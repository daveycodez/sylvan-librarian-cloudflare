// Engine implementation backed by the region's SearchEngine DO — the only
// serving path: isolates parse and RPC here, never loading the store.

import { decodeCollectionPacket } from "./collection-batch";
import {
	adoptShardWidth,
	currentShardWidth,
	reportEngineLatency,
	reportEngineLoad,
	reportEngineRate,
} from "./shard-controller";
import type {
	CollectionBatch,
	CollectionBatchAnswer,
	CollectionScope,
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	ExactNameProbe,
	FuzzyCandidateWire,
	NamedFuzzyBundle,
	NamedFuzzyOwnBundle,
	NamedFuzzyPlanReply,
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
	STALE_MODULUS_MARKER,
	StaleModulusError,
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
	searchCardsAsObjects(
		opts: EngineSearchOptions,
		reportedShards?: number,
		pinnedPartitionCount?: number,
	): Promise<EngineSearchResult & Telemetry>;
	searchCardsAsJson(
		opts: EngineSearchOptions,
		shape: ResultShape,
		reportedShards?: number,
		pinnedPartitionCount?: number,
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
	randomCardsAsObjects(numCards: number, fields: string[], filterTreeJson?: string): Promise<Record<string, unknown>[]>;
	randomCardsAsJson(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		filterTreeJson?: string,
	): Promise<EngineSerializedResult>;
	cardCount(): Promise<number>;
	// Every `/cards/*` reply carries the same shard-controller riders search does, and wraps its
	// payload so a null card has something to carry them on.
	scryfallSearch(
		opts: EngineSearchOptions,
		baseUrl: string,
		reportedShards?: number,
		pinnedPartitionCount?: number,
	): Promise<EngineSerializedResult & Telemetry>;
	scryfallCardById(
		scryfallId: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ card: Record<string, unknown> | null } & Telemetry>;
	scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ card: Record<string, unknown> | null } & Telemetry>;
	scryfallFuzzyName(
		name: string,
		baseUrl: string,
		reportedShards?: number,
		setCode?: string,
	): Promise<ScryfallFuzzyResult & Telemetry>;
	fuzzyCandidates(name: string, setCode?: string): Promise<{ candidates: FuzzyCandidateWire[] }>;
	scryfallAutocomplete(
		prefix: string,
		limit: number,
		reportedShards?: number,
	): Promise<{ names: string[] } & Telemetry>;
	scryfallAutocompleteNames(
		prefix: string,
		limit: number,
		reportedShards?: number,
	): Promise<{ names: string[] } & Telemetry>;
	scryfallNamedFuzzyPlan(
		folded: string,
		words: string[],
		reportedShards?: number,
		own?: NamedFuzzyOwnBundle,
	): Promise<NamedFuzzyPlanReply & Telemetry>;
	scryfallExactName(
		folded: string,
		setCode: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ card: Record<string, unknown> | null } & Telemetry>;
	scryfallExactNameRank(
		folded: string,
		setCode: string,
		reportedShards?: number,
	): Promise<{ rank: number[] | null } & Telemetry>;
	scryfallExactNameProbe(
		folded: string,
		setCode: string,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ probe: ExactNameProbe } & Telemetry>;
	scryfallNamedFuzzyBundle(
		folded: string,
		setCode: string,
		words: string[],
		limit: number,
		baseUrl: string,
		reportedShards?: number,
	): Promise<{ bundle: NamedFuzzyBundle } & Telemetry>;
	scryfallCollectionBatch(
		batch: CollectionBatch,
		baseUrl: string,
		scope: CollectionScope | null,
		reportedShards?: number,
	): Promise<{ packet: Uint8Array } & Telemetry>;
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
		const stale = message.indexOf(STALE_MODULUS_MARKER);
		if (stale >= 0) throw new StaleModulusError(message.slice(stale + STALE_MODULUS_MARKER.length + 1));
		throw err;
	}
}

/**
 * The platform's own "the object was being reset" failures, by message, plus the loader's own
 * abandoned-load error (store.ts StoreLoadStalledError). The runtime flags some resets
 * `retryable: true` but not all — at the 2026-09-23 06:45 deploy "Durable Object storage is no
 * longer accessible", "this Durable Object instance is no longer active" and "caused object to be
 * reset" all reached users unflagged. Each means the object is starting over, so one more attempt
 * lands on the fresh instance.
 */
const TRANSIENT_PLATFORM_FAILURE =
	/storage is no longer accessible|instance is no longer active|reset because its code was updated|caused object to be reset|store load stalled|abandoned after its deadline/i;

/**
 * Whether a failed engine call is worth ONE more attempt: the runtime says so, or the object was
 * resetting. Never an answer about the query or the store, never a timeout (the same object would
 * eat the same deadline again — the caller fails over instead), and never when the runtime says the
 * object is overloaded: repeating into an overloaded object is how a retry becomes a storm.
 */
