// Reject queries whose tree is a VALUE where a PREDICATE belongs.
//
// `1`, `1+2`, `cmc-power` and `power - cmc` all parse — upstream's fixtures pin them to real trees
// (`NumericValueNode`, an arithmetic `CardBinaryOperatorNode`), and tests/parser/parity.test.ts holds
// this port byte-identical to that. So the parser is right and must not change: an arithmetic
// expression is legal SYNTAX, it is just not a filter.
//
// Upstream catches it after parsing and answers 400 with its own wording. This port did not, so the
// value node reached the engine, which has nothing to evaluate `1` as and failed the RPC — a 500 on
// `/search?q=1`, and on any query carrying a bare number as a word ("Ajani 2"). Found in production
// 2026-08-13; ~2529 tests passed over it because nothing searched for a bare number.
//
// CONSERVATIVE BY CONSTRUCTION. Only node types known to be values are rejected, and only in boolean
// position; anything unrecognised is left alone. The two failure directions are not symmetric — a
// miss leaves today's 500 for some exotic shape, while a false positive turns a working search into a
// 400. Unknown shapes therefore stay legal.

interface WireNode {
	node_type: string;
	kwargs: Record<string, unknown>;
}

function isWireNode(value: unknown): value is WireNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as WireNode).node_type === "string" &&
		typeof (value as WireNode).kwargs === "object" &&
		(value as WireNode).kwargs !== null
	);
}

/** Ops that make a BinaryOperatorNode a predicate. Anything else (+ - * /) leaves it a value. */
const COMPARISON_OPS: ReadonlySet<string> = new Set([":", "=", "==", "!=", "<>", "<", ">", "<=", ">="]);

/** Nodes that carry a value rather than assert anything. A bare one cannot be a filter. */
const VALUE_NODES: ReadonlySet<string> = new Set([
	"NumericValueNode",
	"StringValueNode",
	"CollatedNameValueNode",
	"ManaValueNode",
	"RegexValueNode",
	// An attribute standing alone is the `power - cmc` shape with the arithmetic stripped by a
	// single-operand fold; it is a column reference, not a question about one.
	"CardAttributeNode",
	"AttributeNode",
]);

/**
 * True when `tree` uses a value expression as a filter.
 *
 * Descends ONLY through boolean connectives, because that is the only place a predicate is required.
 * The operands of a comparison are supposed to be values — `cmc:1` holds a NumericValueNode and is
 * perfectly good — so a comparison node is where the walk stops rather than somewhere it recurses.
 */
export function usesValueAsPredicate(tree: unknown): boolean {
	if (!isWireNode(tree)) return false;

	switch (tree.node_type) {
		case "AndNode":
		case "OrNode": {
			const operands = tree.kwargs.operands;
			return Array.isArray(operands) && operands.some((operand) => usesValueAsPredicate(operand));
		}
		case "NotNode":
			// `-1` parses as Not(NumericValueNode), so negation is boolean position too.
			return usesValueAsPredicate(tree.kwargs.operand);
		case "BinaryOperatorNode":
		case "CardBinaryOperatorNode":
			return typeof tree.kwargs.op === "string" && !COMPARISON_OPS.has(tree.kwargs.op);
		default:
			return VALUE_NODES.has(tree.node_type);
	}
}

/**
 * Upstream's description for this case, verbatim, including the whole query rather than the offending
 * term — checked against sylvan-librarian.com/search on 2026-08-13 for `1`, `1+2`, `cmc-power` and
 * `t:elf 1`, all of which answer with the full query text.
 */
export function arithmeticNotComparedMessage(query: string): string {
	return (
		`The search query '${query}' contains invalid syntax. ` +
		`Arithmetic expressions like 'cmc+1' need to be part of a comparison (e.g., 'cmc+1>3').`
	);
}
