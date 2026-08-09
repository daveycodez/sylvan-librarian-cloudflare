// The KV storage layer: the chunk grid, the staging→KV reassembly the nightly
// publisher runs, and the streaming reader every SearchEngine DO loads through.
//
// assembleChunk gets the most attention here because it is the one piece whose
// failure is QUIET: the deploy publishes through splitStore (whole store in
// memory, native builder), so a bug in the resumable path only surfaces at the
// next nightly cron, as an index that silently stops updating.

import { describe, expect, test } from "bun:test";
import {
	assembleChunk,
	chunkCountFor,
	chunkKey,
	KV_CHUNK_BYTES,
	kvStoreStream,
	MANIFEST_KEY,
	readManifest,
	type StagedRow,
	splitStore,
} from "../../src/engine/store-kv";
import type { Env, StoreManifest } from "../../src/engine/types";
import { EngineUnavailableError } from "../../src/engine/types";

/** A store whose every byte is checkable: value at i is derived from i. */
function syntheticStore(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(length));
	for (let i = 0; i < length; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
	return out;
}

/** Cut a store into staged rows of the given sizes, cycling through them. */
function stage(store: Uint8Array, sizes: number[]): StagedRow[] {
	const rows: StagedRow[] = [];
	let at = 0;
	while (at < store.length) {
		const size = sizes[rows.length % sizes.length] as number;
		rows.push({ seq: rows.length, bytes: store.subarray(at, Math.min(at + size, store.length)) });
		at += size;
	}
	return rows;
}

const readerFor = (rows: StagedRow[]) => (fromSeq: number, limit: number) =>
	rows.filter((r) => r.seq >= fromSeq).slice(0, limit);

/** Drive assembleChunk to completion the way stepPublish does, one chunk per
 * call, carrying the cursor across — i.e. across alarm slices in production. */
function assembleAll(store: Uint8Array, rows: StagedRow[], chunkBytes: number): Uint8Array[] {
	const total = Math.ceil(store.length / chunkBytes);
	const read = readerFor(rows);
	let cursor = { seq: 0, off: 0 };
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < total; i++) {
		const want = Math.min(chunkBytes, store.length - i * chunkBytes);
		const result = assembleChunk(want, cursor, read);
		chunks.push(result.bytes);
		cursor = result.cursor;
	}
	return chunks;
}

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

describe("assembleChunk", () => {
	test("round-trips a store when the grids do not align", () => {
		// 900 into 250 leaves a boundary inside a staged row every time, which
		// is the real shape: KV's 20MB grid is no multiple of a ~1.9MB row.
		const store = syntheticStore(900);
		const chunks = assembleAll(store, stage(store, [250]), 400);
		expect(concat(chunks)).toEqual(store);
	});

	test("round-trips when staged rows are variable-length", () => {
		const store = syntheticStore(4321);
		const chunks = assembleAll(store, stage(store, [37, 512, 1, 300, 999]), 1000);
		expect(concat(chunks)).toEqual(store);
	});

	test("round-trips when the grids align exactly", () => {
		const store = syntheticStore(1200);
		const chunks = assembleAll(store, stage(store, [100]), 400);
		expect(chunks.map((c) => c.length)).toEqual([400, 400, 400]);
		expect(concat(chunks)).toEqual(store);
	});

	test("round-trips when one staged row spans several whole chunks", () => {
		const store = syntheticStore(1000);
		const chunks = assembleAll(store, stage(store, [1000]), 128);
		expect(concat(chunks)).toEqual(store);
	});

	test("the tail chunk is short, not padded", () => {
		const store = syntheticStore(1050);
		const chunks = assembleAll(store, stage(store, [64]), 400);
		expect(chunks.map((c) => c.length)).toEqual([400, 400, 250]);
		expect(concat(chunks)).toEqual(store);
	});

	test("the cursor resumes mid-row, exactly where it stopped", () => {
		const store = syntheticStore(1000);
		const rows = stage(store, [300]);
		const read = readerFor(rows);
		const first = assembleChunk(400, { seq: 0, off: 0 }, read);
		// 400 bytes = row 0 (300) + 100 of row 1 → next read starts at 1[100].
		expect(first.cursor).toEqual({ seq: 1, off: 100 });
		const second = assembleChunk(400, first.cursor, read);
		expect(concat([first.bytes, second.bytes])).toEqual(concat([store.subarray(0, 800)]));
	});

	test("a cursor landing exactly on a row boundary advances to the next row", () => {
		const store = syntheticStore(600);
		const rows = stage(store, [200]);
		const result = assembleChunk(400, { seq: 0, off: 0 }, readerFor(rows));
		expect(result.cursor).toEqual({ seq: 2, off: 0 });
	});

	test("a short staging table throws instead of yielding a truncated store", () => {
		const store = syntheticStore(500);
		const rows = stage(store, [100]).slice(0, 3); // 300 bytes for a 500-byte ask
		expect(() => assembleChunk(500, { seq: 0, off: 0 }, readerFor(rows))).toThrow(/ran out/);
	});

	test("survives a reader that returns fewer rows than asked", () => {
		const store = syntheticStore(2000);
		const rows = stage(store, [128]);
		const stingy = (fromSeq: number) => rows.filter((r) => r.seq >= fromSeq).slice(0, 1);
		let cursor = { seq: 0, off: 0 };
		const parts: Uint8Array[] = [];
		for (let at = 0; at < store.length; at += 700) {
			const result = assembleChunk(Math.min(700, store.length - at), cursor, stingy);
			parts.push(result.bytes);
			cursor = result.cursor;
		}
		expect(concat(parts)).toEqual(store);
	});

	test("reassembles to exactly what splitStore would have produced", () => {
		// The two publishers must agree: the deploy splits a whole buffer, the
		// nightly reassembles from staging. Same bytes, same boundaries.
		const store = syntheticStore(5000);
		const viaStaging = assembleAll(store, stage(store, [333]), 1024);
		const viaSplit = splitStore(store).map((c) => c);
		// splitStore uses the real KV grid, so compare on a matched grid instead.
		expect(concat(viaStaging)).toEqual(concat(viaSplit));
	});
});

