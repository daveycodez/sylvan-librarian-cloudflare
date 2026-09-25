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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const reportEngineLoad = mock((_region: string, _depth: number) => {});
const reportEngineRate = mock((_region: string, _rate: number) => {});
const reportEngineLatency = mock((_region: string, _ms: number) => {});
const adoptShardWidth = mock((_region: string, _width: number) => {});
const currentShardWidth = mock((_region: string) => 1);
// The DO-side fold is imported by search-engine-do, which rendezvous.test.ts runs for real; since
// `mock.module` is process-global, the mock has to carry the REAL rule or that suite's announcement
// never moves. Query-string import so the real module is not the one being mocked.
const realControllerSpec = "../../src/engine/shard-controller.ts?real-for-autoscaler";
const realController = (await import(realControllerSpec)) as typeof import("../../src/engine/shard-controller");

mock.module("../../src/engine/shard-controller", () => ({
	reportEngineLoad,
	reportEngineRate,
	reportEngineLatency,
	adoptShardWidth,
	currentShardWidth,
	foldWidthAnnouncement: realController.foldWidthAnnouncement,
}));

const { RemoteEngine, setEngineHedgeForTests } = await import("../../src/engine/remote-engine");

type Stub = ConstructorParameters<typeof RemoteEngine>[0];

/** A DO stub whose searchCardsAsObjects() returns the given riders alongside a result. */
function stubReturning(riders: Record<string, unknown>): Stub {
	return {
		searchCardsAsObjects: async () => ({ totalCards: 2, cards: [{ name: "Llanowar Elves" }], ...riders }),
		typeAndKeywordCounts: async () => ({ types: {}, keywords: {} }),
		randomCardsAsObjects: async () => [],
		cardCount: async () => 2,
	} as unknown as Stub;
}

const search = (riders: Record<string, unknown>, region = "wnam") =>
	new RemoteEngine(stubReturning(riders), region).searchCardsAsObjects({ limit: 10 } as never);

beforeEach(() => {
	reportEngineLoad.mockClear();
	reportEngineRate.mockClear();
	reportEngineLatency.mockClear();
	adoptShardWidth.mockClear();
	currentShardWidth.mockClear();
});

