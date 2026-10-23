// The slow-request line (src/routes/slow-request.ts).
//
// DeckGen 2026-10-23 15:20–16:15 UTC: mtgseeker timed out at 8s ~25 times on routes that never
// touch an engine (`/catalog/ability-words`, `/cards/:id/rulings`), and sylvan's own logs — with
// invocation logs off — held nothing for any of them. Pinned here: every request that takes the
// threshold or longer leaves ONE line naming its route key, its time, its status, the stages it
// spent that time in (the KV reads of the KV-only routes included) and whether its isolate was
// cold; a fast request leaves nothing; and dispatch wires it around every exit.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogKey, encodeCountedArray, renderCatalog } from "../../src/engine/reference-kv";
import { routes } from "../../src/routes";
import type { RouteContext, RouteEntry } from "../../src/routes/registry";
import { RequestStages } from "../../src/routes/request-deadline";
import {
	noteRequestStart,
	reportIfSlow,
	resetIsolateForTests,
	SLOW_REQUEST_MS,
	setSlowRequestMsForTests,
	slowRequestLine,
} from "../../src/routes/slow-request";
import { FakeKV, makeCtx } from "./harness";

const never = <T>() => new Promise<T>(() => {});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** console.warn, captured: the slow line is the only record of a slow request. */
function warnings() {
	const spy = spyOn(console, "warn").mockImplementation(() => {});
	return { lines: () => spy.mock.calls.map((c) => String(c[0])), restore: () => spy.mockRestore() };
}

let logged: ReturnType<typeof warnings> | null = null;
const DEFAULT_SLOW_MS = SLOW_REQUEST_MS;
beforeEach(() => resetIsolateForTests());
afterEach(() => {
	logged?.restore();
	logged = null;
	setSlowRequestMsForTests(DEFAULT_SLOW_MS);
});

describe("the threshold", () => {
	test("is a second: far over any healthy route's p99, far under the 8s a client gives up at", () => {
		expect(SLOW_REQUEST_MS).toBe(1_000);
	});
});

describe("the isolate", () => {
	test("its first request is cold, every later one warm, all under one id", () => {
		const first = noteRequestStart(1_000);
		const second = noteRequestStart(4_500);
		expect(first.cold).toBe(true);
		expect(first.isolateRequest).toBe(1);
		expect(second.cold).toBe(false);
		expect(second.isolateRequest).toBe(2);
		expect(second.isolateAgeMs).toBe(3_500);
		expect(first.isolateId).toMatch(/^[0-9a-f]{6}$/);
		expect(second.isolateId).toBe(first.isolateId);
	});
});

describe("RequestStages.spent", () => {
	test("sums each settled label, counts repeats, and lists what is still open", async () => {
		const stages = new RequestStages();
		await stages.track("manifest", async () => 1);
		await stages.track("engine.scryfallCardById", () => sleep(15));
		await stages.track("engine.scryfallCardById", () => sleep(15));
		void stages.track("kv.rulings", () => never());
		expect(stages.spent()).toMatch(
			/^manifest \d+ms, engine\.scryfallCardById (\d+)ms \(2 calls\); open: kv\.rulings for \d+ms$/,
		);
		const summed = Number(/scryfallCardById (\d+)ms/.exec(stages.spent())?.[1]);
		expect(summed).toBeGreaterThanOrEqual(25);
	});

	test("is empty when nothing was tracked", () => {
		expect(new RequestStages().spent()).toBe("");
	});
});