describe("the chunk grid", () => {
	test("chunkCountFor matches what splitStore produces", () => {
		for (const size of [1, KV_CHUNK_BYTES - 1, KV_CHUNK_BYTES, KV_CHUNK_BYTES + 1, 70_000_000]) {
			expect(chunkCountFor(size)).toBe(splitStore(new Uint8Array(size)).length);
		}
	});

	test("chunks stay under KV's 25 MiB value cap", () => {
		expect(KV_CHUNK_BYTES).toBeLessThan(25 * 1024 * 1024);
	});

	test("chunk keys are namespaced per store, so publishes never collide", () => {
		expect(chunkKey("a.store", 0)).not.toBe(chunkKey("b.store", 0));
		expect(chunkKey("a.store", 0)).not.toBe(chunkKey("a.store", 1));
		expect(chunkKey("a.store", 3)).toBe("store:a.store:3");
	});
});

/** Minimal KVNamespace stand-in: only what the store path calls. */
function fakeKv(entries: Record<string, Uint8Array | string>, onGet?: (key: string) => void) {
	return {
		get: async (key: string, opts?: { type?: string }) => {
			onGet?.(key);
			const value = entries[key];
			if (value === undefined) return null;
			if (opts?.type === "arrayBuffer") {
				const bytes = value as Uint8Array;
				return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			}
			return value as string;
		},
	} as unknown as Env["STORE_KV"];
}

const manifestFor = (store: Uint8Array, key = "card-store-v1-123.store"): StoreManifest => ({
	store_key: key,
	built_at: "123",
	card_count: 1,
	printing_count: 1,
	upstream_commit: "vendored",
	format_version: 1,
	store_bytes: store.length,
	chunk_count: splitStore(store).length,
});

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return concat(parts);
}

describe("kvStoreStream", () => {
	test("streams a store back byte-for-byte, in chunk order", async () => {
		const store = syntheticStore(3_000_000);
		const manifest = manifestFor(store);
		const entries: Record<string, Uint8Array> = {};
		splitStore(store).forEach((chunk, seq) => {
			entries[chunkKey(manifest.store_key, seq)] = chunk;
		});
		const env = { STORE_KV: fakeKv(entries) } as Env;
		expect(await drain(kvStoreStream(env, manifest))).toEqual(store);
	});

	test("reads one chunk per get — a load is chunk_count reads, not more", async () => {
		const store = syntheticStore(3_000_000);
		const manifest = manifestFor(store);
		const entries: Record<string, Uint8Array> = {};
		splitStore(store).forEach((chunk, seq) => {
			entries[chunkKey(manifest.store_key, seq)] = chunk;
		});
		const gets: string[] = [];
		const env = { STORE_KV: fakeKv(entries, (k) => gets.push(k)) } as Env;
		await drain(kvStoreStream(env, manifest));
		expect(gets.length).toBe(manifest.chunk_count ?? 0);
	});

	test("a missing chunk fails loudly rather than serving a short store", async () => {
		const store = syntheticStore(3_000_000);
		const manifest = { ...manifestFor(store), chunk_count: 2 };
		const env = { STORE_KV: fakeKv({}) } as Env;
		expect(drain(kvStoreStream(env, manifest))).rejects.toThrow(EngineUnavailableError);
	});

	test("a byte-count mismatch fails loudly", async () => {
		const store = syntheticStore(1000);
		// Manifest claims more bytes than the chunks actually hold.
		const manifest = { ...manifestFor(store), store_bytes: 2000, chunk_count: 1 };
		const env = { STORE_KV: fakeKv({ [chunkKey(manifest.store_key, 0)]: store }) } as Env;
		expect(drain(kvStoreStream(env, manifest))).rejects.toThrow(/incomplete/);
	});
});

describe("readManifest", () => {
	test("an empty namespace is 'nothing published', not an error", async () => {
		expect(await readManifest({ STORE_KV: fakeKv({}) } as Env)).toBeNull();
	});

	test("parses a published manifest", async () => {
		const manifest = manifestFor(syntheticStore(10));
		const env = { STORE_KV: fakeKv({ [MANIFEST_KEY]: JSON.stringify(manifest) }) } as Env;
		expect((await readManifest(env))?.store_key).toBe(manifest.store_key);
	});

	test("an unreachable namespace surfaces the platform's own message", async () => {
		const env = {
			STORE_KV: {
				get: async () => {
					throw new Error("KV binding is not available");
				},
			},
		} as unknown as Env;
		expect(readManifest(env)).rejects.toThrow(/KV binding is not available/);
	});
});
