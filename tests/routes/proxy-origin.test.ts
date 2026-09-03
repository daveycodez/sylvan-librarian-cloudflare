// The absolute URLs in a cacheable body are built from a host and scheme the
// REQUEST supplies, and this deployment is public and edge-cached, so an
// unauthenticated `X-Proxy-Host` used to let one request decide where every
// `uri`, `set_uri`, `rulings_uri`, `prints_search_uri` and `next_page` in a
// sixteen-hour cache entry pointed. See src/routes/proxy-origin.ts.

import { describe, expect, test } from "bun:test";
import type { Env } from "../../src/engine/types";
import { resolveProxyOrigin } from "../../src/routes/proxy-origin";

const env = (vars: Record<string, string> = {}) => vars as unknown as Env;

function origin(headers: Record<string, string>, vars: Record<string, string> = {}) {
	const url = new URL("https://sylvan-librarian.workers.dev/cards/search?q=bolt");
	return resolveProxyOrigin(new Request(url, { headers }), env(vars), url);
}

describe("with no TRUSTED_PROXY_HOSTS configured (the shipped deployment)", () => {
	test("the request's own origin decides, whatever the headers claim", () => {
		expect(origin({})).toEqual({ host: "sylvan-librarian.workers.dev", scheme: "https" });
		expect(origin({ "X-Proxy-Host": "evil.example" })).toEqual({
			host: "sylvan-librarian.workers.dev",
			scheme: "https",
		});
	});

	test("a scheme downgrade is refused too — an https next_page stays https", () => {
		expect(origin({ "x-forwarded-proto": "http" }).scheme).toBe("https");
		expect(origin({ "X-Proxy-Host": "evil.example", "x-forwarded-proto": "http" })).toEqual({
			host: "sylvan-librarian.workers.dev",
			scheme: "https",
		});
	});
});

describe("with a proxy the operator named", () => {
	const vars = { TRUSTED_PROXY_HOSTS: "cards.example.com, mtg.example.org:8443" };

	test("an allowlisted host is honoured, which is upstream's behaviour", () => {
		expect(origin({ "X-Proxy-Host": "cards.example.com" }, vars).host).toBe("cards.example.com");
		expect(origin({ "X-Proxy-Host": "mtg.example.org:8443" }, vars).host).toBe("mtg.example.org:8443");
	});

	test("matching is case-insensitive but never by suffix", () => {
		expect(origin({ "X-Proxy-Host": "CARDS.example.COM" }, vars).host).toBe("CARDS.example.COM");
		// The classic allowlist hole: a rule for example.com admitting an attacker's
		// lookalike. Both of these are 404s for the allowlist, not near-misses.
		expect(origin({ "X-Proxy-Host": "evil-cards.example.com" }, vars).host).toBe("sylvan-librarian.workers.dev");
		expect(origin({ "X-Proxy-Host": "cards.example.com.evil.test" }, vars).host).toBe("sylvan-librarian.workers.dev");
	});

	test("a host NOT on the list falls back, so a forged header cannot seed a cache entry", () => {
		expect(origin({ "X-Proxy-Host": "evil.example" }, vars)).toEqual({
			host: "sylvan-librarian.workers.dev",
			scheme: "https",
		});
	});

	test("the scheme rides on the host: honoured with an allowlisted host, ignored without one", () => {
		expect(origin({ "X-Proxy-Host": "cards.example.com", "x-forwarded-proto": "http" }, vars)).toEqual({
			host: "cards.example.com",
			scheme: "http",
		});
		// No X-Proxy-Host means nothing authenticated this request as coming through
		// the proxy, so the scheme header is just as unsigned as the host one was.
		expect(origin({ "x-forwarded-proto": "http" }, vars).scheme).toBe("https");
		// And an allowlisted host does not let any string through as a scheme.
		expect(origin({ "X-Proxy-Host": "cards.example.com", "x-forwarded-proto": "javascript" }, vars).scheme).toBe(
			"https",
		);
	});
});

describe("configuration edge cases", () => {
	test("empty and whitespace-only entries never match an empty header", () => {
		expect(origin({ "X-Proxy-Host": "" }, { TRUSTED_PROXY_HOSTS: "a.example,," }).host).toBe(
			"sylvan-librarian.workers.dev",
		);
		expect(origin({ "X-Proxy-Host": "   " }, { TRUSTED_PROXY_HOSTS: " , " }).host).toBe("sylvan-librarian.workers.dev");
	});

	test("an empty TRUSTED_PROXY_HOSTS is the same as an unset one", () => {
		expect(origin({ "X-Proxy-Host": "evil.example" }, { TRUSTED_PROXY_HOSTS: "" }).host).toBe(
			"sylvan-librarian.workers.dev",
		);
	});
});
