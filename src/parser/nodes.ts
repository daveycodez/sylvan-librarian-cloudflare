/**
 * Port of api/parsing/nodes.py — the generic AST node classes.
 *
 * Only the engine-wire surface is ported: to_json()/kwargs() (what the Rust
 * engine deserializes, see card_engine/src/filter.rs). The SQL-generation and
 * human-explanation methods have no wire effect and are intentionally omitted.
 */

import { ParseError } from "./errors";
import type { PyNumber } from "./pystr";

/** A JSON value in the engine wire format. PyNumber preserves Python's int/float split. */
export type FilterValue = string | PyNumber | FilterTree | FilterValue[];

/** The engine-wire JSON encoding of a query node ({node_type, kwargs}). */
export interface FilterTree {
	node_type: string;
	kwargs: Record<string, FilterValue>;
}

/** Serialize obj if it's a QueryNode, otherwise return it as-is (nodes._node_to_json). */
export function nodeToJson(obj: QueryNode | FilterValue): FilterValue {
	return obj instanceof QueryNode ? obj.toJson() : obj;
}

/** Base class for all query nodes in the AST. */
export abstract class QueryNode {
	/** Mirrors Python's self.__class__.__name__ used for the wire node_type. */
	abstract readonly nodeType: string;

	toJson(): FilterTree {
		return { node_type: this.nodeType, kwargs: this.kwargs() };
	}

	abstract kwargs(): Record<string, FilterValue>;
}

export abstract class ValueNode extends QueryNode {
	abstract readonly value: string | PyNumber;
}

/**
 * A string value, and WHETHER THE USER QUOTED IT.
 *
 * `literal` is parser metadata and is deliberately NOT serialized — every field but `name:`
 * treats a quoted value and a bare word identically, so emitting it everywhere would churn the
 * wire for nothing. `name:` is the exception, and it is the reason this flag exists. Measured on
 * api.scryfall.com 2026-08-16:
 *
 *   name:ft        1,628      name:"ft"        362      name:'ft'        362
 *   name:ofthe     1,109      name:"ofthe"       0      name:"of the"  1,109
 *   name:eowyn         3      name:"eowyn"       0      name:"éowyn"       3
 *   name:limdul        8      name:"limdul"      0      name:"lim-dûl"     8
 *
 * A BARE word is matched against the name with **diacritics folded and every non-alphanumeric
 * character removed** on both sides — which is why `ft` reaches "Sword **of the** Ages" and
 * `limdul` reaches "Lim-Dûl's Vault". A QUOTED value is matched literally, case-insensitively and
 * nothing else: `"eowyn"` does not reach "Éowyn" and `"lim-dul"` does not reach "Lim-Dûl".
 *
 * `literal` is therefore true for a quoted value AND for a plain-literal regex lowered to a
 * substring (`lowerLiteralRegexes`) — `name:/lim-dul/` answers 0 on Scryfall, exactly as the
 * quoted spelling does.
 *
 * `regexDerived` is the second, narrower half of the same story, and it is NOT serialized either.
 * The two spellings match the same rows, so the wire tree is right to forget which one was typed —
 * but Scryfall's `include_extras` auto-enable fires on `name:/…/` and NOT on `name:"…"` (measured:
 * `name:/zzzqq/` matches nothing and still forces extras on), so one consumer above the parser has
 * to be able to tell them apart. `lowerRegexLeaves` sets it; `Query.loweredRegexTerms` is how
 * it reaches that consumer without touching a single wire byte.
 */
export class StringValueNode extends ValueNode {
	override readonly nodeType: string = "StringValueNode";

	constructor(
		readonly value: string,
		readonly literal = false,
		readonly regexDerived = false,
	) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return { value: this.value };
	}
}

export class NumericValueNode extends ValueNode {
	override readonly nodeType: string = "NumericValueNode";

	constructor(readonly value: PyNumber) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return { value: this.value };
	}
}

export class ManaValueNode extends ValueNode {
	override readonly nodeType: string = "ManaValueNode";

	constructor(readonly value: string) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return { value: this.value };
	}
}

export class RegexValueNode extends ValueNode {
	override readonly nodeType: string = "RegexValueNode";

	constructor(readonly value: string) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return { value: this.value };
	}
}

