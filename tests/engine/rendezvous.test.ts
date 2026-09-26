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
import { ARCHIVE_FORMAT_VERSION } from "../../src/engine/store-kv";

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

/** x22: every bundle the fake engine was asked for, as its arguments. */
const bundlesAsked: unknown[][] = [];

const fakeEngine = {
	searchCardsAsObjects: async () => ({ totalCards: 1, cards: [] }),
	searchCardsAsJson: async () => ({ totalCards: 1, cards: "[]" }),
	scryfallNamedFuzzyBundle: async (...args: unknown[]) => {
		bundlesAsked.push(args);
		return { exact: { rank: null, present: false, card: null }, fuzzy: null, candidates: [], contained: [] };
	},
};

/** The two-step publish's call log, asserted by the prepare/commit suite below. */
const publishCalls: string[] = [];
/** Whether tryGetLoadedEngine reports this object warm (per-label irrelevant here). */
let objectIsWarm = true;
/** A cold load in flight for the object; settleInFlightLoad awaits it and the object comes up warm. */
let inFlightLoad: Promise<void> | null = null;

/**
 * The gather suite's own store, switched on per test. Null keeps every other suite on the plain
 * single-store behaviour: no manifest, no gather ops, an engine that is always already warm.
 */
let gatherStore: {
	/** Resolves when this object's own partition finishes loading. */
	ownLoad: Promise<void>;
	loaded: boolean;
	/** How long the own load reports, in fake-clock ms. */
	ownLoadMs: number;
	events: string[];
	manifest: unknown;
	ops: unknown;
} | null = null;

/** x22: what this object's names index plans for a fuzzy needle (null: it cannot plan). */
let fuzzyPlanAnswer: { partitions: number[]; everywhere: boolean; stage: string; builtAt: string } | null = null;

/** n15: what this object's names index answers a gathered search (null: it cannot say). */
let namesIndexAnswer: number[] | null = null;
/** n15: the builds namesSearchPartitions was asked for. */
const namesIndexAsked: string[] = [];

