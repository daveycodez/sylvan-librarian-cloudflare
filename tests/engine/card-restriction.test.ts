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
import type { NameHint } from "../../src/engine/routing-filter";

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

const HINTS: Record<string, NameHint | null> = {
	bolt: { sole: 2 },
	counterspell: { sole: 7 },
	brainstorm: { served: 4, rival: 0 },
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
		expect(at(and(bang("bolt"), bang("counterspell")))).toEqual({ partitions: [], members: 2, names: 2 });
	});

	test("oracle ids, alone, mixed with names, and upper-cased", () => {
		const ps = IDS.map((id) => partitionOfOracleId(id, N));
		expect(at(or(...IDS.map((id) => oracle(id))))?.partitions).toEqual([...new Set(ps)].sort((a, b) => a - b));
		expect(at(or(oracle(IDS[0] as string), bang("bolt")))).toEqual({
			partitions: [...new Set([ps[0] as number, 2])].sort((a, b) => a - b),
			members: 2,
			names: 1,
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

	test("a WIDENED query trusts sole hints alone: include_multilingual, `lang:`, is:localizedname/flavorname", () => {
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
		for (const widening of [lang, isTag("localizedname"), not(isTag("flavorname"))]) {
			expect(at(and(list, widening))).toBeNull();
			expect(at(and(sole, widening))?.partitions).toEqual([2, 7]);
		}
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
			const hints = new Map<string, NameHint | null>();
			for (const name of NAMES) {
				const all = new Set(rows.filter((r) => r.names.includes(name)).map((r) => r.partition));
				const served = new Set(
					rows.filter((r) => !r.extra && !r.foreign && r.names.includes(name)).map((r) => r.partition),
				);
				let h: NameHint | null;
				if (all.size === 0) {
					const garbage = Math.floor(random() * 256);
					h = garbage < N ? { sole: garbage } : garbage < 5 * N ? { served: Math.floor((garbage - N) / 4) } : null;
				} else if (all.size === 1) h = { sole: [...all][0] as number };
				else if (served.size === 1) h = { served: [...served][0] as number, rival: 0 };
				else h = null;
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
	});
});
