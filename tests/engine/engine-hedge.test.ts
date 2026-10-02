// The hedge around every engine read (remote-engine.ts ENGINE_HEDGE_MS).
//
// Production, 2026-09-23..25: an engine object evicted after ~10s idle is torn down while requests
// still arrive, and a request that lands on the dying instance can HANG until the object restarts
// elsewhere — 19–36s, and once 15 minutes. Retrying the same object waits on the same teardown, so a
// call silent for ENGINE_HEDGE_MS is also sent to the same partition in a neighbouring served region
// (hedgeRegionFor), and the first answer wins.
//
// Real timers, shortened (setEngineHedgeForTests / setEngineCallDeadlineForTests), as the deadline
// suite (engine-deadlines.test.ts) does — the whole file runs in about two seconds.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { effectiveRegion, type Hint, hedgeRegionFor, type PlacementBlock } from "../../src/engine/placement-policy";
import { REGION_HINTS } from "../../src/engine/region";
import {
	ENGINE_SHED_ERROR,
	EngineCallTimeoutError,
	type EngineHedge,
	RemoteEngine,
	resetEngineCoolingForTests,
	setEngineCallDeadlineForTests,
	setEngineCoolingForTests,
	setEngineHedgeForTests,
} from "../../src/engine/remote-engine";
import { EngineQueryError, StaleModulusError } from "../../src/engine/types";

type Stub = ConstructorParameters<typeof RemoteEngine>[0];
const HEDGE_MS = 25;
const envelope = { pretty: false, pageOffset: 0, noMatchDetails: "" };
const never = <T>() => new Promise<T>(() => {});
const after = <T>(ms: number, value: () => T | Promise<T>) =>
	new Promise<T>((resolve, reject) => setTimeout(() => Promise.resolve().then(value).then(resolve, reject), ms));
const card = (name: string) => ({ card: { name }, load: 0, rate: 0, shards: 1 });
const byId = (stub: Record<string, unknown>) => stub as unknown as Stub;

/** A hedge target that counts how often it was connected and called. */
function neighbour(stub: Record<string, unknown>, region = "enam") {
	const seen = { connects: 0 };
	const hedge: EngineHedge = {
		region,
		partition: 3,
		connect: () => {
			seen.connects++;
			return byId(stub);
		},
	};
	return { hedge, seen };
}

beforeEach(() => {
	setEngineHedgeForTests(HEDGE_MS);
	setEngineCallDeadlineForTests(400);
	// Every test here starts with no object cooling: the strikes live in module state (x45).
	resetEngineCoolingForTests();
});
afterEach(() => {
	setEngineHedgeForTests(4_000);
	setEngineCallDeadlineForTests(35_000);
	setEngineCoolingForTests(120_000);
	resetEngineCoolingForTests();
});

