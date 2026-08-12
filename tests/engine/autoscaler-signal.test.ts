// RemoteEngine's contract with the shard autoscaler.
//
// Two rules, and both exist because breaking them lets an expansion manufacture
// the evidence for the next one:
//
//   - A WAKE-carrying sample (the DO reported an `acquireMs`) must not reach the
//     latency signal. Its wall time is the ~76MB store load, not queuing, and
//     every freshly opened shard produces exactly one.
//   - Every sample must be attributed to the REGION it came from. One isolate
//     can address two regions — regionHint splits NA and EU by longitude — so an
//     unkeyed report would let a busy region open shards in a quiet one.
//
// The third rule this file used to pin is gone with the relay tier: there is no
// longer a second DO whose depth, rate and wall time could be mistaken for this
// shard's, so there is no `relayed` rider to drop.
//
// Only the shard-controller is mocked, and only so the reports are observable.
// This suite used to have to mock search-engine-do away as well, because
// remote-engine.ts imported ENGINE_UNAVAILABLE_MARKER from it and so dragged in
// cloudflare:workers and the wasm store. `mock.module` is process-global in bun,
// so that mock leaked into every other suite that wanted the real SearchEngine —
// it passed only on file-ordering luck, and renaming this file broke it. The
// marker now lives in types.ts beside the error it encodes.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const reportEngineLoad = mock((_region: string, _depth: number) => {});
const reportEngineRate = mock((_region: string, _rate: number) => {});
const reportEngineLatency = mock((_region: string, _ms: number) => {});
const adoptShardWidth = mock((_region: string, _width: number) => {});
const currentShardWidth = mock((_region: string) => 1);

mock.module("../../src/engine/shard-controller", () => ({
	reportEngineLoad,
	reportEngineRate,
	reportEngineLatency,
	adoptShardWidth,
	currentShardWidth,
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

const search = (riders: Record<string, unknown>, region = "wnam") =>
	new RemoteEngine(stubReturning(riders), region).search({ limit: 10 } as never);

beforeEach(() => {
	reportEngineLoad.mockClear();
	reportEngineRate.mockClear();
	reportEngineLatency.mockClear();
	adoptShardWidth.mockClear();
	currentShardWidth.mockClear();
});

describe("what a sample reports", () => {
	test("a warm answer reports all three", async () => {
		await search({ acquireMs: 0, load: 2, rate: 55 });
		expect(reportEngineLoad).toHaveBeenCalledWith("wnam", 2);
		expect(reportEngineRate).toHaveBeenCalledWith("wnam", 55);
		expect(reportEngineLatency).toHaveBeenCalledTimes(1);
	});

	test("a wake-carrying answer reports load and rate but not latency", async () => {
		await search({ acquireMs: 950, load: 1, rate: 60 });
		expect(reportEngineLoad).toHaveBeenCalledWith("wnam", 1);
		expect(reportEngineRate).toHaveBeenCalledWith("wnam", 60);
		expect(reportEngineLatency).not.toHaveBeenCalled();
	});

	test("a DO that sends no riders reports nothing rather than zeroes", async () => {
		await search({});
		expect(reportEngineLoad).not.toHaveBeenCalled();
		expect(reportEngineRate).not.toHaveBeenCalled();
		expect(adoptShardWidth).not.toHaveBeenCalled();
	});

	test("a load of zero is still a report — it is evidence, not a missing rider", async () => {
		await search({ acquireMs: 0, load: 0, rate: 12 });
		expect(reportEngineLoad).toHaveBeenCalledWith("wnam", 0);
		expect(reportEngineRate).toHaveBeenCalledWith("wnam", 12);
	});
});

describe("every signal is attributed to its region", () => {
	test("reports carry the region the stub addresses", async () => {
		await search({ acquireMs: 0, load: 3, rate: 70, shards: 2 }, "weur");
		expect(reportEngineLoad).toHaveBeenCalledWith("weur", 3);
		expect(reportEngineRate).toHaveBeenCalledWith("weur", 70);
		expect(adoptShardWidth).toHaveBeenCalledWith("weur", 2);
		expect(reportEngineLatency.mock.calls[0]?.[0]).toBe("weur");
	});

	test("the width ridden out is this region's, not a global one", async () => {
		await search({ acquireMs: 0, load: 0, rate: 55, shards: 1 }, "apac");
		expect(currentShardWidth).toHaveBeenCalledWith("apac");
	});
});

describe("the fan-out rendezvous", () => {
	test("an announced width is adopted", async () => {
		await search({ acquireMs: 0, load: 0, rate: 55, shards: 4 });
		expect(adoptShardWidth).toHaveBeenCalledWith("wnam", 4);
	});

	test("a wake-carrying answer still adopts, since width is not a latency signal", async () => {
		await search({ acquireMs: 800, load: 0, rate: 55, shards: 3 });
		expect(adoptShardWidth).toHaveBeenCalledWith("wnam", 3);
		expect(reportEngineLatency).not.toHaveBeenCalled();
	});

	test("an old DO that sends no width is not treated as a width of zero", async () => {
		await search({ acquireMs: 0, load: 0, rate: 55 });
		expect(adoptShardWidth).not.toHaveBeenCalled();
	});
});

describe("the search envelope", () => {
	test("carries no autoscaler riders", async () => {
		const result = await search({ acquireMs: 0, load: 2, rate: 55, shards: 2 });
		expect(result).toEqual({ totalCards: 2, cards: [{ name: "Llanowar Elves" }] });
	});
});
