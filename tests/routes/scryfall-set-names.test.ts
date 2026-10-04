// `e:` / `set:` / `s:` / `edition:` name a set by its code, its name or a retired code — and
// `block:` reads the retired codes too.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04; the requests are recorded
// in scripts/generate-set-blocks.ts and beside SET_KEYWORDS in
// src/routes/scryfall-compat/query-terms.ts.

import { describe, expect, test } from "bun:test";
import { EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";
import { blockValueCode, setNameCode } from "../../src/routes/scryfall-compat/set-blocks.gen";

/** What the extras gate decides for a query when `plst`, `mb2` and `unk` hold extras. */
async function extrasOpen(q: string): Promise<boolean> {
	const policy = scryfallTermPolicy(q);
	const parsed = parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES);
	const gate = await applyExtrasGate(
		{ setsWithExtras: async () => ["plst", "mb2", "unk"] } as never,
		parsed.tree,
		{ loweredRegexTerms: parsed.loweredRegexTerms, expandedDerivedTerms: parsed.expandedDerivedTerms },
		{ includeExtras: policy.include.extras, includeVariations: false, quietSets: policy.quietSets },
	);
	return gate.includeExtras;
}

describe("a set is named by its whole name where its code goes", () => {
	// `e:zendikar` = `set:zendikar` = `s:zendikar` = `edition:zendikar` = `e:Zendikar` =
	// `e=zendikar` is 234 = `e:zen`; `e:"return to ravnica"` = `e:returntoravnica` 254;
	// `e:"urza's saga"` = `e:urzassaga` 335; `e:kaldheim-commander` = `e:kaldheim_commander` 119;
	// `e:"duel decks elves vs. goblins"` 56; `e:"kamigawa neon dynasty"` 287; `e:"the list"` 5,257.
	test.each([
		["e:zendikar", "e:zen"],
		["set:zendikar", "set:zen"],
		["s:zendikar", "s:zen"],
		["edition:zendikar", "edition:zen"],
		["e:Zendikar", "e:zen"],
		["e=zendikar", "e=zen"],
		['e:"zendikar"', "e:zen"],
		['e:"return to ravnica"', "e:rtr"],
		["e:returntoravnica", "e:rtr"],
		['e:"urza\'s saga"', "e:usg"],
		["e:urzassaga", "e:usg"],
		["e:kaldheim-commander", "e:khc"],
		["e:kaldheim_commander", "e:khc"],
		['e:"duel decks elves vs. goblins"', "e:dd1"],
		['e:"kamigawa neon dynasty"', "e:neo"],
		['e:"ravnica city of guilds"', "e:rav"],
		['set:"The List"', "set:plst"],
		['e:"kaldheim promos"', "e:pkhm"],
		['e:"magic 2010"', "e:m10"],
		['e:"tenth edition"', "e:10e"],
	])("%s is %s", (term, expected) => {
		const policy = scryfallTermPolicy(`${term} t:goblin`);
		expect([term, policy.query, policy.warnings]).toEqual([term, `${expected} t:goblin`, []]);
		expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
	});

	// All 36 nicknames `block:` answers to were asked of `e:` and each answered with its set's
	// count: `e:saga` 335, `e:legacy` 143, `e:shards` 234, `e:alpha` 289, `e:revised` 295,
	// `e:ravnica` 291, `e:throne` = `e:eldraine` 285, `e:"double feature"` 532, `e:"brothers war"` 280.
	test.each([
		["saga", "usg"],
		["legacy", "ulg"],
		["shards", "ala"],
		["alpha", "lea"],
		["revised", "3ed"],
		["ravnica", "rav"],
		["throne", "eld"],
		["eldraine", "eld"],
		["double feature", "dbl"],
		["brothers war", "bro"],
	])("and by a nickname: e:%s is e:%s", (nickname, code) => {
		expect(scryfallTermPolicy(`e:"${nickname}"`).query).toBe(`e:${code}`);
	});

	test("it is the whole name, and a colon in the value is never a name", () => {
		// `e:zendika`, `e:"tales of middle-earth"`, `e:"10th edition"`, `e:commander`, `e:mystery`,
		// `e:urza`, `e:alara`, `e:tarkir`, `e:eldritch`, `e:"kamigawa: neon dynasty"` and
		// `e:"ravnica: city of guilds"` are each a 404: the value is left as the code it would be.
		for (const term of [
			"e:zendika",
			'e:"tales of middle-earth"',
			'e:"10th edition"',
			"e:commander",
			"e:mystery",
			"e:urza",
			"e:alara",
			"e:tarkir",
			"e:eldritch",
			'e:"kamigawa: neon dynasty"',
			'e:"ravnica: city of guilds"',
			"e:nonsense",
		]) {
			const policy = scryfallTermPolicy(term);
			expect([term, policy.query, policy.warnings, policy.quietSets]).toEqual([term, term, [], undefined]);
		}
	});

	test("negated it is the complement, and under a comparison it matches nothing", () => {
		// `-e:zendikar t:goblin cmc=1 pow=2` is 9 = `-e:zen …`; `e!=zendikar …` is a 404.
		expect(scryfallTermPolicy("-e:zendikar t:goblin").query).toBe("-e:zen t:goblin");
		expect(scryfallTermPolicy("e!=zendikar t:goblin").query).toBe("cmc<0 t:goblin");
		expect(scryfallTermPolicy("e>zendikar t:goblin").query).toBe("cmc<0 t:goblin");
		expect(scryfallTermPolicy("e:zendikar or e:worldwake").query).toBe("e:zen or e:wwk");
	});

	test("a code is a code: it is left as written and nothing is recorded for it", () => {
		for (const term of ["e:khm", "set:zen", "s:plst", "e:10e", "e:pkhm", "E:KHM"]) {
			const policy = scryfallTermPolicy(`${term} t:goblin`);
			expect([term, policy.query, policy.quietSets]).toEqual([term, `${term} t:goblin`, undefined]);
		}
	});
});

