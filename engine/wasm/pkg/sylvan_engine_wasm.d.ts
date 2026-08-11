/* tslint:disable */
/* eslint-disable */

/**
 * Panics must be loud, not silent isolate deaths: route the panic message to
 * console.error before the trap. Installed once at module instantiation.
 */
export function __init_panic_hook(): void;

/**
 * Card names matching a partial name, prefix matches first. Scryfall's autocomplete catalog.
 */
export function autocomplete(prefix: string, limit: number): string;

/**
 * Start a chunked residue load. The active store must already be loaded: the residue shares its
 * index space and string tables, so there is nothing to attach it to otherwise.
 */
export function begin_compat_load(total_len: number): void;

/**
 * Start a chunked store load: preallocate the full aligned buffer up front
 * (one allocation, no growth reallocs while chunks stream in). Any previous
 * in-progress load is discarded; the ACTIVE store is untouched until
 * `finish_store_load` succeeds.
 */
export function begin_store_load(total_len: number): void;

/**
 * One card by a marketplace or client id, or `null`. `namespace` is Scryfall's own path segment.
 */
export function card_by_external_id(namespace: string, external_id: bigint, fields_json: string): string;

/**
 * One card by Scryfall id, or `null`.
 */
export function card_by_scryfall_id(scryfall_id: string, fields_json: string): string;

/**
 * Oracle-card count of the loaded store; 0 when no store is loaded.
 */
export function card_count(): number;

/**
 * Cards by Scryfall id, in the order given, skipping misses. One boundary crossing for the whole
 * batch: `POST /cards/collection` resolves up to 175 identifiers.
 */
export function cards_by_scryfall_ids(ids_json: string, fields_json: string): string;

/**
 * `{"card_types": {name: count}, "card_keywords": {name: count}}` — the data
 * behind /get_catalog.
 */
export function catalog(): string;

/**
 * Append one chunk of the residue archive.
 */
export function compat_load_chunk(chunk: Uint8Array): void;

/**
 * Whether the residue archive is attached to the active store.
 */
export function compat_loaded(): boolean;

/**
 * Validate the streamed residue archive and attach it to the active store.
 */
export function finish_compat_load(): void;

/**
 * Validate the streamed archive and atomically swap it in as the active
 * store. On any error the in-progress buffer is dropped and the previously
 * active store (if any) keeps serving.
 */
export function finish_store_load(): void;

/**
 * Scryfall's `?fuzzy=` name lookup. Returns `{"status": "hit"|"ambiguous"|"miss", "card": ...}`.
 *
 * `ambiguous` stays distinct from `miss` because Scryfall reports it, and answering 404 would
 * tell the client the card does not exist.
 */
export function fuzzy_card_by_name(name: string, floor: number, lead: number, fields_json: string): string;

/**
 * One-shot residue attach, the `init_store` twin.
 */
export function init_compat_store(bytes: Uint8Array): void;

/**
 * One-shot load for callers that already hold the whole archive (tests,
 * small stores). Copies `bytes` into an aligned buffer; prefer the chunked
 * API for production-size stores to avoid a second full-size JS-side copy.
 */
export function init_store(bytes: Uint8Array): void;

/**
 * Every printing of one oracle card, representative first. Empty array for an unknown id.
 */
export function printings_of_oracle_id(oracle_id: string, fields_json: string): string;

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
