// The Engine every request isolate uses: the per-route table of plan B5,
// deciding for each route how many partition objects to ask and how to combine
// what comes back. The store is partitioned, always — there is no second Engine
// implementation in the isolate to fall back to.
//
// The RPC-count contract (pinned by tests/engine/partitioned-routes.test.ts):
//
//   search / listing (all shapes)      1 isolate RPC, to the GATHER partition
//                                      (hash(query) % N); the gather object
//                                      fans phases 1 and 2 to its siblings —
//                                      for a NAME-ONLY filter, only to the ones
//                                      its names index says hold a match (n15):
//                                      a 404 is that 1 call, a hit 1 + the
//                                      partitions holding it (usually 1-2)
//   total_cards                        free — rides phase 1 of the gather
//   catalog (types+keywords)           N, summed — ONCE per store generation per
//                                      isolate (CATALOG_CACHE); every later call
//                                      is 0, like setsWithExtras
//   random                             1, partition weighted by card_count
//   scryfall_id / external-keyed       1 when the routing filter knows the id
//                                      (routing-filter.ts, ~740KB in KV), else
//                                      the old N-way first-non-null fan-out —
//                                      and 1 + (N-1) when a hint comes back
//                                      empty, so never worse than the fan-out
//   collection (scryfallCollectionBatch)
//                                      ONE round, at most N: every identifier
//                                      kind in one call per partition. Keys,
//                                      {set, collector_number} addresses and
//                                      names go only to the partitions the
//                                      modulus or routing filter names — a
//                                      lone address is ONE call — and a routed
//                                      NAME only to its own partition; an
//                                      unrouted name goes to all N. A name's
//                                      rank and its local winner's card come
//                                      back together, so there is no
//                                      materialize round; a routed name its
//                                      partition does not settle costs a
//                                      second round to the rest — except a
//                                      name routed to its SERVED partition
//                                      under a scope filter or a set, which
//                                      rides every round-1 call instead (its
//                                      route can miss), so a scoped batch of
//                                      misses is one round. An oracle id
//                                      goes by partitionOfOracleId; its miss
//                                      re-reads the manifest (cacheTtl 60) and
//                                      asks again ONCE iff the modulus moved
//                                      the target
//   set + collector number             1 when the routing filter knows the
//   (/cards/:set/:number)              address (setNumberKey), else N; a
//                                      hinted miss is 1 + (N-1). A fan-out
//                                      answers with the FIRST card to arrive
//                                      (one partition holds an address), and
//                                      an id fan-out once its lowest answer is
//                                      decided (firstDecided), never on the
//                                      slowest object
//   named exact                        1 when the routing filter places the
//                                      name (nameKey) and that partition's
//                                      probe settles it, else N probes
//   search pinned to !"Name"           1, when the filter names ONE partition
//                                      holding the name and it finds rows;
//                                      else the gather
//   named fuzzy (scryfallNamedFuzzy)   1 plan from ONE object's names index (n15),
//                                      then one round of bundles from only the
//                                      partitions the plan names (the winner's,
//                                      usually) — 2 calls where it was N, 1 when
//                                      the plan object is the winner's (x22: its
//                                      own bundle rides the plan's call). A
//                                      needle the index cannot settle because
//                                      the answer may be a FOREIGN printed name
//                                      (the index holds none) asks all N — every
//                                      miss does — N calls with the plan's, where
//                                      it was N + 1. Without an index, or set=:
//                                      ONE round of N bundles — exact probe,
//                                      typo candidates and local race, and
//                                      containment from each partition at once,
//                                      each skipped where it cannot matter
//                                      (containment beside a WEAK typo winner
//                                      too, n14); 1
//                                      for an exact name the routing filter
//                                      places, whose partition is asked first
//                                      (a settled miss or a typo then asks the
//                                      other N-1). It was up to 3N+1 over five
//                                      sequential waits
//   containing (the staged path)       N, combined (see each method's rules)
//   autocomplete                       1, to gatherPartitionOf(prefix), which answers for the
//                                      whole corpus from the build's card-names blob (n8); N,
//                                      merged prefix-first, when the manifest names no blob or
//                                      that one object cannot answer (then 1 + N)
//
// Cross-partition NAME semantics are EXACT: fuzzy fans out the scores-bearing
// fuzzy_candidates export and runs the engine's own FLOOR/LEAD race globally
// (raceFuzzyCandidates — best overall; runner-up = best candidate differing in
// BOTH folded name and oracle id), then materializes the winner through the
// winning partition's own fuzzy_card_by_name, whose local race the global
// winner provably also wins (its local competitors are a subset of the global
// candidates it just led). Autocomplete merges under the engine's own
// (prefix-rank, trigram similarity, name) key, recomputed from the names — both rules
// are pinned against the single-store reference by the Rust differential
// (core_api's fuzzy_race_across_partitions_matches_the_single_store and
// autocomplete_merge_key_matches_the_single_store).

import { collateName, foldAccents } from "../parser/pystr";
import { cardNamesOf } from "./card-names";
import { emptyCollectionAnswer } from "./collection-batch";
import { edgeCacheUrl, readThroughEdgeCache } from "./edge-cache";
import { NAMED_CONTAINMENT_LIMIT, resolveNamedFuzzyStaged, weakWinnerOrContained } from "./named-fuzzy";
import { gatherPartitionOf, partitionOfOracleId } from "./partition";
import { pinnedExactName, pinnedOracleId } from "./pinned-oracle";
import { EngineCallTimeoutError, isTransientEngineFailure, type RemoteEngine } from "./remote-engine";
import {
	externalIdKey,
	illustrationIdKey,
	type NameHint,
	nameKey,
	RoutingFilter,
	scryfallIdKey,
} from "./routing-filter";
import {
	ARCHIVE_FORMAT_VERSION,
	formatManifestKey,
	isPartitionedManifest,
	readManifest,
	readRoutingFilter,
	readRoutingFilterFromColo,
} from "./store-kv";
import {
	type CollectionBatch,
	type CollectionBatchAnswer,
	type CollectionBatchKey,
	type CollectionScope,
	type Engine,
	type EngineSearchOptions,
	type EngineSearchResult,
	type EngineSerializedResult,
	EngineUnavailableError,
	type Env,
	type ExactNameProbe,
	FUZZY_SIMILARITY_LEAD,
	type FuzzyCandidateWire,
	type NamedFuzzyAnswer,
	type NamedFuzzyBundle,
	type NamedFuzzyPlan,
	type NameIdentifier,
	type NameRank,
	type ResultShape,
	type ScryfallFuzzyResult,
	type SearchPageEnvelope,
	StaleModulusError,
	type StoreManifest,
} from "./types";

/**
 * The manifest routing pins each request to, read through three tiers:
 *
 *   1. this isolate's memo, 60s;
 *   2. the data center's Cache API entry, 60s — `caches.default` is unmetered and shared by
 *      every isolate in the colo, so a cold isolate (which at low traffic is nearly every
 *      request) no longer spends a KV read on the one key every request needs;
 *   3. KV (`readManifest`, its own cacheTtl 60), whose every `get` is a metered read against
 *      the same 100k/day budget the request meter draws on.
 *
 * The Cache API's scope is the colo, exactly KV's cacheTtl scope, so tier 2 changes nothing
 * about freshness: a publish still reaches a colo within a minute (two, worst case, when both
 * tiers were filled just before it). The previous architecture served the 70MB ARCHIVE through
 * `caches.default` and paid a second of CPU per load for the double stream (store.ts header);
 * a 2KB manifest has none of that cost.
 *
 * The authoritative readers stay on KV: the stale-modulus retry in index.ts re-reads the key
 * directly, as do the Durable Objects' truth checks before a swap. Those are rare, and they
 * exist precisely to see past a cached answer.
 *
 * THROWS rather than returning null when there is nothing usable at the key.
 * There is no unpartitioned serving path to hand the request to instead, so
 * "no manifest" and "a manifest with no partitions[]" both mean the deployment
 * cannot answer, and the honest form of that is the loud 503 every other
 * engine-unavailable condition takes. readManifest already refuses a manifest
 * that predates the partitioned format, with its own specific wording.
 *
 * Only SUCCESSFUL reads are memoized or put — a failure must not pin an isolate (or a colo)
 * to a bad answer for a minute. A cache entry that does not parse to a partitioned manifest is
 * treated as a miss, never served.
 *
 * THE COLO ENTRY IS KEYED BY FORMAT (x19), like the KV key it caches. Two builds share a colo's
 * Cache API during a deploy — the one being replaced and the one replacing it — and one entry for
 * both would hand each the other's manifest for up to a minute at a time: exactly the store its
 * engine refuses. So each build caches `store:manifest:v<its format>` under that key's URL, and an
 * entry of any other format is a miss.
 */
let manifestCache: { at: number; manifest: StoreManifest } | null = null;
const MANIFEST_CACHE_MS = 60_000;
const MANIFEST_KEY_READ = formatManifestKey(ARCHIVE_FORMAT_VERSION);
const MANIFEST_EDGE_URL = edgeCacheUrl(MANIFEST_KEY_READ);
const MANIFEST_EDGE_TTL_S = 60;
const utf8 = new TextDecoder();

/** Clears the isolate memo so a test can drive the cache and KV tiers deliberately. */
export function resetManifestMemoForTests(): void {
	manifestCache = null;
}

/** A partitioned manifest with partitions, or null: the only thing the edge tier may hand back. */
function usableManifest(bytes: Uint8Array | null): StoreManifest | null {
	if (bytes === null) return null;
	try {
		const parsed = JSON.parse(utf8.decode(bytes)) as StoreManifest;
		return isPartitionedManifest(parsed) &&
			parsed.partitions?.length &&
			parsed.format_version === ARCHIVE_FORMAT_VERSION
			? parsed
			: null;
	} catch {
		return null;
	}
}

export async function livePartitionedManifest(env: Env, defer?: (p: Promise<unknown>) => void): Promise<StoreManifest> {
	const now = Date.now();
	const cached = manifestCache;
	if (cached && now - cached.at <= MANIFEST_CACHE_MS) return cached.manifest;
	let fromKv: StoreManifest | null | undefined;
	const bytes = await readThroughEdgeCache(
		MANIFEST_EDGE_URL,
		MANIFEST_EDGE_TTL_S,
		async () => {
			fromKv = await readManifest(env);
			// Only a servable manifest is stored: the throws below are for the KV answer.
			return fromKv?.partitions?.length ? new TextEncoder().encode(JSON.stringify(fromKv)) : null;
		},
		defer,
	);
	const manifest = fromKv === undefined ? usableManifest(bytes) : fromKv;
	if (fromKv === undefined && manifest === null) {
		// The cache tier handed back something unusable; KV is the authority.
		return livePartitionedManifestFromKv(env, now);
	}
	return commitManifest(manifest, now);
}

