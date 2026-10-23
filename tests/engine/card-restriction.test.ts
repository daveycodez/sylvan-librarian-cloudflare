// Backlog y1: the card restriction a filter tree carries (src/engine/card-restriction.ts).
//
// Two halves. The RULE, case by case — what restricts, what does not, and why. Then SOUNDNESS as a
// property: over a random corpus whose name hints obey the two invariants the real corpus is held
// to (engine/builder/tests/name_routes.rs `list_restriction_keys_cover_every_bang_match`) — and
// whose keys that no card has read ANY hint at all, like a filter's garbage byte — no row matching a
// random tree ever lives outside the partitions its restriction names.

import { describe, expect, test } from "bun:test";
import { cardRestrictionOf } from "../../src/engine/card-restriction";
import { partitionOfOracleId } from "../../src/engine/partition";
import { type NameHint, type NamePlacement, servedPairAt } from "../../src/engine/routing-filter";

// The CPU-bound tests in this file carry an explicit 120 s timeout (the `120_000` closing them).
// bun's default is 5 s, which they pass in under a second on a quiet machine and failed on a
// busy one with nothing wrong: 2026-10-04, four suites at once beside 300 busy loops, the
// slowest took 10.3 s. No assertion reads the clock; a hang still fails, later.

const N = 10;

type Tree = Record<string, unknown>;
const bang = (value: string): Tree => ({ node_type: "ExactNameNode", kwargs: { value } });
const oracle = (value: string, op = ":"): Tree => ({
	node_type: "CardBinaryOperatorNode",
	kwargs: {
		lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "oracle_id" } },
		op,
		rhs: { node_type: "StringValueNode", kwargs: { value } },
	},
});
const typed = (value: string): Tree => ({
	node_type: "CardBinaryOperatorNode",
	kwargs: {
		lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_types" } },
		op: ":",
		rhs: [value],
	},
});
const isTag = (tag: string): Tree => ({
	node_type: "CardBinaryOperatorNode",
	kwargs: {
		lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_is_tags", original_attribute: "is" } },
		op: ":",
		rhs: [tag],
	},
});
const and = (...operands: Tree[]): Tree => ({ node_type: "AndNode", kwargs: { operands } });
const or = (...operands: Tree[]): Tree => ({ node_type: "OrNode", kwargs: { operands } });
const not = (operand: Tree): Tree => ({ node_type: "NotNode", kwargs: { operand } });
/** The router's extras gate (extras-gate.ts `withoutIsTags`): the user's tree ANDed with `NOT is:extra`. */
const gated = (tree: Tree): Tree => and(tree, not(isTag("extra")), not(isTag("variation")));

const HINTS: Record<string, NamePlacement | null> = {
	bolt: { sole: 2 },
	counterspell: { sole: 7 },
	brainstorm: { served: 4, rival: 0 },
	// The card in 3, Yavimaya Bloomsage // Channel in 9: served in exactly two partitions.
	channel: { servedPair: [3, 9] },
	fire: null,
	island: { sole: 2 },
};
const hint = (collated: string) => HINTS[collated] ?? null;
const at = (tree: Tree) => cardRestrictionOf(JSON.stringify(tree), N, hint, false);

const IDS = [
	"aa686c34-cf28-4d4a-bcef-5a34cccdbf87",
	"4457ed35-7c10-48c8-9776-456485fdf070",
	"da5cd3b6-7a41-49a5-9b4f-ec0e2e4fd7ff",
];

