// Engine implementation backed by the colo's SearchEngine DO — the only
// serving path: isolates parse and RPC here, never loading the store.

import { ENGINE_UNAVAILABLE_MARKER } from "./search-engine-do";
import { reportEngineLoad } from "./shard-controller";
import type { Engine, EngineSearchOptions, EngineSearchResult } from "./types";
import { EngineUnavailableError } from "./types";

/** Structural stub type: the SearchEngine DO's RPC surface. `acquireMs` is
 * optional only for one deploy's worth of rolling-update skew (new isolate,
 * old DO); current DO code always sets it. */
interface SearchEngineStub {
	search(
		opts: EngineSearchOptions,
		fallbackHint?: DurableObjectLocationHint,
	): Promise<EngineSearchResult & { acquireMs?: number; load?: number }>;
	catalog(
		fallbackHint?: DurableObjectLocationHint,
	): Promise<{ types: Record<string, number>; keywords: Record<string, number> }>;
	samplePreferred(
		numCards: number,
		fields: string[],
		fallbackHint?: DurableObjectLocationHint,
	): Promise<Record<string, unknown>[]>;
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
			const rest = message.slice(at + ENGINE_UNAVAILABLE_MARKER.length + 1);
			throw new EngineUnavailableError(rest.slice(2), rest.startsWith("1"));
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

	async search(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		const rpcStart = Date.now();
		const { acquireMs, load, ...result } = await withRetry(() => this.stub.search(opts, this.fallbackHint));
		// The DO's queue-depth rider feeds the shard autoscaler; both metadata
		// fields are stripped so the search envelope never carries them.
		if (load !== undefined) reportEngineLoad(load);
		// Wake observability: logged only when the DO had to acquire its engine
		// (acquireMs > 0) — warm queries stay quiet. The gap between the two
		// numbers is transport + serialization.
		if (acquireMs) {
			console.log(`Remote engine search: ${Date.now() - rpcStart}ms rpc, ${acquireMs}ms engine acquisition in the DO`);
		}
		return result;
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

	size(): Promise<number> {
		return withRetry(() => this.stub.size(this.fallbackHint));
	}
}
