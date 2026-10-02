// The partition count (src/import-sizing.ts, backlog x28): the smallest N whose LARGEST partition
// projects under the KV chunk cut less a 5% margin — the nightly's copy of the rule, held to the
// deploy path's Rust twin (engine/builder/src/sizing.rs) through a shared vectors file, and to the
// real corpus through builds measured on 2026-10-02 (backlog x50, which re-fitted the projection).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KV_CHUNK_BYTES } from "../../src/engine/store-kv";
import { MAX_PARTITION_COUNT, MIN_PARTITION_COUNT } from "../../src/import-publish";
import {
	CardBytes,
	choosePartitionCount,
	DRAFT_FRAME_BYTES,
	PARTITION_CEILING_BYTES,
	PARTITION_PROJECTION_ERROR_PCT,
	PARTITION_SAFETY_MARGIN_PCT,
	projectedPartitionCount,
	projectionDriftWarning,
	projectPartitionBytes,
	projectPartitions,
	STORE_BYTES_PER_CARD,
	STORE_BYTES_PER_PARTITION,
	STORE_PER_DRAFT_BYTE_DEN,
	STORE_PER_DRAFT_BYTE_NUM,
} from "../../src/import-sizing";

interface Vectors {
	constants: Record<string, number>;
	cards: number;
	framed_bytes: number;
	drafts: [string, number][];
	choices: {
		ceiling: number;
		n: number;
		largest: number;
		largest_at: number;
		clamped: boolean;
		projected: number[];
	}[];
}

const vectors = JSON.parse(
	readFileSync(join(import.meta.dir, "../engine/partition-sizing-vectors.json"), "utf8"),
) as Vectors;
const layout = () => ({
	hashes: BigUint64Array.from(vectors.drafts.map(([h]) => BigInt(h))),
	lengths: Uint32Array.from(vectors.drafts.map(([, l]) => l)),
});

describe("the two builders choose the same N (vectors shared with engine/builder/src/sizing.rs)", () => {
	test("every constant is the Rust twin's", () => {
		expect(vectors.constants).toEqual({
			min_partitions: MIN_PARTITION_COUNT,
			max_partitions: MAX_PARTITION_COUNT,
			draft_frame_bytes: DRAFT_FRAME_BYTES,
			kv_chunk_bytes: KV_CHUNK_BYTES,
			store_bytes_per_partition: STORE_BYTES_PER_PARTITION,
			store_bytes_per_card: STORE_BYTES_PER_CARD,
			store_per_draft_byte_num: STORE_PER_DRAFT_BYTE_NUM,
			store_per_draft_byte_den: STORE_PER_DRAFT_BYTE_DEN,
			partition_ceiling_bytes: PARTITION_CEILING_BYTES,
		});
	});

	test("every choice matches the independent bigint reference, projections byte for byte", () => {
		// The reference walks every N from the floor with bigint `%`; this starts at the mean and
		// reduces the u64 through its two halves. Hashes at 0, 2^32 +- 1, 2^63 and 2^64 - 1 are in.
		const { hashes, lengths } = layout();
		expect(vectors.choices.map((c) => c.n)).toEqual([2, 4, 11, 18, 48, 48, 48, 48]);
		for (const want of vectors.choices) {
			const got = choosePartitionCount(hashes, lengths, want.ceiling);
			expect({ ceiling: want.ceiling, n: got.n, largestAt: got.largestAt, clamped: got.clamped }).toEqual({
				ceiling: want.ceiling,
				n: want.n,
				largestAt: want.largest_at,
				clamped: want.clamped,
			});
			expect(got.largest).toBe(want.largest);
			expect(got.projected).toEqual(want.projected);
			expect(got.cards).toBe(vectors.cards);
			expect(got.framedBytes).toBe(vectors.framed_bytes);
			expect(got.drafts).toBe(vectors.drafts.length);
		}
	});

	test("the input order does not matter, and the caller's hashes are left as they were", () => {
		const { hashes, lengths } = layout();
		const before = hashes.slice();
		const forward = choosePartitionCount(hashes, lengths, vectors.choices[2]?.ceiling);
		expect(hashes).toEqual(before);
		const reversed = choosePartitionCount(
			hashes.slice().reverse(),
			lengths.slice().reverse(),
			vectors.choices[2]?.ceiling,
		);
		expect(reversed).toEqual(forward);
	});

	test("an empty corpus is the floor", () => {
		const c = choosePartitionCount(new BigUint64Array(0), new Uint32Array(0));
		expect({ n: c.n, clamped: c.clamped, cards: c.cards }).toEqual({
			n: MIN_PARTITION_COUNT,
			clamped: false,
			cards: 0,
		});
	});

	test("a draft whose hash is not a known card is an error, not a silent miss", () => {
		const corpus = CardBytes.distinct(BigUint64Array.from([5n, 7n]));
		expect(() => corpus.add(6n, 100)).toThrow(/not among/);
		expect(() => choosePartitionCount(new BigUint64Array(1), new Uint32Array(2))).toThrow(/1 hashes but 2/);
	});
});

