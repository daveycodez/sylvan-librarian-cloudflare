// Per-isolate shard autoscaler for the regional engine DOs.
//
// Zero request-path overhead by design: picking a shard is a couple of
// integer compares and one Math.random() — identical work at 1 shard and at
// 10 — and the load signal arrives piggybacked on responses the isolate was
// already receiving (no probes, no timers, no extra RPCs).
//
// STATE IS KEYED BY REGION, and that is not cosmetic. This module's state used
// to be module-global on the argument that "isolates only call their own colo's
// engine, so this IS per-colo state". That argument does not survive the move to
// regional DOs: `regionHint` splits NA and EU by LONGITUDE, so a single isolate
// in a colo near -100° serves users on both sides of it and addresses both
// `enam` and `wnam`. Sharing one `targetShards`/`floorEwma`/`engineRate` across
// two regions would let a busy region open shards in a quiet one and let a quiet
// one contract a busy one. Hence the Map.
//
// Each isolate converges independently per region; disagreement is harmless.
//
// THAT LAST CLAIM WAS ONCE TOO GENEROUS, AND A PRODUCTION RAMP MEASURED HOW
// MUCH. Disagreement is harmless to CORRECTNESS but not to BALANCE. Because the
// width is per-isolate and every new isolate starts at 1, an isolate that has not
// expanded sends 100% of its traffic to shard 0. Ramping sylvan.mtgseeker.com to
// 64 concurrent on 2026-08-09, with four shards open, the split held at roughly
// 73/17/10/5 across every stage — never converging, because fresh isolates keep
// arriving at 1. Solving f + (1-f)/4 = 0.73 puts about 64% of isolates on the
// unexpanded path throughout.
//
// So the fan-out relieved ~27% of the load, not the ~75% four shards implies,
// and shard 0 stayed the slowest of them (p50 130-154ms against 80-125ms for
// the rest) precisely because it kept the majority share. The mechanism fires
// correctly; the ROUTING does not follow it.
//
// FIXED by giving them a rendezvous. Every search RPC carries this isolate's
// width out (currentShardWidth) and brings the region's back in
// (adoptShardWidth): the DO remembers the widest value any caller has reported
// and returns it, so an isolate that never expands on its own still learns the
// fan-out on its very next request. Shard 0 works as the meeting point for free,
// because the isolates that need convincing are exactly the ones sending all
// their traffic there. Regional DOs make this strictly better than it was under
// per-colo naming: every isolate in a region now meets at the same object
// instead of at one object per colo.
//
// Adoption RAISES ONLY, and the DO's announcement decays (WIDTH_TTL_MS) rather
// than ratcheting. Those two together are what keep scale-in alive: if adoption
// could lower the width it would fight each isolate's own idle clock, and if
// the announcement never decayed, a contracting isolate would re-adopt the
// stale higher value on its next RPC and never get smaller.
//
// VERIFIED against production, same ramp before and after, at 64 concurrent:
//
//   before   4 shards   68.4 / 17.3 /  9.3 /  4.9 %      imbalance 2.74x
//   after    5 shards   20.5 / 20.0 / 20.0 / 19.9 / 19.6  imbalance 1.02x
//
// and the hot shard's latency penalty went with its share: shard 0 was p50
// 154ms against 86-125ms for the others, and is now 117ms against 116-122ms —
// every shard alike. Whole-run p50 at that stage fell 142ms -> 118ms.
//
// ELASTIC IN BOTH DIRECTIONS. Expansion: a shard reporting 80% of its measured
// ceiling (EXPAND_RATE), or sustained queue depth — several responses within a
// short window reporting that >=2 searches were already executing when the
// request arrived — steps the fan-out up by one, with a cooldown so a single
// blip cannot ladder. Contraction: a long stretch without evidence of saturation
// steps it back down; the abandoned shard then evicts on its own (scale-in IS
// eviction), and the nightly publish fan-out reclaims its cached archive storage
// (see store-cache.ts).
//
// A NEW SHARD TAKES NO TRAFFIC UNTIL IT IS WARM — see readyShards below. That is
// what makes expanding cheap enough to do promptly: the cost of being wrong is a
// wasted store load in the background, never a user waiting on one.

