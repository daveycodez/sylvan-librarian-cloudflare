// `g:` / `group:` — every card of a set's release group — at the rule, the term policy and the
// routes.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-08; the requests are recorded
// in src/routes/scryfall-compat/set-groups.ts and beside GROUP_KEYWORDS in
// src/routes/scryfall-compat/query-terms.ts. The answers themselves — printings, from real card
// objects through the whole store pipeline — are pinned in engine/builder/tests/set_groups.rs.
//
// The catalog is tests/fixtures/set-groups-catalog.json: rows of that day's `/sets`. Families are
// found in it by NAME; the codes below are what that catalog said, recorded as expectations.

import { afterAll, beforeAll, describe, expect, type Mock, setSystemTime, spyOn, test } from "bun:test";
import { encodeCountedArray, renderSets, setsListKey } from "../../src/engine/reference-kv";
import { canonicalStringify, EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import type { FilterValue } from "../../src/parser/nodes";
import {
	type KeywordTables,
	scryfallTermPolicy,
	scryfallTermPolicyFor,
	scryfallTermPolicyWithSets,
} from "../../src/routes/scryfall-compat/query-terms";
import { NO_SET_GROUPS, type SetGroups, setGroupsOf } from "../../src/routes/scryfall-compat/set-groups";
import recorded from "../fixtures/set-groups-catalog.json";
import { FakeEngine, FakeKV, json, makeCtx, testDispatch } from "./harness";

interface CatalogSet {
	code: string;
	name: string;
	parent_set_code?: string;
	card_count: number;
}

const CATALOG = recorded.sets as CatalogSet[];
const GROUPS = setGroupsOf(CATALOG) as SetGroups;

const ignored = (echo: string, reason: string) => `Invalid expression “${echo}” was ignored. ${reason}`;

/** The set the catalog lists under exactly this name. */
function named(name: string): string {
	const hits = CATALOG.filter((set) => set.name === name);
	expect(hits.length).toBe(1);
	return (hits[0] as CatalogSet).code;
}

const childrenOf = (code: string) => CATALOG.filter((set) => set.parent_set_code === code).map((set) => set.code);
const parentOf = (code: string) => CATALOG.find((set) => set.code === code)?.parent_set_code;

/** The whole group — the named set with the others — sorted. */
const group = (code: string) => [code, ...(GROUPS.others(code) as string[])].sort();

/** `(e:a or e:b …)`, the list a group is written as. */
const list = (codes: readonly string[]) => `(${codes.map((code) => `e:${code}`).join(" or ")})`;

const policyFor = (query: string) => scryfallTermPolicyWithSets(query, async () => GROUPS);

function wire(query: string): string {
	return canonicalStringify(parseScryfallQueryWithDirectives(query, EMPTY_TAG_ALIASES).tree as FilterValue);
}

const ECC = "(e:aecl or e:ecc or e:ecl or e:pecl or e:tecc or e:tecl or e:yecl)";
const ECL = "(e:aecl or e:ecc or e:ecl or e:pecl or e:tecl or e:yecl)";

describe("a release group is one step each way from the set that is named", () => {
	const eclipsed = named("Lorwyn Eclipsed");
	const finalFantasy = named("Final Fantasy");
	const hobbit = named("The Hobbit");

	test("the families are the ones the catalog names", () => {
		expect([eclipsed, finalFantasy, hobbit]).toEqual(["ecl", "fin", "hob"]);
		expect(childrenOf(eclipsed).sort()).toEqual(["aecl", "ecc", "pecl", "tecl", "yecl"]);
		expect(childrenOf("ecc")).toEqual(["tecc"]);
		expect(childrenOf(finalFantasy).sort()).toEqual(["afin", "fca", "fic", "pfin", "pss5", "rfin", "tfin", "wfin"]);
		expect(childrenOf("fic").sort()).toEqual(["afic", "tfic"]);
		expect(childrenOf(hobbit).sort()).toEqual(["hoc", "thob"]);
	});

	test("a root is itself and its children — never a grandchild", () => {
		// g:ecl is 764 where the whole family is 777: tecc, a child of ecc, is not in it.
		expect(group(eclipsed)).toEqual(["aecl", "ecc", "ecl", "pecl", "tecl", "yecl"]);
		// g:fin is 1,335 where the family is 1,370: neither of fic's children.
		expect(group(finalFantasy)).toEqual(["afin", "fca", "fic", "fin", "pfin", "pss5", "rfin", "tfin", "wfin"]);
		expect(group(finalFantasy)).not.toContain("afic");
		expect(group(finalFantasy)).not.toContain("tfic");
		// A root whose children have none is its whole family: g:hob = g:hoc = g:thob = 494.
		expect(group(hobbit)).toEqual(["hob", "hoc", "thob"]);
		// g:otj is 1,154 of the family's 1,237.
		expect(group("otj")).toEqual(["aotj", "big", "otc", "otj", "otp", "potj", "totj", "yotj"]);
	});

	test("a child is itself, its parent, its parent's other children — and its own children", () => {
		// g:ecc is the 777: the one member of its family whose group is all of it.
		expect(group("ecc")).toEqual(["aecl", "ecc", "ecl", "pecl", "tecc", "tecl", "yecl"]);
		// g:fic is the 1,370.
		expect(group("fic")).toEqual([...group(finalFantasy), "afic", "tfic"].sort());
		// g:big is 1,191: its own two children, and neither of its siblings' (totc, totp).
		expect(group("big")).toEqual(["aotj", "big", "otc", "otj", "otp", "pbig", "potj", "tbig", "totj", "yotj"]);
	});

	test("siblings share the parent's group, and a sibling's child is no sibling", () => {
		// g:tecl = g:aecl = g:yecl = g:pecl = g:ecl, 764 each.
		for (const sibling of ["tecl", "aecl", "yecl", "pecl"]) expect(group(sibling)).toEqual(group(eclipsed));
		for (const sibling of ["tfin", "fca", "afin", "pfin", "rfin", "wfin", "pss5"]) {
			expect(group(sibling)).toEqual(group(finalFantasy));
		}
		for (const sibling of ["hoc", "thob"]) expect(group(sibling)).toEqual(group(hobbit));
		expect(group("tecl")).not.toContain("tecc");
	});

	test("a grandchild is itself, its parent and its siblings — never its grandparent or a cousin", () => {
		// g:tecc is 189 = ecc + tecc.
		expect(group("tecc")).toEqual(["ecc", "tecc"]);
		// g:afic = g:tfic = 521 = fic + afic + tfic.
		expect(group("afic")).toEqual(["afic", "fic", "tfic"]);
		expect(group("tfic")).toEqual(group("afic"));
		// g:pbig = g:tbig = 132; g:totc 383. Thunder Junction has three such branches.
		expect(group("pbig")).toEqual(["big", "pbig", "tbig"]);
		expect(group("totc")).toEqual(["otc", "totc"]);
		expect(group("totp")).toEqual(["otp", "totp"]);
	});

	test("a set with no parent and no child is alone, and no other group holds it", () => {
		// g:lea 295, g:mir 351, g:7ed 708 — each its own `e:` count.
		for (const alone of [named("Limited Edition Alpha"), named("Mirage"), named("Seventh Edition")]) {
			expect(GROUPS.others(alone)).toEqual([]);
			for (const set of CATALOG) if (set.code !== alone) expect(group(set.code)).not.toContain(alone);
		}
	});

	test("no group reaches another family", () => {
		const rootOf = (code: string): string => {
			const parent = parentOf(code);
			return parent === undefined ? code : rootOf(parent);
		};
		for (const set of CATALOG) {
			for (const member of group(set.code)) expect([set.code, rootOf(member)]).toEqual([set.code, rootOf(set.code)]);
		}
	});

	test("a code the catalog does not list has no group", () => {
		for (const unknown of ["zzzz", "ec", "ECC", " ecc ", "e.c.c", "ecc,hob", ""])
			expect(GROUPS.others(unknown)).toBeNull();
	});

	test("a set with no cards is in the catalog, so it has a group", () => {
		// g:yfra, an Alchemy set with no cards yet, is its parent's 672; g:nau = g:tnau = 1.
		expect(CATALOG.find((set) => set.code === "yfra")?.card_count).toBe(0);
		expect(group("yfra")).toEqual(group(named("Reality Fracture")));
		expect(CATALOG.find((set) => set.code === "nau")?.card_count).toBe(0);
		expect(group("tnau")).toEqual(["nau", "tnau"]);
	});

	test("every set of the catalog follows the one rule", () => {
		for (const { code } of CATALOG) {
			const parent = parentOf(code);
			const expected = new Set([code, ...childrenOf(code)]);
			if (parent !== undefined) for (const member of [parent, ...childrenOf(parent)]) expected.add(member);
			expect([code, group(code)]).toEqual([code, [...expected].sort()]);
		}
	});
});

describe("on a catalog deeper than Scryfall's", () => {
	// The live catalog holds no set below a grandchild (48 of them, 0 beneath), so the step rule
	// is pinned at the depths it could not be measured on a catalog made up for it.
	const deep = setGroupsOf([
		{ code: "aaa" },
		{ code: "bbb", parent_set_code: "aaa" },
		{ code: "bb2", parent_set_code: "aaa" },
		{ code: "ccc", parent_set_code: "bbb" },
		{ code: "cc2", parent_set_code: "bbb" },
		{ code: "ddd", parent_set_code: "ccc" },
		{ code: "orph", parent_set_code: "gone" },
		{ code: "ORP2", parent_set_code: "GONE" },
		{ code: "self", parent_set_code: "self" },
	]) as SetGroups;

	test("it is still one step: children, parent, parent's children", () => {
		expect(deep.others("aaa")).toEqual(["bb2", "bbb"]);
		expect(deep.others("bbb")).toEqual(["aaa", "bb2", "cc2", "ccc"]);
		expect(deep.others("ccc")).toEqual(["bbb", "cc2", "ddd"]);
		expect(deep.others("ddd")).toEqual(["ccc"]);
		expect(deep.others("bb2")).toEqual(["aaa", "bbb"]);
	});

	test("a parent the catalog does not list is still the parent, codes fold case, and a set is not its own other", () => {
		expect(deep.others("orph")).toEqual(["gone", "orp2"]);
		expect(deep.others("orp2")).toEqual(["gone", "orph"]);
		expect(deep.others("gone")).toBeNull();
		expect(deep.others("self")).toEqual([]);
	});

	test("a row that is not a set, or a code that is not shaped like one, is skipped", () => {
		// These strings are written into the query the parser reads.
		const hostile = setGroupsOf([
			null,
			7,
			"ecl",
			{ name: "no code" },
			{ code: "x) or t:goblin (e:y" },
			{ code: "toolongcode" },
			{ code: "ok1" },
			{ code: "ok2", parent_set_code: "ok1" },
			{ code: "ok3", parent_set_code: 'ok1" or t:goblin' },
		]) as SetGroups;
		expect(hostile.others("ok1")).toEqual(["ok2"]);
		expect(hostile.others("ok3")).toEqual([]);
		expect(hostile.others("x) or t:goblin (e:y")).toBeNull();
	});

	test("a value that is no catalog cannot say", () => {
		for (const nothing of [null, undefined, {}, "[]", 3, [], [{ name: "no code" }]])
			expect(setGroupsOf(nothing)).toBeNull();
		expect(NO_SET_GROUPS.others("ecc")).toBeNull();
	});
});

describe("g: and group: are the sets of a release group", () => {
	// g:ecc = group:ecc = g=ecc = group=ecc = G:ecc = GROUP:ECC = g:"ecc" = g:'ecc' = 777.
	test.each(["g:ecc", "group:ecc", "g=ecc", "group=ecc", "G:ecc", "GROUP:ECC", "g:ECC", 'g:"ecc"', "g:'ecc'"])(
		"%s",
		async (term) => {
			const policy = await policyFor(`${term} t:goblin`);
			expect([policy.query, policy.warnings, policy.include.extras, policy.asksSets]).toEqual([
				`${ECC} t:goblin`,
				[],
				true,
				undefined,
			]);
		},
	);

	test("it is the tree the spelled-out sets write", async () => {
		expect(wire((await policyFor("g:ecc")).query)).toBe(wire(ECC));
		expect(wire((await policyFor("group:tecc t:elemental")).query)).toBe(wire("(e:ecc or e:tecc) t:elemental"));
		expect(wire((await policyFor("g:ecl")).query)).toBe(wire(ECL));
		expect(wire((await policyFor("g:hob")).query)).toBe(wire("(e:hob or e:hoc or e:thob)"));
		expect(wire((await policyFor("g:lea")).query)).toBe(wire("e:lea"));
		for (const { code } of CATALOG) expect((await policyFor(`g:${code}`)).query).toBe(list(group(code)));
	});

	// g:"Lorwyn Eclipsed Commander" = g:lorwyneclipsedcommander = 777, g:"lorwyn eclipsed" 764,
	// g:lorwyn 315 (lrw, plrw, tlrw), g:dar 414 (Dominaria by its retired code), g:alpha 295.
	test.each([
		['g:"Lorwyn Eclipsed Commander"', ECC],
		["g:lorwyneclipsedcommander", ECC],
		['group:"lorwyn eclipsed"', ECL],
		["g:lorwyn", "(e:lrw or e:plrw or e:tlrw)"],
		["g:dar", "(e:dom or e:pdom or e:tdom)"],
		["g:alpha", "(e:lea)"],
		['g:"final fantasy commander"', list(group("fic"))],
		['g:"the hobbit"', "(e:hob or e:hoc or e:thob)"],
		// A token set's name is its set: g:"lorwyn eclipsed tokens" is g:tecl's 764, and
		// g:"Lorwyn Eclipsed Commander Tokens" g:tecc's 189.
		['g:"lorwyn eclipsed tokens"', ECL],
		["group:lorwyneclipsedtokens", ECL],
		['g:"Lorwyn Eclipsed Commander Tokens"', "(e:ecc or e:tecc)"],
		['g:"the hobbit tokens"', "(e:hob or e:hoc or e:thob)"],
	])("the value is read as e: reads one: %s", async (term, expected) => {
		const policy = await policyFor(term);
		expect([term, policy.query, policy.warnings]).toEqual([term, expected, []]);
	});

	test("a value that names no set is honored and matches nothing", async () => {
		// g:zzzz, g:ec, g:" ecc ", g:e.c.c and g:ecc,hob are each a 404 with no warnings key, and
		// g:zzzz or e:lea is e:lea's 295. So is a name Scryfall itself answers nothing to:
		// g:"kaldheim tokens" and g:"shadows of the past" are 404s there (2026-10-08).
		for (const term of [
			"g:zzzz",
			"group:zzzz",
			"g:ec",
			'g:" ecc "',
			"g:e.c.c",
			"g:ecc,hob",
			'g:"kaldheim tokens"',
			'g:"shadows of the past"',
		]) {
			const policy = await policyFor(`${term} t:goblin`);
			expect([term, policy.query, policy.warnings, policy.include.extras]).toEqual([term, "cmc<0 t:goblin", [], true]);
		}
		expect((await policyFor("g:zzzz or e:lea")).query).toBe("cmc<0 or e:lea");
		expect((await policyFor("g:ecc g:zzzz")).query).toBe(`${ECC} cmc<0`);
	});

	test("composed with other terms it is a group like any other", async () => {
		// g:ecc g:tecc is 189, g:ecc or g:hob 1,271, g:ecc g:hob a 404, (g:tecc or g:lea) 484.
		expect((await policyFor("g:ecc g:tecc")).query).toBe(`${ECC} (e:ecc or e:tecc)`);
		expect((await policyFor("g:ecc or g:hob")).query).toBe(`${ECC} or (e:hob or e:hoc or e:thob)`);
		expect((await policyFor("(g:tecc or g:lea) t:elf")).query).toBe("((e:ecc or e:tecc) or (e:lea)) t:elf");
		expect((await policyFor("t:creature g:ecc or e:lea")).query).toBe(`t:creature ${ECC} or e:lea`);
		for (const q of ["g:ecc g:tecc", "(g:tecc or g:lea) t:elf", "-g:ecc (g:ecc or -g:hob) -(g:fin or g:zzzz)"]) {
			const { query } = await policyFor(q);
			expect(() => parseScryfallQueryWithDirectives(query, EMPTY_TAG_ALIASES)).not.toThrow();
		}
	});
});

describe("negated", () => {
	test("on the term, the named set stays and the rest of its group goes", async () => {
		// -g:ecc is 117,902 = -(e:aecl or e:ecl or e:pecl or e:tecc or e:tecl or e:yecl), where the
		// complement is 117,726; -g:ecc e:ecc is all 176 of ecc and -g:ecc e:ecl a 404.
		const others = "-(e:aecl or e:ecl or e:pecl or e:tecc or e:tecl or e:yecl)";
		for (const term of ["-g:ecc", "-group:ecc", "-g=ecc", "-G:ECC", '-g:"Lorwyn Eclipsed Commander"']) {
			const policy = await policyFor(`${term} e:ecc`);
			expect([term, policy.query, policy.warnings, policy.include.extras]).toEqual([term, `${others} e:ecc`, [], true]);
		}
		// -g:tecc e:tecc is 13 and -g:tecc e:ecc a 404; -g:ecl e:ecl 408 and -g:ecl e:tecc 13.
		expect((await policyFor("-g:tecc")).query).toBe("-(e:ecc)");
		expect((await policyFor("-g:ecl")).query).toBe("-(e:aecl or e:ecc or e:pecl or e:tecl or e:yecl)");
		// -g:hoc e:hoc is 158; -g:hoc e:hob and e:thob are 404s. -g:dar e:dom is 280.
		expect((await policyFor("-g:hoc")).query).toBe("-(e:hob or e:thob)");
		expect((await policyFor("-g:dar")).query).toBe("-(e:pdom or e:tdom)");
	});

	test("a set alone in its group, or a code that names none, excludes nothing", async () => {
		// -g:lea = -g:zzzz = 118,503: everything, with extras on.
		for (const term of ["-g:lea", "-g:alpha", "-g:zzzz", "-group:mir"]) {
			const policy = await policyFor(`${term} t:goblin`);
			expect([term, policy.query, policy.include.extras]).toEqual([term, "-cmc<0 t:goblin", true]);
		}
	});

	test("on a group around it, it is the complement", async () => {
		// -(g:ecc) is 117,726 and -(g:ecc) e:ecc a 404; -(-g:ecc) e:ecl is 408 and e:ecc a 404;
		// (-g:ecc) e:ecc is the term's own 176.
		expect((await policyFor("-(g:ecc) e:ecc")).query).toBe(`-(${ECC}) e:ecc`);
		expect(wire((await policyFor("-(g:ecc)")).query)).toBe(wire(`-${ECC}`));
		expect((await policyFor("-(-g:ecc) e:ecl")).query).toBe(
			"-(-(e:aecl or e:ecl or e:pecl or e:tecc or e:tecl or e:yecl)) e:ecl",
		);
		expect((await policyFor("(-g:ecc) e:ecc")).query).toBe(
			"(-(e:aecl or e:ecl or e:pecl or e:tecc or e:tecl or e:yecl)) e:ecc",
		);
	});
});

describe("what Scryfall ignores, and what it honors as nothing", () => {
	test("a pattern and an empty value are ignored, each with its sentence and its minus", async () => {
		// g:/ecc/ e:lea is e:lea's 290 carrying `Unknown regular expression keyword “g”.`, and
		// g:"" e:lea the same 290 carrying `Unknown keyword “g”.`; both alone are the 400.
		const cases: [string, string][] = [
			["g:/ecc/", "Unknown regular expression keyword “g”."],
			["-g:/ecc/", "Unknown regular expression keyword “-g”."],
			["group:/x/", "Unknown regular expression keyword “group”."],
			["-group:/x/", "Unknown regular expression keyword “-group”."],
			['g:""', "Unknown keyword “g”."],
			['-g:""', "Unknown keyword “-g”."],
			['group:""', "Unknown keyword “group”."],
			['g=""', "Unknown keyword “g”."],
			["g:''", "Unknown keyword “g”."],
		];
		for (const [term, reason] of cases) {
			const beside = await policyFor(`${term} e:lea`);
			expect([term, beside.query, beside.warnings, beside.include.extras]).toEqual([
				term,
				"e:lea",
				[ignored(term, reason)],
				false,
			]);
			const alone = await policyFor(term);
			expect([term, alone.allIgnored, alone.warnings]).toEqual([term, true, [ignored(term, reason)]]);
		}
		// Spaces are a value: g:"  " e:lea is a 404, not an ignored term.
		expect((await policyFor('g:"  " e:lea')).query).toBe("cmc<0 e:lea");
	});

	test("under a comparison it matches nothing and opens nothing", async () => {
		// g>=ecc, g<=ecc and g!=ecc are 404s; g!=war or cmc=3 is cmc=3's 8,089, echoing
		// include_extras=false; -g>war or cmc=3 is not narrowed. (g>war and g<war are a NAME search
		// for `gwar` there — 11 cards — as e>war is one for `ewar`; nothing here.)
		for (const term of ["g>=ecc", "g<=ecc", "g!=ecc", "g>ecc", "g<ecc", "group>ecc", "group!=ecc"]) {
			const policy = await policyFor(`${term} or cmc=3`);
			expect([term, policy.query, policy.warnings, policy.include.extras]).toEqual([term, "cmc<0 or cmc=3", [], false]);
		}
		expect((await policyFor("-g>=ecc e:lea")).query).toBe("-cmc<0 e:lea");
	});

	test("a dangling operator is the bare word", async () => {
		// `g:` is 38,688 prints — every name holding a g — and `group:` the two cards named "Group …".
		expect((await policyFor("g:")).query).toBe("name:g");
		expect((await policyFor("group:")).query).toBe("name:group");
	});
});

describe("it opens extras, in either polarity, whatever the value names", () => {
	// Each echoes include_extras=true when sent with include_extras=false: g:lea, g:7ed, g:war,
	// g:twar, g:hob, g:ecc, g=war, group:war, g:"war of the spark", g:"limited edition alpha",
	// g:dar, g:zzzz (8,302 = extras-on cmc=3), -g:lea, -g:war, -g:7ed, -g:zzzz, -(g:war) `or cmc=3`.
	test.each([
		"g:lea",
		"g:7ed",
		"g:ecc",
		"g=ecc",
		"group:hob",
		'g:"limited edition alpha"',
		"g:dar",
		"g:zzzz",
		"-g:lea",
	])("%s or cmc=3", async (term) => {
		expect((await policyFor(`${term} or cmc=3`)).include.extras).toBe(true);
	});

	test("in a group and under a negated group too", async () => {
		expect((await policyFor("(g:ecc t:goblin) or cmc=3")).include.extras).toBe(true);
		expect((await policyFor("-(g:ecc) or cmc=3")).include.extras).toBe(true);
		expect((await policyFor("-g:zzzz or cmc=3")).include.extras).toBe(true);
	});

	test("...where e: does not: the same sets spelled out leave the gate to the sets", async () => {
		// e:7ed, e:war, e:hob, e:dom, e:dar and e:zzzz `or cmc=3` all echo include_extras=false.
		expect((await policyFor(`${ECC} or cmc=3`)).include.extras).toBe(false);
		expect((await policyFor("e:hob or cmc=3")).include.extras).toBe(false);
	});
});

describe("e:, set:, s: and edition: are untouched", () => {
	const QUERIES = [
		"e:ecc",
		"set:ecl t:creature",
		"s:tecc or e:lea",
		"edition:hob",
		"-e:ecc e:ecl",
		"e:zendikar",
		'e:"the list" or e:plst',
		"e:dar",
		"e:zzzz",
		"e>ecc",
		"e:/ecc/ t:goblin",
		"block:ecl",
		"(e:aecl or e:ecc or e:ecl) -e:tecl",
		"date>=ecl",
		"o:group o:g t:goblin",
		"!g !group",
	];

	test("the policy answers them exactly as it does with no catalog, and never asks for one", async () => {
		let asked = 0;
		const reader = async () => {
			asked++;
			return GROUPS;
		};
		for (const query of QUERIES) {
			const plain = scryfallTermPolicy(query);
			expect(plain.asksSets).toBeUndefined();
			expect(await scryfallTermPolicyWithSets(query, reader)).toEqual(plain);
			expect(scryfallTermPolicy(query, { setGroups: GROUPS })).toEqual(plain);
		}
		expect(asked).toBe(0);
	});
});

describe("the catalog is read only when a g: term needs it", () => {
	function tables(groups: SetGroups | null = GROUPS) {
		const asked = { carried: 0, catalogs: 0, sets: 0 };
		const source: KeywordTables = {
			carried: async () => {
				asked.carried++;
				return { Flying: 3990 };
			},
			catalogs: async () => {
				asked.catalogs++;
				return ["Flying", "Absorb"];
			},
			setGroups: async () => {
				asked.sets++;
				return groups;
			},
		};
		return { asked, source };
	}

	test("the plain policy leaves the term as written and says what it is waiting on", () => {
		const policy = scryfallTermPolicy("g:ecc t:goblin");
		expect([policy.query, policy.asksSets, policy.include.extras]).toEqual(["g:ecc t:goblin", true, true]);
		expect(scryfallTermPolicy("-group:ecc").asksSets).toBe(true);
		expect(scryfallTermPolicy("(t:elf or (g:ecc))").asksSets).toBe(true);
		// A term answered without the catalog asks nothing.
		for (const query of ["g>ecc", "g:/ecc/ e:lea", 'g:"" e:lea', "g:", "t:goblin"]) {
			expect(scryfallTermPolicy(query).asksSets).toBeUndefined();
		}
	});

	test("one read a query, however many terms, and none without the term", async () => {
		const many = tables();
		const policy = await scryfallTermPolicyFor("g:ecc or g:hob or -group:fin", many.source);
		expect(policy.asksSets).toBeUndefined();
		expect(many.asked).toEqual({ carried: 0, catalogs: 0, sets: 1 });
		const none = tables();
		await scryfallTermPolicyFor("e:ecc t:goblin o:group", none.source);
		expect(none.asked).toEqual({ carried: 0, catalogs: 0, sets: 0 });
	});

	test("beside keyword: both are read, each once, and both are answered", async () => {
		const both = tables();
		const policy = await scryfallTermPolicyFor("g:tecc keyword:flying keyword:nonsense", both.source);
		expect([policy.query, policy.warnings, policy.include.extras]).toEqual([
			"(e:ecc or e:tecc) keyword:flying",
			[ignored("keyword:nonsense", "Unknown keyword “nonsense”")],
			true,
		]);
		expect(both.asked).toEqual({ carried: 1, catalogs: 1, sets: 1 });
	});

	test("a catalog that could not be read lists no set: the term matches nothing, and is never left for the parser", async () => {
		for (const source of [tables(null).source, { ...tables().source, setGroups: undefined }]) {
			const positive = await scryfallTermPolicyFor("g:ecc t:goblin", source);
			expect([positive.query, positive.warnings, positive.include.extras, positive.asksSets]).toEqual([
				"cmc<0 t:goblin",
				[],
				true,
				undefined,
			]);
			expect((await scryfallTermPolicyFor("-g:ecc t:goblin", source)).query).toBe("-cmc<0 t:goblin");
		}
		expect((await scryfallTermPolicyWithSets("g:ecc", undefined)).query).toBe("cmc<0");
		expect((await scryfallTermPolicyWithSets("g:ecc", async () => null)).query).toBe("cmc<0");
	});
});

describe("through the routes, against the mirrored set catalog", () => {
	// An unreadable catalog is reported (reference-routes.ts), and several tests here make one.
	let errors: Mock<typeof console.error>;
	beforeAll(() => {
		errors = spyOn(console, "error").mockImplementation(() => {});
	});
	afterAll(() => errors.mockRestore());

	/** STORE_KV holding `/sets` as the import publishes it: the BARE `data` array (reference-kv.ts). */
	const published = (sets: readonly object[] = CATALOG) => {
		const kv = new FakeKV();
		kv.put(
			setsListKey(),
			renderSets(
				sets as Record<string, unknown>[],
				sets.map((set) => JSON.stringify(set)),
			).list,
		);
		return kv;
	};

	/** The tree `/cards/search` hands the engine for a query. */
	async function searched(query: string, kv: FakeKV | undefined, extra = ""): Promise<string> {
		const engine = new FakeEngine();
		const res = await testDispatch(makeCtx({ engine, kv }), `/cards/search?q=${encodeURIComponent(query)}${extra}`);
		expect(res.status).toBe(200);
		return engine.lastSearch?.filterTreeJson ?? "";
	}

	test("g: searches the sets of the group, with extras open", async () => {
		const kv = published();
		// The same tree as the sets spelled out with include_extras=true — and not the one they
		// write by default, which carries the `-is:extra` conjunct.
		expect(await searched("g:ecc", kv)).toBe(await searched(ECC, kv, "&include_extras=true"));
		expect(await searched("g:ecc", kv)).not.toBe(await searched(ECC, kv));
		expect(await searched("g:ecc", kv)).not.toContain('"extra"');
		expect(await searched("group:tecc t:elemental", kv)).toBe(
			await searched("(e:ecc or e:tecc) t:elemental", kv, "&include_extras=true"),
		);
		expect(await searched("-g:ecc e:ecc", kv)).toBe(
			await searched("-(e:aecl or e:ecl or e:pecl or e:tecc or e:tecl or e:yecl) e:ecc", kv, "&include_extras=true"),
		);
		expect(await searched("-(g:ecc) t:elf", kv)).toBe(await searched(`-${ECC} t:elf`, kv, "&include_extras=true"));
	});

	test("an explicit include_extras=false is overridden, in the rows and in the echo", async () => {
		// g:hob&include_extras=false&unique=prints is 494 with next_page echoing include_extras=true;
		// e:hob echoes false.
		const page = async (query: string) => {
			const engine = new FakeEngine();
			engine.totalCards = 500;
			const res = await testDispatch(
				makeCtx({ engine, kv: published() }),
				`/cards/search?q=${encodeURIComponent(query)}&include_extras=false`,
			);
			return new URL(String((await json(res)).next_page)).searchParams;
		};
		expect((await page("g:hob")).get("include_extras")).toBe("true");
		expect((await page("-group:hob")).get("include_extras")).toBe("true");
		expect((await page("g:zzzz or t:goblin")).get("include_extras")).toBe("true");
		expect((await page("e:hob")).get("include_extras")).toBe("false");
		// The echoed query is the one that was asked, not the sets it became.
		expect((await page("G:Hob")).get("q")).toBe("g:hob");
	});

	test("an unknown code is the term that matches nothing, and its negation the one that matches all", async () => {
		const kv = published();
		expect(await searched("g:zzzz", kv)).toBe(await searched("cmc<0", kv, "&include_extras=true"));
		expect(await searched("-g:zzzz t:goblin", kv)).toBe(await searched("-cmc<0 t:goblin", kv, "&include_extras=true"));
		expect(await searched("-g:lea t:goblin", kv)).toBe(await searched("-cmc<0 t:goblin", kv, "&include_extras=true"));
	});

	test("an ignored term is Scryfall's 400 alone and a warning beside other terms", async () => {
		const kv = published();
		const alone = await testDispatch(makeCtx({ kv }), `/cards/search?q=${encodeURIComponent('g:""')}`);
		expect(alone.status).toBe(400);
		expect(await json(alone)).toMatchObject({
			details: "All of your terms were ignored.",
			warnings: [ignored('g:""', "Unknown keyword “g”.")],
		});
		const beside = await testDispatch(makeCtx({ kv }), `/cards/search?q=${encodeURIComponent("-g:/ecc/ t:goblin")}`);
		expect((await json(beside)).warnings).toEqual([ignored("-g:/ecc/", "Unknown regular expression keyword “-g”.")]);
		// Neither read the catalog.
		expect(kv.reads).toEqual([]);
	});

	test("the catalog is read once an isolate, and never for a query without the term", async () => {
		const kv = published();
		await searched("e:ecc t:goblin", kv);
		await searched(ECC, kv);
		expect(kv.reads).toEqual([]);
		await searched("g:ecc", kv);
		await searched("group:hob or g:fin", kv);
		await searched("-g:tecc", kv);
		expect(kv.reads).toEqual([setsListKey()]);
	});

	test("after an hour the catalog is read again, and a set it gained is in its group", async () => {
		const kv = published();
		const start = Date.now();
		try {
			expect(await searched("g:hob", kv)).toBe(
				await searched("(e:hob or e:hoc or e:thob)", kv, "&include_extras=true"),
			);
			// The night's import adds a promo set to the family.
			kv.put(
				setsListKey(),
				renderSets(
					[...CATALOG, { id: "x", code: "phob", parent_set_code: "hob" }] as Record<string, unknown>[],
					[...CATALOG, { id: "x", code: "phob", parent_set_code: "hob" }].map((set) => JSON.stringify(set)),
				).list,
			);
			setSystemTime(new Date(start + 59 * 60_000));
			expect(await searched("g:hob", kv)).toBe(
				await searched("(e:hob or e:hoc or e:thob)", kv, "&include_extras=true"),
			);
			setSystemTime(new Date(start + 61 * 60_000));
			expect(await searched("g:hob", kv)).toBe(
				await searched("(e:hob or e:hoc or e:phob or e:thob)", kv, "&include_extras=true"),
			);
			expect(kv.reads).toEqual([setsListKey(), setsListKey()]);
		} finally {
			setSystemTime();
		}
	});

	test("an unpublished, unreadable or absent catalog answers as an unknown code does", async () => {
		const never = await searched("cmc<0", published(), "&include_extras=true");
		const always = await searched("-cmc<0", published(), "&include_extras=true");
		const failing = published();
		failing.failOn.add(setsListKey());
		const notJson = new FakeKV();
		notJson.put(setsListKey(), "SLCA02 not json");
		const notAList = new FakeKV();
		notAList.put(setsListKey(), '{"object":"list","data":[]}');
		const empty = new FakeKV();
		empty.put(setsListKey(), "[]");
		// The sets list is NOT a counted array: one stored that way cannot be read, and says so.
		const counted = new FakeKV();
		counted.put(setsListKey(), encodeCountedArray(JSON.stringify(CATALOG), CATALOG.length));
		for (const kv of [new FakeKV(), failing, notJson, notAList, empty, counted, undefined]) {
			expect(await searched("g:ecc", kv)).toBe(never);
			expect(await searched("-g:ecc", kv)).toBe(always);
			// ...and `e:` is answered all the same.
			expect(await searched("e:ecc", kv)).toContain('"ecc"');
		}
	});

	test("a catalog that could not be read is asked for again, and answers once it can be", async () => {
		const kv = published();
		kv.failOn.add(setsListKey());
		expect(await searched("g:tecc", kv)).toBe(await searched("cmc<0", kv, "&include_extras=true"));
		kv.failOn.clear();
		expect(await searched("g:tecc", kv)).toBe(await searched("(e:ecc or e:tecc)", kv, "&include_extras=true"));
	});

	test("/cards/random draws from the group", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine, kv: published() }), "/cards/random?q=g%3Atecc");
		const tree = engine.lastSampleArgs?.filterTreeJson ?? "";
		expect(tree).toContain('"ecc"');
		expect(tree).toContain('"tecc"');
		expect(tree).not.toContain('"extra"');
		expect(tree).not.toContain('"ecl"');
	});

	test("/cards/collection reads no `g:` — a `?q=` there is ignored, catalog and all", async () => {
		// The collection's `?q=` was this port's own (a batch-wide scope, removed 2026-10-08) and the
		// one place outside search and random that read the `/sets` catalog for a group. Scryfall
		// ignores a `q` on a collection, so nothing is parsed, nothing is read and nothing is scoped.
		const sent = async (query: string | null, kv: FakeKV | undefined) => {
			const engine = new FakeEngine();
			const tail = query === null ? "" : `?q=${encodeURIComponent(query)}`;
			const url = `https://sylvan-librarian.com/cards/collection${tail}`;
			const request = new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ identifiers: [{ name: "Llanowar Elves" }] }),
			});
			const res = await testDispatch(makeCtx({ engine, kv, request }), url, "POST");
			return { status: res.status, body: await res.text(), extra: engine.collectionExtraArgs };
		};
		const bare = await sent(null, published());
		expect([bare.status, bare.extra]).toEqual([200, [[]]]);
		for (const query of ["g:ecc", "-group:tecc prefer:oldest", "e:ecc"]) {
			const kv = published();
			expect({ query, ...(await sent(query, kv)) }).toEqual({ query, ...bare });
			expect(kv.reads).toEqual([]);
		}
		// And with no catalog to read at all.
		expect(await sent("g:ecc", undefined)).toEqual(bare);
	});
});
