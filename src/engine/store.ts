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
import { type ArchiveCacheStorage, cachedArchiveStream, ensureCacheSchema, fillCache, pruneCache } from "./store-cache";
import { kvCompatStream, kvStoreStream, readManifest } from "./store-kv";
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

// How stale an isolate's view of the manifest may get before a background
// re-check. Nightly publishes mean sub-hour propagation is plenty.
const MANIFEST_RECHECK_MS = 5 * 60 * 1000;

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
let lastManifestCheck = 0;

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
		/** The load context that built this engine, so a later residue attach can reach the same
		 * local cache. Undefined outside a Durable Object, where the attach goes to KV as before. */
		private readonly ctx?: LoadContext,
	) {}

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

	async search(opts: EngineSearchOptions): Promise<EngineSearchResult> {
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
	async searchSerialized(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
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

	async commonCardTypes(): Promise<Record<string, number>> {
		return this.catalog().card_types;
	}

	async commonCardKeywords(): Promise<Record<string, number>> {
		return this.catalog().card_keywords;
	}

	async samplePreferred(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		// Engine sampling is deterministic per seed; per-request entropy keeps
		// /random_search random, mirroring upstream's process-side RNG.
		const seedBytes = crypto.getRandomValues(new BigUint64Array(1));
		const seed = seedBytes[0] ?? 0n;
		return JSON.parse(wasm.random_search(numCards, seed, JSON.stringify(fields))) as Record<string, unknown>[];
	}

	async samplePreferredSerialized(
		numCards: number,
		fields: string[],
		shape: ResultShape,
	): Promise<EngineSerializedResult> {
		const rows = await this.samplePreferred(numCards, fields);
		return { totalCards: rows.length, cardsBytes: encodeUtf8(serializeCards(rows, shape)), rowCount: rows.length };
	}

	async size(): Promise<number> {
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
async function feedStore(body: ReadableStream<Uint8Array>, totalLen: number): Promise<FeedCounts> {
	wasm.begin_store_load(totalLen);
	const counts = await feedBlocks(body, (block) => wasm.store_load_chunk(block));
	wasm.finish_store_load();
	return counts;
}

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
	wasm.begin_compat_load(total);
	// Cached and fed exactly like the store, and for the same reason: this lands on the `/cards/*`
	// cold path where the store has usually just been loaded, so both decompressions bill to one
	// request. The archives are cached under separate keys because they are attached at different
	// times — a search-only colo never pays for this one.
	const { body, cached } = archiveBytes(
		ctx,
		manifest.compat_key,
		total,
		() => kvCompatStream(env, manifest),
		() => [manifest.store_key, manifest.compat_key as string],
	);
	const counts = await feedBlocks(body, (block) => wasm.compat_load_chunk(block));
	wasm.finish_compat_load();
	return { ...counts, cached };
}

/**
 * The archive's bytes, from the local cache when it holds a complete copy and from KV otherwise —
 * and, when it came from KV, a background fill so the next wake in this colo does not.
 *
 * The fill re-streams from KV rather than tapping the bytes on their way into wasm. That costs a
 * second read and a second decompression, and buys the thing this whole change is about: the
 * REQUEST pays neither. A tap would put ~52 SQLite writes inside the cold load it is meant to make
 * faster, which is precisely how the previous local-copy design earned its removal.
 *
 * Every failure here is swallowed. The cache is an optimisation over a source of truth that is
 * still KV, so a fill that fails must never fail the load that triggered it.
 */
function archiveBytes(
	ctx: LoadContext | undefined,
	key: string,
	expected: number,
	fromKv: () => ReadableStream<Uint8Array>,
	keepAfterFill: () => readonly string[],
): { body: ReadableStream<Uint8Array>; cached: boolean } {
	const storage = ctx?.storage;
	if (storage) {
		try {
			// The schema has to exist before the first SELECT, and the first load on a fresh Durable
			// Object is exactly when it does not — reading a table that has never been created throws.
			ensureCacheSchema(storage);
			const local = cachedArchiveStream(storage, key, expected);
			if (local) return { body: local, cached: true };
		} catch (err) {
			// A cache that cannot be read is a cache miss, never a failed load. This catch is what
			// makes "KV is the source of truth" true in the code and not just in the comments: every
			// fault on this side — no schema, corrupt row, storage unavailable — falls through to KV.
			console.warn(`${tag(ctx)}local archive cache unreadable for ${key} (falling back to KV): ${err}`);
		}
	}
	if (storage && ctx) {
		ctx.waitUntil(
			(async () => {
				const started = Date.now();
				const rows = await fillCache(storage, key, fromKv(), expected);
				const dropped = pruneCache(storage, keepAfterFill());
				console.log(
					`${tag(ctx)}archive cached locally: ${key} (${expected} bytes in ${rows} rows) in ${Date.now() - started}ms` +
						`${dropped.length ? `, dropped ${dropped.length} stale (${dropped.join(", ")})` : ""}`,
				);
			})().catch((err) =>
				console.warn(`${tag(ctx)}local archive cache fill failed for ${key} (KV still serves): ${err}`),
			),
		);
	}
	return { body: fromKv(), cached: false };
}

async function loadStore(env: Env, ctx?: LoadContext): Promise<Engine> {
	// The one place wasm is first touched, so the one place that has to bring
	// it up. Isolates that only parse and RPC never reach here and never pay
	// the instantiation — see the header of wasm-shim.ts.
	wasm.ensureEngine();
	const manifest = await readManifest(env);
	lastManifestCheck = Date.now();

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

	const started = Date.now();
	// Local first (decompressed, no network); KV otherwise, with a background fill behind it. Both
	// archives are named as survivors so the fill's prune does not drop the residue this store is
	// paired with — they are cached under separate keys but retired together.
	const { body, cached } = archiveBytes(
		ctx,
		manifest.store_key,
		manifest.store_bytes,
		() => kvStoreStream(env, manifest),
		() => [manifest.store_key, ...(manifest.compat_key ? [manifest.compat_key] : [])],
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
	const { pieces, blocks } = await feedStore(body, manifest.store_bytes);

	const engine = new WasmEngine(env, manifest, ctx);
	current = { storeKey: manifest.store_key, engine, manifest };
	// The `in NNNms` is I/O WAIT ONLY — Workers freeze the clock during
	// synchronous execution, so it cannot see the decompression or the copy into
	// wasm. Judge this path by cpuTimeMs from the invocation's own event; the
	// linear-memory figure is the honest one here, and is a high-water mark.
	console.log(
		`${tag(ctx)}store loaded from ${cached ? "local cache" : "KV"}: ${manifest.store_key} (${manifest.card_count} cards, ` +
			`${manifest.store_bytes} bytes${!cached && manifest.store_gzip_bytes ? ` from ${manifest.store_gzip_bytes} gzipped` : ""}, ` +
			`built ${manifest.built_at}) in ${Date.now() - started}ms from ${pieces} pieces in ${blocks} blocks ` +
			`(linear memory ${(wasm.linearMemoryBytes() / 1048576).toFixed(1)}MB)`,
	);
	return engine;
}

/** Background manifest re-check; swaps the store if a new version published. */
async function refreshIfStale(env: Env, ctx?: LoadContext): Promise<void> {
	if (Date.now() - lastManifestCheck < MANIFEST_RECHECK_MS) return;
	lastManifestCheck = Date.now();
	try {
		const manifest = await readManifest(env);
		if (manifest && current && manifest.store_key !== current.storeKey) {
			loading = loadStore(env, ctx).finally(() => {
				loading = null;
			});
			await loading;
		}
	} catch (err) {
		console.error(`${tag(ctx)}manifest refresh failed (serving current store):`, err);
	}
}

export async function getEngine(env: Env, ctx: LoadContext): Promise<Engine> {
	if (current) {
		ctx.waitUntil(refreshIfStale(env, ctx));
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

/** Called from the cron handler so isolates converge on a fresh publish fast. */
export async function manifestPollAlarm(env: Env): Promise<void> {
	lastManifestCheck = 0;
	if (current) await refreshIfStale(env);
}
