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
 * A synchronous sink that turns archive bytes into cache rows as they go past.
 *
 * Exists so the load path can TEE into it: the bytes are already decompressed and in hand on their
 * way into wasm, so writing them here costs one pass over local storage instead of a second KV
 * fetch and a second gunzip. The fill used to re-stream from KV precisely to keep those writes off
 * the request — but `waitUntil` bills to the same invocation AND occupies the single-threaded
 * object, so the work was never actually off the request, and the second decompression is worth far
 * more than the writes: measured 2026-08-12, a cold KV read costs 3466-4204ms of DO CPU while
 * reading the same archive out of local SQLite costs 0ms of wait.
 *
 * Rows are accumulated to BLOB_GROUP_BYTES rather than written as they arrive: a gzipped source
 * hands over ~4KB pieces, and one row each would be ~18,700 rows against a 100,000/day write
 * allowance — a single region's fill would spend a fifth of the daily budget.
 *
 * `commit()` writes the meta row LAST, which is what makes a half-written copy unreadable rather
 * than subtly short. A load that dies partway simply never commits, and the next one refills.
 */
export interface CacheWriter {
	/** Take one run of archive bytes. Must be called with the archive in order. */
	write(bytes: Uint8Array): void;
	/** Flush the tail and publish the copy. Returns rows written, or 0 if the length disagreed. */
	commit(): number;
	/** Abandon a partial copy without publishing it. */
	abort(): void;
}

export function cacheWriter(storage: ArchiveCacheStorage, key: string, expectedBytes: number): CacheWriter {
	ensureCacheSchema(storage);
	// A previous partial attempt under this same key would collide on the primary key.
	exec(storage, "DELETE FROM archive_cache_meta WHERE archive_key = ?", key);
	exec(storage, "DELETE FROM archive_cache WHERE archive_key = ?", key);

	const group = new Uint8Array(BLOB_GROUP_BYTES);
	let filled = 0;
	let seq = 0;
	let written = 0;

	const flush = (bytes: Uint8Array) => {
		exec(storage, "INSERT INTO archive_cache (archive_key, seq, bytes) VALUES (?, ?, ?)", key, seq, exactBuffer(bytes));
		seq += 1;
		written += bytes.byteLength;
	};

	return {
		write(bytes: Uint8Array): void {
			let off = 0;
			while (off < bytes.length) {
				const take = Math.min(BLOB_GROUP_BYTES - filled, bytes.length - off);
				group.set(bytes.subarray(off, off + take), filled);
				filled += take;
				off += take;
				if (filled === BLOB_GROUP_BYTES) {
					flush(group);
					filled = 0;
				}
			}
		},
		commit(): number {
			if (filled > 0) {
				flush(group.subarray(0, filled));
				filled = 0;
			}
			if (written !== expectedBytes) {
				// Never leave a readable short copy. No meta row means the next load goes to KV.
				exec(storage, "DELETE FROM archive_cache WHERE archive_key = ?", key);
				return 0;
			}
			exec(
				storage,
				"INSERT INTO archive_cache_meta (archive_key, total_bytes, row_count) VALUES (?, ?, ?)",
				key,
				expectedBytes,
				seq,
			);
			return seq;
		},
		abort(): void {
			exec(storage, "DELETE FROM archive_cache WHERE archive_key = ?", key);
			exec(storage, "DELETE FROM archive_cache_meta WHERE archive_key = ?", key);
		},
	};
}

/**
 * Fill the cache by draining `body` — the standalone path, for a prefetch that has no load to tee
 * into (see refreshNow, which fills under the OLD store before swapping).
 *
 * The load path does NOT use this: it tees into a cacheWriter instead, so it reads and decompresses
 * once rather than twice.
 */
export async function fillCache(
	storage: ArchiveCacheStorage,
	key: string,
	body: ReadableStream<Uint8Array>,
	expectedBytes: number,
): Promise<number> {
	const writer = cacheWriter(storage, key, expectedBytes);
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			writer.write(value);
		}
	} catch (err) {
		writer.abort();
		throw err;
	} finally {
		reader.releaseLock();
	}
	const rows = writer.commit();
	if (rows === 0) throw new Error(`archive cache fill for ${key} did not match ${expectedBytes} bytes`);
	return rows;
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