// THIS USED TO SAY expansion needs evidence of LOAD and evidence of SLOWNESS,
// together — that latency alone has many causes sharding cannot fix, so a rate
// gate stands in front of it, and that real saturation always produces both.
// The second half of that was right and the first half was backwards, which the
// 2026-08-13 ceiling ramp settled (see DO_CEILING_RATE):
//
//   LOAD ALONE IS SUFFICIENT, and is now the primary trigger. A single-threaded
//   DO at 80% of its measured ceiling needs relief whether or not anything has
//   looked slow yet — waiting for slowness means waiting until users feel it.
//
//   SLOWNESS ALONE IS NOT, and could never have been. Of the ~124ms a client
//   waits, the DO contributes ~2.9ms; the rest is transport. At p = 80% the
//   queueing to detect is ~3ms inside a signal that idles at 7-77ms, so the
//   latency rule could only ever fire near p = 100%. Left in front, it fired at
//   19-35% utilization on noise instead — early AND for the wrong reason.
//
// So the ordering inverted: rate expands, and latency is a backstop behind its
// own gate (LATENCY_MIN_RATE) for the case rate cannot see — a shard slow at
// half its ceiling because something outside it is degraded.
//
// The two load-side signals, and what each is actually good for:
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
//    warm-path overload. WAKE-carrying samples are excluded by the caller so
//    revivals don't fake an overload (remote-engine.ts drops any sample whose
//    response reported an `acquireMs`).
//
// The old third exclusion — relay-carrying samples — is gone with the relay
// tier itself. There is no longer a second DO whose depth, rate and wall time
// could be mistaken for this shard's; every sample now describes the object
// being scaled.
//
// A CONSEQUENCE WORTH KNOWING BEFORE DEBUGGING THIS: at sparse traffic the
// controller receives little, and that is correct rather than broken. It wakes
// up only once traffic is dense enough to keep a DO warm between requests, which
// is also the only regime where sharding buys anything. Anything measuring this
// needs sustained traffic against a WARM DO; a burst at a cold one measures the
// wake path and tells you nothing about the fan-out.
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
 * THE NUMBER SURVIVES THE MOVE TO REGIONAL DOs UNCHANGED, because it always
 * measured the same thing: searches per second arriving at the DO being scaled.
 * That DO is now a region's rather than a colo's, so the gate is reached at
 * lower global traffic — which is correct, since the object really is handling
 * that rate. Only the prose needed fixing, not the constant.
 *
 * LOWERED FROM 50 BY THE CEILING MEASUREMENT — see DO_CEILING_RATE. 50 was
 * chosen as a permissive floor against an assumed ceiling in the hundreds; the
 * heaviest real route saturates at 66/s, which made this "sanity floor" 76% of
 * capacity. A gate that high does not reject noise, it rejects the evidence: a
 * genuine pileup at 30/s — already 45% utilization on /cards/search — was being
 * discarded for having "no load behind it".
 *
 * 10 keeps the ORIGINAL intent under the corrected ceiling. It was ~17% of the
 * capacity assumed at the time, and 10/66 is ~15% of the capacity now measured.
 *
 * The gate is still harder to reach than raw traffic suggests: /search sits
 * behind a 90s edge cache with a day of stale-while-revalidate, and hits never
 * reach the Worker at all. 10/s here means 10 cache-MISSING searches per second
 * at one region's DO. Being permissive is the right failure direction for a gate
 * whose only job is rejecting a signal with no load behind it. */
const EXPAND_MIN_RATE = 10;

