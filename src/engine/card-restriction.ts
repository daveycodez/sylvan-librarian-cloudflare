/**
 * Backlog y1: does this query's answer come only from an explicit LIST of cards — `!"A" or !"B" or
 * …`, `oracleid:x or oracleid:y …`, alone or ANDed with other filters (`t:creature (!"A" or …)`)?
 * Then only the partitions those cards live in can hold a row of it, and the rest need not be asked.
 *
 * mtg-seeker's typed-terms, art-terms, art-printing-refs and seek-cards lanes search exactly that:
 * OR-lists of up to 25 exact names ANDed with their own filters. Each went to the full gather —
 * 1 + (N-1) Durable Object requests — for cards that live in a handful of partitions.
 *
 * THE RULE. For every node of the wire tree, a set of partitions every matching row lives in, or
 * ALL when nothing narrower is known:
 *
 *   `!"name"`                 the partitions the routing filter names for it (below), else ALL
 *   `oracle_id:`/`=` a UUID   { partitionOfOracleId(id) } — exact, the rule every draft is cut by
 *   AND(a, b, …)              R(a) ∩ R(b) ∩ …   (a row matching the AND matches every operand)
 *   OR(a, b, …)               R(a) ∪ R(b) ∪ …, ALL if any operand is ALL (a row matches one of them)
 *   anything else             ALL — NOT (it excludes, never names), any other leaf, any other op
 *
 * Soundness is by induction over the tree: if every matching row of each operand lives in its set,
 * every matching row of the AND lives in the intersection and of the OR in the union. ALL is the
 * AND identity and the OR absorbing element, so an OR mixing a list with an unrestricted term
 * (`!"A" or t:elf`) restricts nothing, and `NOT !"A"` restricts nothing.
 *
 * A NAME'S PARTITIONS come from the routing filter's name keys (routing-filter.ts `lookupName`),
 * and a hint is exact only for a key the build inserted. Unlike a lone `!"name"` pin (n6), whose
 * non-empty answer proves its key was real, a list's merged page cannot vouch for each member, so
 * the KEYS must cover `!` — pinned against a real corpus by name_routes.rs
 * `list_restriction_keys_cover_every_bang_match`:
 *
 *   (a) every partition where `!"x"` matches ANY row (extras, variations, foreign annex) emitted a
 *       key for x. So a SOLE hint p is exact; and a key the filter never held names no card at all,
 *       so the partition its garbage byte reads (if any) only adds one that answers nothing.
 *   (b) every partition where `!"x" -is:extra` matches a CANONICAL row emitted x SERVED. So under
 *       the router's extras gate — a `NOT is:extra` conjunct of the ROOT, which every result row
 *       satisfies — on a query that is not WIDENED to the foreign annex, a SERVED hint s is exact
 *       too: every other holder holds x only as an extra. A widened one it is not: a foreign
 *       printing can print a name its card no longer has, which no builder keys — measured, one
 *       name in the whole corpus (`!"Pradesh Gypsies" -is:extra&include_multilingual=true` matches
 *       Pradesh Wanderers' foreign rows, in a partition whose only key for it is an extra's).
 *
 * WIDENED is the engine's own rule (`query_widens`): include_multilingual, or a `lang:`,
 * `is:localizedname` or `is:flavorname` leaf anywhere in the tree — spotted here by its attribute or
 * tag in the wire text, which can only err towards "widened".
 *
 * A served hint without the gate (include_extras) or on a widened query, an undecidable one (255),
 * a key that reads null, a non-ASCII name (`nameKey` refuses it) or a filter without name keys: ALL.
 *
 * An EMPTY set is a query that matches nothing (two disjoint lists ANDed).
 *
 * WHAT THE ROUTER DOES WITH IT (partitioned-engine.ts `pinnedOrGathered`): fewer than N partitions
 * are asked as a gather over just those (search-engine-do.ts `gatherListed`), whose coordinator keeps
 * the page only if they answered from the build whose filter chose them — even ONE partition, since
 * a pin checks the modulus alone and a name's key is its build's. A list of ORACLE IDS alone is good
 * for any build of the modulus, so one partition (or none: any one answers the empty page) is a pin.
 */

import { partitionOfOracleId } from "./partition";
import type { NameHint } from "./routing-filter";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A leaf that widens the query to the foreign annex (card_engine `widens_to_annex`): `lang:` is the
 * `card_lang` attribute, `is:localizedname` / `is:flavorname` are `card_is_tags` values. Matched as
 * quoted JSON strings, so a name that merely contains one of the words is a false "widened" at worst.
 */
const WIDENING = /"(card_lang|localizedname|flavorname)"/;

/** Deeper than any query the parser admits; past it a subtree restricts nothing. */
const MAX_DEPTH = 32;

interface WireNode {
	node_type?: string;
	kwargs?: Record<string, unknown>;
}

/** What a restricted query costs to answer: the partitions to ask, and how many list members named them. */
export interface CardRestriction {
	/** Ascending, distinct, each in [0, n). Empty when the query can match nothing. */
	partitions: number[];
	/** How many `!"name"` / `oracleid:` leaves the restriction was derived from. */
	members: number;
	/**
	 * How many of them were NAMES. A name's partitions are its build's routing filter's word, so a
	 * restriction with any is only good for that build (the caller has the gather check it); one of
	 * oracle ids alone is good for any build of the same partition count.
	 */
	names: number;
}

