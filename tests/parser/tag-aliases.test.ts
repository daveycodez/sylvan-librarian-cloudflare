/**
 * The alias map is the half of upstream #914 this port moved from import time to query time.
 *
 * Upstream stamps every alias into `card_oracle_tags` / `card_art_tags` as an extra key, so the
 * query side can stay a dumb exact match. Here the store holds only canonical slugs and the map
 * does the resolving, because those keys measured 6,252,880 bytes of archive and bought the
 * store a fourth KV chunk (see src/engine/store-kv.ts).
 *
 * That split is worth testing precisely because it cannot fail loudly. If the map and the
 * slugifier ever disagree, or the builder starts stamping again, or an alias goes missing, nothing
 * throws — `art:flames` just returns zero results, which is the exact state #914 existed to fix.
 *
 * The map under test is a builder sidecar (tests/fixtures/tag-aliases.json, the shape every
 * publisher ships: src/engine/tag-aliases.ts). It is a FIXTURE, not the live map: production
 * reads the map its store build published, which is the whole point — the committed copy this
 * test used to import froze on 2026-08-11 while the nightly rebuilt the store from newer dumps,
 * and `copy-from-graveyard` went dark on both spellings when Scryfall swapped which one is
 * canonical. The fixture is from after that swap and pins it below.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseTagAliasTables } from "../../src/engine/tag-aliases";
import { parseScryfallQuery } from "../../src/parser";
import {
	EMPTY_TAG_ALIASES,
	getArtTagsComparisonKeys,
	getOracleTagsComparisonKeys,
	slugifyTag,
	withTagAliases,
} from "../../src/parser/card-query-nodes";

const FIXTURE = parseTagAliasTables(readFileSync(`${import.meta.dir}/../fixtures/tag-aliases.json`, "utf8"));

const MAPS = [
	["oracle", FIXTURE.oracle],
	["art", FIXTURE.art],
] as const;

describe("a published alias map is well formed", () => {
	for (const [name, map] of MAPS) {
		test(`${name}: is non-empty`, () => {
			// A silently empty map is the failure this whole file guards: every alias spelling
			// would quietly stop resolving, with the store no longer carrying the keys either.
			expect(map.size).toBeGreaterThan(100);
		});

		test(`${name}: every key is already in slugified form`, () => {
			// The parser looks the term up AFTER slugifying it. A key that is not itself a fixed
			// point of slugifyTag could never be hit, no matter what the searcher typed.
			const unreachable = [...map.keys()].filter((alias) => slugifyTag(alias) !== alias);
			expect(unreachable).toEqual([]);
		});

		test(`${name}: no alias resolves to another alias`, () => {
			// resolveTagAlias does ONE hop. The builder guarantees this by dropping any alias that
			// collides with a declared slug, so a value is never also a key; if that ever changes,
			// a chain would silently resolve only its first link.
			const chained = [...map.values()].filter((slug) => map.has(slug));
			expect(chained).toEqual([]);
		});

		test(`${name}: no alias maps to itself`, () => {
			const identity = [...map.entries()].filter(([alias, slug]) => alias === slug);
			expect(identity).toEqual([]);
		});
	}
});

describe("tag values resolve through the map", () => {
	test("art:flames reaches the fire tag", () => {
		expect(getArtTagsComparisonKeys("flames", FIXTURE)).toEqual(["fire"]);
	});

	test("a spaced alias spelling reaches the same slug", () => {
		// The two halves of #914 compose: slugifyTag folds "open mouth" to "open-mouth", the map
		// then resolves that alias to the slug the store actually carries.
		expect(getArtTagsComparisonKeys("open mouth", FIXTURE)).toEqual(["loose-lips"]);
		expect(getArtTagsComparisonKeys("open-mouth", FIXTURE)).toEqual(["loose-lips"]);
		expect(getArtTagsComparisonKeys("Open Mouth", FIXTURE)).toEqual(["loose-lips"]);
	});

	test("a canonical slug is returned untouched", () => {
		expect(getArtTagsComparisonKeys("fire", FIXTURE)).toEqual(["fire"]);
		expect(getArtTagsComparisonKeys("right facing", FIXTURE)).toEqual(["right-facing"]);
	});

	test("an unknown value passes through rather than throwing", () => {
		// A typo has to keep behaving like a tag that matches nothing, not like an error.
		expect(getArtTagsComparisonKeys("no-such-tag-anywhere", FIXTURE)).toEqual(["no-such-tag-anywhere"]);
		expect(getOracleTagsComparisonKeys("no-such-tag-anywhere", FIXTURE)).toEqual(["no-such-tag-anywhere"]);
	});

	test("the two dumps keep separate namespaces", () => {
		// An art spelling must not answer in oracle space. `flames` is an art alias; asking for it
		// as an oracle tag has to stay unresolved rather than borrowing the art dump's mapping.
		expect(FIXTURE.art.has("flames")).toBe(true);
		expect(FIXTURE.oracle.has("flames")).toBe(false);
		expect(getOracleTagsComparisonKeys("flames", FIXTURE)).toEqual(["flames"]);
	});

	test("resolution is idempotent", () => {
		// Feeding a resolved slug back in must be a no-op, which is what makes it safe to run over
		// a generation-3 store whose keys are already stamped.
		const once = getArtTagsComparisonKeys("flames", FIXTURE)[0] as string;
		expect(getArtTagsComparisonKeys(once, FIXTURE)).toEqual([once]);
	});

	test("the map follows the store: a swapped slug resolves to the spelling the build carries", () => {
		// Scryfall made `copy-from-graveyard` the slug and `reanimate-copy` its alias between the
		// August dumps and these. The frozen August map sent the new slug to the retired one and
		// both spellings returned zero on production. With the build's OWN map, both reach the
		// key the store has.
		expect(getOracleTagsComparisonKeys("reanimate-copy", FIXTURE)).toEqual(["copy-from-graveyard"]);
		expect(getOracleTagsComparisonKeys("copy-from-graveyard", FIXTURE)).toEqual(["copy-from-graveyard"]);
	});
});

describe("the tables reach the parse through withTagAliases", () => {
	const rhsOf = (tree: unknown): string[] => {
		const json = JSON.stringify(tree);
		const match = /"rhs":\[("[^"]+")\]/.exec(json);
		return match ? [JSON.parse(match[1] as string)] : [];
	};

	test("a parse with tables resolves the alias inside toJson()", () => {
		expect(rhsOf(parseScryfallQuery("otag:reanimate-copy", FIXTURE))).toEqual(["copy-from-graveyard"]);
		expect(rhsOf(parseScryfallQuery("art:flames", FIXTURE))).toEqual(["fire"]);
	});

	test("a parse without tables takes every spelling as the slug typed", () => {
		// Scripts and fixtures parse with no store in hand; that has to be a plain-slug parse, not
		// a parse through whatever a previous caller left active.
		expect(rhsOf(parseScryfallQuery("otag:reanimate-copy"))).toEqual(["reanimate-copy"]);
		expect(rhsOf(parseScryfallQuery("otag:reanimate-copy", EMPTY_TAG_ALIASES))).toEqual(["reanimate-copy"]);
	});

	test("the scope is restored after the parse, even when it throws", () => {
		expect(() => withTagAliases(FIXTURE, () => parseScryfallQuery("otag:("))).toThrow();
		expect(getArtTagsComparisonKeys("flames")).toEqual(["flames"]);
		withTagAliases(FIXTURE, () => {
			expect(getArtTagsComparisonKeys("flames")).toEqual(["fire"]);
		});
		expect(getArtTagsComparisonKeys("flames")).toEqual(["flames"]);
	});
});

describe("punctuation-blind fallback (Scryfall ignores punctuation in a tag value)", () => {
	const oracle = (v: string, tables = FIXTURE) => getOracleTagsComparisonKeys(v, tables);
	const art = (v: string, tables = FIXTURE) => getArtTagsComparisonKeys(v, tables);

	test("a hyphenated spelling of an unhyphenated alias resolves", () => {
		// api.scryfall.com 2026-11-13: otag:board-wipe = 952 = otag:sweeper. `boardwipe` is the
		// listed alias; `board-wipe` is in neither dump, and it answered 404 here.
		expect(oracle("board-wipe")).toEqual(["sweeper"]);
		expect(oracle("board_wipe")).toEqual(["sweeper"]);
		expect(oracle("Board Wipe")).toEqual(["sweeper"]);
	});

	test("an unhyphenated spelling of a spaced alias resolves", () => {
		// The listed alias is "wrath of god" (slug `wrath-of-god`); Scryfall answers both.
		expect(oracle("wrathofgod")).toEqual(["sweeper"]);
		expect(oracle("massremoval")).toEqual(["sweeper"]);
		expect(art("openmouth")).toEqual(["loose-lips"]);
	});

	test("a slug with an alias is reachable under any punctuation", () => {
		expect(oracle("sw-eeper")).toEqual(["sweeper"]);
	});

	test("a spelling several tags share answers ALL of them", () => {
		// api.scryfall.com 2026-11-13: art:black-beard = art:blackbeard = 14 = black-beard ∪
		// edward-teach (alias "Blackbeard"); art:aura = art:au-ra = 44; art:betor = art:b-etor = 7.
		for (const v of ["black-beard", "blackbeard", "Black Beard"])
			expect(art(v)).toEqual(["black-beard", "edward-teach"]);
		for (const v of ["aura", "au-ra"]) expect(art(v)).toEqual(["au-ra", "aura"]);
		for (const v of ["betor", "b-etor"]) expect(art(v)).toEqual(["b-etor", "betor"]);
		// A spelling one tag owns is still that tag alone.
		expect(art("edward-teach")).toEqual(["edward-teach"]);
		expect(art("edward thatch")).toEqual(["edward-teach"]);
	});

	test("the union is an OR of single-tag leaves, so negation and the engine see one tag per leaf", () => {
		const tree = (q: string) => JSON.parse(JSON.stringify(parseScryfallQuery(q, FIXTURE)));
		const leaf = (slug: string) => ({
			node_type: "CardBinaryOperatorNode",
			kwargs: expect.objectContaining({ op: ":", rhs: [slug] }),
		});
		expect(tree("art:blackbeard")).toEqual({
			node_type: "OrNode",
			kwargs: { operands: [leaf("black-beard"), leaf("edward-teach")] },
		});
		expect(tree("-art:blackbeard")).toEqual({
			node_type: "NotNode",
			kwargs: { operand: { node_type: "OrNode", kwargs: { operands: [leaf("black-beard"), leaf("edward-teach")] } } },
		});
		expect(tree("art:fire")).toEqual(leaf("fire"));
	});

	test("a map published without fold groups keeps the fallback off", () => {
		// Older builds' maps carry none; folding without them could redirect a real slug.
		const legacy = { oracle: FIXTURE.oracle, art: FIXTURE.art };
		expect(oracle("board-wipe", legacy)).toEqual(["board-wipe"]);
		expect(oracle("boardwipe", legacy)).toEqual(["sweeper"]);
		expect(art("black-beard", legacy)).toEqual(["black-beard"]);
	});

	test("half the fold groups is a malformed map", () => {
		expect(() => parseTagAliasTables('{"oracle":{},"art":{},"oracle_fold_groups":{}}')).toThrow();
		expect(() =>
			parseTagAliasTables('{"oracle":{},"art":{},"oracle_fold_groups":{},"art_fold_groups":{"a":["a"]}}'),
		).toThrow();
	});

	for (const [name, map, keys, groups] of [
		["oracle", FIXTURE.oracle, oracle, FIXTURE.foldGroups?.oracle],
		["art", FIXTURE.art, art, FIXTURE.foldGroups?.art],
	] as const) {
		test(`${name}: every listed alias and alias target still resolves exactly, unless it is a shared spelling`, () => {
			// The fallback only runs on a miss, so it can never change an exact hit — except where the
			// spelling is shared, and then the answer is the whole group (Scryfall's union).
			const fold = (s: string) => s.replaceAll("-", "");
			const expected = (slug: string, own: string) => groups?.get(fold(own)) ?? [slug];
			for (const [alias, slug] of map) {
				expect(keys(alias)).toEqual([...expected(slug, alias)]);
				expect(keys(slug)).toEqual([...expected(slug, slug)]);
			}
		});
	}
});
