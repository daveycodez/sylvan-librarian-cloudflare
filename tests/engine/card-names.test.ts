// The card-names blob (n8; format 2, the names index, since n15): the ONE encoder both publishers
// use, its key's place in retention, and the manifest fields a reader must tolerate.

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
	CARD_NAMES_HEADER,
	cardNamesCount,
	cardNamesKey,
	cardNamesOf,
	encodeCardNames,
	ledByPartition,
	mayBeNameOnly,
	writeCardNames,
} from "../../src/engine/card-names";
import { generationKey, generationOfKey } from "../../src/engine/kv-retention";
import type { StoreManifest } from "../../src/engine/types";
import { partitionCacheBytes } from "../../src/import-budget";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A format-2 record line as `card_engine::name_records_tsv` spells one, led by its partition. */
const rec = (p: number, collated: string, printed: string, flavor = "") =>
	`${p}\t1f0\t${collated}\t${printed}\t\t\t${flavor}\n`;

describe("encodeCardNames", () => {
	test("header, then each distinct line once, sorted", () => {
		const raw = encodeCardNames([
			bytes(rec(0, "shock", "Shock") + rec(0, "fireice", "Fire // Ice")),
			bytes(rec(1, "eowynladyofrohan", "Éowyn, Lady of Rohan") + rec(0, "shock", "Shock")),
		]);
		expect(text(raw)).toBe(
			CARD_NAMES_HEADER +
				rec(0, "fireice", "Fire // Ice") +
				rec(0, "shock", "Shock") +
				rec(1, "eowynladyofrohan", "Éowyn, Lady of Rohan"),
		);
		expect(cardNamesCount(raw)).toBe(3);
	});

	test("the bytes do not depend on how the lines were cut into partitions, or their order", () => {
		const lines = [
			rec(1, "b", "B"),
			rec(0, "a", "A"),
			rec(2, "", "_____"),
			rec(1, "c", "C"),
			rec(0, "a", "A2", "x:1f"),
		];
		const one = encodeCardNames([bytes(lines.join(""))]);
		const split = encodeCardNames([bytes(lines.slice(3).join("")), bytes(""), bytes(lines.slice(0, 3).join(""))]);
		expect(split).toEqual(one);
		// An empty collated name (`_____` collates to nothing) is a legal line.
		expect(text(one)).toContain("\n2\t1f0\t\t_____\t");
	});

	test("the nightly's unled lines, led by their partition, are the native builder's lines", () => {
		const unled = "1f0\tshock\tShock\t\t\t\n1f0\tbolt\tBolt\t\t\tx:10\n";
		expect(ledByPartition(3, unled)).toBe(rec(3, "shock", "Shock") + rec(3, "bolt", "Bolt", "x:10"));
		expect(ledByPartition(0, "")).toBe("");
		expect(() => ledByPartition(0, "1f0\ta\tA\t\t\t")).toThrow();
	});

	test("an empty corpus is the header alone", () => {
		expect(text(encodeCardNames([]))).toBe(CARD_NAMES_HEADER);
		expect(cardNamesCount(encodeCardNames([]))).toBe(0);
	});

	test("refuses lines the reader would refuse", () => {
		for (const bad of ["no tab\n", "a\tb\tc\n", "a\tb\n", rec(0, "a", "b\r"), rec(0, "a", "b").slice(0, -1)]) {
			expect(() => encodeCardNames([bytes(bad)])).toThrow();
		}
		expect(() => encodeCardNames([new Uint8Array([0xff, 0x0a])])).toThrow();
	});
});

describe("mayBeNameOnly: which gathers wait for the names index (n15)", () => {
	const name = (value: string) => ({
		node_type: "CardBinaryOperatorNode",
		kwargs: { op: ":", lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_name" } }, rhs: value },
	});
	const gate = {
		node_type: "NotNode",
		kwargs: {
			operand: {
				node_type: "CardBinaryOperatorNode",
				kwargs: { lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_is_tags" } }, rhs: ["extra"] },
			},
		},
	};
	const t = (tree: unknown) => mayBeNameOnly(JSON.stringify(tree));
	test("name leaves under AND/OR, with the gate's conjuncts", () => {
		expect(t(name("bolt"))).toBe(true);
		expect(
			t({
				node_type: "AndNode",
				kwargs: { operands: [{ node_type: "OrNode", kwargs: { operands: [name("a"), name("b")] } }, gate] },
			}),
		).toBe(true);
	});
	test("anything else is not, and neither is the gate alone", () => {
		const oracle = {
			node_type: "CardBinaryOperatorNode",
			kwargs: { lhs: { kwargs: { attribute_name: "oracle_text" } } },
		};
		expect(t({ node_type: "AndNode", kwargs: { operands: [name("a"), oracle] } })).toBe(false);
		expect(t({ node_type: "AndNode", kwargs: { operands: [gate] } })).toBe(false);
		expect(t({ node_type: "NotNode", kwargs: { operand: name("a") } })).toBe(false);
		expect(t({ node_type: "TrueNode" })).toBe(false);
		expect(t({ node_type: "ExactNameNode", kwargs: { value: "x" } })).toBe(false);
		expect(mayBeNameOnly("{not json")).toBe(false);
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
		const raw = encodeCardNames([bytes(rec(0, "shock", "Shock"))]);
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
