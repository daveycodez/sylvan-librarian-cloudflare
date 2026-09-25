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
 * Start a load whose bytes arrive GZIPPED — one or more concatenated gzip members, which is how
 * a partition's stored chunks sit in KV and in the Durable Object's cache.
 *
 * The JS side used to decompress with `DecompressionStream` and cross the result in: in workerd
 * that is ~10,000 4KB pieces per partition, each resolved through the streams machinery, and it
 * measured 306-752ms of Durable Object CPU for a 14.3MB -> 40.8MB partition (a benchmark Worker,
 * one stage per invocation, 2026-09-22) — most of every cold wake, against 6-18ms to read the
 * same bytes out of KV and 29-85ms to copy them into wasm. Inflating here takes the compressed
 * bytes in whatever pieces the source delivers and writes the output directly into the
 * preallocated store buffer: no JS-side decompressed bytes at all, and one crossing per
 * compressed piece. Memory is unchanged — the buffer is the same one `begin_store_load` makes,
 * and the inflater's own state is its 32KB window.
 *
 * Same atomic contract as the uncompressed path: the active store is untouched until
 * `finish_store_load_gzip` succeeds.
 */
export function begin_store_load_gzip(total_len: number): void;

/**
 * Start a load whose bytes are the LZ4 frame stream a Durable Object cached (see the section
 * comment). Same atomic contract and the same buffer as the other two load paths: the active
 * store is untouched until `finish_store_load_lz4` succeeds, and a failed load's buffer is
 * recycled as the spare.
 */
export function begin_store_load_lz4(total_len: number): void;

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
 * A whole `POST /cards/collection` batch against THIS store in one call (LOCAL PATCH, Cloudflare
 * port) — every identifier kind at once, answered as finished card objects.
 *
 * The partitioned router used to spend up to 2N + N + N calls on one batch: `{name}` ranked on
 * every partition and then materialized from the winners, `{set, collector_number}` fanned out on
 * its own, and the id kinds on theirs. This answers all of them in ONE round: each name comes
 * back with its rank AND its local winner's card, so the router keeps the global winner's card
 * without asking again. That is exact, not a guess: the winning partition's local pick is the
 * same card its second-round materialize would have returned, because `collection_name_ranks`
 * and `collection_cards_by_names` rank by the same `name_best`.
 *
 * `request_json` is `{"keys": [...], "trees": [...], "tree_opts": {...}, "names": [[folded,
 * set], ...], "prefer": "...", "scope": "..."}`:
 *
 * - `keys`: `{"kind": "scryfall_id" | "oracle_id" | "illustration_id", "id": "<uuid>"}` or
 *   `{"kind": "external", "namespace": "mtgo" | "multiverse" | ..., "id": <n>}`. An oracle id
 *   answers its representative printing, as `/cards/collection` always has.
 * - `trees`: filter trees as JSON strings, each answered by its first row under `tree_opts`.
 * - `names`, `prefer`, `scope`: exactly `collection_cards_by_names`'s arguments.
 *
 * The answer is little-endian bytes:
 *
 * ```text
 * header_len: u32, header: header_len bytes of JSON — one rank per name, [served, tier, score] or null
 * then for each key, each tree, each name, in that order: len: u32, card: len bytes (0 = none)
 * ```
 *
 * Cards are written by `write_scryfall_card`, the builder `/cards/search` uses, so the router
 * splices them into the response without parsing them.
 */
export function collection_batch(request_json: string, fields_json: string, base_url: string): Uint8Array;

/**
 * The best printing a COLLECTION IDENTIFIER's `name` names, or `null` — `POST /cards/collection`.
 *
 * NOT `exact_card_by_name` with a different caller: a collection identifier reads a card's FACE
 * names when the name splits in exactly two and its whole name otherwise, where `exact=` also
 * reads the joined name and the flavor names. `{"name":"Fire // Ice"}` is not_found on
 * api.scryfall.com and `exact=Fire // Ice` is Fire // Ice — see `collection_card_by_name`.
 *
 * `folded` is lowercased and accent-folded by the caller (foldAccents in src/parser/pystr.ts);
 * the collating happens in the engine. `set_code` is "" for no set restriction.
 *
 * `prefer` and `scope_json` are the batch's `?q=` — its folded prefer (this API's spelling,
 * "default" for none) and its filter tree as canonical JSON ("" for none); see the engine's
 * `CollectionScope`.
 * One call for the WHOLE batch — `identifiers_json` is `[[folded, set_code], …]` — so the scope
 * is bound once rather than once per identifier (a regex in the scope compiled 75 times was
 * the difference between 25ms and 165ms on a full batch). Answers a JSON array, a card object or
 * `null` per identifier, in order.
 */
