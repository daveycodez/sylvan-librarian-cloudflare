// The ONLY place a SearchEngine Durable Object stub is ever constructed.
//
// Two one-line calls do not normally earn a module. These do, because the thing
// they control is invisible, permanent, and reported by nothing:
//
//   `locationHint` applies at CREATION and never again.
//
// Whoever first addresses a given object name fixes that object's physical
// region for the rest of its life. Address `engine-apac` once from a Durable
// Object running in North America and every apac request afterwards crosses the
// Pacific twice to reach it — for as long as the name exists, with no error, no
// metric and no log line anywhere that says so. There is no API that reports an
// object's location and no way to move one; the only remedy is to abandon the
// name (see ENGINE-PLACEMENT.md).
//
// So creation is confined to ONE function, which is safe to call only from an
// isolate serving a real user — that isolate is already in the user's region, so
// the hint it supplies is the region the traffic actually comes from. Every
// other caller uses `addressAnnouncedEngine`, which passes no hint at all and so
// cannot place anything even by accident.
//
// The name and the hint are not two arguments that a future edit could let
// drift apart: `placeEngineStub` takes the REGION and derives the name from it,
// so `engine-apac` placed in `wnam` is not a bug this code can express.
// tests/engine/engine-placement.test.ts fails if any other module in src/
// constructs an engine stub or mentions `locationHint`.

import type { Env } from "./types";

/** The stub type, taken from the binding so this module needs no import of the
 * Durable Object class itself. */
export type EngineStub = ReturnType<Env["SEARCH_ENGINE"]["get"]>;

/**
 * The routing key: one object per region, plus `-1`, `-2`, … when a region fans
 * out. Shard 0 keeps the plain name, so single-shard steady state is
 * byte-identical to unsharded routing.
 *
 * This function IS the naming scheme. Changing it abandons every existing object
 * — which is the documented remediation for a misplaced one, and a thing to do
 * deliberately rather than by accident.
 */
export function engineName(region: DurableObjectLocationHint, shard: number): string {
	return shard === 0 ? `engine-${region}` : `engine-${region}-${shard}`;
}

/** The region an engine object's name claims: `engine-wnam-2` → `wnam`. Null
 * for anything that is not an engine name. */
export function regionOfEngineName(name: string): string | null {
	const match = /^engine-([a-z]+)(?:-\d+)?$/.exec(name);
	return match?.[1] ?? null;
}

/**
 * Create-or-get the engine object for `region`, PLACING it there if this is the
 * first time anyone has addressed the name.
 *
 * Call this only from a Worker isolate handling a real request, and only with
 * the region that request maps to. The isolate is in the user's region, so the
 * object is created next to the traffic it will serve. Calling it from anywhere
 * else — a Durable Object, an alarm, a cron — places the object relative to the
 * caller instead, permanently.
 */
export function placeEngineStub(env: Env, region: DurableObjectLocationHint, shard: number): EngineStub {
	const name = engineName(region, shard);
	// The hint only applies at creation, so passing it on every get() is free and
	// makes placement explicit rather than "wherever the first caller happened to
	// be".
	return env.SEARCH_ENGINE.get(env.SEARCH_ENGINE.idFromName(name), { locationHint: region });
}

/**
 * Address an object that has ALREADY announced itself (see REGION_LIVE_PREFIX),
 * without any power to place one.
 *
 * The publisher's fan-out uses this. Omitting the hint is not a cosmetic
 * difference: on a name that already exists a hint would be ignored anyway, and
 * on a name that does not, it is the difference between wasted work and a
 * permanently misplaced object.
 */
export function addressAnnouncedEngine(env: Env, name: string): EngineStub {
	return env.SEARCH_ENGINE.get(env.SEARCH_ENGINE.idFromName(name));
}
