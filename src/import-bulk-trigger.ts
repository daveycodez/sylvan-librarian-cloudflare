/**
 * Start the import when Scryfall's bulk dumps change, instead of waiting for a fixed hour.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Scryfall regenerates every dump once a day, one after another over ~25 minutes: on 2026-11-13
 * rulings at 22:00:32, oracle_cards 22:01:58, default_cards 22:06:41, all_cards 22:22:58 UTC. The
 * nightly cron ran at 11:17 — written on the scaffold day as "after Scryfall's daily bulk-data
 * refresh window", and thirteen hours after it in fact — so every new card waited a full extra
 * half-day. Nauctis (`nau`, 24 cards) reached Scryfall at 14:22 that day, its bulk at 22:06, and
 * this mirror not before 11:17 the next morning.
 *
 * The same timing bit the deploy. A push at 22:12 UTC that day rebuilt the store (store-age saw
 * default_cards newer than the store) and published at 22:15:58 — with the PREVIOUS day's
 * all_cards, which Scryfall replaced seven minutes later. The rebuild ran, and still had no Nauctis.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * A store is STALE when any dump it reads is newer than the store's `built_at`, and the dumps are
 * SETTLED when Scryfall's refresh is over: every dump has turned over together (newest and oldest
 * stamps within TURNOVER_SPREAD_MS of each other), or the newest is SETTLE_MS old — which covers a
 * dump Scryfall did not regenerate that day. Build when stale AND settled; never mid-refresh.
 *
 * The watchdog's 10-minute tick asks; the 11:17 cron stays as the backstop, gated the same way so
 * it no longer re-imports a store the tick already built from the same dumps. A failed run is not
 * retried by the tick (the coordinator remembers which dumps it last attempted); the backstop
 * retries it once a day, as the nightly always did.
 */

import { ARCHIVE_FORMAT_VERSION, formatManifestKey, MANIFEST_KEY } from "./engine/store-kv";
import { DUMP_KINDS } from "./import-phases";

/** Scryfall's dump listing. Overridable for tests and self-hosted mirrors (SCRYFALL_BULK_URL var). */
export const BULK_DATA_URL = "https://api.scryfall.com/bulk-data";

/** The start reason the tick sends; the coordinator treats it as "only if not already tried". */
export const BULK_REFRESH_REASON = "bulk-refresh";

/** Scryfall's refresh runs ~25 minutes end to end; a set of stamps this close together is one whole refresh. */
export const TURNOVER_SPREAD_MS = 60 * 60_000;
/** A refresh whose newest dump is this old is over, even if some dump did not take part in it. */
export const SETTLE_MS = 45 * 60_000;
/** How long the tick waits on Scryfall's listing before trying again next tick. */
export const LISTING_TIMEOUT_MS = 10_000;

/** `sylvan-librarian-worker/<YYYYMMDD>` — Scryfall rejects default UAs. */
export function scryfallUserAgent(d: Date = new Date()): string {
	const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
	return `sylvan-librarian-worker/${stamp}`;
}

export interface BulkStamps {
	/** The most recently regenerated dump this importer reads (ms). */
	newestMs: number;
	/** The least recently regenerated one (ms). */
	oldestMs: number;
}

/**
 * The newest and oldest `updated_at` over `kinds`, or null unless EVERY kind is listed with a
 * parseable stamp — a dump missing from the listing is a schema change, and judging on the rest
 * would call a refresh settled that has not reached the dump the cards come from.
 */
export function bulkStamps(listing: unknown, kinds: readonly string[] = DUMP_KINDS): BulkStamps | null {
	const records = (listing as { data?: { type?: unknown; updated_at?: unknown }[] } | null)?.data;
	if (!Array.isArray(records)) return null;
	const stamps: number[] = [];
	for (const kind of kinds) {
		const record = records.find((r) => r?.type === kind);
		const ms = Date.parse(typeof record?.updated_at === "string" ? record.updated_at : "");
		if (!Number.isFinite(ms)) return null;
		stamps.push(ms);
	}
	if (stamps.length === 0) return null;
	return { newestMs: Math.max(...stamps), oldestMs: Math.min(...stamps) };
}

