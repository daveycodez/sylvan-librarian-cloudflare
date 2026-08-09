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
	"Access-Control-Allow-Origin": "*",
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
		headers: { "content-type": "application/json", ...extraHeaders },
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

/** Upstream set_no_store_header. */
export const NO_STORE_HEADER: Record<string, string> = { "Cache-Control": "no-store" };

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
