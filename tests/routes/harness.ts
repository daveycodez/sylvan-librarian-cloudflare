// Test harness for the route handlers: a fake Engine, a hand-built
// RouteContext, a fake wire parser installed through the parser bridge, and a
// mini-dispatch that replicates src/index.ts's handle() (which cannot be
// imported here: it pulls in the engine store and import coordinator, which
// are wasm/DO-backed). No network, no wasm.

import { encodeUtf8 } from "../../src/engine/bytes";
import { serializeCards } from "../../src/engine/columnar";
import type {
	Engine,
	EngineSearchOptions,
	EngineSerializedResult,
	Env,
	ResultShape,
	ScryfallFuzzyResult,
	SearchPageEnvelope,
} from "../../src/engine/types";
import { EngineUnavailableError } from "../../src/engine/types";
import { routes, SCRYFALL_SURFACE_ROUTES } from "../../src/routes";
import { adminUnauthorized, isAdminPath } from "../../src/routes/admin";
import { httpError, optionsResponse, securityHeaders } from "../../src/routes/http";
import { setParserForTests } from "../../src/routes/parser-bridge";
import type { RouteContext } from "../../src/routes/registry";
import { toScryfallCard } from "../../src/routes/scryfall-compat/objects";
import {
	emptyPageResponse,
	scryfallCsvResponse,
	scryfallHttpError,
	scryfallListJson,
} from "../../src/routes/scryfall-compat/respond";
import { NOT_FOUND_DETAILS } from "../../src/routes/scryfall-compat/routes";

export const FIXTURE_CARDS: Record<string, unknown>[] = [
	{
		// `scryfall_id` is in DEFAULT_RESULT_FIELDS, so a real engine row always carries one — and
		// the /cards/* surface addresses cards BY it.
		scryfall_id: "aaaaaaaa-0000-4000-8000-000000000001",
		name: "Llanowar Elves",
		set_code: "m19",
		collector_number: "314",
		power: "1",
		toughness: "1",
		mana_cost: "{G}",
		oracle_text: "{T}: Add {G}.",
		set_name: "Core Set 2019",
		type_line: "Creature — Elf Druid",
	},
	{
		scryfall_id: "aaaaaaaa-0000-4000-8000-000000000002",
		name: "Elvish Mystic",
		set_code: "m15",
		collector_number: "18",
		power: "1",
		toughness: "1",
		mana_cost: "{G}",
		oracle_text: "{T}: Add {G}.",
		set_name: "Magic 2015",
		type_line: "Creature — Elf Druid",
	},
];

/**
 * Foreign printings, addressable by the query-shaped lookups but NOT part of the default search
 * corpus — the fake's counterpart of the engine's annex. Today's real corpus cannot exercise
 * these rows (foreign printings are not imported yet); the fixtures exist so the route behavior
 * is pinned BEFORE the corpus can regress it.
 */
export const FOREIGN_FIXTURE_CARDS: Record<string, unknown>[] = [
	{
		// A Japanese printing SHARING set and collector number with an English row (Elvish
		// Mystic, m15/18) — the shape that makes the implicit-English default testable: a
		// lookup that forgets the language resolves this row instead (see addressableRows).
		scryfall_id: "aaaaaaaa-0000-4000-8000-000000000003",
		name: "Elvish Mystic",
		printed_name: "エルフの神秘家",
		lang: "ja",
		set_code: "m15",
		collector_number: "18",
		power: "1",
		toughness: "1",
		mana_cost: "{G}",
		oracle_text: "{T}: Add {G}.",
		set_name: "Magic 2015",
		type_line: "Creature — Elf Druid",
	},
	{
		// A printing that exists ONLY in Portuguese — the row a default-English lookup must MISS
		// rather than substitute.
		scryfall_id: "aaaaaaaa-0000-4000-8000-000000000004",
		name: "Unmoored Ego",
		printed_name: "Ego à Deriva",
		lang: "pt",
		set_code: "grn",
		collector_number: "212",
		mana_cost: "{U}{B}",
		oracle_text: "Choose a card name.",
		set_name: "Guilds of Ravnica",
		type_line: "Sorcery",
	},
];

/** The row fields the hand-built trees (src/routes/scryfall-compat/trees.ts) address. */
const TREE_COLUMNS: Record<string, string> = {
	card_set_code: "set_code",
	collector_number: "collector_number",
	card_lang: "lang",
	card_name: "name",
};

