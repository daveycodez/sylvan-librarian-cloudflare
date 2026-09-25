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

	test("a hyphenated hint is one region, not a region plus a shard (backlog g2)", () => {
		// `[a-z]+` read `engine-apac-ne-p3` as region `apac` followed by garbage: null, so the loader
		// would have refused every apac-ne/apac-se object. Longest-first alternation fixes it.
		expect(parseEngineName("engine-apac-ne-p3")).toEqual({ region: "apac-ne", shard: 0, partition: 3 });
		expect(parseEngineName("engine-apac-se-2-p0")).toEqual({ region: "apac-se", shard: 2, partition: 0 });
		expect(parseEngineName("engine-apac-3-p1")).toEqual({ region: "apac", shard: 3, partition: 1 });
		expect(replicaGroupOf("engine-apac-ne-1-p7")).toBe("engine-apac-ne-1");
	});

	test("a region that is not a location hint is not an engine name", () => {
		// The colo-era objects (engine-LAX…) and anything invented stay unparseable.
		for (const bad of ["engine-LAX", "engine-lax-p1", "engine-apac-nw-p1", "engine-asia"]) {
			expect(parseEngineName(bad)).toBeNull();
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

describe("the region's generation (backlog g1)", () => {
	test("generation 0 is today's name, byte for byte, so no object is abandoned on deploy", () => {
		expect(engineName("sam", 0, 3, 0)).toBe("engine-sam-p3");
		expect(engineName("sam", 2, 3, 0)).toBe(engineName("sam", 2, 3));
	});

	test("a generation sits between the hint and the shard", () => {
		expect(engineName("sam", 0, 3, 1)).toBe("engine-sam-g1-p3");
		expect(engineName("apac-ne", 2, 0, 12)).toBe("engine-apac-ne-g12-2-p0");
		expect(engineName("sam", 0, undefined, 1)).toBe("engine-sam-g1");
	});

	test("every hint × generation × shard × partition round-trips", () => {
		for (const region of REGION_HINTS) {
			for (const generation of [0, 1, 12]) {
				for (const shard of [0, 3]) {
					for (const partition of [undefined, 0, 9]) {
						const name = engineName(region, shard, partition, generation);
						expect(parseEngineName(name)).toEqual({
							region,
							shard,
							...(partition === undefined ? {} : { partition }),
							...(generation === 0 ? {} : { generation }),
						});
					}
				}
			}
		}
	});

	test("replica groups and siblings keep the generation", () => {
		expect(replicaGroupOf("engine-sam-g1-2-p7")).toBe("engine-sam-g1-2");
		expect(siblingEngineName("engine-sam-g1-p0", 4)).toBe("engine-sam-g1-p4");
		// A different generation is a different replica group: its width is its own.
		expect(replicaGroupOf("engine-sam-g1-p0")).not.toBe(replicaGroupOf("engine-sam-p0"));
	});

	test("-g0 has no spelling, and a generation is not mistaken for a shard", () => {
		expect(parseEngineName("engine-sam-g0-p1")).toBeNull();
		expect(parseEngineName("engine-sam-g01-p1")).toBeNull();
		expect(parseEngineName("engine-sam-1-p1")).toEqual({ region: "sam", shard: 1, partition: 1 });
	});

	test("placing a generation hints the object into its own region", () => {
		const gets: { name: string; hint?: string }[] = [];
		const env = {
			SEARCH_ENGINE: {
				idFromName: (name: string) => ({ name }),
				get: (id: { name: string }, options?: { locationHint?: string }) => {
					gets.push({ name: id.name, hint: options?.locationHint });
					return {};
				},
			},
		} as unknown as Env;
		placeEngineStub(env, "sam", 0, 2, 1);
		expect(gets).toEqual([{ name: "engine-sam-g1-p2", hint: "sam" }]);
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
