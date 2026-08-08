// Per-isolate store manager: loads the rkyv store from D1 into the wasm
// engine, hot-swaps when the D1 manifest advances, and triggers the
// self-bootstrap import when the database is empty.
//
// Memory discipline: the store (~70MB) is streamed D1 → Cache API → wasm
// linear memory in ~1MB chunks; no full-store JS buffer ever exists, keeping
// peak isolate usage well inside the 128MB limit. Chunk reads are batched a
// few rows per query, so a full load stays inside the free plan's
// per-invocation subrequest allowance.

import * as wasm from "sylvan-engine-wasm";
import type { Engine, EngineSearchOptions, EngineSearchResult, Env, StoreManifest } from "./types";
import { EngineUnavailableError } from "./types";

// Wasm panics must land in console.error, not die silently with the isolate.
wasm.__init_panic_hook();

// How stale an isolate's view of the manifest may get before a background
// re-check. Nightly publishes mean sub-hour propagation is plenty.
const MANIFEST_RECHECK_MS = 5 * 60 * 1000;
// Per-isolate rate limit on bootstrap kicks; the coordinator DO dedupes anyway.
const BOOTSTRAP_KICK_INTERVAL_MS = 60 * 1000;
const STORE_CACHE_URL = "https://sylvan-store.internal/";
/** Chunk rows per D1 query while streaming the store (~2MB/query). */
const CHUNK_ROWS_PER_QUERY = 2;

let current: { storeKey: string; engine: Engine } | null = null;
let loading: Promise<Engine> | null = null;
let lastManifestCheck = 0;
let lastBootstrapKick = 0;

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

export async function readManifest(env: Env): Promise<StoreManifest | null> {
	try {
		const row = await env.STORE_DB.prepare("SELECT json FROM store_manifest WHERE id = 1").first<{ json: string }>();
		if (!row) return null;
		return JSON.parse(row.json) as StoreManifest;
	} catch (err) {
		// A fresh database has no tables yet — that is the bootstrap state, not
		// an error. Anything else propagates.
		if (String(err).includes("no such table")) return null;
		throw err;
	}
}

/** D1 blob columns arrive as ArrayBuffer (or a number array on older paths). */
function asBytes(value: unknown): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (Array.isArray(value)) return Uint8Array.from(value as number[]);
	throw new Error(`store chunk has unexpected blob type ${typeof value}`);
}

function kickBootstrap(env: Env, reason: string): void {
	const now = Date.now();
	if (now - lastBootstrapKick < BOOTSTRAP_KICK_INTERVAL_MS) return;
	lastBootstrapKick = now;
	const coordinator = env.IMPORT_COORDINATOR.get(env.IMPORT_COORDINATOR.idFromName("singleton"));
	// Fire and forget; the DO serializes concurrent kicks from many isolates.
	void coordinator.fetch(`https://coordinator/start-import?reason=${encodeURIComponent(reason)}`).catch((err) => {
		console.error("Failed to kick bootstrap import:", err);
	});
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

/** Stream the store's chunk rows out of D1, a few rows per query. */
function d1StoreStream(env: Env, storeKey: string, expectedBytes: number): ReadableStream<Uint8Array> {
	let nextSeq = 0;
	let seenBytes = 0;
	let done = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (done) return;
			const res = await env.STORE_DB.prepare(
				"SELECT seq, bytes FROM store_chunks WHERE store_key = ? AND seq >= ? ORDER BY seq LIMIT ?",
			)
				.bind(storeKey, nextSeq, CHUNK_ROWS_PER_QUERY)
				.all<{ seq: number; bytes: unknown }>();
			const rows = res.results ?? [];
			if (rows.length === 0) {
				if (seenBytes !== expectedBytes) {
					controller.error(
						new EngineUnavailableError(
							`Store ${storeKey} incomplete in D1: ${seenBytes}/${expectedBytes} bytes`,
							false,
						),
					);
					return;
				}
				done = true;
				controller.close();
				return;
			}
			for (const row of rows) {
				if (row.seq !== nextSeq) {
					controller.error(new EngineUnavailableError(`Store ${storeKey} has a chunk gap at seq ${nextSeq}`, false));
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
export async function openStoreStream(
	env: Env,
	storeKey: string,
	expectedBytes: number,
): Promise<ReadableStream<Uint8Array>> {
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
	const probe = await env.STORE_DB.prepare("SELECT 1 AS one FROM store_chunks WHERE store_key = ? AND seq = 0")
		.bind(storeKey)
		.first();
	if (!probe) {
		throw new EngineUnavailableError(`Store ${storeKey} missing from D1 despite manifest`, false);
	}

	await cache.put(
		cacheKey,
		new Response(d1StoreStream(env, storeKey, expectedBytes), {
			headers: {
				"content-length": String(expectedBytes),
				"Cache-Control": "public, max-age=604800, immutable", // keyed by store_key → content-addressed
			},
		}),
	);
	const cached = await cache.match(cacheKey);
	if (cached?.body) return cached.body;

	// Cache eviction raced us; fall back to a fresh D1 read.
	return d1StoreStream(env, storeKey, expectedBytes);
}

async function loadStore(env: Env): Promise<Engine> {
	const manifest = await readManifest(env);
	lastManifestCheck = Date.now();

	if (!manifest) {
		kickBootstrap(env, "bootstrap-empty-database");
		throw new EngineUnavailableError("No store manifest in D1; import has been triggered", true);
	}

	if (!manifest.store_bytes || !manifest.store_key.endsWith(".store")) {
		// A manifest from an incompatible builder format. Loud, and
		// self-healing: the next import publishes the current format.
		throw new EngineUnavailableError(
			`Manifest ${manifest.store_key} is not in the raw store format this Worker reads`,
			false,
		);
	}

	if (current && current.storeKey === manifest.store_key) return current.engine;

	const body = await openStoreStream(env, manifest.store_key, manifest.store_bytes);
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

/** Coordinator status passthrough for the bootstrap page. */
export async function importStatus(env: Env): Promise<unknown> {
	const coordinator = env.IMPORT_COORDINATOR.get(env.IMPORT_COORDINATOR.idFromName("singleton"));
	const res = await coordinator.fetch("https://coordinator/status");
	return res.json();
}
