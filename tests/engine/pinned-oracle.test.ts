// pinned-oracle.ts: which wire trees pin a query to one partition. The trees here are the REAL
// ones — parsed and gated exactly as /cards/search does — because the walker reads the engine's
// wire shape (`node_type`/`kwargs`), and a hand-written fixture could drift from it silently.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedExactName, pinnedOracleId } from "../../src/engine/pinned-oracle";
import { canonicalStringify, EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import type { FilterValue } from "../../src/parser/nodes";
import { applyExtrasGate } from "../../src/routes/extras-gate";

const ID = "aa686c34-cf28-4d4a-bcef-5a34cccdbf87";

async function wire(q: string, gate = true): Promise<string> {
	const parsed = parseScryfallQueryWithDirectives(q, EMPTY_TAG_ALIASES);
	if (!gate) return canonicalStringify(parsed.tree as FilterValue);
	const gated = await applyExtrasGate(
		{ setsWithExtras: async () => [] } as never,
		parsed.tree,
		{ loweredRegexTerms: parsed.loweredRegexTerms, expandedDerivedTerms: parsed.expandedDerivedTerms },
		{},
	);
	return canonicalStringify(gated.tree as FilterValue);
}

describe("a query pins one partition when", () => {
	test("it is the bare oracleid: lookup mtgseeker sends", async () => {
		expect(pinnedOracleId(await wire(`oracleid:${ID}`, false))).toBe(ID);
	});

	test("the extras gate has wrapped it in NOT is:extra / is:variation conjuncts", async () => {
		expect(pinnedOracleId(await wire(`oracleid:${ID} unique:prints`))).toBe(ID);
	});

	test("the id is one conjunct among others, spelled oracle_id or in upper case", async () => {
		expect(pinnedOracleId(await wire(`t:goblin oracle_id:${ID.toUpperCase()} c:r`))).toBe(ID);
	});

	test("the operator is = rather than :", async () => {
		expect(pinnedOracleId(await wire(`oracleid=${ID}`))).toBe(ID);
	});
});

describe("the owning object's pin check (source pin: the DO cannot load outside workerd)", () => {
	test("accepts the bare count and the previous build's layout pin, on both transports", () => {
		const src = readFileSync(join(import.meta.dir, "../../src/engine/search-engine-do.ts"), "utf8");
		const check = src.slice(src.indexOf("private assertPinnedModulus("), src.indexOf("async searchCardsAsJson("));
		expect(check).toContain('typeof pin === "number"');
		expect(check).toContain('String(pin.layout ?? "").split("|")[0]');
		expect(src).toContain("this.assertPinnedModulus(body.pinnedPartitionCount ?? body.pinned)");
	});
});

describe("Doubling Cube: an id with a zero-led all-digit piece (real JSON, the 2026-08-16 bulk)", () => {
	// `oracleid:9afd8f12-0796-4500-aaa3-10b4a46ef6ec` lexes WORD MINUS NUMBER …, and the parser glued
	// the NUMBER `0796` back as 796. The tree then named no UUID, so the search did not pin
	// (production's `pin=0 … status=404`, ~122 a day), gathered all N partitions for an id no card
	// has, and answered 404 where api.scryfall.com answers these four printings — every
	// "Prints" strip for Doubling Cube on mtgseeker came back empty. 720 of the corpus's 38,626
	// oracle ids have such a piece.
	const PRINTS = [
		"doubling_cube_10e_321",
		"doubling_cube_5dn_116",
		"doubling_cube_plst_10e_321",
		"doubling_cube_sld_1080",
	];
	const cards = PRINTS.map(
		(name) =>
			JSON.parse(readFileSync(join(import.meta.dir, `../../engine/builder/src/fixtures/${name}.json`), "utf8")) as {
				oracle_id?: string;
				layout: string;
				card_faces?: { oracle_id?: string }[];
			},
	);
	const DOUBLING_CUBE = "9afd8f12-0796-4500-aaa3-10b4a46ef6ec";

	test("all four printings carry the one oracle id — the reversible sld/1080 only on its faces", () => {
		for (const card of cards) {
			expect(card.oracle_id ?? card.card_faces?.[0]?.oracle_id).toBe(DOUBLING_CUBE);
		}
		const reversible = cards.filter((c) => c.oracle_id === undefined);
		expect(reversible.map((c) => c.layout)).toEqual(["reversible_card"]);
	});

	test("the search pins that id, and so asks the one partition that owns all four", async () => {
		expect(pinnedOracleId(await wire(`oracleid:${DOUBLING_CUBE}`, false))).toBe(DOUBLING_CUBE);
		expect(pinnedOracleId(await wire(`oracleid:${DOUBLING_CUBE} unique:prints`))).toBe(DOUBLING_CUBE);
		expect(pinnedOracleId(await wire(`oracleid:${DOUBLING_CUBE.toUpperCase()}`))).toBe(DOUBLING_CUBE);
	});

	test("the id reaches the engine spelled as sent, zeros and all", async () => {
		expect(await wire(`oracleid:${DOUBLING_CUBE}`, false)).toContain(`"value":"${DOUBLING_CUBE}"`);
		// A leading all-digit piece, and one that is all zeros.
		const led = "00037840-6089-42ec-8c5c-281f9f474504";
		expect(pinnedOracleId(await wire(`oracleid:${led}`))).toBe(led);
		const zeros = "aa686c34-cf28-4d4a-0000-5a34cccdbf87";
		expect(pinnedOracleId(await wire(`oracleid:${zeros}`))).toBe(zeros);
	});
});

describe("a query fans out when", () => {
	test("the id sits under an OR", async () => {
		expect(pinnedOracleId(await wire(`oracleid:${ID} or t:goblin`))).toBeNull();
	});

	test("the id is negated", async () => {
		expect(pinnedOracleId(await wire(`-oracleid:${ID}`))).toBeNull();
	});

	test("the value is not a uuid", async () => {
		expect(pinnedOracleId(await wire("oracleid:bolt"))).toBeNull();
	});

	test("there is no oracle id at all", async () => {
		expect(pinnedOracleId(await wire("t:goblin cmc=1"))).toBeNull();
	});

	test("the tree is not JSON", () => {
		expect(pinnedOracleId("not json")).toBeNull();
		expect(pinnedOracleId("")).toBeNull();
	});
});

describe('a `!"Name"` query names its one required name (backlog n6)', () => {
	test("the card page's search, through the extras gate, carries the collated name", async () => {
		expect(pinnedExactName(await wire('!"Lim-Dûl\'s Vault" unique:prints'))).toBe("limdulsvault");
		expect(pinnedExactName(await wire("!fire t:instant"))).toBe("fire");
	});

	test("an OR, a negation, or no exact name does not", async () => {
		expect(pinnedExactName(await wire('!"Opt" or t:goblin'))).toBeNull();
		expect(pinnedExactName(await wire('-!"Opt"'))).toBeNull();
		expect(pinnedExactName(await wire("t:goblin"))).toBeNull();
		expect(pinnedExactName("not json")).toBeNull();
	});
});
