// ImportCoordinator: a plain SQLite-backed Durable Object that runs the whole
// nightly/bootstrap store import on-platform — no container, no external CI.
//
// One named instance ("singleton") serializes runs. Triggers:
//   - nightly cron (src/index.ts scheduled handler)
//   - first-request bootstrap (src/engine/store.ts, when D1 has no manifest)
// Both call /start-import; a run already in flight makes that a no-op.
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
//   publish   chunks + manifest to D1 (manifest LAST — it is the commit
//             point readers act on), prune old stores, clear staging
//
// Restart safety: every phase's inputs live in this DO's SQLite, and phase
// progress commits transactionally with its outputs. Phases whose state lives
// inside the wasm heap (tags/agg/finalize interners) record the wasm
// instance nonce; if the DO was evicted mid-group, the group restarts from
// its SQLite inputs — minutes of redone compute, never a wrong store.

import { DurableObject } from "cloudflare:workers";
import { dropGroupWasm, groupWasm, newGroupWasm, transientWasm } from "./engine/import-wasm";
import type { Env } from "./engine/types";
import {
	cardsRowValues,
	ensureCardsSchema,
	execCardsUpserts,
	execVolatileUpdates,
	structuralHash,
} from "./fallback/cards-sync";

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
/** Store chunks copied to D1 per publish slice (staying inside subrequest limits). */
const PUBLISH_SLICE_CHUNKS = 20;

/** Drafts per SQLite batch row (~1.5MB of draft JSON, under the 2MB value cap). */
const DRAFTS_PER_BATCH = 1_000;
/** SQLite blob row size for staged dumps and tag-data snapshots. */
const STAGE_BLOB_BYTES = 1_900_000;
/** Lines per wasm transform call within a slice. */
const LINES_PER_CALL = 2_000;
/** Published store versions kept in D1 for isolates mid-swap. */
const KEEP_STORES = 3;
/** Row batches examined per cards-sync slice (~4k rows of JSON parsing). */
const CARDS_SYNC_BATCHES = 4;
/** Cards-table rows upserted per import run (override: CARDS_WRITE_BUDGET
 * var — paid plans can set it above the corpus size to fill in one run).
 * Each row costs ~2 metered D1 writes (row + PK index; the table carries no
 * secondary indexes for exactly this reason) against the free plan's
 * ~100k/day shared with the chunk publish — so the first fill of ~100k
 * printings spans two-to-three nightly runs. Steady-state deltas are tiny:
 * daily price/EDHREC churn is excluded from the structural hash and synced
 * separately with whatever budget remains (see VOLATILE_COLUMNS). */
const CARDS_WRITE_BUDGET = 45_000;
/** Rows whose volatile columns are refreshed per run once the table is
 * complete (~1 metered write each; full price-refresh cycle ≈ a week). */
const VOLATILE_REFRESH_ROWS = 12_000;
/** JsonlStream parity: parse-coverage hard-failure thresholds (bulk.rs). */
const PARSE_COVERAGE_MIN_BYTES = 1_000_000;
const PARSE_COVERAGE_THRESHOLD = 0.8;

/** Overridable for tests and self-hosted mirrors (SCRYFALL_BULK_URL var). */
const BULK_DATA_URL = "https://api.scryfall.com/bulk-data";
const DUMP_KINDS = ["default_cards", "oracle_tags", "art_tags"] as const;
type DumpKind = (typeof DUMP_KINDS)[number];

type Phase =
	| "idle"
	| "listing"
	| `fetch:${DumpKind}`
	| "transform"
	| "tags"
	| "agg"
	| "finalize"
	| "build"
	| "publish"
	| "cards";

/** `sylvan-librarian-worker/<YYYYMMDD>` — Scryfall rejects default UAs. */
function userAgent(): string {
	const d = new Date();
	const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
	return `sylvan-librarian-worker/${stamp}`;
}

function lengthPrefixed(blobs: Uint8Array[]): Uint8Array {
	const total = blobs.reduce((n, b) => n + 4 + b.length, 0);
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	let at = 0;
	for (const b of blobs) {
		dv.setUint32(at, b.length, true);
		out.set(b, at + 4);
		at += 4 + b.length;
	}
	return out;
}

function splitBatch(batch: Uint8Array): Uint8Array[] {
	const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
	const out: Uint8Array[] = [];
	let at = 0;
	while (at < batch.length) {
		const len = dv.getUint32(at, true);
		out.push(batch.subarray(at + 4, at + 4 + len));
		at += 4 + len;
	}
	return out;
}

