// `GET /symbology/parse-mana`'s cost parser, against goldens captured from api.scryfall.com.
//
// Ported from upstream's api/tests/test_scryfall_mana.py (#922) with its expectations intact, which
// is the point: every one was CAPTURED FROM THE LIVE API on 2026-08-11 rather than worked out by
// hand, because two of the behaviours are undocumented — the canonical colour reordering (`RUW`
// answers `{U}{R}{W}`) and the emission order (`2XWU` answers `{X}{2}{W}{U}`). A hand-written
// expectation for those would only re-assert whatever the implementation happened to do.
//
// The colour cases are exhaustive: all 31 non-empty subsets of WUBRG, each written forwards and
// backwards, so the colour ordering is pinned over its whole domain rather than at a few samples.

import { describe, expect, test } from "bun:test";
import { ManaCostError, parseManaCost } from "../../src/routes/scryfall-compat/mana";

interface Golden {
	cost: string | null;
	colors: string[];
	cmc: number;
	colorless: boolean;
	monocolored: boolean;
	multicolored: boolean;
}

const GOLDENS: [string, Golden][] = [
	["", { cost: null, colors: [], cmc: 0, colorless: true, monocolored: false, multicolored: false }],
	["0", { cost: "{0}", colors: [], cmc: 0, colorless: true, monocolored: false, multicolored: false }],
	["2WW", { cost: "{2}{W}{W}", colors: ["W"], cmc: 4, colorless: false, monocolored: true, multicolored: false }],
	["XRR", { cost: "{X}{R}{R}", colors: ["R"], cmc: 2, colorless: false, monocolored: true, multicolored: false }],
	["W2", { cost: "{2}{W}", colors: ["W"], cmc: 3, colorless: false, monocolored: true, multicolored: false }],
	["RX", { cost: "{X}{R}", colors: ["R"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	[
		"GWU2",
		{ cost: "{2}{G}{W}{U}", colors: ["W", "U", "G"], cmc: 5, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"2XWU",
		{ cost: "{X}{2}{W}{U}", colors: ["W", "U"], cmc: 4, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"WUBRGC",
		{
			cost: "{W}{U}{B}{R}{G}{C}",
			colors: ["W", "U", "B", "R", "G"],
			cmc: 6,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	["CW", { cost: "{W}{C}", colors: ["W"], cmc: 2, colorless: false, monocolored: true, multicolored: false }],
	["{2/W}", { cost: "{2/W}", colors: ["W"], cmc: 2, colorless: false, monocolored: true, multicolored: false }],
	["{W/P}", { cost: "{W/P}", colors: ["W"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["{HW}", { cost: "{HW}", colors: ["W"], cmc: 0.5, colorless: false, monocolored: true, multicolored: false }],
	["{C}", { cost: "{C}", colors: [], cmc: 1, colorless: true, monocolored: false, multicolored: false }],
	["{S}", { cost: "{S}", colors: [], cmc: 1, colorless: true, monocolored: false, multicolored: false }],
	["11R", { cost: "{11}{R}", colors: ["R"], cmc: 12, colorless: false, monocolored: true, multicolored: false }],
	["{10}", { cost: "{10}", colors: [], cmc: 10, colorless: true, monocolored: false, multicolored: false }],
	[
		"{W/U}{B/R}",
		{
			cost: "{W/U}{B/R}",
			colors: ["W", "U", "B", "R"],
			cmc: 2,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"{1}{W/U}{W/U}",
		{ cost: "{1}{W/U}{W/U}", colors: ["W", "U"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	["{X}{X}{R}", { cost: "{X}{X}{R}", colors: ["R"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	[
		"{B/G}{B/G}",
		{ cost: "{B/G}{B/G}", colors: ["B", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true },
	],
	["{HR}{R}", { cost: "{HR}{R}", colors: ["R"], cmc: 1.5, colorless: false, monocolored: true, multicolored: false }],
	["W", { cost: "{W}", colors: ["W"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["U", { cost: "{U}", colors: ["U"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["B", { cost: "{B}", colors: ["B"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["R", { cost: "{R}", colors: ["R"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["G", { cost: "{G}", colors: ["G"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["WU", { cost: "{W}{U}", colors: ["W", "U"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["UW", { cost: "{W}{U}", colors: ["W", "U"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["WB", { cost: "{W}{B}", colors: ["W", "B"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["BW", { cost: "{W}{B}", colors: ["W", "B"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["WR", { cost: "{R}{W}", colors: ["W", "R"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["RW", { cost: "{R}{W}", colors: ["W", "R"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["WG", { cost: "{G}{W}", colors: ["W", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["GW", { cost: "{G}{W}", colors: ["W", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["UB", { cost: "{U}{B}", colors: ["U", "B"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["BU", { cost: "{U}{B}", colors: ["U", "B"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["UR", { cost: "{U}{R}", colors: ["U", "R"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["RU", { cost: "{U}{R}", colors: ["U", "R"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["UG", { cost: "{G}{U}", colors: ["U", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["GU", { cost: "{G}{U}", colors: ["U", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["BR", { cost: "{B}{R}", colors: ["B", "R"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["RB", { cost: "{B}{R}", colors: ["B", "R"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["BG", { cost: "{B}{G}", colors: ["B", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["GB", { cost: "{B}{G}", colors: ["B", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["RG", { cost: "{R}{G}", colors: ["R", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	["GR", { cost: "{R}{G}", colors: ["R", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true }],
	[
		"WUB",
		{ cost: "{W}{U}{B}", colors: ["W", "U", "B"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"BUW",
		{ cost: "{W}{U}{B}", colors: ["W", "U", "B"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"WUR",
		{ cost: "{U}{R}{W}", colors: ["W", "U", "R"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"RUW",
		{ cost: "{U}{R}{W}", colors: ["W", "U", "R"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"WUG",
		{ cost: "{G}{W}{U}", colors: ["W", "U", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"GUW",
		{ cost: "{G}{W}{U}", colors: ["W", "U", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"WBR",
		{ cost: "{R}{W}{B}", colors: ["W", "B", "R"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"RBW",
		{ cost: "{R}{W}{B}", colors: ["W", "B", "R"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"WBG",
		{ cost: "{W}{B}{G}", colors: ["W", "B", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"GBW",
		{ cost: "{W}{B}{G}", colors: ["W", "B", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"WRG",
		{ cost: "{R}{G}{W}", colors: ["W", "R", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"GRW",
		{ cost: "{R}{G}{W}", colors: ["W", "R", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"UBR",
		{ cost: "{U}{B}{R}", colors: ["U", "B", "R"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"RBU",
		{ cost: "{U}{B}{R}", colors: ["U", "B", "R"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"UBG",
		{ cost: "{B}{G}{U}", colors: ["U", "B", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"GBU",
		{ cost: "{B}{G}{U}", colors: ["U", "B", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"URG",
		{ cost: "{G}{U}{R}", colors: ["U", "R", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"GRU",
		{ cost: "{G}{U}{R}", colors: ["U", "R", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"BRG",
		{ cost: "{B}{R}{G}", colors: ["B", "R", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"GRB",
		{ cost: "{B}{R}{G}", colors: ["B", "R", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"WUBR",
		{
			cost: "{W}{U}{B}{R}",
			colors: ["W", "U", "B", "R"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"RBUW",
		{
			cost: "{W}{U}{B}{R}",
			colors: ["W", "U", "B", "R"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"WUBG",
		{
			cost: "{G}{W}{U}{B}",
			colors: ["W", "U", "B", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"GBUW",
		{
			cost: "{G}{W}{U}{B}",
			colors: ["W", "U", "B", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"WURG",
		{
			cost: "{R}{G}{W}{U}",
			colors: ["W", "U", "R", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"GRUW",
		{
			cost: "{R}{G}{W}{U}",
			colors: ["W", "U", "R", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"WBRG",
		{
			cost: "{B}{R}{G}{W}",
			colors: ["W", "B", "R", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"GRBW",
		{
			cost: "{B}{R}{G}{W}",
			colors: ["W", "B", "R", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"UBRG",
		{
			cost: "{U}{B}{R}{G}",
			colors: ["U", "B", "R", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"GRBU",
		{
			cost: "{U}{B}{R}{G}",
			colors: ["U", "B", "R", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"WUBRG",
		{
			cost: "{W}{U}{B}{R}{G}",
			colors: ["W", "U", "B", "R", "G"],
			cmc: 5,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"GRBUW",
		{
			cost: "{W}{U}{B}{R}{G}",
			colors: ["W", "U", "B", "R", "G"],
			cmc: 5,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
];

/** Costs api.scryfall.com rejects with a 422 rather than parsing. */
const UNPARSEABLE = ["{T}", "{Q}"];

describe("parse-mana goldens", () => {
	test.each(GOLDENS)("%s parses as Scryfall parses it", (written, expected) => {
		const parsed = parseManaCost(written) as unknown as Golden & { object: string };
		expect(parsed.object).toBe("mana_cost");
		for (const [field, value] of Object.entries(expected)) {
			expect({ [field]: parsed[field as keyof Golden] }).toEqual({ [field]: value });
		}
	});

	test.each(UNPARSEABLE)("%s is not mana and is rejected", (written) => {
		expect(() => parseManaCost(written)).toThrow(ManaCostError);
	});
});

describe("properties the goldens imply but do not state outright", () => {
	test("an empty cost is null but an explicit zero is not", () => {
		// The two differ upstream, so they cannot share a branch here.
		expect(parseManaCost("").cost).toBeNull();
		expect(parseManaCost("0").cost).toBe("{0}");
	});

	test("case and whitespace do not change the answer", () => {
		expect(parseManaCost("ruw")).toEqual(parseManaCost("RUW"));
		expect(parseManaCost(" 2 W W ")).toEqual(parseManaCost("2WW"));
	});

	test("generic pips are summed into one symbol", () => {
		expect(parseManaCost("1{1}").cost).toBe("{2}");
	});

	test("consecutive digits are one number", () => {
		// `11R` is eleven generic and a red pip, not two ones.
		expect(parseManaCost("11R").cmc).toBe(12);
	});

	test("the colors list is always WUBRG order", () => {
		// Unlike `cost`, which is reordered canonically, `colors` is not.
		expect(parseManaCost("RUW").cost).toBe("{U}{R}{W}");
		expect(parseManaCost("RUW").colors).toEqual(["W", "U", "R"]);
	});
});
