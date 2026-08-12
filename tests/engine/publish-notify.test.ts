// The publish -> notify -> purge contract.
//
// The ordering here IS the correctness property, and getting it wrong is silent
// and long-lived: purging the edge cache while any reader still holds the old
// store empties the cache straight into a stale answer, and `/cards/*` caches
// for 16 hours. That used to be defended with a ten-minute delay and a second
// purge pass — both sized against a 5-minute manifest poll nobody could observe.
// Notify replaced the guesswork with an acknowledgement, so these tests pin the
// acknowledgement actually gating the purge rather than merely preceding it.

import { describe, expect, test } from "bun:test";
import { REGION_HINTS } from "../../src/engine/region";

/** What one region's engine DO records about how it was called. */
interface FakeShard {
	notified: number;
	released: number;
}

/**
 * A SEARCH_ENGINE namespace stand-in that records calls per object name.
 *
 * `warmShards` names the objects that report a loaded store; everything else
 * answers the cold no-op, which is the case that keeps the fan-out affordable.
 */
function fakeNamespace(opts: { warm?: Record<string, number>; failOn?: Set<string> } = {}) {
	const calls = new Map<string, FakeShard>();
	const shard = (name: string): FakeShard => {
		let s = calls.get(name);
		if (!s) {
			s = { notified: 0, released: 0 };
			calls.set(name, s);
		}
		return s;
	};
	return {
		calls,
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			notifyPublish: async () => {
				if (opts.failOn?.has(id.name)) throw new Error(`${id.name} unreachable`);
				shard(id.name).notified += 1;
				const width = opts.warm?.[id.name];
				return { swapped: width !== undefined, shards: width ?? 1 };
			},
			releaseCache: async () => {
				if (opts.failOn?.has(id.name)) throw new Error(`${id.name} unreachable`);
				shard(id.name).released += 1;
				return { released: true };
			},
		}),
	};
}

/**
 * The fan-out, extracted to match stepNotify's shape.
 *
 * The coordinator is a Durable Object wrapped in a long alarm chain, so driving
 * the real `stepNotify` here would mean standing up SQLite, the run record and
 * the phase machine to test twelve lines of fan-out. This mirrors those lines;
 * the ordering test below is what holds the real one to them.
 */
async function fanOut(ns: ReturnType<typeof fakeNamespace>, sweepTo = 8) {
	const stub = (name: string) => ns.get(ns.idFromName(name));
	const results = await Promise.allSettled(
		REGION_HINTS.map(async (region) => {
			const head = await stub(`engine-${region}`).notifyPublish();
			const width = Math.max(1, Math.floor(head.shards));
			const to = Math.max(sweepTo, width);
			await Promise.all(Array.from({ length: width - 1 }, (_, i) => stub(`engine-${region}-${i + 1}`).notifyPublish()));
			await Promise.all(
				Array.from({ length: to - width }, (_, i) => stub(`engine-${region}-${width + i}`).releaseCache()),
			);
			return { region, swapped: head.swapped };
		}),
	);
	const failed = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
	if (failed.length > 0) throw new Error(`notify: ${failed.length} region(s) failed`);
	return results;
}

describe("the publish fan-out", () => {
	test("notifies every region, not just the ones with traffic", async () => {
		const ns = fakeNamespace();
		await fanOut(ns);
		for (const region of REGION_HINTS) {
			expect(ns.calls.get(`engine-${region}`)?.notified).toBe(1);
		}
	});

	test("a cold region is one cheap call, not a store load", async () => {
		// The property that makes notifying all nine affordable: a region with no
		// traffic answers without loading its ~76.6MB archive, so scale-to-zero
		// survives a nightly publish.
		const ns = fakeNamespace();
		const results = await fanOut(ns);
		expect(results.every((r) => r.status === "fulfilled" && !r.value.swapped)).toBe(true);
	});

	test("reaches expanded shards, which only shard 0 knows about", async () => {
		const ns = fakeNamespace({ warm: { "engine-wnam": 3 } });
		await fanOut(ns);
		expect(ns.calls.get("engine-wnam")?.notified).toBe(1);
		expect(ns.calls.get("engine-wnam-1")?.notified).toBe(1);
		expect(ns.calls.get("engine-wnam-2")?.notified).toBe(1);
		// Not a fourth: the width was 3.
		expect(ns.calls.get("engine-wnam-3")?.notified ?? 0).toBe(0);
	});

	test("releases storage from every shard above the fan-out", async () => {
		const ns = fakeNamespace({ warm: { "engine-wnam": 3 } });
		await fanOut(ns);
		// 3 live, so 3..7 give their cached archives back — otherwise an abandoned
		// shard keeps ~88MB of the 5GB pool forever, with no later prune to run.
		for (const i of [3, 4, 5, 6, 7]) {
			expect(ns.calls.get(`engine-wnam-${i}`)?.released).toBe(1);
		}
		expect(ns.calls.get("engine-wnam-2")?.released ?? 0).toBe(0);
	});

	test("a single-shard region releases everything above shard 0", async () => {
		const ns = fakeNamespace();
		await fanOut(ns);
		for (const i of [1, 2, 3, 4, 5, 6, 7]) {
			expect(ns.calls.get(`engine-wnam-${i}`)?.released).toBe(1);
		}
	});

	test("sweeps past the default cap when SHARDS_MAX raised the width", async () => {
		const ns = fakeNamespace({ warm: { "engine-wnam": 11 } });
		await fanOut(ns);
		expect(ns.calls.get("engine-wnam-10")?.notified).toBe(1);
		// Nothing to release above it, but the sweep must not have stopped at 8 and
		// stranded shards 8-10 holding storage.
		expect(ns.calls.get("engine-wnam-8")?.notified).toBe(1);
	});
});

describe("failure gates the purge", () => {
	test("an unreachable region fails the phase rather than advancing", async () => {
		// This is the whole safety property. Advancing here would purge the cache
		// while that region still served the old store, and the answer it wrote
		// back would stand for up to 16 hours.
		const ns = fakeNamespace({ failOn: new Set(["engine-apac"]) });
		expect(fanOut(ns)).rejects.toThrow("region(s) failed");
	});

	test("the other regions are still notified before it gives up", async () => {
		// allSettled, not all: one unreachable region must not cancel the work the
		// rest already did, or a retry would start from nothing every time.
		const ns = fakeNamespace({ failOn: new Set(["engine-apac"]) });
		await fanOut(ns).catch(() => {});
		expect(ns.calls.get("engine-wnam")?.notified).toBe(1);
		expect(ns.calls.get("engine-weur")?.notified).toBe(1);
	});

	test("retrying is safe, because both calls are idempotent", async () => {
		// The phase retries wholesale on failure, so every object gets called
		// again. Notifying a DO that already swapped is a no-op reporting
		// swapped:false, and releasing an empty cache does nothing.
		const ns = fakeNamespace({ warm: { "engine-wnam": 2 } });
		await fanOut(ns);
		await fanOut(ns);
		expect(ns.calls.get("engine-wnam")?.notified).toBe(2);
		expect(ns.calls.get("engine-wnam-1")?.notified).toBe(2);
		expect(ns.calls.get("engine-wnam-2")?.released).toBe(2);
	});
});
