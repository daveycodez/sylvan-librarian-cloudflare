// Port of to_human_explanation from api/parsing/nodes.py and
// api/parsing/card_query_nodes.py, operating on the engine-wire filter tree
// JSON (the {node_type, kwargs} serialization produced for the Rust engine)
// rather than the Python AST, which does not exist in this port.
//
// Known, unavoidable divergences — the wire tree normalizes some right-hand
// sides that upstream's AST-based explanation shows raw:
//   - rarity: the wire carries the numeric rank, so "r:rare" and "r:r" both
//     explain as "the rarity contains rare" (upstream echoes the user's text);
//   - name/artist: the wire value is titlecased (and accent-folded for name:),
//     so "name:bolt" explains as "the name contains Bolt";
//   - keywords/types/tags/legalities: the wire carries the normalized list
//     entry ("Flying", "Elf", "modern"), not the user's spelling;
//   - exact name (!"..."): the wire value is lowercased.
// Everything structural — operators, joins, grouping, the special per-column
// phrasings — matches upstream exactly.

/** One {node_type, kwargs} node of the engine-wire filter tree. */
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

// CardAttributeNode.to_human_explanation name_map.
const ATTRIBUTE_NAME_MAP: Record<string, string> = {
	cmc: "mana value",
	creature_power: "power",
	creature_toughness: "toughness",
	card_color_identity: "color identity",
	card_colors: "color",
	card_name: "name",
	oracle_text: "oracle text",
	card_types: "type",
	card_subtypes: "subtype",
	card_rarity_int: "rarity",
	card_legalities: "format",
	card_artist: "artist",
	card_set_code: "set",
	mana_cost_jsonb: "mana cost",
	planeswalker_loyalty: "loyalty",
	type_line: "type line",
	flavor_text: "flavor text",
	card_keywords: "keyword",
	oracle_id: "oracle ID",
	card_lang: "language",
	card_layout: "layout",
	card_border: "border",
	card_watermark: "watermark",
	released_at: "release date",
	collector_number: "collector number",
	price_usd: "price (USD)",
	price_eur: "price (EUR)",
	price_tix: "price (TIX)",
	edhrec_rank: "EDHREC rank",
};

// BinaryOperatorNode / CardBinaryOperatorNode operator_map.
const OPERATOR_MAP: Record<string, string> = {
	"=": "is",
	"!=": "is not",
	">=": "≥",
	"<=": "≤",
	":": "contains",
	"*": "×",
	"/": "÷",
};

const COLOR_CODE_TO_NAME: Record<string, string> = {
	b: "black",
	c: "colorless",
	g: "green",
	r: "red",
	u: "blue",
	w: "white",
};

// The wire tree carries rarity as its numeric rank (see
// CardBinaryOperatorNode._rhs_to_json + RARITY_TO_NUMBER); map back to the
// canonical name for display.
const RARITY_NUMBER_TO_NAME: Record<number, string> = {
	0: "common",
	1: "uncommon",
	2: "rare",
	3: "mythic",
	4: "special",
	5: "bonus",
};

function capitalize(word: string): string {
	return word.length === 0 ? word : (word[0] as string).toUpperCase() + word.slice(1).toLowerCase();
}

function attributeName(node: WireNode): string {
	const attr = typeof node.kwargs.attribute_name === "string" ? node.kwargs.attribute_name.toLowerCase() : "";
	const original =
		typeof node.kwargs.original_attribute === "string" ? node.kwargs.original_attribute.toLowerCase() : "";
	// Upstream explains the AST *before* wire serialization resolves a type:
	// query against card_types vs card_subtypes, so "t:elf" explains as "the
	// type contains ...". The wire keeps the original alias; undo the
	// resolution for explanation purposes.
	if (attr === "card_subtypes" && (original === "t" || original === "type" || original === "types")) {
		return "card_types";
	}
	return attr;
}

/** ValueNode.to_human_explanation / str(value). */
function valueToString(value: unknown): string {
	return typeof value === "string" ? value : String(value);
}

/**
 * A colour explanation: the name, then the letters as `{W}`-style bracket tokens
 * (mirrors card_query_nodes._color_codes_to_explanation, upstream #1051).
 *
 * The tokens are there so a reader is not left to remember which colours a name means, and the
 * frontend turns exactly this fixed A–Z/digit vocabulary into mana-font icons: `showResults()` runs
 * the whole message through `convertManaSymbols()` AFTER escaping it. That makes this the one place
 * a server-composed string is allowed to steer frontend rendering, and it is safe only because the
 * token alphabet is closed — every character in it comes from COLOR_CODE_TO_NAME's keys, never from
 * the query.
 */
