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
 */

/** The one-line switch: false and no sibling call is ever hedged (nor is a timer set). */
export const SIBLING_HEDGE_ENABLED = true;

/** Never hedge sooner than this: above a cached store wake, below the stall's first second. */
export const SIBLING_HEDGE_FLOOR_MS = 500;

/** ...nor sooner than this many times the median of the phase's answers so far. */
export const SIBLING_HEDGE_PEER_FACTOR = 4;

/** The share of the phase's sibling calls that must have answered before any other is hedged. */
export const SIBLING_HEDGE_QUORUM = 0.5;

const tuning = {
	enabled: SIBLING_HEDGE_ENABLED,
	floorMs: SIBLING_HEDGE_FLOOR_MS,
	peerFactor: SIBLING_HEDGE_PEER_FACTOR,
	quorum: SIBLING_HEDGE_QUORUM,
};

/** For tests: change the hedge's tuning; the returned function puts it back. */
export function setSiblingHedgeForTests(change: Partial<typeof tuning>): () => void {
	const before = { ...tuning };
	Object.assign(tuning, change);
	return () => {
		Object.assign(tuning, before);
	};
}

/** What a hedge did, for the log line and the gather's stall verdict. */
export interface HedgeNote {
	/** How long the original had been out when the hedge was sent. */
	firedAtMs: number;
	/** Which call's answer the gather used; "neither" when both failed. */
	won: "hedge" | "original" | "neither";
	/** When the original settled, measured from its own send; null while it is still out. */
	originalMs: number | null;
	/** The phase as the hedge saw it: answers in hand, calls issued, and those answers' median. */
	answered: number;
	issued: number;
	peerMedianMs: number;
}

/** One sibling call's outcome: its answer or its error, how long the gather waited, and the hedge if one was sent. */
export type HedgedCall<T> =
	| { ok: true; value: T; ms: number; hedge: HedgeNote | null }
	| { ok: false; error: unknown; ms: number; hedge: HedgeNote | null };

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

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Run one sibling call. `send` issues it — once at once, and once more if the call is hedged —
	 * and `schedule` is the gather's limiter: it runs the task it is given when a slot is free and
	 * holds the slot until the task's promise settles. The call's clock starts when its slot does,
	 * so a wait for a slot is not counted as the call being late, and a hedge whose slot comes up
	 * after the original has landed is not sent at all.
	 *
	 * Never rejects: the outcome says whether the call answered. Starts `send` synchronously when
	 * `schedule` does.
	 */
	run<T>(
		send: () => Promise<T>,
		schedule: (task: () => Promise<T>) => Promise<T> = (task) => task(),
	): Promise<HedgedCall<T>> {
		this.issued += 1;
		return new Promise<HedgedCall<T>>((resolve) => {
			const call = {
				sentAt: -1,
				/** The gather has its outcome. */
				settled: false,
				/** The original answered or failed — known inside its slot, before the slot is released. */
				landed: false,
				/** A hedge was asked for (it may still be waiting for a slot, or never be sent). */
				asked: false,
				hedgeOver: false,
				note: null as HedgeNote | null,
				originalFailed: null as { error: unknown } | null,
			};
			let timer: ReturnType<typeof setTimeout> | undefined;

			const sinceSent = () => this.now() - call.sentAt;
			const finish = (outcome: HedgedCall<T>) => {
				call.settled = true;
				clearTimeout(timer);
				resolve(outcome);
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
				const due = Math.max(tuning.floorMs, tuning.peerFactor * peerMedianMs);
				const out = sinceSent();
				if (out < due) {
					timer = setTimeout(consider, due - out);
					return;
				}
				call.asked = true;
				const seen = { answered: this.answers.length, issued: this.issued, peerMedianMs };
				schedule(() => {
					if (call.landed || call.settled) return Promise.reject(new HedgeNotSentError());
					call.note = { firedAtMs: sinceSent(), won: "neither", originalMs: null, ...seen };
					return send();
				}).then(
					(value) => {
						if (call.settled) return;
						if (call.note) call.note.won = "hedge";
						finish({ ok: true, value, ms: sinceSent(), hedge: call.note });
					},
					() => {
						// Failed, or never sent: the original's outcome stands, whenever it comes.
						call.hedgeOver = true;
						if (!call.settled && call.originalFailed) {
							finish({ ok: false, error: call.originalFailed.error, ms: sinceSent(), hedge: call.note });
						}
					},
				);
			};

			schedule(() => {
				call.sentAt = this.now();
				if (tuning.enabled) timer = setTimeout(consider, tuning.floorMs);
				const sent = send();
				// Registered before the limiter's own continuation, so it runs before the slot is
				// handed on: a hedge waiting for THIS slot sees that the call has landed.
				const landed = () => {
					call.landed = true;
					clearTimeout(timer);
				};
				sent.then(landed, landed);
				return sent;
			}).then(
				(value) => {
					const ms = sinceSent();
					if (call.note) call.note.originalMs = ms;
					if (call.settled) return;
					if (call.note) call.note.won = "original";
					else this.answers.push(ms);
					finish({ ok: true, value, ms, hedge: call.note });
				},
				(error) => {
					const ms = sinceSent();
					if (call.note) call.note.originalMs = ms;
					if (call.settled) return;
					// A hedge is still to answer, and its answer would be as good. If it fails, or is
					// never sent, the handler above ends the call with THIS error.
					if (call.asked && !call.hedgeOver) {
						call.originalFailed = { error };
						return;
					}
					finish({ ok: false, error, ms, hedge: call.note });
				},
			);
		});
	}
}

/**
 * The line every hedge logs — find them all with the needle "sibling hedge":
 *
 *   [engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms; won by hedge at 519ms (8 of 10 answered, median 16ms)
 *   [engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms; won by original at 3173ms (8 of 10 answered, median 16ms)
 *   [engine-wnam-p10] sibling hedge p5 searchKeys: fired at 502ms; both failed at 25004ms (...)
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
	const result = hedge.won === "neither" ? `both failed at ${call.ms}ms` : `won by ${hedge.won} at ${call.ms}ms`;
	return (
		`[${label}] sibling hedge p${partition} ${method}: fired at ${hedge.firedAtMs}ms; ${result}` +
		`${acquireMs ? `, its load ${acquireMs}ms` : ""} (${hedge.answered} of ${hedge.issued} answered, median ${hedge.peerMedianMs}ms)`
	);
}
