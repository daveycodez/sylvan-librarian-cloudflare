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
} from "../../src/engine/types";
import { EngineUnavailableError } from "../../src/engine/types";
import { buildRoutesListing, routes } from "../../src/routes";
import { httpError, securityHeaders } from "../../src/routes/http";
import { setParserForTests } from "../../src/routes/parser-bridge";
import type { RouteContext } from "../../src/routes/registry";
import { toScryfallCard } from "../../src/routes/scryfall-compat/objects";

export const FIXTURE_CARDS: Record<string, unknown>[] = [
	{
		// `scryfall_id` is in DEFAULT_RESULT_FIELDS, so a real engine row always carries one — and
		// the /cards/* surface addresses cards BY it.
		scryfall_id: "aaaaaaaa-0000-0000-0000-000000000001",
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
		scryfall_id: "aaaaaaaa-0000-0000-0000-000000000002",
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

export class FakeEngine implements Engine {
	lastSearch: EngineSearchOptions | null = null;
	lastSampleArgs: { numCards: number; fields: string[] } | null = null;
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

	async randomCardsAsObjects(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		this.lastSampleArgs = { numCards, fields };
		const out: Record<string, unknown>[] = [];
		for (let i = 0; i < Math.min(numCards, this.cards.length); i++) {
			out.push(this.cards[i] as Record<string, unknown>);
		}
		return out;
	}

	async randomCardsAsJson(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult> {
		const rows = await this.randomCardsAsObjects(numCards, fields);
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
		const cards = this.cards.slice(0, opts.limit).map((row) => toScryfallCard(row, baseUrl));
		return { totalCards: this.totalCards, cardsBytes: encodeUtf8(JSON.stringify(cards)), rowCount: cards.length };
	}

	/** The streamed shape, over the same fixture bytes — so route tests exercise the real splice. */
	async scryfallSearchStream(
		opts: EngineSearchOptions,
		baseUrl: string,
	): Promise<{ totalCards: number; rowCount: number; byteLength: number; body: ReadableStream<Uint8Array> }> {
		const result = await this.scryfallSearch(opts, baseUrl);
		return {
			totalCards: result.totalCards,
			rowCount: result.rowCount,
			byteLength: result.cardsBytes.byteLength,
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(result.cardsBytes);
					controller.close();
				},
			}),
		};
	}

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

	async scryfallFirstOfEach(filterTreeJsons: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]> {
		return filterTreeJsons.map(() => this.fixtureCard(0, baseUrl));
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
		// The fake parser knows nothing of directives; route tests that care about
		// them install a parser that does.
		parseWithDirectives: (query: string) => ({ tree: parse(query), directives: [] }),
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
	if (!resolved) {
		return httpError(404, "Not Found", { routes: buildRoutesListing() });
	}
	const routeEntry = routes[resolved.key];
	if (!routeEntry) {
		return httpError(404, "Not Found", { routes: buildRoutesListing() });
	}
	if (!routeEntry.methods.includes(method)) {
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
			// Mirrors src/index.ts: upstream's exact wording, cause to the log.
			return securityHeaders(httpError(503, "Service Unavailable", "Engine is not loaded, please try again later."));
		}
		return securityHeaders(httpError(500, "Server Error", "An internal error occurred."));
	}
}

export async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}
