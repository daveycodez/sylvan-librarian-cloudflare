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
	searchCardsAsObjects: async () => ({ totalCards: 1, cards: [] }),
	searchCardsAsJson: async () => ({ totalCards: 1, cards: "[]" }),
};

/** The two-step publish's call log, asserted by the prepare/commit suite below. */
const publishCalls: string[] = [];
/** Whether tryGetLoadedEngine reports this object warm (per-label irrelevant here). */
let objectIsWarm = true;

// The real store is wasm-backed; the rendezvous does not touch it.
mock.module("../../src/engine/store", () => ({
	getEngine: async () => fakeEngine,
	tryGetLoadedEngine: () => (objectIsWarm ? fakeEngine : null),
	// Imported by search-engine-do for notifyPublish and the two-step publish.
	refreshNow: async () => {
		publishCalls.push("refreshNow");
		return true;
	},
	prefetchStore: async () => {
		publishCalls.push("prefetchStore");
		return true;
	},
	swapToStore: async () => {
		publishCalls.push("swapToStore");
		return true;
	},
	// Imported for the two-phase gather; a null manifest keeps every gather
	// entry point on the local single-store path, which these tests exercise.
	currentManifest: () => null,
	gatherOps: () => null,
}));

// The placement probe fetches a trace URL; tests must never touch the network.
// Real exports are preserved for the suites that import them from the plain path.
const placementSpec = "../../src/engine/placement.ts?real-for-rendezvous";
const realPlacement = (await import(placementSpec)) as typeof import("../../src/engine/placement");
mock.module("../../src/engine/placement", () => ({
	...realPlacement,
	probePlacement: () => {},
}));

const { SearchEngine } = await import("../../src/engine/search-engine-do");

type Do = {
	searchCardsAsObjects: (opts: unknown, reported?: number) => Promise<{ shards: number; rate: number }>;
};

function makeDo(): Do {
	return new SearchEngine({ waitUntil: () => {} } as never, {} as never) as unknown as Do;
}

/** One search, returning the announcement it carries back. */
async function report(engine: Do, width?: number): Promise<number> {
	const result = await engine.searchCardsAsObjects({ limit: 1 }, width);
	return result.shards;
}

beforeEach(() => {
	clock = 5_000_000;
	nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
	nowSpy?.mockRestore();
});

