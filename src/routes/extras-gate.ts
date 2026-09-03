// The `include_extras` / `include_variations` gate — Scryfall's two default-lane exclusions, and
// the measured rules that turn each of them back on.
//
// SHARED BY BOTH SEARCH SURFACES, which is the whole reason it is a module. `/cards/search` grew
// this rule first (it is the surface that has the two parameters at all) and `/search` — this
// project's own web-UI route — had NO extras handling whatsoever until the corpus grew.
//
// That gap was invisible while the store was built from Scryfall's `default_cards` bulk, which
// carries no art-series printings at all. `all_cards` carries 2,650 of them, and the day the
// importer switched, `/search?q=lightning bolt` started answering three printings where
// `/cards/search` and api.scryfall.com both answer two — the third being astx/76, a Strixhaven Art
// Series card. A latent gap, made visible by data rather than by code.
//
// So the rule lives HERE and both routes call `applyExtrasGate`. A second implementation of a rule
// this heavily measured would be a rule that drifts: every constant below is a table copied down
// from ~119 serial probes against api.scryfall.com, not something a reader can re-derive by
// reasoning about the values.

import type { Engine } from "../engine/types";
import type { ExpandedDerivedTerm, LoweredRegexTerm } from "../parser";
import { EXTRA_IS_TAG } from "../parser/db-info";

/** What a query's parse tree says about Scryfall's `include_extras` auto-enable. */
interface ExtrasTriggers {
	/** An UNCONDITIONAL trigger term is present: extras are on whatever the caller asked for. */
	forced: boolean;
	/** Lowercased set codes named by `e:`/`s:`/`set:` — the CONDITIONAL trigger. */
	sets: string[];
}

/** Attributes whose mere presence forces `include_extras=true`, whatever their value. */
const UNCONDITIONAL_EXTRAS_ATTRIBUTES: ReadonlySet<string> = new Set([
	"card_artist", // a:
	"card_watermark", // wm:
	"card_layout", // layout:
]);

/**
 * The STORED `is:` values that force extras on — the ones the importer keeps on the row, which
 * survive the rewrite and reach this walk as `card_is_tags` leaves.
 *
 * All 32 were probed for the `include_extras` echo, one query each (2026-08-16, re-run 2026-08-16
 * with the echo read directly). Five fire:
 *
 *   is:extra -> true    is:oversized -> true    is:reserved -> true
 *   is:rebalanced -> true    is:glossy -> true
 *
 * and the other 27 echo false, including the ones that plainly CONTAIN extras and so would look
 * like triggers to a count-based test: `is:variation` is 93 bare against 97 with the flag,
 * `is:convention` 63 against 67, `is:judge` 173 against 176, `is:league` 6 against 18.
 *
 * `glossy` WAS absent, and its absence is the exact hazard of measuring this by counts. The first
 * pass called eight values (buyabox, gameday, giftbox, glossy, …) "unfalsifiable" because they hold
 * no extras, so the flag cannot move their count — but the ECHO moves anyway, because the rule is
 * syntactic. `is:glossy` holds 7 printings and not one of them is `is:extra`, and Scryfall still
 * echoes `include_extras=true` for it. The echo is the measurement; the count never was.
 */
const UNCONDITIONAL_EXTRAS_IS_TAGS: ReadonlySet<string> = new Set([
	EXTRA_IS_TAG,
	"glossy",
	"oversized",
	"reserved",
	"rebalanced",
	// The 2026-09-03 sweep that took ARRAY_IS_TAGS from 24 rows to 106 (db-info.ts) was probed the
	// same way — `<term> or cmc=3` with include_extras=false, the verdict read out of the next_page
	// echo, controls `is:glossy` (fires) and `is:convention`/`is:ffx`/`is:setpromo` (quiet) agreeing
	// with what was already known. THREE of the 93 new values fire; the other 90 echo false. And
	// the file's warning held exactly: 65 of those 90 have a bare count EQUAL to their
	// include_extras count (their populations hold no extras), and a count-based pass had listed
	// every one of them as a trigger before the echo was read.
	//
	// `surgefoil` and `thick` are the two whose populations DO hold extras (token-set and
	// memorabilia printings), so before this they were the two values the local store answered
	// short on: `is:surgefoil` 1,521 against 1,584, `is:thick` 72 against 88, and both exact with
	// the flag forced. `draculaseries` holds none and fires anyway — the `is:glossy` shape again.
	"surgefoil",
	"thick",
	"draculaseries",
]);

