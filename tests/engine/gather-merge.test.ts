// The two-phase gather's order-sensitive core (CARD-PARTITIONING §6).
//
// The acceptance criterion for the whole partitioning project is byte-identical
// envelopes, partitioned vs unpartitioned — and the merge is where a mistake
// would corrupt order silently rather than fail. The property pinned here is
// the §6 sort-key contract from the coordinator's side: for ANY set of keys,
// bytewise-merging per-partition sorted streams reproduces the global bytewise
// sort exactly. No key is ever interpreted; memcmp is the only comparison.

import { describe, expect, test } from "bun:test";
import {
	compareKeys,
	decodeKeyPacket,
	encodeKeyPacket,
	inlineRowBudget,
	type KeyEntry,
	mergeKeyStreams,
	type PartitionClient,
	pinGeneration,
	runTwoPhase,
	selectPage,
} from "../../src/engine/gather";
import type { EngineSearchOptions } from "../../src/engine/types";

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function randomKey(rand: () => number): Uint8Array {
	// Varied lengths on purpose: shorter-is-prefix ordering is part of memcmp.
	const len = 1 + Math.floor(rand() * 12);
	const key = new Uint8Array(len);
	// A small alphabet forces prefix collisions and exact ties.
	for (let i = 0; i < len; i++) key[i] = Math.floor(rand() * 4);
	return key;
}

describe("the k-way bytewise merge", () => {
	test("merging per-partition sorted streams IS the global sort — the §6 property", () => {
		for (const seed of [1, 42, 77777]) {
			const rand = rng(seed);
			const partitions = 5;
			// Global reference: every entry tagged with its partition, sorted by the
			// SAME rule the merge promises: key bytes, then vpid, then partition.
			const all: { partition: number; entry: KeyEntry }[] = [];
			for (let i = 0; i < 400; i++) {
				all.push({
					partition: Math.floor(rand() * partitions),
					entry: { key: randomKey(rand), vpid: Math.floor(rand() * 50) },
				});
			}
			const reference = [...all].sort((a, b) => {
				const c = compareKeys(a.entry.key, b.entry.key);
				if (c !== 0) return c;
				if (a.entry.vpid !== b.entry.vpid) return a.entry.vpid - b.entry.vpid;
				return a.partition - b.partition;
			});

			// What the engine hands over: each partition's OWN entries, sorted.
			const streams: KeyEntry[][] = Array.from({ length: partitions }, () => []);
			for (const { partition, entry } of all) (streams[partition] as KeyEntry[]).push(entry);
			for (const s of streams) s.sort((a, b) => compareKeys(a.key, b.key) || a.vpid - b.vpid);

			const merged = mergeKeyStreams(streams);
			expect(merged.length).toBe(all.length);
			// The local index must be each entry's rank WITHIN its own partition's stream —
			// that is what lets the inline-row prefix be checked with one comparison.
			const seen = new Array<number>(partitions).fill(0);
			expect(merged).toEqual(
				reference.map((r) => ({
					partition: r.partition,
					vpid: r.entry.vpid,
					index: (seen[r.partition] as number)++,
				})),
			);
		}
	});

	test("exact byte-ties break by vpid, then partition — deterministically", () => {
		const key = new Uint8Array([7, 7]);
		const merged = mergeKeyStreams([
			[{ key, vpid: 9 }],
			[
				{ key, vpid: 2 },
				{ key, vpid: 9 },
			],
		]);
		expect(merged).toEqual([
			{ partition: 1, vpid: 2, index: 0 },
			{ partition: 0, vpid: 9, index: 0 },
			{ partition: 1, vpid: 9, index: 1 },
		]);
	});

	test("empty streams and an empty merge are fine", () => {
		expect(mergeKeyStreams([[], [], []])).toEqual([]);
		expect(mergeKeyStreams([])).toEqual([]);
	});
});

