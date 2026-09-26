// The colo's Cache API as a tier in front of KV, for the three values every cold isolate reads:
// the manifest (memo → cache → KV), the routing filter and the tag alias map. The point is that
// KV bills every `get` — colo-cache hit or not — and a cold isolate used to spend three of them
// before it could route a request (~96k of DeckGen's 118k daily reads, measured 2026-09-21).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { edgeCacheUrl, readThroughEdgeCache } from "../../src/engine/edge-cache";
import { livePartitionedManifest, resetManifestMemoForTests } from "../../src/engine/partitioned-engine";
import {
	ARCHIVE_FORMAT_VERSION,
	formatManifestKey,
	readRoutingFilter,
	routingFilterKeyFor,
} from "../../src/engine/store-kv";
import { readTagAliases, tagAliasesKeyFor } from "../../src/engine/tag-aliases";
import type { Env, StoreManifest } from "../../src/engine/types";

const manifest: StoreManifest = {
	store_key: "card-store-v1-100.store",
	built_at: "100",
	card_count: 40,
	printing_count: 100,
	upstream_commit: "abc",
	format_version: ARCHIVE_FORMAT_VERSION,
	store_bytes: 1000,
	chunk_count: 2,
	partition_count: 2,
	partition_hash: "fnv1a64/oracle_id/v1",
	partitions: [0, 1].map((k) => ({
		store_key: `card-store-v1-100-p${k}.store`,
		store_bytes: 500,
		chunk_count: 1,
		card_count: 20,
		printing_count: 50,
	})),
};

/** A KV whose manifest read is counted and scripted. */
function envAnswering(json: string | null) {
	const reads: string[] = [];
	const env = {
		STORE_KV: {
			get: async (key: string) => {
				reads.push(key);
				return json;
			},
		},
	} as unknown as Env;
	return { env, reads };
}

/** A Map-backed stand-in for `caches.default`. */
function fakeCaches() {
	const entries = new Map<string, string>();
	const puts: string[] = [];
	const cache = {
		match: async (key: string) => {
			const body = entries.get(key);
			return body === undefined ? undefined : new Response(body);
		},
		put: async (key: string, res: Response) => {
			puts.push(key);
			entries.set(key, await res.text());
		},
	};
	return { entries, puts, install: () => Object.assign(globalThis, { caches: { default: cache } }) };
}

const g = globalThis as { caches?: unknown };

beforeEach(() => resetManifestMemoForTests());
afterEach(() => {
	delete g.caches;
	resetManifestMemoForTests();
});

describe("the three tiers", () => {
	test("a cold isolate with an empty colo reads KV once and fills the colo entry", async () => {
		const c = fakeCaches();
		c.install();
		const { env, reads } = envAnswering(JSON.stringify(manifest));
		const got = await livePartitionedManifest(env);
		expect(got.store_key).toBe(manifest.store_key);
		expect(reads).toEqual([formatManifestKey()]);
		expect(c.puts.length).toBe(1);
		// The memo answers the same isolate's next request with no read of either tier.
		await livePartitionedManifest(env);
		expect(reads.length).toBe(1);
	});

	test("the next cold isolate in the colo answers from the cache with no KV read", async () => {
		const c = fakeCaches();
		c.install();
		const first = envAnswering(JSON.stringify(manifest));
		await livePartitionedManifest(first.env);
		resetManifestMemoForTests();
		const second = envAnswering(JSON.stringify(manifest));
		const got = await livePartitionedManifest(second.env);
		expect(got.partitions?.length).toBe(2);
		expect(second.reads).toEqual([]);
		expect(c.puts.length).toBe(1);
	});

	test("a deferred put goes through the caller's waitUntil and does not hold the answer", async () => {
		const c = fakeCaches();
		c.install();
		// The put cannot complete until the test releases it: if the answer arrives first, the
		// store really was deferred rather than awaited inline.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cache = (globalThis as unknown as { caches: { default: { put: (k: string, r: Response) => Promise<void> } } })
			.caches.default;
		const rawPut = cache.put;
		cache.put = async (k, r) => {
			await gate;
			return rawPut(k, r);
		};
		const deferred: Promise<unknown>[] = [];
		const { env } = envAnswering(JSON.stringify(manifest));
		const got = await livePartitionedManifest(env, (p) => deferred.push(p));
		expect(got.store_key).toBe(manifest.store_key);
		expect(deferred.length).toBe(1);
		expect(c.puts.length).toBe(0);
		release();
		await Promise.all(deferred);
		expect(c.puts.length).toBe(1);
	});
});

