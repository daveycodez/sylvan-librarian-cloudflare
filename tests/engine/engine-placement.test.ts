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

import { Database } from "bun:sqlite";
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
import { type ArchiveCacheStorage, lastPlacement } from "../../src/engine/store-cache";
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
			.filter(
				(f) => f.path !== CHOKE_POINT && f.path !== "routes/rate-limit.ts" && f.path !== "engine/placement-probe.ts",
			)
			.filter((f) => /locationHint/.test(code(f.text)))
			.map((f) => f.path);
		// rate-limit.ts is exempt on purpose: its objects are per-IP, hold a few
		// counters, and are created by the same edge isolate that serves the
		// request. A misplaced one costs a token bucket, not an ~88MB archive.
		// placement-probe.ts is exempt because placing an object by a hint IS the probe — see below
		// for what keeps that exemption from ever reaching an engine object.
		expect(offenders).toEqual([]);
	});

	test("the placement probe places only its own throwaway class, and never stores anything", () => {
		// g1's nightly probe creates objects with a hint from inside the coordinator — exactly what
		// this file forbids for engine objects. It is safe only because the probe's objects are a
		// class of their own, addressed by newUniqueId (never a name anything reuses), and hold no
		// storage, so each one ceases to exist when idle.
		const probe = code(sourceFiles(SRC).find((f) => f.path === "engine/placement-probe.ts")?.text ?? "");
		expect(probe).toContain("newUniqueId()");
		expect(probe).not.toMatch(/SEARCH_ENGINE/);
		expect(probe).not.toMatch(/ctx\s*\.\s*storage|\.storage\b|deleteAll/);
		expect(probe).not.toMatch(/idFromName/);
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

	/**
	 * Swap the global timers for handles this test can see, so "is a timer still armed?" — which is
	 * otherwise invisible from inside the process — becomes an assertion. Promises do not go through
	 * setTimeout, so the probe's own control flow is unaffected.
	 */
	function captureTimers() {
		const armed: { fn: () => void; ms?: number }[] = [];
		const cleared: unknown[] = [];
		const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
			const handle = { fn, ms };
			armed.push(handle);
			return handle as unknown as ReturnType<typeof setTimeout>;
		}) as unknown as typeof setTimeout);
		const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((h: unknown) => {
			cleared.push(h);
		}) as unknown as typeof clearTimeout);
		const restore = () => {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		};
		return { armed, cleared, restore };
	}

	test("the answered probe leaves no timer armed, so it cannot hold the invocation open", async () => {
		// THE REGRESSION THIS EXISTS FOR. `AbortSignal.timeout` cannot be cancelled, so its timer
		// stayed pending in the Durable Object's I/O context long after the trace had answered and
		// the invocation could not close until it fired. Production request f7f1321e ended exactly
		// PROBE_TIMEOUT_MS after the probe was armed, having finished its work in 690ms.
		const p = await freshPlacement(5);
		const timers = captureTimers();
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const fetcher = (async () => new Response("colo=SJC\nloc=US\n")) as unknown as typeof fetch;
			const pending: Promise<unknown>[] = [];
			p.probePlacement({ waitUntil: (x: Promise<unknown>) => pending.push(x), label: "engine-wnam" }, fetcher);
			await Promise.all(pending);

			expect(timers.armed).toHaveLength(1);
			expect(timers.armed[0]?.ms).toBe(p.PROBE_TIMEOUT_MS);
			// Cancelled, not merely fired-and-ignored: an uncancelled timer is the bug.
			expect(timers.cleared).toEqual([timers.armed[0]]);
		} finally {
			log.mockRestore();
			timers.restore();
		}
	});

	test("a hung probe is still abandoned at the deadline", async () => {
		// The property the timeout was added for, and which cancelling it must not cost: nothing
		// depends on the trace, so a probe that never answers must not keep the object resident.
		const p = await freshPlacement(6);
		const timers = captureTimers();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Answers only by being aborted — the shape of a trace endpoint that has gone silent.
			const fetcher = ((_url: string, init?: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				})) as unknown as typeof fetch;
			const pending: Promise<unknown>[] = [];
			p.probePlacement({ waitUntil: (x: Promise<unknown>) => pending.push(x), label: "engine-wnam" }, fetcher);
			expect(timers.cleared).toEqual([]);

			// Fire the deadline by hand rather than waiting five seconds for it.
			timers.armed[0]?.fn();
			await Promise.all(pending);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			timers.restore();
		}
	});

	test("the per-isolate backstop is long enough that a dead trace endpoint is not retried per wake", () => {
		// It only matters when a probe FAILED (a success is remembered in storage for
		// PLACEMENT_FRESH_MS). An object hibernates after ~10s idle, so a backstop in seconds would
		// put a failing subrequest on nearly every wake.
		expect(PROBE_MIN_INTERVAL_MS).toBeGreaterThan(15 * 60 * 1000);
	});
});

/** The DO's SQLite, for real: bun:sqlite behind the ArchiveCacheStorage surface, counting row writes. */
function sqliteStorage() {
	const db = new Database(":memory:");
	let rowWrites = 0;
	const storage = {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				if (bindings.length === 0 && query.includes(";")) {
					db.exec(query);
					return { toArray: () => [] };
				}
				const stmt = db.query(query);
				if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) {
					rowWrites += stmt.run(...(bindings as never[])).changes;
					return { toArray: () => [] };
				}
				return { toArray: () => stmt.all(...(bindings as never[])) as Record<string, SqlStorageValue>[] };
			},
		},
	} as unknown as ArchiveCacheStorage;
	return { storage, db, rowWrites: () => rowWrites };
}

