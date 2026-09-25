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
import { partitionOfOracleId } from "../../src/engine/partition";
import {
	mergeAutocomplete,
	PartitionedEngine,
	raceFuzzyCandidates,
	resetCatalogMemoForTests,
	sumCounts,
} from "../../src/engine/partitioned-engine";
import type { RemoteEngine } from "../../src/engine/remote-engine";
import {
	buildRoutingFilter,
	externalIdKey,
	illustrationIdKey,
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
			return { totalCards: 1, cards: [] };
		},
		searchCardsAsJson: async (_opts: unknown, _shape: unknown, pinned?: number) => {
			count(`searchCardsAsJson[${pinned ?? "-"}]`);
			return { totalCards: 1, cardsBytes: new Uint8Array(), rowCount: 0 };
		},
		scryfallSearch: async (_opts: unknown, _base: unknown, pinned?: number) => {
			count(`scryfallSearch[${pinned ?? "-"}]`);
			return { totalCards: 1, cardsBytes: new Uint8Array(), rowCount: 0 };
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
		scryfallCardByOracleId: async () => {
			count("scryfallCardByOracleId");
			return val<Record<string, unknown> | null>("oracleCard", null);
		},
		scryfallCardById: async () => {
			count("scryfallCardById");
			return val<Record<string, unknown> | null>("cardById", null);
		},
		scryfallCardByExternalId: async () => {
			count("scryfallCardByExternalId");
			return null;
		},
		scryfallCardByIllustrationId: async () => {
			count("scryfallCardByIllustrationId");
			return null;
		},
		scryfallCardsByIds: async (ids: string[]) => {
			count("scryfallCardsByIds");
			return val<Record<string, unknown>[]>("byIds", []).filter((c) => ids.includes(String(c.id)));
		},
		scryfallCardsByIdentifiers: async (identifiers: { kind: string; id: string | number }[]) => {
			count("scryfallCardsByIdentifiers");
			// `byKey` maps an identifier's id to the card this partition holds for it.
			const held = val<Record<string, Record<string, unknown>>>("byKey", {});
			return identifiers.map((ident) => held[String(ident.id)] ?? null);
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
		scryfallCollectionNames: async (identifiers: { folded: string }[]) => {
			count("scryfallCollectionNames");
			// One card for every identifier this partition was ASKED about — the router only asks
			// for the ones it won, so the length is the test's assertion surface.
			return identifiers.map(() => val<Record<string, unknown> | null>("collectionCard", null));
		},
		scryfallCollectionNameRanks: async (identifiers: { folded: string }[]) => {
			count("scryfallCollectionNameRanks");
			const ranks = val<(number[] | null)[]>("collectionRanks", []);
			return identifiers.map((_, i) => ranks[i] ?? null);
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
			const nameRanks = batch.names.map((_, i) => ranks[i] ?? null);
			return {
				keys: batch.keys.map((k) => cardBytes(held[String(k.id)] ?? null)),
				trees: batch.trees.map((t) => cardBytes(byTree ? (byTree[t] ?? null) : tree)),
				names: nameRanks.map((rank) => (rank === null ? null : cardBytes(card))),
				nameRanks,
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
		});

		test("an unpinned query still gathers", async () => {
			const { engine, calls } = build();
			await engine.scryfallSearchPage(OPTS, "https://x", { pretty: false, pageOffset: 0, noMatchDetails: "" }, {});
			expect(calls.some((c) => c.startsWith("scryfallSearchPage[cards2]"))).toBe(true);
			expect(calls.some((c) => c.startsWith("scryfallSearchPage[cards,"))).toBe(false);
		});

		test("a partition cut at another count refuses, and the gather answers instead", async () => {
			const { engine, calls, of } = build({ [owner]: { staleModulus: true } });
			await engine.searchCardsAsObjects(pinnedOpts);
			expect(calls).toContain(`searchCardsAsObjects[${N}]:${owner}`);
			expect(of("gatherSearchAsObjects").length).toBe(1);
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
	test("oracle-keyed: exactly ONE RPC, to the owning partition", async () => {
		const oracleId = "aa686c34-cf28-4d4a-bcef-5a34cccdbf87";
		const owner = partitionOfOracleId(oracleId, N);
		const { engine, of, calls } = build({ [owner]: { oracleCard: { name: "Found" } } });
		const card = await engine.scryfallCardByOracleId(oracleId, "https://x");
		expect(card).toEqual({ name: "Found" });
		expect(of("scryfallCardByOracleId")).toEqual([`scryfallCardByOracleId:${owner}`]);
		expect(calls.length).toBe(1);
	});

	test("scryfall_id-keyed: N parallel, first non-null", async () => {
		const { engine, of } = build({ 2: { cardById: { name: "Hit" } } });
		const card = await engine.scryfallCardById("some-uuid", "https://x");
		expect(card).toEqual({ name: "Hit" });
		expect(of("scryfallCardById").length).toBe(N);
	});

	test("external and illustration ids: N each", async () => {
		const { engine, of } = build();
		await engine.scryfallCardByExternalId("multiverse", 42, "https://x");
		await engine.scryfallCardByIllustrationId("uuid", "https://x");
		expect(of("scryfallCardByExternalId").length).toBe(N);
		expect(of("scryfallCardByIllustrationId").length).toBe(N);
	});

	test("random: ONE RPC, weighted by card_count", async () => {
		const { engine, of } = build();
		await engine.randomCardsAsObjects(1, ["name"]);
		expect(of("randomCardsAsObjects").length).toBe(1);
	});
});

/** A routing filter placing the given ids, built at the fake manifest's identity. */
function filterOf(entries: { key: string; partition: number }[]): RoutingFilter {
	const bytes = buildRoutingFilter(entries, {
		builtAt: "100",
		partitionCount: N,
		partitionHash: "fnv1a64/oracle_id/v1",
	});
	const parsed = RoutingFilter.parse(bytes, {
		builtAt: "100",
		partitionCount: N,
		partitionHash: "fnv1a64/oracle_id/v1",
	});
	if ("reason" in parsed) throw new Error(parsed.reason);
	return parsed.filter;
}

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

	test("external and illustration ids collapse the same way", async () => {
		const routing = filterOf([
			{ key: externalIdKey("multiverse", 634752), partition: 1 },
			{ key: illustrationIdKey(ART), partition: 3 },
		]);
		const { engine, of } = build({ 1: {}, 3: {} }, undefined, routing);
		// Both partitions answer null here, so these are the WORST case — see the
		// fallback test below for what that costs.
		await engine.scryfallCardByExternalId("multiverse", 634752, "https://x");
		expect(of("scryfallCardByExternalId")[0]).toBe("scryfallCardByExternalId:1");
		await engine.scryfallCardByIllustrationId(ART, "https://x");
		expect(of("scryfallCardByIllustrationId")[0]).toBe("scryfallCardByIllustrationId:3");
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

	test("a collection of known ids asks only the partitions that hold them", async () => {
		const a = "11111111-1111-4111-8111-111111111111";
		const b = "22222222-2222-4222-8222-222222222222";
		const routing = filterOf([
			{ key: scryfallIdKey(a), partition: 1 },
			{ key: scryfallIdKey(b), partition: 1 },
		]);
		const { engine, of } = build({ 1: { byIds: [{ id: a }, { id: b }] } }, undefined, routing);
		expect(await engine.scryfallCardsByIds([a, b], "https://x")).toEqual([{ id: a }, { id: b }]);
		expect(of("scryfallCardsByIds")).toEqual(["scryfallCardsByIds:1"]);
	});

	test("a collection with an unknown id still resolves it, in request order", async () => {
		const known = "11111111-1111-4111-8111-111111111111";
		const stranger = "33333333-3333-4333-8333-333333333333";
		const routing = filterOf([{ key: scryfallIdKey(known), partition: 1 }]);
		const { engine, of } = build(
			{ 1: { byIds: [{ id: known }] }, 3: { byIds: [{ id: stranger }] } },
			undefined,
			routing,
		);
		expect(await engine.scryfallCardsByIds([stranger, known], "https://x")).toEqual([{ id: stranger }, { id: known }]);
		// One hinted batch plus the partitions it did not cover — still at most N.
		expect(of("scryfallCardsByIds").length).toBeLessThanOrEqual(N);
	});
});

describe("the key-shaped collection identifiers are ONE batch per partition asked", () => {
	// oracle_id, illustration_id, mtgo_id and multiverse_id used to be resolved one RPC per
	// identifier — 75 x N Durable Object requests for a batch of misses.
	const ext = (id: number) => ({ kind: "external" as const, namespace: "multiverse", id });

	test("hinted identifiers go to their partitions, one RPC each, however many there are", async () => {
		const ids = Array.from({ length: 75 }, (_, i) => 1000 + i);
		const routing = filterOf(ids.map((id, i) => ({ key: externalIdKey("multiverse", id), partition: i % 2 })));
		const held = (parity: number) =>
			Object.fromEntries(ids.filter((_, i) => i % 2 === parity).map((id) => [String(id), { id }]));
		const { engine, of } = build({ 0: { byKey: held(0) }, 1: { byKey: held(1) } }, undefined, routing);
		const cards = await engine.scryfallCardsByIdentifiers(ids.map(ext), "https://x");
		expect(cards.map((c) => c?.id)).toEqual(ids);
		expect(of("scryfallCardsByIdentifiers").sort()).toEqual([
			"scryfallCardsByIdentifiers:0",
			"scryfallCardsByIdentifiers:1",
		]);
	});

	test("unhinted identifiers cost the fan-out once, never per identifier", async () => {
		const ids = Array.from({ length: 75 }, (_, i) => 5000 + i);
		const { engine, of } = build({}, undefined, filterOf([]));
		const cards = await engine.scryfallCardsByIdentifiers(ids.map(ext), "https://x");
		expect(cards.every((c) => c === null)).toBe(true);
		expect(of("scryfallCardsByIdentifiers").length).toBe(N);
	});

	test("without a routing filter, an unhinted id still reaches a partition round 1 asked for oracle ids", async () => {
		// The first request of every cold isolate has no filter yet. Partition p is asked for an
		// oracle id it owns; the multiverse id ALSO lives in p. The unhinted id must ride along to
		// every partition — including p — or it is reported not_found while the card exists.
		const oracleId = "aa686c34-cf28-4d4a-bcef-5a34cccdb001";
		const p = partitionOfOracleId(oracleId, N);
		const { engine, of } = build(
			{ [p]: { byKey: { [oracleId]: { id: oracleId }, "9999": { id: 9999 } } } },
			undefined,
			null,
		);
		const cards = await engine.scryfallCardsByIdentifiers(
			[{ kind: "oracle_id" as const, id: oracleId }, ext(9999)],
			"https://x",
		);
		expect(cards.map((c) => c?.id)).toEqual([oracleId, 9999]);
		// One round: every partition asked once, none twice.
		expect(of("scryfallCardsByIdentifiers").length).toBe(N);
	});

	test("oracle ids group by their arithmetic owner", async () => {
		const oracle = (i: number) => `aa686c34-cf28-4d4a-bcef-5a34cccdb${String(i).padStart(3, "0")}`;
		const ids = Array.from({ length: 20 }, (_, i) => oracle(i));
		const owners = new Set(ids.map((id) => partitionOfOracleId(id, N)));
		const perPartition: Record<number, Record<string, unknown>> = {};
		for (const id of ids) {
			const p = partitionOfOracleId(id, N);
			perPartition[p] ??= { byKey: {} };
			(perPartition[p].byKey as Record<string, unknown>)[id] = { id };
		}
		const { engine, of } = build(perPartition, undefined, filterOf([]));
		const cards = await engine.scryfallCardsByIdentifiers(
			ids.map((id) => ({ kind: "oracle_id" as const, id })),
			"https://x",
		);
		expect(cards.map((c) => c?.id)).toEqual(ids);
		expect(of("scryfallCardsByIdentifiers").length).toBe(owners.size);
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

	test("a miss re-reads the manifest and retries ONCE when the modulus moved the target", async () => {
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
		const { engine, of } = build({ [freshOwner]: { oracleCard: { name: "Moved" } } }, async () => manifestOf(freshN));
		const card = await engine.scryfallCardByOracleId(moved, "https://x");
		expect(card).toEqual({ name: "Moved" });
		expect(of("scryfallCardByOracleId")).toEqual([
			`scryfallCardByOracleId:${staleOwner}`,
			`scryfallCardByOracleId:${freshOwner}`,
		]);
	});

	test("a genuine miss with an unchanged manifest does NOT retry", async () => {
		const { engine, of } = build({}, async () => manifestOf(N));
		expect(await engine.scryfallCardByOracleId(oracleId, "https://x")).toBeNull();
		expect(of("scryfallCardByOracleId").length).toBe(1);
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
		const { engine, of } = build({}, async () => manifestOf(sameN));
		expect(await engine.scryfallCardByOracleId(oracleId, "https://x")).toBeNull();
		expect(of("scryfallCardByOracleId").length).toBe(1);
	});
});

describe("batches and catalogs", () => {
	test("collection byIds: one batch RPC per partition, merged back into request order", async () => {
		const { engine, of } = build({
			1: { byIds: [{ id: "b", name: "B" }] },
			3: { byIds: [{ id: "a", name: "A" }] },
		});
		const cards = await engine.scryfallCardsByIds(["a", "b", "missing"], "https://x");
		expect(cards).toEqual([
			{ id: "a", name: "A" },
			{ id: "b", name: "B" },
		]);
		expect(of("scryfallCardsByIds").length).toBe(N);
	});

	test("firstOfEach: one batch RPC per partition, per-position first non-null", async () => {
		const { engine, of } = build({ 2: { firstOfEach: { name: "X" } } });
		const cards = await engine.scryfallFirstOfEach(["f1", "f2"], "https://x");
		expect(cards).toEqual([{ name: "X" }, { name: "X" }]);
		expect(of("scryfallFirstOfEach").length).toBe(N);
	});

	test("collection names: N rank RPCs, then one materialize RPC per WINNING partition", async () => {
		// The two-round protocol, and why it is not `firstNonNull` per identifier: partition 1 has
		// a FACE match for the first needle and partition 2 has a WHOLE-name match, and the higher
		// tier has to win however the partitions are ordered. Partition 1 answers a rank and is
		// never asked for a card.
		const { engine, of } = build({
			1: { collectionRanks: [[1, 0], null], collectionCard: { name: "face" } },
			2: {
				collectionRanks: [
					[2, 0],
					[2, 0],
				],
				collectionCard: { name: "whole" },
			},
		});
		const cards = await engine.scryfallCollectionNames(
			[
				{ folded: "a", setCode: "" },
				{ folded: "b", setCode: "" },
			],
			"https://x",
		);
		expect(cards).toEqual([{ name: "whole" }, { name: "whole" }]);
		expect(of("scryfallCollectionNameRanks").length).toBe(N);
		expect(of("scryfallCollectionNames").length).toBe(1);
	});

	test("collection names: each identifier comes back from the partition that won IT", async () => {
		const { engine, of } = build({
			1: { collectionRanks: [[2, 0], null], collectionCard: { name: "p1" } },
			2: { collectionRanks: [null, [2, 0]], collectionCard: { name: "p2" } },
		});
		const cards = await engine.scryfallCollectionNames(
			[
				{ folded: "a", setCode: "" },
				{ folded: "b", setCode: "" },
			],
			"https://x",
		);
		expect(cards).toEqual([{ name: "p1" }, { name: "p2" }]);
		expect(of("scryfallCollectionNames").length).toBe(2);
	});

	test("collection names: a needle no partition ranks is a null IN PLACE, and costs no second round", async () => {
		const { engine, of } = build();
		expect(await engine.scryfallCollectionNames([{ folded: "zzz", setCode: "" }], "https://x")).toEqual([null]);
		expect(of("scryfallCollectionNameRanks").length).toBe(N);
		expect(of("scryfallCollectionNames").length).toBe(0);
	});

	test("collection names: an empty batch touches no partition at all", async () => {
		const { engine, calls } = build();
		expect(await engine.scryfallCollectionNames([], "https://x")).toEqual([]);
		expect(calls.length).toBe(0);
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

	test("exact: rank every partition, materialize only the winner", async () => {
		const { engine, of } = build({ 3: { exact: { name: "Opt" } } });
		expect(await engine.scryfallExactName("opt", "", "https://x")).toEqual({ name: "Opt" });
		// N cheap rank calls, then ONE card materialization — not N of them.
		expect(of("scryfallExactNameRank").length).toBe(N);
		expect(of("scryfallExactName").length).toBe(1);
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
		expect(of("scryfallExactName").length).toBe(1);
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
		expect(of("scryfallExactName")).toEqual(["scryfallExactName:3"]);
		// With NO served card anywhere the extras-only card still answers: a fallback, not an
		// exclusion (`exact=Cabbages` is jtla/39 on api.scryfall.com).
		const alone = build({ 2: { exact: { name: "Cabbages" }, exactRank: [0, 2, 9.9] } });
		expect(await alone.engine.scryfallExactName("cabbages", "", "https://x")).toEqual({ name: "Cabbages" });
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
