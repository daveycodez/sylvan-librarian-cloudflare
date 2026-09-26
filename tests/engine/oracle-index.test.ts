// The scryfall id → oracle id index: what both publishers write and what the rulings route
// binary-searches. A writer/reader disagreement does not fail loudly — it answers one card's
// rulings under another card's id — so these pin the round trip and every way a value is refused.

import { describe, expect, test } from "bun:test";
import { pairFromRow } from "../../scripts/seed-oracle-index";
import { keysToRetire } from "../../src/engine/kv-retention";
import { staleKeys } from "../../src/engine/kv-versions";
import {
	encodeOracleIndexBuckets,
	formatUuid,
	ORACLE_INDEX_BUCKET_COUNT,
	ORACLE_INDEX_KEY_PREFIX,
	ORACLE_INDEX_META_KEY,
	ORACLE_PAIR_BYTES,
	OracleIndexBuilder,
	OracleIndexFormatError,
	oracleIdLookup,
	oracleIndexBucketKey,
	oracleIndexBucketOf,
	oracleIndexCurrentPrefix,
	oracleIndexEntries,
	planOracleIndexPublish,
	uuidBytes,
} from "../../src/engine/oracle-index";
import { REFERENCE_KEY_PREFIX } from "../../src/engine/reference-kv";
import { RULINGS_KEY_PREFIX } from "../../src/engine/rulings-kv";

function pairsOf(pairs: [string, string][]): Uint8Array {
	const flat = new Uint8Array(pairs.length * ORACLE_PAIR_BYTES);
	pairs.forEach(([s, o], i) => {
		flat.set(uuidBytes(s) as Uint8Array, i * ORACLE_PAIR_BYTES);
		flat.set(uuidBytes(o) as Uint8Array, i * ORACLE_PAIR_BYTES + 16);
	});
	return flat;
}

function lookup(buckets: Uint8Array[], id: string): string | null {
	return oracleIdLookup(buckets[oracleIndexBucketOf(id) as number] as Uint8Array, id);
}

describe("addressing", () => {
	test("the bucket is the scryfall id's top six bits", () => {
		expect(oracleIndexBucketOf("00000000-0000-4000-8000-000000000000")).toBe(0);
		expect(oracleIndexBucketOf("03ffffff-0000-4000-8000-000000000000")).toBe(0);
		expect(oracleIndexBucketOf("04000000-0000-4000-8000-000000000000")).toBe(1);
		expect(oracleIndexBucketOf("ffffffff-0000-4000-8000-000000000000")).toBe(ORACLE_INDEX_BUCKET_COUNT - 1);
		expect(oracleIndexBucketOf("FC000000-0000-4000-8000-000000000000")).toBe(63);
	});

	test("anything that is not a UUID has no bucket", () => {
		for (const v of ["", "rulings", "00000000-0000-4000-8000-00000000000", "zz000000-0000-4000-8000-000000000000"]) {
			expect(oracleIndexBucketOf(v)).toBeNull();
		}
	});

	test("keys carry the layout version", () => {
		expect(oracleIndexBucketKey(0)).toBe("oracle-index:v1:00");
		expect(oracleIndexBucketKey(63)).toBe("oracle-index:v1:3f");
		expect(oracleIndexCurrentPrefix()).toBe("oracle-index:v1:");
	});

	test("uuid bytes round-trip to Scryfall's spelling", () => {
		const id = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
		expect(formatUuid(uuidBytes(id.toUpperCase()) as Uint8Array)).toBe(id);
	});
});

