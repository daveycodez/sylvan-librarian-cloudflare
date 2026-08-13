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
 * The best printing carrying this illustration id, or `null`.
 */
export function card_by_illustration_id(illustration_id: string, fields_json: string): string;

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
 * One card per distinct name containing EVERY word, best printing each, up to `limit`.
 * The containment stage of `/cards/named?fuzzy=`; the caller asks for 2 and reads the count.
 */
export function cards_containing_all_words(words_json: string, set_code: string, limit: number, fields_json: string): string;

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
 * The best printing of a card whose FOLDED name matches exactly, or `null`.
 *
 * `folded` must already be lowercased and accent-folded by the caller (foldAccents in
 * src/parser/pystr.ts), the same way `card_name_folded` was at import. `set_code` is "" for no
 * set restriction.
 */
export function exact_card_by_name(folded: string, set_code: string, fields_json: string): string;

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
 * The same query as [`query`], answered as `<total> <row count>\n<rows JSON array>` IN BYTES.
 *
 * For the caller that wants the rows ENCODED rather than as objects — which is /search, whose
 * whole path was `wasm.query` -> `JSON.parse` -> `JSON.stringify`, producing the same bytes it
 * started with. See `QueryOutput::into_total_and_rows_bytes`. `query` is kept for the callers
 * that genuinely need the rows as values (the columnar shape, and the card-object routes until
 * those build their objects here too).
 *
 * Returns `Vec<u8>`, so wasm-bindgen hands JS a `Uint8Array` by copying the linear-memory slice.
 * A `String` return would instead `TextDecoder.decode` it into a UTF-16 JS string, which the
 * Durable Object RPC would UTF-8 encode straight back on the way out — two full passes over the
 * payload, both charged to CPU budgets, to arrive at the bytes written here.
 */
export function query_rows(filter_tree_json: string, opts_json: string): Uint8Array;

/**
 * `n` randomly sampled oracle cards, each as its default-preferred printing —
 * the engine behind /random_search. `seed` comes from the caller (JS
 * `crypto.getRandomValues` or per-request entropy): the sampling itself is
 * deterministic per seed. `fields_json` is a JSON list of field names, or
 * "null"/"" for the default field set. Returns a JSON array of card objects.
 */
export function random_search(n: number, seed: bigint, fields_json: string): string;

/**
 * One engine row as a Scryfall card object, for the differential test that guards the port.
 *
 * Needs NO store: the builder is a pure function of the row and the base URL, which is what lets
 * `tests/routes/card-object-parity.test.ts` instantiate the engine and compare this against
 * `toScryfallCard` byte for byte. Not on any request path — the routes go through
 * `scryfall_search`, which writes a whole page at once.
 */
export function scryfall_card_from_row(row_json: string, base_url: string): string;

/**
 * A page of Scryfall card objects as `<total> <row count>\n<cards JSON array>`, in UTF-8 bytes.
 *
 * What /cards/search runs. The card objects are built HERE rather than by the caller, so the
 * Durable Object no longer parses the engine's rows, constructs ~60 keys per card in JS, and
 * re-encodes the result — it hands these bytes to the response. Requires the residue archive to
 * be attached, like every other card-object entry point.
 */
export function scryfall_search(filter_tree_json: string, opts_json: string, base_url: string): Uint8Array;

/**
 * The same page, RETAINED in linear memory and described by `[ptr, len]`.
 *
 * `scryfall_search` above returns `Vec<u8>`, and wasm-bindgen delivers that to JS by allocating a
 * fresh `Uint8Array` and copying the whole thing out — `getArrayU8FromWasm0(...).slice()` in the
 * generated glue. For a 652KB /cards/search page that is a full copy of the payload purely to
 * change which side of the boundary owns it, on the route whose Durable Object CPU is already
 * dominated by handling these bytes.
 *
 * So the buffer stays here and the caller reads a view over it. The `Vec<u32>` return is copied,
 * but it is two words.
 *
 * THE CALLER MUST FINISH WITH THE VIEW BEFORE THE NEXT ENGINE CALL, and before anything that can
 * grow linear memory — growth DETACHES the ArrayBuffer every view is built on, and the next call
 * through here overwrites this slot. That is safe exactly once: the reader takes the view and
 * hands it to a `Response` synchronously, with no await in between, which is why this pairs with
 * the response-building path rather than with the RPC one. Anything that stores the view for
 * later gets corruption, not an error.
 */
export function scryfall_search_retained(filter_tree_json: string, opts_json: string, base_url: string): Uint32Array;

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
