// The Scryfall search keywords x68 gave an answer to, at the term-policy and parser level.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-03; the requests are recorded
// beside each keyword in src/parser/db-info.ts and src/routes/scryfall-compat/query-terms.ts. The
// answers themselves — counts, from real card objects through the whole store pipeline — are
// pinned in engine/builder/tests/x68_keywords.rs.

import { describe, expect, test } from "bun:test";
import { canonicalStringify, EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import type { FilterValue } from "../../src/parser/nodes";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";

const ignored = (echo: string, reason: string) => `Invalid expression “${echo}” was ignored. ${reason}`;

/** What the extras gate decides for a query, with both parameters sent as false. */
async function gated(q: string) {
	const policy = scryfallTermPolicy(q);
	const parsed = parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES);
	const gate = await applyExtrasGate(
		{ setsWithExtras: async () => [] } as never,
		parsed.tree,
		{ loweredRegexTerms: parsed.loweredRegexTerms, expandedDerivedTerms: parsed.expandedDerivedTerms },
		{ includeExtras: false, includeVariations: false },
	);
	return [gate.includeExtras, gate.includeVariations];
}

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

describe("usdfoil: is the printing's foil price", () => {
	test.each([
		["usdfoil>=1", ">="],
		["usdfoil<1", "<"],
		["usdfoil=0.25", "="],
		["usdfoil:0.25", ":"],
		["usdfoil!=1", "!="],
	])("%s", (q, op) => {
		const tree = leaf(q);
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe("price_usd_foil");
		expect(tree.kwargs.lhs.kwargs.original_attribute).toBe("usdfoil");
		expect(tree.kwargs.op).toBe(op);
	});

	test("it compares against the other prices and columns, on either side", () => {
		// `usdfoil>usd e:khm` 247, `usd>usdfoil e:khm` 57, `usdfoil>eur` 274, `eur>usdfoil` 30,
		// `usdfoil>tix` 283, `usdfoil>=cmc` 67, `cmc<usd` 66.
		for (const q of [
			"usdfoil>usd e:khm",
			"usd>usdfoil e:khm",
			"usdfoil>eur e:khm",
			"eur>usdfoil e:khm",
			"usdfoil>tix e:khm",
			"usdfoil>=cmc e:khm",
			"cmc<usd e:khm",
		]) {
			const policy = scryfallTermPolicy(q);
			expect([q, policy.query, policy.warnings]).toEqual([q, q, []]);
			expect(() => parseScryfallQueryWithDirectives(q, EMPTY_TAG_ALIASES)).not.toThrow();
		}
	});

	test("the numeric columns' sentences, and no extras", async () => {
		expect(scryfallTermPolicy("usdfoil:abc e:khm").warnings).toEqual([
			ignored("usdfoil:abc", "Unknown keyword “usdfoil”."),
		]);
		expect(scryfallTermPolicy("-usdfoil:1 e:khm").warnings).toEqual([
			ignored("-usdfoil:1", "Unknown keyword “-usdfoil”."),
		]);
		expect(scryfallTermPolicy("-usdfoil>=1 e:khm").query).toBe("-cmc<0 e:khm");
		expect(await gated("usdfoil>=100 or cmc=3")).toEqual([false, false]);
	});

	test("its siblings are not Scryfall keywords", () => {
		// `eurfoil:1 e:khm` and `usdetched:1 e:khm` are 305 carrying `Unknown keyword`.
		for (const kw of ["eurfoil", "usdetched", "usd_foil", "tixfoil"]) {
			expect(scryfallTermPolicy(`${kw}:1 e:khm`).warnings).toEqual([ignored(`${kw}:1`, `Unknown keyword “${kw}”.`)]);
		}
	});
});

