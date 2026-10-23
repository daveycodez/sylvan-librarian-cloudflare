// x100: what one engine object remembers about its own health, for the nightly's placement judge
// (engine-moves.ts). Two counters per UTC day, in ONE row of the object's own SQLite:
//
//   loads    how many times a store was loaded into this object — every wake that had to load,
//            from the local cache or from KV. Under steady traffic a healthy object is woken by
//            its siblings' gathers every second or two and stays resident; DeckGen's
//            engine-wnam-p8-e1 reloaded every 15–40s while its siblings did not (2026-10-23).
//   around   per sibling PARTITION: how often this object, coordinating a gather, had to route
//            around that sibling — a hedge (sibling-hedge.ts) that WON, its answer used instead of
//            the late original. The nightly sums these over the replica, so a partition's total is
//            how often its siblings had to go around it: 127 of wnam's 186 rescues in the 24 hours
//            to 2026-10-23 09:00 UTC were enam answering for engine-wnam-p8-e1.
//
// Plus the colo, which is already remembered: the `placement` row placement.ts writes at most once
// per PLACEMENT_FRESH_MS. healthReport reads both, and writes nothing.
//
// WHY A ROW AND NOT MEMORY. An idle object is evicted after ~10s and wakes in a fresh isolate, so a
// counter in memory dies exactly when the object is sickest — a reload storm is a run of fresh
// isolates. WHY NOT KV. One put per event would be the free plan's 1,000 writes a day in an hour.
//
// COST. One row written per counted event (an upsert: ON CONFLICT DO UPDATE is one row on the
// meter, where INSERT OR REPLACE is two). DeckGen loaded 18,775 stores in the 24 hours to
// 2026-10-23 18:00 UTC and hedged 765 sibling calls; the free account 99 and 1. To keep a storm from
// spending the free plan's 100,000 rows written a day, an object writes every event only for its
// first HEALTH_FULL_WRITES of a UTC day and then one in HEALTH_SAMPLE, weighted HEALTH_SAMPLE — an
// unbiased count, at most HEALTH_FULL_WRITES + events/HEALTH_SAMPLE rows a day per object. A load
// needs a request, and the free plan serves 100,000 a day, so the free account's worst case is
// 200 × objects + 6,250 rows: ~11,000 for its 24 objects.

import { type ArchiveCacheStorage, lastPlacement } from "./store-cache";

/** Events per object per UTC day written one by one, before sampling starts. */
export const HEALTH_FULL_WRITES = 200;

/** Past HEALTH_FULL_WRITES, one event in this many is written, counting this many. */
export const HEALTH_SAMPLE = 16;

/** One UTC day's counters. */
export interface HealthDay {
	loads: number;
	/** Partition -> hedges this object won around that sibling. */
	around: Record<string, number>;
	/** Rows this day has written: the sampling budget. */
	w: number;
}

/** The whole row: at most two days, today and yesterday. */
export interface HealthRecord {
	days: Record<string, HealthDay>;
}

/** What the nightly asks of every announced object (SearchEngine.placementReport). */
export interface EngineReport {
	/** The object's own name, epoch and all. */
	name: string;
	/** Its self-reported colo (placement.ts), or null if it never measured one. */
	colo: string | null;
	/** When that colo was measured (epoch ms), or null. */
	coloAt: number | null;
	/** The UTC day the counters are for: yesterday's, the last complete one. */
	day: string;
	loads: number;
	around: Record<string, number>;
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS engine_health (id INTEGER PRIMARY KEY, json TEXT NOT NULL)";

function exec(storage: ArchiveCacheStorage, query: string, ...bindings: string[]) {
	return (storage.sql.exec as (q: string, ...b: unknown[]) => { toArray(): Record<string, SqlStorageValue>[] })(
		query,
		...bindings,
	).toArray();
}

/** `YYYY-MM-DD` of an epoch-ms time, in UTC. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** The row, or an empty record when there is none or it does not parse. Never throws. */
export function readHealth(storage: ArchiveCacheStorage): HealthRecord {
	try {
		exec(storage, SCHEMA);
		const row = exec(storage, "SELECT json FROM engine_health WHERE id = 0")[0];
		const parsed = row ? (JSON.parse(String(row.json)) as HealthRecord) : null;
		return parsed && typeof parsed.days === "object" && parsed.days !== null ? parsed : { days: {} };
	} catch {
		return { days: {} };
	}
}

/** What happened: a store load, or a hedge this object won around sibling partition `around`. */
export type HealthEvent = { load: true } | { around: number };

/**
 * Count one event in today's counters — or, past today's HEALTH_FULL_WRITES, one in HEALTH_SAMPLE
 * of them at weight HEALTH_SAMPLE. Returns whether a row was written. Never throws: health is
 * evidence for a nightly decision, never a reason to fail a load or a gather.
 */
export function noteHealth(
	storage: ArchiveCacheStorage | undefined,
	event: HealthEvent,
	nowMs: number = Date.now(),
	random: () => number = Math.random,
): boolean {
	if (!storage) return false;
	try {
		const record = readHealth(storage);
		const today = utcDay(nowMs);
		const yesterday = utcDay(nowMs - 86_400_000);
		const day = record.days[today] ?? { loads: 0, around: {}, w: 0 };
		let weight = 1;
		if (day.w >= HEALTH_FULL_WRITES) {
			if (random() >= 1 / HEALTH_SAMPLE) return false;
			weight = HEALTH_SAMPLE;
		}
		if ("load" in event) day.loads += weight;
		else {
			const key = String(event.around);
			day.around[key] = (day.around[key] ?? 0) + weight;
		}
		day.w += 1;
		// Only today and yesterday survive: the nightly reads yesterday, the last complete day.
		const days: Record<string, HealthDay> = { [today]: day };
		const kept = record.days[yesterday];
		if (kept) days[yesterday] = kept;
		exec(
			storage,
			"INSERT INTO engine_health (id, json) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
			JSON.stringify({ days }),
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * This object's report for the nightly: its colo and YESTERDAY's counters (the last complete UTC
 * day — the nightly runs at 11:17 UTC, so today's are half a day). Reads two rows, writes none.
 */
export function healthReport(storage: ArchiveCacheStorage, name: string, nowMs: number = Date.now()): EngineReport {
	const placement = lastPlacement(storage);
	const day = utcDay(nowMs - 86_400_000);
	const counters = readHealth(storage).days[day];
	return {
		name,
		colo: placement?.colo ?? null,
		coloAt: placement?.at ?? null,
		day,
		loads: counters?.loads ?? 0,
		around: { ...(counters?.around ?? {}) },
	};
}
