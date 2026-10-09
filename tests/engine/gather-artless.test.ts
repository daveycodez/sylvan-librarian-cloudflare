// The art-less group across partitions: `unique=art` answers every printing with no illustration
// id as ONE row across cards (api.scryfall.com, measured 2026-10-09 — card_engine's
// `artless_rank_key` carries the numbers), and the store is cut by oracle id, so the gather is
// what makes it one. Each partition answers the query WITHOUT its art-less printings and sends its
// best one as a candidate beside the keys; the coordinator keeps the candidate with the smallest
// rank, merges its key in like any other, counts it once and fetches its row.
//
// The engine half — which printing a partition offers, and that the cut answers what one archive
// does over real cards — is engine/builder/tests/artless_group.rs. This is the coordinator's half,
// on synthetic packets: the wire, the choice, the place, the total and the pages.

import { describe, expect, test } from "bun:test";
import {
	type ArtlessCandidate,
	DEEP_OFFSET_PROBE,
	decodeKeyPacket,
	encodeKeyPacket,
	encodeRowPacket,
	KEY_PACKET_FLAG_ARTLESS,
	type KeyEntry,
	mergeKeyStreams,
	mergeWithArtless,
	NOT_INLINE,
	type PartitionClient,
	parseSlots,
	pickArtless,
	ROWS_GATHER,
	runTwoPhase,
} from "../../src/engine/gather";
import type { EngineSearchOptions } from "../../src/engine/types";

const bytes = (...b: number[]) => new Uint8Array(b);
const rowBytes = (row: unknown) => new TextEncoder().encode(JSON.stringify(row));

describe("the art-less trailer on the phase-1 packet", () => {
	const entries: KeyEntry[] = [
		{ key: bytes(1, 2), vpid: 5 },
		{ key: bytes(3), vpid: 6 },
	];
	const artless: ArtlessCandidate = { rank: bytes(0, 9, 9), key: bytes(2, 0xff), vpid: 4_000_000_001 };

	test("round-trips beside keys and inline rows, and sets its flag", () => {
		const packed = encodeKeyPacket({
			total: 2,
			entries,
			inlineRows: [rowBytes({ name: "a" })],
			widened: true,
			artless,
		});
		expect(new DataView(packed.buffer).getUint32(16, true)).toBe(1 | KEY_PACKET_FLAG_ARTLESS);
		const decoded = decodeKeyPacket(packed);
		// The candidate is in neither the total nor the entries.
		expect(decoded.total).toBe(2);
		expect(decoded.entries.length).toBe(2);
		expect(decoded.inlineRows.length).toBe(1);
		expect(decoded.widened).toBe(true);
		expect([...(decoded.artless?.rank ?? [])]).toEqual([0, 9, 9]);
		expect([...(decoded.artless?.key ?? [])]).toEqual([2, 0xff]);
		expect(decoded.artless?.vpid).toBe(4_000_000_001);
	});

	test("a packet without a candidate is byte for byte the packet it always was", () => {
		// What lets two builds either side of this change serve side by side: only a `unique=art`
		// query matching an art-less printing produces bytes an older decoder refuses.
		const plain = encodeKeyPacket({ total: 2, entries });
		expect(plain.byteLength).toBe(20 + (2 + 2 + 4) + (2 + 1 + 4));
		expect(new DataView(plain.buffer).getUint32(16, true)).toBe(0);
		expect("artless" in decodeKeyPacket(plain)).toBe(false);
	});

	test("a truncated trailer, and bytes after it, fail loudly", () => {
		const packed = encodeKeyPacket({ total: 2, entries, artless });
		for (let cut = 1; cut <= 2 + 3 + 2 + 2 + 4; cut++) {
			expect(() => decodeKeyPacket(packed.subarray(0, packed.length - cut))).toThrow(/truncated|trailing/);
		}
		const padded = new Uint8Array(packed.length + 1);
		padded.set(packed);
		expect(() => decodeKeyPacket(padded)).toThrow(/trailing/);
	});

	test("a trailer whose flag is not set is trailing bytes — what a build before the flag sees", () => {
		const packed = encodeKeyPacket({ total: 2, entries, artless });
		new DataView(packed.buffer).setUint32(16, 0, true);
		expect(() => decodeKeyPacket(packed)).toThrow(/trailing/);
	});
});

