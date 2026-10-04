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
import { blockSetCodes, blockValueCode } from "../../src/routes/scryfall-compat/set-blocks.gen";

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

	test("a value that only starts as a number is its leading integer and a term after it, or nothing", () => {
		// `collector:1a e:khm` and `collector:1-2 e:khm` are each khm/1 (Axgard Braggart, which has
		// an `a` and no `2`); `collector:1z e:khm` and `collector:1★ e:khm` are 404. The integer is
		// the collector number and the rest is the term it would be after a space — the rule every
		// numeric column follows (query-terms.ts, numericValueSplit). Until 2026-10-04 this pinned
		// `collector:1a` as `collector:1` alone, which answered `collector:1z e:khm` with khm/1.
		expect(scryfallTermPolicy("collector:1a e:khm").query).toBe("collector:1 a e:khm");
		expect(scryfallTermPolicy("collector:1z e:khm").query).toBe("collector:1 z e:khm");
		expect(scryfallTermPolicy("collector:1-2 e:khm").query).toBe("collector:1 -name:2 e:khm");
		expect(scryfallTermPolicy("collectornumber=40s e:khm").query).toBe("collectornumber=40 s e:khm");
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

describe("the six counts: prints, sets, paperprints, papersets, illustrations, artists", () => {
	const COUNTS: [keyword: string, column: string][] = [
		["prints", "print_count"],
		["sets", "set_count"],
		["paperprints", "paper_print_count"],
		["papersets", "paper_set_count"],
		["illustrations", "illustration_count"],
		["artists", "artist_count"],
	];

	for (const [keyword, column] of COUNTS) {
		test.each([":", "=", ">", ">=", "<", "<=", "!="])(`${keyword}%s2 is ${column}`, (op) => {
			const tree = leaf(`${keyword}${op}2`);
			expect(tree.kwargs.lhs.kwargs.attribute_name).toBe(column);
			expect(tree.kwargs.lhs.kwargs.original_attribute).toBe(keyword);
			expect(tree.kwargs.op).toBe(op);
			expect(wire(`${keyword}${op}2`)).toContain('"rhs":{"kwargs":{"value":2},"node_type":"NumericValueNode"}');
		});

		test(`${keyword}: the numeric columns' sentences`, async () => {
			expect(scryfallTermPolicy(`${keyword}:abc e:khm`).warnings).toEqual([
				ignored(`${keyword}:abc`, `Unknown keyword “${keyword}”.`),
			]);
			expect(scryfallTermPolicy(`-${keyword}:1 e:khm`).warnings).toEqual([
				ignored(`-${keyword}:1`, `Unknown keyword “-${keyword}”.`),
			]);
			const tautology = scryfallTermPolicy(`-${keyword}>=2 e:khm`);
			expect([tautology.query, tautology.warnings]).toEqual(["-cmc<0 e:khm", []]);
			// `prints=1 or cmc=3` … `artists:2 or cmc=3` all echo include_extras=false.
			expect(await gated(`${keyword}=1 or cmc=3`)).toEqual([false, false]);
		});
	}

	test("they compare against each other and against other columns", () => {
		// `prints>sets e:khm` 119, `prints=sets e:khm` 186, `prints>paperprints e:khm` 98,
		// `illustrations>=prints e:khm` 123, `prints>=cmc e:khm` 171, `artists>=cmc e:khm` 59.
		for (const q of [
			"prints>sets e:khm",
			"prints=sets e:khm",
			"prints>paperprints e:khm",
			"papersets<sets e:khm",
			"illustrations>=prints e:khm",
			"prints>=cmc e:khm",
			"artists>=cmc e:khm",
			"cmc<prints e:khm",
		]) {
			const policy = scryfallTermPolicy(q);
			expect([q, policy.query, policy.warnings]).toEqual([q, q, []]);
			expect(() => parseScryfallQueryWithDirectives(q, EMPTY_TAG_ALIASES)).not.toThrow();
		}
	});

	test("compared with itself", () => {
		expect(scryfallTermPolicy("prints=prints e:khm").warnings).toEqual([
			ignored("prints=prints", "The sides of your comparison must be different."),
		]);
	});

	test("a quoted number is a string, as on every numeric column", () => {
		// `artists:"1" e:khm` is 305 carrying the unknown-keyword sentence.
		expect(scryfallTermPolicy('artists:"1" e:khm').warnings).toEqual([
			ignored('artists:"1"', "Unknown keyword “artists”."),
		]);
	});
});

describe("block: and b: are the sets of a block", () => {
	const ZENDIKAR = "(e:proe or e:pwwk or e:pzen or e:roe or e:troe or e:twwk or e:tzen or e:wwk or e:zen)";

	test("the set table answers Scryfall's measured families", () => {
		// block:zen = block:wwk = block:roe = block:tzen = block:pzen = 629.
		const zendikar = ["proe", "pwwk", "pzen", "roe", "troe", "twwk", "tzen", "wwk", "zen"];
		for (const code of ["zen", "wwk", "roe", "tzen", "pzen", "ZEN"]) expect(blockSetCodes(code)).toEqual(zendikar);
		// No block and no parent: the set alone (block:khm = e:khm = 305).
		expect(blockSetCodes("khm")).toEqual(["khm"]);
		// No block of its own: the set and its PARENT (block:tkhm 328, block:akhm = `e:akhm or e:khm`),
		// and the parent does not answer with its children.
		expect(blockSetCodes("tkhm")).toEqual(["khm", "tkhm"]);
		expect(blockSetCodes("akhm")).toEqual(["akhm", "khm"]);
		// The parent's block is not followed: block:pbig is `e:pbig or e:big`, not Thunder Junction.
		expect(blockSetCodes("pbig")).toEqual(["big", "pbig"]);
		expect(blockSetCodes("big")).toEqual(blockSetCodes("otj"));
		expect(blockSetCodes("otj")).toEqual(["big", "otj", "otp"]);
		// A set in a block AND with a parent outside it: both (block:khc is 7,558 = cmd ∪ khm ∪ khc).
		const khc = blockSetCodes("khc");
		expect(khc).toContain("khm");
		expect(khc).toContain("cmd");
		expect(khc).toContain("c21");
		expect(khc.length).toBe(blockSetCodes("cmd").length + 1);
		// `dbl` is a block code and a set that is not IN the block: block:dbl 728, block:mid 727.
		expect(blockSetCodes("dbl")).toEqual([...blockSetCodes("mid"), "dbl"].sort());
		// A block code that is no set's code: block:htr 31.
		expect(blockSetCodes("htr").filter((c) => c !== "htr")).toEqual(
			["ph17", "ph18", "ph19", "ph20", "ph21", "ph22", "ph23", "phtr"].sort(),
		);
		// A code the table has never seen is that set alone.
		expect(blockSetCodes("zzzz")).toEqual(["zzzz"]);
	});

	test.each(["block:wwk", "b:wwk", "block=wwk", "BLOCK:WWK", 'block:"wwk"', "b=roe"])("%s", (term) => {
		const policy = scryfallTermPolicy(`${term} t:goblin`);
		expect(policy.warnings).toEqual([]);
		expect(policy.query).toBe(`${ZENDIKAR} t:goblin`);
		expect(policy.include.extras).toBe(true);
		expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
	});

	test("it is the tree the spelled-out sets write", () => {
		expect(wire("block:khm t:god")).toBe(wire("(e:khm) t:god"));
		expect(wire("b:wwk t:goblin")).toBe(wire(`${ZENDIKAR} t:goblin`));
	});

	test("negated, it is the complement", () => {
		// `-block:khm t:god` is 100: every god not in Kaldheim, over a corpus with extras in it.
		const policy = scryfallTermPolicy("-block:khm t:god");
		expect([policy.query, policy.warnings, policy.include.extras]).toEqual(["-(e:khm) t:god", [], true]);
		expect(wire("-block:khm t:god")).toBe(wire("-e:khm t:god"));
	});

	test("it opens extras, in a group and under or too", () => {
		expect(scryfallTermPolicy("block:zen or cmc=3").include.extras).toBe(true);
		expect(scryfallTermPolicy("(block:zen t:goblin) or cmc=3").include.extras).toBe(true);
		// ...where `e:` does not: `e:zen or cmc=3` echoes include_extras=false.
		expect(scryfallTermPolicy("e:zen or cmc=3").include.extras).toBe(false);
	});

	test("a value that names no set is honored and matches nothing", () => {
		// `block:nonsense t:god` is 404 with no warnings. A value that is no name and not shaped
		// like a code has no `e:` term to become.
		for (const term of ["block:nonsensevalue", 'block:"no such set"', "b:ice-age!"]) {
			const policy = scryfallTermPolicy(`${term} t:god`);
			expect([term, policy.query, policy.warnings]).toEqual([term, "cmc<0 t:god", []]);
		}
		expect(scryfallTermPolicy('-block:"no such set" t:god').query).toBe("-cmc<0 t:god");
		// Code-shaped and unknown: the set alone, which no row carries.
		expect(scryfallTermPolicy("block:alara t:god").query).toBe("(e:alara) t:god");
	});

	// Every row below is a request on api.scryfall.com, 2026-10-04, whose count is the count of the
	// block asked by code; scripts/generate-set-blocks.ts carries them.
	test.each([
		["block:zendikar", "zen"],
		["block:ZENDIKAR", "zen"],
		['block:"zendikar"', "zen"],
		["block:worldwake", "wwk"],
		['block:"rise of the eldrazi"', "roe"],
		['b:"return to ravnica"', "rtr"],
		["block:returntoravnica", "rtr"],
		['block:"time spiral"', "tsp"],
		["block:timespiral", "tsp"],
		['block:"future sight"', "fut"],
		['block:"urza\'s saga"', "usg"],
		['block:"urzas saga"', "usg"],
		['block:"kaldheim commander"', "khc"],
		["block:kaldheim-commander", "khc"],
		["block:kaldheim_commander", "khc"],
		['block:"kaldheim  commander"', "khc"],
		['block:"duel decks elves vs. goblins"', "dd1"],
		['block:"duel decks elves vs goblins"', "dd1"],
		['block:"the lord of the rings tales of middle-earth"', "ltr"],
		["block:kaldheim", "khm"],
		['block:"the dark"', "drk"],
		['block:"new phyrexia"', "nph"],
		['block:"kaldheim promos"', "pkhm"],
		['block:"kaldheim art series"', "akhm"],
		['block:"magic 2010"', "m10"],
		['block:"30th anniversary edition"', "30a"],
	])("a set's whole name answers as its code: %s", (term, code) => {
		const policy = scryfallTermPolicy(`${term} t:goblin`);
		expect(policy.warnings).toEqual([]);
		expect(policy.query).toBe(scryfallTermPolicy(`block:${code} t:goblin`).query);
		expect(policy.include.extras).toBe(true);
		expect(() => parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES)).not.toThrow();
	});

	test("a name, negated, is the complement of the block", () => {
		expect(scryfallTermPolicy("-block:zendikar t:god").query).toBe(scryfallTermPolicy("-block:zen t:god").query);
	});

	test("it is the whole name: a part of one, or a block's own name, names nothing", () => {
		// `block:"return to"`, `block:spiral`, `block:reborn`, `block:"city of guilds"`,
		// `block:"midnight hunt"`, `block:"big score"` and `block:dark` are each 404, and so are the
		// block names `urza`, `alara`, `"core set"` and `commander`.
		for (const value of [
			"return to",
			"spiral",
			"reborn",
			"city of guilds",
			"midnight hunt",
			"big score",
			"dark",
			"urza",
			"alara",
			"core set",
			"commander",
		]) {
			expect([value, blockValueCode(value)]).toEqual([value, null]);
		}
	});

	test("a colon in the value is never a name, though the set's own name has one", () => {
		// `block:"kamigawa: neon dynasty"` is 404 where `block:"kamigawa neon dynasty"` is 287.
		expect(blockValueCode("kamigawa neon dynasty")).toBe("neo");
		expect(blockValueCode("ravnica city of guilds")).toBe("rav");
		expect(blockValueCode("innistrad double feature")).toBe("dbl");
		for (const name of ["kamigawa: neon dynasty", "ravnica: city of guilds", "innistrad: double feature"]) {
			expect([name, blockValueCode(name)]).toEqual([name, null]);
			expect(scryfallTermPolicy(`block:"${name}" t:god`).query).toBe("cmc<0 t:god");
		}
	});

	test("a token set's name is left out, and its code still answers", () => {
		// `block:"kaldheim tokens"` is 404 on api.scryfall.com where `block:tkhm` is 328, and
		// `block:"zendikar tokens"` is 629: eight of twelve token names answered and no rule
		// separates them, so none is in the table.
		expect(blockValueCode("kaldheim tokens")).toBeNull();
		expect(blockValueCode("zendikar tokens")).toBeNull();
		expect(blockValueCode("tkhm")).toBe("tkhm");
	});

	test.each([
		["alpha", "lea"],
		["beta", "leb"],
		["unlimited", "2ed"],
		["revised", "3ed"],
		["fourth", "4ed"],
		["tenth", "10e"],
		["saga", "usg"],
		["legacy", "ulg"],
		["destiny", "uds"],
		["mercadian", "mmq"],
		["masques", "mmq"],
		["champions", "chk"],
		["kamigawa", "chk"],
		["ravnica", "rav"],
		["shards", "ala"],
		["scars", "som"],
		["khans", "ktk"],
		["battle", "bfz"],
		["throne", "eld"],
		["eldraine", "eld"],
		["outlaws", "otj"],
		["double feature", "dbl"],
		["brothers war", "bro"],
		["lord of the rings tales of middle earth", "ltr"],
	])("Scryfall's nickname %s is %s", (nickname, code) => {
		expect(blockValueCode(nickname)).toBe(code);
	});

	test("a code is read before a name, and a set with no block or parent is not in the code table", () => {
		expect(blockValueCode("war")).toBe("war");
		expect(blockValueCode("WAR")).toBe("war");
		// `khm` has neither a block nor a parent; the policy's code-shape fallback answers it.
		expect(blockValueCode("khm")).toBeNull();
		expect(scryfallTermPolicy("block:khm t:god").query).toBe("(e:khm) t:god");
	});

	test("a comparison matches nothing and a regex is the regex-keyword sentence", () => {
		expect(scryfallTermPolicy("block!=khm t:god").query).toBe("cmc<0 t:god");
		expect(scryfallTermPolicy("block>khm t:god").query).toBe("cmc<0 t:god");
		expect(scryfallTermPolicy("block:/khm/ t:god").warnings).toEqual([
			ignored("block:/khm/", "Unknown regular expression keyword “block”."),
		]);
		expect(scryfallTermPolicy("block!=khm t:god").include.extras).toBe(false);
	});
});
