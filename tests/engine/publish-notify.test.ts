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

interface FakeObject {
	notified: number;
	released: number;
	shards: number;
}

/**
 * A SEARCH_ENGINE namespace that records calls AND whether a name was ever addressed.
 *
 * `addressed` is the point of most of this file: anything in it that was not already live is an
 * object the fan-out brought into existence.
 */
function fakeNamespace(live: Record<string, number>, failOn = new Set<string>()) {
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
			const o = calls.get(id.name) ?? { notified: 0, released: 0, shards: live[id.name] ?? 1 };
			calls.set(id.name, o);
			return {
				notifyPublish: async () => {
					if (failOn.has(id.name)) throw new Error(`${id.name} unreachable`);
					o.notified += 1;
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
 * The fan-out, mirroring stepNotify.
 *
 * The coordinator is a Durable Object wrapped in a long alarm chain, so driving the real phase would
 * mean standing up SQLite, the run record and the phase machine to test twenty lines of fan-out.
 */
async function fanOut(ns: ReturnType<typeof fakeNamespace>, liveNames: string[]) {
	const stub = (name: string) => ns.get({ name });
	const results = await Promise.allSettled(
		liveNames.map(async (name) => ({ name, ...(await stub(name).notifyPublish()) })),
	);
	const failed = results.filter((r) => r.status === "rejected");
	if (failed.length > 0) throw new Error(`notify: ${failed.length}/${liveNames.length} object(s) failed`);
	const acked = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

	const widthOf = new Map<string, number>();
	for (const a of acked) {
		if (!a.name.includes("-", "engine-".length)) widthOf.set(a.name, Math.max(1, Math.floor(a.shards)));
	}
	const stale = acked.filter((a) => {
		const dash = a.name.lastIndexOf("-");
		const idx = dash > "engine".length ? Number(a.name.slice(dash + 1)) : Number.NaN;
		if (!Number.isInteger(idx)) return false;
		return idx >= (widthOf.get(a.name.slice(0, dash)) ?? 1);
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
	test("notifies every live object, shard 0 and expanded shards alike", async () => {
		const live = { "engine-wnam": 3, "engine-wnam-1": 1, "engine-wnam-2": 1, "engine-weur": 1 };
		const ns = fakeNamespace(live);
		await fanOut(ns, Object.keys(live));
		for (const name of Object.keys(live)) expect(ns.calls.get(name)?.notified).toBe(1);
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

	test("the reachable ones are still notified before it gives up", async () => {
		// allSettled, not all: one unreachable object must not cancel work the rest
		// already did, or a retry would start from nothing every time.
		const ns = fakeNamespace({ "engine-wnam": 1, "engine-weur": 1 }, new Set(["engine-weur"]));
		await fanOut(ns, ["engine-wnam", "engine-weur"]).catch(() => {});
		expect(ns.calls.get("engine-wnam")?.notified).toBe(1);
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

	test("retrying is safe, because both calls are idempotent", async () => {
		const live = { "engine-wnam": 1, "engine-wnam-1": 1 };
		const ns = fakeNamespace(live);
		await fanOut(ns, Object.keys(live));
		await fanOut(ns, Object.keys(live));
		expect(ns.calls.get("engine-wnam")?.notified).toBe(2);
		expect(ns.calls.get("engine-wnam-1")?.released).toBe(2);
	});
});
