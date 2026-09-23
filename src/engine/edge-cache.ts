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
 * The bytes at `url` from this colo's cache, else from `load` — which are then stored for
 * `ttlSeconds`. `defer` (a `ctx.waitUntil`) takes the store off the request's critical path.
 */
export async function readThroughEdgeCache(
	url: string,
	ttlSeconds: number,
	load: () => Promise<Uint8Array | null>,
	defer?: (p: Promise<unknown>) => void,
): Promise<Uint8Array | null> {
	const cache = edgeCache();
	if (cache) {
		try {
			const hit = await cache.match(url);
			if (hit) return new Uint8Array(await hit.arrayBuffer());
		} catch (err) {
			console.warn(`edge cache read of ${url} failed (reading through): ${err}`);
		}
	}
	const bytes = await load();
	if (cache && bytes !== null) {
		const store = cache
			.put(
				url,
				new Response(bytes, {
					headers: { "Content-Type": "application/octet-stream", "Cache-Control": `public, max-age=${ttlSeconds}` },
				}),
			)
			.catch((err) => {
				console.warn(`edge cache write of ${url} failed (the next cold isolate reads KV): ${err}`);
			});
		if (defer) defer(store);
		else await store;
	}
	return bytes;
}
