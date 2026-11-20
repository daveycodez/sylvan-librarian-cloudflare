/**
 * A deploy-path publish asks the Worker to purge its response cache.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * The response cache (wrangler.jsonc `cache`) holds a search answer for sixteen hours, and only the
 * Worker's own entrypoint can purge it (src/index.ts `purgeCache`). The nightly import ends with
 * that purge. A store published by the DEPLOY path never did: nothing outside the Worker can issue
 * one — a zone purge for the hostname leaves these entries where they are, measured 2026-11-20 —
 * so every answer cached from the store it replaced stayed served until it aged out.
 *
 * That was survivable while a deploy's store differed from the last by a night of prices. On
 * 2026-11-20 it replaced a store with no oracle tags (import-dump-guard.ts), and every `otag:`
 * search asked during the outage kept answering its cached 404 after the fix was live.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────────
 *
 * The publisher writes PURGE_REQUEST_KEY (scripts/request-cache-purge.ts, run by import-store.sh
 * after the store upload). The watchdog tick reads it — one KV read a tick — and, once the request
 * is PURGE_SETTLE_MS old, purges and deletes it. The wait is for the engine objects: a deploy does
 * not notify them, and they pick the new store up over the next minutes (three, measured that
 * night); a purge before that would refill the cache from the store being replaced.
 *
 * A purge that fails is tried again next tick; a request older than PURGE_GIVE_UP_MS is dropped
 * with a warning rather than retried forever — by then the cache has largely aged out anyway.
 */

/** The KV key a publisher writes to ask for a purge: `{ "at": <epoch ms>, "why": "…" }`. */
export const PURGE_REQUEST_KEY = "ops:purge-request";
/** How old a request must be before it is honoured — the engine objects' time to reach the new store. */
export const PURGE_SETTLE_MS = 5 * 60_000;
/** After this long a request that still could not be honoured is dropped. */
export const PURGE_GIVE_UP_MS = 6 * 3_600_000;

interface PurgeKV {
	get(key: string, type: "json"): Promise<unknown>;
	delete(key: string): Promise<void>;
}

export type PurgeOutcome = "none" | "waiting" | "purged" | "failed" | "dropped";

/**
 * One tick's look at the purge request. `purge` is the entrypoint's own `purgeCache`, which never
 * throws. Never throws either: a KV failure is "none" for this tick.
 */
export async function runPurgeRequest(
	kv: PurgeKV,
	purge: () => Promise<{ success: boolean; errors?: unknown }>,
	now: number = Date.now(),
): Promise<PurgeOutcome> {
	let request: { at?: unknown; why?: unknown } | null;
	try {
		request = (await kv.get(PURGE_REQUEST_KEY, "json")) as { at?: unknown; why?: unknown } | null;
	} catch (err) {
		console.warn(`Purge request: ${PURGE_REQUEST_KEY} could not be read (${err}); asking again next tick`);
		return "none";
	}
	if (request === null || typeof request !== "object") return "none";
	const at = typeof request.at === "number" && Number.isFinite(request.at) ? request.at : 0;
	const why = typeof request.why === "string" ? request.why : "no reason given";
	if (now - at < PURGE_SETTLE_MS) return "waiting";
	const result = await purge();
	if (!result.success && now - at < PURGE_GIVE_UP_MS) {
		console.warn(`Purge request (${why}): the purge failed, trying again next tick: ${JSON.stringify(result.errors)}`);
		return "failed";
	}
	try {
		await kv.delete(PURGE_REQUEST_KEY);
	} catch (err) {
		console.warn(`Purge request: could not delete ${PURGE_REQUEST_KEY} (${err}); the next tick purges again`);
	}
	if (!result.success) {
		console.warn(`Purge request (${why}): dropped after ${Math.round((now - at) / 3_600_000)}h of failed purges`);
		return "dropped";
	}
	console.log(`Purge request honoured: response cache purged ${Math.round((now - at) / 60_000)}min after "${why}"`);
	return "purged";
}
