// The Scryfall-compatible `/cards/*` routes. Port of api/scryfall_compat/routes.py (upstream #912).
//
// The point of this surface is that mtg-seeker can change one base URL and stop talking to
// api.scryfall.com. `/search` is untouched and keeps this project's own response shape; everything
// here answers with Scryfall's objects, Scryfall's 175-per-page pagination and Scryfall's error
// bodies.
//
// Two deliberate deviations from upstream run through the whole file:
//
//   - **No SQL fallback.** Upstream tries the engine and falls back to Postgres, distinguishing
//     "the engine could not serve" from "no such card" via an `_EngineMiss` sentinel. This
//     deployment has no Postgres, so there is no second branch to select: a miss IS the 404, an
//     engine failure IS a 500, and the sentinel has no counterpart. Recorded in the README.
//   - **Rulings come out of KV, not out of the engine.** Upstream loads them into `magic.rulings`
//     (`api/rulings_import.py`) and selects by `oracle_id`. Here the nightly import publishes them
//     as 256 KV buckets of pre-rendered Ruling objects (src/engine/rulings-kv.ts) and THIS ISOLATE
//     reads one bucket and slices one card's rulings out of it as bytes. It is the only `/cards/*`
//     answer the Durable Object has no part in, because it is the only one that needs no card
//     object assembled — just the right bytes.
//
// Every card object is built inside the Durable Object (see the Engine interface): `toScryfallCard`
// assembles ~70 keys per card, up to 175 of them for a page, and the DO meters against 30s where
// this isolate meters against 10ms.

import { encodeUtf8 } from "../../engine/bytes";
import { RulingsFormatError, rulingsBucketKey, rulingsBucketOf, rulingsSlice } from "../../engine/rulings-kv";
import type { Engine, EngineSerializedResult } from "../../engine/types";
import { EngineUnavailableError } from "../../engine/types";
import type { FilterValue } from "../../parser";
import { canonicalStringify } from "../../parser";
import { foldAccents } from "../../parser/pystr";
import type { CardOrdering, SortDirection, UniqueOn } from "../enums";
import { CARD_ORDERING, resolveDirection } from "../enums";
import { NO_STORE_HEADER } from "../http";
import { loadParser } from "../parser-bridge";
import type { RouteContext } from "../registry";
import {
	badRequestError,
	buildPageUrl,
	cardList,
	cardToText,
	catalogObject,
	DEFAULT_IMAGE_VERSION,
	errorObject,
	imageUri,
	MAX_AUTOCOMPLETE_VALUES,
	MAX_COLLECTION_IDENTIFIERS,
	notFoundError,
	PAGE_SIZE,
	type ScryfallError,
} from "./objects";
import { asBool, scryfallJson, scryfallListJson } from "./respond";
import { cardName, setAndCollectorNumber, TRUE_TREE } from "./trees";

/** Path segments that name an external id namespace rather than a set code. */
const EXTERNAL_ID_NAMESPACES = ["multiverse", "mtgo", "arena", "tcgplayer", "cardmarket"] as const;

/**
 * Scryfall's `unique` vocabulary. This port's own spellings differ (`card`/`printing`/`artwork`
 * against Scryfall's `cards`/`prints`/`art`), so the mapping is explicit rather than derived.
 */
const UNIQUE_MAP: Record<string, UniqueOn> = { cards: "card", art: "artwork", prints: "printing" };

/**
 * Scryfall's `order` vocabulary, derived from CARD_ORDERING rather than listed — an ordering added
 * to the enum is accepted here without a second edit.
 */
const ORDER_MAP: Map<string, CardOrdering> = new Map(CARD_ORDERING.values.map((m) => [m, m]));

/**
 * The two Scryfall orders with no counterpart. `penny` needs penny_rank as a sort column (it is
 * stored, but in the residue archive, which carries no sort permutations); `review` is
 * Scryfall-internal with no public input and is not reproducible at all. Both fall back to `name`,
 * which is what Scryfall does with an order it does not recognize, and add a warning saying so.
 */
const SCRYFALL_ONLY_ORDERS = ["penny", "review"];