/**
 * The single-DO ceiling, in searches per second. MEASURED, finally.
 *
 * scripts/load-test.ts phase 1 against sylvan.mtgseeker.com on 2026-08-13, with
 * SHARDS_MAX=1 so the fan-out could not rescue a saturated DO — the experiment
 * the load-test header describes and nothing had ever run:
 *
 *   conc     1     4     8    16    32    48    64    96
 *   rps    7.4  33.3  65.4 117.9 217.0 255.7 339.3 334.6
 *   p50    134   123   121   131   131   151   171   247 ms
 *
 * Throughput stops at ~340/s and goes BACKWARDS while p50 climbs. That is the
 * knee. The same client sustained 1862/s against 8 shards fifteen minutes
 * earlier, so 340 is the DO, not the load generator.
 *
 * AND 340 IS THE WRONG NUMBER TO SCALE BY, which the same afternoon established
 * the hard way. The ceiling is a property of the PAYLOAD, not of the engine, and
 * /search with rows is the lightest thing this Worker serves:
 *
 *   route / shape        ceiling   occupancy   mean CPU   bytes
 *   /search rows           340/s      2.94ms     1.35ms   42.9KB
 *   /search columnar      >=286/s    <=3.50ms    2.15ms   30.8KB   (never plateaued)
 *   /cards/search           66/s     15.15ms    11.66ms  652.7KB
 *
 * /cards/search is 5.2x the occupancy, it goes through searchRpc exactly like
 * /search, and it is the traffic this deployment actually serves. A bar set at
 * 80% of 340 sits FOUR TIMES ABOVE that route's entire ceiling: the DO would
 * saturate completely and the trigger would never fire. Calibrating on the
 * lightest route was the mistake, and it shipped before this table existed.
 *
 * SO THE CONSTANT IS THE HEAVIEST MEASURED ROUTE, not the average and not the
 * lightest. The two errors are not symmetric — expanding early costs one
 * background store load against a shard that ready-gating keeps out of the way,
 * while expanding late costs every user in the region their latency. Nor is 66
 * a true floor: it is one query mix, and a broader /cards/search result would
 * land lower still.
 *
 * WHAT THE CEILING IS NOT: 1000/CPU. Mean CPU on the rows run was 1.35ms and
 * FLAT across the whole ramp, leaving ~1.5ms of occupancy that never appears in
 * cpuTimeMs. The first guess was that this was byte-driven serialization, and
 * the three-route table REFUTES it: the residue is near-constant (1.59ms at
 * 42.9KB, 3.49ms at 652.7KB — ~3us/KB of slope) while CPU carries the payload
 * cost at 16.9us/KB, independently reproducing the ~15us/KB this repo had
 * already measured elsewhere. So occupancy ~= 2.1ms fixed + 16.9us/KB, and the
 * residue is fixed per-request RPC overhead rather than encoding.
 *
 * THAT MODEL IS THE ARGUMENT FOR REPLACING THIS CONSTANT ENTIRELY. A single
 * rate bar cannot tell a 42.9KB request from a 652.7KB one, so calibrating for
 * the heavy route necessarily over-expands the light one (/search now trips at
 * ~16% of its own ceiling). Thresholding ESTIMATED OCCUPANCY instead — which
 * the DO can compute from the request count and the bytes it already serialized
 * — is route- and payload-independent by construction, and the fit above is
 * what it would use. Until then this bar is deliberately conservative.
 */
const DO_CEILING_RATE = 66;

/**
 * Expand when one shard reports this rate — 80% of the ceiling.
 *
 * p = 80% is where the ratio rule was always AIMING (T/C = 3 under M/D/1); it
 * just could not get there by thresholding wall time.
 *
 * This is the cause measured directly instead of inferred through a round trip.
 * A single reading suffices because SearchEngine.searchRate is already a
 * 10-second trailing average, not an instantaneous count; EXPAND_COOLDOWN_MS
 * does the pacing from there.
 *
 * READ 80% AS APPLYING TO /cards/search ONLY. Against the heaviest measured
 * route this is the intended p = 0.8; against /search rows the same bar is ~16%
 * utilization, which is EARLIER than the 19-35% the old latency trigger managed.
 * That is not an accident to be tuned away — one rate bar cannot separate a
 * 42.9KB response from a 652.7KB one, so serving the heavy route correctly means
 * over-serving the light one. What changes even there is the KIND of signal:
 * expansion is now caused by measured load, so it stops when load stops, instead
 * of by latency spread that breaches continuously and ladders to the cap
 * regardless. Fixing the light route as well needs the occupancy signal
 * described on DO_CEILING_RATE, not a different multiplier here.
 */
