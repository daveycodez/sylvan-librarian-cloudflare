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
	/**
	 * Scryfall's `include_multilingual`: true widens the search to foreign printings. Absent or
	 * false is Scryfall's default — English/canonical printings only. The OTHER widening trigger
	 * is a `card_lang` comparison in the filter tree, detected inside the engine during filter
	 * compile (one implementation, so the flag and the operator cannot drift). The transports
	 * (RemoteEngine, SearchEngineDO) carry the whole options object opaquely, so this rides the
	 * existing wire unchanged.
	 */
	includeMultilingual?: boolean;
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
	/**
	 * The envelope's `cards` value, already JSON-encoded in the asked-for shape — as UTF-8 BYTES.
	 *
	 * Bytes rather than a string because every hop between the engine and the socket wants bytes,
	 * and a JS string forces two conversions to get back to them: wasm-bindgen decodes the
	 * engine's output into UTF-16, and the RPC re-encodes it to UTF-8 on the way to the isolate.
	 * The isolate then pays a third pass flattening and encoding its response body. Measured, the
	 * Durable Object's CPU is very nearly a pure function of payload size (~15us/KB after the
	 * round trip came out), so passes over the payload are the cost -- and the isolate's share of
	 * them is charged against the free plan's 10ms per request.
	 */
	cardsBytes: Uint8Array;
	/**
	 * How many cards `cardsJson` actually holds — the PAGE's count, against
	 * `totalCards`' unpaginated one.
	 *
	 * It rides along because the alternative was counting them again in the
	 * isolate: /cards/search needs the page count for `has_more`, and the only
	 * thing it had was the encoded string, so it walked the whole ~635KB
	 * response one code point at a time to re-derive a number the DO threw away
	 * one line earlier (`result.rows.length`). Measured against the free plan's
	 * 10ms isolate budget that walk was most of the route's CPU.
	 *
	 * Not computed from `totalCards`, `offset` and the page size, though the
	 * arithmetic looks obvious: that would assume every physical plan in the
	 * engine returns exactly `min(limit, total - offset)` rows, which is an
	 * invariant spread across a dozen executors in lib.rs and pinned by nothing.
	 * `rows.length` is the count, by construction, wherever the rows came from.
	 */
	rowCount: number;
	/**
	 * Whether the engine ran the WIDENED (multilingual) driver — `include_multilingual` was set,
	 * or the bound filter carried a `lang:` leaf.
	 *
	 * It rides back so `/cards/search` can echo `include_multilingual` in `next_page` the way
	 * Scryfall does: a `lang:` in `q` alone makes Scryfall's echo say `true`. The route cannot
	 * work that out without re-implementing the engine's lang-leaf detection in TypeScript, which
	 * is the drift the one-implementation rule forbids — so the engine reports what it did.
	 */
	widened?: boolean;
}

export interface EngineCatalog {
	/** Card type → count, as the engine reports it (pre-alias massaging). */
	types: Record<string, number>;
	keywords: Record<string, number>;
}

/**
 * Everything `scryfallSearchPage` needs to build the WHOLE response beside the payload.
 *
 * One definition, referenced by all five implementations (WasmEngine, RemoteEngine,
 * PartitionedEngine, the Durable Object handler and the route-test harness). It used to be
 * spelled out at each of them, so adding a field meant five identical edits and a build error was
 * the only thing standing between "four of five updated" and a route that silently lost it.
 */
