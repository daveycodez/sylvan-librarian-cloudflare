// Scryfall's `new:` at the term-policy and parser level: `new:rarity` and the `new_flags` values
// answered — `new:artist` among them since 2026-10-10, from Scryfall's own list — and a value it does
// not know ignored with its sentence.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04; the requests are recorded at
// NEW_KEYWORDS in src/routes/scryfall-compat/query-terms.ts, and the rule `new:rarity` follows at
// card_engine's `assign_new_rarity_flags`. The answer itself — from real card objects through the
// whole store pipeline — is pinned in engine/builder/tests/x72_new_rarity.rs.

import { describe, expect, test } from "bun:test";
import { EMPTY_TAG_ALIASES, parseScryfallQuery, parseScryfallQueryWithDirectives } from "../../src/parser";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

/** One spelling of each `new:` value the store's `new_flags` answer. */
const NEW_FLAG_VALUES = [
	"card",
	"paper",
	"frame",
	"mtgo",
	"arena",
	"astral",
	"sega",
	"game",
	"foil",
	"nonfoil",
	"flavor",
	"art",
	"language",
	"artist",
	"illustrator",
];

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

// The values answered from the printing's `new_flags`: NEW_VALUE_IS_TAGS in query-terms.ts, the
// rule and its measurements at card_engine's `assign_new_flags`, the answers themselves pinned on
// real card objects in engine/builder/tests/new_flags.rs. Measured on api.scryfall.com 2026-10-09.
describe("the new: values the store's new_flags answer are the engine's is:new<value>", () => {
	test.each([
		// One list under four names: `new:card` and `new:paper` are the same 35,158 printings, and
		// `new:printed` and `new:cardboard` 12 on the anchor as they are.
		["new:card", "is:newcard"],
		["new:paper", "is:newcard"],
		["new:printed", "is:newcard"],
		["new:cardboard", "is:newcard"],
		["new:CARD", "is:newcard"],
		['new:"card"', "is:newcard"],
		["new=card", "is:newcard"],
		["-new:card", "-is:newcard"],
		["-new:paper", "-is:newcard"],
		["new:frame", "is:newframe"],
		["new:FRAME", "is:newframe"],
		["-new:frame", "-is:newframe"],
		// `new:modo` is 12 on the anchor, as `new:mtgo`.
		["new:mtgo", "is:newmtgo"],
		["new:modo", "is:newmtgo"],
		// `new:magiconline` is 12 on the anchor and 31,262 corpus-wide, as `new:mtgo`; the port
		// dropped it with the "not supported" sentence, which Scryfall does not say for it.
		["new:magiconline", "is:newmtgo"],
		["new:MagicOnline", "is:newmtgo"],
		["-new:magiconline", "-is:newmtgo"],
		["-new:mtgo", "-is:newmtgo"],
		// `new:mtga` is 12 on the anchor, as `new:arena`.
		["new:arena", "is:newarena"],
		["new:mtga", "is:newarena"],
		["-new:arena", "-is:newarena"],
		// `new:astral e:khm t:god` is a 404 with no warning: honored, and empty there.
		["new:astral", "is:newastral"],
		["-new:astral", "-is:newastral"],
		// `new:microprose` and `new:micro` are 404s on the anchor with no warning too, and past/1-12
		// with extras in, as `new:astral`. `new:microp` takes the sentence: a table, not a prefix.
		["new:microprose", "is:newastral"],
		["new:micro", "is:newastral"],
		["new:MicroProse", "is:newastral"],
		["-new:microprose", "-is:newastral"],
		["-new:micro", "-is:newastral"],
		// `new:sega e:khm t:god` is a 404 with no warning: honored, and empty there.
		["new:sega", "is:newsega"],
		["-new:sega", "-is:newsega"],
		// `new:dreamcast` is a 404 on the anchor with no warning too, and psdg/1-10 with extras in.
		["new:dreamcast", "is:newsega"],
		["new:Dreamcast", "is:newsega"],
		["-new:dreamcast", "-is:newsega"],
		// `new:games` is 12 on the anchor and 42,123 corpus-wide, as `new:game`.
		["new:game", "is:newgame"],
		["new:games", "is:newgame"],
		["-new:game", "-is:newgame"],
		["new:foil", "is:newfoil"],
		["-new:foil", "-is:newfoil"],
		["new:nonfoil", "is:newnonfoil"],
		["-new:nonfoil", "-is:newnonfoil"],
		// `new:ft` and `new:flavortext` are 5 on the anchor, as `new:flavor` (27,459 corpus-wide, each).
		["new:flavor", "is:newflavor"],
		["new:ft", "is:newflavor"],
		["new:flavortext", "is:newflavor"],
		["-new:flavor", "-is:newflavor"],
		// `new:illustration` is 52,046 corpus-wide, as `new:art` (25 and 25 on the anchor).
		["new:art", "is:newart"],
		["new:illustration", "is:newart"],
		["-new:art", "-is:newart"],
		// `new:lang` is 285,762 with every language, as `new:language` (12 and 12 on the anchor).
		["new:language", "is:newlanguage"],
		["new:lang", "is:newlanguage"],
		["-new:language", "-is:newlanguage"],
	])("%s", (q, rewritten) => {
		const policy = scryfallTermPolicy(`${q} e:khm t:god`);
		expect(policy.warnings).toEqual([]);
		expect(policy.query).toBe(`${rewritten} e:khm t:god`);
		expect(() => parseScryfallQuery(policy.query)).not.toThrow();
	});

	test("none forces extras, in either polarity", async () => {
		for (const value of NEW_FLAG_VALUES) {
			expect(await gated(`new:${value} or cmc=3`)).toEqual([false, false]);
			expect(await gated(`-new:${value} or cmc=3`)).toEqual([false, false]);
		}
	});

	test("the port's own spellings are not Scryfall values, under any separator", () => {
		// `is:newcard` and `is:new_card` are each 25 of 25 carrying the sentence there.
		for (const term of ["is:newcard", "is:new_card", "is:new-card", "not:newcard", "is:newframe", "is:new_frame"]) {
			const value = term.slice(term.indexOf(":") + 1);
			const policy = scryfallTermPolicy(`${term} e:khm t:god`);
			expect(policy.query).toBe("e:khm t:god");
			expect(policy.warnings).toEqual([ignored(term, `Checking if cards are “${value}” is not supported`)]);
		}
	});
});

