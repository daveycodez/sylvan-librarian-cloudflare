// The hand-built filter trees, pinned against the real parser.
//
// src/routes/scryfall-compat/trees.ts builds these by hand rather than by parsing, to keep 75
// collection identifiers off the isolate's 10ms CPU budget. That is only safe while the trees it
// builds are trees the parser could have produced — a shape the engine has never been handed is
// a shape nothing has tested. This is the check that keeps the two in step.

import { describe, expect, test } from "bun:test";
import { canonicalStringify, parseScryfallQueryWithDirectives } from "../../src/parser";
import { setAndCollectorNumber, TRUE_TREE } from "../../src/routes/scryfall-compat/trees";

// The REAL parser, deliberately, not `loadParser()`: tests/routes/harness.ts installs a fake
// through setParserForTests, and once any route test has imported it this file would be comparing
// the fake against itself — which passed in isolation and failed in the full run, which is the
// worst way for a pinning test to be wrong.
//
// The ENGINE-WIRE tree, which is what the engine is handed, not parseQuery's internal one.
const viaParser = (query: string): string => canonicalStringify(parseScryfallQueryWithDirectives(query).tree);

describe("hand-built filter trees match the parser", () => {
	test("the unfiltered listing", () => {
		expect(TRUE_TREE).toBe(viaParser(""));
	});

	test("set code and collector number pin English implicitly", () => {
		// The default language is EMITTED, never omitted: a lang-less tree would resolve whichever
		// row the engine prefers once foreign printings share a set and collector number.
		expect(setAndCollectorNumber("lea", "1")).toBe(viaParser('set=lea cn="1" lang=en'));
	});

	test("a collector number that is not an integer", () => {
		// The reason `=` is used rather than `:`. `cn:1a` would route to collector_number_int, the
		// NUMERIC column, and match nothing — Scryfall's collector numbers include "1a", "12★" and
		// "A-42".
		expect(setAndCollectorNumber("neo", "1a")).toBe(viaParser('set=neo cn="1a" lang=en'));
	});

	test("a named language", () => {
		expect(setAndCollectorNumber("m15", "18", "ja")).toBe(viaParser('set=m15 cn="18" lang=ja'));
	});
});
