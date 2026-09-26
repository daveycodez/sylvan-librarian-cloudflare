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
import * as cache from "../../src/engine/store-cache";
import {
	ARCHIVE_FORMAT_VERSION,
	chunkKey,
	formatManifestKey,
	gzipBytes,
	PARTITION_HASH_ALGO,
} from "../../src/engine/store-kv";
import type { Env, StoreManifest } from "../../src/engine/types";
import { EngineUnavailableError } from "../../src/engine/types";

/** The manifest this build's engine reads (x19): its own archive format's key. */
const MANIFEST_READ = formatManifestKey();

// ── The wasm fake: one instance per label, like the real shim ─────────────────

interface FakeInstance {
	staged: Uint8Array[];
	expected: number;
	loaded: Uint8Array | null;
	/** The shim's drop counter: a test bumps it to simulate an instance lost to a trap. */
	generation: number;
	/** n8: the card names load_names took, or null. */
	names?: string[] | null;
	/** n15: the loaded blob's format, and (format 2) each record's partition and collated name. */
	namesFormat?: number;
	records?: { partition: number; collated: string }[];
	/** x24: the printed-names lines load_printed_names took (partition, oracle, forms), or null. */
	printed?: { partition: number; oracle: string; forms: string[] }[] | null;
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

const FAKE_LZ4_BLOCK = 24;
const sum8 = (bytes: Uint8Array) => bytes.reduce((s, b) => (s + b) & 0xff, 0);
/** Every label that began an LZ4 load, in order — "did this load read the LZ4 family?" */
const lz4Loads: string[] = [];

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
		// The LZ4 cache (r3), as a toy frame format with the real one's properties: frames of up to
		// FAKE_LZ4_BLOCK raw bytes, each `[0x4c, len, sum8, ...bytes]`, arriving in any pieces; a
		// frame whose sum does not match is a refused load, like the real xxh32.
		begin_store_load_lz4(total: number) {
			inst.staged = [];
			inst.expected = total;
			lz4Loads.push(label);
		},
		store_load_lz4_chunk(chunk: Uint8Array) {
			inst.staged.push(chunk.slice());
		},
		finish_store_load_lz4() {
			const stream = Buffer.concat(inst.staged);
			const out: number[] = [];
			for (let at = 0; at < stream.length; ) {
				const len = stream[at + 1] as number;
				const body = stream.subarray(at + 3, at + 3 + len);
				if (stream[at] !== 0x4c || body.length !== len || sum8(body) !== stream[at + 2]) {
					throw new Error("fake wasm: corrupt LZ4 frame");
				}
				out.push(...body);
				at += 3 + len;
			}
			if (out.length !== inst.expected) throw new Error(`fake wasm: decoded ${out.length} of ${inst.expected} bytes`);
			inst.loaded = Uint8Array.from(out);
		},
		store_lz4_frame(index: number) {
			const bytes = inst.loaded;
			if (!bytes || index * FAKE_LZ4_BLOCK >= bytes.length) return new Uint8Array(0);
			const body = bytes.subarray(index * FAKE_LZ4_BLOCK, (index + 1) * FAKE_LZ4_BLOCK);
			return Uint8Array.from([0x4c, body.length, sum8(body), ...body]);
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
		// n8: the names blob as the real crate reads it — gzip, the header, then name lines — and a
		// toy ranking (printed names containing the prefix, in blob order). n15: format 2's records,
		// and a toy index — the partitions whose collated names contain a bare word's value.
		load_names(gz: Uint8Array) {
			const text = new TextDecoder().decode(gunzipSync(gz));
			const format = text.startsWith("sylvan-card-names/1\n") ? 1 : text.startsWith("sylvan-card-names/2\n") ? 2 : 0;
			if (format === 0) throw new Error("fake wasm: not a names blob");
			const lines = text.split("\n").slice(1, -1);
			inst.namesFormat = format;
			if (format === 1) {
				inst.names = lines.map((l) => l.slice(l.indexOf("\t") + 1));
				inst.records = [];
			} else {
				const fields = lines.map((l) => l.split("\t"));
				inst.names = fields.map((f) => f[3] as string);
				inst.records = fields.map((f) => ({ partition: Number(f[0]), collated: f[2] as string }));
			}
			return inst.names.length;
		},
		names_autocomplete(prefix: string, limit: number) {
			if (!inst.names) throw new Error("no card names loaded");
			return JSON.stringify(inst.names.filter((n) => n.toLowerCase().includes(prefix)).slice(0, limit));
		},
		names_heap_bytes: () => 0,
		names_format: () => (inst.names ? (inst.namesFormat ?? 0) : 0),
		names_search_partitions(treeJson: string) {
			if (inst.namesFormat !== 2) return "null";
			const tree = JSON.parse(treeJson) as { node_type: string; kwargs: { rhs?: { kwargs?: { value?: string } } } };
			const word = tree.node_type === "CardBinaryOperatorNode" ? tree.kwargs.rhs?.kwargs?.value : undefined;
			if (word === undefined) return "null";
			const partitions = [
				...new Set((inst.records ?? []).filter((r) => r.collated.includes(word)).map((r) => r.partition)),
			];
			return JSON.stringify({ partitions: partitions.sort((a, b) => a - b) });
		},
		names_fuzzy_plan(folded: string) {
			if (inst.namesFormat !== 2) return "null";
			const partitions = [
				...new Set((inst.records ?? []).filter((r) => r.collated === folded).map((r) => r.partition)),
			];
			// A toy plan: an exact name, else only the printed tier is undecided (`everywhere`).
			if (partitions.length === 0) return JSON.stringify({ partitions: [], everywhere: true, stage: "contained" });
			return JSON.stringify({ partitions, everywhere: false, stage: "exact" });
		},
		// x24: the printed-names blob as the real crate reads it, and a toy of its carriers test.
		load_printed_names(gz: Uint8Array) {
			const text = new TextDecoder().decode(gunzipSync(gz));
			if (!text.startsWith("sylvan-printed-names/1\n")) throw new Error("fake wasm: not a printed-names blob");
			inst.printed = text
				.split("\n")
				.slice(1, -1)
				.map((l) => {
					const [partition, oracle, ...forms] = l.split("\t");
					return { partition: Number(partition), oracle: oracle as string, forms };
				});
			return inst.printed.reduce((n, r) => n + r.forms.length, 0);
		},
		printed_names_heap_bytes: () => 0,
		printed_names_partitions(wordsJson: string) {
			if (!inst.printed) return "null";
			const words = JSON.parse(wordsJson) as string[];
			const partitions = inst.printed
				.filter((r) =>
					r.forms.some(
						(f) => words.some((w) => f.includes(w)) && words.every((w) => f.includes(w) || r.oracle.includes(w)),
					),
				)
				.map((r) => r.partition);
			return JSON.stringify({ partitions: [...new Set(partitions)].sort((a, b) => a - b) });
		},
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

/**
 * What a fake storage has held at its worst moment (x1): the most distinct BUILDS with cached rows
 * at once, and the most cached bytes. Updated on every row insert and delete.
 */
interface CacheMeter {
	peakBuilds: number;
	peakBytes: number;
	resetPeak(): void;
}
const meters = new WeakMap<ArchiveCacheStorage, CacheMeter>();
const meterOf = (storage: ArchiveCacheStorage) => meters.get(storage) as CacheMeter;

/** A minimal SQLite fake speaking exactly the statements store-cache issues. */
function fakeStorage(): ArchiveCacheStorage {
	const rows = new Map<string, Map<number, Uint8Array>>();
	const meta = new Map<string, { total: number; count: number }>();
	let live: string | null = null;
	let announced: string | null = null;
	const held = () => {
		const builds = new Set([...rows.keys()].map((k) => cache.cachedBuiltAt(k)));
		let bytes = 0;
		for (const list of rows.values()) for (const r of list.values()) bytes += r.length;
		return { builds: builds.size, bytes };
	};
	const meter: CacheMeter = {
		peakBuilds: 0,
		peakBytes: 0,
		resetPeak() {
			const now = held();
			meter.peakBuilds = now.builds;
			meter.peakBytes = now.bytes;
		},
	};
	const sample = () => {
		const now = held();
		meter.peakBuilds = Math.max(meter.peakBuilds, now.builds);
		meter.peakBytes = Math.max(meter.peakBytes, now.bytes);
	};
	const storage = {
		sql: {
			exec(query: string, ...b: unknown[]) {
				const result = execInner(query, ...b);
				if (/^\s*(INSERT|DELETE)/.test(query)) sample();
				return result;
			},
		},
	} as unknown as ArchiveCacheStorage;
	meters.set(storage, meter);
	return storage;
	function execInner(query: string, ...b: unknown[]) {
		{
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
			if (q.startsWith("SELECT DISTINCT archive_key FROM archive_cache")) {
				return out([...rows.keys()].map((archive_key) => ({ archive_key })));
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
		}
	}
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
		format_version: ARCHIVE_FORMAT_VERSION,
		store_bytes: (raw[0] as Uint8Array).length + (raw[1] as Uint8Array).length,
		store_gzip_bytes: (gz[0] as Uint8Array).length + (gz[1] as Uint8Array).length,
		chunk_count: 2,
		partition_count: 2,
		partition_hash: PARTITION_HASH_ALGO,
		partitions,
	};
	const entries = new Map<string, Uint8Array | string>();
	entries.set(MANIFEST_READ, JSON.stringify(manifest));
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
		entries.set(MANIFEST_READ, JSON.stringify({ ...manifest, partition_hash: "sha256/oracle_id/v9" }));
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
			MANIFEST_READ,
			JSON.stringify({
				store_key: "card-store-v1-104.store",
				built_at: "104",
				card_count: 1,
				printing_count: 1,
				upstream_commit: "abc",
				format_version: ARCHIVE_FORMAT_VERSION,
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
		entries.set(MANIFEST_READ, JSON.stringify(manifest));
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
		expect(reads.filter((k) => k === MANIFEST_READ).length).toBe(1);
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

describe("the LZ4 cache (r3)", () => {
	/** A publish whose manifest carries the pool gate's answer. */
	async function publishWith(builtAt: string, codec: "lz4" | "gzip" | undefined) {
		const pub = await publishV2(builtAt);
		if (codec) pub.manifest.cache = { v: 1, codec, projected_lz4_bytes: 1 };
		pub.entries.set(MANIFEST_READ, JSON.stringify(pub.manifest));
		return pub;
	}
	/** A load context whose background work the test can wait for — the fill runs after the load. */
	function waitingCtx(label: string, partition: number, storage: ArchiveCacheStorage) {
		const pending: Promise<unknown>[] = [];
		return {
			ctx: { ...ctxFor(label, partition, storage), waitUntil: (p: Promise<unknown>) => pending.push(p) },
			pending,
		};
	}
	const keyOf = (m: StoreManifest, k: number) => (m.partitions ?? [])[k]?.store_key as string;

	test("under an LZ4 codec a cold KV load tees no gzip, then caches LZ4 only; the next wake reads it", async () => {
		const { entries, manifest, raw } = await publishWith("140", "lz4");
		const storage = fakeStorage();
		const first = fakeEnv(entries);
		const a = waitingCtx("engine-lz4a-p0", 0, storage);
		await store.getEngine(first.env, a.ctx);
		await Promise.all(a.pending);
		const key = keyOf(manifest, 0);
		expect(cache.isLz4Cached(storage, key)).toBe(true);
		// Never both families of one archive: no gzip was tee'd on the way in.
		expect(cache.isCompressedCached(storage, key, 1, manifest.partitions?.[0]?.store_gzip_bytes as number)).toBe(false);

		const second = fakeEnv(entries);
		await store.getEngine(second.env, ctxFor("engine-lz4b-p0", 0, storage));
		expect(second.chunkReads().length).toBe(0);
		expect(lz4Loads).toContain("engine-lz4b-p0");
		expect(instanceFor("engine-lz4b-p0").loaded).toEqual(raw[0] as Uint8Array);
	});

	test("an absent or gzip codec caches gzip exactly as before and writes no LZ4", async () => {
		for (const [builtAt, codec] of [
			["141", undefined],
			["142", "gzip"],
		] as const) {
			const { entries, manifest } = await publishWith(builtAt, codec);
			const storage = fakeStorage();
			const w = waitingCtx(`engine-gz${builtAt}-p1`, 1, storage);
			await store.getEngine(fakeEnv(entries).env, w.ctx);
			await Promise.all(w.pending);
			const key = keyOf(manifest, 1);
			expect(cache.isLz4Cached(storage, key)).toBe(false);
			expect(cache.isCompressedCached(storage, key, 1, manifest.partitions?.[1]?.store_gzip_bytes as number)).toBe(
				true,
			);
		}
	});

	test("the publish swap converts the prefetched gzip to LZ4, dropping the gzip and the old build", async () => {
		const old = await publishWith("143", "lz4");
		const fresh = await publishWith("144", "lz4");
		const entries = new Map([...old.entries, ...fresh.entries]);
		const storage = fakeStorage();
		const w = waitingCtx("engine-lz4swap-p1", 1, storage);
		await store.getEngine(fakeEnv(old.entries).env, w.ctx);
		await Promise.all(w.pending);
		expect(cache.isLz4Cached(storage, keyOf(old.manifest, 1))).toBe(true);

		// Prepare holds the new build as gzip (nothing to encode from yet); commit swaps and converts.
		const env = fakeEnv(entries).env;
		expect(await store.prefetchStore(env, w.ctx, fresh.manifest)).toBe(true);
		expect(await store.swapToStore(env, w.ctx, fresh.manifest)).toBe(true);
		await Promise.all(w.pending);
		const key = keyOf(fresh.manifest, 1);
		expect(cache.isLz4Cached(storage, key)).toBe(true);
		expect(cache.isCompressedCached(storage, key, 1, fresh.manifest.partitions?.[1]?.store_gzip_bytes as number)).toBe(
			false,
		);
		expect(cache.isLz4Cached(storage, keyOf(old.manifest, 1))).toBe(false);
		expect(instanceFor("engine-lz4swap-p1").loaded).toEqual(fresh.raw[1] as Uint8Array);
	});

	test("a held LZ4 copy is read even after the gate turns LZ4 off", async () => {
		const on = await publishWith("145", "lz4");
		const storage = fakeStorage();
		const w = waitingCtx("engine-lz4on-p0", 0, storage);
		await store.getEngine(fakeEnv(on.entries).env, w.ctx);
		await Promise.all(w.pending);
		// The same build, re-announced with the codec off: the copy is not thrown away for a KV load.
		const off = new Map(on.entries);
		off.set(MANIFEST_READ, JSON.stringify({ ...on.manifest, cache: { v: 1, codec: "gzip", projected_lz4_bytes: 9 } }));
		const again = fakeEnv(off);
		await store.getEngine(again.env, ctxFor("engine-lz4off-p0", 0, storage));
		expect(again.chunkReads().length).toBe(0);
		expect(lz4Loads).toContain("engine-lz4off-p0");
	});

	test("a corrupt LZ4 copy fails its load, is dropped, and the next load reads KV", async () => {
		const { entries, manifest, raw } = await publishWith("146", "lz4");
		const storage = fakeStorage();
		const key = keyOf(manifest, 0);
		// A committed copy whose one frame fails its checksum: readable, and wrong.
		const writer = cache.cacheWriter(storage, cache.lz4CacheKey(key), null);
		writer.write(Uint8Array.from([0x4c, 3, 0, 1, 2, 3]));
		expect(writer.commit()).toBe(1);
		await expect(store.getEngine(fakeEnv(entries).env, ctxFor("engine-lz4bad-p0", 0, storage))).rejects.toThrow(
			/corrupt LZ4/,
		);
		expect(cache.isLz4Cached(storage, key)).toBe(false);
		const retry = fakeEnv(entries);
		await store.getEngine(retry.env, ctxFor("engine-lz4bad2-p0", 0, storage));
		expect(retry.chunkReads().length).toBe(1);
		expect(instanceFor("engine-lz4bad2-p0").loaded).toEqual(raw[0] as Uint8Array);
	});

	test("a cold object told of a new build drops the old build's cache (pruneToManifest)", async () => {
		const old = await publishWith("147", "lz4");
		const fresh = await publishWith("148", "lz4");
		const storage = fakeStorage();
		const w = waitingCtx("engine-lz4cold-p0", 0, storage);
		await store.getEngine(fakeEnv(old.entries).env, w.ctx);
		await Promise.all(w.pending);
		expect(store.pruneToManifest(w.ctx, fresh.manifest)).toBe(1);
		expect(cache.isLz4Cached(storage, keyOf(old.manifest, 0))).toBe(false);
		// Idempotent, and never touches what the new manifest names.
		expect(store.pruneToManifest(w.ctx, fresh.manifest)).toBe(0);
	});

	test("objects read an absent, unknown-version or unknown-codec block as gzip", () => {
		expect(cache.cacheCodecOf(undefined)).toBe("gzip");
		expect(cache.cacheCodecOf({})).toBe("gzip");
		expect(cache.cacheCodecOf({ cache: { v: 2, codec: "lz4" } })).toBe("gzip");
		expect(cache.cacheCodecOf({ cache: { v: 1, codec: "zstd" } })).toBe("gzip");
		expect(cache.cacheCodecOf({ cache: { v: 1, codec: "lz4" } })).toBe("lz4");
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

	test("a record of ANOTHER archive format is ignored, however new — KV's manifest of this format loads (x19)", async () => {
		// The previous build's coordinator pushed this record, and then a deploy reset the object
		// onto this build: its engine would refuse that store after fetching every byte of it.
		const live = await publishV2("134");
		const pushed = await publishV2("135");
		const entries = new Map(live.entries);
		for (const [key, value] of pushed.entries) if (key.startsWith("store:card-")) entries.set(key, value);
		const storage = fakeStorage();
		const cache = await import("../../src/engine/store-cache");
		cache.recordLiveManifest(storage, { ...pushed.manifest, format_version: ARCHIVE_FORMAT_VERSION - 1 });

		const { env, chunkReads } = fakeEnv(entries);
		await store.getEngine(env, ctxFor("engine-other-format-p0", 0, storage));
		expect(instanceFor("engine-other-format-p0").loaded).toEqual(live.raw[0] as Uint8Array);
		expect(chunkReads().every((k) => k.includes("-134-"))).toBe(true);
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

// ── Drop, then fill (backlog x1) ──────────────────────────────────────────────────
//
// An object's cache must never hold two builds at once. The pool gate multiplies ONE build per
// replica object; before x1 the publish prefetch and the cold-load tee both wrote the new build
// beside the old one and pruned after, and SQLite keeps that mark. These pin the order.
describe("drop, then fill (x1)", () => {
	async function publishAt(builtAt: string, codec: "gzip" | "lz4", size = 64) {
		const raw = [0, 1].map((k) => {
			const bytes = new Uint8Array(size);
			for (let i = 0; i < size; i++) bytes[i] = (i * 31 + k * 7 + Number(builtAt)) & 0xff;
			// A size that has to mean bytes on disk is incompressible, so gzip cannot hide a second build.
			if (size > 1024) {
				for (let at = 0; at < size; at += 65_536)
					crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65_536)));
			}
			bytes[0] = k === 0 ? 7 : 9;
			return bytes;
		});
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
			format_version: ARCHIVE_FORMAT_VERSION,
			store_bytes: raw.reduce((s, r) => s + r.length, 0),
			store_gzip_bytes: gz.reduce((s, g) => s + g.length, 0),
			chunk_count: 2,
			partition_count: 2,
			partition_hash: PARTITION_HASH_ALGO,
			partitions,
			cache: { v: 1, codec, projected_lz4_bytes: 1 },
		};
		const entries = new Map<string, Uint8Array | string>();
		entries.set(MANIFEST_READ, JSON.stringify(manifest));
		partitions.forEach((p, k) => {
			entries.set(chunkKey(p.store_key, 0), gz[k] as Uint8Array);
		});
		return { entries, manifest, raw };
	}
	function settlingCtx(label: string, storage: ArchiveCacheStorage) {
		const pending: Promise<unknown>[] = [];
		return {
			ctx: { ...ctxFor(label, 1, storage), waitUntil: (p: Promise<unknown>) => pending.push(p) },
			settle: async () => {
				while (pending.length) await pending.shift();
			},
		};
	}
	const merged = (...pubs: { entries: Map<string, Uint8Array | string> }[]) =>
		new Map(pubs.flatMap((p) => [...p.entries]));

	for (const codec of ["gzip", "lz4"] as const) {
		test(`a warm publish (${codec}) never holds two builds: the prefetch drops the old one first`, async () => {
			const old = await publishAt("400", codec);
			const fresh = await publishAt("401", codec);
			const storage = fakeStorage();
			const w = settlingCtx(`engine-x1warm${codec}-p1`, storage);
			await store.getEngine(fakeEnv(old.entries).env, w.ctx);
			await w.settle();
			meterOf(storage).resetPeak();
			expect(meterOf(storage).peakBuilds).toBe(1);

			const env = fakeEnv(merged(old, fresh)).env;
			expect(await store.prefetchStore(env, w.ctx, fresh.manifest)).toBe(true);
			expect(await store.swapToStore(env, w.ctx, fresh.manifest)).toBe(true);
			await w.settle();
			expect(meterOf(storage).peakBuilds).toBe(1);
			expect(instanceFor(`engine-x1warm${codec}-p1`).loaded).toEqual(fresh.raw[1] as Uint8Array);
			// And it ends holding the new build in the codec's family.
			const key = fresh.manifest.partitions?.[1]?.store_key as string;
			expect(
				codec === "lz4"
					? cache.isLz4Cached(storage, key)
					: cache.isCompressedCached(storage, key, 1, fresh.manifest.partitions?.[1]?.store_gzip_bytes as number),
			).toBe(true);
		});

		test(`a cold load (${codec}) of a build the object was never told of drops the old one before its tee`, async () => {
			const old = await publishAt("410", codec);
			const fresh = await publishAt("411", codec);
			const storage = fakeStorage();
			const w = settlingCtx(`engine-x1cold${codec}-p1`, storage);
			await store.getEngine(fakeEnv(old.entries).env, w.ctx);
			await w.settle();
			meterOf(storage).resetPeak();

			// Evicted, never prepared (a straggler): a fresh label on the same storage, KV names 411.
			const next = settlingCtx(`engine-x1cold${codec}b-p1`, storage);
			const kv = merged(old, fresh);
			kv.set(MANIFEST_READ, JSON.stringify(fresh.manifest));
			await store.getEngine(fakeEnv(kv).env, next.ctx);
			await next.settle();
			expect(meterOf(storage).peakBuilds).toBe(1);
			expect(instanceFor(`engine-x1cold${codec}b-p1`).loaded).toEqual(fresh.raw[1] as Uint8Array);
		});
	}

	test("a retried prepare costs nothing: no chunk is fetched and nothing is dropped", async () => {
		const old = await publishAt("420", "gzip");
		const fresh = await publishAt("421", "gzip");
		const storage = fakeStorage();
		const w = settlingCtx("engine-x1retry-p1", storage);
		await store.getEngine(fakeEnv(old.entries).env, w.ctx);
		const first = fakeEnv(merged(old, fresh));
		expect(await store.prefetchStore(first.env, w.ctx, fresh.manifest)).toBe(true);
		expect(first.chunkReads().length).toBe(1);
		const again = fakeEnv(merged(old, fresh));
		expect(await store.prefetchStore(again.env, w.ctx, fresh.manifest)).toBe(true);
		expect(again.chunkReads().length).toBe(0);
	});

	test("concurrent prefetches of one archive are single-flighted: one fetch, one answer", async () => {
		const old = await publishAt("430", "gzip");
		const fresh = await publishAt("431", "gzip");
		const storage = fakeStorage();
		const w = settlingCtx("engine-x1flight-p1", storage);
		await store.getEngine(fakeEnv(old.entries).env, w.ctx);
		const { env, chunkReads } = fakeEnv(merged(old, fresh));
		const answers = await Promise.all([
			store.prefetchStore(env, w.ctx, fresh.manifest),
			store.prefetchStore(env, w.ctx, fresh.manifest),
			store.prefetchStore(env, w.ctx, fresh.manifest),
		]);
		expect(answers).toEqual([true, true, true]);
		expect(chunkReads().length).toBe(1);
		expect(meterOf(storage).peakBuilds).toBe(1);
	});

	test("a NEWER build a prepare is holding survives a cold load of an older one", async () => {
		// Prepared for 441, then evicted; the wake read no record and KV's colo-cached manifest still
		// said 440. The drop before 440's tee must leave 441 alone — the next swap reads it.
		const old = await publishAt("440", "gzip");
		const fresh = await publishAt("441", "gzip");
		const storage = fakeStorage();
		const held = settlingCtx("engine-x1newer-p1", storage);
		expect(await store.prefetchStore(fakeEnv(fresh.entries).env, held.ctx, fresh.manifest)).toBe(true);
		const woke = settlingCtx("engine-x1newerb-p1", storage);
		await store.getEngine(fakeEnv(old.entries).env, woke.ctx);
		await woke.settle();
		const key = fresh.manifest.partitions?.[1]?.store_key as string;
		expect(cache.isCompressedCached(storage, key, 1, fresh.manifest.partitions?.[1]?.store_gzip_bytes as number)).toBe(
			true,
		);
	});

	test("a real SQLite file stays at ONE build across nightly publishes (pages the drop frees are reused)", async () => {
		// bun:sqlite without auto_vacuum keeps every freed page, so page_count x page_size is the file's
		// high-water mark — the quantity that stays billed (see the x1 commit's workerd measurement).
		const { MeteredStorage } = await import("../../scripts/import-harness/storage");
		const sqlite = new MeteredStorage();
		const storage = sqlite as unknown as ArchiveCacheStorage;
		const size = 400_000;
		let pub = await publishAt("450", "gzip", size);
		const w = settlingCtx("engine-x1file-p1", storage);
		await store.getEngine(fakeEnv(pub.entries).env, w.ctx);
		const oneBuild = pub.manifest.partitions?.[1]?.store_gzip_bytes as number;
		for (const next of ["451", "452", "453"]) {
			const fresh = await publishAt(next, "gzip", size);
			const env = fakeEnv(merged(pub, fresh)).env;
			await store.prefetchStore(env, w.ctx, fresh.manifest);
			await store.swapToStore(env, w.ctx, fresh.manifest);
			await w.settle();
			pub = fresh;
		}
		// Two builds would be ~800KB; one build plus the schema's pages is a little over 400KB.
		expect(sqlite.sql.databaseSize).toBeLessThan(oneBuild * 1.25 + 64 * 1024);
		expect(sqlite.sql.databaseSize).toBeGreaterThan(oneBuild);
	});
});

// ── A load that never finishes (2026-09-23 incident) ────────────────────────────
//
// One stalled read inside a load used to leave the label's single-flighted load pending forever,
// and every request to that object waited on it until a deploy replaced the isolate. The load now
// has a deadline; the abandoned load is fenced so a read that resumes later cannot write into the
// next load or become the store.
describe("a store load that stalls", () => {
	test("is abandoned at its deadline, the next request loads cleanly, and the stale load stays fenced", async () => {
		const { entries } = await publishV2("300");
		const { env } = fakeEnv(entries);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let stallNext = true;
		const kv = env.STORE_KV as unknown as { get: (key: string, opts?: { type?: string }) => Promise<unknown> };
		const realGet = kv.get.bind(kv);
		kv.get = async (key: string, opts?: { type?: string }) => {
			if (stallNext && key.startsWith("store:card-store-v1-300-p0.store:")) {
				stallNext = false;
				await gate;
			}
			return realGet(key, opts);
		};
		store.setLoadDeadlineForTests(50);
		try {
			const label = "engine-stall-p0";
			await expect(store.getEngine(env, ctxFor(label, 0))).rejects.toBeInstanceOf(store.StoreLoadStalledError);
			// No backoff after a stall: the very next request starts a fresh load, and it succeeds.
			const engine = await store.getEngine(env, ctxFor(label, 0));
			expect(await engine.cardCount()).toBe(7);
			// The abandoned load's read now resumes. Fenced: it must not replace the loaded store.
			release();
			await Bun.sleep(30);
			expect(store.tryGetLoadedEngine(label)).toBe(engine);
			expect(await engine.cardCount()).toBe(7);
		} finally {
			store.setLoadDeadlineForTests(20_000);
		}
	});
});

describe("every store load says what its isolate holds (the co-location gauge)", () => {
	const MB = 1048576;

	test("a fresh isolate's first load: load #1, itself alone, logged at info", () => {
		const clause = store.isolateClause(1, 0, [{ label: "engine-weur-p6", bytes: 45.6 * MB }]);
		expect(clause.text).toBe("isolate load #1, holds 1 engine(s), 45.6MB linear: engine-weur-p6 45.6MB");
		expect(clause.crowded).toBe(false);
	});

	test("two ~45MB partitions fit the 128MB isolate and are not flagged", () => {
		const clause = store.isolateClause(2, 31_400, [
			{ label: "engine-enam-p8", bytes: 44.4 * MB },
			{ label: "engine-enam-p9", bytes: 47.4 * MB },
		]);
		expect(clause.text).toBe(
			"isolate load #2 (first 31s ago), holds 2 engine(s), 91.8MB linear: engine-enam-p8 44.4MB, engine-enam-p9 47.4MB",
		);
		expect(clause.crowded).toBe(false);
	});

	test("a third partition in the isolate is flagged: three do not fit beside the JS heap", () => {
		const clause = store.isolateClause(3, 40_000, [
			{ label: "engine-enam-p7", bytes: 44.2 * MB },
			{ label: "engine-enam-p8", bytes: 44.4 * MB },
			{ label: "engine-enam-p9", bytes: 47.4 * MB },
		]);
		expect(clause.crowded).toBe(true);
		expect(clause.text).toContain("holds 3 engine(s), 136.0MB linear");
	});

	test("one oversized instance is flagged by bytes alone", () => {
		expect(store.isolateClause(1, 0, [{ label: "x", bytes: store.CROWDED_ISOLATE_BYTES }]).crowded).toBe(true);
	});
});

// ── n8: /cards/autocomplete from the card-names blob ──────────────────────────

describe("the card-names blob (n8)", () => {
	async function publishNamed(builtAt: string, names: string[]) {
		const published = await publishV2(builtAt);
		const lines = names.map((n) => `${n.toLowerCase().replace(/[^a-z0-9]/g, "")}\t${n}\n`).join("");
		const gz = await gzipBytes(new TextEncoder().encode(`sylvan-card-names/1\n${lines}`));
		const key = `store:card-names-v1-${builtAt}.store:0`;
		const manifest = { ...published.manifest, names_key: key, names_bytes: gz.byteLength };
		published.entries.set(key, gz);
		published.entries.set(MANIFEST_READ, JSON.stringify(manifest));
		return { ...published, manifest, key };
	}
	const archiveOf = (manifest: StoreManifest, k: number) => (manifest.partitions ?? [])[k]?.store_key ?? "";

	test("KV once per object per build: a wake reads the names from the object's own SQLite", async () => {
		const { entries, key, manifest } = await publishNamed("140", ["Lightning Bolt", "Lightning Helix", "Shock"]);
		const storage = fakeStorage();
		const { env, reads } = fakeEnv(entries);
		const ctx = ctxFor("engine-names-p1", 1, storage);
		const namesReads = () => reads.filter((k) => k === key).length;

		await store.getEngine(env, ctx);
		expect(await store.autocompleteFromNames(env, ctx, "light", 20)).toEqual(["Lightning Bolt", "Lightning Helix"]);
		expect(namesReads()).toBe(1);
		// Cached beside THIS object's archive, as KV holds it.
		expect(cache.cachedNames(storage, archiveOf(manifest, 1), manifest.names_bytes)).toEqual(
			entries.get(key) as Uint8Array,
		);

		// Warm: the instance answers; nothing is read again.
		expect(await store.autocompleteFromNames(env, ctx, "shock", 20)).toEqual(["Shock"]);
		expect(namesReads()).toBe(1);

		// A wake: the instance is gone (a fresh isolate, or a trap) and so are its names.
		const inst = instanceFor("engine-names-p1");
		inst.generation += 1;
		inst.loaded = null;
		inst.names = null;
		await store.getEngine(env, ctx);
		expect(await store.autocompleteFromNames(env, ctx, "bolt", 20)).toEqual(["Lightning Bolt"]);
		expect(namesReads()).toBe(1);
	});

	test("concurrent first calls share ONE load", async () => {
		const { entries, key } = await publishNamed("141", ["Shock", "Shocker"]);
		const storage = fakeStorage();
		const { env, reads } = fakeEnv(entries);
		const ctx = ctxFor("engine-names-once-p0", 0, storage);
		await store.getEngine(env, ctx);
		const answers = await Promise.all([
			store.autocompleteFromNames(env, ctx, "sho", 20),
			store.autocompleteFromNames(env, ctx, "shock", 1),
			store.autocompleteFromNames(env, ctx, "er", 20),
		]);
		expect(answers).toEqual([["Shock", "Shocker"], ["Shock"], ["Shocker"]]);
		expect(reads.filter((k) => k === key).length).toBe(1);
	});

	test("no blob named, or one gone or the wrong size, is refused — the router then fans out", async () => {
		const plain = await publishV2("142");
		const env = fakeEnv(plain.entries).env;
		const ctx = ctxFor("engine-names-none-p0", 0, fakeStorage());
		await store.getEngine(env, ctx);
		expect(store.autocompleteFromNames(env, ctx, "sho", 20)).rejects.toThrow(store.CardNamesUnavailableError);

		const gone = await publishNamed("143", ["Shock"]);
		gone.entries.delete(gone.key);
		const goneCtx = ctxFor("engine-names-gone-p0", 0, fakeStorage());
		const goneEnv = fakeEnv(gone.entries).env;
		await store.getEngine(goneEnv, goneCtx);
		expect(store.autocompleteFromNames(goneEnv, goneCtx, "sho", 20)).rejects.toThrow(/not in KV/);

		const short = await publishNamed("144", ["Shock"]);
		short.entries.set(short.key, (short.entries.get(short.key) as Uint8Array).subarray(1));
		const shortCtx = ctxFor("engine-names-short-p0", 0, fakeStorage());
		const shortEnv = fakeEnv(short.entries).env;
		await store.getEngine(shortEnv, shortCtx);
		expect(store.autocompleteFromNames(shortEnv, shortCtx, "sho", 20)).rejects.toThrow(/the manifest says/);
	});

	/** n15: a format-2 blob — one record per card, led by its partition. */
	async function publishIndexed(builtAt: string, cards: [number, string][]) {
		const published = await publishV2(builtAt);
		const lines = cards
			.map(([p, n]) => `${p}\t1f0\t${n.toLowerCase().replace(/[^a-z0-9]/g, "")}\t${n}\t\t\t\n`)
			.sort()
			.join("");
		const gz = await gzipBytes(new TextEncoder().encode(`sylvan-card-names/2\n${lines}`));
		const key = `store:card-names-v1-${builtAt}.store:0`;
		const manifest = { ...published.manifest, names_key: key, names_bytes: gz.byteLength };
		published.entries.set(key, gz);
		published.entries.set(MANIFEST_READ, JSON.stringify(manifest));
		return { ...published, manifest, key };
	}
	const bare = (value: string) =>
		JSON.stringify({
			node_type: "CardBinaryOperatorNode",
			kwargs: {
				op: ":",
				lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_name" } },
				rhs: { node_type: "CollatedNameValueNode", kwargs: { value } },
			},
		});
	const searchOpts = (value: string) => ({
		filterTreeJson: bare(value),
		unique: "card",
		prefer: "default",
		orderby: "name",
		direction: "auto",
		limit: 175,
		offset: 0,
		fields: [],
	});

	test("n15: the names index answers a name search for its OWN build only, and autocomplete reads format 2", async () => {
		const { entries, key } = await publishIndexed("160", [
			[0, "Lightning Bolt"],
			[2, "Lightning Helix"],
			[1, "Shock"],
		]);
		const { env, reads } = fakeEnv(entries);
		const ctx = ctxFor("engine-index-p1", 1, fakeStorage());
		await store.getEngine(env, ctx);
		expect(await store.namesSearchPartitions(env, ctx, searchOpts("lightning"), "160")).toEqual([0, 2]);
		expect(await store.namesSearchPartitions(env, ctx, searchOpts("zzz"), "160")).toEqual([]);
		// Another build's request: partition numbers mean nothing across builds.
		expect(await store.namesSearchPartitions(env, ctx, searchOpts("lightning"), "159")).toBeNull();
		// Not a question the index answers.
		expect(await store.namesSearchPartitions(env, ctx, { ...searchOpts("x"), filterTreeJson: "{}" }, "160")).toBeNull();
		expect(await store.autocompleteFromNames(env, ctx, "light", 20)).toEqual(["Lightning Bolt", "Lightning Helix"]);
		expect(reads.filter((k) => k === key).length).toBe(1);
		expect(await store.namesFuzzyPlan(env, ctx, "shock", ["shock"])).toEqual({
			partitions: [1],
			everywhere: false,
			stage: "exact",
			builtAt: "160",
		});
	});

	/** x24: a printed-names blob beside a format-2 names blob. */
	async function publishPrinted(builtAt: string, cards: [number, string][], printed: [number, string, string][]) {
		const indexed = await publishIndexed(builtAt, cards);
		const lines = printed
			.map(([p, oracle, form]) => `${p}\t${oracle}\t${form}\n`)
			.sort()
			.join("");
		const gz = await gzipBytes(new TextEncoder().encode(`sylvan-printed-names/1\n${lines}`));
		const printedKey = `store:card-printed-v1-${builtAt}.store:0`;
		const manifest = { ...indexed.manifest, printed_key: printedKey, printed_bytes: gz.byteLength };
		indexed.entries.set(printedKey, gz);
		indexed.entries.set(MANIFEST_READ, JSON.stringify(manifest));
		return { ...indexed, manifest, printedKey };
	}

	test("x24: a plan left everywhere is settled by the printed names — a miss asks none, a printed hit its holders", async () => {
		const { entries, printedKey } = await publishPrinted(
			"170",
			[
				[1, "Shock"],
				[3, "Unmoored Ego"],
			],
			[[3, "unmooredego", "egoaderiva"]],
		);
		const storage = fakeStorage();
		const { env, reads } = fakeEnv(entries);
		const ctx = ctxFor("engine-printed-p1", 1, storage);
		await store.getEngine(env, ctx);
		// An exact name never reaches the printed tier, and never reads the blob.
		expect(await store.namesFuzzyPlan(env, ctx, "shock", ["shock"])).toEqual({
			partitions: [1],
			everywhere: false,
			stage: "exact",
			builtAt: "170",
		});
		expect(reads.filter((k) => k === printedKey).length).toBe(0);
		// A sentence: nothing carries it — the 404, no partition asked.
		expect(await store.namesFuzzyPlan(env, ctx, "blue creatures", ["blue", "creatures"])).toEqual({
			partitions: [],
			everywhere: false,
			stage: "miss",
			builtAt: "170",
			printed: "miss",
		});
		// `red goad`: the Portuguese printed name in partition 3 carries `goad`, its oracle name `red`.
		expect(await store.namesFuzzyPlan(env, ctx, "red goad", ["red", "goad"])).toEqual({
			partitions: [3],
			everywhere: false,
			stage: "contained",
			builtAt: "170",
			printed: "hit",
		});
		// Read from KV once, and kept in the instance — never in the object's SQLite (the pool).
		expect(reads.filter((k) => k === printedKey).length).toBe(1);
		const cached = storage.sql.exec("SELECT archive_key FROM archive_cache_meta").toArray() as {
			archive_key: string;
		}[];
		expect(cached.some((r) => r.archive_key.includes("printed"))).toBe(false);
		// A wake loses the instance, and the next plan to need it reads KV again.
		const inst = instanceFor("engine-printed-p1");
		inst.generation += 1;
		inst.loaded = null;
		inst.names = null;
		inst.printed = null;
		await store.getEngine(env, ctx);
		expect((await store.namesFuzzyPlan(env, ctx, "littlebones", ["littlebones"])).printed).toBe("miss");
		expect(reads.filter((k) => k === printedKey).length).toBe(2);
	});

	test("x24: no printed blob, or one gone or the wrong size, leaves the plan everywhere, as before — and is not asked again", async () => {
		const none = await publishIndexed("171", [[1, "Shock"]]);
		const noneEnv = fakeEnv(none.entries).env;
		const noneCtx = ctxFor("engine-printed-none-p0", 0, fakeStorage());
		await store.getEngine(noneEnv, noneCtx);
		expect(await store.namesFuzzyPlan(noneEnv, noneCtx, "blue creatures", ["blue", "creatures"])).toEqual({
			partitions: [],
			everywhere: true,
			stage: "contained",
			builtAt: "171",
			printed: "absent",
		});

		const gone = await publishPrinted("172", [[1, "Shock"]], [[3, "unmooredego", "egoaderiva"]]);
		gone.entries.delete(gone.printedKey);
		const goneFake = fakeEnv(gone.entries);
		const goneCtx = ctxFor("engine-printed-gone-p0", 0, fakeStorage());
		await store.getEngine(goneFake.env, goneCtx);
		for (let i = 0; i < 2; i++) {
			expect((await store.namesFuzzyPlan(goneFake.env, goneCtx, "red goad", ["red", "goad"])).everywhere).toBe(true);
		}
		expect(goneFake.reads.filter((k) => k === gone.printedKey).length).toBe(1);

		const short = await publishPrinted("173", [[1, "Shock"]], [[3, "unmooredego", "egoaderiva"]]);
		short.entries.set(short.printedKey, (short.entries.get(short.printedKey) as Uint8Array).subarray(1));
		const shortEnv = fakeEnv(short.entries).env;
		const shortCtx = ctxFor("engine-printed-short-p0", 0, fakeStorage());
		await store.getEngine(shortEnv, shortCtx);
		const plan = await store.namesFuzzyPlan(shortEnv, shortCtx, "red goad", ["red", "goad"]);
		expect([plan.everywhere, plan.printed]).toEqual([true, "absent"]);
	});

	test("n15: a format-1 blob, or none, is no index — the gather and the fuzzy route ask every partition", async () => {
		const v1 = await publishNamed("161", ["Shock"]);
		const env = fakeEnv(v1.entries).env;
		const ctx = ctxFor("engine-index-v1-p0", 0, fakeStorage());
		await store.getEngine(env, ctx);
		expect(await store.namesSearchPartitions(env, ctx, searchOpts("shock"), "161")).toBeNull();
		expect(store.namesFuzzyPlan(env, ctx, "shock", ["shock"])).rejects.toThrow(store.CardNamesUnavailableError);
		expect(await store.autocompleteFromNames(env, ctx, "sho", 20)).toEqual(["Shock"]);

		const none = await publishV2("162");
		const noneEnv = fakeEnv(none.entries).env;
		const noneCtx = ctxFor("engine-index-none-p0", 0, fakeStorage());
		await store.getEngine(noneEnv, noneCtx);
		expect(await store.namesSearchPartitions(noneEnv, noneCtx, searchOpts("shock"), "162")).toBeNull();
	});

	test("the names go with their build: a new build's fill drops the old names first (x1)", async () => {
		const first = await publishNamed("150", ["Shock"]);
		const storage = fakeStorage();
		const ctx = ctxFor("engine-names-swap-p0", 0, storage);
		const firstEnv = fakeEnv(first.entries).env;
		await store.getEngine(firstEnv, ctx);
		await store.autocompleteFromNames(firstEnv, ctx, "sho", 20);
		expect(cache.cachedNames(storage, archiveOf(first.manifest, 0), first.manifest.names_bytes)).not.toBeNull();

		const second = await publishNamed("151", ["Shock", "Shockwave"]);
		const secondEnv = fakeEnv(second.entries).env;
		meterOf(storage).resetPeak();
		expect(await store.swapToStore(secondEnv, ctx, second.manifest)).toBe(true);
		// The swap's own drop took the old build's names with its archive.
		expect(cache.cachedNames(storage, archiveOf(first.manifest, 0), first.manifest.names_bytes)).toBeNull();
		// The new build answers from ITS names, and caches them beside its archive.
		expect(await store.autocompleteFromNames(secondEnv, ctx, "sho", 20)).toEqual(["Shock", "Shockwave"]);
		expect(cache.cachedNames(storage, archiveOf(second.manifest, 0), second.manifest.names_bytes)).not.toBeNull();
		expect(meterOf(storage).peakBuilds).toBe(1);
	});
});
