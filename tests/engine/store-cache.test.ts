// The local decompressed-archive cache.
//
// KV stays the source of truth, so the invariant these tests protect is one-directional: the cache
// may only ever be a faster way to get the SAME bytes. A cache that serves DIFFERENT bytes is worse
// than no cache at all — it would hand rkyv a plausible archive that `access_unchecked` reads as
// valid — and every fault below (partial fill, wrong length, missing row, stale key) is one that
// would do exactly that if it were allowed to read back.

import { describe, expect, test } from "bun:test";
import {
	type ArchiveCacheStorage,
	cachedArchiveStream,
	cachedBuiltAt,
	cachedLz4Stream,
	cachedNames,
	cacheWriter,
	compressedCacheKeys,
	dropCached,
	ensureCacheSchema,
	fillCache,
	isCached,
	isLz4Cached,
	lz4CacheKey,
	namesCacheKey,
	pruneCache,
	pruneCacheOlderThan,
	putNames,
} from "../../src/engine/store-cache";

/**
 * The smallest thing that behaves like the DO's SQLite for these five statements.
 *
 * Deliberately not a SQL engine: it recognises the module's own queries and nothing else, so a
 * query this fake does not know about fails loudly here rather than silently returning no rows —
 * which is how a cache bug would otherwise look like a cache miss and pass.
 */
function fakeStorage(): ArchiveCacheStorage & { rows: Map<string, ArrayBuffer[]>; writes: number } {
	const rows = new Map<string, ArrayBuffer[]>();
	const meta = new Map<string, { total: number; count: number }>();
	const self = {
		rows,
		writes: 0,
		sql: {
			exec(query: string, ...b: unknown[]) {
				const q = query.trim();
				const toArray = (out: Record<string, unknown>[]) => ({ toArray: () => out });
				if (q.startsWith("CREATE TABLE")) return toArray([]);
				if (q.startsWith("SELECT total_bytes")) {
					const m = meta.get(b[0] as string);
					return toArray(m ? [{ total_bytes: m.total, row_count: m.count }] : []);
				}
				if (q.startsWith("SELECT bytes")) {
					const list = rows.get(b[0] as string) ?? [];
					const one = list[b[1] as number];
					return toArray(one ? [{ bytes: one }] : []);
				}
				if (q.startsWith("SELECT archive_key")) {
					return toArray([...meta.keys()].map((archive_key) => ({ archive_key })));
				}
				if (q.startsWith("SELECT DISTINCT archive_key FROM archive_cache")) {
					return toArray([...rows.keys()].map((archive_key) => ({ archive_key })));
				}
				if (q.startsWith("INSERT INTO archive_cache_meta")) {
					meta.set(b[0] as string, { total: b[1] as number, count: b[2] as number });
					self.writes += 1;
					return toArray([]);
				}
				if (q.startsWith("INSERT INTO archive_cache")) {
					const list = rows.get(b[0] as string) ?? [];
					// PRIMARY KEY (archive_key, seq). Modelled, because it is not decoration: it is
					// what turns "two writers on one key" into a thrown error rather than a silently
					// interleaved archive, and a fake that overwrote instead would have let the
					// 2026-08-13 residue race pass its tests.
					if (list[b[1] as number] !== undefined) {
						throw new Error(`UNIQUE constraint failed: archive_cache.archive_key, archive_cache.seq`);
					}
					list[b[1] as number] = b[2] as ArrayBuffer;
					rows.set(b[0] as string, list);
					self.writes += 1;
					return toArray([]);
				}
				if (q.startsWith("DELETE FROM archive_cache_meta")) {
					meta.delete(b[0] as string);
					return toArray([]);
				}
				if (q.startsWith("DELETE FROM archive_cache")) {
					rows.delete(b[0] as string);
					return toArray([]);
				}
				throw new Error(`fake storage got an unrecognised query: ${q}`);
			},
		},
	} as unknown as ArchiveCacheStorage & { rows: Map<string, ArrayBuffer[]>; writes: number };
	return self;
}

