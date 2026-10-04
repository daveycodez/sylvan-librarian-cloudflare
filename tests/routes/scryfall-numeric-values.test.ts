// What a numeric column reads where a number goes: `*`, `x`, `y` and `z` are zero, and a number
// past ±2,461,449,600 is not compared with at all.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04; the requests are recorded
// beside each rule in src/routes/scryfall-compat/query-terms.ts (ZERO_WORD_RE and
// VALUE_OUT_OF_RANGE_REASON).

import { describe, expect, test } from "bun:test";
import { EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

const ANCHOR = "e:khm t:god";
const ignored = (echo: string, reason: string) => `Invalid expression “${echo}” was ignored. ${reason}`;

/** The term is kept, as `expected`, with no warning — and what is kept parses. */
function expectKept(term: string, expected: string): void {
	const policy = scryfallTermPolicy(`${term} ${ANCHOR}`);
	expect([term, policy.query, policy.warnings]).toEqual([term, `${expected} ${ANCHOR}`, []]);
	expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
}

/** The term is dropped, the rest of the query is kept, and the one warning is this sentence. */
function expectIgnored(term: string, echo: string, reason: string): void {
	const policy = scryfallTermPolicy(`${term} ${ANCHOR}`);
	expect([term, policy.query, policy.warnings]).toEqual([term, ANCHOR, [ignored(echo, reason)]]);
	const alone = scryfallTermPolicy(term);
	expect([term, alone.allIgnored, alone.warnings]).toEqual([term, true, [ignored(echo, reason)]]);
}

describe("`*`, `x`, `y` and `z` are the number zero on a numeric column", () => {
	// `pow=0` is 1,049 and so are `pow=*` `pow:*` `power=*` `pow=x` `pow=X` `pow=y` `pow=z`;
	// `tou=*` `tou=x` `tou=y` 431; `pt=*` `pt=x` `powtou=x` `pt=z` 406; `loy=x` `loy=X` `loy=*`
	// `loy=z` 4; `cmc=x` `cmc=*` `mv=x` `cmc=y` `cmc=z` 1,432.
	test.each([
		["pow=*", "pow=0"],
		["pow:*", "pow:0"],
		["power=*", "power=0"],
		["pow=x", "pow=0"],
		["pow=X", "pow=0"],
		["pow=y", "pow=0"],
		["pow=z", "pow=0"],
		["tou=*", "tou=0"],
		["toughness=x", "toughness=0"],
		["pt=*", "pt=0"],
		["powtou=x", "powtou=0"],
		["loy=x", "loy=0"],
		["loyalty=*", "loyalty=0"],
		["cmc=x", "cmc=0"],
		["mv=*", "mv=0"],
		["manavalue=y", "manavalue=0"],
	])("%s is %s", (term, expected) => {
		expectKept(term, expected);
	});

	// `pow>*` `pow>x` 17,943 = `pow>0`; `pow>=x` 18,978; `pow<x` `pow<*` 4; `pow<=*` 1,053;
	// `pow!=*` 17,947; and on columns no card holds a zero in (anchor `e:khm` = 305): `usd>x`
	// `prints>x` `artists>=x` `tix>=y` `cn>x` `cn>=*` 305, `edhrec>x` 295, `usdfoil>x` 285.
	test.each([
		["pow>*", "pow>0"],
		["pow>=x", "pow>=0"],
		["pow<x", "pow<0"],
		["pow<=*", "pow<=0"],
		["pow!=*", "pow!=0"],
		["usd>x", "usd>0"],
		["usdfoil>x", "usdfoil>0"],
		["tix>=y", "tix>=0"],
		["edhrec>x", "edhrec>0"],
		["prints>x", "prints>0"],
		["artists>=x", "artists>=0"],
		["collector=x", "collector=0"],
		["cn>x", "cn>0"],
		["cn>=*", "cn>=0"],
	])("under a comparison, and on every numeric column: %s is %s", (term, expected) => {
		expectKept(term, expected);
	});

	test("a year is compared the way the year 0 is: `year>x` is the anchor and `year=x` matches nothing", () => {
		// `year>x e:khm` and `year>=x e:khm` are 305, `year=x` a 404.
		expect(scryfallTermPolicy(`year>x ${ANCHOR}`).query).toBe(scryfallTermPolicy(`year>0 ${ANCHOR}`).query);
		expect(scryfallTermPolicy(`year=x ${ANCHOR}`).query).toBe(scryfallTermPolicy(`year=0 ${ANCHOR}`).query);
	});

	test("the negated leaf is answered as its numeric twin is, echoing what was written", () => {
		// `-pow=*` alone is the 400 carrying `Unknown keyword “-pow”.`; `-cmc=x e:khm` is the anchor
		// carrying the value sentence, as `-cmc=0 e:khm` is; `-pow>x e:khm` is the silent tautology.
		expectIgnored("-pow=*", "-pow=*", "Unknown keyword “-pow”.");
		expectIgnored("-cmc=x", "-cmc=x", "The value must be a number, or “even”/“odd”");
		expect(scryfallTermPolicy(`-pow>x ${ANCHOR}`)).toMatchObject({
			query: scryfallTermPolicy(`-pow>0 ${ANCHOR}`).query,
			warnings: [],
		});
	});

	test("it composes under `or` and inside a group", () => {
		// `pow=x or t:goblin e:khm` is 1,049.
		expect(scryfallTermPolicy("pow=x or t:goblin e:khm").query).toBe("pow=0 or t:goblin e:khm");
		expect(scryfallTermPolicy("(pow=* tou=*) e:khm").query).toBe("(pow=0 tou=0) e:khm");
	});

	test("only those four, only bare, and only alone", () => {
		// `pow=a`, `pow=w`, `pow=?`, `pow=∞`, `pow=inf`, `pow=½` and the quoted `pow="x"`, `pow="*"`,
		// `pow='*'` are each the 400 carrying the unknown-keyword sentence.
		for (const term of ["pow=a", "pow=w", "pow=?", "pow=∞", "pow=inf", "pow=½", 'pow="x"', 'pow="*"', "pow='*'"]) {
			expectIgnored(term, term, "Unknown keyword “pow”.");
		}
		// A value that only STARTS with one is the zero and a term after it — the next describe.
	});

	test("a column that is not numeric does not read them as zero", () => {
		// `cn=x e:khm` is a 404 on Scryfall either way; under `:`/`=` it is the string collector number.
		for (const term of ["o:x", "t:*", "name:x", "cn=x", "number:*", "e:x"]) {
			expect(scryfallTermPolicy(`${term} ${ANCHOR}`).query).toBe(`${term} ${ANCHOR}`);
		}
	});
});

describe("a number past ±2,461,449,600 is `Value out of range`, and the term is ignored", () => {
	const REASON = "Value out of range";

	test("the bound is 2,461,449,600 itself, on either side of zero, and it is the value that is read", () => {
		expectKept("pow>2461449600", "pow>2461449600");
		expectKept("pow>2461449600.0", "pow>2461449600.0");
		expectKept("pow>-2461449600", "pow>-2461449600");
		expectIgnored("pow>2461449601", "pow>2461449601", REASON);
		expectIgnored("pow>2461449600.5", "pow>2461449600.5", REASON);
		expectIgnored("pow>02461449601", "pow>02461449601", REASON);
		expectIgnored("pow>-2461449601", "pow>-2461449601", REASON);
	});

	test.each([
		"pow=9999999999",
		"tou>9999999999",
		"loy<9999999999",
		"pt<2461449601",
		"mv:9999999999",
		"cmc<2461449601",
		"usd<2461449601",
		"tix<9999999999",
		"usdfoil<9999999999",
		"edhrec<9999999999",
		"prints<9999999999",
		"artists<9999999999",
		"year<9999999999",
		"collector<9999999999",
		"cn<9999999999",
		"cn:9999999999",
	])("every numeric column and every operator: %s", (term) => {
		expectIgnored(term, term, REASON);
	});

	test("the echo is cut at 20 characters", () => {
		// `!"Infinity Elemental" pow>99999999999999999999` carries `“pow>999999999999999…”`.
		expectIgnored("pow>99999999999999999999", "pow>999999999999999…", REASON);
	});

	test("the negated forms are answered before it", () => {
		// `-pow>9999999999` is the anchor with no warning; `-pow=9999999999` and `-cmc=9999999999`
		// carry the sentences every negated numeric equality does.
		expect(scryfallTermPolicy(`-pow>9999999999 ${ANCHOR}`).warnings).toEqual([]);
		expectIgnored("-pow=9999999999", "-pow=9999999999", "Unknown keyword “-pow”.");
		expectIgnored("-cmc=9999999999", "-cmc=9999999999", "The value must be a number, or “even”/“odd”");
	});

	test("a number inside the range, and a value that is not a number, are untouched", () => {
		expectKept("pow>2147483648", "pow>2147483648");
		expectKept("cn:123", "cn:123");
		expectKept("pow>tou", "pow>tou");
	});
});

describe("a numeric value ends where the number ends, and what follows is a term of its own", () => {
	const split = (query: string): string => {
		const policy = scryfallTermPolicy(query);
		expect([query, policy.warnings]).toEqual([query, []]);
		expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
		return policy.query;
	};

	// Each pair is one count on api.scryfall.com, 2026-10-04: `pow=1a` 2,743 = `pow=1 a`, `pow=2x`
	// 234, `cmc=3a` 6,254, `tou=2x` 188, `loy=3a` 74, `pow>1a` 11,760, `pow=1.5a` 1, `pow=-1a` 3,
	// `usd>1a e:khm` 47, `year=2021a e:khm` 241, `cn>1a e:khm` 240.
	test.each([
		["pow=1a", "pow=1 a"],
		["pow=2x", "pow=2 x"],
		["cmc=3a", "cmc=3 a"],
		["tou=2x", "tou=2 x"],
		["loy=3a", "loy=3 a"],
		["pow>1a", "pow>1 a"],
		["pow=1.5a", "pow=1.5 a"],
		["pow=-1a", "pow=-1 a"],
		["usd>1a", "usd>1 a"],
		["year=2021a", "year=2021 a"],
		["cn>1a", "cn>1 a"],
	])("after a number: %s is %s", (term, expected) => {
		expect(split(term)).toBe(expected);
	});

	// `pow=xy` 200 = `pow=0 y`, `pow=xx` 46 = `pow=0 x`, `pow=you` 85 = `pow=0 ou`; `pow=toua`
	// 8,059 = `pow=tou a`, and the LONGEST column name is the value: `tou=powerx` is 457 =
	// `tou=power x`, where `tou=pow erx` is 1.
	test.each([
		["pow=xy", "pow=0 y"],
		["pow=xx", "pow=0 x"],
		["pow=you", "pow=0 ou"],
		["pow=toua", "pow=tou a"],
		["tou=powerx", "tou=power x"],
	])("after a zero word or a column name: %s is %s", (term, expected) => {
		expect(split(term)).toBe(expected);
	});

	test("the rest is any term: a keyword term, a negated word, a quoted word, a number", () => {
		// `pow=1t:goblin` 182 = `pow=1 t:goblin`; `pow=1-1` 3,561; `pow=1"a"` 2,742; `pow=*1` 1 =
		// `pow=0 1`; `pow=x2`, `pow=1e1`, `pow=1,2` and `pow=1/2` 404. A bare number is a NAME word
		// there and a numeric literal to this parser, so it is spelled `name:`.
		expect(split("pow=1t:goblin")).toBe("pow=1 t:goblin");
		expect(split("pow=1-1")).toBe("pow=1 -name:1");
		expect(split('pow=1"a"')).toBe('pow=1 "a"');
		expect(split("pow=*1")).toBe("pow=0 name:1");
		expect(split("pow=x2")).toBe("pow=0 name:2");
		expect(split("pow=1e1")).toBe("pow=1 e1");
		expect(split("pow=1,2")).toBe("pow=1 name:2");
		expect(split("pow=1/2")).toBe("pow=1 name:2");
		// ...and the rest is split again where it is itself a numeric leaf.
		expect(split("pow=1tou=2x")).toBe("pow=1 tou=2 x");
	});

	test("a rest of only punctuation is nothing", () => {
		// `pow=1*` `pow=1?` `pow=1!` `pow=1..` 3,563 = `pow=1`; `pow=**` `pow=x*` `pow=***` 1,049.
		for (const term of ["pow=1*", "pow=1?", "pow=1!", "pow=1.."]) expect(split(term)).toBe("pow=1");
		for (const term of ["pow=**", "pow=x*", "pow=***"]) expect(split(term)).toBe("pow=0");
	});

	test("a `+` is a character the name keeps, so the rest is the quoted word", () => {
		// `+2` alone is +2 Mace and `+mace` a 404; `pow=1+1`, `pow=1+*` and `pow=x+1` are 404.
		expect(split("pow=1+1")).toBe('pow=1 "+1"');
		expect(split("pow=1+*")).toBe('pow=1 "+*"');
		expect(split("pow=x+1")).toBe('pow=0 "+1"');
	});

	test("it composes beside other terms and under `or`, and each half is answered as itself", () => {
		expect(split("pow=1a e:khm")).toBe("pow=1 a e:khm");
		expect(split("t:goblin or pow=2x")).toBe("t:goblin or pow=2 x");
		// The number half is still the leaf it would be alone: out of range, it is dropped with
		// its own sentence and the word stays.
		expect(scryfallTermPolicy("pow=9999999999a e:khm")).toMatchObject({
			query: "a e:khm",
			warnings: [ignored("pow=9999999999", "Value out of range")],
		});
	});

	test("not under a leading minus, and not for a value that does not start as a number", () => {
		// `-pow=1a` alone is the 400 carrying `Unknown keyword “-pow”.`; `-cmc=3a e:khm t:god` is
		// the 12 with the value sentence; `-pow>1a e:khm` is the anchor's 305 with no warning.
		expectIgnored("-pow=1a", "-pow=1a", "Unknown keyword “-pow”.");
		expectIgnored("-cmc=3a", "-cmc=3a", "The value must be a number, or “even”/“odd”");
		expect(scryfallTermPolicy(`-pow>1a ${ANCHOR}`)).toMatchObject({ query: `-cmc<0 ${ANCHOR}`, warnings: [] });
		// `pow=+1a` is the unknown-keyword 400 and `mv=evena e:khm` the 305 with the value sentence.
		expectIgnored("pow=+1a", "pow=+1a", "Unknown keyword “pow”.");
		expectIgnored("mv=evena", "mv=evena", "The value must be a number, or “even”/“odd”");
	});

	test("`cn:` under `:` is the string collector number, and a text column is never split", () => {
		expect(scryfallTermPolicy("cn:1a e:fem").query).toBe("cn:1a e:fem");
		expect(scryfallTermPolicy("o:1a t:2x name:xy").query).toBe("o:1a t:2x name:xy");
	});
});

describe("a number may end in its point or open with it, and a `+` is not a sign", () => {
	// `pow=.5` and `cmc=.5` are 1 (Little Girl), `pow=1.` 3,563 = `pow=1`, `cmc=2.` 7,153 = `cmc=2`,
	// `pow=.` 1,049 = `pow=0`, `pow=-.5` a 404 with no warning, `collector:1. e:khm` 1.
	test.each([
		["pow=.5", "pow=0.5"],
		["cmc=.5", "cmc=0.5"],
		["pow=1.", "pow=1"],
		["cmc=2.", "cmc=2"],
		["pow=.", "pow=0"],
		["pow=-.5", "pow=-0.5"],
		["tou>.5", "tou>0.5"],
		["collector:1.", "collector:1"],
		["cn>1.", "cn>1"],
	])("%s is %s", (term, expected) => {
		expectKept(term, expected);
	});

	test("a spelling the parser already reads is left as written", () => {
		// `pow=1.0` and `pow=01` are 3,563, `pow=1.5` and `pow=1.50` 1.
		for (const term of ["pow=1.0", "pow=01", "pow=1.5", "pow=1.50", "pow=-1"]) expectKept(term, term);
	});

	test("`pow=+1` is the unknown-keyword sentence", () => {
		// `pow=+1` alone is the 400 carrying `Unknown keyword “pow”.` — this port kept it for a
		// parser that refused it.
		expectIgnored("pow=+1", "pow=+1", "Unknown keyword “pow”.");
		expectIgnored("cmc=+1", "cmc=+1", "The value must be a number, or “even”/“odd”");
	});
});
