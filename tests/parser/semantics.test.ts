/**
 * Representative semantic assertions ported from the upstream corpus — the
 * properties fixtures alone can't express (equivalences between two parses,
 * balancing behavior, internal helper contracts).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { balancePartialQuery, canonicalStringify, ParseError, parseScryfallQuery } from "../../src/parser";
import { regexPlainLiteral } from "../../src/parser/rewrite";

// ── balance_partial_query: shared frontend/backend fixture contract ──────────
// (upstream test_balance_parity.py against api/static/fixtures/balance_queries.json)

interface BalanceCase {
	input: string;
	suffix: string | null;
}

const BALANCE_QUERIES = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../../vendor/sylvan_librarian/api/static/fixtures/balance_queries.json"),
		"utf-8",
	),
) as BalanceCase[];

describe("balancePartialQuery", () => {
	for (const { input, suffix } of BALANCE_QUERIES) {
		test(`balances ${JSON.stringify(input)}`, () => {
			if (suffix === null) {
				expect(() => balancePartialQuery(input)).toThrow(/Unbalanced closing character.*cannot be balanced/);
				return;
			}
			expect(balancePartialQuery(input)).toBe(input + suffix);
		});
	}

	// upstream test_balance_query.py: balanced partial queries still parse
	for (const original of ['name:"hydr', '(name:"lightning']) {
		test(`balanced ${JSON.stringify(original)} still parses`, () => {
			expect(() => parseScryfallQuery(original)).toThrow(ParseError);
			expect(parseScryfallQuery(balancePartialQuery(original))).toBeDefined();
		});
	}
});

// ── rewrite equivalences (upstream test_rewrite.py) ──────────────────────────

function tree(query: string): string {
	return canonicalStringify(parseScryfallQuery(query));
}

const EQUIVALENCES: Array<[string, string]> = [
	["frame:modern", "frame:2003"],
	["frame:old", "frame:1993 or frame:1997"],
	["frame:new", "frame:2003 or frame:2015 or frame:future"],
	["is:old", "frame:1993 or frame:1997"],
	["is:new", "frame:2015"],
	["is:historic", "t:legendary or t:artifact or t:saga"],
	["is:permanent", "t:creature or t:artifact or t:enchantment or t:land or t:planeswalker or t:battle"],
	["is:party", "t:creature (t:cleric or t:rogue or t:warrior or t:wizard or kw:changeling)"],
	["is:outlaw", "t:assassin or t:mercenary or t:pirate or t:rogue or t:warlock or kw:changeling"],
	["is:vanilla", 't:creature o=""'],
	["is:bear", "t:creature pow=2 tou=2 cmc=2"],
	["is:split", "layout:split"],
	["is:flip", "layout:flip"],
	["is:transform", "layout:transform"],
	["is:mdfc", "layout:modal_dfc"],
	["is:meld", "layout:meld"],
	["is:leveler", "layout:leveler"],
	["is:dfc", "layout:transform or layout:modal_dfc or layout:meld"],
	["is:colorshifted", "frame:colorshifted"],
	["is:manland", "t:land o:become o:creature o:/still a.* land/"],
	["-frame:old", "-(frame:1993 or frame:1997)"],
	["t:goblin frame:modern", "t:goblin frame:2003"],
	["t:goblin is:party", "t:goblin t:creature (t:cleric or t:rogue or t:warrior or t:wizard or kw:changeling)"],
];

describe("derived-predicate expansion", () => {
	for (const [synonym, expansion] of EQUIVALENCES) {
		test(`${synonym} == ${expansion}`, () => {
			expect(tree(synonym)).toBe(tree(expansion));
		});
	}

	test("unimplemented is: tag passes through", () => {
		const root = parseScryfallQuery("is:promo");
		expect(root.node_type).toBe("CardBinaryOperatorNode");
		expect(root.kwargs.op).toBe(":");
	});
});

// ── plain-literal regex lowering (upstream #734 cases) ───────────────────────

const LOWERED_EQUIVALENCES: Array<[string, string]> = [
	["o:/sacrifice a/", 'o:"sacrifice a"'],
	["name:/lightning bolt/", 'name:"lightning bolt"'],
	["o:/foo\\.bar/", 'o:"foo.bar"'],
	["o:/\\{t\\}/", 'o:"{t}"'],
	["ft:/dragon/", "ft:dragon"],
	["a:/guay/", "a:guay"],
];

describe("plain-literal regex lowering", () => {
	for (const [regexQuery, substringQuery] of LOWERED_EQUIVALENCES) {
		test(`${regexQuery} == ${substringQuery}`, () => {
			expect(tree(regexQuery)).toBe(tree(substringQuery));
		});
	}

	const nonLiteral = [
		"o:/^flying$/",
		"o:/^flying/",
		"o:/flying$/",
		"o:/draw .* cards/",
		"o:/[aeiou]/",
		"o:/\\d+/",
		"o:/a|b/",
	];
	for (const query of nonLiteral) {
		test(`${query} stays a regex leaf`, () => {
			const root = parseScryfallQuery(query);
			const rhs = root.kwargs.rhs as { node_type: string };
			expect(rhs.node_type).toBe("RegexValueNode");
		});
	}

	const plainLiteralCases: Array<[string, string | null]> = [
		["sacrifice a", "sacrifice a"],
		["foo\\.bar", "foo.bar"],
		["\\{t\\}: add", "{t}: add"],
		["^flying", null],
		["flying$", null],
		["a*b", null],
		["a|b", null],
		["[aeiou]", null],
		["\\d+", null],
		["\\bfoo", null],
		["foo\\", null],
		["", null],
	];
	for (const [pattern, expected] of plainLiteralCases) {
		test(`regexPlainLiteral(${JSON.stringify(pattern)})`, () => {
			expect(regexPlainLiteral(pattern)).toBe(expected);
		});
	}
});

// ── failure semantics ────────────────────────────────────────────────────────

describe("failure semantics", () => {
	test("lex failure throws ParseError with Python's wrapped message", () => {
		expect(() => parseScryfallQuery('name:"unclosed')).toThrow(new ParseError('Failed to lex query: "name:"unclosed"'));
	});

	test("parse failure throws ParseError with Python's wrapped message", () => {
		expect(() => parseScryfallQuery("cmc=2 and id=")).toThrow(new ParseError('Failed to parse query: "cmc=2 and id="'));
	});

	test("serialization-time color validation throws unwrapped", () => {
		expect(() => parseScryfallQuery('c:"purple"')).toThrow(new ParseError("Invalid color string: purple"));
	});

	test("empty query parses to TrueNode", () => {
		expect(canonicalStringify(parseScryfallQuery(""))).toBe('{"kwargs":{},"node_type":"TrueNode"}');
		expect(canonicalStringify(parseScryfallQuery(null))).toBe('{"kwargs":{},"node_type":"TrueNode"}');
	});
});
