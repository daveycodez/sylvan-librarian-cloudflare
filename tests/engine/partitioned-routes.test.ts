// The per-route RPC-count table (plan B5), pinned.
//
// Partitioned serving's cost model is the NUMBER of partition objects each route
// touches, and nothing at runtime asserts it: a fan-out sneaking into a route
// that should make one RPC would be invisible in results and only show up as N×
// duration on the meters. So the table in partitioned-engine.ts's header is a
// contract, and this file is where it is enforced — a fake engine per partition
// counts every call.

import { afterEach, describe, expect, test } from "bun:test";
import { edgeCacheUrl } from "../../src/engine/edge-cache";
import { gatherPartitionOf, partitionOfOracleId } from "../../src/engine/partition";
import {
	firstDecided,
	mergeAutocomplete,
	PartitionedEngine,
	raceFuzzyCandidates,
	resetCatalogMemoForTests,
	sumCounts,
} from "../../src/engine/partitioned-engine";
import { EngineCallTimeoutError, type RemoteEngine } from "../../src/engine/remote-engine";
import {
	buildRoutingFilter,
	externalIdKey,
	illustrationIdKey,
	nameKey,
	ROUTING_FEATURE_NAME_KEYS,
	RoutingFilter,
	scryfallIdKey,
	setNumberKey,
} from "../../src/engine/routing-filter";
import { type CollectionBatch, StaleModulusError, type StoreManifest } from "../../src/engine/types";

const N = 4;

const utf8 = new TextDecoder();
const cardBytes = (card: Record<string, unknown> | null): Uint8Array | null =>
	card === null ? null : new TextEncoder().encode(JSON.stringify(card));
const cardOf = (bytes: Uint8Array | null): unknown => (bytes === null ? null : JSON.parse(utf8.decode(bytes)));

/** Every manifest is its own store generation: the engine's per-generation caches (extras sets,
 * catalog counts) are module-scoped, so a shared key would let one test's fan-out answer for
 * the next. The partition keys and built_at stay fixed — nothing here parses the top-level key. */
let generation = 0;

function manifestOf(n: number): StoreManifest {
	generation += 1;
	return {
		store_key: `card-store-v1-100-g${generation}.store`,
		built_at: "100",
		card_count: 40,
		printing_count: 100,
		upstream_commit: "abc",
		format_version: 1,
		store_bytes: 1000,
		chunk_count: n,
		partition_count: n,
		partition_hash: "fnv1a64/oracle_id/v1",
		partitions: Array.from({ length: n }, (_, k) => ({
			store_key: `card-store-v1-100-p${k}.store`,
			store_bytes: 1000 / n,
			chunk_count: 1,
			card_count: 10,
			printing_count: 25,
		})),
	};
}

/** One fake partition client: counts calls, answers what the test tells it to. */
function fakeRemote(partition: number, calls: string[], answers: Record<string, unknown> = {}) {
	const count = (name: string) => calls.push(`${name}:${partition}`);
	const val = <T>(name: string, fallback: T): T => (name in answers ? (answers[name] as T) : fallback);
	return {
		gatherSearchAsObjects: async () => {
			count("gatherSearchAsObjects");
			return { totalCards: 1, cards: [] };
		},
		gatherSearchAsJson: async () => {
			count("gatherSearchAsJson");
			return { totalCards: 1, cardsBytes: new Uint8Array(), rowCount: 0 };
		},
		gatherScryfallSearch: async () => {
			count("gatherScryfallSearch");
			return { totalCards: 1, cardsBytes: new Uint8Array(), rowCount: 0 };
		},
		searchCardsAsObjects: async (_opts: unknown, pinned?: number) => {
			count(`searchCardsAsObjects[${pinned ?? "-"}]`);
			if (answers.staleModulus) throw new StaleModulusError("cut at another count");
			return { totalCards: val("totalCards", 1), cards: [] };
		},
		searchCardsAsJson: async (_opts: unknown, _shape: unknown, pinned?: number) => {
			count(`searchCardsAsJson[${pinned ?? "-"}]`);
			return { totalCards: val("totalCards", 1), cardsBytes: new Uint8Array(), rowCount: 0 };
		},
		scryfallSearch: async (_opts: unknown, _base: unknown, pinned?: number) => {
			count(`scryfallSearch[${pinned ?? "-"}]`);
			return { totalCards: val("totalCards", 1), cardsBytes: new Uint8Array(), rowCount: 0 };
		},
		scryfallSearchPage: async (_o: unknown, _b: unknown, _e: unknown, _c: unknown, call = "cards", pinned?: number) => {
			count(`scryfallSearchPage[${call}${pinned === undefined ? "" : `,${pinned}`}]`);
			if (answers.staleModulus) throw new StaleModulusError("cut at another count");
			count("scryfallSearchPage");
			return new Response("{}");
		},
		cardTypeCounts: async () => {
			count("cardTypeCounts");
			return val("types", { creature: 1 });
		},
		cardKeywordCounts: async () => {
			count("cardKeywordCounts");
			return { flying: 2 };
		},
		setsWithExtras: async () => {
			count("setsWithExtras");
			return val("setsWithExtras", ["lea"]);
		},
		cardCount: async () => {
			count("cardCount");
			return 10;
		},
		randomCardsAsObjects: async () => {
			count("randomCardsAsObjects");
			return [];
		},
		randomCardsAsJson: async () => {
			count("randomCardsAsJson");
			return { totalCards: 0, cardsBytes: new Uint8Array(), rowCount: 0 };
		},
		scryfallCardById: async () => {
			count("scryfallCardById");
			return val<Record<string, unknown> | null>("cardById", null);
		},
		scryfallCardByExternalId: async () => {
			count("scryfallCardByExternalId");
			return null;
		},
		scryfallFirstOfEach: async (filters: string[]) => {
			count("scryfallFirstOfEach");
			return filters.map(() => val<Record<string, unknown> | null>("firstOfEach", null));
		},
		scryfallFuzzyName: async () => {
			count("scryfallFuzzyName");
			return val("fuzzy", { status: "miss", card: null });
		},
		fuzzyCandidates: async () => {
			count("fuzzyCandidates");
			return val("candidates", []);
		},
		scryfallExactName: async () => {
			count("scryfallExactName");
			return val<Record<string, unknown> | null>("exact", null);
		},
		scryfallExactNameProbe: async () => {
			count("scryfallExactNameProbe");
			// The same answers the rank and the card give, in one reply; `present` overrides whether
			// this partition holds the name at all (defaults to "it answered").
			const rank = val<number[] | null>("exactRank", "exact" in answers ? [1, 2, 0] : null);
			return {
				rank,
				present: val<boolean>("present", rank !== null),
				card: rank === null ? null : val<Record<string, unknown> | null>("exact", null),
			};
		},
		scryfallExactNameRank: async () => {
			count("scryfallExactNameRank");
			// A partition that can answer ranks; `exactRank` overrides the tier/score so a test
			// can make a LATER partition win.
			return val<number[] | null>("exactRank", "exact" in answers ? [1, 2, 0] : null);
		},
		scryfallAutocomplete: async () => {
			count("scryfallAutocomplete");
			return val<string[]>("names", []);
		},
		scryfallAutocompleteNames: async (prefix: string, limit: number) => {
			count("scryfallAutocompleteNames");
			// `namesFails` models an object that cannot answer from names: on the build before n8
			// (no such method) or with the blob gone from KV.
			if (answers.namesFails) throw new Error("no such method: scryfallAutocompleteNames");
			return val<string[]>("wholeCorpus", [`${prefix}:${limit}`]);
		},
		scryfallNamesContaining: async () => {
			count("scryfallNamesContaining");
			return val<Record<string, unknown>[]>("containing", []);
		},
		scryfallCollectionBatch: async (batch: CollectionBatch) => {
			// The sub-batch's shape rides in the call record: which keys, and whether the trees
			// and names came along.
			const keys = batch.keys.map((k) => String(k.id)).join(",");
			count(`scryfallCollectionBatch[${keys}|t${batch.trees.length}|n${batch.names.length}]`);
			// `byKey` maps a key's id to this partition's card; `firstOfEach` answers every tree;
			// `collectionRanks` ranks each name and `collectionCard` is its local winner.
			const held = val<Record<string, Record<string, unknown>>>("byKey", {});
			const ranks = val<(number[] | null)[]>("collectionRanks", []);
			const tree = val<Record<string, unknown> | null>("firstOfEach", null);
			// `byTree` answers per tree string, for a test that needs the English tree to miss.
			const byTree = val<Record<string, Record<string, unknown>> | null>("byTree", null);
			const card = val<Record<string, unknown> | null>("collectionCard", null);
			// `rankByName` ranks a name by its folded text — for the routed tests, where a partition is
			// sent only some of the names, so position is not identity; `presentNames` are the names
			// this partition holds even where it ranks none.
			const byName = val<Record<string, number[] | null> | null>("rankByName", null);
			const present = val<string[]>("presentNames", []);
			const nameRanks = batch.names.map((n, i) => (byName ? (byName[n.folded] ?? null) : (ranks[i] ?? null)));
			return {
				keys: batch.keys.map((k) => cardBytes(held[String(k.id)] ?? null)),
				trees: batch.trees.map((t) => cardBytes(byTree ? (byTree[t] ?? null) : tree)),
				names: nameRanks.map((rank, i) =>
					rank === null ? null : cardBytes(byName ? { p: partition, name: batch.names[i]?.folded } : card),
				),
				nameRanks,
				...(batch.presence
					? { namePresent: batch.names.map((n, i) => nameRanks[i] !== null || present.includes(n.folded)) }
					: {}),
			};
		},
	} as unknown as RemoteEngine;
}

function build(
	perPartition: Record<number, Record<string, unknown>> = {},
	reread?: () => Promise<StoreManifest | null>,
	routing?: RoutingFilter | null,
) {
	const calls: string[] = [];
	const engine = new PartitionedEngine(
		(p) => fakeRemote(p, calls, perPartition[p] ?? {}),
		manifestOf(N),
		reread ?? (async () => manifestOf(N)),
		routing ?? null,
	);
	const of = (name: string) => calls.filter((c) => c.startsWith(`${name}:`));
	return { engine, calls, of };
}

const OPTS = {
	filterTreeJson: '{"t":"goblin"}',
	unique: "printing",
	prefer: "default",
	orderby: "name",
	direction: "asc",
	limit: 10,
	offset: 0,
	fields: ["name"],
};

