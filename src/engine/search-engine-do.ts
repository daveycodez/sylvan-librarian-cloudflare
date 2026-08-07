// Per-colo warm-engine Durable Object — the only thing that serves engine
// queries. Worker isolates parse and RPC here; they never load the store.
// One DO per colo (engine-LAX, engine-SEA, ...), created in the colo that
// first names it, so sharding tracks the traffic distribution. No alarms, no
// standing cost: idle colos evict their DO and cost nothing (scale to zero);
// the wake path below makes revival cheap.
//
// Wake-ups avoid R2: the store is persisted in this DO's embedded SQLite
// (colocated disk), so a wake feeds wasm from local chunks and only checks
// the R2 manifest in the background (stale-while-revalidate for the store
// itself). Nightly publishes therefore propagate lazily — live DOs pick them
// up via the per-request staleness check within minutes, woken DOs via the
// freshen pass — no push channel, no cron fan-out.

import { DurableObject } from "cloudflare:workers";
import {
	type AdoptableStoreMeta,
	adoptStoreFromChunks,
	currentStoreKey,
	getEngine,
	openStoreStream,
	readManifest,
	reloadStore,
	tryGetLoadedEngine,
} from "./store";
import type { Engine, EngineSearchOptions, EngineSearchResult, Env } from "./types";
import { EngineUnavailableError } from "./types";

/**
 * RPC error marker: workerd propagates only Error#message across RPC, so the
 * EngineUnavailableError contract (routes turn it into upstream's exact 503 /
 * the bootstrap page) is encoded into the message and decoded by RemoteEngine.
 */
export const ENGINE_UNAVAILABLE_MARKER = "__ENGINE_UNAVAILABLE__";

function rethrowForRpc(err: unknown): never {
	if (err instanceof EngineUnavailableError) {
		throw new Error(`${ENGINE_UNAVAILABLE_MARKER}:${err.bootstrapping ? "1" : "0"}:${err.message}`);
	}
	throw err;
}

/** Just under the 2MB SQLite per-value cap: fewer rows to write on persist
 * and read back on wake. The read path accepts any chunking, so stores
 * persisted at an older chunk size keep working until their next repersist. */
const PERSIST_CHUNK_BYTES = 1_900_000;

