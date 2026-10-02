// x53: a sibling call still out when its phase's other calls have long answered is sent once more,
// and the gather takes whichever answers first (src/engine/sibling-hedge.ts).
//
// DeckGen, 2026-10-02 05:44–07:25 UTC: 43 stalled gathers, 40 of them coordinated by engine-wnam-p10
// or engine-wnam-p1 with one to four of p0/p4/p5/p6/p7 answering 3.11–3.40s late while the rest
// took a median 8–121ms. Whether the second call arrives sooner is what production has to say; what
// is pinned here is when one is sent, that at most one is, and that the answer and the errors are
// the ones the call would have given alone.
//
// Real timers at a 20ms floor: "late" below is 150ms, "quick" the next tick.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	HedgePhase,
	SIBLING_HEDGE_ENABLED,
	SIBLING_HEDGE_FLOOR_MS,
	SIBLING_HEDGE_PEER_FACTOR,
	SIBLING_HEDGE_QUORUM,
	setSiblingHedgeForTests,
	siblingHedgeLine,
} from "../../src/engine/sibling-hedge";
import { SiblingLimiter } from "../../src/engine/sibling-limit";
import { StaleModulusError } from "../../src/engine/types";

const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const failAfter = (ms: number, error: unknown) =>
	new Promise<never>((_, reject) => setTimeout(() => reject(error), ms));

/** A sibling whose successive sends behave as scripted; the last script repeats. */
function sibling<T>(...sends: (() => Promise<T>)[]) {
	const state = { sent: 0 };
	const send = (): Promise<T> => {
		const script = sends[Math.min(state.sent, sends.length - 1)] as () => Promise<T>;
		state.sent += 1;
		return script();
	};
	return { state, send };
}
const quick = (value: string) => sibling(() => after(0, value));

let restore = () => {};
beforeEach(() => {
	restore = setSiblingHedgeForTests({ floorMs: 20 });
});
afterEach(() => restore());

describe("the tuning production runs with", () => {
	test("on; half the phase answered, 500ms out, four times the answers' median", () => {
		restore();
		expect(SIBLING_HEDGE_ENABLED).toBe(true);
		expect(SIBLING_HEDGE_FLOOR_MS).toBe(500);
		expect(SIBLING_HEDGE_PEER_FACTOR).toBe(4);
		expect(SIBLING_HEDGE_QUORUM).toBe(0.5);
	});
});

describe("a phase whose calls all answer", () => {
	test("sends each call once and notes no hedge", async () => {
		const phase = new HedgePhase();
		const siblings = ["a", "b", "c", "d"].map(quick);
		const calls = await Promise.all(siblings.map((s) => phase.run(s.send)));
		expect(calls.map((c) => (c.ok ? c.value : c.error))).toEqual(["a", "b", "c", "d"]);
		expect(calls.every((c) => c.hedge === null)).toBe(true);
		expect(siblings.map((s) => s.state.sent)).toEqual([1, 1, 1, 1]);
	});

	test("starts the call synchronously, as the limiter's contract requires", () => {
		const s = quick("a");
		void new HedgePhase().run(s.send);
		expect(s.state.sent).toBe(1);
	});

	test("a query slow in every partition is never hedged: the answers' median is its own time", async () => {
		const phase = new HedgePhase();
		const siblings = [60, 62, 64, 70].map((ms) => sibling(() => after(ms, "x")));
		const calls = await Promise.all(siblings.map((s) => phase.run(s.send)));
		expect(calls.every((c) => c.ok && c.hedge === null)).toBe(true);
		expect(siblings.map((s) => s.state.sent)).toEqual([1, 1, 1, 1]);
	});
});

