import type { PreferOrder } from "../routes/enums";
import type { PlacementBlock } from "./placement-policy";
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
	/**
	 * Backlog n15: the build (`built_at`) the ROUTER pinned this request to, set on a gathered search
	 * only. The gather's coordinator asks its names index which partitions a NAME-ONLY filter's
	 * matches live in and gathers from those alone — and only when this is the build it has loaded,
	 * since partition numbers mean nothing across builds. Absent (a router before n15) or another
	 * build: every partition is asked, as before. Carried opaquely by every transport; the engine's
	 * own options object never reads it (Store.optsJson picks its keys).
	 */
	namesBuild?: string;
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
	/**
	 * `searchCardsAsJson` answered by the ONE partition the routing filter says holds a printing
	 * address (`setNumberKey`), from that partition's own rows — NOT the global answer. Null when
	 * nothing routes the address (no routing filter, not partitioned) or that partition cannot
	 * answer at this layout. A caller may trust only the rows AT the address: every printing at one
	 * address lives in one partition, so those are exactly the rows a gather returns for it, in the
	 * gather's order; whatever else the query matched in other partitions is missing.
	 */
	searchCardsAtAddress?(
		opts: EngineSearchOptions,
		shape: ResultShape,
		addressKey: string,
	): Promise<EngineSerializedResult | null>;
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
	/** One card by a marketplace or client id. `namespace` is Scryfall's own path segment. */
	scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
	): Promise<Record<string, unknown> | null>;
	/**
	 * Scryfall's typo-tolerant `?fuzzy=` match. `ambiguous` stays distinct from `miss` because
	 * Scryfall reports it, and a 404 would tell the client the card does not exist.
	 *
	 * `setCode` ("" for none) scopes the candidate POOL: only cards with a printing in that set race,
	 * and a hit is the card's best printing there — api.scryfall.com answers `fuzzy=lightning
	 * bolt&set=war` with a 404 and `fuzzy=lightning blow&set=m11` with M11's Lightning Bolt.
	 */
	scryfallFuzzyName(name: string, baseUrl: string, setCode?: string): Promise<ScryfallFuzzyResult>;
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
	 * `[tier, name, served, score]` for this engine's best `exact=` candidate, or null (core_api's
	 * `exact_name_rank`; see NameRank for how two compare).
	 *
	 * Only the partitioned router calls this, to rank partitions before materializing one — a
	 * needle can match one card's whole name and another card's face name, and those cards live
	 * in different partitions.
	 */
	scryfallExactNameRank(folded: string, setCode: string): Promise<NameRank | null>;
	/**
	 * `scryfallExactNameRank` and `scryfallExactName` in one reply, plus whether this store holds
	 * the name at all — what the partitioned router asks a routed partition (see ExactNameProbe).
	 * Only a store and its remote client answer it; the partitioned engine is its caller.
	 */
	scryfallExactNameProbe?(folded: string, setCode: string, baseUrl: string): Promise<ExactNameProbe>;
	/**
	 * All three `?fuzzy=` stages against one store in one reply (see NamedFuzzyBundle). Only a store
	 * and its remote client answer it; the partitioned engine is its caller.
	 */
	scryfallNamedFuzzyBundle?(
		folded: string,
		setCode: string,
		words: string[],
		limit: number,
		baseUrl: string,
	): Promise<NamedFuzzyBundle>;
	/**
	 * `/cards/named?fuzzy=` resolved whole — exact, then typo, then containment — when this engine
	 * can do better than asking the three stages one after another (the partitioned engine: one
	 * round of bundles). Absent, the route runs the stages itself (`resolveNamedFuzzyStaged`).
	 */
	scryfallNamedFuzzy?(folded: string, words: string[], setCode: string, baseUrl: string): Promise<NamedFuzzyAnswer>;
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
	scryfallFirstOfEach(
		filterTreeJsons: string[],
		baseUrl: string,
		/** When every tree looks up ONE address, its `setNumberKey` — the partitioned router then
		 * asks the partition the routing filter names instead of all of them. */
		addressKey?: string,
	): Promise<(Record<string, unknown> | null)[]>;
	/**
	 * A whole `POST /cards/collection` batch — every identifier kind — resolved in ONE round, each
	 * found card as finished Scryfall JSON bytes.
	 *
	 * What the route calls. A partition answers every name with its rank AND its local winner's
	 * card, so the partitioned router keeps the global winner's card without a second round, and
	 * the keys and trees ride the same call instead of their own fan-outs: N calls for a batch the
	 * per-kind methods it replaced (b9bc501) spent up to 2N + N + N on. The bytes are spliced into
	 * the response, never parsed.
	 */
	scryfallCollectionBatch(
		batch: CollectionBatch,
		baseUrl: string,
		scope?: CollectionScope | null,
	): Promise<CollectionBatchAnswer>;
}

