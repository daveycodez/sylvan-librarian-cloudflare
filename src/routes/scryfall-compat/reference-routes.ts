// The Scryfall-compatible `/sets`, `/catalog/*` and `/symbology` routes. Port of
// api/scryfall_compat/reference_routes.py (upstream #922), which completes the Scryfall API
// surface: #912 covered everything under `/cards`, and these describe Magic rather than return
// cards.
//
// A separate module from routes.ts because it is a separate kind of thing, which is upstream's
// structure too: nothing here touches the engine, the parser or a filter tree. Every route but
// `parse-mana` answers from data mirrored off api.scryfall.com into KV by the nightly import (see
// src/engine/reference-kv.ts, which also carries the argument for mirroring rather than deriving);
// `parse-mana` is a pure function of its parameter and answers before any import has run.
//
// DELIBERATE DEVIATION, the same one the cards surface has: upstream falls back to Postgres when
// its tables are empty, and this deployment has no second source. A value that has not been
// published yet is a 503 saying so, never an empty List — an empty List would be a claim about
// Magic ("there are no sets") rather than about this deployment.

import { KeyedBlobError, keyedBlobLookup } from "../../engine/keyed-blob";
import {
	CATALOG_NAMES,
	catalogKey,
	isCatalogName,
	readCountedArray,
	setCodeOrIdKey,
	setsBucketKey,
	setsBucketOf,
	setsListKey,
	setTcgplayerKey,
	symbologyKey,
} from "../../engine/reference-kv";
import { NO_STORE_HEADER } from "../http";
import type { RouteContext } from "../registry";
import { ManaCostError, parseManaCost } from "./mana";
import { errorObject, notFoundError } from "./objects";
import { asBool, scryfallCatalogJson, scryfallJson, scryfallListJson } from "./respond";

// ─── cache tiers ─────────────────────────────────────────────────────────────
//
// Measured against api.scryfall.com on 2026-08-11, and NOT the `public, max-age=57600` the card
// routes carry:
//
//   /sets, /sets/:code, /sets/tcgplayer/:id, /catalog/*, /symbology   public
//   /symbology/parse-mana                                            max-age=0, private, must-revalidate
//
// Both are mildly surprising and both are mirrored rather than chosen. A bare `public` with no
// max-age leaves freshness to the cache's heuristics; `parse-mana` is the one deterministic route
// here and would be safe to cache hard, yet upstream marks it private. Matching is the point: a
// client that swapped its base URL would otherwise hold a response for sixteen hours where Scryfall
// revalidates, and would not find out until it served something stale.
//
// `private` does not stop the Worker's own edge cache from being useless here, but it does stop
// shared caches in front of it — which is Scryfall's behaviour, so it is ours.
const MIRRORED_CACHE: Record<string, string> = { "Cache-Control": "public" };
const PARSE_MANA_CACHE: Record<string, string> = { "Cache-Control": "max-age=0, private, must-revalidate" };

/**
 * The tier on a MISS THAT IS ABOUT THE ROUTE rather than about Magic.
 *
 * Measured 2026-08-16, and it is a real split, not noise: `/sets/zzzz` — a well-formed set lookup
 * that found nothing — is `public`, the same tier as the answer would have been, while
 * `/catalog/not-a-catalog`, `/catalog/Card-Types` and `/sets/khm/extra` are `no-cache`. The
 * difference is what the 404 is a statement ABOUT. A set code that does not exist is a fact about
 * Magic and keeps the data tier; a path that addresses nothing is a fact about the URL, and
 * Scryfall declines to cache those anywhere. This port had `public` on both, so a client that
 * mistyped a catalog name got the mistake held at every edge for as long as the heuristics liked.
 */
const ROUTE_MISS_CACHE: Record<string, string> = { "Cache-Control": "no-cache" };

// Scryfall's own wording, per route, measured on 2026-08-12 — these are NOT the generic body the
// cards surface uses, and upstream answers all of them with that generic one (reported against
// #922). A client that string-matches on `details` sees the difference.
//
//   /sets/*, including /sets/tcgplayer with no id   "No Magic set found for the given code or ID"
//   /catalog/<unknown>                              "The requested object or REST method was not found."
//
// Note the catalog one has no "Please double-check your URI and try again." tail, where the cards
// routes' generic body does. Same sentence, different ending, and both are copied rather than
// shared so neither can be "fixed" into the other.
const SET_NOT_FOUND_DETAILS = "No Magic set found for the given code or ID";
const CATALOG_NOT_FOUND_DETAILS = "The requested object or REST method was not found.";
/**
 * The wording for a path that addresses nothing, which is the same sentence the catalog miss uses.
 *
 * Spelled separately rather than aliased: they mean different things — "there is no such catalog"
 * against "there is no such route" — and Scryfall happening to say the same thing today is not a
 * reason to make one of them impossible to change without changing the other. Same discipline as
 * the SET/CATALOG pair above, which are also one sentence apart on purpose.
 */
