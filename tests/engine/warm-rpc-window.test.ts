// What a closed warm-RPC window reports (remote-engine.ts). The summary line was a per-request
// line at DeckGen's traffic — ~100k `n=1` lines a day — so it now needs two samples; the far-floor
// warning is placement evidence and fires on one.

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

	test("one far sample still raises the placement warning", () => {
		const { log, warn } = warmWindowLines(window({ count: 1, min: 300, max: 300, sum: 300 }), "apac", "SIN", 3_000);
		expect(log).toBeNull();
		expect(warn).toContain("[apac@SIN] warm engine rpc floor is 300ms");
	});

	test("an empty window says nothing at all", () => {
		const { log, warn } = warmWindowLines(window({ min: Number.POSITIVE_INFINITY }), "wnam", "SJC", 3_000);
		expect(log).toBeNull();
		expect(warn).toBeNull();
	});
});
