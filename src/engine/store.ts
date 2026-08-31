// Per-isolate store manager: loads the rkyv store from KV into the wasm engine
// and hot-swaps when the manifest advances. It never starts an import — the
// index is built by the deploy (scripts/import-store.sh) and refreshed by the
// nightly cron, either of which fails loudly rather than shipping no index.
//
// Memory discipline: what an object loads is ONE PARTITION's archive — a
// complete rkyv archive with the card-object residue packed into the printing
// record, not a share of a bigger one — streamed KV → wasm linear memory in 4MB
// blocks (see load-blocks.ts). No full-archive JS buffer ever exists, keeping
// peak isolate usage inside the 128MB limit. Partition size is chosen by the
// builder (TARGET_PARTITION_BYTES, src/import-publish.ts) and read from the
// manifest, so there is no store-wide byte figure to quote here; dated for scale,
// on 2026-08-16 the ten partitions averaged ~41MB raw. The block size is chosen
// independently of however KV and DecompressionStream cut the bytes up, which is
// what keeps the wasm-side scratch allocation small — it used to be one whole
// 26MB KV chunk, and peak linear memory 99.4MB instead of 78.7MB on the
// single-archive store those numbers were measured against.
//
// The wasm engine is instantiated lazily (wasm-shim.ts): only a DO that
// actually loads a store pays for it, never a plain request isolate.
//
// There is deliberately NO Cache API layer in front of KV. The previous
// architecture wrote the store through `caches.default` and read it back, and
// that double-stream measured 0.6-1.3s of billed CPU per load — the single
// largest cost in the old system. KV's own `cacheTtl` gives colo-level caching
// for free, on immutable chunk keys, with none of that overhead. What sits in
// front of KV instead is the Durable Object's own SQLite — see store-cache.ts,
// and note it is a read-through cache over a source of truth that is still KV,
// not a second copy of record. It holds a partitioned archive COMPRESSED, chunk
// for chunk (decompressed copies of every partition in every region do not fit
// the 5GB DO pool), so a cached wake skips the fetch and still pays the gunzip.

import * as wasm from "sylvan-engine-wasm";
import {
	CARD_OBJECT_FIELDS,
	type EngineRow,
	toScryfallCard,
	withResolvedMultilingual,
} from "../routes/scryfall-compat/objects";
import { emptyPageResponse, scryfallCsvResponse, scryfallListJson } from "../routes/scryfall-compat/respond";
import { encodeUtf8, NEWLINE } from "./bytes";
import { serializeCards } from "./columnar";
import { type FeedCounts, feedBlocks } from "./load-blocks";
import { probePlacement } from "./placement";
import {
	type ArchiveCacheStorage,
	type CacheWriter,
	cachedArchiveStream,
	cachedCompressedStream,
	cacheWriter,
	compressedCacheKeys,
	dropCached,
	ensureCacheSchema,
	fillCache,
	isCompressedCached,
	pruneCache,
	putCompressedChunk,
	readLiveManifest,
	recordLiveManifest,
} from "./store-cache";
import {
	type ArchiveSource,
	announceSelf,
	archiveOfManifest,
	fetchStoredChunk,
	kvSourceStream,
	readManifest,
} from "./store-kv";
import type {
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	Env,
	NameIdentifier,
	ResultShape,
	ScryfallFuzzyResult,
	SearchPageEnvelope,
	StoreManifest,
} from "./types";
import { EngineUnavailableError, FUZZY_SIMILARITY_LEAD, type FuzzyCandidateWire } from "./types";

/**
 * The FLOOR of the typo-tolerant stage of `?fuzzy=`: a candidate scoring below this is not a
 * candidate at all. Its twin, the LEAD, lives in types.ts because the partitioned gather applies
 * it too.
 *
 * FITTED, NOT CHOSEN. 0.625 is the middle of the 0.60–0.65 plateau over which Scryfall's answers
 * to 86 probed needles are reproduced identically — see card_engine's `Fuzzy name matching`
 * module comment for the metric it is a floor ON, which is no longer pg_trgm's similarity and no
 * longer comparable to pg_trgm's 0.3 default.
 */
const FUZZY_SIMILARITY_FLOOR = 0.625;

/**
 * Loaded-store state, PER DURABLE OBJECT LABEL rather than module-global.
 *
 * This module is isolate-global, and Durable Object instances of one class can
 * be COLOCATED in a single isolate — with partitioned stores, engine-wnam-p0
 * and engine-wnam-p1 may share this module while holding DIFFERENT archives. A
 * module-global `current` had them clobbering each other: p1's load would
 * replace p0's engine, and every p0 query would answer from the wrong
 * partition. The map key is the object's label (`""` for label-less callers —
 * tests and tooling — which therefore behave exactly as the old globals did).
 * The wasm side is per-label for the same reason: see wasm-shim.ts engineFor.
 */
interface LabelState {
	current: { storeKey: string; engine: WasmEngine; manifest: StoreManifest; handle: wasm.EngineHandle } | null;
	loading: Promise<Engine> | null;
}
const states = new Map<string, LabelState>();

function stateFor(label: string | undefined): LabelState {
	const key = label ?? "";
	let s = states.get(key);
	if (!s) {
		s = { current: null, loading: null };
		states.set(key, s);
	}
	return s;
}

/**
 * What a loader needs from its caller beyond the environment: somewhere to put background work, and
 * — only inside a Durable Object — the local storage that caches decompressed archives.
 *
 * `storage` is optional because the loader runs in two places with different capabilities. A
 * SearchEngine DO has SQLite and wants the cache; anything else (tests, a direct isolate load) has
 * neither and must keep working without it. Absent storage simply means every load goes to KV,
 * which is exactly the behaviour that predates the cache.
 */
