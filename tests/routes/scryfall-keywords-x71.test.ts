// The Scryfall search keywords x71 gave an answer to, at the term-policy and parser level.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04; the requests are recorded
// beside each keyword in src/parser/db-info.ts, src/routes/scryfall-compat/query-terms.ts and
// card_engine's filter.rs. The answers themselves — from real card objects through the whole store
// pipeline — are pinned in engine/builder/tests/x71_keywords.rs.

import { describe, expect, test } from "bun:test";
import { EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
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
		operand?: Leaf;
		lhs: { node_type: string; kwargs: { attribute_name: string; original_attribute: string } };
		rhs: { node_type: string; kwargs: { value: unknown } };
	};
}

/** The policy's query, parsed: the one leaf a single-term query becomes. */
function leaf(q: string): Leaf {
	const policy = scryfallTermPolicy(q);
	expect(policy.warnings).toEqual([]);
	return parseScryfallQueryWithDirectives(policy.query, EMPTY_TAG_ALIASES).tree as unknown as Leaf;
}

describe("lore: is a literal substring the engine answers", () => {
	test.each([
		["lore:jace", ":", "jace"],
		["lore=jace", "=", "jace"],
		['lore:"god of"', ":", "god of"],
		// The edge spaces are part of the value: `lore:" of " e:khm` is 174, `lore:"of "` 176.
		['lore:" of "', ":", " of "],
		// A tilde is a tilde: `lore:~` is the 2 Phyrexian flavor texts, not `o:~`'s 20,181.
		["lore:~", ":", "~"],
	])("%s", (q, op, value) => {
		const tree = leaf(q);
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe("lore");
		expect(tree.kwargs.lhs.kwargs.original_attribute).toBe("lore");
		expect(tree.kwargs.op).toBe(op);
		// A plain string, never the collated name node `name:` builds for a bare word — the
		// collation is exactly what made the four-column rewrite answer 41 for `lore:ft e:khm`.
		expect(tree.kwargs.rhs.node_type).toBe("StringValueNode");
		expect(tree.kwargs.rhs.kwargs.value).toBe(value);
	});

	test("the negation is a plain Not over the same leaf", () => {
		// `-lore:zzzzqq e:khm` is all 305: the complement, with no third value.
		const tree = leaf("-lore:jace");
		expect(tree.node_type).toBe("NotNode");
		expect(tree.kwargs.operand?.kwargs.lhs.kwargs.attribute_name).toBe("lore");
	});

	test("a comparison is honored and matches nothing", () => {
		// `lore!=jace` and `lore>jace` are 404 with no warnings.
		expect(scryfallTermPolicy("lore!=jace e:khm").query).toBe("cmc<0 e:khm");
		expect(scryfallTermPolicy("lore>jace e:khm").query).toBe("cmc<0 e:khm");
		expect(scryfallTermPolicy("lore>jace e:khm").warnings).toEqual([]);
	});

	test("a regex is Scryfall's regex-keyword sentence, however plain", () => {
		// `lore:/jace/ e:khm` is 305 carrying this warning.
		expect(scryfallTermPolicy("lore:/jace/ e:khm")).toMatchObject({
			query: "e:khm",
			warnings: [ignored("lore:/jace/", "Unknown regular expression keyword “lore”.")],
		});
	});

	test("an empty value is the unknown-keyword sentence, and a space is a value", () => {
		// `lore:"" e:khm` and `lore:'' e:khm` are 305 carrying it; `-lore:"" cmc=3` echoes the minus.
		expect(scryfallTermPolicy('lore:"" e:khm')).toMatchObject({
			query: "e:khm",
			warnings: [ignored('lore:""', "Unknown keyword “lore”.")],
		});
		expect(scryfallTermPolicy("lore:'' e:khm").warnings).toEqual([ignored("lore:''", "Unknown keyword “lore”.")]);
		expect(scryfallTermPolicy('-lore:"" cmc=3').warnings).toEqual([ignored('-lore:""', "Unknown keyword “-lore”.")]);
		// `lore:" " e:khm` is 305 with no warning.
		expect(scryfallTermPolicy('lore:" " e:khm')).toMatchObject({ query: 'lore:" " e:khm', warnings: [] });
	});

	test("it forces extras under : and =, in either polarity, and not under a comparison", async () => {
		// `lore:zzzzqq or cmc=3` echoes include_extras=true (8,302 against cmc=3's 8,089), and so do
		// `lore=zzzzqq or cmc=3` and `-lore:zzzzqq cmc=3`; `lore>zzzzqq or cmc=3` echoes false.
		expect(await gated("lore:zzzzqq or cmc=3")).toEqual([true, false]);
		expect(await gated("lore=zzzzqq or cmc=3")).toEqual([true, false]);
		expect(await gated("-lore:zzzzqq cmc=3")).toEqual([true, false]);
		expect(await gated("lore>zzzzqq or cmc=3")).toEqual([false, false]);
		expect(await gated('lore:"" or cmc=3')).toEqual([false, false]);
		expect(await gated("lore:/x/ or cmc=3")).toEqual([false, false]);
	});
});

