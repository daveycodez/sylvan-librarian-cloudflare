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
	nameKey,
	ROUTING_FEATURE_NAME_KEYS,
	ROUTING_FEATURE_NAME_TIERS,
	ROUTING_FILTER_MAGIC_V1,
	type RoutingEntry,
	RoutingFilter,
	RoutingKeyAccumulator,
	routingHash,
	scryfallIdKey,
	setNumberKey,
} from "../../src/engine/routing-filter";
import { MAX_PARTITION_COUNT } from "../../src/import-publish";

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

describe("the address key", () => {
	// WIRE FORMAT, shared with engine/builder/src/transform.rs's `set_number_routing_key` — the Rust
	// test `address_routing_key_is_spelled_like_the_router_spells_it` pins the same literals.
	test("is the set lowercased and the collector number exactly as written", () => {
		expect(setNumberKey("LEA", "161")).toBe("sn:lea/161");
		expect(setNumberKey("war", "184★")).toBe("sn:war/184★");
		expect(setNumberKey("10e", "A-42")).toBe("sn:10e/A-42");
	});
});

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

	test("more partitions than the 8-bit cell can hold is refused outright", () => {
		expect(() => buildRoutingFilter([], { ...IDENTITY, partitionCount: 256 })).toThrow(/8-bit/);
	});

	test("last night's SRF1 filter is still read, so a deploy does not fan out until the next publish", () => {
		// The previous layout packed two 4-bit cells per byte under magic "SRF1". Built here by hand
		// from an SRF2 filter's cells, since this build only writes SRF2.
		const entries = [
			{ key: scryfallIdKey("a"), partition: 3 },
			{ key: scryfallIdKey("b"), partition: 7 },
			{ key: illustrationIdKey("c"), partition: 1 },
		];
		const v2 = buildRoutingFilter(entries, IDENTITY);
		const view = new DataView(v2.buffer, v2.byteOffset, v2.byteLength);
		const blockLength = view.getUint32(8, true);
		const cellsAt = 40 + view.getUint32(20, true) + view.getUint32(24, true);
		const cells = v2.subarray(cellsAt);
		const packed = new Uint8Array(cellsAt + ((blockLength * 3 + 1) >> 1));
		packed.set(v2.subarray(0, cellsAt));
		new DataView(packed.buffer).setUint32(0, ROUTING_FILTER_MAGIC_V1, false);
		for (let i = 0; i < cells.length; i += 2) {
			packed[cellsAt + (i >> 1)] = ((cells[i] as number) & 0xf) | (((cells[i + 1] ?? 0) & 0xf) << 4);
		}
		const filter = parse(packed);
		for (const e of entries) expect(filter.lookup(e.key)).toBe(e.partition);
	});

	test("a filter over more than fifteen partitions round-trips", () => {
		// SRF1 packed two 4-bit cells per byte and refused partition_count 16, while the build allowed
		// up to 32 partitions — corpus growth would have hit it. SRF2 is one byte per cell.
		const identity = { ...IDENTITY, partitionCount: 40 };
		const entries = Array.from({ length: 200 }, (_, i) => ({ key: scryfallIdKey(`id-${i}`), partition: i % 40 }));
		const parsed = RoutingFilter.parse(buildRoutingFilter(entries, identity), identity);
		if ("reason" in parsed) throw new Error(parsed.reason);
		for (const e of entries) expect(parsed.filter.lookup(e.key)).toBe(e.partition);
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

	test("1.2M keys build to under two megabytes, exactly, at one RPC per hit", () => {
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
		// 1.23 cells per key at one BYTE each (SRF2). Comfortably inside KV's 25MiB value cap
		// and inside the isolate; the assertion is that the shape has not silently changed
		// again, e.g. by someone widening the cell past a byte.
		expect(bytes.byteLength / keys).toBeLessThan(1.3);
		expect(bytes.byteLength).toBeLessThan(2 * 1_048_576);

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

describe("name keys (backlog n6)", () => {
	// WIRE FORMAT, shared with engine/builder/src/transform.rs's `name_routing_keys_of` — the Rust
	// test `name_routing_keys_are_spelled_like_the_router_spells_them` pins the same literals.
	test("the key is `nm:` + the collated folded name", () => {
		expect(nameKey("lim-dul's vault")).toBe("nm:limdulsvault");
		expect(nameKey("fire // ice")).toBe("nm:fireice");
		expect(nameKey("fire")).toBe("nm:fire");
		expect(nameKey("who // what // when // where // why")).toBe("nm:whowhatwhenwherewhy");
		expect(nameKey("godzilla, primeval champion")).toBe("nm:godzillaprimevalchampion");
	});

	const named = (entries: RoutingEntry[], identity = IDENTITY) =>
		parse(buildRoutingFilter(entries, identity, ROUTING_FEATURE_NAME_KEYS), identity);

	test("seal: one partition is `sole`; several with ONE served is `served`; anything else asks everyone", () => {
		const filter = named([
			// Every printing of a card repeats its name — one partition, however many lines.
			{ key: "ns:opt", partition: 4 },
			{ key: "ns:opt", partition: 4 },
			{ key: "nm:opt", partition: 4 },
			// Extras only, one partition: still sole.
			{ key: "nm:cabbages", partition: 7 },
			// The real card served in 6, its art-series face in 1 and 2: served 6.
			{ key: "nm:brainstorm", partition: 1 },
			{ key: "ns:brainstorm", partition: 6 },
			{ key: "nm:brainstorm", partition: 2 },
			{ key: "nm:brainstorm", partition: 6 },
			// Served in two partitions: undecidable.
			{ key: "ns:fire", partition: 3 },
			{ key: "ns:fire", partition: 5 },
			// Extras in two, served nowhere: undecidable.
			{ key: "nm:token", partition: 0 },
			{ key: "nm:token", partition: 8 },
		]);
		expect(filter.hasNameKeys).toBe(true);
		expect(filter.lookupName("nm:opt")).toEqual({ sole: 4 });
		expect(filter.lookupName("nm:cabbages")).toEqual({ sole: 7 });
		expect(filter.lookupName("nm:brainstorm")).toEqual({ served: 6 });
		expect(filter.lookupName("nm:fire")).toBeNull();
		expect(filter.lookupName("nm:token")).toBeNull();
	});

	// Backlog n13. WIRE FORMAT with `a_face_flavor_name_is_one_joined_key` in
	// engine/builder/src/transform.rs: the builders key a face-level flavor name by the JOIN of its
	// faces' names, and the route hands the router the needle folded — so `nameKey` of the folded
	// join must be the key the builder wrote, and one face alone must not be.
	test("a face-level flavor name's key is its folded join, collated — sole or served like any name", () => {
		expect(nameKey("megatron // megatron")).toBe("nm:megatronmegatron");
		expect(nameKey("chucky")).toBe("nm:chucky");
		expect(nameKey("recyclops, eco-friendly // recyclops, nature’s vengeance")).toBe(
			"nm:recyclopsecofriendlyrecyclopsnaturesvengeance",
		);
		const filter = named([
			{ key: "ns:megatronmegatron", partition: 3 },
			{ key: "ns:chucky", partition: 1 },
			{ key: "ns:recyclopsecofriendlyrecyclopsnaturesvengeance", partition: 8 },
			// The same join served in 5 and held as an extra in 2: `served`, as for any name.
			{ key: "ns:harnessface", partition: 5 },
			{ key: "nm:harnessface", partition: 2 },
		]);
		expect(filter.lookupName(nameKey("megatron // megatron") as string)).toEqual({ sole: 3 });
		expect(filter.lookupName(nameKey("chucky") as string)).toEqual({ sole: 1 });
		expect(filter.lookupName(nameKey("recyclops, eco-friendly // recyclops, nature's vengeance") as string)).toEqual({
			sole: 8,
		});
		expect(filter.lookupName("nm:harnessface")).toEqual({ served: 5 });
	});

	test("id keys keep the lowest partition beside name keys", () => {
		const filter = named([
			{ key: scryfallIdKey("a"), partition: 5 },
			{ key: scryfallIdKey("a"), partition: 2 },
			{ key: "ns:opt", partition: 4 },
		]);
		expect(filter.lookup(scryfallIdKey("a"))).toBe(2);
		expect(filter.lookupName("nm:opt")).toEqual({ sole: 4 });
	});

	test("a served value that would not fit the byte is stored as undecidable, never wrapped", () => {
		const wide = { ...IDENTITY, partitionCount: 200 };
		const filter = named(
			[
				{ key: "ns:big", partition: 100 },
				{ key: "nm:big", partition: 3 },
				{ key: "ns:small", partition: 20 },
				{ key: "nm:small", partition: 3 },
			],
			wide,
		);
		expect(filter.lookupName("nm:big")).toBeNull();
		expect(filter.lookupName("nm:small")).toEqual({ served: 20 });
	});

	test("at the build's partition ceiling every partition can answer `sole` AND `served`", () => {
		// A name served in partition s is stored as N + s, one byte a cell with 255 reserved — so the
		// last partition's served value, 2N - 1, fits only while N <= 127. Built AT the ceiling
		// src/import-sizing.ts can choose, so raising MAX_PARTITION_COUNT past the encoding fails here
		// rather than quietly turning the top partitions' served names into full fan-outs.
		const n = MAX_PARTITION_COUNT;
		expect(2 * n - 1).toBeLessThan(255);
		const identity = { ...IDENTITY, partitionCount: n };
		const entries: RoutingEntry[] = [];
		for (let p = 0; p < n; p++) {
			entries.push({ key: scryfallIdKey(`id-${p}`), partition: p });
			entries.push({ key: `ns:sole${p}`, partition: p });
			entries.push({ key: `ns:served${p}`, partition: p });
			entries.push({ key: `nm:served${p}`, partition: (p + 1) % n });
		}
		const filter = named(entries, identity);
		for (let p = 0; p < n; p++) {
			expect(filter.lookup(scryfallIdKey(`id-${p}`))).toBe(p);
			expect(filter.lookupName(`nm:sole${p}`)).toEqual({ sole: p });
			expect(filter.lookupName(`nm:served${p}`)).toEqual({ served: p });
		}
	});

	// x26: the builders spell an extras row's tier (`nw:` whole, `nm:` face, `nf:` flavor, `na:` an
	// art series), and a filter built from batches that all do values a served name N + 4s + t — t
	// the highest tier (3/2/1) any OTHER partition's extras hold it on, 0 for none but art series — so
	// the router can tell a final served reply from one an extra elsewhere outranks (`exact=chaos`).
	const tieredFilter = (entries: RoutingEntry[], identity = IDENTITY) =>
		parse(buildRoutingFilter(entries, identity, ROUTING_FEATURE_NAME_KEYS | ROUTING_FEATURE_NAME_TIERS), identity);

	test("tiers: a served name carries the other partitions' highest extras tier as `rival`", () => {
		const entries: RoutingEntry[] = [
			{ key: "ns:chaos", partition: 5 },
			{ key: "nw:chaos", partition: 2 },
			{ key: "ns:delverofsecrets", partition: 7 },
			{ key: "na:delverofsecrets", partition: 6 },
			{ key: "ns:night", partition: 3 },
			{ key: "nm:night", partition: 0 },
			{ key: "ns:lunch", partition: 1 },
			{ key: "nf:lunch", partition: 4 },
			// The served partition's own whole-name extra is not a rival: only 3's face is.
			{ key: "ns:illusion", partition: 8 },
			{ key: "nw:illusion", partition: 8 },
			{ key: "nm:illusion", partition: 3 },
			{ key: "nw:cabbages", partition: 7 },
			{ key: "nw:token", partition: 0 },
			{ key: "nf:token", partition: 8 },
		];
		const filter = tieredFilter(entries);
		expect(filter.lookupName("nm:chaos")).toEqual({ served: 5, rival: 3 });
		expect(filter.lookupName("nm:delverofsecrets")).toEqual({ served: 7, rival: 0 });
		expect(filter.lookupName("nm:night")).toEqual({ served: 3, rival: 2 });
		expect(filter.lookupName("nm:lunch")).toEqual({ served: 1, rival: 1 });
		expect(filter.lookupName("nm:illusion")).toEqual({ served: 8, rival: 2 });
		expect(filter.lookupName("nm:cabbages")).toEqual({ sole: 7 });
		expect(filter.lookupName("nm:token")).toBeNull();
		// The same keys in a filter without the tiers bit read as every filter before x26 did.
		const untiered = named(entries);
		expect(untiered.lookupName("nm:chaos")).toEqual({ served: 5 });
		expect(untiered.lookupName("nm:illusion")).toEqual({ served: 8 });
	});

	test("tiers: every name spelling hashes as `nm:`", () => {
		const acc = new RoutingKeyAccumulator(4);
		for (const k of ["ns:opt", "nw:opt", "nm:opt", "nf:opt", "na:opt"]) acc.add(k, 1);
		const sealed = acc.seal(IDENTITY.partitionCount, true);
		expect(sealed.lo.length).toBe(1);
		const h = routingHash("nm:opt");
		expect([sealed.lo[0], sealed.hi[0]]).toEqual([h.lo, h.hi]);
	});

	test("tiers: at the build's partition ceiling every partition's served value fits, rival 3 included", () => {
		// N + 4s + t reaches 5N - 1 for the last partition's whole-name rival, so tiers fit while
		// N <= 51; MAX_PARTITION_COUNT raised past that fails here rather than silently fanning out.
		const n = MAX_PARTITION_COUNT;
		expect(5 * n - 1).toBeLessThan(255);
		const identity = { ...IDENTITY, partitionCount: n };
		const entries: RoutingEntry[] = [];
		for (let p = 0; p < n; p++) {
			entries.push({ key: `ns:served${p}`, partition: p });
			entries.push({ key: `nw:served${p}`, partition: (p + 1) % n });
		}
		const filter = tieredFilter(entries, identity);
		for (let p = 0; p < n; p++) expect(filter.lookupName(`nm:served${p}`)).toEqual({ served: p, rival: 3 });
	});

	test("the features word gates every name answer: a filter built without it — or before it — says nothing", () => {
		const entries = [{ key: "ns:opt", partition: 4 }];
		const unstamped = parse(buildRoutingFilter(entries, IDENTITY));
		expect(unstamped.hasNameKeys).toBe(false);
		expect(unstamped.lookupName("nm:opt")).toBeNull();
		// The byte at offset 28 is the whole difference; an SRF2 filter from before it was written
		// carries a zero there and reads as unstamped.
		const stamped = buildRoutingFilter(entries, IDENTITY, ROUTING_FEATURE_NAME_KEYS);
		expect(new DataView(stamped.buffer).getUint32(28, true)).toBe(ROUTING_FEATURE_NAME_KEYS);
		const zeroed = stamped.slice();
		new DataView(zeroed.buffer).setUint32(28, 0, true);
		expect(parse(zeroed).lookupName("nm:opt")).toBeNull();
		expect(parse(stamped).lookupName("nm:opt")).toEqual({ sole: 4 });
	});

	test("`ns:` hashes as `nm:` — the lookup side only ever asks `nm:`", () => {
		const acc = new RoutingKeyAccumulator(2);
		acc.add("ns:opt", 1);
		acc.add("nm:opt", 1);
		const sealed = acc.seal(IDENTITY.partitionCount);
		expect(sealed.lo.length).toBe(1);
		expect(sealed.nameKeys).toBe(1);
		const h = routingHash("nm:opt");
		expect([sealed.lo[0], sealed.hi[0]]).toEqual([h.lo, h.hi]);
	});

	test("sealing name keys needs the partition count", () => {
		const acc = new RoutingKeyAccumulator();
		acc.add("nm:opt", 1);
		expect(() => acc.seal()).toThrow(/partition count/);
	});

	test("an honest capacity hint never grows the columns", () => {
		const acc = new RoutingKeyAccumulator(100);
		for (let i = 0; i < 100; i++) acc.add(scryfallIdKey(String(i)), i % 9);
		expect(acc.grows).toBe(0);
		acc.add(scryfallIdKey("one too many"), 0);
		expect(acc.grows).toBe(1);
	});
});