describe("round trip", () => {
	test("every pair is found, in any input order, and absent ids miss", () => {
		const pairs: [string, string][] = [];
		for (let i = 0; i < 5000; i++) pairs.push([crypto.randomUUID(), crypto.randomUUID()]);
		const { buckets, pairCount, conflicts } = encodeOracleIndexBuckets(pairsOf(pairs.slice().reverse()));
		expect(buckets.length).toBe(ORACLE_INDEX_BUCKET_COUNT);
		expect(pairCount).toBe(5000);
		expect(conflicts).toBe(0);
		for (const [s, o] of pairs) expect(lookup(buckets, s)).toBe(o);
		for (const [s, o] of pairs.slice(0, 50)) expect(lookup(buckets, s.toUpperCase())).toBe(o);
		for (let i = 0; i < 200; i++) expect(lookup(buckets, crypto.randomUUID())).toBeNull();
		// And the entries read back as exactly the input set, in id order within each bucket.
		const back = buckets.flatMap((b) => [...oracleIndexEntries(b)]);
		expect(back.length).toBe(5000);
		expect(new Map(back)).toEqual(new Map(pairs));
	});

	test("empty buckets are still valid buckets", () => {
		const { buckets } = encodeOracleIndexBuckets(new Uint8Array(0));
		expect(buckets.every((b) => b.length === 16)).toBe(true);
		expect(lookup(buckets, crypto.randomUUID())).toBeNull();
	});

	test("the encoding is a pure function of the pair SET (so a reordered night writes nothing)", () => {
		const pairs: [string, string][] = Array.from({ length: 300 }, () => [crypto.randomUUID(), crypto.randomUUID()]);
		const a = encodeOracleIndexBuckets(pairsOf(pairs)).buckets;
		// Re-chunked, reordered, one pair repeated: the nightly stages one run per scores batch and
		// the native builder writes one file, and both must come out identical.
		const b = encodeOracleIndexBuckets([
			pairsOf(pairs.slice(150)),
			pairsOf([]),
			pairsOf([...pairs.slice(0, 150), pairs[0] as [string, string]]),
		]).buckets;
		expect(b).toEqual(a);
	});

	test("an id carrying two oracle ids is dropped, so the route asks the engine", () => {
		const s = crypto.randomUUID();
		const { buckets, conflicts, pairCount } = encodeOracleIndexBuckets(
			pairsOf([
				[s, crypto.randomUUID()],
				[s, crypto.randomUUID()],
			]),
		);
		expect(conflicts).toBe(1);
		expect(pairCount).toBe(0);
		expect(lookup(buckets, s)).toBeNull();
	});
});

describe("the two-pass builder", () => {
	test("streamed count-then-add equals the one-shot encoding", () => {
		const runs = Array.from({ length: 7 }, () =>
			pairsOf(Array.from({ length: 90 }, () => [crypto.randomUUID(), crypto.randomUUID()] as [string, string])),
		);
		const builder = new OracleIndexBuilder();
		for (const run of runs) builder.count(run.slice());
		for (const run of runs) builder.add(run.slice());
		expect(builder.finish()).toEqual(encodeOracleIndexBuckets(runs));
	});

	test("runs that change between the passes are refused, not half-encoded", () => {
		const a = pairsOf([["04000000-0000-4000-8000-000000000001", crypto.randomUUID()]]);
		const b = pairsOf([["08000000-0000-4000-8000-000000000001", crypto.randomUUID()]]);
		const more = new OracleIndexBuilder();
		more.count(a);
		expect(() => more.add(b)).toThrow(/more pairs than were counted/);
		const fewer = new OracleIndexBuilder();
		fewer.count(a);
		fewer.count(b);
		fewer.add(a);
		expect(() => fewer.finish()).toThrow(/fewer pairs than were counted/);
		const late = new OracleIndexBuilder();
		late.count(a);
		late.add(a);
		expect(() => late.count(a)).toThrow(/count after add/);
		expect(() => new OracleIndexBuilder().add(a)).toThrow(/more pairs than were counted/);
	});

	test("a run that is not whole records is refused", () => {
		expect(() => new OracleIndexBuilder().count(new Uint8Array(33))).toThrow(OracleIndexFormatError);
	});
});

describe("publish plan", () => {
	test("first publish owes every bucket; an identical night owes none; one new printing owes one", async () => {
		const pairs: [string, string][] = Array.from({ length: 2000 }, () => [crypto.randomUUID(), crypto.randomUUID()]);
		const first = encodeOracleIndexBuckets(pairsOf(pairs));
		const p1 = await planOracleIndexPublish(first.buckets, first.pairCount, "1", null);
		expect(p1.changed.length).toBe(ORACLE_INDEX_BUCKET_COUNT);
		expect(p1.meta.pair_count).toBe(2000);
		expect(p1.meta.hashes.length).toBe(ORACLE_INDEX_BUCKET_COUNT);
		const p2 = await planOracleIndexPublish(first.buckets, first.pairCount, "2", p1.meta);
		expect(p2.changed).toEqual([]);
		const added = "c4000000-0000-4000-8000-000000000001"; // bucket 0x31
		const next = encodeOracleIndexBuckets(pairsOf([...pairs, [added, crypto.randomUUID()]]));
		const p3 = await planOracleIndexPublish(next.buckets, next.pairCount, "3", p2.meta);
		expect(p3.changed).toEqual([oracleIndexBucketOf(added) as number]);
	});

	test("a meta from another layout, generation or bucket count owes everything", async () => {
		const { buckets, pairCount } = encodeOracleIndexBuckets(new Uint8Array(0));
		const { meta } = await planOracleIndexPublish(buckets, pairCount, "1", null);
		for (const stale of [
			{ ...meta, format_version: 0 },
			{ ...meta, content_generation: 0 },
			{ ...meta, bucket_count: 128 },
			{ ...meta, hashes: undefined as unknown as string[] },
		]) {
			const p = await planOracleIndexPublish(buckets, pairCount, "2", stale);
			expect(p.changed.length).toBe(ORACLE_INDEX_BUCKET_COUNT);
		}
	});
});