describe("the phase-1 key packet codec", () => {
	test("round-trips totals, keys and vpids", () => {
		const packet = {
			total: 123_456,
			entries: [
				{ key: new Uint8Array([1, 2, 3]), vpid: 0 },
				{ key: new Uint8Array([]), vpid: 4_000_000_000 },
				{ key: new Uint8Array(300).fill(255), vpid: 7 },
			],
		};
		const decoded = decodeKeyPacket(encodeKeyPacket(packet));
		expect(decoded.total).toBe(packet.total);
		expect(decoded.entries.length).toBe(3);
		for (let i = 0; i < 3; i++) {
			const want = packet.entries[i] as { key: Uint8Array; vpid: number };
			expect([...(decoded.entries[i]?.key ?? [])]).toEqual([...want.key]);
			expect(decoded.entries[i]?.vpid).toBe(want.vpid);
		}
	});

	test("truncation fails loudly rather than yielding fewer rows", () => {
		const good = encodeKeyPacket({ total: 2, entries: [{ key: new Uint8Array([1, 2]), vpid: 3 }] });
		expect(() => decodeKeyPacket(good.subarray(0, good.length - 1))).toThrow(/truncated/);
		expect(() => decodeKeyPacket(new Uint8Array(4))).toThrow(/too short/);
	});

	test("round-trips the inline-row section, framed separately from the keys", () => {
		const rows = [new TextEncoder().encode('{"name":"a"}'), new Uint8Array(0)];
		const decoded = decodeKeyPacket(
			encodeKeyPacket({
				total: 9,
				entries: [
					{ key: new Uint8Array([1]), vpid: 5 },
					{ key: new Uint8Array([2]), vpid: 6 },
					{ key: new Uint8Array([3]), vpid: 7 },
				],
				inlineRows: rows,
			}),
		);
		expect(decoded.entries.length).toBe(3);
		expect(decoded.inlineRows.length).toBe(2);
		expect(new TextDecoder().decode(decoded.inlineRows[0] as Uint8Array)).toBe('{"name":"a"}');
		expect((decoded.inlineRows[1] as Uint8Array).byteLength).toBe(0);
	});

	test("a packet carrying no inline rows decodes to an empty section, not undefined", () => {
		const decoded = decodeKeyPacket(encodeKeyPacket({ total: 1, entries: [{ key: new Uint8Array([1]), vpid: 0 }] }));
		expect(decoded.inlineRows).toEqual([]);
	});

	test("a packet from another layout version is REFUSED, never misread", () => {
		// The failure this prevents: a rolling deploy where one side frames the
		// packet differently. Reading it at the wrong offsets would produce a
		// plausible page in the wrong order rather than an error.
		const good = encodeKeyPacket({ total: 1, entries: [{ key: new Uint8Array([1]), vpid: 0 }] });
		new DataView(good.buffer, good.byteOffset).setUint32(0, 1, true);
		expect(() => decodeKeyPacket(good)).toThrow(/version 1, expected 2/);
	});

	test("more inline rows than entries is a loud error", () => {
		const packed = encodeKeyPacket({ total: 1, entries: [{ key: new Uint8Array([1]), vpid: 0 }] });
		new DataView(packed.buffer, packed.byteOffset).setUint32(12, 3, true);
		expect(() => decodeKeyPacket(packed)).toThrow(/3 inline rows for 1 entries/);
	});

	test("trailing garbage fails loudly — a framing bug is not a longer packet", () => {
		const good = encodeKeyPacket({ total: 1, entries: [{ key: new Uint8Array([9]), vpid: 1 }] });
		const padded = new Uint8Array(good.length + 2);
		padded.set(good);
		expect(() => decodeKeyPacket(padded)).toThrow(/trailing/);
	});
});