describe("what the cache tier refuses", () => {
	test("a colo entry that is not a partitioned manifest is a miss, not an answer", async () => {
		const c = fakeCaches();
		c.install();
		c.entries.set(edgeCacheUrl(formatManifestKey()), '{"store_key":"old","built_at":"1"}');
		const { env, reads } = envAnswering(JSON.stringify(manifest));
		const got = await livePartitionedManifest(env);
		expect(got.partition_count).toBe(2);
		expect(reads.length).toBe(1);
	});

	test("a colo entry holding garbage falls through to KV", async () => {
		const c = fakeCaches();
		c.install();
		c.entries.set(edgeCacheUrl(formatManifestKey()), "not json");
		const { env, reads } = envAnswering(JSON.stringify(manifest));
		await livePartitionedManifest(env);
		expect(reads.length).toBe(1);
	});

	test("no manifest in KV is the loud 503 and nothing is put", async () => {
		const c = fakeCaches();
		c.install();
		const { env } = envAnswering(null);
		await expect(livePartitionedManifest(env)).rejects.toThrow(/No store manifest/);
		expect(c.puts).toEqual([]);
	});

	test("a cache tier that throws on match is a miss, and one that throws on put is a warning", async () => {
		Object.assign(globalThis, {
			caches: {
				default: {
					match: async () => {
						throw new Error("cache down");
					},
					put: async () => {
						throw new Error("cache down");
					},
				},
			},
		});
		const { env, reads } = envAnswering(JSON.stringify(manifest));
		const got = await livePartitionedManifest(env);
		expect(got.store_key).toBe(manifest.store_key);
		expect(reads.length).toBe(1);
	});
});

// x19: two builds share a colo's Cache API during a deploy — the one being replaced and the one
// replacing it. Each reads its own format's manifest, so each must cache under its own key.
describe("two archive formats in one colo", () => {
	/** A KV holding the old format's manifest at the legacy key and this format's at its own. */
	function envOfBoth(own: StoreManifest | null) {
		const old = { ...manifest, built_at: "90", format_version: ARCHIVE_FORMAT_VERSION - 1 };
		const values: Record<string, string> = { "store:manifest": JSON.stringify(old) };
		if (own) values[formatManifestKey()] = JSON.stringify(own);
		const reads: string[] = [];
		const env = {
			STORE_KV: {
				get: async (key: string) => {
					reads.push(key);
					return values[key] ?? null;
				},
			},
		} as unknown as Env;
		return { env, reads };
	}

	test("the old build's colo entry is never this build's answer", async () => {
		const c = fakeCaches();
		c.install();
		// What a build before x19 left in the colo: its manifest, under the legacy key's URL.
		c.entries.set(
			edgeCacheUrl("store:manifest"),
			JSON.stringify({ ...manifest, built_at: "90", format_version: ARCHIVE_FORMAT_VERSION - 1 }),
		);
		const { env, reads } = envOfBoth(manifest);
		const got = await livePartitionedManifest(env);
		expect(got.built_at).toBe("100");
		expect(reads).toEqual([formatManifestKey()]);
		expect(c.puts).toEqual([edgeCacheUrl(formatManifestKey())]);
	});

	test("an entry of another format under this build's URL is a miss, not an answer", async () => {
		const c = fakeCaches();
		c.install();
		c.entries.set(
			edgeCacheUrl(formatManifestKey()),
			JSON.stringify({ ...manifest, built_at: "90", format_version: ARCHIVE_FORMAT_VERSION + 1 }),
		);
		const { env } = envOfBoth(manifest);
		expect((await livePartitionedManifest(env)).built_at).toBe("100");
	});

	test("with no manifest of this format, another format's is the loud 503 — never served", async () => {
		const { env, reads } = envOfBoth(null);
		await expect(livePartitionedManifest(env)).rejects.toThrow(/No store manifest/);
		expect(reads).toEqual([formatManifestKey(), "store:manifest"]);
	});
});

