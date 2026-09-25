/**
 * The data center's Cache API as a read-through tier over KV, for values every cold isolate needs.
 *
 * KV bills every `get` — colo-cache hit or not — against the same 100k/day free budget the request
 * meter draws on, and a cold isolate pays three of them before it can route a request: the
 * manifest, the ~778KB routing filter and the tag alias map. Measured on DeckGen for 2026-09-21:
 * ~32k cold isolates a day (one `routing filter loaded` line each), ~96k of the day's 118k KV
 * reads, and ~25GB of KV egress for the filter alone. `caches.default` is unmetered, shared by
 * every isolate in the colo, and keyed by URL; its scope is the colo, exactly KV's own `cacheTtl`
 * scope, so nothing about freshness changes.
 *
 * The previous architecture served the 70MB ARCHIVE through this API and paid a second of CPU per
 * load for the double stream (store.ts header). Values here are 2KB–800KB and read once per
 * isolate; the cost is a `match` per cold isolate instead of a metered read.
 *
 * Absent in bun (`caches` is not a global there), in the dashboard editor and in Playground
 * previews: every reader falls through to `load` unchanged. A null from `load` is never stored, so
 * a late-published value (the alias map) is found by the next reader, and a cache error of any
 * kind is a warning and a fall-through, never a failure.
 */

/** Any URL works as a Cache API key; the host is a name no request can carry. */
export const EDGE_CACHE_ORIGIN = "https://edge-cache.sylvan-librarian.internal/";

/** The Cache API key for a KV key. */
export function edgeCacheUrl(kvKey: string): string {
	return `${EDGE_CACHE_ORIGIN}${encodeURIComponent(kvKey)}`;
}

function edgeCache(): Cache | null {
	return typeof caches === "undefined" ? null : caches.default;
}

/**
 * The bytes at `url` from this colo's cache ONLY — null on a miss, where Cache API is absent, or on
 * any cache error. Never reads KV: for a caller that may wait on the colo copy but must not wait on
 * a metered, cross-colo KV read (the routing filter's bounded wait, partitioned-engine.ts).
 */
export async function matchEdgeCache(url: string): Promise<Uint8Array | null> {
	const cache = edgeCache();
	if (!cache) return null;
	try {
		const hit = await cache.match(url);
		return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
	} catch (err) {
		console.warn(`edge cache read of ${url} failed: ${err}`);
		return null;
	}
}

/** Marks a cached ABSENCE (see `missTtlSeconds`): a header, because an empty body is a value. */
export const EDGE_CACHE_ABSENT_HEADER = "X-Sylvan-Absent";

/**
 * The bytes at `url` from this colo's cache, else from `load` — which are then stored for
 * `ttlSeconds`. `defer` (a `ctx.waitUntil`) takes the store off the request's critical path.
 *
 * A null from `load` is stored only when `missTtlSeconds` > 0, and then only for that long — for
 * a value whose ABSENCE is read per request (an oracle-index bucket before its first publish),
 * where not caching the miss would make every request a metered KV read of nothing. Default 0:
 * a late-published value (the alias map) is found by the very next reader.
 */
export async function readThroughEdgeCache(
	url: string,
	ttlSeconds: number,
	load: () => Promise<Uint8Array | null>,
	defer?: (p: Promise<unknown>) => void,
	missTtlSeconds = 0,
): Promise<Uint8Array | null> {
	const cache = edgeCache();
	if (cache) {
		try {
			const hit = await cache.match(url);
			if (hit) {
				if (hit.headers.get(EDGE_CACHE_ABSENT_HEADER) === "1") return null;
				return new Uint8Array(await hit.arrayBuffer());
			}
		} catch (err) {
			console.warn(`edge cache read of ${url} failed (reading through): ${err}`);
		}
	}
	const bytes = await load();
	if (cache && (bytes !== null || missTtlSeconds > 0)) {
		await putEdgeCache(url, bytes, bytes === null ? missTtlSeconds : ttlSeconds, defer);
	}
	return bytes;
}

/**
 * Store `bytes` at `url` in this colo's cache for `ttlSeconds` — or, for null, an ABSENT entry that
 * `readThroughEdgeCache` answers as null. Best effort, like every write here: where Cache API is
 * absent it does nothing, and a failed put is a warning. `defer` (a `ctx.waitUntil`) takes the put
 * off the request's critical path.
 */
export async function putEdgeCache(
	url: string,
	bytes: Uint8Array | null,
	ttlSeconds: number,
	defer?: (p: Promise<unknown>) => void,
): Promise<void> {
	const cache = edgeCache();
	if (!cache) return;
	const headers: Record<string, string> = {
		"Content-Type": "application/octet-stream",
		"Cache-Control": `public, max-age=${ttlSeconds}`,
	};
	if (bytes === null) headers[EDGE_CACHE_ABSENT_HEADER] = "1";
	const store = cache.put(url, new Response(bytes ?? new Uint8Array(0), { headers })).catch((err) => {
		console.warn(`edge cache write of ${url} failed (the next cold isolate reads KV): ${err}`);
	});
	if (defer) defer(store);
	else await store;
}
