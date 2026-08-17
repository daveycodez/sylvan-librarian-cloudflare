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
 * `{"card_types": {…}, "card_keywords": {…}, "sets_with_extras": [code, …]}` —
 * the data behind /get_catalog, plus the `include_extras` auto-enable table.
 *
 * The extras table rides HERE rather than on an export of its own because the
 * route that reads it needs it at most once per store generation: this is the
 * one call the isolate already caches whole, so a set-scoped `/cards/search`
 * costs zero extra round trips.
 */
export function catalog(): string;

/**
 * The best printing of a card whose FOLDED name matches exactly, or `null`.
 *
 * `folded` must already be lowercased and accent-folded by the caller (foldAccents in
 * src/parser/pystr.ts), the same way `card_name_folded` was at import. `set_code` is "" for no
 * set restriction.
 */
export function exact_card_by_name(folded: string, set_code: string, fields_json: string): string;

/**
 * How well this partition's best `exact=` candidate matches, as `[tier, score]`, or `null`.
 *
 * Tier descends 2 (the needle IS a card's whole name) > 1 (it matches a FACE) > 0 (a FLAVOR
 * name); ties break on prefer_score. Compare these, do not interpret them.
 *
 * EXISTS FOR THE PARTITIONED ROUTER. `exact_card_by_name` ranks its candidates, but with the
 * corpus cut into partitions that ranking is LOCAL — and more than one partition can answer,
 * because a needle is often one card's whole name and another card's face name, and those two
 * cards hash apart. Taking the first non-null answer discarded the ranking and returned whichever
 * partition replied first. The router now ranks every partition with this and materializes only
 * the winner, which is the same shape `fuzzy_candidates` already uses for the fuzzy race.
 */
export function exact_name_rank(folded: string, set_code: string): string;

/**
 * Phase 2: the card rows for `vpids` (a Uint32Array from this partition's own phase 1), in
 * CALLER order, as a JSON array in UTF-8 bytes. An unknown vpid is a loud error — the ids came
 * from this same store moments ago, so a miss means the caller mixed partitions or generations.
 */
export function fetch_rows(vpids: Uint32Array, fields_json: string): Uint8Array;

/**
 * Validate the streamed archive and atomically swap it in as the active
 * store. On any error the in-progress buffer is dropped and the previously
 * active store (if any) keeps serving.
 */
export function finish_store_load(): void;

/**
 * The scores-bearing fuzzy surface for the cross-partition FLOOR/LEAD race: this partition's
 * top `k` distinct (card, name) candidate classes clearing `floor`, packed little-endian:
 *
 * ```text
 * n: u32, then n of:
 *   score: f32 LE
 *   oracle_id: 16 bytes (the uuid's big-endian byte order — render as the canonical
 *              hyphenated string; all zeros = unset)
 *   vpid: u32 LE (partition-local; meaningful only against THIS loaded store)
 *   namelen: u16 LE, then namelen bytes of the folded name (UTF-8)
 * ```
 *
 * The gather races the UNION of every partition's candidates with the engine's own rule:
 * global best by score; runner-up = best candidate differing from it in BOTH folded name and
 * oracle_id (a card never competes with itself, two cards sharing a name are one answer);
 * `hit` iff best − runner ≥ LEAD, then re-ask the winning partition's fuzzy_card_by_name —
 * whose local race the global winner provably also wins — to materialize the card.
 */
export function fuzzy_candidates(name: string, floor: number, k: number): Uint8Array;

/**
 * Scryfall's `?fuzzy=` name lookup. Returns `{"status": "hit"|"ambiguous"|"miss", "card": ...}`.
 *
 * `ambiguous` stays distinct from `miss` because Scryfall reports it, and answering 404 would
 * tell the client the card does not exist.
 */
export function fuzzy_card_by_name(name: string, floor: number, lead: number, fields_json: string): string;

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
 * `prefer`, `orderby`, `direction`, `limit`, `offset`, `fields`,
 * `include_multilingual` — missing keys take the same defaults as the
 * upstream pyo3 `query()`. Returns `{"total": n, "rows": [...]}` as a JSON
 * string.
 */
export function query(filter_tree_json: string, opts_json: string): string;

/**
 * Phase 1: the same query [`query`] runs, answered as keys — and, for the first `inline_rows`
 * of them, the rows too — packed little-endian:
 *
 * ```text
 * version: u32 (= KEY_PACKET_VERSION)
 * total: u32, n: u32, inline: u32
 * n      of: keylen: u16, key: keylen bytes, vpid: u32
 * inline of: rowlen: u32, row JSON bytes
 * ```
 *
 * `total` is the partition's exact match count; the keys are its top `offset + limit` in page
 * order. The key bytes are comparable across partitions (see card_engine's `encode_sort_key`);
 * `vpid` is meaningful only against the SAME loaded store — hand it back to [`fetch_rows`] on
 * this partition, never another.
 *
 * THE INLINE SECTION IS A PREFIX, and each row is framed separately rather than shipped as one
 * JSON array on purpose: most of them lose the cross-partition merge, and a gather that had to
 * parse the whole array to reach the few survivors would pay for the losers twice — once on the
 * wire and once in the parser. Framed, it parses exactly the rows the page kept.
 */
export function query_keys(filter_tree_json: string, opts_json: string, inline_rows: number): Uint8Array;

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
 * Whether a query would run the multilingual (widened) driver — `include_multilingual`, or a
 * `lang:` leaf in the bound filter.
 *
 * The partitioned gather builds its envelope from `query_keys` replies and never holds a
 * `QueryOutput`, so it asks this instead. `/cards/search` needs the answer to echo
 * `include_multilingual` in `next_page` the way Scryfall does.
 */
export function query_widens(filter_tree_json: string, opts_json: string): boolean;

/**
 * `n` randomly sampled oracle cards, each as the printing the FILTER chose (its
 * default-preferred one when there is no filter) — the engine behind
 * /random_search. `seed` comes from the caller (JS `crypto.getRandomValues` or
 * per-request entropy): the sampling itself is deterministic per seed.
 * `fields_json` is a JSON list of field names, or "null"/"" for the default
 * field set. Returns a JSON array of card objects.
 *
 * `filter_tree_json` is the LOCAL ADDITION: the same wire tree `search` takes,
 * or "null"/"" for the unfiltered pool. Without it this export could not
 * exclude anything and `/random_search` drew `is:extra` rows the search
 * surfaces hide — the route had nothing to gate with, because the pool is
 * here. A `TrueNode` costs nothing extra; see `sample_preferred`.
 */
export function random_search(n: number, seed: bigint, filter_tree_json: string, fields_json: string): string;

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
 * Printing count of the loaded store (the upstream `size()` health number);
 * 0 when no store is loaded, mirroring the pyo3 surface's "empty engine".
 */
export function size(): number;

/**
 * The sort-key layout version this build emits (the first byte of every key). The gather
 * refuses to merge streams whose versions differ — a mixed-generation fan-out must fail loudly,
 * not return a silently misordered page.
 */
export function sort_key_version(): number;

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
