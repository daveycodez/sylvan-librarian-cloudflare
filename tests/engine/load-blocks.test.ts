// The block assembler that feeds archive bytes into wasm.
//
// Worth its own tests because a fault here is SILENT in the ways that matter: `finish_store_load`
// checks only the total length, so a block boundary that dropped or duplicated bytes while keeping
// the count right would hand rkyv a plausible-looking archive and `access_unchecked` would read it
// as valid. Every test below therefore asserts the reassembled bytes, not just how many arrived.

import { describe, expect, test } from "bun:test";
import { feedBlocks, LOAD_BLOCK_BYTES } from "../../src/engine/load-blocks";

/** A stream that delivers `source` in exactly the pieces given, mimicking a KV/gzip cut. */
function streamOf(pieces: Uint8Array[]): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= pieces.length) {
				controller.close();
				return;
			}
			controller.enqueue(pieces[at] as Uint8Array);
			at += 1;
		},
	});
}

/** Distinct, position-dependent bytes, so a reordering or an off-by-one cannot pass. */
function ramp(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
	return out;
}

function cut(source: Uint8Array, sizes: number[]): Uint8Array[] {
	const pieces: Uint8Array[] = [];
	let at = 0;
	for (const size of sizes) {
		pieces.push(source.subarray(at, at + size));
		at += size;
	}
	if (at < source.length) pieces.push(source.subarray(at));
	return pieces;
}

/**
 * Collect what wasm would receive.
 *
 * COPIES each block, because feedBlocks deliberately reuses one buffer — holding the references
 * would collect N views of the same final contents. That reuse is the contract, so this also
 * doubles as the check that a synchronous consumer sees the right bytes at the time it is called.
 */
async function collect(stream: ReadableStream<Uint8Array>, blockBytes?: number) {
	const got: Uint8Array<ArrayBuffer>[] = [];
	const counts = await feedBlocks(stream, (block) => got.push(new Uint8Array(block)), blockBytes);
	const joined = new Uint8Array(got.reduce((n, b) => n + b.length, 0));
	let at = 0;
	for (const b of got) {
		joined.set(b, at);
		at += b.length;
	}
	return { counts, blocks: got, joined };
}

describe("feedBlocks", () => {
	test("reassembles 4KB pieces byte for byte, the shape gzip produces", async () => {
		const source = ramp(40_000);
		const { counts, joined } = await collect(streamOf(cut(source, Array(9).fill(4096))), 8192);
		expect(joined).toEqual(source);
		expect(counts.pieces).toBe(10);
		expect(counts.blocks).toBe(5); // 40,000 / 8,192 = 4 full + a 7,232-byte tail
	});

	test("splits a piece far larger than a block, the shape an uncompressed KV chunk produces", async () => {
		const source = ramp(26_000);
		const { counts, joined, blocks } = await collect(streamOf([source]), 4096);
		expect(joined).toEqual(source);
		expect(counts.pieces).toBe(1);
		expect(counts.blocks).toBe(7); // 6 full blocks + a 1,424-byte tail
		expect(blocks[6]?.length).toBe(26_000 - 6 * 4096);
	});

	test("a piece straddling a boundary lands contiguously", async () => {
		// 3,000 + 3,000 with a 4,096 block: the second piece is split 1,096 / 1,904.
		const source = ramp(6000);
		const { counts, joined } = await collect(streamOf(cut(source, [3000, 3000])), 4096);
		expect(joined).toEqual(source);
		expect(counts.blocks).toBe(2);
	});

	test("every block is full except the last", async () => {
		const source = ramp(10_000);
		const { blocks } = await collect(streamOf(cut(source, Array(100).fill(100))), 3000);
		expect(blocks.slice(0, -1).map((b) => b.length)).toEqual([3000, 3000, 3000]);
		expect(blocks.at(-1)?.length).toBe(1000);
	});

	test("an archive that is an exact multiple of the block size emits no empty tail", async () => {
		const source = ramp(8192);
		const { counts, joined } = await collect(streamOf(cut(source, [4096, 4096])), 4096);
		expect(joined).toEqual(source);
		expect(counts.blocks).toBe(2);
	});

	test("ragged pieces of every size reassemble", async () => {
		const source = ramp(50_000);
		const sizes: number[] = [];
		for (let i = 1; sizes.reduce((a, b) => a + b, 0) < 50_000; i++) sizes.push(i * 7);
		const { joined } = await collect(streamOf(cut(source, sizes)), 4096);
		expect(joined).toEqual(source);
	});

	test("an empty stream feeds nothing rather than an empty block", async () => {
		const { counts, blocks } = await collect(streamOf([]), 4096);
		expect(counts).toEqual({ pieces: 0, blocks: 0 });
		expect(blocks).toEqual([]);
	});

	test("a stream error propagates instead of feeding a short archive", async () => {
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("chunk 2 missing in KV"));
			},
		});
		expect(collect(failing, 4096)).rejects.toThrow("chunk 2 missing in KV");
	});

	test("the production block size holds the store's crossings to three figures", async () => {
		// The regression this exists for: 76.6MB in 4KB pieces was 18,713 crossings.
		const storeBytes = 76_642_320;
		expect(Math.ceil(storeBytes / LOAD_BLOCK_BYTES)).toBe(19);
	});
});
