// Bare words that hold a bracket or a number, and the leftover of a pattern a `/` closed early —
// read as api.scryfall.com reads them, on /cards/search only.
//
// Reported 2026-10-25 from mtg-seeker (Scryfall vs sylvan.mtgseeker.com): `t:goblin a]b`,
// `lightning]`, `o:/a[/]b/`, `fo:/[0-2][/][0-2]/` and `t:goblin 1/1` were each a 400 here where
// Scryfall answers 14, 67, 7,694 (with a warning), 404 and 404. Every total in this file was read
// off api.scryfall.com that day; the harness engine is a fake, so the route tests here assert what
// REACHES the engine — the tree of a query production already answers like Scryfall — and the
// status and warnings, which are decided before it.

import { describe, expect, test } from "bun:test";
import { canonicalStringify, type FilterValue, parseScryfallQuery } from "../../src/parser";
import { LexError } from "../../src/parser/errors";
import { TT, tokenize } from "../../src/parser/tokenizer";
import { SCRYFALL_LEX, scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";
import { FakeEngine, json, makeCtx, testDispatch } from "./harness";

const BRACKETS = "Invalid regular expression: brackets [] not balanced.";
/** `Invalid expression “<echo>” was ignored. <reason>` — the echo is Scryfall's, typed out. */
const ignored = (echo: string, reason: string) => `Invalid expression \u201c${echo}\u201d was ignored. ${reason}`;

/** The filter tree /cards/search hands the engine for `q`, with its status and warnings. */
async function reached(q: string): Promise<{ status: number; warnings: unknown; tree: string | undefined }> {
	const engine = new FakeEngine();
	const response = await testDispatch(makeCtx({ engine }), `/cards/search?q=${encodeURIComponent(q)}`);
	const body = await json(response);
	return { status: response.status, warnings: body.warnings ?? null, tree: engine.lastSearch?.filterTreeJson };
}

/** `q` reaches the engine exactly as `equivalent` does — a query the deployed parser already read. */
async function expectSameSearch(q: string, equivalent: string, warnings: string[] | null = null): Promise<void> {
	const got = await reached(q);
	const want = await reached(equivalent);
	expect(want.status).toBe(200);
	expect({ q, status: got.status, warnings: got.warnings, tree: got.tree }).toEqual({
		q,
		status: 200,
		warnings,
		tree: want.tree,
	});
}

describe("the lexer reads `[` and `]` as word characters only when asked", () => {
	test("upstream's lexer — /search's — still refuses them", () => {
		for (const q of ["a]b", "a[b", "lightning]", "]", "o:a]b", "2]"]) {
			expect(() => tokenize(q)).toThrow(LexError);
		}
	});

	test("the compat lexer makes them one more character of the word they touch", () => {
		const words = (q: string) =>
			tokenize(q, SCRYFALL_LEX)
				.filter((t) => t.type !== TT.EOF)
				.map((t) => [t.type, String(t.value)]);
		expect(words("a]b")).toEqual([[TT.WORD, "a]b"]]);
		expect(words("[lightning]")).toEqual([[TT.WORD, "[lightning]"]]);
		expect(words("]")).toEqual([[TT.WORD, "]"]]);
		// A digit followed by one is a word, as `2rr` is — not the number 2 and a stray bracket.
		expect(words("2]")).toEqual([[TT.WORD, "2]"]]);
		expect(words("o:a]b")).toEqual([
			[TT.WORD, "o"],
			[TT.OP, ":"],
			[TT.WORD, "a]b"],
		]);
		// The first unescaped `/` still closes a pattern, inside a class or not.
		expect(words("o:/a[/]b/")).toEqual([
			[TT.WORD, "o"],
			[TT.OP, ":"],
			[TT.REGEX, "a["],
			[TT.WORD, "]b"],
			[TT.SLASH, "/"],
		]);
	});
});

describe("a bracket in a bare word or a value is a character, as on Scryfall", () => {
	// Anchor `t:goblin` = 561 there; `t:goblin ab` = 14, `lightning` = 67, `!ponder` = 1.
	test("the reported three: 14, 14 and 67", async () => {
		await expectSameSearch("t:goblin a]b", "t:goblin ab");
		await expectSameSearch("t:goblin a[b", "t:goblin ab");
		await expectSameSearch("lightning]", "lightning");
	});

	test("anywhere in a name word, the collation drops it", async () => {
		for (const [q, same] of [
			["t:goblin ]b", "t:goblin b"], // 330
			["t:goblin b]", "t:goblin b"], // 330
			["t:goblin a[]b", "t:goblin ab"], // 14
			["t:goblin [ab]", "t:goblin ab"], // 14
			["t:goblin -a]b", "t:goblin -ab"], // 547
			["t:goblin (a]b)", "t:goblin (ab)"], // 14
			["t:goblin name:a]b", "t:goblin name:ab"], // 14
			["t:goblin a]-b", "t:goblin a-b"], // 14
			["t:goblin a]b-c", "t:goblin ab-c"], // 404
			["pon[der", "ponder"], // 7
			["[lightning", "lightning"], // 67
			["[lightning]", "lightning"],
			["light[]ning", "lightning"],
			["[[lightning]]", "lightning"],
			["lightning-]", "lightning"],
			["lightning]/bolt", "lightning/bolt"], // 2
			["name:[ponder]", "name:ponder"], // 7
			["a:[seb]", "a:seb"], // 190: the artist column is collated too
			["!ponder]", "!ponder"], // 1
			["![ponder]", "!ponder"], // 1
			["2]", "name:2"], // 9
		] as const) {
			await expectSameSearch(q, same);
		}
	});

	test("a bracket alone collates to nothing and matches every card", async () => {
		await expectSameSearch("t:goblin ]", "t:goblin name:*"); // 561
		await expectSameSearch("t:goblin [", "t:goblin name:*"); // 561
		await expectSameSearch("t:goblin -]", "t:goblin -name:*"); // 404
		await expectSameSearch("t:goblin -[", "t:goblin -name:*"); // 404
		await expectSameSearch("t:goblin -name:]", "t:goblin -name:*"); // 404
	});

	test("a literal column keeps it", async () => {
		await expectSameSearch("t:goblin o:a]b", 't:goblin o:"a]b"'); // 404
		await expectSameSearch("t:goblin o:]", 't:goblin o:"]"'); // 404
		await expectSameSearch("o:[", 'o:"["'); // 31
		await expectSameSearch("t:gob]lin", 't:"gob]lin"'); // 404
		await expectSameSearch("t:goblin]", 't:"goblin]"'); // 404
		await expectSameSearch("t:goblin e:[", 't:goblin e:"["'); // 404
		await expectSameSearch("e:[ t:goblin or t:elf", 'e:"[" t:goblin or t:elf'); // 698
	});

	test("quoted, it was already a character", async () => {
		await expectSameSearch('t:goblin "a]b"', 't:goblin "a]b"'); // 404
		await expectSameSearch('t:goblin name:"a]b"', 't:goblin name:"a]b"'); // 404
	});

	test("/search keeps upstream's lexer, which refuses the bracket", async () => {
		const response = await testDispatch(makeCtx(), `/search?q=${encodeURIComponent("t:goblin a]b")}`);
		expect(response.status).toBe(400);
	});
});

describe("the closing `/` of a pattern ends its term, and the rest is the next one", () => {
	test("the reported patterns: the broken head is ignored, the leftover searched", async () => {
		// 7,694 = `b`, 17 = `1`, 404 = no name holds "02".
		await expectSameSearch("o:/a[/]b/", "b", [ignored("o:/a[/", BRACKETS)]);
		await expectSameSearch("o:/1[/]1/", "name:1", [ignored("o:/1[/", BRACKETS)]);
		expect(scryfallTermPolicy("fo:/[0-2][/][0-2]/")).toMatchObject({
			query: "][0-2]/",
			warnings: [ignored("fo:/[0-2][/", BRACKETS)],
			allIgnored: false,
		});
		await expectSameSearch("fo:/[0-2][/][0-2]/", "name:02", [ignored("fo:/[0-2][/", BRACKETS)]);
		// The one that already agreed (561) still does.
		await expectSameSearch("o:/a[b/ t:goblin", "t:goblin", [ignored("o:/a[b/", BRACKETS)]);
	});

	test("a 404 carries no warnings, as Scryfall's does not", async () => {
		const engine = new FakeEngine();
		engine.cards = [];
		engine.totalCards = 0;
		const q = "fo:/[0-2][/][0-2]/";
		const response = await testDispatch(makeCtx({ engine }), `/cards/search?q=${encodeURIComponent(q)}`);
		expect(response.status).toBe(404);
		expect((await json(response)).warnings).toBeUndefined();
	});

	test("its variants quote the head Scryfall quotes", async () => {
		await expectSameSearch("o:/a[/]b/ t:goblin", "b t:goblin", [ignored("o:/a[/", BRACKETS)]); // 330
		await expectSameSearch("t:goblin -o:/a[/]b/", "t:goblin b", [ignored("-o:/a[/", BRACKETS)]); // 330
		await expectSameSearch("name:/a[/]b/", "b", [ignored("name:/a[/", BRACKETS)]); // 7,694
		await expectSameSearch("o:/a[/]", "name:*", [ignored("o:/a[/", BRACKETS)]); // 33,827
		await expectSameSearch("t:goblin o:/[/]/", "t:goblin name:*", [ignored("o:/[/", BRACKETS)]); // 561
		await expectSameSearch("t:goblin o:/x[/]/y/", "t:goblin name:* y", [ignored("o:/x[/", BRACKETS)]); // 57
		await expectSameSearch("]b/", "b"); // 7,694
	});

	test("a whole pattern followed by more is two terms", async () => {
		expect(scryfallTermPolicy("t:goblin o:/haste/b").query).toBe("t:goblin o:/haste/b"); // nothing dropped
		await expectSameSearch("t:goblin o:/haste/b", "t:goblin o:/haste/ b"); // 55
		await expectSameSearch("t:goblin o:/haste/]", "t:goblin o:/haste/ name:*"); // 90
		// An ESCAPED slash does not close it: one pattern, `a/]b`, matching nothing (404).
		expect(scryfallTermPolicy("o:/a\\/]b/")).toMatchObject({ query: "o:/a\\/]b/", warnings: [] });
	});

	test("the pattern a group holds is split inside the group", () => {
		expect(scryfallTermPolicy("t:goblin (o:/a[/]b/ or t:elf)")).toMatchObject({
			query: "t:goblin (]b/ or t:elf)",
			warnings: [ignored("o:/a[/", BRACKETS)],
		});
	});
});

describe("a bare number is a name word, and a slash ends a bare word", () => {
	test("the reported `t:goblin 1/1`: no goblin's name holds a 1 (404)", async () => {
		expect(scryfallTermPolicy("t:goblin 1/1")).toMatchObject({ query: "t:goblin name:1 name:1", warnings: [] });
		await expectSameSearch("t:goblin 1/1", "t:goblin name:1");
	});

	test("every shape Scryfall reads as name words", async () => {
		for (const [q, same] of [
			["1", "name:1"], // 17
			["t:goblin 1", "t:goblin name:1"], // 404
			["1/1", "name:1"], // 17
			["1//1", "name:1"], // 17
			["1/1/1", "name:1"], // 17
			["(1/1)", "(name:1)"], // 17
			["1 1", "name:1"], // 17
			["1,", "name:1"], // 17
			["*/1", "name:* name:1"], // 17
			["1]/1", "name:1"], // 17
			["2/2", "name:2"], // 9
			["2/2/2", "name:2"], // 9
			["2*", "name:2"], // 9
			["*2", "name:2"], // 9
			["11", "name:11"], // 3 — so `1/1` is NOT the collated "11"
			["x/1", "x name:1"], // 2
			["1/b", "name:1 b"], // 3
			["b/1", "b name:1"], // 3
			["t:goblin 1/b", "t:goblin name:1 b"], // 404
			["-1/1", "-name:1 name:1"], // 404
			["t:goblin -1", "t:goblin -name:1"], // 561
			["-2", "-name:2"], // 33,818
			["1-2", "name:12"], // 2
			["1.5", "name:15"], // 404
			["t:goblin 1.5", "t:goblin name:15"], // 404
			["1.5/2", "name:15 name:2"], // 404
			["cmc/2", "name:cmc name:2"], // 404
			["cmc/power", "name:cmc name:power"], // 404
			["cmc-power", "name:cmcpower"], // 404
			["cmc*2", "name:cmc2"], // 404
			["pow/tou", "name:pow name:tou"], // 404
			["2*3", "name:23"], // 1
			["ajani 2", "ajani name:2"], // 404
		] as const) {
			await expectSameSearch(q, same);
		}
	});

	test("what the parser already read as a filter is left byte-identical", () => {
		for (const q of ["fire/ice", "t:goblin a/b", "2rr", "fire-ice", "power-sink", "*ft*", "o:1/1", '"1/1"']) {
			expect({ q, query: scryfallTermPolicy(q).query }).toEqual({ q, query: q });
		}
	});

	test("a column compared with a column is left byte-identical", () => {
		// Arithmetic inside a comparison (`cmc+1>3`, `power/2>1`) and `+` in a word (`1+2`, `+2`) are
		// Scryfall's name words now — tests/routes/scryfall-punctuation.test.ts.
		expect(scryfallTermPolicy("pow>tou").query).toBe("pow>tou");
	});

	test("/search keeps upstream's arithmetic reading", async () => {
		const response = await testDispatch(makeCtx(), `/search?q=${encodeURIComponent("t:goblin 1/1")}`);
		expect(response.status).toBe(400);
	});

	test("each respelled word is the name word the collation would have searched", () => {
		const tree = (q: string) => canonicalStringify(parseScryfallQuery(q, undefined, SCRYFALL_LEX) as FilterValue);
		expect(tree("name:12")).toBe(tree("name:1-2"));
		expect(tree("name:15")).toBe(tree("name:1.5"));
		expect(tree("name:23")).toBe(tree("name:2*3"));
	});
});
