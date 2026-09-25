// The one-time release of the colo-era SearchEngine objects (backlog c1, part b).
//
// Before engines were named by region (acd533d6, 2026-08-12) they were named by the colo a request
// landed in: `env.SEARCH_ENGINE.idFromName("engine-" + colo)`, shard n as `engine-<COLO>-<n>`, with
// NO location hint (6f34fd43, 84439e31, 2026-08-07). Those objects were last active 08-07…08-12 and
// each still holds the SQLite copy of the store it cached then — an estimated 1.2–1.4 GB of DeckGen's
// 5 GB pool. Nothing announces them (announcements came later), so the notify phase's retirement of
// announced leftovers (notifyRetireReason) never reaches them, and no request can either: colo codes
// are upper-case, and `engineName` produces lower-case regions only.
//
// So they are addressed here BY NAME, the way they were created: `idFromName` on the same
// SEARCH_ENGINE namespace, no hint (addressAnnouncedEngine). `idFromName` is a pure function of the
// namespace and the name, and the namespace has never been renamed or given a jurisdiction
// (wrangler.jsonc migration v2 is the only one naming SearchEngine), so each name reaches the very
// object the colo era created. A name an account never had gets a transient empty instance, which
// storageFootprint neither writes to nor keeps (see SearchEngine.storageFootprint).
//
// Off unless the RETIRED_ENGINE_SWEEP var says otherwise, and at most once per value. It runs on the
// every-10-minutes watchdog cron (runRetiredEngineSweep, called from index.ts's scheduled handler),
// not the nightly, so a push that sets the var reports within ten minutes; a finished value is
// recorded in KV (RETIRED_SWEEP_KV_KEY), so later ticks with the var still set wake nothing.
//
//   unset / ""   off: no object is addressed, nothing is read or logged
//   "dry-run"    ask each name for its storage footprint (read-only) and log every size
//   "release"    deleteAll on every name holding more than RETIRED_HOLDING_BYTES, and log the bytes
//                freed; names below it are left alone (an empty SQLite file is a page or two)
//   anything else  off, with a warning naming the value
//
// Only deleteAll gives billed storage back — deleting rows does not (x8 metered 1.1 GB after every
// row was purged, 14.6 MB after deleteAll) — which is why release is releaseCache and nothing finer.

import { addressAnnouncedEngine } from "./engine-namespace";
import type { Env } from "./types";

/** Every colo-era engine name that held storage when the DO list was inventoried on 2026-09-24. */
export const RETIRED_COLO_ENGINE_NAMES = [
	"engine-LAX",
	"engine-LAX-1",
	"engine-LAX-2",
	"engine-LAX-3",
	"engine-LAX-4",
	"engine-LAX-5",
	"engine-LAX-6",
	"engine-LAX-7",
	"engine-BOS",
	"engine-EWR",
	"engine-PDX",
] as const;

/** Above this an object holds a cached archive (tens of MB); below it, at most SQLite's own pages. */
export const RETIRED_HOLDING_BYTES = 1_000_000;

/** Where a finished sweep is recorded: one KV key per account, written at most once per mode. */
export const RETIRED_SWEEP_KV_KEY = "ops:retired-engine-sweep";

export type RetiredSweepMode = "dry-run" | "release";

/** What a finished sweep leaves behind at RETIRED_SWEEP_KV_KEY. */
export interface RetiredSweepRecord {
	mode: RetiredSweepMode;
	at: string;
	/** Bytes each name reported before anything was released. */
	bytes: Record<string, number>;
	/** Release only: the names deleteAll ran on, and what they reported before it. */
	released?: string[];
	freedBytes?: number;
}

export interface RetiredSweepDeps {
	/** The raw RETIRED_ENGINE_SWEEP value. */
	setting: string | undefined;
	/** The last finished sweep. Read only when the var is set, so an unset var costs no row. */
	lastDone(): Promise<RetiredSweepRecord | undefined>;
	/** The object's databaseSize, read-only (SearchEngine.storageFootprint). */
	footprint(name: string): Promise<number>;
	/** deleteAll on the object (SearchEngine.releaseCache). */
	release(name: string): Promise<void>;
	now?: () => Date;
	log?: (line: string) => void;
	warn?: (line: string) => void;
	names?: readonly string[];
}

