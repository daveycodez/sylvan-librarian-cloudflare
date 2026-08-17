// The route table, mirroring upstream APIResource.__init__'s registration of
// @route-marked methods (iter_marked_routes scans dir(cls), so entries land in
// attribute-name order; multi-path specs register each path consecutively).
// Every upstream route declares plain @route() — GET plus the implied HEAD;
// none declare POST. positionalCapacity mirrors _max_positional_args: 2 for
// card's path segments, unbounded for setup_schema's *args, 0 elsewhere.

import { httpError } from "./http";
import { LISTINGS } from "./listing";
import { getCatalogHandler, getPidHandler, notImplementedHandler } from "./misc";
import { cardHandler, redirectToRootHandler, rootHandler } from "./pages";
import { BindingTypeError, ParamCoercionError } from "./param-binding";
import type { RouteEntry, RouteTable } from "./registry";
import { catalogHandler, parseManaHandler, setsHandler, symbologyHandler } from "./scryfall-compat/reference-routes";
import {
	cardsAutocompleteHandler,
	cardsCollectionHandler,
	cardsHandler,
	cardsNamedHandler,
	cardsRandomHandler,
	cardsSearchHandler,
} from "./scryfall-compat/routes";
import { randomSearchHandler, searchHandler } from "./search";

const GET = ["GET", "HEAD"] as const;

/**
 * Wrap a handler with upstream _handle's binding-error translation:
 * ParamCoercionError → 400 {"title": "Invalid Parameter"}, TypeError → 400
 * whose title falls back to falcon's bare status line.
 */
function withBindingErrors(handler: RouteEntry["handler"]): RouteEntry["handler"] {
	return async (ctx, positionalArgs, params) => {
		try {
			return await handler(ctx, positionalArgs, params);
		} catch (err) {
			if (err instanceof ParamCoercionError) {
				return httpError(400, "Invalid Parameter", err.message);
			}
			if (err instanceof BindingTypeError) {
				return httpError(400, "400 Bad Request", err.message);
			}
			throw err;
		}
	};
}

function entry(handler: RouteEntry["handler"], listing: RouteEntry["listing"], positionalCapacity = 0): RouteEntry {
	return { handler: withBindingErrors(handler), methods: GET, positionalCapacity, listing };
}

function stub(routeName: keyof typeof LISTINGS, positionalCapacity = 0): RouteEntry {
	return entry(notImplementedHandler(routeName), LISTINGS[routeName], positionalCapacity);
}