describe("probing is once per OBJECT, remembered in its storage", () => {
	async function freshPlacement(gen: number) {
		return await import(`../../src/engine/placement.ts?persist=${gen}`);
	}
	const trace = (colo = "AMS") => (async () => new Response(`colo=${colo}\nloc=DE\n`)) as unknown as typeof fetch;

	test("a fresh isolate on the same object does not probe again inside PLACEMENT_FRESH_MS", async () => {
		// THE REGRESSION: the throttle lived in module state, and every hibernation wake is a fresh
		// isolate — 10,446 probes on DeckGen on 2026-09-23 for objects that never moved.
		const { storage, rowWrites } = sqliteStorage();
		let clock = 1_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			let fetches = 0;
			const fetcher = (async () => {
				fetches += 1;
				return new Response("colo=AMS\nloc=DE\n");
			}) as unknown as typeof fetch;
			const ctx = { waitUntil: () => {}, label: "engine-weur-p1", storage };

			const first = await freshPlacement(1);
			expect(await first.probePlacement(ctx, fetcher)).toEqual({ colo: "AMS", at: 1_000_000 });
			expect(fetches).toBe(1);
			expect(rowWrites()).toBe(1);

			// Wake after wake, each in a new isolate (a new module instance), 90 minutes apart.
			for (let wake = 2; wake < 12; wake++) {
				clock += 90 * 60 * 1000;
				const p = await freshPlacement(wake);
				expect(await p.probePlacement(ctx, fetcher)).toBeNull();
			}
			expect(fetches).toBe(1);
			expect(rowWrites()).toBe(1);

			// Past the window the next wake measures again — and it is ONE row, an upsert, not a
			// REPLACE's delete plus insert.
			clock = 1_000_000 + first.PLACEMENT_FRESH_MS;
			const later = await freshPlacement(99);
			await later.probePlacement(ctx, trace("CDG"));
			expect(rowWrites()).toBe(2);
			expect(lastPlacement(storage)).toEqual({ colo: "CDG", at: clock });
		} finally {
			nowSpy.mockRestore();
			log.mockRestore();
		}
	});

	test("a failed probe records nothing, and the per-isolate backstop paces the retry", async () => {
		const { storage, rowWrites } = sqliteStorage();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const p = await freshPlacement(200);
			const ctx = { waitUntil: () => {}, label: "engine-weur-p2", storage };
			const failing = (async () => {
				throw new Error("trace unreachable");
			}) as unknown as typeof fetch;
			expect(await p.probePlacement(ctx, failing)).toBeNull();
			expect(rowWrites()).toBe(0);
			expect(lastPlacement(storage)).toBeNull();
			let fetches = 0;
			await p.probePlacement(ctx, (async () => {
				fetches += 1;
				return new Response("colo=AMS\n");
			}) as unknown as typeof fetch);
			expect(fetches).toBe(0);
		} finally {
			warn.mockRestore();
		}
	});

	test("objects sharing an isolate do not suppress each other's probe", async () => {
		// Partitions of one region can be co-resident; one module-wide slot let engine-weur-p1's
		// probe starve engine-weur-p2's for an hour.
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const p = await freshPlacement(300);
			const a = sqliteStorage();
			const b = sqliteStorage();
			await p.probePlacement({ waitUntil: () => {}, label: "engine-weur-p1", storage: a.storage }, trace());
			await p.probePlacement({ waitUntil: () => {}, label: "engine-weur-p2", storage: b.storage }, trace());
			expect(lastPlacement(a.storage)?.colo).toBe("AMS");
			expect(lastPlacement(b.storage)?.colo).toBe("AMS");
		} finally {
			log.mockRestore();
		}
	});

	test("a placement is fresh for less than a day, so every nightly prepare re-measures a warm object", async () => {
		const p = await freshPlacement(400);
		expect(p.PLACEMENT_FRESH_MS).toBeLessThan(24 * 60 * 60 * 1000);
		expect(p.PLACEMENT_FRESH_MS).toBeGreaterThan(12 * 60 * 60 * 1000);
	});

	test("the table arrives on an object that predates it, and a released object answers 'never measured'", async () => {
		// Existing objects already hold the older tables; `placement` must appear by CREATE TABLE IF
		// NOT EXISTS alone, with no migration step and nothing else touched. And releaseCache's
		// deleteAll drops every table — the next read must answer "never measured", not throw.
		const { storage, db } = sqliteStorage();
		db.exec("CREATE TABLE announced (id INTEGER PRIMARY KEY, store_key TEXT NOT NULL)");
		db.exec("INSERT INTO announced (id, store_key) VALUES (0, 'card-store-old')");
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(lastPlacement(storage)).toBeNull();
			const p = await freshPlacement(500);
			await p.probePlacement({ waitUntil: () => {}, label: "engine-weur-p3", storage }, trace("AMS"));
			expect(lastPlacement(storage)?.colo).toBe("AMS");
			expect(db.query("SELECT store_key FROM announced").get()).toEqual({ store_key: "card-store-old" });

			// deleteAll(): every table gone, schema included.
			const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
			for (const { name } of tables) db.exec(`DROP TABLE ${name}`);
			expect(lastPlacement(storage)).toBeNull();
			const again = await freshPlacement(501);
			const ctx = { waitUntil: () => {}, label: "engine-weur-p3", storage };
			expect((await again.probePlacement(ctx, trace("FRA")))?.colo).toBe("FRA");
		} finally {
			log.mockRestore();
		}
	});
});
