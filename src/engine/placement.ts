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
// the machine the DO is running on and `loc=` is that machine's country. Paired
// with the object's own name, one log line settles it:
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
// COST, which is the reason this is not simply always on:
//
//   - An outbound request keeps a Durable Object from being evicted for as long
//     as the connection is pooled — up to ~15 minutes — and a DO is billed for
//     duration while it is alive. On the free plan's 128MB objects that is
//     ~115 GB-s against 13,000 GB-s/day, so it is affordable at this frequency
//     and ruinous at request frequency.
//   - So: never on the request path. This is called from the cold store load and
//     from the nightly publish notify, both of which are rare and already doing
//     far more I/O than one 200-byte GET. The throttle below is the backstop.

/** Cloudflare's trace endpoint: every colo answers it locally, naming itself. */
export const PLACEMENT_TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/**
 * Floor on how often ONE isolate will probe.
 *
 * The callers are rare by construction, so this exists to bound the pathological
 * case rather than the normal one: a region that thrashes — loads, evicts, loads
 * again — would otherwise pay the eviction hold on every wake and never be
 * allowed to go idle at all.
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

/** What a probe needs from its caller: somewhere to park the work, and who to
 * name in the log. Structurally the useful half of DurableObjectState. */
export interface PlacementContext {
	waitUntil(p: Promise<unknown>): void;
	label?: string;
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

/** Last probe this isolate started, and whether one is still running. Module
 * state, so it is per isolate — which is the right grain: a fresh isolate is
 * exactly the case worth re-measuring. */
let lastProbeAt = 0;
let probing = false;

/** Claim the right to probe now, or decline. Exported so the throttle is
 * testable without a network. */
export function takeProbeSlot(now: number): boolean {
	if (probing) return false;
	if (lastProbeAt !== 0 && now - lastProbeAt < PROBE_MIN_INTERVAL_MS) return false;
	lastProbeAt = now;
	probing = true;
	return true;
}

/**
 * Ask this object where it is, and log the answer. Fire-and-forget: it returns
 * before anything has been fetched, and it never throws.
 *
 * Call sites must be off the request path — a cold store load, a publish notify.
 * See the cost note at the top of this file.
 */
export function probePlacement(ctx: PlacementContext, fetcher: typeof fetch = fetch): void {
	const label = ctx.label;
	// No label means this is not running inside a Durable Object (the store
	// loader is isolate-global and is used from tests and tooling too), and an
	// unattributed colo answers nothing worth the request.
	if (!label) return;
	if (!takeProbeSlot(Date.now())) return;
	// See PROBE_TIMEOUT_MS: the deadline has to be cancellable, so it is a plain
	// timer on a controller rather than `AbortSignal.timeout`. Cleared in the
	// `finally` below, which runs on every outcome — answered, failed, or timed
	// out — so the only thing that ever holds the invocation is the fetch itself.
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error(`no trace within ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
	ctx.waitUntil(
		fetcher(PLACEMENT_TRACE_URL, { signal: deadline.signal })
			.then((res) => res.text())
			.then((body) => {
				console.log(placementLine(label, parseTrace(body)));
			})
			.catch((err) => {
				// A failed probe is a missing diagnostic, never an incident: warn and
				// let the next cold load try again.
				console.warn(`[${label}] could not determine its placement: ${err}`);
			})
			.finally(() => {
				clearTimeout(timer);
				probing = false;
			}),
	);
}
