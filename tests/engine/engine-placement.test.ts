// Where engine Durable Objects live, and who is allowed to decide it.
//
// The property under test is unusual in that no runtime assertion can protect it
// and no monitor can detect the moment it breaks. `locationHint` applies at
// CREATION and never again: the first caller to address `engine-apac` fixes that
// object's region for the rest of its life, and if that caller was a Durable
// Object in North America, every apac request afterwards crosses the Pacific
// twice, forever, with nothing anywhere reporting it. Objects cannot be moved.
//
// So the guard has to be at the source level, and this file is it: a scan that
// fails if any module other than engine-namespace.ts constructs an engine stub
// or mentions `locationHint` on that binding. A comment saying "only resolveEngine
// may create these" is not sufficient for a failure mode that is silent and
// permanent — commit fbc5397 added a nine-region fan-out inside the coordinator
// under exactly that comment, and only luck (it lives in the nightly alarm
// chain, which never ran in the 92 minutes the code existed) kept it from
// placing eight objects from the wrong place.

import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addressAnnouncedEngine,
	engineName,
	placeEngineStub,
	regionOfEngineName,
} from "../../src/engine/engine-namespace";
import { PROBE_MIN_INTERVAL_MS, parseTrace, placementLine } from "../../src/engine/placement";
import { REGION_HINTS } from "../../src/engine/region";
import type { Env } from "../../src/engine/types";

const SRC = join(import.meta.dir, "../../src");

/** The one module allowed to name the SEARCH_ENGINE binding. */
const CHOKE_POINT = "engine/engine-namespace.ts";

function sourceFiles(dir: string, prefix = ""): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name), rel));
		else if (entry.name.endsWith(".ts")) out.push({ path: rel, text: readFileSync(join(dir, entry.name), "utf8") });
	}
	return out;
}

/** Strip comments, so the prose in this codebase — which discusses locationHint
 * at length and should keep doing so — is not what fails the scan. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A SEARCH_ENGINE binding that records exactly what it was asked for. */
function fakeEnv() {
	const gets: { name: string; options: DurableObjectNamespaceGetDurableObjectOptions | undefined }[] = [];
	const env = {
		SEARCH_ENGINE: {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
				gets.push({ name: id.name, options });
				return {};
			},
		},
	} as unknown as Env;
	return { env, gets };
}

describe("only one module may bring an engine object into existence", () => {
	test("the scan actually reads the tree it is guarding", () => {
		// A scan that silently walks nothing passes forever. Pin the two files it
		// most has to see: the choke point, and the entrypoint that used to hold the
		// call it now routes through.
		const paths = sourceFiles(SRC).map((f) => f.path);
		expect(paths).toContain(CHOKE_POINT);
		expect(paths).toContain("index.ts");
		expect(code(sourceFiles(SRC).find((f) => f.path === CHOKE_POINT)?.text ?? "")).toContain("SEARCH_ENGINE.get");
	});

	test("no other source file constructs a SEARCH_ENGINE stub", () => {
		const offenders = sourceFiles(SRC)
			.filter((f) => f.path !== CHOKE_POINT)
			.filter((f) => /SEARCH_ENGINE\s*\.\s*(get|idFromName)\b/.test(code(f.text)))
			.map((f) => f.path);
		// If this fails, route the new call site through placeEngineStub (edge
		// requests only) or addressAnnouncedEngine (everything else) rather than
		// adding it to the allowlist.
		expect(offenders).toEqual([]);
	});

	test("no other source file passes a locationHint", () => {
		const offenders = sourceFiles(SRC)
			.filter((f) => f.path !== CHOKE_POINT && f.path !== "routes/rate-limit.ts")
			.filter((f) => /locationHint/.test(code(f.text)))
			.map((f) => f.path);
		// rate-limit.ts is exempt on purpose: its objects are per-IP, hold a few
		// counters, and are created by the same edge isolate that serves the
		// request. A misplaced one costs a token bucket, not an ~88MB archive.
		expect(offenders).toEqual([]);
	});
});

describe("the name and the hint cannot disagree", () => {
	test("placing derives the name from the region it places into", () => {
		for (const region of REGION_HINTS) {
			const { env, gets } = fakeEnv();
			placeEngineStub(env, region, 0);
			placeEngineStub(env, region, 2);
			expect(gets.map((g) => g.name)).toEqual([`engine-${region}`, `engine-${region}-2`]);
			// Every created object is hinted into the region its name claims. This is
			// the invariant the whole module exists for, and it holds by construction
			// rather than by check: there is no argument to get wrong.
			for (const g of gets) expect(g.options?.locationHint).toBe(region);
		}
	});

	test("shard 0 keeps the plain name, so unsharded routing is unchanged", () => {
		expect(engineName("wnam", 0)).toBe("engine-wnam");
		expect(engineName("wnam", 1)).toBe("engine-wnam-1");
	});

	test("addressing an announced object supplies no options at all", () => {
		// Not merely "a different hint": no hint. A phase that cannot name a region
		// cannot place an object in one, even if the live set it walks is wrong.
		const { env, gets } = fakeEnv();
		addressAnnouncedEngine(env, "engine-apac");
		expect(gets).toEqual([{ name: "engine-apac", options: undefined }]);
	});

	test("a name round-trips back to the region it claims", () => {
		for (const region of REGION_HINTS) {
			expect(regionOfEngineName(engineName(region, 0))).toBe(region);
			expect(regionOfEngineName(engineName(region, 7))).toBe(region);
		}
		expect(regionOfEngineName("singleton")).toBeNull();
		expect(regionOfEngineName("engine-")).toBeNull();
	});
});

