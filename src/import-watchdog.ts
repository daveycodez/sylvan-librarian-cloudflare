/**
 * The nightly import's watchdog: the one thing that notices when the coordinator stops, from OUTSIDE it.
 *
 * ── WHY IT HAS TO BE OUTSIDE ─────────────────────────────────────────────────
 *
 * On 2026-09-23 DeckGen's ImportCoordinator finished an ordinary bucket slice at 11:33:18
 * (`alarm success`, 1.4s wall), armed its next alarm for five seconds later, and then did nothing
 * for over five hours: zero invocations, zero CPU, zero storage rows — and 60 seconds of billed
 * active time in every one of those minutes (GraphQL durableObjectsPeriodicGroups). 2026-09-21 did
 * the same for 4.5 hours mid-bucket and then resumed by itself; the free account has had alarms
 * arrive four hours late and one never. The object is wedged on the platform's side, with its
 * last write apparently never confirmed, and nothing running inside it can notice: no code runs.
 * A deploy did not free one (2026-09-17). So the rescue cannot live in the coordinator.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 *
 * Every WATCHDOG_CRON tick it asks the CURRENT coordinator for its status, with a deadline:
 *
 *   - no run in flight, or the run made progress in the last STALL_MS     → nothing
 *   - a stalled run whose object still answers                              → kick: re-arm the
 *     alarm, so the chain resumes from its persisted phase (a lost alarm costs nothing but the gap)
 *   - a kick that did not bring the run back within KICK_GRACE_MS, or an
 *     object that does not answer at all within STATUS_TIMEOUT_MS            → FAILOVER
 *
 * Failover designates a brand-new coordinator object — its own fresh SQLite, none of the wedged
 * one's staging — in the KV pointer, and starts a fresh run on it. That run redoes the import from
 * the dumps (~45 minutes), which is the price of not being able to read the wedged object's state.
 *
 * ── THE FENCE ────────────────────────────────────────────────────────────────
 *
 * The wedged object is not dead: 2026-09-21's came back after 4.5 hours and carried on. Two runs
 * publishing into one KV is the failure class that already took the site down twice (two writers
 * on one archive key; a retention sweep deleting an in-flight build). So every coordinator carries
 * the EPOCH it was designated at, and the pointer carries the current one. At the top of every
 * alarm a coordinator reads the pointer; a NEWER epoch than its own means it was replaced, and it
 * retires: its staging is purged in bounded slices and it publishes nothing, ever. An epoch rather
 * than a name, because KV is eventually consistent — the new coordinator's own first read may
 * still see the old pointer, and an older epoch must never make it retire itself.
 */

import type { ImportCoordinator } from "./import-coordinator";

/** The KV key naming the coordinator every trigger addresses. Absent means the original one. */
export const COORDINATOR_POINTER_KEY = "import:coordinator";

/** The coordinator every deployment used before failover existed. Epoch 0: anything designated later outranks it. */
export const LEGACY_COORDINATOR_NAME = "singleton";

/** The nightly run's cron (wrangler.jsonc). Any cron that is not the watchdog's starts the nightly. */
export const NIGHTLY_CRON = "17 11 * * *";
/** The watchdog's cron (wrangler.jsonc). */
export const WATCHDOG_CRON = "*/10 * * * *";

/**
 * A run silent this long has stopped. A healthy chain's gap between alarms is its pace delay —
 * 5-16 seconds at 2 MB/s, at most a few minutes at the 256 KB/s floor — and the coordinator's own
 * in-alarm watchdog ends any slice at 5-10 minutes, banking its meters on the way out.
 */
export const STALL_MS = 12 * 60_000;
/** After a kick, how long the run gets to show activity again before the object is written off. */
export const KICK_GRACE_MS = 10 * 60_000;
/**
 * How long a status request may take. A healthy object answers in milliseconds; the longest thing
 * a status request can queue behind is one slice's synchronous CPU (~12s for finalize), and a
 * wedged object never answers at all.
 */
export const STATUS_TIMEOUT_MS = 45_000;
/**
 * Failovers per rolling 24 hours before the watchdog stops and says so. Each one restarts a
 * ~45-minute import and leaves the wedged object's staging behind until it wakes and retires, so a
 * cause that wedges EVERY object (a platform incident, a bug that hangs the chain) must not turn
 * into a restart every 20 minutes all day.
 */
export const MAX_FAILOVERS_PER_DAY = 3;
/** How long after a failover an idle designated coordinator counts as a lost start, not a finished day. */
export const LOST_START_WINDOW_MS = 6 * 3_600_000;

