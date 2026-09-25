// queryShape over the REAL parser's wire trees: the families mtg-seeker sends, values-free and
// canonical (operand order and the names themselves do not change the shape).
import { describe, expect, test } from "bun:test";
import { EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import { queryShape } from "../../src/routes/scryfall-compat/query-shape";

const shape = (q: string) => queryShape(parseScryfallQueryWithDirectives(q, EMPTY_TAG_ALIASES).tree);

describe("queryShape", () => {
	test.each([
		["oracleid:e3285e6b-3e79-4d7c-bf96-d920f973b80a", "oracle_id:str"],
		['!"Lightning Bolt"', "!name"],
		['!"Lightning Bolt" or !"Counterspell" or !"Opt"', "or(!name*3)"],
		[
			'(art:dragon or art:fire) -art:skull (!"Shivan Dragon" or !"Lightning Bolt")',
			"and(not(card_art_tags:list),or(!name*2),or(card_art_tags:list*2))",
		],
		["otag:ramp", "card_oracle_tags:list"],
		["lightning bolt", "and(card_name:coll*2)"],
		["name:/\\bgob/", "card_name:re"],
		["pow>tou t:creature", "and(card_types:list,creature_power>@creature_toughness)"],
		["m:{G}{G}", "mana_cost_jsonb:mana"],
	])("%s", (q, want) => {
		expect(shape(q)).toBe(want);
	});

	test("carries no value the user typed", () => {
		const s = shape('!"Sheoldred, the Apocalypse" or o:"draw a card" or otag:secretslug');
		for (const typed of ["sheoldred", "apocalypse", "draw", "secretslug"]) expect(s.toLowerCase()).not.toContain(typed);
	});

	test("is canonical: operand order and the names do not matter", () => {
		expect(shape('!"A" or t:elf or !"B"')).toBe(shape('t:goblin or !"Zzz" or !"Q"'));
	});

	test("is bounded", () => {
		// Sixty distinct attributes cannot collapse into runs, so the unbounded shape is ~1.5KB.
		const leaf = (i: number) => ({
			node_type: "CardBinaryOperatorNode",
			kwargs: { lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: `attr${i}` } }, op: ":", rhs: "x" },
		});
		const tree = { node_type: "OrNode", kwargs: { operands: Array.from({ length: 60 }, (_, i) => leaf(i)) } };
		const s = queryShape(tree);
		expect(s.length).toBe(240);
		expect(s.endsWith("…")).toBe(true);
	});
});
