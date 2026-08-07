/* tslint:disable */
/* eslint-disable */

/**
 * Panics must be loud, not silent isolate deaths: route the panic message to
 * console.error before the trap. Installed once at module instantiation.
 */
export function __init_panic_hook(): void;

/**
 * Start a chunked store load: preallocate the full aligned buffer up front
 * (one allocation, no growth reallocs while chunks stream in). Any previous
 * in-progress load is discarded; the ACTIVE store is untouched until
 * `finish_store_load` succeeds.
 */
export function begin_store_load(total_len: number): void;

/**
 * Oracle-card count of the loaded store; 0 when no store is loaded.
 */
export function card_count(): number;

/**
 * `{"card_types": {name: count}, "card_keywords": {name: count}}` — the data
 * behind /get_catalog.
 */
export function catalog(): string;

/**
 * Validate the streamed archive and atomically swap it in as the active
 * store. On any error the in-progress buffer is dropped and the previously
 * active store (if any) keeps serving.
 */
export function finish_store_load(): void;

/**
 * One-shot load for callers that already hold the whole archive (tests,
 * small stores). Copies `bytes` into an aligned buffer; prefer the chunked
 * API for production-size stores to avoid a second full-size JS-side copy.
 */
export function init_store(bytes: Uint8Array): void;

/**
 * Run a query. `filter_tree_json` is the filter-tree JSON (TrueNode /
 * AndNode / ... encoding); `opts_json` is an object with any of `unique`,
 * `prefer`, `orderby`, `direction`, `limit`, `offset`, `fields` — missing
 * keys take the same defaults as the upstream pyo3 `query()`. Returns
 * `{"total": n, "rows": [...]}` as a JSON string.
 */
export function query(filter_tree_json: string, opts_json: string): string;

/**
 * `n` randomly sampled oracle cards, each as its default-preferred printing —
 * the engine behind /random_search. `seed` comes from the caller (JS
 * `crypto.getRandomValues` or per-request entropy): the sampling itself is
 * deterministic per seed. `fields_json` is a JSON list of field names, or
 * "null"/"" for the default field set. Returns a JSON array of card objects.
 */
export function random_search(n: number, seed: bigint, fields_json: string): string;

/**
 * Printing count of the loaded store (the upstream `size()` health number);
 * 0 when no store is loaded, mirroring the pyo3 surface's "empty engine".
 */
export function size(): number;

/**
 * Append one chunk of the archive (wasm-bindgen copies the chunk into linear
 * memory; stream ~1MB chunks so the JS side never holds the whole store).
 */
export function store_load_chunk(chunk: Uint8Array): void;

export function store_loaded(): boolean;

/**
 * The archive format version this build reads/writes. A store manifest's
 * `format_version` must match, or `finish_store_load` will reject the bytes.
 */
export function store_version(): number;

/**
 * Drop the active store, returning its memory to the wasm allocator (linear
 * memory never shrinks, but the pages are reused by the next load). Call
 * before a swap when there isn't headroom for two stores at once.
 */
export function unload_store(): void;
