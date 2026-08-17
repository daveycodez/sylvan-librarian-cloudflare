// Port of the /search and /random_search routes and the _search core
// (api_resource.py:1091-1321, 2555-2586).
//
// Engine-only: the wasm engine is the sole query path. Upstream sends a query
// the engine throws on to SQL; this port has no SQL, so an engine failure is a
// loud 500 and an empty/unloaded store is an EngineUnavailableError (dispatch
// answers 503) — never a silent empty result.

import { encodeUtf8, jsonBytesResponse } from "../engine/bytes";
import type { Engine, EngineSearchOptions, EngineSerializedResult } from "../engine/types";
import { EngineUnavailableError } from "../engine/types";
import type { DirectiveFound, FilterValue } from "../parser";
import { canonicalStringify } from "../parser";
import type { CardOrdering, PreferOrder, ResponseShape, SortDirection, UniqueOn } from "./enums";
import {
	CARD_ORDERING,
	DIRECTIVE_TABLES,
	PREFER_ORDER,
	RESPONSE_SHAPE,
	resolveDirection,
	SORT_DIRECTION,
	UNIQUE_ON,
} from "./enums";
import { explainWireTree } from "./explanation";
import { applyExtrasGate, type ExtrasGateSpellings } from "./extras-gate";
import { httpError, NO_STORE_HEADER, searchCacheHeader } from "./http";
import type { CardRow } from "./noscript";
import { bindParams, enumParam, intParam, pyRepr, strListParam, strParam } from "./param-binding";
import { loadParser } from "./parser-bridge";
import { arithmeticNotComparedMessage, usesValueAsPredicate } from "./query-validation";
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
	// upstream #913. The two currencies `orderby=` already sorts by: without these a caller can
	// rank a page by EUR or TIX and then have no way to read the number it was ranked on. Same
	// DEFAULT_RESULT_FIELDS exclusion as the #877 names below, for the same reason.
	"price_eur",
	"price_tix",
	"prefer_score",
	// upstream #877. NOT added to DEFAULT_RESULT_FIELDS: `fields=None` resolves against Rust's
	// DEFAULT_FIELDS, which is ungated and live here, so a name there that JSON_FIELD_TABLE does
	// not carry would make every default /search 500 rather than just rejecting one field.
	"layout",
	"cmc",
	"rarity",
	"color_identity",
	"legalities",
	// upstream #912: the printed loyalty, off the card — a base field like power/toughness now
	// that `planeswalker_loyalty_text_id` is a card column matching upstream's.
	"loyalty",
];

// Pagination default: offset 0 everywhere it appears, extracted so the route
// and the internal search default can never drift apart (upstream DEFAULT_OFFSET).
export const DEFAULT_OFFSET = 0;

// `fields=None` resolves to these. Upstream's DEFAULT_RESULT_FIELDS is the first
// nine.
//
// DELIBERATE DEVIATION: `scryfall_id` is this port's tenth. Card images here come
// from Scryfall's CDN rather than upstream's CloudFront mirror (see
// noscript.ts's buildImageUrl), and Scryfall's image path is a pure function of
// the card's id — so without the id in the default response, neither the no-JS
// render nor app.js can build an image URL at all.
//
// It has to be a DEFAULT rather than something the page asks for explicitly:
// `/random_search` accepts only `num_cards` and `shape` (RANDOM_SEARCH_SPEC), so
// there is no `fields` parameter for the front page to pass. Adding one would be
// a wider deviation than adding the field.
//
// Safe to add because `scryfall_id` is already in JSON_FIELD_TABLE — the live,
// non-pyo3 table in core_api.rs. A name in the defaults WITHOUT a twin there is
// what breaks every default search; that is why #877's five fields are in
// RESULT_FIELD_NAMES but not here.
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
	"scryfall_id",
];

/** The four search parameters a directive can set. */
interface DirectiveTargets {
	unique: UniqueOn;
	prefer: PreferOrder;
	orderby: CardOrdering;
	direction: SortDirection;
}

/**
 * Fold in-query directives over the query parameters (upstream #893).
 *
 * Scryfall's semantics, which upstream measured: a directive OVERRIDES its query
 * parameter (so `sort:name` beats the order dropdown), the LAST repeat wins, and
 * an unknown value warns and is ignored rather than failing the search — a typo
 * in one directive should not cost the user their results.
 *
 * A nested directive also warns. It still applies to the whole search, because
 * that is all a directive can do; the warning exists because writing it inside
 * an OR or a negation makes it LOOK scoped.
 */