/**
 * Evaluate one hand-built filter tree against a fixture row — REAL matching, deliberately, so a
 * lookup that drops a clause (the `{set, collector_number}` identifiers' implicit `card_lang ==
 * "en"` is the one that matters) fails a test instead of resolving whatever the fake felt like.
 * Only the shapes trees.ts builds are understood; anything else is a loud error, because a tree
 * this fake cannot evaluate is a tree no test has pinned.
 */
function treeMatchesRow(tree: string, row: Record<string, unknown>): boolean {
	const node = JSON.parse(tree) as { node_type: string; kwargs: Record<string, unknown> };
	const clauses = node.node_type === "AndNode" ? (node.kwargs.operands as (typeof node)[]) : [node];
	for (const clause of clauses) {
		if (clause.node_type !== "CardBinaryOperatorNode" || clause.kwargs.op !== "=") {
			throw new Error(`FakeEngine cannot evaluate tree node: ${JSON.stringify(clause)}`);
		}
		const lhs = clause.kwargs.lhs as { kwargs: { attribute_name: string } };
		const rhs = clause.kwargs.rhs as { kwargs: { value: string } };
		const field = TREE_COLUMNS[lhs.kwargs.attribute_name];
		if (field === undefined) {
			throw new Error(`FakeEngine cannot evaluate tree attribute: ${lhs.kwargs.attribute_name}`);
		}
		// `lang` defaults to "en" when the row omits it, mirroring toScryfallCard's own default;
		// names compare case-insensitively, mirroring upstream's lower() = lower().
		const stored = field === "lang" ? String(row.lang ?? "en") : String(row[field] ?? "");
		const matches =
			field === "name" ? stored.toLowerCase() === rhs.kwargs.value.toLowerCase() : stored === rhs.kwargs.value;
		if (!matches) return false;
	}
	return true;
}

export class FakeEngine implements Engine {
	lastSearch: EngineSearchOptions | null = null;
	lastSampleArgs: { numCards: number; fields: string[]; filterTreeJson?: string } | null = null;
	searchError: Error | null = null;
	cards: Record<string, unknown>[] = FIXTURE_CARDS;
	totalCards = 17;
	types: Record<string, number> = { Creature: 100, Kindred: 5, Land: 42 };
	keywords: Record<string, number> = { Flying: 10, Haste: 3 };

	async searchCardsAsObjects(
		opts: EngineSearchOptions,
	): Promise<{ totalCards: number; cards: Record<string, unknown>[] }> {
		this.lastSearch = opts;
		if (this.searchError) {
			throw this.searchError;
		}
		return { totalCards: this.totalCards, cards: this.cards.slice(0, opts.limit) };
	}

	// Encodes from the same rows search() returns, so a test asserting on the
	// API bytes and one asserting on the page's data are checking one source.
	async searchCardsAsJson(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		const { totalCards, cards } = await this.searchCardsAsObjects(opts);
		return { totalCards, cardsBytes: encodeUtf8(serializeCards(cards, shape)), rowCount: cards.length };
	}

	async cardTypeCounts(): Promise<Record<string, number>> {
		return { ...this.types };
	}

	async cardKeywordCounts(): Promise<Record<string, number>> {
		return { ...this.keywords };
	}

	/** Set codes with an `is:extra` printing — the `include_extras` auto-enable table. Settable
	 * per test through `setsWithExtrasList`, because the trigger is a per-set property and a fake
	 * that always answered "none" could not exercise the half of the rule that fires. */
	setsWithExtrasList: string[] = [];

	async setsWithExtras(): Promise<string[]> {
		return [...this.setsWithExtrasList];
	}

	async randomCardsAsObjects(
		numCards: number,
		fields: string[],
		filterTreeJson?: string,
	): Promise<Record<string, unknown>[]> {
		this.lastSampleArgs = { numCards, fields, filterTreeJson };
		const out: Record<string, unknown>[] = [];
		for (let i = 0; i < Math.min(numCards, this.cards.length); i++) {
			out.push(this.cards[i] as Record<string, unknown>);
		}
		return out;
	}

	async randomCardsAsJson(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		filterTreeJson?: string,
	): Promise<EngineSerializedResult> {
		const rows = await this.randomCardsAsObjects(numCards, fields, filterTreeJson);
		return { totalCards: rows.length, cardsBytes: encodeUtf8(serializeCards(rows, shape)), rowCount: rows.length };
	}

