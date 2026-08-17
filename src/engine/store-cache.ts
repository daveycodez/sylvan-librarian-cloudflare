// A per-object copy of the archive bytes it loads, in the Durable Object's own SQLite.
//
// IN WHICH FORM DEPENDS ON THE ARCHIVE, and this file holds both paths — see "TWO FORMATS LIVE
// HERE" below. A partitioned archive, which is all any publisher emits today, caches COMPRESSED
// chunk for chunk; the decompressed form survives for an uncompressed archive alone. So the
// header of this comment cannot be read as "the gunzip is gone" any more: what a cached wake
// skips is the FETCH.
//
// KV REMAINS THE SOURCE OF TRUTH. Nothing here is authoritative: a miss, a stale key, a partial
// fill, or any error at all falls back to the KV path that has always worked, and the cache is
// refilled from KV afterwards. That is the whole difference from the design this repo removed —
// see the header of search-engine-do.ts, where DO storage WAS the store, a wake read it instead of
// the origin, and a cold boot paid a blocking ~70MB write burst before it could answer.
//
// What it buys is the cost that survives a warm KV cache: a wake has to materialise the archive
// into a fresh wasm heap wherever the bytes come from, and everything before that is what a local
// copy can remove. HOW MUCH it removes is what the two formats differ on, and the measurements
// below were all taken on the DECOMPRESSED one — the single English-only archive of generation 19,
// where a cached wake skipped the fetch AND the gunzip. Under the partitioned format a cached wake
// still gunzips, so read the numbers as the ceiling this bought at the time, not as today's saving.
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
// TWO FORMATS LIVE HERE, chosen by the ARCHIVE's shape, not by this module:
//
//   - An UNCOMPRESSED archive caches DECOMPRESSED, which is what this cache did originally — the
//     whole point was removing the gunzip from a wake, and one ~84MB copy per region fit the pool.
//     No publisher emits an uncompressed archive today (store_gzip_bytes is the format flag, and
//     every publisher sets it), so this format is what keeps a compression revert code-only.
//   - PARTITIONED archives cache COMPRESSED, one row-family per stored KV chunk (see
//     putCompressedChunk / cachedCompressedStream). This is plan reconciliation 2: the partitioned
//     corpus is ~385MB decompressed (2026-08-16, content generation 32), and 9 regions × ~385MB ≈
//     3.5GB of decompressed copies plus the coordinator's ~1.5GB staging peak does NOT fit the 5GB
//     DO pool. Compressed the whole store is ~165MB, so 9 regions of it is ~1.5GB — spread across
//     `partition_count` objects a region, each holding its own partition's
//     `partitions[k].store_gzip_bytes` — leaving the pool at ~3.2GB peak. The cost is a
//     local gunzip when a cached partition is loaded — paid at the publish COMMIT (the publisher's
//     window, not a user's request) and on genuinely cold wakes, which paid it on the KV path anyway.
//
// Sizing, against the Workers Free plan's Durable Objects limits (5GB stored, 5M row reads/day,
// 100k row writes/day):
//
//   - row count follows `ceil(cached bytes / BLOB_GROUP_BYTES)` over ONE object's archive — one
//     partition's compressed chunks today, and there is no separate residue archive to add to it
//     (generation 19 folded that into the printing record). Dated for scale: ~52 rows held the
//     76.6MB single archive decompressed, and ~8 more its 11.8MB residue, before either was true
//   - a wake reads that object's rows and no others, which at current traffic is thousands a day
//     against 5,000,000 — the read meter has never been the constraint here
//   - a fill writes them and a replacement deletes them (deletes bill as writes), once per object
//     per publish — hundreds a day against 100,000
//   - STORAGE IS THE AXIS THAT BINDS, and the bound is `regions × partition_count × one partition
//     compressed` — nine times the whole compressed store, whatever `partition_count` is, which
//     is the arithmetic above and is ~1.5GB against the 5GB ceiling however much traffic arrives.
//     Take the per-object factor from the manifest's `partitions[k].store_gzip_bytes` rather than
//     from a number written down here. What makes it affordable is that engine DOs are
//     named per REGION rather than per colo — nine location hints, a fixed multiplier. Under
//     per-colo naming the same cache would have been bounded only by how many of Cloudflare's ~330
//     colos saw traffic, times the shard width, which is the shape that forced free-plan sharding
//     down to a single shard the last time this storage held a copy of the store.
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
);
CREATE TABLE IF NOT EXISTS live_manifest (
	id INTEGER PRIMARY KEY,
	json TEXT NOT NULL
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
/**
 * Throw away one cached archive, because it turned out not to be the bytes it claimed.
 *
 * The cache's whole safety argument is that it can only ever be a FASTER way to get the SAME bytes,
 * and every guard here defends the write side: meta last, length checked, no readable short copy.
 * None of that helps once a copy is readable and wrong — which happened on 2026-08-13, when two
 * writers on one key interleaved their rows and both counted a full archive, so `commit()` wrote a
 * meta row over a mixture. `isCached` then answered yes forever and every attach fed wasm the same
 * corrupt archive, so `/cards/*` on that object 500'd permanently: the retry re-read the same copy.
 *
 * A cache that cannot be invalidated by its own reader is a trap, so this is the escape hatch. It is
 * always safe: KV is the source of truth and the next load refills from it.
 */
export function dropCached(storage: ArchiveCacheStorage, key: string): void {
	ensureCacheSchema(storage);
	exec(storage, "DELETE FROM archive_cache_meta WHERE archive_key = ?", key);
	exec(storage, "DELETE FROM archive_cache WHERE archive_key = ?", key);
}

export function pruneCache(storage: ArchiveCacheStorage, keep: readonly string[]): string[] {
	const keys = exec(storage, "SELECT archive_key FROM archive_cache_meta").map((r) => String(r.archive_key));
	const stale = keys.filter((k) => !keep.includes(k));
	for (const key of stale) {
		exec(storage, "DELETE FROM archive_cache WHERE archive_key = ?", key);
		exec(storage, "DELETE FROM archive_cache_meta WHERE archive_key = ?", key);
	}
	return stale;
}

// ── The COMPRESSED archive cache (partitioned stores) ──────────────────────────
//
// A partitioned archive is cached as its KV chunks, AS STORED: each gzip member under its own
// cache key, so the reader can run one DecompressionStream per member — workerd rejects
// concatenated members in a single stream ("Trailing bytes after end of compressed data"), which
// is the same reason the KV loader decompresses per chunk. Reusing the row/meta machinery above
// per chunk keeps every existing guarantee: meta written LAST per chunk, a length check per chunk,
// and completeness of the WHOLE archive judged by all chunks present + their stored bytes summing
// to the manifest's store_gzip_bytes. A fill that dies between chunks leaves a set that
// cachedCompressedStream refuses, exactly as a half-written decompressed copy is refused by its meta.

/** Cache key for one stored (compressed) chunk of an archive. */
export function compressedChunkKey(archiveKey: string, seq: number): string {
	return `${archiveKey}:gz:${seq}`;
}

/** Every cache key a compressed archive occupies — the prune keep-list's unit. */
export function compressedCacheKeys(archiveKey: string, chunkCount: number): string[] {
	return Array.from({ length: chunkCount }, (_, seq) => compressedChunkKey(archiveKey, seq));
}

/**
 * Store one chunk exactly as KV holds it. The chunk is whole and in hand (the KV
 * loader materialises each stored value before decompressing, and the prefetch
 * fetches values whole), so write-then-commit is one synchronous sequence — no
 * partially-written chunk can ever carry a meta row.
 */
export function putCompressedChunk(
	storage: ArchiveCacheStorage,
	archiveKey: string,
	seq: number,
	bytes: Uint8Array,
): void {
	const writer = cacheWriter(storage, compressedChunkKey(archiveKey, seq), bytes.byteLength);
	writer.write(bytes);
	if (writer.commit() === 0) {
		throw new Error(`compressed cache chunk ${seq} of ${archiveKey} did not commit its own length`);
	}
}

/**
 * Whether the WHOLE compressed archive is held locally: every chunk's meta
 * present, and their stored lengths summing to what the manifest says KV holds.
 * The sum is the cross-chunk integrity check — per-chunk meta only proves each
 * row-family matches itself.
 */
export function isCompressedCached(
	storage: ArchiveCacheStorage,
	archiveKey: string,
	chunkCount: number,
	expectedGzipBytes: number,
): boolean {
	let total = 0;
	for (let seq = 0; seq < chunkCount; seq++) {
		const meta = exec(
			storage,
			"SELECT total_bytes, row_count FROM archive_cache_meta WHERE archive_key = ?",
			compressedChunkKey(archiveKey, seq),
		)[0];
		if (!meta) return false;
		total += Number(meta.total_bytes);
	}
	return total === expectedGzipBytes;
}

/**
 * The cached compressed archive as a stream of its DECOMPRESSED bytes, or null
 * when any chunk is missing or the stored total disagrees with the manifest.
 *
 * One row per pull and one gzip member per chunk, mirroring kvArchiveStream's
 * discipline: at most one ~1.5MB row is resident on the JS side, and the
 * decompressed pieces flow into wasm as they emerge. The gunzip this pays is
 * the deliberate trade recorded in the header — it buys the pool back.
 */
export function cachedCompressedStream(
	storage: ArchiveCacheStorage,
	archiveKey: string,
	chunkCount: number,
	expectedGzipBytes: number,
): ReadableStream<Uint8Array> | null {
	if (!isCompressedCached(storage, archiveKey, chunkCount, expectedGzipBytes)) return null;
	let chunk = 0;
	let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				if (current) {
					const { done, value } = await current.read();
					if (!done) {
						controller.enqueue(value);
						return;
					}
					current = null;
					chunk += 1;
				}
				if (chunk >= chunkCount) {
					controller.close();
					return;
				}
				const key = compressedChunkKey(archiveKey, chunk);
				const meta = exec(
					storage,
					"SELECT total_bytes, row_count FROM archive_cache_meta WHERE archive_key = ?",
					key,
				)[0];
				if (!meta) {
					// isCompressedCached said yes and a chunk vanished underneath: corrupt copy. Fail
					// the load — the previously loaded engine stays in place and KV refills next time.
					controller.error(new Error(`compressed cache for ${archiveKey} lost chunk ${chunk} mid-read`));
					return;
				}
				const rows = cachedArchiveStream(storage, key, Number(meta.total_bytes));
				if (!rows) {
					controller.error(new Error(`compressed cache for ${archiveKey} chunk ${chunk} is unreadable`));
					return;
				}
				current = rows.pipeThrough(new DecompressionStream("gzip")).getReader();
			}
		},
	});
}