const DIRECTION_MAP: Record<string, SortDirection> = { asc: "asc", desc: "desc", auto: "auto" };

/** Scryfall's own wording, down to the typographic apostrophe, so a client that string-matches on
 * `details` behaves the same. */
const NO_MATCH_DETAILS =
	"Your query didn’t match any cards. Adjust your search terms or refer to the syntax guide " +
	"at https://scryfall.com/docs/syntax";
const EMPTY_QUERY_DETAILS = "You didn't enter anything to search for.";

/** Upstream's generic not-found body, reused for every path that addresses nothing. */
const NOT_FOUND_DETAILS =
	"The requested object or REST method was not found. Please double-check your URI and try again.";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ─── cache tiers ─────────────────────────────────────────────────────────────
//
// api.scryfall.com's own, measured against it rather than guessed:
//
//   /cards/search, /cards/:id, /cards/:set/:number, /cards/:ns/:id, /cards/autocomplete
//                                     public, max-age=57600      (16 hours)
//   /cards/named, INCLUDING its 404   public, max-age=172800     (48 hours)
//   /cards/random                     no-cache
//   POST /cards/collection            max-age=0, private, must-revalidate
//
// Matched, because cache behaviour is part of what a client observes and this surface exists so
// mtg-seeker can change one base URL and nothing else. Note these are Scryfall's, NOT /search's
// `max-age=90, stale-while-revalidate=86400`: /search answers this project's own shape to its own
// frontend, and the two surfaces have no reason to agree.
//
// ONE DEVIATION: `named` gets the SAME 16 hours as everything else, not Scryfall's 48. A card
// object embeds `prices` and this deployment rebuilds its store once a night, so no cached
// response should outlive the data it was built from by more than one import cycle — 48 hours
// lets a client hold prices from two imports ago with nothing in the response to say so. And
// `named` returns the same card object every other route here does, so there was never a reason
// for it to be the one route with a different lifetime.
//
// The tier rides on ERROR responses too, which is Scryfall's behaviour as well — an empty-query
// 400 comes back with the route's own max-age, and a `named` miss with the route's own tier.
//
// NOT matched: Scryfall's `Vary: Accept`. Its responses negotiate on the header; ours select their
// format from the `format=` query parameter, which is already part of the cache key. Sending it
// would split the edge cache per Accept value and buy nothing.
const CARDS_CACHE: Record<string, string> = { "Cache-Control": "public, max-age=57600" };
/** Not `no-store`: Scryfall sends `no-cache`, which permits storing and requires revalidation. */
const RANDOM_CACHE: Record<string, string> = { "Cache-Control": "no-cache" };
const COLLECTION_CACHE: Record<string, string> = { "Cache-Control": "max-age=0, private, must-revalidate" };

function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** Parse an integer parameter or path segment; undefined when absent or unparseable. */
function asInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number.parseInt(value.trim(), 10);
	return Number.isNaN(n) ? undefined : n;
}

function textResponse(body: string, contentType: string, cache: Record<string, string>): Response {
	return new Response(body, { status: 200, headers: { "content-type": contentType, ...cache } });
}

/** Emit one card in the requested format: json, text, or a redirect to its image. */
function renderCard(
	card: Record<string, unknown>,
	format: string,
	face: string,
	version: string,
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	if (format === "text") return textResponse(cardToText(card), "text/plain; charset=utf-8", cache);
	if (format === "image") {
		const location = imageUri(card, version, face);
		if (!location) {
			return scryfallJson(notFoundError("No image is available for this card in that version."), pretty, cache);
		}
		// The redirect carries the tier too: the Location is a pure function of the card's id, so
		// an uncached 302 would be a Worker invocation per image load.
		return new Response(null, { status: 302, headers: { Location: location, ...cache } });
	}
	return scryfallJson(card, pretty, cache);
}

/** The absolute URL of a route on this host, for `next_page`. */
function selfBaseUrl(ctx: RouteContext, path: string): string {
	const url = new URL(ctx.request.url);
	// The request's own scheme as corrected by the proxy that terminated TLS: a `next_page` a
	// client cannot follow is worse than no pagination at all.
	const scheme = ctx.request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	return `${scheme}://${ctx.requestHost || url.host}${path}`;
}

