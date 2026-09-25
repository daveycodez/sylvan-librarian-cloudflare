// The staged draft rows, four times the size (backlog x5, 2026-09-25).
//
// Durable Object rows written are the free plan's tightest meter (100k/day), and every staged
// draft row is written once and deleted once, twice over (draft_batches by transform and bucket,
// draft_parts by bucket and the partition purge). Rows were 1.5MB raw and packed ~7x, so ~0.2MB
// each; they are DRAFT_BATCH_BYTES (6MB) raw now. What that must not change is pinned here:
//   - every draft staged exactly once, in order, and no row past SQLite's 2MB value cap however
//     badly a group compresses (packedDraftGroups);
//   - the bucket's incremental PackStream decodes to exactly the length-prefixed batch packBlob
//     would have stored, and its size bound really bounds;
//   - wasm is fed WASM_FEED_BYTES at a time, at entry boundaries (feedSlices);
//   - a scores slice stages ONE routing_keys row holding exactly its batches' text and pairs
//     (routingStagingRows), falling back to one per batch rather than ever overflowing a row.

import { describe, expect, test } from "bun:test";
import { PackStream, packBlob, unpackBlob } from "../../src/import-blob-codec";
import {
	BLOB_GROUP_BYTES,
	DRAFT_BATCH_BYTES,
	feedSlices,
	lengthPrefixed,
	packedDraftGroups,
	routingStagingRows,
	STAGED_ROW_BYTES,
	splitBatch,
	WASM_FEED_BYTES,
} from "../../src/import-spill";

/** Draft-like JSON: compressible, variable-length, deterministic. */
function drafts(count: number, seed = 1): Uint8Array[] {
	const enc = new TextEncoder();
	let x = seed;
	const rand = () => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x / 2147483648;
	};
	return Array.from({ length: count }, (_, i) =>
		enc.encode(
			JSON.stringify({
				scryfall_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
				card_name: `Card ${Math.floor(rand() * 5000)}`,
				oracle_text: "Draw a card. ".repeat(1 + Math.floor(rand() * 40)),
				printed_text: Array.from({ length: Math.floor(rand() * 30) }, () => Math.floor(rand() * 1e9).toString(36)).join(
					" ",
				),
			}),
		),
	);
}

/** Incompressible entries, for the cap: a group that packs past a row must be re-cut. */
function noise(count: number, size: number): Uint8Array[] {
	return Array.from({ length: count }, (_, i) => {
		const out = new Uint8Array(size);
		let x = i + 7;
		for (let j = 0; j < size; j++) {
			x = (x * 1664525 + 1013904223) >>> 0;
			out[j] = x >>> 24;
		}
		return out;
	});
}

describe("packedDraftGroups", () => {
	test("stages every draft once, in order, in groups of at most DRAFT_BATCH_BYTES raw", () => {
		const all = drafts(25_000);
		const groups = packedDraftGroups(all, packBlob);
		expect(groups.length).toBeGreaterThan(1);
		let next = 0;
		const back: Uint8Array[] = [];
		for (const g of groups) {
			expect(g.start).toBe(next);
			next = g.end;
			expect(g.raw).toBeLessThanOrEqual(DRAFT_BATCH_BYTES);
			expect(g.packed.length).toBeLessThanOrEqual(STAGED_ROW_BYTES);
			const raw = unpackBlob(g.packed);
			expect(raw.length).toBe(g.raw);
			back.push(...splitBatch(raw));
		}
		expect(next).toBe(all.length);
		expect(back.map((b) => Buffer.from(b).toString("hex"))).toEqual(all.map((b) => Buffer.from(b).toString("hex")));
		// Compressible drafts fill whole 6MB groups: four fewer rows per 6MB than 1.5MB groups.
		expect(groups[0]?.raw).toBeGreaterThan(DRAFT_BATCH_BYTES - 5_000);
	});

	test("a group that would pack past a row is re-cut at BLOB_GROUP_BYTES, so no row passes the cap", () => {
		const all = noise(90, 60_000); // ~5.4MB raw that does not compress
		const groups = packedDraftGroups(all, packBlob);
		expect(groups.length).toBeGreaterThanOrEqual(4);
		for (const g of groups) {
			expect(g.raw).toBeLessThanOrEqual(BLOB_GROUP_BYTES);
			expect(g.packed.length).toBeLessThanOrEqual(STAGED_ROW_BYTES);
		}
		expect(groups.at(-1)?.end).toBe(all.length);
	});

	test("no drafts, no groups", () => {
		expect(packedDraftGroups([], packBlob)).toEqual([]);
	});
});

