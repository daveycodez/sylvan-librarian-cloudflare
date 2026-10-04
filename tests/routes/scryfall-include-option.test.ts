// `include:` — Scryfall's in-query spelling of `include_extras` and its two siblings.
//
// Measured on api.scryfall.com 2026-10-03 (x66 R6, reported from mtg-seeker); the request behind
// each expectation is in src/routes/scryfall-compat/query-terms.ts beside INCLUDE_VALUES.

import { describe, expect, test } from "bun:test";
import {
	hasNestedScryfallDisplayOption,
	NESTED_DISPLAY_OPTIONS_DETAILS,
	scryfallTermPolicy,
} from "../../src/routes/scryfall-compat/query-terms";
import { FakeEngine, json, makeCtx, testDispatch } from "./harness";

const NONE = { extras: false, variations: false, multilingual: false };

/** The `is:` tags the default lane still excludes, read off the tree the engine was handed. */
async function closedGates(path: string): Promise<{ gates: string[]; multilingual: boolean | undefined }> {
	const engine = new FakeEngine();
	await testDispatch(makeCtx({ engine }), path);
	const tree = engine.lastSearch?.filterTreeJson ?? "";
	return {
		gates: ["extra", "variation"].filter((tag) => tree.includes(`"rhs":["${tag}"]`)),
		multilingual: engine.lastSearch?.includeMultilingual,
	};
}