export function collection_cards_by_names(identifiers_json: string, fields_json: string, prefer: string, scope_json: string): string;

/**
 * How well this partition's best collection-identifier candidate matches, as
 * `[served, tier, score]` or `null` per identifier — the batched twin of `exact_name_rank`, and
 * there for the same partitioned router. Under a scope the score is the scope's prefer score
 * and served is always 1 (the scope's pool holds no extras).
 */
export function collection_name_ranks(identifiers_json: string, prefer: string, scope_json: string): string;

/**
 * The best printing of a card whose FOLDED name matches exactly, or `null`.
 *
 * `folded` must already be lowercased and accent-folded by the caller (foldAccents in
 * src/parser/pystr.ts), the same way `card_name_folded` was at import. `set_code` is "" for no
 * set restriction.
 */
export function exact_card_by_name(folded: string, set_code: string, fields_json: string): string;

/**
 * `exact_name_rank` and `exact_card_by_name` in ONE call, plus whether this store holds the
 * name at all — `{"rank": <exact_name_rank's text>, "present": bool, "card": <row or null>}`
 * (LOCAL PATCH, Cloudflare port).
 *
 * FOR THE NAME ROUTE (backlog n6). The router asks the partition the routing filter names for a
 * name FIRST, and one reply has to be enough to decide whether it is the answer: the rank says
 * whether a served card won (which no other partition can beat when this one is the name's only
 * served holder), and `present` says whether a MISS is real. A set-restricted miss here is
 * authoritative only if this store holds the name at all — then the filter's word that no other
 * partition does is exact, rather than an arbitrary value for a key it never held. So `present`
 * is computed, without the set, only when the restricted scan found nothing.
 *
 * `rank` is written by the same `format!` as `exact_name_rank`, so the router compares the two
 * exports' ranks as the same numbers.
 */
export function exact_name_probe(folded: string, set_code: string, fields_json: string): string;

/**
 * How well this partition's best `exact=` candidate matches, as `[served, tier, score]`, or
 * `null`.
 *
 * Served is 1 when the printing answered is one a default search shows and 0 when the name
 * exists only in the extras class (a memorabilia front card, a token, an art-series card);
 * tier descends 2 (the needle IS a card's whole name) > 1 (it matches a FACE) > 0 (a FLAVOR
 * name); ties break on prefer_score. Compared lexicographically, in that order — served leads,
 * so `exact=Earth Rumble` answers the tla sorcery over the jtla front card of the same name
 * whatever partition each hashed to. Compare these, do not interpret them.
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
 * Phase 2: the rows for `vpids` (a Uint32Array from this partition's own phase 1), in CALLER
 * order, as a ROW PACKET — `n: u32 LE`, then `n` framed rows exactly as [`query_keys`] frames
 * its inline section, in the same `shape`. Individually framed rather than one JSON array so the
 * coordinator splices them into the page by memcpy, never through a parser. An unknown vpid is
 * a loud error — the ids came from this same store moments ago, so a miss means the caller
 * mixed partitions or generations.
 */
export function fetch_rows(vpids: Uint32Array, fields_json: string, shape: string, base_url: string): Uint8Array;

/**
 * Validate the streamed archive and atomically swap it in as the active
 * store. On any error the in-progress buffer is RECYCLED as the spare (see
 * `recycle`) and the previously active store (if any) keeps serving.
 */
export function finish_store_load(): void;

/**
 * Finish a gzipped load: the last member must be complete (its CRC and length trailer verified by
 * the decoder), the output exactly the declared length, and the header this build's. Then the
 * store swaps in atomically, exactly as `finish_store_load` does. On any error the buffer is
 * RECYCLED as the spare, never dropped.
 */
export function finish_store_load_gzip(): void;

/**
 * Finish an LZ4 load: no partial frame left over, the output exactly the declared length, and
 * the header this build's. Then the store swaps in atomically, as the other two paths do.
 */
