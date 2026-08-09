// The chunk grid is a contract between three parties that never run together:
// the deploy-time seeder (whole buffer in memory), the in-Worker publisher
// (a stream of ~900KB staged chunks), and the reader (hashes from a manifest).
// Reuse only happens if all three land on identical boundaries, so that is
// what these pin down.

import { describe, expect, test } from "bun:test";
import { chunkHash, GridChunker, STORE_CHUNK_BYTES, splitStore } from "../../src/engine/store-chunks";

/** Deterministic pseudo-random bytes — a store-shaped buffer without the store. */
function bytes(length: number, seed = 1): Uint8Array {
	const out = new Uint8Array(length);
	let state = seed >>> 0;
	for (let i = 0; i < length; i++) {
		state = (state * 1664525 + 1013904223) >>> 0;
		out[i] = state >>> 24;
	}
	return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

describe("splitStore", () => {
	test("covers the store exactly, with a short final chunk", () => {
		const store = bytes(STORE_CHUNK_BYTES * 3 + 137);
		const chunks = splitStore(store);
		expect(chunks.length).toBe(4);
		expect(chunks.slice(0, 3).every((c) => c.length === STORE_CHUNK_BYTES)).toBe(true);
		expect(chunks[3]?.length).toBe(137);
		expect(concat(chunks)).toEqual(store);
	});

	test("an exact multiple produces no trailing empty chunk", () => {
		expect(splitStore(bytes(STORE_CHUNK_BYTES * 2)).length).toBe(2);
	});

	test("an empty store produces no chunks", () => {
		expect(splitStore(new Uint8Array(0)).length).toBe(0);
	});
});

describe("GridChunker", () => {
	// The property the whole delta rests on: the in-Worker publisher re-chunks
	// a stream whose own boundaries (~900KB) are not multiples of the grid, and
	// must still produce byte-identical chunks to the seeder's whole-buffer
	// split. If this drifts, a deploy and a nightly import share nothing.
	test("matches splitStore whatever the input boundaries are", () => {
		const store = bytes(STORE_CHUNK_BYTES * 5 + 1234, 7);
		for (const inputSize of [1, 999, 40_001, 900_000, STORE_CHUNK_BYTES]) {
			const chunker = new GridChunker();
			const out: Uint8Array[] = [];
			for (let at = 0; at < store.length; at += inputSize) {
				out.push(...chunker.push(store.subarray(at, Math.min(at + inputSize, store.length))));
			}
			out.push(...chunker.end());
			expect(out).toEqual(splitStore(store));
		}
	});

	test("end() is empty when the store lands on a boundary", () => {
		const store = bytes(STORE_CHUNK_BYTES * 2);
		const chunker = new GridChunker();
		const out = chunker.push(store);
		expect(out.length).toBe(2);
		expect(chunker.end()).toEqual([]);
	});

	test("chunks do not alias the input buffer", () => {
		const source = bytes(STORE_CHUNK_BYTES + 10);
		const chunker = new GridChunker();
		const [chunk] = chunker.push(source);
		const before = (chunk as Uint8Array)[0];
		source.fill(0xff);
		expect((chunk as Uint8Array)[0]).toBe(before as number);
	});
});

describe("chunkHash", () => {
	test("is stable, content-derived, and 12 base64url chars", async () => {
		const a = await chunkHash(bytes(1000, 3));
		const b = await chunkHash(bytes(1000, 3));
		const c = await chunkHash(bytes(1000, 4));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
	});

	test("distinguishes chunks differing in a single byte", async () => {
		const one = bytes(STORE_CHUNK_BYTES, 11);
		const two = Uint8Array.from(one);
		two[STORE_CHUNK_BYTES - 1] = (two[STORE_CHUNK_BYTES - 1] as number) ^ 1;
		expect(await chunkHash(one)).not.toBe(await chunkHash(two));
	});

	test("an unchanged store re-hashes to exactly the same list", async () => {
		const store = bytes(STORE_CHUNK_BYTES * 4 + 99, 13);
		const first = await Promise.all(splitStore(store).map(chunkHash));
		const second = await Promise.all(splitStore(store).map(chunkHash));
		expect(second).toEqual(first);
	});

	test("an in-place edit changes only the chunk containing it", async () => {
		// The premise behind a fixed grid: edits that overwrite rather than
		// shift leave every other chunk reusable. Measured at 84.7% on two real
		// builds; this is the mechanism behind that number.
		const store = bytes(STORE_CHUNK_BYTES * 6 + 500, 17);
		const before = await Promise.all(splitStore(store).map(chunkHash));
		const edited = Uint8Array.from(store);
		edited[STORE_CHUNK_BYTES * 3 + 20] = (edited[STORE_CHUNK_BYTES * 3 + 20] as number) ^ 0xff;
		const after = await Promise.all(splitStore(edited).map(chunkHash));
		expect(after.length).toBe(before.length);
		const changed = after.filter((h, i) => h !== before[i]);
		expect(changed.length).toBe(1);
		expect(after[3]).not.toBe(before[3]);
	});
});
