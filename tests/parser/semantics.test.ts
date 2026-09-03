/**
 * Representative semantic assertions ported from the upstream corpus — the
 * properties fixtures alone can't express (equivalences between two parses,
 * balancing behavior, internal helper contracts).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	balancePartialQuery,
	canonicalStringify,
	ParseError,
	parseScryfallQuery,
	parseScryfallQueryWithDirectives,
} from "../../src/parser";
import {
	ENGINE_IS_VALUES,
	regexPlainLiteral,
	SUPPORTED_HAS_VALUES,
	SUPPORTED_IS_VALUES,
} from "../../src/parser/rewrite";

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
	// NO `is:vanilla` row — it stops expanding here and becomes an engine leaf; see the loop over
	// ENGINE_IS_VALUES below. Two rewrites lived on this line and both fell short: `t:creature o=""`
	// was `t:creature` exactly (18,753 on api.scryfall.com too — `o=""` is a tautology on both
	// sides), and `t:creature -o:/./` answered 352 against Scryfall's 363, because the question is
	// about the FRONT FACE and every rewrite here reads the merged row.
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

	// The engine-answered values reach `FilterExpr` as a `card_is_tags` leaf and are intercepted
	// there (filter.rs's build_filter). A rewrite claiming one would silently win over the engine
	// leaf and answer a DIFFERENT question — which is exactly what `is:vanilla` did for as long as
	// it expanded: `t:creature -o:/./` is 352 where the predicate is 363.
	for (const value of ENGINE_IS_VALUES) {
		test(`is:${value} stays a leaf for the engine`, () => {
			expect(tree(`is:${value}`)).toBe(
				'{"kwargs":{"lhs":{"kwargs":{"attribute_name":"card_is_tags","original_attribute":"is"},' +
					`"node_type":"CardAttributeNode"},"op":":","rhs":["${value}"]},"node_type":"CardBinaryOperatorNode"}`,
			);
		});
	}
});

// ── produces:any ─────────────────────────────────────────────────────────────
//
// `any` is a colour-COUNT name on produced_mana and nowhere else. Measured against
// api.scryfall.com 2026-08-28, corpus-wide AND against a `t:creature` second base — every equality
// below held on both, which is what rules out a coincidence of the whole-corpus totals:
//
//   produces:any = produces=any = produces>any = produces>=any = produces!=any
//                        = 2,603 = `produces>=1`   (t:creature: 756)
//   produces<any         = 30,996 = `produces=0`   (t:creature: 17,997)
//   produces<=any        = 32,139 = `produces<=1`  (t:creature: 18,369)
//
// This port dropped the term entirely instead: `any` was in neither name table, so the value
// parser threw, the compat layer removed the expression, and `t:legendary t:creature produces:any`
// answered `t:legendary t:creature`'s 3,625 where Scryfall answers 194.
//
// `!=` GROUPS WITH `:` here, which is NOT how the `m` table behaves (`produces!=m` is the low side,
// `produces=1`). The asymmetry is measured on both bases; do not tidy it.
const PRODUCES_ANY_EQUIVALENCES: Array<[string, string]> = [
	["produces:any", "produces>=1"],
	["produces=any", "produces>=1"],
	["produces>any", "produces>=1"],
	["produces>=any", "produces>=1"],
	["produces!=any", "produces>=1"],
	["produces<any", "produces=0"],
	["produces<=any", "produces<=1"],
];

describe("produces:any is a colour COUNT, on one column only", () => {
	for (const [written, meaning] of PRODUCES_ANY_EQUIVALENCES) {
		test(`${written} == ${meaning}`, () => {
			expect(tree(written)).toBe(tree(meaning));
		});
	}

	test("the whole operator table is pinned, both sides of every row", () => {
		// The rows that SEPARATE the three answers, stated as inequalities so a table collapsed to
		// one value cannot pass: `<` is not `<=`, and neither is `:`.
		expect(tree("produces<any")).not.toBe(tree("produces<=any"));
		expect(tree("produces<=any")).not.toBe(tree("produces:any"));
		// And `any` is not `m` under any operator — the two tables disagree on every row.
		for (const op of [":", "=", ">", ">=", "<", "<=", "!="]) {
			expect(tree(`produces${op}any`)).not.toBe(tree(`produces${op}m`));
		}
	});

	test("the value is case-insensitive and survives quoting, like every other colour name", () => {
		expect(tree("produces:ANY")).toBe(tree("produces>=1"));
		expect(tree('produces:"any"')).toBe(tree("produces>=1"));
	});

	// THE CONSTRAINT, and the half a global name table would break. Scryfall does not accept `any`
	// on the colour columns: `c:any` alone answers "All of your terms were ignored", and both
	// `t:creature c:any` and `t:creature id:any` answer `t:creature`'s 18,753 — REJECTED and
	// dropped, not applied. The parse error here is what the compat layer turns into that drop.
	test("c:/id: reject any, on every spelling of both colour columns", () => {
		for (const alias of ["c", "color", "colors", "colour", "colours", "ci", "id", "identity", "commander"]) {
			expect(() => parseScryfallQuery(`${alias}:any`)).toThrow(ParseError);
		}
		// Quoted, the value parser is bypassed and serialization is what refuses it — the same
		// place `c:"purple"` is refused.
		expect(() => parseScryfallQuery('c:"any"')).toThrow(new ParseError("Invalid color string: any"));
	});

	test("the colour columns keep every name they already had", () => {
		expect(tree("c:azorius")).toBe(tree("c:wu"));
		expect(tree("c:m")).toBe(tree("c>=2"));
		expect(tree("id:gold")).toBe(tree("id>=2"));
	});
});

// ── rainbow / all ────────────────────────────────────────────────────────────
//
// The two colour names that mean "the WHOLE spread of this column", which is a COUNT and not the
// letters they spell. Measured against api.scryfall.com 2026-08-28, corpus-wide (33,599 cards) —
// the full table and the two rows that refute the letter reading are at db-info's
// COLOR_SPREAD_COUNT_NAMES.
//
// This port compared them as letters, so `id:rainbow` — a subset test against all five colours —
// answered EVERY card (151 on `e:khm t:creature`, where Scryfall answers 1) and `produces:rainbow`
// answered 799 against Scryfall's 693.
//
// `all` is the only value in the colour vocabulary whose meaning depends on the COLUMN: 5 where the
// C bit drops out, 6 on produced_mana where it does not.
const SPREAD_EQUIVALENCES: Array<[string, string]> = [
	["c:rainbow", "c=5"],
	["c:all", "c=5"],
	["c=rainbow", "c=5"],
	["c>=all", "c>=5"],
	["c<rainbow", "c<5"],
	["c!=rainbow", "c!=5"],
	["c>all", "c>5"],
	["c<=rainbow", "c<=5"],
	["id:rainbow", "id=5"],
	["id:all", "id=5"],
	["id>=rainbow", "id>=5"],
	["id<all", "id<5"],
	["id!=all", "id!=5"],
	["produces:rainbow", "produces=5"],
	["produces=rainbow", "produces=5"],
	["produces>=rainbow", "produces>=5"],
	["produces<rainbow", "produces<5"],
	["produces<=rainbow", "produces<=5"],
	["produces>rainbow", "produces>5"],
	["produces!=rainbow", "produces!=5"],
	["produces:all", "produces=6"],
	["produces=all", "produces=6"],
	["produces>=all", "produces>=6"],
	["produces<all", "produces<6"],
	["produces!=all", "produces!=6"],
];

describe("rainbow and all are the column's whole SPREAD, as a count", () => {
	for (const [written, meaning] of SPREAD_EQUIVALENCES) {
		test(`${written} == ${meaning}`, () => {
			expect(tree(written)).toBe(tree(meaning));
		});
	}

	test("`all` is the COLUMN's width, and `rainbow` is five everywhere", () => {
		// The one value in the colour vocabulary whose meaning depends on which column it is on.
		expect(tree("produces:all")).not.toBe(tree("c:all"));
		expect(tree("produces:all")).not.toBe(tree("produces:rainbow"));
		expect(tree("c:all")).toBe(tree("c:rainbow"));
		expect(tree("id:all")).toBe(tree("id:rainbow"));
	});

	test("neither name is its own letter spelling any more", () => {
		// `id:` is a SUBSET test, so `id:wubrg` is every card where `id:rainbow` is the five-colour
		// ones; and `produces:wubrg` also admits the cards that produce a sixth value.
		expect(tree("id:rainbow")).not.toBe(tree("id:wubrg"));
		expect(tree("produces:rainbow")).not.toBe(tree("produces:wubrg"));
		expect(tree("produces:all")).not.toBe(tree("produces:wubrgc"));
		// ...and no OTHER colour name moved: a guild is still the letters it spells.
		expect(tree("id:azorius")).toBe(tree("id:wu"));
		expect(tree("c:esper")).toBe(tree("c:wub"));
		expect(tree("produces:bant")).toBe(tree("produces:gwu"));
	});

	test("the value is case-insensitive and survives quoting, like every other colour name", () => {
		expect(tree("id:RAINBOW")).toBe(tree("id=5"));
		expect(tree('produces:"all"')).toBe(tree("produces=6"));
	});
});

// ── c>=colorless ─────────────────────────────────────────────────────────────
//
// EVERY CARD IS A SUPERSET OF NOTHING. `>=` against colourless on a colour column is a tautology on
// Scryfall — `c>=c` is 33,599, the whole corpus, and 151 on the `e:khm t:creature` base — where
// this port answered the 4,300 colourless cards (2 on that base). The engine's mask compare cannot
// tell `:` from `>=` (both are CmpOp::Ge by then) and its empty-mask special case is right for `:`,
// so the `>=` row is separated in the parser as the tautology `>= 0`.
//
// The full measurement, and the six operator rows that did NOT move, are at card-query-nodes'
// COLORLESS_BY_OPERATOR.
describe("c>=colorless is a tautology, and only that one operator moved", () => {
	for (const spelling of ["c", "colorless", "colourless", "brown"]) {
		test(`c>=${spelling} and id>=${spelling} are the whole corpus`, () => {
			// `c<=m` already spells a tautology this way, so this is not a new node shape.
			expect(tree(`c>=${spelling}`)).toBe(tree("c<=m"));
			expect(tree(`id>=${spelling}`)).toBe(tree("id<=m"));
		});
	}

	test("every other operator still compares against the empty colour set", () => {
		// The engine answers all six of these correctly as a mask compare, so the parser must NOT
		// lower them — `c:c` in particular is the 4,300 colourless cards, not every card.
		for (const op of [":", "=", "!=", "<", "<=", ">"]) {
			expect(tree(`c${op}colorless`)).toBe(tree(`c${op}c`));
			expect(tree(`c${op}c`)).toContain('"rhs":[]');
		}
	});

	test("produced_mana is untouched, because colourless is a real value there", () => {
		// Sol Ring's produced_mana is ["C"] while its colors and color_identity are both [] — so on
		// this one column `c` is the C lane, `produces>=c` is an ordinary mask compare (685 on
		// Scryfall, 2026-08-28), and none of the tautology above applies.
		expect(tree("produces>=c")).toContain('"rhs":["C"]');
		expect(tree("produces>=colorless")).toBe(tree("produces>=c"));
		expect(tree("produces>=c")).not.toBe(tree("c>=c"));
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
	// a set-shaped one, and two ENGINE-answered ones (`vanilla` and `flavorname`, which expand to
	// nothing at all — the alias has to reach the leaf itself, not a rewrite of it; `has:flavorname`
	// is 476 on api.scryfall.com, the same as `is:flavorname`).
	for (const value of [
		"split",
		"dfc",
		"frenchvanilla",
		"permanent",
		"promo",
		"etched",
		"commander",
		"vanilla",
		"flavorname",
	]) {
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

// ── metacharacters beside a non-ASCII literal ────────────────────────────────
//
// Every pattern here parsed, passed the regex budget, and reached the engine — where
// `pattern_requires_backtrack` sliced the pattern string at a byte offset that could land inside a
// multi-byte character and panicked the wasm isolate, so /cards/search answered 500. The parser
// half of that is what this pins: which of these arrive as a REGEX leaf (and so are byte-walked at
// all) and which `lowerLiteralRegexes` turns into a plain substring first. The split is exactly
// why a bare non-ASCII literal was the one shape that worked in production.
//
// Counts measured on api.scryfall.com 2026-08-28.
describe("non-ASCII literals mixed with metacharacters", () => {
	// Regex leaves — each one 500'd on this port before the engine fix. `—` is U+2014 EM DASH
	// (E2 80 94), `é` is U+00E9 (C3 A9).
	const regexLeaves: Array<[string, number]> = [
		["o:/[a-z]—/", 245],
		["o:/\\w—/", 382],
		["o:/[a-z]é/", 5],
		["o:/.—/", 3461],
		["o:/—[^{]*$/", 2846],
		// Controls that always worked, and must keep working: an ASCII class, and one with a
		// quantifier.
		["o:/[a-z]x/", 5212],
		["o:/[a-z]*x/", 6886],
	];
	for (const [query, scryfallCount] of regexLeaves) {
		test(`${query} reaches the engine as a regex leaf (Scryfall: ${scryfallCount})`, () => {
			const root = parseScryfallQuery(query);
			const rhs = root.kwargs.rhs as { node_type: string };
			expect(rhs.node_type).toBe("RegexValueNode");
		});
	}

	// THE ONE THAT NEVER CRASHED, and the reason: a pattern of nothing but literal characters is
	// lowered to a substring leaf here, so it never reaches the byte walk at all. `o:/x—/` was 7
	// on both engines throughout (2026-08-28) while `o:/.—/` was a 500.
	test("a bare non-ASCII literal is lowered to a substring leaf", () => {
		expect(tree("o:/x—/")).toBe(tree('o:"x—"'));
		const rhs = parseScryfallQuery("o:/x—/").kwargs.rhs as { node_type: string };
		expect(rhs.node_type).not.toBe("RegexValueNode");
	});

	// Negative controls: api.scryfall.com answers 404 for both (2026-08-28), so this port refusing
	// them is parity, not a defect — but they must still PARSE, or the refusal would come from the
	// wrong layer.
	for (const query of ["o:/a+—/", "o:/(a|b)—/"]) {
		test(`${query} parses as a regex leaf (both engines answer nothing)`, () => {
			const rhs = parseScryfallQuery(query).kwargs.rhs as { node_type: string };
			expect(rhs.node_type).toBe("RegexValueNode");
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

describe("a regex on a collection column reaches the engine as a regex", () => {
	/**
	 * WHAT THIS PINS is a wrong ANSWER, not a missing feature. `card_keywords`, `card_frame_data`,
	 * `card_oracle_tags`, `card_art_tags` and `card_is_tags` are JSONB_OBJECT columns whose
	 * comparison-key readers take a STRING and slug it into a tag name. A `RegexValueNode` handed
	 * to one of them came out as the letters its pattern happens to contain: `otag:/^remov/`
	 * became the tag `rem`, `kw:/f.y/` became the keyword `fy`. No such tag exists, so production
	 * answered 404 to each on 2026-08-28 — a different query, answered with confidence, and the
	 * exact shape the JSONB_ARRAY branch above it had already been fixed for (`t:/^drag/`).
	 *
	 * The node now passes through, and the engine's `build_text_filter` — which has no arm for
	 * these columns — declines with `regex not supported on card_keywords`, which the route
	 * reports as a 400.
	 */
	const COLLECTION_REGEX: [query: string, attribute: string][] = [
		["kw:/f.y/", "card_keywords"],
		["keyword:/^fly/", "card_keywords"],
		["frame:/^199/", "card_frame_data"],
		["otag:/^remov/", "card_oracle_tags"],
		["function:/^remov/", "card_oracle_tags"],
		["art:/^drag/", "card_art_tags"],
		["is:/^prom/", "card_is_tags"],
		["not:/^prom/", "card_is_tags"],
	];

	for (const [query, attribute] of COLLECTION_REGEX) {
		test(`${query} keeps its pattern`, () => {
			const tree = canonicalStringify(parseScryfallQuery(query));
			expect(tree).toContain('"node_type":"RegexValueNode"');
			expect(tree).toContain(`"attribute_name":"${attribute}"`);
		});
	}

	test("a plain-literal pattern still lowers, so the answers it gives are untouched", () => {
		// Production, 2026-08-28: `is:/promo/` 6,126, `kw:/flying/` 3,285, `otag:/removal/` 6,430.
		for (const query of ["is:/promo/", "kw:/flying/", "otag:/removal/", "frame:/1997/"]) {
			expect(canonicalStringify(parseScryfallQuery(query))).not.toContain("RegexValueNode");
		}
	});

	test("a comparison keeps upstream's slug, which the fixture corpus pins", () => {
		// `>` `>=` `<` `<=` `!=` on these columns are answered by the empty set on both sides
		// before a parser is reached, so there is nothing here to correct — and the exported
		// fixtures (`-frame<=/a\/b/`, `is>/a\/b/`) are never patched.
		expect(canonicalStringify(parseScryfallQuery("frame<=/ab/"))).not.toContain("RegexValueNode");
	});
});