export interface CoordinatorPointer {
	name: string;
	/** Designation time (ms). A coordinator whose own epoch is older than this retires. */
	epoch: number;
	/** Epochs of the failovers in the last 24 hours — the MAX_FAILOVERS_PER_DAY ledger. */
	failovers: number[];
	/** The coordinator this one replaced, for the log reader. */
	previous?: string;
}

export const LEGACY_POINTER: CoordinatorPointer = { name: LEGACY_COORDINATOR_NAME, epoch: 0, failovers: [] };

/** What `/status` answers (ImportCoordinator.status). */
export interface CoordinatorStatus {
	state: "idle" | "starting" | "running" | "done" | "failed" | "superseded";
	phase: string;
	/** The latest sign of life: the last banked slice, the next alarm's due time, or the run's start. */
	lastActivityMs: number;
	/** When the watchdog last kicked THIS run, or null. */
	kickedAtMs: number | null;
	alarmAtMs: number | null;
	epoch: number;
}

export type WatchdogAction =
	| { kind: "none"; why: string }
	| { kind: "kick"; why: string }
	| { kind: "failover"; why: string };

/** The two KV calls the watchdog and the fence make — narrower than KVNamespace, so fakes fit. */
interface WatchdogKV {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
}

/** The pointer, or the legacy coordinator when none was ever written (or it is unreadable garbage). */
export async function readPointer(kv: WatchdogKV): Promise<CoordinatorPointer> {
	const raw = (await kv.get(COORDINATOR_POINTER_KEY, "json")) as Partial<CoordinatorPointer> | null | undefined;
	if (!raw || typeof raw.name !== "string" || !raw.name || typeof raw.epoch !== "number") return LEGACY_POINTER;
	return {
		name: raw.name,
		epoch: raw.epoch,
		failovers: Array.isArray(raw.failovers) ? raw.failovers.filter((t) => typeof t === "number") : [],
		...(typeof raw.previous === "string" ? { previous: raw.previous } : {}),
	};
}

/**
 * The decision, given what the coordinator said (or that it said nothing). Pure, so every branch
 * is pinned by a test rather than by a night in production.
 */
export function decideWatchdog(status: CoordinatorStatus | "unresponsive" | "error", now: number): WatchdogAction {
	if (status === "unresponsive") {
		return { kind: "failover", why: `the coordinator did not answer a status request within ${STATUS_TIMEOUT_MS}ms` };
	}
	if (status === "error") {
		// A thrown request is a reset or a network blip, not a wedge (a wedged object never answers
		// at all). The next tick asks again; a real stall still gets caught by the rules below then.
		return { kind: "none", why: "the status request failed; asking again next tick" };
	}
	if (status.state !== "running" && status.state !== "starting") {
		return { kind: "none", why: `no run in flight (${status.state})` };
	}
	const silentMs = now - status.lastActivityMs;
	if (silentMs < STALL_MS) {
		return { kind: "none", why: `healthy: phase ${status.phase}, last activity ${Math.round(silentMs / 1000)}s ago` };
	}
	const silent = `phase ${status.phase} silent for ${Math.round(silentMs / 60_000)}min`;
	if (status.kickedAtMs === null || status.kickedAtMs < status.lastActivityMs) {
		return { kind: "kick", why: `${silent}; re-arming its alarm` };
	}
	const sinceKick = now - status.kickedAtMs;
	if (sinceKick >= KICK_GRACE_MS) {
		return {
			kind: "failover",
			why: `${silent}, and no activity in the ${Math.round(sinceKick / 60_000)}min since it was kicked`,
		};
	}
	return { kind: "none", why: `${silent}; kicked ${Math.round(sinceKick / 60_000)}min ago, waiting for it` };
}

/** The pointer after a failover designated `name` at `now`, with the 24-hour ledger pruned. */
export function nextPointer(current: CoordinatorPointer, now: number): CoordinatorPointer {
	// Strictly newer than the current epoch even if two ticks land in one millisecond or a clock
	// runs behind: the fence compares epochs, and a tie would retire nothing.
	const epoch = Math.max(now, current.epoch + 1);
	return {
		name: `import-${new Date(epoch).toISOString()}`,
		epoch,
		failovers: [...current.failovers.filter((t) => t > now - 24 * 3_600_000), epoch],
		previous: current.name,
	};
}

export interface WatchdogEnv {
	/** KV, read for the pointer on every tick and written only by a failover. */
	STORE_KV: WatchdogKV;
	IMPORT_COORDINATOR: DurableObjectNamespace<ImportCoordinator>;
}

function coordinatorFor(env: WatchdogEnv, name: string): { fetch(input: string): Promise<Response> } {
	return env.IMPORT_COORDINATOR.get(env.IMPORT_COORDINATOR.idFromName(name)) as unknown as {
		fetch(input: string): Promise<Response>;
	};
}

