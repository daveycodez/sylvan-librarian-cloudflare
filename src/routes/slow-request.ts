/**
 * The one line a SLOW request leaves in sylvan's own logs.
 *
 * WHY: invocation logs are off (wrangler.jsonc), so a request that answers slowly and logs nothing
 * of its own is invisible here — it shows only as a wall-time quantile in GraphQL, with no route and
 * no reason. On DeckGen 2026-10-23 15:20–16:15 UTC mtgseeker timed out ~25 times at 8s on
 * `/catalog/ability-words`, `/cards/:id/rulings` and `/cards/:set/:num`, and sylvan's logs held
 * nothing for any of them. Every request that takes SLOW_REQUEST_MS or longer now logs:
 *
 *   slow request: GET catalog 8123ms -> 200; kv.reference 8101ms; isolate 3f9a1c req #1 (cold)
 *
 * — the route KEY (never the path or the query), the time to the Response, its status, where the
 * time went (the RequestStages dispatch tracked: the manifest read, the alias read, every engine
 * call, and the KV reads of the KV-only routes), and whether the isolate was cold. Only slow
 * requests log, so the volume is the slow tail and nothing else.
 *
 * WHAT IT CANNOT SEE, and what that absence means. Those 2026-10-23 timeouts never ran this code:
 * GraphQL `workersInvocationsAdaptive` has each one as an invocation with cpuTimeUs = 0, memory 0,
 * no subrequest and no response, ending when the client gave up (7.97–8.0s, then 5.7–5.8s for the
 * retry) — while the cheapest ANSWERED request in the same minutes used 408us of CPU. 31 of them
 * between 15:20 and 16:16, in IAD/EWR/MIA/BOS/GRU only (4 on all of 10-22), during Cloudflare's
 * "Network connectivity issues affecting services in North America" (Ashburn–Atlanta packet loss,
 * posted 15:47). A request that hangs before the fetch
 * handler starts cannot be logged by the handler; this line exists so that a slow request that DID
 * run is never mistaken for one of those, and one that did not is recognisable by its absence.
 *
 * THE CLOCK. In workerd `Date.now()` advances only across I/O, so the milliseconds here are time
 * spent waiting — on KV, the Cache API, an engine RPC — and never synchronous CPU, which is the
 * invocation's `cpuTimeMs`. A request slowed by computation alone shows a short time here.
 */

import type { RequestStages } from "./request-deadline";

/** At or past this, a request is slow and logs. Healthy p99 for every route is far under it. */
export let SLOW_REQUEST_MS = 1_000;

/** For tests: change the threshold. */
export function setSlowRequestMsForTests(ms: number): void {
	SLOW_REQUEST_MS = ms;
}

/**
 * This isolate, as the slow line names it: an id to group its lines by (several slow requests from
 * one stuck isolate read differently from several isolates each slow once), and how many requests
 * it has started. The id is drawn at the FIRST REQUEST, not at module scope, where workerd refuses
 * to generate random values.
 */
const isolate = { id: "", requests: 0, firstAt: 0 };

/** Test hook: a fresh isolate. */
export function resetIsolateForTests(): void {
	isolate.id = "";
	isolate.requests = 0;
	isolate.firstAt = 0;
}

/** What the slow line needs from a request's start. */
export interface RequestStart {
	/** When the handler began, by the isolate clock. */
	at: number;
	/** This request's number in the isolate, 1-based. */
	isolateRequest: number;
	/** The isolate's first request: a cold isolate (module just evaluated, nothing memoised). */
	cold: boolean;
	isolateId: string;
	/** How long ago this isolate began its first request. */
	isolateAgeMs: number;
}

/** Count a request against this isolate and note when it began. Call first thing in `fetch`. */
export function noteRequestStart(now: number = Date.now()): RequestStart {
	if (isolate.id === "") {
		const bytes = new Uint8Array(3);
		crypto.getRandomValues(bytes);
		isolate.id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
		isolate.firstAt = now;
	}
	isolate.requests += 1;
	return {
		at: now,
		isolateRequest: isolate.requests,
		cold: isolate.requests === 1,
		isolateId: isolate.id,
		isolateAgeMs: now - isolate.firstAt,
	};
}

export interface FinishedRequest {
	method: string;
	/** The route key (`catalog`, `cards`, `cards/search`), or `-` for a path that resolved to none. */
	route: string;
	ms: number;
	status: number;
	stages: RequestStages | null;
	start: RequestStart;
	/** `x-sylvan-engine`'s value, when an engine answered. */
	engine?: string;
}

/** The slow line. Pure, for the tests. Names the route key only: no path, no query, no client. */
export function slowRequestLine(r: FinishedRequest): string {
	const spent = r.stages?.spent(r.start.at + r.ms) ?? "";
	const age = r.start.cold ? "(cold)" : `(warm, ${Math.round(r.start.isolateAgeMs / 1000)}s old)`;
	return (
		`slow request: ${r.method} ${r.route} ${r.ms}ms -> ${r.status}; ` +
		`${spent || "no tracked stage (the handler's own awaits)"}; ` +
		`isolate ${r.start.isolateId} req #${r.start.isolateRequest} ${age}` +
		(r.engine ? `; engine ${r.engine}` : "")
	);
}

/** Log the slow line when `r` took SLOW_REQUEST_MS or longer; nothing otherwise. */
export function reportIfSlow(r: FinishedRequest): void {
	if (r.ms < SLOW_REQUEST_MS) return;
	console.warn(slowRequestLine(r));
}