	async cardCount(): Promise<number> {
		return this.totalCards;
	}

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// Built from the SAME FIXTURE_CARDS the search half returns, through the same
	// `toScryfallCard` the real engine uses, so a route test asserting on a card object and one
	// asserting on a search row are checking one source. Only the lookup is faked.

	scryfallBaseUrl: string | null = null;
	/** Ids the fake resolves; anything else is a genuine miss, which IS the 404. */
	scryfallKnownIds: string[] = FIXTURE_CARDS.map((c) => String(c.scryfall_id));
	scryfallFuzzyStatus: ScryfallFuzzyResult["status"] = "hit";
	lastAutocomplete: { prefix: string; limit: number } | null = null;

	private fixtureCard(index: number, baseUrl: string): Record<string, unknown> | null {
		const row = FIXTURE_CARDS[index];
		return row === undefined ? null : toScryfallCard(row, baseUrl);
	}

	async scryfallSearch(opts: EngineSearchOptions, baseUrl: string): Promise<EngineSerializedResult> {
		this.lastSearch = opts;
		if (this.searchError) throw this.searchError;
		this.scryfallBaseUrl = baseUrl;
		// The OFFSET is honored here (and only here) because the compat surface's pagination
		// contract depends on it: a page past the end has to come back with zero rows for the
		// 422 to be reachable at all.
		const cards = this.cards.slice(opts.offset, opts.offset + opts.limit).map((row) => toScryfallCard(row, baseUrl));
		return { totalCards: this.totalCards, cardsBytes: encodeUtf8(JSON.stringify(cards)), rowCount: cards.length };
	}

	/** In-process there is no boundary to save; wraps the bytes searchCardsAsJson already produced. */
	/** In-process: the same envelope, spliced here because there is no boundary to keep it off. */
	async scryfallSearchPage(
		opts: EngineSearchOptions,
		baseUrl: string,
		envelope: SearchPageEnvelope,
		cache: Record<string, string>,
	): Promise<Response> {
		const r = await this.scryfallSearch(opts, baseUrl);
		if (r.rowCount === 0) return emptyPageResponse(envelope, r.totalCards, cache);
		const hasMore = envelope.pageOffset + r.rowCount < r.totalCards;
		// Same branch, same order, same helper as the two real implementations (store.ts and
		// search-engine-do.ts): `?format=csv` selects a serialization of the rows this page already
		// holds, so the fake must not be the one place where it selects a query instead.
		if (envelope.csv === true) return scryfallCsvResponse(r.cardsBytes, hasMore, cache);
		return scryfallListJson(
			r.cardsBytes,
			{
				totalCards: r.totalCards,
				hasMore,
				nextPage: hasMore ? envelope.nextPageUrl : undefined,
				warnings: envelope.warnings,
			},
			envelope.pretty,
			cache,
		);
	}

	/** The streamed shape, over the same fixture bytes — so route tests exercise the real splice. */
	async scryfallCardById(scryfallId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const at = this.scryfallKnownIds.indexOf(scryfallId);
		return at < 0 ? null : this.fixtureCard(at, baseUrl);
	}