/**
 * The DERIVED `is:`/`has:` terms that force extras on — the ones `expandDerivedPredicates` replaces
 * with a subtree, so that by the time this walk runs the spelling is gone.
 *
 * IT IS A MEASURED LIST AND NOT A RULE, and the probe was run to find a rule. All 90 values the
 * rewrite expands (77 `is:`, 12 `has:`, 3 `frame:`) were probed one at a time against
 * api.scryfall.com on 2026-08-16 — `<term> or cmc=3` sent with `include_extras=false`, reading the
 * flag back out of the `next_page` echo — and re-probed against a second base (`<term> or t:goblin`)
 * with identical verdicts. Twelve fire; the other 78 do not.
 *
 * EVERY STRUCTURAL HYPOTHESIS IS REFUTED BY THE TABLE, in both directions:
 *
 *  - NOT "what it lowers to". `is:split`, `is:flip`, `is:transform`, `is:tdfc`, `is:meld`,
 *    `is:leveler` and `is:adventure` all lower to `layout:`, which is an unconditional trigger, and
 *    Scryfall fires for none of them. `has:artist` lowers to `artist:/./` and does not fire either.
 *  - NOT "the population contains extras". `is:mdfc` fires with 327 printings and ZERO of them
 *    `is:extra`; `is:glossy` fires with 7 and zero. `is:stamped` does NOT fire with 696 extras out
 *    of 3,195 — the largest extras share in the table.
 *  - NOT the layout family. `is:mdfc` fires while `is:transform` and `is:meld` do not, and `is:dfc`
 *    — which overlaps both — fires. (`is:dfc` is NOT the union of the three, measured separately:
 *    it excludes meld outright and reaches art_series, double_faced_token and reversible_card. See
 *    `DERIVED_EXPANSIONS`. The refutation stands either way; the union was the wrong name for it.)
 *
 * So it is Scryfall's own per-value table, and the honest way to mirror it is to copy it down.
 * Re-derive it by re-running the probe, not by reasoning about the values.
 */
const EXTRAS_DERIVED_TRIGGERS: ReadonlySet<string> = new Set([
	"has:glossy", // == is:glossy, and it fires there too
	"has:watermark", // == is:watermark; `wm:` is an unconditional trigger and this agrees with it
	"is:artseries",
	"is:augmentation",
	"is:dfc",
	"is:funny",
	"is:host",
	"is:mdfc",
	"is:planar",
	"is:reversible",
	"is:token",
	"is:watermark",
]);

/**
 * The `t:` VALUES that force extras on — Scryfall's syntax docs say the vanguard, plane, scheme
 * and phenomenon classes are "hidden by default… You must either search for their type (using the
 * type: keyword) or a set that contains them", and this table is that sentence measured rather
 * than believed, because the docs' list and the echo's list are NOT the same list.
 *
 * All ten candidate values were probed for the `include_extras` echo, one query each (2026-08-27,
 * `<term> or cmc=3` sent with `include_extras=false`, the verdict read out of the `next_page`
 * echo; `plane`, `vanguard` and `emblem` re-probed against `or t:goblin` with identical
 * verdicts). Six fire:
 *
 *   t:token -> true    t:plane -> true     t:phenomenon -> true
 *   t:scheme -> true   t:vanguard -> true  t:emblem -> true
 *
 * and the other four echo false — t:dungeon, t:attraction, t:contraption, t:sticker (t:stickers
 * too) — every one of them a card class as "extra" as the six, which is why the docs' sentence
 * could not be trusted as the rule. `t:creature` and `t:goblin` were probed as controls and echo
 * false. A per-value table again: re-derive it by re-running the probe, not by reasoning.
 *
 * `or` propagates (`t:plane or t:goblin` echoes true) and the regex spelling removes the trigger
 * exactly as it does for `t:token` — `t:/plane/ or cmc=3` echoes false — so the `lowered` check
 * below covers the new values through the same `family()` unification. NEGATION DOES NOT
 * PROPAGATE, unlike `-e:lea t:land` and `-f:premodern t:land`: `-t:plane t:land` echoes false and
 * so does `-t:token t:land` (measured 2026-08-27). This walk does not track `Not` and fires on
 * all six under negation — that was already true of `t:token` before the other five joined it, a
 * recorded residual and not a new one.
 */
