// The oracle-tags blob (src/engine/oracle-tag-partitions.ts): the one encoder both publishers use,
// the reader's refusals, and the router isolate's copy.

import { afterEach, describe, expect, test } from "bun:test";
import {
	encodeOracleTagPartitions,
	forgetOracleTagPartitions,
	ORACLE_TAGS_HEADER,
	OracleTagPartitions,
	oracleTagPartitionsSoon,
	oracleTagsKey,
	oracleTagsOf,
	writeOracleTags,
} from "../../src/engine/oracle-tag-partitions";
import type { Env, StoreManifest } from "../../src/engine/types";

const enc = new TextEncoder();
const dec = new TextDecoder();
const HASH = "fnv1a64-oracle-id-v1";
const expectN = (partitionCount: number) => ({ partitionCount, partitionHash: HASH });

describe("the encoder", () => {
	test("unions every partition's slugs into one sorted line per slug, order- and repeat-insensitive", () => {
		const a = encodeOracleTagPartitions(
			[enc.encode("0\tramp\n0\tremoval\n2\tremoval\n"), enc.encode("11\tramp\n")],
			12,
			HASH,
		);
		const b = encodeOracleTagPartitions(
			[enc.encode("11\tramp\n2\tremoval\n"), enc.encode("0\tremoval\n0\tramp\n0\tramp\n")],
			12,
			HASH,
		);
		expect(dec.decode(a)).toBe(`${ORACLE_TAGS_HEADER}12\t${HASH}\nramp\t801\nremoval\t5\n`);
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
	});

	test("an empty partition contributes nothing, and no tags at all is a valid blob", () => {
		const raw = encodeOracleTagPartitions([enc.encode(""), enc.encode("1\tx\n")], 2, HASH);
		expect(OracleTagPartitions.parse(raw, expectN(2)).partitionsOf("x")).toEqual([1]);
		const none = encodeOracleTagPartitions([enc.encode("")], 2, HASH);
		expect(OracleTagPartitions.parse(none, expectN(2)).size).toBe(0);
	});

	test("refuses what would misplace a tag: a partition past the modulus, a malformed line, an unterminated part", () => {
		expect(() => encodeOracleTagPartitions([enc.encode("12\tramp\n")], 12, HASH)).toThrow();
		expect(() => encodeOracleTagPartitions([enc.encode("ramp\n")], 12, HASH)).toThrow();
		expect(() => encodeOracleTagPartitions([enc.encode("1\t\n")], 12, HASH)).toThrow();
		expect(() => encodeOracleTagPartitions([enc.encode("-1\tramp\n")], 12, HASH)).toThrow();
		expect(() => encodeOracleTagPartitions([enc.encode("1\tramp")], 12, HASH)).toThrow();
		expect(() => encodeOracleTagPartitions([enc.encode("1\tra\rmp\n")], 12, HASH)).toThrow();
		expect(() => encodeOracleTagPartitions([], 54, HASH)).toThrow();
	});

	test("a mask spells every partition up to the ceiling exactly", () => {
		const lines = `${Array.from({ length: 48 }, (_, p) => `${p}\tall\n`).join("")}47\tlast\n0\tfirst\n`;
		const tags = OracleTagPartitions.parse(encodeOracleTagPartitions([enc.encode(lines)], 48, HASH), expectN(48));
		expect(tags.partitionsOf("all")).toEqual(Array.from({ length: 48 }, (_, p) => p));
		expect(tags.partitionsOf("last")).toEqual([47]);
		expect(tags.partitionsOf("first")).toEqual([0]);
	});
});

describe("the reader", () => {
	const raw = encodeOracleTagPartitions([enc.encode("3\tramp\n5\tramp\n7\tsynergy-sliver\n")], 12, HASH);

	test("a slug's partitions, ascending; a slug no card carries holds none", () => {
		const tags = OracleTagPartitions.parse(raw, expectN(12));
		expect(tags.partitionsOf("ramp")).toEqual([3, 5]);
		expect(tags.partitionsOf("synergy-sliver")).toEqual([7]);
		expect(tags.partitionsOf("synergy-nothing")).toEqual([]);
		expect(tags.slugs()).toEqual(["ramp", "synergy-sliver"]);
	});

	test("refuses another modulus, another hash, another header, a truncation or a bad mask", () => {
		expect(() => OracleTagPartitions.parse(raw, expectN(11))).toThrow();
		expect(() => OracleTagPartitions.parse(raw, { partitionCount: 12, partitionHash: "other" })).toThrow();
		const text = dec.decode(raw);
		const bad = (s: string) => () => OracleTagPartitions.parse(enc.encode(s), expectN(12));
		expect(bad(text.replace("sylvan-oracle-tags/1", "sylvan-oracle-tags/2"))).toThrow();
		expect(bad(text.slice(0, -1))).toThrow();
		expect(bad(text.replace("ramp\t28", "ramp\t1000"))).toThrow(); // bit 12 of a 12-partition build
		expect(bad(text.replace("ramp\t28", "ramp\t0"))).toThrow();
		expect(bad(text.replace("ramp\t28", "ramp\tzz"))).toThrow();
		expect(bad(`${text}aaa\t1\n`)).toThrow(); // out of order
		expect(bad(`${text}synergy-sliver\t1\n`)).toThrow(); // repeated
	});
});

