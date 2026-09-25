// Retention by role, the upload lease, the deploy fence and the byte guard (backlog x3,
// src/engine/kv-retention.ts). Every writer — the coordinator, seed-remote-kv.ts, the prune scripts —
// decides through these, so what they pin is what every writer does.

import { describe, expect, test } from "bun:test";
import {
	DEPLOY_LEASE_OWNER,
	decideByteGuard,
	decideUploadLease,
	encodeUploadLease,
	GENERATION_KEY_PREFIX,
	generationKey,
	generationOfKey,
	KV_GUARD_BYTES,
	keysToRetire,
	type ListedKey,
	listedKeyBytes,
	manifestChunkSizes,
	parseDeployFence,
	parseUploadLease,
	planRetention,
	retainedFamilies,
	rollbackFor,
	type UploadLease,
	withPreviousBuiltAt,
} from "../../src/engine/kv-retention";
import { chunkKey, routingFilterKey } from "../../src/engine/store-kv";
import { tagAliasesKey } from "../../src/engine/tag-aliases";

const FMT = 2026090301;
/** One generation's keys: `parts` partitions of `chunks` chunks, its routing filter and alias map. */
function family(builtAt: string, parts = 2, chunks = 2): string[] {
	const keys: string[] = [];
	for (let k = 0; k < parts; k++) {
		for (let seq = 0; seq < chunks; seq++) keys.push(chunkKey(`card-store-v${FMT}-${builtAt}-p${k}.store`, seq));
	}
	keys.push(routingFilterKey(FMT, builtAt), tagAliasesKey(FMT, builtAt));
	return keys;
}
/** A manifest as far as the rollback stamp goes. */
type Stamp = { built_at: string; previous_built_at?: string };
const OTHERS = ["store:manifest", "store:publishing", "rulings:v2:00", "reference:v2:sets:list", "oracle-index:v1:3f"];
const sized = (names: string[], b: number): ListedKey[] => names.map((name) => ({ name, metadata: { b } }));

describe("what a family is", () => {
	test("every per-generation kind groups by built_at — chunks, filter, aliases, and kinds added later", () => {
		expect(generationOfKey(chunkKey(`card-store-v${FMT}-1000-p3.store`, 7))).toBe("1000");
		expect(generationOfKey(routingFilterKey(FMT, "1000"))).toBe("1000");
		expect(generationOfKey(tagAliasesKey(FMT, "1000"))).toBe("1000");
		expect(generationOfKey("store:card-compat-v11-1000.store:0")).toBe("1000");
		// A per-generation value named through generationKey is in its family with no change to
		// retention — n8's names blob, or anything after it.
		expect(generationKey("names", FMT, "1000")).toBe(`store:card-names-v${FMT}-1000.store:0`);
		expect(generationOfKey(generationKey("names", FMT, "1000"))).toBe("1000");
		expect(generationOfKey(`store:card-names-v${FMT}-1000`)).toBe("1000");
	});

	test("a -p suffix never leaks into the built_at", () => {
		expect(generationOfKey("store:card-store-v1-100-p10.store:0")).toBe("100");
	});

	test("the suffix-less pre-partition family still groups, so the ordinary sweep collects it", () => {
		expect(generationOfKey("store:card-store-v2026081402-500.store:1")).toBe("500");
	});

	test("nothing outside the generation prefix is a family: stable keys are never retired", () => {
		for (const key of [...OTHERS, "engine:live:enam-p0", "import:coordinator", "import:deploy-fence"]) {
			expect(generationOfKey(key)).toBeNull();
		}
		expect(OTHERS.filter((k) => k.startsWith(GENERATION_KEY_PREFIX))).toEqual([]);
	});

	test("generationKey refuses a kind the pattern would not match", () => {
		expect(() => generationKey("Names", FMT, "1")).toThrow();
		expect(() => generationKey("na-mes", FMT, "1")).toThrow();
	});
});

