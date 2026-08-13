// The shard autoscaler, which until now had no coverage at all — every
// threshold in it was an unfalsified guess, and the module is pure arithmetic,
// so there was never a reason for that except that nothing forced the issue.
//
// Two things make it testable. Its state lives in a module-global Map keyed by
// region, so each test re-imports it under a fresh cache key. And it reads the
// clock only through Date.now(), so a stubbed clock makes the cooldown and
// contraction windows reachable without waiting ten minutes.
//
// READINESS IS NOW PART OF THE UNIT. Expanding no longer widens what pickShard
// draws from — a new shard is admitted only when markShardReady says its warm
// ping resolved — so tests that mean "the fan-out is now serving N" have to
// admit the shard, and `observedWidth` measures what is ROUTABLE, not what has
// been decided.
//
// The latency tests deliberately pin LATENCY_ABS_MS from both sides: 8ms must
// never expand and 25ms must, which brackets the noise floor to (8, 25]. That
// bound is the whole point — at the previous 75ms the `3 x floor` ratio rule
// could never bind for a 0.2-3ms query, so expansion fired at ~98% utilization
// instead of the ~80% the ratio targets.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

type Controller = typeof import("../../src/engine/shard-controller");

/** The region every single-region test operates on. */
const R = "wnam";

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
function warmFloor(c: Controller, ms = 1, samples = 25, region = R): void {
	for (let i = 0; i < samples; i++) c.reportEngineLatency(region, ms);
}

/** Observed fan-out width: pickShard routes uniformly over [0, readyShards). */
function observedWidth(c: Controller, region = R, samples = 300): number {
	let max = 0;
	for (let i = 0; i < samples; i++) max = Math.max(max, c.pickShard(region));
	return max + 1;
}

/**
 * Expand and then admit the shard, i.e. what a real isolate does once the warm
 * ping resolves. Most tests below care about the fan-out being IN SERVICE, and
 * without this they would measure the pre-admission width and read as failures.
 */
function admitPending(c: Controller, region = R): number | null {
	const target = c.takeWarmTarget(region);
	if (target !== null) c.markShardReady(region, target);
	return target;
}

describe("steady state", () => {
	test("stays at one shard, and shard 0 keeps the plain name", async () => {
		const c = await freshController();
		for (let i = 0; i < 50; i++) expect(c.pickShard(R)).toBe(0);
		expect(c.takeWarmTarget(R)).toBeNull();
	});
});

describe("queue-depth expansion", () => {
	test("depth alone does not expand while the rate gate is shut", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 0);
		for (let i = 0; i < 10; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("depth expands once the rate gate opens", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBe(1);
		// Not routable yet — that is the point of ready-gating.
		expect(observedWidth(c)).toBe(1);
		c.markShardReady(R, 1);
		expect(observedWidth(c)).toBe(2);
	});

	test("the cooldown stops one burst from laddering", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 30; i++) c.reportEngineLoad(R, 3);
		// First step consumed the warm target; nothing further inside the cooldown.
		expect(c.takeWarmTarget(R)).toBe(1);
		expect(c.takeWarmTarget(R)).toBeNull();
		c.markShardReady(R, 1);
		expect(observedWidth(c)).toBe(2);
	});

	test("a later burst past the cooldown steps up again", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(admitPending(c)).toBe(1);
		advance(31_000);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(admitPending(c)).toBe(2);
		expect(observedWidth(c)).toBe(3);
	});
});

// Latency is a BACKSTOP since the ceiling was measured (DO_CEILING_RATE): it cannot open a shard
// below LATENCY_MIN_RATE, which is half the ceiling. These tests therefore report a rate inside the
// band where it is still allowed to fire — above that gate, and below EXPAND_RATE so that the rate
// trigger is not what does the expanding. Reporting the old 60/s here would make four of them pass
// for the wrong reason: refused by the gate rather than by the latency logic they exist to test.
const LATENCY_BAND_RATE = 200;

