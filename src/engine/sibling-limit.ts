/**
 * x44: a gather never has more than SIX sibling calls outstanding.
 *
 * WHY: Workers lets one invocation have six outgoing connections waiting on their answer; a seventh
 * is queued by the runtime until one of the six is answered (developers.cloudflare.com/workers/
 * platform/limits, "Simultaneous open connections"), and x23's probe measured the same six for
 * Durable Object calls. An 11-partition gather issued all ten sibling calls at once, so on every
 * full gather four of them sat in the RUNTIME's queue — and that queue is where calls die:
 *
 *   - 893 "failed transiently" lines on DeckGen, 2026-09-29 → 10-02, 885 of them "Network
 *     connection lost.", in 195 bursts that each landed in ONE millisecond on ONE coordinator.
 *   - Of the 143 searchKeys bursts, 100 were an exact PREFIX of the order the coordinator issued
 *     its calls in (the 1st..kth, k = 1–10) and 32 lay wholly in the last four (the 7th–10th, 20 of
 *     them exactly those four). 11 were neither, most a prefix with one hole. A sibling being
 *     evicted or reset cannot produce either shape: it does not know its place in another object's
 *     loop. No sibling logged a store load around the sampled bursts, and the coordinators were warm.
 *   - The last-four shape is x23's: calls still queued to connect are cancelled together. The prefix
 *     shape is the runtime cancelling the OLDEST open calls while newer ones wait behind them — it
 *     showed up on slow queries (a regex search being paged) and in the daily ~06:53 UTC sweep, i.e.
 *     whenever siblings took long enough to answer that the queued four stayed queued.
 *
 * Both need a call waiting in the runtime's queue, so none is put there: the seventh waits HERE, as
 * a plain promise the runtime never sees, and is sent when one of the six settles. It is the wait
 * the runtime already imposed, moved to where nothing can cancel it; no call is added, dropped or
 * reordered, so the page is the same bytes.
 *
 * One limiter per gather (the limit is counted per invocation, and the 7th–10th shape stayed exact
 * under the sweep's concurrent gathers, which a per-object count would have scrambled). A retry runs
 * inside the slot of the call it replaces — the dead connection is gone before the fresh one opens.
 */
export const SIBLING_CALLS_AT_ONCE = 6;

/** Sibling calls outstanding across every gather an object is running — for the log line only. */
export interface SiblingLoad {
	/** Calls sent and not yet settled. */
	open: number;
	/** Calls waiting for one of their gather's slots. */
	queued: number;
}

export class SiblingLimiter {
	private openCalls = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(
		private readonly load: SiblingLoad = { open: 0, queued: 0 },
		private readonly limit = SIBLING_CALLS_AT_ONCE,
	) {}

	/** This gather's calls sent and not yet settled. */
	get open(): number {
		return this.openCalls;
	}

	/** This gather's calls waiting for a slot. */
	get queued(): number {
		return this.waiting.length;
	}

	/**
	 * `task`, started at once when a slot is free — synchronously, so a fan-out of six or fewer is
	 * issued exactly as it was before (x23 depends on nothing running between the coordinator's
	 * memory reservation and its calls going out) — and otherwise when an earlier call settles, in
	 * the order asked.
	 */
	run<T>(task: () => Promise<T>): Promise<T> {
		if (this.openCalls < this.limit) {
			this.openCalls++;
			this.load.open++;
			return this.settle(task);
		}
		this.load.queued++;
		return new Promise<void>((resolve) => this.waiting.push(resolve)).then(() => {
			// The slot was handed over still counted (see release), so only the tallies move.
			this.load.queued--;
			this.load.open++;
			return this.settle(task);
		});
	}

	private async settle<T>(task: () => Promise<T>): Promise<T> {
		try {
			return await task();
		} finally {
			this.release();
		}
	}

	private release(): void {
		this.load.open--;
		const next = this.waiting.shift();
		// Handed straight to the next in line: the count never dips, so a call arriving between
		// this release and that task's start cannot take a seventh slot.
		if (next) next();
		else this.openCalls--;
	}
}
