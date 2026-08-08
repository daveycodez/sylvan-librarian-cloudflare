// Plan-aware default for the per-colo shard cap — the same zero-config plan
// detection the cards sync uses, applied to sharding: the ImportCoordinator
// records what the platform's own behavior revealed (D1's daily-limit error
// = free plan; a run that wrote past the free quota without one = paid) in a
// one-row plan_meta table, and isolates read it here.
//
//   free    → cap 1: sharding disabled. Every warm shard pins a ~70MB store
//             copy against the free plan's 5GB Durable Object storage and
//             ~13k GB-s/day duration allowances — one engine DO per colo is
//             what those meters comfortably carry.
//   paid    → cap 8 (the autoscaler still starts at 1 and only expands under
//             sustained measured load).
//   unknown → cap 2: the conservative middle until the first import run has
//             produced evidence, typically within a day of first deploy.
//
// SHARDS_MAX overrides all of this (resolveEngine checks it first).
//
// Zero request-path overhead: the cap is a cached module global; refreshes
// ride ctx.waitUntil at most once per PLAN_RECHECK_MS.

import type { Env } from "./types";

const PLAN_RECHECK_MS = 5 * 60 * 1000;
const CAP_FREE = 1;
const CAP_PAID = 8;
const CAP_UNKNOWN = 2;

let cachedCap = CAP_UNKNOWN;
let lastCheck = 0;
let checking = false;

/** The shard cap for an observed plan value (null/unknown → conservative). */
export function capForPlan(plan: string | null | undefined): number {
	if (plan === "free") return CAP_FREE;
	if (plan === "paid") return CAP_PAID;
	return CAP_UNKNOWN;
}

/** Current plan-derived shard cap; schedules a background refresh when stale. */
export function planShardCap(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): number {
	const now = Date.now();
	if (!checking && now - lastCheck >= PLAN_RECHECK_MS) {
		checking = true;
		lastCheck = now;
		ctx.waitUntil(
			refresh(env).finally(() => {
				checking = false;
			}),
		);
	}
	return cachedCap;
}

async function refresh(env: Env): Promise<void> {
	try {
		const row = await env.STORE_DB.prepare("SELECT plan FROM plan_meta WHERE id = 1").first<{ plan: string }>();
		cachedCap = capForPlan(row?.plan);
	} catch {
		// Table not created yet (no import has produced evidence) — unknown.
		cachedCap = CAP_UNKNOWN;
	}
}
