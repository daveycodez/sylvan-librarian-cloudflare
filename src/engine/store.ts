// Per-isolate store manager: loads the rkyv store from D1 into the wasm engine
// and hot-swaps when the D1 manifest advances. It never starts an import — the
// index is built by the deploy (scripts/import-store.sh), which fails rather
// than shipping a Worker without one.
//
// Memory discipline: the store (~70MB) is streamed D1 → Cache API → wasm
// linear memory; no full-store JS buffer ever exists, keeping peak isolate
// usage inside the 128MB limit (measured: 73.1MB resident with the real
// corpus). Chunk reads are batched by BYTES, so a full load stays inside the
// free plan's per-invocation subrequest allowance whatever chunk size the
// publisher chose.

import * as wasm from "sylvan-engine-wasm";
import { readManifest } from "./manifest";
import type { Engine, EngineSearchOptions, EngineSearchResult, Env, StoreManifest } from "./types";
import { EngineUnavailableError } from "./types";

// Wasm panics must land in console.error, not die silently with the isolate.
wasm.__init_panic_hook();

// How stale an isolate's view of the manifest may get before a background
// re-check. Nightly publishes mean sub-hour propagation is plenty.
const MANIFEST_RECHECK_MS = 5 * 60 * 1000;
const STORE_CACHE_URL = "https://sylvan-store.internal/";
/** Target bytes per D1 query while streaming the store.
 *
 * Batched by BYTES, not by a fixed row count: publishers choose different chunk
 * sizes for their own reasons (the in-Worker import uses 900KB rows; the CI
 * seeder must use ~40KB rows to stay inside D1's 100KB SQL statement limit),
 * and a fixed row count would turn that into either oversized responses or
 * hundreds of queries. Hundreds matters — a full load's queries all happen in
 * one invocation, against the free plan's 50-subrequest budget. */
const CHUNK_BYTES_PER_QUERY = 1_800_000;

let current: { storeKey: string; engine: Engine } | null = null;
let loading: Promise<Engine> | null = null;
let lastManifestCheck = 0;

class WasmEngine implements Engine {
	async search(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		const result = JSON.parse(
			wasm.query(
				opts.filterTreeJson,
				JSON.stringify({
					unique: opts.unique,
					prefer: opts.prefer,
					orderby: opts.orderby,
					direction: opts.direction,
					limit: opts.limit,
					fields: opts.fields,
				}),
			),
		) as { total: number; rows: Record<string, unknown>[] };
		return { totalCards: result.total, cards: result.rows };
	}

	async commonCardTypes(): Promise<Record<string, number>> {
		return (JSON.parse(wasm.catalog()) as { card_types: Record<string, number> }).card_types;
	}

	async commonCardKeywords(): Promise<Record<string, number>> {
		return (JSON.parse(wasm.catalog()) as { card_keywords: Record<string, number> }).card_keywords;
	}

	async samplePreferred(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		// Engine sampling is deterministic per seed; per-request entropy keeps
		// /random_search random, mirroring upstream's process-side RNG.
		const seedBytes = crypto.getRandomValues(new BigUint64Array(1));
		const seed = seedBytes[0] ?? 0n;
		return JSON.parse(wasm.random_search(numCards, seed, JSON.stringify(fields))) as Record<string, unknown>[];
	}

	async size(): Promise<number> {
		return wasm.size();
	}
}

export { readManifest } from "./manifest";

/** D1 blob columns arrive as ArrayBuffer (or a number array on older paths). */
function asBytes(value: unknown): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (Array.isArray(value)) return Uint8Array.from(value as number[]);
	throw new Error(`store chunk has unexpected blob type ${typeof value}`);
}

/** Stream the store bytes into wasm memory via the chunked loader. */
async function feedStore(
	body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
	totalLen: number,
): Promise<void> {
	wasm.begin_store_load(totalLen);
	if (body instanceof ReadableStream) {
		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				wasm.store_load_chunk(value);
			}
		} finally {
			reader.releaseLock();
		}
	} else {
		for await (const chunk of body) {
			wasm.store_load_chunk(chunk);
		}
	}
	wasm.finish_store_load();
}

/**
 * Stream a content-addressed store out of D1: the manifest gives the chunk
 * order, `store_blobs` gives the bytes, and chunks shared with a previous
 * store version are simply the same rows.
 *
 * Batched by hash rather than by seq range, so the same query shape works
 * whether or not this version shares chunks with its predecessor. Rows come
 * back unordered (and a hash repeated in the store comes back once), so the
 * manifest's order is re-imposed here.
 */
