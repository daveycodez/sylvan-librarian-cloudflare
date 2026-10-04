// The refusals Scryfall decides on a regex's TEXT, before it compiles the pattern.
//
// Every string and every boundary here was read off api.scryfall.com on 2026-10-03 (x66, reported
// from mtg-seeker, whose queries are validated on this port and shipped as public Scryfall
// queries). See src/routes/scryfall-compat/query-terms.ts for the request behind each row.

import { describe, expect, test } from "bun:test";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";
import { json, makeCtx, testDispatch } from "./harness";

/** `Invalid expression “<echo>” was ignored. <reason>` — the echo is Scryfall's, typed out. */
const ignored = (echo: string, reason: string) => `Invalid expression \u201c${echo}\u201d was ignored. ${reason}`;

const search = (q: string) => testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(q)}`);

describe("a regex over Scryfall's complexity budget is ignored", () => {
	const COMPLEX = "Regular expression too complex.";
	const runs = (body: string) => {
		const q = `t:instant o:/${body}/`;
		const result = scryfallTermPolicy(q);
		expect(result.warnings).toEqual([]);
		expect(result.query).toBe(q);
	};
	const refused = (body: string) => {
		const result = scryfallTermPolicy(`t:instant o:/${body}/`);
		expect(result.query).toBe("t:instant");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toEndWith(`was ignored. ${COMPLEX}`);
	};
	const letters = "abcdefghijklmnopqrstuvwxyz";
	/** `destroy target (creature|qazxjkvw|qbzxjkvw|…)` with `n` junk alternatives — R2a's shape. */
	const junkAlternation = (n: number) =>
		`destroy target (${["creature", ...Array.from({ length: n }, (_, i) => `q${letters[i]}zxjkvw`)].join("|")})`;

	test("the score: `.` and `(` cost 1, a quantifier 2, `|` 4, and 90 is refused", () => {
		runs(".".repeat(89));
		refused(".".repeat(90));
		runs(`destroy${".".repeat(89)}creature`);
		refused(`destroy${".".repeat(90)}creature`);
		for (const quantified of ["a*", "a+", "a?"]) {
			runs(quantified.repeat(44));
			refused(quantified.repeat(45));
		}
		runs(`x${"|".repeat(22)}`);
		refused(`x${"|".repeat(23)}`);
		runs(`${"(a)".repeat(29)}${".".repeat(60)}`);
		refused(`${"(a)".repeat(30)}${".".repeat(60)}`);
		runs(`${"a{2}".repeat(14)}${".".repeat(60)}`);
		refused(`${"a{2}".repeat(15)}${".".repeat(60)}`);
	});

	test("it is one sum, not a cap per character", () => {
		runs(`${".".repeat(45)}${"a*".repeat(22)}`);
		refused(`${".".repeat(46)}${"a*".repeat(22)}`);
		runs(`${"|".repeat(20)}${".".repeat(9)}`);
		refused(`${"|".repeat(20)}${".".repeat(10)}`);
		runs(".*".repeat(29));
		refused(".*".repeat(30));
		runs(`${"a*?".repeat(7)}${".".repeat(60)}`);
		refused(`${"a*?".repeat(8)}${".".repeat(60)}`);
	});

	test("a lookaround costs its parenthesis and its question mark", () => {
		for (const group of ["(?=a)", "(?!a)", "(?<=a)", "(?<!a)", "(?:a)"]) {
			runs(`${group.repeat(9)}${".".repeat(60)}`);
			refused(`${group.repeat(10)}${".".repeat(60)}`);
		}
	});

	test("an escaped or bracketed operator costs what a live one does", () => {
		runs(`${"\\.".repeat(44)}${".".repeat(45)}`);
		refused(`${"\\.".repeat(45)}${".".repeat(45)}`);
		runs(`${"[.]".repeat(29)}${".".repeat(60)}`);
		refused(`${"[.]".repeat(30)}${".".repeat(60)}`);
		runs("[|]".repeat(22));
		refused("[|]".repeat(23));
		runs("\\|".repeat(22));
		refused("\\|".repeat(23));
		refused("[*]".repeat(45));
		refused("\\*".repeat(45));
		refused(`${"\\{".repeat(15)}${".".repeat(60)}`);
	});

	test("what weighs nothing", () => {
		for (const free of ["\\s", "\\)", "[a]", "^", "$", "\\w", "\\d", "\\W", "\\n", "-x", "~", "#", ",", ":", "!"]) {
			runs(`${free.repeat(40)}${".".repeat(89)}`);
		}
		runs(`${"a".repeat(150)}${".".repeat(89)}`);
	});

	test("the length: 248 characters run and 249 do not, on every regex keyword", () => {
		for (const ch of ["a", "1", "A", ",", "\u00e9"]) {
			runs(ch.repeat(248));
			refused(ch.repeat(249));
		}
		for (const keyword of ["name", "fo", "fulloracle", "t", "ft"]) {
			expect(scryfallTermPolicy(`t:instant ${keyword}:/${"a".repeat(248)}/`).warnings).toEqual([]);
			expect(scryfallTermPolicy(`t:instant ${keyword}:/${"a".repeat(249)}/`).warnings).toHaveLength(1);
		}
	});

	test("a backslash and a double quote count twice, `#{` three times, `--` once", () => {
		runs("\\.".repeat(82));
		refused("\\.".repeat(83));
		runs("\\w".repeat(82));
		refused("\\w".repeat(83));
		runs(`${'"'.repeat(10)}${"a".repeat(228)}`);
		refused(`${'"'.repeat(10)}${"a".repeat(229)}`);
		runs(`${"#{".repeat(10)}${"a".repeat(218)}`);
		refused(`${"#{".repeat(10)}${"a".repeat(219)}`);
		runs(`${"-".repeat(10)}${"a".repeat(243)}`);
		refused(`${"-".repeat(10)}${"a".repeat(244)}`);
		runs("-".repeat(249));
		runs(`${"'".repeat(10)}${"a".repeat(238)}`);
		refused(`${"'".repeat(10)}${"a".repeat(239)}`);
	});

	test("the reported shapes: a long alternation, and a run of dots", async () => {
		// R2a/R2b: 23 alternatives run (223 characters); 25 do not (241), nor does anything longer.
		runs(junkAlternation(22));
		refused(junkAlternation(24));
		refused(junkAlternation(26));
		// R2d: `destroy` + 135 dots + `creature`, a 150-character body.
		refused(`destroy${".".repeat(135)}creature`);
		// R2c: beside another term the query ANSWERS — this was a 400 for the whole query.
		const q = `t:instant o:/${junkAlternation(27)}/`;
		const response = await search(q);
		expect(response.status).toBe(200);
		expect((await json(response)).warnings).toEqual([ignored("o:/destroy target (\u2026", COMPLEX)]);
		// Alone it is Scryfall's 400, with the warning, and not this port's own sentence.
		const alone = await search(`o:/${junkAlternation(24)}/`);
		expect(alone.status).toBe(400);
		expect(await json(alone)).toMatchObject({
			code: "bad_request",
			details: "All of your terms were ignored.",
			warnings: [ignored("o:/destroy target (\u2026", COMPLEX)],
		});
	});

	test("it is decided before the nesting rule and before the compiler", () => {
		const reasonOf = (body: string) => scryfallTermPolicy(`t:instant o:/${body}/`).warnings[0];
		expect(reasonOf(`(((a)))${".".repeat(90)}`)).toEndWith(COMPLEX);
		expect(reasonOf(`(((a)))${"a".repeat(249)}`)).toEndWith(COMPLEX);
		expect(reasonOf(`[${".".repeat(90)}`)).toEndWith(COMPLEX);
		expect(reasonOf(`(${".".repeat(90)}`)).toEndWith(COMPLEX);
		// 88 dots and one group is 89, and runs; the 89th dot makes 90.
		runs(`${".".repeat(88)}(a)`);
		refused(`${".".repeat(89)}(a)`);
	});
});

