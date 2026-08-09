// Per-isolate store manager: loads the rkyv store from KV into the wasm engine
// and hot-swaps when the manifest advances. It never starts an import — the
// index is built by the deploy (scripts/import-store.sh) and refreshed by the
// nightly cron, either of which fails loudly rather than shipping no index.
//
// Memory discipline: the store (~70MB) is streamed KV → wasm linear memory one
// ~20MB chunk at a time; no full-store JS buffer ever exists, keeping peak
// isolate usage inside the 128MB limit.
//
// The wasm engine is instantiated lazily (wasm-shim.ts): only a DO that
// actually loads a store pays for it, never a plain request isolate.
//
// There is deliberately NO Cache API layer in front of KV. The previous
// architecture wrote the store through `caches.default` and read it back, and
// that double-stream measured 0.6-1.3s of billed CPU per load — the single
// largest cost in the old system. KV's own `cacheTtl` gives colo-level caching
// for free, on immutable chunk keys, with none of that overhead.

import * as wasm from "sylvan-engine-wasm";
import { serializeCards } from "./columnar";
import { kvStoreStream, readManifest } from "./store-kv";
import type {
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	Env,
	ResultShape,
} from "./types";
import { EngineUnavailableError } from "./types";

// How stale an isolate's view of the manifest may get before a background
// re-check. Nightly publishes mean sub-hour propagation is plenty.
const MANIFEST_RECHECK_MS = 5 * 60 * 1000;

let current: { storeKey: string; engine: Engine } | null = null;
let loading: Promise<Engine> | null = null;
let lastManifestCheck = 0;

class WasmEngine implements Engine {
	private query(opts: EngineSearchOptions): { total: number; rows: Record<string, unknown>[] } {
		return JSON.parse(
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
	}

	async search(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		const result = this.query(opts);
		return { totalCards: result.total, cards: result.rows };
	}

	async searchSerialized(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		const result = this.query(opts);
		return { totalCards: result.total, cardsJson: serializeCards(result.rows, shape) };
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

	async samplePreferredSerialized(
		numCards: number,
		fields: string[],
		shape: ResultShape,
	): Promise<EngineSerializedResult> {
		const rows = await this.samplePreferred(numCards, fields);
		return { totalCards: rows.length, cardsJson: serializeCards(rows, shape) };
	}

	async size(): Promise<number> {
		return wasm.size();
	}
}

export { readManifest } from "./store-kv";

/** Stream the store bytes into wasm memory via the chunked loader. */
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

async function loadStore(env: Env): Promise<Engine> {
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
	const body = kvStoreStream(env, manifest);
	if (current) {
		// Hot swap: requests arriving during the swap await `loading` (set by
		// getEngine), so a brief unloaded window is invisible to callers.
		current = null;
		wasm.unload_store();
	}
	// Raw bytes, deliberately uncompressed: KV reads are metered per read, not
	// per byte, so compression would buy nothing but decompress CPU on every
	// load — and CPU is the scarcer meter.
	await feedStore(body, manifest.store_bytes);

	const engine = new WasmEngine();
	current = { storeKey: manifest.store_key, engine };
	console.log(
		`Store loaded from KV: ${manifest.store_key} (${manifest.card_count} cards, ` +
			`${manifest.store_bytes} bytes, built ${manifest.built_at}) in ${Date.now() - started}ms`,
	);
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

/** The loaded store's key, or null. */
export function currentStoreKey(): string | null {
	return current?.storeKey ?? null;
}

/** Force a manifest read + load now (single-flight). */
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
