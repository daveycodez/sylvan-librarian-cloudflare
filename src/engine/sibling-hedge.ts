/**
 * x53: a sibling call that is still out when its fellows have long answered is asked a second time,
 * on a fresh stub, and the gather takes whichever answers first.
 *
 * WHY (DeckGen, 2026-10-02 05:44–07:25 UTC, the `slow gather` lines x45 added). 44 lines, 43 of
 * them `stalled=yes`:
 *
 *   - 40 of the 43 were coordinated by engine-wnam-p10 (25) or engine-wnam-p1 (15), and in EVERY one
 *     of those the late sibling was one of p0, p4, p5, p6, p7 — 61 late calls, never p2, p3, p8 or
 *     p9, and never each other. Which of the five was late changed from gather to gather; 14 of the
 *     43 had two to four of them late in one phase, to within a few ms of each other (p5 and p4 both
 *     3173ms). So it is a bad path between two SETS of objects, not one bad object.
 *   - A late call took 3.11–3.40s 61 times of 64; the others were 1.14s, 1.15s (the one-second half
 *     of the same 1s-then-2s timer) and 2.87s. The other siblings' median was 8–121ms (one at 261ms).
 *   - Old isolates and new: 14 of p1's 15 were on an isolate under 30s old (streak=1, so x45's
 *     shedding never engaged), and p10 stalled again on the gather let through after its periods.
 *
 * Shedding (gather-health.ts) spares the callers that come AFTER two stalled gathers. It does
 * nothing for the first two, for the probe that ends each period, or for a fresh isolate — and
 * each of those is a person waiting 3.2s or 6.3s for a page its siblings computed in 15ms.
 *
 * WHAT IS NOT KNOWN: whether a second call to the same object arrives any sooner. Two or three
 * siblings late by the same number of milliseconds says their calls rode ONE stuck connection to
 * wherever those objects live, and a second call may be put on that same connection and wait with
 * the first. Or the runtime may open another, which takes a different path and lands in
 * milliseconds — two timer expiries in a row on one connection while its neighbours were fine is
 * what a path-specific loss looks like. Cloudflare documents neither (the Durable Objects docs say
 * nothing about how stub calls share transport; searched 2026-10-02). So this is an EXPERIMENT, and
 * it logs its own result: every hedge writes one `sibling hedge` line saying who won. If the hedge
 * wins most of the time, a stalled gather costs ~0.5s where it cost 3.2s; if the original always
 * wins at ~3.2s, the hedge is one wasted call per stall — set SIBLING_HEDGE_ENABLED to false.
 *
 * THE RULE. A call is hedged once, when all of these hold:
 *
 *   - at least half of this phase's sibling calls have answered (SIBLING_HEDGE_QUORUM) — up to four
 *     of ten were late together, so a stricter quorum would have sat out exactly the worst gathers;
 *   - it has been out SIBLING_HEDGE_FLOOR_MS, and
 *   - it has been out SIBLING_HEDGE_PEER_FACTOR times the median of the answers so far.
 *
 * A query that is heavy in every partition therefore never hedges (its peers' median is its own
 * time), nor does a cold region waking all its stores at once. One cold sibling among warm ones
 * cannot be told from a stall until it answers — its load time is in its REPLY — so the floor sits
 * above a cached store wake (169–406ms measured, see store.ts) and below the timer's first second;
 * a sibling loading from KV for seconds is hedged once, pointlessly, and the line says so
 * (`its load Nms`).
 *
 * COST. Nothing on the healthy path but a timer per sibling call, cleared when it answers. A hedge
 * is one more call to the same object, sent through the gather's limiter (sibling-limit.ts) like
 * any other, so never a seventh outstanding; by then half the phase has answered and slots are free.
 * The call that lost is not cancelled — nothing can cancel it — and keeps its slot until it
 * settles, which is the runtime's own accounting of it.
 *
 * CORRECTNESS. Both calls carry the same arguments to the same object and are reads. The first
 * ANSWER wins; a failure waits for the other call, and when both fail the ORIGINAL's error is the
 * one thrown — so a StaleModulusError or an EngineUnavailableError surfaces exactly as it did, and
 * siblingCall's own retry of a reset still runs inside each of the two.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * x55: WHAT THE EXPERIMENT SAID, AND THE TWO THINGS IT CHANGED.
 *
 * DeckGen, 2026-10-02 09:48–19:48 UTC, the `sibling hedge` lines above: 474 hedges in 288 gathers,
 * 453 of them from wnam coordinators. Classed by when the ORIGINAL call landed:
 *
 *   - 248 were the stall (original at 3.12–4.0s, or still out when the gather ended) — 200 of them
 *     coordinated by engine-wnam-p10 or -p8 and 24 by -p6; every other coordinator had at most one.
 *     The second call to the same object answered 194 of them, a median 17ms after it was sent
 *     (p90 122ms). It lost 53 with the original at ≥3s: 36 of those were sent on time (500–600ms)
 *     and simply rode the same stuck path (16 the only late call of their phase, 20 one of several),
 *     and 17 were sent as the original was landing, because they had WAITED FOR A SLOT. With k calls
 *     stuck a gather has 6−k slots (sibling-limit.ts), and a hedge that sticks holds one: 49 hedges
 *     in phases with two to six late calls were sent 0.1–3.4s after they were due.
 *   - 170 were a sibling WAKING: its reply carried `its load`, the original landed at a median 662ms
 *     (p90 1,086ms) and the hedge won none of them — a second call to an object that is starting up
 *     waits for the same start. They were spread evenly over every coordinator (10–23 each), and 102
 *     were on the coordinator isolate's first gather: a region that had been idle.
 *   - 56 were neither: no load reported, the original at 500–870ms.
 *
 * CHANGE 1 — THE NEIGHBOUR REGION'S COPY OF THE PARTITION. A late call can also be sent to the same
 * partition's object in the neighbouring served region (placement-policy.ts hedgeRegionFor — the
 * mapping, the shard-0 name and the stub the Worker's own hedge uses, see search-engine-do.ts).
 * That object is on other hosts, so its call does not ride the stuck path, and it holds the same
 * store: its answer is taken only when it is from the build this gather's other answers are from
 * (`refuse`), and is otherwise thrown away and the original waited for.
 *
 *   - A call hedged at the ordinary floor is asked on a fresh stub FIRST, as before — that answered
 *     79% of the stalls in 17ms and wakes nothing — and the neighbour SIBLING_HEDGE_CROSS_AFTER_MS
 *     later if neither call has answered (the second call's wins: p90 122ms after it was sent).
 *   - ...unless the gather cannot spare two slots for each late call it still has to hedge: then the
 *     neighbour is asked at once and the same object is not. Three or more late calls in a phase,
 *     or a phase two behind abandoned phase-one calls. A neighbour's answer frees its slot in a
 *     round trip; a second call that sticks holds it for 2.7s.
 *   - A call hedged at the WAKING floor (below) goes to the neighbour at once: the same object
 *     cannot answer sooner whether it is waking or stalled.
 *   - A region with no served neighbour keeps the second call to the same object, unchanged.
 *
 * CHANGE 2 — A SIBLING THAT MAY BE WAKING IS GIVEN LONGER. Its load time is only in its reply, so
 * the coordinator goes by what it already knows (SiblingMemory, per isolate, no call added): a
 * sibling that answered this object within SIBLING_AWAKE_MS has not been idle long enough to be
 * evicted, and an isolate that has SEEN the stall (a call landing SIBLING_STUCK_MS late net of its
 * load) within SIBLING_STUCK_MEMORY_MS knows what its late calls are. Either way the floor is the
 * ordinary one. Otherwise the call may be to a waking object and its floor is
 * SIBLING_HEDGE_WAKING_FLOOR_MS. Nothing is ever skipped outright — a stall on such a call is
 * hedged 400ms later, to the neighbour — because a fresh isolate's first gather is where both
 * happen (32 of the 248 stalls, 102 of the 170 wakes).
 *
 * REPLAYED OVER THOSE 474 LINES (taking no sibling as recently heard, the worst case for stalls):
 * 130 of the 170 waking hedges and 49 of the 56 others are not sent; no stall goes unhedged, 172
 * are hedged at 500ms as now and 76 at 900ms; 325 hedge calls where there were 474 (141 to the
 * same object, 184 to the neighbour) — about 780 a day against 1,140, some 440 of them calls that
 * may wake a neighbour's object. The replay cannot say how often the neighbour answers sooner than
 * the original: that is what the line below is for.
 *
 * THE LINE says where each hedge went and which answer was used:
 *
 *   ... fired at 502ms; won by hedge at 519ms                            the same object, as before
 *   ... fired at 502ms, to enam at 655ms; won by hedge to enam at 731ms  then the neighbour
 *   ... fired at 902ms to enam; won by hedge to enam at 990ms            the neighbour alone
 *   ... won by original at 3173ms, enam's answer discarded: build 8 where 7 is pinned
 *
 * so "won by hedge to " counts the neighbour's rescues, "ms to " and ", to " its calls, and
 * "discarded" the answers a publish in progress made unusable.
 */

