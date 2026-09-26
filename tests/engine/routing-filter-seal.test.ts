// Backlog x2: the routing filter's build fits the free plan's 128MB isolate at 2× and 3× the corpus,
// and publishes the SAME BYTES it did before.
//
// The rewrite changed every memory-heavy step of the build — a radix sort in place of the boxed
// comparator sort, exact-length sealed columns, a peel whose queue doubles as its order record, a
// batch parser that hashes keys where they lie in the staged bytes — and none of them may change a
// byte of the published filter: every isolate reads it, and a store generation does not move with
// it. So every case here builds through BOTH the new code and the code it replaced
// (routing-filter-reference.ts, verbatim from 923e5086) and compares the sealed columns and the
// filter bytes.
//
// The real key file is the case that matters. Set ROUTING_KEYS_TSV to a builder's routing-keys.tsv
// (default: this checkout's store-build/routing-keys.tsv, when it exists), and
// ROUTING_KEYS_SCALES=1,2,3 to hold it at 2× and 3× as well — each copy re-keys every line with a
// `#c` suffix, so distinct keys, duplicates and name runs all scale with it. Without the file, the
// synthetic cases below still cover every rule.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildRoutingFilterFromHashes,
	NAME_KEYS_STAMP,
	NAME_TIERS_STAMP,
	RoutingKeyAccumulator,
	routingHash,
	type SealedRoutingKeys,
} from "../../src/engine/routing-filter";
import { ReferenceAccumulator, referenceBuild } from "./routing-filter-reference";

const IDENTITY = { builtAt: "1790000000", partitionCount: 10, partitionHash: "fnv1a64/oracle_id/v1" };

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

type Line = [partition: number, key: string];

/** Both builds over the same lines: sealed columns and filter bytes must agree. Answers the values. */
function expectSameBuild(
	lines: Iterable<Line>,
	partitionCount = IDENTITY.partitionCount,
	features = 0,
	tiers = false,
): SealedRoutingKeys {
	const identity = { ...IDENTITY, partitionCount };
	const ref = new ReferenceAccumulator(16);
	const acc = new RoutingKeyAccumulator(16);
	for (const [p, key] of lines) {
		ref.add(key, p);
		acc.add(key, p);
	}
	const want = ref.seal(partitionCount, tiers);
	const got = acc.seal(partitionCount, tiers);
	expect(got.lo.length).toBe(want.lo.length);
	expect(got.nameKeys).toBe(want.nameKeys);
	expect(Buffer.from(got.lo.buffer, got.lo.byteOffset, got.lo.byteLength).equals(bytesOf(want.lo))).toBe(true);
	expect(Buffer.from(got.hi.buffer, got.hi.byteOffset, got.hi.byteLength).equals(bytesOf(want.hi))).toBe(true);
	expect(Buffer.from(got.values).equals(Buffer.from(want.values))).toBe(true);
	const wantBytes = referenceBuild(want, identity, features);
	const gotBytes = buildRoutingFilterFromHashes(got, identity, features);
	expect(Buffer.from(gotBytes).equals(Buffer.from(wantBytes))).toBe(true);
	return got;
}

