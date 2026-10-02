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
	type CrossTarget,
	HedgePhase,
	hedgeNeighbourOf,
	PhaseBuild,
	SIBLING_AWAKE_MS,
	SIBLING_HEDGE_CROSS_AFTER_MS,
	SIBLING_HEDGE_CROSS_REGION_ENABLED,
	SIBLING_HEDGE_ENABLED,
	SIBLING_HEDGE_FLOOR_MS,
	SIBLING_HEDGE_PEER_FACTOR,
	SIBLING_HEDGE_QUORUM,
	SIBLING_HEDGE_WAKING_FLOOR_MS,
	SIBLING_STUCK_MEMORY_MS,
	SIBLING_STUCK_MS,
	SiblingMemory,
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
	restore = setSiblingHedgeForTests({ floorMs: 20, wakingFloorMs: 20 });
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

	test("x55: the neighbour on, 150ms after the second call; a sibling that may be waking is given 900ms", () => {
		restore();
		expect(SIBLING_HEDGE_CROSS_REGION_ENABLED).toBe(true);
		expect(SIBLING_HEDGE_CROSS_AFTER_MS).toBe(150);
		expect(SIBLING_HEDGE_WAKING_FLOOR_MS).toBe(900);
		expect(SIBLING_AWAKE_MS).toBe(9_000);
		expect(SIBLING_STUCK_MS).toBe(2_500);
		expect(SIBLING_STUCK_MEMORY_MS).toBe(900_000);
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
		restore = setSiblingHedgeForTests({ enabled: false, crossRegion: false, floorMs: 20 });
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

describe("x55: a late call is also asked of the neighbour region's copy of the partition", () => {
	// DeckGen 2026-10-02 09:48–19:48: the second call to the same object answered 194 of 248 stalls
	// in a median 17ms, and lost 53 with the original at ≥3s — 36 sent on time and stuck on the same
	// path, 17 sent late for want of a slot.
	beforeEach(() => {
		restore();
		restore = setSiblingHedgeForTests({ floorMs: 20, wakingFloorMs: 20, crossAfterMs: 30 });
	});

	/** The neighbour's copy: answers as scripted, counting its calls. */
	function neighbour<T>(answer: () => Promise<T>, refuse?: (value: T) => string | null) {
		const state = { sent: 0 };
		const cross = (): CrossTarget<T> => ({
			region: "enam",
			send: () => {
				state.sent += 1;
				return answer();
			},
			...(refuse ? { refuse } : {}),
		});
		return { state, cross };
	}

	test("the same object first; the neighbour only when neither call has answered a while later", async () => {
		const phase = new HedgePhase();
		const late = sibling(
			() => after(300, "rows"),
			() => after(300, "rows"),
		);
		const there = neighbour(() => after(5, "rows"));
		const [, , call] = await Promise.all([
			phase.run(quick("a").send),
			phase.run(quick("b").send),
			phase.run(late.send, undefined, { cross: there.cross }),
		]);
		expect(late.state.sent).toBe(2);
		expect(there.state.sent).toBe(1);
		if (!call.ok) throw new Error("the hedged call did not answer");
		expect(call.value).toBe("rows");
		expect(call.ms).toBeLessThan(200);
		expect(call.hedge).toMatchObject({ won: "hedge", cross: { region: "enam", direct: false, won: true } });
		expect(call.hedge?.cross?.firedAtMs).toBeGreaterThanOrEqual((call.hedge?.firedAtMs ?? 0) + 25);
		await after(320, null);
	});

	test("a second call that answers in time leaves the neighbour unasked", async () => {
		const phase = new HedgePhase();
		const late = sibling(
			() => after(150, "rows"),
			() => after(5, "rows"),
		);
		const there = neighbour(() => after(0, "rows"));
		const [, , call] = await Promise.all([
			phase.run(quick("a").send),
			phase.run(quick("b").send),
			phase.run(late.send, undefined, { cross: there.cross }),
		]);
		expect(call).toMatchObject({ ok: true, value: "rows", hedge: { won: "hedge" } });
		expect(call.hedge?.cross).toBeUndefined();
		await after(160, null);
		expect(there.state.sent).toBe(0);
	});

	test("the original answering before the neighbour's turn leaves it unasked too", async () => {
		const phase = new HedgePhase();
		const late = sibling(
			() => after(35, "first"),
			() => after(300, "second"),
		);
		const there = neighbour(() => after(0, "third"));
		const [, , call] = await Promise.all([
			phase.run(quick("a").send),
			phase.run(quick("b").send),
			phase.run(late.send, undefined, { cross: there.cross }),
		]);
		expect(call).toMatchObject({ ok: true, value: "first", hedge: { won: "original" } });
		await after(60, null);
		expect(there.state.sent).toBe(0);
		await after(250, null);
	});

	test("an answer from another build is thrown away and the original waited for", async () => {
		const phase = new HedgePhase();
		const late = sibling(
			() => after(120, "build 7"),
			() => after(400, "build 7"),
		);
		const there = neighbour(
			() => after(0, "build 8"),
			(value) => (value === "build 7" ? null : "build 8 where 7 is pinned"),
		);
		const [, , call] = await Promise.all([
			phase.run(quick("a").send),
			phase.run(quick("b").send),
			phase.run(late.send, undefined, { cross: there.cross }),
		]);
		expect(there.state.sent).toBe(1);
		expect(call).toMatchObject({
			ok: true,
			value: "build 7",
			hedge: { won: "original", cross: { region: "enam", discarded: "build 8 where 7 is pinned" } },
		});
		expect(call.hedge?.cross?.won).toBeUndefined();
		expect(call.ms).toBeGreaterThanOrEqual(115);
		await after(300, null);
	});

	test("the neighbour failing leaves the original's answer standing; every call failing throws the ORIGINAL's error", async () => {
		const stale = new StaleModulusError("partition 2 serves modulus 10, asked 11");
		const there = () => neighbour<string>(() => failAfter(0, new Error("enam's own failure")));
		const phase = new HedgePhase();
		const late = sibling<string>(
			() => after(90, "first"),
			() => failAfter(60, new Error("the second call's failure")),
		);
		const enam = there();
		const [, , call] = await Promise.all([
			phase.run(quick("a").send),
			phase.run(quick("b").send),
			phase.run(late.send, undefined, { cross: enam.cross }),
		]);
		expect(enam.state.sent).toBe(1);
		expect(call).toMatchObject({ ok: true, value: "first", hedge: { won: "original" } });

		const failing = new HedgePhase();
		const dead = sibling<string>(
			() => failAfter(100, stale),
			() => failAfter(70, new Error("the second call's failure")),
		);
		const down = there();
		const [, , failed] = await Promise.all([
			failing.run(quick("a").send),
			failing.run(quick("b").send),
			failing.run(dead.send, undefined, { cross: down.cross }),
		]);
		expect(down.state.sent).toBe(1);
		expect(failed).toMatchObject({ ok: false, error: stale, hedge: { won: "neither" } });
	});

	test("an original that fails before the neighbour's turn fails as it did: the neighbour is not asked", async () => {
		const stale = new StaleModulusError("partition 2 serves modulus 10, asked 11");
		const phase = new HedgePhase();
		const dead = sibling<string>(
			() => failAfter(40, stale),
			() => failAfter(0, new Error("the second call's failure")),
		);
		const there = neighbour<string>(() => after(0, "an answer nobody asked for"));
		const [, , failed] = await Promise.all([
			phase.run(quick("a").send),
			phase.run(quick("b").send),
			phase.run(dead.send, undefined, { cross: there.cross }),
		]);
		expect(failed).toMatchObject({ ok: false, error: stale });
		await after(50, null);
		expect(there.state.sent).toBe(0);
	});

	test("a sibling that may be waking is given longer, then the neighbour is asked and the same object is not", async () => {
		restore();
		restore = setSiblingHedgeForTests({ floorMs: 20, wakingFloorMs: 90, crossAfterMs: 30 });
		const run = async (originalMs: number) => {
			const phase = new HedgePhase();
			const late = sibling(() => after(originalMs, "woke"));
			const there = neighbour(() => after(5, "woke"));
			const [, , call] = await Promise.all([
				phase.run(quick("a").send),
				phase.run(quick("b").send),
				phase.run(late.send, undefined, { cross: there.cross, mayBeWaking: () => true }),
			]);
			return { late, there, call };
		};
		// Awake by 60ms: under the waking floor, so no hedge at all — the 2026-10-02 waking median was
		// 662ms against a 900ms floor.
		const woke = await run(60);
		expect(woke.call).toMatchObject({ ok: true, value: "woke", hedge: null });
		expect(woke.late.state.sent).toBe(1);
		expect(woke.there.state.sent).toBe(0);
		// Still out at the waking floor: a stall or a long load, and the neighbour answers for both.
		const stalled = await run(300);
		expect(stalled.late.state.sent).toBe(1);
		expect(stalled.there.state.sent).toBe(1);
		expect(stalled.call).toMatchObject({ ok: true, hedge: { won: "hedge", cross: { direct: true, won: true } } });
		expect(stalled.call.hedge?.firedAtMs).toBeGreaterThanOrEqual(88);
		expect(stalled.call.ms).toBeLessThan(250);
		await after(220, null);
	});

	test("where there is no neighbour, a may-be-waking sibling is still asked twice — at the waking floor", async () => {
		restore();
		restore = setSiblingHedgeForTests({ floorMs: 20, wakingFloorMs: 90 });
		const phase = new HedgePhase();
		const late = sibling(
			() => after(300, "x"),
			() => after(0, "x"),
		);
		const [, , call] = await Promise.all([
			phase.run(quick("a").send),
			phase.run(quick("b").send),
			phase.run(late.send, undefined, { cross: () => null, mayBeWaking: () => true }),
		]);
		expect(late.state.sent).toBe(2);
		expect(call).toMatchObject({ ok: true, hedge: { won: "hedge" } });
		expect(call.hedge?.firedAtMs).toBeGreaterThanOrEqual(88);
		expect(call.hedge?.cross).toBeUndefined();
		await after(220, null);
	});

	test("three late calls and six slots: each goes to the neighbour alone, at once, and never a seventh call", async () => {
		const limiter = new SiblingLimiter();
		const phase = new HedgePhase();
		const peak = { open: 0 };
		const counted =
			(urgent: boolean) =>
			<T>(task: () => Promise<T>) =>
				limiter.run(() => {
					peak.open = Math.max(peak.open, limiter.open);
					return task();
				}, urgent);
		// Every second call to the same object would stick as the first did — the 2026-10-02 case
		// where two hedges held the last two slots and the third late call was hedged 2.8s late.
		const stuck = () => sibling(() => after(250, "late"));
		const lates = [stuck(), stuck(), stuck()];
		const theres = lates.map(() => neighbour(() => after(5, "late")));
		const quicks = ["a", "b", "c", "d"].map(quick);
		const calls = await Promise.all([
			...quicks.map((q) => phase.run(q.send, counted(false))),
			...lates.map((l, i) =>
				phase.run(l.send, counted(false), {
					cross: (theres[i] as (typeof theres)[number]).cross,
					free: () => limiter.free,
					scheduleHedge: counted(true),
				}),
			),
		]);
		expect(lates.map((l) => l.state.sent)).toEqual([1, 1, 1]);
		expect(theres.map((t) => t.state.sent)).toEqual([1, 1, 1]);
		for (const call of calls.slice(4)) {
			expect(call).toMatchObject({ ok: true, value: "late", hedge: { won: "hedge", cross: { direct: true } } });
			expect(call.hedge?.firedAtMs).toBeLessThan(80);
		}
		expect(peak.open).toBeLessThanOrEqual(6);
		await after(260, null);
		expect(limiter.open).toBe(0);
	});

	test("two late calls fit: each is asked of the same object first", async () => {
		const limiter = new SiblingLimiter();
		const phase = new HedgePhase();
		const through = <T>(task: () => Promise<T>) => limiter.run(task);
		const lates = [0, 1].map(() =>
			sibling(
				() => after(150, "late"),
				() => after(0, "late"),
			),
		);
		const theres = lates.map(() => neighbour(() => after(0, "late")));
		await Promise.all([
			phase.run(quick("a").send, through),
			phase.run(quick("b").send, through),
			...lates.map((l, i) =>
				phase.run(l.send, through, {
					cross: (theres[i] as (typeof theres)[number]).cross,
					free: () => limiter.free,
				}),
			),
		]);
		expect(lates.map((l) => l.state.sent)).toEqual([2, 2]);
		expect(theres.map((t) => t.state.sent)).toEqual([0, 0]);
		await after(160, null);
	});

	test("either switch works alone", async () => {
		const run = async (change: { enabled: boolean; crossRegion: boolean }) => {
			const undo = setSiblingHedgeForTests(change);
			try {
				const phase = new HedgePhase();
				const late = sibling(
					() => after(120, "x"),
					() => after(200, "x"),
				);
				const there = neighbour(() => after(200, "x"));
				const [, , call] = await Promise.all([
					phase.run(quick("a").send),
					phase.run(quick("b").send),
					phase.run(late.send, undefined, { cross: there.cross }),
				]);
				await after(210, null);
				return { same: late.state.sent - 1, neighbour: there.state.sent, hedged: call.hedge !== null };
			} finally {
				undo();
			}
		};
		// The neighbour off: x53 exactly — a second call to the same object, and nothing else.
		expect(await run({ enabled: true, crossRegion: false })).toEqual({ same: 1, neighbour: 0, hedged: true });
		// The second call off: the neighbour alone, at once.
		expect(await run({ enabled: false, crossRegion: true })).toEqual({ same: 0, neighbour: 1, hedged: true });
		expect(await run({ enabled: false, crossRegion: false })).toEqual({ same: 0, neighbour: 0, hedged: false });
	});

	test("the original's own outcome is heard whenever it lands, after the gather has moved on too", async () => {
		const phase = new HedgePhase();
		const heard: { ok: boolean; ms: number }[] = [];
		const late = sibling(
			() => after(100, "late"),
			() => after(0, "late"),
		);
		const [, , call] = await Promise.all([
			phase.run(quick("a").send),
			phase.run(quick("b").send),
			phase.run(late.send, undefined, { onOriginal: (o) => heard.push({ ok: o.ok, ms: o.ms }) }),
		]);
		expect(call).toMatchObject({ ok: true, hedge: { won: "hedge" } });
		expect(heard).toEqual([]);
		await after(110, null);
		expect(heard).toHaveLength(1);
		expect(heard[0]?.ok).toBe(true);
		expect(heard[0]?.ms).toBeGreaterThanOrEqual(95);
	});
});

describe("x55: a hedge goes to the head of the limiter's line", () => {
	test("ahead of calls that have not started, behind nothing", async () => {
		const limiter = new SiblingLimiter({ open: 0, queued: 0 }, 1);
		const order: string[] = [];
		const task = (name: string) => () => {
			order.push(name);
			return after(1, name);
		};
		expect(limiter.free).toBe(1);
		const all = [limiter.run(task("first")), limiter.run(task("second")), limiter.run(task("third"))];
		expect(limiter.free).toBe(0);
		all.push(limiter.run(task("hedge"), true));
		await Promise.all(all);
		expect(order).toEqual(["first", "hedge", "second", "third"]);
		expect(limiter.free).toBe(1);
	});
});

describe("x55: what a coordinator already knows about a sibling (SiblingMemory)", () => {
	const T = 1_000_000;

	test("a sibling never heard from in this isolate may be waking", () => {
		expect(new SiblingMemory().mayBeWaking(3, T)).toBe(true);
	});

	test("one that answered within nine seconds cannot have been evicted; after that it may have been", () => {
		const memory = new SiblingMemory();
		memory.answered(3, T, 12);
		expect(memory.mayBeWaking(3, T + SIBLING_AWAKE_MS)).toBe(false);
		expect(memory.mayBeWaking(3, T + SIBLING_AWAKE_MS + 1)).toBe(true);
		// ...and it says nothing about any other sibling.
		expect(memory.mayBeWaking(4, T + 1)).toBe(true);
	});

	test("an isolate that has seen the stall treats every late call as one, for fifteen minutes", () => {
		const memory = new SiblingMemory();
		memory.answered(5, T, 3_173);
		expect(memory.mayBeWaking(4, T + 60_000)).toBe(false);
		expect(memory.mayBeWaking(4, T + SIBLING_STUCK_MEMORY_MS)).toBe(false);
		expect(memory.mayBeWaking(4, T + SIBLING_STUCK_MEMORY_MS + 1)).toBe(true);
	});

	test("a slow wake is not the stall: the slowest of 170 landed at 2.3s", () => {
		const memory = new SiblingMemory();
		memory.answered(5, T, 2_279);
		expect(memory.mayBeWaking(4, T + 60_000)).toBe(true);
	});
});

describe("x55: the neighbour's keys stand in only from the build the region's answers name (PhaseBuild)", () => {
	const reply = (build: string, p: number, sortKeyVersion = 1) => ({
		storeKey: `card-store-v1-${build}-p${p}.store`,
		sortKeyVersion,
	});

	test("the same build and sort-key encoding is taken", () => {
		const pinned = new PhaseBuild();
		pinned.note(reply("7", 0));
		pinned.note(reply("7", 1));
		expect(pinned.refuse(reply("7", 2), "7")).toBeNull();
		// This object's own store not loaded yet: its siblings' answers are the pin.
		expect(pinned.refuse(reply("7", 2), undefined)).toBeNull();
	});

	test("another build is refused, whichever side is ahead", () => {
		const pinned = new PhaseBuild();
		pinned.note(reply("7", 0));
		expect(pinned.refuse(reply("8", 2), "7")).toBe("build 8 where 7 is pinned");
		expect(pinned.refuse(reply("6", 2), "7")).toBe("build 6 where 7 is pinned");
	});

	test("a region that is itself mid-publish takes nothing from the neighbour", () => {
		const mixed = new PhaseBuild();
		mixed.note(reply("7", 0));
		mixed.note(reply("8", 1));
		expect(mixed.refuse(reply("8", 2), "8")).toBe("this region's answers name 2 builds");
		const behind = new PhaseBuild();
		behind.note(reply("8", 1));
		expect(behind.refuse(reply("8", 2), "7")).toBe("this object holds build 7 and its siblings 8");
		expect(new PhaseBuild().refuse(reply("7", 2), "7")).toBe("this region's answers name 0 builds");
	});

	test("another sort-key encoding is refused", () => {
		const pinned = new PhaseBuild();
		pinned.note(reply("7", 0));
		expect(pinned.refuse(reply("7", 2, 2), "7")).toBe("sort-key version 2 where 1 is pinned");
	});
});

describe("x55: the neighbour is the Worker hedge's neighbour (hedgeNeighbourOf)", () => {
	test("wnam's is enam, enam's is wnam, at the generation the placement block gives that region", () => {
		expect(hedgeNeighbourOf("engine-wnam-p10", undefined)).toEqual({ region: "enam", generation: 0 });
		expect(hedgeNeighbourOf("engine-enam-2-p3", undefined)).toEqual({ region: "wnam", generation: 0 });
		expect(hedgeNeighbourOf("engine-wnam-p1", { v: 1, gens: { enam: 2 } })).toEqual({ region: "enam", generation: 2 });
	});

	test("an aliased neighbour is passed over, and a name that is no engine's has none", () => {
		// eeur's first neighbour is weur; with weur aliased away its second, enam, is the one.
		expect(hedgeNeighbourOf("engine-eeur-p0", { v: 1, alias: { weur: { to: "enam", since: "1" } } })).toEqual({
			region: "enam",
			generation: 0,
		});
		expect(hedgeNeighbourOf("engine-wnam-p0", { v: 1, alias: { enam: { to: "weur", since: "1" } } })).toBeNull();
		expect(hedgeNeighbourOf("coordinator", undefined)).toBeNull();
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

	test("x55: says where the neighbour's call went, and whose answer was used", () => {
		const then = { region: "enam", firedAtMs: 655, direct: false };
		expect(
			siblingHedgeLine(
				"engine-wnam-p10",
				5,
				"searchKeys",
				{ ms: 731, hedge: { ...hedge, cross: { ...then, won: true } } },
				0,
			),
		).toBe(
			"[engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms, to enam at 655ms; won by hedge to enam at 731ms (8 of 10 answered, median 16ms)",
		);
		// The second call to the same object answered after the neighbour had been asked.
		expect(siblingHedgeLine("engine-wnam-p10", 5, "searchKeys", { ms: 700, hedge: { ...hedge, cross: then } }, 0)).toBe(
			"[engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms, to enam at 655ms; won by hedge at 700ms (8 of 10 answered, median 16ms)",
		);
		const alone = { region: "enam", firedAtMs: 902, direct: true };
		expect(
			siblingHedgeLine(
				"engine-wnam-p10",
				5,
				"searchKeys",
				{ ms: 990, hedge: { ...hedge, firedAtMs: 902, cross: { ...alone, won: true } } },
				0,
			),
		).toBe(
			"[engine-wnam-p10] sibling hedge p5 searchKeys: fired at 902ms to enam; won by hedge to enam at 990ms (8 of 10 answered, median 16ms)",
		);
		expect(
			siblingHedgeLine(
				"engine-wnam-p10",
				5,
				"searchKeys",
				{
					ms: 3_173,
					hedge: {
						...hedge,
						firedAtMs: 902,
						won: "original",
						cross: { ...alone, discarded: "build 8 where 7 is pinned" },
					},
				},
				0,
			),
		).toBe(
			"[engine-wnam-p10] sibling hedge p5 searchKeys: fired at 902ms to enam; won by original at 3173ms, enam's answer discarded: build 8 where 7 is pinned (8 of 10 answered, median 16ms)",
		);
	});

	test("a hedge spent on a sibling that was loading its store says so", () => {
		expect(
			siblingHedgeLine("engine-enam-p2", 7, "searchKeys", { ms: 2_840, hedge: { ...hedge, won: "original" } }, 2_810),
		).toContain("won by original at 2840ms, its load 2810ms (8 of 10");
	});
});