const ROUTE_NOT_FOUND_DETAILS = "The requested object or REST method was not found.";

/**
 * The host a Catalog's own `uri` points at.
 *
 * Scryfall's, not this deployment's, which is the rule the card objects already follow: a
 * self-referencing URI is part of the payload rather than pagination, and rewriting it would make
 * the object non-identical. See the README's deviations list.
 */
const SCRYFALL_API = "https://api.scryfall.com";

/** Path segment naming the external-id namespace under /sets, mirroring the /cards namespaces. */
const SETS_TCGPLAYER_NAMESPACE = "tcgplayer";

const UNPUBLISHED_DETAILS = "This server has not published its reference data yet. Try again after the next import.";
const UNREADABLE_DETAILS = "The reference data could not be read.";

/** A KV value this surface needs is absent: honest 503, never an empty object. */
function unpublished(pretty: boolean): Response {
	return scryfallJson(errorObject("service_unavailable", 503, UNPUBLISHED_DETAILS), pretty, NO_STORE_HEADER);
}

function unreadable(what: string, err: unknown, pretty: boolean): Response {
	console.error(`Reference data: ${what} could not be read`, err);
	return scryfallJson(errorObject("internal_error", 500, UNREADABLE_DETAILS), pretty, NO_STORE_HEADER);
}

/** Read one reference value, or null when it has never been published. */
async function readValue(ctx: RouteContext, key: string): Promise<Uint8Array | null> {
	const value = await ctx.env.STORE_KV.get(key, "arrayBuffer");
	return value === null ? null : new Uint8Array(value);
}

// ─── GET /sets ───────────────────────────────────────────────────────────────

/**
 * Every `/sets` shape, dispatched by segment count — one handler because the router hands trailing
 * segments to whichever route claims the first one:
 *
 *   - `/sets`                     every set, in Scryfall's own order
 *   - `/sets/:code`, `/sets/:id`  one set, by code or by Scryfall set id
 *   - `/sets/tcgplayer/:id`       one set, by TCGplayer group id
 */
export async function setsHandler(
	ctx: RouteContext,
	positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const [identifier = "", second = ""] = positionalArgs;

	if (!identifier) {
		const list = await readValue(ctx, setsListKey());
		if (list === null) return unpublished(pretty);
		// The stored value IS the `data` array, so the whole route is one read and one splice.
		return scryfallListJson(list, { hasMore: false }, pretty, MIRRORED_CACHE);
	}

	let key: string | null;
	if (identifier.toLowerCase() === SETS_TCGPLAYER_NAMESPACE) {
		if (!second) {
			// Scryfall answers the namespace-with-no-id path with its ordinary set miss, not with a
			// message about the missing id — upstream says "A TCGplayer id is required to look a set
			// up by it." here, which is clearer and is not what a client would see from Scryfall.
			return scryfallJson(notFoundError(SET_NOT_FOUND_DETAILS), pretty, MIRRORED_CACHE);
		}
		key = setTcgplayerKey(second);
	} else if (second) {
		// /sets takes at most one identifying segment; anything longer addresses nothing — and that
		// is a statement about the URL, not about Magic, so it answers with the ROUTE miss rather
		// than the set one. `/sets/khm/extra` on api.scryfall.com is "The requested object or REST
		// method was not found." at `no-cache`, not "No Magic set found…" at `public` (measured
		// 2026-08-16); this port sent the latter, which told a client the set was missing when the
		// set was fine and the path was not.
		return scryfallJson(notFoundError(ROUTE_NOT_FOUND_DETAILS), pretty, ROUTE_MISS_CACHE);
	} else {
		key = setCodeOrIdKey(identifier);
	}
	if (key === null) return scryfallJson(notFoundError(SET_NOT_FOUND_DETAILS), pretty, MIRRORED_CACHE);

	const bucket = await readValue(ctx, setsBucketKey(setsBucketOf(key)));
	if (bucket === null) return unpublished(pretty);
	let found: Uint8Array | null;
	try {
		found = keyedBlobLookup(bucket, key);
	} catch (err) {
		if (!(err instanceof KeyedBlobError)) throw err;
		return unreadable("a sets bucket", err, pretty);
	}
	if (found === null) return scryfallJson(notFoundError(SET_NOT_FOUND_DETAILS), pretty, MIRRORED_CACHE);
	// A Set object, straight out of KV — no envelope to build, so the bytes are the body.
	return new Response(found, {
		status: 200,
		headers: { "content-type": "application/json; charset=utf-8", ...MIRRORED_CACHE },
	});
}

