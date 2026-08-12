// A per-region copy of the DECOMPRESSED archive bytes, in the Durable Object's own SQLite.
//
// KV REMAINS THE SOURCE OF TRUTH. Nothing here is authoritative: a miss, a stale key, a partial
// fill, or any error at all falls back to the KV path that has always worked, and the cache is
// refilled from KV afterwards. That is the whole difference from the design this repo removed —
// see the header of search-engine-do.ts, where DO storage WAS the store, a wake read it instead of
// the origin, and a cold boot paid a blocking ~70MB write burst before it could answer.
//
// What it buys is the cost that survives a warm KV cache. A wake has to materialise ~76.6MB into a
// fresh wasm heap no matter where the bytes come from, but the KV path also gunzips them on the
// way. Storing the archive already decompressed removes that step; the bytes go straight from a
// local blob into linear memory.
//
// MEASURED 2026-08-12 on the paid deployment, cold invocations (cpuTimeMs > 200) in one window:
//
//   default.searchCardsAsJson    3823-4204ms CPU   store read from KV
//   default.catalog                    3466ms CPU   store read from KV
//   default.randomCardsAsJson           445ms CPU   store read from HERE
//
// and on the I/O side, which is a separate instrument (`acquireMs` and the load line are Date.now()
// deltas, and Workers freeze the clock during synchronous execution, so they see waiting only):
//
//   from KV       acquire 2596-3543ms   "in 2596ms ... from 18715 pieces"
//   from here     acquire      124ms    "in 0ms ... from 52 pieces"
//
// THE SAVING IS NOT ONE NUMBER, and the spread is the useful part. Those KV loads all followed a
// republish, so KV's per-colo cache was cold and every chunk came from origin. Against a WARM KV
// colo cache the same comparison is much narrower — the free deployment's cold loads sat at a
// ~1250ms median — because then the only thing this cache removes is the gunzip.
//
//   KV colo cache warm   this saves roughly the decompression      ~800ms
//   KV colo cache cold   it also saves the origin fetch          ~3000ms+
//
// So it pays off hardest exactly when every region is loading at once, which is the minute after a
// nightly publish. That is the opposite of a marginal optimisation, and it is why the publish
// notify prefetches into here before swapping rather than letting each region rediscover KV.
//
// An earlier version of this comment guessed ~800ms flat, from the step across the compression
// deploy. That guess was the warm-KV case only, and it understated the cold-KV case by ~4x.
//
// Sizing, against the Workers Free plan's Durable Objects limits (5GB stored, 5M row reads/day,
// 100k row writes/day):
//
//   - ~52 rows for the 76.6MB store and ~8 for the 11.8MB residue, at BLOB_GROUP_BYTES each
//   - a wake reads ~52 of them, so ~2,300 reads/day at current traffic, against 5,000,000
//   - a fill writes ~60 and a replacement deletes ~60 (deletes bill as writes), once per region per
//     publish — a few hundred a day against 100,000
//   - ~88MB stored per region that caches both archives. THIS IS THE AXIS THAT BINDS, and what
//     makes it affordable is that engine DOs are named per REGION rather than per colo: there are
//     nine location hints, so the worst case is ~790MB against the 5GB ceiling however much traffic
//     arrives. Under per-colo naming the same cache would have been bounded only by how many of
//     Cloudflare's ~330 colos saw traffic, times the shard width — which is the shape that forced
//     free-plan sharding down to a single shard the last time this storage held a copy of the store.
//
// Shards above the announced width are released on the nightly publish fan-out, so a traffic spike
// that opens shards does not permanently consume the pool.
//
// Rows are keyed by ARCHIVE KEY, which is unique per build (`card-store-v<format>-<built_at>.store`),
// so a nightly publish cannot overwrite bytes a reader is streaming: the new build fills under its
// own key and the old key's rows are dropped once the new one is complete.

import { BLOB_GROUP_BYTES, blobBytes, exactBuffer } from "../import-spill";

