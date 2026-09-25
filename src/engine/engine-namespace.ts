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

import { REGION_HINTS } from "./region";
import type { Env } from "./types";

/** The stub type, taken from the binding so this module needs no import of the
 * Durable Object class itself. */
export type EngineStub = ReturnType<Env["SEARCH_ENGINE"]["get"]>;

/**
 * The routing key: one object per region, plus `-1`, `-2`, … when a region fans
 * out. Shard 0 keeps the plain name, so single-shard steady state is
 * byte-identical to unsharded routing.
 *
 * `-g<k>` IS THE REGION'S GENERATION (backlog g1), and generation 0 omits it, so every name that
 * existed before generations did is byte-identical. A generation exists because an object's
 * placement is fixed at creation and nothing can move it: when a hint Cloudflare could not host
 * becomes hostable, its old objects sit where Cloudflare put them instead, and the only way to get
 * objects IN the region is fresh names — `engine-sam-g1-p0` — created at the edge by its own
 * traffic. The generation per hint rides the manifest (placement-policy.ts), and the nightly
 * retires every object of an older one.
 *
 * THE `-p<k>` SUFFIX IS PART OF EVERY LIVE OBJECT'S NAME (CARD-PARTITIONING §2):
 * `partition` names which SUBSET OF THE DATA the object holds, where the shard
 * number names which REPLICA it is. They multiply — `engine-wnam-2-p3` is
 * replica 2's copy of partition 3.
 *
 * Omitting `partition` yields the suffix-less REPLICA GROUP name, which is a
 * label rather than an object anyone loads a store into: it is what
 * `replicaGroupOf` returns and what the shard controller counts. A suffix-less
 * name reaching the LOADER is a bug, and archiveOfManifest says so loudly.
 *
 * This function IS the naming scheme. Changing it abandons every existing object
 * — which is the documented remediation for a misplaced one, and a thing to do
 * deliberately rather than by accident.
 */
export function engineName(
	region: DurableObjectLocationHint,
	shard: number,
	partition?: number,
	generation = 0,
): string {
	const stem = generation > 0 ? `engine-${region}-g${generation}` : `engine-${region}`;
	const base = shard === 0 ? stem : `${stem}-${shard}`;
	return partition === undefined ? base : `${base}-p${partition}`;
}

/** The region an engine object's name claims: `engine-wnam-2` → `wnam`,
 * `engine-wnam-2-p3` → `wnam`. Null for anything that is not an engine name. */
export function regionOfEngineName(name: string): string | null {
	return parseEngineName(name)?.region ?? null;
}

/**
 * An engine name, taken apart: `engine-<region>[-g<k>][-<n>][-p<k>]`.
 *
 * `partition` comes back undefined for a replica-group name (`engine-wnam-2`),
 * which is a real thing to parse — the shard controller names groups, not
 * partitions — but never a name a store is loaded into.
 * This parse is the ONE place the suffix grammar lives; the width parsing and
 * stale-shard release in the publish fan-out (import-coordinator stepNotify, and
 * its mirror in tests/engine/publish-notify.test.ts) group names through
 * `replicaGroupOf` below so `engine-wnam-2-p0 … -p7` count as ONE replica.
 */
/**
 * The name grammar, with the region alternatives generated from REGION_HINTS, LONGEST FIRST: a
 * hint may itself contain a hyphen (`apac-ne`), and `[a-z]+` read `engine-apac-ne-p3` as region
 * `apac` plus garbage — null, so the loader would have refused every apac-ne/apac-se object.
 * Longest-first makes `apac-ne` win over its prefix `apac`.
 */
const ENGINE_NAME_RE = new RegExp(
	`^engine-(${[...REGION_HINTS].sort((a, b) => b.length - a.length).join("|")})(?:-g([1-9]\\d*))?(?:-(\\d+))?(?:-p(\\d+))?$`,
);

/**
 * `generation` is present only when it is not 0 — the same convention as `partition` — so a name
 * without `-g` parses exactly as it always has.
 */
export function parseEngineName(
	name: string,
): { region: string; shard: number; partition?: number; generation?: number } | null {
	const match = ENGINE_NAME_RE.exec(name);
	if (!match?.[1]) return null;
	return {
		region: match[1],
		shard: match[3] === undefined ? 0 : Number(match[3]),
		...(match[4] === undefined ? {} : { partition: Number(match[4]) }),
		...(match[2] === undefined ? {} : { generation: Number(match[2]) }),
	};
}

/**
 * The replica this name belongs to: the name with any `-p<k>` stripped.
 *
 * `engine-wnam-2-p0` and `engine-wnam-2-p7` are ONE replica of the store — the
 * shard controller's width counts replicas, so everything that reasons about
 * fan-out width or stale-shard release must group by THIS, not by raw name.
 */
export function replicaGroupOf(name: string): string | null {
	const parsed = parseEngineName(name);
	if (!parsed) return null;
	return engineName(parsed.region as DurableObjectLocationHint, parsed.shard, undefined, parsed.generation);
}

/**
 * A sibling partition's name, derived from a label this object already carries:
 * same region, same replica shard, partition `k`. Null when the label is not an
 * engine name at all — the caller (the gather fan-out) treats that as a bug, not
 * a fallback.
 */
export function siblingEngineName(label: string, partition: number): string | null {
	const parsed = parseEngineName(label);
	if (!parsed) return null;
	return engineName(parsed.region as DurableObjectLocationHint, parsed.shard, partition, parsed.generation);
}

/**
 * Address a SIBLING partition of a label this object already carries — the
 * gather DO's fan-out (CARD-PARTITIONING §6 phase 1/2 goes through here).
 *
 * Deliberately built on `addressAnnouncedEngine`'s no-hint semantics: a gather
 * object was itself placed by a real request in its region, so a sibling first
 * created from here is created near that traffic anyway — but no hint is passed,
 * so this helper cannot PIN a region even if handed a mangled label.
 */
export function siblingStub(env: Env, label: string, partition: number): EngineStub | null {
	const name = siblingEngineName(label, partition);
	return name === null ? null : addressAnnouncedEngine(env, name);
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
 *
 * The one call for ANOTHER region is the hedge (index.ts, remote-engine.ts ENGINE_HEDGE_MS): a slow
 * call's neighbouring served region, same partition, shard 0. Still an edge isolate passing that
 * region's own hint, and those objects already exist in practice — the neighbour's own traffic made
 * them — so a hedge addresses them rather than creating them.
 */
export function placeEngineStub(
	env: Env,
	region: DurableObjectLocationHint,
	shard: number,
	partition?: number,
	/** The region's current generation (placement-policy.ts generationOf); 0 is the plain name. */
	generation = 0,
): EngineStub {
	const name = engineName(region, shard, partition, generation);
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
