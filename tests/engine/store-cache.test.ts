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
	ensureCacheSchema,
	fillCache,
	isCached,
	pruneCache,
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
				if (q.startsWith("INSERT INTO archive_cache_meta")) {
					meta.set(b[0] as string, { total: b[1] as number, count: b[2] as number });
					self.writes += 1;
					return toArray([]);
				}
				if (q.startsWith("INSERT INTO archive_cache")) {
					const list = rows.get(b[0] as string) ?? [];
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

	test("prune keeping everything drops nothing", async () => {
		const store = fakeStorage();
		await fillCache(store, KEY, streamOf(ramp(1000), 500), 1000);
		expect(pruneCache(store, [KEY])).toEqual([]);
		expect(isCached(store, KEY, 1000)).toBe(true);
	});
});
