// Wire shaping for card results, applied where the rows already are: inside
// the Durable Object that ran the query.
//
// Both shapes are produced next to the engine rather than in the request
// isolate. The isolate's CPU is metered against the free plan's 10ms per
// request; the DO's is not (a DO invocation gets 30s), so every byte of
// card-shaped work moved across this boundary is budget the serving path
// gets back. See Engine.searchSerialized in types.ts.
//
// THE COLUMNAR SHAPE IS ASSEMBLED, NOT SERIALIZED (backlog n11). It used to be the engine's rows
// through `JSON.parse`, inverted, and back out of `JSON.stringify` — three passes over the page to
// move each value from one list to another. The engine now writes every row as a COLUMN FRAME
// (engine/wasm/src/lib.rs `RowShape::Columns`): its values alone, each already spelled the way
// `JSON.stringify` spells it, so the page is `{"<key>":[` + the frames' Nth values joined + `]…}`
// and `assembleColumnar` below does nothing but copy bytes. `serializeCards` stays as the
// reference the parity test (tests/engine/columnar-parity.test.ts) holds the assembly to, byte for
// byte, and as the reshaper for a sibling still on a build that cannot write frames.

import { encodeUtf8 } from "./bytes";
import { decodeRowPacket, type GatherShaping } from "./gather";

/**
 * Upstream _columnarize_cards: invert a list of card dicts into one list per
 * field. Every card carries the same keys, so keys come from the first card.
 */
export function columnarizeCards(cards: Record<string, unknown>[]): Record<string, unknown[]> {
	const keys = cards.length > 0 ? Object.keys(cards[0] as Record<string, unknown>) : [];
	return Object.fromEntries(keys.map((k) => [k, cards.map((c) => c[k])]));
}

/** The envelope's `cards` value, serialized in the requested shape. */
export function serializeCards(rows: Record<string, unknown>[], shape: "rows" | "columnar"): string {
	return JSON.stringify(shape === "columnar" ? columnarizeCards(rows) : rows);
}

/**
 * The keys of a columnar page asked for with `fields`: what `Object.keys` of the page's first row
 * was. The engine resolves `fields` by dropping repeats (and refusing unknown names), and its row
 * is a sorted map — serde_json without `preserve_order`, pinned by the engine crate's
 * `engine_rows_iterate_in_sorted_key_order` test — so the keys are the distinct fields, sorted.
 * Field names are ASCII identifiers, where JavaScript's code-unit sort and Rust's byte order
 * agree, and never array indices, which a parsed object would have listed first.
 */
export function columnKeys(fields: readonly string[]): string[] {
	return [...new Set(fields)].sort();
}

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
/** Below this a value is copied byte by byte: `set` over a `subarray` allocates a view per call. */
const SHORT_VALUE = 16;

/**
 * A columnar page, `{"<key>":[v, …], …}`, spliced from one column frame per row.
 *
 * A frame is `nfields: u16 LE`, then per field `vlen: u32 LE` and the value's JSON (see
 * `write_columns_frame` in engine/wasm/src/lib.rs); the frames are in page order and the values
 * in `keys` order. Two passes, neither of which decodes a byte: one reads the lengths and sizes
 * the output exactly, the other copies. No rows is `{}`, as `columnarizeCards` answers.
 *
 * A frame whose field count is not `keys.length` is refused: it would be a page whose columns
 * are silently offset by one, which no parser downstream would notice.
 */