describe("stamp: is the security stamp, with Scryfall's six values", () => {
	test.each(["oval", "triangle", "acorn", "circle", "arena", "heart"])("stamp:%s", (value) => {
		const tree = leaf(`stamp:${value}`);
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe("security_stamp");
		expect(tree.kwargs.op).toBe(":");
		expect((tree.kwargs.rhs as { kwargs: { value: string } }).kwargs.value).toBe(value);
	});

	test("=, upper case and quotes are the same term", () => {
		for (const q of ["stamp=oval", "stamp:OVAL", 'stamp:"oval"', "STAMP:oval"]) {
			expect(leaf(q).kwargs.lhs.kwargs.attribute_name).toBe("security_stamp");
		}
	});

	test("any other value is ignored with its own sentence, in either polarity", () => {
		expect(scryfallTermPolicy("stamp:nonsense e:khm").warnings).toEqual([
			ignored("stamp:nonsense", "Unknown security stamp “nonsense”"),
		]);
		expect(scryfallTermPolicy("stamp:none e:khm").warnings).toEqual([
			ignored("stamp:none", "Unknown security stamp “none”"),
		]);
		expect(scryfallTermPolicy("-stamp:NONSENSE e:khm").warnings).toEqual([
			ignored("-stamp:nonsense", "Unknown security stamp “nonsense”"),
		]);
		expect(scryfallTermPolicy("stamp:nonsense e:khm").query).toBe("e:khm");
	});

	test("a comparison matches nothing, a regex is the regex-keyword sentence, and extras stay closed", async () => {
		expect(scryfallTermPolicy("stamp!=oval e:khm").query).toBe("cmc<0 e:khm");
		expect(scryfallTermPolicy("stamp>oval e:khm").query).toBe("cmc<0 e:khm");
		expect(scryfallTermPolicy("stamp:/oval/ e:khm").warnings).toEqual([
			ignored("stamp:/oval/", "Unknown regular expression keyword “stamp”."),
		]);
		expect(await gated("stamp:oval or cmc=3")).toEqual([false, false]);
		expect(await gated("-stamp:oval or cmc=3")).toEqual([false, false]);
	});
});