describe("without a Cache API at all", () => {
	test("the KV path is unchanged", async () => {
		const { env, reads } = envAnswering(JSON.stringify(manifest));
		const got = await livePartitionedManifest(env);
		expect(got.store_key).toBe(manifest.store_key);
		expect(reads).toEqual([formatManifestKey()]);
	});
});

describe("readThroughEdgeCache itself", () => {
	const url = edgeCacheUrl("store:card-routing-v1-100.store:0");

	test("a hit never calls load", async () => {
		const c = fakeCaches();
		c.install();
		c.entries.set(url, "cached");
		let loads = 0;
		const got = await readThroughEdgeCache(url, 60, async () => {
			loads += 1;
			return new Uint8Array([1]);
		});
		expect(new TextDecoder().decode(got as Uint8Array)).toBe("cached");
		expect(loads).toBe(0);
	});

	test("a miss loads, stores, and the next reader hits", async () => {
		const c = fakeCaches();
		c.install();
		const got = await readThroughEdgeCache(url, 60, async () => new TextEncoder().encode("from kv"));
		expect(new TextDecoder().decode(got as Uint8Array)).toBe("from kv");
		expect(c.puts).toEqual([url]);
		const again = await readThroughEdgeCache(url, 60, async () => null);
		expect(new TextDecoder().decode(again as Uint8Array)).toBe("from kv");
	});

	test("a null load is handed back and never stored", async () => {
		const c = fakeCaches();
		c.install();
		expect(await readThroughEdgeCache(url, 60, async () => null)).toBeNull();
		expect(c.puts).toEqual([]);
	});

	test("the URL is the KV key, escaped", () => {
		expect(edgeCacheUrl("store:manifest")).toBe("https://edge-cache.sylvan-librarian.internal/store%3Amanifest");
	});
});

describe("the per-build values every cold isolate reads", () => {
	const build = {
		...manifest,
		format_version: 5,
		built_at: "1700000000",
	} as StoreManifest;

	test("the routing filter answers from the colo entry with no KV read", async () => {
		const c = fakeCaches();
		c.install();
		const key = routingFilterKeyFor(build) as string;
		c.entries.set(edgeCacheUrl(key), "filter-bytes");
		const { env, reads } = envAnswering(null);
		const got = await readRoutingFilter(env, build);
		expect(new TextDecoder().decode(got as Uint8Array)).toBe("filter-bytes");
		expect(reads).toEqual([]);
	});

	test("the alias map answers from the colo entry with no KV read, and an unpublished one is not stored", async () => {
		const c = fakeCaches();
		c.install();
		const key = tagAliasesKeyFor(build) as string;
		c.entries.set(edgeCacheUrl(key), '{"oracle":{"a":"b"},"art":{}}');
		const { env, reads } = envAnswering(null);
		const tables = await readTagAliases(env, build);
		expect(tables?.oracle.get("a")).toBe("b");
		expect(reads).toEqual([]);
		// A build with no map: KV is asked, answers null, and nothing is put — the late publish
		// (scripts/publish-tag-aliases.ts) must be found by the next reader.
		const other = { ...build, built_at: "1700000001" } as StoreManifest;
		expect(await readTagAliases(env, other)).toBeNull();
		expect(c.puts).toEqual([]);
	});
});