import { parseEngineName } from "./engine-namespace";
import { builtAtOfStoreKey } from "./gather";
import { generationOf, type Hint, hedgeRegionFor, type PlacementBlock } from "./placement-policy";

/** The one-line switch for the second call to the SAME object: false and none is ever sent. */
export const SIBLING_HEDGE_ENABLED = true;

/**
 * x55's switch for the call to the NEIGHBOUR region's copy: false and none is ever sent, and a late
 * call is hedged exactly as x53 did (the waking floor still applies; make it the floor to undo that).
 * Either switch works alone; with both false no sibling call is hedged and no timer is set.
 */
export const SIBLING_HEDGE_CROSS_REGION_ENABLED = true;

/** Never hedge sooner than this: above a cached store wake, below the stall's first second. */
export const SIBLING_HEDGE_FLOOR_MS = 500;

/**
 * ...nor sooner than this when the sibling may be waking (SiblingMemory.mayBeWaking). The 170 waking
 * siblings hedged on 2026-10-02 answered at a median 662ms, 138 of them (81%) inside 900ms; the stall
 * is 3.1–3.4s, so one hedged here is still answered two seconds sooner. It is also gather-health's
 * SIBLING_STALL_MS: the point past which a call is counted as held up rather than slow.
 */
export const SIBLING_HEDGE_WAKING_FLOOR_MS = 900;