/**
 * Remember which store the publisher says is live.
 *
 * PUSHED STATE, not a cache. The publisher writes this into every region during the notify phase —
 * including regions that are COLD, which cost nothing to tell: the object wakes, writes one row,
 * and evicts again without loading a byte. That is what makes it trustworthy enough to start a cold
 * load from, and it is why notifyPublish records it even when it has no engine to swap.
 *
 * It exists to take KV off the cold path entirely. Reading the manifest from KV was the last
 * network I/O a cold start did — measured at 124-129ms, against 0ms for everything else once the
 * archive is cached locally.
 */
export function recordLiveManifest(storage: ArchiveCacheStorage, manifest: unknown): void {
	ensureCacheSchema(storage);
	exec(storage, "INSERT OR REPLACE INTO live_manifest (id, json) VALUES (0, ?)", JSON.stringify(manifest));
}

/** The last manifest the publisher pushed here, or null if it has never been told. */
export function readLiveManifest(storage: ArchiveCacheStorage): unknown | null {
	try {
		ensureCacheSchema(storage);
		const row = exec(storage, "SELECT json FROM live_manifest WHERE id = 0")[0];
		return row ? JSON.parse(String(row.json)) : null;
	} catch {
		// Never a reason to fail a load: no local manifest simply means reading KV.
		return null;
	}
}