describe("the two-step publish delegates swap to COMMIT, never prepare", () => {
	type PublishDo = {
		preparePublish(m?: unknown): Promise<{ prepared: boolean; shards: number }>;
		commitPublish(): Promise<{ swapped: boolean; shards: number }>;
	};

	/** Just enough SQLite for recordLiveManifest/readLiveManifest. */
	function fakeStorage() {
		let live: string | null = null;
		return {
			sql: {
				exec(query: string, ...b: unknown[]) {
					const q = query.trim();
					if (q.startsWith("INSERT OR REPLACE INTO live_manifest")) live = b[0] as string;
					if (q.startsWith("SELECT json FROM live_manifest")) {
						return { toArray: () => (live === null ? [] : [{ json: live }]) };
					}
					return { toArray: () => [] };
				},
			},
		};
	}

	function makePublishDo(): PublishDo {
		return new SearchEngine(
			{ waitUntil: () => {}, storage: fakeStorage(), id: { name: "engine-wnam-p0" } } as never,
			{} as never,
		) as unknown as PublishDo;
	}

	// PARTITIONED-shaped, which is the only shape any publisher writes — the
	// object above is engine-wnam-p0 and manifestServableBy makes it refuse
	// anything else, which the last test in this suite pins.
	const MANIFEST = {
		store_key: "card-store-v1-1.store",
		store_bytes: 10,
		built_at: "1",
		card_count: 1,
		partition_count: 1,
		partitions: [{ store_key: "card-store-v1-1-p0.store", store_bytes: 10, chunk_count: 1, card_count: 1 }],
	};

	test("prepare on a WARM object prefetches and does NOT swap", async () => {
		publishCalls.length = 0;
		objectIsWarm = true;
		const r = await makePublishDo().preparePublish(MANIFEST);
		expect(r.prepared).toBe(true);
		expect(publishCalls).toEqual(["prefetchStore"]);
	});

	test("commit on a WARM object swaps from the recorded manifest", async () => {
		publishCalls.length = 0;
		objectIsWarm = true;
		const engine = makePublishDo();
		await engine.preparePublish(MANIFEST);
		const r = await engine.commitPublish();
		expect(r.swapped).toBe(true);
		expect(publishCalls).toEqual(["prefetchStore", "swapToStore"]);
	});

	test("a COLD object acks both steps without touching the loader", async () => {
		publishCalls.length = 0;
		objectIsWarm = false;
		const engine = makePublishDo();
		expect((await engine.preparePublish(MANIFEST)).prepared).toBe(true);
		expect((await engine.commitPublish()).swapped).toBe(false);
		expect(publishCalls).toEqual([]);
		objectIsWarm = true;
	});

	test("commit with nothing recorded is a no-op ack, not a throw", async () => {
		publishCalls.length = 0;
		objectIsWarm = true;
		const r = await makePublishDo().commitPublish();
		expect(r.swapped).toBe(false);
		expect(publishCalls).toEqual([]);
	});

	test("a manifest shape the object's name cannot serve is ACKED but never cached or prefetched", async () => {
		// A pushed manifest with no partition_count — a builder bug, since every
		// publisher emits partitions. The object must refuse to record it (a cached
		// unservable manifest wedges the next cold load) while still acking, so
		// the coordinator's all-or-retry barrier does not wedge on it — and a
		// later commit must find nothing recorded.
		publishCalls.length = 0;
		objectIsWarm = true;
		const engine = makePublishDo();
		const unpartitioned = { store_key: "card-store-v1-9.store", store_bytes: 10, built_at: "9", card_count: 1 };
		expect((await engine.preparePublish(unpartitioned)).prepared).toBe(true);
		expect(publishCalls).toEqual([]); // no prefetch of a shape it cannot hold
		expect((await engine.commitPublish()).swapped).toBe(false); // nothing was recorded
		expect(publishCalls).toEqual([]);
	});
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

describe("the arrival-rate meter", () => {
	/** Fire n searches inside one second and return the last reported rate. */
	async function burst(engine: Do, n: number): Promise<number> {
		let rate = 0;
		for (let i = 0; i < n; i++) rate = (await engine.searchCardsAsObjects({ limit: 1 }, 1)).rate;
		return rate;
	}

	test("reports arrivals per second over the trailing window", async () => {
		const engine = makeDo();
		// 100 in one second, ten-second window: 10/s.
		expect(await burst(engine, 100)).toBeCloseTo(10, 5);
	});

	test("does not saturate above the old 410/s ceiling", async () => {
		// The array it replaced capped at 4096 samples over 10s, so it could
		// never report more than 409.6/s — the production expansion log read
		// "at 410/s", which was the cap rather than the traffic.
		const engine = makeDo();
		expect(await burst(engine, 20_000)).toBeCloseTo(2000, 5);
	});

	test("ages arrivals out once they leave the window", async () => {
		const engine = makeDo();
		await burst(engine, 100);
		clock += 11_000;
		// One arrival in the new window, nothing carried over from the old one.
		expect(await burst(engine, 1)).toBeCloseTo(0.1, 5);
	});

	test("keeps counting across a bucket boundary", async () => {
		const engine = makeDo();
		for (let s = 0; s < 5; s++) {
			await burst(engine, 10);
			clock += 1000;
		}
		// 50 arrivals spread over five buckets, plus this one, all still inside
		// the ten-second window.
		expect(await burst(engine, 1)).toBeCloseTo(5.1, 5);
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
