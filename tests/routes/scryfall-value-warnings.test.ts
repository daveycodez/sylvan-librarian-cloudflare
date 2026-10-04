// Scryfall's sentences for a value it will not read — an `is:` value, a set type, a frame, a
// date, a mana symbol — where this port answered a no-match or `Failed to parse query`.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04, anchor `e:khm t:god` = 12
// unless a row says otherwise; the requests are recorded beside each rule in
// src/routes/scryfall-compat/query-terms.ts.

import { describe, expect, test } from "bun:test";
import { EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

const ANCHOR = "e:khm t:god";
const ignored = (echo: string, reason: string) => `Invalid expression “${echo}” was ignored. ${reason}`;

/** The term is dropped, the rest of the query is kept, and the one warning is this sentence. */
function expectIgnored(term: string, echo: string, reason: string): void {
	const policy = scryfallTermPolicy(`${term} ${ANCHOR}`);
	expect([term, policy.query, policy.warnings]).toEqual([term, ANCHOR, [ignored(echo, reason)]]);
	// Alone, the same warning rides the 400 `All of your terms were ignored.`
	const alone = scryfallTermPolicy(term);
	expect([term, alone.allIgnored, alone.warnings]).toEqual([term, true, [ignored(echo, reason)]]);
}

/** The term is kept, as `expected`, with no warning — and what is kept parses. */
function expectKept(term: string, expected: string): void {
	const policy = scryfallTermPolicy(`${term} ${ANCHOR}`);
	expect([term, policy.query, policy.warnings]).toEqual([term, `${expected} ${ANCHOR}`, []]);
	expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
}

describe("an is: value neither side answers", () => {
	const unsupported = (value: string) => `Checking if cards are “${value}” is not supported`;

	test.each([
		["is:nonsense", "is:nonsense", "nonsense"],
		["has:nonsense", "has:nonsense", "nonsense"],
		["not:nonsense", "not:nonsense", "nonsense"],
		["is=nonsense", "is=nonsense", "nonsense"],
		["-is:nonsense", "-is:nonsense", "nonsense"],
		["is:NONSENSE", "is:nonsense", "nonsense"],
		["is:non-sense", "is:non-sense", "non-sense"],
		["is:1", "is:1", "1"],
		// The tags under this port's own spelling are not Scryfall's either.
		["is:game_paper", "is:game_paper", "game_paper"],
		// Measured as unknown there, though each is a field, a frame effect or a type here.
		["is:acorn", "is:acorn", "acorn"],
		["is:legendary", "is:legendary", "legendary"],
		["is:newinpauper", "is:newinpauper", "newinpauper"],
	])("%s is ignored with Scryfall's sentence", (term, echo, value) => {
		expectIgnored(term, echo, unsupported(value));
	});

	test("the value is cut at 20 characters, as the expression is", () => {
		// 20 is named whole; 21 is 19 and an ellipsis.
		expectIgnored("is:abcdefghijklmnopqrst", "is:abcdefghijklmnop…", unsupported("abcdefghijklmnopqrst"));
		expectIgnored("is:abcdefghijklmnopqrstu", "is:abcdefghijklmnop…", unsupported("abcdefghijklmnopqrs…"));
	});

	test("it is dropped from a group, and the group's other arm answers", () => {
		// `(is:nonsense or t:god) e:khm` is the 12 carrying the warning.
		const policy = scryfallTermPolicy("(is:nonsense or t:god) e:khm");
		expect([policy.query, policy.warnings]).toEqual([
			"(t:god) e:khm",
			[ignored("is:nonsense", unsupported("nonsense"))],
		]);
	});

	test("under a comparison it is honored and matches nothing", () => {
		// `is>nonsense e:khm t:god` is a 404 with no warning.
		const policy = scryfallTermPolicy(`is>nonsense ${ANCHOR}`);
		expect([policy.query, policy.warnings]).toEqual([`cmc<0 ${ANCHOR}`, []]);
	});

	test("a value this port answers, respells or knows Scryfall answers is not ignored", () => {
		for (const term of ["is:foil", "is:FOIL", "has:watermark", "not:reprint", "is:vanilla", "is:fetchland"]) {
			expectKept(term, term);
		}
		expectKept("is:full_art", "is:fullart");
		expectKept("is:core", "st:core");
		// Scryfall answers 30,744 for it and this port cannot: kept, and matching nothing.
		expect(scryfallTermPolicy(`is:mtgoid ${ANCHOR}`).query).toBe(`is:mtgoid ${ANCHOR}`);
	});
});

describe("a quoted is: value is not an is: value", () => {
	test.each([
		['is:"foil"', 'is:"foil"', "is"],
		["is:'foil'", "is:'foil'", "is"],
		['is:"nonsense"', 'is:"nonsense"', "is"],
		['is:"two words"', 'is:"two words"', "is"],
		['has:"watermark"', 'has:"watermark"', "has"],
		['not:"foil"', 'not:"foil"', "not"],
		['-is:"foil"', '-is:"foil"', "-is"],
		// A letter outside ASCII takes the same sentence, the expression lower-cased.
		["is:Éowyn", "is:éowyn", "is"],
	])("%s", (term, echo, keyword) => {
		expectIgnored(term, echo, `Unknown keyword “${keyword}”.`);
	});
});

describe("a regex on is: is the regex-keyword sentence unless it spells a value answered here", () => {
	test("is:/nonsense/", () => {
		expectIgnored("is:/nonsense/", "is:/nonsense/", "Unknown regular expression keyword “is”.");
	});

	test("is:/promo/ keeps answering, as it did", () => {
		expect(scryfallTermPolicy(`is:/promo/ ${ANCHOR}`).warnings).toEqual([]);
	});
});

describe("st: reads Scryfall's 24 set types and nothing else", () => {
	test.each([
		["st:nonsense", "st:nonsense", "nonsense"],
		["set_type:nonsense", "set_type:nonsense", "nonsense"],
		["settype:nonsense", "settype:nonsense", "nonsense"],
		["st=nonsense", "st=nonsense", "nonsense"],
		['st:"nonsense"', 'st:"nonsense"', "nonsense"],
		["st:NONSENSE", "st:nonsense", "nonsense"],
		["-st:nonsense", "-st:nonsense", "nonsense"],
		// No prefix, nickname or plural is a set type.
		["st:exp", "st:exp", "exp"],
		["st:duel", "st:duel", "duel"],
		["st:ftv", "st:ftv", "ftv"],
		["st:tokens", "st:tokens", "tokens"],
		["st:promos", "st:promos", "promos"],
		["st:supplemental", "st:supplemental", "supplemental"],
		["st:un", "st:un", "un"],
	])("%s", (term, echo, value) => {
		expectIgnored(term, echo, `Unknown set type “${value}”`);
	});

	test("the sentence names the whole value where the expression is cut", () => {
		expectIgnored(
			"st:abcdefghijklmnopqrstuvwxyz",
			"st:abcdefghijklmnop…",
			"Unknown set type “abcdefghijklmnopqrstuvwxyz”",
		);
	});

	test("all 24 are kept as written", () => {
		for (const setType of [
			"alchemy",
			"archenemy",
			"arsenal",
			"box",
			"commander",
			"core",
			"draft_innovation",
			"duel_deck",
			"eternal",
			"expansion",
			"from_the_vault",
			"funny",
			"masterpiece",
			"masters",
			"memorabilia",
			"minigame",
			"planechase",
			"premium_deck",
			"promo",
			"spellbook",
			"starter",
			"token",
			"treasure_chest",
			"vanguard",
		]) {
			expectKept(`st:${setType}`, `st:${setType}`);
		}
		expectKept("st:EXPANSION", "st:EXPANSION");
		expectKept('st:"expansion"', 'st:"expansion"');
	});

	test("a set type is read with its spaces, `_` and `-` removed", () => {
		// `st:draftinnovation`, `st:draft-innovation` and `st:"draft innovation"` are each
		// `st:draft_innovation t:god`'s 11.
		expectKept("st:draftinnovation", "st:draft_innovation");
		expectKept("st:draft-innovation", "st:draft_innovation");
		expectKept('st:"draft innovation"', "st:draft_innovation");
		expectKept("-settype:fromthevault", "-settype:from_the_vault");
		expectKept('st:"duel deck"', "st:duel_deck");
	});

	test("under a comparison it is honored and matches nothing", () => {
		expect(scryfallTermPolicy(`st>nonsense ${ANCHOR}`).query).toBe(`cmc<0 ${ANCHOR}`);
	});

	test("a pattern keeps answering only when it spells a set type", () => {
		expect(scryfallTermPolicy(`st:/expansion/ ${ANCHOR}`).warnings).toEqual([]);
		expectIgnored("st:/exp/", "st:/exp/", "Unknown regular expression keyword “st”.");
		// `set_type:` takes the value sentence, slashes and all — the per-spelling split.
		expectIgnored("set_type:/exp/", "set_type:/exp/", "Unknown set type “/exp/”");
	});
});

describe("frame: reads Scryfall's frames, effects and nicknames and nothing else", () => {
	test.each([
		["frame:nonsense", "frame:nonsense", "nonsense"],
		["frame=nonsense", "frame=nonsense", "nonsense"],
		['frame:"nonsense"', 'frame:"nonsense"', "nonsense"],
		["frame:NONSENSE", "frame:nonsense", "nonsense"],
		["-frame:nonsense", "-frame:nonsense", "nonsense"],
		["frame:1", "frame:1", "1"],
		// Each of these is something else on a card and not a frame.
		["frame:fullart", "frame:fullart", "fullart"],
		["frame:textless", "frame:textless", "textless"],
		["frame:borderless", "frame:borderless", "borderless"],
		["frame:booster", "frame:booster", "booster"],
		["frame:timeshifted", "frame:timeshifted", "timeshifted"],
		["frame:textured", "frame:textured", "textured"],
		["frame:dfc", "frame:dfc", "dfc"],
	])("%s", (term, echo, value) => {
		expectIgnored(term, echo, `Unknown frame “${value}”`);
	});

	test("the sentence names the whole value where the expression is cut", () => {
		expectIgnored(
			"frame:abcdefghijklmnopqrstuvwxyz",
			"frame:abcdefghijklm…",
			"Unknown frame “abcdefghijklmnopqrstuvwxyz”",
		);
	});

	test("the editions and the 24 frame effects are kept as written", () => {
		for (const frame of [
			"1993",
			"1997",
			"2003",
			"2015",
			"future",
			"old",
			"new",
			"modern",
			"legendary",
			"miracle",
			"enchantment",
			"draft",
			"devoid",
			"tombstone",
			"colorshifted",
			"inverted",
			"sunmoondfc",
			"compasslanddfc",
			"originpwdfc",
			"mooneldrazidfc",
			"waxingandwaningmoondfc",
			"showcase",
			"extendedart",
			"companion",
			"etched",
			"snow",
			"lesson",
			"shatteredglass",
			"convertdfc",
			"fandfc",
			"upsidedowndfc",
			"spree",
		]) {
			expectKept(`frame:${frame}`, `frame:${frame}`);
		}
		expectKept("frame:LEGENDARY", "frame:LEGENDARY");
		expectKept('frame:"2015"', 'frame:"2015"');
	});

	// Each nickname is the same count as the value it names over the whole corpus: 93 = 1993
	// (1,589), 97 = classic = 1997 (6,748), 03 = 8ed = 2003 (9,070), 15 = m15 = 2015 (24,819),
	// retro = old (7,285), nyx = nyxtouched = enchantment (831).
	test.each([
		["93", "1993"],
		["97", "1997"],
		["classic", "1997"],
		["03", "2003"],
		["8ed", "2003"],
		["15", "2015"],
		["m15", "2015"],
		["M15", "2015"],
		["retro", "old"],
		["nyx", "enchantment"],
		["nyxtouched", "enchantment"],
	])("frame:%s is frame:%s", (nickname, frame) => {
		expectKept(`frame:${nickname}`, `frame:${frame}`);
		expectKept(`-frame:${nickname}`, `-frame:${frame}`);
	});

	test("under a comparison it is honored and matches nothing; a pattern is the regex sentence", () => {
		expect(scryfallTermPolicy(`frame>nonsense ${ANCHOR}`).query).toBe(`cmc<0 ${ANCHOR}`);
		expectIgnored("frame:/nonsense/", "frame:/nonsense/", "Unknown regular expression keyword “frame”.");
	});
});

describe("a date shaped like one whose month or day does not exist", () => {
	test.each([
		["date:2021-13", "date:2021-13", "2021-13"],
		["date:2021-00", "date:2021-00", "2021-00"],
		["date:2021-99", "date:2021-99", "2021-99"],
		['date:"2021-13"', 'date:"2021-13"', "2021-13"],
		["date:2021-13-01", "date:2021-13-01", "2021-13-01"],
		["date:2021-12-32", "date:2021-12-32", "2021-12-32"],
		["date:2021-02-00", "date:2021-02-00", "2021-02-00"],
		["date>=2021-13", "date>=2021-13", "2021-13"],
		["-date:2021-13", "-date:2021-13", "2021-13"],
	])("%s", (term, echo, value) => {
		expectIgnored(term, echo, `Invalid date “${value}”`);
	});

	test("a value that is not shaped like a date keeps the set-code sentence", () => {
		// `date:2021-1-1`, `date:2021-02-5`, `date:2021-013` and `date:20211`, each measured.
		for (const value of ["2021-1-1", "2021-02-5", "2021-013", "20211"]) {
			expectIgnored(`date:${value}`, `date:${value}`, `Invalid date or unknown set code “${value}”`);
		}
	});
});

describe("a date Scryfall honors and the parser will not read", () => {
	// Kaldheim is 2021-02-05. A day its month does not have compares past the month's end:
	// `date:2021-02-30` and `date:2021-02-29` are 404, `date!=2021-02-30` and `date<=2021-02-30`
	// the 12, `date>=2021-02-30` and `date>=2021-02-29` 404.
	test.each([
		["date:2021-02-30", "cmc<0"],
		["date=2021-02-30", "cmc<0"],
		["date:2021-02-29", "cmc<0"],
		["date!=2021-02-30", "-cmc<0"],
		["date<=2021-02-30", "date<=2021-02-28"],
		["date<2021-02-30", "date<=2021-02-28"],
		["date>=2021-02-30", "date>2021-02-28"],
		["date>=2021-02-29", "date>2021-02-28"],
		["date>2021-04-31", "date>2021-04-30"],
		// 2024 is a leap year: the 29th exists and the parser reads it.
		["date:2024-02-29", "date:2024-02-29"],
		["date<=2024-02-30", "date<=2024-02-29"],
	])("%s", (term, expected) => {
		expectKept(term, expected);
	});

	// A year no printing is dated in compares as a number: `date:1990`, `date<1990`, `date:2041`
	// and `date>9999` are 404; `date>=0000`, `date<9999` and `date<=2041` the 12.
	test.each([
		["date:1990", "cmc<0"],
		["date<1990", "cmc<0"],
		["date<=1990-06", "cmc<0"],
		["date>=0000", "-cmc<0"],
		["date>1990-06-15", "-cmc<0"],
		["date!=1990", "-cmc<0"],
		["date:2041", "cmc<0"],
		["date>9999", "cmc<0"],
		["date>=2041-01-01", "cmc<0"],
		["date<9999", "-cmc<0"],
		["date<=2041", "-cmc<0"],
		["date!=2041", "-cmc<0"],
	])("%s", (term, expected) => {
		expectKept(term, expected);
	});

	test("the `-` on a date is discarded, as on every date term", () => {
		expectKept("-date:2021-02-30", "cmc<0");
		expectKept("-date>=0000", "-cmc<0");
	});

	test("a date the parser reads is left alone", () => {
		for (const term of ["date:2021", "date>=2021-02", "date<=2021-02-28", "date:1993", "date<2040-12-31"]) {
			expectKept(term, term);
		}
	});

	// `year:0000` and `year:9999` are 404 and `year>=0` the 12.
	test.each([
		["year:0000", "cmc<0"],
		["year:9999", "cmc<0"],
		["year>=0", "-cmc<0"],
		["year<1990", "cmc<0"],
		["year<=2041", "-cmc<0"],
		["year:2021", "year:2021"],
	])("%s", (term, expected) => {
		expectKept(term, expected);
	});

	test("a negated year keeps the sentences it had", () => {
		// The negation rules answer first: `-year:1993` is `Unknown keyword “-year”.` and a negated
		// comparison is the silent tautology.
		expectIgnored("-year:0000", "-year:0000", "Unknown keyword “-year”.");
		expectKept("-year>=0", "-cmc<0");
	});
});

describe("mana: names what its reader leaves unread", () => {
	const unknown = (left: string) => `Unknown mana symbols “${left}”.`;

	test.each([
		["mana:{q}", "{Q}"],
		["m:{q}", "{Q}"],
		["mana={q}", "{Q}"],
		["mana>={q}", "{Q}"],
		["-mana:{q}", "{Q}"],
		['mana:"{q}"', "{Q}"],
		["mana:{t}", "{T}"],
		["mana:{e}", "{E}"],
		["mana:{a}", "{A}"],
		["mana:{d}", "{D}"],
		["mana:{p}", "{P}"],
		["mana:{tk}", "{TK}"],
		["mana:{q}{t}", "{Q}{T}"],
		["mana:{}", "{}"],
		["mana:q", "Q"],
		["mana:wq", "Q"],
		["mana:1q", "Q"],
		["mana:2wwq", "Q"],
		["mana:abc", "A"],
		["mana:hello", "HEO"],
		["mana:{w}{q}", "{Q}"],
		["mana:{w}{w}{zz}", "{}"],
		["mana:{pw}", "{P}"],
		["mana:{chaos}", "{HAO}"],
		["mana:{1/w}", "{1/}"],
		["mana:{2/c}", "{2/}"],
		["mana:{2/2}", "{2/2}"],
		["mana:{w/q}", "{/Q}"],
		["mana:{w/w}", "{/}"],
		["mana:{w/u/b}", "{//}"],
		["mana:{w/p/p}", "{/P/P}"],
	])("%s leaves %s", (term, left) => {
		expectIgnored(term, term, unknown(left));
	});

	test("a value it reads whole is kept as written", () => {
		// `mana:{100}`, `mana:{s}`, `mana:{u/w}` and `mana:{c/w}` are honored (404 among the gods).
		for (const term of [
			"mana:{100}",
			"mana:{s}",
			"mana:{u/w}",
			"mana:{c/w}",
			"mana:{w}{u}",
			"m:2ww",
			"mana>={r}{r}",
			"m:{W/P}",
		]) {
			expectKept(term, term);
		}
	});

	test("a hybrid written in the other order is respelled to the one the parser reads", () => {
		// `mana:{p/w}` and `mana:{w/2}` are honored there and were a parse error here.
		expectKept("mana:{p/w}", "mana:{w/p}");
		expectKept("mana:{w/2}", "mana:{2/w}");
		expectKept("-m:{p/u/w}{r}", "-m:{u/w/p}{r}");
	});

	test("a shape nobody measured is left to the parser, as before", () => {
		// A bare digit that is not leading, and a character outside letters, digits, braces and `/`.
		for (const term of ["mana:w2q", "mana:{q}+{t}"]) {
			const policy = scryfallTermPolicy(`${term} ${ANCHOR}`);
			expect([term, policy.query, policy.warnings]).toEqual([term, `${term} ${ANCHOR}`, []]);
		}
	});

	test("the two slash forms keep the sentences they had", () => {
		// `mana>=/{r}/` names `//` and `mana!=/^tap/` the whole value.
		expect(scryfallTermPolicy(`mana>=/{r}/ ${ANCHOR}`).warnings).toEqual([ignored("mana>=/{r}/", unknown("//"))]);
		expect(scryfallTermPolicy(`mana!=/^tap/ ${ANCHOR}`).warnings).toEqual([ignored("mana!=/^tap/", unknown("/^TAP/"))]);
	});
});
