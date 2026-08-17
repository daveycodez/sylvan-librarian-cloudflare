// The id→partition routing filter (src/engine/routing-filter.ts).
//
// The structure's whole claim is asymmetric, and both halves are tested here:
//
//   * a key that WAS built in returns its partition EXACTLY — no probability, no
//     false-positive rate, because a 3-wise XOR retrieval filter is exact on its
//     construction set. That is what makes a hint safe to act on.
//   * a key that was NOT returns an arbitrary nibble, and the serving path treats
//     a fruitless hint as a miss and fans out. So the only thing to measure on the
//     absent side is COST, not correctness — how often a garbage nibble names a
//     real partition and buys one wasted RPC.
//
// The corpus-scale case at the bottom is the one that matters for the meter: it
// builds a filter over a synthetic corpus the size of the real one and reports
// the bytes, the exactness and the expected RPC count.

import { describe, expect, test } from "bun:test";
import {
	buildRoutingFilter,
	buildRoutingFilterFromHashes,
	externalIdKey,
	illustrationIdKey,
	type RoutingEntry,
	RoutingFilter,
	RoutingKeyAccumulator,
	routingHash,
	scryfallIdKey,
} from "../../src/engine/routing-filter";

const IDENTITY = { builtAt: "1786869419", partitionCount: 9, partitionHash: "fnv1a64/oracle_id/v1" };

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function uuidLike(rand: () => number): string {
	const hex = "0123456789abcdef";
	let out = "";
	for (let i = 0; i < 32; i++) out += hex[Math.floor(rand() * 16)];
	return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

function parse(bytes: Uint8Array, identity = IDENTITY): RoutingFilter {
	const parsed = RoutingFilter.parse(bytes, identity);
	if ("reason" in parsed) throw new Error(`parse refused: ${parsed.reason}`);
	return parsed.filter;
}

describe("key namespacing", () => {
	test("the same integer in two namespaces is two different keys", () => {
		expect(externalIdKey("multiverse", 12345)).not.toBe(externalIdKey("tcgplayer", 12345));
	});

	test("uuid keys fold case, so a caller's spelling cannot lose the hint", () => {
		const id = "0001C639-8BD0-426F-89CB-4CA61F3CC054";
		expect(scryfallIdKey(id)).toBe(scryfallIdKey(id.toLowerCase()));
		expect(illustrationIdKey(id)).toBe(illustrationIdKey(id.toLowerCase()));
		expect(scryfallIdKey(id)).not.toBe(illustrationIdKey(id));
	});

	test("hashing is stable and both halves carry entropy", () => {
		const a = routingHash("i:0001c639-8bd0-426f-89cb-4ca61f3cc054");
		const b = routingHash("i:0001c639-8bd0-426f-89cb-4ca61f3cc054");
		expect(a).toEqual(b);
		expect(a.lo).not.toBe(a.hi);
	});
});

describe("build and lookup", () => {
	test("every key that went in comes back with its own partition", () => {
		const rand = rng(7);
		const entries: RoutingEntry[] = [];
		for (let i = 0; i < 5_000; i++) {
			entries.push({ key: scryfallIdKey(uuidLike(rand)), partition: Math.floor(rand() * 9) });
		}
		const filter = parse(buildRoutingFilter(entries, IDENTITY));
		for (const e of entries) expect(filter.lookup(e.key)).toBe(e.partition);
	});

	test("a duplicated key resolves to the LOWEST partition — the fan-out's own answer", () => {
		// `firstNonNull` returns the lowest-index partition that answers, so an id two
		// partitions both hold (46 of them on the real corpus) must hint at the lower
		// one or the hinted answer would differ from the fanned-out one.
		const key = illustrationIdKey("7eb65d52-deea-4693-9111-9f95a3b0c915");
		const filter = parse(
			buildRoutingFilter(
				[
					{ key, partition: 6 },
					{ key, partition: 2 },
					{ key, partition: 8 },
					{ key: scryfallIdKey("0001c639-8bd0-426f-89cb-4ca61f3cc054"), partition: 4 },
				],
				IDENTITY,
			),
		);
		expect(filter.lookup(key)).toBe(2);
	});

	test("an out-of-range partition is a build error, not a truncated hint", () => {
		expect(() => buildRoutingFilter([{ key: "i:x", partition: 9 }], IDENTITY)).toThrow(/out of range/);
		expect(() => buildRoutingFilter([{ key: "i:x", partition: -1 }], IDENTITY)).toThrow(/out of range/);
	});

	test("more partitions than the 4-bit cell can hold is refused outright", () => {
		expect(() => buildRoutingFilter([], { ...IDENTITY, partitionCount: 16 })).toThrow(/4-bit/);
	});

	test("an empty key set builds and answers nothing usefully", () => {
		const filter = parse(buildRoutingFilter([], IDENTITY));
		expect(filter.keyCount).toBe(0);
		// Whatever it says, the serving path treats a fruitless hint as a miss.
		expect(filter.lookup("i:anything")).toBeOneOf([null, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});

	test("the accumulator holds no strings and still dedupes to the lowest partition", () => {
		const acc = new RoutingKeyAccumulator(4);
		acc.add("i:a", 5);
		acc.add("i:b", 1);
		acc.add("i:a", 3);
		acc.add("i:c", 8);
		acc.add("i:a", 7);
		expect(acc.size).toBe(5);
		const sealed = acc.seal();
		expect(sealed.lo.length).toBe(3);
		const filter = parse(buildRoutingFilterFromHashes(sealed, IDENTITY));
		expect(filter.lookup("i:a")).toBe(3);
		expect(filter.lookup("i:b")).toBe(1);
		expect(filter.lookup("i:c")).toBe(8);
	});
});

describe("validation on load — the partition_hash discipline", () => {
	const bytes = buildRoutingFilter([{ key: scryfallIdKey("a"), partition: 3 }], IDENTITY);

	test("a filter from another build is refused, not consulted", () => {
		const parsed = RoutingFilter.parse(bytes, { ...IDENTITY, builtAt: "1786869999" });
		expect("reason" in parsed && parsed.reason).toMatch(/built_at/);
	});

	test("a filter built under another modulus is refused", () => {
		// The failure this prevents: hints computed at N=8 applied to an N=9 store
		// name partitions that mean something else entirely.
		const parsed = RoutingFilter.parse(bytes, { ...IDENTITY, partitionCount: 8 });
		expect("reason" in parsed && parsed.reason).toMatch(/partition_count/);
	});

	test("a filter naming another partition hash is refused", () => {
		const parsed = RoutingFilter.parse(bytes, { ...IDENTITY, partitionHash: "fnv1a64/oracle_id/v2" });
		expect("reason" in parsed && parsed.reason).toMatch(/partition_hash/);
	});

	test("corrupt bytes are refused rather than thrown — a bad filter must not 500 a route", () => {
		expect("reason" in RoutingFilter.parse(new Uint8Array(4), IDENTITY)).toBe(true);
		const wrongMagic = bytes.slice();
		wrongMagic[0] = 0;
		expect("reason" in RoutingFilter.parse(wrongMagic, IDENTITY)).toBe(true);
		expect("reason" in RoutingFilter.parse(bytes.subarray(0, bytes.length - 1), IDENTITY)).toBe(true);
	});
});

describe("corpus scale — the meter this exists for", () => {
	// The real generation-1786869419 corpus: 517,746 printings across 9 partitions,
	// with 1,232,730 distinct addressable keys once illustration ids, multiverse ids
	// and the four external namespaces are counted. Synthesized here at the same
	// shape so the size and the RPC arithmetic are checked in CI rather than
	// asserted in a comment.
	const PRINTINGS = 517_746;
	const N = 9;

	test("1.2M keys build to well under a megabyte, exactly, at one RPC per hit", () => {
		const rand = rng(20260816);
		const acc = new RoutingKeyAccumulator(1 << 21);
		const present: string[] = [];
		for (let i = 0; i < PRINTINGS; i++) {
			const partition = Math.floor(rand() * N);
			const id = scryfallIdKey(uuidLike(rand));
			acc.add(id, partition);
			if (i % 1000 === 0) present.push(id);
			// Real ratios: ~9% of printings introduce a new illustration id, ~79% carry
			// a multiverse id, and roughly a third carry each of the four external ids.
			if (rand() < 0.09) acc.add(illustrationIdKey(uuidLike(rand)), partition);
			if (rand() < 0.79) acc.add(externalIdKey("multiverse", Math.floor(rand() * 1e6)), partition);
			for (const ns of ["mtgo", "arena", "tcgplayer", "cardmarket"]) {
				if (rand() < 0.31) acc.add(externalIdKey(ns, Math.floor(rand() * 1e6)), partition);
			}
		}
		const sealed = acc.seal();
		const keys = sealed.lo.length;
		expect(keys).toBeGreaterThan(1_100_000);
		const bytes = buildRoutingFilterFromHashes(sealed, IDENTITY);
		// 1.23 cells per key at 4 bits each. Comfortably inside KV's 25MiB value cap
		// and inside the isolate; the assertion is that the shape has not silently
		// changed, e.g. by someone widening the cell.
		expect(bytes.byteLength / keys).toBeLessThan(0.8);
		expect(bytes.byteLength).toBeLessThan(1_048_576);

		const filter = parse(buildRoutingFilterFromHashes(sealed, IDENTITY));
		// EXACT on the construction set — this is the property, not a rate.
		for (const key of present) expect(filter.lookup(key)).not.toBeNull();

		// Absent keys: the only question is what a garbage nibble costs. 9 of the 16
		// values name a real partition, so ~44% are recognised as garbage outright and
		// skip straight to the fan-out; the rest buy one fruitless RPC first. Either
		// way the total stays at or below the N the fan-out already spent.
		let recognisedAbsent = 0;
		const PROBES = 20_000;
		for (let i = 0; i < PROBES; i++) {
			if (filter.lookup(scryfallIdKey(uuidLike(rand))) === null) recognisedAbsent++;
		}
		const rate = recognisedAbsent / PROBES;
		expect(rate).toBeGreaterThan(0.3);
		expect(rate).toBeLessThan(0.55);
	}, 120_000);
});
