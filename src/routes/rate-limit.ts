// Per-IP rate limiting for the engine-computing routes, with a trusted-key
// bypass for server-to-server callers (whose traffic funnels through shared
// egress IPs and must not be counted per-IP).
//
// A deliberate addition to the upstream mirror (see README deviations):
// upstream sits on a private VPS; this deployment is a public Worker any
// hobbyist can clone, so it ships with wallet protection by default. The
// limiter only ever runs on cache MISSES (Workers Cache answers hits before
// the Worker starts), so crowds of repeat queries never count against it.
//
// Counting lives in a PER-IP RateLimiter Durable Object (token-bucket
// pattern from Cloudflare's rules-of-durable-objects docs): one tiny
// instance per IP — globally exact, naturally sharded — created with a
// locationHint in the region the IP's traffic originates from.
//
// Enforcement is ASYNCHRONOUS, deliberately: awaiting the DO check measured
// ~70ms added per cache-miss request (a DO RPC is a regional hop, and per-IP
// wakes ran ~700ms). Instead the request is served immediately while the
// check reports in the background; when the DO rules an IP over-limit, this
// isolate caches a block-until timestamp and answers 429 from memory — zero
// added latency, enforcement within ~one round trip of a violation, a few
// dozen grace requests for a fresh burst. (The Workers rate-limiting
// *binding* was tried first and measured as barely enforcing at all.)

import { DurableObject } from "cloudflare:workers";
import { regionHint } from "../engine/region";
import type { Env } from "../engine/types";

/**
 * Default allowance when RATE_LIMIT_PER_10S is unset: generous for many people
 * behind one shared IP, a wall for scripts.
 *
 * 25 per 10s, not the 100 it used to be, because enforcement is asynchronous
 * and therefore LOOSE: requests are served while the verdict is still in
 * flight, so the effective ceiling measured against production on 2026-08-09
 * was ~2x the configured one (a 10/s setting passed 20.5/s in steady state).
 * 25 lands near 5 requests per second in practice.
 *
 * That is half of what Scryfall — the API this mirrors — asks of its own
 * consumers: they request sustained traffic stay under 10/s, 50-100ms between
 * calls, and 429 anyone who ignores it. Half their ceiling is a defensible
 * place for a mirror, and it is still far above any human, who produces a
 * query every few seconds at most and whose repeats never reach the limiter
 * at all (it only sees cache MISSES).
 *
 * It matters most on a free-plan deployment, where the daily request budget is
 * shared ACCOUNT-WIDE: one unthrottled client can spend everyone's allowance
 * and take the site down for the rest of the UTC day. A rate cap only shapes
 * bursts and cannot fully prevent that — a per-IP DAILY budget would — but it
 * moves the time-to-exhaust from minutes to hours.
 */
const DEFAULT_LIMIT_PER_10S = 25;
const PERIOD_SECONDS = 10;

/**
 * Per-IP limiter: one continuously-refilling token bucket, in memory.
 * Eviction resets it (full allowance) — same trade as the docs example,
 * fine for burst damping.
 */
export class RateLimiter extends DurableObject<Env> {
	private tokens = Number.NaN; // NaN = uninitialized (capacity set on first check)
	private lastRefillMs = 0;

	/** Returns true when the request is allowed. */
	async check(limit: number): Promise<boolean> {
		const now = Date.now();
		if (Number.isNaN(this.tokens)) {
			this.tokens = limit;
			this.lastRefillMs = now;
		}
		const refillPerMs = limit / (PERIOD_SECONDS * 1000);
		this.tokens = Math.min(limit, this.tokens + (now - this.lastRefillMs) * refillPerMs);
		this.lastRefillMs = now;
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}
}

/** Routes whose handlers run the engine; everything else is never limited. */
export function isRateLimitedRoute(routeKey: string, params: Record<string, string>): boolean {
	if (routeKey === "search" || routeKey === "random_search") return true;
	// Every Scryfall-compatible route runs the engine, and most of them build card objects on top
	// of it -- `cards/collection` resolves up to 75 in one request and `cards/named` scans the name
	// vocabulary. A route that computes and is absent here does not get a smaller share of the
	// limiter; it bypasses the limiter entirely, which is why this list is enumerated rather than
	// inferred from the route table.
	if (routeKey === "cards" || routeKey.startsWith("cards/")) return true;
	// The SSR root only computes when a query is embedded.
	return routeKey === "_root" && Boolean(params.q || params.query);
}

/**
 * True when TRUSTED_API_KEY is configured and the request presents it.
 * Unset secret (the default) = no bypass surface at all. Timing-safe compare
 * so the key cannot be probed byte-by-byte through response timing.
 */
export async function isTrustedRequest(env: Env, request: Request): Promise<boolean> {
	const secret = (env as { TRUSTED_API_KEY?: string }).TRUSTED_API_KEY;
	if (!secret) return false;
	const presented = request.headers.get("X-API-Key");
	if (!presented) return false;
	const enc = new TextEncoder();
	const a = enc.encode(secret);
	const b = enc.encode(presented);
	if (a.byteLength !== b.byteLength) return false;
	return crypto.subtle.timingSafeEqual(a, b);
}

