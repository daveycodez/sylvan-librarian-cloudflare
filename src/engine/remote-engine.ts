// Engine implementation backed by the region's SearchEngine DO — the only
// serving path: isolates parse and RPC here, never loading the store.

import {
	adoptShardWidth,
	currentShardWidth,
	reportEngineLatency,
	reportEngineLoad,
	reportEngineRate,
} from "./shard-controller";
import type {
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	FuzzyCandidateWire,
	ResultShape,
	ScryfallFuzzyResult,
	SearchPageEnvelope,
} from "./types";
import {
	BUILD_FILTER_ERROR_PREFIX,
	ENGINE_STREAM_PATH,
	ENGINE_UNAVAILABLE_MARKER,
	EngineQueryError,
	EngineUnavailableError,
} from "./types";

/** Riders the DO attaches to a search result for the shard controller. */
type Telemetry = { acquireMs?: number; load?: number; rate?: number; shards?: number };

/** Structural stub type: the SearchEngine DO's RPC surface. The riders are
 * optional only for one deploy's worth of rolling-update skew (new isolate, old
 * DO); current DO code always sets them, and a missing one is simply not
 * reported to the autoscaler. */
interface SearchEngineStub {
	/** The payload transport (ENGINE_STREAM_PATH). A response body streams down the stub's pipe
	 * instead of being serialized as an RPC value, which is the DO-CPU term that dominates the
	 * large payloads — see the DO's `fetch` handler. */
	fetch(request: Request): Promise<Response>;
	searchCardsAsObjects(opts: EngineSearchOptions, reportedShards?: number): Promise<EngineSearchResult & Telemetry>;
	searchCardsAsJson(
		opts: EngineSearchOptions,
		shape: ResultShape,
		reportedShards?: number,
	): Promise<EngineSerializedResult & Telemetry>;
	// The two-phase gather twins (plan B5): served by a partition object, which
	// coordinates its siblings. Same shapes, same riders.
	gatherSearchAsObjects(opts: EngineSearchOptions, reportedShards?: number): Promise<EngineSearchResult & Telemetry>;
	gatherSearchAsJson(
		opts: EngineSearchOptions,
		shape: ResultShape,
		reportedShards?: number,
	): Promise<EngineSerializedResult & Telemetry>;
	gatherScryfallSearch(
		opts: EngineSearchOptions,
		baseUrl: string,
		reportedShards?: number,
	): Promise<EngineSerializedResult & Telemetry>;
	typeAndKeywordCounts(): Promise<{
		types: Record<string, number>;
		keywords: Record<string, number>;
		setsWithExtras: string[];
	}>;
	randomCardsAsObjects(numCards: number, fields: string[]): Promise<Record<string, unknown>[]>;
	randomCardsAsJson(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult>;
	cardCount(): Promise<number>;
	// Every `/cards/*` reply carries the same shard-controller riders search does, and wraps its
	// payload so a null card has something to carry them on.
	scryfallSearch(
		opts: EngineSearchOptions,
		baseUrl: string,
		reportedShards?: number,
	): Promise<EngineSerializedResult & Telemetry>;
	scryfallCardById(
		scryfallId: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ card: Record<string, unknown> | null } & Telemetry>;
	scryfallCardsByIds(
		scryfallIds: string[],
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ cards: Record<string, unknown>[] } & Telemetry>;
	scryfallCardByOracleId(
		oracleId: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ card: Record<string, unknown> | null } & Telemetry>;
	scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ card: Record<string, unknown> | null } & Telemetry>;
	scryfallFuzzyName(name: string, baseUrl: string, reportedShards?: number): Promise<ScryfallFuzzyResult & Telemetry>;
	fuzzyCandidates(name: string): Promise<{ candidates: FuzzyCandidateWire[] }>;
	scryfallAutocomplete(
		prefix: string,
		limit: number,
		reportedShards?: number,
	): Promise<{ names: string[] } & Telemetry>;
	scryfallExactName(
		folded: string,
		setCode: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ card: Record<string, unknown> | null } & Telemetry>;
	scryfallCardByIllustrationId(
		illustrationId: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ card: Record<string, unknown> | null } & Telemetry>;
	scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ cards: Record<string, unknown>[] } & Telemetry>;
	scryfallFirstOfEach(
		filterTreeJsons: string[],
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ cards: (Record<string, unknown> | null)[] } & Telemetry>;
}

