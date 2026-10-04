// The Scryfall search keywords x68 gave an answer to, at the term-policy and parser level.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-03; the requests are recorded
// beside each keyword in src/parser/db-info.ts and src/routes/scryfall-compat/query-terms.ts. The
// answers themselves — counts, from real card objects through the whole store pipeline — are
// pinned in engine/builder/tests/x68_keywords.rs.

import { describe, expect, test } from "bun:test";
import { canonicalStringify, EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import type { FilterValue } from "../../src/parser/nodes";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

const ignored = (echo: string, reason: string) => `Invalid expression “${echo}” was ignored. ${reason}`;

interface Leaf {
	node_type: string;
	kwargs: {
		op: string;
		lhs: { node_type: string; kwargs: { attribute_name: string; original_attribute: string } };
		rhs: unknown;
	};
}

/** The policy's query, parsed: the one leaf a single-term query becomes. */
function leaf(q: string): Leaf {
	const policy = scryfallTermPolicy(q);
	expect(policy.warnings).toEqual([]);
	return parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES).tree as unknown as Leaf;
}

function wire(q: string): string {
	const policy = scryfallTermPolicy(q);
	return canonicalStringify(parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES).tree as FilterValue);
}

describe("edition: is a fourth spelling of set:", () => {
	test.each([
		["edition:khm", ":"],
		["edition=khm", "="],
		["EDITION:KHM", ":"],
		['edition:"khm"', ":"],
	])("%s", (q, op) => {
		const tree = leaf(q);
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe("card_set_code");
		expect(tree.kwargs.lhs.kwargs.original_attribute).toBe("edition");
		expect(tree.kwargs.op).toBe(op);
	});

	test("it is the tree e: writes, but for the spelling", () => {
		expect(wire("edition:khm t:god").replaceAll('"edition"', '"e"')).toBe(wire("e:khm t:god"));
	});

	test("a comparison is honored and matches nothing, as on e:", () => {
		// `edition!=khm t:god` and `edition>khm t:god` are 404 with no warnings.
		expect(scryfallTermPolicy("edition!=khm t:god").query).toBe("cmc<0 t:god");
		expect(scryfallTermPolicy("edition>khm t:god").query).toBe("cmc<0 t:god");
	});

	test("a real regex is Scryfall's regex-keyword sentence", () => {
		// `edition:/khm/ t:god` is 95 carrying this warning; a pattern with a metacharacter is the
		// shape that needs an engine, so it is the one the sentence is said for here.
		expect(scryfallTermPolicy("edition:/^kh/ t:god").warnings).toEqual([
			ignored("edition:/^kh/", "Unknown regular expression keyword “edition”."),
		]);
	});
});

