// The shard autoscaler, which until now had no coverage at all — every
// threshold in it was an unfalsified guess, and the module is pure arithmetic,
// so there was never a reason for that except that nothing forced the issue.
//
// Two things make it testable. Its state is module-global on purpose (it IS
// the isolate's per-colo state), so each test re-imports it under a fresh cache
// key. And it reads the clock only through Date.now(), so a stubbed clock makes
// the cooldown and contraction windows reachable without waiting ten minutes.
//
// The latency tests deliberately pin LATENCY_ABS_MS from both sides: 8ms must
// never expand and 25ms must, which brackets the noise floor to (8, 25]. That
// bound is the whole point — at the previous 75ms the `3 x floor` ratio rule
// could never bind for a 0.2-3ms query, so expansion fired at ~98% utilization
// instead of the ~80% the ratio targets.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

type Controller = typeof import("../../src/engine/shard-controller");

let gen = 0;
let clock = 1_000_000;
let nowSpy: ReturnType<typeof spyOn> | null = null;

/** Fresh module state per test — the globals are the unit under test. */
async function freshController(): Promise<Controller> {
	return (await import(`../../src/engine/shard-controller.ts?gen=${gen++}`)) as Controller;
}

beforeEach(() => {
	clock = 1_000_000;
	nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
	nowSpy?.mockRestore();
});

function advance(ms: number): void {
	clock += ms;
}

/** Settle floorEwma at `ms` and clear the LATENCY_MIN_SAMPLES gate. */
function warmFloor(c: Controller, ms = 1, samples = 25): void {
	for (let i = 0; i < samples; i++) c.reportEngineLatency(ms);
}

/** Observed fan-out width: pickShard routes uniformly over [0, activeShards). */
function observedWidth(c: Controller, samples = 300): number {
	let max = 0;
	for (let i = 0; i < samples; i++) max = Math.max(max, c.pickShard());
	return max + 1;
}

describe("steady state", () => {
	test("stays at one shard, and shard 0 keeps the plain name", async () => {
		const c = await freshController();
		for (let i = 0; i < 50; i++) expect(c.pickShard()).toBe(0);
		expect(c.takeWarmTarget()).toBeNull();
	});
});

describe("queue-depth expansion", () => {
	test("depth alone does not expand while the rate gate is shut", async () => {
		const c = await freshController();
		c.reportEngineRate(0);
		for (let i = 0; i < 10; i++) c.reportEngineLoad(3);
		expect(c.takeWarmTarget()).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("depth expands once the rate gate opens", async () => {
		const c = await freshController();
		c.reportEngineRate(60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(3);
		expect(c.takeWarmTarget()).toBe(1);
		expect(observedWidth(c)).toBe(2);
	});

	test("the cooldown stops one burst from laddering", async () => {
		const c = await freshController();
		c.reportEngineRate(60);
		for (let i = 0; i < 30; i++) c.reportEngineLoad(3);
		// First step consumed the warm target; nothing further inside the cooldown.
		expect(c.takeWarmTarget()).toBe(1);
		expect(c.takeWarmTarget()).toBeNull();
		expect(observedWidth(c)).toBe(2);
	});

	test("a later burst past the cooldown steps up again", async () => {
		const c = await freshController();
		c.reportEngineRate(60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(3);
		expect(c.takeWarmTarget()).toBe(1);
		advance(31_000);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(3);
		expect(c.takeWarmTarget()).toBe(2);
		expect(observedWidth(c)).toBe(3);
	});
});

describe("latency expansion", () => {
	test("sustained latency below the noise floor never expands", async () => {
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(60);
		for (let i = 0; i < 60; i++) c.reportEngineLatency(8);
		expect(c.takeWarmTarget()).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("sustained latency above the bar expands", async () => {
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(60);
		for (let i = 0; i < 12; i++) c.reportEngineLatency(25);
		expect(c.takeWarmTarget()).toBe(1);
	});

	test("latency cannot expand on its own below the rate gate", async () => {
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(10);
		for (let i = 0; i < 30; i++) c.reportEngineLatency(25);
		expect(c.takeWarmTarget()).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("a slow floor raises the bar with it, so slow-but-steady is not overload", async () => {
		const c = await freshController();
		// A colo whose healthy cost really is 20ms: 3 x floor = 60ms, so 25ms
		// reads as normal here even though it expanded against a 1ms floor.
		warmFloor(c, 20);
		c.reportEngineRate(60);
		for (let i = 0; i < 30; i++) c.reportEngineLatency(25);
		expect(c.takeWarmTarget()).toBeNull();
	});

	test("isolated spikes decay before they can breach", async () => {
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(60);
		for (let round = 0; round < 10; round++) {
			c.reportEngineLatency(40);
			for (let i = 0; i < 15; i++) c.reportEngineLatency(1);
		}
		expect(c.takeWarmTarget()).toBeNull();
	});

	test("one huge spike gets within a single breach of expanding", async () => {
		// Documents how little margin LATENCY_BREACHES_TO_EXPAND actually has.
		// A lone 100ms sample against a 1ms floor drives fastEwma to 20.8, and
		// the 0.2 weight means it decays back under the 10ms bar only on the
		// fifth sample after: breaches reach exactly 4 of the 5 required. Drop
		// that constant to 4 and a single outlier cold-loads a shard.
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(60);
		c.reportEngineLatency(100);
		for (let i = 0; i < 20; i++) c.reportEngineLatency(1);
		expect(c.takeWarmTarget()).toBeNull();
	});

	test("but a sustained half-duty spike train is real overload and does expand", async () => {
		// The mean here is ~20ms against a 1ms floor. The EWMA never falls back
		// under the bar between spikes, which is the correct reading: this colo
		// is slow, not jittery.
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(60);
		for (let i = 0; i < 20; i++) {
			c.reportEngineLatency(40);
			c.reportEngineLatency(1);
		}
		expect(c.takeWarmTarget()).toBe(1);
	});
});

describe("SHARDS_MAX", () => {
	test("caps the fan-out", async () => {
		const c = await freshController();
		c.pickShard(1);
		c.reportEngineRate(60);
		for (let i = 0; i < 10; i++) c.reportEngineLoad(3);
		expect(c.takeWarmTarget()).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("0 means unbounded, not zero", async () => {
		const c = await freshController();
		c.pickShard(0);
		c.reportEngineRate(60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(3);
		expect(c.takeWarmTarget()).toBe(1);
	});
});

describe("contraction", () => {
	test("folds back one step per cooldown once saturation stops", async () => {
		const c = await freshController();
		c.reportEngineRate(60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(3);
		advance(31_000);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(3);
		expect(observedWidth(c)).toBe(3);

		advance(11 * 60_000);
		c.pickShard();
		expect(observedWidth(c)).toBe(2);

		advance(61_000);
		c.pickShard();
		expect(observedWidth(c)).toBe(1);
	});

	test("never folds below one shard", async () => {
		const c = await freshController();
		c.reportEngineRate(60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(3);
		for (let i = 0; i < 10; i++) {
			advance(11 * 60_000);
			c.pickShard();
		}
		expect(observedWidth(c)).toBe(1);
	});
});