/** The base URL every derived `*_uri` in a card object addresses. */
function apiBaseUrl(ctx: RouteContext): string {
	const url = new URL(ctx.request.url);
	const scheme = ctx.request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	return `${scheme}://${ctx.requestHost || url.host}`;
}

/**
 * Engine failures are LOUD.
 *
 * Upstream falls back to SQL here. This port has none, so an engine that cannot answer must say
 * so rather than 404 — a 404 would tell the client the card does not exist, which is a different
 * and false statement. EngineUnavailableError propagates to dispatch's 503; anything else is a 500
 * in Scryfall's error shape so the client still gets a body it can parse.
 */
function engineFailure(err: unknown, pretty: boolean): Response {
	if (err instanceof EngineUnavailableError) throw err;
	console.error("Scryfall compat route: engine failure", err);
	// `no-store`, NOT the route's tier. Every other status here is deterministic in the URL and
	// safe to cache for hours, but a 500 means the engine failed on this attempt -- caching that
	// alongside the answers would pin a transient outage into every edge for 16 hours.
	return scryfallJson(
		errorObject("internal_error", 500, "The card engine could not answer this request."),
		pretty,
		NO_STORE_HEADER,
	);
}

// ─── GET /cards/search ───────────────────────────────────────────────────────

export async function cardsSearchHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const q = params.q;
	if (!q?.trim()) return scryfallJson(badRequestError(EMPTY_QUERY_DETAILS), pretty, CARDS_CACHE);

	// `|| 1` would swallow page=0 into page=1; an unparseable page defaults, a non-positive one is
	// rejected.
	const page = asInt(params.page) ?? 1;
	if (page < 1)
		return scryfallJson(badRequestError("The page parameter must be a positive integer."), pretty, CARDS_CACHE);

	const warnings: string[] = [];
	const uniqueRaw = (params.unique ?? "cards").toLowerCase();
	let unique = UNIQUE_MAP[uniqueRaw];
	if (unique === undefined) {
		warnings.push(`Unrecognized unique mode '${uniqueRaw}'; rolled up by card instead.`);
		unique = "card";
	}

	const orderRaw = (params.order ?? "name").toLowerCase();
	let orderby = ORDER_MAP.get(orderRaw);
	if (orderby === undefined) {
		warnings.push(
			SCRYFALL_ONLY_ORDERS.includes(orderRaw)
				? `This server cannot sort by '${orderRaw}' yet; sorted by name instead.`
				: `Unrecognized order '${orderRaw}'; sorted by name instead.`,
		);
		orderby = "name";
	}

	// An unrecognized direction falls back to AUTO, which is also the default — Scryfall ignores
	// one it does not know rather than erroring.
	const direction = DIRECTION_MAP[(params.dir ?? "auto").toLowerCase()] ?? "auto";

	const engine = await ctx.getEngine();
	const parser = await loadParser();
	let filterTree: unknown;
	try {
		filterTree = parser.parseWithDirectives(q).tree;
	} catch (err) {
		if (parser.isParseError(err)) {
			return scryfallJson(badRequestError(`Failed to parse query: "${q}"`, warnings), pretty, CARDS_CACHE);
		}
		throw err;
	}

	let result: EngineSerializedResult;
	try {
		result = await engine.scryfallSearch(
			{
				filterTreeJson: canonicalStringify(filterTree as FilterValue),
				unique,
				prefer: "default",
				orderby,
				direction: resolveDirection(direction, orderby),
				limit: PAGE_SIZE,
				offset: (page - 1) * PAGE_SIZE,
				fields: [],
			},
			apiBaseUrl(ctx),
		);
	} catch (err) {
		return engineFailure(err, pretty);
	}

	// rowCount rather than inspecting the encoded bytes for "[]" — the engine counted the rows.
	if (result.rowCount === 0) {
		return scryfallJson(errorObject("not_found", 404, NO_MATCH_DETAILS, warnings), pretty, CARDS_CACHE);
	}

	const seen = (page - 1) * PAGE_SIZE + result.rowCount;
	const hasMore = seen < result.totalCards;
	const nextPage = hasMore
		? buildPageUrl(
				selfBaseUrl(ctx, "/cards/search"),
				{
					dir: params.dir ?? "auto",
					format: params.format ?? "json",
					include_extras: String(asBool(params.include_extras)),
					include_multilingual: String(asBool(params.include_multilingual)),
					include_variations: String(asBool(params.include_variations)),
					order: params.order ?? "name",
					q,
					unique: params.unique ?? "cards",
				},
				page + 1,
			)
		: undefined;

	return scryfallListJson(
		result.cardsBytes,
		{ totalCards: result.totalCards, hasMore, nextPage, warnings },
		pretty,
		CARDS_CACHE,
	);
}

