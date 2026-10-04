// Scryfall's `new:` at the term-policy and parser level: `new:rarity` answered, the other values
// Scryfall honors still refused, and a value it does not know ignored with its sentence.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04; the requests are recorded at
// NEW_KEYWORDS in src/routes/scryfall-compat/query-terms.ts, and the rule `new:rarity` follows at
// card_engine's `assign_new_rarity_flags`. The answer itself — from real card objects through the
// whole store pipeline — is pinned in engine/builder/tests/x72_new_rarity.rs.

import { describe, expect, test } from "bun:test";
import { EMPTY_TAG_ALIASES, parseScryfallQuery, parseScryfallQueryWithDirectives } from "../../src/parser";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

const ignored = (echo: string, reason: string) => `Invalid expression “${echo}” was ignored. ${reason}`;

/** What the extras gate decides for a query, with both parameters sent as false. */
async function gated(q: string) {
	const policy = scryfallTermPolicy(q);
	const parsed = parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES);
	const gate = await applyExtrasGate(
		{ setsWithExtras: async () => [] } as never,
		parsed.tree,
		{ loweredRegexTerms: parsed.loweredRegexTerms, expandedDerivedTerms: parsed.expandedDerivedTerms },
		{ includeExtras: false, includeVariations: false },
	);
	return [gate.includeExtras, gate.includeVariations];
}

describe("new:rarity is the engine's is:newrarity", () => {
	test.each([
		["new:rarity", "is:newrarity"],
		["new:RARITY", "is:newrarity"],
		['new:"rarity"', "is:newrarity"],
		["new=rarity", "is:newrarity"],
		// The negated term is the complement (`-new:rarity e:khm t:god` 13 of 25), so a plain `-`.
		["-new:rarity", "-is:newrarity"],
		["-new:RARITY", "-is:newrarity"],
	])("%s", (q, rewritten) => {
		const policy = scryfallTermPolicy(`${q} e:khm t:god`);
		expect(policy.warnings).toEqual([]);
		expect(policy.query).toBe(`${rewritten} e:khm t:god`);
		expect(() => parseScryfallQuery(policy.query)).not.toThrow();
	});

	test("it forces no extras, in either polarity", async () => {
		// `new:rarity or cmc=3` and `-new:rarity or cmc=3` both echo include_extras=false.
		expect(await gated("new:rarity or cmc=3")).toEqual([false, false]);
		expect(await gated("-new:rarity or cmc=3")).toEqual([false, false]);
	});

	test("the port's own spelling is not a Scryfall value, under any separator", () => {
		// `is:newrarity`, `has:newrarity`, `not:newrarity` and `is:new_rarity` are each 25 of 25
		// carrying the sentence there.
		const cases: [string, string][] = [
			["is:newrarity", "newrarity"],
			["has:newrarity", "newrarity"],
			["not:newrarity", "newrarity"],
			["is:NEWRARITY", "newrarity"],
			["is:new_rarity", "new_rarity"],
			["is:new-rarity", "new-rarity"],
		];
		for (const [term, value] of cases) {
			const policy = scryfallTermPolicy(`${term} e:khm t:god`);
			expect(policy.query).toBe("e:khm t:god");
			expect(policy.warnings).toEqual([
				ignored(term.toLowerCase(), `Checking if cards are “${value}” is not supported`),
			]);
		}
	});
});

describe("the values Scryfall honors and this port does not answer fail to parse", () => {
	test.each([
		"new:language",
		"new:lang",
		"new:LANGUAGE",
		"-new:language",
		"new:art",
		"new:artist",
		"new:flavor",
		"new:ft",
		"new:flavortext",
		"new:frame",
		"new:card",
		"new:illustration",
		"new:foil",
		"new:nonfoil",
		"new:paper",
		"new:game",
		"new:mtgo",
		"new:arena",
	])("%s is kept, unwarned, and refused", (term) => {
		const policy = scryfallTermPolicy(`${term} e:khm t:god`);
		expect(policy.warnings).toEqual([]);
		expect(policy.query).toBe(`${term} e:khm t:god`);
		expect(() => parseScryfallQuery(policy.query)).toThrow();
	});
});

describe("a value Scryfall does not know is ignored with its sentence", () => {
	test.each([
		["new:nonsense", "new:nonsense", "nonsense"],
		// The expression and the value are both lower-cased.
		["new:NONSENSE", "new:nonsense", "nonsense"],
		['new:"non sense"', 'new:"non sense"', "non sense"],
		["-new:nonsense", "-new:nonsense", "nonsense"],
		["new:languages", "new:languages", "languages"],
		["new:rarities", "new:rarities", "rarities"],
		["new:set", "new:set", "set"],
		["new:name", "new:name", "name"],
		["new:border", "new:border", "border"],
		["new:r", "new:r", "r"],
		["new:l", "new:l", "l"],
		["new:print", "new:print", "print"],
		["new:printing", "new:printing", "printing"],
		["new:reprint", "new:reprint", "reprint"],
	])("%s", (term, echo, value) => {
		const policy = scryfallTermPolicy(`${term} e:khm t:god`);
		expect(policy.query).toBe("e:khm t:god");
		expect(policy.warnings).toEqual([ignored(echo, `Checking if cards have a new “${value}” is not supported`)]);
	});

	test("alone it is the 400 carrying that sentence", () => {
		const policy = scryfallTermPolicy("new:nonsense");
		expect(policy.allIgnored).toBe(true);
	});

	test.each([
		['new:""', "Unknown keyword “new”."],
		['-new:""', "Unknown keyword “-new”."],
		["new:/rarity/", "Unknown regular expression keyword “new”."],
		["-new:/rarity/", "Unknown regular expression keyword “-new”."],
	])("%s", (term, reason) => {
		const policy = scryfallTermPolicy(`${term} e:khm t:god`);
		expect(policy.query).toBe("e:khm t:god");
		expect(policy.warnings).toEqual([ignored(term, reason)]);
	});

	test("under a comparison it is honored and matches nothing, as every non-comparable keyword", () => {
		// `new>rarity e:khm t:god` 404; `-new>rarity e:khm t:god` all 25.
		expect(scryfallTermPolicy("new>rarity e:khm t:god").query).toBe("cmc<0 e:khm t:god");
		expect(scryfallTermPolicy("-new>rarity e:khm t:god").warnings).toEqual([]);
	});
});