describe("the ceiling", () => {
	test("is the 46MB cut less the 5% margin, less the projection's 1.25% error on top", () => {
		expect(PARTITION_SAFETY_MARGIN_PCT).toBe(5);
		expect(PARTITION_PROJECTION_ERROR_PCT).toBe(1.25);
		expect(PARTITION_CEILING_BYTES).toBe(43_160_493);
		// A partition landing at the worst error allowed is still the whole margin under the cut.
		expect(PARTITION_CEILING_BYTES * (1 + PARTITION_PROJECTION_ERROR_PCT / 100)).toBeLessThanOrEqual(
			KV_CHUNK_BYTES * (1 - PARTITION_SAFETY_MARGIN_PCT / 100),
		);
	});
});

/**
 * Measured 2026-10-02 (format 2026092601): per partition [cards, framed draft bytes, built archive
 * bytes], the 2026-10-01 all_cards dump (545,288 drafts, 38,705 cards) built natively at a pinned
 * N — two of the eleven builds the coefficients were fitted on. The N=11 sizes are the ones both
 * accounts' nightlies built on 2026-10-01, to within 400 bytes.
 */
const OCT01_N10: [number, number, number][] = [
	[3893, 167806922, 41592128],
	[3752, 194727930, 45095704],
	[3940, 194463070, 45791080],
	[3843, 169527922, 41571448],
	[3934, 180207790, 43867784],
	[3830, 179240300, 43137208],
	[3918, 177864008, 43532408],
	[3860, 170973317, 41987584],
	[3887, 171451029, 42186664],
	[3848, 193537603, 45426064],
];
const OCT01_N11: [number, number, number][] = [
	[3515, 163579656, 39633688],
	[3527, 167459705, 40128944],
	[3498, 148231100, 37030176],
	[3512, 168438756, 40204712],
	[3565, 162120560, 39542848],
	[3569, 157899273, 38761240],
	[3407, 147814963, 36532096],
	[3556, 176547213, 41807176],
	[3562, 159243808, 39288864],
	[3532, 185012933, 42796072],
	[3462, 163451924, 39557088],
];

/**
 * The fit x50 replaced (2026-09-26, on the 2026-08-16 dump). Against it p8 and p10 of the eleven
 * built 1.04% high on 2026-10-01 and tripped the 1% drift warning on every build, nightly and deploy.
 */
const X28_FIT = (cards: number, framed: number) => Math.floor(1_141_000 + 3_770 * cards + 0.1527 * framed);

