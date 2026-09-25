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
//     outcomes, and the run's own row meters — now the `run_meters` row), and
//   - scripts/import-harness, which drives this exact pipeline end to end on a
//     scaled synthetic corpus and prints rows read/written per phase.

import type { CacheCodec } from "./engine/types";
import { BLOB_GROUP_BYTES, DRAFT_BATCH_BYTES } from "./import-spill";

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
 * is restartable once it has been idle for STALE_IDLE_MS. Enough restarts and the day is gone
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
/**
 * LOWERED 64 → 16 on 2026-09-16: a 64-batch slice writes ~96MB of partition
 * groups AND deletes ~96MB of source batches in one alarm, a ~190MB burst —
 * the size of burst that left Durable Object storage hours behind (see
 * PACE_START_BPS). At 16 the burst is ~48MB and the pacing spreads the rest.
 *
 * Since 2026-09-25 a slice is also capped at BUCKET_SLICE_RAW_BYTES of raw drafts, the same 16
 * rows at DRAFT_BATCH_BYTES (6MB each). The rows are stored packed (~7x), so the burst is ~28MB
 * of rows written and deleted. A run staged across that deploy, whose rows are 1.5MB, still
 * reads 16 of them per slice.
 */
export const BUCKET_SLICE_BATCHES = 16;
export const BUCKET_SLICE_RAW_BYTES = 96_000_000;
/** Source rows materialized at once: two 6MB-raw rows, ~12MB, the resident-bytes half of the split. */
export const BUCKET_FETCH_BATCHES = 2;

/**
 * Staged bytes one purge slice may delete (src/import-purge.ts).
 *
 * Sized from the one commit production has proven, not from a guess: the
 * bucket slice above deletes 64 x ~1.9MB ≈ 120MB in one transaction on every
 * slice of every run and gets through. The partition's ~300MB completion
 * delete did NOT — the next alarm's first storage read hung behind its flush
 * for hours (2026-09-15, the free account's whole DO duration bill). 32MB is
 * ~4x under the proven commit; ~20 rows is well under a second of CPU; and
 * because every deleted row is billed as a row written whether it goes in one
 * transaction or ten, slicing costs only the per-alarm toll: ~10 alarms per
 * partition, ~100 per run at N=10, which keeps the 3x growth projection in
 * tests/import/run-budget.test.ts inside the day's write cap with margin
 * (24MB did not). The bound is per ALARM, not just per delete: one alarm may
 * walk several tables, but frees no more than this in total, because it is
 * the alarm's flush the next alarm waits on. If the per-slice timing log shows
 * the flush is nowhere near the wall, 48MB is the next step; not before.
 */
export const PURGE_SLICE_BYTES = 32 * 1024 * 1024;
/** Rows one slice may plan over, so the planning read stays a few rows even when they are tiny. */
export const PURGE_SLICE_MAX_ROWS = 64;

/**
 * Raw draft bytes one agg slice reads: 64 of the 1.5MB batches it was counted in until 2026-09-25.
 * Staged groups are up to DRAFT_BATCH_BYTES now, and bucket tails are smaller, so a count of
 * rows is no longer a budget of work; the bytes are (and they are what the CPU note below prices).
 *
 * As a batch count, the history: RAISED 8 → 64 on 2026-08-28, with the resident bytes bounded
 * separately by the fetch group (DRAFT_FETCH_ROWS below), the split stepScores has had since it
 * was written. At 8, one partition's aggregation over the real corpus's ~1,180 staged
 * batches took ~148 alarms, and TEN partitions took ~1,480. Every one of those
 * alarms pays the same fixed toll (FIXED_ROWS_PER_ALARM below), which is why
 * the 2026-08-28 run's single most-read storage statement was
 * `SELECT value FROM meta WHERE key = ?` — the toll, not the work.
 *
 * 64 is bounded by CPU, generously: the 2026-08-28 production alarms measured
 * 40-90ms of CPU per 4-batch finalize slice (~15ms/batch on an edge core), so
 * 64 batches is ~1s against the 30s Durable Object allowance.
 */
export const AGG_SLICE_RAW_BYTES = 64 * BLOB_GROUP_BYTES;

/**
 * Draft rows materialized as JS buffers at once inside an agg or finalize slice.
 *
 * The SLICE is a CPU budget; this is the MEMORY budget, and they are different
 * numbers for the same reason stepScores keeps them apart: a slice that
 * materialized all of its rows in one query would hold ~96MB of drafts against a
 * 128MB isolate. Two rows of up to DRAFT_BATCH_BYTES raw each is ~12MB raw beside
 * their packed bytes — what eight 1.5MB rows held before 2026-09-25. Each row
 * reaches wasm in WASM_FEED_BYTES pieces (feedSlices), never whole.
 */
export const DRAFT_FETCH_ROWS = 2;

