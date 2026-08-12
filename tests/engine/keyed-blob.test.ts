// The keyed blob: what the import writes and what a request isolate slices out of it.
//
// Two datasets ride on this format (rulings buckets, the by-key set index), and neither reader
// parses what it reads — so a writer and reader that disagree by one byte do not fail loudly, they
// answer one key with another key's payload. These pin the round trip, the ASCII discipline the
// format exists for, and every way a value can be unreadable.

import { describe, expect, test } from "bun:test";
import { encodeKeyedBlob, KeyedBlobError, keyedBlobCount, keyedBlobLookup } from "../../src/engine/keyed-blob";

const decoder = new TextDecoder();

function lookup(blob: Uint8Array, key: string): string | null {
	const found = keyedBlobLookup(blob, key);
	return found === null ? null : decoder.decode(found);
}

describe("round trip", () => {
	test("every key answers with its own payload", () => {
		const blob = encodeKeyedBlob(
			[
				{ key: "mh3", json: '{"code":"mh3"}' },
				{ key: "dsk", json: '{"code":"dsk"}' },
				{ key: "war", json: '{"code":"war"}' },
			],
			8,
		);
		expect(lookup(blob, "mh3")).toBe('{"code":"mh3"}');
		expect(lookup(blob, "dsk")).toBe('{"code":"dsk"}');
		expect(lookup(blob, "war")).toBe('{"code":"war"}');
		expect(keyedBlobCount(blob)).toBe(3);
	});

	test("a key the blob does not carry is a miss, not a failure", () => {
		const blob = encodeKeyedBlob([{ key: "mh3", json: "1" }], 8);
		expect(lookup(blob, "xyz")).toBeNull();
		// Nor is an empty blob: the publisher writes one per bucket whether or not it has entries.
		expect(lookup(encodeKeyedBlob([], 8), "mh3")).toBeNull();
	});

	test("keys wider than the blob's are a miss rather than a truncated match", () => {
		const blob = encodeKeyedBlob([{ key: "abc", json: "1" }], 4);
		expect(lookup(blob, "abcde")).toBeNull();
	});

	test("two keys can share one payload, which is stored once", () => {
		// A set is addressed by code, by id and by TCGplayer id; storing its object three times
		// would triple the index's payload for nothing.
		const json = '{"code":"mh3","id":"1234"}';
		const blob = encodeKeyedBlob(
			[
				{ key: "code:mh3", json },
				{ key: "id:1234", json },
			],
			16,
		);
		expect(lookup(blob, "code:mh3")).toBe(json);
		expect(lookup(blob, "id:1234")).toBe(json);
		// One copy: the whole value is the header, two index entries and one payload.
		expect(blob.length).toBe(17 + 2 * (16 + 16) + json.length);
	});

	test("every key in a large blob resolves to its own payload", () => {
		// The binary search is the part that fails quietly: an index sorted differently than it is
		// searched returns a neighbour's payload under this key, with nothing to notice.
		const entries = [];
		for (let n = 0; n < 500; n++) {
			// Added in an order that is neither sorted nor reverse-sorted.
			const at = (n * 37) % 500;
			entries.push({ key: `key-${String(at).padStart(4, "0")}`, json: `{"n":${at}}` });
		}
		const blob = encodeKeyedBlob(entries, 12);
		for (let n = 0; n < 500; n++) {
			expect(lookup(blob, `key-${String(n).padStart(4, "0")}`)).toBe(`{"n":${n}}`);
		}
	});

	test("keys of different lengths still order and resolve correctly", () => {
		// Padding is on the RIGHT, so a short key cannot sort into the middle of a longer one's
		// prefix and shadow it.
		const blob = encodeKeyedBlob(
			[
				{ key: "a", json: '"a"' },
				{ key: "ab", json: '"ab"' },
				{ key: "abc", json: '"abc"' },
				{ key: "b", json: '"b"' },
			],
			8,
		);
		for (const key of ["a", "ab", "abc", "b"]) expect(lookup(blob, key)).toBe(`"${key}"`);
	});
});

describe("the ASCII discipline the format exists for", () => {
	test("a blob survives being carried as a string", () => {
		// THE REGRESSION THIS FORMAT EXISTS FOR. A KV value goes through string-shaped transports
		// (`wrangler kv bulk put` takes its values from JSON), and a packed binary index came back
		// with every key replaced by U+FFFD — bigger, still parseable, and answering the wrong
		// thing. Decoding STRICTLY is the check: a byte that is not valid UTF-8 throws here.
		const entries = [];
		for (let n = 0; n < 50; n++) entries.push({ key: `k${n}`, json: `{"n":${n},"note":"— “quoted” ✦"}` });
		const blob = encodeKeyedBlob(entries, 8);
		const carried = new TextEncoder().encode(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(blob));
		expect(carried).toEqual(blob);
		for (let n = 0; n < 50; n++) expect(lookup(carried, `k${n}`)).toBe(`{"n":${n},"note":"— “quoted” ✦"}`);
	});

	test("non-ASCII payloads survive the byte layout", () => {
		// Offsets and lengths are in BYTES; a payload measured in characters would truncate every
		// entry carrying a typographic apostrophe.
		const json = '{"comment":"They’re not associated with any specific permanents — ✦"}';
		const blob = encodeKeyedBlob(
			[
				{ key: "a", json },
				{ key: "b", json: "2" },
			],
			4,
		);
		expect(lookup(blob, "a")).toBe(json);
		expect(lookup(blob, "b")).toBe("2");
	});
});

describe("refusals", () => {
	test("a key too wide for the blob is refused rather than truncated into a collision", () => {
		expect(() => encodeKeyedBlob([{ key: "far-too-long-a-key", json: "1" }], 4)).toThrow(KeyedBlobError);
	});

	test("one key with two different payloads is a bug in the caller, not a silent pick", () => {
		expect(() =>
			encodeKeyedBlob(
				[
					{ key: "a", json: "1" },
					{ key: "a", json: "2" },
				],
				4,
			),
		).toThrow(KeyedBlobError);
		// The same payload twice is fine: two spellings of one key can arrive from one source.
		expect(() =>
			encodeKeyedBlob(
				[
					{ key: "a", json: "1" },
					{ key: "a", json: "1" },
				],
				4,
			),
		).not.toThrow();
	});

	test("bytes that are not this format are an error, never a miss", () => {
		const good = encodeKeyedBlob([{ key: "a", json: "1" }], 4);
		const wrongMagic = good.slice();
		wrongMagic[0] = 0x00;
		expect(() => keyedBlobLookup(wrongMagic, "a")).toThrow(KeyedBlobError);
		expect(() => keyedBlobLookup(new Uint8Array(4), "a")).toThrow(KeyedBlobError);
		expect(() => keyedBlobLookup(good.slice(0, 20), "a")).toThrow(KeyedBlobError);
	});

	test("a future format version is refused rather than misread", () => {
		const future = encodeKeyedBlob([{ key: "a", json: "1" }], 4).slice();
		future.set(new TextEncoder().encode("99"), 4);
		expect(() => keyedBlobLookup(future, "a")).toThrow(KeyedBlobError);
	});

	test("a blob read out of a larger buffer reads its own bytes", () => {
		// KV hands back an ArrayBuffer; a view with a non-zero byteOffset is what a caller slicing
		// one out of a bigger read would pass.
		const good = encodeKeyedBlob([{ key: "a", json: '"payload"' }], 4);
		const padded = new Uint8Array(good.length + 8);
		padded.set(good, 8);
		expect(lookup(padded.subarray(8), "a")).toBe('"payload"');
	});
});
