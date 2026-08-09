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
 * Bytes per KV chunk: just under KV's 25 MiB (26,214,400 byte) value cap.
 *
 * Bigger is better until that cap — every chunk is one metered read on load
 * and one metered write on publish, and there is no dedup to preserve, so a
 * ~70MB store wants as few chunks as it can have (three, here).
 *
 * The binding constraint is NOT the cap, though: it is the 128MB isolate the
 * nightly publisher assembles chunks in. That only leaves room for a value
 * this large because the build now releases the wasm group (~75MB of linear
 * memory that never shrinks) before publish runs.
 */
export const KV_CHUNK_BYTES = 25_000_000;

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
 * Stream a store's chunks out of KV: every chunk requested at once, consumed
 * strictly in order.
 *
 * Both halves of that matter.
 *
 * ALL AT ONCE, because the load used to be `get` → copy into wasm → `get` →
 * copy, so the network and the CPU never ran together and the wall time was
 * their sum. Cloudflare's own guidance for several large values is to "read
 * individual keys in parallel with Promise.all()", which is what starting
 * every get up front does. The read count is unchanged — one per chunk, as
 * before.
 *
 * IN ORDER, because the archive has to reach wasm in order: the loader appends.
 * Consuming sequentially keeps that true while the other chunks are still
 * arriving, so no random-access write path is needed.
 *
 * `stream` rather than `arrayBuffer` is what makes the two compatible. An
 * arrayBuffer get materialises its whole 25MB before we can touch it, so three
 * in flight would be 75MB on top of the ~70MB store in wasm linear memory —
 * past the 128MB isolate. A stream applies backpressure instead: a chunk that
 * is not being read stops pulling once its queue fills, so the transfers
 * overlap without the bytes piling up. Cloudflare documents `stream` as the
 * fastest of the return types and the way to stay inside 128MB.
 *
 * `cacheTtl` is a week because chunk keys are immutable — a given store key's
 * bytes never change — so a colo that has loaded this store once serves later
 * loads from its own cache without a metered read.
 */
export function kvStoreStream(env: Env, manifest: StoreManifest): ReadableStream<Uint8Array> {
	const storeKey = manifest.store_key;
	const expected = manifest.store_bytes;
	const total = manifest.chunk_count ?? chunkCountFor(expected);

	// Every chunk's read starts here, before anything is consumed.
	const requests: Promise<ReadableStream<Uint8Array> | null>[] = [];
	for (let n = 0; n < total; n++) {
		const pending = env.STORE_KV.get(chunkKey(storeKey, n), {
			type: "stream",
			cacheTtl: 604_800,
		}) as Promise<ReadableStream<Uint8Array> | null>;
		// A load that fails or is cancelled leaves the later reads unawaited;
		// without a handler their rejections surface as unhandled promise
		// rejections. Whoever awaits still sees the original rejection.
		pending.catch(() => {});
		requests.push(pending);
	}

	let seq = 0;
	let seen = 0;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				if (!reader) {
					if (seq >= total) {
						if (seen !== expected) {
							controller.error(
								new EngineUnavailableError(`Store ${storeKey} incomplete in KV: ${seen}/${expected} bytes`),
							);
							return;
						}
						controller.close();
						return;
					}
					const body = await requests[seq];
					if (!body) {
						// A manifest naming chunks KV does not have means a publish was
						// interrupted between chunks and manifest, or retention deleted a
						// store still referenced. Never serve a short store: fail the load
						// and leave the previously loaded engine in place.
						controller.error(new EngineUnavailableError(`Store ${storeKey} is missing chunk ${seq} in KV`));
						return;
					}
					reader = body.getReader();
				}
				const { done, value } = await reader.read();
				if (done) {
					reader = null;
					seq += 1;
					continue;
				}
				seen += value.byteLength;
				controller.enqueue(value);
				return;
			}
		},
		async cancel(reason) {
			// An abandoned load must not leave chunk reads holding connections
			// open for the rest of the invocation.
			await reader?.cancel(reason).catch(() => {});
			for (const pending of requests) {
				await pending.then((body) => body?.cancel(reason)).catch(() => {});
			}
		},
	});
}