async function livePartitionedManifestFromKv(env: Env, now: number): Promise<StoreManifest> {
	return commitManifest(await readManifest(env), now);
}

function commitManifest(manifest: StoreManifest | null, now: number): StoreManifest {
	if (!manifest) {
		// Deliberately the same posture as the loader's: building the index is the
		// deploy's job (scripts/import-store.sh), and a request finding no store
		// means the deploy did not publish one.
		throw new EngineUnavailableError(
			`No store manifest at ${MANIFEST_KEY_READ}; the deploy has not published an index for this build's format`,
		);
	}
	if (!manifest.partitions?.length) {
		throw new EngineUnavailableError(
			`The manifest at ${MANIFEST_KEY_READ} (${manifest.store_key}) declares partition_count ` +
				`${manifest.partition_count} but carries no partitions[] records, so there is nothing to route to.`,
		);
	}
	manifestCache = { at: now, manifest };
	return manifest;
}

/** Test hook: forget the isolate's cached manifest. */
export function forgetLivePartitionedManifest(): void {
	manifestCache = null;
}

/** A string's alphanumerics, in order — the containment stage's separator fold (core_api.rs's
 * `strip_separators`), which the cross-partition merge has to re-apply to rank what came back. */
function unseparated(value: string): string {
	return [...foldAccents(value.toLowerCase())].filter((c) => /\p{L}|\p{N}/u.test(c)).join("");
}

/** Whether `value` IS `whole` once its separators are dropped. Absent/non-string is never a match. */
function equalsUnseparated(value: unknown, whole: string): boolean {
	return typeof value === "string" && unseparated(value) === whole;
}

/**
 * A card object's flavor-name KEY: its top-level `flavor_name`, or else the flavor names its faces
 * carry, joined " // " in face order over the faces that carry one — the key the engine matches
 * (core_api's `FaceFlavorKey`). Measured on api.scryfall.com 2026-09-25: `fuzzy=lord of bats` and
 * `fuzzy=recyclops` answer printings whose flavor names sit on their faces alone.
 */
export function flavorKeyOf(card: Record<string, unknown>): string | undefined {
	if (typeof card.flavor_name === "string") return card.flavor_name;
	const faces = card.card_faces;
	if (!Array.isArray(faces)) return undefined;
	const names = faces
		.map((f) => (f !== null && typeof f === "object" ? (f as Record<string, unknown>).flavor_name : undefined))
		.filter((n): n is string => typeof n === "string");
	return names.length > 0 ? names.join(" // ") : undefined;
}

/**
 * Whether exact-name rank `a` beats `b`, with null losing to anything — card_engine's
 * `NameHit::outranks` over the wire form `[tier, name, served, score]` (core_api's
 * `exact_name_rank`): element by element in the order the engine emits them, a NUMBER higher-wins
 * and a STRING — the collated card name — lower-wins.
 *
 * The tier leads: a partition holding an extras-only card the needle names WHOLE beats one holding
 * a served card it names by a face (`exact=chaos`: the fj25 front card Chaos over Order // Chaos,
 * api.scryfall.com 2026-09-26). On one tier the first name wins (`exact=day`: the Day // Night token
 * over Night // Day), and of one name the served card (`exact=Earth Rumble`: the tla sorcery over
 * the jtla front card).
 */
export function beatsExactRank(a: NameRank, b: NameRank | null): boolean {
	if (b === null) return true;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const [x, y] = [a[i] ?? 0, b[i] ?? 0];
		if (x === y) continue;
		if (typeof x === "string" && typeof y === "string") return x < y;
		return Number(x) > Number(y);
	}
	return false;
}

/** The partition a name hint sends a lookup to first. */
function hintPartition(hint: NameHint): number {
	return "sole" in hint ? hint.sole : hint.served;
}

/** The partition a SOLE name hint names, else null — the only route whose miss `present` settles. */
function soleHint(hint: NameHint | null): number | null {
	return hint !== null && "sole" in hint ? hint.sole : null;
}

/**
 * Whether the ONE reply a routed name got — from the partition its hint names — is the whole
 * store's answer, so no other partition need be asked (backlog n6).
 *
 * The filter's word is exact only for a key it was built with; for any other it is an arbitrary
 * byte. So the reply has to PROVE the key was real before the word is trusted:
 *
 *   sole p     p answered (it holds the name, so it emitted the key, so the value is exact and no
 *              other partition holds it) — or it missed, but holds the name without the set or
 *              scope (`present`): the same proof, and every other partition misses too.
 *   served s   s answered (it holds the name, so the value is exact: s is its one served holder,
 *   rival t    and every other partition holds it only as an extra — on tier t at most, 0 when
 *              only as an art series, which ranks below everything), and s's `[tier, name, served,
 *              …]` beats every one of theirs whatever their names and scores: a HIGHER tier than
 *              t, or the whole-name tier served (every whole-name candidate has the needle for its
 *              name, so the served flag decides). `delver of secrets` (a face of the served card,
 *              its art-series faces elsewhere, t = 0) settles; `chaos` (Order // Chaos's face, t = 3
 *              from the fj25 front card Chaos) and `night` (Night // Day's face, t = 2 from the Day
 *              // Night token, whose name comes first) do not, and the merge answers the extra.
 *   served s   a filter built before the builders spelled tiers (no `rival`): s answered SERVED —
 *              the rule before x26, when served led the rank. Until the next build publishes a
 *              tiered filter it answers exactly as it did, a whole-name extra in another
 *              partition included (`chaos`); a reply it does not settle is merged tier-first.
 *
 * Anything else — a miss from a served route, a reply another partition's extras can beat, an
 * absent name under a garbage hint — settles nothing, and the caller asks the rest and merges
 * every reply.
 */
export function nameReplySettles(hint: NameHint, rank: NameRank | null, present: boolean): boolean {
	if ("sole" in hint) return rank !== null || present;
	if (rank === null) return false;
	const tier = Number(rank[0] ?? 0);
	const served = Number(rank[2] ?? 0);
	if (hint.rival === undefined) return served === 1;
	return tier > hint.rival || (tier === hint.rival && tier === NAME_TIER_WHOLE && served === 1);
}

/** The engine's whole-name tier (core_api's `TIER_WHOLE_NAME`): on it every candidate's name IS the
 * needle, so of two replies the served one wins. */
const NAME_TIER_WHOLE = 3;

// ── The routing filter (src/engine/routing-filter.ts) ─────────────────────────
//
// A ~740KB KV value that answers "which partition owns this printing id?" for
// every addressable id in the build — scryfall_id, illustration_id and the five
// external namespaces, 1.23M keys on the real corpus. It turns the bare-UUID
// routes from an N-way fan-out into ONE RPC.
//
// NEVER WAITED ON FOR KV. The first request in a fresh isolate finds nothing cached and starts the
// load, which reads the colo's Cache API copy first (edge-cache.ts) and KV only on a miss. A
// ROUTABLE request (a bare id, an address, a collection key) may wait for that first stage — the
// colo copy, a same-machine read — for at most ROUTING_WAIT_MS; everything else, and every wait
// that runs out, fans out exactly as before, which is always correct on its own. What must never
// happen is a 740KB cross-colo KV read in front of a 6ms point lookup.
//
// Why wait at all (backlog n1): before this, the first lookups of every fresh isolate asked all ten
// partitions — 27 of 135 single-address batches right after b3, ~100k DO calls a day.

/** How long a routable request may wait for the colo's copy of the filter. Measured on DeckGen
 * 09-25 (96 colo loads): p50 14 ms, p75 57, p90 170 — 20 ms caught 70% of them; 60 catches ~75%
 * and still never waits on the slow tail. */
export const ROUTING_WAIT_MS = 60;

/** Cached per isolate and keyed by BUILD, because the filter is immutable per
 * build — a new generation is a new key, not a new value under the old one.
 * `filter: null` remembers a build with no usable filter so the isolate stops
 * asking KV for it once per request. */
let routingCache: { builtAt: string; filter: RoutingFilter | null } | null = null;
/** The load in flight: `colo` settles after the Cache API stage — with the filter on a hit, null on a
 * miss (the KV stage then continues under `done`). */
let routingLoad: { builtAt: string; done: Promise<void>; colo: Promise<RoutingFilter | null> } | null = null;

/** Validate and cache `bytes` as `builtAt`'s filter; the parsed filter, or null when refused. */
function adoptRoutingFilter(
	bytes: Uint8Array,
	builtAt: string,
	manifest: StoreManifest,
	source: string,
	startedAt: number,
): RoutingFilter | null {
	const parsed = RoutingFilter.parse(bytes, {
		builtAt,
		partitionCount: manifest.partition_count as number,
		partitionHash: manifest.partition_hash as string,
	});
	if ("reason" in parsed) {
		// Validated against the manifest the way archiveOfManifest validates
		// partition_hash: a filter that disagrees was built under another
		// modulus and would hint at partitions that no longer mean anything.
		console.warn(`routing filter for ${builtAt} refused (${parsed.reason}); routes fall back to the fan-out`);
		routingCache = { builtAt, filter: null };
		return null;
	}
	routingCache = { builtAt, filter: parsed.filter };
	console.log(
		`routing filter loaded for build ${builtAt}: ${parsed.filter.keyCount} ids, ` +
			`${(parsed.filter.byteLength / 1024).toFixed(0)}KB, from ${source} in ${Date.now() - startedAt}ms`,
	);
	return parsed.filter;
}

/** Start (once per build per isolate) the two-stage load: colo cache, then KV. */
function startRoutingLoad(
	env: Env,
	manifest: StoreManifest,
	builtAt: string,
	waitUntil: (p: Promise<unknown>) => void,
): NonNullable<typeof routingLoad> {
	if (routingLoad?.builtAt === builtAt) return routingLoad;
	let settleColo: (filter: RoutingFilter | null) => void = () => {};
	const colo = new Promise<RoutingFilter | null>((resolve) => {
		settleColo = resolve;
	});
	const done = (async () => {
		const startedAt = Date.now();
		try {
			const fromColo = await readRoutingFilterFromColo(manifest);
			if (fromColo !== null) {
				settleColo(adoptRoutingFilter(fromColo, builtAt, manifest, "the colo cache", startedAt));
				return;
			}
			settleColo(null);
			// Read-through: KV, then stored in the colo cache for the next fresh isolate.
			const bytes = await readRoutingFilter(env, manifest);
			if (bytes === null) {
				// Not an error. A build published before this existed, or one whose
				// filter build failed, simply has none — and the fan-out is the
				// deployment's original behaviour, not a degraded mode.
				routingCache = { builtAt, filter: null };
				return;
			}
			adoptRoutingFilter(bytes, builtAt, manifest, "KV", startedAt);
		} catch (err) {
			settleColo(null);
			// A failed read must not poison the cache — the next request retries.
			console.warn(`routing filter for ${builtAt} could not be read (${err}); routes fall back to the fan-out`);
			routingLoad = null;
		}
	})();
	routingLoad = { builtAt, done, colo };
	waitUntil(done);
	return routingLoad;
}