describe("one call late while the rest have answered", () => {
	test("is sent once more, and the second answer is the call's answer", async () => {
		const phase = new HedgePhase();
		const late = sibling(
			() => after(150, "rows"),
			() => after(0, "rows"),
		);
		const [, , , call] = await Promise.all([quick("a"), quick("b"), quick("c"), late].map((s) => phase.run(s.send)));
		expect(late.state.sent).toBe(2);
		if (!call?.ok) throw new Error("the hedged call did not answer");
		expect(call.value).toBe("rows");
		expect(call.ms).toBeLessThan(120);
		expect(call.hedge).toMatchObject({ won: "hedge", answered: 3, issued: 4, originalMs: null });
		expect(call.hedge?.firedAtMs).toBeGreaterThanOrEqual(19);
		// The original is not cancelled; when it lands the note says how late it was.
		await after(170, null);
		expect(call.hedge?.originalMs).toBeGreaterThanOrEqual(140);
		expect(late.state.sent).toBe(2);
	});

	test("the original still wins when it answers first, and only one hedge is ever sent", async () => {
		const phase = new HedgePhase();
		const late = sibling(
			() => after(80, "first"),
			() => after(400, "second"),
		);
		const [, , call] = await Promise.all([quick("a"), quick("b"), late].map((s) => phase.run(s.send)));
		expect(late.state.sent).toBe(2);
		expect(call).toMatchObject({ ok: true, value: "first", hedge: { won: "original" } });
		expect(call?.ms).toBeGreaterThanOrEqual(75);
		expect(call?.hedge?.originalMs).toBe(call?.ms as number);
	});

	test("up to half the phase late together is still hedged; more than half is not", async () => {
		const half = new HedgePhase();
		const slow = () =>
			sibling(
				() => after(150, "late"),
				() => after(0, "late"),
			);
		const two = [slow(), slow()];
		await Promise.all([quick("a"), quick("b"), ...two].map((s) => half.run(s.send)));
		expect(two.map((s) => s.state.sent)).toEqual([2, 2]);

		const most = new HedgePhase();
		const three = [slow(), slow(), slow()];
		const calls = await Promise.all([quick("a"), ...three].map((s) => most.run(s.send)));
		expect(three.map((s) => s.state.sent)).toEqual([1, 1, 1]);
		expect(calls.every((c) => c.hedge === null)).toBe(true);
	});

	test("a call with no fellow to be judged against is never hedged", async () => {
		const late = sibling(() => after(80, "only"));
		expect(await new HedgePhase().run(late.send)).toMatchObject({ ok: true, value: "only", hedge: null });
		expect(late.state.sent).toBe(1);
	});

	test("switched off, nothing is hedged", async () => {
		restore();
		restore = setSiblingHedgeForTests({ enabled: false, floorMs: 20 });
		const phase = new HedgePhase();
		const late = sibling(() => after(100, "late"));
		const [, , call] = await Promise.all([quick("a"), quick("b"), late].map((s) => phase.run(s.send)));
		expect(late.state.sent).toBe(1);
		expect(call).toMatchObject({ ok: true, value: "late", hedge: null });
	});
});

describe("errors surface as they did without the hedge", () => {
	const stale = new StaleModulusError("partition 2 serves modulus 10, asked 11");

	test("a call that fails before any hedge fails at once, unhedged", async () => {
		const phase = new HedgePhase();
		const failing = sibling<string>(() => failAfter(0, stale));
		const [, , call] = await Promise.all([quick("a"), quick("b"), failing].map((s) => phase.run(s.send)));
		expect(failing.state.sent).toBe(1);
		expect(call).toEqual({ ok: false, error: stale, ms: expect.any(Number), hedge: null });
	});

	test("the hedge failing leaves the original's answer standing", async () => {
		const phase = new HedgePhase();
		const late = sibling<string>(
			() => after(90, "first"),
			() => failAfter(0, stale),
		);
		const [, , call] = await Promise.all([quick("a"), quick("b"), late].map((s) => phase.run(s.send)));
		expect(call).toMatchObject({ ok: true, value: "first", hedge: { won: "original" } });
	});

	test("the original failing while the hedge is out waits for the hedge's answer", async () => {
		const phase = new HedgePhase();
		const late = sibling<string>(
			() => failAfter(60, new Error("Network connection lost.")),
			() => after(90, "second"),
		);
		const [, , call] = await Promise.all([quick("a"), quick("b"), late].map((s) => phase.run(s.send)));
		expect(call).toMatchObject({ ok: true, value: "second", hedge: { won: "hedge" } });
		expect(call?.hedge?.originalMs).toBeGreaterThanOrEqual(55);
	});

	test("both failing throws the ORIGINAL's error, whichever failed last", async () => {
		for (const [originalMs, hedgeMs] of [
			[60, 80],
			[120, 0],
		] as const) {
			const phase = new HedgePhase();
			const late = sibling<string>(
				() => failAfter(originalMs, stale),
				() => failAfter(hedgeMs, new Error("the hedge's own failure")),
			);
			const [, , call] = await Promise.all([quick("a"), quick("b"), late].map((s) => phase.run(s.send)));
			expect(late.state.sent).toBe(2);
			expect(call).toMatchObject({ ok: false, error: stale, hedge: { won: "neither" } });
		}
	});
});