function d1BlobStream(env: Env, storeKey: string, expectedBytes: number, hashes: string[]): ReadableStream<Uint8Array> {
	const avgChunk = hashes.length > 0 ? Math.ceil(expectedBytes / hashes.length) : CHUNK_BYTES_PER_QUERY;
	const perQuery = Math.max(1, Math.floor(CHUNK_BYTES_PER_QUERY / avgChunk));
	let next = 0;
	let seenBytes = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (next >= hashes.length) {
				if (seenBytes !== expectedBytes) {
					controller.error(
						new EngineUnavailableError(`Store ${storeKey} incomplete in D1: ${seenBytes}/${expectedBytes} bytes`),
					);
					return;
				}
				controller.close();
				return;
			}
			const want = hashes.slice(next, next + perQuery);
			const unique = [...new Set(want)];
			const res = await env.STORE_DB.prepare(
				`SELECT hash, bytes FROM store_blobs WHERE hash IN (${unique.map(() => "?").join(",")})`,
			)
				.bind(...unique)
				.all<{ hash: string; bytes: unknown }>();
			const byHash = new Map((res.results ?? []).map((row) => [row.hash, asBytes(row.bytes)]));
			for (const hash of want) {
				const bytes = byHash.get(hash);
				if (!bytes) {
					// A manifest referencing a blob that is gone means a prune raced
					// a publish, or the database was edited under us. Never serve a
					// short store: fail the load and keep the previous engine.
					controller.error(new EngineUnavailableError(`Store ${storeKey} is missing chunk ${hash} in D1`));
					return;
				}
				seenBytes += bytes.length;
				controller.enqueue(bytes);
			}
			next += want.length;
		},
	});
}

/** Stream the store's chunk rows out of D1, ~CHUNK_BYTES_PER_QUERY per query. */
function d1StoreStream(
	env: Env,
	storeKey: string,
	expectedBytes: number,
	chunkCount: number,
): ReadableStream<Uint8Array> {
	// Rows per query derived from the store's own average chunk size, so the
	// query count stays flat whatever the publisher chose. At least one row, so
	// an unexpectedly huge chunk still makes progress.
	const avgChunk = chunkCount > 0 ? Math.ceil(expectedBytes / chunkCount) : CHUNK_BYTES_PER_QUERY;
	const rowsPerQuery = Math.max(1, Math.floor(CHUNK_BYTES_PER_QUERY / avgChunk));
	let nextSeq = 0;
	let seenBytes = 0;
	let done = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (done) return;
			const res = await env.STORE_DB.prepare(
				"SELECT seq, bytes FROM store_chunks WHERE store_key = ? AND seq >= ? ORDER BY seq LIMIT ?",
			)
				.bind(storeKey, nextSeq, rowsPerQuery)
				.all<{ seq: number; bytes: unknown }>();
			const rows = res.results ?? [];
			if (rows.length === 0) {
				if (seenBytes !== expectedBytes) {
					controller.error(
						new EngineUnavailableError(`Store ${storeKey} incomplete in D1: ${seenBytes}/${expectedBytes} bytes`),
					);
					return;
				}
				done = true;
				controller.close();
				return;
			}
			for (const row of rows) {
				if (row.seq !== nextSeq) {
					controller.error(new EngineUnavailableError(`Store ${storeKey} has a chunk gap at seq ${nextSeq}`));
					return;
				}
				nextSeq += 1;
				const bytes = asBytes(row.bytes);
				seenBytes += bytes.length;
				controller.enqueue(bytes);
			}
			if (seenBytes >= expectedBytes) {
				done = true;
				controller.close();
			}
		},
	});
}

/**
 * Fetch the store bytes as a stream: Cache API first, D1 on miss. On miss the
 * D1 chunk stream is written into the cache first (no JS-side buffering),
 * then read back — two sequential streams instead of one big resident buffer.
 */
export async function openStoreStream(env: Env, manifest: StoreManifest): Promise<ReadableStream<Uint8Array>> {
	const storeKey = manifest.store_key;
	const expectedBytes = manifest.store_bytes;
	// A manifest with a chunk list is content-addressed; one without predates
	// that and still lives in store_chunks, keyed by seq. Both must load: the
	// deploy publishes the store and the Worker separately, so a new Worker
	// routinely meets a manifest an older publisher wrote.
	const hashes = manifest.chunks;
	const fromD1 = () =>
		hashes
			? d1BlobStream(env, storeKey, expectedBytes, hashes)
			: d1StoreStream(env, storeKey, expectedBytes, manifest.chunk_count ?? 0);
	const cacheKey = new Request(STORE_CACHE_URL + encodeURIComponent(storeKey));
	const cache = caches.default;

	const hit = await cache.match(cacheKey);
	if (hit?.body) {
		// Keys are content-addressed, but defend against a stale body anyway
		// (dev state can pair an old cache with a newer database): on a length
		// mismatch, drop the entry and rebuild from D1 rather than letting the
		// wasm loader reject the stream mid-swap.
		if (Number(hit.headers.get("content-length")) === expectedBytes) return hit.body;
		await hit.body.cancel();
		await cache.delete(cacheKey);
	}

	// Existence probe before caching: a manifest naming a store D1 no longer
	// has must fail loudly, never serve a silently empty engine.
	const probe = hashes
		? await env.STORE_DB.prepare("SELECT 1 AS one FROM store_blobs WHERE hash = ?")
				.bind(hashes[0] ?? "")
				.first()
		: await env.STORE_DB.prepare("SELECT 1 AS one FROM store_chunks WHERE store_key = ? AND seq = 0")
				.bind(storeKey)
				.first();
	if (!probe) {
		throw new EngineUnavailableError(`Store ${storeKey} missing from D1 despite manifest`);
	}

	await cache.put(
		cacheKey,
		new Response(fromD1(), {
			headers: {
				"content-length": String(expectedBytes),
				"Cache-Control": "public, max-age=604800, immutable", // keyed by store_key → content-addressed
			},
		}),
	);
	const cached = await cache.match(cacheKey);
	if (cached?.body) return cached.body;

	// Cache eviction raced us; fall back to a fresh D1 read.
	return fromD1();
}