export class SearchEngine extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS store_meta (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				store_key TEXT NOT NULL,
				store_bytes INTEGER NOT NULL,
				card_count INTEGER NOT NULL,
				built_at TEXT NOT NULL,
				chunk_count INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS store_chunks (seq INTEGER PRIMARY KEY, bytes BLOB NOT NULL);`,
		);
	}

	// ── RPC surface ────────────────────────────────────────────────────────────
	//
	// Every method takes an optional fallbackHint: when this DO is COLD and a
	// hint is present, it relays the call to the region's DO (engine-<hint>)
	// and wakes itself in the background — the caller never waits on a wake.
	// The relay passes NO hint, so a cold regional DO answers after its own
	// wake rather than relaying further (recursion depth 1 by construction).

	/** Searches already executing here; snapshotted per request as the queue-
	 * depth (`load`) signal the isolates' shard controllers scale on. */
	private inFlightSearches = 0;

	async search(
		opts: EngineSearchOptions,
		fallbackHint?: DurableObjectLocationHint,
	): Promise<EngineSearchResult & { acquireMs: number; load: number }> {
		if (this.shouldRelay(fallbackHint)) {
			this.wakeInBackground();
			const relayStart = Date.now();
			// The relayed result carries the REGIONAL engine's acquireMs/load —
			// honest numbers for whoever actually computed the answer.
			const result = await this.regionStub(fallbackHint).search(opts);
			console.log(`Cold colo relayed search to engine-${fallbackHint} in ${Date.now() - relayStart}ms`);
			return result;
		}
		const load = this.inFlightSearches;
		this.inFlightSearches += 1;
		try {
			// Time the engine acquisition (the wake cost, when there is one) for
			// the calling isolate's cold-path breakdown. Date.now() only advances
			// across I/O in Workers, which is exactly what a wake spends:
			// SQLite/R2 reads. Warm calls report ~0.
			const acquireStart = Date.now();
			const engine = await this.engine();
			const acquireMs = Date.now() - acquireStart;
			try {
				return { ...(await engine.search(opts)), acquireMs, load };
			} catch (err) {
				rethrowForRpc(err);
			}
		} finally {
			this.inFlightSearches -= 1;
		}
	}

	/** Both catalogs in one RPC (get_catalog needs both). */
	async catalog(
		fallbackHint?: DurableObjectLocationHint,
	): Promise<{ types: Record<string, number>; keywords: Record<string, number> }> {
		if (this.shouldRelay(fallbackHint)) {
			this.wakeInBackground();
			return this.regionStub(fallbackHint).catalog();
		}
		const engine = await this.engine();
		return { types: await engine.commonCardTypes(), keywords: await engine.commonCardKeywords() };
	}

	async samplePreferred(
		numCards: number,
		fields: string[],
		fallbackHint?: DurableObjectLocationHint,
	): Promise<Record<string, unknown>[]> {
		if (this.shouldRelay(fallbackHint)) {
			this.wakeInBackground();
			return this.regionStub(fallbackHint).samplePreferred(numCards, fields);
		}
		const engine = await this.engine();
		return engine.samplePreferred(numCards, fields);
	}

	async size(fallbackHint?: DurableObjectLocationHint): Promise<number> {
		if (this.shouldRelay(fallbackHint)) {
			this.wakeInBackground();
			return this.regionStub(fallbackHint).size();
		}
		const engine = await this.engine();
		return engine.size();
	}

	// ── Cold relay ─────────────────────────────────────────────────────────────

	/** Cold (no engine in this isolate) and permitted to relay. */
	private shouldRelay(hint?: DurableObjectLocationHint): hint is DurableObjectLocationHint {
		return hint !== undefined && tryGetLoadedEngine() === null;
	}

	/** The regional fallback engine's stub, typed like RemoteEngine's. */
	private regionStub(hint: DurableObjectLocationHint) {
		return this.env.SEARCH_ENGINE.get(this.env.SEARCH_ENGINE.idFromName(`engine-${hint}`), {
			locationHint: hint,
		}) as unknown as SearchEngine;
	}

	/** Single-flighted wake under waitUntil; failures logged, never thrown. */
	private wakeInBackground(): void {
		this.ctx.waitUntil(
			this.engine().then(
				() => {},
				(err) => console.warn(`Background colo wake failed (still relaying): ${err}`),
			),
		);
	}

	// ── Engine acquisition ─────────────────────────────────────────────────────

	private async engine(): Promise<Engine> {
		try {
			// Already live in this isolate (also covers the case where the machine
			// hosting this DO serves worker traffic that warmed the module global).
			if (tryGetLoadedEngine()) return await getEngine(this.env, this.ctx);

			// Wake path: adopt the SQLite copy — local disk, no R2 — and check
			// freshness in the background.
			const meta = this.sqliteMeta();
			if (meta) {
				try {
					const wakeStart = Date.now();
					const engine = await adoptStoreFromChunks(meta, this.sqliteChunks(meta.chunk_count));
					console.log(
						`SearchEngine wake: adopted ${meta.store_key} from SQLite ` +
							`(${meta.store_bytes} bytes, ${meta.chunk_count} chunks) in ${Date.now() - wakeStart}ms`,
					);
					this.ctx.waitUntil(this.freshen());
					return engine;
				} catch (err) {
					console.warn(`SQLite store adoption failed (falling back to R2): ${err}`);
				}
			}

			// First boot (or corrupt local copy): R2 path, then persist locally.
			const wakeStart = Date.now();
			const engine = await getEngine(this.env, this.ctx);
			console.log(`SearchEngine wake: loaded store from R2 in ${Date.now() - wakeStart}ms (no usable local copy)`);
			this.ctx.waitUntil(this.persistCurrent());
			return engine;
		} catch (err) {
			rethrowForRpc(err);
		}
	}

	/** Reload from R2 if the manifest moved past what we serve; then repersist. */
	private async freshen(): Promise<void> {
		try {
			const manifest = await readManifest(this.env);
			if (!manifest || manifest.store_key === currentStoreKey()) return;
			await reloadStore(this.env);
			await this.persistCurrent();
		} catch (err) {
			console.warn(`Store freshen failed (still serving current store): ${err}`);
		}
	}

	// ── SQLite persistence ─────────────────────────────────────────────────────

	private sqliteMeta(): (AdoptableStoreMeta & { chunk_count: number }) | null {
		const rows = this.ctx.storage.sql
			.exec("SELECT store_key, store_bytes, card_count, built_at, chunk_count FROM store_meta WHERE id = 1")
			.toArray();
		const row = rows[0];
		if (!row) return null;
		return {
			store_key: row.store_key as string,
			store_bytes: row.store_bytes as number,
			card_count: row.card_count as number,
			built_at: String(row.built_at),
			chunk_count: row.chunk_count as number,
		};
	}

	/** Lazy row-by-row read so at most ~1MB of chunk data is resident in JS. */
	private async *sqliteChunks(expected: number): AsyncGenerator<Uint8Array> {
		let seen = 0;
		for (const row of this.ctx.storage.sql.exec("SELECT bytes FROM store_chunks ORDER BY seq")) {
			seen++;
			yield new Uint8Array(row.bytes as ArrayBuffer);
		}
		if (seen !== expected) {
			throw new Error(`SQLite store is incomplete: ${seen}/${expected} chunks`);
		}
	}

	/**
	 * Persist the currently-loaded store into SQLite by re-reading its bytes
	 * from the colo cache (they were just streamed through it). Crash-safe by
	 * ordering: meta is deleted first and written last, so a partial write
	 * reads as "no local copy" and the wake path falls back to R2.
	 */
	private async persistCurrent(): Promise<void> {
		try {
			const key = currentStoreKey();
			if (!key) return;
			if (this.sqliteMeta()?.store_key === key) return;
			const manifest = await readManifest(this.env);
			if (!manifest || manifest.store_key !== key) return;

			const sql = this.ctx.storage.sql;
			sql.exec("DELETE FROM store_meta");
			sql.exec("DELETE FROM store_chunks");

			const body = await openStoreStream(this.env, key);
			const reader = body.getReader();
			let seq = 0;
			let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
			const flush = (bytes: Uint8Array) => {
				// Copy to an exact ArrayBuffer: SQL params want ArrayBuffer-backed
				// bytes, and a subarray view would otherwise pin its parent buffer.
				const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
				sql.exec("INSERT INTO store_chunks (seq, bytes) VALUES (?, ?)", seq++, exact);
			};
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					let merged: Uint8Array;
					if (carry.length) {
						merged = new Uint8Array(carry.length + value.length);
						merged.set(carry);
						merged.set(value, carry.length);
					} else {
						merged = value;
					}
					let offset = 0;
					while (merged.length - offset >= PERSIST_CHUNK_BYTES) {
						flush(merged.subarray(offset, offset + PERSIST_CHUNK_BYTES));
						offset += PERSIST_CHUNK_BYTES;
					}
					carry = merged.subarray(offset);
				}
			} finally {
				reader.releaseLock();
			}
			if (carry.length) flush(carry);

			sql.exec(
				"INSERT INTO store_meta (id, store_key, store_bytes, card_count, built_at, chunk_count) VALUES (1, ?, ?, ?, ?, ?)",
				manifest.store_key,
				manifest.store_bytes,
				manifest.card_count,
				manifest.built_at,
				seq,
			);
			console.log(`Persisted ${key} to DO SQLite (${seq} chunks)`);
		} catch (err) {
			console.warn(`SQLite persist failed (wake-ups will use R2): ${err}`);
		}
	}
}
