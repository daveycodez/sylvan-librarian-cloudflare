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
	type DirectiveFound,
	DirectiveNode,
	flattenNestedOperations,
	NotNode,
	OrNode,
	Query,
	type QueryNode,
	RegexValueNode,
	StringValueNode,
	TrueNode,
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
	// Frame-effect (stored in card_frame_data). is:colorshifted == frame:colorshifted exactly (45).
	["is\u0000colorshifted", "frame:colorshifted"],
	// ── Land cycles: one alphabetized segment ────────────────────────────────
	// creatureland/manland keep the oracle-text heuristic: 48/49 vs Scryfall,
	// 0 false positives (the one miss is Alchemy-only and absent here).
	// `o:become` (substring), NOT `o:becomes` -- the looser form also catches
	// Crawling Barrens; the "still a land" clause keeps false positives at 0.
	// Backed by the community cycle/parent tags in Scryfall's oracle-tags bulk
	// export; ancestor propagation makes parent slugs self-updating as new
	// cycles are tagged. Plain parent tags preferred where they exist. Upstream
	// accepts deviations from Scryfall's own is: membership as community
	// sentiment -- otag:shockland includes Multiversal Passage, otag:gainland
	// reaches newer enters-tapped-gain-life cycles Scryfall's list lacks.
	["is\u0000battleland", "otag:cycle-tangoland"], // 10
	["is\u0000bondland", "otag:cycle-bondland"], // 10
	["is\u0000bounceland", "otag:bounceland"], // 17, exact
	["is\u0000canopyland", "otag:cycle-horizon-land"], // 6, exact
	["is\u0000checkland", "otag:cycle-checkland"], // 10, exact
	["is\u0000creatureland", "t:land o:become o:creature o:/still a.* land/"],
	["is\u0000dual", "otag:cycle-abu-dual-land"], // 10, the ABUR duals, exact
	["is\u0000fastland", "otag:cycle-fastland"], // 10, exact
	["is\u0000fetchland", "otag:cycle-fetchland"], // 10, exact
	["is\u0000filterland", "otag:cycle-hybrid-filterland or otag:cycle-ody-filterland"], // 20 vs 22
	["is\u0000gainland", "otag:gainland"], // 42, self-updating superset of Scryfall's 15
	["is\u0000manland", "t:land o:become o:creature o:/still a.* land/"],
	["is\u0000painland", "otag:cycle-painland"], // 10, exact
	["is\u0000scryland", "otag:cycle-block-ths-scry-land"], // 10, exact
	// shadowland/snarl: the reveal-or-tapped lands that reveal a BASIC LAND TYPE
	// card -- the basic-type regex is what separates them from the Lorwyn-style
	// typal reveal-lands, which reveal a CREATURE-type card and otherwise share
	// the wording. 10, name-verified (5 shadowlands + 5 snarls); no cycle tag
	// exists for the SOI half.
	["is\u0000shadowland", "t:land o:/reveal an? (Plains|Island|Swamp|Mountain|Forest)/"],
	["is\u0000shockland", "otag:shockland"], // 11, includes Multiversal Passage
	["is\u0000slowland", "otag:cycle-slowland"], // 10, exact
	["is\u0000snarl", "t:land o:/reveal an? (Plains|Island|Swamp|Mountain|Forest)/"], // same family
	["is\u0000storageland", "otag:cycle-fem-storage-land or otag:cycle-mmq-storage-land or otag:cycle-tsp-storage-land"], // 15 vs 12
	["is\u0000tangoland", "otag:cycle-tangoland"], // 10; Scryfall accepts both names
	["is\u0000triland", "otag:cycle-ala-shardland or otag:cycle-ktk-wedgeland"], // 10, name-verified
	["is\u0000triome", "otag:cycle-iko-triome or otag:cycle-snc-triland"], // 10, name-verified
	// ── Non-land derivables ──────────────────────────────────────────────────
	// Commander eligibility: legendary permanents with a printed toughness
	// (creatures, Vehicles, Spacecraft -- toughness>=0, the parser-friendly
	// spelling of toughness>-1; no legendary prints negative toughness and *
	// compares as 0 on both engines) plus Backgrounds, plus rules text granting
	// eligibility outright, MINUS the commander banlist.
	[
		"is\u0000commander",
		'((t:legendary (toughness>=0 or t:background)) or o:"can be your commander") -banned:commander',
	],
	["is\u0000companion", "kw:companion"], // 10, name-verified
	["is\u0000class", "t:class"], // 34, equals Scryfall's paper count exactly
	// is:adventure is LAYOUT semantics by Scryfall's own definition -- it equals
	// `t:adventure or t:omen` there (164 = 164; Omen cards use the adventure
	// layout with an Omen-typed face), so layout is the faithful mirror.
	["is\u0000adventure", "layout:adventure"],
	["is\u0000frenchvanilla", "otag:french-vanilla"], // community tag, ~+233 looser than "keywords only"
	// The community tag tracks is:modal far better than the mode-introducing
	// wording did, and is cheaper to evaluate: scored on Scryfall's corpus
	// against their own is:modal (800 cards), otag:modal disagrees on 9 while
	// the 'o:"choose one" or ...' union it replaces disagrees on 197.
	["is\u0000modal", "otag:modal"],
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

