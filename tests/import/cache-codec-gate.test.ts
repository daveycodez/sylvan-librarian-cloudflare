// r3: the nightly pool gate that decides whether engine objects may cache the build as LZ4
// (x1.449 the bytes, ~3x cheaper to decode on every wake) or must stay on gzip.

import { describe, expect, test } from "bun:test";
import {
	decideCacheCodec,
	LZ4_CACHE_RATIO,
	LZ4_OFF_FRACTION,
	LZ4_ON_FRACTION,
	POOL_GATE_BUDGET_BYTES,
	projectCachePool,
	projectPoolBytes,
	STAGING_PEAK_BYTES_2026_09_25,
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
	test("under gzip it IS the existing double-hold projection: old cache plus the new build's prefetch", () => {
		for (const replicas of [8, 11]) {
			expect(pool(replicas, 1, 1)).toBe(
				projectPoolBytes({
					warmRegions: replicas,
					generationsHeld: 2,
					partitionGzipBytes: GEN52_GZIP,
					stagingPeakBytes: STAGING_PEAK_BYTES_2026_09_25,
				}),
			);
		}
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
	test("1x: LZ4 turns on for 8 or 9 cache replicas (11 hints with sam/afr/me aliased, plus a shard)", () => {
		expect(decideCacheCodec(undefined, pool(8, 1, LZ4_CACHE_RATIO))).toBe("lz4"); // ~3.43GB
		expect(decideCacheCodec(undefined, pool(9, 1, LZ4_CACHE_RATIO))).toBe("lz4"); // ~3.79GB
	});

	test("1x: 10 replicas holds LZ4 once on but never turns it on; 11 separate regions refuse it", () => {
		const ten = pool(10, 1, LZ4_CACHE_RATIO); // ~4.16GB
		expect(decideCacheCodec("gzip", ten)).toBe("gzip");
		expect(decideCacheCodec("lz4", ten)).toBe("lz4");
		expect(decideCacheCodec("lz4", pool(11, 1, LZ4_CACHE_RATIO))).toBe("gzip"); // ~4.53GB
	});

	test("2x: LZ4 is refused — and gzip ALONE no longer fits with the double hold (backlog x1)", () => {
		expect(decideCacheCodec("lz4", pool(8, 2, LZ4_CACHE_RATIO))).toBe("gzip");
		// The standing tripwire run-budget.test.ts already carries: at 2x the prefetch overlap itself
		// overflows the pool, codec or not. x1 (drop the old cache before the prefetch) is its fix.
		expect(pool(8, 2, 1)).toBeGreaterThan(POOL_GATE_BUDGET_BYTES);
	});

	test("one more replica on an in-band night never takes a gated LZ4 pool past the budget", () => {
		// The worst in-band night: LZ4 held right at the OFF threshold, then a shard opens in one
		// region before the next gate runs. It fills LZ4 directly (no gzip tee under an LZ4 codec),
		// and its high-water mark reaches both families only at the NEXT publish, when the gate has
		// run again — but budget it at the full double hold anyway.
		const replica = GEN52_GZIP.reduce((s, b) => s + b, 0) * (LZ4_CACHE_RATIO + 1);
		expect(LZ4_OFF_FRACTION * POOL_GATE_BUDGET_BYTES + replica).toBeLessThan(POOL_GATE_BUDGET_BYTES);
	});
});
