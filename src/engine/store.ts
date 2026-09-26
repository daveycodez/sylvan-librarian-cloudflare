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
import { decodeUtf8, NEWLINE } from "./bytes";
import { cardNamesOf } from "./card-names";
import { collectionBatchRequest, decodeCollectionPacket } from "./collection-batch";
import { assembleColumnar, columnKeys, decodeShapedPage } from "./columnar";
import { decodeFuzzyCandidates } from "./fuzzy-wire";
import { decodeRowPacket, joinJsonArray, type RowShaping } from "./gather";
import { type FeedCounts, feedBlocks } from "./load-blocks";
import { decodeNamedFuzzyPacket } from "./named-fuzzy";
import { probePlacement } from "./placement";
import {
	type ArchiveCacheStorage,
	announcedFor,
	type CacheWriter,
	cacheCodecOf,
	cachedArchiveStream,
	cachedBuiltAt,
	cachedCompressedStream,
	cachedLz4Stream,
	cachedNames,
	cacheWriter,
	compressedCacheKeys,
	dropCached,
	ensureCacheSchema,
	fillCache,
	isCompressedCached,
	isLz4Cached,
	lz4CacheKey,
	namesCacheKey,
	pruneCacheOlderThan,
	putCompressedChunk,
	putNames,
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
	CacheCodec,
	CollectionBatch,
	CollectionBatchAnswer,
	CollectionScope,
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	Env,
	ExactNameProbe,
	NamedFuzzyBundle,
	ResultShape,
	ScryfallFuzzyResult,
	SearchPageEnvelope,
	StoreManifest,
} from "./types";
import { EngineUnavailableError, FUZZY_SIMILARITY_LEAD, FUZZY_WEAK_BELOW, type FuzzyCandidateWire } from "./types";

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
		/** n8: the names blob (manifest `names_key`) loaded into this instance, once one is. */
		names?: string;
	} | null;
	/** n8: the one names load in flight (autocompleteFromNames), whoever asked first. */
	namesLoading: Promise<void> | null;
	/** The ONE load in flight for this label, whoever started it (getEngine or swapToStore). */
	loading: Promise<Engine> | null;
	/** The one refreshNow in flight: concurrent callers are all reacting to the same publish. */
	refreshing: Promise<boolean> | null;
	/**
	 * The one prefetch in flight, and which archive it is filling. preparePublish reaches
	 * prefetchStore without refreshNow's single-flight, and a coordinator that retries its prepare
	 * phase while the first attempt is still fetching would otherwise run two fills of one archive
	 * side by side — each dropping and rewriting the other's chunks (x1).
	 */
	prefetching: { storeKey: string; done: Promise<boolean> } | null;
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
		s = {
			current: null,
			loading: null,
			refreshing: null,
			prefetching: null,
			lastLoadFailure: null,
			namesLoading: null,
		};
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

/**
 * What THIS ISOLATE has loaded, for the co-location half of every "store loaded" line.
 *
 * Two questions the 2026-09-25 DeckGen logs could not answer: whether a partition that reloads
 * every ~30s (engine-enam-p8, 157 loads in 95 minutes) comes back in a NEW isolate each time or in
 * the same one, and what else that isolate holds when it goes. `load #1` is a fresh isolate; the
 * resident list is every engine instance beside this one, with its linear memory — which never
 * shrinks, so two ~45MB partitions fit the 128MB isolate and three do not.
 */
let isolateLoads = 0;
let isolateFirstLoadAt = 0;

/** Linear memory past which a line is logged at WARN: under ~28MB left for the JS heap and a third store. */
export const CROWDED_ISOLATE_BYTES = 100 * 1024 * 1024;

/** The isolate clause of a "store loaded" line, and whether it reads as crowded. Pure, for the tests. */
export function isolateClause(
	loadNumber: number,
	sinceFirstMs: number,
	resident: readonly { label: string; bytes: number }[],
): { text: string; crowded: boolean } {
	const total = resident.reduce((sum, r) => sum + r.bytes, 0);
	const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
	const list = resident.map((r) => `${r.label || "default"} ${mb(r.bytes)}MB`).join(", ");
	return {
		text:
			`isolate load #${loadNumber}${loadNumber > 1 ? ` (first ${Math.round(sinceFirstMs / 1000)}s ago)` : ""}, ` +
			`holds ${resident.length} engine(s), ${mb(total)}MB linear${list ? `: ${list}` : ""}`,
		crowded: resident.length >= 3 || total >= CROWDED_ISOLATE_BYTES,
	};
}

