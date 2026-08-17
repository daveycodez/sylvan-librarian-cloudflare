/**
 * Representative semantic assertions ported from the upstream corpus — the
 * properties fixtures alone can't express (equivalences between two parses,
 * balancing behavior, internal helper contracts).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { balancePartialQuery, canonicalStringify, ParseError, parseScryfallQuery } from "../../src/parser";
import { regexPlainLiteral, SUPPORTED_HAS_VALUES, SUPPORTED_IS_VALUES } from "../../src/parser/rewrite";

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
	// Measured 2026-08-16: `is:new` IS `frame:new`, exactly (both set differences empty on
	// api.scryfall.com). It was `frame:2015` here, under-matching by 9,201 cards.
	["is:new", "frame:2003 or frame:2015 or frame:future"],
	["is:historic", "t:legendary or t:artifact or t:saga"],
	["is:permanent", "t:creature or t:artifact or t:enchantment or t:land or t:planeswalker or t:battle"],
	["is:party", "t:creature (t:cleric or t:rogue or t:warrior or t:wizard or kw:changeling)"],
	["is:outlaw", "t:assassin or t:mercenary or t:pirate or t:rogue or t:warlock or kw:changeling"],
	// `o=""` was a tautology on both sides — `t:creature o=""` is 18,753 on api.scryfall.com too,
	// exactly `t:creature`, while `is:vanilla` is 363 there. The presence regex, negated, is the
	// empty-text test that exists: 352 on Scryfall and 352 here.
	["is:vanilla", "t:creature -o:/./"],
	["is:bear", "t:creature pow=2 tou=2 cmc=2"],
	["is:split", "layout:split"],
	["is:flip", "layout:flip"],
	["is:transform", "layout:transform"],
	["is:mdfc", "layout:modal_dfc"],
	["is:meld", "layout:meld"],
	["is:leveler", "layout:leveler"],
	[
		"is:dfc",
		"layout:transform or layout:modal_dfc or layout:art_series or layout:double_faced_token or " +
			"layout:reversible_card",
	],
	// The same predicate under two names, and neither of them is one layout: `is:host
	// -is:augmentation` and its converse are both empty on api.scryfall.com.
	["is:host", "layout:host or layout:augment"],
	["is:augmentation", "layout:host or layout:augment"],
	["is:token", "layout:token or layout:double_faced_token or t:token"],
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

// ── has: is a TOTAL alias of is: ─────────────────────────────────────────────
//
// The parity sweep found `has:split` answering a 404 here against 126 on api.scryfall.com. The
// cause was that HAS_EXPANSIONS is a hand-probed list of `has:`-FLAVOURED values, so anything
// nobody thought to spell against `has:` was simply absent. Measured 2026-08-17 over 22 values
// spanning every shape of the `is:` vocabulary: `is:X` and `has:X` agree on `total_cards` 22 of 22.
//
// Two properties, and the second is the one a careless widening breaks: the alias must not swallow
// the PRESENCE half, where `has:` and `is:` mean genuinely different things.
describe("has: aliases is:", () => {
	test("every supported is: value is a supported has: value", () => {
		const missing = [...SUPPORTED_IS_VALUES].filter((v) => !SUPPORTED_HAS_VALUES.has(v));
		expect(missing).toEqual([]);
	});

	// One per shape: a derived layout predicate, a computed text predicate, an importer boolean,
	// and a set-shaped one. Each must expand to the identical tree under either spelling.
	for (const value of ["split", "dfc", "frenchvanilla", "permanent", "promo", "etched", "commander"]) {
		test(`has:${value} == is:${value}`, () => {
			expect(tree(`has:${value}`)).toBe(tree(`is:${value}`));
		});
	}

	// The presence half keeps precedence. `has:watermark` asks whether a watermark is PRESENT --
	// there is no `is:watermark`, and folding the alias in ahead of HAS_EXPANSIONS would turn this
	// into an unsupported tag matching nothing.
	test("the presence half is not overtaken by the alias", () => {
		expect(tree("has:watermark")).toBe(tree("watermark:/./"));
		expect(tree("has:artist")).toBe(tree("artist:/./"));
	});
});

// ── plain-literal regex lowering (upstream #734 cases) ───────────────────────

const LOWERED_EQUIVALENCES: Array<[string, string]> = [
	["o:/sacrifice a/", 'o:"sacrifice a"'],
	["name:/lightning bolt/", 'name:"lightning bolt"'],
	["o:/foo\\.bar/", 'o:"foo.bar"'],
	["o:/\\{t\\}/", 'o:"{t}"'],
	["ft:/dragon/", "ft:dragon"],
	// `a:` is COLLATED for a bare word and literal for a quoted one, exactly as `name:` is — so
	// the lowered regex equals the QUOTED spelling, not the bare one. Same shape as
	// `name:/lightning bolt/` above.
	["a:/guay/", 'a:"guay"'],
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

	// THE PROPERTY THE REWRITE HAS TO HAVE, rather than a table of what it currently answers.
	//
	// `o:/\(this creature/` reaching the engine as the substring `(this creature` reads like a
	// mangled pattern and is not one: a backslash before a NON-word character is that character,
	// so the lowered literal matches exactly the strings the regex did. This test states that as
	// an equivalence against the real regex engine instead of trusting the reading — the escape
	// table above would still pass if `\(` were being dropped rather than resolved.
	//
	// The `i` flag is the query flag the engine prepends to every pattern, and the substring path
	// compares lowercased text, so case-insensitivity is what both sides mean.
	const corpus = [
		"(this creature can't be blocked)",
		"this creature can't be blocked",
		"{T}: Add {G}.",
		"T: Add G.",
		"deal 2 damage. draw a card.",
		"+1/+1 counter",
		"11 counter",
		"a-b",
		"ab",
		"[brackets]",
		"brackets",
		"back\\slash",
	];
	const equivalences = [
		"\\(this creature",
		"\\{t\\}",
		"target\\.",
		"\\+1/\\+1",
		"a\\-b",
		"\\[brackets\\]",
		"back\\\\slash",
	];
	for (const pattern of equivalences) {
		test(`lowering ${JSON.stringify(pattern)} preserves what it matches`, () => {
			const literal = regexPlainLiteral(pattern);
			expect(literal).not.toBeNull();
			const re = new RegExp(pattern, "i");
			for (const text of corpus) {
				expect(text.toLowerCase().includes((literal as string).toLowerCase())).toBe(re.test(text));
			}
		});
	}

	// ...and the other half: a pattern that KEEPS its regex leaf keeps its backslashes byte for
	// byte, because that string is handed to the engine's regex compiler verbatim.
	const verbatim = [
		["o", "\\(a.b"],
		["name", "^\\(x"],
		["ft", "\\d\\d\\d"],
		["a", "\\bguay\\b"],
		["t", "\\(a|b"],
		["fo", "[\\]]"],
		["e", "kh\\w"],
		["cn", "\\d+a"],
		["watermark", "izz\\S+"],
		["layout", "norm\\w+"],
		["border", "bl\\w+"],
	];
	for (const [op, pattern] of verbatim as Array<[string, string]>) {
		test(`${op}:/${pattern}/ reaches the engine byte for byte`, () => {
			const root = parseScryfallQuery(`${op}:/${pattern}/`);
			const rhs = root.kwargs.rhs as { node_type: string; kwargs: { value: string } };
			expect(rhs.node_type).toBe("RegexValueNode");
			expect(rhs.kwargs.value).toBe(pattern);
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
