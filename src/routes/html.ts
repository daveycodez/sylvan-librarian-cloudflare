// Port of the page-template plumbing in api_resource.py (~92-440):
// _inject_shared_fragments, _build_base_html, _build_card_html, the
// _STYLES_CSS_HASH/_APP_MIN_JS_HASH/_CARD_JS_HASH cache busting, and
// _minify_html.
//
// Upstream busts caches with a query param (/static/app.min.js?v=<hash>); this
// port rewrites the whole path instead (/static/app.<hash>.min.js). See
// assetPath() in ./assets for why the query form cannot work behind Cloudflare's
// asset layer, which resolves by path and ignores the query.

import { assetPath, cssHtml, faviconHtml, fontsHtml, footerHtml, preconnectsHtml, staticText } from "./assets";

// Placeholder written into index.html/card.html wherever the site name belongs
// (upstream _SITE_NAME_PLACEHOLDER).
export const SITE_NAME_PLACEHOLDER = "%%%SITENAME%%%";

/**
 * Replacement helper: String.replaceAll with a literal replacement, immune to
 * the `$`-pattern substitution semantics of the string form (asset text and
 * search results legitimately contain `$`).
 */
function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
	return haystack.replaceAll(needle, () => replacement);
}

/**
 * Splice the shared head/footer fragments into their placeholder comments.
 * Must run before the CRITICAL_CSS/asset-hash substitutions: the CSS fragment
 * carries its own inner <!-- CRITICAL_CSS --> placeholder.
 */
export function injectSharedFragments(html: string): string {
	let out = replaceAllLiteral(html, "<!-- FAVICON -->", faviconHtml());
	out = replaceAllLiteral(out, "<!-- PRECONNECTS -->", preconnectsHtml());
	out = replaceAllLiteral(out, "<!-- FONTS -->", fontsHtml());
	out = replaceAllLiteral(out, "<!-- CSS -->", cssHtml());
	return replaceAllLiteral(out, "<!-- FOOTER -->", footerHtml());
}

/**
 * DELIBERATE DEVIATION (bytes only, not behavior): upstream minifies the built
 * pages with the Rust minify-html crate (minify_js/minify_css on,
 * keep_comments=True so the SERVER_SIDE_* placeholders survive). That library
 * has no faithful JS/Workers port, and upstream itself supports serving
 * unminified pages via its _MINIFY_HTML_ENABLED = False switch — this port
 * permanently takes that path. Placeholders, substitutions, headers and
 * envelope are unaffected; pages are simply a few KB larger.
 */
function minifyHtml(html: string): string {
	return html;
}

const BASE_HTML_CACHE_MAX = 16; // upstream LRUCache(maxsize=16)
const baseHtmlCache = new Map<string, string>();

/** Build index.html with fragments, critical CSS, versioned assets and site name. Cached per site name. */
export function buildBaseHtml(criticalCss: string, siteName: string): string {
	const key = `${criticalCss.length}:${siteName}`;
	const cached = baseHtmlCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	let html = staticText("index.html");
	html = injectSharedFragments(html);
	html = replaceAllLiteral(html, "<!-- CRITICAL_CSS -->", criticalCss);
	html = replaceAllLiteral(html, "/static/styles.css", assetPath("styles.css"));
	html = replaceAllLiteral(html, "/static/app.min.js", assetPath("app.min.js"));
	const built = minifyHtml(replaceAllLiteral(html, SITE_NAME_PLACEHOLDER, siteName));
	if (baseHtmlCache.size >= BASE_HTML_CACHE_MAX) {
		const oldest = baseHtmlCache.keys().next().value;
		if (oldest !== undefined) {
			baseHtmlCache.delete(oldest);
		}
	}
	baseHtmlCache.set(key, built);
	return built;
}

let cardHtmlCache: string | null = null;

/** Build card.html with fragments, critical CSS and versioned asset URLs. The site name placeholder stays in. */
export function buildCardHtml(criticalCss: string): string {
	if (cardHtmlCache !== null) {
		return cardHtmlCache;
	}
	let html = staticText("card.html");
	html = injectSharedFragments(html);
	html = replaceAllLiteral(html, "<!-- CRITICAL_CSS -->", criticalCss);
	html = replaceAllLiteral(html, "/static/styles.css", assetPath("styles.css"));
	html = replaceAllLiteral(html, "/static/card.js", assetPath("card.js"));
	cardHtmlCache = minifyHtml(html);
	return cardHtmlCache;
}

export { replaceAllLiteral };
