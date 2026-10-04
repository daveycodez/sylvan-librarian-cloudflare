import { describe, expect, test } from "bun:test";
import {
	collapseScryfallQueryWhitespace,
	prepareScryfallQueryParams,
	truncateScryfallQuery,
} from "../../src/routes/scryfall-compat/query-input";
import regression from "../fixtures/scryfall-truncated-query.json";
import { json, makeCtx, testDispatch } from "./harness";

describe("Scryfall query input limit", () => {
	test("preserves exactly 1,024 Unicode code points rather than UTF-16 units or bytes", () => {
		const query = `o:"😀" OR t:creature${" ".repeat(995)}sort:edhrec`;
		const prefix = [...query].slice(0, 1024).join("");
		expect(truncateScryfallQuery(query)).toBe(prefix);
		expect(prefix.length).toBe(1025);
		expect(new TextEncoder().encode(prefix).length).toBe(1027);
		expect(truncateScryfallQuery("😀".repeat(1025))).toBe("😀".repeat(1024));
	});

	test("preserves short and missing inputs", () => {
		expect(truncateScryfallQuery(undefined)).toBeUndefined();
		expect(truncateScryfallQuery("t:elf")).toBe("t:elf");
		expect(truncateScryfallQuery("x".repeat(1024))).toHaveLength(1024);
	});

	test.each(["/cards/search", "/cards/random"])("%s validates the truncated prefix", async (route) => {
		const response = await testDispatch(makeCtx(), `${route}?q=${encodeURIComponent(regression.query)}`);
		expect(regression.query).toHaveLength(1062);
		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({
			object: "error",
			code: "bad_request",
			status: 400,
			warnings: null,
			details: "Your search contains unclosed parentheses.",
		});
	});

	test("a directive truncated mid-value gets the surviving value's warning", async () => {
		const query = `t:creature${" ".repeat(1004)}sort:edhrec`;
		expect(query).toHaveLength(1025);
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(200);
		expect((await json(response)).warnings).toEqual([expect.stringContaining("edhre")]);
	});

	test("regex operators after the prefix do not spend the budget", async () => {
		const query = `${"fo:/draw/ ".repeat(6).padEnd(1024, " ")}fo:/draw/`;
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(200);
	});

	test("leading whitespace counts toward the prefix before trimming", async () => {
		const query = ` t:creature${" ".repeat(1003)}sort:edhrec`;
		expect(query).toHaveLength(1025);
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(200);
		expect((await json(response)).warnings).toEqual([expect.stringContaining("edhre")]);
	});

	test("grouped display options beyond the prefix are ignored", async () => {
		const query = `${"t:creature".padEnd(1024, " ")}(sort:edhrec)`;
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(200);
	});

	test.each(["/cards/search", "/cards/random"])(
		"%s truncates before dispatch's raw-input byte limit",
		async (route) => {
			const query = `t:creature OR name:${"a".repeat(3500)}`;
			const response = await testDispatch(makeCtx(), `${route}?q=${encodeURIComponent(query)}`);
			expect(response.status).toBe(200);
		},
	);

	test("other routes retain their raw-input byte limit", async () => {
		const query = `t:creature OR name:${"a".repeat(3500)}`;
		const response = await testDispatch(makeCtx(), `/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(400);
	});

	// R29 (mtg-seeker, 2026-10-04): the classes held RAW line breaks, which Scryfall reads as spaces.
	test("whitespace runs collapse to one space everywhere, a regex and a quoted phrase included", () => {
		const prepared = (q: string) =>
			prepareScryfallQueryParams("cards/search", new URLSearchParams({ q, unique: "cards" })).get("q");
		expect(prepared("o:/Whenever [^,.\n]* (blocks|becomes blocked)[^,.\n]*,/ OR keyword:bushido")).toBe(
			"o:/Whenever [^,. ]* (blocks|becomes blocked)[^,. ]*,/ OR keyword:bushido",
		);
		expect(prepared("o:/blocks\n\nor/")).toBe("o:/blocks or/");
		expect(prepared("o:/blocks\tor/")).toBe("o:/blocks or/");
		expect(prepared('o:"blocks  \r\n or"')).toBe('o:"blocks or"');
		expect(prepared("  t:elf \n")).toBe("t:elf");
		// The ESCAPE is two ordinary characters and is the way to say "a line break".
		expect(prepared("o:/choose one —\\n• untap/")).toBe("o:/choose one —\\n• untap/");
		// Only `q`, and only on the two Scryfall query routes.
		expect(prepareScryfallQueryParams("cards/search", new URLSearchParams({ order: "na  me" })).get("order")).toBe(
			"na  me",
		);
		expect(prepareScryfallQueryParams("search", new URLSearchParams({ q: "a  b" })).get("q")).toBe("a  b");
		expect(prepareScryfallQueryParams("cards/random", new URLSearchParams({ q: "a \n b" })).get("q")).toBe("a b");
	});

	test("the 1,024 prefix is cut before whitespace collapses", () => {
		// `lightning` + 1,100 spaces + `bolt` is the 67 cards of `lightning` on api.scryfall.com.
		const q = `lightning${" ".repeat(1100)}bolt`;
		expect(prepareScryfallQueryParams("cards/search", new URLSearchParams({ q })).get("q")).toBe("lightning");
		expect(collapseScryfallQueryWhitespace("a\u00a0 b")).toBe("a\u00a0 b");
	});

	test("native search does not inherit compatibility truncation", async () => {
		const query = `${"t:elf".padEnd(1024, " ")}(`;
		const response = await testDispatch(makeCtx(), `/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(400);
	});
});
