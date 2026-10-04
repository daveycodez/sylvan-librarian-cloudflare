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
		// A value that only STARTS with one is a different thing on Scryfall (the rest is a name
		// word) and is not reproduced: it is still the unknown-keyword sentence here.
		for (const term of ["pow=xx", "pow=x*", "pow=**", "pow=x2", "pow=1a"]) {
			expectIgnored(term, term, "Unknown keyword “pow”.");
		}
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