/** A collection identifier that is a KEY into the store rather than a query, Scryfall ids aside. */
export type CollectionKeyIdentifier =
	| { kind: "oracle_id"; id: string }
	| { kind: "illustration_id"; id: string }
	| { kind: "external"; namespace: string; id: number };

/** A collection identifier that is a KEY into the store, Scryfall ids included — see Engine.scryfallCollectionBatch. */
export type CollectionBatchKey = CollectionKeyIdentifier | { kind: "scryfall_id"; id: string };

/** One `POST /cards/collection` batch, split by how each identifier is answered. */
export interface CollectionBatch {
	/** Looked up by key — Scryfall, oracle, illustration and external ids. */
	keys: CollectionBatchKey[];
	/** Filter trees answered by their first printing — `{set, collector_number}`. */
	trees: string[];
	/**
	 * Per tree, the routing key of the ADDRESS it looks up (`setNumberKey`), or null. Trees that
	 * share a key are alternatives at one address — English, then any language — and all live in
	 * the one partition that key names, so the partitioned router asks that partition alone.
	 * Absent means no tree is routable: every partition is asked.
	 */
	treeAddresses?: (string | null)[];
	/** `{name}` and `{name, set}`, under the batch's scope. */
	names: NameIdentifier[];
	/**
	 * Ask each store whether it holds each name AT ALL (`CollectionBatchAnswer.namePresent`) — what
	 * lets the partitioned router trust a routed partition's MISS (see `nameReplySettles`). A store
	 * on a build before it ignores the flag.
	 */
	presence?: boolean;
}

/** Per slot of a CollectionBatch, the card as Scryfall JSON bytes, or null for none. */
export interface CollectionBatchAnswer {
	keys: (Uint8Array | null)[];
	trees: (Uint8Array | null)[];
	names: (Uint8Array | null)[];
	/** `[tier, name, served, score]` per name, or null — what the partitioned router merges names by. */
	nameRanks: (NameRank | null)[];
	/**
	 * Per name, whether this store holds it at all — no set, no scope, and `exact=`'s wider name
	 * rule — when the batch asked for `presence` and the store understood; absent otherwise.
	 */
	namePresent?: boolean[];
}

/**
 * A name lookup's rank on the wire, `[tier, name, served, score]` — card_engine's `exact_name_rank`.
 * The router compares two with `beatsExactRank`: a NUMBER element higher-wins, a STRING element (the
 * collated card name) lower-wins, in order.
 */
export type NameRank = (number | string)[];

/**
 * One store's whole answer to an `exact=` name — `scryfallExactNameRank` and `scryfallExactName`
 * in one reply, plus `present`: whether the store holds the name at all, set or no set. What the
 * partitioned router asks the partition the routing filter names for a name (backlog n6).
 */
