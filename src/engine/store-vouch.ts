/**
 * The caller vouches for the store a waking engine object is about to load, so the wake needs no
 * KV read of its own.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * A cold object starts from the manifest it was last TOLD is live (the record `notifyPublish`
 * writes), and before loading it checked that record against KV's manifest — one metered `get` per
 * wake (store.ts `loadStore`; the check exists because a deploy publishes without notifying, and
 * loading a stale record cost a double load and an isolate reset loop on 2026-09-18). Objects idle
 * out after ~10 s, so that was one KV read per wake: 32,177 of DeckGen's 70,774 KV reads on
 * 2026-11-16, counted off the `store loaded from` lines.
 *
 * Every call that wakes an object comes from a router that is itself pinned to a manifest it read
 * through the same KV key moments ago (partitioned-engine.ts `livePartitionedManifest`). So the
 * router says which build that is, and an object whose record names THE SAME build loads it at
 * once. Any disagreement — no vouch, another build, a record this code cannot serve — is the KV
 * check exactly as before, so a stale record is still never loaded on its own word.
 *
 * FRESHNESS. KV's answer to the object was at most its cacheTtl old (60 s). The router's manifest
 * is that plus its colo-cache entry (60 s) plus its isolate memo (60 s): up to three minutes. The
 * record is only wrong after a publish nobody notified this object of, so the cost is that for up
 * to three minutes after such a publish (one, before) a wake may load the previous build. The
 * gather's generation pin and the next wake correct it, as they did within the first minute.
 *
 * ── HOW IT TRAVELS ───────────────────────────────────────────────────────────
 *
 * Router → object: in the FRACTION of the shard width every instrumented call already carries
 * (`reportedShards`). The width is a small integer and an object reads it through
 * `foldWidthAnnouncement`, which floors it — so an object on the build before this one sees the
 * width it always saw, and a router before this one sends no fraction, which reads as "no vouch".
 * A deploy replaces Workers and objects separately; twenty RPC signatures with their own trailing
 * optionals could not all grow an argument that pairs both ways, and this needs none.
 * `built_at` is epoch seconds, under 2^32, so `width + built_at / 2^32` is exact in a double (the
 * fraction is dyadic, 32 bits; a width has at most a handful) and survives JSON.
 *
 * Coordinator → sibling: in `EngineSearchOptions.vouchedBuild`, carried opaquely like `namesBuild`.
 * A gather's coordinator passes on what ITS caller vouched, never its own record: the vouch is
 * worth something only because it comes from outside the objects.
 */

const FRACTION = 2 ** 32;

/** `built_at` as the integer a rider can carry, or null when it is not epoch seconds under 2^32. */
function ridable(builtAt: unknown): number | null {
	if (typeof builtAt !== "string" && typeof builtAt !== "number") return null;
	const text = String(builtAt);
	if (!/^[1-9]\d{0,9}$/.test(text)) return null;
	const n = Number(text);
	return n < FRACTION ? n : null;
}

/**
 * The shard width to report, carrying `builtAt` when it can. No vouch leaves the width untouched —
 * `undefined` included, which an object reads as 1; with one, an absent width IS that 1.
 */
export function vouchingWidth(width: number | undefined, builtAt: unknown): number | undefined {
	const build = ridable(builtAt);
	if (build === null) return width;
	const whole = width !== undefined && Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
	return whole + build / FRACTION;
}

/** The build a reported width vouches for, as the manifest spells `built_at`, or undefined. */
export function vouchedBuildOf(reported: unknown): string | undefined {
	if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 1) return undefined;
	const fraction = reported - Math.floor(reported);
	if (fraction === 0) return undefined;
	const build = Math.round(fraction * FRACTION);
	return build > 0 && build < FRACTION ? String(build) : undefined;
}