describe("PackStream", () => {
	test("decodes to exactly the length-prefixed batch packBlob would have stored", () => {
		const all = drafts(3000, 5);
		const stream = new PackStream();
		for (const d of all) stream.push(d);
		const bound = stream.packedBound;
		expect(stream.count).toBe(all.length);
		const expected = lengthPrefixed(all);
		expect(stream.raw).toBe(expected.length);
		const packed = stream.finish();
		expect(packed.length).toBeLessThanOrEqual(bound);
		expect(Buffer.from(unpackBlob(packed)).equals(Buffer.from(expected))).toBe(true);
		// And about as small as the one-shot packing (the smaller hash table costs ~1%).
		expect(packed.length).toBeLessThan(packBlob(expected).length * 1.1);
	});

	test("its bound holds for incompressible entries too — the case the row cap exists for", () => {
		const stream = new PackStream();
		for (const d of noise(40, 30_000)) {
			stream.push(d);
		}
		const bound = stream.packedBound;
		expect(stream.finish().length).toBeLessThanOrEqual(bound);
	});

	test("an empty stream is an empty batch", () => {
		expect(unpackBlob(new PackStream().finish()).length).toBe(0);
	});
});

describe("feedSlices", () => {
	test("cuts at entry boundaries into pieces of at most the cap, and loses nothing", () => {
		const all = drafts(6000, 9);
		const batch = lengthPrefixed(all);
		const pieces = feedSlices(batch);
		expect(pieces.length).toBeGreaterThan(1);
		for (const p of pieces) expect(p.length).toBeLessThanOrEqual(WASM_FEED_BYTES);
		expect(pieces.flatMap((p) => splitBatch(p)).length).toBe(all.length);
		expect(Buffer.concat(pieces.map((p) => Buffer.from(p))).equals(Buffer.from(batch))).toBe(true);
	});

	test("an entry larger than the cap stands alone rather than being split", () => {
		const big = new Uint8Array(3000).fill(1);
		const pieces = feedSlices(lengthPrefixed([new Uint8Array(10), big, new Uint8Array(10)]), 1000);
		expect(pieces.map((p) => splitBatch(p).length)).toEqual([1, 1, 1]);
	});

	test("a truncated batch is an error, not a short feed", () => {
		const batch = lengthPrefixed(drafts(3));
		expect(() => feedSlices(batch.subarray(0, batch.length - 1))).toThrow();
	});
});

describe("routingStagingRows", () => {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const batch = (seq: number, lines: number) => ({
		seq,
		bytes: enc.encode(`#name-keys\n${Array.from({ length: lines }, (_, i) => `${i % 7}\t${seq}-${i}\n`).join("")}`),
	});
	const pairsOf = (seq: number, n: number) => new Uint8Array(32 * n).fill(seq);

	test("one row per slice, keyed by its first batch, holding every batch's text and pairs in order", () => {
		const routing = [batch(40, 5), batch(41, 3), batch(42, 0)];
		const pairs = new Map([
			[40, pairsOf(40, 2)],
			[41, pairsOf(41, 1)],
			[42, pairsOf(42, 0)],
		]);
		const rows = routingStagingRows(routing, pairs, packBlob, STAGED_ROW_BYTES);
		expect(rows.length).toBe(1);
		expect(rows[0]?.seq).toBe(40);
		const text = dec.decode(unpackBlob(rows[0]?.bytes as Uint8Array));
		expect(text).toBe(routing.map((b) => dec.decode(b.bytes)).join(""));
		expect(text.startsWith("#name-keys\n")).toBe(true);
		expect([...(rows[0]?.pairs ?? [])]).toEqual([...pairsOf(40, 2), ...pairsOf(41, 1)]);
	});

	test("a slice that would overflow a row, or lacks a batch's pairs, is staged per batch", () => {
		const routing = [batch(7, 50), batch(8, 50)];
		const pairs = new Map([
			[7, pairsOf(7, 3)],
			[8, pairsOf(8, 3)],
		]);
		const tiny = routingStagingRows(routing, pairs, packBlob, 100);
		expect(tiny.map((r) => r.seq)).toEqual([7, 8]);
		expect(tiny.map((r) => dec.decode(unpackBlob(r.bytes)))).toEqual(routing.map((b) => dec.decode(b.bytes)));
		const unpaired = routingStagingRows(routing, new Map([[7, pairsOf(7, 3)]]), packBlob, STAGED_ROW_BYTES);
		expect(unpaired.map((r) => [r.seq, r.pairs === null])).toEqual([
			[7, false],
			[8, true],
		]);
	});

	test("a slice with no batches stages nothing", () => {
		expect(routingStagingRows([], new Map(), packBlob, STAGED_ROW_BYTES)).toEqual([]);
	});
});
