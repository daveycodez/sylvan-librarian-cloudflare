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
//
// x56: THE SAME RULE IS WHY ONE OBJECT CAN BE ABANDONED HERE AND NOWHERE ELSE. An object the
// platform keeps on a bad machine cannot be moved either; what a deployment can do is stop using
// it, by listing its id in ABANDONED_ENGINES below. Every stub this module builds for that object's
// name is then built for the name's next EPOCH (`engine-wnam-p10-e1`) — a different id, so a
// different object, placed afresh by whoever addresses it first.
//
// x56: THE SAME RULE IS WHY ONE OBJECT CAN BE ABANDONED HERE AND NOWHERE ELSE. An object the
// platform keeps on a bad machine cannot be moved either; what can be done is to stop using it,
// by listing its id in ABANDONED_ENGINES. Every stub this module builds for that object's name is
// then built for the name's next EPOCH (`engine-wnam-p10-e1`) — a different id, so a different
// object, placed afresh by whoever addresses it first. See ABANDONED_ENGINES.

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
 * `-e<k>` IS ONE OBJECT'S EPOCH (x56), last of all, and epoch 0 omits it like every other axis.
 * Where the generation re-creates a whole region, an epoch re-creates ONE object: the replacement
 * of a name whose earlier object is listed in ABANDONED_ENGINES. Nothing chooses an epoch but
 * `currentEngine` below, which is why no caller passes one.
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
	epoch = 0,
): string {
	const stem = generation > 0 ? `engine-${region}-g${generation}` : `engine-${region}`;
	const base = shard === 0 ? stem : `${stem}-${shard}`;
	const name = partition === undefined ? base : `${base}-p${partition}`;
	return epoch > 0 ? `${name}-e${epoch}` : name;
}

/** The region an engine object's name claims: `engine-wnam-2` → `wnam`,
 * `engine-wnam-2-p3` → `wnam`. Null for anything that is not an engine name. */
export function regionOfEngineName(name: string): string | null {
	return parseEngineName(name)?.region ?? null;
}

/**
 * An engine name, taken apart: `engine-<region>[-g<k>][-<n>][-p<k>][-e<k>]`.
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
	`^engine-(${[...REGION_HINTS].sort((a, b) => b.length - a.length).join("|")})(?:-g([1-9]\\d*))?(?:-(\\d+))?(?:-p(\\d+))?(?:-e([1-9]\\d*))?$`,
);

/**
 * `generation` is present only when it is not 0 — the same convention as `partition` — so a name
 * without `-g` parses exactly as it always has. `epoch` likewise (x56): `engine-wnam-p10-e1` is
 * partition 10 of wnam, exactly as `engine-wnam-p10` is — the epoch says WHICH OBJECT holds that
 * partition, never what the object holds, so everything that reads a partition, a region or a
 * replica out of a label is unchanged by it.
 */
