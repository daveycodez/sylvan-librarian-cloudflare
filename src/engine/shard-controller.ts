// Per-isolate shard autoscaler for the per-colo engine DOs.
//
// Zero request-path overhead by design: picking a shard is a couple of
// integer compares and one Math.random() — identical work at 1 shard and at
// 10 — and the load signal arrives piggybacked on responses the isolate was
// already receiving (no probes, no timers, no extra RPCs).
//
// Isolates only call their own colo's engine, so this module-global state IS
// per-colo state. Each isolate converges independently; disagreement is
// harmless (an early expander just warms a shard the others adopt moments
// later, and a cold shard relays to the regional DO while adopting, so
// opening one never makes a user wait).
//
// Expansion: sustained queue depth — several responses within a short window
// reporting that >=2 searches were already executing when the request
// arrived — steps the fan-out up by one, with a cooldown so a single blip
// cannot ladder. Contraction: a long fully-idle stretch steps it back down;
// the abandoned shard then evicts on its own (scale-in IS eviction).

// Two expansion signals, because each is blind where the other sees:
//
// 1. QUEUE DEPTH (reportEngineLoad): the DO's in-flight count at arrival.
//    Blind on the warm path — a warm search is synchronous CPU whose only
//    await resolves in a microtask, and microtasks drain before the event
//    loop delivers a queued RPC, so waiting requests pile up OUTSIDE the
//    counter's view. It mostly detects wake-time pileups.
// 2. LATENCY TREND (reportEngineLatency): the isolate's own wall time per
//    RPC, compared against a slow "healthy floor" EWMA. Event-loop queuing
//    inside the DO is invisible to counters but shows up here as sustained
//    wall-time inflation — this is the signal that fires under real
//    warm-path overload. Wake/relay-carrying samples are excluded by the
//    caller so revivals don't fake an overload.

/** A response reporting this many already-executing searches counts as queuing. */
const EXPAND_DEPTH = 2;
/** Queued samples within EXPAND_WINDOW_MS needed to step up. */
const EXPAND_SAMPLES = 3;
const EXPAND_WINDOW_MS = 15_000;
const EXPAND_COOLDOWN_MS = 30_000;
/** No sample with any queue depth for this long steps the fan-out down. */
const CONTRACT_IDLE_MS = 10 * 60_000;
const CONTRACT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_SHARDS = 8;

/** Sustained RPC wall time above max(MULT × floor, ABS) reads as queuing. */
const LATENCY_FLOOR_MULT = 3;
const LATENCY_ABS_MS = 75;
/** Consecutive breaching reports needed to step up (EWMA already smooths). */
const LATENCY_BREACHES_TO_EXPAND = 5;
/** Don't judge latency until the floor has seen this many samples. */
const LATENCY_MIN_SAMPLES = 20;

let activeShards = 1;
let configuredMax = DEFAULT_MAX_SHARDS;
/** Timestamps of recent samples at or above EXPAND_DEPTH. */
let queuedAt: number[] = [];
let lastBusyAt = 0;
let lastExpandAt = 0;
let lastContractAt = 0;
/** Healthy-cost floor: drops fast, rises barely (overload must not lift it). */
let floorEwma = 0;
/** Recent cost: ≈ the last handful of RPCs. */
let fastEwma = 0;
let latencySamples = 0;
let latencyBreaches = 0;
/** A just-opened shard awaiting its decision-time warm ping (see takeWarmTarget). */
let pendingWarmShard: number | null = null;

/** Feed one response's reported queue depth back into the controller. */
export function reportEngineLoad(depth: number): void {
	const now = Date.now();
	if (depth >= 1) lastBusyAt = now;
	if (depth < EXPAND_DEPTH) return;
	queuedAt.push(now);
	queuedAt = queuedAt.filter((t) => now - t <= EXPAND_WINDOW_MS);
	if (queuedAt.length >= EXPAND_SAMPLES && now - lastExpandAt >= EXPAND_COOLDOWN_MS && activeShards < configuredMax) {
		activeShards += 1;
		lastExpandAt = now;
		queuedAt = [];
		pendingWarmShard = activeShards - 1;
		console.log(`Shard controller: expanded to ${activeShards} shards (sustained queue depth)`);
	}
}

/**
 * Feed one warm RPC's isolate-measured wall time into the latency-trend
 * signal. Callers must NOT report wake- or relay-carrying RPCs (their wall
 * time is legitimately inflated). Pure arithmetic — nothing here touches the
 * request path.
 */
export function reportEngineLatency(rpcMs: number): void {
	latencySamples += 1;
	if (floorEwma === 0) {
		floorEwma = rpcMs;
	} else if (rpcMs < floorEwma) {
		floorEwma = floorEwma * 0.7 + rpcMs * 0.3;
	} else {
		floorEwma = floorEwma * 0.999 + rpcMs * 0.001;
	}
	fastEwma = fastEwma === 0 ? rpcMs : fastEwma * 0.8 + rpcMs * 0.2;

	const bar = Math.max(LATENCY_FLOOR_MULT * floorEwma, LATENCY_ABS_MS);
	if (latencySamples < LATENCY_MIN_SAMPLES || fastEwma <= bar) {
		latencyBreaches = 0;
		return;
	}
	const now = Date.now();
	// An elevated colo is BUSY: hold the idle-contraction off so a spike
	// can't get its shards folded mid-overload by the depth signal's silence.
	lastBusyAt = now;
	latencyBreaches += 1;
	if (
		latencyBreaches >= LATENCY_BREACHES_TO_EXPAND &&
		now - lastExpandAt >= EXPAND_COOLDOWN_MS &&
		activeShards < configuredMax
	) {
		activeShards += 1;
		lastExpandAt = now;
		latencyBreaches = 0;
		pendingWarmShard = activeShards - 1;
		console.log(
			`Shard controller: expanded to ${activeShards} shards (rpc ${fastEwma.toFixed(0)}ms vs floor ${floorEwma.toFixed(0)}ms)`,
		);
	}
}

/**
 * The just-opened shard index, handed out exactly once: the caller fires a
 * fire-and-forget warm ping so the shard's wake starts at DECISION time, not
 * at its first real request — and since a cold shard relays the ping, the
 * regional fallback gets touched (and woken, if evicted) in the same motion.
 * Routing never waits on this: the relay serves the shard's early traffic
 * regardless, so surge relief still begins on the next request.
 */
export function takeWarmTarget(): number | null {
	const target = pendingWarmShard;
	pendingWarmShard = null;
	return target;
}

/**
 * Pick the shard index for one request: 0 is the colo's plain-named DO, so a
 * single-shard steady state is byte-identical to unsharded routing. Also the
 * lazy home of contraction — isolates have no timers, so the check rides the
 * pick path (two timestamp compares).
 */
export function pickShard(maxShards?: number): number {
	if (maxShards && maxShards > 0) configuredMax = maxShards;
	const now = Date.now();
	if (
		activeShards > 1 &&
		lastBusyAt !== 0 &&
		now - lastBusyAt >= CONTRACT_IDLE_MS &&
		now - lastContractAt >= CONTRACT_COOLDOWN_MS
	) {
		activeShards -= 1;
		lastContractAt = now;
		console.log(`Shard controller: contracted to ${activeShards} shards (idle)`);
	}
	if (activeShards > configuredMax) activeShards = configuredMax;
	return activeShards === 1 ? 0 : Math.floor(Math.random() * activeShards);
}