describe("slowRequestLine", () => {
	test("names the route key, time, status, stages and isolate — and nothing about the client", async () => {
		const stages = new RequestStages();
		await stages.track("kv.reference", async () => null);
		const start = noteRequestStart(10_000);
		const line = slowRequestLine({ method: "GET", route: "catalog", ms: 8_123, status: 200, stages, start });
		expect(line).toMatch(
			/^slow request: GET catalog 8123ms -> 200; kv\.reference \d+ms; isolate [0-9a-f]{6} req #1 \(cold\)$/,
		);
	});

	test("a warm isolate says how old it is; an engine that answered is named", () => {
		noteRequestStart(0);
		const start = noteRequestStart(42_000);
		const line = slowRequestLine({
			method: "GET",
			route: "cards",
			ms: 4_051,
			status: 200,
			stages: null,
			start,
			engine: "do-enam",
		});
		expect(line).toMatch(
			/^slow request: GET cards 4051ms -> 200; no tracked stage \(the handler's own awaits\); isolate [0-9a-f]{6} req #2 \(warm, 42s old\); engine do-enam$/,
		);
	});
});

describe("reportIfSlow", () => {
	test("logs one line at or past the threshold, and nothing under it", () => {
		logged = warnings();
		const start = noteRequestStart(0);
		reportIfSlow({ method: "GET", route: "catalog", ms: 999, status: 200, stages: null, start });
		expect(logged.lines()).toEqual([]);
		reportIfSlow({ method: "GET", route: "catalog", ms: 1_000, status: 200, stages: null, start });
		expect(logged.lines()).toHaveLength(1);
		expect(logged.lines()[0]).toStartWith("slow request: GET catalog 1000ms -> 200;");
	});
});

describe("the KV-only routes' reads are stages", () => {
	/** A KV whose every read takes `delayMs`, holding one published catalog. */
	function slowKv(delayMs: number): FakeKV {
		const kv = new FakeKV();
		const abilityWords = renderCatalog(["Landfall", "Raid"]);
		kv.put(catalogKey("ability-words"), encodeCountedArray(abilityWords.json, abilityWords.count));
		const get = kv.get.bind(kv);
		kv.get = async (key, options) => {
			await sleep(delayMs);
			return get(key, options);
		};
		return kv;
	}

	test("a slow /catalog read is named on the slow line as kv.reference, with its time", async () => {
		logged = warnings();
		setSlowRequestMsForTests(20);
		const stages = new RequestStages();
		const ctx: RouteContext = { ...makeCtx({ kv: slowKv(40) }), track: (label, work) => stages.track(label, work) };
		const start = noteRequestStart();
		const res = await (routes.catalog as RouteEntry).handler(ctx, ["ability-words"], {});
		expect(res.status).toBe(200);
		reportIfSlow({ method: "GET", route: "catalog", ms: Date.now() - start.at, status: res.status, stages, start });
		expect(logged.lines()).toHaveLength(1);
		const spentMs = Number(/kv\.reference (\d+)ms/.exec(logged.lines()[0] ?? "")?.[1]);
		expect(spentMs).toBeGreaterThanOrEqual(35);
	});

	test("an untracked context (tests, tooling) still answers", async () => {
		const res = await (routes.catalog as RouteEntry).handler(makeCtx({ kv: slowKv(0) }), ["ability-words"], {});
		expect(res.status).toBe(200);
	});
});

describe("dispatch", () => {
	// `src/index.ts` imports `cloudflare:workers` and cannot be loaded here, so its wiring is pinned
	// by its text, as request-deadline.test.ts pins the deadline's.
	const source = readFileSync(join(import.meta.dir, "../../src/index.ts"), "utf8");

	test("every request is counted at its start and reported after its answer, whichever exit it took", () => {
		expect(source).toMatch(
			/override async fetch\(request: Request\): Promise<Response> \{\s+const start = noteRequestStart\(\);/,
		);
		expect(source).toMatch(/\} finally \{[\s\S]*?reportIfSlow\(\{/);
	});

	test("the handler's stages are the ones the line reads, and routes can track their own reads", () => {
		expect(source).toMatch(/record\.stages = stages;/);
		expect(source).toMatch(/REQUEST_DEADLINE_MS,\s+stages,\s+\);/);
		expect(source).toMatch(/track: \(label, work\) => stages\.track\(label, work\),/);
	});
});
