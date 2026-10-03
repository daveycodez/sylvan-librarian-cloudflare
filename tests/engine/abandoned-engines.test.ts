// x56: abandoning ONE engine object — the manual lever for an object the platform keeps somewhere bad.
//
// DeckGen, 2026-10-03: engine-wnam-p10 and engine-wnam-p8 coordinated 2,797 of wnam's 3,308 stalled
// gathers, a third of what each coordinated against 1–2% for the other nine coordinators — and p8 had
// been clean until 10-02 12:57:25 UTC, the second its store loaded into p10's isolate. A Durable
// Object cannot be moved, so the lever is to stop using one: its id goes in ABANDONED_ENGINES and
// every stub for its name is built for the name's next epoch instead.
//
// What has to hold, and is pinned here:
//
//   - the Worker and every coordinator resolve a name to the SAME object, from the same list;
//   - only the listed object changes: no other partition, region, generation — or ACCOUNT, since
//     one push deploys this code to two and the list is keyed by object id;
//   - an empty list costs the hot path nothing;
//   - the abandoned object keeps working until it is released, and is released only at a publish,
//     only once it is due, and only when nobody is still calling it.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ABANDONED_ENGINES,
	ABANDONED_QUIET_MS,
	ABANDONED_RELEASE_AFTER_MS,
	type AbandonedEngine,
	abandonedReleaseDue,
	addressAnnouncedEngine,
	currentEngineName,
	MAX_ENGINE_EPOCH,
	parseEngineName,
	placeEngineStub,
	setAbandonedEnginesForTests,
	siblingStub,
	supersededEngine,
	sweepAbandonedEngines,
} from "../../src/engine/engine-namespace";
import type { Env } from "../../src/engine/types";

/** An object id as an account's namespace would hash it: a function of (account, name) only. */
const idOf = (account: string, name: string) => `${account}:${name}`;

/**
 * A SEARCH_ENGINE binding for one account that records what was addressed and how. `strings` counts
 * how many ids were turned into strings — the cost an empty list must not pay.
 */
function fakeEnv(account = "deckgen") {
	const gets: { name: string; options: unknown }[] = [];
	const counters = { strings: 0 };
	const env = {
		SEARCH_ENGINE: {
			idFromName: (name: string) => ({
				name,
				toString: () => {
					counters.strings += 1;
					return idOf(account, name);
				},
			}),
			get: (id: { name: string }, options?: unknown) => {
				gets.push({ name: id.name, options });
				return {};
			},
		},
	} as unknown as Env;
	return { env, gets, counters };
}

const entry = (name: string, since = "2026-10-04T00:00:00Z", account = "deckgen"): AbandonedEngine => ({
	id: idOf(account, name),
	name,
	since,
	why: "test",
});

afterEach(() => setAbandonedEnginesForTests());

describe("the shipped list", () => {
	test("every entry is one object, dated, and named as a partition object", () => {
		// Vacuous while the list is empty; the guard for whoever adds the first entry.
		const ids = ABANDONED_ENGINES.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const e of ABANDONED_ENGINES) {
			expect(e.id).toMatch(/^[0-9a-f]{64}$/);
			expect(parseEngineName(e.name)?.partition).toBeDefined();
			expect(Number.isFinite(Date.parse(e.since))).toBe(true);
			expect(e.why.length).toBeGreaterThan(0);
		}
		expect(ABANDONED_ENGINES.length).toBeLessThanOrEqual(MAX_ENGINE_EPOCH);
	});

	test("with nothing listed, every stub is built for the plain name and no id is ever stringified", () => {
		setAbandonedEnginesForTests([]);
		const { env, gets, counters } = fakeEnv();
		placeEngineStub(env, "wnam", 0, 10);
		siblingStub(env, "engine-wnam-p0", 10);
		expect(gets.map((g) => g.name)).toEqual(["engine-wnam-p10", "engine-wnam-p10"]);
		expect(supersededEngine(env, "engine-wnam-p10")).toBeNull();
		expect(counters.strings).toBe(0);
	});
});

