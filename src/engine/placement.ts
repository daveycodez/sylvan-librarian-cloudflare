// Where an engine Durable Object physically IS — self-reported, because nothing
// else will report it.
//
// `locationHint` decides an object's region at creation and is never applied
// again (see engine-namespace.ts). There is no API that reads a Durable Object's
// location back, so "is engine-wnam actually in western North America?" has
// exactly one direct answer available to us: ask the object to look.
//
// It looks by fetching Cloudflare's own trace endpoint, which every colo answers
// locally with the colo that answered. The reply's `colo=` is the IATA code of
// the machine the DO is running on. Its `loc=` is NOT the object's country: it is
// the country the request is attributed to, which follows the request that woke
// the object — measured 2026-09-23 on DeckGen, engine-weur-p1 answered colo=AMS
// every time and loc= GB, FR, DE, BE, IT, NL, ES, NO and PT across one day's
// wakes, and every engine-sam-* object answered colo=EWR with loc= BR, AR, PE, VE,
// CO, CL, UY. Read `colo` for placement; `loc` is logged only because it is free,
// and says who was asking. Paired with the object's own name, one line settles it:
//
//   [engine-wnam] placement: colo=SJC loc=US
//
// The verdict against `engine-<region>` is deliberately left to the reader
// rather than computed here. It needs a colo→region table, Cloudflare adds colos
// continuously, and a table that silently rots would answer "correct" for an
// object that had moved. What is here instead is the raw pair, plus the isolate
// side of the join: `remote-engine.ts` logs the colo of the isolate that CALLED,
// under the region it routed to. Real traffic therefore builds the mapping
// itself — the colos that appear in `[wnam@…]` lines are, by definition, the
// colos wnam traffic arrives at — and engine-wnam's own colo either sits among
// them or does not. ENGINE-PLACEMENT.md walks that query.
//
// COST, and why this is once per OBJECT per PLACEMENT_FRESH_MS:
//
//   - One subrequest per probe. The throttle used to be module state, i.e. per
//     ISOLATE, and an idle object hibernates after ~10s and wakes in a fresh one —
//     so every reload probed: 10,446 probes on DeckGen on 2026-09-23 (342 on the
//     free account) for an answer that changes only if the object moves. It is
//     now remembered in the object's own storage (store-cache.ts `placement`),
//     like announceSelfOnce, at one row written per probe.
//   - An outbound fetch does NOT keep the object alive. What held objects open
//     was the probe's own uncancellable timer (see PROBE_TIMEOUT_MS), not the
//     connection; with the timer cancelled a probe costs its round trip.
//   - Still never on the request path: the callers are the cold store load and
//     the publish prepare/notify, and the work is parked on waitUntil.

import { type ArchiveCacheStorage, lastPlacement, type PlacementRecord, recordPlacement } from "./store-cache";

/** Cloudflare's trace endpoint: every colo answers it locally, naming itself. */
export const PLACEMENT_TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/**
 * How long a measured placement stands before this object measures again.
 *
 * Just under a day, so that the nightly publish — the one recurring moment every warm object is
 * called anyway — finds the record stale and re-measures, and a placement line is never more than
 * about a night old for an object that is in use. A cold load inside the window reads the record
 * and does nothing, which is the whole saving.
 */
export const PLACEMENT_FRESH_MS = 20 * 60 * 60 * 1000;

/**
 * Floor on how often ONE isolate will probe ONE label, whatever storage says.
 *
 * The backstop for the case storage cannot cover: a probe that FAILS records nothing, so without
 * this a trace endpoint that is down would be retried on every wake that shares an isolate. Keyed
 * by label because several partition objects can share an isolate, and a single module-wide slot
 * let one object's probe suppress its neighbours'. Also the only throttle a context without
 * storage has (the store loader outside a Durable Object).
 */
export const PROBE_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long to wait for the trace before giving up. Nothing depends on the
 * answer, so a hung probe must not hold the object open.
 *
 * ARMED ON A CONTROLLER THAT IS CANCELLED, not on `AbortSignal.timeout`, which
 * gives no handle to cancel. That timer stays pending in the object's I/O
 * context after the trace has answered, and the invocation cannot close until
 * it fires — so this budget was not a ceiling on a hung probe, it was a floor
 * on EVERY cold load. Production, request f7f1321e (2026-08-12T23:36 PDT): the
 * store loaded from local cache at t+669ms, the trace answered at t+690ms, and
 * the invocation ended at t+5669ms — 5000ms after the probe was armed, to the
 * millisecond, with 557ms of CPU spent and nothing logged in the gap.
 *
 * Nobody waited on it: the RPC returns when the method returns, and this runs
 * under `waitUntil`. What it cost was ~0.64 GB-s of Durable Object duration per
 * wake, and the readability of the one trace that shows a cold load — every one
 * of them measured 5.7s whatever it had actually done.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/** What a probe needs from its caller: somewhere to park the work, who to name
 * in the log, and — inside a Durable Object — where to remember the answer.
 * Structurally the useful half of LoadContext. */
