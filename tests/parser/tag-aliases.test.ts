/**
 * The alias map is the half of upstream #914 this port moved from import time to query time.
 *
 * Upstream stamps every alias into `card_oracle_tags` / `card_art_tags` as an extra key, so the
 * query side can stay a dumb exact match. Here the store holds only canonical slugs and the map
 * below does the resolving, because those keys measured 6,252,880 bytes of archive and bought the
 * store a fourth KV chunk (see src/engine/store-kv.ts).
 *
 * That split is worth testing precisely because it cannot fail loudly. If the map and the
 * slugifier ever disagree, or the builder starts stamping again, or an alias goes missing, nothing
 * throws — `art:flames` just returns zero results, which is the exact state #914 existed to fix.
 */

import { describe, expect, test } from "bun:test";
import { getArtTagsComparisonKeys, getOracleTagsComparisonKeys, slugifyTag } from "../../src/parser/card-query-nodes";
import { ART_TAG_ALIASES, ORACLE_TAG_ALIASES } from "../../src/parser/tag-aliases.gen";

const MAPS = [
	["oracle", ORACLE_TAG_ALIASES],
	["art", ART_TAG_ALIASES],
] as const;

describe("the generated alias map is well formed", () => {
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
		expect(getArtTagsComparisonKeys("flames")).toEqual(["fire"]);
	});

	test("a spaced alias spelling reaches the same slug", () => {
		// The two halves of #914 compose: slugifyTag folds "open mouth" to "open-mouth", the map
		// then resolves that alias to the slug the store actually carries.
		expect(getArtTagsComparisonKeys("open mouth")).toEqual(["loose-lips"]);
		expect(getArtTagsComparisonKeys("open-mouth")).toEqual(["loose-lips"]);
		expect(getArtTagsComparisonKeys("Open Mouth")).toEqual(["loose-lips"]);
	});

	test("a canonical slug is returned untouched", () => {
		expect(getArtTagsComparisonKeys("fire")).toEqual(["fire"]);
		expect(getArtTagsComparisonKeys("right facing")).toEqual(["right-facing"]);
	});

	test("an unknown value passes through rather than throwing", () => {
		// A typo has to keep behaving like a tag that matches nothing, not like an error.
		expect(getArtTagsComparisonKeys("no-such-tag-anywhere")).toEqual(["no-such-tag-anywhere"]);
		expect(getOracleTagsComparisonKeys("no-such-tag-anywhere")).toEqual(["no-such-tag-anywhere"]);
	});

	test("the two dumps keep separate namespaces", () => {
		// An art spelling must not answer in oracle space. `flames` is an art alias; asking for it
		// as an oracle tag has to stay unresolved rather than borrowing the art dump's mapping.
		expect(ART_TAG_ALIASES.has("flames")).toBe(true);
		expect(ORACLE_TAG_ALIASES.has("flames")).toBe(false);
		expect(getOracleTagsComparisonKeys("flames")).toEqual(["flames"]);
	});

	test("resolution is idempotent", () => {
		// Feeding a resolved slug back in must be a no-op, which is what makes it safe to run over
		// a generation-3 store whose keys are already stamped.
		const once = getArtTagsComparisonKeys("flames")[0] as string;
		expect(getArtTagsComparisonKeys(once)).toEqual([once]);
	});
});
