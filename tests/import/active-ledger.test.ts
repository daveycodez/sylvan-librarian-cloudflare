// The run's meters row (src/import-budget.ts, ImportCoordinator.flushMeters):
// rows read and written, alarms, ACTIVE TIME — the free plan's duration meter,
// which the row meters never saw — and the storage churn pacing that rides it.
//
// A Durable Object is billed for every second it is active — a request, an
// alarm, or any pending I/O — against 13,000 GB-s a day on the free plan. On
// 2026-09-15 one ImportCoordinator was active 93,072 seconds of the day,
// 11,913 GB-s, with no meter anywhere to say so; on 2026-09-16 its alarms ran
// ~1,800 s in total while it was billed ~60,000 s, every lost hour sitting
// between an alarm that churned a burst of storage and the next one arriving
// hours late. Every alarm now banks its wall time and its churn into the one
// `run_meters` row and paces the next alarm to the churn.

import { describe, expect, test } from "bun:test";
import {
	adjustPace,
	advanceMeters,
	CURRENT_TOLL,
	DO_FREE_ACTIVE_SECONDS_PER_DAY,
	DO_FREE_GB_SECONDS_PER_DAY,
	DO_OBJECT_GB,
	EMPTY_RUN_METERS,
	FIXED_ROWS_READ_PER_ALARM,
	FIXED_ROWS_WRITTEN_PER_ALARM,
	LATE_ALARM_MS,
	MAX_RUN_ACTIVE_MS,
	MERGED_METERS_ROWS_READ_SAVED,
	MERGED_METERS_ROWS_WRITTEN_SAVED,
	PACE_MAX_BPS,
	PACE_MAX_DELAY_MS,
	PACE_MIN_BPS,
	PACE_START_BPS,
	PACE_STEP_BPS,
	PACE_STEP_MIN_CHURN,
	paceDelayMs,
	parseMeters,
	projectedGbSeconds,
	TOLL_2026_08_28,
} from "../../src/import-budget";

const MB = 1024 * 1024;

describe("the duration cap, in the object's own units", () => {
	test("a 128MB object has ~101,562 active seconds a day before the free plan cuts it off", () => {
		expect(DO_OBJECT_GB).toBe(0.128);
		expect(Math.floor(DO_FREE_ACTIVE_SECONDS_PER_DAY)).toBe(101_562);
		// The 2026-09-15 measurement, reproduced: 93,072 s active is 11,913 GB-s.
		expect(Math.round(projectedGbSeconds(93_072_000))).toBe(11_913);
		expect(projectedGbSeconds(93_072_000) / DO_FREE_GB_SECONDS_PER_DAY).toBeGreaterThan(0.9);
	});

	test("a run's budget is a small fraction of the day, and well above a healthy run", () => {
		expect(projectedGbSeconds(MAX_RUN_ACTIVE_MS) / DO_FREE_GB_SECONDS_PER_DAY).toBeLessThan(0.15);
		expect(MAX_RUN_ACTIVE_MS).toBeGreaterThan(60 * 60_000);
	});
});