function startUrl(reason: string, pointer: CoordinatorPointer): string {
	const params = new URLSearchParams({ reason, name: pointer.name, epoch: String(pointer.epoch) });
	return `https://coordinator/start-import?${params}`;
}

/** `promise`, or "timeout" after `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	promise.catch(() => {});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** The nightly trigger: start a run on whichever coordinator the pointer names. */
export async function startNightlyImport(env: WatchdogEnv): Promise<Response> {
	const pointer = await readPointer(env.STORE_KV);
	return coordinatorFor(env, pointer.name).fetch(startUrl("cron", pointer));
}

/**
 * One watchdog tick. Returns what it decided, for the log line and the tests.
 *
 * `timeoutMs` is a parameter only so tests need not wait out the real deadline.
 */
export async function runImportWatchdog(
	env: WatchdogEnv,
	now: number = Date.now(),
	timeoutMs: number = STATUS_TIMEOUT_MS,
): Promise<WatchdogAction> {
	const pointer = await readPointer(env.STORE_KV);
	const coordinator = coordinatorFor(env, pointer.name);

	let status: CoordinatorStatus | "unresponsive" | "error";
	try {
		const answer = await within(coordinator.fetch("https://coordinator/status"), timeoutMs);
		if (answer === "timeout") status = "unresponsive";
		else if (!answer.ok) status = "error";
		else status = (await answer.json()) as CoordinatorStatus;
	} catch (err) {
		console.warn(`Import watchdog: status request to ${pointer.name} failed: ${err}`);
		status = "error";
	}

	let action = decideWatchdog(status, now);
	if (action.kind === "failover") {
		const recent = pointer.failovers.filter((t) => t > now - 24 * 3_600_000);
		if (recent.length >= MAX_FAILOVERS_PER_DAY) {
			console.error(
				`Import watchdog: ${pointer.name} needs replacing (${action.why}), but ${recent.length} failovers in the ` +
					`last 24h is the cap (MAX_FAILOVERS_PER_DAY) — something is wedging every coordinator; not restarting again`,
			);
			return { kind: "none", why: `failover cap reached: ${action.why}` };
		}
	}

	if (action.kind === "kick") {
		try {
			const answer = await within(coordinator.fetch(`https://coordinator/kick?at=${now}`), timeoutMs);
			if (answer === "timeout") {
				// It answered status but not a kick: the kick's write is what never confirms, which is
				// the wedge itself. Replace it now rather than a tick from now.
				action = { kind: "failover", why: `${action.why}; the kick itself did not answer within ${timeoutMs}ms` };
			} else {
				console.warn(`Import watchdog: kicked ${pointer.name} — ${action.why}`);
			}
		} catch (err) {
			console.warn(`Import watchdog: kick of ${pointer.name} failed (${err}); asking again next tick`);
			return { kind: "none", why: `kick failed: ${err}` };
		}
	}

	if (action.kind === "failover") {
		const next = nextPointer(pointer, now);
		// The pointer FIRST: it is the fence. If the start request below is lost, the next tick finds
		// the new coordinator idle and starts it (LOST_START_WINDOW_MS); the other order could leave
		// two unfenced runs.
		await env.STORE_KV.put(COORDINATOR_POINTER_KEY, JSON.stringify(next));
		console.error(
			`Import watchdog: FAILOVER — ${pointer.name} (epoch ${pointer.epoch}) replaced by ${next.name} ` +
				`(epoch ${next.epoch}): ${action.why}. The old object retires if it ever wakes; a fresh run starts now ` +
				`(failover ${next.failovers.length}/${MAX_FAILOVERS_PER_DAY} today)`,
		);
		const started = await within(coordinatorFor(env, next.name).fetch(startUrl("watchdog-failover", next)), timeoutMs);
		if (started === "timeout")
			console.error(`Import watchdog: the new coordinator ${next.name} did not answer its start`);
		return action;
	}

	// A coordinator designated by a failover whose start request was lost sits idle with no run
	// ever recorded. Start it, rather than leave the day without an import until the next nightly.
	if (
		typeof status === "object" &&
		status.state === "idle" &&
		pointer.epoch > 0 &&
		now - pointer.epoch < LOST_START_WINDOW_MS
	) {
		console.warn(`Import watchdog: ${pointer.name} was designated but never started; starting it`);
		await within(coordinatorFor(env, pointer.name).fetch(startUrl("watchdog-restart", pointer)), timeoutMs);
		return { kind: "none", why: "started a designated coordinator whose start was lost" };
	}

	if (action.kind === "none" && typeof status === "object" && status.state === "running") {
		console.log(`Import watchdog: ${pointer.name} ${action.why}`);
	}
	return action;
}
