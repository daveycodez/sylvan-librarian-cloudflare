// ImportCoordinator: a plain SQLite-backed Durable Object that runs the whole
// nightly/bootstrap store import on-platform — no container, no external CI.
//
// One named instance ("singleton") serializes runs. Triggers:
//   - nightly cron (src/index.ts scheduled handler), the only trigger
// The FULL bulk import runs in the deploy instead (scripts/import-store.sh),
// where there is 8GB and 20 minutes rather than a 128MB isolate and 30s
// alarms; this pipeline exists to refresh an already-published index.
//
// The pipeline is the wasm import module (engine/wasm-import) — the same Rust
// the native dev builder runs — driven phase by phase through an alarm chain
// so no single invocation exceeds the isolate CPU allowance:
//
// ONE PIPELINE. The corpus is all_cards, the build is partitioned, and the
// commit point is the single manifest key — there is no second shape to select
// between (src/import-phases.ts holds the dump list and the chain):
//
//   listing   Scryfall /bulk-data → dump URIs
//   fetch     ranged, resumable download of each compressed dump → SQLite
//   (recode   RETIRED: all_cards and default_cards are STREAMED, never staged,
//             and resume through openDumpStream's inflater checkpoints)
//   canonical default_cards' ids → the canonical-printing set, snapshotted as
//             TagData (tagdata_blobs) — built BEFORE transform because every
//             all_cards row's is_canonical is membership in this set
//   transform all_cards JSONL → RowDraft blobs (batched into SQLite), each
//             carrying its 64-bit oracle-id partition hash
//   tags      tag dumps → in-wasm TagData (+ snapshot to SQLite for restarts);
//             fixes built_at and computes partition_count N ONCE at its end
//             (plan B3/Decision 3b) — the loop below reads both from meta, so a
//             mid-loop restart can fork neither
//   scores    EVERY partition's drafts → the corpus-wide finalize tables
//             (cubecobra percent-rank over the whole corpus's card names;
//             illustration counts, whose (illustration_id, card_name) group is
//             the one key the partition hash does not co-locate), sealed into
//             the same TagData snapshot before the loop opens
//   bucket    EVERY draft moved into its partition's own draft_parts rows
//             (bucketDrafts re-mods each stored hash by N), ONCE, consuming
//             draft_batches as it goes — so the loop below reads 1/N of the
//             corpus per partition where it used to read all of it N times
//   [for p in 0..N):                  the PARTITIONED build+publish loop.
//     agg(p)      partition p's draft_parts, pass 1: dedupe winners and pin
//                 slots — both keyed inside one card, so partition-local —
//                 through a FRESH group wasm + restored tags per partition, so
//                 no partition's heap high-water carries into the next
//     finalize(p) same drafts, pass 2: ENGINE_COLUMNS rows → spill blobs.
//                 partition p's draft_parts are dropped when its PUBLISH
//                 completes (a rewind during reorder/build still needs them)
//     reorder(p)  partition p's spill rewritten in build order
//     build(p)    spilled rows → partition p's own rkyv archive
//                 (card-store-v<fmt>-<built_at>-p<k>.store) → chunk staging;
//                 the group wasm is DROPPED here, before the publish slices
//                 (§5.5 emit-one-release-one, enforced by the loop shape)
//     publish(p)  partition p's chunks to KV; its spill/ordered/chunk staging
//                 is purged when its publish completes (progressive purge —
//                 the 5GB pool never holds two partitions' staging)
//   ]
//   manifest  written LAST, after every chunk of every partition — the
//             partitioned manifest is the commit point readers act on; then
//             prune superseded builds
//   rulings   the rulings dump → 256 KV buckets for /cards/:id/rulings; after
//             publish and unable to fail the run, because nothing but that one
//             route reads them
//   reference api.scryfall.com's /sets, /catalog/* and /symbology → KV, for the
//             routes of the same names; same posture as rulings
//   purge     drop the Worker's edge cache, once, right after notify has
//             every engine DO on the new manifest — deliberately NOT at the commit point
//
// Restart safety: every phase's inputs live in this DO's SQLite, and phase
// progress commits transactionally with its outputs. Phases whose state lives
// inside the wasm heap (tags/agg/finalize interners) record the wasm
// instance nonce; if the DO was evicted mid-group, the group restarts from
// its SQLite inputs — minutes of redone compute, never a wrong store.

import { DurableObject } from "cloudflare:workers";
import { addressAnnouncedEngine, engineName, parseEngineName, replicaGroupOf } from "./engine/engine-namespace";
import {
	dropGroupWasm,
	groupWasm,
	type ImportWasm,
	newGroupWasm,
	type SnapshotRows,
	transientWasm,
} from "./engine/import-wasm";
import { staleKeys } from "./engine/kv-versions";
import {
	ORACLE_INDEX_KEY_PREFIX,
	ORACLE_INDEX_META_KEY,
	OracleIndexBuilder,
	type OracleIndexMeta,
	oracleIndexBucketKey,
	oracleIndexCurrentPrefix,
	planOracleIndexPublish,
} from "./engine/oracle-index";
import {
	continentOfColo,
	effectiveRegion,
	nextPlacement,
	notifyRetireReason,
	type PlacementBlock,
	unreachableEngine,
} from "./engine/placement-policy";
import { probeHints } from "./engine/placement-probe";
import {
	CATALOG_NAMES,
	catalogKey,
	encodeCountedArray,
	REFERENCE_CONTENT_GENERATION,
	REFERENCE_FORMAT_VERSION,
	REFERENCE_KEY_PREFIX,
	REFERENCE_META_KEY,
	type ReferenceMeta,
	rawArrayElements,
	referenceCurrentPrefix,
	renderCatalog,
	renderSets,
	renderSymbology,
	SETS_BUCKET_COUNT,
	setsBucketKey,
	setsListKey,
	symbologyKey,
} from "./engine/reference-kv";
import { REGION_HINTS } from "./engine/region";
import {
	buildRoutingFilterFromHashes,
	ROUTING_FEATURE_NAME_KEYS,
	RoutingKeyAccumulator,
} from "./engine/routing-filter";
import {
	encodeRulingsBucket,
	parseRulingLine,
	RULINGS_BUCKET_COUNT,
	RULINGS_CONTENT_GENERATION,
	RULINGS_FORMAT_VERSION,
	RULINGS_KEY_PREFIX,
	RULINGS_META_KEY,
	type RulingRow,
	type RulingsMeta,
	rulingsBucketKey,
	rulingsBucketOf,
	rulingsCurrentPrefix,
} from "./engine/rulings-kv";
import { GridChunker } from "./engine/store-chunks";
import {
	assembleChunk,
	chunkHeadroomWarning,
	chunkKey,
	gzipBytes,
	KEEP_STORES_IN_KV,
	KV_CHUNK_BYTES_SAFE,
	KV_VALUE_CAP_BYTES,
	MANIFEST_KEY,
	missingManifestChunks,
	PARTITION_HASH_ALGO,
	PUBLISHING_KEY,
	PUBLISHING_TTL_SECONDS,
	partitionFamilyPrefix,
	partitionStoreKey,
	REGION_LIVE_PREFIX,
	STORE_CONTENT_GENERATION,
	type StagedRow,
	staleStoreKeys,
	storeKeyStem,
	writeManifest,
	writeRoutingFilter,
} from "./engine/store-kv";
import { tagAliasesKey, writeTagAliases } from "./engine/tag-aliases";
import type { Env, StoreManifest, StoreManifestCache, StoreManifestPartition } from "./engine/types";
import { PackStream, packBlob, unpackBlob } from "./import-blob-codec";
import {
	AGG_SLICE_RAW_BYTES,
	adjustPace,
	advanceMeters,
	BUCKET_FETCH_BATCHES,
	BUCKET_SLICE_BATCHES,
	BUCKET_SLICE_RAW_BYTES,
	DO_FREE_GB_SECONDS_PER_DAY,
	DRAFT_FETCH_ROWS,
	deadManDelayMs,
	decideCacheCodec,
	EMPTY_RUN_METERS,
	FINALIZE_SLICE_RAW_BYTES,
	LATE_ALARM_MS,
	LZ4_CACHE_RATIO,
	LZ4_OFF_FRACTION,
	MAX_DAY_ROWS_READ,
	MAX_DAY_ROWS_WRITTEN,
	MAX_RUN_ACTIVE_MS,
	MAX_RUN_ROWS_READ,
	MAX_RUN_ROWS_WRITTEN,
	MEASURED_BATCH_RAW_BYTES,
	PACE_START_BPS,
	POOL_GATE_BUDGET_BYTES,
	PURGE_SLICE_BYTES,
	PURGE_SLICE_MAX_ROWS,
	paceDelayMs,
	parseMeters,
	projectCachePool,
	projectedGbSeconds,
	REORDER_SLICE_ROWS,
	STAGING_PEAK_BYTES_2026_09_25,
} from "./import-budget";
import { isBlankLine, scanJsonlSlice } from "./import-lines";
import { DUMP_KINDS, type DumpKind, firstFetchPhase, phaseAfterFetch, TRANSFORM_KIND } from "./import-phases";
import {
	advanceToNextPartition,
	completePartitionPublish,
	currentRecord,
	initialPpPublish,
	type PpPublish,
	parsePpPublish,
	partitionCountFor,
	publishChunkTotal,
	recordBuild,
	recordChunk,
	restartAtSafeCut,
	serializePpPublish,
	TARGET_PARTITION_BYTES,
} from "./import-publish";
import { PURGE_TABLES, type PurgeScope, type PurgeTable, planPurgeSlice } from "./import-purge";
import { InflateRecodeSource, MEMBER_RAW_BYTES, type ResumableInflate, skipBytes } from "./import-recode";
import {
	blobBytes,
	blobGroups,
	bucketDrafts,
	DRAFT_BATCH_BYTES,
	exactBuffer,
	feedSlices,
	lengthPrefixed,
	orderedRowCursor,
	type PackedDraftGroup,
	packedDraftGroups,
	packPartHashes,
	reorderSlice,
	routingStagingRows,
	STAGED_ROW_BYTES,
	spillIndex,
	splitBatch,
	unpackPartHashes,
} from "./import-spill";
import {
	COORDINATOR_POINTER_KEY,
	type CoordinatorPointer,
	type CoordinatorStatus,
	LEGACY_COORDINATOR_NAME,
	readPointer,
} from "./import-watchdog";

interface RunRecord {
	/** `superseded`: the watchdog designated a newer coordinator while this run was in flight (import-watchdog.ts). */
	state: "idle" | "starting" | "running" | "done" | "failed" | "superseded";
	reason?: string;
	startedAt?: string;
	finishedAt?: string;
	detail?: string;
}

/**
 * A run that has banked nothing and scheduled nothing for this long is dead and may be restarted.
 *
 * Measured from ACTIVITY, not from the run's start. The old rule — a run older than 90 minutes is
 * lost — contradicted the pacing model (a healthy paced run is under 4h at the start pace and
 * under 16h at the floor, tests/import/run-budget.test.ts), so it only ever fired at the 24h cron
 * boundary, where it wiped a legitimately slow run; and it said nothing about whether a slice was
 * executing at that moment, so metaClear could run under an alarm parked on a Scryfall read, whose
 * transaction then committed its cursor into the NEW run. Thirty minutes of silence cannot be a
 * live slice: the watchdog ends any slice at 5-10 minutes and every exit banks the meters row.
 */
const STALE_IDLE_MS = 30 * 60 * 1000;
/**
 * A cron start this soon after a finished run's START is a duplicate delivery (startImport). Half
 * a day: far past any duplicate, and far short of the next nightly 24 hours on.
 */
const DUPLICATE_CRON_WINDOW_MS = 12 * 3_600_000;
/** Transient-failure retries per run before the run is marked failed. */
const MAX_RETRIES = 8;
/**
 * Consecutive attempts at one phase before the run is declared stuck.
 *
 * Sits above MAX_RETRIES because it counts a strictly larger set: every
 * attempt, including the ones killed before they could fail. Its job is to
 * put a ceiling on a loop that reports no errors at all, so it only has to be
 * loose enough never to fire on genuine retry-and-recover.
 *
 * REACHABLE ONLY BECAUSE OF THE DEAD-MAN ALARM (runAlarmBody). The platform
 * retries a killed alarm at most six times and then consumes it, so on its own
 * a kill loop stops at seven attempts with no alarm left and the run record
 * still saying "running" — under this ceiling, silent until the next cron,
 * which restarted from scratch and died at the same slice: the 2026-08-22→27
 * week. Every RETRIED attempt now arms a dead-man alarm before running the
 * slice, so a kill never exhausts the platform's budget without something
 * scheduled behind it, and the count keeps climbing to this ceiling, where
 * failRun names the phase.
 *
 * DELIBERATELY UNCHANGED for the partitioned loop (plan B3). The loop
 * multiplies how many SLICES a run makes (~N times the agg/finalize/reorder/
 * build/publish alarms), not how many consecutive attempts any one slice
 * needs: the counter resets to zero on every slice that completes, so a
 * healthy N-partition run passes this gate exactly as a healthy N=1 run did —
 * one attempt per slice, many more slices. What the ceiling bounds is a single
 * slice the runtime keeps killing, and partitioning makes each slice SMALLER,
 * not larger.
 */
const MAX_PHASE_ATTEMPTS = 12;
/**
 * Times one run may lose its wasm heap to eviction and rewind to aggregation
 * before it is called off. Three is generous — a healthy import survives with
 * zero — and the cost of each one is most of an import.
 */
const MAX_WASM_REWINDS = 3;

/**
 * How long one alarm may run before the object resets ITSELF.
 *
 * A Durable Object is billed for every second it is active, and it stays active
 * while any I/O is pending — so an alarm stuck on a storage read that never
 * resolves (2026-09-15: hours behind one 300MB delete's flush, every day, the
 * free account's whole duration bill) costs the day, not the slice. The
 * platform kills an alarm at 15 minutes of wall time and retries it, which
 * changes nothing when the retry stalls on the same I/O. `ctx.abort()` does
 * what a deploy did by accident: tear the instance down so the pending alarm
 * re-fires on a fresh one, which re-reads its cursor and redoes one slice.
 *
 * Five minutes is far above any legitimate slice — a streamed transform slice
 * inflates ~60MB, a small dump's fetch or a chunk gzip+put is seconds —
 * and far below the 15-minute wall. `notify` gets the long leash: it waits on
 * every region's prefetch of ~146MB of compressed archives.
 */
const ALARM_WATCHDOG_MS = 5 * 60_000;
const ALARM_WATCHDOG_MS_BY_PHASE: Partial<Record<Phase, number>> = { notify: 10 * 60_000 };

/**
 * Passes the `purge` phase makes. ONE, now that convergence is an event.
 *
 * This was 2, with a 10-minute PURGE_DELAY_MS in front of each, and both numbers
 * existed for the same reason: nothing could observe when the engine DOs had
 * picked up the new store. The delay was sized to outlast the two things that
 * bounded it — a 5-minute manifest re-check in store.ts plus KV's 60s cache on
 * the manifest read — and the second pass covered the hole the first could not:
 * convergence was lazy AND deferred, so a colo with no traffic during the first
 * pass would swap only on its next request, and that request wrote a stale answer
 * straight back into a cache that had just been emptied. For `/cards/*` that
 * entry then stood for 16 hours.
 *
 * The `notify` phase removes the premise. It pushes the new store to every region
 * and does not advance until they have all acknowledged, so by the time this runs
 * there is no reader left holding the old store and nothing to refill the cache
 * with a stale answer. Purging once, immediately, is now correct — and strictly
 * better than waiting, because every second between the publish and the purge is
 * a second of old answers still being served from the edge.
 */
const PURGE_PASSES = 1;

/** Meta keys under this prefix are day-scoped and survive a run reset. */
const DAY_PREFIX = "day:";

/**
 * How long a retiring run's purge waits after its attempt limit or a spent retry count before
 * trying again (deferRetire). Long enough not to churn against a platform problem, short enough
 * that the staging it holds is back in the storage pool the same day.
 */
const RETIRE_DEFER_MS = 60 * 60_000;

/** An import failure that retrying cannot fix, so the run stops at once. */
/** A platform daily-quota rejection (KV writes, DO storage): distinguishable
 * from a transient failure because backoff cannot clear it before midnight. */
function isQuotaError(err: unknown): boolean {
	return /daily limit|exceeded your|too many writes|quota/i.test(String(err));
}

class FatalImportError extends Error {}

// Slice budgets — sized so a slice stays far under the 30s DO CPU allowance.
/** Compressed dump bytes fetched per slice (network-bound, cheap CPU). */
const FETCH_SLICE_BYTES = 48 * 1024 * 1024;
/** Bulk JSONL lines transformed per slice (~2-4s of wasm CPU at all_cards'
 * CJK-heavy mix). 540,484 all_cards lines ≈ 55 slices — each resuming O(1)
 * into the recoded members (stagedBytes), so the slice count no longer
 * multiplies a decompress-the-prefix cost. Sized for isolate memory as much as
 * CPU: the slice's drafts buffer in JS until the transaction — worst case all
 * 10k lines draft, at ~1.5KB for an English draft and ~2.5-4KB for a foreign
 * one carrying printed_* text, ≈ 25-40MB of JS buffers (+ 80KB of hashes)
 * alongside a transient wasm heap holding the ~2MB canonical set — comfortably
 * inside 128MB, but not a budget to double casually. */
const TRANSFORM_SLICE_LINES = 10_000;
/** default_cards lines fed to the canonical id pass per slice. ~117k canonical
 * printings at ~3.9KB/line ≈ 450MB raw → 5 slices of 24k lines / ~94MB raw
 * (plan B2 says ~4-6). default_cards is streamed through openDumpStream, whose
 * inflater checkpoint lets a slice resume mid-dump without re-inflating the
 * prefix; the slice's own cost is an id-only serde parse of its window (~1s). */
const CANONICAL_SLICE_LINES = 24_000;
/** Raw draft bytes folded into the corpus-wide finalize tables per slice.
 *
 * 24 of the 1.5MB batches it was counted in until 2026-09-25 (staged rows are up to
 * DRAFT_BATCH_BYTES now), so the same work per slice: small per draft — three fields off a narrow
 * serde struct, one hash lookup, no dedupe map, no interners — against a fixed per-slice overhead,
 * the corpus tables restored and re-exported around it. ~36MB of drafts per slice. */
const SCORES_SLICE_RAW_BYTES = 24 * MEASURED_BATCH_RAW_BYTES;
/** Draft rows materialized as JS buffers at once inside a scores slice — the agg slice's
 * resident-bytes budget (DRAFT_FETCH_ROWS). */
const SCORES_FETCH_ROWS = DRAFT_FETCH_ROWS;
/** Drafts per SQLite batch row: DRAFT_BATCH_BYTES of draft JSON, packed under the 2MB value cap. */
// Draft batching is by BYTES (DRAFT_BATCH_BYTES, via packedDraftGroups) rather than by draft count.
//
// It was `DRAFTS_PER_BATCH = 1_000`, which silently made the SQLite row size a function of how fat
// a draft happens to be — and Durable Object SQLite rejects a value over 2 MB with SQLITE_TOOBIG.
// Adding the Scryfall compat residue to `RowDraft` (generation 10) grew each draft enough to cross
// that, and the import failed in the transform phase with nothing to say a size limit was what it
// hit. The spill and row batches were already byte-capped; drafts were the one that was not.
/** SQLite blob row size for staged dumps and tag-data snapshots. The wasm module cuts its streamed
 * snapshot exports at the same size (engine/wasm-import SNAPSHOT_CHUNK), so each emit is one row. */
const STAGE_BLOB_BYTES = STAGED_ROW_BYTES;
/** The two snapshot tables: the TagData (tags, labels, slugs; the canonical set before tags), and
 * the corpus-wide finalize tables alone. */
type SnapshotTable = "tagdata_blobs" | "corpus_blobs";
/** Lines per wasm transform call within a slice. */
const LINES_PER_CALL = 2_000;
// Store retention lives in src/engine/store-kv.ts (KEEP_STORES_IN_KV), shared with the deploy
// path so one policy governs both writers.
/** JsonlStream parity: parse-coverage hard-failure thresholds (bulk.rs). */
const PARSE_COVERAGE_MIN_BYTES = 1_000_000;
const PARSE_COVERAGE_THRESHOLD = 0.8;
/**
 * Rulings buckets built per slice.
 *
 * Every slice re-streams the whole rulings dump and keeps only the entries whose bucket falls in
 * its range, so this trades passes over a 25.7MB decode (cheap: ~0.5s) against how much of it a
 * slice holds at once. 64 of 256 buckets is a quarter of the corpus — ~6.5MB of comments — where
 * building all 256 in one pass would hold the lot as JS strings, at two bytes a character.
 */
const RULINGS_SLICE_BUCKETS = 64;
/** KV puts issued at once within a rulings slice. */
const RULINGS_PUT_CONCURRENCY = 8;
/**
 * Attempts at the notify phase before the run proceeds WITHOUT the objects that never acked.
 *
 * Every throw in notify is an ordinary retry (MAX_RETRIES, minutes of backoff) and then failRun —
 * but by then the manifest is written and the store is live, so one persistently unreachable
 * engine object used to cost the purge (16h of old /cards/* answers at the edge), the rulings and
 * the reference mirrors, and mark the run failed. An object that never acked reads the manifest
 * from KV on its next cold load anyway; after this many attempts the phase counts the acks it has.
 */
const NOTIFY_MAX_ATTEMPTS = 4;
/**
 * Attempts at the rulings phase before the run gives up on it and moves ON.
 *
 * Below MAX_RETRIES on purpose: this phase runs AFTER the store is published, so letting it fail
 * the run would strand a live store with no `purge` — the edge would keep serving answers built
 * from the store this run replaced, for up to 16 hours. Upstream takes the same position from the
 * other end (rulings_import logs its failures rather than raising, "rulings are the only thing in
 * the import sequence nothing else reads"), and the cost of moving on is that yesterday's rulings
 * stay served, which is what the stable bucket keys guarantee.
 */
const RULINGS_MAX_ATTEMPTS = 3;

/** Overridable for tests and self-hosted mirrors (SCRYFALL_BULK_URL var). */
const BULK_DATA_URL = "https://api.scryfall.com/bulk-data";
/**
 * The API root the reference phase mirrors from (SCRYFALL_API_URL var).
 *
 * A separate constant from the bulk listing URL even though both point at api.scryfall.com today:
 * the two are different kinds of endpoint — one lists dumps to download, the other IS the data —
 * and a deployment that mirrors dumps locally has no reason to also mirror the API.
 */
const SCRYFALL_API_URL = "https://api.scryfall.com";
/**
 * Milliseconds to wait before each api.scryfall.com request in the reference phase.
 *
 * Scryfall's documented ask is 50-100ms between requests; this takes the conservative end, because
 * the whole phase is twenty-two requests and nothing waits on it. The dump downloads are not paced
 * by this — they are one ranged request per slice against data.scryfall.io, already spread across
 * alarms.
 */
const SCRYFALL_REQUEST_DELAY_MS = 100;

/**
 * Version stamp on a streamed dump's recode_checkpoint row. 1 was the retired
 * recode phase's (a position in staged blobs feeding member recoding); a row
 * of that version is never trusted by the streams.
 */
const STREAM_CHECKPOINT_VERSION = 2;
/** Raw bytes between stream checkpoints: the most a resume re-inflates before its first line. */
const STREAM_CHECKPOINT_GRID_RAW = MEMBER_RAW_BYTES;

/** A decoder snapshot on the checkpoint grid. */
interface StreamCheckpoint {
	raw: number;
	state: Uint8Array;
}

/** An open streamed dump (openDumpStream). */
interface DumpStream {
	/** Raw bytes from the requested offset onward. */
	bytes: AsyncIterable<Uint8Array>;
	/** The newest decoder snapshot at or before raw offset `raw`, if the stream reached one. */
	checkpointAtOrBefore(raw: number): StreamCheckpoint | null;
	/** Stop the download. */
	close(): Promise<void>;
}
// WHICH dumps a run fetches, and where the chain goes after each, live in
// src/import-phases.ts (DUMP_KINDS / phaseAfterFetch) — one list, with the
// per-dump ordering rationale beside it.

type Phase =
	| "idle"
	| "listing"
	| `fetch:${DumpKind}`
	| "canonical"
	| "transform"
	| "tags"
	| "scores"
	| "routing"
	| "oracle_index"
	| "bucket"
	| "agg"
	| "finalize"
	| "reorder"
	| "build"
	| "publish"
	// The partition's staging retired in bounded slices (src/import-purge.ts);
	// also the run-start reset and the wasm rewind's clean-up, by `purge_scope`.
	| "purge_staging"
	// Every partition published and purged: g1's nightly placement probes, just before the
	// manifest that carries their verdict.
	| "placement"
	// The manifest write, the commit point.
	| "manifest"
	| "notify"
	| "rulings"
	| "reference"
	| "purge";

/** Content hash of one published bucket, for "have these bytes changed since last night?". */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Newline-join buffered lines into one wasm call's payload (canonical + transform slices). */
function joinLines(lineBufs: Uint8Array[], lineBytes: number): Uint8Array {
	const joined = new Uint8Array(lineBytes + lineBufs.length - 1);
	let at = 0;
	for (let i = 0; i < lineBufs.length; i++) {
		if (i > 0) joined[at++] = 0x0a;
		const buf = lineBufs[i] as Uint8Array;
		joined.set(buf, at);
		at += buf.length;
	}
	return joined;
}

/** `sylvan-librarian-worker/<YYYYMMDD>` — Scryfall rejects default UAs. */
function userAgent(): string {
	const d = new Date();
	const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
	return `sylvan-librarian-worker/${stamp}`;
}

export class ImportCoordinator extends DurableObject<Env> {
	/** Schema created once per instance — see ensureSchema. */
	private schemaReady = false;
	/** Set when a retire purge finishes: the alarm deletes the whole object's storage once its last write is done. */
	private releaseAfterAlarm = false;

	// ── metered storage ────────────────────────────────────────────────────────
	//
	// Durable Objects meter SQL rows read and written, and the free plan's
	// ceilings (5M read, 100k written per day) are day-scoped: spend them and
	// the storage API starts throwing for everything, which is how an import
	// loop once took the search wake path down with it — every DO lost its
	// local store copy at once and fell back to a 15s reload.
	//
	// So the import counts what it spends, out of the runtime's own accounting
	// rather than an estimate of ours, and stops itself before it can spend a
	// day's worth. The counters live on the instance and are flushed to storage
	// each alarm, because eviction mid-run is normal here and a budget that
	// resets on eviction would bound nothing.
	private rowsRead = 0;
	private rowsWritten = 0;
	/** Blob bytes this alarm wrote to or deleted from storage, for pacing the next one. */
	private churnThisAlarm = 0;
	/** Churn not yet banked into run_meters (flushMeters can run more than once per alarm). */
	private churnUnbanked = 0;
	/** The pace and due time flushMeters persists for the alarm that arrives next. */
	private paceBps = 0;
	private nextDueMs = 0;
	private lateThisAlarm = false;
	/** When the running alarm started, or last banked its time (flushMeters advances it). */
	private alarmStartedAt = 0;
	/** Whether the running alarm has been counted into the ledger yet (flushMeters runs more than once per alarm). */
	private alarmCounted = false;