describe("new:artist and new:illustrator are one list, answered from Scryfall's own record of it", () => {
	// Nearly every row there (542,667 of 545,440 with every language, 2026-10-10) and no rule the
	// card objects hold: the 2,773 rows it leaves out are copied (engine/builder/src/is_lists.tsv
	// `old_artist`) and the store holds the answer as a bit on every other row. `new:illustrator` is
	// the same list, each without the other a 404. Until 2026-10-10 both were left as written and
	// refused, which answered a 400 where Scryfall answers cards; before 2026-10-09
	// `new:illustrator` was dropped with a sentence, which answered `-new:illustrator e:khm t:god`
	// with 25 where Scryfall has a 404. The answers on real card objects are in
	// engine/builder/tests/new_flags.rs.
	test.each([
		["new:artist", "is:newartist"],
		["new:ARTIST", "is:newartist"],
		["-new:artist", "-is:newartist"],
		["new:illustrator", "is:newartist"],
		["new:Illustrator", "is:newartist"],
		["-new:illustrator", "-is:newartist"],
	])("%s", (q, rewritten) => {
		const policy = scryfallTermPolicy(`${q} e:khm t:god`);
		expect(policy.warnings).toEqual([]);
		expect(policy.query).toBe(`${rewritten} e:khm t:god`);
		expect(() => parseScryfallQuery(policy.query)).not.toThrow();
	});

	test("the port's own spelling is not a Scryfall value", () => {
		for (const term of ["is:newartist", "is:old_artist", "is:oldartist"]) {
			const value = term.slice(term.indexOf(":") + 1);
			const policy = scryfallTermPolicy(`${term} e:khm t:god`);
			expect(policy.query).toBe("e:khm t:god");
			expect(policy.warnings).toEqual([ignored(term, `Checking if cards are “${value}” is not supported`)]);
		}
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
		["new:microp", "new:microp", "microp"],
		["new:dream", "new:dream", "dream"],
		["new:artists", "new:artists", "artists"],
		["new:painter", "new:painter", "painter"],
		["new:dc", "new:dc", "dc"],
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