describe("the streaming transport's riders", () => {
	test("feed the autoscaler and are stripped before the response leaves the isolate", async () => {
		// Passed through verbatim they told every client (and the edge cache) the shard
		// controller's load, rate and width.
		const stub = {
			fetch: async () =>
				new Response("{}", {
					status: 200,
					headers: {
						"content-type": "application/json",
						"cache-control": "public, max-age=57600",
						"x-total-cards": "7",
						"x-row-count": "7",
						"x-acquire-ms": "0",
						"x-load": "3",
						"x-rate": "44",
						"x-shards": "2",
					},
				}),
		} as unknown as Stub;
		const res = await new RemoteEngine(stub, "wnam").scryfallSearchPage(
			{ limit: 10 } as never,
			"https://x",
			{} as never,
			{},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("public, max-age=57600");
		for (const name of ["x-total-cards", "x-row-count", "x-acquire-ms", "x-load", "x-rate", "x-shards"]) {
			expect(res.headers.get(name)).toBeNull();
		}
		expect(reportEngineLoad).toHaveBeenCalledWith("wnam", 3);
		expect(reportEngineRate).toHaveBeenCalledWith("wnam", 44);
		expect(adoptShardWidth).toHaveBeenCalledWith("wnam", 2);
		expect(await res.text()).toBe("{}");
	});
});

describe("what a sample reports", () => {
	test("a warm answer reports all three", async () => {
		await search({ acquireMs: 0, load: 2, rate: 55 });
		expect(reportEngineLoad).toHaveBeenCalledWith("wnam", 2);
		expect(reportEngineRate).toHaveBeenCalledWith("wnam", 55);
		expect(reportEngineLatency).toHaveBeenCalledTimes(1);
	});

	test("a wake-carrying answer reports its rate, but neither its depth nor its latency", async () => {
		// Its depth is the queue behind the object's own store load, not a shortage of replicas.
		await search({ acquireMs: 950, load: 7, rate: 60 });
		expect(reportEngineLoad).not.toHaveBeenCalled();
		expect(reportEngineRate).toHaveBeenCalledWith("wnam", 60);
		expect(reportEngineLatency).not.toHaveBeenCalled();
	});

	test("overload during a wake still reaches the controller: rate on the wake, depth right after it", async () => {
		// The arrivals are real demand whatever the store was doing, so the rate rider — the primary
		// trigger — is untouched; and the first warm answer after the load reports depth again.
		await search({ acquireMs: 1_200, load: 9, rate: 58 });
		await search({ acquireMs: 0, load: 3, rate: 58 });
		expect(reportEngineRate).toHaveBeenCalledTimes(2);
		expect(reportEngineRate).toHaveBeenCalledWith("wnam", 58);
		expect(reportEngineLoad).toHaveBeenCalledTimes(1);
		expect(reportEngineLoad).toHaveBeenCalledWith("wnam", 3);
	});

	test("the streaming transport drops a wake-carrying depth the same way", async () => {
		const stub = {
			fetch: async () =>
				new Response("{}", { status: 200, headers: { "x-acquire-ms": "830", "x-load": "6", "x-rate": "12" } }),
		} as unknown as Stub;
		await new RemoteEngine(stub, "weur").scryfallSearchPage({ limit: 10 } as never, "https://x", {} as never, {});
		expect(reportEngineLoad).not.toHaveBeenCalled();
		expect(reportEngineRate).toHaveBeenCalledWith("weur", 12);
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

describe("a HEDGED answer feeds nothing", () => {
	// A call silent for ENGINE_HEDGE_MS is also sent to the same partition in a neighbouring region
	// (remote-engine.ts hedgedCall). The neighbour's riders describe ITS object, and the wall time
	// includes the silence of this region's: fed here, they would open replicas in this region, or
	// adopt the neighbour's width, on evidence about somewhere else.
	const hung = {
		searchCardsAsObjects: () => new Promise(() => {}),
		fetch: () => new Promise(() => {}),
	} as unknown as Stub;
	const hedgeTo = (stub: Record<string, unknown>) => ({
		region: "enam",
		partition: 0,
		connect: () => stub as unknown as Stub,
	});
	beforeEach(() => setEngineHedgeForTests(10));
	afterEach(() => setEngineHedgeForTests(4_000));

	test("the RPC transport: the neighbour's answer is returned, its riders reach no report", async () => {
		const neighbour = {
			searchCardsAsObjects: async () => ({ totalCards: 1, cards: [], acquireMs: 0, load: 9, rate: 80, shards: 4 }),
		};
		const engine = new RemoteEngine(hung, "wnam", "SJC", undefined, false, hedgeTo(neighbour));
		expect(await engine.searchCardsAsObjects({ limit: 10 } as never)).toEqual({ totalCards: 1, cards: [] });
		expect(reportEngineLoad).not.toHaveBeenCalled();
		expect(reportEngineRate).not.toHaveBeenCalled();
		expect(reportEngineLatency).not.toHaveBeenCalled();
		expect(adoptShardWidth).not.toHaveBeenCalled();
	});

	test("the page transport: likewise, and the riders are still stripped from the client's response", async () => {
		const neighbour = {
			fetch: async () =>
				new Response("{}", {
					status: 200,
					headers: { "x-acquire-ms": "0", "x-load": "9", "x-rate": "80", "x-shards": "4" },
				}),
		};
		const engine = new RemoteEngine(hung, "wnam", "SJC", undefined, false, hedgeTo(neighbour));
		const res = await engine.scryfallSearchPage({ limit: 10 } as never, "https://x", {} as never, {});
		expect(res.headers.get("x-load")).toBeNull();
		expect(res.headers.get("x-shards")).toBeNull();
		expect(reportEngineLoad).not.toHaveBeenCalled();
		expect(reportEngineRate).not.toHaveBeenCalled();
		expect(reportEngineLatency).not.toHaveBeenCalled();
		expect(adoptShardWidth).not.toHaveBeenCalled();
	});

	test("the primary winning after the hedge fired still feeds as it always has", async () => {
		const slow = {
			searchCardsAsObjects: () =>
				new Promise((resolve) =>
					setTimeout(() => resolve({ totalCards: 2, cards: [], acquireMs: 0, load: 1, rate: 5, shards: 1 }), 30),
				),
		} as unknown as Stub;
		const silent = hedgeTo({ searchCardsAsObjects: () => new Promise(() => {}) });
		await new RemoteEngine(slow, "wnam", "SJC", undefined, false, silent).searchCardsAsObjects({ limit: 10 } as never);
		expect(reportEngineLoad).toHaveBeenCalledWith("wnam", 1);
		expect(reportEngineRate).toHaveBeenCalledWith("wnam", 5);
		expect(adoptShardWidth).toHaveBeenCalledWith("wnam", 1);
	});
});
