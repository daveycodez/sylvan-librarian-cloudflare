// Interface of the wasm-bindgen module produced by engine/wasm (wasm-pack,
// bundler target). Kept in one place so the store manager compiles before the
// crate is built; reconciled against the crate's actual exports at integration.
declare module "sylvan-engine-wasm" {
	/** Preallocate the store buffer (aligned; includes the 16-byte header). */
	export function begin_store_load(totalLen: number): void;
	/** Append a chunk of the store file (stream R2 → wasm, no full JS copy). */
	export function store_load_chunk(chunk: Uint8Array): void;
	/** Validate header + activate the store. Throws on a bad archive. */
	export function finish_store_load(): void;
	/** Drop the active store ahead of a hot swap. */
	export function unload_store(): void;
	export function store_loaded(): boolean;
	/** Cards in the active store. */
	export function size(): number;
	/**
	 * Evaluate a filter tree. optsJson: {unique, prefer, orderby, direction,
	 * limit, fields}. Returns {"total_cards": n, "cards": [...]} JSON.
	 */
	export function query(filterTreeJson: string, optsJson: string): string;
	/** {"types": {...}, "keywords": {...}} JSON (raw engine counts). */
	export function catalog(): string;
	/** Random preferred-printing sample as a JSON rows array. */
	export function sample_preferred(numCards: number, fieldsJson: string): string;
}