export function finish_store_load_lz4(): void;

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
 *   served: u8 (1 = a printing a default search shows, 0 = the card is extras-only; the
 *           race's tiebreak on a score tie, so the served card of a shared name leads)
 *   namelen: u16 LE, then namelen bytes of the folded name (UTF-8)
 * ```
 *
 * The gather races the UNION of every partition's candidates with the engine's own rule:
 * global best by score; runner-up = best candidate differing from it in BOTH folded name and
 * oracle_id (a card never competes with itself, two cards sharing a name are one answer);
 * `hit` iff best − runner ≥ LEAD, then re-ask the winning partition's fuzzy_card_by_name —
 * whose local race the global winner provably also wins — to materialize the card.
 *
 * `set_code` ("" for none) is `fuzzy_card_by_name`'s: the same set-scoped pool, so the global race
 * and the winner's local one stay one race.
 */
export function fuzzy_candidates(name: string, set_code: string, floor: number, k: number): Uint8Array;

/**
 * Scryfall's `?fuzzy=` name lookup. Returns `{"status": "hit"|"ambiguous"|"miss", "card": ...}`.
 *
 * `ambiguous` stays distinct from `miss` because Scryfall reports it, and answering 404 would
 * tell the client the card does not exist.
 *
 * `set_code` ("" for none) scopes the candidate POOL: only cards with a printing in the set race,
 * and a hit is the card's best printing there — `fuzzy=lightning bolt&set=war` is Scryfall's 404
 * and `fuzzy=lightning blow&set=m11` its M11 Lightning Bolt (see card_engine's
 * `preferred_served_vpid_in`).
 */
export function fuzzy_card_by_name(name: string, set_code: string, floor: number, lead: number, fields_json: string): string;

/**
 * One-shot load for callers that already hold the whole archive (tests,
 * small stores). Copies `bytes` into an aligned buffer; prefer the chunked
 * API for production-size stores to avoid a second full-size JS-side copy.
 */
export function init_store(bytes: Uint8Array): void;

/**
 * `values` as a JSON array in JavaScript's spelling — FOR THE PARITY TEST, which feeds it
 * doubles by their bits (a JSON round trip would let serde_json's best-effort float parse move
 * the value it is testing) and compares against `JSON.stringify`. Not on any request path.
 */
export function js_spelled_numbers(values: Float64Array): string;

/**
 * Replace this instance's card names with a gzipped blob. Returns how many pairs it holds. The
 * previous list is dropped FIRST, so a reload reuses its memory instead of holding two.
 */
export function load_names(gz: Uint8Array): number;

/**
 * `/cards/named?fuzzy=` against THIS store in one call (LOCAL PATCH, Cloudflare port; backlog
 * n7): the exact stage, the typo stage and the containment stage together, so the partitioned
 * router asks each partition ONCE where it used to ask every partition three times over three
 * sequential rounds (probes, then fuzzy candidates plus the winner's materialize, then
 * containment).
 *
 * Every section is written by the export that answers that stage alone, called here with the
 * same arguments, so the bundle cannot drift from them:
 *
 * ```text
 * header_len: u32 LE, header: header_len bytes of JSON —
 *   {"exact": <exact_name_probe(folded, set_code, fields)>,
 *    "fuzzy": <fuzzy_card_by_name(folded, set_code, floor, lead, fields)> or null,
 *    "contained": <cards_containing_all_words(words, set_code, limit, fields)> or null}
 * then the fuzzy_candidates(folded, set_code, floor, k) packet unchanged, or nothing
 * ```
 *
 * A stage whose answer the router can never read is SKIPPED, which is what keeps one call no
 * dearer than the stages it replaces:
 *
 * - This store ranks the needle exactly (`rank` non-null): nothing else is computed. Some
 *   partition then has an exact rank, so the router's exact stage is certain to answer, and the
 *   typo and containment stages never run anywhere. `fuzzy` and `contained` are null and there
 *   are no candidate bytes.
 * - Otherwise the candidates are always computed (the router races every partition's). If there
 *   is at least one, containment is skipped: the global race then has a leader, so it is a hit or
 *   ambiguous and never falls through to containment. `contained` is null.
 * - With NO candidate, the local race is a miss by construction (`fuzzy_name_match` and
 *   `fuzzy_candidates` offer the same scores against the same floor), so `fuzzy` is the miss
 *   `fuzzy_card_by_name` would write, built by the same `json!` — without a second scan — and
 *   containment runs.
 *
 * `fuzzy` is this store's own local race, and the router uses it only when this partition wins
 * the global race: its local race is a sub-race the global winner also leads, which is the
 * materialize call the three-round router made to the winning partition.
 *
 * `set_code` scopes all three stages alike — the typo stage's candidate pool included, which is
 * what keeps the skip rules sound under a set: a candidate here is a card IN the set, so a global
 * leader is still an answer in the set and containment is still unreachable.
 *
 * `limit` is containment's; the route asks for 2 and reads two DISTINCT names as ambiguous.
 */
export function named_fuzzy_bundle(folded: string, set_code: string, floor: number, lead: number, k: number, words_json: string, limit: number, fields_json: string): Uint8Array;

/**
 * Scryfall's autocomplete catalog for the WHOLE corpus, from the loaded names — the answer the
 * partitioned fan-out's merge gives, from one object. Errors when no names are loaded.
 */
export function names_autocomplete(prefix: string, limit: number): string;

/**
 * Bytes the loaded names hold in linear memory (0 when none are loaded) — for the load log line.
 */
export function names_heap_bytes(): number;

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
 * total: u32, n: u32, inline: u32, flags: u32 (KEY_PACKET_FLAG_WIDENED)
 * n      of: keylen: u16, key: keylen bytes, vpid: u32
 * inline of: rowlen: u32, row bytes in `shape`
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
 * wire and once in the parser. Framed, it splices exactly the rows the page kept.
 *
 * `shape` is `"rows"` or `"cards"` (see [`RowShape`]); `base_url` matters only for cards. The
 * packet itself does not record the shape — the RPC reply that carries it does, which is what
 * lets a gather tell a sibling still on the previous build (row JSON, no shape) from one that
 * answered in the shape it asked for. The `"cards"` shape builds from whatever `fields` the opts
 * name; the caller widens them to the card-object set, as the single-store path does.
 */
export function query_keys(filter_tree_json: string, opts_json: string, inline_rows: number, shape: string, base_url: string): Uint8Array;

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
 * The same query as [`query`], answered as `total: u32 LE` followed by a row packet of the page
 * in `shape` (see [`parse_page_shape`]) — the single-store `/search?shape=columnar`.
 *
 * Its own export rather than [`query_keys`] + [`fetch_rows`]: those answer a page at `offset` by
 * fetching all `offset + limit` keys first, and a deep page would pay for every row before it.
 */
export function query_shaped(filter_tree_json: string, opts_json: string, shape: string): Uint8Array;

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
 * [`random_search`]'s draw — same arguments, same seed semantics, the same rows — answered as a
 * row packet in `shape` (see [`parse_page_shape`]), for `/random_search` and `/cards/random`.
 * Both routes' callers wrote the draw through `JSON.stringify`, so `"rows"` is JavaScript's
 * spelling too: the joined frames are the bytes they wrote.
 */
export function random_search_shaped(n: number, seed: bigint, filter_tree_json: string, fields_json: string, shape: string): Uint8Array;

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
 * Rows given as a JSON array, written as a row packet in `shape` — FOR THE PARITY TEST
 * (tests/engine/columnar-parity.test.ts), which diffs it against `serializeCards` over rows
 * built to break the writer. Needs no store; not on any request path.
 */
export function shaped_frames_from_rows(rows_json: string, shape: string): Uint8Array;

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
 * The loaded STORE's own `(collated, printed)` autocomplete pairs, as a JSON array of pairs —
 * what its build published into the names blob, read back from the archive. Verification only
 * (the real-corpus differential); nothing on a request path calls it.
 */
export function store_autocomplete_names(): string;

/**
 * Append one chunk of the archive (wasm-bindgen copies the chunk into linear
 * memory; stream ~1MB chunks so the JS side never holds the whole store).
 */
export function store_load_chunk(chunk: Uint8Array): void;

/**
 * Inflate one piece of the compressed stream into the store buffer. Pieces may split gzip members
 * (and their headers) anywhere.
 */
export function store_load_gzip_chunk(chunk: Uint8Array): void;

/**
 * Decode one piece of the frame stream. Pieces may split frames (and their headers) anywhere.
 */
export function store_load_lz4_chunk(chunk: Uint8Array): void;

/**
 * Whether a store is loaded. A poisoned slot reports false: the instance holds nothing usable,
 * and the next load or query surfaces the poisoned error for the shim to act on.
 */
export function store_loaded(): boolean;

/**
 * Frame `index` of the ACTIVE store's LZ4 encoding, or an empty array past the last one.
 *
 * The encoder half of the cache: after a load that inflated gzip, the Durable Object walks
 * `index = 0, 1, …` and writes each frame into its cache, so the archive is encoded from the
 * bytes already in linear memory — one frame (~0.5MB) resident on the JS side at a time. The JS
 * walk is synchronous, so nothing can swap the store out between two frames of one encoding.
 */
export function store_lz4_frame(index: number): Uint8Array;

/**
 * The archive format version this build reads/writes. A store manifest's
 * `format_version` must match, or `finish_store_load` will reject the bytes.
 */
export function store_version(): number;

/**
 * Drop the active store, keeping its buffer as the spare the next load refills
 * (see `store_buffer`: a freed store buffer is NOT reused by the allocator, so
 * dropping it outright would grow linear memory by a whole store on the next
 * load). Call before a swap when there isn't headroom for two stores at once.
 */
export function unload_store(): void;