export function assembleColumnar(keys: readonly string[], frames: readonly Uint8Array[]): Uint8Array {
	const rows = frames.length;
	const nf = keys.length;
	if (rows === 0 || nf === 0) return new Uint8Array([OPEN_BRACE, CLOSE_BRACE]);
	const starts = new Uint32Array(rows * nf);
	const lens = new Uint32Array(rows * nf);
	let size = 2 + (nf - 1) + nf * (3 + (rows - 1));
	for (let r = 0; r < rows; r++) {
		const frame = frames[r] as Uint8Array;
		const end = frame.byteLength;
		if (end < 2) throw new Error(`column frame ${r} is ${end} bytes, too short for its field count`);
		const n = (frame[0] as number) | ((frame[1] as number) << 8);
		if (n !== nf) throw new Error(`column frame ${r} carries ${n} fields where the page has ${nf} keys`);
		let at = 2;
		for (let f = 0; f < nf; f++) {
			if (at + 4 > end) throw new Error(`column frame ${r} truncated in field ${f}'s length`);
			const len =
				((frame[at] as number) |
					((frame[at + 1] as number) << 8) |
					((frame[at + 2] as number) << 16) |
					((frame[at + 3] as number) << 24)) >>>
				0;
			at += 4;
			if (at + len > end) throw new Error(`column frame ${r} truncated in field ${f}'s value`);
			starts[r * nf + f] = at;
			lens[r * nf + f] = len;
			size += len;
			at += len;
		}
		if (at !== end) throw new Error(`column frame ${r} has ${end - at} trailing bytes`);
	}
	const keyBytes = keys.map((k) => encodeUtf8(JSON.stringify(k)));
	for (const k of keyBytes) size += k.byteLength;

	const out = new Uint8Array(size);
	let at = 0;
	out[at++] = OPEN_BRACE;
	for (let f = 0; f < nf; f++) {
		if (f > 0) out[at++] = COMMA;
		const key = keyBytes[f] as Uint8Array;
		out.set(key, at);
		at += key.byteLength;
		out[at++] = COLON;
		out[at++] = OPEN_BRACKET;
		for (let r = 0; r < rows; r++) {
			if (r > 0) out[at++] = COMMA;
			const frame = frames[r] as Uint8Array;
			const start = starts[r * nf + f] as number;
			const len = lens[r * nf + f] as number;
			if (len < SHORT_VALUE) {
				for (let i = 0; i < len; i++) out[at + i] = frame[start + i] as number;
			} else {
				out.set(frame.subarray(start, start + len), at);
			}
			at += len;
		}
		out[at++] = CLOSE_BRACKET;
	}
	out[at++] = CLOSE_BRACE;
	if (at !== size) throw new Error(`columnar assembly wrote ${at} of ${size} bytes`);
	return out;
}

/**
 * One parsed row as a column frame over `keys` — the frame a partition on this build would have
 * written, built from a row a partition on the PREVIOUS build answered in row JSON (see gather.ts's
 * `columnsGather`). `JSON.stringify` per value is exactly the spelling the old page used, and a key
 * the row lacks is `null`, as it was inside the old page's arrays.
 */
export function columnsFrameOf(row: Record<string, unknown>, keys: readonly string[]): Uint8Array {
	const values = keys.map((k) => encodeUtf8(JSON.stringify(row[k] === undefined ? null : row[k])));
	const out = new Uint8Array(2 + values.reduce((s, v) => s + 4 + v.byteLength, 0));
	const view = new DataView(out.buffer);
	view.setUint16(0, keys.length, true);
	let at = 2;
	for (const value of values) {
		view.setUint32(at, value.byteLength, true);
		out.set(value, at + 4);
		at += 4 + value.byteLength;
	}
	return out;
}

/**
 * The gather shaping for a columnar page over `keys`: every partition writes column frames, and a
 * partition still on the previous build — which answers row JSON, or refuses a shape it has never
 * heard of (see gather.ts's `tolerateUnknownShape`) — has the rows the page keeps reshaped here.
 */
export function columnsGather(keys: readonly string[]): GatherShaping {
	return { shape: "columns", baseUrl: "", reshape: (row) => columnsFrameOf(row, keys) };
}

/** `query_shaped`'s answer: `total: u32 LE`, then a row packet (gather.ts's `decodeRowPacket`). */
export function decodeShapedPage(answer: Uint8Array): { total: number; frames: Uint8Array[] } {
	if (answer.byteLength < 4) throw new Error(`shaped page too short: ${answer.byteLength} bytes`);
	const total = new DataView(answer.buffer, answer.byteOffset, 4).getUint32(0, true);
	return { total, frames: decodeRowPacket(answer.subarray(4)) };
}
