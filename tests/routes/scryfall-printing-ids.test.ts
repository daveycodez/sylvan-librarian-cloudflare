// `scryfallid:` and `illustrationid:` — Scryfall's two printing-id keywords.
//
// Measured on api.scryfall.com 2026-10-03 (x66 R5, reported from mtg-seeker). The requests are
// recorded beside UUID_KEYWORDS in src/routes/scryfall-compat/query-terms.ts and beside the
// trigger in src/routes/extras-gate.ts.

import { describe, expect, test } from "bun:test";
import { pinnedOracleId, pinnedScryfallId } from "../../src/engine/pinned-oracle";
import { canonicalStringify, EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import type { FilterValue } from "../../src/parser/nodes";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

const RESET = "860aa0fe-0337-458c-b864-5ef5733fbae6";
const ART = "9e42d409-161d-4e63-8982-71e313f27b2f";
const UUID_REASON = "You must provide a valid v4 UUID.";
const ignored = (echo: string, reason: string) => `Invalid expression “${echo}” was ignored. ${reason}`;

async function gated(q: string, requested: { includeExtras?: boolean; includeVariations?: boolean } = {}) {
	const policy = scryfallTermPolicy(q);
	const parsed = parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES);
	const gate = await applyExtrasGate(
		{ setsWithExtras: async () => [] } as never,
		parsed.tree,
		{ loweredRegexTerms: parsed.loweredRegexTerms, expandedDerivedTerms: parsed.expandedDerivedTerms },
		requested,
	);
	return { ...gate, wire: canonicalStringify(gate.tree as FilterValue) };
}

describe("the keywords parse, under both spellings and both equality operators", () => {
	test.each([
		[`scryfallid:${RESET}`, "scryfall_id", ":"],
		[`scryfall_id:${RESET}`, "scryfall_id", ":"],
		[`scryfallid=${RESET}`, "scryfall_id", "="],
		[`SCRYFALLID:${RESET.toUpperCase()}`, "scryfall_id", ":"],
		[`scryfallid:"${RESET}"`, "scryfall_id", ":"],
		[`illustrationid:${ART}`, "illustration_id", ":"],
		[`illustration_id:${ART}`, "illustration_id", ":"],
		[`illustrationid=${ART}`, "illustration_id", "="],
	])("%s", (q, attribute, op) => {
		const policy = scryfallTermPolicy(q);
		expect(policy.warnings).toEqual([]);
		expect(policy.query).toBe(q);
		const tree = parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES).tree as unknown as {
			node_type: string;
			kwargs: { op: string; lhs: { kwargs: { attribute_name: string } }; rhs: { kwargs: { value: string } } };
		};
		expect(tree.node_type).toBe("CardBinaryOperatorNode");
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe(attribute);
		expect(tree.kwargs.op).toBe(op);
		expect(tree.kwargs.rhs.kwargs.value.toLowerCase()).toBe(attribute === "scryfall_id" ? RESET : ART);
	});
});

describe("a value that is not a v4 UUID is ignored with Scryfall's sentence", () => {
	test.each([
		["scryfallid:abc", "scryfallid:abc"],
		["illustrationid:abc", "illustrationid:abc"],
		["scryfall_id:abc", "scryfall_id:abc"],
		// The nil UUID and the unhyphenated form are not v4 either; the echo is cut at 20.
		["scryfallid:00000000-0000-0000-0000-000000000000", "scryfallid:00000000…"],
		["illustrationid:00000000-0000-0000-0000-000000000000", "illustrationid:0000…"],
		["scryfallid:860aa0fe0337458cb8645ef5733fbae6", "scryfallid:860aa0fe…"],
		["-scryfallid:abc", "-scryfallid:abc"],
		// The underscore spellings read a regex-shaped value as a value; the others as a regex.
		["scryfall_id:/860aa0fe/", "scryfall_id:/860aa0…"],
		["illustration_id:/9e42/", "illustration_id:/9e…"],
	])("%s", (term, echo) => {
		const result = scryfallTermPolicy(`${term} e:khm t:god`);
		expect(result.query).toBe("e:khm t:god");
		expect(result.warnings).toEqual([ignored(echo, UUID_REASON)]);
	});

	test("alone it is the 400's warning", () => {
		const result = scryfallTermPolicy("scryfallid:00000000-0000-0000-0000-000000000000");
		expect(result.allIgnored).toBe(true);
		expect(result.warnings).toEqual([ignored("scryfallid:00000000…", UUID_REASON)]);
	});

	test("a regex on the underscore-free spellings is the regex-keyword sentence", () => {
		expect(scryfallTermPolicy("scryfallid:/^860a/ e:khm").warnings).toEqual([
			ignored("scryfallid:/^860a/", "Unknown regular expression keyword “scryfallid”."),
		]);
	});

	test("a comparison is honored and matches nothing; a well-formed id no card has is kept", () => {
		expect(scryfallTermPolicy(`scryfallid!=${RESET} e:khm t:god`).query).toBe("cmc<0 e:khm t:god");
		expect(scryfallTermPolicy(`scryfallid>${RESET} e:khm t:god`).query).toBe("cmc<0 e:khm t:god");
		const unknown = "scryfallid:11111111-1111-4111-8111-111111111111";
		expect(scryfallTermPolicy(unknown).query).toBe(unknown);
	});
});

