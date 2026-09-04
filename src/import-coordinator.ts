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
//   recode    all_cards' one long gzip stream → independent 8MB-raw gzip
//             members (stage_members), so every later resume into the ~2GB
//             dump seeks to a member instead of re-decompressing the prefix
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
//   purge     drop the Worker's edge cache, twice, once the engine DOs have
//             picked the new manifest up — deliberately NOT at the commit point
//
// Restart safety: every phase's inputs live in this DO's SQLite, and phase
// progress commits transactionally with its outputs. Phases whose state lives
// inside the wasm heap (tags/agg/finalize interners) record the wasm
// instance nonce; if the DO was evicted mid-group, the group restarts from
// its SQLite inputs — minutes of redone compute, never a wrong store.

import { DurableObject } from "cloudflare:workers";
import { addressAnnouncedEngine, parseEngineName, replicaGroupOf } from "./engine/engine-namespace";
import { dropGroupWasm, groupWasm, type ImportWasm, newGroupWasm, transientWasm } from "./engine/import-wasm";
import { staleKeys } from "./engine/kv-versions";
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
import { buildRoutingFilterFromHashes, RoutingKeyAccumulator } from "./engine/routing-filter";
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
	PARTITION_HASH_ALGO,
	partitionStoreKey,
	REGION_LIVE_PREFIX,
	STORE_CONTENT_GENERATION,
	type StagedRow,
	staleStoreKeys,
	storeKeyStem,
	writeManifest,
	writeRoutingFilter,
} from "./engine/store-kv";
import type { Env, StoreManifest, StoreManifestPartition } from "./engine/types";
import {
	AGG_FETCH_BATCHES,
	AGG_SLICE_BATCHES,
	BUCKET_FETCH_BATCHES,
	BUCKET_SLICE_BATCHES,
	FINALIZE_FETCH_BATCHES,
	FINALIZE_SLICE_BATCHES,
	MAX_DAY_ROWS_READ,
	MAX_DAY_ROWS_WRITTEN,
	MAX_RUN_ROWS_READ,
	MAX_RUN_ROWS_WRITTEN,
	REORDER_SLICE_ROWS,
} from "./import-budget";
import { isBlankLine, scanJsonlSlice } from "./import-lines";
import { DUMP_KINDS, type DumpKind, phaseAfterFetch, phaseAfterStaged, TRANSFORM_KIND } from "./import-phases";
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
import {
	InflateRecodeSource,
	MEMBER_RAW_BYTES,
	memberBytes,
	RECODE_ALARM_BUDGET_SECONDS,
	RECODE_CHECKPOINT_VERSION,
	RECODE_RESUMED_WINDOW_SECONDS_PER_GIB,
	type ResumableInflate,
	recodeAlarm,
	skipBytes,
} from "./import-recode";
import {
	BLOB_GROUP_BYTES,
	blobBytes,
	blobGroups,
	bucketDrafts,
	exactBuffer,
	lengthPrefixed,
	orderedRowCursor,
	packPartHashes,
	reorderSlice,
	spillIndex,
	splitBatch,
	unpackPartHashes,
} from "./import-spill";

interface RunRecord {
	state: "idle" | "starting" | "running" | "done" | "failed";
	reason?: string;
	startedAt?: string;
	finishedAt?: string;
	detail?: string;
}

/** A run older than this is considered lost and may be restarted. */
const STALE_RUN_MS = 90 * 60 * 1000;
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
 * (plan B2 says ~4-6). default_cards is NOT recoded, so each slice re-streams
 * the dump and linear-discards to its checkpoint — the tolerable cost profile
 * stagedBytes documents for small kinds: worst slice gunzips a ~360MB prefix
 * (~1-2s) plus an id-only serde parse of its own window (~1s). */
const CANONICAL_SLICE_LINES = 24_000;
/** Draft batches folded into the corpus-wide finalize tables per slice.
 *
 * Bigger than AGG_SLICE_BATCHES because the work per draft is far smaller — three fields off a
 * narrow serde struct, one hash lookup, no dedupe map, no interners — while the per-slice OVERHEAD
 * is large and fixed: the whole TagData snapshot is restored and re-exported around every slice
 * (~20MB of JSON), which is what makes the phase resumable. 24 batches ≈ 45MB of staged drafts,
 * putting today's corpus at ~35 slices. */
const SCORES_SLICE_BATCHES = 24;
/** Batch rows materialized as JS buffers at once inside a scores slice (~15MB) — the same
 * resident-bytes budget the agg slice keeps. */
const SCORES_FETCH_BATCHES = 8;
/** Drafts per SQLite batch row (~1.5MB of draft JSON, under the 2MB value cap). */
// Draft batching is by BYTES (BLOB_GROUP_BYTES, via blobGroups) rather than by draft count.
//
// It was `DRAFTS_PER_BATCH = 1_000`, which silently made the SQLite row size a function of how fat
// a draft happens to be — and Durable Object SQLite rejects a value over 2 MB with SQLITE_TOOBIG.
// Adding the Scryfall compat residue to `RowDraft` (generation 10) grew each draft enough to cross
// that, and the import failed in the transform phase with nothing to say a size limit was what it
// hit. The spill and row batches were already byte-capped; drafts were the one that was not.
/** SQLite blob row size for staged dumps and tag-data snapshots. */
const STAGE_BLOB_BYTES = 1_900_000;
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
// WHICH dumps a run fetches, and where the chain goes after each, live in
// src/import-phases.ts (DUMP_KINDS / phaseAfterFetch) — one list, with the
// per-dump ordering rationale beside it.

