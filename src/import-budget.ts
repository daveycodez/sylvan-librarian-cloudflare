// What one nightly import may spend of the Durable Objects storage meters, and
// the arithmetic that says whether tonight's corpus fits.
//
// These lived inside import-coordinator.ts, next to the guard that enforces
// them, and that is exactly why the 2026-08-28 outage happened the way it did:
// the coordinator imports `cloudflare:workers` and a compiled .wasm, so nothing
// in `bun test` could reach the numbers, and the only place the projection was
// ever evaluated was a doc-comment. It said "roughly 150k reads"; the run spent
// 1,023,874 and stopped itself in the reorder phase of partition 2 of 10, six
// and a half hours in, with nothing published.
//
// So the cost model is a module, and it is pure: the ceilings, the slice sizes
// that decide how many alarms a run takes, the measured per-alarm toll, and
// `projectRunCost` — which tests/import/run-budget.test.ts evaluates against
// the real corpus's measured shape on every `bun test`. Change a slice size and
// the projection moves; move it past a ceiling and the suite goes red before
// the cron does.
//
// Everything here is MEASURED, not estimated. The measurements come from two
// places, both cited per constant:
//   - the 2026-08-28 production run (Workers observability: per-alarm CPU,
//     outcomes, and the run's own do_rows_read/do_rows_written meters), and
//   - scripts/import-harness, which drives this exact pipeline end to end on a
//     scaled synthetic corpus and prints rows read/written per phase.

/**
 * What one import run may spend before it stops itself. The free plan allows
 * 5,000,000 rows read and 100,000 written per DAY, across everything — so
 * these are deliberately a fraction of that, leaving the day's allowance for
 * serving.
 *
 * ── WHAT A HEALTHY RUN ACTUALLY COSTS (measured 2026-08-28) ─────────────────
 *
 * The previous note here said "roughly 150k reads, dominated by the build
 * phase's ~98k row lookups". The build's random seeks are gone (stepReorder
 * replaced them), and the corpus has since grown to 541,378 multilingual lines
 * over ten partitions, so that sentence described a pipeline that no longer
 * exists. The harness re-measured it: at 28,130 lines and N=8 a full run costs
 * 3,460 rows read and 1,723 written, which projects to ~67k read and ~33k
 * written at the real corpus. See projectRunCost below for the same number
 * derived from the slice sizes rather than from a scaled run.
 *
 * So 1,000,000 is ~15x the honest cost, and that headroom is the point.
 * Tripping this ceiling does not mean "a big import"; it means the same work
 * is being done repeatedly, which is exactly how 4.5M reads were once spent in
 * a day — blocking the storage API account-wide and knocking every search DO
 * onto a 15-second load.
 *
 * Better to abandon a run and serve yesterday's index than to finish one and
 * take search down until midnight UTC.
 */
export const MAX_RUN_ROWS_READ = 1_000_000;

/**
 * The WRITE ceiling, and the tight one — this is the meter a healthy run
 * actually comes close to.
 *
 * The free plan allows 100,000 rows written per DAY across the whole account,
 * fifty times less headroom than the read meter, and a Durable Object charges
 * a row written for every `setAlarm()` (Workers pricing, SQLite backend,
 * footnote 3) plus one for each meta write. That makes the ALARM COUNT, not
 * the work, the dominant term: before 2026-08-28's slice-size fix the
 * projection stood at ~71,000 writes for a ten-partition run — over this
 * ceiling and over MAX_DAY_ROWS_WRITTEN, which is to say the pipeline could
 * not have completed a nightly at the current corpus size no matter how well
 * every phase behaved. It now projects to ~33,000.
 *
 * Anything that adds alarms spends this budget linearly. Check projectRunCost.
 */
export const MAX_RUN_ROWS_WRITTEN = 40_000;

/**
 * The same ceilings, per UTC DAY across all runs — the ones that actually
 * match the limit being protected.
 *
 * A per-run budget alone bounds nothing durable: startImport clears the run's
 * counters, so every fresh run gets a fresh allowance, and a run that stalls
 * is restartable after STALE_RUN_MS. Enough restarts and the day is gone
 * anyway, one "within budget" run at a time. These counters therefore survive
 * metaClear (see metaClear's key filter) and reset only when the date does,
 * exactly like the meter they stand in for.
 *
 * Well under the account's 5M/100k so the serving path keeps its share: a
 * SearchEngine wake reads its local store copy, and losing THAT to an
 * exhausted meter is what turns a background import problem into 15-second
 * searches.
 */
