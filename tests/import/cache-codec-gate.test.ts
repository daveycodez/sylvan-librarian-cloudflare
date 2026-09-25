// r3: the nightly pool gate that decides whether engine objects may cache the build as LZ4
// (x1.449 the bytes, ~3x cheaper to decode on every wake) or must stay on gzip.

import { describe, expect, test } from "bun:test";
import {
	cacheHighWaterFactor,
	decideCacheCodec,
	LZ4_CACHE_RATIO,
	LZ4_OFF_FRACTION,
	LZ4_ON_FRACTION,
	MAX_POOL_WAITS,
	manifestPoolShardCap,
	POOL_GATE_BUDGET_BYTES,
	POOL_WAIT_MS,
	poolAdmitsRun,
	poolShardCap,
	projectCachePool,
	projectPoolBytes,
	STAGING_PEAK_BYTES_2026_09_25,
	stagingBytesOf,
} from "../../src/import-budget";

// Generation 52 as the deploy path publishes it (gzip level 9), measured 2026-09-25 over every
// partition in store-build/: 146.7MB gzip, 212.6MB as the engine's LZ4 frames.
const GEN52_GZIP = [
	14_227_000, 14_714_000, 15_264_000, 14_137_000, 14_888_000, 14_643_000, 14_792_000, 14_317_000, 14_378_000,
	15_311_000,
];
const GEN52_LZ4 = [
	20_620_000, 21_380_000, 22_090_000, 20_470_000, 21_610_000, 21_220_000, 21_420_000, 20_740_000, 20_830_000,
	22_170_000,
];

const pool = (replicas: number, corpus: number, factor: number) =>
	projectCachePool({
		replicas,
		partitionGzipBytes: GEN52_GZIP.map((b) => b * corpus),
		cacheFactor: factor,
		stagingPeakBytes: STAGING_PEAK_BYTES_2026_09_25 * corpus,
		strandedBytes: 0,
	});

describe("the LZ4 ratio constant", () => {
	test("is at or above every measured partition", () => {
		for (let k = 0; k < GEN52_GZIP.length; k++) {
			expect(LZ4_CACHE_RATIO).toBeGreaterThanOrEqual((GEN52_LZ4[k] as number) / (GEN52_GZIP[k] as number));
		}
		// And the one partition report 20 measured in workerd (gen 51 p1: 21,354,566 / 14,669,489).
		expect(LZ4_CACHE_RATIO).toBeGreaterThanOrEqual(21_354_566 / 14_669_489);
	});
});

describe("projectCachePool", () => {
	test("under gzip it IS the one-generation projection: drop, then fill (x1)", () => {
		for (const replicas of [8, 11]) {
			expect(pool(replicas, 1, 1)).toBe(
				projectPoolBytes({
					warmRegions: replicas,
					generationsHeld: 1,
					partitionGzipBytes: GEN52_GZIP,
					stagingPeakBytes: STAGING_PEAK_BYTES_2026_09_25,
				}),
			);
		}
	});

	test("under LZ4 a replica peaks at its LZ4 copy — never LZ4 plus the prefetched gzip, never two builds", () => {
		expect(cacheHighWaterFactor(1)).toBe(1);
		expect(cacheHighWaterFactor(LZ4_CACHE_RATIO)).toBe(LZ4_CACHE_RATIO);
		const perBuild = GEN52_GZIP.reduce((s, b) => s + b, 0);
		expect(pool(8, 1, LZ4_CACHE_RATIO) - pool(8, 1, 1)).toBeCloseTo(8 * perBuild * (LZ4_CACHE_RATIO - 1), 0);
	});

	test("stranded staging from a failover counts in full", () => {
		const base = pool(8, 1, LZ4_CACHE_RATIO);
		const withStranded = projectCachePool({
			replicas: 8,
			partitionGzipBytes: GEN52_GZIP,
			cacheFactor: LZ4_CACHE_RATIO,
			stagingPeakBytes: STAGING_PEAK_BYTES_2026_09_25,
			strandedBytes: STAGING_PEAK_BYTES_2026_09_25,
		});
		expect(withStranded - base).toBe(STAGING_PEAK_BYTES_2026_09_25);
	});
});

