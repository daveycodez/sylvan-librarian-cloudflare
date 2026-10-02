// A gather coordinator judging its own sibling calls (src/engine/gather-health.ts, x45).
//
// DeckGen, 2026-09-29 and 10-01: engine-wnam-p9 and engine-wnam-p10 each answered gathers in 3.2s
// or 6.3s for the life of one isolate, with ~40ms of CPU per gather. Their siblings ran each call
// in milliseconds; some of the coordinator's calls simply reached them ~1s or ~3.1s late. The
// numbers below are the ones the per-second invocation metrics showed.

import { describe, expect, test } from "bun:test";
import {
	GatherHealth,
	gatherHealthOf,
	resetGatherHealthForTests,
	SHED_BASE_MS,
	SHED_MAX_MS,
	type SiblingCallTiming,
	slowGatherLine,
	stallOf,
} from "../../src/engine/gather-health";

const call = (partition: number, ms: number, more: Partial<SiblingCallTiming> = {}): SiblingCallTiming => ({
	partition,
	method: "searchKeys",
	ms,
	acquireMs: 0,
	failed: false,
	...more,
});
/** Ten siblings' phase 1, every call at `ms` except the ones named in `late`. */
const phase1 = (ms: number, late: Record<number, number> = {}) =>
	[0, 1, 2, 3, 4, 5, 6, 7, 8, 10].map((p) => call(p, late[p] ?? ms));

describe("stallOf", () => {
	test("20:43:21 — six siblings at once, p0 and p6 a second late, p4 and p5 three: stalled", () => {
		const verdict = stallOf(phase1(9, { 0: 1_020, 6: 1_050, 4: 3_098, 5: 3_101 }));
		expect(verdict.stalled).toBe(true);
		expect(verdict.medianMs).toBe(9);
		expect(verdict.slow.map((c) => c.partition)).toEqual([5, 4, 6, 0]); // slowest first
	});

	test("one late call among quick ones is enough", () => {
		expect(stallOf([...phase1(8, { 0: 3_098 }), call(3, 6, { method: "fetchRows" })]).stalled).toBe(true);
	});

	test("a healthy gather: every call quick", () => {
		expect(stallOf(phase1(12, { 7: 319 }))).toMatchObject({ stalled: false, slow: [] });
	});

	test("a heavy query is slow in EVERY partition, so the median is slow too: not a stall", () => {
		expect(stallOf(phase1(1_400, { 3: 1_900 })).stalled).toBe(false);
	});

	test("a sibling that spent the time loading its own store was not held up on the way", () => {
		const waking = phase1(10);
		waking[2] = call(2, 2_400, { acquireMs: 2_350 });
		expect(stallOf(waking)).toMatchObject({ stalled: false, slow: [] });
		// ...but a load does not excuse the seconds beyond it.
		waking[2] = call(2, 3_500, { acquireMs: 400 });
		expect(stallOf(waking).stalled).toBe(true);
	});

	test("a failed call that took seconds counts like any other", () => {
		expect(
			stallOf(phase1(10, { 4: 25_000 }).map((c) => (c.partition === 4 ? { ...c, failed: true } : c))).stalled,
		).toBe(true);
	});

	test("a list gather of one or two siblings cannot tell a stall from a slow query: no verdict", () => {
		expect(stallOf([]).stalled).toBeNull();
		expect(stallOf([call(1, 3_100), call(2, 8)]).stalled).toBeNull();
		expect(stallOf([call(1, 3_100), call(2, 8), call(3, 9)]).stalled).toBe(true);
	});
});

