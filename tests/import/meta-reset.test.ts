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
		// The recode phase's checkpoint: raw all_cards bytes already re-compressed
		// into stage_members. Run-scoped — a fresh run refetches the dump and must
		// recode it from byte 0, so surviving a reset would make stepRecode skip
		// a prefix of a stream it has not staged.
		["recode_raw_done", "268435456"],
		// The canonical phase's cursor pair and the transform's raw-offset twin:
		// run-scoped like recode's — a fresh run refetches default_cards and
		// all_cards, so a surviving cursor would skip a prefix of streams the
		// run has not staged, and a surviving id count would satisfy the
		// coverage check with last night's ids.
		["canonical_raw_done", "94371840"],
		["canonical_ids", "48000"],
		["transform_raw_offset", "1073741824"],
		// The partition loop's state, fixed at the end of tags: built_at and
		// format_version pin the run's key family, pp_publish carries the chosen
		// N and every partition's publish cursor, agg_partition_started marks
		// whose fresh wasm heap is live. ALL run-scoped — a surviving pp_publish
		// would resume last night's loop against chunk keys derived from a
		// built_at the new run no longer owns, which is the resume-from-stale-
		// cursor bug the single value exists to prevent.
		["built_at", "1755300000"],
		["format_version", "2026081501"],
		["agg_partition_started", "3"],
		[
			"pp_publish",
			'{"partition":3,"step":"publish","partitions":[{"store_bytes":1,"card_count":1,"printing_count":1,"chunk_count":1,"chunks_published":1,"cursor_seq":0,"cursor_off":0,"cut":46000000,"gzip_bytes":1}]}',
		],
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
