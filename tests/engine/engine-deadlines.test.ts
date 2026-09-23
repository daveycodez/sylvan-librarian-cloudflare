// The deadlines and the single retry around every engine call (2026-09-23 incident: requests to one
// object that stopped answering hung for 30s+ for half an hour, until a deploy replaced it).
//
//   - RemoteEngine: a per-call deadline on both transports, and ONE retry of the platform's reset
//     errors or the loader's abandoned-load error — never of a timeout, a query error, a store
//     error or an overloaded object.
//   - PartitionedEngine: a gather coordinator that does not answer is replaced by the next
//     partition once, and a pinned owner that does not answer falls back to the gather.

import { afterEach, describe, expect, test } from "bun:test";
import { PartitionedEngine } from "../../src/engine/partitioned-engine";
import {
	EngineCallTimeoutError,
	isTransientEngineFailure,
	RemoteEngine,
	setEngineCallDeadlineForTests,
	withDeadline,
} from "../../src/engine/remote-engine";
import {
	EngineQueryError,
	EngineUnavailableError,
	StaleModulusError,
	type StoreManifest,
} from "../../src/engine/types";

type Stub = ConstructorParameters<typeof RemoteEngine>[0];
const envelope = { pretty: false, pageOffset: 0, noMatchDetails: "" };
const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const never = <T>() => new Promise<T>(() => {});

afterEach(() => setEngineCallDeadlineForTests(35_000));

describe("which failures get the one retry", () => {
	test("a reset, flagged or not, and the loader's abandoned load", () => {
		expect(isTransientEngineFailure(Object.assign(new Error("x"), { retryable: true }))).toBe(true);
		expect(isTransientEngineFailure(new Error("Durable Object storage is no longer accessible."))).toBe(true);
		expect(
			isTransientEngineFailure(new Error("Connection closed: this Durable Object instance is no longer active.")),
		).toBe(true);
		expect(
			isTransientEngineFailure(
				new Error("Internal error while starting up Durable Object storage caused object to be reset"),
			),
		).toBe(true);
		expect(
			isTransientEngineFailure(new Error("[engine-wnam-p3] store load stalled for 20000ms and was abandoned")),
		).toBe(true);
	});

	test("never a timeout, a query or store answer, an overload, or an unknown error", () => {
		expect(isTransientEngineFailure(new EngineCallTimeoutError("slow"))).toBe(false);
		expect(isTransientEngineFailure(new EngineQueryError("build_filter: bad regex"))).toBe(false);
		expect(isTransientEngineFailure(new EngineUnavailableError("no store"))).toBe(false);
		expect(isTransientEngineFailure(new StaleModulusError("other count"))).toBe(false);
		expect(isTransientEngineFailure(Object.assign(new Error("reset"), { retryable: true, overloaded: true }))).toBe(
			false,
		);
		expect(isTransientEngineFailure(new Error("Network connection lost."))).toBe(false);
		expect(isTransientEngineFailure(new Error("TypeError: x is undefined"))).toBe(false);
	});
});

describe("withDeadline", () => {
	test("answers when the call does, and times out when it never does", async () => {
		expect(await withDeadline(Promise.resolve(7), 50, "x")).toBe(7);
		await expect(withDeadline(never(), 20, "a call")).rejects.toBeInstanceOf(EngineCallTimeoutError);
	});
});

