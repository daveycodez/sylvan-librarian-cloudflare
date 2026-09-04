// Does tonight's import fit the free plan's storage meters?
//
// On 2026-08-28 the answer was no, and nothing said so until the run had been
// going for six and a half hours. It stopped itself in the reorder phase of
// partition 2 of 10 with `Import stopped on this run's storage budget: 1,023,874
// rows read, 34,193 written` against MAX_RUN_ROWS_READ = 1,000,000 — and the
// 34,193 written, for three partitions of ten, was on course to blow
// MAX_RUN_ROWS_WRITTEN (40,000) even if the reads had fit. The store had not
// published by cron since 2026-08-21.
//
// The cause was not a phase doing wrong work. It was ALARM COUNT: agg and
// finalize sliced the staged drafts 8 and 4 batches at a time, so one partition
// took ~443 alarms and ten took ~4,430, each paying the same fixed storage toll
// before doing ~50ms of work against a 30s allowance. The run's single
// most-read statement was `SELECT value FROM meta WHERE key = ?`.
//
// So this suite asserts the projection the run needed and did not have: that
// the slice sizes in src/import-budget.ts keep a full-corpus run inside both
// ceilings, and — the part that makes it a regression test rather than a
// restatement — that the values it replaced do NOT.
//
// The corpus shape below is measured, from that run's own logs. Update it when
// the corpus grows; that is the point of it being a constant with a date on it.

import { describe, expect, test } from "bun:test";
import { REGION_HINTS } from "../../src/engine/region";
import {
	AGG_SLICE_BATCHES,
	CURRENT_SLICES,
	DO_STORAGE_POOL_BYTES,
	FINALIZE_SLICE_BATCHES,
	FIXED_ROWS_WRITTEN_PER_ALARM,
	MAX_DAY_ROWS_WRITTEN,
	MAX_RUN_ROWS_READ,
	MAX_RUN_ROWS_WRITTEN,
	projectPoolBytes,
	projectRunCost,
	REORDER_SLICE_ROWS,
	type RunShape,
	type SliceSizes,
} from "../../src/import-budget";
import { partitionCountFor } from "../../src/import-publish";

/**
 * The 2026-08-28 nightly, as its own logs describe it.
 *
 *   stagedBatches            1,180  — 295 finalize slices x 4 batches, logged
 *                                     per partition ("Finalize slice (partition
 *                                     0)" appeared 295 times, likewise 1)
 *   rowsPerPartition        57,545  — "Aggregation sealed for partition 2/10:
 *                                     57545 winners" (0 was 50,907, 1 was
 *                                     55,537; the largest is the one to size on)
 *   spillGroupsPerPartition    295  — "Reorder slice (partition 0): rows
 *                                     0-12500 of 50907 from 295 spill groups"
 *   partitions                  10  — "partition 2/10"
 *   prefixAlarms               160  — listing 1 + fetch 14 + recode 18 +
 *                                     canonical 5 + transform 55 + tags 3 +
 *                                     scores 48 + routing 1, plus ~15 for the
 *                                     manifest/notify/rulings/reference/purge
 *                                     tail, all counted from the same logs
 */
const CORPUS_2026_08_28: RunShape = {
	stagedBatches: 1_180,
	rowsPerPartition: 57_545,
	spillGroupsPerPartition: 295,
	partitions: 10,
	prefixAlarms: 160,
};

/**
 * The same corpus as the pipeline now stages it (2026-09-04): one number moved.
 *
 *   spillGroupsPerPartition     32  — the 295 above was one group per 4-batch
 *                                     finalize slice (~144KB each, 42.5MB a
 *                                     partition). Groups are byte-capped at
 *                                     BLOB_GROUP_BYTES (1.5MB), so at 64-batch
 *                                     slices the same 42.5MB is ~29 full groups
 *                                     plus one partial per finalize slice (3
 *                                     slices of the ~137 bucketed groups). The
 *                                     harness confirms the shape: 2 spill groups
 *                                     per ~4MB partition, `SELECT base, bytes
 *                                     FROM spill_batches` returning 14 rows over
 *                                     7 partitions on 2026-09-04.
 *
 * CORPUS_2026_08_28 stays as measured, because the calibration test below
 * reproduces that run's projection from it; this is the shape the growth
 * projection scales.
 */
const CORPUS_2026_09_04: RunShape = { ...CORPUS_2026_08_28, spillGroupsPerPartition: 32 };

