// RemoteEngine's contract with the shard autoscaler.
//
// This pins the fix for a defect that was invisible by construction: the DO
// tags relayed results, and a relayed sample must reach NONE of the three
// report functions. Its wall time carries a cross-colo hop (region.ts budgets
// 60-80ms for a bad one), and its depth and rate belong to the regional DO
// rather than the colo shard being scaled. Because every shard the controller
// opens relays until it warms, reporting any of it let each expansion
// manufacture the evidence for the next one.
//
// The module graph is cut twice to keep this out of the runtime: the real
// shard-controller is replaced by spies, and search-engine-do (which pulls in
// cloudflare:workers and the wasm-backed store) is replaced by the one
// constant remote-engine.ts imports from it.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const reportEngineLoad = mock((_depth: number) => {});
const reportEngineRate = mock((_rate: number) => {});
const reportEngineLatency = mock((_ms: number) => {});
const adoptShardWidth = mock((_width: number) => {});
const currentShardWidth = mock(() => 1);

mock.module("../../src/engine/shard-controller", () => ({
	reportEngineLoad,
	reportEngineRate,
	reportEngineLatency,
	adoptShardWidth,
	currentShardWidth,
}));

mock.module("../../src/engine/search-engine-do", () => ({
	// Value is irrelevant here — no test exercises the error-decoding path.
	ENGINE_UNAVAILABLE_MARKER: "__ENGINE_UNAVAILABLE__",
}));

const { RemoteEngine } = await import("../../src/engine/remote-engine");

type Stub = ConstructorParameters<typeof RemoteEngine>[0];

/** A DO stub whose search() returns the given riders alongside a result. */
function stubReturning(riders: Record<string, unknown>): Stub {
	return {
		search: async () => ({ totalCards: 2, cards: [{ name: "Llanowar Elves" }], ...riders }),
		catalog: async () => ({ types: {}, keywords: {} }),
		samplePreferred: async () => [],
		size: async () => 2,
	} as unknown as Stub;
}

const search = (riders: Record<string, unknown>) =>
	new RemoteEngine(stubReturning(riders), "wnam").search({ limit: 10 } as never);

beforeEach(() => {
	reportEngineLoad.mockClear();
	reportEngineRate.mockClear();
	reportEngineLatency.mockClear();
	adoptShardWidth.mockClear();
	currentShardWidth.mockClear();
});

describe("relayed samples", () => {
	test("report nothing at all — not latency, not depth, not rate", async () => {
		await search({ acquireMs: 0, load: 7, rate: 900, relayed: true });
		expect(reportEngineLatency).not.toHaveBeenCalled();
		expect(reportEngineLoad).not.toHaveBeenCalled();
		expect(reportEngineRate).not.toHaveBeenCalled();
	});

	test("are dropped even when the regional DO was itself cold", async () => {
		await search({ acquireMs: 1200, load: 3, rate: 400, relayed: true });
		expect(reportEngineLatency).not.toHaveBeenCalled();
		expect(reportEngineLoad).not.toHaveBeenCalled();
		expect(reportEngineRate).not.toHaveBeenCalled();
	});
});

describe("local samples", () => {
	test("a warm local answer reports all three", async () => {
		await search({ acquireMs: 0, load: 2, rate: 55, relayed: false });
		expect(reportEngineLoad).toHaveBeenCalledWith(2);
		expect(reportEngineRate).toHaveBeenCalledWith(55);
		expect(reportEngineLatency).toHaveBeenCalledTimes(1);
	});

	test("a wake-carrying answer reports load and rate but not latency", async () => {
		await search({ acquireMs: 950, load: 1, rate: 60, relayed: false });
		expect(reportEngineLoad).toHaveBeenCalledWith(1);
		expect(reportEngineRate).toHaveBeenCalledWith(60);
		expect(reportEngineLatency).not.toHaveBeenCalled();
	});

	test("a missing relayed rider reads as local, for rolling-update skew", async () => {
		await search({ acquireMs: 0, load: 0, rate: 12 });
		expect(reportEngineLoad).toHaveBeenCalledWith(0);
		expect(reportEngineRate).toHaveBeenCalledWith(12);
		expect(reportEngineLatency).toHaveBeenCalledTimes(1);
	});
});

describe("the fan-out rendezvous", () => {
	test("a local answer's announced width is adopted", async () => {
		await search({ acquireMs: 0, load: 0, rate: 55, relayed: false, shards: 4 });
		expect(adoptShardWidth).toHaveBeenCalledWith(4);
	});

	test("a relayed answer's width is ignored — it describes the region", async () => {
		await search({ acquireMs: 0, load: 0, rate: 55, relayed: true, shards: 9 });
		expect(adoptShardWidth).not.toHaveBeenCalled();
	});

	test("a wake-carrying local answer still adopts, since width is not a latency signal", async () => {
		await search({ acquireMs: 800, load: 0, rate: 55, relayed: false, shards: 3 });
		expect(adoptShardWidth).toHaveBeenCalledWith(3);
		expect(reportEngineLatency).not.toHaveBeenCalled();
	});

	test("an old DO that sends no width is not treated as a width of zero", async () => {
		await search({ acquireMs: 0, load: 0, rate: 55, relayed: false });
		expect(adoptShardWidth).not.toHaveBeenCalled();
	});

	test("this isolate's width rides out on the RPC", async () => {
		await search({ acquireMs: 0, load: 0, rate: 55, relayed: false, shards: 1 });
		expect(currentShardWidth).toHaveBeenCalled();
	});
});

describe("the search envelope", () => {
	test("carries no autoscaler riders", async () => {
		const result = await search({ acquireMs: 0, load: 2, rate: 55, relayed: false });
		expect(result).toEqual({ totalCards: 2, cards: [{ name: "Llanowar Elves" }] });
	});

	test("carries no riders on a relay either", async () => {
		const result = await search({ acquireMs: 5, load: 2, rate: 55, relayed: true });
		expect(result).toEqual({ totalCards: 2, cards: [{ name: "Llanowar Elves" }] });
	});
});