describe("include: is a display option", () => {
	test("the reported query parses, and the option leaves the query", () => {
		const result = scryfallTermPolicy("name:/^reset$/ include:extras");
		expect(result.query).toBe("name:/^reset$/");
		expect(result.warnings).toEqual([]);
		expect(result.include).toEqual({ ...NONE, extras: true });
		expect(scryfallTermPolicy("include:extras lightning").query).toBe("lightning");
	});

	test.each([
		["extras", { ...NONE, extras: true }],
		["extra", { ...NONE, extras: true }],
		["variations", { ...NONE, variations: true }],
		["variation", { ...NONE, variations: true }],
		["multilingual", { ...NONE, multilingual: true }],
		["all", { extras: true, variations: true, multilingual: true }],
		["everything", { extras: true, variations: true, multilingual: true }],
		// Accepted, silently, and nothing observable moves.
		["funny", NONE],
		["digital", NONE],
		["EXTRAS", { ...NONE, extras: true }],
	])("include:%s", (value, include) => {
		const result = scryfallTermPolicy(`include:${value} cmc=3`);
		expect(result.query).toBe("cmc=3");
		expect(result.warnings).toEqual([]);
		expect(result.include).toEqual(include);
	});

	test.each([
		["foo", "foo"],
		["FOO", "foo"],
		["foreign", "foreign"],
		["tokens", "tokens"],
		["any", "any"],
		["1", "1"],
		// Quotes are part of the value: `include:"extras"` is not `include:extras`.
		['"extras"', '"extras"'],
		// Ten characters, three ASCII dots included.
		["extras,variations", "extras,..."],
		["extrasx", "extrasx"],
	])("an unknown value is ignored with the DIRECTION sentence: include:%s", (value, echo) => {
		const result = scryfallTermPolicy(`include:${value} cmc=3`);
		expect(result.query).toBe("cmc=3");
		expect(result.include).toEqual(NONE);
		expect(result.warnings).toEqual([`Unknown direction choice “${echo}” was ignored`]);
	});

	test("a `-` changes nothing, and several options add up", () => {
		expect(scryfallTermPolicy("-include:extras t:goblin cmc=0").include.extras).toBe(true);
		expect(scryfallTermPolicy("-include:foo t:goblin").warnings).toEqual([
			"Unknown direction choice “foo” was ignored",
		]);
		const both = scryfallTermPolicy("include:extras include:variations cmc=3");
		expect(both.query).toBe("cmc=3");
		expect(both.include).toEqual({ ...NONE, extras: true, variations: true });
		const mixed = scryfallTermPolicy("t:goblin include:extras include:foo");
		expect(mixed.include.extras).toBe(true);
		expect(mixed.warnings).toHaveLength(1);
	});

	test("it is removed before the connectors are read", () => {
		expect(scryfallTermPolicy("include:extras or t:goblin cmc=0").query).toBe("t:goblin cmc=0");
	});

	test("only under `:` — `=` is an unknown keyword and a comparison matches nothing", () => {
		const equals = scryfallTermPolicy("include=extras t:goblin");
		expect(equals.query).toBe("t:goblin");
		expect(equals.include).toEqual(NONE);
		expect(equals.warnings).toEqual(["Invalid expression “include=extras” was ignored. Unknown keyword “include”."]);
		expect(scryfallTermPolicy("include>extras t:goblin").query).toBe("cmc<0 t:goblin");
	});

	test("alone it is the 400 with no warnings — an option is not a term", async () => {
		const response = await testDispatch(makeCtx(), "/cards/search?q=include%3Aextras");
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({
			object: "error",
			code: "bad_request",
			status: 400,
			warnings: null,
			details: "All of your terms were ignored.",
		});
		const withIgnored = await testDispatch(
			makeCtx(),
			`/cards/search?q=${encodeURIComponent("include:extras f:notaformat")}`,
		);
		expect(withIgnored.status).toBe(400);
		expect((await json(withIgnored)).warnings).toEqual([
			"Invalid expression “f:notaformat” was ignored. Unknown game format “notaformat”",
		]);
	});

	test("inside parentheses it is Scryfall's display-option 400", async () => {
		for (const q of ["(include:extras t:goblin) cmc=0", "t:goblin cmc=0 (include:extras or t:elf)"]) {
			expect(hasNestedScryfallDisplayOption(q)).toBe(true);
			const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(q)}`);
			expect(response.status).toBe(400);
			expect((await json(response)).details).toBe(NESTED_DISPLAY_OPTIONS_DETAILS);
		}
		expect(hasNestedScryfallDisplayOption('(o:"include:extras")')).toBe(false);
	});
});

describe("include: opens the same gates the parameters open", () => {
	test("the default closes both; include:extras opens one, include:variations the other", async () => {
		expect((await closedGates("/cards/search?q=elf")).gates).toEqual(["extra", "variation"]);
		expect((await closedGates("/cards/search?q=elf+include%3Aextras")).gates).toEqual(["variation"]);
		expect((await closedGates("/cards/search?q=elf+include%3Avariations")).gates).toEqual(["extra"]);
		expect((await closedGates("/cards/search?q=elf+include%3Aall")).gates).toEqual([]);
	});

	test("the option beats a parameter that says false", async () => {
		expect((await closedGates("/cards/search?q=elf+include%3Aextras&include_extras=false")).gates).toEqual([
			"variation",
		]);
	});

	test("include:multilingual and include:all reach the engine's multilingual switch", async () => {
		expect((await closedGates("/cards/search?q=elf")).multilingual).toBe(false);
		expect((await closedGates("/cards/search?q=elf+include%3Amultilingual")).multilingual).toBe(true);
		expect((await closedGates("/cards/search?q=elf+include%3Aall")).multilingual).toBe(true);
	});

	test("an unknown value opens nothing and the page carries the warning", async () => {
		const response = await testDispatch(makeCtx(), "/cards/search?q=elf+include%3Afoo");
		expect(response.status).toBe(200);
		expect((await json(response)).warnings).toEqual(["Unknown direction choice “foo” was ignored"]);
		expect((await closedGates("/cards/search?q=elf+include%3Afoo")).gates).toEqual(["extra", "variation"]);
	});

	test("/cards/random reads it too", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/random?q=elf+include%3Aextras");
		expect(engine.lastSampleArgs?.filterTreeJson ?? "").not.toContain('"rhs":["extra"]');
		const gated = new FakeEngine();
		await testDispatch(makeCtx({ engine: gated }), "/cards/random?q=elf");
		expect(gated.lastSampleArgs?.filterTreeJson ?? "").toContain('"rhs":["extra"]');
	});
});
