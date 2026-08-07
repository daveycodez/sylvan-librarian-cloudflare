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

let activeShards = 1;
let configuredMax = DEFAULT_MAX_SHARDS;
/** Timestamps of recent samples at or above EXPAND_DEPTH. */
let queuedAt: number[] = [];
let lastBusyAt = 0;
let lastExpandAt = 0;
let lastContractAt = 0;

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
		console.log(`Shard controller: expanded to ${activeShards} shards (sustained queue depth)`);
	}
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
