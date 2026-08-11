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
import type { FilterTree, Query } from "./nodes";
import { parseQuery } from "./parser";
import { rewriteQuery } from "./rewrite";

export { ParseError } from "./errors";
export type { FilterTree, FilterValue } from "./nodes";
export { parseQuery } from "./parser";
export { PyNumber } from "./pystr";
export { rewriteQuery } from "./rewrite";
export { canonicalStringify } from "./serialize";

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
 * Balance quotes and parentheses for typeahead searches
 * (mirrors api.parsing.parsing_f.balance_partial_query).
 */
export function balancePartialQuery(queryIn: string): string {
	let query = queryIn;
	const charToMirror: Record<string, string> = {
		"(": ")",
		"'": "'", // single quote is own mirror
		'"': '"', // double quote is own mirror
		")": "(",
	};
	const unbalancedClosingChars = new Set([")"]);
	const quoteChars = new Set(["'", '"']);

	// A word character either side of an apostrophe makes it part of the word rather than an
	// opening quote — the same rule scanWordEnd applies in the tokenizer. Without this the balancer
	// "closes" the apostrophe in urza's, producing urza's', which does not parse.
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
			index + 1 < chars.length &&
			wordChar.test(chars[index + 1] as string)
		) {
			continue; // word-internal apostrophe
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