// ─── GET /catalog/:name ──────────────────────────────────────────────────────

/** One catalog, by name. An unknown name is a 404, not an empty catalog. */
export async function catalogHandler(
	ctx: RouteContext,
	positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	// VERBATIM, not lowercased and not trimmed: catalog names are CASE-SENSITIVE on
	// api.scryfall.com — `/catalog/Card-Types` is a 404 there and was a 200 here (measured
	// 2026-08-16). Folding the case made this route answer a URL Scryfall does not serve, which is
	// the same class of mistake as failing to answer one it does.
	const wanted = positionalArgs[0] ?? "";
	// Upstream's reasoning, kept: the list is fixed in code rather than discovered, so a name this
	// instance has never imported 404s instead of reporting that Magic has no creature types.
	if (!isCatalogName(wanted)) return scryfallJson(notFoundError(CATALOG_NOT_FOUND_DETAILS), pretty, ROUTE_MISS_CACHE);

	const value = await readValue(ctx, catalogKey(wanted));
	if (value === null) return unpublished(pretty);
	try {
		const { count, data } = readCountedArray(value);
		return scryfallCatalogJson(data, count, `${SCRYFALL_API}/catalog/${wanted}`, pretty, MIRRORED_CACHE);
	} catch (err) {
		return unreadable(`the ${wanted} catalog`, err, pretty);
	}
}

// ─── GET /symbology ──────────────────────────────────────────────────────────

/** Every card symbol, in Scryfall's order. */
export async function symbologyHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const value = await readValue(ctx, symbologyKey());
	if (value === null) return unpublished(pretty);
	return scryfallListJson(value, { hasMore: false }, pretty, MIRRORED_CACHE);
}

// ─── GET /symbology/parse-mana ───────────────────────────────────────────────

/**
 * Parse a mana cost into Scryfall's ManaCost object.
 *
 * The one route on this surface that reads nothing: it answers the same before the first import as
 * after it, which is also why it carries no 503 branch.
 */
export function parseManaHandler(
	_ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Response {
	const pretty = asBool(params.pretty);
	// A MISSING `cost` is the same request as an empty one, and both are answered: measured
	// 2026-08-16, `/symbology/parse-mana` with no parameter and `?cost=` both return
	// `200 {"object":"mana_cost","cost":null,"colors":[],"cmc":0.0,…}`. This port sent a 400 saying
	// "You must provide a cost parameter to parse." — a sentence Scryfall does not own and a
	// rejection it does not make. `parseManaCost("")` already produces exactly that body, because
	// the empty-cost-is-null branch was measured when this route was written; only the guard in
	// front of it was wrong. Upstream 400s here too (reported against #922).
	const cost = params.cost ?? "";
	try {
		return scryfallJson(parseManaCost(cost), pretty, PARSE_MANA_CACHE);
	} catch (err) {
		if (!(err instanceof ManaCostError)) throw err;
		// 422 with code `validation_error`, both measured: upstream sends 422 with code
		// `bad_request`, which is the status right and the code wrong (reported against #922).
		//
		// `no-cache`, not the route's own tier: an unreadable cost is a fact about the REQUEST, and
		// Scryfall declines to cache those anywhere (measured on `{QQQ}`, `!!!`, `{}`, `é` and
		// `{W/U/B}`). The successful answer keeps `max-age=0, private, must-revalidate`, which is
		// nearly the same instruction and is the one Scryfall sends there — copied rather than
		// unified, because Scryfall really does send two different strings.
		return scryfallJson(errorObject("validation_error", 422, err.message), pretty, ROUTE_MISS_CACHE);
	}
}

export { CATALOG_NAMES };