const EXPAND_RATE = Math.round(DO_CEILING_RATE * 0.8);

/**
 * Rate below which a latency breach cannot open a shard, now that latency is a
 * BACKSTOP rather than the primary trigger.
 *
 * Half the ceiling. The band this leaves — 33/s up to EXPAND_RATE — is the case
 * latency still earns its place in: a shard slow at 40/s when it should manage
 * 66/s is degraded by something the rate signal cannot see (a noisy neighbour,
 * a colo problem). Below half the ceiling, elevated latency is not a shortage
 * of shards and never was.
 *
 * This gate is now BELOW the old EXPAND_MIN_RATE of 50 rather than above it, and
 * that is the correction the /cards/search measurement forced: at 66/s the
 * heaviest route is fully saturated, so a gate set above it silences the backstop
 * exactly where it is most needed. The first version of this constant was half
 * of the WRONG ceiling and did precisely that.
 */
const LATENCY_MIN_RATE = Math.round(DO_CEILING_RATE * 0.5);

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
 * hold contraction off. A busy-but-COPING region therefore does contract, one
 * step per CONTRACT_COOLDOWN_MS, until latency reaches the bar again — it
 * walks toward the smallest fan-out that keeps up rather than holding whatever
 * peak it once hit.
 *
 * These two timers stay, and they are not the kind the publish path deleted.
 * Those were standing in for state that could not be observed (had a reader
 * converged yet?) and were replaced by an event. "Quiet for long enough to be
 * sure" has no event to wait on; it is a real control-loop parameter. */
const CONTRACT_IDLE_MS = 10 * 60_000;
const CONTRACT_COOLDOWN_MS = 60_000;
/** Cap on the fan-out. Not a scaling limit so much as a blast radius: the
 * signals that drive expansion can be wrong, and an unbounded response to a
 * wrong signal opens shards that each cold-load ~76MB and hold it resident.
 * SHARDS_MAX=0 opts into genuinely unbounded scaling.
 *
 * Lowered from 32 on 2026-08-09, because this cap turned out to be doing real
 * work rather than sitting unreachable:
 *
 *   - The production ramp laddered 1 -> 2 -> 5 in about 40 seconds of load.
 *     That is faster than one step per EXPAND_COOLDOWN_MS, because the
 *     rendezvous propagates the widest isolate's width to every other isolate
 *     at once — so the region advances at the pace of its FASTEST expander, not
 *     its average one. Balance and ladder speed came from the same change.
 *   - And the latency trigger breaches almost continuously under production
 *     load: floorEwma latches the fast tail (5-7ms) while fastEwma tracks
 *     current conditions (40-100ms), so the ratio sits far above MULT whenever
 *     there is traffic. Expansion is therefore paced by cooldown and this cap,
 *     not by evidence of saturation.
 *
 * ONE OF THE THREE ORIGINAL REASONS IS NOW GONE. It used to say "a cold shard
 * costs a user ~1.5-2s against ~120ms warm, so past the point of relieving load,
 * more shards make latency WORSE". Ready-gating (readyShards, below) means a
 * cold shard is never routed to, so opening one can no longer cost a user
 * anything — the failure mode that argument described does not exist any more.
 *
 * What survives is thinner but still real: splitting a region's traffic N ways
 * makes each shard likelier to fall idle and evict, and each re-warm is another
 * KV load and another cached archive against the 5GB pool. That is an argument
 * for a bound, not for THIS bound, and 8 is now conservative rather than tuned.
 *
 * THE CEILING HAS NOW BEEN MEASURED (DO_CEILING_RATE), so the arithmetic this
 * comment was waiting on: 8 shards is ~528 cache-MISSING /cards/search per
 * second in one region, or ~2720 of the much lighter /search. Production sits
 * nearer 0.1/s, so 8 stays — not for want of a measurement any more, but because
 * the measurement says it is ample for the traffic that exists. Note the honest
 * version of that headroom is the SMALL number: the cap should be read against
 * the heaviest route, not the one that flatters it. Raise it with SHARDS_MAX
 * where a region genuinely needs more. */
