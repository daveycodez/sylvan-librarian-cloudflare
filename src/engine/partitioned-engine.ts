// The Engine every request isolate uses: the per-route table of plan B5,
// deciding for each route how many partition objects to ask and how to combine
// what comes back. The store is partitioned, always — there is no second Engine
// implementation in the isolate to fall back to.
//
// The RPC-count contract (pinned by tests/engine/partitioned-routes.test.ts):
//
//   search / listing (all shapes)      1 isolate RPC, to the GATHER partition
//                                      (hash(query) % N); the gather object
//                                      fans phases 1 and 2 to its siblings
//   total_cards                        free — rides phase 1 of the gather
//   catalog (types+keywords)           N, summed — ONCE per store generation per
//                                      isolate (CATALOG_CACHE); every later call
//                                      is 0, like setsWithExtras
//   random                             1, partition weighted by card_count
//   oracle_id-keyed                    1, partitionOfOracleId; a miss re-reads
//                                      the manifest (cacheTtl 60) and retries
//                                      ONCE iff the modulus moved the target
//   scryfall_id / external /           1 when the routing filter knows the id
//   illustration-keyed                 (routing-filter.ts, ~740KB in KV), else
//                                      the old N-way first-non-null fan-out —
//                                      and 1 + (N-1) when a hint comes back
//                                      empty, so never worse than the fan-out
//   collection (byIds)                 one batch RPC per DISTINCT hinted
//                                      partition (1-2 for a short collection,
//                                      N for a wide one), plus the partitions
//                                      no hint covered; total never above N
//   collection (firstOfEach)           N — a {set,collector_number} identifier
//                                      is not an id the routing filter holds
//   collection ({name})                N ranks, then one materialize RPC per
//                                      partition that WON an identifier: 2N
//                                      worst case for a batch of 75, and N+1
//                                      for the batch that all lands in one
//   named exact / fuzzy / containing   N, combined (see each method's rules)
//   autocomplete                       N, merged prefix-first
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
import { gatherPartitionOf, partitionOfOracleId } from "./partition";
import type { RemoteEngine } from "./remote-engine";
import { externalIdKey, illustrationIdKey, RoutingFilter, scryfallIdKey } from "./routing-filter";
import { MANIFEST_KEY, readManifest, readRoutingFilter } from "./store-kv";
import {
	type CollectionScope,
	type Engine,
	type EngineSearchOptions,
	type EngineSearchResult,
	type EngineSerializedResult,
	EngineUnavailableError,
	type Env,
	FUZZY_SIMILARITY_LEAD,
	type FuzzyCandidateWire,
	type NameIdentifier,
	type ResultShape,
	type ScryfallFuzzyResult,
	type SearchPageEnvelope,
	type StoreManifest,
} from "./types";

/**
 * The manifest routing pins each request to, cached PER ISOLATE for 60s — the
 * same freshness readManifest's own cacheTtl gives, without a metered KV read
 * per request (100k/day is the budget that would otherwise bind).
 *
 * THROWS rather than returning null when there is nothing usable at the key.
 * There is no unpartitioned serving path to hand the request to instead, so
 * "no manifest" and "a manifest with no partitions[]" both mean the deployment
 * cannot answer, and the honest form of that is the loud 503 every other
 * engine-unavailable condition takes. readManifest already refuses a manifest
 * that predates the partitioned format, with its own specific wording.
 *
 * Only SUCCESSFUL reads are cached — a failure must not pin an isolate to a bad
 * answer for a minute.
 */
let manifestCache: { at: number; manifest: StoreManifest } | null = null;
const MANIFEST_CACHE_MS = 60_000;