describe("retention by role", () => {
	test("at most three families are kept, by construction", () => {
		expect([...retainedFamilies({ live: "3", rollback: "2", inFlight: "4" })].sort()).toEqual(["2", "3", "4"]);
		expect([...retainedFamilies({ live: "3", rollback: null, inFlight: "3" })]).toEqual(["3"]);
	});

	test("an orphan NEWER than live is retired — the superseded run that used to push the rollback out", () => {
		// 09-24 on the free account: a replaced run's half-uploaded family (3000) was newer than the
		// live one (2000), survived the newest-two sweep, and the real rollback (1000) went instead.
		const names = [...family("1000"), ...family("2000"), ...family("3000", 1, 1), ...OTHERS];
		const retire = keysToRetire(names, { live: "2000", rollback: "1000", inFlight: null });
		expect(retire.sort()).toEqual(family("3000", 1, 1).sort());
	});

	test("the in-flight family is kept however old and however partial (2026-09-15)", () => {
		// The coordinator's generation, older than both deploy-built ones that landed while it crawled.
		const names = [...family("1789224220", 8, 1), ...family("1789417939"), ...family("1789424305")];
		const roles = { live: "1789424305", rollback: "1789417939", inFlight: "1789224220" };
		expect(keysToRetire(names, roles)).toEqual([]);
		// Without the lease it has no role, and goes: the lease IS its protection.
		expect(keysToRetire(names, { ...roles, inFlight: null }).length).toBe(family("1789224220", 8, 1).length);
	});

	test("the live family survives however old it is — a republished older manifest is a rollback", () => {
		const names = [...family("1000"), ...family("2000")];
		expect(keysToRetire(names, { live: "1000", rollback: null, inFlight: null }).sort()).toEqual(family("2000").sort());
	});

	test("an N-partition family retires all or nothing", () => {
		const names = [...family("1000", 3, 2), ...family("2000")];
		const retire = keysToRetire(names, { live: "2000", rollback: null, inFlight: null });
		expect(retire.length).toBe(family("1000", 3, 2).length);
		expect(retire.some((k) => k.includes("-2000"))).toBe(false);
	});

	test("NO manifest retires nothing: the only store there is must not be swept", () => {
		expect(
			keysToRetire([...family("1000"), ...family("2000")], { live: null, rollback: null, inFlight: "2000" }),
		).toEqual([]);
	});
});

describe("the rollback role", () => {
	test("is the manifest's previous_built_at", () => {
		expect(rollbackFor({ built_at: "3000", previous_built_at: "1000" }, ["2000", "1000"])).toBe("1000");
	});

	test("a manifest from before x3 falls back to the newest family OLDER than live, never a newer one", () => {
		expect(rollbackFor({ built_at: "2000" }, [...family("3000"), ...family("1000"), ...family("500")])).toBe("1000");
		// …and never the in-flight upload, which has a role of its own.
		expect(rollbackFor({ built_at: "2000" }, [...family("1500"), ...family("1000")], "1500")).toBe("1000");
		expect(rollbackFor({ built_at: "2000" }, family("3000"))).toBeNull();
	});

	test("withPreviousBuiltAt records the build being replaced", () => {
		expect(withPreviousBuiltAt<Stamp>({ built_at: "3000" }, { built_at: "2000", previous_built_at: "1000" })).toEqual({
			built_at: "3000",
			previous_built_at: "2000",
		});
	});

	test("republishing the SAME build keeps its rollback rather than naming itself", () => {
		expect(withPreviousBuiltAt<Stamp>({ built_at: "2000" }, { built_at: "2000", previous_built_at: "1000" })).toEqual({
			built_at: "2000",
			previous_built_at: "1000",
		});
	});

	test("no live manifest, no rollback — and a stale field on the input is not carried", () => {
		expect(withPreviousBuiltAt<Stamp>({ built_at: "2000", previous_built_at: "9" }, null)).toEqual({
			built_at: "2000",
		});
	});
});