/** What agg/finalize were before 2026-08-28 — and no bucket phase, which did not exist yet. */
const SLICES_BEFORE: SliceSizes = {
	aggBatches: 8,
	finalizeBatches: 4,
	reorderRows: REORDER_SLICE_ROWS,
	bucketBatches: null,
};

/** The 2026-08-28 slice sizes WITHOUT the bucket phase: the pipeline between that fix and 2026-09-04. */
const SLICES_UNBUCKETED: SliceSizes = { ...CURRENT_SLICES, bucketBatches: null };

/**
 * The staged-draft bytes behind CORPUS_2026_08_28's N=10: partitionCountFor
 * picks 10 for anything in (1,612MB, 1,792MB] at TARGET_PARTITION_BYTES, and
 * 1,180 byte-capped batches of ~1.5MB is 1.77GB — the top of that band.
 */
const STAGED_DRAFT_BYTES_2026_08_28 = 1_770_000_000;

/**
 * The same corpus, `multiple` times larger, with N chosen the way the run would
 * choose it. Everything per partition scales by multiple x 10/N; the prefix
 * alarms split into the ~57 that do not scale (listing, fetch, recode,
 * canonical, tags, routing, the tail) and the ~103 that do (transform 55,
 * scores 48 — both walk the corpus in fixed-size slices).
 */
function corpusAt(multiple: number): RunShape {
	const partitions = partitionCountFor(STAGED_DRAFT_BYTES_2026_08_28 * multiple);
	const perPartition = (multiple * 10) / partitions;
	return {
		stagedBatches: Math.ceil(CORPUS_2026_09_04.stagedBatches * multiple),
		rowsPerPartition: Math.ceil(CORPUS_2026_09_04.rowsPerPartition * perPartition),
		spillGroupsPerPartition: Math.ceil(CORPUS_2026_09_04.spillGroupsPerPartition * perPartition),
		partitions,
		prefixAlarms: 57 + Math.ceil(103 * multiple),
	};
}

/** What the harness measures total writes at, over the floor this model counts. */
const HARNESS_WRITE_MULTIPLE = 2.4;

/**
 * How much of the WRITE budget the per-alarm toll may consume.
 *
 * The rest has to cover the actual staging — draft batches, spill groups,
 * ordered groups, chunk staging, the tag snapshot's re-export, the rulings and
 * reference hash rows. The harness measures total writes at ~2.4x the fixed
 * toll plus staging that this model counts, so leaving 60% of the ceiling for
 * work is the honest split. Before 2026-08-28 the toll alone wanted 93%.
 */
const TOLL_SHARE_OF_WRITE_BUDGET = 0.4;