describe("RemoteEngine", () => {
	test("the page transport: a reset 503 gets ONE retry, then answers", async () => {
		let calls = 0;
		const stub = {
			fetch: async () => {
				calls++;
				return calls === 1
					? new Response("Durable Object storage is no longer accessible.", {
							status: 503,
							headers: { "x-engine-error": "Error" },
						})
					: ok();
			},
		} as unknown as Stub;
		const res = await new RemoteEngine(stub, "wnam").scryfallSearchPage(
			{ limit: 10 } as never,
			"https://x",
			envelope,
			{},
		);
		expect(res.status).toBe(200);
		expect(calls).toBe(2);
	});

	test("the page transport: a reset that persists is retried ONCE, not three times", async () => {
		let calls = 0;
		const stub = {
			fetch: async () => {
				calls++;
				return new Response("Durable Object storage is no longer accessible.", {
					status: 503,
					headers: { "x-engine-error": "Error" },
				});
			},
		} as unknown as Stub;
		await expect(
			new RemoteEngine(stub, "wnam").scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}),
		).rejects.toThrow(/no longer accessible/);
		expect(calls).toBe(2);
	});

	test("the page transport: an object that never answers times out, and is NOT asked again", async () => {
		setEngineCallDeadlineForTests(30);
		let calls = 0;
		const stub = {
			fetch: () => {
				calls++;
				return never<Response>();
			},
		} as unknown as Stub;
		await expect(
			new RemoteEngine(stub, "wnam").scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}),
		).rejects.toBeInstanceOf(EngineCallTimeoutError);
		expect(calls).toBe(1);
	});

	test("a bad query is answered once, as the query error it is", async () => {
		let calls = 0;
		const stub = {
			fetch: async () => {
				calls++;
				return new Response("build_filter: unclosed regex", { status: 503, headers: { "x-engine-error": "Error" } });
			},
		} as unknown as Stub;
		await expect(
			new RemoteEngine(stub, "wnam").scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}),
		).rejects.toBeInstanceOf(EngineQueryError);
		expect(calls).toBe(1);
	});

	test("the RPC transport: an unflagged reset gets one retry; a hang times out", async () => {
		let calls = 0;
		const flaky = {
			cardCount: async () => {
				calls++;
				if (calls === 1) throw new Error("Durable Object storage is no longer accessible.");
				return 7;
			},
		} as unknown as Stub;
		expect(await new RemoteEngine(flaky, "wnam").cardCount()).toBe(7);
		expect(calls).toBe(2);

		setEngineCallDeadlineForTests(30);
		const hung = { cardCount: () => never<number>() } as unknown as Stub;
		await expect(new RemoteEngine(hung, "wnam").cardCount()).rejects.toBeInstanceOf(EngineCallTimeoutError);
	});
});

describe("PartitionedEngine failover", () => {
	const N = 4;
	const manifest = {
		store_key: "card-store-v1-100.store",
		built_at: "100",
		partition_count: N,
		partitions: Array.from({ length: N }, (_, k) => ({
			store_key: `card-store-v1-100-p${k}.store`,
			store_bytes: 1,
			chunk_count: 1,
			card_count: 1,
			printing_count: 1,
		})),
	} as unknown as StoreManifest;
	const opts = { filterTreeJson: '{"node_type":"TrueNode"}', limit: 10 } as never;

	function engineWith(behaviour: (p: number) => Promise<unknown>) {
		const asked: number[] = [];
		const engine = new PartitionedEngine(
			(p) =>
				({
					gatherSearchAsObjects: () => {
						asked.push(p);
						return behaviour(p);
					},
				}) as unknown as RemoteEngine,
			manifest,
			async () => manifest,
			null,
		);
		return { engine, asked };
	}

	test("a coordinator that times out is replaced by the next partition, once", async () => {
		let first = -1;
		const { engine, asked } = engineWith(async (p) => {
			if (first < 0) {
				first = p;
				throw new EngineCallTimeoutError("coordinator did not answer");
			}
			return { totalCards: 1, cards: [] };
		});
		expect(await engine.searchCardsAsObjects(opts)).toEqual({ totalCards: 1, cards: [] });
		expect(asked).toEqual([first, (first + 1) % N]);
	});

	test("a query error is not failed over — every coordinator would say the same", async () => {
		const { engine, asked } = engineWith(async () => {
			throw new EngineQueryError("build_filter: bad regex");
		});
		await expect(engine.searchCardsAsObjects(opts)).rejects.toBeInstanceOf(EngineQueryError);
		expect(asked.length).toBe(1);
	});
});
