// The bulk trigger (src/import-bulk-trigger.ts): when a store is behind Scryfall's dumps, when
// Scryfall's refresh is still in progress, and what each trigger does when it cannot ask. The
// coordinator's half — a run in flight, dumps already tried — is `bun run harness:failover` (10).

import { describe, expect, test } from "bun:test";
import { ARCHIVE_FORMAT_VERSION, formatManifestKey, MANIFEST_KEY } from "../../src/engine/store-kv";
import {
	bulkGate,
	bulkSettled,
	bulkStamps,
	judgeStore,
	liveStoreBuiltAt,
	SETTLE_MS,
	TURNOVER_SPREAD_MS,
} from "../../src/import-bulk-trigger";
import { DUMP_KINDS } from "../../src/import-phases";

const at = (iso: string) => Date.parse(iso);

/** Scryfall's listing on 2026-11-13 after its refresh, and the previous night's for the rest. */
function listing(stamps: Partial<Record<string, string>>, fallback = "2026-11-12T22:20:00Z") {
	return {
		data: DUMP_KINDS.map((type): { type: string; updated_at: string } => ({
			type,
			updated_at: stamps[type] ?? fallback,
		})),
	};
}
/** bulkStamps, or a test failure — never a non-null assertion. */
function stampsOf(l: unknown) {
	const s = bulkStamps(l);
	if (s === null) throw new Error("the listing gave no stamps");
	return s;
}
const REFRESHED_1113 = {
	rulings: "2026-11-13T22:00:32Z",
	oracle_tags: "2026-11-13T22:00:31Z",
	art_tags: "2026-11-13T22:01:13Z",
	oracle_cards: "2026-11-13T22:01:58Z",
	default_cards: "2026-11-13T22:06:41Z",
	all_cards: "2026-11-13T22:22:58Z",
};

describe("bulkStamps", () => {
	test("the newest and oldest over the dumps the import reads", () => {
		const s = bulkStamps(listing(REFRESHED_1113));
		expect(s).toEqual({ newestMs: at("2026-11-13T22:22:58Z"), oldestMs: at("2026-11-13T22:00:31Z") });
	});

	test("a dump missing from the listing, or without a stamp, is no answer at all", () => {
		const missing = { data: listing(REFRESHED_1113).data.filter((r) => r.type !== "all_cards") };
		expect(bulkStamps(missing)).toBeNull();
		const blank = listing({ ...REFRESHED_1113, all_cards: "not a date" });
		expect(bulkStamps(blank)).toBeNull();
		expect(bulkStamps(null)).toBeNull();
		expect(bulkStamps({})).toBeNull();
	});

	test("kinds outside the list are not this gate's business", () => {
		const extra = listing(REFRESHED_1113);
		extra.data.push({ type: "unique_artwork", updated_at: "2027-01-01T00:00:00Z" });
		expect(bulkStamps(extra)?.newestMs).toBe(at("2026-11-13T22:22:58Z"));
	});
});

describe("bulkSettled", () => {
	test("a whole refresh, every dump within the spread, is settled the moment it ends", () => {
		const s = stampsOf(listing(REFRESHED_1113));
		expect(s.newestMs - s.oldestMs).toBeLessThan(TURNOVER_SPREAD_MS);
		expect(bulkSettled(s, at("2026-11-13T22:23:30Z"))).toBe(true);
	});

	test("2026-11-13 22:12 UTC: default_cards new, all_cards still yesterday's — mid-refresh", () => {
		const s = stampsOf(listing({ ...REFRESHED_1113, all_cards: "2026-11-12T22:21:40Z" }));
		expect(bulkSettled(s, at("2026-11-13T22:12:00Z"))).toBe(false);
	});

	test("a dump Scryfall did not regenerate that day stops blocking once the newest is SETTLE_MS old", () => {
		const s = stampsOf(listing({ ...REFRESHED_1113, rulings: "2026-11-10T22:00:00Z" }));
		expect(bulkSettled(s, s.newestMs + SETTLE_MS - 1)).toBe(false);
		expect(bulkSettled(s, s.newestMs + SETTLE_MS)).toBe(true);
	});
});

