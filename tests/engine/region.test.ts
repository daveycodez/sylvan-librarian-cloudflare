// The request -> region mapping, which had no coverage at all until it became
// the routing key for the entire engine tier.
//
// It used to decide only where a relay went and where a fresh rate-limiter DO
// was placed — both forgiving, both self-correcting. Now it decides WHICH
// Durable Object serves the request, so a wrong answer sends a user to another
// continent's store and a non-deterministic one splits a region's traffic across
// two objects that each hold their own ~76.6MB copy.
//
// The longitude splits are the part worth pinning: they are the only reason one
// isolate can address two regions, which is what forced the shard controller's
// state to be keyed by region.

import { describe, expect, test } from "bun:test";
import { COLOS } from "../../src/engine/colos.gen";
import { CONTINENT_TO_HINT, hintForColo, REGION_HINTS, REGIONS, regionHint } from "../../src/engine/region";

/** A request carrying the `cf` fields the mapping reads, and nothing else. */
function req(cf: { colo?: string; continent?: string; longitude?: string } | undefined): Request {
	const request = new Request("https://example.com/search?q=elf");
	Object.defineProperty(request, "cf", { value: cf, configurable: true });
	return request;
}

describe("continent defaults", () => {
	test("each continent maps to its documented hint", () => {
		expect(regionHint(req({ continent: "AS" }))).toBe("apac");
		expect(regionHint(req({ continent: "OC" }))).toBe("oc");
		expect(regionHint(req({ continent: "AN" }))).toBe("oc");
		expect(regionHint(req({ continent: "SA" }))).toBe("sam");
		expect(regionHint(req({ continent: "AF" }))).toBe("afr");
	});

	test("NA and EU fall back to their western half without a longitude", () => {
		expect(regionHint(req({ continent: "NA" }))).toBe("wnam");
		expect(regionHint(req({ continent: "EU" }))).toBe("weur");
	});

	test("every mapped continent resolves to a real location hint", () => {
		const hints = new Set(["wnam", "enam", "weur", "eeur", "apac", "oc", "sam", "afr", "me"]);
		for (const hint of Object.values(CONTINENT_TO_HINT)) expect(hints.has(hint)).toBe(true);
	});
});

describe("the North America split at -100°", () => {
	test("west of the meridian is wnam", () => {
		expect(regionHint(req({ continent: "NA", longitude: "-118.24" }))).toBe("wnam"); // Los Angeles
		expect(regionHint(req({ continent: "NA", longitude: "-121.89" }))).toBe("wnam"); // San Jose
	});

	test("east of it is enam", () => {
		expect(regionHint(req({ continent: "NA", longitude: "-71.06" }))).toBe("enam"); // Boston
		expect(regionHint(req({ continent: "NA", longitude: "-87.63" }))).toBe("enam"); // Chicago
	});

	test("the boundary itself goes east, and one degree either side straddles", () => {
		expect(regionHint(req({ continent: "NA", longitude: "-100" }))).toBe("enam");
		expect(regionHint(req({ continent: "NA", longitude: "-99.99" }))).toBe("enam");
		expect(regionHint(req({ continent: "NA", longitude: "-100.01" }))).toBe("wnam");
	});
});

describe("the Europe split at +15°", () => {
	test("west of the meridian is weur", () => {
		expect(regionHint(req({ continent: "EU", longitude: "-0.13" }))).toBe("weur"); // London
		expect(regionHint(req({ continent: "EU", longitude: "2.35" }))).toBe("weur"); // Paris
	});

	test("east of it is eeur", () => {
		expect(regionHint(req({ continent: "EU", longitude: "21.01" }))).toBe("eeur"); // Warsaw
		expect(regionHint(req({ continent: "EU", longitude: "16.37" }))).toBe("eeur"); // Vienna
	});

	test("the boundary itself goes east", () => {
		expect(regionHint(req({ continent: "EU", longitude: "15" }))).toBe("eeur");
		expect(regionHint(req({ continent: "EU", longitude: "14.99" }))).toBe("weur");
	});
});

