// g1's nightly probe: where does an object created with each location hint land TONIGHT?
//
// The answer that matters is "on the hint's own continent or not" (placement-policy.ts), and the
// only way to learn it is to create an object with the hint and ask it where it is. That cannot be
// an engine object: creating one fixes its region forever (engine-namespace.ts), and every engine
// object must be created by a real request at the edge. So the probe is its OWN class, created with
// `newUniqueId()` — a name nobody will ever address again — and it NEVER touches storage: an object
// that stores nothing ceases to exist when it goes idle, so there is nothing to release, no
// deleteAll (which would itself be a write), and no pool used. One request per probe, four probes
// per hint, eleven hints: 44 Durable Object requests a night per account.
//
// The coordinator creating the probes is itself a Durable Object, and whether a hinted object
// created from INSIDE one lands like one created at the edge is not something anything in-house
// has measured (report 28). That is why the policy's first-run gate refuses to change anything on a
// night when a served hint's probes land off their continent.

import { DurableObject } from "cloudflare:workers";
import { PLACEMENT_TRACE_URL, PROBE_TIMEOUT_MS, parseTrace } from "./placement";
import type { Hint } from "./placement-policy";

/** Probes per hint per night: enough to see a hint's spawn pool, cheap enough to run every night. */
export const PROBES_PER_HINT = 4;

/** How long the coordinator waits for one probe's answer before counting it as unanswered. */
export const PROBE_ANSWER_MS = 15_000;

export class PlacementProbe extends DurableObject<Env> {
	/**
	 * The colo this object is running in, from Cloudflare's own trace endpoint, or null. Never
	 * throws, never writes storage. The deadline is a cancellable timer for the reason placement.ts
	 * gives: an uncancelled one holds the object open until it fires.
	 */
	async where(): Promise<{ colo: string | null }> {
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(new Error("no trace")), PROBE_TIMEOUT_MS);
		try {
			const res = await fetch(PLACEMENT_TRACE_URL, { signal: deadline.signal });
			return { colo: parseTrace(await res.text()).colo ?? null };
		} catch {
			return { colo: null };
		} finally {
			clearTimeout(timer);
		}
	}
}

/** The binding, when this deployment has it (a config that predates g1 simply probes nothing). */
type ProbeNamespace = {
	newUniqueId(): DurableObjectId;
	get(
		id: DurableObjectId,
		options?: { locationHint?: DurableObjectLocationHint },
	): { where(): Promise<{ colo: string | null }> };
};

/**
 * Create `perHint` probe objects with each hint and collect the colos they report. Bounded: every
 * probe is raced against PROBE_ANSWER_MS, and an unanswered probe is simply absent from its hint's
 * list (an empty list is a hint the policy leaves untouched tonight).
 */
export async function probeHints(
	env: { PLACEMENT_PROBE?: unknown },
	hints: readonly Hint[],
	perHint = PROBES_PER_HINT,
	answerMs = PROBE_ANSWER_MS,
): Promise<Partial<Record<Hint, string[]>>> {
	const ns = env.PLACEMENT_PROBE as ProbeNamespace | undefined;
	const out: Partial<Record<Hint, string[]>> = {};
	if (!ns) return out;
	await Promise.all(
		hints.flatMap((hint) =>
			Array.from({ length: perHint }, async () => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const late = new Promise<null>((resolve) => {
					timer = setTimeout(() => resolve(null), answerMs);
				});
				try {
					const stub = ns.get(ns.newUniqueId(), { locationHint: hint });
					const answer = await Promise.race([stub.where().then((r) => r.colo), late]);
					if (answer) out[hint] = [...(out[hint] ?? []), answer];
				} catch {
					// An unanswered probe is data too: its absence. Nothing to retry tonight.
				} finally {
					clearTimeout(timer);
				}
			}),
		),
	);
	return out;
}
