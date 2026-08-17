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
import { rewriteQuery } from "./rewrite";
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
export { rewriteQuery } from "./rewrite";
export { canonicalStringify } from "./serialize";
export { foldTypographicQuotes } from "./tokenizer";

/**
 * Parse a Scryfall search query into a card-specific AST
 * (mirrors api.parsing.parsing_f.parse_scryfall_query: parse => rewrite).
 */
export function parseScryfallQueryAst(query: string | null | undefined): Query {
	return rewriteQuery(parseQuery(query));
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

/**
 * Balance quotes and parentheses for typeahead searches
 * (mirrors api.parsing.parsing_f.balance_partial_query).
 */
export function balancePartialQuery(queryIn: string): string {
	// The balancer and the lexer must agree about which characters are quotes, or a typed `name:‘`
	// balances to nothing here and then fails to lex as an unclosed `name:'` after parseQuery
	// folds it. Same fold, same position: before anything reads a character as a delimiter.
	let query = foldTypographicQuotes(queryIn);
	const charToMirror: Record<string, string> = {
		"(": ")",
		"'": "'", // single quote is own mirror
		'"': '"', // double quote is own mirror
		")": "(",
	};
	const unbalancedClosingChars = new Set([")"]);
	const quoteChars = new Set(["'", '"']);

	// An apostrophe preceded by a word character and followed by either another word character or
	// NOTHING is part of the word rather than an opening quote — the same rule scanWordEnd applies
	// in the tokenizer, and the two must agree exactly or the balancer emits something the lexer
	// rejects. Without the "or nothing", "urza'" balanced to "urza''", which parses as `urza` AND
	// an empty quoted string: the search widened to every card containing "urza" and the
	// explanation rendered "the name contains Urza and " with nothing after the "and".
	const wordChar = /[\p{L}\p{N}_.]/u;

	const currentStack: string[] = [];
	const chars = [...query];
	for (const [index, char] of chars.entries()) {
		// When inside a quoted string, only the matching closing quote ends it.
		const top = currentStack[currentStack.length - 1];
		if (top !== undefined && quoteChars.has(top)) {
			if (char === top) {
				currentStack.pop();
			}
			continue;
		}

		if (
			char === "'" &&
			index > 0 &&
			wordChar.test(chars[index - 1] as string) &&
			(index + 1 >= chars.length || wordChar.test(chars[index + 1] as string))
		) {
			continue; // apostrophe inside a word, or trailing one mid-type
		}

		const mirroredChar = charToMirror[char];
		if (!mirroredChar) {
			continue;
		}
		if (currentStack.length > 0 && currentStack[currentStack.length - 1] === mirroredChar) {
			currentStack.pop();
		} else {
			if (unbalancedClosingChars.has(char)) {
				throw new ParseError(`Unbalanced closing character '${char}' cannot be balanced`);
			}
			currentStack.push(char);
		}
	}
	while (currentStack.length > 0) {
		const char = currentStack.pop() as string;
		query += charToMirror[char] as string;
	}
	return query;
}