/** Count this load against the isolate, and describe what the isolate now holds. */
function noteIsolateLoad(): { text: string; crowded: boolean } {
	const now = Date.now();
	isolateLoads += 1;
	if (isolateLoads === 1) isolateFirstLoadAt = now;
	// Guarded: a test's stand-in for the wasm module may not provide the gauge.
	const resident = typeof wasm.residentEngines === "function" ? wasm.residentEngines() : [];
	return isolateClause(isolateLoads, now - isolateFirstLoadAt, resident);
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
	 * `columnar` -- the site's own shape -- no longer parses either (backlog n11): the engine writes
	 * each row as a column frame, values already spelled as `JSON.stringify` spells them, and the
	 * page is assembled by memcpy. See columnar.ts.
	 */
	async searchCardsAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		if (shape === "columnar") {
			const { total, frames } = decodeShapedPage(
				this.w.query_shaped(opts.filterTreeJson, this.optsJson(opts), "columns"),
			);
			return {
				totalCards: total,
				cardsBytes: assembleColumnar(columnKeys(opts.fields), frames),
				rowCount: frames.length,
			};
		}
		const answer = this.w.query_rows(opts.filterTreeJson, this.optsJson(opts));
		// `<total> <rowCount>\n<rows>`. Only the prefix is decoded -- a handful of ASCII digits --
		// and the rows stay bytes all the way to the response body. `subarray` is a view, not a
		// copy, so nothing here is proportional to the payload.
		const split = answer.indexOf(NEWLINE);
		const [total = "0", rows = "0"] = decodeUtf8(answer.subarray(0, split)).split(" ");
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
		// The same draw as randomCardsAsObjects, written by the engine in the page's shape rather than
		// parsed here and serialized back (backlog n11). Both shapes arrive JavaScript-spelled, so the
		// bytes are the ones `JSON.stringify` wrote over the parsed draw.
		const seed = crypto.getRandomValues(new BigUint64Array(1))[0] ?? 0n;
		const packet = this.w.random_search_shaped(
			numCards,
			seed,
			filterTreeJson ?? "null",
			JSON.stringify(fields),
			shape === "columnar" ? "columns" : "rows",
		);
		const frames = decodeRowPacket(packet);
		const cardsBytes = shape === "columnar" ? assembleColumnar(columnKeys(fields), frames) : joinJsonArray(frames);
		return { totalCards: frames.length, cardsBytes, rowCount: frames.length };
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
		const [total = "0", rows = "0", widened = "0"] = decodeUtf8(answer.subarray(0, split)).split(" ");
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

	async scryfallFuzzyName(name: string, baseUrl: string, setCode = ""): Promise<ScryfallFuzzyResult> {
		const out = JSON.parse(
			this.w.fuzzy_card_by_name(
				name,
				setCode,
				FUZZY_SIMILARITY_FLOOR,
				FUZZY_SIMILARITY_LEAD,
				FUZZY_WEAK_BELOW,
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

	/** `exact_name_probe` — see ExactNameProbe. */
	async scryfallExactNameProbe(folded: string, setCode: string, baseUrl: string): Promise<ExactNameProbe> {
		const probe = JSON.parse(this.w.exact_name_probe(folded, setCode, JSON.stringify(CARD_OBJECT_FIELDS))) as {
			rank: number[] | null;
			present: boolean;
			card: EngineRow | null;
		};
		return {
			rank: probe.rank,
			present: probe.present,
			card: probe.card === null ? null : toScryfallCard(probe.card, baseUrl),
		};
	}

	async scryfallExactName(folded: string, setCode: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const row = JSON.parse(
			this.w.exact_card_by_name(folded, setCode, JSON.stringify(CARD_OBJECT_FIELDS)),
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

	/**
	 * `named_fuzzy_bundle` — the three `?fuzzy=` stages in one call, each built exactly as its own
	 * method above builds it (same floor, lead, candidate count and fields; the rows mapped by the
	 * same toScryfallCard), so a bundle's sections ARE those methods' answers. See NamedFuzzyBundle.
	 */
	async scryfallNamedFuzzyBundle(
		folded: string,
		setCode: string,
		words: string[],
		limit: number,
		baseUrl: string,
	): Promise<NamedFuzzyBundle> {
		const packet = decodeNamedFuzzyPacket<EngineRow>(
			this.w.named_fuzzy_bundle(
				folded,
				setCode,
				FUZZY_SIMILARITY_FLOOR,
				FUZZY_SIMILARITY_LEAD,
				FUZZY_WEAK_BELOW,
				FUZZY_CANDIDATE_CLASSES,
				JSON.stringify(words),
				limit,
				JSON.stringify(CARD_OBJECT_FIELDS),
			),
		);
		const card = (row: EngineRow | null) => (row === null ? null : toScryfallCard(row, baseUrl));
		return {
			exact: { rank: packet.exact.rank, present: packet.exact.present, card: card(packet.exact.card) },
			fuzzy: packet.fuzzy === null ? null : { status: packet.fuzzy.status, card: card(packet.fuzzy.card) },
			candidates: packet.candidates,
			contained: packet.contained === null ? null : this.toCards(packet.contained, baseUrl),
		};
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

/** What the bytes handed to feedStore are: the raw archive, stored gzip members, or cached LZ4 frames. */
type StoreFormat = "raw" | "gzip" | "lz4";

/**
 * Stream the store bytes into wasm memory, in blocks (see load-blocks.ts for why).
 *
 * `gzip` bytes are the stored gzip members, inflated INSIDE the engine straight into the store
 * buffer (see begin_store_load_gzip in engine/wasm/src/lib.rs for the measurement that moved the
 * gunzip there: 306-752ms of DO CPU per partition through DecompressionStream in workerd). `lz4`
 * bytes are this object's own cached frames (backlog r3), decoded the same way at a fraction of
 * the inflate's cost, and crossed at the same 1MB ceiling for the same reason.
 */
async function feedStore(
	w: wasm.EngineHandle,
	body: ReadableStream<Uint8Array>,
	totalLen: number,
	sink: CacheWriter | null,
	format: StoreFormat = "raw",
	fence?: LoadFence,
): Promise<FeedCounts> {
	// Every call into the instance is fenced: an abandoned load whose read resumes must not feed
	// the buffer a newer load is filling.
	checkFence(fence);
	if (format === "gzip" || format === "lz4") {
		const [begin, chunk, finish] =
			format === "gzip"
				? [w.begin_store_load_gzip, w.store_load_gzip_chunk, w.finish_store_load_gzip]
				: [w.begin_store_load_lz4, w.store_load_lz4_chunk, w.finish_store_load_lz4];
		begin(totalLen);
		const counts = await feedBlocks(
			body,
			(block) => {
				checkFence(fence);
				chunk(block);
			},
			GZIP_FEED_BYTES,
		);
		checkFence(fence);
		finish();
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
			// Drop, then fill (x1): the older build's rows go before the tee writes its first one.
			dropOlderBuilds(ctx, storage, [key], key);
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
	/** What the manifest being loaded lets this object WRITE (cacheCodecOf). Reads take either. */
	codec: CacheCodec = "gzip",
): {
	body: ReadableStream<Uint8Array>;
	cached: boolean;
	format: "gzip" | "lz4";
	commit: () => void;
	invalidate: () => void;
} {
	const storage = ctx?.storage;
	const gzipBytes = source.gzipBytes as number; // callers gate on presence
	const chunkCount = source.chunkCount as number; // compressed manifests always carry it (kvArchiveStream enforces)
	const keys = compressedCacheKeys(source.storeKey, chunkCount);
	// Everything this archive may be cached under, in either family: what every prune keeps.
	const keep = cacheKeysOf(source);
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
			// LZ4 first (r3): the cheaper decode, and — held — the only family the object keeps.
			// Taken whatever the codec says: a gate that turned LZ4 off tonight must not make an
			// object throw away a copy it already has and pay a KV reload for it.
			const lz4 = cachedLz4Stream(storage, source.storeKey);
			if (lz4) {
				const dropLz4 = () => {
					try {
						dropCached(storage, lz4CacheKey(source.storeKey));
					} catch (err) {
						console.warn(`${tag(ctx)}could not drop the LZ4 cache for ${source.storeKey}: ${err}`);
					}
				};
				return { body: lz4, cached: true, format: "lz4", commit: () => {}, invalidate: dropLz4 };
			}
			const local = cachedCompressedStream(storage, source.storeKey, chunkCount, gzipBytes, false);
			if (local) return { body: local, cached: true, format: "gzip", commit: () => {}, invalidate: dropAll };
		} catch (err) {
			console.warn(
				`${tag(ctx)}compressed archive cache unreadable for ${source.storeKey} (falling back to KV): ${err}`,
			);
		}
	}
	// Miss: read KV, teeing each STORED chunk in. Tee faults must never fail the
	// load — warn once and stop writing, exactly like the decompressed sink.
	//
	// NO TEE when the codec is LZ4 (design r3, change 4): the object is about to hold this archive
	// as LZ4, and teeing the gzip chunks first would hold both families of one archive at once —
	// at the publish, in every warm region together. The LZ4 copy is written from wasm after the
	// load instead (fillLz4Cache).
	//
	// DROP, THEN FILL (x1), in both codecs: this object's older builds go NOW, before the first
	// chunk is tee'd, not at commit. A miss means neither family of THIS archive is held, so what
	// remains is a build this load is replacing — and tee'ing beside it held two builds at once in
	// every object that woke onto a publish it had not been prepared for. Under LZ4 nothing is tee'd,
	// but the old rows would otherwise still sit beside the LZ4 fill's until commit.
	if (storage) dropOlderBuilds(ctx, storage, keep, source.storeKey);
	const teeGzip = codec === "gzip";
	let teeBroken = storage === undefined || !teeGzip;
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
		body: kvSourceStream(env, source, storage && teeGzip ? tee : undefined, false),
		cached: false,
		format: "gzip",
		commit: () => {
			if (storage && !teeGzip) {
				// Nothing tee'd. The older builds went before the load; anything a concurrent writer
				// left since is still dead weight.
				try {
					const dropped = pruneCacheOlderThan(storage, keep, cachedBuiltAt(source.storeKey));
					if (dropped.length) console.log(`${tag(ctx)}dropped ${dropped.length} stale cached archive(s)`);
				} catch (err) {
					console.warn(`${tag(ctx)}could not prune the archive cache: ${err}`);
				}
				return;
			}
			if (!storage || teeBroken) return;
			try {
				if (!isCompressedCached(storage, source.storeKey, chunkCount, gzipBytes)) {
					console.warn(`${tag(ctx)}compressed cache for ${source.storeKey} is incomplete after the load; not kept`);
					dropAll();
					return;
				}
				const dropped = pruneCacheOlderThan(storage, keep, cachedBuiltAt(source.storeKey));
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
		const dropped = ctx?.storage ? pruneCacheOlderThan(ctx.storage, keep, cachedBuiltAt(key)) : [];
		console.log(
			`${tag(ctx)}cached ${key} locally while loading it (${rows} rows)` +
				`${dropped.length ? `, dropped ${dropped.length} stale` : ""}`,
		);
	} catch (err) {
		console.warn(`${tag(ctx)}could not cache ${key} locally (KV still serves): ${err}`);
	}
}

/**
 * Every cache key an archive may occupy: its gzip chunk family and its LZ4 family (or, for an
 * uncompressed archive, its one decompressed family). What a prune that keeps THIS archive keeps.
 */
function cacheKeysOf(source: ArchiveSource): string[] {
	if (source.gzipBytes === undefined) return [source.storeKey];
	return [...compressedCacheKeys(source.storeKey, source.chunkCount as number), lz4CacheKey(source.storeKey)];
}

/**
 * DROP, THEN FILL (backlog x1): before a fill of `storeKey` writes anything, drop every cached build
 * but the one being filled (`keep`), and never one NEWER than it (pruneCacheOlderThan's guard).
 * Never throws: a drop that fails leaves the old behaviour — two builds for one fill — not a failed
 * load.
 */
function dropOlderBuilds(
	ctx: LoadContext | undefined,
	storage: ArchiveCacheStorage,
	keep: readonly string[],
	storeKey: string,
): string[] {
	try {
		const dropped = pruneCacheOlderThan(storage, keep, cachedBuiltAt(storeKey));
		if (dropped.length) {
			console.log(`${tag(ctx)}dropped ${dropped.length} older cached archive(s) before filling ${storeKey}`);
		}
		return dropped;
	} catch (err) {
		console.warn(`${tag(ctx)}could not drop the older cached archives before filling ${storeKey}: ${err}`);
		return [];
	}
}

/**
 * Re-encode the store this label just loaded into its LZ4 cache (backlog r3), when the manifest
 * says LZ4 and the load inflated gzip — a KV miss, a gzip cache hit, or a publish swap from the
 * gzip the prefetch held.
 *
 * ORDER IS THE POOL (design r3, change 4): the gzip rows go FIRST, then the LZ4 rows are written,
 * so an object never holds both families of one archive. Encoding first would, at the publish
 * commit, have every warm object in every region holding both at once — ~+0.15GB per warm region
 * at today's corpus, ~+2.3GB at 2x with eight regions, past the pool. The store is already in
 * wasm memory, so nothing needs the gzip copy; an eviction between the drop and the commit costs
 * one KV reload, and a failed encode leaves no cache at all, which the next load refills.
 *
 * SYNCHRONOUS once it starts: every frame and every row write happens in one turn, so no request
 * or publish swap can change the active store between two frames (the stillCurrent check guards
 * the gap before it starts). Measured under V8 at ~67ms of encode per partition (2026-09-25, node,
 * every partition of generation 52) plus ~15 row writes — once per object per publish.
 */
function fillLz4Cache(
	ctx: LoadContext,
	w: wasm.EngineHandle,
	source: ArchiveSource,
	stillCurrent: () => boolean,
): void {
	const storage = ctx.storage;
	if (!storage || !stillCurrent()) return;
	const key = lz4CacheKey(source.storeKey);
	try {
		if (isLz4Cached(storage, source.storeKey)) return;
		// Everything but the LZ4 family this fill writes: the gzip copy of THIS archive, and any
		// OLDER build's rows a prune has not reached — never a newer build a prepare is holding (x1).
		const dropped = pruneCacheOlderThan(storage, [key], cachedBuiltAt(source.storeKey));
		const writer = cacheWriter(storage, key, null);
		let frames = 0;
		try {
			for (;;) {
				const frame = w.store_lz4_frame(frames);
				if (frame.length === 0) break;
				writer.write(frame);
				frames += 1;
			}
		} catch (err) {
			writer.abort();
			throw err;
		}
		const rows = writer.commit();
		if (rows === 0) {
			console.warn(`${tag(ctx)}LZ4 cache for ${source.storeKey} came out empty; not kept`);
			return;
		}
		console.log(
			`${tag(ctx)}cached ${source.storeKey} as LZ4 (${frames} frames, ${rows} rows)` +
				`${dropped.length ? `, dropped ${dropped.length} gzip/stale` : ""}`,
		);
	} catch (err) {
		// The cache is an optimisation over KV: a fill that fails costs the next wake a KV load.
		console.warn(`${tag(ctx)}could not cache ${source.storeKey} as LZ4 (the next load reads KV): ${err}`);
	}
}

/**
 * Drop every cached archive a COLD object holds that the manifest it was just told about does
 * not name (design r3, change 6: the cold branch of preparePublish). Once the publisher has
 * recorded the new manifest here, the old build's cache is never read again — a wake loads the
 * recorded build, falling back to KV — so keeping it only means the next cold load holds two
 * builds while it fills the new one. Never throws: a prune that fails is the old behaviour.
 */
export function pruneToManifest(ctx: LoadContext, manifest: StoreManifest): number {
	const storage = ctx.storage;
	const source = tryArchiveOfManifest(manifest, ctx.partition);
	if (!storage || !source) return 0;
	try {
		ensureCacheSchema(storage);
		return pruneCacheOlderThan(storage, cacheKeysOf(source), cachedBuiltAt(source.storeKey)).length;
	} catch (err) {
		console.warn(`${tag(ctx)}could not prune stale cached archives: ${err}`);
		return 0;
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
	// What the manifest lets this object write (r3's pool gate): read once, from the manifest it
	// is loading, so a load and the fill after it agree.
	const codec = cacheCodecOf(manifest);
	const fetch: {
		body: ReadableStream<Uint8Array>;
		cached: boolean;
		format: StoreFormat;
		sink: CacheWriter | null;
		commit: () => void;
		invalidate: () => void;
	} = compressedMode
		? { ...compressedArchiveBytes(env, ctx, source, codec), sink: null }
		: (() => {
				const f = archiveBytes(ctx, source.storeKey, source.storeBytes, () => kvSourceStream(env, source));
				return {
					body: f.body,
					cached: f.cached,
					format: "raw" as const,
					sink: f.sink,
					commit: () => commitSink(ctx, f.sink, source.storeKey, [source.storeKey]),
					invalidate: () => f.sink?.abort(),
				};
			})();
	const { body, cached, sink, format } = fetch;
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
		counts = await feedStore(w, body, source.storeBytes, sink, format, fence);
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
		// have just been created, and creation is when its region was fixed forever. Once per object
		// per PLACEMENT_FRESH_MS (remembered in its own storage, so a reload inside the window costs
		// one SELECT) and fire-and-forget; see placement.ts for why this must never move onto the
		// request path.
		probePlacement(ctx);
	}

	// Last gate before this load becomes the object's store: an abandoned load never does.
	checkFence(fence);
	const engine = new WasmEngine(w);
	state.current = { storeKey: source.storeKey, engine, manifest, handle: w, generation: w.instanceGeneration() };
	if (ctx?.storage && format === "gzip" && codec === "lz4") {
		// After this load resolves, not inside it: the request (or the publish commit) that caused
		// the load is answered first, and the one-off encode runs on the next turn. It re-checks that
		// THIS store is still the label's before it touches anything (a swap may have begun).
		const fillCtx = ctx;
		const generation = w.instanceGeneration();
		const stillCurrent = () =>
			state.current?.storeKey === source.storeKey && state.current.handle.instanceGeneration() === generation;
		ctx.waitUntil(
			new Promise<void>((resolve) =>
				setTimeout(() => {
					fillLz4Cache(fillCtx, w, source, stillCurrent);
					resolve();
				}, 0),
			),
		);
	}
	// The `in NNNms` is I/O WAIT ONLY — Workers freeze the clock during
	// synchronous execution, so it cannot see the decompression or the copy into
	// wasm. Judge this path by cpuTimeMs from the invocation's own event; the
	// linear-memory figure is the honest one here, and is a high-water mark.
	const isolate = noteIsolateLoad();
	(isolate.crowded ? console.warn : console.log)(
		`${tag(ctx)}store loaded from ${cached ? `local cache (${format})` : "KV"}: ${source.storeKey} (${source.cardCount} cards, ` +
			`${source.storeBytes} bytes${!cached && source.gzipBytes ? ` from ${source.gzipBytes} gzipped` : ""}, ` +
			`built ${manifest.built_at}) in ${Date.now() - started}ms from ${pieces} pieces in ${blocks} blocks ` +
			`(linear memory ${(w.linearMemoryBytes() / 1048576).toFixed(1)}MB); ${isolate.text}`,
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
 * in LOCAL storage, swapping nothing. The old store serves throughout — from
 * wasm memory, which is why its cached rows are dropped BEFORE the new ones are
 * fetched (x1: drop, then fill), and the object never holds two builds.
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
	const state = stateFor(ctx.label);
	if (liveCurrent(state, ctx.label)?.storeKey === source.storeKey) return false;
	// SINGLE-FLIGHTED PER LABEL (x1). A second prefetch of the same archive — the coordinator
	// retrying its prepare phase while the first attempt is still fetching, or a notify racing a
	// prepare — shares the first one's answer instead of fetching every chunk again beside it. One
	// of ANOTHER archive waits for the one in flight to finish, so two fills never interleave.
	for (;;) {
		const inFlight = state.prefetching;
		if (!inFlight) break;
		if (inFlight.storeKey === source.storeKey) return inFlight.done;
		await inFlight.done.catch(() => false);
	}
	const done = prefetchOnce(env, ctx, ctx.storage, source).finally(() => {
		if (state.prefetching?.done === done) state.prefetching = null;
	});
	state.prefetching = { storeKey: source.storeKey, done };
	return done;
}

async function prefetchOnce(
	env: Env,
	ctx: LoadContext,
	storage: ArchiveCacheStorage,
	source: ArchiveSource,
): Promise<boolean> {
	try {
		ensureCacheSchema(storage);
		const builtAt = cachedBuiltAt(source.storeKey);
		if (source.gzipBytes !== undefined) {
			const chunkCount = source.chunkCount as number;
			// The prefetch always stages GZIP, even under an LZ4 codec: the new archive is not in wasm
			// yet, so there is nothing to encode from, and a second store-sized buffer does not fit the
			// isolate. The commit swap inflates it and fillLz4Cache converts it (r3). A held LZ4 copy
			// of the same archive (a retried phase) is already the better form — and asking FIRST is
			// what keeps a retried prepare free: nothing is dropped and nothing is fetched.
			if (
				!isLz4Cached(storage, source.storeKey) &&
				!isCompressedCached(storage, source.storeKey, chunkCount, source.gzipBytes)
			) {
				// DROP, THEN FILL (x1). The build this object serves lives in wasm memory, not in these
				// rows, and the new manifest is already written (the coordinator's manifest step runs
				// before notify), so the old build's cache is never read again: a wake from here loads
				// the recorded build. Filling beside it held two builds in every warm object of every
				// region at once, and SQLite kept that mark. See pruneCacheOlderThan.
				dropOlderBuilds(ctx, storage, cacheKeysOf(source), source.storeKey);
				for (let seq = 0; seq < chunkCount; seq++) {
					putCompressedChunk(storage, source.storeKey, seq, await fetchStoredChunk(env, source.storeKey, seq));
				}
			}
			const dropped = pruneCacheOlderThan(storage, cacheKeysOf(source), builtAt);
			console.log(
				`${tag(ctx)}prefetched ${source.storeKey} (${chunkCount} compressed chunks) before swapping` +
					`${dropped.length ? `, dropped ${dropped.length} stale` : ""}`,
			);
		} else {
			dropOlderBuilds(ctx, storage, [source.storeKey], source.storeKey);
			const rows = await fillCache(storage, source.storeKey, kvSourceStream(env, source), source.storeBytes);
			const dropped = pruneCacheOlderThan(storage, [source.storeKey], builtAt);
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

// ── /cards/autocomplete from the card-names blob (backlog n8) ─────────────────

/** Thrown when this object cannot answer from names — the caller (the router) then fans out. */
export class CardNamesUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CardNamesUnavailableError";
	}
}

/** How long an isolate's colo may serve a cached names blob: immutable per build, like the chunks. */
const CARD_NAMES_CACHE_TTL = 604_800;

/**
 * `/cards/autocomplete` for the WHOLE corpus, answered by this one object from the names blob of the
 * build it has loaded (card-names.ts; engine/wasm/src/names.rs ranks it exactly as the engine does).
 * The caller has acquired the engine first (SearchEngine.instrumented), so a store is loaded.
 *
 * WHERE THE BLOB COMES FROM, cheapest first — and KV at most ONCE per object per generation:
 *
 *   1. this wasm instance, when it already holds the blob this build names (every call after the
 *      first, until the instance or the build changes);
 *   2. this object's SQLite (store-cache.ts, `<archiveKey>:names`) — what an object pays after every
 *      hibernation wake, instead of a KV read: ~10k reloads a day against the free plan's 100k KV
 *      reads would otherwise make this route the account's largest KV reader;
 *   3. KV, once, then cached here — DROP, THEN FILL, like every archive fill (x1): the prune that
 *      runs first keeps this build's families (the names key follows its archive, namesKeptWith) and
 *      drops any older build's, so an object never holds two builds' names.
 *
 * A manifest naming no blob, a blob that is gone or the wrong length, or one wasm refuses, throws
 * CardNamesUnavailableError; the router answers by the fan-out instead. A cached copy wasm refuses is
 * dropped, so the next call reads KV rather than the same bad rows (the 2026-08-13 lesson).
 */
export async function autocompleteFromNames(
	env: Env,
	ctx: LoadContext,
	prefix: string,
	limit: number,
): Promise<string[]> {
	const state = stateFor(ctx.label);
	for (;;) {
		const current = liveCurrent(state, ctx.label);
		if (!current) throw new CardNamesUnavailableError("no store is loaded to name a card-names blob");
		const names = cardNamesOf(current.manifest);
		if (!names) {
			throw new CardNamesUnavailableError(`the loaded build (${current.manifest.store_key}) publishes no card names`);
		}
		if (current.names === names.key) {
			return JSON.parse(current.handle.names_autocomplete(prefix, limit)) as string[];
		}
		if (!state.namesLoading) {
			const loading = loadNames(env, ctx, current, names).finally(() => {
				if (state.namesLoading === loading) state.namesLoading = null;
			});
			state.namesLoading = loading;
		}
		await state.namesLoading;
		// Loaded into the store that was current when the load began. A swap in the meantime (a
		// publish) means the NEW store asks again on the next pass; the same store answers now.
		if (liveCurrent(state, ctx.label) === current && current.names === names.key) {
			return JSON.parse(current.handle.names_autocomplete(prefix, limit)) as string[];
		}
	}
}

async function loadNames(
	env: Env,
	ctx: LoadContext,
	current: NonNullable<LabelState["current"]>,
	names: { key: string; bytes: number },
): Promise<void> {
	const storage = ctx.storage;
	const archiveKey = current.storeKey;
	let blob: Uint8Array | null = null;
	let from = "local cache";
	if (storage) {
		try {
			ensureCacheSchema(storage);
			blob = cachedNames(storage, archiveKey, names.bytes);
		} catch (err) {
			console.warn(`${tag(ctx)}card names cache unreadable for ${archiveKey} (reading KV): ${err}`);
		}
	}
	if (!blob) {
		from = "KV";
		const buf = await env.STORE_KV.get(names.key, { type: "arrayBuffer", cacheTtl: CARD_NAMES_CACHE_TTL });
		if (buf === null) throw new CardNamesUnavailableError(`${names.key} is not in KV`);
		if (buf.byteLength !== names.bytes) {
			throw new CardNamesUnavailableError(`${names.key} is ${buf.byteLength} bytes, the manifest says ${names.bytes}`);
		}
		blob = new Uint8Array(buf);
		if (storage) {
			try {
				// DROP, THEN FILL (x1). Kept: every family of the archive this object serves, which
				// keeps its names key too; dropped: anything older, never anything newer.
				const source = tryArchiveOfManifest(current.manifest, ctx.partition);
				const keep = source ? cacheKeysOf(source) : [archiveKey];
				dropOlderBuilds(ctx, storage, keep, archiveKey);
				putNames(storage, archiveKey, blob);
			} catch (err) {
				console.warn(`${tag(ctx)}card names not cached for ${archiveKey} (KV again next wake): ${err}`);
			}
		}
	}
	let count: number;
	try {
		count = current.handle.load_names(blob);
	} catch (err) {
		if (from !== "KV" && storage) {
			try {
				dropCached(storage, namesCacheKey(archiveKey));
			} catch {}
		}
		throw new CardNamesUnavailableError(`${names.key} from ${from} did not load: ${err}`);
	}
	current.names = names.key;
	console.log(
		`${tag(ctx)}card names loaded from ${from}: ${names.key} (${count} names, ${names.bytes} bytes gzipped, ` +
			`${(current.handle.names_heap_bytes() / 1048576).toFixed(1)}MB in wasm; ` +
			`linear memory ${(current.handle.linearMemoryBytes() / 1048576).toFixed(1)}MB)`,
	);
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
	/** This partition's scores-bearing fuzzy candidates (the cross-partition race's phase 1),
	 * over the cards with a printing in `setCode` when one is given. */
	fuzzyCandidates(name: string, setCode: string): FuzzyCandidateWire[];
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
		fuzzyCandidates: (name, setCode) =>
			decodeFuzzyCandidates(handle.fuzzy_candidates(name, setCode, FUZZY_SIMILARITY_FLOOR, FUZZY_CANDIDATE_CLASSES)),
	};
}