// The real store is wasm-backed; the rendezvous does not touch it.
mock.module("../../src/engine/store", () => ({
	namesSearchPartitions: async (_env: unknown, _ctx: unknown, _opts: unknown, builtAt: string) => {
		namesIndexAsked.push(builtAt);
		return namesIndexAnswer;
	},
	// n8: imported by search-engine-do for scryfallAutocompleteNames; nothing here routes to it.
	autocompleteFromNames: async () => [],
	// n15: the fuzzy plan's; x22's suite sets what it answers.
	namesFuzzyPlan: async () => {
		if (fuzzyPlanAnswer === null) throw new Error("no names index");
		return fuzzyPlanAnswer;
	},
	collectionPacketOf: () => new Uint8Array(),
	getEngine: async () => {
		const g = gatherStore;
		if (g && !g.loaded) {
			g.events.push("own:load-start");
			await g.ownLoad;
			clock += g.ownLoadMs;
			g.loaded = true;
			g.events.push("own:loaded");
		}
		return fakeEngine;
	},
	tryGetLoadedEngine: () => (objectIsWarm ? fakeEngine : null),
	settleInFlightLoad: async () => {
		if (inFlightLoad) {
			await inFlightLoad;
			inFlightLoad = null;
			objectIsWarm = true;
		}
	},
	// Imported by search-engine-do for notifyPublish and the two-step publish.
	refreshNow: async () => {
		publishCalls.push("refreshNow");
		return true;
	},
	prefetchStore: async () => {
		publishCalls.push("prefetchStore");
		return true;
	},
	// The cold branch of preparePublish drops a stale build's cache (r3); nothing is loaded.
	pruneToManifest: () => {
		publishCalls.push("pruneToManifest");
		return 0;
	},
	swapToStore: async () => {
		publishCalls.push("swapToStore");
		return true;
	},
	// Imported for the two-phase gather; a null manifest keeps every gather
	// entry point on the local single-store path, which these tests exercise.
	currentManifest: () => (gatherStore?.loaded ? gatherStore.manifest : null),
	gatherOps: () => (gatherStore?.loaded ? gatherStore.ops : null),
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
const { encodeKeyPacket, encodeRowPacket } = await import("../../src/engine/gather");

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
		notifyPublish(m?: unknown): Promise<{ swapped: boolean; shards: number }>;
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
		format_version: ARCHIVE_FORMAT_VERSION,
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

	test("a COLD object acks both steps without loading, only dropping a stale build's cache", async () => {
		publishCalls.length = 0;
		objectIsWarm = false;
		const engine = makePublishDo();
		expect((await engine.preparePublish(MANIFEST)).prepared).toBe(true);
		expect((await engine.commitPublish()).swapped).toBe(false);
		// No prefetch, no swap: the one loader call is the row-delete prune (r3), which loads nothing.
		expect(publishCalls).toEqual(["pruneToManifest"]);
		objectIsWarm = true;
	});

	test("a commit arriving MID-LOAD waits for the load, then swaps", async () => {
		// A request's cold load is streaming when the publish lands. Judged by
		// tryGetLoadedEngine alone the object looks cold, acks both steps, and
		// then finishes its OLD load and serves it under a record naming the new
		// store. Settling the in-flight load first makes it a warm object.
		publishCalls.length = 0;
		objectIsWarm = false;
		let finishLoad: () => void = () => {};
		inFlightLoad = new Promise<void>((resolve) => {
			finishLoad = resolve;
		});
		const engine = makePublishDo();
		const prepared = engine.preparePublish(MANIFEST);
		finishLoad();
		expect((await prepared).prepared).toBe(true);
		expect(publishCalls).toEqual(["prefetchStore"]);
		const r = await engine.commitPublish();
		expect(r.swapped).toBe(true);
		expect(publishCalls).toEqual(["prefetchStore", "swapToStore"]);
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

	test("another archive format's manifest is ACKED but never cached or prefetched (x19)", async () => {
		// The previous build's coordinator, reset by a deploy mid-notify, can still reach an object
		// that already runs this build. Its engine would refuse that store after fetching all of it.
		publishCalls.length = 0;
		objectIsWarm = true;
		const engine = makePublishDo();
		const older = { ...MANIFEST, format_version: ARCHIVE_FORMAT_VERSION - 1 };
		expect((await engine.preparePublish(older)).prepared).toBe(true);
		expect(publishCalls).toEqual([]);
		expect((await engine.commitPublish()).swapped).toBe(false);
		expect((await engine.notifyPublish(older)).swapped).toBe(false);
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

describe("a cold gather wakes every partition at once", () => {
	// The coordinator used to acquire its OWN store before fanning out, so a cold region paid two
	// loads back to back: measured 2026-09-22, the coordinator loaded by +1.6s and the siblings'
	// loads only began after it. The fan-out needs the partition COUNT, which the pushed manifest
	// already names, so the siblings must be asked before the coordinator's load completes.

	const WIDE = {
		store_key: "card-store-v1-7.store",
		store_bytes: 20,
		built_at: "7",
		card_count: 2,
		partition_count: 2,
		format_version: ARCHIVE_FORMAT_VERSION,
		partitions: [
			{ store_key: "card-store-v1-7-p0.store", store_bytes: 10, chunk_count: 1, card_count: 1 },
			{ store_key: "card-store-v1-7-p1.store", store_bytes: 10, chunk_count: 1, card_count: 1 },
		],
	};
	const row = (p: number) => new TextEncoder().encode(`{"name":"p${p}"}`);
	const packet = (p: number, inline: number) =>
		encodeKeyPacket({
			total: 1,
			entries: [{ key: new Uint8Array([p + 1]), vpid: 0 }],
			inlineRows: inline > 0 ? [row(p)] : [],
		});

	type GatherDo = {
		gatherSearchAsJson(
			opts: unknown,
			shape: string,
			reported?: number,
		): Promise<{ totalCards: number; cardsBytes: Uint8Array; acquireMs: number }>;
	};

	function coldGather(siblingAcquireMs: number) {
		let finishOwnLoad = () => {};
		const events: string[] = [];
		gatherStore = {
			ownLoad: new Promise<void>((resolve) => {
				finishOwnLoad = resolve;
			}),
			loaded: false,
			ownLoadMs: 900,
			events,
			manifest: WIDE,
			ops: {
				storeKey: "card-store-v1-7-p0.store",
				sortKeyVersion: () => 1,
				queryKeys: () => packet(0, 0),
				fetchRows: () => encodeRowPacket([row(0)]),
			},
		};
		const sibling = {
			async searchKeys(_opts: unknown, inline: number) {
				events.push("p1:searchKeys");
				// The sibling is asked while the coordinator is still loading; let that load finish
				// only now, so the order is observable.
				finishOwnLoad();
				return {
					packed: packet(1, inline),
					storeKey: "card-store-v1-7-p1.store",
					sortKeyVersion: 1,
					shape: "rows",
					acquireMs: siblingAcquireMs,
				};
			},
			async fetchRows() {
				return { rowsBytes: encodeRowPacket([row(1)]), shape: "rows" };
			},
		};
		const live = JSON.stringify(WIDE);
		const storage = {
			sql: {
				exec(query: string) {
					if (query.trim().startsWith("SELECT json FROM live_manifest")) return { toArray: () => [{ json: live }] };
					return { toArray: () => [] };
				},
			},
		};
		const env = {
			SEARCH_ENGINE: {
				idFromName: (name: string) => name,
				get: (name: string) => {
					if (name !== "engine-wnam-p1") throw new Error(`unexpected sibling ${name}`);
					return sibling;
				},
			},
		};
		const engine = new SearchEngine(
			{ waitUntil: () => {}, storage, id: { name: "engine-wnam-p0" } } as never,
			env as never,
		) as unknown as GatherDo;
		return { engine, events };
	}

	const OPTS = { filterTreeJson: "{}", unique: "printing", orderby: "name", limit: 2, offset: 0, fields: ["name"] };

	afterEach(() => {
		gatherStore = null;
	});

	test("siblings are asked before the coordinator's own store has loaded", async () => {
		const { engine, events } = coldGather(0);
		const page = await engine.gatherSearchAsJson(OPTS, "rows");
		expect(events.indexOf("p1:searchKeys")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("p1:searchKeys")).toBeLessThan(events.indexOf("own:loaded"));
		expect(page.totalCards).toBe(2);
		expect(new TextDecoder().decode(page.cardsBytes)).toBe('[{"name":"p0"},{"name":"p1"}]');
	});

	test("the page reports the longest wake anywhere in the fan-out, not only its own", async () => {
		// A sibling that woke inflates the page's wall time. Reporting 0 over it handed the
		// autoscaler a multi-second "warm" latency sample.
		const { engine } = coldGather(2_400);
		const page = await engine.gatherSearchAsJson(OPTS, "rows");
		expect(page.acquireMs).toBe(2_400);
	});

	test("the coordinator's own wake counts when it is the longest", async () => {
		const { engine } = coldGather(0);
		const page = await engine.gatherSearchAsJson(OPTS, "rows");
		expect(page.acquireMs).toBe(900);
	});
});

describe("a gather awaiting its siblings is concurrency, not queue depth", () => {
	// 2026-09-22 08:20:56, DeckGen: 11 isolates opened weur-1 on "sustained queue depth" within
	// 230ms, with no store load anywhere in weur for the 25s before. On a warm object every
	// non-gather handler runs to completion before the next RPC is delivered, so the only thing
	// that could have been "in flight" at an arrival was a gather waiting on its siblings.
	test("an arrival during an in-flight warm gather reports load 0, and so does a second gather", async () => {
		let releaseSibling = () => {};
		const siblingGate = new Promise<void>((resolve) => {
			releaseSibling = resolve;
		});
		const row = new TextEncoder().encode('{"name":"x"}');
		const keys = (p: number) =>
			encodeKeyPacket({ total: 1, entries: [{ key: new Uint8Array([p + 1]), vpid: 0 }], inlineRows: [row] });
		gatherStore = {
			ownLoad: Promise.resolve(),
			loaded: true,
			ownLoadMs: 0,
			events: [],
			manifest: {
				store_key: "card-store-v1-7.store",
				store_bytes: 20,
				built_at: "7",
				card_count: 2,
				partition_count: 2,
				format_version: ARCHIVE_FORMAT_VERSION,
				partitions: [
					{ store_key: "card-store-v1-7-p0.store", store_bytes: 10, chunk_count: 1, card_count: 1 },
					{ store_key: "card-store-v1-7-p1.store", store_bytes: 10, chunk_count: 1, card_count: 1 },
				],
			},
			ops: {
				storeKey: "card-store-v1-7-p0.store",
				sortKeyVersion: () => 1,
				queryKeys: () => keys(0),
				fetchRows: () => encodeRowPacket([row]),
			},
		};
		const sibling = {
			async searchKeys() {
				await siblingGate;
				return {
					packed: keys(1),
					storeKey: "card-store-v1-7-p1.store",
					sortKeyVersion: 1,
					shape: "rows",
					acquireMs: 0,
				};
			},
			async fetchRows() {
				return { rowsBytes: encodeRowPacket([row]), shape: "rows" };
			},
		};
		const env = { SEARCH_ENGINE: { idFromName: (n: string) => n, get: () => sibling } };
		const storage = { sql: { exec: () => ({ toArray: () => [] }) } };
		const engine = new SearchEngine(
			{ waitUntil: () => {}, storage, id: { name: "engine-weur-p0" } } as never,
			env as never,
		) as unknown as {
			gatherSearchAsJson(o: unknown, shape: string): Promise<{ load: number }>;
			searchCardsAsObjects(o: unknown): Promise<{ load: number }>;
		};
		const OPTS = { filterTreeJson: "{}", unique: "printing", orderby: "name", limit: 2, offset: 0, fields: ["name"] };
		try {
			const first = engine.gatherSearchAsJson(OPTS, "rows");
			const second = engine.gatherSearchAsJson(OPTS, "rows");
			// Both gathers are now parked on their sibling; a plain search arrives.
			const plain = await engine.searchCardsAsObjects({ limit: 1 });
			expect(plain.load).toBe(0);
			releaseSibling();
			expect((await first).load).toBe(0);
			expect((await second).load).toBe(0);
		} finally {
			gatherStore = null;
		}
	});
});

describe("a name-only gather asks only the partitions its names index names (n15)", () => {
	const WIDE = {
		store_key: "card-store-v1-7.store",
		store_bytes: 30,
		built_at: "7",
		card_count: 3,
		partition_count: 3,
		format_version: ARCHIVE_FORMAT_VERSION,
		partitions: [0, 1, 2].map((k) => ({
			store_key: `card-store-v1-7-p${k}.store`,
			store_bytes: 10,
			chunk_count: 1,
			card_count: 1,
		})),
	};
	const row = (p: number) => new TextEncoder().encode(`{"name":"p${p}"}`);
	const packet = (p: number, inline: number) =>
		encodeKeyPacket({
			total: 1,
			entries: [{ key: new Uint8Array([p + 1]), vpid: 0 }],
			inlineRows: inline > 0 ? [row(p)] : [],
		});
	type GatherDo = {
		gatherSearchAsJson(opts: unknown, shape: string): Promise<{ totalCards: number; cardsBytes: Uint8Array }>;
	};

	function gather(siblingBuild = "7") {
		const asked: number[] = [];
		gatherStore = {
			ownLoad: Promise.resolve(),
			loaded: true,
			ownLoadMs: 0,
			events: [],
			manifest: WIDE,
			ops: {
				storeKey: "card-store-v1-7-p0.store",
				sortKeyVersion: () => 1,
				queryKeys: () => {
					asked.push(0);
					return packet(0, 0);
				},
				fetchRows: () => encodeRowPacket([row(0)]),
			},
		};
		const sibling = (p: number) => ({
			async searchKeys(_opts: unknown, inline: number) {
				asked.push(p);
				return {
					packed: packet(p, inline),
					storeKey: `card-store-v1-${siblingBuild}-p${p}.store`,
					sortKeyVersion: 1,
					shape: "rows",
				};
			},
			async fetchRows() {
				return { rowsBytes: encodeRowPacket([row(p)]), shape: "rows" };
			},
			async notifyPublish() {
				return { swapped: false, shards: 1 };
			},
		});
		const env = {
			SEARCH_ENGINE: {
				idFromName: (name: string) => name,
				get: (name: string) => sibling(Number(name.slice(-1))),
			},
		};
		const storage = { sql: { exec: () => ({ toArray: () => [] }) } };
		const engine = new SearchEngine(
			{ waitUntil: () => {}, storage, id: { name: "engine-wnam-p0" } } as never,
			env as never,
		) as unknown as GatherDo;
		return { engine, asked };
	}
	const NAME_TREE = JSON.stringify({
		node_type: "CardBinaryOperatorNode",
		kwargs: {
			op: ":",
			lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_name" } },
			rhs: { node_type: "CollatedNameValueNode", kwargs: { value: "bolt" } },
		},
	});
	const OPTS = { filterTreeJson: NAME_TREE, unique: "card", orderby: "name", limit: 5, offset: 0, fields: ["name"] };
	const text = (b: Uint8Array) => new TextDecoder().decode(b);

	afterEach(() => {
		gatherStore = null;
		namesIndexAnswer = null;
		namesIndexAsked.length = 0;
	});

	test("the named partitions alone, and the page is the same as theirs in the full gather", async () => {
		namesIndexAnswer = [2];
		const { engine, asked } = gather();
		const page = await engine.gatherSearchAsJson({ ...OPTS, namesBuild: "7" }, "rows");
		expect(asked).toEqual([2]);
		expect(namesIndexAsked).toEqual(["7"]);
		expect(page.totalCards).toBe(1);
		expect(text(page.cardsBytes)).toBe('[{"name":"p2"}]');
	});

	test("no partition holds a match: the empty page, with no partition asked", async () => {
		namesIndexAnswer = [];
		const { engine, asked } = gather();
		const page = await engine.gatherSearchAsJson({ ...OPTS, namesBuild: "7" }, "rows");
		expect(asked).toEqual([]);
		expect(page.totalCards).toBe(0);
		expect(text(page.cardsBytes)).toBe("[]");
	});

	test("an index that cannot say, no pinned build, or a partition number out of range: every partition", async () => {
		for (const [answer, opts] of [
			[null, { ...OPTS, namesBuild: "7" }],
			[[1], OPTS],
			[[3], { ...OPTS, namesBuild: "7" }],
		] as const) {
			namesIndexAnswer = answer as number[] | null;
			const { engine, asked } = gather();
			const page = await engine.gatherSearchAsJson(opts, "rows");
			expect(asked.sort()).toEqual([0, 1, 2]);
			expect(page.totalCards).toBe(3);
		}
	});

	test("a filter that plainly reads more than names never asks the index (nor waits on this store for it)", async () => {
		namesIndexAnswer = [2];
		const { engine, asked } = gather();
		await engine.gatherSearchAsJson({ ...OPTS, filterTreeJson: '{"node_type":"TrueNode"}', namesBuild: "7" }, "rows");
		expect(namesIndexAsked).toEqual([]);
		expect(asked.sort()).toEqual([0, 1, 2]);
	});

	test("partitions answering from another build than the index's: thrown away, every partition asked", async () => {
		namesIndexAnswer = [1];
		const { engine, asked } = gather("8");
		await engine.gatherSearchAsJson({ ...OPTS, namesBuild: "7" }, "rows").catch(() => {});
		// The pruned run asked partition 1 (and re-asked it as a straggler); the fallback asks all.
		expect(asked.includes(0)).toBe(true);
		expect(asked.includes(2)).toBe(true);
	});
});

describe("the fuzzy plan's object answers its own bundle in the same call (x22)", () => {
	type PlanDo = {
		scryfallNamedFuzzyPlan(
			folded: string,
			words: string[],
			reportedShards?: number,
			own?: { partition: number; limit: number; baseUrl: string },
		): Promise<{ partitions: number[]; everywhere: boolean; bundle?: unknown }>;
	};
	const planDo = () => makeDo() as unknown as PlanDo;
	const own = { partition: 4, limit: 2, baseUrl: "https://x" };

	afterEach(() => {
		fuzzyPlanAnswer = null;
		bundlesAsked.length = 0;
	});

	test("a plan naming this object's partition, or every partition, carries its bundle", async () => {
		for (const plan of [
			{ partitions: [1, 4], everywhere: false, stage: "typo", builtAt: "1" },
			{ partitions: [], everywhere: true, stage: "contained", builtAt: "1" },
		]) {
			fuzzyPlanAnswer = plan;
			bundlesAsked.length = 0;
			const reply = await planDo().scryfallNamedFuzzyPlan("shok", ["shok"], 1, own);
			expect(reply.partitions).toEqual(plan.partitions);
			expect(reply.bundle).toBeDefined();
			// The bundle's own arguments; never a set (a set= needle is never planned).
			expect(bundlesAsked).toEqual([["shok", "", ["shok"], 2, "https://x"]]);
		}
	});

	test("a plan leaving this object out, or a router that did not ask, computes no bundle", async () => {
		fuzzyPlanAnswer = { partitions: [1], everywhere: false, stage: "typo", builtAt: "1" };
		expect((await planDo().scryfallNamedFuzzyPlan("shok", ["shok"], 1, own)).bundle).toBeUndefined();
		fuzzyPlanAnswer = { partitions: [], everywhere: true, stage: "contained", builtAt: "1" };
		expect((await planDo().scryfallNamedFuzzyPlan("shok", ["shok"], 1)).bundle).toBeUndefined();
		expect(bundlesAsked).toEqual([]);
	});
});
