// Seam between the routes and src/parser. Routes consume the parser only
// through loadParser(), so tests can substitute a fake wire-tree parser (and
// simulate ParseError) without touching module resolution.

import {
	type DirectiveFound,
	type ExpandedDerivedTerm,
	InvalidRegexPatternError,
	type LoweredRegexTerm,
	ParseError,
	parseScryfallQuery,
	parseScryfallQueryWithDirectives,
	QueryBudgetExceeded,
} from "../parser";

export interface WireParser {
	/** Parse a Scryfall query string into the engine-wire filter tree JSON. */
	parseScryfallQuery(query: string): unknown;
	/**
	 * Same, plus the in-query directives the string carried (upstream #893) and the warnings the
	 * rewrite passes raised — today, `is:` values this server has no data for, which the search
	 * route surfaces so a no-match says WHY rather than looking like an empty corpus.
	 */
	parseWithDirectives(query: string): {
		tree: unknown;
		directives: readonly DirectiveFound[];
		warnings: readonly string[];
		/**
		 * The `field:/regex/` leaves the rewrite lowered to plain substrings — the one parse fact
		 * the wire tree cannot carry, and the compat route's `include_extras` auto-enable needs in
		 * both directions (`name:/zzzqq/` forces extras on where `name:"zzzqq"` does not;
		 * `t:/token/` does NOT where `t:token` does).
		 */
		loweredRegexTerms: readonly LoweredRegexTerm[];
		/**
		 * The derived `is:`/`has:` terms the rewrite replaced with subtrees, and the leaves each
		 * one left behind — the other parse fact the wire tree cannot carry. `is:split` becomes
		 * `layout:split`, which is byte-identical to a `layout:split` the caller typed, and only
		 * one of those two forces the extras gate on Scryfall.
		 */
		expandedDerivedTerms: readonly ExpandedDerivedTerm[];
	};
	/** True when err is the parser's ParseError (upstream: ValueError subclass → 400). */
	isParseError(err: unknown): boolean;
	/**
	 * The user-facing message for a query the parser refused on a public BOUND rather than on
	 * syntax (upstream #1041/#1047), or null when `err` is not one of those.
	 *
	 * Separate from `isParseError` because the answer is different, not just the wording: a budget
	 * rejection must NOT be reported as `Failed to parse query: "…"`. The query parsed fine — the
	 * message would be false, and echoing the query back is exactly what these messages avoid,
	 * since the input is attacker-shaped by the time a bound is reached. Without this the errors
	 * escape both handlers and land as 500s.
	 */
	queryBudgetMessage(err: unknown): string | null;
}

const realParser: WireParser = {
	parseScryfallQuery: (query: string) => parseScryfallQuery(query),
	parseWithDirectives: (query: string) => parseScryfallQueryWithDirectives(query),
	isParseError: (err: unknown) => err instanceof ParseError,
	queryBudgetMessage: (err: unknown) => {
		if (err instanceof QueryBudgetExceeded) return err.userMessage;
		// A malformed pattern is the one case in this family that DOES quote the input back — the
		// user typed a broken regex and needs to see which part broke, exactly as the SQL path's
		// InvalidRegularExpression handler tells them upstream.
		if (err instanceof InvalidRegexPatternError) return err.reason;
		return null;
	},
};

let testOverride: WireParser | null = null;

/** Test hook: substitute (or clear with null) the parser implementation. */
export function setParserForTests(parser: WireParser | null): void {
	testOverride = parser;
}

export async function loadParser(): Promise<WireParser> {
	return testOverride ?? realParser;
}