export interface ExactNameProbe {
	rank: NameRank | null;
	present: boolean;
	card: Record<string, unknown> | null;
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
 * The `?q=` of a `POST /cards/collection`, once per batch: the prefer folded out of it (this
 * API's spelling; "default" is no preference) and the rest of it as a canonical filter tree, or
 * null when nothing but directives was written. Applied to every `{name}` identifier — the
 * printing answered is the best of those passing the filter under the prefer. See the engine's
 * `CollectionScope`.
 */
export interface CollectionScope {
	prefer: PreferOrder;
	filterTreeJson: string | null;
}

/**
 * The FLOOR of the typo-tolerant stage of `?fuzzy=`: a candidate scoring below this is not a
 * candidate at all, and the needle goes on to containment. Its metric is pg_trgm's similarity of
 * the COLLATED name (backlog x25; card_engine's `Fuzzy name matching` section has the derivation).
 *
 * BRACKETED BY PROBES, 2026-09-26: `fuzzy=deadeall` scores 6/11 = 0.545 against Deadfall and is a
 * 404 on api.scryfall.com; `fuzzy=lightning blow&set=m11` and `lihgtning bolt` score 5/9 = 0.556
 * against Lightning Bolt and answer it. Every cached answer (217 `fuzzy=` needles) reads the same
 * with any floor in between.
 */
export const FUZZY_SIMILARITY_FLOOR = 0.55;

/**
 * The fuzzy LEAD: the best candidate must lead the best competing (different name, different
 * card) candidate by this much or the answer is `ambiguous`. ZERO since backlog x25 — Scryfall's
 * typo stage never calls a tie ambiguous: `fuzzy=illusionary`, `parallax` and `thoughts`, whose
 * two best cards score the same, answer Illusionary Wall, Parallax Wave and Thought Scour
 * (probed 2026-09-26), and `sculptor` Storm Sculptor over Soul Sculptor. The tie goes to the card
 * first printed most recently, then to the name that sorts last (card_engine's `FuzzyRace`,
 * `raceFuzzyCandidates`). Every needle Scryfall calls ambiguous falls through the floor and is
 * called ambiguous by the containment stage behind it.
 *
 * Lives here, on the seam, because BOTH sides apply it — the engine's own race and the
 * partitioned gather's global race — and the two must never drift.
 */
export const FUZZY_SIMILARITY_LEAD = 0;

/**
 * The score below which a typo winner no longer outranks the containment stage (backlog n14) — 0
 * since backlog x25, which reads every hit as "hit". The line was 0.71 on the metric before x25,
 * fitted to eleven needles where the one card carrying every query word beat a typo winner scoring
 * 0.703 or less; on the collated metric every one of those winners scores under the floor
 * (`hyd disintegrat` 0.474 for Disintegrate, `moderator` 0.500 for Moderation), so containment
 * answers them with no line, and the two the line could not reach (`ugin spirit`, `mindstat`) are
 * right too. The mechanism stays (the engine reports "weak" under a positive line and its bundle
 * skips containment only at or above it), unused.
 */
export const FUZZY_WEAK_BELOW = 0;

/** Backlog n15: which partitions `/cards/named?fuzzy=` must ask — see store.ts `namesFuzzyPlan`. */
export interface NamedFuzzyPlan {
	/** The partitions to ask, ascending. */
	partitions: number[];
	/** Every partition must be asked (the containment stage may need foreign printed names). */
	everywhere: boolean;
	/** The stage that decided the set: "exact", "typo", "contained" or "miss" (logging only). */
	stage: string;
	/** The build the plan was made from — the router uses it only when it is its own. */
	builtAt: string;
	/**
	 * x24: what the printed-names blob said, for the log line — "hit" (it named partitions for the
	 * printed tier), "miss" (it named none), "absent" (the plan needed it and could not read it: no
	 * blob in the manifest, or one KV or wasm refused; the plan stays `everywhere`). Absent from a
	 * plan that never reached that tier, and from an object on the build before x24.
	 */
	printed?: "hit" | "miss" | "absent";
}

/**
 * x22: the plan object's OWN bundle, asked in the plan's call. The plan object is a partition object
 * too, and a plan that names its partition — every `everywhere` plan, which is every miss the index
 * cannot settle — used to cost it a second call for its bundle. `partition` is its number as the
 * router counts them; the rest are the bundle's own arguments (no set: a set= needle is never planned).
 */
export interface NamedFuzzyOwnBundle {
	partition: number;
	limit: number;
	baseUrl: string;
}

/** A plan, and — when the router asked for it and the plan names the object's partition — its bundle. */
export interface NamedFuzzyPlanReply extends NamedFuzzyPlan {
	bundle?: NamedFuzzyBundle;
}

/** One cross-partition fuzzy candidate, decoded off the wasm `fuzzy_candidates` packet.
 * `oracleId` is the global card identity the race's "a card never competes with itself" rule
 * keys on; `vpid` is partition-local and unused by the race. */
export interface FuzzyCandidateWire {
	score: number;
	/** Whether `vpid` is a printing a default search shows. The race's tiebreak on a score
	 * tie: two cards sharing one name score identically, and the served one (the tla sorcery)
	 * must lead the extras-only one (the jtla memorabilia front card) whatever partition each
	 * hashed to. See the engine's `FuzzyRace`. */
	served: boolean;
	/** The day the card was first printed, yyyymmdd (0 unknown): the race's next tiebreak after
	 * `served` (backlog x25). Absent from an object on the build before x25. */
	firstReleased?: number;
	oracleId: string;
	vpid: number;
	foldedName: string;
}

/**
 * What a `?fuzzy=` lookup resolved to. "weak" is a hit scoring under FUZZY_WEAK_BELOW, with its
 * card: the answer only when the containment stage has no single card instead.
 */
export interface ScryfallFuzzyResult {
	status: "hit" | "weak" | "ambiguous" | "miss";
	card: Record<string, unknown> | null;
}

/**
 * One store's whole answer to `/cards/named?fuzzy=` (backlog n7) — engine/wasm's
 * `named_fuzzy_bundle`, decoded: each stage exactly as its own method answers it, or null where
 * the store skipped a stage whose answer the router can never read.
 *
 *   exact       `scryfallExactNameProbe` — always
 *   fuzzy       this store's own `scryfallFuzzyName` — null when it ranks the needle exactly
 *   candidates  `fuzzyCandidates` — empty when it ranks the needle exactly
 *   contained   `scryfallNamesContaining` — null unless the store has no rank and no candidate
 *               scoring at or above FUZZY_WEAK_BELOW (a strong one)
 */
export interface NamedFuzzyBundle {
	exact: ExactNameProbe;
	fuzzy: ScryfallFuzzyResult | null;
	candidates: FuzzyCandidateWire[];
	contained: Record<string, unknown>[] | null;
}

/** What `/cards/named?fuzzy=` resolved to — the route renders the card, or answers the 404. */
export type NamedFuzzyAnswer =
	| { status: "card"; card: Record<string, unknown> }
	| { status: "ambiguous" }
	| { status: "miss" };

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
 * Thrown by a partition object asked to answer a query PINNED to it (see pinned-oracle.ts) when
 * the partition count the caller pinned against is not the one its loaded store was cut at. The
 * caller's manifest is at most a minute stale; the object's is the truth. Answered from the wrong
 * modulus the page would be an honest-looking empty one, and `/cards/search` is edge-cached for 16
 * hours — so the caller falls back to the gather, which re-runs at the loaded width.
 */
export class StaleModulusError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StaleModulusError";
	}
}

