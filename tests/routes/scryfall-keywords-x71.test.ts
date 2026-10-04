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
