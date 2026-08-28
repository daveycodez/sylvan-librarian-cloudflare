/**
 * TypeScript port of Sylvan Librarian's Scryfall-syntax query parser.
 *
 * parseScryfallQuery(query) returns the engine-wire JSON tree — exactly what
 * the Python side hands the Rust engine: parse_scryfall_query(query).to_json()
 * (the engine calls filters.to_json() and orjson.dumps it, see
 * card_engine/src/lib.rs bind_and_split_filter). Output parity with the Python
 * parser is enforced byte-for-byte by tests/parser/parity.test.ts against
 * fixtures exported from the vendored upstream corpus.
 *
 * Every failure (lex, parse, or serialization-time validation) throws
 * ParseError carrying the same message Python's ValueError does.
 */

import { ParseError } from "./errors";
import type { DirectiveFound, ExpandedDerivedTerm, FilterTree, LoweredRegexTerm, Query } from "./nodes";
import { parseQuery } from "./parser";
import { checkQueryByteLength } from "./query-budget";
import { validateRegexPatterns } from "./regex-budget";
import { flattenAndDeduplicateCompounds, rewriteQuery } from "./rewrite";
import { braceCloseIndex, findCloseIndex, opensRegex, QUOTE_CHARS } from "./spans";
import { foldTypographicQuotes } from "./tokenizer";

export { ParseError } from "./errors";
export type {
	DirectiveFound,
	ExpandedDerivedTerm,
	FilterTree,
	FilterValue,
	LoweredRegexTerm,
	QueryTerm,
} from "./nodes";
export { parseQuery } from "./parser";
export { PyNumber } from "./pystr";
export {
	boundedQueryLogContext,
	checkQueryByteLength,
	checkSearchParamLengths,
	InvalidRegexPatternError,
	MAX_QUERY_UTF8_BYTES,
	QUERY_REGEX_REJECTED_MESSAGE,
	QUERY_TOO_LONG_MESSAGE,
	QueryBudgetExceeded,
} from "./query-budget";
export { validateRegexPatterns } from "./regex-budget";
export { flattenAndDeduplicateCompounds, regexPlainLiteral, rewriteQuery } from "./rewrite";
export { canonicalStringify } from "./serialize";
export { foldTypographicQuotes } from "./tokenizer";

/**
 * The shared post-parse pipeline (mirrors api.parsing.post_parse.finalize_query, upstream #1050):
 * semantic rewrites, then the static regex limits, then flatten+dedupe normalization.
 *
 * The order is load-bearing in both directions. Rewrites run FIRST because `lowerLiteralRegexes`
 * turns a literal `/…/` into a plain string, and a pattern that will never reach a regex engine
 * should not be charged against the regex budget. Dedupe runs LAST, after that budget, so
 * repeating one expensive pattern ten times still counts as ten leaves.
 */
export function finalizeQuery(queryIn: Query): Query {
	const query = rewriteQuery(queryIn);
	validateRegexPatterns(query);
	return flattenAndDeduplicateCompounds(query);
}

/**
 * Parse a Scryfall search query into a card-specific AST
 * (mirrors api.parsing.parse_scryfall_query: byte-length check => parse => finalize).
 */
export function parseScryfallQueryAst(query: string | null | undefined): Query {
	if (query !== null && query !== undefined) {
		checkQueryByteLength(query);
	}
	return finalizeQuery(parseQuery(query));
}

/**
 * Parse a Scryfall search query to the engine-wire JSON filter tree.
 *
 * Numeric leaf values are PyNumber instances (preserving Python's int/float
 * distinction); use canonicalStringify() to obtain the byte-exact JSON string
 * the Python side would produce.
 */
export function parseScryfallQuery(query: string | null | undefined): FilterTree {
	return parseScryfallQueryAst(query).toJson();
}

/**
 * Parse to the wire tree AND the in-query directives it carried (upstream #893).
 *
 * The stripping happens inside `rewriteQuery`, so `parseScryfallQuery` already
 * returns a tree with no directive leaves — this only additionally hands back
 * what was stripped, for the route layer to fold into the search parameters.
 *
 * `loweredRegexTerms` rides along for the same reason: the rewrite ERASES the difference between
 * `name:/zzzqq/` and `name:"zzzqq"` — and between `t:/token/` and `t:token` — while Scryfall's
 * `include_extras` auto-enable separates both pairs. See `Query.loweredRegexTerms`.
 *
 * `expandedDerivedTerms` is the same fact one rewrite further along: `expandDerivedPredicates`
 * erases the difference between `is:split` and `layout:split`, and that auto-enable separates those
 * too. See `Query.expandedDerivedTerms`.
 */
