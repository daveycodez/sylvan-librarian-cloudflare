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

// Expansion needs evidence of LOAD and evidence of SLOWNESS, together.
//
// Latency alone is an effect with many causes — KV slowness, network jitter,
// a noisy neighbour — and none of those are fixed by adding shards. They are
// made worse by it, since every shard opened cold-loads ~70MB. So a rate
// gate stands in front of the latency trigger: high rate without slowness
// means the fan-out is coping; slowness without rate means the problem is
// somewhere sharding cannot reach. Real saturation of a single-threaded DO
// always produces both.
//
// The two load-side signals, and why neither is sufficient alone:
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
//    warm-path overload. Wake- and relay-carrying samples are excluded by the
//    caller so revivals don't fake an overload: the DO tags relays with a
//    `relayed` rider and remote-engine.ts drops those samples entirely (all
//    three signals, not just latency — a relayed result's depth and rate are
//    the REGION's, not this colo's). Relays are the case that matters most:
//    every shard this controller opens relays until it warms, so without the
//    tag each expansion would inflate the very signal that triggers the next.
//
// A CONSEQUENCE WORTH KNOWING BEFORE DEBUGGING THIS: at sparse traffic the
// controller receives nothing at all, and that is correct rather than broken.
// Production logs on 2026-08-09 showed every engine RPC arriving as a cold
// relay — 1457-1853ms wall, 382ms of it the regional DO's own store load —
// because a colo whose DO has been evicted relays while it warms, and at ~0.1
// req/s the DO is always evicted. Every one of those samples is dropped by the
// rule above, so floorEwma never receives a sample, latencySamples never
// reaches LATENCY_MIN_SAMPLES, and the latency trigger cannot fire by
// construction. The controller wakes up only once traffic is dense enough to
// keep a colo DO warm between requests, which is also the only regime where
// sharding buys anything. Anything measuring this therefore needs sustained
// traffic against a WARM colo DO; a burst at a cold one measures the relay
// path and tells you nothing about the fan-out.

/** Searches per second at the DO below which elevated latency is NOT read as
 * saturation. This sits far below the ceiling deliberately — it is a sanity
 * gate on the latency trigger, not the trigger itself.
 *
 * The ceiling probably moved with the encode-in-the-DO change (d538c1f): that
 * profile put total warm busy at 2.08ms with 1.43ms of it isolate-side, which
 * would leave ~0.65ms in the DO for a 26KB result and put a single-threaded DO
 * nearer 1500/s than the 300/s this comment used to assume. Treat that as an
 * estimate, not a measurement — it was taken locally under wrangler dev, and
 * e7ec18d is this repo's own worked example of a local harness disagreeing with
 * production outright (it predicted 35% off startup for a split that delivered
 * 0). Nothing has measured the DO's ceiling against real traffic.
 *
 * Whatever the ceiling is, this gate is harder to reach than raw traffic
 * suggests: /search sits behind a 90s edge cache with a day of
 * stale-while-revalidate, and hits never reach the Worker at all. 50/s here
 * means 50 cache-MISSING searches per second at one colo's DO. Being permissive
 * is the right failure direction for a gate whose only job is rejecting latency
 * with no load behind it. */
const EXPAND_MIN_RATE = 50;

/** A response reporting this many already-executing searches counts as queuing. */
const EXPAND_DEPTH = 2;
/** Queued samples within EXPAND_WINDOW_MS needed to step up. */
const EXPAND_SAMPLES = 3;
const EXPAND_WINDOW_MS = 15_000;
const EXPAND_COOLDOWN_MS = 30_000;
/** No evidence of saturation for this long steps the fan-out down. Note this
 * is NOT idleness, despite what a fan-out walking down looks like: lastBusyAt
 * is set by any reported queue depth OR a latency breach, and a warm DO reports
 * depth 0 almost always (see QUEUE DEPTH above), so in practice only breaches
 * hold contraction off. A busy-but-COPING colo therefore does contract, one
 * step per CONTRACT_COOLDOWN_MS, until latency reaches the bar again — it
 * walks toward the smallest fan-out that keeps up rather than holding whatever
 * peak it once hit. */
const CONTRACT_IDLE_MS = 10 * 60_000;
const CONTRACT_COOLDOWN_MS = 60_000;
/** Cap on the fan-out. Not a scaling limit so much as a blast radius: the
 * signals that drive expansion can be wrong, and an unbounded response to a
 * wrong signal opens shards that each cold-load ~70MB and hold it resident.
 * SHARDS_MAX=0 opts into genuinely unbounded scaling. */
const DEFAULT_MAX_SHARDS = 32;