/** Copy to an exact ArrayBuffer: SQL/D1 blob params must not be views. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}

export class ImportCoordinator extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(
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
			CREATE TABLE IF NOT EXISTS spill_batches (seq INTEGER PRIMARY KEY, base INTEGER NOT NULL, count INTEGER NOT NULL, bytes BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS row_batches (seq INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS tagdata_blobs (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS chunk_staging (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);`,
		);
	}

	// ── HTTP surface (unchanged contract with store.ts / bootstrap page) ───────

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/start-import":
				return this.startImport(url.searchParams.get("reason") ?? "unspecified");
			case "/status":
				return this.status();
			default:
				return new Response("not found", { status: 404 });
		}
	}

	private async getRun(): Promise<RunRecord> {
		return (await this.ctx.storage.get<RunRecord>("run")) ?? { state: "idle" };
	}

	private async startImport(reason: string): Promise<Response> {
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

		const record: RunRecord = { state: "running", reason, startedAt: new Date().toISOString() };
		this.ctx.storage.transactionSync(() => {
			this.resetStaging();
			this.metaClear();
			this.metaSet("phase", "listing");
		});
		await this.ctx.storage.put("run", record);
		await this.ctx.storage.setAlarm(Date.now());
		return Response.json({ ok: true, run: record }, { status: 202 });
	}

	private async status(): Promise<Response> {
		const run = await this.getRun();
		const phase = this.metaGet("phase") ?? "idle";
		const printings = Number(this.metaGet("staged_rows") ?? this.metaGet("drafts_total") ?? 0);
		const detailBits: string[] = [];
		if (phase.startsWith("fetch:")) {
			const kind = phase.slice("fetch:".length);
			const f = this.ctx.storage.sql
				.exec("SELECT fetched_bytes, total_bytes FROM stage_files WHERE kind = ?", kind)
				.toArray()[0];
			if (f) detailBits.push(`${f.fetched_bytes}/${f.total_bytes ?? "?"} bytes`);
		}
		if (phase === "transform") detailBits.push(`${this.metaGet("lines_done") ?? 0} lines`);
		if (phase === "publish") detailBits.push(`${this.metaGet("chunks_published") ?? 0} chunks`);
		if (phase === "cards") detailBits.push(`${this.metaGet("cards_synced") ?? 0} rows synced`);
		// Same shape the container version exposed; the bootstrap page reads
		// builder.phase and the routes pass the whole object through.
		return Response.json({
			run,
			builder: {
				state: run.state,
				phase: phase === "idle" ? run.state : phase,
				detail: detailBits.join(", ") || undefined,
				printings,
			},
		});
	}

	// ── alarm chain ────────────────────────────────────────────────────────────

	override async alarm(): Promise<void> {
		const run = await this.getRun();
		if (run.state !== "running") return; // stale alarm from a finished run
		const phase = (this.metaGet("phase") ?? "idle") as Phase;
		if (phase === "idle") return;
		try {
			await this.step(phase);
			this.metaSet("retries", "0");
			const next = (this.metaGet("phase") ?? "idle") as Phase;
			if (next !== "idle") {
				await this.ctx.storage.setAlarm(Date.now());
			}
		} catch (err) {
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
				if (phase === "agg" || phase === "finalize" || phase === "build") {
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
		}
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
			case "build":
				return this.stepBuild();
			case "publish":
				return this.stepPublish();
			case "cards":
				return this.stepCards();
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
		const listing = (await res.json()) as { data?: { type?: string; jsonl_download_uri?: string }[] };
		const records = listing.data ?? [];
		this.ctx.storage.transactionSync(() => {
			for (const kind of DUMP_KINDS) {
				const record = records.find((r) => r.type === kind);
				// Mirrors bulk.rs download_uri_from_listing: a missing record or
				// missing jsonl_download_uri is a schema change — fail loudly.
				if (!record?.jsonl_download_uri) {
					throw new Error(`/bulk-data listing has no jsonl_download_uri for ${kind}`);
				}
				this.ctx.storage.sql.exec(
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
		const sql = this.ctx.storage.sql;
		const file = sql.exec("SELECT uri, etag, fetched_bytes, done FROM stage_files WHERE kind = ?", kind).toArray()[0];
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
				sql.exec("DELETE FROM stage_blobs WHERE kind = ?", kind);
				sql.exec("UPDATE stage_files SET fetched_bytes = 0, etag = NULL WHERE kind = ?", kind);
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
				sql.exec("SELECT COALESCE(MAX(seq), -1) AS m FROM stage_blobs WHERE kind = ?", kind).toArray()[0]?.m ?? -1,
			);
			for (const blob of blobs) {
				sql.exec("INSERT INTO stage_blobs (kind, seq, bytes) VALUES (?, ?, ?)", kind, ++seq, blob);
			}
			sql.exec(
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
		const sql = this.ctx.storage.sql;
		let seq = 0;
		const raw = new ReadableStream<Uint8Array>({
			pull(controller) {
				const row = sql.exec("SELECT bytes FROM stage_blobs WHERE kind = ? AND seq = ?", kind, seq).toArray()[0];
				if (!row) {
					controller.close();
					return;
				}
				seq += 1;
				controller.enqueue(new Uint8Array(row.bytes as ArrayBuffer));
			},
		});
		const first = sql.exec("SELECT bytes FROM stage_blobs WHERE kind = ? AND seq = 0", kind).toArray()[0];
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
		const sql = this.ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			let seq = Number(sql.exec("SELECT COALESCE(MAX(seq), -1) AS m FROM draft_batches").toArray()[0]?.m ?? -1);
			let pendingDrafts = this.takePendingDrafts();
			pendingDrafts = pendingDrafts.concat(draftBuf);
			while (pendingDrafts.length >= DRAFTS_PER_BATCH || (exhausted && pendingDrafts.length > 0)) {
				const take = pendingDrafts.splice(0, DRAFTS_PER_BATCH);
				sql.exec(
					"INSERT INTO draft_batches (seq, count, bytes) VALUES (?, ?, ?)",
					++seq,
					take.length,
					exactBuffer(lengthPrefixed(take)),
				);
			}
			this.storePendingDrafts(pendingDrafts);
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
		const stored = this.ctx.storage.sql.exec("SELECT bytes FROM draft_batches WHERE seq = -1").toArray()[0];
		if (!stored) return [];
		this.ctx.storage.sql.exec("DELETE FROM draft_batches WHERE seq = -1");
		return splitBatch(new Uint8Array(stored.bytes as ArrayBuffer)).map((b) => b.slice());
	}

	private storePendingDrafts(drafts: Uint8Array[]): void {
		this.ctx.storage.sql.exec("DELETE FROM draft_batches WHERE seq = -1");
		if (drafts.length > 0) {
			this.ctx.storage.sql.exec(
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
		const tagBlobs: Uint8Array[] = [];
		wasm.setHandlers({ onTagData: (b) => tagBlobs.push(b) });
		wasm.tagsExport();
		wasm.setHandlers({});
		const sql = this.ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			sql.exec("DELETE FROM tagdata_blobs");
			let seq = -1;
			for (const blob of tagBlobs) {
				for (let at = 0; at < blob.length; at += STAGE_BLOB_BYTES) {
					sql.exec(
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
		const rows = this.ctx.storage.sql.exec("SELECT bytes FROM tagdata_blobs ORDER BY seq").toArray();
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
		console.warn("Wasm state lost to eviction; rebuilding tags + aggregation from SQLite");
		const fresh = newGroupWasm();
		fresh.reset();
		this.restoreTags(fresh);
		this.ctx.storage.transactionSync(() => {
			this.metaSet("tags_nonce", fresh.nonce);
			this.metaSet("agg_batch_done", "0");
			this.metaSet("agg_sealed", "0");
			// Any partially-spilled finalize output is invalid with a fresh heap.
			this.ctx.storage.sql.exec("DELETE FROM spill_batches");
			this.ctx.storage.sql.exec("DELETE FROM row_batches");
			this.metaSet("finalize_batch_done", "0");
			this.metaSet("phase", "agg");
		});
		return false;
	}

	// ── phase: agg ─────────────────────────────────────────────────────────────

	private async stepAgg(): Promise<void> {
		if (!this.ensureWasmContinuity()) return;
		const wasm = groupWasm();
		const done = Number(this.metaGet("agg_batch_done") ?? 0);
		const rows = this.ctx.storage.sql
			.exec("SELECT seq, bytes FROM draft_batches WHERE seq >= ? ORDER BY seq LIMIT ?", done, AGG_SLICE_BATCHES)
			.toArray();
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

	/** Byte cap for a persisted blob group (safely under SQLite's 2MB value cap). */
	private static readonly BLOB_GROUP_BYTES = 1_500_000;

	/** Split blobs into groups whose length-prefixed encoding stays under the cap. */
	private static blobGroups(blobs: Uint8Array[]): Uint8Array[][] {
		const groups: Uint8Array[][] = [];
		let group: Uint8Array[] = [];
		let bytes = 0;
		for (const b of blobs) {
			if (group.length > 0 && bytes + 4 + b.length > ImportCoordinator.BLOB_GROUP_BYTES) {
				groups.push(group);
				group = [];
				bytes = 0;
			}
			group.push(b);
			bytes += 4 + b.length;
		}
		if (group.length > 0) groups.push(group);
		return groups;
	}

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
		const rows = this.ctx.storage.sql
			.exec("SELECT seq, bytes FROM draft_batches WHERE seq >= ? ORDER BY seq LIMIT ?", done, FINALIZE_SLICE_BATCHES)
			.toArray();
		let staged = 0n;
		for (const row of rows) {
			staged = wasm.finalizeDrafts(new Uint8Array(row.bytes as ArrayBuffer));
		}
		const finished = rows.length < FINALIZE_SLICE_BATCHES;
		if (finished) staged = wasm.finalizeEnd();
		wasm.setHandlers({});

		const sql = this.ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			// Persist in byte-capped groups: one slice's output (~8k rows of row
			// JSON) far exceeds a single SQLite value's 2MB limit.
			let base = Number(this.metaGet("spill_base") ?? 0);
			let spillSeq = Number(sql.exec("SELECT COALESCE(MAX(seq), -1) AS m FROM spill_batches").toArray()[0]?.m ?? -1);
			for (const group of ImportCoordinator.blobGroups(spillBuf)) {
				sql.exec(
					"INSERT INTO spill_batches (seq, base, count, bytes) VALUES (?, ?, ?, ?)",
					++spillSeq,
					base,
					group.length,
					exactBuffer(lengthPrefixed(group)),
				);
				base += group.length;
			}
			this.metaSet("spill_base", String(base));
			let rowSeq = Number(sql.exec("SELECT COALESCE(MAX(seq), -1) AS m FROM row_batches").toArray()[0]?.m ?? -1);
			for (const group of ImportCoordinator.blobGroups(rowBuf)) {
				sql.exec(
					"INSERT INTO row_batches (seq, count, bytes) VALUES (?, ?, ?)",
					++rowSeq,
					group.length,
					exactBuffer(lengthPrefixed(group)),
				);
			}
			this.metaSet("finalize_batch_done", String(done + rows.length));
			if (finished) {
				this.metaSet("staged_rows", String(staged));
				this.metaSet("phase", "build");
			}
		});
		console.log(`Finalize slice: ${rows.length} batches, ${staged} rows staged${finished ? " (done)" : ""}`);
	}

	// ── phase: build ───────────────────────────────────────────────────────────

	private async stepBuild(): Promise<void> {
		if (!this.ensureWasmContinuity()) return;
		const wasm = groupWasm();
		const sql = this.ctx.storage.sql;

		// Spill-batch directory for pull_row: (base, count, seq), ascending.
		const dir = sql.exec("SELECT seq, base, count FROM spill_batches ORDER BY base").toArray() as {
			seq: number;
			base: number;
			count: number;
		}[];
		const cache = new Map<number, Uint8Array[]>(); // batch seq → split blobs (LRU-ish)
		const lookup = (index: number): Uint8Array | null => {
			// Binary search the directory for the batch containing `index`.
			let lo = 0;
			let hi = dir.length - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				const d = dir[mid];
				if (!d) return null;
				if (index < d.base) hi = mid - 1;
				else if (index >= d.base + d.count) lo = mid + 1;
				else {
					let blobs = cache.get(d.seq);
					if (!blobs) {
						const row = sql.exec("SELECT bytes FROM spill_batches WHERE seq = ?", d.seq).toArray()[0];
						if (!row) return null;
						blobs = splitBatch(new Uint8Array(row.bytes as ArrayBuffer));
						if (cache.size >= 8) {
							const first = cache.keys().next().value;
							if (first !== undefined) cache.delete(first);
						}
						cache.set(d.seq, blobs);
					}
					return blobs[index - d.base] ?? null;
				}
			}
			return null;
		};

		sql.exec("DELETE FROM chunk_staging");
		let chunkSeq = -1;
		wasm.setHandlers({
			pullRow: lookup,
			onChunk: (b) => {
				sql.exec("INSERT INTO chunk_staging (seq, bytes) VALUES (?, ?)", ++chunkSeq, exactBuffer(b));
			},
			onStats: (s) => {
				this.metaSet("build_card_count", String(s.card_count ?? 0));
				this.metaSet("build_printing_count", String(s.printing_count ?? 0));
				this.metaSet("build_store_bytes", String(s.store_bytes ?? 0));
			},
		});
		const buildStart = Date.now();
		const totalBytes = wasm.buildStoreStream();
		wasm.setHandlers({});
		const heap = wasm.heap();
		console.log(
			`Store built: ${totalBytes} bytes in ${chunkSeq + 1} chunks, ${Date.now() - buildStart}ms ` +
				`(wasm heap peak ${(heap.peak / 1048576).toFixed(1)}MB)`,
		);
		this.ctx.storage.transactionSync(() => {
			this.metaSet("chunk_count", String(chunkSeq + 1));
			this.metaSet("built_at", String(Math.floor(Date.now() / 1000)));
			this.metaSet("chunks_published", "0");
			this.metaSet("phase", "publish");
		});
	}

	// ── phase: publish (D1) ────────────────────────────────────────────────────

	private storeKey(): string {
		return `card-store-v${groupWasm().formatVersion()}-${this.metaGet("built_at")}.store`;
	}

	private async stepPublish(): Promise<void> {
		const db = this.env.STORE_DB;
		const sql = this.ctx.storage.sql;
		const published = Number(this.metaGet("chunks_published") ?? 0);
		const chunkCount = Number(this.metaGet("chunk_count") ?? 0);
		const storeKey = this.storeKey();

		if (published === 0) {
			await db.batch([
				db.prepare(
					"CREATE TABLE IF NOT EXISTS store_chunks (store_key TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (store_key, seq))",
				),
				db.prepare(
					"CREATE TABLE IF NOT EXISTS store_manifest (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)",
				),
				db.prepare(
					"CREATE TABLE IF NOT EXISTS store_history (store_key TEXT PRIMARY KEY, published_at INTEGER NOT NULL)",
				),
				// A retried publish must not stack rows under the same key.
				db.prepare("DELETE FROM store_chunks WHERE store_key = ?").bind(storeKey),
			]);
			this.metaSet("chunks_published", "0");
		}

		const rows = sql
			.exec("SELECT seq, bytes FROM chunk_staging WHERE seq >= ? ORDER BY seq LIMIT ?", published, PUBLISH_SLICE_CHUNKS)
			.toArray();
		if (rows.length > 0) {
			const stmt = db.prepare("INSERT INTO store_chunks (store_key, seq, bytes) VALUES (?, ?, ?)");
			await db.batch(rows.map((r) => stmt.bind(storeKey, r.seq, r.bytes as ArrayBuffer)));
			this.metaSet("chunks_published", String(published + rows.length));
			return; // next alarm continues
		}
		if (published < chunkCount) {
			throw new Error(`chunk staging is short: ${published}/${chunkCount}`);
		}

		// Every chunk is in D1 — write the manifest LAST (the commit point),
		// then prune old stores and clear staging.
		const manifest = {
			store_key: storeKey,
			built_at: this.metaGet("built_at") ?? "",
			card_count: Number(this.metaGet("build_card_count") ?? 0),
			printing_count: Number(this.metaGet("build_printing_count") ?? 0),
			upstream_commit: "vendored", // UPSTREAM.lock is a build-time concern; readers ignore this field
			format_version: groupWasm().formatVersion(),
			store_bytes: Number(this.metaGet("build_store_bytes") ?? 0),
			chunk_count: chunkCount,
		};
		await db.batch([
			db.prepare("INSERT OR REPLACE INTO store_manifest (id, json) VALUES (1, ?)").bind(JSON.stringify(manifest)),
			db
				.prepare("INSERT OR REPLACE INTO store_history (store_key, published_at) VALUES (?, ?)")
				.bind(storeKey, Date.now()),
		]);
		// Prune stores older than the KEEP_STORES most recent.
		const old = await db
			.prepare("SELECT store_key FROM store_history ORDER BY published_at DESC LIMIT -1 OFFSET ?")
			.bind(KEEP_STORES)
			.all<{ store_key: string }>();
		for (const row of old.results ?? []) {
			await db.batch([
				db.prepare("DELETE FROM store_chunks WHERE store_key = ?").bind(row.store_key),
				db.prepare("DELETE FROM store_history WHERE store_key = ?").bind(row.store_key),
			]);
		}

		// The store is live. The engine no longer needs the wasm group; the
		// cards-table sync (SQL fallback data) runs next with plain JS.
		dropGroupWasm();
		console.log(`Store published: ${storeKey} (${manifest.card_count} cards)`);
		this.ctx.storage.transactionSync(() => {
			this.metaSet("cards_synced", "0");
			this.metaSet("cards_writes_used", "0");
			this.metaSet("phase", "cards");
		});
	}

	// ── phase: cards (D1 SQL-fallback table sync) ──────────────────────────────
	//
	// Maintains the queryable `cards` table the D1 SQL fallback reads — the
	// same finalized ENGINE_COLUMNS rows the store was built from, hash-diffed
	// so steady-state nightly writes are small, under an explicit write budget
	// (D1 free meters ~100k rows written/day, index maintenance included).
	// The first fill of ~100k printings therefore spans a few nightly runs;
	// fallback_meta.complete flips only when the table matches the import, and
	// the Worker keeps upstream's structured error until then.

	private async stepCards(): Promise<void> {
		const db = this.env.STORE_DB;
		const sql = this.ctx.storage.sql;
		const synced = Number(this.metaGet("cards_synced") ?? 0);
		const writesUsed = Number(this.metaGet("cards_writes_used") ?? 0);
		const staged = Number(this.metaGet("staged_rows") ?? 0);

		if (synced === 0) {
			await ensureCardsSchema(db);
			// Existing content hashes: the diff basis for this sync.
			const existing = await db.prepare("SELECT scryfall_id, row_hash FROM cards").all<{
				scryfall_id: string;
				row_hash: string;
			}>();
			this.cardsHashes = new Map((existing.results ?? []).map((r) => [r.scryfall_id, r.row_hash]));
			this.cardsSeen = new Set();
			await db
				.prepare("INSERT OR REPLACE INTO fallback_meta (id, store_key, complete, synced_rows) VALUES (1, ?, 0, ?)")
				.bind(this.storeKey(), this.cardsHashes.size)
				.run();
		}
		if (!this.cardsHashes || !this.cardsSeen) {
			// Eviction dropped the in-memory diff basis — restart the phase.
			this.metaSet("cards_synced", "0");
			return;
		}

		const writeBudget =
			Number.parseInt((this.env as { CARDS_WRITE_BUDGET?: string }).CARDS_WRITE_BUDGET ?? "", 10) || CARDS_WRITE_BUDGET;
		if (writesUsed >= writeBudget) {
			// Budget exhausted: finish the run with the table incomplete; the
			// next nightly import continues from its own fresh diff.
			await this.finishRun(
				`published ${this.storeKey()}; cards table ${synced}/${staged} rows synced (write budget reached — completes over upcoming imports)`,
			);
			return;
		}

		const batchRows = sql
			.exec(
				"SELECT seq, count, bytes FROM row_batches WHERE seq >= ? ORDER BY seq LIMIT ?",
				Number(this.metaGet("cards_batch_done") ?? 0),
				CARDS_SYNC_BATCHES,
			)
			.toArray();
		let processed = 0;
		let writes = 0;
		const upserts: Record<string, unknown>[] = [];
		for (const batch of batchRows) {
			for (const blob of splitBatch(new Uint8Array(batch.bytes as ArrayBuffer))) {
				const rowJson = new TextDecoder().decode(blob);
				const row = JSON.parse(rowJson) as Record<string, unknown>;
				const id = String(row.scryfall_id);
				this.cardsSeen.add(id);
				// Structural hash only: daily price/EDHREC churn is not a delta.
				const hash = structuralHash(row);
				if (this.cardsHashes.get(id) !== hash) {
					upserts.push(cardsRowValues(row, hash));
					writes++;
				}
				processed++;
			}
		}
		if (upserts.length > 0) {
			await execCardsUpserts(db, upserts);
		}

		const done = batchRows.length < CARDS_SYNC_BATCHES;
		this.ctx.storage.transactionSync(() => {
			this.metaSet("cards_batch_done", String(Number(this.metaGet("cards_batch_done") ?? 0) + batchRows.length));
			this.metaSet("cards_synced", String(synced + processed));
			this.metaSet("cards_writes_used", String(writesUsed + writes));
		});
		if (!done) return;

		// All rows examined: remove cards this import no longer carries, then
		// mark the fallback complete for this store version.
		const stale = await db.prepare("SELECT scryfall_id FROM cards").all<{ scryfall_id: string }>();
		const deletions = (stale.results ?? []).map((r) => r.scryfall_id).filter((id) => !this.cardsSeen?.has(id));
		for (let at = 0; at < deletions.length; at += 50) {
			const slice = deletions.slice(at, at + 50);
			await db.batch(slice.map((id) => db.prepare("DELETE FROM cards WHERE scryfall_id = ?").bind(id)));
		}
		await db
			.prepare("INSERT OR REPLACE INTO fallback_meta (id, store_key, complete, synced_rows) VALUES (1, ?, 1, ?)")
			.bind(this.storeKey(), staged)
			.run();

		// Leftover budget refreshes volatile columns (prices, EDHREC) for a
		// rotating slice of rows — structural sync never sees that churn.
		const leftover = Math.min(VOLATILE_REFRESH_ROWS, Math.max(0, writeBudget - (writesUsed + writes)));
		if (leftover > 0) {
			await this.refreshVolatile(leftover, staged);
		}
		await this.finishRun(
			`published ${this.storeKey()} (${this.metaGet("build_card_count")} cards, ${staged} printings; fallback table complete)`,
		);
	}

	/** Rotate volatile-column refreshes through the corpus, `budget` rows/run. */
	private async refreshVolatile(budget: number, staged: number): Promise<void> {
		if (staged === 0) return;
		const start = Number(this.metaGet("volatile_pos") ?? 0) % staged;
		const wanted = Math.min(budget, staged);
		const picks: Record<string, unknown>[] = [];
		let index = 0;
		// Two passes cover the wrap; row_batches still hold this import's rows.
		for (let pass = 0; pass < 2 && picks.length < wanted; pass++) {
			index = 0;
			for (const batch of this.ctx.storage.sql.exec("SELECT bytes FROM row_batches ORDER BY seq").toArray()) {
				for (const blob of splitBatch(new Uint8Array(batch.bytes as ArrayBuffer))) {
					const inWindow = pass === 0 ? index >= start : index < (start + wanted) % staged && start + wanted > staged;
					if (inWindow && picks.length < wanted) {
						picks.push(JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>);
					}
					index++;
				}
				if (picks.length >= wanted && pass === 0 && start + wanted <= staged) break;
			}
			if (start + wanted <= staged) break; // no wrap needed
		}
		await execVolatileUpdates(this.env.STORE_DB, picks);
		this.metaSet("volatile_pos", String((start + picks.length) % staged));
		console.log(`Volatile refresh: ${picks.length} rows from position ${start}`);
	}

	/** In-memory diff basis for the cards sync (rebuilt if the DO evicts). */
	private cardsHashes: Map<string, string> | null = null;
	private cardsSeen: Set<string> | null = null;

	private async finishRun(detail: string): Promise<void> {
		const run = await this.getRun();
		run.state = "done";
		run.finishedAt = new Date().toISOString();
		run.detail = detail;
		this.ctx.storage.transactionSync(() => {
			this.resetStaging();
			this.metaSet("phase", "idle");
		});
		await this.ctx.storage.put("run", run);
		this.cardsHashes = null;
		this.cardsSeen = null;
		console.log(`Import complete: ${detail}`);
	}

	// ── staging helpers ────────────────────────────────────────────────────────

	private resetStaging(): void {
		const sql = this.ctx.storage.sql;
		for (const table of [
			"stage_files",
			"stage_blobs",
			"draft_batches",
			"spill_batches",
			"row_batches",
			"tagdata_blobs",
			"chunk_staging",
		]) {
			sql.exec(`DELETE FROM ${table}`);
		}
	}

	private metaClear(): void {
		this.ctx.storage.sql.exec("DELETE FROM meta");
	}

	private metaGet(key: string): string | null {
		const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
		return row ? String(row.value) : null;
	}

	private metaSet(key: string, value: string): void {
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
	}
}
