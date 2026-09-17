// The staging purge, sliced (src/import-purge.ts, ImportCoordinator.purgeSlice).
//
// Until 2026-09-16 a partition's publish completion deleted its whole staging
// (~300MB of 1.5-1.9MB blob rows across four tables) in ONE transactionSync,
// and the next alarm's first awaited storage read hung behind that commit's
// flush — for hours, until a deploy reset the object. The free account's whole
// Durable Object duration bill was that one object, active every second of
// the day. The purge is now one bounded slice per alarm, and these pin both
// halves: the pure plan, and the exact SQL the coordinator runs, mirrored here
// against bun:sqlite with real-sized blobs the way meta-reset.test.ts mirrors
// metaClear.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { BUCKET_SLICE_BATCHES, PURGE_SLICE_BYTES, PURGE_SLICE_MAX_ROWS } from "../../src/import-budget";
import { PURGE_TABLES, type PurgeTable, planPurgeSlice } from "../../src/import-purge";

const MB = 1024 * 1024;
const ROW = 1_900_000; // a staged row just under the DO's 2MB value cap

describe("planPurgeSlice", () => {
	test("an empty head is nothing to do", () => {
		expect(planPurgeSlice([], PURGE_SLICE_BYTES)).toBeNull();
	});

	test("cuts on the row that first reaches the budget, in key order", () => {
		const rows = [10, 11, 12, 13, 14].map((key) => ({ key, bytes: 10 * MB }));
		// 10 + 10 + 10 = 30MB < 32MB, + 10 = 40MB ≥ 32MB: four rows, cut at key 13.
		expect(planPurgeSlice(rows, PURGE_SLICE_BYTES)).toEqual({ upTo: 13, rows: 4, bytes: 40 * MB });
	});

	test("always takes at least one row, so a row larger than the budget cannot stall the purge", () => {
		expect(planPurgeSlice([{ key: 7, bytes: 5 * MB }], 1 * MB)).toEqual({ upTo: 7, rows: 1, bytes: 5 * MB });
	});

	test("takes the whole head when it fits under the budget", () => {
		const rows = [1, 2].map((key) => ({ key, bytes: ROW }));
		expect(planPurgeSlice(rows, PURGE_SLICE_BYTES)).toEqual({ upTo: 2, rows: 2, bytes: 2 * ROW });
	});
});

describe("the slice budget", () => {
	test("churns no more in one alarm than a bucket slice does, the other big burst the pacing spreads", () => {
		// A bucket slice writes its batches' worth of partition groups and deletes
		// the source batches: ~2 x 16 x 1.9MB. A purge slice only deletes, and at
		// most PURGE_SLICE_BYTES. Both are paced to storage afterwards (PACE_START_BPS).
		expect(PURGE_SLICE_BYTES).toBeLessThanOrEqual(2 * BUCKET_SLICE_BATCHES * ROW);
	});

	test("a full planning read still covers a slice of the smallest staged rows", () => {
		// 64 rows x 1.5MB (BLOB_GROUP_BYTES) is 96MB: the plan never runs out of
		// head before it runs out of budget.
		expect(PURGE_SLICE_MAX_ROWS * 1_500_000).toBeGreaterThan(PURGE_SLICE_BYTES);
	});

	test("the big families go last, and composite keys are scoped so a cut never sweeps unpriced rows", () => {
		for (const tables of Object.values(PURGE_TABLES)) expect(tables.length).toBeGreaterThan(0);
		expect(PURGE_TABLES.partition.at(-1)?.table).toBe("draft_parts");
		expect(PURGE_TABLES.reset.at(-1)?.table).toBe("stage_blobs");
		expect(PURGE_TABLES.partition.find((t) => t.table === "draft_parts")?.scope).toBe("partition");
		expect(PURGE_TABLES.reset.find((t) => t.table === "draft_parts")?.scope).toBe("partition");
		for (const table of ["stage_blobs", "stage_members"]) {
			expect(PURGE_TABLES.reset.find((t) => t.table === table)?.scope).toBe("kind");
		}
	});
});

// ─── the coordinator's SQL, mirrored ─────────────────────────────────────────

