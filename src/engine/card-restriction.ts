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
 *   `otag:x` (`:`/`=`/`>=`/`>`) the partitions whose cards carry the slug x, from the build's
 *                             oracle-tags blob (below), else ALL
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
 * `is:localizedname`, `is:printedtext` or unnegated `is:fwb` leaf anywhere in the tree — spotted here by its attribute or tag in the wire
 * text, which can only err towards "widened". (`is:flavorname` was a third until 2026-10-04, when
 * it was measured NOT to widen on api.scryfall.com; card_engine's `FlavorNamePresent` has it.)
 *
 * (c) a SERVED PAIR (routing-filter.ts, a filter with ROUTING_FEATURE_NAME_SERVED_PAIRS) is a name
 *     exactly two partitions emitted SERVED — a classic spell and the `prepare` card printing it as
 *     a face (`Channel`, `Yavimaya Bloomsage // Channel`). By (b), under the gate on a query not
 *     widened, those two are every partition a row of `!"x"` can come from, exactly as one served
 *     partition is for a served hint; every other holder holds x only as an extra.
 *
 * A served hint or pair without the gate (include_extras) or on a widened query, an undecidable one (255),
 * a key that reads null, a non-ASCII name (`nameKey` refuses it) or a filter without name keys: ALL.
 *
 * AN ORACLE TAG'S PARTITIONS come from the build's oracle-tags blob (oracle-tag-partitions.ts):
 * every partition whose archive holds a card carrying the slug, as the engine listed them off the
 * structures it serialized (card_engine `oracle_tags_of`). `otag:x` is a `CollectionCmp` on
 * `card_oracle_tags` and nothing else, and every row of every mode — canonical, extras, variations,
 * the foreign annex — belongs to one of a partition's cards, so the set is EXACT for every mode and
 * every request flag: no gate, no widening condition. A slug no card carries is the empty set. `:`,
 * `=` and `>=` are containment and `>` containment plus more (the engine's `CmpOp::Ge`/`Gt`), so
 * all four need the tag; `<`, `<=` and `!=` match cards WITHOUT it (an empty tag set satisfies
 * them) and restrict nothing, and neither does a negated `-otag:x`. The slug on the wire is the one
 * the engine binds — the parser has already slugified it and resolved its alias spelling — so it
 * is looked up exactly as written.
 *
 * An EMPTY set is a query that matches nothing (two disjoint lists ANDed, an unknown tag).
 *
 * WHAT THE ROUTER DOES WITH IT (partitioned-engine.ts `pinnedOrGathered`): fewer than N partitions
 * are asked as a gather over just those (search-engine-do.ts `gatherListed`), whose coordinator keeps
 * the page only if they answered from the build whose filter chose them — even ONE partition, since
 * a pin checks the modulus alone and a name's key is its build's. A list of ORACLE IDS alone is good
 * for any build of the modulus, so one partition (or none: any one answers the empty page) is a pin.
 */

import { partitionOfOracleId } from "./partition";
import type { NamePlacement } from "./routing-filter";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A leaf that widens the query to the foreign annex (card_engine `widens_to_annex`): `lang:` is the
 * `card_lang` attribute, `is:localizedname`, `is:printedtext` and `is:fwb` are `card_is_tags` values. Matched as
 * quoted JSON strings, so a name that merely contains one of the words is a false "widened" at
 * worst — and so is a NEGATED `is:fwb`, which does not widen in the engine.
 */
const WIDENING = /"(card_lang|localizedname|printedtext|fwb)"/;

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
	/** How many were ORACLE TAGS — their build's blob's word, so build-bound exactly like names. */
	tags: number;
}

/** A subtree's partition set and the list members it was derived from, or null for ALL. */
type Restricted = { set: Set<number>; members: number; names: number; tags: number } | null;

/** The operators on a collection column that need the value present (engine `CmpOp::Ge`/`Gt`). */
const CONTAINING_OPS = new Set([":", "=", ">=", ">"]);

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
	nameHint: (collated: string) => NamePlacement | null,
	/** The request's include_multilingual. */
	multilingual: boolean,
	/**
	 * The build's oracle-tags blob's word on a slug: the partitions holding a card that carries it
	 * (empty: none does), or null when there is no blob — every `otag:` term is then ALL.
	 */
	tagPartitions: ((slug: string) => readonly number[]) | null = null,
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
		if (!servedExact) return null;
		if ("servedPair" in hint) {
			const [a, b] = hint.servedPair;
			return a >= 0 && a < n && b >= 0 && b < n ? new Set([a, b]) : null;
		}
		return hint.served >= 0 && hint.served < n ? new Set([hint.served]) : null;
	};

	const walk = (node: unknown, depth: number): Restricted => {
		if (depth > MAX_DEPTH || !node || typeof node !== "object") return null;
		const { node_type, kwargs } = node as WireNode;
		if (!kwargs) return null;
		if (node_type === "ExactNameNode") {
			const set = nameSet(kwargs.value);
			return set === null ? null : { set, members: 1, names: 1, tags: 0 };
		}
		if (node_type === "CardBinaryOperatorNode") {
			const lhs = kwargs.lhs as WireNode | undefined;
			if (lhs?.node_type !== "CardAttributeNode") return null;
			if (lhs.kwargs?.attribute_name === "card_oracle_tags") {
				if (tagPartitions === null || typeof kwargs.op !== "string" || !CONTAINING_OPS.has(kwargs.op)) return null;
				// The parser's one-slug array (getOracleTagsComparisonKeys); a regex or numeric rhs is
				// not one, and the engine reads only the first element of an array anyway.
				const rhs = kwargs.rhs;
				if (!Array.isArray(rhs) || rhs.length !== 1 || typeof rhs[0] !== "string") return null;
				const set = new Set<number>();
				for (const p of tagPartitions(rhs[0])) {
					// A partition outside the modulus means the blob is not this build's: ask everyone.
					if (!Number.isInteger(p) || p < 0 || p >= n) return null;
					set.add(p);
				}
				return { set, members: 1, names: 0, tags: 1 };
			}
			if (kwargs.op !== ":" && kwargs.op !== "=") return null;
			const rhs = kwargs.rhs as WireNode | undefined;
			if (lhs.kwargs?.attribute_name !== "oracle_id") return null;
			if (rhs?.node_type !== "StringValueNode") return null;
			const value = rhs.kwargs?.value;
			if (typeof value !== "string" || !UUID.test(value)) return null;
			return { set: new Set([partitionOfOracleId(value.toLowerCase(), n)]), members: 1, names: 0, tags: 0 };
		}
		const operands = kwargs.operands;
		if (!Array.isArray(operands) || operands.length === 0) return null;
		if (node_type === "AndNode") {
			let set: Set<number> | null = null;
			let members = 0;
			let names = 0;
			let tags = 0;
			for (const operand of operands) {
				const r = walk(operand, depth + 1);
				if (r === null) continue;
				set = set === null ? r.set : new Set([...(set as Set<number>)].filter((p) => r.set.has(p)));
				members += r.members;
				names += r.names;
				tags += r.tags;
			}
			return set === null ? null : { set, members, names, tags };
		}
		if (node_type === "OrNode") {
			const set = new Set<number>();
			let members = 0;
			let names = 0;
			let tags = 0;
			for (const operand of operands) {
				const r = walk(operand, depth + 1);
				// One unrestricted operand and the OR can match anything.
				if (r === null) return null;
				for (const p of r.set) set.add(p);
				members += r.members;
				names += r.names;
				tags += r.tags;
			}
			return { set, members, names, tags };
		}
		return null;
	};

	const r = walk(tree, 0);
	if (r === null) return null;
	return { partitions: [...r.set].sort((a, b) => a - b), members: r.members, names: r.names, tags: r.tags };
}