/** One directive as found in the query: name, value, and whether it was nested. */
/**
 * Remove directive leaves, appending them to `found` in source order.
 *
 * Returns null when the node vanishes entirely (it WAS a directive, or a
 * compound made only of directives). A directive is removed as if never
 * written: inside an Or it does not make the Or true, and a negated directive
 * is still just a directive — Scryfall ignores the negation, so `-unique:art`
 * dedups by artwork exactly as `unique:art` does.
 *
 * `nested` marks directives under an Or or a negation. A directive always
 * applies to the WHOLE search, so one written inside such a group LOOKS scoped
 * and is not; the route layer turns the flag into an explicit warning rather
 * than a silent surprise. Parenthesised AND groups do not count — conjunction
 * is flat, so `(t:goblin sort:x) t:elf` means exactly `t:goblin sort:x t:elf`.
 */
function stripDirectives(node: QueryNode, found: DirectiveFound[], nested: boolean): QueryNode | null {
	if (node instanceof DirectiveNode) {
		found.push({ name: node.name, value: node.value, nested });
		return null;
	}
	if (node instanceof AndNode || node instanceof OrNode) {
		const innerNested = nested || node instanceof OrNode;
		const ops = node.operands.map((op) => stripDirectives(op, found, innerNested));
		const kept = ops.filter((op): op is QueryNode => op !== null);
		if (kept.length === 0) {
			return null;
		}
		if (kept.length === 1) {
			return kept[0] as QueryNode;
		}
		const unchanged = kept.length === node.operands.length && kept.every((op, i) => op === node.operands[i]);
		if (unchanged) {
			return node;
		}
		return node instanceof AndNode ? new AndNode(kept) : new OrNode(kept);
	}
	if (node instanceof NotNode) {
		const inner = stripDirectives(node.operand, found, true);
		if (inner === null) {
			return null;
		}
		return inner === node.operand ? node : new NotNode(inner);
	}
	return node;
}

/**
 * Strip result-shape directives from the filter tree, returning them alongside it.
 *
 * A query that is nothing but directives filters as the empty query does.
 */
export function extractDirectives(query: Query): { query: Query; directives: DirectiveFound[] } {
	const found: DirectiveFound[] = [];
	const root = stripDirectives(query.root, found, false);
	if (found.length === 0) {
		return { query, directives: [] };
	}
	return { query: new Query(root ?? new TrueNode()), directives: found };
}

// The post-parse rewrite pipeline, applied in order at the shared parse seam.
const REWRITE_PASSES: ReadonlyArray<(q: Query) => Query> = [expandDerivedPredicates, lowerLiteralRegexes];

/** Apply every post-parse AST rewrite, in order. The single seam both parsers call. */
export function rewriteQuery(queryIn: Query): Query {
	// Strip first: a directive is not a filter, so no pass should ever see one.
	// The pairs are attached AFTER, because each pass returns a fresh Query.
	const { query: stripped, directives } = extractDirectives(queryIn);
	let query = stripped;
	for (const rewritePass of REWRITE_PASSES) {
		query = rewritePass(query);
	}
	query.directives = directives;
	return query;
}
