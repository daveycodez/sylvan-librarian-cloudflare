// The publish -> notify -> purge contract.
//
// The ordering IS the correctness property, and getting it wrong is silent and long-lived: purging
// the edge cache while any reader still holds the old store empties the cache straight into a stale
// answer, and `/cards/*` caches for 16 hours. That used to be defended with a ten-minute delay and a
// second purge pass, both sized against a 5-minute poll nobody could observe. Notify replaced the
// guesswork with an acknowledgement, so these tests pin the acknowledgement actually GATING the
// purge rather than merely preceding it.
//
// The second property here is subtler and was a live risk: the fan-out must never CREATE an engine
// object. `locationHint` fixes an object's region at creation, so an object created by the
// publisher is placed relative to a hint the publisher chose rather than by a real request at the
// edge — permanently, if the hint is ever not honoured. Objects announce themselves instead, and
// the fan-out visits exactly that set.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEngineName, replicaGroupOf } from "../../src/engine/engine-namespace";
import { manifestServableBy } from "../../src/engine/store-kv";
import type { StoreManifest } from "../../src/engine/types";

interface FakeObject {
	prepared: number;
	committed: number;
	released: number;
	shards: number;
}

/**
 * A SEARCH_ENGINE namespace that records calls AND whether a name was ever addressed.
 *
 * `addressed` is the point of most of this file: anything in it that was not already live is an
 * object the fan-out brought into existence.
 *
 * `failOn` fails an object's PREPARE (and its release); `failCommitOn` lets a
 * prepare succeed and the commit fail, which is the window the two-step
 * protocol exists to keep narrow.
 */
function fakeNamespace(live: Record<string, number>, failOn = new Set<string>(), failCommitOn = new Set<string>()) {
	const calls = new Map<string, FakeObject>();
	const addressed = new Set<string>();
	/** Announcement keys, which must be retired alongside the storage they name. */
	const announced = new Set<string>(Object.keys(live));
	return {
		calls,
		addressed,
		announced,
		get: (id: { name: string }) => {
			addressed.add(id.name);
			const o = calls.get(id.name) ?? { prepared: 0, committed: 0, released: 0, shards: live[id.name] ?? 1 };
			calls.set(id.name, o);
			return {
				preparePublish: async () => {
					if (failOn.has(id.name)) throw new Error(`${id.name} unreachable`);
					o.prepared += 1;
					return { prepared: true, shards: o.shards };
				},
				commitPublish: async () => {
					if (failOn.has(id.name) || failCommitOn.has(id.name)) throw new Error(`${id.name} unreachable`);
					o.committed += 1;
					return { swapped: id.name in live, shards: o.shards };
				},
				releaseCache: async () => {
					if (failOn.has(id.name)) throw new Error(`${id.name} unreachable`);
					o.released += 1;
					return { released: true };
				},
			};
		},
	};
}

/**
 * The fan-out, mirroring stepNotify: prepare EVERYWHERE, require every ack,
 * only then commit everywhere.
 *
 * The coordinator is a Durable Object wrapped in a long alarm chain, so driving the real phase would
 * mean standing up SQLite, the run record and the phase machine to test twenty lines of fan-out.
 */
async function fanOut(ns: ReturnType<typeof fakeNamespace>, liveNames: string[]) {
	const stub = (name: string) => ns.get({ name });
	const prepared = await Promise.allSettled(
		liveNames.map(async (name) => ({ name, ...(await stub(name).preparePublish()) })),
	);
	const prepareFailed = prepared.filter((r) => r.status === "rejected");
	if (prepareFailed.length > 0) {
		throw new Error(`notify: ${prepareFailed.length}/${liveNames.length} object(s) failed to prepare`);
	}
	const results = await Promise.allSettled(
		liveNames.map(async (name) => ({ name, ...(await stub(name).commitPublish()) })),
	);
	const failed = results.filter((r) => r.status === "rejected");
	if (failed.length > 0) throw new Error(`notify: ${failed.length}/${liveNames.length} object(s) failed to commit`);
	const acked = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

	const widthOf = new Map<string, number>();
	for (const a of acked) {
		const parsed = parseEngineName(a.name);
		const group = replicaGroupOf(a.name);
		if (parsed?.shard === 0 && group !== null) widthOf.set(group, Math.max(1, Math.floor(a.shards)));
	}
	const stale = acked.filter((a) => {
		const parsed = parseEngineName(a.name);
		if (!parsed || parsed.shard === 0) return false;
		const regionGroup = replicaGroupOf(`engine-${parsed.region}`);
		return parsed.shard >= ((regionGroup !== null ? widthOf.get(regionGroup) : undefined) ?? 1);
	});
	await Promise.allSettled(
		stale.map(async (a) => {
			await stub(a.name).releaseCache();
			ns.announced.delete(a.name);
		}),
	);
	return { acked, stale: stale.map((s) => s.name) };
}

