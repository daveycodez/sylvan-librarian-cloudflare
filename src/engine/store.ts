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
// the 5GB DO pool), so a cached wake skips the fetch and still pays the inflate —
// which runs inside the engine (feedStore), not through DecompressionStream.

import * as wasm from "sylvan-engine-wasm";
import {
	CARD_OBJECT_FIELDS,
	type EngineRow,
	toScryfallCard,
	withResolvedMultilingual,
} from "../routes/scryfall-compat/objects";
import { emptyPageResponse, scryfallCsvResponse, scryfallListJson } from "../routes/scryfall-compat/respond";
import { encodeUtf8, NEWLINE } from "./bytes";
import { collectionBatchRequest, decodeCollectionPacket } from "./collection-batch";
import { serializeCards } from "./columnar";
import type { RowShaping } from "./gather";
import { type FeedCounts, feedBlocks } from "./load-blocks";
import { probePlacement } from "./placement";
import {
	type ArchiveCacheStorage,
	announcedFor,
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
	recordAnnounced,
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
	CollectionBatch,
	CollectionBatchAnswer,
	CollectionKeyIdentifier,
	CollectionScope,
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
	current: {
		storeKey: string;
		engine: WasmEngine;
		manifest: StoreManifest;
		handle: wasm.EngineHandle;
		/** The wasm instance generation the store was loaded into (see liveCurrent). */
		generation: number;
	} | null;
	/** The ONE load in flight for this label, whoever started it (getEngine or swapToStore). */
	loading: Promise<Engine> | null;
	/** The one refreshNow in flight: concurrent callers are all reacting to the same publish. */
	refreshing: Promise<boolean> | null;
	/** The last request-path load that failed, while its backoff window is open. See getEngine. */
	lastLoadFailure: { at: number; message: string } | null;
}

/**
 * How long getEngine refuses to start another load after one failed. A load that fails costs
 * a KV round trip per chunk, a full inflate and — before the wasm crate recycled the buffer
 * of a failed load — a partition of linear memory, and getEngine used to start a fresh one on
 * the very next request: a partition whose chunks had been swept answered 503 AND reset its
 * isolate every few requests. Seconds, not minutes: the next publish or a stale-modulus retry
 * should not have to wait on it, and the window only needs to outlast a burst.
 */
const LOAD_BACKOFF_MS = 5_000;

/**
 * How long one store load may take before it is abandoned.
 *
 * NOTHING ELSE BOUNDS A LOAD. It awaits KV reads, the local cache and an announcement put, and a
 * single one of those that never settles leaves the label's in-flight load pending forever — and
 * every request to that object waits on it, because loads are single-flighted. The object cannot
 * clear it by resetting itself: partition objects share one isolate (wasm-shim.ts), and this state
 * is module-level, so only a new isolate — a deploy — ever did. That is the shape of the
 * 2026-09-23 06:45–07:33 incident on DeckGen: requests routed to one object hung for 30s+ for half
 * an hour while every other object served, and the next deploy cleared it.
 *
 * A healthy load is 0.2–2s from the local cache and a few seconds from KV cold, so 20s only ever
 * catches a stall. The abandoned load is FENCED (LoadFence): if its stalled read ever resumes, it
 * throws at its next step instead of writing into the wasm instance the next load is using, and it
 * can never become the object's store.
 */
let loadDeadlineMs = 20_000;

/** For tests: shorten the load deadline. */
export function setLoadDeadlineForTests(ms: number): void {
	loadDeadlineMs = ms;
}

/** Thrown to the caller of a load that outlived LOAD_DEADLINE and was abandoned. Safe to retry. */
export class StoreLoadStalledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreLoadStalledError";
	}
}

/** Shared by one load and its deadline: once `abandoned`, the load may not touch anything again. */
interface LoadFence {
	abandoned: boolean;
	label: string;
}

function checkFence(fence: LoadFence | undefined): void {
	if (fence?.abandoned) {
		throw new StoreLoadStalledError(`[${fence.label}] store load abandoned after its deadline; not resuming it`);
	}
}

