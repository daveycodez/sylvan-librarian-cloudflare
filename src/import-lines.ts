// Byte-exact JSONL slice scanning for the resumable dump consumers
// (import-coordinator's canonical and transform phases).
//
// Both phases walk a decompressed dump line by line across many alarm slices,
// and both resume by RAW BYTE OFFSET: `stagedBytes(kind, offset)` starts the
// stream at the offset, so the checkpoint must land exactly on a line start or
// the next slice feeds a corrupted line into a store that builds anyway. The
// consumed-byte accounting therefore lives here, once, where a test can pin it
// against real streams — not twice inside a Durable Object.
//
// Split out of import-coordinator.ts for the same reason import-recode.ts and
// import-spill.ts were: everything here is pure, taking byte streams and a
// callback.

/** One slice's walk over a JSONL stream. */
export interface JsonlSliceResult {
	/**
	 * Raw bytes consumed from wherever the source started — add to the slice's
	 * starting offset to get the next slice's resume offset. Every consumed
	 * line contributes its bytes plus its `\n`; a final unterminated line (only
	 * possible when `exhausted`) contributes just its bytes.
	 */
	consumed: number;
	/** Lines consumed, blank ones included — consumption is what the cursor tracks. */
	lines: number;
	/** True when the stream ended inside this slice (no budget stop). */
	exhausted: boolean;
}

/** Whitespace-only (space / tab / CR) — the lines a consumer skips but still consumes. */
export function isBlankLine(line: Uint8Array): boolean {
	return line.every((b) => b === 0x20 || b === 0x09 || b === 0x0d);
}

/**
 * Hand `source`'s lines to `take`, one at a time, until `take` returns true
 * (slice budget hit — the line it just saw IS consumed) or the stream ends.
 *
 * `take` receives a VIEW into the current chunk; callers that keep a line must
 * copy it (`line.slice()`), exactly as the coordinator's transform loop always
 * has. Blank and empty lines are delivered too — the caller decides what to
 * feed, but the byte cursor advances over everything it walked past.
 */
export async function scanJsonlSlice(
	source: AsyncIterable<Uint8Array>,
	take: (line: Uint8Array) => boolean,
): Promise<JsonlSliceResult> {
	let consumed = 0;
	let lines = 0;
	let exhausted = true;
	let carry = new Uint8Array(0);
	outer: for await (const chunk of source) {
		let data: Uint8Array;
		if (carry.length) {
			data = new Uint8Array(carry.length + chunk.length);
			data.set(carry);
			data.set(chunk, carry.length);
			carry = new Uint8Array(0);
		} else {
			data = chunk;
		}
		let start = 0;
		for (;;) {
			const nl = data.indexOf(0x0a, start);
			if (nl === -1) {
				carry = data.slice(start);
				break;
			}
			const line = data.subarray(start, nl);
			const budgetHit = take(line);
			consumed += line.length + 1; // the line and its newline
			lines += 1;
			start = nl + 1;
			if (budgetHit) {
				exhausted = false;
				break outer;
			}
		}
	}
	if (exhausted && carry.length) {
		// The dump's final line arrived without a trailing newline: consumed in
		// full, but there is no `\n` to count — the next offset is end-of-stream.
		take(carry);
		consumed += carry.length;
		lines += 1;
	}
	return { consumed, lines, exhausted };
}
