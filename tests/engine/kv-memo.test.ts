// readKvBytesMemo's pools, byte budget and edge-cache tier — the three options the oracle index
// (src/engine/oracle-index.ts) reads its buckets with. Every caller before it passes none of them
// and must behave exactly as it did: one default pool, count-bounded, KV only.

import { afterEach, describe, expect, test } from "bun:test";
import { EDGE_CACHE_ABSENT_HEADER, edgeCacheUrl } from "../../src/engine/edge-cache";
import { readKvBytesMemo } from "../../src/engine/kv-memo";

/** Counts gets per key; values are `size` bytes, or absent for keys in `absent`. */
function countingKv(size = 100, absent = new Set<string>()): { kv: KVNamespace; gets: Map<string, number> } {
	const gets = new Map<string, number>();
	const kv = {
		async get(key: string) {
			gets.set(key, (gets.get(key) ?? 0) + 1);
			return absent.has(key) ? null : new Uint8Array(size).fill(7).buffer;
		},
	} as unknown as KVNamespace;
	return { kv, gets };
}

/** A `caches.default` that keeps bodies as BYTES and keeps headers, like the real one. */
function installCaches(): Map<string, { body: Uint8Array; headers: Headers }> {
	const entries = new Map<string, { body: Uint8Array; headers: Headers }>();
	const cache = {
		match: async (key: string) => {
			const hit = entries.get(key);
			return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
		},
		put: async (key: string, res: Response) => {
			entries.set(key, { body: new Uint8Array(await res.arrayBuffer()), headers: new Headers(res.headers) });
		},
	};
	Object.assign(globalThis, { caches: { default: cache } });
	return entries;
}

afterEach(() => {
	delete (globalThis as { caches?: unknown }).caches;
});

describe("readKvBytesMemo pools and byte budget", () => {
	test("a pool's values do not evict the default pool's", async () => {
		const { kv, gets } = countingKv();
		await readKvBytesMemo(kv, "rulings:v2:00");
		for (let b = 0; b < 20; b++) {
			await readKvBytesMemo(kv, `oracle-index:v1:${b}`, { pool: "oracle-index", maxEntries: 16 });
		}
		await readKvBytesMemo(kv, "rulings:v2:00");
		expect(gets.get("rulings:v2:00")).toBe(1);
	});

	test("the default pool is still bounded by entry count (8), oldest first", async () => {
		const { kv, gets } = countingKv();
		for (let i = 0; i < 9; i++) await readKvBytesMemo(kv, `k${i}`);
		await readKvBytesMemo(kv, "k8");
		await readKvBytesMemo(kv, "k0");
		expect(gets.get("k8")).toBe(1);
		expect(gets.get("k0")).toBe(2);
	});

	test("maxBytes evicts oldest-first until the new value fits", async () => {
		const { kv, gets } = countingKv(1000);
		const opts = { pool: "p", maxEntries: 100, maxBytes: 2500 };
		await readKvBytesMemo(kv, "a", opts);
		await readKvBytesMemo(kv, "b", opts);
		await readKvBytesMemo(kv, "c", opts); // evicts a
		await readKvBytesMemo(kv, "b", opts);
		await readKvBytesMemo(kv, "a", opts);
		expect(gets.get("b")).toBe(1);
		expect(gets.get("a")).toBe(2);
	});
});

describe("readKvBytesMemo through the edge cache", () => {
	test("a second isolate in the colo reads the colo copy, not KV", async () => {
		const entries = installCaches();
		const first = countingKv(300);
		const got = await readKvBytesMemo(first.kv, "oracle-index:v1:00", { edgeTtl: 43_200 });
		expect(got?.length).toBe(300);
		const stored = entries.get(edgeCacheUrl("oracle-index:v1:00"));
		expect(stored?.headers.get("cache-control")).toBe("public, max-age=43200");
		// A different namespace object is a different isolate's memo; the colo copy still answers.
		const second = countingKv(300);
		const again = await readKvBytesMemo(second.kv, "oracle-index:v1:00", { edgeTtl: 43_200 });
		expect(again).toEqual(got);
		expect(second.gets.size).toBe(0);
	});

	test("an absent key is remembered at the colo only when asked to, and only for edgeMissTtl", async () => {
		const entries = installCaches();
		const absent = new Set(["oracle-index:v1:01"]);
		const a = countingKv(300, absent);
		expect(await readKvBytesMemo(a.kv, "oracle-index:v1:01", { edgeTtl: 43_200 })).toBeNull();
		expect(entries.size).toBe(0);

		expect(
			await readKvBytesMemo(countingKv(300, absent).kv, "oracle-index:v1:01", { edgeTtl: 43_200, edgeMissTtl: 3600 }),
		).toBeNull();
		const stored = entries.get(edgeCacheUrl("oracle-index:v1:01"));
		expect(stored?.headers.get(EDGE_CACHE_ABSENT_HEADER)).toBe("1");
		expect(stored?.headers.get("cache-control")).toBe("public, max-age=3600");
		// The next isolate is told "absent" by the colo, without a metered read of nothing.
		const b = countingKv(300, absent);
		expect(await readKvBytesMemo(b.kv, "oracle-index:v1:01", { edgeTtl: 43_200, edgeMissTtl: 3600 })).toBeNull();
		expect(b.gets.size).toBe(0);
	});
});