// Insertion order mirrors upstream registration (dir(cls) order over the
// handler attribute names, each spec's paths in declaration order) so the 404
// routes listing serializes identically.
// Static files (/static/*, /favicon.ico, /robots.txt, /prefer_score_tuner.html)
// are absent deliberately: they are served from public/ by Cloudflare's CDN and
// never reach this Worker, so they need no route and cost no isolate. See
// scripts/generate-assets.ts.
export const routes: RouteTable = {
	// _redirect_to_root
	index: entry(redirectToRootHandler, LISTINGS._redirect_to_root),
	"index.html": entry(redirectToRootHandler, LISTINGS._redirect_to_root),
	// _root
	_root: entry(rootHandler, LISTINGS._root),
	// Postgres-only backfills → 501 stubs
	backfill_cubecobra_scores: stub("backfill_cubecobra_scores"),
	backfill_prefer_scores: stub("backfill_prefer_scores"),
	// card
	card: entry(cardHandler, LISTINGS.card, 2),
	// The Scryfall-compatible /cards/* surface (upstream #912). Order matters: it serializes into
	// the 404 routes listing and is pinned by tests/routes/dispatch.test.ts.
	//
	// `cards` absorbs up to THREE trailing segments -- /cards/:code/:number/:lang is the longest
	// shape -- and the five named sub-routes register their exact paths, which resolveAction
	// matches before it falls back to the first segment. That is what lets `cards/search` and
	// `/cards/:id` coexist without a router.
	cards: entry(cardsHandler, LISTINGS.cards, 3),
	"cards/search": entry(cardsSearchHandler, LISTINGS["cards/search"]),
	"cards/named": entry(cardsNamedHandler, LISTINGS["cards/named"]),
	"cards/autocomplete": entry(cardsAutocompleteHandler, LISTINGS["cards/autocomplete"]),
	"cards/random": entry(cardsRandomHandler, LISTINGS["cards/random"]),
	// The one POST in the table; every other route is GET plus the implied HEAD.
	"cards/collection": {
		handler: withBindingErrors(cardsCollectionHandler),
		methods: ["POST"],
		positionalCapacity: 0,
		listing: LISTINGS["cards/collection"],
	},
	discover_is_tags_from_syntax: stub("discover_is_tags_from_syntax"),
	get_catalog: entry(getCatalogHandler, LISTINGS.get_catalog),
	get_common_keywords: stub("get_common_keywords"),
	get_migrations: stub("get_migrations"),
	get_pid: entry(getPidHandler, LISTINGS.get_pid),
	import_all_is_tags: stub("import_all_is_tags"),
	import_art_tags: stub("import_art_tags"),
	import_card_by_name: stub("import_card_by_name"),
	import_cards_by_search: stub("import_cards_by_search"),
	import_data: stub("import_data"),
	import_oracle_tags: stub("import_oracle_tags"),
	// Postgres-only, like the backfills above: upstream loads the bulk rulings file into
	// magic.rulings, and this deployment has no such table. See the README's deviations list.
	import_rulings: stub("import_rulings"),
	ingest_cubecobra: stub("ingest_cubecobra"),
	random_search: entry(randomSearchHandler, LISTINGS.random_search),
	// The reference half of the Scryfall surface (upstream #922). These sort HERE, and in this
	// order, because the listing follows upstream attribute names — `scryfall_catalog`,
	// `scryfall_parse_mana`, `scryfall_sets`, `scryfall_symbology` — and all four sort between
	// `random_search` and `search`. Hence `symbology/parse-mana` sitting apart from `symbology`:
	// it is its own handler, not a path registered behind that one, which is the difference from
	// the `cards` block above.
	catalog: entry(catalogHandler, LISTINGS.catalog, 1),
	"symbology/parse-mana": entry(parseManaHandler, LISTINGS["symbology/parse-mana"]),
	// Two trailing segments: /sets/tcgplayer/:id is the longest shape.
	sets: entry(setsHandler, LISTINGS.sets, 2),
	symbology: entry(symbologyHandler, LISTINGS.symbology),
	search: entry(searchHandler, LISTINGS.search),
	// setup_schema takes *args upstream, so any number of trailing segments resolves
	setup_schema: stub("setup_schema", Number.POSITIVE_INFINITY),
};

/**
 * The route keys that make up the SCRYFALL-COMPATIBLE surface.
 *
 * It decides one thing: which shape a DISPATCH-level error takes on that path — Scryfall's
 * `{object, code, status, details}` or upstream's falcon `{title, description}`. Everything a
 * handler answers for itself already knows which surface it is on.
 *
 * The split is by ROUTE KEY rather than by path prefix because the two surfaces interleave under
 * one: `catalog` is Scryfall's `/catalog/:name` and `get_catalog` is upstream's own endpoint, and
 * only the table can tell them apart. `cards` is in the set even though `/cards` itself is an
 * upstream route api.scryfall.com does not have — it owns every `/cards/*` path a Scryfall client
 * would ever address, and a client is far likelier to mistype one of those than to want the listing.
 *
 * What is deliberately NOT here: `_root`, `card`, `index` (the web interface), `search` and
 * `random_search` (this project's own JSON, whose error bodies the frontend renders by reading
 * `title` and `description` — see public/static/app.js), `get_catalog`, `get_pid`, and the
 * Postgres-only admin stubs. Those are upstream's surface and keep upstream's shape.
 */
export const SCRYFALL_SURFACE_ROUTES: ReadonlySet<string> = new Set([
	"cards",
	"cards/search",
	"cards/named",
	"cards/autocomplete",
	"cards/random",
	"cards/collection",
	"catalog",
	"sets",
	"symbology",
	"symbology/parse-mana",
]);

/** The {route: {doc, args, kwargs}} listing carried by 404 responses (upstream _build_routes_listing). */
export function buildRoutesListing(): Record<string, RouteEntry["listing"]> {
	return Object.fromEntries(Object.entries(routes).map(([path, routeEntry]) => [path, routeEntry.listing]));
}
