// explainWireTree: the to_human_explanation port over engine-wire trees, plus
// pyRepr message-formatting units used by the coercion errors.

import { describe, expect, test } from "bun:test";
import { parseScryfallQuery } from "../../src/parser";
import { explainWireTree } from "../../src/routes/explanation";
import { pyRepr } from "../../src/routes/param-binding";

function attr(name: string, original = name): object {
	return { node_type: "CardAttributeNode", kwargs: { attribute_name: name, original_attribute: original } };
}

function str(value: string): object {
	return { node_type: "StringValueNode", kwargs: { value } };
}

function num(value: number): object {
	return { node_type: "NumericValueNode", kwargs: { value } };
}

function bin(lhs: object, op: string, rhs: unknown): object {
	return { node_type: "CardBinaryOperatorNode", kwargs: { lhs, op, rhs } };
}

describe("explainWireTree", () => {
	test("TrueNode and unknown shapes explain as empty", () => {
		expect(explainWireTree({ node_type: "TrueNode", kwargs: {} })).toBe("");
		expect(explainWireTree(null)).toBe("");
		expect(explainWireTree({ node_type: "MysteryNode", kwargs: {} })).toBe("");
	});

	test("operands that explain to nothing contribute no clause and no connector", () => {
		// An empty quoted string parses to a TrueNode, which explains to "". Joining it anyway
		// produced a dangling conjunction: `urza''` rendered as "the name contains Urza and "
		// with nothing after the "and", which is what a user saw in the results count line.
		const trueNode = { node_type: "TrueNode", kwargs: {} };
		const name = bin(attr("card_name"), ":", str("Urza"));

		const and = { node_type: "AndNode", kwargs: { operands: [name, trueNode] } };
		expect(explainWireTree(and)).toBe("the name contains Urza");

		// ...from either side, and with nothing left over when every operand is empty.
		expect(explainWireTree({ node_type: "AndNode", kwargs: { operands: [trueNode, name] } })).toBe(
			"the name contains Urza",
		);
		expect(explainWireTree({ node_type: "AndNode", kwargs: { operands: [trueNode, trueNode] } })).toBe("");
		expect(explainWireTree({ node_type: "OrNode", kwargs: { operands: [name, trueNode] } })).toBe(
			"the name contains Urza",
		);
	});

	test("a trailing apostrophe stays in the word instead of opening an empty string", () => {
		// The whole chain: "urza'" must survive the balancer unchanged and explain as a SINGLE
		// name clause. Before, it balanced to "urza''" and explained as "the name contains Urza
		// and " — the apostrophe opened an empty quoted string, and the results silently widened.
		//
		// The apostrophe is gone from the explained VALUE now, and that is not the balancer
		// failing: a bare `name:` word is collated before it reaches the wire (Scryfall matches
		// `limdul` and `lim-dul` identically, both 8), so "Urzas" is what the search actually
		// asks for. The `and ""` half is what this test exists to catch, and it is what a second
		// clause would still show.
		expect(explainWireTree(parseScryfallQuery("urza'"))).toBe("the name contains Urza");
		expect(explainWireTree(parseScryfallQuery("urza's"))).toBe("the name contains Urzas");
		// The QUOTED spelling keeps every character, because that search does too.
		expect(explainWireTree(parseScryfallQuery('name:"urza\'s"'))).toBe("the name contains Urza's");
	});

	test("special card-attribute phrasings", () => {
		expect(explainWireTree(bin(attr("card_name"), ":", str("Bolt")))).toBe("the name contains Bolt");
		expect(explainWireTree(bin(attr("oracle_text"), ":", str("draw a card")))).toBe(
			"the oracle text contains draw a card",
		);
		expect(explainWireTree(bin(attr("cmc"), ">=", num(3)))).toBe("the mana value ≥ 3");
		expect(explainWireTree(bin(attr("creature_power"), ">", num(2)))).toBe("the power > 2");
		expect(explainWireTree(bin(attr("card_types"), ":", ["Elf"]))).toBe("the type contains Elf");
	});

	test("colors expand from wire arrays to slash-joined names plus their mana tokens", () => {
		expect(explainWireTree(bin(attr("card_colors"), ":", ["W", "U"]))).toBe("the color is White/Blue ({W}{U})");
		expect(explainWireTree(bin(attr("card_color_identity", "id"), "<=", ["G"]))).toBe("color identity ≤ Green ({G})");
		expect(explainWireTree(bin(attr("card_colors"), ":", []))).toBe("the color is Colorless ({C})");
	});

	test("a numeric colour rhs is a COUNT of colors, not a colour", () => {
		// `c>=2` and `c:m` are the same node here — the parser lowers the colour-COUNT names into
		// the numeric comparison — so "the color ≥ 2" would be a sentence about a colour named 2.
		expect(explainWireTree(bin(attr("card_colors"), ">=", num(2)))).toBe("the number of colors ≥ 2");
		expect(explainWireTree(bin(attr("card_colors"), ":", num(2)))).toBe("the number of colors is 2");
		expect(explainWireTree(bin(attr("card_color_identity", "id"), "<", num(2)))).toBe(
			"the number of colors in the color identity < 2",
		);
		// The lowered forms of the count names, end to end through the parser.
		expect(explainWireTree(parseScryfallQuery("c:m"))).toBe("the number of colors ≥ 2");
		expect(explainWireTree(parseScryfallQuery("c!=gold"))).toBe("the number of colors < 2");
		expect(explainWireTree(parseScryfallQuery("c<=multicoloured"))).toBe("the number of colors ≥ 0");
		expect(explainWireTree(parseScryfallQuery("id>gold"))).toBe("the number of colors in the color identity ≥ 2");
		// `produces:any` lowers the same way, so the explanation is an ordinary count sentence and
		// this path needed no case of its own. Its `<` row is the only one in the colour vocabulary
		// that lowers to `= 0`.
		expect(explainWireTree(parseScryfallQuery("produces:any"))).toBe("the number of kinds of mana produced ≥ 1");
		expect(explainWireTree(parseScryfallQuery("produces<any"))).toBe("the number of kinds of mana produced is 0");
		expect(explainWireTree(parseScryfallQuery("produces<=any"))).toBe("the number of kinds of mana produced ≤ 1");
	});

	test("legalities and rarity", () => {
		expect(explainWireTree(bin(attr("card_legalities", "f"), ":", ["modern"]))).toBe("it's legal in modern");
		expect(explainWireTree(bin(attr("card_rarity_int", "r"), ":", num(2)))).toBe("the rarity contains rare");
	});

	test("boolean structure: and/or joins, or-parens, not", () => {
		const a = bin(attr("card_types"), ":", ["Elf"]);
		const b = bin(attr("cmc"), "<=", num(2));
		const c = bin(attr("card_colors"), ":", ["G"]);
		expect(explainWireTree({ node_type: "AndNode", kwargs: { operands: [a, b] } })).toBe(
			"the type contains Elf and the mana value ≤ 2",
		);
		expect(explainWireTree({ node_type: "OrNode", kwargs: { operands: [a, b] } })).toBe(
			"(the type contains Elf or the mana value ≤ 2)",
		);
		// AndNode operand of an OrNode gets parenthesized.
		expect(
			explainWireTree({
				node_type: "OrNode",
				kwargs: { operands: [{ node_type: "AndNode", kwargs: { operands: [a, b] } }, c] },
			}),
		).toBe("((the type contains Elf and the mana value ≤ 2) or the color is Green ({G}))");
		expect(explainWireTree({ node_type: "NotNode", kwargs: { operand: a } })).toBe("not (the type contains Elf)");
	});

	test("single-operand nary collapses without a join", () => {
		const a = bin(attr("card_name"), ":", str("Elf"));
		expect(explainWireTree({ node_type: "AndNode", kwargs: { operands: [a] } })).toBe("the name contains Elf");
	});

	test("exact name and empty string values", () => {
		expect(explainWireTree({ node_type: "ExactNameNode", kwargs: { value: "lightning bolt" } })).toBe(
			'exact name is "lightning bolt"',
		);
		expect(explainWireTree(bin(attr("card_name"), ":", str("   ")))).toBe("");
	});
});