describe("degenerate input never produces an unroutable name", () => {
	// Every one of these has to return SOME valid hint: the caller uses the result
	// to build a DO name unconditionally, so undefined or "" would create an
	// object called `engine-undefined` that nothing else would ever address.
	test("a missing cf object falls back to wnam", () => {
		expect(regionHint(req(undefined))).toBe("wnam");
	});

	test("an unknown continent falls back to wnam", () => {
		expect(regionHint(req({ continent: "XX" }))).toBe("wnam");
	});

	test("an unparseable longitude falls back to the continent default", () => {
		expect(regionHint(req({ continent: "NA", longitude: "" }))).toBe("wnam");
		expect(regionHint(req({ continent: "NA", longitude: "not-a-number" }))).toBe("wnam");
		expect(regionHint(req({ continent: "EU", longitude: "NaN" }))).toBe("weur");
	});

	test("a longitude without a continent is read against the NA default", () => {
		// `continent ?? "NA"` happens BEFORE the split, so a bare longitude is
		// treated as a North American one and can select enam. That is the
		// behaviour, not an accident of ordering: the edge always sends a
		// continent in practice, and defaulting to NA-with-split beats defaulting
		// every unlabelled request onto one object.
		expect(regionHint(req({ longitude: "-71.06" }))).toBe("enam");
		expect(regionHint(req({ longitude: "-118.24" }))).toBe("wnam");
	});
});

describe("determinism", () => {
	test("the same request always routes to the same region", () => {
		// Non-determinism here would split one region's traffic across two objects,
		// each holding its own ~76.6MB copy — the exact fragmentation that
		// per-colo naming caused and this mapping replaced.
		const request = req({ continent: "NA", longitude: "-118.24" });
		const first = regionHint(request);
		for (let i = 0; i < 25; i++) expect(regionHint(request)).toBe(first);
	});

	test("both LAX and SJC land on the same object", () => {
		// The two colos this deployment actually sees. Under per-colo naming they
		// were engine-LAX and engine-SJC plus engine-wnam as a relay target —
		// three objects, three store loads, for traffic that fits in one.
		expect(regionHint(req({ continent: "NA", longitude: "-118.24" }))).toBe(
			regionHint(req({ continent: "NA", longitude: "-121.89" })),
		);
	});
});

describe("the region list is every location hint (backlog g2)", () => {
	test("all eleven hints, each once — the type enforces it, this pins the runtime list", () => {
		// `REGIONS satisfies Record<DurableObjectLocationHint, …>` is the real guard (typecheck fails
		// on a missing hint); this catches the runtime list drifting from the table.
		expect(new Set(REGION_HINTS).size).toBe(REGION_HINTS.length);
		const all: DurableObjectLocationHint[] = [
			"afr",
			"apac",
			"apac-ne",
			"apac-se",
			"eeur",
			"enam",
			"me",
			"oc",
			"sam",
			"weur",
			"wnam",
		];
		expect([...REGION_HINTS].sort()).toEqual(all.sort());
		expect(Object.keys(REGIONS)).toEqual([...REGION_HINTS]);
	});
});

describe("routing by the colo the isolate runs in (backlog p4)", () => {
	test("the colo decides, not the client's geography", () => {
		// A US reader whose request entered at SIN runs every engine call from SIN.
		expect(regionHint(req({ colo: "SIN", continent: "NA", longitude: "-122.4" }))).toBe("apac");
		expect(regionHint(req({ colo: "FRA", continent: "NA", longitude: "-74.0" }))).toBe("weur");
	});

	test("each Cloudflare region lands where its colos are", () => {
		const cases: [string, DurableObjectLocationHint][] = [
			["EWR", "enam"],
			["LAX", "wnam"],
			["FRA", "weur"],
			["WAW", "eeur"],
			["GRU", "sam"],
			["JNB", "afr"],
			["DXB", "me"],
			["SYD", "oc"],
			["BOM", "apac"],
		];
		for (const [colo, hint] of cases) expect([colo, hintForColo(colo)]).toEqual([colo, hint]);
	});

	test("a colo the table does not know falls back to the client rule", () => {
		expect(hintForColo("ZZZ")).toBeNull();
		expect(regionHint(req({ colo: "ZZZ", continent: "EU", longitude: "21.0" }))).toBe("eeur");
		expect(regionHint(req({ colo: "ZZZ" }))).toBe("wnam");
	});

	test("every known colo maps to a real location hint, deterministically", () => {
		for (const colo of Object.keys(COLOS)) {
			const hint = hintForColo(colo);
			expect(hint !== null && REGION_HINTS.includes(hint)).toBe(true);
			expect(hintForColo(colo)).toBe(hint);
		}
	});

	test("every region some colo can reach — all of them once Asia splits (g3)", () => {
		const reached = new Set(Object.keys(COLOS).map((c) => hintForColo(c)));
		// me is now reachable: CONTINENT_TO_HINT never returned it (Middle East clients are "AS").
		for (const hint of ["wnam", "enam", "weur", "eeur", "apac", "oc", "sam", "afr", "me"] as const) {
			expect(reached.has(hint)).toBe(true);
		}
	});
});