	async scryfallCardsByIds(scryfallIds: string[], baseUrl: string): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
		for (const id of scryfallIds) {
			const card = await this.scryfallCardById(id, baseUrl);
			if (card) out.push(card);
		}
		return out;
	}

	async scryfallCardByOracleId(_oracleId: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		return this.fixtureCard(0, baseUrl);
	}

	async scryfallCardByExternalId(
		_namespace: string,
		_externalId: number,
		baseUrl: string,
	): Promise<Record<string, unknown> | null> {
		return this.fixtureCard(0, baseUrl);
	}

	async scryfallFuzzyName(_name: string, baseUrl: string): Promise<ScryfallFuzzyResult> {
		const status = this.scryfallFuzzyStatus;
		return { status, card: status === "hit" ? this.fixtureCard(0, baseUrl) : null };
	}

	async scryfallAutocomplete(prefix: string, limit: number): Promise<string[]> {
		this.lastAutocomplete = { prefix, limit };
		return FIXTURE_CARDS.map((c) => String(c.name))
			.filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
			.slice(0, limit);
	}

	/** Names the fake resolves exactly, folded; anything else is a miss. */
	scryfallExactNames: string[] = FIXTURE_CARDS.map((c) => String(c.name).toLowerCase());

	async scryfallExactName(folded: string, _setCode: string, baseUrl: string): Promise<Record<string, unknown> | null> {
		const at = this.scryfallExactNames.indexOf(folded);
		return at < 0 ? null : this.fixtureCard(at, baseUrl);
	}

	/** Every fixture name is a WHOLE name here, so a hit ranks at the top tier with a flat score. */
	async scryfallExactNameRank(folded: string, _setCode: string): Promise<number[] | null> {
		return this.scryfallExactNames.includes(folded) ? [2, 0] : null;
	}

	async scryfallCardByIllustrationId(
		_illustrationId: string,
		baseUrl: string,
	): Promise<Record<string, unknown> | null> {
		return this.fixtureCard(0, baseUrl);
	}

	async scryfallNamesContaining(
		words: string[],
		_setCode: string,
		limit: number,
		baseUrl: string,
	): Promise<Record<string, unknown>[]> {
		return FIXTURE_CARDS.map((_, at) => at)
			.filter((at) => words.every((w) => String(FIXTURE_CARDS[at]?.name).toLowerCase().includes(w)))
			.slice(0, limit)
			.map((at) => this.fixtureCard(at, baseUrl))
			.filter((c): c is Record<string, unknown> => c !== null);
	}

	/** Foreign printings the query-shaped lookups can address; the fake's annex. */
	foreignCards: Record<string, unknown>[] = FOREIGN_FIXTURE_CARDS;

	/**
	 * FOREIGN ROWS FIRST, deliberately: every lookup that must pin English does so via an explicit
	 * `card_lang == "en"` clause, and putting the ja row in front of the en row it shares an
	 * address with means a lookup that DROPS that clause resolves the ja row and fails its test —
	 * ordered the other way, the bug would pass silently.
	 */
	private addressableRows(): Record<string, unknown>[] {
		return [...this.foreignCards, ...this.cards];
	}

	async scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]> {
		return filterTreeJsons.map((tree) => {
			const row = this.addressableRows().find((r) => treeMatchesRow(tree, r));
			return row === undefined ? null : toScryfallCard(row, baseUrl);
		});
	}
}

/** Sentinel error the fake parser throws for queries containing "PARSE_FAIL". */
export class FakeParseError extends Error {}

/** Deterministic fake wire trees, shaped like the real engine-wire JSON. */
export function fakeParse(query: string): unknown {
	if (query.includes("PARSE_FAIL")) {
		throw new FakeParseError(`cannot parse: ${query}`);
	}
	if (query === "") {
		return { node_type: "TrueNode", kwargs: {} };
	}
	return {
		node_type: "CardBinaryOperatorNode",
		kwargs: {
			lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_name", original_attribute: "name" } },
			op: ":",
			rhs: { node_type: "StringValueNode", kwargs: { value: query } },
		},
	};
}

export function installFakeParser(parse: (query: string) => unknown = fakeParse): void {
	setParserForTests({
		parseScryfallQuery: parse,
		// The fake parser knows nothing of directives or rewrite warnings; route tests that care
		// about either install a parser that does.
		parseWithDirectives: (query: string) => ({
			tree: parse(query),
			directives: [],
			warnings: [],
			loweredRegexTerms: [],
			expandedDerivedTerms: [],
		}),
		isParseError: (err) => err instanceof FakeParseError,
	});
}

/**
 * Enough of a KVNamespace for the one route that reads KV in the isolate: `/cards/*`'s rulings
 * variants. Everything else here reaches KV only from a Durable Object.
 */
export class FakeKV {
	readonly values = new Map<string, Uint8Array>();
	/** Reads that should fail, for the "KV is down" branch. */
	failOn = new Set<string>();

	put(key: string, value: Uint8Array | string): void {
		this.values.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
	}

	async get(key: string, type?: string): Promise<ArrayBuffer | unknown | null> {
		if (this.failOn.has(key)) throw new Error(`KV get ${key} failed`);
		const value = this.values.get(key);
		if (value === undefined) return null;
		if (type === "json") return JSON.parse(new TextDecoder().decode(value));
		if (type === "arrayBuffer") return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
		return new TextDecoder().decode(value);
	}
}