/** A subtree's partition set and the list members it was derived from, or null for ALL. */
type Restricted = { set: Set<number>; members: number; names: number } | null;

/** `NOT card_is_tags:["extra"]` — the router's gate conjunct (extras-gate.ts `notIsTagNode`). */
function isExtrasGate(node: unknown): boolean {
	const { node_type, kwargs } = (node ?? {}) as WireNode;
	if (node_type !== "NotNode") return false;
	const inner = (kwargs?.operand ?? {}) as WireNode;
	if (inner.node_type !== "CardBinaryOperatorNode" || inner.kwargs?.op !== ":") return false;
	const lhs = (inner.kwargs?.lhs ?? {}) as WireNode;
	if (lhs.node_type !== "CardAttributeNode" || lhs.kwargs?.attribute_name !== "card_is_tags") return false;
	const rhs = inner.kwargs?.rhs;
	return Array.isArray(rhs) && rhs.length === 1 && rhs[0] === "extra";
}

/** The root's conjuncts, nested ANDs flattened — where the gate is looked for. */
function rootConjuncts(node: unknown, out: unknown[], depth = 0): void {
	const { node_type, kwargs } = (node ?? {}) as WireNode;
	if (node_type === "AndNode" && Array.isArray(kwargs?.operands) && depth < MAX_DEPTH) {
		for (const operand of kwargs.operands) rootConjuncts(operand, out, depth + 1);
		return;
	}
	out.push(node);
}

/**
 * The card restriction a wire filter tree carries, or null when it has none (ALL partitions — the
 * full gather). `nameHint` is the routing filter's word on a collated name (null: ask everyone).
 */
export function cardRestrictionOf(
	filterTreeJson: string,
	n: number,
	nameHint: (collated: string) => NameHint | null,
	/** The request's include_multilingual. */
	multilingual: boolean,
): CardRestriction | null {
	let tree: unknown;
	try {
		tree = JSON.parse(filterTreeJson);
	} catch {
		return null;
	}
	if (!Number.isInteger(n) || n < 1) return null;
	const conjuncts: unknown[] = [];
	rootConjuncts(tree, conjuncts);
	// Served hints are exact only here (invariant b above).
	const servedExact = conjuncts.some(isExtrasGate) && !multilingual && !WIDENING.test(filterTreeJson);

	const nameSet = (value: unknown): Set<number> | null => {
		if (typeof value !== "string" || value === "") return null;
		const hint = nameHint(value);
		if (hint === null) return null;
		if ("sole" in hint) return hint.sole >= 0 && hint.sole < n ? new Set([hint.sole]) : null;
		return servedExact && hint.served >= 0 && hint.served < n ? new Set([hint.served]) : null;
	};

	const walk = (node: unknown, depth: number): Restricted => {
		if (depth > MAX_DEPTH || !node || typeof node !== "object") return null;
		const { node_type, kwargs } = node as WireNode;
		if (!kwargs) return null;
		if (node_type === "ExactNameNode") {
			const set = nameSet(kwargs.value);
			return set === null ? null : { set, members: 1, names: 1 };
		}
		if (node_type === "CardBinaryOperatorNode") {
			if (kwargs.op !== ":" && kwargs.op !== "=") return null;
			const lhs = kwargs.lhs as WireNode | undefined;
			const rhs = kwargs.rhs as WireNode | undefined;
			if (lhs?.node_type !== "CardAttributeNode" || lhs.kwargs?.attribute_name !== "oracle_id") return null;
			if (rhs?.node_type !== "StringValueNode") return null;
			const value = rhs.kwargs?.value;
			if (typeof value !== "string" || !UUID.test(value)) return null;
			return { set: new Set([partitionOfOracleId(value.toLowerCase(), n)]), members: 1, names: 0 };
		}
		const operands = kwargs.operands;
		if (!Array.isArray(operands) || operands.length === 0) return null;
		if (node_type === "AndNode") {
			let set: Set<number> | null = null;
			let members = 0;
			let names = 0;
			for (const operand of operands) {
				const r = walk(operand, depth + 1);
				if (r === null) continue;
				set = set === null ? r.set : new Set([...(set as Set<number>)].filter((p) => r.set.has(p)));
				members += r.members;
				names += r.names;
			}
			return set === null ? null : { set, members, names };
		}
		if (node_type === "OrNode") {
			const set = new Set<number>();
			let members = 0;
			let names = 0;
			for (const operand of operands) {
				const r = walk(operand, depth + 1);
				// One unrestricted operand and the OR can match anything.
				if (r === null) return null;
				for (const p of r.set) set.add(p);
				members += r.members;
				names += r.names;
			}
			return { set, members, names };
		}
		return null;
	};

	const r = walk(tree, 0);
	if (r === null) return null;
	return { partitions: [...r.set].sort((a, b) => a - b), members: r.members, names: r.names };
}