/**
 * Raw draft bytes finalized per slice — the same bytes and the same rows as agg's (see
 * AGG_SLICE_RAW_BYTES), 64 of the 1.5MB batches it was counted in. The history, as a count:
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
export const FINALIZE_SLICE_RAW_BYTES = 64 * BLOB_GROUP_BYTES;

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
 *
 * Since 2026-09-16 the run's meters are ONE meta row (`run_meters`, JSON:
 * rows read, rows written, alarms, active milliseconds) instead of the two
 * rows `do_rows_read`/`do_rows_written`. That is where each alarm banks its
 * wall time — the meter behind the free plan's DURATION cap, which the row
 * meters never saw — and it costs LESS than the two rows did: one read at the
 * top for both budget checks (was two), one read and one write in
 * flushMeters (was two and two). The 2026-08-28 toll is kept as its own
 * constant because the calibration test reproduces that run's projection
 * from it; projectRunCost takes the toll as an input.
 */
export interface AlarmToll {
	read: number;
	written: number;
}
export const TOLL_2026_08_28: AlarmToll = { read: 20, written: 8 };
/** Reads and writes the merged `run_meters` row saves per alarm against the 2026-08-28 toll. */
export const MERGED_METERS_ROWS_READ_SAVED = 2;
export const MERGED_METERS_ROWS_WRITTEN_SAVED = 1;
/**
 * The day's two meter rows, `day:<date>:read` and `:written`, merged into one `day:<date>` row
 * (2026-09-25): one read instead of two for the budget check, and one read and one write instead
 * of two and two in flushMeters.
 */
export const MERGED_DAY_METERS_ROWS_READ_SAVED = 2;
export const MERGED_DAY_METERS_ROWS_WRITTEN_SAVED = 1;
/**
 * The `retries` reset after a healthy slice, written only when a retry was recorded (2026-09-25):
 * it wrote a row on every alarm to clear a counter that was nearly always already zero. It reads
 * the row first to see.
 */
export const RETRIES_RESET_ROWS_WRITTEN_SAVED = 1;
export const RETRIES_RESET_ROWS_READ_ADDED = 1;
export const FIXED_ROWS_READ_PER_ALARM =
	TOLL_2026_08_28.read -
	MERGED_METERS_ROWS_READ_SAVED -
	MERGED_DAY_METERS_ROWS_READ_SAVED +
	RETRIES_RESET_ROWS_READ_ADDED;
export const FIXED_ROWS_WRITTEN_PER_ALARM =
	TOLL_2026_08_28.written -
	MERGED_METERS_ROWS_WRITTEN_SAVED -
	MERGED_DAY_METERS_ROWS_WRITTEN_SAVED -
	RETRIES_RESET_ROWS_WRITTEN_SAVED;
export const CURRENT_TOLL: AlarmToll = { read: FIXED_ROWS_READ_PER_ALARM, written: FIXED_ROWS_WRITTEN_PER_ALARM };

// ─── Durable Object duration: the free plan's other meter ────────────────────

/**
 * GB-seconds of Durable Object duration the Workers Free plan allows per day,
 * and what that is in wall seconds for a 128MB object. An object is billed for
 * every second it is ACTIVE — a request, an alarm, or any pending I/O — so a
 * coordinator that hangs inside an alarm spends the whole day's allowance by
 * itself: 93,072 s active, 11,913 GB-s, on 2026-09-15. Past the cap every
 * Durable Object request on the account errors until 00:00 UTC, which is
 * search going dark on the free host.
 */
export const DO_FREE_GB_SECONDS_PER_DAY = 13_000;
export const DO_OBJECT_GB = 0.128;
export const DO_FREE_ACTIVE_SECONDS_PER_DAY = DO_FREE_GB_SECONDS_PER_DAY / DO_OBJECT_GB;

/**
 * Wall time one run may be active before it is called off.
 *
 * A healthy run is ~400 alarms, most of them sub-second, plus the slices that
 * do real I/O — 14 fetch slices of 48MB, 55 transform slices, a build and a
 * publish per partition — which the
 * healthy-run model in tests/import/run-budget.test.ts puts under an hour.
 * Three hours is ~3x that and ~10% of the day's allowance: a run that is still
 * going has been stalling, not working, and the honest outcome is a failed run
 * with the number in its detail rather than a second one of these bills.
 * Under-counts by construction — a slice that never returns never banks its
 * time — which is what the alarm watchdog is for.
 */
export const MAX_RUN_ACTIVE_MS = 3 * 60 * 60_000;

/** The duration a run's active time would bill, in the unit the cap is stated in. */
export function projectedGbSeconds(activeMs: number): number {
	return (activeMs / 1000) * DO_OBJECT_GB;
}