/** ...nor sooner than this many times the median of the phase's answers so far. */
export const SIBLING_HEDGE_PEER_FACTOR = 4;

/** The share of the phase's sibling calls that must have answered before any other is hedged. */
export const SIBLING_HEDGE_QUORUM = 0.5;

/**
 * How long the second call to the same object is given before the neighbour is asked as well. A
 * second call that was going to answer did so a median 17ms after it was sent, 75% within 40ms and
 * 90% within 122ms; one still out after this is on the stuck path too.
 */
export const SIBLING_HEDGE_CROSS_AFTER_MS = 150;

const tuning = {
	enabled: SIBLING_HEDGE_ENABLED,
	crossRegion: SIBLING_HEDGE_CROSS_REGION_ENABLED,
	floorMs: SIBLING_HEDGE_FLOOR_MS,
	wakingFloorMs: SIBLING_HEDGE_WAKING_FLOOR_MS,
	peerFactor: SIBLING_HEDGE_PEER_FACTOR,
	quorum: SIBLING_HEDGE_QUORUM,
	crossAfterMs: SIBLING_HEDGE_CROSS_AFTER_MS,
};

/** For tests: change the hedge's tuning; the returned function puts it back. */
export function setSiblingHedgeForTests(change: Partial<typeof tuning>): () => void {
	const before = { ...tuning };
	Object.assign(tuning, change);
	return () => {
		Object.assign(tuning, before);
	};
}

/**
 * A sibling that answered this object this recently cannot have been evicted since: Cloudflare
 * evicts a Durable Object after ~10s idle (reloads followed gaps of ≥12s and never ≤9s, 2026-09-25).
 */
export const SIBLING_AWAKE_MS = 9_000;

/**
 * A sibling call that lands this late, net of the load its reply reports, is the stall and not a
 * wake: the stall is 3.1–3.4s (rarely ~1.0–1.15s), and of the 170 waking siblings hedged on
 * 2026-10-02 the slowest landed at 2.3s, 164 of them inside 1.5s.
 */
export const SIBLING_STUCK_MS = 2_500;

