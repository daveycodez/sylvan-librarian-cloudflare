// The tag alias map as a per-build KV value (src/engine/tag-aliases.ts): its key sits in the
// retention family, its value is refused rather than half-read, and the Worker's per-isolate
// loader answers EMPTY — never throws — for a build without one.

import { afterEach, describe, expect, test } from "bun:test";
import { staleStoreKeys } from "../../src/engine/store-kv";
import {
	forgetLiveTagAliases,
	liveTagAliases,
	parseTagAliasTables,
	readTagAliases,
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

afterEach(() => forgetLiveTagAliases());

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
		expect(staleStoreKeys(keys, 1, "2000").sort()).toEqual([
			"store:card-aliases-v5-1000.store:0",
			"store:card-routing-v5-1000.store:0",
			"store:card-store-v5-1000-p0.store:0",
		]);
		expect(staleStoreKeys(keys, 1, "1000")).not.toContain("store:card-aliases-v5-1000.store:0");
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

	test("a manifest without a built_at gets the empty tables without touching KV", async () => {
		const kv = new FakeKV();
		kv.failOn.add("anything");
		const tables = await liveTagAliases(envOf(kv), { store_key: "x" } as unknown as StoreManifest);
		expect(tables.oracle.size).toBe(0);
	});
});
