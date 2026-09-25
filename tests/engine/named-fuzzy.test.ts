// `/cards/named?fuzzy=` in one round (backlog n7): the partitioned engine's bundle path must answer
// exactly what the three stages answer asked one after another — the same status and the same
// bytes — while asking each partition once.
//
// The stages are replayed from per-partition answers: recorded off the real ten-partition store
// (named-fuzzy-recorded.json), and hand-built for the merge's corner cases. A partition's bundle
// is built from the SAME answers by `bundleFromStages`, the skip rules engine/wasm's
// `named_fuzzy_bundle` applies — and that export is pinned byte-for-byte against the separate
// exports by its own Rust test (`the_bundle_is_the_separate_exports_byte_for_byte`), so the two
// tests together cover the path from the engine to the response.

import { describe, expect, test } from "bun:test";
import { bundleFromStages, type NamedFuzzyStages, resolveNamedFuzzyStaged } from "../../src/engine/named-fuzzy";
import { mergeNamedFuzzyBundles, nameReplySettles, PartitionedEngine } from "../../src/engine/partitioned-engine";
import type { RemoteEngine } from "../../src/engine/remote-engine";
import {
	buildRoutingFilter,
	type NameHint,
	nameKey,
	ROUTING_FEATURE_NAME_KEYS,
	RoutingFilter,
} from "../../src/engine/routing-filter";
import type { Engine, FuzzyCandidateWire, ScryfallFuzzyResult, StoreManifest } from "../../src/engine/types";
import { foldAccents } from "../../src/parser/pystr";
import { makeCtx, testDispatch } from "../routes/harness";
import recorded from "./named-fuzzy-recorded.json";

type Card = Record<string, unknown>;

/** One partition's answer to each stage, for one needle. */
interface Stages {
	rank: number[] | null;
	present: boolean;
	exact: Card | null;
	candidates: FuzzyCandidateWire[];
	fuzzy: ScryfallFuzzyResult;
	contained: Card[];
}

const MISS: Stages = {
	rank: null,
	present: false,
	exact: null,
	candidates: [],
	fuzzy: { status: "miss", card: null },
	contained: [],
};

function stagesOf(s: Stages): NamedFuzzyStages {
	return {
		scryfallExactNameProbe: async () => ({ rank: s.rank, present: s.present, card: s.exact }),
		fuzzyCandidates: async () => s.candidates,
		scryfallFuzzyName: async () => s.fuzzy,
		scryfallNamesContaining: async () => s.contained,
	};
}

/** A partition client answering from `s`, counting every call in `calls`. */
function fakePartition(p: number, s: Stages, calls: string[]) {
	const stages = stagesOf(s);
	const counted =
		<A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>) =>
		(...a: A) => {
			calls.push(`${name}:${p}`);
			return f(...a);
		};
	return {
		scryfallExactNameProbe: counted("probe", stages.scryfallExactNameProbe),
		scryfallExactNameRank: counted("rank", async () => s.rank),
		scryfallExactName: counted("exact", async () => s.exact),
		fuzzyCandidates: counted("candidates", stages.fuzzyCandidates),
		scryfallFuzzyName: counted("fuzzy", stages.scryfallFuzzyName),
		scryfallNamesContaining: counted("contained", stages.scryfallNamesContaining),
		scryfallNamedFuzzyBundle: counted(
			"bundle",
			(folded: string, setCode: string, words: string[], limit: number, baseUrl: string) =>
				bundleFromStages(stages, folded, setCode, words, limit, baseUrl),
		),
	} as unknown as RemoteEngine;
}