/** The run's meters: one meta row (`run_meters`), JSON. Run-scoped — metaClear drops it. */
export interface RunMeters {
	/** Durable Object rows read and written by this run, what MAX_RUN_ROWS_* are checked against. */
	rows_read: number;
	rows_written: number;
	/** Alarms that have banked into this run. */
	alarms: number;
	/** Wall milliseconds this run's alarms have been active, summed. */
	active_ms: number;
	/** Blob bytes this run has written to and deleted from Durable Object storage (the pacing input). */
	churn_bytes: number;
	/** When the next alarm was asked for (epoch ms), so the alarm that arrives can measure how late it is. 0 = unknown. */
	due_ms: number;
	/** The storage churn rate the run is currently paced to, bytes per second. 0 = not yet set (PACE_START_BPS). */
	pace_bps: number;
	/** Alarms that arrived more than LATE_ALARM_MS after they were due. */
	late_alarms: number;
	/**
	 * When this row was last banked (epoch ms). Every alarm flushes on every exit, so this is the
	 * last moment a slice was provably executing — what startImport reads to tell a run that is
	 * slow (still banking) from one that is dead (nothing banked, nothing scheduled). 0 = never.
	 */
	banked_ms: number;
	/**
	 * The coordinator's own `ctx.storage.sql.databaseSize` high-water mark this run, sampled on
	 * every flush — the MEASURED staging peak r3's pool gate budgets with (decideCacheCodec). Rides
	 * the row every alarm already writes, so it costs no write. 0 = not sampled.
	 */
	peak_db_bytes: number;
}

export const EMPTY_RUN_METERS: RunMeters = {
	rows_read: 0,
	rows_written: 0,
	alarms: 0,
	active_ms: 0,
	churn_bytes: 0,
	due_ms: 0,
	pace_bps: 0,
	late_alarms: 0,
	banked_ms: 0,
	peak_db_bytes: 0,
};

/** Bank one flush; `newAlarm` counts the alarm once per alarm, not per flush. */
export function advanceMeters(
	prev: RunMeters | null,
	delta: {
		rowsRead: number;
		rowsWritten: number;
		elapsedMs: number;
		newAlarm: boolean;
		churnBytes?: number;
		/** `databaseSize` at this flush; folded into the high-water mark. */
		dbBytes?: number;
	},
): RunMeters {
	return {
		...EMPTY_RUN_METERS,
		...(prev ?? {}),
		peak_db_bytes: Math.max(prev?.peak_db_bytes ?? 0, delta.dbBytes ?? 0),
		rows_read: (prev?.rows_read ?? 0) + delta.rowsRead,
		rows_written: (prev?.rows_written ?? 0) + delta.rowsWritten,
		alarms: (prev?.alarms ?? 0) + (delta.newAlarm ? 1 : 0),
		active_ms: (prev?.active_ms ?? 0) + Math.max(0, delta.elapsedMs),
		churn_bytes: (prev?.churn_bytes ?? 0) + Math.max(0, delta.churnBytes ?? 0),
	};
}

/** Read the meters row back; anything unparseable is an empty row, never a crash. */
export function parseMeters(value: string | null | undefined): RunMeters | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Partial<RunMeters>;
		const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		return {
			rows_read: n(parsed.rows_read),
			rows_written: n(parsed.rows_written),
			alarms: n(parsed.alarms),
			active_ms: n(parsed.active_ms),
			churn_bytes: n(parsed.churn_bytes),
			due_ms: n(parsed.due_ms),
			pace_bps: n(parsed.pace_bps),
			late_alarms: n(parsed.late_alarms),
			banked_ms: n(parsed.banked_ms),
			peak_db_bytes: n(parsed.peak_db_bytes),
		};
	} catch {
		return null;
	}
}

// ─── storage churn pacing ────────────────────────────────────────────────────

/**
 * How fast the import may push bytes through Durable Object storage — writes
 * and deletes alike — and how it backs off when storage falls behind.
 *
 * MEASURED 2026-09-16, both accounts, Workers Observability events: the import's
 * alarms spent 1,844 s (daveycodez) and 1,314 s (DeckGen) actually running all
 * day, while the coordinator was billed as active for ~60,000 s. Every lost hour
 * sat BETWEEN alarms: an alarm returned "ok" having churned tens of MB in a
 * burst — 392MB of fetched dump in ~90 s (≈4 MB/s), recode members at ≈7 MB/s,
 * five 32MB purge slices one second apart (≈32 MB/s) — and the NEXT alarm,
 * scheduled for "now", was delivered 31 min, 74 min, 2 h 7 min, 5 h 19 min,
 * 5 h 45 min later, often followed by a reset reported as "Durable Object reset
 * because its code was updated" with no deploy anywhere near it. The same
 * nine-slice purge ran in 7 s on another partition: it is a storage backlog
 * threshold, not a fixed cost, and a commit-size bound (PURGE_SLICE_BYTES)
 * alone did not stay under it, because the bursts were back-to-back.
 *
 * So the chain paces itself: after an alarm that churned B bytes, the next one
 * is scheduled no sooner than B / pace after this one started. The pace starts
 * well under every rate that stalled and adapts — halved whenever an alarm
 * arrives more than LATE_ALARM_MS late (storage fell behind anyway), raised a
 * step after every on-time alarm that did real churn — between the floor and
 * the ceiling. An idle object between alarms is not running anything; the
 * billed hours were the object waiting on storage, which is what pacing
 * prevents.
 */