/** Per-isolate cache of DO verdicts: ip -> blocked-until epoch ms. */
const blockedUntil = new Map<string, number>();
/**
 * How long a 429'd address stays blocked in this isolate.
 *
 * Deliberately LONGER than the refill window, which it used to equal. Async
 * enforcement leaks one round trip of traffic per isolate per block cycle: when
 * a block lapses the isolate serves optimistically until a fresh refusal lands,
 * and with the verdict ~130ms behind at 8 concurrent that measured ~11 requests
 * per isolate, ~105 across the ~10 isolates involved. Against 100 tokens per
 * 10s that is where the overshoot comes from — measured against production on
 * 2026-08-09 at 20.5/s steady state for a configured 10/s, a visible sawtooth
 * on the cycle period.
 *
 * The grace is paid per CYCLE, so lengthening the block dilutes it: tokens
 * accrue at the configured rate throughout while the leak is paid once. 30s
 * models to ~1.35x where 10s measured 2.05x. It cannot reach 1.0x — only
 * lease-based counting, where an isolate serves solely from a batch the DO
 * already granted, removes the leak outright, and that is a rewrite this does
 * not need.
 *
 * The cost is lockout duration for anything that does trip it. That is
 * acceptable because only cache MISSES reach the limiter, and /search sits
 * behind a 90s edge cache with a day of stale-while-revalidate — so sustaining
 * this many DISTINCT searches is a script, not a person reading card results.
 */
const BLOCK_MS = 30_000;

/**
 * Ceiling on the verdict cache, because the only other eviction is an IP
 * coming BACK after its block expired (see enforceRateLimit). An address that
 * gets blocked and never returns leaves its entry forever, so a distributed
 * source — precisely the case this limiter exists for — grows the map without
 * bound in a 128MB isolate. 10k entries is roughly a megabyte and far above
 * any legitimate count of simultaneously-blocked addresses.
 */
const MAX_BLOCKED_ENTRIES = 10_000;

/**
 * Record a block, keeping the cache bounded and in expiry order.
 *
 * Every entry is written with the same BLOCK_MS, so insertion order IS expiry
 * order — which makes the oldest entry the soonest to expire and therefore the
 * right one to drop. Map.set on an existing key would leave that key in its
 * original position and break the invariant, so a re-block deletes first.
 */
function rememberBlock(ip: string, until: number): void {
	blockedUntil.delete(ip);
	if (blockedUntil.size >= MAX_BLOCKED_ENTRIES) {
		const now = Date.now();
		for (const [addr, expiry] of blockedUntil) {
			if (expiry <= now) blockedUntil.delete(addr);
		}
		// Still at the cap means every entry is live; drop from the front,
		// which is the closest to expiring anyway.
		while (blockedUntil.size >= MAX_BLOCKED_ENTRIES) {
			const oldest = blockedUntil.keys().next();
			if (oldest.done) break;
			blockedUntil.delete(oldest.value);
		}
	}
	blockedUntil.set(ip, until);
}

/**
 * Enforce the per-IP limit — without awaiting the DO. The local verdict
 * cache answers instantly; the regional DO check runs via waitUntil and
 * blocks the IP from the NEXT request onward when it rules over-limit.
 * RATE_LIMIT_ENABLED="true" opts in (unset = off); RATE_LIMIT_PER_10S tunes
 * the allowance — both runtime vars, changeable without a redeploy.
 */
export function enforceRateLimit(
	env: Env,
	request: Request,
	waitUntil: (p: Promise<unknown>) => void,
): { outcome: "off" | "allowed" | "limited"; response: Response | null } {
	const cfg = env as { RATE_LIMIT_ENABLED?: string; RATE_LIMIT_PER_10S?: string };
	// Opt-in: enforcement only when RATE_LIMIT_ENABLED=true is set (env var /
	// dashboard). Unset = off — a clone does nothing surprising by default.
	if (cfg.RATE_LIMIT_ENABLED !== "true") return { outcome: "off", response: null };
	const limit = Math.max(1, Number.parseInt(cfg.RATE_LIMIT_PER_10S ?? "", 10) || DEFAULT_LIMIT_PER_10S);

	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const now = Date.now();
	const until = blockedUntil.get(ip);
	if (until !== undefined && now < until) {
		return {
			outcome: "limited",
			response: new Response(
				JSON.stringify({
					title: "Too Many Requests",
					description: "Rate limit exceeded for this address; retry shortly.",
				}),
				{
					status: 429,
					// Derived, not written twice: a Retry-After that undershoots
					// BLOCK_MS tells a well-behaved client to come back while it
					// is still blocked, which reads to it as the limiter lying.
					headers: { "content-type": "application/json", "Retry-After": String(Math.ceil(BLOCK_MS / 1000)) },
				},
			),
		};
	}
	if (until !== undefined) blockedUntil.delete(ip);

	// Background verdict: never on the request path. Errors are logged, not
	// thrown — a broken limiter must not break search. Per-IP instance,
	// placed (on first creation) in the region the IP's traffic comes from.
	const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip), { locationHint: regionHint(request) });
	waitUntil(
		stub
			.check(limit)
			.then((allowed) => {
				if (!allowed) rememberBlock(ip, Date.now() + BLOCK_MS);
			})
			.catch((err) => {
				console.warn(`Rate-limit check failed (fail open): ${err}`);
			}),
	);
	return { outcome: "allowed", response: null };
}
