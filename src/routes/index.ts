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
	ingest_cubecobra: stub("ingest_cubecobra"),
	random_search: entry(randomSearchHandler, LISTINGS.random_search),
	search: entry(searchHandler, LISTINGS.search),
	// setup_schema takes *args upstream, so any number of trailing segments resolves
	setup_schema: stub("setup_schema", Number.POSITIVE_INFINITY),
};

/** The {route: {doc, args, kwargs}} listing carried by 404 responses (upstream _build_routes_listing). */
export function buildRoutesListing(): Record<string, RouteEntry["listing"]> {
	return Object.fromEntries(Object.entries(routes).map(([path, routeEntry]) => [path, routeEntry.listing]));
}
