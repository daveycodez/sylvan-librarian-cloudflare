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
//
// A second measurement session on 2026-08-28 added the HYBRID goldens below — 61 more requests, one
// per row, driven by `GET /symbology`'s own inventory of 84 symbols rather than by what the parser
// happened to accept. That inventory is what the parser is now written against, because the rule it
// used to carry ("a hybrid has exactly two halves") rejected `{W/U/P}` — a printed Phyrexian hybrid
// that four live cards put in their mana cost.

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
	// --- The hybrid inventory, measured from `GET /symbology` on 2026-08-28 -----------------------
	//
	// All ten PHYREXIAN HYBRIDS. These were 422s here until 2026-08-28: the parser required a hybrid
	// to have exactly two halves, which is right for `{W/U/B}` and wrong for every row below.
	[
		"{W/U/P}",
		{ cost: "{W/U/P}", colors: ["W", "U"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{W/B/P}",
		{ cost: "{W/B/P}", colors: ["W", "B"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{U/B/P}",
		{ cost: "{U/B/P}", colors: ["U", "B"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{U/R/P}",
		{ cost: "{U/R/P}", colors: ["U", "R"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{B/R/P}",
		{ cost: "{B/R/P}", colors: ["B", "R"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{B/G/P}",
		{ cost: "{B/G/P}", colors: ["B", "G"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{R/G/P}",
		{ cost: "{R/G/P}", colors: ["R", "G"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{R/W/P}",
		{ cost: "{R/W/P}", colors: ["W", "R"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{G/W/P}",
		{ cost: "{G/W/P}", colors: ["W", "G"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{G/U/P}",
		{ cost: "{G/U/P}", colors: ["U", "G"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	// The four cards that actually print one, mana cost as `/cards/search?q=is:phyrexian is:hybrid`
	// gives it (2026-08-28, 4 results, no more): Ajani, Sleeper Agent (DMU); Tamiyo, Compleated Sage
	// (NEO); Nahiri, the Unforgiving (ONE); Lukka, Bound to Ruin (ONE). Every one of these was a 422.
	[
		"{1}{G}{G/W/P}{W}",
		{ cost: "{1}{G/W/P}{G}{W}", colors: ["W", "G"], cmc: 4, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{2}{G}{G/U/P}{U}",
		{ cost: "{2}{G/U/P}{G}{U}", colors: ["U", "G"], cmc: 5, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{1}{R}{R/W/P}{W}",
		{ cost: "{1}{R/W/P}{R}{W}", colors: ["W", "R"], cmc: 4, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{2}{R}{R/G/P}{G}",
		{ cost: "{2}{R/G/P}{R}{G}", colors: ["R", "G"], cmc: 5, colorless: false, monocolored: false, multicolored: true },
	],
	// The colorless hybrids, which the two-halves rule also rejected — not for the count, but because
	// it priced only colours, digits and `P`, and `C` is none of the three. `{C/P}` produces NO colour.
	["{C/W}", { cost: "{C/W}", colors: ["W"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["{C/U}", { cost: "{C/U}", colors: ["U"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["{C/B}", { cost: "{C/B}", colors: ["B"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["{C/R}", { cost: "{C/R}", colors: ["R"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["{C/G}", { cost: "{C/G}", colors: ["G"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["{C/P}", { cost: "{C/P}", colors: [], cmc: 1, colorless: true, monocolored: false, multicolored: false }],
	// A TWO-part hybrid may be written either way round and comes back in the listed spelling. A
	// three-part one may not — see REJECTED, where `{U/W/P}` is a 422 though `{W/U/P}` parses.
	["{U/W}", { cost: "{W/U}", colors: ["W", "U"], cmc: 1, colorless: false, monocolored: false, multicolored: true }],
	["{W/2}", { cost: "{2/W}", colors: ["W"], cmc: 2, colorless: false, monocolored: true, multicolored: false }],
	["{P/W}", { cost: "{W/P}", colors: ["W"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["{W/C}", { cost: "{C/W}", colors: ["W"], cmc: 1, colorless: false, monocolored: true, multicolored: false }],
	["{W/G}", { cost: "{G/W}", colors: ["W", "G"], cmc: 1, colorless: false, monocolored: false, multicolored: true }],
	[
		"{W/U}{U/W}",
		{ cost: "{W/U}{W/U}", colors: ["W", "U"], cmc: 2, colorless: false, monocolored: false, multicolored: true },
	],
	// EMISSION ORDER. Every row here was also requested written the other way round and answered the
	// same, which is what makes it a sort rather than the writing order. The order is `/symbology`
	// catalog order — the plain colour pips are the one exception, and keep the canonical colour order
	// the goldens above pin. `{G/W}{W/U}` and `{G/U}{W/B}` are the rows a colour-rank sort cannot
	// reach: both put the LATER colour's hybrid first.
	[
		"{G}{G/W}{W}",
		{ cost: "{G/W}{G}{W}", colors: ["W", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	["{W}{HW}", { cost: "{HW}{W}", colors: ["W"], cmc: 1.5, colorless: false, monocolored: true, multicolored: false }],
	[
		"{R}{HR}{R/W}",
		{ cost: "{R/W}{HR}{R}", colors: ["W", "R"], cmc: 2.5, colorless: false, monocolored: false, multicolored: true },
	],
	["{W}{C/P}", { cost: "{C/P}{W}", colors: ["W"], cmc: 2, colorless: false, monocolored: true, multicolored: false }],
	["{C}{C/P}", { cost: "{C/P}{C}", colors: [], cmc: 2, colorless: true, monocolored: false, multicolored: false }],
	["{S}{C}", { cost: "{C}{S}", colors: [], cmc: 2, colorless: true, monocolored: false, multicolored: false }],
	[
		"{HR}{HW}",
		{ cost: "{HW}{HR}", colors: ["W", "R"], cmc: 1, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{G/W}{W/U}",
		{ cost: "{W/U}{G/W}", colors: ["W", "U", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{G/U}{W/B}",
		{
			cost: "{W/B}{G/U}",
			colors: ["W", "U", "B", "G"],
			cmc: 2,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"{U/B}{W/U}{B/R}",
		{
			cost: "{W/U}{B/R}{U/B}",
			colors: ["W", "U", "B", "R"],
			cmc: 3,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"{C/G}{G/P}{2/G}{G/W}",
		{
			cost: "{G/W}{C/G}{2/G}{G/P}",
			colors: ["W", "G"],
			cmc: 5,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"{G}{G/U/P}{U}{G/W}",
		{
			cost: "{G/W}{G/U/P}{G}{U}",
			colors: ["W", "U", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"{HW}{R}",
		{ cost: "{HW}{R}", colors: ["W", "R"], cmc: 1.5, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{HR}{G/W}",
		{ cost: "{G/W}{HR}", colors: ["W", "R", "G"], cmc: 1.5, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{2/W}{G/U}",
		{ cost: "{G/U}{2/W}", colors: ["W", "U", "G"], cmc: 3, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{G/U/P}{W/U}",
		{ cost: "{W/U}{G/U/P}", colors: ["W", "U", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"{G/W/P}{G/U/P}",
		{
			cost: "{G/U/P}{G/W/P}",
			colors: ["W", "U", "G"],
			cmc: 2,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"{G/W}{G/W/P}",
		{ cost: "{G/W}{G/W/P}", colors: ["W", "G"], cmc: 2, colorless: false, monocolored: false, multicolored: true },
	],
	[
		"2{W/U/P}{G}",
		{
			cost: "{2}{W/U/P}{G}",
			colors: ["W", "U", "G"],
			cmc: 4,
			colorless: false,
			monocolored: false,
			multicolored: true,
		},
	],
	[
		"{W/U/P}{W/U/P}",
		{ cost: "{W/U/P}{W/U/P}", colors: ["W", "U"], cmc: 2, colorless: false, monocolored: false, multicolored: true },
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

/**
 * Costs api.scryfall.com rejects, WITH the fragment its 422 names — captured one request per row on
 * 2026-08-28, and the reason the inventory had to be measured rather than reasoned about.
 *
 * The first four rows are the boundary the accepting goldens above sit against: a slash symbol
 * parses only if `GET /symbology` lists it, so a third half (`{W/U/B}`), a fourth (`{W/U/P/P}`), the
 * same symbol spelled backwards (`{U/W/P}`, `{P/W/U}`), a combination that is not printed
 * (`{C/W/P}`, `{W/W/P}`, `{2/W/P}`) and a generic half that is not 2 (`{3/W}`) are all 422s.
 *
 * The fragments also pin what "everything Scryfall could read" strikes out: the ten one-character
 * symbols and nothing else. `P`, `H` and digits SURVIVE — the residue rule here used to strike them
 * because the parser priced them, which no measurement supported.
 */
const REJECTED: [string, string][] = [
	["{W/U/B}", "{//}"],
	["{U/W/P}", "{//P}"],
	["{P/W/U}", "{P//}"],
	["{W/U/P/P}", "{//P/P}"],
	["{C/W/P}", "{//P}"],
	["{W/W/P}", "{//P}"],
	["{2/W/P}", "{2//P}"],
	["{3/W}", "{3/}"],
	["{S/W}", "{/}"],
	["{X/W}", "{/}"],
	["{C/S}", "{/}"],
	// `H` is not a prefix over any colour: `GET /symbology` lists {HW} and {HR}, and no others.
	["{H/W}", "{H/}"],
	["{HB}", "{H}"],
];

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

	test.each(REJECTED)("%s is rejected naming the fragment Scryfall names", (written, fragment) => {
		// The `details` string is compared byte for byte by clients, so it is pinned that way.
		expect(() => parseManaCost(written)).toThrow(
			`The string fragment(s) “${fragment}” could not be understood as part of mana cost.`,
		);
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

	test("a hybrid is the symbols Scryfall lists, not a shape a symbol may take", () => {
		// The rule this replaced counted halves, which gets `{W/U/B}` right and `{W/U/P}` wrong.
		// Neither "exactly two" nor "two or three" is the boundary — the inventory is.
		expect(parseManaCost("{W/U}").cost).toBe("{W/U}");
		expect(parseManaCost("{W/U/P}").cost).toBe("{W/U/P}");
		expect(parseManaCost("{2/W}").cmc).toBe(2);
		expect(parseManaCost("{W/U/P}").cmc).toBe(1);
		expect(() => parseManaCost("{W/U/B}")).toThrow(ManaCostError);
		expect(() => parseManaCost("{U/W/P}")).toThrow(ManaCostError);
		expect(() => parseManaCost("{3/W}")).toThrow(ManaCostError);
	});

	test("a Phyrexian hybrid contributes both its colours and one mana", () => {
		// Ajani, Sleeper Agent — the whole point of the fix, since `is:phyrexian is:hybrid` finds
		// four cards and this route used to 422 on all four (2026-08-28).
		const ajani = parseManaCost("{1}{G}{G/W/P}{W}");
		expect(ajani.cost).toBe("{1}{G/W/P}{G}{W}");
		expect(ajani.colors).toEqual(["W", "G"]);
		expect(ajani.cmc).toBe(4);
	});

	test("the colors list is always WUBRG order", () => {
		// Unlike `cost`, which is reordered canonically, `colors` is not.
		expect(parseManaCost("RUW").cost).toBe("{U}{R}{W}");
		expect(parseManaCost("RUW").colors).toEqual(["W", "U", "R"]);
	});
});
