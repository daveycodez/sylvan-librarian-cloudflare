// The tag alias map as a per-build KV value (src/engine/tag-aliases.ts): its key sits in the
// retention family, its value is refused rather than half-read, and the Worker's per-isolate
// loader answers EMPTY — never throws — for a build without one.

import { afterEach, describe, expect, test } from "bun:test";
import { keysToRetire } from "../../src/engine/kv-retention";
import {
	ALIAS_MISS_RETRY_MS,
	forgetLiveTagAliases,
	liveTagAliases,
	parseTagAliasTables,
	readTagAliases,
	setAliasJoinForTests,
	tagAliasesKey,
	tagAliasesKeyFor,
	writeTagAliases,
} from "../../src/engine/tag-aliases";
import type { Env, StoreManifest } from "../../src/engine/types";
import { FakeKV } from "../routes/harness";

const VALUE = '{"oracle":{"reanimate-copy":"copy-from-graveyard"},"art":{"flames":"fire"}}';

function manifestOf(builtAt: string): StoreManifest {
	return { format_version: 5, built_at: builtAt, partition_count: 1, partitions: [] } as unknown as StoreManifest;
}

function envOf(kv: FakeKV): Env {
	return { STORE_KV: kv } as unknown as Env;
}

afterEach(() => {
	forgetLiveTagAliases();
	setAliasJoinForTests(500);
});

/** A KV whose alias reads answer what `plan` says, in order: "never" is a read whose request was
 * cancelled (it never settles), "late" one that answers only when `release()` is called. */
function plannedKv(plan: ("ok" | "never" | "late")[]) {
	const kv = new FakeKV();
	kv.put("store:card-aliases-v5-1000.store:0", VALUE);
	let reads = 0;
	let release: () => void = () => {};
	const planned = new Proxy(kv, {
		get(target, prop, receiver) {
			if (prop !== "get") return Reflect.get(target, prop, receiver);
			return (...args: unknown[]) => {
				const how = plan[reads++] ?? "ok";
				const answer = () => (target.get as (...a: unknown[]) => Promise<unknown>).apply(target, args);
				if (how === "never") return new Promise(() => {});
				if (how === "late") {
					return new Promise((resolve) => {
						release = () => resolve(answer());
					});
				}
				return answer();
			};
		},
	});
	return { env: envOf(planned as unknown as FakeKV), reads: () => reads, release: () => release() };
}

describe("the key", () => {
	test("is shaped like the routing filter's and named by the build", () => {
		expect(tagAliasesKey(5, "1700000000")).toBe("store:card-aliases-v5-1700000000.store:0");
		expect(tagAliasesKeyFor(manifestOf("1700000000"))).toBe("store:card-aliases-v5-1700000000.store:0");
		expect(tagAliasesKeyFor({ store_key: "x" } as unknown as StoreManifest)).toBeNull();
	});

	test("retires with its build's family and survives with a protected one", () => {
		// A `store:card-` key the retention pattern misses is listed forever and deleted never;
		// one it matches too eagerly takes the live map down. Both directions pinned.
		const keys = [
			"store:card-store-v5-1000-p0.store:0",
			"store:card-aliases-v5-1000.store:0",
			"store:card-routing-v5-1000.store:0",
			"store:card-store-v5-2000-p0.store:0",
			"store:card-aliases-v5-2000.store:0",
		];
		expect(keysToRetire(keys, { live: "2000", rollback: null, inFlight: null }).sort()).toEqual([
			"store:card-aliases-v5-1000.store:0",
			"store:card-routing-v5-1000.store:0",
			"store:card-store-v5-1000-p0.store:0",
		]);
		expect(keysToRetire(keys, { live: "1000", rollback: null, inFlight: null })).not.toContain(
			"store:card-aliases-v5-1000.store:0",
		);
	});
});

describe("the value", () => {
	test("parses into the parser's two tables", () => {
		const tables = parseTagAliasTables(VALUE);
		expect(tables.oracle.get("reanimate-copy")).toBe("copy-from-graveyard");
		expect(tables.art.get("flames")).toBe("fire");
		expect(tables.oracle.has("flames")).toBe(false);
	});

	test("is refused whole when it is not the shipped shape", () => {
		// A half-read map's only symptom is a tag spelling that quietly matches nothing.
		expect(() => parseTagAliasTables("[]")).toThrow();
		expect(() => parseTagAliasTables('{"oracle":{}}')).toThrow(/"art"/);
		expect(() => parseTagAliasTables('{"oracle":{"a":1},"art":{}}')).toThrow(/oracle\.a/);
		expect(() => parseTagAliasTables("null")).toThrow();
	});

	test("round-trips through KV under the build's key", async () => {
		const kv = new FakeKV();
		await writeTagAliases(envOf(kv), 5, "1000", VALUE);
		expect([...kv.values.keys()]).toEqual(["store:card-aliases-v5-1000.store:0"]);
		const tables = await readTagAliases(envOf(kv), manifestOf("1000"));
		expect(tables?.oracle.get("reanimate-copy")).toBe("copy-from-graveyard");
		expect(await readTagAliases(envOf(kv), manifestOf("2000"))).toBeNull();
	});

	test("a publisher cannot write a value the reader would refuse", async () => {
		const kv = new FakeKV();
		await expect(writeTagAliases(envOf(kv), 5, "1000", "{}")).rejects.toThrow();
		expect(kv.values.size).toBe(0);
	});
});