/** Decode the DO's EngineUnavailableError marker back into the real type. */
async function unwrap<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const at = message.indexOf(ENGINE_UNAVAILABLE_MARKER);
		if (at >= 0) {
			throw new EngineUnavailableError(message.slice(at + ENGINE_UNAVAILABLE_MARKER.length + 1));
		}
		// The RPC path carries the message verbatim, so the same classification the fetch transport
		// makes from its status line is made here from the text.
		if (message.includes(BUILD_FILTER_ERROR_PREFIX)) throw new EngineQueryError(message);
		throw err;
	}
}

/**
 * Run one engine RPC, retrying failures the runtime flags as transient.
 *
 * Every deploy RESETS every DO, and an RPC landing during the reset is
 * rejected with "Durable Object reset because its code was updated" (storage
 * resets and network blips behave the same). The runtime marks these
 * `retryable: true`, and Cloudflare's guidance is to retry them — without
 * this, the first request after each deploy surfaced as a raw 500. All
 * engine RPCs are pure reads, so retrying is always safe. Engine-unavailable
 * errors (real 503 semantics) are never retried.
 */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await unwrap(call());
		} catch (err) {
			if (err instanceof EngineUnavailableError) throw err;
			const flags = err as { retryable?: boolean; overloaded?: boolean };
			if (attempt >= 2 || flags.retryable !== true || flags.overloaded === true) throw err;
			console.warn(`retryable engine RPC failure (attempt ${attempt + 1}): ${err}`);
			// The reset completes in well under a second; brief linear backoff.
			await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
		}
	}
}

/**
 * Warm RPC wall time, summarized into the log.
 *
 * This is the ONLY input to the shard controller's latency trigger, and none of
 * it was observable before: the wake log above fires only when the answering DO
 * had to acquire its engine, so production could show cold RPCs and nothing
 * else. That left floorEwma — which decides whether the `MULT x floor` rule or
 * the flat LATENCY_ABS_MS bar binds, and therefore what utilization expansion
 * actually fires at — unmeasurable from outside.
 *
 * What this measures is now a BACKSTOP rather than the main signal. The 2026-08-13
 * ceiling ramp showed why: on /search the DO contributes ~2.9ms of the ~124ms a
 * client waits, so this number is overwhelmingly transport and cannot see the DO
 * cross 80% utilization at all. It is less lopsided on the heavy routes — 15.15ms
 * for /cards/search — but the signal is the same shape, and the DO's own reported
 * rate is what expansion keys on instead (shard-controller.ts DO_CEILING_RATE).
 * Reading min against mean here is still the right way to see what the backstop is
 * comparing against.
 *
 * Windowed by TIME rather than by count, and the first warm RPC an isolate sees
 * always emits. A 1-in-N counter is per-isolate state, so it only reports once
 * one isolate has personally served N warm searches — which never happens at
 * sparse traffic, and misses exactly the transition worth seeing: the first
 * warm RPC after a cold colo finishes waking. Under load the window caps the
 * cost instead.
 *
 * min is the number to read: floorEwma tracks the fast tail, so the minimum
 * here is the closest thing to the value the controller is actually comparing
 * against.
 */
const WARM_RPC_WINDOW_MS = 2_000;

/**
 * A window's worth of warm samples, kept PER REGION.
 *
 * It used to be one set of module globals, which was wrong for the same reason
 * the shard controller keys its state by region: `regionHint` splits NA and EU
 * by longitude, so one isolate near -100° serves users on both sides of it and
 * addresses both `wnam` and `enam`. Pooling their samples produced a line that
 * described neither — and the whole use for this line now is comparing regions
 * against each other, which a pooled number cannot support.
 */
interface WarmWindow {
	start: number;
	count: number;
	min: number;
	max: number;
	sum: number;
}
const warmWindows = new Map<string, WarmWindow>();