describe("the restriction rule", () => {
	test("an OR of exact names is the union of their partitions", () => {
		expect(at(or(bang("bolt"), bang("counterspell"), bang("island")))).toEqual({
			partitions: [2, 7],
			members: 3,
			names: 3,
			tags: 0,
		});
	});

	test("ANDed with any other filter, at any depth of conjunction", () => {
		const list = or(bang("bolt"), bang("counterspell"));
		expect(at(and(typed("creature"), list))?.partitions).toEqual([2, 7]);
		expect(at(and(typed("creature"), and(isTag("foil"), list)))?.partitions).toEqual([2, 7]);
		expect(at(gated(and(typed("creature"), list)))?.partitions).toEqual([2, 7]);
	});

	test("an AND of two lists is their intersection — and may be empty", () => {
		expect(at(and(or(bang("bolt"), bang("counterspell")), or(bang("island"), bang("bolt"))))?.partitions).toEqual([2]);
		expect(at(and(bang("bolt"), bang("counterspell")))).toEqual({ partitions: [], members: 2, names: 2, tags: 0 });
	});

	test("oracle ids, alone, mixed with names, and upper-cased", () => {
		const ps = IDS.map((id) => partitionOfOracleId(id, N));
		expect(at(or(...IDS.map((id) => oracle(id))))?.partitions).toEqual([...new Set(ps)].sort((a, b) => a - b));
		expect(at(or(oracle(IDS[0] as string), bang("bolt")))).toEqual({
			partitions: [...new Set([ps[0] as number, 2])].sort((a, b) => a - b),
			members: 2,
			names: 1,
			tags: 0,
		});
		expect(at(oracle((IDS[1] as string).toUpperCase(), "="))?.partitions).toEqual([ps[1] as number]);
	});

	test("an OR mixing a list with an unrestricted term restricts nothing", () => {
		expect(at(or(bang("bolt"), typed("elf")))).toBeNull();
		expect(at(and(typed("creature"), or(bang("bolt"), typed("elf"))))).toBeNull();
	});

	test("NOT, other operators and other leaves restrict nothing", () => {
		expect(at(not(bang("bolt")))).toBeNull();
		expect(at(and(typed("creature"), not(or(bang("bolt"), bang("counterspell")))))).toBeNull();
		expect(at(oracle(IDS[0] as string, "!="))).toBeNull();
		expect(at(oracle("not-a-uuid"))).toBeNull();
		expect(at(typed("creature"))).toBeNull();
		expect(at({ node_type: "TrueNode", kwargs: {} })).toBeNull();
		expect(at(bang(""))).toBeNull();
	});

	test("one member the filter cannot place makes its OR unrestricted", () => {
		expect(at(or(bang("bolt"), bang("fire")))).toBeNull();
		expect(at(or(bang("bolt"), bang("notakey")))).toBeNull();
		// ...but an AND keeps what its other operands know.
		expect(at(and(bang("fire"), bang("bolt")))?.partitions).toEqual([2]);
	});

	test("a SERVED hint places a name only under the router's extras gate at the ROOT", () => {
		const list = or(bang("bolt"), bang("brainstorm"));
		expect(at(list)).toBeNull();
		expect(at(gated(list))?.partitions).toEqual([2, 4]);
		// The gate nested in the root's conjunction still covers every result row.
		expect(at(and(and(list, not(isTag("extra"))), typed("instant")))?.partitions).toEqual([2, 4]);
		// Anywhere else it does not: under an OR, or excluding another tag.
		expect(at(or(and(list, not(isTag("extra"))), and(list, typed("elf"))))).toBeNull();
		expect(at(and(list, not(isTag("variation"))))).toBeNull();
		expect(at(and(list, isTag("extra")))).toBeNull();
	});

	test("a SERVED PAIR places a name in both partitions, under the same gate a served hint needs", () => {
		const list = or(bang("bolt"), bang("channel"));
		expect(at(list)).toBeNull();
		expect(at(gated(list))).toEqual({ partitions: [2, 3, 9], members: 2, names: 2, tags: 0 });
		expect(at(gated(bang("channel")))?.partitions).toEqual([3, 9]);
		// ANDed with a sole name: the intersection, which may be empty.
		expect(at(gated(and(bang("channel"), bang("bolt"))))?.partitions).toEqual([]);
		// Not under an OR of the gate, not excluding another tag, not on a widened query.
		expect(at(or(and(list, not(isTag("extra"))), and(list, typed("elf"))))).toBeNull();
		expect(at(and(list, not(isTag("variation"))))).toBeNull();
		expect(cardRestrictionOf(JSON.stringify(gated(list)), N, hint, true)).toBeNull();
		// A pair outside the filter's width is no placement.
		expect(cardRestrictionOf(JSON.stringify(gated(bang("x"))), N, () => ({ servedPair: [1, N] }), false)).toBeNull();
	});

	test("a WIDENED query trusts sole hints alone: include_multilingual, `lang:`, is:localizedname", () => {
		const list = gated(or(bang("bolt"), bang("brainstorm")));
		const sole = gated(or(bang("bolt"), bang("counterspell")));
		expect(cardRestrictionOf(JSON.stringify(list), N, hint, true)).toBeNull();
		expect(cardRestrictionOf(JSON.stringify(sole), N, hint, true)?.partitions).toEqual([2, 7]);
		const lang: Tree = {
			node_type: "CardBinaryOperatorNode",
			kwargs: {
				lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_lang" } },
				op: ":",
				rhs: { node_type: "StringValueNode", kwargs: { value: "ja" } },
			},
		};
		for (const widening of [lang, isTag("localizedname"), not(isTag("localizedname"))]) {
			expect(at(and(list, widening))).toBeNull();
			expect(at(and(sole, widening))?.partitions).toEqual([2, 7]);
		}
		// `is:flavorname` does NOT widen (measured 2026-10-04: 686 printings on api.scryfall.com of
		// the 742 rows of every language that carry one), so a served hint under it is still exact.
		expect(at(and(list, isTag("flavorname")))?.partitions).toEqual([2, 4]);
	});

	test("the whole corpus is no restriction; a tree that does not parse is none", () => {
		const hintAll = (c: string): NameHint | null => ({ sole: Number(c.slice(1)) });
		const every = or(...Array.from({ length: N }, (_, p) => bang(`p${p}`)));
		expect(cardRestrictionOf(JSON.stringify(every), N, hintAll, false)?.partitions.length).toBe(N);
		expect(cardRestrictionOf("{", N, hint, false)).toBeNull();
		// A hint out of range (a filter of another width) is no placement.
		expect(cardRestrictionOf(JSON.stringify(bang("x")), N, () => ({ sole: N }), false)).toBeNull();
	});
});