/** Sustained RPC wall time above max(MULT × floor, ABS) reads as queuing.
 *
 * MULT is the real rule and it is well placed. Service here is CPU-bound and
 * near-deterministic, so M/D/1 applies: T/C = 1 + p/(2(1-p)). T/C = 3 puts
 * expansion at p = 80% utilization, which is where a single-threaded server
 * should fan out.
 *
 * ABS only exists as a noise floor. It must stay SMALL or it silently replaces
 * the rule: max() picks ABS whenever floor < ABS/MULT, and at the original 75ms
 * that meant floor < 25ms, i.e. always. The ratio rule was dead code and
 * expansion actually fired at p = 98-99.3% — past the knee, where mean queue
 * depth is already 24+ requests.
 *
 * SETTLED at 10 by measurement, after being held there on argument. The open
 * question was the transport term: this signal is RPC WALL TIME, not CPU, and
 * whether ABS or MULT binds depends on DO CPU (~0.65ms) plus isolate-to-DO
 * transport, which nothing had measured. Production warm samples on 2026-08-09
 * answered it — 7, 8, 8, 28, 29, 33, 35, 44, 49, 51, 68, 77 ms.
 *
 * floorEwma ratchets to the fast tail (0.7/0.3 down, 0.999/0.001 up), so it
 * settles near 7-8ms. MULT then gives a ~24ms bar against ABS's 10, so THE
 * RATIO RULE ALREADY BINDS and lowering ABS would change nothing. It would have
 * to fall below ~3.3ms before ABS mattered again, and that is well under
 * anything observed. Keep 10 as the floor-of-the-floor for a hypothetical
 * much faster path; do not spend effort tuning it.
 *
 *   - Caveat on the sample: 12 points at ~0.1 req/s, each from a different
 *     isolate serving exactly one request, so it is the sparse regime rather
 *     than the loaded one. Under sustained load the distribution should tighten
 *     and drop. The conclusion is robust to that — the margin is 2.4x — but the
 *     MULT concern below is not.
 *   - A REAL RISK this exposed: the spread is over 10x (7ms fast tail against a
 *     ~36ms mean). Since floorEwma tracks the tail and fastEwma tracks the mean,
 *     fastEwma would sit near 36 against a 24ms bar — a permanent breach, so a
 *     colo past the rate gate would expand continuously to SHARDS_MAX on
 *     variance alone. Whether that survives into the loaded regime is exactly
 *     what the load test has to show; if it does, MULT is what needs raising,
 *     not ABS lowering. Do not act on 12 sparse samples.
 *   - Below ~9ms the bar stops rejecting single outliers. One 100ms sample
 *     drives fastEwma to 20.8 against a 1ms floor, and the 0.2 weight decays it
 *     back under 9 only on the fifth sample after — so any lower bar turns one
 *     GC pause into an expansion. At 10 the count is exactly 4 of the 5
 *     required (tests/engine/shard-controller.test.ts pins this). No EWMA
 *     weight fixes that; a rank filter over the last N samples would, and that
 *     is a redesign, not a constant.
 *
 * So the perf work did move the target — cheaper C means a fixed absolute bar
 * corresponds to HIGHER utilization — but it did not move which term binds, and
 * guessing the transport cost would trade a property we have for one we don't.
 * remote-engine.ts now samples warm RPC wall time into the log; one load-test
 * run makes floorEwma observable and settles this. */
const LATENCY_FLOOR_MULT = 3;
const LATENCY_ABS_MS = 10;
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
/** Most recent searches-per-second the DO reported. */
let engineRate = 0;
/** A just-opened shard awaiting its decision-time warm ping (see takeWarmTarget). */
let pendingWarmShard: number | null = null;

/** Feed the DO's reported request rate back into the controller. This is the
 * cause-side half of the expansion decision — see the header. */
export function reportEngineRate(rate: number): void {
	engineRate = rate;
}

/** Feed one response's reported queue depth back into the controller. */
export function reportEngineLoad(depth: number): void {
	const now = Date.now();
	if (depth >= 1) lastBusyAt = now;
	if (depth < EXPAND_DEPTH) return;
	queuedAt.push(now);
	queuedAt = queuedAt.filter((t) => now - t <= EXPAND_WINDOW_MS);
	if (
		queuedAt.length >= EXPAND_SAMPLES &&
		engineRate >= EXPAND_MIN_RATE &&
		now - lastExpandAt >= EXPAND_COOLDOWN_MS &&
		canExpand()
	) {
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
		engineRate >= EXPAND_MIN_RATE &&
		now - lastExpandAt >= EXPAND_COOLDOWN_MS &&
		canExpand()
	) {
		activeShards += 1;
		lastExpandAt = now;
		latencyBreaches = 0;
		pendingWarmShard = activeShards - 1;
		console.log(
			`Shard controller: expanded to ${activeShards} shards ` +
				`(rpc ${fastEwma.toFixed(0)}ms vs floor ${floorEwma.toFixed(0)}ms at ${engineRate.toFixed(0)}/s)`,
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
/** Room to grow: SHARDS_MAX=0 means unbounded, so treat 0 as no ceiling. */
function canExpand(): boolean {
	return configuredMax === 0 || activeShards < configuredMax;
}

export function pickShard(maxShards?: number): number {
	if (maxShards !== undefined && maxShards >= 0) configuredMax = maxShards;
	const now = Date.now();
	if (
		activeShards > 1 &&
		lastBusyAt !== 0 &&
		now - lastBusyAt >= CONTRACT_IDLE_MS &&
		now - lastContractAt >= CONTRACT_COOLDOWN_MS
	) {
		activeShards -= 1;
		lastContractAt = now;
		console.log(
			`Shard controller: contracted to ${activeShards} shards ` +
				`(no saturation for ${CONTRACT_IDLE_MS / 60_000}m — not necessarily idle)`,
		);
	}
	if (configuredMax > 0 && activeShards > configuredMax) activeShards = configuredMax;
	return activeShards === 1 ? 0 : Math.floor(Math.random() * activeShards);
}
