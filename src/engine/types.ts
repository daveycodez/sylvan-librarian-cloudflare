// Seam between the HTTP routes (src/routes/) and the wasm engine (src/engine/).
// Routes depend only on this interface; tests may inject a fake.

/** Options accepted by the engine search, mirroring upstream's pyo3 query() surface. */
export interface EngineSearchOptions {
	/**
	 * Engine-wire filter tree, PRE-SERIALIZED to its canonical JSON string by
	 * the parser's serializer. A string (not the node objects) deliberately:
	 * the tree preserves Python int/float semantics via class behavior that
	 * structured clone would strip when this crosses the DO RPC boundary.
	 */
	filterTreeJson: string;
	unique: string;
	prefer: string;
	orderby: string;
	direction: string;
	/** Upstream passes 1_000_000 for "no limit". */
	limit: number;
	/**
	 * Results to skip before the first returned card, in the query's own sort
	 * order — limit/offset together paginate the full result set. total_cards
	 * stays the UNPAGINATED count.
	 */
	offset: number;
	/** Resolved result field names (never undefined by the time it reaches the engine). */
	fields: string[];
}

export interface EngineSearchResult {
	totalCards: number;
	/** Row objects keyed by result field name. */
	cards: Record<string, unknown>[];
}

/** Wire shape of the envelope's `cards` value (upstream's `shape=` parameter). */
export type ResultShape = "rows" | "columnar";

/**
 * A result whose card data never becomes JS objects in the request isolate.
 *
 * The engine emits JSON; the old path parsed it in the DO, structured-cloned
 * the row objects across the RPC, re-shaped them, and re-encoded them — three
 * conversions of the same bytes, two of them charged to the isolate's 10ms
 * free-plan CPU budget. Here the DO shapes and encodes once, and `cardsJson`
 * crosses the boundary as a string (a copy, not a per-property clone) that the
 * route splices into the envelope verbatim.
 */
export interface EngineSerializedResult {
	totalCards: number;
	/** The envelope's `cards` value, already JSON-encoded in the asked-for shape. */
	cardsJson: string;
}

export interface EngineCatalog {
	/** Card type → count, as the engine reports it (pre-alias massaging). */
	types: Record<string, number>;
	keywords: Record<string, number>;
}

/**
 * What the routes need from an engine. Async because the engine may be local
 * (warm isolate: wasm call, resolves immediately) or remote (cold isolate:
 * RPC to the regional SearchEngine Durable Object while this isolate warms
 * itself in the background).
 */
export interface Engine {
	/** Row objects — for the server-rendered page, which needs them as data. */
	search(opts: EngineSearchOptions): Promise<EngineSearchResult>;
	/** Pre-encoded cards — for the JSON API, which only ever needs the bytes. */
	searchSerialized(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult>;
	commonCardTypes(): Promise<Record<string, number>>;
	commonCardKeywords(): Promise<Record<string, number>>;
	/** Random preferred-printing sample, mirroring upstream sample_preferred(). */
	samplePreferred(numCards: number, fields: string[]): Promise<Record<string, unknown>[]>;
	/** The same sample, pre-encoded (see searchSerialized). */
	samplePreferredSerialized(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult>;
	/** Number of cards in the store; 0 means "not loaded" upstream — here a loaded engine is never empty. */
	size(): Promise<number>;

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// Every one of these BUILDS Scryfall card objects, and every one of them does it inside the
	// Durable Object. `toScryfallCard` assembles ~70 keys per card and a collection POST resolves
	// up to 75 of them; the DO meters against 30s where the request isolate meters against 10ms,
	// so which side of this boundary the assembly happens on is a factor of 3000. That is the one
	// design choice here that cannot be tuned away afterwards.
	//
	// They also attach the residue archive on first use (see StoreManifest.compat_key), which is
	// why they are separate from search() rather than a `fields` option on it: `/search` must
	// never pull ~11MB it does not read.

	/** A Scryfall-shaped search: card objects, pre-encoded. `cardsJson` is a JSON array. */
	scryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult>;
	/** One card object by Scryfall id, or null for a genuine miss (which IS the 404 here). */
	scryfallCardById(scryfallId: string, baseUrl: string): Promise<Record<string, unknown> | null>;
	/** Card objects for these ids, in the order given, skipping misses. */
	scryfallCardsByIds(scryfallIds: string[], baseUrl: string): Promise<Record<string, unknown>[]>;
	/** The representative printing of an oracle id, as a card object. */
	scryfallCardByOracleId(oracleId: string, baseUrl: string): Promise<Record<string, unknown> | null>;
	/** One card by a marketplace or client id. `namespace` is Scryfall's own path segment. */
	scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
	): Promise<Record<string, unknown> | null>;
	/**
	 * Scryfall's typo-tolerant `?fuzzy=` match. `ambiguous` stays distinct from `miss` because
	 * Scryfall reports it, and a 404 would tell the client the card does not exist.
	 */
	scryfallFuzzyName(name: string, baseUrl: string): Promise<ScryfallFuzzyResult>;
	/** Scryfall's autocomplete catalog: printed names, prefix matches first. */
	scryfallAutocomplete(prefix: string, limit: number): Promise<string[]>;
	/**
	 * The first card matching each filter tree, in order — the query-shaped lookups
	 * (`/cards/:code/:number`, and a collection POST's `set`+`collector_number` and `name`
	 * identifiers). One RPC for the whole batch so 75 identifiers are not 75 round trips.
	 */
	scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]>;
}

/** What a `?fuzzy=` lookup resolved to. */
export interface ScryfallFuzzyResult {
	status: "hit" | "ambiguous" | "miss";
	card: Record<string, unknown> | null;
}

/**
 * Thrown when the engine cannot answer. Routes translate this to a loud
 * structured error — NEVER an empty result (upstream would fall back to SQL
 * here; this deployment has no SQL by design).
 */
export class EngineUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngineUnavailableError";
	}
}

export interface StoreManifest {
	store_key: string;
	built_at: string;
	card_count: number;
	printing_count: number;
	upstream_commit: string;
	format_version: number;
	/**
	 * The builder-content generation this store was built by (see
	 * STORE_CONTENT_GENERATION). Absent on stores built before it was recorded,
	 * which the deploy reads as "older than generation 1" and rebuilds.
	 */
	content_generation?: number;
	/** Uncompressed archive size; the wasm buffer is preallocated from this. */
	store_bytes: number;
	/** KV chunks the store occupies; readers validate the total byte count. */
	chunk_count?: number;
	/**
	 * The paired residue archive: the Scryfall card-object fields `/search` never reads, kept out
	 * of the search store so it stays at three chunks and its in-Worker build stays under the
	 * 112 MiB wasm cap (see CompatData in card_engine). Loaded on demand by `/cards/*`.
	 *
	 * Absent on stores built before the split, which reads as "this store cannot serve /cards/*"
	 * — a 503 on those routes rather than a card object with every residue field missing.
	 */
	compat_key?: string;
	/** Uncompressed residue-archive size; the wasm buffer is preallocated from this. */
	compat_bytes?: number;
	/** KV chunks the residue archive occupies. */
	compat_chunk_count?: number;
	/**
	 * Scryfall's `updated_at` for the bulk dump this store was built from. Lets
	 * a deploy ask "has upstream actually changed?" instead of guessing from
	 * the store's own age. Absent on stores built before it was recorded.
	 */
	source_updated_at?: string;
}

// Generated by `bun run cf-typegen` (wrangler types) from wrangler.jsonc +
// .env — bindings, vars, and secret names all come from the real config.
export type Env = Cloudflare.Env;