const EXTRAS_TYPE_TRIGGERS: ReadonlySet<string> = new Set([
	"token",
	"plane",
	"phenomenon",
	"scheme",
	"vanguard",
	"emblem",
]);

/**
 * The `is:` value behind `include_variations`, and the whole of that gate's auto-enable rule.
 *
 * Spelled here rather than imported from `db-info` beside `EXTRA_IS_TAG` because it is not the same
 * kind of thing: `extra` is COMPUTED by this project's import (`COMPUTED_IS_TAGS`), while
 * `variation` is one of Scryfall's own booleans that `BOOLEAN_IS_TAGS` syncs straight off the bulk
 * row. The gate treats them alike; their provenance is not alike.
 */
const VARIATION_IS_TAG = "variation";

/** Whether the parse tree names `is:<tag>` anywhere — under `or`, `and` and negation alike. */
function mentionsIsTag(node: unknown, tag: string): boolean {
	if (!node || typeof node !== "object") return false;
	if (Array.isArray(node)) return node.some((item) => mentionsIsTag(item, tag));
	const n = node as { node_type?: string; kwargs?: Record<string, unknown> };
	if (n.node_type === "CardBinaryOperatorNode") {
		const lhs = n.kwargs?.lhs as { node_type?: string; kwargs?: Record<string, unknown> } | undefined;
		const attr =
			lhs?.node_type === "CardAttributeNode" ? (lhs.kwargs?.attribute_name as string | undefined) : undefined;
		const rhs = n.kwargs?.rhs;
		if (
			attr === "card_is_tags" &&
			Array.isArray(rhs) &&
			rhs.some((v) => typeof v === "string" && v.toLowerCase() === tag)
		) {
			return true;
		}
	}
	return Object.values(n.kwargs ?? {}).some((value) => mentionsIsTag(value, tag));
}