export interface SearchPageEnvelope {
	pretty: boolean;
	warnings?: string[];
	nextPageUrl?: string;
	pageOffset: number;
	/** Scryfall's no-match wording — passed in so its text stays with the other route copy. */
	noMatchDetails: string;
	/**
	 * Scryfall's `422 validation_error` wording for a page PAST the end of a non-empty result.
	 *
	 * Separate from `noMatchDetails` because the two answer different questions and Scryfall gives
	 * them different statuses: "nothing matched" is a 404 at every page, "this page is past the
	 * end" is a 422. Only the side holding the total can tell them apart, which is why the sentence
	 * travels here rather than being decided in the isolate. Omitted (and the 404 used for both)
	 * by callers with no pagination of their own.
	 */
	beyondEndDetails?: string;
	/**
	 * Render the page as Scryfall's CSV rather than as a List envelope (`?format=csv`).
	 *
	 * A RESOLVED boolean, not the raw `format` string, so the rule that decides it — Scryfall
	 * accepts `csv` on `/cards/search` alone and is case-sensitive about it — has one implementation,
	 * in the route, and does not get re-derived on the far side of the RPC. Everything else about
	 * the request is identical: same query, same page, same 175 rows, same 404 for an empty result
	 * and same 422 past the end. Only the bytes wrapping the rows change.
	 */
	csv?: boolean;
}

/**
 * What the routes need from an engine. Async because every implementation is
 * remote from the route's point of view: an isolate RPCs to its region's
 * SearchEngine Durable Object (RemoteEngine) and never loads the store itself.
 * Inside that Durable Object the same interface is served locally by WasmEngine.
 */
export interface Engine {
	/** Row objects — for the server-rendered page, which needs them as data. */
	searchCardsAsObjects(opts: EngineSearchOptions): Promise<EngineSearchResult>;
	/** Pre-encoded cards — for the JSON API, which only ever needs the bytes. */
	searchCardsAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult>;
	cardTypeCounts(): Promise<Record<string, number>>;
	cardKeywordCounts(): Promise<Record<string, number>>;
	/**
	 * The set codes holding at least one `is:extra` printing, sorted and deduplicated.
	 *
	 * THE `include_extras` AUTO-ENABLE TABLE. Scryfall forces `include_extras=true` — overriding
	 * an explicit `false`, in the echo and in the results — when a query names a set that has an
	 * extra printing, and leaves it off when the set has none. That question is not answerable
	 * from the query text, so the builder folds it into the archive and the route reads it from
	 * here; `PartitionedEngine` unions the partitions' answers and caches the union for the life
	 * of the store generation, so a set-scoped search costs no round trip of its own.
	 */
	setsWithExtras(): Promise<string[]>;
	/**
	 * Random preferred-printing sample, mirroring upstream sample_preferred().
	 *
	 * `filterTreeJson` is this port's addition and the reason `/random_search` can hide the extras
	 * class at all: the draw happens inside the engine, over a pool the route cannot see, so a
	 * gate above the engine has nothing to gate. Omit it (or pass a `TrueNode`) for the whole
	 * corpus, which is what every caller did before the gate.
	 */
	randomCardsAsObjects(numCards: number, fields: string[], filterTreeJson?: string): Promise<Record<string, unknown>[]>;
	/** The same sample, pre-encoded (see searchCardsAsJson). */
	randomCardsAsJson(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		filterTreeJson?: string,
	): Promise<EngineSerializedResult>;
	/** Number of cards in the store; 0 means "not loaded" upstream — here a loaded engine is never empty. */
	cardCount(): Promise<number>;

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// Every one of these BUILDS Scryfall card objects, and every one of them does it inside the
	// Durable Object. `toScryfallCard` assembles ~70 keys per card and a collection POST resolves
	// up to 75 of them; the DO meters against 30s where the request isolate meters against 10ms,
	// so which side of this boundary the assembly happens on is a factor of 3000. That is the one
	// design choice here that cannot be tuned away afterwards.
	//
	/** A Scryfall-shaped search: card objects, pre-encoded. `cardsJson` is a JSON array. */
	scryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult>;
	/** Whether this query runs the widened (multilingual) driver; see EngineSerializedResult.widened. */
	queryWidens?(opts: EngineSearchOptions): boolean;