export function applyDirectives(
	directives: readonly DirectiveFound[],
	base: DirectiveTargets,
): DirectiveTargets & { warnings: string[] } {
	const out: DirectiveTargets & { warnings: string[] } = { ...base, warnings: [] };
	for (const { name, value, nested } of directives) {
		const spec = DIRECTIVE_TABLES.get(name);
		if (spec === undefined) {
			continue; // unreachable: the parser only produces DIRECTIVE_NAMES
		}
		const resolved = spec.table.get(value);
		if (resolved === undefined) {
			out.warnings.push(`Ignored unknown ${spec.label} ${pyRepr(value)} in ${name}:${value}.`);
			continue;
		}
		if (nested) {
			out.warnings.push(`${name}:${value} applies to the whole search, not just the group it appears in.`);
		}
		// Each table only ever yields values valid for its own parameter, which the
		// type system cannot see through the name->table indirection.
		(out as unknown as Record<string, unknown>)[spec.param] = resolved;
	}
	return out;
}

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

/** Upstream _validate_offset; like validateLimit, the non-int branch is unreachable over HTTP. */
export function validateOffset(offset: number): number {
	if (offset < 0) {
		throw new SearchBadRequest("Invalid Offset", "Offset must be a non-negative integer.");
	}
	return offset;
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
	/** Directive warnings, absent when there are none (upstream #893). */
	warnings?: string[];
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
	/** Results to skip, in the query's sort order. Defaults to DEFAULT_OFFSET (0). */
	offset?: number;
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
	warnings?: string[];
}

interface PreparedSearch {
	engine: Engine;
	warnings: string[];
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
	const offset = validateOffset(opts.offset === undefined ? DEFAULT_OFFSET : opts.offset);
	const resolvedFields = resolveResultFields(opts.fields ?? null);

	const timer = new Timer();
	const query = opts.query || "";
	const parser = await loadParser();
	let filterTree: unknown;
	let directives: readonly DirectiveFound[] = [];
	// Out of band from the tree, for the extras gate: the rewrite erases both the `field:/regex/`
	// spelling and the `is:split` -> `layout:split` expansion, and Scryfall's auto-enable reads
	// what was WRITTEN. See extras-gate.ts.
	let spellings: ExtrasGateSpellings = { loweredRegexTerms: [], expandedDerivedTerms: [] };
	try {
		const parsed = timer.time("parse", () => parser.parseWithDirectives(query));
		filterTree = parsed.tree;
		directives = parsed.directives;
		spellings = {
			loweredRegexTerms: parsed.loweredRegexTerms,
			expandedDerivedTerms: parsed.expandedDerivedTerms,
		};
	} catch (err) {
		if (parser.isParseError(err)) {
			throw new SearchBadRequest("Invalid Search Query", `Failed to parse query: "${query}"`);
		}
		throw err;
	}
	// Parsed, but not a filter: `1` and `cmc-power` are legal arithmetic with nothing to evaluate as a
	// question. Rejected HERE rather than in the parser, whose trees are pinned byte-identical to
	// upstream's for exactly these inputs — see query-validation.ts.
	if (usesValueAsPredicate(filterTree)) {
		throw new SearchBadRequest("Invalid Search Query", arithmeticNotComparedMessage(query));
	}

	// The EXPLANATION describes the query the user typed, so it is taken before the gate wraps the
	// tree — "the name contains Bolt" and not "…and it is not an extra and it is not a variation".
	const queryExplanation = query ? explainWireTree(filterTree) : "";

	// SCRYFALL'S TWO DEFAULT-LANE EXCLUSIONS, shared with `/cards/search` — see extras-gate.ts.
	//
	// THIS ROUTE HAD NO EXTRAS HANDLING AT ALL, and did not need any while the store was built from
	// the `default_cards` bulk: that dump carries no art-series printings, so there was nothing to
	// exclude. `all_cards` carries 2,650, and `q=lightning bolt` started answering astx/76
	// ("Lightning Bolt // Lightning Bolt", a Strixhaven Art Series card) alongside the two printings
	// `/cards/search` and api.scryfall.com both answer. A latent gap the corpus made visible.
	//
	// NO PARAMETERS ARE PASSED because this route has none: `/search` is the web UI, not a Scryfall
	// mirror, so the rule reduces to "exclude unless the query itself triggers". Every trigger still
	// works — `is:extra`, `t:token`, `layout:…`, `wm:`, `a:`, `border:silver`, a set that holds an
	// extra, and `is:variation` for the other gate — because they are properties of the QUERY.
	//
	// VARIATIONS ARE GATED TOO, deliberately. Scryfall excludes them by default and `/cards/search`
	// measured that and matches it; a variation is by definition a second printing of a card that is
	// still in the results under its ordinary printing, so nothing becomes unfindable. Gating one
	// and not the other would mean the site's own search and the site's own Scryfall-compatible
	// search disagreed about the same query — which is exactly the bug above, in the other half.
	const gated = await applyExtrasGate(engine, filterTree, spellings);
	filterTree = gated.tree;

