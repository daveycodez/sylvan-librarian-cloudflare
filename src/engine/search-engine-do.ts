// Per-colo warm-engine Durable Object — the only thing that serves engine
// queries. Worker isolates parse and RPC here; they never load the store.
// One DO per colo (engine-LAX, engine-SEA, ...), created in the colo that
// first names it, so sharding tracks the traffic distribution. No alarms, no
// standing cost: idle colos evict their DO and cost nothing (scale to zero).
//
// The DO keeps NO local copy of the store. It used to persist all ~70MB into
// its own SQLite so wakes avoided the origin, which cost a 70MB write burst on
// first boot (blocking live responses behind the output gate until the writes
// were trickled), 70MB of the 5GB DO storage pool per colo — which is what
// forced free-plan sharding down to one shard — and ~39 metered row reads on
// every wake. KV replaced all of it: a wake is ~4 KV reads of immutable,
// colo-cached chunks, so the local copy earned nothing it cost.

import { DurableObject } from "cloudflare:workers";
import { getEngine, tryGetLoadedEngine } from "./store";
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
		throw new Error(`${ENGINE_UNAVAILABLE_MARKER}:${err.message}`);
	}
	throw err;
}

export class SearchEngine extends DurableObject<Env> {
	/** Searches already executing here; snapshotted per request as the queue-
	 * depth (`load`) signal the isolates' shard controllers scale on. */
	private inFlightSearches = 0;

	// ── RPC surface ────────────────────────────────────────────────────────────
	//
	// Every method takes an optional fallbackHint: when this DO is COLD and a
	// hint is present, it relays the call to the region's DO (engine-<hint>)
	// and warms itself in the background — the caller never waits on a load.
	// The relay passes NO hint, so a cold regional DO answers after its own
	// load rather than relaying further (recursion depth 1 by construction).

	async search(
		opts: EngineSearchOptions,
		fallbackHint?: DurableObjectLocationHint,
	): Promise<EngineSearchResult & { acquireMs: number; load: number }> {
		if (this.shouldRelay(fallbackHint)) {
			this.warmInBackground();
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
			// Time the engine acquisition (the KV load, when there is one) for
			// the calling isolate's cold-path breakdown. Date.now() only advances
			// across I/O in Workers, which is what a load spends. Warm calls
			// report ~0.
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
			this.warmInBackground();
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
			this.warmInBackground();
			return this.regionStub(fallbackHint).samplePreferred(numCards, fields);
		}
		const engine = await this.engine();
		return engine.samplePreferred(numCards, fields);
	}

	async size(fallbackHint?: DurableObjectLocationHint): Promise<number> {
		if (this.shouldRelay(fallbackHint)) {
			this.warmInBackground();
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

	/** Single-flighted load under waitUntil; failures logged, never thrown. */
	private warmInBackground(): void {
		this.ctx.waitUntil(
			this.engine().then(
				() => {},
				(err) => console.warn(`Background colo warm failed (still relaying): ${err}`),
			),
		);
	}

	// ── Engine acquisition ─────────────────────────────────────────────────────

	private async engine(): Promise<Engine> {
		try {
			// getEngine is single-flighted and returns immediately when this
			// isolate already holds the store; otherwise it streams the store in
			// from KV (~4 immutable, colo-cached reads).
			return await getEngine(this.env, this.ctx);
		} catch (err) {
			rethrowForRpc(err);
		}
	}
}
