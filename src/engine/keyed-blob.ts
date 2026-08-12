// A KV value that answers one key with one slice of pre-rendered JSON, without being parsed.
//
// Both Scryfall-compat datasets that live in KV want the same thing: a request names a key (an
// oracle id, a set code) and the answer is a chunk of JSON that was rendered at import time. The
// isolate should not parse a ~100KB value to hand back ~1KB of it, and it does not have to — a
// fixed-width index sorted by key can be binary-searched in place and the payload sliced out.
//
//   0..4    "SLKB"
//   4..6    format version, 2 hex digits
//   6..8    key width in bytes, 2 hex digits
//   8..16   entry count, 8 hex digits
//   16      "\n"
//   17..    the index: `count` entries, sorted by key, of
//             <key width> bytes  the key, space-padded on the right
//              8 hex digits      where its payload starts, from the payload's first byte
//              8 hex digits      how long it is
//   then    the payload: each key's JSON, concatenated in index order
//
// EVERY BYTE IS ASCII, and that is load-bearing rather than tidy. A KV value goes through
// string-shaped transports: `wrangler kv bulk put` takes its values from JSON, and a packed binary
// index did not survive it — a rulings bucket went in at 112,993 bytes and landed at 113,887 with
// the JSON payload intact and every 16-byte oracle id replaced by U+FFFD, so lookups missed and the
// route answered `data: []` for a card with 32 rulings. Hex and padded keys cost a little size and
// remove the whole class of failure, including from tools not written yet. They also make
// `wrangler kv key get --text` readable, which is how that was found.
//
// Keys are compared as BYTES, so a caller must fold case (and anything else that should not
// distinguish two keys) before building or looking up. `padKey` refuses a key that does not fit
// rather than truncating one into a collision with another.

const MAGIC = "SLKB";
const HEADER_BYTES = 17; // magic(4) + version(2) + key width(2) + count(8) + "\n"
const OFFSET_HEX_BYTES = 8;

const encoder = new TextEncoder();

/** Thrown when a value is not a blob of this format. Never a miss — a miss is `null`. */
export class KeyedBlobError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KeyedBlobError";
	}
}

/** One key and the JSON it answers with. */
export interface KeyedEntry {
	key: string;
	/** Rendered JSON, spliced into a response verbatim. */
	json: string;
}

function padKey(key: string, keyWidth: number): string {
	if (key.length > keyWidth) {
		throw new KeyedBlobError(`key ${JSON.stringify(key)} is longer than this blob's ${keyWidth}-byte keys`);
	}
	// Padded with spaces rather than NULs so the index stays printable, and on the RIGHT so the
	// padding never participates in ordering before the key's own bytes do.
	return key.padEnd(keyWidth, " ");
}

function hex(value: number, width: number): string {
	return value.toString(16).padStart(width, "0");
}

/** Read `length` hex digits as a number, or NaN if any of them is not a lowercase hex digit. */
function readHex(bytes: Uint8Array, at: number, length: number): number {
	let value = 0;
	for (let i = at; i < at + length; i++) {
		const code = bytes[i] as number;
		let digit: number;
		if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
		else if (code >= 0x61 && code <= 0x66) digit = code - 0x61 + 10;
		else return Number.NaN;
		value = value * 16 + digit;
	}
	return value;
}

/**
 * Build one blob.
 *
 * Entries are sorted by key here rather than trusted to arrive sorted — the readers binary-search,
 * and an unsorted index does not fail, it misses.
 *
 * A key may repeat only if it carries identical JSON; a genuine duplicate is a bug in the caller's
 * key derivation and is refused rather than resolved arbitrarily. Two DIFFERENT keys sharing one
 * payload is normal and costs nothing extra: `/sets/:code` and `/sets/:id` address the same object,
 * so identical JSON is stored once and pointed at twice.
 */
