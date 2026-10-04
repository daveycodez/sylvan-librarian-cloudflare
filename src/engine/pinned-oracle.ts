/**
 * Does this query pin ONE oracle id? Then one partition owns every row it can match.
 *
 * Measured 2026-09-21 on DeckGen: 24,595 of the day's 43,055 `/cards/search` requests (57%) were
 * `oracleid:<uuid>` — mtgseeker's "all printings of this card" panel — and each ran the full
 * two-phase gather, 1 + (N-1) Durable Object requests. Partitioning is `fnv1a64(oracle_id) % N`
 * (`partitionOfOracleId`), the same rule the coordinator assigns every draft by, canonical and
 * annex alike, so the owning partition's OWN store answers exactly: same total, same rows, same
 * order, for one request instead of N. That holds whatever N grows to.
 *
 * Only CONJUNCTIONS are walked. `AndNode` operands each narrow the match set, so a pinned leaf
 * anywhere among them pins the whole query — including the `NOT is:extra` conjuncts the extras
 * gate adds. An `OrNode` can widen past the id, a `NotNode` excludes it, and any other operator on
 * the attribute (`!=`, `<`) does not name one row set; none of those pin. Two different pinned ids
 * match nothing at all, so the first one found is as right as any. The wire tree is the engine's
 * (`canonicalStringify`), never the parser's AST.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WireNode {
	node_type?: string;
	kwargs?: Record<string, unknown>;
}

function pinnedIn(node: unknown, attribute = "oracle_id"): string | null {
	if (!node || typeof node !== "object") return null;
	const { node_type, kwargs } = node as WireNode;
	if (!kwargs) return null;
	if (node_type === "AndNode") {
		const operands = kwargs.operands;
		if (!Array.isArray(operands)) return null;
		for (const operand of operands) {
			const pinned = pinnedIn(operand, attribute);
			if (pinned !== null) return pinned;
		}
		return null;
	}
	if (node_type !== "CardBinaryOperatorNode") return null;
	if (kwargs.op !== ":" && kwargs.op !== "=") return null;
	const lhs = kwargs.lhs as WireNode | undefined;
	const rhs = kwargs.rhs as WireNode | undefined;
	if (lhs?.node_type !== "CardAttributeNode" || lhs.kwargs?.attribute_name !== attribute) return null;
	if (rhs?.node_type !== "StringValueNode") return null;
	const value = rhs.kwargs?.value;
	return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

/** The oracle id a filter tree pins the whole query to, lowercased, or null. */
export function pinnedOracleId(filterTreeJson: string): string | null {
	try {
		return pinnedIn(JSON.parse(filterTreeJson));
	} catch {
		return null;
	}
}

/**
 * Does this query require ONE printing by its Scryfall id (`scryfallid:<uuid>`)? Then every row it
 * can match is that printing, and that printing lives in exactly one partition — the one the
 * routing filter's printing-id keys name (routing-filter.ts `scryfallIdKey`, the hint `/cards/<id>`
 * already routes by).
 *
 * The same walk and the same "first one found" rule as `pinnedOracleId`. Unlike an oracle id, a
 * printing id says nothing about its partition by itself, so the caller treats the filter's answer
 * as a HINT and trusts the pinned page only when it is not empty — see
 * `PartitionedEngine.pinnedPrintingPartition`.
 *
 * `illustrationid:` is deliberately NOT pinned: an artwork is shared across oracle cards (a card
 * and its art-series card, a token and its reprints), which live in different partitions, and
 * the filter stores only the lowest one.
 */
export function pinnedScryfallId(filterTreeJson: string): string | null {
	// Cheap before the parse: most trees carry no such leaf.
	if (!filterTreeJson.includes('"scryfall_id"')) return null;
	try {
		return pinnedIn(JSON.parse(filterTreeJson), "scryfall_id");
	} catch {
		return null;
	}
}

/**
 * Does this query require ONE exact name (`!"Name"`)? Then its value — already collated by the
 * parser (`ExactNameNode.kwargs`) — is a name the routing filter may place in one partition
 * (backlog n6): the site's card page searches `!"Name"&unique=printing`, and every such search
 * gathered all N partitions for a card that lives in one.
 *
 * Same walk as `pinnedOracleId` — conjunctions only, since an `OrNode` can widen past the name and
 * a `NotNode` excludes it — and the same "first one found" rule: two different required names
 * match nothing at all. Returns the COLLATED value; the caller keys it.
 */
function exactNameIn(node: unknown): string | null {
	if (!node || typeof node !== "object") return null;
	const { node_type, kwargs } = node as WireNode;
	if (!kwargs) return null;
	if (node_type === "AndNode") {
		const operands = kwargs.operands;
		if (!Array.isArray(operands)) return null;
		for (const operand of operands) {
			const pinned = exactNameIn(operand);
			if (pinned !== null) return pinned;
		}
		return null;
	}
	if (node_type !== "ExactNameNode") return null;
	const value = kwargs.value;
	return typeof value === "string" && value !== "" ? value : null;
}

/** The collated exact name a filter tree requires of every row, or null. */
export function pinnedExactName(filterTreeJson: string): string | null {
	try {
		return exactNameIn(JSON.parse(filterTreeJson));
	} catch {
		return null;
	}
}