// ─── GET /cards/named ────────────────────────────────────────────────────────

export async function cardsNamedHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const exact = params.exact;
	const fuzzy = params.fuzzy;
	if (!exact && !fuzzy) {
		return scryfallJson(badRequestError("You must provide a fuzzy or exact name parameter."), pretty, CARDS_CACHE);
	}
	const format = (params.format ?? "json").toLowerCase();
	const face = params.face ?? "front";
	const version = params.version ?? DEFAULT_IMAGE_VERSION;
	const setCode = params.set ?? "";
	const engine = await ctx.getEngine();
	const baseUrl = apiBaseUrl(ctx);

	if (exact) {
		// Folded here, matched against the stored `card_name_folded` — Scryfall's exact match
		// ignores case AND diacritics, and resolves a single face of a "Front // Back" card.
		let card: Record<string, unknown> | null;
		try {
			card = await engine.scryfallExactName(foldAccents(exact.trim().toLowerCase()), setCode, baseUrl);
		} catch (err) {
			return engineFailure(err, pretty);
		}
		if (!card) return scryfallJson(notFoundError(`No cards found matching “${exact}”`), pretty, CARDS_CACHE);
		return renderCard(card, format, face, version, pretty, CARDS_CACHE);
	}

	return namedFuzzy(engine, fuzzy ?? "", setCode, baseUrl, { format, face, version, pretty });
}

/**
 * Resolve a fuzzy name: exact, then all-words-present, then typo-tolerant similarity.
 *
 * The three stages mirror what Scryfall resolves in practice — `lightning bolt` exactly, `bolt` by
 * containment, `lighning bolt` by trigram distance — and each stage that finds more than one
 * distinct card name reports `ambiguous` rather than guessing between them.
 */