/** How long an isolate that saw the stall goes on treating its late calls as stalls. The stalling
 * isolates of 2026-10-02 stalled again within minutes for as long as they lived. */
export const SIBLING_STUCK_MEMORY_MS = 15 * 60_000;

/**
 * What one coordinator knows, without asking, about whether a late sibling call is to a WAKING
 * object. Kept per label in module state like the gather's health (gather-health.ts): it is a fact
 * about this isolate's calls, and the object inside the isolate is re-created every ten idle seconds.
 */
export class SiblingMemory {
	private readonly heard = new Map<number, number>();
	private stuckAt = Number.NEGATIVE_INFINITY;

	/** A call to `partition` in this region answered at `now`, `netMs` after it was sent (its own load taken off). */
	answered(partition: number, now: number, netMs: number): void {
		this.heard.set(partition, now);
		if (netMs >= SIBLING_STUCK_MS) this.stuckAt = now;
	}

	/** Whether a call to `partition` that is late at `now` may be late because the object is starting up. */
	mayBeWaking(partition: number, now: number): boolean {
		if (now - this.stuckAt <= SIBLING_STUCK_MEMORY_MS) return false;
		const heard = this.heard.get(partition);
		return heard === undefined || now - heard > SIBLING_AWAKE_MS;
	}
}

const memories = new Map<string, SiblingMemory>();

/** The memory of the object named `label`, for the life of this isolate. */
export function siblingMemoryOf(label: string): SiblingMemory {
	let memory = memories.get(label);
	if (!memory) {
		memory = new SiblingMemory();
		memories.set(label, memory);
	}
	return memory;
}

/** For tests: forget every object's memory. */
export function resetSiblingMemoryForTests(): void {
	memories.clear();
}

/**
 * The neighbour a coordinator named `label` sends a late sibling call to: the region the Worker's
 * own hedge of a slow engine call goes to (hedgeRegionFor — a SERVED region, never this one), and
 * the generation its object names carry. Null where there is none, or the label is no engine name.
 * The object is that region's SHARD 0 copy of the partition, as the Worker's hedge addresses it: the
 * one its own traffic keeps warm, and the only one certain to exist.
 */
export function hedgeNeighbourOf(
	label: string,
	placement: PlacementBlock | undefined,
): { region: Hint; generation: number } | null {
	const parsed = parseEngineName(label);
	if (!parsed) return null;
	const region = hedgeRegionFor(parsed.region as Hint, placement);
	return region === null ? null : { region, generation: generationOf(region, placement) };
}

/**
 * SAME ANSWER, OR NO ANSWER: what a neighbour's searchKeys reply must match to stand in for a
 * sibling's.
 *
 * Every region loads the same archives from the same KV keys, so partition k of build B is the same
 * bytes in enam as in wnam and one engine build answers a query over it identically. What can
 * differ, for a short time around a publish, is WHICH build an object holds. A gather is pinned to
 * one build by its phase-1 replies' store keys (gather.ts pinGeneration); the neighbour's reply is
 * taken only when it names the build every answer this region has given the phase names — and this
 * object's own loaded store, when it has one — and the same sort-key encoding. Anything else is
 * refused and the original waited for, which is the gather x53 ran.
 *
 * Phase 2 needs no such check: fetchRows carries the store key phase 1 pinned, and an object holding
 * any other archive refuses the call itself (search-engine-do.ts fetchRows).
 */
export class PhaseBuild {
	private readonly builds = new Set<string>();
	private readonly versions = new Set<number>();

	/** One of this region's own answers to the phase. */
	note(reply: { storeKey: string; sortKeyVersion: number }): void {
		this.builds.add(builtAtOfStoreKey(reply.storeKey));
		this.versions.add(reply.sortKeyVersion);
	}

	/** Why a neighbour's reply cannot be used, or null when it can. `ownBuild`: this object's loaded built_at. */
	refuse(reply: { storeKey: string; sortKeyVersion: number }, ownBuild: string | undefined): string | null {
		const [pinned, ...others] = [...this.builds];
		if (pinned === undefined || others.length > 0) {
			return `this region's answers name ${this.builds.size} builds`;
		}
		if (ownBuild !== undefined && ownBuild !== pinned)
			return `this object holds build ${ownBuild} and its siblings ${pinned}`;
		const build = builtAtOfStoreKey(reply.storeKey);
		if (build !== pinned) return `build ${build} where ${pinned} is pinned`;
		if (this.versions.size !== 1 || !this.versions.has(reply.sortKeyVersion)) {
			return `sort-key version ${reply.sortKeyVersion} where ${[...this.versions].join(",")} is pinned`;
		}
		return null;
	}
}

