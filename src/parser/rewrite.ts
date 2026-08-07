/**
 * Port of api/parsing/rewrite.py — post-parse AST rewrites.
 *
 * Two passes, applied in order at the shared parse seam:
 *  1. expand_derived_predicates — `is:` / frame synonyms re-parsed from DSL strings
 *  2. lower_literal_regexes — plain-literal `field:/regex/` leaves become substrings
 */

import { CardAttributeNode } from "./card-query-nodes";
import {
	AndNode,
	BinaryOperatorNode,
	flattenNestedOperations,
	NotNode,
	OrNode,
	Query,
	type QueryNode,
	RegexValueNode,
	StringValueNode,
	type ValueNode,
} from "./nodes";
import { parseQuery } from "./parser";
import { pyLower } from "./pystr";

// (original alias, lowercased value) -> expansion DSL string. Mirrors
// rewrite._DERIVED_EXPANSIONS exactly (validated upstream against Scryfall).
const DERIVED_EXPANSIONS: ReadonlyMap<string, string> = new Map([
	["frame\u0000modern", "frame:2003"],
	["frame\u0000old", "frame:1993 or frame:1997"],
	["frame\u0000new", "frame:2003 or frame:2015 or frame:future"],
	["is\u0000old", "frame:1993 or frame:1997"],
	["is\u0000new", "frame:2015"],
	["is\u0000historic", "t:legendary or t:artifact or t:saga"],
	["is\u0000permanent", "t:creature or t:artifact or t:enchantment or t:land or t:planeswalker or t:battle"],
	["is\u0000party", "t:creature (t:cleric or t:rogue or t:warrior or t:wizard or kw:changeling)"],
	["is\u0000outlaw", "t:assassin or t:mercenary or t:pirate or t:rogue or t:warlock or kw:changeling"],
	["is\u0000vanilla", 't:creature o=""'],
	["is\u0000bear", "t:creature pow=2 tou=2 cmc=2"],
	["is\u0000split", "layout:split"],
	["is\u0000flip", "layout:flip"],
	["is\u0000transform", "layout:transform"],
	["is\u0000mdfc", "layout:modal_dfc"],
	["is\u0000meld", "layout:meld"],
	["is\u0000leveler", "layout:leveler"],
	["is\u0000dfc", "layout:transform or layout:modal_dfc or layout:meld"],
	["is\u0000colorshifted", "frame:colorshifted"],
	["is\u0000manland", "t:land o:become o:creature o:/still a.* land/"],
]);

function makeKey(alias: string, value: string): string {
	return `${alias}\u0000${value}`;
}

/** Return the (alias, value) key for a `field:value` leaf eligible for rewriting, else null. */
function leafKey(node: QueryNode): string | null {
	if (!(node instanceof BinaryOperatorNode) || node.operator !== ":") {
		return null;
	}
	// Python: getattr(node.lhs, "original_attribute", None)
	const alias = node.lhs instanceof CardAttributeNode ? node.lhs.originalAttribute : null;
	const value = (node.rhs as Partial<ValueNode>).value;
	if (alias === null || typeof value !== "string") {
		return null;
	}
	return makeKey(alias, pyLower(value));
}

/** Parse an expansion DSL string into a subtree (the production parser's output root). */
function parseExpansion(dsl: string): QueryNode {
	return parseQuery(dsl).root;
}

/** Expand derived-predicate leaves in `node`; returns [node, changed]. */
function expand(node: QueryNode, inProgress: ReadonlySet<string>): [QueryNode, boolean] {
	const cls = (node as object).constructor;
	if (cls === AndNode || cls === OrNode) {
		let changed = false;
		const operands: QueryNode[] = [];
		for (const op of (node as AndNode | OrNode).operands) {
			const [newOp, opChanged] = expand(op, inProgress);
			operands.push(newOp);
			changed ||= opChanged;
		}
		return changed ? [cls === AndNode ? new AndNode(operands) : new OrNode(operands), true] : [node, false];
	}
	if (cls === NotNode) {
		const [newOp, changed] = expand((node as NotNode).operand, inProgress);
		return changed ? [new NotNode(newOp), true] : [node, false];
	}
	const key = leafKey(node);
	if (key !== null && DERIVED_EXPANSIONS.has(key) && !inProgress.has(key)) {
		// Recurse into the expansion so a definition may itself reference another
		// derived predicate; `inProgress` breaks any (mis)configured cycle.
		const nested = new Set(inProgress);
		nested.add(key);
		const [subtree] = expand(parseExpansion(DERIVED_EXPANSIONS.get(key) as string), nested);
		return [subtree, true];
	}
	return [node, false];
}

const REGEX_METACHARS = new Set(".*+?()[]{}|^$");

function isAsciiAlnum(c: string): boolean {
	return /^[0-9A-Za-z]$/.test(c);
}

/**
 * The exact substring an unanchored, metacharacter-free regex matches, else null.
 * Mirrors rewrite._regex_plain_literal (and the engine's regex_tier classification).
 */
export function regexPlainLiteral(pattern: string): string | null {
	const out: string[] = [];
	const chars = [...pattern];
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i] as string;
		if (c === "\\") {
			i++;
			const nxt = chars[i];
			if (nxt === undefined || isAsciiAlnum(nxt)) {
				return null; // class escape (\d \w \b …) or a dangling backslash
			}
			out.push(nxt);
		} else if (REGEX_METACHARS.has(c)) {
			return null;
		} else {
			out.push(c);
		}
	}
	const joined = out.join("");
	return joined === "" ? null : joined; // empty pattern matches everything -> leave it a regex
}

/** Rewrite plain-literal regex leaves to substring leaves, in place. */
function lowerRegexLeaves(node: QueryNode): void {
	if (node instanceof AndNode || node instanceof OrNode) {
		for (const op of node.operands) lowerRegexLeaves(op);
	} else if (node instanceof NotNode) {
		lowerRegexLeaves(node.operand);
	} else if (node instanceof BinaryOperatorNode && node.operator === ":" && node.rhs instanceof RegexValueNode) {
		const literal = regexPlainLiteral(node.rhs.value);
		if (literal !== null) {
			node.rhs = new StringValueNode(literal);
		}
	}
}

/** Rewrite plain-literal regex leaves (`o:/foo/` -> `o:foo`) to substring leaves. */
export function lowerLiteralRegexes(query: Query): Query {
	lowerRegexLeaves(query.root);
	return query;
}

/** Rewrite derived-predicate leaves (frame synonyms, derivable `is:`) into primitive subtrees. */
export function expandDerivedPredicates(query: Query): Query {
	const [root, changed] = expand(query.root, new Set());
	if (!changed) {
		return query;
	}
	return flattenNestedOperations(new Query(root));
}

// The post-parse rewrite pipeline, applied in order at the shared parse seam.
const REWRITE_PASSES: ReadonlyArray<(q: Query) => Query> = [expandDerivedPredicates, lowerLiteralRegexes];

/** Apply every post-parse AST rewrite, in order. The single seam both parsers call. */
export function rewriteQuery(queryIn: Query): Query {
	let query = queryIn;
	for (const rewritePass of REWRITE_PASSES) {
		query = rewritePass(query);
	}
	return query;
}