export interface CtxOptions {
	engine?: Engine | null;
	requestHost?: string;
	/** Override the request, for the one route that reads a body (POST /cards/collection). */
	request?: Request;
	/** STORE_KV, for the rulings routes. Absent means the binding is never touched. */
	kv?: FakeKV;
}

/** RouteContext built by hand; engine: null simulates an unloaded store. */
export function makeCtx(options: CtxOptions = {}): RouteContext {
	const {
		engine = new FakeEngine(),
		requestHost = "sylvan-librarian.com",
		request = new Request("https://sylvan-librarian.com/"),
		kv,
	} = options;
	return {
		env: (kv ? { STORE_KV: kv } : {}) as unknown as Env,
		getEngine: async () => {
			if (!engine) {
				throw new EngineUnavailableError("Engine is not loaded, please try again later.");
			}
			return engine;
		},
		request,
		requestHost,
		waitUntil: () => {},
	};
}

const DISALLOWED_QUERY_ARGS = new Set(["falcon_response", "request_host"]);

/**
 * Mirror of src/index.ts handle(): path resolution, 404 listing, 405 + Allow,
 * binding of query params, Response rethrow, EngineUnavailableError → 503.
 */
export async function testDispatch(ctx: RouteContext, url: string, method = "GET"): Promise<Response> {
	const parsed = new URL(url, "https://sylvan-librarian.com");
	const path = parsed.pathname.replace(/^\/+|\/+$/g, "") || "_root";

	// Mirrors dispatch: the /_admin mount is answered before routing (src/routes/admin.ts).
	if (isAdminPath(path)) return adminUnauthorized();

	let resolved: { key: string; positionalArgs: string[] } | null = null;
	if (path in routes) {
		resolved = { key: path, positionalArgs: [] };
	} else {
		const [actionWord = "", ...actionArgs] = path.split("/");
		const routeEntry = routes[actionWord];
		if (routeEntry && actionArgs.length <= routeEntry.positionalCapacity) {
			resolved = { key: actionWord, positionalArgs: actionArgs };
		}
	}
	// Mirrors dispatch: an unknown path is Scryfall's error object, not upstream's routes listing.
	if (!resolved) {
		return securityHeaders(scryfallHttpError("not_found", 404, NOT_FOUND_DETAILS));
	}
	const routeEntry = routes[resolved.key];
	if (!routeEntry) {
		return securityHeaders(scryfallHttpError("not_found", 404, NOT_FOUND_DETAILS));
	}
	const scryfallSurface = SCRYFALL_SURFACE_ROUTES.has(resolved.key);
	// Before the method check, exactly as dispatch does it — no route declares OPTIONS, so a
	// preflight answered after this point could only be a 405.
	if (method === "OPTIONS") {
		return securityHeaders(optionsResponse());
	}
	if (!routeEntry.methods.includes(method)) {
		// Mirrors dispatch: the Scryfall surface answers 404 with `not_found` and no `Allow`, exactly
		// as api.scryfall.com does; upstream's own surface keeps falcon's 405.
		if (scryfallSurface) {
			return securityHeaders(scryfallHttpError("not_found", 404, NOT_FOUND_DETAILS));
		}
		const allow = [...routeEntry.methods].sort().join(", ");
		return httpError(405, "Method Not Allowed", `Allowed methods: ${allow}`, { Allow: allow });
	}

	const params: Record<string, string> = {};
	for (const [k, v] of parsed.searchParams) {
		if (!DISALLOWED_QUERY_ARGS.has(k)) {
			params[k] = v;
		}
	}

	try {
		const response = await routeEntry.handler(ctx, resolved.positionalArgs, params);
		return securityHeaders(response);
	} catch (err) {
		if (err instanceof Response) {
			return securityHeaders(err);
		}
		if (err instanceof EngineUnavailableError) {
			// Mirrors src/index.ts: upstream's exact wording, cause to the log, shape by surface.
			return securityHeaders(
				scryfallSurface
					? scryfallHttpError("service_unavailable", 503, "Engine is not loaded, please try again later.")
					: httpError(503, "Service Unavailable", "Engine is not loaded, please try again later."),
			);
		}
		return securityHeaders(
			scryfallSurface
				? scryfallHttpError("internal_error", 500, "An internal error occurred.")
				: httpError(500, "Server Error", "An internal error occurred."),
		);
	}
}

export async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}
