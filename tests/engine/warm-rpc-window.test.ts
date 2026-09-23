// What a closed warm-RPC window reports (remote-engine.ts). The summary line was a per-request
// line at DeckGen's traffic — ~100k `n=1` lines a day — so it now needs two samples; the far-floor
// warning needs three, since the floor of one or two calls is a query's cost, not distance.

import { describe, expect, test } from "bun:test";
import { type WarmWindow, warmWindowLines } from "../../src/engine/remote-engine";

const window = (over: Partial<WarmWindow>): WarmWindow => ({ start: 1_000, count: 0, min: 0, max: 0, sum: 0, ...over });

describe("a closed warm window", () => {
	test("with one sample reports nothing — the invocation log already has it", () => {
		const { log, warn } = warmWindowLines(window({ count: 1, min: 9, max: 9, sum: 9 }), "enam", "EWR", 3_000);
		expect(log).toBeNull();
		expect(warn).toBeNull();
	});

	test("with two samples reports the summary", () => {
		const { log } = warmWindowLines(window({ count: 2, min: 8, max: 12, sum: 20 }), "enam", "EWR", 3_000);
		expect(log).toBe("[enam@EWR] warm engine rpc: n=2 min=8ms avg=10.0ms max=12ms over 2000ms");
	});

	test("one or two slow calls are a heavy query, not distance — no placement warning", () => {
		// The 2026-09-20..23 false alarms: [wnam@SEA] n=1 min=2048ms, with every wnam object at SEA.
		for (const count of [1, 2]) {
			const { warn } = warmWindowLines(
				window({ count, min: 2048, max: 2048, sum: 2048 * count }),
				"wnam",
				"SEA",
				3_000,
			);
			expect(warn).toBeNull();
		}
	});

	test("three calls that all stay slow are distance, and warn", () => {
		const { warn } = warmWindowLines(window({ count: 10, min: 256, max: 991, sum: 5161 }), "apac", "AMS", 3_000);
		expect(warn).toContain("[apac@AMS] warm engine rpc floor is 256ms");
		const fast = warmWindowLines(window({ count: 10, min: 60, max: 2529, sum: 3356 }), "wnam", "SEA", 3_000);
		expect(fast.warn).toBeNull();
	});

	test("an empty window says nothing at all", () => {
		const { log, warn } = warmWindowLines(window({ min: Number.POSITIVE_INFINITY }), "wnam", "SJC", 3_000);
		expect(log).toBeNull();
		expect(warn).toBeNull();
	});
});
