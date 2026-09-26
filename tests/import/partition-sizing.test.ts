// The partition count (src/import-sizing.ts, backlog x28): the smallest N whose LARGEST partition
// projects under the KV chunk cut less a 5% margin — the nightly's copy of the rule, held to the
// deploy path's Rust twin (engine/builder/src/sizing.rs) through a shared vectors file, and to the
// real corpus through builds measured on 2026-09-26.

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
	test("is the 46MB cut less the 5% margin, less the projection's 1% error on top", () => {
		expect(PARTITION_SAFETY_MARGIN_PCT).toBe(5);
		expect(PARTITION_PROJECTION_ERROR_PCT).toBe(1);
		expect(PARTITION_CEILING_BYTES).toBe(43_267_326);
		// A partition landing at the worst error allowed is still the whole margin under the cut.
		expect(PARTITION_CEILING_BYTES * (1 + PARTITION_PROJECTION_ERROR_PCT / 100)).toBeLessThanOrEqual(
			KV_CHUNK_BYTES * (1 - PARTITION_SAFETY_MARGIN_PCT / 100),
		);
	});
});

/**
 * Measured 2026-09-26 (format 2026092601): per partition [cards, framed draft bytes, built archive
 * bytes], the 2026-08-16 all_cards dump built natively at a pinned N — two of the nine builds the
 * coefficients were fitted on.
 */
const AUG16_N10: [number, number, number][] = [
	[3902, 166060618, 41152200],
	[3738, 192391229, 44520384],
	[3916, 191769830, 45093600],
	[3826, 167582866, 41044824],
	[3926, 178107689, 43318360],
	[3818, 176899122, 42528648],
	[3917, 175737922, 42998272],
	[3860, 168825962, 41458760],
	[3883, 169579555, 41689760],
	[3840, 190999502, 44789040],
];
const AUG16_N11: [number, number, number][] = [
	[3502, 161587516, 39120960],
	[3516, 165196393, 39536384],
	[3496, 146451588, 36554264],
	[3506, 166265529, 39665696],
	[3571, 160239547, 39069128],
	[3571, 156137061, 38322600],
	[3401, 146196161, 36096640],
	[3533, 174188284, 41196264],
	[3552, 157455816, 38809624],
	[3521, 182713034, 42232944],
	[3457, 161523366, 39078536],
];

describe("the projection, against real builds", () => {
	test("every partition lands within the projection's error allowance", () => {
		for (const [cards, framed, built] of [...AUG16_N10, ...AUG16_N11]) {
			const projected = projectPartitionBytes(cards, framed);
			expect(Math.abs(built - projected) / projected).toBeLessThan(PARTITION_PROJECTION_ERROR_PCT / 100);
			expect(projectionDriftWarning(0, built, projected)).toBeNull();
		}
	});

	test("the corpus the mean rule left 1.4% under the cut is 11 partitions, largest 8% under", () => {
		// The mean rule cut this corpus (and today's, one day's growth on) into 10: its largest
		// partition built to 45.09MB here and 45.34MB on 2026-09-26, 2.0% and 1.4% under the cut.
		const largest10 = Math.max(...AUG16_N10.map(([c, d]) => projectPartitionBytes(c, d)));
		expect(largest10).toBeGreaterThan(PARTITION_CEILING_BYTES);
		const largest11 = Math.max(...AUG16_N11.map(([c, d]) => projectPartitionBytes(c, d)));
		expect(largest11).toBeLessThanOrEqual(PARTITION_CEILING_BYTES);
		const built11 = Math.max(...AUG16_N11.map(([, , a]) => a));
		expect((KV_CHUNK_BYTES - built11) / KV_CHUNK_BYTES).toBeGreaterThan(0.08);
	});

	test("a partition built further above its projection than the fit allows says so", () => {
		expect(projectionDriftWarning(3, 42_000_000, 41_000_000)).toMatch(/p3 built 42000000 bytes, 2\.44% above/);
		expect(projectionDriftWarning(3, 41_400_000, 41_000_000)).toBeNull();
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
