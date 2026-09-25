// g1: hints Cloudflare cannot host yet are routed to the served hint that shares their spawn pool,
// and flip back — onto FRESH objects — once probes say otherwise. Every hint stays a region.

import { describe, expect, test } from "bun:test";
import { engineName, parseEngineName } from "../../src/engine/engine-namespace";
import {
	continentOfColo,
	effectiveRegion,
	generationOf,
	type Hint,
	nextPlacement,
	type PlacementBlock,
	UNSERVED_SEED,
	unreachableEngine,
} from "../../src/engine/placement-policy";
import { REGION_HINTS } from "../../src/engine/region";

/** Tonight's probes as Cloudflare places them today (spawn pools from where.durableobjects.live). */
function today(overrides: Partial<Record<Hint, string[]>> = {}): Partial<Record<Hint, string[]>> {
	return {
		wnam: ["DFW", "SJC", "SEA", "DFW"],
		enam: ["EWR", "ATL", "IAD", "ORD"],
		sam: ["EWR", "MIA", "ATL", "EWR"],
		weur: ["AMS", "LHR", "CDG", "AMS"],
		eeur: ["FRA", "WAW", "MXP", "VIE"],
		apac: ["SIN", "HKG", "ICN", "NRT"],
		"apac-ne": ["KIX", "NRT", "ICN", "KIX"],
		"apac-se": ["SIN", "HKG", "SIN", "SIN"],
		oc: ["SYD", "MEL", "SYD", "SYD"],
		afr: ["LHR", "AMS", "MAD", "CDG"],
		me: ["FRA", "MXP", "PRG", "FRA"], // all three are weur by longitude — the flapping trap
		...overrides,
	};
}

function night(previous: PlacementBlock | undefined, probes = today(), mayBump = true, builtAt = "n") {
	return nextPlacement({ previous, probes, continentOf: continentOfColo, builtAt, hints: REGION_HINTS, mayBump });
}
/** Two quiet nights from nothing: the state a deployment settles into. */
const settled = () => night(night(undefined).placement).placement;

describe("effectiveRegion", () => {
	test("before any probe run the documented seed applies", () => {
		expect(effectiveRegion("sam", undefined)).toBe("enam");
		expect(effectiveRegion("afr", undefined)).toBe("weur");
		expect(effectiveRegion("me", undefined)).toBe("eeur");
		for (const h of ["wnam", "enam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc"] as Hint[]) {
			expect(effectiveRegion(h, undefined)).toBe(h);
		}
	});

	test("every hint resolves to a real, non-aliased hint — none is dropped", () => {
		for (const block of [undefined, UNSERVED_SEED, settled()]) {
			for (const h of REGION_HINTS) {
				const r = effectiveRegion(h, block);
				expect(REGION_HINTS).toContain(r);
				expect(effectiveRegion(r, block)).toBe(r);
			}
		}
	});

	test("a chain, a self-alias or an unknown target degrades to no alias, never a loop", () => {
		const chain: PlacementBlock = {
			v: 1,
			alias: { sam: { to: "enam", since: "x" }, enam: { to: "wnam", since: "x" } },
		};
		expect(effectiveRegion("sam", chain)).toBe("sam");
		expect(effectiveRegion("oc", { v: 1, alias: { oc: { to: "oc", since: "x" } } })).toBe("oc");
		expect(effectiveRegion("oc", { v: 1, alias: { oc: { to: "mars" as Hint, since: "x" } } })).toBe("oc");
	});

	test("an explicit empty block means no alias at all (the seed is only for an ABSENT block)", () => {
		expect(effectiveRegion("sam", { v: 1 })).toBe("sam");
	});
});

describe("the first-run gate", () => {
	test("today's probes pass it, and the pass is recorded so it is not asked again", () => {
		const first = night(undefined);
		expect(first.held).toBe(false);
		expect(first.placement?.checked).toBe("n");
		expect(first.changes.join("\n")).toContain("first-run gate passed");
	});

	test("a served hint probed off its continent changes NOTHING that night — not even the history", () => {
		// wnam probes landing in Europe would mean probes created by a Durable Object do not land
		// like edge-created objects: nothing they say can be trusted yet.
		const held = night(undefined, today({ wnam: ["DFW", "AMS", "SJC", "SJC"], sam: ["GRU", "GRU", "GRU", "GRU"] }));
		expect(held.held).toBe(true);
		expect(held.placement).toBeUndefined(); // the seed keeps applying
		expect(held.changes.join("\n")).toContain("wnam at DFW,AMS,SJC,SJC");
		// With a block already published, it is carried as is.
		const block: PlacementBlock = { v: 1, alias: { sam: { to: "enam", since: "x" } } };
		expect(night(block, today({ oc: ["SIN", "SIN", "SIN", "SIN"] })).placement).toBe(block);
	});

	test("an unserved hint landing off its continent is expected, and does not trip it", () => {
		expect(night(undefined, today({ me: ["FRA", "FRA", "FRA", "FRA"] })).held).toBe(false);
	});

	test("once passed, an off-continent served hint is ordinary evidence, not a gate", () => {
		const n = night(settled(), today({ oc: ["SIN", "SIN", "HKG", "SIN"] }));
		expect(n.held).toBe(false);
	});

	test("a night on which no probe answered holds everything", () => {
		const block = settled();
		const empty = night(block, {});
		expect(empty.held).toBe(true);
		expect(empty.placement).toBe(block);
	});
});

