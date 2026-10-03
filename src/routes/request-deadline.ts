/**
 * The one deadline over a whole request, and the record of what it was waiting on when it fired.
 *
 * WHY (x57): on DeckGen 2026-10-03 two `GET /cards/search` requests were never answered — the edge
 * gave up on each after 100s (524). Both ran ~100.0s on 7.7ms and 2.8ms of CPU and made no
 * subrequest: they were waiting, before any engine call, on an await with no deadline (a tag-alias
 * read begun by a request that was then cancelled — shared-load.ts). The engine calls have
 * deadlines (remote-engine.ts ENGINE_CALL_DEADLINE_MS); the reads in front of them had none, and the
 * engine's own deadlines COMPOSE past the edge's patience as well: a pinned search that times out
 * (35s) falls back to the gather (35s), whose coordinator is replaced once (35s) — 105s.
 *
 * So the request as a whole gets one clock. When it runs out the client is answered 503, the same
 * retryable answer a store that is not loaded gets, and ONE line says what was still open:
 *
 *   request deadline: GET cards/search gave no answer within 40000ms; waiting on tag-aliases for
 *   39991ms; last finished: manifest; answering 503
 *
 * The work is not cancelled (nothing in a Worker can be); its answer, if one ever comes, is dropped.
 */

import { httpError } from "./http";
import { scryfallHttpError } from "./scryfall-compat/respond";

/**
 * Above ENGINE_CALL_DEADLINE_MS (35s), so one engine call that never answers still surfaces as its
 * own timeout, with its own log lines, before this fires — and far below the 100s at which the edge
 * answers 524 for us. Nothing healthy is near it: engine p999 is 1.1–2.6s, a cold region's wake 8.2s.
 */
export let REQUEST_DEADLINE_MS = 40_000;

/** For tests: shorten the request deadline. */
export function setRequestDeadlineForTests(ms: number): void {
	REQUEST_DEADLINE_MS = ms;
}

/** What a request is waiting on: every tracked call that has started and not settled. */
export class RequestStages {
	private readonly open = new Map<number, { label: string; since: number }>();
	private opened = 0;
	private last: string | null = null;

	/** Run `work` as the stage `label`: open from now until its promise settles either way. */
	track<T>(label: string, work: () => Promise<T>): Promise<T> {
		const id = this.opened++;
		this.open.set(id, { label, since: Date.now() });
		const close = () => {
			this.open.delete(id);
			this.last = label;
		};
		let running: Promise<T>;
		try {
			running = work();
		} catch (err) {
			close();
			throw err;
		}
		return running.then(
			(value) => {
				close();
				return value;
			},
			(err) => {
				close();
				throw err;
			},
		);
	}

	/**
	 * `engine` with every method call that returns a promise tracked as `engine.<method>`. Fields
	 * and getters read through to the engine itself, and `instanceof` still sees its class.
	 */
	watch<E extends object>(engine: E): E {
		return new Proxy(engine, {
			get: (target, prop) => {
				const value = Reflect.get(target, prop, target);
				if (typeof value !== "function" || typeof prop !== "string") return value;
				return (...args: unknown[]) => {
					const result: unknown = value.apply(target, args);
					return result instanceof Promise ? this.track(`engine.${prop}`, () => result) : result;
				};
			},
			// A route that writes a field writes the engine's own, not a shadow on the proxy.
			set: (target, prop, value) => Reflect.set(target, prop, value, target),
		});
	}

	/** The open stages, oldest first, and the last one to finish — for the deadline's log line. */
	describe(now: number = Date.now()): string {
		const waiting = [...this.open.values()]
			.sort((a, b) => a.since - b.since)
			.map((s) => `${s.label} for ${now - s.since}ms`);
		const on =
			waiting.length > 0 ? `waiting on ${waiting.join(", ")}` : "no tracked call open (the handler's own awaits)";
		return `${on}; last finished: ${this.last ?? "none"}`;
	}
}

/** The line the deadline logs. `route` is the route key and never the query: only its shape is logged anywhere. */
export function requestDeadlineLine(method: string, route: string, ms: number, stages: RequestStages): string {
	return `request deadline: ${method} ${route} gave no answer within ${ms}ms; ${stages.describe()}; answering 503`;
}

/**
 * `work`'s answer — or, once `ms` pass without one, `late()`'s. A failure of `work` inside the
 * window is the caller's, as before; one after it is dropped with the rest of the abandoned work.
 */
export function answerWithin<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<T>((resolve, reject) => {
		timer = setTimeout(() => {
			try {
				resolve(late());
			} catch (err) {
				reject(err);
			}
		}, ms);
	});
	work.catch(() => {});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** What the client is told. Wording of our own: Scryfall has no measured answer for this. */
export const REQUEST_DEADLINE_DETAILS = "The request could not be answered in time, please try again later.";

/**
 * Run a route's handler under the request deadline. `run` is handed the stages to track its
 * context's calls with; whatever it answers or throws inside the window is passed on untouched
 * (dispatch still maps a thrown Response, an EngineUnavailableError and everything else itself).
 *
 * Past the window the answer is a 503 in the surface's own error shape — Scryfall's error object on
 * `/cards/*`, `{title, description}` on upstream's — `no-cache` like every dispatch-level error: the
 * same retryable answer a store that is not loaded gets, so a client that retries reaches an
 * isolate, or a moment, that is not stuck. Nothing here retries on its behalf.
 */
export function answerInTime(
	route: { method: string; key: string; scryfallSurface: boolean },
	run: (stages: RequestStages) => Promise<Response> | Response,
	ms: number = REQUEST_DEADLINE_MS,
): Promise<Response> {
	const stages = new RequestStages();
	return answerWithin((async () => run(stages))(), ms, () => {
		console.error(requestDeadlineLine(route.method, route.key, ms, stages));
		return route.scryfallSurface
			? scryfallHttpError("service_unavailable", 503, REQUEST_DEADLINE_DETAILS)
			: httpError(503, "Service Unavailable", REQUEST_DEADLINE_DETAILS);
	});
}
