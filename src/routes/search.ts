// Port of the /search and /random_search routes and the _search core
// (api_resource.py:1091-1321, 2555-2586).
//
// Engine-first with upstream's SQL fallback semantics restored: an engine
// that throws on a query it was handed sends the search to SQL — here the D1
// cards table (src/fallback/), once the import has fully synced it. An
// empty/unloaded store still surfaces as EngineUnavailableError (dispatch
// answers 503), and if the fallback is unavailable or
// also fails, the failure stays a loud 500 — never a silent empty result.

import { EngineUnavailableError } from "../engine/types";
import { fallbackReady, fallbackSearch } from "../fallback/sql-search";
import type { FilterValue } from "../parser";
import { canonicalStringify } from "../parser";
import type { CardOrdering, PreferOrder, ResponseShape, SortDirection, UniqueOn } from "./enums";
import { CARD_ORDERING, PREFER_ORDER, RESPONSE_SHAPE, SORT_DIRECTION, UNIQUE_ON } from "./enums";
import { explainWireTree } from "./explanation";
import { httpError, jsonResponse, NO_STORE_HEADER, searchCacheHeader } from "./http";
import type { CardRow } from "./noscript";
import { bindParams, enumParam, intParam, pyRepr, strListParam, strParam } from "./param-binding";
import { loadParser } from "./parser-bridge";
import type { RouteContext } from "./registry";
import { Timer } from "./timer";

// Public field name -> magic.cards column vocabulary for `fields=` (upstream
// RESULT_FIELD_COLUMNS; only the key set matters on the engine path).
export const RESULT_FIELD_NAMES: readonly string[] = [
	"name",
	"set_code",
	"collector_number",
	"power",
	"toughness",
	"mana_cost",
	"oracle_text",
	"set_name",
	"type_line",
	"illustration_id",
	"scryfall_id",
	"price_usd",
	"prefer_score",
];

// `fields=None` resolves to these 9 (upstream DEFAULT_RESULT_FIELDS).
export const DEFAULT_RESULT_FIELDS: readonly string[] = [
	"name",
	"set_code",
	"collector_number",
	"power",
	"toughness",
	"mana_cost",
	"oracle_text",
	"set_name",
	"type_line",
];

/** A falcon.HTTPBadRequest-shaped failure raised inside the search core. */
export class SearchBadRequest extends Error {
	constructor(
		readonly title: string,
		readonly description: string,
	) {
		super(`${title}: ${description}`);
		this.name = "SearchBadRequest";
	}
}

/** The engine failed to answer a query it was given (upstream would fall back to SQL here). */
export class EngineQueryError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "EngineQueryError";
	}
}

/** Upstream _validate_limit; the non-int branch is unreachable over HTTP (coercion runs first). */
export function validateLimit(limit: number | null): number | null {
	if (limit !== null && limit < 0) {
		throw new SearchBadRequest("Invalid Limit", "Limit must be a positive integer.");
	}
	return limit;
}

/** Upstream _resolve_result_fields: dedupe, reject empty and unknown names. */
export function resolveResultFields(fields: readonly string[] | null): string[] {
	if (fields === null) {
		return [...DEFAULT_RESULT_FIELDS];
	}
	const resolved = [...new Set(fields)];
	if (resolved.length === 0) {
		throw new SearchBadRequest("Invalid Fields", "fields must include at least one field name.");
	}
	for (const name of resolved) {
		if (!RESULT_FIELD_NAMES.includes(name)) {
			throw new SearchBadRequest("Invalid Fields", `Unknown field: ${pyRepr(name)}`);
		}
	}
	return resolved;
}

/**
 * Upstream _columnarize_cards: invert a list of card dicts into one list per
 * field. Every card carries the same keys, so keys come from the first card.
 */
export function columnarizeCards(cards: CardRow[]): Record<string, unknown[]> {
	const keys = cards.length > 0 ? Object.keys(cards[0] as CardRow) : [];
	return Object.fromEntries(keys.map((k) => [k, cards.map((c) => c[k])]));
}

export interface SearchEnvelope {
	cards: CardRow[];
	compiled: string;
	inner_timings: unknown;
	outer_timings: unknown;
	params: Record<string, never>;
	query: string;
	query_explanation: string;
	total_cards: number;
	[key: string]: unknown;
}

export interface RunSearchOptions {
	query: string | null;
	orderby: CardOrdering;
	direction: SortDirection;
	unique: UniqueOn;
	prefer: PreferOrder;
	/** null means "no limit" (engine gets 1_000_000, like upstream). Defaults to 100. */
	limit?: number | null;
	fields?: readonly string[] | null;
}

/**
 * Port of _search/_search_engine. Throws SearchBadRequest for parse/limit/
 * fields problems, EngineQueryError when the engine fails, and lets
 * EngineUnavailableError from getEngine() propagate (503 at dispatch).
 */