export const PACE_START_BPS = 1024 * 1024;
export const PACE_MIN_BPS = 256 * 1024;
export const PACE_MAX_BPS = 2 * 1024 * 1024;
/** Additive increase per on-time alarm that churned at least PACE_STEP_MIN_CHURN. */
export const PACE_STEP_BPS = 32 * 1024;
export const PACE_STEP_MIN_CHURN = 4 * 1024 * 1024;
/** An alarm this late means storage fell behind: halve the pace. */
export const LATE_ALARM_MS = 2 * 60_000;
/** No single pause longer than this, whatever one alarm churned. */
export const PACE_MAX_DELAY_MS = 10 * 60_000;

/**
 * Margin the dead-man alarm adds to the phase's watchdog limit.
 *
 * The platform retries a failed or KILLED alarm at most six times and then
 * consumes it. A slice the runtime keeps killing (CPU or memory) never reaches
 * the handler's catch, so nothing reschedules; after the sixth retry the run
 * record still says "running" and no alarm exists — the 2026-08-22→27 silent
 * week. The coordinator therefore arms a dead-man alarm at the START of every
 * retried attempt, far enough out that a live handler has already been ended
 * by its watchdog before it could fire. A completed or thrown slice replaces it
 * through the ordinary next-alarm put; only a killed slice leaves it standing,
 * and it fires with a fresh platform retry budget, so `phase_attempts` keeps
 * counting until MAX_PHASE_ATTEMPTS fails the run with the phase named.
 */
export const DEAD_MAN_MARGIN_MS = 60_000;
export function deadManDelayMs(watchdogMs: number): number {
	return watchdogMs + DEAD_MAN_MARGIN_MS;
}

/** How long after `now` the next alarm should be scheduled, given this alarm's churn and how long it already ran. */
export function paceDelayMs(churnBytes: number, elapsedMs: number, paceBps: number): number {
	if (churnBytes <= 0) return 0;
	const bps = Math.max(PACE_MIN_BPS, paceBps || PACE_START_BPS);
	const wanted = (churnBytes / bps) * 1000 - Math.max(0, elapsedMs);
	return Math.round(Math.min(PACE_MAX_DELAY_MS, Math.max(0, wanted)));
}

/**
 * The pace for the NEXT stretch, from how late the alarm that just arrived was
 * and how much the alarm just run churned. Multiplicative decrease on a late
 * alarm, additive increase on an on-time one that did real work, clamped.
 */
export function adjustPace(paceBps: number, lagMs: number, churnBytes: number): number {
	const current = paceBps || PACE_START_BPS;
	if (lagMs > LATE_ALARM_MS) return Math.max(PACE_MIN_BPS, Math.floor(current / 2));
	if (churnBytes >= PACE_STEP_MIN_CHURN) return Math.min(PACE_MAX_BPS, current + PACE_STEP_BPS);
	return Math.min(PACE_MAX_BPS, Math.max(PACE_MIN_BPS, current));
}

/** The shape of a corpus, as the cost model needs to see it. */
export interface RunShape {
	/**
	 * The staged drafts, in the unit they were measured in: 1.5MB-raw batches
	 * (MEASURED_BATCH_RAW_BYTES). How many ROWS they make is the slice sizes' business
	 * (SliceSizes.draftBatchBytes).
	 */
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
	/**
	 * Bytes one partition's publish leaves in staging to be purged: its
	 * draft_parts, spill groups, ordered groups and chunk staging. Decides the
	 * purge slices per partition (PURGE_SLICE_BYTES).
	 */
	stagingBytesPerPartition: number;
	/**
	 * Bytes the phases BEFORE the loop drop at their boundaries, purged in the
	 * same slices: since 2026-09-17 only the tag and label dumps after tags —
	 * all_cards and default_cards are streamed from Scryfall, never staged.
	 */
	prefixStagingBytes: number;
}

/** Slice sizes to project against — the module's own by default. Overridable
 * so a caller (and the budget test) can ask what a DIFFERENT slice size would
 * have cost, which is the only way to state "the old value did not fit" as an
 * assertion rather than as a claim in a comment. */
