// `e:` / `set:` / `s:` / `edition:` name a set by its code, its name or a retired code — and
// `block:` reads the retired codes too.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04 — and, from "every set type"
// down, 2026-10-08, when all 1,056 set names were asked; the requests are recorded in
// scripts/generate-set-blocks.ts and beside SET_KEYWORDS and IN_KEYWORDS in
// src/routes/scryfall-compat/query-terms.ts.

import { describe, expect, test } from "bun:test";
import { EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";
import { blockValueCode, setNameCode, setNameCodes } from "../../src/routes/scryfall-compat/set-blocks.gen";

/** What the extras gate decides for a query when `plst`, `mb2` and `unk` (or `sets`) hold extras. */
async function extrasOpen(q: string, sets: readonly string[] = ["plst", "mb2", "unk"]): Promise<boolean> {
	const policy = scryfallTermPolicy(q);
	const parsed = parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES);
	const gate = await applyExtrasGate(
		{ setsWithExtras: async () => [...sets] } as never,
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

describe("every set type's names answer, token sets included", () => {
	// Each `e:"<name>"` was asked with include_extras=true and answered its set's own count:
	// tecl 13, tecc 13, tzen 11, tkhc 8, ttsr 15, tmh3 43, sznr 9, wfin 3, thob 15, tltr 25,
	// tmid 19, tclb 51 (token sets), cmb2 121.
	test.each([
		["lorwyn eclipsed tokens", "tecl"],
		["Lorwyn Eclipsed Commander Tokens", "tecc"],
		["zendikar tokens", "tzen"],
		["kaldheim commander tokens", "tkhc"],
		["time spiral remastered tokens", "ttsr"],
		["modern horizons 3 tokens", "tmh3"],
		["zendikar rising substitute cards", "sznr"],
		["fin asia wpn promo tokens", "wfin"],
		["the hobbit tokens", "thob"],
		["tales of middle-earth tokens", "tltr"],
		["innistrad midnight hunt tokens", "tmid"],
		["battle for baldurs gate tokens", "tclb"],
		["mystery booster playtest cards 2021", "cmb2"],
	])('e:"%s" is e:%s', (name, code) => {
		const policy = scryfallTermPolicy(`e:"${name}" t:goblin`);
		expect([name, policy.query, policy.warnings, policy.quietSets]).toEqual([name, `e:${code} t:goblin`, [], [code]]);
		expect(scryfallTermPolicy(`block:"${name}"`).query).toBe(scryfallTermPolicy(`block:${code}`).query);
		expect(scryfallTermPolicy(`in:"${name}"`).query).toBe(`in:${code}`);
	});

	test("the name does not open extras, so a token set's name answers under include:extras", async () => {
		// `e:"lorwyn eclipsed tokens"` is a 404 and `e:"lorwyn eclipsed tokens" include:extras`
		// tecl's 13; `e:tecl` is 13 with nothing beside it.
		const sets = ["tecl", "tdmu", "ptdmu"];
		expect(await extrasOpen('e:"lorwyn eclipsed tokens"', sets)).toBe(false);
		expect(await extrasOpen('e:"lorwyn eclipsed tokens" include:extras', sets)).toBe(true);
		expect(await extrasOpen("e:tecl", sets)).toBe(true);
		// `e:"dominaria united tokens"` is a 404 and 29 under include:extras.
		expect(await extrasOpen('e:"dominaria united tokens"', sets)).toBe(false);
		expect(await extrasOpen('e:"dominaria united tokens" include:extras', sets)).toBe(true);
		expect(await extrasOpen('e:"dominaria united tokens" or e:ptdmu', sets)).toBe(true);
	});

	test("a set whose name answers nothing on Scryfall answers nothing here", () => {
		// Each a 404 with include_extras=true, where the set's code answers its cards: tkhm 23,
		// tmh2 21, tneo 19, tstx 9, tiko 14, tbro 12, tunf 14, t30a 16, smh3 1, wmkm 4, ptdmu 3,
		// tvoc 6 (token); sis 76, pz2 270, pz1 149, ha5 25, cmb1 121, altr 81, plg21 11, pclb 104,
		// ysnc 30.
		for (const name of [
			"kaldheim tokens",
			"modern horizons 2 tokens",
			"kamigawa neon dynasty tokens",
			"strixhaven school of mages tokens",
			"ikoria lair of behemoths tokens",
			"the brothers war tokens",
			"unfinity tokens",
			"30th anniversary tokens",
			"modern horizons 3 substitute cards",
			"mkm japanese promo tokens",
			"dominaria united southeast asia tokens",
			"crimson vow commander tokens",
			"shadows of the past",
			"treasure chest",
			"legendary cube prize pack",
			"historic anthology 5",
			"mystery booster playtest cards 2019",
			"tales of middle-earth art series",
			"love your lgs 2021",
			"battle for baldurs gate promos",
			"alchemy new capenna",
		]) {
			const term = `e:"${name}"`;
			const policy = scryfallTermPolicy(term);
			expect([name, policy.query, policy.quietSets, setNameCode(name)]).toEqual([name, term, undefined, null]);
			// `block:"kaldheim tokens"`, `in:"kaldheim tokens"`, `block:"historic anthology 5"`,
			// `in:"mystery booster playtest cards 2019"`: 404s too.
			expect(scryfallTermPolicy(`block:"${name}"`).query).toBe("cmc<0");
			expect(scryfallTermPolicy(`in:"${name}"`).query).toBe(`in:"${name}"`);
		}
	});

	test("a name the set had before still answers", () => {
		// `e:"legendary cube"` 149 = e:pz1, `e:"you make the cube"` 270 = e:pz2,
		// `e:"commander legends battle for baldurs gate promos"` 104 = e:pclb.
		expect(scryfallTermPolicy('e:"legendary cube"').query).toBe("e:pz1");
		expect(scryfallTermPolicy('e:"You Make the Cube"').query).toBe("e:pz2");
		expect(scryfallTermPolicy('e:"commander legends battle for baldurs gate promos"').query).toBe("e:pclb");
		expect(scryfallTermPolicy('in:"legendary cube"').query).toBe("in:pz1");
	});
});

describe("the characters of a set name", () => {
	// `e:"warhammer 40000 commander"` = `e:"warhammer 40 000 commander"` 617, `e:"warhammer 40000
	// tokens"` 31, `e:"url convention promos"` = `e:"urlconvention promos"` 18, `e:"summer magic
	// edgar"` 306, `e:"global series jiang yanggu mu yanling"` 41, `e:"the list (unfinity foil
	// edition)"` 62, `e:"magic × duel masters promos"` 4.
	test.each([
		["warhammer 40000 commander", "40k"],
		["warhammer 40 000 commander", "40k"],
		["Warhammer 40000 Tokens", "t40k"],
		["url convention promos", "purl"],
		["urlconvention promos", "purl"],
		["summer magic edgar", "sum"],
		["global series jiang yanggu mu yanling", "gs1"],
		["the list (unfinity foil edition)", "ulst"],
		["The List (Unfinity Foil Edition)", "ulst"],
		["magic × duel masters promos", "pmda"],
	])('e:"%s" is e:%s', (name, code) => {
		const policy = scryfallTermPolicy(`e:"${name}" t:goblin`);
		expect([name, policy.query, policy.warnings]).toEqual([name, `e:${code} t:goblin`, []]);
		expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
	});

	test("a comma, a slash or an ampersand in the value is never a name; a parenthesis or × left out is none", () => {
		// Each a 404: the comma, the slash and the `&` as the set object spells them, "and" for the
		// `&`, the parentheses dropped, the `×` dropped and an `x` in its place.
		for (const name of [
			"warhammer 40,000 commander",
			"warhammer 40,000 tokens",
			"url/convention promos",
			"summer magic / edgar",
			"global series jiang yanggu & mu yanling",
			"global series jiang yanggu and mu yanling",
			"the list unfinity foil edition",
			"magic duel masters promos",
			"magic x duel masters promos",
		]) {
			expect([name, setNameCode(name)]).toEqual([name, null]);
			const term = `e:"${name}"`;
			expect(scryfallTermPolicy(term).query).toBe(term);
		}
	});
});

describe("a name several sets answer to", () => {
	// `e:"dominaria united tokens"` 29 = tdmu 26 + ptdmu 3; `e:"innistrad crimson vow tokens"` 29 =
	// tvow 21 + tvoc 6 + ovoc 2; `e:"30th anniversary history promos"` 12 = p30h 10 + p30t 2;
	// `e:"year of the ox 2021"` 11 = pl21 6 + pl22 5; `e:"historic anthology 4"` 50 = ha4 + ha5;
	// `e:"mystery booster playtest cards"` 242 = cmb1 + cmb2.
	test.each([
		["dominaria united tokens", ["tdmu", "ptdmu"]],
		["innistrad crimson vow tokens", ["ovoc", "tvoc", "tvow"]],
		["30th anniversary history promos", ["p30t", "p30h"]],
		["year of the ox 2021", ["pl21", "pl22"]],
		["historic anthology 4", ["ha5", "ha4"]],
		["mystery booster playtest cards", ["cmb1", "cmb2"]],
	])('e:"%s" is all of them, and one where one set is wanted', (name, codes) => {
		const list = `(${codes.map((code) => `e:${code}`).join(" or ")})`;
		const policy = scryfallTermPolicy(`e:"${name}" t:goblin`);
		expect([name, policy.query, policy.warnings, policy.quietSets]).toEqual([name, `${list} t:goblin`, [], codes]);
		expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
		expect(setNameCodes(name)).toEqual(codes);
		// g:"historic anthology 4" 25 = g:ha5; block:"year of the ox 2021" 6 = block:pl21;
		// in:"30th anniversary history promos" 60 = in:p30t; in:"innistrad crimson vow tokens" 8 =
		// in:ovoc; in:"dominaria united tokens" 502 = in:tdmu; g:"mystery booster playtest cards"
		// 121 = g:cmb1.
		const one = codes[0] as string;
		expect(setNameCode(name)).toBe(one);
		expect(scryfallTermPolicy(`in:"${name}"`).query).toBe(`in:${one}`);
		expect(scryfallTermPolicy(`block:"${name}"`).query).toBe(scryfallTermPolicy(`block:${one}`).query);
	});

	test("the minus is the term's, and the other keywords spell their own", () => {
		// `-e:"dominaria united tokens" (e:tdmu or e:ptdmu or e:wdmu)` is wdmu's 5.
		expect(scryfallTermPolicy('-e:"dominaria united tokens" (e:tdmu or e:ptdmu or e:wdmu)').query).toBe(
			"-(e:tdmu or e:ptdmu) (e:tdmu or e:ptdmu or e:wdmu)",
		);
		expect(scryfallTermPolicy('set="historic anthology 4" or cmc=3').query).toBe("(set=ha5 or set=ha4) or cmc=3");
		expect(scryfallTermPolicy('e!="historic anthology 4"').query).toBe("cmc<0");
	});
});

describe("`in:` names a set as `e:` names one", () => {
	// in:zendikar t:goblin = in:zen t:goblin 27 (prints); in:"the list" = in:mb1 = in:plst 37,578;
	// in:dar = in:dom 5,891; in:ex t:goblin = in:exo t:goblin 27; in:alpha = in:lea 10,289;
	// in:"kamigawa neon dynasty" = in:neo 5,732; in:"warhammer 40000 commander" = in:40k 7,886;
	// in:"summer magic edgar" = in:sum 10,323; in:"magic × duel masters promos" = in:pmda 117;
	// in:"lorwyn eclipsed tokens" = in:tecl 139; -in:zendikar e:roe = -in:zen e:roe 228.
	test.each([
		["in:zendikar", "in:zen"],
		["in:Zendikar", "in:zen"],
		["in=zendikar", "in=zen"],
		['in:"the list"', "in:plst"],
		["in:mb1", "in:plst"],
		["in:dar", "in:dom"],
		["in:ex", "in:exo"],
		["in:alpha", "in:lea"],
		['in:"kamigawa neon dynasty"', "in:neo"],
		['in:"warhammer 40000 commander"', "in:40k"],
		['in:"summer magic edgar"', "in:sum"],
		['in:"magic × duel masters promos"', "in:pmda"],
		['in:"lorwyn eclipsed tokens"', "in:tecl"],
		["-in:zendikar", "-in:zen"],
		// The name beats the set type of the same word: in:planechase = in:hop 5,939 and
		// in:archenemy = in:arc 6,228.
		["in:planechase", "in:hop"],
		["in:archenemy", "in:arc"],
	])("%s is %s", (term, expected) => {
		const policy = scryfallTermPolicy(`${term} t:goblin`);
		expect([term, policy.query, policy.warnings, policy.quietSets]).toEqual([
			term,
			`${expected} t:goblin`,
			[],
			undefined,
		]);
		expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
	});

	test("a value that is no set's name is the word it was", () => {
		// in:"kamigawa: neon dynasty" and in:"kaldheim tokens" are 404s; a code is a code; and under
		// a comparison the keyword matches nothing.
		for (const term of ['in:"kamigawa: neon dynasty"', 'in:"kaldheim tokens"', "in:zen", "in:khm", "in:nonsense"]) {
			expect(scryfallTermPolicy(term).query).toBe(term);
		}
		expect(scryfallTermPolicy("in>=zendikar").query).toBe("cmc<0");
	});

	test("no word `in:` already reads is a set's name", () => {
		// Games, rarities, finishes, frames, languages and every set type but the two measured
		// above. `planechase` and `archenemy` are the only words on both sides.
		const words = [
			...["paper", "arena", "mtgo", "astral", "sega"],
			...["common", "uncommon", "rare", "mythic", "special", "bonus"],
			...["foil", "nonfoil", "etched", "booster", "future", "1993", "1997", "2003", "2015"],
			...["en", "es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht", "he", "la", "grc", "ar", "sa"],
			...["ph", "qya"],
			...["core", "expansion", "masters", "eternal", "alchemy", "masterpiece", "arsenal", "from_the_vault"],
			...["spellbook", "premium_deck", "duel_deck", "draft_innovation", "treasure_chest", "commander"],
			...["vanguard", "funny", "starter", "box", "promo", "token", "memorabilia", "minigame"],
		];
		for (const word of words) {
			expect([word, setNameCode(word), scryfallTermPolicy(`in:${word}`).query]).toEqual([word, null, `in:${word}`]);
		}
	});
});