async function namedFuzzy(
	engine: Engine,
	fuzzy: string,
	setCode: string,
	baseUrl: string,
	render: { format: string; face: string; version: string; pretty: boolean },
): Promise<Response> {
	const { pretty } = render;
	const needle = foldAccents(fuzzy.trim().toLowerCase());
	const words = needle.split(/[^\w']+/u).filter((w) => w.length > 0);
	if (words.length === 0) {
		return scryfallJson(badRequestError("You must provide a fuzzy or exact name parameter."), pretty, CARDS_CACHE);
	}

	try {
		const exactHit = await engine.scryfallExactName(needle, setCode, baseUrl);
		if (exactHit) return renderCard(exactHit, render.format, render.face, render.version, pretty, CARDS_CACHE);

		// Two is all it takes to tell "one match" from "ambiguous"; asking for more would scan the
		// same corpus to throw the rest away.
		const contained = await engine.scryfallNamesContaining(words, setCode, 2, baseUrl);
		if (contained.length > 1) return ambiguous(fuzzy, pretty);
		const only = contained[0];
		if (only) return renderCard(only, render.format, render.face, render.version, pretty, CARDS_CACHE);

		const { status, card } = await engine.scryfallFuzzyName(needle, baseUrl);
		if (status === "ambiguous") return ambiguous(fuzzy, pretty);
		if (status === "hit" && card)
			return renderCard(card, render.format, render.face, render.version, pretty, CARDS_CACHE);
	} catch (err) {
		return engineFailure(err, pretty);
	}
	return scryfallJson(notFoundError(`No cards found matching “${fuzzy}”`), pretty, CARDS_CACHE);
}

function ambiguous(name: string, pretty: boolean): Response {
	return scryfallJson(
		errorObject(
			"ambiguous",
			404,
			`Too many cards match ambiguous name “${name}”. Add more words to refine your search.`,
		),
		pretty,
		CARDS_CACHE,
	);
}

// ─── GET /cards/autocomplete ─────────────────────────────────────────────────

export async function cardsAutocompleteHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const needle = (params.q ?? "").trim();
	// Scryfall answers an empty catalog below two characters rather than scanning for one letter.
	if (needle.length < 2) return scryfallJson(catalogObject([]), pretty, CARDS_CACHE);
	const engine = await ctx.getEngine();
	try {
		const names = await engine.scryfallAutocomplete(needle, MAX_AUTOCOMPLETE_VALUES);
		return scryfallJson(catalogObject(names), pretty, CARDS_CACHE);
	} catch (err) {
		return engineFailure(err, pretty);
	}
}

// ─── GET /cards/random ───────────────────────────────────────────────────────

export async function cardsRandomHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const format = (params.format ?? "json").toLowerCase();
	const engine = await ctx.getEngine();
	const baseUrl = apiBaseUrl(ctx);
	const q = params.q;

	let filterTreeJson = TRUE_TREE;
	if (q?.trim()) {
		const parser = await loadParser();
		try {
			filterTreeJson = canonicalStringify(parser.parseWithDirectives(q).tree as FilterValue);
		} catch (err) {
			if (parser.isParseError(err)) {
				return scryfallJson(badRequestError(`Failed to parse query: "${q}"`), pretty, RANDOM_CACHE);
			}
			throw err;
		}
	}

	try {
		// Two passes, like upstream: count, then take one card at a random offset. A sort over the
		// whole match set to keep one row would be the alternative, and it is strictly worse.
		const counted = await engine.scryfallSearch(
			{
				filterTreeJson,
				unique: "card",
				prefer: "default",
				orderby: "name",
				direction: "asc",
				limit: 1,
				offset: 0,
				fields: [],
			},
			baseUrl,
		);
		if (counted.totalCards === 0) return scryfallJson(notFoundError(NO_MATCH_DETAILS), pretty, RANDOM_CACHE);

		const offset = Math.floor(Math.random() * counted.totalCards);
		const drawn = await engine.scryfallSearch(
			{
				filterTreeJson,
				unique: "card",
				prefer: "default",
				orderby: "name",
				direction: "asc",
				limit: 1,
				offset,
				fields: [],
			},
			baseUrl,
		);
		// The one place this surface genuinely needs the card as an object: /cards/random reshapes a
		// single card into text or an image redirect. One card, so decoding it costs nothing that
		// matters -- unlike a 175-card page, which is why the list routes never do this.
		const cards = JSON.parse(new TextDecoder().decode(drawn.cardsBytes)) as Record<string, unknown>[];
		const card = cards[0];
		if (!card) return scryfallJson(notFoundError(NO_MATCH_DETAILS), pretty, RANDOM_CACHE);
		// RANDOM_CACHE carries Scryfall's `no-cache` -- a cached random card is one card forever,
		// and every draw has to reach the engine.
		return renderCard(
			card,
			format,
			params.face ?? "front",
			params.version ?? DEFAULT_IMAGE_VERSION,
			pretty,
			RANDOM_CACHE,
		);
	} catch (err) {
		return engineFailure(err, pretty);
	}
}

// ─── POST /cards/collection ──────────────────────────────────────────────────

