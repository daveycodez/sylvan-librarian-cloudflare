/**
 * A query's SHAPE: its wire tree with every value taken out — node types, attribute names,
 * operators and the KIND of each value, never the value. What `/cards/search`'s per-miss log line
 * records, so the day's non-oracleid traffic can be told apart by the queries it asks (and the
 * next one worth pinning to one partition picked from data) without logging anything a user typed.
 *
 * Canonical, so one family is one string however it was spelled: a conjunction's or disjunction's
 * operands are SORTED and runs of the same shape collapse to `shape*n` — `!"A" or !"B" or !"C"` is
 * `or(!name*3)`, whichever names and in whatever order. Bounded: at most MAX_SHAPE_CHARS, cut with
 * a trailing `…`, so a pathological query cannot make a pathological log line.
 *
 * Leaves:
 *   `!name`                     an exact name (`!"…"`), ExactNameNode
 *   `<attribute><op><kind>`     a comparison, e.g. `card_oracle_tags:list`, `cmc>=num`,
 *                               `card_name:coll` (a bare word), `card_name:re`
 *   `<attribute><op>@<attr>`    a column-to-column comparison (`pow>tou`)
 *   `true`                      TrueNode (an empty query after directives)
 * where kind is str | coll | num | re | mana | list (a compiled value set: `t:`, `c:`, `is:`,
 * `otag:`) | bool | expr (arithmetic) | ? (anything unrecognized).
 *
 * NOTHING FROM THE QUERY TEXT REACHES THE STRING: attribute names and operators are the parser's
 * own vocabulary, and an unrecognized node contributes its node type or `?`, never a kwarg.
 */

const MAX_SHAPE_CHARS = 240;
/** Deeper than any query the parser's budget admits in practice; past it a subtree is `…`. */
const MAX_DEPTH = 12;

interface WireNode {
	node_type?: string;
	kwargs?: Record<string, unknown>;
}

const VALUE_KIND: Readonly<Record<string, string>> = {
	StringValueNode: "str",
	CollatedNameValueNode: "coll",
	NumericValueNode: "num",
	RegexValueNode: "re",
	ManaValueNode: "mana",
	BinaryOperatorNode: "expr",
};

function valueShape(node: unknown): string {
	// Compiled right-hand sides are plain JSON too: `t:creature` and `otag:ramp` carry an array of
	// values, and a few comparisons a bare string or number.
	if (Array.isArray(node)) return "list";
	if (typeof node === "string") return "str";
	if (typeof node === "number") return "num";
	if (typeof node === "boolean") return "bool";
	const { node_type, kwargs } = (node ?? {}) as WireNode;
	if (node_type === "CardAttributeNode") return `@${String(kwargs?.attribute_name ?? "?")}`;
	return VALUE_KIND[node_type ?? ""] ?? "?";
}

function shapeOf(node: unknown, depth: number): string {
	if (depth > MAX_DEPTH) return "…";
	const { node_type, kwargs } = (node ?? {}) as WireNode;
	switch (node_type) {
		case "AndNode":
		case "OrNode": {
			const operands = Array.isArray(kwargs?.operands) ? kwargs.operands : [];
			const parts = operands.map((operand) => shapeOf(operand, depth + 1)).sort();
			const runs: string[] = [];
			for (let i = 0; i < parts.length; ) {
				let j = i;
				while (j < parts.length && parts[j] === parts[i]) j++;
				runs.push(j - i > 1 ? `${parts[i]}*${j - i}` : (parts[i] as string));
				i = j;
			}
			return `${node_type === "AndNode" ? "and" : "or"}(${runs.join(",")})`;
		}
		case "NotNode":
			return `not(${shapeOf(kwargs?.operand, depth + 1)})`;
		case "ExactNameNode":
			return "!name";
		case "TrueNode":
			return "true";
		case "CardBinaryOperatorNode":
		case "BinaryOperatorNode": {
			const lhs = (kwargs?.lhs ?? {}) as WireNode;
			const attribute =
				lhs.node_type === "CardAttributeNode" ? String(lhs.kwargs?.attribute_name ?? "?") : valueShape(lhs);
			return `${attribute}${String(kwargs?.op ?? "?")}${valueShape(kwargs?.rhs)}`;
		}
		default:
			return node_type ?? "?";
	}
}

/** The shape of a wire filter tree (the parser's output, as JSON-ready objects). */
export function queryShape(tree: unknown): string {
	const shape = shapeOf(tree, 0);
	return shape.length > MAX_SHAPE_CHARS ? `${shape.slice(0, MAX_SHAPE_CHARS - 1)}…` : shape;
}