function ramp(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 17 + (i >> 9)) & 0xff;
	return out;
}

function streamOf(source: Uint8Array, pieceSize: number): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= source.length) {
				controller.close();
				return;
			}
			controller.enqueue(source.subarray(at, at + pieceSize));
			at += pieceSize;
		},
	});
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const KEY = "card-store-v2026081104-1786533595.store";

describe("archive cache", () => {
	test("round-trips an archive byte for byte through 4KB source pieces", async () => {
		const store = fakeStorage();
		const source = ramp(5_000_000);
		ensureCacheSchema(store);
		const rowCount = await fillCache(store, KEY, streamOf(source, 4096), source.length);
		expect(rowCount).toBe(4); // 5,000,000 / 1,500,000 = 3 full rows + a tail
		const stream = cachedArchiveStream(store, KEY, source.length);
		expect(stream).not.toBeNull();
		expect(await drain(stream as ReadableStream<Uint8Array>)).toEqual(source);
	});

	test("groups 4KB pieces into few rows rather than one row each", async () => {
		const store = fakeStorage();
		const source = ramp(3_000_000);
		await fillCache(store, KEY, streamOf(source, 4096), source.length);
		// 733 source pieces; one row each would be a fifth of the daily write allowance per colo.
		expect(store.rows.get(KEY)?.length).toBe(2);
	});

	test("an uncached archive reads as a miss, not an empty stream", () => {
		const store = fakeStorage();
		ensureCacheSchema(store);
		expect(cachedArchiveStream(store, KEY, 100)).toBeNull();
		expect(isCached(store, KEY, 100)).toBe(false);
	});

	test("a fill that runs short leaves nothing readable", async () => {
		const store = fakeStorage();
		const source = ramp(1000);
		// The manifest says more bytes than the stream carries — a truncated KV read.
		expect(fillCache(store, KEY, streamOf(source, 256), 2000)).rejects.toThrow("did not match 2000 bytes");
		await Promise.resolve();
		expect(isCached(store, KEY, 2000)).toBe(false);
		expect(cachedArchiveStream(store, KEY, 2000)).toBeNull();
	});

	test("a cached copy is refused when the manifest's byte count has moved", async () => {
		const store = fakeStorage();
		const source = ramp(4000);
		await fillCache(store, KEY, streamOf(source, 1000), source.length);
		expect(isCached(store, KEY, 4000)).toBe(true);
		// Same key, different length: not the archive being asked for.
		expect(isCached(store, KEY, 4001)).toBe(false);
		expect(cachedArchiveStream(store, KEY, 4001)).toBeNull();
	});

	test("a row that vanishes under a complete copy errors the stream", async () => {
		const store = fakeStorage();
		const source = ramp(4_000_000);
		await fillCache(store, KEY, streamOf(source, 100_000), source.length);
		store.rows.get(KEY)?.splice(1, 1, undefined as unknown as ArrayBuffer);
		const stream = cachedArchiveStream(store, KEY, source.length) as ReadableStream<Uint8Array>;
		expect(drain(stream)).rejects.toThrow("missing row 1");
	});

	test("refilling the same key replaces rather than collides", async () => {
		const store = fakeStorage();
		const first = ramp(3000);
		await fillCache(store, KEY, streamOf(first, 500), first.length);
		const second = ramp(2000);
		await fillCache(store, KEY, streamOf(second, 500), second.length);
		const stream = cachedArchiveStream(store, KEY, second.length) as ReadableStream<Uint8Array>;
		expect(await drain(stream)).toEqual(second);
	});

	test("prune drops every archive but the ones named, and keeps their rows", async () => {
		const store = fakeStorage();
		const old = "card-store-v2026081104-1786000000.store";
		const compat = "card-compat-v2026081104-1786533595.store";
		for (const key of [old, KEY, compat]) await fillCache(store, key, streamOf(ramp(1000), 500), 1000);
		const dropped = pruneCache(store, [KEY, compat]);
		expect(dropped).toEqual([old]);
		expect(isCached(store, KEY, 1000)).toBe(true);
		expect(isCached(store, compat, 1000)).toBe(true);
		expect(isCached(store, old, 1000)).toBe(false);
		expect(store.rows.has(old)).toBe(false);
	});

	test("a second writer on a live key destroys the first — why residue fills are single-flighted", async () => {
		// The 500 of 2026-08-13, in miniature. The cold load pre-caches the residue under waitUntil
		// while the request that triggered it attaches that same residue; `isCached` reads false
		// until the pre-cache commits its meta row LAST, so the attach opened its own writer on the
		// same key. cacheWriter DELETEs the key on construction and then INSERTs by (archive_key,
		// seq) — so the two clobber each other, and the loser's commit fails. That surfaced as the
		// first /cards/* after every store change 500ing, nightly.
		//
		// store.ts fixes it upstream of here (residueFills), but this is the property that makes the
		// fix necessary, so it belongs in the layer that has it.
		const store = fakeStorage();
		const source = ramp(6_000_000); // BLOB_GROUP_BYTES is 1.5MB, so this is 4 rows
		const first = cacheWriter(store, KEY, source.length);
		first.write(source.subarray(0, 1_500_000)); // flushes seq 0
		expect((store.rows.get(KEY) ?? []).length).toBe(1);

		// A second writer for the same key, opened while the first is mid-flight. Construction
		// DELETEs the key, so the first writer's row is gone and its seq counter is now stale.
		const second = cacheWriter(store, KEY, source.length);
		expect(store.rows.get(KEY) ?? []).toEqual([]);

		second.write(source.subarray(0, 4_500_000)); // seq 0, 1, 2

		// The first, resuming, writes seq 1 — which the second already holds. This is the
		// production 500: the loser's insert violates the primary key.
		expect(() => first.write(source.subarray(1_500_000, 3_000_000))).toThrow("UNIQUE constraint failed");
	});

	test("dropCached invalidates one archive so a poisoned copy is not permanent", async () => {
		// The escape hatch the cache had no way to reach. A copy that is readable but WRONG — two
		// writers interleaving rows under one meta row — makes isCached answer yes forever, so every
		// attach feeds wasm the same bad archive and /cards/* stays down until the store key changes.
		// KV is the source of truth, so throwing the copy away is always safe.
		const store = fakeStorage();
		const other = "card-compat-v2026081104-1786533595.store";
		await fillCache(store, KEY, streamOf(ramp(1000), 500), 1000);
		await fillCache(store, other, streamOf(ramp(1000), 500), 1000);

		dropCached(store, KEY);
		expect(isCached(store, KEY, 1000)).toBe(false);
		expect(cachedArchiveStream(store, KEY, 1000)).toBeNull();
		expect(store.rows.has(KEY)).toBe(false);
		// Its neighbour is untouched: the store archive must survive dropping the residue.
		expect(isCached(store, other, 1000)).toBe(true);
	});

	test("dropping an archive that was never cached is a no-op", async () => {
		const store = fakeStorage();
		ensureCacheSchema(store);
		expect(() => dropCached(store, KEY)).not.toThrow();
		expect(isCached(store, KEY, 1000)).toBe(false);
	});

	test("a refill after dropCached produces a clean, readable copy", async () => {
		// The point of dropping: the next load repairs it from KV.
		const store = fakeStorage();
		const source = ramp(3000);
		await fillCache(store, KEY, streamOf(source, 500), source.length);
		dropCached(store, KEY);
		await fillCache(store, KEY, streamOf(source, 500), source.length);
		const stream = cachedArchiveStream(store, KEY, source.length) as ReadableStream<Uint8Array>;
		expect(await drain(stream)).toEqual(source);
	});

	test("prune keeping everything drops nothing", async () => {
		const store = fakeStorage();
		await fillCache(store, KEY, streamOf(ramp(1000), 500), 1000);
		expect(pruneCache(store, [KEY])).toEqual([]);
		expect(isCached(store, KEY, 1000)).toBe(true);
	});

	test("prune also drops rows no meta row names — a writer that died — unless the key is kept", () => {
		// The LZ4 encode is one writer spanning many rows; an isolate lost mid-encode leaves rows
		// without a meta row, which no reader accepts and no meta-driven prune ever found.
		const store = fakeStorage();
		const dead = cacheWriter(store, `${KEY}:lz4v1`, null);
		dead.write(ramp(2_000_000)); // one full row flushed, never committed
		const live = cacheWriter(store, "in-flight:lz4v1", null);
		live.write(ramp(1_600_000));
		expect(store.rows.has(`${KEY}:lz4v1`)).toBe(true);
		expect(pruneCache(store, ["in-flight:lz4v1"])).toEqual([`${KEY}:lz4v1`]);
		expect(store.rows.has(`${KEY}:lz4v1`)).toBe(false);
		expect(store.rows.has("in-flight:lz4v1")).toBe(true);
	});
});

