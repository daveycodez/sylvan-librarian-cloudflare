// The partitioned build+publish loop's durable state: partition sizing and the
// ONE `pp_publish` meta value that replaces the flat publish-cursor trio.
//
// The trio (kv_chunks_published / kv_cursor_seq / kv_cursor_off, plus their
// satellites kv_chunk_cut and kv_gzip_bytes) had a standing bug class: every
// code path that restarted a publish had to remember to reset ALL of them, and
// one forgotten reset resumed a fresh publish from a stale cursor — quietly,
// into a store that assembles wrong. With N partitions each owning a cursor,
// that class scales by N. So the whole loop state is one JSON value, written
// whole in the same transaction as the progress it describes: there is no
// second key to forget, and a partition restart rebuilds its record from one
// constructor instead of five metaSets.
//
// Everything here is pure (state in, state out, no storage), so the resume
// semantics — mid-partition, mid-chunk, across a SAFE-cut restart — are
// testable without a Durable Object. The coordinator owns persistence: it
// parses the value at each alarm, mutates through these helpers, and
// serializes back inside its transactions.

import { chunkCountFor, KV_CHUNK_BYTES, KV_CHUNK_BYTES_SAFE } from "./engine/store-kv";

// ─── partition count (plan Decision 3b) ──────────────────────────────────────

/**
 * Target RAW archive bytes per partition, the knob N is derived from.
 *
 * MUST STAY <= KV_CHUNK_BYTES, and that is the binding reason for the value.
 * `kvArchiveStream` pulls a partition's chunks strictly in sequence (the
 * do-not-parallelize note in store-kv.ts), so a partition whose raw bytes cross
 * the chunk cut costs an extra sequential round trip on every cold load. At
 * 48_000_000 — above the 46_000_000 cut — the real corpus measured 42-46MB
 * partitions and five of eight took a second, nearly-empty chunk: 13 chunks
 * where the design says 8. 43MB sits under the cut with room for the
 * projection's own error, and lands today's corpus on nine ~40MB partitions,
 * one chunk each.
 *
 * It also keeps a partition's build inside the wasm import's memory class (the
 * single-archive build peaked at 120.9MiB against the 124MiB cap at 83.9MB of
 * archive — see the gate tripwire; measured per-partition builds run 35-46MB).
 * The router never sees this number — it reads partition_count from the
 * manifest.
 */
export const TARGET_PARTITION_BYTES = 43_000_000;

/**
 * The floor. Two, not one, so the partitioned pipeline is genuinely exercised
 * on every corpus that reaches it: an N=1 "partitioned" store is the unsplit
 * pipeline wearing a suffix, and every partition-boundary bug would wait for
 * corpus growth to surface it.
 */
export const MIN_PARTITION_COUNT = 2;

/**
 * The ceiling, a safety rail rather than a plan: 48 partitions of the 43MB target is ~2.06GB of
 * projected store, 4.8x today's corpus (N=10 on ~427MB projected). Hitting it means the projection
 * input is garbage (and N should not amplify the garbage), or the corpus grew past every budget in
 * this deployment and needs a human anyway.
 *
 * WHY A CEILING HERE IS A MEMORY QUESTION. Past the ceiling N stops growing and every partition
 * grows instead — and a partition's build is the nightly's memory peak. Measured with the import
 * harness (2026-09-25; wasm linear memory at the build alarm, which the 124MiB --max-memory link
 * cap bounds and ~10MB of JS sits beside) on the synthetic corpus cut at a 53MB harness target,
 * which reproduces the real corpus's N and ~41MB partitions (its drafts are ~25% heavier per
 * archive byte): N=10/20/30 build at 98.9 / 103.2 / 106.8MB at 1x / 2x / 3x. At 4x, 32 partitions
 * of ~50MB built at 106-122MB and the 18th TRAPPED (`build_store_stream` unreachable), so the run
 * failed; 40 partitions of ~41MB built at 101-103MB and published. The ceiling of 32 bound at
 * ~3.2x the real corpus (1.77GB staged x 3.24 x 0.24 / 43MB = 32). At 48 partitions stay at the
 * target through 4.8x.
 *
 * WHY NOT HIGHER. Everything below grows with N and none of it with the corpus bytes a partition
 * holds, so the ceiling is the lowest one that keeps partitions at the target past the 3x stress
 * case with margin:
 *   - every /search and every unrouted /cards/* route asks all N partitions (one billed Durable
 *     Object request each), and every live replica group holds N engine objects that wake apart;
 *   - each publish is N KV chunk puts plus one `engine:live` announcement per object per store —
 *     ~30 + (1 + G) x N writes for G live replica groups against the free plan's 1,000 a day
 *     (free: G ~4, so ~280 a publish at 48; ~360 at 64, over the day's allowance at three
 *     publishes);
 *   - stepNotify prepares and commits every live object in ONE alarm: ~2 x G x N calls against the
 *     free plan's 1,000 subrequests to Cloudflare services per invocation;
 *   - the routing filter's name keys store `N + s` for a name served in partition s, one byte a
 *     cell with 255 reserved, so N <= 127 (tests/engine/routing-filter.test.ts pins it at this
 *     ceiling);
 *   - the bucket phase holds one PackStream per partition, ~0.4MB each (6MB more at 48 than 32).
 *
 * The Rust builder's `MAX_PARTITIONS` (engine/builder/src/lib.rs) is the same number for the
 * deploy path's `--partitions auto` — keep the two in step.
 */