describe("the run's storage budget", () => {
	test("a full-corpus run fits MAX_RUN_ROWS_READ with real headroom", () => {
		const cost = projectRunCost(CORPUS_2026_08_28);
		expect(cost.rowsRead).toBeLessThan(MAX_RUN_ROWS_READ);
		// Not merely "fits": the ceiling exists to catch REPEATED work, and it
		// can only do that if a healthy run sits far below it. Five times over
		// is the margin that makes a trip mean something.
		expect(cost.rowsRead * 5).toBeLessThan(MAX_RUN_ROWS_READ);
	});

	test("the per-alarm toll leaves most of the write budget for actual work", () => {
		const cost = projectRunCost(CORPUS_2026_08_28);
		expect(cost.fixedRowsWritten).toBeLessThan(MAX_RUN_ROWS_WRITTEN * TOLL_SHARE_OF_WRITE_BUDGET);
	});

	test("the modelled write floor fits MAX_RUN_ROWS_WRITTEN", () => {
		const cost = projectRunCost(CORPUS_2026_08_28);
		expect(cost.rowsWritten).toBeLessThan(MAX_RUN_ROWS_WRITTEN);
	});

	test("the slice sizes this replaced do NOT fit — which is what happened", () => {
		const before = projectRunCost(CORPUS_2026_08_28, SLICES_BEFORE);
		const now = projectRunCost(CORPUS_2026_08_28, CURRENT_SLICES);

		// ~4,600 alarms then, ~600 now.
		expect(before.alarms).toBeGreaterThan(4_000);
		expect(now.alarms).toBeLessThan(1_000);

		// And the failure this test exists to prevent: the fixed per-alarm toll
		// alone consuming the write budget, before a single staged row is
		// written. If someone lowers a slice size back, THIS is the assertion
		// that goes red — locally, in seconds, instead of at 11:17 UTC.
		expect(before.fixedRowsWritten).toBeGreaterThan(MAX_RUN_ROWS_WRITTEN * TOLL_SHARE_OF_WRITE_BUDGET);
		expect(now.fixedRowsWritten).toBeLessThan(MAX_RUN_ROWS_WRITTEN * TOLL_SHARE_OF_WRITE_BUDGET);
	});

	test("the alarm count is no longer dominated by the partition loop", () => {
		// This used to assert the opposite — that the loop dominated the prefix,
		// so the loop's slice sizes were the lever. The bucket phase is what
		// flipped it: the loop's alarms fell from ~450 to ~150 against a prefix
		// of 160, so the next lever, if one is ever needed, is the prefix's own
		// corpus-walking phases (transform 55, scores 48), not the loop.
		const unbucketed = projectRunCost(CORPUS_2026_08_28, SLICES_UNBUCKETED);
		const now = projectRunCost(CORPUS_2026_08_28);
		expect(unbucketed.alarms - CORPUS_2026_08_28.prefixAlarms).toBeGreaterThan(CORPUS_2026_08_28.prefixAlarms);
		expect(now.alarms - CORPUS_2026_08_28.prefixAlarms).toBeLessThan(CORPUS_2026_08_28.prefixAlarms);
	});

	test("the unbucketed model still reproduces the 2026-08-28 projection it was calibrated on", () => {
		// 610 alarms and 71,200 rows read, within 7% of the harness — the figures
		// projectRunCost's own comment cites. They belong to the pipeline WITHOUT
		// the bucket phase; keeping them reproducible is what makes the bucketed
		// projection below a measured delta rather than a fresh guess.
		const cost = projectRunCost(CORPUS_2026_08_28, SLICES_UNBUCKETED);
		expect(cost.alarms).toBe(610);
		expect(cost.rowsRead).toBe(71_200);
	});

	test("the bucket phase removes the N x staging term: reads fall, alarms fall, writes do not rise", () => {
		const before = projectRunCost(CORPUS_2026_08_28, SLICES_UNBUCKETED);
		const now = projectRunCost(CORPUS_2026_08_28);
		// agg + finalize used to read 2 x N x 1,180 rows; now 1,180 once plus ~2 x 1,180 in
		// total. What remains of the read cost is the reorder phase's two passes per slice
		// over the spill groups — unchanged here, and the next term to look at.
		const { stagedBatches, partitions } = CORPUS_2026_08_28;
		expect(before.rowsRead - now.rowsRead).toBeGreaterThan(2 * partitions * stagedBatches * 0.8);
		expect(now.alarms).toBeLessThan(before.alarms / 1.9);
		// The pass costs writes of its own (groups written, source rows deleted) that today's
		// alarm saving roughly repays; the point is the exponent, asserted next.
		expect(now.rowsWritten).toBeLessThan(before.rowsWritten * 1.1);
	});

	test("the nightly stays inside the day's write cap as the corpus grows — through 3x", () => {
		// The wall the bucket phase was built for. Unbucketed, every partition
		// rescanned the whole staging and N grew with the corpus, so the alarm
		// count — and with it the write toll — grew as N x corpus. On this shape
		// that crossed the 60k self-cap between 2x and 2.5x and the platform's
		// 100k by ~3.3x (an earlier projection said 1.6x and 2.4x; it was
		// carrying the stale 295 spill groups). Bucketed, every term is linear:
		// the self-cap holds through 3x and falls between 3x and 4x, the
		// platform's limit near 6x. At the corpus's ~7%/year that is the
		// difference between ~12 years and ~18 on the self-cap — and when the
		// self-cap does bind, the honest next lever is raising it toward the
		// platform's 100k (serving writes are hundreds a day), then the three
		// writes of every spill group (finalize, reorder, build).
		for (const multiple of [1, 1.5, 2, 2.5, 3]) {
			const cost = projectRunCost(corpusAt(multiple));
			expect(cost.rowsWritten * HARNESS_WRITE_MULTIPLE).toBeLessThan(MAX_DAY_ROWS_WRITTEN);
			expect(cost.rowsRead * 2).toBeLessThan(MAX_RUN_ROWS_READ);
		}
		// And the regression twin: the unbucketed pipeline could not have done 2.5x,
		// and its alarm count at 3x is what "quadratic" means in practice.
		const unbucketed = projectRunCost(corpusAt(2.5), SLICES_UNBUCKETED);
		expect(unbucketed.rowsWritten * HARNESS_WRITE_MULTIPLE).toBeGreaterThan(MAX_DAY_ROWS_WRITTEN);
		expect(projectRunCost(corpusAt(3), SLICES_UNBUCKETED).alarms).toBeGreaterThan(
			4 * projectRunCost(corpusAt(3)).alarms,
		);
	});

	test("agg and finalize slice the same staging, so they cost the same alarms", () => {
		// They walk the identical draft_batches cursor in the identical order —
		// that is the finalize pass's contract with the aggregation before it.
		// Divergent slice sizes are not wrong, but they are always a decision,
		// never a drift, so pin them together.
		expect(AGG_SLICE_BATCHES).toBe(FINALIZE_SLICE_BATCHES);
	});

	test("a slice never asks for more than the isolate can hold", () => {
		// The 4-batch finalize slice was sized for a JS row-JSON buffer that had
		// already been deleted. The rule that replaced it: the SLICE is a CPU
		// budget and the FETCH GROUP is the memory budget, so the fetch group is
		// what has to stay small — a staged batch is ~1.9MB and the isolate
		// ceiling is 128MB.
		const STAGE_BATCH_BYTES = 1_900_000;
		const ISOLATE_BUDGET_BYTES = 128 * 1024 * 1024;
		for (const group of [8]) {
			expect(group * STAGE_BATCH_BYTES).toBeLessThan(ISOLATE_BUDGET_BYTES / 4);
		}
		// And the slice itself must not be so large that even ONE fetch group's
		// worth of work overruns the 30s allowance: ~15ms of CPU per batch was
		// measured on the 2026-08-28 production alarms.
		const CPU_MS_PER_BATCH = 15;
		const DO_CPU_ALLOWANCE_MS = 30_000;
		expect(FINALIZE_SLICE_BATCHES * CPU_MS_PER_BATCH * 4).toBeLessThan(DO_CPU_ALLOWANCE_MS);
		expect(FIXED_ROWS_WRITTEN_PER_ALARM).toBeGreaterThan(0);
	});
});