describe("the page cut and phase-2 shopping list", () => {
	test("applies offset/limit to the MERGED order and groups vpids by owner in that order", () => {
		const merged = [
			{ partition: 0, vpid: 10, index: 0 },
			{ partition: 1, vpid: 20, index: 0 },
			{ partition: 0, vpid: 11, index: 1 },
			{ partition: 2, vpid: 30, index: 0 },
			{ partition: 1, vpid: 21, index: 1 },
		];
		const { page, byPartition } = selectPage(merged, 1, 3);
		expect(page).toEqual([
			{ partition: 1, vpid: 20, index: 0 },
			{ partition: 0, vpid: 11, index: 1 },
			{ partition: 2, vpid: 30, index: 0 },
		]);
		expect([...byPartition.entries()]).toEqual([
			[1, [20]],
			[0, [11]],
			[2, [30]],
		]);
	});

	test("an offset past the end is an empty page, not an error", () => {
		const { page, byPartition } = selectPage([{ partition: 0, vpid: 1, index: 0 }], 5, 10);
		expect(page).toEqual([]);
		expect(byPartition.size).toBe(0);
	});
});

describe("the inline-row budget", () => {
	test("page 1 gets limit/N plus slack; a deep page gets none", () => {
		// The production shape: N=9, Scryfall's 175-row page.
		expect(inlineRowBudget(0, 175, 9)).toBe(36);
		// One row past page 1 and the prefix can no longer cover the page, so the
		// gather stops paying for rows it cannot use.
		expect(inlineRowBudget(1, 175, 9)).toBe(0);
		expect(inlineRowBudget(175, 175, 9)).toBe(0);
	});

	test("small pages are covered outright rather than by the mean", () => {
		// The flat slack is what makes this safe: at limit 20 the mean contribution
		// is 2.2 and the budget is 19, so a partition would have to own almost the
		// whole page before phase 2 came back.
		expect(inlineRowBudget(0, 20, 9)).toBe(19);
		expect(inlineRowBudget(0, 3, 9)).toBe(3);
		expect(inlineRowBudget(0, 1, 9)).toBe(1);
	});

	test("the budget never exceeds the page — a partition cannot owe more than the limit", () => {
		for (const limit of [1, 5, 50, 175, 1000]) {
			for (const n of [1, 2, 9, 32]) {
				expect(inlineRowBudget(0, limit, n)).toBeLessThanOrEqual(limit);
			}
		}
	});

	test("degenerate inputs ask for nothing rather than throwing", () => {
		expect(inlineRowBudget(0, 0, 9)).toBe(0);
		expect(inlineRowBudget(0, 175, 0)).toBe(0);
	});
});

describe("the pinned generation", () => {
	test("agreement pins that build with no stragglers", () => {
		const { pinnedBuiltAt, stragglers } = pinGeneration([
			{ partition: 0, storeKey: "card-store-v2026081501-1755200000-p0.store" },
			{ partition: 1, storeKey: "card-store-v2026081501-1755200000-p1.store" },
		]);
		expect(pinnedBuiltAt).toBe("1755200000");
		expect(stragglers).toEqual([]);
	});

	test("a mismatch pins the NEWEST build and names the older partitions for re-issue", () => {
		// Pin-to-old is unimplementable — swaps are monotonic and the old chunks
		// retire — so the newest build wins and the stragglers are re-asked.
		const { pinnedBuiltAt, stragglers } = pinGeneration([
			{ partition: 0, storeKey: "card-store-v2026081501-1755200000-p0.store" },
			{ partition: 1, storeKey: "card-store-v2026081501-1755286400-p1.store" },
			{ partition: 2, storeKey: "card-store-v2026081501-1755200000-p2.store" },
		]);
		expect(pinnedBuiltAt).toBe("1755286400");
		expect(stragglers).toEqual([0, 2]);
	});

	test("builds compare numerically, not lexically", () => {
		const { pinnedBuiltAt } = pinGeneration([
			{ partition: 0, storeKey: "card-store-v1-999-p0.store" },
			{ partition: 1, storeKey: "card-store-v1-10000-p1.store" },
		]);
		expect(pinnedBuiltAt).toBe("10000");
	});

	test("an unparseable store key is a loud error, never silently ungrouped", () => {
		expect(() => pinGeneration([{ partition: 0, storeKey: "what.store" }])).toThrow(/unparseable/);
	});
});