/** Whether Scryfall's refresh is over — see the header. */
export function bulkSettled(stamps: BulkStamps, now: number): boolean {
	return stamps.newestMs - stamps.oldestMs < TURNOVER_SPREAD_MS || now - stamps.newestMs >= SETTLE_MS;
}

export type StoreVerdict =
	| { kind: "current"; why: string }
	| { kind: "settling"; why: string }
	| { kind: "stale"; why: string };

/** The decision, given the dumps' stamps and the live store's `built_at` (ms, or null for no store). Pure. */
export function judgeStore(stamps: BulkStamps, builtAtMs: number | null, now: number): StoreVerdict {
	const newest = new Date(stamps.newestMs).toISOString();
	if (builtAtMs !== null && builtAtMs >= stamps.newestMs) {
		return {
			kind: "current",
			why: `the store (built ${new Date(builtAtMs).toISOString()}) has Scryfall's ${newest} dumps`,
		};
	}
	const store =
		builtAtMs === null ? "no store is published" : `the store was built ${new Date(builtAtMs).toISOString()}`;
	if (!bulkSettled(stamps, now)) {
		return {
			kind: "settling",
			why: `${store}, but Scryfall is mid-refresh (dumps from ${new Date(stamps.oldestMs).toISOString()} to ${newest}); waiting for it to finish`,
		};
	}
	return { kind: "stale", why: `${store}, before Scryfall's ${newest} dumps` };
}

/** The KV read this needs — narrower than KVNamespace, so the watchdog's fakes fit. */
interface ManifestKV {
	get(key: string, type: "json"): Promise<unknown>;
}

/**
 * The live store's `built_at` in ms: null when no manifest for this build's format is published,
 * "error" when KV could not be read. The legacy key counts only for this format, as readManifest
 * has it.
 */
export async function liveStoreBuiltAt(kv: ManifestKV): Promise<number | null | "error"> {
	try {
		type Manifest = { built_at?: unknown; format_version?: unknown } | null;
		let manifest = (await kv.get(formatManifestKey(ARCHIVE_FORMAT_VERSION), "json")) as Manifest;
		if (!manifest) {
			const legacy = (await kv.get(MANIFEST_KEY, "json")) as Manifest;
			manifest = legacy && legacy.format_version === ARCHIVE_FORMAT_VERSION ? legacy : null;
		}
		if (!manifest) return null;
		const seconds = Number(manifest.built_at);
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
	} catch (err) {
		console.warn(`Bulk trigger: could not read the store manifest (${err})`);
		return "error";
	}
}

export type GateOutcome = { kind: "start"; bulkMs: number | null; why: string } | { kind: "skip"; why: string };

/**
 * Whether a trigger should start an import now. `backstop` is the 11:17 cron: when it cannot ask
 * Scryfall or read the manifest it starts anyway, as the nightly always did; the tick never does.
 */
export async function bulkGate(
	kv: ManifestKV,
	now: number,
	backstop: boolean,
	fetchListing: () => Promise<unknown>,
): Promise<GateOutcome> {
	let stamps: BulkStamps | null = null;
	try {
		stamps = bulkStamps(await fetchListing());
	} catch (err) {
		console.warn(`Bulk trigger: could not read Scryfall's /bulk-data (${err})`);
	}
	if (stamps === null) {
		return backstop
			? { kind: "start", bulkMs: null, why: "Scryfall's /bulk-data listing was unusable; starting anyway (backstop)" }
			: { kind: "skip", why: "Scryfall's /bulk-data listing was unusable; asking again next tick" };
	}
	const builtAt = await liveStoreBuiltAt(kv);
	if (builtAt === "error") {
		return backstop
			? { kind: "start", bulkMs: stamps.newestMs, why: "the manifest could not be read; starting anyway (backstop)" }
			: { kind: "skip", why: "the manifest could not be read; asking again next tick" };
	}
	const verdict = judgeStore(stamps, builtAt, now);
	return verdict.kind === "stale"
		? { kind: "start", bulkMs: stamps.newestMs, why: verdict.why }
		: { kind: "skip", why: verdict.why };
}

/** Scryfall's listing, with a deadline. */
export async function fetchBulkListing(url: string = BULK_DATA_URL): Promise<unknown> {
	const res = await fetch(url, {
		headers: { "User-Agent": scryfallUserAgent(), Accept: "application/json" },
		signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return res.json();
}
