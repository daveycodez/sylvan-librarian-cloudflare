// The hand-built filter trees, pinned against the real parser.
//
// src/routes/scryfall-compat/trees.ts builds these by hand rather than by parsing, to keep 75
// collection identifiers off the isolate's 10ms CPU budget. That is only safe while the trees it
// builds are trees the parser could have produced — a shape the engine has never been handed is
// a shape nothing has tested. This is the check that keeps the two in step.

import { describe, expect, test } from "bun:test";
import { canonicalStringify, parseScryfallQueryWithDirectives } from "../../src/parser";
import { scryfallNegations, setAndCollectorNumber, TRUE_TREE } from "../../src/routes/scryfall-compat/trees";

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

describe("a negated group that compares a face stat is asked as Scryfall answers it", () => {
	// `t:planeswalker -(loy>=1)` is a 404 on api.scryfall.com where `loy<1` is 4, `t:creature
	// -(pow>=3)` 39 and `-(pow>=3 t:elf) e:khm` 289 (2026-10-04): `pow`, `tou` and `loy` are
	// compared over a printing's two faces in three-valued logic. The engine answers that for a
	// `ScryfallNotNode` (engine/builder/tests/negated_face_stat.rs); this is where one is made.
	const tree = (query: string): unknown => parseScryfallQueryWithDirectives(query).tree;
	const types = (query: string): string[] =>
		[...canonicalStringify(scryfallNegations(tree(query)) as never).matchAll(/"node_type":"(\w*NotNode)"/g)].map(
			(m) => m[1] as string,
		);

	test.each([
		["t:planeswalker -(loy>=1)"],
		["-(pow>=3)"],
		["-(tou<2)"],
		["-(pow>tou)"],
		["-(pow>=3 t:elf) e:khm"],
		["-(pow>=3 or t:elf) e:khm"],
		["-(pow+1>cmc)"],
	])("%s is sent as a ScryfallNotNode", (query) => {
		expect(types(query)).toEqual(["ScryfallNotNode"]);
	});

	test("nested groups are each renamed, and the rest of the tree is untouched", () => {
		expect(types("-(-(pow>=3)) e:khm")).toEqual(["ScryfallNotNode", "ScryfallNotNode"]);
		expect(types("-(pow>=3) -t:elf")).toEqual(["ScryfallNotNode", "NotNode"]);
		const renamed = canonicalStringify(scryfallNegations(tree("-(pow>=3) t:elf")) as never);
		expect(renamed.replace("ScryfallNotNode", "NotNode")).toBe(canonicalStringify(tree("-(pow>=3) t:elf") as never));
	});

	test("a group with no face stat in it, and a tree with no negation, are the same object", () => {
		// `-(cmc>=3) e:khm t:elf` is 7 = `cmc<3`, `-(usd>=1)` = `usd<1`, `-(pt>=5) e:khm` 50: only
		// the three face stats are three-valued.
		for (const query of ["-(cmc>=3) t:elf", "-(usd>=1)", "-(pt>=5)", "-t:elf o:draw", "pow>=3 t:elf", "-(o:pow)"]) {
			const parsed = tree(query);
			expect(scryfallNegations(parsed)).toBe(parsed);
		}
	});
});