describe("explainWireTree over the real parser", () => {
	// Verified against upstream parsed_query.to_human_explanation() on the same
	// queries; the only divergences are the wire tree's value normalizations
	// (titlecased/folded strings), documented in src/routes/explanation.ts.
	const cases: [query: string, explanation: string][] = [
		["t:elf", "the type contains Elf"],
		["c:wu", "the color is White/Blue ({W}{U})"],
		["id<=g", "color identity ≤ Green ({G})"],
		["cmc>=3", "the mana value ≥ 3"],
		["pow>2 tou<5", "the power > 2 and the toughness < 5"],
		['o:"draw a card"', "the oracle text contains draw a card"],
		["f:modern", "it's legal in modern"],
		["banned:legacy", "it's legal in legacy"],
		["r:rare", "the rarity contains rare"],
		["s:neo", "the set contains neo"],
		["(t:elf cmc<2) or c:g", "((the type contains Elf and the mana value < 2) or the color is Green ({G}))"],
		["-t:creature", "not (the type contains Creature)"],
		["c:c", "the color is Colorless ({C})"],
		["year:2020", "release date contains 2020"],
		["usd>10", "price (USD) > 10"],
	];
	for (const [query, expected] of cases) {
		test(`${JSON.stringify(query)} → ${JSON.stringify(expected)}`, () => {
			expect(explainWireTree(parseScryfallQuery(query))).toBe(expected);
		});
	}
});

describe("pyRepr", () => {
	test("prefers single quotes, switching for embedded singles", () => {
		expect(pyRepr("abc")).toBe("'abc'");
		expect(pyRepr("it's")).toBe(`"it's"`);
		expect(pyRepr(`both " and '`)).toBe(`'both " and \\''`);
	});

	test("escapes control characters like CPython", () => {
		expect(pyRepr("a\nb\tc\\d")).toBe("'a\\nb\\tc\\\\d'");
		expect(pyRepr("\x01")).toBe("'\\x01'");
	});
});
