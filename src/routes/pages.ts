// Port of the page routes: _root (server-side rendered index with embedded
// search results), card (/card/{set_code}/{collector_number}),
// prefer_score_tuner, and the legacy index → / redirect
// (api_resource.py:1494-1602, 1702-1728).

import { readManifest } from "../engine/manifest";
import { EngineUnavailableError } from "../engine/types";
import { staticText } from "./assets";
import type { CardOrdering, PreferOrder, SortDirection, UniqueOn } from "./enums";
import { CARD_ORDERING, PREFER_ORDER, SORT_DIRECTION, UNIQUE_ON } from "./enums";
import { buildBaseHtml, buildCardHtml, CRITICAL_CSS, replaceAllLiteral, SITE_NAME_PLACEHOLDER } from "./html";
import { cacheHeader, searchCacheHeader } from "./http";
import { generateResultsCountHtml, generateResultsHtml } from "./noscript";
import { bindParams, enumParam, strParam } from "./param-binding";
import type { RouteContext } from "./registry";
import { EngineQueryError, runSearch, SearchBadRequest } from "./search";
import { SITE_NAME } from "./site-name";

// Keyword parameters of _root(), in signature order (request_host is injected
// by dispatch, never bound from the query string).
const ROOT_SPEC = [
	{ name: "q", converter: strParam(), default: null },
	{ name: "query", converter: strParam(), default: null },
	{ name: "orderby", converter: enumParam(CARD_ORDERING), default: null },
	{ name: "direction", converter: enumParam(SORT_DIRECTION), default: null },
	{ name: "unique", converter: enumParam(UNIQUE_ON), default: null },
	{ name: "prefer", converter: enumParam(PREFER_ORDER), default: null },
] as const;

/** Return the index page, optionally with embedded search results (upstream _root()). */
export async function rootHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const bound = bindParams("APIResource._root", ROOT_SPEC, [], params);
	const siteName = SITE_NAME;
	let htmlContent = buildBaseHtml(CRITICAL_CSS, siteName);

	// Cache for 1 hour unless a search is embedded below.
	let headers: Record<string, string> = cacheHeader(3600);

	const searchQuery = (bound.query as string | null) || (bound.q as string | null);
	if (!searchQuery) {
		// The bare homepage renders without the engine, so without this check it
		// would look fine while every client-side fetch failed. One cheap
		// manifest read turns that into an honest error page. It does NOT start
		// an import: the deploy builds the index (scripts/deploy.sh) and fails
		// if it cannot, so no store here means the deploy did not publish one —
		// a visitor-triggered rebuild would just mask that. A D1 hiccup must
		// never take the homepage down, so a read error falls through to the
		// normal render.
		try {
			if ((await readManifest(ctx.env)) === null) {
				throw new EngineUnavailableError("No store manifest in D1; deploy has not published an index", false);
			}
		} catch (err) {
			if (err instanceof EngineUnavailableError) throw err;
		}
	}
	if (searchQuery) {
		try {
			// Run the search server-side and embed results in the HTML.
			const searchResults = await runSearch(ctx, {
				query: searchQuery,
				orderby: (bound.orderby as CardOrdering | null) ?? "edhrec",
				direction: (bound.direction as SortDirection | null) ?? "asc",
				unique: (bound.unique as UniqueOn | null) ?? "card",
				prefer: (bound.prefer as PreferOrder | null) ?? "default",
			});

			const cards = searchResults.cards ?? [];
			const totalCards = searchResults.total_cards ?? cards.length;

			// Server-side HTML for cards (for no-JS support).
			const resultsHtml = cards.length > 0 ? generateResultsHtml(cards) : "";
			const resultsCountHtml = cards.length > 0 ? generateResultsCountHtml(totalCards, searchQuery) : "";

			htmlContent = replaceAllLiteral(htmlContent, "<!-- SERVER_SIDE_RESULTS -->", resultsHtml);
			if (resultsCountHtml) {
				htmlContent = replaceAllLiteral(
					htmlContent,
					"<!-- SERVER_SIDE_RESULTS_COUNT -->",
					`<div class="results-count">${resultsCountHtml}</div>`,
				);
			}

			// Embed the full envelope for JavaScript enhancement.
			const searchResultsJson = JSON.stringify(searchResults);
			const embeddedData = `// Server-side embedded search results\n      window.EMBEDDED_SEARCH_RESULTS = ${searchResultsJson};\n      `;
			htmlContent = replaceAllLiteral(htmlContent, "<!-- SERVER_SIDE_EMBEDDED_DATA -->", embeddedData);

			headers = searchCacheHeader();
		} catch (err) {
			// If search fails, just serve the page without embedded results.
			// EngineQueryError lands here too: upstream would have recovered via
			// its SQL fallback, and this route's contract is "page without
			// results", not an error page. EngineUnavailableError still
			// propagates (upstream's 503 does the same).
			if (err instanceof SearchBadRequest || err instanceof EngineQueryError) {
				console.warn(`Failed to embed search results: ${err.message}`);
				headers = cacheHeader(3600);
			} else {
				throw err;
			}
		}
	}

	return new Response(htmlContent, { headers: { "content-type": "text/html", ...headers } });
}

const CARD_SPEC = [
	{ name: "set_code", converter: strParam(), default: "", positional: true },
	{ name: "collector_number", converter: strParam(), default: "", positional: true },
] as const;

/** Serve the per-card page for /card/{set_code}/{collector_number} (upstream card()). */
export function cardHandler(_ctx: RouteContext, positionalArgs: string[], params: Record<string, string>): Response {
	// The handler ignores the values, but binding still runs: a query param
	// colliding with a path segment is a 400 upstream (TypeError → HTTPBadRequest).
	bindParams("APIResource.card", CARD_SPEC, positionalArgs, params);
	const siteName = SITE_NAME;
	const html = replaceAllLiteral(buildCardHtml(CRITICAL_CSS), SITE_NAME_PLACEHOLDER, siteName);
	return new Response(html, { headers: { "content-type": "text/html", ...cacheHeader(3600) } });
}

/** Return the prefer score tuner page (upstream prefer_score_tuner(); no cache header). */
export function preferScoreTunerHandler(): Response {
	return new Response(staticText("prefer_score_tuner.html"), { headers: { "content-type": "text/html" } });
}

/** Send the legacy index paths to / (upstream _redirect_to_root, falcon.HTTPMovedPermanently). */
export function redirectToRootHandler(): Response {
	// Thrown, not returned: dispatch rethrows Responses, mirroring how the
	// upstream handler raises falcon.HTTPMovedPermanently instead of returning.
	throw new Response(null, { status: 301, headers: { Location: "/" } });
}