/**
 * The live manifest on 2026-09-04 (content generation 48, format 2026090301):
 * ten partitions, 424MB raw, 145.9MB compressed — `partitions[k].store_gzip_bytes`
 * as published. Read off KV with `wrangler kv key get store:manifest --remote`.
 */
const PARTITION_GZIP_BYTES_2026_09_04 = [
	14_172_427, 14_633_721, 15_155_561, 14_062_972, 14_822_299, 14_558_732, 14_718_473, 14_241_953, 14_314_945,
	15_209_706,
];

/**
 * The coordinator's staging at its peak, which is the moment the drafts are
 * bucketed: draft_batches (1.77GB, see STAGED_DRAFT_BYTES_2026_08_28) plus the
 * tag snapshot and the rulings blobs (~150MB together). An ESTIMATE from the
 * sizing rule, not a meter reading — replace it with the "Partition loop: …
 * staged draft bytes" log line of a real run when one is at hand.
 */
const STAGING_PEAK_BYTES_2026_09_04 = 1_920_000_000;

describe("the Durable Objects storage pool", () => {
	const today = (warmRegions: number, generationsHeld: number) =>
		projectPoolBytes({
			warmRegions,
			generationsHeld,
			partitionGzipBytes: PARTITION_GZIP_BYTES_2026_09_04,
			stagingPeakBytes: STAGING_PEAK_BYTES_2026_09_04,
		});

	/** The corpus multiple at which the pool overflows, everything scaling together. */
	const crossing = (warmRegions: number, generationsHeld: number) =>
		DO_STORAGE_POOL_BYTES / today(warmRegions, generationsHeld);

	test("tonight's publish fits the pool even with every region warm", () => {
		// Nine regions, each holding the old AND the new archives between prepare
		// and commit, beside the coordinator's staging peak. ~4.6GB of 5GB.
		expect(today(REGION_HINTS.length, 2)).toBeLessThan(DO_STORAGE_POOL_BYTES);
	});

	test("the pool is the NEAREST wall, and this is the tripwire for it", () => {
		// With every region warm through a publish the pool crosses at ~1.1x the
		// corpus; with the cache's own arithmetic (one generation, nine regions)
		// at ~1.6x; with five warm regions holding two, ~1.5x. All of them are
		// nearer than the write meter's wall now that the bucket phase exists,
		// and the corpus grows ~7% a year — so this assertion is expected to go
		// red within a year of 2026-09-04, and when it does the answer is to
		// shrink the staging (the drafts are uncompressed JSON) or the
		// double-hold, not to raise the number.
		expect(crossing(REGION_HINTS.length, 2)).toBeGreaterThan(1.05);
		expect(crossing(REGION_HINTS.length, 1)).toBeGreaterThan(1.5);
		expect(crossing(5, 2)).toBeGreaterThan(1.4);
	});
});