export async function runSearch(ctx: RouteContext, opts: RunSearchOptions): Promise<SearchEnvelope> {
	// _require_setup_complete parity: the engine must be resolvable before any
	// parameter validation errors are reported.
	const engine = await ctx.getEngine();
	const limit = validateLimit(opts.limit === undefined ? 100 : opts.limit);
	const resolvedFields = resolveResultFields(opts.fields ?? null);

	const timer = new Timer();
	const query = opts.query || "";
	const parser = await loadParser();
	let filterTree: unknown;
	try {
		filterTree = timer.time("parse", () => parser.parseScryfallQuery(query));
	} catch (err) {
		if (parser.isParseError(err)) {
			throw new SearchBadRequest("Invalid Search Query", `Failed to parse query: "${query}"`);
		}
		throw err;
	}

	const queryExplanation = query ? explainWireTree(filterTree) : "";

	let totalCards: number;
	let rawCards: CardRow[];
	let compiled = "(rust engine)";
	try {
		const result = await timer.time("engine_query", () =>
			engine.search({
				filterTreeJson: canonicalStringify(filterTree as FilterValue),
				unique: opts.unique,
				prefer: opts.prefer,
				orderby: opts.orderby,
				direction: opts.direction,
				// limit=None means "no limit"; the engine requires an int (upstream parity)
				limit: limit !== null ? limit : 1_000_000,
				fields: resolvedFields,
			}),
		);
		totalCards = result.totalCards;
		rawCards = result.cards;
	} catch (err) {
		if (err instanceof EngineUnavailableError) {
			throw err;
		}
		// Upstream's fallback trigger: an engine that throws on a query it was
		// handed sends the search to SQL. Here that is the D1 cards table —
		// available once the import has fully synced it (fallback_meta); until
		// then this port's original structured error stands.
		if (!(await fallbackReady(ctx.env))) {
			throw new EngineQueryError(`Engine query failed for ${JSON.stringify(query)}`, { cause: err });
		}
		try {
			const result = await timer.time("sql_query", () =>
				fallbackSearch(ctx.env, {
					filterTree,
					unique: opts.unique,
					prefer: opts.prefer,
					orderby: opts.orderby,
					direction: opts.direction,
					limit,
					resolvedFields,
				}),
			);
			totalCards = result.totalCards;
			rawCards = result.cards as CardRow[];
			compiled = "(d1 fallback)";
			console.log(`Engine declined ${JSON.stringify(query)}; answered by the D1 SQL fallback`);
		} catch (sqlErr) {
			// The fallback could not express or execute the query either —
			// surface the ORIGINAL engine failure (the primary path's error).
			console.warn(`D1 fallback also failed for ${JSON.stringify(query)}: ${sqlErr}`);
			throw new EngineQueryError(`Engine query failed for ${JSON.stringify(query)}`, { cause: err });
		}
	}
	const cards = timer.time("engine_collect", () => [...rawCards]);

	const timings = timer.getTimings();
	return {
		cards,
		compiled,
		inner_timings: timings,
		outer_timings: timings,
		params: {},
		query,
		query_explanation: queryExplanation,
		total_cards: totalCards,
	};
}

// Keyword parameters of search(), in signature order (binding reports the
// first failing parameter in this order, like upstream's ParamBinder plan).
const SEARCH_SPEC = [
	{ name: "direction", converter: enumParam(SORT_DIRECTION), default: "asc" },
	{ name: "fields", converter: strListParam(), default: null },
	{ name: "limit", converter: intParam(), default: 100 },
	{ name: "orderby", converter: enumParam(CARD_ORDERING), default: "edhrec" },
	{ name: "prefer", converter: enumParam(PREFER_ORDER), default: "default" },
	{ name: "q", converter: strParam(), default: null },
	{ name: "query", converter: strParam(), default: null },
	{ name: "shape", converter: enumParam(RESPONSE_SHAPE), default: "rows" },
	{ name: "unique", converter: enumParam(UNIQUE_ON), default: "card" },
] as const;

/** Run a search query and return results and metadata (upstream search()). */
export async function searchHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const bound = bindParams("APIResource.search", SEARCH_SPEC, [], params);
	// Falcon sets Cache-Control before running the search, so the header also
	// rides on the 400s raised inside it (upstream parity).
	const cache = searchCacheHeader();
	try {
		const results = await runSearch(ctx, {
			query: (bound.query as string | null) || (bound.q as string | null),
			orderby: bound.orderby as CardOrdering,
			direction: bound.direction as SortDirection,
			unique: bound.unique as UniqueOn,
			prefer: bound.prefer as PreferOrder,
			limit: bound.limit as number,
			fields: bound.fields as string[] | null,
		});
		let envelope: Record<string, unknown> = results;
		if ((bound.shape as ResponseShape) === "columnar") {
			// Shallow copy: the cards list must stay row-shaped elsewhere.
			envelope = { ...results, cards: columnarizeCards(results.cards) };
		}
		return jsonResponse(envelope, cache);
	} catch (err) {
		if (err instanceof SearchBadRequest) {
			return httpError(400, err.title, err.description, cache);
		}
		if (err instanceof EngineQueryError) {
			// DELIBERATE DEVIATION: upstream silently falls back to SQL here.
			console.error(`Engine query failed: ${err.message}`, err.cause);
			return httpError(500, "Engine Error", "The query engine failed to answer this search.");
		}
		throw err;
	}
}

const RANDOM_SEARCH_SPEC = [
	{ name: "num_cards", converter: intParam(), default: 1 },
	{ name: "shape", converter: enumParam(RESPONSE_SHAPE), default: "rows" },
] as const;

/** Return one or more random cards in the same envelope shape as search() (upstream random_search()). */
export async function randomSearchHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const bound = bindParams("APIResource.random_search", RANDOM_SEARCH_SPEC, [], params);
	const numCards = Math.min(Math.max(bound.num_cards as number, 1), 1000);
	// Upstream returns an empty list while the store is loading; this port has
	// no store-less mode, so an unloaded engine is a 503 (see module comment).
	const engine = await ctx.getEngine();
	const cards = await engine.samplePreferred(numCards, [...DEFAULT_RESULT_FIELDS]);
	const totalCards = cards.length;
	const shaped: unknown = (bound.shape as ResponseShape) === "columnar" ? columnarizeCards(cards) : cards;
	return jsonResponse({ cards: shaped, total_cards: totalCards }, NO_STORE_HEADER);
}
