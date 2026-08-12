// The announcement that makes an object visible to the publisher.
//
// This is the smallest piece of the convergence design and the one whose failure is hardest to see.
// `stepNotify` fans out to exactly the objects in `engine:live:`; an object missing from that set is
// never notified, and `refreshNow` has a single caller — `notifyPublish`. With the manifest poll
// deleted there is no other path by which a warm object learns a publish happened, so a dropped
// announcement means that object keeps serving the old store while `stepPurge` empties the edge
// cache in front of it. The next request refills that cache with a stale answer and `/cards/*`
// holds it for 16 hours.
//
// None of that raises an error anywhere. The only defence is that the write is actually made, so
// these tests pin the three properties that make it reliable: it retries, it reports exhaustion
// loudly rather than silently, and — the one that matters most — it does not resolve until the
// write has landed, because `loadStore` awaits it before committing the engine.

import { describe, expect, mock, test } from "bun:test";
import { announceSelf } from "../../src/engine/store-kv";

/** A STORE_KV that records puts and can be told to fail the first N of them. */
function fakeEnv(failures = 0) {
	const puts: string[] = [];
	let seen = 0;
	return {
		puts,
		env: {
			STORE_KV: {
				put: async (key: string) => {
					seen += 1;
					if (seen <= failures) throw new Error(`KV unavailable (attempt ${seen})`);
					puts.push(key);
				},
			},
		} as unknown as Parameters<typeof announceSelf>[0],
	};
}

describe("announceSelf", () => {
	test("writes the object's own name under the live prefix", async () => {
		const { env, puts } = fakeEnv();
		await announceSelf(env, "engine-wnam");
		expect(puts).toEqual(["engine:live:engine-wnam"]);
	});

	test("an expanded shard announces under its own name, not its region's", async () => {
		// stepNotify derives a region's width from shard 0 and reaches the rest by name,
		// so a shard that announced as its region would be invisible AND would corrupt
		// the width reading for the object that is actually shard 0.
		const { env, puts } = fakeEnv();
		await announceSelf(env, "engine-wnam-2");
		expect(puts).toEqual(["engine:live:engine-wnam-2"]);
	});

	test("a transient KV failure is retried rather than dropped", async () => {
		const { env, puts } = fakeEnv(1);
		await announceSelf(env, "engine-wnam");
		expect(puts).toEqual(["engine:live:engine-wnam"]);
	});

	test("exhausting the retries is an ERROR, not a warning", async () => {
		// The severity is the point. This object is now invisible to the fan-out, which
		// is a correctness state, not a degraded-logging state — a warning here would sit
		// unread next to the cache-miss chatter.
		const { env, puts } = fakeEnv(2);
		const error = mock((..._args: unknown[]) => {});
		const original = console.error;
		console.error = error as unknown as typeof console.error;
		try {
			await announceSelf(env, "engine-wnam");
		} finally {
			console.error = original;
		}
		expect(puts).toEqual([]);
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0] ?? "")).toContain("COULD NOT ANNOUNCE ITSELF");
	});

	test("a failure never throws, because a load that cannot announce still beats no load", async () => {
		// Refusing to serve would turn a stale-answer risk into an outage.
		const { env } = fakeEnv(2);
		const original = console.error;
		console.error = (() => {}) as unknown as typeof console.error;
		try {
			expect(announceSelf(env, "engine-wnam")).resolves.toBeUndefined();
		} finally {
			console.error = original;
		}
	});

	test("does not resolve before the write has landed", async () => {
		// The whole reason this moved off ctx.waitUntil. loadStore starts it before the
		// archive fetch and awaits it after, so the engine is never committed on the
		// strength of an announcement still in flight.
		let release: (() => void) | undefined;
		const landed = new Promise<void>((r) => {
			release = r;
		});
		let settled = false;
		const env = {
			STORE_KV: { put: async () => await landed },
		} as unknown as Parameters<typeof announceSelf>[0];

		const pending = announceSelf(env, "engine-wnam").then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false); // still in flight
		release?.();
		await pending;
		expect(settled).toBe(true);
	});

	test("an object with no label announces nothing at all", async () => {
		// The scheduled isolate and the tests both load without a DO identity. Writing a
		// key like "engine:live:undefined" would put a name in the live set that the
		// fan-out would then address — and addressing a name CREATES that object.
		const { env, puts } = fakeEnv();
		await announceSelf(env, undefined);
		expect(puts).toEqual([]);
	});
});
