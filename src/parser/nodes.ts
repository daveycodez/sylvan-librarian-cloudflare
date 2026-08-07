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

export class StringValueNode extends ValueNode {
	override readonly nodeType: string = "StringValueNode";

	constructor(readonly value: string) {
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

/** Top-level query container node; to_json delegates to the root. */
export class Query extends QueryNode {
	override readonly nodeType: string = "Query";

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