	/**
	 * `/cards/search`'s WHOLE response — envelope, headers and status — built where the payload is.
	 *
	 * The isolate that serves the request only picks the shard and returns this, so its CPU stops
	 * scaling with the page at all. Splicing the envelope in the isolate instead measured ~13ms mean
	 * on a 652KB page, over the free plan's 10ms metered budget.
	 */

	scryfallSearchPage(
		opts: EngineSearchOptions,
		baseUrl: string,
		envelope: SearchPageEnvelope,
		cache: Record<string, string>,
	): Promise<Response>;
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
	 * `/cards/named?exact=`: the best printing whose FOLDED name matches, or null.
	 *
	 * `folded` is lowercased and accent-folded by the caller. Matches either half of a
	 * `Front // Back` name as well as the whole, which is what Scryfall does.
	 */
	scryfallExactName(folded: string, setCode: string, baseUrl: string): Promise<Record<string, unknown> | null>;
	/**
	 * `[tier, score]` for this engine's best `exact=` candidate, or null; higher wins.
	 *
	 * Only the partitioned router calls this, to rank partitions before materializing one — a
	 * needle can match one card's whole name and another card's face name, and those cards live
	 * in different partitions. Compare the pair; do not interpret either half.
	 */
	scryfallExactNameRank(folded: string, setCode: string): Promise<number[] | null>;
	/**
	 * A `POST /cards/collection` `{name}` identifier batch, resolved to one card each.
	 *
	 * NOT `scryfallExactName` looped: the two surfaces read different keys (see the engine's
	 * `collection_card_by_name`), and a collection POST carries up to 75 identifiers, which
	 * looped would be 75 round trips per partition.
	 */
	scryfallCollectionNames(identifiers: NameIdentifier[], baseUrl: string): Promise<(Record<string, unknown> | null)[]>;
	/**
	 * `[tier, score]` per identifier for this engine's best candidate, or null — the batched twin
	 * of `scryfallExactNameRank`, and there for the same partitioned router.
	 */
	scryfallCollectionNameRanks(identifiers: NameIdentifier[]): Promise<(number[] | null)[]>;
	/** `illustration_id`, one of the collection endpoint's identifiers; not a searchable field. */
	scryfallCardByIllustrationId(illustrationId: string, baseUrl: string): Promise<Record<string, unknown> | null>;
	/**
	 * The containment stage of `/cards/named?fuzzy=`: one card per distinct name containing every
	 * word. The caller asks for 2 — more than one distinct name is `ambiguous`, not a guess.
	 */
	scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
	): Promise<Record<string, unknown>[]>;
	/**
	 * The first card matching each filter tree, in order — the query-shaped lookups
	 * (`/cards/:code/:number`, and a collection POST's `set`+`collector_number` and `name`
	 * identifiers). One RPC for the whole batch so 75 identifiers are not 75 round trips.
	 */
	scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]>;
}

/**
 * One `POST /cards/collection` `{"name": …, "set": …}` identifier, as the engine takes it.
 *
 * `folded` is lowercased and accent-folded by the route (foldAccents in src/parser/pystr.ts), the
 * same shape `/cards/named?exact=` hands over; the engine collates it. `setCode` is "" for an
 * identifier that names no set.
 */
export interface NameIdentifier {
	folded: string;
	setCode: string;
}

/**
 * The fuzzy LEAD threshold: the best candidate must lead the best competing (different name,
 * different card) candidate by this much or the answer is `ambiguous`. Lives here, on the seam,
 * because BOTH sides apply it — the engine's own race and the partitioned gather's global race —
 * and the two must never drift.
 *
 * FITTED against 86 probed Scryfall needles alongside the floor in store.ts. It is small because
 * on the derived metric the typo stage almost never has to declare ambiguity: every needle
 * Scryfall calls ambiguous (`bolt`, `jac bel`, `aust com`, `ring sol`, …) falls THROUGH the typo
 * stage's floor and is called ambiguous by the containment stage behind it.
 *
 * It got SMALLER when the extras classes started being imported: `Lightning Bolt // Lightning
 * Bolt` (astx/76, art series) trails Blightning by 0.0032 for `fuzzy=bolt lightning`, and 0.01
 * called that ambiguous. See card_engine's FUZZY_SCORE_LEAD for the refit.
 */