export const MAX_PARTITION_COUNT = 48;

/**
 * PARTITIONED archive bytes produced per byte of staged draft JSON — the
 * projection ratio.
 *
 * MEASURED AT G2 on the real all_cards corpus (2026-08-15, 517,746 drafts =
 * 1,480,683,467 staged bytes): the N=8 build totals 353.3MB of archives
 * (0.239 archive bytes per draft byte; N=32 measures 0.247). 0.24 projects
 * tonight's corpus to N=8; 0.25 would round to N=9, erring toward more
 * partitions, which costs alarms rather than the memory cap. The pre-G2
 * placeholder was 0.95, derived from the English-only gen-19 archive —
 * printed_text interning (426k names -> 247k uniques; text deduped by
 * (oracle, lang) across reprints) is why the multilingual ratio is 4x lower.
 *
 * NEVER project from a single-archive measurement: the N=1 shape is
 * SUPERLINEAR (same corpus builds 1,792.8MB unpartitioned vs 353.3MB at N=8 —
 * a ~1.4GB quadratic-class index appears only at full single-archive scale,
 * ratio 1.211), which is exactly the mistake that made the builder's auto arm
 * clamp to N=32. The Rust builder's auto projection uses this same constant
 * and derivation — keep the two comments twinned.
 */
export const DRAFT_TO_STORE_RATIO = 0.24;

/** Projected RAW archive bytes for a corpus staged as `stagedDraftBytes` of draft JSON. */
export function projectedStoreBytes(stagedDraftBytes: number): number {
	return Math.ceil(stagedDraftBytes * DRAFT_TO_STORE_RATIO);
}

/**
 * The partition count for tonight's corpus:
 * clamp(ceil(projected_store_bytes / TARGET_PARTITION_BYTES), MIN, MAX).
 *
 * Computed ONCE, when the loop starts (end of tags, drafts fully staged), and
 * persisted as pp_publish's partitions[].length — a mid-loop restart reads the
 * persisted state and can never re-derive a different N, which matters because
 * N is baked into every already-published chunk key and every draft's
 * partition assignment.
 *
 * `targetBytes` exists for ONE caller: the local end-to-end harness
 * (scripts/import-harness), which runs a corpus a fiftieth of the real one and
 * would otherwise always land on MIN_PARTITION_COUNT — a two-partition loop has
 * a first partition and a last one and no partition that is neither, which is
 * exactly the position (partition 2 of 10) the 2026-08-28 production run died
 * in. Production never passes it; the default IS TARGET_PARTITION_BYTES.
 */
export function partitionCountFor(stagedDraftBytes: number, targetBytes = TARGET_PARTITION_BYTES): number {
	if (!Number.isFinite(stagedDraftBytes) || stagedDraftBytes < 0) {
		throw new Error(`cannot size partitions from ${stagedDraftBytes} staged draft bytes`);
	}
	if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
		throw new Error(`cannot size partitions against a ${targetBytes}-byte target`);
	}
	const wanted = Math.ceil(projectedStoreBytes(stagedDraftBytes) / targetBytes);
	return Math.min(MAX_PARTITION_COUNT, Math.max(MIN_PARTITION_COUNT, wanted));
}

// ─── the pp_publish value ────────────────────────────────────────────────────

/**
 * Where the loop stands for its CURRENT partition (mirrors the phase meta, same transaction).
 *
 * `purge` follows `publish`: every chunk is in KV and the partition's staging
 * is being retired in bounded slices (src/import-purge.ts) before the loop
 * advances — or, on the last partition, before the manifest is written.
 */
export type PartitionStep = "agg" | "finalize" | "reorder" | "build" | "publish" | "purge";

/**
 * One partition's build outputs and publish progress.
 *
 * Zeroed until its build runs (store_bytes 0 is "not built"); the cursor
 * fields are live only while its publish is in flight; chunk_count is stamped
 * at publish completion and is what the manifest record carries.
 */
export interface PartitionPublishRecord {
	/** RAW archive bytes, from the build's own stats. 0 = this partition has not built yet. */
	store_bytes: number;
	card_count: number;
	printing_count: number;
	/** KV chunks this partition published; stamped at its publish completion. */
	chunk_count: number;
	/** Chunks already in KV for this partition's in-flight publish. */
	chunks_published: number;
	/** Staging cursor (see StagingCursor in store-kv.ts): next chunk_staging row / offset within it. */
	cursor_seq: number;
	cursor_off: number;
	/** The RAW cut this partition publishes at; drops to KV_CHUNK_BYTES_SAFE on a fallback restart. */
	cut: number;
	/** Gzipped bytes in KV so far / in total for this partition. */
	gzip_bytes: number;
}

