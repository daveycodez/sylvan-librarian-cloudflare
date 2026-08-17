// HTTP plumbing shared by dispatch (src/index.ts) and route handlers:
// falcon-parity error responses, security/CORS headers, cache headers.
// Mirrors vendor/sylvan_librarian/api/api_worker.py json_error_serializer,
// api/middlewares/security_headers.py + cors_middleware.py, and
// api_resource.py set_cache_header/set_no_store_header.

// Upstream reads CDN_URL with a CloudFront default. Our own assets (app.min.js,
// styles.css, card.js) are same-origin out of public/, but the FONTS fragment we
// vendor verbatim still loads mana/beleren/mplantin from upstream's CloudFront —
// so style-src and font-src must keep naming it. Dropping it silently kills
// mana-subset.css, which is what turns every <span class="ms ms-*"> mana symbol
// into an empty box.
const CDN_URL = "https://d1hot9ps2xugbc.cloudfront.net";

const SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy":
		"default-src 'self'; " +
		"script-src 'self' 'unsafe-inline'; " +
		`style-src 'self' 'unsafe-inline' ${CDN_URL}; ` +
		`font-src 'self' ${CDN_URL}; ` +
		"img-src 'self' data: https:; " +
		"connect-src 'self'; " +
		"frame-ancestors 'none'; " +
		"base-uri 'self'; " +
		"form-action 'self'",
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"X-XSS-Protection": "1; mode=block",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "geolocation=(), microphone=(), camera=()",
	// ── CORS, as api.scryfall.com sends it (measured 2026-08-16, on every response) ──
	//
	// `Access-Control-Allow-Origin: *` alone is enough for a SIMPLE cross-origin GET, and that is
	// all this port sent. It is NOT enough for anything else: a browser preflights
	// `POST /cards/collection` (its `content-type: application/json` is not a CORS-safelisted
	// value), and a preflight whose response names no allowed method or header fails the request
	// before it is made. So a browser client could read this mirror's search results and could not
	// post a collection to it — a gap with no error message anywhere, because the failing exchange
	// is the OPTIONS the page never sees.
	//
	// The three values are Scryfall's own, verbatim, including the header list a client is unlikely
	// to send all of. Copying it rather than trimming to what these routes read keeps the answer a
	// property of the API being mirrored rather than of this implementation's current parameter set.
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":
		"Accept, Accept-Charset, Accept-Language, Authorization, Cache-Control, Content-Language, " +
		"Content-Type, DNT, Host, If-Modified-Since, Keep-Alive, Origin, Referer, User-Agent, X-Requested-With",
	"Access-Control-Max-Age": "300",
};

/** Applied to every response, matching upstream's process_response middlewares. */
export function securityHeaders(response: Response): Response {
	const out = new Response(response.body, response);
	for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
		out.headers.set(header, value);
	}
	return out;
}

/**
 * Falcon HTTP error as JSON: {"title": ..., "description": ...} via upstream's
 * json_error_serializer (description may be a structured object, e.g. the 404
 * routes listing).
 */
export function httpError(
	status: number,
	title: string,
	description: unknown,
	extraHeaders?: Record<string, string>,
): Response {
	return new Response(JSON.stringify({ title, description }), {
		status,
		headers: {
			// WITH the charset, and `no-cache` — both measured on api.scryfall.com's own dispatch-level
			// errors (`/nonexistent-route`, `/catalog/card-types/extra`, `/symbology/parse-mana/extra`),
			// which send `application/json; charset=utf-8` and `Cache-Control: no-cache`. This sent a
			// bare `application/json` and no cache directive at all, so a shared cache in front of the
			// Worker was free to apply its own heuristics to a 404, a 405 or a 500.
			//
			// The BODY still differs: it is upstream's routes listing rather than Scryfall's error
			// object. That one is a deliberate deviation (this deployment serves upstream's surface
			// beside the compat one) and is ledgered in the README and in the sweep's `http` family;
			// the content type and the tier were not deviations, only omissions.
			"content-type": "application/json; charset=utf-8",
			"Cache-Control": "no-cache",
			...extraHeaders,
		},
	});
}

