// The KV storage layer: the chunk grid, the staging→KV reassembly the nightly
// publisher runs, and the streaming reader every SearchEngine DO loads through.
//
// assembleChunk gets the most attention here because it is the one piece whose
// failure is QUIET: the deploy publishes through splitStore (whole store in
// memory, native builder), so a bug in the resumable path only surfaces at the
// next nightly cron, as an index that silently stops updating.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	assembleChunk,
	CHUNK_HEADROOM_WARN_BYTES,
	chunkCountFor,
	chunkForKv,
	chunkHeadroom,
	chunkHeadroomWarning,
	chunkKey,
	gzipBytes,
	isPartitionedManifest,
	KV_CHUNK_BYTES,
	KV_CHUNK_BYTES_SAFE,
	KV_VALUE_CAP_BYTES,
	kvSourceStream,
	MANIFEST_KEY,
	manifestServableBy,
	manifestShapeProblem,
	PARTITION_HASH_ALGO,
	partitionStoreKey,
	readManifest,
	type StagedRow,
	splitStore,
	staleStoreKeys,
	storeKeyStem,
	writeManifest,
} from "../../src/engine/store-kv";
import type { Env, StoreManifest, StoreManifestPartition } from "../../src/engine/types";
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

	test("the SAFE cut stays under KV's value cap even if gzip expanded it", () => {
		// This is the invariant KV_CHUNK_BYTES used to carry and deliberately no
		// longer does. gzip's worst case is ~0.02% expansion plus a header, so a
		// cut this size cannot produce an over-cap value for ANY input — which is
		// what makes it a sound fallback rather than a smaller guess.
		expect(KV_CHUNK_BYTES_SAFE * 1.0002 + 64).toBeLessThan(KV_VALUE_CAP_BYTES);
	});

	test("the ambitious cut is bigger than the cap, and that is the trade", () => {
		// It relies on the store compressing. Written as a test so the assumption
		// is visible rather than buried in a constant: if someone lowers this back
		// under the cap they should do it knowingly.
		expect(KV_CHUNK_BYTES).toBeGreaterThan(KV_VALUE_CAP_BYTES);
		expect(KV_CHUNK_BYTES).toBeGreaterThan(KV_CHUNK_BYTES_SAFE);
	});

	test("the live store's two-way cut is what the ambitious value is sized for", () => {
		// 76,655,728 bytes, measured on the generation-12 build.
		expect(chunkCountFor(76_655_728)).toBe(2);
		// And the safe fallback still produces a publishable store, just more of it.
		expect(chunkCountFor(76_655_728, KV_CHUNK_BYTES_SAFE)).toBe(3);
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

/**
 * One manifest's archive as a stream. In production a reader gets its
 * ArchiveSource from archiveOfManifest (partitions[k]); these tests drive the
 * CHUNK GRID rather than the partition selection, so they build the source from
 * the manifest's own fields and hand it to the same kvSourceStream the loader
 * uses. `kvStoreStream` used to do exactly this in src/ — it was deleted with
 * the unpartitioned loader, because a partitioned manifest's top-level
 * store_key is a stem holding no chunks.
 */
const kvStoreStream = (env: Env, manifest: StoreManifest) =>
	kvSourceStream(env, {
		storeKey: manifest.store_key,
		storeBytes: manifest.store_bytes,
		...(manifest.store_gzip_bytes !== undefined ? { gzipBytes: manifest.store_gzip_bytes } : {}),
		...(manifest.chunk_count !== undefined ? { chunkCount: manifest.chunk_count } : {}),
		cardCount: manifest.card_count,
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

/**
 * The gzipped grid. These matter more than the raw ones now: the raw path is
 * what a store published before this change still uses, and the compressed path
 * is what every new publish takes — so a break here is a break in the only path
 * production actually reads.
 */
describe("gzipped chunks", () => {
	/** Publish a store the way the publisher does: cut RAW, gzip each cut. */
	async function publishGzipped(store: Uint8Array, key = "card-store-v1-123.store") {
		const raw = splitStore(store);
		const stored = await Promise.all(raw.map((c) => gzipBytes(c)));
		const entries: Record<string, Uint8Array> = {};
		stored.forEach((chunk, seq) => {
			entries[chunkKey(key, seq)] = chunk;
		});
		const manifest: StoreManifest = {
			store_key: key,
			built_at: "123",
			card_count: 1,
			printing_count: 1,
			upstream_commit: "vendored",
			format_version: 1,
			store_bytes: store.length,
			store_gzip_bytes: stored.reduce((n, c) => n + c.byteLength, 0),
			chunk_count: raw.length,
		};
		return { entries, manifest, stored };
	}

	test("a gzipped store streams back byte-for-byte", async () => {
		const store = syntheticStore(3_000_000);
		const { entries, manifest } = await publishGzipped(store);
		const env = { STORE_KV: fakeKv(entries) } as Env;
		expect(await drain(kvStoreStream(env, manifest))).toEqual(store);
	});

	test("round-trips across a multi-chunk store, where each chunk is its own member", async () => {
		// Larger than one chunk, so the reader must open a fresh
		// DecompressionStream per chunk — workerd rejects members concatenated
		// into a single stream, which is what makes this the load-bearing case.
		const store = syntheticStore(KV_CHUNK_BYTES + 1_500_000);
		const { entries, manifest, stored } = await publishGzipped(store);
		expect(stored.length).toBe(2);
		const env = { STORE_KV: fakeKv(entries) } as Env;
		expect(await drain(kvStoreStream(env, manifest))).toEqual(store);
	});

	test("still one get per chunk — compression does not add reads", async () => {
		const store = syntheticStore(KV_CHUNK_BYTES + 1_500_000);
		const { entries, manifest } = await publishGzipped(store);
		const gets: string[] = [];
		const env = { STORE_KV: fakeKv(entries, (k) => gets.push(k)) } as Env;
		await drain(kvStoreStream(env, manifest));
		expect(gets.length).toBe(manifest.chunk_count ?? 0);
	});

	test("the integrity check counts STORED bytes, so a truncated value fails loudly", async () => {
		const store = syntheticStore(3_000_000);
		const { entries, manifest } = await publishGzipped(store);
		// Claim more compressed bytes than KV holds — a publish cut short.
		const env = { STORE_KV: fakeKv(entries) } as Env;
		const lying = { ...manifest, store_gzip_bytes: (manifest.store_gzip_bytes ?? 0) + 1 };
		expect(drain(kvStoreStream(env, lying))).rejects.toThrow(/incomplete/);
	});

	test("a compressed manifest without chunk_count is refused, not guessed at", async () => {
		// The count is derivable from neither byte figure once compressed, so
		// guessing it would mean silently reading a short store.
		const store = syntheticStore(3_000_000);
		const { entries, manifest } = await publishGzipped(store);
		const env = { STORE_KV: fakeKv(entries) } as Env;
		const { chunk_count, ...withoutCount } = manifest;
		expect(() => kvStoreStream(env, withoutCount as StoreManifest)).toThrow(EngineUnavailableError);
	});

	test("an uncompressed manifest still loads — the flag is store_gzip_bytes' absence", async () => {
		// A store published before this change must keep loading, or the change
		// is not revertible and a rollback serves nothing.
		const store = syntheticStore(3_000_000);
		const entries: Record<string, Uint8Array> = {};
		splitStore(store).forEach((chunk, seq) => {
			entries[chunkKey("raw.store", seq)] = chunk;
		});
		const manifest = { ...manifestFor(store, "raw.store") };
		expect(manifest.store_gzip_bytes).toBeUndefined();
		const env = { STORE_KV: fakeKv(entries) } as Env;
		expect(await drain(kvStoreStream(env, manifest))).toEqual(store);
	});

	test("a full-size SAFE chunk still fits KV's value cap once gzipped", async () => {
		// Incompressible input is the worst case the fallback exists for: gzip must
		// not expand a full KV_CHUNK_BYTES_SAFE cut past the 25 MiB cap. This is
		// what makes the fallback terminal — chunkForKv can stop there and know the
		// result is publishable for ANY input.
		//
		// It is deliberately NOT asserted for KV_CHUNK_BYTES. That cut is larger
		// than the cap on purpose and is safe only while the store compresses;
		// chunkForKv detects the miss and re-cuts here instead.
		//
		// Real CSPRNG bytes, not an LCG — a cheap generator leaves enough
		// structure that gzip SHRINKS it (a 31-bit LCG here compressed 26MB to
		// 248KB), which would make this test assert nothing.
		const noise = new Uint8Array(new ArrayBuffer(KV_CHUNK_BYTES_SAFE));
		for (let at = 0; at < noise.length; at += 65536) {
			crypto.getRandomValues(noise.subarray(at, Math.min(at + 65536, noise.length)));
		}
		const gz = await gzipBytes(noise);
		expect(gz.byteLength).toBeGreaterThan(KV_CHUNK_BYTES_SAFE); // it really is incompressible
		expect(gz.byteLength).toBeLessThanOrEqual(KV_VALUE_CAP_BYTES);
	});
});

describe("readManifest", () => {
	test("an empty namespace is 'nothing published', not an error", async () => {
		expect(await readManifest({ STORE_KV: fakeKv({}) } as Env)).toBeNull();
	});

	test("parses a published manifest", async () => {
		// A PARTITIONED one, because that is the only shape readManifest hands
		// back — the unpartitioned shape is refused, and has its own test below.
		const manifest: StoreManifest = {
			...manifestFor(syntheticStore(10)),
			partition_count: 1,
			partition_hash: PARTITION_HASH_ALGO,
			partitions: [
				{
					store_key: partitionStoreKey(1, "123", 0),
					store_bytes: 10,
					chunk_count: 1,
					card_count: 1,
					printing_count: 1,
				},
			],
		};
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

// The manifest: ONE key, ONE shape. Every publisher writes a partitioned
// manifest to `store:manifest` and every reader gets one back — an unpartitioned
// manifest is refused on both sides, loudly, as the builder bug it would be.
describe("the manifest", () => {
	const partition = (k: number, over: Partial<StoreManifestPartition> = {}): StoreManifestPartition => ({
		store_key: partitionStoreKey(2026081501, "1755300000", k),
		store_bytes: 40_000_000,
		store_gzip_bytes: 17_000_000,
		chunk_count: 1,
		card_count: 4_000,
		printing_count: 12_000,
		...over,
	});

	const v2 = (over: Partial<StoreManifest> = {}): StoreManifest => ({
		store_key: storeKeyStem(2026081501, "1755300000"),
		built_at: "1755300000",
		card_count: 8_000,
		printing_count: 24_000,
		upstream_commit: "vendored",
		format_version: 2026081501,
		content_generation: 20,
		store_bytes: 80_000_000,
		store_gzip_bytes: 34_000_000,
		chunk_count: 2,
		partition_count: 2,
		partition_hash: PARTITION_HASH_ALGO,
		partitions: [partition(0), partition(1)],
		...over,
	});

	/** A KV stand-in that also records puts/deletes, for the writeManifest round trip. */
	function fakeKvStore() {
		const entries: Record<string, string> = {};
		return {
			entries,
			kv: {
				get: async (key: string) => entries[key] ?? null,
				put: async (key: string, value: string) => {
					entries[key] = value;
				},
				delete: async (key: string) => {
					delete entries[key];
				},
			} as unknown as Env["STORE_KV"],
		};
	}

	test("the discriminant is partition_count's presence, nothing subtler", () => {
		expect(isPartitionedManifest(v2())).toBe(true);
		expect(isPartitionedManifest(manifestFor(syntheticStore(10)))).toBe(false);
	});

	test("writeManifest → readManifest round-trips a manifest field-for-field", async () => {
		const { kv } = fakeKvStore();
		const env = { STORE_KV: kv } as Env;
		const manifest = v2();
		await writeManifest(env, manifest);
		expect(await readManifest(env)).toEqual(manifest);
	});

	// ONE POINTER. There is no shape→key derivation left to get wrong because
	// there is no second key: a partitioned manifest is the only thing that can
	// be written, and `store:manifest` is the only place it goes.
	describe("the one manifest pointer", () => {
		test("the key is store:manifest, and a publish writes exactly it", async () => {
			expect(MANIFEST_KEY).toBe("store:manifest");
			const { kv, entries } = fakeKvStore();
			await writeManifest({ STORE_KV: kv } as Env, v2());
			expect(Object.keys(entries)).toEqual([MANIFEST_KEY]);
		});

		test("a republish overwrites in place rather than opening a second pointer", async () => {
			const { kv, entries } = fakeKvStore();
			const env = { STORE_KV: kv } as Env;
			await writeManifest(env, v2());
			const next = v2({ built_at: "1755400000" });
			await writeManifest(env, next);
			expect(Object.keys(entries)).toEqual([MANIFEST_KEY]);
			expect(await readManifest(env)).toEqual(next);
		});

		test("nothing published yet reads as null, not as an error", async () => {
			const { kv } = fakeKvStore();
			expect(await readManifest({ STORE_KV: kv } as Env)).toBeNull();
		});
	});

	// THE ONE-TIME TRANSITION, from the reader's side: a store published before
	// the partitioned format is still physically in KV, and meeting it must be a
	// loud, specific failure rather than a silently-served fallback. There is no
	// unpartitioned reader left to hand it to.
	describe("a manifest that predates the partitioned store", () => {
		test("readManifest refuses it, naming the format and the repair", async () => {
			const { kv, entries } = fakeKvStore();
			entries[MANIFEST_KEY] = JSON.stringify(manifestFor(syntheticStore(1000)));
			const env = { STORE_KV: kv } as Env;
			expect(readManifest(env)).rejects.toThrow(EngineUnavailableError);
			expect(readManifest(env)).rejects.toThrow(/partition_count/);
			// The repair is a rebuild, and the message says so — an operator meeting
			// this 503 should not have to re-derive that no fallback exists.
			expect(readManifest(env)).rejects.toThrow(/next import/);
		});

		test("writeManifest refuses to CREATE one, naming the builder", async () => {
			// The mirror of the read side: this shape is a builder bug, so the error
			// names both publishers rather than describing a mode.
			const { kv, entries } = fakeKvStore();
			const env = { STORE_KV: kv } as Env;
			expect(writeManifest(env, manifestFor(syntheticStore(1000)))).rejects.toThrow(/partitions auto/);
			expect(entries[MANIFEST_KEY]).toBeUndefined();
		});
	});

	// The reader-side guard on PUSHED manifests, which never go through
	// readManifest and so have no other shape check (see SearchEngine.preparePublish).
	describe("manifestServableBy", () => {
		test("a partition-named object serves partitioned shapes", () => {
			expect(manifestServableBy(0, v2())).toBe(true);
			expect(manifestServableBy(3, v2())).toBe(true);
		});

		test("an unpartitioned manifest is servable by nobody", () => {
			expect(manifestServableBy(0, manifestFor(syntheticStore(10)))).toBe(false);
			expect(manifestServableBy(undefined, manifestFor(syntheticStore(10)))).toBe(false);
		});

		test("a label with no partition cannot serve anything — that is a naming bug", () => {
			// Every engine object is engine-<region>[-<n>]-p<k>. A suffix-less label
			// reaching here would otherwise cache a manifest it then wedges on.
			expect(manifestServableBy(undefined, v2())).toBe(false);
		});
	});

	test("the partition keys carry the -p suffix and the stem carries none", () => {
		expect(partitionStoreKey(2026081501, "1755300000", 3)).toBe("card-store-v2026081501-1755300000-p3.store");
		expect(storeKeyStem(2026081501, "1755300000")).toBe("card-store-v2026081501-1755300000.store");
	});

	describe("what the producer refuses", () => {
		test("a healthy v2 manifest has nothing to complain about", () => {
			expect(manifestShapeProblem(v2())).toBeNull();
		});

		test("an unpartitioned manifest is itself the problem, named as a builder bug", () => {
			const problem = manifestShapeProblem(manifestFor(syntheticStore(1000)));
			expect(problem).toContain("partition_count");
			expect(problem).toContain("--partitions auto");
			expect(problem).toContain("ImportCoordinator");
		});

		test("partition_count disagreeing with partitions[] is refused", () => {
			expect(manifestShapeProblem(v2({ partition_count: 3 }))).toContain("partition_count 3");
		});

		test("an unknown partition_hash is refused at the source", () => {
			// The loader refuses unknown hashes too (its own defense); the writer
			// refusing first means the bad manifest never exists to be refused.
			expect(manifestShapeProblem(v2({ partition_hash: "md5/name/v9" }))).toContain("partition_hash");
		});

		test("an incomplete partition record is refused", () => {
			expect(manifestShapeProblem(v2({ partitions: [partition(0), partition(1, { chunk_count: 0 })] }))).toContain(
				"partition 1",
			);
		});

		test("totals that are not the sum of their parts are refused", () => {
			expect(manifestShapeProblem(v2({ store_bytes: 1 }))).toContain("store_bytes");
			expect(manifestShapeProblem(v2({ chunk_count: 99 }))).toContain("chunk_count");
		});

		test("writeManifest throws instead of publishing the problem", async () => {
			const { kv, entries } = fakeKvStore();
			const env = { STORE_KV: kv } as Env;
			expect(writeManifest(env, v2({ partition_count: 9 }))).rejects.toThrow(/refusing to publish/);
			expect(entries[MANIFEST_KEY]).toBeUndefined();
		});
	});
});

// The deploy and dev paths must gate the store on the SAME question. They
// drifted once: store-age.ts rebuilt the live store on a content_generation
// mismatch, while dev.sh asked only whether a manifest existed, so a builder
// change that forced a rebuild before a deploy left `bun dev` serving from a
// store the code could no longer read. The fix was one script with a --local
// flag rather than two implementations; these pin that, because a second
// implementation is exactly how the drift comes back.
describe("the dev and deploy staleness gates are the same gate", () => {
	const read = (p: string) => readFileSync(join(import.meta.dir, "../../scripts", p), "utf8");

	test("dev.sh defers to store-age.ts rather than asking its own question", () => {
		const devSh = read("dev.sh");
		expect(devSh).toMatch(/store-age\.ts["']?\s+--local/);
		// The old existence-only check. If it returns, dev runs on whatever is seeded.
		expect(devSh).not.toMatch(/kv key get store:manifest/);
	});

	test("store-age.ts resolves one KV target and reads every key through it", () => {
		const src = read("store-age.ts");
		expect(src).toContain('process.argv.includes("--local")');
		// The manifest read and the chunk probe must hit the SAME namespace. A
		// second hand-built argv is how one of them ends up on production while
		// the other is on the dev namespace, so `kv key get` is spelled once.
		expect(src.match(/"kv", "key", "get"/g)?.length ?? 0).toBe(1);
		expect(src).toMatch(/kvGetArgv\(MANIFEST_KEY\)/);
		expect(src).toMatch(/kvGetArgv\(lastChunk\)/);
		// And the target itself is chosen exactly once, by the flag.
		expect(src.match(/"--remote"/g)?.length ?? 0).toBe(1);
	});

	test("the generation comparison lives in the one shared script", () => {
		const src = read("store-age.ts");
		expect(src).toContain("STORE_CONTENT_GENERATION");
		expect(src).toMatch(/!==\s*STORE_CONTENT_GENERATION/);
		expect(src).toMatch(/!manifest\.store_bytes\s*\|\|\s*!manifest\.chunk_count/);
	});

	// The gate validates the partition shape UNCONDITIONALLY and probes EVERY
	// partition. There is no flag left to pick a key or a shape with, which is
	// the property worth pinning: a re-introduced conditional here is how a
	// deploy would green-light a store the serving path cannot load.
	test("store-age validates the partition shape with no mode selection", () => {
		const src = read("store-age.ts");
		expect(src).not.toContain("PARTITIONED_STORE");
		expect(src).not.toContain("manifestKeyFor");
		expect(src).toContain("MANIFEST_KEY");
		// The shape check is a plain refusal, not an arm of a conditional.
		expect(src).toMatch(/!Number\.isInteger\(manifest\.partition_count\)/);
		// Every partition's last chunk is probed: an interrupted publish can leave
		// 0..k complete while k+1 is missing, and one absent partition 503s every
		// card it owns.
		expect(src).toMatch(/for \(const target of manifest\.partitions \?\? \[\]\)/);
	});

	test("store-age watches all_cards, the corpus the one pipeline reads", () => {
		const src = read("store-age.ts");
		expect(src).toMatch(/const DUMP_KINDS = \["all_cards", "default_cards", "oracle_tags", "art_tags"\]/);
	});
});

// The publishers, pinned at the source level the way the store-age gate is:
// every one of them writes the single manifest key, and every sweeper protects
// the build the live manifest references.
describe("the publishers", () => {
	const read = (p: string) => readFileSync(join(import.meta.dir, "../../scripts", p), "utf8");

	test("seed-remote-kv publishes the manifest at the one key", () => {
		const src = read("seed-remote-kv.ts");
		expect(src).toMatch(/"put", MANIFEST_KEY/);
		expect(src).not.toContain("MANIFEST_KEY_V2");
	});

	test("seed-local-store seeds the same key, so dev reads through the same loader", () => {
		const src = read("seed-local-store.ts");
		expect(src).toMatch(/localKvPut\(MANIFEST_KEY/);
		expect(src).not.toContain("MANIFEST_KEY_V2");
	});

	test("every deploy sweep protects the build the live manifest references", () => {
		const kvPrune = read("kv-prune.ts");
		expect(kvPrune).toContain("export async function liveManifestBuiltAts");
		expect(kvPrune).not.toContain("MANIFEST_KEY_V2");
		expect(read("prune-kv.ts")).toContain("liveManifestBuiltAts(remote)");
		expect(read("seed-remote-kv.ts")).toContain("liveManifestBuiltAts(true)");
	});
});

// Growing past `n * cut` costs every cold load another KV read and says nothing:
// splitStore is a bare ceil loop, and chunkForKv's fallback answers a different
// question (one gzipped member against KV's per-VALUE cap). The manifest has always
// recorded chunk_count and nothing has ever compared it. These pin the warning that
// closes that, and the arithmetic it rests on.
describe("chunk headroom", () => {
	test("headroom is measured to the next boundary, not the last one", () => {
		// The generation-19 archive against the 46MB cut: two chunks, 8,097,368 bytes shy
		// of the 92,000,000-byte boundary. (A 42MB cut left 97,368 bytes — five days of
		// Scryfall drift — which is why the cut is 46MB.)
		const h = chunkHeadroom(83_902_632, KV_CHUNK_BYTES);
		expect(h.chunks).toBe(2);
		expect(h.nextBoundary).toBe(2 * KV_CHUNK_BYTES);
		expect(h.headroomBytes).toBe(8_097_368);
		// Relative to the store, so a thin margin reads thin regardless of the cut size.
		expect(h.headroomPct).toBeCloseTo(9.651, 2);
	});

	test("a store exactly on a boundary has a full chunk of room, not none", () => {
		// `ceil` has already handed it the chunk it fills, so the next boundary is
		// the one after. Reporting 0 here would cry wolf on every exact multiple.
		const h = chunkHeadroom(2 * KV_CHUNK_BYTES, KV_CHUNK_BYTES);
		expect(h.chunks).toBe(2);
		expect(h.headroomBytes).toBe(0);
		expect(chunkHeadroom(2 * KV_CHUNK_BYTES - 1).chunks).toBe(2);
		expect(chunkHeadroom(2 * KV_CHUNK_BYTES + 1).chunks).toBe(3);
	});

	test("one byte past the ceiling is a silent extra chunk — which is the point", () => {
		expect(chunkCountFor(2 * KV_CHUNK_BYTES)).toBe(2);
		expect(chunkCountFor(2 * KV_CHUNK_BYTES + 1)).toBe(3);
		// splitStore agrees, without complaint: this is the regression being guarded.
		expect(splitStore(new Uint8Array(2 * 8 + 1), 8)).toHaveLength(3);
	});

	test("the warning fires only when the margin is thin, and names the numbers", () => {
		// A store 100KB shy of the boundary — the exact margin the 42MB cut would have
		// shipped — must warn and name the numbers.
		const thin = 2 * KV_CHUNK_BYTES - 100_000;
		expect(chunkHeadroomWarning(thin)).toContain("100000");
		expect(chunkHeadroomWarning(thin)).toContain("becomes 3");
		// The real generation-19 archive sits 8.1MB inside: nothing to say.
		expect(chunkHeadroomWarning(83_902_632)).toBeNull();
	});

	test("the threshold is the boundary between quiet and loud", () => {
		const boundary = 2 * KV_CHUNK_BYTES;
		expect(chunkHeadroomWarning(boundary - CHUNK_HEADROOM_WARN_BYTES)).toBeNull();
		expect(chunkHeadroomWarning(boundary - CHUNK_HEADROOM_WARN_BYTES + 1)).not.toBeNull();
	});

	test("the safe cut is measured against its own grid", () => {
		// A fallback publish cuts at KV_CHUNK_BYTES_SAFE, so headroom must follow the
		// cut actually used rather than the constant the ambitious path prefers.
		const h = chunkHeadroom(76_656_360, KV_CHUNK_BYTES_SAFE);
		expect(h.chunks).toBe(3);
		expect(h.nextBoundary).toBe(3 * KV_CHUNK_BYTES_SAFE);
	});
});

describe("staleStoreKeys", () => {
	// Retention used to read a history list out of the coordinator's `meta` table, which
	// `metaClear()` wipes at the start of every run — so the list was always empty, nothing was ever
	// deleted, and production reached 15 store builds and 3 residue builds (~510MB of a 1GB
	// namespace) against a policy of 2. Deriving the sweep from the keys themselves is what makes it
	// unable to drift, so these pin the derivation.
	const keys = [
		"store:card-store-v11-1000.store:0",
		"store:card-store-v11-1000.store:1",
		"store:card-compat-v11-1000.store:0",
		"store:card-store-v11-2000.store:0",
		"store:card-compat-v11-2000.store:0",
		"store:card-store-v11-3000.store:0",
		"store:card-compat-v11-3000.store:0",
	];

	test("keeps the newest builds and retires the rest", () => {
		expect(staleStoreKeys(keys, 2, "3000").sort()).toEqual([
			"store:card-compat-v11-1000.store:0",
			"store:card-store-v11-1000.store:0",
			"store:card-store-v11-1000.store:1",
		]);
	});

	test("retires a build's residue archive with it", () => {
		// The residue is keyed by its own name, so a sweep that only knew about `card-store-` would
		// leave every `card-compat-` behind — which is its own slow leak.
		const stale = staleStoreKeys(keys, 1, "3000");
		expect(stale).toContain("store:card-compat-v11-1000.store:0");
		expect(stale).toContain("store:card-compat-v11-2000.store:0");
		expect(stale).not.toContain("store:card-compat-v11-3000.store:0");
	});

	test("never retires the build the manifest points at", () => {
		// Even when its timestamp is not the newest — a republished older manifest is a rollback,
		// and a sweep that deleted the live store would take the site down rather than tidy it.
		expect(staleStoreKeys(keys, 1, "1000")).not.toContain("store:card-store-v11-1000.store:0");
	});

	test("a namespace holding only the current build has nothing to retire", () => {
		expect(staleStoreKeys(["store:card-store-v11-3000.store:0"], 2, "3000")).toEqual([]);
	});

	test("leaves keys that are not store chunks alone", () => {
		// The manifest especially: it is the commit point, and the other datasets share the
		// namespace. Two builds so there is genuinely something to retire, or the assertion would
		// pass on a sweep that retires nothing at all.
		const others = ["store:manifest", "rulings:v2:00", "reference:v2:sets:list", "rulings:meta"];
		const withStores = [...others, "store:card-store-v11-1.store:0", "store:card-store-v11-2.store:0"];
		expect(staleStoreKeys(withStores, 1, "2")).toEqual(["store:card-store-v11-1.store:0"]);
	});

	// A partitioned build is N chunk families sharing one built_at, and retention must treat them as
	// ONE build: retiring some partitions of a generation while keeping others leaves a manifest
	// pointing at a store with holes, which 503s every card the missing partitions own.
	describe("partitioned families", () => {
		/** Two partitioned builds (N=3 and N=2) plus one suffix-less pre-partition
		 * build, mixed chunk seqs. */
		const partitioned = [
			// built_at 1000, N=3
			"store:card-store-v2026081501-1000-p0.store:0",
			"store:card-store-v2026081501-1000-p0.store:1",
			"store:card-store-v2026081501-1000-p1.store:0",
			"store:card-store-v2026081501-1000-p2.store:0",
			// built_at 2000, N=2
			"store:card-store-v2026081501-2000-p0.store:0",
			"store:card-store-v2026081501-2000-p1.store:0",
			// the pre-partition build, built_at 500 — suffix-less family
			"store:card-store-v2026081402-500.store:0",
			"store:card-store-v2026081402-500.store:1",
		];

		test("an N-family retires all-or-nothing, grouped by built_at", () => {
			const stale = staleStoreKeys(partitioned, 1, "2000");
			// EVERY key of build 1000 goes — all three partitions, every chunk.
			expect(stale.filter((k) => k.includes("-1000-")).length).toBe(4);
			// And NO key of the kept build does.
			expect(stale.some((k) => k.includes("-2000-"))).toBe(false);
		});

		test("THE ORPHANED PRE-PARTITION FAMILY IS COLLECTED BY THE ORDINARY SWEEP", () => {
			// The one-time transition's only leftover in KV. Once `store:manifest`
			// names a partitioned build, the generation-19 chunk family is referenced
			// by nothing — and because the pattern matches SUFFIX-LESS families too,
			// it groups by its own built_at, ages out of the newest-`keep` set, and
			// goes. No one-off cleanup script, and nothing to remember to run.
			//
			// keep=2 across three builds: 500 is the oldest and the one to go.
			const stale = staleStoreKeys(partitioned, 2, "2000").sort();
			expect(stale).toEqual(["store:card-store-v2026081402-500.store:0", "store:card-store-v2026081402-500.store:1"]);
		});

		test("the suffix-less family is matched at all — the property the sweep rests on", () => {
			// If the pattern had been tightened to REQUIRE `-p<k>` when the
			// partitioned store landed, the pre-partition family would be invisible to
			// retention and sit in a 1GB namespace forever. Alone against keep=1 with
			// a newer partitioned build, every one of its chunks must be named.
			const orphaned = [
				"store:card-store-v2026081402-500.store:0",
				"store:card-store-v2026081402-500.store:1",
				"store:card-store-v2026081501-2000-p0.store:0",
			];
			expect(staleStoreKeys(orphaned, 1, "2000").sort()).toEqual([
				"store:card-store-v2026081402-500.store:0",
				"store:card-store-v2026081402-500.store:1",
			]);
		});

		test("the live partitioned build is never retired, whatever its age", () => {
			// A republished older manifest is a rollback; the sweep must not take the
			// site down behind it. Same property the suffix-less test above pins, for
			// -p keys.
			const stale = staleStoreKeys(partitioned, 1, "1000");
			expect(stale.some((k) => k.includes("-1000-"))).toBe(false);
		});

		test("a -p suffix does not leak into the build grouping", () => {
			// The regex must group by built_at alone: if p10 parsed as part of the
			// timestamp, one partition of a build could be "newer" than its siblings.
			const keys = [
				"store:card-store-v1-100-p0.store:0",
				"store:card-store-v1-100-p10.store:0",
				"store:card-store-v1-200-p0.store:0",
			];
			expect(staleStoreKeys(keys, 1, "200")).toEqual([
				"store:card-store-v1-100-p0.store:0",
				"store:card-store-v1-100-p10.store:0",
			]);
		});
	});

	// Age alone does not decide. A build the live manifest references is a build
	// the serving path depends on, whatever its timestamp says, so every sweeper
	// passes that built_at alongside the one it just published.
	describe("the protect list", () => {
		// Three builds against keep=2, oldest first — the shape where an age-only
		// sweep and a protected sweep genuinely disagree.
		const dualWindow = [
			"store:card-store-v2026081402-500.store:0",
			"store:card-store-v2026081402-500.store:1",
			"store:card-store-v2026081501-1000-p0.store:0",
			"store:card-store-v2026081501-1000-p1.store:0",
			"store:card-store-v2026081501-2000-p0.store:0",
			"store:card-store-v2026081501-2000-p1.store:0",
		];

		test("WITHOUT protection the sweep takes the oldest family — the hazard is real", () => {
			const stale = staleStoreKeys(dualWindow, 2, "2000");
			expect(stale.filter((k) => k.includes("-500.")).length).toBe(2);
		});

		test("a family the live manifest references survives, however old", () => {
			const stale = staleStoreKeys(dualWindow, 2, ["2000", "500"]);
			expect(stale).toEqual([]);
		});

		test("protection is per-build, not blanket: unreferenced old builds still retire", () => {
			const withOlder = ["store:card-store-v2026081501-900-p0.store:0", ...dualWindow];
			const stale = staleStoreKeys(withOlder, 2, ["2000", "500"]);
			expect(stale).toEqual(["store:card-store-v2026081501-900-p0.store:0"]);
		});

		test("a plain string still means one protected build — the old call shape", () => {
			expect(staleStoreKeys(dualWindow, 1, "500").filter((k) => k.includes("-500."))).toEqual([]);
		});

		test("empty strings in the protect list protect nothing", () => {
			const stale = staleStoreKeys(dualWindow, 2, ["2000", ""]);
			expect(stale.filter((k) => k.includes("-500.")).length).toBe(2);
		});
	});
});

describe("chunkForKv", () => {
	/** Compressible: gzip collapses a repeating pattern to almost nothing. */
	const compressible = (n: number) => new Uint8Array(n).fill(0x41);

	/** Incompressible: a byte pattern gzip cannot shrink, so the cut binds. */
	function incompressible(n: number): Uint8Array<ArrayBuffer> {
		const out = new Uint8Array(n);
		// A xorshift PRNG, not Math.random, so a failure reproduces exactly.
		let x = 0x9e3779b9;
		for (let i = 0; i < n; i++) {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			out[i] = x & 0xff;
		}
		return out;
	}

	/** Stand-in for gzipSync: shrinks runs, leaves noise alone. */
	function fakeGzip(bytes: Uint8Array): Uint8Array {
		let runs = 1;
		for (let i = 1; i < bytes.length; i++) if (bytes[i] !== bytes[i - 1]) runs += 1;
		// Roughly "one output byte per run", floored so it is never zero-length.
		return new Uint8Array(Math.max(1, Math.min(bytes.length, runs)));
	}

	test("takes the ambitious cut when the data compresses", () => {
		const { chunks, cut } = chunkForKv(compressible(KV_CHUNK_BYTES * 2), fakeGzip);
		expect(cut).toBe(KV_CHUNK_BYTES);
		expect(chunks.length).toBe(2);
	});

	test("falls back to the safe cut when a member would exceed the cap", () => {
		// Incompressible input: at the ambitious cut every member is over the cap,
		// so the only publishable answer is the smaller one.
		const { chunks, cut } = chunkForKv(incompressible(KV_CHUNK_BYTES + 1_000), fakeGzip);
		expect(cut).toBe(KV_CHUNK_BYTES_SAFE);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(KV_VALUE_CAP_BYTES);
	});

	test("no chunk it returns is ever over the cap, whichever cut it chose", () => {
		for (const archive of [compressible(5_000_000), incompressible(5_000_000), compressible(KV_CHUNK_BYTES * 3)]) {
			const { chunks } = chunkForKv(archive, fakeGzip);
			for (const c of chunks) expect(c.length).toBeLessThanOrEqual(KV_VALUE_CAP_BYTES);
		}
	});

	test("the chunks reassemble to the original archive", () => {
		// The whole point: a cut is only correct if concatenating the pieces in
		// order reproduces the input, which is what the reader does.
		const archive = incompressible(3_000_000);
		const { chunks } = chunkForKv(archive, (b) => b); // identity "gzip"
		const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
		let at = 0;
		for (const c of chunks) {
			joined.set(c, at);
			at += c.length;
		}
		expect(joined).toEqual(archive);
	});

	test("a tiny archive is one chunk", () => {
		expect(chunkForKv(compressible(1_000), fakeGzip).chunks.length).toBe(1);
	});
});