/**
 * Scryfall's `include_extras` AUTO-ENABLE, read off the parse tree.
 *
 * MEASURED, not inferred — ~119 serial probes against api.scryfall.com on 2026-08-16, and the
 * result contradicts the obvious hypothesis. It is NOT a property of the result set: `t:creature`,
 * `o:draw` and `ft:death` each match 1,742 / 358 / 26 extras and every one of them echoes
 * `include_extras=false`. It is a SYNTACTIC property of the terms, propagated through `or`, `and`
 * and negation alike — `e:war or e:lea` is true, `(e:lea t:creature) or t:land` is true even
 * though LEA's only extra is an enchantment that cannot be in that result, `-e:lea t:land` is true
 * and `-e:war t:land` is false. And it is a FORCE, not a default: `include_extras=false` sent
 * explicitly is overridden, in the echo and in the rows.
 *
 * Unconditional triggers: `a:`, `wm:`, `layout:`, `name:/…/`, six `t:` values (`token` and five
 * hidden card classes — see `EXTRAS_TYPE_TRIGGERS`), and four `is:` values
 * (`b:` belongs here too — this parser has no block operator, so the term cannot reach us). Each
 * fires on the TERM: `a:"Wesley Burt"` triggers although `a:"Wesley Burt" is:extra` is 0,
 * `name:/zzzqq/` matches nothing and still triggers, `layout:normal` triggers. Deliberately NOT
 * triggers, each probed: `t:` at any other value, `o:`, `o:/…/`, `t:/…/`, `cn:`, `st:`,
 * `year:`/`date:`, `border:` at every OTHER value, `frame:` at every value, `name:"literal"`, a
 * bare `name:` word, `!"Exact"`, and the other 28 `is:` values — see
 * `UNCONDITIONAL_EXTRAS_IS_TAGS`.
 *
 * `border:silver` WAS in that negative list and is a trigger; it surfaced as a lone outlier in a
 * scope calibration (`border:silver` matching the extras-INCLUDED count where every other scope
 * matched the excluded one) and the obvious explanation — that silver borders are simply extras
 * already — is wrong: only 108 of the 665 are. See the walk for the `border:gold` control.
 *
 * THE DEFAULT IS AN EXCLUSION, RE-MEASURED 2026-08-16 against the claim that it is not. Three
 * queries that cannot trigger any of the above: `t:creature` answers 51,473 bare and 55,454 with
 * `include_extras=true`, `o:draw` 12,301 against 12,858, `cmc=3` 22,832 against 23,477; and
 * `t:goblin cmc=0` — every zero-cost goblin being a token — is 404 bare and 87 with the flag. A
 * SET-SCOPED probe cannot see any of this, which is the trap: `cn:4 s:thob` answers 1 bare because
 * `s:thob` auto-enables, so reconstructing the default from set-scoped counts finds no exclusion
 * and concludes there is none.
 *
 * Conditional trigger: a set term, IFF that set holds at least one `is:extra` printing — see
 * `Engine.setsWithExtras`. Over 18 measured sets the split is perfect (lea/leb/2ed/3ed/sum 1,
 * 4ed/5ed/6ed 2, leg 4, j21 16, hbg 122, unk 506 enable; ust/ice/war/unf/por/7ed are 0 and none
 * does), and six more predicted from the local bulk before being measured were all correct.
 *
 * RANKING on the 57 set probes: this rule 57/57, the `mentionsSet` rule it replaces 20/57 — wrong
 * on every ordinary modern set. Across the non-set probes the old rule additionally missed
 * `name:/…/`, `layout:`, `t:token` and `is:extra`.
 *
 * THE REGEX SPELLING IS INVISIBLE IN THE TREE, which is why `loweredRegexTerms` is a second
 * argument rather than something this walk could find. `lowerLiteralRegexes` rewrites a
 * metacharacter-free regex into a quoted literal before the wire tree exists — upstream's rewrite,
 * compared byte for byte by the parity fixtures, so it is not negotiable — and `name:/zzzqq/` then
 * reads here exactly like `name:"zzzqq"`, `t:/token/` exactly like `t:token`.
 *
 * SCRYFALL SEPARATES BOTH PAIRS, IN OPPOSITE DIRECTIONS, and one cause produces both errors
 * (measured 2026-08-16):
 *
 *   name:/bolt/  175 = its extras-on count   name:"bolt"  157   -> the regex ADDS a trigger
 *   t:token cmc=3  6 (extras auto-on)        t:/token/ cmc=3  0 -> the regex REMOVES one
 *   is:/extra/ cmc=3 and border:/silver/ cmc=3 both answer plain `cmc=3` (22,832), echoing false
 *
 * So a `card_name` term triggers when it was written as a regex whether or not the leaf still is
 * one, and every VALUE-specific trigger fires only when it was NOT. The pairs are keyed by column
 * AND value so `t:token t:/goblin/` still reads its two terms apart; the one case they cannot
 * separate is the same column and value written both ways in one query (`t:token or t:/token/`),
 * where this suppresses and Scryfall triggers — an unreachable spelling in practice, recorded
 * rather than papered over.
 *
 * THE DERIVED SPELLING IS INVISIBLE FOR THE SAME REASON, and `expandedDerivedTerms` is the third
 * argument that restores it. `expandDerivedPredicates` replaces `is:split` with `layout:split`
 * before the wire tree exists — upstream's rewrite again, byte-compared by the same fixtures — and
 * `layout:` is an unconditional trigger while `is:split` is not: 327 there against the 347
 * `layout:split` answers. So the walk declines to fire on any leaf an expansion produced, and
 * `EXTRAS_DERIVED_TRIGGERS` fires instead for the twelve derived TERMS Scryfall does fire on. The
 * two halves are independent — `has:glossy` produces an `is:glossy` leaf that would have fired and
 * must not fire AS a leaf, and fires as a term; `is:split` produces a `layout:` leaf that must not
 * fire either way.
 */