export const DEFAULT_MAX_SHARDS = 8;

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
 * THE OPEN PROBLEM, and a correction. A previous version of this comment
 * retired the worry that variance alone would breach the bar permanently,
 * on the grounds that within a 2s window min and avg track closely (min 0-2ms
 * against avg 0.9-5.3ms locally, 1.2-2.2x in production). That comparison was
 * against the wrong quantity. floorEwma is not the within-window minimum: it
 * falls fast (0.7/0.3 on any sample below it) and rises at 0.001, so it latches
 * onto the fast tail across ALL windows and stays there. In production that
 * pins it at 5-7ms while fastEwma tracks current conditions at 40-100ms — a
 * ratio far above MULT whenever there is any traffic at all.
 *
 * So the latency trigger does not currently measure queueing. It measures "is
 * now worse than the best moment ever seen", which under real network variance
 * is almost always true once loaded. Expansion is in practice paced by
 * EXPAND_COOLDOWN_MS and DEFAULT_MAX_SHARDS rather than by evidence of
 * saturation — the production ramp laddered 1 -> 2 -> 5 in about 40s while the
 * busiest shard sat at roughly a fifth of its capacity.
 *
 * That over-eagerness is far less costly than it was, because ready-gating means
 * an unnecessary shard costs a background store load rather than a slow request.
 * It is still worth fixing, because idle shards evict and re-warm.
 *
 * AND THE FIX THIS COMMENT USED TO PROPOSE WOULD NOT HAVE WORKED. It said the
 * answer was making floorEwma a healthy RECENT baseline instead of an all-time
 * minimum — soften the 0.3 downward weight, let it rise faster than 0.001 — and
 * that both numbers needed a measurement to choose. The measurement now exists
 * (DO_CEILING_RATE) and it retires the whole approach rather than settling the
 * weights:
 *
 *   At p = 80%, M/D/1 puts queueing at about 2x service time. Service time here
 *   is ~2.9ms of DO occupancy, so the signal to detect is ~3ms — inside an RPC
 *   wall time that idles at 7-77ms and is 95-98% transport. No baseline, however
 *   well chosen, recovers a 3ms signal from that. Saturation only becomes
 *   visible in wall time at p ~ 100%, where the ramp saw DO wall reach ~150ms
 *   while CPU stayed at 1-4ms.
 *
 * So latency can only ever fire LATE, which is the opposite of what expanding at
 * 80% is for. Raising MULT was already rejected as too blunt; softening the
 * floor is rejected now for a better reason — it is thresholding the wrong
 * quantity. The rate signal (reportEngineRate) measures the constraint directly
 * and is the primary trigger; what survives here is a backstop, gated at
 * LATENCY_MIN_RATE so it cannot fire in the regime that produced the 19-35%
 * expansions.
 *   - Below ~9ms the bar stops rejecting single outliers. One 100ms sample
 *     drives fastEwma to 20.8 against a 1ms floor, and the 0.2 weight decays it
 *     back under 9 only on the fifth sample after — so any lower bar turns one
 *     GC pause into an expansion. At 10 the count is exactly 4 of the 5
 *     required (tests/engine/shard-controller.test.ts pins this). No EWMA
 *     weight fixes that; a rank filter over the last N samples would, and that
 *     is a redesign, not a constant. */
const LATENCY_FLOOR_MULT = 3;
const LATENCY_ABS_MS = 10;
/** Consecutive breaching reports needed to step up (EWMA already smooths). */
const LATENCY_BREACHES_TO_EXPAND = 5;
/** Don't judge latency until the floor has seen this many samples. */
const LATENCY_MIN_SAMPLES = 20;