const BIN_OPS: ReadonlySet<string> = new Set(["-", "!=", "*", "/", "+", "<", "<=", "=", ">", ">=", ":"]);

export class BinaryOperatorNode extends QueryNode {
	override readonly nodeType: string = "BinaryOperatorNode";

	constructor(
		public lhs: QueryNode,
		public operator: string,
		public rhs: QueryNode,
	) {
		super();
		if (!BIN_OPS.has(operator)) {
			throw new ParseError(`Unknown operator: ${operator}`);
		}
	}

	override kwargs(): Record<string, FilterValue> {
		return { lhs: nodeToJson(this.lhs), op: this.operator, rhs: nodeToJson(this.rhs) };
	}
}

export abstract class NaryOperatorNode extends QueryNode {
	constructor(readonly operands: QueryNode[]) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return { operands: this.operands.map((op) => nodeToJson(op)) };
	}
}

export class AndNode extends NaryOperatorNode {
	override readonly nodeType: string = "AndNode";
}

export class OrNode extends NaryOperatorNode {
	override readonly nodeType: string = "OrNode";
}

export class NotNode extends QueryNode {
	override readonly nodeType: string = "NotNode";

	constructor(readonly operand: QueryNode) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return { operand: nodeToJson(this.operand) };
	}
}

export class TrueNode extends QueryNode {
	override readonly nodeType: string = "TrueNode";

	override kwargs(): Record<string, FilterValue> {
		return {};
	}
}

/**
 * The directive names both parsers recognise, longest spelling first so an
 * alternation built from this list matches `direction` outright rather than
 * leaning on a lookahead to reject the `dir` prefix.
 *
 * `sort`/`order` and `direction`/`dir` are two spellings of one parameter each;
 * api.scryfall.com accepts both inline.
 */
/** One directive as found in the query: name, value, and whether it was nested. */
export interface DirectiveFound {
	name: string;
	value: string;
	/** True when it sat under an OR or a negation — see stripDirectives in rewrite.ts. */
	nested: boolean;
}

export const DIRECTIVE_NAMES: readonly string[] = ["unique", "sort", "order", "direction", "dir", "prefer"];

/**
 * A result-shape directive written inside the query string (`unique:art`, `sort:usd`).
 *
 * Carries the name and value so `extractDirectives` can record them on the Query
 * and strip the node from the filter tree — a directive constrains PRESENTATION,
 * not membership, so one must never reach the engine. Without the strip it would
 * serialize as a vestigial residue and make `t:goblin sort:edhrec` compare
 * unequal to `t:goblin` despite filtering identically.
 */
export class DirectiveNode extends QueryNode {
	override readonly nodeType: string = "DirectiveNode";

	constructor(
		readonly name: string,
		readonly value: string,
	) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return {};
	}
}

/** One `column:value` leaf, at the granularity every out-of-band rewrite record is kept in. */
export interface QueryTerm {
	readonly attribute: string;
	/** Lowercased, because every consumer compares case-insensitively. */
	readonly value: string;
}

/** One `field:/regex/` leaf the rewrite lowered: the db column, and the literal it lowered to. */
export type LoweredRegexTerm = QueryTerm;

/**
 * One derived `is:`/`has:`/`frame:` term that `expandDerivedPredicates` replaced with a subtree,
 * and the leaves that subtree left behind in its place.
 *
 * SAME PROBLEM AS `LoweredRegexTerm`, one rewrite further along: the expansion erases the spelling
 * the caller wrote. `is:split` becomes `layout:split` and is then INDISTINGUISHABLE from a
 * `layout:split` the caller typed — the two wire trees are byte-identical — while Scryfall's
 * `include_extras` auto-enable separates them (`is:split` echoes `false` and answers 327,
 * `layout:split` echoes `true` and answers 347). `term` is what the caller wrote, so the rule can
 * be applied to it; `leaves` is what the rewrite put there, so the rule can decline to fire on
 * terms the caller never typed. See `Query.expandedDerivedTerms` and `extrasTriggers`.
 */
export interface ExpandedDerivedTerm {
	/** The term as written, `alias:value` and lowercased — `is:split`, `has:artist`, `frame:old`. */
	readonly term: string;
	/** Every `column:value` leaf the expansion produced, lowercased, in tree order. */
	readonly leaves: readonly QueryTerm[];
}