function extrasTriggers(
	tree: unknown,
	loweredRegexTerms: readonly LoweredRegexTerm[] = [],
	expandedDerivedTerms: readonly ExpandedDerivedTerm[] = [],
): ExtrasTriggers {
	// `t:` binds to `card_types` OR `card_subtypes` depending on which vocabulary the value is in,
	// and a term lowered from a regex was bound before that lookup could run — `t:/token/` records
	// `card_types` where the serialized `t:token` reads `card_subtypes`. They are one family here,
	// which costs nothing: the value still has to match.
	const family = (attribute: string) => (attribute === "card_subtypes" ? "card_types" : attribute);
	const lowered = (attribute: string, value: string) =>
		loweredRegexTerms.some((t) => family(t.attribute) === family(attribute) && t.value === value.toLowerCase());
	// Keyed by column AND value for the same reason `lowered` is: `is:split layout:normal` must keep
	// the caller's own `layout:normal` trigger while dropping the `layout:split` the rewrite wrote.
	// The one case it cannot separate is the same column and value written both ways in one query
	// (`is:split layout:split`), where this suppresses — the identical, recorded residual.
	const expandedLeaves = expandedDerivedTerms.flatMap((t) => t.leaves);
	const derived = (attribute: string, value: string) =>
		expandedLeaves.some((t) => family(t.attribute) === family(attribute) && t.value === value.toLowerCase());
	const out: ExtrasTriggers = {
		forced:
			loweredRegexTerms.some((t) => t.attribute === "card_name") ||
			expandedDerivedTerms.some((t) => EXTRAS_DERIVED_TRIGGERS.has(t.term)),
		sets: [],
	};
	walkExtrasTriggers(tree, out, lowered, derived);
	return out;
}

/** Whether a `field:value` term was written as a `field:/regex/` the rewrite lowered. */
type LoweredCheck = (attribute: string, value: string) => boolean;

/**
 * Every string a term's rhs compares against, lowercased — the shapes a value-specific trigger has
 * to read. A type, is-tag or legality leaf serializes to a string array; `layout:`, `border:` and
 * `set:` to a `StringValueNode`; `a:`/`wm:` presence tests to a `RegexValueNode`. Anything else
 * (numeric, mana) has no string to compare and yields nothing.
 */
function termValues(rhs: unknown): string[] {
	if (Array.isArray(rhs)) return rhs.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
	const value = (rhs as { kwargs?: { value?: unknown } })?.kwargs?.value;
	return typeof value === "string" ? [value.toLowerCase()] : [];
}