function bytesOf(a: Uint32Array): Buffer {
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/**
 * A synthetic corpus shaped like the real one where it matters to the seal: id keys repeated across
 * partitions (illustration ids, shared addresses), and name keys in every configuration the name
 * rule distinguishes — one partition, several with one served, several served, served in one
 * partition only through `ns:`, extras on every tier (`nw:`/`nm:`/`nf:`/`na:`), a partition count where
 * N + s would reach 255.
 */
function* syntheticLines(count: number, seed: number, partitions: number): Generator<Line> {
	const rand = rng(seed);
	const pick = () => Math.floor(rand() * partitions);
	const ids: string[] = [];
	const names: string[] = [];
	for (let i = 0; i < count; i++) {
		const r = rand();
		if (r < 0.55) {
			const id = `i:${Math.floor(rand() * 2 ** 32).toString(16)}-${i}`;
			if (ids.length < 5000) ids.push(id);
			yield [pick(), id];
		} else if (r < 0.7 && ids.length > 0) {
			// A repeat of an earlier id from any partition: the lowest partition must win.
			yield [pick(), ids[Math.floor(rand() * ids.length)] as string];
		} else if (r < 0.85) {
			const name = `${Math.floor(rand() * 2 ** 32).toString(36)}`;
			if (names.length < 5000) names.push(name);
			yield [pick(), `${rand() < 0.5 ? (["nm", "nw", "nf", "na"][Math.floor(rand() * 4)] as string) : "ns"}:${name}`];
		} else if (names.length > 0) {
			const name = names[Math.floor(rand() * names.length)] as string;
			yield [pick(), `${rand() < 0.4 ? "ns" : (["nm", "nw", "nf", "na"][Math.floor(rand() * 4)] as string)}:${name}`];
		} else {
			yield [pick(), `multiverse:${i}`];
		}
	}
}

describe("the rewritten build publishes the reference's bytes", () => {
	test("the empty set and the tiny ones", () => {
		expectSameBuild([]);
		expectSameBuild([[3, "i:a"]]);
		expectSameBuild([
			[3, "i:a"],
			[1, "i:a"],
		]);
		expectSameBuild([
			[2, "nm:opt"],
			[2, "ns:opt"],
			[5, "nm:opt"],
			[7, "i:x"],
		]);
	});

	test("the name rule in every configuration, and the id rule beside it", () => {
		const lines: Line[] = [
			// sole owner, several rows
			[4, "nm:sole"],
			[4, "ns:sole"],
			// two owners, one served → N + s
			[1, "nm:oneserved"],
			[6, "ns:oneserved"],
			// two owners, both served → ambiguous
			[2, "ns:twoserved"],
			[8, "ns:twoserved"],
			// two owners, none served → ambiguous
			[0, "nm:noneserved"],
			[9, "nm:noneserved"],
			// served twice in the same partition, beside an unserved one elsewhere → N + s
			[3, "ns:sameserved"],
			[3, "ns:sameserved"],
			[7, "nm:sameserved"],
			// ids: lowest partition wins whatever the order
			[9, "i:dup"],
			[2, "i:dup"],
			[5, "i:dup"],
		];
		expectSameBuild(lines);
		expectSameBuild([...lines].reverse());
		// A partition count where N + s would reach 255: the served value is refused for ambiguous.
		expectSameBuild(
			[
				[1, "nm:wide"],
				[200, "ns:wide"],
			],
			201,
		);
	});

	// x26: a served name's value carries the highest tier any OTHER partition's extras hold it on —
	// `N + 4s + t`, t 3 whole, 2 face, 1 flavor, 0 none but an art series — so one reply can tell
	// whether another partition's extra outranks it.
	test("the tiered name rule: the served partition, and the other partitions' highest extras tier", () => {
		const N = IDENTITY.partitionCount;
		const lines: Line[] = [
			// `chaos`: Order // Chaos served in 5 (a face), the fj25 front card in 2 (whole) → t = 3
			[5, "ns:chaos"],
			[2, "nw:chaos"],
			// `delverofsecrets`: the transform card served in 7, its art-series faces in 6 → t = 0
			[7, "ns:delverofsecrets"],
			[6, "na:delverofsecrets"],
			// `night`: Night // Day served in 3, the Day // Night token in 0 (a face) → t = 2
			[3, "ns:night"],
			[0, "nm:night"],
			// only a flavor name elsewhere → t = 1
			[1, "ns:flavored"],
			[4, "nf:flavored"],
			// the served partition's OWN whole-name extra is its own reply's business, not a rival:
			// only 3's face counts → t = 2
			[8, "ns:ownextra"],
			[8, "nw:ownextra"],
			[3, "nm:ownextra"],
			// the highest of several rivals, in any order → t = 3
			[0, "nf:several"],
			[9, "ns:several"],
			[4, "nw:several"],
			[6, "nm:several"],
			[2, "na:several"],
			// sole and ambiguous names are what they always were
			[4, "nw:sole"],
			[4, "ns:sole"],
			[2, "ns:twoserved"],
			[8, "ns:twoserved"],
			[3, "nw:twoserved"],
		];
		const tiered = expectSameBuild(lines, N, 3, true);
		expectSameBuild([...lines].reverse(), N, 3, true);
		const untiered = expectSameBuild(lines, N, 1, false);
		const sealedValue = (sealed: SealedRoutingKeys, key: string) => {
			const { lo, hi } = routingHash(key);
			for (let i = 0; i < sealed.lo.length; i++)
				if (sealed.lo[i] === lo && sealed.hi[i] === hi) return sealed.values[i];
			throw new Error(`no ${key}`);
		};
		expect(sealedValue(tiered, "nm:chaos")).toBe(N + 4 * 5 + 3);
		expect(sealedValue(tiered, "nm:delverofsecrets")).toBe(N + 4 * 7 + 0);
		expect(sealedValue(tiered, "nm:night")).toBe(N + 4 * 3 + 2);
		expect(sealedValue(tiered, "nm:flavored")).toBe(N + 4 * 1 + 1);
		expect(sealedValue(tiered, "nm:ownextra")).toBe(N + 4 * 8 + 2);
		expect(sealedValue(tiered, "nm:several")).toBe(N + 4 * 9 + 3);
		expect(sealedValue(tiered, "nm:sole")).toBe(4);
		expect(sealedValue(tiered, "nm:twoserved")).toBe(255);
		// Untiered, the same keys seal as every filter before x26 did: N + s.
		expect(sealedValue(untiered, "nm:chaos")).toBe(N + 5);
		expect(sealedValue(untiered, "nm:several")).toBe(N + 9);
		// Where N + 4s + t would reach 255, the served value is refused for ambiguous.
		const wide = expectSameBuild(
			[
				[1, "nw:wide"],
				[60, "ns:wide"],
			],
			61,
			3,
			true,
		);
		expect([...wide.values]).toEqual([255]);
	});

	test("synthetic sets across the sort's size classes", () => {
		// Sizes that land every radix bucket in the insertion-sort range, at the recursion cutoffs,
		// and well past them.
		for (const [count, seed] of [
			[10, 1],
			[25, 2],
			[300, 3],
			[5_000, 4],
			[70_000, 5],
			[400_000, 6],
		] as const) {
			expectSameBuild(syntheticLines(count, seed, IDENTITY.partitionCount));
			expectSameBuild(syntheticLines(count, seed, IDENTITY.partitionCount), IDENTITY.partitionCount, 3, true);
		}
	});

	test("a cell holding more keys than a byte counts takes the wide counter, and the same bytes", () => {
		// 300 keys share their `lo` half, so their first cell is the SAME cell under every seed — past
		// the one-byte count — among 4,000 ordinary ones that let it peel. Real hashes put ~2.4 keys
		// in a cell.
		const rand = rng(99);
		const n = 4000;
		const sealed = { lo: new Uint32Array(n), hi: new Uint32Array(n), values: new Uint8Array(n) };
		for (let i = 0; i < n; i++) {
			sealed.lo[i] = i < 300 ? 0x1234abcd : Math.floor(rand() * 2 ** 32);
			sealed.hi[i] = Math.floor(rand() * 2 ** 32);
			sealed.values[i] = Math.floor(rand() * 10);
		}
		const want = referenceBuild(sealed, IDENTITY);
		expect(Buffer.from(buildRoutingFilterFromHashes(sealed, IDENTITY)).equals(Buffer.from(want))).toBe(true);
	});

	test("heavy duplication: one key a thousand times, and addresses repeated across every partition", () => {
		const lines: Line[] = [];
		for (let i = 0; i < 1000; i++) lines.push([(i * 7) % 10, "l:everywhere"]);
		for (let i = 0; i < 2000; i++) lines.push([i % 10, `sn:set/${i % 300}`]);
		expectSameBuild(lines);
	});
});

describe("addBatch reads a staged batch exactly as the string path did", () => {
	/** HEAD's stepRouting loop, verbatim: decode, split, `add` per line. */
	function viaStrings(batches: Uint8Array[]): {
		acc: RoutingKeyAccumulator;
		keys: number;
		stamped: number;
		tiered: number;
	} {
		const acc = new RoutingKeyAccumulator(16);
		const decoder = new TextDecoder();
		let keys = 0;
		let stamped = 0;
		let tiered = 0;
		for (const bytes of batches) {
			const text = decoder.decode(bytes);
			if (text.startsWith(`${NAME_TIERS_STAMP}\n`)) tiered++;
			if (text.startsWith(`${NAME_KEYS_STAMP}\n`) || text.startsWith(`${NAME_TIERS_STAMP}\n`)) stamped++;
			let at = 0;
			while (at < text.length) {
				let end = text.indexOf("\n", at);
				if (end === -1) end = text.length;
				if (end > at && text.charCodeAt(at) !== 35) {
					const tab = text.indexOf("\t", at);
					if (tab !== -1 && tab < end) {
						acc.add(text.slice(tab + 1, end), Number(text.slice(at, tab)));
						keys++;
					}
				}
				at = end + 1;
			}
		}
		return { acc, keys, stamped, tiered };
	}

	function viaBytes(batches: Uint8Array[]): {
		acc: RoutingKeyAccumulator;
		keys: number;
		stamped: number;
		tiered: number;
	} {
		const acc = new RoutingKeyAccumulator(16);
		let keys = 0;
		let stamped = 0;
		let tiered = 0;
		for (const bytes of batches) {
			const read = acc.addBatch(bytes);
			keys += read.keys;
			if (read.stamped) stamped++;
			if (read.tiered) tiered++;
		}
		return { acc, keys, stamped, tiered };
	}

	function expectSameRead(texts: string[]): void {
		const enc = new TextEncoder();
		const batches = texts.map((t) => enc.encode(t));
		const a = viaStrings(batches);
		const b = viaBytes(batches);
		expect(b.keys).toBe(a.keys);
		expect(b.stamped).toBe(a.stamped);
		expect(b.tiered).toBe(a.tiered);
		expect(b.acc.size).toBe(a.acc.size);
		const sa = a.acc.seal(80, true);
		const sb = b.acc.seal(80, true);
		expect(bytesOf(sb.lo).equals(bytesOf(sa.lo))).toBe(true);
		expect(bytesOf(sb.hi).equals(bytesOf(sa.hi))).toBe(true);
		expect(Buffer.from(sb.values).equals(Buffer.from(sa.values))).toBe(true);
		expect(sb.nameKeys).toBe(sa.nameKeys);
	}

	test("the shapes the builders write", () => {
		expectSameRead([
			`${NAME_KEYS_STAMP}\n0\ti:00009878-d086-46f0-a964-15734d8368ac\n0\tl:e8a09f86\n3\tmultiverse:433932\n`,
			`${NAME_KEYS_STAMP}\n7\tsn:m21/326\n7\tnm:lightningbolt\n9\tns:lightningbolt\n12\tns:x\n`,
			`${NAME_TIERS_STAMP}\n2\tnw:chaos\n5\tns:chaos\n6\tna:delverofsecrets\n0\tnm:night\n4\tnf:lunch100pm\n`,
			"4\tcardmarket:467859\n5\ttcgplayer:215418", // no stamp, no trailing newline
		]);
	});

	test("everything else a line could be", () => {
		expectSameRead([
			// comments, empty lines, a line with no tab, a tab after the newline
			"# comment\n\n\n5\n6\ti:a\nno-tab-here\n2\ti:b\n",
			// partition fields Number() reads specially, a long digit run, an empty field
			" 3\ti:c\n+4\ti:d\n0x5\ti:e\n1e0\ti:f\n\ti:g\n0000000000007\ti:h\nx\ti:i\n",
			// non-ASCII keys (the Japanese flavor names), keys with tabs in them, CR before LF
			"1\tnm:ドラゴン\n2\tns:café\n3\ti:has\ttab\n4\ti:crlf\r\n",
			// `nm`/`ns` lookalikes that are not the name namespaces
			"1\tnm\n2\tns\n3\tnmx:a\n4\tn:m\n5\tnq:a\n6\tns:\n7\tnm:\n8\tnw\n9\tnf:\n10\tnwx:a\n11\tna\n12\tnb:a\n",
			// a stamp that is not the first line, and one without its newline
			`1\ti:z\n${NAME_KEYS_STAMP}\n`,
			NAME_KEYS_STAMP,
			`1\ti:z\n${NAME_TIERS_STAMP}\n`,
			NAME_TIERS_STAMP,
			// an `ns:` key longer than the respelling scratch starts at
			`8\tns:${"a".repeat(600)}\n9\tnm:${"a".repeat(600)}\n10\tnw:${"a".repeat(700)}\n`,
		]);
	});
});

describe("the accumulator after sealing", () => {
	test("is spent: nothing can be added, and it cannot seal twice", () => {
		const acc = new RoutingKeyAccumulator(4);
		acc.add("i:a", 1);
		acc.seal();
		expect(() => acc.add("i:b", 2)).toThrow(/sealed/);
		expect(() => acc.seal()).toThrow(/sealed/);
	});

	test("hands back exact-length columns, not views of its capacity", () => {
		const acc = new RoutingKeyAccumulator(1000);
		for (let i = 0; i < 100; i++) acc.add(`i:${i % 40}`, i % 10);
		const sealed = acc.seal();
		expect(sealed.lo.length).toBe(40);
		expect(sealed.lo.buffer.byteLength).toBe(40 * 4);
		expect(sealed.hi.buffer.byteLength).toBe(40 * 4);
		expect(sealed.values.buffer.byteLength).toBe(40);
	});
});

// ── The real key file ─────────────────────────────────────────────────────────

const REAL_TSV = process.env.ROUTING_KEYS_TSV ?? join(import.meta.dir, "../../store-build/routing-keys.tsv");
const REAL_SCALES = (process.env.ROUTING_KEYS_SCALES ?? "1").split(",").map(Number);

describe.skipIf(!existsSync(REAL_TSV))(`the real key file (${REAL_TSV})`, () => {
	for (const scale of REAL_SCALES) {
		test(`${scale}× — staged in batches the way the scores pass stages them, built both ways`, () => {
			const text = readFileSync(REAL_TSV, "utf8");
			const stamp = [NAME_TIERS_STAMP, NAME_KEYS_STAMP].find((st) => text.startsWith(`${st}\n`)) ?? null;
			const stamped = stamp !== null;
			const tiers = stamp === NAME_TIERS_STAMP;
			const body = stamped ? text.slice(stamp.length + 1) : text;
			const partitionCount = partitionCountOf(body);
			// Batches of ~1,620 lines (1.91M lines / the scores pass's ~1,180 draft batches), each
			// opening with the stamp when the file carries it. Copy c > 0 suffixes every key.
			const enc = new TextEncoder();
			const batches: Uint8Array[] = [];
			let lines = 0;
			for (let c = 0; c < scale; c++) {
				const copy = c === 0 ? body : body.replace(/\n(?=.)/g, `#${c}\n`).replace(/([^\n])$/, `$1#${c}`);
				let at = 0;
				while (at < copy.length) {
					let end = at;
					for (let k = 0; k < 1620 && end !== -1; k++) end = copy.indexOf("\n", end + 1);
					if (end === -1) end = copy.length;
					batches.push(enc.encode(`${stamped ? `${stamp}\n` : ""}${copy.slice(at, end + 1)}`));
					at = end + 1;
				}
			}
			for (const b of batches) for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) lines++;

			// Reference: HEAD's string loop and HEAD's construction.
			const ref = new ReferenceAccumulator(lines);
			const decoder = new TextDecoder();
			let refStamped = 0;
			for (const b of batches) {
				const t = decoder.decode(b);
				if (stamp !== null && t.startsWith(`${stamp}\n`)) refStamped++;
				let at = 0;
				while (at < t.length) {
					let end = t.indexOf("\n", at);
					if (end === -1) end = t.length;
					if (end > at && t.charCodeAt(at) !== 35) {
						const tab = t.indexOf("\t", at);
						if (tab !== -1 && tab < end) ref.add(t.slice(tab + 1, end), Number(t.slice(at, tab)));
					}
					at = end + 1;
				}
			}
			const features = refStamped === batches.length ? (tiers ? 3 : 1) : 0;
			const identity = { ...IDENTITY, partitionCount };
			const want = referenceBuild(ref.seal(partitionCount, features === 3), identity, features);

			// This branch: addBatch, the radix seal, the lean peel.
			const acc = new RoutingKeyAccumulator(lines);
			let accStamped = 0;
			for (const b of batches) if (acc.addBatch(b).stamped) accStamped++;
			expect(accStamped).toBe(refStamped);
			expect(acc.grows).toBe(0);
			const sealed = acc.seal(partitionCount, features === 3);
			const got = buildRoutingFilterFromHashes(sealed, identity, features);
			console.log(
				`real key file ×${scale}: ${lines} lines, ${sealed.lo.length} distinct keys ` +
					`(${sealed.nameKeys} names), ${got.byteLength} filter bytes, identical=${Buffer.from(got).equals(Buffer.from(want))}`,
			);
			expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true);
		}, 120_000);
	}
});

function partitionCountOf(body: string): number {
	let max = 0;
	let at = 0;
	while (at < body.length) {
		const tab = body.indexOf("\t", at);
		if (tab === -1) break;
		const p = Number(body.slice(at, tab));
		if (p > max) max = p;
		const end = body.indexOf("\n", tab);
		if (end === -1) break;
		at = end + 1;
	}
	return max + 1;
}
