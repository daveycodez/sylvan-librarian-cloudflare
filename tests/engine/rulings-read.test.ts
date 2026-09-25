// readRulingsBucket: a rulings bucket read through the colo's Cache API, its copy named by the
// publish version `rulings:meta` records. The keys are rewritten in place each night, so what these
// pin is freshness as much as cost: a new publish is a miss once the colo has seen its meta, a copy
// filled while KV may still be converging lives a minute rather than a day, and with no usable meta
// the read is exactly the plain one it replaced.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { edgeCacheUrl } from "../../src/engine/edge-cache";
import {
	currentRulingsVersion,
	RULINGS_BUCKET_COUNT,
	RULINGS_CONTENT_GENERATION,
	RULINGS_EDGE_TTL_S,
	RULINGS_FORMAT_VERSION,
	RULINGS_META_KEY,
	RULINGS_SEEN_URL,
	RULINGS_SETTLE_S,
	RULINGS_UNSETTLED_EDGE_TTL_S,
	RULINGS_VERSION_CHECK_S,
	RULINGS_VERSION_MEMO_MS,
	type RulingsMeta,
	readRulingsBucket,
	rulingsBucketKey,
	rulingsPublishVersion,
} from "../../src/engine/rulings-kv";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const BUCKET = 0x1f;
const KEY = rulingsBucketKey(BUCKET);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

function meta(builtAt: string, rulingCount = 7): RulingsMeta {
	return {
		format_version: RULINGS_FORMAT_VERSION,
		content_generation: RULINGS_CONTENT_GENERATION,
		bucket_count: RULINGS_BUCKET_COUNT,
		built_at: builtAt,
		ruling_count: rulingCount,
	};
}

/** One KV namespace; `isolate()` is a fresh binding object, so a fresh set of per-isolate memos. */
function namespace() {
	const values = new Map<string, Uint8Array>();
	const gets: string[] = [];
	const failOn = new Set<string>();
	const isolate = () =>
		({
			async get(key: string, opts?: { type?: string }) {
				gets.push(key);
				if (failOn.has(key)) throw new Error(`KV get ${key} failed`);
				const value = values.get(key);
				if (value === undefined) return null;
				if (opts?.type === "arrayBuffer") return value.slice().buffer;
				return new TextDecoder().decode(value);
			},
		}) as unknown as KVNamespace;
	const publish = (bucketText: string, m: RulingsMeta | string) => {
		values.set(KEY, bytes(bucketText));
		values.set(RULINGS_META_KEY, bytes(typeof m === "string" ? m : JSON.stringify(m)));
	};
	return { values, gets, failOn, isolate, publish };
}

/** A `caches.default` that honours max-age against the (mockable) clock, like the real one. */
function installCaches(): Map<string, { body: Uint8Array; maxAge: number }> {
	const entries = new Map<string, { body: Uint8Array; maxAge: number; expires: number }>();
	const cache = {
		match: async (url: string) => {
			const hit = entries.get(url);
			if (!hit || Date.now() >= hit.expires) return undefined;
			return new Response(hit.body.slice());
		},
		put: async (url: string, res: Response) => {
			const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 0);
			const body = new Uint8Array(await res.arrayBuffer());
			entries.set(url, { body, maxAge, expires: Date.now() + maxAge * 1000 });
		},
	};
	Object.assign(globalThis, { caches: { default: cache } });
	return entries as unknown as Map<string, { body: Uint8Array; maxAge: number }>;
}

const at = (seconds: number) => setSystemTime(new Date(T0 + seconds * 1000));
const copyName = (version: string) => edgeCacheUrl(`${KEY}@${version}`);
const bucketGets = (gets: string[]) => gets.filter((k) => k === KEY).length;
const metaGets = (gets: string[]) => gets.filter((k) => k === RULINGS_META_KEY).length;

afterEach(() => {
	delete (globalThis as { caches?: unknown }).caches;
	setSystemTime();
});