describe("the isolate loader", () => {
	test("reads once per build and answers from the isolate after that", async () => {
		const kv = new FakeKV();
		kv.put("store:card-aliases-v5-1000.store:0", VALUE);
		let reads = 0;
		const counting = new Proxy(kv, {
			get(target, prop, receiver) {
				if (prop === "get") reads++;
				return Reflect.get(target, prop, receiver);
			},
		});
		const env = envOf(counting as unknown as FakeKV);
		const first = await liveTagAliases(env, manifestOf("1000"));
		expect(first.oracle.get("reanimate-copy")).toBe("copy-from-graveyard");
		const again = await liveTagAliases(env, manifestOf("1000"));
		expect(again).toBe(first);
		expect(reads).toBe(1);
		// Concurrent first requests share ONE read.
		forgetLiveTagAliases();
		reads = 0;
		await Promise.all([liveTagAliases(env, manifestOf("1000")), liveTagAliases(env, manifestOf("1000"))]);
		expect(reads).toBe(1);
	});

	test("a new build is a new key, not a stale table", async () => {
		const kv = new FakeKV();
		kv.put("store:card-aliases-v5-1000.store:0", VALUE);
		kv.put("store:card-aliases-v5-2000.store:0", '{"oracle":{"new-alias":"new-slug"},"art":{}}');
		const env = envOf(kv);
		expect((await liveTagAliases(env, manifestOf("1000"))).oracle.has("new-alias")).toBe(false);
		expect((await liveTagAliases(env, manifestOf("2000"))).oracle.has("new-alias")).toBe(true);
	});

	test("a build without a map resolves nothing, and the isolate stops asking", async () => {
		const kv = new FakeKV();
		let reads = 0;
		const counting = new Proxy(kv, {
			get(target, prop, receiver) {
				if (prop === "get") reads++;
				return Reflect.get(target, prop, receiver);
			},
		});
		const env = envOf(counting as unknown as FakeKV);
		const tables = await liveTagAliases(env, manifestOf("1000"));
		expect(tables.oracle.size).toBe(0);
		await liveTagAliases(env, manifestOf("1000"));
		expect(reads).toBe(1);
		// ...for ALIAS_MISS_RETRY_MS. A map published late (scripts/publish-tag-aliases.ts) must
		// become visible without waiting for the isolate to die.
		kv.put("store:card-aliases-v5-1000.store:0", VALUE);
		const realNow = Date.now;
		Date.now = () => realNow() + ALIAS_MISS_RETRY_MS + 1;
		try {
			expect((await liveTagAliases(env, manifestOf("1000"))).oracle.get("reanimate-copy")).toBe("copy-from-graveyard");
			expect(reads).toBe(2);
		} finally {
			Date.now = realNow;
		}
	});

	test("a KV fault costs this request its aliases and is retried by the next", async () => {
		const kv = new FakeKV();
		kv.put("store:card-aliases-v5-1000.store:0", VALUE);
		kv.failOn.add("store:card-aliases-v5-1000.store:0");
		const env = envOf(kv);
		expect((await liveTagAliases(env, manifestOf("1000"))).oracle.size).toBe(0);
		kv.failOn.clear();
		expect((await liveTagAliases(env, manifestOf("1000"))).oracle.get("reanimate-copy")).toBe("copy-from-graveyard");
	});

	// x57. DeckGen 2026-10-03: two /cards/search requests waited 100s each on this load, then the edge
	// answered 524 — the request that began the read had been cancelled, so the read never settled,
	// its `finally` never cleared the slot, and every later request in the isolate joined it.
	test("a read whose request was cancelled does not hold the next request: it reads for itself", async () => {
		setAliasJoinForTests(20);
		const { env, reads } = plannedKv(["never"]);
		// The cancelled request's call: nothing will ever come of it.
		void liveTagAliases(env, manifestOf("1000"));
		const started = Date.now();
		const tables = await liveTagAliases(env, manifestOf("1000"));
		expect(tables.oracle.get("reanimate-copy")).toBe("copy-from-graveyard");
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(reads()).toBe(2);
		// And the isolate is whole again: the next request reads nothing and waits on nothing.
		const again = Date.now();
		expect(await liveTagAliases(env, manifestOf("1000"))).toBe(tables);
		expect(Date.now() - again).toBeLessThan(15);
		expect(reads()).toBe(2);
	});

	test("the request that takes a lost read over owns the slot: later joiners wait on the live read", async () => {
		setAliasJoinForTests(20);
		const { env, reads, release } = plannedKv(["never", "late"]);
		void liveTagAliases(env, manifestOf("1000"));
		// Takes over after 20ms; its own read is slow but alive.
		const second = liveTagAliases(env, manifestOf("1000"));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(reads()).toBe(2);
		// Joins the SECOND read, not the lost one — so it is answered when that read is, with no third.
		setAliasJoinForTests(5_000);
		const third = liveTagAliases(env, manifestOf("1000"));
		release();
		expect((await second).oracle.get("reanimate-copy")).toBe("copy-from-graveyard");
		expect(await third).toBe(await second);
		expect(reads()).toBe(2);
	});

	test("a read given up on that answers late after all still fills the isolate's table", async () => {
		setAliasJoinForTests(20);
		const { env, reads, release } = plannedKv(["late", "never"]);
		const first = liveTagAliases(env, manifestOf("1000"));
		// Gives up on the first read at 20ms and starts a second, which never answers.
		const second = liveTagAliases(env, manifestOf("1000"));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(reads()).toBe(2);
		// The first read answers after all: its table is the isolate's, for everyone.
		release();
		expect((await first).oracle.get("reanimate-copy")).toBe("copy-from-graveyard");
		expect(await liveTagAliases(env, manifestOf("1000"))).toBe(await first);
		expect(reads()).toBe(2);
		void second;
	});

	test("a manifest without a built_at gets the empty tables without touching KV", async () => {
		const kv = new FakeKV();
		kv.failOn.add("anything");
		const tables = await liveTagAliases(envOf(kv), { store_key: "x" } as unknown as StoreManifest);
		expect(tables.oracle.size).toBe(0);
	});
});
