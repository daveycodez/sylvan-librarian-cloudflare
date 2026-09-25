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

// LOADED ON FIRST USE, not at module evaluation. fflate builds its Huffman tables at load — a
// 32,768-entry bit-reversal loop plus the fixed-code maps, run in the interpreter as module
// top-level code — and every isolate of this script evaluates every module: the router, each
// SearchEngine object, and the coordinator alike. Only the coordinator ever packs or unpacks a
// staged blob. Measured on the bundled script (node 24, warm compile cache, 60 cold processes):
// fflate was ~3.0ms of ~5.8ms of module evaluation. A `require` of a bundled module is what
// esbuild turns into a synchronous lazy init (`__esm`/`__commonJS`), so both call sites stay
// synchronous — they run inside sync transactions and sync wasm callbacks (see WHY SYNCHRONOUS).
type Fflate = typeof import("fflate");
let fflateModule: Fflate | null = null;
function fflate(): Fflate {
	fflateModule ??= require("fflate") as Fflate;
	return fflateModule;
}

export const BLOB_CODEC_MAGIC = new Uint8Array([0x53, 0x4c, 0x5a, 0x31]); // "SLZ1"
const HEADER_BYTES = 8;

/**
 * Deflate level for staged blobs. The fastest level: on the harness corpus it
 * reached 9.5x on drafts against 15.8x at level 6 for a fraction of the CPU,
 * and every alarm that writes staging also spends CPU against the 30s
 * allowance. Level 1 already removes nearly all the storage churn.
 */
export const BLOB_CODEC_LEVEL = 1;

/**
 * Deflate level for the staged DRAFTS alone — draft_batches (transform) and draft_parts (bucket) —
 * the rows that ARE the coordinator's storage high-water: every partition's drafts at once, just
 * before the partition loop starts consuming them (backlog x1, report 13: ~80% of the peak). That
 * peak is what r3's pool gate budgets as the coordinator's share of the 5GB pool, so bytes here are
 * pool bytes; everywhere else a staged blob is transient and level 1 stays.
 *
 * MEASURED 2026-09-25 on real card JSON (store-build/rows.jsonl, 24 rows of 6MB raw spread over the
 * 2.04GB file, fflate under bun): level 1 3.91x, level 6 4.91x — 20.4% fewer stored bytes through
 * packBlob, 21.4% through PackStream (mem 4) — for 11.4 → 15.2 ms per raw MB of compress CPU
 * (PackStream 12.3 → 16.4). At the real corpus's ~1.78GB of raw drafts that is ~0.08GB off the
 * staging peak, and about +0.1s on a transform slice and +0.4s on a 96MB bucket slice against the
 * 30s allowance. Level 9 is no better than 6 (report 16). Decoding is unchanged: a deflate stream
 * reads the same at any level, so rows staged at level 1 by a run a deploy lands in stay readable.
 */
export const DRAFT_CODEC_LEVEL = 6;

/** A deflate level fflate accepts. */
type DeflateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

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

/** Compress one staged blob for storage; staged drafts pass DRAFT_CODEC_LEVEL. */
export function packBlob(raw: Uint8Array, level: DeflateLevel = BLOB_CODEC_LEVEL): Uint8Array {
	const deflated = fflate().deflateSync(raw, { level });
	const out = new Uint8Array(HEADER_BYTES + deflated.length);
	out.set(BLOB_CODEC_MAGIC, 0);
	new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, raw.length, true);
	out.set(deflated, HEADER_BYTES);
	return out;
}

/** packBlob at DRAFT_CODEC_LEVEL: a staged draft row. */
export function packDraftBlob(raw: Uint8Array): Uint8Array {
	return packBlob(raw, DRAFT_CODEC_LEVEL);
}

/**
 * fflate's hash-table size for a PackStream, as its `mem` option (12 + mem bits). The default for
 * a stream is 20 bits: a 2MB table per stream, 71MB for the bucket phase's 32 at once, measured.
 * At 4 (16 bits) the 32 hold ~13MB, and on draft JSON the ratio is within 1% of packBlob's.
 */
export const PACK_STREAM_MEM = 4;
/** Raw bytes a PackStream collects before handing them to the compressor: fflate compresses per
 * push once 8KB is buffered, allocating a block-sized output each time, so pushing ~1.5KB drafts
 * one by one cost ~3x the CPU of one packBlob over the same bytes. */
const PACK_STREAM_PUSH_BYTES = 64 * 1024;

/**
 * One packed blob built INCREMENTALLY, a length-prefixed entry at a time — the bucket phase keeps
 * one per partition, so what it holds while it reads is compressed bytes (plus one push buffer),
 * not every partition's raw drafts. `finish()` returns the same format packBlob does: the header
 * with the raw length, then one deflate stream that decodes to exactly the entries pushed.
 */
export class PackStream {
	private readonly parts: Uint8Array[] = [];
	private packed = 0;
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private readonly deflate: import("fflate").Deflate;
	/** Raw (length-prefixed) bytes pushed so far. */
	raw = 0;
	/** Entries pushed so far. */
	count = 0;

	constructor(level: DeflateLevel = BLOB_CODEC_LEVEL) {
		this.deflate = new (fflate().Deflate)({ level, mem: PACK_STREAM_MEM }, (chunk) => {
			this.parts.push(chunk);
			this.packed += chunk.length;
		});
	}

	/**
	 * An upper bound on the finished blob's size: the header, what is already compressed, what is
	 * waiting to be, the compressor's own unflushed input (it compresses whenever 8KB is buffered),
	 * and deflate's worst case of a few bytes per 64KB stored block.
	 */
	get packedBound(): number {
		return HEADER_BYTES + this.packed + this.pendingBytes + 8192 + 1024 + Math.ceil(this.raw / 65536) * 8;
	}

	/** Append one entry, framed as a length-prefixed batch entry ([u32 le length][bytes]). */
	push(entry: Uint8Array): void {
		const head = new Uint8Array(4);
		new DataView(head.buffer).setUint32(0, entry.length, true);
		this.pending.push(head, entry);
		this.pendingBytes += 4 + entry.length;
		this.raw += 4 + entry.length;
		this.count += 1;
		if (this.pendingBytes >= PACK_STREAM_PUSH_BYTES) this.drain(false);
	}

	private drain(final: boolean): void {
		const chunk = new Uint8Array(this.pendingBytes);
		let at = 0;
		for (const piece of this.pending) {
			chunk.set(piece, at);
			at += piece.length;
		}
		this.pending = [];
		this.pendingBytes = 0;
		this.deflate.push(chunk, final);
	}

	/** The finished blob. The stream is spent afterwards. */
	finish(): Uint8Array {
		this.drain(true);
		const out = new Uint8Array(HEADER_BYTES + this.packed);
		out.set(BLOB_CODEC_MAGIC, 0);
		new DataView(out.buffer).setUint32(4, this.raw, true);
		let at = HEADER_BYTES;
		for (const part of this.parts) {
			out.set(part, at);
			at += part.length;
		}
		this.parts.length = 0;
		return out;
	}
}

/** The raw bytes of a stored blob: decompressed when packed, passed through when not. */
export function unpackBlob(stored: Uint8Array): Uint8Array {
	if (!isPackedBlob(stored)) return stored;
	const rawLength = new DataView(stored.buffer, stored.byteOffset, stored.byteLength).getUint32(4, true);
	const out = fflate().inflateSync(stored.subarray(HEADER_BYTES), { out: new Uint8Array(rawLength) });
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
