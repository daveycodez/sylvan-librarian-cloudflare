// Interface of the wasm-bindgen module produced by engine/wasm (wasm-pack,
// bundler target; committed at engine/wasm/pkg, aliased in wrangler config).
// Mirrors engine/wasm/pkg/sylvan_engine_wasm.d.ts — keep in lockstep.
declare module "sylvan-engine-wasm" {
	/** Instantiate the engine on first use. Provided by the Workers shim
	 * (src/engine/wasm-shim.ts), not by wasm-bindgen: instantiation is lazy so
	 * request isolates, which never query, never pay for it. */
	export function ensureEngine(): void;
	/** Wasm linear memory reserved, in bytes — a high-water mark, since it never
	 * shrinks. Provided by the Workers shim, not wasm-bindgen. */
	export function linearMemoryBytes(): number;
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
	 * A page of Scryfall card objects as `<total> <rowCount>\n<cards JSON array>` in UTF-8 bytes.
	 * The objects are built in the engine, so the DO never materializes a card. Needs the residue
	 * archive attached.
	 */
	export function scryfall_search(filterTreeJson: string, optsJson: string, baseUrl: string): Uint8Array;
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