describe("a listed object is never addressed again; its name's next epoch is", () => {
	test("the Worker places the replacement, hinted into the same region", () => {
		setAbandonedEnginesForTests([entry("engine-wnam-p10")]);
		const { env, gets } = fakeEnv();
		placeEngineStub(env, "wnam", 0, 10);
		expect(gets).toEqual([{ name: "engine-wnam-p10-e1", options: { locationHint: "wnam" } }]);
	});

	test("a coordinator's sibling call reaches the replacement, with no hint at all", () => {
		setAbandonedEnginesForTests([entry("engine-wnam-p10")]);
		const { env, gets } = fakeEnv();
		siblingStub(env, "engine-wnam-p3", 10);
		expect(gets).toEqual([{ name: "engine-wnam-p10-e1", options: undefined }]);
	});

	test("the Worker and every coordinator agree on which object is partition k", () => {
		setAbandonedEnginesForTests([entry("engine-wnam-p10"), entry("engine-wnam-p8")]);
		const { env, gets } = fakeEnv();
		for (let k = 0; k < 11; k++) {
			gets.length = 0;
			placeEngineStub(env, "wnam", 0, k);
			// Every coordinator of the region, the two replacements among them.
			for (const label of ["engine-wnam-p0", "engine-wnam-p10-e1", "engine-wnam-p8-e1", "engine-wnam-p10"]) {
				siblingStub(env, label, k);
			}
			const expected = k === 10 || k === 8 ? `engine-wnam-p${k}-e1` : `engine-wnam-p${k}`;
			expect(new Set(gets.map((g) => g.name))).toEqual(new Set([expected]));
			expect(currentEngineName(env, "wnam", 0, k)).toBe(expected);
		}
	});

	test("nothing else moves: other partitions, regions, replicas and generations keep their objects", () => {
		setAbandonedEnginesForTests([entry("engine-wnam-p10")]);
		const { env } = fakeEnv();
		expect(currentEngineName(env, "wnam", 0, 9)).toBe("engine-wnam-p9");
		expect(currentEngineName(env, "enam", 0, 10)).toBe("engine-enam-p10");
		expect(currentEngineName(env, "wnam", 1, 10)).toBe("engine-wnam-1-p10");
		expect(currentEngineName(env, "wnam", 0, 10, 1)).toBe("engine-wnam-g1-p10");
		expect(currentEngineName(env, "wnam", 0)).toBe("engine-wnam");
	});

	test("the neighbour region's hedge still reaches that region's own object", () => {
		// x55 hedges a late sibling call to enam's copy of the partition through placeEngineStub.
		setAbandonedEnginesForTests([entry("engine-wnam-p10")]);
		const { env, gets } = fakeEnv();
		placeEngineStub(env, "enam", 0, 10);
		expect(gets).toEqual([{ name: "engine-enam-p10", options: { locationHint: "enam" } }]);
	});

	test("the same name on ANOTHER ACCOUNT is another object, and is not touched", () => {
		// One push deploys both accounts. DeckGen's engine-wnam-p10 stalls in SEA; daveycodez's is
		// another object in another data center, and an entry keyed by name would have re-rolled it
		// for nothing.
		setAbandonedEnginesForTests([entry("engine-wnam-p10", "2026-10-04T00:00:00Z", "deckgen")]);
		const other = fakeEnv("daveycodez");
		placeEngineStub(other.env, "wnam", 0, 10);
		siblingStub(other.env, "engine-wnam-p0", 10);
		expect(other.gets.map((g) => g.name)).toEqual(["engine-wnam-p10", "engine-wnam-p10"]);
		expect(supersededEngine(other.env, "engine-wnam-p10")).toBeNull();
	});

	test("moving it again: the replacement listed too resolves to the next epoch", () => {
		setAbandonedEnginesForTests([entry("engine-wnam-p10"), entry("engine-wnam-p10-e1")]);
		const { env } = fakeEnv();
		expect(currentEngineName(env, "wnam", 0, 10)).toBe("engine-wnam-p10-e2");
	});

	test("a replacement listed without the object it replaced changes nothing", () => {
		// Resolution starts at the name's own object; -e1 is reached only through an abandoned -e0.
		setAbandonedEnginesForTests([entry("engine-wnam-p10-e1")]);
		const { env } = fakeEnv();
		expect(currentEngineName(env, "wnam", 0, 10)).toBe("engine-wnam-p10");
	});

	test("a chain stops at MAX_ENGINE_EPOCH rather than walking a list gone wrong", () => {
		const chain = [entry("engine-wnam-p10")];
		for (let e = 1; e <= MAX_ENGINE_EPOCH + 3; e++) chain.push(entry(`engine-wnam-p10-e${e}`));
		setAbandonedEnginesForTests(chain);
		const { env } = fakeEnv();
		expect(currentEngineName(env, "wnam", 0, 10)).toBe(`engine-wnam-p10-e${MAX_ENGINE_EPOCH}`);
	});

	test("an entry whose documented name is not the object's name says so, once", () => {
		setAbandonedEnginesForTests([{ ...entry("engine-wnam-p10"), name: "engine-wnam-p1" }]);
		const { env } = fakeEnv();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(currentEngineName(env, "wnam", 0, 10)).toBe("engine-wnam-p10-e1");
			currentEngineName(env, "wnam", 0, 10);
			expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
				"ABANDONED_ENGINES lists deckgen:engine-wnam-p10 as engine-wnam-p1, but it is the object named engine-wnam-p10",
			]);
		} finally {
			warn.mockRestore();
		}
	});

	test("the publish fan-out still reaches the abandoned object, by its exact name", () => {
		setAbandonedEnginesForTests([entry("engine-wnam-p10")]);
		const { env, gets } = fakeEnv();
		addressAnnouncedEngine(env, "engine-wnam-p10");
		addressAnnouncedEngine(env, "engine-wnam-p10-e1");
		expect(gets).toEqual([
			{ name: "engine-wnam-p10", options: undefined },
			{ name: "engine-wnam-p10-e1", options: undefined },
		]);
	});
});