/** Same role as ENGINE_UNAVAILABLE_MARKER, for StaleModulusError across the RPC boundary. */
export const STALE_MODULUS_MARKER = "__STALE_MODULUS__";

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
	/**
	 * The built_at of the manifest THIS one replaced — the ROLLBACK role in retention by role
	 * (src/engine/kv-retention.ts). Written by every publisher (withPreviousBuiltAt); absent on a
	 * manifest from before x3, where retention falls back to the newest family older than this one.
	 */
	previous_built_at?: string;
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

	/**
	 * n8: this build's card-names blob (src/engine/card-names.ts) — every served name pair of the
	 * corpus, which lets `/cards/autocomplete` ask ONE engine object instead of all N. The KV key,
	 * and the bytes KV holds under it (gzipped), which a reader checks what it fetched against.
	 *
	 * Per BUILD, like the routing filter, so neither is carried forward: each publisher writes its
	 * own. Optional and read-tolerant (cardNamesOf): a manifest without them — published before n8,
	 * or by a run that could not build the blob — makes autocomplete fan out as it always did.
	 */
	names_key?: string;
	names_bytes?: number;

	/**
	 * x24: this build's printed-names blob (src/engine/printed-names.ts) — every card's foreign
	 * printed names, cut to what an ASCII query word can match — which lets the fuzzy plan settle
	 * containment's printed tier from ONE object, so a `/cards/named?fuzzy=` needle no name carries
	 * is a 404 in one call where it asked every partition. Per BUILD, never carried forward, and
	 * read-tolerant (printedNamesOf): absent — a build published before x24, or a run that could not
	 * build it — the plan asks every partition for that tier, as it always did.
	 */
	printed_key?: string;
	printed_bytes?: number;

	// ── Blocks the nightly decides and every later publish carries forward ─────
	//
	// Neither describes the store's bytes, so neither is a format change: a reader that predates
	// them ignores them, and a manifest without them reads as the safe default. Both publishers
	// must carry them — the coordinator decides them (stepManifest), the deploy path copies them
	// from the live manifest (scripts/seed-remote-kv.ts), or a deploy would silently reset them.

	/**
	 * r3: which codec engine objects may WRITE their local archive cache in after loading this
	 * build. Readers accept either cached format whatever this says. Decided nightly by the pool
	 * gate (import-budget.ts decideCacheCodec); absent, an unknown version or an unknown codec
	 * reads as gzip (store-cache.ts cacheCodecOf) — the pool-safe choice.
	 */
	cache?: StoreManifestCache;
	/**
	 * g1: the location hints Cloudflare cannot host yet, the served hint each one's traffic goes
	 * to instead, per-hint object generations, and the probe history behind them
	 * (placement-policy.ts). Absent reads as UNSERVED_SEED: sam→enam, afr→weur, me→eeur.
	 */
	placement?: PlacementBlock;
}

/** The engine objects' local cache codec. See StoreManifest.cache. */
export type CacheCodec = "lz4" | "gzip";

export interface StoreManifestCache {
	v: 1;
	codec: CacheCodec;
	/** The pool projection, WITH LZ4 caches, that decided `codec` — bytes. For the log and the next gate. */
	projected_lz4_bytes: number;
	/**
	 * x1: the coordinator staging high-water the gate budgeted (bytes, measured: RunMeters.peak_db_bytes
	 * plus 1%). What an isolate sizes the pool-aware shard cap with (import-budget.ts
	 * manifestPoolShardCap), and what the next run's listing checks retiring coordinators against —
	 * neither can measure it. Absent on manifests published before x1: stagingBytesOf falls back.
	 */
	staging_bytes?: number;
}

// Generated by `bun run cf-typegen` (wrangler types) from wrangler.jsonc +
// .env — bindings, vars, and secret names all come from the real config.
export type Env = Cloudflare.Env;