export async function cardsCollectionHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	let body: unknown;
	try {
		body = await ctx.request.json();
	} catch {
		body = null;
	}
	const identifiers = (body as { identifiers?: unknown } | null)?.identifiers;
	if (!Array.isArray(identifiers)) {
		return scryfallJson(
			errorObject("validation_error", 422, "The request body must be a JSON object with an `identifiers` array."),
			pretty,
			COLLECTION_CACHE,
		);
	}
	if (identifiers.length > MAX_COLLECTION_IDENTIFIERS) {
		return scryfallJson(
			errorObject(
				"validation_error",
				422,
				`A maximum of ${MAX_COLLECTION_IDENTIFIERS} card references may be submitted at once.`,
			),
			pretty,
			COLLECTION_CACHE,
		);
	}

	const engine = await ctx.getEngine();
	const baseUrl = apiBaseUrl(ctx);
	try {
		const resolved = await resolveIdentifiers(engine, identifiers, baseUrl);
		const found: Record<string, unknown>[] = [];
		const notFound: unknown[] = [];
		const seen = new Set<string>();
		for (let at = 0; at < identifiers.length; at++) {
			const card = resolved[at];
			if (!card) {
				notFound.push(identifiers[at]);
				continue;
			}
			const id = String(card.id);
			if (seen.has(id)) continue;
			seen.add(id);
			found.push(card);
		}
		return scryfallJson(cardList(found, { notFound }), pretty, COLLECTION_CACHE);
	} catch (err) {
		return engineFailure(err, pretty);
	}
}

/**
 * Resolve every collection identifier, batching by kind.
 *
 * Batched rather than looped because each lookup is a Durable Object RPC: 75 identifiers resolved
 * one at a time would be 75 round trips. Every kind that is a query becomes a filter tree here and
 * goes over in one call; the id-shaped kinds go over in one call each.
 */
async function resolveIdentifiers(
	engine: Engine,
	identifiers: unknown[],
	baseUrl: string,
): Promise<(Record<string, unknown> | null)[]> {
	const out: (Record<string, unknown> | null)[] = new Array(identifiers.length).fill(null);
	const byScryfallId: { at: number; id: string }[] = [];
	const byTree: { at: number; tree: string }[] = [];
	// The remaining kinds each need their own engine entry point, so they are gathered per kind
	// and awaited together rather than serialized.
	const singles: Promise<void>[] = [];

	for (let at = 0; at < identifiers.length; at++) {
		const ident = identifiers[at];
		if (typeof ident !== "object" || ident === null) continue;
		const id = ident as Record<string, unknown>;
		const put = (p: Promise<Record<string, unknown> | null>) => {
			singles.push(
				p.then((card) => {
					out[at] = card;
				}),
			);
		};

		if (typeof id.id === "string" && isUuid(id.id)) {
			byScryfallId.push({ at, id: id.id });
		} else if (typeof id.oracle_id === "string" && isUuid(id.oracle_id)) {
			put(engine.scryfallCardByOracleId(id.oracle_id, baseUrl));
		} else if (typeof id.illustration_id === "string" && isUuid(id.illustration_id)) {
			put(engine.scryfallCardByIllustrationId(id.illustration_id, baseUrl));
		} else if (id.mtgo_id !== undefined) {
			const n = asInt(String(id.mtgo_id));
			if (n !== undefined) put(engine.scryfallCardByExternalId("mtgo", n, baseUrl));
		} else if (id.multiverse_id !== undefined) {
			const n = asInt(String(id.multiverse_id));
			if (n !== undefined) put(engine.scryfallCardByExternalId("multiverse", n, baseUrl));
		} else if (id.set !== undefined && id.collector_number !== undefined) {
			byTree.push({ at, tree: setAndCollectorNumber(String(id.set), String(id.collector_number)) });
		} else if (id.name !== undefined) {
			byTree.push({ at, tree: cardName(String(id.name), id.set === undefined ? undefined : String(id.set)) });
		}
	}

	if (byScryfallId.length > 0) {
		singles.push(
			engine
				.scryfallCardsByIds(
					byScryfallId.map((e) => e.id),
					baseUrl,
				)
				.then((cards) => {
					// The batch skips misses, so results are matched back BY ID rather than by position.
					const byId = new Map(cards.map((c) => [String(c.id).toLowerCase(), c]));
					for (const { at, id } of byScryfallId) out[at] = byId.get(id.toLowerCase()) ?? null;
				}),
		);
	}
	if (byTree.length > 0) {
		singles.push(
			engine
				.scryfallFirstOfEach(
					byTree.map((e) => e.tree),
					baseUrl,
				)
				.then((cards) => {
					for (let i = 0; i < byTree.length; i++) {
						const entry = byTree[i];
						if (entry) out[entry.at] = cards[i] ?? null;
					}
				}),
		);
	}

	await Promise.all(singles);
	return out;
}