describe("the fan-out never creates an object", () => {
	test("visits only names that announced themselves", async () => {
		// The whole safety property. Walking every possible region name would create
		// engine-apac, engine-afr and the rest from inside the coordinator, fixing
		// their region by a hint the coordinator chose rather than by a real request.
		const ns = fakeNamespace({ "engine-wnam": 1 });
		await fanOut(ns, ["engine-wnam"]);
		expect([...ns.addressed]).toEqual(["engine-wnam"]);
	});

	test("a region with no traffic is never addressed at all", async () => {
		const ns = fakeNamespace({ "engine-wnam": 1 });
		await fanOut(ns, ["engine-wnam"]);
		for (const cold of ["engine-apac", "engine-afr", "engine-oc", "engine-sam", "engine-me"]) {
			expect(ns.addressed.has(cold)).toBe(false);
		}
	});

	test("an empty live set is a no-op, not an error", async () => {
		// A fresh deployment nothing has loaded yet. The first real request reads the
		// manifest from KV, which is exactly the fallback.
		const ns = fakeNamespace({});
		const { acked } = await fanOut(ns, []);
		expect(acked).toEqual([]);
		expect(ns.addressed.size).toBe(0);
	});
});

describe("what the fan-out does to the objects that exist", () => {
	test("prepares AND commits every live object, shard 0 and expanded shards alike", async () => {
		const live = { "engine-wnam": 3, "engine-wnam-1": 1, "engine-wnam-2": 1, "engine-weur": 1 };
		const ns = fakeNamespace(live);
		await fanOut(ns, Object.keys(live));
		for (const name of Object.keys(live)) {
			expect(ns.calls.get(name)?.prepared).toBe(1);
			expect(ns.calls.get(name)?.committed).toBe(1);
		}
	});

	test("releases storage from shards at or above their region's fan-out", async () => {
		// engine-wnam reports width 3, so shards 1-2 are live and 3 is abandoned —
		// and an abandoned shard keeps ~88MB forever, since its own prune never runs
		// again because it never loads again.
		const live = { "engine-wnam": 3, "engine-wnam-1": 1, "engine-wnam-2": 1, "engine-wnam-3": 1 };
		const ns = fakeNamespace(live);
		const { stale } = await fanOut(ns, Object.keys(live));
		expect(stale).toEqual(["engine-wnam-3"]);
		expect(ns.calls.get("engine-wnam-3")?.released).toBe(1);
		expect(ns.calls.get("engine-wnam-2")?.released).toBe(0);
	});

	test("shard 0 is never released, whatever the width says", async () => {
		const live = { "engine-wnam": 1 };
		const ns = fakeNamespace(live);
		const { stale } = await fanOut(ns, ["engine-wnam"]);
		expect(stale).toEqual([]);
		expect(ns.calls.get("engine-wnam")?.released).toBe(0);
	});

	test("a partitioned shard 0 reports its region's width", async () => {
		// The region's rendezvous object is engine-wnam-p0..pN — any of them
		// parses to shard 0 and must register the width for the whole replica
		// group, or scale-in never fires again.
		const live = { "engine-wnam-p0": 2, "engine-wnam-p1": 2, "engine-wnam-2-p0": 1, "engine-wnam-2-p1": 1 };
		const ns = fakeNamespace(live);
		const { stale } = await fanOut(ns, Object.keys(live));
		// width 2 → replica shard 2 is stale, and BOTH its partitions go together.
		expect(stale.sort()).toEqual(["engine-wnam-2-p0", "engine-wnam-2-p1"]);
	});

	test("all partitions of a stale replica are released together", async () => {
		const live = {
			"engine-wnam-p0": 3,
			"engine-wnam-1-p0": 1,
			"engine-wnam-1-p1": 1,
			"engine-wnam-3-p0": 1,
			"engine-wnam-3-p1": 1,
		};
		const ns = fakeNamespace(live);
		const { stale } = await fanOut(ns, Object.keys(live));
		// width 3: replica 1's partitions are live and stay; replica 3's are
		// beyond the fan-out and every partition of it goes — a half-released
		// replica would keep half a store's cache forever.
		expect(stale.sort()).toEqual(["engine-wnam-3-p0", "engine-wnam-3-p1"]);
	});

	test("partitions of live replicas are never released", async () => {
		const live = { "engine-wnam-p0": 2, "engine-wnam-p1": 2, "engine-wnam-1-p0": 1, "engine-wnam-1-p1": 1 };
		const ns = fakeNamespace(live);
		const { stale } = await fanOut(ns, Object.keys(live));
		expect(stale).toEqual([]);
	});

	test("each region's width governs only its own shards", async () => {
		const live = { "engine-wnam": 2, "engine-wnam-1": 1, "engine-weur": 1, "engine-weur-1": 1 };
		const ns = fakeNamespace(live);
		const { stale } = await fanOut(ns, Object.keys(live));
		// wnam runs 2, so shard 1 stays. weur runs 1, so its shard 1 goes.
		expect(stale).toEqual(["engine-weur-1"]);
	});
});