export interface SliceSizes {
	/** Raw draft bytes per staged draft_batches row and per bucketed draft_parts group. */
	draftBatchBytes: number;
	/** Raw draft bytes one agg / finalize slice reads. */
	aggBytes: number;
	finalizeBytes: number;
	reorderRows: number;
	/**
	 * Source rows per bucket slice — or `null` for the pipeline BEFORE the
	 * bucket phase, where every partition rescanned the whole draft staging.
	 * Kept as a model so the budget test can state what that pipeline cost as an
	 * assertion, the same way `SLICES_BEFORE` keeps the pre-2026-08-28 slices.
	 */
	bucketBatches: number | null;
	/**
	 * Bytes per staging-purge slice — or `null` for the pipeline BEFORE
	 * 2026-09-16, when a partition's completion deleted its whole staging in
	 * one transaction (zero extra alarms, and the commit that wedged the
	 * object). Kept as a model for the same reason as `bucketBatches: null`.
	 */
	purgeBytes: number | null;
}

/** The raw bytes of one batch of RunShape.stagedBatches — BLOB_GROUP_BYTES, the size every staged
 * draft row was when the shapes were measured. */
export const MEASURED_BATCH_RAW_BYTES = BLOB_GROUP_BYTES;

export const CURRENT_SLICES: SliceSizes = {
	draftBatchBytes: DRAFT_BATCH_BYTES,
	aggBytes: AGG_SLICE_RAW_BYTES,
	finalizeBytes: FINALIZE_SLICE_RAW_BYTES,
	reorderRows: REORDER_SLICE_ROWS,
	bucketBatches: BUCKET_SLICE_BATCHES,
	purgeBytes: PURGE_SLICE_BYTES,
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
export function projectRunCost(
	shape: RunShape,
	slices: SliceSizes = CURRENT_SLICES,
	toll: AlarmToll = CURRENT_TOLL,
): RunCost {
	// The bucket pass, or its absence. With it, each partition's agg and finalize
	// read that partition's OWN groups: about stagedBatches / N full ones plus
	// one partial tail per bucket slice (stepBucket flushes what it holds at the
	// end of every slice rather than carrying it over). Without it — the
	// pipeline before 2026-09-04 — every partition walked all of draft_batches
	// twice and filtered in process, so its "groups" were the whole staging.
	//
	// Rows are DRAFT-BYTE-capped: the staging's raw bytes over the row size (2026-09-25: 6MB, four
	// of the 1.5MB rows the shape was measured in). Agg and finalize slices are budgeted in raw
	// bytes, so a partition's slices are its share of the raw bytes over the slice's.
	const stagedRawBytes = shape.stagedBatches * MEASURED_BATCH_RAW_BYTES;
	const stagedRows = Math.ceil(stagedRawBytes / slices.draftBatchBytes);
	const bucketAlarms = slices.bucketBatches === null ? 0 : Math.ceil(stagedRows / slices.bucketBatches);
	const groupsPerPartition =
		slices.bucketBatches === null ? stagedRows : Math.ceil(stagedRows / shape.partitions) + bucketAlarms;
	const partitionRawBytes = slices.bucketBatches === null ? stagedRawBytes : stagedRawBytes / shape.partitions;
	const aggAlarms = Math.ceil(partitionRawBytes / slices.aggBytes);
	const finalizeAlarms = Math.ceil(partitionRawBytes / slices.finalizeBytes);
	const reorderAlarms = Math.ceil(shape.rowsPerPartition / slices.reorderRows);
	// One build alarm and one publish alarm per partition is the floor; a
	// multi-chunk partition adds publish alarms, which the caller folds into
	// prefixAlarms rather than this model guessing at KV chunk counts. The
	// purge of the partition's staging is its own sliced step after publish; the
	// alarm that empties the last table moves the loop on itself.
	const purgeAlarms = slices.purgeBytes === null ? 0 : Math.ceil(shape.stagingBytesPerPartition / slices.purgeBytes);
	// The phase-boundary purge before the loop (the tag dumps), at the same
	// slice; it costs at least one alarm even when its kinds are already gone.
	const prefixPurgeAlarms =
		slices.purgeBytes === null ? 0 : Math.max(1, Math.ceil(shape.prefixStagingBytes / slices.purgeBytes));
	const perPartitionAlarms = aggAlarms + finalizeAlarms + reorderAlarms + 2 + purgeAlarms;
	const alarms = shape.prefixAlarms + prefixPurgeAlarms + bucketAlarms + perPartitionAlarms * shape.partitions;

	// Work reads, on top of the per-alarm toll. The bucket pass reads the staging
	// once; each partition then reads its own groups TWICE (agg, then finalize),
	// reorder makes two full passes over the spill groups per slice, and build
	// walks the ordered groups once and precharges the same count.
	const bucketReads = slices.bucketBatches === null ? 0 : stagedRows;
	const workReads =
		bucketReads +
		shape.partitions *
			(2 * groupsPerPartition + 2 * shape.spillGroupsPerPartition * reorderAlarms + 2 * shape.spillGroupsPerPartition);

	// Writes whose count the shape fixes: one draft_batches row per staged batch
	// (transform); the bucket pass's one row per group it produces and one
	// delete (billed as a write) per source batch it consumes; then each
	// partition's spill groups written once by finalize, once by reorder, and
	// once as chunk staging by build.
	const bucketWrites = slices.bucketBatches === null ? 0 : shape.partitions * groupsPerPartition + stagedRows;

	const fixedRowsRead = alarms * toll.read;
	const fixedRowsWritten = alarms * toll.written;
	return {
		alarms,
		fixedRowsRead,
		fixedRowsWritten,
		rowsRead: fixedRowsRead + workReads,
		rowsWritten: fixedRowsWritten + stagedRows + bucketWrites + shape.partitions * 3 * shape.spillGroupsPerPartition,
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
 * corpus and they are both standing marks — every SQLite file keeps its
 * high-water (see "WHAT IT CANNOT DO" in the r3 section below). Until x1 the publish prefetched the NEW
 * archives into the cache while the OLD ones were still held, two generations
 * per region; since x1 every fill drops the old build first, one. Pure, so the
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
	 * Store generations a warm region holds at once. 1 since x1 (drop, then fill): the prepare step
	 * drops the OLD archives before it prefetches the NEW ones — the old store serves from wasm
	 * memory, not from its rows. 2 is what every publish held before, kept as a model so the budget
	 * test can state that it did not fit.
	 */
	generationsHeld: number;
	/**
	 * The coordinator's own high-water mark: its staging at its peak (drafts + tag snapshot + one
	 * partition's spill). Not staging PLUS the notify residue — both live in the coordinator's one
	 * file, whose mark is the larger of them, and the residue (~0.066GB) is the smaller.
	 */
	stagingPeakBytes: number;
}): number {
	const cached = shape.partitionGzipBytes.reduce((s, b) => s + b, 0);
	return shape.warmRegions * shape.generationsHeld * cached + shape.stagingPeakBytes;
}

/** The Workers Free plan's Durable Objects storage pool, in bytes. */
export const DO_STORAGE_POOL_BYTES = 5 * 1024 * 1024 * 1024;

// ── r3: the engine objects' local cache codec, gated on the pool ──────────────
//
// An engine object can hold its partition's local cache as the gzip members KV stores, or as LZ4
// frames the engine re-encodes after a load (store-cache.ts, "The LZ4 archive cache") — ~3x
// cheaper to decode on every wake in workerd, x1.449 the bytes (every partition of generation 52,
// 2026-09-25: 212.6MB of LZ4 against 146.7MB of gzip, x1.453 at worst). So the nightly decides per
// BUILD which one objects may WRITE, from measured inputs, and publishes the answer in the manifest
// (StoreManifest.cache). Readers accept either family whatever it says.
//
// A FLIP COSTS NOTHING EXTRA to carry out. Every publish is a new build under new archive keys, so
// every cache is rewritten anyway: the codec only chooses what an object writes after its NEXT load
// of the NEW build. The dead band below is for predictability, not cost.
//
// WHAT IT CANNOT DO IS GIVE THE POOL BACK. A Durable Object's SQLite keeps the pages its deletes
// free (only deleteAll returns them), so each object's FILE sits at its high-water mark. Measured
// 2026-09-25 in workerd (miniflare 5 / workerd 1.20260801, a 14.7MB partition, four publishes):
// `databaseSize` falls back to the live pages after a DELETE, but the object's .sqlite file keeps the
// most it ever held — 30.5MB (two builds) when each fill wrote the new build beside the old, 15.3MB
// (one build) when the old build was dropped first and its freed pages reused. Production agrees on
// the second half: the three coordinators x8 released read ~0.2MB of databaseSize each and were
// still billed ~1.1GB until deleteAll.
//
// So the mark is set by the worst moment of every fill, and since x1 (drop, then fill — store.ts
// prefetchStore, compressedArchiveBytes, fillLz4Cache) that moment holds ONE build: the old one is
// dropped before the new one's first row, and under LZ4 the prefetched gzip goes before the LZ4
// frames are written. The worst moment is therefore max(gzip, LZ4) of one build, not their sum plus
// the old build's (cacheHighWaterFactor). An object created before x1 keeps its old mark until it is
// released — at most the two builds the gate accepted when it was set, which one build of either
// codec now fits inside, so a flip to LZ4 does not grow it. Switching the codec OFF stops the mark
// from growing with the corpus; it does not lower it until the object is released. Hence a gate
// that turns on only well inside the budget.

/** LZ4 cache bytes per gzip byte: x1.449 measured over all ten partitions (x1.453 worst), rounded UP. */
export const LZ4_CACHE_RATIO = 1.5;

/**
 * The pool the gate budgets against: 5.0e9, not DO_STORAGE_POOL_BYTES (5 GiB). The plan says "5 GB";
 * budgeting against the smaller reading costs 7% of headroom and removes the question of which unit
 * the dashboard means.
 */
export const POOL_GATE_BUDGET_BYTES = 5_000_000_000;
/** gzip -> lz4 only when the LZ4 projection is at or under this share of the budget. */
export const LZ4_ON_FRACTION = 0.8;
/** lz4 -> gzip as soon as the LZ4 projection passes this share. Between the two, keep what was published. */
export const LZ4_OFF_FRACTION = 0.88;

/**
 * What one replica object's cache file peaks at, per gzip byte of the build it holds (x1): ONE build,
 * in the larger of the two forms it passes through. A gzip object holds the gzip chunks (1); an LZ4
 * object holds the prefetched gzip, drops it, then writes the LZ4 frames (LZ4_CACHE_RATIO) — never
 * both, and never beside the previous build. Before x1 this was `cacheFactor + 1`: the object's own
 * cache beside the next build's gzip prefetch.
 */
export function cacheHighWaterFactor(cacheFactor: number): number {
	return Math.max(cacheFactor, 1);
}

/**
 * The pool at its high-water mark under a cache codec: every replica object at its cache file's
 * high-water mark (cacheHighWaterFactor x the build's gzip bytes), plus the coordinator's own
 * staging high-water mark, plus the staging replaced coordinators still hold.
 *
 * Summed, not max'd: they are different objects, and every SQLite file keeps its own high-water
 * mark (see above), so the staging peak of the build and each replica's fill are standing costs,
 * not moments that could be scheduled apart.
 */
export function projectCachePool(shape: {
	/** Replica groups that hold a cache: every ROUTABLE region's shard 0, plus the shards announced above it. */
	replicas: number;
	/** `partitions[k].store_gzip_bytes` of the build being published. */
	partitionGzipBytes: readonly number[];
	/** 1 for gzip caches, LZ4_CACHE_RATIO for lz4. */
	cacheFactor: number;
	/** The coordinator's databaseSize high-water mark (RunMeters.peak_db_bytes). */
	stagingPeakBytes: number;
	/** Staging still held by replaced (failed-over) coordinators; 0 once they are released. */
	strandedBytes: number;
}): number {
	const perBuild = shape.partitionGzipBytes.reduce((s, b) => s + b, 0);
	return (
		shape.replicas * perBuild * cacheHighWaterFactor(shape.cacheFactor) + shape.stagingPeakBytes + shape.strandedBytes
	);
}

/** generation 52's raw store bytes, the corpus STAGING_PEAK_BYTES_2026_09_25 was measured at. */
export const STAGING_PEAK_STORE_BYTES = 425_181_152;

/**
 * The coordinator staging high-water to budget for a build: last night's MEASURED mark when the
 * manifest carries it (StoreManifest.cache.staging_bytes, written by the pool gate from
 * RunMeters.peak_db_bytes), else the 2026-09-25 meter reading scaled by the store.
 */
export function stagingBytesOf(manifest: {
	store_bytes?: number;
	cache?: { staging_bytes?: number } | undefined;
}): number {
	const measured = manifest.cache?.staging_bytes;
	if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) return measured;
	return (STAGING_PEAK_BYTES_2026_09_25 * (manifest.store_bytes ?? 0)) / STAGING_PEAK_STORE_BYTES;
}

