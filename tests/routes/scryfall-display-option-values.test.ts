// Display options — `unique:`, `order:`/`sort:`, `direction:`/`dir:`, `prefer:`, `display:`/`as:` —
// as Scryfall reads them: never a term, warned about in Scryfall's words, and not an option under `=`.
//
// Measured on api.scryfall.com 2026-10-03 (x66); the request behind each row is in
// src/routes/scryfall-compat/query-terms.ts beside DISPLAY_OPTION_LABELS.

import { describe, expect, test } from "bun:test";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";
import { FakeEngine, json, makeCtx, testDispatch } from "./harness";

const search = (q: string, engine = new FakeEngine()) =>
	testDispatch(makeCtx({ engine }), `/cards/search?q=${encodeURIComponent(q)}`);

describe("an unknown display-option value is warned about in Scryfall's sentence", () => {
	test.each([
		["unique:nonsense", "Unknown unique mode “nonsense” was ignored"],
		["order:nonsense", "Unknown order choice “nonsense” was ignored"],
		["sort:nonsense", "Unknown order choice “nonsense” was ignored"],
		["direction:nonsense", "Unknown direction choice “nonsense” was ignored"],
		["dir:nonsense", "Unknown direction choice “nonsense” was ignored"],
		["prefer:nonsense", "Unknown preference mode “nonsense” was ignored"],
		["display:nonsense", "Unknown display mode “nonsense” was ignored"],
		["as:nonsense", "Unknown display mode “nonsense” was ignored"],
		// Lower-cased, and cut to ten characters with three ASCII dots; exactly ten comes back whole.
		["unique:abcdefghijklmnop", "Unknown unique mode “abcdefg...” was ignored"],
		["order:ABCdefghijklmnop", "Unknown order choice “abcdefg...” was ignored"],
		["prefer:abcdefghij", "Unknown preference mode “abcdefghij” was ignored"],
		["prefer:abcdefghijk", "Unknown preference mode “abcdefg...” was ignored"],
		// A quoted value is not the value: quotes echoed.
		['unique:"prints"', 'Unknown unique mode “"prints"” was ignored'],
		['order:"cmc"', 'Unknown order choice “"cmc"” was ignored'],
		// A `-` changes nothing, and a regex-shaped value is just an unknown value.
		["-unique:nonsense", "Unknown unique mode “nonsense” was ignored"],
		["unique:/x/", "Unknown unique mode “/x/” was ignored"],
	])("%s", async (option, warning) => {
		const result = scryfallTermPolicy(`${option} t:goblin`);
		expect(result.query).toBe("t:goblin");
		expect(result.warnings).toEqual([warning]);
		expect(result.directives).toEqual([]);
		const response = await search(`${option} t:goblin`);
		expect(response.status).toBe(200);
		expect((await json(response)).warnings).toEqual([warning]);
	});

	test("two of them are two warnings, in source order", () => {
		expect(scryfallTermPolicy("unique:nonsense order:nonsense t:goblin").warnings).toEqual([
			"Unknown unique mode “nonsense” was ignored",
			"Unknown order choice “nonsense” was ignored",
		]);
	});
});

describe("a known value is lifted out of the query and applied", () => {
	test("the option leaves the text and comes back as a directive", () => {
		const result = scryfallTermPolicy("t:goblin unique:prints order:cmc dir:desc prefer:oldest");
		expect(result.query).toBe("t:goblin");
		expect(result.warnings).toEqual([]);
		expect(result.directives).toEqual([
			{ name: "unique", value: "prints", nested: false },
			{ name: "order", value: "cmc", nested: false },
			{ name: "dir", value: "desc", nested: false },
			{ name: "prefer", value: "oldest", nested: false },
		]);
	});

	test("it reaches the engine as the search's own parameters", async () => {
		const engine = new FakeEngine();
		await search("elf unique:prints order:cmc dir:desc", engine);
		expect(engine.lastSearch).toMatchObject({ unique: "printing", orderby: "cmc", direction: "desc" });
	});

	test("a `-` on a known option changes nothing and adds no warning", async () => {
		const engine = new FakeEngine();
		const response = await search("elf -unique:prints", engine);
		expect(engine.lastSearch?.unique).toBe("printing");
		expect((await json(response)).warnings).toBeUndefined();
	});

	test("display: and as: are accepted silently and change nothing", () => {
		for (const option of ["display:grid", "display:checklist", "display:full", "display:text", "display:images"]) {
			const result = scryfallTermPolicy(`${option} t:goblin`);
			expect(result.query).toBe("t:goblin");
			expect(result.warnings).toEqual([]);
		}
		expect(scryfallTermPolicy("as:checklist display:GRID t:goblin").warnings).toEqual([]);
	});

	test("this port's own values are still honored where Scryfall warns", () => {
		for (const option of ["unique:artwork", "unique:card", "unique:printing", "order:cubecobra", "prefer:borderless"]) {
			const result = scryfallTermPolicy(`${option} cmc=3`);
			expect(result.warnings).toEqual([]);
			expect(result.directives).toHaveLength(1);
		}
	});

	test("an order Scryfall sorts by and this port cannot keeps the parameter's sentence", () => {
		expect(scryfallTermPolicy("order:penny cmc=3").warnings).toEqual([
			"This server cannot sort by 'penny' yet; sorted by name instead.",
		]);
	});
});

describe("a query of nothing but display options has no terms", () => {
	test.each(["unique:prints", "order:cmc", "prefer:oldest", "display:grid", "unique:prints order:cmc"])(
		"%s alone is the 400 with no warnings",
		async (q) => {
			expect(scryfallTermPolicy(q).allIgnored).toBe(true);
			const response = await search(q);
			expect(response.status).toBe(400);
			expect(await json(response)).toEqual({
				object: "error",
				code: "bad_request",
				status: 400,
				warnings: null,
				details: "All of your terms were ignored.",
			});
		},
	);

	test("an unknown value alone carries its warning into the 400", async () => {
		const response = await search("unique:nonsense");
		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({
			details: "All of your terms were ignored.",
			warnings: ["Unknown unique mode “nonsense” was ignored"],
		});
	});

	test("an option beside an ignored term is still nothing", async () => {
		const response = await search("unique:prints f:notaformat");
		expect(response.status).toBe(400);
		expect((await json(response)).warnings).toEqual([
			"Invalid expression “f:notaformat” was ignored. Unknown game format “notaformat”",
		]);
	});

	test("/cards/random refuses it the same way", async () => {
		const response = await testDispatch(makeCtx(), "/cards/random?q=unique%3Aprints");
		expect(response.status).toBe(400);
		expect((await json(response)).details).toBe("All of your terms were ignored.");
	});
});

describe("under `=` a display keyword is a keyword Scryfall does not know", () => {
	test.each([
		["unique=prints", "unique"],
		["order=cmc", "order"],
		["display=grid", "display"],
		["include=extras", "include"],
	])("%s", (option, keyword) => {
		const result = scryfallTermPolicy(`${option} t:goblin`);
		expect(result.query).toBe("t:goblin");
		expect(result.directives).toEqual([]);
		expect(result.warnings).toEqual([`Invalid expression “${option}” was ignored. Unknown keyword “${keyword}”.`]);
	});

	test("and under a comparison it matches nothing, like any unknown keyword", () => {
		expect(scryfallTermPolicy("order>cmc t:goblin").query).toBe("cmc<0 t:goblin");
	});
});