async function loadStore(env: Env): Promise<Engine> {
	const manifest = await readManifest(env);
	lastManifestCheck = Date.now();

	if (!manifest) {
		// Deliberately does NOT start an import. Building the card index is the
		// deploy's job (scripts/deploy.sh), where there is 8GB and 20 minutes to
		// do it in, and a failure fails the deploy. A request finding no store
		// means the deploy did not publish one — kicking a 10-minute in-Worker
		// rebuild here would hide that, and hide it once per visitor.
		throw new EngineUnavailableError("No store manifest in D1; deploy has not published an index");
	}

	if (!manifest.store_bytes || !manifest.store_key.endsWith(".store")) {
		// A manifest from an incompatible builder format. Loud, and
		// self-healing: the next import publishes the current format.
		throw new EngineUnavailableError(`Manifest ${manifest.store_key} is not in the raw store format this Worker reads`);
	}

	if (current && current.storeKey === manifest.store_key) return current.engine;

	const body = await openStoreStream(env, manifest);
	if (current) {
		// Hot swap: requests arriving during the swap await `loading` (set by
		// getEngine), so a brief unloaded window is invisible to callers.
		current = null;
		wasm.unload_store();
	}
	// Raw bytes, deliberately uncompressed: D1 reads cost rows, not bytes,
	// while decompress CPU would be metered on every isolate warm-up.
	await feedStore(body, manifest.store_bytes);

	const engine = new WasmEngine();
	current = { storeKey: manifest.store_key, engine };
	console.log(`Store loaded: ${manifest.store_key} (${manifest.card_count} cards, built ${manifest.built_at})`);
	return engine;
}

/** Background manifest re-check; swaps the store if a new version published. */
async function refreshIfStale(env: Env): Promise<void> {
	if (Date.now() - lastManifestCheck < MANIFEST_RECHECK_MS) return;
	lastManifestCheck = Date.now();
	try {
		const manifest = await readManifest(env);
		if (manifest && current && manifest.store_key !== current.storeKey) {
			loading = loadStore(env).finally(() => {
				loading = null;
			});
			await loading;
		}
	} catch (err) {
		console.error("Manifest refresh failed (serving current store):", err);
	}
}

export async function getEngine(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Engine> {
	if (current) {
		ctx.waitUntil(refreshIfStale(env));
		return current.engine;
	}
	if (!loading) {
		loading = loadStore(env).finally(() => {
			loading = null;
		});
	}
	return loading;
}

/** The loaded store's key, or null — lets the DO decide persistence/freshness. */
export function currentStoreKey(): string | null {
	return current?.storeKey ?? null;
}

/** What adoptStoreFromChunks needs to know about a locally-persisted store. */
export interface AdoptableStoreMeta {
	store_key: string;
	store_bytes: number;
	card_count: number;
	built_at: string;
}

/**
 * Activate a store from an arbitrary chunk source (the DO's SQLite copy on
 * wake) without touching D1. Same guards as the D1 path: no-op when the key
 * is already active, single-flight via `loading`.
 */
export function adoptStoreFromChunks(meta: AdoptableStoreMeta, chunks: AsyncIterable<Uint8Array>): Promise<Engine> {
	if (current && current.storeKey === meta.store_key) return Promise.resolve(current.engine);
	if (loading) return loading;
	loading = (async () => {
		if (current) {
			current = null;
			wasm.unload_store();
		}
		await feedStore(chunks, meta.store_bytes);
		const engine = new WasmEngine();
		current = { storeKey: meta.store_key, engine };
		console.log(
			`Store adopted from local chunks: ${meta.store_key} (${meta.card_count} cards, built ${meta.built_at})`,
		);
		return engine;
	})().finally(() => {
		loading = null;
	});
	return loading;
}

/** Force a manifest read + load now (single-flight); used by DO freshening. */
export function reloadStore(env: Env): Promise<Engine> {
	if (loading) return loading;
	loading = loadStore(env).finally(() => {
		loading = null;
	});
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
