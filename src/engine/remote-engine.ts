// Engine implementation backed by the colo's SearchEngine DO — the only
// serving path: isolates parse and RPC here, never loading the store.

import { ENGINE_UNAVAILABLE_MARKER } from "./search-engine-do";
import { reportEngineLatency, reportEngineLoad, reportEngineRate } from "./shard-controller";
import type { Engine, EngineSearchOptions, EngineSearchResult, EngineSerializedResult, ResultShape } from "./types";
import { EngineUnavailableError } from "./types";

/** Riders the DO attaches to a search result for the shard controller. */
type Telemetry = { acquireMs?: number; load?: number; rate?: number; relayed?: boolean };

/** Structural stub type: the SearchEngine DO's RPC surface. `acquireMs` and
 * `relayed` are optional only for one deploy's worth of rolling-update skew
 * (new isolate, old DO); current DO code always sets them. A missing `relayed`
 * reads as false, which is the pre-existing behavior — the skew window keeps
 * the old contamination rather than inventing a new failure mode. */
interface SearchEngineStub {
	search(opts: EngineSearchOptions, fallbackHint?: DurableObjectLocationHint): Promise<EngineSearchResult & Telemetry>;
	searchSerialized(
		opts: EngineSearchOptions,
		shape: ResultShape,
		fallbackHint?: DurableObjectLocationHint,
	): Promise<EngineSerializedResult & Telemetry>;
	catalog(
		fallbackHint?: DurableObjectLocationHint,
	): Promise<{ types: Record<string, number>; keywords: Record<string, number> }>;
	samplePreferred(
		numCards: number,
		fields: string[],
		fallbackHint?: DurableObjectLocationHint,
	): Promise<Record<string, unknown>[]>;
	samplePreferredSerialized(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		fallbackHint?: DurableObjectLocationHint,
	): Promise<EngineSerializedResult>;
	size(fallbackHint?: DurableObjectLocationHint): Promise<number>;
}

/** Decode the DO's EngineUnavailableError marker back into the real type. */
async function unwrap<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const at = message.indexOf(ENGINE_UNAVAILABLE_MARKER);
		if (at >= 0) {
			throw new EngineUnavailableError(message.slice(at + ENGINE_UNAVAILABLE_MARKER.length + 1));
		}
		throw err;
	}
}

/**
 * Run one engine RPC, retrying failures the runtime flags as transient.
 *
 * Every deploy RESETS every DO, and an RPC landing during the reset is
 * rejected with "Durable Object reset because its code was updated" (storage
 * resets and network blips behave the same). The runtime marks these
 * `retryable: true`, and Cloudflare's guidance is to retry them — without
 * this, the first request after each deploy surfaced as a raw 500. All
 * engine RPCs are pure reads, so retrying is always safe. Engine-unavailable
 * errors (real 503 semantics) are never retried.
 */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await unwrap(call());
		} catch (err) {
			if (err instanceof EngineUnavailableError) throw err;
			const flags = err as { retryable?: boolean; overloaded?: boolean };
			if (attempt >= 2 || flags.retryable !== true || flags.overloaded === true) throw err;
			console.warn(`Retryable engine RPC failure (attempt ${attempt + 1}): ${err}`);
			// The reset completes in well under a second; brief linear backoff.
			await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
		}
	}
}

export class RemoteEngine implements Engine {
	/** get_catalog reads both catalogs; one RPC serves both calls. */
	private catalogOnce: Promise<{ types: Record<string, number>; keywords: Record<string, number> }> | null = null;

	constructor(
		private readonly stub: SearchEngineStub,
		/** Region of the calling request: where a COLD colo DO relays to. */
		private readonly fallbackHint?: DurableObjectLocationHint,
	) {}

	/**
	 * One search RPC, with the DO's riders stripped and fed to the autoscaler.
	 *
	 * A RELAYED sample is dropped wholesale: it describes the regional DO, not
	 * the colo shard being scaled — its wall time includes a cross-colo hop, and
	 * its depth/rate are the region's. Since every freshly opened shard relays
	 * until it warms, reporting these would let each expansion argue for the next.
	 */
	private async searchRpc<T extends object>(call: () => Promise<T & Telemetry>): Promise<Omit<T, keyof Telemetry>> {
		const rpcStart = Date.now();
		const { acquireMs, load, rate, relayed, ...result } = await withRetry(call);
		if (acquireMs) {
			// Wake observability: logged only when the DO that answered had to
			// acquire its engine. Under a relay that DO is the regional one.
			console.log(
				`Remote engine search: ${Date.now() - rpcStart}ms rpc, ${acquireMs}ms engine acquisition in the DO` +
					(relayed ? " (relayed)" : ""),
			);
		}
		if (!relayed) {
			if (load !== undefined) reportEngineLoad(load);
			if (rate !== undefined) reportEngineRate(rate);
			// Wake-carrying RPCs are excluded from the latency signal too: their
			// wall time is legitimately inflated by the load.
			if (!acquireMs) reportEngineLatency(Date.now() - rpcStart);
		}
		return result as Omit<T, keyof Telemetry>;
	}

	search(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		return this.searchRpc(() => this.stub.search(opts, this.fallbackHint));
	}

	searchSerialized(opts: EngineSearchOptions, shape: ResultShape): Promise<EngineSerializedResult> {
		return this.searchRpc(() => this.stub.searchSerialized(opts, shape, this.fallbackHint));
	}

	private catalog() {
		this.catalogOnce ??= withRetry(() => this.stub.catalog(this.fallbackHint));
		return this.catalogOnce;
	}

	async commonCardTypes(): Promise<Record<string, number>> {
		return (await this.catalog()).types;
	}

	async commonCardKeywords(): Promise<Record<string, number>> {
		return (await this.catalog()).keywords;
	}

	samplePreferred(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		return withRetry(() => this.stub.samplePreferred(numCards, fields, this.fallbackHint));
	}

	samplePreferredSerialized(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult> {
		return withRetry(() => this.stub.samplePreferredSerialized(numCards, fields, shape, this.fallbackHint));
	}

	size(): Promise<number> {
		return withRetry(() => this.stub.size(this.fallbackHint));
	}
}
