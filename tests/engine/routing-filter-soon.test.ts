// The routing filter's bounded wait (backlog n1): a fresh isolate's routed request may take the
// filter from the colo's Cache API copy for at most a few milliseconds, and must NEVER wait on the
// metered, cross-colo KV read — that keeps going in the background for the next request.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { edgeCacheUrl } from "../../src/engine/edge-cache";
import { forgetLiveRoutingFilter, liveRoutingFilter, routingFilterSoon } from "../../src/engine/partitioned-engine";
import { buildRoutingFilter, scryfallIdKey } from "../../src/engine/routing-filter";
import { routingFilterKeyFor } from "../../src/engine/store-kv";
import type { StoreManifest } from "../../src/engine/types";

const CARD = "0001c639-8bd0-426f-89cb-4ca61f3cc054";
const manifest = {
	store_key: "card-store-v5-1700000000.store",
	built_at: "1700000000",
	format_version: 5,
	partition_count: 4,
	partition_hash: "fnv1a64/oracle_id/v1",
} as StoreManifest;
const filterBytes = buildRoutingFilter([{ key: scryfallIdKey(CARD), partition: 3 }], {
	builtAt: "1700000000",
	partitionCount: 4,
	partitionHash: "fnv1a64/oracle_id/v1",
});

/** A caches.default whose only entry, when `hit`, is the filter. */
function installColo(hit: boolean): void {
	const url = edgeCacheUrl(routingFilterKeyFor(manifest) as string);
	const cache = {
		match: async (key: string) => (hit && key === url ? new Response(filterBytes) : undefined),
		put: async () => {},
	};
	Object.assign(globalThis, { caches: { default: cache } });
}

/** A KV whose get never answers until released — the slow, cold-colo read. */
function slowKv() {
	let release: (v: ArrayBuffer | null) => void = () => {};
	const gets: string[] = [];
	const env = {
		STORE_KV: {
			get: (key: string) => {
				gets.push(key);
				return new Promise((resolve) => {
					release = resolve;
				});
			},
		},
	} as unknown as Env;
	return { env, gets, release: (v: ArrayBuffer | null) => release(v) };
}

const background: Promise<unknown>[] = [];
const waitUntil = (p: Promise<unknown>) => {
	background.push(p);
};

beforeEach(() => forgetLiveRoutingFilter());
afterEach(() => {
	delete (globalThis as { caches?: unknown }).caches;
	forgetLiveRoutingFilter();
	background.length = 0;
});

describe("routingFilterSoon", () => {
	test("a colo hit hands over the filter at once, with no KV read", async () => {
		installColo(true);
		const { env, gets } = slowKv();
		const filter = await routingFilterSoon(env, manifest, waitUntil, 50);
		expect(filter?.lookup(scryfallIdKey(CARD))).toBe(3);
		expect(gets).toEqual([]);
		// And the isolate keeps it: the synchronous path now has it too.
		expect(liveRoutingFilter(env, manifest, waitUntil)).toBe(filter);
	});

	test("a colo miss answers null without waiting on KV, which carries on in the background", async () => {
		installColo(false);
		const { env, gets, release } = slowKv();
		const started = Date.now();
		expect(await routingFilterSoon(env, manifest, waitUntil, 1000)).toBeNull();
		// Released by the colo stage's miss, not by the 1s bound: the KV read never finished.
		expect(Date.now() - started).toBeLessThan(500);
		expect(gets.length).toBe(1);
		release(new Uint8Array(filterBytes).buffer);
		await Promise.all(background);
		expect(liveRoutingFilter(env, manifest, waitUntil)?.lookup(scryfallIdKey(CARD))).toBe(3);
	});

	test("the wait is bounded even when the colo itself is slow", async () => {
		const cache = { match: () => new Promise(() => {}), put: async () => {} };
		Object.assign(globalThis, { caches: { default: cache } });
		const { env } = slowKv();
		const started = Date.now();
		expect(await routingFilterSoon(env, manifest, waitUntil, 20)).toBeNull();
		expect(Date.now() - started).toBeLessThan(200);
	});

	test("one load per build per isolate, however many requests wait on it", async () => {
		installColo(false);
		const { env, gets } = slowKv();
		await Promise.all([
			routingFilterSoon(env, manifest, waitUntil, 5),
			routingFilterSoon(env, manifest, waitUntil, 5),
			routingFilterSoon(env, manifest, waitUntil, 5),
		]);
		expect(gets.length).toBe(1);
	});
});
