// One manifest per archive format (backlog x19), from the deploy's side: scripts/deploy-upload.ts
// reads every live manifest for its roles, never retires another format, and gives the build it is
// about to ship its own manifest key on the first deploy of per-format keys. Over an in-memory
// DeployKv, so what is pinned is the real functions' decisions — the harness (failover.ts scenarios
// 8-9) drives the same functions through a whole deploy and nightly.

import { describe, expect, test } from "bun:test";
import {
	beginDeployUpload,
	type DeployKv,
	ensureFormatManifest,
	readPublishedManifests,
	sweepGenerationsByRole,
} from "../../scripts/deploy-upload";
import { DEPLOY_FENCE_KEY, type ListedKey } from "../../src/engine/kv-retention";
import { chunkKey, formatManifestKey, MANIFEST_KEY, routingFilterKey } from "../../src/engine/store-kv";

const A = 2026092401;
const B = 2026092501;

function memoryKv(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const meta = new Map<string, unknown>();
	const deleted: string[] = [];
	const puts: string[] = [];
	let clock = 10_000_000;
	const kv: DeployKv = {
		get: async (key) => ({ value: values.get(key) ?? null, failed: null }),
		put: async (key, value, opts) => {
			values.set(key, value);
			puts.push(key);
			if (opts?.metadata !== undefined) meta.set(key, opts.metadata);
		},
		list: async (prefix) =>
			[...values.keys()]
				.filter((k) => k.startsWith(prefix))
				.sort()
				.map((name): ListedKey => ({ name, metadata: meta.get(name) ?? { b: values.get(name)?.length ?? 0 } })),
		deleteKeys: async (keys) => {
			for (const k of keys) {
				values.delete(k);
				deleted.push(k);
			}
			return true;
		},
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
	};
	return { kv, values, deleted, puts };
}

/** A generation's keys under format `fmt` — two chunks and a routing filter. */
function family(fmt: number, builtAt: string): Record<string, string> {
	return {
		[chunkKey(`card-store-v${fmt}-${builtAt}-p0.store`, 0)]: "x".repeat(100),
		[chunkKey(`card-store-v${fmt}-${builtAt}-p1.store`, 0)]: "x".repeat(100),
		[routingFilterKey(fmt, builtAt)]: "r",
	};
}
const manifest = (fmt: number, builtAt: string, previous?: string) =>
	JSON.stringify({ built_at: builtAt, format_version: fmt, ...(previous ? { previous_built_at: previous } : {}) });
const familyOf = (values: Map<string, string>, builtAt: string) =>
	[...values.keys()].filter((k) => k.startsWith("store:card-") && k.includes(`-${builtAt}`));

describe("readPublishedManifests", () => {
	test("the legacy mirror and every per-format key, and nothing else under the prefix", async () => {
		const { kv } = memoryKv({
			[MANIFEST_KEY]: manifest(A, "2000"),
			[formatManifestKey(A)]: manifest(A, "2000"),
			[formatManifestKey(B)]: manifest(B, "3000"),
			"store:manifest:vjunk": manifest(B, "9"),
			"store:manifest2": manifest(B, "8"),
		});
		const read = await readPublishedManifests(kv);
		expect(read.failed).toBeNull();
		expect(read.published.map((p) => `${p.key}${p.legacy ? " (legacy)" : ""}=${p.manifest.built_at}`)).toEqual([
			`${MANIFEST_KEY} (legacy)=2000`,
			`${formatManifestKey(A)}=2000`,
			`${formatManifestKey(B)}=3000`,
		]);
	});

	test("a list that fails is `failed`, never an empty namespace", async () => {
		const { kv } = memoryKv({ [MANIFEST_KEY]: manifest(A, "2000") });
		kv.list = async () => null;
		expect((await readPublishedManifests(kv)).failed).not.toBeNull();
	});
});

describe("the deploy never deletes a family some deployed reader serves", () => {
	test("a format-bump deploy keeps the running build's family as live, before its first key and after its manifest", async () => {
		// Production before the bump: format A live at 2000 (rollback 1000), through its key and the mirror.
		const { kv, values } = memoryKv({
			...family(A, "1000"),
			...family(A, "2000"),
			[MANIFEST_KEY]: manifest(A, "2000", "1000"),
			[formatManifestKey(A)]: manifest(A, "2000", "1000"),
			[DEPLOY_FENCE_KEY]: JSON.stringify({ at: 1 }),
		});
		const begun = await beginDeployUpload(kv, { builtAt: "3000", incomingBytes: 200 });
		expect(begun.ok).toBe(true);
		expect(begun.plan?.roles).toEqual({ live: "2000", otherLive: [], rollback: "1000", inFlight: "3000" });
		expect(familyOf(values, "2000").length).toBe(3);
		// The deploy uploads B and writes ITS key only (the mirror holds A).
		for (const [k, v] of Object.entries(family(B, "3000"))) values.set(k, v);
		values.set(formatManifestKey(B), manifest(B, "3000", "2000"));
		// The post-manifest sweep: B live, A still live beside it; A's old rollback is the only thing to go.
		const swept = await sweepGenerationsByRole(kv, { built_at: "3000", format_version: B, previous_built_at: "2000" });
		expect(swept).toBe(3);
		expect(familyOf(values, "1000")).toEqual([]);
		expect(familyOf(values, "2000").length).toBe(3);
		expect(familyOf(values, "3000").length).toBe(3);
		// And nothing of another format's manifest was touched: that is deployed code's to retire.
		expect(values.get(formatManifestKey(A))).toBe(manifest(A, "2000", "1000"));
		expect(values.get(MANIFEST_KEY)).toBe(manifest(A, "2000", "1000"));
	});

	test("a sweep handed the manifest it just wrote ignores a stale read of that key", async () => {
		const { kv, values } = memoryKv({
			...family(B, "2000"),
			...family(B, "3000"),
			[formatManifestKey(B)]: manifest(B, "2000"), // stale: the put of 3000 has not propagated
		});
		await sweepGenerationsByRole(kv, { built_at: "3000", format_version: B, previous_built_at: "2000" });
		expect(familyOf(values, "3000").length).toBe(3);
		expect(familyOf(values, "2000").length).toBe(3);
	});
});

describe("ensureFormatManifest — the migration from the single key", () => {
	test("copies a same-format legacy manifest to this format's key once, and leaves the legacy key alone", async () => {
		const { kv, values, puts } = memoryKv({ [MANIFEST_KEY]: manifest(B, "2000") });
		expect(await ensureFormatManifest(kv, B)).toBe("copied");
		expect(JSON.parse(values.get(formatManifestKey(B)) as string).built_at).toBe("2000");
		expect(puts).toEqual([formatManifestKey(B)]);
		expect(await ensureFormatManifest(kv, B)).toBe("present");
		expect(puts.length).toBe(1);
	});

	test("never copies another format's store under this format's key", async () => {
		const { kv, values } = memoryKv({ [MANIFEST_KEY]: manifest(A, "2000") });
		expect(await ensureFormatManifest(kv, B)).toBe("other-format");
		expect(values.has(formatManifestKey(B))).toBe(false);
	});

	test("an empty namespace is left for the import", async () => {
		const { kv, puts } = memoryKv();
		expect(await ensureFormatManifest(kv, B)).toBe("absent");
		expect(puts).toEqual([]);
	});
});
