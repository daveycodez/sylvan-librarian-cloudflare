// The byte cursor under the canonical and transform phases' resumes.
//
// Both phases checkpoint a RAW BYTE OFFSET and later hand it to
// stagedBytes(kind, offset), so the failure mode of a wrong `consumed` is a
// resume that starts mid-line: the next slice feeds a corrupted JSON line and
// the store builds anyway. These tests pin that a slice's consumed count is
// exactly the offset of its first unprocessed line, across every boundary
// shape a dump can produce — chunk splits mid-line, blank lines, budget stops,
// and a final line with no trailing newline.

import { describe, expect, test } from "bun:test";
import { isBlankLine, scanJsonlSlice } from "../../src/import-lines";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Deliver `text` as chunks of `chunkSize` bytes — boundaries land mid-line on purpose. */
async function* chunked(text: string, chunkSize: number): AsyncGenerator<Uint8Array> {
	const bytes = enc.encode(text);
	for (let at = 0; at < bytes.length; at += chunkSize) {
		yield bytes.subarray(at, Math.min(at + chunkSize, bytes.length));
	}
}

async function scan(text: string, chunkSize: number, budget = Number.POSITIVE_INFINITY) {
	const lines: string[] = [];
	let taken = 0;
	const result = await scanJsonlSlice(chunked(text, chunkSize), (line) => {
		lines.push(dec.decode(line.slice()));
		taken += 1;
		return taken >= budget;
	});
	return { lines, result };
}

describe("scanJsonlSlice", () => {
	const corpus = `{"n":1}\n{"n":2}\n\n{"n":3}\n{"n":4}`; // blank line + unterminated tail

	test("delivers every line once, whatever the chunk boundaries", async () => {
		for (const size of [1, 3, 7, 1024]) {
			const { lines, result } = await scan(corpus, size);
			expect(lines).toEqual(['{"n":1}', '{"n":2}', "", '{"n":3}', '{"n":4}']);
			expect(result.exhausted).toBe(true);
			expect(result.lines).toBe(5);
			// Final line is unterminated: consumed is the corpus length exactly.
			expect(result.consumed).toBe(corpus.length);
		}
	});

	test("a budget stop's consumed count is the next line's exact offset", async () => {
		const { result } = await scan(corpus, 3, 2);
		expect(result.exhausted).toBe(false);
		expect(result.lines).toBe(2);
		expect(result.consumed).toBe('{"n":1}\n{"n":2}\n'.length);
		// The resume contract: a stream starting at `consumed` yields the rest.
		const rest = await scan(corpus.slice(result.consumed), 5);
		expect(rest.lines).toEqual(["", '{"n":3}', '{"n":4}']);
	});

	test("slicing at every possible budget re-yields the whole corpus", async () => {
		// The canonical/transform resume loop end to end: run slices of `budget`
		// lines, resuming each from the previous consumed offset, until
		// exhausted; the concatenation must be every line exactly once.
		for (const budget of [1, 2, 3]) {
			const all: string[] = [];
			let offset = 0;
			for (let guard = 0; guard < 20; guard++) {
				const { lines, result } = await scan(corpus.slice(offset), 4, budget);
				all.push(...lines);
				offset += result.consumed;
				if (result.exhausted) break;
			}
			expect(all).toEqual(['{"n":1}', '{"n":2}', "", '{"n":3}', '{"n":4}']);
			expect(offset).toBe(corpus.length);
		}
	});

	test("a trailing newline leaves no phantom line", async () => {
		const { lines, result } = await scan('{"n":1}\n{"n":2}\n', 4);
		expect(lines).toEqual(['{"n":1}', '{"n":2}']);
		expect(result.consumed).toBe('{"n":1}\n{"n":2}\n'.length);
		expect(result.exhausted).toBe(true);
	});

	test("an empty stream is exhausted at offset zero", async () => {
		const { lines, result } = await scan("", 4);
		expect(lines).toEqual([]);
		expect(result).toEqual({ consumed: 0, lines: 0, exhausted: true });
	});
});

describe("isBlankLine", () => {
	test("whitespace-only lines are blank; content is not", () => {
		expect(isBlankLine(enc.encode(""))).toBe(true);
		expect(isBlankLine(enc.encode(" \t\r"))).toBe(true);
		expect(isBlankLine(enc.encode(" x "))).toBe(false);
	});
});
