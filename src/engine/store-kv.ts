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
// ~75MB store is THREE chunks, so:
//
//   - a full publish is 4 writes against a 1,000/day free allowance — no
//     incremental publish, no dedup, no resume bookkeeping
//   - a full load is 4 reads against 100,000/day
//   - one copy serves every colo, instead of one 75MB SQLite copy per
//     Durable Object against a 5GB pool
//
// Chunk count is not cosmetic. The loader below pulls chunks STRICTLY IN
// SEQUENCE, one awaited get each (and must — see kvStoreStream), so a chunk is
// a serialized network round trip on the cold path, not just a meter tick.
// Crossing a boundary is a latency change: generation 3 added 6.25MB of tag
// alias keys, went 3 chunks to 4, and the production median store load went
// 337ms to 691ms. Generation 4 took them back out.
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
 * ~75MB store wants as few chunks as it can have (three, here).
 *
 * The binding constraint is NOT the cap, though: it is the 128MB isolate the
 * nightly publisher assembles chunks in. That only leaves room for a value
 * this large because the build now releases the wasm group (~75MB of linear
 * memory that never shrinks) before publish runs.
 *
 * RAISED from 25,000,000 with generation 4, and the reason is headroom rather
 * than throughput. Chunk count is `ceil(store_bytes / this)`, so the number
 * that matters is the 3-chunk ceiling it implies. Dropping the alias keys puts
 * the store at 74.8MB, which cleared the old 75,000,000 ceiling by 184,272
 * bytes — and two same-format builds a day apart differ by ~19KB, so that
 * margin was about ten days of ordinary Scryfall drift before the 4th chunk
 * came back. At 26,000,000 the ceiling is 78,000,000 and the margin is 3.2MB.
 *
 * Do not read the remaining 214,400 bytes of cap as free: a chunk is
 * materialised whole as an ArrayBuffer during load, on top of wasm linear
 * memory that already holds the store, and that sum is what the 128MB limit
 * actually governs.
 */
export const KV_CHUNK_BYTES = 26_000_000;

/** The manifest key: the one mutable pointer in the namespace. */
export const MANIFEST_KEY = "store:manifest";

/**
 * What the BUILDER puts in the archive, versioned separately from
 * `format_version` (which describes the archive's struct LAYOUT and comes from
 * the Rust engine).
 *
 * A change here is a change in the VALUES a structurally-identical store holds,
 * so no header check can catch it: the store loads fine and answers wrongly.
 * The deploy compares this against the published manifest and rebuilds on a
 * mismatch — this repo's equivalent of the data migrations upstream ships next
 * to such changes (e.g. api/db/2026-08-06-01-lowercase-keywords.sql).
 *
 * BUMP THIS whenever transform.rs/tags.rs change what a card's stored fields
 * contain, even though the schema is untouched. History:
 *   1 — initial
 *   2 — keywords stored lowercase (upstream #869); card_is_tags carries the
 *       boolean-backed reserved/gamechanger (upstream #888)
 *   3 — card_oracle_tags / card_art_tags carry alias keys, and aliases ride
 *       along on ancestors (upstream #914). Bumped together with #913's
 *       ARCHIVE_FORMAT_VERSION 2026080601 -> 2026080901 (Printing gains
 *       set_rank/artist_rank), because they rebuild together: the format bump
 *       makes the old store unloadable, and this makes store-age.ts FORCE the
 *       rebuild at deploy rather than leaving the port dark until the nightly.
 *   4 — the alias keys from 3 are GONE again, resolved at query time instead
 *       (src/parser/tag-aliases.gen.ts). They cost 6,252,880 bytes and bought
 *       the store a 4th chunk; see KV_CHUNK_BYTES. No format change — the
 *       layout is identical and generation 3 stores still load, they just
 *       carry duplicate keys nothing asks for any more. That is what makes
 *       this rollout safe in either order: the new parser resolves `flames`
 *       to `fire`, and `fire` is present in both generations.
 *   5 — the card-face merge (upstream #400/#873). A multi-face card is now ONE
 *       row carrying every face's searchable data (type/subtype/colour/keyword
 *       unions, joined oracle text) instead of silently being its BACK face,
 *       and each face is stored structurally besides. Paired with
 *       ARCHIVE_FORMAT_VERSION 2026080901 -> 2026081001, so the old store is
 *       unloadable and the rebuild is forced rather than deferred to the
 *       nightly. Two visible consequences: `t:battle` matches for the first
 *       time (every battle is a transform front), and a multi-face card's
 *       illustration_id is now its FRONT face's, which shifts prefer_score's
 *       artwork-set component and so which printing represents such a card.
 */
export const STORE_CONTENT_GENERATION = 5;

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
 * DO NOT convert this to `type: "stream"` with the reads issued in parallel.
 * It was tried, deployed, and reverted. KV hands a ~70MB store over in ~17,900
 * pieces, and paying JS for each of them cost far more than the serialised
 * network wait it removed — Durable Object CPU on a load-carrying invocation
 * went from ~120ms to ~900ms, a clean 7x step at the deploy that introduced it.
 *
 * It looked like a win for an hour because of how it was measured. The load
 * logs "in NNNms" from Date.now() deltas, and Workers FREEZE THE CLOCK during
 * synchronous execution — so that number only ever measured I/O wait. Streaming
 * moved work out of I/O and into CPU, which made the number fall from ~2200ms
 * to ~123ms while total request time got worse. Any future attempt here has to
 * be judged on cpuTimeMs from the invocation's own event, not on that log line.
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
