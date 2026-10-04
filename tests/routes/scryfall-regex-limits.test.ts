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
