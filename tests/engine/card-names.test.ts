// The card-names blob (n8): the ONE encoder both publishers use, its key's place in retention, and
// the manifest fields a reader must tolerate.

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
	CARD_NAMES_HEADER,
	cardNamesCount,
	cardNamesKey,
	cardNamesOf,
	encodeCardNames,
	writeCardNames,
} from "../../src/engine/card-names";
import { generationKey, generationOfKey } from "../../src/engine/kv-retention";
import type { StoreManifest } from "../../src/engine/types";
import { partitionCacheBytes } from "../../src/import-budget";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("encodeCardNames", () => {
	test("header, then each distinct line once, sorted", () => {
		const raw = encodeCardNames([
			bytes("shock\tShock\nfireice\tFire // Ice\n"),
			bytes("eowynladyofrohan\tÉowyn, Lady of Rohan\nshock\tShock\n"),
		]);
		expect(text(raw)).toBe(
			`${CARD_NAMES_HEADER}eowynladyofrohan\tÉowyn, Lady of Rohan\nfireice\tFire // Ice\nshock\tShock\n`,
		);
		expect(cardNamesCount(raw)).toBe(3);
	});

	test("the bytes do not depend on how the lines were cut into partitions, or their order", () => {
		const lines = ["b\tB", "a\tA", "\t_____", "c\tC", "a\tA2"].map((l) => `${l}\n`);
		const one = encodeCardNames([bytes(lines.join(""))]);
		const split = encodeCardNames([bytes(lines.slice(3).join("")), bytes(""), bytes(lines.slice(0, 3).join(""))]);
		expect(split).toEqual(one);
		// An empty collated name (`_____` collates to nothing) is a legal line.
		expect(text(one)).toContain("\n\t_____\n");
	});

	test("an empty corpus is the header alone", () => {
		expect(text(encodeCardNames([]))).toBe(CARD_NAMES_HEADER);
		expect(cardNamesCount(encodeCardNames([]))).toBe(0);
	});

	test("refuses lines the reader would refuse", () => {
		for (const bad of ["no tab\n", "a\tb\tc\n", "a\tb\r\n", "a\tb"]) {
			expect(() => encodeCardNames([bytes(bad)])).toThrow();
		}
		expect(() => encodeCardNames([new Uint8Array([0xff, 0x0a])])).toThrow();
	});
});

describe("the names key", () => {
	test("is shaped like the routing filter's, so it retires with its build", () => {
		expect(cardNamesKey(7, "1700000000")).toBe("store:card-names-v7-1700000000.store:0");
		const keys = [
			"store:card-store-v7-1000-p0.store:0",
			cardNamesKey(7, "1000"),
			"store:card-store-v7-2000-p0.store:0",
			cardNamesKey(7, "2000"),
			"store:card-store-v7-3000-p0.store:0",
			cardNamesKey(7, "3000"),
		];
		// Retention is by family (kv-retention.ts): the blob's key names its build, exactly as x3's
		// generationKey spells a per-generation value, so it is kept and retired with that build.
		expect(cardNamesKey(7, "1000")).toBe(generationKey("names", 7, "1000"));
		expect(keys.map(generationOfKey)).toEqual(["1000", "1000", "2000", "2000", "3000", "3000"]);
	});

	test("writeCardNames puts the blob gzipped and reports what the manifest records", async () => {
		const puts = new Map<string, Uint8Array>();
		const kv = { put: async (k: string, v: Uint8Array) => void puts.set(k, v) } as unknown as KVNamespace;
		const raw = encodeCardNames([bytes("shock\tShock\n")]);
		const out = await writeCardNames(kv, 7, "1000", raw);
		expect(out.key).toBe(cardNamesKey(7, "1000"));
		const stored = puts.get(out.key) as Uint8Array;
		expect(out.bytes).toBe(stored.byteLength);
		expect(Buffer.from(gunzipSync(stored)).equals(Buffer.from(raw))).toBe(true);
		expect(out.count).toBe(1);
	});
});

describe("the manifest's names fields are read-tolerant", () => {
	const base = { store_key: "card-store-v7-1000.store", built_at: "1000" } as StoreManifest;
	test("both present and well-formed, or no blob", () => {
		expect(cardNamesOf({ ...base, names_key: cardNamesKey(7, "1000"), names_bytes: 99 })).toEqual({
			key: cardNamesKey(7, "1000"),
			bytes: 99,
		});
		expect(cardNamesOf(base)).toBeNull();
		expect(cardNamesOf(null)).toBeNull();
		expect(cardNamesOf({ ...base, names_key: cardNamesKey(7, "1000") })).toBeNull();
		expect(cardNamesOf({ ...base, names_key: "store:manifest", names_bytes: 99 })).toBeNull();
		expect(cardNamesOf({ ...base, names_key: cardNamesKey(7, "1000"), names_bytes: 1.5 })).toBeNull();
	});

	test("the pool projection counts the names once per partition object", () => {
		const partitions = [{ store_gzip_bytes: 100 }, { store_gzip_bytes: 200 }];
		expect(partitionCacheBytes({ partitions })).toEqual([100, 200]);
		expect(partitionCacheBytes({ partitions, names_bytes: 7 })).toEqual([107, 207]);
	});
});