/**
 * The routing filter for this request's pinned build, if the isolate already has
 * it — otherwise null, plus a background load so the next request does.
 */
export function liveRoutingFilter(
	env: Env,
	manifest: StoreManifest,
	waitUntil: (p: Promise<unknown>) => void,
): RoutingFilter | null {
	const builtAt = String(manifest.built_at ?? "");
	if (!builtAt) return null;
	const cached = routingCache;
	if (cached?.builtAt === builtAt) return cached.filter;
	startRoutingLoad(env, manifest, builtAt, waitUntil);
	return null;
}

/**
 * The routing filter as soon as the colo can hand it over: the isolate's copy at once, else the
 * load's colo-cache stage for at most `maxWaitMs`, else null (fan out). Never waits on KV.
 */
export async function routingFilterSoon(
	env: Env,
	manifest: StoreManifest,
	waitUntil: (p: Promise<unknown>) => void,
	maxWaitMs: number = ROUTING_WAIT_MS,
): Promise<RoutingFilter | null> {
	const builtAt = String(manifest.built_at ?? "");
	if (!builtAt) return null;
	const cached = routingCache;
	if (cached?.builtAt === builtAt) return cached.filter;
	const load = startRoutingLoad(env, manifest, builtAt, waitUntil);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), maxWaitMs);
	});
	try {
		return await Promise.race([load.colo, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Test hook: forget the isolate's cached routing filter. */
export function forgetLiveRoutingFilter(): void {
	routingCache = null;
	routingLoad = null;
}

/** Sum per-partition histograms key-wise (catalog types/keywords). */
export function sumCounts(parts: Record<string, number>[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const part of parts) {
		for (const [k, v] of Object.entries(part)) out[k] = (out[k] ?? 0) + v;
	}
	return out;
}

/**
 * Combine per-partition fuzzy outcomes. Conservative by construction (header):
 * any partition's own ambiguity stands; hits on two DISTINCT names cannot be
 * raced without scores, so they read as ambiguous; a single distinct name wins.
 */
export function raceFuzzyCandidates(
	perPartition: FuzzyCandidateWire[][],
	lead: number,
): { status: "hit" | "ambiguous" | "miss"; winner?: number } {
	const all = perPartition.flatMap((list, partition) => list.map((c) => ({ ...c, partition })));
	// The engine's FuzzyRace order (`RaceEntry::rank`), all descending: the score; a SERVED
	// candidate before an extras-only one (two cards sharing a name score identically, and the one
	// a default search shows must lead); the card FIRST PRINTED most recently, then the name that
	// sorts last (backlog x25: Scryfall answers a tie between two names, `sculptor` is Storm
	// Sculptor over Soul Sculptor) — then deterministic tiebreaks. Names compare by code unit, which
	// is the engine's UTF-8 byte order for every name outside the astral planes.
	all.sort(
		(a, b) =>
			b.score - a.score ||
			Number(b.served) - Number(a.served) ||
			(b.firstReleased ?? 0) - (a.firstReleased ?? 0) ||
			(a.foldedName < b.foldedName ? 1 : a.foldedName > b.foldedName ? -1 : 0) ||
			(a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0) ||
			a.vpid - b.vpid,
	);
	const best = all[0];
	if (best === undefined) return { status: "miss" };
	// The engine's own competition rule: only a DIFFERENT name on a DIFFERENT card threatens the
	// leader — a card's own foreign and English names never read ambiguous, and two cards sharing
	// one name are one answer.
	const runner = all.find((c) => c.foldedName !== best.foldedName && c.oracleId !== best.oracleId);
	if (runner !== undefined && best.score - runner.score < lead) return { status: "ambiguous" };
	return { status: "hit", winner: best.partition };
}

/**
 * The distinct `pg_trgm` trigrams of a collated name — the TypeScript twin of core_api.rs's
 * `collated_trigrams`, and the reason it exists here is that a partitioned merge has to recompute
 * the engine's ordering key from the NAMES alone.
 */
function collatedTrigrams(collated: string): Set<string> {
	const out = new Set<string>();
	if (collated === "") return out;
	const padded = `  ${collated} `;
	const chars = [...padded];
	for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
	return out;
}

/**
 * Merge per-partition autocomplete lists under the ENGINE'S OWN ordering key, recomputed from
 * the names: (prefix-rank over the COLLATED name, `pg_trgm` trigram similarity DESCENDING, name).
 *
 * The similarity component is load-bearing and is NOT length — it is what puts `Light Up the
 * Night` ahead of `Lightning Angel` (a repeated `igh`/`ght` window shrinks its trigram set) and
 * what promotes every `q=ser` name ending in `er`. See core_api.rs `autocomplete` for the
 * derivation and the measurement; the Rust differential
 * (autocomplete_merge_key_matches_the_single_store) pins this merge to the single-store output.
 *
 * The extras exclusion needs no mirror here: each partition applies it before answering, so a
 * name that reaches this merge is already one Scryfall would offer.
 */
export function mergeAutocomplete(lists: string[][], prefix: string, limit: number): string[] {
	const seen = new Set<string>();
	const all: string[] = [];
	for (const list of lists) {
		for (const name of list) {
			if (!seen.has(name)) {
				seen.add(name);
				all.push(name);
			}
		}
	}
	const collate = (value: string) => collateName(foldAccents(value.toLowerCase()));
	const p = collate(prefix);
	const needle = collatedTrigrams(p);
	const rank = (name: string) => (collate(name).startsWith(p) ? 0 : 1);
	// similarity as the exact rational |A ∩ B| / |A ∪ B|, cross-multiplied rather than divided so
	// two names cannot tie or untie on a float rounding the Rust side does not have.
	const score = (name: string): [number, number] => {
		const tg = collatedTrigrams(collate(name));
		let inter = 0;
		for (const t of tg) if (needle.has(t)) inter++;
		return [inter, needle.size + tg.size - inter];
	};
	const cache = new Map<string, [number, number]>();
	const scoreOf = (name: string) => {
		let s = cache.get(name);
		if (s === undefined) {
			s = score(name);
			cache.set(name, s);
		}
		return s;
	};
	all.sort((a, b) => {
		if (rank(a) !== rank(b)) return rank(a) - rank(b);
		const [ia, ua] = scoreOf(a);
		const [ib, ub] = scoreOf(b);
		if (ib * ua !== ia * ub) return ib * ua - ia * ub;
		return a < b ? -1 : a > b ? 1 : 0;
	});
	return all.slice(0, limit);
}

/** The corpus-global constants a store generation carries: both catalogs and the extras-set table. */
export interface CatalogTables {
	types: Record<string, number>;
	keywords: Record<string, number>;
	setsWithExtras: string[];
}

/**
 * `store_key` → that generation's CatalogTables, read through three tiers:
 *
 *   1. this isolate's memo (module scope, so it outlives the per-request PartitionedEngine; never
 *      pruned, because an isolate sees a handful of generations in its life and each value is a
 *      few KB);
 *   2. the colo's Cache API entry (edge-cache.ts), keyed by the store key — immutable per
 *      generation, so a day's TTL only bounds how long an old build's copy lingers;
 *   3. the N-way fan-out: one `typeAndKeywordCounts` RPC per partition (RemoteEngine dedupes the
 *      three asks per instance), summed and unioned.
 *
 * Tier 2 is what turned "N Durable Object requests per cold isolate" into "N per colo per
 * generation". The extras-gate asks for `setsWithExtras` on every set-scoped `/cards/search`, the
 * hottest route there is, and `/get_catalog` asks for the counts; DeckGen sees ~32k cold isolates
 * a day, and every one of them used to pay the fan-out on its first such request. Publishing the
 * tables with the store was the other design and it needs a producer the coordinator lacks (the
 * engine computes them at load) plus a second implementation in the native seed path.
 *
 * The in-flight PROMISE is what is memoized, so concurrent first requests share one read, and a
 * rejected one is forgotten rather than remembered as an empty catalog — which would silently
 * turn the extras auto-enable off for the life of the isolate.
 */
const CATALOG_TABLES = new Map<string, Promise<CatalogTables>>();
const CATALOG_EDGE_TTL_S = 86_400;
const catalogText = { decoder: new TextDecoder(), encoder: new TextEncoder() };

/** Clears the isolate memo so a test can drive the cache and fan-out tiers deliberately. */
export function resetCatalogMemoForTests(): void {
	CATALOG_TABLES.clear();
}

/** The cache tier's bytes as CatalogTables, or null for anything that is not that shape. */
function parseCatalogTables(bytes: Uint8Array): CatalogTables | null {
	try {
		const parsed = JSON.parse(catalogText.decoder.decode(bytes)) as Partial<CatalogTables> | null;
		if (!parsed || typeof parsed !== "object") return null;
		if (!parsed.types || !parsed.keywords || !Array.isArray(parsed.setsWithExtras)) return null;
		return { types: parsed.types, keywords: parsed.keywords, setsWithExtras: parsed.setsWithExtras };
	} catch {
		return null;
	}
}

/**
 * How a point lookup's fan-out picks its answer, which is what decides how EARLY it may resolve.
 *
 *   "lowest"  the lowest partition answering non-null wins. A scryfall_id two partitions both
 *             answer (46 in the real corpus) resolves to the lower one, which is also the
 *             partition the routing filter stores. Resolved once partition p has answered
 *             non-null and every partition before p has answered null.
 *   "sole"    at most one partition CAN answer: a {set, collector_number} address, every printing
 *             of which lives in one partition (store-build/routing-keys.tsv, 2026-09-24: 0 of its
 *             `sn:` keys are emitted by two partitions). Resolved on the first non-null answer.
 */
export type FanOutAnswer = "lowest" | "sole";

/**
 * The fan-out's answer as soon as it is DECIDED, rather than when the slowest partition settles.
 *
 * This was `Promise.all`, and that made every partition a single point of failure: one object
 * that did not answer within ENGINE_CALL_DEADLINE_MS failed a lookup another partition had
 * already answered. Measured on DeckGen 2026-09-25: `/cards/plst/MMA-154` fanned out to ten
 * weur partitions (its fresh isolate's routing filter took 204ms, past ROUTING_WAIT_MS); the
 * owner, p6, answered in 258ms; the request 500'd at exactly +35.000s because another partition
 * never answered. `/cards/m13/54` at 20:39 the same way: nine partitions answered within 4.1s, the
 * tenth took the request down.
 *
 * A failure fails the lookup only when the answer DEPENDS on it: under "lowest", a failed
 * partition before the first non-null one (it might have held the card); under "sole", a failure
 * when no partition answered at all (a 404 would claim a card does not exist when one partition
 * could not say). A miss is still only ever reported once EVERY partition has answered null.
 *
 * `runs` is in partition order. The calls this stops waiting for are not cancelled; their
 * answers and errors are dropped, and every rejection is handled so none surfaces as unhandled.
 */
export function firstDecided<T>(runs: Promise<T | null>[], rule: FanOutAnswer): Promise<T | null> {
	type Slot = { state: "pending" } | { state: "value"; value: T | null } | { state: "error"; error: unknown };
	return new Promise<T | null>((resolve, reject) => {
		const slots: Slot[] = runs.map(() => ({ state: "pending" }));
		let settled = 0;
		let decided = false;
		const decide = () => {
			if (decided) return;
			if (rule === "sole") {
				for (const s of slots) {
					if (s.state === "value" && s.value !== null) {
						decided = true;
						resolve(s.value);
						return;
					}
				}
			} else {
				for (const s of slots) {
					// An earlier partition that has not answered could still be the one that wins.
					if (s.state === "pending") break;
					if (s.state === "error") {
						decided = true;
						reject(s.error);
						return;
					}
					if (s.value !== null) {
						decided = true;
						resolve(s.value);
						return;
					}
				}
			}
			if (settled < slots.length) return;
			decided = true;
			const failed = slots.find((s) => s.state === "error");
			if (failed?.state === "error") reject(failed.error);
			else resolve(null);
		};
		runs.forEach((run, i) => {
			run.then(
				(value) => {
					slots[i] = { state: "value", value };
					settled += 1;
					decide();
				},
				(error: unknown) => {
					slots[i] = { state: "error", error };
					settled += 1;
					decide();
				},
			);
		});
		decide();
	});
}

/**
 * An engine object that did not answer in time, or kept failing with the platform's reset errors
 * after RemoteEngine's own retry. Worth trying ANOTHER object for; a query or store error is not.
 */
function isStuckEngine(err: unknown): boolean {
	return err instanceof EngineCallTimeoutError || isTransientEngineFailure(err);
}

export class PartitionedEngine implements Engine {
	/** Lazily created per-partition clients, so a single-card route builds one. */
	private readonly engines = new Map<number, RemoteEngine>();

	constructor(
		/** One RemoteEngine per partition index — the factory is index.ts's
		 * closure over placeEngineStub, the only allowed stub constructor. */
		private readonly engineFor: (partition: number) => RemoteEngine,
		/** The manifest this REQUEST is pinned to (isolate-cached, 60s). */
		private readonly manifest: StoreManifest,
		/** Fresh manifest for the stale-modulus retry (readManifest, cacheTtl 60). */
		private readonly reread: () => Promise<StoreManifest | null>,
		/** The build's id→partition hints, when this isolate has them (see
		 * liveRoutingFilter). Null means every bare-id route fans out, which is
		 * what the deployment did before the filter existed. */
		private routing: RoutingFilter | null = null,
		/** When `routing` is null (a fresh isolate): the colo copy, waited on for at most
		 * ROUTING_WAIT_MS by the first ROUTED lookup of this request (routingFilterSoon). */
		private awaitRouting: (() => Promise<RoutingFilter | null>) | null = null,
	) {}

	/** Before a routed lookup: take the filter from the colo if this request can still get it. */
	private async routed(): Promise<void> {
		if (this.routing !== null || this.awaitRouting === null) return;
		const wait = this.awaitRouting;
		this.awaitRouting = null;
		this.routing = await wait();
	}

	private get n(): number {
		return this.manifest.partition_count as number;
	}

	/**
	 * Partition RPCs this request has issued so far — every `at()` is exactly one call, before
	 * RemoteEngine's own transient retry. Read by the collection route's per-request log line.
	 */
	partitionCalls = 0;

	/**
	 * How many partitions this request's gathered search page asked (n15: the names index makes it
	 * fewer than N for a name-only filter, 0 for its 404), or null when it was not a gathered page
	 * or the coordinator did not say. Read by `/cards/search`'s per-miss log line.
	 */
	gatheredPartitions: number | null = null;

	/** n15: the stage the names index's fuzzy plan settled on, or null when no plan was used. */
	namedFuzzyPlanStage: string | null = null;

	/**
	 * x22: whether the fuzzy plan asked EVERY partition (the containment stage may need the foreign
	 * printed names the index does not carry), or null when no plan was used. Logged as `wide=`.
	 */
	namedFuzzyWide: boolean | null = null;

	/** x22: how many partitions' bundles the fuzzy merge read — the plan object's included. Logged as `bundles=`. */
	namedFuzzyBundles: number | null = null;

	/**
	 * x24: what the plan's printed-names blob said — "hit", "miss" or "absent" (see NamedFuzzyPlan) — or
	 * null when no plan was used or it never reached the printed tier. Logged as `printed=`.
	 */
	namedFuzzyPrinted: string | null = null;

	/**
	 * Whether this request's search was ANSWERED by one pinned partition — an oracle id's owner or a
	 * `!"Name"`'s sole partition — rather than by the gather. A pin that fell back (stale modulus, a
	 * stuck owner, an empty name-pinned page) is false. Read by `/cards/search`'s per-miss log line.
	 */
	pinnedAnswer = false;

	private at(partition: number): RemoteEngine {
		this.partitionCalls++;
		let e = this.engines.get(partition);
		if (!e) {
			e = this.engineFor(partition);
			this.engines.set(partition, e);
		}
		return e;
	}

	private all<T>(run: (e: RemoteEngine, p: number) => Promise<T>): Promise<T[]> {
		return Promise.all(Array.from({ length: this.n }, (_, p) => run(this.at(p), p)));
	}

	private firstNonNull<T>(run: (e: RemoteEngine) => Promise<T | null>, rule: FanOutAnswer): Promise<T | null> {
		// Parallel, then FIRST BY PARTITION ORDER (or the sole answer) — deterministic even in the
		// case of two answers, and resolved as soon as it is decided (firstDecided).
		return firstDecided(
			Array.from({ length: this.n }, (_, p) => run(this.at(p))),
			rule,
		);
	}

	/**
	 * `firstNonNull` with the routing filter in front of it: ask the ONE partition
	 * the filter names, and fan out to the rest only if that comes back empty.
	 *
	 * THE ANSWER IS IDENTICAL TO THE FAN-OUT'S, not merely equivalent. The filter
	 * stores the LOWEST partition owning a key, which is precisely the one
	 * `firstNonNull` would have picked, so a hinted hit resolves the same card as a
	 * full fan-out would — including for the 46 ids in the real corpus that two
	 * partitions both answer. A hinted MISS means the filter never saw this key
	 * (it is not in the build, or it collided), and the remaining partitions are
	 * then asked exactly as before: total RPCs 1 + (N-1) = N, never more than the
	 * fan-out it replaced.
	 */
	private async hinted<T>(
		key: string,
		run: (e: RemoteEngine) => Promise<T | null>,
		rule: FanOutAnswer = "lowest",
	): Promise<T | null> {
		await this.routed();
		const hint = this.routing?.lookup(key) ?? null;
		if (hint === null || hint >= this.n) return this.firstNonNull(run, rule);
		const first = await run(this.at(hint));
		if (first !== null) return first;
		const others = Array.from({ length: this.n }, (_, p) => p).filter((p) => p !== hint);
		return firstDecided(
			others.map((p) => run(this.at(p))),
			rule,
		);
	}

	// ── search / listing: one RPC to the gather, or ONE to the owning partition ──
	//
	// A query pinned to an oracle id (pinned-oracle.ts) is answered by that id's partition from
	// its own store: exact, and 1 Durable Object request instead of 1 + (N-1). That was 57% of
	// /cards/search on DeckGen (2026-09-21), ~220k of the day's 938k requests on the meter the free
	// plan binds first. The pin carries this isolate's partition count; an object cut at another
	// count refuses (StaleModulusError) and the gather, which re-runs at the loaded width, answers
	// instead — so a stale manifest can never turn into an empty page cached for 16 hours.

	/** The partition a query is pinned to, or null when it must fan out. */
	private pinnedPartition(opts: EngineSearchOptions): number | null {
		const oracleId = pinnedOracleId(opts.filterTreeJson);
		return oracleId === null ? null : partitionOfOracleId(oracleId, this.n);
	}

	/**
	 * The partition a `!"Name"` query is pinned to (backlog n6), or null: the one partition the
	 * routing filter says holds that name — a SOLE route only. A served route is not enough here: a
	 * search can reach the extras and the foreign printings the served rule says nothing about.
	 *
	 * The filter's word is exact only for a name it was built with, so the pinned answer is trusted
	 * only when it is NOT empty — a partition that returns rows for `!name` holds the name, so the
	 * key was real and no other partition holds it. An empty answer (a name no card has, or one the
	 * filter never held) is asked of the gather, which is what it cost before.
	 */
	private async pinnedNamePartition(opts: EngineSearchOptions): Promise<number | null> {
		const collated = pinnedExactName(opts.filterTreeJson);
		if (collated === null) return null;
		await this.routed();
		const hint = this.nameHintOf(collated);
		return hint !== null && "sole" in hint ? hint.sole : null;
	}

	private async pinnedOrGathered<T>(
		opts: EngineSearchOptions,
		pinned: (owner: RemoteEngine, partitionCount: number) => Promise<T>,
		gathered: (coordinator: RemoteEngine, gatherOpts: EngineSearchOptions) => Promise<T>,
		/** Whether a pinned answer found nothing — a NAME pin then gathers (see pinnedNamePartition). */
		empty: (answer: T) => boolean,
	): Promise<T> {
		const p = this.pinnedPartition(opts);
		if (p !== null) {
			try {
				const answer = await pinned(this.at(p), this.n);
				this.pinnedAnswer = true;
				return answer;
			} catch (err) {
				// A stale layout, or an owner that is not answering: the gather reaches the same rows.
				if (!(err instanceof StaleModulusError) && !isStuckEngine(err)) throw err;
				console.warn(`pinned search not answered by partition ${p} (${err}); gathering instead`);
			}
		} else {
			const named = await this.pinnedNamePartition(opts);
			if (named !== null) {
				try {
					const answer = await pinned(this.at(named), this.n);
					if (!empty(answer)) {
						this.pinnedAnswer = true;
						return answer;
					}
				} catch (err) {
					if (!(err instanceof StaleModulusError) && !isStuckEngine(err)) throw err;
					console.warn(`name-pinned search not answered by partition ${named} (${err}); gathering instead`);
				}
			}
		}
		const coordinator = gatherPartitionOf(opts.filterTreeJson, this.n);
		// n15: the build this request is pinned to rides along, so the coordinator may answer a
		// name-only filter from its names index — only when it has loaded this very build.
		const gatherOpts: EngineSearchOptions = cardNamesOf(this.manifest)
			? { ...opts, namesBuild: String(this.manifest.built_at ?? "") }
			: opts;
		try {
			return await gathered(this.at(coordinator), gatherOpts);
		} catch (err) {
			// The coordinator is chosen from the query text, so every repeat of a query goes to the SAME
			// object: one object that has stopped answering would take that query down until the next
			// deploy. Any partition can coordinate a gather, so the next one takes over — once.
			if (this.n < 2 || !isStuckEngine(err)) throw err;
			const next = (coordinator + 1) % this.n;
			console.warn(`gather coordinator partition ${coordinator} not answering (${err}); failing over to ${next}`);
			return gathered(this.at(next), gatherOpts);
		}
	}

	searchCardsAsObjects(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		return this.pinnedOrGathered(
			opts,
			(owner, n) => owner.searchCardsAsObjects(opts, n),
			(c, o) => c.gatherSearchAsObjects(o),
			(r) => r.totalCards === 0,
		);
	}

	searchCardsAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		return this.pinnedOrGathered(
			opts,
			(owner, n) => owner.searchCardsAsJson(opts, shape, n),
			(c, o) => c.gatherSearchAsJson(o, shape),
			(r) => r.totalCards === 0,
		);
	}

	/**
	 * See Engine.searchCardsAtAddress: one local search, not the gather, on the partition the routing
	 * filter names for `addressKey` (the site's card page, src/routes/card-embed.ts). Pinned to this
	 * request's partition count like an oracle pin, so an object cut at another count refuses rather
	 * than answering from rows the hint was not computed for — and that refusal, or an object not
	 * answering, is null: the caller runs the whole search, which is what it cost before.
	 */
	async searchCardsAtAddress(
		opts: EngineSearchOptions,
		shape: ResultShape,
		addressKey: string,
	): Promise<EngineSerializedResult | null> {
		await this.routed();
		const hint = this.routing?.lookup(addressKey) ?? null;
		if (hint === null || hint >= this.n) return null;
		try {
			return await this.at(hint).searchCardsAsJson(opts, shape, this.n);
		} catch (err) {
			if (!(err instanceof StaleModulusError) && !isStuckEngine(err)) throw err;
			console.warn(`address search not answered by partition ${hint} (${err}); searching everywhere instead`);
			return null;
		}
	}

	scryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult> {
		return this.pinnedOrGathered(
			opts,
			(owner, n) => owner.scryfallSearch(opts, baseUrl, n),
			(c, o) => c.gatherScryfallSearch(o, baseUrl),
			(r) => r.totalCards === 0,
		);
	}

	scryfallSearchPage(
		opts: EngineSearchOptions,
		baseUrl: string,
		envelope: SearchPageEnvelope,
		cache: Record<string, string>,
	): Promise<Response> {
		return this.pinnedOrGathered(
			opts,
			(owner, n) => owner.scryfallSearchPage(opts, baseUrl, envelope, cache, "cards", n),
			async (c, o) => {
				const page = await c.scryfallSearchPage(o, baseUrl, envelope, cache, "cards2");
				this.gatheredPartitions = c.gatheredPartitions;
				return page;
			},
			// A no-match page is Scryfall's 404 (`emptyPageResponse`); a page past the end of real
			// matches is a 422, which only a partition holding the name can say.
			(r) => r.status === 404,
		);
	}

	// ── catalogs and counts: the colo's copy, else sum the partitions ────────────

	async cardTypeCounts(): Promise<Record<string, number>> {
		return (await this.catalogTables()).types;
	}

	async cardKeywordCounts(): Promise<Record<string, number>> {
		return (await this.catalogTables()).keywords;
	}

	setsWithExtras(): Promise<string[]> {
		return this.catalogTables().then((t) => t.setsWithExtras);
	}

	/** See CATALOG_TABLES for the tiers. */
	private catalogTables(): Promise<CatalogTables> {
		const key = this.manifest.store_key;
		const cached = CATALOG_TABLES.get(key);
		if (cached) return cached;
		const fanOut = async (): Promise<CatalogTables> => {
			const parts = await this.all(async (e) => ({
				types: await e.cardTypeCounts(),
				keywords: await e.cardKeywordCounts(),
				setsWithExtras: await e.setsWithExtras(),
			}));
			return {
				types: sumCounts(parts.map((p) => p.types)),
				keywords: sumCounts(parts.map((p) => p.keywords)),
				setsWithExtras: [...new Set(parts.flatMap((p) => p.setsWithExtras))].sort(),
			};
		};
		const pending = (async (): Promise<CatalogTables> => {
			let fromFanOut: CatalogTables | null = null;
			const bytes = await readThroughEdgeCache(edgeCacheUrl(`catalog:${key}`), CATALOG_EDGE_TTL_S, async () => {
				fromFanOut = await fanOut();
				return catalogText.encoder.encode(JSON.stringify(fromFanOut));
			});
			if (fromFanOut) return fromFanOut;
			// A colo entry that is not the shape (or is unreadable) is a miss: ask the partitions.
			return (bytes && parseCatalogTables(bytes)) ?? (await fanOut());
		})().catch((err) => {
			CATALOG_TABLES.delete(key);
			throw err;
		});
		CATALOG_TABLES.set(key, pending);
		return pending;
	}

	async cardCount(): Promise<number> {
		return (await this.all((e) => e.cardCount())).reduce((s, c) => s + c, 0);
	}

	// ── random: one partition, weighted by its share of the cards ───────────────
	//
	// THE WEIGHT IS `card_count`, AND A FILTER DOES NOT CHANGE THAT — a deliberate choice, not an
	// oversight carried over from the unfiltered draw. Weighting by cards is exactly right for an
	// unfiltered sample and only approximately right for a filtered one: partition p should be
	// picked in proportion to its share of the MATCHES, not of the cards, and the two differ by
	// however much the filter's density varies across partitions.
	//
	// MEASURED, on the built corpus (generation 36, N=10, 38,626 cards): the extras gate — the one
	// filter this route sends — admits 86.99% of cards overall and between 86.29% and 87.93% per
	// partition, so the worst partition's weight is off by 1.07% RELATIVE. It is that small by
	// construction rather than by luck: partitioning is `fnv1a64(oracle_id) % N`, and nothing about
	// being a token or an art-series card correlates with an oracle id's hash.
	//
	// THE ALTERNATIVE WAS PRICED AND REJECTED. Correcting the weight means learning each
	// partition's match count, which is an N-way count fan-out: 10 RPCs before the draw plus 1 to
	// take it, on a route the front page calls on every load, against a free-tier budget where
	// Durable Object requests are the metered resource. Eleven RPCs to remove a 1% weighting error
	// is the wrong trade, and it would be the wrong trade even if the error were 5%.
	//
	// WHERE IT WOULD BE WRONG: a filter whose density varies by partition — a set-scoped or
	// name-scoped one, where whole partitions can hold no match at all. Such a partition returns
	// FEWER rows than asked (the engine samples the matches it has) rather than wrong ones, so the
	// failure is visible in the count instead of silent in the distribution. No caller sends one
	// today; `/cards/random` is the route for a user query, and it counts before it draws.
	private weightedPartition(): number {
		const parts = this.manifest.partitions ?? [];
		const total = parts.reduce((s, p) => s + p.card_count, 0);
		let at = Math.random() * total;
		for (let p = 0; p < parts.length; p++) {
			at -= parts[p]?.card_count ?? 0;
			if (at < 0) return p;
		}
		return parts.length - 1;
	}

	randomCardsAsObjects(
		numCards: number,
		fields: string[],
		filterTreeJson?: string,
	): Promise<Record<string, unknown>[]> {
		return this.at(this.weightedPartition()).randomCardsAsObjects(numCards, fields, filterTreeJson);
	}

	randomCardsAsJson(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		filterTreeJson?: string,
	): Promise<EngineSerializedResult> {
		return this.at(this.weightedPartition()).randomCardsAsJson(numCards, fields, shape, filterTreeJson);
	}

	// ── bare-UUID and external ids: ONE RPC when the filter knows the id ────────
	//
	// A bare printing UUID cannot name its oracle partition arithmetically (plan
	// B5 called this out and priced the exact map at ~9MB×N), so these routes used
	// to cost N billed RPC sessions each to find one card. The routing filter is
	// the same answer at 740KB total, and it is a HINT: a miss falls back to the
	// fan-out, so the worst case is what the best case used to be.

	scryfallCardById(scryfallId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		return this.hinted(scryfallIdKey(scryfallId), (e) => e.scryfallCardById(scryfallId, baseUrl));
	}

	scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
	): Promise<Record<string, unknown> | null> {
		return this.hinted(externalIdKey(namespace, externalId), (e) =>
			e.scryfallCardByExternalId(namespace, externalId, baseUrl),
		);
	}

	// ── collection batches: one batch RPC per partition, merged per-position ────

	async scryfallFirstOfEach(
		filterTreeJsons: string[],
		baseUrl: string,
		addressKey?: string,
	): Promise<(Record<string, unknown> | null)[]> {
		if (addressKey !== undefined) {
			// Every printing at one address lives in one partition, so the partition holding a card
			// for ANY of the trees holds the whole answer: the routed partition first, the rest only
			// if it has none — one call for `/cards/:set/:number`, where every one was N.
			//
			// And because only that one partition CAN answer, a fan-out (no filter yet, or a hint that
			// missed) takes the first answer that arrives rather than waiting on every partition: an
			// object that is slow or not answering cannot fail a lookup it has no part in ("sole").
			const found = await this.hinted(
				addressKey,
				async (e) => {
					const cards = await e.scryfallFirstOfEach(filterTreeJsons, baseUrl);
					return cards.some((card) => card !== null) ? cards : null;
				},
				"sole",
			);
			return found ?? filterTreeJsons.map(() => null);
		}
		const perPartition = await this.all((e) => e.scryfallFirstOfEach(filterTreeJsons, baseUrl));
		return filterTreeJsons.map((_, i) => {
			for (const cards of perPartition) {
				const card = cards[i];
				if (card !== null && card !== undefined) return card;
			}
			return null;
		});
	}

	// ── the name routes: fan out and combine (see header for the fuzzy caveat) ──

	async scryfallFuzzyName(name: string, baseUrl: string, setCode = ""): Promise<ScryfallFuzzyResult> {
		const race = raceFuzzyCandidates(await this.all((e) => e.fuzzyCandidates(name, setCode)), FUZZY_SIMILARITY_LEAD);
		if (race.status !== "hit" || race.winner === undefined) return { status: race.status, card: null };
		// One more RPC to the winning partition materializes the card: its local race is a
		// sub-race of the global one the winner just led by >= lead, so it resolves the same hit.
		return this.at(race.winner).scryfallFuzzyName(name, baseUrl, setCode);
	}

	async scryfallExactName(folded: string, setCode: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		// RANK EVERY PARTITION, AND TAKE THE WINNER'S CARD — the same shape as the fuzzy race above,
		// and for the same reason.
		//
		// This used to be `firstNonNull`, on the premise that "a folded name identifies an oracle
		// card, and an oracle card lives in exactly one partition — so at most one partition
		// answers". THAT PREMISE WAS FALSE, and had been since `exact_card_by_name` learned to
		// match FACE names and FLAVOR names: a needle is very often one card's whole name and
		// another card's face name, and those two cards hash apart. So several partitions answer,
		// and taking the first in partition order threw away the ranking the engine had just
		// computed — the ranking whose entire purpose is that `exact=Lightning Bolt` must not
		// answer `Emeritus of Conflict // Lightning Bolt`.
		//
		// Measured on the ten-partition store, 2026-08-17, against api.scryfall.com — and against
		// the single-archive production deployment, which answers all four correctly because there
		// the ranking was global by construction:
		//
		//   exact=Ancestral Recall  ours Emeritus of Ideation // Ancestral Recall  want Ancestral Recall
		//   exact=Brainstorm        ours Harmonized Trio // Brainstorm             want Brainstorm
		//   exact=Fire              ours Start // Fire                             want Fire // Ice
		//   exact=Delver of Secrets ours Delver of Secrets // Delver of Secrets    want ... // Insectile
		//                                                                          Aberration
		//
		// The last two are why a "whole name?" boolean is not enough to merge on: neither
		// candidate is a whole-name match, so the answer turns on prefer_score — which only the
		// owning partition can compute. `Delver of Secrets // Delver of Secrets` is a real
		// art_series card, correctly ingested; it simply must not outrank the card itself.
		//
		// PROBE FIRST (backlog n6). Each partition answers with a PROBE — its rank, its local
		// winner's card and whether it holds the name at all — so the fan-out is N calls where
		// rank-then-materialize was N + 1. And when the routing filter knows the name, the one
		// partition it names is asked first: its reply alone is the answer whenever it settles the
		// name (`nameReplySettles`) — ONE call for a name only one partition holds, and for a name
		// several hold but only one holds SERVED and no other holds on a higher tier, which is every
		// popular card whose name an art-series card shares. Otherwise the rest are asked and every
		// reply merged in partition order, the hinted one included: exactly the fan-out's answer.
		await this.routed();
		const hint = this.nameHintOf(folded);
		const probe = (p: number) => this.probeExactName(p, folded, setCode, baseUrl);
		const replies: (ExactNameProbe | null)[] = new Array(this.n).fill(null);
		let asked = Array.from({ length: this.n }, (_, p) => p);
		if (hint !== null) {
			const first = hintPartition(hint);
			const reply = await probe(first);
			if (nameReplySettles(hint, reply.rank, reply.present)) return reply.card;
			replies[first] = reply;
			asked = asked.filter((p) => p !== first);
		}
		await Promise.all(
			asked.map(async (p) => {
				replies[p] = await probe(p);
			}),
		);
		let best: NameRank | null = null;
		let card: Record<string, unknown> | null = null;
		for (const reply of replies) {
			// Strictly greater, so an exact tie keeps the LOWEST partition index — the same
			// deterministic tiebreak firstNonNull gave, preserved for the ties it did decide.
			if (reply !== null && reply.rank !== null && beatsExactRank(reply.rank, best)) {
				best = reply.rank;
				card = reply.card;
			}
		}
		return card;
	}

	/** One partition's exact-name probe — RemoteEngine answers it through the old two calls for an
	 * object still on the previous build. */
	private probeExactName(p: number, folded: string, setCode: string, baseUrl: string): Promise<ExactNameProbe> {
		return this.at(p).scryfallExactNameProbe(folded, setCode, baseUrl);
	}

	/** The routing filter's word on a folded name, or null to ask every partition (see `nameKey`). */
	private nameHintOf(folded: string): NameHint | null {
		if (this.routing === null || !this.routing.hasNameKeys) return null;
		const key = nameKey(folded);
		return key === null ? null : this.routing.lookupName(key);
	}

	/** The best rank any partition holds — the whole store's answer, for an Engine asked directly. */
	async scryfallExactNameRank(folded: string, setCode: string): Promise<NameRank | null> {
		const ranks = await this.all((e) => e.scryfallExactNameRank(folded, setCode));
		let best: NameRank | null = null;
		for (const rank of ranks) {
			if (rank !== null && beatsExactRank(rank, best)) {
				best = rank;
			}
		}
		return best;
	}

	/** Rounds of partition calls this request's collection batch took — the route's log line. */
	collectionRounds = 0;

	/**
	 * A whole collection batch in ONE round of at most N calls — see Engine.scryfallCollectionBatch.
	 * The per-kind methods it replaced (b9bc501) spent up to 2N on the names (rank, then materialize
	 * the winners), N on the `{set, collector_number}` trees and up to N on the keys, each its own
	 * fan-out.
	 *
	 * WHICH partitions are called: the ones the identifiers are ROUTED to — a key by the oracle
	 * modulus or the routing filter, a tree by its address's `setNumberKey`, a name by its
	 * `nameKey` (the one partition holding the name, or the one holding it served) — and every one
	 * if anything has no route. EVERY called partition is sent EVERY key and tree: each is one probe
	 * or one narrow query, so a partition being called anyway answers the rest for free, and
	 * whatever misses then needs only the partitions nobody called. A lone `{set,
	 * collector_number}` — 74% of DeckGen's collection POSTs on 2026-09-24 — is therefore one call,
	 * where it was N.
	 *
	 * NAMES ARE NOT SPRAYED LIKE KEYS: a routed name goes to its own partition only, an unrouted one
	 * to all of them. A name is the one identifier whose lookup is real work (a trigram scan and a
	 * card built in every partition holding a match), so a 50-name batch — mtg-seeker's shape —
	 * costs ~50 name lookups where it cost 50 × N. The call count barely moves for such a batch
	 * (fifty names hash across nearly every partition anyway); a small one drops to the partitions
	 * its names live in. A routed name's reply must SETTLE it (`nameReplySettles`); one that does
	 * not — a hint from a key the filter never held, a served partition answering only an extra —
	 * is asked of every other partition in the repair round, and then ALL its replies are merged
	 * in partition order, exactly as if it had been asked everywhere at once. The one exception is
	 * a SERVED-routed name under a scope filter or a set, whose route can miss for want of a
	 * passing printing: it rides every round-1 call instead, so a scoped deck list that misses most
	 * of its names is still one round (see `riding` below).
	 *
	 * The merge keeps the rules the per-kind methods had:
	 *   - keys and trees: the first card in PARTITION ORDER — a hint names the lowest owning
	 *     partition, so a hinted hit is the card a full fan-out's first-non-null picks
	 *   - names: the best rank, strictly greater so a tie keeps the lowest partition, and THAT
	 *     partition's card, which is what its materialize round would have returned: the engine
	 *     ranks and picks a name by the same `name_best`
	 * then the repair rounds, both rare by construction: an oracle miss re-reads the manifest and
	 * asks the new owner if N moved, and a routed key or name — or an address none of whose trees
	 * hit — asks only the partitions round 1 did not ask it of. A hint from another build, or a
	 * lookup of something the filter never held, costs that second round; it can never cost a
	 * wrong answer.
	 */
	async scryfallCollectionBatch(
		batch: CollectionBatch,
		baseUrl: string,
		scope?: CollectionScope | null,
	): Promise<CollectionBatchAnswer> {
		const out = emptyCollectionAnswer(batch);
		await this.routed();
		const hintOf = (routingKey: string, n: number): number | null => {
			const hint = this.routing?.lookup(routingKey) ?? null;
			return hint === null || hint >= n ? null : hint;
		};
		const targetOf = (key: CollectionBatchKey, n: number): number | null => {
			if (key.kind === "oracle_id") return partitionOfOracleId(key.id, n);
			return hintOf(
				key.kind === "scryfall_id"
					? scryfallIdKey(key.id)
					: key.kind === "illustration_id"
						? illustrationIdKey(key.id)
						: externalIdKey(key.namespace, key.id),
				n,
			);
		};
		// Each name's route, and every reply it gets, whichever round: merged at the end, in
		// partition order.
		const nameHints = batch.names.map(({ folded }) => this.nameHintOf(folded));
		const nameReplies: { p: number; rank: NameRank | null; card: Uint8Array | null; present: boolean }[][] =
			batch.names.map(() => []);
		// Which partitions each name has been asked of, whichever round — a name is never asked of
		// one twice, and one asked of all N is settled by construction.
		const nameAsked = batch.names.map(() => new Set<number>());
		// A SERVED-routed name rides every round-1 call when its route can MISS: under a scope FILTER
		// or a set, the served partition may hold no printing that passes, and its miss proves nothing
		// about the extras-only cards of the name the other partitions hold (`nameReplySettles`) — so
		// the repair round would ask them anyway. Measured on DeckGen 09-26: `?q=(is:commander)` and
		// `?q=t:"creature" ...` batches of 60–75 names missed 46–70 of them, one served name among the
		// misses sent the whole batch to a second round, and 515 of 841 such batches cost 19–20
		// calls on ten partitions where the same batches unscoped cost 10. Riding round 1 costs a name
		// lookup per partition already being called and no call; a served name WITHOUT a filter or
		// set always settles on its route (the served card is there to answer), so it stays routed.
		const nameCanMiss = (i: number) => (scope?.filterTreeJson ?? null) !== null || batch.names[i]?.setCode !== "";
		const riding = batch.names.map((_, i) => {
			const hint = nameHints[i] ?? null;
			return hint !== null && !("sole" in hint) && nameCanMiss(i);
		});
		type Ask = { p: number; keyAt: number[]; treeAt: number[]; nameAt: number[] };
		const ask = (asks: Ask[]) => {
			if (asks.length > 0) this.collectionRounds++;
			return Promise.all(
				asks.map(async ({ p, keyAt, treeAt, nameAt }) => {
					const sub: CollectionBatch = {
						keys: keyAt.map((i) => batch.keys[i] as CollectionBatchKey),
						trees: treeAt.map((i) => batch.trees[i] as string),
						names: nameAt.map((i) => batch.names[i] as NameIdentifier),
					};
					// Presence settles a routed name's MISS (`nameReplySettles`); only a sole route reads it.
					if (nameAt.some((i) => soleHint(nameHints[i] ?? null) === p)) sub.presence = true;
					for (const i of nameAt) nameAsked[i]?.add(p);
					return { p, keyAt, treeAt, nameAt, answer: await this.at(p).scryfallCollectionBatch(sub, baseUrl, scope) };
				}),
			);
		};
		const fill = (replies: Awaited<ReturnType<typeof ask>>) => {
			for (const { p, keyAt, treeAt, nameAt, answer } of replies) {
				for (const [j, i] of keyAt.entries()) if (out.keys[i] === null) out.keys[i] = answer.keys[j] ?? null;
				for (const [j, i] of treeAt.entries()) if (out.trees[i] === null) out.trees[i] = answer.trees[j] ?? null;
				for (const [j, i] of nameAt.entries()) {
					nameReplies[i]?.push({
						p,
						rank: answer.nameRanks[j] ?? null,
						card: answer.names[j] ?? null,
						present: answer.namePresent?.[j] ?? false,
					});
				}
			}
		};
		const allKeys = batch.keys.map((_, i) => i);
		const allTrees = batch.trees.map((_, i) => i);
		const unroutedNames = batch.names.flatMap((_, i) => (nameHints[i] === null ? [i] : []));

		// Round 1: the routed partitions, or all of them.
		let everywhere = unroutedNames.length > 0;
		const called = new Set<number>();
		const route = (target: number | null) => {
			if (target === null) everywhere = true;
			else called.add(target);
		};
		for (const hint of nameHints) if (hint !== null) called.add(hintPartition(hint));
		if (!everywhere) {
			for (const key of batch.keys) route(targetOf(key, this.n));
			for (const [i] of batch.trees.entries()) {
				const address = batch.treeAddresses?.[i];
				route(address ? hintOf(address, this.n) : null);
			}
		}
		const askedIn1 = (p: number) => everywhere || called.has(p);
		// Every partition round 1 calls: an unrouted name's, a routed name's own, and a riding name's.
		const namesFor = (p: number) =>
			batch.names.flatMap((_, i) => {
				const hint = nameHints[i] ?? null;
				return hint === null || hintPartition(hint) === p || riding[i] ? [i] : [];
			});
		fill(
			await ask(
				Array.from({ length: this.n }, (_, p) => p)
					.filter(askedIn1)
					.map((p) => ({ p, keyAt: allKeys, treeAt: allTrees, nameAt: namesFor(p) })),
			),
		);

		// An oracle id that missed its owner is not in the store at this N; if N has moved, it may
		// be in its NEW owner, which round 1 did not ask when that owner is past the old count.
		const oracleMissed = batch.keys.flatMap((key, i) => (key.kind === "oracle_id" && out.keys[i] === null ? [i] : []));
		if (oracleMissed.length > 0) {
			const freshN = (await this.reread())?.partition_count;
			if (freshN !== undefined && freshN !== this.n) {
				const regrouped = new Map<number, number[]>();
				for (const i of oracleMissed) {
					const p2 = targetOf(batch.keys[i] as CollectionBatchKey, freshN) as number;
					if (p2 >= this.n || !askedIn1(p2)) regrouped.set(p2, [...(regrouped.get(p2) ?? []), i]);
				}
				const asks = [...regrouped]
					.sort(([a], [b]) => a - b)
					.map(([p, keyAt]) => ({ p, keyAt, treeAt: [], nameAt: [] }));
				fill(await ask(asks));
			}
		}

		// Anything else that missed was routed somewhere it is not (a filter from another build, a
		// collision, or a lookup of something that does not exist): it can only be in a partition
		// round 1 did not ask. A tree misses only as an ADDRESS — the English tree of an address
		// with no English printing misses while its lang-less twin hits, and that is an answer. A
		// routed name is unsettled when its route's reply does not prove the filter's word
		// (`nameReplySettles`), and is then asked of every partition that has not answered it yet —
		// none, for a name round 1 already asked of all N.
		const keyAt = everywhere
			? []
			: batch.keys.flatMap((key, i) => (key.kind !== "oracle_id" && out.keys[i] === null ? [i] : []));
		const answered = new Set(
			allTrees.filter((i) => out.trees[i] !== null).map((i) => batch.treeAddresses?.[i] ?? null),
		);
		const treeAt = everywhere ? [] : allTrees.filter((i) => !answered.has(batch.treeAddresses?.[i] ?? null));
		const unsettled = batch.names.flatMap((_, i) => {
			const hint = nameHints[i] ?? null;
			if (hint === null || (nameAsked[i]?.size ?? 0) >= this.n) return [];
			const route = hintPartition(hint);
			const reply = nameReplies[i]?.find((r) => r.p === route);
			return reply !== undefined && nameReplySettles(hint, reply.rank, reply.present) ? [] : [i];
		});
		if (keyAt.length > 0 || treeAt.length > 0 || unsettled.length > 0) {
			const asks = Array.from({ length: this.n }, (_, p) => p)
				.map((p) => ({
					p,
					keyAt: askedIn1(p) ? [] : keyAt,
					treeAt: askedIn1(p) ? [] : treeAt,
					nameAt: unsettled.filter((i) => !nameAsked[i]?.has(p)),
				}))
				.filter((a) => a.keyAt.length > 0 || a.treeAt.length > 0 || a.nameAt.length > 0);
			fill(await ask(asks));
		}

		for (const [i, replies] of nameReplies.entries()) {
			replies.sort((a, b) => a.p - b.p);
			for (const { rank, card } of replies) {
				if (rank !== null && beatsExactRank(rank, out.nameRanks[i] ?? null)) {
					out.nameRanks[i] = rank;
					out.names[i] = card;
				}
			}
		}
		return out;
	}

	/**
	 * ONE object answers (n8): any partition can, because it answers from the build's card-names
	 * blob — every served name of the corpus — rather than from its own archive, with a line-for-line
	 * copy of the engine's ranking (engine/wasm/src/names.rs), so the answer is the merge's, byte for
	 * byte. Which object is a function of the prefix alone, like the gather coordinator: the same
	 * keystroke always lands on the same object, and a prefix's traffic spreads across the N.
	 *
	 * The fan-out below is what answers when there is no blob to answer from — a manifest published
	 * before n8 names none (cardNamesOf), an object on the build before this one has no such method —
	 * or when the one object cannot (a blob missing from KV, a stuck object): 1 + N calls, never a
	 * different answer.
	 */
	async scryfallAutocomplete(prefix: string, limit: number): Promise<string[]> {
		if (cardNamesOf(this.manifest)) {
			const p = gatherPartitionOf(`autocomplete:${prefix}`, this.n);
			try {
				return await this.at(p).scryfallAutocompleteNames(prefix, limit);
			} catch (err) {
				console.warn(`autocomplete not answered from partition ${p}'s card names (${err}); asking every partition`);
			}
		}
		return mergeAutocomplete(await this.all((e) => e.scryfallAutocomplete(prefix, limit)), prefix, limit);
	}

	async scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
	): Promise<Record<string, unknown>[]> {
		// The caller asks for 2 and reads ≥2 DISTINCT NAMES as ambiguous; distinct
		// names survive a cross-partition dedupe, so the semantics carry over.
		return mergeContained(
			await this.all((e) => e.scryfallNamesContaining(words, setCode, limit, baseUrl)),
			words,
			limit,
		);
	}

	/**
	 * `/cards/named?fuzzy=` in ONE round (backlog n7): one bundle per partition — its exact probe,
	 * its typo candidates and local race, and its containment matches, each skipped where it cannot
	 * matter (see NamedFuzzyBundle) — merged by `mergeNamedFuzzyBundles` under exactly the rules the
	 * three stages apply one after another (`resolveNamedFuzzyStaged`). Those spent up to 3N + 1
	 * calls over as many as five sequential waits: the exact probes (a routed name first, then the
	 * rest), every partition's candidates, the winner's materialize, then every partition's
	 * containment. This is N calls in one wait.
	 *
	 * A name the routing filter places is asked of its partition FIRST, exactly as
	 * `scryfallExactName` asks it (backlog n6): when that one reply settles the name with a card,
	 * it is the answer — ONE call for an exact name. Anything else — a typo, a set-restricted miss,
	 * a garbage hint — asks the rest in one more round and merges every reply, the routed one
	 * included.
	 *
	 * A combination of replies the merge cannot read (a stage a partition skipped turning out to be
	 * needed, which the skip rules make impossible) is answered by the three stages, logged.
	 */
	async scryfallNamedFuzzy(
		folded: string,
		words: string[],
		setCode: string,
		baseUrl: string,
	): Promise<NamedFuzzyAnswer> {
		await this.routed();
		const hint = this.nameHintOf(folded);
		const bundle = (p: number) =>
			this.at(p).scryfallNamedFuzzyBundle(folded, setCode, words, NAMED_CONTAINMENT_LIMIT, baseUrl);
		const replies: (NamedFuzzyBundle | undefined)[] = new Array(this.n);
		// A routed MISS the hint settles is the exact stage's answer too (`scryfallExactName` returns
		// it without asking further), so the other partitions' ranks are not consulted.
		let exactSettledMiss = false;
		this.namedFuzzyWide = null;
		this.namedFuzzyBundles = null;
		this.namedFuzzyPrinted = null;
		if (hint !== null) {
			const first = hintPartition(hint);
			const reply = await bundle(first);
			if (nameReplySettles(hint, reply.exact.rank, reply.exact.present)) {
				if (reply.exact.rank !== null && reply.exact.card !== null) {
					this.namedFuzzyBundles = 1;
					return { status: "card", card: reply.exact.card };
				}
				exactSettledMiss = reply.exact.rank === null;
			}
			replies[first] = reply;
		}
		// n15: ONE object's names index names the partitions whose bundles can change the answer; every
		// other partition's bundle is read as answering nothing (EMPTY_NAMED_FUZZY_BUNDLE), which the
		// plan proves it would. No plan (no index, a set scope, an object that cannot say): all of them.
		// x22: the plan object answers its own bundle in the plan's call when the plan names it.
		const plan = setCode === "" ? await this.namedFuzzyPlan(folded, words, replies, baseUrl) : null;
		const wanted = plan === null || plan.everywhere ? Array.from({ length: this.n }, (_, p) => p) : plan.partitions;
		this.namedFuzzyWide = plan === null ? null : plan.everywhere;
		await Promise.all(
			wanted
				.filter((p) => replies[p] === undefined)
				.map(async (p) => {
					replies[p] = await bundle(p);
				}),
		);
		this.namedFuzzyBundles = replies.filter((r) => r !== undefined).length;
		// Array.from, not map: `replies` is sparse, and map skips its holes.
		const filled = Array.from({ length: this.n }, (_, p) => replies[p] ?? EMPTY_NAMED_FUZZY_BUNDLE);
		const merged = mergeNamedFuzzyBundles(filled, words, NAMED_CONTAINMENT_LIMIT, exactSettledMiss);
		if (merged !== null) return merged;
		console.warn("named fuzzy: the bundles do not combine; asking the three stages instead");
		return resolveNamedFuzzyStaged(this, folded, words, setCode, baseUrl);
	}

	/**
	 * n15: the fuzzy plan for a needle from ONE object's names index — which object, a function of the
	 * needle, like the gather coordinator — or null to ask every partition: the manifest names no
	 * names blob, the object cannot plan (a format-1 blob, the build before n15, a stuck object), or
	 * it planned from another build than this request's (partition numbers mean nothing across builds).
	 *
	 * x22: the plan object is a partition object, so it is asked for its OWN bundle in the same call
	 * (unless `replies` already holds it, from the routed probe), and answers it when its plan names
	 * it: the bundle is filled into `replies` here, and the fan-out skips it. An `everywhere` plan —
	 * a needle only the foreign printed names could answer, which the index does not carry, and so
	 * every miss — is N calls in all where it was N + 1. A bundle rides only an ACCEPTED plan: one
	 * from another build numbers its partitions differently.
	 */
	private async namedFuzzyPlan(
		folded: string,
		words: string[],
		replies: (NamedFuzzyBundle | undefined)[],
		baseUrl: string,
	): Promise<NamedFuzzyPlan | null> {
		if (!cardNamesOf(this.manifest)) return null;
		const p = gatherPartitionOf(`named:${folded}`, this.n);
		const own = replies[p] === undefined ? { partition: p, limit: NAMED_CONTAINMENT_LIMIT, baseUrl } : undefined;
		try {
			const plan = await this.at(p).scryfallNamedFuzzyPlan(folded, words, own);
			if (plan.builtAt !== String(this.manifest.built_at ?? "")) return null;
			if (plan.partitions.some((q) => !Number.isInteger(q) || q < 0 || q >= this.n)) return null;
			this.namedFuzzyPlanStage = plan.stage;
			this.namedFuzzyPrinted = plan.printed ?? null;
			if (own !== undefined && plan.bundle !== undefined) replies[p] = plan.bundle;
			return plan;
		} catch (err) {
			console.warn(`named fuzzy: no plan from partition ${p}'s names index (${err}); asking every partition`);
			return null;
		}
	}
}

