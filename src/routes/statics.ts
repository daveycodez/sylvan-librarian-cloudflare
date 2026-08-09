// Port of the static-file routes (api_resource.py:1604-1700): each serves the
// vendored asset with upstream's exact content type and Cache-Control.

import { faviconIcoBytes, socialPreviewBytes, staticText } from "./assets";
import { cacheHeader } from "./http";

const DAY_SECONDS = 86_400;

function textResponse(body: string, contentType: string, headers: Record<string, string> = {}): Response {
	return new Response(body, { headers: { "content-type": contentType, ...headers } });
}

function binaryResponse(body: Uint8Array, contentType: string, headers: Record<string, string>): Response {
	// Upstream sets content-length explicitly on its binary responses.
	return new Response(body as unknown as BodyInit, {
		headers: { "content-type": contentType, "content-length": String(body.byteLength), ...headers },
	});
}

/** favicon.ico + static/favicon.ico: image/vnd.microsoft.icon, cached 7 days. */
export function faviconHandler(): Response {
	return binaryResponse(faviconIcoBytes(), "image/vnd.microsoft.icon", cacheHeader(7 * DAY_SECONDS));
}

/** static/social-preview.webp: image/webp, cached 30 days. */
export function socialPreviewHandler(): Response {
	return binaryResponse(socialPreviewBytes(), "image/webp", cacheHeader(30 * DAY_SECONDS));
}

/** static/styles.css: text/css, cached 30 days. */
export function stylesCssHandler(): Response {
	return textResponse(staticText("styles.css"), "text/css", cacheHeader(30 * DAY_SECONDS));
}

/** static/app.js: application/javascript, cached 1 hour. */
export function appJsHandler(): Response {
	return textResponse(staticText("app.js"), "application/javascript", cacheHeader(3600));
}

/** static/app.min.js: application/javascript, cached 30 days. Built by scripts/generate-assets.ts. */
export function appMinJsHandler(): Response {
	return textResponse(staticText("app.min.js"), "application/javascript", cacheHeader(30 * DAY_SECONDS));
}

/** static/card.js: application/javascript, cached 1 hour. */
export function cardJsHandler(): Response {
	return textResponse(staticText("card.js"), "application/javascript", cacheHeader(3600));
}

/** robots.txt: text/plain, no cache header (upstream sets none). */
export function robotsTxtHandler(): Response {
	return textResponse(staticText("robots.txt"), "text/plain");
}