	// Fold the in-query directives BEFORE resolveDirection, which is the last
	// point at which orderby is final — `dir:auto` has to resolve against the
	// ordering a `sort:` directive may just have changed.
	const folded = applyDirectives(directives, {
		unique: opts.unique,
		prefer: opts.prefer,
		orderby: opts.orderby,
		direction: opts.direction,
	});

	return {
		engine,
		queryExplanation,
		warnings: folded.warnings,
		engineOpts: {
			filterTreeJson: canonicalStringify(filterTree as FilterValue),
			unique: folded.unique,
			prefer: folded.prefer,
			orderby: folded.orderby,
			// Resolved HERE, not at coercion: the engine has no `auto` arm, so an unresolved
			// direction would fall through to its default and sort wrongly rather than failing.
			// This is also the last point at which `orderby` is final — anything that can still
			// change it (in-query directives, upstream #893) must fold before this line.
			direction: resolveDirection(folded.direction, folded.orderby),
			// limit=None means "no limit"; the engine requires an int (upstream parity)
			limit: limit !== null ? limit : 1_000_000,
			offset,
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
		// Only present when a directive said something worth reporting: an unknown
		// value that was ignored, or one written inside a group where it looks
		// scoped but is not. Omitted entirely otherwise, so a query without
		// directives has the envelope it always had.
		...(prep.warnings.length > 0 ? { warnings: prep.warnings } : {}),
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
		const result = await prep.timer.time("engine_query", () => prep.engine.searchCardsAsObjects(prep.engineOpts));
		totalCards = result.totalCards;
		rawCards = result.cards;
	} catch (err) {
		engineFailure(prep.query, err);
	}
	const cards = prep.timer.time("engine_collect", () => [...rawCards]);
	return { cards, ...metadataFor(prep, totalCards) };
}

/**
 * The same search, returning the envelope as UTF-8 BYTES.
 *
 * The engine hands back `cards` already encoded in the requested shape, and it
 * splices in here without ever being parsed: `cards` is the envelope's first
 * key upstream, so the bytes are identical to JSON.stringify({cards, ...rest})
 * — one encode, done in the Durable Object, where CPU is not metered against
 * the free plan's 10ms per request.
 *
 * Bytes rather than a string, because a string here would undo that. The rows
 * arrive as bytes; interpolating them into a template literal would decode the
 * whole payload to UTF-16, and building the Response would encode it back. Two
 * passes over a payload that can be a megabyte, both on the metered side.
 */
export async function runSearchJson(
	ctx: RouteContext,
	opts: RunSearchOptions,
	shape: ResponseShape,
): Promise<Uint8Array[]> {
	const prep = await prepareSearch(ctx, opts);
	let result: EngineSerializedResult;
	try {
		result = await prep.timer.time("engine_query", () => prep.engine.searchCardsAsJson(prep.engineOpts, shape));
	} catch (err) {
		engineFailure(prep.query, err);
	}
	// Upstream's engine_collect span materialized the row list; nothing is
	// materialized here, but the span still has to appear in the timings tree.
	prep.timer.time("engine_collect", () => {});
	// The metadata is built AFTER the query, so its timings tree includes the
	// spans above — which is why this cannot be encoded before the payload.
	const tail = JSON.stringify(metadataFor(prep, result.totalCards)).slice(1);
	return [encodeUtf8('{"cards":'), result.cardsBytes, encodeUtf8(`,${tail}`)];
}

// Keyword parameters of search(), in signature order (binding reports the
// first failing parameter in this order, like upstream's ParamBinder plan).
const SEARCH_SPEC = [
	{ name: "direction", converter: enumParam(SORT_DIRECTION), default: "asc" },
	{ name: "fields", converter: strListParam(), default: null },
	{ name: "limit", converter: intParam(), default: 100 },
	{ name: "offset", converter: intParam(), default: DEFAULT_OFFSET },
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
				offset: bound.offset as number,
				fields: bound.fields as string[] | null,
			},
			bound.shape as ResponseShape,
		);
		return jsonBytesResponse(body, cache);
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
	const result = await engine.randomCardsAsJson(numCards, [...DEFAULT_RESULT_FIELDS], bound.shape as ResponseShape);
	return jsonBytesResponse(
		[encodeUtf8('{"cards":'), result.cardsBytes, encodeUtf8(`,"total_cards":${result.totalCards}}`)],
		NO_STORE_HEADER,
	);
}