export const MAX_DAY_ROWS_READ = 1_500_000;
export const MAX_DAY_ROWS_WRITTEN = 60_000;

/**
 * Draft batches re-bucketed by partition per slice (stepBucket), and the
 * fetch-group size that bounds what is resident at once — the same split as
 * the agg and finalize slices below, for the same reasons.
 *
 * The bucket pass is what makes the loop's cost LINEAR in corpus size: before
 * it, agg and finalize each walked all of draft_batches for every partition
 * (the `2 x N x stagedBatches` term projectRunCost used to carry) and kept the
 * 1/N that hashed to it. Its own cost is one read per staged batch, one write
 * per group it produces and one per source batch it deletes — once — so the
 * slice size only decides how many alarms that once costs.
 */
export const BUCKET_SLICE_BATCHES = 64;
export const BUCKET_FETCH_BATCHES = 8;

/**
 * Draft batches aggregated per slice.
 *
 * RAISED 8 → 64 on 2026-08-28, with the resident bytes bounded separately by
 * AGG_FETCH_BATCHES below — the split stepScores has had since it was written.
 * At 8, one partition's aggregation over the real corpus's ~1,180 staged
 * batches took ~148 alarms, and TEN partitions took ~1,480. Every one of those
 * alarms pays the same fixed toll (FIXED_ROWS_PER_ALARM below), which is why
 * the 2026-08-28 run's single most-read storage statement was
 * `SELECT value FROM meta WHERE key = ?` — the toll, not the work.
 *
 * 64 is bounded by CPU, generously: the 2026-08-28 production alarms measured
 * 40-90ms of CPU per 4-batch finalize slice (~15ms/batch on an edge core), so
 * 64 batches is ~1s against the 30s Durable Object allowance.
 */
export const AGG_SLICE_BATCHES = 64;

/**
 * Batch rows materialized as JS buffers at once inside an agg slice.
 *
 * The SLICE is a CPU budget; this is the MEMORY budget, and they are different
 * numbers for the same reason stepScores keeps them apart: a staged batch is
 * ~1.9MB, so eight resident at once is ~15MB alongside the restored tag heap,
 * and a slice that materialized all 64 of its batches in one query would be
 * ~120MB against a 128MB isolate. Same value as SCORES_FETCH_BATCHES, same
 * reasoning, and it is what makes the slice above safe to raise at all.
 */
export const AGG_FETCH_BATCHES = 8;

/**
 * Draft batches finalized per slice.
 *
 * RAISED 4 → 64 on 2026-08-28, and the old value's justification is the reason
 * why. It read: "Finalize buffers ~2KB of row JSON per row in JS while the
 * wasm heap holds tags+aggregates+interners (~90MB at full corpus)". That JS
 * buffer NO LONGER EXISTS — the per-row JSON emit (EMIT_ROW, upstream's D1
 * cards-table feed) was unhooked when row_batches was deleted, and stepFinalize
 * now sets only `onSpill`. What a slice actually holds is its spilled rows:
 * ~36KB per staged batch on the 2026-08-28 corpus (partition 2's 1,180 batches
 * produced a 43MB archive), so 64 batches is ~2.3MB. The constant had been
 * sized for a buffer that was removed underneath it, and nothing said so.
 *
 * What that cost: 1,180 staged batches at 4 per slice is 295 alarms per
 * partition, 2,950 for a ten-partition run. The 2026-08-28 run logged 1,073
 * finalize slices — for THREE partitions — before it tripped
 * MAX_RUN_ROWS_READ. At 64 the same partition is ~19 alarms.
 */
export const FINALIZE_SLICE_BATCHES = 64;

/** Batch rows materialized as JS buffers at once inside a finalize slice — the
 * memory half of the split, exactly as AGG_FETCH_BATCHES is. ~15MB resident. */
export const FINALIZE_FETCH_BATCHES = 8;

/**
 * Build positions rewritten per reorder slice. Each slice indexes the spill and
 * then reads the groups it needs, so it trades slice count against two
 * whole-spill passes.
 *
 * NOT raised on 2026-08-28, deliberately. It is the one slice size bounded by
 * MEMORY rather than by the per-alarm toll: a slice's rows are copied out of
 * the group blobs and held until its transaction commits (~9MB at 12,500 rows
 * of ~750 bytes), and it holds the whole spill's offset index besides. The
 * cost it does carry is real and is the largest single term projectRunCost
 * still charges — five slices per partition, each making two full passes over
 * ~295 spill groups, ~2,950 rows per partition — so it is the next thing to
 * look at if this budget ever needs another factor.
 */