describe("decideCacheCodec", () => {
	const on = LZ4_ON_FRACTION * POOL_GATE_BUDGET_BYTES;
	const off = LZ4_OFF_FRACTION * POOL_GATE_BUDGET_BYTES;

	test("turns LZ4 on only at or under the lower threshold", () => {
		expect(decideCacheCodec(undefined, on)).toBe("lz4");
		expect(decideCacheCodec("gzip", on + 1)).toBe("gzip");
	});

	test("turns it off as soon as the upper threshold is passed", () => {
		expect(decideCacheCodec("lz4", off)).toBe("lz4");
		expect(decideCacheCodec("lz4", off + 1)).toBe("gzip");
	});

	test("inside the band it keeps what the previous manifest published", () => {
		const mid = (on + off) / 2;
		expect(decideCacheCodec("lz4", mid)).toBe("lz4");
		expect(decideCacheCodec("gzip", mid)).toBe("gzip");
		expect(decideCacheCodec(undefined, mid)).toBe("gzip");
	});

	test("an unusable projection is gzip", () => {
		expect(decideCacheCodec("lz4", Number.NaN)).toBe("gzip");
		expect(decideCacheCodec("lz4", 0)).toBe("gzip");
		expect(decideCacheCodec("lz4", Number.POSITIVE_INFINITY)).toBe("gzip");
	});
});

describe("the gate on today's corpus", () => {
	test("1x: LZ4 turns on for every replica count up to all eleven hints served separately", () => {
		expect(decideCacheCodec(undefined, pool(8, 1, LZ4_CACHE_RATIO))).toBe("lz4"); // ~2.26GB (was 3.43)
		expect(decideCacheCodec(undefined, pool(9, 1, LZ4_CACHE_RATIO))).toBe("lz4"); // ~2.47GB
		expect(decideCacheCodec(undefined, pool(11, 1, LZ4_CACHE_RATIO))).toBe("lz4"); // ~2.91GB (was 4.53, refused)
	});

	test("2026-09-25's free-account refusal does not recur: 4.94GB was the double hold plus released staging", () => {
		// The Pool gate line: 8 replicas, staging 0.50GB, 3 failovers → 4.94GB, gzip. Reproduce it the
		// way it was computed — each replica at cache + prefetch, and one staging peak per failover
		// of the last 24h although x8 had released all three at 05:40 — and then the way it is now.
		const staging = 0.5e9;
		const perBuild = GEN52_GZIP.reduce((s, b) => s + b, 0);
		const before = 8 * perBuild * (LZ4_CACHE_RATIO + 1) + staging + 3 * staging;
		expect(before / 1e9).toBeCloseTo(4.93, 1);
		expect(decideCacheCodec("gzip", before)).toBe("gzip");
		const released = projectCachePool({
			replicas: 8,
			partitionGzipBytes: GEN52_GZIP,
			cacheFactor: LZ4_CACHE_RATIO,
			stagingPeakBytes: staging,
			strandedBytes: 0,
		});
		expect(decideCacheCodec("gzip", released)).toBe("lz4"); // ~2.26GB
		// Even had all three still been retiring, it fits the ON threshold now.
		expect(decideCacheCodec("gzip", released + 3 * staging)).toBe("lz4"); // ~3.76GB
	});

	test("2x: LZ4 is refused, and gzip fits with room (x1 removed the double hold)", () => {
		expect(decideCacheCodec("lz4", pool(8, 2, LZ4_CACHE_RATIO))).toBe("gzip"); // ~4.51GB
		expect(pool(8, 2, 1)).toBeLessThan(0.7 * POOL_GATE_BUDGET_BYTES); // ~3.34GB
	});

	test("3x: gzip fits for the eight routable regions only because the drafts are level 6", () => {
		// At level 1 staging it is right at the line (~5.01GB); DRAFT_CODEC_LEVEL 6 takes ~20% off
		// the drafts, ~80% of the staging peak (report 13's composition), which puts it under.
		expect(pool(8, 3, 1)).toBeGreaterThan(0.99 * POOL_GATE_BUDGET_BYTES);
		const stagingL6 = STAGING_PEAK_BYTES_2026_09_25 * (1 - 0.8 * 0.204);
		const l6 = projectCachePool({
			replicas: 8,
			partitionGzipBytes: GEN52_GZIP.map((b) => b * 3),
			cacheFactor: 1,
			stagingPeakBytes: stagingL6 * 3,
			strandedBytes: 0,
		});
		expect(l6).toBeLessThan(0.96 * POOL_GATE_BUDGET_BYTES); // ~4.76GB
	});

	test("one more replica on an in-band night never takes a gated LZ4 pool past the budget", () => {
		// The worst in-band night: LZ4 held right at the OFF threshold, then a shard opens in one
		// region before the next gate runs. It holds one build as LZ4 (its fill drops the gzip first).
		const replica = GEN52_GZIP.reduce((s, b) => s + b, 0) * cacheHighWaterFactor(LZ4_CACHE_RATIO);
		expect(LZ4_OFF_FRACTION * POOL_GATE_BUDGET_BYTES + replica).toBeLessThan(POOL_GATE_BUDGET_BYTES);
	});
});