// ─── GET /cards and /cards/... ───────────────────────────────────────────────

/**
 * Every `/cards/*` shape the five named sub-routes do not claim, dispatched by segment count:
 *
 *   - `/cards`                            every card, paginated
 *   - `/cards/:id`                        one card by Scryfall id
 *   - `/cards/:namespace/:id`             one card by multiverse/mtgo/arena/tcgplayer/cardmarket id
 *   - `/cards/:code/:number`              one card by set code and collector number
 *   - `/cards/:code/:number/:lang`        the same, in one language
 *   - `/cards/:id/rulings`, `/cards/:namespace/:id/rulings`, `/cards/:code/:number/rulings`
 *                                        that card's rulings, as a List of Ruling objects
 */
export async function cardsHandler(
	ctx: RouteContext,
	positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const [identifier = "", number = "", suffix = ""] = positionalArgs;

	if (!identifier) return allCardsPage(ctx, params, pretty);

	// The rulings variants address a card exactly the way every other shape here does, so the
	// segment is consumed and the rest resolved as a plain card address. The card still has to be
	// found: rulings for a card this deployment does not hold are Scryfall's 404, not an empty
	// list, which would be a claim about the card rather than about the corpus.
	const wantsRulings = number === "rulings" || suffix === "rulings";

	let card: Record<string, unknown> | null;
	try {
		card = await resolvePathCard(ctx, identifier, number, suffix, wantsRulings);
	} catch (err) {
		return engineFailure(err, pretty);
	}

	if (!card) return scryfallJson(notFoundError(NOT_FOUND_DETAILS), pretty, CARDS_CACHE);
	if (wantsRulings) return rulingsForCard(ctx, card, pretty);
	return renderCard(
		card,
		(params.format ?? "json").toLowerCase(),
		params.face ?? "front",
		params.version ?? DEFAULT_IMAGE_VERSION,
		pretty,
		CARDS_CACHE,
	);
}

/**
 * The card a `/cards/...` path addresses, or null when it addresses nothing — an unparseable id,
 * a language that is not the card's, or a genuine miss, all of which are the same 404.
 *
 * Split out because the rulings variants resolve their card through it too, which is upstream's
 * `_resolve_path_card` and matters for more than tidiness: the rulings routes accept exactly the
 * addressings the card routes do, and one resolver is what keeps that true.
 */
async function resolvePathCard(
	ctx: RouteContext,
	identifier: string,
	number: string,
	suffix: string,
	wantsRulings: boolean,
): Promise<Record<string, unknown> | null> {
	// Drop the trailing `rulings` so the rest reads as a plain card address. When it was the
	// SECOND segment the path was `/cards/:id/rulings`, and there is no third segment to keep.
	if (wantsRulings) {
		if (suffix === "rulings") suffix = "";
		else number = suffix = "";
	}

	const engine = await ctx.getEngine();
	const baseUrl = apiBaseUrl(ctx);

	if ((EXTERNAL_ID_NAMESPACES as readonly string[]).includes(identifier)) {
		const externalId = asInt(number);
		if (externalId === undefined) return null;
		return engine.scryfallCardByExternalId(identifier, externalId, baseUrl);
	}
	if (!number) {
		if (!isUuid(identifier)) return null;
		return engine.scryfallCardById(identifier, baseUrl);
	}
	const [first] = await engine.scryfallFirstOfEach([setAndCollectorNumber(identifier, number)], baseUrl);
	const card = first ?? null;
	// DELIBERATE DEVIATION: upstream filters the language in SQL. `lang` lives in the residue
	// archive here and is not a filter field, so the card is resolved first and its OWN stored
	// language checked — which uses the real value rather than assuming. Scryfall defaults the
	// segment to English.
	if (card && String(card.lang ?? "en") !== (suffix || "en")) return null;
	return card;
}

/** `[]` as bytes: the `data` of a card that has no rulings, which is a 200 rather than a miss. */
const EMPTY_DATA = encodeUtf8("[]");

