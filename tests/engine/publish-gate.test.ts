// The publish gate (src/engine/publish-gate.ts): a store that has lost content against the live one
// is not published. The numbers are the 2026-11-19 outage's own, off the two manifests and the
// import's log lines.

import { describe, expect, test } from "bun:test";
import { publishRegressions, shrinkRefusal, tagAliasCounts } from "../../src/engine/publish-gate";
import type { StoreManifest } from "../../src/engine/types";

/** The store that was live at 23:10 UTC on 2026-11-19 (build 1795084669), as its manifest described it. */
const LIVE = {
	store_key: "card-store-v2026101004-1795084669.store",
	built_at: "1795084669",
	format_version: 2026101004,
	content_generation: 97,
	card_count: 39_356,
	printing_count: 120_211,
	store_bytes: 448_600_000,
	names_bytes: 620_020,
	printed_bytes: 1_325_247,
	otags_bytes: 31_515,
	tag_alias_counts: { oracle: 857, art: 1_433 },
} as unknown as StoreManifest;
const next = (over: Partial<StoreManifest>): StoreManifest =>
	({ ...LIVE, store_key: "card-store-v2026101004-1795130185.store", built_at: "1795130185", ...over }) as StoreManifest;

describe("publishRegressions", () => {
	test("the same content, or more of it, publishes", () => {
		expect(publishRegressions(next({}), LIVE)).toEqual([]);
		expect(
			publishRegressions(next({ card_count: 39_420, printing_count: 120_600, otags_bytes: 31_700 }), LIVE),
		).toEqual([]);
		// A few cards fewer is an ordinary night.
		expect(publishRegressions(next({ card_count: 39_300 }), LIVE)).toEqual([]);
	});

	test("the 2026-11-19 store — no oracle tags — is refused twice over", () => {
		const outage = next({ otags_bytes: 61, tag_alias_counts: { oracle: 0, art: 1_433 } });
		expect(publishRegressions(outage, LIVE)).toEqual([
			"oracle tag aliases 0, where the live store has 857 (under 80%)",
			"oracle tags blob bytes 61, where the live store has 31,515 (under 80%)",
		]);
		expect(shrinkRefusal(outage.store_key, publishRegressions(outage, LIVE))).toContain("ALLOW_STORE_SHRINK=1");
	});

	test("a full-sized dump that parsed to half its tags is refused; so is a corpus that lost cards", () => {
		expect(publishRegressions(next({ tag_alias_counts: { oracle: 857, art: 600 } }), LIVE)).toEqual([
			"art tag aliases 600, where the live store has 1,433 (under 80%)",
		]);
		expect(publishRegressions(next({ card_count: 30_000, printing_count: 90_000 }), LIVE).length).toBe(2);
		// A blob the new build did not publish at all counts as zero.
		const { otags_bytes: _none, ...without } = next({});
		expect(publishRegressions(without as StoreManifest, LIVE).length).toBe(1);
	});

	test("a new archive format or content generation may shrink the bytes, never the counts", () => {
		const relaid = next({ content_generation: 98, store_bytes: 300_000_000, names_bytes: 100, otags_bytes: 100 });
		expect(publishRegressions(relaid, LIVE)).toEqual([]);
		expect(publishRegressions({ ...relaid, card_count: 20_000 } as StoreManifest, LIVE).length).toBe(1);
	});

	test("what the live manifest does not say gates nothing — and neither does no live manifest", () => {
		const { tag_alias_counts: _c, otags_bytes: _o, ...old } = LIVE as StoreManifest & Record<string, unknown>;
		expect(
			publishRegressions(next({ otags_bytes: 61, tag_alias_counts: { oracle: 0, art: 0 } }), old as StoreManifest),
		).toEqual([]);
		expect(publishRegressions(next({ card_count: 1 }), null)).toEqual([]);
	});
});

describe("tagAliasCounts", () => {
	test("counts each table of the alias map, and says nothing about a map that does not parse", () => {
		expect(tagAliasCounts(JSON.stringify({ oracle: { a: "x", b: "y" }, art: { c: "z" } }))).toEqual({
			oracle: 2,
			art: 1,
		});
		expect(tagAliasCounts(JSON.stringify({ art: { c: "z" } }))).toEqual({ oracle: 0, art: 1 });
		expect(tagAliasCounts("not json")).toBeUndefined();
		expect(tagAliasCounts(null)).toBeUndefined();
	});
});