describe("the projection, against real builds", () => {
	test("every partition lands within the fit's measured residual, well inside the allowance", () => {
		const residuals = [...OCT01_N10, ...OCT01_N11].map(([cards, framed, built]) => {
			const projected = projectPartitionBytes(cards, framed);
			expect(projectionDriftWarning(0, built, projected)).toBeNull();
			return ((built - projected) / projected) * 100;
		});
		// -0.47% .. +0.62% here; -0.74% .. +0.62% over all 77 fitted partitions, +0.78% the worst
		// of 127 across five states of the corpus (src/import-sizing.ts). The allowance leaves the
		// furthest drift seen between two fits, 0.46%, on top of that.
		expect(Math.min(...residuals)).toBeGreaterThan(-0.5);
		expect(Math.max(...residuals)).toBeLessThan(0.63);
		expect(0.78 + 0.46).toBeLessThanOrEqual(PARTITION_PROJECTION_ERROR_PCT);
	});

	test("the re-fit took out a drift common to every partition, not the two that warned", () => {
		const mean = (project: (cards: number, framed: number) => number) =>
			OCT01_N11.reduce((sum, [c, f, built]) => sum + ((built - project(c, f)) / project(c, f)) * 100, 0) /
			OCT01_N11.length;
		// Every partition but one sat above the x28 fit, +0.46% on average; p8 and p10 were +0.6%
		// above it the day it was fitted, and the drift took them past 1%.
		expect(OCT01_N11.filter(([c, f, built]) => built > X28_FIT(c, f)).length).toBe(10);
		expect(mean(X28_FIT)).toBeGreaterThan(0.45);
		expect(mean(X28_FIT)).toBeLessThan(0.47);
		expect(Math.abs(mean(projectPartitionBytes))).toBeLessThan(0.02);
		for (const k of [8, 10]) {
			const [cards, framed, built] = OCT01_N11[k] as [number, number, number];
			expect(built / X28_FIT(cards, framed)).toBeGreaterThan(1.01);
			expect(built / projectPartitionBytes(cards, framed)).toBeLessThan(1.0062);
		}
	});

	test("today's corpus is still 11 partitions, largest 7% under the cut, and 10 is still refused", () => {
		// What the mean rule did with this corpus: 10 partitions, the largest 45.79MB, 0.5% under.
		const largest10 = Math.max(...OCT01_N10.map(([c, d]) => projectPartitionBytes(c, d)));
		expect(largest10).toBeGreaterThan(PARTITION_CEILING_BYTES);
		// The re-fit and the wider allowance both move toward N=12, and neither reaches it: the
		// largest partition projects to 42,921,158 against a ceiling of 43,160,493 (0.56% of room;
		// the x28 fit and its 1% allowance left 1.31%).
		const largest11 = Math.max(...OCT01_N11.map(([c, d]) => projectPartitionBytes(c, d)));
		expect(largest11).toBe(42_921_158);
		expect(largest11).toBeLessThanOrEqual(PARTITION_CEILING_BYTES);
		expect(Math.max(...OCT01_N11.map(([c, d]) => X28_FIT(c, d)))).toBeLessThanOrEqual(43_267_326);
		const built11 = Math.max(...OCT01_N11.map(([, , a]) => a));
		expect((KV_CHUNK_BYTES - built11) / KV_CHUNK_BYTES).toBeGreaterThan(0.069);
	});

	test("a partition built further above its projection than the fit allows says so", () => {
		expect(projectionDriftWarning(3, 42_000_000, 41_000_000)).toMatch(/p3 built 42000000 bytes, 2\.44% above/);
		expect(projectionDriftWarning(3, 41_520_000, 41_000_000)).toMatch(/more than the 1\.25% the sizing fit allows/);
		expect(projectionDriftWarning(3, 41_500_000, 41_000_000)).toBeNull();
		expect(projectionDriftWarning(3, 30_000_000, 41_000_000)).toBeNull();
	});

	test("projectPartitions is choosePartitionCount's own projection at any N", () => {
		const { hashes, lengths } = layout();
		const corpus = CardBytes.distinct(hashes.slice());
		for (let i = 0; i < hashes.length; i++) corpus.add(hashes[i] as bigint, lengths[i] as number);
		const want = vectors.choices[3];
		expect(projectPartitions(corpus, want?.n ?? 0)).toEqual(want?.projected ?? []);
	});
});

describe("projectedPartitionCount — N without the layout (the budget model; a run staged before part_lens)", () => {
	// 1,785,155,265 framed draft bytes: the 2026-09-26 dump, which the layout sizes at 11 (largest
	// 42.48MB projected, 42.44MB built). Simulated growth (every card copied under fresh hashes) sizes
	// 1.5x / 2x / 3x at 17 / 23 / 34 from the layout; the mean projection must not fall below.
	const TODAY = 1_785_155_265;

	test("errs at or above the layout's answer", () => {
		expect(projectedPartitionCount(TODAY)).toBe(12);
		expect(projectedPartitionCount(TODAY * 1.5)).toBeGreaterThanOrEqual(17);
		expect(projectedPartitionCount(TODAY * 2)).toBeGreaterThanOrEqual(23);
		expect(projectedPartitionCount(TODAY * 3)).toBeGreaterThanOrEqual(34);
	});

	test("clamps at both ends, and refuses garbage", () => {
		expect(projectedPartitionCount(0)).toBe(MIN_PARTITION_COUNT);
		expect(projectedPartitionCount(100_000_000_000)).toBe(MAX_PARTITION_COUNT);
		// The layout sizes 4x the corpus at 43 (simulated), so N keeps growing to ~4.5x; the mean
		// projection, erring wide, reaches the ceiling a little sooner.
		expect(projectedPartitionCount(TODAY * 4.2)).toBeLessThan(MAX_PARTITION_COUNT);
		expect(() => projectedPartitionCount(Number.NaN)).toThrow(/cannot size/);
		expect(() => projectedPartitionCount(-1)).toThrow(/cannot size/);
	});
});