/**
 * x1(b): how many replica shards per region the pool can hold — the cap the shard controller
 * expands to (index.ts) and the notify releases above (stepNotify).
 *
 * Every region may open the same number, so the bound is uniform: `regions x cap` replica groups,
 * each holding one build at the manifest's codec (cacheHighWaterFactor), plus the coordinator's
 * staging, must stay under the gate's OFF threshold — the same line past which the gate itself
 * turns LZ4 off, so the cap and the codec can never disagree about what fits. Shard 0 always
 * exists, so the cap is never below 1.
 *
 * `null` when the inputs cannot decide it (no partition sizes, no regions): the caller keeps its
 * configured cap. Measured inputs today (0.147GB per build, 8 routable regions, 0.50GB staging):
 * 3 shards per region under gzip, 2 under LZ4; at 2x the corpus 1; at 3x 1.
 */
export function poolShardCap(shape: {
	regions: number;
	partitionGzipBytes: readonly number[];
	cacheFactor: number;
	stagingPeakBytes: number;
	budget?: number;
}): number | null {
	const perReplica = shape.partitionGzipBytes.reduce((s, b) => s + b, 0) * cacheHighWaterFactor(shape.cacheFactor);
	if (!(perReplica > 0) || !(shape.regions >= 1)) return null;
	const room = LZ4_OFF_FRACTION * (shape.budget ?? POOL_GATE_BUDGET_BYTES) - Math.max(0, shape.stagingPeakBytes || 0);
	return Math.max(1, Math.floor(room / (shape.regions * perReplica)));
}

