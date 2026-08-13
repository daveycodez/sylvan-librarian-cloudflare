// A parsed query that is a VALUE rather than a PREDICATE must be a 400, not a 500.
//
// Driven through the REAL parser rather than a fake, because the whole point is which production
// queries land in this branch. `/search?q=1` answered 500 in production on 2026-08-13 — the engine
// was handed a NumericValueNode and had nothing to evaluate it as. Upstream answers 400 for the same
// inputs (checked against sylvan-librarian.com), and its parser fixtures pin `1` and `cmc-power` to
// real trees, so the rejection belongs here rather than in the parser.

import { describe, expect, test } from "bun:test";
import { parseScryfallQuery } from "../../src/parser";
import { arithmeticNotComparedMessage, usesValueAsPredicate } from "../../src/routes/query-validation";

/** Parse for real, then ask the validator — the exact sequence the routes perform. */
function rejects(query: string): boolean {
	return usesValueAsPredicate(parseScryfallQuery(query));
}

describe("value expressions used as predicates", () => {
	// The four shapes that 500'd in production, and the nesting that hides them.
	test.each([
		["1", "bare integer — the reported production 500"],
		["2", "any bare integer, not just 1"],
		["12", "multi-digit"],
		["007", "leading zeroes still lex as a number"],
		["3.5", "bare float"],
		["1+2", "arithmetic over literals"],
		["cmc-power", "arithmetic over attributes, no spaces"],
		["power - cmc", "arithmetic over attributes, spaced"],
	])("%s is not a filter (%s)", (query) => {
		expect(rejects(query)).toBe(true);
	});

	test("a bare number ANDed with a real filter is still rejected", () => {
		// `t:elf 1` parses to And(t:elf, 1). The offending node is an operand, not the root, so a
		// root-only check would pass this straight through to the engine.
		expect(rejects("t:elf 1")).toBe(true);
	});

	test("a negated bare number is still rejected", () => {
		// `-1` parses to Not(NumericValueNode), so negation is boolean position too.
		expect(rejects("-1")).toBe(true);
	});
});

describe("real filters are left alone", () => {
	// The false-positive direction is the dangerous one: it turns working searches into 400s.
	test.each([
		["elf", "implicit name"],
		["1x", "a number with a letter is a name, not arithmetic"],
		["x1", "and the other way round"],
		["t:elf", "attribute comparison"],
		["t:elf x", "filter plus an implicit name"],
		["cmc:1", "a NumericValueNode is legal as a comparison operand"],
		["cmc>=3", "comparison operators are predicates"],
		["cmc+1>3", "arithmetic IS allowed inside a comparison — upstream's own example"],
		["name:elf", "explicit name"],
		["t:goblin cmc<3 c:r", "conjunction of comparisons"],
		["t:elf or t:goblin", "disjunction"],
		["-t:elf", "negated comparison"],
		["lightning bolt", "multi-word implicit name"],
		["", "the empty query is TrueNode"],
	])("%s is a filter (%s)", (query) => {
		expect(rejects(query)).toBe(false);
	});
});

describe("the message", () => {
	test("matches upstream verbatim, carrying the whole query", () => {
		// Upstream quotes the FULL query, not the offending term — `t:elf 1`, not `1`.
		expect(arithmeticNotComparedMessage("t:elf 1")).toBe(
			"The search query 't:elf 1' contains invalid syntax. " +
				"Arithmetic expressions like 'cmc+1' need to be part of a comparison (e.g., 'cmc+1>3').",
		);
	});
});

describe("unrecognised shapes stay legal", () => {
	test("a node type the validator does not know is not rejected", () => {
		// Deliberate asymmetry: a miss leaves a 500 for some exotic shape, a false positive breaks a
		// working search. Unknown shapes therefore pass.
		expect(usesValueAsPredicate({ node_type: "SomeFutureNode", kwargs: {} })).toBe(false);
	});

	test("non-nodes are not rejected", () => {
		expect(usesValueAsPredicate(null)).toBe(false);
		expect(usesValueAsPredicate("nope")).toBe(false);
	});
});