describe("nextPlacement", () => {
	test("today's probes keep sam→enam, afr→weur and send me to eeur, not weur", () => {
		const block = settled();
		expect(effectiveRegion("sam", block)).toBe("enam");
		expect(effectiveRegion("afr", block)).toBe("weur");
		// hintForColo(FRA|MXP|PRG) would say weur; the pool overlap says eeur.
		expect(effectiveRegion("me", block)).toBe("eeur");
		for (const h of ["wnam", "enam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc"] as Hint[]) {
			expect(effectiveRegion(h, block)).toBe(h);
		}
	});

	test("the alias target is sticky: a night with no shared colo does not move it", () => {
		const n = night(settled(), today({ me: ["FRA", "FRA", "MXP", "PRG"], eeur: ["WAW", "VIE", "ARN", "OTP"] }));
		expect(effectiveRegion("me", n.placement)).toBe("eeur");
	});

	test("a newly unserved hint is aliased only after two consecutive nights", () => {
		const once = night(settled(), today({ oc: ["SIN", "SIN", "HKG", "SIN"] }));
		expect(effectiveRegion("oc", once.placement)).toBe("oc");
		const twice = night(once.placement, today({ oc: ["SIN", "HKG", "SIN", "SIN"] }));
		// Jaccard, not a raw count: SIN/HKG overlaps apac (SIN HKG ICN NRT) and apac-se (SIN HKG)
		// equally by count, and apac-se is the pool it actually shares.
		expect(effectiveRegion("oc", twice.placement)).toBe("apac-se");
	});

	test("sam flips back after two on-continent nights, with a generation bump", () => {
		const once = night(settled(), today({ sam: ["GRU", "GRU", "GRU", "GRU"] }));
		expect(effectiveRegion("sam", once.placement)).toBe("enam"); // one night is not enough
		expect(generationOf("sam", once.placement)).toBe(0);
		const twice = night(once.placement, today({ sam: ["GRU", "GRU", "GRU", "GRU"] }));
		expect(effectiveRegion("sam", twice.placement)).toBe("sam");
		expect(generationOf("sam", twice.placement)).toBe(1); // engine-sam-g1-p*: never the EWR-placed g0 objects
		expect(twice.changes.join("\n")).toContain("sam: served again");
		// And a third on-continent night does not bump it again.
		expect(generationOf("sam", night(twice.placement, today({ sam: ["GRU"] })).placement)).toBe(1);
	});

	test("the pool guard defers the flip-back, keeping sam served from enam", () => {
		const once = night(settled(), today({ sam: ["GRU", "GRU", "GRU", "GRU"] }));
		const blocked = night(once.placement, today({ sam: ["GRU", "GRU", "GRU", "GRU"] }), false);
		expect(effectiveRegion("sam", blocked.placement)).toBe("enam");
		expect(generationOf("sam", blocked.placement)).toBe(0);
		expect(blocked.changes.join("\n")).toContain("would not fit the pool");
	});

	test("a mixed night, or a hint none of whose probes answered, changes nothing for it", () => {
		const block = settled();
		const mixed = night(block, today({ sam: ["GRU", "EWR", "GRU", "GRU"] }));
		const empty = night(mixed.placement, today({ sam: [] }));
		expect(effectiveRegion("sam", mixed.placement)).toBe("enam");
		expect(effectiveRegion("sam", empty.placement)).toBe("enam");
		// An unanswered hint's history is kept, not shifted out.
		expect(empty.placement?.obs?.sam).toEqual(mixed.placement?.obs?.sam);
	});

	test("the block stays small: two nights of four probes for eleven hints", () => {
		expect(JSON.stringify(settled()).length).toBeLessThan(1200);
	});
});

describe("what a publish retires", () => {
	test("objects of an aliased hint, and objects of a generation that is not current", () => {
		const flipped: PlacementBlock = { v: 1, gens: { sam: 1 } };
		const parsed = (name: string) => parseEngineName(name) as { region: string; generation?: number };
		expect(unreachableEngine(parsed("engine-sam-p0"), undefined)).toBe(true); // seed alias
		expect(unreachableEngine(parsed("engine-enam-p0"), undefined)).toBe(false);
		expect(unreachableEngine(parsed("engine-sam-p0"), flipped)).toBe(true); // generation 0 < 1
		expect(unreachableEngine(parsed("engine-sam-g1-p3"), flipped)).toBe(false);
		expect(unreachableEngine(parsed("engine-sam-g2-p3"), flipped)).toBe(true);
		expect(unreachableEngine(parsed(engineName("wnam", 2, 7)), flipped)).toBe(false);
	});
});