describe("the meters row", () => {
	test("banks rows, elapsed time and churn, and counts an alarm once however many times it flushes", () => {
		let m = advanceMeters(null, { rowsRead: 20, rowsWritten: 8, elapsedMs: 1200, newAlarm: true, churnBytes: 5 * MB });
		expect(m).toMatchObject({ rows_read: 20, rows_written: 8, alarms: 1, active_ms: 1200, churn_bytes: 5 * MB });
		// prechargeReads flushes mid-alarm: more rows and time, no second alarm.
		m = advanceMeters(m, { rowsRead: 300, rowsWritten: 0, elapsedMs: 300, newAlarm: false });
		expect(m).toMatchObject({ rows_read: 320, rows_written: 8, alarms: 1, active_ms: 1500, churn_bytes: 5 * MB });
		m = advanceMeters(m, { rowsRead: 0, rowsWritten: 0, elapsedMs: 40, newAlarm: true, churnBytes: MB });
		expect(m).toMatchObject({ alarms: 2, active_ms: 1540, churn_bytes: 6 * MB });
	});

	test("carries the pacing fields through a flush untouched", () => {
		const prev = { ...EMPTY_RUN_METERS, pace_bps: 777_777, due_ms: 1_789_600_000_000, late_alarms: 2 };
		const m = advanceMeters(prev, { rowsRead: 1, rowsWritten: 1, elapsedMs: 1, newAlarm: true });
		expect(m).toMatchObject({ pace_bps: 777_777, due_ms: 1_789_600_000_000, late_alarms: 2 });
	});

	test("a clock that went backwards banks nothing rather than a negative", () => {
		const m = advanceMeters(EMPTY_RUN_METERS, { rowsRead: 0, rowsWritten: 0, elapsedMs: -20, newAlarm: true });
		expect(m.active_ms).toBe(0);
		expect(m.alarms).toBe(1);
	});

	test("survives the persistence boundary; a pre-pacing row and garbage read as defaults", () => {
		const m = {
			...advanceMeters(null, { rowsRead: 5, rowsWritten: 2, elapsedMs: 777, newAlarm: true }),
			pace_bps: 123,
			due_ms: 9,
		};
		expect(parseMeters(JSON.stringify(m))).toEqual(m);
		expect(parseMeters(null)).toBeNull();
		expect(parseMeters("{not json")).toBeNull();
		// The row an in-flight run wrote before pacing shipped: pace unset → start pace.
		expect(parseMeters('{"rows_read":3,"rows_written":1,"alarms":2,"active_ms":10}')).toEqual({
			...EMPTY_RUN_METERS,
			rows_read: 3,
			rows_written: 1,
			alarms: 2,
			active_ms: 10,
		});
	});
});

describe("storage churn pacing", () => {
	test("paces the next alarm to the churn: 32MB at 1MB/s waits ~32s less what the alarm already took", () => {
		expect(paceDelayMs(32 * MB, 0, PACE_START_BPS)).toBe(32_000);
		expect(paceDelayMs(32 * MB, 2_000, PACE_START_BPS)).toBe(30_000);
		expect(paceDelayMs(32 * MB, 40_000, PACE_START_BPS)).toBe(0);
	});

	test("an alarm that churned nothing is not delayed, and no pause exceeds the ceiling", () => {
		expect(paceDelayMs(0, 0, PACE_START_BPS)).toBe(0);
		expect(paceDelayMs(10_000 * MB, 0, PACE_MIN_BPS)).toBe(PACE_MAX_DELAY_MS);
	});

	test("an unset pace paces at the start rate, and a pace below the floor paces at the floor", () => {
		expect(paceDelayMs(8 * MB, 0, 0)).toBe(8_000);
		expect(paceDelayMs(8 * MB, 0, 1)).toBe(Math.round((8 * MB * 1000) / PACE_MIN_BPS));
	});

	test("the start pace sits well under every burst rate that stalled storage on 2026-09-16", () => {
		// ≈4 MB/s fetch, ≈7 MB/s recode, ≈32 MB/s purge bursts all left the next alarm hours late.
		expect(PACE_START_BPS).toBeLessThanOrEqual((4 * MB) / 4);
		expect(PACE_MAX_BPS).toBeLessThan(4 * MB);
	});

	test("a late alarm halves the pace, down to the floor", () => {
		expect(adjustPace(PACE_START_BPS, LATE_ALARM_MS + 1, 0)).toBe(PACE_START_BPS / 2);
		expect(adjustPace(PACE_MIN_BPS, 3_600_000, 0)).toBe(PACE_MIN_BPS);
	});

	test("an on-time alarm that did real churn raises the pace a step, up to the ceiling; a light one holds it", () => {
		expect(adjustPace(PACE_START_BPS, 5_000, PACE_STEP_MIN_CHURN)).toBe(PACE_START_BPS + PACE_STEP_BPS);
		expect(adjustPace(PACE_MAX_BPS, 0, 64 * MB)).toBe(PACE_MAX_BPS);
		expect(adjustPace(PACE_START_BPS, 0, 1024)).toBe(PACE_START_BPS);
		expect(adjustPace(0, 0, 0)).toBe(PACE_START_BPS);
	});

	test("recovering from one late alarm back to the start pace takes a bounded number of on-time alarms", () => {
		let pace = adjustPace(PACE_START_BPS, LATE_ALARM_MS * 10, 0);
		let steps = 0;
		while (pace < PACE_START_BPS) {
			pace = adjustPace(pace, 0, 32 * MB);
			steps += 1;
		}
		expect(steps).toBe(Math.ceil(PACE_START_BPS / 2 / PACE_STEP_BPS));
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