	/** Execute and materialise, adding what it cost to this run's totals. */
	private sqlAll<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
		const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings);
		const rows = cursor.toArray();
		this.rowsRead += cursor.rowsRead;
		this.rowsWritten += cursor.rowsWritten;
		return rows;
	}

	/**
	 * Execute and iterate lazily, metering once the cursor is exhausted.
	 *
	 * Needed wherever materialising would defeat the point: the spill scan walks
	 * ~200MB of staged rows to build its offset index and discards the bytes as
	 * it goes, so it must stay a stream.
	 */
	private *sqlIter<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): Generator<T> {
		const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings);
		try {
			for (const row of cursor) yield row;
		} finally {
			this.rowsRead += cursor.rowsRead;
			this.rowsWritten += cursor.rowsWritten;
		}
	}

	/**
	 * Execute a statement that writes, adding what it cost to this run's totals.
	 *
	 * Every write must come through here. The counters used to live only in
	 * sqlAll/sqlIter, while every INSERT and DELETE called `sql.exec` directly —
	 * so the run's rows-written meter read ZERO after an import that wrote hundreds of
	 * rows, and the daily write-budget guard below could never fire. That guard
	 * is the one thing standing between a looping import and a spent free-tier
	 * allowance, and it was measuring nothing.
	 *
	 * A write cursor has no rows to drain, so its counters are final as soon as
	 * exec returns.
	 */
	/**
	 * The KV-style storage calls, BANKED like the SQL ones. `ctx.storage.put`, `get`, `setAlarm` and
	 * `deleteAlarm` each cost a row on the same meter (a delete bills as a write), and the toll
	 * model in import-budget.ts has counted them since 2026-08-28 — but the live counters the
	 * self-cap is checked against did not, so the two drifted by ~3 writes and ~2 reads an alarm.
	 * `getAlarm` is read only from startImport, outside any alarm's ledger, and stays uncounted.
	 */
	private async storeGet<T>(key: string): Promise<T | undefined> {
		this.rowsRead += 1;
		return this.ctx.storage.get<T>(key);
	}

	private async storePut(key: string, value: unknown): Promise<void> {
		this.rowsWritten += 1;
		await this.ctx.storage.put(key, value);
	}

	private async armAlarm(atMs: number): Promise<void> {
		this.rowsWritten += 1;
		await this.ctx.storage.setAlarm(atMs);
	}

	private async disarmAlarm(): Promise<void> {
		this.rowsWritten += 1;
		await this.ctx.storage.deleteAlarm();
	}

	private sqlRun(query: string, ...bindings: unknown[]): void {
		const cursor = this.ctx.storage.sql.exec(query, ...bindings);
		this.rowsRead += cursor.rowsRead;
		this.rowsWritten += cursor.rowsWritten;
		// Blob bytes written are the pacing input (see PACE_START_BPS); deletes
		// report their bytes where they know them (noteChurn).
		let blobBytes = 0;
		for (const b of bindings) {
			if (b instanceof ArrayBuffer) blobBytes += b.byteLength;
			else if (ArrayBuffer.isView(b)) blobBytes += b.byteLength;
		}
		if (blobBytes > 0) this.noteChurn(blobBytes);
	}

	/** Count bytes written to or deleted from storage toward this alarm's pacing and the run's meter. */
	private noteChurn(bytes: number): void {
		if (bytes <= 0) return;
		this.churnThisAlarm += bytes;
		this.churnUnbanked += bytes;
	}

	/** The blob bytes a delete is about to free, for tables where no caller already knows them. */
	private blobBytesIn(where: string, ...bindings: unknown[]): number {
		return Number(
			this.sqlAll<{ n: number }>(`SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS n FROM ${where}`, ...bindings)[0]?.n ?? 0,
		);
	}

	/**
	 * Create the staging schema. Deliberately NOT in the constructor: DDL is a
	 * storage write, and the Durable Objects free tier blocks writes once the
	 * daily rows_written allowance is spent. Writing in the constructor made
	 * every instantiation throw while blocked — including plain GET /status —
	 * so the one surface that could have explained the outage was the one
	 * surface that could not respond. Write paths call this; the read path
	 * tolerates its absence.
	 */
	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.sqlRun(
			`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS stage_files (
				kind TEXT PRIMARY KEY, uri TEXT NOT NULL, etag TEXT,
				total_bytes INTEGER, fetched_bytes INTEGER NOT NULL DEFAULT 0,
				done INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS stage_blobs (
				kind TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL,
				PRIMARY KEY (kind, seq)
			);
			-- RETIRED 2026-09-17: all_cards re-compressed into independent gzip
			-- members by the recode phase, so transform could resume at any raw
			-- offset. all_cards is streamed from Scryfall now (openDumpStream) and
			-- nothing writes here; the table stays so the run-start purge drains
			-- what a pre-streaming run left behind.
			CREATE TABLE IF NOT EXISTS stage_members (
				kind TEXT NOT NULL, seq INTEGER NOT NULL,
				raw_start INTEGER NOT NULL, raw_len INTEGER NOT NULL, bytes BLOB NOT NULL,
				PRIMARY KEY (kind, seq)
			);
			-- The resumable recode path's decoder checkpoint: the wasm gzip
			-- inflater's serialized state (~33KB, its own layout version inside,
			-- engine/inflate) as of EXACTLY raw_done decompressed bytes — written
			-- in the same transaction as the window it describes, so it can never
			-- disagree with recode_raw_done; a row whose version or raw_done does
			-- not match is dead weight the next alarm ignores (falling back to
			-- the from-byte-0 stream) and the next commit replaces.
			CREATE TABLE IF NOT EXISTS recode_checkpoint (
				kind TEXT PRIMARY KEY, version INTEGER NOT NULL,
				raw_done INTEGER NOT NULL, state BLOB NOT NULL
			);
			-- part_hashes: count × 8 bytes, little-endian u64 — the i-th entry is the
			-- fnv1a64(oracle_id) partition hash of the batch's i-th length-prefixed
			-- draft (see the draft-partition-hash block in import-spill.ts for why it
			-- is a parallel vector and a full hash rather than a per-draft INTEGER or
			-- a partition index). stepBucket re-mods it by the partition_count the
			-- build chose (bucketDrafts) and moves each draft into draft_parts.
			CREATE TABLE IF NOT EXISTS draft_batches (seq INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL, part_hashes BLOB);
			-- The same drafts, re-bucketed by partition once N is known (stepBucket):
			-- partition k's drafts in emission order, in byte-capped length-prefixed
			-- groups. The composite key is what makes a partition's agg and finalize
			-- read ITS rows and no others — an index seek, charged for the rows it
			-- returns — where they used to walk all of draft_batches and filter in
			-- process, N times over, which is the term that grew as N x corpus.
			-- Dropped per partition at its publish (the last point a rewind needs it).
			CREATE TABLE IF NOT EXISTS draft_parts (partition INTEGER NOT NULL, seq INTEGER NOT NULL, count INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (partition, seq)) WITHOUT ROWID;
			-- Spilled card rows, length-prefixed in byte-capped groups keyed by
			-- the index of their first row. Batched because DO row writes are
			-- the scarcest resource on the free plan (100k/day): one row per
			-- card row would spend 98% of the daily quota on a single import.
			-- stepBuild serves random lookups out of these without re-reading
			-- whole groups — see the substr() lookup there.
			CREATE TABLE IF NOT EXISTS spill_batches (base INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL);
			-- The same spilled rows, rewritten in BUILD order (see stepReorder).
			-- The build consumes rows sorted; finalize can only write them in add
			-- order, and serving an arbitrary add-index meant a random seek per
			-- row — 97,802 of them, which is what took the build past the
			-- Durable Object CPU ceiling. Rewriting once, sequentially, lets the
			-- build read straight through.
			-- Keyed by BUILD POSITION, not an insertion counter, for the same
			-- reason spill_batches is keyed by its own base: a retried slice then
			-- rewrites its own groups instead of appending a second copy of
			-- every row it already wrote.
			CREATE TABLE IF NOT EXISTS ordered_rows (base INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS tagdata_blobs (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
			-- The corpus-wide finalize tables ALONE (cubecobra scores, illustration counts, artist
			-- spellings), rewritten by every scores slice and read by every partition's seal. They
			-- rode inside tagdata_blobs until 2026-09-25, which made each scores slice restore and
			-- re-export every tag map it never reads (see stepScores).
			CREATE TABLE IF NOT EXISTS corpus_blobs (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS chunk_staging (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
			-- The routing filter's raw input, one row per scores SLICE (one per batch until
			-- 2026-09-25, see routingStagingRows): tab-separated partition/key lines emitted by
			-- scores_add_drafts (EMIT_ROUTING), the slice's batches in order. Staged rather than
			-- accumulated in wasm
			-- because 1.2M keys resident would be ~55MB against a 124MiB ceiling; the routing phase
			-- streams them straight into hashes. "pairs" is the SAME batches' oracle-index input
			-- (EMIT_ORACLE_PAIRS, 32 bytes a printing), in the same row so it costs no row written
			-- of its own; the oracle_index phase reads it and drops the table.
			CREATE TABLE IF NOT EXISTS routing_keys (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL, pairs BLOB);
			-- What the last import left in each published rulings bucket. CROSS-RUN state, unlike
			-- every table above it: it is what lets a night publish only the buckets whose bytes
			-- actually moved, so it is neither in the run-start purge nor covered by metaClear.
			CREATE TABLE IF NOT EXISTS rulings_buckets (
				bucket INTEGER PRIMARY KEY, hash TEXT NOT NULL, rulings INTEGER NOT NULL
			);
			-- What the last import left in each published reference value. Cross-run, like
			-- rulings_buckets and for the same reason: it is what lets a night write only what moved.
			CREATE TABLE IF NOT EXISTS reference_values (key TEXT PRIMARY KEY, hash TEXT NOT NULL);
			-- row_batches held finalize's per-row JSON (the D1 cards-table feed upstream has and this
			-- platform never did). It was WRITE-ONLY — inserted, reset, never read — and at all_cards
			-- scale it would have been ~1.1GB of dead staging against a 5GB pool. The DROP reclaims
			-- what a live instance still holds from before the table was removed.
			DROP TABLE IF EXISTS row_batches;`,
		);
		// A live instance's draft_batches predates the part_hashes column (CREATE IF
		// NOT EXISTS never alters). Additive and nullable, so old rows read NULL —
		// which takePendingDrafts treats as "staged by the pre-partition pipeline",
		// a state only a mid-run deploy can produce and one that fails the run.
		const draftCols = this.sqlAll<{ name: string }>(
			"SELECT name FROM pragma_table_info('draft_batches') WHERE name = 'part_hashes'",
		);
		if (draftCols.length === 0) {
			this.sqlRun("ALTER TABLE draft_batches ADD COLUMN part_hashes BLOB");
		}
		// Staged drafts are compressed (import-blob-codec.ts), so length(bytes) no longer measures
		// the corpus — and the partition count is sized from it. raw_len carries the uncompressed
		// size; NULL on rows staged before compression, which were raw, so length(bytes) IS theirs.
		const rawLenCols = this.sqlAll<{ name: string }>(
			"SELECT name FROM pragma_table_info('draft_batches') WHERE name = 'raw_len'",
		);
		if (rawLenCols.length === 0) {
			this.sqlRun("ALTER TABLE draft_batches ADD COLUMN raw_len INTEGER");
		}
		// A live instance's routing_keys predates the oracle index's `pairs` column. Additive and
		// nullable: a row staged without it reads NULL, which stepOracleIndex treats as "this run
		// began before the pairs existed" and skips the night's index publish rather than
		// publishing one that has lost those batches' printings.
		const pairsCols = this.sqlAll<{ name: string }>(
			"SELECT name FROM pragma_table_info('routing_keys') WHERE name = 'pairs'",
		);
		if (pairsCols.length === 0) {
			this.sqlRun("ALTER TABLE routing_keys ADD COLUMN pairs BLOB");
		}
		// On record once per instance: how the platform's SQLite frees pages. The
		// staging purges are sliced on the assumption that a commit's cost is the
		// pages it frees (see PURGE_SLICE_BYTES); this is the datum behind it.
		try {
			const mode = this.sqlAll<{ auto_vacuum: number }>("PRAGMA auto_vacuum")[0]?.auto_vacuum;
			if (mode !== undefined) console.log(`Import storage: auto_vacuum=${mode}`);
		} catch {
			// A platform that refuses the pragma says so by this line's absence.
		}
		this.schemaReady = true;
	}

	// ── HTTP surface ───────────────────────────────────────────────────────────
	//
	// Four routes, all internal (a Durable Object has no public URL): the triggers' `/start-import`,
	// and the watchdog's `/status`, `/kick` and `/release` (src/import-watchdog.ts). Progress itself
	// lives in the Worker logs, where an unattended nightly run belongs.

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/start-import": {
				const epoch = Number(url.searchParams.get("epoch") ?? 0);
				return this.startImport(url.searchParams.get("reason") ?? "unspecified", {
					name: url.searchParams.get("name") ?? LEGACY_COORDINATOR_NAME,
					epoch: Number.isFinite(epoch) && epoch > 0 ? epoch : 0,
				});
			}
			case "/status":
				return Response.json(await this.status());
			case "/kick": {
				const at = Number(url.searchParams.get("at") ?? Date.now());
				return Response.json(await this.kick(Number.isFinite(at) ? at : Date.now()));
			}
			case "/release": {
				const epoch = Number(url.searchParams.get("epoch") ?? 0);
				return Response.json(await this.release(Number.isFinite(epoch) ? epoch : 0));
			}
			default:
				return new Response("not found", { status: 404 });
		}
	}

	/**
	 * What the watchdog decides on. Everything here but the run record and the alarm is the
	 * in-memory SQLite, so a healthy object answers in milliseconds; a wedged one does not answer,
	 * which is the other half of what the watchdog needs to know.
	 */
	private async status(): Promise<CoordinatorStatus> {
		this.ensureSchema();
		const run = await this.getRun();
		const meters = parseMeters(this.metaGet("run_meters"));
		const started = run.startedAt ? Date.parse(run.startedAt) : 0;
		const kicked = Number(this.metaGet("watchdog_kick_ms") ?? Number.NaN);
		return {
			state: run.state,
			phase: this.metaGet("phase") ?? "idle",
			lastActivityMs: Math.max(meters?.banked_ms ?? 0, meters?.due_ms ?? 0, Number.isFinite(started) ? started : 0),
			kickedAtMs: Number.isFinite(kicked) ? kicked : null,
			alarmAtMs: await this.ctx.storage.getAlarm(),
			epoch: Number(this.metaGet("coordinator_epoch") ?? 0),
		};
	}

	/**
	 * Re-arm a stalled run's alarm, so the chain resumes from its persisted phase: the platform has
	 * lost an alarm outright before (2026-09-17, the last `purge`), and a lost alarm otherwise
	 * costs the run until the next nightly. Recorded, so the watchdog can tell a kick that did not
	 * help from one it has not tried yet.
	 */
	private async kick(at: number): Promise<{ kicked: boolean; state: RunRecord["state"] }> {
		this.ensureSchema();
		const run = await this.getRun();
		if (run.state !== "running" && run.state !== "starting") return { kicked: false, state: run.state };
		this.metaSet("watchdog_kick_ms", String(at));
		await this.armAlarm(Date.now());
		console.warn(`Import watchdog kick: re-armed the alarm in phase ${this.metaGet("phase") ?? "idle"}`);
		return { kicked: true, state: run.state };
	}

	/**
	 * The watchdog's cleanup of a coordinator it replaced: give back ALL of its storage, which only
	 * `deleteAll` does — a purge deletes the rows, but 09-24's three retired runs on the free account
	 * still held ~1 GB between them (1.11 GB for the namespace) after purging every staging row.
	 *
	 * `designated` is the epoch of the pointer the watchdog read; a coordinator at that epoch or
	 * newer is current and releases nothing. Nor does a run still in flight: it retires through its
	 * own alarm chain (the fence) and releases itself when the purge ends, so this only makes sure an
	 * alarm is armed. An object with nothing stored answers `released` without writing a byte — a
	 * name the watchdog asks about may never have been created at all.
	 */
	private async release(designated: number): Promise<{ released: boolean; detail: string }> {
		const hasTables =
			this.sqlAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").length > 0;
		const run = await this.getRun();
		if (!hasTables && run.state === "idle") return { released: true, detail: "nothing stored" };
		const mine = hasTables ? Number(this.metaGet("coordinator_epoch") ?? 0) : 0;
		if (!(designated > mine)) {
			return { released: false, detail: `current coordinator (epoch ${mine}, pointer epoch ${designated})` };
		}
		if (run.state === "running" || run.state === "starting") {
			// Never over a deferred retire (deferRetire): its alarm is set for when the budget allows.
			if ((await this.ctx.storage.getAlarm()) === null) await this.armAlarm(Date.now());
			const phase = hasTables ? (this.metaGet("phase") ?? "idle") : "idle";
			return { released: false, detail: `run in flight (phase ${phase}); it retires through its own alarms` };
		}
		const bytes = await this.releaseStorage(`superseded (epoch ${mine} < ${designated}), run ${run.state}`);
		return { released: true, detail: `deleted ${bytes} bytes (run ${run.state})` };
	}

	/** deleteAll, which also drops the alarm (compatibility date ≥ 2026-02-24). Returns the bytes it freed. */
	private async releaseStorage(why: string): Promise<number> {
		const bytes = this.ctx.storage.sql.databaseSize;
		await this.ctx.storage.deleteAll();
		this.schemaReady = false;
		console.log(
			`Import coordinator storage released (${why}): deleteAll freed the ${(bytes / 1048576).toFixed(1)}MB ` +
				"its database still held",
		);
		return bytes;
	}

	/**
	 * The coordinator the watchdog designated after this one, or null while this one is current.
	 *
	 * Compared by EPOCH, never by name: KV is eventually consistent, so a freshly designated
	 * coordinator's first reads may still see the pointer that named its predecessor — an older
	 * epoch, which must not make it retire itself. A pointer that cannot be read retires nothing
	 * either; the next alarm reads it again.
	 */
	private async supersededBy(): Promise<CoordinatorPointer | null> {
		try {
			const pointer = await readPointer(this.env.STORE_KV);
			const mine = Number(this.metaGet("coordinator_epoch") ?? 0);
			return pointer.epoch > mine ? pointer : null;
		} catch (err) {
			console.warn(`Import fence: could not read ${COORDINATOR_POINTER_KEY} (${err}); carrying on`);
			return null;
		}
	}

	private async getRun(): Promise<RunRecord> {
		return (await this.storeGet<RunRecord>("run")) ?? { state: "idle" };
	}

	private async startImport(reason: string, self: { name: string; epoch: number }): Promise<Response> {
		this.ensureSchema();
		const run = await this.getRun();
		// A second cron start after today's run finished is a duplicate delivery, not a new day:
		// 2026-09-24 on the free account, a start with no trace arrived ~4 minutes after the 11:17
		// run published, and began a whole second import that wedged and cost three failovers.
		if (reason === "cron" && run.state === "done" && run.startedAt) {
			const sinceStart = Date.now() - Date.parse(run.startedAt);
			if (Number.isFinite(sinceStart) && sinceStart < DUPLICATE_CRON_WINDOW_MS) {
				console.warn(
					`Import start ignored: a cron start ${Math.round(sinceStart / 60_000)}min after the run that began ` +
						`${run.startedAt} and is done — a duplicate cron delivery, not a new day`,
				);
				return Response.json({ ok: true, skipped: "duplicate-cron", run }, { status: 200 });
			}
		}
		console.log(`Import start requested: reason=${reason}, coordinator ${self.name} (epoch ${self.epoch})`);
		if (run.state === "starting" || run.state === "running") {
			const now = Date.now();
			const meters = parseMeters(this.metaGet("run_meters"));
			const started = run.startedAt ? Date.parse(run.startedAt) : 0;
			const lastActivity = Math.max(
				meters?.banked_ms ?? 0,
				meters?.due_ms ?? 0,
				Number.isFinite(started) ? started : 0,
			);
			const idleMs = now - lastActivity;
			const pending = await this.ctx.storage.getAlarm();
			// An alarm that is armed but OVERDUE by the whole idle window was never delivered (this
			// account has seen one arrive four hours late and one not at all); counting it as alive
			// would answer 202 to every nightly cron from then on and the import would never run
			// again. The restart below re-arms, which replaces the stuck alarm.
			const overdue = pending !== null && pending < now - STALE_IDLE_MS;
			if ((pending !== null && !overdue) || idleMs < STALE_IDLE_MS) {
				// Alive: an alarm is scheduled, or a slice banked within the window.
				// A restart (deploy, dev reload) can drop the pending alarm while the
				// run record says "running" — re-arm so the chain resumes from its
				// persisted phase instead of waiting out the idle window.
				if (pending === null) await this.armAlarm(now);
				return Response.json({ ok: true, alreadyRunning: true, run }, { status: 202 });
			}
			// Name where it died. A run that reaches here without a "failed" record
			// was not failed by its own bookkeeping — it stopped being scheduled,
			// which is the signature of a killed slice — and the phase is the one
			// fact the next reader needs.
			console.warn(
				`Import run dead: nothing banked or scheduled for ${Math.round(idleMs / 60_000)}min in phase ` +
					`${this.metaGet("phase") ?? "idle"} (started ${run.startedAt ?? "?"}, ` +
					`${run.detail ?? "no detail recorded"}); restarting (reason=${reason})`,
			);
		}

		// Always a fresh run. Resume-where-it-failed used to matter when a visitor
		// hitting a progress page could retrigger an import minutes later;
		// the nightly cron is now the only trigger, and it exists precisely to
		// pick up today's dumps, so inheriting yesterday's staged ones would
		// defeat the point.
		const record: RunRecord = { state: "running", reason, startedAt: new Date().toISOString() };
		this.ctx.storage.transactionSync(() => {
			// The staging a previous run left behind is retired by the first alarms
			// in bounded slices (purge_staging, scope "reset") — never here, in one
			// transaction: after a run that died mid-transform that is ~1.5GB, and
			// one commit that size is what wedged the object for days. The two
			// tables of a handful of tiny rows go inline.
			this.sqlRun("DELETE FROM stage_files");
			this.sqlRun("DELETE FROM recode_checkpoint");
			this.metaClear();
			// Who this run is, for the fence (supersededBy): the pointer's epoch when it was started.
			this.metaSet("coordinator_name", self.name);
			this.metaSet("coordinator_epoch", String(self.epoch));
			this.beginPurge("reset");
		});
		await this.storePut("run", record);
		await this.storePut("phase_attempts", 0);
		await this.armAlarm(Date.now());
		return Response.json({ ok: true, run: record }, { status: 202 });
	}

	// ── alarm chain ────────────────────────────────────────────────────────────

	override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		try {
			await this.runAlarm(alarmInfo);
		} catch (err) {
			// The alarm's own bookkeeping failed — reading the run record, the
			// budget counters, the schema. The overwhelmingly likely cause is the
			// storage API refusing everything because the daily row allowance is
			// gone, which is precisely when retrying is worst: each attempt spends
			// more of a meter that is already empty. Log it and stop; the next
			// scheduled import starts fresh on a new day's allowance.
			console.error("Import alarm could not manage its own state (storage unavailable?):", err);
		}
	}

	private async runAlarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		this.ensureSchema();
		// The phase is read FIRST and synchronously — sql.exec answers from the
		// in-memory database, which is the one storage op that cannot stall — so
		// the watchdog can name the phase it fired in even when nothing else in
		// this alarm ever resolved.
		const phase = (this.metaGet("phase") ?? "idle") as Phase;
		if (phase === "idle") return; // stale alarm from a finished run
		const started = Date.now();
		this.alarmStartedAt = started;
		this.alarmCounted = false;
		this.churnThisAlarm = 0;
		this.nextDueMs = 0;
		this.lateThisAlarm = false;
		const limit = ALARM_WATCHDOG_MS_BY_PHASE[phase] ?? ALARM_WATCHDOG_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const watchdog = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const reason = `import watchdog: phase ${phase} has run ${Date.now() - started}ms, over the ${limit}ms limit`;
				console.error(`${reason} — resetting the object (ctx.abort) so the pending alarm re-fires on a fresh instance`);
				try {
					this.ctx.abort(reason);
				} catch (err) {
					// Outside the platform (the harness) abort throws instead of
					// resetting; either way this alarm ends here.
					reject(err);
					return;
				}
				reject(new Error(reason));
			}, limit);
		});
		try {
			await Promise.race([this.runAlarmBody(phase, limit, alarmInfo), watchdog]);
		} finally {
			// Cleared on every exit: a live timer is pending I/O, and pending I/O is
			// exactly what keeps an object active and billed.
			clearTimeout(timer);
		}
		// After the body and its meter flush, never inside them: both write to tables deleteAll drops.
		if (this.releaseAfterAlarm) {
			this.releaseAfterAlarm = false;
			await this.releaseStorage(`retired, superseded by ${this.metaGet("superseded_by") ?? "a newer coordinator"}`);
		}
	}

	private async runAlarmBody(phaseAtStart: Phase, watchdogMs: number, alarmInfo?: AlarmInvocationInfo): Promise<void> {
		let phase = phaseAtStart;
		const run = await this.getRun();
		if (run.state !== "running") return; // stale alarm from a finished run
		// The fence (src/import-watchdog.ts), before anything this alarm would write. A coordinator
		// the watchdog replaced while it was wedged can wake hours later in any phase — 2026-09-21's
		// resumed after 4.5 hours — and must publish nothing: two runs writing one KV is how the
		// site went dark before. It retires instead, its staging purged in bounded slices like a
		// reset, and ends `superseded`.
		if (!(phase === "purge_staging" && this.metaGet("purge_scope") === "retire")) {
			const successor = await this.supersededBy();
			if (successor) {
				console.warn(
					`Import run superseded in phase ${phase}: the watchdog designated ${successor.name} ` +
						`(epoch ${successor.epoch}) after this coordinator ` +
						`(${this.metaGet("coordinator_name") ?? LEGACY_COORDINATOR_NAME}, epoch ` +
						`${this.metaGet("coordinator_epoch") ?? 0}); retiring its staging and publishing nothing`,
				);
				this.ctx.storage.transactionSync(() => {
					this.metaSet("superseded_by", successor.name);
					this.beginPurge("retire");
				});
				phase = "purge_staging";
			}
		}
		// A RETIRING run never fails (backlog x6, 2026-09-25). Its purge is bounded cleanup of its
		// own staging, and every stop below used to route through failRun — which would end the run
		// `failed` with its staging stranded, and release a publishing marker that by then belonged
		// to its successor. (09-24's three retired runs did finish their purges.) So
		// the per-run budgets do not stop it, and the day budget, the attempt limit and a spent
		// retry count only defer it.
		const retiring = phase === "purge_staging" && this.metaGet("purge_scope") === "retire";
		// A retry is the ONLY trace a killed slice leaves: the handler never saw
		// it end, so nothing else could have logged it. Say so, with the phase.
		if (alarmInfo?.isRetry) {
			console.warn(
				`Import alarm for phase ${phase} is platform retry ${alarmInfo.retryCount}: ` +
					"the previous attempt threw before rescheduling or was killed by the runtime (CPU or memory)",
			);
		}

		// Count the attempt BEFORE running it, durably.
		//
		// MAX_RETRIES below only bounds failures this handler survives to catch.
		// A slice killed by the runtime — CPU allowance exhausted mid-phase, the
		// isolate reset under it — never reaches the catch, so nothing increments
		// and nothing is written: the alarm is retried against exactly the same
		// state and dies at exactly the same point, forever, with the retry
		// counter reading zero the whole time. Each pass costs what the phase
		// costs (a build attempt alone re-reads ~98k staged rows), so an
		// invisible loop like that is also the single most expensive thing this
		// Durable Object can do to the daily row budget.
		//
		// An awaited put is durable when it resolves, which is the point: it
		// survives a kill that a metaSet in the same handler would not.
		// Spend check, before anything expensive. The counters are cumulative for
		// the run and survive eviction (flushed below), so this bounds the whole
		// import rather than one instance's share of it.
		const day = ImportCoordinator.dayKey();
		const meters = parseMeters(this.metaGet("run_meters")) ?? EMPTY_RUN_METERS;
		// How late did this alarm arrive? A late alarm means storage fell behind
		// the churn the chain was pacing to; the pace halves (adjustPace).
		const lagMs = meters.due_ms > 0 ? Math.max(0, this.alarmStartedAt - meters.due_ms) : 0;
		this.lateThisAlarm = lagMs > LATE_ALARM_MS;
		this.paceBps = meters.pace_bps || PACE_START_BPS;
		if (this.lateThisAlarm) {
			const halved = adjustPace(this.paceBps, lagMs, 0);
			console.warn(
				`Import alarm for phase ${phase} arrived ${Math.round(lagMs / 1000)}s late — storage fell behind; ` +
					`pace ${(this.paceBps / 1048576).toFixed(2)} → ${(halved / 1048576).toFixed(2)} MB/s`,
			);
			this.paceBps = halved;
		}
		const spentRead = meters.rows_read;
		const spentWritten = meters.rows_written;
		const [dayRead, dayWritten] = this.dayMeters(day);
		const overRun = !retiring && (spentRead > MAX_RUN_ROWS_READ || spentWritten > MAX_RUN_ROWS_WRITTEN);
		const overDay = dayRead > MAX_DAY_ROWS_READ || dayWritten > MAX_DAY_ROWS_WRITTEN;
		if (retiring && overDay) {
			await this.deferRetire(
				`today's storage budget is spent (${dayRead.toLocaleString()} rows read, ${dayWritten.toLocaleString()} written)`,
				ImportCoordinator.nextUtcDayMs(),
			);
			return;
		}
		if (overRun || overDay) {
			const scope = overDay ? "today's" : "this run's";
			const read = overDay ? dayRead : spentRead;
			const written = overDay ? dayWritten : spentWritten;
			console.error(
				`Import stopped on ${scope} storage budget in phase ${phase}: ` +
					`${read.toLocaleString()} rows read, ${written.toLocaleString()} written. ` +
					"A single import costs a fraction of this, so exceeding it means work is being repeated.",
			);
			await this.failRun(
				run,
				`${phase}: ${scope} storage budget exhausted (${read.toLocaleString()} rows read, ` +
					`${written.toLocaleString()} written) — stopped before spending the daily allowance`,
			);
			return;
		}
		// The other meter: wall time. A Durable Object is billed for every second
		// it is active, and the free plan's day is 13,000 GB-s — which one wedged
		// coordinator spent by itself on 2026-09-15. A run this long has been
		// stalling, not working (see MAX_RUN_ACTIVE_MS).
		if (!retiring && meters.active_ms > MAX_RUN_ACTIVE_MS) {
			const activeS = Math.round(meters.active_ms / 1000);
			const gbS = Math.round(projectedGbSeconds(meters.active_ms));
			console.error(
				`Import stopped on this run's active-time budget in phase ${phase}: ${meters.alarms} alarms, ` +
					`${activeS}s active (≈${gbS} GB-s of the free plan's ${DO_FREE_GB_SECONDS_PER_DAY}/day). ` +
					"A healthy import is under an hour, so the object has been stalling, not working.",
			);
			await this.failRun(
				run,
				`${phase}: active-time budget exhausted (${activeS}s ≈ ${gbS} GB-s over ${meters.alarms} alarms) — ` +
					"the object was live far longer than a healthy import",
			);
			return;
		}

		const attempts = ((await this.storeGet<number>("phase_attempts")) ?? 0) + 1;
		await this.storePut("phase_attempts", attempts);
		// The dead-man alarm, on retried attempts only (see MAX_PHASE_ATTEMPTS):
		// armed BEFORE the slice runs, past the watchdog so it cannot fire under
		// a live handler, and replaced by the ordinary next-alarm put on every
		// exit this handler survives. A killed slice leaves it standing, and it
		// fires with a fresh platform retry budget. Healthy alarms pay nothing.
		if (alarmInfo?.isRetry) {
			await this.armAlarm(Date.now() + deadManDelayMs(watchdogMs));
		}
		if (attempts > MAX_PHASE_ATTEMPTS && retiring) {
			await this.deferRetire(`${attempts} attempts without completing a purge slice`, Date.now() + RETIRE_DEFER_MS);
			return;
		}
		if (attempts > MAX_PHASE_ATTEMPTS) {
			console.error(
				`Import phase ${phase} attempted ${attempts} times without completing a slice — ` +
					"stopping. This is the signature of a slice the runtime keeps killing " +
					"(CPU or memory), not of an error being retried.",
			);
			await this.failRun(run, `${phase}: ${attempts} attempts with no progress — slice is being killed, not failing`);
			return;
		}

		try {
			await this.step(phase);
			// A slice that succeeded clears the retry state, so a recovered
			// transient failure stops being reported as an ongoing problem —
			// written only when a retry was recorded: the unconditional reset
			// wrote a row on every healthy alarm (FIXED_ROWS_WRITTEN_PER_ALARM).
			if ((this.metaGet("retries") ?? "0") !== "0") this.metaSet("retries", "0");
			// Only when something was actually being retried: attempts is always
			// >= 1 here, so an unconditional reset would write a row on every
			// healthy slice to clear a counter nothing had raised.
			if (attempts > 1) await this.storePut("phase_attempts", 0);
			const next = (this.metaGet("phase") ?? "idle") as Phase;
			// Every phase is now work with nothing to wait for, so the chain runs
			// itself as fast as the runtime allows. `purge` used to be a DEADLINE
			// instead of a slice, carrying a timestamp it could not run before,
			// because it had to outlast readers noticing the publish on their own.
			// `notify` tells them instead, so there is nothing left to wait out.
			//
			// Except the storage itself (PACE_START_BPS): an alarm that churned
			// tens of MB schedules the next one no sooner than the pace allows,
			// so bursts never pile up faster than storage confirms them.
			if (next !== "idle") {
				if (!this.lateThisAlarm) this.paceBps = adjustPace(this.paceBps, 0, this.churnThisAlarm);
				const now = Date.now();
				const delay = paceDelayMs(this.churnThisAlarm, now - this.alarmStartedAt, this.paceBps);
				this.nextDueMs = now + delay;
				if (delay >= 5_000) {
					console.log(
						`Import pacing: ${phase} churned ${(this.churnThisAlarm / 1048576).toFixed(1)}MB; ` +
							`next alarm in ${Math.round(delay / 1000)}s at ${(this.paceBps / 1048576).toFixed(2)} MB/s`,
					);
				}
				await this.armAlarm(this.nextDueMs);
			}
		} catch (err) {
			if (retiring && (err instanceof FatalImportError || isQuotaError(err))) {
				await this.deferRetire(
					`purge slice failed: ${err}`,
					isQuotaError(err) ? ImportCoordinator.nextUtcDayMs() : Date.now() + RETIRE_DEFER_MS,
				);
				return;
			}
			if (err instanceof FatalImportError) {
				console.error(`Import stopped in phase ${phase}: ${err.message}`);
				await this.failRun(run, `${phase}: ${err.message}`);
				return;
			}
			if (isQuotaError(err)) {
				// A daily quota resets at 00:00 UTC — minutes of backoff cannot
				// clear it, so retrying is pure churn. Fail the run with the real
				// reason; the next scheduled import restarts on fresh quota.
				console.error(`Import stopped by a platform daily limit in phase ${phase}:`, err);
				await this.failRun(
					run,
					`${phase}: daily write limit reached — the next scheduled import retries on fresh quota`,
				);
				return;
			}
			const retries = Number(this.metaGet("retries") ?? 0) + 1;
			if (retries <= MAX_RETRIES) {
				const backoffMs = Math.min(60_000, 1000 * 2 ** retries);
				console.warn(`Import phase ${phase} failed (retry ${retries}/${MAX_RETRIES} in ${backoffMs}ms): ${err}`);
				this.metaSet("retries", String(retries));
				// A failed slice in a wasm-state-coupled phase leaves the wasm heap
				// ahead of the (rolled-back) SQLite progress — e.g. rows staged in
				// the interners that the retry would stage again. Marking the wasm
				// group dirty makes ensureWasmContinuity rebuild it from SQLite
				// before the retry, exactly like an eviction.
				if (phase === "agg" || phase === "finalize" || phase === "reorder" || phase === "build") {
					this.metaSet("tags_nonce", "dirty");
				}
				this.nextDueMs = Date.now() + backoffMs;
				await this.armAlarm(this.nextDueMs);
				return;
			}
			if (retiring) {
				await this.deferRetire(`purge slice failed ${MAX_RETRIES} times: ${err}`, Date.now() + RETIRE_DEFER_MS);
				return;
			}
			console.error(`Import failed in phase ${phase}:`, err);
			await this.failRun(run, `${phase}: ${err}`);
		} finally {
			// On EVERY exit from this alarm, including the early returns above and
			// a thrown slice: what was spent has to be banked before the instance
			// goes away, or the budget only ever measures the last alarm.
			try {
				this.flushMeters();
			} catch (err) {
				// The one way this throws in practice is the instance already being
				// torn down under us — "Durable Object reset because its code was
				// updated", i.e. a deploy landed mid-slice. The catch above has
				// already scheduled the retry; all that is lost is this slice's
				// meter delta. Letting it escape turned every deploy-reset into a
				// second, misleading "could not manage its own state (storage
				// unavailable?)" error with no phase on it — forty of those in the
				// week of the 2026-09-15 outage, one per reset.
				console.warn(`Import phase ${phase}: slice interrupted before its meters were banked: ${err}`);
			}
		}
	}

	/**
	 * Terminal failure: record it, park the phase, drop the alarm, and release
	 * the in-flight marker so retention can reclaim the chunks this run leaves
	 * behind. Best-effort on the KV side — a failed run's marker also expires on
	 * its own (PUBLISHING_TTL_SECONDS), so a KV hiccup here costs a week of one
	 * generation's storage, not the run record.
	 */
	private async failRun(run: RunRecord, detail: string): Promise<void> {
		run.state = "failed";
		run.finishedAt = new Date().toISOString();
		run.detail = detail;
		this.metaSet("phase", "idle");
		await this.storePut("run", run);
		await this.disarmAlarm();
		await this.releasePublishing();
		this.logRunSummary("failed");
	}

	/**
	 * Tell every retention sweep that this run's family is in flight (see
	 * PUBLISHING_KEY). First called in stepRouting, before the family's FIRST
	 * key lands in KV (the routing filter is grouped with the family by
	 * built_at and was once retired unprotected), then at each partition's
	 * first chunk: idempotent, and each call refreshes the TTL so a run that
	 * crawls across deploys for days keeps its protection for as long as it
	 * keeps making progress.
	 */
	private async markPublishing(): Promise<void> {
		const builtAt = this.metaGet("built_at") ?? "";
		if (!builtAt) throw new Error("publish: no built_at to mark as in flight");
		await this.env.STORE_KV.put(PUBLISHING_KEY, builtAt, { expirationTtl: PUBLISHING_TTL_SECONDS });
	}

	/**
	 * The family is either published (a manifest names it) or abandoned; either way age decides now.
	 *
	 * ONLY THIS RUN'S MARKER. The key is shared by every run the account ever starts, and one
	 * that ends after another has begun — a coordinator the watchdog replaced, waking late — would
	 * otherwise delete the marker protecting the run that replaced it (backlog x6, 2026-09-25). So
	 * it is deleted only while it still names this run's built_at. KV reads can be stale; a stale
	 * read that skips the delete costs nothing, since the marker expires on its own
	 * (PUBLISHING_TTL_SECONDS).
	 */
	private async releasePublishing(): Promise<void> {
		const builtAt = this.metaGet("built_at") ?? "";
		try {
			const held = await this.env.STORE_KV.get(PUBLISHING_KEY);
			if (held === null) return;
			if (!builtAt || held !== builtAt) {
				console.log(`Leaving ${PUBLISHING_KEY} alone: it names build ${held}, not this run's ${builtAt || "(none)"}`);
				return;
			}
			await this.env.STORE_KV.delete(PUBLISHING_KEY);
		} catch (err) {
			console.warn(`Could not clear ${PUBLISHING_KEY}; it expires on its own: ${err}`);
		}
	}

	/**
	 * Park a retiring run's purge until `untilMs` instead of failing it (see `retiring` in
	 * runAlarmBody). The run stays `running` in phase purge_staging, so the next alarm resumes the
	 * purge exactly where it stopped; the attempt and retry counters start over.
	 */
	private async deferRetire(reason: string, untilMs: number): Promise<void> {
		console.warn(
			`Retiring run deferred (${reason}); its staging purge resumes at ${new Date(untilMs).toISOString()}. ` +
				"A replaced run never fails: failing it would strand its staging.",
		);
		this.metaSet("retries", "0");
		await this.storePut("phase_attempts", 0);
		this.nextDueMs = untilMs;
		await this.armAlarm(untilMs);
	}

	/** A few minutes past the next UTC midnight, when the platform's daily meters (and ours) reset. */
	private static nextUtcDayMs(now = new Date()): number {
		return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5);
	}

	/** Every key KV currently holds under this run's partition family — the truth the manifest is checked against. */
	private async listFamilyKeys(formatVersion: number, builtAt: string): Promise<Set<string>> {
		return this.listAllKeys(partitionFamilyPrefix(formatVersion, builtAt));
	}

	/**
	 * Every key under `prefix`, ALL pages. A KV list is paged at 1,000 keys, and a caller that reads
	 * `.keys` off the first page silently drops the rest — the live-engine set once did, and at
	 * 9 regions x 32 partitions x replicas the objects past the first page would simply not have
	 * been told about a publish.
	 */
	private async listAllKeys(prefix: string): Promise<Set<string>> {
		const names = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await this.env.STORE_KV.list({ prefix, cursor });
			for (const k of page.keys) names.add(k.name);
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor);
		return names;
	}

	/** Today's UTC date, the scope the platform's own meters reset on. */
	private static dayKey(): string {
		return `${DAY_PREFIX}${new Date().toISOString().slice(0, 10)}`;
	}

	/** Bank this instance's metered rows into the run's and the day's totals. */
	private flushMeters(): void {
		// The ledger banks even when no rows moved: an alarm that only waited is
		// exactly the one whose time has to be on record. Outside an alarm
		// (startImport's own flush) there is no alarm to bank.
		const now = Date.now();
		const elapsed = this.alarmStartedAt > 0 ? now - this.alarmStartedAt : 0;
		if (this.rowsRead === 0 && this.rowsWritten === 0 && this.alarmStartedAt === 0) return;
		const day = ImportCoordinator.dayKey();
		const [dayReadBefore, dayWrittenBefore] = this.dayMeters(day);
		const dayRead = dayReadBefore + this.rowsRead;
		const dayWritten = dayWrittenBefore + this.rowsWritten;
		const meters = advanceMeters(parseMeters(this.metaGet("run_meters")), {
			rowsRead: this.rowsRead,
			rowsWritten: this.rowsWritten,
			elapsedMs: elapsed,
			newAlarm: !this.alarmCounted,
			churnBytes: this.churnUnbanked,
			// r3's pool gate reads this run's high-water mark at the manifest step. A getter over
			// the open database, not a read of any row.
			dbBytes: this.ctx.storage.sql.databaseSize,
		});
		// Pacing state rides the same row, so it costs no extra write. The due
		// time is only known once the next alarm is scheduled (the final flush).
		if (this.paceBps > 0) meters.pace_bps = this.paceBps;
		if (this.nextDueMs > 0) meters.due_ms = this.nextDueMs;
		meters.banked_ms = now;
		if (this.lateThisAlarm && !this.alarmCounted) meters.late_alarms += 1;
		this.rowsRead = 0;
		this.rowsWritten = 0;
		this.churnUnbanked = 0;
		// A second flush in the same alarm (prechargeReads) banks only what
		// elapsed since the first, and counts no second alarm.
		if (this.alarmStartedAt > 0) this.alarmStartedAt = now;
		this.alarmCounted = true;
		this.ctx.storage.transactionSync(() => {
			this.metaSet("run_meters", JSON.stringify(meters));
			this.metaSet(day, `${dayRead},${dayWritten}`);
		});
	}

	/**
	 * The day's [rows read, rows written]: ONE meta row, `day:<date>` = "read,written", since
	 * 2026-09-25 — the two rows it replaced (`day:<date>:read` and `:written`) cost a read each at
	 * the top of every alarm and a read and a write each in every flush. A day that began under the
	 * two-row code has only those, and they are summed in once; the first flush carries them into
	 * the merged row. Old days of either shape are swept by metaClear's date prefix.
	 */
	private dayMeters(day: string): [number, number] {
		const merged = this.metaGet(day);
		if (merged !== null) {
			const [read, written] = merged.split(",");
			return [Number(read) || 0, Number(written) || 0];
		}
		return [Number(this.metaGet(`${day}:read`) ?? 0), Number(this.metaGet(`${day}:written`) ?? 0)];
	}

	/**
	 * One line per run, at its end, with the numbers the free plan meters —
	 * alarms, active seconds as the GB-s they bill, rows read and written — so
	 * "is the importer within budget" is a log search, not a dashboard visit.
	 * Banks this alarm's time first so the summary includes it.
	 */
	private logRunSummary(state: "done" | "failed" | "superseded"): void {
		try {
			this.flushMeters();
			const m = parseMeters(this.metaGet("run_meters")) ?? EMPTY_RUN_METERS;
			const activeS = Math.round(m.active_ms / 1000);
			const gbS = Math.round(projectedGbSeconds(m.active_ms));
			console.log(
				`Import run ${state}: ${m.alarms} alarms, ${activeS}s active ` +
					`(≈${gbS} GB-s of the free plan's ${DO_FREE_GB_SECONDS_PER_DAY}/day), ` +
					`${m.rows_read.toLocaleString()} rows read, ${m.rows_written.toLocaleString()} written`,
			);
		} catch (err) {
			console.warn(`Import run ${state}: summary unavailable: ${err}`);
		}
	}

	/**
	 * Charge rows to the meters BEFORE spending them.
	 *
	 * flushMeters runs in the alarm's `finally`, which a slice killed outright
	 * by the runtime never reaches — so the most expensive thing this DO does
	 * was also the one thing that could spend without ever being recorded, and
	 * repeat. Pre-charging a phase's known cost makes the spend durable first
	 * and the work second, so a kill leaves evidence instead of a clean slate.
	 *
	 * Deliberately never refunded: over-counting costs a skipped import, while
	 * under-counting costs the day.
	 */
	private prechargeReads(rows: number): void {
		this.rowsRead += rows;
		this.flushMeters();
	}

	private async step(phase: Phase): Promise<void> {
		switch (phase) {
			case "listing":
				return this.stepListing();
			case "canonical":
				return this.stepCanonical();
			case "transform":
				return this.stepTransform();
			case "tags":
				return this.stepTags();
			case "scores":
				return this.stepScores();
			case "routing":
				return this.stepRouting();
			case "oracle_index":
				return this.stepOracleIndex();
			case "bucket":
				return this.stepBucket();
			case "agg":
				return this.stepAgg();
			case "finalize":
				return this.stepFinalize();
			case "reorder":
				return this.stepReorder();
			case "build":
				return this.stepBuild();
			case "publish":
				return this.stepPublish();
			case "purge_staging":
				return this.stepPurgeStaging();
			case "placement":
				return this.stepPlacement();
			case "manifest":
				return this.stepManifest();
			case "notify":
				return this.stepNotify();
			case "rulings":
				return this.stepRulings();
			case "reference":
				return this.stepReference();
			case "purge":
				return this.stepPurge();
			default: {
				if (phase.startsWith("fetch:")) {
					return this.stepFetch(phase.slice("fetch:".length) as DumpKind);
				}
				if (phase.startsWith("recode:")) {
					// Retired 2026-09-17: all_cards is streamed from Scryfall by the transform
					// (STREAMED_KINDS), never staged, so there is nothing to recode. Only a run
					// that was mid-recode when the deploy landed can be here.
					throw new FatalImportError(
						"the recode phase is retired (all_cards is streamed, not staged); the next scheduled import restarts cleanly",
					);
				}
				throw new Error(`unknown phase ${phase}`);
			}
		}
	}

	// ── phase: listing ─────────────────────────────────────────────────────────

	private bulkDataUrl(): string {
		return (this.env as { SCRYFALL_BULK_URL?: string }).SCRYFALL_BULK_URL ?? BULK_DATA_URL;
	}

	private async stepListing(): Promise<void> {
		const kinds = DUMP_KINDS;
		const res = await fetch(this.bulkDataUrl(), {
			headers: { "User-Agent": userAgent(), Accept: "application/json" },
		});
		if (!res.ok) throw new Error(`${this.bulkDataUrl()} answered ${res.status}`);
		const listing = (await res.json()) as {
			data?: { type?: string; jsonl_download_uri?: string; updated_at?: string }[];
		};
		const records = listing.data ?? [];
		// Newest dump timestamp across everything this import reads, recorded
		// into the manifest at publish time so a later deploy can ask "is the
		// live store already built from current upstream data?" without
		// downloading anything. Best-effort: a listing without updated_at just
		// leaves the field off, and the deploy falls back to its age backstop.
		const stamps = records
			.filter((r) => r.type && (kinds as readonly string[]).includes(r.type))
			.map((r) => Date.parse(r.updated_at ?? ""))
			.filter((n) => Number.isFinite(n));
		this.ctx.storage.transactionSync(() => {
			if (stamps.length > 0) {
				this.metaSet("source_updated_at", new Date(Math.max(...stamps)).toISOString());
			}
			for (const kind of kinds) {
				const record = records.find((r) => r.type === kind);
				// Mirrors bulk.rs download_uri_from_listing: a missing record or
				// missing jsonl_download_uri is a schema change — fail loudly.
				if (!record?.jsonl_download_uri) {
					throw new Error(`/bulk-data listing has no jsonl_download_uri for ${kind}`);
				}
				this.sqlRun(
					"INSERT OR REPLACE INTO stage_files (kind, uri, etag, total_bytes, fetched_bytes, done) VALUES (?, ?, NULL, NULL, 0, 0)",
					kind,
					record.jsonl_download_uri,
				);
			}
			this.metaSet("phase", firstFetchPhase());
		});
		console.log(`Import run listed ${kinds.length} dumps to fetch`);
	}

	// ── phase: fetch (ranged, resumable, compressed-at-rest) ───────────────────

	private async stepFetch(kind: DumpKind): Promise<void> {
		const file = this.sqlAll("SELECT uri, etag, fetched_bytes, done FROM stage_files WHERE kind = ?", kind)[0];
		if (!file) throw new Error(`stage_files row missing for ${kind}`);
		if (file.done) {
			this.advanceFetch(kind);
			return;
		}
		const fetched = Number(file.fetched_bytes);
		// Accept-Encoding identity: dumps are gzip *files*; ranges must address
		// the stored bytes, not a transfer encoding.
		const headers: Record<string, string> = {
			"User-Agent": userAgent(),
			"Accept-Encoding": "identity",
			Range: `bytes=${fetched}-${fetched + FETCH_SLICE_BYTES - 1}`,
		};
		if (file.etag) headers["If-Range"] = String(file.etag);
		const res = await fetch(String(file.uri), { headers });
		if (res.status === 200 && fetched > 0) {
			// Server replayed the whole file (dump rotated mid-download): restart.
			console.warn(`Dump ${kind} rotated mid-fetch; restarting its download`);
			this.ctx.storage.transactionSync(() => {
				this.sqlRun("DELETE FROM stage_blobs WHERE kind = ?", kind);
				this.sqlRun("UPDATE stage_files SET fetched_bytes = 0, etag = NULL WHERE kind = ?", kind);
			});
			await res.body?.cancel();
			return;
		}
		if (res.status !== 206 && res.status !== 200) {
			throw new Error(`GET ${kind} answered ${res.status}`);
		}
		const contentRange = res.headers.get("content-range"); // "bytes a-b/total"
		const total = contentRange ? Number(contentRange.split("/")[1]) : Number(res.headers.get("content-length") ?? 0);
		const etag = res.headers.get("etag");

		// Stream this slice into 1.9MB blob rows.
		const blobs: ArrayBuffer[] = [];
		let carry: Uint8Array = new Uint8Array(0);
		const reader = res.body?.getReader();
		if (!reader) throw new Error(`GET ${kind}: no body`);
		let sliceBytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			sliceBytes += value.length;
			let merged: Uint8Array;
			if (carry.length) {
				merged = new Uint8Array(carry.length + value.length);
				merged.set(carry);
				merged.set(value, carry.length);
			} else {
				merged = value;
			}
			let offset = 0;
			while (merged.length - offset >= STAGE_BLOB_BYTES) {
				blobs.push(exactBuffer(merged.subarray(offset, offset + STAGE_BLOB_BYTES)));
				offset += STAGE_BLOB_BYTES;
			}
			carry = merged.subarray(offset);
		}
		const newFetched = fetched + sliceBytes;
		const fileDone = res.status === 200 || (total > 0 && newFetched >= total);
		if (fileDone && carry.length) {
			blobs.push(exactBuffer(carry));
			carry = new Uint8Array(0);
		}
		// A non-final slice must persist only whole blobs; the carry re-fetches
		// with the next Range (blob boundaries stay deterministic).
		const persistedBytes = fileDone ? newFetched : newFetched - carry.length;

		this.ctx.storage.transactionSync(() => {
			let seq = Number(
				this.sqlAll<{ m: number }>("SELECT COALESCE(MAX(seq), -1) AS m FROM stage_blobs WHERE kind = ?", kind)[0]?.m ??
					-1,
			);
			for (const blob of blobs) {
				this.sqlRun("INSERT INTO stage_blobs (kind, seq, bytes) VALUES (?, ?, ?)", kind, ++seq, blob);
			}
			this.sqlRun(
				"UPDATE stage_files SET fetched_bytes = ?, total_bytes = ?, etag = COALESCE(?, etag), done = ? WHERE kind = ?",
				persistedBytes,
				total || null,
				etag,
				fileDone ? 1 : 0,
				kind,
			);
		});
		console.log(`Fetched ${kind}: ${persistedBytes}${total ? `/${total}` : ""} bytes${fileDone ? " (done)" : ""}`);
		if (fileDone) this.advanceFetch(kind);
	}

	private advanceFetch(kind: DumpKind): void {
		// The chain lives in src/import-phases.ts: the small dumps are fetched in
		// order, and the last hands the chain to the canonical id pass, which must
		// complete before transform starts (every transformed row's is_canonical is
		// membership in the set it builds; see stepCanonical). all_cards and
		// default_cards are not in the chain at all — they are streamed.
		this.metaSet("phase", phaseAfterFetch(kind));
	}

	// ── streamed dumps (all_cards, default_cards: never staged) ────────────────

	/**
	 * Open a streamed dump (STREAMED_KINDS) at raw offset `rawOffset`, straight
	 * from Scryfall.
	 *
	 * The decoder is the wasm gzip inflater with its serialized state — the one
	 * the recode phase checkpointed — restored from the dump's row in
	 * recode_checkpoint (version STREAM_CHECKPOINT_VERSION) and positioned at the
	 * EXACT compressed offset it had consumed, so one ranged request picks the
	 * gzip stream up there. A checkpoint is a position in the ORIGINAL file, which
	 * is what it always was: the staged blobs it used to be read from were that
	 * file's bytes, cut into rows.
	 *
	 * Checkpoints sit on a STREAM_CHECKPOINT_GRID_RAW grid: the decoder reports
	 * each grid line it reaches (InflateRecodeSource's onGrid, the one moment its
	 * state describes exactly that offset), the stream keeps those snapshots in
	 * memory, and the consumer persists the newest one at or before its line
	 * cursor in the same transaction as the cursor (persistStreamCheckpoint). A
	 * resume therefore re-inflates at most one grid step before its first line.
	 *
	 * Upstream integrity: the download URI names one immutable file, and the
	 * ETag seen on its first read is sent as If-Range on every later one. A 200
	 * where a range was asked for, a 404 or a 410 mean the file this run started
	 * on is gone — no staged copy exists to fall back on, so the run fails and
	 * the next scheduled import starts over on the current file.
	 */
	private async openDumpStream(kind: DumpKind, rawOffset: number): Promise<DumpStream> {
		const file = this.sqlAll<{ uri: string; etag: string | null }>(
			"SELECT uri, etag FROM stage_files WHERE kind = ?",
			kind,
		)[0];
		if (!file) throw new FatalImportError(`stage_files row missing for streamed dump ${kind}`);
		const wasm = transientWasm();
		let startRaw = 0;
		let compOffset = 0;
		const row =
			rawOffset > 0
				? this.sqlAll<{ version: number; raw_done: number; state: ArrayBuffer }>(
						"SELECT version, raw_done, state FROM recode_checkpoint WHERE kind = ?",
						kind,
					)[0]
				: undefined;
		if (row && Number(row.version) === STREAM_CHECKPOINT_VERSION && Number(row.raw_done) <= rawOffset) {
			const restored = wasm.inflateRestore(new Uint8Array(row.state));
			if (restored === null || wasm.inflateTotalOut() !== Number(row.raw_done)) {
				throw new FatalImportError(
					`${kind}: the stream checkpoint at raw ${row.raw_done} did not restore; the next scheduled import restarts cleanly`,
				);
			}
			startRaw = Number(row.raw_done);
			compOffset = restored;
		} else {
			// No checkpoint yet: only legitimate before the stream's first grid line.
			if (rawOffset >= STREAM_CHECKPOINT_GRID_RAW) {
				throw new FatalImportError(
					`${kind}: no stream checkpoint at or before raw offset ${rawOffset}; the next scheduled import restarts cleanly`,
				);
			}
			wasm.inflateBegin();
		}

		const headers: Record<string, string> = {
			"User-Agent": userAgent(),
			// Ranges must address the file's own gzip bytes, not a transfer encoding.
			"Accept-Encoding": "identity",
			Range: `bytes=${compOffset}-`,
		};
		if (compOffset > 0 && file.etag) headers["If-Range"] = file.etag;
		const res = await fetch(file.uri, { headers });
		if (res.status === 404 || res.status === 410 || (compOffset > 0 && res.status === 200)) {
			await res.body?.cancel();
			throw new FatalImportError(
				`${kind} changed or vanished upstream mid-phase (HTTP ${res.status} at compressed offset ${compOffset}); ` +
					"the next scheduled import restarts on the current file",
			);
		}
		if (res.status !== 206 && res.status !== 200) {
			await res.body?.cancel();
			throw new Error(`GET ${kind} at compressed offset ${compOffset} answered ${res.status}`);
		}
		const reader = res.body?.getReader();
		if (!reader) throw new Error(`GET ${kind}: no body`);
		if (compOffset === 0) {
			const etag = res.headers.get("etag");
			if (etag) this.sqlRun("UPDATE stage_files SET etag = ? WHERE kind = ?", etag, kind);
		}

		let checkedMagic = compOffset > 0;
		const rows: AsyncIterator<Uint8Array> = {
			next: async () => {
				const { done, value } = await reader.read();
				if (done) return { done: true, value: undefined };
				if (!checkedMagic && value.length >= 2) {
					checkedMagic = true;
					if (value[0] !== 0x1f || value[1] !== 0x8b) {
						throw new FatalImportError(`${kind} is not a gzip file at ${file.uri}; the dump format changed`);
					}
				}
				return { done: false, value };
			},
		};
		const snapshots: StreamCheckpoint[] = [];
		const source = new InflateRecodeSource(
			ImportCoordinator.resumableInflate(wasm),
			rows,
			startRaw,
			STREAM_CHECKPOINT_GRID_RAW,
			(produced) => {
				if (wasm.inflateTotalOut() !== produced) return; // a lying checkpoint is worse than none
				snapshots.push({ raw: produced, state: wasm.inflateSave() });
				if (snapshots.length > 32) snapshots.shift();
			},
		);
		return {
			bytes: skipBytes(source.stream(), rawOffset - startRaw),
			checkpointAtOrBefore: (raw) => {
				for (let i = snapshots.length - 1; i >= 0; i--) {
					const snap = snapshots[i] as StreamCheckpoint;
					if (snap.raw <= raw) return snap;
				}
				return null;
			},
			close: async () => {
				await reader.cancel().catch(() => {});
			},
		};
	}

	/**
	 * Persist the stream's position alongside the consumer's line cursor — call
	 * inside the SAME transaction that writes the cursor. The newest snapshot at
	 * or before the cursor replaces the row; none newer keeps the existing row,
	 * which is still at or before the (only ever advancing) cursor. A finished
	 * stream drops its row.
	 */
	private persistStreamCheckpoint(kind: DumpKind, stream: DumpStream, cursor: number, exhausted: boolean): void {
		if (exhausted) {
			this.sqlRun("DELETE FROM recode_checkpoint WHERE kind = ?", kind);
			return;
		}
		const snap = stream.checkpointAtOrBefore(cursor);
		if (!snap) return;
		this.sqlRun(
			"INSERT OR REPLACE INTO recode_checkpoint (kind, version, raw_done, state) VALUES (?, ?, ?, ?)",
			kind,
			STREAM_CHECKPOINT_VERSION,
			snap.raw,
			exactBuffer(snap.state),
		);
	}

	/** The wasm module's resumable-inflate surface, shaped for InflateRecodeSource. */
	private static resumableInflate(wasm: ImportWasm): ResumableInflate {
		return {
			feed: (bytes, maxOut) => {
				let output: Uint8Array | null = null;
				wasm.setHandlers({
					onInflate: (b) => {
						output = b;
					},
				});
				try {
					return { consumed: wasm.inflateFeed(bytes, maxOut), output };
				} finally {
					wasm.setHandlers({});
				}
			},
			atBoundary: () => wasm.inflateAtBoundary(),
			totalOut: () => wasm.inflateTotalOut(),
			save: () => wasm.inflateSave(),
		};
	}

	/** Stream a staged dump's RAW stage_blobs rows, decompressed. Detects gzip
	 * by magic. One long stream, decodable only from the top — fine for the
	 * small fetched dumps, which are all that is staged. */
	private async *stagedBlobBytes(kind: DumpKind): AsyncGenerator<Uint8Array> {
		let seq = 0;
		const raw = new ReadableStream<Uint8Array>({
			// Arrow, not a method: `this` inside an underlying-source method is
			// the source object, and these reads have to reach the coordinator's
			// row meter.
			pull: (controller) => {
				const row = this.sqlAll("SELECT bytes FROM stage_blobs WHERE kind = ? AND seq = ?", kind, seq)[0];
				if (!row) {
					controller.close();
					return;
				}
				seq += 1;
				controller.enqueue(new Uint8Array(row.bytes as ArrayBuffer));
			},
		});
		const first = this.sqlAll("SELECT bytes FROM stage_blobs WHERE kind = ? AND seq = 0", kind)[0];
		const head = first ? new Uint8Array(first.bytes as ArrayBuffer) : new Uint8Array(0);
		const gzipped = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
		const stream = gzipped ? raw.pipeThrough(new DecompressionStream("gzip")) : raw;
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				yield value;
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Stream a staged dump's decompressed bytes from `fromRawOffset` onward — the
	 * small fetched dumps (tags, labels, rulings), honouring the offset by linear
	 * discard, the cost profile they are small enough to tolerate. The large ones
	 * are never staged; see openDumpStream.
	 */
	private async *stagedBytes(kind: DumpKind, fromRawOffset = 0): AsyncGenerator<Uint8Array> {
		yield* skipBytes(this.stagedBlobBytes(kind), fromRawOffset);
	}

	/** Line-decoded view of a staged dump (tags dumps — small enough to decode). */
	private async *stagedLines(kind: DumpKind): AsyncGenerator<string> {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of this.stagedBytes(kind)) {
			pending += decoder.decode(chunk, { stream: true });
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) yield line;
		}
		pending += decoder.decode();
		if (pending.length > 0) yield pending;
	}

	// ── phase: canonical (default_cards → the canonical id set) ────────────────

	/**
	 * Fold one slice of default_cards' ids into the canonical set.
	 *
	 * The set answers, for every all_cards row the transform will see,
	 * "is this printing one of Scryfall's canonical (default_cards) printings?"
	 * — id-membership, never re-derived (plan reconciliation 5) — so it must be
	 * COMPLETE before the first transform slice runs; is_canonical is baked
	 * into each draft at transform time.
	 *
	 * Continuity is the labels mechanism, exactly: the set lives inside the
	 * wasm's TagData (canonical_add_lines), and the ONE snapshot path —
	 * tags_export streamed into tagdata_blobs, pulled back out row by row — is what carries
	 * it across slices, across DO evictions, and into every transient transform
	 * instance. Each slice here restores the snapshot, adds its lines, and
	 * re-exports in the same transaction as its cursor, so a retried slice
	 * restores exactly the set its cursor describes. (The tags phase later
	 * overwrites tagdata_blobs with the tag snapshot; by then the set has been
	 * consumed — transform is complete.)
	 *
	 * Resumes by raw byte offset, like transform, through openDumpStream's
	 * inflater checkpoint (see CANONICAL_SLICE_LINES for the cost math).
	 */
	private async stepCanonical(): Promise<void> {
		const wasm = transientWasm();
		wasm.reset();
		const rawDone = Number(this.metaGet("canonical_raw_done") ?? 0);
		if (rawDone > 0) {
			if (!this.hasSnapshot("tagdata_blobs")) throw new FatalImportError("canonical: id snapshot missing mid-phase");
			wasm.tagsRestorePull(this.snapshotRows("tagdata_blobs"));
		}

		let added = 0n;
		let fed = 0;
		let lineBufs: Uint8Array[] = [];
		let lineBytes = 0;
		const feed = () => {
			if (lineBufs.length === 0) return;
			added += wasm.canonicalAddLinesRaw(joinLines(lineBufs, lineBytes));
			lineBufs = [];
			lineBytes = 0;
		};
		const stream = await this.openDumpStream("default_cards", rawDone);
		const result = await scanJsonlSlice(stream.bytes, (line) => {
			if (line.length === 0 || isBlankLine(line)) return false;
			lineBufs.push(line.slice());
			lineBytes += line.length;
			fed += 1;
			if (lineBufs.length >= LINES_PER_CALL) feed();
			return fed >= CANONICAL_SLICE_LINES;
		}).finally(() => stream.close());
		feed();

		this.ctx.storage.transactionSync(() => {
			this.writeSnapshot("tagdata_blobs", wasm);
			this.metaSet("canonical_raw_done", String(rawDone + result.consumed));
			this.persistStreamCheckpoint("default_cards", stream, rawDone + result.consumed, result.exhausted);
			const lines = Number(this.metaGet("canonical_lines") ?? 0) + fed;
			const ids = Number(this.metaGet("canonical_ids") ?? 0) + Number(added);
			this.metaSet("canonical_lines", String(lines));
			this.metaSet("canonical_ids", String(ids));
			if (result.exhausted) {
				// Coverage check, the transform parse-coverage's sibling: default_cards
				// carries one unique id per line, so ids far below lines means the dump
				// format changed — and unlike the labels (optional by construction),
				// an empty canonical set builds a store with NO canonical printings.
				if (lines === 0 || ids < PARSE_COVERAGE_THRESHOLD * lines) {
					throw new Error(
						`canonical ids ${ids} from ${lines} default_cards lines, below ${PARSE_COVERAGE_THRESHOLD}; format changed?`,
					);
				}
				// default_cards was streamed, never staged: nothing to drop.
				this.metaSet("phase", "transform");
			}
		});
		console.log(`Canonical slice: ${fed} lines, ${added} new ids` + `${result.exhausted ? " (done)" : ""}`);
	}

	// ── phase: transform ───────────────────────────────────────────────────────

	private async stepTransform(): Promise<void> {
		// The corpus is all_cards — every printing in every language — streamed
		// straight from Scryfall from the checkpointed decoder (openDumpStream).
		const corpus = TRANSFORM_KIND;
		// Disposable instance per slice: transform keeps no cross-slice state of
		// its own, and reusing a heap across phases would carry its high-water
		// into the capped later group (linear memory never shrinks). The one
		// thing a slice DOES need resident — the canonical id set — is re-fed
		// below from the snapshot the canonical phase left, the same restore the
		// group phases use after an eviction (one persistence path, no drift).
		const wasm = transientWasm();
		wasm.reset();
		if (!this.hasSnapshot("tagdata_blobs")) {
			// Not retryable: the snapshot is written by the canonical phase, which
			// the chain guarantees ran to completion before this one.
			throw new FatalImportError("transform: canonical id snapshot missing (canonical phase incomplete?)");
		}
		wasm.tagsRestorePull(this.snapshotRows("tagdata_blobs"));

		const linesDone = Number(this.metaGet("lines_done") ?? 0);
		// The raw-offset cursor pairs with lines_done: it names the byte at which
		// line `lines_done` starts; the stream resumes from the newest decoder
		// checkpoint at or before it, re-inflating at most one grid step.
		const rawOffset = Number(this.metaGet("transform_raw_offset") ?? 0);
		const draftBuf: Uint8Array[] = [];
		const hashBuf: bigint[] = [];
		const stats = { parsed: 0, skipped: 0, drafts: 0, canonical: 0, parsed_bytes: 0, total_bytes: 0 };
		wasm.setHandlers({
			onDraft: (b, partHash) => {
				draftBuf.push(b);
				hashBuf.push(partHash);
			},
			onStats: (s) => {
				stats.parsed += s.parsed ?? 0;
				stats.skipped += s.skipped ?? 0;
				stats.drafts += s.drafts ?? 0;
				stats.canonical += s.canonical ?? 0;
				stats.parsed_bytes += s.parsed_bytes ?? 0;
			},
		});

		let processed = 0;
		let lineBufs: Uint8Array[] = [];
		let lineBytes = 0;
		const feed = () => {
			if (lineBufs.length === 0) return;
			stats.total_bytes += lineBytes + lineBufs.length; // + one newline per line
			wasm.transformLinesRaw(joinLines(lineBufs, lineBytes));
			lineBufs = [];
			lineBytes = 0;
		};
		const stream = await this.openDumpStream(corpus, rawOffset);
		const result = await scanJsonlSlice(stream.bytes, (line) => {
			if (line.length === 0 || isBlankLine(line)) return false;
			lineBufs.push(line.slice());
			lineBytes += line.length;
			if (lineBufs.length >= LINES_PER_CALL) feed();
			processed += 1;
			return processed >= TRANSFORM_SLICE_LINES;
		}).finally(() => stream.close());
		feed();
		wasm.setHandlers({});
		const exhausted = result.exhausted;
		const seen = linesDone + result.lines;
		console.log(
			`Transform slice: ${processed} lines (through line ${seen}), ${stats.drafts} drafts ` +
				`(${stats.canonical} canonical)`,
		);

		// Persist this slice's drafts + progress atomically: an eviction between
		// the two would otherwise duplicate drafts on resume.
		this.ctx.storage.transactionSync(() => {
			let seq = Number(this.sqlAll<{ m: number }>("SELECT COALESCE(MAX(seq), -1) AS m FROM draft_batches")[0]?.m ?? -1);
			// Byte-capped rows of DRAFT_BATCH_BYTES raw, packed (packedDraftGroups re-cuts a group
			// that would not fit a row). The last group is partial unless this slice reached the end
			// of the dump, so it goes back into the pending row rather than being written
			// undersized once per slice. The hash vector is cut at the same boundaries, staying
			// parallel to its drafts.
			const pending = this.takePendingDrafts();
			const allDrafts = pending.drafts.concat(draftBuf);
			const allHashes = pending.hashes.concat(hashBuf);
			const groups = packedDraftGroups(allDrafts, packBlob);
			const tail = exhausted ? undefined : groups.pop();
			for (const group of groups) {
				this.sqlRun(
					"INSERT INTO draft_batches (seq, count, bytes, part_hashes, raw_len) VALUES (?, ?, ?, ?, ?)",
					++seq,
					group.end - group.start,
					exactBuffer(group.packed),
					exactBuffer(packPartHashes(allHashes.slice(group.start, group.end))),
					group.raw,
				);
			}
			this.storePendingDrafts(tail ? { ...tail, hashes: allHashes.slice(tail.start, tail.end) } : null);
			this.metaSet("lines_done", String(seen));
			this.metaSet("transform_raw_offset", String(rawOffset + result.consumed));
			this.persistStreamCheckpoint(corpus, stream, rawOffset + result.consumed, exhausted);
			// The running totals, ONE row (was one per counter, six writes a slice).
			const totals = this.transformTotals(linesDone);
			for (const [k, v] of Object.entries(stats)) totals[k] = (totals[k] ?? 0) + v;
			this.metaSet("tf_stats", JSON.stringify(totals));
			if (exhausted) {
				// Parse-coverage integrity check (bulk.rs JsonlStream parity): a
				// large dump that mostly failed to parse means the format changed.
				const totalBytes = totals.total_bytes ?? 0;
				const parsedBytes = totals.parsed_bytes ?? 0;
				if (totalBytes >= PARSE_COVERAGE_MIN_BYTES && parsedBytes < PARSE_COVERAGE_THRESHOLD * totalBytes) {
					throw new Error(
						`bulk parse coverage ${parsedBytes}/${totalBytes} bytes below ${PARSE_COVERAGE_THRESHOLD}; format changed?`,
					);
				}
				this.metaSet("drafts_total", String(totals.drafts ?? 0));
				// all_cards was streamed, never staged: nothing to drop.
				this.metaSet("phase", "tags");
			}
		});
	}

	/** Drafts that have not yet filled a whole batch, persisted between slices
	 * as the reserved seq -1 row (excluded from agg/finalize scans by `seq >= 0`
	 * ... which start from a non-negative cursor), each with its partition hash. */
	private takePendingDrafts(): { drafts: Uint8Array[]; hashes: bigint[] } {
		const stored = this.sqlAll<{ bytes: ArrayBuffer; part_hashes: ArrayBuffer | null }>(
			"SELECT bytes, part_hashes FROM draft_batches WHERE seq = -1",
		)[0];
		if (!stored) return { drafts: [], hashes: [] };
		this.sqlRun("DELETE FROM draft_batches WHERE seq = -1");
		const drafts = splitBatch(unpackBlob(new Uint8Array(stored.bytes as ArrayBuffer))).map((b) => b.slice());
		const hashes = stored.part_hashes ? unpackPartHashes(new Uint8Array(stored.part_hashes as ArrayBuffer)) : [];
		if (hashes.length !== drafts.length) {
			// Only a deploy that lands MID-RUN, across the partition-hash framing
			// change, can produce this — and that run's staged drafts are from the
			// old transform anyway (different input dump, no printed columns).
			// Restarting the run is strictly better than finishing it wrong.
			throw new FatalImportError(
				`pending draft row carries ${drafts.length} drafts but ${hashes.length} hashes — ` +
					"staged by a pre-partition build; the next scheduled import restarts cleanly",
			);
		}
		return { drafts, hashes };
	}

	/** Replace the pending row with this slice's partial last group (already packed), or clear it. */
	private storePendingDrafts(tail: (PackedDraftGroup & { hashes: bigint[] }) | null): void {
		this.sqlRun("DELETE FROM draft_batches WHERE seq = -1");
		if (tail && tail.end > tail.start) {
			this.sqlRun(
				"INSERT INTO draft_batches (seq, count, bytes, part_hashes, raw_len) VALUES (-1, ?, ?, ?, ?)",
				tail.end - tail.start,
				exactBuffer(tail.packed),
				exactBuffer(packPartHashes(tail.hashes)),
				tail.raw,
			);
		}
	}

	/**
	 * The transform's running totals (parsed, skipped, drafts, canonical, parsed_bytes, total_bytes),
	 * kept in ONE meta row, `tf_stats`, since 2026-09-25. A transform begun under the code that kept
	 * one `tf_<name>` row per counter has only those, and they are read once, on the first slice
	 * this code runs; the first slice of a run (linesDone 0) has nothing to carry.
	 */
	private transformTotals(linesDone: number): Record<string, number> {
		const merged = this.metaGet("tf_stats");
		if (merged !== null) return JSON.parse(merged) as Record<string, number>;
		const totals: Record<string, number> = {};
		if (linesDone === 0) return totals;
		for (const k of ["parsed", "skipped", "drafts", "canonical", "parsed_bytes", "total_bytes"]) {
			totals[k] = Number(this.metaGet(`tf_${k}`) ?? 0);
		}
		return totals;
	}

	// ── phase: tags ────────────────────────────────────────────────────────────

	private async stepTags(): Promise<void> {
		// Tag dumps are small next to default_cards; both fit one slice. The
		// TagData snapshot persists so later phases survive eviction.
		//
		// A DISPOSABLE instance, not the group's. It used to be newGroupWasm(), and so it outlived
		// this alarm: nothing between tags and the first partition's agg replaces the group
		// instance, so its heap sat beside the scores phase's own for every scores slice — the
		// second wasm heap that put scores at 151.8MB at 2x the corpus. Every phase after this one
		// restores what it needs from the snapshot written below, and each partition's agg builds
		// its own group instance. Dropping any group left in this isolate (a run that died
		// mid-loop) is the same move for the same reason.
		dropGroupWasm();
		const wasm = transientWasm();
		wasm.reset();
		for (const [kind, code] of [
			["oracle_tags", 1],
			["art_tags", 2],
		] as const) {
			wasm.tagsBegin();
			let batch: string[] = [];
			for await (const line of this.stagedLines(kind)) {
				if (line.trim().length === 0) continue;
				batch.push(line);
				if (batch.length >= LINES_PER_CALL) {
					wasm.tagsAddLines(batch.join("\n"));
					batch = [];
				}
			}
			if (batch.length > 0) wasm.tagsAddLines(batch.join("\n"));
			const mapped = wasm.tagsFinish(code);
			console.log(`Tags ${kind}: ${mapped} ids mapped`);
		}
		// Representative labels, into the SAME TagData the tag dumps just filled — so the export
		// below carries them across DO evictions with no second persistence path to drift.
		// Non-fatal by construction: a staged file that is missing or unreadable yields zero
		// labels, and zero labels means every row scores exactly as it did before the pin existed.
		let labelBatch: string[] = [];
		let labelCount = 0n;
		for await (const line of this.stagedLines("oracle_cards")) {
			if (line.trim().length === 0) continue;
			labelBatch.push(line);
			if (labelBatch.length >= LINES_PER_CALL) {
				labelCount += wasm.labelsAddLines(labelBatch.join("\n"));
				labelBatch = [];
			}
		}
		if (labelBatch.length > 0) labelCount += wasm.labelsAddLines(labelBatch.join("\n"));
		console.log(`Representative labels: ${labelCount}`);

		// The alias -> slug maps, cut from the same TagData: stashed in meta now (the key that names
		// them needs built_at, stamped below) and published beside the manifest by stepManifest.
		// See src/engine/tag-aliases.ts for why this ships with the store rather than the code.
		let tagAliasesJson = "";
		wasm.setHandlers({
			onTagAliases: (b) => {
				tagAliasesJson = new TextDecoder().decode(b);
			},
		});
		wasm.tagAliasesExport();
		wasm.setHandlers({});
		if (!tagAliasesJson) throw new Error("tags: the wasm import emitted no alias map");

		// Size the partition loop HERE, while everything it needs is already
		// durable: the drafts are fully staged (transform completed before this
		// phase), so the sum of their RAW sizes (raw_len; the rows themselves are
		// compressed) is the whole corpus, and the projection
		// (bytes × DRAFT_TO_STORE_RATIO / TARGET_PARTITION_BYTES, clamped) is a
		// pure function of it. N and built_at are persisted in the SAME
		// transaction that opens the loop, so a mid-loop restart can fork
		// neither: the store keys, the chunk keys, and every draft's partition
		// assignment all derive from these two values (plan B3 / Decision 3b).
		const stagedDraftBytes = Number(
			this.sqlAll<{ n: number }>(
				"SELECT COALESCE(SUM(COALESCE(raw_len, length(bytes))), 0) AS n FROM draft_batches WHERE seq >= 0",
			)[0]?.n ?? 0,
		);
		// The target is overridable for ONE caller — the local end-to-end
		// harness (scripts/import-harness), whose corpus is small enough that
		// the real target would always yield MIN_PARTITION_COUNT. Same posture
		// as SCRYFALL_BULK_URL above: never set in wrangler.jsonc, so
		// production reads the constant.
		const targetBytes =
			Number((this.env as { IMPORT_TARGET_PARTITION_BYTES?: string }).IMPORT_TARGET_PARTITION_BYTES) ||
			TARGET_PARTITION_BYTES;
		const partitionCount = partitionCountFor(stagedDraftBytes, targetBytes);
		console.log(
			`Partition loop: ${stagedDraftBytes} staged draft bytes project to ${partitionCount} partition(s) ` +
				`of ~${(targetBytes / 1048576).toFixed(0)}MB`,
		);

		this.ctx.storage.transactionSync(() => {
			// Overwrites the canonical phase's snapshot, deliberately: the canonical
			// set was consumed when transform completed, and from here every restart
			// path restores THIS TagData (tags + labels). Streamed straight into its rows.
			this.writeSnapshot("tagdata_blobs", wasm);
			this.metaSet("tag_aliases", tagAliasesJson);
			this.metaSet("scores_batch_done", "0");
			// The routing filter's line count, summed as the scores slices stage them — see stepRouting.
			this.metaSet("routing_lines", "0");
			// built_at is fixed ONCE, here at the end of tags, never in stepBuild
			// (plan B3): with N builds in one run, a built_at stamped per build
			// would fork the store key family on any mid-loop restart, stranding
			// the chunks already published under the earlier timestamp.
			this.metaSet("built_at", String(Math.floor(Date.now() / 1000)));
			// The format version likewise binds the whole FAMILY of keys, so it is
			// recorded once beside built_at rather than asked of each partition's
			// build (every partition builds through the same wasm module anyway).
			this.metaSet("format_version", String(wasm.formatVersion()));
			// The loop's one durable cursor: partition 0, step agg, N zeroed
			// records. Its length IS the persisted N — there is no second copy.
			this.metaSet("pp_publish", serializePpPublish(initialPpPublish(partitionCount)));
			// Progressive staging purge: this phase is the only consumer of the
			// tags dumps and the labels dump, and the TagData snapshot just
			// written above is what every restart path restores from
			// (stepAgg reads tagdata_blobs, never these) — so their staged
			// bytes are dead the moment this transaction commits. (default_cards'
			// blobs went earlier still, at the end of the canonical phase — its
			// only consumer.) Dropped in bounded slices on the next alarms, then
			// the GLOBAL phase between the tags and the loop: the cubecobra table
			// (see stepScores).
			this.beginPurge("blobs", {
				table: "stage_blobs",
				kinds: ["oracle_tags", "art_tags", "oracle_cards"],
				next: "scores",
			});
		});
	}

	// ── phase: scores (the corpus-wide finalize tables) ────────────────────────

	/**
	 * Fold one slice of the staged drafts — EVERY partition's, in emission order — into the
	 * corpus-wide finalize tables.
	 *
	 * WHY IT IS ITS OWN PHASE. Two of `finalize`'s inputs are computed ACROSS rows, and the loop
	 * below runs `agg(p)` over ONE partition's drafts:
	 *   - `cubecobra_score` is a PERCENT_RANK over the distinct card names of the whole corpus. A
	 *     table built per partition ranks each card against 1/Nth of the names, so the same corpus
	 *     scores differently depending on which publisher built it — and the archive stores the
	 *     value and SORTS on it (`orderby=cubecobra`), so the deploy's ordering would silently
	 *     change after the first nightly.
	 *   - `illustration_count` groups by (illustration_id, card_name), the one aggregate key with
	 *     no oracle_id in it and therefore the one the partition hash does not co-locate. It has
	 *     never straddled (0 of 46,487 groups on the real corpus), which is a reason to count it
	 *     where the question cannot arise, not a reason to assume it.
	 * Computed once, here, where the drafts are already fully staged (transform finished two
	 * phases ago) and no partition has been chosen yet.
	 *
	 * The tables have a snapshot of their OWN (corpus_blobs), which each slice restores, adds its
	 * batches to, and re-exports in the same transaction as its cursor — so a retried slice
	 * restores exactly the tables its cursor describes, and an eviction costs one slice. They rode
	 * inside the TagData snapshot until 2026-09-25, which made every slice restore and re-export
	 * every tag map, label and slug it never reads: ~3x the snapshot resident at once, beside the
	 * tags phase's group heap that was still alive here. That was 151.8MB of wasm at 2x the corpus,
	 * and at 3x `tags_export` trapped. Each partition's seal reads the tables back, kept to that
	 * partition's names (stepAgg).
	 */
	private async stepScores(): Promise<void> {
		// Nothing before the partition loop needs a group instance (stepTags no longer makes one);
		// one left in this isolate by a run that died mid-loop is dead weight beside this slice.
		dropGroupWasm();
		const wasm = transientWasm();
		wasm.reset();
		const done = Number(this.metaGet("scores_batch_done") ?? 0);
		// Which snapshot holds the tables so far. Set by this phase's first slice under this code;
		// absent only for a run whose earlier slices ran before the tables had a snapshot of their
		// own, and carried them inside tagdata_blobs instead — read from there, once, then carried
		// on in corpus_blobs like any other run's.
		const corpusStaged = this.metaGet("corpus_staged") === "1";
		if (done === 0 || !corpusStaged) {
			if (!this.hasSnapshot("tagdata_blobs")) {
				// Not retryable: the snapshot is written by the tags phase, which the chain
				// guarantees ran to completion before this one.
				throw new FatalImportError("scores: TagData snapshot missing (tags phase incomplete?)");
			}
		}
		if (done > 0) {
			if (corpusStaged) {
				if (!this.hasSnapshot("corpus_blobs")) throw new FatalImportError("scores: corpus snapshot missing mid-phase");
				wasm.corpusRestorePull(this.snapshotRows("corpus_blobs"));
			} else {
				wasm.corpusRestorePull(this.snapshotRows("tagdata_blobs"), true);
			}
		}

		// The routing filter's key set rides this pass (see the wasm export): every draft of every
		// partition, exactly once, is precisely what it needs and precisely what this phase already
		// reads. The partition count is fixed at the end of `tags`, two phases back, so the wasm can
		// stamp the final partition index rather than a hash the publisher would have to re-mod.
		const partitionCount = this.requirePp().partitions.length;
		const routingBlobs: { seq: number; bytes: Uint8Array }[] = [];
		// The oracle index's pairs, by the same batch seq: the wasm emits them right after the
		// routing keys, and they are staged in the SAME row (see stepOracleIndex).
		const pairBlobs = new Map<number, Uint8Array>();
		let routingSeq = -1;
		wasm.setHandlers({
			onRoutingKeys: (b) => routingBlobs.push({ seq: routingSeq, bytes: b }),
			onOraclePairs: (b) => pairBlobs.set(routingSeq, b),
		});

		let fed = 0;
		let fedBytes = 0;
		let exhausted = false;
		let names = 0n;
		// Batches are read in small groups rather than one query: a slice's worth of staged drafts
		// is ~36MB, and materializing that as JS ArrayBuffers alongside the restored tables is
		// the one place this phase could crowd the isolate.
		while (fedBytes < SCORES_SLICE_RAW_BYTES) {
			const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer }>(
				"SELECT seq, bytes FROM draft_batches WHERE seq >= ? ORDER BY seq LIMIT ?",
				done + fed,
				SCORES_FETCH_ROWS,
			);
			// Staged bytes are already the length-prefixed batch framing the wasm reads, so a
			// batch goes across exactly as it was written — no split, no rejoin.
			for (const row of rows) {
				// The routing emit that this call produces is tagged with the batch's OWN seq, so the
				// slice's row can be keyed by where the slice began and cut back per batch if needed.
				routingSeq = row.seq;
				const batch = unpackBlob(new Uint8Array(row.bytes));
				fedBytes += batch.length;
				names = wasm.scoresAddDrafts(batch, partitionCount);
			}
			fed += rows.length;
			// A short fetch is the end of the staging — never "this slice happened to be small".
			if (rows.length < SCORES_FETCH_ROWS) {
				exhausted = true;
				break;
			}
		}
		if (exhausted) names = wasm.scoresFinish();
		wasm.setHandlers({});

		// Counted HERE, where the text is in hand, and committed in the same transaction as the cursor
		// — so a retried slice (which restarts from the last committed cursor) never counts a batch
		// twice. stepRouting sizes its accumulator from the total.
		let routingLines = 0;
		for (const blob of routingBlobs) {
			for (let i = blob.bytes.indexOf(10); i !== -1; i = blob.bytes.indexOf(10, i + 1)) routingLines++;
		}
		this.ctx.storage.transactionSync(() => {
			// Streamed straight into its rows, one chunk resident at a time.
			this.writeSnapshot("corpus_blobs", wasm);
			if (!corpusStaged) this.metaSet("corpus_staged", "1");
			this.metaSet("routing_lines", String(Number(this.metaGet("routing_lines") ?? 0) + routingLines));
			// ONE row for the slice where there was one per batch (routingStagingRows): keyed by the
			// seq of its first batch, so a RETRIED slice — which starts from the same committed
			// cursor — replaces its own row instead of doubling it.
			for (const row of routingStagingRows(routingBlobs, pairBlobs, packBlob, STAGE_BLOB_BYTES)) {
				this.sqlRun(
					"INSERT OR REPLACE INTO routing_keys (seq, bytes, pairs) VALUES (?, ?, ?)",
					row.seq,
					exactBuffer(row.bytes),
					row.pairs ? exactBuffer(row.pairs) : null,
				);
			}
			this.metaSet("scores_batch_done", String(done + fed));
			if (exhausted) this.metaSet("phase", "routing");
		});
		console.log(
			`Scores slice: ${fed} draft batches, ${names} distinct card names` +
				`${exhausted ? " (tables sealed; the partition loop opens)" : ""}`,
		);
	}

	// ── phase: routing (the id→partition filter) ───────────────────────────────

	/**
	 * Build this generation's routing filter from the keys the scores pass staged, and publish it.
	 *
	 * WHY IT IS A PHASE OF ITS OWN, AND WHY IT IS HERE. It needs EVERY partition's keys at once —
	 * an XOR retrieval structure is built from the whole key set or not at all — so it cannot live
	 * inside the per-partition loop; and it must not live in the publish tail, where it would add
	 * seconds of CPU to the one slice that also writes the manifest. Right after `scores` is the
	 * first moment the whole key set exists, and built_at / format_version / partition_count were
	 * all fixed at the end of `tags`, so the key it writes to is already final.
	 *
	 * PUBLISHING BEFORE THE ARCHIVES IS SAFE, not sloppy: the value is addressed by built_at, so
	 * nothing reads it until a manifest names that generation. A run that dies after this point
	 * leaves one orphan key, which retention sweeps with the rest of its family (routingFilterKey
	 * is inside the `store:card-` retention pattern for exactly this reason).
	 *
	 * A FAILURE HERE IS NOT A FAILED RUN. The filter is an optimisation — the serving path fans out
	 * when it is missing, which is what the deployment did before it existed — so a peeling failure
	 * or a KV hiccup logs and moves on rather than costing a night's import.
	 */
	private async stepRouting(): Promise<void> {
		const pp = this.requirePp();
		const builtAt = this.metaGet("built_at") ?? "";
		const formatVersion = Number(this.metaGet("format_version") ?? 0);
		// The tags phase's wasm instance is still referenced here, and nothing reads it again: scores
		// ran on a transient instance restored from the snapshot, and agg builds a fresh one per
		// partition. Its linear memory (17/32/54MB at 1×/2×/3× the corpus in the harness) would sit
		// beside this phase's peak for nothing. Dropping it is the eviction case agg already handles.
		dropGroupWasm();
		try {
			if (!builtAt || !formatVersion) throw new Error("built_at/format_version are not stamped yet");
			// STREAMED (sqlIter): one staged batch in hand at a time, hashed where its bytes lie
			// (`addBatch`) — never the whole ~30MB of packed staging at once, and no string per key.
			//
			// SIZED EXACTLY from the scores pass's own count (`routing_lines`): 1,955,867 counted lines
			// for 1,954,660 keys on the 2026-09-25 corpus — the count includes each batch's stamp line,
			// so it runs over the keys, never under. The 2^21 floor it used to carry held ~1.4MB of
			// unused columns at 1×; 2^21 is now only the guess for a run staged before the count
			// existed, where running out costs a grow.
			const counted = Number(this.metaGet("routing_lines") ?? 0);
			const acc = new RoutingKeyAccumulator(counted > 0 ? counted : 1 << 21);
			let lines = 0;
			// Name keys are claimed only if EVERY staged batch opened with the stamp: a run resumed
			// across the deploy that added them has early batches without any, and a name missing
			// from the filter must never read as "no other partition holds it".
			let batches = 0;
			let stampedBatches = 0;
			for (const row of this.sqlIter<{ bytes: ArrayBuffer }>("SELECT bytes FROM routing_keys ORDER BY seq")) {
				const read = acc.addBatch(unpackBlob(new Uint8Array(row.bytes)));
				batches++;
				if (read.stamped) stampedBatches++;
				lines += read.keys;
			}
			if (lines === 0) throw new Error("the scores phase staged no routing keys");
			// Sorts in place and hands back exact copies of the distinct keys, releasing the
			// accumulator's columns — see `seal` and backlog x2 for the memory this phase holds.
			const sealed = acc.seal(pp.partitions.length);
			const names = batches > 0 && stampedBatches === batches;
			const bytes = buildRoutingFilterFromHashes(
				sealed,
				{
					builtAt,
					partitionCount: pp.partitions.length,
					partitionHash: PARTITION_HASH_ALGO,
				},
				names ? ROUTING_FEATURE_NAME_KEYS : 0,
			);
			// The family is in flight from its FIRST key in KV, and this is that key. The marker used
			// to be set at partition 0's first chunk, hours from here, and the filter — grouped with
			// the family by built_at — sat unprotected in between: two deploy-built generations in
			// that window made it third-newest and retention retired it, so the generation shipped
			// with every /cards/<id> fanning out N ways until the next night. A marker put that
			// fails lands in the catch below, which is right: an unprotected filter IS the bug.
			await this.markPublishing();
			await writeRoutingFilter(this.env, formatVersion, builtAt, bytes);
			console.log(
				`Routing filter published: ${sealed.lo.length} keys (${names ? sealed.nameKeys : 0} names` +
					`${names ? "" : `, name routing OFF: ${stampedBatches}/${batches} batches stamped`}) from ${lines} ` +
					`rows (sized for ${counted}, ${acc.grows} grows), ` +
					`${(bytes.byteLength / 1024).toFixed(0)}KB — bare-id routes ask ONE of ` +
					`${pp.partitions.length} partitions.`,
			);
		} catch (err) {
			console.warn(`Routing filter NOT published (${err}); every /cards/<id> lookup will fan out.`);
		}
		// The staging stays for one more phase: its `pairs` column is the oracle index's input, and
		// that phase drops the table (both halves) once it has read them.
		this.metaSet("phase", "oracle_index");
	}

	// ── phase: oracle_index (scryfall id → oracle id, for /cards/:id/rulings) ──

	/**
	 * Build the scryfall id → oracle id index (src/engine/oracle-index.ts) from the pairs the scores
	 * pass staged beside the routing keys, publish the buckets whose bytes changed, then drop the
	 * staging.
	 *
	 * ITS OWN PHASE, AND SO ITS OWN SLICE, because of memory: the encoder holds the pairs once
	 * (17MB on the 2026-09-24 corpus, ~35MB at 2×) plus the buckets it has finished, and the
	 * routing filter's accumulator in the phase before holds ~20MB of hashes and reads ~60MB of
	 * staged text — the two together in one 128MB isolate is the overlap this split exists to
	 * avoid. The encoder takes TWO passes over the staged rows (count, then scatter) so it never
	 * holds the rows and the pairs at once: ~2 x 1,180 rows read, ~0.2% of MAX_RUN_ROWS_READ.
	 *
	 * KV COST: one meta read, then a put per CHANGED bucket and the meta last — the hashes in the
	 * meta are what the next publisher (this phase or the deploy's seed-oracle-index.ts) diffs
	 * against, so it must never describe bytes KV does not hold. Buckets are keyed by the id's top
	 * six bits and new printings land uniformly: k new printings touch ~64(1-(63/64)^k) buckets,
	 * ~51 at k=100, never more than 64 — against the free plan's 1,000 KV writes a day.
	 *
	 * BEFORE THE MANIFEST, deliberately: the index is not part of the store generation (stable
	 * keys, no built_at in them), so publishing it here only means a brand-new printing's rulings
	 * can answer for the hour or two before the manifest names the partition that holds it —
	 * rulings the route would serve that printing the moment the manifest landed anyway.
	 *
	 * A FAILURE HERE IS NOT A FAILED RUN, exactly like the routing filter: a missing or stale index
	 * costs one engine call per rulings request, which is what the route did before it existed.
	 */
	private async stepOracleIndex(): Promise<void> {
		const builtAt = this.metaGet("built_at") ?? "";
		try {
			const builder = new OracleIndexBuilder();
			let batches = 0;
			let unpaired = 0;
			let pairBytes = 0;
			for (const row of this.sqlIter<{ pairs: ArrayBuffer | null }>("SELECT pairs FROM routing_keys ORDER BY seq")) {
				batches++;
				if (row.pairs === null) {
					unpaired++;
					continue;
				}
				pairBytes += row.pairs.byteLength;
				builder.count(new Uint8Array(row.pairs));
			}
			if (batches === 0) throw new Error("the scores phase staged no batches");
			// A run resumed across the deploy that added the pairs has early batches without them.
			// Publishing would REMOVE those printings from buckets that hold them tonight — safe (a
			// miss asks the engine) but a step backwards; the index already in KV is the better one.
			if (unpaired > 0) throw new Error(`${unpaired}/${batches} staged batches carry no oracle pairs`);
			for (const row of this.sqlIter<{ pairs: ArrayBuffer }>("SELECT pairs FROM routing_keys ORDER BY seq")) {
				builder.add(new Uint8Array(row.pairs));
			}
			const { buckets, pairCount, conflicts } = builder.finish();
			if (pairCount === 0) throw new Error("the staged batches hold no oracle pairs");

			let published: OracleIndexMeta | null = null;
			try {
				published = (await this.env.STORE_KV.get(ORACLE_INDEX_META_KEY, "json")) as OracleIndexMeta | null;
			} catch (err) {
				// Unparseable is "describes nothing": every bucket is owed. A failed READ is too —
				// the cost is re-putting unchanged buckets once, never a wrong one.
				console.warn(`Oracle index: could not read ${ORACLE_INDEX_META_KEY} (${err}); republishing every bucket`);
			}
			const { changed, meta } = await planOracleIndexPublish(buckets, pairCount, builtAt, published);
			for (let at = 0; at < changed.length; at += RULINGS_PUT_CONCURRENCY) {
				await Promise.all(
					changed
						.slice(at, at + RULINGS_PUT_CONCURRENCY)
						.map((b) => this.env.STORE_KV.put(oracleIndexBucketKey(b), buckets[b] as Uint8Array)),
				);
			}
			await this.env.STORE_KV.put(ORACLE_INDEX_META_KEY, JSON.stringify(meta));
			// Only when the layout moved: a list costs a KV operation, and on every other night there
			// is nothing under the prefix but the current layout's own stable keys.
			if (published?.format_version !== meta.format_version) {
				await this.pruneOldKeys(ORACLE_INDEX_KEY_PREFIX, oracleIndexCurrentPrefix(), "oracle-index");
			}
			let bucketBytes = 0;
			let largest = 0;
			for (const b of buckets) {
				bucketBytes += b.byteLength;
				largest = Math.max(largest, b.byteLength);
			}
			console.log(
				`Oracle index published: ${pairCount} printings from ${batches} batches (${pairBytes} staged bytes` +
					`${conflicts > 0 ? `, ${conflicts} conflicting ids dropped` : ""}), ${changed.length}/${buckets.length} ` +
					`bucket(s) written, ${(bucketBytes / 1048576).toFixed(1)}MB in all, largest ` +
					`${(largest / 1024).toFixed(0)}KB — /cards/:id/rulings asks no partition for these.`,
			);
		} catch (err) {
			console.warn(`Oracle index NOT published (${err}); /cards/:id/rulings asks the engine for what it lacks.`);
		}
		this.ctx.storage.transactionSync(() => {
			// Dropped either way: the keys and pairs have done their job, and ~80MB of staging
			// against a shared 5GB pool is not worth keeping for a retry of optional artifacts.
			this.noteChurn(this.routingStagingBytes());
			this.sqlRun("DELETE FROM routing_keys");
			this.metaSet("bucket_batch_done", "0");
			this.metaSet("phase", "bucket");
		});
	}

	/** Both halves of routing_keys' staged bytes in ONE scan (blobBytesIn measures `bytes` only). */
	private routingStagingBytes(): number {
		return Number(
			this.sqlAll<{ n: number }>(
				"SELECT COALESCE(SUM(LENGTH(bytes)), 0) + COALESCE(SUM(LENGTH(pairs)), 0) AS n FROM routing_keys",
			)[0]?.n ?? 0,
		);
	}

	// ── phase: bucket (the drafts, re-grouped by partition, ONCE) ──────────────

	/**
	 * Walk the draft staging once and write every draft into its partition's own
	 * `draft_parts` rows, so the loop that follows reads 1/N of the corpus per
	 * partition instead of all of it.
	 *
	 * Before this phase existed, agg and finalize each read the WHOLE of
	 * draft_batches for every partition and kept the 1/N that hashed to it —
	 * 2 x N x 1,180 rows read and 2 x N x 19 alarms at today's shape, and N
	 * itself grows with the corpus, so the nightly's cost was quadratic in corpus
	 * size. Every alarm bills a row written (import-budget.ts), which made the
	 * write meter the one that would have stopped nightlies completing at about
	 * 1.6x today's corpus. This pass costs one read per staged batch plus one
	 * write per group written and one per batch deleted, once, and turns the
	 * N x stagedBatches term into stagedBatches. projectRunCost carries the model.
	 *
	 * IT RUNS HERE, after scores and routing, because those are the last phases
	 * that read draft_batches whole — scores builds the corpus-wide tables from
	 * every draft — and it runs before agg because N is pinned at the end of tags
	 * and every partition's share is a function of it.
	 *
	 * Memory: each partition's group is built as a PackStream, so what a slice
	 * holds is COMPRESSED bytes — at most one row's worth per partition — plus
	 * each stream's compressor (~0.4MB) and the fetch group. Groups are up to
	 * DRAFT_BATCH_BYTES raw (6MB, since 2026-09-25), which as raw views would be
	 * N x 6MB, 192MB at N=32; packed as they go it is ~15MB at N=32. A group
	 * whose packed bound would pass a row is flushed early, whatever its raw size.
	 *
	 * Idempotent per slice: a group's key is a pure function of the slice's
	 * source cursor and the group's ordinal within it (`done x 128 + ordinal`,
	 * monotonic across slices, and no partition writes 128 groups from 64
	 * batches), so a retried slice overwrites its own rows rather than appending
	 * duplicates; the consumed source rows are deleted in the same transaction
	 * that advances the cursor. Partial tails — one group per partition per
	 * slice, under the cap — are accepted rather than carried over: carrying
	 * them would cost 2N writes a slice to save ~N rows of reads later.
	 */
	private async stepBucket(): Promise<void> {
		const pp = this.requirePp();
		const n = pp.partitions.length;
		const done = Number(this.metaGet("bucket_batch_done") ?? 0);
		const acc: (PackStream | null)[] = new Array(n).fill(null);
		const ordinal = new Array<number>(n).fill(0);
		let groups = 0;
		const flush = (partition: number) => {
			const group = acc[partition];
			if (!group || group.count === 0) return;
			this.sqlRun(
				"INSERT OR REPLACE INTO draft_parts (partition, seq, count, bytes) VALUES (?, ?, ?, ?)",
				partition,
				done * 128 + (ordinal[partition] as number),
				group.count,
				exactBuffer(group.finish()),
			);
			ordinal[partition] = (ordinal[partition] as number) + 1;
			acc[partition] = null;
			groups += 1;
		};
		let fed = 0;
		let fedBytes = 0;
		let exhausted = false;
		let sourceBytes = 0;
		while (fed < BUCKET_SLICE_BATCHES && fedBytes < BUCKET_SLICE_RAW_BYTES) {
			const want = Math.min(BUCKET_FETCH_BATCHES, BUCKET_SLICE_BATCHES - fed);
			const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer; part_hashes: ArrayBuffer | null }>(
				"SELECT seq, bytes, part_hashes FROM draft_batches WHERE seq >= ? ORDER BY seq LIMIT ?",
				done + fed,
				want,
			);
			for (const row of rows) {
				if (!row.part_hashes) {
					throw new FatalImportError(
						"draft batch carries no partition hashes — staged by a pre-partition build; " +
							"the next scheduled import restarts cleanly",
					);
				}
				// Deleted at the end of this slice: churn, like the groups it becomes.
				sourceBytes += row.bytes.byteLength + row.part_hashes.byteLength;
				const raw = unpackBlob(new Uint8Array(row.bytes));
				fedBytes += raw.length;
				const byPartition = bucketDrafts({ bytes: raw, partHashes: new Uint8Array(row.part_hashes) }, n);
				for (let p = 0; p < n; p++) {
					for (const draft of byPartition[p] as Uint8Array[]) {
						// A group ends where the next draft would take it past DRAFT_BATCH_BYTES raw (the
						// blobGroups rule), or past a row once packed.
						const open = acc[p];
						if (
							open &&
							open.count > 0 &&
							(open.raw + 4 + draft.length > DRAFT_BATCH_BYTES ||
								open.packedBound + 4 + draft.length > STAGE_BLOB_BYTES)
						) {
							flush(p);
						}
						const group = acc[p] ?? new PackStream();
						acc[p] = group;
						group.push(draft);
					}
				}
			}
			fed += rows.length;
			// A short fetch is the end of the staging, and the only seal condition.
			if (rows.length < want) {
				exhausted = true;
				break;
			}
		}
		this.ctx.storage.transactionSync(() => {
			for (let p = 0; p < n; p++) flush(p);
			// The consumed source rows go in the SAME transaction as the cursor, so the pool never
			// holds the drafts twice for longer than one slice and a retry re-reads exactly what
			// it re-writes.
			this.sqlRun("DELETE FROM draft_batches WHERE seq >= ? AND seq < ?", done, done + fed);
			this.noteChurn(sourceBytes);
			this.metaSet("bucket_batch_done", String(done + fed));
			if (exhausted) {
				this.metaSet("phase", "agg");
			}
		});
		if (exhausted) {
			const parts = this.sqlAll<{ partition: number; groups: number; drafts: number }>(
				"SELECT partition, COUNT(*) AS groups, SUM(count) AS drafts FROM draft_parts GROUP BY partition ORDER BY partition",
			);
			console.log(
				`Drafts bucketed into ${n} partition(s): ` +
					parts.map((r) => `p${r.partition} ${r.groups} groups/${r.drafts} drafts`).join(", "),
			);
		} else {
			console.log(`Bucket slice: batches ${done}-${done + fed}, ${groups} groups written`);
		}
	}

	/**
	 * The loop state, which every partitioned phase requires.
	 *
	 * Missing in a loop phase means the run was staged by the pre-partition
	 * pipeline and a deploy landed mid-run — the same situation
	 * takePendingDrafts detects, with the same answer: restarting the run is
	 * strictly better than finishing it wrong.
	 */
	private requirePp(): PpPublish {
		const state = parsePpPublish(this.metaGet("pp_publish"));
		if (!state) {
			throw new FatalImportError(
				"pp_publish is missing mid-loop — staged by a pre-partition build; " +
					"the next scheduled import restarts cleanly",
			);
		}
		return state;
	}

	/** Persist the loop state (caller supplies the surrounding transaction). */
	private savePp(state: PpPublish): void {
		this.metaSet("pp_publish", serializePpPublish(state));
	}

	/** Partition p's chunk-family key in this run's pinned family:
	 * `card-store-v<fmt>-<built_at>-p<k>.store`. */
	private partitionKey(partition: number): string {
		const formatVersion = Number(this.metaGet("format_version") ?? 0);
		const builtAt = this.metaGet("built_at") ?? "";
		return partitionStoreKey(formatVersion, builtAt, partition);
	}

	/** Whether a snapshot table holds any rows (one index read). */
	private hasSnapshot(table: SnapshotTable): boolean {
		return this.sqlAll<{ seq: number }>(`SELECT seq FROM ${table} LIMIT 1`).length > 0;
	}

	/**
	 * A snapshot table served to a pull restore, one row per call: row `index` unpacked, null past
	 * the last. The restore holds one row at a time; the old path read every row, unpacked each,
	 * and copied them into one merged buffer that then went into wasm whole — the snapshot three
	 * times over at its peak. A row the previous build wrote unpacked passes through unpackBlob.
	 */
	private snapshotRows(table: SnapshotTable): SnapshotRows {
		return (index) => {
			const row = this.sqlAll<{ bytes: ArrayBuffer }>(`SELECT bytes FROM ${table} WHERE seq = ?`, index)[0];
			return row ? unpackBlob(new Uint8Array(row.bytes)) : null;
		};
	}

	/**
	 * Replace a snapshot table with the instance's export (caller supplies the surrounding
	 * transaction): the TagData into tagdata_blobs, the corpus tables alone into corpus_blobs.
	 *
	 * STREAMED: the wasm emits STAGE_BLOB_BYTES-sized chunks and each is packed and inserted as it
	 * arrives, so neither side ever holds the serialized snapshot whole — the rows are the ones the
	 * old path cut out of one whole-snapshot emit. Each row is PACKED (packBlob, deflate level 1):
	 * the snapshot is serde_json, which compresses several-fold, and every rewrite is churn — the
	 * bytes deleted plus the bytes inserted — that the pacing turns into alarm sleeps at ≤2MB/s.
	 */
	private writeSnapshot(table: SnapshotTable, wasm: ImportWasm): void {
		this.noteChurn(this.blobBytesIn(table));
		this.sqlRun(`DELETE FROM ${table}`);
		let seq = -1;
		const put = (chunk: Uint8Array) => {
			this.sqlRun(`INSERT INTO ${table} (seq, bytes) VALUES (?, ?)`, ++seq, exactBuffer(packBlob(chunk)));
		};
		try {
			if (table === "tagdata_blobs") {
				wasm.setHandlers({ onTagData: put });
				wasm.tagsExport();
			} else {
				wasm.setHandlers({ onCorpus: put });
				wasm.corpusExport();
			}
		} finally {
			wasm.setHandlers({});
		}
	}

	/**
	 * Tags/agg/finalize state lives in the wasm heap. If the instance nonce
	 * changed (DO eviction), rebuild that state from SQLite: restore the tag
	 * snapshot and restart aggregation OF THE CURRENT PARTITION; the caller
	 * then resumes its phase.
	 *
	 * The rewind scope is one partition, and that is free by construction:
	 * spill_batches and ordered_rows only ever hold the CURRENT partition's
	 * rows (each partition's are purged when its publish completes), and
	 * partitions already published live in KV under their own chunk keys,
	 * which nothing here touches. So losing the heap during partition 5 of 8
	 * costs partition 5's agg-to-build, never the four stores already
	 * published.
	 */
	private ensureWasmContinuity(): boolean {
		const wasm = groupWasm();
		if (this.metaGet("tags_nonce") === wasm.nonce) return true;
		// A rewind is not a retry, and that is what makes it dangerous: it
		// returns false, the caller returns cleanly, and the alarm chain
		// counts the slice as a SUCCESS — clearing the retry and attempt
		// counters that would otherwise bound it. Meanwhile it has thrown away
		// the current partition's spilled rows and sent the run back to `agg`,
		// so that partition's work from aggregation onwards is done again.
		// Evict often enough and the import never finishes while quietly
		// re-spending the daily row budget, with no error anywhere to say so.
		//
		// So rewinds get their own ceiling — cumulative across the whole run,
		// not per partition, because the budget being protected (the day's row
		// allowance) is run-scoped. Hitting it means eviction is outrunning
		// progress, which no amount of retrying fixes.
		const rewinds = Number(this.metaGet("wasm_rewinds") ?? 0) + 1;
		if (rewinds > MAX_WASM_REWINDS) {
			throw new FatalImportError(
				`wasm state was lost ${rewinds} times in one run — eviction is outpacing progress, ` +
					"so the import is rewinding to aggregation faster than it can reach publish",
			);
		}
		const pp = this.requirePp();
		// The rewind rebuilds the partition from its draft_parts — which the
		// partition's PUBLISH drops (progressive purge, load-bearing for the 5GB
		// pool). Losing the heap after that point is unrecoverable within this
		// run: without this check the rewind would "succeed", aggregate zero
		// drafts, and die two phases later on "no staged rows" — an accurate
		// symptom of the wrong cause. The cost is one lost nightly in a rare
		// double failure (eviction during the partition's reorder/build after
		// its drafts are gone); the previous store keeps serving and the next
		// import restarts cleanly.
		const draftRows = Number(
			this.sqlAll<{ n: number }>("SELECT COUNT(*) AS n FROM draft_parts WHERE partition = ?", pp.partition)[0]?.n ?? 0,
		);
		if (draftRows === 0) {
			throw new FatalImportError(
				`wasm state was lost and partition ${pp.partition}'s drafts are already gone — this run ` +
					"cannot rebuild the partition; the next scheduled import restarts cleanly",
			);
		}
		console.warn(
			`Wasm state lost to eviction (${rewinds}/${MAX_WASM_REWINDS}); partition ${pp.partition} ` +
				"restarts at aggregation once its stale staging is purged",
		);
		this.ctx.storage.transactionSync(() => {
			this.metaSet("wasm_rewinds", String(rewinds));
			// NOTHING IS INSTANTIATED HERE. The rewind used to build a fresh group
			// wasm and restore the ~20MB tag snapshot into it right away, then arm
			// the purge below — whose slices are paced 13-32s apart, while an idle
			// object hibernates after ~10s. So the fresh heap was routinely lost
			// DURING the purge it had just armed, and when stepAgg resumed, the
			// nonce mismatched again and a SECOND rewind was charged for the same
			// eviction: two deploys mid-loop were fatal. Clearing the partition's
			// start marker instead hands the rebuild to stepAgg's own fresh path,
			// which runs AFTER the purge, in the alarm that will use the heap it
			// builds. An eviction during the purge slices has nothing to lose.
			this.metaSet("tags_nonce", "rewound");
			this.metaSet("agg_partition_started", "");
			this.metaSet("agg_seq_done", "-1");
			this.metaSet("agg_sealed", "0");
			// Any partially-spilled finalize output is invalid with a fresh heap,
			// and so is anything reorder derived FROM that output: resuming the
			// rewritten spill part-written against rows that no longer exist would
			// append to stale blobs — a store that builds without error and is
			// wrong. Only the current partition's rows exist in those tables (see
			// the method comment), so the "rewind" purge scope's whole-table sweep
			// IS the partition-scoped one — and it runs in bounded slices on the
			// next alarms, never as one commit here (import-purge.ts).
			this.metaSet("finalize_seq_done", "-1");
			this.metaSet("reorder_done", "0");
			pp.step = "agg";
			this.savePp(pp);
			this.beginPurge("rewind");
		});
		return false;
	}

	// ── phase: agg (per partition) ───────────────────────────────────────────────

	private async stepAgg(): Promise<void> {
		const pp = this.requirePp();
		// A FRESH heap per partition (plan B3): linear memory never shrinks, so a
		// heap that carried partition k's interners into partition k+1 would climb
		// monotonically toward the module's cap over the loop. This is the same
		// move stepTags makes at the start of ITS group, keyed on the partition
		// index so an eviction mid-partition takes the rewind path below instead
		// of silently restarting the partition without counting it.
		if (this.metaGet("agg_partition_started") !== String(pp.partition)) {
			// The drafts this partition will read were bucketed by stepBucket. None at all means
			// the staging predates that phase — a deploy landed mid-run on an instance whose drafts
			// are still only in draft_batches — and the same answer as every other mid-run schema
			// gap applies: restart the run rather than build a partition from nothing.
			const bucketed = Number(
				this.sqlAll<{ n: number }>("SELECT COUNT(*) AS n FROM draft_parts WHERE partition = ?", pp.partition)[0]?.n ??
					0,
			);
			if (bucketed === 0) {
				throw new FatalImportError(
					`partition ${pp.partition} has no bucketed drafts — staged by a pre-bucket build; ` +
						"the next scheduled import restarts cleanly",
				);
			}
			// This partition's share of the TagData and nothing more: the labels and the slug table
			// whole, the oracle tags its own oracle ids hash to. The art tags and the corpus tables
			// follow at the seal below, kept to the names and illustrations its drafts turn out to
			// carry. Restoring the WHOLE TagData and corpus tables into every partition's heap was
			// a corpus-wide term in a heap whose every other term is bounded by the partition size.
			const fresh = newGroupWasm();
			fresh.reset();
			if (!this.hasSnapshot("tagdata_blobs")) throw new Error("tagdata snapshot missing; cannot restore tags");
			const oracleIds = fresh.tagsRestorePullPartition(
				this.snapshotRows("tagdata_blobs"),
				pp.partition,
				pp.partitions.length,
			);
			console.log(`Restored partition ${pp.partition}'s share of the TagData: ${oracleIds} oracle ids' tags`);
			this.ctx.storage.transactionSync(() => {
				this.metaSet("tags_nonce", fresh.nonce);
				this.metaSet("agg_partition_started", String(pp.partition));
				// Every per-partition cursor starts over with the heap. Stale
				// values from the previous partition would resume its progress
				// against this partition's data — the forgotten-reset bug class —
				// so they are all reset HERE, in the one transition that
				// invalidates them.
				this.metaSet("agg_seq_done", "-1");
				this.metaSet("agg_sealed", "0");
				this.metaSet("finalize_seq_done", "-1");
				this.metaSet("spill_base", "0");
				this.metaSet("reorder_done", "0");
				this.metaSet("staged_rows", "0");
			});
		}
		if (!this.ensureWasmContinuity()) return;
		const wasm = groupWasm();
		// The cursor is the last draft_parts seq consumed, not a count: the seqs
		// are sparse (stepBucket keys them by source slice and ordinal), and a
		// `seq > ?` seek on the composite key reads this partition's next groups
		// and nothing else.
		let last = Number(this.metaGet("agg_seq_done") ?? -1);
		// Fetched DRAFT_FETCH_ROWS rows at a time rather than one query for the
		// whole slice — the split stepScores documents: the slice (raw bytes) is a
		// CPU budget, the fetch group is the resident-bytes budget, and
		// materializing a whole slice at once would be ~96MB against a 128MB
		// isolate.
		let fedBytes = 0;
		let exhausted = false;
		while (fedBytes < AGG_SLICE_RAW_BYTES) {
			const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer }>(
				"SELECT seq, bytes FROM draft_parts WHERE partition = ? AND seq > ? ORDER BY seq LIMIT ?",
				pp.partition,
				last,
				DRAFT_FETCH_ROWS,
			);
			for (const row of rows) {
				// Every draft in the group is this partition's, in emission order —
				// stepBucket preserved it within and across batches — so the group
				// is fed whole, no filter: in WASM_FEED_BYTES pieces (feedSlices),
				// since each call's input lands in linear memory, which never shrinks.
				const batch = unpackBlob(new Uint8Array(row.bytes));
				fedBytes += batch.length;
				for (const piece of feedSlices(batch)) wasm.aggDrafts(piece);
				last = row.seq;
			}
			// A short fetch means the staging ran out, which is the seal condition
			// below — never "this group happened to be small".
			if (rows.length < DRAFT_FETCH_ROWS) {
				exhausted = true;
				break;
			}
		}
		if (exhausted) {
			const winners = wasm.aggFinish();
			// The rest of what finalize looks up, now that the partition's drafts have named every key
			// they will ask for: the art tags of the illustrations they show, and the corpus tables'
			// entries for the names they carry. Exact — see the wasm export. A run whose scores
			// phase finished before the tables had a snapshot of their own reads them from the
			// TagData snapshot, where it left them.
			const art = wasm.partitionTablesRestorePull("art", this.snapshotRows("tagdata_blobs"));
			const scored =
				this.metaGet("corpus_staged") === "1"
					? wasm.partitionTablesRestorePull("corpus", this.snapshotRows("corpus_blobs"))
					: wasm.partitionTablesRestorePull("legacy-corpus", this.snapshotRows("tagdata_blobs"));
			console.log(
				`Aggregation sealed for partition ${pp.partition}/${pp.partitions.length}: ${winners} winners; ` +
					`kept ${art} illustrations' art tags and ${scored} names' scores`,
			);
			wasm.finalizeBegin();
			this.ctx.storage.transactionSync(() => {
				this.metaSet("agg_sealed", "1");
				this.metaSet("finalize_seq_done", "-1");
				this.metaSet("spill_base", "0");
				pp.step = "finalize";
				this.savePp(pp);
				this.metaSet("phase", "finalize");
			});
		} else {
			this.metaSet("agg_seq_done", String(last));
		}
	}

	// ── phase: finalize ────────────────────────────────────────────────────────

	private async stepFinalize(): Promise<void> {
		const pp = this.requirePp();
		if (!this.ensureWasmContinuity()) return;
		const wasm = groupWasm();
		let last = Number(this.metaGet("finalize_seq_done") ?? -1);
		const spillBuf: Uint8Array[] = [];
		// Only the spill handler: the wasm also emits per-row JSON (EMIT_ROW,
		// upstream's D1 cards-table feed), which nothing on this platform reads —
		// it used to be staged into a row_batches table that was write-only, ~1.1GB
		// of dead staging at all_cards scale. Leaving the handler unset drops those
		// emits without even copying the bytes out of wasm memory.
		wasm.setHandlers({
			onSpill: (b) => spillBuf.push(b),
		});
		let staged = 0n;
		// Same fetch-group split as stepAgg and stepScores: FINALIZE_SLICE_RAW_BYTES
		// is the CPU budget, DRAFT_FETCH_ROWS the resident-bytes one.
		let fedBytes = 0;
		let finished = false;
		while (fedBytes < FINALIZE_SLICE_RAW_BYTES) {
			const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer }>(
				"SELECT seq, bytes FROM draft_parts WHERE partition = ? AND seq > ? ORDER BY seq LIMIT ?",
				pp.partition,
				last,
				DRAFT_FETCH_ROWS,
			);
			for (const row of rows) {
				// Same rows, same order as stepAgg — the finalize pass's contract
				// with the aggregation it follows — and the same WASM_FEED_BYTES pieces.
				const batch = unpackBlob(new Uint8Array(row.bytes));
				fedBytes += batch.length;
				for (const piece of feedSlices(batch)) staged = wasm.finalizeDrafts(piece);
				last = row.seq;
			}
			if (rows.length < DRAFT_FETCH_ROWS) {
				finished = true;
				break;
			}
		}
		if (finished) staged = wasm.finalizeEnd();
		wasm.setHandlers({});

		this.ctx.storage.transactionSync(() => {
			// Byte-capped groups keyed by their first row's index, so a retried
			// slice overwrites its own groups instead of appending duplicates.
			let base = Number(this.metaGet("spill_base") ?? 0);
			for (const group of blobGroups(spillBuf)) {
				this.sqlRun(
					"INSERT OR REPLACE INTO spill_batches (base, count, bytes) VALUES (?, ?, ?)",
					base,
					group.length,
					exactBuffer(packBlob(lengthPrefixed(group))),
				);
				base += group.length;
			}
			this.metaSet("spill_base", String(base));
			this.metaSet("finalize_seq_done", String(last));
			if (finished) {
				this.metaSet("staged_rows", String(staged));
				// This partition's drafts are NOT dropped here, though finalize is
				// their last reader on the happy path: a wasm rewind during reorder
				// or build restarts the partition at agg and needs them again. They
				// go at the partition's publish (stepPublish's completion), the
				// first point nothing can send the loop back — and since stepBucket
				// consumed draft_batches, the staging shrinks by 1/N per partition
				// rather than dropping all at once on the last one.
				pp.step = "reorder";
				this.savePp(pp);
				this.metaSet("phase", "reorder");
			}
		});
		console.log(
			`Finalize slice (partition ${pp.partition}): ${(fedBytes / 1e6).toFixed(1)}MB of drafts, ${staged} rows staged` +
				`${finished ? " (done)" : ""}`,
		);
	}

	// ── phase: build ───────────────────────────────────────────────────────────

	/**
	 * Rewrite the spilled rows in BUILD order, a contiguous range per slice.
	 *
	 * The build consumes rows sorted; finalize can only write them in add order,
	 * because the sort key of the last row is not known until every row is in.
	 * Serving the build's arbitrary add-index therefore meant a random seek per
	 * row: 97,802 `substr` lookups, measured at 15.0s of a 17.4s build — roughly
	 * 60s on an edge core against a 30s ceiling, which is why the nightly import
	 * has never completed on either plan.
	 *
	 * So the order is fetched from wasm up front (`stagedOrder`) and the spill is
	 * rewritten once to match it. Each slice claims a contiguous range of build
	 * positions, reads each spill group holding one of those rows exactly once,
	 * and writes them out in order. The build then reads straight through.
	 *
	 * Cost per slice: two passes over the spill groups — one to index the row
	 * offsets, one to read the groups this slice needs — so ~2x25 reads a slice
	 * and ~400 across the phase, against the 97,802 the random-seek build did.
	 * Memory: this slice's own rows, which is why reorderSlice copies them out
	 * rather than viewing into the group blobs.
	 */
	private async stepReorder(): Promise<void> {
		const pp = this.requirePp();
		if (!this.ensureWasmContinuity()) return;
		const staged = Number(this.metaGet("staged_rows") ?? 0);
		if (staged === 0) throw new FatalImportError(`reorder: no staged rows for partition ${pp.partition}`);

		const order = groupWasm().stagedOrder(staged);
		if (order.length !== staged) {
			throw new FatalImportError(`reorder: order has ${order.length} entries, expected ${staged}`);
		}

		const index = spillIndex(
			(function* (rows) {
				for (const row of rows) yield { base: Number(row.base), bytes: unpackBlob(blobBytes(row.bytes)) };
			})(this.sqlIter("SELECT base, bytes FROM spill_batches ORDER BY base")),
		);
		const from = Number(this.metaGet("reorder_done") ?? 0);
		const to = Math.min(from + REORDER_SLICE_ROWS, staged);

		let groupsRead = 0;
		const ordered = reorderSlice(order, index, from, to, (base) => {
			const blob = this.sqlAll<{ bytes: ArrayBuffer }>("SELECT bytes FROM spill_batches WHERE base = ?", base)[0];
			if (!blob) return null;
			groupsRead += 1;
			return unpackBlob(blobBytes(blob.bytes));
		});

		this.ctx.storage.transactionSync(() => {
			// Keyed by the build position of the group's first row, so this
			// slice's write is idempotent — see the schema note on ordered_rows.
			let base = from;
			for (const group of blobGroups(ordered)) {
				this.sqlRun(
					"INSERT OR REPLACE INTO ordered_rows (base, count, bytes) VALUES (?, ?, ?)",
					base,
					group.length,
					exactBuffer(packBlob(lengthPrefixed(group))),
				);
				base += group.length;
			}
			this.metaSet("reorder_done", String(to));
			if (to >= staged) {
				pp.step = "build";
				this.savePp(pp);
				this.metaSet("phase", "build");
			}
		});
		console.log(
			`Reorder slice (partition ${pp.partition}): rows ${from}-${to} of ${staged} from ${groupsRead} spill groups`,
		);
	}

	private async stepBuild(): Promise<void> {
		const pp = this.requirePp();
		if (!this.ensureWasmContinuity()) return;
		const wasm = groupWasm();

		// stepReorder rewrote the spill in the exact order build_store_stream
		// pulls, so this is a cursor, not a lookup table. It used to be the
		// latter: one `substr` per row, 97,802 random seeks, 15.0s of a 17.4s
		// build — about 60s on an edge core against a 30s ceiling. Now one
		// ordered blob is resident at a time and each pull is an array index.
		//
		// The order is re-derived here rather than trusted: it is the same
		// deterministic permutation stepReorder laid the rows out in (the
		// comparator ends on scryfall_id, so there are no ties to break
		// differently), and orderedRowCursor checks every pull against it.
		const staged = Number(this.metaGet("staged_rows") ?? 0);
		const order = wasm.stagedOrder(staged);
		if (order.length !== staged) {
			throw new FatalImportError(`build: order has ${order.length} entries, expected ${staged}`);
		}
		const lookup = orderedRowCursor(order, (position) => {
			const next = this.sqlAll<{ base: number; bytes: ArrayBuffer }>(
				"SELECT base, bytes FROM ordered_rows WHERE base <= ? ORDER BY base DESC LIMIT 1",
				position,
			)[0];
			return next ? { base: Number(next.base), bytes: unpackBlob(blobBytes(next.bytes)) } : null;
		});
		console.log(
			`Build (partition ${pp.partition}/${pp.partitions.length}): streaming ${staged} rows from ordered_rows`,
		);
		// One metered read per ordered blob, not per row — charged up front so a
		// killed build cannot spend the allowance invisibly.
		this.prechargeReads(Number(this.sqlAll<{ n: number }>("SELECT COUNT(*) AS n FROM ordered_rows")[0]?.n ?? 0));

		// Empty on the happy path (the previous partition's purge took it); only a
		// build retry finds rows here, at most ~70MB — under the commit size the
		// bucket phase proves safe, and timed so a slow one is on record.
		{
			const cleared = Date.now();
			const cursor = this.ctx.storage.sql.exec("DELETE FROM chunk_staging");
			this.rowsRead += cursor.rowsRead;
			this.rowsWritten += cursor.rowsWritten;
			if (cursor.rowsWritten > 0) {
				this.noteChurn(cursor.rowsWritten * STAGE_BLOB_BYTES);
				console.log(`Build: cleared ${cursor.rowsWritten} stale chunk_staging row(s) in ${Date.now() - cleared}ms`);
			}
		}
		let chunkSeq = -1;
		// Stage on the STAGING grid — rows just under the DO's 2MB per-value
		// cap, which is as large as they can be. Publishing to KV shares a grid
		// with nobody (it re-cuts these into ~20MB KV chunks), and the old
		// 40,000-byte grid cost ~1,750 DO row writes per import against a
		// 100k/day budget. At 1.9MB a 70MB store stages in ~37 rows.
		const grid = new GridChunker();
		const stage = (b: Uint8Array) => {
			this.sqlRun("INSERT INTO chunk_staging (seq, bytes) VALUES (?, ?)", ++chunkSeq, exactBuffer(packBlob(b)));
		};
		const built = { card_count: 0, printing_count: 0, store_bytes: 0 };
		wasm.setHandlers({
			pullRow: lookup,
			onChunk: (b) => {
				for (const chunk of grid.push(b)) stage(chunk);
			},
			onStats: (s) => {
				built.card_count = s.card_count ?? 0;
				built.printing_count = s.printing_count ?? 0;
				built.store_bytes = s.store_bytes ?? 0;
			},
		});
		const buildStart = Date.now();
		const totalBytes = wasm.buildStoreStream();
		wasm.setHandlers({});
		// The tail is unlikely to be a whole grid chunk.
		for (const chunk of grid.end()) stage(chunk);
		const heap = wasm.heap();
		console.log(
			`Store built (partition ${pp.partition}): ${totalBytes} bytes in ${chunkSeq + 1} chunks, ` +
				`${Date.now() - buildStart}ms (wasm heap peak ${(heap.peak / 1048576).toFixed(1)}MB, ` +
				`linear memory ${(heap.linear / 1048576).toFixed(1)}MB)`,
		);
		this.ctx.storage.transactionSync(() => {
			// The partition's build outputs and a zeroed publish cursor, one
			// transition (see recordBuild). built_at and format_version are NOT
			// touched here — they were fixed once at the end of tags, and stamping
			// either per build would fork the key family on a mid-loop restart.
			recordBuild(pp, built.store_bytes, built.card_count, built.printing_count);
			this.savePp(pp);
			this.metaSet("phase", "publish");
		});
		// Release the wasm group NOW rather than after this partition's publish
		// slices (plan B3: dropGroupWasm after each build(p), §5.5
		// emit-one-release-one). Linear memory peaks at 90-106MB per partition and
		// never shrinks, and publish's assembleChunk holds the WHOLE raw partition
		// (up to ~46MB, one chunk since TARGET_PARTITION_BYTES) plus its gzip output
		// — up to ~60MB — which cannot share a 128MB isolate with it. Dropping it
		// here only makes the memory COLLECTABLE; it is reclaimed at the next GC,
		// which is why the gate's wasm fit step fails at 112MB, not at the 124MiB
		// link cap. Publish needs nothing from wasm — the format version has been
		// in meta since tags — and the next partition's agg builds a fresh
		// instance anyway.
		dropGroupWasm();
	}

	// ── phase: publish (KV, per partition) ───────────────────────────────────────
	//
	// Partition p's archive goes to KV as ~2 gzipped chunks under its own key
	// family; the v2 manifest goes up ONCE, after the LAST partition's last
	// chunk — it is the commit point, and until it lands readers keep serving
	// the previous store. Between partitions this phase hands the loop back to
	// `agg` for the next one.
	//
	// Still sliced across alarms, for CPU rather than quota: each slice
	// assembles ONE chunk out of the staged rows and puts it, so no invocation
	// holds more than one chunk or runs long enough to be cut off. All publish
	// progress lives in the ONE pp_publish meta value (see import-publish.ts) —
	// the flat cursor trio this replaces required every restart path to
	// remember every key, and a forgotten one resumed a fresh publish from a
	// stale cursor.

	/** Staging-backed reader for assembleChunk (see src/engine/store-kv.ts). */
	private stagedRows(fromSeq: number, limit: number): StagedRow[] {
		return this.sqlAll("SELECT seq, bytes FROM chunk_staging WHERE seq >= ? ORDER BY seq LIMIT ?", fromSeq, limit).map(
			(row) => ({ seq: Number(row.seq), bytes: unpackBlob(new Uint8Array(row.bytes as ArrayBuffer)) }),
		);
	}

	private async stepPublish(): Promise<void> {
		const pp = this.requirePp();
		const rec = currentRecord(pp);
		const storeKey = this.partitionKey(pp.partition);
		if (!rec.store_bytes) throw new Error(`publish: partition ${pp.partition}'s build recorded no store size`);
		const kvTotal = publishChunkTotal(pp);
		// Say so while there is still room to act. Publish is the one moment that
		// knows the finished size, and a crossing is otherwise invisible — see
		// chunkHeadroom. Gated on each partition's first slice to keep it one
		// line per partition rather than one per chunk.
		if (rec.chunks_published === 0) {
			const warning = chunkHeadroomWarning(rec.store_bytes, rec.cut);
			if (warning) console.warn(warning);
			// First set in stepRouting, before the family's first key; refreshed here
			// per partition so a run that crawls across days keeps its week-long TTL
			// ahead of it. From the routing filter until the manifest write, the
			// family is in flight and no sweep may age it out.
			await this.markPublishing();
		}

		// One chunk per slice. A put that lands but whose marker rolls back (the
		// alarm threw afterwards, the isolate went away) simply re-puts the same
		// key with the same bytes on retry — keys are stable per store, so the
		// write is idempotent and needs no reconciliation.
		if (rec.chunks_published < kvTotal) {
			const want = Math.min(rec.cut, rec.store_bytes - rec.chunks_published * rec.cut);
			const { bytes, cursor } = assembleChunk(want, { seq: rec.cursor_seq, off: rec.cursor_off }, (fromSeq, limit) =>
				this.stagedRows(fromSeq, limit),
			);
			// Compressed HERE, inside the slice that publishes it, so the
			// compression unit is the publish unit and the phase stays resumable
			// across alarms with no extra state: a retry recompresses the same raw
			// cut to the same key, which is the idempotence the raw path already had.
			const stored = await gzipBytes(bytes);
			if (stored.byteLength > KV_VALUE_CAP_BYTES) {
				// rec.cut is the ambitious cut and is safe only while the archive
				// compresses; this is the branch where it did not. Unlike the in-memory
				// publishers there is no re-cutting what is already written, so THIS
				// PARTITION's publish restarts at the cut that needs no assumption
				// about the data (restartAtSafeCut — scoped to the one record; sibling
				// partitions' chunk math is self-contained in their own records).
				// Chunk keys are stable per store, so re-putting from zero is the same
				// idempotent write the retry path already relies on, and the earlier
				// chunks are simply overwritten by their re-cut replacements. THAT IS
				// ONLY SAFE BEFORE THE MANIFEST: readers cache chunk keys for a week
				// and nothing may fetch one until the manifest names it — see the
				// invariant on chunkKey (store-kv.ts).
				//
				// Falling back rather than failing keeps the nightly alive: a store that
				// compresses badly should cost an extra publish pass, not a dark site.
				if (rec.cut !== KV_CHUNK_BYTES_SAFE) {
					console.warn(
						`Publish: partition ${pp.partition} chunk ${rec.chunks_published} compressed to ` +
							`${stored.byteLength} bytes, over KV's ${KV_VALUE_CAP_BYTES} cap at a ${rec.cut}-byte cut — ` +
							`restarting this partition's publish at ${KV_CHUNK_BYTES_SAFE}. ` +
							`This archive compresses worse than KV_CHUNK_BYTES assumes.`,
					);
					this.ctx.storage.transactionSync(() => {
						restartAtSafeCut(pp);
						this.savePp(pp);
					});
					return; // next alarm re-publishes this partition from chunk 0 at the safe cut
				}
				throw new Error(
					`publish: partition ${pp.partition} chunk ${rec.chunks_published} compressed to ` +
						`${stored.byteLength} bytes, over KV's ${KV_VALUE_CAP_BYTES} cap`,
				);
			}
			await this.env.STORE_KV.put(chunkKey(storeKey, rec.chunks_published), stored);
			this.ctx.storage.transactionSync(() => {
				recordChunk(pp, cursor, stored.byteLength);
				this.savePp(pp);
			});
			console.log(
				`Publish slice: KV chunk ${rec.chunks_published}/${kvTotal} (${(want / 1048576).toFixed(1)}MB raw -> ` +
					`${(stored.byteLength / 1048576).toFixed(1)}MB gzip) for ${storeKey}`,
			);
			return; // next alarm continues
		}

		// Every one of this partition's chunks is in KV. Stamp its record and hand
		// the loop to purge_staging, which retires the partition's staging in
		// bounded slices (progressive purge, plan B1/B3: the 5GB pool must never
		// hold two partitions' spill+ordered+chunk staging at once — and the
		// partition's own drafts go too: published means no rewind can ask for
		// them again) and then either advances the loop or moves to the manifest.
		//
		// Until 2026-09-16 the four deletes lived HERE, in this transaction, ~300MB
		// in one commit — and the next alarm's first storage read hung behind its
		// flush for hours, until a deploy reset the object. See import-purge.ts.
		this.ctx.storage.transactionSync(() => {
			completePartitionPublish(pp);
			pp.step = "purge";
			this.savePp(pp);
			this.beginPurge("partition");
		});
		console.log(
			`Partition ${pp.partition} published (${rec.chunk_count} chunk(s)) of ${pp.partitions.length}; ` +
				"purging its staging",
		);
	}

	// ── phase: manifest (every partition published and purged) ────────────────

	/**
	 * Write the manifest LAST — the commit point. Totals at top level, one
	 * record per partition; partition_count and partition_hash are what routers
	 * derive the fan-out and the modulus from (never a constant — plan Decision
	 * 3b). Idempotent: a retry re-puts identical bytes.
	 */
	private async stepManifest(): Promise<void> {
		const pp = this.requirePp();
		const builtAt = this.metaGet("built_at") ?? "";
		const formatVersion = Number(this.metaGet("format_version") ?? 0);
		const sourceUpdatedAt = this.metaGet("source_updated_at") ?? undefined;
		const partitions: StoreManifestPartition[] = pp.partitions.map((p, k) => ({
			store_key: this.partitionKey(k),
			store_bytes: p.store_bytes,
			store_gzip_bytes: p.gzip_bytes,
			chunk_count: p.chunk_count,
			card_count: p.card_count,
			printing_count: p.printing_count,
		}));
		const sum = (f: (p: StoreManifestPartition) => number) => partitions.reduce((t, p) => t + f(p), 0);
		const manifest: StoreManifest = {
			// The FAMILY STEM: no chunks live under it (see StoreManifest.store_key)
			// — readers load through partitions[].
			store_key: storeKeyStem(formatVersion, builtAt),
			built_at: builtAt,
			card_count: sum((p) => p.card_count),
			printing_count: sum((p) => p.printing_count),
			upstream_commit: "vendored", // UPSTREAM.lock is a build-time concern; readers ignore this field
			format_version: formatVersion,
			content_generation: STORE_CONTENT_GENERATION,
			store_bytes: sum((p) => p.store_bytes),
			store_gzip_bytes: sum((p) => p.store_gzip_bytes ?? 0),
			chunk_count: sum((p) => p.chunk_count),
			source_updated_at: sourceUpdatedAt,
			partition_count: pp.partitions.length,
			partition_hash: PARTITION_HASH_ALGO,
			partitions,
		};
		// The manifest is the commit point: the one write where a bug becomes a
		// served outage rather than a failed run. writeManifest refuses a malformed
		// SHAPE; this refuses a manifest whose CHUNKS are gone. Both halves are
		// load-bearing. On 2026-09-15 every partition this run had uploaded was
		// retired by the deploy sweeps that landed during its days-long upload,
		// and the write below went ahead and named them — fifteen hours of 503.
		// The family cannot be re-uploaded (each partition's staging rows are
		// dropped the moment it publishes), so the honest outcome is a failed run
		// and a fresh start on the next cron, with the previous manifest untouched.
		// The alias map goes BEFORE the manifest, like the chunks and the routing filter: the
		// manifest is the commit point, and a reader that finds the manifest must find the map its
		// build resolves through. Idempotent, like the manifest put. Absent only for a run whose
		// tags phase predates the export (a deploy landed mid-run); that build serves alias
		// spellings as plain slugs until the next run, and the Worker says so in its log.
		const tagAliasesJson = this.metaGet("tag_aliases");
		if (tagAliasesJson) {
			await writeTagAliases(this.env, formatVersion, builtAt, tagAliasesJson);
			console.log(`Tag aliases published: ${tagAliasesKey(formatVersion, builtAt)} (${tagAliasesJson.length} bytes)`);
		} else {
			console.warn(
				`Tag aliases NOT published for build ${builtAt}: this run's tags phase stashed none. ` +
					"Alias tag spellings match nothing on this build; the next run publishes them.",
			);
		}
		const present = await this.listFamilyKeys(formatVersion, builtAt);
		// A `list` is eventually consistent and can lag a key this run put a minute ago; a `get` of
		// that key is not. The refusal below guards against a SWEEP having deleted chunks, which a
		// direct read sees as absent too — so anything the list did not show is asked for directly
		// before it counts as gone. This used to be safe only because the last partition's purge
		// slices happened to interpose minutes between the last chunk put and this check.
		const unlisted = missingManifestChunks(manifest, present);
		const missing: string[] = [];
		for (const key of unlisted) {
			const value = await this.env.STORE_KV.get(key, { type: "stream" });
			if (value === null) missing.push(key);
			else await value.cancel();
		}
		if (missing.length > 0) {
			const shown = missing.slice(0, 3).join(", ") + (missing.length > 3 ? `, … +${missing.length - 3}` : "");
			throw new FatalImportError(
				`publish: refusing to write the manifest for ${manifest.store_key}: ${missing.length} chunk(s) it ` +
					`names are no longer in KV (${shown}). Retention retired them while this run was still ` +
					`uploading; the live manifest keeps serving and the next run starts over.`,
			);
		}
		// The blocks the nightly decides and every publish carries (StoreManifest.cache): read the
		// live manifest once, decide from it and tonight's measurements, write them in.
		const previous = await this.liveManifestJson();
		const placement = await this.placementGate(manifest, previous);
		if (placement) manifest.placement = placement;
		manifest.cache = await this.cacheGate(manifest, previous);
		await writeManifest(this.env, manifest);
		// Published: a manifest names the family now, and the manifest read inside
		// every sweep protects it from here. The in-flight marker has done its job.
		await this.releasePublishing();

		// Retention: keep the newest KEEP_STORES_IN_KV builds, decided from the keys that are actually in
		// KV. The predecessor stays addressable so a reader mid-stream finishes and a bad build can
		// be rolled back by republishing the older manifest. A partitioned build's N chunk families
		// share one built_at and retire together (see staleStoreKeys).
		//
		// This used to read a history list out of `meta` — which `metaClear()` wipes at the start of
		// every run, so the list was always empty and NOTHING was ever deleted. Production reached 15
		// store builds and 3 residue builds, ~510MB of a 1GB namespace, before anyone counted. A
		// sweep derived from the keys themselves cannot drift from what is there, and it heals a
		// namespace that already leaked.
		await this.pruneOldStores(builtAt || undefined);

		// The store is LIVE from here — every reader that reads the manifest from
		// now on gets it. What is left is the edge cache, which still holds
		// answers computed from the store this one replaced; `purge` clears them
		// once the readers have caught up.
		console.log(
			`Store published to KV: ${manifest.store_key} (${manifest.card_count} cards, ` +
				`${manifest.partition_count} partition(s), ${manifest.chunk_count} chunks)`,
		);
		this.ctx.storage.transactionSync(() => {
			// What the run record's `detail` will say once the run is done.
			this.metaSet(
				"run_summary",
				`published ${manifest.store_key} (${manifest.card_count} cards, ${manifest.partition_count} partitions)`,
			);
			// `notify` comes FIRST, before rulings and reference: it is what puts the
			// readers on the new store, and everything after it is additional KV data
			// rather than a reason to keep serving the old archive.
			this.metaSet("phase", "notify");
			this.metaSet("rulings_bucket_cursor", "0");
			this.metaSet("rulings_attempts", "0");
			this.metaSet("reference_step", "sets");
			this.metaSet("purges_done", "0");
		});
	}

	// ── phase: placement (g1's nightly probes) ─────────────────────────────────

	/**
	 * Probe where an object created with each location hint lands tonight: PROBES_PER_HINT
	 * throwaway PlacementProbe objects per hint (placement-probe.ts), 44 Durable Object requests in
	 * all, each bounded by PROBE_ANSWER_MS. BEFORE the manifest step, so tonight's answers go
	 * straight into tonight's manifest (placementGate) with no key of their own.
	 *
	 * Never fails the run: a probe that does not answer is absent from its hint's list, and the
	 * policy leaves a hint with no answers exactly as it was. Idempotent across a retried slice:
	 * the answers are kept in meta and the probes are not re-run.
	 */
	private async stepPlacement(): Promise<void> {
		if (this.metaGet("placement_probes") === null) {
			const t0 = Date.now();
			let probes: Partial<Record<DurableObjectLocationHint, string[]>> = {};
			try {
				probes = await probeHints(this.env, REGION_HINTS);
			} catch (err) {
				console.warn(`Placement probes failed (${err}); tonight's placement stays as it is`);
			}
			this.metaSet("placement_probes", JSON.stringify(probes));
			const answered = Object.values(probes).reduce((n, colos) => n + (colos?.length ?? 0), 0);
			console.log(
				`Placement probes: ${answered} answered in ${Date.now() - t0}ms — ` +
					REGION_HINTS.map((h) => `${h} ${(probes[h] ?? []).join(",") || "-"}`).join("; "),
			);
		}
		this.metaSet("phase", "manifest");
	}

	/**
	 * g1: tonight's placement block — the previous manifest's, advanced by tonight's probes
	 * (nextPlacement). Returns undefined when there was no block and the night changed nothing, so
	 * the manifest keeps reading as the seed.
	 *
	 * The pool guard for a flip-back: a fresh generation is one more region of caches, so it is
	 * allowed only if the pool with one more replica still fits under the gate's OFF threshold at
	 * gzip — the codec gate that runs next then decides whether LZ4 still fits too.
	 */
	private async placementGate(
		manifest: StoreManifest,
		previous: StoreManifest | null,
	): Promise<PlacementBlock | undefined> {
		let probes: Partial<Record<DurableObjectLocationHint, string[]>> = {};
		try {
			probes = JSON.parse(this.metaGet("placement_probes") ?? "{}");
		} catch {
			probes = {};
		}
		const before = previous?.placement;
		const replicas = new Set(REGION_HINTS.map((h) => effectiveRegion(h, before))).size + 1;
		const meters = parseMeters(this.metaGet("run_meters"));
		const mayBump =
			projectCachePool({
				replicas,
				partitionGzipBytes: (manifest.partitions ?? []).map((p) => p.store_gzip_bytes ?? 0),
				cacheFactor: 1,
				stagingPeakBytes: meters?.peak_db_bytes || STAGING_PEAK_BYTES_2026_09_25,
				strandedBytes: 0,
			}) <=
			LZ4_OFF_FRACTION * POOL_GATE_BUDGET_BYTES;
		const decision = nextPlacement({
			previous: before,
			probes,
			continentOf: continentOfColo,
			builtAt: manifest.built_at,
			hints: REGION_HINTS,
			mayBump,
		});
		const aliases = REGION_HINTS.filter((h) => effectiveRegion(h, decision.placement) !== h)
			.map((h) => `${h}→${effectiveRegion(h, decision.placement)}`)
			.join(", ");
		console.log(
			`Placement: ${decision.held ? "held" : "decided"}; aliases ${aliases || "none"}` +
				`${decision.changes.length ? ` — ${decision.changes.join("; ")}` : ""}`,
		);
		return decision.placement;
	}

	/** The manifest KV serves right now, parsed, or null — never a throw: the gates fall back to defaults. */
	private async liveManifestJson(): Promise<StoreManifest | null> {
		try {
			return JSON.parse(
				(await this.env.STORE_KV.get(MANIFEST_KEY, { type: "text" })) ?? "null",
			) as StoreManifest | null;
		} catch (err) {
			console.warn(`Manifest gates: could not read the live manifest (${err}); deciding from defaults`);
			return null;
		}
	}

	/**
	 * r3's pool gate: may engine objects cache THIS build as LZ4?
	 *
	 * Every input is measured or read, none guessed: the replica groups that will hold a cache
	 * (every routable region's shard 0, plus every shard announced right now — one KV list), this
	 * build's partition sizes, this run's own databaseSize high-water mark, and one such mark per
	 * watchdog failover in the last day for the staging a replaced coordinator may still hold.
	 * What it cannot see is an object holding storage WITHOUT an announcement (released objects
	 * delete theirs together with their storage, so only a hand-deleted key would be one).
	 *
	 * Hysteresis state is the PREVIOUS manifest's codec, not the coordinator's meta table, which a
	 * run start clears and a failover starts empty.
	 */
	private async cacheGate(manifest: StoreManifest, previous: StoreManifest | null): Promise<StoreManifestCache> {
		// g1: a hint aliased to another region holds no cache of its own (its objects are retired at
		// this publish's notify), so only the regions requests can actually reach count.
		const routable = new Set<string>(REGION_HINTS.map((h) => effectiveRegion(h, manifest.placement)));
		const groups = new Set([...routable].map((r) => `${r}/0`));
		try {
			for (const key of await this.listAllKeys(REGION_LIVE_PREFIX)) {
				const parsed = parseEngineName(key.slice(REGION_LIVE_PREFIX.length));
				if (parsed && routable.has(parsed.region) && !unreachableEngine(parsed, manifest.placement)) {
					groups.add(`${parsed.region}/${parsed.shard}`);
				}
			}
		} catch (err) {
			console.warn(`Pool gate: could not list the announced objects (${err}); counting one replica per region`);
		}
		const meters = parseMeters(this.metaGet("run_meters"));
		// Unsampled only for a run that began before this shipped: the 2026-09-25 measured peak, scaled
		// by the store. Staging is written with a 1% margin for tomorrow's slightly larger corpus.
		const staging =
			(meters?.peak_db_bytes || (STAGING_PEAK_BYTES_2026_09_25 * (manifest.store_bytes ?? 0)) / 425_181_152) * 1.01;
		const pointer = await readPointer(this.env.STORE_KV).catch(() => null);
		const failovers = (pointer?.failovers ?? []).filter((t) => Date.now() - t < 24 * 3600_000).length;
		const projected = projectCachePool({
			replicas: groups.size,
			partitionGzipBytes: (manifest.partitions ?? []).map((p) => p.store_gzip_bytes ?? 0),
			cacheFactor: LZ4_CACHE_RATIO,
			stagingPeakBytes: staging,
			strandedBytes: failovers * staging,
		});
		const was = previous?.cache?.v === 1 ? previous.cache.codec : undefined;
		const codec = decideCacheCodec(was, projected);
		console.log(
			`Pool gate: ${groups.size} cache replica(s), staging ${(staging / 1e9).toFixed(2)}GB, ${failovers} ` +
				`failover(s) today; LZ4 projection ${(projected / 1e9).toFixed(2)}GB of ` +
				`${(POOL_GATE_BUDGET_BYTES / 1e9).toFixed(1)}GB → cache codec ${codec}` +
				`${codec !== (was ?? "gzip") ? ` (was ${was ?? "gzip"})` : ""}`,
		);
		return { v: 1, codec, projected_lz4_bytes: Math.round(projected) };
	}

	// ── phase: notify (push the new store to every region) ─────────────────────

	/**
	 * Tell every region's engine DO that a new store is live, and release the
	 * storage held by shards that are no longer in the fan-out.
	 *
	 * This replaces readers polling. Convergence used to be a 5-minute manifest
	 * re-check inside each live DO, which nothing could observe — so the purge
	 * phase was built around not being able to see it: a 10-minute delay sized to
	 * outlast the poll plus KV's 60s manifest cache, and then a SECOND pass to
	 * catch a colo that had not polled during the first. Both are gone. Pushing
	 * makes convergence an event, and the run advances when the event has happened
	 * rather than when a clock says it probably has.
	 *
	 * ALL LIVE OBJECTS ARE TOLD UNCONDITIONALLY, in parallel. A cold one
	 * answers instantly without loading anything (see SearchEngine.notifyPublish),
	 * so this does not wake idle regions into holding a full store, and
	 * scale-to-zero survives. The coordinator's own CPU here is negligible: the
	 * work happens inside the objects being called.
	 *
	 * TWO-STEP, PREPARE THEN COMMIT (plan B5). With N partitions per region a
	 * one-step swap gives each object its own multi-second prefetch window, and
	 * the windows do not line up — a fan-out query pinned to one generation
	 * could meet regions serving different stores for as long as the slowest
	 * prefetch takes. So the phase first calls `preparePublish` on EVERY live
	 * object (prefetch all announced archives into local storage, no swap),
	 * waits for ALL of them to acknowledge, and only then calls `commitPublish`
	 * (the swap itself — local, sub-second). The mixed-generation window
	 * shrinks from "slowest prefetch" to "commit fan-out spread".
	 *
	 * The DO side currently implements both names as a COMPATIBILITY SHIM over
	 * today's single-step notifyPublish (prepare records+swaps, commit is an
	 * ack — see search-engine-do.ts); the real prefetch-no-swap lands with the
	 * partitioned loader (task 9). This coordinator already speaks the final
	 * protocol either way.
	 *
	 * A failure at either step re-runs the whole phase. That is safe because
	 * every RPC is idempotent — preparing an object that already holds the
	 * archives is a local no-op, committing an object that already swapped
	 * reports `swapped: false`, and releasing an empty cache does nothing.
	 */
	private async stepNotify(): Promise<void> {
		// Hand the manifest over rather than making each object read it back out of KV. That read is
		// ~124ms and it is paid IN FRONT OF whatever requests arrive during the swap, for a value
		// this phase just wrote at the one manifest key.
		const published = JSON.parse((await this.env.STORE_KV.get(MANIFEST_KEY, { type: "text" })) ?? "null");

		// ONLY OBJECTS THAT ALREADY EXIST. An engine announces itself under
		// REGION_LIVE_PREFIX when it loads a store, so this set is exactly the objects a real
		// request has created — at the edge, in the right region.
		//
		// The alternative was walking every possible name, which CREATES the ones that do not exist
		// yet, from inside this Durable Object. `locationHint` fixes an object's region at creation,
		// so that would place engine-apac relative to a hint the coordinator supplied rather than by
		// a request from apac. Honoured, it is merely wasteful; not honoured, it is permanent.
		const announced = [...(await this.listAllKeys(REGION_LIVE_PREFIX))].map((name) =>
			name.slice(REGION_LIVE_PREFIX.length),
		);
		// g1: objects no request can reach any more — their hint is aliased to another region's
		// objects, or their generation is not the hint's current one — are RETIRED here instead of
		// prepared: storage released and announcement deleted together, exactly as a stale shard is
		// below, and without first prefetching a build into them. An isolate still holding the
		// previous manifest (its memo is 60s) may re-create one; it announces itself on load and the
		// next notify retires it again.
		// Also the pre-partitioning single-store region objects (notifyRetireReason): announced
		// long ago, addressed by nothing, and each one logged a refusal at ERROR every night.
		const reasons = new Map<string, string>();
		for (const name of announced) {
			const parsed = parseEngineName(name);
			const reason = parsed === null ? null : notifyRetireReason(parsed, published as StoreManifest | null);
			if (reason) reasons.set(name, reason);
		}
		const retire = [...reasons.keys()];
		const live = announced.filter((name) => !retire.includes(name));
		if (retire.length > 0) {
			const gone = await Promise.allSettled(
				retire.map(async (name) => {
					await (
						addressAnnouncedEngine(this.env, name) as unknown as { releaseCache(): Promise<unknown> }
					).releaseCache();
					await this.env.STORE_KV.delete(`${REGION_LIVE_PREFIX}${name}`);
				}),
			);
			const failed = retire.filter((_, i) => gone[i]?.status === "rejected");
			console.log(
				`Publish notify: retired ${retire.length - failed.length}/${retire.length} object(s) no request can reach ` +
					`(${retire.map((n) => `${n}: ${reasons.get(n)}`).join(", ")})` +
					(failed.length > 0 ? `; ${failed.length} left announced, retried at the next publish` : ""),
			);
		}
		if (live.length === 0) {
			// Nothing has ever loaded a store, so there is nobody to tell. Not an error: it is the
			// state of a fresh deployment, and the first real request will read the manifest from KV.
			console.log("Publish notify: no live engine objects to notify");
			this.metaSet("phase", "rulings");
			return;
		}

		// `addressAnnouncedEngine` is the half of the engine namespace that has no power to place an
		// object: it passes no locationHint, so even a name that turned out not to exist would be
		// created wherever the platform chose rather than somewhere this Durable Object named. Every
		// name here belongs to an object that announced itself, so the hint would be ignored anyway;
		// the point is that this phase could not misplace one if the live set were wrong.
		const stubFor = (name: string) =>
			addressAnnouncedEngine(this.env, name) as unknown as {
				preparePublish(m?: unknown): Promise<{ prepared: boolean; shards: number }>;
				commitPublish(): Promise<{ swapped: boolean; shards: number }>;
				releaseCache(): Promise<unknown>;
			};

		// Step 1: PREPARE everywhere, and require every ack before any commit.
		// This is the barrier that shrinks the mixed-generation window: no object
		// swaps until every object holds the new archives locally.
		// BOUNDED all-or-retry. A failed barrier is thrown so the phase retries from prepare — the
		// purge below must not run while a reader might still be serving the old store, or it
		// empties the cache straight into a stale answer that then stands for up to 16 hours, and
		// objects that already acked re-ack from their local copy for free. But only up to
		// NOTIFY_MAX_ATTEMPTS: past that the store is live and the objects that never answered are
		// not going to, so the phase proceeds with the acks it has, and the stragglers converge on
		// KV's manifest at their next cold load.
		const attempt = Number(this.metaGet("notify_attempts") ?? 0) + 1;
		const barrier = (step: string, failures: string[]): void => {
			if (failures.length === 0) return;
			this.metaSet("notify_attempts", String(attempt));
			if (attempt < NOTIFY_MAX_ATTEMPTS) {
				throw new Error(
					`notify: ${failures.length}/${live.length} object(s) failed to ${step}: ${failures.join("; ")}`,
				);
			}
			console.error(
				`notify: ${failures.length}/${live.length} object(s) still failed to ${step} on attempt ` +
					`${attempt}/${NOTIFY_MAX_ATTEMPTS}; proceeding with the objects that acked — the rest read the ` +
					`manifest from KV on their next cold load: ${failures.join("; ")}`,
			);
		};

		const prepared = await Promise.allSettled(
			live.map(async (name) => ({ name, ...(await stubFor(name).preparePublish(published)) })),
		);
		barrier(
			"prepare",
			prepared.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : [])),
		);
		const preparedNames = prepared.flatMap((r) => (r.status === "fulfilled" ? [r.value.name] : []));

		// Step 2: COMMIT everywhere that prepared. Same bounded posture — a commit that reached some
		// objects and not others is the mixed window again, and re-running both steps is safe
		// because both are idempotent.
		const results = await Promise.allSettled(
			preparedNames.map(async (name) => ({ name, ...(await stubFor(name).commitPublish()) })),
		);
		barrier(
			"commit",
			results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : [])),
		);
		const acked = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

		// Widths are reported by each region's shard 0, which is the rendezvous every isolate in that
		// region reports to and therefore the only object that knows the fan-out. Partitioned names
		// parse through the shared helpers: every `engine-<region>[-<n>]-p<k>` partition of one
		// replica is ONE member of the fan-out (`replicaGroupOf`), so a shard-0 partition object
		// reports its region's width and a retired replica releases ALL its partitions together.
		const widthOf = new Map<string, number>();
		for (const a of acked) {
			const parsed = parseEngineName(a.name);
			const group = replicaGroupOf(a.name);
			if (parsed?.shard === 0 && group !== null) widthOf.set(group, Math.max(1, Math.floor(a.shards)));
		}

		// Shards at or above their region's fan-out give their cached archives back. Scale-in is
		// eviction, which was free while a shard held nothing in storage; with the archive cache an
		// abandoned engine-wnam-3 would keep one compressed partition per `-p<k>` object forever,
		// and their own prune never runs again because they never load again. Width keys are the
		// REGION's shard-0 group, so a shard's own group is not its width key — the region prefix is.
		const stale = acked.filter((a) => {
			const parsed = parseEngineName(a.name);
			if (!parsed || parsed.shard === 0) return false;
			const regionGroup = engineName(parsed.region as DurableObjectLocationHint, 0, undefined, parsed.generation);
			return parsed.shard >= ((regionGroup !== null ? widthOf.get(regionGroup) : undefined) ?? 1);
		});
		// Release the storage AND retire the announcement together. Deleting only the
		// storage would leave `engine:live:<name>` behind, so the next publish would
		// find the name in the live set, address it, and RECREATE the object — which
		// is precisely the "the publisher creates objects" property this fan-out was
		// rewritten to remove, reintroduced through the announcement instead of the
		// name list. A resurrected shard would then record a manifest row, gain
		// storage, and stop being reclaimable.
		const released = await Promise.allSettled(
			stale.map(async (a) => {
				await stubFor(a.name).releaseCache();
				await this.env.STORE_KV.delete(`${REGION_LIVE_PREFIX}${a.name}`);
			}),
		);

		console.log(
			`Publish notified ${acked.length} live engine object(s); ` +
				`${acked.filter((a) => a.swapped).length} swapped, ` +
				`${released.filter((r) => r.status === "fulfilled").length}/${stale.length} released stale storage`,
		);
		this.metaSet("phase", "rulings");
	}

	// ── phase: rulings (KV) ────────────────────────────────────────────────────
	//
	// The rulings dump becomes 256 KV buckets of pre-rendered Ruling objects, keyed by the first
	// byte of the oracle id — the layout, and why it is a layout rather than a table, is in
	// src/engine/rulings-kv.ts. This phase is the only writer.
	//
	// It runs AFTER publish and cannot fail the run (see RULINGS_MAX_ATTEMPTS). Bucket keys are
	// stable across imports, so "this night's rulings did not land" degrades to "last night's are
	// still served" rather than to a hole.
	//
	// Only buckets whose bytes MOVED are written. Rulings drift slowly — new cards and the
	// occasional retraction — so a normal night is a handful of writes against the free plan's
	// 1,000/day, where rewriting the set unconditionally would spend a quarter of the day's
	// allowance every night to republish bytes KV already holds.

	private async stepRulings(): Promise<void> {
		try {
			await this.rulingsSlice();
		} catch (err) {
			const attempts = Number(this.metaGet("rulings_attempts") ?? 0) + 1;
			this.metaSet("rulings_attempts", String(attempts));
			// A daily KV write quota is the one failure this phase can plausibly cause: a first
			// publish is 256 writes. Backoff cannot clear it before midnight, and rethrowing would
			// take the alarm chain's quota branch, which FAILS THE RUN — stranding a store that is
			// already live with its `purge` unrun, so the edge would keep serving the previous
			// store's answers for up to 16 hours. Give up on the rulings instead.
			if (attempts < RULINGS_MAX_ATTEMPTS && !isQuotaError(err)) throw err; // ordinary retry
			console.error(
				`Rulings publish gave up after ${attempts} attempt(s); the previously published buckets ` +
					`stay served and the next import retries: ${err}`,
			);
			this.metaSet("phase", "reference");
		}
	}

	/** One slice: build and publish RULINGS_SLICE_BUCKETS buckets, then advance the cursor. */
	private async rulingsSlice(): Promise<void> {
		const from = Number(this.metaGet("rulings_bucket_cursor") ?? 0);
		if (from === 0) await this.resetRulingsIfUnpublished();
		const to = Math.min(from + RULINGS_SLICE_BUCKETS, RULINGS_BUCKET_COUNT);

		const inRange = new Map<number, RulingRow[]>();
		let lines = 0;
		let valid = 0;
		for await (const line of this.stagedLines("rulings")) {
			if (line.trim().length === 0) continue;
			lines += 1;
			const row = parseRulingLine(line);
			if (row === null) continue;
			valid += 1;
			const bucket = rulingsBucketOf(row.oracle_id);
			if (bucket === null || bucket < from || bucket >= to) continue;
			const group = inRange.get(bucket);
			if (group) group.push(row);
			else inRange.set(bucket, [row]);
		}

		// Coverage check, in the spirit of the transform phase's: entries that carry every field
		// upstream's `_valid_rulings` requires are dropped silently one at a time, so a renamed key
		// would otherwise publish 256 empty buckets and read as "no card has any rulings".
		if (lines > 0 && valid < PARSE_COVERAGE_THRESHOLD * lines) {
			throw new Error(`rulings dump: only ${valid} of ${lines} entries are usable; format changed?`);
		}

		let written = 0;
		let unchanged = 0;
		const pending: (() => Promise<void>)[] = [];
		for (let bucket = from; bucket < to; bucket++) {
			const { bytes, rulingCount } = encodeRulingsBucket(inRange.get(bucket) ?? []);
			const hash = await sha256Hex(bytes);
			const known = this.sqlAll<{ hash: string }>("SELECT hash FROM rulings_buckets WHERE bucket = ?", bucket)[0];
			if (known && String(known.hash) === hash) {
				unchanged += 1;
				continue;
			}
			written += 1;
			pending.push(async () => {
				await this.env.STORE_KV.put(rulingsBucketKey(bucket), bytes);
				// AFTER the put, never with it: a hash recorded for bytes that never reached KV would
				// make every later import skip the bucket it most needs to write.
				this.sqlRun(
					"INSERT OR REPLACE INTO rulings_buckets (bucket, hash, rulings) VALUES (?, ?, ?)",
					bucket,
					hash,
					rulingCount,
				);
			});
		}
		for (let at = 0; at < pending.length; at += RULINGS_PUT_CONCURRENCY) {
			await Promise.all(pending.slice(at, at + RULINGS_PUT_CONCURRENCY).map((put) => put()));
		}

		console.log(
			`Rulings slice: buckets ${from}-${to - 1}, ${written} written, ${unchanged} already current ` +
				`(${valid}/${lines} entries usable)`,
		);

		if (to < RULINGS_BUCKET_COUNT) {
			this.metaSet("rulings_bucket_cursor", String(to));
			return; // next alarm continues
		}

		// The set is complete — record it. Written LAST, like the store manifest, and for the same
		// reason: it is what a later run reads to decide the published set is really there.
		const total = Number(
			this.sqlAll<{ n: number }>("SELECT COALESCE(SUM(rulings), 0) AS n FROM rulings_buckets")[0]?.n ?? 0,
		);
		const meta: RulingsMeta = {
			format_version: RULINGS_FORMAT_VERSION,
			content_generation: RULINGS_CONTENT_GENERATION,
			bucket_count: RULINGS_BUCKET_COUNT,
			built_at: this.metaGet("built_at") ?? "",
			ruling_count: total,
		};
		await this.env.STORE_KV.put(RULINGS_META_KEY, JSON.stringify(meta));
		await this.pruneOldKeys(RULINGS_KEY_PREFIX, rulingsCurrentPrefix(), "rulings");
		this.metaSet("phase", "reference");
		console.log(`Rulings published to KV: ${total} rulings across ${RULINGS_BUCKET_COUNT} buckets`);
	}

	/**
	 * Forget every recorded bucket hash unless KV still describes the set they belong to.
	 *
	 * The hashes are an optimization built on an assumption — that KV still holds what this DO last
	 * put there — and a recreated namespace (which the deploy repairs by id, see
	 * scripts/align-kv-binding.ts) or a format bump breaks it. Both show up as a missing or
	 * mismatched meta key, and so does a content generation this build no longer renders — all
	 * three want the same answer: publish all 256 again.
	 */
	private async resetRulingsIfUnpublished(): Promise<void> {
		const published = (await this.env.STORE_KV.get(RULINGS_META_KEY, "json")) as RulingsMeta | null;
		if (
			published &&
			published.format_version === RULINGS_FORMAT_VERSION &&
			published.content_generation === RULINGS_CONTENT_GENERATION &&
			published.bucket_count === RULINGS_BUCKET_COUNT
		) {
			return;
		}
		const known = Number(this.sqlAll<{ n: number }>("SELECT COUNT(*) AS n FROM rulings_buckets")[0]?.n ?? 0);
		this.sqlRun("DELETE FROM rulings_buckets");
		if (known > 0) {
			console.warn(`Rulings: KV holds no current bucket set; republishing all ${RULINGS_BUCKET_COUNT}`);
		}
	}

	// ── phase: reference (KV) ──────────────────────────────────────────────────
	//
	// The `/sets`, `/catalog/*` and `/symbology` data (upstream #922). Unlike everything above it,
	// this is NOT bulk data: Scryfall publishes it as ordinary API responses, small enough to fetch
	// whole — 1,047 sets, twenty catalogs, 84 symbols, ~1.65MB rendered. So this phase talks to
	// api.scryfall.com directly rather than to the dump mirror, and renders response bodies into KV
	// (see src/engine/reference-kv.ts).
	//
	// Same posture as `rulings`, for the same reason: it runs after the store is published, nothing
	// else reads what it writes, and it cannot fail the run. Upstream draws the line in the same two
	// places — a failure between the three steps still lets the others run, and a single catalog
	// that fails keeps its previous value rather than being written empty, because nineteen fresh
	// catalogs and one stale one beats one that claims Magic has no creature types.
	//
	// One slice per step (sets, catalogs, symbology), so no invocation holds more than one dataset
	// or runs long enough to be cut off.

	private async stepReference(): Promise<void> {
		const step = this.metaGet("reference_step") ?? "sets";
		try {
			if (step === "sets") await this.referenceSets();
			else if (step === "catalogs") await this.referenceCatalogs();
			else await this.referenceSymbology();
		} catch (err) {
			// Per STEP, not per phase: a failed `sets` fetch must not cost the catalogs their
			// refresh. The step is marked done either way and the chain moves on; what it wrote
			// last import stays served.
			console.error(`Reference ${step} failed; the previously published values stay served: ${err}`);
			this.advanceReference(step);
			return;
		}
	}

	/** Move to the next reference step, or out of the phase when there is none. */
	private advanceReference(step: string): void {
		if (step === "sets") this.metaSet("reference_step", "catalogs");
		else if (step === "catalogs") this.metaSet("reference_step", "symbology");
		else this.metaSet("phase", "purge");
	}

	/**
	 * Delete every store build but the newest KEEP_STORES_IN_KV, plus the one just published,
	 * plus the build the live manifest points at.
	 *
	 * The manifest read is protection against age alone deciding: a family the
	 * live manifest references is a family the serving path depends on, whatever
	 * its timestamp says.
	 *
	 * Note what this sweep collects for free: the orphaned pre-partition chunk
	 * family. Its keys have no `-p<k>` suffix, staleStoreKeys' pattern matches
	 * suffix-less families too, and no manifest names it any more — so it groups
	 * by its own built_at, ages out of the newest-KEEP set, and goes.
	 *
	 * One list operation, one manifest read, and however many deletes are owed;
	 * best effort, because a chunk that will not delete costs storage and gets
	 * another chance next publish, and losing a completed publish over cleanup
	 * would be the worse trade.
	 */
	private async pruneOldStores(currentBuiltAt: string | undefined): Promise<void> {
		try {
			const names: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await this.env.STORE_KV.list({ prefix: "store:card-", cursor });
				names.push(...page.keys.map((k) => k.name));
				cursor = page.list_complete ? undefined : page.cursor;
			} while (cursor);

			const protect: string[] = currentBuiltAt ? [currentBuiltAt] : [];
			try {
				const live = JSON.parse((await this.env.STORE_KV.get(MANIFEST_KEY, { type: "text" })) ?? "null") as {
					built_at?: unknown;
				} | null;
				if (live?.built_at) protect.push(String(live.built_at));
			} catch {
				// An unreadable manifest protects nothing extra; the newest-KEEP
				// rule still holds and the next publish gets another chance.
			}

			let removed = 0;
			for (const key of staleStoreKeys(names, KEEP_STORES_IN_KV, protect)) {
				await this.env.STORE_KV.delete(key);
				removed += 1;
			}
			if (removed > 0) console.log(`Retention: dropped ${removed} chunk(s) from superseded store builds`);
		} catch (err) {
			console.warn(`Retention: could not prune old store builds: ${err}`);
		}
	}

	/**
	 * Delete the keys a previous LAYOUT version of a dataset left behind.
	 *
	 * Called after the meta key, which is the commit point: pruning first would leave a window in
	 * which neither version is complete. Best effort — a key that will not delete costs a few KB of
	 * a 1GB namespace and gets another chance next publish, and losing a finished publish over
	 * cleanup would be the worse trade.
	 */
	private async pruneOldKeys(prefix: string, currentPrefix: string, label: string): Promise<void> {
		try {
			let cursor: string | undefined;
			let removed = 0;
			do {
				const page = await this.env.STORE_KV.list({ prefix, cursor });
				for (const key of staleKeys(
					page.keys.map((k) => k.name),
					prefix,
					currentPrefix,
				)) {
					await this.env.STORE_KV.delete(key);
					removed += 1;
				}
				cursor = page.list_complete ? undefined : page.cursor;
			} while (cursor);
			if (removed > 0) console.log(`Retention: dropped ${removed} ${label} key(s) from an older layout`);
		} catch (err) {
			console.warn(`Retention: could not prune old ${label} keys: ${err}`);
		}
	}

	/**
	 * GET one api.scryfall.com endpoint as JSON, paced.
	 *
	 * Scryfall asks for 50-100ms between requests and rate-limits callers who ignore it. The
	 * catalogs step makes twenty in a row, which is exactly the burst that ask exists for — and a
	 * 429 here would cost a catalog its refresh for the night. The delay goes BEFORE the request
	 * rather than after, so no caller can skip it by returning early, and the first call in a slice
	 * pays it too: slices are separate alarm invocations, and this object cannot see how recently
	 * the previous one finished.
	 */
	private async fetchScryfallJson(path: string): Promise<{ payload: Record<string, unknown>; raw: string[] }> {
		await scheduler.wait(SCRYFALL_REQUEST_DELAY_MS);
		const base = (this.env as { SCRYFALL_API_URL?: string }).SCRYFALL_API_URL ?? SCRYFALL_API_URL;
		const res = await fetch(`${base}/${path}`, {
			headers: { "User-Agent": userAgent(), Accept: "application/json" },
		});
		if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
		// The raw text is what gets stored: these routes serve what Scryfall sent, down to how it
		// wrote its numbers (`"mana_value":0.0` is a decimal, and JavaScript cannot re-emit that).
		// The parsed copy only supplies the lookup keys.
		const text = await res.text();
		return { payload: JSON.parse(text) as Record<string, unknown>, raw: rawArrayElements(text) };
	}

	/**
	 * Put one reference value, unless KV already holds these exact bytes.
	 *
	 * Same hash table as the rulings buckets and the same reasoning: these change rarely — a set
	 * list moves when a set is announced, a catalog when a card is spoiled — so writing all 38
	 * values nightly would spend the free plan's KV budget republishing bytes KV already has.
	 */
	private async putReferenceValue(key: string, value: string | Uint8Array): Promise<boolean> {
		const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
		const hash = await sha256Hex(bytes);
		const known = this.sqlAll<{ hash: string }>("SELECT hash FROM reference_values WHERE key = ?", key)[0];
		if (known && String(known.hash) === hash) return false;
		await this.env.STORE_KV.put(key, bytes);
		this.sqlRun("INSERT OR REPLACE INTO reference_values (key, hash) VALUES (?, ?)", key, hash);
		return true;
	}

	private async referenceSets(): Promise<void> {
		const { payload, raw } = await this.fetchScryfallJson("sets");
		const sets = (payload.data ?? []) as Record<string, unknown>[];
		if (!Array.isArray(sets) || sets.length === 0) throw new Error("/sets answered no data");
		const { list, buckets, setCount } = renderSets(sets, raw);
		let written = (await this.putReferenceValue(setsListKey(), list)) ? 1 : 0;
		for (let bucket = 0; bucket < buckets.length; bucket++) {
			if (await this.putReferenceValue(setsBucketKey(bucket), buckets[bucket] as Uint8Array)) written += 1;
		}
		this.ctx.storage.transactionSync(() => {
			this.metaSet("reference_set_count", String(setCount));
			this.advanceReference("sets");
		});
		console.log(`Reference sets: ${setCount} sets, ${written} of ${buckets.length + 1} values written`);
	}

	private async referenceCatalogs(): Promise<void> {
		const counts: Record<string, number> = JSON.parse(this.metaGet("reference_catalogs") ?? "{}");
		let written = 0;
		let failed = 0;
		for (const name of CATALOG_NAMES) {
			try {
				const { payload, raw } = await this.fetchScryfallJson(`catalog/${name}`);
				const values = payload.data;
				if (!Array.isArray(values)) throw new Error("no data array");
				const { json, count } = renderCatalog(values, raw);
				if (await this.putReferenceValue(catalogKey(name), encodeCountedArray(json, count))) written += 1;
				counts[name] = count;
			} catch (err) {
				// Upstream's rule: one catalog that cannot be fetched keeps its previous value.
				console.warn(`Reference catalog ${name} could not be fetched; keeping the previous one: ${err}`);
				failed += 1;
			}
		}
		this.ctx.storage.transactionSync(() => {
			this.metaSet("reference_catalogs", JSON.stringify(counts));
			this.advanceReference("catalogs");
		});
		console.log(`Reference catalogs: ${written} written, ${failed} kept from last import`);
	}

	private async referenceSymbology(): Promise<void> {
		const { payload, raw } = await this.fetchScryfallJson("symbology");
		const symbols = (payload.data ?? []) as Record<string, unknown>[];
		if (!Array.isArray(symbols) || symbols.length === 0) throw new Error("/symbology answered no data");
		const { json, count } = renderSymbology(symbols, raw);
		const written = await this.putReferenceValue(symbologyKey(), json);

		// The meta key last, as everywhere else here: it is what says the published set is real.
		const meta: ReferenceMeta = {
			format_version: REFERENCE_FORMAT_VERSION,
			content_generation: REFERENCE_CONTENT_GENERATION,
			bucket_count: SETS_BUCKET_COUNT,
			built_at: this.metaGet("built_at") ?? "",
			set_count: Number(this.metaGet("reference_set_count") ?? 0),
			symbol_count: count,
			catalogs: JSON.parse(this.metaGet("reference_catalogs") ?? "{}"),
		};
		await this.env.STORE_KV.put(REFERENCE_META_KEY, JSON.stringify(meta));
		await this.pruneOldKeys(REFERENCE_KEY_PREFIX, referenceCurrentPrefix(), "reference");
		this.metaSet("phase", "purge");
		console.log(`Reference symbology: ${count} symbols${written ? " (written)" : " (already current)"}`);
	}

	/**
	 * Drop the Worker's edge cache, which is the last thing still serving the
	 * store this run replaced.
	 *
	 * Reached once `notify` has confirmed every region is serving the new store,
	 * which is the correctness condition — purging while a reader still holds the
	 * old one empties the cache straight into a stale answer that then stands for
	 * up to 16 hours. That used to be bought with a ten-minute wait and a second
	 * pass; it is now bought with an acknowledgement, so this runs immediately and
	 * once.
	 *
	 * The purge itself has to run inside the default Worker entrypoint, because
	 * Workers Cache scopes a purge to the entrypoint that issues one and this
	 * Durable Object is not an entrypoint at all; `ctx.exports` is the loopback
	 * that gets us there. See SylvanLibrarian.purgeCache in src/index.ts.
	 *
	 * A failed purge does not fail the run: the fallback is the behaviour this
	 * deployment had before the phase existed — cached answers age out on their
	 * own TTL, at worst 16 hours for a `/cards/*` object. Losing a completed
	 * import over a cache call would be the worse trade, so this only ever logs.
	 */
	private async stepPurge(): Promise<void> {
		const pass = Number(this.metaGet("purges_done") ?? 0) + 1;
		try {
			const result = await this.ctx.exports.default.purgeCache();
			if (result.success) {
				console.log(`Edge cache purged after publish (pass ${pass}/${PURGE_PASSES})`);
			} else {
				console.warn(
					`Edge cache purge pass ${pass}/${PURGE_PASSES} did not succeed ` +
						`(cached answers will expire on their own TTL): ` +
						`${result.errors.map((e) => `${e.code} ${e.message}`).join("; ")}`,
				);
			}
		} catch (err) {
			console.warn(
				`Edge cache purge pass ${pass}/${PURGE_PASSES} could not be issued ` +
					`(cached answers will expire on their own TTL): ${err}`,
			);
		}

		this.ctx.storage.transactionSync(() => {
			this.metaSet("purges_done", String(pass));
			this.metaSet("phase", "idle");
			this.metaSet("finished_at", String(Date.now()));
		});
		// The RUN RECORD has to be retired too, not just the phase. It used to be
		// left saying "running" forever: the phase went idle, so the alarm chain
		// stopped, but `startImport` kept reading state === "running" and taking
		// its already-running branch — re-arming an alarm that returns in 1ms
		// because the phase is idle. Every trigger for the next idle window
		// (STALE_IDLE_MS) was therefore a silent no-op.
		//
		// The daily cron never noticed, because 24h is well past that window. What
		// it broke is any attempt to RUN the import twice in an hour and a half,
		// which is exactly what testing this pipeline requires.
		await this.storePut("run", {
			...(await this.getRun()),
			state: "done",
			finishedAt: new Date().toISOString(),
			detail: this.metaGet("run_summary") ?? undefined,
		} satisfies RunRecord);
		this.logRunSummary("done");
	}

	// ── staging helpers ────────────────────────────────────────────────────────

	/**
	 * Arm the purge_staging phase for `scope` — inside the caller's transaction,
	 * beside the progress it follows, so a lost commit loses both together.
	 */
	private beginPurge(
		scope: PurgeScope,
		blobs?: { table: "stage_blobs" | "stage_members"; kinds: readonly DumpKind[]; next: Phase },
	): void {
		this.metaSet("purge_scope", scope);
		this.metaSet("purge_slices", "0");
		this.metaSet("purge_started_ms", String(Date.now()));
		if (blobs) {
			// ONE table: the recode boundary drops all_cards' raw blobs while its
			// recoded members are what the transform reads next; the transform
			// boundary drops the members. Naming both would drop the corpus.
			this.metaSet("purge_table", blobs.table);
			this.metaSet("purge_kinds", JSON.stringify(blobs.kinds));
			this.metaSet("purge_next", blobs.next);
		}
		this.metaSet("phase", "purge_staging");
	}

	/** The dump kinds a `blobs` purge is confined to (purge_kinds), or null when the scope is not `blobs`. */
	private purgeKinds(scope: PurgeScope): string[] | null {
		if (scope !== "blobs") return null;
		const kinds = JSON.parse(this.metaGet("purge_kinds") ?? "[]") as unknown;
		if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((k) => typeof k === "string")) {
			throw new FatalImportError(`purge_staging: blobs scope without kinds (${this.metaGet("purge_kinds")})`);
		}
		return kinds as string[];
	}

	/**
	 * Delete at most PURGE_SLICE_BYTES from one staging table, in key order from
	 * its head, in one transaction of its own. Returns what it freed, or null
	 * when the table (or its scoped part) is already empty.
	 *
	 * Idempotent under a lost commit: the next attempt plans from the same head
	 * and cuts at the same key. `LENGTH(bytes)` reads the cell header, not the
	 * overflow pages, so the planning read is cheap.
	 */
	private purgeSlice(
		t: PurgeTable,
		partition: number | undefined,
		kinds: readonly string[] | null,
		budgetBytes: number,
	): { rows: number; bytes: number; scope: string } | null {
		let where = "";
		let scopeArgs: unknown[] = [];
		let label = "";
		if (t.scope) {
			// A `kind` scope confined to named kinds (the blobs purge) discovers the
			// lowest of THOSE; unconfined (the reset) takes whatever is there.
			const confined = t.scope === "kind" && kinds ? ` WHERE kind IN (${kinds.map(() => "?").join(", ")})` : "";
			const value =
				t.scope === "partition" && partition !== undefined
					? partition
					: (this.sqlAll<{ v: number | string | null }>(
							`SELECT MIN(${t.scope}) AS v FROM ${t.table}${confined}`,
							...(confined ? (kinds ?? []) : []),
						)[0]?.v ?? null);
			if (value === null || value === undefined) return null;
			where = ` WHERE ${t.scope} = ?`;
			scopeArgs = [value];
			label = ` ${t.scope} ${value}`;
		}
		const head = this.sqlAll<{ key: number; bytes: number }>(
			`SELECT ${t.key} AS key, LENGTH(bytes) AS bytes FROM ${t.table}${where} ORDER BY ${t.key} LIMIT ?`,
			...scopeArgs,
			PURGE_SLICE_MAX_ROWS,
		);
		const plan = planPurgeSlice(head, budgetBytes);
		if (!plan) return null;
		this.noteChurn(plan.bytes);
		this.ctx.storage.transactionSync(() => {
			this.sqlRun(`DELETE FROM ${t.table}${where ? `${where} AND` : " WHERE"} ${t.key} <= ?`, ...scopeArgs, plan.upTo);
		});
		return { rows: plan.rows, bytes: plan.bytes, scope: label };
	}

	// ── phase: purge_staging (bounded deletes, one slice per alarm) ────────────

	/**
	 * Retire the staging the current scope names, at most PURGE_SLICE_BYTES per
	 * alarm, then move the run on. Stateless across alarms on purpose: each one
	 * walks the scope's tables in order, deleting from each until the alarm's
	 * budget is spent or the table is empty, so a retry or a reset costs nothing
	 * but the planning reads, and no cursor can drift from what is actually in
	 * the tables. Every delete is its own bounded transaction; the alarm's total
	 * is bounded too, because it is the alarm's flush the next one waits on.
	 * When the walk runs out of tables before it runs out of budget, everything
	 * is gone and the same alarm moves the run on.
	 */
	private async stepPurgeStaging(): Promise<void> {
		const scope = this.metaGet("purge_scope") as PurgeScope | null;
		if (!scope || !(scope in PURGE_TABLES)) {
			throw new FatalImportError(`purge_staging: no purge scope recorded (${JSON.stringify(scope)})`);
		}
		const pp = scope === "partition" || scope === "rewind" ? this.requirePp() : null;
		const kinds = this.purgeKinds(scope);
		const purgeTable = scope === "blobs" ? this.metaGet("purge_table") : null;
		if (scope === "blobs" && !purgeTable) throw new FatalImportError("purge_staging: blobs scope without a table");
		const tables = purgeTable ? PURGE_TABLES[scope].filter((t) => t.table === purgeTable) : PURGE_TABLES[scope];
		if (tables.length === 0) throw new FatalImportError(`purge_staging: no purge table named ${purgeTable}`);
		const t0 = Date.now();
		let freedBytes = 0;
		const freedParts: string[] = [];
		for (const t of tables) {
			while (freedBytes < PURGE_SLICE_BYTES) {
				const freed = this.purgeSlice(t, pp?.partition, kinds, PURGE_SLICE_BYTES - freedBytes);
				if (!freed) break; // this table (or its scoped part) is empty: next table
				freedBytes += freed.bytes;
				freedParts.push(`${t.table}${freed.scope} ${freed.rows} row(s) ${(freed.bytes / 1048576).toFixed(1)}MB`);
			}
			if (freedBytes >= PURGE_SLICE_BYTES) break;
		}
		if (freedBytes > 0) {
			const n = Number(this.metaGet("purge_slices") ?? 0) + 1;
			this.metaSet("purge_slices", String(n));
			console.log(
				`Staging purge slice ${n} (${scope}${pp ? `, partition ${pp.partition}` : ""}): ${freedParts.join(", ")} — ` +
					`${(freedBytes / 1048576).toFixed(1)}MB in ${Date.now() - t0}ms`,
			);
			if (freedBytes >= PURGE_SLICE_BYTES) return; // next alarm continues
			// Under budget with no table left: the walk emptied the scope. Fall
			// through and move on in this same alarm.
		}
		// Every table in scope is empty: leave the phase, in one transaction
		// with the progress that follows it.
		const slices = Number(this.metaGet("purge_slices") ?? 0);
		const ms = Date.now() - Number(this.metaGet("purge_started_ms") ?? t0);
		let next = "";
		this.ctx.storage.transactionSync(() => {
			if (scope === "reset") {
				this.metaSet("phase", "listing");
				next = "listing the dumps";
			} else if (scope === "blobs") {
				const after = this.metaGet("purge_next");
				if (!after) throw new FatalImportError("purge_staging: blobs scope without a next phase");
				this.metaSet("phase", after);
				this.metaSet("purge_table", "");
				this.metaSet("purge_kinds", "");
				this.metaSet("purge_next", "");
				next = `${purgeTable} ${(kinds ?? []).join("+")} dropped; on to ${after}`;
			} else if (scope === "rewind") {
				// The rewind already reset the partition's cursors and pp.step.
				this.metaSet("phase", "agg");
				next = `re-aggregating partition ${pp?.partition}`;
			} else if (scope === "retire") {
				this.metaSet("phase", "idle");
				next = `retired: superseded by ${this.metaGet("superseded_by") ?? "a newer coordinator"}, published nothing`;
			} else if (pp) {
				const isLast = pp.partition === pp.partitions.length - 1;
				if (isLast) {
					this.metaSet("phase", "placement");
					next = "probing placement, then writing the manifest";
				} else {
					const advanced = advanceToNextPartition(pp);
					if (!advanced) throw new Error(`purge_staging: could not advance past partition ${pp.partition}`);
					this.savePp(pp);
					this.metaSet("phase", "agg");
					next = `continuing with partition ${pp.partition}/${pp.partitions.length}`;
				}
			}
			this.metaSet("purge_scope", "");
		});
		console.log(`Staging purged (${scope}) in ${slices} slice(s), ${ms}ms; ${next}`);
		if (scope === "retire") {
			// Terminal, like failRun — but NOT failRun: the publishing marker it releases now belongs
			// to the run that replaced this one.
			const run = await this.getRun();
			await this.storePut("run", {
				...run,
				state: "superseded",
				finishedAt: new Date().toISOString(),
				detail: `superseded by ${this.metaGet("superseded_by") ?? "a newer coordinator"}`,
			} satisfies RunRecord);
			await this.disarmAlarm();
			this.logRunSummary("superseded");
			// Deleting the rows did not give their space back: 09-24's three retired runs purged ~1 GB
			// of staging and the namespace still held 1.11 GB, not the ~0.1 GB its live coordinator
			// needed. Only deleteAll releases an object's storage, and a retired coordinator holds
			// nothing a later run needs (should the legacy singleton ever be named again, it starts
			// empty, like any new coordinator).
			this.releaseAfterAlarm = true;
		}
	}

	/**
	 * Reset the run's bookkeeping — but NOT the day-scoped spend counters.
	 *
	 * Those are the whole point: a budget a new run can clear is a budget that
	 * only ever bounds one run, and the failure being guarded against restarts.
	 * Old days are pruned here too, so this never accumulates rows.
	 */
	private metaClear(): void {
		const today = ImportCoordinator.dayKey();
		// Plain positional `?` throughout: numbered parameters (?1) are not part
		// of the storage API's binding contract.
		this.sqlRun(
			"DELETE FROM meta WHERE key NOT LIKE ? OR (key LIKE ? AND key NOT LIKE ?)",
			`${DAY_PREFIX}%`,
			`${DAY_PREFIX}%`,
			`${today}%`,
		);
	}

	private metaGet(key: string): string | null {
		const row = this.sqlAll<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0];
		return row ? String(row.value) : null;
	}

	private metaSet(key: string, value: string): void {
		this.sqlRun("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
	}
}