/**
 * The DO storage surface this module needs. Narrowed to what it calls so the loader can be handed
 * a plain object in tests, and so `getEngine`'s caller can pass `undefined` — a Worker isolate has
 * no Durable Object storage, and the loader must work there unchanged.
 */
export interface ArchiveCacheStorage {
	sql: {
		/**
		 * Structurally compatible with workerd's `SqlStorage.exec`, which is generic over the row
		 * shape and returns a cursor. Only `toArray()` is named here — every query below reads at
		 * most one row, so nothing needs the streaming cursor, and keeping the surface this small is
		 * what lets a test pass a plain object in place of a Durable Object.
		 */
		exec(query: string, ...bindings: never[]): { toArray(): Record<string, SqlStorageValue>[] };
	};
}

/**
 * Rows are only readable once the fill has finished.
 *
 * A cold load that dies partway through — an eviction, an exceeded CPU limit, a KV chunk that goes
 * missing — leaves rows behind for an archive that is not all there. Length-checking on read would
 * catch a short copy, but only after streaming it, and a copy that is short in the MIDDLE would not
 * be caught at all. So completeness is recorded as its own fact, written last.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_cache (
	archive_key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	bytes BLOB NOT NULL,
	PRIMARY KEY (archive_key, seq)
);
CREATE TABLE IF NOT EXISTS archive_cache_meta (
	archive_key TEXT PRIMARY KEY,
	total_bytes INTEGER NOT NULL,
	row_count INTEGER NOT NULL
);`;

/** `sql.exec` with the binding types this module actually uses, and rows as plain records. */
function exec(storage: ArchiveCacheStorage, query: string, ...bindings: (string | number | ArrayBuffer)[]) {
	return (storage.sql.exec as (q: string, ...b: unknown[]) => { toArray(): Record<string, SqlStorageValue>[] })(
		query,
		...bindings,
	).toArray();
}

export function ensureCacheSchema(storage: ArchiveCacheStorage): void {
	exec(storage, SCHEMA);
}

/** What the cache holds for an archive, or null if it holds no COMPLETE copy of it. */
function cachedMeta(storage: ArchiveCacheStorage, key: string, expectedBytes: number): { rowCount: number } | null {
	const meta = exec(storage, "SELECT total_bytes, row_count FROM archive_cache_meta WHERE archive_key = ?", key)[0];
	if (!meta) return null;
	// A byte count that disagrees with the manifest means the cached copy was written against a
	// different understanding of this key than the one being asked for. Refuse it rather than
	// stream a store that will fail its length check inside wasm.
	if (Number(meta.total_bytes) !== expectedBytes) return null;
	return { rowCount: Number(meta.row_count) };
}

/** Whether a complete copy of `key` is cached locally. */
export function isCached(storage: ArchiveCacheStorage, key: string, expectedBytes: number): boolean {
	return cachedMeta(storage, key, expectedBytes) !== null;
}

/**
 * The cached archive as a stream of its rows, or null when it is not cached.
 *
 * ONE ROW PER PULL, and one query per row, for the same reason `kvArchiveStream` pulls one KV chunk
 * at a time: the point of the whole load path is that the archive exists once, inside wasm linear
 * memory, and never as a second JS-side copy. Selecting every row in one statement would hand back
 * all ~76.6MB at once and defeat that — this reads ~1.5MB at a time and lets each row go.
 */
export function cachedArchiveStream(
	storage: ArchiveCacheStorage,
	key: string,
	expectedBytes: number,
): ReadableStream<Uint8Array> | null {
	const meta = cachedMeta(storage, key, expectedBytes);
	if (!meta) return null;
	let seq = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (seq >= meta.rowCount) {
				controller.close();
				return;
			}
			const row = exec(storage, "SELECT bytes FROM archive_cache WHERE archive_key = ? AND seq = ?", key, seq)[0];
			if (!row) {
				// Meta said complete and a row is missing: the copy is corrupt. Erroring the stream
				// fails this load, which leaves the previously loaded engine in place and sends the
				// next attempt back to KV — the same contract a missing KV chunk gets.
				controller.error(new Error(`archive cache for ${key} is missing row ${seq} of ${meta.rowCount}`));
				return;
			}
			seq += 1;
			controller.enqueue(blobBytes(row.bytes));
		},
	});
}