export function isTransientEngineFailure(err: unknown): boolean {
	if (
		err instanceof EngineUnavailableError ||
		err instanceof EngineQueryError ||
		err instanceof StaleModulusError ||
		err instanceof EngineCallTimeoutError
	) {
		return false;
	}
	const flags = err as { retryable?: boolean; overloaded?: boolean } | null;
	if (flags?.overloaded === true) return false;
	if (flags?.retryable === true) return true;
	const message = err instanceof Error ? err.message : String(err);
	return TRANSIENT_PLATFORM_FAILURE.test(message);
}

/**
 * The most one engine call may take, end to end, before the caller stops waiting.
 *
 * Above everything a healthy call can legitimately spend — a cold region waking its partitions
 * (measured 8.2s worst) plus a heavy query — and above the loader's own 20s load deadline, so a
 * stalled load surfaces as the loader's retryable error first. What it exists for is the object
 * that never answers at all: without it a request waited as long as the client did.
 */
export let ENGINE_CALL_DEADLINE_MS = 35_000;

/** For tests: shorten the engine-call deadline. */
export function setEngineCallDeadlineForTests(ms: number): void {
	ENGINE_CALL_DEADLINE_MS = ms;
}

/** An engine call outlived ENGINE_CALL_DEADLINE_MS. Not retried on the same object. */
export class EngineCallTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngineCallTimeoutError";
	}
}

/** `promise`, or EngineCallTimeoutError after `ms`. The call itself is not cancelled; its answer is ignored. */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new EngineCallTimeoutError(`${what} did not answer within ${ms}ms`)), ms);
	});
	promise.catch(() => {});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The most a gather waits on one sibling: above the loader's 20s deadline, so a sibling whose load
 * stalled answers with its retryable abandoned-load error first, and below the Worker's 35s, so a
 * gather that cannot finish fails in time for the Worker to try another coordinator.
 */
export const SIBLING_CALL_DEADLINE_MS = 25_000;

/** One sibling RPC with a deadline and ONE retry of a reset or an abandoned load. */
export async function siblingCall<T, S>(what: string, connect: () => S, call: (stub: S) => Promise<T>): Promise<T> {
	try {
		return await withDeadline(call(connect()), SIBLING_CALL_DEADLINE_MS, what);
	} catch (err) {
		if (!isTransientEngineFailure(err)) throw err;
		console.warn(`${what} failed transiently (${err}); asking once more on a fresh stub`);
		// A FRESH stub: after "this Durable Object instance is no longer active. Reconnect or retry"
		// the first stub's connection is dead, and a retry through it fails the same way.
		return withDeadline(call(connect()), SIBLING_CALL_DEADLINE_MS, what);
	}
}

/** One retry at most, after a jittered 100–300ms pause: enough for a reset to finish, too little to pile up. */
const ENGINE_CALL_ATTEMPTS = 2;
const retryPause = () => new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 200)));

/**
 * How long an engine call may stay silent before the SAME call is also sent to the same partition
 * in a neighbouring region (placement-policy.ts hedgeRegionFor), the first answer winning.
 *
 * WHY: an engine object evicted after ~10s idle is torn down while requests are still arriving, and
 * a request that lands on the dying instance can HANG until the object restarts elsewhere — 19.2s
 * (engine-enam-p8, 09-24 09:58), 22.5s (wnam-p7), 35–36.7s (enam-p5; weur-p0 and p3 sharing one
 * isolate, 09-25), ~30 a day on 09-24, and 15 minutes for wnam-p2/p8 on 09-23. Retrying the SAME
 * object waits on the same teardown; the neighbour's copy of the partition is a different object on
 * the same store and answers identically.
 *
 * WHY 4s: healthy engine wall times are p50 14–18ms, p90 72–121ms, p99 438–637ms, p999 1.1–2.6s,
 * and a call carrying a store wake is ~100–400ms from the local cache, 0.3–1s from KV, occasionally
 * 1–3s — so 4s sits above everything a healthy call spends, and a hedge fires on well under 0.1%
 * of healthy calls (fewer than one in a thousand, since even p999 is 2.6s). It is also well under
 * the 10s after which mtg-seeker's client gives up, so a hedged answer (4s + a warm neighbour's
 * ~100ms, + ~100ms of ocean when the neighbour is across one) still reaches it.
 */
export let ENGINE_HEDGE_MS = 4_000;

/** For tests: shorten (or with Infinity, disable) the hedge delay. */
export function setEngineHedgeForTests(ms: number): void {
	ENGINE_HEDGE_MS = ms;
}

/** The neighbour a RemoteEngine hedges a slow call to: the same partition, shard 0, another region. */
export interface EngineHedge {
	/** The neighbouring served region (hedgeRegionFor). */
	region: string;
	/** The partition both objects hold — for the log line. */
	partition: number;
	/** A stub to that object, built by index.ts through placeEngineStub, and only when the hedge fires. */
	connect: () => SearchEngineStub;
}

/** Which side of a hedged call answered. */
type HedgeWinner = "primary" | "hedge";

