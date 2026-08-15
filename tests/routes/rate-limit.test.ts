// The per-IP limiter's isolate-local verdict cache.
//
// Enforcement is asynchronous by design: a request is served immediately and
// the Durable Object's verdict lands a round trip later, blocking the address
// from the NEXT request. So everything here drives enforceRateLimit and then
// awaits the waitUntil promises to let the verdict settle, which is also the
// order production runs it in.
//
// The eviction test exists because the cache's only other eviction is an
// address coming BACK after its block expired. One that never returns used to
// leave its entry forever, so a distributed source grew the map without bound.
// The bound is not directly observable — the map is module-private — so it is
// tested the way it actually matters: the oldest blocked address stops being
// blocked once the cap is passed.

import { describe, expect, mock, test } from "bun:test";
import { timingSafeEqual } from "node:crypto";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

// crypto.subtle.timingSafeEqual is a Workers-only extension; Bun does not
// have it, so the trusted-key tests borrow Node's constant-time compare.
if (!("timingSafeEqual" in crypto.subtle)) {
	(crypto.subtle as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean }).timingSafeEqual = (a, b) =>
		timingSafeEqual(a, b);
}

const { enforceRateLimit, isRateLimitedRoute, isTrustedRequest } = await import("../../src/routes/rate-limit");
type Env = Parameters<typeof enforceRateLimit>[0];

/** Env whose limiter DO always rules the address over its allowance. */
function envRefusing(allowed = false): Env {
	return {
		RATE_LIMIT_ENABLED: "true",
		RATE_LIMIT_PER_10S: "100",
		RATE_LIMITER: {
			idFromName: (name: string) => name,
			get: () => ({ rateLimit: async () => allowed }),
		},
	} as unknown as Env;
}

function requestFrom(ip: string): Request {
	return new Request("https://sylvan-librarian.com/search?q=elf", { headers: { "CF-Connecting-IP": ip } });
}

/** Run one request and settle the background verdict. */
async function hit(env: Env, ip: string): Promise<"off" | "allowed" | "limited"> {
	const pending: Promise<unknown>[] = [];
	const { outcome } = enforceRateLimit(env, requestFrom(ip), (p) => pending.push(p));
	await Promise.all(pending);
	return outcome;
}

describe("enforcement", () => {
	test("is off unless RATE_LIMIT_ENABLED is exactly true", async () => {
		const env = { RATE_LIMIT_ENABLED: "1" } as unknown as Env;
		expect(await hit(env, "203.0.113.1")).toBe("off");
	});

	test("serves the first request and blocks only from the next one", async () => {
		const env = envRefusing();
		// Async by design: the verdict cannot apply to the request that caused it.
		expect(await hit(env, "203.0.113.2")).toBe("allowed");
		expect(await hit(env, "203.0.113.2")).toBe("limited");
	});

	test("a permitted address is never blocked", async () => {
		const env = envRefusing(true);
		for (let i = 0; i < 5; i++) expect(await hit(env, "203.0.113.3")).toBe("allowed");
	});

	test("addresses are blocked independently", async () => {
		const env = envRefusing();
		await hit(env, "203.0.113.4");
		expect(await hit(env, "203.0.113.4")).toBe("limited");
		expect(await hit(env, "203.0.113.5")).toBe("allowed");
	});
});

describe("verdict cache bound", () => {
	test("evicts the oldest block rather than growing without limit", async () => {
		const env = envRefusing();
		const victim = "198.51.100.0";
		await hit(env, victim);
		expect(await hit(env, victim)).toBe("limited");

		// Block far more distinct addresses than the cap, none of which return.
		// Before the bound this grew the map by one entry per address, forever.
		for (let i = 1; i <= 10_200; i++) await hit(env, `198.51.100.${i}`);

		// The first address aged out of the cache, so it is served again — the
		// limiter re-learns from the DO, which is the correct degradation.
		expect(await hit(env, victim)).toBe("allowed");
		// A recently blocked address is still remembered.
		expect(await hit(env, "198.51.100.10200")).toBe("limited");
	});
});

describe("the 429", () => {
	test("advertises a Retry-After that covers the whole block", async () => {
		const env = envRefusing();
		const ip = "203.0.113.9";
		await hit(env, ip);
		const pending: Promise<unknown>[] = [];
		const { response } = enforceRateLimit(env, requestFrom(ip), (p) => pending.push(p));
		await Promise.all(pending);
		expect(response?.status).toBe(429);
		// Undershooting BLOCK_MS would send a well-behaved client back while it
		// is still blocked. Derived from the constant, so this pins the pairing
		// rather than the number.
		const retryAfter = Number(response?.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThanOrEqual(30);
		const body = (await response?.json()) as { title: string };
		expect(body.title).toBe("Too Many Requests");
	});
});

describe("trusted keys", () => {
	const envWith = (keys: string | undefined): Env => ({ TRUSTED_API_KEYS: keys }) as unknown as Env;
	const requestWith = (key?: string): Request =>
		new Request("https://sylvan-librarian.com/search?q=elf", {
			headers: key === undefined ? {} : { "X-API-Key": key },
		});

	test("no configured keys means no bypass surface at all", async () => {
		expect(await isTrustedRequest(envWith(undefined), requestWith("anything"))).toBe(false);
		expect(await isTrustedRequest(envWith(""), requestWith("anything"))).toBe(false);
	});

	test("a single configured key still works", async () => {
		expect(await isTrustedRequest(envWith("alpha"), requestWith("alpha"))).toBe(true);
		expect(await isTrustedRequest(envWith("alpha"), requestWith("beta"))).toBe(false);
		expect(await isTrustedRequest(envWith("alpha"), requestWith())).toBe(false);
	});

	test("every key in the list is accepted", async () => {
		const env = envWith("alpha,beta,gamma");
		expect(await isTrustedRequest(env, requestWith("alpha"))).toBe(true);
		expect(await isTrustedRequest(env, requestWith("beta"))).toBe(true);
		expect(await isTrustedRequest(env, requestWith("gamma"))).toBe(true);
		expect(await isTrustedRequest(env, requestWith("delta"))).toBe(false);
	});

	test("whitespace around entries and empty entries are tolerated", async () => {
		const env = envWith(" alpha , ,\tbeta ,");
		expect(await isTrustedRequest(env, requestWith("alpha"))).toBe(true);
		expect(await isTrustedRequest(env, requestWith("beta"))).toBe(true);
		// A padded presented key is unrepresentable: the Headers API trims
		// field values per the fetch spec, so " alpha " arrives as "alpha".
		// Trimming the CONFIGURED entries mirrors that, which is why the two
		// sides can only ever meet on the trimmed form.
		expect(await isTrustedRequest(env, requestWith(""))).toBe(false);
	});

	test("the delimiter cannot be smuggled: the joined list is not a key", async () => {
		const env = envWith("alpha,beta");
		expect(await isTrustedRequest(env, requestWith("alpha,beta"))).toBe(false);
	});
});

describe("limited routes", () => {
	test("covers the engine-computing routes only", () => {
		expect(isRateLimitedRoute("search", {})).toBe(true);
		expect(isRateLimitedRoute("random_search", {})).toBe(true);
		expect(isRateLimitedRoute("get_catalog", {})).toBe(false);
		expect(isRateLimitedRoute("_root", {})).toBe(false);
	});

	test("includes the SSR root only when it embeds a query", () => {
		expect(isRateLimitedRoute("_root", { q: "elf" })).toBe(true);
		expect(isRateLimitedRoute("_root", { query: "elf" })).toBe(true);
	});
});