/**
 * A warm RPC whose MINIMUM is this slow reads as distance rather than work.
 *
 * The number is chosen to be un-triggerable by ordinary load. A same-region warm
 * call is 20-70ms in production, dominated by payload serialization; a call to
 * an object on the far side of the planet cannot be faster than its round trip,
 * which is 150ms+ before any work happens. Sitting the bar at 250ms on the
 * window's MINIMUM — not its average, not a single sample — means queueing,
 * a large `/cards/search` payload, or a slow neighbour do not reach it, while a
 * misplaced object cannot avoid it.
 *
 * This is the detection half of placement: the trace probe (placement.ts) says
 * where an object is when someone reads its log line, and this says something is
 * wrong without anyone looking. It is a WARNING, not proof — read it as "go run
 * the placement query in ENGINE-PLACEMENT.md", not as "the object has moved".
 */
const WARM_RPC_FAR_MS = 250;

function sampleWarmRpc(region: string, colo: string, rpcMs: number): void {
	const w = warmWindows.get(region) ?? { start: 0, count: 0, min: Number.POSITIVE_INFINITY, max: 0, sum: 0 };
	warmWindows.set(region, w);
	w.count += 1;
	w.sum += rpcMs;
	if (rpcMs < w.min) w.min = rpcMs;
	if (rpcMs > w.max) w.max = rpcMs;
	const now = Date.now();
	if (w.start !== 0 && now - w.start < WARM_RPC_WINDOW_MS) return;
	// `[wnam@SJC]` — the region this isolate routed to, and the colo it routed
	// FROM. The colo is what makes the line checkable: the colos that appear here
	// under a region are the colos that region's traffic actually arrives at, so
	// they are what an object's self-reported colo has to sit among.
	const prefix = `[${region}@${colo}]`;
	console.log(
		`${prefix} warm engine rpc: n=${w.count} min=${w.min}ms avg=${(w.sum / w.count).toFixed(1)}ms ` +
			`max=${w.max}ms over ${w.start === 0 ? 0 : now - w.start}ms`,
	);
	if (w.min >= WARM_RPC_FAR_MS) {
		// Name the OBJECTS, not the replica-group label. `engine-<region>` is what
		// replicaGroupOf returns and nothing loads a store into it; the things this
		// window actually timed are `engine-<region>[-<n>]-p<k>`, and the window
		// mixes every partition and shard this isolate addressed, so the floor says
		// "at least one of them is far", never which.
		console.warn(
			`${prefix} warm engine rpc floor is ${w.min}ms — an engine-${region}[-<n>]-p<k> object may not be ` +
				`in ${region}; check their placement lines (see ENGINE-PLACEMENT.md)`,
		);
	}
	w.start = now;
	w.count = 0;
	w.min = Number.POSITIVE_INFINITY;
	w.max = 0;
	w.sum = 0;
}

export class RemoteEngine implements Engine {
	/** get_catalog reads both catalogs; one RPC serves both calls. */
	private catalogOnce: Promise<{
		types: Record<string, number>;
		keywords: Record<string, number>;
		setsWithExtras: string[];
	}> | null = null;

	constructor(
		private readonly stub: SearchEngineStub,
		/** Which region's DO this stub addresses — the key the shard controller
		 * keeps its state under, since one isolate can serve both sides of a
		 * longitude split and therefore address two regions. */
		private readonly region: string,
		/** The colo THIS isolate is in, for the warm-RPC line. Defaults for the
		 * tests and tooling that construct engines outside a request. */
		private readonly colo: string = "?",
	) {}

	/**
	 * One search RPC, with the DO's riders stripped and fed to the autoscaler.
	 *
	 * A RELAYED sample is dropped wholesale: it describes the regional DO, not
	 * the colo shard being scaled — its wall time includes a cross-colo hop, and
	 * its depth/rate are the region's. Since every freshly opened shard relays
	 * until it warms, reporting these would let each expansion argue for the next.
	 */
	private async searchRpc<T extends object>(call: () => Promise<T & Telemetry>): Promise<Omit<T, keyof Telemetry>> {
		const rpcStart = Date.now();
		const { acquireMs, load, rate, shards, ...result } = await withRetry(call);
		this.feedAutoscaler(rpcStart, { acquireMs, load, rate, shards });
		return result as Omit<T, keyof Telemetry>;
	}

