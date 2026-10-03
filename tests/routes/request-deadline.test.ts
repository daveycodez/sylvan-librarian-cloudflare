// The one deadline over a whole request (src/routes/request-deadline.ts, x57).
//
// DeckGen 2026-10-03, 15:56:21 and 16:06:46 UTC: two `GET /cards/search?q=otag:lifegain-to-damage`
// ran 100.002s and 99.998s on 7.7ms and 2.8ms of CPU, made no subrequest, and were answered by the
// edge (524) rather than by us — each was waiting, before any engine call, on a read with no
// deadline. Pinned here: a handler that never answers is answered FOR, in the surface's own error
// shape, with one log line naming what it was waiting on; and a handler that does answer, or fail,
// inside the window is passed through untouched.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PartitionedEngine } from "../../src/engine/partitioned-engine";
import { ENGINE_CALL_DEADLINE_MS, type RemoteEngine } from "../../src/engine/remote-engine";
import { EngineUnavailableError, type StoreManifest } from "../../src/engine/types";
import { routes } from "../../src/routes";
import type { RouteEntry } from "../../src/routes/registry";
import {
	answerInTime,
	answerWithin,
	REQUEST_DEADLINE_DETAILS,
	REQUEST_DEADLINE_MS,
	RequestStages,
} from "../../src/routes/request-deadline";
import { FakeEngine, json, makeCtx } from "./harness";

const never = <T>() => new Promise<T>(() => {});
const SEARCH = { method: "GET", key: "cards/search", scryfallSurface: true };
/** The real `/cards/search` handler: the route both unanswered requests were on. */
const searchRoute = routes["cards/search"] as RouteEntry;

/** console.error, captured: the deadline's line is the only way the next occurrence is found. */
function errors() {
	const spy = spyOn(console, "error").mockImplementation(() => {});
	return { lines: () => spy.mock.calls.map((c) => String(c[0])), restore: () => spy.mockRestore() };
}

let logged: ReturnType<typeof errors> | null = null;
afterEach(() => {
	logged?.restore();
	logged = null;
});

describe("the bound", () => {
	test("sits above one engine call's own deadline and far below the edge's 100s", () => {
		// One engine call that never answers must surface as ITS timeout, with its hedge and failover
		// lines, before this fires; and this must fire long before the edge answers 524 for us.
		expect(REQUEST_DEADLINE_MS).toBeGreaterThan(ENGINE_CALL_DEADLINE_MS);
		expect(REQUEST_DEADLINE_MS).toBeLessThanOrEqual(45_000);
	});
});