describe("search and listing make ONE isolate RPC, to the gather", () => {
	test("searchCardsAsObjects", async () => {
		const { engine, of } = build();
		await engine.searchCardsAsObjects(OPTS);
		expect(of("gatherSearchAsObjects").length).toBe(1);
	});

	test("searchCardsAsJson", async () => {
		const { engine, of } = build();
		await engine.searchCardsAsJson(OPTS, "rows");
		expect(of("gatherSearchAsJson").length).toBe(1);
	});

	test("scryfallSearch and the whole-page transport", async () => {
		const { engine, of, calls } = build();
		await engine.scryfallSearch(OPTS, "https://x");
		await engine.scryfallSearchPage(OPTS, "https://x", { pretty: false, pageOffset: 0, noMatchDetails: "" }, {});
		expect(of("gatherScryfallSearch").length).toBe(1);
		expect(of("scryfallSearchPage").length).toBe(1);
		// Two RPCs; the third entry is the fake recording the page call's kind.
		expect(calls.filter((c) => !c.startsWith("scryfallSearchPage[")).length).toBe(2);
	});

	describe("a query pinned to one oracle id", () => {
		const oracleId = "aa686c34-cf28-4d4a-bcef-5a34cccdbf87";
		const pinnedOpts = {
			...OPTS,
			filterTreeJson: JSON.stringify({
				node_type: "CardBinaryOperatorNode",
				kwargs: {
					lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "oracle_id" } },
					op: ":",
					rhs: { node_type: "StringValueNode", kwargs: { value: oracleId } },
				},
			}),
		};
		const owner = partitionOfOracleId(oracleId, N);

		test("goes to the owning partition's own store, once, carrying this isolate's N", async () => {
			const { engine, calls, of } = build();
			await engine.scryfallSearchPage(
				pinnedOpts,
				"https://x",
				{ pretty: false, pageOffset: 0, noMatchDetails: "" },
				{},
			);
			await engine.scryfallSearch(pinnedOpts, "https://x");
			await engine.searchCardsAsObjects(pinnedOpts);
			await engine.searchCardsAsJson(pinnedOpts, "rows");
			expect(calls).toContain(`scryfallSearchPage[cards,${N}]:${owner}`);
			expect(calls).toContain(`scryfallSearch[${N}]:${owner}`);
			expect(calls).toContain(`searchCardsAsObjects[${N}]:${owner}`);
			expect(calls).toContain(`searchCardsAsJson[${N}]:${owner}`);
			for (const gather of ["gatherScryfallSearch", "gatherSearchAsObjects", "gatherSearchAsJson"]) {
				expect(of(gather)).toEqual([]);
			}
			expect(calls.filter((c) => c.includes("[cards2"))).toEqual([]);
			expect(engine.pinnedAnswer).toBe(true);
		});

		test("an unpinned query still gathers", async () => {
			const { engine, calls } = build();
			await engine.scryfallSearchPage(OPTS, "https://x", { pretty: false, pageOffset: 0, noMatchDetails: "" }, {});
			expect(calls.some((c) => c.startsWith("scryfallSearchPage[cards2]"))).toBe(true);
			expect(calls.some((c) => c.startsWith("scryfallSearchPage[cards,"))).toBe(false);
			expect(engine.pinnedAnswer).toBe(false);
		});

		test("a partition cut at another count refuses, and the gather answers instead", async () => {
			const { engine, calls, of } = build({ [owner]: { staleModulus: true } });
			await engine.searchCardsAsObjects(pinnedOpts);
			expect(calls).toContain(`searchCardsAsObjects[${N}]:${owner}`);
			expect(of("gatherSearchAsObjects").length).toBe(1);
			// Asked of the owner, answered by the gather: not a pinned answer.
			expect(engine.pinnedAnswer).toBe(false);
			await engine.scryfallSearchPage(
				pinnedOpts,
				"https://x",
				{ pretty: false, pageOffset: 0, noMatchDetails: "" },
				{},
			);
			expect(calls.some((c) => c.startsWith("scryfallSearchPage[cards2]"))).toBe(true);
		});
	});

	test("the same query always picks the same gather partition", async () => {
		const a = build();
		const b = build();
		await a.engine.searchCardsAsObjects(OPTS);
		await b.engine.searchCardsAsObjects(OPTS);
		expect(a.calls).toEqual(b.calls);
	});
});

describe("point routes", () => {
	test("scryfall_id-keyed: N parallel, first non-null", async () => {
		const { engine, of } = build({ 2: { cardById: { name: "Hit" } } });
		const card = await engine.scryfallCardById("some-uuid", "https://x");
		expect(card).toEqual({ name: "Hit" });
		expect(of("scryfallCardById").length).toBe(N);
	});

	test("external ids: N", async () => {
		const { engine, of } = build();
		await engine.scryfallCardByExternalId("multiverse", 42, "https://x");
		expect(of("scryfallCardByExternalId").length).toBe(N);
	});

	test("random: ONE RPC, weighted by card_count", async () => {
		const { engine, of } = build();
		await engine.randomCardsAsObjects(1, ["name"]);
		expect(of("randomCardsAsObjects").length).toBe(1);
	});
});

/** A promise the test settles by hand — a partition that has not answered YET. */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Whether `promise` has settled once the microtasks queued so far have run. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	const mark = () => {
		done = true;
	};
	promise.then(mark, mark);
	for (let i = 0; i < 10; i++) await Promise.resolve();
	return done;
}

/** A partition that never answers: the object the 35s deadline was waiting on. */
const NEVER = new Promise<never>(() => {});

describe("a point lookup's fan-out answers when its answer is DECIDED, not when the slowest partition does", () => {
	// DeckGen, 2026-09-25: `/cards/plst/MMA-154` fanned out to ten weur partitions because its fresh
	// isolate's routing filter arrived 144ms after ROUTING_WAIT_MS. The owner answered in 258ms; the
	// request 500'd at +35.000s on a partition that never answered. `/cards/m13/54`, 20:39, likewise.

	describe("firstDecided", () => {
		test("lowest: a later partition's answer waits on the earlier ones, then wins over the ones after it", async () => {
			const p0 = deferred<string | null>();
			const decided = firstDecided([p0.promise, Promise.resolve("p1"), NEVER], "lowest");
			expect(await settledYet(decided)).toBe(false);
			p0.resolve(null);
			expect(await decided).toBe("p1");
		});

		test("lowest: the lower of two answers wins, whichever arrives first", async () => {
			const p0 = deferred<string | null>();
			const decided = firstDecided([p0.promise, Promise.resolve("p1")], "lowest");
			p0.resolve("p0");
			expect(await decided).toBe("p0");
		});

		test("lowest: a failure BEFORE the answer fails the lookup; one after it does not", async () => {
			const boom = new EngineCallTimeoutError("engine RPC did not answer within 35000ms");
			await expect(firstDecided([Promise.reject(boom), Promise.resolve("p1")], "lowest")).rejects.toBe(boom);
			expect(await firstDecided([Promise.resolve(null), Promise.resolve("p1"), Promise.reject(boom)], "lowest")).toBe(
				"p1",
			);
		});

		test("sole: the first answer wins while other partitions are still out", async () => {
			expect(await firstDecided([NEVER, NEVER, Promise.resolve("owner"), NEVER], "sole")).toBe("owner");
		});

		test("sole: a failure elsewhere does not fail an answer that arrives later", async () => {
			const owner = deferred<string | null>();
			const decided = firstDecided([Promise.reject(new Error("Network connection lost.")), owner.promise], "sole");
			expect(await settledYet(decided)).toBe(false);
			owner.resolve("owner");
			expect(await decided).toBe("owner");
		});

		test("a miss is reported only when EVERY partition answered null; a failure then is the error, not a 404", async () => {
			expect(await firstDecided([Promise.resolve(null), Promise.resolve(null)], "sole")).toBeNull();
			expect(await firstDecided([Promise.resolve(null), Promise.resolve(null)], "lowest")).toBeNull();
			const boom = new Error("Network connection lost.");
			await expect(firstDecided([Promise.resolve(null), Promise.reject(boom)], "sole")).rejects.toBe(boom);
			expect(await settledYet(firstDecided([Promise.resolve(null), NEVER], "sole"))).toBe(false);
			expect(await firstDecided([], "sole")).toBeNull();
		});
	});

	/** A partitioned engine with some partitions' methods replaced (a hang, a failure). */
	function buildWith(
		perPartition: Record<number, Record<string, unknown>>,
		overrides: Record<number, Record<string, () => Promise<unknown>>>,
		routing: RoutingFilter | null = null,
	) {
		return new PartitionedEngine(
			(p) => ({ ...fakeRemote(p, [], perPartition[p] ?? {}), ...(overrides[p] ?? {}) }) as unknown as RemoteEngine,
			manifestOf(N),
			async () => manifestOf(N),
			routing,
		);
	}

	const k = setNumberKey("plst", "MMA-154");
	const both = [{ id: "admirers" }, { id: "admirers" }];

	test("/cards/:set/:number with no filter: the owner's card, while another partition never answers", async () => {
		const engine = buildWith({ 2: { firstOfEach: { id: "admirers" } } }, { 0: { scryfallFirstOfEach: () => NEVER } });
		expect(await engine.scryfallFirstOfEach(["en", "any"], "https://x", k)).toEqual(both);
	});

	test("/cards/:set/:number with no filter: a partition that fails does not fail the owner's answer", async () => {
		const engine = buildWith(
			{ 3: { firstOfEach: { id: "admirers" } } },
			{ 1: { scryfallFirstOfEach: () => Promise.reject(new EngineCallTimeoutError("did not answer")) } },
		);
		expect(await engine.scryfallFirstOfEach(["en", "any"], "https://x", k)).toEqual(both);
	});

	test("/cards/:set/:number: a hinted miss's fan-out answers the same way", async () => {
		const engine = buildWith(
			{ 3: { firstOfEach: { id: "admirers" } } },
			{ 2: { scryfallFirstOfEach: () => NEVER } },
			filterOf([{ key: k, partition: 1 }]),
		);
		expect(await engine.scryfallFirstOfEach(["en", "any"], "https://x", k)).toEqual(both);
	});

	test("/cards/:set/:number: with no card anywhere and a partition failed, the failure is the answer, never a 404", async () => {
		const boom = new EngineCallTimeoutError("did not answer");
		const engine = buildWith({}, { 1: { scryfallFirstOfEach: () => Promise.reject(boom) } });
		await expect(engine.scryfallFirstOfEach(["en", "any"], "https://x", k)).rejects.toBe(boom);
	});

	test("a bare id keeps the LOWEST answer: a partition after it never answering does not matter", async () => {
		const engine = buildWith({ 1: { cardById: { name: "Hit" } } }, { 3: { scryfallCardById: () => NEVER } });
		expect(await engine.scryfallCardById("some-uuid", "https://x")).toEqual({ name: "Hit" });
	});

	test("a bare id still waits on a partition BEFORE its answer, which could hold the lower copy", async () => {
		const p0 = deferred<Record<string, unknown> | null>();
		const engine = buildWith({ 2: { cardById: { name: "Upper" } } }, { 0: { scryfallCardById: () => p0.promise } });
		const answer = engine.scryfallCardById("some-uuid", "https://x");
		expect(await settledYet(answer)).toBe(false);
		p0.resolve({ name: "Lower" });
		expect(await answer).toEqual({ name: "Lower" });
	});
});