function walkExtrasTriggers(node: unknown, out: ExtrasTriggers, lowered: LoweredCheck, derived: LoweredCheck): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) walkExtrasTriggers(item, out, lowered, derived);
		return;
	}
	const n = node as { node_type?: string; kwargs?: Record<string, unknown> };
	if (n.node_type === "CardBinaryOperatorNode") {
		const lhs = n.kwargs?.lhs as { node_type?: string; kwargs?: Record<string, unknown> } | undefined;
		const attr =
			lhs?.node_type === "CardAttributeNode" ? (lhs.kwargs?.attribute_name as string | undefined) : undefined;
		const rhs = n.kwargs?.rhs;
		// A term every one of whose values a derived expansion put there is not a term the caller
		// wrote, and Scryfall's rule reads what was written. `is:split` is the whole class: it leaves
		// a `layout:split` behind, `layout:` is an unconditional trigger, and `is:split` is not one.
		const values = termValues(rhs);
		const fromExpansion = values.length > 0 && values.every((v) => attr !== undefined && derived(attr, v));
		if (attr && UNCONDITIONAL_EXTRAS_ATTRIBUTES.has(attr) && !fromExpansion) out.forced = true;
		if (attr === "card_name" && (rhs as { node_type?: string })?.node_type === "RegexValueNode" && !fromExpansion) {
			out.forced = true;
		}
		// Six `t:` values and four `is:` values are the VALUE-specific triggers; both arrive as a
		// string array (the parser expands a type or is-tag term into its comparison keys).
		// `banned:` at ANY value, and `f:`/`format:`/`legal:` at exactly `premodern`. Both bind to
		// `card_legalities`, so the alias is what separates them — `banned:legacy`, `banned:vintage`,
		// `banned:modern` and `banned:pauper` all echo true while `restricted:vintage` echoes false,
		// and of the 21 format values probed one at a time `premodern` is the ONLY one that fires
		// (`legal:premodern` and `-f:premodern t:land` fire too, so it is the value and not the
		// alias, and negation does not cancel it). Measured 2026-08-16.
		// `-banned:commander` is the tail of `is:commander`'s expansion, so this is one of the four
		// triggers a derived term can leak: `is:commander` echoes false there and would fire here.
		if (attr === "card_legalities" && !fromExpansion) {
			const original = lhs?.kwargs?.original_attribute;
			if (original === "banned") out.forced = true;
			if (values.includes("premodern")) out.forced = true;
		}
		if (attr === "card_types" || attr === "card_subtypes" || attr === "card_is_tags") {
			const wanted = (v: string) =>
				attr === "card_is_tags" ? UNCONDITIONAL_EXTRAS_IS_TAGS.has(v) : EXTRAS_TYPE_TRIGGERS.has(v);
			if (values.some((v) => wanted(v) && !lowered(attr, v) && !derived(attr, v))) {
				out.forced = true;
			}
		}
		// `border:silver` — a VALUE-specific trigger on an attribute that is otherwise inert, and
		// the one term in this rule with a perfect control. `border:gold` is 0 bare and 1,373 with
		// `include_extras=true` (every gold border is a World Championship card, so the whole
		// population is memorabilia), which is what a NON-trigger on the same attribute looks like;
		// `border:silver` is 665 bare and 665 with the flag, echoing `include_extras=true` unsent,
		// with 108 of those 665 inside `is:extra`. `border:black`, `border:white` and
		// `border:borderless` echo false, as does `frame:` at every value. Measured 2026-08-16.
		if (attr === "card_border") {
			for (const value of values) {
				if (value === "silver" && !lowered(attr, value) && !derived(attr, value)) out.forced = true;
			}
		}
		if (attr === "card_set_code" && !fromExpansion) {
			for (const value of values) out.sets.push(value);
		}
	}
	for (const value of Object.values(n.kwargs ?? {})) walkExtrasTriggers(value, out, lowered, derived);
}

/**
 * `tree AND NOT is:<tag> AND NOT is:<tag>…` — the default-lane exclusions, built as tree nodes
 * rather than by rewriting the query string so a caller's own `is:extra` / `is:variation` term
 * still means what it says.
 *
 * Two gates feed this, and BOTH can be closed at once: `include_extras` contributes `is:extra` and
 * `include_variations` contributes `is:variation`. They are independent on Scryfall — `t:creature`
 * is 51,473 bare, 55,454 with extras alone, 51,523 with variations alone and 55,506 with both — so
 * the conjuncts are independent here too. They arrive as ONE flat `AndNode` rather than as nested
 * wraps because a second wrap would bury the caller's own tree an operand deeper for nothing;
 * `card_is_tags` is a `HybridTagIndex` that survives `Not`, so each term costs a narrowing arm and
 * not a physical plan the way a `SetTypeMatch` conjunct would.
 *
 * A `TrueNode` tree (the empty query, and every route that searches without one) is left ALONE:
 * those lanes have their own scoping, and wrapping `True` would change what `/cards/random` and
 * the collection lookups answer.
 */