/**
 * Whether a primary that FAILED (after its own retry, when it had one) is worth asking the
 * neighbour for at once — the FAILOVER, where the hedge proper waits for silence.
 *
 * WHY: on DeckGen 2026-09-26, bursts of mtg-seeker traffic met a cold wnam (00:46:32, ~6,300 engine
 * calls in the minute after ~2 a minute; 02:48:39, ~4,000) and the coordinators' calls to their
 * siblings died with "Network connection lost." — 934 and 1,526 of them within 4–8s, the fresh-stub
 * retry dying the same way. Each gather then failed FAST, 1–2s in, long before ENGINE_HEDGE_MS, so
 * the neighbour was never asked and 81 and 98 /cards/search answered 500; the calls that merely hung
 * past 4s were hedged to enam, which answered 103 of 103. The failure reaches this isolate as the
 * gather's plain 503 text, which no retry rule recognizes — so this rule works by exclusion, not by
 * message: whatever broke in this region (a lost connection, an overloaded or resetting object, a
 * store not loaded) is some other isolate's business in the neighbour's copy of the partition.
 *
 * Never for an answer that is the same in every region — the filter's own query error — nor for the
 * stale-modulus refusal PartitionedEngine already routes around by gathering. A failure that IS
 * deterministic costs one extra Durable Object request on a request that was failing anyway.
 */
function failsOverToNeighbour(err: unknown): boolean {
	return !(err instanceof EngineQueryError) && !(err instanceof StaleModulusError);
}

/**
 * Run `primary` (today's call, retry included); if it has not settled within ENGINE_HEDGE_MS, also
 * run `hedge` once, and take the first SUCCESSFUL answer. A primary that FAILS before then runs the
 * hedge at once instead: the failover (failsOverToNeighbour).
 *
 * - Primary answers before the timer: exactly today's behaviour, and no hedge call is made — so a
 *   fast call costs nothing, and a fast transient failure still gets its one retry on a fresh stub
 *   (inside `primary`) before anything else happens.
 * - Primary fails before the timer: the neighbour is asked now ("engine failover" in the log), and
 *   its answer is the answer; the neighbour failing too surfaces the PRIMARY's error. A query error
 *   or a stale-modulus refusal is surfaced at once, as before.
 * - After the timer, a failure from either side waits for the other; both failing surfaces the
 *   PRIMARY's error. A query error from the primary is the query's own answer, identical in every
 *   region, so it is surfaced at once rather than waiting on the hedge.
 * - The hedge is bounded by what is left of ENGINE_CALL_DEADLINE_MS, measured from the primary's
 *   start, so the pair never outlives the deadline a lone call has. It is ONE attempt: no retry,
 *   so a slow or failed call costs at most one extra Durable Object request.
 * - The loser's answer, when it arrives, goes to `dispose` (a stream Response's body is cancelled
 *   there) and is otherwise ignored. `abandoned` tells the primary's retry loop not to retry for an
 *   answer nobody is waiting for.
 */
