// Live semantics measured on api.scryfall.com, 2026-10-04. The shared fixture's exact
// parser trees also run through transform -> store -> engine in builder/tests/etb.rs.
import { describe, expect, test } from "bun:test";
import { canonicalStringify, parseScryfallQuery, parseScryfallQueryWithDirectives } from "../../src/parser";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";
import controls from "../fixtures/etb-controls.json";
import { FakeEngine, makeCtx, testDispatch } from "./harness";

const EFFECT = "(fo:/when(ever)? (~|this creature|this permanent) enters.*?draws? [^.]*cards?/) t:creature";
const SEEK = `${EFFECT} otag:draw is:etb`;

describe("Scryfall's ETB predicate", () => {
	for (const { q, tree } of controls.queries) {
		test(`the engine fixture carries the production parser's tree: ${q}`, () => {
			expect<unknown>(parseScryfallQuery(q)).toEqual(tree);
		});
	}

	test.each([
		["is:etb", "fo:enters"],
		["is:ETB", "fo:enters"],
		["has:etb", "fo:enters"],
		["not:etb", "-fo:enters"],
		["-is:etb", "-fo:enters"],
		["-has:etb", "-fo:enters"],
		["-not:etb", "-(-fo:enters)"],
	])("%s retains its polarity and is supported", (term, expansion) => {
		const q = `${term} t:creature`;
		const policy = scryfallTermPolicy(q);
		expect(policy.query).toBe(q);
		expect(policy.warnings).toEqual([]);
		const parsed = parseScryfallQueryWithDirectives(policy.query);
		expect(parsed.warnings).toEqual([]);
		expect(canonicalStringify(parsed.tree)).toBe(canonicalStringify(parseScryfallQuery(`${expansion} t:creature`)));
	});

	test("the seek keeps its effect regex and ANDs both restrictions", () => {
		const policy = scryfallTermPolicy(SEEK);
		expect(policy.query).toBe(SEEK);
		expect(policy.warnings).toEqual([]);
		expect(parseScryfallQuery(SEEK)).toEqual(parseScryfallQuery(`${EFFECT} otag:draw fo:enters`));
		expect(parseScryfallQuery(SEEK)).not.toEqual(parseScryfallQuery(`${EFFECT} otag:draw`));
	});

	test.each(["is:etb t:creature", SEEK])("/cards/search accepts %s without warnings", async (q) => {
		const engine = new FakeEngine();
		const response = await testDispatch(makeCtx({ engine }), `/cards/search?${new URLSearchParams({ q })}`);
		expect(response.status).toBe(200);
		expect(await response.json()).not.toHaveProperty("warnings");
		// A separate full-Oracle leaf MUST reach the engine. Accepting the spelling while
		// dropping the restriction was the production bug.
		expect(engine.lastSearch?.filterTreeJson).toContain(canonicalStringify(parseScryfallQuery("fo:enters")));
		expect(engine.lastSearch?.filterTreeJson).toContain(canonicalStringify(parseScryfallQuery("-is:extra")));
	});
});