function withoutIsTags(tree: unknown, tags: readonly string[]): unknown {
	if (tags.length === 0) return tree;
	if (!tree || typeof tree !== "object" || (tree as { node_type?: string }).node_type === "TrueNode") return tree;
	return {
		node_type: "AndNode",
		kwargs: { operands: [tree, ...tags.map(notIsTagNode)] },
	};
}

/** `NOT is:<tag>`, the one conjunct shape both the gate and the random draw exclude with. */
function notIsTagNode(tag: string): unknown {
	return {
		node_type: "NotNode",
		kwargs: {
			operand: {
				node_type: "CardBinaryOperatorNode",
				kwargs: {
					lhs: {
						node_type: "CardAttributeNode",
						kwargs: { attribute_name: "card_is_tags", original_attribute: "is" },
					},
					op: ":",
					rhs: [tag],
				},
			},
		},
	};
}

/**
 * The default-lane exclusions ALONE, as a filter tree with no caller query under them — what a
 * route searches with when it has no query at all and still must not answer from the extras class.
 *
 * `/random_search` is the caller, and it is the case `withoutIsTags`'s `TrueNode` exemption
 * deliberately does NOT cover. Those are two different questions that look like one:
 *
 *   - `/search?q=` and `/cards/random` with no `q` ask for EVERYTHING, and the exemption keeps
 *     that meaning intact. Scryfall's own bare `/cards/random` was never measured either way, so
 *     narrowing it would be an inference (see cardsRandomHandler).
 *   - `/random_search` asks for "some random cards" and has no query language to say anything
 *     else. Its answer used to contain no extras at all — not by policy but because the importer
 *     dropped the class — and 13.6% of 1,000 draws became tokens, art-series cards and
 *     memorabilia the day the corpus started carrying them. That is a REGRESSION from an import
 *     change, so restoring it is not a new policy for the route; it is the route's own behaviour.
 *
 * Spelled here rather than in the route so there is still exactly one definition of what the
 * default lane excludes: adding a third exclusion to the gate adds it to the random draw too.
 */
export function defaultLaneExclusionTree(): unknown {
	return {
		node_type: "AndNode",
		kwargs: { operands: [EXTRA_IS_TAG, VARIATION_IS_TAG].map(notIsTagNode) },
	};
}

// ─── The gate itself ─────────────────────────────────────────────────────────

/** The parse facts the gate needs that the wire tree cannot carry — see `parseWithDirectives`. */
export interface ExtrasGateSpellings {
	loweredRegexTerms: readonly LoweredRegexTerm[];
	expandedDerivedTerms: readonly ExpandedDerivedTerm[];
}

/** What the caller asked for. `/search` has neither parameter, so it passes neither. */
export interface ExtrasGateRequest {
	includeExtras?: boolean;
	includeVariations?: boolean;
}

export interface ExtrasGateResult {
	/** The tree to search, with a `NOT(is:…)` conjunct per closed gate. */
	tree: unknown;
	/** The value that was SERVED, which is also the value `/cards/search` echoes in `next_page`. */
	includeExtras: boolean;
	includeVariations: boolean;
}

