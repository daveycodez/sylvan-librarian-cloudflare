// Port of the page routes: _root (server-side rendered index with embedded
// search results), card (/card/{set_code}/{collector_number}), and the legacy
// index → / redirect. (prefer_score_tuner left with upstream #963: it lives
// behind the Basic-Auth /_admin mount now — see src/routes/admin.ts.)

import { criticalCss } from "./assets";
import type { CardOrdering, PreferOrder, SortDirection, UniqueOn } from "./enums";
import { CARD_ORDERING, PREFER_ORDER, SORT_DIRECTION, UNIQUE_ON } from "./enums";
import { buildBaseHtml, buildCardHtml, replaceAllLiteral, SITE_NAME_PLACEHOLDER, serializeEmbeddedJson } from "./html";
import { pageCacheHeader, searchPageCacheHeader } from "./http";
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
	let htmlContent = buildBaseHtml(criticalCss(), siteName);

	// Revalidated by the browser on every navigation, cached an hour at the edge.
	let headers: Record<string, string> = pageCacheHeader();

	const searchQuery = (bound.query as string | null) || (bound.q as string | null);
	if (!searchQuery) {
		// No manifest pre-check: the page renders, and its client-side search
		// fetch surfaces any index problem through the UI's existing error
		// display (app.js showError, fed from the API's JSON title/description).
		// That is strictly better than replacing the whole page with an error —
		// the shell, header and no-JS content still work — and it keeps the
		// homepage off D1 entirely on the happy path.
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
			const searchResultsJson = serializeEmbeddedJson(searchResults);
			const embeddedData = `// Server-side embedded search results\n      window.EMBEDDED_SEARCH_RESULTS = ${searchResultsJson};\n      `;
			htmlContent = replaceAllLiteral(htmlContent, "<!-- SERVER_SIDE_EMBEDDED_DATA -->", embeddedData);

			headers = searchPageCacheHeader();
		} catch (err) {
			// If search fails, just serve the page without embedded results.
			// EngineQueryError lands here too: upstream would have recovered via
			// its SQL fallback, and this route's contract is "page without
			// results", not an error page. EngineUnavailableError still
			// propagates (upstream's 503 does the same).
			if (err instanceof SearchBadRequest || err instanceof EngineQueryError) {
				console.warn(`Failed to embed search results: ${err.message}`);
				headers = pageCacheHeader();
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
	const html = replaceAllLiteral(buildCardHtml(criticalCss()), SITE_NAME_PLACEHOLDER, siteName);
	return new Response(html, { headers: { "content-type": "text/html", ...pageCacheHeader() } });
}

/** Send the legacy index paths to / (upstream _redirect_to_root, falcon.HTTPMovedPermanently). */
export function redirectToRootHandler(): Response {
	// Thrown, not returned: dispatch rethrows Responses, mirroring how the
	// upstream handler raises falcon.HTTPMovedPermanently instead of returning.
	throw new Response(null, { status: 301, headers: { Location: "/" } });
}
