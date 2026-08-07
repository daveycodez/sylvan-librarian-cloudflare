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

/** Default allowance when RATE_LIMIT_PER_10S is unset: generous for many
 * people behind one shared IP, a wall for scripts. */
const DEFAULT_LIMIT_PER_10S = 100;
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
	const presented = request.headers.get("x-sylvan-api-key");
	if (!presented) return false;
	const enc = new TextEncoder();
	const a = enc.encode(secret);
	const b = enc.encode(presented);
	if (a.byteLength !== b.byteLength) return false;
	return crypto.subtle.timingSafeEqual(a, b);
}

/** Per-isolate cache of DO verdicts: ip -> blocked-until epoch ms. */
const blockedUntil = new Map<string, number>();
/** A 429'd IP stays blocked in this isolate for one full refill window. */
const BLOCK_MS = PERIOD_SECONDS * 1000;

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
					headers: { "content-type": "application/json", "Retry-After": "10" },
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
				if (!allowed) blockedUntil.set(ip, Date.now() + BLOCK_MS);
			})
			.catch((err) => {
				console.warn(`Rate-limit check failed (fail open): ${err}`);
			}),
	);
	return { outcome: "allowed", response: null };
}