describe("the upload lease", () => {
	const coordinator = (built_at: string, epoch: number, owner = `import-${epoch}`): UploadLease => ({
		built_at,
		owner,
		epoch,
	});

	test("round-trips, and a pre-x3 bare built_at parses as the lowest claim", () => {
		const lease = coordinator("1789", 1_700_000_000_000);
		expect(parseUploadLease(encodeUploadLease(lease))).toEqual(lease);
		expect(parseUploadLease("1789224220\n")).toEqual({ built_at: "1789224220", owner: "", epoch: -1 });
		expect(parseUploadLease(null)).toBeNull();
		expect(parseUploadLease("garbage")).toBeNull();
		expect(parseUploadLease('{"built_at":"x"}')).toBeNull();
	});

	test("reads `wrangler kv key get` output with a banner in front, as the deploy side gets it", () => {
		// deployStillHoldsLease reads null as "another deploy took it" and refuses the manifest, so a
		// parse stricter than the values written would fail every deploy.
		const lease = { built_at: "1789", owner: "deploy", epoch: 5 };
		expect(parseUploadLease(`⛅️ wrangler 4.119.0\n${encodeUploadLease(lease)}\n`)).toEqual(lease);
		expect(parseUploadLease("banner 4.119.0\n1789224220")).toEqual({ built_at: "1789224220", owner: "", epoch: -1 });
		expect(parseDeployFence('banner\n{"at":7}')).toEqual({ at: 7 });
	});

	test("free, or the same family: take it", () => {
		expect(decideUploadLease(null, coordinator("2", 5)).kind).toBe("take");
		expect(decideUploadLease(coordinator("2", 5), coordinator("2", 5)).kind).toBe("take");
	});

	test("a HIGHER epoch takes it; a lower one yields — the replaced run never takes it back", () => {
		const old = coordinator("1", 100);
		const fresh = coordinator("2", 200);
		expect(decideUploadLease(old, fresh)).toEqual({ kind: "take", displaced: old });
		expect(decideUploadLease(fresh, old).kind).toBe("yield");
	});

	test("a later run of the same coordinator takes over the lease its earlier run leaked", () => {
		expect(decideUploadLease(coordinator("1", 0, "singleton"), coordinator("2", 0, "singleton")).kind).toBe("take");
	});

	test("the deploy takes it from anyone, and only a deploy takes it from the deploy", () => {
		const deploy: UploadLease = { built_at: "9", owner: DEPLOY_LEASE_OWNER, epoch: 1 };
		expect(decideUploadLease(coordinator("1", Number.MAX_SAFE_INTEGER), deploy).kind).toBe("take");
		expect(decideUploadLease(deploy, coordinator("2", Number.MAX_SAFE_INTEGER)).kind).toBe("yield");
		expect(decideUploadLease(deploy, { ...deploy, built_at: "10" }).kind).toBe("take");
	});

	test("any claimant outranks a pre-x3 lease", () => {
		expect(decideUploadLease(parseUploadLease("1789"), coordinator("2", 0, "singleton")).kind).toBe("take");
	});
});

describe("the deploy fence", () => {
	test("parses its own shape and nothing else", () => {
		expect(parseDeployFence({ at: 5 })).toEqual({ at: 5 });
		expect(parseDeployFence('{"at":5}')).toEqual({ at: 5 });
		expect(parseDeployFence(null)).toBeNull();
		expect(parseDeployFence({ at: "5" })).toBeNull();
		expect(parseDeployFence("nope")).toBeNull();
	});
});