export const REORDER_SLICE_ROWS = 12_500;

/**
 * The fixed storage toll every alarm pays before it does any work, measured
 * from scripts/import-harness on 2026-08-28 (the per-statement table: 14
 * `SELECT value FROM meta WHERE key = ?` plus two `ctx.storage.get` per alarm).
 *
 * READS: the run record, the phase, four budget counters, phase_attempts, the
 * post-step phase re-read, the phase's own cursor keys, and flushMeters' four.
 * WRITES: setAlarm (billed as a row written), phase_attempts, the `retries`
 * reset, and flushMeters' four meta rows.
 *
 * This is why the alarm count IS the budget: a run's floor cost is
 * alarms x these, before a single draft is read.
 */
export const FIXED_ROWS_READ_PER_ALARM = 20;
export const FIXED_ROWS_WRITTEN_PER_ALARM = 8;

/** The shape of a corpus, as the cost model needs to see it. */
export interface RunShape {
	/** draft_batches rows the transform staged (byte-capped, ~1.9MB each). */
	stagedBatches: number;
	/** Rows one partition finalizes — the reorder phase's slice input. */
	rowsPerPartition: number;
	/** spill_batches groups one partition produces. */
	spillGroupsPerPartition: number;
	/** N, as partitionCountFor chose it. */
	partitions: number;
	/** Alarms everything before the partition loop takes (listing through
	 * routing) plus everything after it (manifest through purge). */
	prefixAlarms: number;
}

/** Slice sizes to project against — the module's own by default. Overridable
 * so a caller (and the budget test) can ask what a DIFFERENT slice size would
 * have cost, which is the only way to state "the old value did not fit" as an
 * assertion rather than as a claim in a comment. */
export interface SliceSizes {
	aggBatches: number;
	finalizeBatches: number;
	reorderRows: number;
	/**
	 * Source batches per bucket slice — or `null` for the pipeline BEFORE the
	 * bucket phase, where every partition rescanned the whole draft staging.
	 * Kept as a model so the budget test can state what that pipeline cost as an
	 * assertion, the same way `SLICES_BEFORE` keeps the pre-2026-08-28 slices.
	 */
	bucketBatches: number | null;
}

export const CURRENT_SLICES: SliceSizes = {
	aggBatches: AGG_SLICE_BATCHES,
	finalizeBatches: FINALIZE_SLICE_BATCHES,
	reorderRows: REORDER_SLICE_ROWS,
	bucketBatches: BUCKET_SLICE_BATCHES,
};

export interface RunCost {
	alarms: number;
	/** The toll every alarm pays before doing any work: alarms x the fixed
	 * per-alarm rows. Separated out because it is the term slice sizes control
	 * and the term that blew the 2026-08-28 budget. */
	fixedRowsRead: number;
	fixedRowsWritten: number;
	/** Fixed plus the modelled work. A FLOOR, not a forecast — see below. */
	rowsRead: number;
	rowsWritten: number;
}

/**
 * What a run of this shape costs, from the slice sizes above.
 *
 * Deliberately arithmetic rather than a measurement: it is what a person
 * changing a slice size can re-evaluate without running anything.
 * scripts/import-harness measures the same quantity the other way, by actually
 * running the pipeline, and the two are checked against each other:
 *
 *   2026-08-28, the real corpus's shape at N=10
 *     projectRunCost   610 alarms,  71,200 rows read
 *     harness, scaled  ~590 alarms, ~66,600 rows read     (within 7%)
 *
 * THE WRITE SIDE IS A FLOOR, not a forecast. It counts the per-alarm toll and
 * the staging inserts whose count follows directly from the shape; it does not
 * model the tag-snapshot re-export, the chunk staging, the rulings/reference
 * hash rows, or the progressive purges. The harness measures ~2.4x this. That
 * is why the budget test asserts on `fixedRowsWritten` — a term this model
 * knows exactly — rather than on the total it can only bound from below.
 */
