// Port of get_pid, get_catalog, and the Postgres-only admin routes
// (api_resource.py:803-813, 1764-1792 and the import/backfill family).

import { cacheHeader, httpError, jsonResponse, NO_STORE_HEADER } from "./http";
import type { RouteContext, RouteEntry } from "./registry";

/**
 * Upstream returns os.getpid() with a no-store header. A Workers isolate has
 * no process id (and workerd exposes nothing equivalent), so this port always
 * reports 0 — the shape (a bare JSON int) is what upstream's clients consume.
 */
export function getPidHandler(): Response {
	return jsonResponse(0, NO_STORE_HEADER);
}

function sortedByKey(entries: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Get type and keyword frequency catalogs from the engine (upstream
 * get_catalog()). An unloaded engine surfaces as EngineUnavailableError from
 * getEngine(), which dispatch answers with upstream's exact 503 ("Engine is
 * not loaded, please try again later.") — never caught here.
 */
export async function getCatalogHandler(ctx: RouteContext): Promise<Response> {
	const engine = await ctx.getEngine();
	const typeCounts: Record<string, number> = { ...(await engine.cardTypeCounts()) };
	// tribal is the old name for kindred
	const kindredCount = typeCounts.Kindred ?? 0;
	if (kindredCount) {
		typeCounts.Tribal = kindredCount;
	}
	const keywordCatalog: Record<string, number> = {};
	for (const [keyword, count] of Object.entries(await engine.cardKeywordCounts())) {
		keywordCatalog[keyword.toLowerCase()] = count;
	}
	// Sorted keys compress smaller and make the payload deterministic; sorting
	// must happen after the Tribal alias is inserted above (upstream parity).
	return jsonResponse(
		{
			types: sortedByKey(typeCounts),
			keywords: sortedByKey(keywordCatalog),
		},
		cacheHeader(3600),
	);
}

/**
 * The Postgres-only routes exist in the route table (so the 404 listing, 405s
 * and path resolution mirror upstream) but answer 501: their work — schema
 * setup, bulk import, tag ingestion, score backfills — was replaced by the
 * Cloudflare import pipeline (Durable Object build → D1 store) in this port.
 */
export function notImplementedHandler(routeName: string): RouteEntry["handler"] {
	return () =>
		httpError(
			501,
			"Not Implemented",
			`${routeName} is a Postgres-backed route upstream; this port has no Postgres, and nothing feeds it.`,
		);
}
