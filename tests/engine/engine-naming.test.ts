// The partition-aware engine naming scheme (CARD-PARTITIONING §2).
//
// Names are load-bearing state: an object's name is the only channel carrying
// which REGION it serves, which REPLICA it is, and which SLICE OF THE DATA it
// holds. The suffix-less form is still parsed, but it names a REPLICA GROUP
// (what the shard controller counts) rather than an object that loads a store —
// and a parse change that misread `engine-wnam-2` as partition 2 would misroute
// every request in the region.

import { describe, expect, test } from "bun:test";
import {
	engineName,
	parseEngineName,
	placeEngineStub,
	regionOfEngineName,
	replicaGroupOf,
	siblingEngineName,
} from "../../src/engine/engine-namespace";
import { gatherPartitionOf } from "../../src/engine/partition";
import { REGION_HINTS } from "../../src/engine/region";
import type { Env } from "../../src/engine/types";

describe("engineName carries the partition last", () => {
	test("omitting the partition yields the replica-group name", () => {
		expect(engineName("wnam", 0)).toBe("engine-wnam");
		expect(engineName("wnam", 2)).toBe("engine-wnam-2");
		// An explicit undefined must not differ from omission — replicaGroupOf
		// depends on the two spellings agreeing.
		expect(engineName("wnam", 0, undefined)).toBe("engine-wnam");
	});

	test("partitioned names suffix -p<k> after the shard", () => {
		expect(engineName("wnam", 0, 0)).toBe("engine-wnam-p0");
		expect(engineName("wnam", 0, 3)).toBe("engine-wnam-p3");
		expect(engineName("wnam", 2, 3)).toBe("engine-wnam-2-p3");
	});
});

describe("names round-trip through the parser", () => {
	test("every combination of region, shard and partition", () => {
		for (const region of REGION_HINTS) {
			for (const shard of [0, 1, 7]) {
				for (const partition of [undefined, 0, 5, 12]) {
					const name = engineName(region, shard, partition);
					expect(parseEngineName(name)).toEqual(
						partition === undefined ? { region, shard } : { region, shard, partition },
					);
					expect(regionOfEngineName(name)).toBe(region);
				}
			}
		}
	});

	test("non-engine names parse to null", () => {
		for (const bad of ["singleton", "engine-", "engine-wnam-p", "engine-wnam-p1-2", "engine-1wnam", ""]) {
			expect(parseEngineName(bad)).toBeNull();
			expect(regionOfEngineName(bad)).toBeNull();
		}
	});

	test("the shard suffix is not mistaken for a partition", () => {
		// `engine-wnam-2` is REPLICA 2 of the whole store, not partition 2.
		expect(parseEngineName("engine-wnam-2")).toEqual({ region: "wnam", shard: 2 });
	});
});

describe("replica grouping — the width parser's unit", () => {
	test("all partitions of one replica group together", () => {
		// The stale-shard release and width parsing must count engine-wnam-2-p0
		// through -p7 as ONE replica; releasing some partitions of a replica while
		// keeping others would leave that replica serving a store with holes.
		expect(replicaGroupOf("engine-wnam-2-p0")).toBe("engine-wnam-2");
		expect(replicaGroupOf("engine-wnam-2-p7")).toBe("engine-wnam-2");
		expect(replicaGroupOf("engine-wnam-p3")).toBe("engine-wnam");
	});

	test("a group name is its own group", () => {
		expect(replicaGroupOf("engine-wnam")).toBe("engine-wnam");
		expect(replicaGroupOf("engine-wnam-2")).toBe("engine-wnam-2");
		expect(replicaGroupOf("not-an-engine")).toBeNull();
	});
});

describe("sibling derivation — the gather's addressing", () => {
	test("keeps region and replica, swaps the partition", () => {
		expect(siblingEngineName("engine-wnam-p0", 3)).toBe("engine-wnam-p3");
		expect(siblingEngineName("engine-wnam-2-p5", 0)).toBe("engine-wnam-2-p0");
	});

	test("a group label can still name a partition sibling", () => {
		expect(siblingEngineName("engine-wnam", 2)).toBe("engine-wnam-p2");
	});

	test("a non-engine label yields null, never a guessed name", () => {
		expect(siblingEngineName("singleton", 0)).toBeNull();
	});
});

describe("placement carries the partition", () => {
	function fakeEnv() {
		const gets: { name: string; options?: { locationHint?: string } }[] = [];
		const env = {
			SEARCH_ENGINE: {
				idFromName: (name: string) => ({ name }),
				get: (id: { name: string }, options?: { locationHint?: string }) => {
					gets.push({ name: id.name, ...(options ? { options } : {}) });
					return {};
				},
			},
		} as unknown as Env;
		return { env, gets };
	}

	test("a partition object is created under its partitioned name, hinted into its region", () => {
		const { env, gets } = fakeEnv();
		placeEngineStub(env, "weur", 0, 4);
		placeEngineStub(env, "weur", 1, 0);
		expect(gets.map((g) => g.name)).toEqual(["engine-weur-p4", "engine-weur-1-p0"]);
		for (const g of gets) expect(g.options?.locationHint).toBe("weur");
	});

	test("no partition argument places the replica-group name", () => {
		const { env, gets } = fakeEnv();
		placeEngineStub(env, "wnam", 0);
		expect(gets.map((g) => g.name)).toEqual(["engine-wnam"]);
	});
});

describe("the gather partition spread", () => {
	test("is deterministic and in range", () => {
		for (const q of ["t:goblin", "lightning bolt", "", "lang:ja o:draw"]) {
			const p = gatherPartitionOf(q, 8);
			expect(p).toBe(gatherPartitionOf(q, 8));
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThan(8);
		}
	});

	test("spreads distinct queries across partitions", () => {
		const hits = new Set<number>();
		for (let i = 0; i < 64; i++) hits.add(gatherPartitionOf(`query-${i}`, 8));
		expect(hits.size).toBeGreaterThan(4);
	});
});