export async function livePartitionedManifest(env: Env): Promise<StoreManifest> {
	const now = Date.now();
	const cached = manifestCache;
	if (cached && now - cached.at <= MANIFEST_CACHE_MS) return cached.manifest;
	const manifest = await readManifest(env);
	if (!manifest) {
		// Deliberately the same posture as the loader's: building the index is the
		// deploy's job (scripts/import-store.sh), and a request finding no store
		// means the deploy did not publish one.
		throw new EngineUnavailableError(`No store manifest at ${MANIFEST_KEY}; the deploy has not published an index`);
	}
	if (!manifest.partitions?.length) {
		throw new EngineUnavailableError(
			`The manifest at ${MANIFEST_KEY} (${manifest.store_key}) declares partition_count ` +
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
 * Whether exact-name rank `a` beats `b` — TIER first, then prefer_score, with null losing to
 * anything. The pair is compared, never interpreted; see core_api's `exact_name_rank`.
 */
function beatsExactRank(a: number[], b: number[] | null): boolean {
	if (b === null) return true;
	const [aTier = 0, aScore = 0] = a;
	const [bTier = 0, bScore = 0] = b;
	return aTier > bTier || (aTier === bTier && aScore > bScore);
}

// ── The routing filter (src/engine/routing-filter.ts) ─────────────────────────
//
// A ~740KB KV value that answers "which partition owns this printing id?" for
// every addressable id in the build — scryfall_id, illustration_id and the five
// external namespaces, 1.23M keys on the real corpus. It turns the bare-UUID
// routes from an N-way fan-out into ONE RPC.
//
// NEVER AWAITED ON THE REQUEST PATH. The first request in a fresh isolate finds
// nothing cached, fans out exactly as the deployment did before this existed, and
// schedules the load; every request after it is routed. That is deliberate: a
// 740KB KV read in front of a 6ms point lookup would trade the meter this exists
// to fix for the latency it exists to protect, and the fan-out is always correct
// on its own.

/** Cached per isolate and keyed by BUILD, because the filter is immutable per
 * build — a new generation is a new key, not a new value under the old one.
 * `filter: null` remembers a build with no usable filter so the isolate stops
 * asking KV for it once per request. */
let routingCache: { builtAt: string; filter: RoutingFilter | null } | null = null;
let routingLoad: { builtAt: string; done: Promise<void> } | null = null;

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
	if (routingLoad?.builtAt !== builtAt) {
		const done = (async () => {
			try {
				const bytes = await readRoutingFilter(env, manifest);
				if (bytes === null) {
					// Not an error. A build published before this existed, or one whose
					// filter build failed, simply has none — and the fan-out is the
					// deployment's original behaviour, not a degraded mode.
					routingCache = { builtAt, filter: null };
					return;
				}
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
					return;
				}
				routingCache = { builtAt, filter: parsed.filter };
				console.log(
					`routing filter loaded for build ${builtAt}: ${parsed.filter.keyCount} ids, ` +
						`${(parsed.filter.byteLength / 1024).toFixed(0)}KB`,
				);
			} catch (err) {
				// A failed read must not poison the cache — the next request retries.
				console.warn(`routing filter for ${builtAt} could not be read (${err}); routes fall back to the fan-out`);
				routingLoad = null;
			}
		})();
		routingLoad = { builtAt, done };
		waitUntil(done);
	}
	return null;
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
	// Score-descending with deterministic tiebreaks, mirroring the Rust reference race.
	all.sort(
		(a, b) => b.score - a.score || (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0) || a.vpid - b.vpid,
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

/**
 * `store_key` → the union of that generation's per-partition extras-set tables.
 *
 * Module scope, so it outlives the per-request PartitionedEngine. One entry per store generation;
 * the map is never pruned because an isolate sees at most a handful of generations in its life and
 * each value is a few hundred short strings.
 */
const EXTRAS_SETS_CACHE = new Map<string, Promise<string[]>>();

/**
 * `store_key` → the corpus-global type and keyword counts, summed across the partitions.
 *
 * The same shape and the same rationale as EXTRAS_SETS_CACHE: a few KB of constants that change
 * exactly when the archives do, asked for by a route (`/get_catalog`) that fanned out N RPCs on
 * every call — once an hour per colo behind its edge cache, but N grows with the corpus and the
 * answer never does. One entry covers both tables because one RPC (`typeAndKeywordCounts`)
 * returns both, and RemoteEngine already dedupes that per instance.
 */
const CATALOG_CACHE = new Map<string, Promise<{ types: Record<string, number>; keywords: Record<string, number> }>>();

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
		private readonly routing: RoutingFilter | null = null,
	) {}

	private get n(): number {
		return this.manifest.partition_count as number;
	}

	private at(partition: number): RemoteEngine {
		let e = this.engines.get(partition);
		if (!e) {
			e = this.engineFor(partition);
			this.engines.set(partition, e);
		}
		return e;
	}

	private gatherAt(query: string): RemoteEngine {
		return this.at(gatherPartitionOf(query, this.n));
	}

	private all<T>(run: (e: RemoteEngine, p: number) => Promise<T>): Promise<T[]> {
		return Promise.all(Array.from({ length: this.n }, (_, p) => run(this.at(p), p)));
	}

	private async firstNonNull<T>(run: (e: RemoteEngine) => Promise<T | null>): Promise<T | null> {
		// Parallel, then FIRST BY PARTITION ORDER — deterministic even in the
		// (id-keyed: impossible; name-keyed: vanishing) case of two answers.
		const answers = await this.all((e) => run(e));
		for (const a of answers) if (a !== null) return a;
		return null;
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
	private async hinted<T>(key: string, run: (e: RemoteEngine) => Promise<T | null>): Promise<T | null> {
		const hint = this.routing?.lookup(key) ?? null;
		if (hint === null || hint >= this.n) return this.firstNonNull(run);
		const first = await run(this.at(hint));
		if (first !== null) return first;
		const others = Array.from({ length: this.n }, (_, p) => p).filter((p) => p !== hint);
		const answers = await Promise.all(others.map((p) => run(this.at(p))));
		for (const a of answers) if (a !== null) return a;
		return null;
	}

	// ── search / listing: one RPC to the gather ─────────────────────────────────

	searchCardsAsObjects(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		return this.gatherAt(opts.filterTreeJson).gatherSearchAsObjects(opts);
	}

	searchCardsAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		return this.gatherAt(opts.filterTreeJson).gatherSearchAsJson(opts, shape);
	}

	scryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult> {
		return this.gatherAt(opts.filterTreeJson).gatherScryfallSearch(opts, baseUrl);
	}

	scryfallSearchPage(
		opts: EngineSearchOptions,
		baseUrl: string,
		envelope: SearchPageEnvelope,
		cache: Record<string, string>,
	): Promise<Response> {
		return this.gatherAt(opts.filterTreeJson).scryfallSearchPage(opts, baseUrl, envelope, cache, "cards2");
	}

	// ── catalogs and counts: sum the partitions ─────────────────────────────────

	async cardTypeCounts(): Promise<Record<string, number>> {
		return (await this.catalogCounts()).types;
	}

	async cardKeywordCounts(): Promise<Record<string, number>> {
		return (await this.catalogCounts()).keywords;
	}

	/**
	 * Both count tables in ONE fan-out per store generation per isolate — see CATALOG_CACHE. The
	 * in-flight promise is what is cached, so concurrent first requests share the fan-out, and a
	 * failed one is forgotten rather than remembered as an empty catalog.
	 */
	private catalogCounts(): Promise<{ types: Record<string, number>; keywords: Record<string, number> }> {
		const key = this.manifest.store_key;
		const cached = CATALOG_CACHE.get(key);
		if (cached) return cached;
		const pending = this.all(async (e) => ({ types: await e.cardTypeCounts(), keywords: await e.cardKeywordCounts() }))
			.then((parts) => ({
				types: sumCounts(parts.map((p) => p.types)),
				keywords: sumCounts(parts.map((p) => p.keywords)),
			}))
			.catch((err) => {
				CATALOG_CACHE.delete(key);
				throw err;
			});
		CATALOG_CACHE.set(key, pending);
		return pending;
	}

	/**
	 * The union of the partitions' extras-set tables, cached PER ISOLATE for the store generation.
	 *
	 * Not cached on `this`: a PartitionedEngine is constructed per request, so an instance field
	 * would fan out on every set-scoped `/cards/search`. The key is the manifest's `store_key`,
	 * which changes exactly when the archives do — so a nightly publish invalidates the table by
	 * construction and a stale generation can never answer for a fresh one. The in-flight promise
	 * is what is cached, not its value, so N concurrent first requests share one fan-out.
	 */
	setsWithExtras(): Promise<string[]> {
		const key = this.manifest.store_key;
		const cached = EXTRAS_SETS_CACHE.get(key);
		if (cached) return cached;
		const pending = this.all((e) => e.setsWithExtras())
			.then((lists) => [...new Set(lists.flat())].sort())
			.catch((err) => {
				// A failed fan-out must not be remembered as "no set has extras" — that would
				// silently turn the auto-enable off for the life of the isolate.
				EXTRAS_SETS_CACHE.delete(key);
				throw err;
			});
		EXTRAS_SETS_CACHE.set(key, pending);
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

	// ── oracle-keyed: exactly one RPC, with the stale-modulus retry ─────────────

	async scryfallCardByOracleId(oracleId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const p = partitionOfOracleId(oracleId, this.n);
		const card = await this.at(p).scryfallCardByOracleId(oracleId, baseUrl);
		if (card !== null) return card;
		// A miss under a stale isolate manifest is a WRONG-PARTITION ask, not a
		// missing card (Decision 3b): re-read the manifest and retry once, only
		// when the modulus actually moved the target.
		const fresh = await this.reread();
		const freshN = fresh?.partition_count;
		if (freshN !== undefined && freshN !== this.n) {
			const p2 = partitionOfOracleId(oracleId, freshN);
			if (p2 !== p) return this.at(p2).scryfallCardByOracleId(oracleId, baseUrl);
		}
		return null;
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

	scryfallCardByIllustrationId(illustrationId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		return this.hinted(illustrationIdKey(illustrationId), (e) =>
			e.scryfallCardByIllustrationId(illustrationId, baseUrl),
		);
	}

	// ── collection batches: one batch RPC per partition, merged per-position ────

	async scryfallCardsByIds(scryfallIds: string[], baseUrl: string): Promise<Record<string, unknown>[]> {
		const byId = new Map<string, Record<string, unknown>>();
		const collect = (cards: Record<string, unknown>[]) => {
			for (const card of cards) byId.set(String(card.id), card);
		};
		// With the filter, a batch goes only to the partitions its ids actually name
		// — for a short collection that is one or two objects instead of nine. A
		// second round then covers whatever the hints missed, asking only the
		// partitions the first round did NOT, so the total is never above N.
		const hinted = new Map<number, string[]>();
		let unhinted = false;
		if (this.routing !== null) {
			for (const id of scryfallIds) {
				const p = this.routing.lookup(scryfallIdKey(id));
				if (p === null || p >= this.n) {
					unhinted = true;
					continue;
				}
				const list = hinted.get(p);
				if (list) list.push(id);
				else hinted.set(p, [id]);
			}
		}
		if (this.routing !== null && hinted.size < this.n) {
			const asked = await Promise.all(
				[...hinted.entries()].map(([p, ids]) => this.at(p).scryfallCardsByIds(ids, baseUrl)),
			);
			for (const cards of asked) collect(cards);
			// Anything still missing could only live where we have not looked. Ids the
			// filter did not recognise could live anywhere, so an unrecognised id costs
			// the rest of the fan-out — one round later, and still N calls in total.
			const missing = scryfallIds.filter((id) => !byId.has(id));
			if (missing.length > 0 && (unhinted || hinted.size < this.n)) {
				const rest = Array.from({ length: this.n }, (_, p) => p).filter((p) => !hinted.has(p));
				const more = await Promise.all(rest.map((p) => this.at(p).scryfallCardsByIds(missing, baseUrl)));
				for (const cards of more) collect(cards);
			}
		} else {
			// Each partition returns ITS matches in request order, skipping misses;
			// re-merge by id so the combined list is in request order too.
			for (const cards of await this.all((e) => e.scryfallCardsByIds(scryfallIds, baseUrl))) collect(cards);
		}
		return scryfallIds.flatMap((id) => {
			const card = byId.get(id);
			return card ? [card] : [];
		});
	}

	async scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]> {
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

	async scryfallFuzzyName(name: string, baseUrl: string): Promise<ScryfallFuzzyResult> {
		const race = raceFuzzyCandidates(await this.all((e) => e.fuzzyCandidates(name)), FUZZY_SIMILARITY_LEAD);
		if (race.status !== "hit" || race.winner === undefined) return { status: race.status, card: null };
		// One more RPC to the winning partition materializes the card: its local race is a
		// sub-race of the global one the winner just led by >= lead, so it resolves the same hit.
		return this.at(race.winner).scryfallFuzzyName(name, baseUrl);
	}

	async scryfallExactName(folded: string, setCode: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		// RANK EVERY PARTITION, THEN MATERIALIZE THE WINNER — the same shape as the fuzzy race
		// above, and for the same reason.
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
		const ranks = await this.all((e) => e.scryfallExactNameRank(folded, setCode));
		let winner = -1;
		let best: number[] | null = null;
		for (const [p, rank] of ranks.entries()) {
			// Strictly greater, so an exact tie keeps the LOWEST partition index — the same
			// deterministic tiebreak firstNonNull gave, preserved for the ties it did decide.
			if (rank !== null && beatsExactRank(rank, best)) {
				best = rank;
				winner = p;
			}
		}
		if (winner < 0) return null;
		return this.at(winner).scryfallExactName(folded, setCode, baseUrl);
	}

	/** The best rank any partition holds — the whole store's answer, for an Engine asked directly. */
	async scryfallExactNameRank(folded: string, setCode: string): Promise<number[] | null> {
		const ranks = await this.all((e) => e.scryfallExactNameRank(folded, setCode));
		let best: number[] | null = null;
		for (const rank of ranks) {
			if (rank !== null && beatsExactRank(rank, best)) {
				best = rank;
			}
		}
		return best;
	}

	/**
	 * A collection POST's `{name}` identifiers, ranked across every partition and materialized
	 * from the winners: TWO rounds of at most N RPCs, whatever the batch size.
	 *
	 * The rank round is `scryfallExactName`'s protocol run 75-wide — the same reason it exists
	 * there applies here identifier by identifier, since a needle is often one card's whole name
	 * and another card's face name and those two cards hash apart. The materialize round asks each
	 * partition ONLY for the identifiers it won, so a batch that all lands in one partition costs
	 * one call and a batch spread across ten costs ten — never one per identifier.
	 */
	async scryfallCollectionNames(
		identifiers: NameIdentifier[],
		baseUrl: string,
		scope?: CollectionScope | null,
	): Promise<(Record<string, unknown> | null)[]> {
		if (identifiers.length === 0) return [];
		const perPartition = await this.all((e) => e.scryfallCollectionNameRanks(identifiers, scope));
		const winner = new Array<number>(identifiers.length).fill(-1);
		const best: (number[] | null)[] = new Array(identifiers.length).fill(null);
		for (const [p, ranks] of perPartition.entries()) {
			for (let i = 0; i < identifiers.length; i++) {
				const rank = ranks[i] ?? null;
				// Strictly greater, so an exact tie keeps the LOWEST partition index — the same
				// deterministic tiebreak the single-needle path gives.
				if (rank !== null && beatsExactRank(rank, best[i] ?? null)) {
					best[i] = rank;
					winner[i] = p;
				}
			}
		}
		const claimed = new Map<number, number[]>();
		for (const [i, p] of winner.entries()) {
			if (p < 0) continue;
			const positions = claimed.get(p);
			if (positions) positions.push(i);
			else claimed.set(p, [i]);
		}
		const out: (Record<string, unknown> | null)[] = new Array(identifiers.length).fill(null);
		await Promise.all(
			[...claimed].map(async ([p, positions]) => {
				const asked = positions.map((i) => identifiers[i] as NameIdentifier);
				const cards = await this.at(p).scryfallCollectionNames(asked, baseUrl, scope);
				for (const [k, position] of positions.entries()) out[position] = cards[k] ?? null;
			}),
		);
		return out;
	}

	/** The best rank any partition holds per identifier — for an Engine asked directly. */
	async scryfallCollectionNameRanks(
		identifiers: NameIdentifier[],
		scope?: CollectionScope | null,
	): Promise<(number[] | null)[]> {
		const perPartition = await this.all((e) => e.scryfallCollectionNameRanks(identifiers, scope));
		const best: (number[] | null)[] = new Array(identifiers.length).fill(null);
		for (const ranks of perPartition) {
			for (let i = 0; i < identifiers.length; i++) {
				const rank = ranks[i] ?? null;
				if (rank !== null && beatsExactRank(rank, best[i] ?? null)) best[i] = rank;
			}
		}
		return best;
	}

	async scryfallAutocomplete(prefix: string, limit: number): Promise<string[]> {
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
		const perPartition = await this.all((e) => e.scryfallNamesContaining(words, setCode, limit, baseUrl));
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
		const whole = words.map(unseparated).join("");
		const named = [...byName.values()].filter(
			(card) => equalsUnseparated(card.name, whole) || equalsUnseparated(card.printed_name, whole),
		);
		if (named.length > 0) return named.slice(0, 1);
		return [...byName.values()].slice(0, limit);
	}
}