/** What a hedge did, for the log line and the gather's stall verdict. */
export interface HedgeNote {
	/** How long the original had been out when the first hedge was sent. */
	firedAtMs: number;
	/** Which call's answer the gather used; "neither" when every call failed. */
	won: "hedge" | "original" | "neither";
	/** When the original settled, measured from its own send; null while it is still out. */
	originalMs: number | null;
	/** The phase as the hedge saw it: answers in hand, calls issued, and those answers' median. */
	answered: number;
	issued: number;
	peerMedianMs: number;
	/** x55: the call to the neighbour region's copy of the partition, when one was sent. */
	cross?: {
		region: string;
		/** How long the original had been out when it was sent. */
		firedAtMs: number;
		/** True when it was the only hedge: no second call went to the same object. */
		direct: boolean;
		/** True when ITS answer is the one the gather used (`won` is then "hedge"). */
		won?: true;
		/** Why its answer was thrown away, when it was: it came from another store build. */
		discarded?: string;
	};
}

/** One sibling call's outcome: its answer or its error, how long the gather waited, and the hedge if one was sent. */
export type HedgedCall<T> =
	| { ok: true; value: T; ms: number; hedge: HedgeNote | null }
	| { ok: false; error: unknown; ms: number; hedge: HedgeNote | null };

/** The neighbour region's copy of the sibling a call is to. */
export interface CrossTarget<T> {
	/** The neighbouring served region, for the line. */
	region: string;
	/** The same call, to that object. One attempt. */
	send: () => Promise<T>;
	/** Why this answer cannot stand in for the original's, or null when it can. */
	refuse?: (value: T) => string | null;
}

/** What the gather tells a phase about one call beyond how to send it. All optional: without them a
 * call is hedged as x53 hedged it. */
export interface HedgeOptions<T> {
	/** Whether the sibling may be starting up (SiblingMemory.mayBeWaking), asked when the call is late. */
	mayBeWaking?: () => boolean;
	/** The neighbour's copy, resolved only when a hedge is due; null where there is none. */
	cross?: () => CrossTarget<T> | null;
	/** Slots the gather's limiter has free right now. */
	free?: () => number;
	/** The limiter's line for a hedge (its head — see sibling-limit.ts); `schedule` when absent. */
	scheduleHedge?: (task: () => Promise<T>) => Promise<T>;
	/** Hears the ORIGINAL call's own outcome whenever it comes — after the gather has moved on, too. */
	onOriginal?: (outcome: { ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number }) => void;
}

/** What a hedge's turn in the limiter rejects with when the call had already landed. Never surfaces. */
class HedgeNotSentError extends Error {}

/**
 * The sibling calls of one phase of one gather (its searchKeys, or its fetchRows): they are issued
 * together, so each is judged against the others.
 */
