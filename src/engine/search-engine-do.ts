// Per-region warm-engine Durable Object — the only thing that serves engine
// queries. Worker isolates parse and RPC here; they never load the store.
// One DO per region (engine-wnam, engine-weur, ...), placed by location hint.
// No alarms, no standing cost: idle regions evict their DO and cost nothing
// (scale to zero).
//
// THERE IS NO RELAY TIER, and its removal is why this file is much smaller than
// it was. Objects used to be named per COLO, with the regional DO existing only
// as a fallback: a cold colo raced its own store load against a relay to the
// region, and BOTH loaded the ~76.6MB archive for one request. Measured on
// 2026-08-12 that was 2.38s + 1.41s of DO CPU on a single cold /cards/search.
//
// The colo was never a placement control, only a partition key — see the
// routing comment in src/index.ts — so the fan-out bought no locality and cost
// an extra object per colo, each too rarely used to stay warm. With one object
// per region there is no cold-colo case to hide, so a cold region simply loads.
//
// It must never relay to another region either: that would reintroduce both the
// cross-region hop and the double load. Note the name would now collide anyway —
// `engine-<hint>` IS this object, so a surviving relay would recurse into its
// own stub.
//
// KV IS THE STORE; DO STORAGE HOLDS A CACHE OF IT. That distinction is the whole
// of this file's history, and it is not the same claim as "no local copy".
//
// The design that was removed made DO storage AUTHORITATIVE: the object persisted
// the entire ~70MB archive into its own SQLite so a wake never touched the origin.
// That cost a 70MB write burst on first boot (blocking live responses behind the
// output gate until the writes were trickled), 70MB of the 5GB DO storage pool per
// COLO — which is what forced free-plan sharding down to one shard — and ~39
// metered row reads on every wake. KV replaced it: chunks are immutable and
// colo-cached, and a cold object reads the chunks of its OWN partition, nothing
// more.
//
// What came back afterwards is a read-through CACHE, not a store
// (src/engine/store-cache.ts): it holds this object's partition compressed, chunk
// for chunk; nothing in it is authoritative; and a miss, a stale key or any fault
// falls back to the KV path. It DOES consume the 5GB pool, so anyone sizing that
// budget must count it — the bound is regions × partitions × one compressed
// partition, which is why store-cache.ts and not this comment carries the
// arithmetic.

import { DurableObject } from "cloudflare:workers";
import {
	CARD_OBJECT_FIELDS,
	cardList,
	type EngineRow,
	toScryfallCard,
	withResolvedMultilingual,
} from "../routes/scryfall-compat/objects";
import {
	emptyPageResponse,
	JSON_CONTENT_TYPE,
	scryfallCsvResponse,
	spliceMarkers,
} from "../routes/scryfall-compat/respond";
import { concatBytes, encodeUtf8 } from "./bytes";
import { serializeCards } from "./columnar";
import { parseEngineName, siblingStub } from "./engine-namespace";
import { type PartitionClient, runTwoPhase, type SearchKeysReply } from "./gather";
import { probePlacement } from "./placement";
import {
	currentManifest,
	gatherOps,
	getEngine,
	type LoadContext,
	prefetchStore,
	refreshNow,
	swapToStore,
	tryGetLoadedEngine,
} from "./store";
import { readLiveManifest, recordLiveManifest } from "./store-cache";
import { isPartitionedManifest, manifestServableBy } from "./store-kv";
import type {
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	Env,
	FuzzyCandidateWire,
	ResultShape,
	ScryfallFuzzyResult,
	SearchPageEnvelope,
	StoreManifest,
} from "./types";
import { ENGINE_STREAM_PATH, ENGINE_UNAVAILABLE_MARKER, EngineUnavailableError } from "./types";

/**
 * `/cards/*` replies, wrapped so `instrumented` has an object to spread telemetry over. A bare
 * `null` card — the genuine miss that becomes a Scryfall 404 — cannot carry riders on its own.
 */
interface ScryfallCardReply {
	card: Record<string, unknown> | null;
}
interface ScryfallCardsReply {
	cards: Record<string, unknown>[];
}
interface ScryfallMaybeCardsReply {
	cards: (Record<string, unknown> | null)[];
}
interface ScryfallNamesReply {
	names: string[];
}

/** Shard-controller riders every search RPC carries back (see RemoteEngine). */
interface SearchTelemetry {
	acquireMs: number;
	load: number;
	rate: number;
	/** Widest fan-out any caller has reported lately — the rendezvous. */
	shards: number;
}

/**
 * How long the announced width survives without a caller re-reporting it.
 *
 * The announcement has to be a DECAYING max, not a running one. A plain max
 * would ratchet: the controller's contraction step lowers an isolate's width,
 * the isolate would immediately re-adopt the stale higher value from here, and
 * scale-in could never happen. With a TTL, a width nobody is still reporting
 * ages out and the announcement follows the callers back down. Sized to match
 * CONTRACT_COOLDOWN_MS so decay and contraction step at the same pace.
 */
const WIDTH_TTL_MS = 60_000;

/** One-second buckets behind the arrival-rate meter; also its window in
 * seconds, since each bucket holds exactly one. */
const RATE_BUCKETS = 10;

