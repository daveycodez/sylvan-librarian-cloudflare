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
// Static files (/static/*, /favicon.ico, /robots.txt) are absent deliberately:
// they are served from public/ by Cloudflare's CDN and never reach this Worker,
// so they need no route and cost no isolate. See scripts/generate-assets.ts.
//
// The admin surface is absent too, and for upstream's reason rather than this
// port's: #963 moved every data-management route (import_*, setup_schema, the
// backfills, ingest_cubecobra, prefer_score_tuner; get_migrations was deleted
// outright) behind a Basic-Auth `/_admin` mount that hides them from this
// listing. src/routes/admin.ts is what `/_admin/*` answers here.
export const routes: RouteTable = {
	// _redirect_to_root
	index: entry(redirectToRootHandler, LISTINGS._redirect_to_root),
	"index.html": entry(redirectToRootHandler, LISTINGS._redirect_to_root),
	// _root
	_root: entry(rootHandler, LISTINGS._root),
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
	get_catalog: entry(getCatalogHandler, LISTINGS.get_catalog),
	get_common_keywords: stub("get_common_keywords"),
	get_pid: entry(getPidHandler, LISTINGS.get_pid),
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

/**
 * Resolve a normalized path to a route key and its trailing positional segments,
 * or null when nothing matches — upstream _resolve_action.
 *
 * `Object.hasOwn` rather than `in`, in BOTH lookups, because `routes` is a plain
 * object literal and `in` walks Object.prototype. `/constructor`, `/toString`,
 * `/valueOf`, `/hasOwnProperty` and `/__proto__` all resolved to inherited
 * members: truthy, so the `!entry` guard passed, and with no `positionalCapacity`
 * on them the capacity check passed too (`1 > undefined` is false, since every
 * comparison against undefined is). Dispatch then read `.methods` off a Function
 * and threw a TypeError ABOVE handle()'s try block — workerd's generic 500 rather
 * than the 404 object this surface promises, with console.error never reached.
 *
 * This lives beside the table rather than in the Worker entrypoint so the route
 * test harness can call the REAL resolver: it deliberately does not import
 * src/index.ts (that pulls in the engine store and import coordinator), so it
 * carried a hand-copied mirror of this logic, and the mirror had already drifted
 * — it spelled the capacity check as `<=` where dispatch spells it `> ... return
 * null`, which are not the same function when `positionalCapacity` is undefined.
 * The harness answered 404 for the paths production threw on, so the bug above
 * was invisible to every test that went through it. One implementation, no mirror.
 */
export function resolveAction(path: string): { key: string; positionalArgs: string[] } | null {
	// Exact match first: flat routes like "static/favicon.ico" and "index.html"
	// register their full slash/dot-containing path as the route key.
	if (Object.hasOwn(routes, path)) return { key: path, positionalArgs: [] };
	const [actionWord = "", ...actionArgs] = path.split("/");
	if (!Object.hasOwn(routes, actionWord)) return null;
	const entry = routes[actionWord];
	// A matched route that can't absorb this many trailing segments means the
	// path identifies nothing — 404, not a 400 (upstream parity).
	if (!entry || actionArgs.length > entry.positionalCapacity) return null;
	return { key: actionWord, positionalArgs: actionArgs };
}