	/**
	 * Hand one call's riders to the shard controller.
	 *
	 * Shared by BOTH transports rather than reimplemented per path. The autoscaler is fed only from
	 * here, so a route that moves between RPC and the payload stream cannot quietly stop reporting
	 * — which for /cards/search would mean the controller losing sight of the very route whose
	 * ceiling DO_CEILING_RATE is calibrated against.
	 */
	private feedAutoscaler(rpcStart: number, { acquireMs, load, rate, shards }: Telemetry): void {
		if (acquireMs) {
			// Wake observability: logged only when the DO that answered had to
			// acquire its engine.
			console.log(
				`[${this.region}] engine rpc took ${Date.now() - rpcStart}ms, of which ${acquireMs}ms was the DO acquiring its store`,
			);
		}
		// The rendezvous: adopt a fan-out this region already reached, so an
		// isolate that never expanded on its own stops pinning shard 0.
		if (shards !== undefined) adoptShardWidth(this.region, shards);
		if (load !== undefined) reportEngineLoad(this.region, load);
		if (rate !== undefined) reportEngineRate(this.region, rate);
		// Wake-carrying calls are excluded from the latency signal: their wall time
		// is legitimately inflated by the load, so reporting them would let every
		// expansion argue for the next.
		if (!acquireMs) {
			const rpcMs = Date.now() - rpcStart;
			reportEngineLatency(this.region, rpcMs);
			sampleWarmRpc(this.region, this.colo, rpcMs);
		}
	}

	/**
	 * `/cards/search`'s WHOLE response — envelope, headers and status — built in the Durable Object.
	 *
	 * The isolate's only job on this route is choosing the shard and handing this back. Splicing the
	 * envelope here instead meant reading and re-enqueuing every chunk of a 652KB page in the
	 * metered isolate, measured at ~13ms mean against the free plan's 10ms budget; passing the body
	 * through costs nothing that scales with it. The riders are read off the headers first, so the
	 * autoscaler is fed exactly as it is on every other path.
	 */
	async scryfallSearchPage(
		opts: EngineSearchOptions,
		baseUrl: string,
		envelope: SearchPageEnvelope,
		cache: Record<string, string>,
		/** "cards2" routes the same request through the two-phase gather (plan
		 * B5) — set only by PartitionedEngine, whose stub is a partition object. */
		call: "cards" | "cards2" = "cards",
	): Promise<Response> {
		const rpcStart = Date.now();
		const res = await this.stub.fetch(
			new Request(`https://engine${ENGINE_STREAM_PATH}`, {
				method: "POST",
				body: JSON.stringify({
					call,
					opts,
					baseUrl,
					envelope,
					cache,
					shards: currentShardWidth(this.region),
				}),
			}),
		);
		if (res.status === 503) {
			// The transport reports EVERY failure as a 503 with the class name in a header, so the
			// class has to be rebuilt here or the raw 503 becomes the client's answer — which is
			// exactly how a malformed regex in a user's query produced a 5xx with a non-JSON body.
			const kind = res.headers.get("x-engine-error");
			const message = await res.text();
			if (kind === "EngineUnavailableError") throw new EngineUnavailableError(message);
			if (message.startsWith(BUILD_FILTER_ERROR_PREFIX)) throw new EngineQueryError(message);
			throw new Error(message);
		}
		const num = (name: string): number | undefined => {
			const raw = res.headers.get(name);
			return raw === null ? undefined : Number(raw);
		};
		this.feedAutoscaler(rpcStart, {
			acquireMs: num("x-acquire-ms"),
			load: num("x-load"),
			rate: num("x-rate"),
			shards: num("x-shards"),
		});
		return res;
	}

	searchCardsAsObjects(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		return this.searchRpc(() => this.stub.searchCardsAsObjects(opts, currentShardWidth(this.region)));
	}

	searchCardsAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		return this.searchRpc(() => this.stub.searchCardsAsJson(opts, shape, currentShardWidth(this.region)));
	}

	// ── Gather twins (partitioned serving; called by PartitionedEngine only) ────
	//
	// Same instrumentation as the local twins — the gather object's riders feed
	// the autoscaler exactly as a single-store object's do, so partitioned
	// serving cannot quietly blind the shard controller.

	gatherSearchAsObjects(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		return this.searchRpc(() => this.stub.gatherSearchAsObjects(opts, currentShardWidth(this.region)));
	}

	gatherSearchAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		return this.searchRpc(() => this.stub.gatherSearchAsJson(opts, shape, currentShardWidth(this.region)));
	}

	gatherScryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult> {
		return this.searchRpc(() => this.stub.gatherScryfallSearch(opts, baseUrl, currentShardWidth(this.region)));
	}

	private catalog() {
		this.catalogOnce ??= withRetry(() => this.stub.typeAndKeywordCounts());
		return this.catalogOnce;
	}

	async cardTypeCounts(): Promise<Record<string, number>> {
		return (await this.catalog()).types;
	}

	async cardKeywordCounts(): Promise<Record<string, number>> {
		return (await this.catalog()).keywords;
	}

	async setsWithExtras(): Promise<string[]> {
		return (await this.catalog()).setsWithExtras;
	}

	randomCardsAsObjects(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		return withRetry(() => this.stub.randomCardsAsObjects(numCards, fields));
	}

	randomCardsAsJson(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult> {
		return withRetry(() => this.stub.randomCardsAsJson(numCards, fields, shape));
	}

	cardCount(): Promise<number> {
		return withRetry(() => this.stub.cardCount());
	}

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// Through `searchRpc`, exactly like search(), so these calls FEED THE AUTOSCALER rather than
	// being invisible to it. mtg-seeker points at `/cards/*`; if this went through plain
	// `withRetry` the shard controller would see only `/search` depth, rate and latency, and would
	// sit at one shard while the traffic that actually arrives saturated it. Same reason they pass
	// `currentShardWidth(this.region)`: the shard rendezvous is what scale-out depends on, and a
	// second serving surface has to join it rather than route around it.

	async scryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult> {
		return this.searchRpc(() => this.stub.scryfallSearch(opts, baseUrl, currentShardWidth(this.region)));
	}

	async scryfallCardById(scryfallId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const { card } = await this.searchRpc(() =>
			this.stub.scryfallCardById(scryfallId, baseUrl, currentShardWidth(this.region)),
		);
		return card;
	}

	async scryfallCardsByIds(scryfallIds: string[], baseUrl: string): Promise<Record<string, unknown>[]> {
		const { cards } = await this.searchRpc(() =>
			this.stub.scryfallCardsByIds(scryfallIds, baseUrl, currentShardWidth(this.region)),
		);
		return cards;
	}

	async scryfallCardByOracleId(oracleId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const { card } = await this.searchRpc(() =>
			this.stub.scryfallCardByOracleId(oracleId, baseUrl, currentShardWidth(this.region)),
		);
		return card;
	}

	async scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
	): Promise<Record<string, unknown> | null> {
		const { card } = await this.searchRpc(() =>
			this.stub.scryfallCardByExternalId(namespace, externalId, baseUrl, currentShardWidth(this.region)),
		);
		return card;
	}

	async scryfallFuzzyName(name: string, baseUrl: string): Promise<ScryfallFuzzyResult> {
		return this.searchRpc(() => this.stub.scryfallFuzzyName(name, baseUrl, currentShardWidth(this.region)));
	}

	/** This partition's scores-bearing fuzzy candidates — no telemetry riders (like the gather
	 * phases, it is partition machinery, not a shard-controller-fed route). */
	async fuzzyCandidates(name: string): Promise<FuzzyCandidateWire[]> {
		const { candidates } = await withRetry(() => this.stub.fuzzyCandidates(name));
		return candidates;
	}

	async scryfallAutocomplete(prefix: string, limit: number): Promise<string[]> {
		const { names } = await this.searchRpc(() =>
			this.stub.scryfallAutocomplete(prefix, limit, currentShardWidth(this.region)),
		);
		return names;
	}

	async scryfallExactName(folded: string, setCode: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const { card } = await this.searchRpc(() =>
			this.stub.scryfallExactName(folded, setCode, baseUrl, currentShardWidth(this.region)),
		);
		return card;
	}

	async scryfallCardByIllustrationId(illustrationId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const { card } = await this.searchRpc(() =>
			this.stub.scryfallCardByIllustrationId(illustrationId, baseUrl, currentShardWidth(this.region)),
		);
		return card;
	}

	async scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
	): Promise<Record<string, unknown>[]> {
		const { cards } = await this.searchRpc(() =>
			this.stub.scryfallNamesContaining(words, setCode, limit, baseUrl, currentShardWidth(this.region)),
		);
		return cards;
	}

	async scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]> {
		const { cards } = await this.searchRpc(() =>
			this.stub.scryfallFirstOfEach(filterTreeJsons, baseUrl, currentShardWidth(this.region)),
		);
		return cards;
	}
}