/**
 * Start `run` as the label's one in-flight load, bounded by the load deadline. Both starters —
 * a request (getEngine) and a publish swap (swapToStore) — go through here, so neither can wedge
 * the object behind a read that never returns.
 */
function startLoad(
	state: LabelState,
	label: string | undefined,
	run: (fence: LoadFence) => Promise<Engine>,
): Promise<Engine> {
	const fence: LoadFence = { abandoned: false, label: label || "default" };
	const inner = run(fence);
	// A load abandoned by its deadline may still reject later; nobody awaits it by then.
	inner.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			fence.abandoned = true;
			console.error(
				`[${fence.label}] store load did not finish within ${loadDeadlineMs}ms; abandoning it so the next ` +
					`request starts a fresh one`,
			);
			reject(
				new StoreLoadStalledError(`[${fence.label}] store load stalled for ${loadDeadlineMs}ms and was abandoned`),
			);
		}, loadDeadlineMs);
	});
	const loading: Promise<Engine> = Promise.race([inner, deadline]).finally(() => {
		clearTimeout(timer);
		if (state.loading === loading) state.loading = null;
	});
	state.loading = loading;
	return loading;
}
const states = new Map<string, LabelState>();

/**
 * The label's loaded store — ONLY if the wasm instance it was loaded into is still the live one.
 *
 * A trap drops the label's instance (wasm-shim.ts dropInstance) and the store goes with it, but
 * `current` would keep pointing at the dead instance's engine: the next publish would unload into
 * a fresh, empty instance and every query would answer "no store loaded". Checking the generation
 * turns that into an ordinary cold load on the next request.
 */
function liveCurrent(state: LabelState, label: string | undefined): LabelState["current"] {
	const current = state.current;
	if (current && current.handle.instanceGeneration() !== current.generation) {
		console.error(
			`[${label || "default"}] the engine instance holding ${current.storeKey} was lost to a trap; reloading`,
		);
		state.current = null;
	}
	return state.current;
}