/**
 * What each partition's engine object caches for a build, per partition: its archive's stored gzip
 * bytes plus the build's card-names blob (n8, `names_bytes`), which EVERY partition object caches
 * once it answers an autocomplete — ~0.45MB beside a ~15MB partition today. The pool projections
 * take their per-object bytes from here, so the names are counted wherever the archives are. (The
 * LZ4 factor then multiplies the names too, which they never are: a slight over-count, the safe
 * direction for a gate.)
 */
export function partitionCacheBytes(manifest: {
	partitions?: readonly { store_gzip_bytes?: number }[];
	names_bytes?: number;
}): number[] {
	const names = typeof manifest.names_bytes === "number" && manifest.names_bytes > 0 ? manifest.names_bytes : 0;
	return (manifest.partitions ?? []).map((p) => (p.store_gzip_bytes ?? 0) + names);
}

/** poolShardCap for a published manifest, over the `regions` requests can reach under its placement. */
export function manifestPoolShardCap(
	manifest: {
		store_bytes?: number;
		partitions?: readonly { store_gzip_bytes?: number }[];
		names_bytes?: number;
		cache?: { v?: number; codec?: string; staging_bytes?: number };
	},
	regions: number,
): number | null {
	return poolShardCap({
		regions,
		partitionGzipBytes: partitionCacheBytes(manifest),
		cacheFactor: manifest.cache?.v === 1 && manifest.cache.codec === "lz4" ? LZ4_CACHE_RATIO : 1,
		stagingPeakBytes: stagingBytesOf(manifest),
	});
}

