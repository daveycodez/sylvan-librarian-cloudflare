// An artwork two cards share, across partitions: `unique=art` answers it as ONE row whichever
// cards print it (api.scryfall.com, measured 2026-10-10 — card_engine's `shared_rank_key` carries
// the numbers), and two cards are two oracle ids, which the store's cut puts in any two
// partitions, so the gather is what makes it one. Each partition answers the query WITHOUT the
// printings of such artworks and sends its best printing of each as a candidate beside the keys,
// with the artwork's identity; the coordinator keeps the candidate with the smallest rank for
// each identity, merges its key in like any other, counts it once and fetches its row.
//
// The engine half — which printing a partition offers, and that the cut answers what one archive
// does over real cards — is engine/builder/tests/shared_artworks.rs. This is the coordinator's
// half, on synthetic packets: the wire, the choice, the place, the total and the pages.

import { describe, expect, test } from "bun:test";
import {
	type ArtlessCandidate,
	DEEP_OFFSET_PROBE,
	decodeKeyPacket,
	encodeKeyPacket,
	encodeRowPacket,
	KEY_PACKET_FLAG_ARTLESS,
	KEY_PACKET_FLAG_SHARED,
	type KeyEntry,
	mergeApart,
	mergeKeyStreams,
	NOT_INLINE,
	type PartitionClient,
	parseSlots,
	pickShared,
	ROWS_GATHER,
	runTwoPhase,
	type SharedCandidate,
} from "../../src/engine/gather";
import type { EngineSearchOptions } from "../../src/engine/types";

const bytes = (...b: number[]) => new Uint8Array(b);
const rowBytes = (row: unknown) => new TextEncoder().encode(JSON.stringify(row));
/** A 16-byte identity for artwork `n`. */
const artOf = (n: number) => new Uint8Array(16).fill(n & 0xff).map((b, i) => (i === 0 ? n >>> 8 : b));

describe("the shared-artwork trailer on the phase-1 packet", () => {
	const entries: KeyEntry[] = [
		{ key: bytes(1, 2), vpid: 5 },
		{ key: bytes(3), vpid: 6 },
	];
	const shared: SharedCandidate[] = [
		{ art: artOf(1), rank: bytes(0, 0, 9), key: bytes(2, 0xff), vpid: 4_000_000_001 },
		{ art: artOf(2), rank: bytes(0, 2), key: bytes(0), vpid: 7 },
	];
	const artless: ArtlessCandidate = { rank: bytes(0, 4), key: bytes(9), vpid: 3 };

	test("round-trips beside keys, inline rows and the art-less candidate, and sets its flag", () => {
		const packed = encodeKeyPacket({
			total: 2,
			entries,
			inlineRows: [rowBytes({ name: "a" })],
			widened: true,
			artless,
			shared,
		});
		expect(new DataView(packed.buffer).getUint32(16, true)).toBe(1 | KEY_PACKET_FLAG_ARTLESS | KEY_PACKET_FLAG_SHARED);
		const decoded = decodeKeyPacket(packed);
		// The candidates are in neither the total nor the entries.
		expect(decoded.total).toBe(2);
		expect(decoded.entries.length).toBe(2);
		expect(decoded.inlineRows.length).toBe(1);
		expect(decoded.artless?.vpid).toBe(3);
		expect(decoded.shared?.length).toBe(2);
		expect(decoded.shared?.map((c) => [[...c.art], [...c.rank], [...c.key], c.vpid])).toEqual(
			shared.map((c) => [[...c.art], [...c.rank], [...c.key], c.vpid]),
		);
		// Without the art-less one, the trailer follows the inline rows directly.
		const alone = decodeKeyPacket(encodeKeyPacket({ total: 2, entries, shared }));
		expect(alone.artless).toBeUndefined();
		expect(alone.shared?.length).toBe(2);
	});

	test("a packet without a candidate is byte for byte the packet it always was", () => {
		// What lets two builds either side of this change serve side by side: only a `unique=art`
		// query matching a printing of a shared artwork produces bytes an older decoder refuses.
		const plain = encodeKeyPacket({ total: 2, entries, shared: [] });
		expect(plain).toEqual(encodeKeyPacket({ total: 2, entries }));
		expect(new DataView(plain.buffer).getUint32(16, true)).toBe(0);
		expect("shared" in decodeKeyPacket(plain)).toBe(false);
	});

	test("a truncated trailer, bytes after it, and a flag with nothing behind it fail loudly", () => {
		const packed = encodeKeyPacket({ total: 2, entries, shared });
		const trailer = 2 + shared.reduce((s, c) => s + 16 + 2 + c.rank.byteLength + 2 + c.key.byteLength + 4, 0);
		for (let cut = 1; cut <= trailer; cut++) {
			expect(() => decodeKeyPacket(packed.subarray(0, packed.length - cut))).toThrow(/truncated|trailing/);
		}
		const padded = new Uint8Array(packed.length + 1);
		padded.set(packed);
		expect(() => decodeKeyPacket(padded)).toThrow(/trailing/);
		// A count of zero under the flag is not a packet the engine writes.
		const none = encodeKeyPacket({ total: 2, entries });
		const flagged = new Uint8Array(none.length + 2);
		flagged.set(none);
		new DataView(flagged.buffer).setUint32(16, KEY_PACKET_FLAG_SHARED, true);
		expect(() => decodeKeyPacket(flagged)).toThrow(/counts no candidate/);
		expect(() =>
			encodeKeyPacket({ total: 0, entries: [], shared: [{ ...shared[0], art: bytes(1, 2) } as SharedCandidate] }),
		).toThrow(/16 bytes/);
	});

	test("a trailer whose flag is not set is trailing bytes — what a build before the flag sees", () => {
		const packed = encodeKeyPacket({ total: 2, entries, shared });
		new DataView(packed.buffer).setUint32(16, 0, true);
		expect(() => decodeKeyPacket(packed)).toThrow(/trailing/);
	});
});

