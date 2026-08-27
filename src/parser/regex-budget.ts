/**
 * Static regex pattern and query-level limits for public search
 * (port of api/parsing/regex_budget.py, upstream #1047).
 *
 * Enforced on the POST-REWRITE AST, so only patterns that will actually run as a regex are checked
 * — `lowerLiteralRegexes` has already turned `o:/flying/` into a plain `StringValueNode` by then,
 * and a literal that never reaches a regex engine has nothing to bound.
 *
 * Runtime limits live elsewhere: the engine's own backtrack budget is in
 * `vendor/sylvan_librarian/card_engine/src/regex_compat.rs`. This module is parse-time static
 * bounds only, and it is the half that can refuse a pattern before any candidate is walked.
 *
 * ── TWO DELIBERATE DIVERGENCES FROM UPSTREAM ────────────────────────────────
 *
 * 1. **Node counting.** Upstream measures pattern complexity with CPython's `re._parser` AST
 *    (`MAX_REGEX_AST_NODES = 64`, counting non-literal ops). There is no such parser here, and
 *    reimplementing `sre` to match its node count exactly would be a far larger and more fragile
 *    thing than the bound is worth. This counts CONSTRUCTS instead — classes, groups, quantifiers,
 *    anchors, escapes and metacharacters — over a single lexical scan. The two counts are close in
 *    shape but not equal, so the constant is stated separately rather than reused, and a pattern
 *    sitting exactly at one tree's limit may sit either side of the other's. Both refuse the same
 *    class of pattern; neither is claimed to refuse byte-identically.
 *
 * 2. **Malformedness is judged by a different regex parser.** Upstream quotes CPython's `sre`
 *    wording back to the user; this quotes V8's, because `RegExp` is the only pattern parser in a
 *    Worker. Both reject the same malformed patterns — the parity fixtures pin the TYPE of the
 *    rejection, not the sentence — and the sentence is the part that cannot be made to match.
 *
 * Backreferences and conditionals are rejected here as upstream rejects them, even though
 * `CompiledRegex` can run a backreference on `fancy_regex`. That capability is not the public
 * surface's to spend: upstream's parse-time refusal means its SQL path never sees one either, so
 * accepting them here would make the two trees answer the same query differently — which is the one
 * thing a port exists to prevent.
 */

import { AndNode, type BinaryOperatorNode, NotNode, OrNode, type Query, type QueryNode, RegexValueNode } from "./nodes";
import { InvalidRegexPatternError, QueryBudgetExceeded, utf8ByteLength } from "./query-budget";

/** Regex leaves one query may carry. A decklist-shaped OR chain of names carries none. */
export const MAX_REGEX_LEAVES_PER_QUERY = 10;
/** Bytes in one pattern. Upstream's figure. */
export const MAX_PATTERN_UTF8_BYTES = 256;
/** Lookarounds in one pattern. Upstream's MAX_LOOKAROUNDS_PER_PATTERN. */
export const MAX_LOOKAROUNDS_PER_PATTERN = 4;
/** `|` alternatives in one pattern. Upstream's figure. */
export const MAX_ALTERNATIONS_PER_PATTERN = 32;
/**
 * Constructs in one pattern — this port's stand-in for upstream's AST node count.
 * See divergence 1; the number is upstream's 64, the unit is not identical.
 */
export const MAX_REGEX_CONSTRUCTS = 64;
/** `(` nesting depth in one pattern. Upstream's figure. */
export const MAX_REGEX_PARSE_DEPTH = 16;
/** Largest explicit `{n}` / `{m,n}` bound, and the largest product of nested ones. */
export const MAX_QUANTIFIER_BOUND = 1024;

/** Reject `query` when any regex leaf is ill-formed or over budget. */
export function validateRegexPatterns(query: Query): void {
	const patterns = collectRegexPatterns(query.root);
	if (patterns.length > MAX_REGEX_LEAVES_PER_QUERY) {
		throw new QueryBudgetExceeded("regex_leaves");
	}
	for (const pattern of patterns) {
		enforcePatternLimits(pattern);
	}
}

function collectRegexPatterns(node: QueryNode): string[] {
	if (node instanceof AndNode || node instanceof OrNode) {
		return node.operands.flatMap(collectRegexPatterns);
	}
	if (node instanceof NotNode) {
		return collectRegexPatterns(node.operand);
	}
	const rhs = (node as BinaryOperatorNode).rhs;
	if (rhs instanceof RegexValueNode) {
		return [rhs.value];
	}
	return [];
}