function rethrowForRpc(err: unknown): never {
	if (err instanceof EngineUnavailableError) {
		throw new Error(`${ENGINE_UNAVAILABLE_MARKER}:${err.message}`);
	}
	throw err;
}

export class SearchEngine extends DurableObject<Env> {
	/** Searches already executing here; snapshotted per request as the queue-
	 * depth (`load`) signal. */
	private inFlightSearches = 0;
	/** Arrivals per second, for the request-RATE the shard controller gates
	 * expansion on. Rate is the cause-side measurement: latency rises for
	 * reasons sharding cannot fix (KV slowness, network, a noisy neighbour),
	 * and adding shards to those only makes them worse, because every new
	 * shard cold-loads ~70MB. Load without slowness means we are coping;
	 * slowness without load means the problem is elsewhere. Real saturation
	 * always shows both.
	 *
	 * Ten one-second buckets in a ring, indexed by epoch second, each carrying
	 * the second it belongs to so a stale one is skipped rather than cleared.
	 * This replaced an array of arrival timestamps that had two faults: it was
	 * capped at 4096 entries over a 10s window, so the reported rate SATURATED
	 * at 409.6/s — the production expansion log reads "at 410/s", which is the
	 * cap and not the traffic — and it re-filtered the whole array into a fresh
	 * allocation on every single search, putting an O(n) copy on the hot path
	 * of a single-threaded object precisely when n was largest. */
	private readonly rateCounts = new Uint32Array(RATE_BUCKETS);
	private readonly rateSeconds = new Float64Array(RATE_BUCKETS);

	/**
	 * The fan-out rendezvous: widest width any caller has reported, with a TTL.
	 *
	 * activeShards is per-isolate state, and every new isolate starts at 1 — so
	 * without somewhere to meet, an isolate that has not expanded sends all its
	 * traffic to shard 0 and never learns better. Measured on production
	 * 2026-08-09: four shards open, split stuck at ~73/17/10/5 across every
	 * stage of a ramp, ~64% of isolates never expanding. This DO is the meeting
	 * point, because the isolates that need convincing are exactly the ones
	 * sending everything here.
	 */
	private announcedShards = 1;
	private announcedAt = 0;

	/**
	 * This object's own name, for logs: `engine-wnam`, `engine-wnam-2`.
	 *
	 * `DurableObjectId.name` is populated whenever the id came from `idFromName`,
	 * which is the only way this class is ever addressed. Worth carrying into
	 * every line because the store loader is isolate-global and cannot know it:
	 * without this, a load line is identical whichever region, shard or build
	 * emitted it, which during the region cutover made `engine-LAX` on the old
	 * build indistinguishable from `engine-wnam` on the new one.
	 */
	private get label(): string {
		// `id?` because tests construct this class with a stub state that has no
		// id, and a logging accessor must never be the thing that throws.
		return this.ctx.id?.name ?? "engine-?";
	}

	/** Fold a caller's width in and hand back the current announcement. */
	private rendezvous(reported: number, now: number): number {
		const width = Number.isFinite(reported) && reported >= 1 ? Math.floor(reported) : 1;
		// Refresh on any report at or above the announcement — otherwise a
		// stream of lower reports would keep a stale higher value alive forever
		// and defeat the TTL.
		if (width >= this.announcedShards || now - this.announcedAt > WIDTH_TTL_MS) {
			this.announcedShards = width;
			this.announcedAt = now;
		}
		return this.announcedShards;
	}

	/** Searches per second over the trailing window. O(RATE_BUCKETS), no
	 * allocation, and no ceiling short of 2^32 arrivals in one second. */
	private searchRate(now: number): number {
		const second = Math.floor(now / 1000);
		const slot = ((second % RATE_BUCKETS) + RATE_BUCKETS) % RATE_BUCKETS;
		if (this.rateSeconds[slot] !== second) {
			this.rateSeconds[slot] = second;
			this.rateCounts[slot] = 0;
		}
		this.rateCounts[slot] = (this.rateCounts[slot] as number) + 1;
		let total = 0;
		for (let i = 0; i < RATE_BUCKETS; i++) {
			if (second - (this.rateSeconds[i] as number) < RATE_BUCKETS) total += this.rateCounts[i] as number;
		}
		return total / RATE_BUCKETS;
	}

	// ── RPC surface ────────────────────────────────────────────────────────────
	//
	// Every method runs locally. There is no fallbackHint and no relay: this DO
	// is the region, so there is nowhere better to ask. A cold one loads.

	async searchCardsAsObjects(
		opts: EngineSearchOptions,
		reportedShards?: number,
	): Promise<EngineSearchResult & SearchTelemetry> {
		return this.instrumented(reportedShards, (engine) => engine.searchCardsAsObjects(opts));
	}

	/**
	 * The API path: identical telemetry, but the cards come back already encoded,
	 * so no card ever becomes a JS object in the isolate that serves the request.
	 * See EngineSerializedResult.
	 */
	async searchCardsAsJson(
		opts: EngineSearchOptions,
		shape: ResultShape,
		reportedShards?: number,
	): Promise<EngineSerializedResult & SearchTelemetry> {
		return this.instrumented(reportedShards, (engine) => engine.searchCardsAsJson(opts, shape));
	}

