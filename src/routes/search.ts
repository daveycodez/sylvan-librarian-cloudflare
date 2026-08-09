// Port of the /search and /random_search routes and the _search core
// (api_resource.py:1091-1321, 2555-2586).
//
// Engine-only: the wasm engine is the sole query path. Upstream sends a query
// the engine throws on to SQL; this port has no SQL, so an engine failure is a
// loud 500 and an empty/unloaded store is an EngineUnavailableError (dispatch
// answers 503) — never a silent empty result.

import type { Engine, EngineSearchOptions } from "../engine/types";
import { EngineUnavailableError } from "../engine/types";
import type { FilterValue } from "../parser";
import { canonicalStringify } from "../parser";
import type { CardOrdering, PreferOrder, ResponseShape, SortDirection, UniqueOn } from "./enums";
import { CARD_ORDERING, PREFER_ORDER, RESPONSE_SHAPE, SORT_DIRECTION, UNIQUE_ON } from "./enums";
import { explainWireTree } from "./explanation";
import { httpError, jsonResponseText, NO_STORE_HEADER, searchCacheHeader } from "./http";
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
 * Everything the envelope carries except `cards`, in upstream's key order —
 * spelled out rather than Omit<SearchEnvelope, "cards">, which collapses to the
 * bare index signature and would let a missing field through unnoticed.
 */
interface SearchMetadata {
	compiled: string;
	inner_timings: unknown;
	outer_timings: unknown;
	params: Record<string, never>;
	query: string;
	query_explanation: string;
	total_cards: number;
}

interface PreparedSearch {
	engine: Engine;
	engineOpts: EngineSearchOptions;
	timer: Timer;
	query: string;
	queryExplanation: string;
}

/**
 * The half of _search/_search_engine that runs before the engine: parameter
 * validation, parse, and the wire tree. Throws SearchBadRequest for
 * parse/limit/fields problems and lets EngineUnavailableError from getEngine()
 * propagate (503 at dispatch).
 */
async function prepareSearch(ctx: RouteContext, opts: RunSearchOptions): Promise<PreparedSearch> {
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

	return {
		engine,
		queryExplanation: query ? explainWireTree(filterTree) : "",
		engineOpts: {
			filterTreeJson: canonicalStringify(filterTree as FilterValue),
			unique: opts.unique,
			prefer: opts.prefer,
			orderby: opts.orderby,
			direction: opts.direction,
			// limit=None means "no limit"; the engine requires an int (upstream parity)
			limit: limit !== null ? limit : 1_000_000,
			fields: resolvedFields,
		},
		timer,
		query,
	};
}

/**
 * DELIBERATE DEVIATION from upstream, restored: upstream falls back to SQL when
 * the engine throws on a query it was handed. This port has no SQL to fall back
 * to — the wasm engine is the only query path — so an engine failure is a loud
 * 500 rather than a silently different answer.
 */
function engineFailure(query: string, err: unknown): never {
	if (err instanceof EngineUnavailableError) throw err;
	throw new EngineQueryError(`Engine query failed for ${JSON.stringify(query)}`, { cause: err });
}

function metadataFor(prep: PreparedSearch, totalCards: number): SearchMetadata {
	const timings = prep.timer.getTimings();
	return {
		compiled: "(rust engine)",
		inner_timings: timings,
		outer_timings: timings,
		params: {},
		query: prep.query,
		query_explanation: prep.queryExplanation,
		total_cards: totalCards,
	};
}

/**
 * Port of _search/_search_engine, returning the envelope as DATA — for the
 * server-rendered page, which reads the rows to build HTML. The JSON API uses
 * runSearchJson instead, which never materializes them.
 */
export async function runSearch(ctx: RouteContext, opts: RunSearchOptions): Promise<SearchEnvelope> {
	const prep = await prepareSearch(ctx, opts);
	let totalCards: number;
	let rawCards: CardRow[];
	try {
		const result = await prep.timer.time("engine_query", () => prep.engine.search(prep.engineOpts));
		totalCards = result.totalCards;
		rawCards = result.cards;
	} catch (err) {
		engineFailure(prep.query, err);
	}
	const cards = prep.timer.time("engine_collect", () => [...rawCards]);
	return { cards, ...metadataFor(prep, totalCards) };
}

/**
 * The same search, returning the envelope as JSON TEXT.
 *
 * The engine hands back `cards` already encoded in the requested shape, and it
 * splices in here without ever being parsed: `cards` is the envelope's first
 * key upstream, so the bytes are identical to JSON.stringify({cards, ...rest})
 * — one encode, done in the Durable Object, where CPU is not metered against
 * the free plan's 10ms per request.
 */
export async function runSearchJson(ctx: RouteContext, opts: RunSearchOptions, shape: ResponseShape): Promise<string> {
	const prep = await prepareSearch(ctx, opts);
	let result: { totalCards: number; cardsJson: string };
	try {
		result = await prep.timer.time("engine_query", () => prep.engine.searchSerialized(prep.engineOpts, shape));
	} catch (err) {
		engineFailure(prep.query, err);
	}
	// Upstream's engine_collect span materialized the row list; nothing is
	// materialized here, but the span still has to appear in the timings tree.
	prep.timer.time("engine_collect", () => {});
	return `{"cards":${result.cardsJson},${JSON.stringify(metadataFor(prep, result.totalCards)).slice(1)}`;
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
		const body = await runSearchJson(
			ctx,
			{
				query: (bound.query as string | null) || (bound.q as string | null),
				orderby: bound.orderby as CardOrdering,
				direction: bound.direction as SortDirection,
				unique: bound.unique as UniqueOn,
				prefer: bound.prefer as PreferOrder,
				limit: bound.limit as number,
				fields: bound.fields as string[] | null,
			},
			bound.shape as ResponseShape,
		);
		return jsonResponseText(body, cache);
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
	// Pre-encoded next to the store, like /search — see runSearchJson.
	const result = await engine.samplePreferredSerialized(
		numCards,
		[...DEFAULT_RESULT_FIELDS],
		bound.shape as ResponseShape,
	);
	return jsonResponseText(`{"cards":${result.cardsJson},"total_cards":${result.totalCards}}`, NO_STORE_HEADER);
}
