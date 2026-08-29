// Card-text escaping parity with upstream (#1039).
//
// `format_card_text` is the ONE entry point through which raw `mana_cost`/`oracle_text` reaches
// HTML: it escapes exactly once and only then substitutes the mana-token vocabulary. Before it,
// the substitution ran on RAW text, so a card that prints `Look at a card & say "done".` reached
// the page with a live `&` and a live `"` — and this port had the same hole, because it is a port.
//
// Read straight from the vendored fixture rather than restated here, for the same reason
// tests/parser/semantics.test.ts reads balance_queries.json: the fixture is upstream's own, so a
// sync that changes it changes what this asserts, and the two implementations cannot drift
// silently. All four (isModal x convertNewlines) combinations are covered per case.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertManaSymbols, formatCardText, formatOracleText } from "../../src/routes/noscript";

type EscapingCase = {
	id: string;
	input: string;
	non_modal_no_newlines: string;
	non_modal_newlines: string;
	modal_no_newlines: string;
	modal_newlines: string;
};

const cases = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../../vendor/sylvan_librarian/api/static/fixtures/card_text_escaping_cases.json"),
		"utf8",
	),
) as EscapingCase[];

describe("formatCardText matches upstream's escaping fixture", () => {
	test("the fixture is actually loaded", () => {
		expect(cases.length).toBeGreaterThan(10);
	});

	for (const c of cases) {
		test(c.id, () => {
			expect(formatCardText(c.input, false, false)).toBe(c.non_modal_no_newlines);
			expect(formatCardText(c.input, false, true)).toBe(c.non_modal_newlines);
			expect(formatCardText(c.input, true, false)).toBe(c.modal_no_newlines);
			expect(formatCardText(c.input, true, true)).toBe(c.modal_newlines);
		});
	}
});

// The two named wrappers are what the renderers actually call, so they are what a regression would
// come through. Each is one fixed (isModal, convertNewlines) pair of the function above.
describe("the two wrappers stay pinned to formatCardText", () => {
	for (const c of cases) {
		test(c.id, () => {
			expect(convertManaSymbols(c.input, false)).toBe(c.non_modal_no_newlines);
			expect(convertManaSymbols(c.input, true)).toBe(c.modal_no_newlines);
			expect(formatOracleText(c.input, false)).toBe(c.non_modal_newlines);
			expect(formatOracleText(c.input, true)).toBe(c.modal_newlines);
		});
	}
});