export function projectRunCost(shape: RunShape, slices: SliceSizes = CURRENT_SLICES): RunCost {
	// The bucket pass, or its absence. With it, each partition's agg and finalize
	// read that partition's OWN groups: about stagedBatches / N full ones plus
	// one partial tail per bucket slice (stepBucket flushes what it holds at the
	// end of every slice rather than carrying it over). Without it — the
	// pipeline before 2026-09-04 — every partition walked all of draft_batches
	// twice and filtered in process, so its "groups" were the whole staging.
	const bucketAlarms = slices.bucketBatches === null ? 0 : Math.ceil(shape.stagedBatches / slices.bucketBatches);
	const groupsPerPartition =
		slices.bucketBatches === null
			? shape.stagedBatches
			: Math.ceil(shape.stagedBatches / shape.partitions) + bucketAlarms;
	const aggAlarms = Math.ceil(groupsPerPartition / slices.aggBatches);
	const finalizeAlarms = Math.ceil(groupsPerPartition / slices.finalizeBatches);
	const reorderAlarms = Math.ceil(shape.rowsPerPartition / slices.reorderRows);
	// One build alarm and one publish alarm per partition is the floor; a
	// multi-chunk partition adds publish alarms, which the caller folds into
	// prefixAlarms rather than this model guessing at KV chunk counts.
	const perPartitionAlarms = aggAlarms + finalizeAlarms + reorderAlarms + 2;
	const alarms = shape.prefixAlarms + bucketAlarms + perPartitionAlarms * shape.partitions;

	// Work reads, on top of the per-alarm toll. The bucket pass reads the staging
	// once; each partition then reads its own groups TWICE (agg, then finalize),
	// reorder makes two full passes over the spill groups per slice, and build
	// walks the ordered groups once and precharges the same count.
	const bucketReads = slices.bucketBatches === null ? 0 : shape.stagedBatches;
	const workReads =
		bucketReads +
		shape.partitions *
			(2 * groupsPerPartition + 2 * shape.spillGroupsPerPartition * reorderAlarms + 2 * shape.spillGroupsPerPartition);

	// Writes whose count the shape fixes: one draft_batches row per staged batch
	// (transform); the bucket pass's one row per group it produces and one
	// delete (billed as a write) per source batch it consumes; then each
	// partition's spill groups written once by finalize, once by reorder, and
	// once as chunk staging by build.
	const bucketWrites = slices.bucketBatches === null ? 0 : shape.partitions * groupsPerPartition + shape.stagedBatches;

	const fixedRowsRead = alarms * FIXED_ROWS_READ_PER_ALARM;
	const fixedRowsWritten = alarms * FIXED_ROWS_WRITTEN_PER_ALARM;
	return {
		alarms,
		fixedRowsRead,
		fixedRowsWritten,
		rowsRead: fixedRowsRead + workReads,
		rowsWritten:
			fixedRowsWritten + shape.stagedBatches + bucketWrites + shape.partitions * 3 * shape.spillGroupsPerPartition,
	};
}

/**
 * What the Durable Objects storage pool holds at the worst moment of a
 * nightly: every busy region's cached copy of every partition's compressed
 * archive, plus the coordinator's staging at its peak.
 *
 * The serving cache (store-cache.ts) is bounded by `regions x partition_count x
 * one partition compressed` — that is, regions x the whole compressed store —
 * and the coordinator's staging peaks while the drafts are bucketed (just
 * after transform, before the loop starts consuming them). Both scale with the
 * corpus and they collide on the same night: the publish prefetches the NEW
 * archives into the cache while the OLD ones are still held. Pure, so the
 * budget test can project it forward the way projectRunCost projects the
 * meters — the pool is the 5GB free-plan limit, and the thing that trips it
 * should be a red test, not a failed nightly.
 */
export function projectPoolBytes(shape: {
	/** Regions holding a cached copy — every region with traffic, at most REGION_HINTS.length. */
	warmRegions: number;
	/** `partitions[k].store_gzip_bytes` from the live manifest, one per partition. */
	partitionGzipBytes: readonly number[];
	/**
	 * Store generations a warm region holds at once. 2 during a publish: the
	 * prepare step prefetches the NEW archives into local storage while the OLD
	 * ones still serve, and the commit swaps and only then drops the old rows.
	 */
	generationsHeld: number;
	/** The coordinator's staging at its peak (drafts + tag snapshot + one partition's spill). */
	stagingPeakBytes: number;
}): number {
	const cached = shape.partitionGzipBytes.reduce((s, b) => s + b, 0);
	return shape.warmRegions * shape.generationsHeld * cached + shape.stagingPeakBytes;
}

/** The Workers Free plan's Durable Objects storage pool, in bytes. */
export const DO_STORAGE_POOL_BYTES = 5 * 1024 * 1024 * 1024;
