// The partitioned loader, per-label store state, and the compressed cache —
// exercised through the REAL src/engine/store.ts with the wasm boundary faked.
//
// MOCK SCOPE NOTE (the autoscaler-signal lesson): `mock.module` is
// process-global in bun. Two mocks are registered here and both are safe by
// construction:
//   - "sylvan-engine-wasm" resolves nowhere outside workerd (wrangler aliases
//     it to the shim), and the only module importing it — store.ts — is either
//     mocked away wholesale (rendezvous.test.ts) or imported HERE through a
//     query-string specifier, so no other suite can observe this fake.
//   - "../../src/engine/placement" is replaced with the real module plus an
//     inert probePlacement, because the real probe fetches a trace URL and
//     tests/ must never touch the network. engine-placement.test.ts imports
//     only parseTrace/placementLine/PROBE_MIN_INTERVAL_MS from the plain path
//     (its probe tests use query-string imports), all of which this mock
//     re-exports unchanged.

import { describe, expect, mock, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import type { ArchiveCacheStorage } from "../../src/engine/store-cache";
import { chunkKey, gzipBytes, PARTITION_HASH_ALGO } from "../../src/engine/store-kv";
import type { Env, StoreManifest } from "../../src/engine/types";
import { EngineUnavailableError } from "../../src/engine/types";

// ── The wasm fake: one instance per label, like the real shim ─────────────────

interface FakeInstance {
	staged: Uint8Array[];
	expected: number;
	loaded: Uint8Array | null;
	/** The shim's drop counter: a test bumps it to simulate an instance lost to a trap. */
	generation: number;
}
const instances = new Map<string, FakeInstance>();

function instanceFor(label: string): FakeInstance {
	let inst = instances.get(label);
	if (!inst) {
		inst = { staged: [], expected: 0, loaded: null, generation: 0 };
		instances.set(label, inst);
	}
	return inst;
}

function handleFor(label: string) {
	const inst = instanceFor(label);
	return {
		begin_store_load(total: number) {
			inst.staged = [];
			inst.expected = total;
		},
		store_load_chunk(chunk: Uint8Array) {
			inst.staged.push(chunk.slice());
		},
		finish_store_load() {
			const total = inst.staged.reduce((s, c) => s + c.length, 0);
			if (total !== inst.expected) throw new Error(`fake wasm: fed ${total} of ${inst.expected} bytes`);
			const out = new Uint8Array(total);
			let at = 0;
			for (const c of inst.staged) {
				out.set(c, at);
				at += c.length;
			}
			inst.loaded = out;
		},
		// The engine's own inflater: the stored gzip members arrive as-is, in any pieces, and come
		// out as the archive. node:zlib accepts concatenated members, as the real decoder does.
		begin_store_load_gzip(total: number) {
			inst.staged = [];
			inst.expected = total;
		},
		store_load_gzip_chunk(chunk: Uint8Array) {
			inst.staged.push(chunk.slice());
		},
		finish_store_load_gzip() {
			const gz = Buffer.concat(inst.staged);
			const out = new Uint8Array(gunzipSync(gz));
			if (out.length !== inst.expected) throw new Error(`fake wasm: inflated ${out.length} of ${inst.expected} bytes`);
			inst.loaded = out;
		},
		unload_store() {
			inst.loaded = null;
		},
		store_loaded: () => inst.loaded !== null,
		// The identity probe: the loaded archive's first byte, so a test can tell
		// WHICH partition's bytes an engine answers from.
		size: () => (inst.loaded ? (inst.loaded[0] as number) : 0),
		query: () => JSON.stringify({ total: 0, rows: [] }),
		sort_key_version: () => 1,
		query_keys: () => new Uint8Array(8),
		fetch_rows: () => new Uint8Array(2),
		linearMemoryBytes: () => inst.loaded?.length ?? 0,
		instanceGeneration: () => inst.generation,
	};
}

mock.module("sylvan-engine-wasm", () => ({
	ensureEngine: () => {},
	linearMemoryBytes: () => 0,
	engineFor: handleFor,
}));

// Query-string specifiers keep these imports OUT of the plain module-cache slot
// (and out of other suites' mocks); the indirection through a variable keeps
// tsc from resolving what only bun's loader understands.
const placementSpec = "../../src/engine/placement.ts?real-for-store-partitioned";
const realPlacement = (await import(placementSpec)) as typeof import("../../src/engine/placement");
mock.module("../../src/engine/placement", () => ({
	...realPlacement,
	probePlacement: () => {},
}));

const storeSpec = "../../src/engine/store.ts?partitioned";
const store = (await import(storeSpec)) as typeof import("../../src/engine/store");

// ── Fake KV and DO storage ────────────────────────────────────────────────────

function fakeEnv(entries: Map<string, Uint8Array | string>, putFailures = 0) {
	const reads: string[] = [];
	const puts: string[] = [];
	let putsSeen = 0;
	const env = {
		STORE_KV: {
			async get(key: string, opts?: { type?: string }) {
				reads.push(key);
				const value = entries.get(key);
				if (value === undefined) return null;
				if (opts?.type === "arrayBuffer") {
					const bytes = value as Uint8Array;
					const buf = new ArrayBuffer(bytes.byteLength);
					new Uint8Array(buf).set(bytes);
					return buf;
				}
				return typeof value === "string" ? value : new TextDecoder().decode(value);
			},
			async put(key: string) {
				putsSeen += 1;
				if (putsSeen <= putFailures) throw new Error(`KV unavailable (put ${putsSeen})`);
				puts.push(key);
			},
			async delete() {},
		},
	} as unknown as Env;
	return { env, reads, puts, chunkReads: () => reads.filter((k) => k.startsWith("store:card-")) };
}

/** A minimal SQLite fake speaking exactly the statements store-cache issues. */
function fakeStorage(): ArchiveCacheStorage {
	const rows = new Map<string, Map<number, Uint8Array>>();
	const meta = new Map<string, { total: number; count: number }>();
	let live: string | null = null;
	let announced: string | null = null;
	return {
		sql: {
			exec(query: string, ...b: unknown[]) {
				const q = query.trim();
				const out = (rowsOut: Record<string, unknown>[]) => ({
					toArray: () => rowsOut as never[],
				});
				if (q.startsWith("CREATE TABLE")) return out([]);
				if (q.startsWith("SELECT total_bytes")) {
					const m = meta.get(b[0] as string);
					return out(m ? [{ total_bytes: m.total, row_count: m.count }] : []);
				}
				if (q.startsWith("SELECT bytes")) {
					const one = rows.get(b[0] as string)?.get(b[1] as number);
					return out(one ? [{ bytes: one }] : []);
				}
				if (q.startsWith("SELECT archive_key")) {
					return out([...meta.keys()].map((archive_key) => ({ archive_key })));
				}
				if (q.startsWith("INSERT INTO archive_cache_meta")) {
					meta.set(b[0] as string, { total: b[1] as number, count: b[2] as number });
					return out([]);
				}
				if (q.startsWith("INSERT INTO archive_cache")) {
					let list = rows.get(b[0] as string);
					if (!list) {
						list = new Map();
						rows.set(b[0] as string, list);
					}
					if (list.has(b[1] as number)) throw new Error("UNIQUE constraint failed");
					list.set(b[1] as number, new Uint8Array(b[2] as ArrayBuffer));
					return out([]);
				}
				if (q.startsWith("DELETE FROM archive_cache_meta")) {
					meta.delete(b[0] as string);
					return out([]);
				}
				if (q.startsWith("DELETE FROM archive_cache")) {
					rows.delete(b[0] as string);
					return out([]);
				}
				if (q.startsWith("INSERT OR REPLACE INTO live_manifest")) {
					live = b[0] as string;
					return out([]);
				}
				if (q.startsWith("SELECT json FROM live_manifest")) {
					return out(live === null ? [] : [{ json: live }]);
				}
				if (q.startsWith("INSERT OR REPLACE INTO announced")) {
					announced = b[0] as string;
					return out([]);
				}
				if (q.startsWith("SELECT store_key FROM announced")) {
					return out(announced === null ? [] : [{ store_key: announced }]);
				}
				throw new Error(`fake storage cannot answer: ${q.slice(0, 60)}`);
			},
		},
	} as unknown as ArchiveCacheStorage;
}

// ── A published two-partition store ───────────────────────────────────────────

/** Partition k's raw archive: 64 bytes, first byte = marker. */
function rawArchive(marker: number): Uint8Array {
	const bytes = new Uint8Array(64);
	bytes.fill(marker);
	return bytes;
}

async function publishV2(builtAt = "100"): Promise<{
	entries: Map<string, Uint8Array | string>;
	manifest: StoreManifest;
	raw: Uint8Array[];
}> {
	const raw = [rawArchive(7), rawArchive(9)];
	const gz = await Promise.all(raw.map((r) => gzipBytes(r)));
	const partitions = raw.map((r, k) => ({
		store_key: `card-store-v1-${builtAt}-p${k}.store`,
		store_bytes: r.length,
		store_gzip_bytes: (gz[k] as Uint8Array).length,
		chunk_count: 1,
		card_count: 10,
		printing_count: 20,
	}));
	const manifest: StoreManifest = {
		store_key: `card-store-v1-${builtAt}.store`,
		built_at: builtAt,
		card_count: 20,
		printing_count: 40,
		upstream_commit: "abc",
		format_version: 1,
		store_bytes: (raw[0] as Uint8Array).length + (raw[1] as Uint8Array).length,
		store_gzip_bytes: (gz[0] as Uint8Array).length + (gz[1] as Uint8Array).length,
		chunk_count: 2,
		partition_count: 2,
		partition_hash: PARTITION_HASH_ALGO,
		partitions,
	};
	const entries = new Map<string, Uint8Array | string>();
	entries.set("store:manifest", JSON.stringify(manifest));
	for (let k = 0; k < 2; k++)
		entries.set(chunkKey((partitions[k] as { store_key: string }).store_key, 0), gz[k] as Uint8Array);
	return { entries, manifest, raw };
}

const ctxFor = (label: string, partition?: number, storage?: ArchiveCacheStorage) => ({
	waitUntil: () => {},
	label,
	...(partition === undefined ? {} : { partition }),
	...(storage ? { storage } : {}),
});

describe("the partitioned loader", () => {
	test("selects partitions[k] by the label's partition, per label, without clobbering", async () => {
		const { entries } = await publishV2();
		const { env } = fakeEnv(entries);

		const e0 = await store.getEngine(env, ctxFor("engine-test-p0", 0));
		const e1 = await store.getEngine(env, ctxFor("engine-test-p1", 1));

		// Each label's wasm instance holds ITS partition's bytes.
		expect(instanceFor("engine-test-p0").loaded?.[0]).toBe(7);
		expect(instanceFor("engine-test-p1").loaded?.[0]).toBe(9);
		// And the per-label registry did not clobber: p0's engine still answers
		// from p0's archive after p1 loaded.
		expect(await e0.cardCount()).toBe(7);
		expect(await e1.cardCount()).toBe(9);
		expect(store.tryGetLoadedEngine("engine-test-p0")).toBe(e0);
		expect(store.tryGetLoadedEngine("engine-test-p1")).toBe(e1);
		expect(store.tryGetLoadedEngine("engine-test-p0")).not.toBe(e1);
	});

	test("a label with NO partition is a loud 503 calling it a naming bug", async () => {
		// Every engine object is engine-<region>[-<n>]-p<k>. Loading one partition
		// as the whole store would answer with 1/N of the corpus and say nothing,
		// so the loader refuses rather than serving — and the message says which
		// side is wrong, because there is no mode to switch.
		const { entries } = await publishV2("101");
		const { env } = fakeEnv(entries);
		expect(store.getEngine(env, ctxFor("engine-nopartition"))).rejects.toThrow(/NAMING BUG/);
		expect(store.getEngine(env, ctxFor("engine-nopartition"))).rejects.toThrow(EngineUnavailableError);
	});

	test("an unknown partition_hash is refused, loudly", async () => {
		const { entries, manifest } = await publishV2("102");
		entries.set("store:manifest", JSON.stringify({ ...manifest, partition_hash: "sha256/oracle_id/v9" }));
		const { env } = fakeEnv(entries);
		expect(store.getEngine(env, ctxFor("engine-hash-p0", 0))).rejects.toThrow(/does not implement/);
	});

	test("a partition index past partition_count is refused", async () => {
		const { entries } = await publishV2("103");
		const { env } = fakeEnv(entries);
		expect(store.getEngine(env, ctxFor("engine-oob-p5", 5))).rejects.toThrow(/no record for partition 5/);
	});

	test("a manifest predating the partitioned store is refused, loudly and specifically", async () => {
		// THE ONE-TIME TRANSITION, from the loader's side: the pre-partition store
		// is still physically in KV until retention collects it, and a reader that
		// met its manifest must fail with the reason rather than fall back — there
		// is no unpartitioned load path left to fall back to.
		const raw = rawArchive(3);
		const entries = new Map<string, Uint8Array | string>();
		entries.set(
			"store:manifest",
			JSON.stringify({
				store_key: "card-store-v1-104.store",
				built_at: "104",
				card_count: 1,
				printing_count: 1,
				upstream_commit: "abc",
				format_version: 1,
				store_bytes: raw.length,
			}),
		);
		const { env } = fakeEnv(entries);
		expect(store.getEngine(env, ctxFor("engine-old-p0", 0))).rejects.toThrow(/predates the partitioned store/);
		// And the repair is named: the next import replaces it.
		expect(store.getEngine(env, ctxFor("engine-old-p0", 0))).rejects.toThrow(/next import/);
	});
});

describe("the compressed archive cache", () => {
	test("a cold load tees COMPRESSED chunks in; the next load reads no KV chunks", async () => {
		const { entries, raw } = await publishV2("110");
		const storage = fakeStorage();

		const first = fakeEnv(entries);
		await store.getEngine(first.env, ctxFor("engine-cachea-p0", 0, storage));
		expect(first.chunkReads().length).toBe(1);
		expect(instanceFor("engine-cachea-p0").loaded).toEqual(raw[0] as Uint8Array);

		// A different label (fresh state) sharing the storage: KV chunk reads stay
		// at zero, and the decompressed bytes are identical.
		const second = fakeEnv(entries);
		await store.getEngine(second.env, ctxFor("engine-cacheb-p0", 0, storage));
		expect(second.chunkReads().length).toBe(0);
		expect(instanceFor("engine-cacheb-p0").loaded).toEqual(raw[0] as Uint8Array);
	});

	test("a partial compressed copy is unreadable as a whole (meta-last per chunk, sum-checked)", async () => {
		const { entries, manifest, raw } = await publishV2("111");
		// Two chunks for partition 0 this time: cut the raw archive in half.
		const part = manifest.partitions?.[0];
		if (!part) throw new Error("no partition record");
		const whole = raw[0] as Uint8Array;
		const halves = [whole.subarray(0, 32), whole.subarray(32)];
		const gz = await Promise.all(halves.map((h) => gzipBytes(h.slice())));
		part.chunk_count = 2;
		part.store_gzip_bytes = (gz[0] as Uint8Array).length + (gz[1] as Uint8Array).length;
		if (manifest.partitions) {
			manifest.chunk_count = manifest.partitions.reduce((s, p) => s + p.chunk_count, 0);
			manifest.store_gzip_bytes = manifest.partitions.reduce((s, p) => s + (p.store_gzip_bytes ?? 0), 0);
		}
		entries.set("store:manifest", JSON.stringify(manifest));
		entries.set(chunkKey(part.store_key, 0), gz[0] as Uint8Array);
		entries.set(chunkKey(part.store_key, 1), gz[1] as Uint8Array);

		const storage = fakeStorage();
		// Prefetch only chunk 0 by hand, simulating a fill that died between chunks.
		const cache = await import("../../src/engine/store-cache");
		cache.putCompressedChunk(storage, part.store_key, 0, gz[0] as Uint8Array);
		expect(cache.isCompressedCached(storage, part.store_key, 2, part.store_gzip_bytes)).toBe(false);

		// The load treats the partial set as a miss and reads KV.
		const { env, chunkReads } = fakeEnv(entries);
		await store.getEngine(env, ctxFor("engine-partial-p0", 0, storage));
		expect(chunkReads().length).toBe(2);
		expect(instanceFor("engine-partial-p0").loaded).toEqual(raw[0] as Uint8Array);
		// And the tee completed the copy: now it IS readable as a whole.
		expect(cache.isCompressedCached(storage, part.store_key, 2, part.store_gzip_bytes)).toBe(true);
	});
});

describe("prepare/commit at the loader level", () => {
	test("prefetchStore holds the bytes locally and does NOT swap", async () => {
		const { entries, manifest } = await publishV2("120");
		const storage = fakeStorage();
		const { env, chunkReads } = fakeEnv(entries);

		const held = await store.prefetchStore(env, ctxFor("engine-prep-p1", 1, storage), manifest);
		expect(held).toBe(true);
		expect(chunkReads().length).toBe(1);
		// NO swap: nothing is loaded for the label.
		expect(store.tryGetLoadedEngine("engine-prep-p1")).toBeNull();
		expect(instanceFor("engine-prep-p1").loaded ?? null).toBeNull();
	});

	test("swapToStore then loads from the local copy, not KV", async () => {
		const { entries, manifest, raw } = await publishV2("121");
		const storage = fakeStorage();
		const prefetchEnv = fakeEnv(entries);
		await store.prefetchStore(prefetchEnv.env, ctxFor("engine-commit-p1", 1, storage), manifest);

		const swapEnv = fakeEnv(entries);
		const swapped = await store.swapToStore(swapEnv.env, ctxFor("engine-commit-p1", 1, storage), manifest);
		expect(swapped).toBe(true);
		expect(swapEnv.chunkReads().length).toBe(0); // served from the compressed cache
		expect(instanceFor("engine-commit-p1").loaded).toEqual(raw[1] as Uint8Array);
		expect(store.tryGetLoadedEngine("engine-commit-p1")).not.toBeNull();
	});

	test("two concurrent swaps to the same store load it ONCE", async () => {
		// The gather's straggler remedy is called by every concurrent gather that
		// meets the same straggler; each used to start its own load on the same
		// wasm handle, sharing one streaming decoder and leaking a buffer.
		const { entries, manifest, raw } = await publishV2("123");
		const storage = fakeStorage();
		const { env, chunkReads } = fakeEnv(entries);
		const ctx = ctxFor("engine-twice-p1", 1, storage);
		const [a, b] = await Promise.all([store.swapToStore(env, ctx, manifest), store.swapToStore(env, ctx, manifest)]);
		expect(a).toBe(true);
		expect(b).toBe(true);
		expect(chunkReads().length).toBe(1);
		expect(instanceFor("engine-twice-p1").loaded).toEqual(raw[1] as Uint8Array);
		expect(store.tryGetLoadedEngine("engine-twice-p1")).not.toBeNull();
	});

	test("a swap arriving during a cold load waits for it, then swaps", async () => {
		// KV's manifest names build 124; a publish of 125 is pushed while a request's
		// cold load of 124 is still streaming. The swap must not start a second load
		// on top of the first; it waits, then moves the label to 125.
		const old = await publishV2("124");
		const fresh = await publishV2("125");
		const entries = new Map(old.entries);
		for (const [key, value] of fresh.entries) if (key.startsWith("store:card-")) entries.set(key, value);
		const storage = fakeStorage();
		const { env } = fakeEnv(entries);
		const ctx = ctxFor("engine-midload-p1", 1, storage);
		const cold = store.getEngine(env, ctx);
		const swapped = await store.swapToStore(env, ctx, fresh.manifest);
		await cold;
		expect(swapped).toBe(true);
		expect(instanceFor("engine-midload-p1").loaded).toEqual(fresh.raw[1] as Uint8Array);
		expect(store.tryGetLoadedEngine("engine-midload-p1")).not.toBeNull();
	});

	test("concurrent refreshNow calls share one manifest read and one swap", async () => {
		const { entries, manifest, raw } = await publishV2("126");
		const storage = fakeStorage();
		const { env, reads, chunkReads } = fakeEnv(entries);
		const ctx = ctxFor("engine-refresh-p1", 1, storage);
		const results = await Promise.all([
			store.refreshNow(env, ctx),
			store.refreshNow(env, ctx),
			store.refreshNow(env, ctx),
		]);
		expect(results).toEqual([true, true, true]);
		expect(reads.filter((k) => k === "store:manifest").length).toBe(1);
		expect(chunkReads().length).toBe(1);
		expect(instanceFor("engine-refresh-p1").loaded).toEqual(raw[1] as Uint8Array);
		expect(manifest.built_at).toBe("126");
	});

	test("a manifest shape this object cannot serve degrades to a no-op ack, never a throw", async () => {
		const { entries, manifest } = await publishV2("122");
		const storage = fakeStorage();
		const { env } = fakeEnv(entries);
		// A label carrying no partition is a bug, but the PUBLISH must not wedge on
		// it: prepare and commit both report false and keep whatever was serving.
		expect(await store.prefetchStore(env, ctxFor("engine-unnamed", undefined, storage), manifest)).toBe(false);
		expect(await store.swapToStore(env, ctxFor("engine-unnamed", undefined, storage), manifest)).toBe(false);
	});
});

describe("an engine instance lost to a trap", () => {
	test("its store is no longer served, and the next request reloads it", async () => {
		// The shim drops a trapped instance and bumps its generation; `current` used to keep
		// pointing at the dead instance, so every query answered from an empty fresh one.
		const { entries, raw } = await publishV2("128");
		const storage = fakeStorage();
		const { env, chunkReads } = fakeEnv(entries);
		const ctx = ctxFor("engine-trapped-p1", 1, storage);
		await store.getEngine(env, ctx);
		expect(store.tryGetLoadedEngine("engine-trapped-p1")).not.toBeNull();
		const inst = instanceFor("engine-trapped-p1");
		inst.generation += 1;
		inst.loaded = null; // the fresh instance holds nothing
		expect(store.tryGetLoadedEngine("engine-trapped-p1")).toBeNull();
		const before = chunkReads().length;
		await store.getEngine(env, ctx);
		expect(instanceFor("engine-trapped-p1").loaded as Uint8Array | null).toEqual(raw[1] as Uint8Array);
		// Reloaded from the local cache the first load filled, not KV.
		expect(chunkReads().length).toBe(before);
		expect(store.tryGetLoadedEngine("engine-trapped-p1")).not.toBeNull();
	});
});

describe("load backoff", () => {
	test("a failed cold load is not retried on the very next request", async () => {
		// The manifest names a partition whose chunks are gone (a deploy that pruned
		// without notifying). The first request fails loudly; the next one, seconds
		// later, must fail just as loudly WITHOUT a second fetch-and-inflate: each
		// attempt costs the chunk reads, the inflate and (until the wasm crate
		// recycled it) a partition of linear memory, and a per-request retry is what
		// turned a 503 outage into an isolate reset loop.
		const { entries, manifest } = await publishV2("127");
		const missing = new Map(entries);
		for (const key of [...missing.keys()])
			if (key.startsWith("store:card-") && key.includes("-p1.")) missing.delete(key);
		const storage = fakeStorage();
		const { env, chunkReads } = fakeEnv(missing);
		const ctx = ctxFor("engine-backoff-p1", 1, storage);
		await expect(store.getEngine(env, ctx)).rejects.toThrow();
		const readsAfterFirst = chunkReads().length;
		expect(readsAfterFirst).toBeGreaterThan(0);
		await expect(store.getEngine(env, ctx)).rejects.toBeInstanceOf(EngineUnavailableError);
		await expect(store.getEngine(env, ctx)).rejects.toThrow(/not retrying/);
		expect(chunkReads().length).toBe(readsAfterFirst);
		expect(manifest.built_at).toBe("127");
	});
});

describe("wedged-object recovery, per partition", () => {
	test("a pushed manifest whose PARTITION chunks are gone falls back to KV's live build", async () => {
		const { entries, manifest, raw } = await publishV2("130");
		const storage = fakeStorage();
		// The publisher once pushed build 099, whose chunks no longer exist.
		const stale = JSON.parse(JSON.stringify(manifest)) as StoreManifest;
		stale.store_key = "card-store-v1-099.store";
		stale.built_at = "099";
		for (const p of stale.partitions ?? []) p.store_key = p.store_key.replace("-130-", "-099-");
		// The rewrite must actually point the pushed manifest at retired chunks,
		// or this test would pass without exercising the recovery at all.
		expect(stale.partitions?.[0]?.store_key).toBe("card-store-v1-099-p0.store");
		const cache = await import("../../src/engine/store-cache");
		cache.recordLiveManifest(storage, stale);

		const { env } = fakeEnv(entries);
		const engine = await store.getEngine(env, ctxFor("engine-wedged-p0", 0, storage));
		// The KV check compared THIS PARTITION's chunk-family keys BEFORE loading, noticed the
		// mismatch, and loaded the build KV actually holds — once, never the stale one first.
		expect(instanceFor("engine-wedged-p0").loaded).toEqual(raw[0] as Uint8Array);
		expect(await engine.cardCount()).toBe(7);
		// And corrected the record, so the next wake starts from the live build instead of
		// rediscovering the mismatch. On 2026-09-18 this correction was missing and every wake of
		// a colocated pair double-loaded until the isolate ran out of memory.
		expect((cache.readLiveManifest(storage) as StoreManifest).built_at).toBe(manifest.built_at);
	});
});

describe("a pushed record NEWER than KV's colo-cached manifest", () => {
	// Right after a publish, KV's manifest read answers the PREVIOUS generation for up to 60s
	// (cacheTtl), while the coordinator has already pushed the new one and counted this object
	// as converged. The record is the fresher fact; loading KV's served the old generation and
	// rewrote the record with it.
	test("is loaded on its own authority, and the record is kept", async () => {
		const older = await publishV2("130");
		const newer = await publishV2("131");
		// KV: manifest 130 (the stale colo cache), chunks of BOTH families present.
		const entries = new Map(older.entries);
		for (const [key, value] of newer.entries) if (key.startsWith("store:card-")) entries.set(key, value);
		const storage = fakeStorage();
		const cache = await import("../../src/engine/store-cache");
		cache.recordLiveManifest(storage, newer.manifest);

		const { env, chunkReads } = fakeEnv(entries);
		const engine = await store.getEngine(env, ctxFor("engine-newer-p0", 0, storage));
		expect(instanceFor("engine-newer-p0").loaded).toEqual(newer.raw[0] as Uint8Array);
		expect(await engine.cardCount()).toBe(7);
		expect(chunkReads().every((k) => k.includes("-131-"))).toBe(true);
		expect((cache.readLiveManifest(storage) as StoreManifest).built_at).toBe("131");
	});

	test("falls back to KV's build when the record's chunks are gone, and corrects the record", async () => {
		const older = await publishV2("132");
		const newer = await publishV2("133");
		// KV: manifest 132, and ONLY 132's chunks — 133 was retired before this object woke.
		const storage = fakeStorage();
		const cache = await import("../../src/engine/store-cache");
		cache.recordLiveManifest(storage, newer.manifest);

		const { env } = fakeEnv(older.entries);
		const engine = await store.getEngine(env, ctxFor("engine-newer-gone-p0", 0, storage));
		expect(instanceFor("engine-newer-gone-p0").loaded).toEqual(older.raw[0] as Uint8Array);
		expect(await engine.cardCount()).toBe(7);
		expect((cache.readLiveManifest(storage) as StoreManifest).built_at).toBe("132");
	});
});

describe("the announcement is written once per store, not once per wake", () => {
	// An idle object is hibernated after ~10s, so a wake is routine: DeckGen's partitions reloaded
	// ~500 times an hour on 2026-09-22, and every one rewrote the same `engine:live:<name>` = "1",
	// ~12,000 KV writes a day against the free plan's 1,000. A fresh import of store.ts is a fresh
	// isolate: nothing loaded, the object's storage intact — exactly what a wake looks like.
	let wakes = 0;
	const wake = async () =>
		(await import(`../../src/engine/store.ts?announce-wake-${++wakes}`)) as typeof import("../../src/engine/store");

	test("the first load announces; a wake onto the same store writes nothing", async () => {
		const { entries } = await publishV2("300");
		const { env, puts } = fakeEnv(entries);
		const storage = fakeStorage();
		await (await wake()).getEngine(env, ctxFor("engine-announce-p0", 0, storage));
		expect(puts).toEqual(["engine:live:engine-announce-p0"]);
		await (await wake()).getEngine(env, ctxFor("engine-announce-p0", 0, storage));
		await (await wake()).getEngine(env, ctxFor("engine-announce-p0", 0, storage));
		expect(puts).toEqual(["engine:live:engine-announce-p0"]);
	});

	test("a new generation announces once more, so a key deleted by hand comes back", async () => {
		const first = await publishV2("301");
		const storage = fakeStorage();
		const a = fakeEnv(first.entries);
		await (await wake()).getEngine(a.env, ctxFor("engine-announce2-p0", 0, storage));
		const second = await publishV2("302");
		const b = fakeEnv(second.entries);
		await (await wake()).getEngine(b.env, ctxFor("engine-announce2-p0", 0, storage));
		expect(a.puts).toEqual(["engine:live:engine-announce2-p0"]);
		expect(b.puts).toEqual(["engine:live:engine-announce2-p0"]);
	});

	test("an announcement that failed is not recorded, so the next wake retries it", async () => {
		const { entries } = await publishV2("303");
		// Both attempts of the first load fail; the second load's write lands.
		const { env, puts } = fakeEnv(entries, 2);
		const storage = fakeStorage();
		const original = console.error;
		console.error = (() => {}) as unknown as typeof console.error;
		try {
			await (await wake()).getEngine(env, ctxFor("engine-announce3-p0", 0, storage));
		} finally {
			console.error = original;
		}
		expect(puts).toEqual([]);
		await (await wake()).getEngine(env, ctxFor("engine-announce3-p0", 0, storage));
		expect(puts).toEqual(["engine:live:engine-announce3-p0"]);
	});
});