describe("failure gates the purge", () => {
	test("an unreachable object fails the phase rather than advancing", async () => {
		// Advancing would purge the cache while that object still served the old
		// store, and the answer it wrote back would stand for up to 16 hours.
		const ns = fakeNamespace({ "engine-wnam": 1, "engine-weur": 1 }, new Set(["engine-weur"]));
		expect(fanOut(ns, ["engine-wnam", "engine-weur"])).rejects.toThrow("object(s) failed");
	});

	test("the reachable ones are still prepared before it gives up", async () => {
		// allSettled, not all: one unreachable object must not cancel work the rest
		// already did, or a retry would start from nothing every time.
		const ns = fakeNamespace({ "engine-wnam": 1, "engine-weur": 1 }, new Set(["engine-weur"]));
		await fanOut(ns, ["engine-wnam", "engine-weur"]).catch(() => {});
		expect(ns.calls.get("engine-wnam")?.prepared).toBe(1);
	});

	test("NO object commits until every object has prepared — the barrier itself", async () => {
		// This ordering is the whole point of the two-step protocol: a one-step
		// notify gave each region its own multi-second prefetch window, and the
		// windows did not line up. If one prepare fails, zero commits happen
		// anywhere, so no region swaps ahead of a region that is not ready.
		const ns = fakeNamespace({ "engine-wnam": 1, "engine-weur": 1 }, new Set(["engine-weur"]));
		await fanOut(ns, ["engine-wnam", "engine-weur"]).catch(() => {});
		expect(ns.calls.get("engine-wnam")?.committed).toBe(0);
	});

	test("a commit failure retries the whole phase, and the re-run is safe", async () => {
		// Prepare succeeded everywhere, one commit failed: the phase throws (some
		// regions may have swapped — the mixed window exists until the retry) and
		// the re-run repeats BOTH steps, which idempotence makes free.
		const live = { "engine-wnam": 1, "engine-weur": 1 };
		const ns = fakeNamespace(live, new Set(), new Set(["engine-weur"]));
		expect(fanOut(ns, Object.keys(live))).rejects.toThrow(/failed to commit/);
		await fanOut(ns, Object.keys(live)).catch(() => {});
		expect(ns.calls.get("engine-wnam")?.prepared).toBe(2);
	});

	test("a released shard is un-announced, so the next publish does not recreate it", async () => {
		// The trap this closes: releaseCache wipes the object's storage, but the
		// announcement lives in KV and would survive. The next publish would find the
		// name in the live set, address it — CREATING it — and it would record a
		// manifest row, gain storage, and stop being reclaimable. That is the
		// "publisher creates objects" property this fan-out exists to prevent,
		// re-entering through the announcement rather than through a name list.
		const live = { "engine-wnam": 1, "engine-wnam-1": 1 };
		const ns = fakeNamespace(live);
		await fanOut(ns, Object.keys(live));
		expect([...ns.announced]).toEqual(["engine-wnam"]);

		// Second publish walks the announcements that remain, and never touches it.
		const ns2 = fakeNamespace({ "engine-wnam": 1 });
		await fanOut(ns2, [...ns.announced]);
		expect(ns2.addressed.has("engine-wnam-1")).toBe(false);
	});

	test("retrying is safe, because every call is idempotent", async () => {
		const live = { "engine-wnam": 1, "engine-wnam-1": 1 };
		const ns = fakeNamespace(live);
		await fanOut(ns, Object.keys(live));
		await fanOut(ns, Object.keys(live));
		expect(ns.calls.get("engine-wnam")?.prepared).toBe(2);
		expect(ns.calls.get("engine-wnam")?.committed).toBe(2);
		expect(ns.calls.get("engine-wnam-1")?.released).toBe(2);
	});
});