export function parseEngineName(
	name: string,
): { region: string; shard: number; partition?: number; generation?: number; epoch?: number } | null {
	const match = ENGINE_NAME_RE.exec(name);
	if (!match?.[1]) return null;
	return {
		region: match[1],
		shard: match[3] === undefined ? 0 : Number(match[3]),
		...(match[4] === undefined ? {} : { partition: Number(match[4]) }),
		...(match[2] === undefined ? {} : { generation: Number(match[2]) }),
		...(match[5] === undefined ? {} : { epoch: Number(match[5]) }),
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
 *
 * The EPOCH-0 name, whatever epoch the label itself carries: an epoch belongs to one object, so
 * `engine-wnam-p10-e1`'s sibling for partition 3 is `engine-wnam-p3`. Which object holds that
 * name today is `siblingStub`'s question (currentEngine), not this function's.
 */
export function siblingEngineName(label: string, partition: number): string | null {
	const parsed = parseEngineName(label);
	if (!parsed) return null;
	return engineName(parsed.region as DurableObjectLocationHint, parsed.shard, partition, parsed.generation);
}

// ── x56: abandoning ONE object ──────────────────────────────────────────────────────────────────
//
// WHY. DeckGen, 2026-10-01 → 10-03, eleven `engine-wnam-p*` objects, every one in colo SEA all week
// (their own `placement:` lines and the invocation metrics' coloCode agree). Two of them coordinated
// 2,797 of the region's 3,308 stalled gathers on 10-03 — a third of what each coordinated, against
// 1–2% for the other nine — with 1–4 of their sibling calls delivered 3.1–3.4s late (sometimes
// ~1.15s), and to the same five siblings (p0, p4, p5, p6, p7) all but a handful of times:
//
//   - engine-wnam-p10 from the deploy of 10-01 23:25 UTC, through six more deploys and two
//     nightly publishes, in hundreds of fresh isolates;
//   - engine-wnam-p8 from 10-02 12:57:25 UTC — no deploy, no publish — which is the second its
//     store loaded into p10's isolate ("isolate load #2, holds 2 engine(s): engine-wnam-p10,
//     engine-wnam-p8"). It had run alone and clean until then; 334 store loads since have found
//     the two in one isolate, and no other pair of wnam objects in any.
//
// So the stall goes with WHERE those objects run, not with which objects they are, and the platform
// decides that: Cloudflare's docs say an object's data center is fixed at creation ("Durable
// Objects do not currently change locations after they are created",
// developers.cloudflare.com/durable-objects/reference/data-location/) while objects "migrate among
// healthy servers" (…/durable-objects/concepts/what-are-durable-objects/) — within the data
// center, and by the platform's choice alone. engine-wnam-p9 (09-29) and -p1 (09-27, 10-02) each
// stalled for hours and stopped with no deploy; -p8 started stalling with none.
//
// WHAT THIS IS. The one thing a deployment can do about an object it cannot move: stop using it. An
// id listed below is never addressed again by anything that builds a stub from a region and a
// partition; the name's next epoch is, and that is a new object, placed by its first caller (most
// often a sibling's call from inside the region, which passes no hint; else the Worker's, hinted).
// WHAT THIS IS NOT: a cure. Nothing says where the replacement lands — the same colo and another
// machine, the same machine, or another colo of the hint (the nightly's wnam probes land in SJC, LAX,
// DEN and DFW, and the free account's wnam objects live in DFW, DEN and SJC), where every sibling
// call to it crosses between data centers. So it is a MANUAL lever, with the lines that say what
// it did: the replacement's own `placement: colo=` line on its first load, its "store loaded …
// holds N engine(s)" line, and the `slow gather` lines under its new label. ENGINE-PLACEMENT.md §5
// is the runbook.
//
// WHY AN ID AND NOT A NAME. This repo deploys to two accounts from one push, and `engine-wnam-p10`
// is another, healthy object on the other one (its wnam objects report DFW, DEN and SJC). An object
// id is the namespace's hash of the name, so it names one object on one account; on every other
// deployment the list matches nothing and costs one id string and one Map lookup per stub. The id
// is what Workers Logs prints as `$workers.durableObjectId` on any of the object's lines, and what
// GraphQL's durableObjectsInvocationsAdaptiveGroups prints as `objectId`.
//
// THE ORDER OF A MOVE, which is what keeps both names working throughout:
//
//   1. An entry ships in a deploy. Isolates on the new version address the next epoch; isolates on
//      the old one, for the seconds a rollout takes, still address the abandoned object — which is
//      untouched, still holds its store, and answers them as it always did.
//   2. The replacement's first call finds an empty object: it loads its partition from KV (one
//      chunk read, ~14 MB compressed), caches it in its own SQLite (~15 rows) and announces itself
//      (one KV put). That is the whole cost of a move — see ENGINE-PLACEMENT.md §5 for the budget.
//   3. The abandoned object gives its storage back at a nightly publish (import-coordinator
//      stepNotify), never sooner than ABANDONED_RELEASE_AFTER_MS after the entry's `since`, and
//      never while it has served a call in the last ABANDONED_QUIET_MS (SearchEngine
//      releaseAbandoned). Until then it is notified of each publish like any live object, so a
//      straggler that reaches it is answered from the current build.
//   4. To UNDO a move before step 3, delete the entry: the name's epoch-0 object is addressed again
//      and still holds its cache. After step 3 deleting the entry still works, at one more KV load.
//      Either way the replacement is then the object nothing addresses, and the next publish
//      releases it (supersededEngine).
//
// To move an object AGAIN, list the replacement's id as well; the name then resolves to `-e2`.

/** One object this deployment has stopped using. */
export interface AbandonedEngine {
	/** The object's id, 64 hex digits: `$workers.durableObjectId` in Workers Logs. */
	id: string;
	/** The name that hashes to it on its account — documentation, checked when the id matches. */
	name: string;
	/** ISO time the entry shipped. Its storage is not released before ABANDONED_RELEASE_AFTER_MS past it. */
	since: string;
	/** The evidence, in a sentence. */
	why: string;
}

/**
 * The objects no stub is built for. EMPTY: the lever ships unpulled.
 *
 * An entry looks like this (DeckGen's engine-wnam-p10 as of 2026-10-03):
 *
 *   {
 *     id: "669242d40ff0a82acea97ae47009b9698e2bc39877c89632ea7a7d4fdac88691",
 *     name: "engine-wnam-p10",
 *     since: "2026-10-04T00:00:00Z",
 *     why: "x56: 1,470 of its 4,073 gathers stalled on 10-03; every other wnam coordinator 44–78",
 *   },
 */
export const ABANDONED_ENGINES: readonly AbandonedEngine[] = [];

/** No name is followed past this many abandoned objects: a longer chain is a list gone wrong. */
export const MAX_ENGINE_EPOCH = 8;

/**
 * How long after an entry's `since` its object keeps its storage, at least. Every isolate is on the
 * version that carries the entry within seconds of its deploy; twelve hours is so that a move made
 * in an evening is judged by a day's traffic before the next nightly makes undoing it cost a load.
 */
export const ABANDONED_RELEASE_AFTER_MS = 12 * 60 * 60 * 1000;

/** An abandoned object that served a call this recently is still in use by someone: not released. */
export const ABANDONED_QUIET_MS = 15 * 60 * 1000;

let abandonedById = new Map<string, AbandonedEngine>(ABANDONED_ENGINES.map((e) => [e.id, e]));
const misnamed = new Set<string>();

/** For tests: use `list` as the abandoned objects, or the shipped list when omitted. */
export function setAbandonedEnginesForTests(list: readonly AbandonedEngine[] = ABANDONED_ENGINES): void {
	abandonedById = new Map(list.map((e) => [e.id, e]));
	misnamed.clear();
}

/**
 * The object that holds a name today: the name's own, or — when that one is abandoned — its next
 * epoch's, and so on. With nothing abandoned this is `idFromName` and nothing else: no string is
 * made of the id and no lookup runs, so an empty list costs the hot path nothing.
 */
function currentEngine(
	env: Env,
	region: DurableObjectLocationHint,
	shard: number,
	partition: number | undefined,
	generation: number,
): { id: DurableObjectId; name: string } {
	let name = engineName(region, shard, partition, generation);
	let id = env.SEARCH_ENGINE.idFromName(name);
	if (abandonedById.size === 0) return { id, name };
	for (let epoch = 1; epoch <= MAX_ENGINE_EPOCH; epoch++) {
		const entry = abandonedById.get(id.toString());
		if (!entry) break;
		if (entry.name !== name && !misnamed.has(entry.id)) {
			misnamed.add(entry.id);
			console.warn(`ABANDONED_ENGINES lists ${entry.id} as ${entry.name}, but it is the object named ${name}`);
		}
		name = engineName(region, shard, partition, generation, epoch);
		id = env.SEARCH_ENGINE.idFromName(name);
	}
	return { id, name };
}

/**
 * The name a stub for (region, shard, partition, generation) is built for right now — the epoch
 * resolved. For logs and tests; the stubs themselves come from placeEngineStub and siblingStub.
 */
export function currentEngineName(
	env: Env,
	region: DurableObjectLocationHint,
	shard: number,
	partition?: number,
	generation = 0,
): string {
	return currentEngine(env, region, shard, partition, generation).name;
}

/**
 * Whether the object named `name` is one nothing addresses any more on THIS deployment, and why —
 * or null for an object in use. The publish fan-out asks this of every announced name
 * (import-coordinator stepNotify). Two ways to be superseded:
 *
 *   - its id is listed in ABANDONED_ENGINES (`entry`), so its name resolves to a later epoch;
 *   - it IS a later epoch (`engine-wnam-p10-e1`) and its name resolves to an earlier one, because
 *     the entry that made it was deleted — an undone move's replacement. `entry` is null: nothing
 *     dates it, so it is released as soon as it is unused.
 *
 * A name with no epoch, on a deployment with nothing listed, is answered without hashing anything.
 */
export function supersededEngine(env: Env, name: string): { by: string; entry: AbandonedEngine | null } | null {
	const parsed = parseEngineName(name);
	if (!parsed) return null;
	if (parsed.epoch === undefined && abandonedById.size === 0) return null;
	const by = currentEngine(
		env,
		parsed.region as DurableObjectLocationHint,
		parsed.shard,
		parsed.partition,
		parsed.generation ?? 0,
	).name;
	if (by === name) return null;
	const entry =
		abandonedById.size === 0 ? null : (abandonedById.get(env.SEARCH_ENGINE.idFromName(name).toString()) ?? null);
	return { by, entry };
}

/** Whether an abandoned object is old enough to give its storage back (ABANDONED_RELEASE_AFTER_MS). */
export function abandonedReleaseDue(entry: AbandonedEngine, nowMs: number): boolean {
	const since = Date.parse(entry.since);
	// An unreadable `since` never comes due: the object keeps its storage until the entry is fixed.
	return Number.isFinite(since) && nowMs - since >= ABANDONED_RELEASE_AFTER_MS;
}

/** What a publish did about the announced objects nothing addresses any more (supersededEngine). */
export interface AbandonedSweep {
	/** Storage released and announcement deleted: gone, and not to be notified. */
	released: string[];
	/** Listed, but not yet ABANDONED_RELEASE_AFTER_MS past `since`: notified like any live object. */
	waiting: string[];
	/** Due, but served a call within ABANDONED_QUIET_MS: kept and notified; the next publish asks again. */
	busy: string[];
	/** The release call failed: left announced, not notified this time; the next publish asks again. */
	failed: string[];
}

/**
 * Step 3 of a move (see ABANDONED_ENGINES): at a publish, every ANNOUNCED object that nothing
 * addresses any more gives its storage back once it is due and unused, and its announcement goes
 * with it — the two together, for the reason the stale-shard release gives: a leftover
 * announcement would have the next publish address the name and re-create the object. An undone
 * move's replacement goes the same way, or it would be notified, and hold a build, every night for
 * good.
 *
 * An object is asked only through `release`, which is SearchEngine.releaseAbandoned: the object
 * itself refuses while somebody is still calling it. Never throws; a failed call is reported and
 * retried by the next publish.
 */
export async function sweepAbandonedEngines(
	announced: readonly string[],
	deps: {
		superseded(name: string): { by: string; entry: AbandonedEngine | null } | null;
		release(name: string): Promise<{ released: boolean; servedAgoMs: number | null }>;
		unannounce(name: string): Promise<void>;
		nowMs: number;
		log?: (line: string) => void;
	},
): Promise<AbandonedSweep> {
	const sweep: AbandonedSweep = { released: [], waiting: [], busy: [], failed: [] };
	const notes: string[] = [];
	for (const name of announced) {
		const gone = deps.superseded(name);
		if (!gone) continue;
		const { by, entry } = gone;
		if (entry && !abandonedReleaseDue(entry, deps.nowMs)) {
			sweep.waiting.push(name);
			notes.push(
				`${name} (now ${by}) keeps its storage until ${ABANDONED_RELEASE_AFTER_MS / 3_600_000}h past ${entry.since}`,
			);
			continue;
		}
		try {
			const { released, servedAgoMs } = await deps.release(name);
			if (released) {
				await deps.unannounce(name);
				sweep.released.push(name);
				notes.push(`${name} released (${entry ? `abandoned ${entry.since}` : "its move was undone"}; now ${by})`);
			} else {
				sweep.busy.push(name);
				notes.push(`${name} (now ${by}) kept: it served a call ${servedAgoMs}ms ago`);
			}
		} catch (err) {
			sweep.failed.push(name);
			notes.push(`${name} (now ${by}) could not be released (${err}); asked again at the next publish`);
		}
	}
	if (notes.length > 0) {
		(deps.log ?? ((line: string) => console.log(line)))(`Publish notify: abandoned object(s) — ${notes.join("; ")}`);
	}
	return sweep;
}

/**
 * Address a SIBLING partition of a label this object already carries — the
 * gather DO's fan-out (CARD-PARTITIONING §6 phase 1/2 goes through here).
 *
 * Deliberately built with `addressAnnouncedEngine`'s no-hint semantics: a gather
 * object was itself placed by a real request in its region, so a sibling first
 * created from here is created near that traffic anyway — but no hint is passed,
 * so this helper cannot PIN a region even if handed a mangled label.
 *
 * The sibling is the object that holds its name TODAY (currentEngine), so a coordinator and the
 * Worker always agree on which object is partition k — both resolve it here, from the same list.
 */
export function siblingStub(env: Env, label: string, partition: number): EngineStub | null {
	const parsed = parseEngineName(label);
	if (!parsed) return null;
	const { id } = currentEngine(
		env,
		parsed.region as DurableObjectLocationHint,
		parsed.shard,
		partition,
		parsed.generation ?? 0,
	);
	return env.SEARCH_ENGINE.get(id);
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
 *
 * x55 makes the same call from INSIDE an engine object: a gather coordinator whose call to a sibling
 * is late asks the neighbour region's shard-0 copy of that partition (search-engine-do.ts
 * partitionClients, sibling-hedge.ts). It is the hedge's own name, hint and generation, built by
 * this function for the same reason — the hint is the NEIGHBOUR's, so an object this call created
 * would be created in the region its name claims, wherever the caller runs. What must never happen
 * is the thing `siblingStub` exists to prevent: addressing a name with no hint, or with the
 * caller's.
 */
export function placeEngineStub(
	env: Env,
	region: DurableObjectLocationHint,
	shard: number,
	partition?: number,
	/** The region's current generation (placement-policy.ts generationOf); 0 is the plain name. */
	generation = 0,
): EngineStub {
	// x56: the object that holds this name today — an abandoned one's next epoch (currentEngine).
	const { id } = currentEngine(env, region, shard, partition, generation);
	// The hint only applies at creation, so passing it on every get() is free and
	// makes placement explicit rather than "wherever the first caller happened to
	// be".
	return env.SEARCH_ENGINE.get(id, { locationHint: region });
}

/**
 * Address an object that has ALREADY announced itself (see REGION_LIVE_PREFIX),
 * without any power to place one.
 *
 * The publisher's fan-out uses this. Omitting the hint is not a cosmetic
 * difference: on a name that already exists a hint would be ignored anyway, and
 * on a name that does not, it is the difference between wasted work and a
 * permanently misplaced object.
 *
 * The EXACT name, epoch and all, with no ABANDONED_ENGINES lookup: this is how the fan-out reaches
 * an abandoned object, to notify it or to release it.
 */
export function addressAnnouncedEngine(env: Env, name: string): EngineStub {
	return env.SEARCH_ENGINE.get(env.SEARCH_ENGINE.idFromName(name));
}
