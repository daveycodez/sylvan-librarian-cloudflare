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