export interface PlacementContext {
	waitUntil(p: Promise<unknown>): void;
	label?: string;
	storage?: ArchiveCacheStorage;
}

/** Trace body → its fields. `colo` and `loc` are the two that matter; the rest
 * (ip, uag, tls, …) are dropped rather than logged. */
export function parseTrace(body: string): { colo?: string; loc?: string } {
	const out: { colo?: string; loc?: string } = {};
	for (const line of body.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1).trim();
		if (key === "colo") out.colo = value;
		else if (key === "loc") out.loc = value;
	}
	return out;
}

/** The one line this whole module exists to emit. */
export function placementLine(label: string, trace: { colo?: string; loc?: string }): string {
	return `[${label}] placement: colo=${trace.colo ?? "?"} loc=${trace.loc ?? "?"}`;
}

/** Per label: the last probe this isolate started, and whether one is running.
 * Module state, so per isolate — the failed-probe backstop only; a success is
 * remembered in the object's storage. */
const slots = new Map<string, { lastProbeAt: number; probing: boolean }>();

/** Claim the right to probe `label` now, or decline. Exported so the throttle is
 * testable without a network. */
export function takeProbeSlot(label: string, now: number): boolean {
	const slot = slots.get(label);
	if (slot?.probing) return false;
	if (slot && now - slot.lastProbeAt < PROBE_MIN_INTERVAL_MS) return false;
	slots.set(label, { lastProbeAt: now, probing: true });
	return true;
}

function releaseProbeSlot(label: string): void {
	const slot = slots.get(label);
	if (slot) slot.probing = false;
}

/** Whether this object's stored placement is still fresh, i.e. nothing to do. */
export function placementIsFresh(storage: ArchiveCacheStorage | undefined, now: number): boolean {
	if (!storage) return false;
	const last = lastPlacement(storage);
	return last !== null && now - last.at < PLACEMENT_FRESH_MS;
}

/**
 * Ask this object where it is, log the answer, and remember it — at most once per
 * PLACEMENT_FRESH_MS per object. Fire-and-forget: the work is parked on waitUntil
 * and it never throws or rejects. The returned promise resolves with what was
 * recorded (null when skipped or failed), for a caller that wants to wait — e.g.
 * a publish ack carrying a fresh placement.
 *
 * Call sites must be off the request path — a cold store load, a publish notify.
 * See the cost note at the top of this file.
 */
export function probePlacement(ctx: PlacementContext, fetcher: typeof fetch = fetch): Promise<PlacementRecord | null> {
	const label = ctx.label;
	// No label means this is not running inside a Durable Object (the store
	// loader is isolate-global and is used from tests and tooling too), and an
	// unattributed colo answers nothing worth the request.
	if (!label) return Promise.resolve(null);
	const now = Date.now();
	// The saving: one SELECT on the object's own SQLite in place of a subrequest.
	if (placementIsFresh(ctx.storage, now)) return Promise.resolve(null);
	if (!takeProbeSlot(label, now)) return Promise.resolve(null);
	// See PROBE_TIMEOUT_MS: the deadline has to be cancellable, so it is a plain
	// timer on a controller rather than `AbortSignal.timeout`. Cleared in the
	// `finally` below, which runs on every outcome — answered, failed, or timed
	// out — so the only thing that ever holds the invocation is the fetch itself.
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error(`no trace within ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
	const done = fetcher(PLACEMENT_TRACE_URL, { signal: deadline.signal })
		.then((res) => res.text())
		.then((body): PlacementRecord | null => {
			const trace = parseTrace(body);
			console.log(placementLine(label, trace));
			// A trace without a colo measured nothing: log it, record nothing.
			if (!trace.colo) return null;
			const record = { colo: trace.colo, at: now };
			if (ctx.storage) {
				try {
					recordPlacement(ctx.storage, record);
				} catch (err) {
					// Unrecorded means the next wake past PROBE_MIN_INTERVAL_MS measures again.
					console.warn(`[${label}] could not record its placement locally: ${err}`);
				}
			}
			return record;
		})
		.catch((err) => {
			// A failed probe is a missing diagnostic, never an incident: warn and
			// let a later load try again (PROBE_MIN_INTERVAL_MS paces the retries).
			console.warn(`[${label}] could not determine its placement: ${err}`);
			return null;
		})
		.finally(() => {
			clearTimeout(timer);
			releaseProbeSlot(label);
		});
	ctx.waitUntil(done);
	return done;
}
