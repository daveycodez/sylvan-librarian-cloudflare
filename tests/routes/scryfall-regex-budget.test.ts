import { describe, expect, test } from "bun:test";
import { parseScryfallQuery } from "../../src/parser";
import { exceedsScryfallRegexBudget, TOO_MANY_REGEX_DETAILS } from "../../src/routes/scryfall-compat/query-terms";
import regression from "../fixtures/scryfall-regex-budget-query.json";
import { json, makeCtx, testDispatch } from "./harness";

const patterns = (count: number) =>
	Array.from({ length: count }, (_, i) => `fo:/[${String.fromCharCode(97 + i)}]/`).join(" OR ");

describe("Scryfall regex operator budget", () => {
	test.each(["/cards/search", "/cards/random"])("%s accepts six operators and rejects seven", async (route) => {
		const accepted = await testDispatch(makeCtx(), `${route}?q=${encodeURIComponent(patterns(6))}`);
		expect(accepted.status).toBe(200);
		const rejected = await testDispatch(makeCtx(), `${route}?q=${encodeURIComponent(patterns(7))}`);
		expect(rejected.status).toBe(400);
		expect(await json(rejected)).toMatchObject({
			object: "error",
			code: "bad_request",
			status: 400,
			details: TOO_MANY_REGEX_DETAILS,
			warnings: null,
		});
	});

	test("the actual eleven-operator paired-role query is rejected before lowering", async () => {
		expect(() => parseScryfallQuery(regression.query)).not.toThrow();
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(regression.query)}`);
		expect(response.status).toBe(400);
		expect((await json(response)).details).toBe(TOO_MANY_REGEX_DETAILS);
	});

	test("literal patterns and duplicate predicates still count", async () => {
		const query = Array(7).fill("fo:/draw/").join(" ");
		expect(exceedsScryfallRegexBudget(query)).toBe(true);
		expect(() => parseScryfallQuery(query)).not.toThrow();
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(400);
	});

	test("malformed patterns on a supported field count before validation", async () => {
		const query = `(${patterns(6)}) fo:/[/`;
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(400);
		expect((await json(response)).details).toBe(TOO_MANY_REGEX_DETAILS);
	});

	test("unknown regex keywords are ignored without spending the budget", async () => {
		const query = `(${patterns(6)}) nonsense:/a/`;
		expect(exceedsScryfallRegexBudget(query)).toBe(false);
		const response = await testDispatch(makeCtx(), `/cards/search?q=${encodeURIComponent(query)}`);
		expect(response.status).toBe(200);
		expect((await json(response)).warnings).toHaveLength(1);
	});

	test.each([
		`(${patterns(6)}) fo:"text fo:/draw/"`,
		`(${patterns(6)}) c:/w/ id:/w/`,
		`(${patterns(6)}) cmc/2>1`,
		String.raw`fo:/one\/two/ fo:/[ab]/ fo:/draw/ fo:/gain/ fo:/life/ fo:/card/`,
	])("literal contents and non-regex values do not count: %s", (query) => {
		expect(exceedsScryfallRegexBudget(query)).toBe(false);
	});

	test("supported aliases, negation and nesting share one budget", () => {
		expect(exceedsScryfallRegexBudget("(name:/a/ -t:/b/) (oracle:/c/ o:/d/ fulloracle:/e/) flavor:/f/ mana:/g/")).toBe(
			true,
		);
	});

	test("unterminated literals leave the existing syntax error in charge", () => {
		expect(exceedsScryfallRegexBudget('fo:"unterminated')).toBe(false);
	});

	test("the native search route retains its existing engine budget", async () => {
		const response = await testDispatch(makeCtx(), `/search?q=${encodeURIComponent(patterns(7))}`);
		expect(response.status).toBe(200);
	});
});