describe("collector: and collectornumber: are the NUMERIC collector number", () => {
	test.each([
		["collector:1", ":", "collector"],
		["collectornumber:1", ":", "collectornumber"],
		["collector=1", "=", "collector"],
		["collector>=390", ">=", "collector"],
		["collectornumber<5", "<", "collectornumber"],
		["collector!=1", "!=", "collector"],
	])("%s", (q, op, spelling) => {
		const tree = leaf(q);
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe("collector_number_int");
		expect(tree.kwargs.lhs.kwargs.original_attribute).toBe(spelling);
		expect(tree.kwargs.op).toBe(op);
	});

	test("a comparison is the tree cn writes", () => {
		expect(wire("collector>=390 e:khm").replaceAll('"collector"', '"cn"')).toBe(wire("cn>=390 e:khm"));
	});

	test("it compares against another column, on either side", () => {
		// `collector>=cmc e:khm` is 303 and `pow>cn e:khm` = `pow>number e:khm` is 1.
		for (const q of ["collector>=cmc e:khm", "pow>cn e:khm", "pow>number e:khm", "pow>collector e:khm"]) {
			const policy = scryfallTermPolicy(q);
			expect([q, policy.query, policy.warnings]).toEqual([q, q, []]);
			const tree = parseScryfallQueryWithDirectives(q, EMPTY_TAG_ALIASES).tree as FilterValue;
			expect(canonicalStringify(tree)).toContain('"attribute_name":"collector_number_int"');
		}
	});

	test.each([
		["collector:abc", "collector"],
		["collectornumber:abc", "collectornumber"],
		["collector:a-40", "collector"],
		["collector:a1", "collector"],
		["collector:★", "collector"],
		["collector:+1", "collector"],
		['collector:"1"', "collector"],
	])("%s is the numeric columns' unknown-keyword sentence", (term, keyword) => {
		const result = scryfallTermPolicy(`${term} e:khm`);
		expect(result.query).toBe("e:khm");
		expect(result.warnings).toEqual([ignored(term, `Unknown keyword “${keyword}”.`)]);
	});

	test("a negated equality names the minus; a negated comparison is the silent tautology", () => {
		expect(scryfallTermPolicy("-collector:1 e:khm").warnings).toEqual([
			ignored("-collector:1", "Unknown keyword “-collector”."),
		]);
		expect(scryfallTermPolicy("-collectornumber:1 e:khm").warnings).toEqual([
			ignored("-collectornumber:1", "Unknown keyword “-collectornumber”."),
		]);
		const tautology = scryfallTermPolicy("-collector>=390 e:khm");
		expect(tautology.warnings).toEqual([]);
		expect(tautology.query).toBe("-cmc<0 e:khm");
	});

	test("a value that only starts as a number is its leading integer, or nothing", () => {
		// `collector:1a e:khm` and `collector:1-2 e:khm` are each khm/1; `collector:1★ e:khm` is 404.
		expect(scryfallTermPolicy("collector:1a e:khm").query).toBe("collector:1 e:khm");
		expect(scryfallTermPolicy("collector:1-2 e:khm").query).toBe("collector:1 e:khm");
		expect(scryfallTermPolicy("collectornumber=40s e:khm").query).toBe("collectornumber=40 e:khm");
		expect(scryfallTermPolicy("collector:1★ e:khm").query).toBe("cmc<0 e:khm");
		for (const q of ["collector:1a e:khm", "collector:1★ e:khm", "collector:1.5 e:khm", "collector:-1 e:khm"]) {
			expect(scryfallTermPolicy(q).warnings).toEqual([]);
		}
	});

	test("compared with itself, under either spelling", () => {
		expect(scryfallTermPolicy("collector=collector e:khm").warnings).toEqual([
			ignored("collector=collector", "The sides of your comparison must be different."),
		]);
		expect(scryfallTermPolicy("collector>cn e:khm").warnings).toEqual([
			ignored("collector>cn", "The sides of your comparison must be different."),
		]);
	});

	test("a regex value is the regex-keyword sentence", () => {
		expect(scryfallTermPolicy("collector:/1/ e:khm").warnings).toEqual([
			ignored("collector:/1/", "Unknown regular expression keyword “collector”."),
		]);
	});
});

describe("edhrec: is the EDHREC rank, under three spellings", () => {
	test.each([
		["edhrec:1", ":", "edhrec"],
		["edhrec=1", "=", "edhrec"],
		["edhrecrank:1", ":", "edhrecrank"],
		["edhrec_rank:1", ":", "edhrec_rank"],
		["edhrec<=10", "<=", "edhrec"],
		["edhrec>=5000", ">=", "edhrec"],
		["edhrec!=1", "!=", "edhrec"],
	])("%s", (q, op, spelling) => {
		const tree = leaf(q);
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe("edhrec_rank");
		expect(tree.kwargs.lhs.kwargs.original_attribute).toBe(spelling);
		expect(tree.kwargs.op).toBe(op);
	});

	test("it compares against another column", () => {
		// `edhrec>=cmc e:khm` is 295: every card of the set that has a rank.
		const policy = scryfallTermPolicy("edhrec>=cmc e:khm");
		expect(policy.warnings).toEqual([]);
		expect(policy.query).toBe("edhrec>=cmc e:khm");
		expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
	});

	test("the numeric columns' sentences", () => {
		expect(scryfallTermPolicy("edhrec:abc e:khm").warnings).toEqual([
			ignored("edhrec:abc", "Unknown keyword “edhrec”."),
		]);
		expect(scryfallTermPolicy("-edhrec:1 e:khm").warnings).toEqual([
			ignored("-edhrec:1", "Unknown keyword “-edhrec”."),
		]);
		const tautology = scryfallTermPolicy("-edhrec>=5000 e:khm");
		expect(tautology.warnings).toEqual([]);
		expect(tautology.query).toBe("-cmc<0 e:khm");
	});
});
