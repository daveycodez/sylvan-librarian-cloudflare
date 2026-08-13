// Per-isolate store manager: loads the rkyv store from KV into the wasm engine
// and hot-swaps when the manifest advances. It never starts an import — the
// index is built by the deploy (scripts/import-store.sh) and refreshed by the
// nightly cron, either of which fails loudly rather than shipping no index.
//
// Memory discipline: the store (~76.6MB) is streamed KV → wasm linear memory in
// 4MB blocks (see load-blocks.ts); no full-store JS buffer ever exists, keeping
// peak isolate usage inside the 128MB limit. The block size is chosen
// independently of however KV and DecompressionStream cut the bytes up, which is
// what keeps the wasm-side scratch allocation small — it used to be one whole
// 26MB KV chunk, and peak linear memory 99.4MB instead of 78.7MB.
//
// The wasm engine is instantiated lazily (wasm-shim.ts): only a DO that
// actually loads a store pays for it, never a plain request isolate.
//
// There is deliberately NO Cache API layer in front of KV. The previous
// architecture wrote the store through `caches.default` and read it back, and
// that double-stream measured 0.6-1.3s of billed CPU per load — the single
// largest cost in the old system. KV's own `cacheTtl` gives colo-level caching
// for free, on immutable chunk keys, with none of that overhead. What sits in
// front of KV instead is the Durable Object's own SQLite, holding the archive
// already DECOMPRESSED — see store-cache.ts, and note it is a read-through cache
// over a source of truth that is still KV, not a second copy of record.

import * as wasm from "sylvan-engine-wasm";
import { CARD_OBJECT_FIELDS, type EngineRow, toScryfallCard } from "../routes/scryfall-compat/objects";
import { encodeUtf8, NEWLINE } from "./bytes";
import { serializeCards } from "./columnar";
import { type FeedCounts, feedBlocks } from "./load-blocks";
import { probePlacement } from "./placement";
import {
	type ArchiveCacheStorage,
	type CacheWriter,
	cachedArchiveStream,
	cacheWriter,
	dropCached,
	ensureCacheSchema,
	fillCache,
	isCached,
	pruneCache,
	readLiveManifest,
} from "./store-cache";
import { announceSelf, kvCompatStream, kvStoreStream, readManifest } from "./store-kv";
import type {
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	Env,
	ResultShape,
	ScryfallFuzzyResult,
	StoreManifest,
} from "./types";
import { EngineUnavailableError } from "./types";

/**
 * Thresholds for the typo-tolerant stage of `?fuzzy=` (upstream routes.py).
 *
 * A candidate must score at least the floor, and the best must lead the next DISTINCT card name by
 * at least the lead — closer than that and the query does not identify either card, so it is
 * `ambiguous` rather than a guess. The floor sits deliberately above pg_trgm's default 0.3, which
 * is what upstream's index-assisted prefilter relies on; here the engine scans, so the floor is
 * simply the bar.
 */
const FUZZY_SIMILARITY_FLOOR = 0.4;
const FUZZY_SIMILARITY_LEAD = 0.05;

let current: { storeKey: string; engine: WasmEngine; manifest: StoreManifest } | null = null;
let loading: Promise<Engine> | null = null;

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
	 * `engine-wnam-2`).
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
}

/** `[engine-wnam] ` for logs, or an empty prefix outside a Durable Object. */
function tag(ctx?: LoadContext): string {
	return ctx?.label ? `[${ctx.label}] ` : "";
}

class WasmEngine implements Engine {
	/**
	 * The residue archive is attached on FIRST /cards/* use, not at load.
	 *
	 * Single-flighted through this promise so concurrent card requests on a cold isolate stream it
	 * once rather than racing four KV reads each. Held for the life of this instance, which is the
	 * life of the loaded store — a hot swap constructs a new WasmEngine, so it invalidates by
	 * construction, exactly like catalogOnce below.
	 */
	private compatOnce: Promise<void> | null = null;

	constructor(
		private readonly env: Env,
		private readonly manifest: StoreManifest,
		/** The context of the call currently using this engine — see useContext. */
		private ctx?: LoadContext,
	) {}