describe("the LZ4 family (r3)", () => {
	test("a length-free writer commits what it was given, and refuses to commit nothing", async () => {
		const store = fakeStorage();
		const frames = ramp(3_100_000);
		const writer = cacheWriter(store, lz4CacheKey(KEY), null);
		writer.write(frames.subarray(0, 1_000_000));
		writer.write(frames.subarray(1_000_000));
		expect(isLz4Cached(store, KEY)).toBe(false); // meta last: not readable until commit
		expect(writer.commit()).toBe(3);
		expect(isLz4Cached(store, KEY)).toBe(true);
		expect(await drain(cachedLz4Stream(store, KEY) as ReadableStream<Uint8Array>)).toEqual(frames);

		const empty = cacheWriter(store, lz4CacheKey("other"), null);
		expect(empty.commit()).toBe(0);
		expect(isLz4Cached(store, "other")).toBe(false);
		expect(cachedLz4Stream(store, "other")).toBeNull();
	});

	test("its key is its own family, never one of the gzip chunk keys", () => {
		expect(lz4CacheKey(KEY)).toBe(`${KEY}:lz4v1`);
		expect(lz4CacheKey(KEY)).not.toMatch(/:gz:/);
	});
});

describe("drop, then fill (x1)", () => {
	const at = (builtAt: number, family: string) => `card-store-v7-${builtAt}-p3.store${family}`;

	test("a cache key names its build whatever family follows, and NaN when it names none", () => {
		expect(cachedBuiltAt(at(1790000000000, ":gz:0"))).toBe(1790000000000);
		expect(cachedBuiltAt(at(1790000000000, ":lz4v1"))).toBe(1790000000000);
		expect(cachedBuiltAt("card-store-v7-1790000000000.store")).toBe(1790000000000);
		expect(cachedBuiltAt("in-flight:lz4v1")).toBeNaN();
		expect(cachedBuiltAt("card-store-v7-notanumber-p3.store:gz:0")).toBeNaN();
	});

	test("drops every older build and every key that names none — but never a NEWER build", async () => {
		const store = fakeStorage();
		for (const key of [at(100, ":gz:0"), at(100, ":lz4v1"), at(200, ":gz:0"), at(300, ":gz:0"), "stray"]) {
			await fillCache(store, key, streamOf(ramp(10), 10), 10);
		}
		// Filling build 200: 100's two families and the stray go; 200 is kept; 300 — newer — survives.
		const dropped = pruneCacheOlderThan(store, [at(200, ":gz:0"), at(200, ":lz4v1")], 200);
		expect(dropped.sort()).toEqual([at(100, ":gz:0"), at(100, ":lz4v1"), "stray"].sort());
		expect([...store.rows.keys()].sort()).toEqual([at(200, ":gz:0"), at(300, ":gz:0")].sort());
	});

	test("the guard covers rows no meta row names, too — a newer fill still being written", () => {
		const store = fakeStorage();
		const older = cacheWriter(store, at(100, ":lz4v1"), null);
		older.write(ramp(2_000_000));
		const newer = cacheWriter(store, at(300, ":lz4v1"), null);
		newer.write(ramp(2_000_000));
		expect(pruneCacheOlderThan(store, [], 200)).toEqual([at(100, ":lz4v1")]);
		expect(store.rows.has(at(300, ":lz4v1"))).toBe(true);
	});

	test("an unparseable target falls back to the plain prune rather than keeping everything", async () => {
		const store = fakeStorage();
		await fillCache(store, at(300, ":gz:0"), streamOf(ramp(10), 10), 10);
		expect(pruneCacheOlderThan(store, [], "not-a-build")).toEqual([at(300, ":gz:0")]);
	});
});

