// The canonical phase's persistence shape, pinned against a real SQLite with
// the coordinator's SQL mirrored by hand (the meta-reset / recode pattern).
//
// Two contracts live in stepCanonical's transactions and nowhere a pure
// function can reach:
//   1. The snapshot+cursor pair commits ATOMICALLY per slice — a retried slice
//      restores exactly the set its cursor describes, so accumulation across
//      transient wasm instances cannot drift, and the snapshot survives the
//      byte-capped row split (tagdata_blobs holds 1.9MB cuts, reassembled in
//      seq order).
//   2. Completion fires the progressive staging purge: default_cards'
//      stage_blobs drop IN THE SAME transaction that advances the phase —
//      and only default_cards', because the tags phase still needs its dumps.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { exactBuffer } from "../../src/import-spill";

/** Scaled-down STAGE_BLOB_BYTES: same row-split shape at test size. */
const BLOB_CAP = 64;

function db(): Database {
	const d = new Database(":memory:");
	d.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE stage_blobs (kind TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (kind, seq));
		CREATE TABLE tagdata_blobs (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL)`);
	return d;
}

const blobParam = (bytes: Uint8Array) => new Uint8Array(exactBuffer(bytes));

/** ImportCoordinator.writeTagSnapshot, kept in step by hand. */
function writeTagSnapshot(d: Database, blobs: Uint8Array[]): void {
	d.run("DELETE FROM tagdata_blobs");
	let seq = -1;
	for (const blob of blobs) {
		for (let at = 0; at < blob.length; at += BLOB_CAP) {
			d.run("INSERT INTO tagdata_blobs (seq, bytes) VALUES (?, ?)", [
				++seq,
				blobParam(blob.subarray(at, Math.min(at + BLOB_CAP, blob.length))),
			]);
		}
	}
}

/** ImportCoordinator.tagSnapshotBytes, kept in step by hand. */
function tagSnapshotBytes(d: Database): Uint8Array | null {
	const rows = d.query<{ bytes: Uint8Array }, []>("SELECT bytes FROM tagdata_blobs ORDER BY seq").all();
	if (rows.length === 0) return null;
	const total = rows.reduce((n, r) => n + r.bytes.byteLength, 0);
	const merged = new Uint8Array(total);
	let at = 0;
	for (const r of rows) {
		merged.set(new Uint8Array(r.bytes), at);
		at += r.bytes.byteLength;
	}
	return merged;
}

/** stepCanonical's per-slice transaction (mid-phase and completion shapes). */
function canonicalSliceTxn(
	d: Database,
	snapshot: Uint8Array,
	rawDone: number,
	consumed: number,
	exhausted: boolean,
): void {
	const txn = d.transaction(() => {
		writeTagSnapshot(d, [snapshot]);
		d.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('canonical_raw_done', ?)", [String(rawDone + consumed)]);
		if (exhausted) {
			d.run("DELETE FROM stage_blobs WHERE kind = ?", ["default_cards"]);
			d.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('phase', 'transform')", []);
		}
	});
	txn();
}

const meta = (d: Database, key: string) =>
	d.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value;

describe("canonical phase persistence", () => {
	test("a snapshot larger than the row cap reassembles bit-exactly for the next slice", () => {
		const d = db();
		const snapshot = new Uint8Array(BLOB_CAP * 2 + 17).map((_, i) => i % 251);
		canonicalSliceTxn(d, snapshot, 0, 4096, false);
		expect(d.query("SELECT COUNT(*) AS n FROM tagdata_blobs").get()).toEqual({ n: 3 });
		expect(tagSnapshotBytes(d)).toEqual(snapshot);
		expect(meta(d, "canonical_raw_done")).toBe("4096");
		expect(meta(d, "phase")).toBeUndefined(); // mid-phase: no advance, no purge
	});

	test("the next slice's snapshot REPLACES the previous one, never appends to it", () => {
		// The bug shape this pins out: a second slice's rows landing after the
		// first's would restore a corrupted concatenation of two snapshots.
		const d = db();
		canonicalSliceTxn(d, new Uint8Array(BLOB_CAP + 5).fill(1), 0, 100, false);
		const second = new Uint8Array(9).fill(2);
		canonicalSliceTxn(d, second, 100, 50, false);
		expect(tagSnapshotBytes(d)).toEqual(second);
		expect(meta(d, "canonical_raw_done")).toBe("150");
	});

	test("completion purges default_cards' staged blobs — and only those", () => {
		const d = db();
		for (const [kind, seq] of [
			["default_cards", 0],
			["default_cards", 1],
			["oracle_tags", 0],
			["rulings", 0],
		] as const) {
			d.run("INSERT INTO stage_blobs (kind, seq, bytes) VALUES (?, ?, ?)", [kind, seq, blobParam(new Uint8Array(8))]);
		}
		canonicalSliceTxn(d, new Uint8Array(4), 150, 60, true);
		const kinds = d
			.query<{ kind: string }, []>("SELECT DISTINCT kind FROM stage_blobs ORDER BY kind")
			.all()
			.map((r) => r.kind);
		// The purge fires with the phase advance, in one transaction: the run
		// either still owns the dump or no longer needs it, never neither.
		expect(kinds).toEqual(["oracle_tags", "rulings"]);
		expect(meta(d, "phase")).toBe("transform");
		expect(meta(d, "canonical_raw_done")).toBe("210");
	});
});