/**
 * One region's view of its own fan-out.
 *
 * `targetShards` and `readyShards` are the load-bearing distinction. The
 * controller decides to run `targetShards`; `pickShard` only ever draws from
 * `readyShards`, and a newly opened shard joins the draw only once its warm ping
 * has resolved (markShardReady). Before that it exists but receives nothing.
 *
 * This is what stops an expansion from costing a user anything. Previously the
 * width incremented and `pickShard` immediately started routing across it, so a
 * real request could land on a shard that had not loaded the ~76MB store yet and
 * block for the whole cold path. The decision-time warm ping started that load
 * but did not gate routing, and the next request could beat it there.
 *
 * `targetShards >= readyShards` always. They differ only while a shard warms, or
 * briefly after a failed warm-up before `unmarkPending` rolls the target back.
 */
interface RegionState {
	targetShards: number;
	readyShards: number;
	/** Timestamps of recent samples at or above EXPAND_DEPTH. */
	queuedAt: number[];
	lastBusyAt: number;
	lastExpandAt: number;
	lastContractAt: number;
	/** Healthy-cost floor: drops fast, rises barely (overload must not lift it). */
	floorEwma: number;
	/** Recent cost: ≈ the last handful of RPCs. */
	fastEwma: number;
	latencySamples: number;
	latencyBreaches: number;
	/** Most recent searches-per-second the DO reported. */
	engineRate: number;
	/** A just-opened shard awaiting its warm ping (see takeWarmTarget). */
	pendingWarmShard: number | null;
}

const regions = new Map<string, RegionState>();

/** SHARDS_MAX is one env var for the whole Worker, so the cap is not per-region. */
let configuredMax = DEFAULT_MAX_SHARDS;

function stateFor(region: string): RegionState {
	let state = regions.get(region);
	if (!state) {
		state = {
			targetShards: 1,
			readyShards: 1,
			queuedAt: [],
			lastBusyAt: 0,
			lastExpandAt: 0,
			lastContractAt: 0,
			floorEwma: 0,
			fastEwma: 0,
			latencySamples: 0,
			latencyBreaches: 0,
			engineRate: 0,
			pendingWarmShard: null,
		};
		regions.set(region, state);
	}
	return state;
}

function canExpand(state: RegionState): boolean {
	return configuredMax === 0 || state.targetShards < configuredMax;
}

/** Open one more shard, pending its warm-up. Shared by both expansion triggers. */
function expand(state: RegionState, region: string, now: number, why: string): void {
	state.targetShards += 1;
	state.lastExpandAt = now;
	state.queuedAt = [];
	state.pendingWarmShard = state.targetShards - 1;
	console.log(
		`[${region}] shard controller: expanding to ${state.targetShards} shards (${why}); ` +
			`shard ${state.pendingWarmShard} takes no traffic until it is warm`,
	);
}

/**
 * Feed the DO's reported request rate back into the controller, and expand on it.
 *
 * THE PRIMARY TRIGGER, as of the ceiling measurement. It thresholds the thing
 * that actually constrains a single-threaded DO — searches per second arriving
 * at it — instead of inferring saturation from a round trip that is 95-98%
 * transport. At the ceiling the DO contributes ~2.9ms to a ~124ms client-observed
 * request; a rule reading the 124ms cannot see the 2.9ms move until it is
 * queueing hard, which is exactly what production did.
 *
 * `rate` is per-OBJECT, reported by whichever shard answered, so a shard at
 * EXPAND_RATE is at 80% of ITS ceiling however wide the region already is. That
 * is the right reading: it means this shard needs relief, not that the region
 * does on average.
 */
export function reportEngineRate(region: string, rate: number): void {
	const state = stateFor(region);
	state.engineRate = rate;
	if (rate < EXPAND_RATE) return;
	const now = Date.now();
	// At 80% of its ceiling a shard is busy whether or not anything has queued yet — hold
	// contraction off on the same evidence that opens a shard.
	state.lastBusyAt = now;
	if (now - state.lastExpandAt >= EXPAND_COOLDOWN_MS && canExpand(state)) {
		expand(
			state,
			region,
			now,
			`engine rate ${rate.toFixed(0)}/s at ${EXPAND_RATE}/s bar (80% of ${DO_CEILING_RATE}/s)`,
		);
	}
}