// n8: the card-names blob rides beside its archive, under `<archiveKey>:names`, and every prune
// keeps it exactly when it keeps a family of that archive — so it is dropped with its build and
// never outlives it, and no keep-list had to learn about it.
describe("the card-names cache", () => {
	const OLD = "card-store-v7-1000-p3.store";
	const NEW = "card-store-v7-2000-p3.store";
	const blob = ramp(4096);

	test("round-trips whole, and a wrong length reads as a miss", () => {
		const storage = fakeStorage();
		ensureCacheSchema(storage);
		expect(cachedNames(storage, NEW, blob.byteLength)).toBeNull();
		putNames(storage, NEW, blob);
		expect(cachedNames(storage, NEW, blob.byteLength)).toEqual(blob);
		expect(cachedNames(storage, NEW, blob.byteLength + 1)).toBeNull();
		expect(cachedBuiltAt(namesCacheKey(NEW))).toBe(2000);
	});

	test("kept by every keep-list that keeps its archive — gzip, LZ4 or raw", () => {
		for (const keep of [compressedCacheKeys(NEW, 2), [lz4CacheKey(NEW)], [NEW]]) {
			const storage = fakeStorage();
			ensureCacheSchema(storage);
			putNames(storage, NEW, blob);
			pruneCacheOlderThan(storage, keep, 2000);
			pruneCache(storage, keep);
			expect(cachedNames(storage, NEW, blob.byteLength)).toEqual(blob);
		}
	});

	test("dropped with its build — drop, then fill", () => {
		const storage = fakeStorage();
		ensureCacheSchema(storage);
		putNames(storage, OLD, blob);
		const dropped = pruneCacheOlderThan(storage, [...compressedCacheKeys(NEW, 1), lz4CacheKey(NEW)], 2000);
		expect(dropped).toContain(namesCacheKey(OLD));
		expect(cachedNames(storage, OLD, blob.byteLength)).toBeNull();
	});

	test("a NEWER build's names survive a prune for an older one (the x1 guard)", () => {
		const storage = fakeStorage();
		ensureCacheSchema(storage);
		putNames(storage, NEW, blob);
		expect(pruneCacheOlderThan(storage, compressedCacheKeys(OLD, 1), 1000)).toEqual([]);
		expect(cachedNames(storage, NEW, blob.byteLength)).toEqual(blob);
	});

	test("another archive's names are not kept by a prefix that merely looks alike", () => {
		const storage = fakeStorage();
		ensureCacheSchema(storage);
		putNames(storage, "card-store-v7-2000-p1.store", blob);
		pruneCache(storage, compressedCacheKeys("card-store-v7-2000-p10.store", 1));
		expect(cachedNames(storage, "card-store-v7-2000-p1.store", blob.byteLength)).toBeNull();
	});
});