/** Scryfall's own wording is not available for this one — it never has to say it. */
const RULINGS_UNPUBLISHED_DETAILS =
	"This server has not published its rulings data yet. Try again after the next import.";
const RULINGS_UNREADABLE_DETAILS = "The rulings store could not be read.";

/**
 * One card's rulings, as a List of Ruling objects.
 *
 * Rulings hang off `oracle_id`, so every printing of a card answers with the same list — which is
 * why they are stored by oracle id rather than per printing. The bucket that holds them is read
 * from KV and SLICED, never parsed: see src/engine/rulings-kv.ts for the layout and for why this
 * is the one `/cards/*` answer the Durable Object has no part in.
 */
async function rulingsForCard(ctx: RouteContext, card: Record<string, unknown>, pretty: boolean): Promise<Response> {
	const oracleId = typeof card.oracle_id === "string" ? card.oracle_id : "";
	const bucket = oracleId ? rulingsBucketOf(oracleId) : null;
	// A card carrying no usable oracle id has no rulings to find. Upstream answers the same empty
	// List rather than a miss — the card itself resolved, so the 404 would be about the wrong thing.
	if (bucket === null) return scryfallListJson(EMPTY_DATA, { hasMore: false }, pretty, CARDS_CACHE);

	let value: ArrayBuffer | null;
	try {
		value = await ctx.env.STORE_KV.get(rulingsBucketKey(bucket), "arrayBuffer");
	} catch (err) {
		console.error("Rulings: KV read failed", err);
		return scryfallJson(errorObject("internal_error", 500, RULINGS_UNREADABLE_DETAILS), pretty, NO_STORE_HEADER);
	}
	// Every bucket is published, empty ones included, so a MISSING bucket means no import has put
	// rulings in this namespace yet — not that the card has none. Saying so is the honest answer;
	// `data: []` would be a claim about the card, and a 404 a claim about its existence.
	if (value === null) {
		return scryfallJson(errorObject("service_unavailable", 503, RULINGS_UNPUBLISHED_DETAILS), pretty, NO_STORE_HEADER);
	}

	let data: Uint8Array;
	try {
		data = rulingsSlice(new Uint8Array(value), oracleId) ?? EMPTY_DATA;
	} catch (err) {
		if (!(err instanceof RulingsFormatError)) throw err;
		console.error(`Rulings: ${rulingsBucketKey(bucket)} is not readable as a bucket`, err);
		return scryfallJson(errorObject("internal_error", 500, RULINGS_UNREADABLE_DETAILS), pretty, NO_STORE_HEADER);
	}
	return scryfallListJson(data, { hasMore: false }, pretty, CARDS_CACHE);
}

/** One page of the unfiltered `/cards` listing, ordered by name like Scryfall's. */
async function allCardsPage(ctx: RouteContext, params: Record<string, string>, pretty: boolean): Promise<Response> {
	const page = asInt(params.page) ?? 1;
	if (page < 1)
		return scryfallJson(badRequestError("The page parameter must be a positive integer."), pretty, CARDS_CACHE);
	const engine = await ctx.getEngine();
	let result: EngineSerializedResult;
	try {
		result = await engine.scryfallSearch(
			{
				filterTreeJson: TRUE_TREE,
				unique: "printing",
				prefer: "default",
				orderby: "name",
				direction: "asc",
				limit: PAGE_SIZE,
				offset: (page - 1) * PAGE_SIZE,
				fields: [],
			},
			apiBaseUrl(ctx),
		);
	} catch (err) {
		return engineFailure(err, pretty);
	}
	if (result.rowCount === 0) return scryfallJson(notFoundError(NO_MATCH_DETAILS), pretty, CARDS_CACHE);
	const hasMore = (page - 1) * PAGE_SIZE + result.rowCount < result.totalCards;
	return scryfallListJson(
		result.cardsBytes,
		{
			totalCards: result.totalCards,
			hasMore,
			nextPage: hasMore ? buildPageUrl(selfBaseUrl(ctx, "/cards"), {}, page + 1) : undefined,
		},
		pretty,
		CARDS_CACHE,
	);
}

export type { ScryfallError };