/** A routing filter placing the given ids, built at the fake manifest's identity. */
function filterOf(entries: { key: string; partition: number }[], features = 0): RoutingFilter {
	const bytes = buildRoutingFilter(
		entries,
		{
			builtAt: "100",
			partitionCount: N,
			partitionHash: "fnv1a64/oracle_id/v1",
		},
		features,
	);
	const parsed = RoutingFilter.parse(bytes, {
		builtAt: "100",
		partitionCount: N,
		partitionHash: "fnv1a64/oracle_id/v1",
	});
	if ("reason" in parsed) throw new Error(parsed.reason);
	return parsed.filter;
}

describe("a fresh isolate waits briefly for the colo's filter (backlog n1)", () => {
	const CARD = "0001c639-8bd0-426f-89cb-4ca61f3cc054";
	function waiting(answer: RoutingFilter | null, perPartition: Record<number, Record<string, unknown>> = {}) {
		const calls: string[] = [];
		let asked = 0;
		const engine = new PartitionedEngine(
			(p) => fakeRemote(p, calls, perPartition[p] ?? {}),
			manifestOf(N),
			async () => manifestOf(N),
			null,
			async () => {
				asked += 1;
				return answer;
			},
		);
		return { engine, calls, asked: () => asked };
	}

	test("the first routed lookup takes the colo's filter and asks ONE partition", async () => {
		const routing = filterOf([{ key: scryfallIdKey(CARD), partition: 2 }]);
		const { engine, calls, asked } = waiting(routing, { 2: { cardById: { name: "Hit" } } });
		expect(await engine.scryfallCardById(CARD, "https://x")).toEqual({ name: "Hit" });
		expect(calls).toEqual(["scryfallCardById:2"]);
		// Once per request: a second routed lookup reuses what the first one got.
		await engine.scryfallCardById(CARD, "https://x");
		expect(asked()).toBe(1);
	});

	test("an empty wait (the colo had no copy in time) fans out exactly as before, and is not retried", async () => {
		const { engine, calls, asked } = waiting(null);
		await engine.scryfallCardById(CARD, "https://x");
		expect(calls.length).toBe(N);
		await engine.scryfallCardById(CARD, "https://x");
		expect(asked()).toBe(1);
	});

	test("a route the filter cannot help never waits", async () => {
		const { engine, asked } = waiting(filterOf([]));
		await engine.searchCardsAsJson(OPTS, "rows");
		expect(asked()).toBe(0);
	});
});

describe("the routing filter collapses the bare-id fan-out", () => {
	const CARD = "0001c639-8bd0-426f-89cb-4ca61f3cc054";
	const ART = "7eb65d52-deea-4693-9111-9f95a3b0c915";

	test("a known scryfall_id costs ONE RPC, to the partition the filter names", async () => {
		const routing = filterOf([{ key: scryfallIdKey(CARD), partition: 2 }]);
		const { engine, of, calls } = build({ 2: { cardById: { name: "Hit" } } }, undefined, routing);
		expect(await engine.scryfallCardById(CARD, "https://x")).toEqual({ name: "Hit" });
		expect(of("scryfallCardById")).toEqual(["scryfallCardById:2"]);
		expect(calls.length).toBe(1);
	});

	test("external ids collapse the same way", async () => {
		const routing = filterOf([{ key: externalIdKey("multiverse", 634752), partition: 1 }]);
		const { engine, of } = build({ 1: {} }, undefined, routing);
		// The partition answers null here, so this is the WORST case — see the fallback test below
		// for what that costs.
		await engine.scryfallCardByExternalId("multiverse", 634752, "https://x");
		expect(of("scryfallCardByExternalId")[0]).toBe("scryfallCardByExternalId:1");
	});

	test("a hint that comes back empty falls back to the REST — never more than the fan-out", async () => {
		// The filter names partition 0; the card is actually in 3. This is what an id
		// the filter never saw looks like from the inside, and the answer must still
		// be the fan-out's answer.
		const routing = filterOf([{ key: scryfallIdKey(CARD), partition: 0 }]);
		const { engine, of } = build({ 3: { cardById: { name: "Elsewhere" } } }, undefined, routing);
		expect(await engine.scryfallCardById(CARD, "https://x")).toEqual({ name: "Elsewhere" });
		const asked = of("scryfallCardById");
		expect(asked.length).toBe(N);
		expect(asked[0]).toBe("scryfallCardById:0");
		expect(new Set(asked).size).toBe(N);
	});

	test("an unknown id whose nibble names no partition skips straight to the fan-out", async () => {
		// 4 partitions, 16 nibble values: most garbage lands outside the range and is
		// recognised as garbage without spending an RPC on it. Whichever way this
		// particular id falls, the total must not exceed N.
		const routing = filterOf([{ key: scryfallIdKey(ART), partition: 1 }]);
		const { engine, of } = build({}, undefined, routing);
		expect(await engine.scryfallCardById(CARD, "https://x")).toBeNull();
		expect(of("scryfallCardById").length).toBeLessThanOrEqual(N);
	});

	test("with no filter at all the routes fan out exactly as before", async () => {
		const { engine, of } = build({ 2: { cardById: { name: "Hit" } } }, undefined, null);
		expect(await engine.scryfallCardById(CARD, "https://x")).toEqual({ name: "Hit" });
		expect(of("scryfallCardById").length).toBe(N);
	});
});

describe("the key-shaped collection identifiers are ONE batch per partition asked", () => {
	// oracle_id, illustration_id, mtgo_id and multiverse_id used to be resolved one RPC per
	// identifier — 75 x N Durable Object requests for a batch of misses. They ride
	// scryfallCollectionBatch now, which the per-kind batch methods were folded into.
	const ext = (id: number) => ({ kind: "external" as const, namespace: "multiverse", id });
	const keysOf = (keys: CollectionBatch["keys"]): CollectionBatch => ({ keys, trees: [], names: [] });
	const idsOf = (got: { keys: (Uint8Array | null)[] }) =>
		got.keys.map((b) => (cardOf(b) as { id: string | number } | null)?.id ?? null);

	test("hinted identifiers go to their partitions, one call each, however many there are", async () => {
		const ids = Array.from({ length: 75 }, (_, i) => 1000 + i);
		const routing = filterOf(ids.map((id, i) => ({ key: externalIdKey("multiverse", id), partition: i % 2 })));
		const held = (parity: number) =>
			Object.fromEntries(ids.filter((_, i) => i % 2 === parity).map((id) => [String(id), { id }]));
		const { engine, calls } = build({ 0: { byKey: held(0) }, 1: { byKey: held(1) } }, undefined, routing);
		expect(idsOf(await engine.scryfallCollectionBatch(keysOf(ids.map(ext)), "https://x"))).toEqual(ids);
		expect(calls.map((c) => c.slice(c.lastIndexOf(":"))).sort()).toEqual([":0", ":1"]);
	});

	test("an illustration id the filter knows is ONE call", async () => {
		const art = "7eb65d52-deea-4693-9111-9f95a3b0c915";
		const routing = filterOf([{ key: illustrationIdKey(art), partition: 3 }]);
		const { engine, calls } = build({ 3: { byKey: { [art]: { id: "art" } } } }, undefined, routing);
		const got = await engine.scryfallCollectionBatch(keysOf([{ kind: "illustration_id", id: art }]), "https://x");
		expect(idsOf(got)).toEqual(["art"]);
		expect(calls).toEqual([`scryfallCollectionBatch[${art}|t0|n0]:3`]);
	});

	test("unhinted identifiers cost the fan-out once, never per identifier", async () => {
		const ids = Array.from({ length: 75 }, (_, i) => 5000 + i);
		const { engine, calls } = build({}, undefined, filterOf([]));
		const got = await engine.scryfallCollectionBatch(keysOf(ids.map(ext)), "https://x");
		expect(got.keys.every((c) => c === null)).toBe(true);
		expect(calls.length).toBe(N);
	});

	test("without a routing filter, an unhinted id still reaches a partition round 1 asked for oracle ids", async () => {
		// The first request of every cold isolate has no filter yet. Partition p is asked for an
		// oracle id it owns; the multiverse id ALSO lives in p. The unhinted id must ride along to
		// every partition — including p — or it is reported not_found while the card exists.
		const oracleId = "aa686c34-cf28-4d4a-bcef-5a34cccdb001";
		const p = partitionOfOracleId(oracleId, N);
		const { engine, calls } = build(
			{ [p]: { byKey: { [oracleId]: { id: oracleId }, "9999": { id: 9999 } } } },
			undefined,
			null,
		);
		const got = await engine.scryfallCollectionBatch(
			keysOf([{ kind: "oracle_id", id: oracleId }, ext(9999)]),
			"https://x",
		);
		expect(idsOf(got)).toEqual([oracleId, 9999]);
		// One round: every partition asked once, none twice.
		expect(calls.length).toBe(N);
		expect(new Set(calls).size).toBe(N);
	});

	test("oracle ids group by their arithmetic owner: one call per owner", async () => {
		const oracle = (i: number) => `aa686c34-cf28-4d4a-bcef-5a34cccdb${String(i).padStart(3, "0")}`;
		const ids = Array.from({ length: 20 }, (_, i) => oracle(i));
		const owners = new Set(ids.map((id) => partitionOfOracleId(id, N)));
		const perPartition: Record<number, Record<string, unknown>> = {};
		for (const id of ids) {
			const p = partitionOfOracleId(id, N);
			perPartition[p] ??= { byKey: {} };
			(perPartition[p].byKey as Record<string, unknown>)[id] = { id };
		}
		const { engine, calls } = build(perPartition, undefined, filterOf([]));
		const got = await engine.scryfallCollectionBatch(
			keysOf(ids.map((id) => ({ kind: "oracle_id" as const, id }))),
			"https://x",
		);
		expect(idsOf(got)).toEqual(ids);
		expect(calls.length).toBe(owners.size);
	});
});