/** Feed one response's reported queue depth back into the controller. */
export function reportEngineLoad(region: string, depth: number): void {
	const state = stateFor(region);
	const now = Date.now();
	if (depth >= 1) state.lastBusyAt = now;
	if (depth < EXPAND_DEPTH) return;
	state.queuedAt.push(now);
	state.queuedAt = state.queuedAt.filter((t) => now - t <= EXPAND_WINDOW_MS);
	if (
		state.queuedAt.length >= EXPAND_SAMPLES &&
		state.engineRate >= EXPAND_MIN_RATE &&
		now - state.lastExpandAt >= EXPAND_COOLDOWN_MS &&
		canExpand(state)
	) {
		expand(state, region, now, "sustained queue depth");
	}
}

/**
 * Feed one warm RPC's isolate-measured wall time into the latency-trend
 * signal. Callers must NOT report wake-carrying RPCs (their wall time is
 * dominated by the store load, not by queuing).
 */
export function reportEngineLatency(region: string, rpcMs: number): void {
	const state = stateFor(region);
	const now = Date.now();
	state.latencySamples += 1;
	state.floorEwma =
		state.floorEwma === 0
			? rpcMs
			: rpcMs < state.floorEwma
				? state.floorEwma * 0.7 + rpcMs * 0.3
				: state.floorEwma * 0.999 + rpcMs * 0.001;
	state.fastEwma = state.fastEwma === 0 ? rpcMs : state.fastEwma * 0.8 + rpcMs * 0.2;

	const bar = Math.max(LATENCY_FLOOR_MULT * state.floorEwma, LATENCY_ABS_MS);
	if (state.latencySamples < LATENCY_MIN_SAMPLES || state.fastEwma <= bar) {
		state.latencyBreaches = 0;
		return;
	}
	// An elevated region is BUSY: hold the idle-contraction off so a spike
	// can't get its shards folded mid-overload by the depth signal's silence.
	state.lastBusyAt = now;
	state.latencyBreaches += 1;
	if (
		state.latencyBreaches >= LATENCY_BREACHES_TO_EXPAND &&
		// Demoted to a backstop: below half the ceiling, elevated latency is not a shortage of
		// shards. This gate is what stops the 19-35%-utilization expansions the ramp measured.
		state.engineRate >= LATENCY_MIN_RATE &&
		now - state.lastExpandAt >= EXPAND_COOLDOWN_MS &&
		canExpand(state)
	) {
		state.latencyBreaches = 0;
		expand(state, region, now, `latency ${state.fastEwma.toFixed(1)}ms over a ${bar.toFixed(1)}ms bar`);
	}
}

/**
 * The shard this isolate just opened and has not yet warmed, once.
 *
 * The caller pings it immediately so its store load starts at DECISION time
 * rather than at its first real request — and, now, so that first real request
 * never happens until the ping resolves. The caller must report the outcome
 * back through markShardReady or unmarkPending; until it does, the shard exists
 * in `targetShards` and receives nothing.
 */
export function takeWarmTarget(region: string): number | null {
	const state = stateFor(region);
	const target = state.pendingWarmShard;
	state.pendingWarmShard = null;
	return target;
}

/**
 * A pending shard has finished its warm-up and may now take traffic.
 *
 * Admits every shard up to and including this one, capped at the target — the
 * warm pings for two shards opened in quick succession can resolve out of order,
 * and admitting a gap would mean `pickShard` drawing an index nobody warmed.
 */
export function markShardReady(region: string, shard: number): void {
	const state = stateFor(region);
	const admitted = Math.min(Math.max(state.readyShards, shard + 1), state.targetShards);
	if (admitted === state.readyShards) return;
	state.readyShards = admitted;
	console.log(`[${region}] shard controller: shard ${shard} is warm; now routing across ${state.readyShards}`);
}