describe("choosing and placing the art-less group's row", () => {
	test("the smallest rank represents the group; the lower partition on a tie; none is none", () => {
		const c = (...rank: number[]): ArtlessCandidate => ({ rank: bytes(...rank), key: bytes(1), vpid: 0 });
		expect(pickArtless([undefined, undefined])).toBeUndefined();
		expect(pickArtless([])).toBeUndefined();
		expect(pickArtless([undefined, c(5), c(3, 9), c(4)])).toBe(2);
		// A prefix ranks first, as memcmp says.
		expect(pickArtless([c(3, 0), c(3)])).toBe(1);
		expect(pickArtless([undefined, c(7), undefined, c(7)])).toBe(1);
	});

	test("the row merges in by its own key and comes out owned by the partition that sent it", () => {
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
		// Partition 0's candidate ranks second and sorts first; partition 1's represents the group.
		const candidates: (ArtlessCandidate | undefined)[] = [
			{ rank: bytes(2), key: bytes(5), vpid: 77 },
			{ rank: bytes(1), key: bytes(30), vpid: 88 },
		];
		const { merged, artless } = mergeWithArtless(streams, candidates);
		expect(artless).toBe(1);
		expect(merged).toEqual([
			{ partition: 0, vpid: 0, index: 0 },
			{ partition: 1, vpid: 0, index: 0 },
			{ partition: 1, vpid: 88, index: NOT_INLINE },
			{ partition: 0, vpid: 1, index: 1 },
			{ partition: 1, vpid: 1, index: 1 },
		]);
	});

	test("with no candidate the merge is the merge", () => {
		const streams: KeyEntry[][] = [[{ key: bytes(2), vpid: 0 }], [{ key: bytes(1), vpid: 0 }]];
		expect(mergeWithArtless(streams, [undefined, undefined])).toEqual({ merged: mergeKeyStreams(streams), artless: 0 });
	});
});

