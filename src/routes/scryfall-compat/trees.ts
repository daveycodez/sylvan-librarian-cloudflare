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
 * `/cards/:code/:number` — one printing by set code and collector number.
 *
 * `=` on `collector_number`, the TEXT column, not `:` on `collector_number_int`: Scryfall's
 * collector numbers include "1a", "12★" and "A-42", none of which are integers.
 */
export function setAndCollectorNumber(setCode: string, collectorNumber: string): string {
	return wire(and(textEquals("card_set_code", "set", setCode), textEquals("collector_number", "cn", collectorNumber)));
}

/**
 * A collection identifier's `name`, optionally within a set.
 *
 * `=` on `card_name`, which is the PRINTED name, matching upstream's
 * `lower(card_name) = lower(%(name)s)`. Upstream also accepts the front half of a `Front // Back`
 * name here; that half is handled by the caller falling back to the exact-name engine path, which
 * folds and matches either face.
 */
export function cardName(name: string, setCode?: string): string {
	const clauses = [textEquals("card_name", "name", name)];
	if (setCode) clauses.push(textEquals("card_set_code", "set", setCode));
	return wire(and(...clauses));
}