export function parseScryfallQueryWithDirectives(query: string | null | undefined): {
	tree: FilterTree;
	directives: readonly DirectiveFound[];
	warnings: readonly string[];
	loweredRegexTerms: readonly LoweredRegexTerm[];
	expandedDerivedTerms: readonly ExpandedDerivedTerm[];
} {
	const parsed = parseScryfallQueryAst(query);
	return {
		tree: parsed.toJson(),
		directives: parsed.directives,
		warnings: parsed.warnings,
		loweredRegexTerms: parsed.loweredRegexTerms,
		expandedDerivedTerms: parsed.expandedDerivedTerms,
	};
}

/** The suffix that closes a span left open — escaping a dangling `\` first, or the closer would escape THAT. */
function closerForPartialSpan(danglingEscape: boolean, closer: string): string {
	return (danglingEscape ? "\\" : "") + closer;
}

/**
 * Balance parentheses for typeahead searches, skipping over quotes, regexes and mana symbols
 * (mirrors api.parsing.parsing_f.balance_partial_query).
 *
 * Parentheses are the only construct that nests, so tracking depth is a counter rather than a
 * stack. The opaque spans never go on it: each one is resolved to its closer and stepped over
 * whole, which is what keeps the quotes, parens and metacharacters inside them from being read as
 * structure. The span rules come from spans.ts so the balancer and the lexer cannot drift apart —
 * where they disagree, the balancer "fixes" a quote the lexer never saw (upstream #905).
 */
export function balancePartialQuery(queryIn: string): string {
	// The balancer and the lexer must agree about which characters are quotes, or a typed `name:‘`
	// balances to nothing here and then fails to lex as an unclosed `name:'` after parseQuery
	// folds it. Same fold, same position: before anything reads a character as a delimiter.
	const query = foldTypographicQuotes(queryIn);
	const chars = [...query];
	let openParens = 0;
	// Closer for whichever span is still open at the end of the query. Only one is ever needed,
	// because everything after an unterminated opener is span content — there is nothing left to
	// open, and nothing after it to close. That is also why it can be appended before the parens:
	// an unterminated span is necessarily the innermost thing open.
	let spanSuffix = "";

	// An apostrophe preceded by a word character and followed by either another word character or
	// NOTHING is part of the word rather than an opening quote — the same rule scanWordEnd applies
	// in the tokenizer, and the two must agree exactly or the balancer emits something the lexer
	// rejects. Without the "or nothing", "urza'" balanced to "urza''", which parses as `urza` AND an
	// empty quoted string: the search widened to every card containing "urza" and the explanation
	// rendered "the name contains Urza and " with nothing after the "and".
	const wordChar = /[\p{L}\p{N}_.]/u;

	let pos = 0;
	while (pos < chars.length) {
		const char = chars[pos] as string;
		pos += 1;

		if (
			char === "'" &&
			pos - 1 > 0 &&
			wordChar.test(chars[pos - 2] as string) &&
			(pos === chars.length || wordChar.test(chars[pos] as string))
		) {
			continue; // apostrophe inside a word, or trailing one mid-type
		}

		// A quoted string, a /regex/ and a {mana symbol} are all opaque: the quotes and parens inside
		// them are content, not delimiters.
		if (QUOTE_CHARS.has(char)) {
			const { closeIndex, danglingEscape } = findCloseIndex(chars, pos, char);
			if (closeIndex === null) {
				spanSuffix = closerForPartialSpan(danglingEscape, char);
				break;
			}
			pos = closeIndex + 1;
			continue;
		}

		// A '/' in value position opens a regex; anywhere else it is division, an ordinary character.
		if (char === "/") {
			if (opensRegex(chars, pos - 1)) {
				const { closeIndex, danglingEscape } = findCloseIndex(chars, pos, "/");
				if (closeIndex === null) {
					// Still being typed. Close the regex rather than reading on, or the metacharacters
					// the user has typed so far get balanced as query structure: `o:/[)` is a partial
					// `o:/[)]/`, not a stray ')'.
					spanSuffix = closerForPartialSpan(danglingEscape, "/");
					break;
				}
				pos = closeIndex + 1;
			}
			continue;
		}

		// A '{mana symbol}' is opaque whatever it holds, and an unterminated one gets closed for the
		// same reason an unterminated quote does: the lexer demands a '}' for every '{', so leaving
		// it open would make 'mana:{' — a prefix of 'mana:{W}' — unlexable while it is being typed.
		// No escapes exist inside a mana symbol, so there is no dangling-backslash case here.
		if (char === "{") {
			const closeIndex = braceCloseIndex(chars, pos);
			if (closeIndex === null) {
				spanSuffix = "}";
				break;
			}
			pos = closeIndex + 1;
			continue;
		}

		if (char === "(") {
			openParens += 1;
		} else if (char === ")") {
			if (openParens === 0) {
				throw new ParseError(`Unbalanced closing character '${char}' cannot be balanced`);
			}
			openParens -= 1;
		}
	}

	return query + spanSuffix + ")".repeat(openParens);
}