describe("a regex whose `{…}` upper bounds add up past 50 is ignored", () => {
	const REPETITION = "Too much repetition.";
	const reasonOf = (body: string) => scryfallTermPolicy(`t:instant o:/${body}/`).warnings;
	const runs = (body: string) => expect(reasonOf(body)).toEqual([]);
	const refused = (body: string) =>
		expect(reasonOf(body)).toEqual([
			ignored([...`o:/${body}/`].length > 20 ? `${`o:/${body}/`.slice(0, 19)}\u2026` : `o:/${body}/`, REPETITION),
		]);

	test("50 runs and 51 does not, as one bound or as several", () => {
		for (const ok of ["a{50}", "a{0,50}", ".{50}", "a{25}b{25}", "x{3,4}y{46}", "a{1}".repeat(26), "(a{10}){10}"]) {
			runs(ok);
		}
		for (const over of [
			"a{51}",
			"a{0,51}",
			".{51}",
			"a{25}b{26}",
			"a{0,25}b{0,26}",
			"x{3,4}y{47}",
			"a{2}".repeat(26),
		]) {
			refused(over);
		}
	});

	test("the upper bound counts, and an open one counts nothing", () => {
		runs("a{25,26}");
		refused("a{51,60}");
		refused("a{60,51}");
		runs("a{51,}");
		runs("x{3,}y{50}");
		runs("a{255,}");
	});

	test("it reads characters: a bracketed brace counts, an escaped or spaced one does not", () => {
		refused("[{51}]");
		refused("{r}{51}");
		refused("a{051}");
		runs("\\{51\\}");
		runs("a{ 51}");
	});

	test("the reported pattern, and where the rule sits", async () => {
		expect(scryfallTermPolicy("t:instant o:/destroy.{135}creature/").warnings).toEqual([
			ignored("o:/destroy.{135}cre\u2026", REPETITION),
		]);
		expect(scryfallTermPolicy("t:instant o:/destroy[^.]{0,100}creature/").warnings).toEqual([
			ignored("o:/destroy[^.]{0,10\u2026", REPETITION),
		]);
		// The bound mtg-seeker's queries actually use.
		runs("destroy[^.]{0,35}creature");
		// After the other two text rules, before the compiler.
		expect(reasonOf("(((a{60})))")[0]).toEndWith("Too many nested groups.");
		expect(reasonOf(`a{60}${".".repeat(90)}`)[0]).toEndWith("Regular expression too complex.");
		refused("a{60}[");
		const response = await search("o:/a{1000}/");
		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({
			details: "All of your terms were ignored.",
			warnings: [ignored("o:/a{1000}/", REPETITION)],
		});
	});
});