describe("latency expansion", () => {
	test("sustained latency below the noise floor never expands", async () => {
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(R, LATENCY_BAND_RATE);
		for (let i = 0; i < 60; i++) c.reportEngineLatency(R, 8);
		expect(c.takeWarmTarget(R)).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("sustained latency above the bar expands", async () => {
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(R, LATENCY_BAND_RATE);
		for (let i = 0; i < 12; i++) c.reportEngineLatency(R, 25);
		expect(c.takeWarmTarget(R)).toBe(1);
	});

	test("latency cannot expand on its own below the rate gate", async () => {
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(R, 10);
		for (let i = 0; i < 30; i++) c.reportEngineLatency(R, 25);
		expect(c.takeWarmTarget(R)).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("a slow floor raises the bar with it, so slow-but-steady is not overload", async () => {
		const c = await freshController();
		// A colo whose healthy cost really is 20ms: 3 x floor = 60ms, so 25ms
		// reads as normal here even though it expanded against a 1ms floor.
		warmFloor(c, 20);
		c.reportEngineRate(R, LATENCY_BAND_RATE);
		for (let i = 0; i < 30; i++) c.reportEngineLatency(R, 25);
		expect(c.takeWarmTarget(R)).toBeNull();
	});

	test("isolated spikes decay before they can breach", async () => {
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(R, LATENCY_BAND_RATE);
		for (let round = 0; round < 10; round++) {
			c.reportEngineLatency(R, 40);
			for (let i = 0; i < 15; i++) c.reportEngineLatency(R, 1);
		}
		expect(c.takeWarmTarget(R)).toBeNull();
	});

	test("one huge spike gets within a single breach of expanding", async () => {
		// Documents how little margin LATENCY_BREACHES_TO_EXPAND actually has.
		// A lone 100ms sample against a 1ms floor drives fastEwma to 20.8, and
		// the 0.2 weight means it decays back under the 10ms bar only on the
		// fifth sample after: breaches reach exactly 4 of the 5 required. Drop
		// that constant to 4 and a single outlier cold-loads a shard.
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(R, LATENCY_BAND_RATE);
		c.reportEngineLatency(R, 100);
		for (let i = 0; i < 20; i++) c.reportEngineLatency(R, 1);
		expect(c.takeWarmTarget(R)).toBeNull();
	});

	test("but a sustained half-duty spike train is real overload and does expand", async () => {
		// The mean here is ~20ms against a 1ms floor. The EWMA never falls back
		// under the bar between spikes, which is the correct reading: this colo
		// is slow, not jittery.
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(R, LATENCY_BAND_RATE);
		for (let i = 0; i < 20; i++) {
			c.reportEngineLatency(R, 40);
			c.reportEngineLatency(R, 1);
		}
		expect(c.takeWarmTarget(R)).toBe(1);
	});
});

// The primary trigger since the ceiling was measured. Numbers here are literals rather than imports
// so the file states the bars it pins, matching how the latency tests bracket LATENCY_ABS_MS:
// DO_CEILING_RATE 340/s, EXPAND_RATE 272/s (80%), LATENCY_MIN_RATE 170/s (50%).
describe("rate expansion", () => {
	test("a shard at 80% of the measured ceiling expands on rate alone", async () => {
		// No latency samples and no reported depth — the rate IS the evidence.
		const c = await freshController();
		c.reportEngineRate(R, 272);
		expect(c.takeWarmTarget(R)).toBe(1);
	});

	test("one search per second below the bar does not", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 271);
		expect(c.takeWarmTarget(R)).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("the cooldown paces it, so one hot window cannot ladder to the cap", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 400);
		expect(admitPending(c)).toBe(1);
		for (let i = 0; i < 20; i++) c.reportEngineRate(R, 400);
		expect(c.takeWarmTarget(R)).toBeNull();
		advance(31_000);
		c.reportEngineRate(R, 400);
		expect(admitPending(c)).toBe(2);
		expect(observedWidth(c)).toBe(3);
	});

	test("a rate that high holds contraction off", async () => {
		// Rate is evidence of BUSY as well as of needing a shard: without this a region at 80%
		// of its ceiling could have shards folded under it by the idle timer, since a coping DO
		// reports depth 0 almost always.
		const c = await freshController();
		c.reportEngineRate(R, 400);
		expect(admitPending(c)).toBe(1);
		advance(9 * 60_000);
		c.reportEngineRate(R, 400);
		advance(9 * 60_000);
		c.reportEngineRate(R, 400);
		expect(observedWidth(c)).toBe(2);
	});
});

describe("the over-expansion the ceiling ramp measured", () => {
	test("sustained latency at a fifth of the ceiling no longer opens a shard", async () => {
		// THE REGRESSION THIS FIX EXISTS FOR. Production on 2026-08-13 expanded at 8-16 concurrent
		// — 65 to 118 searches/s against a 340/s ceiling — and laddered to the 8-shard cap in about
		// 40s while client p50 never moved off ~124ms. 65/s with badly breaching latency is exactly
		// that regime, and it must now be refused: at 19% utilization the DO does not need help.
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(R, 65);
		for (let i = 0; i < 60; i++) c.reportEngineLatency(R, 40);
		expect(c.takeWarmTarget(R)).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("but a genuinely degraded shard in the backstop band still expands", async () => {
		// The case latency keeps its place for: 200/s is well under the 272/s bar, so the rate
		// trigger stays quiet, yet the shard is slow anyway — a noisy neighbour rather than a
		// shortage of shards. Sharding may not fix it, but refusing to react at all would be a
		// regression from the previous behaviour.
		const c = await freshController();
		warmFloor(c);
		c.reportEngineRate(R, 200);
		for (let i = 0; i < 60; i++) c.reportEngineLatency(R, 40);
		expect(c.takeWarmTarget(R)).toBe(1);
	});
});

describe("SHARDS_MAX", () => {
	test("caps the fan-out", async () => {
		const c = await freshController();
		c.pickShard(R, 1);
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 10; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBeNull();
		expect(observedWidth(c)).toBe(1);
	});

	test("0 means unbounded, not zero", async () => {
		const c = await freshController();
		c.pickShard(R, 0);
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBe(1);
	});
});

describe("the fan-out rendezvous", () => {
	test("an isolate that never expanded adopts the colo's announced width", async () => {
		const c = await freshController();
		// This is the ~64% case a production ramp measured: on its own it would
		// route 100% to shard 0 forever.
		expect(observedWidth(c)).toBe(1);
		c.adoptShardWidth(R, 4);
		expect(observedWidth(c)).toBe(4);
	});

	test("announces READY width, never a shard still warming", async () => {
		const c = await freshController();
		expect(c.currentShardWidth(R)).toBe(1);
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		// Expanded, but announcing 2 here would make every peer that adopts it
		// start routing to a shard that has not loaded the store — the exact cold
		// routing ready-gating exists to prevent, spread across the whole region.
		expect(c.currentShardWidth(R)).toBe(1);
		c.markShardReady(R, 1);
		expect(c.currentShardWidth(R)).toBe(2);
	});

	test("raises only — a narrower announcement cannot undo local state", async () => {
		const c = await freshController();
		c.adoptShardWidth(R, 4);
		c.adoptShardWidth(R, 2);
		expect(observedWidth(c)).toBe(4);
	});

	test("cannot be used to escape SHARDS_MAX", async () => {
		const c = await freshController();
		c.pickShard(R, 2);
		c.adoptShardWidth(R, 16);
		expect(observedWidth(c)).toBe(2);
	});

	test("ignores nonsense without disturbing the current width", async () => {
		const c = await freshController();
		c.adoptShardWidth(R, 3);
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) c.adoptShardWidth(R, bad);
		expect(observedWidth(c)).toBe(3);
	});

	test("an adopted width still contracts, so adoption is not a ratchet", async () => {
		// The hazard this pairs with WIDTH_TTL_MS in the DO: if adoption could
		// not be undone locally, scale-in would be dead. Contraction is driven by
		// the idle clock and does not care where the width came from.
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		c.adoptShardWidth(R, 3);
		expect(observedWidth(c)).toBe(3);
		advance(11 * 60_000);
		c.pickShard(R);
		expect(observedWidth(c)).toBe(2);
	});
});

describe("contraction", () => {
	test("folds back one step per cooldown once saturation stops", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		admitPending(c);
		advance(31_000);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		admitPending(c);
		expect(observedWidth(c)).toBe(3);

		advance(11 * 60_000);
		c.pickShard(R);
		expect(observedWidth(c)).toBe(2);

		advance(61_000);
		c.pickShard(R);
		expect(observedWidth(c)).toBe(1);
	});

	test("never folds below one shard", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		for (let i = 0; i < 10; i++) {
			advance(11 * 60_000);
			c.pickShard(R);
		}
		expect(observedWidth(c)).toBe(1);
	});
});

describe("readiness gating", () => {
	test("an opened shard takes no traffic until its warm ping resolves", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		// Decided, but unreachable: routing here would put a user on a DO that has
		// not loaded the ~76MB store, which is the whole failure this prevents.
		expect(observedWidth(c)).toBe(1);
		expect(c.takeWarmTarget(R)).toBe(1);
		expect(observedWidth(c)).toBe(1);
		c.markShardReady(R, 1);
		expect(observedWidth(c)).toBe(2);
	});

	test("a failed warm-up gives the slot back instead of stranding it", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBe(1);
		c.unmarkPending(R);
		expect(observedWidth(c)).toBe(1);
		// And the slot is genuinely free again: the next burst past the cooldown
		// re-opens shard 1 rather than skipping to 2.
		advance(31_000);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBe(1);
	});

	test("unmarking never discards a shard peers have already warmed", async () => {
		const c = await freshController();
		c.adoptShardWidth(R, 3);
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBe(3);
		c.unmarkPending(R);
		expect(observedWidth(c)).toBe(3);
	});

	test("out-of-order warm pings never admit a gap", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBe(1);
		advance(31_000);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(R)).toBe(2);
		// Shard 2 reports first. Admitting only it would leave pickShard drawing
		// index 1, which nobody warmed — so readiness advances through the gap.
		c.markShardReady(R, 2);
		expect(observedWidth(c)).toBe(3);
	});

	test("adoption cannot admit more than the cap", async () => {
		const c = await freshController();
		c.pickShard(R, 2);
		c.adoptShardWidth(R, 8);
		expect(observedWidth(c)).toBe(2);
	});
});