// The guard on PUSHED manifests. The fan-out hands a manifest straight to every
// announced object, so this is the only shape check in front of them —
// readManifest, which refuses an unpartitioned manifest on the read side, is not
// on this path. An object that recorded a shape it cannot serve would wedge its
// next cold load on the loader's refusal with KV never consulted, so it refuses
// to cache while still acking: the publish must not wedge on what is a bug
// somewhere else.
describe("a pushed manifest the object cannot serve is refused, not cached", () => {
	const unpartitioned = { store_key: "card-store-v1-1.store", store_bytes: 10 } as StoreManifest;
	const partitioned = {
		store_key: "card-store-v2-2.store",
		store_bytes: 10,
		partition_count: 2,
	} as StoreManifest;

	/** The rule as the DO applies it: its own name's partition against the shape. */
	const servable = (label: string, manifest: StoreManifest) =>
		manifestServableBy(parseEngineName(label)?.partition, manifest);

	test("a partition-named object serves a partitioned manifest", () => {
		expect(servable("engine-wnam-p0", partitioned)).toBe(true);
		expect(servable("engine-wnam-2-p1", partitioned)).toBe(true);
	});

	test("an unpartitioned manifest is refused by every object", () => {
		// It cannot be loaded by anything here, so caching it anywhere is a wedge.
		expect(servable("engine-wnam-p0", unpartitioned)).toBe(false);
		expect(servable("engine-wnam-2-p1", unpartitioned)).toBe(false);
		expect(servable("engine-wnam", unpartitioned)).toBe(false);
	});

	test("a label carrying no partition refuses everything — that is a naming bug", () => {
		// Every engine object is engine-<region>[-<n>]-p<k>. A suffix-less label is
		// a replica-GROUP name, which no store is ever loaded into.
		expect(servable("engine-wnam", partitioned)).toBe(false);
		expect(servable("engine-wnam-2", partitioned)).toBe(false);
	});

	test("the DO guards BOTH push RPCs with the rule, before anything is recorded", () => {
		// search-engine-do.ts cannot be imported outside workerd (it drags
		// cloudflare:workers), so the wiring is pinned at the source level: both
		// notifyPublish and preparePublish check manifestServableBy, and every
		// recordLiveManifest call sits behind one of those guards.
		const src = readFileSync(join(import.meta.dir, "../../src/engine/search-engine-do.ts"), "utf8");
		const guards = src.match(/!manifestServableBy\(parseEngineName\(this\.label\)\?\.partition, manifest\)/g);
		expect(guards?.length ?? 0).toBe(2);
		// Each guard returns an ACK (never a throw): the publish must not wedge.
		expect(src.match(/REFUSING a pushed manifest/g)?.length ?? 0).toBe(2);
		// And the refusal comes BEFORE the record, in both RPCs.
		for (const rpc of ["notifyPublish", "preparePublish"]) {
			const body = src.slice(src.indexOf(`async ${rpc}(`));
			expect(body.indexOf("manifestServableBy")).toBeGreaterThan(-1);
			expect(body.indexOf("manifestServableBy")).toBeLessThan(body.indexOf("recordLiveManifest"));
		}
	});
});