function colorCodesToExplanation(codes: readonly string[]): string {
	const lower = codes.map((c) => String(c).toLowerCase());
	const names = lower.map((c) => capitalize(COLOR_CODE_TO_NAME[c] ?? c)).join("/");
	const tokens = lower.map((c) => `{${c.toUpperCase()}}`).join("");
	return `${names} (${tokens})`;
}

/** Mirror of CardBinaryOperatorNode._explain_value plus the wire-array shapes. */
function explainRhs(rhs: unknown, lhs: WireNode | null): string {
	const attr = lhs && lhs.node_type === "CardAttributeNode" ? attributeName(lhs) : "";

	if (Array.isArray(rhs)) {
		// JSONB comparisons ship the rhs as a plain list of normalized entries.
		if (attr === "card_colors" || attr === "card_color_identity" || attr === "produced_mana") {
			if (rhs.length === 0) {
				// Only a "colorless" query produces an empty color object — and upstream spells its
				// token out as `{C}` rather than leaving the parentheses empty.
				return colorCodesToExplanation(["c"]);
			}
			return colorCodesToExplanation(rhs.map(String));
		}
		return rhs.map(valueToString).join(", ");
	}

	if (isWireNode(rhs)) {
		if (rhs.node_type === "NumericValueNode" && attr === "card_rarity_int") {
			const num = Number(rhs.kwargs.value);
			return RARITY_NUMBER_TO_NAME[num] ?? valueToString(rhs.kwargs.value);
		}
		if (
			rhs.node_type === "StringValueNode" ||
			// The BARE-word `name:` value (see the parser). It reads as a string everywhere here;
			// the only difference is that the parser already collated it, so an explanation of
			// `urza's` says "Urzas" — which is honestly what the search now matches on.
			rhs.node_type === "CollatedNameValueNode" ||
			rhs.node_type === "NumericValueNode" ||
			rhs.node_type === "ManaValueNode" ||
			rhs.node_type === "RegexValueNode"
		) {
			const value = valueToString(rhs.kwargs.value);
			if (rhs.node_type !== "StringValueNode" && rhs.node_type !== "CollatedNameValueNode") {
				return value;
			}
			const trimmed = value.trim();
			if (attr === "card_colors" || attr === "card_color_identity") {
				if (trimmed.length === 1 && COLOR_CODE_TO_NAME[trimmed.toLowerCase()]) {
					return colorCodesToExplanation([trimmed]);
				}
				const maxColors = 5;
				if (
					trimmed.length <= maxColors &&
					trimmed.length > 0 &&
					[...trimmed].every((c) => COLOR_CODE_TO_NAME[c.toLowerCase()])
				) {
					return colorCodesToExplanation([...trimmed]);
				}
			}
			return trimmed;
		}
		return explain(rhs);
	}

	return valueToString(rhs);
}

/**
 * The noun each colour column counts, for the numeric colour-count branch below.
 *
 * `c:m` and `c>=2` are the same node by the time an explanation sees them — the parser lowers the
 * colour-COUNT names into the numeric comparison — so this sentence is what both of them get.
 */
const COLOR_COUNT_NOUN: Record<string, string> = {
	card_colors: "colors",
	card_color_identity: "colors in the color identity",
	// SIX kinds, not five: produced_mana is the one colour-ish column whose array can hold "C".
	produced_mana: "kinds of mana produced",
};

/** CardBinaryOperatorNode._format_card_attribute_explanation. */
function formatCardAttributeExplanation(
	lhs: WireNode,
	op: string,
	opStr: string,
	rhsStr: string,
	rhs: unknown,
): string {
	const dbColumnName = attributeName(lhs);

	// Numeric color syntax compares the count of colors, not the colors themselves.
	if (COLOR_COUNT_NOUN[dbColumnName] && isWireNode(rhs) && rhs.node_type === "NumericValueNode") {
		const countOp = op === ":" ? "is" : opStr; // ":" compares counts as equality
		return `the number of ${COLOR_COUNT_NOUN[dbColumnName]} ${countOp} ${rhsStr}`;
	}

	if (dbColumnName === "card_color_identity" && (op === "=" || op === ":")) {
		return `the color identity is ${rhsStr}`;
	}
	if (dbColumnName === "card_legalities" && (op === "=" || op === ":")) {
		return `it's legal in ${rhsStr}`;
	}
	if (dbColumnName === "card_colors" && (op === "=" || op === ":")) {
		return `the color is ${rhsStr}`;
	}
	if (dbColumnName === "creature_power") {
		return `the power ${opStr} ${rhsStr}`;
	}
	if (dbColumnName === "creature_toughness") {
		return `the toughness ${opStr} ${rhsStr}`;
	}
	if (dbColumnName === "cmc") {
		return `the mana value ${opStr} ${rhsStr}`;
	}
	if (dbColumnName === "card_name" && (op === ":" || op === "=")) {
		return `the name contains ${rhsStr}`;
	}
	if (dbColumnName === "oracle_text" && (op === ":" || op === "=")) {
		return `the oracle text contains ${rhsStr}`;
	}
	if (dbColumnName === "card_types" && (op === ":" || op === "=")) {
		return `the type contains ${rhsStr}`;
	}
	if (dbColumnName === "card_rarity_int") {
		return `the rarity ${opStr} ${rhsStr}`;
	}
	if (dbColumnName === "card_artist" && (op === ":" || op === "=")) {
		return `the artist contains ${rhsStr}`;
	}
	if (dbColumnName === "card_set_code" && (op === ":" || op === "=")) {
		return `the set contains ${rhsStr}`;
	}

	const lhsStr = ATTRIBUTE_NAME_MAP[dbColumnName] ?? dbColumnName.replace(/_/g, " ");
	return `${lhsStr} ${opStr} ${rhsStr}`;
}

