// Seam between the routes and src/parser. Routes consume the parser only
// through loadParser(), so tests can substitute a fake wire-tree parser (and
// simulate ParseError) without touching module resolution.

import { type DirectiveFound, ParseError, parseScryfallQuery, parseScryfallQueryWithDirectives } from "../parser";

export interface WireParser {
	/** Parse a Scryfall query string into the engine-wire filter tree JSON. */
	parseScryfallQuery(query: string): unknown;
	/** Same, plus the in-query directives the string carried (upstream #893). */
	parseWithDirectives(query: string): { tree: unknown; directives: readonly DirectiveFound[] };
	/** True when err is the parser's ParseError (upstream: ValueError subclass → 400). */
	isParseError(err: unknown): boolean;
}

const realParser: WireParser = {
	parseScryfallQuery: (query: string) => parseScryfallQuery(query),
	parseWithDirectives: (query: string) => parseScryfallQueryWithDirectives(query),
	isParseError: (err: unknown) => err instanceof ParseError,
};

let testOverride: WireParser | null = null;

/** Test hook: substitute (or clear with null) the parser implementation. */
export function setParserForTests(parser: WireParser | null): void {
	testOverride = parser;
}

export async function loadParser(): Promise<WireParser> {
	return testOverride ?? realParser;
}
