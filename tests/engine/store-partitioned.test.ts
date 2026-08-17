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
import type { ArchiveCacheStorage } from "../../src/engine/store-cache";
import { chunkKey, gzipBytes, PARTITION_HASH_ALGO } from "../../src/engine/store-kv";
import type { Env, StoreManifest } from "../../src/engine/types";
import { EngineUnavailableError } from "../../src/engine/types";

// ── The wasm fake: one instance per label, like the real shim ─────────────────

interface FakeInstance {
	staged: Uint8Array[];
	expected: number;
	loaded: Uint8Array | null;
}
const instances = new Map<string, FakeInstance>();

function instanceFor(label: string): FakeInstance {
	let inst = instances.get(label);
	if (!inst) {
		inst = { staged: [], expected: 0, loaded: null };
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

function fakeEnv(entries: Map<string, Uint8Array | string>) {
	const reads: string[] = [];
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
			async put() {},
			async delete() {},
		},
	} as unknown as Env;
	return { env, reads, chunkReads: () => reads.filter((k) => k.startsWith("store:card-")) };
}

/** A minimal SQLite fake speaking exactly the statements store-cache issues. */
function fakeStorage(): ArchiveCacheStorage {
	const rows = new Map<string, Map<number, Uint8Array>>();
	const meta = new Map<string, { total: number; count: number }>();
	let live: string | null = null;
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
		// The confirm read compared THIS PARTITION's chunk-family keys, noticed the
		// mismatch, and reloaded from the build KV actually holds.
		expect(instanceFor("engine-wedged-p0").loaded).toEqual(raw[0] as Uint8Array);
		expect(await engine.cardCount()).toBe(7);
	});
});