describe("a collection batch is ONE round of at most N calls", () => {
	// The route's only engine call for POST /cards/collection. Before it, a batch of names cost N
	// rank calls plus up to N materialize calls, and its {set, collector_number} identifiers and
	// ids each cost their own fan-out on top.
	const names = (...folded: string[]) => folded.map((f) => ({ folded: f, setCode: "" }));
	const sid = (id: string) => ({ kind: "scryfall_id" as const, id });
	const answer = (a: { keys: (Uint8Array | null)[]; trees: (Uint8Array | null)[]; names: (Uint8Array | null)[] }) => ({
		keys: a.keys.map(cardOf),
		trees: a.trees.map(cardOf),
		names: a.names.map(cardOf),
	});

	test("every kind at once: N calls, each partition asked once, every key riding along", async () => {
		const routing = filterOf([
			{ key: scryfallIdKey("a"), partition: 1 },
			{ key: scryfallIdKey("b"), partition: 1 },
		]);
		const { engine, calls } = build(
			{
				1: { byKey: { a: { id: "a" }, b: { id: "b" } }, collectionRanks: [[1, 1, 0], null], collectionCard: { p: 1 } },
				2: {
					collectionRanks: [
						[1, 2, 0],
						[1, 2, 0],
					],
					collectionCard: { p: 2 },
					firstOfEach: { tree: 2 },
				},
				3: { firstOfEach: { tree: 3 } },
			},
			undefined,
			routing,
		);
		const got = await engine.scryfallCollectionBatch(
			{ keys: [sid("a"), sid("b")], trees: ["en", "any"], names: names("x", "y") },
			"https://x",
		);
		// Names and trees call every partition, so the ids ride along to all of them: no partition
		// is called twice, and no hint has to be trusted.
		expect(calls.sort()).toEqual([0, 1, 2, 3].map((p) => `scryfallCollectionBatch[a,b|t2|n2]:${p}`));
		expect(answer(got)).toEqual({
			keys: [{ id: "a" }, { id: "b" }],
			// First in PARTITION order: 2 before 3.
			trees: [{ tree: 2 }, { tree: 2 }],
			// Partition 2's whole-name tier beats partition 1's face match, and its card comes with it.
			names: [{ p: 2 }, { p: 2 }],
		});
		expect(got.nameRanks).toEqual([
			[1, 2, 0],
			[1, 2, 0],
		]);
	});

	test("without a routing filter, an id rides to every partition, and the first by partition order wins", async () => {
		// Every cold isolate's first request has no filter yet.
		const { engine, calls } = build({ 1: { byKey: { u: { id: "u", p: 1 } } }, 3: { byKey: { u: { id: "u", p: 3 } } } });
		const got = await engine.scryfallCollectionBatch({ keys: [sid("u")], trees: [], names: names("x") }, "https://x");
		expect(answer(got).keys).toEqual([{ id: "u", p: 1 }]);
		expect(calls.sort()).toEqual([0, 1, 2, 3].map((p) => `scryfallCollectionBatch[u|t0|n1]:${p}`));
	});

	test("a batch of hinted ids alone asks only the partitions they name", async () => {
		const routing = filterOf([
			{ key: scryfallIdKey("a"), partition: 0 },
			{ key: scryfallIdKey("b"), partition: 3 },
		]);
		const { engine, calls } = build(
			{ 0: { byKey: { a: { id: "a" } } }, 3: { byKey: { b: { id: "b" } } } },
			undefined,
			routing,
		);
		const got = await engine.scryfallCollectionBatch({ keys: [sid("a"), sid("b")], trees: [], names: [] }, "https://x");
		expect(answer(got).keys).toEqual([{ id: "a" }, { id: "b" }]);
		// Each partition called is asked for every key: one probe each, and no second round.
		expect(calls.sort()).toEqual(["scryfallCollectionBatch[a,b|t0|n0]:0", "scryfallCollectionBatch[a,b|t0|n0]:3"]);
	});

	test("an id hinted wrong is found in ANOTHER hinted partition, in the same round", async () => {
		// The filter says b lives in 3; it lives in 0, which a's hint calls anyway. The per-kind
		// scryfallCardsByIds asked 0 only about a and then skipped every hinted partition in its
		// second round, so it answered b not_found.
		const routing = filterOf([
			{ key: scryfallIdKey("a"), partition: 0 },
			{ key: scryfallIdKey("b"), partition: 3 },
		]);
		const { engine, calls } = build({ 0: { byKey: { a: { id: "a" }, b: { id: "b" } } } }, undefined, routing);
		const got = await engine.scryfallCollectionBatch({ keys: [sid("a"), sid("b")], trees: [], names: [] }, "https://x");
		expect(answer(got).keys).toEqual([{ id: "a" }, { id: "b" }]);
		expect(calls.length).toBe(2);
	});

	test("an oracle id goes to its arithmetic owner", async () => {
		const oracleId = "aa686c34-cf28-4d4a-bcef-5a34cccdb001";
		const p = partitionOfOracleId(oracleId, N);
		const { engine, calls } = build({ [p]: { byKey: { [oracleId]: { id: oracleId } } } }, undefined, filterOf([]));
		const got = await engine.scryfallCollectionBatch(
			{ keys: [{ kind: "oracle_id", id: oracleId }], trees: [], names: [] },
			"https://x",
		);
		expect(answer(got).keys).toEqual([{ id: oracleId }]);
		expect(calls).toEqual([`scryfallCollectionBatch[${oracleId}|t0|n0]:${p}`]);
	});

	test("a name tie keeps the LOWEST partition, and that partition's card", async () => {
		const { engine } = build({
			1: { collectionRanks: [[1, 2, 5]], collectionCard: { p: 1 } },
			3: { collectionRanks: [[1, 2, 5]], collectionCard: { p: 3 } },
		});
		const got = await engine.scryfallCollectionBatch({ keys: [], trees: [], names: names("x") }, "https://x");
		expect(answer(got).names).toEqual([{ p: 1 }]);
	});

	test("a hinted miss asks only the partitions round 1 did not call — N calls in all", async () => {
		// The filter says 1; the card lives in 3 (a filter from another build).
		const routing = filterOf([{ key: scryfallIdKey("a"), partition: 1 }]);
		const { engine, calls } = build({ 3: { byKey: { a: { id: "a" } } } }, undefined, routing);
		const got = await engine.scryfallCollectionBatch({ keys: [sid("a")], trees: [], names: [] }, "https://x");
		expect(answer(got).keys).toEqual([{ id: "a" }]);
		expect(calls.length).toBe(N);
		expect(calls.filter((c) => c.endsWith(":1"))).toEqual(["scryfallCollectionBatch[a|t0|n0]:1"]);
	});

	describe("a {set, collector_number} address is routed like a key", () => {
		const k = setNumberKey("lea", "161");
		const pair = { trees: ["en", "any"], treeAddresses: [k, k] };

		test("a lone address is ONE call — 74% of DeckGen's collection POSTs", async () => {
			const { engine, calls } = build(
				{ 2: { firstOfEach: { id: "bolt" } } },
				undefined,
				filterOf([{ key: k, partition: 2 }]),
			);
			const got = await engine.scryfallCollectionBatch({ keys: [], names: [], ...pair }, "https://x");
			expect(answer(got).trees).toEqual([{ id: "bolt" }, { id: "bolt" }]);
			expect(calls).toEqual(["scryfallCollectionBatch[|t2|n0]:2"]);
		});

		test("an English miss with a lang-less hit is an ANSWER, not a reason to ask again", async () => {
			const { engine, calls } = build(
				{ 2: { byTree: { any: { id: "hoc-95", lang: "dw" } } } },
				undefined,
				filterOf([{ key: k, partition: 2 }]),
			);
			const got = await engine.scryfallCollectionBatch({ keys: [], names: [], ...pair }, "https://x");
			expect(answer(got).trees).toEqual([null, { id: "hoc-95", lang: "dw" }]);
			expect(calls.length).toBe(1);
		});

		test("an address hinted wrong asks only the partitions round 1 did not call", async () => {
			const { engine, calls } = build(
				{ 3: { firstOfEach: { id: "bolt" } } },
				undefined,
				filterOf([{ key: k, partition: 1 }]),
			);
			const got = await engine.scryfallCollectionBatch({ keys: [], names: [], ...pair }, "https://x");
			expect(answer(got).trees).toEqual([{ id: "bolt" }, { id: "bolt" }]);
			expect(calls.length).toBe(N);
			expect(calls.filter((c) => c.endsWith(":1"))).toEqual(["scryfallCollectionBatch[|t2|n0]:1"]);
		});

		test("addresses and ids share the round: each called partition answers both", async () => {
			const routing = filterOf([
				{ key: k, partition: 2 },
				{ key: scryfallIdKey("a"), partition: 0 },
			]);
			const { engine, calls } = build(
				{ 0: { byKey: { a: { id: "a" } } }, 2: { firstOfEach: { id: "bolt" } } },
				undefined,
				routing,
			);
			const got = await engine.scryfallCollectionBatch({ keys: [sid("a")], names: [], ...pair }, "https://x");
			expect(answer(got)).toEqual({ keys: [{ id: "a" }], trees: [{ id: "bolt" }, { id: "bolt" }], names: [] });
			expect(calls.sort()).toEqual(["scryfallCollectionBatch[a|t2|n0]:0", "scryfallCollectionBatch[a|t2|n0]:2"]);
		});

		test("a batch with names still asks every partition, once", async () => {
			const { engine, calls } = build(
				{ 2: { firstOfEach: { id: "bolt" } } },
				undefined,
				filterOf([{ key: k, partition: 2 }]),
			);
			await engine.scryfallCollectionBatch({ keys: [], names: names("x"), ...pair }, "https://x");
			expect(calls.length).toBe(N);
		});

		test("without the address in the filter, the lookup is the old fan-out, still one round", async () => {
			const { engine, calls } = build({ 2: { firstOfEach: { id: "bolt" } } });
			const got = await engine.scryfallCollectionBatch({ keys: [], names: [], ...pair }, "https://x");
			expect(answer(got).trees).toEqual([{ id: "bolt" }, { id: "bolt" }]);
			expect(calls.length).toBe(N);
		});

		test("/cards/:set/:number: the routed partition alone, then the rest only on a miss", async () => {
			const routed = build({ 2: { firstOfEach: { id: "bolt" } } }, undefined, filterOf([{ key: k, partition: 2 }]));
			expect(await routed.engine.scryfallFirstOfEach(["en", "any"], "https://x", k)).toEqual([
				{ id: "bolt" },
				{ id: "bolt" },
			]);
			expect(routed.calls).toEqual(["scryfallFirstOfEach:2"]);

			const stale = build({ 3: { firstOfEach: { id: "bolt" } } }, undefined, filterOf([{ key: k, partition: 1 }]));
			expect(await stale.engine.scryfallFirstOfEach(["en", "any"], "https://x", k)).toEqual([
				{ id: "bolt" },
				{ id: "bolt" },
			]);
			expect(stale.calls.length).toBe(N);

			const nowhere = build({}, undefined, filterOf([{ key: k, partition: 1 }]));
			expect(await nowhere.engine.scryfallFirstOfEach(["en", "any"], "https://x", k)).toEqual([null, null]);
			expect(nowhere.calls.length).toBe(N);
		});
	});

	test("nothing to resolve costs nothing", async () => {
		const { engine, calls } = build();
		await engine.scryfallCollectionBatch({ keys: [], trees: [], names: [] }, "https://x");
		expect(calls).toEqual([]);
	});
});

