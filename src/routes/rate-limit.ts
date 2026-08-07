// Per-IP rate limiting for the engine-computing routes, with a trusted-key
// bypass for server-to-server callers (whose traffic funnels through shared
// egress IPs and must not be counted per-IP).
//
// A deliberate addition to the upstream mirror (see README deviations):
// upstream sits on a private VPS; this deployment is a public Worker any
// hobbyist can clone, so it ships with wallet protection by default. The
// limiter only ever runs on cache MISSES (Workers Cache answers hits before
// the Worker starts), so crowds of repeat queries never count against it.

import type { Env } from "../engine/types";

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

/**
 * Enforce the per-IP limit. Returns the outcome (surfaced in a diagnostic
 * response header) and the 429 response when limited. Binding absent (older
 * local simulators) = fail open: availability over throttling for a
 * protection feature.
 */
export async function enforceRateLimit(
	env: Env,
	request: Request,
): Promise<{ outcome: "absent" | "allowed" | "limited"; response: Response | null }> {
	const limiter = (env as { SEARCH_RATE_LIMITER?: RateLimit }).SEARCH_RATE_LIMITER;
	if (!limiter) return { outcome: "absent", response: null };
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const { success } = await limiter.limit({ key: ip });
	if (success) return { outcome: "allowed", response: null };
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
