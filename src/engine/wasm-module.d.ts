// Interface of the wasm-bindgen module produced by engine/wasm (wasm-pack,
// bundler target; committed at engine/wasm/pkg, aliased in wrangler config).
// Mirrors engine/wasm/pkg/sylvan_engine_wasm.d.ts — keep in lockstep.
declare module "sylvan-engine-wasm" {
	/** Instantiate the DEFAULT engine instance on first use. Provided by the
	 * Workers shim (src/engine/wasm-shim.ts), not by wasm-bindgen: instantiation
	 * is lazy so request isolates, which never query, never pay for it. */
	export function ensureEngine(): void;
	/** Wasm linear memory reserved by the default instance, in bytes — a
	 * high-water mark, since it never shrinks. Provided by the Workers shim. */
	export function linearMemoryBytes(): number;
	/**
	 * One wasm engine instance per Durable Object label (Workers shim). The Rust
	 * engine's store is module-global per INSTANCE, and colocated partition
	 * objects share this module, so each label binds its own instance; every
	 * handle method re-binds before crossing into wasm. See wasm-shim.ts for the
	 * instantiation-cost accounting.
	 */
	export function engineFor(label: string): EngineHandle;
	export interface EngineHandle {
		begin_store_load(totalLen: number): void;
		store_load_chunk(chunk: Uint8Array): void;
		finish_store_load(): void;
		unload_store(): void;
		store_loaded(): boolean;
		query(filterTreeJson: string, optsJson: string): string;
		query_rows(filterTreeJson: string, optsJson: string): Uint8Array;
		query_keys(filterTreeJson: string, optsJson: string, inlineRows: number): Uint8Array;
		fetch_rows(vpids: Uint32Array, fieldsJson: string): Uint8Array;
		sort_key_version(): number;
		fuzzy_candidates(name: string, floor: number, k: number): Uint8Array;
		scryfall_search(filterTreeJson: string, optsJson: string, baseUrl: string): Uint8Array;
		query_widens(filterTreeJson: string, optsJson: string): boolean;
		catalog(): string;
		random_search(n: number, seed: bigint, fieldsJson: string): string;
		size(): number;
		card_by_scryfall_id(scryfallId: string, fieldsJson: string): string;
		cards_by_scryfall_ids(idsJson: string, fieldsJson: string): string;
		printings_of_oracle_id(oracleId: string, fieldsJson: string): string;
		card_by_external_id(namespace: string, externalId: bigint, fieldsJson: string): string;
		fuzzy_card_by_name(name: string, floor: number, lead: number, fieldsJson: string): string;
		autocomplete(prefix: string, limit: number): string;
		exact_card_by_name(folded: string, setCode: string, fieldsJson: string): string;
		card_by_illustration_id(illustrationId: string, fieldsJson: string): string;
		cards_containing_all_words(wordsJson: string, setCode: string, limit: number, fieldsJson: string): string;
		linearMemoryBytes(): number;
	}
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
	// ── Single-card addressing (the /cards/* surface) ────────────────────────
	// `fieldsJson` is a JSON list of field names, or "null" for the default set. A miss is JSON
	// `null` — this port has no SQL behind it, so a miss IS the answer.
	export function card_by_scryfall_id(scryfallId: string, fieldsJson: string): string;
	export function cards_by_scryfall_ids(idsJson: string, fieldsJson: string): string;
	export function printings_of_oracle_id(oracleId: string, fieldsJson: string): string;
	export function card_by_external_id(namespace: string, externalId: bigint, fieldsJson: string): string;
	/** `{"status": "hit"|"ambiguous"|"miss", "card": ...}`. */
	export function fuzzy_card_by_name(name: string, floor: number, lead: number, fieldsJson: string): string;
	/** Printed card names matching a partial name, prefix matches first. JSON array. */
	export function autocomplete(prefix: string, limit: number): string;
	/**
	 * The best printing of a card whose FOLDED name matches exactly, or JSON `null`. `folded` is
	 * already lowercased and accent-folded by the caller; `setCode` is "" for no restriction.
	 */
	export function exact_card_by_name(folded: string, setCode: string, fieldsJson: string): string;
	/** The best printing carrying this illustration id, or JSON `null`. */
	export function card_by_illustration_id(illustrationId: string, fieldsJson: string): string;
	/** One card per distinct name containing every word, best printing each. JSON array. */
	export function cards_containing_all_words(
		wordsJson: string,
		setCode: string,
		limit: number,
		fieldsJson: string,
	): string;
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
	/**
	 * The same query, answered as `<total> <rowCount>\n<rows JSON array>` in UTF-8 BYTES.
	 *
	 * For callers that want the rows ENCODED rather than as values — which is /search, whose whole
	 * path was query → JSON.parse → JSON.stringify, rebuilding the bytes it was handed. The two
	 * counts ride in the prefix so reaching them costs no parse either, and the payload stays
	 * bytes to the response body rather than being decoded to UTF-16 and encoded back.
	 */
	export function query_rows(filterTreeJson: string, optsJson: string): Uint8Array;
	/**
	 * Phase 1 of the two-phase gather (plan A4/B5): the page's top offset+limit
	 * opaque sort keys, packed little-endian as `(total u32, n u32, then per
	 * key: keylen u16, key bytes, vpid u32)`. Same executor as query().
	 */
	export function query_keys(filterTreeJson: string, optsJson: string, inlineRows: number): Uint8Array;
	/**
	 * Phase 2: the named virtual printings' rows as a UTF-8 JSON array, in
	 * CALLER order. An unknown vpid is a loud error — against a swapped store it
	 * means the caller's keys came from another generation.
	 */
	export function fetch_rows(vpids: Uint32Array, fieldsJson: string): Uint8Array;
	/** Leading version byte of every sort key this build emits. Streams from
	 * builds disagreeing on this must never be merged. */
	export function sort_key_version(): number;
	/**
	 * The scores-bearing fuzzy surface for the cross-partition FLOOR/LEAD race:
	 * the top `k` distinct (card, name) candidate classes clearing `floor`,
	 * packed little-endian as `(n u32, then per candidate: score f32,
	 * oracle_id 16 raw uuid bytes, vpid u32, namelen u16, name UTF-8)`.
	 */
	export function fuzzy_candidates(name: string, floor: number, k: number): Uint8Array;
	/**
	 * A page of Scryfall card objects as `<total> <rowCount>\n<cards JSON array>` in UTF-8 bytes.
	 * The objects are built in the engine, so the DO never materializes a card. Needs the residue
	 * archive attached.
	 */
	export function scryfall_search(filterTreeJson: string, optsJson: string, baseUrl: string): Uint8Array;
	export function query_widens(filterTreeJson: string, optsJson: string): boolean;
	/**
	 * One engine row as a Scryfall card object. Pure — needs no loaded store, which is what lets
	 * tests/routes/card-object-parity.test.ts diff it against toScryfallCard. Not a request path.
	 */
	export function scryfall_card_from_row(rowJson: string, baseUrl: string): string;
	/** {"card_types": {...}, "card_keywords": {...}} JSON. */
	export function catalog(): string;
	/** n sampled preferred printings; deterministic per seed. JSON array. */
	export function random_search(n: number, seed: bigint, fieldsJson: string): string;
}
