// The RESUMABLE recode path — checkpointed wasm inflater, per-window state
// rows, fallback routing — driven through the same import-recode machinery
// ImportCoordinator uses, against a real SQLite standing in for the Durable
// Object's, with the coordinator's SQL mirrored by hand (the meta-reset
// pattern; keep in step with stepRecode/stepRecodeResumable/
// stepRecodeFallback and restoreRecodeCheckpoint).
//
// The quiet failures pinned here: a checkpoint that does not correspond to
// the committed window would recut the member grid one byte off and the store
// would build anyway; a checkpoint surviving its transaction's rollback would
// resume a decoder into data it already emitted; a version-stamped layout
// change resuming anyway would misread the window. And throughout: the
// resumable path's members must be BYTE-IDENTICAL to the fallback path's —
// same raw stream, same grid, same gzipBytes — or a mid-phase fallback would
// splice two encodings of one dump.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { gzipBytes } from "../../src/engine/store-kv";
import {
	InflateRecodeSource,
	RECODE_CHECKPOINT_VERSION,
	type RecodeAlarmOptions,
	type RecodeAlarmProgress,
	recodeAlarm,
} from "../../src/import-recode";
import { exactBuffer } from "../../src/import-spill";
import { type InflateHost, instantiate } from "./inflate-host";

/** Scaled-down grid, as in recode.test.ts. */
const MEMBER_RAW = 1024;
const WINDOW_RAW = 4 * MEMBER_RAW;
/** Unit-scaled rate: 1 modeled "second" per member, so budgets read as members. */
const PER_MEMBER = (1024 * 1024 * 1024) / MEMBER_RAW;
const GENEROUS: RecodeAlarmOptions = { budgetSeconds: 1_000_000, gzipSecondsPerGib: PER_MEMBER };

/** Deterministic compressible text, JSONL-shaped like the real dump. */
function makeRaw(bytes: number, seed = 7): Uint8Array {
	let s = seed >>> 0;
	const rand = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const lines: string[] = [];
	let total = 0;
	for (let i = 0; total < bytes; i++) {
		const line = `{"object":"card","seq":${i},"name":"card ${i}","pad":"${"x".repeat(Math.floor(rand() * 40))}"}\n`;
		lines.push(line);
		total += line.length;
	}
	return new TextEncoder().encode(lines.join("")).subarray(0, bytes);
}

const blobParam = (bytes: Uint8Array) => new Uint8Array(exactBuffer(bytes));

interface MemberRow {
	seq: number;
	raw_start: number;
	raw_len: number;
	bytes: Uint8Array;
}

class Harness {
	readonly db = new Database(":memory:");
	readonly kind = "all_cards";
	/** stage_blobs rows FETCHED WHOLE by the resumable source (prefix rows
	 * skipped via LENGTH() are not counted) — the no-prefix-cost instrument. */
	compressedRowsRead = 0;
	/** Which path each stepAlarm took, in order. */
	readonly paths: Array<"resumable" | "fallback"> = [];

