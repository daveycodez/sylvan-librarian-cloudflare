// Port of the page routes: _root (server-side rendered index with embedded
// search results), card (/card/{set_code}/{collector_number}), and the legacy
// index → / redirect. (prefer_score_tuner left with upstream #963: it lives
// behind the Basic-Auth /_admin mount now — see src/routes/admin.ts.)

import { concatBytes, decodeUtf8, encodeUtf8, escapeLtBytes } from "../engine/bytes";
import { criticalCss } from "./assets";
import type { CardOrdering, PreferOrder, SortDirection, UniqueOn } from "./enums";
import { CARD_ORDERING, PREFER_ORDER, SORT_DIRECTION, UNIQUE_ON } from "./enums";
import { buildBaseHtml, buildCardHtml, replaceAllLiteral, SITE_NAME_PLACEHOLDER } from "./html";
import { NO_STORE_HEADER, pageCacheHeader, searchPageCacheHeader } from "./http";
import { type CardRow, generateResultsCountHtml, generateResultsHtml } from "./noscript";
import { bindParams, enumParam, strParam } from "./param-binding";
import type { RouteContext } from "./registry";
import { EngineQueryError, runSearchParts, SearchBadRequest } from "./search";
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

/**
 * PORT-ONLY: start app.js's discovery fetch from the head. With no `q`, app.js's init() calls
 * loadRandomCards(), whose fetch otherwise waits for the deferred bundle to download, parse and
 * run. It is consumed by that fetch, not doubled: the URL matches, `crossorigin` makes the preload
 * `cors` with same-origin credentials like fetch()'s defaults, and fetch()'s `Accept:
 * application/json` does not block reuse (Chromium 152: measured; WebKit: Accept is in
 * shouldIgnoreHeaderForCacheReuse; Gecko: only CORS-safelisted headers are required). `no-store`
 * stops the answer being cached, not the preload being consumed.
 */
const RANDOM_PRELOAD =
	'\n    <link rel="preload" href="/random_search?num_cards=12&amp;shape=columnar" as="fetch" crossorigin />';
const CANONICAL_LINK = '<link rel="canonical" href="/" />';

const EMBEDDED_DATA_PLACEHOLDER = "<!-- SERVER_SIDE_EMBEDDED_DATA -->";

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

	// app.js reads ONLY `q` (not `query`) to choose between the embedded results and a random
	// sample, so the preload keys on the same test: `/?query=x` still loads random cards.
	if (!bound.q) {
		htmlContent = htmlContent.replace(CANONICAL_LINK, () => CANONICAL_LINK + RANDOM_PRELOAD);
	}

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
			// Run the search server-side and embed results in the HTML. The rows come back as the
			// engine's own JSON bytes: parsed ONCE here for the HTML, and spliced verbatim (`<`
			// escaped) into the embedded envelope, rather than cloned across the RPC as objects and
			// re-serialized here.
			const found = await runSearchParts(
				ctx,
				{
					query: searchQuery,
					orderby: (bound.orderby as CardOrdering | null) ?? "edhrec",
					direction: (bound.direction as SortDirection | null) ?? "asc",
					unique: (bound.unique as UniqueOn | null) ?? "card",
					prefer: (bound.prefer as PreferOrder | null) ?? "default",
				},
				"rows",
			);

			const cards = JSON.parse(decodeUtf8(found.cardsBytes)) as CardRow[];
			const totalCards = found.totalCards;

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

			// Embed the full envelope for JavaScript enhancement: the same bytes
			// serializeEmbeddedJson({cards, ...metadata}) wrote. lastIndexOf, because the anchor
			// sits in the closing <script>, after the (escaped, so anchor-free) results markup.
			const at = htmlContent.lastIndexOf(EMBEDDED_DATA_PLACEHOLDER);
			const body = concatBytes([
				encodeUtf8(
					`${htmlContent.slice(0, at)}// Server-side embedded search results\n      window.EMBEDDED_SEARCH_RESULTS = {"cards":`,
				),
				escapeLtBytes(found.cardsBytes),
				encodeUtf8(
					`${found.tail.replaceAll("<", "\\u003c")};\n      ${htmlContent.slice(at + EMBEDDED_DATA_PLACEHOLDER.length)}`,
				),
			]);
			return new Response(body, { headers: { "content-type": "text/html", ...searchPageCacheHeader() } });
		} catch (err) {
			// If search fails, just serve the page without embedded results.
			// EngineQueryError lands here too: upstream would have recovered via
			// its SQL fallback, and this route's contract is "page without
			// results", not an error page. EngineUnavailableError still
			// propagates (upstream's 503 does the same).
			//
			// CACHED DIFFERENTLY. A parse failure is a property of the query and
			// deserves the page's ordinary hour at the edge (upstream's own 1h
			// header is only ever reached for it). An engine fault is transient,
			// and cached for an hour it pinned an empty page into every edge for
			// that URL — no-JS users saw nothing, and app.js's fallback fired an
			// extra /search request plus engine RPC on every view for the hour.
			if (err instanceof SearchBadRequest) {
				console.warn(`Failed to embed search results: ${err.message}`);
				headers = pageCacheHeader();
			} else if (err instanceof EngineQueryError) {
				console.error(`Failed to embed search results (engine fault, not cached): ${err.message}`);
				headers = NO_STORE_HEADER;
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