describe("refusals", () => {
	const id = "04000000-0000-4000-8000-000000000001";
	const { buckets } = encodeOracleIndexBuckets(pairsOf([[id, crypto.randomUUID()]]));
	const mine = buckets[1] as Uint8Array;

	test("a value under the wrong bucket key is refused, not searched", () => {
		expect(() => oracleIdLookup(buckets[2] as Uint8Array, id)).toThrow(OracleIndexFormatError);
	});

	test("a truncated, foreign or future-version value is refused", () => {
		expect(() => oracleIdLookup(mine.subarray(0, mine.length - 1), id)).toThrow(OracleIndexFormatError);
		expect(() => oracleIdLookup(new TextEncoder().encode("SLKB01200000001\n"), id)).toThrow(OracleIndexFormatError);
		expect(() => oracleIdLookup(new Uint8Array(4), id)).toThrow(OracleIndexFormatError);
		const future = mine.slice();
		future[4] = 2;
		expect(() => oracleIdLookup(future, id)).toThrow(OracleIndexFormatError);
	});

	test("a malformed id is a miss, not an error", () => {
		expect(oracleIdLookup(mine, "not-a-uuid")).toBeNull();
	});
});

describe("retention never touches it", () => {
	// Stable keys, overwritten in place — nothing may sweep them. Every KV sweep in this repo is a
	// prefix list: the store's (`store:card-`, retention by role — the coordinator's sweepByRole
	// and scripts/prune-kv.ts), and the layout sweeps (staleKeys under `rulings:v` / `reference:v`,
	// the coordinator's pruneOldKeys and scripts/kv-prune.ts). The index's own layout sweep keeps
	// the current version's keys and never matches the meta.
	const keys = [
		ORACLE_INDEX_META_KEY,
		...Array.from({ length: ORACLE_INDEX_BUCKET_COUNT }, (_, b) => oracleIndexBucketKey(b)),
	];

	test("no sweep prefix covers an oracle-index key", () => {
		for (const prefix of ["store:card-", RULINGS_KEY_PREFIX, REFERENCE_KEY_PREFIX]) {
			expect(keys.filter((k) => k.startsWith(prefix))).toEqual([]);
			expect(staleKeys(keys, prefix, `${prefix}999:`)).toEqual([]);
		}
		expect(keysToRetire(keys, { live: "1", rollback: null, inFlight: null })).toEqual([]);
	});

	test("its own layout sweep drops only an older layout's buckets", () => {
		const old = ["oracle-index:v0:00", "oracle-index:v0:3f"];
		expect(staleKeys([...keys, ...old], ORACLE_INDEX_KEY_PREFIX, oracleIndexCurrentPrefix())).toEqual(old);
	});
});

describe("the deploy seeder's rows.jsonl fallback", () => {
	// transform::oracle_pair_of_row's rule, in TS, for a build dir from before the sidecar.
	const s = "0A1B2C3D-4E5F-4A6B-8C7D-8E9FA0B1C2D3";
	const o = "11111111-2222-4333-8444-555555555555";

	test("a row with two UUIDs is a pair, case folded", () => {
		const out = new Uint8Array(64);
		expect(pairFromRow({ scryfall_id: s, oracle_id: o, card_layout: "normal" }, out, 32)).toBe(true);
		expect(formatUuid(out, 32)).toBe(s.toLowerCase());
		expect(formatUuid(out, 48)).toBe(o);
	});

	test("a reversible printing is a pair too: its row holds its faces' oracle id", () => {
		const out = new Uint8Array(32);
		expect(pairFromRow({ scryfall_id: s, oracle_id: o, card_layout: "reversible_card" }, out, 0)).toBe(true);
		expect(formatUuid(out, 16)).toBe(o);
	});

	test("a missing or a malformed id is not", () => {
		const out = new Uint8Array(32);
		expect(pairFromRow({ scryfall_id: s, card_layout: "normal" }, out, 0)).toBe(false);
		expect(pairFromRow({ scryfall_id: s, oracle_id: "", card_layout: "normal" }, out, 0)).toBe(false);
		expect(pairFromRow({ scryfall_id: "x", oracle_id: o }, out, 0)).toBe(false);
	});
});
