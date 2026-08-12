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
//   listing   Scryfall /bulk-data → dump URIs
//   fetch     ranged, resumable download of each compressed dump → SQLite
//   transform bulk JSONL → RowDraft blobs (batched into SQLite)
//   tags      tag dumps → in-wasm TagData (+ snapshot to SQLite for restarts)
//   agg       drafts pass 1: dedupe winners, illustration counts, cubecobra
//   finalize  drafts pass 2: ENGINE_COLUMNS rows → spill blobs + row JSON
//   build     spilled rows in build order → rkyv archive → chunk staging
//   publish   ~4 chunks + manifest to KV (manifest LAST — it is the commit
//             point readers act on), prune old stores, clear staging
//
// Restart safety: every phase's inputs live in this DO's SQLite, and phase
// progress commits transactionally with its outputs. Phases whose state lives
// inside the wasm heap (tags/agg/finalize interners) record the wasm
// instance nonce; if the DO was evicted mid-group, the group restarts from
// its SQLite inputs — minutes of redone compute, never a wrong store.

import { DurableObject } from "cloudflare:workers";
import { dropGroupWasm, groupWasm, newGroupWasm, transientWasm } from "./engine/import-wasm";
import { GridChunker } from "./engine/store-chunks";
import {
	assembleChunk,
	chunkCountFor,
	chunkKey,
	gzipBytes,
	KV_CHUNK_BYTES,
	KV_VALUE_CAP_BYTES,
	MANIFEST_KEY,
	STORE_CONTENT_GENERATION,
	type StagedRow,
} from "./engine/store-kv";
import type { Env } from "./engine/types";
import {
	blobBytes,
	blobGroups,
	exactBuffer,
	lengthPrefixed,
	orderedRowCursor,
	reorderSlice,
	spillIndex,
	splitBatch,
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
 */
const MAX_PHASE_ATTEMPTS = 12;
/**
 * Times one run may lose its wasm heap to eviction and rewind to aggregation
 * before it is called off. Three is generous — a healthy import survives with
 * zero — and the cost of each one is most of an import.
 */
const MAX_WASM_REWINDS = 3;

/**
 * What one import run may spend of the Durable Objects storage meters before
 * it stops itself. The free plan allows 5,000,000 rows read and 100,000
 * written per DAY, across everything — so these are deliberately a fraction of
 * that, leaving the day's allowance for serving.
 *
 * A healthy run costs far less: roughly 150k reads, dominated by the build
 * phase's ~98k row lookups, and a few thousand writes. Tripping this ceiling
 * therefore does not mean "a big import"; it means the same work is being done
 * repeatedly, which is exactly how 4.5M reads were once spent in a day —
 * blocking the storage API account-wide and knocking every search DO onto a
 * 15-second load.
 *
 * Better to abandon a run and serve yesterday's index than to finish one and
 * take search down until midnight UTC.
 */
const MAX_RUN_ROWS_READ = 1_000_000;
const MAX_RUN_ROWS_WRITTEN = 40_000;

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
const MAX_DAY_ROWS_READ = 1_500_000;
const MAX_DAY_ROWS_WRITTEN = 60_000;

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
/** Bulk JSONL lines transformed per slice (~1-2s of wasm CPU). Sized for
 * isolate memory as much as CPU: the slice's drafts buffer in JS (~1.5KB
 * each) until the transaction, alongside the wasm heap. */
const TRANSFORM_SLICE_LINES = 10_000;
/** Draft batches aggregated / finalized per slice (~1-2s of wasm CPU each). */
const AGG_SLICE_BATCHES = 8;
/** Finalize buffers ~2KB of row JSON per row in JS while the wasm heap holds
 * tags+aggregates+interners (~90MB at full corpus) — small slices keep the
 * isolate total well under 128MB. */
const FINALIZE_SLICE_BATCHES = 4;
/**
 * Build positions rewritten per reorder slice. Each slice indexes the spill and
 * then reads the groups it needs, so it trades slice count against two
 * whole-spill passes: 8 slices over ~98k rows is ~16 passes, ~400 reads against
 * the 97,802 the random-seek build did. Sized for memory as much as reads —
 * a slice's rows are copied out and held until its transaction commits.
 */
const REORDER_SLICE_ROWS = 12_500;
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
/** Published store versions kept in KV for readers mid-stream and rollback.
 * One previous version covers both; more just consumes the free plan's 1GB
 * KV ceiling at ~70MB apiece. */
const KEEP_STORES = 2;
/** JsonlStream parity: parse-coverage hard-failure thresholds (bulk.rs). */
const PARSE_COVERAGE_MIN_BYTES = 1_000_000;
const PARSE_COVERAGE_THRESHOLD = 0.8;

/** Overridable for tests and self-hosted mirrors (SCRYFALL_BULK_URL var). */
const BULK_DATA_URL = "https://api.scryfall.com/bulk-data";
// `oracle_cards` is one card object per oracle_id, and that object IS Scryfall's chosen
// representative printing — it pins ours (see transform.rs PIN_BONUS). ~24MB against
// default_cards' ~450MB. Last in the list so the phase chain reaches it after the dumps the store
// cannot be built without: a failure here should cost the pin, not the import.
const DUMP_KINDS = ["default_cards", "oracle_tags", "art_tags", "oracle_cards"] as const;
type DumpKind = (typeof DUMP_KINDS)[number];

type Phase =
	| "idle"
	| "listing"
	| `fetch:${DumpKind}`
	| "transform"
	| "tags"
	| "agg"
	| "finalize"
	| "reorder"
	| "build"
	| "publish"
	| "publish";

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
			CREATE TABLE IF NOT EXISTS draft_batches (seq INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL);
			-- Spilled card rows, length-prefixed in byte-capped groups keyed by
			-- the index of their first row. Batched because DO row writes are
			-- the scarcest resource on the free plan (100k/day): one row per
			-- card row would spend 98% of the daily quota on a single import.
			-- stepBuild serves random lookups out of these without re-reading
			-- whole groups — see the substr() lookup there.
			CREATE TABLE IF NOT EXISTS spill_batches (base INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS row_batches (seq INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL);
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
			CREATE TABLE IF NOT EXISTS compat_staging (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);`,
		);
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
			if (next !== "idle") {
				await this.ctx.storage.setAlarm(Date.now());
			}
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
			case "transform":
				return this.stepTransform();
			case "tags":
				return this.stepTags();
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
			default: {
				if (phase.startsWith("fetch:")) {
					return this.stepFetch(phase.slice("fetch:".length) as DumpKind);
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
			.filter((r) => r.type && (DUMP_KINDS as readonly string[]).includes(r.type))
			.map((r) => Date.parse(r.updated_at ?? ""))
			.filter((n) => Number.isFinite(n));
		this.ctx.storage.transactionSync(() => {
			if (stamps.length > 0) {
				this.metaSet("source_updated_at", new Date(Math.max(...stamps)).toISOString());
			}
			for (const kind of DUMP_KINDS) {
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
			this.metaSet("phase", "fetch:default_cards");
		});
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
		const idx = DUMP_KINDS.indexOf(kind);
		const next = DUMP_KINDS[idx + 1];
		this.metaSet("phase", next ? `fetch:${next}` : "transform");
	}

	/** Stream a staged dump's decompressed byte chunks. Detects gzip by magic. */
	private async *stagedBytes(kind: DumpKind): AsyncGenerator<Uint8Array> {
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

	// ── phase: transform ───────────────────────────────────────────────────────

	private async stepTransform(): Promise<void> {
		// Disposable instance per slice: transform is stateless, and reusing a
		// heap across phases would carry its high-water into the capped later
		// group (linear memory never shrinks).
		const wasm = transientWasm();
		const linesDone = Number(this.metaGet("lines_done") ?? 0);
		const draftBuf: Uint8Array[] = [];
		const stats = { parsed: 0, skipped: 0, drafts: 0, parsed_bytes: 0, total_bytes: 0 };
		wasm.setHandlers({
			onDraft: (b) => draftBuf.push(b),
			onStats: (s) => {
				stats.parsed += s.parsed ?? 0;
				stats.skipped += s.skipped ?? 0;
				stats.drafts += s.drafts ?? 0;
				stats.parsed_bytes += s.parsed_bytes ?? 0;
			},
		});

		// Byte-level line handling: skipped (already-processed) lines cost one
		// newline scan, never a decode — resuming deep into the dump stays cheap
		// even though each slice re-streams the gzip from the start.
		let seen = 0;
		let processed = 0;
		let exhausted = true;
		let lineBufs: Uint8Array[] = [];
		let lineBytes = 0;
		const feed = () => {
			if (lineBufs.length === 0) return;
			const joined = new Uint8Array(lineBytes + lineBufs.length - 1);
			let at = 0;
			for (let i = 0; i < lineBufs.length; i++) {
				if (i > 0) joined[at++] = 0x0a;
				const buf = lineBufs[i] as Uint8Array;
				joined.set(buf, at);
				at += buf.length;
			}
			stats.total_bytes += lineBytes + lineBufs.length; // + one newline per line
			wasm.transformLinesRaw(joined);
			lineBufs = [];
			lineBytes = 0;
		};
		const isBlank = (line: Uint8Array): boolean => line.every((b) => b === 0x20 || b === 0x09 || b === 0x0d);
		const takeLine = (line: Uint8Array): boolean => {
			// Returns true when the slice budget is exhausted.
			seen += 1;
			if (seen <= linesDone || line.length === 0 || isBlank(line)) return false;
			lineBufs.push(line.slice());
			lineBytes += line.length;
			if (lineBufs.length >= LINES_PER_CALL) feed();
			processed += 1;
			return processed >= TRANSFORM_SLICE_LINES;
		};
		let carry = new Uint8Array(0);
		outer: for await (const chunk of this.stagedBytes("default_cards")) {
			let data: Uint8Array;
			if (carry.length) {
				data = new Uint8Array(carry.length + chunk.length);
				data.set(carry);
				data.set(chunk, carry.length);
				carry = new Uint8Array(0);
			} else {
				data = chunk;
			}
			let start = 0;
			for (;;) {
				const nl = data.indexOf(0x0a, start);
				if (nl === -1) {
					carry = data.slice(start);
					break;
				}
				const budgetHit = takeLine(data.subarray(start, nl));
				start = nl + 1;
				if (budgetHit) {
					exhausted = false;
					break outer;
				}
			}
		}
		if (exhausted && carry.length) takeLine(carry); // final unterminated line
		feed();
		wasm.setHandlers({});
		console.log(`Transform slice: ${processed} lines (through line ${seen}), ${stats.drafts} drafts`);

		// Persist this slice's drafts + progress atomically: an eviction between
		// the two would otherwise duplicate drafts on resume.
		this.ctx.storage.transactionSync(() => {
			let seq = Number(this.sqlAll<{ m: number }>("SELECT COALESCE(MAX(seq), -1) AS m FROM draft_batches")[0]?.m ?? -1);
			// Byte-capped rows, the same `blobGroups` the spill and row batches below already use.
			// The last group is partial unless this slice reached the end of the dump, so it goes
			// back into the pending row rather than being written undersized once per slice.
			const groups = blobGroups(this.takePendingDrafts().concat(draftBuf));
			for (const group of exhausted ? groups : groups.slice(0, -1)) {
				this.sqlRun(
					"INSERT INTO draft_batches (seq, count, bytes) VALUES (?, ?, ?)",
					++seq,
					group.length,
					exactBuffer(lengthPrefixed(group)),
				);
			}
			this.storePendingDrafts(exhausted ? [] : (groups.at(-1) ?? []));
			this.metaSet("lines_done", String(seen));
			for (const [k, v] of Object.entries(stats)) {
				if (k === "total_bytes" || k === "parsed_bytes" || k === "parsed" || k === "skipped" || k === "drafts") {
					this.metaSet(`tf_${k}`, String(Number(this.metaGet(`tf_${k}`) ?? 0) + v));
				}
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
				this.metaSet("phase", "tags");
			}
		});
	}

	/** Drafts that have not yet filled a whole batch, persisted between slices
	 * as the reserved seq -1 row (excluded from agg/finalize scans by `seq >= 0`
	 * ... which start from a non-negative cursor). */
	private takePendingDrafts(): Uint8Array[] {
		const stored = this.sqlAll<{ bytes: ArrayBuffer }>("SELECT bytes FROM draft_batches WHERE seq = -1")[0];
		if (!stored) return [];
		this.sqlRun("DELETE FROM draft_batches WHERE seq = -1");
		return splitBatch(new Uint8Array(stored.bytes as ArrayBuffer)).map((b) => b.slice());
	}

	private storePendingDrafts(drafts: Uint8Array[]): void {
		this.sqlRun("DELETE FROM draft_batches WHERE seq = -1");
		if (drafts.length > 0) {
			this.sqlRun(
				"INSERT INTO draft_batches (seq, count, bytes) VALUES (-1, ?, ?)",
				drafts.length,
				exactBuffer(lengthPrefixed(drafts)),
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
		this.ctx.storage.transactionSync(() => {
			this.sqlRun("DELETE FROM tagdata_blobs");
			let seq = -1;
			for (const blob of tagBlobs) {
				for (let at = 0; at < blob.length; at += STAGE_BLOB_BYTES) {
					this.sqlRun(
						"INSERT INTO tagdata_blobs (seq, bytes) VALUES (?, ?)",
						++seq,
						exactBuffer(blob.subarray(at, Math.min(at + STAGE_BLOB_BYTES, blob.length))),
					);
				}
			}
			this.metaSet("tags_nonce", wasm.nonce);
			this.metaSet("agg_batch_done", "0");
			this.metaSet("phase", "agg");
		});
	}

	/** Restore in-wasm TagData from the SQLite snapshot (post-eviction). */
	private restoreTags(wasm: ReturnType<typeof groupWasm>): void {
		const rows = this.sqlAll<{ bytes: ArrayBuffer }>("SELECT bytes FROM tagdata_blobs ORDER BY seq");
		if (rows.length === 0) throw new Error("tagdata snapshot missing; cannot restore tags");
		const total = rows.reduce((n, r) => n + (r.bytes as ArrayBuffer).byteLength, 0);
		const merged = new Uint8Array(total);
		let at = 0;
		for (const r of rows) {
			merged.set(new Uint8Array(r.bytes as ArrayBuffer), at);
			at += (r.bytes as ArrayBuffer).byteLength;
		}
		const n = wasm.tagsRestore(merged);
		console.log(`Restored TagData after eviction (${n} mapped ids)`);
	}

	/**
	 * Tags/agg/finalize state lives in the wasm heap. If the instance nonce
	 * changed (DO eviction), rebuild that state from SQLite: restore the tag
	 * snapshot and restart aggregation; the caller then resumes its phase.
	 */
	private ensureWasmContinuity(): boolean {
		const wasm = groupWasm();
		if (this.metaGet("tags_nonce") === wasm.nonce) return true;
		// A rewind is not a retry, and that is what makes it dangerous: it
		// returns false, the caller returns cleanly, and the alarm chain
		// counts the slice as a SUCCESS — clearing the retry and attempt
		// counters that would otherwise bound it. Meanwhile it has thrown away
		// every spilled row and sent the run back to `agg`, so the work from
		// aggregation onwards is done again, including a build phase that
		// re-reads ~98k staged rows. Evict often enough and the import never
		// finishes while quietly re-spending the whole daily row budget, with
		// no error anywhere to say so.
		//
		// So rewinds get their own ceiling. Hitting it means eviction is
		// outrunning progress, which no amount of retrying fixes.
		const rewinds = Number(this.metaGet("wasm_rewinds") ?? 0) + 1;
		if (rewinds > MAX_WASM_REWINDS) {
			throw new FatalImportError(
				`wasm state was lost ${rewinds} times in one run — eviction is outpacing progress, ` +
					"so the import is rewinding to aggregation faster than it can reach publish",
			);
		}
		console.warn(
			`Wasm state lost to eviction (${rewinds}/${MAX_WASM_REWINDS}); rebuilding tags + aggregation from SQLite`,
		);
		const fresh = newGroupWasm();
		fresh.reset();
		this.restoreTags(fresh);
		this.ctx.storage.transactionSync(() => {
			this.metaSet("wasm_rewinds", String(rewinds));
			this.metaSet("tags_nonce", fresh.nonce);
			this.metaSet("agg_batch_done", "0");
			this.metaSet("agg_sealed", "0");
			// Any partially-spilled finalize output is invalid with a fresh heap.
			this.sqlRun("DELETE FROM spill_batches");
			this.sqlRun("DELETE FROM row_batches");
			this.metaSet("finalize_batch_done", "0");
			// And so is anything reorder derived FROM that output. Leaving these
			// behind would resume the rewritten spill part-written against rows
			// that no longer exist, appending to stale blobs — a store that
			// builds without error and is wrong.
			this.sqlRun("DELETE FROM ordered_rows");
			this.metaSet("reorder_done", "0");
			this.metaSet("phase", "agg");
		});
		return false;
	}

	// ── phase: agg ─────────────────────────────────────────────────────────────

	private async stepAgg(): Promise<void> {
		if (!this.ensureWasmContinuity()) return;
		const wasm = groupWasm();
		const done = Number(this.metaGet("agg_batch_done") ?? 0);
		const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer }>(
			"SELECT seq, bytes FROM draft_batches WHERE seq >= ? ORDER BY seq LIMIT ?",
			done,
			AGG_SLICE_BATCHES,
		);
		for (const row of rows) {
			wasm.aggDrafts(new Uint8Array(row.bytes as ArrayBuffer));
		}
		if (rows.length < AGG_SLICE_BATCHES) {
			const winners = wasm.aggFinish();
			console.log(`Aggregation sealed: ${winners} winners`);
			wasm.finalizeBegin();
			this.ctx.storage.transactionSync(() => {
				this.metaSet("agg_sealed", "1");
				this.metaSet("finalize_batch_done", "0");
				this.metaSet("spill_base", "0");
				this.metaSet("phase", "finalize");
			});
		} else {
			this.metaSet("agg_batch_done", String(done + rows.length));
		}
	}

	// ── phase: finalize ────────────────────────────────────────────────────────

	private async stepFinalize(): Promise<void> {
		if (!this.ensureWasmContinuity()) return;
		const wasm = groupWasm();
		const done = Number(this.metaGet("finalize_batch_done") ?? 0);
		const spillBuf: Uint8Array[] = [];
		const rowBuf: Uint8Array[] = [];
		wasm.setHandlers({
			onSpill: (b) => spillBuf.push(b),
			onRow: (b) => rowBuf.push(b),
		});
		const rows = this.sqlAll<{ seq: number; bytes: ArrayBuffer }>(
			"SELECT seq, bytes FROM draft_batches WHERE seq >= ? ORDER BY seq LIMIT ?",
			done,
			FINALIZE_SLICE_BATCHES,
		);
		let staged = 0n;
		for (const row of rows) {
			staged = wasm.finalizeDrafts(new Uint8Array(row.bytes as ArrayBuffer));
		}
		const finished = rows.length < FINALIZE_SLICE_BATCHES;
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
			let rowSeq = Number(
				this.sqlAll<{ m: number }>("SELECT COALESCE(MAX(seq), -1) AS m FROM row_batches")[0]?.m ?? -1,
			);
			for (const group of blobGroups(rowBuf)) {
				this.sqlRun(
					"INSERT INTO row_batches (seq, count, bytes) VALUES (?, ?, ?)",
					++rowSeq,
					group.length,
					exactBuffer(lengthPrefixed(group)),
				);
			}
			this.metaSet("finalize_batch_done", String(done + rows.length));
			if (finished) {
				this.metaSet("staged_rows", String(staged));
				this.metaSet("phase", "reorder");
			}
		});
		console.log(`Finalize slice: ${rows.length} batches, ${staged} rows staged${finished ? " (done)" : ""}`);
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
		if (!this.ensureWasmContinuity()) return;
		const staged = Number(this.metaGet("staged_rows") ?? 0);
		if (staged === 0) throw new FatalImportError("reorder: no staged rows");

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
			if (to >= staged) this.metaSet("phase", "build");
		});
		console.log(`Reorder slice: rows ${from}-${to} of ${staged} from ${groupsRead} spill groups`);
	}

	private async stepBuild(): Promise<void> {
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
		console.log(`Build: streaming ${staged} rows from ordered_rows`);
		// One metered read per ordered blob, not per row — charged up front so a
		// killed build cannot spend the allowance invisibly.
		this.prechargeReads(Number(this.sqlAll<{ n: number }>("SELECT COUNT(*) AS n FROM ordered_rows")[0]?.n ?? 0));

		this.sqlRun("DELETE FROM chunk_staging");
		this.sqlRun("DELETE FROM compat_staging");
		let chunkSeq = -1;
		let compatSeq = -1;
		// Stage on the STAGING grid — rows just under the DO's 2MB per-value
		// cap, which is as large as they can be. Publishing to KV shares a grid
		// with nobody (it re-cuts these into ~20MB KV chunks), and the old
		// 40,000-byte grid cost ~1,750 DO row writes per import against a
		// 100k/day budget. At 1.9MB a 70MB store stages in ~37 rows.
		const grid = new GridChunker();
		const stage = (b: Uint8Array) => {
			this.sqlRun("INSERT INTO chunk_staging (seq, bytes) VALUES (?, ?)", ++chunkSeq, exactBuffer(b));
		};
		// The residue archive rides its own grid and its own table. It is written PART WAY through
		// the build — before the search indexes exist, which is what keeps the peak under the wasm
		// cap — so the two streams interleave and cannot share a sequence.
		const compatGrid = new GridChunker();
		const stageCompat = (b: Uint8Array) => {
			this.sqlRun("INSERT INTO compat_staging (seq, bytes) VALUES (?, ?)", ++compatSeq, exactBuffer(b));
		};
		wasm.setHandlers({
			pullRow: lookup,
			onChunk: (b) => {
				for (const chunk of grid.push(b)) stage(chunk);
			},
			onCompatChunk: (b) => {
				for (const chunk of compatGrid.push(b)) stageCompat(chunk);
			},
			onStats: (s) => {
				this.metaSet("build_card_count", String(s.card_count ?? 0));
				this.metaSet("build_printing_count", String(s.printing_count ?? 0));
				this.metaSet("build_store_bytes", String(s.store_bytes ?? 0));
				this.metaSet("build_compat_bytes", String(s.compat_bytes ?? 0));
			},
		});
		const buildStart = Date.now();
		const totalBytes = wasm.buildStoreStream();
		wasm.setHandlers({});
		// Neither archive's tail is likely to be a whole grid chunk.
		for (const chunk of grid.end()) stage(chunk);
		for (const chunk of compatGrid.end()) stageCompat(chunk);
		const heap = wasm.heap();
		console.log(
			`Store built: ${totalBytes} bytes in ${chunkSeq + 1} chunks ` +
				`(+ card-object archive ${this.metaGet("build_compat_bytes") ?? 0} bytes in ${compatSeq + 1}), ` +
				`${Date.now() - buildStart}ms ` +
				`(wasm heap peak ${(heap.peak / 1048576).toFixed(1)}MB, linear memory ${(heap.linear / 1048576).toFixed(1)}MB)`,
		);
		const formatVersion = wasm.formatVersion();
		this.ctx.storage.transactionSync(() => {
			this.metaSet("chunk_count", String(chunkSeq + 1));
			this.metaSet("compat_stage_count", String(compatSeq + 1));
			this.metaSet("built_at", String(Math.floor(Date.now() / 1000)));
			// Recorded HERE so publish never has to ask wasm for it — see the
			// dropGroupWasm below.
			this.metaSet("format_version", String(formatVersion));
			this.metaSet("kv_chunks_published", "0");
			this.metaSet("kv_cursor_seq", "0");
			this.metaSet("kv_cursor_off", "0");
			this.metaSet("kv_compat_published", "0");
			this.metaSet("kv_compat_seq", "0");
			this.metaSet("kv_compat_off", "0");
			this.metaSet("phase", "publish");
		});
		// Release the wasm group NOW rather than after publish. Its linear
		// memory peaks around 75MB and never shrinks, so holding it through
		// publish left a ~20MB assembly buffer and ~15MB of staged rows sharing
		// a 128MB isolate with it — about 111MB, on the one path that runs
		// unattended at 11:17 UTC. Publish needs nothing from wasm now that the
		// format version is in meta.
		dropGroupWasm();
	}

	// ── phase: publish (KV) ────────────────────────────────────────────────────
	//
	// The store goes to KV as a handful of ~20MB chunks plus a manifest, and
	// that is the entire publish. What this replaces was a content-addressed
	// 40,000-byte grid in D1 with hash lookups, reuse accounting and
	// prune-by-reference — machinery that existed solely to keep ~1,800 row
	// writes per store under the free plan's daily quota. Four KV writes a
	// night against a 1,000/day allowance needs none of it.
	//
	// Still sliced across alarms, for CPU rather than quota: each slice
	// assembles ONE ~20MB chunk out of the staged rows and puts it, so no
	// invocation holds more than one chunk or runs long enough to be cut off.
	// The manifest is written last — it is the commit point, and until it
	// lands readers keep serving the previous store.

	private storeKey(): string {
		return `card-store-v${this.metaGet("format_version") ?? 0}-${this.metaGet("built_at")}.store`;
	}

	/** The paired residue archive's key, named off the same build so the two cannot be mismatched. */
	private compatKey(): string {
		return `card-compat-v${this.metaGet("format_version") ?? 0}-${this.metaGet("built_at")}.store`;
	}

	/** Staging-backed reader for assembleChunk (see src/engine/store-kv.ts). */
	private stagedRows(fromSeq: number, limit: number): StagedRow[] {
		return this.sqlAll("SELECT seq, bytes FROM chunk_staging WHERE seq >= ? ORDER BY seq LIMIT ?", fromSeq, limit).map(
			(row) => ({ seq: Number(row.seq), bytes: new Uint8Array(row.bytes as ArrayBuffer) }),
		);
	}

	/** The same, over the residue archive's staging table. */
	private stagedCompatRows(fromSeq: number, limit: number): StagedRow[] {
		return this.sqlAll("SELECT seq, bytes FROM compat_staging WHERE seq >= ? ORDER BY seq LIMIT ?", fromSeq, limit).map(
			(row) => ({ seq: Number(row.seq), bytes: new Uint8Array(row.bytes as ArrayBuffer) }),
		);
	}

	private async stepPublish(): Promise<void> {
		const storeKey = this.storeKey();
		const storeBytes = Number(this.metaGet("build_store_bytes") ?? 0);
		if (!storeBytes) throw new Error("publish: the build recorded no store size");
		const kvTotal = chunkCountFor(storeBytes);
		let published = Number(this.metaGet("kv_chunks_published") ?? 0);

		// A publish that began under the RAW publisher and was interrupted by a
		// deploy would otherwise finish under this one, leaving chunk 0 raw and the
		// rest gzipped — a store no reader can load, described by a manifest whose
		// gzip total counts only the compressed ones. The counter being set while
		// the gzip total is not is exactly that straddle, and the fix is to publish
		// the whole thing again: chunk keys are stable per store, so re-putting
		// from zero is the same idempotent write the retry path already relies on.
		if (published > 0 && this.metaGet("kv_gzip_bytes") === undefined) {
			console.warn(`Publish: ${published} chunk(s) were written uncompressed before a code change; republishing all`);
			this.ctx.storage.transactionSync(() => {
				this.metaSet("kv_chunks_published", "0");
				this.metaSet("kv_cursor_seq", "0");
				this.metaSet("kv_cursor_off", "0");
			});
			published = 0;
		}

		// One chunk per slice. A put that lands but whose marker rolls back (the
		// alarm threw afterwards, the isolate went away) simply re-puts the same
		// key with the same bytes on retry — keys are stable per store, so the
		// write is idempotent and needs no reconciliation.
		if (published < kvTotal) {
			const want = Math.min(KV_CHUNK_BYTES, storeBytes - published * KV_CHUNK_BYTES);
			const { bytes, cursor } = assembleChunk(
				want,
				{ seq: Number(this.metaGet("kv_cursor_seq") ?? 0), off: Number(this.metaGet("kv_cursor_off") ?? 0) },
				(fromSeq, limit) => this.stagedRows(fromSeq, limit),
			);
			// Compressed HERE, inside the slice that publishes it, so the
			// compression unit is the publish unit and the phase stays resumable
			// across alarms with no extra state: a retry recompresses the same raw
			// cut to the same key, which is the idempotence the raw path already had.
			const stored = await gzipBytes(bytes);
			if (stored.byteLength > KV_VALUE_CAP_BYTES) {
				throw new Error(
					`publish: chunk ${published} compressed to ${stored.byteLength} bytes, over KV's ${KV_VALUE_CAP_BYTES} cap`,
				);
			}
			const gzipSoFar = Number(this.metaGet("kv_gzip_bytes") ?? 0) + stored.byteLength;
			await this.env.STORE_KV.put(chunkKey(storeKey, published), stored);
			this.ctx.storage.transactionSync(() => {
				this.metaSet("kv_chunks_published", String(published + 1));
				this.metaSet("kv_cursor_seq", String(cursor.seq));
				this.metaSet("kv_cursor_off", String(cursor.off));
				this.metaSet("kv_gzip_bytes", String(gzipSoFar));
			});
			console.log(
				`Publish slice: KV chunk ${published + 1}/${kvTotal} (${(want / 1048576).toFixed(1)}MB raw -> ` +
					`${(stored.byteLength / 1048576).toFixed(1)}MB gzip) for ${storeKey}`,
			);
			return; // next alarm continues
		}

		// Then the residue archive, on the same one-chunk-per-slice rhythm and with the same
		// idempotent-key property. Before the manifest, because the manifest naming a compat_key
		// whose chunks are not in KV yet is exactly the state a reader must never see.
		const compatKey = this.compatKey();
		const compatBytes = Number(this.metaGet("build_compat_bytes") ?? 0);
		if (!compatBytes) throw new Error("publish: the build recorded no card-object archive size");
		const compatTotal = chunkCountFor(compatBytes);
		const compatPublished = Number(this.metaGet("kv_compat_published") ?? 0);
		if (compatPublished < compatTotal) {
			const want = Math.min(KV_CHUNK_BYTES, compatBytes - compatPublished * KV_CHUNK_BYTES);
			const { bytes, cursor } = assembleChunk(
				want,
				{ seq: Number(this.metaGet("kv_compat_seq") ?? 0), off: Number(this.metaGet("kv_compat_off") ?? 0) },
				(fromSeq, limit) => this.stagedCompatRows(fromSeq, limit),
			);
			const stored = await gzipBytes(bytes);
			if (stored.byteLength > KV_VALUE_CAP_BYTES) {
				throw new Error(
					`publish: card-object chunk ${compatPublished} compressed to ${stored.byteLength} bytes, ` +
						`over KV's ${KV_VALUE_CAP_BYTES} cap`,
				);
			}
			const compatGzipSoFar = Number(this.metaGet("kv_compat_gzip_bytes") ?? 0) + stored.byteLength;
			await this.env.STORE_KV.put(chunkKey(compatKey, compatPublished), stored);
			this.ctx.storage.transactionSync(() => {
				this.metaSet("kv_compat_published", String(compatPublished + 1));
				this.metaSet("kv_compat_seq", String(cursor.seq));
				this.metaSet("kv_compat_off", String(cursor.off));
				this.metaSet("kv_compat_gzip_bytes", String(compatGzipSoFar));
			});
			console.log(
				`Publish slice: card-object chunk ${compatPublished + 1}/${compatTotal} ` +
					`(${(want / 1048576).toFixed(1)}MB raw -> ${(stored.byteLength / 1048576).toFixed(1)}MB gzip) for ${compatKey}`,
			);
			return; // next alarm continues
		}

		// Every chunk is in KV — write the manifest LAST (the commit point).
		const manifest = {
			store_key: storeKey,
			built_at: this.metaGet("built_at") ?? "",
			card_count: Number(this.metaGet("build_card_count") ?? 0),
			printing_count: Number(this.metaGet("build_printing_count") ?? 0),
			upstream_commit: "vendored", // UPSTREAM.lock is a build-time concern; readers ignore this field
			format_version: Number(this.metaGet("format_version") ?? 0),
			content_generation: STORE_CONTENT_GENERATION,
			store_bytes: storeBytes,
			// Present iff compressed (see StoreManifest) — the flag the reader keys off.
			store_gzip_bytes: Number(this.metaGet("kv_gzip_bytes") ?? 0),
			chunk_count: kvTotal,
			compat_key: compatKey,
			compat_bytes: compatBytes,
			compat_gzip_bytes: Number(this.metaGet("kv_compat_gzip_bytes") ?? 0),
			compat_chunk_count: compatTotal,
			source_updated_at: this.metaGet("source_updated_at") ?? undefined,
		};
		await this.env.STORE_KV.put(MANIFEST_KEY, JSON.stringify(manifest));

		// Retention: keep this store and the one before it. The predecessor
		// stays addressable so a reader that started streaming it finishes, and
		// so one bad build can be rolled back by republishing the older
		// manifest. History lives in this DO's own storage — one row, and no
		// metered KV list operations.
		const previous = JSON.parse(this.metaGet("kv_store_history") ?? "[]") as string[];
		const history = [storeKey, ...previous].filter((key, at, all) => all.indexOf(key) === at).slice(0, KEEP_STORES);
		// Both archives, or the residue's chunks leak: they are keyed by their own name, so the
		// store's retention sweep would never touch them.
		const retired = previous.filter((k) => !history.includes(k));
		for (const key of retired.flatMap((k) => [k, k.replace("card-store-v", "card-compat-v")])) {
			// Best effort: a chunk that fails to delete costs 20MB of a 1GB
			// allowance and gets another chance next publish. Never fail a
			// completed publish over cleanup.
			for (let seq = 0; seq < kvTotal + 2; seq++) {
				try {
					await this.env.STORE_KV.delete(chunkKey(key, seq));
				} catch (err) {
					console.warn(`Retention: could not delete ${chunkKey(key, seq)}: ${err}`);
				}
			}
			console.log(`Retention: dropped ${key} from KV`);
		}

		// The store is live and the import is done — there is no phase after
		// publish now that the SQL fallback is gone.
		console.log(
			`Store published to KV: ${storeKey} (${manifest.card_count} cards, ${kvTotal} chunks) ` +
				`+ ${compatKey} (${compatTotal} chunks)`,
		);
		this.ctx.storage.transactionSync(() => {
			this.metaSet("kv_store_history", JSON.stringify(history));
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
			"draft_batches",
			"spill_batches",
			"ordered_rows",
			"row_batches",
			"tagdata_blobs",
			"chunk_staging",
			"compat_staging",
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