describe("the manifest's word and the isolate's copy", () => {
	afterEach(() => forgetOracleTagPartitions());

	const manifest = (extra: Partial<StoreManifest>): StoreManifest =>
		({
			store_key: "store:card-store-v7-1000",
			built_at: "1000",
			format_version: 7,
			partition_count: 12,
			partition_hash: HASH,
			...extra,
		}) as StoreManifest;

	test("the key is in its build's family; a manifest without both fields names none", () => {
		expect(oracleTagsKey(7, "1000")).toBe("store:card-otags-v7-1000.store:0");
		expect(oracleTagsOf(manifest({ otags_key: oracleTagsKey(7, "1000"), otags_bytes: 9 }))).toEqual({
			key: oracleTagsKey(7, "1000"),
			bytes: 9,
		});
		expect(oracleTagsOf(manifest({ otags_key: oracleTagsKey(7, "1000") }))).toBeNull();
		expect(oracleTagsOf(manifest({ otags_key: "store:manifest", otags_bytes: 9 }))).toBeNull();
		expect(oracleTagsOf(manifest({}))).toBeNull();
	});

	function fakeEnv(): { env: Env; reads: string[]; store: Map<string, Uint8Array> } {
		const store = new Map<string, Uint8Array>();
		const reads: string[] = [];
		const kv = {
			async get(key: string) {
				reads.push(key);
				const v = store.get(key);
				return v === undefined ? null : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
			},
			async put(key: string, value: Uint8Array) {
				store.set(key, new Uint8Array(value));
			},
		};
		return { env: { STORE_KV: kv } as unknown as Env, reads, store };
	}

	test("published, read back once per build, and checked against the manifest", async () => {
		const { env, reads, store } = fakeEnv();
		const raw = encodeOracleTagPartitions([enc.encode("4\tramp\n")], 12, HASH);
		const published = await writeOracleTags(env.STORE_KV, 7, "1000", raw);
		expect(published.key).toBe(oracleTagsKey(7, "1000"));
		const m = manifest({ otags_key: published.key, otags_bytes: published.bytes });
		const waits: Promise<unknown>[] = [];
		const first = await oracleTagPartitionsSoon(env, m, (p) => waits.push(p), 5_000);
		expect(first?.partitionsOf("ramp")).toEqual([4]);
		await oracleTagPartitionsSoon(env, m, (p) => waits.push(p), 5_000);
		expect(reads).toEqual([published.key]);
		// Another build's manifest is another key, read on its own.
		const other = { ...m, built_at: "2000", otags_key: oracleTagsKey(7, "2000") };
		store.set(oracleTagsKey(7, "2000"), store.get(published.key) as Uint8Array);
		expect((await oracleTagPartitionsSoon(env, other, () => {}, 5_000))?.partitionsOf("ramp")).toEqual([4]);
		expect(reads).toHaveLength(2);
	});

	test("a blob of the wrong length or modulus is refused, and so is a missing one: the gather asks everyone", async () => {
		const { env } = fakeEnv();
		const raw = encodeOracleTagPartitions([enc.encode("4\tramp\n")], 12, HASH);
		const published = await writeOracleTags(env.STORE_KV, 7, "1000", raw);
		expect(
			await oracleTagPartitionsSoon(
				env,
				manifest({ otags_key: published.key, otags_bytes: published.bytes + 1 }),
				() => {},
			),
		).toBeNull();
		forgetOracleTagPartitions();
		expect(
			await oracleTagPartitionsSoon(
				env,
				manifest({ otags_key: published.key, otags_bytes: published.bytes, partition_count: 11 }),
				() => {},
			),
		).toBeNull();
		forgetOracleTagPartitions();
		expect(
			await oracleTagPartitionsSoon(env, manifest({ otags_key: oracleTagsKey(7, "9"), otags_bytes: 10 }), () => {}),
		).toBeNull();
		expect(await oracleTagPartitionsSoon(env, manifest({}), () => {})).toBeNull();
	});

	test("a read slower than the wait is not waited for; the next request has it", async () => {
		const { env } = fakeEnv();
		const raw = encodeOracleTagPartitions([enc.encode("4\tramp\n")], 12, HASH);
		const published = await writeOracleTags(env.STORE_KV, 7, "1000", raw);
		const slowKv = {
			get: async (key: string, opts: unknown) => {
				await new Promise((r) => setTimeout(r, 50));
				return (env.STORE_KV as unknown as { get: (k: string, o: unknown) => Promise<unknown> }).get(key, opts);
			},
		};
		const slow = { STORE_KV: slowKv } as unknown as Env;
		const m = manifest({ otags_key: published.key, otags_bytes: published.bytes });
		const waits: Promise<unknown>[] = [];
		expect(await oracleTagPartitionsSoon(slow, m, (p) => waits.push(p), 5)).toBeNull();
		await Promise.all(waits);
		expect((await oracleTagPartitionsSoon(slow, m, () => {}, 0))?.partitionsOf("ramp")).toEqual([4]);
	});
});