describe("regions are independent", () => {
	const OTHER = "weur";

	test("one region's expansion does not widen another", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		c.markShardReady(R, 1);
		expect(observedWidth(c, R)).toBe(2);
		expect(observedWidth(c, OTHER)).toBe(1);
		expect(c.currentShardWidth(OTHER)).toBe(1);
	});

	test("a busy region's warm target is not handed to a quiet one", async () => {
		const c = await freshController();
		c.reportEngineRate(R, 60);
		for (let i = 0; i < 3; i++) c.reportEngineLoad(R, 3);
		expect(c.takeWarmTarget(OTHER)).toBeNull();
		expect(c.takeWarmTarget(R)).toBe(1);
	});

	test("latency signals do not bleed across regions", async () => {
		const c = await freshController();
		// A slow region breaching its bar must not expand a quiet one. This is the
		// hazard the Map exists for: regionHint splits NA and EU by longitude, so
		// ONE isolate can address two regions.
		c.reportEngineRate(R, 60);
		c.reportEngineRate(OTHER, 60);
		warmFloor(c, 1);
		for (let i = 0; i < 10; i++) c.reportEngineLatency(R, 200);
		expect(observedWidth(c, OTHER)).toBe(1);
		expect(c.takeWarmTarget(OTHER)).toBeNull();
	});

	test("contraction in one region leaves the other alone", async () => {
		const c = await freshController();
		for (const region of [R, OTHER]) {
			c.reportEngineRate(region, 60);
			for (let i = 0; i < 3; i++) c.reportEngineLoad(region, 3);
			const target = c.takeWarmTarget(region);
			if (target !== null) c.markShardReady(region, target);
		}
		expect(observedWidth(c, R)).toBe(2);
		expect(observedWidth(c, OTHER)).toBe(2);

		// The clock is shared, so keeping OTHER busy is what isolates the two —
		// otherwise both regions have been quiet for 11 minutes and both contract,
		// which is correct behaviour but tests nothing about independence.
		advance(11 * 60_000);
		c.reportEngineLoad(OTHER, 1);
		c.pickShard(R);
		expect(observedWidth(c, R)).toBe(1);
		expect(observedWidth(c, OTHER)).toBe(2);
	});
});