	/**
	 * Re-point this engine at the caller that is using it RIGHT NOW.
	 *
	 * `current` is isolate-global while `ctx.storage` belongs to ONE Durable Object instance, and a
	 * single isolate can host several of them (engine-wnam and engine-wnam-1, say). The engine used
	 * to keep whichever context happened to load it, so a DIFFERENT instance hitting `/cards/*`
	 * later would attach the residue through the FIRST instance's storage handle. workerd rejects
	 * that outright:
	 *
	 *   Cannot perform I/O on behalf of a different Durable Object.  (I/O type: ActorCacheInterface)
	 *
	 * Observed in production 2026-08-12: every residue attach failed its cache read AND its fill,
	 * fell back to KV, and so the card-object archive was never cached at all.
	 *
	 * Only the residue attach was exposed, because it is the one thing that happens long after the
	 * load rather than during it — everything else uses the context it was handed. getEngine calls
	 * this on every acquisition, so the engine always holds the storage of the object actually
	 * serving.
	 */
	useContext(ctx: LoadContext): void {
		this.ctx = ctx;
	}

	/** Attach the residue archive if it is not already; idempotent and single-flighted. */
	private ensureCompat(): Promise<void> {
		this.compatOnce ??= (async () => {
			if (wasm.compat_loaded()) return;
			const started = Date.now();
			const { pieces, blocks, cached } = await feedCompat(this.env, this.manifest, this.ctx);
			console.log(
				`${tag(this.ctx)}card archive attached from ${cached ? "local cache" : "KV"}: ${this.manifest.compat_key} ` +
					`(${this.manifest.compat_bytes} bytes` +
					`${!cached && this.manifest.compat_gzip_bytes ? ` from ${this.manifest.compat_gzip_bytes} gzipped` : ""}) ` +
					`in ${Date.now() - started}ms from ${pieces} pieces in ${blocks} blocks ` +
					`(linear memory ${(wasm.linearMemoryBytes() / 1048576).toFixed(1)}MB)`,
			);
		})().catch((err) => {
			// SAY WHY. This used to rethrow silently, and the caller turns it into
			// ENGINE_UNAVAILABLE_MARKER, so the only trace a failed attach left anywhere was the
			// request-side "Scryfall compat route: engine failure" with a stack that stops at the RPC
			// boundary. On 2026-08-13 that meant a /cards/* outage whose cause could not be read out
			// of production at all — every hypothesis had to be tested by changing something.
			console.error(
				`${tag(this.ctx)}could not attach the card archive ${this.manifest.compat_key} ` +
					`(${this.manifest.compat_bytes} bytes): ${err}`,
			);
			// A failed attach must not be cached: the next /cards/* request should retry rather
			// than inherit a transient KV failure for the life of the isolate.
			this.compatOnce = null;
			throw err;
		});
		return this.compatOnce;
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
		});
	}

	private query(opts: EngineSearchOptions): { total: number; rows: Record<string, unknown>[] } {
		return JSON.parse(wasm.query(opts.filterTreeJson, this.optsJson(opts))) as {
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
		const answer = wasm.query_rows(opts.filterTreeJson, this.optsJson(opts));
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
	private catalogOnce: { card_types: Record<string, number>; card_keywords: Record<string, number> } | null = null;

	private catalog(): { card_types: Record<string, number>; card_keywords: Record<string, number> } {
		const cached = this.catalogOnce;
		if (cached) return cached;
		const parsed = JSON.parse(wasm.catalog()) as {
			card_types: Record<string, number>;
			card_keywords: Record<string, number>;
		};
		this.catalogOnce = parsed;
		return parsed;
	}

	async cardTypeCounts(): Promise<Record<string, number>> {
		return this.catalog().card_types;
	}

	async cardKeywordCounts(): Promise<Record<string, number>> {
		return this.catalog().card_keywords;
	}

	async randomCardsAsObjects(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		// Engine sampling is deterministic per seed; per-request entropy keeps
		// /random_search random, mirroring upstream's process-side RNG.
		const seedBytes = crypto.getRandomValues(new BigUint64Array(1));
		const seed = seedBytes[0] ?? 0n;
		return JSON.parse(wasm.random_search(numCards, seed, JSON.stringify(fields))) as Record<string, unknown>[];
	}

	async randomCardsAsJson(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult> {
		const rows = await this.randomCardsAsObjects(numCards, fields);
		return { totalCards: rows.length, cardsBytes: encodeUtf8(serializeCards(rows, shape)), rowCount: rows.length };
	}

	async cardCount(): Promise<number> {
		return wasm.size();
	}

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// See the Engine interface: every card object here is BUILT in this Durable Object, never in
	// the request isolate. Each entry point attaches the residue archive first.

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
		await this.ensureCompat();
		const answer = wasm.scryfall_search(
			opts.filterTreeJson,
			this.optsJson({ ...opts, fields: [...CARD_OBJECT_FIELDS] }),
			baseUrl,
		);
		// `<total> <rowCount>\n<cards>`, the same framing query_rows uses; only the short ASCII
		// prefix is decoded and the cards stay bytes all the way to the response body.
		const split = answer.indexOf(NEWLINE);
		const [total = "0", rows = "0"] = new TextDecoder().decode(answer.subarray(0, split)).split(" ");
		return { totalCards: Number(total), cardsBytes: answer.subarray(split + 1), rowCount: Number(rows) };
	}

	/**
	 * The page as a stream. In-process there is no boundary to save, so this wraps the bytes
	 * `scryfallSearch` already produced — see the Engine interface for why the shape is shared.
	 */
	async scryfallSearchStream(
		opts: EngineSearchOptions,
		baseUrl: string,
	): Promise<{ totalCards: number; rowCount: number; byteLength: number; body: ReadableStream<Uint8Array> }> {
		const result = await this.scryfallSearch(opts, baseUrl);
		return {
			totalCards: result.totalCards,
			rowCount: result.rowCount,
			byteLength: result.cardsBytes.byteLength,
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(result.cardsBytes);
					controller.close();
				},
			}),
		};
	}

	async scryfallCardById(scryfallId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		await this.ensureCompat();
		const row = JSON.parse(
			wasm.card_by_scryfall_id(scryfallId, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallCardsByIds(scryfallIds: string[], baseUrl: string): Promise<Record<string, unknown>[]> {
		await this.ensureCompat();
		const rows = JSON.parse(
			wasm.cards_by_scryfall_ids(JSON.stringify(scryfallIds), JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow[];
		return this.toCards(rows, baseUrl);
	}

	async scryfallCardByOracleId(oracleId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		await this.ensureCompat();
		const rows = JSON.parse(wasm.printings_of_oracle_id(oracleId, JSON.stringify(CARD_OBJECT_FIELDS))) as EngineRow[];
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
		await this.ensureCompat();
		const row = JSON.parse(
			wasm.card_by_external_id(namespace, BigInt(externalId), JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallFuzzyName(name: string, baseUrl: string): Promise<ScryfallFuzzyResult> {
		await this.ensureCompat();
		const out = JSON.parse(
			wasm.fuzzy_card_by_name(name, FUZZY_SIMILARITY_FLOOR, FUZZY_SIMILARITY_LEAD, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as { status: ScryfallFuzzyResult["status"]; card: EngineRow | null };
		return { status: out.status, card: out.card === null ? null : toScryfallCard(out.card, baseUrl) };
	}

	async scryfallAutocomplete(prefix: string, limit: number): Promise<string[]> {
		// The only /cards/* route that needs NO residue: names live in the search archive.
		return JSON.parse(wasm.autocomplete(prefix, limit)) as string[];
	}

	async scryfallExactName(folded: string, setCode: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		await this.ensureCompat();
		const row = JSON.parse(
			wasm.exact_card_by_name(folded, setCode, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallCardByIllustrationId(illustrationId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		await this.ensureCompat();
		const row = JSON.parse(
			wasm.card_by_illustration_id(illustrationId, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow | null;
		return row === null ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
	): Promise<Record<string, unknown>[]> {
		await this.ensureCompat();
		const rows = JSON.parse(
			wasm.cards_containing_all_words(JSON.stringify(words), setCode, limit, JSON.stringify(CARD_OBJECT_FIELDS)),
		) as EngineRow[];
		return this.toCards(rows, baseUrl);
	}

	async scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]> {
		await this.ensureCompat();
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
	body: ReadableStream<Uint8Array>,
	totalLen: number,
	sink: CacheWriter | null,
): Promise<FeedCounts> {
	wasm.begin_store_load(totalLen);
	const counts = await feedBlocks(body, (block) => {
		wasm.store_load_chunk(block);
		sink?.write(block);
	});
	wasm.finish_store_load();
	return counts;
}

/**
 * Residue fills that are in flight RIGHT NOW, keyed by archive key.
 *
 * The cold load pre-caches the residue under `waitUntil` while the request that triggered it goes
 * on to ATTACH that same residue. Both wrote the same cache key: the pre-cache through `fillCache`,
 * the attach through its own tee sink, because `isCached` reads false until the pre-cache commits
 * its meta row last. Whichever finished second collided, and since the loser was usually the
 * attach, the FIRST `/cards/*` after any store change 500'd — nightly, on the traffic this
 * deployment mostly serves. Production, 2026-08-13: free 500'd (pre-cache won a 1587ms load), paid
 * survived only because its 4172ms load let the attach finish first.
 *
 * So the attach waits for a fill already running instead of starting a competing one, and then
 * reads it back locally — which is faster than the KV fetch it used to race, not slower.
 */
const residueFills = new Map<string, Promise<unknown>>();

/**
 * Stream the residue archive in and attach it (see StoreManifest.compat_key).
 *
 * Single-flighted per isolate and only ever called from a `/cards/*` path: `/search` reads none of
 * these fields, so a search-only isolate never pays the ~11MB of linear memory or the extra KV
 * read. Once attached it stays for the life of the loaded store, because the store is immutable
 * and a hot swap constructs a new WasmEngine.
 */
async function feedCompat(
	env: Env,
	manifest: StoreManifest,
	ctx?: LoadContext,
): Promise<FeedCounts & { cached: boolean }> {
	const total = manifest.compat_bytes;
	if (!total || !manifest.compat_key) {
		throw new EngineUnavailableError(
			`Store ${manifest.store_key} has no card-object archive; /cards/* needs one (rebuild the store)`,
		);
	}
	// If the cold load is already filling this archive, wait for it rather than opening a second
	// writer on the same cache key — see residueFills. A failed fill is not fatal here: the cache
	// simply stays empty and the read below falls back to KV, which is the pre-8575754 behaviour.
	const filling = residueFills.get(manifest.compat_key);
	if (filling) await filling.catch(() => {});

	try {
		return await attachResidue(env, manifest, total, ctx);
	} catch (err) {
		// The local copy is the only thing that can be wrong here in a way KV cannot: KV is the
		// source of truth, so a bad archive means a bad CACHE. Left alone this is permanent — the
		// retry reads the same rows and fails identically, which is how one object's /cards/* stayed
		// down until the store key next changed. Drop the copy and go to KV once.
		if (!ctx?.storage || !isCached(ctx.storage, manifest.compat_key, total)) throw err;
		console.error(
			`${tag(ctx)}the locally cached card archive ${manifest.compat_key} did not load (${err}); ` +
				`dropping it and re-reading from KV. This copy was readable but not the bytes it claimed.`,
		);
		dropCached(ctx.storage, manifest.compat_key);
		return await attachResidue(env, manifest, total, ctx);
	}
}

/**
 * One attempt at attaching the residue, from wherever the bytes are.
 *
 * Separated so the caller can retry it after invalidating a bad cache: `begin_compat_load` starts a
 * fresh buffer, so re-entering here discards whatever a failed attempt had fed in.
 */
async function attachResidue(
	env: Env,
	manifest: StoreManifest,
	total: number,
	ctx?: LoadContext,
): Promise<FeedCounts & { cached: boolean }> {
	wasm.begin_compat_load(total);
	// Cached and fed exactly like the store, and for the same reason: this lands on the `/cards/*`
	// cold path where the store has usually just been loaded, so both decompressions bill to one
	// request. The archives are cached under separate keys because they are attached at different
	// times — a search-only colo never pays for this one.
	const compatKey = manifest.compat_key as string;
	const { body, cached, sink } = archiveBytes(ctx, compatKey, total, () => kvCompatStream(env, manifest));
	const counts = await feedBlocks(body, (block) => {
		wasm.compat_load_chunk(block);
		sink?.write(block);
	});
	wasm.finish_compat_load();
	// Committed only once wasm has accepted the archive, so a failed attach caches nothing.
	commitSink(ctx, sink, compatKey, [manifest.store_key, compatKey]);
	return { ...counts, cached };
}

/**
 * The archive's bytes, and — on a miss — a sink that caches them AS THEY GO PAST.
 *
 * The fill used to re-stream the archive from KV under `waitUntil`, which meant a cold load that
 * missed the cache fetched and decompressed the same ~76.6MB TWICE. That was justified on the
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
	// The one place wasm is first touched, so the one place that has to bring
	// it up. Isolates that only parse and RPC never reach here and never pay
	// the instantiation — see the header of wasm-shim.ts.
	wasm.ensureEngine();
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
			manifest = pushed;
			confirm = readManifest(env).catch(() => null);
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

	if (current && current.storeKey === manifest.store_key) return current.engine;

	// Started here rather than after the load, so the write has the whole archive fetch to complete
	// in. Awaited below, before the engine is committed — see announceSelf for why a dropped
	// announcement is a correctness problem and not a missing log line.
	const announced = announceSelf(env, ctx?.label);

	const started = Date.now();
	// Local first (decompressed, no network); KV otherwise, teeing into the cache as it streams so
	// the archive is read and decompressed exactly once.
	const { body, cached, sink } = archiveBytes(ctx, manifest.store_key, manifest.store_bytes, () =>
		kvStoreStream(env, manifest),
	);
	if (current) {
		// Hot swap: requests arriving during the swap await `loading` (set by
		// getEngine), so a brief unloaded window is invisible to callers.
		current = null;
		wasm.unload_store();
	}
	// GZIPPED in KV (see StoreManifest.store_gzip_bytes), decompressed per chunk
	// as it streams. The meter argument against this was sound but answered the
	// wrong question: KV reads are charged per read rather than per byte, yet the
	// cold path is bound by neither. Measured on production over 3 days (n=121
	// cold loads): wall p50 915ms against DO CPU p50 164ms, so ~750ms was pure
	// I/O wait for 76.6MB. Compression buys that back and costs CPU for it —
	// ~190ms of DecompressionStream per load in workerd — which is why this is a
	// trade, not a free win, and why `store_gzip_bytes` is a flag the reader can
	// still see absent.
	const { pieces, blocks } = await feedStore(body, manifest.store_bytes, sink);

	// The confirmation, awaited only now: it has had the whole load to arrive, so in the common case
	// this costs nothing. A mismatch means the pushed manifest was stale, and the load just done is
	// discarded rather than served.
	if (confirm) {
		const truth = await confirm;
		if (truth?.store_bytes && truth.store_key !== manifest.store_key) {
			console.warn(
				`${tag(ctx)}the pushed manifest named ${manifest.store_key} but KV says ${truth.store_key}; reloading`,
			);
			sink?.abort();
			wasm.unload_store();
			return loadStore(env, ctx, truth);
		}
	}
	// Both archives survive the prune: they are cached under separate keys but retired together, so
	// naming only the store here would drop the residue this build is paired with.
	commitSink(ctx, sink, manifest.store_key, [
		manifest.store_key,
		...(manifest.compat_key ? [manifest.compat_key] : []),
	]);

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

	const engine = new WasmEngine(env, manifest, ctx);
	current = { storeKey: manifest.store_key, engine, manifest };
	// The `in NNNms` is I/O WAIT ONLY — Workers freeze the clock during
	// synchronous execution, so it cannot see the decompression or the copy into
	// wasm. Judge this path by cpuTimeMs from the invocation's own event; the
	// linear-memory figure is the honest one here, and is a high-water mark.
	// PRE-CACHE THE RESIDUE, without attaching it, and WITHOUT blocking this request.
	//
	// It is still ATTACHED lazily on first `/cards/*` use, so a search-only region carries none of
	// its ~11.8MB of linear memory — that property is why the split exists. But cache ROWS are a
	// different resource from linear memory, and not filling them meant the first card request after
	// every wake paid a full KV fetch and gunzip in front of a user. Since `/cards/*` is the traffic
	// this deployment actually serves, that was the common case rather than the rare one.
	//
	// Deliberately under waitUntil rather than awaited. Awaiting it added ~1s to the FIRST request
	// after a publish (production wall went to 7674ms) for an archive that request does not need —
	// the store is already resident and answering by this point. waitUntil does not make the work
	// free, and this file says so elsewhere, but it does let the response go out first, which is the
	// whole difference between paying CPU and making someone wait.
	if (ctx?.storage && !cached && manifest.compat_key && manifest.compat_bytes) {
		const compatKey = manifest.compat_key;
		const compatBytes = manifest.compat_bytes;
		const storage = ctx.storage;
		// Published in residueFills BEFORE it is handed to waitUntil, so an attach on this very
		// request — the common case, since only /cards/* triggers one — can find it. Registering it
		// after the await would be a race with nothing in it.
		const fill = fillCache(storage, compatKey, kvCompatStream(env, manifest), compatBytes)
			.then((rows) => {
				console.log(`${tag(ctx)}pre-cached the card archive (${rows} rows) so the first /cards/* wake reads locally`);
				return rows;
			})
			.catch((err) => {
				console.warn(`${tag(ctx)}could not pre-cache the card archive (it will attach from KV): ${err}`);
			})
			.finally(() => {
				// Only clear the entry if it is still this fill: a hot swap can publish a newer one.
				if (residueFills.get(compatKey) === fill) residueFills.delete(compatKey);
			});
		residueFills.set(compatKey, fill);
		ctx.waitUntil(fill);
	}
	console.log(
		`${tag(ctx)}store loaded from ${cached ? "local cache" : "KV"}: ${manifest.store_key} (${manifest.card_count} cards, ` +
			`${manifest.store_bytes} bytes${!cached && manifest.store_gzip_bytes ? ` from ${manifest.store_gzip_bytes} gzipped` : ""}, ` +
			`built ${manifest.built_at}) in ${Date.now() - started}ms from ${pieces} pieces in ${blocks} blocks ` +
			`(linear memory ${(wasm.linearMemoryBytes() / 1048576).toFixed(1)}MB)`,
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
 * store before loading the new one — two ~76.6MB archives do not fit in a 128MB
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
	if (current?.storeKey === manifest.store_key) return false;

	// Prefetch under the OLD store, which keeps serving throughout. Failures here
	// are not fatal: the swap below falls back to reading from KV, which is what
	// it did before this cache existed.
	if (ctx.storage) {
		const keep = [manifest.store_key, ...(manifest.compat_key ? [manifest.compat_key] : [])];
		try {
			ensureCacheSchema(ctx.storage);
			const rows = await fillCache(ctx.storage, manifest.store_key, kvStoreStream(env, manifest), manifest.store_bytes);
			let compatRows = 0;
			if (manifest.compat_key && manifest.compat_bytes) {
				compatRows = await fillCache(
					ctx.storage,
					manifest.compat_key,
					kvCompatStream(env, manifest),
					manifest.compat_bytes,
				);
			}
			const dropped = pruneCache(ctx.storage, keep);
			console.log(
				`${tag(ctx)}prefetched ${manifest.store_key} (${rows} rows) + residue (${compatRows} rows) before swapping` +
					`${dropped.length ? `, dropped ${dropped.length} stale` : ""}`,
			);
		} catch (err) {
			console.warn(`${tag(ctx)}prefetch failed, swapping straight from KV: ${err}`);
		}
	}

	loading = loadStore(env, ctx, manifest).finally(() => {
		loading = null;
	});
	await loading;
	return true;
}

export async function getEngine(env: Env, ctx: LoadContext): Promise<Engine> {
	// No manifest re-check on the warm path: a publish reaches this isolate by
	// being pushed to it, so the hot path does no KV read at all.
	if (current) {
		// Re-point at THIS caller before handing the engine over: the engine is
		// isolate-global and its storage handle is not (see useContext).
		current.engine.useContext(ctx);
		return current.engine;
	}
	if (!loading) {
		loading = loadStore(env, ctx).finally(() => {
			loading = null;
		});
	}
	return loading;
}

/** Non-blocking: the local engine if this isolate is already warm, else null. */
export function tryGetLoadedEngine(): Engine | null {
	return current?.engine ?? null;
}