describe("a hedge is a sibling call like any other to the limiter (x44)", () => {
	test("it waits for a slot, and is not sent at all if the original answers first", async () => {
		const limiter = new SiblingLimiter({ open: 0, queued: 0 }, 1);
		const phase = new HedgePhase();
		const peak = { open: 0 };
		const through = <T>(task: () => Promise<T>) =>
			limiter.run(() => {
				peak.open = Math.max(peak.open, limiter.open);
				return task();
			});
		// One slot, and the late call holds it: its hedge can only queue behind the call itself, and
		// when the slot comes free the call has landed.
		const late = sibling(() => after(80, "x"));
		const calls = await Promise.all([quick("a"), quick("b"), late].map((s) => phase.run(s.send, through)));
		expect(peak.open).toBe(1);
		expect(calls.map((c) => c.ok && c.value)).toEqual(["a", "b", "x"]);
		expect(calls[2]?.hedge).toBeNull();
		await after(5, null);
		expect(late.state.sent).toBe(1);
		expect(limiter.open).toBe(0);
		expect(limiter.queued).toBe(0);
	});

	test("a hedge is sent in a free slot and the count never passes the limit", async () => {
		const limiter = new SiblingLimiter({ open: 0, queued: 0 }, 3);
		const phase = new HedgePhase();
		const peak = { open: 0 };
		const late = sibling(
			() => after(150, "late"),
			() => after(0, "late"),
		);
		const through = <T>(task: () => Promise<T>) =>
			limiter.run(() => {
				peak.open = Math.max(peak.open, limiter.open);
				return task();
			});
		const siblings = [late, quick("a"), quick("b"), quick("c"), quick("d")];
		const calls = await Promise.all(siblings.map((s) => phase.run(s.send, through)));
		expect(calls[0]).toMatchObject({ ok: true, value: "late", hedge: { won: "hedge" } });
		expect(late.state.sent).toBe(2);
		expect(peak.open).toBe(3);
		// The call that lost keeps its slot until it settles — the runtime still counts it.
		expect(limiter.open).toBe(1);
		await after(170, null);
		expect(limiter.open).toBe(0);
	});
});

describe("siblingHedgeLine", () => {
	const hedge = { firedAtMs: 502, won: "hedge" as const, originalMs: null, answered: 8, issued: 10, peerMedianMs: 16 };

	test("says when it fired, who won and when, and what the phase looked like", () => {
		expect(siblingHedgeLine("engine-wnam-p10", 5, "searchKeys", { ms: 519, hedge }, 0)).toBe(
			"[engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms; won by hedge at 519ms (8 of 10 answered, median 16ms)",
		);
		expect(
			siblingHedgeLine("engine-wnam-p10", 5, "searchKeys", { ms: 3_173, hedge: { ...hedge, won: "original" } }, 0),
		).toBe(
			"[engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms; won by original at 3173ms (8 of 10 answered, median 16ms)",
		);
		expect(
			siblingHedgeLine("engine-wnam-p1", 6, "fetchRows", { ms: 25_004, hedge: { ...hedge, won: "neither" } }, 0),
		).toBe(
			"[engine-wnam-p1] sibling hedge p6 fetchRows: fired at 502ms; both failed at 25004ms (8 of 10 answered, median 16ms)",
		);
	});

	test("a hedge spent on a sibling that was loading its store says so", () => {
		expect(
			siblingHedgeLine("engine-enam-p2", 7, "searchKeys", { ms: 2_840, hedge: { ...hedge, won: "original" } }, 2_810),
		).toContain("won by original at 2840ms, its load 2810ms (8 of 10");
	});
});
