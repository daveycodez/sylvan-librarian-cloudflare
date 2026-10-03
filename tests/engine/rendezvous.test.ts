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
import { BUILD_COMMIT } from "../../src/build-info.gen";
import { resetSiblingMemoryForTests, setSiblingHedgeForTests } from "../../src/engine/sibling-hedge";
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
		return {
			exact: { rank: bundleRank, present: bundleRank !== null, card: null },
			fuzzy: null,
			candidates: [],
			contained: [],
		};
	},
};
/** x48: the rank the fake engine's bundle answers the needle with (null: it ranks nothing). */
let bundleRank: unknown[] | null = null;

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
/** x47: the packet the fake store answers a collection batch with, and the names index's holders. */
let collectionPacket = new Uint8Array();
let holdersAnswer: Record<string, number[]> | null = null;
const holdersAsked: string[][] = [];

/** x56: the engine labels the fake isolate holds — the `holds=` of a slow gather's line. */
let residentLabels: string[] = [];

// The real store is wasm-backed; the rendezvous does not touch it.
mock.module("../../src/engine/store", () => ({
	residentEngineLabels: () => residentLabels,
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
	collectionPacketOf: () => collectionPacket,
	// x47: who holds each name, by the names index; the suite sets what it answers.
	namesExactHolders: async (_env: unknown, _ctx: unknown, foldeds: string[]) => {
		holdersAsked.push(foldeds);
		return holdersAnswer === null ? null : { builtAt: "1", holders: foldeds.map((f) => holdersAnswer?.[f] ?? []) };
	},
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
	// x23: the cold coordinator's reservation, recorded in the gather suite's event order.
	reserveStoreBuffer: (label: string, manifest: { partitions?: { store_bytes: number }[] }, partition?: number) => {
		const g = gatherStore;
		if (!g || g.loaded) return null;
		const bytes = manifest.partitions?.[partition ?? -1]?.store_bytes;
		g.events.push(`own:reserve ${label} ${bytes}`);
		return bytes === undefined ? null : { bytes, linearBefore: 1_048_576, linearAfter: 1_048_576 + bytes };
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
const { resetGatherHealthForTests } = await import("../../src/engine/gather-health");

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

	test("a cold coordinator reserves its own store's memory before asking any sibling (x23)", async () => {
		// Workers cancels an invocation's still-connecting DO calls when its memory jumps, and the
		// coordinator's own load is a ~45MB jump: the reservation must land before the fan-out.
		const { engine, events } = coldGather(0);
		await engine.gatherSearchAsJson(OPTS, "rows");
		expect(events[0]).toBe("own:reserve engine-wnam-p0 10");
		expect(events.filter((e) => e.startsWith("own:reserve"))).toHaveLength(1);
		// ...and the load itself still runs alongside the siblings' (a2432b3).
		expect(events.indexOf("p1:searchKeys")).toBeLessThan(events.indexOf("own:loaded"));
	});

	test("a warm coordinator reserves nothing", async () => {
		const { engine, events } = coldGather(0);
		await engine.gatherSearchAsJson(OPTS, "rows");
		events.length = 0;
		await engine.gatherSearchAsJson(OPTS, "rows");
		expect(events.filter((e) => e.startsWith("own:"))).toEqual([]);
		expect(events).toContain("p1:searchKeys");
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

	// y1: a search restricted to a list of cards names its partitions itself (card-restriction.ts).
	describe("a card-list gather asks only the partitions the router listed (y1)", () => {
		const LIST_TREE = JSON.stringify({
			node_type: "OrNode",
			kwargs: {
				operands: [
					{ node_type: "ExactNameNode", kwargs: { value: "a" } },
					{ node_type: "ExactNameNode", kwargs: { value: "b" } },
				],
			},
		});
		const LIST = { ...OPTS, filterTreeJson: LIST_TREE };

		test("the listed partitions alone, merged in order, and never the names index", async () => {
			namesIndexAnswer = [1];
			const { engine, asked } = gather();
			const page = await engine.gatherSearchAsJson(
				{ ...LIST, namesBuild: "7", gatherPartitions: { build: "7", partitions: [0, 2] } },
				"rows",
			);
			expect(asked.sort()).toEqual([0, 2]);
			expect(namesIndexAsked).toEqual([]);
			expect(page.totalCards).toBe(2);
			expect(text(page.cardsBytes)).toBe('[{"name":"p0"},{"name":"p2"}]');
		});

		test("a list of ONE partition — another object's — is a gather of one", async () => {
			const { engine, asked } = gather();
			const page = await engine.gatherSearchAsJson(
				{ ...LIST, gatherPartitions: { build: "7", partitions: [1] } },
				"rows",
			);
			expect(asked).toEqual([1]);
			expect(text(page.cardsBytes)).toBe('[{"name":"p1"}]');
		});

		test("a list for another build than this object loaded, out of range, unordered or empty: every partition", async () => {
			for (const list of [
				{ build: "6", partitions: [1] },
				{ build: "7", partitions: [1, 3] },
				{ build: "7", partitions: [2, 1] },
				{ build: "7", partitions: [] },
				{ build: "", partitions: [1] },
			]) {
				const { engine, asked } = gather();
				const page = await engine.gatherSearchAsJson({ ...LIST, gatherPartitions: list }, "rows");
				expect(asked.sort()).toEqual([0, 1, 2]);
				expect(page.totalCards).toBe(3);
			}
		});

		test("listed partitions that answer from another build: thrown away, every partition asked", async () => {
			const { engine, asked } = gather("8");
			await engine
				.gatherSearchAsJson({ ...LIST, gatherPartitions: { build: "7", partitions: [1, 2] } }, "rows")
				.catch(() => {});
			expect(asked.includes(0)).toBe(true);
		});
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

describe("a full gather keeps at most six sibling calls outstanding (x44)", () => {
	// DeckGen 2026-09-29 → 10-02: 893 sibling calls died "Network connection lost." inside warm
	// coordinators, each burst either the first k calls the coordinator issued or its last four —
	// the runtime's six-connection queue, which a ten-call fan-out always overflowed by four.
	const N = 11;
	const OWN = 9;
	const row = (p: number) => new TextEncoder().encode(`{"name":"p${p}"}`);
	const keys = (p: number, inline: number) =>
		encodeKeyPacket({
			total: 1,
			entries: [{ key: new Uint8Array([p + 1]), vpid: 0 }],
			inlineRows: inline > 0 ? [row(p)] : [],
		});
	const OPTS = { filterTreeJson: "{}", unique: "printing", orderby: "name", limit: 20, offset: 0, fields: ["name"] };

	function warmRegion() {
		gatherStore = {
			ownLoad: Promise.resolve(),
			loaded: true,
			ownLoadMs: 0,
			events: [],
			manifest: {
				store_key: "card-store-v1-7.store",
				store_bytes: 10 * N,
				built_at: "7",
				card_count: N,
				partition_count: N,
				format_version: ARCHIVE_FORMAT_VERSION,
				partitions: Array.from({ length: N }, (_, p) => ({
					store_key: `card-store-v1-7-p${p}.store`,
					store_bytes: 10,
					chunk_count: 1,
					card_count: 1,
				})),
			},
			ops: {
				storeKey: `card-store-v1-7-p${OWN}.store`,
				sortKeyVersion: () => 1,
				queryKeys: () => keys(OWN, 0),
				fetchRows: () => encodeRowPacket([row(OWN)]),
			},
		};
		/** `stuck`: the sibling whose first searchKeys stays outstanding 40ms of real time, the fake
		 * clock reading 600ms meanwhile (x53) — -1 for none. */
		const seen = { outstanding: 0, peak: 0, asked: [] as string[], stuck: -1 };
		const held = async (ms = 1) => {
			seen.peak = Math.max(seen.peak, ++seen.outstanding);
			await new Promise((resolve) => setTimeout(resolve, ms));
			seen.outstanding--;
		};
		const env = {
			SEARCH_ENGINE: {
				idFromName: (name: string) => name,
				get: (name: string) => {
					const p = Number(name.slice("engine-enam-p".length));
					return {
						async searchKeys(_opts: unknown, inline: number) {
							seen.asked.push(`keys:${p}`);
							if (p === seen.stuck && seen.asked.filter((a) => a === `keys:${p}`).length === 1) {
								setTimeout(() => {
									clock += 600;
								}, 3);
								await held(40);
							} else await held();
							return {
								packed: keys(p, inline),
								storeKey: `card-store-v1-7-p${p}.store`,
								sortKeyVersion: 1,
								shape: "rows",
								acquireMs: 0,
							};
						},
						async fetchRows() {
							seen.asked.push(`rows:${p}`);
							await held();
							return { rowsBytes: encodeRowPacket([row(p)]), shape: "rows" };
						},
					};
				},
			},
		};
		const storage = { sql: { exec: () => ({ toArray: () => [] }) } };
		const engine = new SearchEngine(
			{ waitUntil: () => {}, storage, id: { name: `engine-enam-p${OWN}` } } as never,
			env as never,
		) as unknown as {
			gatherSearchAsJson(o: unknown, shape: string): Promise<{ totalCards: number; cardsBytes: Uint8Array }>;
		};
		return { engine, seen };
	}

	const WHOLE_PAGE = `[${Array.from({ length: N }, (_, p) => `{"name":"p${p}"}`).join(",")}]`;

	afterEach(() => {
		gatherStore = null;
	});

	test("ten siblings: each asked once, in order, never more than six at a time, and the same page", async () => {
		const { engine, seen } = warmRegion();
		const page = await engine.gatherSearchAsJson(OPTS, "rows");
		expect(seen.peak).toBe(6);
		// No call added for the limit, none dropped, none reordered: one searchKeys per sibling in
		// partition order, and a fetchRows only where the page's rows were not inlined.
		expect(seen.asked.filter((a) => a.startsWith("keys:"))).toEqual(
			Array.from({ length: N }, (_, p) => p)
				.filter((p) => p !== OWN)
				.map((p) => `keys:${p}`),
		);
		expect(new Set(seen.asked).size).toBe(seen.asked.length);
		expect(page.totalCards).toBe(N);
		expect(new TextDecoder().decode(page.cardsBytes)).toBe(WHOLE_PAGE);
	});

	test("a hedge (x53) takes a slot like any other call: still never more than six, and the same page", async () => {
		const restoreHedge = setSiblingHedgeForTests({ floorMs: 5, wakingFloorMs: 5, crossRegion: false });
		const realWarn = console.warn;
		const lines: string[] = [];
		console.warn = (...args: unknown[]) => lines.push(args.join(" "));
		try {
			const { engine, seen } = warmRegion();
			seen.stuck = 4;
			const page = await engine.gatherSearchAsJson(OPTS, "rows");
			expect(new TextDecoder().decode(page.cardsBytes)).toBe(WHOLE_PAGE);
			expect(seen.asked.filter((a) => a === "keys:4")).toHaveLength(2);
			expect(seen.asked.filter((a) => a.startsWith("keys:"))).toHaveLength(N);
			expect(seen.peak).toBe(6);
			expect(lines.filter((l) => l.includes("sibling hedge"))).toEqual([
				expect.stringMatching(
					/^\[engine-enam-p9\] sibling hedge p4 searchKeys: fired at 600ms; won by hedge at 600ms \(\d+ of 10 answered, median 0ms\)$/,
				),
			]);
			await new Promise((resolve) => setTimeout(resolve, 45)); // let the first call land
		} finally {
			console.warn = realWarn;
			restoreHedge();
		}
	});

	test("two gathers on one coordinator each keep six, and both answer the whole page", async () => {
		const { engine, seen } = warmRegion();
		const [a, b] = await Promise.all([
			engine.gatherSearchAsJson(OPTS, "rows"),
			engine.gatherSearchAsJson(OPTS, "rows"),
		]);
		expect(seen.peak).toBe(12);
		expect(new TextDecoder().decode(a.cardsBytes)).toBe(WHOLE_PAGE);
		expect(new TextDecoder().decode(b.cardsBytes)).toBe(WHOLE_PAGE);
	});
});

describe("a coordinator whose sibling calls arrive late stops coordinating (x45)", () => {
	// DeckGen 2026-09-29 20:42–21:49, engine-wnam-p9: every gather took 3.2s or 6.3s for the life of
	// one isolate, on ~40ms of CPU, because some of its calls reached their sibling ~1s or ~3.1s
	// late; the siblings ran them in milliseconds and four other coordinators were unaffected.
	const WIDE = {
		store_key: "card-store-v1-7.store",
		store_bytes: 40,
		built_at: "7",
		card_count: 4,
		partition_count: 4,
		format_version: ARCHIVE_FORMAT_VERSION,
		partitions: [0, 1, 2, 3].map((p) => ({
			store_key: `card-store-v1-7-p${p}.store`,
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
	const OPTS = { filterTreeJson: "{}", unique: "printing", orderby: "name", limit: 4, offset: 0, fields: ["name"] };

	/** A warm coordinator `engine-oc-p0` with three siblings; `late` is how long the fake clock runs
	 * while each sibling's call is on its way (set per test, read per call). */
	function coordinator() {
		const late: Record<number, number> = {};
		/** x53: a sibling whose FIRST call each gather is on its way for `ms` of real time (the fake
		 * clock reading 600ms once the others have answered and 3,100ms when it lands), and whose
		 * second — the hedge — answers at once, or after `hedgeMs` of real time when that is set. */
		const stuck: Record<number, { ms: number; hedgeMs?: number }> = {};
		const calls: Record<number, number> = {};
		const asked: number[] = [];
		const rowsAsked: number[] = [];
		/** x55: the neighbour region's objects (oc's is apac-se) — the build they hold, every call they
		 * were sent, and how each stub to them was obtained. */
		const there = {
			build: "7",
			asked: [] as string[],
			gets: [] as { name: string; options: unknown }[],
		};
		const neighbourSibling = (p: number) => ({
			async searchKeys(_opts: unknown, inline: number, shaping: { shape: string }) {
				there.asked.push(`keys:${p}`);
				return {
					packed: packet(p, inline),
					storeKey: `card-store-v1-${there.build}-p${p}.store`,
					sortKeyVersion: 1,
					shape: shaping.shape,
					acquireMs: 0,
				};
			},
			async fetchRows(_vpids: unknown, _fields: unknown, storeKey: string) {
				there.asked.push(`rows:${p}`);
				const held = `card-store-v1-${there.build}-p${p}.store`;
				if (storeKey !== held)
					throw new Error(`generation mismatch: rows asked from ${storeKey} but it serves ${held}`);
				return { rowsBytes: encodeRowPacket([row(p)]), shape: "cards" };
			},
		});
		gatherStore = {
			ownLoad: Promise.resolve(),
			loaded: true,
			ownLoadMs: 0,
			events: [],
			manifest: WIDE,
			ops: {
				storeKey: "card-store-v1-7-p0.store",
				sortKeyVersion: () => 1,
				queryKeys: () => packet(0, 0),
				fetchRows: () => encodeRowPacket([row(0)]),
			},
		};
		const sibling = (p: number) => ({
			async searchKeys(_opts: unknown, inline: number, shaping: { shape: string }) {
				asked.push(p);
				const held = stuck[p];
				if (held) {
					calls[p] = (calls[p] ?? 0) + 1;
					if ((calls[p] as number) % 2 === 1) {
						await new Promise((resolve) => setTimeout(resolve, 1));
						clock += 600;
						await new Promise((resolve) => setTimeout(resolve, held.ms));
						clock += 2_500;
					} else if (held.hedgeMs) {
						await new Promise((resolve) => setTimeout(resolve, held.hedgeMs));
					}
				}
				if (late[p]) {
					// The quick siblings answer (and are timed) first; only then does the clock run on
					// for the late one — as in production, where the others had long since replied.
					await new Promise((resolve) => setTimeout(resolve, 1));
					clock += late[p] as number;
				}
				return {
					packed: packet(p, inline),
					storeKey: `card-store-v1-7-p${p}.store`,
					sortKeyVersion: 1,
					shape: shaping.shape,
					acquireMs: 0,
				};
			},
			async fetchRows() {
				rowsAsked.push(p);
				return { rowsBytes: encodeRowPacket([row(p)]), shape: "cards" };
			},
		});
		const env = {
			SEARCH_ENGINE: {
				idFromName: (name: string) => name,
				get: (name: string, options?: unknown) => {
					if (name.startsWith("engine-oc-p")) return sibling(Number(name.slice("engine-oc-p".length)));
					there.gets.push({ name, options });
					return neighbourSibling(Number(name.slice(name.lastIndexOf("-p") + 2)));
				},
			},
		};
		const storage = { sql: { exec: () => ({ toArray: () => [] }) } };
		const engine = new SearchEngine(
			{ waitUntil: () => {}, storage, id: { name: "engine-oc-p0" } } as never,
			env as never,
		) as unknown as { fetch(request: Request): Promise<Response> };
		const gather = (sheddable: boolean, opts: typeof OPTS = OPTS) =>
			engine.fetch(
				new Request("https://engine/engine/payload", {
					method: "POST",
					body: JSON.stringify({
						call: "cards2",
						opts,
						baseUrl: "https://x",
						...(sheddable ? { sheddable } : {}),
					}),
				}),
			);
		return { late, stuck, calls, asked, rowsAsked, there, gather };
	}

	let lines: string[] = [];
	const realWarn = console.warn;
	beforeEach(() => {
		resetGatherHealthForTests();
		lines = [];
		console.warn = (...args: unknown[]) => lines.push(args.join(" "));
	});
	afterEach(() => {
		console.warn = realWarn;
		gatherStore = null;
		resetGatherHealthForTests();
	});

	test("two stalled gathers in a row: the next sheddable gather is refused at once, asking no sibling", async () => {
		const { late, asked, gather } = coordinator();
		late[2] = 3_100;
		expect((await gather(true)).status).toBe(200);
		expect(lines.filter((l) => l.includes("shedding gathers"))).toEqual([]);
		expect((await gather(true)).status).toBe(200);
		expect(lines.filter((l) => l.includes("shedding gathers"))).toEqual([
			"[engine-oc-p0] shedding gathers for 30000ms: 2 gathers in a row had sibling calls delivered late " +
				"(period 1); callers fail over to their neighbour region",
		]);
		asked.length = 0;
		const refused = await gather(true);
		expect(refused.status).toBe(503);
		expect(refused.headers.get("x-engine-error")).toBe("EngineShedError");
		expect(await refused.text()).toContain("engine-oc-p0 is not coordinating gathers for another 30000ms");
		expect(asked).toEqual([]);
	});

	test("each stalled gather logs one line naming the late call", async () => {
		const { late, gather } = coordinator();
		late[2] = 3_100;
		await gather(true);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.replace(/isolate=\d+s$/, "isolate=Ns")).toBe(
			"[engine-oc-p0] slow gather: 3100ms, 3 sibling calls, median 0ms; searchKeys worst p2 3100ms, median 0ms; " +
				"fetchRows none; late: p2 searchKeys 3100ms; stalled=yes streak=1 shedding=no inflight=0 isolate=Ns",
		);
	});

	test("the line ends with the engine objects its isolate holds (x56)", async () => {
		// DeckGen 2026-10-02 12:57 UTC: engine-wnam-p8 began stalling the minute its store loaded into
		// engine-wnam-p10's isolate. Two labels on a stalled line are that finding without a join.
		const { late, gather } = coordinator();
		late[2] = 3_100;
		residentLabels = ["engine-oc-p0", "engine-oc-p3"];
		try {
			await gather(true);
		} finally {
			residentLabels = [];
		}
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/stalled=yes streak=1 shedding=no inflight=0 isolate=\d+s holds=engine-oc-p0\+engine-oc-p3$/,
		);
	});

	test("a healthy gather logs nothing and is never refused", async () => {
		const { gather } = coordinator();
		for (let i = 0; i < 4; i++) expect((await gather(true)).status).toBe(200);
		expect(lines).toEqual([]);
	});

	test("the answer is the same bytes whether or not the gather may be shed", async () => {
		const { gather } = coordinator();
		const plain = new Uint8Array(await (await gather(false)).arrayBuffer());
		const sheddable = new Uint8Array(await (await gather(true)).arrayBuffer());
		expect(sheddable).toEqual(plain);
		expect(plain.byteLength).toBeGreaterThan(0);
	});

	test("a gather with no leave to refuse (a neighbour's hedge, a caller's last attempt) is always answered", async () => {
		const { late, gather } = coordinator();
		late[1] = 3_100;
		await gather(true);
		await gather(true);
		expect((await gather(true)).status).toBe(503);
		expect((await gather(false)).status).toBe(200);
	});

	test("a clean gather during the period ends it", async () => {
		const { late, gather } = coordinator();
		late[1] = 3_100;
		await gather(true);
		await gather(true);
		expect((await gather(true)).status).toBe(503);
		late[1] = 0;
		expect((await gather(false)).status).toBe(200); // not sheddable, so it ran — and ran clean
		expect((await gather(true)).status).toBe(200);
	});

	test("when the period runs out one gather is let through; still stalling, the next period is twice as long", async () => {
		const { late, gather } = coordinator();
		late[3] = 1_050;
		await gather(true);
		await gather(true);
		clock += 29_000;
		expect((await gather(true)).status).toBe(503);
		clock += 1_000;
		expect((await gather(true)).status).toBe(200); // the probe
		expect(lines.filter((l) => l.includes("shedding gathers")).at(-1)).toBe(
			"[engine-oc-p0] shedding gathers for 60000ms: 3 gathers in a row had sibling calls delivered late " +
				"(period 2, 1 refused in the last one); callers fail over to their neighbour region",
		);
		clock += 59_000;
		expect((await gather(true)).status).toBe(503);
	});

	test("a query that is slow in every partition is not a stall", async () => {
		const { late, gather } = coordinator();
		late[1] = late[2] = late[3] = 1_200;
		for (let i = 0; i < 3; i++) expect((await gather(true)).status).toBe(200);
		expect(lines.filter((l) => l.includes("shedding gathers"))).toEqual([]);
		// Slow enough to be worth a line, and the line says it did not stall.
		expect(lines.every((l) => l.includes("slow gather") && l.includes("stalled=no"))).toBe(true);
		expect(lines).toHaveLength(3);
	});

	describe("a late sibling call is asked a second time on a fresh stub (x53)", () => {
		// DeckGen 2026-10-02: 43 stalled gathers in 100 minutes, one to four siblings 3.11–3.40s late
		// and the rest at a median 8–121ms — and 14 of engine-wnam-p1's 15 on an isolate too young to
		// have shed anything. The floor is 500ms in production; 5ms of real time here.
		let restoreHedge = () => {};
		beforeEach(() => {
			// x53 as it shipped: no neighbour (x55 has its own suite below), no waking floor.
			restoreHedge = setSiblingHedgeForTests({ floorMs: 5, wakingFloorMs: 5, crossRegion: false });
		});
		afterEach(() => restoreHedge());

		test("the hedge's answer is the page, byte for byte, and the gather does not wait for the late call", async () => {
			const { stuck, asked, gather } = coordinator();
			const healthy = new Uint8Array(await (await gather(true)).arrayBuffer());
			expect(lines).toEqual([]);
			asked.length = 0;
			stuck[2] = { ms: 60 };
			const before = clock;
			const rescued = await gather(true);
			expect(rescued.status).toBe(200);
			expect(new Uint8Array(await rescued.arrayBuffer())).toEqual(healthy);
			// The late call is asked twice and nobody else is; the gather ended when the hedge
			// answered, with the first call still on its way.
			expect([...asked].sort()).toEqual([1, 2, 2, 3]);
			expect(clock - before).toBe(600);
			expect(lines).toEqual([
				"[engine-oc-p0] sibling hedge p2 searchKeys: fired at 600ms; won by hedge at 600ms (2 of 3 answered, median 0ms)",
				expect.stringMatching(
					/^\[engine-oc-p0\] slow gather: 600ms, 3 sibling calls, median 0ms; searchKeys worst p2 600ms, median 0ms; fetchRows none; late: none; hedged: p2 searchKeys at 600ms won by hedge 600ms \(original pending\); stalled=rescued streak=0 shedding=no inflight=0 isolate=\d+s$/,
				),
			]);
			await new Promise((resolve) => setTimeout(resolve, 70)); // let the first call land
		});

		test("gathers rescued by their hedge never shed", async () => {
			const { stuck, gather } = coordinator();
			stuck[2] = { ms: 30 };
			for (let i = 0; i < 4; i++) {
				expect((await gather(true)).status).toBe(200);
				await new Promise((resolve) => setTimeout(resolve, 35));
			}
			expect(lines.filter((l) => l.includes("shedding gathers"))).toEqual([]);
			expect(lines.filter((l) => l.includes("sibling hedge")).every((l) => l.includes("won by hedge"))).toBe(true);
			expect(lines.filter((l) => l.includes("stalled=rescued"))).toHaveLength(4);
		});

		test("a hedge that loses is a stall like any other: two in a row and the object sheds", async () => {
			const { stuck, gather } = coordinator();
			stuck[2] = { ms: 30, hedgeMs: 80 };
			expect((await gather(true)).status).toBe(200);
			expect((await gather(true)).status).toBe(200);
			expect(lines.filter((l) => l.includes("sibling hedge"))).toEqual([
				"[engine-oc-p0] sibling hedge p2 searchKeys: fired at 600ms; won by original at 3100ms (2 of 3 answered, median 0ms)",
				"[engine-oc-p0] sibling hedge p2 searchKeys: fired at 600ms; won by original at 3100ms (2 of 3 answered, median 0ms)",
			]);
			expect(lines.filter((l) => l.includes("slow gather"))[0]).toContain(
				"late: p2 searchKeys 3100ms; hedged: p2 searchKeys at 600ms won by original 3100ms; stalled=yes streak=1",
			);
			expect(lines.filter((l) => l.includes("shedding gathers"))).toHaveLength(1);
			expect((await gather(true)).status).toBe(503);
			await new Promise((resolve) => setTimeout(resolve, 90));
		});

		test("a rescued gather does not end a shedding period the way a clean one does", async () => {
			const { late, stuck, gather } = coordinator();
			late[1] = 3_100;
			await gather(true);
			await gather(true);
			expect((await gather(true)).status).toBe(503);
			late[1] = 0;
			stuck[1] = { ms: 30 };
			expect((await gather(false)).status).toBe(200); // not sheddable, so it ran — rescued, not clean
			expect(lines.at(-1)).toContain("stalled=rescued streak=2");
			expect((await gather(true)).status).toBe(503);
			await new Promise((resolve) => setTimeout(resolve, 35));
		});
	});

	describe("a late sibling call is also asked of the neighbour region's copy of the partition (x55)", () => {
		// DeckGen 2026-10-02 09:48–19:48: 53 second calls to the same object lost with the original
		// at ≥3s — the same stuck path — and 170 were spent on a sibling that was only waking.
		let restoreHedge = () => {};
		beforeEach(() => {
			resetSiblingMemoryForTests();
			restoreHedge = setSiblingHedgeForTests({ floorMs: 5, wakingFloorMs: 5, crossAfterMs: 10 });
		});
		afterEach(() => restoreHedge());

		const bytes = async (response: Response) => {
			expect(response.status).toBe(200);
			return new Uint8Array(await response.arrayBuffer());
		};
		const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		test("the second call sticks too: the neighbour answers, and the page is the same bytes", async () => {
			const { stuck, asked, there, gather } = coordinator();
			const healthy = await bytes(await gather(true));
			expect(there.gets).toEqual([]);
			asked.length = 0;
			// The first call is out 60ms and the second 200ms: the path is stuck for both.
			stuck[2] = { ms: 60, hedgeMs: 200 };
			const before = clock;
			expect(await bytes(await gather(true))).toEqual(healthy);
			expect(clock - before).toBe(600);
			// This region's sibling was asked twice, the neighbour once — for that partition alone,
			// by the name and with the hint the Worker's own hedge uses.
			expect([...asked].sort()).toEqual([1, 2, 2, 3]);
			expect(there.asked).toEqual(["keys:2"]);
			expect(there.gets).toEqual([{ name: "engine-apac-se-p2", options: { locationHint: "apac-se" } }]);
			expect(lines[0]).toBe(
				"[engine-oc-p0] sibling hedge p2 searchKeys: fired at 600ms, to apac-se at 600ms; won by hedge to apac-se at 600ms (2 of 3 answered, median 0ms)",
			);
			expect(lines[1]).toContain(
				"late: none; hedged: p2 searchKeys at 600ms, to apac-se at 600ms won by hedge to apac-se 600ms (original pending); stalled=rescued",
			);
			await settle(210);
		});

		test("whichever call wins, the page is the same bytes", async () => {
			const { stuck, there, gather } = coordinator();
			const healthy = await bytes(await gather(true));
			// The original, the second call, the neighbour: each in turn is the one that answers.
			stuck[2] = { ms: 60, hedgeMs: 200 };
			const byNeighbour = await bytes(await gather(true));
			await settle(210);
			stuck[2] = { ms: 60 };
			const bySecondCall = await bytes(await gather(true));
			await settle(70);
			restoreHedge();
			restoreHedge = setSiblingHedgeForTests({ enabled: false, crossRegion: false });
			const byOriginal = await bytes(await gather(true));
			expect(byNeighbour).toEqual(healthy);
			expect(bySecondCall).toEqual(healthy);
			expect(byOriginal).toEqual(healthy);
			const won = lines.filter((l) => l.includes("sibling hedge")).map((l) => /won by [a-z -]+ at/.exec(l)?.[0]);
			expect(won).toEqual(["won by hedge to apac-se at", "won by hedge at"]);
			expect(there.asked).toEqual(["keys:2"]);
		});

		test("a neighbour on another build is not believed: its answer is discarded and the original waited for", async () => {
			const { stuck, there, gather } = coordinator();
			const healthy = await bytes(await gather(true));
			there.build = "8"; // mid-publish: the neighbour has swapped, this region has not
			stuck[2] = { ms: 30, hedgeMs: 80 };
			expect(await bytes(await gather(true))).toEqual(healthy);
			expect(there.asked).toEqual(["keys:2"]);
			expect(lines[0]).toBe(
				"[engine-oc-p0] sibling hedge p2 searchKeys: fired at 600ms, to apac-se at 600ms; won by original at 3100ms, " +
					"apac-se's answer discarded: build 8 where 7 is pinned (2 of 3 answered, median 0ms)",
			);
			expect(lines[1]).toContain("stalled=yes");
			await settle(90);
		});

		test("a sibling never heard from may be waking: it is given the waking floor, then the neighbour alone", async () => {
			restoreHedge();
			restoreHedge = setSiblingHedgeForTests({ floorMs: 5, wakingFloorMs: 25, crossAfterMs: 10 });
			const { stuck, calls, asked, there, gather } = coordinator();
			// This isolate's first gather: no sibling has answered it yet.
			stuck[2] = { ms: 60, hedgeMs: 200 };
			const first = await bytes(await gather(true));
			expect([...asked].sort()).toEqual([1, 2, 3]);
			expect(there.asked).toEqual(["keys:2"]);
			expect(lines[0]).toBe(
				"[engine-oc-p0] sibling hedge p2 searchKeys: fired at 600ms to apac-se; won by hedge to apac-se at 600ms (2 of 3 answered, median 0ms)",
			);
			await settle(70);
			// The original has landed 3.1s late: this isolate has now SEEN the stall, so its next late
			// call is hedged at the ordinary floor, to the same object first.
			asked.length = 0;
			calls[2] = 0; // the fixture's next call to p2 is a first call again
			stuck[2] = { ms: 60 };
			expect(await bytes(await gather(true))).toEqual(first);
			expect([...asked].sort()).toEqual([1, 2, 2, 3]);
			expect(there.asked).toEqual(["keys:2"]);
			expect(lines.filter((l) => l.includes("sibling hedge"))[1]).toContain("fired at 600ms; won by hedge at 600ms");
			await settle(70);
		});

		test("rows for keys the neighbour supplied are asked of the neighbour, and the page is the same bytes", async () => {
			const { stuck, rowsAsked, there, gather } = coordinator();
			// Past the first row, no rows ride with the keys: every partition on the page owes a fetchRows.
			const paged = { ...OPTS, offset: 1 };
			const healthy = await bytes(await gather(true, paged));
			expect([...rowsAsked].sort()).toEqual([1, 2, 3]);
			rowsAsked.length = 0;
			stuck[2] = { ms: 60, hedgeMs: 200 };
			expect(await bytes(await gather(true, paged))).toEqual(healthy);
			expect(there.asked).toEqual(["keys:2", "rows:2"]);
			expect([...rowsAsked].sort()).toEqual([1, 3]);
			await settle(210);
		});

		test("a region with no neighbour keeps the second call to the same object", async () => {
			// oc's neighbours are apac-se and apac; with both aliased away there is nowhere to ask.
			const { stuck, asked, there, gather } = coordinator();
			(gatherStore as { manifest: Record<string, unknown> }).manifest = {
				...WIDE,
				placement: { v: 1, alias: { "apac-se": { to: "enam", since: "1" }, apac: { to: "enam", since: "1" } } },
			};
			const healthy = await bytes(await gather(true));
			asked.length = 0;
			stuck[2] = { ms: 60 };
			expect(await bytes(await gather(true))).toEqual(healthy);
			expect([...asked].sort()).toEqual([1, 2, 2, 3]);
			expect(there.gets).toEqual([]);
			expect(lines[0]).toBe(
				"[engine-oc-p0] sibling hedge p2 searchKeys: fired at 600ms; won by hedge at 600ms (2 of 3 answered, median 0ms)",
			);
			await settle(70);
		});
	});
});

describe("the routed partition answers its bundle and, unranked, the plan in one call (x48)", () => {
	type RoutedDo = {
		scryfallNamedFuzzyRouted(
			folded: string,
			words: string[],
			limit: number,
			baseUrl: string,
			reportedShards?: number,
		): Promise<{ bundle: { exact: { rank: unknown } }; plan: { partitions: number[]; stage: string } | null }>;
	};
	const routedDo = () => makeDo() as unknown as RoutedDo;

	afterEach(() => {
		fuzzyPlanAnswer = null;
		bundleRank = null;
		bundlesAsked.length = 0;
	});

	test("a bundle that ranks nothing comes back with the plan — a miss is this one call", async () => {
		fuzzyPlanAnswer = { partitions: [], everywhere: false, stage: "miss", builtAt: "1" };
		const reply = await routedDo().scryfallNamedFuzzyRouted(
			"tap opponent mills",
			["tap", "opponent", "mills"],
			2,
			"https://x",
			1,
		);
		expect(reply.bundle.exact.rank).toBeNull();
		expect(reply.plan).toEqual(fuzzyPlanAnswer as never);
		// The bundle's own arguments; never a set (a set= needle is never planned).
		expect(bundlesAsked).toEqual([["tap opponent mills", "", ["tap", "opponent", "mills"], 2, "https://x"]]);
	});

	test("a ranked bundle — the hit path — plans nothing", async () => {
		bundleRank = [3, "lightningbolt", 1, "", 0.9];
		// Any plan asked for here would be this one, and the reply must not carry it.
		fuzzyPlanAnswer = { partitions: [4], everywhere: false, stage: "exact", builtAt: "1" };
		const reply = await routedDo().scryfallNamedFuzzyRouted("lightning bolt", ["lightning", "bolt"], 2, "https://x", 1);
		expect(reply.bundle.exact.rank).toEqual(bundleRank);
		expect(reply.plan).toBeNull();
	});

	test("no names index: the bundle alone, and the router asks for a plan as it did", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			fuzzyPlanAnswer = null;
			const reply = await routedDo().scryfallNamedFuzzyRouted("zzqx", ["zzqx"], 2, "https://x", 1);
			expect(reply.bundle.exact.rank).toBeNull();
			expect(reply.plan).toBeNull();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("a collection batch's route says where the names it did not settle live (x47)", () => {
	type BatchDo = {
		scryfallCollectionBatch(
			batch: unknown,
			baseUrl: string,
			scope: null,
			reportedShards?: number,
		): Promise<{
			packet: Uint8Array;
			located?: { builtAt: string; names: number[]; holders: number[][] };
			answeredFrom?: { build: string; commit: string };
		}>;
	};
	const batchDo = () => makeDo() as unknown as BatchDo;
	/** A packet as engine/wasm's `collection_batch` writes it: the header, then one empty slot per name. */
	const packetOf = (header: unknown, slots: number) => {
		const json = new TextEncoder().encode(JSON.stringify(header));
		const out = new Uint8Array(4 + json.length + 4 * slots);
		new DataView(out.buffer).setUint32(0, json.length, true);
		out.set(json, 4);
		return out;
	};
	const names = (...folded: string[]) => folded.map((f) => ({ folded: f, setCode: "" }));

	afterEach(() => {
		collectionPacket = new Uint8Array();
		holdersAnswer = null;
		holdersAsked.length = 0;
		gatherStore = null;
	});

	test("x58: the reply says which store build and which commit wrote the packet, and nothing else moved", async () => {
		collectionPacket = packetOf([null], 1);
		const batch = { keys: [], trees: [], names: names("nope") };
		// The object's loaded store is build 1791026526: that, and this code's commit, ride beside
		// the packet — what the route compares with the build and commit it keys a kept answer on.
		gatherStore = {
			ownLoad: Promise.resolve(),
			loaded: true,
			ownLoadMs: 0,
			events: [],
			manifest: { built_at: "1791026526" },
			ops: null,
		};
		const reply = await batchDo().scryfallCollectionBatch(batch, "https://x", null, 1);
		expect(reply.answeredFrom).toEqual({ build: "1791026526", commit: BUILD_COMMIT });
		// An isolate on the code before x58 reads `packet` and `located` and the telemetry riders:
		// the same object, the same keys, one trailing key more.
		expect(reply.packet).toBe(collectionPacket);
		expect(Object.keys(reply).sort()).toEqual(["acquireMs", "answeredFrom", "load", "packet", "rate", "shards"]);

		// An object that cannot name its store names none, which is never the build a route is pinned to.
		gatherStore = null;
		const unnamed = await batchDo().scryfallCollectionBatch(batch, "https://x", null, 1);
		expect(unnamed.answeredFrom).toEqual({ build: "", commit: BUILD_COMMIT });
	});

	test("an unsettled routed name comes back with its holders — none, for a name no card carries", async () => {
		// Three names; this store is the route of the first two. It ranks `lightning bolt` (settled)
		// and not `lightnig bolt`, which the filter never held: the index says nobody holds it.
		collectionPacket = packetOf(
			{ ranks: [[3, "lightningbolt", 1, "", 0.9], null, null], present: [true, false, false] },
			3,
		);
		holdersAnswer = {};
		const batch = {
			keys: [],
			trees: [],
			names: names("lightning bolt", "lightnig bolt", "opt"),
			presence: true,
			locate: [
				{ at: 0, hint: { sole: 4 } },
				{ at: 1, hint: { sole: 4 } },
			],
		};
		const reply = await batchDo().scryfallCollectionBatch(batch, "https://x", null, 1);
		expect(reply.packet).toBe(collectionPacket);
		expect(reply.located).toEqual({ builtAt: "1", names: [1], holders: [[]] });
		// Only the unsettled name was looked up: not the settled one, not the one routed elsewhere.
		expect(holdersAsked).toEqual([["lightnig bolt"]]);
	});

	test("a served answer another partition's extras may outrank is located too", async () => {
		// `chaos`: this store answers a served FACE (tier 2) and the hint says another holds it whole.
		collectionPacket = packetOf([[2, "orderchaos", 1, "", 0.5]], 1);
		holdersAnswer = { chaos: [1, 3] };
		const batch = {
			keys: [],
			trees: [],
			names: names("chaos"),
			locate: [{ at: 0, hint: { served: 3, rival: 3, needle: "chaos" } }],
		};
		const reply = await batchDo().scryfallCollectionBatch(batch, "https://x", null, 1);
		expect(reply.located).toEqual({ builtAt: "1", names: [0], holders: [[1, 3]] });
	});

	test("a batch whose routed names all settle never reads the index — the hit path", async () => {
		collectionPacket = packetOf({ ranks: [[3, "lightningbolt", 1, "", 0.9], null], present: [true, true] }, 2);
		holdersAnswer = {};
		const batch = {
			keys: [],
			trees: [],
			// The second is a sole route's miss that presence settles (the name is here, not in the set).
			names: [...names("lightning bolt"), { folded: "opt", setCode: "lea" }],
			presence: true,
			locate: [
				{ at: 0, hint: { sole: 4 } },
				{ at: 1, hint: { sole: 4 } },
			],
		};
		const reply = await batchDo().scryfallCollectionBatch(batch, "https://x", null, 1);
		expect(reply.located).toBeUndefined();
		expect(holdersAsked).toEqual([]);
	});

	test("no locate, or no names index: the packet alone, as before", async () => {
		collectionPacket = packetOf([null], 1);
		holdersAnswer = {};
		const plain = await batchDo().scryfallCollectionBatch(
			{ keys: [], trees: [], names: names("nope") },
			"https://x",
			null,
			1,
		);
		expect(plain.located).toBeUndefined();
		expect(holdersAsked).toEqual([]);
		holdersAnswer = null;
		const batch = { keys: [], trees: [], names: names("nope"), locate: [{ at: 0, hint: { sole: 4 } }] };
		expect((await batchDo().scryfallCollectionBatch(batch, "https://x", null, 1)).located).toBeUndefined();
	});
});

describe("an abandoned object gives its storage back only when nobody is calling it (x56)", () => {
	// ABANDONED_ENGINES (engine-namespace.ts) stops every stub being built for an object the platform
	// keeps on a bad machine. Its storage is released at a later publish — but an isolate that does
	// not carry the list yet still calls it, and releasing under that caller would have its next
	// call re-create the object and load a store from KV in front of a user.
	const QUIET_MS = 15 * 60 * 1000;
	type AbandonedDo = {
		searchCardsAsObjects(opts: unknown, reported?: number): Promise<unknown>;
		releaseAbandoned(quietMs: number): Promise<{ released: boolean; servedAgoMs: number | null }>;
	};
	function abandonedDo(name: string) {
		let deleted = 0;
		const storage = {
			sql: { databaseSize: 41_000_000, exec: () => ({ toArray: () => [] }) },
			deleteAll: async () => {
				deleted += 1;
			},
		};
		const engine = new SearchEngine(
			{ waitUntil: () => {}, storage, id: { name } } as never,
			{} as never,
		) as unknown as AbandonedDo;
		return { engine, deleted: () => deleted };
	}

	let warned: string[] = [];
	let logged: string[] = [];
	const realWarn = console.warn;
	const realLog = console.log;
	beforeEach(() => {
		warned = [];
		logged = [];
		console.warn = (...args: unknown[]) => warned.push(args.join(" "));
		console.log = (...args: unknown[]) => logged.push(args.join(" "));
	});
	afterEach(() => {
		console.warn = realWarn;
		console.log = realLog;
	});

	test("an object that served a call a moment ago refuses, and deletes nothing", async () => {
		const { engine, deleted } = abandonedDo("engine-wnam-p10");
		await engine.searchCardsAsObjects({ limit: 1 }, 1);
		clock += 4_000;
		expect(await engine.releaseAbandoned(QUIET_MS)).toEqual({ released: false, servedAgoMs: 4_000 });
		expect(deleted()).toBe(0);
		expect(warned).toEqual([
			"[engine-wnam-p10] is abandoned but served a call 4000ms ago: keeping its cached archives until a publish " +
				"finds it unused for 900000ms",
		]);
	});

	test("once it has gone the quiet period without a call it releases everything, with deleteAll", async () => {
		const { engine, deleted } = abandonedDo("engine-wnam-p8");
		await engine.searchCardsAsObjects({ limit: 1 }, 1);
		clock += QUIET_MS;
		expect(await engine.releaseAbandoned(QUIET_MS)).toEqual({ released: true, servedAgoMs: QUIET_MS });
		expect(deleted()).toBe(1);
		expect(logged).toEqual(["[engine-wnam-p8] abandoned: released its cached archives (41000000 bytes of storage)"]);
		// And the record went with the storage: asked again (a retried notify), it releases again.
		expect(await engine.releaseAbandoned(QUIET_MS)).toEqual({ released: true, servedAgoMs: null });
		expect(deleted()).toBe(2);
	});

	test("an object no call has reached in this isolate is released at once", async () => {
		const { engine, deleted } = abandonedDo("engine-wnam-p9");
		expect(await engine.releaseAbandoned(QUIET_MS)).toEqual({ released: true, servedAgoMs: null });
		expect(deleted()).toBe(1);
	});

	test("the release is the object's own storage, not a call to itself", async () => {
		// A wrapper that calls itself passes every other test here (wrapper-replacement): pin the body.
		const src = await Bun.file(new URL("../../src/engine/search-engine-do.ts", import.meta.url)).text();
		const body = src.slice(src.indexOf("async releaseAbandoned("), src.indexOf("async storageFootprint("));
		expect(body).toContain("await this.ctx.storage.deleteAll();");
		expect(body).not.toContain("this.releaseAbandoned(");
		// And every serving call is what marks the object as in use.
		const acquire = src.slice(src.indexOf("private async engine(): Promise<Engine> {"));
		expect(acquire.slice(0, 120)).toContain("lastServedAt.set(this.label, Date.now());");
	});
});