	private constructor() {
		this.db.exec(
			`CREATE TABLE stage_blobs (kind TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (kind, seq));
			CREATE TABLE stage_members (
				kind TEXT NOT NULL, seq INTEGER NOT NULL,
				raw_start INTEGER NOT NULL, raw_len INTEGER NOT NULL, bytes BLOB NOT NULL,
				PRIMARY KEY (kind, seq)
			);
			CREATE TABLE recode_checkpoint (
				kind TEXT PRIMARY KEY, version INTEGER NOT NULL,
				raw_done INTEGER NOT NULL, state BLOB NOT NULL
			);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
		);
	}

	static async staged(raw: Uint8Array, blobBytes = 512, gzip = true): Promise<Harness> {
		const h = new Harness();
		const stored = gzip ? await gzipBytes(raw) : raw;
		let seq = -1;
		for (let at = 0; at < stored.length; at += blobBytes) {
			h.db.run("INSERT INTO stage_blobs (kind, seq, bytes) VALUES (?, ?, ?)", [
				h.kind,
				++seq,
				blobParam(stored.subarray(at, Math.min(at + blobBytes, stored.length))),
			]);
		}
		h.metaSet("recode_raw_done", "0");
		return h;
	}

	metaGet(key: string): string | null {
		const row = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
		return row ? row.value : null;
	}

	metaSet(key: string, value: string): void {
		this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
	}

	members(): MemberRow[] {
		return this.db
			.query<MemberRow, [string]>(
				"SELECT seq, raw_start, raw_len, bytes FROM stage_members WHERE kind = ? ORDER BY seq",
			)
			.all(this.kind)
			.map((m) => ({ ...m, bytes: new Uint8Array(m.bytes) }));
	}

	blobCount(): number {
		return (
			this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM stage_blobs WHERE kind = ?").get(this.kind) as {
				n: number;
			}
		).n;
	}

	checkpoint(): { version: number; raw_done: number; state: Uint8Array } | null {
		const row = this.db
			.query<{ version: number; raw_done: number; state: Uint8Array }, [string]>(
				"SELECT version, raw_done, state FROM recode_checkpoint WHERE kind = ?",
			)
			.get(this.kind);
		return row ? { ...row, state: new Uint8Array(row.state) } : null;
	}

	/** ImportCoordinator.stagedIsGzip, mirrored. */
	stagedIsGzip(): boolean {
		const row = this.db
			.query<{ head: Uint8Array }, [string]>(
				"SELECT substr(bytes, 1, 2) AS head FROM stage_blobs WHERE kind = ? AND seq = 0",
			)
			.get(this.kind);
		if (!row) return false;
		const head = new Uint8Array(row.head);
		return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
	}

	/** ImportCoordinator.stagedCompressedBytes, mirrored (LENGTH() first). */
	async *stagedCompressedBytes(fromByte: number): AsyncGenerator<Uint8Array> {
		const sizes = this.db
			.query<{ seq: number; len: number }, [string]>(
				"SELECT seq, LENGTH(bytes) AS len FROM stage_blobs WHERE kind = ? ORDER BY seq",
			)
			.all(this.kind);
		let skip = fromByte;
		for (const { seq, len } of sizes) {
			if (skip >= len) {
				skip -= len;
				continue;
			}
			const row = this.db
				.query<{ bytes: Uint8Array }, [string, number]>("SELECT bytes FROM stage_blobs WHERE kind = ? AND seq = ?")
				.get(this.kind, seq);
			if (!row) throw new Error(`stage blob ${seq} vanished`);
			this.compressedRowsRead += 1;
			const bytes = new Uint8Array(row.bytes);
			yield skip > 0 ? bytes.subarray(skip) : bytes;
			skip = 0;
		}
	}

	/** ImportCoordinator.stagedBlobBytes, mirrored — the fallback source. */
	async *stagedBlobBytes(): AsyncGenerator<Uint8Array> {
		let seq = 0;
		const rowAt = (s: number) =>
			this.db
				.query<{ bytes: Uint8Array }, [string, number]>("SELECT bytes FROM stage_blobs WHERE kind = ? AND seq = ?")
				.get(this.kind, s);
		const raw = new ReadableStream<Uint8Array>({
			pull: (controller) => {
				const row = rowAt(seq);
				if (!row) {
					controller.close();
					return;
				}
				seq += 1;
				controller.enqueue(new Uint8Array(row.bytes));
			},
		});
		const first = rowAt(0);
		const head = first ? new Uint8Array(first.bytes) : new Uint8Array(0);
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

	/** ImportCoordinator.restoreRecodeCheckpoint, mirrored. */
	restoreCheckpoint(rawDone: number, host: InflateHost): number | null {
		if (rawDone === 0) {
			host.begin();
			return 0;
		}
		const row = this.checkpoint();
		if (!row || row.version !== RECODE_CHECKPOINT_VERSION || row.raw_done !== rawDone) return null;
		const compOffset = host.restore(row.state);
		if (compOffset === null || host.totalOut() !== rawDone) return null;
		return compOffset;
	}

	/** One window's commit, exactly as both stepRecode paths run it. */
	private commitWindow(
		window: {
			members: Array<{ seq: number; rawStart: number; rawLen: number; bytes: Uint8Array }>;
			rawStart: number;
			rawEnd: number;
			exhausted: boolean;
		},
		checkpointState: (() => Uint8Array | null) | null,
	): void {
		this.db.transaction(() => {
			this.db.run("DELETE FROM stage_members WHERE kind = ? AND seq >= ?", [
				this.kind,
				Math.floor(window.rawStart / MEMBER_RAW),
			]);
			for (const m of window.members) {
				this.db.run("INSERT INTO stage_members (kind, seq, raw_start, raw_len, bytes) VALUES (?, ?, ?, ?, ?)", [
					this.kind,
					m.seq,
					m.rawStart,
					m.rawLen,
					blobParam(m.bytes),
				]);
			}
			this.metaSet("recode_raw_done", String(window.rawEnd));
			if (checkpointState) this.db.run("DELETE FROM recode_checkpoint WHERE kind = ?", [this.kind]);
			if (window.exhausted) {
				if (!checkpointState) this.db.run("DELETE FROM recode_checkpoint WHERE kind = ?", [this.kind]);
				this.db.run("DELETE FROM stage_blobs WHERE kind = ?", [this.kind]);
				this.metaSet("phase", "fetch:default_cards");
			} else if (checkpointState) {
				const state = checkpointState();
				if (state) {
					this.db.run("INSERT INTO recode_checkpoint (kind, version, raw_done, state) VALUES (?, ?, ?, ?)", [
						this.kind,
						RECODE_CHECKPOINT_VERSION,
						window.rawEnd,
						blobParam(state),
					]);
				}
			}
		})();
	}

	/** ImportCoordinator.stepRecode, mirrored: route, fall back on error. */
	async stepAlarm(opts: RecodeAlarmOptions = {}, killAfter?: number): Promise<RecodeAlarmProgress | null> {
		const rawDone = Number(this.metaGet("recode_raw_done") ?? 0);
		if (this.metaGet("recode_engine_fallback") !== "1" && this.stagedIsGzip()) {
			const host = instantiate();
			const compOffset = this.restoreCheckpoint(rawDone, host);
			if (compOffset !== null) {
				this.paths.push("resumable");
				try {
					return await this.resumableAlarm(rawDone, host, compOffset, opts, killAfter);
				} catch (_err) {
					this.db.run("DELETE FROM recode_checkpoint WHERE kind = ?", [this.kind]);
					this.metaSet("recode_engine_fallback", "1");
					return null; // zero progress this alarm, like the coordinator's early return
				}
			}
		}
		this.paths.push("fallback");
		return await this.fallbackAlarm(rawDone, opts);
	}

	/** ImportCoordinator.stepRecodeResumable, mirrored. */
	private async resumableAlarm(
		rawDone: number,
		host: InflateHost,
		compOffset: number,
		opts: RecodeAlarmOptions,
		killAfter?: number,
	): Promise<RecodeAlarmProgress> {
		const source = new InflateRecodeSource(
			host.resumable(),
			this.stagedCompressedBytes(compOffset)[Symbol.asyncIterator](),
			rawDone,
			opts.memberRaw ?? MEMBER_RAW,
		);
		let committed = 0;
		return await recodeAlarm(
			source.stream(),
			rawDone,
			(window) => {
				if (killAfter !== undefined && committed >= killAfter) throw new Error("simulated mid-alarm kill");
				this.commitWindow(window, () => {
					if (source.produced === window.rawEnd && host.totalOut() === window.rawEnd) return host.save();
					return null;
				});
				committed += 1;
			},
			{ windowRaw: WINDOW_RAW, memberRaw: MEMBER_RAW, resumed: true, ...opts },
		);
	}

	/** ImportCoordinator.stepRecodeFallback, mirrored. */
	private async fallbackAlarm(rawDone: number, opts: RecodeAlarmOptions): Promise<RecodeAlarmProgress> {
		return await recodeAlarm(
			this.stagedBlobBytes(),
			rawDone,
			(window) => {
				this.commitWindow(window, null);
			},
			{ windowRaw: WINDOW_RAW, memberRaw: MEMBER_RAW, ...opts },
		);
	}

	async runToCompletion(opts: RecodeAlarmOptions = GENEROUS, maxAlarms = 50): Promise<number> {
		for (let alarms = 1; alarms <= maxAlarms; alarms++) {
			const progress = await this.stepAlarm(opts);
			if (progress?.exhausted) return alarms;
		}
		throw new Error("recode did not finish");
	}
}

/** 10 full members + one partial: 3 windows, the last one short. */
const RAW_BYTES = 10 * MEMBER_RAW + 360;

/** The oracle: the fallback (DecompressionStream) path, run alone. */
async function fallbackBaseline(raw: Uint8Array): Promise<MemberRow[]> {
	const h = await Harness.staged(raw);
	h.metaSet("recode_engine_fallback", "1");
	await h.runToCompletion();
	expect(h.paths.every((p) => p === "fallback")).toBe(true);
	return h.members();
}

describe("resumable recode", () => {
	test("byte-identical members to the fallback path, checkpoint gone at the end", async () => {
		const raw = makeRaw(RAW_BYTES);
		const baseline = await fallbackBaseline(raw);

		const h = await Harness.staged(raw);
		const alarms = await h.runToCompletion();
		expect(alarms).toBe(1); // generous budget: one alarm, three windows
		expect(h.paths).toEqual(["resumable"]);
		expect(h.members()).toEqual(baseline);
		expect(h.checkpoint()).toBeNull(); // final transaction cleans it up
		expect(h.blobCount()).toBe(0);
		expect(h.metaGet("phase")).toBe("fetch:default_cards");
	});

	test("a budget-stopped alarm leaves a checkpoint matching recode_raw_done, and the next alarm pays no prefix", async () => {
		const raw = makeRaw(RAW_BYTES);
		// Small blob rows, so "how many compressed rows did alarm 2 fetch"
		// has the resolution to distinguish a suffix read from a full re-read.
		const h = await Harness.staged(raw, 128);
		// gzip = 1/member, budget 8 members: exactly 2 windows, then stop.
		const opts: RecodeAlarmOptions = { budgetSeconds: 8, gzipSecondsPerGib: PER_MEMBER };
		const first = await h.stepAlarm(opts);
		expect(first).toEqual({ windows: 2, rawEnd: 8 * MEMBER_RAW, exhausted: false });
		const ckpt = h.checkpoint();
		expect(ckpt?.version).toBe(RECODE_CHECKPOINT_VERSION);
		expect(ckpt?.raw_done).toBe(8 * MEMBER_RAW);
		expect(h.metaGet("recode_raw_done")).toBe(String(8 * MEMBER_RAW));

		// The prefix instrument: alarm 2 must fetch only the compressed rows
		// from the checkpoint's offset on — not the whole prefix again.
		const totalRows = h.blobCount();
		h.compressedRowsRead = 0;
		const second = await h.stepAlarm(opts);
		expect(second?.exhausted).toBe(true);
		expect(h.compressedRowsRead).toBeLessThan(totalRows / 2);
		expect(h.paths).toEqual(["resumable", "resumable"]);

		expect(h.members()).toEqual(await fallbackBaseline(raw));
	});

	test("an alarm killed between window commits retries from the last committed checkpoint", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		// Window 1 commits (with its checkpoint); the kill hits before window 2.
		await expect(h.stepAlarm(GENEROUS, 1)).resolves.toBeNull();
		// The mirrored router treats the kill as a resumable-path failure —
		// but the WINDOW-1 transaction landed, checkpoint and all.
		expect(h.metaGet("recode_raw_done")).toBe(String(4 * MEMBER_RAW));
		expect(h.checkpoint()).toBeNull(); // the failure handler deleted it
		expect(h.metaGet("recode_engine_fallback")).toBe("1");

		// The retry completes on the fallback path from the committed offset.
		await h.runToCompletion();
		expect(h.members()).toEqual(await fallbackBaseline(raw));
	});

	test("a checkpoint from a rolled-back transaction cannot exist: state rides the window transaction", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		const opts: RecodeAlarmOptions = { budgetSeconds: 4, gzipSecondsPerGib: PER_MEMBER };
		await h.stepAlarm(opts); // one window: raw_done 4096, checkpoint 4096
		// Simulate the half-state a torn write would present: meta rewound
		// UNDER the checkpoint (the delete-then-insert test's shape). The
		// checkpoint no longer matches recode_raw_done and must be refused.
		h.metaSet("recode_raw_done", "0");
		const host = instantiate();
		expect(h.restoreCheckpoint(4 * MEMBER_RAW, host)).not.toBeNull(); // sanity: it WOULD restore at its own offset
		expect(h.restoreCheckpoint(0, instantiate())).toBe(0); // raw 0 bootstraps fresh instead
		// And a full phase re-run from the rewound meta still converges.
		await h.runToCompletion();
		expect(h.members()).toEqual(await fallbackBaseline(raw));
	});

	test("a version-stamped checkpoint from other code is refused into the fallback path", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.stepAlarm({ budgetSeconds: 4, gzipSecondsPerGib: PER_MEMBER });
		h.db.run("UPDATE recode_checkpoint SET version = ?", [RECODE_CHECKPOINT_VERSION + 1]);
		await h.runToCompletion();
		expect(h.paths[0]).toBe("resumable");
		expect(h.paths.slice(1).every((p) => p === "fallback")).toBe(true);
		expect(h.members()).toEqual(await fallbackBaseline(raw));
	});

	test("a corrupted state blob is refused into the fallback path", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.stepAlarm({ budgetSeconds: 4, gzipSecondsPerGib: PER_MEMBER });
		const ckpt = h.checkpoint();
		expect(ckpt).not.toBeNull();
		const bad = (ckpt as { state: Uint8Array }).state.slice();
		bad[4] = (bad[4] ?? 0) ^ 0xff; // the wasm-side STATE_VERSION stamp
		h.db.run("UPDATE recode_checkpoint SET state = ?", [blobParam(bad)]);
		await h.runToCompletion();
		expect(h.paths.slice(1).every((p) => p === "fallback")).toBe(true);
		expect(h.members()).toEqual(await fallbackBaseline(raw));
	});

	test("a non-gzip staged dump routes straight to the sniffing fallback", async () => {
		const raw = makeRaw(3 * MEMBER_RAW);
		const h = await Harness.staged(raw, 512, false);
		await h.runToCompletion();
		expect(h.paths.every((p) => p === "fallback")).toBe(true);
		// Members still cut, from the identity stream.
		expect(h.members().length).toBe(3);
	});

	test("mixed paths splice cleanly mid-phase", async () => {
		// Alarm 1 resumable, alarm 2 forced fallback, alarm 3 resumable again
		// (flag cleared, no checkpoint → but rawDone > 0 and no checkpoint
		// means fallback; so re-checkpoint never happens — assert exactly
		// that, then finish and compare bytes).
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		const opts: RecodeAlarmOptions = { budgetSeconds: 4, gzipSecondsPerGib: PER_MEMBER, discardSecondsPerGib: 0 };
		await h.stepAlarm(opts); // resumable, window 1
		h.db.run("DELETE FROM recode_checkpoint"); // lose the checkpoint
		await h.stepAlarm(opts); // mid-phase, no checkpoint → fallback
		expect(h.paths).toEqual(["resumable", "fallback"]);
		await h.runToCompletion(opts);
		expect(h.members()).toEqual(await fallbackBaseline(raw));
	});
});
