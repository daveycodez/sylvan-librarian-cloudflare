// The per-route RPC-count table (plan B5), pinned.
//
// Partitioned serving's cost model is the NUMBER of partition objects each route
// touches, and nothing at runtime asserts it: a fan-out sneaking into a route
// that should make one RPC would be invisible in results and only show up as N×
// duration on the meters. So the table in partitioned-engine.ts's header is a
// contract, and this file is where it is enforced — a fake engine per partition
// counts every call.

import { describe, expect, test } from "bun:test";
import { partitionOfOracleId } from "../../src/engine/partition";
import {
	mergeAutocomplete,
	PartitionedEngine,
	raceFuzzyCandidates,
	sumCounts,
} from "../../src/engine/partitioned-engine";
import type { RemoteEngine } from "../../src/engine/remote-engine";
import {
	buildRoutingFilter,
	externalIdKey,
	illustrationIdKey,
	RoutingFilter,
	scryfallIdKey,
} from "../../src/engine/routing-filter";
import type { StoreManifest } from "../../src/engine/types";

const N = 4;

function manifestOf(n: number): StoreManifest {
	return {
		store_key: `card-store-v1-100.store`,
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
		scryfallSearchPage: async () => {
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
			return val<number[] | null>("exactRank", "exact" in answers ? [2, 0] : null);
		},
		scryfallAutocomplete: async () => {
			count("scryfallAutocomplete");
			return val<string[]>("names", []);
		},
		scryfallNamesContaining: async () => {
			count("scryfallNamesContaining");
			return val<Record<string, unknown>[]>("containing", []);
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
		expect(calls.length).toBe(2);
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

describe("the routing filter collapses the bare-id fan-out", () => {
	const CARD = "0001c639-8bd0-426f-89cb-4ca61f3cc054";
	const ART = "7eb65d52-deea-4693-9111-9f95a3b0c915";

	/** A filter that places the three ids below, built at the fake manifest's identity. */
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

	test("catalog: N summed", async () => {
		const { engine, of } = build({ 0: { types: { creature: 5 } } });
		const types = await engine.cardTypeCounts();
		expect(types).toEqual({ creature: 8 }); // 5 + 1 + 1 + 1
		expect(of("cardTypeCounts").length).toBe(N);
	});

	test("cardCount: N summed", async () => {
		const { engine } = build();
		expect(await engine.cardCount()).toBe(N * 10);
	});
});

describe("name-route combination rules", () => {
	const cand = (score: number, oracleId: string, foldedName: string, vpid = 0) => ({
		score,
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
			1: { exact: { name: "Emeritus of Ideation // Ancestral Recall" }, exactRank: [1, 9.9] },
			3: { exact: { name: "Ancestral Recall" }, exactRank: [2, 0.1] },
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
			0: { exact: { name: "Start // Fire" }, exactRank: [1, 0.2] },
			3: { exact: { name: "Fire // Ice" }, exactRank: [1, 0.7] },
		});
		expect(await engine.scryfallExactName("fire", "", "https://x")).toEqual({ name: "Fire // Ice" });
	});

	test("exact: an exact tie keeps the lowest partition index", async () => {
		const { engine } = build({
			1: { exact: { name: "Lower" }, exactRank: [1, 0.5] },
			3: { exact: { name: "Higher" }, exactRank: [1, 0.5] },
		});
		expect(await engine.scryfallExactName("tie", "", "https://x")).toEqual({ name: "Lower" });
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
