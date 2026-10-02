// A collection name its route does not settle, on the REAL corpus (backlog x47): `POST
// /cards/collection` through the real route and the real PartitionedEngine, every partition its own
// instance of the committed wasm, the names index in one more (real-partitions.ts).
//
// Two claims.
//
//   1. THE INDEX'S HOLDERS ARE EVERY PARTITION THAT CAN ANSWER. For a name — a card's own, either
//      half of a two-part one, a misspelling, a name several cards share — every partition whose
//      `collection_batch` ranks it is among the partitions the names index lists (card-names.ts
//      `nameHoldersFromIndex`). So asking only those reads every reply the fan-out's merge reads; and
//      a set or a scope only removes printings, so the list stays a superset under either.
//   2. THE RESPONSE DOES NOT MOVE. Deck lists shaped like production's (DeckGen 2026-09-30: 1–75
//      names, 0–10 of them misspelt, some naming cards several partitions hold), behind a routing
//      filter built from the corpus's own names: the bytes are the every-partition fan-out's and the
//      pre-x47 path's, and a list whose only unsettled names are ones no card carries is ONE round.
//
// Opt-in, because it loads every partition of the corpus:
//
//   SYLVAN_REAL_DIFFERENTIAL=1 bun test tests/engine/collection-locate-real.test.ts
//
// with STORE_BUILD_DIR pointing at a store build (default: this checkout's store-build/).

import { describe, expect, spyOn, test } from "bun:test";
import { collectionPacketRanks } from "../../src/engine/collection-batch";
import { PartitionedEngine } from "../../src/engine/partitioned-engine";
import {
	buildRoutingFilter,
	nameKey,
	ROUTING_FEATURE_NAME_KEYS,
	ROUTING_FEATURE_NAME_TIERS,
	RoutingFilter,
} from "../../src/engine/routing-filter";
import { foldAccents } from "../../src/parser/pystr";
import { makeCtx, testDispatch } from "../routes/harness";
import {
	loadRealStore,
	type RealPartitionOptions,
	type RealStore,
	realCollectionPacket,
	realExactRank,
	realNameHolders,
	realPartition,
	realStoreDir,
	realStoreReadable,
} from "./real-partitions";

const foldedOf = (name: string) => foldAccents(name.trim().toLowerCase());

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Every card's printed name, per partition, off the engine's own name records. */
function cardNames(store: RealStore): string[] {
	const decoder = new TextDecoder();
	const names = new Set<string>();
	for (const engine of store.engines) {
		const tsv = decoder.decode(engine.use((g) => g.store_name_records_tsv()));
		for (const line of tsv.split("\n")) {
			const printed = line.split("\t")[2];
			if (printed) names.add(printed);
		}
	}
	return [...names].sort();
}

/** A name with one interior letter dropped — what a deck list's typo looks like. */
const misspelt = (name: string) =>
	`${name.slice(0, Math.floor(name.length / 2))}${name.slice(Math.floor(name.length / 2) + 1)}`;

/** Which partitions rank each name as a collection identifier, by asking every one of them. */
function rankedPartitions(store: RealStore, foldeds: string[], setCode = ""): number[][] {
	const ranked: number[][] = foldeds.map(() => []);
	const names = foldeds.map((folded) => ({ folded, setCode }));
	for (let p = 0; p < store.n; p++) {
		const { ranks } = collectionPacketRanks(
			realCollectionPacket(store, p, { keys: [], trees: [], names }, "https://api.scryfall.com"),
		);
		for (const [i, rank] of ranks.entries()) if (rank !== null) ranked[i]?.push(p);
	}
	return ranked;
}

/** The names several cards share that the engine's ranking was measured on (card_engine `exact_name_rank`). */
const SHARED = [
	"Lightning Bolt",
	"Brainstorm",
	"Ancestral Recall",
	"Delver of Secrets",
	"Insectile Aberration",
	"Chaos",
	"Day",
	"Night",
	"Blood",
	"Armed",
	"Illusion",
	"Elemental",
	"Treasure",
	"Fire",
	"Start",
	"Earth Rumble",
	"Solitude",
];

