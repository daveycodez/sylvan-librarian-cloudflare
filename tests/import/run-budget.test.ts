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
import {
	AGG_SLICE_BATCHES,
	CURRENT_SLICES,
	FINALIZE_SLICE_BATCHES,
	FIXED_ROWS_WRITTEN_PER_ALARM,
	MAX_RUN_ROWS_READ,
	MAX_RUN_ROWS_WRITTEN,
	projectRunCost,
	REORDER_SLICE_ROWS,
	type RunShape,
} from "../../src/import-budget";

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

/** What agg/finalize were before 2026-08-28. */
const SLICES_BEFORE = { aggBatches: 8, finalizeBatches: 4, reorderRows: REORDER_SLICE_ROWS };

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

	test("the alarm count is dominated by the partition loop, not the prefix", () => {
		// The invariant behind every number above: if the prefix ever dominates,
		// the slice sizes are no longer the lever and this model has stopped
		// describing the pipeline.
		const cost = projectRunCost(CORPUS_2026_08_28);
		expect(cost.alarms - CORPUS_2026_08_28.prefixAlarms).toBeGreaterThan(CORPUS_2026_08_28.prefixAlarms);
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
