// Port of the page-template plumbing in api_resource.py (~92-440):
// _inject_shared_fragments, _build_base_html, _build_card_html, the
// _STYLES_CSS_HASH/_APP_MIN_JS_HASH/_CARD_JS_HASH cache-busting query params,
// and _minify_html.

import {
	appMinJsHash,
	cardJsHash,
	cssHtml,
	faviconHtml,
	fontsHtml,
	footerHtml,
	preconnectsHtml,
	staticText,
	stylesCssHash,
} from "./assets";

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
	html = replaceAllLiteral(html, "/static/styles.css", `/static/styles.css?v=${stylesCssHash()}`);
	html = replaceAllLiteral(html, "/static/app.min.js", `/static/app.min.js?v=${appMinJsHash()}`);
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
	html = replaceAllLiteral(html, "/static/styles.css", `/static/styles.css?v=${stylesCssHash()}`);
	html = replaceAllLiteral(html, "/static/card.js", `/static/card.js?v=${cardJsHash()}`);
	cardHtmlCache = minifyHtml(html);
	return cardHtmlCache;
}

export { replaceAllLiteral };