describe("choosing and placing the rows of the artworks two cards share", () => {
	const c = (art: number, rank: number[], key = 1, vpid = 0): SharedCandidate => ({
		art: artOf(art),
		rank: bytes(...rank),
		key: bytes(key),
		vpid,
	});

	test("the smallest rank represents each artwork; the lower partition on a tie; none is none", () => {
		expect(pickShared([undefined, undefined])).toEqual([]);
		expect(pickShared([])).toEqual([]);
		expect(pickShared([[], undefined])).toEqual([]);
		const picked = pickShared([[c(1, [5]), c(2, [1])], undefined, [c(1, [3, 9]), c(3, [7])], [c(1, [4]), c(2, [1])]]);
		const of = (art: number) => picked.find((p) => p.candidate.art[1] === (art & 0xff))?.partition;
		expect(picked.length).toBe(3);
		expect(of(1)).toBe(2);
		// A tie: the lower partition.
		expect(of(2)).toBe(0);
		expect(of(3)).toBe(2);
		// A prefix ranks first, as memcmp says.
		expect(pickShared([[c(1, [3, 0])], [c(1, [3])]])[0]?.partition).toBe(1);
		// Identities are compared whole: two that differ in their first byte are two artworks.
		expect(pickShared([[c(0x101, [1])], [c(0x201, [1])]]).length).toBe(2);
	});

	test("each row merges in by its own key and comes out owned by the partition that sent it", () => {
		const streams: KeyEntry[][] = [
			[
				{ key: bytes(10), vpid: 0 },
				{ key: bytes(40), vpid: 1 },
			],
			[
				{ key: bytes(20), vpid: 0 },
				{ key: bytes(50), vpid: 1 },
			],
		];
		// Artwork 1: partition 0's candidate ranks second and sorts first; partition 1's is the row.
		// Artwork 2: only partition 0 holds it. And the art-less group, from partition 1.
		const shared = [[c(1, [2], 5, 77), c(2, [0], 60, 66)], [c(1, [1], 30, 88)]];
		const artless = [undefined, { rank: bytes(0), key: bytes(15), vpid: 99 }];
		const { merged, apart } = mergeApart(streams, artless, shared);
		expect(apart).toBe(3);
		expect(merged).toEqual([
			{ partition: 0, vpid: 0, index: 0 },
			{ partition: 1, vpid: 99, index: NOT_INLINE },
			{ partition: 1, vpid: 0, index: 0 },
			{ partition: 1, vpid: 88, index: NOT_INLINE },
			{ partition: 0, vpid: 1, index: 1 },
			{ partition: 1, vpid: 1, index: 1 },
			{ partition: 0, vpid: 66, index: NOT_INLINE },
		]);
	});

	test("with no candidate the merge is the merge", () => {
		const streams: KeyEntry[][] = [[{ key: bytes(2), vpid: 0 }], [{ key: bytes(1), vpid: 0 }]];
		expect(mergeApart(streams, [undefined, undefined], [undefined, []])).toEqual({
			merged: mergeKeyStreams(streams),
			apart: 0,
		});
	});
});

