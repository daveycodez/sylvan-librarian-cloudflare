// The SearchEngine DO's half of the fan-out rendezvous.
//
// Isolates cannot see each other, and activeShards is per-isolate state that
// starts at 1, so an isolate which never expands on its own sends everything to
// shard 0 forever. A production ramp on 2026-08-09 measured the consequence:
// four shards open and traffic stuck at ~73/17/10/5 through every stage, ~64%
// of isolates never expanding. The DO is the meeting point, since the isolates
// that need convincing are exactly the ones sending all their traffic here.
//
// The decay is the part worth testing. A plain running max would ratchet: the
// controller's contraction lowers an isolate's width, the isolate re-adopts the
// stale higher announcement on its next RPC, and scale-in becomes impossible.
// WIDTH_TTL_MS is what stops that, and it only works if a stream of LOWER
// reports cannot keep a higher value alive.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

let clock = 5_000_000;
let nowSpy: ReturnType<typeof spyOn> | null = null;

mock.module("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

const fakeEngine = {
	search: async () => ({ totalCards: 1, cards: [] }),
	searchSerialized: async () => ({ totalCards: 1, cards: "[]" }),
};

// The real store is wasm-backed; the rendezvous does not touch it.
mock.module("../../src/engine/store", () => ({
	getEngine: async () => fakeEngine,
	tryGetLoadedEngine: () => fakeEngine,
}));

const { SearchEngine } = await import("../../src/engine/search-engine-do");

type Do = { search: (opts: unknown, hint?: unknown, reported?: number) => Promise<{ shards: number }> };

function makeDo(): Do {
	return new SearchEngine({ waitUntil: () => {} } as never, {} as never) as unknown as Do;
}

/** One local search (no fallback hint, so no relay), returning the announcement. */
async function report(engine: Do, width?: number): Promise<number> {
	const result = await engine.search({ limit: 1 }, undefined, width);
	return result.shards;
}

beforeEach(() => {
	clock = 5_000_000;
	nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
	nowSpy?.mockRestore();
});

describe("announcing the fan-out width", () => {
	test("starts at one and echoes a lone caller", async () => {
		const engine = makeDo();
		expect(await report(engine, 1)).toBe(1);
	});

	test("takes the widest any caller reports", async () => {
		const engine = makeDo();
		await report(engine, 1);
		expect(await report(engine, 4)).toBe(4);
	});

	test("hands an unexpanded caller the width its peers reached", async () => {
		// The whole point: this caller arrived at 1 and leaves knowing 4.
		const engine = makeDo();
		await report(engine, 4);
		expect(await report(engine, 1)).toBe(4);
	});

	test("a caller reporting less does not lower it inside the TTL", async () => {
		const engine = makeDo();
		await report(engine, 4);
		clock += 30_000;
		expect(await report(engine, 2)).toBe(4);
	});

	test("treats a missing width as one, for rolling-update skew", async () => {
		const engine = makeDo();
		expect(await report(engine, undefined)).toBe(1);
	});

	test("clamps nonsense to one rather than announcing it", async () => {
		const engine = makeDo();
		expect(await report(engine, 0)).toBe(1);
		expect(await report(engine, -3)).toBe(1);
		expect(await report(engine, Number.NaN)).toBe(1);
	});
});

describe("decay, so adoption is not a ratchet", () => {
	test("a width nobody still reports ages out", async () => {
		const engine = makeDo();
		await report(engine, 4);
		clock += 61_000;
		// Everyone has contracted to 2; the announcement follows them down
		// instead of pinning them back at 4 forever.
		expect(await report(engine, 2)).toBe(2);
	});

	test("lower reports cannot keep a stale higher value alive", async () => {
		// The failure this guards: refreshing announcedAt on EVERY report would
		// mean a steady stream of 2s renewed the 4 indefinitely.
		const engine = makeDo();
		await report(engine, 4);
		for (let i = 0; i < 12; i++) {
			clock += 10_000;
			await report(engine, 2);
		}
		expect(await report(engine, 2)).toBe(2);
	});

	test("a still-live width keeps being renewed by callers at that width", async () => {
		const engine = makeDo();
		await report(engine, 4);
		for (let i = 0; i < 10; i++) {
			clock += 30_000;
			expect(await report(engine, 4)).toBe(4);
		}
	});
});
