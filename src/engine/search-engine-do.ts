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
// The DO keeps NO local copy of the store. It used to persist all ~70MB into
// its own SQLite so wakes avoided the origin, which cost a 70MB write burst on
// first boot (blocking live responses behind the output gate until the writes
// were trickled), 70MB of the 5GB DO storage pool per colo — which is what
// forced free-plan sharding down to one shard — and ~39 metered row reads on
// every wake. KV replaced all of it: a wake is ~4 KV reads of immutable,
// colo-cached chunks, so the local copy earned nothing it cost.

import { DurableObject } from "cloudflare:workers";
import { getEngine, tryGetLoadedEngine } from "./store";
import type {
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	Env,
	ResultShape,
	ScryfallFuzzyResult,
} from "./types";
import { ENGINE_UNAVAILABLE_MARKER, EngineUnavailableError } from "./types";

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

	/** Both catalogs in one RPC (get_catalog needs both). */
	async typeAndKeywordCounts(): Promise<{ types: Record<string, number>; keywords: Record<string, number> }> {
		const engine = await this.engine();
		return { types: await engine.cardTypeCounts(), keywords: await engine.cardKeywordCounts() };
	}

	async randomCardsAsObjects(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		return (await this.engine()).randomCardsAsObjects(numCards, fields);
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
	async randomCardsAsJson(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult> {
		const warm = tryGetLoadedEngine() !== null;
		const acquireStart = Date.now();
		const engine = await this.engine();
		const acquireMs = Date.now() - acquireStart;
		const result = await engine.randomCardsAsJson(numCards, fields, shape);
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
	// THE RESIDUE ATTACH IS NOW PAID IN FRONT OF THE USER, and that is an accepted consequence of
	// dropping the relay. A DO can be fully warm for `/search` and still ~250-350ms of CPU away from
	// a card object, because the residue archive is attached only on first `/cards/*` use — so a
	// search-only region never carries its ~11.8MB. `shouldRelayScryfall` used to hide that behind a
	// race with the regional DO. With one tier there is nothing to race, so the first card request
	// after a wake pays it. Two things make that acceptable: the local archive cache turns the attach
	// into a same-machine read (store-cache.ts), and a region-scale DO wakes far less often than a
	// colo-scale one did.

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

	// ── Engine acquisition ─────────────────────────────────────────────────────

	private async engine(): Promise<Engine> {
		try {
			// getEngine is single-flighted and returns immediately when this
			// isolate already holds the store; otherwise it streams the store in
			// from KV (~4 immutable, colo-cached reads).
			// Built field by field, NOT spread from this.ctx: `waitUntil` lives on
			// DurableObjectState's prototype, so `{...this.ctx}` type-checks and
			// then drops it at runtime, and the archive cache's background fill
			// would throw on every load.
			//
			// `label` rides along so the isolate-global loader can name this object
			// in its own log lines; `storage` is what the archive cache lives in.
			return await getEngine(this.env, {
				waitUntil: (p) => this.ctx.waitUntil(p),
				storage: this.ctx.storage,
				label: this.label,
			});
		} catch (err) {
			rethrowForRpc(err);
		}
	}
}