/** The whole loop's durable state — ONE meta value (`pp_publish`). */
export interface PpPublish {
	/** The partition the loop is currently on, 0-based. */
	partition: number;
	/** Where the loop stands for that partition. */
	step: PartitionStep;
	/**
	 * One record per partition, index k at position k. THE LENGTH IS N — the
	 * chosen partition_count, persisted here at loop start so a restart cannot
	 * re-derive a different one (there is deliberately no second copy to drift).
	 */
	partitions: PartitionPublishRecord[];
}

function freshRecord(): PartitionPublishRecord {
	return {
		store_bytes: 0,
		card_count: 0,
		printing_count: 0,
		chunk_count: 0,
		chunks_published: 0,
		cursor_seq: 0,
		cursor_off: 0,
		cut: KV_CHUNK_BYTES,
		gzip_bytes: 0,
	};
}

/** The loop state at its start: partition 0, agg, N zeroed records. */
export function initialPpPublish(partitionCount: number): PpPublish {
	if (!Number.isInteger(partitionCount) || partitionCount < 1) {
		throw new Error(`partitionCount must be a positive integer, got ${partitionCount}`);
	}
	return {
		partition: 0,
		step: "agg",
		partitions: Array.from({ length: partitionCount }, freshRecord),
	};
}

export function serializePpPublish(state: PpPublish): string {
	return JSON.stringify(state);
}

/**
 * Parse a persisted pp_publish value, refusing a malformed one.
 *
 * Null in, null out — "the loop has not started" — but bytes that do not parse
 * to a coherent state are an ERROR, not null: treating them as absent would
 * silently restart the loop from partition 0 against chunk keys that already
 * exist, which is exactly the resume-from-stale-cursor bug this value exists
 * to make unrepresentable.
 */
export function parsePpPublish(json: string | null): PpPublish | null {
	if (json === null) return null;
	const state = JSON.parse(json) as PpPublish;
	if (
		!Number.isInteger(state.partition) ||
		!Array.isArray(state.partitions) ||
		state.partition < 0 ||
		state.partition >= state.partitions.length
	) {
		throw new Error(`pp_publish is malformed: ${json.slice(0, 200)}`);
	}
	return state;
}

/** The state's current partition record. */
export function currentRecord(state: PpPublish): PartitionPublishRecord {
	return state.partitions[state.partition] as PartitionPublishRecord;
}

/**
 * Record the current partition's build outputs and arm its publish.
 *
 * The cursor reset lives HERE, in the one transition that invalidates any
 * previous cursor, rather than as a checklist at call sites — the shape the
 * flat trio's forgotten-reset bug demanded.
 */
export function recordBuild(state: PpPublish, storeBytes: number, cardCount: number, printingCount: number): void {
	const rec = currentRecord(state);
	rec.store_bytes = storeBytes;
	rec.card_count = cardCount;
	rec.printing_count = printingCount;
	rec.chunk_count = 0;
	rec.chunks_published = 0;
	rec.cursor_seq = 0;
	rec.cursor_off = 0;
	rec.cut = KV_CHUNK_BYTES;
	rec.gzip_bytes = 0;
	state.step = "publish";
}

/** One chunk landed in KV: advance the current partition's cursor. */
export function recordChunk(state: PpPublish, cursor: { seq: number; off: number }, gzipBytes: number): void {
	const rec = currentRecord(state);
	rec.chunks_published += 1;
	rec.cursor_seq = cursor.seq;
	rec.cursor_off = cursor.off;
	rec.gzip_bytes += gzipBytes;
}

/**
 * A chunk compressed past KV's value cap at the ambitious cut: restart THIS
 * partition's publish at the safe cut. Scoped to the current record only —
 * partitions already published at the ambitious cut stay as they are (each
 * partition's chunk math is self-contained in its manifest record), and
 * partitions not yet built will start ambitious again, because one
 * badly-compressing partition says nothing about its siblings.
 */
export function restartAtSafeCut(state: PpPublish): void {
	const rec = currentRecord(state);
	rec.cut = KV_CHUNK_BYTES_SAFE;
	rec.chunks_published = 0;
	rec.cursor_seq = 0;
	rec.cursor_off = 0;
	rec.gzip_bytes = 0;
}

/** KV chunks the current partition's publish must write in total. */
export function publishChunkTotal(state: PpPublish): number {
	const rec = currentRecord(state);
	return chunkCountFor(rec.store_bytes, rec.cut);
}

/** Stamp the finished partition's chunk_count (its manifest record is now complete). */
export function completePartitionPublish(state: PpPublish): void {
	const rec = currentRecord(state);
	rec.chunk_count = publishChunkTotal(state);
}

/**
 * Move the loop to the next partition's agg, or report there is none.
 *
 * False means the state's current partition was the LAST one — the caller
 * moves on to the manifest and leaves the loop. The state is deliberately not
 * mutated in that case, so the completed records stay addressed by a valid
 * partition index for the manifest assembly. Called from the partition's
 * purge completion, once its staging is gone — never from publish itself.
 */
export function advanceToNextPartition(state: PpPublish): boolean {
	if (state.partition + 1 >= state.partitions.length) return false;
	state.partition += 1;
	state.step = "agg";
	return true;
}