/**
 * A partition's bundle when it holds nothing the needle could match: no exact rank, a typo miss with
 * no candidates, no containment match — exactly what `named_fuzzy_bundle` answers from a partition
 * holding no such card. Stands in for every partition a names-index plan leaves out (n15).
 */
export const EMPTY_NAMED_FUZZY_BUNDLE: NamedFuzzyBundle = Object.freeze({
	exact: { rank: null, present: false, card: null },
	fuzzy: { status: "miss", card: null },
	candidates: [],
	contained: [],
}) as NamedFuzzyBundle;

/**
 * The containment stage's cross-partition merge: one card per distinct name, in partition order —
 * the caller asks for 2 and reads ≥2 DISTINCT NAMES as ambiguous, and distinct names survive a
 * cross-partition dedupe, so the semantics carry over — with the whole-name rank re-applied.
 */
export function mergeContained(
	perPartition: Record<string, unknown>[][],
	words: string[],
	limit: number,
): Record<string, unknown>[] {
	const byName = new Map<string, Record<string, unknown>>();
	for (const cards of perPartition) {
		for (const card of cards) {
			const key = String(card.name ?? "");
			if (!byName.has(key)) byName.set(key, card);
		}
	}
	// THE WHOLE-NAME RANK, re-applied globally. Each partition already prefers a name that IS
	// the query over one that merely carries its letters (the engine's containment rule), but
	// that ranking is LOCAL: `fuzzy=blitzschlag` puts the German printing of Lightning Bolt in
	// one archive and some other card whose name contains those letters in another, and a
	// dedupe that only counts distinct names reads the pair as ambiguous — where Scryfall, and
	// a single store, answer the card the query names. Folded here because the card object
	// carries the name as PRINTED, while the engine matched the folded form.
	//
	// THE ENGLISH TIER, re-applied globally for the same reason, and AHEAD of the whole-name rank:
	// each partition answers its printed-name matches — a printed name that IS the query included
	// — only when no oracle or flavor name of its own carries the words (core_api's
	// `cards_containing_all_words`), but a partition cannot see that ANOTHER one did. `fuzzy=spirit
	// ugin` puts Ugin, the Spirit Dragon in one archive and Ugin's Conjurant — whose Spanish name,
	// "Espíritu conjurado de Ugin", carries both words — in another, and `fuzzy=inganno` puts
	// Wedding Announcement in one and Guile, whose Italian name IS "Inganno", in another;
	// api.scryfall.com answers the English card both times. An answer is English when its oracle
	// and flavor names alone carry every word, which is exactly the set the engine's first tier
	// admits; the whole-name rank then runs within the tier that answers. A flavor name is the
	// printing's KEY (`flavorKeyOf`), which for a printing whose faces carry them is their join.
	const cards = [...byName.values()];
	const whole = words.map(unseparated).join("");
	const needles = words.map(unseparated).filter((w) => w.length > 0);
	const english = cards.filter((card) => {
		const pool = [card.name, flavorKeyOf(card)].map((n) => (typeof n === "string" ? unseparated(n) : ""));
		return needles.every((w) => pool.some((n) => n.includes(w)));
	});
	const tier = english.length > 0 ? english : cards;
	const named = tier.filter((card) =>
		(english.length > 0 ? [card.name, flavorKeyOf(card)] : [card.name, card.printed_name]).some((n) =>
			equalsUnseparated(n, whole),
		),
	);
	if (named.length > 0) return named.slice(0, 1);
	return tier.slice(0, limit);
}