describe("which announced objects nothing addresses any more", () => {
	test("a listed object is superseded by its replacement; the replacement is in use", () => {
		const listed = entry("engine-wnam-p10");
		setAbandonedEnginesForTests([listed]);
		const { env } = fakeEnv();
		expect(supersededEngine(env, "engine-wnam-p10")).toEqual({ by: "engine-wnam-p10-e1", entry: listed });
		expect(supersededEngine(env, "engine-wnam-p10-e1")).toBeNull();
		expect(supersededEngine(env, "engine-wnam-p9")).toBeNull();
	});

	test("an undone move leaves its replacement superseded, with no entry to date it", () => {
		// The entry was deleted: engine-wnam-p10 is addressed again, and -e1 would otherwise be
		// notified, and hold a build, every night for good.
		setAbandonedEnginesForTests([]);
		const { env } = fakeEnv();
		expect(supersededEngine(env, "engine-wnam-p10-e1")).toEqual({ by: "engine-wnam-p10", entry: null });
		expect(supersededEngine(env, "engine-wnam-p10")).toBeNull();
	});

	test("after a second move both earlier objects are superseded by the newest", () => {
		const first = entry("engine-wnam-p10");
		const second = entry("engine-wnam-p10-e1", "2026-10-06T00:00:00Z");
		setAbandonedEnginesForTests([first, second]);
		const { env } = fakeEnv();
		expect(supersededEngine(env, "engine-wnam-p10")).toEqual({ by: "engine-wnam-p10-e2", entry: first });
		expect(supersededEngine(env, "engine-wnam-p10-e1")).toEqual({ by: "engine-wnam-p10-e2", entry: second });
		expect(supersededEngine(env, "engine-wnam-p10-e2")).toBeNull();
	});

	test("a name that is not an engine's is never superseded", () => {
		setAbandonedEnginesForTests([entry("engine-wnam-p10")]);
		const { env } = fakeEnv();
		for (const name of ["singleton", "engine-LAX", "engine-wnam-p10-e0"])
			expect(supersededEngine(env, name)).toBeNull();
	});
});