describe("the extras gate: a printing named by id is returned whatever class it is", () => {
	test("scryfallid: opens extras AND variations", async () => {
		const gate = await gated(`scryfallid:${RESET}`);
		expect(gate.includeExtras).toBe(true);
		expect(gate.includeVariations).toBe(true);
		expect(gate.wire).not.toContain("NotNode");
	});

	test("it overrides parameters that say false, in either polarity, and for an id no card has", async () => {
		for (const q of [
			`scryfallid:${RESET} or cmc=3`,
			`-scryfallid:${RESET} cmc=3`,
			"scryfallid:11111111-1111-4111-8111-111111111111 or cmc=3",
			`scryfallid=${RESET.toUpperCase()} or cmc=3`,
		]) {
			const gate = await gated(q, { includeExtras: false, includeVariations: false });
			expect([q, gate.includeExtras, gate.includeVariations]).toEqual([q, true, true]);
		}
	});

	test("illustrationid: opens extras and leaves variations closed", async () => {
		for (const q of [`illustrationid:${ART}`, `illustrationid:${ART} or cmc=3`, `-illustration_id:${ART} cmc=3`]) {
			const gate = await gated(q);
			expect([q, gate.includeExtras, gate.includeVariations]).toEqual([q, true, false]);
			expect(gate.wire).toContain('"rhs":["variation"]');
			expect(gate.wire).not.toContain('"rhs":["extra"]');
		}
	});

	test("an ignored value and a comparison fire nothing", async () => {
		for (const q of ["scryfallid:abc or cmc=3", `scryfallid!=${RESET} or cmc=3`]) {
			const gate = await gated(q);
			expect([q, gate.includeExtras, gate.includeVariations]).toEqual([q, false, false]);
		}
	});
});

describe("a scryfallid: conjunct pins the query for the router", () => {
	const wire = async (q: string) => (await gated(q)).wire;

	test("alone, and beside other terms", async () => {
		expect(pinnedScryfallId(await wire(`scryfallid:${RESET}`))).toBe(RESET);
		expect(pinnedScryfallId(await wire(`t:instant scryfall_id=${RESET.toUpperCase()} c:u`))).toBe(RESET);
		expect(pinnedScryfallId(await wire(`scryfallid:${RESET} unique:prints`))).toBe(RESET);
	});

	test("not under `or`, a `-`, or as an illustration id — and it is not an oracle pin", async () => {
		expect(pinnedScryfallId(await wire(`scryfallid:${RESET} or cmc=3`))).toBeNull();
		expect(pinnedScryfallId(await wire(`-scryfallid:${RESET} cmc=3`))).toBeNull();
		expect(pinnedScryfallId(await wire(`illustrationid:${ART}`))).toBeNull();
		expect(pinnedScryfallId(await wire("t:instant"))).toBeNull();
		expect(pinnedOracleId(await wire(`scryfallid:${RESET}`))).toBeNull();
		expect(pinnedScryfallId(await wire(`oracleid:${RESET}`))).toBeNull();
	});
});