function hedgedCall<T>(
	primary: (abandoned: () => boolean) => Promise<T>,
	hedge: (() => Promise<T>) | null,
	describe: { region: string; hedgeRegion: string; partition: number; method: string },
	dispose?: (loser: T) => void,
): Promise<{ value: T; from: HedgeWinner }> {
	if (hedge === null || !Number.isFinite(ENGINE_HEDGE_MS)) {
		return primary(() => false).then((value) => ({ value, from: "primary" as const }));
	}
	const started = Date.now();
	const at = `p${describe.partition} ${describe.method}`;
	return new Promise((resolve, reject) => {
		let done = false;
		let hedgeState: "idle" | "running" | "failed" = "idle";
		let primaryFailure: { err: unknown } | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const win = (value: T, from: HedgeWinner) => {
			done = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve({ value, from });
		};
		const fail = (err: unknown) => {
			done = true;
			if (timer !== undefined) clearTimeout(timer);
			reject(err);
		};
		const lose = (value: T) => {
			try {
				dispose?.(value);
			} catch {
				// A loser that cannot be disposed of is garbage either way.
			}
		};
		/** The one call to the neighbour. `kind` says why, and heads its log lines: "hedge" after
		 * ENGINE_HEDGE_MS of silence, "failover" after a failure — counted apart, as they measure
		 * different things (a hanging object vs a failing one). */
		const askNeighbour = (kind: "hedge" | "failover") => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			hedgeState = "running";
			const where = `[${describe.region}] engine ${kind} ${at}`;
			const remaining = Math.max(1, ENGINE_CALL_DEADLINE_MS - (Date.now() - started));
			console.warn(
				kind === "hedge"
					? `${where}: no answer from ${describe.region} after ${Date.now() - started}ms; asking ${describe.hedgeRegion}`
					: `${where}: ${describe.region} failed after ${Date.now() - started}ms (${primaryFailure?.err}); asking ${describe.hedgeRegion}`,
			);
			let attempt: Promise<T>;
			try {
				attempt = withDeadline(hedge(), remaining, `hedged ${describe.method}`);
			} catch (err) {
				attempt = Promise.reject(err);
			}
			attempt.then(
				(value) => {
					if (done) return lose(value);
					console.warn(`${where}: ${kind} won — ${describe.hedgeRegion} answered at ${Date.now() - started}ms`);
					win(value, "hedge");
				},
				(err) => {
					hedgeState = "failed";
					if (done) return;
					console.warn(`${where}: ${kind} to ${describe.hedgeRegion} failed after ${Date.now() - started}ms: ${err}`);
					if (primaryFailure) fail(primaryFailure.err);
				},
			);
		};
		primary(() => done).then(
			(value) => {
				if (done) return lose(value);
				if (hedgeState !== "idle") {
					console.warn(
						`[${describe.region}] engine hedge ${at}: primary won after ${Date.now() - started}ms (hedge to ${describe.hedgeRegion})`,
					);
				}
				win(value, "primary");
			},
			(err) => {
				if (done) return;
				// The query's own answer is the same in every region: surfaced at once, hedge or not.
				if (err instanceof EngineQueryError) return fail(err);
				// The hedge is out: wait for it.
				if (hedgeState === "running") {
					primaryFailure = { err };
					return;
				}
				// Not yet: the failover — the neighbour now, instead of a 500 now.
				if (hedgeState === "idle" && failsOverToNeighbour(err)) {
					primaryFailure = { err };
					askNeighbour("failover");
					return;
				}
				fail(err);
			},
		);
		timer = setTimeout(() => {
			timer = undefined;
			if (done || hedgeState !== "idle") return;
			askNeighbour("hedge");
		}, ENGINE_HEDGE_MS);
	});
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
async function withRetry<T>(
	call: () => Promise<T>,
	reconnect?: () => void,
	/** True once a hedge has answered in this call's place: a failure is then not worth retrying. */
	abandoned: () => boolean = () => false,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await unwrap(withDeadline(call(), ENGINE_CALL_DEADLINE_MS, "engine RPC"));
		} catch (err) {
			if (attempt >= ENGINE_CALL_ATTEMPTS - 1 || !isTransientEngineFailure(err) || abandoned()) throw err;
			console.warn(`retryable engine RPC failure (attempt ${attempt + 1}): ${err}`);
			// A fresh stub before the second attempt: after "Connection closed: this Durable Object
			// instance is no longer active. Reconnect or retry the request." the OLD stub's connection
			// is dead, and a retry through it fails identically — 2026-09-23 21:20:02, a /cards/collection
			// 500 two minutes after a deploy, retried once and failed the same way.
			reconnect?.();
			await retryPause();
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
export interface WarmWindow {
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

/**
 * Samples a window needs before its floor is read as distance.
 *
 * The floor is the fastest call, and the fastest of several calls is the round trip. With ONE
 * call it is just that call — including its query work, and a heavy query (a broad regex over
 * oracle text) legitimately takes 1–2 seconds warm. Measured on DeckGen 2026-09-20..23: ~2,200
 * `wnam` warnings, every one from an n=1 window (827ms, 2048ms), while multi-call windows from the
 * same colos floored at 10–75ms and every engine-wnam object placed at SEA. The real signals
 * (apac@AMS n=10 min=256ms) survive the bar.
 */
const WARM_RPC_FAR_MIN_SAMPLES = 3;

/**
 * What a closed window says. Pure, so the rule is testable without the module's windows.
 *
 * The summary line needs at least TWO samples: a one-sample window is a per-request line, and it
 * says nothing the invocation log does not. Measured on DeckGen for 2026-09-21, ~100k of the
 * Worker's 137k console lines were `warm engine rpc: n=1 …` — at that traffic the 2s window
 * closed with a single sample on nearly every request. The far-floor WARNING needs
 * WARM_RPC_FAR_MIN_SAMPLES calls, because a floor of fewer is a query's cost rather than distance.
 */
export function warmWindowLines(
	w: Readonly<WarmWindow>,
	region: string,
	colo: string,
	now: number,
	aliased = false,
): { log: string | null; warn: string | null } {
	const prefix = `[${region}@${colo}]`;
	const log =
		w.count >= 2
			? `${prefix} warm engine rpc: n=${w.count} min=${w.min}ms avg=${(w.sum / w.count).toFixed(1)}ms ` +
				`max=${w.max}ms over ${now - w.start}ms`
			: null;
	// Name the OBJECTS, not the replica-group label. `engine-<region>` is what
	// replicaGroupOf returns and nothing loads a store into it; the things this
	// window actually timed are `engine-<region>[-<n>]-p<k>`, and the window
	// mixes every partition and shard this isolate addressed, so the floor says
	// "at least one of them is far", never which.
	//
	// ALIASED traffic is far by design: an EZE request maps to `sam`, which g1's placement block
	// sends to enam's objects in the US East, so its floor is the Buenos Aires–Virginia round trip and
	// the warning would accuse objects that sit exactly where they should (`[enam@EZE] … 383ms`,
	// 2026-09-25). The window still logs; only the placement accusation is withheld.
	const warn =
		!aliased && w.count >= WARM_RPC_FAR_MIN_SAMPLES && w.min >= WARM_RPC_FAR_MS
			? `${prefix} warm engine rpc floor is ${w.min}ms — an engine-${region}[-<n>]-p<k> object may not be ` +
				`in ${region}; check their placement lines (see ENGINE-PLACEMENT.md)`
			: null;
	return { log, warn };
}

function sampleWarmRpc(region: string, colo: string, rpcMs: number, aliased: boolean): void {
	const now = Date.now();
	const w = warmWindows.get(region) ?? { start: now, count: 0, min: Number.POSITIVE_INFINITY, max: 0, sum: 0 };
	warmWindows.set(region, w);
	w.count += 1;
	w.sum += rpcMs;
	if (rpcMs < w.min) w.min = rpcMs;
	if (rpcMs > w.max) w.max = rpcMs;
	// The first sample opens the window silently; the window is reported when it closes.
	if (now - w.start < WARM_RPC_WINDOW_MS) return;
	// `[wnam@SJC]` — the region this isolate routed to, and the colo it routed
	// FROM. The colo is what makes the line checkable: the colos that appear here
	// under a region are the colos that region's traffic actually arrives at, so
	// they are what an object's self-reported colo has to sit among.
	const { log, warn } = warmWindowLines(w, region, colo, now, aliased);
	if (log) console.log(log);
	if (warn) console.warn(warn);
	w.start = now;
	w.count = 0;
	w.min = Number.POSITIVE_INFINITY;
	w.max = 0;
	w.sum = 0;
}

/**
 * One request on the payload stream (ENGINE_STREAM_PATH) with a deadline: the object's Response, or
 * the error class its 503 names. The transport reports EVERY failure as a 503 with the class name in
 * a header, so the class has to be rebuilt here or the raw 503 becomes the client's answer — which
 * is exactly how a malformed regex in a user's query produced a 5xx with a non-JSON body.
 */
async function pageAttempt(stub: SearchEngineStub, body: string, ms: number): Promise<Response> {
	const answer = await withDeadline(
		stub.fetch(new Request(`https://engine${ENGINE_STREAM_PATH}`, { method: "POST", body })),
		ms,
		"engine page",
	);
	if (answer.status !== 503) return answer;
	const kind = answer.headers.get("x-engine-error");
	const message = await answer.text();
	if (kind === "EngineUnavailableError") throw new EngineUnavailableError(message);
	if (kind === "StaleModulusError") throw new StaleModulusError(message);
	if (message.startsWith(BUILD_FILTER_ERROR_PREFIX)) throw new EngineQueryError(message);
	throw new Error(message);
}

/** The streaming transport's riders (search-engine-do.ts), stripped before a response leaves the isolate. */
export const ENGINE_TELEMETRY_HEADERS = [
	"x-total-cards",
	"x-row-count",
	"x-acquire-ms",
	"x-load",
	"x-rate",
	"x-shards",
	"x-gathered",
] as const;

export class RemoteEngine implements Engine {
	/** n15: how many partitions this object's last gathered search page asked (its `x-gathered`
	 * rider), or null when it did not say. Read by PartitionedEngine for the route's log line. */
	gatheredPartitions: number | null = null;

	/** get_catalog reads both catalogs; one RPC serves both calls. */
	private catalogOnce: Promise<{
		types: Record<string, number>;
		keywords: Record<string, number>;
		setsWithExtras: string[];
	}> | null = null;

	constructor(
		/** The object's stub — replaced by `connect()` before a retry, when there is one. */
		private stub: SearchEngineStub,
		/** Which region's DO this stub addresses — the key the shard controller
		 * keeps its state under, since one isolate can serve both sides of a
		 * longitude split and therefore address two regions. */
		private readonly region: string,
		/** The colo THIS isolate is in, for the warm-RPC line. Defaults for the
		 * tests and tooling that construct engines outside a request. */
		private readonly colo: string = "?",
		/** A fresh stub to the SAME object. A retry after a transient failure goes through it, because
		 * a stub whose connection the runtime closed ("this Durable Object instance is no longer
		 * active. Reconnect or retry the request.") fails every later call the same way. Without it a
		 * retry reuses `stub` — right for the tests' plain objects, wrong for a real dead connection. */
		private readonly connect?: () => SearchEngineStub,
		/** This request's own hint was aliased onto `region` (g1's placement block): its objects are
		 * far from this colo on purpose, so the warm-RPC floor is not read as misplacement. */
		private readonly aliased = false,
		/** Where a call that stays silent for ENGINE_HEDGE_MS is ALSO sent, and one that fails sooner is
		 * sent instead (see hedgedCall): this partition's object in a neighbouring served region.
		 * Absent means never hedge nor fail over — the warm ping
		 * for a newly opened shard, whose whole point is waking THIS object, is built without one. */
		private readonly hedge?: EngineHedge,
	) {}

	/** Swap in a fresh stub before a retry (see `connect`). */
	private readonly reconnect = (): void => {
		if (this.connect) this.stub = this.connect();
	};

	/**
	 * One PURE-READ call through the stub: today's deadline and single retry, hedged to the
	 * neighbouring region when this call stays silent or fails (hedgedCall). `call` is handed the stub and
	 * the fan-out width to report — this region's own for the primary, NONE for the hedge: the width
	 * rendezvous remembers the widest value any caller reports, and this region's width folded into
	 * the neighbour's shard-0 object would open replicas there that its own traffic never asked for.
	 *
	 * Only reads may come through here: a hedged call runs twice. Every engine query RPC is one;
	 * `cardCount` (the warm ping) deliberately is not routed here, and nothing that writes is.
	 */
	private read<T>(
		method: string,
		call: (stub: SearchEngineStub, reportedShards: number | undefined) => Promise<T>,
	): Promise<{ value: T; from: HedgeWinner }> {
		const hedge = this.hedge;
		return hedgedCall(
			(abandoned) => withRetry(() => call(this.stub, currentShardWidth(this.region)), this.reconnect, abandoned),
			hedge ? () => unwrap(call(hedge.connect(), undefined)) : null,
			{ region: this.region, hedgeRegion: hedge?.region ?? "", partition: hedge?.partition ?? -1, method },
		);
	}

	/**
	 * One search RPC, with the DO's riders stripped and fed to the autoscaler.
	 *
	 * An answer the HEDGE gave is not fed at all: its load, rate and width are the neighbour's
	 * object's, and its wall time includes the ENGINE_HEDGE_MS this region's object spent silent —
	 * fed as this region's, it would argue for replicas here (or adopt the neighbour's width) on
	 * evidence about somewhere else. The hedge's own log line (hedgedCall) is what counts them.
	 */
	private async searchRpc<T extends object>(
		method: string,
		call: (stub: SearchEngineStub, reportedShards: number | undefined) => Promise<T & Telemetry>,
	): Promise<Omit<T, keyof Telemetry>> {
		const rpcStart = Date.now();
		const { value, from } = await this.read(method, call);
		const { acquireMs, load, rate, shards, ...result } = value;
		if (from === "primary") this.feedAutoscaler(rpcStart, { acquireMs, load, rate, shards });
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
		// A wake-carrying reply's depth is the queue behind the object's OWN store load: every
		// request that arrived during the load waited for it and reports the ones before it. That
		// says nothing about whether one more replica is needed once the store is in memory, and a
		// burst that merely happened to meet a reload would open a replica that then idles. Its
		// RATE is still reported — arrivals are demand whether or not the store was loaded — so
		// real overload during a wake still expands on the rate bar, and on depth in the warm
		// replies that follow it.
		if (load !== undefined && !acquireMs) reportEngineLoad(this.region, load);
		if (rate !== undefined) reportEngineRate(this.region, rate);
		// Wake-carrying calls are excluded from the latency signal: their wall time
		// is legitimately inflated by the load, so reporting them would let every
		// expansion argue for the next.
		if (!acquireMs) {
			const rpcMs = Date.now() - rpcStart;
			reportEngineLatency(this.region, rpcMs);
			sampleWarmRpc(this.region, this.colo, rpcMs, this.aliased);
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
		/** The partition count a pinned "cards" call was routed against (pinned-oracle.ts). */
		pinnedPartitionCount?: number,
	): Promise<Response> {
		// The hedge's body reports NO width, for the reason `read` gives: this region's fan-out must not
		// be folded into the neighbour's rendezvous.
		const bodyWith = (shards: number | undefined) =>
			JSON.stringify({
				call,
				opts,
				baseUrl,
				envelope,
				cache,
				shards,
				...(pinnedPartitionCount === undefined ? {} : { pinnedPartitionCount }),
			});
		const body = bodyWith(currentShardWidth(this.region));
		const hedge = this.hedge;
		let rpcStart = Date.now();
		const { value: res, from } = await hedgedCall(
			async (abandoned) => {
				// The same deadline and single retry the RPC transport has (withRetry): a deploy resets every
				// object, and a request landing mid-reset fails as a thrown fetch or as the object's own 503.
				for (let attempt = 0; ; attempt++) {
					rpcStart = Date.now();
					try {
						return await pageAttempt(this.stub, body, ENGINE_CALL_DEADLINE_MS);
					} catch (err) {
						if (attempt >= ENGINE_CALL_ATTEMPTS - 1 || !isTransientEngineFailure(err) || abandoned()) throw err;
						console.warn(`retryable engine page failure (attempt ${attempt + 1}): ${err}`);
						this.reconnect(); // a dead connection fails the retry identically (withRetry)
						await retryPause();
					}
				}
			},
			// A hedged GATHER ("cards2") re-runs the whole gather in the neighbour: its coordinator fans out
			// to ITS siblings, so one hedge here also covers a sibling that is stuck behind this region's
			// coordinator — and the answer is one region's complete page, never a mix of two.
			hedge ? () => pageAttempt(hedge.connect(), bodyWith(undefined), ENGINE_CALL_DEADLINE_MS) : null,
			{
				region: this.region,
				hedgeRegion: hedge?.region ?? "",
				partition: hedge?.partition ?? -1,
				method: call === "cards2" ? "page-gather" : "page",
			},
			// The loser's stream is never read; cancel it so the pipe it holds is released.
			(loser) => {
				loser.body?.cancel().catch(() => {});
			},
		);
		const num = (name: string): number | undefined => {
			const raw = res.headers.get(name);
			return raw === null ? undefined : Number(raw);
		};
		// Not a hedged answer's riders: see searchRpc.
		if (from === "primary") {
			this.feedAutoscaler(rpcStart, {
				acquireMs: num("x-acquire-ms"),
				load: num("x-load"),
				rate: num("x-rate"),
				shards: num("x-shards"),
			});
		}
		// n15: how many partitions a gather asked (the names index can make it fewer than N) — kept for
		// the route's log line, like the riders never sent on to the client.
		const gathered = num("x-gathered");
		this.gatheredPartitions = gathered === undefined || Number.isNaN(gathered) ? null : gathered;
		// The riders are for THIS isolate, not the client: passed through verbatim they published the
		// shard controller's load, rate and width signals on every /cards/search — and cached them
		// at the edge. Body, status and every other header pass through untouched.
		const out = new Response(res.body, res);
		for (const name of ENGINE_TELEMETRY_HEADERS) out.headers.delete(name);
		return out;
	}

	searchCardsAsObjects(opts: EngineSearchOptions, pinnedPartitionCount?: number): Promise<EngineSearchResult> {
		return this.searchRpc("searchCardsAsObjects", (stub, shards) =>
			stub.searchCardsAsObjects(opts, shards, pinnedPartitionCount),
		);
	}

	searchCardsAsJson(
		opts: EngineSearchOptions,
		shape: ResultShape,
		pinnedPartitionCount?: number,
	): Promise<EngineSerializedResult> {
		return this.searchRpc("searchCardsAsJson", (stub, shards) =>
			stub.searchCardsAsJson(opts, shape, shards, pinnedPartitionCount),
		);
	}

	// ── Gather twins (partitioned serving; called by PartitionedEngine only) ────
	//
	// Same instrumentation as the local twins — the gather object's riders feed
	// the autoscaler exactly as a single-store object's do, so partitioned
	// serving cannot quietly blind the shard controller. A hedged gather re-runs
	// the WHOLE gather in the neighbour region (its coordinator, its siblings),
	// so the answer is still one region's, on one build.

	gatherSearchAsObjects(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		return this.searchRpc("gatherSearchAsObjects", (stub, shards) => stub.gatherSearchAsObjects(opts, shards));
	}

	gatherSearchAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		return this.searchRpc("gatherSearchAsJson", (stub, shards) => stub.gatherSearchAsJson(opts, shape, shards));
	}

	gatherScryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult> {
		return this.searchRpc("gatherScryfallSearch", (stub, shards) => stub.gatherScryfallSearch(opts, baseUrl, shards));
	}

	private catalog() {
		this.catalogOnce ??= this.read("typeAndKeywordCounts", (stub) => stub.typeAndKeywordCounts()).then((r) => r.value);
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

	async randomCardsAsObjects(
		numCards: number,
		fields: string[],
		filterTreeJson?: string,
	): Promise<Record<string, unknown>[]> {
		return (
			await this.read("randomCardsAsObjects", (stub) => stub.randomCardsAsObjects(numCards, fields, filterTreeJson))
		).value;
	}

	async randomCardsAsJson(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		filterTreeJson?: string,
	): Promise<EngineSerializedResult> {
		return (
			await this.read("randomCardsAsJson", (stub) => stub.randomCardsAsJson(numCards, fields, shape, filterTreeJson))
		).value;
	}

	/** NEVER hedged: its one caller is the warm ping for a newly opened shard (index.ts), whose whole
	 * point is to wake THIS object — a neighbour answering in its place would admit a cold shard. */
	cardCount(): Promise<number> {
		return withRetry(() => this.stub.cardCount(), this.reconnect);
	}

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// Through `searchRpc`, exactly like search(), so these calls FEED THE AUTOSCALER rather than
	// being invisible to it. mtg-seeker points at `/cards/*`; if this went through plain
	// `withRetry` the shard controller would see only `/search` depth, rate and latency, and would
	// sit at one shard while the traffic that actually arrives saturated it. Same reason they pass
	// `currentShardWidth(this.region)` (as `shards`, from `read`): the shard rendezvous is what
	// scale-out depends on, and a second serving surface has to join it rather than route around it.

	async scryfallSearch(
		opts: EngineSearchOptions,
		baseUrl: string,
		pinnedPartitionCount?: number,
	): Promise<EngineSerializedResult> {
		return this.searchRpc("scryfallSearch", (stub, shards) =>
			stub.scryfallSearch(opts, baseUrl, shards, pinnedPartitionCount),
		);
	}

	async scryfallCardById(scryfallId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const { card } = await this.searchRpc("scryfallCardById", (stub, shards) =>
			stub.scryfallCardById(scryfallId, baseUrl, shards),
		);
		return card;
	}

	async scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
	): Promise<Record<string, unknown> | null> {
		const { card } = await this.searchRpc("scryfallCardByExternalId", (stub, shards) =>
			stub.scryfallCardByExternalId(namespace, externalId, baseUrl, shards),
		);
		return card;
	}

	async scryfallFuzzyName(name: string, baseUrl: string, setCode = ""): Promise<ScryfallFuzzyResult> {
		return this.searchRpc("scryfallFuzzyName", (stub, shards) =>
			stub.scryfallFuzzyName(name, baseUrl, shards, setCode),
		);
	}

	/** This partition's scores-bearing fuzzy candidates — no telemetry riders (like the gather
	 * phases, it is partition machinery, not a shard-controller-fed route). */
	async fuzzyCandidates(name: string, setCode = ""): Promise<FuzzyCandidateWire[]> {
		const { value } = await this.read("fuzzyCandidates", (stub) => stub.fuzzyCandidates(name, setCode));
		return value.candidates;
	}

	async scryfallAutocomplete(prefix: string, limit: number): Promise<string[]> {
		const { names } = await this.searchRpc("scryfallAutocomplete", (stub, shards) =>
			stub.scryfallAutocomplete(prefix, limit, shards),
		);
		return names;
	}

	/** n15: which partitions `/cards/named?fuzzy=` must ask, planned by this one object from its names
	 * index (see the DO's scryfallNamedFuzzyPlan). Throws where the object cannot — the router then
	 * asks every partition. With `own` (x22) the reply also carries this object's own bundle when the
	 * plan names its partition; an object on the build before x22 never carries one. */
	async scryfallNamedFuzzyPlan(
		folded: string,
		words: string[],
		own?: NamedFuzzyOwnBundle,
	): Promise<NamedFuzzyPlanReply> {
		const { partitions, everywhere, stage, builtAt, bundle } = await this.searchRpc(
			"scryfallNamedFuzzyPlan",
			(stub, shards) =>
				own === undefined
					? stub.scryfallNamedFuzzyPlan(folded, words, shards)
					: stub.scryfallNamedFuzzyPlan(folded, words, shards, own),
		);
		return bundle === undefined
			? { partitions, everywhere, stage, builtAt }
			: { partitions, everywhere, stage, builtAt, bundle };
	}

	/** n8: the whole corpus's autocomplete from this one object's card-names blob (see the DO's
	 * scryfallAutocompleteNames). Throws where the object cannot — the router then fans out. */
	async scryfallAutocompleteNames(prefix: string, limit: number): Promise<string[]> {
		const { names } = await this.searchRpc("scryfallAutocompleteNames", (stub, shards) =>
			stub.scryfallAutocompleteNames(prefix, limit, shards),
		);
		return names;
	}

	async scryfallExactName(folded: string, setCode: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const { card } = await this.searchRpc("scryfallExactName", (stub, shards) =>
			stub.scryfallExactName(folded, setCode, baseUrl, shards),
		);
		return card;
	}

	/** The name route's probe (ExactNameProbe). */
	async scryfallExactNameProbe(folded: string, setCode: string, baseUrl: string): Promise<ExactNameProbe> {
		const { probe } = await this.searchRpc("scryfallExactNameProbe", (stub, shards) =>
			stub.scryfallExactNameProbe(folded, setCode, baseUrl, shards),
		);
		return probe;
	}

	/** `/cards/named?fuzzy=`'s three stages from this object in one call (NamedFuzzyBundle). */
	async scryfallNamedFuzzyBundle(
		folded: string,
		setCode: string,
		words: string[],
		limit: number,
		baseUrl: string,
	): Promise<NamedFuzzyBundle> {
		const { bundle } = await this.searchRpc("scryfallNamedFuzzyBundle", (stub, shards) =>
			stub.scryfallNamedFuzzyBundle(folded, setCode, words, limit, baseUrl, shards),
		);
		return bundle;
	}

	async scryfallExactNameRank(folded: string, setCode: string): Promise<number[] | null> {
		const { rank } = await this.searchRpc("scryfallExactNameRank", (stub, shards) =>
			stub.scryfallExactNameRank(folded, setCode, shards),
		);
		return rank;
	}

	async scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
	): Promise<Record<string, unknown>[]> {
		const { cards } = await this.searchRpc("scryfallNamesContaining", (stub, shards) =>
			stub.scryfallNamesContaining(words, setCode, limit, baseUrl, shards),
		);
		return cards;
	}

	async scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]> {
		const { cards } = await this.searchRpc("scryfallFirstOfEach", (stub, shards) =>
			stub.scryfallFirstOfEach(filterTreeJsons, baseUrl, shards),
		);
		return cards;
	}

	/** The one-round collection batch — see Engine.scryfallCollectionBatch. */
	async scryfallCollectionBatch(
		batch: CollectionBatch,
		baseUrl: string,
		scope?: CollectionScope | null,
	): Promise<CollectionBatchAnswer> {
		const { packet } = await this.searchRpc("scryfallCollectionBatch", (stub, shards) =>
			stub.scryfallCollectionBatch(batch, baseUrl, scope ?? null, shards),
		);
		return decodeCollectionPacket(packet, batch);
	}
}