/**
 * Resolve both gates against a parse tree and return the tree to search.
 *
 * ── WHY THE EXCLUSION IS A QUERY-TIME CONJUNCT ───────────────────────────────
 *
 * It used to be an ABSENCE: `passes_filters` refused memorabilia, un-sets, playtest promos and the
 * "Card" type-line family at import. That cannot reproduce `include_extras`, because there is
 * nothing left to include: `/cards/named?exact=Counters` answered 404 where Scryfall answers
 * fmsc/9, and `include_extras=true` answered nothing at all. Storing the rows and filtering them
 * here answers both.
 *
 * Spelled as `-is:extra` rather than as a set-type conjunct deliberately: `card_is_tags` is a
 * `HybridTagIndex` and composes under `Not`, so `PrintingCompose` survives the extra term; a
 * `SetTypeMatch` conjunct has no narrowing arm and would have cost three of the six physical plans
 * on EVERY query.
 *
 * ── THE EXTRAS AUTO-ENABLE, MEASURED ─────────────────────────────────────────
 *
 * Scryfall does not merely DEFAULT `include_extras` — it FORCES it, overriding an explicit
 * `include_extras=false` in both the echo and the results, whenever the parse tree syntactically
 * contains a trigger term. `extrasTriggers` is that rule; see its own comment for the ranking
 * (57/57 against 20/57 for the set-mention rule it replaced).
 *
 * The `false` branch stays a query-time conjunct rather than a flag on the wire because the
 * caller's own `is:extra` term must keep meaning what it says — see `withoutIsTags`.
 *
 * ── AND THE SAME STORY FOR `include_variations`, WITH A DIFFERENT TRIGGER RULE ─
 *
 * Measured 2026-08-16 with queries that fire no auto-enable at all: `t:creature` is 51,473 bare and
 * 51,523 with `include_variations=true`, `cmc=3` 22,832 against 22,854, `o:draw` 12,301 against
 * 12,303. So the default EXCLUDES them, exactly as it excludes extras.
 *
 * THE TRIGGER RULE IS NOT THE EXTRAS RULE, which is why this is a separate walk and not a second
 * reading of `triggers`. Every unconditional extras trigger was probed and echoes
 * `include_variations=false`: `a:"rebecca guay" t:creature` and `layout:normal cmc=3` echo
 * `extras=true var=false`, and so do `wm:`, `name:/^z/`, `t:token`, `is:extra`, `is:oversized`,
 * `is:reserved` and `is:rebalanced`. A SET term does not enable it either — `e:hho` is 21 bare and
 * 23 with the parameter, though hho auto-enables extras — so there is no conditional arm here and
 * nothing to ask the engine. The only trigger found is the caller's own `is:variation`, and it is a
 * FORCE like the extras ones: `t:creature or is:variation` sent with `include_variations=false`
 * answers 51,566 and echoes `true`.
 *
 * ── THE ASYNC ────────────────────────────────────────────────────────────────
 *
 * The only reason this is async: the ONE conditional trigger, a set term, needs
 * `Engine.setsWithExtras` to answer whether that set holds an `is:extra` printing. The table is
 * folded into the archive and cached per store generation, so it is a map lookup on every request
 * after an isolate's first set-scoped query — and it is not consulted at all unless a set term is
 * present and nothing unconditional has already forced the gate.
 */
export async function applyExtrasGate(
	engine: Pick<Engine, "setsWithExtras">,
	tree: unknown,
	spellings: ExtrasGateSpellings,
	requested: ExtrasGateRequest = {},
): Promise<ExtrasGateResult> {
	const triggers = extrasTriggers(tree, spellings.loweredRegexTerms, spellings.expandedDerivedTerms);
	let extrasForced = triggers.forced;
	if (!extrasForced && triggers.sets.length > 0) {
		const withExtras = new Set(await engine.setsWithExtras());
		extrasForced = triggers.sets.some((code) => withExtras.has(code));
	}
	const includeExtras = extrasForced || requested.includeExtras === true;
	const includeVariations = mentionsIsTag(tree, VARIATION_IS_TAG) || requested.includeVariations === true;
	return {
		tree: withoutIsTags(tree, [
			...(includeExtras ? [] : [EXTRA_IS_TAG]),
			...(includeVariations ? [] : [VARIATION_IS_TAG]),
		]),
		includeExtras,
		includeVariations,
	};
}