export interface LoadContext {
	waitUntil(p: Promise<unknown>): void;
	storage?: ArchiveCacheStorage;
	/**
	 * Who to blame in the logs — the Durable Object's own name (`engine-wnam`,
	 * `engine-wnam-2`) — AND the key this module's per-label state lives under.
	 *
	 * This module is isolate-global and has no idea which object it is running
	 * inside, so without it every load line reads identically no matter which
	 * shard, region, or build emitted it. That is not hypothetical: during the
	 * region cutover, `engine-LAX` on the old build and `engine-wnam` on the new
	 * one logged byte-identical "Store loaded from KV" lines, and telling them
	 * apart needed a version join that the log itself should have made
	 * unnecessary.
	 */
	label?: string;
	/**
	 * Which partition of the store this object serves — parsed from the `-p<k>`
	 * suffix of its own label by the Durable Object. Optional in the TYPE only
	 * because non-DO callers (tests, tooling) construct a context by hand;
	 * undefined reaching the loader is a naming bug and archiveOfManifest refuses
	 * it loudly rather than serving 1/N of the corpus as the whole store.
	 */
	partition?: number;
}

/** `[engine-wnam] ` for logs, or an empty prefix outside a Durable Object. */
function tag(ctx?: LoadContext): string {
	return ctx?.label ? `[${ctx.label}] ` : "";
}

/** The `catalog()` wasm export's payload, parsed once per loaded store. */
interface WasmCatalog {
	card_types: Record<string, number>;
	card_keywords: Record<string, number>;
	sets_with_extras: string[];
}

class WasmEngine implements Engine {
	/** The wasm instance this engine queries: one per label (see wasm-shim.ts). */
	constructor(private readonly w: wasm.EngineHandle) {}

	/** The options encoding, for gatherOps — phase 1 must serialize opts EXACTLY
	 * as a local query would, or the fan-out and the single-partition path could
	 * disagree about defaults. */
	optsJsonFor(opts: EngineSearchOptions): string {
		return this.optsJson(opts);
	}

	/** The engine's options object, shared by both query entry points. */
	private optsJson(opts: EngineSearchOptions): string {
		return JSON.stringify({
			unique: opts.unique,
			prefer: opts.prefer,
			orderby: opts.orderby,
			direction: opts.direction,
			limit: opts.limit,
			offset: opts.offset,
			fields: opts.fields,
			// Scryfall's include_multilingual, defaulted here so the engine-side key is always a
			// boolean; true widens the search to foreign printings (see EngineSearchOptions).
			include_multilingual: opts.includeMultilingual === true,
		});
	}

	private query(opts: EngineSearchOptions): { total: number; rows: Record<string, unknown>[] } {
		return JSON.parse(this.w.query(opts.filterTreeJson, this.optsJson(opts))) as {
			total: number;
			rows: Record<string, unknown>[];
		};
	}

	async searchCardsAsObjects(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		const result = this.query(opts);
		return { totalCards: result.total, cards: result.rows };
	}

