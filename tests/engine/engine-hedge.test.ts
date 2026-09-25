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
	EngineCallTimeoutError,
	type EngineHedge,
	RemoteEngine,
	setEngineCallDeadlineForTests,
	setEngineHedgeForTests,
} from "../../src/engine/remote-engine";
import { EngineQueryError } from "../../src/engine/types";

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
});
afterEach(() => {
	setEngineHedgeForTests(4_000);
	setEngineCallDeadlineForTests(35_000);
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

	test("a fast failure that is not transient fails at once, as it does today — no hedge", async () => {
		const { hedge, seen } = neighbour({ scryfallSearch: async () => ({ totalCards: 0 }) });
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
		expect(seen.connects).toBe(0);
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