describe("cheapest: is a currency, and its negated term is a term of its own", () => {
	test.each([
		// `cheapest:usd e:khm` is 222 of the set's 407 printings; `$` and `dollar` the same.
		["cheapest:usd", "usd"],
		["cheapest=usd", "usd"],
		["cheapest:USD", "usd"],
		['cheapest:"usd"', "usd"],
		["cheapest:$", "usd"],
		["cheapest:dollar", "usd"],
		["cheapest:DOLLAR", "usd"],
		// `cheapest:eur e:khm` 238 = `euro` = `€`.
		["cheapest:eur", "eur"],
		["cheapest:euro", "eur"],
		["cheapest:\u20ac", "eur"],
		// `cheapest:tix e:khm` 290 = `mtgo`.
		["cheapest:tix", "tix"],
		["cheapest:mtgo", "tix"],
	])("%s", (q, currency) => {
		const tree = leaf(q);
		expect(tree.node_type).toBe("CardBinaryOperatorNode");
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe("cheapest");
		expect(tree.kwargs.rhs.node_type).toBe("StringValueNode");
		expect(tree.kwargs.rhs.kwargs.value).toBe(currency);
	});

	test.each([
		// `-cheapest:usd e:khm` is 5 printings where the positive is 222 of 407, and khm/400 is in
		// both: `(usd IS NULL OR usd <> M) AND (usd_foil IS NULL OR usd_foil = M)`. The engine
		// answers that expression for `not_<currency>`, so the term stays POSITIVE in the tree.
		["-cheapest:usd", "not_usd"],
		["-cheapest:$", "not_usd"],
		["-cheapest=eur", "not_eur"],
		["-cheapest:mtgo", "not_tix"],
	])("%s is the negated TERM", (q, value) => {
		const tree = leaf(q);
		expect(tree.node_type).toBe("CardBinaryOperatorNode");
		expect(tree.kwargs.lhs.kwargs.attribute_name).toBe("cheapest");
		expect(tree.kwargs.rhs.kwargs.value).toBe(value);
	});

	test("a negated GROUP stays a Not over the positive term", () => {
		// `-(cheapest:usd) e:khm` is 185 = 407 - 222, the complement the negated term is not; and
		// `-(-cheapest:usd) e:khm` is 402 = 407 - 5.
		expect(scryfallTermPolicy("-(cheapest:usd) e:khm").query).toBe("-(cheapest:usd) e:khm");
		expect(scryfallTermPolicy("-(-cheapest:usd) e:khm").query).toBe("-(cheapest:not_usd) e:khm");
		const tree = parseScryfallQueryWithDirectives(scryfallTermPolicy("-(cheapest:usd)").query, EMPTY_TAG_ALIASES)
			.tree as unknown as Leaf;
		expect(tree.node_type).toBe("NotNode");
		expect(tree.kwargs.operand?.kwargs.rhs.kwargs.value).toBe("usd");
	});

	test.each([
		"dollars",
		"euros",
		"ticket",
		"tickets",
		"usdfoil",
		"eurfoil",
		"usd_foil",
		"usdetched",
		"tcgplayer",
		"cardmarket",
		"paper",
		"us",
		"1",
	])("cheapest:%s is an unknown currency", (word) => {
		// Each is 305 carrying the sentence, which has no closing period.
		expect(scryfallTermPolicy(`cheapest:${word} e:khm`)).toMatchObject({
			query: "e:khm",
			warnings: [ignored(`cheapest:${word}`, `Unknown currency “${word}”`)],
		});
	});

	test("the unknown-currency sentence downcases the value and echoes the minus", () => {
		// `-cheapest:nonsense e:khm` is 305 carrying `Invalid expression “-cheapest:nonsense” …`.
		expect(scryfallTermPolicy("-cheapest:nonsense e:khm").warnings).toEqual([
			ignored("-cheapest:nonsense", "Unknown currency “nonsense”"),
		]);
		expect(scryfallTermPolicy("cheapest:NONSENSE e:khm").warnings).toEqual([
			ignored("cheapest:nonsense", "Unknown currency “nonsense”"),
		]);
		// The internal spelling of the negated term is not a currency a user can write.
		expect(scryfallTermPolicy("cheapest:not_usd e:khm").warnings).toEqual([
			ignored("cheapest:not_usd", "Unknown currency “not_usd”"),
		]);
	});

	test("an empty value, a regex and a comparison", () => {
		// `cheapest:"" e:khm` is 305 carrying the unknown-keyword sentence.
		expect(scryfallTermPolicy('cheapest:"" e:khm').warnings).toEqual([
			ignored('cheapest:""', "Unknown keyword “cheapest”."),
		]);
		// `cheapest:/usd/ e:khm` is 305 carrying the regex-keyword sentence.
		expect(scryfallTermPolicy("cheapest:/usd/ e:khm")).toMatchObject({
			query: "e:khm",
			warnings: [ignored("cheapest:/usd/", "Unknown regular expression keyword “cheapest”.")],
		});
		// `cheapest>usd e:khm` and `cheapest!=usd e:khm` are 404 with no warnings.
		expect(scryfallTermPolicy("cheapest>usd e:khm")).toMatchObject({ query: "cmc<0 e:khm", warnings: [] });
		expect(scryfallTermPolicy("cheapest!=usd e:khm")).toMatchObject({ query: "cmc<0 e:khm", warnings: [] });
	});

	test("it forces no extras", async () => {
		// `cheapest:usd cmc=3` and `-cheapest:usd cmc=3` echo include_extras=false.
		expect(await gated("cheapest:usd cmc=3")).toEqual([false, false]);
		expect(await gated("-cheapest:usd cmc=3")).toEqual([false, false]);
	});
});