describe("GatherHealth", () => {
	const T0 = 1_000_000;

	test("one stalled gather sheds nothing; the second in a row starts a 30s period", () => {
		const health = new GatherHealth();
		expect(health.note(true, T0)).toBeNull();
		expect(health.shedding(T0)).toBe(false);
		expect(health.note(true, T0 + 3_200)).toBe(SHED_BASE_MS);
		expect(health.shedding(T0 + 3_201)).toBe(true);
		expect(health.shedding(T0 + 3_200 + SHED_BASE_MS)).toBe(false);
	});

	test("a clean gather between two stalled ones: no period", () => {
		const health = new GatherHealth();
		health.note(true, T0);
		health.note(false, T0 + 100);
		expect(health.note(true, T0 + 200)).toBeNull();
		expect(health.shedding(T0 + 201)).toBe(false);
	});

	test("a gather with no verdict neither counts nor clears", () => {
		const health = new GatherHealth();
		health.note(true, T0);
		expect(health.note(null, T0 + 100)).toBeNull();
		expect(health.note(true, T0 + 200)).toBe(SHED_BASE_MS);
	});

	test("stalled gathers that finish DURING a period (the abandoned ones) do not extend it", () => {
		const health = new GatherHealth();
		health.note(true, T0);
		health.note(true, T0 + 1);
		const until = health.shedUntil;
		expect(health.note(true, T0 + 3_000)).toBeNull();
		expect(health.shedUntil).toBe(until);
	});

	test("the gather that ends a period stalls again: the next period starts at once and doubles, to five minutes", () => {
		const health = new GatherHealth();
		health.note(true, T0);
		let now = T0 + 1;
		const periods: number[] = [];
		for (let i = 0; i < 6; i++) {
			const period = health.note(true, now) as number;
			periods.push(period);
			now += period; // the period runs out; the next gather is let through and stalls
		}
		expect(periods).toEqual([30_000, 60_000, 120_000, 240_000, SHED_MAX_MS, SHED_MAX_MS]);
	});

	test("a clean gather ends the period at once and resets the doubling", () => {
		const health = new GatherHealth();
		health.note(true, T0);
		health.note(true, T0 + 1);
		health.note(true, T0 + 1 + SHED_BASE_MS); // period 2
		// A hedged gather from another region is never refused, so it probes during the period.
		expect(health.note(false, T0 + 40_000)).toBeNull();
		expect(health.shedding(T0 + 40_001)).toBe(false);
		health.note(true, T0 + 50_000);
		expect(health.note(true, T0 + 53_000)).toBe(SHED_BASE_MS);
	});

	test("the record is kept per object for the life of the isolate", () => {
		resetGatherHealthForTests();
		const p9 = gatherHealthOf("engine-wnam-p9");
		p9.note(true, T0);
		expect(gatherHealthOf("engine-wnam-p9")).toBe(p9);
		expect(gatherHealthOf("engine-wnam-p3").streak).toBe(0);
		resetGatherHealthForTests();
		expect(gatherHealthOf("engine-wnam-p9").streak).toBe(0);
	});
});

describe("slowGatherLine", () => {
	test("names what was late, per phase, and what the object is doing about it", () => {
		const calls = [
			...phase1(9, { 0: 3_098 }),
			call(4, 14, { method: "fetchRows" }),
			call(2, 6, { method: "fetchRows" }),
		];
		const health = new GatherHealth();
		health.note(true, 1_000);
		health.note(true, 5_000);
		expect(
			slowGatherLine("engine-wnam-p9", 3_207, calls, stallOf(calls), health, 5_000, {
				inFlight: 2,
				isolateAgeMs: 912_400,
			}),
		).toBe(
			"[engine-wnam-p9] slow gather: 3207ms, 12 sibling calls, median 9ms; searchKeys worst p0 3098ms, median 9ms; " +
				"fetchRows worst p4 14ms, median 6ms; late: p0 searchKeys 3098ms; stalled=yes streak=2 shedding=30000ms " +
				"inflight=2 isolate=912s",
		);
	});

	test("a slow gather that did not stall says so", () => {
		const calls = phase1(700);
		const line = slowGatherLine("engine-enam-p2", 2_900, calls, stallOf(calls), new GatherHealth(), 0, {
			inFlight: 1,
			isolateAgeMs: 0,
		});
		expect(line).toContain("fetchRows none; late: none; stalled=no streak=0 shedding=no");
	});
});
