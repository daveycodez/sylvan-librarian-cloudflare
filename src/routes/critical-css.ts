// Port of api/utils/css_utils.py build_critical_css: extract the allowlisted
// critical rules from styles.css for inlining into the page <style> block.
// Upstream parses with tinycss2; this port uses a minimal scanner that
// understands exactly what build_critical_css consumes — top-level qualified
// rules and @media blocks — while respecting strings and comments, and keeps
// each kept rule's original source text (tinycss2.serialize reproduces token
// source verbatim, so the outputs agree once _minify has run).

// Selectors inlined into the HTML <style> block (upstream _CRITICAL_SELECTORS).
const CRITICAL_SELECTORS = new Set([
	'[data-theme="light"]',
	'[data-theme="dark"]',
	"*",
	"html",
	"body",
	".container",
	".spacer",
	".spacer-30",
	".spacer-20",
	".header",
	".theme-toggle",
	".header h1",
	".header p",
	".search-container",
	".search-box",
	".search-input",
	".help-icon",
	".order-controls",
	".dropdown-label",
	".order-dropdown",
	".order-toggle",
	".arrow-up",
	// Results grid — needed for SSR search result pages
	".results-container",
	".card-item",
	".card-image",
	".card-name-mana-row",
	".card-name",
	".card-mana",
	".ms-cost",
	".mana-symbol",
	".card-type",
	".card-text",
	".card-set-power-row",
	".card-set",
	".card-power-toughness",
	".results-count",
	"#statusMessage",
	// Footer — margin-top:auto positions it; missing this causes it to jump on styles load
	".footer",
	".footer-legal", // also matches the comma rule .footer-legal, .footer-attribution, .footer-links
	".footer-attribution a",
	".footer-links a",
]);

function selectorIsCritical(selector: string): boolean {
	return selector.split(",").some((part) => CRITICAL_SELECTORS.has(part.trim()));
}

/** Upstream _minify: strip comments and collapse avoidable whitespace. */
function minifyCss(css: string): string {
	let out = css.replace(/\/\*[\s\S]*?\*\//g, "");
	out = out.replace(/\s+/g, " ");
	out = out.replace(/\s*([{};:,>])\s*/g, "$1");
	out = out.replace(/;\}/g, "}");
	return out.trim();
}

interface QualifiedRule {
	kind: "qualified";
	selector: string;
	/** Original source text: prelude + braced block. */
	text: string;
}

interface AtRule {
	kind: "at";
	keyword: string;
	/** Prelude between the at-keyword and the block/semicolon. */
	prelude: string;
	/** Text inside the braces, or null for statement at-rules. */
	content: string | null;
}

type Rule = QualifiedRule | AtRule;

/**
 * Re-serialize CSS string tokens the way tinycss2 does: always double-quoted,
 * with backslash and double-quote escaped. Upstream's selector allowlist
 * matches serialized preludes, so `[data-theme='light']` in styles.css must
 * become `[data-theme="light"]` both for matching and in the output.
 * Comments are copied verbatim (the minifier strips them later).
 */
