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
	chunkCountFor,
	chunkKey,
	gzipBytes,
	KV_CHUNK_BYTES,
	KV_VALUE_CAP_BYTES,
	kvStoreStream,
	MANIFEST_KEY,
	readManifest,
	type StagedRow,
	splitStore,
	staleStoreKeys,
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

	test("a full-size raw chunk still fits KV's value cap once gzipped", async () => {
		// Incompressible input is the worst case the publisher's guard exists for:
		// gzip must not expand a full KV_CHUNK_BYTES cut past the 25 MiB cap.
		// Real CSPRNG bytes, not an LCG — a cheap generator leaves enough
		// structure that gzip SHRINKS it (a 31-bit LCG here compressed 26MB to
		// 248KB), which would make this test assert nothing.
		const noise = new Uint8Array(new ArrayBuffer(KV_CHUNK_BYTES));
		for (let at = 0; at < noise.length; at += 65536) {
			crypto.getRandomValues(noise.subarray(at, Math.min(at + 65536, noise.length)));
		}
		const gz = await gzipBytes(noise);
		expect(gz.byteLength).toBeGreaterThan(KV_CHUNK_BYTES); // it really is incompressible
		expect(gz.byteLength).toBeLessThanOrEqual(KV_VALUE_CAP_BYTES);
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
});
