// x100: self-healing engine placement — the nightly's automatic version of ABANDONED_ENGINES.
//
// What has to hold, and is pinned here:
//
//   - the judge moves an object whose colo is far from its replica's home on the first night it is
//     seen, a sick one only on the second consecutive night, and nothing that is merely scattered
//     within a metro area (DeckGen's weur in AMS/LHR/CDG, eeur in WAW/VIE/FRA);
//   - the limits: a few moves a night, one per replica, a cooldown per name, a give-up after
//     MAX_AUTO_MOVES or at MAX_ENGINE_EPOCH, and pins that override all of it;
//   - the move rides the manifest: the epoch a judge writes is the epoch every stub builder
//     resolves (Worker, coordinator, hedge), the old name keeps answering until it is released, and
//     it is released only once the move is ABANDONED_RELEASE_AFTER_MS old and unused;
//   - the evidence the objects keep costs a bounded number of rows a day.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EngineReport,
	HEALTH_FULL_WRITES,
	HEALTH_SAMPLE,
	healthReport,
	noteHealth,
	readHealth,
	utcDay,
} from "../../src/engine/engine-health";
import {
	coloKm,
	type EngineMove,
	gatherEngineReports,
	homeColo,
	type JudgeInput,
	judgeEngines,
	MAX_AUTO_MOVES,
	MAX_MOVES_PER_NIGHT,
	MISPLACED_KM,
	MOVE_COOLDOWN_MS,
	SICK_HEDGES_MIN,
	seedMoves,
} from "../../src/engine/engine-moves";
import {
	ABANDONED_QUIET_MS,
	ABANDONED_RELEASE_AFTER_MS,
	type AbandonedEngine,
	currentEngineName,
	engineMoveRecord,
	epochFloorOf,
	MAX_ENGINE_EPOCH,
	placeEngineStub,
	seedSiblingStub,
	setAbandonedEnginesForTests,
	siblingStub,
	supersededEngine,
	sweepAbandonedEngines,
} from "../../src/engine/engine-namespace";
import { nextPlacement, type PlacementBlock, UNSERVED_SEED } from "../../src/engine/placement-policy";
import { recordPlacement } from "../../src/engine/store-cache";
import type { Env } from "../../src/engine/types";

const NIGHT = Date.parse("2026-10-24T11:30:00Z");
const DAY = 86_400_000;

afterEach(() => setAbandonedEnginesForTests([]));

/** One object's report: colo measured an hour ago, a quiet day unless told otherwise. */
function report(name: string, colo: string | null, extra: Partial<EngineReport> = {}): EngineReport {
	return {
		name,
		colo,
		coloAt: colo === null ? null : NIGHT - 3_600_000,
		day: "2026-10-23",
		loads: 100,
		around: {},
		...extra,
	};
}

/** `count` partitions of a region, each in the colo `colos(k)` says. */
function replica(
	region: string,
	count: number,
	colos: (k: number) => string,
	extra: (k: number) => Partial<EngineReport> = () => ({}),
) {
	return Array.from({ length: count }, (_, k) => report(`engine-${region}-p${k}`, colos(k), extra(k)));
}

/**
 * A judge over `reports`, every name served, every name resolving to the object that reported. A
 * colo measured "an hour ago" is an hour before the night judged (placement.ts re-measures daily).
 */
function judge(reports: EngineReport[], over: Partial<JudgeInput> = {}) {
	const nowMs = over.nowMs ?? NIGHT;
	return judgeEngines({
		previous: undefined,
		reports: reports.map((r) => (r.coloAt === NIGHT - 3_600_000 ? { ...r, coloAt: nowMs - 3_600_000 } : r)),
		currentNameOf: (name0) => {
			const r = reports.find((x) => x.name === name0 || x.name.startsWith(`${name0}-e`));
			return r?.name ?? name0;
		},
		served: () => true,
		pins: null,
		nowMs: NIGHT,
		...over,
	});
}

describe("distance and home", () => {
	test("great-circle distances from the colo table, in km", () => {
		expect(coloKm("SEA", "SEA")).toBe(0);
		expect(coloKm("SEA", "DFW")).toBeGreaterThan(2_600);
		expect(coloKm("EWR", "IAD")).toBeLessThan(400);
		expect(coloKm("AMS", "LHR")).toBeLessThan(MISPLACED_KM);
		expect(coloKm("ICN", "SIN")).toBeGreaterThan(4_000);
		expect(coloKm("SEA", "NOPE")).toBeUndefined();
	});

	test("the home is the medoid: a colo where objects are, nearest the rest", () => {
		expect(homeColo(["SEA", "SEA", "SEA", "DFW"])).toEqual({ colo: "SEA", count: 3 });
		// apac-ne on DeckGen: KIX 6, NRT 5, ICN 1 — KIX is nearer the lot than NRT.
		expect(homeColo([...Array(6).fill("KIX"), ...Array(5).fill("NRT"), "ICN"])?.colo).toBe("KIX");
		expect(homeColo([])).toBeNull();
	});
});

