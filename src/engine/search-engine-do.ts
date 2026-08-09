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
import type {
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	Env,
	ResultShape,
} from "./types";
import { EngineUnavailableError } from "./types";

/** Shard-controller riders every search RPC carries back (see RemoteEngine). */
interface SearchTelemetry {
	acquireMs: number;
	load: number;
	rate: number;
	relayed: boolean;
}

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
	 * depth (`load`) signal. */
	private inFlightSearches = 0;
	/** Arrival times of recent searches, for the request-RATE the shard
	 * controller gates expansion on. Rate is the cause-side measurement:
	 * latency rises for reasons sharding cannot fix (KV slowness, network,
	 * a noisy neighbour), and adding shards to those only makes them worse,
	 * because every new shard cold-loads ~70MB. Load without slowness means
	 * we are coping; slowness without load means the problem is elsewhere.
	 * Real saturation always shows both. */
	private recentSearches: number[] = [];

	/** Searches per second over the trailing window. */
	private searchRate(now: number): number {
		const windowMs = 10_000;
		this.recentSearches.push(now);
		if (this.recentSearches.length > 4096) this.recentSearches.shift();
		this.recentSearches = this.recentSearches.filter((t) => now - t <= windowMs);
		return this.recentSearches.length / (windowMs / 1000);
	}

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
	): Promise<EngineSearchResult & SearchTelemetry> {
		if (this.shouldRelay(fallbackHint)) {
			return this.relay(fallbackHint, (region) => region.search(opts));
		}
		return this.instrumented((engine) => engine.search(opts));
	}

	/**
	 * The API path: identical routing and telemetry, but the cards come back
	 * already encoded, so no card ever becomes a JS object in the isolate that
	 * serves the request. See EngineSerializedResult.
	 */
	async searchSerialized(
		opts: EngineSearchOptions,
		shape: ResultShape,
		fallbackHint?: DurableObjectLocationHint,
	): Promise<EngineSerializedResult & SearchTelemetry> {
		if (this.shouldRelay(fallbackHint)) {
			return this.relay(fallbackHint, (region) => region.searchSerialized(opts, shape));
		}
		return this.instrumented((engine) => engine.searchSerialized(opts, shape));
	}

	/**
	 * Answer from the region's DO while this colo warms behind it.
	 *
	 * The relayed result carries the REGIONAL engine's acquireMs/load/rate —
	 * honest numbers for whoever actually computed the answer, but they describe
	 * a DIFFERENT DO than the one the caller is scaling. `relayed` marks the
	 * whole sample so the shard controller drops it: the wall time carries a
	 * cross-colo hop (region.ts budgets 60-80ms for a bad one, against a 75ms
	 * latency bar), and the depth/rate belong to the region. Without this every
	 * freshly opened shard, which relays until it warms, would manufacture the
	 * evidence for the next expansion.
	 */
	private async relay<T extends object>(
		hint: DurableObjectLocationHint,
		call: (region: SearchEngine) => Promise<T>,
	): Promise<T & { relayed: true }> {
		this.warmInBackground();
		const relayStart = Date.now();
		const result = await call(this.regionStub(hint));
		console.log(`Cold colo relayed search to engine-${hint} in ${Date.now() - relayStart}ms`);
		return { ...result, relayed: true };
	}

	/** Run a search against the local engine, carrying the autoscaler's signals. */
	private async instrumented<T extends object>(run: (engine: Engine) => Promise<T>): Promise<T & SearchTelemetry> {
		const load = this.inFlightSearches;
		const rate = this.searchRate(Date.now());
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
				return { ...(await run(engine)), acquireMs, load, rate, relayed: false };
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

	async samplePreferredSerialized(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		fallbackHint?: DurableObjectLocationHint,
	): Promise<EngineSerializedResult> {
		if (this.shouldRelay(fallbackHint)) {
			this.warmInBackground();
			return this.regionStub(fallbackHint).samplePreferredSerialized(numCards, fields, shape);
		}
		const engine = await this.engine();
		return engine.samplePreferredSerialized(numCards, fields, shape);
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
