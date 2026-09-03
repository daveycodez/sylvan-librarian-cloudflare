// The public origin a response's absolute URLs address: upstream's
// `X-Proxy-Host` (api_resource.py:478) and the `x-forwarded-proto` beside it,
// honoured ONLY from a proxy the operator named.
//
// WHY THIS IS NOT JUST `request.headers.get(...)`, which is what it was:
//
// Upstream reads X-Proxy-Host unconditionally, and upstream is right to — it is
// a private VPS behind a reverse proxy it controls, so the only party that can
// set that header IS that proxy. This port is a public Worker on an open
// hostname, and it added something upstream does not have: an edge cache.
// `cache.enabled` is on in wrangler.jsonc, `/cards/*` answers
// `public, max-age=57600`, and the two headers below feed every absolute URL a
// card object carries — `uri`, `set_uri`, `set_search_uri`, `rulings_uri`,
// `prints_search_uri` (objects.ts) and a search's `next_page`.
//
// Neither header is part of the cache key. So ONE request carrying
// `X-Proxy-Host: evil.example` would seed a cache entry, keyed by a URL anyone
// can request, whose every link points off-host — served to everyone hitting
// that URL in that colo for the next sixteen hours. `x-forwarded-proto: http`
// is the same defect with a downgrade instead of a redirect: `next_page` comes
// back as plaintext http and a client that follows it has left TLS.
//
// `Vary` DOES NOT FIX THIS and should not be reached for: Cloudflare's cache
// does not vary on arbitrary request headers, so `Vary: X-Proxy-Host` would
// widen nothing while looking like a fix. The cache key is the URL, and neither
// header is in it. What fixes it is not trusting an unauthenticated header:
// with the value checked against a list the OPERATOR configured, a forged value
// is ignored and an honest one produces exactly what the real proxy produces,
// so there is no pair of requests that can disagree about a cache entry.
//
// The knob is `TRUSTED_PROXY_HOSTS`, comma-separated, matched exactly against
// the header (include the port when the proxy sends one). UNSET IS THE DEFAULT
// AND MEANS "no proxy in front of this deployment": both headers are ignored
// and the request's own URL decides, which is the correct answer for the
// workers.dev deployment this repo ships and for anything fronted directly by
// Cloudflare. Configuring it is how an operator who really has a rewriting
// proxy gets upstream's behaviour back.

import type { Env } from "../engine/types";

/** The two schemes `x-forwarded-proto` is allowed to name. */
const FORWARDABLE_SCHEMES = new Set(["http", "https"]);

/**
 * True when `host` is one the operator listed in TRUSTED_PROXY_HOSTS. Exact,
 * case-insensitive match on the whole `host:port` string — no suffix matching,
 * which is the classic way an allowlist lets `evil-example.com` through a rule
 * meant for `example.com`.
 */
function isTrustedProxyHost(env: Env, host: string): boolean {
	const configured = (env as { TRUSTED_PROXY_HOSTS?: string }).TRUSTED_PROXY_HOSTS;
	if (!configured) return false;
	const wanted = host.trim().toLowerCase();
	if (!wanted) return false;
	for (const entry of configured.split(",")) {
		const allowed = entry.trim().toLowerCase();
		if (allowed && allowed === wanted) return true;
	}
	return false;
}

/**
 * The host and scheme every absolute URL in this response should be built from.
 *
 * The scheme is coupled to the host deliberately: `x-forwarded-proto` is honoured
 * only on a request that ALSO presented an allowlisted `X-Proxy-Host`. A proxy
 * that rewrites the origin sends both (rewriting the host is why upstream reads
 * the header at all), and honouring the scheme on its own would leave the
 * downgrade vector open on every request — the weaker half of the same header
 * pair, with nothing authenticating it.
 */
export function resolveProxyOrigin(request: Request, env: Env, url: URL): { host: string; scheme: string } {
	const fallback = { host: url.host, scheme: url.protocol.replace(":", "") };
	const claimedHost = request.headers.get("X-Proxy-Host");
	if (!claimedHost || !isTrustedProxyHost(env, claimedHost)) return fallback;
	const claimedScheme = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
	return {
		host: claimedHost.trim(),
		scheme: claimedScheme && FORWARDABLE_SCHEMES.has(claimedScheme) ? claimedScheme : fallback.scheme,
	};
}