function normalizeStrings(css: string): string {
	let out = "";
	let i = 0;
	while (i < css.length) {
		const ch = css[i];
		if (ch === "/" && css[i + 1] === "*") {
			const end = skipComment(css, i);
			out += css.slice(i, end);
			i = end;
		} else if (ch === '"' || ch === "'") {
			const end = skipString(css, i);
			let body = css.slice(i + 1, end);
			if (body.endsWith(ch)) {
				body = body.slice(0, -1);
			}
			// Unescape the simple escapes a stylesheet author writes, then
			// re-escape for a double-quoted token.
			const value = body.replace(/\\(['"\\])/g, "$1");
			out += `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
			i = end;
		} else {
			out += ch;
			i += 1;
		}
	}
	return out;
}

/** Index just past a comment starting at pos ("/*"), or the string end. */
function skipComment(css: string, pos: number): number {
	const end = css.indexOf("*/", pos + 2);
	return end === -1 ? css.length : end + 2;
}

/** Index just past a string literal starting at pos (quote char at pos). */
function skipString(css: string, pos: number): number {
	const quote = css[pos];
	let i = pos + 1;
	while (i < css.length) {
		if (css[i] === "\\") {
			i += 2;
		} else if (css[i] === quote || css[i] === "\n") {
			return i + 1;
		} else {
			i += 1;
		}
	}
	return i;
}

/** Index of the "}" matching the "{" at pos, or the string end. */
function matchBrace(css: string, pos: number): number {
	let depth = 0;
	let i = pos;
	while (i < css.length) {
		const ch = css[i];
		if (ch === "/" && css[i + 1] === "*") {
			i = skipComment(css, i);
		} else if (ch === '"' || ch === "'") {
			i = skipString(css, i);
		} else if (ch === "{") {
			depth += 1;
			i += 1;
		} else if (ch === "}") {
			depth -= 1;
			i += 1;
			if (depth === 0) {
				return i - 1;
			}
		} else {
			i += 1;
		}
	}
	return css.length;
}

/** Top-level rules of a stylesheet or rule list, comments/whitespace between rules skipped. */
function parseRuleList(css: string): Rule[] {
	const rules: Rule[] = [];
	let i = 0;
	while (i < css.length) {
		const ch = css[i] as string;
		if (/\s/.test(ch)) {
			i += 1;
			continue;
		}
		if (ch === "/" && css[i + 1] === "*") {
			i = skipComment(css, i);
			continue;
		}
		if (ch === "@") {
			const keywordMatch = /^@([\w-]+)/.exec(css.slice(i));
			const keyword = keywordMatch?.[1] ?? "";
			let j = i + 1 + keyword.length;
			const preludeStart = j;
			while (j < css.length && css[j] !== "{" && css[j] !== ";") {
				if (css[j] === "/" && css[j + 1] === "*") {
					j = skipComment(css, j);
				} else if (css[j] === '"' || css[j] === "'") {
					j = skipString(css, j);
				} else {
					j += 1;
				}
			}
			if (j >= css.length || css[j] === ";") {
				rules.push({ kind: "at", keyword, prelude: css.slice(preludeStart, j), content: null });
				i = j + 1;
				continue;
			}
			const close = matchBrace(css, j);
			rules.push({
				kind: "at",
				keyword,
				prelude: css.slice(preludeStart, j),
				content: css.slice(j + 1, close),
			});
			i = close + 1;
			continue;
		}
		// Qualified rule: prelude up to "{", then the block.
		const start = i;
		let j = i;
		while (j < css.length && css[j] !== "{") {
			if (css[j] === "/" && css[j + 1] === "*") {
				j = skipComment(css, j);
			} else if (css[j] === '"' || css[j] === "'") {
				j = skipString(css, j);
			} else {
				j += 1;
			}
		}
		if (j >= css.length) {
			break; // trailing garbage with no block — nothing to keep
		}
		const close = matchBrace(css, j);
		rules.push({
			kind: "qualified",
			selector: css.slice(start, j).trim(),
			text: css.slice(start, close + 1),
		});
		i = close + 1;
	}
	return rules;
}

/**
 * Extract and minify the critical rules from a stylesheet. `@media` blocks are
 * descended into and rebuilt around whichever of their rules are critical.
 */
export function buildCriticalCss(stylesCss: string): string {
	const parts: string[] = [];
	for (const rule of parseRuleList(normalizeStrings(stylesCss))) {
		if (rule.kind === "qualified") {
			if (selectorIsCritical(rule.selector)) {
				parts.push(rule.text);
			}
		} else if (rule.keyword === "media" && rule.content !== null) {
			const inner = parseRuleList(rule.content).filter(
				(r): r is QualifiedRule => r.kind === "qualified" && selectorIsCritical(r.selector),
			);
			if (inner.length > 0) {
				const condition = rule.prelude.trim();
				parts.push(`@media ${condition}{${inner.map((r) => r.text).join("")}}`);
			}
		}
	}
	return minifyCss(parts.join(""));
}
