// Per-colo warm-engine Durable Object — the only thing that serves engine
// queries. Worker isolates parse and RPC here; they never load the store.
// One DO per colo (engine-LAX, engine-SEA, ...), created in the colo that
// first names it, so sharding tracks the traffic distribution. No alarms, no
// standing cost: idle colos evict their DO and cost nothing (scale to zero);
// the wake path below makes revival cheap.
//
// Wake-ups avoid D1: the store is persisted in this DO's embedded SQLite
// (colocated disk), so a wake feeds wasm from local chunks and only checks
// the D1 manifest in the background (stale-while-revalidate for the store
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
import type { Engine, EngineSearchOptions, EngineSearchResult, Env, StoreManifest } from "./types";
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
/**
 * Pause between persist chunk INSERTs. The DO output gate holds every
 * outgoing response until storage writes issued before it are confirmed —
 * persisting 70MB in one continuous burst held live responses hostage for
 * 20-58s on brand-new shards (measured). Trickling the writes means a
 * response only ever waits on ONE in-flight chunk.
 */
const PERSIST_CHUNK_PAUSE_MS = 150;

export class SearchEngine extends DurableObject<Env> {
	/** Schema created once per instance — see ensureSchema. */
	private schemaReady = false;

	/**
	 * Create the local store-copy schema. NOT in the constructor: DDL is a
	 * storage write, and exceeding the Durable Objects free-tier daily
	 * allowance blocks the entire storage API — so a constructor that writes
	 * makes this DO unconstructable, and SEARCH GOES DOWN with it, even though
	 * serving a query needs nothing from local storage (the store comes from
	 * D1, a separate quota). Local persistence is a cold-start optimisation;
	 * losing it must never cost availability.
	 */
	private ensureSchema(): void {
		if (this.schemaReady) return;
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
		this.schemaReady = true;
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

	/**
	 * Storage-only pre-seed: materialize this shard's SQLite copy of the
	 * current store WITHOUT loading the engine, so a later expansion opens a
	 * ~1s local revival instead of running a 70MB D1 first-boot mid-spike.
	 * Fired fire-and-forget by isolates when the active fan-out nears its
	 * expansion threshold (see shard-controller). A shard whose copy is
	 * current answers in ~1ms and simply evicts again — no engine, no alarm,
	 * no residency: seeding never compromises scale-to-zero.
	 */
	async seed(): Promise<{ seeding: boolean }> {
		const manifest = await readManifest(this.env);
		if (!manifest) return { seeding: false };
		if (this.sqliteMeta()?.store_key === manifest.store_key) return { seeding: false };
		console.log(`Seeding shard SQLite ahead of need (${manifest.store_key})`);
		this.ctx.waitUntil(
			this.persistStore(manifest).catch((err) => {
				console.warn(`Seed persist failed (expansion will first-boot from D1): ${err}`);
			}),
		);
		return { seeding: true };
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

			// Wake path: adopt the SQLite copy — local disk, no D1 — and check
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
					console.warn(`SQLite store adoption failed (falling back to D1): ${err}`);
				}
			}

			// First boot (or corrupt local copy): D1 path, then persist locally.
			const wakeStart = Date.now();
			const engine = await getEngine(this.env, this.ctx);
			console.log(`SearchEngine wake: loaded store from D1 in ${Date.now() - wakeStart}ms (no usable local copy)`);
			this.ctx.waitUntil(this.persistCurrent());
			return engine;
		} catch (err) {
			rethrowForRpc(err);
		}
	}

	/** Reload from D1 if the manifest moved past what we serve; then repersist. */
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

	/** The local copy's metadata, or null when there is no usable local copy —
	 * including when storage itself is unavailable (see ensureSchema). Callers
	 * treat null as "no local copy" and fall back to loading from D1, which is
	 * exactly the right behaviour for a blocked or empty local store. */
	private sqliteMeta(): (AdoptableStoreMeta & { chunk_count: number }) | null {
		let rows: Record<string, unknown>[];
		try {
			this.ensureSchema();
			rows = this.ctx.storage.sql
				.exec("SELECT store_key, store_bytes, card_count, built_at, chunk_count FROM store_meta WHERE id = 1")
				.toArray();
		} catch (err) {
			console.warn(`Local store copy unavailable, will use D1: ${err}`);
			return null;
		}
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

	/** Single-flighted store persist: seed() and persistCurrent() may race. */
	private persistInFlight: Promise<void> | null = null;

	private persistStore(manifest: StoreManifest): Promise<void> {
		this.persistInFlight ??= this.streamStoreToSqlite(manifest).finally(() => {
			this.persistInFlight = null;
		});
		return this.persistInFlight;
	}

	/** Persist the currently-loaded store into SQLite (no-op if already stored). */
	private async persistCurrent(): Promise<void> {
		try {
			const key = currentStoreKey();
			if (!key) return;
			if (this.sqliteMeta()?.store_key === key) return;
			const manifest = await readManifest(this.env);
			if (!manifest || manifest.store_key !== key) return;
			await this.persistStore(manifest);
		} catch (err) {
			console.warn(`SQLite persist failed (wake-ups will use D1): ${err}`);
		}
	}

	/**
	 * Stream the manifest's store bytes (colo cache first, D1 on miss) into
	 * SQLite. Crash-safe by ordering: meta is deleted first and written last,
	 * so a partial write reads as "no local copy" and the wake path falls
	 * back to D1. Runs WITHOUT the engine — seed() uses it on shards that
	 * have never loaded a store.
	 */
	private async streamStoreToSqlite(manifest: StoreManifest): Promise<void> {
		{
			this.ensureSchema();
			const sql = this.ctx.storage.sql;
			sql.exec("DELETE FROM store_meta");
			sql.exec("DELETE FROM store_chunks");

			const body = await openStoreStream(this.env, manifest.store_key, manifest.store_bytes, manifest.chunk_count ?? 0);
			const reader = body.getReader();
			let seq = 0;
			let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
			const flush = (bytes: Uint8Array) => {
				// Copy to an exact ArrayBuffer: SQL params want ArrayBuffer-backed
				// bytes, and a subarray view would otherwise pin its parent buffer.
				const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
				sql.exec("INSERT INTO store_chunks (seq, bytes) VALUES (?, ?)", seq++, exact);
			};
			const persistStart = Date.now();
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
						// Let the output gate drain between chunks (see
						// PERSIST_CHUNK_PAUSE_MS) — never block live responses
						// behind the whole store.
						await new Promise((resolve) => setTimeout(resolve, PERSIST_CHUNK_PAUSE_MS));
					}
					carry = merged.subarray(offset);
				}
			} finally {
				reader.releaseLock();
			}
			if (carry.length) flush(carry);
			console.log(`Persist trickled ${seq} chunks in ${Date.now() - persistStart}ms`);

			sql.exec(
				"INSERT INTO store_meta (id, store_key, store_bytes, card_count, built_at, chunk_count) VALUES (1, ?, ?, ?, ?, ?)",
				manifest.store_key,
				manifest.store_bytes,
				manifest.card_count,
				manifest.built_at,
				seq,
			);
			console.log(`Persisted ${manifest.store_key} to DO SQLite (${seq} chunks)`);
		}
	}
}