describe("the two-phase run over artworks two cards share", () => {
	const OPTS: EngineSearchOptions = {
		filterTreeJson: "{}",
		unique: "artwork",
		prefer: "default",
		orderby: "name",
		direction: "asc",
		limit: 100,
		offset: 0,
		fields: ["name"],
	};

	/** One partition's printings: a sort key each; for a printing of a shared artwork, which artwork and its rank. */
	interface Printing {
		key: number;
		art?: number;
		rank?: number;
		/** An art-less printing: the one group, ranked. */
		artless?: number;
	}

	/**
	 * A partition as the engine answers under `unique=art`: its other rows paged and counted as the
	 * query without the printings kept apart, the first `inlineRows` of the page carried — and its
	 * best printing of each shared artwork, and of the art-less group, as candidates, whatever the page.
	 */
	function partition(p: number, printings: Printing[], log: string[] = []): PartitionClient {
		const storeKey = `card-store-v1-100-p${p}.store`;
		const rows = printings.map((printing, vpid) => ({ ...printing, vpid })).sort((a, b) => a.key - b.key);
		const plain = rows.filter((r) => r.art === undefined && r.artless === undefined);
		const best = new Map<number, (typeof rows)[number]>();
		for (const r of rows) {
			if (r.art === undefined) continue;
			const held = best.get(r.art);
			if (!held || (r.rank as number) < (held.rank as number)) best.set(r.art, r);
		}
		const artless = rows
			.filter((r) => r.artless !== undefined)
			.sort((a, b) => (a.artless as number) - (b.artless as number))[0];
		return {
			async searchKeys(opts, inlineRows, shaping) {
				log.push(`keys:${p}:inline=${inlineRows}`);
				const window = plain.slice(opts.offset, opts.offset + opts.limit);
				return {
					packed: encodeKeyPacket({
						total: plain.length,
						entries: window.map((r) => ({ key: bytes(r.key), vpid: r.vpid })),
						inlineRows: window.slice(0, inlineRows).map((r) => rowBytes({ name: `p${p}k${r.key}` })),
						...(artless
							? { artless: { rank: bytes(artless.artless as number), key: bytes(artless.key), vpid: artless.vpid } }
							: {}),
						shared: [...best.entries()]
							.sort(([a], [b]) => a - b)
							.map(([art, r]) => ({ art: artOf(art), rank: bytes(r.rank as number), key: bytes(r.key), vpid: r.vpid })),
					}),
					storeKey,
					sortKeyVersion: 1,
					shape: shaping.shape,
				};
			},
			async fetchRows(vpids, _fields, pinnedKey, shaping) {
				log.push(`rows:${p}:${vpids.join(".")}`);
				if (pinnedKey !== storeKey) throw new Error("generation mismatch");
				return {
					rowsBytes: encodeRowPacket(vpids.map((v) => rowBytes({ name: `p${p}k${(printings[v] as Printing).key}` }))),
					shape: shaping.shape,
				};
			},
		};
	}

	/** What ONE archive holding every partition's printings answers: the reference. */
	function reference(parts: Printing[][], offset: number, limit: number) {
		const all = parts.flatMap((printings, p) => printings.map((printing) => ({ ...printing, p })));
		const rows = all.filter((r) => r.art === undefined && r.artless === undefined);
		const best = new Map<number, (typeof all)[number]>();
		for (const r of all) {
			if (r.art === undefined) continue;
			const held = best.get(r.art);
			if (!held || (r.rank as number) < (held.rank as number)) best.set(r.art, r);
		}
		rows.push(...best.values());
		rows.push(
			...all
				.filter((r) => r.artless !== undefined)
				.sort((a, b) => (a.artless as number) - (b.artless as number))
				.slice(0, 1),
		);
		rows.sort((a, b) => a.key - b.key);
		return { total: rows.length, rows: rows.slice(offset, offset + limit).map((r) => ({ name: `p${r.p}k${r.key}` })) };
	}

	async function run(parts: Printing[][], opts: EngineSearchOptions, log: string[] = []) {
		const page = await runTwoPhase(
			parts.map((printings, p) => partition(p, printings, log)),
			opts,
			ROWS_GATHER,
		);
		return { total: page.total, rows: parseSlots(page.slots) };
	}

	// Three partitions. Artwork 1 is on a card in each of p0 and p1 (p1's key-35 printing is its
	// representative); artwork 2 on cards in p1 and p2; artwork 3 on two cards of p2 alone.
	const PARTS: Printing[][] = [
		[{ key: 10 }, { key: 40 }, { key: 5, art: 1, rank: 3 }, { key: 90, art: 1, rank: 9 }],
		[{ key: 20 }, { key: 50 }, { key: 35, art: 1, rank: 1 }, { key: 1, art: 2, rank: 8 }],
		[
			{ key: 30 },
			{ key: 60 },
			{ key: 99, art: 2, rank: 2 },
			{ key: 45, art: 3, rank: 4 },
			{ key: 46, art: 3, rank: 5 },
		],
	];

	test("three partitions' printings of three shared artworks are three rows, in their places, counted once each", async () => {
		const log: string[] = [];
		const { total, rows } = await run(PARTS, OPTS, log);
		expect(rows).toEqual([
			{ name: "p0k10" },
			{ name: "p1k20" },
			{ name: "p2k30" },
			{ name: "p1k35" },
			{ name: "p0k40" },
			{ name: "p2k45" },
			{ name: "p1k50" },
			{ name: "p2k60" },
			{ name: "p2k99" },
		]);
		// Six rows of their own and one an artwork — not the seven printings, and not a row a partition.
		expect(total).toBe(9);
		// The inline prefixes cover every other row; the three artworks' rows are fetched from the
		// partitions that sent the winning candidates, one call each.
		expect(log.filter((l) => l.startsWith("rows:")).sort()).toEqual(["rows:1:2", "rows:2:3.2"]);
	});

	test("every page of every size is the reference's, each artwork's row on exactly one of them", async () => {
		for (const limit of [1, 2, 3, 5, 100]) {
			const seen: { name: string }[] = [];
			for (let offset = 0; offset < 12; offset += limit) {
				const got = await run(PARTS, { ...OPTS, offset, limit });
				expect(got).toEqual(reference(PARTS, offset, limit));
				seen.push(...(got.rows as { name: string }[]));
			}
			for (const name of ["p1k35", "p2k99", "p2k45"]) expect(seen.filter((r) => r.name === name).length).toBe(1);
			expect(seen.length).toBe(9);
		}
	});

	test("a pseudo-random corpus, every cut of it, every page: the gather is the reference", async () => {
		let s = 20261010;
		const rand = () => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s / 2 ** 32;
		};
		for (const n of [1, 2, 3, 10]) {
			for (const [sharedShare, artlessShare] of [
				[0, 0],
				[0.05, 0],
				[0.3, 0.05],
				[1, 0],
				[0.5, 0.5],
			] as const) {
				// Distinct keys and distinct ranks, as real ones are (both end in a Scryfall id).
				const keys = Array.from({ length: 120 }, (_, i) => i + 1).sort(() => rand() - 0.5);
				const parts: Printing[][] = Array.from({ length: n }, () => []);
				keys.forEach((key, i) => {
					const roll = rand();
					const printing: Printing =
						roll < sharedShare
							? { key, art: 1 + Math.floor(rand() * 12), rank: 200 - i }
							: roll < sharedShare + artlessShare
								? { key, artless: 200 - i }
								: { key };
					(parts[Math.floor(rand() * n)] as Printing[]).push(printing);
				});
				for (const [offset, limit] of [
					[0, 175],
					[0, 1],
					[0, 7],
					[7, 7],
					[50, 20],
					[119, 5],
					[400, 5],
				] as const) {
					expect(await run(parts, { ...OPTS, offset, limit })).toEqual(reference(parts, offset, limit));
				}
			}
		}
	});

	test("an artwork whose row lies past the page still counts, and costs no fetch", async () => {
		const log: string[] = [];
		const { total, rows } = await run(PARTS, { ...OPTS, limit: 2 }, log);
		expect(rows).toEqual([{ name: "p0k10" }, { name: "p1k20" }]);
		expect(total).toBe(9);
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual([]);
	});

	test("a query matching no printing of a shared artwork is the gather it always was", async () => {
		const parts: Printing[][] = [[{ key: 10 }, { key: 40 }], [{ key: 20 }], [{ key: 30 }]];
		const log: string[] = [];
		const { total, rows } = await run(parts, OPTS, log);
		expect(total).toBe(4);
		expect(rows).toEqual([{ name: "p0k10" }, { name: "p1k20" }, { name: "p2k30" }, { name: "p0k40" }]);
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual([]);
	});

	test("an artwork that is the whole answer is one row, whichever partitions hold it", async () => {
		const parts: Printing[][] = [
			[{ key: 9, art: 7, rank: 4 }],
			[{ key: 3, art: 7, rank: 2 }],
			[],
			[{ key: 7, art: 7, rank: 8 }],
		];
		expect(await run(parts, OPTS)).toEqual({ total: 1, rows: [{ name: "p1k3" }] });
		// Page two of it is past the end.
		expect(await run(parts, { ...OPTS, offset: 1 })).toEqual({ total: 1, rows: [] });
	});

	test("the deep-offset probe counts each artwork once too", async () => {
		const page = await runTwoPhase(
			PARTS.map((printings, p) => partition(p, printings)),
			{ ...OPTS, offset: DEEP_OFFSET_PROBE, limit: 175 },
			ROWS_GATHER,
		);
		expect(page.total).toBe(9);
		expect(page.slots).toEqual([]);
	});
});