/** Upstream set_cache_header: Cache-Control: public, max-age=<seconds>. */
export function cacheHeader(seconds: number): Record<string, string> {
	return { "Cache-Control": `public, max-age=${seconds}` };
}

/**
 * Search-bearing responses: upstream's 90s max-age plus stale-while-revalidate
 * (a deliberate deviation, see README): Workers Cache serves an expired entry
 * instantly while refreshing in the background, turning repeat-query cold
 * isolate hits into edge-speed responses. A day of SWR bounds staleness at
 * one nightly import cycle.
 */
export function searchCacheHeader(): Record<string, string> {
	return { "Cache-Control": "public, max-age=90, stale-while-revalidate=86400" };
}

/**
 * HTML documents: always revalidated by the browser, still cached at the edge.
 *
 * The pages are the only thing that names an asset URL, which makes them the
 * pointer in a content-addressed scheme — and a stale pointer is indistinguishable
 * from a stale asset from the user's side. Upstream sends `public, max-age=3600`
 * here and this port copied it, which meant a browser could keep rendering an
 * hour-old page naming an hour-old bundle: a frontend fix provably could not
 * reach a user for that hour, no matter how correct the deploy was.
 *
 * `max-age=0, must-revalidate` is what Cloudflare's asset layer applies to HTML
 * by default, and it is the half of the pair that earns `immutable` on the assets
 * (see scripts/generate-assets.ts). `s-maxage` keeps the edge copy, so the Worker
 * still does not run per navigation: browsers revalidate against Cloudflare, get
 * a 304 from a cache the deploy already reset (Workers Caching partitions by
 * Worker version), and pick up a new bundle on the first navigation after a
 * deploy rather than up to an hour later.
 */
export function pageCacheHeader(edgeSeconds = 3600): Record<string, string> {
	return { "Cache-Control": `public, max-age=0, must-revalidate, s-maxage=${edgeSeconds}` };
}

/**
 * A page with search results embedded in it. Same always-revalidate rule as any
 * other document — it names an asset URL too — over the search tier's shorter
 * edge TTL and stale-while-revalidate. The SWR stays on the SHARED cache only:
 * as a browser directive it let a client render a day-old document, and so a
 * day-old bundle pointer. /search's JSON keeps searchCacheHeader() unchanged; it
 * carries no asset URL.
 */
export function searchPageCacheHeader(): Record<string, string> {
	return { "Cache-Control": "public, max-age=0, must-revalidate, s-maxage=90, stale-while-revalidate=86400" };
}

/** Upstream set_no_store_header. */
export const NO_STORE_HEADER: Record<string, string> = { "Cache-Control": "no-store" };

/**
 * The CORS preflight answer, byte-for-byte as api.scryfall.com gives it.
 *
 * A Message object, not an error and not an empty 204: `{object, code, status, details}` with
 * `object: "message"`, pretty-printed the way Scryfall pretty-prints every one of these bodies.
 * The sentence names the four methods the API accepts, which is the same set
 * `Access-Control-Allow-Methods` carries — Scryfall says it twice and so does this.
 *
 * Lives here rather than in the compat routes because dispatch answers it for every path, which is
 * also what Scryfall does: measured on `/cards/search` and `/catalog/battle-types`, the two
 * surfaces give the identical response.
 */
export function optionsResponse(): Response {
	const body = {
		object: "message",
		code: "ok",
		status: 200,
		details: "This API accepts GET, POST, DELETE, and OPTIONS",
	};
	return new Response(JSON.stringify(body, null, 2), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"Cache-Control": "max-age=0, private, must-revalidate",
		},
	});
}

/** JSON success envelope; upstream uses orjson with default options (compact). */
export function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
	return jsonResponseText(JSON.stringify(body), headers);
}

/**
 * The same envelope, from a body that is ALREADY JSON text.
 *
 * Card results reach the isolate pre-serialized (Engine.searchSerialized), so
 * re-encoding them here would spend this deployment's scarcest budget — the
 * free plan's 10ms of isolate CPU — undoing work the Durable Object has done.
 */
export function jsonResponseText(body: string, headers?: Record<string, string>): Response {
	return new Response(body, {
		headers: { "content-type": "application/json", ...headers },
	});
}