export class HedgePhase {
	private issued = 0;
	/** How long each un-hedged call that has answered took. */
	private readonly answers: number[] = [];
	/** Calls sent, not yet landed, and not yet hedged: the ones a hedge's slot may still be needed for. */
	private unhedged = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Run one sibling call. `send` issues it — once at once, and once more if the call is hedged to
	 * the same object — and `schedule` is the gather's limiter: it runs the task it is given when a
	 * slot is free and holds the slot until the task's promise settles. The call's clock starts when
	 * its slot does, so a wait for a slot is not counted as the call being late, and a hedge whose
	 * slot comes up after the original has landed is not sent at all.
	 *
	 * Never rejects: the outcome says whether the call answered. Starts `send` synchronously when
	 * `schedule` does.
	 */
	run<T>(
		send: () => Promise<T>,
		schedule: (task: () => Promise<T>) => Promise<T> = (task) => task(),
		options: HedgeOptions<T> = {},
	): Promise<HedgedCall<T>> {
		this.issued += 1;
		const scheduleHedge = options.scheduleHedge ?? schedule;
		return new Promise<HedgedCall<T>>((resolve) => {
			const call = {
				sentAt: -1,
				/** The gather has its outcome. */
				settled: false,
				/** The original answered or failed — known inside its slot, before the slot is released. */
				landed: false,
				/** A hedge was asked for (it may still be waiting for a slot, or never be sent). */
				asked: false,
				/** Hedges asked for and not yet over: answered, failed, refused or never sent. */
				out: 0,
				note: null as HedgeNote | null,
				originalFailed: null as { error: unknown } | null,
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			let crossTimer: ReturnType<typeof setTimeout> | undefined;

			const sinceSent = () => this.now() - call.sentAt;
			const finish = (outcome: HedgedCall<T>) => {
				call.settled = true;
				clearTimeout(timer);
				clearTimeout(crossTimer);
				resolve(outcome);
			};
			/** One hedge is over without an answer the gather could use: the original's outcome stands,
			 * whenever it comes — and if it has already failed and no other hedge is out, it is the call's. */
			const hedgeOver = () => {
				call.out -= 1;
				if (!call.settled && call.originalFailed && call.out === 0) {
					finish({ ok: false, error: call.originalFailed.error, ms: sinceSent(), hedge: call.note });
				}
			};

			/**
			 * Send one hedge through the limiter: to the same object (`target` null), or to the
			 * neighbour's copy. `then` runs as it is sent — the same-object hedge uses it to start the
			 * neighbour's clock.
			 */
			const hedge = (
				seen: Pick<HedgeNote, "answered" | "issued" | "peerMedianMs">,
				target: CrossTarget<T> | null,
				direct: boolean,
				then?: () => void,
			) => {
				call.out += 1;
				scheduleHedge(() => {
					if (call.landed || call.settled) return Promise.reject(new HedgeNotSentError());
					const firedAtMs = sinceSent();
					call.note ??= { firedAtMs, won: "neither", originalMs: null, ...seen };
					if (target) call.note.cross = { region: target.region, firedAtMs, direct };
					then?.();
					return target ? target.send() : send();
				}).then((value) => {
					if (target) {
						let refused: string | null;
						try {
							refused = target.refuse?.(value) ?? null;
						} catch (err) {
							refused = String(err);
						}
						if (refused !== null) {
							if (call.note?.cross) call.note.cross.discarded = refused;
							hedgeOver();
							return;
						}
					}
					if (call.settled) return;
					if (call.note) {
						call.note.won = "hedge";
						if (target && call.note.cross) call.note.cross.won = true;
					}
					finish({ ok: true, value, ms: sinceSent(), hedge: call.note });
				}, hedgeOver);
			};

			const consider = () => {
				timer = undefined;
				if (call.settled || call.landed || call.asked) return;
				// Too few answers to judge by. Looked at again a floor later, NOT when the next answer
				// arrives: when most of a phase is late together, the first late answer would
				// otherwise hedge the rest in the very millisecond they are landing.
				if (this.answers.length < Math.max(1, Math.ceil(this.issued * tuning.quorum))) {
					timer = setTimeout(consider, tuning.floorMs);
					return;
				}
				const sorted = [...this.answers].sort((a, b) => a - b);
				const peerMedianMs = sorted[Math.floor((sorted.length - 1) / 2)] as number;
				const waking = tuning.wakingFloorMs > tuning.floorMs && (options.mayBeWaking?.() ?? false);
				const due = Math.max(waking ? tuning.wakingFloorMs : tuning.floorMs, tuning.peerFactor * peerMedianMs);
				const out = sinceSent();
				if (out < due) {
					timer = setTimeout(consider, due - out);
					return;
				}
				call.asked = true;
				this.unhedged -= 1;
				const target = tuning.crossRegion ? (options.cross?.() ?? null) : null;
				// A second call to an object that is starting up waits for the same start (it won none
				// of 170), so it is sent to a may-be-waking sibling only where there is no neighbour.
				const same = tuning.enabled && (!waking || target === null);
				const seen = { answered: this.answers.length, issued: this.issued, peerMedianMs };
				// Both hedges need a slot each, and so does every other late call of the phase still to
				// be hedged. When the limiter cannot give that, the neighbour alone is asked: its
				// answer frees the slot in a round trip, where a second call that sticks holds it.
				const slots = options.free?.() ?? Number.POSITIVE_INFINITY;
				if (target && (!same || slots < 2 * (this.unhedged + 1))) {
					hedge(seen, target, true);
				} else if (same) {
					hedge(seen, null, false, () => {
						if (!target) return;
						crossTimer = setTimeout(() => {
							crossTimer = undefined;
							if (!call.settled && !call.landed) hedge(seen, target, false);
						}, tuning.crossAfterMs);
					});
				}
			};

			schedule(() => {
				call.sentAt = this.now();
				this.unhedged += 1;
				if (tuning.enabled || tuning.crossRegion) timer = setTimeout(consider, tuning.floorMs);
				const sent = send();
				// Registered before the limiter's own continuation, so it runs before the slot is
				// handed on: a hedge waiting for THIS slot sees that the call has landed.
				const landed = () => {
					call.landed = true;
					if (!call.asked) this.unhedged -= 1;
					clearTimeout(timer);
					clearTimeout(crossTimer);
				};
				sent.then(landed, landed);
				return sent;
			}).then(
				(value) => {
					const ms = sinceSent();
					if (call.note) call.note.originalMs = ms;
					options.onOriginal?.({ ok: true, value, ms });
					if (call.settled) return;
					if (call.note) call.note.won = "original";
					else this.answers.push(ms);
					finish({ ok: true, value, ms, hedge: call.note });
				},
				(error) => {
					const ms = sinceSent();
					if (call.note) call.note.originalMs = ms;
					options.onOriginal?.({ ok: false, error, ms });
					if (call.settled) return;
					// A hedge is still to answer, and its answer would be as good. If it fails, is
					// refused or is never sent, hedgeOver ends the call with THIS error.
					if (call.out > 0) {
						call.originalFailed = { error };
						return;
					}
					finish({ ok: false, error, ms, hedge: call.note });
				},
			);
		});
	}
}

/** `won by hedge`, `won by hedge to enam`, `won by original`, or `both failed` — the verdict both lines carry. */
export function hedgeVerdict(hedge: HedgeNote): string {
	if (hedge.won === "neither") return "both failed";
	return `won by ${hedge.won}${hedge.won === "hedge" && hedge.cross?.won ? ` to ${hedge.cross.region}` : ""}`;
}

/** `fired at 502ms`, `fired at 502ms to enam`, or `fired at 502ms, to enam at 655ms`. */
export function hedgeFired(hedge: HedgeNote, at = "fired at "): string {
	const { cross } = hedge;
	if (!cross) return `${at}${hedge.firedAtMs}ms`;
	if (cross.direct) return `${at}${hedge.firedAtMs}ms to ${cross.region}`;
	return `${at}${hedge.firedAtMs}ms, to ${cross.region} at ${cross.firedAtMs}ms`;
}

/**
 * The line every hedge logs — find them all with the needle "sibling hedge":
 *
 *   [engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms; won by hedge at 519ms (8 of 10 answered, median 16ms)
 *   [engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms; won by original at 3173ms (8 of 10 answered, median 16ms)
 *   [engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms; both failed at 25004ms (...)
 *   [engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms, to enam at 655ms; won by hedge to enam at 731ms (...)
 *   [engine-wnam-p10] sibling hedge p5 searchKeys: fired at 902ms to enam; won by original at 3173ms, enam's answer discarded: ... (...)
 *
 * `its load` is the winner's own store load: a hedge spent on a sibling that was merely waking.
 */
export function siblingHedgeLine(
	label: string,
	partition: number,
	method: string,
	call: { ms: number; hedge: HedgeNote },
	acquireMs: number,
): string {
	const { hedge } = call;
	const discarded = hedge.cross?.discarded
		? `, ${hedge.cross.region}'s answer discarded: ${hedge.cross.discarded}`
		: "";
	return (
		`[${label}] sibling hedge p${partition} ${method}: ${hedgeFired(hedge)}; ${hedgeVerdict(hedge)} at ${call.ms}ms` +
		`${discarded}${acquireMs ? `, its load ${acquireMs}ms` : ""} (${hedge.answered} of ${hedge.issued} answered, median ${hedge.peerMedianMs}ms)`
	);
}
