// Scryfall's ignore-and-continue query policy, term by term.
//
// Every expectation here is a MEASUREMENT against api.scryfall.com, not a design: the warning
// sentences, the 20-character expression echo, its DOWNCASE, which characters fold, which keywords
// Scryfall does not know and which of its own it refuses to negate were all read off live
// responses. See src/routes/scryfall-compat/query-terms.ts for the request that produced each.
// Dated 2026-08-16 unless a comment says otherwise; the colour hints and the echo downcase are
// 2026-08-28.
//
// A row typed in lower case cannot measure a case rule. Two of the tests here quoted a mixed-case
// term back verbatim and passed for months because every OTHER row was already lower-case — so a
// case-sensitive expectation belongs on a query whose case is MIXED, and on both halves of it.

import { describe, expect, test } from "bun:test";
import { parseScryfallQuery } from "../../src/parser";
import {
	COLOR_ALIAS_TO_CODES,
	COLOR_COUNT_NAMES,
	COLUMN_SCOPED_COUNT_NAMES,
	DB_COLUMNS,
} from "../../src/parser/db-info";
import { foldSmartQuotes, scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

describe("typographic quote folding", () => {
	test("the four Scryfall folds, and only those four", () => {
		expect(foldSmartQuotes("o:\u201Cdraw\u201D")).toBe('o:"draw"');
		expect(foldSmartQuotes("o:\u2018draw\u2019")).toBe("o:'draw'");
		// `‘’` fold to the APOSTROPHE, not to the double quote. The discriminator is measured:
		// `name:‘Gaea"s Blessing’` finds nothing on Scryfall, which only holds if the result is
		// `name:'Gaea"s Blessing'`; folding all four to `"` would have made it find the card.
		expect(foldSmartQuotes("name:\u201CGaea\u2019s Blessing\u201D")).toBe('name:"Gaea\'s Blessing"');
		for (const literal of [
			"\u00AB",
			"\u00BB",
			"\u2039",
			"\u203A",
			"\u201E",
			"\u201A",
			"\u2032",
			"\u2033",
			"\uFF02",
			"\u300C",
			"\u02BC",
			"`",
			"\u00B4",
		]) {
			expect(foldSmartQuotes(`o:${literal}draw${literal}`)).toBe(`o:${literal}draw${literal}`);
		}
	});

	test("a query with nothing to fold is the same string", () => {
		const q = 't:creature c:r o:"draw a card"';
		expect(foldSmartQuotes(q)).toBe(q);
	});
});

describe("queries with nothing to ignore pass through untouched", () => {
	// The property the whole policy rests on: it may only ever act on a term it has a measured
	// reason to act on. A rebuild that "normalized" an ordinary query would put every search on
	// this file's conscience.
	for (const q of [
		't:creature c:r cmc<=2 o:"draw a card"',
		'!"Lightning Bolt"',
		"(t:creature or t:land) e:khm",
		"-t:creature e:lea",
		"name:/^Whenever/ e:khm",
		"cmc>=3 pow>tou",
		"otag:draw atag:forest",
		// `-cn:1` only. `-date:2021` and `-cmc!=3` used to sit on this line as untouched terms and
		// they are not — see "a negated comparison is not applied" below, which measured both.
		"-cn:1 -r>=rare -c>=2 -produces>=2",
		"m:{2}{R} devotion:{R}{R}",
		"r>=rare f:modern lang:ja oracleid:0d5f3b41-1b4d-4d8b-8d4c-3f1b2c9e8a70",
	]) {
		test(q, () => {
			const result = scryfallTermPolicy(q);
			expect(result.query).toBe(q);
			expect(result.warnings).toEqual([]);
			expect(result.allIgnored).toBe(false);
		});
	}
});

describe("keywords Scryfall does not know", () => {
	test("an upstream-only spelling is dropped and named", () => {
		const result = scryfallTermPolicy("subtype:eldrazi e:khm");
		expect(result.query).toBe("e:khm");
		expect(result.warnings).toEqual([
			"Invalid expression \u201csubtype:eldrazi\u201d was ignored. Unknown keyword \u201csubtype\u201d.",
		]);
		expect(result.allIgnored).toBe(false);
	});

	test("the minus is INSIDE the quoted keyword", () => {
		expect(scryfallTermPolicy("-subtype:human t:cleric").warnings).toEqual([
			"Invalid expression \u201c-subtype:human\u201d was ignored. Unknown keyword \u201c-subtype\u201d.",
		]);
	});

	test("the Scryfall spelling of the same predicate survives", () => {
		// `oracle_tags:` is upstream's and `otag:` is Scryfall's; both reach the same column here,
		// which is what makes ignoring one of them a compat-layer decision rather than a loss.
		expect(scryfallTermPolicy("otag:draw e:khm").warnings).toEqual([]);
		expect(scryfallTermPolicy("oracle_tags:draw e:khm").query).toBe("e:khm");
	});

	for (const keyword of ["subtypes", "types", "color_identity", "coloridentity", "art_tags"]) {
		test(`${keyword}: is unknown to Scryfall`, () => {
			expect(scryfallTermPolicy(`${keyword}:x e:khm`).query).toBe("e:khm");
		});
	}
});

describe("a comparison Scryfall does not implement is honored and matches nothing", () => {
	// ONE rule, not two. An unknown keyword under `>` `>=` `<` `<=` `!=` and a TEXT column under the
	// same five reach the same answer by the same route: the term is kept, it matches nothing, and
	// there is no `warnings` key at all. Under `:`/`=` both run a validator and are ignored-and-warned
	// instead, which is the pair that separates the two mechanisms:
	//
	//   nonsense:1   151 + `Unknown keyword “nonsense”.`   nonsense>=1   404, no warning
	//   t:creature   151                                   t>creature    404, no warning
	//   f:notaformat 151 + `Unknown game format`           f>notaformat  404, no warning
	//   lang:zz      151 + `Unknown language \`zz\``         lang>zz       404, no warning
	//
	// The boundary is a KEYWORD table, enumerated rather than guessed: every alias in DB_COLUMNS
	// and every directive name was probed as `<alias>>=0 e:khm t:creature` against api.scryfall.com
	// on 2026-08-16. See COMPARABLE_KEYWORDS for the three classes the 78 rows fell into.

	test("an unknown keyword under a comparison is NOT the ignore machinery", () => {
		for (const op of [">", ">=", "<", "<=", "!="]) {
			const result = scryfallTermPolicy(`nonsense${op}1 e:khm t:creature`);
			expect(result.warnings).toEqual([]);
			expect(result.query).toBe("cmc<0 e:khm t:creature");
		}
		// …and under `:`/`=` it still is.
		for (const op of [":", "="]) {
			expect(scryfallTermPolicy(`nonsense${op}1 e:khm`).warnings).toEqual([
				`Invalid expression “nonsense${op}1” was ignored. Unknown keyword “nonsense”.`,
			]);
		}
	});

	test("a text column under a comparison matches nothing", () => {
		for (const term of ["t>creature", "t!=creature", "o!=flying", "name!=a", "a>guay", "ft>zzz", "wm>zzz"]) {
			const result = scryfallTermPolicy(`${term} e:khm`);
			expect(result.warnings).toEqual([]);
			expect(result.query).toBe("cmc<0 e:khm");
		}
		// The `:` twins are ordinary searches and must be untouched.
		for (const term of ["t:creature", "o:flying", "name:a", "t=creature"]) {
			expect(scryfallTermPolicy(`${term} e:khm`).query).toBe(`${term} e:khm`);
		}
	});

	test("it runs BEFORE every value validator, so those go quiet under a comparison", () => {
		// `f>notaformat`, `lang>zz`, `oracleid>abc` and `is>foil` are one 404 each with no warning,
		// where `f:notaformat`, `lang:zz` and `oracleid:abc` are all ignored-and-warned.
		for (const term of ["f>notaformat", "lang>zz", "oracleid>abc", "is>foil", "layout>normal", "border>black"]) {
			const result = scryfallTermPolicy(`${term} e:khm t:creature`);
			expect(result.warnings).toEqual([]);
			expect(result.query).toBe("cmc<0 e:khm t:creature");
		}
	});

	test("the directive names take it too", () => {
		for (const keyword of ["unique", "sort", "order", "direction", "dir", "prefer"]) {
			expect(scryfallTermPolicy(`${keyword}>=0 e:khm`).query).toBe("cmc<0 e:khm");
		}
	});

	test("the keywords Scryfall DOES compare are untouched", () => {
		// The other two classes of the enumeration: a real comparison (a count comes back), and a
		// real comparison that checks its value first (rarity, date, devotion — tested above).
		for (const term of [
			"c>=2",
			"ci>=2",
			"colour>=2",
			"commander>=2",
			"id>=2",
			"produces>=2",
			"m>=2",
			"cmc>=3",
			"mv>=3",
			"manavalue>=3",
			"pow>=1",
			"power>=1",
			"tou>=1",
			"toughness>=1",
			"loy>=3",
			"loyalty>=3",
			"usd>=1",
			"eur>=1",
			"tix>=1",
			"cn>=100",
			"number>=100",
			"year>=2022",
			"date>=2022",
			"r>=rare",
			"rarity>=rare",
		]) {
			expect(scryfallTermPolicy(`${term} e:khm`).query).toBe(`${term} e:khm`);
		}
	});

	test("the negated form still takes the tautology, and this rule does not steal it", () => {
		// `-nonsense>=1` and `-t>creature` are 151 with `warnings` absent — the always-true leaf the
		// negation rule installs, NOT this rule's empty one. The negation block runs first, so a
		// negated comparison never reaches here.
		for (const term of ["-nonsense>=1", "-t>creature", "-lang>zz"]) {
			const result = scryfallTermPolicy(`${term} e:khm t:creature`);
			expect(result.warnings).toEqual([]);
			expect(result.query).toBe("-cmc<0 e:khm t:creature");
		}
	});
});

describe("negated numeric equality, which Scryfall cannot express", () => {
	test("mana value gets the value sentence", () => {
		expect(scryfallTermPolicy("-cmc:3 e:lea").warnings).toEqual([
			"Invalid expression \u201c-cmc:3\u201d was ignored. The value must be a number, or \u201ceven\u201d/\u201codd\u201d",
		]);
	});

	test("the other numeric columns get an unknown-keyword sentence", () => {
		expect(scryfallTermPolicy("-tou:1 t:elf").warnings).toEqual([
			"Invalid expression \u201c-tou:1\u201d was ignored. Unknown keyword \u201c-tou\u201d.",
		]);
		expect(scryfallTermPolicy("-usd:0 e:lea").warnings).toEqual([
			"Invalid expression \u201c-usd:0\u201d was ignored. Unknown keyword \u201c-usd\u201d.",
		]);
	});

	test("negation itself is fine — it is negated EQUALITY on these columns that is not", () => {
		for (const q of ["-t:creature e:lea", "-cn:1", "-o:flying e:khm", "-is:foil e:khm"]) {
			expect(scryfallTermPolicy(q).warnings).toEqual([]);
			expect(scryfallTermPolicy(q).query).toBe(q);
		}
	});
});

describe("a negated comparison is not applied — it is always-true, and silently so", () => {
	// The general case of the block above, measured on api.scryfall.com 2026-08-16 with the anchor
	// `e:khm t:creature` = 151. A row answering 151 is a term that did nothing; see
	// NEGATION_HONORING_COMPARISONS in query-terms.ts for the full 65-row table.
	const ALWAYS = "-cmc<0";

	test("every operator, on every column whose positive comparison Scryfall honors", () => {
		//   pow>=1 = 146 / -pow>=1 = 151     cmc!=3 = 106 / -cmc!=3 = 151
		//   tou!=1 = 133 / -tou!=1 = 151     usd>=1 =  28 / -usd>=1 = 151
		for (const keyword of ["pow", "power", "tou", "toughness", "cmc", "mv", "loy", "usd", "eur", "tix", "year", "cn"]) {
			for (const op of [">", ">=", "<", "<=", "!="]) {
				const result = scryfallTermPolicy(`-${keyword}${op}1 e:khm t:creature`);
				expect(result.query).toBe(`${ALWAYS} e:khm t:creature`);
				expect(result.warnings).toEqual([]);
			}
		}
	});

	test("a text column or a keyword neither side knows takes it too, and stays QUIET", () => {
		// `name>zzz`, `t>creature` and `nonsense>=1` are all 404 positive — so the negated form
		// matching everything is ordinary — but `-nonsense>=1 e:khm t:creature` is 151 with NO
		// `warnings` key, where `nonsense:1` is ignored-and-warned. That silence is the assertion.
		for (const q of ["-name>zzz", "-o>draw", "-t>creature", "-layout>normal", "-nonsense>=1", "-subtype>=1"]) {
			const result = scryfallTermPolicy(`${q} e:khm`);
			expect(result.query).toBe(`${ALWAYS} e:khm`);
			expect(result.warnings).toEqual([]);
		}
	});

	test("it runs BEFORE the value validators, because Scryfall's does", () => {
		// Each of these is ignored-and-warned unnegated and 151-with-no-warning negated.
		for (const q of ["-lang>zz", "-f>notaformat", "-oracleid>abc", "-cmc>=notanumber"]) {
			expect(scryfallTermPolicy(`${q} e:khm`)).toMatchObject({ query: `${ALWAYS} e:khm`, warnings: [] });
		}
	});

	test("the set-comparison columns negate correctly and must be left alone", () => {
		// `r>=rare` 52 / `-r>=rare` 99, `c>=2` 19 / `-c>=2` 132, `m>=2` 102 / `-m>=2` 49,
		// `produces>=2` 5 / `-produces>=2` 146, `devotion>={r}{r}` 7 / negated 144 — all exact
		// complements of the 151 anchor, so the boundary is the KEYWORD and not the operator.
		for (const keyword of ["c", "color", "colors", "colour", "colours", "id", "identity", "ci", "commander"]) {
			expect(scryfallTermPolicy(`-${keyword}>=2 e:khm`).query).toBe(`-${keyword}>=2 e:khm`);
		}
		for (const q of ["-r>=rare", "-rarity!=rare", "-m>=2", "-mana!=2", "-produces>=2", "-devotion>={R}{R}"]) {
			expect(scryfallTermPolicy(`${q} e:khm`).query).toBe(`${q} e:khm`);
		}
	});

	test("`-( … )` is honored — the fault is how `-` binds to a LEAF", () => {
		// `-(cmc>=3) e:khm t:creature` = 39, the complement of `cmc>=3`'s 112, where the bare
		// `-cmc>=3` = 151.
		expect(scryfallTermPolicy("-(cmc>=3) e:khm").query).toBe("-(cmc>=3) e:khm");
		expect(scryfallTermPolicy("-(pow>=1 t:god) e:khm").query).toBe("-(pow>=1 t:god) e:khm");
	});

	test("it is a TAUTOLOGY, not a dropped term — which only an `or` can tell apart", () => {
		// `(-pow>=1 or t:god) e:khm` = 323, all of Kaldheim; `(t:god) e:khm` = 13, which is what a
		// REMOVED arm answers. And `-pow>=1` alone is 200 with the whole 33,599-card corpus, where
		// `-pow:1` alone is the 400 "All of your terms were ignored." — two different mechanisms.
		expect(scryfallTermPolicy("(-pow>=1 or t:god) e:khm").query).toBe(`(${ALWAYS} or t:god) e:khm`);
		expect(scryfallTermPolicy("-pow>=1")).toMatchObject({ query: ALWAYS, allIgnored: false, warnings: [] });
		expect(scryfallTermPolicy("-pow:1").allIgnored).toBe(true);
	});

	test("the two mechanisms coexist without borrowing each other's sentence", () => {
		// `-pow>=1 -cmc:3 e:khm t:creature` is 151 warning ONLY about `-cmc:3`.
		expect(scryfallTermPolicy("-pow>=1 -cmc:3 e:khm")).toMatchObject({
			query: `${ALWAYS} e:khm`,
			warnings: ["Invalid expression “-cmc:3” was ignored. The value must be a number, or “even”/“odd”"],
		});
	});

	test("`date` discards the minus instead — every operator, `:` and `=` included", () => {
		// Measured with values that separate all three readings: `date>=2022` = 11 and
		// `-date>=2022` = 11 (honored would be 140, dropped would be the anchor's 151);
		// `date<2022` = 141 = `-date<2022`. `year`, the same column under another name, takes the
		// tautology instead — `year>=2022` = 11, `-year>=2022` = 151 — which the first test pins.
		for (const op of [">", ">=", "<", "<=", "!=", ":", "="]) {
			expect(scryfallTermPolicy(`-date${op}2021 e:khm`).query).toBe(`date${op}2021 e:khm`);
		}
		expect(scryfallTermPolicy("-date>2021 e:khm").warnings).toEqual([]);
	});
});

describe("values a known keyword cannot take", () => {
	test("format", () => {
		expect(scryfallTermPolicy("f:notaformat e:khm").warnings).toEqual([
			"Invalid expression \u201cf:notaformat\u201d was ignored. Unknown game format \u201cnotaformat\u201d",
		]);
		// Measured as honored despite not being a `legalities` key; `pauperedh` and `frontier` are
		// measured as ignored, so this list is a boundary rather than a superset.
		expect(scryfallTermPolicy("f:explorer").warnings).toEqual([]);
	});

	test("language — backticks, not quotes", () => {
		expect(scryfallTermPolicy("lang:zz e:khm").warnings).toEqual([
			"Invalid expression \u201clang:zz\u201d was ignored. Unknown language `zz`",
		]);
		for (const ok of ["lang:ja", "lang:any", "lang:pt-br", "lang:chinesesimplified", "language:english"]) {
			expect(scryfallTermPolicy(`${ok} e:khm`).warnings).toEqual([]);
		}
	});

	test("rarity — the full stop is INSIDE the quotes, which is Scryfall's", () => {
		expect(scryfallTermPolicy("r:notarare e:khm").warnings).toEqual([
			"Invalid expression \u201cr:notarare\u201d was ignored. Unknown rarity \u201cnotarare.\u201d",
		]);
		// A COMPARISON on rarity is ordinary and must survive.
		expect(scryfallTermPolicy("r>=rare e:khm").warnings).toEqual([]);
	});

	test("rarity checks its value under EVERY operator, not only `:`", () => {
		// Rarity is an ordered enum, so `r>rare` is a comparison Scryfall really performs — and it
		// therefore checks the value the same way it does under equality. Anchor `e:khm t:creature`
		// = 151, one request each: all seven of these answer 151 carrying the same sentence, where
		// this port used to answer `400 Failed to parse query` for the five comparisons.
		for (const op of [":", "=", ">", ">=", "<", "<=", "!="]) {
			expect(scryfallTermPolicy(`r${op}notarare e:khm t:creature`).warnings).toEqual([
				`Invalid expression “r${op}notarare” was ignored. Unknown rarity “notarare.”`,
			]);
		}
		// `rarity>=0` is 151 with `Unknown rarity “0.”` — a number is not a rarity either.
		expect(scryfallTermPolicy("rarity>=0 e:khm").warnings).toEqual([
			"Invalid expression “rarity>=0” was ignored. Unknown rarity “0.”",
		]);
		// And the real comparisons still pass through untouched, in both polarities.
		for (const term of ["r>rare", "r<=mythic", "r!=common", "-r>=rare"]) {
			expect(scryfallTermPolicy(`${term} e:khm`).warnings).toEqual([]);
		}
	});

	test("devotion takes one colour repeated, or one hybrid PAIR repeated", () => {
		// Measured against api.scryfall.com 2026-08-16, anchor `e:khm t:creature` = 151.
		const devotion = "Devotion can only match single color or hybrid mana.";
		for (const [value, reason] of [
			["2", devotion],
			["{c}", devotion],
			["{s}", devotion],
			["{x}", devotion],
			["{1}", devotion],
			["{2/r}", devotion],
			["{r/p}", devotion],
			["{w}{u}", devotion],
			["{r}{g}", devotion],
			["rg", devotion],
			["{r}{r/g}", devotion],
			// Not a mana symbol at all — a different sentence, and the echo is the value as
			// written with toUpperCase applied.
			["{p}", "Unknown mana symbols “{P}”."],
			["{}", "Unknown mana symbols “{}”."],
			["notmana", "Unknown mana symbols “NOTMANA”."],
		] as [string, string][]) {
			expect(scryfallTermPolicy(`devotion:${value} e:khm`).warnings).toEqual([
				`Invalid expression “devotion:${value}” was ignored. ${reason}`,
			]);
		}
		// Honored: one colour repeated, one hybrid pair repeated, either brace order, unbraced.
		for (const value of [
			"{r}",
			"{R}",
			"r",
			"{r}{r}",
			"rr",
			"{r}{r}{r}",
			"{r/g}",
			"{g/r}",
			"{r/g}{r/g}",
			"{r/g}{g/r}",
		]) {
			expect(scryfallTermPolicy(`devotion:${value} e:khm`).warnings).toEqual([]);
		}
	});

	test("devotion checks its value in BOTH polarities and under every operator", () => {
		// `-devotion>2` and `-devotion:2` are 151 with the devotion sentence, the same as their
		// positive twins — a VALUE check, not a negation rule. `devotion` is in
		// NEGATION_HONORING_COMPARISONS, which is what lets a negated comparison reach the
		// validator instead of being swallowed as an always-true leaf.
		for (const term of ["devotion:2", "devotion>2", "devotion>=2", "-devotion:2", "-devotion>2"]) {
			expect(scryfallTermPolicy(`${term} e:khm t:creature`).warnings).toEqual([
				`Invalid expression “${term}” was ignored. Devotion can only match single color or hybrid mana.`,
			]);
		}
		expect(scryfallTermPolicy("-devotion>={r}{r} e:khm").warnings).toEqual([]);
	});

	test("oracle id must be a v4 UUID", () => {
		expect(scryfallTermPolicy("oracleid:notauuid e:khm").warnings).toEqual([
			"Invalid expression \u201coracleid:notauuid\u201d was ignored. You must provide a valid v4 UUID.",
		]);
	});

	test("a numeric column asked for a word: ignored under `:`, unsatisfiable under a comparison", () => {
		// Two different Scryfall answers, so two different rules: `q=cmc:notanumber` is the 400 with
		// a warning, and `q=cmc>=notanumber` is the ordinary 404 — the term is HONORED and matches
		// nothing. Dropping the second would have turned `cmc>=notanumber e:khm` into all of
		// Kaldheim where Scryfall answers "no cards".
		expect(scryfallTermPolicy("cmc:notanumber").allIgnored).toBe(true);
		expect(scryfallTermPolicy("pow:notanumber").warnings).toEqual([
			"Invalid expression \u201cpow:notanumber\u201d was ignored. Unknown keyword \u201cpow\u201d.",
		]);
		const comparison = scryfallTermPolicy("cmc>=notanumber e:khm");
		expect(comparison.warnings).toEqual([]);
		expect(comparison.allIgnored).toBe(false);
		expect(comparison.query).toBe("cmc<0 e:khm");
	});
});

describe("regular expressions the pattern cannot be", () => {
	// Scryfall compiles in Ruby and reports Onigmo's sentence; these four were read off live
	// responses. The port's own 503 on this input — a non-JSON body from user text — is what the
	// pre-validation exists to prevent.
	const cases: [string, string][] = [
		["o:/[unclosed/", "brackets [] not balanced."],
		["name:/[a-/", "brackets [] not balanced."],
		["o:/(unclosed/", "parentheses () not balanced."],
		["o:/a)/", "parentheses () not balanced."],
		["o:/a{2,1}/", "invalid repetition count(s)."],
	];
	for (const [q, reason] of cases) {
		test(q, () => {
			expect(scryfallTermPolicy(q).warnings).toEqual([
				`Invalid expression \u201c${q}\u201d was ignored. Invalid regular expression: ${reason}`,
			]);
		});
	}

	test("a pattern that compiles is left alone, escapes and all", () => {
		for (const q of ["o:/\\(this creature/", "name:/\\./ e:khm", "o:/\\+1\\/\\+1/", "cn:/\\d/"]) {
			expect(scryfallTermPolicy(q).warnings).toEqual([]);
			expect(scryfallTermPolicy(q).query).toBe(q);
		}
	});
});

describe("what is left when terms leave", () => {
	test("a group whose every arm went takes its parentheses with it", () => {
		const result = scryfallTermPolicy("(subtype:elf or subtype:goblin) e:war");
		expect(result.query).toBe("e:war");
		expect(result.warnings).toHaveLength(2);
	});

	test("a group that keeps an arm keeps its parentheses", () => {
		expect(scryfallTermPolicy("(subtype:elf t:creature) e:war").query).toBe("(t:creature) e:war");
	});

	test("a connector orphaned by a drop goes too", () => {
		expect(scryfallTermPolicy("t:creature or subtype:elf").query).toBe("t:creature");
		expect(scryfallTermPolicy("subtype:elf or t:creature").query).toBe("t:creature");
	});

	test("every term ignored is the 400 case", () => {
		const result = scryfallTermPolicy("subtype:elf or subtype:goblin");
		expect(result.allIgnored).toBe(true);
		expect(result.warnings).toHaveLength(2);
	});

	test("an empty group is all-ignored even with nothing to warn about", () => {
		expect(scryfallTermPolicy("()").allIgnored).toBe(true);
		expect(scryfallTermPolicy("()").warnings).toEqual([]);
	});

	test("a dangling operator is the bare KEYWORD, searched as a name", () => {
		// Not a dropped term and not a vacuous one: `t:` is `t`, and a bare word is `name:t`.
		// Sixteen live pairs pin it (see danglingOperatorTerm); the ones this asserts are
		// `t: e:khm` = `t e:khm` = 215, `-t: e:khm` = 108, and `t:` alone = `name:t` = 22,261
		// rather than the 400 that "every term was ignored" would produce.
		expect(scryfallTermPolicy("t: e:khm")).toMatchObject({
			query: "name:t e:khm",
			warnings: [],
			allIgnored: false,
		});
		expect(scryfallTermPolicy("-t: e:khm").query).toBe("-name:t e:khm");
		const alone = scryfallTermPolicy("t:");
		expect(alone.allIgnored).toBe(false);
		expect(alone.warnings).toEqual([]);
		expect(alone.query).toBe("name:t");
	});

	test("the operator characters stay on the word for the =-family, and only for it", () => {
		// `t>` = `t<` = `t:` = 215 in Kaldheim; `t=`, `t>=`, `t<=` and `t!=` are all 404, the same
		// answer `name:"t="` gives. The split is measured, not tidied.
		expect(scryfallTermPolicy("t> e:khm").query).toBe("name:t e:khm");
		expect(scryfallTermPolicy("t< e:khm").query).toBe("name:t e:khm");
		expect(scryfallTermPolicy("t= e:khm").query).toBe('name:"t=" e:khm');
		expect(scryfallTermPolicy("t>= e:khm").query).toBe('name:"t>=" e:khm');
		expect(scryfallTermPolicy("t!= e:khm").query).toBe('name:"t!=" e:khm');
	});

	test("a keyword neither side knows is still a bare word once its value is gone", () => {
		// `nonsense:x` is "Unknown keyword"; `nonsense:` is the 404 `q=nonsense` gives, because
		// the term never reaches the keyword table at all.
		expect(scryfallTermPolicy("nonsense: e:khm")).toMatchObject({
			query: "name:nonsense e:khm",
			warnings: [],
		});
		expect(scryfallTermPolicy("cmc: e:khm").query).toBe("name:cmc e:khm");
		expect(scryfallTermPolicy("subtype: e:khm").query).toBe("name:subtype e:khm");
	});
});

describe("colour values Scryfall refuses, and the sentence it refuses them with", () => {
	// The `m` rule reads the WHOLE value, cuts at five characters, and is decided BEFORE the
	// colored-and-colorless contradiction. All three halves are measured: `c:monocolor` spells a
	// `c` next to an `r` AND contains an `m`, and Scryfall answers the `m` sentence.
	const M_RULE: [string, string][] = [
		["c:mono", "no"],
		["c:mm", ""],
		["c:mwu", "uw"],
		["c:mzy", "yz"],
		["c:m1", "1"],
		["c:mono-red", "denor"],
		["c:monocolor", "clnor"],
		["c:monocolored", "cdeln"],
		["c:nephilim", "ehiln"],
		["c:chromatic", "achio"],
		["c:spectrum", "ceprs"],
		["c:prismatic", "acipr"],
	];
	for (const [term, rest] of M_RULE) {
		test(`${term} names ${rest === "" ? "nothing" : rest}`, () => {
			expect(scryfallTermPolicy(`${term} e:khm`).warnings).toEqual([
				`Invalid expression \u201c${term}\u201d was ignored. Using \u201cm\u201d with other colors is no longer supported. Use c>${rest} instead.`,
			]);
		});
	}

	test("the contradiction is what is left when there is no m", () => {
		for (const term of ["c:witch", "c:colorful", "c:wubrgc", "c:blackwhite"]) {
			expect(scryfallTermPolicy(`${term} e:khm`).warnings[0]).toContain("A card cannot be both colored and colorless.");
		}
	});

	test("produces: has no contradiction and a narrower name table", () => {
		// Colorless is a producible VALUE there, so `produces:wubrgc` is honoured and the three
		// WORDS for colorless are not names: `produces:colorless` answers the unknown-letter
		// sentence where `c:colorless` is simply accepted.
		expect(scryfallTermPolicy("produces:colorless e:khm").warnings).toEqual([
			"Invalid expression \u201cproduces:colorless\u201d was ignored. Unknown color \u201ce\u201d",
		]);
		expect(scryfallTermPolicy("produces:brown e:khm").warnings).toEqual([
			"Invalid expression \u201cproduces:brown\u201d was ignored. Unknown color \u201cn\u201d",
		]);
		expect(scryfallTermPolicy("produces:wubrgc e:khm").warnings).toEqual([]);
		expect(scryfallTermPolicy("c:brown e:khm").warnings).toEqual([]);
	});

	test("the names the parser learned are no longer ignored", () => {
		// Every one of these was a warned-and-dropped term until the parser gained
		// COLOR_ALIAS_TO_CODES; `all` is the one this table had to gain alongside it.
		for (const term of ["c:azorius", "id:bant", "ci:yore-tiller", "c:artifice", "c:rainbow", "c:all", "produces:all"]) {
			expect(scryfallTermPolicy(`${term} e:khm`).warnings).toEqual([]);
		}
	});

	test("the colour-COUNT names are silent here, on every operator and every column", () => {
		// These were listed in COLOR_NAMES without a parser spelling — silent here and a 400 from
		// the parser — until COLOR_COUNT_NAMES landed. They must stay silent, because Scryfall
		// honours them: `c:m e:khm` = `c>=2 e:khm` = 44, not an ignored term.
		//
		// `produces:` is in the list too, and still silent, even though the parser refuses a count
		// on that column (Scryfall counts six values there, colorless included). Silent-and-400 is
		// the deliberate posture for a value Scryfall HONOURS and this port cannot yet answer:
		// warning would claim a term was dropped that Scryfall applied, and widening the result.
		for (const term of [
			"c:m",
			"c:gold",
			"c:multicolor",
			"c:multicolour",
			"c:multicolored",
			"c:multicoloured",
			"c=m",
			"c>m",
			"c>=m",
			"c<m",
			"c<=m",
			"c!=m",
			"id:m",
			"ci<m",
			"identity!=gold",
			"produces:m",
			"produces<m",
			"produces<=m",
			"colour:m",
			"colours>=2",
			"commander:m",
			"commander:wu",
			"c:M",
			"c:GOLD",
		]) {
			expect(scryfallTermPolicy(`${term} e:khm`).warnings).toEqual([]);
		}
	});

	test("produces:any is honoured here, and c:any / id:any are still dropped", () => {
		// `any` is a produced_mana name and nothing else. Measured against api.scryfall.com
		// 2026-08-28: `produces:any` = 2,603 = `produces>=1`, so warning would claim a term was
		// dropped that Scryfall applied — while `c:any` on its own answers "All of your terms were
		// ignored" and `t:creature c:any` = `t:creature` = 18,753, so the drop is what Scryfall
		// does there. This port dropped BOTH, which is what made `produces:any` match everything.
		for (const op of [":", "=", ">", ">=", "<", "<=", "!="]) {
			expect(scryfallTermPolicy(`produces${op}any e:khm`).warnings).toEqual([]);
		}
		expect(scryfallTermPolicy("produces:ANY e:khm").warnings).toEqual([]);
		for (const kw of ["c", "color", "colors", "colour", "colours", "ci", "id", "identity", "commander"]) {
			expect(scryfallTermPolicy(`${kw}:any e:khm`).warnings).toEqual([
				`Invalid expression “${kw}:any” was ignored. Unknown color “a”`,
			]);
		}
		// Alone, with nothing left standing: every term ignored, exactly as Scryfall answers it.
		expect(scryfallTermPolicy("c:any").allIgnored).toBe(true);
		expect(scryfallTermPolicy("produces:any").allIgnored).toBe(false);
	});

	test("the identity spellings Scryfall REFUSES are unknown keywords, not colour values", () => {
		// Scryfall's identity vocabulary is a boundary — `id`/`identity`/`ci`/`commander` and
		// nothing else — so these answer "Unknown keyword", NOT a colour complaint. `coloridentity`
		// and `color_identity` are absent on purpose: this parser accepts them (upstream's own
		// spellings) where Scryfall does not, and answering where Scryfall warns costs nobody
		// anything, so they are not listed as unknown here either.
		for (const kw of ["cid", "colouridentity", "commanderidentity"]) {
			const warnings = scryfallTermPolicy(`${kw}:wu e:khm`).warnings;
			expect(warnings).toEqual([`Invalid expression “${kw}:wu” was ignored. Unknown keyword “${kw}”.`]);
		}
	});

	test("m beside another colour still gets the m sentence, on every column", () => {
		// The `m` rule is decided BEFORE the colored-and-colorless contradiction and BEFORE the
		// unknown-letter sentence, and gaining the count names must not move that line: `c:mc`
		// spells a `c` next to an `m` and still answers the `m` sentence, not the contradiction.
		for (const [term, hint] of [
			["c:mw", "c>w"],
			["c:wm", "c>w"],
			["c:mc", "c>c"],
			["c!=mw", "c>w"],
			["id:mw", "id>w"],
			["produces:mw", "produces>w"],
		] as [string, string][]) {
			expect(scryfallTermPolicy(`${term} e:khm`).warnings).toEqual([
				`Invalid expression “${term}” was ignored. Using “m” with other colors is no longer supported. Use ${hint} instead.`,
			]);
		}
	});

	// MEASURED 2026-08-28, one request each, anchor `e:khm` = 323. The hint echoes THE KEYWORD THE
	// USER TYPED — ten spellings, ten different hints — where this port said `c>` for all ten. The
	// `c:` spelling agreed by coincidence, which is why the divergence hid until the value-axis
	// sweep put a colour-count name on the other columns (42 cases).
	const HINT_BY_KEYWORD: [string, string, string][] = [
		["c", "mw", "c>w"],
		["color", "mw", "color>w"],
		["colors", "mw", "colors>w"],
		["colour", "mw", "colour>w"],
		["colours", "mw", "colours>w"],
		["ci", "mw", "ci>w"],
		["id", "mw", "id>w"],
		["identity", "mw", "identity>w"],
		["commander", "mw", "commander>w"],
		["produces", "mw", "produces>w"],
		// the two the sweep actually caught, verbatim off the live responses
		["id", "mono", "id>no"],
		["produces", "nephilim", "produces>ehiln"],
	];
	for (const [keyword, value, hint] of HINT_BY_KEYWORD) {
		test(`${keyword}:${value} hints ${hint}`, () => {
			expect(scryfallTermPolicy(`${keyword}:${value} e:khm`).warnings).toEqual([
				`Invalid expression “${keyword}:${value}” was ignored. Using “m” with other colors is no longer supported. Use ${hint} instead.`,
			]);
		});
	}

	test("the keyword echoed in the hint is LOWERCASED however it was typed", () => {
		// Measured 2026-08-28: `C:MW e:khm` comes back "… Use c>w instead." and `Id:mw` "… Use
		// id>w instead." — the hint is the keyword folded to lower case, never the letters as
		// typed. The WHOLE sentence is asserted now, echo included: this test used to stop at the
		// hint and leave the quoted expression unmeasured, which is exactly where the port was
		// wrong. See "the echoed expression is lower-cased" below for the rule.
		//
		// q=C:MW e:khm  → 200, 323, one warning, verbatim:
		expect(scryfallTermPolicy("C:MW e:khm").warnings).toEqual([
			"Invalid expression “c:mw” was ignored. Using “m” with other colors is no longer supported. Use c>w instead.",
		]);
		// q=Id:mw e:khm → 200, 323, one warning, verbatim:
		expect(scryfallTermPolicy("Id:mw e:khm").warnings).toEqual([
			"Invalid expression “id:mw” was ignored. Using “m” with other colors is no longer supported. Use id>w instead.",
		]);
	});
});

/**
 * THE ANTI-DRIFT ASSERTION.
 *
 * The compat layer's colour-name table and the parser's are one vocabulary, and keeping them as two
 * hand-written lists cost us the same bug twice: `produces:any` (fixed 3288c89) and then all five
 * Strixhaven colleges, which the parser has spelled since 2026-08-16 while the compat table did
 * not — so `c:lorehold e:khm t:creature` answered the UNFILTERED 151 with a warning where Scryfall
 * answers 2, across three columns and seven operators (105 sweep cases).
 *
 * query-terms now DERIVES its table from db-info, so an addition can no longer be missed. What
 * derivation cannot police is the other direction — the parser gaining a name Scryfall REFUSES,
 * which would turn a warning Scryfall emits into a silent answer — so that is what this asserts,
 * name by name, over the whole vocabulary and on every colour column.
 */
describe("the compat colour vocabulary is the parser's colour vocabulary", () => {
	const SET_NAMES = [...COLOR_ALIAS_TO_CODES.keys()];
	const COUNT_NAMES = [...COLOR_COUNT_NAMES];
	const ALL_NAMES = [...SET_NAMES, ...COUNT_NAMES];
	// Only `any` today, and it is produced_mana's alone — see db-info's COLUMN_SCOPED_COUNT_NAMES.
	const PRODUCES_ONLY = [...(COLUMN_SCOPED_COUNT_NAMES.get("produced_mana") ?? [])];
	// `produces:` refuses the WORDS for colorless, because colorless is a producible value there
	// spelled `c`. Derived from the codes, exactly as query-terms derives it.
	const COLORLESS_WORDS = SET_NAMES.filter((n) => COLOR_ALIAS_TO_CODES.get(n) === "c");

	test("every name the parser spells survives the policy on c: and id:, unwarned", () => {
		for (const name of ALL_NAMES) {
			for (const keyword of ["c", "id"]) {
				const verdict = scryfallTermPolicy(`${keyword}:${name} e:khm`);
				expect({ name, keyword, ...verdict }).toMatchObject({ query: `${keyword}:${name} e:khm`, warnings: [] });
			}
		}
	});

	test("every name the compat layer keeps, the parser can actually parse", () => {
		// The half derivation cannot give us: a name kept here that the parser cannot spell is a
		// 400 where Scryfall answers. Both directions are now bonded, not just documented.
		for (const name of ALL_NAMES) {
			for (const keyword of ["c", "id"]) {
				expect(() => parseScryfallQuery(`${keyword}:${name}`)).not.toThrow();
			}
		}
		for (const name of [...ALL_NAMES.filter((n) => !COLORLESS_WORDS.includes(n)), ...PRODUCES_ONLY]) {
			expect(() => parseScryfallQuery(`produces:${name}`)).not.toThrow();
		}
	});

	test("produces: takes the same vocabulary minus the words for colorless, plus its scoped names", () => {
		expect(COLORLESS_WORDS.sort()).toEqual(["brown", "colorless", "colourless"]);
		for (const name of ALL_NAMES.filter((n) => !COLORLESS_WORDS.includes(n))) {
			expect(scryfallTermPolicy(`produces:${name} e:khm`).warnings).toEqual([]);
		}
		for (const name of PRODUCES_ONLY) {
			expect(scryfallTermPolicy(`produces:${name} e:khm`).warnings).toEqual([]);
		}
	});

	test("the scoped names stay scoped: c:any and id:any are still dropped", () => {
		// The one entry the colour columns must NOT gain. `t:creature c:any` = `t:creature` =
		// 18,753 on Scryfall — the term is rejected and dropped, not applied.
		for (const keyword of ["c", "id"]) {
			for (const name of PRODUCES_ONLY) {
				expect(scryfallTermPolicy(`${keyword}:${name} e:khm`).warnings).toEqual([
					`Invalid expression “${keyword}:${name}” was ignored. Unknown color “${[...new Set(name)].sort()[0]}”`,
				]);
			}
		}
	});

	test("the words for colorless are refused on produces: and nowhere else", () => {
		expect(scryfallTermPolicy("produces:colorless e:khm").warnings).toEqual([
			"Invalid expression “produces:colorless” was ignored. Unknown color “e”",
		]);
		expect(scryfallTermPolicy("produces:brown e:khm").warnings).toEqual([
			"Invalid expression “produces:brown” was ignored. Unknown color “n”",
		]);
		expect(scryfallTermPolicy("c:colorless e:khm").warnings).toEqual([]);
		expect(scryfallTermPolicy("c:brown e:khm").warnings).toEqual([]);
	});

	test("the boundary is still a boundary: the names Scryfall refuses are still refused", () => {
		// Derivation must not have widened the table. These came back "Unknown color …" or the `m`
		// sentence live (2026-08-16), and none of them may become a silent answer.
		for (const name of ["yore", "glint", "dune", "ink", "witch", "five", "mono", "nephilim", "chromatic", "guild"]) {
			expect(scryfallTermPolicy(`c:${name} e:khm`).warnings.length).toBe(1);
		}
	});

	// THE FIVE COLLEGES, which is what the derivation was for. Scryfall's counts against
	// `e:khm t:creature` (151 unfiltered), measured 2026-08-28: c:lorehold 2, c:prismari 2,
	// c:quandrix 3, c:silverquill 2, c:witherbloom 4 — and id:lorehold 52, produces:lorehold 5,
	// so the term is honoured on all three columns rather than dropped.
	const COLLEGES: [string, string][] = [
		["lorehold", "rw"],
		["prismari", "ur"],
		["quandrix", "gu"],
		["silverquill", "wb"],
		["witherbloom", "bg"],
	];
	for (const [college, letters] of COLLEGES) {
		test(`${college} resolves on c:, id: and produces:, and spells ${letters}`, () => {
			expect(COLOR_ALIAS_TO_CODES.get(college)).toBe(letters);
			for (const keyword of ["c", "id", "produces"]) {
				for (const op of [":", "=", "!=", "<", "<=", ">", ">="]) {
					const term = `${keyword}${op}${college}`;
					expect({ term, ...scryfallTermPolicy(`${term} e:khm`) }).toMatchObject({
						query: `${term} e:khm`,
						warnings: [],
					});
				}
			}
		});
	}
});

test("a long expression is echoed at 20 characters, ellipsis included", () => {
	// Measured a character at a time: `f:abcdefghijklmnopqr` (19) comes back whole and one more
	// character comes back cut. Only the EXPRESSION is cut — the reason still names the full value.
	expect(scryfallTermPolicy("f:abcdefghijklmnopqr").warnings[0]).toContain("\u201cf:abcdefghijklmnopqr\u201d");
	const cut = scryfallTermPolicy("f:abcdefghijklmnopqrs").warnings[0] as string;
	expect(cut).toContain("\u201cf:abcdefghijklmnopq\u2026\u201d");
	expect(cut).toContain("Unknown game format \u201cabcdefghijklmnopqrs\u201d");
});

describe("the echoed expression is lower-cased, keyword AND value", () => {
	// MEASURED 2026-08-28 against api.scryfall.com, one request per row, anchor `e:khm` = 323 — the
	// exact query is the first column and the assertion is that response's `warnings[0]`, verbatim.
	//
	// `C:MW` alone cannot decide this: both halves are upper-case, so it is equally consistent with
	// a keyword-only downcase and with a whole-expression downcase. The three colour rows below are
	// the separator — `C:mw` and `c:MW` each contradict one of the two readings, and both come back
	// fully lower-cased — and the rows after them show the rule has nothing to do with colour
	// vocabulary: it holds for an unknown keyword, for a quoted string, and for the contents of a
	// regex literal, where case is unambiguously load-bearing to what the value spells.
	//
	// Echoing a downcased value is safe precisely because the term is being reported as IGNORED:
	// this text is display, and the query handed to the parser keeps the user's case (asserted at
	// the bottom of this block).
	const ECHO: [string, string][] = [
		// keyword upper, value lower — contradicts "only the value is downcased"
		[
			"C:mw e:khm",
			"Invalid expression “c:mw” was ignored. Using “m” with other colors is no longer supported. Use c>w instead.",
		],
		// keyword lower, value upper — contradicts "only the keyword is downcased"
		[
			"c:MW e:khm",
			"Invalid expression “c:mw” was ignored. Using “m” with other colors is no longer supported. Use c>w instead.",
		],
		// both upper — the probe that started this, and the one that could not decide it
		[
			"C:MW e:khm",
			"Invalid expression “c:mw” was ignored. Using “m” with other colors is no longer supported. Use c>w instead.",
		],
		[
			"c:MonoColor e:khm",
			"Invalid expression “c:monocolor” was ignored. Using “m” with other colors is no longer supported. Use c>clnor instead.",
		],
		[
			"Id:NePhIlIm e:khm",
			"Invalid expression “id:nephilim” was ignored. Using “m” with other colors is no longer supported. Use id>ehiln instead.",
		],
		// The REASON names a downcased value too, wherever it names one at all — the second half of
		// the same divergence, and invisible to every pre-existing test because they all typed
		// lower-case values.
		["F:NOTAFORMAT e:khm", "Invalid expression “f:notaformat” was ignored. Unknown game format “notaformat”"],
		["R:NotARare e:khm", "Invalid expression “r:notarare” was ignored. Unknown rarity “notarare.”"],
		["R>NotARare e:khm", "Invalid expression “r>notarare” was ignored. Unknown rarity “notarare.”"],
		["Lang:ZZ e:khm", "Invalid expression “lang:zz” was ignored. Unknown language `zz`"],
		// A keyword Scryfall does not know is downcased exactly like one it does.
		["SubType:Eldrazi e:khm", "Invalid expression “subtype:eldrazi” was ignored. Unknown keyword “subtype”."],
		["NotAKeyword:MiXeD e:khm", "Invalid expression “notakeyword:mixed” was ignored. Unknown keyword “notakeyword”."],
		// The negation prefix survives; everything after it is downcased.
		["-SubType:Human e:khm", "Invalid expression “-subtype:human” was ignored. Unknown keyword “-subtype”."],
		[
			"Oracleid:NotAUuid e:khm",
			"Invalid expression “oracleid:notauuid” was ignored. You must provide a valid v4 UUID.",
		],
		[
			"Devotion:XyZ e:khm",
			"Invalid expression “devotion:xyz” was ignored. Devotion can only match single color or hybrid mana.",
		],
		[
			"Cmc:NotANumber e:khm",
			"Invalid expression “cmc:notanumber” was ignored. The value must be a number, or “even”/“odd”",
		],
		// A regex literal's CONTENTS are downcased in the echo — the strongest evidence available
		// that this is a downcase of the TEXT and not a normalization of a case-insensitive
		// vocabulary, since `/[Unclosed/` and `/[unclosed/` are different patterns.
		[
			"O:/[Unclosed/ e:khm",
			"Invalid expression “o:/[unclosed/” was ignored. Invalid regular expression: brackets [] not balanced.",
		],
		[
			"Name:/(Unclosed/ e:khm",
			"Invalid expression “name:/(unclosed/” was ignored. Invalid regular expression: parentheses () not balanced.",
		],
		// Quotes are PRESERVED and the quoted words downcased — the echo is the source text, not a
		// term re-rendered from a parse.
		['SubType:"Big Elf" e:khm', 'Invalid expression “subtype:"big elf"” was ignored. Unknown keyword “subtype”.'],
		// Not an ASCII fold: `É` and `Ä` come back as `é` and `ä`.
		["SubType:ÉLDRÄZI e:khm", "Invalid expression “subtype:éldräzi” was ignored. Unknown keyword “subtype”."],
	];
	for (const [q, warning] of ECHO) {
		test(q, () => {
			expect(scryfallTermPolicy(q).warnings).toEqual([warning]);
		});
	}

	test("the downcase happens BEFORE the 20-character cut", () => {
		// q=F:ABCDEFGHIJKLMNOPQRS e:khm → 200, 323, `warnings[0]` verbatim below: the echo is the
		// LOWER-CASED text cut to 20, and the reason names the full value, also lower-cased.
		expect(scryfallTermPolicy("F:ABCDEFGHIJKLMNOPQRS e:khm").warnings).toEqual([
			"Invalid expression “f:abcdefghijklmnopq…” was ignored. Unknown game format “abcdefghijklmnopqrs”",
		]);
		// THE ORDER IS ONLY OBSERVABLE ON A CODEPOINT THAT CHANGES LENGTH WHEN DOWNCASED, so here is
		// one. `f:İABCDEFGHIJKLMNOPQ` is 20 characters as typed — under truncate-then-downcase it
		// would come back WHOLE — but `İ` (U+0130) downcases to `i` + U+0307, which makes it 21 and
		// pushes it over the cut. q=f:İABCDEFGHIJKLMNOPQ e:khm → 200, 323, and the live warning is
		// the string below character for character: cut after `…mno`, and the reason naming the full
		// 19-character downcased value. Ruby's `String#downcase` and JS's `toLowerCase()` agree on
		// this expansion, and slicing by CODE POINT rather than by UTF-16 unit is what keeps the
		// combining mark from being severed from its `i`.
		expect(scryfallTermPolicy("f:İABCDEFGHIJKLMNOPQ e:khm").warnings).toEqual([
			"Invalid expression “f:i̇abcdefghijklmno…” was ignored. Unknown game format “i̇abcdefghijklmnopq”",
		]);
	});

	test("the 400 all-ignored answer carries the SAME downcased warning", () => {
		// q=C:MW → 400 bad_request, details "All of your terms were ignored.", and a warnings array
		// character-for-character the one `C:MW e:khm` carries on its 200. The two answer shapes
		// format the echo identically, so this cannot be right on one path and wrong on the other.
		const alone = scryfallTermPolicy("C:MW");
		expect(alone.allIgnored).toBe(true);
		expect(alone.warnings).toEqual(scryfallTermPolicy("C:MW e:khm").warnings);
		// q=SubType:Eldrazi → 400, the same details, "Invalid expression “subtype:eldrazi” …".
		const unknown = scryfallTermPolicy("SubType:Eldrazi");
		expect(unknown.allIgnored).toBe(true);
		expect(unknown.warnings).toEqual(["Invalid expression “subtype:eldrazi” was ignored. Unknown keyword “subtype”."]);
	});

	test("the QUERY handed to the parser keeps the user's case", () => {
		// The downcase is display-only, and this is the assertion that keeps it that way. `T:Creature
		// e:khm` is 151 on Scryfall with no `warnings` key at all (measured 2026-08-28), so a term
		// that SURVIVES must reach the parser untouched — `o:` and `name:` values above all.
		expect(scryfallTermPolicy("T:Creature e:khm").warnings).toEqual([]);
		expect(scryfallTermPolicy("T:Creature e:khm").query).toBe("T:Creature e:khm");
		expect(scryfallTermPolicy('o:"Draw A Card" Name:Bolt').query).toBe('o:"Draw A Card" Name:Bolt');
		// And a survivor keeps its case even when a sibling is dropped and downcased in the warning.
		const mixed = scryfallTermPolicy('C:MW o:"Draw A Card"');
		expect(mixed.query).toBe('o:"Draw A Card"');
		expect(mixed.warnings[0]).toContain("“c:mw”");
	});
});

describe("parentheses that do not balance", () => {
	// Scryfall has its own sentence for the commonest search-box typo, and gives it for a stray
	// opener and a stray closer alike (measured 2026-08-16 on `e:khm (t:god`, `e:khm t:god)`, `(`).
	for (const q of ["e:khm (t:god", "e:khm t:god)", "(", ")", "((t:god)"]) {
		test(q, () => {
			expect(scryfallTermPolicy(q).unclosedParens).toBe(true);
		});
	}

	test("a parenthesis inside a string, a pattern or a mana symbol is not a parenthesis", () => {
		for (const q of ['name:"(a"', "o:/\\(this creature/", "(t:creature or t:land) e:khm", "m:{2}{R}"]) {
			expect(scryfallTermPolicy(q).unclosedParens).toBe(false);
		}
	});
});

/**
 * THE WHOLE REGEX SURFACE, one row per search alias `DB_COLUMNS` carries.
 *
 * Generated from a probe of api.scryfall.com on 2026-08-28 — every one of the 80 spellings, one
 * request each, `<alias>:/pattern/` with a pattern that means something on that column — and from
 * the Scryfall docs page the probe agrees with:
 * <https://scryfall.com/docs/regular-expressions> grants a regex to `type:`/`t:`, `oracle:`/`o:`,
 * `flavor:`/`ft:` and `name:` and to nothing else.
 *
 * FOUR OUTCOMES, and this table is how they are told apart:
 *
 *  1. BOTH ANSWER. `name:/^Ancient/` 38 = 38, `t:/creature/` 18,753 = 18,753,
 *     `o:/^whenever/` 6,255 = 6,255 on all four oracle spellings, `ft:/^the /` 2,423 / 2,451
 *     (the 28 are a corpus-vintage difference, not a dialect one).
 *  2. SCRYFALL ANSWERS, THIS PORT DID NOT. `st:/^exp/ t:goblin` and `date:/199/ t:goblin` are 563
 *     there and were `400 Failed to parse query` here; `kw:/^fly/ t:goblin` is 563 there and was
 *     404 here — the term having silently become the keyword `fly`. Fixed: the whole family is
 *     ignored-and-warned now, in Scryfall's own words.
 *  3. BOTH REJECT. Every `Unknown keyword` row below: `types`, `subtype`, `subtypes`,
 *     `color_identity`, `coloridentity`, `oracle_tags`, `art_tags` are not Scryfall keywords at
 *     all, so neither side ever reaches the regex question.
 *  4. SCRYFALL IS NOT RUNNING A REGEX. The colour and mana columns read `/…/` as part of the
 *     VALUE: `c:/w/` is 7,105 = `c:w`, `c:/wu/` is 718 = `c:wu`, `id:/w/` 7,993,
 *     `produces:/g/` 1,274, and `mana:/p/ mv=1` is 9 — every one Phyrexian, identical to
 *     `mana:/\smp/ mv=1`. Matching those means teaching the colour and mana value lexers to skip
 *     a `/`, which upstream's grammar does not do; they keep this port's sentence and are NOT
 *     changed here.
 *
 * A FIFTH, which is this port's own and deliberate: the rows under "answered here, warned by
 * Scryfall" are a SUPERSET. `a:/^rebecca/` 170, `s:/^kh/` 442, `cn:/^1/` 17,483,
 * `layout:/^trans/` 401, `border:/^black/` 32,817, `wm:/^az/` 107 — every string column the
 * engine stores takes a pattern (#907), and Scryfall answers each of those
 * `Unknown regular expression keyword`.
 */
describe("the regex surface, alias by alias", () => {
	/** `<alias>:/…/` spellings the policy KEEPS, with what the engine then does with them. */
	const KEPT: Record<string, string> = {
		// Scryfall's own four columns — outcome 1.
		name: "name:/^Ancient/",
		type: "type:/creature/",
		t: "t:/creature/",
		oracle: "oracle:/^whenever/",
		o: "o:/^whenever/",
		fo: "fo:/^whenever/",
		fulloracle: "fulloracle:/^whenever/",
		flavor: "flavor:/^the /",
		ft: "ft:/^the /",
		// This port's superset: the other string columns the engine stores.
		artist: "artist:/^rebecca/",
		a: "a:/^rebecca/",
		set: "set:/^kh/",
		s: "s:/^kh/",
		e: "e:/^kh/",
		number: "number:/^1/",
		cn: "cn:/^1/",
		layout: "layout:/^trans/",
		border: "border:/^black/",
		watermark: "watermark:/^guild/",
		wm: "wm:/^guild/",
		// PLAIN LITERALS on a collection column, which never reach a regex engine at all:
		// `lowerLiteralRegexes` has already turned them into the substring they spell, and the
		// answers are real (`is:/promo/` 6,126, `kw:/flying/` 3,285, `st:/expansion/` 24,741,
		// `frame:/1997/` 6,750, `otag:/removal/` 6,430, `art:/dragon/` 1,149). Scryfall drops
		// each of these; removing a working answer to match a warning buys a searcher nothing.
		frame: "frame:/1997/",
		keyword: "keyword:/flying/",
		kw: "kw:/flying/",
		otag: "otag:/removal/",
		oracletag: "oracletag:/removal/",
		function: "function:/removal/",
		art: "art:/dragon/",
		atag: "atag:/dragon/",
		arttag: "arttag:/dragon/",
		is: "is:/promo/",
		has: "has:/promo/",
		not: "not:/promo/",
		settype: "settype:/expansion/",
		st: "st:/expansion/",
		set_type: "set_type:/expansion/",
		// Outcome 4: Scryfall reads the slashes as value characters and ANSWERS. This port does
		// not, and the parse error it raises downstream is the divergence — the policy keeps the
		// term either way, so nothing here is a claim that the two agree.
		mana: "mana:/p/",
		m: "m:/p/",
	};

	/** `<alias>:/…/` spellings the policy DROPS, with the exact sentence Scryfall answers. */
	const DROPPED: Record<string, [query: string, reason: string]> = {
		// Outcome 3 — not Scryfall keywords, so the regex question never arises on either side.
		subtype: ["subtype:/goblin/", "Unknown keyword \u201csubtype\u201d."],
		subtypes: ["subtypes:/goblin/", "Unknown keyword \u201csubtypes\u201d."],
		types: ["types:/creature/", "Unknown keyword \u201ctypes\u201d."],
		color_identity: ["color_identity:/w/", "Unknown keyword \u201ccolor_identity\u201d."],
		coloridentity: ["coloridentity:/w/", "Unknown keyword \u201ccoloridentity\u201d."],
		oracle_tags: ["oracle_tags:/draw/", "Unknown keyword \u201coracle_tags\u201d."],
		art_tags: ["art_tags:/dragon/", "Unknown keyword \u201cart_tags\u201d."],
		// Outcome 4 — Scryfall answers these as VALUES; this port's colour reader speaks instead.
		color: ["color:/w/", "Unknown color \u201c/\u201d"],
		colors: ["colors:/w/", "Unknown color \u201c/\u201d"],
		colour: ["colour:/w/", "Unknown color \u201c/\u201d"],
		colours: ["colours:/w/", "Unknown color \u201c/\u201d"],
		c: ["c:/w/", "Unknown color \u201c/\u201d"],
		id: ["id:/w/", "Unknown color \u201c/\u201d"],
		identity: ["identity:/w/", "Unknown color \u201c/\u201d"],
		ci: ["ci:/w/", "Unknown color \u201c/\u201d"],
		commander: ["commander:/w/", "Unknown color \u201c/\u201d"],
		produces: ["produces:/g/", "Unknown color \u201c/\u201d"],
		// ...and the two spellings whose VALUE sentence Scryfall gives verbatim, per spelling.
		oracle_id: ["oracle_id:/^0000/", "You must provide a valid v4 UUID."],
		// THE VALUE VALIDATOR GETS THERE FIRST on these three, even for a plain-literal pattern
		// that the parser would happily lower — `/ja/` is not a language and `/abcd/` is not a
		// UUID, so the term is dropped before the regex question is asked. Scryfall drops them
		// too and says `Unknown regular expression keyword …` instead; the OUTCOME is identical
		// and only the sentence differs, so this port keeps the sentence it can justify.
		lang: ["lang:/ja/", "Unknown language `/ja/`"],
		language: ["language:/ja/", "Unknown language `/ja/`"],
		oracleid: ["oracleid:/abcd/", "You must provide a valid v4 UUID."],
		// Outcome 2, now fixed — a real pattern on a column with no regex path. Every sentence
		// below was read off api.scryfall.com; `st:` and `date:` were `400 Failed to parse query`
		// here before this rule, and the collection columns silently answered a DIFFERENT query.
		cmc: ["cmc:/1/", "Unknown regular expression keyword \u201ccmc\u201d."],
		mv: ["mv:/1/", "Unknown regular expression keyword \u201cmv\u201d."],
		manavalue: ["manavalue:/1/", "Unknown regular expression keyword \u201cmanavalue\u201d."],
		power: ["power:/1/", "Unknown regular expression keyword \u201cpower\u201d."],
		pow: ["pow:/1/", "Unknown regular expression keyword \u201cpow\u201d."],
		toughness: ["toughness:/1/", "Unknown regular expression keyword \u201ctoughness\u201d."],
		tou: ["tou:/1/", "Unknown regular expression keyword \u201ctou\u201d."],
		loyalty: ["loyalty:/3/", "Unknown regular expression keyword \u201cloyalty\u201d."],
		loy: ["loy:/3/", "Unknown regular expression keyword \u201cloy\u201d."],
		devotion: ["devotion:/u/", "Unknown regular expression keyword \u201cdevotion\u201d."],
		usd: ["usd:/1/", "Unknown regular expression keyword \u201cusd\u201d."],
		eur: ["eur:/1/", "Unknown regular expression keyword \u201ceur\u201d."],
		tix: ["tix:/1/", "Unknown regular expression keyword \u201ctix\u201d."],
		rarity: ["rarity:/rare/", "Unknown regular expression keyword \u201crarity\u201d."],
		r: ["r:/rare/", "Unknown regular expression keyword \u201cr\u201d."],
		format: ["format:/modern/", "Unknown regular expression keyword \u201cformat\u201d."],
		f: ["f:/modern/", "Unknown regular expression keyword \u201cf\u201d."],
		legal: ["legal:/modern/", "Unknown regular expression keyword \u201clegal\u201d."],
		banned: ["banned:/modern/", "Unknown regular expression keyword \u201cbanned\u201d."],
		restricted: ["restricted:/modern/", "Unknown regular expression keyword \u201crestricted\u201d."],
		date: ["date:/199/", "Unknown regular expression keyword \u201cdate\u201d."],
		year: ["year:/199/", "Unknown regular expression keyword \u201cyear\u201d."],
	};

	/**
	 * The rows above cover a PLAIN-LITERAL pattern on the collection columns; these are the same
	 * columns asked a pattern that needs a real engine, which is the shape that was answering a
	 * different query. Scryfall drops all of them with the same sentence.
	 */
	const DROPPED_ONLY_WHEN_REAL: [query: string, reason: string][] = [
		["kw:/^fly/", "Unknown regular expression keyword \u201ckw\u201d."],
		["keyword:/^fly/", "Unknown regular expression keyword \u201ckeyword\u201d."],
		["otag:/^remov/", "Unknown regular expression keyword \u201cotag\u201d."],
		["function:/^remov/", "Unknown regular expression keyword \u201cfunction\u201d."],
		["art:/^drag/", "Unknown regular expression keyword \u201cart\u201d."],
		["is:/^prom/", "Unknown regular expression keyword \u201cis\u201d."],
		["has:/^prom/", "Unknown regular expression keyword \u201chas\u201d."],
		["not:/^prom/", "Unknown regular expression keyword \u201cnot\u201d."],
		["frame:/^199/", "Unknown regular expression keyword \u201cframe\u201d."],
		["lang:/^ja/", "Unknown regular expression keyword \u201clang\u201d."],
		["oracleid:/^0000/", "Unknown regular expression keyword \u201coracleid\u201d."],
		["st:/^exp/", "Unknown regular expression keyword \u201cst\u201d."],
		["settype:/^exp/", "Unknown regular expression keyword \u201csettype\u201d."],
		// The one spelling that gets a VALUE sentence instead — Scryfall's own split.
		["set_type:/^exp/", "Unknown set type \u201c/^exp/\u201d"],
	];

	for (const [alias, term] of Object.entries(KEPT)) {
		test(`${alias}: keeps a regex`, () => {
			const result = scryfallTermPolicy(`${term} t:goblin`);
			expect(result.query).toBe(`${term} t:goblin`);
			expect(result.warnings).toEqual([]);
		});
	}

	for (const [alias, [term, reason]] of Object.entries(DROPPED)) {
		test(`${alias}: a regex is ignored and named`, () => {
			const result = scryfallTermPolicy(`${term} t:goblin`);
			expect(result.query).toBe("t:goblin");
			expect(result.warnings).toEqual([`Invalid expression \u201c${term}\u201d was ignored. ${reason}`]);
		});
	}

	for (const [term, reason] of DROPPED_ONLY_WHEN_REAL) {
		test(`${term} needs an engine, so it is ignored and named`, () => {
			const result = scryfallTermPolicy(`${term} t:goblin`);
			expect(result.query).toBe("t:goblin");
			expect(result.warnings).toEqual([`Invalid expression \u201c${term}\u201d was ignored. ${reason}`]);
		});
	}

	test("every alias in the vocabulary is classified", () => {
		const classified = new Set([...Object.keys(KEPT), ...Object.keys(DROPPED)]);
		const missing = [...new Set(DB_COLUMNS.flatMap((c) => c.searchAliases))].filter((a) => !classified.has(a));
		expect(missing).toEqual([]);
	});
});