describe("the publish version", () => {
	test("is the meta's identity: generation, built_at and ruling count", () => {
		expect(rulingsPublishVersion(meta("1758700000", 77961))).toBe(`g${RULINGS_CONTENT_GENERATION}-1758700000-77961`);
		const { content_generation: _, ...older } = meta("5");
		expect(rulingsPublishVersion(older)).toBe("g0-5-7");
	});

	test("a meta this reader cannot key by is no version at all", () => {
		for (const m of [
			null,
			"text",
			{ ...meta("5"), format_version: RULINGS_FORMAT_VERSION + 1 },
			{ ...meta("5"), bucket_count: 64 },
			{ ...meta("5"), built_at: "" },
			{ ...meta("5"), ruling_count: undefined },
		]) {
			expect(rulingsPublishVersion(m)).toBeNull();
		}
	});
});

describe("readRulingsBucket through the colo cache", () => {
	test("a second isolate in the colo reads neither the meta nor the bucket from KV", async () => {
		installCaches();
		at(0);
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-1");
		expect(ns.gets).toEqual([RULINGS_META_KEY, KEY]);
		at(RULINGS_SETTLE_S);
		// Past the settle window the copy is refilled once, for a day; after that, nothing.
		expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-1");
		expect(bucketGets(ns.gets)).toBe(2);
		for (let i = 1; i <= 5; i++) {
			at(RULINGS_SETTLE_S + i * 60);
			expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-1");
		}
		expect(ns.gets).toEqual([RULINGS_META_KEY, KEY, KEY]);
	});

	test("one isolate asks the colo for the version at most once a minute", async () => {
		installCaches();
		at(0);
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		const kv = ns.isolate();
		const matched: string[] = [];
		const cache = (globalThis as unknown as { caches: { default: { match: (u: string) => Promise<unknown> } } }).caches
			.default;
		const match = cache.match;
		cache.match = async (u: string) => {
			matched.push(u);
			return match(u);
		};
		await readRulingsBucket(kv, BUCKET);
		await readRulingsBucket(kv, BUCKET);
		at(RULINGS_VERSION_MEMO_MS / 1000);
		await readRulingsBucket(kv, BUCKET);
		expect(matched.filter((u) => u === RULINGS_SEEN_URL).length).toBe(2);
	});

	test("fills inside the settle window live a minute; after it, a day", async () => {
		const entries = installCaches();
		at(0);
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		await readRulingsBucket(ns.isolate(), BUCKET);
		expect(entries.get(copyName("g1-100-7"))?.maxAge).toBe(RULINGS_UNSETTLED_EDGE_TTL_S);
		at(RULINGS_SETTLE_S - 1);
		await readRulingsBucket(ns.isolate(), BUCKET);
		expect(entries.get(copyName("g1-100-7"))?.maxAge).toBe(RULINGS_UNSETTLED_EDGE_TTL_S);
		at(RULINGS_SETTLE_S + RULINGS_UNSETTLED_EDGE_TTL_S);
		await readRulingsBucket(ns.isolate(), BUCKET);
		expect(entries.get(copyName("g1-100-7"))?.maxAge).toBe(RULINGS_EDGE_TTL_S);
	});

	test("the colo checks the meta hourly, and a check that finds the same version keeps its `since`", async () => {
		const entries = installCaches();
		at(0);
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		await readRulingsBucket(ns.isolate(), BUCKET);
		at(RULINGS_VERSION_CHECK_S - 1);
		await readRulingsBucket(ns.isolate(), BUCKET);
		expect(metaGets(ns.gets)).toBe(1);
		at(RULINGS_VERSION_CHECK_S);
		const kv = ns.isolate();
		expect(await currentRulingsVersion(kv)).toEqual({ version: "g1-100-7", since: T0 });
		expect(metaGets(ns.gets)).toBe(2);
		expect(entries.has(RULINGS_SEEN_URL)).toBe(true);
	});

	test("a republish is a miss as soon as the colo sees its meta — within the hour, never later", async () => {
		const entries = installCaches();
		at(0);
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		await readRulingsBucket(ns.isolate(), BUCKET);
		at(RULINGS_SETTLE_S + RULINGS_UNSETTLED_EDGE_TTL_S);
		await readRulingsBucket(ns.isolate(), BUCKET); // the settled, day-long copy

		// The nightly rewrites the bucket in place, then the meta.
		at(1800);
		ns.publish("night-2", meta("200", 9));
		// Until the colo's next check it still serves the copy it has — today's bound, not longer.
		at(RULINGS_VERSION_CHECK_S - 1);
		expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-1");
		const before = bucketGets(ns.gets);
		at(RULINGS_VERSION_CHECK_S);
		expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-2");
		expect(bucketGets(ns.gets)).toBe(before + 1);
		// The new version starts its own settle window.
		expect(entries.get(copyName("g1-200-9"))?.maxAge).toBe(RULINGS_UNSETTLED_EDGE_TTL_S);
		expect(await currentRulingsVersion(ns.isolate())).toEqual({
			version: "g1-200-9",
			since: T0 + RULINGS_VERSION_CHECK_S * 1000,
		});
	});

	test("an isolate that already saw the new version does not wait for anyone else's memo", async () => {
		installCaches();
		at(0);
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		const kv = ns.isolate();
		await readRulingsBucket(kv, BUCKET);
		ns.publish("night-2", meta("200"));
		at(RULINGS_VERSION_CHECK_S);
		// Its bucket memo still holds night-1 under the OLD name; the new name is a memo miss.
		expect(text(await readRulingsBucket(kv, BUCKET))).toBe("night-2");
	});
});