describe("the byte guard", () => {
	test("go / drop the rollback / refuse", () => {
		expect(decideByteGuard({ used: 500, rollbackBytes: 150, incoming: 160, limit: 950 }).decision).toBe("go");
		expect(decideByteGuard({ used: 800, rollbackBytes: 300, incoming: 160, limit: 950 })).toEqual({
			decision: "drop-rollback",
			projected: 660,
		});
		expect(decideByteGuard({ used: 900, rollbackBytes: 50, incoming: 160, limit: 950 }).decision).toBe("refuse");
		// No rollback to drop: over is over.
		expect(decideByteGuard({ used: 900, rollbackBytes: 0, incoming: 160, limit: 950 }).decision).toBe("refuse");
	});

	test("a key's size is its metadata; a legacy key is estimated, never zero", () => {
		expect(listedKeyBytes({ name: "store:card-store-v1-1-p0.store:0", metadata: { b: 123 } })).toEqual({
			bytes: 123,
			exact: true,
		});
		const legacyChunk = listedKeyBytes({ name: "store:card-store-v1-1-p0.store:0" });
		expect(legacyChunk.exact).toBe(false);
		expect(legacyChunk.bytes).toBeGreaterThan(20_000_000);
		expect(listedKeyBytes({ name: "engine:live:enam-p0" }).bytes).toBeGreaterThan(0);
	});

	test("the live manifest sizes its own legacy chunks exactly", () => {
		const live = {
			built_at: "1",
			partitions: [
				{
					store_key: "card-store-v1-1-p0.store",
					store_bytes: 40,
					store_gzip_bytes: 20,
					chunk_count: 2,
					card_count: 1,
					printing_count: 1,
				},
			],
		};
		const known = manifestChunkSizes(live);
		expect(listedKeyBytes({ name: "store:card-store-v1-1-p0.store:1" }, known)).toEqual({ bytes: 10, exact: false });
	});
});

describe("planRetention — the whole decision", () => {
	const MB = 1_000_000;
	/** Families of ~`mb` MB (four chunk keys carry it) with every key sized. */
	const gen = (builtAt: string, mb: number): ListedKey[] =>
		family(builtAt).map((name) => ({ name, metadata: { b: name.includes("card-store-") ? (mb * MB) / 4 : 0 } }));
	const live = (builtAt: string, prev: string, mb: number) => ({
		built_at: builtAt,
		previous_built_at: prev,
		store_gzip_bytes: mb * MB,
	});
	const stable = sized(OTHERS, 10 * MB); // 50 MB of rulings, reference, index, control keys

	test("1x corpus: the orphan goes, three roles stay, the new family fits", () => {
		const keys = [...gen("1000", 150), ...gen("2000", 150), ...gen("2500", 70), ...stable];
		const plan = planRetention(keys, { live: live("2000", "1000", 150), inFlight: "3000", incomingBytes: 165 * MB });
		expect(plan.decision).toBe("go");
		expect(plan.roles).toEqual({ live: "2000", rollback: "1000", inFlight: "3000" });
		expect(plan.retire.sort()).toEqual(family("2500").sort());
		expect(plan.usedBytes).toBe(350 * MB);
	});

	test("2x corpus: the rollback is dropped so the new family fits", () => {
		const keys = [...gen("1000", 300), ...gen("2000", 300), ...stable];
		const plan = planRetention(keys, { live: live("2000", "1000", 300), inFlight: "3000", incomingBytes: 330 * MB });
		expect(plan.decision).toBe("drop-rollback");
		expect(plan.roles.rollback).toBeNull();
		expect(plan.retire.sort()).toEqual(family("1000").sort());
		expect(plan.projectedBytes).toBeLessThanOrEqual(KV_GUARD_BYTES);
	});

	test("3x corpus: even live-only does not fit — refuse, and retire nothing extra for it", () => {
		const keys = [...gen("1000", 450), ...gen("2000", 450), ...stable];
		const plan = planRetention(keys, { live: live("2000", "1000", 450), inFlight: "3000", incomingBytes: 495 * MB });
		expect(plan.decision).toBe("refuse");
		expect(plan.retire.some((k) => k.includes("-2000"))).toBe(false);
	});

	test("a sweep without an incoming family never runs the guard", () => {
		const keys = [...gen("1000", 450), ...gen("2000", 450), ...gen("500", 450), ...stable];
		const plan = planRetention(keys, { live: live("2000", "1000", 450), inFlight: null });
		expect(plan.decision).toBe("sweep");
		expect(plan.retire.sort()).toEqual(family("500").sort());
	});

	test("never retires the live family, even when the rollback role names it", () => {
		const keys = [...gen("2000", 100)];
		const plan = planRetention(keys, { live: live("2000", "2000", 100), inFlight: null, incomingBytes: 2_000 * MB });
		expect(plan.retire).toEqual([]);
		expect(plan.decision).toBe("refuse");
	});
});
