// The store's chunking grid and content addressing — shared by everything that
// writes or reads store bytes, because the grid only pays off if every writer
// agrees on it.
//
// This is now ONLY the staging grid: the sizes the in-Worker import writes
// into the coordinator DO's SQLite while assembling a store. Publishing reads
// those rows back and re-cuts them onto KV's ~20MB grid, so no other component
// depends on where these boundaries fall.
//
// It used to be a content-addressed grid shared by every writer and reader,
// with hashing and dedup, so a publish wrote only changed chunks. That bought
// its keep against D1's row quotas; against KV's four writes per publish it
// bought nothing, and it is gone.

/**
 * Bytes per STAGED chunk — rows the import writes into the coordinator DO's
 * own SQLite while a store is being built, before publishing.
 *
 * Just under the DO's 2MB per-value cap, which is as large as a row can be,
 * because DO row writes are the metered resource here: a 70MB store stages in
 * ~37 rows. This used to be 40,000 bytes to fit D1's 100,000-byte SQL
 * statement limit (hex doubles every blob), which cost ~1,750 row writes per
 * import against a 100k/day budget. Nothing downstream shares this grid any
 * more — the publisher re-cuts staged bytes onto KV's ~20MB grid — so it is
 * free to be whatever is cheapest to write.
 */
export const STORE_CHUNK_BYTES = 1_900_000;

/**
 * Re-chunk an arbitrary byte stream onto the grid, holding at most one chunk
 * plus one input buffer in memory.
 *
 * The in-Worker publisher needs this: the wasm builder emits ~900KB chunks
 * (which is the right size for DO staging, where row writes are the scarce
 * resource), and 900,000 is not a multiple of 40,000 — so the grid can only be
 * recovered by carrying bytes across staged chunk boundaries from offset 0.
 */
export class GridChunker {
	private carry: Uint8Array = new Uint8Array(0);

	/** Feed input; returns every complete grid chunk it completes. */
	push(input: Uint8Array): Uint8Array[] {
		let merged: Uint8Array;
		if (this.carry.length === 0) {
			merged = input;
		} else {
			merged = new Uint8Array(this.carry.length + input.length);
			merged.set(this.carry);
			merged.set(input, this.carry.length);
		}
		const out: Uint8Array[] = [];
		let at = 0;
		while (merged.length - at >= STORE_CHUNK_BYTES) {
			// Copy, never a view: a subarray would pin the whole merged buffer
			// alive for as long as the caller holds the chunk.
			out.push(merged.slice(at, at + STORE_CHUNK_BYTES));
			at += STORE_CHUNK_BYTES;
		}
		this.carry = merged.slice(at);
		return out;
	}

	/** The trailing partial chunk, if any. Call once, after the last push. */
	end(): Uint8Array[] {
		if (this.carry.length === 0) return [];
		const tail = this.carry;
		this.carry = new Uint8Array(0);
		return [tail];
	}
}