/**
 * x1(c): may a run START staging while replaced coordinators still hold theirs? The pool at this
 * run's own staging peak, beside the live build's caches and every retiring run's staging (each
 * budgeted at one staging peak — x8's watchdog releases them within a tick or two, but a wedged one
 * holds its rows until it wakes), must stay under the budget. Nothing retiring is always yes.
 */
export function poolAdmitsRun(shape: {
	retiring: number;
	replicas: number;
	partitionGzipBytes: readonly number[];
	cacheFactor: number;
	stagingPeakBytes: number;
	budget?: number;
}): boolean {
	if (shape.retiring <= 0) return true;
	const projected = projectCachePool({
		replicas: shape.replicas,
		partitionGzipBytes: shape.partitionGzipBytes,
		cacheFactor: shape.cacheFactor,
		stagingPeakBytes: shape.stagingPeakBytes,
		strandedBytes: shape.retiring * shape.stagingPeakBytes,
	});
	return projected <= (shape.budget ?? POOL_GATE_BUDGET_BYTES);
}

/** How long a run waits at listing for retiring coordinators to be released (the watchdog's tick is 10 minutes). */
export const POOL_WAIT_MS = 5 * 60_000;
/**
 * Waits before a run starts anyway. An hour covers six watchdog ticks; past it a retiring object is
 * wedged, and not importing tonight does not free its rows — the run proceeds and says so.
 */
export const MAX_POOL_WAITS = 12;

/** The codec the next build publishes, with a dead band so a replica shard opening or closing does not toggle it. */
export function decideCacheCodec(
	previous: CacheCodec | undefined,
	projectedLz4Bytes: number,
	budget: number = POOL_GATE_BUDGET_BYTES,
): CacheCodec {
	if (!Number.isFinite(projectedLz4Bytes) || projectedLz4Bytes <= 0) return "gzip";
	if (previous === "lz4") return projectedLz4Bytes > LZ4_OFF_FRACTION * budget ? "gzip" : "lz4";
	return projectedLz4Bytes <= LZ4_ON_FRACTION * budget ? "lz4" : "gzip";
}

/**
 * The coordinator's staging at its peak — a METER READING: GraphQL durableObjectsSqlStorageGroups
 * read 0.486–0.495GB for the ImportCoordinator namespace on DeckGen 2026-09-20, -21 and -23, each a
 * run stalled while holding its staging (backlog x1, report 13). The pool gate measures its own
 * (RunMeters.peak_db_bytes) and uses this only for a run that began before that meter existed,
 * scaled by the store's raw bytes against generation 52's 425,181,152. The first gated runs agreed:
 * 2026-09-25's Pool gate lines read 0.50GB (free) and 0.54GB (DeckGen), 1% margin included. All of
 * these staged drafts at deflate level 1; DRAFT_CODEC_LEVEL 6 takes ~20% off the drafts, ~80% of
 * the peak. Left as measured — a fallback should not be an estimate — and the gate's own
 * measurement replaces it from the first run that stages at level 6.
 */
export const STAGING_PEAK_BYTES_2026_09_25 = 495_000_000;