export function encodeKeyedBlob(entries: Iterable<KeyedEntry>, keyWidth: number): Uint8Array {
	const byKey = new Map<string, string>();
	for (const entry of entries) {
		const existing = byKey.get(entry.key);
		if (existing !== undefined && existing !== entry.json) {
			throw new KeyedBlobError(`key ${JSON.stringify(entry.key)} was given two different payloads`);
		}
		byKey.set(entry.key, entry.json);
	}

	const sorted = [...byKey.entries()]
		.map(([key, json]) => ({ padded: padKey(key, keyWidth), json }))
		.sort((a, b) => (a.padded < b.padded ? -1 : a.padded > b.padded ? 1 : 0));

	// One payload per DISTINCT json, so keys that answer with the same object share its bytes.
	const payloads: Uint8Array[] = [];
	const rangeOf = new Map<string, { at: number; length: number }>();
	let payloadBytes = 0;
	for (const { json } of sorted) {
		if (rangeOf.has(json)) continue;
		const encoded = encoder.encode(json);
		rangeOf.set(json, { at: payloadBytes, length: encoded.length });
		payloads.push(encoded);
		payloadBytes += encoded.length;
	}

	const indexEntryBytes = keyWidth + 2 * OFFSET_HEX_BYTES;
	const bytes = new Uint8Array(HEADER_BYTES + sorted.length * indexEntryBytes + payloadBytes);
	bytes.set(encoder.encode(`${MAGIC}${hex(1, 2)}${hex(keyWidth, 2)}${hex(sorted.length, 8)}\n`), 0);
	const payloadAt = HEADER_BYTES + sorted.length * indexEntryBytes;
	for (let i = 0; i < sorted.length; i++) {
		const { padded, json } = sorted[i] as { padded: string; json: string };
		const range = rangeOf.get(json) as { at: number; length: number };
		const entry = `${padded}${hex(range.at, OFFSET_HEX_BYTES)}${hex(range.length, OFFSET_HEX_BYTES)}`;
		bytes.set(encoder.encode(entry), HEADER_BYTES + i * indexEntryBytes);
	}
	let at = payloadAt;
	for (const payload of payloads) {
		bytes.set(payload, at);
		at += payload.length;
	}
	return bytes;
}

/**
 * The JSON one key answers with, as bytes to splice into a response — or null when the blob does
 * not carry the key, which is a miss and not a failure.
 *
 * `blob` is the whole KV value; nothing in it is decoded except the index entries a binary search
 * touches.
 */
export function keyedBlobLookup(blob: Uint8Array, key: string): Uint8Array | null {
	if (blob.length < HEADER_BYTES) {
		throw new KeyedBlobError(`value is ${blob.length} bytes, shorter than the header`);
	}
	for (let i = 0; i < MAGIC.length; i++) {
		if (blob[i] !== MAGIC.charCodeAt(i)) throw new KeyedBlobError("value does not start with the format magic");
	}
	const version = readHex(blob, 4, 2);
	if (version !== 1) throw new KeyedBlobError(`value is format version ${version}, this reader speaks 1`);
	const keyWidth = readHex(blob, 6, 2);
	const count = readHex(blob, 8, 8);
	if (Number.isNaN(keyWidth) || Number.isNaN(count)) throw new KeyedBlobError("header is not readable");
	if (key.length > keyWidth) return null; // cannot be in a blob whose keys are narrower

	const indexEntryBytes = keyWidth + 2 * OFFSET_HEX_BYTES;
	const payloadAt = HEADER_BYTES + count * indexEntryBytes;
	if (payloadAt > blob.length) {
		throw new KeyedBlobError(`value claims ${count} entries, more than its ${blob.length} bytes hold`);
	}
	const wanted = encoder.encode(padKey(key, keyWidth));

	let lo = 0;
	let hi = count - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const entryAt = HEADER_BYTES + mid * indexEntryBytes;
		let cmp = 0;
		for (let i = 0; i < keyWidth && cmp === 0; i++) {
			const left = blob[entryAt + i] as number;
			const right = wanted[i] as number;
			if (left !== right) cmp = left < right ? -1 : 1;
		}
		if (cmp === 0) {
			const offset = readHex(blob, entryAt + keyWidth, OFFSET_HEX_BYTES);
			const length = readHex(blob, entryAt + keyWidth + OFFSET_HEX_BYTES, OFFSET_HEX_BYTES);
			const from = payloadAt + offset;
			if (Number.isNaN(offset) || Number.isNaN(length) || from + length > blob.length) {
				throw new KeyedBlobError("an entry runs past the end of the value");
			}
			return blob.subarray(from, from + length);
		}
		if (cmp < 0) lo = mid + 1;
		else hi = mid - 1;
	}
	return null;
}

/** Entries in a blob, for the publisher's own accounting. */
export function keyedBlobCount(blob: Uint8Array): number {
	const count = readHex(blob, 8, 8);
	if (Number.isNaN(count)) throw new KeyedBlobError("header is not readable");
	return count;
}