/**
 * Every partition's NamedFuzzyBundle (in partition order), combined into the answer the three
 * stages give asked one after another over the same partitions — or null when the replies cannot
 * say (a stage the merge needs was skipped somewhere), for the caller to ask the stages instead.
 *
 *   1. EXACT: the best rank, strictly greater so a tie keeps the lowest partition, and that
 *      partition's card — `scryfallExactName`'s merge. Skipped when the routed partition settled
 *      the name as absent (`exactSettledMiss`), which is that method's answer too.
 *   2. TYPO: `raceFuzzyCandidates` over every partition's candidates; ambiguous is the answer, and
 *      a hit is the WINNING partition's own local race, which is what the stage's materialize call
 *      to that partition returned — its local race is a sub-race the global winner also leads.
 *      A WEAK hit (the winner scores under FUZZY_WEAK_BELOW, which its partition's race reports)
 *      answers only when containment has no single card instead (`weakWinnerOrContained`, n14);
 *      the port's line is 0 since backlog x25, so a hit is never weak.
 *   3. CONTAINMENT: `mergeContained`, where two distinct names are ambiguous.
 *
 * Each stage is reached only where the previous one fell through, so the skip rules guarantee its
 * inputs: no partition ranked the needle (else stage 1 answered), so every one raced; and no
 * partition had a STRONG candidate (else the global winner is strong, or the race ambiguous, and
 * stage 2 answered), so every one ran containment — beside a weak candidate or with none.
 */
