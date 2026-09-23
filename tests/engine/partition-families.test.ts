// partition.ts's family arithmetic: a manifest without families is one run over every partition
// (today's layout), and with families every helper stays inside the run it is handed.

import { describe, expect, test } from "bun:test";
import {
	defaultFamilyOf,
	familiesOf,
	familyForLang,
	familyOfPartition,
	gatherPartitionIn,
	layoutKeyOf,
	partitionOfOracleId,
	partitionOfOracleIdIn,
	partitionsOf,
} from "../../src/engine/partition";

const FAMILIES = [
	{ lang: "en", start: 0, count: 4 },
	{ lang: "de", start: 4, count: 2 },
	{ lang: "ja", start: 6, count: 1 },
];

describe("a single-family manifest", () => {
	test("is one en run over every partition, so the owner is the plain modulus", () => {
		const manifest = { partition_count: 10 };
		expect(familiesOf(manifest)).toEqual([{ lang: "en", start: 0, count: 10 }]);
		expect(defaultFamilyOf(manifest).count).toBe(10);
		const id = "aa686c34-cf28-4d4a-bcef-5a34cccdbf87";
		expect(partitionOfOracleIdIn(defaultFamilyOf(manifest), id)).toBe(partitionOfOracleId(id, 10));
		expect(familyForLang(manifest, "de")).toBeNull();
		expect(familyOfPartition(manifest, 9)?.lang).toBe("en");
		expect(familyOfPartition(manifest, 10)).toBeNull();
	});
});

describe("the layout key a pinned search carries", () => {
	test("names count and families, so same-layout builds pin-compatibly and different ones do not", () => {
		expect(layoutKeyOf({ partition_count: 10 })).toBe("10|en:0:10");
		expect(layoutKeyOf({ partition_count: 7, families: FAMILIES })).toBe("7|en:0:4,de:4:2,ja:6:1");
		expect(layoutKeyOf({ partition_count: 7, families: FAMILIES })).not.toBe(layoutKeyOf({ partition_count: 7 }));
	});
});

describe("a family manifest", () => {
	const manifest = { partition_count: 7, families: FAMILIES };

	test("finds a family by language and a partition's family by index", () => {
		expect(familyForLang(manifest, "de")).toEqual({ lang: "de", start: 4, count: 2 });
		expect(familyForLang(manifest, "fr")).toBeNull();
		expect(familyOfPartition(manifest, 5)?.lang).toBe("de");
		expect(familyOfPartition(manifest, 6)?.lang).toBe("ja");
		expect(familyOfPartition(manifest, 7)).toBeNull();
		expect(partitionsOf(FAMILIES[1] as (typeof FAMILIES)[number])).toEqual([4, 5]);
	});

	test("owners and gather coordinators land inside their family's run", () => {
		for (let i = 0; i < 200; i++) {
			const id = `aa686c34-cf28-4d4a-bcef-${String(i).padStart(12, "0")}`;
			for (const family of FAMILIES) {
				const owner = partitionOfOracleIdIn(family, id);
				expect(owner).toBeGreaterThanOrEqual(family.start);
				expect(owner).toBeLessThan(family.start + family.count);
				// The same hash, offset: within the run it is exactly the single-family modulus.
				expect(owner - family.start).toBe(partitionOfOracleId(id, family.count));
				const coordinator = gatherPartitionIn(family, `t:goblin ${i}`);
				expect(coordinator).toBeGreaterThanOrEqual(family.start);
				expect(coordinator).toBeLessThan(family.start + family.count);
			}
		}
	});
});