function stateFor(label: string | undefined): LabelState {
	const key = label ?? "";
	let s = states.get(key);
	if (!s) {
		s = { current: null, loading: null, refreshing: null, lastLoadFailure: null };
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
	 * THIS IS THE SINGLE-STORE TWIN. The deployment is partitioned, so `/cards/search` runs the
	 * two-phase gather instead (search-engine-do.ts's `gatherScryfallSearchLocal`) — and for a
	 * while that gather did exactly the four passes this comment says were removed, because it
	 * asked the partitions for rows and rebuilt the cards in TypeScript. It now asks for the
	 * `"cards"` row shape: `query_keys` and `fetch_rows` write each row through the same
	 * `write_scryfall_card` this export runs over a page, and the coordinator splices the frames
	 * by memcpy (gather.ts's joinJsonArray). One writer, two transports, the same bytes.
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
		scope?: CollectionScope | null,
	): Promise<(Record<string, unknown> | null)[]> {
		// ONE wasm call for the batch: the engine binds the scope once and reuses it for every
		// identifier (see `collection_cards_by_names`), and the boundary is crossed once.
		const rows = JSON.parse(
			this.w.collection_cards_by_names(
				JSON.stringify(identifiers.map(({ folded, setCode }) => [folded, setCode])),
				JSON.stringify(CARD_OBJECT_FIELDS),
				scope?.prefer ?? "default",
				scope?.filterTreeJson ?? "",
			),
		) as (EngineRow | null)[];
		return rows.map((row) => (row === null ? null : toScryfallCard(row, baseUrl)));
	}

	async scryfallCollectionNameRanks(
		identifiers: NameIdentifier[],
		scope?: CollectionScope | null,
	): Promise<(number[] | null)[]> {
		return JSON.parse(
			this.w.collection_name_ranks(
				JSON.stringify(identifiers.map(({ folded, setCode }) => [folded, setCode])),
				scope?.prefer ?? "default",
				scope?.filterTreeJson ?? "",
			),
		) as (number[] | null)[];
	}

	async scryfallCardByIllustrationId(illustrationId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const row = JSON.parse(
			this.w.card_by_illustration_id(illustrationId, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallCardsByIdentifiers(
		identifiers: CollectionKeyIdentifier[],
		baseUrl: string,
	): Promise<(Record<string, unknown> | null)[]> {
		// One RPC in, N wasm calls: the per-kind lookups are each a single index probe, and the
		// cost this batch exists to remove is the RPC, not the probe.
		const out: (Record<string, unknown> | null)[] = [];
		for (const ident of identifiers) {
			if (ident.kind === "oracle_id") out.push(await this.scryfallCardByOracleId(ident.id, baseUrl));
			else if (ident.kind === "illustration_id") out.push(await this.scryfallCardByIllustrationId(ident.id, baseUrl));
			else out.push(await this.scryfallCardByExternalId(ident.namespace, ident.id, baseUrl));
		}
		return out;
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

	/** `collection_batch`'s packet as written — what the Durable Object hands over, one buffer. */
	scryfallCollectionPacket(batch: CollectionBatch, baseUrl: string, scope?: CollectionScope | null): Uint8Array {
		return this.w.collection_batch(collectionBatchRequest(batch, scope), JSON.stringify(CARD_OBJECT_FIELDS), baseUrl);
	}

	async scryfallCollectionBatch(
		batch: CollectionBatch,
		baseUrl: string,
		scope?: CollectionScope | null,
	): Promise<CollectionBatchAnswer> {
		return decodeCollectionPacket(this.scryfallCollectionPacket(batch, baseUrl, scope), batch);
	}
}

/**
 * A loaded store's collection packet, for the SearchEngine RPC: the packet crosses as ONE buffer
 * rather than as the decoded answer's per-card views, which the RPC would have to serialize as
 * separate values. Only a local store has a packet; anything else is a wiring bug.
 */
export function collectionPacketOf(
	engine: Engine,
	batch: CollectionBatch,
	baseUrl: string,
	scope: CollectionScope | null,
): Uint8Array {
	if (!(engine instanceof WasmEngine)) throw new Error("collection packets come from a loaded store only");
	return engine.scryfallCollectionPacket(batch, baseUrl, scope);
}

export { readManifest } from "./store-kv";

/**
 * announceSelf, at most once per object per STORE rather than once per wake.
 *
 * The key's value never changes ("1"), yet every cold load rewrote it — and an idle object is
 * hibernated after ~10s, so a load is not rare: measured 2026-09-22, DeckGen's partitions reloaded
 * ~500 times an hour, which is ~12,000 KV writes a day against the free plan's 1,000. The flag
 * sits in this object's own storage, and is keyed by the store it announced for, so the write is
 * repeated once per publish: if the key was ever deleted by hand without releasing the object,
 * the next generation puts it back. A write that failed is not recorded, so the next load retries.
 */
async function announceSelfOnce(env: Env, ctx: LoadContext | undefined, storeKey: string): Promise<void> {
	const storage = ctx?.storage;
	if (!ctx?.label) return;
	if (storage && announcedFor(storage) === storeKey) return;
	const landed = await announceSelf(env, ctx.label);
	if (!landed || !storage) return;
	try {
		recordAnnounced(storage, storeKey);
	} catch (err) {
		// Unrecorded means the next load writes the key again: redundant, never missing.
		console.warn(`${tag(ctx)}could not record the announcement locally: ${err}`);
	}
}

/**
 * The ceiling on one COMPRESSED crossing into the engine's inflater.
 *
 * wasm-bindgen copies each crossing through a scratch allocation inside linear memory, and linear
 * memory never shrinks, so the largest crossing is paid for the rest of the instance's life. A
 * KV chunk arrives as ONE ~14MB value; crossed whole it would leave every partition object ~14MB
 * heavier against the 128MB isolate it may share with a sibling. At 1MB the scratch is noise and a
 * 14MB partition is ~15 crossings, which is nothing next to the ~10,000 4KB pieces the
 * DecompressionStream path crossed.
 */
const GZIP_FEED_BYTES = 1024 * 1024;

/**
 * Stream the store bytes into wasm memory, in blocks (see load-blocks.ts for why).
 *
 * `gzipped` bytes are the stored gzip members, inflated INSIDE the engine straight into the store
 * buffer (see begin_store_load_gzip in engine/wasm/src/lib.rs for the measurement that moved the
 * gunzip there: 306-752ms of DO CPU per partition through DecompressionStream in workerd).
 */
async function feedStore(
	w: wasm.EngineHandle,
	body: ReadableStream<Uint8Array>,
	totalLen: number,
	sink: CacheWriter | null,
	gzipped = false,
	fence?: LoadFence,
): Promise<FeedCounts> {
	// Every call into the instance is fenced: an abandoned load whose read resumes must not feed
	// the buffer a newer load is filling.
	checkFence(fence);
	if (gzipped) {
		w.begin_store_load_gzip(totalLen);
		const counts = await feedBlocks(
			body,
			(block) => {
				checkFence(fence);
				w.store_load_gzip_chunk(block);
			},
			GZIP_FEED_BYTES,
		);
		checkFence(fence);
		w.finish_store_load_gzip();
		return counts;
	}
	w.begin_store_load(totalLen);
	const counts = await feedBlocks(body, (block) => {
		checkFence(fence);
		w.store_load_chunk(block);
		sink?.write(block);
	});
	checkFence(fence);
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
 * Either way the body is the archive STILL COMPRESSED — the stored gzip members,
 * which the engine inflates itself (feedStore). On a hit it is the local copy;
 * on a miss it is the KV stream with each stored chunk tee'd into the cache as
 * it passes — each chunk commits meta-last as a unit, and the copy
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
			const local = cachedCompressedStream(storage, source.storeKey, chunkCount, gzipBytes, false);
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
		body: kvSourceStream(env, source, storage ? tee : undefined, false),
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

async function loadStore(env: Env, ctx?: LoadContext, known?: StoreManifest, fence?: LoadFence): Promise<Engine> {
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
	// retries — so KV is read and checked BEFORE anything is loaded.
	//
	// It used to be read concurrently and checked after the load, on the theory that the cost of
	// a stale record was one discarded load. It is not: wasm linear memory never shrinks, so an
	// object that loaded a stale 41MB partition and then the live 44MB one sat at 86MB for the
	// rest of its life, and two partition objects share an isolate (wasm-shim.ts). On 2026-09-18
	// a deploy-path publish left every object's record one build behind; wnam's p7 and p9,
	// colocated, double-loaded on every wake, took the isolate past 128MB together, were reset,
	// woke, and did it again — about once every 80 seconds for half an hour, with every request
	// from the region fanned out into them and waiting. The record was never corrected because
	// only the failed-load path wrote the truth back. One KV round trip (~125ms, colo-cached
	// for 60s) in front of a 400-900ms load is the price of never loading twice.
	let manifest = known;
	// KV's manifest, held only when the pushed record was NEWER than it and was
	// loaded on that basis: if the record's chunks turn out to be gone, this is
	// what the object falls back to. See the tiebreak below.
	let fallback: StoreManifest | null = null;
	if (!manifest && ctx?.storage) {
		const pushed = readLiveManifest(ctx.storage) as StoreManifest | null;
		if (pushed?.store_bytes) {
			// The guard on pushed state (the notify side refuses to record a shape
			// this object cannot serve, but a record written before that guard —
			// or by a skewed build — could still be here): a pushed manifest this
			// object's own name cannot serve is IGNORED, loudly, and the load
			// falls through to KV. Trusting it would wedge every wake on
			// archiveOfManifest's refusal without KV ever being consulted.
			const pushedSource = tryArchiveOfManifest(pushed, ctx.partition);
			if (pushedSource) {
				// PER-PARTITION: the comparison is between THIS PARTITION's chunk-family keys under
				// each manifest, not the manifests' top-level keys — a v2 store_key is a stem
				// holding no chunks, so comparing stems would miss a republished partition.
				const truth = await readManifest(env).catch(() => null);
				const truthSource = truth?.store_bytes ? tryArchiveOfManifest(truth, ctx.partition) : null;
				if (truth && truthSource && truthSource.storeKey !== pushedSource.storeKey) {
					// THE TIEBREAK IS built_at. KV's manifest is colo-cached for 60s, and in
					// any colo with traffic it is essentially always cached (isolates re-read
					// it every minute), so for the first minute after a publish this read
					// answers the PREVIOUS generation. A record newer than that is not stale —
					// it is the publish the coordinator just pushed, which has already counted
					// this object as converged and is about to purge the edge cache. Loading
					// KV's here loaded the old generation, overwrote the record with it, and
					// left the object refilling the 16h /cards/* tier with old answers (point
					// lookups carry no generation check). So a newer record is loaded on its
					// own authority, with KV's as the fallback should its chunks be gone; an
					// OLDER record is the 2026-09-18 case (pruned chunks) and KV still wins.
					// NaN compares false, so an unparseable built_at keeps KV-wins.
					if (Number(pushed.built_at) > Number(truth.built_at)) {
						console.log(
							`${tag(ctx)}the recorded manifest names ${pushedSource.storeKey} (built ${pushed.built_at}), ` +
								`newer than KV's colo-cached ${truthSource.storeKey} (built ${truth.built_at}); loading the record's`,
						);
						manifest = pushed;
						fallback = truth;
					} else {
						console.warn(
							`${tag(ctx)}the recorded manifest names ${pushedSource.storeKey} but KV says ` +
								`${truthSource.storeKey}; loading KV's and correcting the record`,
						);
						// Overwrite the stale record so the NEXT wake starts from the store that is live,
						// instead of paying this round trip's discovery again.
						recordLiveManifest(ctx.storage, truth);
						manifest = truth;
					}
				} else {
					// KV agreed, or could not be read: the record is the best answer there is.
					manifest = pushed;
				}
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

	const loaded = liveCurrent(state, ctx?.label);
	if (loaded && loaded.storeKey === source.storeKey) return loaded.engine;

	// Started here rather than after the load, so the write has the whole archive fetch to complete
	// in. Awaited below, before the engine is committed — see announceSelf for why a dropped
	// announcement is a correctness problem and not a missing log line.
	const announced = announceSelfOnce(env, ctx, source.storeKey);

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
	if (liveCurrent(state, ctx?.label)) {
		// Hot swap: requests arriving during the swap await `loading` (set by
		// getEngine), so a brief unloaded window is invisible to callers.
		state.current = null;
		w.unload_store();
	}
	// GZIPPED in KV (see StoreManifest.store_gzip_bytes), inflated inside the
	// engine as it streams. The meter argument against compression was sound but
	// answered the wrong question: KV reads are charged per read rather than per
	// byte, yet the cold path is bound by neither. Measured on production over 3
	// days (n=121 cold loads): wall p50 915ms against DO CPU p50 164ms, so ~750ms
	// was pure I/O wait for ~84MB. Compression buys that back and costs CPU for it.
	// The budgeted ~190ms of DecompressionStream turned out to be 306-752ms per
	// ~41MB partition once measured in isolation (2026-09-22), most of every wake;
	// the engine's own inflater (zlib-rs, in wasm) does the same partition in
	// ~105ms under V8. `store_gzip_bytes` stays a flag the reader can see absent.
	let counts: FeedCounts;
	try {
		counts = await feedStore(w, body, source.storeBytes, sink, compressedMode, fence);
	} catch (err) {
		// An abandoned load stops here: no cache invalidation it does not own, no fallback load.
		if (err instanceof StoreLoadStalledError) throw err;
		// A recorded manifest can name a store that no longer loads — its archive header no longer
		// matches this build, or its chunks were pruned by a deploy that published without
		// notifying (production, 2026-08-13: a generation bump pruned the old chunks and every
		// engine object answered 5xx). The KV check above already replaced a stale record with
		// what is live before this load began, so reaching here means KV agreed with the record,
		// or KV could not be read; either way there is nothing better to load, and the next wake
		// asks again. A tee'd cache copy of the failed load is discarded, never committed.
		if (compressedMode && cached) fetch.invalidate();
		if (fallback && ctx?.storage) {
			// The newer record's chunks are gone after all (a publish that was rolled back, or
			// retired before this object ever woke): KV's manifest was right. Correct the record
			// and load that, through the `known` form so the record logic is not re-run. The
			// failed attempt's buffer is recycled by the next begin (see the wasm crate).
			console.warn(
				`${tag(ctx)}the recorded manifest ${source.storeKey} did not load (${err}); ` +
					`falling back to KV's ${fallback.store_key} and correcting the record`,
			);
			recordLiveManifest(ctx.storage, fallback);
			return loadStore(env, ctx, fallback, fence);
		}
		throw err;
	}
	const { pieces, blocks } = counts;

	checkFence(fence);
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

	// Last gate before this load becomes the object's store: an abandoned load never does.
	checkFence(fence);
	const engine = new WasmEngine(w);
	state.current = { storeKey: source.storeKey, engine, manifest, handle: w, generation: w.instanceGeneration() };
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
	// SINGLE-FLIGHTED PER LABEL. The argument-less form is the gather's straggler
	// remedy, and every concurrent gather that meets the same straggler calls it
	// independently — within one ~125ms manifest round trip, several of them.
	// They are all reacting to the same publish, so the first one's answer is
	// every one's answer; without this each awaited its own manifest read and its
	// own prefetch (colliding on the cache's primary key) and then each started a
	// swap on top of the others' — see swapToStore for what two interleaved loads
	// do to one wasm handle.
	const state = stateFor(ctx.label);
	if (state.refreshing) return state.refreshing;
	const refreshing = (async () => {
		// `known` is the manifest the PUBLISHER just wrote and is holding. Taking it
		// skips a KV round trip that is pure waste on this path: measured at ~124ms,
		// paid by every region, for a value the caller already has in hand. It is only
		// ever supplied over RPC by our own coordinator, and loadStore re-validates the
		// shape below regardless, so a bad one fails the load rather than being served.
		const manifest = known ?? (await readManifest(env));
		if (!manifest?.store_bytes) return false;
		await prefetchStore(env, ctx, manifest);
		return swapToStore(env, ctx, manifest);
	})().finally(() => {
		if (state.refreshing === refreshing) state.refreshing = null;
	});
	state.refreshing = refreshing;
	return refreshing;
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
	if (liveCurrent(stateFor(ctx.label), ctx.label)?.storeKey === source.storeKey) return false;
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
 * unloaded window — and, the other way round, a swap arriving while a load is
 * already in flight (a cold load a request started, or another swap) WAITS for
 * it instead of starting a second one on the same wasm handle. Two interleaved
 * loads share the engine's one streaming decoder, so both streams fail their
 * CRC or length check; the second one, finding the spare buffer taken, allocates
 * a fresh partition-sized buffer that linear memory never gives back; and the
 * first one's cleanup used to clear the slot the second owned, so a third
 * request started a third load. Every cleanup here checks that the slot still
 * holds its own promise. A manifest shape this object cannot serve reports
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
				`it keeps serving ${liveCurrent(state, ctx.label)?.storeKey ?? "nothing"}`,
		);
		return false;
	}
	if (liveCurrent(state, ctx.label)?.storeKey === source.storeKey) return false;
	// Whatever is in flight finishes first. Its failure is its caller's to report;
	// what matters here is only where the label ended up.
	while (state.loading) {
		await state.loading.catch(() => {});
	}
	// Converged by the loader that was in flight — which is what was asked for.
	if (liveCurrent(state, ctx.label)?.storeKey === source.storeKey) return true;
	await startLoad(state, ctx.label, (fence) => loadStore(env, ctx, manifest, fence));
	return true;
}

export async function getEngine(env: Env, ctx: LoadContext): Promise<Engine> {
	// No manifest re-check on the warm path: a publish reaches this isolate by
	// being pushed to it, so the hot path does no KV read at all.
	const state = stateFor(ctx.label);
	const loaded = liveCurrent(state, ctx.label);
	if (loaded) return loaded.engine;
	if (!state.loading) {
		const failed = state.lastLoadFailure;
		if (failed) {
			const since = Date.now() - failed.at;
			if (since < LOAD_BACKOFF_MS) {
				throw new EngineUnavailableError(
					`store load failed ${since}ms ago (${failed.message}); not retrying for another ` +
						`${LOAD_BACKOFF_MS - since}ms`,
				);
			}
		}
		const loading = startLoad(state, ctx.label, (fence) => loadStore(env, ctx, undefined, fence));
		loading.then(
			() => {
				state.lastLoadFailure = null;
			},
			(err: unknown) => {
				// A stalled load is not a failed store: the next request should start a fresh load at
				// once rather than wait out the backoff meant for a store that cannot load.
				if (err instanceof StoreLoadStalledError) return;
				state.lastLoadFailure = { at: Date.now(), message: err instanceof Error ? err.message : String(err) };
			},
		);
	}
	return state.loading as Promise<Engine>;
}

/** Non-blocking: the label's engine if this isolate is already warm, else null. */
export function tryGetLoadedEngine(label?: string): Engine | null {
	return liveCurrent(stateFor(label), label)?.engine ?? null;
}

/**
 * Wait until no load is in flight for the label. Cheap when none is.
 *
 * The publish RPCs gate on tryGetLoadedEngine, which is null both for a COLD
 * object and for one whose first request's load is still streaming — and the
 * two must not be treated alike: a cold object acks and loads the pushed store
 * on its next request, while a mid-load object that is acked as cold finishes
 * its OLD load and serves it under a record naming the new one. The load's
 * failure is its own caller's to report; this only waits it out.
 */
export async function settleInFlightLoad(label?: string): Promise<void> {
	const state = stateFor(label);
	while (state.loading) {
		await state.loading.catch(() => {});
	}
}

/** The manifest the label's loaded store came from, or null when cold — how the
 * gather learns partition_count without a KV read on the request path. */
export function currentManifest(label?: string): StoreManifest | null {
	return liveCurrent(stateFor(label), label)?.manifest ?? null;
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
	 * ride back with the keys (see gather.ts's inlineRowBudget), framed in
	 * `shaping.shape` — row JSON, or card objects the engine writes itself. */
	queryKeys(opts: EngineSearchOptions, inlineRows: number, shaping: RowShaping): Uint8Array;
	/** The row packet (gather.ts's decodeRowPacket) for these vpids, in `shaping.shape`. */
	fetchRows(vpids: number[], fields: string[], shaping: RowShaping): Uint8Array;
	/** This partition's scores-bearing fuzzy candidates (the cross-partition race's phase 1). */
	fuzzyCandidates(name: string): FuzzyCandidateWire[];
}

/** Decode `fuzzy_candidates`' packed reply: `n: u32, then n of (score: f32, oracle_id: 16B,
 * vpid: u32, served: u8, namelen: u16, name)`, all LITTLE-ENDIAN except the oracle's raw uuid
 * bytes. */
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
		const served = packed[at] === 1;
		at += 1;
		const len = view.getUint16(at, true);
		at += 2;
		const foldedName = new TextDecoder().decode(packed.subarray(at, at + len));
		at += len;
		out.push({ score, served, oracleId, vpid, foldedName });
	}
	return out;
}

/** How many candidate classes each partition ships the race — see the wasm export's docstring
 * for why 8 makes the bounded reply practically exact. */
const FUZZY_CANDIDATE_CLASSES = 8;

export function gatherOps(label?: string): GatherOps | null {
	const current = liveCurrent(stateFor(label), label);
	if (!current) return null;
	const { handle, engine, storeKey } = current;
	return {
		storeKey,
		sortKeyVersion: () => handle.sort_key_version(),
		queryKeys: (opts, inlineRows, shaping) =>
			handle.query_keys(opts.filterTreeJson, engine.optsJsonFor(opts), inlineRows, shaping.shape, shaping.baseUrl),
		fetchRows: (vpids, fields, shaping) =>
			handle.fetch_rows(Uint32Array.from(vpids), JSON.stringify(fields), shaping.shape, shaping.baseUrl),
		fuzzyCandidates: (name) =>
			decodeFuzzyCandidates(handle.fuzzy_candidates(name, FUZZY_SIMILARITY_FLOOR, FUZZY_CANDIDATE_CLASSES)),
	};
}
