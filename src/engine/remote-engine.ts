// Engine implementation backed by the colo's SearchEngine DO — the only
// serving path: isolates parse and RPC here, never loading the store.

import { ENGINE_UNAVAILABLE_MARKER } from "./search-engine-do";
import type { Engine, EngineSearchOptions, EngineSearchResult } from "./types";
import { EngineUnavailableError } from "./types";

/** Structural stub type: the SearchEngine DO's RPC surface. `acquireMs` is
 * optional only for one deploy's worth of rolling-update skew (new isolate,
 * old DO); current DO code always sets it. */
interface SearchEngineStub {
	search(opts: EngineSearchOptions): Promise<EngineSearchResult & { acquireMs?: number }>;
	catalog(): Promise<{ types: Record<string, number>; keywords: Record<string, number> }>;
	samplePreferred(numCards: number, fields: string[]): Promise<Record<string, unknown>[]>;
	size(): Promise<number>;
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

export class RemoteEngine implements Engine {
	/** get_catalog reads both catalogs; one RPC serves both calls. */
	private catalogOnce: Promise<{ types: Record<string, number>; keywords: Record<string, number> }> | null = null;

	constructor(private readonly stub: SearchEngineStub) {}

	async search(opts: EngineSearchOptions): Promise<EngineSearchResult> {
		const rpcStart = Date.now();
		const { acquireMs, ...result } = await unwrap(this.stub.search(opts));
		// Wake observability: logged only when the DO had to acquire its engine
		// (acquireMs > 0) — warm queries stay quiet. The gap between the two
		// numbers is transport + serialization. The field is stripped so the
		// search envelope never carries it.
		if (acquireMs) {
			console.log(`Remote engine search: ${Date.now() - rpcStart}ms rpc, ${acquireMs}ms engine acquisition in the DO`);
		}
		return result;
	}

	private catalog() {
		this.catalogOnce ??= unwrap(this.stub.catalog());
		return this.catalogOnce;
	}

	async commonCardTypes(): Promise<Record<string, number>> {
		return (await this.catalog()).types;
	}

	async commonCardKeywords(): Promise<Record<string, number>> {
		return (await this.catalog()).keywords;
	}

	samplePreferred(numCards: number, fields: string[]): Promise<Record<string, unknown>[]> {
		return unwrap(this.stub.samplePreferred(numCards, fields));
	}

	size(): Promise<number> {
		return unwrap(this.stub.size());
	}
}