describe("the two-phase run over an art-less group", () => {
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

	/** One partition's printings: a sort key each, and for the art-less ones a rank. */
	interface Printing {
		key: number;
		rank?: number;
	}

	/**
	 * A partition as the engine answers under `unique=art`: its rows WITH an illustration, paged
	 * and counted as the query without the art-less ones, the first `inlineRows` of the page
	 * carried — and its best art-less printing as the candidate, whatever the page.
	 */
	function partition(p: number, printings: Printing[], log: string[] = []): PartitionClient {
		const storeKey = `card-store-v1-100-p${p}.store`;
		const rows = printings.map((printing, vpid) => ({ ...printing, vpid })).sort((a, b) => a.key - b.key);
		const withArt = rows.filter((r) => r.rank === undefined);
		const best = rows.filter((r) => r.rank !== undefined).sort((a, b) => (a.rank as number) - (b.rank as number))[0];
		return {
			async searchKeys(opts, inlineRows, shaping) {
				log.push(`keys:${p}:inline=${inlineRows}`);
				const window = withArt.slice(opts.offset, opts.offset + opts.limit);
				return {
					packed: encodeKeyPacket({
						total: withArt.length,
						entries: window.map((r) => ({ key: bytes(r.key), vpid: r.vpid })),
						inlineRows: window.slice(0, inlineRows).map((r) => rowBytes({ name: `p${p}k${r.key}` })),
						...(best ? { artless: { rank: bytes(best.rank as number), key: bytes(best.key), vpid: best.vpid } } : {}),
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
		const artless = all.filter((r) => r.rank !== undefined).sort((a, b) => (a.rank as number) - (b.rank as number));
		const rows = all.filter((r) => r.rank === undefined).concat(artless.slice(0, 1));
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

	// Three partitions, each holding art-less printings: p1's key-35 printing ranks best.
	const PARTS: Printing[][] = [
		[{ key: 10 }, { key: 40 }, { key: 5, rank: 3 }, { key: 90, rank: 9 }],
		[{ key: 20 }, { key: 50 }, { key: 35, rank: 1 }, { key: 1, rank: 2 }],
		[{ key: 30 }, { key: 60 }, { key: 99, rank: 7 }],
	];

	test("three partitions' art-less printings are one row, in its place, counted once", async () => {
		const log: string[] = [];
		const { total, rows } = await run(PARTS, OPTS, log);
		expect(rows).toEqual([
			{ name: "p0k10" },
			{ name: "p1k20" },
			{ name: "p2k30" },
			{ name: "p1k35" },
			{ name: "p0k40" },
			{ name: "p1k50" },
			{ name: "p2k60" },
		]);
		// Six rows with an illustration and the group's one — not the five art-less printings,
		// and not one per partition.
		expect(total).toBe(7);
		// The inline prefixes cover every other row; the group's row is the one phase-2 fetch, from
		// the partition that sent the winning candidate.
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual(["rows:1:2"]);
	});

	test("every page of every size is the reference's, the group's row on exactly one of them", async () => {
		for (const limit of [1, 2, 3, 5, 100]) {
			const seen: unknown[] = [];
			for (let offset = 0; offset < 9; offset += limit) {
				const got = await run(PARTS, { ...OPTS, offset, limit });
				expect(got).toEqual(reference(PARTS, offset, limit));
				seen.push(...got.rows);
			}
			expect(seen.filter((r) => (r as { name: string }).name === "p1k35").length).toBe(1);
			expect(seen.length).toBe(7);
		}
	});

	test("a pseudo-random corpus, every cut of it, every page: the gather is the reference", async () => {
		let s = 20261009;
		const rand = () => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s / 2 ** 32;
		};
		for (const n of [1, 2, 3, 10]) {
			for (const artlessShare of [0, 0.05, 0.3, 1]) {
				// Distinct keys and distinct ranks, as real ones are (both end in a Scryfall id).
				const keys = Array.from({ length: 120 }, (_, i) => i + 1).sort(() => rand() - 0.5);
				const parts: Printing[][] = Array.from({ length: n }, () => []);
				keys.forEach((key, i) => {
					const printing: Printing = rand() < artlessShare ? { key, rank: 200 - i } : { key };
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

	test("a group whose row lies past the page still counts, and costs no fetch", async () => {
		const log: string[] = [];
		const { total, rows } = await run(PARTS, { ...OPTS, limit: 2 }, log);
		expect(rows).toEqual([{ name: "p0k10" }, { name: "p1k20" }]);
		expect(total).toBe(7);
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual([]);
	});

	test("a query matching no art-less printing is the gather it always was", async () => {
		const parts: Printing[][] = [[{ key: 10 }, { key: 40 }], [{ key: 20 }], [{ key: 30 }]];
		const log: string[] = [];
		const { total, rows } = await run(parts, OPTS, log);
		expect(total).toBe(4);
		expect(rows).toEqual([{ name: "p0k10" }, { name: "p1k20" }, { name: "p2k30" }, { name: "p0k40" }]);
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual([]);
	});

	test("a group that is the whole answer is one row", async () => {
		const parts: Printing[][] = [[{ key: 9, rank: 4 }], [{ key: 3, rank: 2 }], [], [{ key: 7, rank: 8 }]];
		expect(await run(parts, OPTS)).toEqual({ total: 1, rows: [{ name: "p1k3" }] });
		// Page two of it is past the end.
		expect(await run(parts, { ...OPTS, offset: 1 })).toEqual({ total: 1, rows: [] });
	});

	test("the deep-offset probe counts the group once too", async () => {
		const page = await runTwoPhase(
			PARTS.map((printings, p) => partition(p, printings)),
			{ ...OPTS, offset: DEEP_OFFSET_PROBE, limit: 175 },
			ROWS_GATHER,
		);
		expect(page.total).toBe(7);
		expect(page.slots).toEqual([]);
	});
});