describe("a retired code still names its set, for `e:` and for `block:`", () => {
	// `e:mb1` = `e:fmb1` = `e:plist` is 5,257 (The List; `block:mb1` = `block:fmb1` = `block:plst`
	// 5,323), `e:dar` 265 = `e:dom` (`block:dar` 265), `e:2e` 291, `e:7e` 335, `e:ex` 143, `e:mi`
	// 335, `e:pr` 143, `e:vi` 167, `e:wl` 167, `e:fe` 102, `e:ia` 373, `e:lg` 306, `e:aq` 85,
	// `e:an` 76, `e:dk` 119, `e:nms` 143.
	test.each([
		["mb1", "plst"],
		["fmb1", "plst"],
		["plist", "plst"],
		["dar", "dom"],
		["DAR", "dom"],
		["2e", "2ed"],
		["7e", "7ed"],
		["9e", "9ed"],
		["ex", "exo"],
		["mi", "mir"],
		["pr", "pcy"],
		["vi", "vis"],
		["wl", "wth"],
		["fe", "fem"],
		["ia", "ice"],
		["lg", "leg"],
		["aq", "atq"],
		["an", "arn"],
		["dk", "drk"],
		["nms", "nem"],
	])("%s is %s", (alias, code) => {
		expect(scryfallTermPolicy(`e:${alias} t:goblin`).query).toBe(`e:${code} t:goblin`);
		expect(scryfallTermPolicy(`block:${alias} t:goblin`).query).toBe(
			scryfallTermPolicy(`block:${code} t:goblin`).query,
		);
	});

	test("`block:mb1` is The List, with extras open", () => {
		// 5,323 against this port's 404: the code named no set and no block.
		const policy = scryfallTermPolicy("block:mb1");
		expect([policy.query, policy.include.extras]).toEqual(["(e:plst)", true]);
		expect(blockValueCode("mb1")).toBe("plst");
	});

	test("only the codes measured to answer", () => {
		// `e:uz`, `e:te`, `e:in`, `e:ap`, `e:mm`, `e:ms2`, `e:pc1`, `e:1e`, `e:2u`, `e:hm` and
		// `e:pmb1` are each a 404, though the first seven are their sets' MTGO codes.
		for (const code of ["uz", "te", "in", "ap", "mm", "ms2", "pc1", "1e", "2u", "hm", "pmb1"]) {
			expect([code, setNameCode(code)]).toEqual([code, null]);
		}
	});
});

describe("a set named by its name or a retired code does not open extras, and its code does", () => {
	// `e:plst` is 5,323 and `e:"the list"` 5,257 (= `e:plst -is:extra`); `e:mb1` 5,257 and
	// `e:mb1 include:extras` 5,323; `e:mb2` 385 and `e:"mystery booster 2"` 264; `e:unk` 521 and
	// `e:"unknown event"` a 404; `e:plst or cmc=3` 12,408 and `e:"the list" or cmc=3` 12,129.
	test("the policy names the codes it wrote and the query did not", () => {
		expect(scryfallTermPolicy('e:"the list"').quietSets).toEqual(["plst"]);
		expect(scryfallTermPolicy("e:mb1 or cmc=3").quietSets).toEqual(["plst"]);
		expect(scryfallTermPolicy('(e:"mystery booster 2" or e:"unknown event") t:goblin').quietSets).toEqual([
			"mb2",
			"unk",
		]);
		expect(scryfallTermPolicy('e:plst or e:"the list"').quietSets).toBeUndefined();
	});

	test("the gate opens for the typed code and stays shut for the name", async () => {
		expect(await extrasOpen("e:plst")).toBe(true);
		expect(await extrasOpen("e:plst or cmc=3")).toBe(true);
		expect(await extrasOpen('e:"the list"')).toBe(false);
		expect(await extrasOpen('e:"the list" or cmc=3')).toBe(false);
		expect(await extrasOpen("e:mb1")).toBe(false);
		expect(await extrasOpen('e:"unknown event"')).toBe(false);
		expect(await extrasOpen('-e:"the list"')).toBe(false);
	});

	test("every other way of opening extras still opens them", async () => {
		// `e:mb1 include:extras` is 5,323, `e:"the list" t:token` 57, `block:mb1` 5,323.
		expect(await extrasOpen("e:mb1 include:extras")).toBe(true);
		expect(await extrasOpen('e:"the list" t:token')).toBe(true);
		expect(await extrasOpen("block:mb1")).toBe(true);
		// A code the query also spells itself is a typed code.
		expect(await extrasOpen('e:plst or e:"the list"')).toBe(true);
		expect(await extrasOpen('e:"the list" or e:unk')).toBe(true);
	});
});