describe("the stale-modulus retry (Decision 3b)", () => {
	const oracleId = "aa686c34-cf28-4d4a-bcef-5a34cccdbf87";
	const oracleKey = (id: string): CollectionBatch => ({ keys: [{ kind: "oracle_id", id }], trees: [], names: [] });

	test("a miss re-reads the manifest and asks ONCE more when the modulus moved the target", async () => {
		// The card lives where a FRESH modulus says; the pinned manifest's N is stale.
		// Search for an id the modulus change MOVES (about half of them, but not any
		// fixed one — hardcoding an id would couple the test to the hash function).
		const freshN = N * 2;
		let moved = oracleId;
		for (let i = 0; partitionOfOracleId(moved, freshN) === partitionOfOracleId(moved, N); i++) {
			moved = `aa686c34-cf28-4d4a-bcef-${String(i).padStart(12, "0")}`;
		}
		const freshOwner = partitionOfOracleId(moved, freshN);
		const staleOwner = partitionOfOracleId(moved, N);
		expect(freshOwner).not.toBe(staleOwner);
		const { engine, calls } = build({ [freshOwner]: { byKey: { [moved]: { name: "Moved" } } } }, async () =>
			manifestOf(freshN),
		);
		const got = await engine.scryfallCollectionBatch(oracleKey(moved), "https://x");
		expect(got.keys.map(cardOf)).toEqual([{ name: "Moved" }]);
		expect(calls).toEqual([
			`scryfallCollectionBatch[${moved}|t0|n0]:${staleOwner}`,
			`scryfallCollectionBatch[${moved}|t0|n0]:${freshOwner}`,
		]);
	});

	test("a genuine miss with an unchanged manifest does NOT retry", async () => {
		const { engine, calls } = build({}, async () => manifestOf(N));
		expect((await engine.scryfallCollectionBatch(oracleKey(oracleId), "https://x")).keys).toEqual([null]);
		expect(calls.length).toBe(1);
	});

	test("a changed N that maps to the SAME partition does not re-ask it", async () => {
		// Find an n where the owner stays put.
		let sameN = N;
		for (let n = N + 1; n < N + 32; n++) {
			if (partitionOfOracleId(oracleId, n) === partitionOfOracleId(oracleId, N)) {
				sameN = n;
				break;
			}
		}
		const { engine, calls } = build({}, async () => manifestOf(sameN));
		expect((await engine.scryfallCollectionBatch(oracleKey(oracleId), "https://x")).keys).toEqual([null]);
		expect(calls.length).toBe(1);
	});
});

describe("batches and catalogs", () => {
	test("firstOfEach: one batch RPC per partition, per-position first non-null", async () => {
		const { engine, of } = build({ 2: { firstOfEach: { name: "X" } } });
		const cards = await engine.scryfallFirstOfEach(["f1", "f2"], "https://x");
		expect(cards).toEqual([{ name: "X" }, { name: "X" }]);
		expect(of("scryfallFirstOfEach").length).toBe(N);
	});

	test("collection names: each identifier comes back from the partition that won IT", async () => {
		const { engine, calls } = build({
			1: { collectionRanks: [[1, 2, 0], null], collectionCard: { name: "p1" } },
			2: { collectionRanks: [null, [1, 2, 0]], collectionCard: { name: "p2" } },
		});
		const got = await engine.scryfallCollectionBatch(
			{
				keys: [],
				trees: [],
				names: [
					{ folded: "a", setCode: "" },
					{ folded: "b", setCode: "" },
				],
			},
			"https://x",
		);
		expect(got.names.map(cardOf)).toEqual([{ name: "p1" }, { name: "p2" }]);
		expect(calls.length).toBe(N);
	});

	test("collection names: a needle no partition ranks is a null IN PLACE, and costs no second round", async () => {
		const { engine, calls } = build();
		const got = await engine.scryfallCollectionBatch(
			{ keys: [], trees: [], names: [{ folded: "zzz", setCode: "" }] },
			"https://x",
		);
		expect(got.names).toEqual([null]);
		expect(got.nameRanks).toEqual([null]);
		expect(calls.length).toBe(N);
	});

	test("catalog: N summed, ONCE per store generation — types and keywords share the fan-out", async () => {
		const { engine, of } = build({ 0: { types: { creature: 5 } } });
		const types = await engine.cardTypeCounts();
		expect(types).toEqual({ creature: 8 }); // 5 + 1 + 1 + 1
		expect(of("cardTypeCounts").length).toBe(N);
		// The keywords ride the same fan-out, and a second ask of either costs nothing.
		expect(await engine.cardKeywordCounts()).toEqual({ flying: 8 });
		expect(await engine.cardTypeCounts()).toEqual({ creature: 8 });
		expect(of("cardTypeCounts").length).toBe(N);
		expect(of("cardKeywordCounts").length).toBe(N);
	});

	test("catalog: the cache is per store generation, shared across the per-request engines", async () => {
		// Two engines on the SAME manifest (one request after another): one fan-out between them.
		const manifest = manifestOf(N);
		const calls: string[] = [];
		const first = new PartitionedEngine(
			(p) => fakeRemote(p, calls),
			manifest,
			async () => manifest,
			null,
		);
		const second = new PartitionedEngine(
			(p) => fakeRemote(p, calls),
			manifest,
			async () => manifest,
			null,
		);
		await first.cardTypeCounts();
		await second.cardKeywordCounts();
		expect(calls.filter((c) => c.startsWith("cardTypeCounts:")).length).toBe(N);
		// A new generation (a nightly publish) is a new key, so it fans out again.
		const { engine, of } = build();
		await engine.cardTypeCounts();
		expect(of("cardTypeCounts").length).toBe(N);
	});

	test("catalog: a failed fan-out is not remembered", async () => {
		const manifest = manifestOf(N);
		let fail = true;
		const calls: string[] = [];
		const remote = (p: number) => {
			const inner = fakeRemote(p, calls);
			return {
				...inner,
				cardTypeCounts: async () => {
					if (fail) throw new Error("partition down");
					return inner.cardTypeCounts();
				},
			} as unknown as RemoteEngine;
		};
		const engine = new PartitionedEngine(remote, manifest, async () => manifest, null);
		expect(engine.cardTypeCounts()).rejects.toThrow(/partition down/);
		fail = false;
		expect(await engine.cardTypeCounts()).toEqual({ creature: 4 });
	});

	describe("catalog: the colo's copy", () => {
		const g = globalThis as { caches?: unknown };
		afterEach(() => {
			delete g.caches;
			resetCatalogMemoForTests();
		});
		/** A Map-backed stand-in for `caches.default`, as in edge-cache.test.ts. */
		function installFakeCaches() {
			const entries = new Map<string, string>();
			const puts: string[] = [];
			Object.assign(globalThis, {
				caches: {
					default: {
						match: async (key: string) => {
							const body = entries.get(key);
							return body === undefined ? undefined : new Response(body);
						},
						put: async (key: string, res: Response) => {
							puts.push(key);
							entries.set(key, await res.text());
						},
					},
				},
			});
			return { entries, puts };
		}

		test("the first isolate in a colo fans out and stores; the next cold one asks no partition", async () => {
			const c = installFakeCaches();
			const manifest = manifestOf(N);
			const first: string[] = [];
			const a = new PartitionedEngine(
				(p) => fakeRemote(p, first, p === 0 ? { types: { creature: 5 } } : {}),
				manifest,
				async () => manifest,
				null,
			);
			expect(await a.cardTypeCounts()).toEqual({ creature: 8 });
			expect(await a.setsWithExtras()).toEqual(["lea"]);
			expect(first.filter((x) => x.startsWith("cardTypeCounts:")).length).toBe(N);
			expect(c.puts).toEqual([edgeCacheUrl(`catalog:${manifest.store_key}`)]);
			// A second cold isolate: the memo is empty, the colo entry is not.
			resetCatalogMemoForTests();
			const second: string[] = [];
			const b = new PartitionedEngine(
				(p) => fakeRemote(p, second),
				manifest,
				async () => manifest,
				null,
			);
			expect(await b.cardTypeCounts()).toEqual({ creature: 8 });
			expect(await b.cardKeywordCounts()).toEqual({ flying: 8 });
			expect(await b.setsWithExtras()).toEqual(["lea"]);
			expect(second).toEqual([]);
		});

		test("a colo entry that is not the tables' shape falls through to the fan-out", async () => {
			const c = installFakeCaches();
			const manifest = manifestOf(N);
			c.entries.set(edgeCacheUrl(`catalog:${manifest.store_key}`), '{"types":{}}');
			const calls: string[] = [];
			const engine = new PartitionedEngine(
				(p) => fakeRemote(p, calls),
				manifest,
				async () => manifest,
				null,
			);
			expect(await engine.cardTypeCounts()).toEqual({ creature: 4 });
			expect(calls.filter((x) => x.startsWith("cardTypeCounts:")).length).toBe(N);
		});
	});

	test("cardCount: N summed", async () => {
		const { engine } = build();
		expect(await engine.cardCount()).toBe(N * 10);
	});
});