describe("when an abandoned object gives its storage back", () => {
	const SINCE = "2026-10-04T00:00:00Z";
	const T0 = Date.parse(SINCE);

	test("not before ABANDONED_RELEASE_AFTER_MS past its entry, and never on an unreadable date", () => {
		expect(abandonedReleaseDue(entry("engine-wnam-p10", SINCE), T0)).toBe(false);
		expect(abandonedReleaseDue(entry("engine-wnam-p10", SINCE), T0 + ABANDONED_RELEASE_AFTER_MS - 1)).toBe(false);
		expect(abandonedReleaseDue(entry("engine-wnam-p10", SINCE), T0 + ABANDONED_RELEASE_AFTER_MS)).toBe(true);
		expect(abandonedReleaseDue(entry("engine-wnam-p10", "soon"), T0 + 10 * ABANDONED_RELEASE_AFTER_MS)).toBe(false);
	});

	test("the wait covers a rollout many times over, and the quiet period an isolate's manifest memo", () => {
		// Every isolate runs the version carrying the entry within seconds of its deploy; the Worker's
		// manifest memo and its colo cache are 60s each.
		expect(ABANDONED_RELEASE_AFTER_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
		expect(ABANDONED_QUIET_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
	});

	/** A publish's sweep over `announced`, with objects that answer `release` as `objects` says. */
	async function sweep(
		announced: string[],
		list: AbandonedEngine[],
		nowMs: number,
		objects: Record<string, "idle" | "busy" | "down"> = {},
	) {
		setAbandonedEnginesForTests(list);
		const { env } = fakeEnv();
		const asked: string[] = [];
		const unannounced: string[] = [];
		const lines: string[] = [];
		const result = await sweepAbandonedEngines(announced, {
			superseded: (name) => supersededEngine(env, name),
			release: async (name) => {
				asked.push(name);
				if (objects[name] === "down") throw new Error("Network connection lost");
				return objects[name] === "busy"
					? { released: false, servedAgoMs: 1_200 }
					: { released: true, servedAgoMs: null };
			},
			unannounce: async (name) => {
				unannounced.push(name);
			},
			nowMs,
			log: (line) => lines.push(line),
		});
		return { result, asked, unannounced, lines };
	}
	const WNAM = Array.from({ length: 11 }, (_, k) => `engine-wnam-p${k}`);

	test("nothing listed, nothing announced under an epoch: no object is asked and nothing is logged", async () => {
		const { result, asked, lines } = await sweep(WNAM, [], T0);
		expect(result).toEqual({ released: [], waiting: [], busy: [], failed: [] });
		expect(asked).toEqual([]);
		expect(lines).toEqual([]);
	});

	test("the night of the move: the abandoned object is NOT asked, and stays to be notified", async () => {
		// Both names work during the switch: an isolate still on the old version reaches an object
		// that holds its store, and tonight's publish tells it about the new build like any other.
		const announced = [...WNAM, "engine-wnam-p10-e1"];
		const { result, asked, unannounced, lines } = await sweep(
			announced,
			[entry("engine-wnam-p10", SINCE)],
			T0 + 11 * 3_600_000,
		);
		expect(result).toEqual({ released: [], waiting: ["engine-wnam-p10"], busy: [], failed: [] });
		expect(asked).toEqual([]);
		expect(unannounced).toEqual([]);
		expect(lines).toEqual([
			"Publish notify: abandoned object(s) — engine-wnam-p10 (now engine-wnam-p10-e1) keeps its storage until 12h past 2026-10-04T00:00:00Z",
		]);
	});

	test("a later night: it is released and un-announced together, and its replacement is untouched", async () => {
		const announced = [...WNAM, "engine-wnam-p10-e1"];
		const { result, asked, unannounced, lines } = await sweep(
			announced,
			[entry("engine-wnam-p10", SINCE)],
			T0 + 36 * 3_600_000,
		);
		expect(result).toEqual({ released: ["engine-wnam-p10"], waiting: [], busy: [], failed: [] });
		expect(asked).toEqual(["engine-wnam-p10"]);
		// The announcement goes with the storage, or the next publish would re-create the object.
		expect(unannounced).toEqual(["engine-wnam-p10"]);
		expect(lines).toEqual([
			"Publish notify: abandoned object(s) — engine-wnam-p10 released (abandoned 2026-10-04T00:00:00Z; now engine-wnam-p10-e1)",
		]);
	});

	test("an object somebody is still calling refuses, keeps its announcement, and is asked again next time", async () => {
		const { result, unannounced, lines } = await sweep(WNAM, [entry("engine-wnam-p10", SINCE)], T0 + 36 * 3_600_000, {
			"engine-wnam-p10": "busy",
		});
		expect(result).toEqual({ released: [], waiting: [], busy: ["engine-wnam-p10"], failed: [] });
		expect(unannounced).toEqual([]);
		expect(lines[0]).toContain("engine-wnam-p10 (now engine-wnam-p10-e1) kept: it served a call 1200ms ago");
	});

	test("an object that cannot be reached is neither released nor un-announced, and the sweep does not throw", async () => {
		const { result, unannounced, lines } = await sweep(
			WNAM,
			[entry("engine-wnam-p10", SINCE), entry("engine-wnam-p8", SINCE)],
			T0 + 36 * 3_600_000,
			{ "engine-wnam-p8": "down" },
		);
		expect(result).toEqual({ released: ["engine-wnam-p10"], waiting: [], busy: [], failed: ["engine-wnam-p8"] });
		expect(unannounced).toEqual(["engine-wnam-p10"]);
		expect(lines[0]).toContain(
			"engine-wnam-p8 (now engine-wnam-p8-e1) could not be released (Error: Network connection lost)",
		);
	});

	test("an undone move's replacement is released as soon as it is unused — there is no entry to wait on", async () => {
		const { result, unannounced, lines } = await sweep([...WNAM, "engine-wnam-p10-e1"], [], T0);
		expect(result).toEqual({ released: ["engine-wnam-p10-e1"], waiting: [], busy: [], failed: [] });
		expect(unannounced).toEqual(["engine-wnam-p10-e1"]);
		expect(lines).toEqual([
			"Publish notify: abandoned object(s) — engine-wnam-p10-e1 released (its move was undone; now engine-wnam-p10)",
		]);
	});
});

describe("the publish fan-out runs the sweep, and notifies what it kept", () => {
	const coordinator = readFileSync(join(import.meta.dir, "../../src/import-coordinator.ts"), "utf8");
	const notify = coordinator.slice(
		coordinator.indexOf("const announced = [...(await this.listAllKeys(REGION_LIVE_PREFIX))]"),
	);

	test("the sweep is asked of the announced names the publish is not already retiring", () => {
		const at = notify.indexOf("await sweepAbandonedEngines(");
		expect(at).toBeGreaterThan(-1);
		const call = notify.slice(at, notify.indexOf("const live = announced.filter("));
		expect(call).toContain("announced.filter((name) => !reasons.has(name))");
		expect(call).toContain("superseded: (name) => supersededEngine(this.env, name)");
		// The object decides whether it is still in use; the coordinator only asks.
		expect(call).toContain(").releaseAbandoned(ABANDONED_QUIET_MS)");
		expect(call).toContain("addressAnnouncedEngine(this.env, name)");
		// Storage and announcement go together.
		expect(call).toMatch(/unannounce: \(name\) => this\.env\.STORE_KV\.delete\(`\$\{REGION_LIVE_PREFIX\}\$\{name\}`\)/);
	});

	test("a released object is not notified; a waiting or busy one is, like any live object", () => {
		const live = notify.slice(notify.indexOf("const live = announced.filter("));
		expect(live.slice(0, live.indexOf(");") + 2).replace(/\s+/g, " ")).toBe(
			"const live = announced.filter( (name) => !retire.includes(name) && !abandoned.released.includes(name) && " +
				"!abandoned.failed.includes(name), );",
		);
		// And the sweep comes BEFORE the prepare barrier: nothing prefetches a build into an object
		// the same publish is about to release.
		expect(notify.indexOf("await sweepAbandonedEngines(")).toBeLessThan(notify.indexOf("preparePublish(published)"));
	});

	test("nothing but the choke point reads the list", () => {
		// The Worker's routing, the gather's fan-out and the hedge all go through placeEngineStub and
		// siblingStub; a second reader of the list is a second opinion on which object is partition k.
		for (const file of [
			"index.ts",
			"engine/search-engine-do.ts",
			"engine/sibling-hedge.ts",
			"engine/remote-engine.ts",
		]) {
			const text = readFileSync(join(import.meta.dir, "../../src", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
			expect(text.replace(/(^|[^:])\/\/.*$/gm, "$1")).not.toMatch(
				/ABANDONED_ENGINES|supersededEngine|currentEngineName/,
			);
		}
	});
});
