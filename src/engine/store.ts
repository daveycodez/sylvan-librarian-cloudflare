// Per-isolate store manager: loads the rkyv store from R2 into the wasm
// engine, hot-swaps when the R2 manifest advances, and triggers the
// self-bootstrap import when the bucket is empty.
//
// Memory discipline: the store (~70MB) is streamed R2 → Cache API → wasm
// linear memory in ~1MB chunks; no full-store JS buffer ever exists, keeping
// peak isolate usage well inside the 128MB limit.

import * as wasm from "sylvan-engine-wasm";
import type { Engine, EngineSearchOptions, EngineSearchResult, Env, StoreManifest } from "./types";
import { EngineUnavailableError } from "./types";

// Wasm panics must land in console.error, not die silently with the isolate.
wasm.__init_panic_hook();

const MANIFEST_KEY = "manifest.json";
// How stale an isolate's view of the manifest may get before a background
// re-check. Nightly publishes mean sub-hour propagation is plenty.
const MANIFEST_RECHECK_MS = 5 * 60 * 1000;
// Per-isolate rate limit on bootstrap kicks; the coordinator DO dedupes anyway.
const BOOTSTRAP_KICK_INTERVAL_MS = 60 * 1000;
const STORE_CACHE_URL = "https://sylvan-store.internal/";

let current: { storeKey: string; engine: Engine } | null = null;
let loading: Promise<Engine> | null = null;
let lastManifestCheck = 0;
let lastBootstrapKick = 0;

class WasmEngine implements Engine {
	search(opts: EngineSearchOptions): EngineSearchResult {
		const result = JSON.parse(
			wasm.query(
				JSON.stringify(opts.filterTree),
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

	commonCardTypes(): Record<string, number> {
		return (JSON.parse(wasm.catalog()) as { card_types: Record<string, number> }).card_types;
	}

	commonCardKeywords(): Record<string, number> {
		return (JSON.parse(wasm.catalog()) as { card_keywords: Record<string, number> }).card_keywords;
	}

	samplePreferred(numCards: number, fields: string[]): Record<string, unknown>[] {
		// Engine sampling is deterministic per seed; per-request entropy keeps
		// /random_search random, mirroring upstream's process-side RNG.
		const seedBytes = crypto.getRandomValues(new BigUint64Array(1));
		const seed = seedBytes[0] ?? 0n;
		return JSON.parse(wasm.random_search(numCards, seed, JSON.stringify(fields))) as Record<string, unknown>[];
	}

	size(): number {
		return wasm.size();
	}
}

async function readManifest(env: Env): Promise<StoreManifest | null> {
	const obj = await env.STORE.get(MANIFEST_KEY);
	if (!obj) return null;
	return (await obj.json()) as StoreManifest;
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

/** Stream the store object into wasm memory via the chunked loader. */
async function feedStore(body: ReadableStream<Uint8Array>, totalLen: number): Promise<void> {
	wasm.begin_store_load(totalLen);
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
	wasm.finish_store_load();
}

/**
 * Fetch the store bytes as a stream: Cache API first, R2 on miss. On miss the
 * R2 body is streamed into the cache first (no JS-side buffering), then read
 * back — two sequential streams instead of one big resident buffer.
 */
async function openStoreStream(
	env: Env,
	storeKey: string,
): Promise<{ body: ReadableStream<Uint8Array>; totalLen: number }> {
	const cacheKey = new Request(STORE_CACHE_URL + encodeURIComponent(storeKey));
	const cache = caches.default;

	const hit = await cache.match(cacheKey);
	if (hit?.body) {
		const len = Number(hit.headers.get("content-length") ?? 0);
		if (len > 0) return { body: hit.body, totalLen: len };
	}

	const obj = await env.STORE.get(storeKey);
	if (!obj) {
		// The manifest names a store object that is missing: loud failure, never
		// a silently empty engine (this deployment's honest-failure invariant).
		throw new EngineUnavailableError(`Store object ${storeKey} missing from R2 despite manifest`, false);
	}

	await cache.put(
		cacheKey,
		new Response(obj.body, {
			headers: {
				"content-length": String(obj.size),
				"Cache-Control": "public, max-age=604800, immutable", // keyed by store_key → content-addressed
			},
		}),
	);
	const cached = await cache.match(cacheKey);
	if (cached?.body) return { body: cached.body, totalLen: obj.size };

	// Cache eviction raced us; fall back to a fresh R2 read.
	const again = await env.STORE.get(storeKey);
	if (!again) throw new EngineUnavailableError(`Store object ${storeKey} vanished from R2`, false);
	return { body: again.body, totalLen: again.size };
}

async function loadStore(env: Env): Promise<Engine> {
	const manifest = await readManifest(env);
	lastManifestCheck = Date.now();

	if (!manifest) {
		kickBootstrap(env, "bootstrap-empty-bucket");
		throw new EngineUnavailableError("No store manifest in R2; import has been triggered", true);
	}

	if (current && current.storeKey === manifest.store_key) return current.engine;

	const { body, totalLen } = await openStoreStream(env, manifest.store_key);
	if (current) {
		// Hot swap: requests arriving during the swap await `loading` (set by
		// getEngine), so a brief unloaded window is invisible to callers.
		current = null;
		wasm.unload_store();
	}
	await feedStore(body, totalLen);

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

export async function getEngine(env: Env, ctx: ExecutionContext): Promise<Engine> {
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
