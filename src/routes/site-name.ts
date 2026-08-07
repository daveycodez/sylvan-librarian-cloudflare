// Port of hostname_to_site_name (api_resource.py:153-232): derive the display
// name shown in page chrome from the Host (or X-Proxy-Host) header.
//
// Upstream additionally splits a run-together name into dictionary words when
// /usr/share/dict is available; that step is data-dependent and self-disabling
// (an empty word set skips it), and a Worker has no system dictionary, so this
// port always takes the no-dictionary path.

export const FALLBACK_SITE_NAME = "MTG Search";

// Deliberate deviation (see README "Deviations from upstream"): this deployment
// IS Sylvan Librarian, so pages always use its name instead of upstream's
// hostname-derived one (which can never produce it — mtgseeker.com-family
// hosts derive "Mtgseeker", workers.dev derives "Workers"). The derivation
// port below stays intact and tested for upstream-sync fidelity.
export const SITE_NAME = "Sylvan Librarian";

// TLDs in this set are stripped from the hostname; others are concatenated
// into the word. e.g. sylvan-librarian.com -> "Sylvan Librarian";
// tolarian-acade.my -> "Tolarian Academy" (upstream _STRIP_TLDS).
const STRIP_TLDS = new Set(["app", "biz", "co", "com", "dev", "edu", "gov", "info", "io", "me", "net", "org", "us"]);
const SAFE_HOSTNAME_RE = /^[a-z0-9.-]+$/;
const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;

/** Python str.title() over the ASCII names this ever sees. */
function pyTitle(value: string): string {
	return value.replace(/[A-Za-z]+/g, (run) => (run[0] as string).toUpperCase() + run.slice(1).toLowerCase());
}

function siteNameForHostname(hostname: string): string {
	if (!hostname || hostname === "localhost" || IP_RE.test(hostname) || !SAFE_HOSTNAME_RE.test(hostname)) {
		return FALLBACK_SITE_NAME;
	}
	const parts = hostname.split(".").slice(-2);
	const tld = (parts[parts.length - 1] as string).toLowerCase();
	let name = STRIP_TLDS.has(tld) ? (parts[0] as string) : parts.join(".");
	name = name.replaceAll(".", "").replaceAll("-", " ").trim();
	name = pyTitle(name);
	return /[A-Za-z0-9]/.test(name) ? name : FALLBACK_SITE_NAME;
}

/** Derive a display name from a Host header value, falling back to FALLBACK_SITE_NAME. */
export function hostnameToSiteName(rawHost: string): string {
	// Python urlparse keeps a non-ASCII hostname as-is, which then fails the
	// safe-hostname allowlist; URL() would instead punycode it, so reject
	// non-ASCII input up front to land on the same fallback.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors Python's ASCII check
	if (/[^\x00-\x7f]/.test(rawHost)) {
		return FALLBACK_SITE_NAME;
	}
	let hostname = "";
	try {
		// URL() strips the port and lowercases, like urlparse().hostname.
		hostname = new URL(`http://${rawHost}`).hostname;
	} catch {
		hostname = "";
	}
	// URL() brackets IPv6 hostnames; urlparse().hostname does not. Strip for parity.
	hostname = hostname.replace(/^\[|\]$/g, "");
	return siteNameForHostname(hostname.slice(0, 64));
}