describe("the judge, on synthetic evidence", () => {
	test("DeckGen's wnam (2026-10-23): eleven in SEA, p11 in DFW — p11 moves on the first night, seeded from p0", () => {
		const reports = replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA"));
		const out = judge(reports);
		expect(out.moves).toEqual([
			{
				name0: "engine-wnam-p11",
				from: "engine-wnam-p11",
				to: "engine-wnam-p11-e1",
				epoch: 1,
				host: "engine-wnam-p0",
				why: expect.stringContaining("misplaced: colo DFW"),
			},
		]);
		expect(out.engines).toEqual({
			"engine-wnam-p11": { e: 1, since: new Date(NIGHT).toISOString(), moves: 1, why: expect.any(String) },
		});
		expect(out.lines[0]).toMatch(
			/^Engine placement: moved engine-wnam-p11 -> engine-wnam-p11-e1 — misplaced: colo DFW, \d+km vs home SEA \(11 of 12\); .*seeded from engine-wnam-p0 in SEA; automatic move 1 of 3$/,
		);
		expect(out.lines.at(-1)).toBe(
			"Engine placement: judged 12 object(s) in 1 replica(s); 1 moved, 0 kept, 0 gave up, 0 pinned; homes wnam SEA 11/12",
		);
	});

	test("scatter within a metro area is not misplacement: DeckGen's weur and eeur keep every object", () => {
		const weur = replica("weur", 12, (k) => ["AMS", "AMS", "LHR", "AMS", "CDG", "LHR"][k % 6] as string);
		const eeur = replica("eeur", 12, (k) => ["WAW", "VIE", "WAW", "FRA", "WAW", "VIE"][k % 6] as string);
		const out = judge([...weur, ...eeur]);
		expect(out.moves).toEqual([]);
		expect(out.engines).toBeUndefined();
		expect(out.lines).toHaveLength(1);
	});

	test("a stale colo, an unknown colo, or too few reporting objects judges no colo", () => {
		const stale = replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA"));
		(stale[11] as EngineReport).coloAt = NIGHT - 3 * DAY;
		expect(judge(stale).moves).toEqual([]);
		const small = replica("wnam", 3, (k) => (k === 2 ? "DFW" : "SEA"));
		expect(judge(small).moves).toEqual([]);
		const unknown = replica("wnam", 12, (k) => (k === 11 ? "XXX" : "SEA"));
		expect(judge(unknown).moves).toEqual([]);
	});

	test("no clear home (fewer than 40% in any colo) judges no colo", () => {
		const scattered = replica("enam", 10, (k) => ["EWR", "ATL", "ORD", "MIA", "DFW"][k % 5] as string);
		expect(judge(scattered).moves).toEqual([]);
	});

	test("a sick object (hedged around) is kept on night 1 and moved on night 2", () => {
		// p8 is hedged around 132 times by its siblings (127 by p3, 5 by p7); every other partition 5.
		const reports = replica(
			"wnam",
			12,
			() => "SEA",
			(k) => ({ around: { "8": k === 3 ? 127 : 0, [String((k + 1) % 12)]: 5 } }),
		);
		const night1 = judge(reports);
		expect(night1.moves).toEqual([]);
		expect(night1.engines?.["engine-wnam-p8"]).toEqual({
			strikes: 1,
			seen: new Date(NIGHT).toISOString(),
		});
		expect(night1.lines[0]).toMatch(
			/^Engine placement: kept engine-wnam-p8 — sick \(hedged around 132 times .*night 1 of 2$/,
		);
		const night2 = judge(reports, { previous: night1.engines, nowMs: NIGHT + DAY });
		expect(night2.moves.map((m) => m.to)).toEqual(["engine-wnam-p8-e1"]);
		expect(night2.moves[0]?.host).toBe("engine-wnam-p0");
		expect(night2.engines?.["engine-wnam-p8"]).toMatchObject({ e: 1, moves: 1 });
	});

	test("a skipped night or a healthy night breaks a sick run", () => {
		const sick = replica(
			"wnam",
			12,
			() => "SEA",
			(k): Partial<EngineReport> => ({ around: k === 0 ? { "5": 200 } : {} }),
		);
		const night1 = judge(sick);
		expect(night1.engines?.["engine-wnam-p5"]?.strikes).toBe(1);
		// Two days later (a failed nightly in between): the run starts over.
		const late = judge(sick, { previous: night1.engines, nowMs: NIGHT + 2 * DAY });
		expect(late.moves).toEqual([]);
		expect(late.engines?.["engine-wnam-p5"]?.strikes).toBe(1);
		// Healthy the next night: the record goes.
		const healthy = judge(
			replica("wnam", 12, () => "SEA"),
			{ previous: night1.engines, nowMs: NIGHT + DAY },
		);
		expect(healthy.engines).toBeUndefined();
	});

	test("a name whose object did not report keeps its run untouched", () => {
		const sick = replica(
			"wnam",
			12,
			() => "SEA",
			(k): Partial<EngineReport> => ({ around: k === 0 ? { "5": 200 } : {} }),
		);
		const night1 = judge(sick);
		const silent = judge(
			sick.filter((r) => r.name !== "engine-wnam-p5"),
			{ previous: night1.engines, nowMs: NIGHT + DAY },
		);
		expect(silent.engines?.["engine-wnam-p5"]).toEqual(night1.engines?.["engine-wnam-p5"]);
	});

	test("the hedge bar is relative: a replica that hedges everyone a lot flags no one", () => {
		const busy = replica(
			"wnam",
			12,
			() => "SEA",
			() => ({
				around: Object.fromEntries(Array.from({ length: 12 }, (_, p) => [String(p), 20])),
			}),
		);
		// Every partition hedged around 240 times — the median — so none is 5x the median.
		expect(judge(busy).engines).toBeUndefined();
		// An absolute floor too: a quiet replica's 10 against a median of 0 is not sick.
		const quiet = replica(
			"wnam",
			12,
			() => "SEA",
			(k): Partial<EngineReport> => ({ around: k === 0 ? { "4": SICK_HEDGES_MIN - 1 } : {} }),
		);
		expect(judge(quiet).engines).toBeUndefined();
	});

	test("a reload storm is sick: loads far above the replica's median", () => {
		const storm = replica(
			"wnam",
			12,
			() => "SEA",
			(k) => ({ loads: k === 8 ? 4_000 : 300 }),
		);
		const night1 = judge(storm);
		expect(night1.lines[0]).toContain("4000 store loads on 2026-10-23");
		const night2 = judge(storm, { previous: night1.engines, nowMs: NIGHT + DAY });
		expect(night2.moves.map((m) => m.to)).toEqual(["engine-wnam-p8-e1"]);
	});

	test("a superseded object's report does not speak for its name, and an unserved name's record goes", () => {
		// engine-wnam-p8 is ABANDONED (the name resolves to -e2): its own report, from DFW, is ignored.
		const reports = [...replica("wnam", 12, () => "SEA"), report("engine-wnam-p8-e1", "SJC")];
		reports[8] = report("engine-wnam-p8", "DFW");
		reports.push(report("engine-wnam-p8-e2", "SEA"));
		const out = judge(reports, {
			currentNameOf: (name0) => (name0 === "engine-wnam-p8" ? "engine-wnam-p8-e2" : name0),
		});
		expect(out.moves).toEqual([]);
		const gone = judge(
			replica("wnam", 4, () => "SEA"),
			{
				previous: { "engine-wnam-p11": { e: 1, since: "2026-10-01T00:00:00Z", moves: 1 } },
				served: (name0) => name0 !== "engine-wnam-p11",
			},
		);
		expect(gone.engines).toBeUndefined();
	});
});

describe("the limits", () => {
	test(`at most ${MAX_MOVES_PER_NIGHT} moves a night, one per replica, farthest first`, () => {
		const regions = ["wnam", "enam", "apac", "oc", "weur"];
		const far: Record<string, string> = { wnam: "DFW", enam: "DFW", apac: "SIN", oc: "PER", weur: "WAW" };
		const home: Record<string, string> = { wnam: "SEA", enam: "EWR", apac: "ICN", oc: "SYD", weur: "AMS" };
		const reports = regions.flatMap((r) => replica(r, 12, (k) => (k >= 10 ? (far[r] as string) : (home[r] as string))));
		const out = judge(reports);
		expect(out.moves).toHaveLength(MAX_MOVES_PER_NIGHT);
		expect(new Set(out.moves.map((m) => m.name0.replace(/-p\d+$/, ""))).size).toBe(MAX_MOVES_PER_NIGHT);
		// The three farthest: SYD-PER, ICN-SIN, then SEA-DFW or EWR-DFW (both ~2,000km+)…
		expect(out.moves[0]?.name0).toMatch(/^engine-(apac|oc)-p10$/);
		const kept = out.lines.filter((l) => l.includes(" kept "));
		expect(kept.length).toBe(10 - MAX_MOVES_PER_NIGHT);
		expect(kept.some((l) => l.includes("one move per replica a night"))).toBe(true);
		expect(kept.some((l) => l.includes(`${MAX_MOVES_PER_NIGHT} moves a night already made`))).toBe(true);
	});

	test("a moved name is not moved again within the cooldown; after it, to the next epoch", () => {
		const first = judge(replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA")));
		// The replacement landed in DFW again.
		const again = replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA"));
		again[11] = report("engine-wnam-p11-e1", "DFW");
		const soon = judge(again, { previous: first.engines, nowMs: NIGHT + DAY });
		expect(soon.moves).toEqual([]);
		expect(soon.lines[0]).toMatch(/kept engine-wnam-p11-e1 — .*cooling down until/);
		const later = judge(again, { previous: first.engines, nowMs: NIGHT + MOVE_COOLDOWN_MS });
		expect(later.moves.map((m) => m.to)).toEqual(["engine-wnam-p11-e2"]);
		expect(later.engines?.["engine-wnam-p11"]).toMatchObject({ e: 2, moves: 2 });
	});

	test(`after ${MAX_AUTO_MOVES} automatic moves the nightly gives up, and says so every night`, () => {
		const reports = replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA"));
		reports[11] = report("engine-wnam-p11-e3", "DFW");
		const previous = { "engine-wnam-p11": { e: 3, since: "2026-10-01T00:00:00Z", moves: MAX_AUTO_MOVES } };
		const out = judge(reports, { previous });
		expect(out.moves).toEqual([]);
		expect(out.engines?.["engine-wnam-p11"]).toMatchObject({ e: 3, stop: "gave-up" });
		expect(out.lines[0]).toMatch(/^Engine placement: gave up on engine-wnam-p11-e3 — misplaced/);
		const next = judge(reports, { previous: out.engines, nowMs: NIGHT + DAY });
		expect(next.moves).toEqual([]);
		expect(next.lines[0]).toMatch(/^Engine placement: gave up on engine-wnam-p11-e3/);
	});

	test("never past MAX_ENGINE_EPOCH", () => {
		const reports = replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA"));
		reports[11] = report(`engine-wnam-p11-e${MAX_ENGINE_EPOCH}`, "DFW");
		const out = judge(reports, { previous: { "engine-wnam-p11": { e: MAX_ENGINE_EPOCH, moves: 1 } } });
		expect(out.moves).toEqual([]);
		expect(out.engines?.["engine-wnam-p11"]?.stop).toBe("gave-up");
	});
});

describe("pins: the hand's undo", () => {
	const moved = { "engine-wnam-p11": { e: 1, since: "2026-10-24T11:30:00.000Z", moves: 1 } };

	test("a number pins the name at that epoch and holds it; deleting it unpins at the epoch it has", () => {
		const reports = replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA"));
		const pinned = judge(reports, { previous: moved, pins: { "engine-wnam-p11": 0 }, nowMs: NIGHT + DAY });
		expect(pinned.moves).toEqual([]);
		expect(pinned.engines?.["engine-wnam-p11"]).toEqual({
			since: moved["engine-wnam-p11"].since,
			moves: 1,
			stop: "pinned",
		});
		expect(pinned.lines).toContain("Engine placement: pinned engine-wnam-p11 at epoch 0 by hand");
		// Still pinned the next night: no line, no move.
		const held = judge(reports, { previous: pinned.engines, pins: { "engine-wnam-p11": 0 }, nowMs: NIGHT + 2 * DAY });
		expect(held.lines.some((l) => l.includes("pinned engine-wnam-p11"))).toBe(false);
		// …but the evidence still gets its line, with the reason nothing moved.
		expect(held.lines[0]).toMatch(
			/^Engine placement: kept engine-wnam-p11 — misplaced: colo DFW.*; pinned by hand at epoch 0$/,
		);
		expect(held.moves).toEqual([]);
		// Unpinned: judged again (and, cooled down, moved again).
		const free = judge(reports, { previous: held.engines, nowMs: NIGHT + 5 * DAY });
		expect(free.lines[0]).toBe("Engine placement: engine-wnam-p11 unpinned at epoch 0; judged automatically again");
		expect(free.moves.map((m) => m.to)).toEqual(["engine-wnam-p11-e1"]);
	});

	test('"auto" clears a give-up', () => {
		const reports = replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA"));
		reports[11] = report("engine-wnam-p11-e3", "DFW");
		const previous = { "engine-wnam-p11": { e: 3, since: "2026-10-01T00:00:00Z", moves: 3, stop: "gave-up" as const } };
		const out = judge(reports, { previous, pins: { "engine-wnam-p11": "auto" } });
		expect(out.moves.map((m) => m.to)).toEqual(["engine-wnam-p11-e4"]);
	});

	test("pins that are not epoch-0 partition names, or not epochs, are ignored", () => {
		const out = judge(
			replica("wnam", 4, () => "SEA"),
			{
				pins: { "engine-wnam-p1-e2": 0, "engine-wnam": 1, "engine-wnam-p2": -1, "engine-wnam-p3": "x", nope: 1 },
			},
		);
		expect(out.engines).toBeUndefined();
	});
});

/** A SEARCH_ENGINE binding whose ids are `<account>:<name>`, recording what was addressed. */
function fakeEnv(account = "deckgen") {
	const gets: { name: string; options: unknown }[] = [];
	const env = {
		SEARCH_ENGINE: {
			idFromName: (name: string) => ({ name, toString: () => `${account}:${name}` }),
			get: (id: { name: string }, options?: unknown) => {
				gets.push({ name: id.name, options });
				return { name: id.name };
			},
		},
	} as unknown as Env;
	return { env, gets };
}

describe("the move rides the manifest", () => {
	/** The block a published manifest carries after the judge's night, through JSON like KV. */
	function publishedBlock(): PlacementBlock {
		const out = judge(replica("wnam", 12, (k) => (k === 11 ? "DFW" : "SEA")));
		const decision = nextPlacement({
			previous: undefined,
			probes: { wnam: ["SEA"], enam: ["EWR"] },
			continentOf: () => "NA",
			builtAt: "b1",
			hints: ["wnam", "enam"],
			mayBump: true,
		});
		const block: PlacementBlock = { ...(decision.placement ?? UNSERVED_SEED), engines: out.engines };
		return JSON.parse(JSON.stringify(block)) as PlacementBlock;
	}

	test("the epoch round-trips through the manifest and every stub builder resolves it", () => {
		const placement = publishedBlock();
		expect(epochFloorOf(placement, "engine-wnam-p11")).toBe(1);
		expect(engineMoveRecord(placement, "engine-wnam-p3")).toBeUndefined();
		const { env, gets } = fakeEnv();
		expect(currentEngineName(env, "wnam", 0, 11, 0, placement)).toBe("engine-wnam-p11-e1");
		expect(currentEngineName(env, "wnam", 0, 3, 0, placement)).toBe("engine-wnam-p3");
		// Another replica, region or generation of the same partition is untouched.
		expect(currentEngineName(env, "wnam", 1, 11, 0, placement)).toBe("engine-wnam-1-p11");
		expect(currentEngineName(env, "enam", 0, 11, 0, placement)).toBe("engine-enam-p11");
		expect(currentEngineName(env, "wnam", 0, 11, 1, placement)).toBe("engine-wnam-g1-p11");
		// Without the block (an isolate on a manifest from before the move): the old object.
		expect(currentEngineName(env, "wnam", 0, 11)).toBe("engine-wnam-p11");
		placeEngineStub(env, "wnam", 0, 11, 0, placement);
		siblingStub(env, "engine-wnam-p0", 11, placement);
		siblingStub(env, "engine-wnam-p11-e1", 3, placement);
		expect(gets).toEqual([
			{ name: "engine-wnam-p11-e1", options: { locationHint: "wnam" } },
			{ name: "engine-wnam-p11-e1", options: undefined },
			{ name: "engine-wnam-p3", options: undefined },
		]);
	});

	test("nextPlacement carries the records through a night it decides nothing else about", () => {
		const previous = publishedBlock();
		const decision = nextPlacement({
			previous,
			probes: { wnam: ["SEA"], enam: ["EWR"] },
			continentOf: () => "NA",
			builtAt: "b2",
			hints: ["wnam", "enam"],
			mayBump: true,
		});
		expect(decision.placement?.engines).toEqual(previous.engines);
	});

	test("it composes with ABANDONED_ENGINES: the floor first, then the list's id chain", () => {
		const { env } = fakeEnv();
		const listed = (name: string): AbandonedEngine => ({
			id: `deckgen:${name}`,
			name,
			since: "2026-10-01T00:00:00Z",
			why: "t",
		});
		setAbandonedEnginesForTests([listed("engine-wnam-p8"), listed("engine-wnam-p8-e1")]);
		expect(currentEngineName(env, "wnam", 0, 8)).toBe("engine-wnam-p8-e2");
		// The nightly moved p8 past the list (it judged -e2, wrote e: 3).
		const placement: PlacementBlock = {
			v: 1,
			engines: { "engine-wnam-p8": { e: 3, since: "2026-10-24T11:30:00Z", moves: 1 } },
		};
		expect(currentEngineName(env, "wnam", 0, 8, 0, placement)).toBe("engine-wnam-p8-e3");
		// A floor of 1 still follows the list from there: -e1 is listed, so -e2.
		const low: PlacementBlock = { v: 1, engines: { "engine-wnam-p8": { e: 1 } } };
		expect(currentEngineName(env, "wnam", 0, 8, 0, low)).toBe("engine-wnam-p8-e2");
		// And a listed -e2 under a floor of 2 moves on to -e3.
		setAbandonedEnginesForTests([listed("engine-wnam-p8-e2")]);
		expect(currentEngineName(env, "wnam", 0, 8, 0, { v: 1, engines: { "engine-wnam-p8": { e: 2 } } })).toBe(
			"engine-wnam-p8-e3",
		);
	});

	test("an empty block costs the hot path nothing: no id becomes a string", () => {
		let strings = 0;
		const env = {
			SEARCH_ENGINE: {
				idFromName: (name: string) => ({
					name,
					toString: () => {
						strings += 1;
						return name;
					},
				}),
				get: () => ({}),
			},
		} as unknown as Env;
		placeEngineStub(env, "wnam", 0, 3, 0, publishedBlock());
		siblingStub(env, "engine-wnam-p0", 11, publishedBlock());
		expect(supersededEngine(env, "engine-wnam-p3", publishedBlock())).toBeNull();
		expect(strings).toBe(0);
	});

	test("the old name keeps answering until it is released: superseded, dated by the move, released after the windows", async () => {
		const placement = publishedBlock();
		const { env } = fakeEnv();
		const since = engineMoveRecord(placement, "engine-wnam-p11")?.since as string;
		expect(supersededEngine(env, "engine-wnam-p11", placement)).toEqual({
			by: "engine-wnam-p11-e1",
			entry: { id: "deckgen:engine-wnam-p11", name: "engine-wnam-p11", since, why: expect.stringContaining("x100") },
		});
		expect(supersededEngine(env, "engine-wnam-p11-e1", placement)).toBeNull();
		// The old object is addressed by its exact name (the fan-out's addressAnnouncedEngine) and
		// answers as before; the sweep decides when it gives its storage back.
		const sweep = async (nowMs: number, servedAgoMs: number | null) => {
			const released: string[] = [];
			const result = await sweepAbandonedEngines(["engine-wnam-p3", "engine-wnam-p11", "engine-wnam-p11-e1"], {
				superseded: (name) => supersededEngine(env, name, placement),
				release: async (name) => {
					const quiet = servedAgoMs === null || servedAgoMs >= ABANDONED_QUIET_MS;
					if (quiet) released.push(name);
					return { released: quiet, servedAgoMs };
				},
				unannounce: async () => {},
				nowMs,
				log: () => {},
			});
			return { result, released };
		};
		const t = Date.parse(since);
		expect((await sweep(t + 60_000, null)).result.waiting).toEqual(["engine-wnam-p11"]);
		expect((await sweep(t + ABANDONED_RELEASE_AFTER_MS, 60_000)).result.busy).toEqual(["engine-wnam-p11"]);
		expect(await sweep(t + ABANDONED_RELEASE_AFTER_MS, null)).toEqual({
			result: { released: ["engine-wnam-p11"], waiting: [], busy: [], failed: [] },
			released: ["engine-wnam-p11"],
		});
	});

	test("undo: a pin back to epoch 0 makes the replacement the undone one, released once unused", () => {
		const { env } = fakeEnv();
		const undone: PlacementBlock = {
			v: 1,
			engines: { "engine-wnam-p11": { since: "2026-10-24T11:30:00Z", moves: 1, stop: "pinned" } },
		};
		expect(currentEngineName(env, "wnam", 0, 11, 0, undone)).toBe("engine-wnam-p11");
		expect(supersededEngine(env, "engine-wnam-p11-e1", undone)).toEqual({ by: "engine-wnam-p11", entry: null });
		expect(supersededEngine(env, "engine-wnam-p11", undone)).toBeNull();
	});

	test("a seed stub is only ever a replacement of the caller's own sibling", () => {
		const { env, gets } = fakeEnv();
		expect(seedSiblingStub(env, "engine-wnam-p0", "engine-wnam-p11-e1")).not.toBeNull();
		expect(gets).toEqual([{ name: "engine-wnam-p11-e1", options: undefined }]);
		for (const name of [
			"engine-wnam-p11", // an original, not a replacement
			"engine-enam-p11-e1", // another region
			"engine-wnam-1-p11-e1", // another replica
			"engine-wnam-g1-p11-e1", // another generation
			"engine-wnam-e1", // not a partition object
			"nope",
		])
			expect(seedSiblingStub(env, "engine-wnam-p0", name)).toBeNull();
		expect(seedSiblingStub(env, "engine-wnam-p11-e1", "engine-wnam-p11-e1")).toBeNull();
	});
});

describe("the coordinator's I/O halves", () => {
	test("reports are gathered in parallel, bounded; a silent or mislabelled object is left out", async () => {
		const out = await gatherEngineReports(
			["engine-wnam-p0", "engine-wnam-p1", "engine-wnam-p2", "engine-wnam", "engine-wnam-p3"],
			async (name) => {
				if (name === "engine-wnam-p1") return new Promise<EngineReport>(() => {});
				if (name === "engine-wnam-p2") return report("engine-wnam-p9", "SEA");
				if (name === "engine-wnam-p3") throw new Error("boom");
				return report(name, "SEA");
			},
			20,
		);
		expect(out.reports.map((r) => r.name)).toEqual(["engine-wnam-p0"]);
		expect(out.failed).toEqual(["engine-wnam-p1", "engine-wnam-p2", "engine-wnam-p3"]);
	});

	test("seeds go from each move's host; a failure or a hostless move is logged, never thrown", async () => {
		const lines: string[] = [];
		const move = (to: string, host: string | null): EngineMove => ({
			name0: to.replace(/-e\d+$/, ""),
			from: "",
			to,
			epoch: 1,
			host,
			why: "",
		});
		const out = await seedMoves(
			[
				move("engine-wnam-p11-e1", "engine-wnam-p0"),
				move("engine-apac-p10-e1", "engine-apac-p0"),
				move("engine-oc-p3-e1", null),
			],
			async (host, to) => {
				if (to.startsWith("engine-apac")) throw new Error("no");
				return { cards: 3300, ms: 900 + host.length };
			},
			(line) => lines.push(line),
		);
		expect(out).toEqual({
			seeded: ["engine-wnam-p11-e1"],
			unseeded: expect.arrayContaining(["engine-apac-p10-e1", "engine-oc-p3-e1"]),
		});
		expect(lines).toContain(
			"Engine placement: seeded engine-wnam-p11-e1 from engine-wnam-p0 (3300 cards loaded in 914ms)",
		);
		expect(lines.some((l) => l.startsWith("Engine placement: could not seed engine-apac-p10-e1"))).toBe(true);
		expect(lines).toContain(
			"Engine placement: engine-oc-p3-e1 not seeded (no host in a home colo); its first caller creates it",
		);
	});
});

/** A Durable Object's SQLite, on bun:sqlite, counting rows written. */
function sqliteStorage() {
	const db = new Database(":memory:");
	const meter = { written: 0 };
	const storage = {
		sql: {
			exec: (query: string, ...bindings: unknown[]) => {
				const q = query.trim();
				if (/^SELECT/i.test(q)) {
					const rows = db.query(q).all(...(bindings as never[])) as Record<string, SqlStorageValue>[];
					return { toArray: () => rows };
				}
				if (bindings.length === 0) db.exec(q);
				else {
					const changes = db.run(q, bindings as never[]).changes;
					meter.written += changes;
				}
				return { toArray: () => [] };
			},
		},
	};
	return { storage, meter };
}

describe("the evidence the objects keep (engine-health.ts)", () => {
	test("loads and hedges are counted per UTC day; the report is yesterday's, with the colo", () => {
		const { storage } = sqliteStorage();
		const yesterday = NIGHT - DAY;
		for (let i = 0; i < 3; i++) noteHealth(storage, { load: true }, yesterday);
		noteHealth(storage, { around: 8 }, yesterday);
		noteHealth(storage, { around: 8 }, yesterday);
		noteHealth(storage, { around: 2 }, yesterday);
		noteHealth(storage, { load: true }, NIGHT);
		recordPlacement(storage, { colo: "SEA", at: NIGHT - 1000 });
		expect(healthReport(storage, "engine-wnam-p0", NIGHT)).toEqual({
			name: "engine-wnam-p0",
			colo: "SEA",
			coloAt: NIGHT - 1000,
			day: utcDay(yesterday),
			loads: 3,
			around: { "8": 2, "2": 1 },
		});
		// Only today and yesterday are kept.
		noteHealth(storage, { load: true }, NIGHT + 2 * DAY);
		expect(Object.keys(readHealth(storage).days)).toEqual([utcDay(NIGHT + 2 * DAY)]);
	});

	test("one row written per event, then one in HEALTH_SAMPLE at that weight: a storm is counted, not paid for", () => {
		const { storage, meter } = sqliteStorage();
		let coin = 0;
		const random = () => {
			coin = (coin + 1) % HEALTH_SAMPLE;
			return coin === 0 ? 0 : 0.99;
		};
		const events = HEALTH_FULL_WRITES + 16 * 100;
		for (let i = 0; i < events; i++) noteHealth(storage, { load: true }, NIGHT, random);
		const day = readHealth(storage).days[utcDay(NIGHT)];
		expect(day?.loads).toBe(events);
		expect(meter.written).toBe(HEALTH_FULL_WRITES + 100);
		expect(day?.w).toBe(HEALTH_FULL_WRITES + 100);
	});

	test("a missing or broken row is an empty record, and nothing here ever throws", () => {
		const { storage } = sqliteStorage();
		expect(healthReport(storage, "engine-x-p0", NIGHT)).toMatchObject({ colo: null, loads: 0, around: {} });
		storage.sql.exec("INSERT INTO engine_health (id, json) VALUES (0, ?)", "not json");
		expect(readHealth(storage)).toEqual({ days: {} });
		expect(noteHealth(undefined, { load: true })).toBe(false);
		const broken = {
			sql: {
				exec: () => {
					throw new Error("disk");
				},
			},
		};
		expect(noteHealth(broken, { load: true })).toBe(false);
	});
});

describe("the wiring, pinned at the source", () => {
	const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

	test("every Worker stub is built under the manifest's placement", () => {
		const index = src("index.ts");
		const calls = index.match(/placeEngineStub\([^)]*\)/g) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(5);
		for (const call of calls) expect(call).toContain("manifest.placement");
	});

	test("the gather's siblings and hedges resolve under the manifest the object serves", () => {
		const engine = src("engine/search-engine-do.ts");
		expect(engine).toContain("siblingStub(this.env, this.label, p, placement)");
		expect(engine).toContain("placeEngineStub(this.env, region, 0, p, generation, placement)");
		expect(engine).toContain("const placement = (currentManifest(this.label) ?? cold)?.placement;");
	});

	test("an object counts its loads and the hedges it wins, and reports without writing", () => {
		const engine = src("engine/search-engine-do.ts");
		expect(engine).toContain('if (hedge?.won === "hedge") noteHealth(this.ctx.storage, { around: partition });');
		expect(engine).toContain("noteHealth(this.ctx.storage, { load: true });");
		expect(engine).toContain("return healthReport(this.ctx.storage, this.label);");
	});

	test("the nightly judges before the manifest, and seeds after the commit", () => {
		const coordinator = src("import-coordinator.ts");
		// The reports are gathered in the placement phase, which hands over to the manifest step.
		const placementStep = coordinator.slice(coordinator.indexOf("private async stepPlacement"));
		const gathered = placementStep.indexOf('this.metaGet("engine_reports") === null');
		expect(gathered).toBeGreaterThan(-1);
		expect(gathered).toBeLessThan(placementStep.indexOf('this.metaSet("phase", "manifest")'));
		expect(coordinator).toContain("return this.judgeEnginePlacement(decision.placement, manifest, before);");
		const notify = coordinator.slice(coordinator.indexOf("private async stepNotify"));
		expect(notify.indexOf("await seedMoves(")).toBeGreaterThan(notify.indexOf("commitPublish()"));
	});
});