describe("answerWithin", () => {
	test("work that answers in time is the answer, and the late answer is never built", async () => {
		let built = 0;
		const late = () => {
			built++;
			return "late";
		};
		expect(await answerWithin(Promise.resolve("ok"), 30, late)).toBe("ok");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(built).toBe(0);
	});

	test("work that never answers is answered for when the window closes", async () => {
		const started = Date.now();
		expect(await answerWithin(never<string>(), 30, () => "late")).toBe("late");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("a failure inside the window is the caller's; one after it is dropped", async () => {
		await expect(answerWithin(Promise.reject(new Error("boom")), 30, () => "late")).rejects.toThrow("boom");
		let fail: (err: Error) => void = () => {};
		const work = new Promise<string>((_, reject) => {
			fail = reject;
		});
		expect(await answerWithin(work, 10, () => "late")).toBe("late");
		// Were this unhandled, bun would fail the run on it.
		fail(new Error("after the deadline"));
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
});

describe("RequestStages", () => {
	test("names every call still open, oldest first, and the last one to finish", async () => {
		const stages = new RequestStages();
		expect(stages.describe()).toBe("no tracked call open (the handler's own awaits); last finished: none");
		expect(await stages.track("manifest", async () => 1)).toBe(1);
		void stages.track("tag-aliases", () => never());
		await new Promise((resolve) => setTimeout(resolve, 15));
		void stages.track("engine.scryfallSearchPage", () => never());
		expect(stages.describe()).toMatch(
			/^waiting on tag-aliases for \d+ms, engine\.scryfallSearchPage for \d+ms; last finished: manifest$/,
		);
	});

	test("a stage closes when its call fails too, and the failure is the caller's", async () => {
		const stages = new RequestStages();
		await expect(
			stages.track("manifest", () => Promise.reject(new EngineUnavailableError("no store"))),
		).rejects.toThrow("no store");
		expect(() =>
			stages.track("manifest", () => {
				throw new Error("sync");
			}),
		).toThrow("sync");
		expect(stages.describe()).toBe("no tracked call open (the handler's own awaits); last finished: manifest");
	});

	test("a watched engine tracks its calls and is otherwise the engine itself", async () => {
		class Counting {
			calls = 0;
			private hidden = "h";
			get label(): string {
				return `engine:${this.hidden}`;
			}
			async search(q: string): Promise<string> {
				this.calls++;
				return `found ${q} on ${this.label}`;
			}
			hang(): Promise<string> {
				return never();
			}
			syncWidth(): number {
				return 11;
			}
		}
		const engine = new Counting();
		const stages = new RequestStages();
		const watched = stages.watch(engine);
		// Methods run on the engine, with its own `this`; fields and getters read through — the routes
		// read `partitionCalls`, `gatheredPartitions` and friends off it after a call.
		expect(await watched.search("bolt")).toBe("found bolt on engine:h");
		expect(watched.calls).toBe(1);
		expect(engine.calls).toBe(1);
		expect(watched.label).toBe("engine:h");
		expect(watched.syncWidth()).toBe(11);
		expect(watched instanceof Counting).toBe(true);
		// A write lands on the engine, not on a shadow.
		watched.calls = 5;
		expect(engine.calls).toBe(5);
		void watched.hang();
		expect(stages.describe()).toMatch(/^waiting on engine\.hang for \d+ms; last finished: engine\.search$/);
	});

	test("the engine dispatch really watches — a PartitionedEngine — answers and counts as before", async () => {
		const manifest = {
			store_key: "card-store-v1-100-x57.store",
			built_at: "100",
			partition_count: 3,
			partition_hash: "fnv1a64/oracle_id/v1",
			partitions: [{}, {}, {}],
		} as unknown as StoreManifest;
		const engine = new PartitionedEngine(
			() => ({ cardCount: async () => 10 }) as unknown as RemoteEngine,
			manifest,
			async () => manifest,
			null,
		);
		const stages = new RequestStages();
		const watched = stages.watch(engine);
		expect(await watched.cardCount()).toBe(30);
		// What the routes' per-request log lines read off the engine after a call.
		expect(watched.partitionCalls).toBe(3);
		expect(watched.gatheredPartitions).toBeNull();
		expect(watched instanceof PartitionedEngine).toBe(true);
		expect(stages.describe()).toBe("no tracked call open (the handler's own awaits); last finished: engine.cardCount");
	});
});

describe("answerInTime", () => {
	test("the incident: /cards/search waiting on its alias read is answered 503, and the log says on what", async () => {
		logged = errors();
		const started = Date.now();
		const res = await answerInTime(
			SEARCH,
			(stages) =>
				searchRoute.handler(
					{
						...makeCtx(),
						getEngine: () => stages.track("manifest", async () => new FakeEngine()).then((e) => stages.watch(e)),
						tagAliases: () => stages.track("tag-aliases", () => never()),
					},
					[],
					{ q: "otag:lifegain-to-damage", unique: "cards", page: "1" },
				),
			40,
		);
		expect(Date.now() - started).toBeLessThan(1_000);
		// Scryfall's error object, the same retryable 503 an unloaded store answers with, and no-cache.
		expect(res.status).toBe(503);
		expect(await json(res)).toEqual({
			object: "error",
			code: "service_unavailable",
			status: 503,
			details: REQUEST_DEADLINE_DETAILS,
		});
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		// One line, findable by its first two words, naming the stage and never the query.
		expect(logged.lines().length).toBe(1);
		expect(logged.lines()[0]).toMatch(
			/^request deadline: GET cards\/search gave no answer within 40ms; waiting on tag-aliases for \d+ms; last finished: manifest; answering 503$/,
		);
		expect(logged.lines()[0]).not.toContain("lifegain");
	});

	test("an engine call that never answers is named by its method", async () => {
		logged = errors();
		class Stuck extends FakeEngine {
			override scryfallSearchPage(): Promise<never> {
				return never();
			}
		}
		const res = await answerInTime(
			SEARCH,
			(stages) =>
				searchRoute.handler(
					{
						...makeCtx(),
						getEngine: () => stages.track("manifest", async () => new Stuck()).then((e) => stages.watch(e)),
					},
					[],
					{ q: "bolt" },
				),
			40,
		);
		expect(res.status).toBe(503);
		expect(logged.lines()[0]).toMatch(/waiting on engine\.scryfallSearchPage for \d+ms; last finished: /);
	});

	test("upstream's surface gets upstream's error shape", async () => {
		logged = errors();
		const res = await answerInTime({ method: "GET", key: "search", scryfallSurface: false }, () => never(), 20);
		expect(res.status).toBe(503);
		expect(await json(res)).toEqual({ title: "Service Unavailable", description: REQUEST_DEADLINE_DETAILS });
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(logged.lines()[0]).toStartWith(
			"request deadline: GET search gave no answer within 20ms; no tracked call open",
		);
	});

	test("a handler that answers in time is untouched: same response, nothing logged", async () => {
		logged = errors();
		const res = await answerInTime(
			SEARCH,
			(stages) =>
				searchRoute.handler(
					{
						...makeCtx(),
						getEngine: () => stages.track("manifest", async () => new FakeEngine()).then((e) => stages.watch(e)),
					},
					[],
					{ q: "bolt" },
				),
			5_000,
		);
		expect(res.status).toBe(200);
		expect((await json(res)).object).toBe("list");
		expect(logged.lines()).toEqual([]);
	});

	test("what a handler throws inside the window is still dispatch's to map", async () => {
		const redirect = new Response(null, { status: 301 });
		await expect(
			answerInTime(SEARCH, () => {
				throw redirect;
			}),
		).rejects.toBe(redirect);
		await expect(
			answerInTime(SEARCH, async () => {
				throw new EngineUnavailableError("no store");
			}),
		).rejects.toBeInstanceOf(EngineUnavailableError);
	});
});

describe("dispatch", () => {
	// `src/index.ts` imports `cloudflare:workers` and cannot be loaded here, so its wiring is pinned
	// by its text: every handler runs under the deadline, with the manifest read, the alias read and
	// the engine's calls each tracked — and it adds no retry of its own.
	const source = readFileSync(join(import.meta.dir, "../../src/index.ts"), "utf8");

	test("every handler runs under the request deadline, with its stages tracked", () => {
		expect(source.match(/entry\.handler\(/g)?.length).toBe(1);
		expect(source).toMatch(
			/await answerInTime\(\{ method: request\.method, key: resolved\.key, scryfallSurface \}, \(stages\) =>\s+entry\.handler\(/,
		);
		expect(source).toMatch(
			/stages\.track\("manifest", \(\) => resolveEngine\(request, env, ctx, engineSource\)\)\.then\(\(e\) => stages\.watch\(e\)\)/,
		);
		expect(source).toMatch(/stages\.track\("tag-aliases", \(\) =>/);
	});
});
