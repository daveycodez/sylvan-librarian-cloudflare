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
import { badRequestError, errorObject, notFoundError } from "./objects";
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
		// /sets takes at most one identifying segment; anything longer addresses nothing.
		key = null;
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
	const wanted = (positionalArgs[0] ?? "").trim().toLowerCase();
	// Upstream's reasoning, kept: the list is fixed in code rather than discovered, so a name this
	// instance has never imported 404s instead of reporting that Magic has no creature types.
	if (!isCatalogName(wanted)) return scryfallJson(notFoundError(CATALOG_NOT_FOUND_DETAILS), pretty, MIRRORED_CACHE);

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
	const cost = params.cost;
	if (cost === undefined) {
		return scryfallJson(badRequestError("You must provide a cost parameter to parse."), pretty, PARSE_MANA_CACHE);
	}
	try {
		return scryfallJson(parseManaCost(cost), pretty, PARSE_MANA_CACHE);
	} catch (err) {
		if (!(err instanceof ManaCostError)) throw err;
		// 422 with code `validation_error`, both measured: upstream sends 422 with code
		// `bad_request`, which is the status right and the code wrong (reported against #922).
		return scryfallJson(errorObject("validation_error", 422, err.message), pretty, PARSE_MANA_CACHE);
	}
}

export { CATALOG_NAMES };
