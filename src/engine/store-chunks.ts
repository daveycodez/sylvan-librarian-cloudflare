// The store's chunking grid and content addressing — shared by everything that
// writes or reads store bytes, because the grid only pays off if every writer
// agrees on it.
//
// Chunks are content-addressed: a publish inserts only the chunks whose bytes
// are genuinely new, and the manifest carries the ordered hash list that
// reassembles them. Two consequences fall out of that, and both are the point:
//
//   - a publish costs writes proportional to what CHANGED, not to store size
//   - an interrupted publish resumes, because "already inserted" is a property
//     of the content, not of how far a previous run got
//
// Why a fixed grid rather than content-defined boundaries: measured on two real
// builds of identical input, 1551 of 1831 chunks (84.7%) were byte-identical on
// this exact 40,000-byte grid, with every difference confined to one band of
// the archive. A fixed grid only fails when an edit SHIFTS later bytes rather
// than overwriting them in place; the observed churn does not. If a cross-day
// rebuild ever shows poor reuse, this is the one place to swap in a rolling
// hash — nothing outside this module knows how boundaries are chosen.

/**
 * Bytes per stored chunk.
 *
 * Bounded by D1's 100,000-byte SQL statement limit, not by taste: the CI
 * seeder writes chunks as `X'<hex>'` literals and hex doubles the payload, so
 * 40,000 bytes is ~80KB of hex plus statement text — comfortably inside it,
 * where the in-Worker import's natural 900KB chunks would be ~1.8MB and fail
 * with SQLITE_TOOBIG every time.
 *
 * Both publishers re-chunk onto this grid from byte 0 of the store. That is
 * what lets a nightly in-Worker publish reuse chunks a deploy-time publish
 * already wrote, and vice versa — different chunk sizes would share nothing.
 */
export const STORE_CHUNK_BYTES = 40_000;

/**
 * A chunk's content address: 9 bytes of SHA-256, base64url.
 *
 * 72 bits over a few thousand chunks puts a collision around 1e-16, and a
 * collision could only serve wrong bytes for a store whose total length still
 * matched — the loader checks that. Short matters because the whole ordered
 * list ships inside the manifest row, which the seeder writes as a single SQL
 * statement under the same 100,000-byte limit: 12 chars per chunk keeps a
 * 73MB store's list around 27KB.
 */
export async function chunkHash(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	let binary = "";
	// 9 bytes is divisible by 3, so base64 emits exactly 12 chars, no padding.
	for (const byte of digest.subarray(0, 9)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
}

/** Split a whole store buffer onto the grid. */
export function splitStore(store: Uint8Array): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < store.length; at += STORE_CHUNK_BYTES) {
		chunks.push(store.subarray(at, Math.min(at + STORE_CHUNK_BYTES, store.length)));
	}
	return chunks;
}

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
