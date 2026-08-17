// The recode phase: re-compressing the staged all_cards dump into
// independently seekable gzip members, and the member-aware stagedBytes that
// consumes them.
//
// The failure modes here are the quiet ones: a resume that recuts the member
// grid one byte off feeds the transform a corrupted line and the store builds
// anyway; a retried slice that appends instead of replacing serves some raw
// span twice. So the round trip is pinned end to end against a real SQLite
// standing in for the Durable Object's, driven through the same import-recode
// functions ImportCoordinator calls, with the coordinator's SQL mirrored by
// hand (the meta-reset pattern).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { gzipBytes } from "../../src/engine/store-kv";
import { MEMBER_RAW_BYTES, memberBytes, RECODE_WINDOW_RAW, recodeWindow, skipBytes } from "../../src/import-recode";
import { exactBuffer } from "../../src/import-spill";

/** Scaled-down grid: same shapes (window a multiple of the member size, a
 * partial final member) at a size a test can afford to gzip repeatedly. */
const MEMBER_RAW = 1024;
const WINDOW_RAW = 4 * MEMBER_RAW;

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

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of gen) {
		parts.push(chunk.slice());
		total += chunk.length;
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** bun:sqlite wants a view for blob params; the DO binds ArrayBuffer. */
const blobParam = (bytes: Uint8Array) => new Uint8Array(exactBuffer(bytes));

interface MemberRow {
	seq: number;
	raw_start: number;
	raw_len: number;
	bytes: Uint8Array;
}

/**
 * The coordinator's staging tables against a real SQLite, driven through the
 * same import-recode functions stepRecode and stagedBytes call. The SQL is
 * mirrored from ImportCoordinator by hand, like meta-reset.test.ts mirrors
 * metaClear — keep them in step.
 */
class Harness {
	readonly db = new Database(":memory:");
	readonly kind: string;
	membersRead = 0;

	private constructor(kind: string) {
		this.kind = kind;
		this.db.exec(
			`CREATE TABLE stage_blobs (kind TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (kind, seq));
			CREATE TABLE stage_members (
				kind TEXT NOT NULL, seq INTEGER NOT NULL,
				raw_start INTEGER NOT NULL, raw_len INTEGER NOT NULL, bytes BLOB NOT NULL,
				PRIMARY KEY (kind, seq)
			);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
		);
	}

	/** Stage `raw` the way stepFetch would: gzipped whole, cut into blob rows. */
	static async staged(raw: Uint8Array, kind = "all_cards", blobBytes = 512, gzip = true): Promise<Harness> {
		const h = new Harness(kind);
		const stored = gzip ? await gzipBytes(raw) : raw;
		let seq = -1;
		for (let at = 0; at < stored.length; at += blobBytes) {
			h.db.run("INSERT INTO stage_blobs (kind, seq, bytes) VALUES (?, ?, ?)", [
				kind,
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

	blobCount(kind = this.kind): number {
		return (
			this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM stage_blobs WHERE kind = ?").get(kind) as {
				n: number;
			}
		).n;
	}

	members(kind = this.kind): MemberRow[] {
		return this.db
			.query<MemberRow, [string]>(
				"SELECT seq, raw_start, raw_len, bytes FROM stage_members WHERE kind = ? ORDER BY seq",
			)
			.all(kind)
			.map((m) => ({ ...m, bytes: new Uint8Array(m.bytes) }));
	}

	/** ImportCoordinator.stagedBlobBytes, mirrored: gzip sniffed by magic. */
	async *stagedBlobBytes(kind = this.kind): AsyncGenerator<Uint8Array> {
		let seq = 0;
		const rowAt = (s: number) =>
			this.db
				.query<{ bytes: Uint8Array }, [string, number]>("SELECT bytes FROM stage_blobs WHERE kind = ? AND seq = ?")
				.get(kind, s);
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

	/** One recode slice, exactly as stepRecode commits it. Returns exhausted. */
	async recodeSlice(windowRaw = WINDOW_RAW, memberRaw = MEMBER_RAW): Promise<boolean> {
		const rawDone = Number(this.metaGet("recode_raw_done") ?? 0);
		const { members, rawEnd, exhausted } = await recodeWindow(this.stagedBlobBytes(), rawDone, windowRaw, memberRaw);
		this.db.transaction(() => {
			this.db.run("DELETE FROM stage_members WHERE kind = ? AND seq >= ?", [
				this.kind,
				Math.floor(rawDone / memberRaw),
			]);
			for (const m of members) {
				this.db.run("INSERT INTO stage_members (kind, seq, raw_start, raw_len, bytes) VALUES (?, ?, ?, ?, ?)", [
					this.kind,
					m.seq,
					m.rawStart,
					m.rawLen,
					blobParam(m.bytes),
				]);
			}
			this.metaSet("recode_raw_done", String(rawEnd));
			if (exhausted) {
				this.db.run("DELETE FROM stage_blobs WHERE kind = ?", [this.kind]);
				this.metaSet("phase", "fetch:default_cards");
			}
		})();
		return exhausted;
	}

	async recodeAll(windowRaw = WINDOW_RAW, memberRaw = MEMBER_RAW): Promise<number> {
		let slices = 0;
		for (;;) {
			slices += 1;
			if (await this.recodeSlice(windowRaw, memberRaw)) return slices;
		}
	}

	/** ImportCoordinator.stagedBytes, mirrored: member seek, blob fallback. */
	async *stagedBytes(kind = this.kind, fromRawOffset = 0): AsyncGenerator<Uint8Array> {
		const start = this.db
			.query<{ seq: number; raw_start: number }, [string, number]>(
				"SELECT seq, raw_start FROM stage_members WHERE kind = ? AND raw_start <= ? ORDER BY seq DESC LIMIT 1",
			)
			.get(kind, fromRawOffset);
		if (start) {
			yield* memberBytes(
				(seq) => {
					const row = this.db
						.query<{ bytes: Uint8Array }, [string, number]>(
							"SELECT bytes FROM stage_members WHERE kind = ? AND seq = ?",
						)
						.get(kind, seq);
					if (!row) return null;
					this.membersRead += 1;
					return new Uint8Array(row.bytes);
				},
				start.seq,
				fromRawOffset - start.raw_start,
			);
			return;
		}
		yield* skipBytes(this.stagedBlobBytes(kind), fromRawOffset);
	}
}

/** 10 full members + one partial: 3 windows, the last one short. */
const RAW_BYTES = 10 * MEMBER_RAW + 360;

describe("recode round trip", () => {
	test("the members reassemble to the exact staged bytes", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		const slices = await h.recodeAll();
		expect(slices).toBe(3); // 4 + 4 + 3 members
		expect(await collect(h.stagedBytes())).toEqual(raw);
	});

	test("the member grid is contiguous, seq-derived, and partial only at the end", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.recodeAll();
		const members = h.members();
		expect(members.length).toBe(11);
		let expectStart = 0;
		for (const m of members) {
			expect(m.raw_start).toBe(expectStart);
			expect(m.seq).toBe(m.raw_start / MEMBER_RAW);
			expectStart += m.raw_len;
		}
		expect(expectStart).toBe(RAW_BYTES);
		for (const m of members.slice(0, -1)) expect(m.raw_len).toBe(MEMBER_RAW);
		expect(members.at(-1)?.raw_len).toBe(360);
	});

	test("each member is its own complete gzip stream", async () => {
		// The whole point of the recode: a consumer must be able to start at any
		// member without the ones before it. Decompress each in isolation.
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.recodeAll();
		for (const m of h.members()) {
			const alone = await collect(memberBytes((seq) => (seq === m.seq ? m.bytes : null), m.seq, 0));
			expect(alone).toEqual(raw.subarray(m.raw_start, m.raw_start + m.raw_len));
		}
	});

	test("a stream that ends exactly on a window boundary still terminates", async () => {
		// The last full window returns exhausted=false; the extra slice must
		// produce zero members, report exhausted, and take the transition.
		const raw = makeRaw(2 * WINDOW_RAW);
		const h = await Harness.staged(raw);
		expect(await h.recodeSlice()).toBe(false);
		expect(await h.recodeSlice()).toBe(false);
		expect(await h.recodeSlice()).toBe(true);
		expect(h.members().length).toBe(8);
		expect(await collect(h.stagedBytes())).toEqual(raw);
	});
});

describe("recode resume and retry", () => {
	test("a slice killed before its transaction resumes to identical members", async () => {
		const raw = makeRaw(RAW_BYTES);
		const whole = await Harness.staged(raw);
		await whole.recodeAll();

		const killed = await Harness.staged(raw);
		await killed.recodeSlice(); // slice 1 lands
		// Slice 2 is killed mid-flight: the window is computed but its
		// transaction never runs — exactly what a CPU kill leaves behind.
		await recodeWindow(killed.stagedBlobBytes(), Number(killed.metaGet("recode_raw_done")), WINDOW_RAW, MEMBER_RAW);
		await killed.recodeAll(); // the retry runs the same slice, then finishes

		expect(killed.members()).toEqual(whole.members());
	});

	test("a rewound checkpoint replaces members instead of duplicating them", async () => {
		// The delete-seq>=resume-point guard: members from a later window must
		// not survive a slice re-run from an earlier checkpoint (the half-state
		// a restored backup or a torn meta write would present).
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.recodeSlice();
		await h.recodeSlice();
		h.metaSet("recode_raw_done", String(WINDOW_RAW)); // rewind over slice 2
		await h.recodeAll();

		const whole = await Harness.staged(raw);
		await whole.recodeAll();
		expect(h.members()).toEqual(whole.members());
	});

	test("re-running the whole phase from zero is idempotent", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.recodeAll();
		const first = h.members();
		// stage_blobs are gone (purged by the final slice), so re-stage them the
		// way a full phase retry after a fetch restart would.
		const restaged = await gzipBytes(raw);
		let seq = -1;
		for (let at = 0; at < restaged.length; at += 512) {
			h.db.run("INSERT INTO stage_blobs (kind, seq, bytes) VALUES (?, ?, ?)", [
				h.kind,
				++seq,
				blobParam(restaged.subarray(at, Math.min(at + 512, restaged.length))),
			]);
		}
		h.metaSet("recode_raw_done", "0");
		await h.recodeAll();
		expect(h.members()).toEqual(first);
	});

	test("a misaligned checkpoint is rejected, not silently regridded", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		expect(recodeWindow(h.stagedBlobBytes(), 17, WINDOW_RAW, MEMBER_RAW)).rejects.toThrow(/member boundary/);
	});

	test("a window that is not a multiple of the member size is rejected", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		expect(recodeWindow(h.stagedBlobBytes(), 0, MEMBER_RAW * 2 + 1, MEMBER_RAW)).rejects.toThrow(/multiple/);
	});
});

describe("purge on transition", () => {
	test("the final slice drops the original stage blobs and advances the phase", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.recodeSlice();
		expect(h.blobCount()).toBeGreaterThan(0); // mid-phase: input still owned
		expect(h.metaGet("phase")).toBeNull();
		await h.recodeAll();
		expect(h.blobCount()).toBe(0);
		expect(h.metaGet("phase")).toBe("fetch:default_cards");
		// The members are complete despite the input being gone.
		expect(await collect(h.stagedBytes())).toEqual(raw);
	});

	test("transform completion purges all_cards members and only those", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.recodeAll();
		// Another kind's members must survive the purge untouched.
		h.db.run("INSERT INTO stage_members (kind, seq, raw_start, raw_len, bytes) VALUES (?, ?, ?, ?, ?)", [
			"other_kind",
			0,
			0,
			3,
			blobParam(Uint8Array.from([1, 2, 3])),
		]);
		// The statement from stepTransform's completion transaction, kept in
		// step by hand (the meta-reset pattern).
		h.db.run("DELETE FROM stage_members WHERE kind = ?", ["all_cards"]);
		expect(h.members("all_cards").length).toBe(0);
		expect(h.members("other_kind").length).toBe(1);
	});
});

describe("stagedBytes seeks", () => {
	test("every offset yields exactly the raw suffix, across member boundaries", async () => {
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.recodeAll();
		const offsets = [
			0,
			1,
			MEMBER_RAW - 1,
			MEMBER_RAW, // exactly on a boundary
			MEMBER_RAW + 1,
			2 * MEMBER_RAW + 511, // mid-member, later window
			WINDOW_RAW, // exactly on a window boundary
			RAW_BYTES - 1,
			RAW_BYTES, // one past the end: empty, not an error
		];
		for (const offset of offsets) {
			expect(await collect(h.stagedBytes("all_cards", offset))).toEqual(raw.subarray(offset));
		}
	});

	test("a deep offset reads only the members from its seek point on", async () => {
		// The point of the phase: the resume cost is the tail, not the prefix.
		const raw = makeRaw(RAW_BYTES);
		const h = await Harness.staged(raw);
		await h.recodeAll();
		h.membersRead = 0;
		await collect(h.stagedBytes("all_cards", 9 * MEMBER_RAW + 5));
		// Members 9 and 10, plus the probe for the nonexistent member 11.
		expect(h.membersRead).toBe(2);
	});

	test("a non-recoded kind keeps the blob path, offset included", async () => {
		const raw = makeRaw(3000);
		const h = await Harness.staged(raw, "default_cards");
		expect(await collect(h.stagedBytes("default_cards", 0))).toEqual(raw);
		expect(await collect(h.stagedBytes("default_cards", 1234))).toEqual(raw.subarray(1234));
	});

	test("gzip-magic sniffing survives for non-gzipped staged dumps", async () => {
		// The fixture path stepFetch never produces but stagedBlobBytes has
		// always tolerated: plain bytes pass through undecompressed.
		const raw = makeRaw(3000);
		const h = await Harness.staged(raw, "oracle_tags", 512, false);
		expect(await collect(h.stagedBytes("oracle_tags", 0))).toEqual(raw);
	});
});

describe("production constants", () => {
	test("the window is a whole number of members", () => {
		expect(RECODE_WINDOW_RAW % MEMBER_RAW_BYTES).toBe(0);
	});
});
