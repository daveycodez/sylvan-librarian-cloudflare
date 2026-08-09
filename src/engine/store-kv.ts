// Where the card store lives: Workers KV, as a handful of large chunks plus a
// manifest pointing at them.
//
// This replaces a content-addressed 40,000-byte grid in D1. That grid existed
// for one reason — D1's 100,000-byte SQL statement limit, with hex doubling
// every blob — and it dragged a whole dedup scheme behind it (~1,800 rows per
// store, reuse accounting, prune-by-reference) purely to keep row writes under
// the free plan's daily quota.
//
// KV removes the constraint that created all of it. A 25 MiB value cap means a
// ~70MB store is FOUR chunks, so:
//
//   - a full publish is 5 writes against a 1,000/day free allowance — no
//     incremental publish, no dedup, no resume bookkeeping
//   - a full load is 5 reads against 100,000/day
//   - one copy serves every colo, instead of one 70MB SQLite copy per
//     Durable Object against a 5GB pool
//
// Chunks are keyed by the store key, which is unique per build, so a publish
// never overwrites bytes a reader might still be streaming. Retention is
// handled by deleting the previous store's chunks once a newer manifest has
// been live long enough (see the publisher).

import type { Env, StoreManifest } from "./types";
import { EngineUnavailableError } from "./types";

/**
 * Bytes per KV chunk. KV's hard value cap is 25 MiB; 20MB leaves room for the
 * platform's own framing and keeps a ~70MB store at four chunks.
 *
 * Bigger is strictly better here until the cap: every chunk is one metered
 * read on load and one metered write on publish, and unlike the D1 grid there
 * is no dedup to preserve — a rebuilt store rewrites all of its chunks either
 * way, and four writes a night is nothing against the quota.
 */
export const KV_CHUNK_BYTES = 20_000_000;

/** The manifest key: the one mutable pointer in the namespace. */
export const MANIFEST_KEY = "store:manifest";

/** Chunk key for a store. Keyed by store_key, so publishes never collide. */
export function chunkKey(storeKey: string, seq: number): string {
	return `store:${storeKey}:${seq}`;
}

/** How many chunks a store of this size occupies on the grid. */
export function chunkCountFor(storeBytes: number): number {
	return Math.ceil(storeBytes / KV_CHUNK_BYTES);
}

/** Split a whole store buffer onto the KV grid. */
export function splitStore(store: Uint8Array): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < store.length; at += KV_CHUNK_BYTES) {
		chunks.push(store.subarray(at, Math.min(at + KV_CHUNK_BYTES, store.length)));
	}
	return chunks;
}

/** One staged row as the publisher hands it over. */
export interface StagedRow {
	seq: number;
	bytes: Uint8Array;
}

/** Where a partially-consumed staging stream left off. */
export interface StagingCursor {
	/** The next staged row to read. */
	seq: number;
	/** Bytes already consumed from THAT row. */
	off: number;
}

/**
 * Fill one KV-sized buffer from staged rows, resuming from `cursor`.
 *
 * The publisher stages the store in rows sized for the DO's 2MB per-value cap
 * and then re-cuts them onto KV's much larger grid, so the two grids do not
 * align and a KV chunk boundary routinely falls INSIDE a staged row. Hence a
 * (seq, offset) cursor rather than a row range: a slice can stop 40% into row
 * 31 and the next one resumes exactly there.
 *
 * `readRows(fromSeq, limit)` returns staged rows in seq order starting at
 * `fromSeq`; returning fewer than asked is fine, returning none before the
 * buffer is full is a short store and throws.
 */
export function assembleChunk(
	want: number,
	cursor: StagingCursor,
	readRows: (fromSeq: number, limit: number) => StagedRow[],
): { bytes: Uint8Array; cursor: StagingCursor } {
	let { seq, off } = cursor;
	const bytes = new Uint8Array(want);
	let filled = 0;
	while (filled < want) {
		const rows = readRows(seq, 8);
		if (rows.length === 0) {
			throw new Error(`chunk staging ran out at seq ${seq} with ${filled}/${want} bytes filled`);
		}
		for (const row of rows) {
			if (filled >= want) break;
			const take = Math.min(row.bytes.length - off, want - filled);
			bytes.set(row.bytes.subarray(off, off + take), filled);
			filled += take;
			if (off + take >= row.bytes.length) {
				seq = row.seq + 1;
				off = 0;
			} else {
				off += take;
			}
		}
	}
	return { bytes, cursor: { seq, off } };
}

/**
 * Read the manifest. A namespace with no manifest is "no index published yet",
 * reported as null; anything else (binding gone, KV unreachable) becomes an
 * EngineUnavailableError carrying the platform's own message so the reason
 * reaches the response instead of a generic 500.
 */
export async function readManifest(env: Env): Promise<StoreManifest | null> {
	try {
		// cacheTtl is deliberately short: the manifest is the ONE mutable key,
		// and a nightly publish should reach isolates within minutes, not hours.
		const json = await env.STORE_KV.get(MANIFEST_KEY, { type: "text", cacheTtl: 60 });
		if (!json) return null;
		return JSON.parse(json) as StoreManifest;
	} catch (err) {
		throw new EngineUnavailableError(`Cannot read the store manifest from KV: ${err}`);
	}
}

/**
 * Stream a store's chunks out of KV in order.
 *
 * One `get` per chunk, pulled lazily so at most one chunk is resident: the
 * whole point of the 128MB isolate discipline is that the store exists once,
 * inside wasm linear memory, and never as a second JS-side copy.
 *
 * `cacheTtl` is a week because chunk keys are immutable — a given store key's
 * bytes never change — so a colo that has loaded this store once serves later
 * loads from its own cache without a metered read.
 */
export function kvStoreStream(env: Env, manifest: StoreManifest): ReadableStream<Uint8Array> {
	const storeKey = manifest.store_key;
	const expected = manifest.store_bytes;
	const total = manifest.chunk_count ?? chunkCountFor(expected);
	let seq = 0;
	let seen = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (seq >= total) {
				if (seen !== expected) {
					controller.error(new EngineUnavailableError(`Store ${storeKey} incomplete in KV: ${seen}/${expected} bytes`));
					return;
				}
				controller.close();
				return;
			}
			const key = chunkKey(storeKey, seq);
			const body = await env.STORE_KV.get(key, { type: "arrayBuffer", cacheTtl: 604_800 });
			if (!body) {
				// A manifest naming chunks KV does not have means a publish was
				// interrupted between chunks and manifest, or retention deleted a
				// store still referenced. Never serve a short store: fail the load
				// and leave the previously loaded engine in place.
				controller.error(new EngineUnavailableError(`Store ${storeKey} is missing chunk ${seq} in KV`));
				return;
			}
			const bytes = new Uint8Array(body);
			seen += bytes.byteLength;
			seq += 1;
			controller.enqueue(bytes);
		},
	});
}