/** The var, read strictly: only the two documented values turn anything on. */
export function retiredSweepMode(setting: string | undefined): RetiredSweepMode | "off" | "invalid" {
	const value = (setting ?? "").trim();
	if (value === "") return "off";
	return value === "dry-run" || value === "release" ? value : "invalid";
}

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)}MB`;

/**
 * Run the sweep the var asks for, unless that exact value already finished. Returns the record to
 * persist when this call completed a sweep, or null when there is nothing to record — the var is off
 * or invalid, the value already finished, or something failed and the next tick should retry.
 * Never throws for a single object's failure; the caller still wraps it, because the watchdog cron
 * must not fail on a cleanup.
 */
export async function sweepRetiredEngines(deps: RetiredSweepDeps): Promise<RetiredSweepRecord | null> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const warn = deps.warn ?? ((line: string) => console.warn(line));
	const names = deps.names ?? RETIRED_COLO_ENGINE_NAMES;
	const mode = retiredSweepMode(deps.setting);
	if (mode === "off") return null;
	if (mode === "invalid") {
		warn(`Retired-engine sweep: RETIRED_ENGINE_SWEEP="${deps.setting}" is neither "dry-run" nor "release"; off`);
		return null;
	}
	const last = await deps.lastDone();
	if (last?.mode === mode) {
		log(
			`Retired-engine sweep (${mode}): already finished ${last.at}; no object addressed. ` +
				"Change the value to run the other mode, or remove RETIRED_ENGINE_SWEEP.",
		);
		return null;
	}

	const measured = await Promise.allSettled(names.map((name) => deps.footprint(name)));
	const bytes: Record<string, number> = {};
	const failures: string[] = [];
	measured.forEach((r, i) => {
		const name = names[i] as string;
		if (r.status === "fulfilled") bytes[name] = r.value;
		else failures.push(`${name}: ${r.reason}`);
	});
	const holding = Object.keys(bytes).filter((name) => (bytes[name] ?? 0) > RETIRED_HOLDING_BYTES);
	const held = holding.reduce((t, name) => t + (bytes[name] ?? 0), 0);
	log(
		`Retired-engine sweep (${mode}): ${holding.length}/${names.length} colo-era object(s) hold ${mb(held)} ` +
			`above ${mb(RETIRED_HOLDING_BYTES)}` +
			(holding.length === 0 ? " — nothing left to release" : "") +
			`; per name: ${Object.entries(bytes)
				.map(([name, n]) => `${name}=${n}`)
				.join(", ")}`,
	);

	const record: RetiredSweepRecord = { mode, at: (deps.now ?? (() => new Date()))().toISOString(), bytes };
	if (mode === "release" && holding.length > 0) {
		const released = await Promise.allSettled(holding.map((name) => deps.release(name)));
		const done = holding.filter((_, i) => released[i]?.status === "fulfilled");
		released.forEach((r, i) => {
			if (r.status === "rejected") failures.push(`${holding[i]}: release: ${r.reason}`);
		});
		// Read back, so the log shows the space actually left rather than assuming deleteAll worked.
		const after = await Promise.allSettled(done.map((name) => deps.footprint(name)));
		const left = after.reduce((t, r) => t + (r.status === "fulfilled" ? r.value : 0), 0);
		const freed = done.reduce((t, name) => t + (bytes[name] ?? 0), 0) - left;
		log(
			`Retired-engine sweep (release): deleteAll on ${done.length}/${holding.length} object(s) freed ${mb(freed)}` +
				` (${done.map((name) => `${name}=${mb(bytes[name] ?? 0)}`).join(", ")}); ${left} bytes left across them`,
		);
		record.released = done;
		record.freedBytes = freed;
	}

	if (failures.length > 0) {
		warn(
			`Retired-engine sweep (${mode}): ${failures.length} call(s) failed, so it is not recorded as finished ` +
				`and the next watchdog tick runs it again: ${failures.join("; ")}`,
		);
		return null;
	}
	return record;
}

/**
 * The sweep as the watchdog cron runs it: the var off (the normal state) costs nothing — no KV read,
 * no object addressed. Addressed with addressAnnouncedEngine although nothing announces these names:
 * it is exactly the colo era's own call (`SEARCH_ENGINE.get(SEARCH_ENGINE.idFromName(name))`, no
 * hint), so each name reaches the object that era created, and a name this account never had cannot
 * be placed. Never throws: the store is live either way, and this is housekeeping.
 */
export async function runRetiredEngineSweep(
	env: Pick<Env, "STORE_KV" | "SEARCH_ENGINE"> & { RETIRED_ENGINE_SWEEP?: string },
): Promise<void> {
	if (retiredSweepMode(env.RETIRED_ENGINE_SWEEP) === "off") return;
	const stub = (name: string) =>
		addressAnnouncedEngine(env as Env, name) as unknown as {
			storageFootprint(): Promise<{ label: string; bytes: number }>;
			releaseCache(): Promise<unknown>;
		};
	try {
		const done = await sweepRetiredEngines({
			setting: env.RETIRED_ENGINE_SWEEP,
			lastDone: async () => (await env.STORE_KV.get<RetiredSweepRecord>(RETIRED_SWEEP_KV_KEY, "json")) ?? undefined,
			footprint: async (name) => (await stub(name).storageFootprint()).bytes,
			release: async (name) => {
				await stub(name).releaseCache();
			},
		});
		if (done) await env.STORE_KV.put(RETIRED_SWEEP_KV_KEY, JSON.stringify(done));
	} catch (err) {
		console.warn(`Retired-engine sweep failed; the next watchdog tick runs it again: ${err}`);
	}
}