describe("x1(b): the pool-aware shard cap", () => {
	const cap = (corpus: number, factor: number, regions = 8) =>
		poolShardCap({
			regions,
			partitionGzipBytes: GEN52_GZIP.map((b) => b * corpus),
			cacheFactor: factor,
			stagingPeakBytes: STAGING_PEAK_BYTES_2026_09_25 * corpus,
		});

	test("today: 3 replicas a region under gzip caches, 2 under LZ4; 1 at 2x and 3x", () => {
		expect(cap(1, 1)).toBe(3);
		expect(cap(1, LZ4_CACHE_RATIO)).toBe(2);
		expect(cap(2, 1)).toBe(1);
		expect(cap(3, 1)).toBe(1);
	});

	test("every region at the cap stays under the gate's OFF threshold — the cap and the codec agree", () => {
		for (const corpus of [1, 1.5, 2]) {
			for (const factor of [1, LZ4_CACHE_RATIO]) {
				const c = cap(corpus, factor) as number;
				if (c === 1) continue; // shard 0 exists whatever the pool says
				expect(pool(8 * c, corpus, factor)).toBeLessThanOrEqual(LZ4_OFF_FRACTION * POOL_GATE_BUDGET_BYTES);
				expect(pool(8 * (c + 1), corpus, factor)).toBeGreaterThan(LZ4_OFF_FRACTION * POOL_GATE_BUDGET_BYTES);
			}
		}
	});

	test("an undecidable manifest (no sizes, no regions) leaves SHARDS_MAX alone", () => {
		expect(poolShardCap({ regions: 8, partitionGzipBytes: [], cacheFactor: 1, stagingPeakBytes: 0 })).toBeNull();
		expect(cap(1, 1, 0)).toBeNull();
		expect(manifestPoolShardCap({}, 8)).toBeNull();
	});

	test("reads the codec and the measured staging off the manifest", () => {
		const partitions = GEN52_GZIP.map((b) => ({ store_gzip_bytes: b }));
		expect(manifestPoolShardCap({ partitions, store_bytes: 425_181_152 }, 8)).toBe(3);
		expect(manifestPoolShardCap({ partitions, cache: { v: 1, codec: "lz4", staging_bytes: 5e8 } }, 8)).toBe(2);
		// An unknown block version is gzip, as cacheCodecOf reads it.
		expect(manifestPoolShardCap({ partitions, cache: { v: 2, codec: "lz4", staging_bytes: 5e8 } }, 8)).toBe(3);
	});

	test("stagingBytesOf prefers last night's measurement, else scales the 2026-09-25 reading by the store", () => {
		expect(stagingBytesOf({ cache: { staging_bytes: 123 } })).toBe(123);
		expect(stagingBytesOf({ store_bytes: 425_181_152 })).toBe(STAGING_PEAK_BYTES_2026_09_25);
		expect(stagingBytesOf({ store_bytes: 2 * 425_181_152, cache: { staging_bytes: 0 } })).toBe(
			2 * STAGING_PEAK_BYTES_2026_09_25,
		);
	});
});

describe("x1(c): a run waits at listing while retiring coordinators' staging would not fit", () => {
	const admits = (retiring: number, corpus: number, factor = 1) =>
		poolAdmitsRun({
			retiring,
			replicas: 8,
			partitionGzipBytes: GEN52_GZIP.map((b) => b * corpus),
			cacheFactor: factor,
			stagingPeakBytes: STAGING_PEAK_BYTES_2026_09_25 * corpus,
		});

	test("nothing retiring always starts", () => {
		expect(admits(0, 10)).toBe(true);
	});

	test("today even three stranded runs fit; at 3x one does not", () => {
		expect(admits(3, 1, LZ4_CACHE_RATIO)).toBe(true);
		expect(admits(1, 2)).toBe(true);
		expect(admits(1, 3)).toBe(false);
	});

	test("the wait is bounded: a wedged retiring object is not waited on all night", () => {
		expect(POOL_WAIT_MS * MAX_POOL_WAITS).toBeLessThanOrEqual(60 * 60_000);
		expect(POOL_WAIT_MS).toBeLessThan(12 * 60_000); // under the watchdog's STALL_MS: each wait banks
	});
});
