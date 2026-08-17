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
//   catalog (types+keywords)           N, summed (each object caches its own)
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
//   collection (firstOfEach)           N — a {set,collector_number} or {name}
//                                      identifier is not an id the filter holds
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
// (prefix-rank, char-length, name) key, recomputed from the names — both rules
// are pinned against the single-store reference by the Rust differential
// (core_api's fuzzy_race_across_partitions_matches_the_single_store and
// autocomplete_merge_key_matches_the_single_store).

import { foldAccents } from "../parser/pystr";
import { gatherPartitionOf, partitionOfOracleId } from "./partition";
import type { RemoteEngine } from "./remote-engine";
import { externalIdKey, illustrationIdKey, RoutingFilter, scryfallIdKey } from "./routing-filter";
import { MANIFEST_KEY, readManifest, readRoutingFilter } from "./store-kv";
import {
	type Engine,
	type EngineSearchOptions,
	type EngineSearchResult,
	type EngineSerializedResult,
	EngineUnavailableError,
	type Env,
	FUZZY_SIMILARITY_LEAD,
	type FuzzyCandidateWire,
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
 * Merge per-partition autocomplete lists under the ENGINE'S OWN ordering key, recomputed from
 * the names: (prefix-rank over the folded name, printed length in CHARACTERS, name). The length
 * component is load-bearing — the engine orders "Shock" before "Shatter" (5 < 7) where an
 * alphabetical merge reverses them — and the Rust differential
 * (autocomplete_merge_key_matches_the_single_store) pins this merge to the single-store output.
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
	const p = foldAccents(prefix.toLowerCase());
	const rank = (name: string) => (foldAccents(name.toLowerCase()).startsWith(p) ? 0 : 1);
	const chars = (name: string) => [...name].length;
	all.sort((a, b) => rank(a) - rank(b) || chars(a) - chars(b) || (a < b ? -1 : a > b ? 1 : 0));
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
		return sumCounts(await this.all((e) => e.cardTypeCounts()));
	}

	async cardKeywordCounts(): Promise<Record<string, number>> {
		return sumCounts(await this.all((e) => e.cardKeywordCounts()));
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

	randomCardsAsObjects(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		return this.at(this.weightedPartition()).randomCardsAsObjects(numCards, fields);
	}

	randomCardsAsJson(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult> {
		return this.at(this.weightedPartition()).randomCardsAsJson(numCards, fields, shape);
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
		// A folded name identifies an oracle card, and an oracle card lives in
		// exactly one partition — so at most one partition answers.
		return this.firstNonNull((e) => e.scryfallExactName(folded, setCode, baseUrl));
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