// ── oracle tags ─────────────────────────────────────────────────────────────

const otag = (slug: unknown, op = ":"): Tree => ({
	node_type: "CardBinaryOperatorNode",
	kwargs: {
		lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_oracle_tags", original_attribute: "otag" } },
		op,
		rhs: Array.isArray(slug) ? slug : [slug],
	},
});
/** A build's oracle-tags blob: `removal` everywhere but 5, `ramp` in 1 and 6, `synergy-sliver` in 8. */
const TAG_HOLDERS: Record<string, number[]> = {
	removal: [0, 1, 2, 3, 4, 6, 7, 8, 9],
	ramp: [1, 6],
	"synergy-sliver": [8],
};
const tagHolders = (slug: string) => TAG_HOLDERS[slug] ?? [];
const tagged = (tree: Tree, multilingual = false) =>
	cardRestrictionOf(JSON.stringify(tree), N, hint, multilingual, tagHolders);

describe("the restriction rule: oracle tags", () => {
	test("an `otag:` term is its tag's partitions, under every request flag", () => {
		expect(tagged(otag("ramp"))).toEqual({ partitions: [1, 6], members: 1, names: 0, tags: 1 });
		// No gate needed and none read: the blob covers every row class, so extras and widening do not matter.
		expect(tagged(gated(otag("ramp")))?.partitions).toEqual([1, 6]);
		expect(tagged(otag("ramp"), true)?.partitions).toEqual([1, 6]);
		expect(tagged(and(otag("ramp"), isTag("localizedname")))?.partitions).toEqual([1, 6]);
	});

	test("`=`, `>=` and `>` need the tag too; `<`, `<=` and `!=` do not, and restrict nothing", () => {
		for (const op of ["=", ">=", ">"]) expect(tagged(otag("ramp", op))?.partitions).toEqual([1, 6]);
		for (const op of ["<", "<=", "!="]) expect(tagged(otag("ramp", op))).toBeNull();
	});

	test("a tag no card carries is the empty set — a 404 any one partition of the build can answer", () => {
		expect(tagged(otag("synergy-nothing"))).toEqual({ partitions: [], members: 1, names: 0, tags: 1 });
		expect(tagged(or(otag("synergy-nothing"), otag("synergy-sliver")))?.partitions).toEqual([8]);
	});

	test("the algebra: AND intersects, OR unions, and an unrestricted operand absorbs the OR", () => {
		expect(tagged(and(otag("removal"), otag("ramp")))?.partitions).toEqual([1, 6]);
		expect(tagged(or(otag("ramp"), otag("synergy-sliver")))?.partitions).toEqual([1, 6, 8]);
		expect(tagged(and(typed("creature"), or(otag("ramp"), otag("synergy-sliver"))))?.partitions).toEqual([1, 6, 8]);
		expect(tagged(or(otag("ramp"), typed("elf")))).toBeNull();
		// With a list of names: `otag:ramp (!"bolt" or !"counterspell")` holds nothing — bolt is in 2.
		expect(tagged(and(otag("ramp"), or(bang("bolt"), bang("counterspell"))))).toEqual({
			partitions: [],
			members: 3,
			names: 2,
			tags: 1,
		});
		// `removal` is in nine of ten: still a restriction, the router asks those nine.
		expect(tagged(otag("removal"))?.partitions).toHaveLength(9);
	});

	test("a negated tag, a regex, a malformed value or no blob restricts nothing", () => {
		expect(tagged(not(otag("ramp")))).toBeNull();
		expect(tagged(and(typed("creature"), not(otag("ramp"))))).toBeNull();
		expect(tagged(otag({ node_type: "RegexValueNode", kwargs: { value: "^ram" } }))).toBeNull();
		expect(tagged(otag(["ramp", "removal"]))).toBeNull();
		expect(tagged(otag([7]))).toBeNull();
		expect(tagged(otag([]))).toBeNull();
		expect(at(otag("ramp"))).toBeNull();
		// A blob naming a partition past the modulus is not this build's: ask everyone.
		expect(cardRestrictionOf(JSON.stringify(otag("x")), N, hint, false, () => [N])).toBeNull();
	});
});