type Phase =
	| "idle"
	| "listing"
	| `fetch:${DumpKind}`
	| "recode:all_cards"
	| "canonical"
	| "transform"
	| "tags"
	| "scores"
	| "routing"
	| "bucket"
	| "agg"
	| "finalize"
	| "reorder"
	| "build"
	| "publish"
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
	 * so `do_rows_written` read ZERO after an import that wrote hundreds of
	 * rows, and the daily write-budget guard below could never fire. That guard
	 * is the one thing standing between a looping import and a spent free-tier
	 * allowance, and it was measuring nothing.
	 *
	 * A write cursor has no rows to drain, so its counters are final as soon as
	 * exec returns.
	 */
	private sqlRun(query: string, ...bindings: unknown[]): void {
		const cursor = this.ctx.storage.sql.exec(query, ...bindings);
		this.rowsRead += cursor.rowsRead;
		this.rowsWritten += cursor.rowsWritten;
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
			-- A staged dump re-compressed into INDEPENDENT gzip members of
			-- MEMBER_RAW_BYTES raw bytes each (see stepRecode), one member per
			-- row, carrying the raw span it covers. Unlike stage_blobs — arbitrary
			-- 1.9MB cuts of one long gzip stream, decodable only from the top —
			-- these let stagedBytes() start decompressing AT any raw offset, which
			-- is what makes ~55 transform resumes into all_cards' ~2GB affordable.
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
			CREATE TABLE IF NOT EXISTS chunk_staging (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
			-- The routing filter's raw input, one row per scores batch: tab-separated
			-- partition/key lines emitted by scores_add_drafts (EMIT_ROUTING). Staged rather than
			-- accumulated in wasm
			-- because 1.2M keys resident would be ~55MB against a 124MiB ceiling; the routing phase
			-- streams them straight into hashes and drops the table.
			CREATE TABLE IF NOT EXISTS routing_keys (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
			-- What the last import left in each published rulings bucket. CROSS-RUN state, unlike
			-- every table above it: it is what lets a night publish only the buckets whose bytes
			-- actually moved, so it is neither in resetStaging nor covered by metaClear.
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
		this.schemaReady = true;
	}

	// ── HTTP surface ───────────────────────────────────────────────────────────
	//
	// One route. /status existed to drive the "building the card index" page,
	// which is gone: the deploy builds the index and fails if it cannot, so
	// there is no in-progress state for a visitor to watch. Progress lives in
	// the Worker logs, where an unattended nightly run belongs.

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (new URL(request.url).pathname === "/start-import") {
			return this.startImport(url.searchParams.get("reason") ?? "unspecified");
		}
		return new Response("not found", { status: 404 });
	}

	private async getRun(): Promise<RunRecord> {
		return (await this.ctx.storage.get<RunRecord>("run")) ?? { state: "idle" };
	}

	private async startImport(reason: string): Promise<Response> {
		this.ensureSchema();
		const run = await this.getRun();
		if (run.state === "starting" || run.state === "running") {
			const age = run.startedAt ? Date.now() - Date.parse(run.startedAt) : 0;
			if (age < STALE_RUN_MS) {
				// A restart (deploy, dev reload) can drop the pending alarm while
				// the run record says "running" — re-arm so the chain resumes from
				// its persisted phase instead of stalling until the stale window.
				if ((await this.ctx.storage.getAlarm()) === null) {
					await this.ctx.storage.setAlarm(Date.now());
				}
				return Response.json({ ok: true, alreadyRunning: true, run }, { status: 202 });
			}
			console.warn(`Import run stale after ${age}ms; restarting (reason=${reason})`);
		}

		// Always a fresh run. Resume-where-it-failed used to matter when a visitor
		// hitting a progress page could retrigger an import minutes later;
		// the nightly cron is now the only trigger, and it exists precisely to
		// pick up today's dumps, so inheriting yesterday's staged ones would
		// defeat the point.
		const record: RunRecord = { state: "running", reason, startedAt: new Date().toISOString() };
		this.ctx.storage.transactionSync(() => {
			this.resetStaging();
			this.metaClear();
			this.metaSet("phase", "listing");
		});
		await this.ctx.storage.put("run", record);
		await this.ctx.storage.put("phase_attempts", 0);
		await this.ctx.storage.setAlarm(Date.now());
		return Response.json({ ok: true, run: record }, { status: 202 });
	}

	// ── alarm chain ────────────────────────────────────────────────────────────

	override async alarm(): Promise<void> {
		try {
			await this.runAlarm();
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

	private async runAlarm(): Promise<void> {
		this.ensureSchema();
		const run = await this.getRun();
		if (run.state !== "running") return; // stale alarm from a finished run
		const phase = (this.metaGet("phase") ?? "idle") as Phase;
		if (phase === "idle") return;

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
		const spentRead = Number(this.metaGet("do_rows_read") ?? 0);
		const spentWritten = Number(this.metaGet("do_rows_written") ?? 0);
		const dayRead = Number(this.metaGet(`${day}:read`) ?? 0);
		const dayWritten = Number(this.metaGet(`${day}:written`) ?? 0);
		const overRun = spentRead > MAX_RUN_ROWS_READ || spentWritten > MAX_RUN_ROWS_WRITTEN;
		const overDay = dayRead > MAX_DAY_ROWS_READ || dayWritten > MAX_DAY_ROWS_WRITTEN;
		if (overRun || overDay) {
			const scope = overDay ? "today's" : "this run's";
			const read = overDay ? dayRead : spentRead;
			const written = overDay ? dayWritten : spentWritten;
			console.error(
				`Import stopped on ${scope} storage budget in phase ${phase}: ` +
					`${read.toLocaleString()} rows read, ${written.toLocaleString()} written. ` +
					"A single import costs a fraction of this, so exceeding it means work is being repeated.",
			);
			run.state = "failed";
			run.finishedAt = new Date().toISOString();
			run.detail =
				`${phase}: ${scope} storage budget exhausted (${read.toLocaleString()} rows read, ` +
				`${written.toLocaleString()} written) — stopped before spending the daily allowance`;
			this.metaSet("phase", "idle");
			await this.ctx.storage.put("run", run);
			await this.ctx.storage.deleteAlarm();
			return;
		}

		const attempts = ((await this.ctx.storage.get<number>("phase_attempts")) ?? 0) + 1;
		await this.ctx.storage.put("phase_attempts", attempts);
		if (attempts > MAX_PHASE_ATTEMPTS) {
			console.error(
				`Import phase ${phase} attempted ${attempts} times without completing a slice — ` +
					"stopping. This is the signature of a slice the runtime keeps killing " +
					"(CPU or memory), not of an error being retried.",
			);
			run.state = "failed";
			run.finishedAt = new Date().toISOString();
			run.detail = `${phase}: ${attempts} attempts with no progress — slice is being killed, not failing`;
			this.metaSet("phase", "idle");
			await this.ctx.storage.put("run", run);
			await this.ctx.storage.deleteAlarm();
			return;
		}

		try {
			await this.step(phase);
			// A slice that succeeded clears the retry state, so a recovered
			// transient failure stops being reported as an ongoing problem.
			this.metaSet("retries", "0");
			// Only when something was actually being retried: attempts is always
			// >= 1 here, so an unconditional reset would write a row on every
			// healthy slice to clear a counter nothing had raised.
			if (attempts > 1) await this.ctx.storage.put("phase_attempts", 0);
			const next = (this.metaGet("phase") ?? "idle") as Phase;
			// Every phase is now work with nothing to wait for, so the chain runs
			// itself as fast as the runtime allows. `purge` used to be a DEADLINE
			// instead of a slice, carrying a timestamp it could not run before,
			// because it had to outlast readers noticing the publish on their own.
			// `notify` tells them instead, so there is nothing left to wait out.
			if (next !== "idle") await this.ctx.storage.setAlarm(Date.now());
		} catch (err) {
			if (err instanceof FatalImportError) {
				console.error(`Import stopped in phase ${phase}: ${err.message}`);
				run.state = "failed";
				run.finishedAt = new Date().toISOString();
				run.detail = `${phase}: ${err.message}`;
				this.metaSet("phase", "idle");
				await this.ctx.storage.put("run", run);
				await this.ctx.storage.deleteAlarm();
				return;
			}
			if (isQuotaError(err)) {
				// A daily quota resets at 00:00 UTC — minutes of backoff cannot
				// clear it, so retrying is pure churn. Fail the run with the real
				// reason; the next scheduled import restarts on fresh quota.
				console.error(`Import stopped by a platform daily limit in phase ${phase}:`, err);
				run.state = "failed";
				run.finishedAt = new Date().toISOString();
				run.detail = `${phase}: daily write limit reached — the next scheduled import retries on fresh quota`;
				this.metaSet("phase", "idle");
				await this.ctx.storage.put("run", run);
				await this.ctx.storage.deleteAlarm();
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
				await this.ctx.storage.setAlarm(Date.now() + backoffMs);
				return;
			}
			console.error(`Import failed in phase ${phase}:`, err);
			run.state = "failed";
			run.finishedAt = new Date().toISOString();
			run.detail = `${phase}: ${err}`;
			this.metaSet("phase", "idle");
			await this.ctx.storage.put("run", run);
			await this.ctx.storage.deleteAlarm();
		} finally {
			// On EVERY exit from this alarm, including the early returns above and
			// a thrown slice: what was spent has to be banked before the instance
			// goes away, or the budget only ever measures the last alarm.
			this.flushMeters();
		}
	}

	/** Today's UTC date, the scope the platform's own meters reset on. */
	private static dayKey(): string {
		return `${DAY_PREFIX}${new Date().toISOString().slice(0, 10)}`;
	}

	/** Bank this instance's metered rows into the run's and the day's totals. */
	private flushMeters(): void {
		if (this.rowsRead === 0 && this.rowsWritten === 0) return;
		const day = ImportCoordinator.dayKey();
		const read = Number(this.metaGet("do_rows_read") ?? 0) + this.rowsRead;
		const written = Number(this.metaGet("do_rows_written") ?? 0) + this.rowsWritten;
		const dayRead = Number(this.metaGet(`${day}:read`) ?? 0) + this.rowsRead;
		const dayWritten = Number(this.metaGet(`${day}:written`) ?? 0) + this.rowsWritten;
		this.rowsRead = 0;
		this.rowsWritten = 0;
		this.ctx.storage.transactionSync(() => {
			this.metaSet("do_rows_read", String(read));
			this.metaSet("do_rows_written", String(written));
			this.metaSet(`${day}:read`, String(dayRead));
			this.metaSet(`${day}:written`, String(dayWritten));
		});
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
					return this.stepRecode(phase.slice("recode:".length) as DumpKind);
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
			this.metaSet("phase", `fetch:${kinds[0]}`);
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
		// The chain lives in src/import-phases.ts: all_cards takes the recode
		// detour, and the last dump hands the chain to the canonical id pass, which
		// must complete before transform starts (every transformed row's
		// is_canonical is membership in the set it builds; see stepCanonical).
		const next = phaseAfterFetch(kind);
		if (next.startsWith("recode:")) {
			this.ctx.storage.transactionSync(() => {
				// A checkpoint is a position in ONE compressed stream; a fresh
				// fetch is a different stream, so any leftover row is poison.
				this.sqlRun("DELETE FROM recode_checkpoint WHERE kind = ?", kind);
				this.metaSet("recode_raw_done", "0");
				this.metaSet("phase", next);
			});
			return;
		}
		this.metaSet("phase", next);
	}

	// ── phase: recode (all_cards → independent gzip members) ──────────────────

	/**
	 * Re-compress as many recode windows as one alarm's work budget affords
	 * into independent MEMBER_RAW_BYTES-raw gzip members (stage_members rows),
	 * routed down one of two paths:
	 *
	 * RESUMABLE (the normal path): the wasm gzip inflater (engine/inflate via
	 * engine/wasm-import) whose serialized state persists per window in
	 * recode_checkpoint, so an alarm continues decompressing EXACTLY where the
	 * last one stopped — no prefix work at all, at any dump size, forever.
	 * Taken when the staged stream is gzip and either the phase is at byte 0
	 * (a fresh decoder) or a trustworthy checkpoint exists (version match,
	 * raw_done match, and the wasm accepts the blob's own layout stamp).
	 *
	 * FALLBACK (the 2026-08-28 budget path, kept verbatim): re-stream the
	 * original stage_blobs gzip from seq 0 through DecompressionStream,
	 * discard to `recode_raw_done`, then cut windows — prefix charged up
	 * front, sound to ~2.9GiB raw. Taken when no trustworthy checkpoint
	 * exists mid-phase (a deploy changed the state layout, a refused blob),
	 * when the staged dump is not gzip at all, or after ANY resumable-path
	 * error (`recode_engine_fallback`, cleared by metaClear at the next run):
	 * the error path deletes the checkpoint, marks the flag, and lets the
	 * alarm end with zero progress rather than running both paths against one
	 * 30s CPU allowance.
	 *
	 * Each window commits in its OWN transactionSync as it completes — never
	 * hold two windows' members (~60–70MB compressed each) in memory at once.
	 * Resumable mid-phase and mid-alarm: a window's raw_done checkpoint (and
	 * on the resumable path the decoder state) commits in the same transaction
	 * as its members, and a killed or retried alarm cannot duplicate members —
	 * member seq is derived from raw_start, and each window's write deletes
	 * seq >= its own start before inserting, so a re-run replaces exactly what
	 * a dead alarm may have half-committed (nothing, given the transaction,
	 * but the delete also covers a checkpoint rolled back under members that
	 * landed).
	 *
	 * The final window deletes the original all_cards stage_blobs INSIDE its
	 * own transaction — first of the progressive staging purges, and
	 * load-bearing for the 5GB pool: dump-as-blobs (~392MB) plus
	 * dump-as-members (~392MB) must not both persist for the rest of the run.
	 */
	private async stepRecode(kind: DumpKind): Promise<void> {
		const rawDone = Number(this.metaGet("recode_raw_done") ?? 0);
		// The budget's rates are measured numbers, and the resumable path's
		// wasm-inflate rate is the soft one (a dev-machine ratio scaled to
		// production — see RECODE_RESUMED_WINDOW_SECONDS_PER_GIB). If a rate
		// is badly underestimated, an alarm overruns 30s and the runtime KILLS
		// it — uncaught, so `retries` never moves, but phase_attempts (counted
		// durably BEFORE each attempt) does. Halving the budget per kill turns
		// "die identically forever" into "converge to windows that fit": the
		// exact spiral the old recode died of nightly, closed structurally.
		const attempts = (await this.ctx.storage.get<number>("phase_attempts")) ?? 1;
		const budgetSeconds = Math.max(RECODE_ALARM_BUDGET_SECONDS / 2 ** Math.max(0, attempts - 1), 1);
		if (this.metaGet("recode_engine_fallback") !== "1" && this.stagedIsGzip(kind)) {
			const wasm = transientWasm();
			const compOffset = this.restoreRecodeCheckpoint(kind, rawDone, wasm);
			if (compOffset !== null) {
				try {
					await this.stepRecodeResumable(kind, rawDone, wasm, compOffset, budgetSeconds);
					return;
				} catch (err) {
					// Fail toward the proven path. Windows committed before the
					// error stand (idempotent grid); the checkpoint goes so no
					// later alarm trusts a decoder this error may have poisoned,
					// and the flag stops re-trying a path that just burned CPU —
					// two paths against one 30s allowance is how retries die.
					console.error(`Recode resumable path failed; phase continues on the from-byte-0 fallback: ${err}`);
					this.ctx.storage.transactionSync(() => {
						this.sqlRun("DELETE FROM recode_checkpoint WHERE kind = ?", kind);
						this.metaSet("recode_engine_fallback", "1");
					});
					return;
				}
			}
		}
		await this.stepRecodeFallback(kind, rawDone, budgetSeconds);
	}

	/** The resumable-path alarm: `wasm` holds a decoder positioned at exactly
	 * `rawDone` raw / `compOffset` compressed bytes. */
	private async stepRecodeResumable(
		kind: DumpKind,
		rawDone: number,
		wasm: ImportWasm,
		compOffset: number,
		budgetSeconds: number,
	): Promise<void> {
		const source = new InflateRecodeSource(
			ImportCoordinator.resumableInflate(wasm),
			this.stagedCompressedBytes(kind, compOffset),
			rawDone,
		);
		const { windows, rawEnd, exhausted } = await recodeAlarm(
			source.stream(),
			rawDone,
			(window) => {
				this.ctx.storage.transactionSync(() => {
					this.sqlRun(
						"DELETE FROM stage_members WHERE kind = ? AND seq >= ?",
						kind,
						Math.floor(window.rawStart / MEMBER_RAW_BYTES),
					);
					for (const m of window.members) {
						this.sqlRun(
							"INSERT INTO stage_members (kind, seq, raw_start, raw_len, bytes) VALUES (?, ?, ?, ?, ?)",
							kind,
							m.seq,
							m.rawStart,
							m.rawLen,
							exactBuffer(m.bytes),
						);
					}
					this.metaSet("recode_raw_done", String(window.rawEnd));
					// The old checkpoint describes an offset this transaction
					// obsoletes either way; only a state that provably sits at
					// EXACTLY the committed offset replaces it.
					this.sqlRun("DELETE FROM recode_checkpoint WHERE kind = ?", kind);
					if (window.exhausted) {
						this.sqlRun("DELETE FROM stage_blobs WHERE kind = ?", kind);
						this.metaSet("phase", phaseAfterStaged(kind));
					} else if (source.produced === window.rawEnd && wasm.inflateTotalOut() === window.rawEnd) {
						this.sqlRun(
							"INSERT INTO recode_checkpoint (kind, version, raw_done, state) VALUES (?, ?, ?, ?)",
							kind,
							RECODE_CHECKPOINT_VERSION,
							window.rawEnd,
							exactBuffer(wasm.inflateSave()),
						);
					} else {
						// A decoder ahead of (or behind) the commit would make a
						// LYING checkpoint — no checkpoint beats a wrong one; the
						// next alarm pays the fallback prefix instead.
						console.error(
							`Recode checkpoint skipped: decoder at ${source.produced}/${wasm.inflateTotalOut()} raw ` +
								`bytes, window committed at ${window.rawEnd}`,
						);
					}
				});
			},
			{ resumed: true, gzipSecondsPerGib: RECODE_RESUMED_WINDOW_SECONDS_PER_GIB, budgetSeconds },
		);
		console.log(
			`Recode alarm (resumable): ${kind} raw bytes ${rawDone}-${rawEnd} in ${windows} window(s)` +
				`${exhausted ? " (done; original stage blobs dropped)" : ""}`,
		);
	}

	/** The pre-checkpoint alarm shape, byte-identical output to the resumable
	 * path (same raw stream, same member grid, same gzipBytes). */
	private async stepRecodeFallback(kind: DumpKind, rawDone: number, budgetSeconds: number): Promise<void> {
		const { windows, rawEnd, exhausted } = await recodeAlarm(
			this.stagedBlobBytes(kind),
			rawDone,
			(window) => {
				this.ctx.storage.transactionSync(() => {
					this.sqlRun(
						"DELETE FROM stage_members WHERE kind = ? AND seq >= ?",
						kind,
						Math.floor(window.rawStart / MEMBER_RAW_BYTES),
					);
					for (const m of window.members) {
						this.sqlRun(
							"INSERT INTO stage_members (kind, seq, raw_start, raw_len, bytes) VALUES (?, ?, ?, ?, ?)",
							kind,
							m.seq,
							m.rawStart,
							m.rawLen,
							exactBuffer(m.bytes),
						);
					}
					this.metaSet("recode_raw_done", String(window.rawEnd));
					if (window.exhausted) {
						this.sqlRun("DELETE FROM recode_checkpoint WHERE kind = ?", kind);
						this.sqlRun("DELETE FROM stage_blobs WHERE kind = ?", kind);
						this.metaSet("phase", phaseAfterStaged(kind));
					}
				});
			},
			{ budgetSeconds },
		);
		console.log(
			`Recode alarm: ${kind} raw bytes ${rawDone}-${rawEnd} in ${windows} window(s)` +
				`${exhausted ? " (done; original stage blobs dropped)" : ""}`,
		);
	}

	/**
	 * Rebuild the wasm decoder for a resumable recode alarm. Returns the
	 * compressed-byte offset to feed from — 0 for the fresh decoder that
	 * bootstraps the phase — or null when nothing trustworthy exists and the
	 * caller must take the fallback path: no row, a version stamp from other
	 * code (the row's OR the state blob's own, checked inside the wasm), a
	 * raw_done that does not match the live meta (a rolled-back transaction's
	 * orphan — impossible while both write in one transaction, checked
	 * anyway), or a decoder that restores to a different offset than the row
	 * claims. A checkpoint is never "repaired": wrong is fallback.
	 */
	private restoreRecodeCheckpoint(kind: DumpKind, rawDone: number, wasm: ImportWasm): number | null {
		if (rawDone === 0) {
			wasm.inflateBegin();
			return 0;
		}
		const row = this.sqlAll<{ version: number; raw_done: number; state: ArrayBuffer }>(
			"SELECT version, raw_done, state FROM recode_checkpoint WHERE kind = ?",
			kind,
		)[0];
		if (!row || Number(row.version) !== RECODE_CHECKPOINT_VERSION || Number(row.raw_done) !== rawDone) return null;
		const compOffset = wasm.inflateRestore(new Uint8Array(row.state));
		if (compOffset === null || wasm.inflateTotalOut() !== rawDone) return null;
		return compOffset;
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

	/** True when a staged dump's bytes carry the gzip magic — the resumable
	 * path only speaks gzip; anything else keeps the sniffing blob path. */
	private stagedIsGzip(kind: DumpKind): boolean {
		const head = this.sqlAll<{ head: ArrayBuffer }>(
			"SELECT substr(bytes, 1, 2) AS head FROM stage_blobs WHERE kind = ? AND seq = 0",
			kind,
		)[0];
		if (!head) return false;
		const bytes = new Uint8Array(head.head as ArrayBuffer);
		return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
	}

	/**
	 * A staged dump's COMPRESSED bytes from `fromByte` onward — the resumable
	 * inflater's input. Row lengths are read first (no blob transfer) so the
	 * skipped prefix is never hauled through memory; only the rows actually
	 * fed are fetched whole.
	 */
	private async *stagedCompressedBytes(kind: DumpKind, fromByte: number): AsyncGenerator<Uint8Array> {
		const sizes = this.sqlAll<{ seq: number; len: number }>(
			"SELECT seq, LENGTH(bytes) AS len FROM stage_blobs WHERE kind = ? ORDER BY seq",
			kind,
		);
		let skip = fromByte;
		for (const { seq, len } of sizes) {
			if (skip >= Number(len)) {
				skip -= Number(len);
				continue;
			}
			const row = this.sqlAll<{ bytes: ArrayBuffer }>(
				"SELECT bytes FROM stage_blobs WHERE kind = ? AND seq = ?",
				kind,
				seq,
			)[0];
			if (!row) throw new Error(`recode: stage blob ${kind}#${seq} vanished mid-stream`);
			const bytes = new Uint8Array(row.bytes as ArrayBuffer);
			yield skip > 0 ? bytes.subarray(skip) : bytes;
			skip = 0;
		}
	}

	/** Stream a staged dump's RAW stage_blobs rows, decompressed. Detects gzip
	 * by magic. The pre-recode view: one long stream, decodable only from the
	 * top — stepRecode's input, and the fallback for kinds never recoded. */
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
	 * Stream a staged dump's decompressed bytes from `fromRawOffset` onward.
	 *
	 * Recoded kinds (rows in stage_members) seek: binary-search the members on
	 * raw_start — the (kind, seq) primary key walks them in raw order, so the
	 * DESC LIMIT 1 below IS that search — start decompressing at the containing
	 * member, and skip the offset's remainder inside it. Cost of a resume: one
	 * ~8MB member, however deep the offset.
	 *
	 * Non-recoded kinds keep the original behavior — the whole-stream blob view
	 * with its gzip-magic sniffing — and honor the offset by linear discard,
	 * which is the cost profile those dumps are small enough to tolerate.
	 */
	private async *stagedBytes(kind: DumpKind, fromRawOffset = 0): AsyncGenerator<Uint8Array> {
		const start = this.sqlAll<{ seq: number; raw_start: number }>(
			"SELECT seq, raw_start FROM stage_members WHERE kind = ? AND raw_start <= ? ORDER BY seq DESC LIMIT 1",
			kind,
			fromRawOffset,
		)[0];
		if (start) {
			yield* memberBytes(
				(seq) => {
					const row = this.sqlAll<{ bytes: ArrayBuffer }>(
						"SELECT bytes FROM stage_members WHERE kind = ? AND seq = ?",
						kind,
						seq,
					)[0];
					return row ? new Uint8Array(row.bytes as ArrayBuffer) : null;
				},
				Number(start.seq),
				fromRawOffset - Number(start.raw_start),
			);
			return;
		}
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
	 * tags_export into tagdata_blobs, tags_restore back out — is what carries
	 * it across slices, across DO evictions, and into every transient transform
	 * instance. Each slice here restores the snapshot, adds its lines, and
	 * re-exports in the same transaction as its cursor, so a retried slice
	 * restores exactly the set its cursor describes. (The tags phase later
	 * overwrites tagdata_blobs with the tag snapshot; by then the set has been
	 * consumed — transform is complete.)
	 *
	 * Resumes by raw byte offset, like transform — but default_cards is not
	 * recoded, so the resume is stagedBytes' linear discard (see
	 * CANONICAL_SLICE_LINES for the cost math).
	 */
	private async stepCanonical(): Promise<void> {
		const wasm = transientWasm();
		wasm.reset();
		const rawDone = Number(this.metaGet("canonical_raw_done") ?? 0);
		if (rawDone > 0) {
			const snapshot = this.tagSnapshotBytes();
			if (!snapshot) throw new FatalImportError("canonical: id snapshot missing mid-phase");
			wasm.tagsRestore(snapshot);
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
		const result = await scanJsonlSlice(this.stagedBytes("default_cards", rawDone), (line) => {
			if (line.length === 0 || isBlankLine(line)) return false;
			lineBufs.push(line.slice());
			lineBytes += line.length;
			fed += 1;
			if (lineBufs.length >= LINES_PER_CALL) feed();
			return fed >= CANONICAL_SLICE_LINES;
		});
		feed();

		const tagBlobs: Uint8Array[] = [];
		wasm.setHandlers({ onTagData: (b) => tagBlobs.push(b) });
		wasm.tagsExport();
		wasm.setHandlers({});

		this.ctx.storage.transactionSync(() => {
			this.writeTagSnapshot(tagBlobs);
			this.metaSet("canonical_raw_done", String(rawDone + result.consumed));
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
				// Progressive staging purge (plan B1): this phase is default_cards'
				// ONLY consumer — the transform reads all_cards — and everything the
				// set feeds is in the snapshot just written. Same transaction as the
				// phase's end, so the run either still owns the dump or no longer
				// needs it, never neither.
				this.sqlRun("DELETE FROM stage_blobs WHERE kind = ?", "default_cards");
				this.metaSet("phase", "transform");
			}
		});
		console.log(
			`Canonical slice: ${fed} lines, ${added} new ids` +
				`${result.exhausted ? " (done; default_cards staged blobs dropped)" : ""}`,
		);
	}

	// ── phase: transform ───────────────────────────────────────────────────────

	private async stepTransform(): Promise<void> {
		// The corpus is all_cards — every printing in every language, recoded into
		// seekable gzip members by the phase before last.
		const corpus = TRANSFORM_KIND;
		// Disposable instance per slice: transform keeps no cross-slice state of
		// its own, and reusing a heap across phases would carry its high-water
		// into the capped later group (linear memory never shrinks). The one
		// thing a slice DOES need resident — the canonical id set — is re-fed
		// below from the snapshot the canonical phase left, the same restore the
		// group phases use after an eviction (one persistence path, no drift).
		const wasm = transientWasm();
		wasm.reset();
		const snapshot = this.tagSnapshotBytes();
		if (!snapshot) {
			// Not retryable: the snapshot is written by the canonical phase, which
			// the chain guarantees ran to completion before this one.
			throw new FatalImportError("transform: canonical id snapshot missing (canonical phase incomplete?)");
		}
		wasm.tagsRestore(snapshot);

		const linesDone = Number(this.metaGet("lines_done") ?? 0);
		// The raw-offset cursor pairs with lines_done: it names the byte at which
		// line `lines_done` starts, so a resume seeks stagedBytes O(1) into the
		// recoded members instead of newline-scanning a ~2GB prefix.
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
		const result = await scanJsonlSlice(this.stagedBytes(corpus, rawOffset), (line) => {
			if (line.length === 0 || isBlankLine(line)) return false;
			lineBufs.push(line.slice());
			lineBytes += line.length;
			if (lineBufs.length >= LINES_PER_CALL) feed();
			processed += 1;
			return processed >= TRANSFORM_SLICE_LINES;
		});
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
			// Byte-capped rows, the same `blobGroups` the spill and row batches below already use.
			// The last group is partial unless this slice reached the end of the dump, so it goes
			// back into the pending row rather than being written undersized once per slice.
			// The hash vector is cut at the same boundaries, staying parallel to its drafts.
			const pending = this.takePendingDrafts();
			const allDrafts = pending.drafts.concat(draftBuf);
			const allHashes = pending.hashes.concat(hashBuf);
			const groups = blobGroups(allDrafts);
			let at = 0;
			for (const group of exhausted ? groups : groups.slice(0, -1)) {
				this.sqlRun(
					"INSERT INTO draft_batches (seq, count, bytes, part_hashes) VALUES (?, ?, ?, ?)",
					++seq,
					group.length,
					exactBuffer(lengthPrefixed(group)),
					exactBuffer(packPartHashes(allHashes.slice(at, at + group.length))),
				);
				at += group.length;
			}
			const tail = exhausted ? [] : (groups.at(-1) ?? []);
			this.storePendingDrafts(tail, allHashes.slice(at, at + tail.length));
			this.metaSet("lines_done", String(seen));
			this.metaSet("transform_raw_offset", String(rawOffset + result.consumed));
			for (const [k, v] of Object.entries(stats)) {
				this.metaSet(`tf_${k}`, String(Number(this.metaGet(`tf_${k}`) ?? 0) + v));
			}
			if (exhausted) {
				// Parse-coverage integrity check (bulk.rs JsonlStream parity): a
				// large dump that mostly failed to parse means the format changed.
				const totalBytes = Number(this.metaGet("tf_total_bytes") ?? 0);
				const parsedBytes = Number(this.metaGet("tf_parsed_bytes") ?? 0);
				if (totalBytes >= PARSE_COVERAGE_MIN_BYTES && parsedBytes < PARSE_COVERAGE_THRESHOLD * totalBytes) {
					throw new Error(
						`bulk parse coverage ${parsedBytes}/${totalBytes} bytes below ${PARSE_COVERAGE_THRESHOLD}; format changed?`,
					);
				}
				this.metaSet("drafts_total", this.metaGet("tf_drafts") ?? "0");
				// Progressive staging purge: the transform's corpus exists to feed
				// it, and no later phase reads it — everything downstream works
				// from draft_batches. Dropped in the SAME transaction that ends the
				// phase, so the run either still owns its input or no longer needs
				// it, never neither. The rows are the RECODED members; all_cards'
				// original blobs went at the end of the recode phase.
				this.sqlRun("DELETE FROM stage_members WHERE kind = ?", corpus);
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
		const drafts = splitBatch(new Uint8Array(stored.bytes as ArrayBuffer)).map((b) => b.slice());
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

	private storePendingDrafts(drafts: Uint8Array[], hashes: bigint[]): void {
		this.sqlRun("DELETE FROM draft_batches WHERE seq = -1");
		if (drafts.length > 0) {
			this.sqlRun(
				"INSERT INTO draft_batches (seq, count, bytes, part_hashes) VALUES (-1, ?, ?, ?)",
				drafts.length,
				exactBuffer(lengthPrefixed(drafts)),
				exactBuffer(packPartHashes(hashes)),
			);
		}
	}

	// ── phase: tags ────────────────────────────────────────────────────────────

	private async stepTags(): Promise<void> {
		// Tag dumps are small next to default_cards; both fit one slice. The
		// TagData snapshot persists so later phases survive eviction.
		const wasm = newGroupWasm();
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

		const tagBlobs: Uint8Array[] = [];
		wasm.setHandlers({ onTagData: (b) => tagBlobs.push(b) });
		wasm.tagsExport();
		wasm.setHandlers({});

		// Size the partition loop HERE, while everything it needs is already
		// durable: the drafts are fully staged (transform completed before this
		// phase), so SUM(length(bytes)) is the whole corpus, and the projection
		// (bytes × DRAFT_TO_STORE_RATIO / TARGET_PARTITION_BYTES, clamped) is a
		// pure function of it. N and built_at are persisted in the SAME
		// transaction that opens the loop, so a mid-loop restart can fork
		// neither: the store keys, the chunk keys, and every draft's partition
		// assignment all derive from these two values (plan B3 / Decision 3b).
		const stagedDraftBytes = Number(
			this.sqlAll<{ n: number }>("SELECT COALESCE(SUM(length(bytes)), 0) AS n FROM draft_batches WHERE seq >= 0")[0]
				?.n ?? 0,
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
			// path restores THIS TagData (tags + labels).
			this.writeTagSnapshot(tagBlobs);
			this.metaSet("tags_nonce", wasm.nonce);
			this.metaSet("scores_batch_done", "0");
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
			// (restoreTags reads tagdata_blobs, never these) — so their staged
			// bytes are dead the moment this transaction commits. (default_cards'
			// blobs went earlier still, at the end of the canonical phase — its
			// only consumer.)
			for (const consumed of ["oracle_tags", "art_tags", "oracle_cards"] as const) {
				this.sqlRun("DELETE FROM stage_blobs WHERE kind = ?", consumed);
			}
			// The GLOBAL phase between the tags and the loop: the cubecobra table (see stepScores).
			this.metaSet("phase", "scores");
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
	 * The mechanism is the canonical id set's, exactly (stepCanonical): the tables live inside the
	 * wasm's TagData, and the ONE snapshot path — tags_export into tagdata_blobs, tags_restore
	 * back out — carries them across slices, across evictions, and into every per-partition
	 * instance the loop creates. Each slice restores, adds its batches, and re-exports in the same
	 * transaction as its cursor, so a retried slice restores exactly the tables its cursor
	 * describes.
	 */
	private async stepScores(): Promise<void> {
		const wasm = transientWasm();
		wasm.reset();
		const snapshot = this.tagSnapshotBytes();
		if (!snapshot) {
			// Not retryable: the snapshot is written by the tags phase, which the chain
			// guarantees ran to completion before this one.
			throw new FatalImportError("scores: TagData snapshot missing (tags phase incomplete?)");
		}
		wasm.tagsRestore(snapshot);

		// The routing filter's key set rides this pass (see the wasm export): every draft of every
		// partition, exactly once, is precisely what it needs and precisely what this phase already
		// reads. The partition count is fixed at the end of `tags`, two phases back, so the wasm can
		// stamp the final partition index rather than a hash the publisher would have to re-mod.
		const partitionCount = this.requirePp().partitions.length;
		const routingBlobs: { seq: number; bytes: Uint8Array }[] = [];
		let routingSeq = -1;
		wasm.setHandlers({ onRoutingKeys: (b) => routingBlobs.push({ seq: routingSeq, bytes: b }) });

		const done = Number(this.metaGet("scores_batch_done") ?? 0);
		let fed = 0;
		let names = 0n;
		// Batches are read in small groups rather than one query: a slice's worth of staged drafts
		// is ~45MB, and materializing that as JS ArrayBuffers alongside the restored tag heap is
		// the one place this phase could crowd the isolate.
		while (fed < SCORES_SLICE_BATCHES) {
			const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer }>(
				"SELECT seq, bytes FROM draft_batches WHERE seq >= ? ORDER BY seq LIMIT ?",
				done + fed,
				SCORES_FETCH_BATCHES,
			);
			// Staged bytes are already the length-prefixed batch framing the wasm reads, so a
			// batch goes across exactly as it was written — no split, no rejoin.
			for (const row of rows) {
				// The routing emit that this call produces is tagged with the batch's OWN seq, so a
				// retried slice replaces its rows rather than appending a second copy of them.
				routingSeq = row.seq;
				names = wasm.scoresAddDrafts(new Uint8Array(row.bytes), partitionCount);
			}
			fed += rows.length;
			if (rows.length < SCORES_FETCH_BATCHES) break;
		}
		const exhausted = fed < SCORES_SLICE_BATCHES;
		if (exhausted) names = wasm.scoresFinish();

		const tagBlobs: Uint8Array[] = [];
		wasm.setHandlers({ onTagData: (b) => tagBlobs.push(b) });
		wasm.tagsExport();
		wasm.setHandlers({});

		this.ctx.storage.transactionSync(() => {
			this.writeTagSnapshot(tagBlobs);
			// Keyed by the batch cursor this slice started from, so a RETRIED slice
			// overwrites its own rows instead of doubling them. Duplicate keys would
			// not corrupt the filter (it dedupes), but they would inflate the build.
			for (const blob of routingBlobs) {
				this.sqlRun("INSERT OR REPLACE INTO routing_keys (seq, bytes) VALUES (?, ?)", blob.seq, blob.bytes);
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
		try {
			if (!builtAt || !formatVersion) throw new Error("built_at/format_version are not stamped yet");
			// Streamed into hashes row by row. The staged text is ~60MB on today's corpus and the
			// accumulator holds three typed arrays instead of 1.2M strings — the difference between
			// ~15MB and well past this object's 128MB.
			const acc = new RoutingKeyAccumulator(1 << 21);
			const decoder = new TextDecoder();
			let lines = 0;
			for (const row of this.sqlAll<{ bytes: ArrayBuffer }>("SELECT bytes FROM routing_keys ORDER BY seq")) {
				const text = decoder.decode(new Uint8Array(row.bytes));
				let at = 0;
				while (at < text.length) {
					let end = text.indexOf("\n", at);
					if (end === -1) end = text.length;
					if (end > at) {
						const tab = text.indexOf("\t", at);
						if (tab !== -1 && tab < end) {
							acc.add(text.slice(tab + 1, end), Number(text.slice(at, tab)));
							lines++;
						}
					}
					at = end + 1;
				}
			}
			if (lines === 0) throw new Error("the scores phase staged no routing keys");
			const sealed = acc.seal();
			const bytes = buildRoutingFilterFromHashes(sealed, {
				builtAt,
				partitionCount: pp.partitions.length,
				partitionHash: PARTITION_HASH_ALGO,
			});
			await writeRoutingFilter(this.env, formatVersion, builtAt, bytes);
			console.log(
				`Routing filter published: ${sealed.lo.length} ids from ${lines} rows, ` +
					`${(bytes.byteLength / 1024).toFixed(0)}KB — bare-id routes ask ONE of ` +
					`${pp.partitions.length} partitions.`,
			);
		} catch (err) {
			console.warn(`Routing filter NOT published (${err}); every /cards/<id> lookup will fan out.`);
		}
		this.ctx.storage.transactionSync(() => {
			// Dropped either way: the keys have done their job, and ~60MB of staging against a
			// shared 5GB pool is not worth keeping for a retry of an optional artifact.
			this.sqlRun("DELETE FROM routing_keys");
			this.metaSet("bucket_batch_done", "0");
			this.metaSet("phase", "bucket");
		});
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
	 * Memory: a slice holds the drafts it has not yet flushed as VIEWS into their
	 * batch buffers, so what stays resident is every batch with an unflushed
	 * draft — bounded by the accumulators (N x BLOB_GROUP_BYTES) plus the fetch
	 * group, ~60MB at N=32 and ~27MB at N=10, against the 128MB isolate.
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
		const acc: Uint8Array[][] = Array.from({ length: n }, () => []);
		const accBytes = new Array<number>(n).fill(0);
		const ordinal = new Array<number>(n).fill(0);
		let groups = 0;
		const flush = (partition: number) => {
			const group = acc[partition] as Uint8Array[];
			if (group.length === 0) return;
			this.sqlRun(
				"INSERT OR REPLACE INTO draft_parts (partition, seq, count, bytes) VALUES (?, ?, ?, ?)",
				partition,
				done * 128 + (ordinal[partition] as number),
				group.length,
				exactBuffer(lengthPrefixed(group)),
			);
			ordinal[partition] = (ordinal[partition] as number) + 1;
			acc[partition] = [];
			accBytes[partition] = 0;
			groups += 1;
		};
		let fed = 0;
		while (fed < BUCKET_SLICE_BATCHES) {
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
				const byPartition = bucketDrafts(
					{ bytes: new Uint8Array(row.bytes), partHashes: new Uint8Array(row.part_hashes) },
					n,
				);
				for (let p = 0; p < n; p++) {
					for (const draft of byPartition[p] as Uint8Array[]) {
						// Same cap rule as blobGroups: a group's length-prefixed encoding stays under it.
						if ((acc[p] as Uint8Array[]).length > 0 && (accBytes[p] as number) + 4 + draft.length > BLOB_GROUP_BYTES) {
							flush(p);
						}
						(acc[p] as Uint8Array[]).push(draft);
						accBytes[p] = (accBytes[p] as number) + 4 + draft.length;
					}
				}
			}
			fed += rows.length;
			if (rows.length < want) break;
		}
		const exhausted = fed < BUCKET_SLICE_BATCHES;
		this.ctx.storage.transactionSync(() => {
			for (let p = 0; p < n; p++) flush(p);
			// The consumed source rows go in the SAME transaction as the cursor, so the pool never
			// holds the drafts twice for longer than one slice and a retry re-reads exactly what
			// it re-writes.
			this.sqlRun("DELETE FROM draft_batches WHERE seq >= ? AND seq < ?", done, done + fed);
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

	/** The TagData snapshot, reassembled from its byte-capped rows; null when none. */
	private tagSnapshotBytes(): Uint8Array | null {
		const rows = this.sqlAll<{ bytes: ArrayBuffer }>("SELECT bytes FROM tagdata_blobs ORDER BY seq");
		if (rows.length === 0) return null;
		const total = rows.reduce((n, r) => n + (r.bytes as ArrayBuffer).byteLength, 0);
		const merged = new Uint8Array(total);
		let at = 0;
		for (const r of rows) {
			merged.set(new Uint8Array(r.bytes as ArrayBuffer), at);
			at += (r.bytes as ArrayBuffer).byteLength;
		}
		return merged;
	}

	/** Replace the TagData snapshot (caller supplies the surrounding transaction). */
	private writeTagSnapshot(blobs: Uint8Array[]): void {
		this.sqlRun("DELETE FROM tagdata_blobs");
		let seq = -1;
		for (const blob of blobs) {
			for (let at = 0; at < blob.length; at += STAGE_BLOB_BYTES) {
				this.sqlRun(
					"INSERT INTO tagdata_blobs (seq, bytes) VALUES (?, ?)",
					++seq,
					exactBuffer(blob.subarray(at, Math.min(at + STAGE_BLOB_BYTES, blob.length))),
				);
			}
		}
	}

	/** Restore in-wasm TagData from the SQLite snapshot (post-eviction). */
	private restoreTags(wasm: ReturnType<typeof groupWasm>): void {
		const merged = this.tagSnapshotBytes();
		if (!merged) throw new Error("tagdata snapshot missing; cannot restore tags");
		const n = wasm.tagsRestore(merged);
		console.log(`Restored TagData after eviction (${n} mapped ids)`);
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
		// The rewind rebuilds the partition from draft_batches — which the LAST
		// partition's finalize drops (progressive purge, load-bearing for the 5GB
		// pool). Losing the heap after that point is unrecoverable within this
		// run: without this check the rewind would "succeed", aggregate zero
		// drafts, and die two phases later on "no staged rows" — an accurate
		// symptom of the wrong cause. The cost is one lost nightly in a rare
		// double failure (eviction during the last partition's reorder/build);
		// the previous store keeps serving and the next import restarts cleanly.
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
			`Wasm state lost to eviction (${rewinds}/${MAX_WASM_REWINDS}); rebuilding tags + ` +
				`partition ${pp.partition}'s aggregation from SQLite`,
		);
		const fresh = newGroupWasm();
		fresh.reset();
		this.restoreTags(fresh);
		this.ctx.storage.transactionSync(() => {
			this.metaSet("wasm_rewinds", String(rewinds));
			this.metaSet("tags_nonce", fresh.nonce);
			// This rebuild IS the partition's fresh start, so stepAgg must not
			// stack a second fresh instance on top of it.
			this.metaSet("agg_partition_started", String(pp.partition));
			this.metaSet("agg_seq_done", "-1");
			this.metaSet("agg_sealed", "0");
			// Any partially-spilled finalize output is invalid with a fresh heap.
			// Only the current partition's rows exist in these tables (see the
			// method comment), so the whole-table delete IS the partition-scoped
			// one.
			this.sqlRun("DELETE FROM spill_batches");
			this.metaSet("finalize_seq_done", "-1");
			// And so is anything reorder derived FROM that output. Leaving these
			// behind would resume the rewritten spill part-written against rows
			// that no longer exist, appending to stale blobs — a store that
			// builds without error and is wrong.
			this.sqlRun("DELETE FROM ordered_rows");
			this.metaSet("reorder_done", "0");
			pp.step = "agg";
			this.savePp(pp);
			this.metaSet("phase", "agg");
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
			const fresh = newGroupWasm();
			fresh.reset();
			this.restoreTags(fresh);
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
		// Fetched in AGG_FETCH_BATCHES-sized groups rather than one query for
		// the whole slice — the split stepScores documents: the slice is a CPU
		// budget, the group is the resident-bytes budget, and materializing a
		// 64-batch slice at once would be ~120MB against a 128MB isolate.
		let fed = 0;
		while (fed < AGG_SLICE_BATCHES) {
			const want = Math.min(AGG_FETCH_BATCHES, AGG_SLICE_BATCHES - fed);
			const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer }>(
				"SELECT seq, bytes FROM draft_parts WHERE partition = ? AND seq > ? ORDER BY seq LIMIT ?",
				pp.partition,
				last,
				want,
			);
			for (const row of rows) {
				// Every draft in the group is this partition's, in emission order —
				// stepBucket preserved it within and across batches — so the group
				// is fed whole, no filter.
				wasm.aggDrafts(new Uint8Array(row.bytes));
				last = row.seq;
			}
			fed += rows.length;
			// Short group means the staging ran out, which is the seal condition
			// below — never "this group happened to be small".
			if (rows.length < want) break;
		}
		if (fed < AGG_SLICE_BATCHES) {
			const winners = wasm.aggFinish();
			console.log(`Aggregation sealed for partition ${pp.partition}/${pp.partitions.length}: ${winners} winners`);
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
		// Same fetch-group split as stepAgg and stepScores: FINALIZE_SLICE_BATCHES
		// is the CPU budget, FINALIZE_FETCH_BATCHES the resident-bytes one.
		let fed = 0;
		while (fed < FINALIZE_SLICE_BATCHES) {
			const want = Math.min(FINALIZE_FETCH_BATCHES, FINALIZE_SLICE_BATCHES - fed);
			const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer }>(
				"SELECT seq, bytes FROM draft_parts WHERE partition = ? AND seq > ? ORDER BY seq LIMIT ?",
				pp.partition,
				last,
				want,
			);
			for (const row of rows) {
				// Same rows, same order as stepAgg — the finalize pass's contract
				// with the aggregation it follows.
				staged = wasm.finalizeDrafts(new Uint8Array(row.bytes));
				last = row.seq;
			}
			fed += rows.length;
			if (rows.length < want) break;
		}
		const finished = fed < FINALIZE_SLICE_BATCHES;
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
					exactBuffer(lengthPrefixed(group)),
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
			`Finalize slice (partition ${pp.partition}): ${fed} batches, ${staged} rows staged` +
				`${finished ? " (done)" : ""}` +
				`${finished && pp.partition === pp.partitions.length - 1 ? " — draft staging dropped (last partition)" : ""}`,
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
				for (const row of rows) yield { base: Number(row.base), bytes: blobBytes(row.bytes) };
			})(this.sqlIter("SELECT base, bytes FROM spill_batches ORDER BY base")),
		);
		const from = Number(this.metaGet("reorder_done") ?? 0);
		const to = Math.min(from + REORDER_SLICE_ROWS, staged);

		let groupsRead = 0;
		const ordered = reorderSlice(order, index, from, to, (base) => {
			const blob = this.sqlAll<{ bytes: ArrayBuffer }>("SELECT bytes FROM spill_batches WHERE base = ?", base)[0];
			if (!blob) return null;
			groupsRead += 1;
			return blobBytes(blob.bytes);
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
					exactBuffer(lengthPrefixed(group)),
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
			return next ? { base: Number(next.base), bytes: blobBytes(next.bytes) } : null;
		});
		console.log(
			`Build (partition ${pp.partition}/${pp.partitions.length}): streaming ${staged} rows from ordered_rows`,
		);
		// One metered read per ordered blob, not per row — charged up front so a
		// killed build cannot spend the allowance invisibly.
		this.prechargeReads(Number(this.sqlAll<{ n: number }>("SELECT COUNT(*) AS n FROM ordered_rows")[0]?.n ?? 0));

		this.sqlRun("DELETE FROM chunk_staging");
		let chunkSeq = -1;
		// Stage on the STAGING grid — rows just under the DO's 2MB per-value
		// cap, which is as large as they can be. Publishing to KV shares a grid
		// with nobody (it re-cuts these into ~20MB KV chunks), and the old
		// 40,000-byte grid cost ~1,750 DO row writes per import against a
		// 100k/day budget. At 1.9MB a 70MB store stages in ~37 rows.
		const grid = new GridChunker();
		const stage = (b: Uint8Array) => {
			this.sqlRun("INSERT INTO chunk_staging (seq, bytes) VALUES (?, ?)", ++chunkSeq, exactBuffer(b));
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
		// emit-one-release-one). Linear memory peaks well over 70MB and never
		// shrinks, so holding it through publish would leave a ~20MB assembly
		// buffer and ~15MB of staged rows sharing a 128MB isolate with it, once
		// per partition. Publish needs nothing from wasm — the format version has
		// been in meta since tags — and the next partition's agg builds a fresh
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
			(row) => ({ seq: Number(row.seq), bytes: new Uint8Array(row.bytes as ArrayBuffer) }),
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
				// chunks are simply overwritten by their re-cut replacements.
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

		// Every one of this partition's chunks is in KV. Stamp its record, purge
		// its staging (progressive purge, plan B1/B3: the 5GB pool must never
		// hold two partitions' spill+ordered+chunk staging at once — these tables
		// hold ONLY partition p's rows by this same invariant), and either hand
		// the loop to the next partition or commit the whole build.
		const isLast = pp.partition === pp.partitions.length - 1;
		this.ctx.storage.transactionSync(() => {
			completePartitionPublish(pp);
			this.sqlRun("DELETE FROM spill_batches");
			this.sqlRun("DELETE FROM ordered_rows");
			this.sqlRun("DELETE FROM chunk_staging");
			// And the partition's own drafts: published means no rewind can ask for them again.
			this.sqlRun("DELETE FROM draft_parts WHERE partition = ?", pp.partition);
			if (!isLast) {
				const advanced = advanceToNextPartition(pp);
				if (!advanced) throw new Error(`publish: could not advance past partition ${pp.partition}`);
				this.metaSet("phase", "agg");
			}
			this.savePp(pp);
		});
		if (!isLast) {
			console.log(
				`Partition ${pp.partition - 1} published (${rec.chunk_count} chunk(s)); ` +
					`continuing with partition ${pp.partition}/${pp.partitions.length}`,
			);
			return; // next alarm starts the next partition's agg
		}

		// Every chunk of every partition is in KV — write the manifest LAST (the
		// commit point). Totals at top level, one record per partition;
		// partition_count and partition_hash are what routers derive the fan-out
		// and the modulus from (never a constant — plan Decision 3b).
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
		// writeManifest refuses a malformed manifest — the commit point is the one
		// write where a shape bug becomes a served outage rather than a build error.
		await writeManifest(this.env, manifest);

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
		const live = (await this.env.STORE_KV.list({ prefix: REGION_LIVE_PREFIX })).keys.map((k) =>
			k.name.slice(REGION_LIVE_PREFIX.length),
		);
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
		const prepared = await Promise.allSettled(
			live.map(async (name) => ({ name, ...(await stubFor(name).preparePublish(published)) })),
		);
		const prepareFailed = prepared.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
		if (prepareFailed.length > 0) {
			// Thrown, so the phase retries from prepare: the purge below MUST NOT run while a reader
			// might still be serving the old store, or it empties the cache straight into a stale
			// answer that then stands for up to 16 hours. Objects that already prepared re-ack from
			// their local copy for free.
			throw new Error(
				`notify: ${prepareFailed.length}/${live.length} object(s) failed to prepare: ${prepareFailed.join("; ")}`,
			);
		}

		// Step 2: COMMIT everywhere. Same all-or-retry posture — a commit that
		// reached some objects and not others is exactly the mixed window again,
		// and re-running both steps is safe because both are idempotent.
		const results = await Promise.allSettled(
			live.map(async (name) => ({ name, ...(await stubFor(name).commitPublish()) })),
		);
		const failed = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
		if (failed.length > 0) {
			throw new Error(`notify: ${failed.length}/${live.length} object(s) failed to commit: ${failed.join("; ")}`);
		}
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
			const regionGroup = replicaGroupOf(`engine-${parsed.region}`);
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
		// because the phase is idle. Every trigger for the next STALE_RUN_MS (90
		// minutes) was therefore a silent no-op.
		//
		// The daily cron never noticed, because 24h is well past that window. What
		// it broke is any attempt to RUN the import twice in an hour and a half,
		// which is exactly what testing this pipeline requires.
		await this.ctx.storage.put("run", {
			...(await this.getRun()),
			state: "done",
			finishedAt: new Date().toISOString(),
		} satisfies RunRecord);
	}

	// ── staging helpers ────────────────────────────────────────────────────────

	private resetStaging(): void {
		for (const table of [
			"stage_files",
			"stage_blobs",
			"stage_members",
			"recode_checkpoint",
			"draft_batches",
			"draft_parts",
			"spill_batches",
			"ordered_rows",
			"tagdata_blobs",
			"chunk_staging",
			"routing_keys",
		]) {
			this.sqlRun(`DELETE FROM ${table}`);
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