describe("the RPC transport", () => {
	test("a primary that answers fast is the answer, and the neighbour is never asked", async () => {
		const { hedge, seen } = neighbour({ scryfallCardById: async () => card("neighbour") });
		const engine = new RemoteEngine(
			byId({ scryfallCardById: async () => card("own") }),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		expect(await engine.scryfallCardById("x", "https://x")).toEqual({ name: "own" });
		// Past the hedge delay too: the timer was cleared, not merely outrun.
		await after(HEDGE_MS * 2, () => {});
		expect(seen.connects).toBe(0);
	});

	test("a primary that hangs: the hedge fires at ENGINE_HEDGE_MS and its answer wins", async () => {
		let hedgeAskedAt = 0;
		const started = Date.now();
		const { hedge, seen } = neighbour({
			scryfallCardById: async () => {
				hedgeAskedAt = Date.now() - started;
				return card("neighbour");
			},
		});
		const engine = new RemoteEngine(byId({ scryfallCardById: () => never() }), "wnam", "SJC", undefined, false, hedge);
		expect(await engine.scryfallCardById("x", "https://x")).toEqual({ name: "neighbour" });
		expect(seen.connects).toBe(1);
		expect(hedgeAskedAt).toBeGreaterThanOrEqual(HEDGE_MS - 2);
		expect(Date.now() - started).toBeLessThan(200); // not the 400ms deadline
	});

	test("a primary that answers just after the hedge fires still wins; the neighbour's late answer is ignored", async () => {
		let neighbourAnswered = false;
		const { hedge, seen } = neighbour({
			scryfallCardById: () =>
				after(HEDGE_MS * 4, () => {
					neighbourAnswered = true;
					return card("neighbour");
				}),
		});
		const engine = new RemoteEngine(
			byId({ scryfallCardById: () => after(HEDGE_MS + 15, () => card("own")) }),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		expect(await engine.scryfallCardById("x", "https://x")).toEqual({ name: "own" });
		expect(seen.connects).toBe(1);
		await after(HEDGE_MS * 5, () => {});
		expect(neighbourAnswered).toBe(true); // it did answer — and nothing took it
	});

	test("a fast transient failure gets today's retry on a fresh stub, and no hedge", async () => {
		// Above the retry's own 100–300ms pause, as 4s is in production: the timer runs from the call's
		// start, so a retry that is itself slow still gets hedged.
		setEngineHedgeForTests(350);
		let first = 0;
		let fresh = 0;
		const { hedge, seen } = neighbour({ scryfallCardById: async () => card("neighbour") });
		const engine = new RemoteEngine(
			byId({
				scryfallCardById: async () => {
					first++;
					throw new Error("Durable Object storage is no longer accessible.");
				},
			}),
			"wnam",
			"SJC",
			() =>
				byId({
					scryfallCardById: async () => {
						fresh++;
						return card("own-retry");
					},
				}),
			false,
			hedge,
		);
		expect(await engine.scryfallCardById("x", "https://x")).toEqual({ name: "own-retry" });
		expect([first, fresh, seen.connects]).toEqual([1, 1, 0]);
	});

	test("a fast failure fails over to the neighbour at once — no waiting for the hedge delay", async () => {
		// 2026-09-26 00:46 and 02:48 on DeckGen: a gather whose siblings' connections were lost failed in
		// 1–2s as a plain Error, and answered 500 without the neighbour ever being asked.
		setEngineHedgeForTests(60_000);
		const started = Date.now();
		const { hedge, seen } = neighbour({ scryfallSearch: async () => ({ totalCards: 7, load: 0, rate: 0 }) });
		const engine = new RemoteEngine(
			byId({
				scryfallSearch: async () => {
					throw new Error("Network connection lost.");
				},
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		expect((await engine.scryfallSearch({ limit: 1 } as never, "https://x")).totalCards).toBe(7);
		expect(seen.connects).toBe(1);
		expect(Date.now() - started).toBeLessThan(200);
	});

	test("a transient failure is retried on a fresh stub FIRST, and only a second failure fails over", async () => {
		setEngineHedgeForTests(60_000);
		const calls: string[] = [];
		const { hedge } = neighbour({
			scryfallCardById: async () => {
				calls.push("neighbour");
				return card("neighbour");
			},
		});
		const dying = (name: string) =>
			byId({
				scryfallCardById: async () => {
					calls.push(name);
					throw new Error("Connection closed: this Durable Object instance is no longer active.");
				},
			});
		const engine = new RemoteEngine(dying("own"), "wnam", "SJC", () => dying("own-fresh"), false, hedge);
		expect(await engine.scryfallCardById("x", "https://x")).toEqual({ name: "neighbour" });
		expect(calls).toEqual(["own", "own-fresh", "neighbour"]);
	});

	test("the neighbour failing too surfaces the PRIMARY's error, after one neighbour call", async () => {
		setEngineHedgeForTests(60_000);
		const { hedge, seen } = neighbour({
			scryfallSearch: async () => {
				throw new Error("the neighbour's own failure");
			},
		});
		const engine = new RemoteEngine(
			byId({
				scryfallSearch: async () => {
					throw new Error("TypeError: something broke");
				},
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		await expect(engine.scryfallSearch({ limit: 1 } as never, "https://x")).rejects.toThrow("something broke");
		expect(seen.connects).toBe(1);
	});

	test("a fast query error or stale-modulus refusal is the answer at once — never a failover", async () => {
		setEngineHedgeForTests(60_000);
		const { hedge, seen } = neighbour({ scryfallSearch: async () => ({ totalCards: 7 }) });
		for (const err of [new EngineQueryError("build_filter: unclosed regex"), new StaleModulusError("cut at 12")]) {
			const engine = new RemoteEngine(
				byId({
					scryfallSearch: async () => {
						throw err;
					},
				}),
				"wnam",
				"SJC",
				undefined,
				false,
				hedge,
			);
			// unwrap re-types a query error by its message, so the class is what survives, not the object.
			await expect(engine.scryfallSearch({ limit: 1 } as never, "https://x")).rejects.toBeInstanceOf(
				err.constructor as typeof Error,
			);
		}
		expect(seen.connects).toBe(0);
	});

	test("the failover logs its own line, apart from the hedge's", async () => {
		setEngineHedgeForTests(60_000);
		const lines: string[] = [];
		const warn = console.warn;
		console.warn = (...args: unknown[]) => lines.push(args.join(" "));
		try {
			const { hedge } = neighbour({ scryfallCardById: async () => card("neighbour") });
			const engine = new RemoteEngine(
				byId({
					scryfallCardById: async () => {
						throw new Error("Network connection lost.");
					},
				}),
				"wnam",
				"SJC",
				undefined,
				false,
				hedge,
			);
			await engine.scryfallCardById("x", "https://x");
		} finally {
			console.warn = warn;
		}
		expect(lines.some((l) => l.startsWith("[wnam] engine failover p3 scryfallCardById: wnam failed after"))).toBe(true);
		expect(lines.some((l) => l.includes("Network connection lost.") && l.endsWith("asking enam"))).toBe(true);
		expect(
			lines.some((l) =>
				/^\[wnam\] engine failover p3 scryfallCardById: failover won — enam answered at \d+ms$/.test(l),
			),
		).toBe(true);
		expect(lines.some((l) => l.includes("engine hedge"))).toBe(false);
	});

	test("both hang: the call still ends at the engine-call deadline, as the primary's timeout", async () => {
		const started = Date.now();
		const { hedge, seen } = neighbour({ scryfallCardById: () => never() });
		const engine = new RemoteEngine(byId({ scryfallCardById: () => never() }), "wnam", "SJC", undefined, false, hedge);
		await expect(engine.scryfallCardById("x", "https://x")).rejects.toBeInstanceOf(EngineCallTimeoutError);
		const took = Date.now() - started;
		expect(took).toBeGreaterThanOrEqual(395);
		expect(took).toBeLessThan(600); // the hedge's deadline is what is LEFT, not another 400ms
		expect(seen.connects).toBe(1);
	});

	test("both fail after the hedge fired: the PRIMARY's error is the one surfaced", async () => {
		const { hedge } = neighbour({
			scryfallCardById: () =>
				after(5, () => {
					throw new Error("the neighbour's own failure");
				}),
		});
		const engine = new RemoteEngine(
			byId({
				scryfallCardById: () =>
					after(HEDGE_MS + 30, () => {
						throw new Error("the primary's failure");
					}),
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		await expect(engine.scryfallCardById("x", "https://x")).rejects.toThrow("the primary's failure");

		// And in the other order: the primary fails first and waits on the hedge, which then fails too.
		const { hedge: late } = neighbour({
			scryfallCardById: () =>
				after(40, () => {
					throw new Error("the neighbour's own failure");
				}),
		});
		const other = new RemoteEngine(
			byId({
				scryfallCardById: () =>
					after(HEDGE_MS + 5, () => {
						throw new Error("the primary's failure");
					}),
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			late,
		);
		await expect(other.scryfallCardById("x", "https://x")).rejects.toThrow("the primary's failure");
	});

	test("a primary that fails after the hedge fired waits for the hedge, which answers", async () => {
		const { hedge } = neighbour({ scryfallCardById: () => after(HEDGE_MS, () => card("neighbour")) });
		const engine = new RemoteEngine(
			byId({
				scryfallCardById: () =>
					after(HEDGE_MS + 5, () => {
						throw new Error("Network connection lost.");
					}),
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		expect(await engine.scryfallCardById("x", "https://x")).toEqual({ name: "neighbour" });
	});

	test("a query error from the primary is the answer at once — the neighbour would say the same", async () => {
		const started = Date.now();
		const { hedge } = neighbour({ scryfallSearch: () => never() });
		const engine = new RemoteEngine(
			byId({
				scryfallSearch: () =>
					after(HEDGE_MS + 5, () => {
						throw new EngineQueryError("build_filter: unclosed regex");
					}),
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		await expect(engine.scryfallSearch({ limit: 1 } as never, "https://x")).rejects.toBeInstanceOf(EngineQueryError);
		expect(Date.now() - started).toBeLessThan(200);
	});

	test("the hedge reports NO fan-out width to the neighbour's rendezvous", async () => {
		const reported: (number | undefined)[] = [];
		const { hedge } = neighbour({
			scryfallCardById: async (_id: string, _base: string, shards?: number) => {
				reported.push(shards);
				return card("neighbour");
			},
		});
		const engine = new RemoteEngine(byId({ scryfallCardById: () => never() }), "wnam", "SJC", undefined, false, hedge);
		await engine.scryfallCardById("x", "https://x");
		expect(reported).toEqual([undefined]);
	});

	test("the catalog, random draws and fuzzy candidates are hedged; the warm ping's cardCount never is", async () => {
		const { hedge, seen } = neighbour({
			typeAndKeywordCounts: async () => ({ types: { Elf: 1 }, keywords: {}, setsWithExtras: [] }),
			randomCardsAsObjects: async () => [{ name: "neighbour" }],
			fuzzyCandidates: async () => ({ candidates: [] }),
			cardCount: async () => 9,
		});
		const hung = byId({
			typeAndKeywordCounts: () => never(),
			randomCardsAsObjects: () => never(),
			fuzzyCandidates: () => never(),
			cardCount: () => never(),
		});
		const engine = new RemoteEngine(hung, "wnam", "SJC", undefined, false, hedge);
		expect(await engine.cardTypeCounts()).toEqual({ Elf: 1 });
		expect(await engine.randomCardsAsObjects(1, [])).toEqual([{ name: "neighbour" }]);
		expect(await engine.fuzzyCandidates("x")).toEqual([]);
		expect(seen.connects).toBe(3);
		await expect(engine.cardCount()).rejects.toBeInstanceOf(EngineCallTimeoutError);
		expect(seen.connects).toBe(3);
	});

	test("no hedge configured: a hang is today's deadline error, and nothing else is asked", async () => {
		const engine = new RemoteEngine(byId({ scryfallCardById: () => never() }), "wnam");
		await expect(engine.scryfallCardById("x", "https://x")).rejects.toBeInstanceOf(EngineCallTimeoutError);
	});
});

describe("the page transport (the /cards/search and /search gathers)", () => {
	/** A 200 whose body records whether it was cancelled. A loser's stays open, as a real page still
	 * streaming would, so a cancel reaches it; a winner's closes so it can be read to the end. */
	function trackedPage(label: string, stillStreaming = false) {
		const state = { cancelled: false };
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`{"from":"${label}"}`));
				if (!stillStreaming) controller.close();
			},
			cancel() {
				state.cancelled = true;
			},
		});
		return {
			state,
			response: () =>
				new Response(body, { status: 200, headers: { "content-type": "application/json", "x-load": "3" } }),
		};
	}

	test("a hung coordinator: the neighbour's gather answers, and its riders are stripped", async () => {
		const bodies: string[] = [];
		const theirs = trackedPage("neighbour");
		const { hedge, seen } = neighbour({
			fetch: async (req: Request) => {
				bodies.push(await req.text());
				return theirs.response();
			},
		});
		const engine = new RemoteEngine(byId({ fetch: () => never() }), "wnam", "SJC", undefined, false, hedge);
		const res = await engine.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}, "cards2");
		expect(await res.text()).toBe('{"from":"neighbour"}');
		expect(res.headers.get("x-load")).toBeNull();
		expect(seen.connects).toBe(1);
		// The same gather, with no width folded into the neighbour's rendezvous.
		const sent = JSON.parse(bodies[0] ?? "{}");
		expect(sent.call).toBe("cards2");
		expect("shards" in sent).toBe(false);
	});

	test("the hedge wins: the primary's late stream is cancelled, not leaked", async () => {
		const ours = trackedPage("own", true);
		const theirs = trackedPage("neighbour");
		const { hedge } = neighbour({ fetch: async () => theirs.response() });
		const engine = new RemoteEngine(
			byId({ fetch: () => after(HEDGE_MS * 3, () => ours.response()) }),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		const res = await engine.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {});
		expect(await res.text()).toBe('{"from":"neighbour"}');
		await after(HEDGE_MS * 4, () => {});
		expect(ours.state.cancelled).toBe(true);
		expect(theirs.state.cancelled).toBe(false);
	});

	test("the primary wins after the hedge fired: the neighbour's late stream is cancelled", async () => {
		const ours = trackedPage("own");
		const theirs = trackedPage("neighbour", true);
		const { hedge, seen } = neighbour({ fetch: () => after(HEDGE_MS * 3, () => theirs.response()) });
		const engine = new RemoteEngine(
			byId({ fetch: () => after(HEDGE_MS + 10, () => ours.response()) }),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		const res = await engine.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {});
		expect(await res.text()).toBe('{"from":"own"}');
		expect(seen.connects).toBe(1);
		await after(HEDGE_MS * 4, () => {});
		expect(theirs.state.cancelled).toBe(true);
	});

	/** The coordinator's own 503 for a gather whose sibling calls failed twice (search-engine-do.ts fetch). */
	const gatherFailed = (message: string) =>
		new Response(message, { status: 503, headers: { "x-engine-error": "Error" } });

	test("a gather whose partition failed twice (the coordinator's fast 503) is answered by the neighbour's gather", async () => {
		setEngineHedgeForTests(60_000);
		const bodies: string[] = [];
		const theirs = trackedPage("neighbour");
		const { hedge, seen } = neighbour({
			fetch: async (req: Request) => {
				bodies.push(await req.text());
				return theirs.response();
			},
		});
		let own = 0;
		const engine = new RemoteEngine(
			byId({
				fetch: async () => {
					own++;
					return gatherFailed("Network connection lost.");
				},
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		const res = await engine.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}, "cards2");
		expect(await res.text()).toBe('{"from":"neighbour"}');
		expect(res.headers.get("x-load")).toBeNull();
		expect([own, seen.connects]).toEqual([1, 1]);
		const sent = JSON.parse(bodies[0] ?? "{}");
		expect(sent.call).toBe("cards2"); // the WHOLE gather, in one region
		expect("shards" in sent).toBe(false);
	});

	test("a stale-modulus refusal carried as a plain Error 503 is a StaleModulusError, never failed over (x39)", async () => {
		// 2026-09-26 23:17, the 10 → 11 partition switch: the object's instrumented wrapper had
		// already turned the refusal into the RPC marker string, the fetch transport sent it as a
		// plain "Error" 503, and it was failed over to the neighbour (which refused the same way)
		// instead of reaching the caller as the StaleModulusError that re-gathers at the loaded width.
		setEngineHedgeForTests(60_000);
		const { hedge, seen } = neighbour({ fetch: () => never() });
		const engine = new RemoteEngine(
			byId({
				fetch: async () =>
					gatherFailed("__STALE_MODULUS__:engine-enam-p3 serves a 11-partition store; the caller pinned against 10"),
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		const err = await engine
			.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}, "cards2")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(StaleModulusError);
		expect((err as Error).message).toBe("engine-enam-p3 serves a 11-partition store; the caller pinned against 10");
		expect(seen.connects).toBe(0);
	});

	test("a gather that fails in the neighbour too surfaces this region's error", async () => {
		setEngineHedgeForTests(60_000);
		const { hedge, seen } = neighbour({ fetch: async () => gatherFailed("enam's own failure") });
		const engine = new RemoteEngine(
			byId({ fetch: async () => gatherFailed("Network connection lost.") }),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		await expect(
			engine.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}, "cards2"),
		).rejects.toThrow("Network connection lost.");
		expect(seen.connects).toBe(1);
	});

	test("a fast page answers with no hedge", async () => {
		const ours = trackedPage("own");
		const { hedge, seen } = neighbour({ fetch: () => never() });
		const engine = new RemoteEngine(
			byId({ fetch: async () => ours.response() }),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		const res = await engine.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {});
		expect(await res.text()).toBe('{"from":"own"}');
		await after(HEDGE_MS * 2, () => {});
		expect(seen.connects).toBe(0);
	});
});

describe("an object that keeps going unanswered is asked second for a while (x45)", () => {
	// DeckGen 2026-09-29 20:42–21:49: 40 pages in a row waited out the 4s hedge delay behind
	// engine-wnam-p9, and enam answered every one within 100–450ms of being asked. The hedge
	// remembered nothing, so the slow object was asked first every single time.

	/** A home object whose next answers are scripted: "hang", or a delay in ms. */
	function home(script: ("hang" | number)[]) {
		const seen = { calls: 0 };
		const stub = byId({
			scryfallCardById: () => {
				seen.calls++;
				const next = script.shift() ?? 0;
				return next === "hang" ? never() : after(next, () => card("own"));
			},
		});
		return { stub, seen };
	}
	const ask = async (engine: RemoteEngine) => {
		const started = Date.now();
		const answer = (await engine.scryfallCardById("x", "https://x")) as { name: string };
		return { from: answer.name, took: Date.now() - started };
	};
	const engineOf = (stub: Stub, hedge: EngineHedge) => new RemoteEngine(stub, "wnam", "SJC", undefined, false, hedge);

	test("two unanswered calls in a row: the third asks the neighbour FIRST and never waits the hedge delay", async () => {
		setEngineHedgeForTests(60);
		const lines: string[] = [];
		const warn = console.warn;
		console.warn = (...args: unknown[]) => lines.push(args.join(" "));
		try {
			const own = home(["hang", "hang", "hang"]);
			const { hedge, seen } = neighbour({ scryfallCardById: async () => card("neighbour") });
			const engine = engineOf(own.stub, hedge);
			expect((await ask(engine)).took).toBeGreaterThanOrEqual(58);
			expect((await ask(engine)).took).toBeGreaterThanOrEqual(58);
			const third = await ask(engine);
			expect(third.from).toBe("neighbour");
			expect(third.took).toBeLessThan(40);
			// The home object was not asked at all the third time: no extra call while it is cooling.
			expect([own.seen.calls, seen.connects]).toEqual([2, 3]);
		} finally {
			console.warn = warn;
		}
		expect(
			lines.filter((l) =>
				/^\[wnam\] engine cooling p3: 2 calls in a row went 60ms unanswered \(last: scryfallCardById\); asking enam first for 120000ms$/.test(
					l,
				),
			),
		).toHaveLength(1);
	});

	test("one unanswered call is the eviction hang the hedge is for: nothing changes", async () => {
		setEngineHedgeForTests(60);
		const own = home(["hang", 0, "hang"]);
		const { hedge } = neighbour({ scryfallCardById: async () => card("neighbour") });
		const engine = engineOf(own.stub, hedge);
		expect((await ask(engine)).from).toBe("neighbour");
		expect((await ask(engine)).from).toBe("own"); // a prompt answer clears the count
		const third = await ask(engine);
		expect(third.took).toBeGreaterThanOrEqual(58); // asked first again, and waited for
		expect(own.seen.calls).toBe(3);
	});

	test("an answer that only just beat the hedge delay does not clear the count", async () => {
		// The stalled coordinators answered many pages in 3.2–3.5s between the hedged ones.
		setEngineHedgeForTests(60);
		const own = home(["hang", 45, "hang", "hang"]);
		const { hedge } = neighbour({ scryfallCardById: async () => card("neighbour") });
		const engine = engineOf(own.stub, hedge);
		await ask(engine);
		expect((await ask(engine)).from).toBe("own");
		await ask(engine);
		const fourth = await ask(engine);
		expect(fourth.from).toBe("neighbour");
		expect(fourth.took).toBeLessThan(40);
		expect(own.seen.calls).toBe(3);
	});

	test("a failover is a fast failure and never counts", async () => {
		setEngineHedgeForTests(60);
		const seenOwn = { calls: 0 };
		const failing = byId({
			scryfallCardById: async () => {
				seenOwn.calls++;
				throw new Error("Network connection lost.");
			},
		});
		const { hedge } = neighbour({ scryfallCardById: async () => card("neighbour") });
		const engine = engineOf(failing, hedge);
		for (let i = 0; i < 4; i++) expect((await ask(engine)).from).toBe("neighbour");
		expect(seenOwn.calls).toBe(4); // still asked first every time
	});

	test("while cooling, a silent neighbour falls back to the home object", async () => {
		setEngineHedgeForTests(40);
		const own = home(["hang", "hang", 0]);
		let neighbourAnswers = true;
		const { hedge } = neighbour({
			scryfallCardById: () => (neighbourAnswers ? Promise.resolve(card("neighbour")) : never()),
		});
		const engine = engineOf(own.stub, hedge);
		await ask(engine);
		await ask(engine);
		neighbourAnswers = false;
		const third = await ask(engine);
		expect(third.from).toBe("own");
		expect(third.took).toBeGreaterThanOrEqual(38); // the neighbour went first and was waited for
	});

	test("while cooling, a neighbour that fails is failed over to the home object at once", async () => {
		setEngineHedgeForTests(40);
		const own = home(["hang", "hang", 0]);
		let neighbourFails = false;
		const { hedge } = neighbour({
			scryfallCardById: async () => {
				if (neighbourFails) throw new Error("Durable Object is overloaded");
				return card("neighbour");
			},
		});
		const engine = engineOf(own.stub, hedge);
		await ask(engine);
		await ask(engine);
		neighbourFails = true;
		const third = await ask(engine);
		expect(third.from).toBe("own");
		expect(third.took).toBeLessThan(30);
	});

	test("when the period ends the object is asked first again, and ONE more silence re-arms it", async () => {
		setEngineHedgeForTests(40);
		setEngineCoolingForTests(80);
		const own = home(["hang", "hang", "hang", "hang"]);
		const { hedge } = neighbour({ scryfallCardById: async () => card("neighbour") });
		const engine = engineOf(own.stub, hedge);
		await ask(engine);
		await ask(engine); // cooling starts
		expect((await ask(engine)).took).toBeLessThan(30);
		await after(90, () => {});
		expect((await ask(engine)).took).toBeGreaterThanOrEqual(38); // the probe: asked first, silent
		expect((await ask(engine)).took).toBeLessThan(30); // cooling again after that one call
		expect(own.seen.calls).toBe(3);
	});

	test("cooling is per object: another partition of the region is still asked first", async () => {
		setEngineHedgeForTests(40);
		const own = home(["hang", "hang"]);
		const { hedge } = neighbour({ scryfallCardById: async () => card("neighbour") });
		const engine = engineOf(own.stub, hedge);
		await ask(engine);
		await ask(engine);
		const other = home([0]);
		const elsewhere = engineOf(other.stub, { ...hedge, partition: 4 });
		expect((await ask(elsewhere)).from).toBe("own");
	});
});

describe("a coordinator that sheds its gathers (x45)", () => {
	const page = (label: string) =>
		new Response(`{"from":"${label}"}`, { status: 200, headers: { "content-type": "application/json" } });
	const shedding = () =>
		new Response("engine-wnam-p3 is not coordinating gathers for another 29000ms", {
			status: 503,
			headers: { "x-engine-error": ENGINE_SHED_ERROR },
		});

	test("the refusal is failed over to the neighbour at once: one call each, no retry, no hedge delay", async () => {
		setEngineHedgeForTests(60_000);
		const ours: string[] = [];
		const theirs: string[] = [];
		const { hedge } = neighbour({
			fetch: async (req: Request) => {
				theirs.push(await req.text());
				return page("neighbour");
			},
		});
		const engine = new RemoteEngine(
			byId({
				fetch: async (req: Request) => {
					ours.push(await req.text());
					return shedding();
				},
			}),
			"wnam",
			"SJC",
			() => {
				throw new Error("a shed gather must not be retried on a fresh stub");
			},
			false,
			hedge,
		);
		const started = Date.now();
		const res = await engine.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}, "cards2");
		expect(await res.text()).toBe('{"from":"neighbour"}');
		expect(Date.now() - started).toBeLessThan(200);
		expect([ours.length, theirs.length]).toEqual([1, 1]);
		// Only the home coordinator is given leave to refuse; the neighbour's copy must answer.
		expect(JSON.parse(ours[0] ?? "{}").sheddable).toBe(true);
		expect("sheddable" in JSON.parse(theirs[0] ?? "{}")).toBe(false);
	});

	test("shed here and no answer from the neighbour: the home coordinator is asked again, with no leave to refuse", async () => {
		setEngineHedgeForTests(60_000);
		const ours: string[] = [];
		const { hedge } = neighbour({
			fetch: async () => new Response("enam is down", { status: 503, headers: { "x-engine-error": "Error" } }),
		});
		const engine = new RemoteEngine(
			byId({
				fetch: async (req: Request) => {
					const body = await req.text();
					ours.push(body);
					return JSON.parse(body).sheddable === true ? shedding() : page("own");
				},
			}),
			"wnam",
			"SJC",
			undefined,
			false,
			hedge,
		);
		const res = await engine.scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}, "cards2");
		expect(await res.text()).toBe('{"from":"own"}');
		expect(ours).toHaveLength(2);
		expect("sheddable" in JSON.parse(ours[1] ?? "{}")).toBe(false);
	});

	test("only a gather with a neighbour to go to may be refused", async () => {
		const bodies: string[] = [];
		const stub = byId({
			fetch: async (req: Request) => {
				bodies.push(await req.text());
				return page("own");
			},
		});
		const { hedge } = neighbour({ fetch: async () => page("neighbour") });
		// A pinned "cards" call is one object's own answer: nothing to shed.
		await new RemoteEngine(stub, "wnam", "SJC", undefined, false, hedge).scryfallSearchPage(
			{ limit: 10 } as never,
			"https://x",
			envelope,
			{},
		);
		// A gather with no hedge region has nowhere else to go.
		await new RemoteEngine(stub, "wnam").scryfallSearchPage(
			{ limit: 10 } as never,
			"https://x",
			envelope,
			{},
			"cards2",
		);
		expect(bodies.map((b) => "sheddable" in JSON.parse(b))).toEqual([false, false]);
	});
});

describe("hedgeRegionFor", () => {
	const aliasTo = (alias: Partial<Record<Hint, Hint>>): PlacementBlock => ({
		v: 1,
		alias: Object.fromEntries(Object.entries(alias).map(([h, to]) => [h, { to, since: "t" }])),
	});
	const placements: (PlacementBlock | undefined)[] = [
		undefined, // the seed: sam→enam, afr→weur, me→eeur
		{ v: 1 }, // every hint served
		aliasTo({ sam: "enam", afr: "weur", me: "eeur", oc: "apac-se", "apac-ne": "apac" }),
		aliasTo({ eeur: "weur", wnam: "enam" }),
	];

	test("never the region itself, never an aliased region, and always a real one", () => {
		for (const placement of placements) {
			for (const region of REGION_HINTS) {
				const h = hedgeRegionFor(region, placement);
				if (h === null) continue;
				expect(h).not.toBe(region);
				expect(REGION_HINTS).toContain(h);
				expect(effectiveRegion(h, placement)).toBe(h);
			}
		}
	});

	test("continent first", () => {
		const pairs: [Hint, Hint][] = [
			["enam", "wnam"],
			["wnam", "enam"],
			["weur", "eeur"],
			["eeur", "weur"],
			["apac", "apac-se"],
			["apac-se", "apac"],
			["apac-ne", "apac-se"],
			["oc", "apac-se"],
		];
		for (const [from, to] of pairs) expect(hedgeRegionFor(from, undefined)).toBe(to);
	});

	test("an unserved first choice falls through to the next served one, or to no hedge", () => {
		const block = aliasTo({ eeur: "weur", wnam: "enam" });
		expect(hedgeRegionFor("weur", block)).toBe("enam"); // eeur aliased → across the Channel to enam
		expect(hedgeRegionFor("enam", block)).toBe("weur"); // wnam aliased
		// A region whose every neighbour is aliased gets no hedge rather than a far or wrong one.
		const asia = aliasTo({ "apac-se": "apac-ne", apac: "apac-ne" });
		expect(hedgeRegionFor("oc", asia)).toBeNull();
		expect(hedgeRegionFor("apac-ne", asia)).toBeNull();
		expect(hedgeRegionFor("wnam", aliasTo({ enam: "wnam" }))).toBeNull();
	});
});