/** Top-level query container node; to_json delegates to the root. */
export class Query extends QueryNode {
	override readonly nodeType: string = "Query";

	/**
	 * Result-shape directives the query carried, in source order. Attached by
	 * `rewriteQuery` after the passes run, exactly as upstream does — each pass
	 * returns a fresh Query, so this cannot be set before them.
	 */
	directives: readonly DirectiveFound[] = [];

	/**
	 * Notes the rewrite passes want the API layer to surface — today, the `is:` values this server
	 * has no data for, which would otherwise leave a caller looking at zero results with nothing to
	 * distinguish "no such card" from "no such predicate". Attached by `rewriteQuery`, for the same
	 * reason `directives` is.
	 */
	warnings: readonly string[] = [];

	/**
	 * The `field:/regex/` leaves that `lowerLiteralRegexes` rewrote into plain substrings, as
	 * (db column, lowered value) pairs in tree order. Attached by that pass rather than by
	 * `rewriteQuery`, because the pass is the only place that still knows.
	 *
	 * The lowering is not optional — it is upstream's rewrite, and the parity fixtures compare the
	 * tree byte for byte — but it erases a distinction one caller above the parser needs, in BOTH
	 * directions. Scryfall's `include_extras` auto-enable fires on a `name:` regex and not on
	 * `name:"…"`, and fires on `t:token` but not on `t:/token/`; after the rewrite each pair is the
	 * same JSON. This carries the fact out of band, keyed finely enough that `t:token t:/goblin/`
	 * still reads its two terms apart. See `StringValueNode.regexDerived` and `extrasTriggers`.
	 */
	loweredRegexTerms: readonly LoweredRegexTerm[] = [];

	/**
	 * The derived `is:`/`has:`/`frame:` terms `expandDerivedPredicates` replaced, each with the
	 * leaves its expansion left behind. Attached by that pass, for exactly the reason
	 * `loweredRegexTerms` is attached by its own: the pass is the only place that still knows.
	 *
	 * The expansion is not optional — it is upstream's rewrite and the parity fixtures compare the
	 * tree byte for byte — but it makes `is:split` reach the route layer as a `layout:` term the
	 * caller never wrote, and `layout:` forces Scryfall's extras gate on where `is:split` does not.
	 * Carrying both halves out of band lets one consumer apply the rule to the spelling that was
	 * typed: fire for the derived values Scryfall fires on, and ignore the leaves the rewrite
	 * invented. See `ExpandedDerivedTerm` and `extrasTriggers`.
	 */
	expandedDerivedTerms: readonly ExpandedDerivedTerm[] = [];

	constructor(readonly root: QueryNode) {
		super();
	}

	override toJson(): FilterTree {
		return this.root.toJson();
	}

	override kwargs(): Record<string, FilterValue> {
		return this.root.kwargs();
	}
}

/**
 * Flatten nested AND/OR chains into canonical n-ary form.
 * AndNode(a, AndNode(b, c)) -> AndNode(a, b, c)
 *
 * Mirrors nodes.flatten_nested_operations, including its exact-class tests
 * (`node.__class__ is AndNode`), so subclasses would not be flattened.
 */
export function flattenNestedOperations(node: Query): Query;
export function flattenNestedOperations(node: QueryNode): QueryNode;
export function flattenNestedOperations(node: QueryNode): QueryNode {
	const cls = (node as object).constructor;
	if (cls === AndNode) {
		const operands: QueryNode[] = [];
		for (const operand of (node as AndNode).operands) {
			const flattened = flattenNestedOperations(operand);
			if (flattened instanceof AndNode) operands.push(...flattened.operands);
			else operands.push(flattened);
		}
		return new AndNode(operands);
	}
	if (cls === OrNode) {
		const operands: QueryNode[] = [];
		for (const operand of (node as OrNode).operands) {
			const flattened = flattenNestedOperations(operand);
			if (flattened instanceof OrNode) operands.push(...flattened.operands);
			else operands.push(flattened);
		}
		return new OrNode(operands);
	}
	if (cls === NotNode) {
		return new NotNode(flattenNestedOperations((node as NotNode).operand));
	}
	if (cls === Query) {
		return new Query(flattenNestedOperations((node as Query).root));
	}
	return node;
}