export const FUZZY_SIMILARITY_LEAD = 0.002;

/** One cross-partition fuzzy candidate, decoded off the wasm `fuzzy_candidates` packet.
 * `oracleId` is the global card identity the race's "a card never competes with itself" rule
 * keys on; `vpid` is partition-local and unused by the race. */
export interface FuzzyCandidateWire {
	score: number;
	oracleId: string;
	vpid: number;
	foldedName: string;
}

/** What a `?fuzzy=` lookup resolved to. */
export interface ScryfallFuzzyResult {
	status: "hit" | "ambiguous" | "miss";
	card: Record<string, unknown> | null;
}

/**
 * RPC error marker: workerd propagates only Error#message across RPC, so the
 * EngineUnavailableError contract (routes turn it into upstream's exact 503 /
 * the bootstrap page) is encoded into the message by the Durable Object and
 * decoded by RemoteEngine.
 *
 * It lives HERE, beside the error it encodes, rather than in search-engine-do.ts
 * where it was defined. Importing it from there made remote-engine.ts — which a
 * plain Worker isolate loads on every request — depend on the whole Durable
 * Object module, dragging in `cloudflare:workers` and the wasm-backed store for
 * one string. Tests had to mock that module away to exercise the client at all,
 * and because `mock.module` is process-global in bun, doing so broke any other
 * suite that wanted the real SearchEngine.
 */
export const ENGINE_UNAVAILABLE_MARKER = "__ENGINE_UNAVAILABLE__";

/**
 * The one path the SearchEngine DO answers over `fetch` — the payload transport.
 *
 * The host is arbitrary and never resolved: a Durable Object stub's `fetch` is a direct pipe, so
 * only the path is read.
 *
 * LIVES HERE, with the shared types, rather than beside the handler that serves it. Exporting it
 * from search-engine-do.ts pulled `cloudflare:workers` into every module that imports RemoteEngine,
 * which is most of the engine — and outside workerd that import cannot resolve at all, so the unit
 * tests stopped loading. A protocol constant is shared by definition; it does not belong in either
 * end's implementation.
 */
export const ENGINE_STREAM_PATH = "/engine/payload";

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

/**
 * Thrown when the engine refused the QUERY rather than failed to serve — a bad request, not an
 * outage.
 *
 * The one producer today is `build_filter`, which compiles a regex leaf the parser accepted:
 * `q=o:/[unclosed/` reached the wasm, threw
 * `build_filter: invalid regex '[unclosed': regex parse error: unclosed character class`, and came
 * back out of the Durable Object's fetch transport as a bare `503` with a NON-JSON body. A 5xx
 * with nothing to parse, from user-controlled input, is the worst answer this API can give; the
 * route now turns this class into Scryfall's `400 bad_request`.
 *
 * `query-terms.ts` validates the patterns it can before the engine ever sees them, so this is the
 * backstop for the ones it cannot: Rust's `regex` crate rejects lookaround and backreferences that
 * JavaScript's `RegExp` compiles happily, and nothing on the isolate side can know that.
 */
export class EngineQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngineQueryError";
	}
}

/**
 * The prefix the engine puts on a failure to COMPILE a bound filter.
 *
 * Both ends read it from here: the Durable Object classifies the error it caught, and RemoteEngine
 * classifies the message that came back over the transport, so "which failures are the caller's
 * fault" has one definition rather than two that can drift.
 */
export const BUILD_FILTER_ERROR_PREFIX = "build_filter";

/**
 * One partition of the store.
 *
 * Each partition is its own complete rkyv archive, holding the cards whose
 * `fnv1a64(oracle_id) % partition_count` is this partition's index, published
 * under its own chunk family (`card-store-v<fmt>-<built_at>-p<k>.store`). These
 * fields are what a reader actually loads from; their top-level twins on the
 * manifest are the TOTALS over all of them.
 */