describe("a regex whose parentheses nest three deep is ignored", () => {
	const NESTED = "Too many nested groups.";

	test("depth 2 runs, and so do siblings however many", () => {
		for (const q of [
			"o:/destroy ((target|another) (nonblack|nonwhite)|that) creature/",
			"t:instant o:/(destroy) (target) (creature)/",
			"t:instant o:/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/",
			"t:instant o:/destroy ((target)|(another)) (creature)/",
			"t:instant o:/(?<!x(y))destroy target creature/",
		]) {
			const result = scryfallTermPolicy(q);
			expect(result.warnings).toEqual([]);
			expect(result.query).toBe(q);
		}
	});

	test("depth 3 alone is the 400 that carries the warning", async () => {
		const q = "o:/destroy ((target (nonblack|nonwhite))|that) creature/";
		const result = scryfallTermPolicy(q);
		expect(result.allIgnored).toBe(true);
		expect(result.warnings).toEqual([ignored("o:/destroy ((target\u2026", NESTED)]);
		const response = await search(q);
		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({
			object: "error",
			code: "bad_request",
			status: 400,
			warnings: [ignored("o:/destroy ((target\u2026", NESTED)],
			details: "All of your terms were ignored.",
		});
	});

	test("depth 3 beside another term is dropped, and the rest answers with the warning", async () => {
		const result = scryfallTermPolicy("t:instant o:/destroy (((target))) creature/");
		expect(result.query).toBe("t:instant");
		expect(result.warnings).toEqual([ignored("o:/destroy (((targe\u2026", NESTED)]);
		const response = await search("t:instant o:/destroy (((target))) creature/");
		expect(response.status).toBe(200);
		expect((await json(response)).warnings).toEqual([ignored("o:/destroy (((targe\u2026", NESTED)]);
	});

	test.each([
		["t:instant o:/destroy (?:(?:(?:target))) creature/", "o:/destroy (?:(?:(?\u2026"],
		["t:instant o:/destroy (((?=target))) creature/", "o:/destroy (((?=tar\u2026"],
		["t:instant o:/destroy ((?!(x))target) creature/", "o:/destroy ((?!(x))\u2026"],
		["t:instant o:/(?<!x(y(z)))destroy target creature/", "o:/(?<!x(y(z)))dest\u2026"],
		["t:instant o:/((destroy)(( target))) creature/", "o:/((destroy)(( tar\u2026"],
		["t:instant name:/(((a)))/", "name:/(((a)))/"],
		["t:instant t:/(((instant)))/", "t:/(((instant)))/"],
		["t:instant ft:/(((the)))/", "ft:/(((the)))/"],
		["t:instant mana:/((({r})))/", "mana:/((({r})))/"],
		["t:instant -o:/(((target)))/", "-o:/(((target)))/"],
		["t:instant O:/Destroy (((Target))) creature/", "o:/destroy (((targe\u2026"],
	])("every kind of group and every regex keyword: %s", (q, echo) => {
		const result = scryfallTermPolicy(q);
		expect(result.query).toBe("t:instant");
		expect(result.warnings).toEqual([ignored(echo, NESTED)]);
	});

	test("it counts the two characters, escaped or bracketed, and not the groups", () => {
		for (const [q, echo] of [
			["t:instant o:/destroy (?:(?:[(]?target)) creature/", "o:/destroy (?:(?:[(\u2026"],
			["t:instant o:/destroy (?:(?:\\(?target)) creature/", "o:/destroy (?:(?:\\(\u2026"],
			["t:instant o:/\\(\\(\\(/", "o:/\\(\\(\\(/"],
			["t:instant o:/[(][(][(]/", "o:/[(][(][(]/"],
			["t:instant o:/destroy (?#(((x)target creature/", "o:/destroy (?#(((x)\u2026"],
		] as const) {
			expect(scryfallTermPolicy(q).warnings).toEqual([ignored(echo, NESTED)]);
		}
		// A REAL depth of three that the count reads as one, because each `\)` and `[)]` closed a
		// level: both run on Scryfall (404 under `t:instant`, no warning).
		for (const q of ["t:instant o:/(\\)(\\)(a)))/", "t:instant o:/([)]([)](a)))/"]) {
			expect(scryfallTermPolicy(q).warnings).toEqual([]);
		}
	});

	test("it is decided before the compiler speaks, and after the keyword is", () => {
		expect(scryfallTermPolicy("t:instant o:/(((a/").warnings).toEqual([ignored("o:/(((a/", NESTED)]);
		expect(scryfallTermPolicy("t:instant o:/(((a)))[/").warnings).toEqual([ignored("o:/(((a)))[/", NESTED)]);
		// The counter is not clamped at zero: it reaches -1, comes back to 2, and the compiler's
		// sentence is the one Scryfall sends.
		expect(scryfallTermPolicy("t:instant o:/())(((a)/").warnings).toEqual([
			ignored("o:/())(((a)/", "Invalid regular expression: parentheses () not balanced."),
		]);
		expect(scryfallTermPolicy("t:instant kw:/(((x)))/").warnings).toEqual([
			ignored("kw:/(((x)))/", "Unknown regular expression keyword \u201ckw\u201d."),
		]);
	});

	test("two of them are two warnings, and a group of nothing else goes with them", () => {
		const result = scryfallTermPolicy("t:instant (o:/(((a)))/ or o:/(((b)))/)");
		expect(result.query).toBe("t:instant");
		expect(result.warnings).toEqual([ignored("o:/(((a)))/", NESTED), ignored("o:/(((b)))/", NESTED)]);
	});

	test("the three shipped queries that carried one", () => {
		// R12, removal-battle: the first regex goes, the second and the `-o:` stay.
		const r12 = scryfallTermPolicy(
			'o:/(?<!would )deals? ([1-9X]|that much|half X|damage( equal|(?= to any target)))[^.]*to (any( other)? target|[^.]*\\bbattle\\b)/ OR o:/remove (up to \\w+|\\w+) counters? from (all |(up to \\w+ )?target )permanents?\\b/ -o:"you control"',
		);
		expect(r12.warnings).toEqual([ignored("o:/(?<!would )deals\u2026", NESTED)]);
		expect(r12.query).toBe(
			'o:/remove (up to \\w+|\\w+) counters? from (all |(up to \\w+ )?target )permanents?\\b/ -o:"you control"',
		);
		// R25, attacking-matters.
		const r25 = scryfallTermPolicy(
			'o:/Whenever (you|((a|an|another|one or more) [^.,"]*)) attacks?/ OR o:"if you attacked" OR o:"if no creatures attacked" OR o:"number of attacking" OR o:"for each attacking"',
		);
		expect(r25.warnings).toEqual([ignored("o:/whenever (you|((\u2026", NESTED)]);
		expect(r25.query).toBe(
			'o:"if you attacked" OR o:"if no creatures attacked" OR o:"number of attacking" OR o:"for each attacking"',
		);
		// R33: all 18,760 creatures on Scryfall, where this port answered 86.
		const r33 = scryfallTermPolicy(
			"fo:/((sacrifice (this creature|it)[^.]*end step)|(end step[^.]*sacrifice (this creature|it)))/ t:creature",
		);
		expect(r33.warnings).toEqual([ignored("fo:/((sacrifice (th\u2026", NESTED)]);
		expect(r33.query).toBe("t:creature");
	});

	test("the colour columns never read a regex, so the rule is not theirs", () => {
		// `c:/w/` is `c:w` on Scryfall — the slashes are value characters.
		expect(scryfallTermPolicy("c:/w/ e:khm").warnings).toEqual([]);
	});

	test("a nested regex still spends the seven-operator budget", async () => {
		const six = "o:/a/ o:/b/ o:/c/ o:/d/ o:/e/ o:/f/";
		const response = await search(`${six} o:/(((g)))/`);
		expect(response.status).toBe(400);
		expect((await json(response)).details).toBe("Too many regular expression operators used");
	});
});