// ── soundness, as a property ────────────────────────────────────────────────

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

interface Row {
	partition: number;
	oracleId: string;
	/** The collated needles `!` matches this row by (its card's name, faces, flavor names). */
	names: string[];
	extra: boolean;
	/** A foreign-annex printing: searched only by a widened query, and its names keyed only as `all`. */
	foreign: boolean;
	type: string;
}

describe("soundness: no matching row lives outside the restriction", () => {
	test("20,000 random trees over a random corpus, under hints that obey the key invariants", () => {
		const random = rng(0x5e1);
		const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)] as T;
		const hex = (k: number) => Array.from({ length: k }, () => Math.floor(random() * 16).toString(16)).join("");
		const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
		const NAMES = Array.from({ length: 60 }, (_, i) => `name${i}`);
		const TYPES = ["creature", "instant", "land"];
		let restricted = 0;
		let narrowedMatches = 0;
		let pairNames = 0;

		for (let corpus = 0; corpus < 20; corpus++) {
			// Cards: each an oracle id and a partition by the modulus; its rows share its names, some extra.
			const rows: Row[] = [];
			const ids: string[] = [];
			for (let c = 0; c < 80; c++) {
				const oracleId = uuid();
				ids.push(oracleId);
				const partition = partitionOfOracleId(oracleId, N);
				const names = [pick(NAMES)];
				if (random() < 0.2) names.push(pick(NAMES)); // a face or a flavor name
				const type = pick(TYPES);
				const printings = 1 + Math.floor(random() * 3);
				for (let i = 0; i < printings; i++) {
					rows.push({ partition, oracleId, names, extra: random() < 0.3, foreign: false, type });
				}
				// A foreign printing that prints a name its card no longer has (Pradesh Gypsies), keyed
				// in its partition only by an extra's printing of it.
				if (random() < 0.1) {
					const old = [pick(NAMES)];
					rows.push({ partition, oracleId, names: [...names, ...old], extra: false, foreign: true, type });
					rows.push({ partition, oracleId, names: old, extra: true, foreign: false, type });
				}
			}
			// The filter's seal, from what each partition holds (all) and holds served (the canonical rows
			// that are not extras): invariants (a) and (b) hold by construction, and a foreign row's name
			// need not be keyed served. A name no card has reads garbage.
			const hints = new Map<string, NamePlacement | null>();
			for (const name of NAMES) {
				const all = new Set(rows.filter((r) => r.names.includes(name)).map((r) => r.partition));
				const served = new Set(
					rows.filter((r) => !r.extra && !r.foreign && r.names.includes(name)).map((r) => r.partition),
				);
				let h: NamePlacement | null;
				if (all.size === 0) {
					// Garbage reads ANY value, the served pairs' among them (routing-filter.ts lookupNamePlacement).
					const garbage = Math.floor(random() * 256);
					const pair = garbage >= 5 * N ? servedPairAt(garbage - 5 * N, N) : null;
					h =
						garbage < N
							? { sole: garbage }
							: garbage < 5 * N
								? { served: Math.floor((garbage - N) / 4) }
								: pair !== null
									? { servedPair: pair }
									: null;
				} else if (all.size === 1) h = { sole: [...all][0] as number };
				else if (served.size === 1) h = { served: [...served][0] as number, rival: 0 };
				else if (served.size === 2) {
					const [a, b] = [...served].sort((x, y) => x - y) as [number, number];
					h = { servedPair: [a, b] };
					pairNames++;
				} else h = null;
				hints.set(name, h);
			}

			type Node = Tree & { eval: (r: Row) => boolean };
			const gen = (depth: number): Node => {
				const roll = random();
				if (depth > 3 || roll < 0.35) {
					const leaf = random();
					if (leaf < 0.45) {
						const name = pick(NAMES);
						return { ...bang(name), eval: (r) => r.names.includes(name) };
					}
					if (leaf < 0.7) {
						const id = random() < 0.8 ? pick(ids) : uuid();
						return { ...oracle(id), eval: (r) => r.oracleId === id };
					}
					const type = pick(TYPES);
					return { ...typed(type), eval: (r) => r.type === type };
				}
				const k = 1 + Math.floor(random() * 5);
				const kids = Array.from({ length: k }, () => gen(depth + 1));
				if (roll < 0.6) return { ...and(...kids), eval: (r) => kids.every((c) => c.eval(r)) };
				if (roll < 0.9) return { ...or(...kids), eval: (r) => kids.some((c) => c.eval(r)) };
				const kid = kids[0] as Node;
				return { ...not(kid), eval: (r) => !kid.eval(r) };
			};
			// `eval` is a function, so JSON.stringify drops it and the tree is the wire tree.
			for (let q = 0; q < 1000; q++) {
				const tree = gen(0);
				const withGate = random() < 0.6;
				const multilingual = random() < 0.3;
				const wire = withGate ? gated(tree) : tree;
				const matches = rows.filter((r) => tree.eval(r) && (!withGate || !r.extra) && (multilingual || !r.foreign));
				const restriction = cardRestrictionOf(JSON.stringify(wire), N, (c) => hints.get(c) ?? null, multilingual);
				if (restriction === null) continue;
				restricted++;
				if (matches.length > 0 && restriction.partitions.length < N) narrowedMatches++;
				for (const r of matches) {
					if (!restriction.partitions.includes(r.partition)) {
						throw new Error(
							`${JSON.stringify(wire)} matches a row in partition ${r.partition}, restricted to ${restriction.partitions}`,
						);
					}
				}
			}
		}
		// The property is not vacuous: many trees restrict, and many of those still match rows.
		expect(restricted).toBeGreaterThan(4000);
		expect(narrowedMatches).toBeGreaterThan(1000);
		// ...and the corpora hold served pairs for the trees to read.
		expect(pairNames).toBeGreaterThan(50);
	}, 120_000);
});