describe("readRulingsBucket with no usable meta is the plain read", () => {
	test("no meta: KV per isolate, no colo copy of the bucket, and the absence is checked hourly", async () => {
		const entries = installCaches();
		at(0);
		const ns = namespace();
		ns.values.set(KEY, bytes("seeded-without-meta"));
		for (let i = 0; i < 3; i++) {
			expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("seeded-without-meta");
		}
		expect(bucketGets(ns.gets)).toBe(3);
		expect(metaGets(ns.gets)).toBe(1);
		expect([...entries.keys()]).toEqual([RULINGS_SEEN_URL]);
	});

	test("no bucket either: null (the route's 503), never remembered at the colo", async () => {
		const entries = installCaches();
		const ns = namespace();
		expect(await readRulingsBucket(ns.isolate(), BUCKET)).toBeNull();
		expect([...entries.keys()]).toEqual([RULINGS_SEEN_URL]);
	});

	test("a meta for another layout, or one that is not JSON, reads as before", async () => {
		for (const m of [JSON.stringify({ ...meta("100"), format_version: 99 }), "{not json"]) {
			const entries = installCaches();
			const ns = namespace();
			ns.publish("night-1", m);
			expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-1");
			expect(entries.has(copyName("g1-100-7"))).toBe(false);
			expect([...entries.keys()]).toEqual([RULINGS_SEEN_URL]);
		}
	});

	test("a failed meta read reads the bucket as before, and the next request asks again", async () => {
		const entries = installCaches();
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		ns.failOn.add(RULINGS_META_KEY);
		const kv = ns.isolate();
		expect(text(await readRulingsBucket(kv, BUCKET))).toBe("night-1");
		expect(entries.size).toBe(0);
		ns.failOn.clear();
		expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-1");
		expect(metaGets(ns.gets)).toBe(2);
		expect(entries.has(RULINGS_SEEN_URL)).toBe(true);
	});

	test("a failed bucket read still throws (the route's 500)", async () => {
		installCaches();
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		ns.failOn.add(KEY);
		await expect(readRulingsBucket(ns.isolate(), BUCKET)).rejects.toThrow("failed");
	});

	test("with no Cache API at all (bun, previews) the bytes are still the published ones", async () => {
		const ns = namespace();
		ns.publish("night-1", meta("100"));
		expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-1");
		ns.publish("night-2", meta("200"));
		expect(text(await readRulingsBucket(ns.isolate(), BUCKET))).toBe("night-2");
	});
});
