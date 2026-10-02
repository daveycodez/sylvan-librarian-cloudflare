// A gather coordinator's view of its own sibling calls: which ones stalled, whether the object
// should stop coordinating for a while, and the one log line that says so.
//
// WHY (x45, DeckGen). Two coordinators each spent the whole life of one isolate answering gathers
// in 3.2s or 6.3s where every other coordinator of the region took ~100ms:
//
//   engine-wnam-p9   isolate 2026-09-29 20:27:11 → ≤22:18:29   minute medians 3.12–3.24s, 40 more abandoned at ~6.3s
//   engine-wnam-p10  isolate 2026-10-01 23:25:55 → 10-02 01:40  the same two quanta, 23:32 → 00:46
//
// The object was never silent and never busy: ~40ms of CPU per gather, no storage, no reload, 78MB.
// Its siblings ran each call in 5–15ms (max 320ms) and answered 18 gathers from four OTHER
// coordinators in the same minute in under 250ms. What was late was the DELIVERY of some of this
// object's own outgoing sibling calls: at one-second resolution six to nine of the ten siblings were
// invoked at once and the rest ~1s or ~3.1s later, a different sibling each time; a phase with a late
// call cost 3.1s, both phases 6.3s. A page that took over ENGINE_HEDGE_MS was hedged to enam (which
// answered in 100–450ms) — 40 and 36 times — and the ones that took 3.2s were simply slow.
//
// Nothing in this codebase waits 1s or 3.1s, so the stall is below it, and its cause is NOT
// established: it has the shape of a connection retried on a 1s-then-2s timer, and it was confined
// to two isolates while every coordinator ran the same ten-wide fan-out. x44's limiter
// (sibling-limit.ts) has since taken the seventh-to-tenth calls out of the runtime's six-connection
// queue, which is the other candidate; a call still timed here at 1s or 3.1s with six or fewer
// outstanding rules that one out. Whatever it is, the object can SEE it — a sibling call that took a second while its fellows took milliseconds — and stop
// coordinating, so the caller's failover (remote-engine.ts) asks the neighbour region in
// milliseconds instead of after four seconds, from every isolate at once.

/** One sibling call a gather made, as the coordinator timed it. */
export interface SiblingCallTiming {
	partition: number;
	method: "searchKeys" | "fetchRows";
	/** Wall time of the call from this object, retry included. */
	ms: number;
	/** What the sibling said its own store load took (searchKeys only): time that is not a stall. */
	acquireMs: number;
	failed: boolean;
}

/**
 * A sibling call this slow, beyond the sibling's own reported load, was held up on the way.
 *
 * Warm sibling calls measured 5–15ms at the median and 160–320ms at the worst within the incident
 * minutes; the stalls were ~1,000ms and ~3,100ms. 900ms sits between, under the shorter stall.
 */
export const SIBLING_STALL_MS = 900;

/**
 * ...but only when the gather's OTHER sibling calls were quick. A broad regex costs every partition
 * the same CPU, so all ten calls are slow together and the median with them; a stall leaves the
 * median at milliseconds. Above this the gather is judged heavy, not stalled.
 */
export const SIBLING_QUICK_MEDIAN_MS = 300;

/** Fewer sibling calls than this cannot tell a stall from a slow query: no verdict either way. */
export const STALL_MIN_CALLS = 3;

export interface StallVerdict {
	/** True: stalled. False: clean. Null: too few sibling calls to say (a list gather of one or two). */
	stalled: boolean | null;
	/** The calls over SIBLING_STALL_MS net of their sibling's load, slowest first. */
	slow: SiblingCallTiming[];
	medianMs: number;
}

/** Whether a gather's sibling calls show the stall: some a second late, the rest quick. */
export function stallOf(calls: readonly SiblingCallTiming[]): StallVerdict {
	const net = (c: SiblingCallTiming) => Math.max(0, c.ms - c.acquireMs);
	const sorted = calls.map(net).sort((a, b) => a - b);
	const medianMs = sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] as number);
	const slow = calls.filter((c) => net(c) >= SIBLING_STALL_MS).sort((a, b) => net(b) - net(a));
	if (calls.length < STALL_MIN_CALLS) return { stalled: null, slow, medianMs };
	return { stalled: slow.length > 0 && medianMs < SIBLING_QUICK_MEDIAN_MS, slow, medianMs };
}