interface PatternMetrics {
	constructs: number;
	depth: number;
	lookarounds: number;
	alternations: number;
	backreferences: number;
	conditionals: number;
	/** The product of nested explicit numeric quantifiers — `(a{100}){100}` is 10,000. */
	maxExplicitRepeat: number;
	/** True when a single `{m,n}` names a bound over MAX_QUANTIFIER_BOUND. */
	quantifierOverBound: boolean;
}

function enforcePatternLimits(pattern: string): void {
	if (utf8ByteLength(pattern) > MAX_PATTERN_UTF8_BYTES) {
		throw new QueryBudgetExceeded("regex_pattern");
	}

	const metrics = analyzePattern(pattern);

	// Conditionals and backreferences are refused BEFORE well-formedness, and the order is forced
	// rather than chosen: upstream's `sre` PARSES `(?(1)b)` happily and then rejects it as a
	// conditional, while V8's `RegExp` — the only pattern parser here — has no conditional syntax at
	// all and calls it malformed. Checking it first is what makes the two trees agree that
	// `o:/(a)(?(1)b)/` is over budget rather than mistyped.
	if (metrics.backreferences > 0 || metrics.conditionals > 0) {
		throw new QueryBudgetExceeded("regex_pattern");
	}

	// Then well-formedness, before the remaining bounds: a pattern that is not a regex at all
	// should be told so, not refused with the budget's deliberately uninformative message.
	checkPatternIsWellFormed(pattern);

	if (metrics.quantifierOverBound || metrics.maxExplicitRepeat > MAX_QUANTIFIER_BOUND) {
		throw new QueryBudgetExceeded("regex_pattern");
	}
	if (metrics.lookarounds > MAX_LOOKAROUNDS_PER_PATTERN) {
		throw new QueryBudgetExceeded("regex_pattern");
	}
	if (metrics.alternations > MAX_ALTERNATIONS_PER_PATTERN) {
		throw new QueryBudgetExceeded("regex_pattern");
	}
	if (metrics.constructs > MAX_REGEX_CONSTRUCTS || metrics.depth > MAX_REGEX_PARSE_DEPTH) {
		throw new QueryBudgetExceeded("regex_pattern");
	}
}

/** `{m}` / `{m,n}` / `{m,}` at `i` (which points at the `{`), or null when it is a literal brace. */
function readQuantifier(pattern: string, i: number): { lower: number; upper: number | null; end: number } | null {
	const close = pattern.indexOf("}", i);
	if (close === -1) return null;
	const body = pattern.slice(i + 1, close);
	const m = /^(\d*)(,?)(\d*)$/.exec(body);
	if (!m) return null;
	const [, lo, comma, hi] = m as unknown as [string, string, string, string];
	// `{}` and `{,}` are literal braces to every engine here, not quantifiers.
	if (lo === "" && hi === "") return null;
	// `{,n}` is a literal brace in PostgreSQL ARE and in the `regex` crate alike.
	if (lo === "") return null;
	const lower = Number.parseInt(lo, 10);
	const upper = comma === "" ? lower : hi === "" ? null : Number.parseInt(hi, 10);
	return { lower, upper, end: close };
}

/**
 * One lexical pass over `pattern`, collecting every bounded metric.
 *
 * Character classes are stepped over as opaque spans, exactly as the tokenizer and the balancer do
 * with quoted strings: `[|(){2}]` contains no alternation, no group and no quantifier, and counting
 * one there would refuse a pattern for punctuation it treats as literal. A `]` in first position is
 * literal (POSIX), so it does not close the class — the same rule `translateAreEscapes` follows.
 *
 * `maxExplicitRepeat` needs the group stack rather than a running total: a quantifier applies to the
 * group that just closed, and nesting MULTIPLIES, which is the shape that turns a 256-byte pattern
 * into exponential work.
 */
