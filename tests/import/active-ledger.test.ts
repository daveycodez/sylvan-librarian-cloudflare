// The run's meters row (src/import-budget.ts, ImportCoordinator.flushMeters):
// rows read and written, alarms, and ACTIVE TIME — the free plan's duration
// meter, which the row meters never saw.
//
// A Durable Object is billed for every second it is active — a request, an
// alarm, or any pending I/O — against 13,000 GB-s a day on the free plan. On
// 2026-09-15 one wedged ImportCoordinator was active 93,072 seconds of the day,
// 11,913 GB-s, with no meter anywhere to say so. Every alarm now banks its wall
// time into the one `run_meters` row, the run fails past MAX_RUN_ACTIVE_MS, and
// the run ends with one line stating what it billed.

import { describe, expect, test } from "bun:test";
import {
	advanceMeters,
	CURRENT_TOLL,
	DO_FREE_ACTIVE_SECONDS_PER_DAY,
	DO_FREE_GB_SECONDS_PER_DAY,
	DO_OBJECT_GB,
	EMPTY_RUN_METERS,
	FIXED_ROWS_READ_PER_ALARM,
	FIXED_ROWS_WRITTEN_PER_ALARM,
	MAX_RUN_ACTIVE_MS,
	MERGED_METERS_ROWS_READ_SAVED,
	MERGED_METERS_ROWS_WRITTEN_SAVED,
	parseMeters,
	projectedGbSeconds,
	TOLL_2026_08_28,
} from "../../src/import-budget";

describe("the duration cap, in the object's own units", () => {
	test("a 128MB object has ~101,562 active seconds a day before the free plan cuts it off", () => {
		expect(DO_OBJECT_GB).toBe(0.128);
		expect(Math.floor(DO_FREE_ACTIVE_SECONDS_PER_DAY)).toBe(101_562);
		// The 2026-09-15 measurement, reproduced: 93,072 s active is 11,913 GB-s.
		expect(Math.round(projectedGbSeconds(93_072_000))).toBe(11_913);
		expect(projectedGbSeconds(93_072_000) / DO_FREE_GB_SECONDS_PER_DAY).toBeGreaterThan(0.9);
	});

	test("a run's budget is a small fraction of the day, and well above a healthy run", () => {
		// 3h ≈ 1,382 GB-s ≈ 10.6% of the day. A healthy run is under an hour
		// (tests/import/run-budget.test.ts models it).
		expect(projectedGbSeconds(MAX_RUN_ACTIVE_MS) / DO_FREE_GB_SECONDS_PER_DAY).toBeLessThan(0.15);
		expect(MAX_RUN_ACTIVE_MS).toBeGreaterThan(60 * 60_000);
	});

	test("a wedged alarm alone blows the run budget long before it blows the day", () => {
		// The platform kills an alarm at 15 minutes; a coordinator that wedged
		// and was retried would cross the run budget inside twelve retries —
		// if its writes could land, which is why the watchdog exists too.
		expect(MAX_RUN_ACTIVE_MS).toBeLessThan(12 * 15 * 60_000 + 1);
	});
});

describe("the meters row", () => {
	test("banks rows and elapsed time, and counts an alarm once however many times it flushes", () => {
		let m = advanceMeters(null, { rowsRead: 20, rowsWritten: 8, elapsedMs: 1200, newAlarm: true });
		expect(m).toEqual({ rows_read: 20, rows_written: 8, alarms: 1, active_ms: 1200 });
		// prechargeReads flushes mid-alarm: more rows and time, no second alarm.
		m = advanceMeters(m, { rowsRead: 300, rowsWritten: 0, elapsedMs: 300, newAlarm: false });
		expect(m).toEqual({ rows_read: 320, rows_written: 8, alarms: 1, active_ms: 1500 });
		m = advanceMeters(m, { rowsRead: 0, rowsWritten: 0, elapsedMs: 40, newAlarm: true });
		expect(m).toEqual({ rows_read: 320, rows_written: 8, alarms: 2, active_ms: 1540 });
	});

	test("a clock that went backwards banks nothing rather than a negative", () => {
		const m = advanceMeters(EMPTY_RUN_METERS, { rowsRead: 0, rowsWritten: 0, elapsedMs: -20, newAlarm: true });
		expect(m.active_ms).toBe(0);
		expect(m.alarms).toBe(1);
	});

	test("survives the persistence boundary, and garbage reads as an empty row", () => {
		const m = advanceMeters(null, { rowsRead: 5, rowsWritten: 2, elapsedMs: 777, newAlarm: true });
		expect(parseMeters(JSON.stringify(m))).toEqual(m);
		expect(parseMeters(null)).toBeNull();
		expect(parseMeters("")).toBeNull();
		expect(parseMeters("{not json")).toBeNull();
		expect(parseMeters('{"alarms":"x","rows_read":3}')).toEqual({ ...EMPTY_RUN_METERS, rows_read: 3 });
	});
});

describe("what the merged row costs the row meters", () => {
	test("less than the two rows it replaced: one read for both budget checks, one read and one write to bank", () => {
		expect(MERGED_METERS_ROWS_READ_SAVED).toBe(2);
		expect(MERGED_METERS_ROWS_WRITTEN_SAVED).toBe(1);
		expect(FIXED_ROWS_READ_PER_ALARM).toBe(TOLL_2026_08_28.read - MERGED_METERS_ROWS_READ_SAVED);
		expect(FIXED_ROWS_WRITTEN_PER_ALARM).toBe(TOLL_2026_08_28.written - MERGED_METERS_ROWS_WRITTEN_SAVED);
		expect(CURRENT_TOLL).toEqual({ read: FIXED_ROWS_READ_PER_ALARM, written: FIXED_ROWS_WRITTEN_PER_ALARM });
	});
});