/** The statements purgeSlice runs, kept in step by hand (tests/import/meta-reset.test.ts does the same for metaClear). */
function purgeSliceSql(
	db: Database,
	t: PurgeTable,
	partition?: number,
	budgetBytes = PURGE_SLICE_BYTES,
	kinds: readonly string[] | null = null,
): { rows: number; bytes: number } | null {
	let where = "";
	let scopeArgs: (number | string)[] = [];
	if (t.scope) {
		const confined = t.scope === "kind" && kinds ? ` WHERE kind IN (${kinds.map(() => "?").join(", ")})` : "";
		const value =
			t.scope === "partition" && partition !== undefined
				? partition
				: ((
						db
							.query(`SELECT MIN(${t.scope}) AS v FROM ${t.table}${confined}`)
							.get(...(confined ? [...(kinds ?? [])] : [])) as { v: number | string | null } | null
					)?.v ?? null);
		if (value === null || value === undefined) return null;
		where = ` WHERE ${t.scope} = ?`;
		scopeArgs = [value];
	}
	const head = db
		.query(`SELECT ${t.key} AS key, LENGTH(bytes) AS bytes FROM ${t.table}${where} ORDER BY ${t.key} LIMIT ?`)
		.all(...scopeArgs, PURGE_SLICE_MAX_ROWS) as { key: number; bytes: number }[];
	const plan = planPurgeSlice(head, budgetBytes);
	if (!plan) return null;
	db.run(`DELETE FROM ${t.table}${where ? `${where} AND` : " WHERE"} ${t.key} <= ?`, [...scopeArgs, plan.upTo]);
	return { rows: plan.rows, bytes: plan.bytes };
}

function stagingDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE draft_parts (partition INTEGER NOT NULL, seq INTEGER NOT NULL, count INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (partition, seq)) WITHOUT ROWID;
		CREATE TABLE spill_batches (base INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL);
		CREATE TABLE ordered_rows (base INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL);
		CREATE TABLE chunk_staging (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
		CREATE TABLE stage_blobs (kind TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (kind, seq));
	`);
	return db;
}

const count = (db: Database, table: string, where = "") =>
	(db.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;

describe("purgeSlice, against SQLite", () => {
	test("frees at most one budget (plus the crossing row) per slice and empties a table in ceil(total/budget) slices", () => {
		const db = stagingDb();
		const insert = db.prepare("INSERT INTO spill_batches (base, count, bytes) VALUES (?, ?, ?)");
		const n = 40; // 40 x 1.9MB = 76MB
		for (let i = 0; i < n; i++) insert.run(i * 1000, 1, Buffer.alloc(ROW, i));
		const t = PURGE_TABLES.partition.find((x) => x.table === "spill_batches") as PurgeTable;
		let slices = 0;
		const perSlice = Math.ceil(PURGE_SLICE_BYTES / ROW); // 18 rows reach 32MB
		for (;;) {
			const freed = purgeSliceSql(db, t);
			if (!freed) break;
			slices += 1;
			expect(freed.bytes).toBeLessThanOrEqual(PURGE_SLICE_BYTES + ROW);
			expect(freed.rows).toBe(Math.min(perSlice, n - (slices - 1) * perSlice)); // 13, 13, 13, then the tail
		}
		expect(count(db, "spill_batches")).toBe(0);
		expect(slices).toBe(Math.ceil(n / perSlice));
	});

	test("a smaller remaining budget cuts sooner: the alarm's total, not just each delete, stays bounded", () => {
		const db = stagingDb();
		const insert = db.prepare("INSERT INTO chunk_staging (seq, bytes) VALUES (?, ?)");
		for (let seq = 0; seq < 10; seq++) insert.run(seq, Buffer.alloc(ROW));
		const t = PURGE_TABLES.partition.find((x) => x.table === "chunk_staging") as PurgeTable;
		expect(purgeSliceSql(db, t, undefined, 3 * ROW)).toEqual({ rows: 3, bytes: 3 * ROW });
		expect(count(db, "chunk_staging")).toBe(7);
	});

	test("a partition-scoped slice never touches another partition's drafts", () => {
		const db = stagingDb();
		const insert = db.prepare("INSERT INTO draft_parts (partition, seq, count, bytes) VALUES (?, ?, ?, ?)");
		for (let seq = 0; seq < 6; seq++) {
			insert.run(0, seq, 1, Buffer.alloc(ROW, 0));
			insert.run(1, seq, 1, Buffer.alloc(ROW, 1));
		}
		const t = PURGE_TABLES.partition.find((x) => x.table === "draft_parts") as PurgeTable;
		// 6 x 1.9MB = 11.4MB fits one slice: partition 0 goes entirely, 1 stays.
		expect(purgeSliceSql(db, t, 0)).toEqual({ rows: 6, bytes: 6 * ROW });
		expect(count(db, "draft_parts", "WHERE partition = 0")).toBe(0);
		expect(count(db, "draft_parts", "WHERE partition = 1")).toBe(6);
		expect(purgeSliceSql(db, t, 0)).toBeNull();
	});

	test("the reset scope discovers the lowest partition itself and walks them all", () => {
		const db = stagingDb();
		const insert = db.prepare("INSERT INTO draft_parts (partition, seq, count, bytes) VALUES (?, ?, ?, ?)");
		for (const partition of [3, 7]) for (let seq = 0; seq < 2; seq++) insert.run(partition, seq, 1, Buffer.alloc(ROW));
		const t = PURGE_TABLES.reset.find((x) => x.table === "draft_parts") as PurgeTable;
		expect(purgeSliceSql(db, t)).toEqual({ rows: 2, bytes: 2 * ROW }); // partition 3
		expect(count(db, "draft_parts", "WHERE partition = 3")).toBe(0);
		expect(purgeSliceSql(db, t)).toEqual({ rows: 2, bytes: 2 * ROW }); // then 7
		expect(purgeSliceSql(db, t)).toBeNull();
	});

	test("a kind-scoped table (stage_blobs) is walked one kind at a time", () => {
		const db = stagingDb();
		const insert = db.prepare("INSERT INTO stage_blobs (kind, seq, bytes) VALUES (?, ?, ?)");
		for (const kind of ["all_cards", "rulings"])
			for (let seq = 0; seq < 3; seq++) insert.run(kind, seq, Buffer.alloc(ROW));
		const t = PURGE_TABLES.reset.find((x) => x.table === "stage_blobs") as PurgeTable;
		expect(purgeSliceSql(db, t)).toEqual({ rows: 3, bytes: 3 * ROW });
		expect(count(db, "stage_blobs", "WHERE kind = 'all_cards'")).toBe(0);
		expect(count(db, "stage_blobs", "WHERE kind = 'rulings'")).toBe(3);
		expect(purgeSliceSql(db, t)).toEqual({ rows: 3, bytes: 3 * ROW });
		expect(purgeSliceSql(db, t)).toBeNull();
	});

	test("a blobs purge confined to named kinds leaves the other kinds' dumps alone", () => {
		// The recode boundary drops all_cards' raw blobs while default_cards and
		// the tag dumps are still to be read by the phases after it.
		const db = stagingDb();
		const insert = db.prepare("INSERT INTO stage_blobs (kind, seq, bytes) VALUES (?, ?, ?)");
		for (const kind of ["all_cards", "default_cards", "oracle_tags"]) {
			for (let seq = 0; seq < 2; seq++) insert.run(kind, seq, Buffer.alloc(ROW));
		}
		const t = PURGE_TABLES.blobs.find((x) => x.table === "stage_blobs") as PurgeTable;
		expect(purgeSliceSql(db, t, undefined, PURGE_SLICE_BYTES, ["all_cards"])).toEqual({ rows: 2, bytes: 2 * ROW });
		expect(purgeSliceSql(db, t, undefined, PURGE_SLICE_BYTES, ["all_cards"])).toBeNull();
		expect(count(db, "stage_blobs", "WHERE kind = 'all_cards'")).toBe(0);
		expect(count(db, "stage_blobs", "WHERE kind = 'default_cards'")).toBe(2);
		expect(count(db, "stage_blobs", "WHERE kind = 'oracle_tags'")).toBe(2);
		// The tags boundary names three kinds and walks them lowest-first.
		const tags = ["oracle_tags", "art_tags", "oracle_cards"];
		expect(purgeSliceSql(db, t, undefined, PURGE_SLICE_BYTES, tags)).toEqual({ rows: 2, bytes: 2 * ROW });
		expect(count(db, "stage_blobs", "WHERE kind = 'default_cards'")).toBe(2);
		expect(purgeSliceSql(db, t, undefined, PURGE_SLICE_BYTES, tags)).toBeNull();
	});

	test("a slice whose commit was lost re-plans identically: the cut is a function of the head", () => {
		const db = stagingDb();
		const insert = db.prepare("INSERT INTO chunk_staging (seq, bytes) VALUES (?, ?)");
		for (let seq = 0; seq < 20; seq++) insert.run(seq, Buffer.alloc(ROW));
		const t = PURGE_TABLES.partition.find((x) => x.table === "chunk_staging") as PurgeTable;
		const head = () =>
			db
				.query("SELECT seq AS key, LENGTH(bytes) AS bytes FROM chunk_staging ORDER BY seq LIMIT ?")
				.all(PURGE_SLICE_MAX_ROWS) as {
				key: number;
				bytes: number;
			}[];
		const first = planPurgeSlice(head(), PURGE_SLICE_BYTES);
		db.exec("BEGIN");
		purgeSliceSql(db, t);
		db.exec("ROLLBACK");
		expect(count(db, "chunk_staging")).toBe(20);
		expect(planPurgeSlice(head(), PURGE_SLICE_BYTES)).toEqual(first);
	});

	test("LENGTH(bytes) sizes a blob row in bytes, which is what the budget is in", () => {
		const db = stagingDb();
		db.run("INSERT INTO chunk_staging (seq, bytes) VALUES (?, ?)", [0, Buffer.alloc(ROW)]);
		expect((db.query("SELECT LENGTH(bytes) AS n FROM chunk_staging").get() as { n: number }).n).toBe(ROW);
	});
});