/** Stalled gathers in a row before the object stops coordinating. One is an eviction's hang. */
export const STALL_STREAK_TO_SHED = 2;
/** The first shedding period; doubled each time the gather that ends one stalls again. */
export const SHED_BASE_MS = 30_000;
/** The longest shedding period: at most one slow probe page every five minutes. */
export const SHED_MAX_MS = 300_000;

/**
 * One coordinator's stall record. Kept per LABEL in module state (gatherHealthOf), because the
 * stall lasted the life of the ISOLATE while the object inside it was evicted and re-created
 * between bursts of traffic — an instance field would have forgotten it every ten idle seconds.
 */
export class GatherHealth {
	/** Stalled gathers since the last clean one. */
	streak = 0;
	/** Shedding periods since the last clean gather. */
	periods = 0;
	shedUntil = 0;
	/** How many gathers this object refused in the current or last period, for the log. */
	shed = 0;

	/** Whether a sheddable gather arriving `now` should be refused. */
	shedding(now: number): boolean {
		return now < this.shedUntil;
	}

	/**
	 * Record one finished gather. Returns the length of the shedding period it STARTS, or null.
	 *
	 * A clean gather ends everything at once — hedged and RPC gathers are never refused, so they
	 * keep probing during a period. When a period runs out the next gather is let through; if it
	 * stalls, the next period starts at once and is twice as long.
	 */
	note(verdict: boolean | null, now: number): number | null {
		if (verdict === null) return null;
		if (!verdict) {
			this.streak = 0;
			this.periods = 0;
			this.shedUntil = 0;
			return null;
		}
		this.streak += 1;
		if (this.streak < STALL_STREAK_TO_SHED || now < this.shedUntil) return null;
		const ms = Math.min(SHED_MAX_MS, SHED_BASE_MS * 2 ** this.periods);
		this.periods += 1;
		this.shedUntil = now + ms;
		this.shed = 0;
		return ms;
	}
}

const healths = new Map<string, GatherHealth>();

/** The stall record of the object named `label`, for the life of this isolate. */
export function gatherHealthOf(label: string): GatherHealth {
	let health = healths.get(label);
	if (!health) {
		health = new GatherHealth();
		healths.set(label, health);
	}
	return health;
}

/** For tests: forget every object's record. */
export function resetGatherHealthForTests(): void {
	healths.clear();
}

/** A gather this slow is logged whether or not it stalled. */
export const SLOW_GATHER_LOG_MS = 2_000;

/**
 * The line a slow or stalled gather logs — everything the x45 diagnosis had to reconstruct from
 * per-second invocation metrics, in one message: find them all with the needle "slow gather".
 *
 *   [engine-wnam-p9] slow gather: 3207ms, 20 sibling calls, median 9ms; searchKeys worst p0 3098ms,
 *   median 8ms; fetchRows worst p4 14ms, median 6ms; late: p0 searchKeys 3098ms; stalled=yes
 *   streak=2 shedding=30000ms inflight=2 isolate=912s
 */
export function slowGatherLine(
	label: string,
	totalMs: number,
	calls: readonly SiblingCallTiming[],
	verdict: StallVerdict,
	health: GatherHealth,
	now: number,
	extra: { inFlight: number; isolateAgeMs: number },
): string {
	const phase = (method: SiblingCallTiming["method"]) => {
		const of = calls.filter((c) => c.method === method);
		if (of.length === 0) return `${method} none`;
		const worst = of.reduce((a, b) => (b.ms > a.ms ? b : a));
		const sorted = of.map((c) => c.ms).sort((a, b) => a - b);
		const failed = of.filter((c) => c.failed).length;
		return (
			`${method} worst p${worst.partition} ${worst.ms}ms, median ${sorted[Math.floor((sorted.length - 1) / 2)]}ms` +
			(failed ? `, ${failed} failed` : "")
		);
	};
	const late = verdict.slow
		.slice(0, 6)
		.map((c) => `p${c.partition} ${c.method} ${c.ms}ms${c.acquireMs ? ` (its load ${c.acquireMs}ms)` : ""}`);
	const left = health.shedUntil - now;
	return (
		`[${label}] slow gather: ${totalMs}ms, ${calls.length} sibling calls, median ${verdict.medianMs}ms; ` +
		`${phase("searchKeys")}; ${phase("fetchRows")}; late: ${late.length ? late.join(", ") : "none"}; ` +
		`stalled=${verdict.stalled === null ? "unknown" : verdict.stalled ? "yes" : "no"} streak=${health.streak} ` +
		`shedding=${left > 0 ? `${left}ms` : "no"} inflight=${extra.inFlight} isolate=${Math.round(extra.isolateAgeMs / 1000)}s`
	);
}
