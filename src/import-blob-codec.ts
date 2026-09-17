/**
 * Compression for the coordinator's staged blobs — synchronous both ways.
 *
 * WHY: the nightly import used to push ~9GB a night through Durable Object
 * storage, written and deleted again, and the object's storage falling behind
 * those bursts is what left it billed for hours between alarms (see
 * PACE_START_BPS in import-budget.ts). Most of those bytes were card data that
 * compresses extremely well — measured on the harness corpus with a fast
 * deflate: staged drafts 9.5x, ordered rows 7.1x, spill groups 6.4x, routing
 * keys 3.0x, archive chunks 2.8x — so staging them compressed cuts both the
 * database's peak size and every write and delete the run makes.
 *
 * WHY SYNCHRONOUS: the rows are read and written inside synchronous
 * transactions and synchronous wasm callbacks (the build pulls ordered rows
 * through a sync handler; reorder indexes spill groups in a sync generator).
 * The platform's CompressionStream is async, so it cannot serve those sites;
 * fflate is a small, dependency-free, pure-JS deflate that can.
 *
 * FORMAT: MAGIC (4 bytes, "SLZ1") + raw length (u32 little-endian) + raw
 * deflate. The raw length lets decoding allocate the output once. A row
 * WITHOUT the magic is returned as-is, which keeps a run that was staged raw
 * readable across the deploy that ships this. The uncompressed framings this
 * replaces cannot begin with "SLZ1" where it matters: for the length-prefixed
 * draft/spill/ordered groups those four bytes would be a first entry of
 * 0x315A4C53 ≈ 827MB, far past the 2MB row cap, and routing keys begin with a
 * decimal partition index. A raw archive-staging row is arbitrary bytes, so a
 * legacy one collides with probability 2^-32 — and only rows staged before
 * this deploy, in the one run it lands in the middle of, are raw at all.
 */

import { deflateSync, inflateSync } from "fflate";

export const BLOB_CODEC_MAGIC = new Uint8Array([0x53, 0x4c, 0x5a, 0x31]); // "SLZ1"
const HEADER_BYTES = 8;

/**
 * Deflate level for staged blobs. The fastest level: on the harness corpus it
 * reached 9.5x on drafts against 15.8x at level 6 for a fraction of the CPU,
 * and every alarm that writes staging also spends CPU against the 30s
 * allowance. Level 1 already removes nearly all the storage churn.
 */
export const BLOB_CODEC_LEVEL = 1;

/** True when `bytes` carries the codec header. */
export function isPackedBlob(bytes: Uint8Array): boolean {
	return (
		bytes.length >= HEADER_BYTES &&
		bytes[0] === BLOB_CODEC_MAGIC[0] &&
		bytes[1] === BLOB_CODEC_MAGIC[1] &&
		bytes[2] === BLOB_CODEC_MAGIC[2] &&
		bytes[3] === BLOB_CODEC_MAGIC[3]
	);
}

/** Compress one staged blob for storage. */
export function packBlob(raw: Uint8Array): Uint8Array {
	const deflated = deflateSync(raw, { level: BLOB_CODEC_LEVEL });
	const out = new Uint8Array(HEADER_BYTES + deflated.length);
	out.set(BLOB_CODEC_MAGIC, 0);
	new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, raw.length, true);
	out.set(deflated, HEADER_BYTES);
	return out;
}

/** The raw bytes of a stored blob: decompressed when packed, passed through when not. */
export function unpackBlob(stored: Uint8Array): Uint8Array {
	if (!isPackedBlob(stored)) return stored;
	const rawLength = new DataView(stored.buffer, stored.byteOffset, stored.byteLength).getUint32(4, true);
	const out = inflateSync(stored.subarray(HEADER_BYTES), { out: new Uint8Array(rawLength) });
	if (out.length !== rawLength) {
		throw new Error(`staged blob decompressed to ${out.length} bytes, header says ${rawLength}`);
	}
	return out;
}

/** The raw length a stored blob decodes to, without decoding it. */
export function unpackedLength(stored: Uint8Array): number {
	if (!isPackedBlob(stored)) return stored.length;
	return new DataView(stored.buffer, stored.byteOffset, stored.byteLength).getUint32(4, true);
}