describe("the two-phase run", () => {
	const OPTS: EngineSearchOptions = {
		filterTreeJson: "{}",
		unique: "printing",
		prefer: "default",
		orderby: "name",
		direction: "asc",
		limit: 3,
		offset: 1,
		fields: ["name"],
	};

	/** A partition whose keys are single bytes and whose rows name themselves. */
	function fakePartition(
		partition: number,
		keys: number[],
		log: string[],
		storeKey = `card-store-v1-100-p${partition}.store`,
	): PartitionClient & { storeKey: string } {
		return {
			storeKey,
			async searchKeys() {
				log.push(`keys:${partition}`);
				return {
					packed: encodeKeyPacket({
						total: keys.length,
						entries: keys.map((k, i) => ({ key: new Uint8Array([k]), vpid: i })),
					}),
					storeKey,
					sortKeyVersion: 1,
				};
			},
			async fetchRows(vpids: number[], _fields: string[], pinnedKey: string) {
				log.push(`rows:${partition}:${vpids.join(".")}`);
				if (pinnedKey !== storeKey) throw new Error("generation mismatch");
				return new TextEncoder().encode(JSON.stringify(vpids.map((v) => ({ name: `p${partition}v${v}` }))));
			},
		};
	}

	/**
	 * The same partition, but HONORING offset/limit the way a real engine does —
	 * `query_keys` runs the query and pages it. Only this shape can catch the
	 * gather asking with the caller's offset, which is why the plain fake (which
	 * ignores both) is not enough on its own.
	 */
	function pagingPartition(partition: number, keys: number[], log: string[]): PartitionClient & { storeKey: string } {
		const storeKey = `card-store-v1-100-p${partition}.store`;
		return {
			storeKey,
			async searchKeys(opts) {
				log.push(`keys:${partition}:off=${opts.offset}:lim=${opts.limit}`);
				const window = keys
					.map((k, i) => ({ key: new Uint8Array([k]), vpid: i }))
					.slice(opts.offset, opts.offset + opts.limit);
				return {
					packed: encodeKeyPacket({ total: keys.length, entries: window }),
					storeKey,
					sortKeyVersion: 1,
				};
			},
			async fetchRows(vpids: number[], _fields: string[], pinnedKey: string) {
				log.push(`rows:${partition}:${vpids.join(".")}`);
				if (pinnedKey !== storeKey) throw new Error("generation mismatch");
				return new TextEncoder().encode(JSON.stringify(vpids.map((v) => ({ name: `p${partition}v${v}` }))));
			},
		};
	}

	test("phase 1 asks every partition from ZERO for offset+limit keys, never for its own page", async () => {
		const log: string[] = [];
		// Global order interleaves the two partitions: p0 1,3,5,7 / p1 2,4,6,8.
		const clients = [pagingPartition(0, [1, 3, 5, 7], log), pagingPartition(1, [2, 4, 6, 8], log)];
		const { total, rows } = await runTwoPhase(clients, { ...OPTS, offset: 4, limit: 2 });
		expect(total).toBe(8);
		// Merged: p0v0(1) p1v0(2) p0v1(3) p1v1(4) | p0v2(5) p1v2(6) | ...
		expect(rows).toEqual([{ name: "p0v2" }, { name: "p1v2" }]);
		// Asked from 0 for 6 — a per-partition [4, 6) window holds none of these rows,
		// and past a partition's match count would hold nothing at all.
		expect(log.filter((l) => l.startsWith("keys:"))).toEqual(["keys:0:off=0:lim=6", "keys:1:off=0:lim=6"]);
	});

	test("a page deeper than any single partition's match count still has rows", async () => {
		const log: string[] = [];
		// 6 rows spread over 3 partitions, 2 each: an offset of 4 exceeds every
		// partition's own count, which is exactly what 404'd page 2 of a short
		// multi-partition result before phase 1 was asked from zero.
		const clients = [pagingPartition(0, [1, 4], log), pagingPartition(1, [2, 5], log), pagingPartition(2, [3, 6], log)];
		const { total, rows } = await runTwoPhase(clients, { ...OPTS, offset: 4, limit: 2 });
		expect(total).toBe(6);
		expect(rows).toEqual([{ name: "p1v1" }, { name: "p2v1" }]);
	});

	test("merges, cuts the page, fetches only owners, reassembles in merged order", async () => {
		const log: string[] = [];
		// Global key order: p1's 1, p0's 2, p1's 3, p0's 4, p1's 5.
		const clients = [fakePartition(0, [2, 4], log), fakePartition(1, [1, 3, 5], log)];
		const { total, rows } = await runTwoPhase(clients, OPTS);
		expect(total).toBe(5);
		// offset 1, limit 3 of the merged order → p0v0(key 2), p1v1(key 3), p0v1(key 4).
		expect(rows).toEqual([{ name: "p0v0" }, { name: "p1v1" }, { name: "p0v1" }]);
		// Phase 2 asked each owner once, vpids in merged order.
		expect(log.filter((l) => l.startsWith("rows:")).sort()).toEqual(["rows:0:0.1", "rows:1:1"]);
	});

	test("a page past every key fetches nothing", async () => {
		const log: string[] = [];
		const { total, rows } = await runTwoPhase([fakePartition(0, [1], log), fakePartition(1, [], log)], {
			...OPTS,
			offset: 10,
		});
		expect(total).toBe(1);
		expect(rows).toEqual([]);
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual([]);
	});

	test("a generation mismatch re-issues phase 1 to the stragglers only", async () => {
		const log: string[] = [];
		// Partition 0 answers from an OLD build the first time, then converges.
		let firstAsk = true;
		const straggler: PartitionClient = {
			async searchKeys(opts) {
				const inner = fakePartition(0, [2], log, `card-store-v1-${firstAsk ? "100" : "200"}-p0.store`);
				firstAsk = false;
				return inner.searchKeys(opts, 0);
			},
			async fetchRows(vpids, fields, key) {
				return fakePartition(0, [2], log, "card-store-v1-200-p0.store").fetchRows(vpids, fields, key);
			},
		};
		const fresh = fakePartition(1, [1], log, "card-store-v1-200-p1.store");
		const { total, rows } = await runTwoPhase([straggler, fresh], { ...OPTS, offset: 0, limit: 10 }, async () => {});
		expect(total).toBe(2);
		expect(rows).toEqual([{ name: "p1v0" }, { name: "p0v0" }]);
		// Phase 1 ran everywhere once, then ONLY on the straggler again.
		expect(log.filter((l) => l.startsWith("keys:"))).toEqual(["keys:0", "keys:1", "keys:0"]);
	});

	test("a straggler no publish told is REFRESHED from KV, then asked again", async () => {
		// The 2026-09-02 outage in miniature: partition 0 loaded the previous build and nothing
		// ever told it a deploy had published a new one, so the 250ms pause changes nothing — it
		// keeps answering from the old build until it is told to converge. `refresh` is that
		// telling; only after it does the partition answer from the pinned build.
		const log: string[] = [];
		let refreshed = false;
		const straggler: PartitionClient = {
			async searchKeys(opts) {
				const inner = fakePartition(0, [2], log, `card-store-v1-${refreshed ? "200" : "100"}-p0.store`);
				return inner.searchKeys(opts, 0);
			},
			async fetchRows(vpids, fields, key) {
				return fakePartition(0, [2], log, "card-store-v1-200-p0.store").fetchRows(vpids, fields, key);
			},
			async refresh() {
				log.push("refresh:0");
				refreshed = true;
			},
		};
		const fresh = fakePartition(1, [1], log, "card-store-v1-200-p1.store");
		const { total, rows } = await runTwoPhase([straggler, fresh], { ...OPTS, offset: 0, limit: 10 }, async () => {});
		expect(total).toBe(2);
		expect(rows).toEqual([{ name: "p1v0" }, { name: "p0v0" }]);
		// Everyone once, the straggler again after the pause, THEN the refresh, then the straggler
		// once more — and the fresh partition is never refreshed or re-asked.
		expect(log.filter((l) => l.startsWith("keys:") || l.startsWith("refresh:"))).toEqual([
			"keys:0",
			"keys:1",
			"keys:0",
			"refresh:0",
			"keys:0",
		]);
	});

	test("a straggler that never converges fails loudly, naming the partitions", async () => {
		const log: string[] = [];
		const stuck = fakePartition(0, [2], log, "card-store-v1-100-p0.store");
		const fresh = fakePartition(1, [1], log, "card-store-v1-200-p1.store");
		expect(runTwoPhase([stuck, fresh], OPTS, async () => {})).rejects.toThrow(
			/partitions 0 still answer from another generation after re-issue and refresh/,
		);
	});

	test("streams with different sort-key versions are refused, never merged", async () => {
		const log: string[] = [];
		const other = fakePartition(1, [1], log);
		const v2: PartitionClient = {
			async searchKeys(opts) {
				const reply = await other.searchKeys(opts, 0);
				return { ...reply, storeKey: "card-store-v1-100-p1.store", sortKeyVersion: 2 };
			},
			fetchRows: other.fetchRows.bind(other),
		};
		expect(runTwoPhase([fakePartition(0, [2], log), v2], OPTS)).rejects.toThrow(/sort-key version 2/);
	});

	/**
	 * A partition that HONOURS the inline-row budget — the shape the real
	 * `query_keys` export has since the packet moved to version 2. Its inline rows
	 * are byte-identical to what its own `fetchRows` would return for the same
	 * vpids, which is the engine-side property the Rust differential pins
	 * (`inline_rows_equal_fetch_rows_for_the_same_entries`).
	 */
	function inliningPartition(partition: number, keys: number[], log: string[]): PartitionClient {
		const storeKey = `card-store-v1-100-p${partition}.store`;
		const rowOf = (vpid: number) => ({ name: `p${partition}v${vpid}` });
		return {
			async searchKeys(opts, inlineRows) {
				log.push(`keys:${partition}:inline=${inlineRows}`);
				const window = keys
					.map((k, i) => ({ key: new Uint8Array([k]), vpid: i }))
					.slice(opts.offset, opts.offset + opts.limit);
				const carried = window.slice(0, inlineRows);
				return {
					packed: encodeKeyPacket({
						total: keys.length,
						entries: window,
						inlineRows: carried.map((e) => new TextEncoder().encode(JSON.stringify(rowOf(e.vpid)))),
					}),
					storeKey,
					sortKeyVersion: 1,
				};
			},
			async fetchRows(vpids, _fields, pinnedKey) {
				log.push(`rows:${partition}:${vpids.join(".")}`);
				if (pinnedKey !== storeKey) throw new Error("generation mismatch");
				return new TextEncoder().encode(JSON.stringify(vpids.map(rowOf)));
			},
		};
	}

	test("page 1 covered by the inline prefixes costs NO phase-2 call at all", async () => {
		const log: string[] = [];
		// 3 partitions, 4 keys each; page 1 of 6 draws 2 from each, and the budget
		// (ceil(6/3) + 16 = 18, clamped to 6) covers every one of them.
		const clients = [
			inliningPartition(0, [1, 4, 7, 10], log),
			inliningPartition(1, [2, 5, 8, 11], log),
			inliningPartition(2, [3, 6, 9, 12], log),
		];
		const { total, rows } = await runTwoPhase(clients, { ...OPTS, offset: 0, limit: 6 });
		expect(total).toBe(12);
		expect(rows).toEqual([
			{ name: "p0v0" },
			{ name: "p1v0" },
			{ name: "p2v0" },
			{ name: "p0v1" },
			{ name: "p1v1" },
			{ name: "p2v1" },
		]);
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual([]);
		expect(log.filter((l) => l.startsWith("keys:"))).toEqual(["keys:0:inline=6", "keys:1:inline=6", "keys:2:inline=6"]);
	});

	test("a partition whose share overflows its prefix falls back for the TAIL only", async () => {
		const log: string[] = [];
		// Budget is min(limit, ceil(limit/N) + 16); with limit 4 and N 2 that is 4, so
		// force an overflow by handing the gather a client that carries only 1 row —
		// the same situation a skewed page produces against a real engine.
		const stingy = (partition: number, keys: number[]): PartitionClient => {
			const inner = inliningPartition(partition, keys, log);
			return { searchKeys: (opts) => inner.searchKeys(opts, 1), fetchRows: inner.fetchRows.bind(inner) };
		};
		const clients = [stingy(0, [1, 2, 3]), stingy(1, [4, 5, 6])];
		const { total, rows } = await runTwoPhase(clients, { ...OPTS, offset: 0, limit: 4 });
		expect(total).toBe(6);
		// Merged: p0v0(1) p0v1(2) p0v2(3) | p1v0(4)...  page = first four.
		expect(rows).toEqual([{ name: "p0v0" }, { name: "p0v1" }, { name: "p0v2" }, { name: "p1v0" }]);
		// p0 carried one row and owed two; p1 carried the one row it needed and owed none.
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual(["rows:0:1.2"]);
	});

	test("a deep page asks for no inline rows and pays phase 2 exactly as before", async () => {
		const log: string[] = [];
		const clients = [inliningPartition(0, [1, 3, 5, 7], log), inliningPartition(1, [2, 4, 6, 8], log)];
		const { rows } = await runTwoPhase(clients, { ...OPTS, offset: 4, limit: 2 });
		expect(rows).toEqual([{ name: "p0v2" }, { name: "p1v2" }]);
		expect(log.filter((l) => l.startsWith("keys:"))).toEqual(["keys:0:inline=0", "keys:1:inline=0"]);
		expect(log.filter((l) => l.startsWith("rows:")).sort()).toEqual(["rows:0:2", "rows:1:2"]);
	});

	test("a partition that ignores the budget entirely is still answered correctly", async () => {
		// The rolling-deploy case: one sibling still on the keys-only build. Its page
		// rows come back through phase 2 while its neighbour's ride inline.
		const log: string[] = [];
		const oldBuild = fakePartition(0, [1, 3], log);
		const newBuild = inliningPartition(1, [2, 4], log);
		const { rows } = await runTwoPhase([oldBuild, newBuild], { ...OPTS, offset: 0, limit: 4 });
		expect(rows).toEqual([{ name: "p0v0" }, { name: "p1v0" }, { name: "p0v1" }, { name: "p1v1" }]);
		expect(log.filter((l) => l.startsWith("rows:"))).toEqual(["rows:0:0.1"]);
	});

	test("inline and keys-only produce IDENTICAL pages across offsets — the whole claim", async () => {
		// A pseudo-random corpus so the page draws unevenly from the partitions, run
		// through both protocols at every offset that matters. If folding phase 2 in
		// could ever change an answer, this is where it shows.
		const rand = rng(20260816);
		const keysFor = Array.from({ length: 4 }, () =>
			Array.from({ length: 25 }, () => 1 + Math.floor(rand() * 200)).sort((a, b) => a - b),
		);
		for (const offset of [0, 1, 5, 17, 60, 99, 500]) {
			for (const limit of [1, 3, 12, 40]) {
				const opts = { ...OPTS, offset, limit };
				const keysOnly = await runTwoPhase(
					keysFor.map((k, p) => pagingPartition(p, k, [])),
					opts,
				);
				const inlined = await runTwoPhase(
					keysFor.map((k, p) => inliningPartition(p, k, [])),
					opts,
				);
				expect(inlined.total).toBe(keysOnly.total);
				expect(inlined.rows).toEqual(keysOnly.rows);
			}
		}
	});

	test("a partition returning the wrong row count is a loud error, not a short page", async () => {
		const log: string[] = [];
		const short: PartitionClient = {
			searchKeys: (opts) => fakePartition(0, [1, 2], log).searchKeys(opts, 0),
			async fetchRows() {
				return new TextEncoder().encode("[]");
			},
		};
		expect(runTwoPhase([short], { ...OPTS, offset: 0 })).rejects.toThrow(/0 rows for 2 vpids/);
	});
});
