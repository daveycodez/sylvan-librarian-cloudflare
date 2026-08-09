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
// THAT LAST CLAIM IS TOO GENEROUS, AND A PRODUCTION RAMP MEASURED HOW MUCH.
// Disagreement is harmless to CORRECTNESS but not to BALANCE. Because
// activeShards is per-isolate and every new isolate starts at 1, an isolate
// that has not expanded sends 100% of its traffic to shard 0. Ramping
// sylvan.mtgseeker.com to 64 concurrent on 2026-08-09, with four shards open,
// the split held at roughly 73/17/10/5 across every stage — never converging,
// because fresh isolates keep arriving at 1. Solving f + (1-f)/4 = 0.73 puts
// about 64% of isolates on the unexpanded path throughout.
//
// So the fan-out relieved ~27% of the load, not the ~75% four shards implies,
// and shard 0 stayed the slowest of them (p50 130-154ms against 80-125ms for
// the rest) precisely because it kept the majority share. The mechanism fires
// correctly; the ROUTING does not follow it.
//
// FIXED by giving them a rendezvous. Every search RPC now carries this
// isolate's width out (currentShardWidth) and brings the colo's back in
// (adoptShardWidth): the DO remembers the widest value any caller has reported
// and returns it, so an isolate that never expands on its own still learns the
// fan-out on its very next request. Shard 0 works as the meeting point for
// free, because the isolates that need convincing are exactly the ones sending
// all their traffic there.
//
// Adoption RAISES ONLY, and the DO's announcement decays (WIDTH_TTL_MS) rather
// than ratcheting. Those two together are what keep scale-in alive: if adoption
// could lower the width it would fight each isolate's own idle clock, and if
// the announcement never decayed, a contracting isolate would re-adopt the
// stale higher value on its next RPC and never get smaller.
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
//
// AND THE SIGNAL IS DELIBERATELY NARROW: it sees the DO round trip and nothing
// else. A local ramp at 32 concurrent measured 65ms end-to-end while the DO
// round trip underneath was ~4.5ms, because the saturation was isolate-side,
// not in the DO. The controller stayed quiet through that, which is correct —
// fanning out more DOs cannot help a bottleneck that is not in a DO. Do not
// "fix" this by feeding end-to-end latency in; that would make every isolate
// slowdown, cold start and cache miss look like a reason to open shards.

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
 * WHICH TERM BINDS DEPENDS ON THE REGIME, and both are fine:
 *
 *   - Sparse (~0.1 req/s, production): floorEwma ratchets to the fast tail and
 *     settles near 7-8ms, so MULT gives a ~24ms bar and the ratio rule binds.
 *   - Loaded (~430 req/s, measured locally via scripts/load-test.ts): the floor
 *     collapses to 0-1ms, MULT gives ~3ms, and ABS binds at 10.
 *
 * So ABS is not inert after all — it is what governs precisely when the system
 * is busy, which is when it matters. Keep it at 10. Lowering it toward 4 would
 * make expansion fire earlier under load, which is a real (if modest) argument,
 * but it costs the single-outlier rejection described below, and the loaded
 * measurement shows fastEwma sitting at 4.5-5.3ms against the 10ms bar — a
 * comfortable margin rather than a system straining to trigger.
 *
 * The 10x spread the sparse samples showed was an ARTIFACT of that regime, not
 * intrinsic variance: every one of those 12 was the first (and only) RPC its
 * isolate ever made, so each carried a first-call cost that amortizes away.
 * Under sustained load min and avg track each other closely (min 0-2ms against
 * avg 0.9-5.3ms over ~850-sample windows). An earlier version of this comment
 * predicted the spread would breach the bar permanently and expand a busy colo
 * to SHARDS_MAX on variance alone. It does not happen; that concern is retired,
 * and LATENCY_FLOOR_MULT should NOT be raised.
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

/** This isolate's current fan-out width, reported on every search RPC. */
export function currentShardWidth(): number {
	return activeShards;
}

/**
 * Adopt a width some other isolate has already reached.
 *
 * The rendezvous half of the fix for the convergence defect in the header:
 * activeShards is per-isolate and a new isolate starts at 1, so without this an
 * isolate that never expands on its own keeps sending everything to shard 0. A
 * production ramp measured the result — four shards open, traffic stuck at
 * ~73/17/10/5, never converging.
 *
 * Raise only. Lowering here would fight contraction, which is a decision each
 * isolate makes from its own idle clock; the DO's announcement decays instead
 * (WIDTH_TTL_MS), so a width nobody still reports ages out at the source. The
 * cap still applies: adopting must not be a way around SHARDS_MAX.
 */
export function adoptShardWidth(width: number): void {
	if (!Number.isFinite(width) || width <= activeShards) return;
	const capped = configuredMax === 0 ? Math.floor(width) : Math.min(Math.floor(width), configuredMax);
	if (capped <= activeShards) return;
	activeShards = capped;
	console.log(`Shard controller: adopted ${activeShards} shards announced by the colo's DO`);
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