describe("judgeStore", () => {
	const settled = stampsOf(listing(REFRESHED_1113));

	test("a store built after the newest dump is current", () => {
		expect(judgeStore(settled, at("2026-11-13T23:10:00Z"), at("2026-11-14T03:00:00Z")).kind).toBe("current");
	});

	test("the 2026-11-13 night: the 11:25 nightly's store is stale once the refresh settles", () => {
		const v = judgeStore(settled, at("2026-11-13T11:25:09Z"), at("2026-11-13T22:30:00Z"));
		expect(v.kind).toBe("stale");
		expect(v.why).toContain("2026-11-13T22:22:58");
	});

	test("the 22:15:58 deploy's store — built mid-refresh — is stale after it, though newer than most dumps", () => {
		expect(judgeStore(settled, at("2026-11-13T22:15:58Z"), at("2026-11-13T22:30:00Z")).kind).toBe("stale");
	});

	test("behind a refresh still in progress, it waits rather than build from mixed days", () => {
		const mid = stampsOf(listing({ ...REFRESHED_1113, all_cards: "2026-11-12T22:21:40Z" }));
		const v = judgeStore(mid, at("2026-11-13T11:25:09Z"), at("2026-11-13T22:12:00Z"));
		expect(v.kind).toBe("settling");
		expect(v.why).toContain("mid-refresh");
	});

	test("no store at all is stale, once settled", () => {
		expect(judgeStore(settled, null, at("2026-11-13T22:30:00Z")).kind).toBe("stale");
	});
});

class MapKV {
	readonly values = new Map<string, string>();
	async get(key: string, _type: "json"): Promise<unknown> {
		const v = this.values.get(key);
		return v === undefined ? null : JSON.parse(v);
	}
}

describe("liveStoreBuiltAt", () => {
	test("reads this format's manifest, in ms", async () => {
		const kv = new MapKV();
		kv.values.set(formatManifestKey(ARCHIVE_FORMAT_VERSION), JSON.stringify({ built_at: "1794608158" }));
		expect(await liveStoreBuiltAt(kv)).toBe(1_794_608_158_000);
	});

	test("the legacy key counts only for this format", async () => {
		const kv = new MapKV();
		kv.values.set(MANIFEST_KEY, JSON.stringify({ built_at: "100", format_version: ARCHIVE_FORMAT_VERSION }));
		expect(await liveStoreBuiltAt(kv)).toBe(100_000);
		kv.values.set(MANIFEST_KEY, JSON.stringify({ built_at: "100", format_version: ARCHIVE_FORMAT_VERSION - 1 }));
		expect(await liveStoreBuiltAt(kv)).toBeNull();
	});

	test("a KV failure is 'error', not 'no store'", async () => {
		const broken = { get: async () => Promise.reject(new Error("kv down")) };
		expect(await liveStoreBuiltAt(broken)).toBe("error");
	});
});

describe("bulkGate", () => {
	const now = at("2026-11-13T22:30:00Z");
	const nightlyStore = () => {
		const kv = new MapKV();
		kv.values.set(
			formatManifestKey(ARCHIVE_FORMAT_VERSION),
			JSON.stringify({ built_at: String(at("2026-11-13T11:25:09Z") / 1000) }),
		);
		return kv;
	};

	test("stale and settled starts, carrying the newest dump's stamp", async () => {
		const gate = await bulkGate(nightlyStore(), now, false, async () => listing(REFRESHED_1113));
		expect(gate).toMatchObject({ kind: "start", bulkMs: at("2026-11-13T22:22:58Z") });
	});

	test("the tick never starts on a listing it could not read; the backstop does", async () => {
		const fail = async () => Promise.reject(new Error("503"));
		expect((await bulkGate(nightlyStore(), now, false, fail)).kind).toBe("skip");
		expect(await bulkGate(nightlyStore(), now, true, fail)).toMatchObject({ kind: "start", bulkMs: null });
	});

	test("the backstop skips a store the tick already built from these dumps", async () => {
		const kv = new MapKV();
		kv.values.set(
			formatManifestKey(ARCHIVE_FORMAT_VERSION),
			JSON.stringify({ built_at: String(at("2026-11-13T23:12:00Z") / 1000) }),
		);
		const gate = await bulkGate(kv, at("2026-11-14T11:17:00Z"), true, async () => listing(REFRESHED_1113));
		expect(gate.kind).toBe("skip");
		expect(gate.why).toContain("has Scryfall's");
	});

	test("mid-refresh, neither trigger starts", async () => {
		const mid = async () => listing({ ...REFRESHED_1113, all_cards: "2026-11-12T22:21:40Z" });
		for (const backstop of [false, true]) {
			expect((await bulkGate(nightlyStore(), at("2026-11-13T22:12:00Z"), backstop, mid)).kind).toBe("skip");
		}
	});
});
