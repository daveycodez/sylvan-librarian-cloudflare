// The `is:` values Scryfall answers under a spelling, a word or a keyword this port did not have.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04: a sweep of 619 candidate
// values, then one symmetric-difference request per synonym over printings with extras in. The
// requests are recorded at SCRYFALL_IS_SYNONYMS in src/routes/scryfall-compat/query-terms.ts.

import { describe, expect, test } from "bun:test";
import { canonicalStringify, EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import type { FilterValue } from "../../src/parser/nodes";
import { SUPPORTED_IS_VALUES } from "../../src/parser/rewrite";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { SCRYFALL_UNANSWERED_IS_VALUES, scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

/** The policy's rewrite of a one-term query, which must carry no warning. */
function rewritten(q: string): string {
	const policy = scryfallTermPolicy(q);
	expect([q, policy.warnings]).toEqual([q, []]);
	return policy.query;
}

/** The wire tree a query becomes, and the warnings the parser attaches to it. */
function parsed(q: string) {
	const result = parseScryfallQueryWithDirectives(scryfallTermPolicy(q).query, EMPTY_TAG_ALIASES);
	return { wire: canonicalStringify(result.tree as FilterValue), warnings: result.warnings };
}

/** Whether a query switches `include_extras` on by itself, both parameters sent as false. */
async function opensExtras(q: string): Promise<boolean> {
	const result = parseScryfallQueryWithDirectives(scryfallTermPolicy(q).query, EMPTY_TAG_ALIASES);
	const gate = await applyExtrasGate(
		{ setsWithExtras: async () => [] } as never,
		result.tree,
		{ loweredRegexTerms: result.loweredRegexTerms, expandedDerivedTerms: result.expandedDerivedTerms },
		{ includeExtras: false, includeVariations: false },
	);
	return gate.includeExtras;
}

describe("an is: value is read with its `-` and `_` removed", () => {
	// `is:fo-il` and `is:f_o-il` are `is:foil` (12 of Kaldheim's 12 gods), `is:full_art` is
	// `is:fullart`'s 825, `is:judge-gift` is `is:judge_gift`'s 164.
	test.each([
		["is:fo-il", "is:foil"],
		["is:f_o-il", "is:foil"],
		["is:full_art", "is:fullart"],
		["is:FULL_ART", "is:fullart"],
		["is:french_vanilla", "is:frenchvanilla"],
		["is:universes_beyond", "is:universesbeyond"],
		["is:art_series", "is:artseries"],
		["is:buy_a_box", "is:buyabox"],
		["is:flavor_name", "is:flavorname"],
		["is:judge-gift", "is:judgegift"],
		["is:player-rewards", "is:player_rewards"],
		["is:playerrewards", "is:player_rewards"],
		["is:content_warning", "is:contentwarning"],
	])("%s is %s", (term, expected) => {
		expect(rewritten(`${term} t:goblin`)).toBe(`${expected} t:goblin`);
		expect(parsed(`${term} t:goblin`)).toEqual(parsed(`${expected} t:goblin`));
		expect(parsed(`${term} t:goblin`).warnings).toEqual([]);
	});

	test("a spelling this parser already stores is left as written", () => {
		for (const term of ["is:judge_gift", "is:arena_league", "is:foil", "is:FOIL", "has:watermark", "not:reprint"]) {
			expect(rewritten(`${term} t:goblin`)).toBe(`${term} t:goblin`);
		}
	});

	test("has: and not: read the same vocabulary, and a `-` is kept", () => {
		expect(rewritten("has:full_art t:goblin")).toBe("has:fullart t:goblin");
		expect(rewritten("-is:full_art t:goblin")).toBe("-is:fullart t:goblin");
		// `not:` is `-is:`.
		expect(rewritten("not:full_art t:goblin")).toBe("-is:fullart t:goblin");
		expect(parsed("not:full_art t:goblin").wire).toBe(parsed("-is:fullart t:goblin").wire);
	});

	test("a quoted value is not respelled", () => {
		// `is:"foil"` is not an `is:` value on Scryfall at all (`Unknown keyword “is”.`).
		expect(scryfallTermPolicy('is:"full_art" t:goblin').query).toBe('is:"full_art" t:goblin');
	});
});

describe("another word for a value answered here", () => {
	// Each pair is the empty symmetric difference on api.scryfall.com over printings with extras
	// in: `(is:A -is:B) or (is:B -is:A)` with unique=prints&include_extras=true is a 404.
	test.each([
		["artcard", "is:artseries"],
		["augment", "is:augmentation"],
		["bab", "is:buyabox"],
		["battlebondland", "is:bondland"],
		["crowdland", "is:bondland"],
		["canopy", "is:canopyland"],
		["horizon", "is:canopyland"],
		["chocobotrack", "is:chocobotrackfoil"],
		["compleat", "is:stepandcompleat"],
		["dracula", "is:draculaseries"],
		["dragonscale", "is:dragonscalefoil"],
		["emboss", "is:embossed"],
		["etch", "is:etched"],
		["extended", "is:extendedart"],
		["extension", "is:setextension"],
		["firstplace", "is:firstplacefoil"],
		["gc", "is:gamechanger"],
		["gleaming", "is:gleaminggold"],
		["gloss", "is:glossy"],
		["godzilla", "is:godzillaseries"],
		["insert", "is:media_insert"],
		["pack", "is:booster"],
		["planeswalkerstamp", "is:stamped"],
		["pwstamped", "is:stamped"],
		["raised", "is:raisedfoil"],
		["ripple", "is:ripplefoil"],
		["wpn", "is:wizardsplaynetwork"],
		["confetti", "is:confettifoil"],
		["doublefaced", "is:dfc"],
		["double_faced", "is:dfc"],
		["doublesided", "is:dfc"],
		["etchedfoil", "is:etched"],
		["extras", "is:extra"],
		["fracture", "is:fracturefoil"],
		["halo", "is:halofoil"],
		["highres", "is:hires"],
		["high_res", "is:hires"],
		["horizonland", "is:canopyland"],
		["modaldfc", "is:mdfc"],
		["modal_dfc", "is:mdfc"],
		["normal", "is:default"],
		["onlyprint", "is:unique"],
		["planeswalkerstamped", "is:stamped"],
		["premium", "is:foil"],
		["printedname", "is:localizedname"],
		["printed_name", "is:localizedname"],
		["pwdeck", "is:planeswalker_deck"],
		["reservedlist", "is:reserved"],
		["splitmana", "is:hybrid"],
		["story", "is:spotlight"],
		["story_spotlight", "is:spotlight"],
		["surge", "is:surgefoil"],
		["tournament", "is:tourney"],
		["trikeland", "is:tricycleland"],
		["ub", "is:universesbeyond"],
	])("is:%s is %s", (value, target) => {
		expect(rewritten(`is:${value} t:goblin`)).toBe(`${target} t:goblin`);
		const tree = parsed(`is:${value} t:goblin`);
		expect(tree).toEqual(parsed(`${target} t:goblin`));
		expect(tree.warnings).toEqual([]);
	});
});

describe("is:<set type> is st:<set type>", () => {
	test.each([
		["archenemy", "archenemy"],
		["arsenal", "arsenal"],
		["box", "box"],
		["core", "core"],
		["eternal", "eternal"],
		["expansion", "expansion"],
		["masters", "masters"],
		["memorabilia", "memorabilia"],
		["planechase", "planechase"],
		["premiumdeck", "premium_deck"],
		["premium_deck", "premium_deck"],
		["starter", "starter"],
	])("is:%s", (value, setType) => {
		expect(rewritten(`is:${value} t:goblin`)).toBe(`st:${setType} t:goblin`);
		expect(parsed(`is:${value} t:goblin`).warnings).toEqual([]);
	});

	test("not every set type is one: is:spellbook is 99 printings apart from st:spellbook", () => {
		expect(scryfallTermPolicy("is:spellbook t:goblin").query).toBe("is:spellbook t:goblin");
		// ...and these four are classes of their own, answered by their own tags and rewrites.
		for (const value of ["commander", "funny", "promo", "token"]) {
			expect(rewritten(`is:${value} t:goblin`)).toBe(`is:${value} t:goblin`);
		}
	});

	test("the `-` goes with it, from either spelling of the negation", () => {
		expect(rewritten("-is:core t:goblin")).toBe("-st:core t:goblin");
		expect(rewritten("not:core t:goblin")).toBe("-st:core t:goblin");
		expect(rewritten("has:core t:goblin")).toBe("st:core t:goblin");
	});
});

describe("is:ff is the sixteen Final Fantasy games together", () => {
	// 741 cards; `(is:ff -(is:ffi or … or is:ffxvi)) or (the converse)` is empty over printings.
	test.each(["ff", "finalfantasy", "final_fantasy"])("is:%s", (value) => {
		const games =
			"(is:ffi or is:ffii or is:ffiii or is:ffiv or is:ffv or is:ffvi or is:ffvii or is:ffviii or " +
			"is:ffix or is:ffx or is:ffxi or is:ffxii or is:ffxiii or is:ffxiv or is:ffxv or is:ffxvi)";
		expect(rewritten(`is:${value} t:goblin`)).toBe(`${games} t:goblin`);
		expect(parsed(`is:${value} t:goblin`).warnings).toEqual([]);
	});
});

describe("is:future and is:modern are frames", () => {
	test("is:future is frame:future and is:modern is frame:2003", () => {
		expect(rewritten("is:futureshifted t:goblin")).toBe("frame:future t:goblin");
		expect(rewritten("is:future t:goblin")).toBe("frame:future t:goblin");
		expect(rewritten("is:modern t:goblin")).toBe("frame:2003 t:goblin");
		expect(rewritten("not:modern t:goblin")).toBe("-frame:2003 t:goblin");
	});
});

describe("is:<field> is the field being present", () => {
	// At the printing grain with extras in: is:artist 117,609, is:flavor 56,525, is:stamp 42,825
	// on api.scryfall.com, and the same three counts for the terms below on production.
	test.each([
		["artist", "has:artist"],
		["flavor", "has:flavor"],
		["flavortext", "has:flavor"],
		["flavor_text", "has:flavor"],
	])("is:%s is %s", (value, target) => {
		expect(rewritten(`is:${value} t:goblin`)).toBe(`${target} t:goblin`);
		expect(parsed(`is:${value} t:goblin`).warnings).toEqual([]);
	});

	test.each(["stamp", "securitystamp", "security_stamp"])("is:%s is any of the six security stamps", (value) => {
		const stamps = "(stamp:oval or stamp:triangle or stamp:acorn or stamp:circle or stamp:arena or stamp:heart)";
		expect(rewritten(`is:${value} t:goblin`)).toBe(`${stamps} t:goblin`);
		expect(rewritten(`-is:${value} t:goblin`)).toBe(`-${stamps} t:goblin`);
		expect(parsed(`is:${value} t:goblin`).warnings).toEqual([]);
	});
});

describe("the respelled term opens extras exactly when the spelling it becomes does", () => {
	// `<term> or cmc=3` sent with include_extras=false, the flag read out of next_page:
	// is:artcard, is:extras, is:doublesided and is:surge echo true; is:core, is:memorabilia,
	// is:artist, is:stamp and is:normal echo false.
	test.each([
		["is:artcard", true],
		["is:extras", true],
		["is:doublesided", true],
		["is:surge", true],
		["is:core", false],
		["is:memorabilia", false],
		["is:artist", false],
		["is:stamp", false],
		["is:normal", false],
	])("%s or cmc=3", async (term, expected) => {
		expect(await opensExtras(`${term} or cmc=3`)).toBe(expected);
	});
});

describe("the six tags stored with generation 61", () => {
	test.each(["contentwarning", "premiereshop", "schinesealtart", "setextension", "singularityfoil", "themepack"])(
		"is:%s has data behind it",
		(value) => {
			expect(SUPPORTED_IS_VALUES.has(value)).toBe(true);
			expect(parsed(`is:${value}`).warnings).toEqual([]);
		},
	);

	test("is:contentwarning opens extras in either polarity; the five promo types do not", async () => {
		// Every content-warning printing is an extra, and Scryfall answers 7 cards by default:
		// `is:contentwarning or cmc=3` and `-is:contentwarning or cmc=3` both echo true.
		expect(await opensExtras("is:contentwarning or cmc=3")).toBe(true);
		expect(await opensExtras("-is:contentwarning or cmc=3")).toBe(true);
		expect(await opensExtras("is:content_warning or cmc=3")).toBe(true);
		for (const value of ["premiereshop", "schinesealtart", "setextension", "singularityfoil", "themepack"]) {
			expect([value, await opensExtras(`is:${value} or cmc=3`)]).toEqual([value, false]);
		}
	});
});

describe("what Scryfall answers and this port cannot is kept, and says so", () => {
	test("every listed value is still unanswered — drop it from the list when it gains an answer", () => {
		for (const value of SCRYFALL_UNANSWERED_IS_VALUES) {
			const policy = scryfallTermPolicy(`is:${value} t:goblin`);
			expect([value, policy.query, policy.warnings]).toEqual([value, `is:${value} t:goblin`, []]);
			expect([value, parsed(`is:${value} t:goblin`).warnings.length]).toEqual([value, 1]);
		}
	});

	test("under its separated spelling too", () => {
		for (const term of ["is:mtgo_id", "is:attraction_lights", "is:from_the_vault"]) {
			expect(scryfallTermPolicy(`${term} t:goblin`).query).toBe(`${term} t:goblin`);
		}
	});
});