function analyzePattern(pattern: string): PatternMetrics {
	let constructs = 0;
	let depth = 0;
	let maxDepth = 0;
	let lookarounds = 0;
	let alternations = 0;
	let backreferences = 0;
	let conditionals = 0;
	let quantifierOverBound = false;

	// One entry per open group: the repeat factor accumulated inside it. Index 0 is the whole
	// pattern, which is why the stack starts non-empty.
	const repeatStack: number[] = [1];
	// The repeat factor of the construct a quantifier would apply to — the group that just closed,
	// or 1 for a single character.
	let lastAtomRepeat = 1;
	let maxExplicitRepeat = 1;

	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i] as string;

		if (c === "\\") {
			const next = pattern[i + 1];
			if (next !== undefined) {
				// `\1`-`\9` and the named/relative spellings.
				if (/[1-9gGkK]/.test(next)) {
					backreferences += 1;
				}
				constructs += 1;
				lastAtomRepeat = 1;
				i += 2;
				continue;
			}
			constructs += 1;
			i += 1;
			continue;
		}

		if (c === "[") {
			// Opaque span. A leading `^` then a leading `]` are both literal inside it.
			let j = i + 1;
			if (pattern[j] === "^") j += 1;
			if (pattern[j] === "]") j += 1;
			while (j < pattern.length && pattern[j] !== "]") {
				j += pattern[j] === "\\" ? 2 : 1;
			}
			constructs += 1;
			lastAtomRepeat = 1;
			i = j < pattern.length ? j + 1 : j;
			continue;
		}

		if (c === "(") {
			const rest = pattern.slice(i);
			if (rest.startsWith("(?(")) {
				conditionals += 1;
			} else if (
				rest.startsWith("(?=") ||
				rest.startsWith("(?!") ||
				rest.startsWith("(?<=") ||
				rest.startsWith("(?<!")
			) {
				lookarounds += 1;
			} else if (rest.startsWith("(?P=")) {
				backreferences += 1;
			}
			constructs += 1;
			depth += 1;
			maxDepth = Math.max(maxDepth, depth);
			repeatStack.push(1);
			i += 1;
			continue;
		}

		if (c === ")") {
			// The group's own accumulated factor becomes the atom a following quantifier multiplies.
			lastAtomRepeat = repeatStack.length > 1 ? (repeatStack.pop() as number) : 1;
			depth = Math.max(0, depth - 1);
			i += 1;
			continue;
		}

		if (c === "|") {
			alternations += 1;
			constructs += 1;
			lastAtomRepeat = 1;
			i += 1;
			continue;
		}

		if (c === "{") {
			const q = readQuantifier(pattern, i);
			if (q !== null) {
				constructs += 1;
				// `{m,}` with m > 1 is explicit and unbounded above; `*`/`+`/`?` are neither.
				if (q.upper === null ? q.lower > 1 : q.lower > MAX_QUANTIFIER_BOUND || q.upper > MAX_QUANTIFIER_BOUND) {
					quantifierOverBound = true;
				}
				const factor = q.upper ?? q.lower;
				const applied = factor * lastAtomRepeat;
				maxExplicitRepeat = Math.max(maxExplicitRepeat, applied);
				// Fold it into the enclosing group, so an outer `{n}` multiplies this one.
				const top = repeatStack.length - 1;
				repeatStack[top] = Math.max(repeatStack[top] as number, applied);
				lastAtomRepeat = applied;
				i = q.end + 1;
				continue;
			}
			// A literal brace.
			lastAtomRepeat = 1;
			i += 1;
			continue;
		}

		if (c === "*" || c === "+" || c === "?" || c === "." || c === "^" || c === "$") {
			constructs += 1;
			i += 1;
			continue;
		}

		lastAtomRepeat = 1;
		i += 1;
	}

	return {
		constructs,
		depth: maxDepth,
		lookarounds,
		alternations,
		backreferences,
		conditionals,
		maxExplicitRepeat,
		quantifierOverBound,
	};
}

/**
 * Reject a pattern no engine in this tree can compile, quoting the reason back.
 *
 * Separate from the budget above because the two answer differently: an over-budget pattern is
 * refused with a fixed message that discloses nothing, while a MALFORMED one is a user mistake and
 * saying what is wrong with it is the whole help. `RegExp` is the only regex parser available here,
 * and it is a strict enough reader to catch the malformed cases (unbalanced parens, a dangling
 * quantifier, an unterminated class) — the dialect differences that make it the WRONG acceptor for
 * a query regex are all cases where it accepts something the engine also accepts.
 */
export function checkPatternIsWellFormed(pattern: string): void {
	try {
		new RegExp(pattern, "iu");
	} catch {
		// `u` mode rejects ARE spellings (`\y`, `\m`) that this port translates and the engine
		// takes; re-read without it before calling the pattern malformed.
		try {
			new RegExp(pattern, "i");
		} catch (err) {
			throw new InvalidRegexPatternError(err instanceof Error ? stripPositionSuffix(err.message) : "invalid pattern");
		}
	}
}

/** Drop V8's ` at position N` / `: /…/: ` framing so the reason reads like the SQL path's. */
function stripPositionSuffix(message: string): string {
	const colon = message.lastIndexOf("/: ");
	const reason = colon === -1 ? message : message.slice(colon + 3);
	return reason.replace(/ at position \d+$/, "");
}