describe("name-route combination rules", () => {
	const cand = (score: number, oracleId: string, foldedName: string, vpid = 0, served = true) => ({
		score,
		served,
		oracleId,
		vpid,
		foldedName,
	});

	test("fuzzy: candidates race globally, the winning partition materializes", async () => {
		const { engine, of } = build({
			1: {
				candidates: [cand(0.9, "o-1", "shock")],
				fuzzy: { status: "hit", card: { name: "Shock" } },
			},
			2: { candidates: [cand(0.5, "o-2", "sock")] },
		});
		expect(await engine.scryfallFuzzyName("shok", "https://x")).toEqual({
			status: "hit",
			card: { name: "Shock" },
		});
		expect(of("fuzzyCandidates").length).toBe(N); // phase 1 fans to every partition
		expect(of("scryfallFuzzyName")).toEqual(["scryfallFuzzyName:1"]); // only the WINNER materializes
	});

	test("fuzzy: the LEAD rule races ACROSS partitions — near-tied distinct cards are ambiguous, a clear lead is a hit", () => {
		// Two distinct-name, distinct-card candidates within the lead: ambiguous, exactly as one
		// store would say. (The old {status,card} combine could never see the scores.)
		expect(raceFuzzyCandidates([[cand(0.9, "o-1", "shock")], [cand(0.88, "o-2", "sock")]], 0.05).status).toBe(
			"ambiguous",
		);
		// The same shapes with a clear lead: the winner's partition is named.
		expect(raceFuzzyCandidates([[cand(0.9, "o-1", "shock")], [cand(0.5, "o-2", "sock")]], 0.05)).toEqual({
			status: "hit",
			winner: 0,
		});
	});

	test("fuzzy: a card never competes with itself, and shared names are one answer", () => {
		// Same card's English and foreign names (same oracleId): a hit, never ambiguous.
		expect(raceFuzzyCandidates([[cand(0.9, "o-1", "shock")], [cand(0.89, "o-1", "shokku")]], 0.05).status).toBe("hit");
		// Two cards sharing ONE name: one answer, the pre-partition rule.
		expect(raceFuzzyCandidates([[cand(0.9, "o-1", "shock")], [cand(0.9, "o-2", "shock")]], 0.05).status).toBe("hit");
		// Nothing above the floor anywhere: miss.
		expect(raceFuzzyCandidates([[], []], 0.05).status).toBe("miss");
	});

	test("fuzzy: on a score tie the SERVED card leads the extras-only card of the same name", () => {
		// `fuzzy=earth rumbel`: the tla sorcery and the jtla memorabilia front card share the
		// name, so they share the score. The front card sorts first on oracle id AND sits in the
		// lower partition — the served flag is the only thing that makes the sorcery's
		// partition the winner, which is what api.scryfall.com answers (2026-09-15).
		expect(
			raceFuzzyCandidates([[cand(0.9, "o-1", "earth rumble", 0, false)], [cand(0.9, "o-2", "earth rumble")]], 0.05),
		).toEqual({ status: "hit", winner: 1 });
		// Still one answer, not two: the served/extras split never reads as ambiguity.
		expect(
			raceFuzzyCandidates([[cand(0.9, "o-1", "earth rumble", 0, false)], [cand(0.9, "o-2", "earth rumble")]], 0.95)
				.status,
		).toBe("hit");
	});

	test("exact: every partition probed ONCE — rank and card together, no materialize round", async () => {
		const { engine, of } = build({ 3: { exact: { name: "Opt" } } });
		expect(await engine.scryfallExactName("opt", "", "https://x")).toEqual({ name: "Opt" });
		// N probes, where rank-then-materialize was N + 1.
		expect(of("scryfallExactNameProbe").length).toBe(N);
		expect(of("scryfallExactNameRank")).toEqual([]);
		expect(of("scryfallExactName")).toEqual([]);
	});

	test("exact: a WHOLE-name match in a later partition beats a face match in an earlier one", async () => {
		// THE REGRESSION THIS PROTOCOL EXISTS FOR. Before the rank pass, `scryfallExactName` took
		// the first non-null answer in partition order, on the premise that only one partition
		// could answer. `exact_card_by_name` matches FACE and FLAVOR names too, so a needle is
		// routinely one card's whole name and another card's face name — and those cards hash
		// apart. Measured on the ten-partition store: `exact=Ancestral Recall` answered
		// `Emeritus of Ideation // Ancestral Recall`, and `exact=Brainstorm` answered
		// `Harmonized Trio // Brainstorm`, while single-archive production answered both
		// correctly because there the ranking was global by construction.
		const { engine, of } = build({
			1: { exact: { name: "Emeritus of Ideation // Ancestral Recall" }, exactRank: [1, 1, 9.9] },
			3: { exact: { name: "Ancestral Recall" }, exactRank: [1, 2, 0.1] },
		});
		expect(await engine.scryfallExactName("ancestralrecall", "", "https://x")).toEqual({
			name: "Ancestral Recall",
		});
		// The face match sits in the LOWER partition index and carries the HIGHER score, so it
		// wins under both of the rules this replaced.
		expect(of("scryfallExactNameProbe").length).toBe(N);
	});

	test("exact: with no whole-name match anywhere, the best prefer_score wins", async () => {
		// `exact=Fire` — no card is named just "Fire", so every candidate is a face match and the
		// answer turns on prefer_score alone. Scryfall answers `Fire // Ice`; the port answered
		// `Start // Fire` purely because it hashed to a lower partition.
		const { engine } = build({
			0: { exact: { name: "Start // Fire" }, exactRank: [1, 1, 0.2] },
			3: { exact: { name: "Fire // Ice" }, exactRank: [1, 1, 0.7] },
		});
		expect(await engine.scryfallExactName("fire", "", "https://x")).toEqual({ name: "Fire // Ice" });
	});

	test("exact: an exact tie keeps the lowest partition index", async () => {
		const { engine } = build({
			1: { exact: { name: "Lower" }, exactRank: [1, 1, 0.5] },
			3: { exact: { name: "Higher" }, exactRank: [1, 1, 0.5] },
		});
		expect(await engine.scryfallExactName("tie", "", "https://x")).toEqual({ name: "Lower" });
	});

	test("exact: a SERVED card the needle names beats an extras-only card it names exactly, whatever the tiers", async () => {
		// `exact=Earth Rumble` on the ten-partition store: the jtla memorabilia front card is a
		// whole-name match with the higher prefer_score in the lower partition, and it is what
		// production answered on every name route (2026-09-15). The rank's leading element is
		// the served flag, so the served card wins even from a face-match tier.
		const { engine, of } = build({
			0: { exact: { name: "Earth Rumble (jtla front card)" }, exactRank: [0, 2, 9.9] },
			3: { exact: { name: "Earth Rumble" }, exactRank: [1, 1, 0.1] },
		});
		expect(await engine.scryfallExactName("earthrumble", "", "https://x")).toEqual({ name: "Earth Rumble" });
		expect(of("scryfallExactNameProbe").length).toBe(N);
		// With NO served card anywhere the extras-only card still answers: a fallback, not an
		// exclusion (`exact=Cabbages` is jtla/39 on api.scryfall.com).
		const alone = build({ 2: { exact: { name: "Cabbages" }, exactRank: [0, 2, 9.9] } });
		expect(await alone.engine.scryfallExactName("cabbages", "", "https://x")).toEqual({ name: "Cabbages" });
	});

	// n8: a build that publishes card names is answered by ONE object — any partition can, from the
	// corpus-wide blob — chosen by the prefix, so a keystroke's repeats land on the same object.
	describe("autocomplete from the card-names blob (n8)", () => {
		const named = (perPartition: Record<number, Record<string, unknown>> = {}) => {
			const calls: string[] = [];
			const manifest = {
				...manifestOf(N),
				names_key: "store:card-names-v1-100.store:0",
				names_bytes: 4321,
			};
			const engine = new PartitionedEngine(
				(p) => fakeRemote(p, calls, perPartition[p] ?? {}),
				manifest,
				async () => manifest,
				null,
			);
			return { engine, calls };
		};

		test("one call, to gatherPartitionOf(prefix), whose answer is the answer", async () => {
			const { engine, calls } = named();
			expect(await engine.scryfallAutocomplete("lig", 20)).toEqual(["lig:20"]);
			expect(calls.length).toBe(1);
			const [call] = calls;
			expect(call).toBe(`scryfallAutocompleteNames:${gatherPartitionOf("autocomplete:lig", N)}`);
			// The same prefix, the same object; the prefixes spread across the partitions.
			await engine.scryfallAutocomplete("lig", 20);
			expect(calls[1]).toBe(call);
			const spread = new Set<string>();
			for (const prefix of ["ab", "bo", "ch", "dr", "el", "fi", "go", "he", "is", "ja", "ki", "li"]) {
				const one = named();
				await one.engine.scryfallAutocomplete(prefix, 20);
				spread.add(one.calls[0] as string);
			}
			expect(spread.size).toBeGreaterThan(1);
		});

		test("an object that cannot answer from names costs 1 + N, and the fan-out's answer", async () => {
			const everywhere = Object.fromEntries(
				Array.from({ length: N }, (_, p) => [p, { namesFails: true, names: p === 1 ? ["Shock"] : [] }]),
			);
			const { engine, calls } = named(everywhere);
			expect(await engine.scryfallAutocomplete("sho", 20)).toEqual(["Shock"]);
			expect(calls.filter((c) => c.startsWith("scryfallAutocompleteNames:")).length).toBe(1);
			expect(calls.filter((c) => c.startsWith("scryfallAutocomplete:")).length).toBe(N);
		});

		test("a manifest naming no blob fans out exactly as before n8", async () => {
			const { engine, of } = build({ 0: { names: ["Shock"] }, 2: { names: ["Aftershock"] } });
			expect(await engine.scryfallAutocomplete("sho", 20)).toEqual(["Shock", "Aftershock"]);
			expect(of("scryfallAutocomplete").length).toBe(N);
			expect(of("scryfallAutocompleteNames").length).toBe(0);
		});

		test("a malformed names_key or names_bytes reads as no blob", async () => {
			for (const bad of [
				{ names_key: "card-names-v1-100", names_bytes: 10 },
				{ names_key: "store:card-names-v1-100.store:0", names_bytes: 0 },
				{ names_key: "store:card-names-v1-100.store:0" },
			]) {
				const calls: string[] = [];
				const manifest = { ...manifestOf(N), ...bad } as StoreManifest;
				const engine = new PartitionedEngine(
					(p) => fakeRemote(p, calls),
					manifest,
					async () => manifest,
					null,
				);
				await engine.scryfallAutocomplete("sho", 20);
				expect(calls.filter((c) => c.startsWith("scryfallAutocompleteNames:")).length).toBe(0);
				expect(calls.length).toBe(N);
			}
		});
	});

	test("autocomplete: merged prefix-first, deduped, capped", () => {
		expect(
			mergeAutocomplete(
				[
					["Shock", "Shocker"],
					["Aftershock", "Shock"],
				],
				"sho",
				3,
			),
		).toEqual(["Shock", "Shocker", "Aftershock"]);
	});

	// The merge key is `pg_trgm` similarity, not name length — the two shapes where the two
	// disagree, both taken from api.scryfall.com's own answers (2026-08-17) and pinned against
	// the single-store engine by core_api's autocomplete_merge_key_matches_the_single_store.
	test("autocomplete: a repeated trigram outranks being shorter", () => {
		// `igh` and `ght` each occur twice in "Light Up the Night", so its trigram SET is smaller
		// than that of the shorter "Lightning Angel".
		expect(mergeAutocomplete([["Lightning Angel"], ["Light Up the Night"]], "lig", 2)).toEqual([
			"Light Up the Night",
			"Lightning Angel",
		]);
	});

	test("autocomplete: sharing the query's closing window outranks being shorter", () => {
		// "Serra Avenger" ends in `er` and so carries the `er ` window `ser` closes with;
		// "Serenity" does not, and is five characters shorter for nothing.
		expect(mergeAutocomplete([["Serenity"], ["Serra Avenger"]], "ser", 2)).toEqual(["Serra Avenger", "Serenity"]);
	});

	// The prefix rank is asked of the COLLATED name: api.scryfall.com answers `q=gob` with
	// `_____ Goblin` first, which is a prefix match only once the underscores are gone.
	test("autocomplete: the prefix rank is collated", () => {
		expect(mergeAutocomplete([["Goblin Welder"], ["_____ Goblin", "Gobsmacked"]], "gob", 3)).toEqual([
			"_____ Goblin",
			"Gobsmacked",
			"Goblin Welder",
		]);
	});

	test("namesContaining: distinct names survive the cross-partition dedupe", async () => {
		const { engine } = build({
			0: { containing: [{ name: "Fire Bolt Two" }] },
			2: { containing: [{ name: "Bolt of Fire" }, { name: "Fire Bolt Two" }] },
		});
		const cards = await engine.scryfallNamesContaining(["fire", "bolt"], "", 2, "https://x");
		expect(cards.length).toBe(2); // two DISTINCT names → the caller reads ambiguous
	});

	// The whole-name rank is GLOBAL, and each partition can only apply it locally: the card the
	// query names sits in one archive and a name that merely carries its letters in another, so a
	// dedupe that only counts distinct names reads the pair as ambiguous. Scryfall answers the
	// card — `fuzzy=lightningbolt` is Lightning Bolt, not a tie with "Emeritus of Conflict //
	// Lightning Bolt" (measured 2026-08-16).
	test("namesContaining: a name that IS the query wins across partitions", async () => {
		const { engine } = build({
			0: { containing: [{ name: "Emeritus of Conflict // Lightning Bolt" }] },
			2: { containing: [{ name: "Lightning Bolt" }] },
		});
		const cards = await engine.scryfallNamesContaining(["lightning", "bolt"], "", 2, "https://x");
		expect(cards.map((c) => c.name)).toEqual(["Lightning Bolt"]);
	});

	// Separators and diacritics are folded on both sides, and a PRINTED name counts too: the
	// German printing of Lightning Bolt answers `fuzzy=blitzschlag` even when another partition
	// returns a card whose name merely contains those letters.
	test("namesContaining: the whole-name rank reads printed names, folded", async () => {
		const { engine } = build({
			0: { containing: [{ name: "Blitzschlag Storm" }] },
			2: { containing: [{ name: "Unmoored Ego", printed_name: "Ego à Deriva" }] },
		});
		const cards = await engine.scryfallNamesContaining(["ego", "a", "deriva"], "", 2, "https://x");
		expect(cards.map((c) => c.name)).toEqual(["Unmoored Ego"]);
	});

	test("histogram summing is key-wise", () => {
		expect(
			sumCounts([
				{ a: 1, b: 2 },
				{ b: 3, c: 4 },
			]),
		).toEqual({ a: 1, b: 5, c: 4 });
	});
});

