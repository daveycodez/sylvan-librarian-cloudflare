// Filter trees for the `/cards/*` lookups that are queries rather than id lookups.
//
// Built BY HAND rather than by running the parser, for two reasons:
//
//   - Cost. `POST /cards/collection` resolves up to 75 identifiers, and parsing 75 queries in the
//     request isolate would spend the free plan's 10ms CPU budget on work whose answer is fixed.
//     These shapes are not user input; they are three known trees with values substituted.
//   - Honesty. `set:lea cn:1` parses `cn` to `collector_number_int`, the NUMERIC column, which
//     silently fails to match "1a", "★" and every other collector number that is not an integer.
//     `=` is the operator that selects the TEXT column, and picking it deliberately here is
//     clearer than relying on the parser to have done so.
//
// The shapes are pinned against the real parser in tests/routes/scryfall-trees.test.ts: a tree
// this file builds must equal the tree `parseQuery` produces for the equivalent query string, or
// the engine is being handed something no query could produce.

import type { FilterValue } from "../../parser";
import { canonicalStringify } from "../../parser";

/** A parser wire node. */
type Node = Record<string, unknown>;

/**
 * Through `canonicalStringify`, the same serializer the parsed path uses.
 *
 * Not cosmetic: it is what lets tests/routes/scryfall-trees.test.ts compare a tree built here
 * against the one `parseWithDirectives` produces for the equivalent query, byte for byte. Two
 * key orders would make that comparison structural and therefore weaker.
 */
function wire(node: Node): string {
	return canonicalStringify(node as unknown as FilterValue);
}

function attribute(column: string, alias: string): Node {
	return { node_type: "CardAttributeNode", kwargs: { attribute_name: column, original_attribute: alias } };
}

/** `<column> = "<value>"` — exact match on a TEXT column. */
function textEquals(column: string, alias: string, value: string): Node {
	return {
		node_type: "CardBinaryOperatorNode",
		kwargs: {
			lhs: attribute(column, alias),
			op: "=",
			rhs: { node_type: "StringValueNode", kwargs: { value } },
		},
	};
}

function and(...operands: Node[]): Node {
	return operands.length === 1 ? (operands[0] as Node) : { node_type: "AndNode", kwargs: { operands } };
}

/** Every card, unfiltered — the `/cards` listing. */
export const TRUE_TREE = wire({ node_type: "TrueNode", kwargs: {} });

/**
 * `/cards/:code/:number(/:lang)` — one printing by set code, collector number and language.
 *
 * `=` on `collector_number`, the TEXT column, not `:` on `collector_number_int`: Scryfall's
 * collector numbers include "1a", "12★" and "A-42", none of which are integers.
 *
 * The language is part of the QUERY, like upstream's SQL filter, defaulting to "en" exactly as
 * Scryfall defaults the URL segment — and the default is EMITTED, never omitted. Foreign printings
 * share a set code and collector number with their English row, so a lang-less lookup would
 * resolve whichever row the engine happened to prefer. That implicit English is also what the
 * collection route's `{set, collector_number}` identifiers depend on: they come through here with
 * the default and must keep doing so.
 */
export function setAndCollectorNumber(setCode: string, collectorNumber: string, lang = "en"): string {
	return wire(
		and(
			textEquals("card_set_code", "set", setCode),
			textEquals("collector_number", "cn", collectorNumber),
			textEquals("card_lang", "lang", lang),
		),
	);
}

// A collection identifier's `name` HAS NO TREE HERE, deliberately. It was `name="…"`, which is
// the CONTAINMENT operator: `{"name":"Delver of Secrets"}` answered `Literal Delver of Secrets`
// (unk/CU06), because the containment matched it too and the edhrec order this file's caller asks
// for put it first. The identifier is an exact NAME lookup with its own key rule and its own
// ranking, neither of which a filter tree can express — it goes through the engine's
// `collection_card_by_name` instead. See `resolveIdentifiers`.