function manifestOf(n: number): StoreManifest {
	return {
		store_key: "card-store-v1-100.store",
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

/** A name filter that answers `hint` for `folded`'s key. */
function filterFor(folded: string, hint: NameHint, n: number): RoutingFilter {
	const collated = (nameKey(folded) as string).slice("nm:".length);
	const entries =
		"sole" in hint
			? [{ key: `ns:${collated}`, partition: hint.sole }]
			: [
					{ key: `ns:${collated}`, partition: hint.served },
					{ key: `nm:${collated}`, partition: (hint.served + 1) % n },
				];
	const identity = { builtAt: "100", partitionCount: n, partitionHash: "fnv1a64/oracle_id/v1" };
	const parsed = RoutingFilter.parse(buildRoutingFilter(entries, identity, ROUTING_FEATURE_NAME_KEYS), identity);
	if ("reason" in parsed) throw new Error(parsed.reason);
	expect(parsed.filter.lookupName(nameKey(folded) as string)).toEqual(hint);
	return parsed.filter;
}

function engines(partitions: Stages[], routing: RoutingFilter | null = null) {
	const n = partitions.length;
	const manifest = manifestOf(n);
	const make = (calls: string[]) =>
		new PartitionedEngine(
			(p) => fakePartition(p, partitions[p] ?? MISS, calls),
			manifest,
			async () => manifest,
			routing,
		);
	const newCalls: string[] = [];
	const oldCalls: string[] = [];
	const bundled = make(newCalls);
	// The same engine with the one-round method hidden: the route then asks the three stages.
	const staged = Object.assign(make(oldCalls), { scryfallNamedFuzzy: undefined }) as Engine;
	return { bundled, staged, newCalls, oldCalls };
}

async function respond(engine: Engine, fuzzy: string, set: string) {
	const qs = new URLSearchParams({ fuzzy, ...(set ? { set } : {}) });
	const res = await testDispatch(makeCtx({ engine }), `/cards/named?${qs}`);
	return { status: res.status, body: await res.text() };
}

/** The route's responses both ways, which must be identical; the bundle path's calls. */
async function both(partitions: Stages[], fuzzy: string, set = "", routing: RoutingFilter | null = null) {
	const e = engines(partitions, routing);
	const bundled = await respond(e.bundled, fuzzy, set);
	const staged = await respond(e.staged, fuzzy, set);
	expect(bundled).toEqual(staged);
	expect(e.newCalls.every((c) => c.startsWith("bundle:"))).toBe(true);
	return { ...bundled, calls: e.newCalls, oldCalls: e.oldCalls, json: JSON.parse(bundled.body) };
}

const cand = (score: number, oracleId: string, foldedName: string, served = true): FuzzyCandidateWire => ({
	score,
	served,
	oracleId,
	vpid: 0,
	foldedName,
});
const at = (n: number, answers: Record<number, Partial<Stages>>): Stages[] =>
	Array.from({ length: n }, (_, p) => ({ ...MISS, ...(answers[p] ?? {}) }));
const named = (name: string): Card => ({ object: "card", name });

describe("the replay of the real ten-partition store", () => {
	const cases = recorded.cases as unknown as {
		label: string;
		fuzzy: string;
		set: string;
		hint: NameHint | null;
		expect: string;
		partitions: Stages[];
	}[];

	test("the recording covers every way the route answers", () => {
		const kinds = new Set(cases.map((c) => c.expect.split(":")[0]));
		expect([...kinds].sort()).toEqual(["ambiguous", "card", "miss"]);
		expect(cases.every((c) => c.partitions.length === 10)).toBe(true);
	});

	for (const c of cases) {
		test(`${c.label}: fuzzy=${c.fuzzy}${c.set ? ` set=${c.set}` : ""} — one round of N, the staged answer`, async () => {
			const got = await both(c.partitions, c.fuzzy, c.set);
			expect(got.calls.length).toBe(10);
			const summary =
				got.status === 200 ? `card:${got.json.name}` : got.json.type === "ambiguous" ? "ambiguous" : "miss";
			expect(summary).toBe(c.expect);
		});

		if (c.hint !== null) {
			const hint = c.hint;
			test(`${c.label}: routed by the name filter, the same answer`, async () => {
				const folded = foldAccents(c.fuzzy.trim().toLowerCase());
				const got = await both(c.partitions, c.fuzzy, c.set, filterFor(folded, hint, 10));
				// The routed partition first: an exact name it settles is ONE call, anything else all ten.
				const first = "sole" in hint ? hint.sole : hint.served;
				const reply = c.partitions[first] as Stages;
				const settled = reply.rank !== null && nameReplySettles(hint, reply.rank, reply.present);
				expect(got.calls[0]).toBe(`bundle:${first}`);
				expect(got.calls.length).toBe(settled ? 1 : 10);
			});
		}
	}
});

describe("the merge's corner cases", () => {
	const N = 4;

	test("exact: the best rank wins, a tie keeps the lowest partition, and nothing else is computed", async () => {
		const face = { rank: [1, 1, 9.9], present: true, exact: named("Emeritus of Conflict // Lightning Bolt") };
		const whole = { rank: [1, 2, 0.1], present: true, exact: named("Lightning Bolt") };
		expect((await both(at(N, { 1: face, 3: whole }), "Lightning Bolt")).json.name).toBe("Lightning Bolt");
		const lower = { rank: [1, 1, 0.5], present: true, exact: named("Lower") };
		const higher = { rank: [1, 1, 0.5], present: true, exact: named("Higher") };
		const tie = await both(at(N, { 1: lower, 3: higher }), "tie");
		expect(tie.json.name).toBe("Lower");
		expect(tie.calls.length).toBe(N);
		// The staged path: N probes and nothing after — the bundle path is the same count, one round.
		expect(tie.oldCalls.length).toBe(N);
	});

	test("typo: a local hit in two partitions is raced globally, and the winner's own card answers", async () => {
		const got = await both(
			at(N, {
				0: { candidates: [cand(0.7, "o-0", "shack")], fuzzy: { status: "hit", card: named("Shack") } },
				2: { candidates: [cand(0.9, "o-2", "shock")], fuzzy: { status: "hit", card: named("Shock") } },
			}),
			"shok",
		);
		expect(got.json.name).toBe("Shock");
		expect(got.calls.length).toBe(N);
		// Staged: N probes, N candidate lists, the winner's materialize.
		expect(got.oldCalls.length).toBe(2 * N + 1);
	});

	test("typo: near-tied distinct cards in different partitions are ambiguous, though each is a local hit", async () => {
		const got = await both(
			at(N, {
				1: { candidates: [cand(0.9, "o-1", "shock")], fuzzy: { status: "hit", card: named("Shock") } },
				3: { candidates: [cand(0.8995, "o-3", "sock")], fuzzy: { status: "hit", card: named("Sock") } },
			}),
			"shok",
		);
		expect(got.status).toBe(404);
		expect(got.json.type).toBe("ambiguous");
	});

	test("typo: the winner's own race being ambiguous is the answer, as its materialize call said", async () => {
		const got = await both(
			at(N, { 2: { candidates: [cand(0.9, "o-2", "shock")], fuzzy: { status: "ambiguous", card: null } } }),
			"shok",
		);
		expect(got.json.type).toBe("ambiguous");
	});

	test("containment: two distinct names are ambiguous; one is the card", async () => {
		const two = await both(
			at(N, { 0: { contained: [named("Fire Bolt Two")] }, 2: { contained: [named("Bolt of Fire")] } }),
			"fire bolt",
		);
		expect(two.json.type).toBe("ambiguous");
		// Staged: N probes, N candidate lists, N containment scans over three waits; bundled: N in one.
		expect(two.oldCalls.length).toBe(3 * N);
		expect(two.calls.length).toBe(N);
		const one = await both(at(N, { 3: { contained: [named("Bolt of Fire")] } }), "bolt of");
		expect(one.json.name).toBe("Bolt of Fire");
	});

	test("containment: a name that IS the query wins across partitions (blitzschlag)", async () => {
		const got = await both(
			at(N, {
				0: { contained: [{ object: "card", name: "Storm Surge", printed_name: "Blitzschlagsturm" }] },
				2: { contained: [{ object: "card", name: "Lightning Bolt", printed_name: "Blitzschlag" }] },
			}),
			"blitzschlag",
		);
		expect(got.json.name).toBe("Lightning Bolt");
	});

	// ...within its tier: an English name that merely CONTAINS the query outranks a foreign printed
	// name that IS it. api.scryfall.com 2026-09-25: `fuzzy=inganno` is Wedding Announcement, not
	// Guile (Italian "Inganno"); likewise `verfall`, `velocita`, `disputa`, `nautilo`, `fusione`.
	test("containment: English containment outranks another partition's whole printed name", async () => {
		const got = await both(
			at(N, {
				0: { contained: [named("Wedding Announcement // Wedding Festivity")] },
				2: { contained: [{ object: "card", name: "Guile", printed_name: "Inganno" }] },
			}),
			"inganno",
		);
		expect(got.json.name).toBe("Wedding Announcement // Wedding Festivity");
	});

	// Each partition answers its printed-name matches only when no oracle or flavor name of its own
	// carries the words; the merge applies the same tier across partitions. api.scryfall.com
	// 2026-09-25: `fuzzy=austere` is Austere Command, not ambiguous with Dour Port-Mage's French name.
	test("containment: an English name outranks another partition's printed name", async () => {
		const french = { object: "card", name: "Dour Port-Mage", printed_name: "Portmage austère" };
		const got = await both(
			at(N, { 0: { contained: [french] }, 3: { contained: [named("Austere Command")] } }),
			"austere",
		);
		expect(got.json.name).toBe("Austere Command");
		// A flavor name is English: it stays in the first tier, so two cards there are still ambiguous.
		const flavored = { object: "card", name: "Walking Ballista", flavor_name: "Assaultron Invader" };
		const two = await both(
			at(N, { 1: { contained: [flavored] }, 2: { contained: [named("Assaultron Dominator")] } }),
			"assaultron",
		);
		expect(two.json.type).toBe("ambiguous");
		// A flavor name on the FACES is the faces' names joined, and English too. api.scryfall.com
		// 2026-09-25: `fuzzy=lord of bats` is Voldaren Bloodcaster vow/338 ("Dracula, Lord of Blood" //
		// "Dracula, Lord of Bats"); a foreign printed name elsewhere carrying the words is no rival.
		const voldaren = {
			object: "card",
			name: "Voldaren Bloodcaster // Bloodbat Summoner",
			card_faces: [
				{ object: "card_face", name: "Voldaren Bloodcaster", flavor_name: "Dracula, Lord of Blood" },
				{ object: "card_face", name: "Bloodbat Summoner", flavor_name: "Dracula, Lord of Bats" },
			],
		};
		const foreignBats = { object: "card", name: "Some Card", printed_name: "Lord of Bats" };
		const bats = await both(at(N, { 1: { contained: [voldaren] }, 3: { contained: [foreignBats] } }), "lord of bats");
		expect(bats.json.name).toBe("Voldaren Bloodcaster // Bloodbat Summoner");
		// Printed names alone still answer: nothing English carries `goad`.
		const ego = { object: "card", name: "Unmoored Ego", printed_name: "Ego à Deriva" };
		expect((await both(at(N, { 2: { contained: [ego] } }), "red goad")).json.name).toBe("Unmoored Ego");
	});

	test("a complete miss is Scryfall's 404 with the name quoted", async () => {
		const got = await both(at(N, {}), "zzzz qqqq");
		expect(got.status).toBe(404);
		expect(got.json.details).toBe("No cards found matching “zzzz qqqq”");
		expect(got.calls.length).toBe(N);
	});

	test("a routed exact name its partition settles is ONE call", async () => {
		const routing = filterFor("lightning bolt", { sole: 2 }, N);
		const hit = { rank: [1, 2, 0], present: true, exact: named("Lightning Bolt") };
		const got = await both(at(N, { 2: hit }), "Lightning Bolt", "", routing);
		expect(got.calls).toEqual(["bundle:2"]);
		expect(got.oldCalls).toEqual(["probe:2"]);
	});

	test("a routed set-restricted MISS asks the rest once, and their typo stage answers", async () => {
		// Partition 2 holds the name but not in this set: the exact stage is settled as a miss, and
		// the typo stage — which ignores the set — finds the card there.
		const routing = filterFor("lightning bolt", { sole: 2 }, N);
		const held = {
			present: true,
			candidates: [cand(1, "o-2", "lightning bolt")],
			fuzzy: { status: "hit" as const, card: named("Lightning Bolt") },
		};
		const got = await both(at(N, { 2: held }), "Lightning Bolt", "m19", routing);
		expect(got.json.name).toBe("Lightning Bolt");
		expect(got.calls[0]).toBe("bundle:2");
		expect(got.calls.length).toBe(N);
	});

	test("a garbage hint costs the rest one more round, never the answer", async () => {
		const routing = filterFor("shok", { sole: 1 }, N);
		const got = await both(
			at(N, { 3: { candidates: [cand(0.9, "o-3", "shock")], fuzzy: { status: "hit", card: named("Shock") } } }),
			"shok",
			"",
			routing,
		);
		expect(got.json.name).toBe("Shock");
		expect(got.calls[0]).toBe("bundle:1");
		expect(got.calls.length).toBe(N);
	});

	test("replies the merge cannot read fall back to the stages", async () => {
		// A race winner whose local race is a miss cannot happen (a candidate IS a local race entry),
		// and the merge refuses rather than guessing; the engine then asks the stages.
		const bundle = (fuzzy: ScryfallFuzzyResult, candidates: FuzzyCandidateWire[]) => ({
			exact: { rank: null, present: false, card: null },
			fuzzy,
			candidates,
			contained: null,
		});
		expect(
			mergeNamedFuzzyBundles([bundle({ status: "miss", card: null }, [cand(0.9, "o", "x")])], ["x"], 2),
		).toBeNull();
		// A needle an exact-settled partition says nobody holds, but another ranks: refused too.
		const ranked = {
			...bundle({ status: "miss", card: null }, []),
			exact: { rank: [1, 2, 0], present: true, card: null },
		};
		expect(mergeNamedFuzzyBundles([ranked], ["x"], 2, true)).toBeNull();

		const partitions = at(N, { 1: { candidates: [cand(0.9, "o-1", "shock")], fuzzy: { status: "miss", card: null } } });
		const e = engines(partitions);
		expect(await e.bundled.scryfallNamedFuzzy?.("shok", ["shok"], "", "https://x")).toEqual(
			await resolveNamedFuzzyStaged(e.staged, "shok", ["shok"], "", "https://x"),
		);
	});
});