// ── the colour and mana families take a SLASH-DELIMITED value ────────────────
//
// Two different rules behind one spelling, and the whole point of the pair of tests below is that
// they are not the same rule. On the COLOUR columns Scryfall runs no regex at all — the slashes
// are ordinary value characters and get skipped — while on `mana:` it compiles one and runs it
// against the printed cost STRING. Every row measured on api.scryfall.com 2026-08-28.
describe("slash-delimited colour values", () => {
	// Each pair must parse to the SAME tree as the undelimited spelling, which is the strongest
	// form of "the slashes are not a regex": not merely "answers something", but "is that query".
	const EQUIVALENT: [slashed: string, plain: string, scryfall: string][] = [
		["c:/w/", "c:w", "7,105"],
		["c:/wu/", "c:wu", "718"],
		["c:/white/", "c:white", "7,105"],
		["c:/yore-tiller/", "c:yore-tiller", "62"],
		["c:/2/", "c:2", "3,811"],
		["c>=/2/", "c>=2", "4,607"],
		["color:/w/", "color:w", "7,105"],
		["colour:/w/", "colour:w", "7,105"],
		["colors:/w/", "colors:w", "7,105"],
		["colours:/w/", "colours:w", "7,105"],
		["id:/w/", "id:w", "7,993"],
		["identity:/w/", "identity:w", "7,993"],
		["ci:/w/", "ci:w", "7,993"],
		["commander:/w/", "commander:w", "7,993"],
		["produces:/g/", "produces:g", "1,274"],
	];

	for (const [slashed, plain, scryfall] of EQUIVALENT) {
		test(`${slashed} parses as ${plain} (Scryfall ${scryfall})`, () => {
			expect(canonicalStringify(parseScryfallQuery(slashed))).toBe(canonicalStringify(parseScryfallQuery(plain)));
		});
	}

	// The FAILURE mode is the undelimited one too, which is what keeps the ignored-term warning
	// byte-identical: `c:/xyz/` is `Unknown color “x”` on api.scryfall.com, naming the letter from
	// inside the delimiters. Same throw here as `c:xyz`, so the compat layer produces one sentence
	// for both. See tests/routes/query-terms.test.ts for the sentence itself.
	for (const bad of ["c:/xyz/", "id:/xyz/", "produces:/xyz/"]) {
		test(`${bad} raises exactly as its undelimited twin does`, () => {
			expect(() => parseScryfallQuery(bad)).toThrow(ParseError);
			expect(() => parseScryfallQuery(bad.replace(/\//g, ""))).toThrow(ParseError);
		});
	}

	// MEASURED AND NOT FIXED. Scryfall skips characters that are neither colour letters nor part
	// of a name ANYWHERE in the value, not only at the delimiters — `c:w|u` and `c:w-u` are both
	// 718, `c:/{w}/` is 7,105, and the empty `c://` and `c:""` are both 33,599, the whole corpus.
	// Those spellings do not survive this port's tokenizer as one token, so widening the rule is a
	// grammar change rather than a value change. Pinned here so the remainder is a decision.
	for (const unfixed of ["c:/{w}/", "c:/w-u/", "c://"]) {
		test(`${unfixed} still raises — the punctuation-skipping remainder`, () => {
			expect(() => parseScryfallQuery(unfixed)).toThrow(ParseError);
		});
	}
});

describe("slash-delimited mana values are a real regex", () => {
	const regexRhs = (query: string): string | null => {
		const tree = JSON.parse(canonicalStringify(parseScryfallQuery(query))) as {
			kwargs?: { rhs?: { node_type?: string; kwargs?: { value?: string } } };
		};
		const rhs = tree.kwargs?.rhs;
		return rhs?.node_type === "RegexValueNode" ? (rhs.kwargs?.value ?? null) : null;
	};

	// `:` and `=`, on both spellings of the column — the four shapes Scryfall compiles.
	// `mana:/p/ mv=1` is 9 there, every one Phyrexian; `mana=/{r}/` is 6,853, exactly `mana:/{r}/`.
	for (const query of ["mana:/p/", "mana=/{r}/", "m:/p/", "m=/{r}/"]) {
		test(`${query} keeps the pattern as a regex`, () => {
			expect(regexRhs(query)).not.toBeNull();
		});
	}

	// A PLAIN-LITERAL PATTERN IS NOT LOWERED HERE, which is the half that would have been silent:
	// `lowerLiteralRegexes` turns `o:/p/` into the substring `o:p`, and doing the same to
	// `mana:/p/` would have produced `mana:p` — `Invalid expression “mana:p” was ignored. Unknown
	// mana symbols “P”.` on api.scryfall.com, the unfiltered 3,244 instead of the 9.
	test("mana:/p/ is not lowered to the substring mana:p", () => {
		expect(regexRhs("mana:/p/")).toBe("p");
		expect(() => parseScryfallQuery("mana:p")).toThrow(ParseError);
	});

	// Scryfall's own dialect reaches this column: `mana:/\smp/ mv=1` is the same 9 as `mana:/p/`.
	test("the \\s… shorthands survive to the engine", () => {
		expect(regexRhs("mana:/\\smp/")).toBe("\\smp");
	});

	// EVERY OTHER OPERATOR IS A VALUE AGAIN, and the value lexer rejects the delimiters:
	// `mana!=/^tap/` is `Unknown mana symbols “/^TAP/”` and `mana>=/{r}/` is
	// `Unknown mana symbols “//”`, where `mana=/{r}/` is 6,853.
	for (const query of ["mana!=/^tap/", "mana>=/{r}/", "mana</^tap/", "mana>/{r}/", "mana<=/{r}/"]) {
		test(`${query} is a value error, not a pattern`, () => {
			expect(() => parseScryfallQuery(query)).toThrow(ParseError);
		});
	}

	// `devotion` shares the parser class and is NOT regex-capable: `devotion:/r/` is
	// `Unknown regular expression keyword “devotion”` on api.scryfall.com, while `devotion:{r}`
	// still answers 5,290.
	for (const query of ["devotion:/r/", "devotion=/{r}/"]) {
		test(`${query} is not a pattern — the alias set is part of the rule`, () => {
			expect(() => parseScryfallQuery(query)).toThrow(ParseError);
		});
	}
	test("devotion:{r} still parses", () => {
		expect(() => parseScryfallQuery("devotion:{r}")).not.toThrow();
	});
});

// ── `~` is a METACHARACTER, not a tilde ─────────────────────────────────────
//
// `o:/~/` answers 19,228 on api.scryfall.com and answered 404 here — a silent zero, and half of
// it was on this side of the parser. `regexPlainLiteral` read `~` as an ordinary character, so
// `lowerLiteralRegexes` turned `o:/~/` into the substring search `o:~`, and no oracle text on
// earth contains a tilde. The engine never saw a pattern at all.
describe("the ~ self-reference alias survives the plain-literal lowering", () => {
	const rhsType = (query: string): string | undefined => {
		const tree = JSON.parse(canonicalStringify(parseScryfallQuery(query))) as {
			kwargs?: { rhs?: { node_type?: string } };
		};
		return tree.kwargs?.rhs?.node_type;
	};

	// Every column Scryfall takes a regex on, because the lowering is column-blind and the alias
	// has to reach the engine on each of them.
	for (const query of ["o:/~/", "oracle:/~/", "fo:/~/", "ft:/~/", "flavor:/~/", "name:/~/", "t:/~/"]) {
		test(`${query} stays a regex`, () => {
			expect(rhsType(query)).toBe("RegexValueNode");
		});
	}

	// An ESCAPED tilde too, because Scryfall's is not escaped either: `o:/\~/` answers the same
	// 19,228 as `o:/~/` there (2026-08-28), so the backslash does not turn the alias back into a
	// character.
	test("an escaped tilde is still the alias", () => {
		expect(rhsType("o:/\\~/")).toBe("RegexValueNode");
		expect(regexPlainLiteral("\\~")).toBeNull();
		expect(regexPlainLiteral("~")).toBeNull();
	});

	// Composed forms — the ones a name-only reading would get wrong rather than empty.
	// `o:/~ deals/` is 2,910 there and `o:/^~$/` is exactly 1.
	for (const query of ["o:/~ deals/", "o:/^~$/", "o:/^~ deals/", "o:/~ enters/"]) {
		test(`${query} stays a regex`, () => {
			expect(rhsType(query)).toBe("RegexValueNode");
		});
	}

	// ...and nothing else moves: a plain literal with no tilde is still lowered to the substring
	// it spells, which is what keeps `o:/flying/` index-backed rather than a full scan.
	test("a tilde-free plain literal is still lowered", () => {
		expect(rhsType("o:/flying/")).toBe("StringValueNode");
		expect(regexPlainLiteral("flying")).toBe("flying");
		// A tilde inside a BRACKET expression is left alone by the engine's expansion, but the
		// lowering is deliberately coarser: any tilde at all makes the pattern non-plain, so the
		// class reaches the engine as a class instead of being flattened to a literal.
		expect(regexPlainLiteral("[~]")).toBeNull();
	});
});

// ── the two Scryfall operators this port could not read at all ───────────────

/**
 * A SET CODE where a date goes. Every count below was read off api.scryfall.com on 2026-09-03, one
 * request per row, against the explicit date `/sets/<code>` reports for that set — see
 * `parser.parseDateValue` for the table and `scripts/generate-set-dates.ts` for where the dates
 * come from.
 */
describe("date: takes a set code, and resolves it to that set's release date", () => {
	const tree = (query: string): string => canonicalStringify(parseScryfallQuery(query));

	test("a code is the set's released_at, on every operator", () => {
		// date>=hob is 1,200 there and so is date>=2026-08-14; date:hob is 311 and so is the date.
		for (const op of [":", "=", ">", ">=", "<", "<="]) {
			expect(tree(`date${op}hob`)).toBe(tree(`date${op}2026-08-14`));
		}
	});

	test("it is a full date, not a window like the bare year", () => {
		// `date:hob` is the 311 released that DAY; `date:2021` is the whole of 2021's 3,834, and the
		// engine reads the two precisions differently (see the builder's date_range_bounds).
		expect(tree("date:hob")).toBe(tree("date:2026-08-14"));
		expect(tree("date:hob")).not.toBe(tree("date:2026"));
	});

	test("a leading-digit code is one WORD token, not a number and a word", () => {
		expect(tree("date>=40k")).toBe(tree("date>=2022-10-07"));
		expect(tree("date>=2x2")).toBe(tree("date>=2022-07-08"));
		expect(tree("date>=3ed")).toBe(tree("date>=1994-04-11"));
		expect(tree("date>=10e")).toBe(tree("date>=2007-07-13"));
	});

	test("case-insensitive, and quoted resolves too", () => {
		expect(tree("date>=HOB")).toBe(tree("date>=2026-08-14"));
		expect(tree('date>="hob"')).toBe(tree("date>=2026-08-14"));
	});

	test("an unknown code is a parse failure, not a silently different date", () => {
		expect(() => parseScryfallQuery("date>=zzzz")).toThrow(ParseError);
		// Dominaria's mtgo/arena code. `e:dar` is 265 on api.scryfall.com and `date>=dar` is
		// `Invalid date or unknown set code` there — only the primary code anchors a date.
		expect(() => parseScryfallQuery("date>=dar")).toThrow(ParseError);
	});

	test("year: does NOT take one — `year>=hob` is honored-and-empty on Scryfall, not a date", () => {
		expect(() => parseScryfallQuery("year>=hob")).toThrow(ParseError);
	});
});

/**
 * `game:` reaches the `game_*` tags the importer stores (db-info.ts GAME_IS_TAGS), through a total
 * value mapping — which is the point of the prefix, and what the last test here pins.
 */
describe("game: is the games array, prefixed so it cannot collide with is:", () => {
	const tree = (query: string): string => canonicalStringify(parseScryfallQuery(query));

	test("a game value becomes its prefixed tag", () => {
		expect(tree("game:paper")).toBe(tree("is:game_paper"));
		expect(tree("game:arena")).toBe(tree("is:game_arena"));
		expect(tree("game:mtgo")).toBe(tree("is:game_mtgo"));
	});

	test("astral and sega are in the vocabulary — 404 on Scryfall, not `Unknown game`", () => {
		expect(tree("game:astral")).toBe(tree("is:game_astral"));
		expect(tree("game:sega")).toBe(tree("is:game_sega"));
	});

	test("case-folded, like every other value", () => {
		expect(tree("game:MTGO")).toBe(tree("is:game_mtgo"));
	});

	test("negation wraps the rewritten leaf, nothing more", () => {
		expect(tree("-game:paper")).toBe(tree("-is:game_paper"));
	});

	/**
	 * THE REASON THE TAGS ARE PREFIXED. `game:` and `is:` share `card_is_tags`, so an unprefixed
	 * mapping would answer `is:promo`'s 6,126 promo printings for `game:promo`, where
	 * api.scryfall.com ignores the term with ``Unknown game `promo` ``. Here it becomes a tag no
	 * row carries — a no-match — and the parser says so in a warning.
	 */
	test("a regex value folds into the tag name too, so it cannot match one either", () => {
		// `^prom` would match the `promo` tag if the leaf stayed a regex over card_is_tags. It does
		// not: the pattern becomes part of the tag NAME, and no row carries `game_^prom`.
		expect(tree("game:/^prom/")).toBe(tree('is:"game_^prom"'));
		expect(tree("game:/^prom/")).not.toBe(tree("is:/^prom/"));
	});

	test("a value outside the vocabulary cannot borrow an is: tag", () => {
		expect(tree("game:promo")).not.toBe(tree("is:promo"));
		expect(tree("game:promo")).toBe(tree("is:game_promo"));
		expect(parseScryfallQueryWithDirectives("game:promo").warnings).toEqual([
			"Unsupported term \u201cgame:promo\u201d: this server has no data for that predicate, so it matched no cards.",
		]);
		expect(parseScryfallQueryWithDirectives("game:paper").warnings).toEqual([]);
	});
});

/**
 * `in:` parses onto its own CARD-level column. The rules live in the engine (`assign_in_tags`),
 * measured there; what the parser owes is the leaf shape, and that a comparison is a comparison.
 */
describe("in: is a card_in_tags leaf", () => {
	const wire = (query: string): string => JSON.stringify(parseScryfallQueryWithDirectives(query).tree);

	test("every namespace is one column, one value", () => {
		for (const v of ["paper", "khm", "core", "ja", "rare", "2015", "foil", "booster"]) {
			const tree = wire(`in:${v}`);
			expect(tree).toContain('"attribute_name":"card_in_tags"');
			expect(tree).toContain(`"rhs":["${v}"]`);
		}
		// Lower-cased on the way out, like the engine's vocabulary.
		expect(wire("in:KHM")).toContain('"rhs":["khm"]');
	});

	test("no warning: Scryfall has no value validator for it, so neither does this", () => {
		expect(parseScryfallQueryWithDirectives("in:nonsense").warnings).toEqual([]);
	});

	test("negation is the card-level complement Scryfall's docs describe (`-in:core`)", () => {
		expect(wire("-in:core")).toMatch(/^\{"node_type":"NotNode"/);
	});
});
