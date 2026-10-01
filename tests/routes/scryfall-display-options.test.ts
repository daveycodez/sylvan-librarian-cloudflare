import { describe, expect, test } from "bun:test";
import {
	hasNestedScryfallDisplayOption,
	NESTED_DISPLAY_OPTIONS_DETAILS,
} from "../../src/routes/scryfall-compat/query-terms";
import { json, makeCtx, testDispatch } from "./harness";

describe("Scryfall display option scope", () => {
	test.each([
		"sort:name",
		"order:name",
		"unique:cards",
		"direction:asc",
		"dir:asc",
		"prefer:newest",
		"sort:bogus",
		"-sort:name",
	])("rejects nested %s", async (directive) => {
		const query = `(t:elf ${directive})`;
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({
			object: "error",
			code: "bad_request",
			status: 400,
			warnings: null,
			details: NESTED_DISPLAY_OPTIONS_DETAILS,
		});
	});

	test("wrapping a complete query does not turn its trailing sort into a valid scoped option", async () => {
		const query = "((t:planeswalker (ci>=b OR ci>=g)) sort:edhrec)";
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(400);
		expect((await json(response)).details).toBe(NESTED_DISPLAY_OPTIONS_DETAILS);
	});

	test("random uses the same compatibility policy", async () => {
		const response = await testDispatch(makeCtx(), `/cards/random?q=${encodeURIComponent("(t:elf sort:name)")}`);
		expect(response.status).toBe(400);
		expect((await json(response)).details).toBe(NESTED_DISPLAY_OPTIONS_DETAILS);
	});

	test.each([
		"(t:elf) sort:edhrec",
		'(o:"sort:name (direction:asc)")',
		String.raw`(o:"escaped \" sort:name")`,
		String.raw`(fo:/sort:name (dir:asc)\/prefer:newest/)`,
		"(t:elf sort=edhrec)",
		"(t:elf sort:)",
		"(o:sort:name)",
	])("leaves literal text and non-directives alone: %s", (query) => {
		expect(hasNestedScryfallDisplayOption(query)).toBe(false);
	});

	test("a top-level directive remains valid on the compatibility route", async () => {
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent("(t:elf) sort:edhrec")}`);
		expect(response.status).toBe(200);
	});

	test("native search retains nested directive support", async () => {
		const response = await testDispatch(makeCtx(), `/search?q=${encodeURIComponent("(t:elf sort:edhrec)")}`);
		expect(response.status).toBe(200);
	});
});
