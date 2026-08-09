// The reset that must NOT reset everything.
//
// The import's daily row-spend counters live in the same `meta` table as its
// run bookkeeping, and startImport wipes that table. If the wipe takes the day
// counters with it, every fresh run starts with a fresh allowance and the
// daily budget bounds nothing — which is the exact shape of the bug that
// exhausted a 5,000,000-row/day Durable Objects allowance in one day.
//
// Pins the statement metaClear() issues against a real SQLite.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

const TODAY = "day:2026-08-09";

/** The statement from ImportCoordinator.metaClear(), kept in step by hand. */
function metaClear(db: Database, today: string): void {
	db.run("DELETE FROM meta WHERE key NOT LIKE ? OR (key LIKE ? AND key NOT LIKE ?)", ["day:%", "day:%", `${today}%`]);
}

function seed(): Database {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const rows: [string, string][] = [
		["phase", "build"],
		["retries", "2"],
		["do_rows_read", "98000"],
		["do_rows_written", "1200"],
		[`${TODAY}:read`, "1200000"],
		[`${TODAY}:written`, "9000"],
		["day:2026-08-08:read", "4500000"],
		["day:2026-07-30:read", "12"],
	];
	for (const [key, value] of rows) db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [key, value]);
	return db;
}

const keysIn = (db: Database) =>
	db
		.query<{ key: string }, []>("SELECT key FROM meta ORDER BY key")
		.all()
		.map((r) => r.key);

describe("metaClear", () => {
	test("keeps today's spend, drops run state and previous days", () => {
		const db = seed();
		metaClear(db, TODAY);
		expect(keysIn(db)).toEqual([`${TODAY}:read`, `${TODAY}:written`]);
	});

	test("the surviving totals still carry their values", () => {
		const db = seed();
		metaClear(db, TODAY);
		const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(`${TODAY}:read`);
		expect(row?.value).toBe("1200000");
	});

	test("a run started on a new day starts from zero", () => {
		// The counters are per-date, so the rollover needs no separate reset —
		// tomorrow simply reads a key that was never written.
		const db = seed();
		metaClear(db, "day:2026-08-10");
		expect(keysIn(db)).toEqual([]);
	});

	test("repeated resets are stable", () => {
		const db = seed();
		metaClear(db, TODAY);
		metaClear(db, TODAY);
		expect(keysIn(db)).toEqual([`${TODAY}:read`, `${TODAY}:written`]);
	});
});