describe.skipIf(!realStoreReadable)(`a collection name its route does not settle, on ${realStoreDir}`, () => {
	test("the names index lists every partition a collection name is ranked in", () => {
		const store = loadRealStore();
		const all = cardNames(store);
		const needles = new Set<string>(SHARED.map(foldedOf));
		for (const [i, name] of all.entries()) {
			const folded = foldedOf(name);
			const halves = folded.split(" // ");
			// Every two-part name's halves (the face keys, where cards share names most), every 5th
			// whole name, and a misspelling of every 9th.
			if (halves.length === 2) for (const half of halves) needles.add(half);
			if (i % 5 === 0) needles.add(folded);
			if (i % 9 === 0 && folded.length > 4) needles.add(misspelt(folded));
		}
		const list = [...needles];
		let exact = 0;
		let wider = 0;
		let nowhere = 0;
		let shared = 0;
		const started = performance.now();
		let indexMs = 0;
		for (let from = 0; from < list.length; from += 500) {
			const chunk = list.slice(from, from + 500);
			const ranked = rankedPartitions(store, chunk);
			for (const [i, folded] of chunk.entries()) {
				const t0 = performance.now();
				const holders = realNameHolders(store, folded);
				indexMs += performance.now() - t0;
				const got = ranked[i] as number[];
				expect({ folded, unlisted: got.filter((p) => !holders.includes(p)) }).toEqual({ folded, unlisted: [] });
				if (holders.length === 0) nowhere++;
				if (got.length > 1) shared++;
				if (holders.length === got.length) exact++;
				else wider++;
			}
		}
		// A set only removes printings: the same list covers `{name, set}`.
		const inSet = rankedPartitions(store, SHARED.map(foldedOf), "m11");
		for (const [i, name] of SHARED.entries()) {
			const holders = realNameHolders(store, foldedOf(name));
			expect((inSet[i] as number[]).filter((p) => !holders.includes(p))).toEqual([]);
		}
		console.log(
			`names index vs collection ranks: ${list.length} names over ${store.n} partitions in ${((performance.now() - started) / 1000).toFixed(1)}s; ` +
				`${exact} lists exact, ${wider} wider (a flavor key, a joined name), ${nowhere} held nowhere, ${shared} ranked in several; ` +
				`index lookup ${(indexMs / list.length).toFixed(3)}ms a name`,
		);
		expect(list.length).toBeGreaterThan(5000);
		expect(nowhere).toBeGreaterThan(1000);
		expect(shared).toBeGreaterThan(50);
	}, 900_000);

	test("production-shaped deck lists answer the fan-out's bytes, and a misspelt name ends in round one", async () => {
		const store = loadRealStore();
		const all = cardNames(store).filter((name) => !name.includes(" // "));
		const random = rng(47);
		const pick = () => all[Math.floor(random() * all.length)] as string;
		// A misspelling that is no card's name.
		const typo = () => {
			for (;;) {
				const name = misspelt(pick());
				if (name.length > 3 && realNameHolders(store, foldedOf(name)).length === 0) return name;
			}
		};

		// (names, misspelt, shared) per list — the day's rounds=2 lines, and the lists that must not move.
		const shapes: [number, number, number][] = [
			[1, 1, 0],
			[2, 2, 0],
			[2, 1, 0],
			[5, 1, 0],
			[6, 1, 0],
			[17, 1, 0],
			[27, 10, 0],
			[35, 8, 0],
			[47, 1, 0],
			[60, 1, 0],
			[60, 2, 0],
			[60, 8, 0],
			[72, 1, 0],
			[72, 4, 0],
			[72, 6, 0],
			[75, 1, 0],
			[75, 3, 0],
			[72, 0, 0],
			[72, 0, 3],
			[72, 1, 4],
			[12, 0, 12],
			[60, 0, 0],
		];
		const lists = shapes.map(([n, typos, shared]) => {
			const names: string[] = [];
			for (let i = 0; i < typos; i++) names.push(typo());
			for (let i = 0; i < shared; i++) names.push(SHARED[Math.floor(random() * SHARED.length)] as string);
			while (names.length < n) names.push(pick());
			// Shuffled: the response's `data` and `not_found` orders are the list's.
			for (let i = names.length - 1; i > 0; i--) {
				const j = Math.floor(random() * (i + 1));
				[names[i], names[j]] = [names[j] as string, names[i] as string];
			}
			return { names, typos, shared };
		});

		// The routing filter the builders write for these names, from the partitions' own word on
		// them: `ns:` where a partition answers the name served, and an extra's tier elsewhere — `nw:`
		// whole, `nm:` face, `nf:` flavor, `na:` an art series (held, never ranked by `exact=`).
		const entries: { key: string; partition: number }[] = [];
		const keyed = new Set<string>();
		for (const name of lists.flatMap((l) => l.names)) {
			const folded = foldedOf(name);
			const key = nameKey(folded);
			if (key === null || keyed.has(key)) continue;
			keyed.add(key);
			for (const p of realNameHolders(store, folded)) {
				const rank = realExactRank(store, p, folded);
				const prefix =
					rank === null ? "na" : rank[2] === 1 ? "ns" : (["na", "nf", "nm", "nw"][Number(rank[0])] as string);
				entries.push({ key: `${prefix}:${key.slice("nm:".length)}`, partition: p });
			}
		}
		const identity = { builtAt: store.builtAt, partitionCount: store.n, partitionHash: "fnv1a64/oracle_id/v1" };
		const parsed = RoutingFilter.parse(
			buildRoutingFilter(entries, identity, ROUTING_FEATURE_NAME_KEYS | ROUTING_FEATURE_NAME_TIERS),
			identity,
		);
		if ("reason" in parsed) throw new Error(parsed.reason);
		const routing = parsed.filter;

		const post = async (
			identifiers: unknown[],
			query: string,
			filter: RoutingFilter | null,
			withNames: boolean,
			options: RealPartitionOptions = {},
		) => {
			const calls: string[] = [];
			const manifest = store.manifest(withNames);
			const engine = new PartitionedEngine(
				(p) => realPartition(store, p, calls, options),
				manifest,
				async () => manifest,
				filter,
			);
			const url = `https://sylvan-librarian.com/cards/collection${query}`;
			const request = new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ identifiers }),
			});
			const res = await testDispatch(makeCtx({ engine, request }), `/cards/collection${query}`, "POST");
			return {
				status: res.status,
				body: await res.text(),
				calls: calls.filter((c) => c.startsWith("batch:")).length,
				rounds: engine.collectionRounds,
				repair: engine.collectionRepair,
			};
		};

		const log = spyOn(console, "log").mockImplementation(() => {});
		const lines: string[] = [];
		let compared = 0;
		let oneRound = 0;
		const total = { callsBefore: 0, callsAfter: 0, twoRoundsBefore: 0, twoRoundsAfter: 0 };
		try {
			for (const [at, list] of lists.entries()) {
				const variants: [string, unknown[], string][] = [
					["plain", list.names.map((name) => ({ name })), ""],
					// A set on every third identifier, and a batch scope: both only remove printings.
					["set", list.names.map((name, i) => (i % 3 === 0 ? { name, set: "m11" } : { name })), ""],
					["q", list.names.map((name) => ({ name })), "?q=t%3Acreature"],
				];
				for (const [variant, identifiers, query] of variants) {
					const fanOut = await post(identifiers, query, null, false);
					const before = await post(identifiers, query, routing, true, { beforeX47: true });
					const now = await post(identifiers, query, routing, true);
					expect(fanOut.status).toBe(200);
					expect({ at, variant, status: now.status, body: now.body }).toEqual({
						at,
						variant,
						status: fanOut.status,
						body: fanOut.body,
					});
					expect({ at, variant, status: before.status, body: before.body }).toEqual({
						at,
						variant,
						status: fanOut.status,
						body: fanOut.body,
					});
					expect(now.calls).toBeLessThanOrEqual(before.calls);
					expect(now.rounds).toBeLessThanOrEqual(before.rounds);
					// A list every name of which at most ONE partition holds is one round: a misspelt name
					// is held nowhere, and nothing can outrank a sole holder's answer or stand in for its
					// miss. (A name two partitions hold may still need the second — its extra — asked.)
					if (list.names.every((name) => realNameHolders(store, foldedOf(name)).length <= 1)) {
						expect({ at, variant, rounds: now.rounds }).toEqual({ at, variant, rounds: 1 });
						oneRound++;
					}
					compared++;
					total.callsBefore += before.calls;
					total.callsAfter += now.calls;
					if (before.rounds > 1) total.twoRoundsBefore++;
					if (now.rounds > 1) total.twoRoundsAfter++;
					if (variant === "plain") {
						const found = (JSON.parse(now.body) as { data: unknown[] }).data.length;
						lines.push(
							`  n=${list.names.length} misspelt=${list.typos} shared=${list.shared} found=${found}: ` +
								`calls ${before.calls} -> ${now.calls}, rounds ${before.rounds} -> ${now.rounds}` +
								`${now.repair === null ? "" : ` (repair=${now.repair})`}`,
						);
					}
				}
			}
		} finally {
			log.mockRestore();
		}
		console.log(
			`collection on the real corpus: ${compared} responses equal the ${store.n}-partition fan-out's; ` +
				`${total.callsBefore} calls before x47, ${total.callsAfter} after; two-round batches ${total.twoRoundsBefore} -> ${total.twoRoundsAfter}\n` +
				lines.join("\n"),
		);
		expect(total.callsAfter).toBeLessThan(total.callsBefore);
		expect(oneRound).toBeGreaterThan(10);
	}, 900_000);
});