/**
 * A pending shard's warm-up failed; give the slot back.
 *
 * Without this the target would stay permanently one above ready, which both
 * blocks the cap from ever being reached honestly and leaves `canExpand` gated
 * on a shard that is not running. Rolls back only to `readyShards`, so a shard
 * that other isolates have already warmed is not discarded.
 */
export function unmarkPending(region: string): void {
	const state = stateFor(region);
	if (state.targetShards <= state.readyShards) return;
	state.targetShards = state.readyShards;
	console.log(`[${region}] shard controller: warm-up failed; back to ${state.targetShards} shards`);
}

/**
 * The width this isolate is actually routing across, ridden out on every search
 * RPC for the rendezvous.
 *
 * Announces READY width, not target: peers adopt this number and start drawing
 * across it immediately, so announcing a shard that is still warming would push
 * exactly the cold-routing this design exists to prevent onto every other
 * isolate in the region.
 */
export function currentShardWidth(region: string): number {
	return stateFor(region).readyShards;
}

/**
 * Adopt a width some other isolate has already reached.
 *
 * The rendezvous half of the fix for the convergence defect in the header:
 * the width is per-isolate and a new isolate starts at 1, so without this an
 * isolate that never expands on its own keeps sending everything to shard 0. A
 * production ramp measured the result — four shards open, traffic stuck at
 * ~73/17/10/5, never converging.
 *
 * Raises BOTH target and ready. Readiness is a property of the shard, not of the
 * isolate: the announcing peer only ever announces shards it verified warm, so
 * there is nothing left for this isolate to wait on.
 *
 * Raise only. Lowering here would fight contraction, which is a decision each
 * isolate makes from its own idle clock; the DO's announcement decays instead
 * (WIDTH_TTL_MS), so a width nobody still reports ages out at the source. The
 * cap still applies: adopting must not be a way around SHARDS_MAX.
 */
export function adoptShardWidth(region: string, width: number): void {
	const state = stateFor(region);
	if (!Number.isFinite(width) || width <= state.readyShards) return;
	const capped = configuredMax === 0 ? Math.floor(width) : Math.min(Math.floor(width), configuredMax);
	if (capped <= state.readyShards) return;
	state.readyShards = capped;
	if (state.targetShards < capped) state.targetShards = capped;
	console.log(`[${region}] shard controller: adopted ${state.readyShards} shards announced by the region's DO`);
}

/**
 * Pick the shard index for one request: 0 is the region's plain-named DO, so a
 * single-shard steady state is byte-identical to unsharded routing. Also the
 * lazy home of contraction — isolates have no timers, so the check rides the
 * pick path (two timestamp compares).
 *
 * Draws from `readyShards`, never `targetShards`: a shard that has been opened
 * but not yet warmed is deliberately unreachable.
 */
export function pickShard(region: string, maxShards?: number): number {
	if (maxShards !== undefined && maxShards >= 0) configuredMax = maxShards;
	const state = stateFor(region);
	const now = Date.now();
	if (
		state.targetShards > 1 &&
		state.lastBusyAt !== 0 &&
		now - state.lastBusyAt >= CONTRACT_IDLE_MS &&
		now - state.lastContractAt >= CONTRACT_COOLDOWN_MS
	) {
		state.targetShards -= 1;
		// Drop it from the draw first so nothing new is routed there; in-flight
		// work finishes and the object then idles out on its own.
		if (state.readyShards > state.targetShards) state.readyShards = state.targetShards;
		state.lastContractAt = now;
		console.log(
			`[${region}] shard controller: contracted to ${state.targetShards} shards ` +
				`(no saturation for ${CONTRACT_IDLE_MS / 60_000}m — not necessarily idle)`,
		);
	}
	if (configuredMax > 0 && state.targetShards > configuredMax) state.targetShards = configuredMax;
	if (configuredMax > 0 && state.readyShards > configuredMax) state.readyShards = configuredMax;
	return state.readyShards === 1 ? 0 : Math.floor(Math.random() * state.readyShards);
}