describe("exact names route through the filter (backlog n6)", () => {
	// A name key's value: its one partition, N + its one SERVED partition, or 255. The builders
	// write `ns:` for a served row and `nm:` for an extra; both hash as `nm:`.
	const named = (entries: { key: string; partition: number }[]) => filterOf(entries, ROUTING_FEATURE_NAME_KEYS);
	const SOLE = named([{ key: "ns:lightningbolt", partition: 2 }]);
	// The real card in 2, its art-series face in 0: several hold it, one holds it served.
	const SERVED = named([
		{ key: "ns:brainstorm", partition: 2 },
		{ key: "nm:brainstorm", partition: 0 },
	]);
	// Served in two partitions: nothing the filter can decide.
	const TWO_SERVED = named([
		{ key: "ns:fire", partition: 1 },
		{ key: "ns:fire", partition: 3 },
	]);

	test("the spelling: collated, and not routed when non-ASCII survives the fold", () => {
		expect(nameKey("lim-dul's vault")).toBe("nm:limdulsvault");
		expect(nameKey("fire // ice")).toBe("nm:fireice");
		// Typographic quotes both sides drop are fine; a letter the two collations may disagree on is not.
		expect(nameKey("urza’s saga")).toBe("nm:urzassaga");
		expect(nameKey("アクスガルドの自慢屋")).toBeNull();
		expect(nameKey("   ")).toBeNull();
	});

	test("the seal: sole, served, ambiguous — and a filter without the feature answers nothing", () => {
		expect(SOLE.lookupName("nm:lightningbolt")).toEqual({ sole: 2 });
		expect(SERVED.lookupName("nm:brainstorm")).toEqual({ served: 2 });
		expect(TWO_SERVED.lookupName("nm:fire")).toBeNull();
		const unstamped = filterOf([{ key: "ns:lightningbolt", partition: 2 }]);
		expect(unstamped.lookupName("nm:lightningbolt")).toBeNull();
	});

	test("exact: a name ONE partition holds is ONE probe", async () => {
		const { engine, calls } = build({ 2: { exact: { name: "Lightning Bolt" } } }, undefined, SOLE);
		expect(await engine.scryfallExactName("lightning bolt", "", "https://x")).toEqual({ name: "Lightning Bolt" });
		expect(calls).toEqual(["scryfallExactNameProbe:2"]);
	});

	test("exact: a set-restricted miss where the name lives is the answer — it holds the name, so no one else does", async () => {
		const { engine, calls } = build({ 2: { exactRank: null, present: true } }, undefined, SOLE);
		expect(await engine.scryfallExactName("lightning bolt", "lea", "https://x")).toBeNull();
		expect(calls).toEqual(["scryfallExactNameProbe:2"]);
	});

	test("exact: a sole hint the partition cannot confirm asks the rest — N probes, never a wrong answer", async () => {
		// The filter was never built with this name (its bytes read "1" by chance), and the card is in 3.
		const garbage = named([{ key: "ns:lightningbolt", partition: 1 }]);
		const { engine, calls } = build({ 3: { exact: { name: "Real" } } }, undefined, garbage);
		expect(await engine.scryfallExactName("lightning bolt", "", "https://x")).toEqual({ name: "Real" });
		expect(calls.length).toBe(N);
		expect(calls[0]).toBe("scryfallExactNameProbe:1");
	});

	test("exact: the one SERVED holder answering served is the answer, whatever the others hold", async () => {
		const { engine, calls } = build(
			{
				0: { exact: { name: "Brainstorm // Brainstorm (art series)" }, exactRank: [0, 1, 9.9] },
				2: { exact: { name: "Brainstorm" }, exactRank: [1, 2, 0.1] },
			},
			undefined,
			SERVED,
		);
		expect(await engine.scryfallExactName("brainstorm", "", "https://x")).toEqual({ name: "Brainstorm" });
		expect(calls).toEqual(["scryfallExactNameProbe:2"]);
	});

	test("exact: a served route that answers only an extra asks the rest and merges in partition order", async () => {
		// `set=` admitted only the served holder's memorabilia printing; the art-series card in 0
		// scores higher on the same served-0 footing and wins, as the fan-out would have said.
		const { engine, calls } = build(
			{
				0: { exact: { name: "art series" }, exactRank: [0, 1, 9.9] },
				2: { exact: { name: "memorabilia" }, exactRank: [0, 2, 0.1] },
			},
			undefined,
			SERVED,
		);
		expect(await engine.scryfallExactName("brainstorm", "wc98", "https://x")).toEqual({ name: "memorabilia" });
		expect(calls.length).toBe(N);
		// A tie between the routed reply and a later one keeps the LOWER partition, routed or not.
		const tie = build(
			{
				0: { exact: { name: "lower" }, exactRank: [0, 2, 5] },
				2: { exact: { name: "routed" }, exactRank: [0, 2, 5] },
			},
			undefined,
			SERVED,
		);
		expect(await tie.engine.scryfallExactName("brainstorm", "", "https://x")).toEqual({ name: "lower" });
	});

	// Backlog n13: a printing whose flavor names sit on its FACES is keyed by their join, and the
	// builders emit that join as one more name key — so the needle routes like any other name. The
	// keys are the literal lines `name_routing_keys_of` writes for sld/1079 and sld/1807
	// (`a_face_flavor_name_is_one_joined_key` in engine/builder/src/transform.rs).
	test("exact: a face-level flavor name is ONE probe, to the partition holding its printing", async () => {
		const FACES = named([
			{ key: "ns:blightsteelcolossusblightsteelcolossus", partition: 3 },
			{ key: "ns:blightsteelcolossus", partition: 3 },
			{ key: "ns:megatronmegatron", partition: 3 },
			{ key: "ns:kardurdoomscourgekardurdoomscourge", partition: 1 },
			{ key: "ns:kardurdoomscourge", partition: 1 },
			{ key: "ns:chucky", partition: 1 },
		]);
		const megatron = build(
			{ 3: { exact: { name: "Blightsteel Colossus // Blightsteel Colossus" } } },
			undefined,
			FACES,
		);
		expect(await megatron.engine.scryfallExactName("megatron // megatron", "", "https://x")).toEqual({
			name: "Blightsteel Colossus // Blightsteel Colossus",
		});
		expect(megatron.calls).toEqual(["scryfallExactNameProbe:3"]);
		const chucky = build({ 1: { exact: { name: "Kardur, Doomscourge // Kardur, Doomscourge" } } }, undefined, FACES);
		expect(await chucky.engine.scryfallExactName("chucky", "", "https://x")).toEqual({
			name: "Kardur, Doomscourge // Kardur, Doomscourge",
		});
		expect(chucky.calls).toEqual(["scryfallExactNameProbe:1"]);
		// A set-restricted miss is settled there too: the partition holds the name (`present`).
		const scoped = build({ 1: { exactRank: null, present: true } }, undefined, FACES);
		expect(await scoped.engine.scryfallExactName("chucky", "lea", "https://x")).toBeNull();
		expect(scoped.calls).toEqual(["scryfallExactNameProbe:1"]);
	});

	test("exact: an undecidable name, or a filter without name keys, probes every partition once", async () => {
		const two = build({ 1: { exact: { name: "Fire // Ice" }, exactRank: [1, 1, 0.7] } }, undefined, TWO_SERVED);
		expect(await two.engine.scryfallExactName("fire", "", "https://x")).toEqual({ name: "Fire // Ice" });
		expect(two.calls.length).toBe(N);
		const old = build(
			{ 2: { exact: { name: "Lightning Bolt" } } },
			undefined,
			filterOf([{ key: "ns:lightningbolt", partition: 2 }]),
		);
		await old.engine.scryfallExactName("lightning bolt", "", "https://x");
		expect(old.calls.length).toBe(N);
	});

	describe("collection names", () => {
		const names = (...folded: string[]) => folded.map((f) => ({ folded: f, setCode: "" }));
		const MANY = named([
			{ key: "ns:lightningbolt", partition: 2 },
			{ key: "ns:counterspell", partition: 2 },
			{ key: "ns:opt", partition: 3 },
			// Served in two partitions: no route.
			{ key: "ns:mystery", partition: 1 },
			{ key: "ns:mystery", partition: 3 },
		]);
		const names0 = (got: { names: (Uint8Array | null)[] }) => got.names.map(cardOf);

		test("routed names go to their own partitions only, each asked for its own names — one round", async () => {
			const { engine, calls } = build(
				{
					2: { rankByName: { "lightning bolt": [1, 2, 0], counterspell: [1, 2, 0] } },
					3: { rankByName: { opt: [1, 2, 0] } },
				},
				undefined,
				MANY,
			);
			const got = await engine.scryfallCollectionBatch(
				{ keys: [], trees: [], names: names("lightning bolt", "opt", "counterspell") },
				"https://x",
			);
			expect(names0(got)).toEqual([
				{ p: 2, name: "lightning bolt" },
				{ p: 3, name: "opt" },
				{ p: 2, name: "counterspell" },
			]);
			expect(calls.sort()).toEqual(["scryfallCollectionBatch[|t0|n1]:3", "scryfallCollectionBatch[|t0|n2]:2"]);
		});

		test("a routed name its partition does not settle is asked of every other one, and merged in order", async () => {
			const garbage = named([{ key: "ns:lightningbolt", partition: 1 }]);
			const { engine, calls } = build({ 3: { rankByName: { "lightning bolt": [1, 2, 0] } } }, undefined, garbage);
			const got = await engine.scryfallCollectionBatch(
				{ keys: [], trees: [], names: names("lightning bolt") },
				"https://x",
			);
			expect(names0(got)).toEqual([{ p: 3, name: "lightning bolt" }]);
			expect(calls.length).toBe(N);
			expect(calls.filter((c) => c.endsWith(":1"))).toEqual(["scryfallCollectionBatch[|t0|n1]:1"]);
		});

		test("a sole partition's miss is settled by presence — no second round", async () => {
			const { engine, calls } = build({ 2: { rankByName: {}, presentNames: ["lightning bolt"] } }, undefined, SOLE);
			const got = await engine.scryfallCollectionBatch(
				{ keys: [], trees: [], names: [{ folded: "lightning bolt", setCode: "lea" }] },
				"https://x",
			);
			expect(names0(got)).toEqual([null]);
			expect(calls).toEqual(["scryfallCollectionBatch[|t0|n1]:2"]);
		});

		test("one unrouted name calls every partition — but the routed names still go only to theirs", async () => {
			const { engine, calls } = build(
				{
					1: { rankByName: { mystery: [1, 2, 0] } },
					2: { rankByName: { "lightning bolt": [1, 2, 0] } },
				},
				undefined,
				MANY,
			);
			const got = await engine.scryfallCollectionBatch(
				{ keys: [], trees: [], names: names("lightning bolt", "mystery") },
				"https://x",
			);
			expect(names0(got)).toEqual([
				{ p: 2, name: "lightning bolt" },
				{ p: 1, name: "mystery" },
			]);
			expect(calls.sort()).toEqual([
				"scryfallCollectionBatch[|t0|n1]:0",
				"scryfallCollectionBatch[|t0|n1]:1",
				"scryfallCollectionBatch[|t0|n1]:3",
				"scryfallCollectionBatch[|t0|n2]:2",
			]);
		});
	});

	describe('a `!"Name"` search is pinned to the name\'s one partition', () => {
		const exactTree = (value: string) =>
			JSON.stringify({
				node_type: "AndNode",
				kwargs: {
					operands: [
						{ node_type: "ExactNameNode", kwargs: { value } },
						{ node_type: "NotNode", kwargs: { operand: { node_type: "TrueNode", kwargs: {} } } },
					],
				},
			});
		const pinned = { ...OPTS, filterTreeJson: exactTree("lightningbolt") };

		test("a sole route asks that partition alone, carrying this isolate's N", async () => {
			const { engine, calls } = build({}, undefined, SOLE);
			await engine.scryfallSearch(pinned, "https://x");
			await engine.searchCardsAsJson(pinned, "rows");
			expect(calls).toEqual([`scryfallSearch[${N}]:2`, `searchCardsAsJson[${N}]:2`]);
			expect(engine.pinnedAnswer).toBe(true);
		});

		test("an EMPTY pinned answer is not trusted: the gather answers", async () => {
			const { engine, calls } = build({ 2: { totalCards: 0 } }, undefined, SOLE);
			await engine.searchCardsAsObjects(pinned);
			expect(calls[0]).toBe(`searchCardsAsObjects[${N}]:2`);
			expect(calls.filter((c) => c.startsWith("gatherSearchAsObjects")).length).toBe(1);
			expect(engine.pinnedAnswer).toBe(false);
			expect(engine.partitionCalls).toBe(2);
		});

		test("a served route, or no route, gathers", async () => {
			const served = build({}, undefined, SERVED);
			await served.engine.searchCardsAsObjects({ ...OPTS, filterTreeJson: exactTree("brainstorm") });
			expect(served.calls.map((c) => c.split(":")[0])).toEqual(["gatherSearchAsObjects"]);
			// A name the filter never held reads an arbitrary byte, which may well name a partition:
			// that partition's empty answer is what sends it to the gather.
			const nothing = { totalCards: 0 };
			const none = build({ 0: nothing, 1: nothing, 2: nothing, 3: nothing }, undefined, SOLE);
			await none.engine.searchCardsAsObjects({ ...OPTS, filterTreeJson: exactTree("notacard") });
			expect(none.calls.some((c) => c.startsWith("gatherSearchAsObjects"))).toBe(true);
		});
	});
});