describe("soundness with oracle tags: no matching row lives outside the restriction", () => {
	test("20,000 random trees over a random tagged corpus, every operator, negations and unknown tags", () => {
		const random = rng(0x07a9);
		const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)] as T;
		const hex = (k: number) => Array.from({ length: k }, () => Math.floor(random() * 16).toString(16)).join("");
		const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
		const NAMES = Array.from({ length: 40 }, (_, i) => `name${i}`);
		const TAGS = Array.from({ length: 30 }, (_, i) => `tag${i}`);
		const OPS = [":", "=", ">=", ">", "<", "<=", "!="];
		// The engine's CollectionCmp over a card's tag set against the one-value query {v} (filter.rs).
		const cmp = (tags: string[], op: string, v: string): boolean => {
			const has = tags.includes(v);
			if (op === ":" || op === ">=") return has;
			if (op === "=") return tags.length === 1 && has;
			if (op === ">") return has && tags.length > 1;
			if (op === "<=") return tags.every((t) => t === v);
			if (op === "<") return tags.length === 0;
			return !(tags.length === 1 && has);
		};
		interface TaggedRow {
			partition: number;
			oracleId: string;
			names: string[];
			tags: string[];
			type: string;
			extra: boolean;
			foreign: boolean;
		}
		let restricted = 0;
		let narrowedMatches = 0;
		let empty = 0;
		for (let corpus = 0; corpus < 20; corpus++) {
			const rows: TaggedRow[] = [];
			const ids: string[] = [];
			for (let c = 0; c < 60; c++) {
				const oracleId = uuid();
				ids.push(oracleId);
				const partition = partitionOfOracleId(oracleId, N);
				const names = [pick(NAMES)];
				const type = pick(["creature", "instant"]);
				// A card's tags are its own: every row of it carries them, in every class. Some cards have
				// none, and tags 20-29 no card carries (a slug the blob does not list).
				const tags = [...new Set(Array.from({ length: Math.floor(random() * 4) }, () => pick(TAGS.slice(0, 20))))];
				for (let i = 0; i < 1 + Math.floor(random() * 3); i++) {
					rows.push({ partition, oracleId, names, tags, type, extra: random() < 0.3, foreign: random() < 0.15 });
				}
			}
			// The blob, as the engine lists it: every partition holding a card that carries the tag.
			const holders = new Map<string, number[]>();
			for (const t of TAGS) {
				const ps = new Set(rows.filter((r) => r.tags.includes(t)).map((r) => r.partition));
				holders.set(
					t,
					[...ps].sort((a, b) => a - b),
				);
			}
			const hints = new Map<string, NamePlacement | null>();
			for (const name of NAMES) {
				const all = new Set(rows.filter((r) => r.names.includes(name)).map((r) => r.partition));
				hints.set(name, all.size === 1 ? { sole: [...all][0] as number } : null);
			}
			type Node = Tree & { eval: (r: TaggedRow) => boolean };
			const gen = (depth: number): Node => {
				const roll = random();
				if (depth > 3 || roll < 0.35) {
					const leaf = random();
					if (leaf < 0.55) {
						const t = pick(TAGS);
						const op = random() < 0.6 ? ":" : pick(OPS);
						return { ...otag(t, op), eval: (r) => cmp(r.tags, op, t) };
					}
					if (leaf < 0.7) {
						const name = pick(NAMES);
						return { ...bang(name), eval: (r) => r.names.includes(name) };
					}
					if (leaf < 0.85) {
						const id = random() < 0.8 ? pick(ids) : uuid();
						return { ...oracle(id), eval: (r) => r.oracleId === id };
					}
					const type = pick(["creature", "instant"]);
					return { ...typed(type), eval: (r) => r.type === type };
				}
				const k = 1 + Math.floor(random() * 5);
				const kids = Array.from({ length: k }, () => gen(depth + 1));
				if (roll < 0.6) return { ...and(...kids), eval: (r) => kids.every((c) => c.eval(r)) };
				if (roll < 0.88) return { ...or(...kids), eval: (r) => kids.some((c) => c.eval(r)) };
				const kid = kids[0] as Node;
				return { ...not(kid), eval: (r) => !kid.eval(r) };
			};
			for (let q = 0; q < 1000; q++) {
				const tree = gen(0);
				const withGate = random() < 0.6;
				const multilingual = random() < 0.3;
				const wire = withGate ? gated(tree) : tree;
				const matches = rows.filter((r) => tree.eval(r) && (!withGate || !r.extra) && (multilingual || !r.foreign));
				const restriction = cardRestrictionOf(
					JSON.stringify(wire),
					N,
					(c) => hints.get(c) ?? null,
					multilingual,
					(slug) => holders.get(slug) ?? [],
				);
				if (restriction === null) continue;
				restricted++;
				if (restriction.partitions.length === 0) empty++;
				if (matches.length > 0 && restriction.partitions.length < N) narrowedMatches++;
				for (const r of matches) {
					if (!restriction.partitions.includes(r.partition)) {
						throw new Error(
							`${JSON.stringify(wire)} matches a row in partition ${r.partition}, restricted to ${restriction.partitions}`,
						);
					}
				}
			}
		}
		// Not vacuous: many trees restrict, many of those still match rows, and many name no partition.
		expect(restricted).toBeGreaterThan(4000);
		expect(narrowedMatches).toBeGreaterThan(1000);
		expect(empty).toBeGreaterThan(200);
	}, 120_000);
});