describe("the four external-id keywords", () => {
	const SPELLINGS: [column: string, aliases: string[]][] = [
		["mtgo_id", ["mtgoid", "mtgo_id", "mtgo"]],
		["arena_id", ["arenaid", "arena_id", "arena"]],
		["tcgplayer_id", ["tcgplayerid", "tcgplayer_id", "tcgplayer"]],
		["multiverse_id", ["multiverseid", "multiverse_id", "multiverse"]],
	];

	for (const [column, aliases] of SPELLINGS) {
		test.each(aliases)(`%s: is ${column}, under : and =`, (alias) => {
			for (const op of [":", "="]) {
				const tree = leaf(`${alias}${op}87321`);
				expect(tree.kwargs.lhs.kwargs.attribute_name).toBe(column);
				expect(tree.kwargs.lhs.kwargs.original_attribute).toBe(alias);
				expect(tree.kwargs.op).toBe(op);
				expect((tree.kwargs.rhs as { kwargs: { value: string } }).kwargs.value).toBe("87321");
			}
		});
	}

	test("the value is the integer it leads with, quoted or not", () => {
		// `mtgoid:"87321"`, `mtgoid:87321.0` and `mtgoid:87321a` are each khm/1.
		expect(scryfallTermPolicy('mtgoid:"87321" e:khm').query).toBe("mtgoid:87321 e:khm");
		expect(scryfallTermPolicy("mtgoid:87321.0 e:khm").query).toBe("mtgoid:87321 e:khm");
		expect(scryfallTermPolicy("mtgoid:87321a e:khm").query).toBe("mtgoid:87321 e:khm");
		expect(scryfallTermPolicy("arenaid:75036a e:khm").query).toBe("arenaid:75036 e:khm");
		expect(scryfallTermPolicy("tcgplayerid:230675a e:khm").query).toBe("tcgplayerid:230675 e:khm");
		expect(scryfallTermPolicy("tcgplayerid:1.5 e:khm").query).toBe("tcgplayerid:1 e:khm");
		expect(scryfallTermPolicy("multiverse_id=503605a e:khm").query).toBe("multiverse_id=503605 e:khm");
	});

	test("a value that leads with no digit names no card, and is not a warning", () => {
		// `mtgoid:abc`, `mtgoid:-1`, `arenaid:abc`, `multiverseid:abc` e:khm: 404, no warnings. The
		// negations are left to the engine: id 0 is on no printing.
		for (const [q, rewritten] of [
			["mtgoid:abc e:khm", "mtgoid:0 e:khm"],
			["mtgoid:-1 e:khm", "mtgoid:0 e:khm"],
			["arenaid:abc e:khm", "arenaid:0 e:khm"],
			["multiverseid:abc e:khm", "multiverseid:0 e:khm"],
			["-multiverseid:abc e:khm", "-multiverseid:0 e:khm"],
			["-arenaid:abc e:khm", "-arenaid:0 e:khm"],
		]) {
			const policy = scryfallTermPolicy(q as string);
			expect([q, policy.query, policy.warnings]).toEqual([q, rewritten, []]);
			expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
		}
	});

	test("only tcgplayerid validates, in Scryfall's own words", () => {
		const reason = "You must provide a vaid interger";
		expect(scryfallTermPolicy("tcgplayerid:abc e:khm").warnings).toEqual([ignored("tcgplayerid:abc", reason)]);
		expect(scryfallTermPolicy("-tcgplayerid:abc e:khm").warnings).toEqual([ignored("-tcgplayerid:abc", reason)]);
		expect(scryfallTermPolicy("tcgplayerid:-5 e:khm").warnings).toEqual([ignored("tcgplayerid:-5", reason)]);
		expect(scryfallTermPolicy("tcgplayer_id:abc e:khm").warnings).toEqual([ignored("tcgplayer_id:abc", reason)]);
		expect(scryfallTermPolicy("tcgplayerid:abc e:khm").query).toBe("e:khm");
	});

	test("a comparison is honored and matches nothing", () => {
		for (const q of ["mtgoid>=87000", "mtgoid!=87000", "arenaid>=75000", "tcgplayerid>abc", "multiverseid<503650"]) {
			const policy = scryfallTermPolicy(`${q} e:khm`);
			expect([q, policy.query, policy.warnings]).toEqual([q, "cmc<0 e:khm", []]);
		}
	});

	test("the spellings Scryfall does not know stay unknown", () => {
		for (const kw of ["mtgofoilid", "mtgo_foil_id", "tcg", "mvid", "cardmarketid", "cardmarket"]) {
			expect(scryfallTermPolicy(`${kw}:1 e:khm`).warnings).toEqual([ignored(`${kw}:1`, `Unknown keyword “${kw}”.`)]);
		}
	});

	test("each opens extras on the term, in either polarity and for a value naming nothing", async () => {
		for (const q of [
			"mtgoid:87321 or cmc=3",
			"arenaid:75036 or cmc=3",
			"multiverseid:503605 or cmc=3",
			"mtgoid:abc or cmc=3",
			"arenaid:abc or cmc=3",
			"multiverseid:abc or cmc=3",
			"-mtgoid:87321 or cmc=3",
			"-arenaid:75036 or cmc=3",
			"-multiverseid:503605 or cmc=3",
		]) {
			expect([q, ...(await gated(q))]).toEqual([q, true, false]);
		}
	});

	test("tcgplayerid: opens variations too", async () => {
		expect(await gated("tcgplayerid:230675 or cmc=3")).toEqual([true, true]);
		expect(await gated("-tcgplayerid:230675 or cmc=3")).toEqual([true, true]);
		expect(await gated("tcgplayer:230675 or cmc=3")).toEqual([true, true]);
	});

	test("a comparison and an ignored value fire nothing", async () => {
		expect(await gated("mtgoid>=1 or cmc=3")).toEqual([false, false]);
		expect(await gated("tcgplayerid:abc or cmc=3")).toEqual([false, false]);
	});
});