	/**
	 * The same two payloads as the RPCs above, delivered as a RESPONSE BODY instead of a return
	 * value.
	 *
	 * WHY THIS EXISTS. An RPC return crosses the isolate/DO boundary as a serialized value, and that
	 * serialization is charged to this object's CPU. Measured 2026-08-13, DO CPU is 16.9us/KB in
	 * production while the engine itself accounts for only 4.2us/KB (`bench_card_object_build`:
	 * 2.613ms for a 175-card page) and the two memcpys in the path are ~0.2ms each — a 646KB
	 * `concatBytes` removal measured as exactly zero. The remainder is this hop. A `fetch` response
	 * streams down the same pipe instead of being cloned into it, which is the one term left worth
	 * attacking on /cards/search's 11.66ms.
	 *
	 * GENERIC ON PURPOSE. `/search` has the identical shape and the same per-KB cost — its payload
	 * is just 15x smaller — so it moves onto this transport too rather than keeping a second one
	 * alive. `call` picks the engine method; nothing else differs.
	 *
	 * THE TELEMETRY RIDES IN HEADERS, and that is load-bearing rather than incidental. The shard
	 * autoscaler is fed entirely by riders on the search RPCs (see RemoteEngine.searchRpc), so a
	 * route that moved to `fetch` and dropped them would silently stop reporting the rate the
	 * controller now expands on — and /cards/search is the route whose ceiling that constant is
	 * calibrated to.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname !== ENGINE_STREAM_PATH) {
			return new Response("not found", { status: 404 });
		}
		const body = (await request.json()) as {
			// "cards" answers from this object's own store; "cards2" is the partitioned
			// twin — the two-phase gather across this object's sibling partitions (plan
			// B5), same envelope, same headers. A "rows" variant existed for /search's
			// streaming transport; that route is buffered again (see respond.ts), so the
			// branch is gone rather than left to rot. Anything else is rejected LOUDLY
			// below — answering a stale `call` with card objects would be silently wrong
			// data, not an error.
			call: "cards" | "cards2";
			opts: EngineSearchOptions;
			baseUrl?: string;
			shards?: number;
			/**
			 * The envelope this object should wrap the payload in, so the ISOLATE never touches a byte.
			 *
			 * Splicing `<head><payload><tail>` in the isolate meant reading and re-enqueuing every
			 * chunk of a 652KB page there — measured 2026-08-13 at ~13ms mean, over the free plan's
			 * 10ms metered budget. Built here, the isolate returns this response verbatim and its cost
			 * stops scaling with the payload at all. Everything needed is small and known before the
			 * query; only the counts are not, and this object has those.
			 */
			envelope?: SearchPageEnvelope;
			cache?: Record<string, string>;
		};
		if (body.call !== "cards" && body.call !== "cards2") {
			return new Response(`unsupported engine call: ${String(body.call)}`, { status: 400 });
		}
		let result: EngineSerializedResult & SearchTelemetry;
		try {
			result = await this.instrumented(body.shards, (engine) =>
				body.call === "cards2"
					? this.gatherScryfallSearchLocal(body.opts, body.baseUrl ?? "")
					: engine.scryfallSearch(body.opts, body.baseUrl ?? ""),
			);
		} catch (err) {
			// The RPC path has `rethrowForRpc` to keep error IDENTITY across the boundary; a fetch
			// carries a status line instead, so the class is named explicitly and rebuilt client-side.
			// Losing EngineUnavailableError here would turn a 503 "still loading" into a 500.
			const name = err instanceof Error ? err.name : "Error";
			const message = err instanceof Error ? err.message : String(err);
			return new Response(message, { status: 503, headers: { "x-engine-error": name } });
		}
		const telemetry = {
			"x-total-cards": String(result.totalCards),
			"x-row-count": String(result.rowCount),
			"x-acquire-ms": String(result.acquireMs),
			"x-load": String(result.load),
			"x-rate": String(result.rate),
			"x-shards": String(result.shards),
		};
		const envelope = body.envelope;
		if (envelope === undefined) {
			// Raw payload: the caller splices its own envelope (the rows path still does).
			return new Response(result.cardsBytes, {
				headers: { "content-length": String(result.cardsBytes.byteLength), ...telemetry },
			});
		}
		// THE WHOLE RESPONSE, headers and status included, so the isolate can return it verbatim.
		const cache = body.cache ?? {};
		if (result.rowCount === 0) {
			const miss = emptyPageResponse(envelope, result.totalCards, cache);
			for (const [k, v] of Object.entries(telemetry)) miss.headers.set(k, v);
			return miss;
		}
		const hasMore = envelope.pageOffset + result.rowCount < result.totalCards;
		if (envelope.csv === true) {
			// The CSV branch sits HERE, beside the JSON splice, rather than in the isolate: the rows
			// are already on this side, and rendering them means parsing the ~900KB array — the exact
			// work the whole `envelope`-crosses-the-RPC design exists to keep off the 10ms budget.
			// Both `cards` and `cards2` converge on this line, so the partitioned and single-store
			// paths cannot render a page differently.
			const csv = scryfallCsvResponse(result.cardsBytes, hasMore, cache);
			for (const [k, v] of Object.entries(telemetry)) csv.headers.set(k, v);
			return csv;
		}
		const { head, tail } = spliceMarkers(
			cardList([], {
				totalCards: result.totalCards,
				hasMore,
				nextPage: hasMore ? withResolvedMultilingual(envelope.nextPageUrl, result.widened === true) : undefined,
				warnings: envelope.warnings,
			}),
			envelope.pretty,
		);
		return new Response(concatBytes([head, result.cardsBytes, tail]), {
			headers: {
				"content-type": JSON_CONTENT_TYPE,
				"content-length": String(head.byteLength + result.cardsBytes.byteLength + tail.byteLength),
				...cache,
				...telemetry,
			},
		});
	}

	/** Run a search against the local engine, carrying the autoscaler's signals. */
	private async instrumented<T extends object>(
		reportedShards: number | undefined,
		run: (engine: Engine) => Promise<T>,
	): Promise<T & SearchTelemetry> {
		const now = Date.now();
		const load = this.inFlightSearches;
		const rate = this.searchRate(now);
		const shards = this.rendezvous(reportedShards ?? 1, now);
		this.inFlightSearches += 1;
		try {
			// Time the engine acquisition (the KV load, when there is one) for
			// the calling isolate's cold-path breakdown. Date.now() only advances
			// across I/O in Workers, which is what a load spends. Warm calls
			// report ~0.
			const acquireStart = Date.now();
			const engine = await this.engine();
			const acquireMs = Date.now() - acquireStart;
			try {
				return { ...(await run(engine)), acquireMs, load, rate, shards };
			} catch (err) {
				rethrowForRpc(err);
			}
		} finally {
			this.inFlightSearches -= 1;
		}
	}

	/**
	 * Both catalogs plus the extras-set table, in one RPC.
	 *
	 * `setsWithExtras` has nothing to do with /get_catalog; it rides along because the isolate
	 * already caches this call's answer for the life of the store generation, and the route that
	 * needs the table (`cardsSearchHandler`, deciding Scryfall's `include_extras` auto-enable) is
	 * the hottest one there is. A second RPC would have made a set-scoped search pay a round trip
	 * per partition to learn something that changes only when the store does.
	 */
	async typeAndKeywordCounts(): Promise<{
		types: Record<string, number>;
		keywords: Record<string, number>;
		setsWithExtras: string[];
	}> {
		const engine = await this.engine();
		return {
			types: await engine.cardTypeCounts(),
			keywords: await engine.cardKeywordCounts(),
			setsWithExtras: await engine.setsWithExtras(),
		};
	}

	async randomCardsAsObjects(
		numCards: number,
		fields: string[],
		filterTreeJson?: string,
	): Promise<Record<string, unknown>[]> {
		return (await this.engine()).randomCardsAsObjects(numCards, fields, filterTreeJson);
	}

	/**
	 * Instrumented like search(), and for the reason search() already was: this
	 * is the most expensive invocation in the deployment (~200ms of CPU against
	 * 1-2ms warm) and working out WHY took hours of inference, because search
	 * reports whether it had to acquire its engine and this did not.
	 *
	 * `warm` is the datum, and it needs no clock: whether this isolate already
	 * held the store before acquiring. An expensive call with warm=true would
	 * rule out the store load outright — which is the answer nothing else here
	 * can give, since the load's own log line is emitted by another module and
	 * cannot be correlated per invocation.
	 *
	 * `acquireMs` measures I/O only. Workers freeze the clock during synchronous
	 * execution, so a 0 beside a large cpuTime is itself the finding: the time
	 * went to compute, not to KV.
	 *
	 * Logged only when it actually acquired, matching RemoteEngine.searchRpc —
	 * a warm call is the boring case and says nothing worth a log line.
	 */
	async randomCardsAsJson(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		filterTreeJson?: string,
	): Promise<EngineSerializedResult> {
		const warm = tryGetLoadedEngine(this.label) !== null;
		const acquireStart = Date.now();
		const engine = await this.engine();
		const acquireMs = Date.now() - acquireStart;
		const result = await engine.randomCardsAsJson(numCards, fields, shape, filterTreeJson);
		if (!warm) {
			console.log(
				`[${this.label}] randomCardsAsObjects acquired its engine in ${acquireMs}ms (cold) for n=${numCards}`,
			);
		}
		return result;
	}

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// Instrumented EXACTLY like search/searchCardsAsJson: same telemetry, same shard rendezvous. That
	// is not symmetry for its own sake — mtg-seeker points at `/cards/*`, so this is the traffic the
	// deployment actually has to scale under. Bypassing `instrumented` would leave the shard
	// controller reading only `/search` depth and rate, and it would decline to open a shard while
	// `/cards/*` saturated the one it had.
	//
	// Every result is wrapped in an object because `instrumented` spreads its telemetry over the
	// return value, and a bare `null` (a genuine card miss) has nothing to spread onto.
	// RemoteEngine unwraps on the other side, so the Engine interface keeps the plain shapes.
	//
	// THERE IS NO SECOND ARCHIVE TO ATTACH. Generation 19 folded the `card-compat-*` residue into
	// the printing record, so a warm object is warm for `/cards/*` on exactly the terms it is warm
	// for `/search`: one archive, loaded once, no lazy attach and no first-card-request penalty.
	// This paragraph used to describe the opposite — a ~11.8MB residue attached on first `/cards/*`
	// use, costing ~250-350ms of CPU in front of the user once the relay tier (`shouldRelayScryfall`)
	// stopped hiding it behind a race. Both the relay and the residue are gone; the memory argument
	// that justified splitting them is in store-kv.ts's generation changelog.

	async scryfallSearch(
		opts: EngineSearchOptions,
		baseUrl: string,
		reportedShards?: number,
	): Promise<EngineSerializedResult & SearchTelemetry> {
		return this.instrumented(reportedShards, (engine) => engine.scryfallSearch(opts, baseUrl));
	}

	async scryfallCardById(
		scryfallId: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			card: await engine.scryfallCardById(scryfallId, baseUrl),
		}));
	}

	async scryfallCardsByIds(
		scryfallIds: string[],
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallCardsReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			cards: await engine.scryfallCardsByIds(scryfallIds, baseUrl),
		}));
	}

	async scryfallCardByOracleId(
		oracleId: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			card: await engine.scryfallCardByOracleId(oracleId, baseUrl),
		}));
	}

	async scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			card: await engine.scryfallCardByExternalId(namespace, externalId, baseUrl),
		}));
	}

	async scryfallFuzzyName(
		name: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallFuzzyResult & SearchTelemetry> {
		return this.instrumented(reportedShards, (engine) => engine.scryfallFuzzyName(name, baseUrl));
	}

	async scryfallAutocomplete(
		prefix: string,
		limit: number,
		reportedShards?: number,
	): Promise<ScryfallNamesReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			names: await engine.scryfallAutocomplete(prefix, limit),
		}));
	}

	async scryfallExactName(
		folded: string,
		setCode: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			card: await engine.scryfallExactName(folded, setCode, baseUrl),
		}));
	}

	async scryfallExactNameRank(
		folded: string,
		setCode: string,
		reportedShards?: number,
	): Promise<{ rank: number[] | null } & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			rank: await engine.scryfallExactNameRank(folded, setCode),
		}));
	}

	async scryfallCardByIllustrationId(
		illustrationId: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			card: await engine.scryfallCardByIllustrationId(illustrationId, baseUrl),
		}));
	}

	async scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallCardsReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			cards: await engine.scryfallNamesContaining(words, setCode, limit, baseUrl),
		}));
	}

	async scryfallFirstOfEach(
		filterTreeJsons: string[],
		baseUrl: string,
		reportedShards?: number,
	): Promise<ScryfallMaybeCardsReply & SearchTelemetry> {
		return this.instrumented(reportedShards, async (engine) => ({
			cards: await engine.scryfallFirstOfEach(filterTreeJsons, baseUrl),
		}));
	}

	// ── The two-phase gather (plan B5, CARD-PARTITIONING §6) ──────────────────────
	//
	// A partitioned search cannot be answered by one object — the global order is
	// scattered across N archives — and the ~N × 650KB interleave is exactly the
	// splice this codebase has twice exiled from isolates to Durable Objects. So
	// the ISOLATE sends one request to a gather partition (spread by
	// gatherPartitionOf), and THIS object coordinates: phase-1 searchKeys to its
	// N-1 siblings plus its own store, a bytewise merge, phase-2 fetchRows to the
	// owning partitions, and the reassembly — all inside the DO's 30s budget. The
	// order-sensitive machinery lives in gather.ts, where it is testable without
	// a Durable Object; this section is only the wiring.
	//
	// Riders come from the GATHER object alone — the isolate made one RPC and the
	// autoscaler reasons about replicas, not partitions — and sibling calls are
	// plain RPCs that deliberately do not feed the rendezvous.

	/**
	 * Phase 1, served to a sibling gather: this partition's page of opaque sort
	 * keys, plus the identity facts the protocol pins on. A cold object LOADS
	 * here — `engine()` is the same acquisition every RPC does.
	 *
	 * `inlineRows` is the gather's request to carry the first N entries' ROWS back
	 * in the same reply, which is what removes the phase-2 RPC on the common page
	 * (see gather.ts's inlineRowBudget). Defaulted to 0 so an object still running
	 * the previous build during a rolling deploy — or any caller that predates the
	 * argument — gets exactly the old keys-only behaviour.
	 */
	async searchKeys(opts: EngineSearchOptions, inlineRows = 0): Promise<SearchKeysReply> {
		await this.engine();
		const ops = gatherOps(this.label);
		if (!ops) rethrowForRpc(new EngineUnavailableError(`${this.label} acquired an engine but holds no store`));
		return {
			packed: ops.queryKeys(opts, inlineRows),
			storeKey: ops.storeKey,
			sortKeyVersion: ops.sortKeyVersion(),
		};
	}

	/**
	 * This partition's scores-bearing fuzzy candidates — phase 1 of the
	 * cross-partition FLOOR/LEAD race (the {status, card} answer cannot carry
	 * scores, so racing it globally was impossible; see PartitionedEngine's
	 * scryfallFuzzyName for the exact rule these feed).
	 */
	async fuzzyCandidates(name: string): Promise<{ candidates: FuzzyCandidateWire[] }> {
		await this.engine();
		const ops = gatherOps(this.label);
		if (!ops) rethrowForRpc(new EngineUnavailableError(`${this.label} acquired an engine but holds no store`));
		return { candidates: ops.fuzzyCandidates(name) };
	}

	/**
	 * Phase 2: rows for vpids THIS partition's phase-1 keys named, in caller
	 * order. `storeKey` pins the generation — vpids are meaningless against any
	 * other archive, so a swapped object errors loudly rather than answering
	 * from different rows (the gather re-runs against the newer generation).
	 */
	async fetchRows(vpids: number[], fields: string[], storeKey: string): Promise<{ rowsBytes: Uint8Array }> {
		await this.engine();
		const ops = gatherOps(this.label);
		if (!ops) rethrowForRpc(new EngineUnavailableError(`${this.label} acquired an engine but holds no store`));
		if (ops.storeKey !== storeKey) {
			throw new Error(`generation mismatch: rows asked from ${storeKey} but ${this.label} serves ${ops.storeKey}`);
		}
		return { rowsBytes: ops.fetchRows(vpids, fields) };
	}

	/** One client per partition: this object's own store served locally, every
	 * sibling over RPC. Names derive from THIS object's label (siblingStub), so
	 * a gather can only ever fan out within its own region and replica. */
	private partitionClients(count: number): PartitionClient[] {
		const own = parseEngineName(this.label)?.partition;
		return Array.from({ length: count }, (_, p) => {
			if (p === own) {
				// The gather's OWN partition answers in-process, so inlining its rows would only
				// move bytes it already holds. Asking for none keeps that work off the local path
				// and leaves those page slots to the (free, local) fetchRows call.
				return {
					searchKeys: (opts: EngineSearchOptions) => this.searchKeys(opts, 0),
					fetchRows: async (vpids: number[], fields: string[], storeKey: string) =>
						(await this.fetchRows(vpids, fields, storeKey)).rowsBytes,
				};
			}
			const stub = siblingStub(this.env, this.label, p) as unknown as {
				searchKeys(opts: EngineSearchOptions, inlineRows: number): Promise<SearchKeysReply>;
				fetchRows(vpids: number[], fields: string[], storeKey: string): Promise<{ rowsBytes: Uint8Array }>;
			} | null;
			if (!stub) throw new Error(`${this.label} cannot derive its partition-${p} sibling's name`);
			return {
				searchKeys: (opts: EngineSearchOptions, inlineRows: number) => stub.searchKeys(opts, inlineRows),
				fetchRows: async (vpids: number[], fields: string[], storeKey: string) =>
					(await stub.fetchRows(vpids, fields, storeKey)).rowsBytes,
			};
		});
	}

	/**
	 * Both phases.
	 *
	 * `await this.engine()` has just loaded (or confirmed) this object's store, so
	 * the manifest is present and — since every published manifest is partitioned
	 * — carries partition_count. Both checks below are therefore assertions: a
	 * gather that could not find its width would otherwise answer from one
	 * partition and report it as the whole corpus, which is the failure mode with
	 * no symptom.
	 */
	private async gatherRun(opts: EngineSearchOptions): Promise<{ total: number; rows: Record<string, unknown>[] }> {
		await this.engine();
		const manifest = currentManifest(this.label);
		if (!manifest || !isPartitionedManifest(manifest)) {
			rethrowForRpc(
				new EngineUnavailableError(
					`${this.label} cannot gather: its loaded store reports ` +
						`${manifest ? `manifest ${manifest.store_key} with no partition_count` : "no manifest at all"}. ` +
						`Answering from one partition would silently return a fraction of the corpus.`,
				),
			);
		}
		return runTwoPhase(this.partitionClients(manifest.partition_count as number), opts);
	}

	/** The gather twin of engine.scryfallSearch: card objects, pre-encoded. */
	private async gatherScryfallSearchLocal(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult> {
		const wide = { ...opts, fields: [...CARD_OBJECT_FIELDS] };
		const gathered = await this.gatherRun(wide);
		const cards = gathered.rows.map((row) => toScryfallCard(row as EngineRow, baseUrl));
		const cardsBytes = encodeUtf8(JSON.stringify(cards));
		// The gather never holds a QueryOutput, so the widening flag comes from this object's OWN
		// store: the decision is a pure function of the options and the bound filter and is the
		// same in every partition. `/cards/search` echoes `include_multilingual` in `next_page`
		// from it — see withResolvedMultilingual.
		const widened = (await this.engine()).queryWidens?.(opts) ?? false;
		return { totalCards: gathered.total, cardsBytes, rowCount: cards.length, widened };
	}

	/** /search's object shape, gathered. Instrumented exactly like its local twin. */
	async gatherSearchAsObjects(
		opts: EngineSearchOptions,
		reportedShards?: number,
	): Promise<EngineSearchResult & SearchTelemetry> {
		return this.instrumented(reportedShards, async () => {
			const gathered = await this.gatherRun(opts);
			return { totalCards: gathered.total, cards: gathered.rows };
		});
	}

	/** The API row shapes, gathered. */
	async gatherSearchAsJson(
		opts: EngineSearchOptions,
		shape: ResultShape,
		reportedShards?: number,
	): Promise<EngineSerializedResult & SearchTelemetry> {
		return this.instrumented(reportedShards, async () => {
			const gathered = await this.gatherRun(opts);
			return {
				totalCards: gathered.total,
				cardsBytes: encodeUtf8(serializeCards(gathered.rows, shape)),
				rowCount: gathered.rows.length,
			};
		});
	}

	/** Scryfall card objects, gathered — the RPC-return twin of `cards2`. */
	async gatherScryfallSearch(
		opts: EngineSearchOptions,
		baseUrl: string,
		reportedShards?: number,
	): Promise<EngineSerializedResult & SearchTelemetry> {
		return this.instrumented(reportedShards, () => this.gatherScryfallSearchLocal(opts, baseUrl));
	}

	/**
	 * The store's card count, and the readiness probe a freshly opened shard is warmed with.
	 *
	 * `src/index.ts` pings this on a shard the controller has just opened and admits the shard to
	 * routing only when it resolves, so on a cold DO this call IS the store load. Deliberately not
	 * instrumented: it is not a user request and its wall time is a wake, so feeding it to the
	 * autoscaler would let every expansion argue for the next.
	 */
	async cardCount(): Promise<number> {
		const engine = await this.engine();
		return engine.cardCount();
	}

	// ── Publish convergence ────────────────────────────────────────────────────
	//
	// The publisher calls these directly rather than every reader polling for a
	// manifest change. That is only possible because objects are named per REGION:
	// there are nine of them and the list is a constant, where colo names were
	// unknowable (`engine-LAX` exists only if LAX saw traffic, no registry, ~330
	// locations) and polling was the only option.

	/**
	 * A new store has been published — converge on it now.
	 *
	 * A COLD object does nothing and says so. That is what keeps the fan-out cheap
	 * enough to send to all nine regions unconditionally: constructing a Durable
	 * Object is just a constructor, and it is the ~76.6MB load that costs, so an
	 * idle region answers instantly and evicts again rather than being woken into
	 * holding a store it has no traffic for. It will load the (already current)
	 * manifest whenever its next real request arrives.
	 *
	 * A WARM one prefetches the new archives into local storage and then swaps,
	 * so the unavoidable unload/reload window is a local read rather than a KV
	 * fetch plus a decompression.
	 *
	 * Reports its announced shard width so the publisher can reach expanded shards
	 * too — it cannot know the fan-out any other way, and shard 0 is exactly the
	 * object every isolate in the region reports to.
	 */
	async notifyPublish(manifest?: StoreManifest): Promise<{ swapped: boolean; shards: number }> {
		// Record it even with nothing loaded. A cold object costs nothing to tell — it wakes, writes
		// one row and evicts again without reading an archive — and this is precisely what lets its
		// NEXT cold start skip the KV manifest read: the publisher already told it what is live.
		//
		// UNLESS the shape is one this object's own name cannot serve — an
		// unpartitioned manifest, or a label that parsed to no partition. Either is
		// a BUG rather than a state to serve through, and caching it would wedge the
		// next cold load on the loader's refusal; refuse LOUDLY here instead, ack,
		// and keep the current store, because the publish must not fail on it.
		if (manifest && !manifestServableBy(parseEngineName(this.label)?.partition, manifest)) {
			console.error(
				`[${this.label}] REFUSING a pushed manifest this object cannot serve ` +
					`(${manifest.store_key}, partition_count ${manifest.partition_count ?? "none"}); not caching it`,
			);
			return { swapped: false, shards: this.announcedShards };
		}
		if (manifest) {
			try {
				recordLiveManifest(this.ctx.storage, manifest);
			} catch (err) {
				console.warn(`[${this.label}] could not record the live manifest (it will read KV): ${err}`);
			}
		}
		if (tryGetLoadedEngine(this.label) === null) return { swapped: false, shards: this.announcedShards };
		// Deliberately BELOW the cold early-return. A publish is the one recurring, off-request moment
		// to re-check where this object is, but a probe holds an object open for as long as its
		// outbound connection is pooled — and "a cold object wakes, writes one row and evicts again"
		// is a property this fan-out depends on. A warm object is already alive and already paying
		// duration, so it is the only one this costs nothing to ask.
		probePlacement(this.loadContext());
		const swapped = await refreshNow(this.env, this.loadContext(), manifest);
		console.log(`[${this.label}] publish notify: ${swapped ? "swapped to the new store" : "already current"}`);
		return { swapped, shards: this.announcedShards };
	}

	// ── Two-step publish (prepare → commit) ────────────────────────────────────
	//
	// The publish protocol the coordinator speaks (stepNotify, plan B5):
	//   preparePublish(manifest)  prefetch the announced archive into local
	//                             storage, NO swap — ack when the bytes are held
	//   commitPublish()           the swap itself, local and sub-second
	// so that no region swaps before every region is ready, and the
	// mixed-generation window shrinks from "slowest prefetch" to "commit fan-out
	// spread" — which is what a partitioned store's pinned-generation fan-out
	// needs.
	//
	// ROLLOUT COMPATIBILITY: an object still running the PREVIOUS build during
	// the deploy that ships this file implements prepare as a shim over
	// notifyPublish, so a prepare to it swaps immediately — reproducing today's
	// one-step behavior for exactly one mixed window, the deploy itself. That is
	// the PRE-EXISTING behavior of every current publish, not a regression, and
	// it resolves itself: the fan-out runs nightly and the fleet is on one build
	// by then. notifyPublish itself stays — it is the documented single-step RPC
	// and remains correct on its own (prefetch, then swap).

	/**
	 * Step 1 of the two-step publish: hold the new store locally, ready to swap.
	 * NO swap happens here — the old store serves until every object has acked
	 * and the coordinator says commit.
	 *
	 * Idempotent — an object that already prepared (or already swapped) re-acks
	 * from its local state for free, which is what lets the coordinator retry
	 * the whole phase on any single failure. A cold object records the manifest
	 * and acks without loading a byte; an object that cannot serve the pushed
	 * shape also acks — it keeps its current store, and the publish must not
	 * wedge on what is a bug elsewhere.
	 */
	async preparePublish(manifest?: StoreManifest): Promise<{ prepared: boolean; shards: number }> {
		// The same refusal as notifyPublish: a manifest shape this object's name
		// cannot serve is never recorded, because a cached one wedges the next cold
		// load — but the ack still goes back, because a publish must not wedge on
		// what is a bug on the other side of the call.
		if (manifest && !manifestServableBy(parseEngineName(this.label)?.partition, manifest)) {
			console.error(
				`[${this.label}] REFUSING a pushed manifest this object cannot serve ` +
					`(${manifest.store_key}, partition_count ${manifest.partition_count ?? "none"}); not caching it`,
			);
			return { prepared: true, shards: this.announcedShards };
		}
		if (manifest) {
			try {
				recordLiveManifest(this.ctx.storage, manifest);
			} catch (err) {
				console.warn(`[${this.label}] could not record the live manifest (it will read KV): ${err}`);
			}
		}
		if (tryGetLoadedEngine(this.label) === null) return { prepared: true, shards: this.announcedShards };
		// Warm: hold the bytes locally under the OLD store. See prefetchStore for
		// why every failure here degrades to a slower commit, never a failed one.
		probePlacement(this.loadContext());
		const held = manifest ? await prefetchStore(this.env, this.loadContext(), manifest) : false;
		console.log(`[${this.label}] publish prepare: ${held ? "holding the new store locally" : "nothing prefetched"}`);
		return { prepared: true, shards: this.announcedShards };
	}

	/**
	 * Step 2 of the two-step publish: swap to the prepared store.
	 *
	 * The manifest comes from this object's own storage — preparePublish
	 * recorded it — so a commit needs no arguments and a retry is free. A cold
	 * object acks `swapped: false` (its next real request loads the new store
	 * anyway); a warm one swaps from the local copy, falling back to KV if the
	 * prefetch did not land.
	 */
	async commitPublish(): Promise<{ swapped: boolean; shards: number }> {
		if (tryGetLoadedEngine(this.label) === null) return { swapped: false, shards: this.announcedShards };
		const manifest = readLiveManifest(this.ctx.storage) as StoreManifest | null;
		if (!manifest?.store_bytes) return { swapped: false, shards: this.announcedShards };
		const swapped = await swapToStore(this.env, this.loadContext(), manifest);
		console.log(`[${this.label}] publish commit: ${swapped ? "swapped to the new store" : "already current"}`);
		return { swapped, shards: this.announcedShards };
	}

	/**
	 * Drop this object's cached archives — called on shards above the fan-out.
	 *
	 * Scale-in is eviction, which was free while a shard held nothing in storage.
	 * With the archive cache it is not: an abandoned partition object — every
	 * `engine-wnam-3-p<k>` of a retired replica, released together — would keep its
	 * cached chunks forever, and its own prune never runs again because it never
	 * loads again. The rows are one partition's COMPRESSED archive, not the whole
	 * store's — `partitions[k].store_gzip_bytes`, a fraction of it set by
	 * `partition_count` — and a retired replica holds one such object per
	 * partition, so it strands the whole compressed store once. Left alone, every
	 * transient spike would
	 * permanently consume a slice of the 5GB pool.
	 *
	 * Safe unconditionally: the cache is an optimisation over KV, so the worst a
	 * mistaken release can do is make one later load slower. Cloudflare reclaims a
	 * Durable Object once its storage is empty, so this releases the object too,
	 * not just its rows.
	 */
	async releaseCache(): Promise<{ released: boolean }> {
		await this.ctx.storage.deleteAll();
		console.log(`[${this.label}] released its cached archives (shard is above the fan-out)`);
		return { released: true };
	}

	// ── Engine acquisition ─────────────────────────────────────────────────────

	/**
	 * The loader's view of this object.
	 *
	 * Built field by field, NOT spread from `this.ctx`: `waitUntil` lives on
	 * DurableObjectState's prototype, so `{...this.ctx}` type-checks and then
	 * drops it at runtime, and the archive cache's background fill would throw on
	 * every load.
	 */
	private loadContext(): LoadContext {
		// The partition this object serves is carried IN ITS NAME (`engine-wnam-p3`
		// → partition 3), so the loader needs no other channel to learn it. A name
		// that parses to no partition passes undefined, and the loader refuses that
		// loudly as the naming bug it is (see archiveOfManifest).
		const partition = parseEngineName(this.label)?.partition;
		return {
			waitUntil: (p) => this.ctx.waitUntil(p),
			storage: this.ctx.storage,
			label: this.label,
			...(partition === undefined ? {} : { partition }),
		};
	}

	private async engine(): Promise<Engine> {
		try {
			// getEngine is single-flighted and returns immediately when this
			// isolate already holds the store; otherwise it streams the store in
			// from KV (~4 immutable, colo-cached reads).
			return await getEngine(this.env, this.loadContext());
		} catch (err) {
			rethrowForRpc(err);
		}
	}
}
