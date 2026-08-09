// Interface of the wasm-bindgen module produced by engine/wasm (wasm-pack,
// bundler target; committed at engine/wasm/pkg, aliased in wrangler config).
// Mirrors engine/wasm/pkg/sylvan_engine_wasm.d.ts — keep in lockstep.
declare module "sylvan-engine-wasm" {
	/** Instantiate the engine on first use. Provided by the Workers shim
	 * (src/engine/wasm-shim.ts), not by wasm-bindgen: instantiation is lazy so
	 * request isolates, which never query, never pay for it. */
	export function ensureEngine(): void;
	export function __init_panic_hook(): void;
	/** Preallocate the aligned store buffer (one allocation, no growth). */
	export function begin_store_load(totalLen: number): void;
	/** Append an archive chunk (stream KV → wasm, no full JS-side copy). */
	export function store_load_chunk(chunk: Uint8Array): void;
	/** Validate + atomically activate; previous store survives any error. */
	export function finish_store_load(): void;
	/** One-shot load for tests/small stores (full JS-side copy — avoid in prod). */
	export function init_store(bytes: Uint8Array): void;
	/** Drop the active store ahead of a tight-memory hot swap. */
	export function unload_store(): void;
	export function store_loaded(): boolean;
	/** Printing count (upstream size()); 0 = no store loaded. */
	export function size(): number;
	/** Oracle-card count of the loaded store. */
	export function card_count(): number;
	/** Archive format version this build reads. */
	export function store_version(): number;
	/**
	 * Evaluate a filter tree. optsJson: {unique, prefer, orderby, direction,
	 * limit, offset, fields} (missing keys = upstream pyo3 defaults).
	 * Returns {"total": n, "rows": [...]} JSON.
	 */
	export function query(filterTreeJson: string, optsJson: string): string;
	/** {"card_types": {...}, "card_keywords": {...}} JSON. */
	export function catalog(): string;
	/** n sampled preferred printings; deterministic per seed. JSON array. */
	export function random_search(n: number, seed: bigint, fieldsJson: string): string;
}
