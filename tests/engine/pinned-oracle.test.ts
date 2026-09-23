// pinned-oracle.ts: which wire trees pin a query to one partition. The trees here are the REAL
// ones — parsed and gated exactly as /cards/search does — because the walker reads the engine's
// wire shape (`node_type`/`kwargs`), and a hand-written fixture could drift from it silently.

import { describe, expect, test } from "bun:test";
import { pinnedOracleId } from "../../src/engine/pinned-oracle";
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