function explainBinary(node: WireNode): string {
	const lhs = node.kwargs.lhs;
	const rhs = node.kwargs.rhs;
	const op = typeof node.kwargs.op === "string" ? node.kwargs.op : "";

	// Handle empty string values (CardBinaryOperatorNode.to_human_explanation).
	if (
		isWireNode(rhs) &&
		(rhs.node_type === "StringValueNode" || rhs.node_type === "CollatedNameValueNode") &&
		valueToString(rhs.kwargs.value).trim() === ""
	) {
		return "";
	}
	if (typeof rhs === "string" && rhs.trim() === "") {
		return "";
	}

	const opStr = OPERATOR_MAP[op] ?? op;
	const lhsNode = isWireNode(lhs) ? lhs : null;
	const rhsStr = explainRhs(rhs, lhsNode);

	if (lhsNode && lhsNode.node_type === "CardAttributeNode") {
		return formatCardAttributeExplanation(lhsNode, op, opStr, rhsStr, rhs);
	}

	const lhsStr = lhsNode ? explain(lhsNode) : valueToString(lhs);
	return `${lhsStr} ${opStr} ${rhsStr}`;
}

function explainNary(node: WireNode): string {
	const operands = Array.isArray(node.kwargs.operands) ? node.kwargs.operands.filter(isWireNode) : [];
	if (operands.length === 0) {
		return "";
	}
	if (operands.length === 1) {
		return explain(operands[0] as WireNode);
	}
	const parts = operands.map((op) => {
		let explanation = explain(op);
		// An AndNode with multiple parts needs parens in OR context.
		if (
			node.node_type === "OrNode" &&
			op.node_type === "AndNode" &&
			Array.isArray(op.kwargs.operands) &&
			op.kwargs.operands.length > 1
		) {
			explanation = `(${explanation})`;
		}
		return explanation;
	});
	// A TrueNode explains to "" — it is not a constraint, so it has no clause to
	// contribute. Joining it anyway produced a dangling conjunction: an empty
	// quoted string is a TrueNode, so `urza''` rendered as "the name contains
	// Urza and " with nothing after the "and". Drop empty parts rather than
	// special-casing TrueNode, so anything else that explains to nothing is
	// covered too.
	const clauses = parts.filter((part) => part !== "");
	if (clauses.length === 0) {
		return "";
	}
	if (clauses.length === 1) {
		return clauses[0] as string;
	}
	if (node.node_type === "OrNode") {
		return `(${clauses.join(" or ")})`;
	}
	return clauses.join(" and ");
}

function explain(node: WireNode): string {
	switch (node.node_type) {
		case "TrueNode":
			return "";
		case "AndNode":
		case "OrNode":
			return explainNary(node);
		case "NotNode": {
			const operand = node.kwargs.operand;
			return `not (${isWireNode(operand) ? explain(operand) : ""})`;
		}
		case "ExactNameNode":
			return `exact name is "${valueToString(node.kwargs.value)}"`;
		case "StringValueNode":
		case "CollatedNameValueNode":
		case "NumericValueNode":
		case "ManaValueNode":
		case "RegexValueNode":
			return valueToString(node.kwargs.value);
		case "AttributeNode":
			return typeof node.kwargs.attribute_name === "string" ? node.kwargs.attribute_name.replace(/_/g, " ") : "";
		case "CardAttributeNode":
			return ATTRIBUTE_NAME_MAP[attributeName(node)] ?? attributeName(node).replace(/_/g, " ");
		case "BinaryOperatorNode":
		case "CardBinaryOperatorNode":
			return explainBinary(node);
		default:
			return "";
	}
}

/**
 * Human-readable explanation of an engine-wire filter tree, mirroring
 * upstream's parsed_query.to_human_explanation(). Total: unrecognized shapes
 * explain as "" rather than throwing (the explanation must never take the
 * search down with it).
 */
export function explainWireTree(tree: unknown): string {
	return isWireNode(tree) ? explain(tree) : "";
}
