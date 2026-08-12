// Which keys a publish retires.
//
// The predicate is three lines and the consequence is not: it is what the nightly import and the
// deploy both hand to `delete`. Too greedy and it removes the keys currently being served; too shy
// and a layout change leaks a whole namespace, which is exactly what happened when `reference:v1:*`
// was orphaned by the bump to v2.

import { describe, expect, test } from "bun:test";
import { staleKeys } from "../../src/engine/kv-versions";

describe("staleKeys", () => {
	const keys = [
		"reference:v1:sets:list",
		"reference:v1:catalog:card-names",
		"reference:v2:sets:list",
		"reference:v2:catalog:card-names",
		"reference:meta",
		"rulings:v2:00",
		"store:manifest",
		"card-store-v11-123.store.0",
	];

	test("retires older layouts and nothing else", () => {
		expect(staleKeys(keys, "reference:v", "reference:v2:")).toEqual([
			"reference:v1:sets:list",
			"reference:v1:catalog:card-names",
		]);
	});

	test("leaves the current layout alone", () => {
		const stale = staleKeys(keys, "reference:v", "reference:v2:");
		expect(stale).not.toContain("reference:v2:sets:list");
		expect(stale).not.toContain("reference:v2:catalog:card-names");
	});

	test("never touches another dataset, or the meta key that commits this one", () => {
		const stale = staleKeys(keys, "reference:v", "reference:v2:");
		// `reference:meta` does not carry a version and is the commit point — deleting it would say
		// "nothing published" to the next deploy, which would then republish the whole set.
		expect(stale).not.toContain("reference:meta");
		expect(stale).not.toContain("rulings:v2:00");
		expect(stale).not.toContain("store:manifest");
		expect(stale).not.toContain("card-store-v11-123.store.0");
	});

	test("a first publish has nothing to retire", () => {
		expect(staleKeys(["rulings:v2:00", "rulings:meta"], "rulings:v", "rulings:v2:")).toEqual([]);
	});

	test("a version whose number is a prefix of another is not swept up", () => {
		// `v1:` must not match `v10:` — the trailing colon in the current prefix is what stops it,
		// and the same colon is why `reference:v2:` cannot match `reference:v20:`.
		expect(staleKeys(["reference:v10:sets:list"], "reference:v", "reference:v1:")).toEqual(["reference:v10:sets:list"]);
		expect(staleKeys(["reference:v10:sets:list"], "reference:v", "reference:v10:")).toEqual([]);
	});
});