/**
 * Write `body` into the cache under `key`, then drop every other archive's rows.
 *
 * Runs in the BACKGROUND, off the request that triggered it (see the loader's `waitUntil`), because
 * this is the write burst that made the previous design pay for itself on the very path it was
 * meant to speed up. Here the request has already been answered from KV before a row is written.
 *
 * Rows are accumulated to `BLOB_GROUP_BYTES` rather than written as they arrive: the source hands
 * over ~4KB gzip pieces, and one row per piece would be ~18,700 rows against a 100,000/day write
 * allowance — a single colo's fill would spend a fifth of the daily budget.
 *
 * Returns the number of rows written. Partial failure leaves no meta row, so the copy stays
 * unreadable and the next cold load refills it.
 */
export async function fillCache(
	storage: ArchiveCacheStorage,
	key: string,
	body: ReadableStream<Uint8Array>,
	expectedBytes: number,
): Promise<number> {
	ensureCacheSchema(storage);
	// A previous partial attempt under this same key would collide on the primary key.
	exec(storage, "DELETE FROM archive_cache_meta WHERE archive_key = ?", key);
	exec(storage, "DELETE FROM archive_cache WHERE archive_key = ?", key);

	const reader = body.getReader();
	const group = new Uint8Array(BLOB_GROUP_BYTES);
	let filled = 0;
	let seq = 0;
	let written = 0;

	const flush = (bytes: Uint8Array) => {
		exec(storage, "INSERT INTO archive_cache (archive_key, seq, bytes) VALUES (?, ?, ?)", key, seq, exactBuffer(bytes));
		seq += 1;
		written += bytes.byteLength;
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			let off = 0;
			while (off < value.length) {
				const take = Math.min(BLOB_GROUP_BYTES - filled, value.length - off);
				group.set(value.subarray(off, off + take), filled);
				filled += take;
				off += take;
				if (filled === BLOB_GROUP_BYTES) {
					flush(group);
					filled = 0;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (filled > 0) flush(group.subarray(0, filled));

	if (written !== expectedBytes) {
		// Never leave a readable short copy. No meta row means the next load goes to KV and refills.
		exec(storage, "DELETE FROM archive_cache WHERE archive_key = ?", key);
		throw new Error(`archive cache fill for ${key} wrote ${written} of ${expectedBytes} bytes`);
	}
	exec(
		storage,
		"INSERT INTO archive_cache_meta (archive_key, total_bytes, row_count) VALUES (?, ?, ?)",
		key,
		expectedBytes,
		seq,
	);
	return seq;
}

/**
 * Drop every cached archive except `keep`.
 *
 * Retention has to be positive rather than incidental: a nightly publish changes both archive keys,
 * so without this a colo would accumulate ~88MB a day against a 5GB account-wide ceiling — the same
 * leak that let production hold 15 store builds in KV under a policy of 2 (see staleStoreKeys).
 * Called after a fill, when the replacement is known good.
 */
export function pruneCache(storage: ArchiveCacheStorage, keep: readonly string[]): string[] {
	const keys = exec(storage, "SELECT archive_key FROM archive_cache_meta").map((r) => String(r.archive_key));
	const stale = keys.filter((k) => !keep.includes(k));
	for (const key of stale) {
		exec(storage, "DELETE FROM archive_cache WHERE archive_key = ?", key);
		exec(storage, "DELETE FROM archive_cache_meta WHERE archive_key = ?", key);
	}
	return stale;
}