	/**
	 * The engine's own encoding of the rows, spliced rather than rebuilt.
	 *
	 * The `rows` shape used to go wasm -> `JSON.parse` -> `JSON.stringify`, which produced the
	 * bytes it started with: the rows arrive already encoded, and `serializeCards(rows, "rows")`
	 * is `JSON.stringify(rows)`. Measured against the live deployment, the Durable Object's CPU is
	 * very nearly a pure function of payload size -- ~29us per KB across a 17x range, so a
	 * megabyte-scale /search spent most of its 34ms handling the same bytes four times over.
	 * `query_rows` hands them back once. Field selection already happened in the engine, so the
	 * encoded array is exactly the answer.
	 *
	 * `columnar` still parses, because inverting rows into per-field arrays genuinely needs the
	 * values -- and it is the shape almost nothing asks for.
	 */
	async searchCardsAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		if (shape === "columnar") {
			const result = this.query(opts);
			return {
				totalCards: result.total,
				cardsBytes: encodeUtf8(serializeCards(result.rows, shape)),
				rowCount: result.rows.length,
			};
		}
		const answer = this.w.query_rows(opts.filterTreeJson, this.optsJson(opts));
		// `<total> <rowCount>\n<rows>`. Only the prefix is decoded -- a handful of ASCII digits --
		// and the rows stay bytes all the way to the response body. `subarray` is a view, not a
		// copy, so nothing here is proportional to the payload.
		const split = answer.indexOf(NEWLINE);
		const [total = "0", rows = "0"] = new TextDecoder().decode(answer.subarray(0, split)).split(" ");
		return { totalCards: Number(total), cardsBytes: answer.subarray(split + 1), rowCount: Number(rows) };
	}

	/**
	 * The store's type/keyword catalogs, aggregated once per loaded store.
	 *
	 * The engine walks the whole archive to build these, so it is not a call to
	 * repeat: /get_catalog needs both halves, and asking for them separately used
	 * to run the aggregation AND parse its full JSON twice, keeping one half each
	 * time (measured 15ms of DO CPU for one request). A loaded store is immutable
	 * — a hot swap constructs a new WasmEngine — so the result is cached for the
	 * life of this instance and invalidates by construction.
	 */
	private catalogOnce: WasmCatalog | null = null;

	private catalog(): WasmCatalog {
		const cached = this.catalogOnce;
		if (cached) return cached;
		const parsed = JSON.parse(this.w.catalog()) as WasmCatalog;
		this.catalogOnce = parsed;
		return parsed;
	}

	async cardTypeCounts(): Promise<Record<string, number>> {
		return this.catalog().card_types;
	}

	async cardKeywordCounts(): Promise<Record<string, number>> {
		return this.catalog().card_keywords;
	}

	/**
	 * The set codes this archive holds an `is:extra` printing for — the `include_extras`
	 * auto-enable table, folded at build (see `CardIndexes::sets_with_extras`) and read here off
	 * the same cached catalog payload the two count maps come from.
	 */
	async setsWithExtras(): Promise<string[]> {
		return this.catalog().sets_with_extras;
	}

	async randomCardsAsObjects(
		numCards: number,
		fields: string[],
		filterTreeJson?: string,
	): Promise<Record<string, unknown>[]> {
		// Engine sampling is deterministic per seed; per-request entropy keeps
		// /random_search random, mirroring upstream's process-side RNG.
		const seedBytes = crypto.getRandomValues(new BigUint64Array(1));
		const seed = seedBytes[0] ?? 0n;
		// "null" rather than an empty string for "no filter": both are accepted by the export, and
		// the spelling matches `fields_json`'s own null convention one argument along.
		const filter = filterTreeJson ?? "null";
		return JSON.parse(this.w.random_search(numCards, seed, filter, JSON.stringify(fields))) as Record<
			string,
			unknown
		>[];
	}

	async randomCardsAsJson(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		filterTreeJson?: string,
	): Promise<EngineSerializedResult> {
		const rows = await this.randomCardsAsObjects(numCards, fields, filterTreeJson);
		return { totalCards: rows.length, cardsBytes: encodeUtf8(serializeCards(rows, shape)), rowCount: rows.length };
	}

	async cardCount(): Promise<number> {
		return this.w.size();
	}

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// See the Engine interface: every card object here is BUILT in this Durable Object, never in
	// the request isolate.

	/** Map engine rows to Scryfall card objects. Runs here, in the DO, for the reason above. */
	private toCards(rows: Record<string, unknown>[], baseUrl: string): Record<string, unknown>[] {
		return rows.map((row) => toScryfallCard(row, baseUrl));
	}

	/**
	 * A page of Scryfall card objects, built in the ENGINE and never as JS values.
	 *
	 * This used to ask for rows, `JSON.parse` them, run `toScryfallCard` over all 175, and
	 * `JSON.stringify` the result — four passes over a ~635KB payload to produce bytes the engine
	 * could have written itself. Measured, the Durable Object's CPU is very nearly a pure function
	 * of payload bytes (~15us/KB), while building a card object is ~16us per CARD, so those passes
	 * were the cost and the construction was not.
	 *
	 * `toScryfallCard` remains the reference implementation, and
	 * tests/routes/card-object-parity.test.ts holds the engine to it byte for byte — the route
	 * splices these bytes into a response envelope without parsing them, so nothing downstream
	 * would notice a divergence.
	 */
	async scryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult> {
		const answer = this.w.scryfall_search(
			opts.filterTreeJson,
			this.optsJson({ ...opts, fields: [...CARD_OBJECT_FIELDS] }),
			baseUrl,
		);
		// `<total> <rowCount> <widened>\n<cards>`, the same framing query_rows uses plus the
		// widening flag; only the short ASCII prefix is decoded and the cards stay bytes all the
		// way to the response body.
		const split = answer.indexOf(NEWLINE);
		const [total = "0", rows = "0", widened = "0"] = new TextDecoder().decode(answer.subarray(0, split)).split(" ");
		return {
			totalCards: Number(total),
			cardsBytes: answer.subarray(split + 1),
			rowCount: Number(rows),
			widened: widened === "1",
		};
	}

	/**
	 * Whether this query would run the widened (multilingual) driver.
	 *
	 * One implementation, in the engine: `include_multilingual`, or a `card_lang` leaf in the
	 * BOUND filter. The gather path asks for it separately because it assembles its envelope from
	 * key replies rather than from a query result.
	 */
	queryWidens(opts: EngineSearchOptions): boolean {
		return this.w.query_widens(opts.filterTreeJson, this.optsJson(opts));
	}

	/** In-process: the same envelope, spliced here because there is no boundary to keep it off. */
	async scryfallSearchPage(
		opts: EngineSearchOptions,
		baseUrl: string,
		envelope: SearchPageEnvelope,
		cache: Record<string, string>,
	): Promise<Response> {
		const r = await this.scryfallSearch(opts, baseUrl);
		if (r.rowCount === 0) return emptyPageResponse(envelope, r.totalCards, cache);
		const hasMore = envelope.pageOffset + r.rowCount < r.totalCards;
		if (envelope.csv === true) return scryfallCsvResponse(r.cardsBytes, hasMore, cache);
		return scryfallListJson(
			r.cardsBytes,
			{
				totalCards: r.totalCards,
				hasMore,
				nextPage: hasMore ? withResolvedMultilingual(envelope.nextPageUrl, r.widened === true) : undefined,
				warnings: envelope.warnings,
			},
			envelope.pretty,
			cache,
		);
	}

	async scryfallCardById(scryfallId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const row = JSON.parse(
			this.w.card_by_scryfall_id(scryfallId, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallCardsByIds(scryfallIds: string[], baseUrl: string): Promise<Record<string, unknown>[]> {
		const rows = JSON.parse(
			this.w.cards_by_scryfall_ids(JSON.stringify(scryfallIds), JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow[];
		return this.toCards(rows, baseUrl);
	}

	async scryfallCardByOracleId(oracleId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const rows = JSON.parse(this.w.printings_of_oracle_id(oracleId, JSON.stringify(CARD_OBJECT_FIELDS))) as EngineRow[];
		// Printings are stored in descending default-prefer order, so the first is the
		// representative printing every other by-name path shows.
		const first = rows[0];
		return first === undefined ? null : toScryfallCard(first, baseUrl);
	}

	async scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
	): Promise<Record<string, unknown> | null> {
		const row = JSON.parse(
			this.w.card_by_external_id(namespace, BigInt(externalId), JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallFuzzyName(name: string, baseUrl: string): Promise<ScryfallFuzzyResult> {
		const out = JSON.parse(
			this.w.fuzzy_card_by_name(
				name,
				FUZZY_SIMILARITY_FLOOR,
				FUZZY_SIMILARITY_LEAD,
				JSON.stringify(CARD_OBJECT_FIELDS),
			),
		) as { status: ScryfallFuzzyResult["status"]; card: EngineRow | null };
		return { status: out.status, card: out.card === null ? null : toScryfallCard(out.card, baseUrl) };
	}

	async scryfallAutocomplete(prefix: string, limit: number): Promise<string[]> {
		return JSON.parse(this.w.autocomplete(prefix, limit)) as string[];
	}

	/**
	 * `[tier, score]` for this store's best `exact=` candidate, or null. Higher wins.
	 *
	 * The partitioned router ranks every partition with this and materializes only the winner —
	 * see PartitionedEngine.scryfallExactName for why a first-non-null merge was wrong.
	 */
	async scryfallExactNameRank(folded: string, setCode: string): Promise<number[] | null> {
		return JSON.parse(this.w.exact_name_rank(folded, setCode)) as number[] | null;
	}

	async scryfallExactName(folded: string, setCode: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const row = JSON.parse(
			this.w.exact_card_by_name(folded, setCode, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	/**
	 * The collection identifiers' own name rule, one card each — see the engine's
	 * `collection_card_by_name` for what separates it from `exact_card_by_name`.
	 *
	 * Looped HERE rather than by the caller: the loop is inside the Durable Object, so 75
	 * identifiers cost 75 wasm calls and ONE RPC instead of 75 round trips.
	 */
	async scryfallCollectionNames(
		identifiers: NameIdentifier[],
		baseUrl: string,
	): Promise<(Record<string, unknown> | null)[]> {
		return identifiers.map(({ folded, setCode }) => {
			const row = JSON.parse(
				this.w.collection_card_by_name(folded, setCode, JSON.stringify(CARD_OBJECT_FIELDS)),
			) as EngineRow | null;
			return row === null ? null : toScryfallCard(row, baseUrl);
		});
	}

	async scryfallCollectionNameRanks(identifiers: NameIdentifier[]): Promise<(number[] | null)[]> {
		return identifiers.map(
			({ folded, setCode }) => JSON.parse(this.w.collection_name_rank(folded, setCode)) as number[] | null,
		);
	}

	async scryfallCardByIllustrationId(illustrationId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const row = JSON.parse(
			this.w.card_by_illustration_id(illustrationId, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
	): Promise<Record<string, unknown>[]> {
		const rows = JSON.parse(
			this.w.cards_containing_all_words(JSON.stringify(words), setCode, limit, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow[];
		return this.toCards(rows, baseUrl);
	}

	async scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]> {
		return filterTreeJsons.map((filterTreeJson) => {
			const result = this.query({
				filterTreeJson,
				unique: "printing",
				prefer: "default",
				orderby: "edhrec",
				direction: "asc",
				limit: 1,
				offset: 0,
				fields: [...CARD_OBJECT_FIELDS],
			});
			const row = result.rows[0];
			return row === undefined ? null : toScryfallCard(row, baseUrl);
		});
	}
}

export { readManifest } from "./store-kv";

/** Stream the store bytes into wasm memory, in blocks (see load-blocks.ts for why). */
async function feedStore(
	w: wasm.EngineHandle,
	body: ReadableStream<Uint8Array>,
	totalLen: number,
	sink: CacheWriter | null,
): Promise<FeedCounts> {
	w.begin_store_load(totalLen);
	const counts = await feedBlocks(body, (block) => {
		w.store_load_chunk(block);
		sink?.write(block);
	});
	w.finish_store_load();
	return counts;
}

/** archiveOfManifest as a question rather than a refusal — for the publish
 * paths, where a shape this object cannot serve means "keep the current store
 * and ack", never a failed phase. Request paths use the throwing form. */
function tryArchiveOfManifest(manifest: StoreManifest, partition?: number): ArchiveSource | null {
	try {
		return archiveOfManifest(manifest, partition);
	} catch {
		return null;
	}
}

/**
 * The archive's bytes, and — on a miss — a sink that caches them AS THEY GO PAST.
 *
 * The fill used to re-stream the archive from KV under `waitUntil`, which meant a cold load that
 * missed the cache fetched and decompressed the same ~84MB TWICE. That was justified on the
 * grounds that the request paid neither, and that was wrong twice over: `waitUntil` bills to the
 * same invocation, and a Durable Object is single-threaded, so a background fill occupies the
 * object against every request behind it. It is what took cold CPU to 4756ms.
 *
 * Teeing costs one pass over local storage instead. The numbers make that lopsided — a cold KV read
 * is 3466-4204ms of DO CPU while the local rows are 0ms of wait — and the writes happen either way,
 * only sooner.
 *
 * Every failure here is swallowed. The cache is an optimisation over a source of truth that is
 * still KV, so a fault on this side must never fail the load that triggered it.
 */
function archiveBytes(
	ctx: LoadContext | undefined,
	key: string,
	expected: number,
	fromKv: () => ReadableStream<Uint8Array>,
): { body: ReadableStream<Uint8Array>; cached: boolean; sink: CacheWriter | null } {
	const storage = ctx?.storage;
	if (storage) {
		try {
			// The schema has to exist before the first SELECT, and the first load on a fresh Durable
			// Object is exactly when it does not — reading a table that has never been created throws.
			ensureCacheSchema(storage);
			const local = cachedArchiveStream(storage, key, expected);
			if (local) return { body: local, cached: true, sink: null };
		} catch (err) {
			// A cache that cannot be read is a cache miss, never a failed load. This catch is what
			// makes "KV is the source of truth" true in the code and not just in the comments: every
			// fault on this side — no schema, corrupt row, storage unavailable — falls through to KV.
			console.warn(`${tag(ctx)}local archive cache unreadable for ${key} (falling back to KV): ${err}`);
		}
	}
	let sink: CacheWriter | null = null;
	if (storage) {
		try {
			sink = cacheWriter(storage, key, expected);
		} catch (err) {
			console.warn(`${tag(ctx)}local archive cache unwritable for ${key} (serving from KV anyway): ${err}`);
		}
	}
	return { body: fromKv(), cached: false, sink };
}

/**
 * The COMPRESSED-cache twin of archiveBytes, and the path every real archive
 * takes (plan reconciliation 2 — see the store-cache.ts header for why N
 * decompressed partition copies do not fit the 5GB DO pool).
 *
 * On a hit the body is the local compressed copy DECOMPRESSING as it streams;
 * on a miss it is the KV stream with each stored chunk tee'd into the cache
 * before decompression — each chunk commits meta-last as a unit, and the copy
 * only becomes readable as a whole when every chunk is present and their bytes
 * sum to the manifest's store_gzip_bytes (isCompressedCached). `commit` prunes
 * once wasm has accepted the archive; `invalidate` is the readable-and-wrong
 * escape hatch — a cached copy that fails to load is dropped so the next
 * attempt reads KV instead of re-reading the same corrupt rows (the 2026-08-13
 * lesson, applied to this cache from birth).
 */
function compressedArchiveBytes(
	env: Env,
	ctx: LoadContext | undefined,
	source: ArchiveSource,
): { body: ReadableStream<Uint8Array>; cached: boolean; commit: () => void; invalidate: () => void } {
	const storage = ctx?.storage;
	const gzipBytes = source.gzipBytes as number; // callers gate on presence
	const chunkCount = source.chunkCount as number; // compressed manifests always carry it (kvArchiveStream enforces)
	const keys = compressedCacheKeys(source.storeKey, chunkCount);
	const dropAll = () => {
		if (!storage) return;
		try {
			for (const k of keys) dropCached(storage, k);
		} catch (err) {
			console.warn(`${tag(ctx)}could not drop the compressed cache for ${source.storeKey}: ${err}`);
		}
	};
	if (storage) {
		try {
			ensureCacheSchema(storage);
			const local = cachedCompressedStream(storage, source.storeKey, chunkCount, gzipBytes);
			if (local) return { body: local, cached: true, commit: () => {}, invalidate: dropAll };
		} catch (err) {
			console.warn(
				`${tag(ctx)}compressed archive cache unreadable for ${source.storeKey} (falling back to KV): ${err}`,
			);
		}
	}
	// Miss: read KV, teeing each STORED chunk in. Tee faults must never fail the
	// load — warn once and stop writing, exactly like the decompressed sink.
	let teeBroken = storage === undefined;
	const tee = (seq: number, bytes: Uint8Array) => {
		if (teeBroken || !storage) return;
		try {
			putCompressedChunk(storage, source.storeKey, seq, bytes);
		} catch (err) {
			teeBroken = true;
			console.warn(`${tag(ctx)}compressed archive cache unwritable for ${source.storeKey} (KV still serves): ${err}`);
		}
	};
	return {
		body: kvSourceStream(env, source, storage ? tee : undefined),
		cached: false,
		commit: () => {
			if (!storage || teeBroken) return;
			try {
				if (!isCompressedCached(storage, source.storeKey, chunkCount, gzipBytes)) {
					console.warn(`${tag(ctx)}compressed cache for ${source.storeKey} is incomplete after the load; not kept`);
					dropAll();
					return;
				}
				const dropped = pruneCache(storage, keys);
				console.log(
					`${tag(ctx)}cached ${source.storeKey} compressed while loading it (${chunkCount} chunks)` +
						`${dropped.length ? `, dropped ${dropped.length} stale` : ""}`,
				);
			} catch (err) {
				console.warn(`${tag(ctx)}could not keep the compressed cache for ${source.storeKey}: ${err}`);
			}
		},
		invalidate: dropAll,
	};
}

/**
 * Publish a tee'd copy, or discard it — called once the archive is known good.
 *
 * Committed only AFTER the wasm side has accepted the bytes, so a load that dies mid-stream leaves
 * an uncommitted copy that no reader can see, and the next cold load refills.
 */
function commitSink(
	ctx: LoadContext | undefined,
	sink: CacheWriter | null,
	key: string,
	keep: readonly string[],
): void {
	if (!sink) return;
	try {
		const rows = sink.commit();
		if (rows === 0) {
			console.warn(`${tag(ctx)}archive cache for ${key} did not match its manifest length; not cached`);
			return;
		}
		const dropped = ctx?.storage ? pruneCache(ctx.storage, keep) : [];
		console.log(
			`${tag(ctx)}cached ${key} locally while loading it (${rows} rows)` +
				`${dropped.length ? `, dropped ${dropped.length} stale` : ""}`,
		);
	} catch (err) {
		console.warn(`${tag(ctx)}could not cache ${key} locally (KV still serves): ${err}`);
	}
}

async function loadStore(env: Env, ctx?: LoadContext, known?: StoreManifest): Promise<Engine> {
	const state = stateFor(ctx?.label);
	// The one place wasm is first touched, so the one place that has to bring it
	// up — one INSTANCE per label, because colocated partition objects share this
	// module (see wasm-shim.ts). Isolates that only parse and RPC never reach
	// here and never pay the instantiation.
	const w = wasm.engineFor(ctx?.label ?? "");
	// Three sources, in order of what they cost.
	//
	// `known` is the publisher handing it over during a swap. Otherwise the object may already have
	// been TOLD what is live (recordLiveManifest, written by notifyPublish even when this object was
	// cold), and starting from that takes the last KV round trip off the cold path — ~124-129ms,
	// against 0ms for everything else once the archive is cached locally.
	//
	// A pushed manifest is not blindly trusted. Its one failure mode is a publish this object was
	// never told about — a deploy publishes without notifying, and a notify can exhaust its
	// retries — so KV is read CONCURRENTLY and checked before the engine is committed. That
	// overlaps the round trip with the load instead of serving anything stale: the cost of being
	// wrong is one discarded load, not one wrong answer.
	let manifest = known;
	let confirm: Promise<StoreManifest | null> | null = null;
	if (!manifest && ctx?.storage) {
		const pushed = readLiveManifest(ctx.storage) as StoreManifest | null;
		if (pushed?.store_bytes) {
			// The guard on pushed state (the notify side refuses to record a shape
			// this object cannot serve, but a record written before that guard —
			// or by a skewed build — could still be here): a pushed manifest this
			// object's own name cannot serve is IGNORED, loudly, and the load
			// falls through to KV. Trusting it would wedge every wake on
			// archiveOfManifest's refusal without KV ever being consulted.
			if (tryArchiveOfManifest(pushed, ctx.partition)) {
				manifest = pushed;
				confirm = readManifest(env).catch(() => null);
			} else {
				console.error(
					`${tag(ctx)}ignoring a pushed manifest this object cannot serve ` +
						`(${pushed.store_key}, partition_count ${pushed.partition_count ?? "none"} vs own partition ` +
						`${ctx.partition ?? "none"}); reading the manifest from KV instead`,
				);
			}
		}
	}
	if (!manifest) manifest = (await readManifest(env)) ?? undefined;

	if (!manifest) {
		// Deliberately does NOT start an import. Building the card index is the
		// deploy's job, where there is time and memory to do it in, and a
		// failure fails the deploy. A request finding no store means the deploy
		// did not publish one — kicking a rebuild here would hide that, once
		// per visitor.
		throw new EngineUnavailableError("No store manifest in KV; deploy has not published an index");
	}

	if (!manifest.store_bytes || !manifest.store_key.endsWith(".store")) {
		// A manifest from an incompatible builder format. Loud, and
		// self-healing: the next publish writes the current format.
		throw new EngineUnavailableError(`Manifest ${manifest.store_key} is not in the raw store format this Worker reads`);
	}

	// WHICH archive this object loads: its own `partitions[k]`. Every refusal —
	// an unpartitioned manifest, a label carrying no partition, an unknown
	// partition hash — throws the loud 503 here, on the request path, where
	// serving anyway would mean silently answering with the wrong slice of the
	// corpus. See archiveOfManifest for the full case table.
	const source = archiveOfManifest(manifest, ctx?.partition);

	if (state.current && state.current.storeKey === source.storeKey) return state.current.engine;

	// Started here rather than after the load, so the write has the whole archive fetch to complete
	// in. Awaited below, before the engine is committed — see announceSelf for why a dropped
	// announcement is a correctness problem and not a missing log line.
	const announced = announceSelf(env, ctx?.label);

	const started = Date.now();
	// Local first (no network); KV otherwise, teeing into the cache as it streams
	// so the archive is fetched exactly once. The cache FORMAT follows the
	// ARCHIVE's: a gzipped archive — which is every archive any publisher here
	// emits — caches COMPRESSED (see compressedArchiveBytes and the store-cache.ts
	// header). The decompressed path below is what an UNCOMPRESSED archive would
	// take; it is the compression revert staying code-only (StoreManifest
	// .store_gzip_bytes is the format flag), not a partitioning fallback.
	const compressedMode = source.gzipBytes !== undefined;
	const fetch = compressedMode
		? { ...compressedArchiveBytes(env, ctx, source), sink: null as CacheWriter | null }
		: (() => {
				const f = archiveBytes(ctx, source.storeKey, source.storeBytes, () => kvSourceStream(env, source));
				return {
					body: f.body,
					cached: f.cached,
					sink: f.sink,
					commit: () => commitSink(ctx, f.sink, source.storeKey, [source.storeKey]),
					invalidate: () => f.sink?.abort(),
				};
			})();
	const { body, cached, sink } = fetch;
	if (state.current) {
		// Hot swap: requests arriving during the swap await `loading` (set by
		// getEngine), so a brief unloaded window is invisible to callers.
		state.current = null;
		w.unload_store();
	}
	// GZIPPED in KV (see StoreManifest.store_gzip_bytes), decompressed per chunk
	// as it streams. The meter argument against this was sound but answered the
	// wrong question: KV reads are charged per read rather than per byte, yet the
	// cold path is bound by neither. Measured on production over 3 days (n=121
	// cold loads): wall p50 915ms against DO CPU p50 164ms, so ~750ms was pure
	// I/O wait for ~84MB. Compression buys that back and costs CPU for it —
	// ~190ms of DecompressionStream per load in workerd — which is why this is a
	// trade, not a free win, and why `store_gzip_bytes` is a flag the reader can
	// still see absent.
	let counts: FeedCounts;
	try {
		counts = await feedStore(w, body, source.storeBytes, sink);
	} catch (err) {
		// A PUSHED manifest can name a store that no longer loads — its archive header no longer
		// matches this build, or its chunks were pruned by a deploy that published without
		// notifying. The confirm read below was started for exactly this doubt, but it used to be
		// consulted only AFTER a successful load, so a failing pushed manifest wedged the object:
		// every wake re-read the same stale record, failed the same way, and nothing ever asked KV
		// what is actually live. Production, 2026-08-13: a generation bump pruned the old chunks
		// and every engine object answered 5xx until this fallback existed.
		//
		// PER-PARTITION: the comparison is between THIS PARTITION's chunk-family
		// keys under each manifest, not the manifests' top-level keys — a v2
		// store_key is a stem holding no chunks, so comparing stems would both
		// miss real changes (same stem, republished partition) and be blind to
		// what this object actually failed to read.
		if (compressedMode && cached) fetch.invalidate();
		if (confirm) {
			const truth = await confirm;
			const truthSource = truth?.store_bytes ? tryArchiveOfManifest(truth, ctx?.partition) : null;
			if (truthSource && truthSource.storeKey !== source.storeKey) {
				console.warn(
					`${tag(ctx)}the pushed manifest named ${source.storeKey}, which failed to load (${err}); ` +
						`KV says ${truthSource.storeKey} — reloading from that`,
				);
				fetch.invalidate();
				w.unload_store();
				// Overwrite the stale record so the NEXT wake starts from the store that exists,
				// instead of paying this failed load again.
				if (ctx?.storage) recordLiveManifest(ctx.storage, truth);
				return loadStore(env, ctx, truth ?? undefined);
			}
		}
		throw err;
	}
	const { pieces, blocks } = counts;

	// The confirmation, awaited only now: it has had the whole load to arrive, so in the common case
	// this costs nothing. A mismatch means the pushed manifest was stale, and the load just done is
	// discarded rather than served.
	if (confirm) {
		const truth = await confirm;
		const truthSource = truth?.store_bytes ? tryArchiveOfManifest(truth, ctx?.partition) : null;
		if (truthSource && truthSource.storeKey !== source.storeKey) {
			console.warn(
				`${tag(ctx)}the pushed manifest named ${source.storeKey} but KV says ${truthSource.storeKey}; reloading`,
			);
			fetch.invalidate();
			w.unload_store();
			return loadStore(env, ctx, truth ?? undefined);
		}
	}
	fetch.commit();

	// The announcement started before the load must have LANDED before this object starts answering
	// from the store it just loaded: the fan-out reaches exactly the objects in that set, and guessing
	// the set instead would mean creating objects, which is what fixes an object's region forever.
	// See REGION_LIVE_PREFIX and announceSelf. In the common case this has long since resolved.
	await announced;

	if (ctx?.label) {
		// And report WHERE it is, which nothing else can: a cold load is the one moment an object may
		// have just been created, and creation is when its region was fixed forever. Throttled and
		// fire-and-forget; see placement.ts for why this must never move onto the request path.
		probePlacement(ctx);
	}

	const engine = new WasmEngine(w);
	state.current = { storeKey: source.storeKey, engine, manifest, handle: w };
	// The `in NNNms` is I/O WAIT ONLY — Workers freeze the clock during
	// synchronous execution, so it cannot see the decompression or the copy into
	// wasm. Judge this path by cpuTimeMs from the invocation's own event; the
	// linear-memory figure is the honest one here, and is a high-water mark.
	console.log(
		`${tag(ctx)}store loaded from ${cached ? "local cache" : "KV"}: ${source.storeKey} (${source.cardCount} cards, ` +
			`${source.storeBytes} bytes${!cached && source.gzipBytes ? ` from ${source.gzipBytes} gzipped` : ""}, ` +
			`built ${manifest.built_at}) in ${Date.now() - started}ms from ${pieces} pieces in ${blocks} blocks ` +
			`(linear memory ${(w.linearMemoryBytes() / 1048576).toFixed(1)}MB)`,
	);
	return engine;
}

/**
 * Pick up a newly published store NOW: prefetch it locally, then swap.
 *
 * Called by the publisher through SearchEngine.notifyPublish, which is the ONLY
 * way a warm reader learns about a publish. There used to be a 5-minute manifest
 * re-check on the warm path instead, and the whole shape of the publish pipeline
 * was built around not being able to see when readers had converged — a 10-minute
 * purge delay sized to outlast the poll, and a second purge pass to catch colos
 * that had not polled yet. Push makes convergence an event, so all of that is
 * gone rather than tuned.
 *
 * THE PREFETCH IS THE POINT, not an optimisation. `loadStore` must unload the old
 * store before loading the new one — two ~84MB archives do not fit in a 128MB
 * isolate — so requests arriving during the swap wait for the whole load. Filling
 * the local cache FIRST, while the old store is still serving, turns that wait
 * from a KV fetch plus a decompression into a read from local SQLite.
 *
 * Returns whether it actually swapped, so the caller can distinguish "converged"
 * from "was already current".
 */
export async function refreshNow(env: Env, ctx: LoadContext, known?: StoreManifest): Promise<boolean> {
	// `known` is the manifest the PUBLISHER just wrote and is holding. Taking it
	// skips a KV round trip that is pure waste on this path: measured at ~124ms,
	// paid by every region, for a value the caller already has in hand. It is only
	// ever supplied over RPC by our own coordinator, and loadStore re-validates the
	// shape below regardless, so a bad one fails the load rather than being served.
	const manifest = known ?? (await readManifest(env));
	if (!manifest?.store_bytes) return false;
	await prefetchStore(env, ctx, manifest);
	return swapToStore(env, ctx, manifest);
}

/**
 * Step 1 of the two-step publish, in the loader's terms: hold the new archive
 * in LOCAL storage, swapping nothing. The old store serves throughout.
 *
 * The FORMAT held follows the ARCHIVE's, exactly as a cold load's does: a
 * gzipped archive is prefetched as its COMPRESSED chunks (fetched whole from KV,
 * no decompression paid for bytes that are only being staged — the gunzip lands
 * at the commit swap, still the publisher's window and not a user's request);
 * the decompressed branch is the uncompressed-archive twin (see loadStore).
 *
 * Returns false — never throws — when there is nothing this object can hold: no
 * storage, a manifest shape this object's name cannot serve (which is a bug, not
 * a mode — it keeps its current store and the publish phase still completes), or
 * a prefetch fault (the commit swap falls back to KV, which is what this path
 * did before the cache existed). The publish phase must degrade to slower, never
 * to failed.
 */
export async function prefetchStore(env: Env, ctx: LoadContext, manifest: StoreManifest): Promise<boolean> {
	if (!ctx.storage) return false;
	const source = tryArchiveOfManifest(manifest, ctx.partition);
	if (!source) {
		console.warn(
			`${tag(ctx)}not prefetching ${manifest.store_key}: this object cannot serve that manifest shape ` +
				`(partition ${ctx.partition ?? "none"} vs partition_count ${manifest.partition_count ?? "none"})`,
		);
		return false;
	}
	if (stateFor(ctx.label).current?.storeKey === source.storeKey) return false;
	try {
		ensureCacheSchema(ctx.storage);
		if (source.gzipBytes !== undefined) {
			const chunkCount = source.chunkCount as number;
			if (!isCompressedCached(ctx.storage, source.storeKey, chunkCount, source.gzipBytes)) {
				for (let seq = 0; seq < chunkCount; seq++) {
					putCompressedChunk(ctx.storage, source.storeKey, seq, await fetchStoredChunk(env, source.storeKey, seq));
				}
			}
			const dropped = pruneCache(ctx.storage, compressedCacheKeys(source.storeKey, chunkCount));
			console.log(
				`${tag(ctx)}prefetched ${source.storeKey} (${chunkCount} compressed chunks) before swapping` +
					`${dropped.length ? `, dropped ${dropped.length} stale` : ""}`,
			);
		} else {
			const rows = await fillCache(ctx.storage, source.storeKey, kvSourceStream(env, source), source.storeBytes);
			const dropped = pruneCache(ctx.storage, [source.storeKey]);
			console.log(
				`${tag(ctx)}prefetched ${source.storeKey} (${rows} rows) before swapping` +
					`${dropped.length ? `, dropped ${dropped.length} stale` : ""}`,
			);
		}
		return true;
	} catch (err) {
		console.warn(`${tag(ctx)}prefetch failed, a swap will read from KV: ${err}`);
		return false;
	}
}

/**
 * Step 2: the swap itself — local when the prefetch landed, KV otherwise.
 *
 * Single-flighted per label through the same `loading` slot getEngine uses, so
 * requests arriving during the swap wait on the load rather than observing the
 * unloaded window. A manifest shape this object cannot serve reports
 * `false` (kept its current store) for the same publish-must-not-fail reason as
 * prefetchStore; a shape it CAN serve that fails to load still throws, because
 * that is a real fault the publish phase must see and retry.
 */
export async function swapToStore(env: Env, ctx: LoadContext, manifest: StoreManifest): Promise<boolean> {
	const state = stateFor(ctx.label);
	const source = tryArchiveOfManifest(manifest, ctx.partition);
	if (!source) {
		console.warn(
			`${tag(ctx)}not swapping to ${manifest.store_key}: this object cannot serve that manifest shape; ` +
				`it keeps serving ${state.current?.storeKey ?? "nothing"}`,
		);
		return false;
	}
	if (state.current?.storeKey === source.storeKey) return false;
	state.loading = loadStore(env, ctx, manifest).finally(() => {
		state.loading = null;
	});
	await state.loading;
	return true;
}

export async function getEngine(env: Env, ctx: LoadContext): Promise<Engine> {
	// No manifest re-check on the warm path: a publish reaches this isolate by
	// being pushed to it, so the hot path does no KV read at all.
	const state = stateFor(ctx.label);
	if (state.current) {
		return state.current.engine;
	}
	if (!state.loading) {
		state.loading = loadStore(env, ctx).finally(() => {
			state.loading = null;
		});
	}
	return state.loading;
}

/** Non-blocking: the label's engine if this isolate is already warm, else null. */
export function tryGetLoadedEngine(label?: string): Engine | null {
	return stateFor(label).current?.engine ?? null;
}

/** The manifest the label's loaded store came from, or null when cold — how the
 * gather learns partition_count without a KV read on the request path. */
export function currentManifest(label?: string): StoreManifest | null {
	return stateFor(label).current?.manifest ?? null;
}

/**
 * The two-phase gather's view of a LOADED store (plan B5): the phase-1/phase-2
 * wasm exports plus the identity facts the protocol rides on — which archive
 * answered (the pinned-generation check) and which sort-key version its keys
 * carry (streams from disagreeing builds must never be merged).
 *
 * Null when nothing is loaded for this label; the Durable Object acquires its
 * engine FIRST (which loads on a cold sibling) and only then asks for this, so
 * null here is a bug surfacing, not a state to serve through.
 */
export interface GatherOps {
	/** The loaded archive's chunk-family key (carries `-p<k>` when partitioned). */
	storeKey: string;
	sortKeyVersion(): number;
	/** `inlineRows` folds phase 2 into phase 1: the rows for the first N entries
	 * ride back with the keys (see gather.ts's inlineRowBudget). */
	queryKeys(opts: EngineSearchOptions, inlineRows: number): Uint8Array;
	fetchRows(vpids: number[], fields: string[]): Uint8Array;
	/** This partition's scores-bearing fuzzy candidates (the cross-partition race's phase 1). */
	fuzzyCandidates(name: string): FuzzyCandidateWire[];
}

/** Decode `fuzzy_candidates`' packed reply: `n: u32, then n of (score: f32, oracle_id: 16B,
 * vpid: u32, namelen: u16, name)`, all LITTLE-ENDIAN except the oracle's raw uuid bytes. */
function decodeFuzzyCandidates(packed: Uint8Array): FuzzyCandidateWire[] {
	const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
	const n = view.getUint32(0, true);
	const out: FuzzyCandidateWire[] = [];
	let at = 4;
	for (let i = 0; i < n; i++) {
		const score = view.getFloat32(at, true);
		at += 4;
		const hex = Array.from(packed.subarray(at, at + 16), (b) => b.toString(16).padStart(2, "0")).join("");
		at += 16;
		const oracleId =
			hex === "00000000000000000000000000000000"
				? ""
				: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		const vpid = view.getUint32(at, true);
		at += 4;
		const len = view.getUint16(at, true);
		at += 2;
		const foldedName = new TextDecoder().decode(packed.subarray(at, at + len));
		at += len;
		out.push({ score, oracleId, vpid, foldedName });
	}
	return out;
}

/** How many candidate classes each partition ships the race — see the wasm export's docstring
 * for why 8 makes the bounded reply practically exact. */
const FUZZY_CANDIDATE_CLASSES = 8;

export function gatherOps(label?: string): GatherOps | null {
	const current = stateFor(label).current;
	if (!current) return null;
	const { handle, engine, storeKey } = current;
	return {
		storeKey,
		sortKeyVersion: () => handle.sort_key_version(),
		queryKeys: (opts, inlineRows) => handle.query_keys(opts.filterTreeJson, engine.optsJsonFor(opts), inlineRows),
		fetchRows: (vpids, fields) => handle.fetch_rows(Uint32Array.from(vpids), JSON.stringify(fields)),
		fuzzyCandidates: (name) =>
			decodeFuzzyCandidates(handle.fuzzy_candidates(name, FUZZY_SIMILARITY_FLOOR, FUZZY_CANDIDATE_CLASSES)),
	};
}