// n15: a gathered search carries the build it is pinned to, so its coordinator may answer a
// name-only filter from its names index — and only when the manifest names a names blob at all.
describe("a gathered search carries its build to the coordinator's names index (n15)", () => {
	function recording(withNames: boolean) {
		const seen: { method: string; opts: Record<string, unknown> }[] = [];
		const manifest = withNames
			? { ...manifestOf(N), names_key: "store:card-names-v1-100.store:0", names_bytes: 10 }
			: manifestOf(N);
		const record = (method: string, answer: unknown) => async (opts: Record<string, unknown>) => {
			seen.push({ method, opts });
			return answer;
		};
		const engine = new PartitionedEngine(
			() =>
				({
					gatherSearchAsObjects: record("gatherSearchAsObjects", { totalCards: 0, cards: [] }),
					gatherSearchAsJson: record("gatherSearchAsJson", {
						totalCards: 0,
						cardsBytes: new Uint8Array(),
						rowCount: 0,
					}),
					gatherScryfallSearch: record("gatherScryfallSearch", {
						totalCards: 0,
						cardsBytes: new Uint8Array(),
						rowCount: 0,
					}),
					scryfallSearchPage: record("scryfallSearchPage", new Response("{}", { status: 404 })),
					gatheredPartitions: 0,
				}) as unknown as RemoteEngine,
			manifest,
			async () => manifest,
			null,
		);
		return { engine, seen };
	}

	test("every gather transport sends namesBuild = the pinned build, the caller's options otherwise unchanged", async () => {
		const { engine, seen } = recording(true);
		await engine.searchCardsAsObjects(OPTS);
		await engine.searchCardsAsJson(OPTS, "rows");
		await engine.scryfallSearch(OPTS, "https://x");
		await engine.scryfallSearchPage(OPTS, "https://x", { pretty: false, pageOffset: 0, noMatchDetails: "" }, {});
		expect(seen.map((s) => s.method)).toEqual([
			"gatherSearchAsObjects",
			"gatherSearchAsJson",
			"gatherScryfallSearch",
			"scryfallSearchPage",
		]);
		for (const { opts } of seen) expect(opts).toEqual({ ...OPTS, namesBuild: "100" });
		// The coordinator's count of partitions asked reaches the route's log line.
		expect(engine.gatheredPartitions).toBe(0);
	});

	test("a manifest that names no names blob sends the options untouched", async () => {
		const { engine, seen } = recording(false);
		await engine.searchCardsAsObjects(OPTS);
		expect(seen[0]?.opts).toEqual(OPTS);
	});
});