export interface StoreManifestPartition {
	/** Chunk-family key for this partition's archive (carries the `-p<k>` suffix). */
	store_key: string;
	/** Uncompressed archive size; the wasm buffer is preallocated from this. */
	store_bytes: number;
	/** Bytes KV holds for this partition. Present iff compressed (the format flag). */
	store_gzip_bytes?: number;
	chunk_count: number;
	card_count: number;
	printing_count: number;
}

export interface StoreManifest {
	/**
	 * The build's FAMILY STEM (`card-store-v<fmt>-<built_at>.store`, no `-p<k>`
	 * suffix). NO CHUNKS LIVE UNDER IT; it exists so retention and logs can name
	 * the build as one thing. Readers load through `partitions[]`, never this key.
	 */
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
	/**
	 * Bytes KV actually holds, when the chunks were published gzipped.
	 *
	 * PRESENT IFF COMPRESSED — this field is the format flag, not a size hint.
	 * `store_bytes` stays the DECOMPRESSED length either way, so
	 * `begin_store_load` is unchanged and `finish_store_load` still validates the
	 * archive by filling a buffer preallocated to exactly that. What needed a new
	 * number is the reader's integrity check, which counts what KV handed over.
	 *
	 * Absent on every store published before compression, which is what lets one
	 * reader serve both formats and makes reverting the change code-only: the
	 * previous raw store is still addressable (KEEP_STORES), and a rolled-back
	 * reader meeting a compressed manifest fails its byte check and keeps serving
	 * whatever it already had, rather than loading something it cannot read.
	 */
	store_gzip_bytes?: number;
	/**
	 * KV chunks the store occupies; readers validate the total byte count.
	 *
	 * Load-bearing once compressed: the cut is on RAW bytes while the stored
	 * values are smaller, so the count is derivable from neither size and the
	 * reader refuses a compressed manifest without it.
	 */
	chunk_count?: number;
	/**
	 * Scryfall's `updated_at` for the bulk dump this store was built from. Lets
	 * a deploy ask "has upstream actually changed?" instead of guessing from
	 * the store's own age. Absent on stores built before it was recorded.
	 */
	source_updated_at?: string;

	// ── The partitioned store (generation 20) ──────────────────────────────────
	//
	// OPTIONAL IN THE TYPE, MANDATORY IN FACT. Every manifest this deployment
	// publishes carries all three, and readManifest/writeManifest refuse one that
	// does not — a manifest without them predates the partitioned store and no
	// reader here can serve it. They stay optional only so that refusal can be
	// EXPRESSED: a required field would make the bad shape unparseable rather
	// than diagnosable, and the loud error naming the builder is the point.
	//
	// When present, the top-level store_bytes/store_gzip_bytes/chunk_count/
	// card_count/printing_count are TOTALS over `partitions`.

	/**
	 * How many partitions the store is cut into. NOT a constant anywhere: the
	 * builder auto-scales it per build (plan Decision 3b) and every reader —
	 * router fan-out width, hash modulus, loaders — derives it from HERE.
	 */
	partition_count?: number;
	/**
	 * Names the partition-assignment function, algorithm + key + vector version
	 * (see PARTITION_HASH_ALGO in store-kv.ts). A loader that does not recognise
	 * it must REFUSE the manifest: routing by the wrong hash makes cards silently
	 * vanish from single-card routes, and a loud unknown-hash failure is the only
	 * observable form of that bug.
	 */
	partition_hash?: string;
	/** One record per partition, index k at position k. Length === partition_count. */
	partitions?: StoreManifestPartition[];
}

// Generated by `bun run cf-typegen` (wrangler types) from wrangler.jsonc +
// .env — bindings, vars, and secret names all come from the real config.
export type Env = Cloudflare.Env;