export function mergeNamedFuzzyBundles(
	replies: NamedFuzzyBundle[],
	words: string[],
	limit: number,
	exactSettledMiss = false,
): NamedFuzzyAnswer | null {
	if (exactSettledMiss) {
		// The settled word says no partition holds the name; one that ranks it anyway skipped its
		// typo stage, and the stages are the only faithful answer.
		if (replies.some((r) => r.exact.rank !== null)) return null;
	} else {
		let best: NameRank | null = null;
		let card: Record<string, unknown> | null = null;
		for (const reply of replies) {
			if (reply.exact.rank !== null && beatsExactRank(reply.exact.rank, best)) {
				best = reply.exact.rank;
				card = reply.exact.card;
			}
		}
		if (best !== null) return card === null ? null : { status: "card", card };
	}

	if (replies.some((r) => r.fuzzy === null)) return null;
	const race = raceFuzzyCandidates(
		replies.map((r) => r.candidates),
		FUZZY_SIMILARITY_LEAD,
	);
	if (race.status === "ambiguous") return { status: "ambiguous" };
	let weak: Record<string, unknown> | null = null;
	if (race.status === "hit" && race.winner !== undefined) {
		const local = replies[race.winner]?.fuzzy ?? null;
		if (local?.status === "ambiguous") return { status: "ambiguous" };
		if (local?.status === "hit" && local.card) return { status: "card", card: local.card };
		if (local?.status === "weak" && local.card) weak = local.card;
	}

	const contained: Record<string, unknown>[][] = [];
	for (const reply of replies) {
		if (reply.contained === null) return null;
		contained.push(reply.contained);
	}
	const found = mergeContained(contained, words, limit);
	if (weak !== null) return weakWinnerOrContained(weak, found);
	if (found.length > 1) return { status: "ambiguous" };
	const only = found[0];
	return only ? { status: "card", card: only } : { status: "miss" };
}