describe("the placement probe", () => {
	test("reads the colo and country out of a trace body", () => {
		const body = ["fl=12f34", "h=www.cloudflare.com", "ip=1.2.3.4", "colo=SJC", "loc=US", "tls=TLSv1.3"].join("\n");
		expect(parseTrace(body)).toEqual({ colo: "SJC", loc: "US" });
	});

	test("a trace missing the fields is reported as unknown, not as an error", () => {
		expect(placementLine("engine-wnam", parseTrace("h=www.cloudflare.com"))).toBe(
			"[engine-wnam] placement: colo=? loc=?",
		);
	});

	test("names the object, because the object's name is what the colo is judged against", () => {
		expect(placementLine("engine-wnam-2", { colo: "SJC", loc: "US" })).toBe(
			"[engine-wnam-2] placement: colo=SJC loc=US",
		);
	});
});

describe("probing never lands on the request path", () => {
	/** Fresh module state per test: the throttle is a module global, which is the
	 * unit under test. */
	async function freshPlacement(gen: number) {
		return await import(`../../src/engine/placement.ts?gen=${gen}`);
	}

	test("one probe per isolate per interval, however often it is called", async () => {
		const p = await freshPlacement(1);
		let clock = 1_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
		try {
			let fetches = 0;
			const fetcher = (async () => {
				fetches += 1;
				return new Response("colo=SJC\nloc=US\n");
			}) as unknown as typeof fetch;
			const pending: Promise<unknown>[] = [];
			const ctx = { waitUntil: (x: Promise<unknown>) => pending.push(x), label: "engine-wnam" };

			for (let i = 0; i < 5; i++) p.probePlacement(ctx, fetcher);
			await Promise.all(pending);
			expect(fetches).toBe(1);

			// Still throttled a minute later — a region that thrashes must not pay the
			// eviction hold on every wake.
			clock += 60_000;
			p.probePlacement(ctx, fetcher);
			await Promise.all(pending);
			expect(fetches).toBe(1);

			clock += p.PROBE_MIN_INTERVAL_MS;
			p.probePlacement(ctx, fetcher);
			await Promise.all(pending);
			expect(fetches).toBe(2);
		} finally {
			nowSpy.mockRestore();
		}
	});

	test("returns without waiting for the trace, and parks the work on waitUntil", async () => {
		const p = await freshPlacement(2);
		// A trace that never answers on its own: only the test can complete it, so
		// "did probePlacement return?" and "did the probe finish?" are separable.
		let answer = (_: Response) => {};
		const fetcher = (() => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof fetch;
		const pending: Promise<unknown>[] = [];
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			p.probePlacement({ waitUntil: (x: Promise<unknown>) => pending.push(x), label: "engine-wnam" }, fetcher);
			// The caller is a store load or a publish notify; neither may wait on this.
			expect(pending).toHaveLength(1);
			expect(log).not.toHaveBeenCalled();

			answer(new Response("colo=SJC\n"));
			await Promise.all(pending);
			expect(log).toHaveBeenCalledWith("[engine-wnam] placement: colo=SJC loc=?");
		} finally {
			log.mockRestore();
		}
	});

	test("an unlabelled context never probes, because an unattributed colo answers nothing", async () => {
		const p = await freshPlacement(3);
		const pending: Promise<unknown>[] = [];
		p.probePlacement({ waitUntil: (x: Promise<unknown>) => pending.push(x) });
		expect(pending).toHaveLength(0);
	});

	test("a failed probe is a missing diagnostic, not an incident", async () => {
		const p = await freshPlacement(4);
		const fetcher = (async () => {
			throw new Error("trace unreachable");
		}) as unknown as typeof fetch;
		const pending: Promise<unknown>[] = [];
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			p.probePlacement({ waitUntil: (x: Promise<unknown>) => pending.push(x), label: "engine-wnam" }, fetcher);
			// Rejecting here would surface as an unhandled rejection inside a store
			// load, which is a real request's critical path.
			await expect(Promise.all(pending)).resolves.toBeDefined();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("the throttle interval is long enough to bound the eviction hold", () => {
		// An outbound request keeps a DO resident for as long as its connection is
		// pooled (~15 minutes). An interval below that would keep an idle object
		// alive continuously and defeat scale-to-zero outright.
		expect(PROBE_MIN_INTERVAL_MS).toBeGreaterThan(15 * 60 * 1000);
	});
});
