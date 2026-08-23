/**
 * Port of api/parsing/rewrite.py — post-parse AST rewrites.
 *
 * Three passes, applied in order at the shared parse seam:
 *  1. negate_not_prefix — `not:value` leaves become `NotNode(is:value)` (upstream #987)
 *  2. expand_derived_predicates — `is:` / frame synonyms re-parsed from DSL strings
 *  3. lower_literal_regexes — plain-literal `field:/regex/` leaves become substrings
 */

import { CardAttributeNode, CardBinaryOperatorNode } from "./card-query-nodes";
import { ARRAY_IS_TAGS, BOOLEAN_IS_TAGS, COMPUTED_IS_TAGS } from "./db-info";
import {
	AndNode,
	BinaryOperatorNode,
	type DirectiveFound,
	DirectiveNode,
	type ExpandedDerivedTerm,
	flattenNestedOperations,
	type LoweredRegexTerm,
	NotNode,
	OrNode,
	Query,
	type QueryNode,
	type QueryTerm,
	RegexValueNode,
	StringValueNode,
	TrueNode,
	type ValueNode,
} from "./nodes";
import { parseQuery } from "./parser";
import { pyLower } from "./pystr";

// (original alias, lowercased value) -> expansion DSL string. Mirrors
// rewrite._DERIVED_EXPANSIONS exactly (validated upstream against Scryfall).
//
// `is:new` was `frame:2015` here, on the belief that it was the 2015 frame ONLY and deliberately
// narrower than `frame:new`. Measured 2026-08-16, that is false in both directions:
// `is:new -(frame:2003 or frame:2015 or frame:future)` and its converse are BOTH empty on
// api.scryfall.com, and `frame:new -is:new` is empty too — `is:new` IS `frame:new`, exactly. The
// old mapping under-matched by 9,201 cards, every one of them a 2003 frame.
const DERIVED_EXPANSIONS: ReadonlyMap<string, string> = new Map([
	["frame\u0000modern", "frame:2003"],
	["frame\u0000old", "frame:1993 or frame:1997"],
	["frame\u0000new", "frame:2003 or frame:2015 or frame:future"],
	["is\u0000old", "frame:1993 or frame:1997"],
	["is\u0000new", "frame:2003 or frame:2015 or frame:future"], // == frame:new, exact both ways
	["is\u0000historic", "t:legendary or t:artifact or t:saga"],
	["is\u0000permanent", "t:creature or t:artifact or t:enchantment or t:land or t:planeswalker or t:battle"],
	["is\u0000party", "t:creature (t:cleric or t:rogue or t:warrior or t:wizard or kw:changeling)"],
	["is\u0000outlaw", "t:assassin or t:mercenary or t:pirate or t:rogue or t:warlock or kw:changeling"],
	// NO `is:vanilla` HERE — it is an ENGINE predicate now; see ENGINE_IS_VALUES below and
	// `FilterExpr::VanillaFace`. Two rewrites lived here and neither could reach the answer:
	// `t:creature o=""` was `t:creature` exactly (18,753, because `o=""` is a tautology on
	// api.scryfall.com as much as here — `=` on a text column is a SUBSTRING test and every string
	// contains the empty one), and `t:creature -o:/./` — the presence regex the `has:` family uses,
	// negated — answered the same 352 on both sides and stopped 11 short of Scryfall's 363.
	//
	// The 11 are not one class, which is why the last of it had to be enumerated card by card rather
	// than reasoned about. 12 are the FRONT-FACE class: `is:vanilla o:/./` is 12 on api.scryfall.com
	// and all 12 are adventures whose creature FRONT prints nothing while the Instant/Sorcery half
	// does (Beluna's Gatekeeper // Entry Denied), and every rewrite expressible here reads the
	// MERGED row, where the join hides the blank front. The 13th moves the other way: `Dryad Arbor`
	// is in `t:creature -o:/./` on BOTH sides and is NOT `is:vanilla` on Scryfall, because a LAND is
	// never vanilla there. +12 − 1 = the 11, and the engine's set is now Scryfall's own 363 card for
	// card, not merely the same size.
	["is\u0000watermark", "has:watermark"], // Scryfall accepts both spellings; 4,656 = 4,656
	["is\u0000bear", "t:creature pow=2 tou=2 cmc=2"],
	["is\u0000split", "layout:split"],
	["is\u0000flip", "layout:flip"],
	["is\u0000transform", "layout:transform"],
	["is\u0000mdfc", "layout:modal_dfc"],
	["is\u0000meld", "layout:meld"],
	["is\u0000leveler", "layout:leveler"],
	// `is:dfc` is NOT "the gameplay double-faced cards", and the old union was wrong in BOTH
	// directions. Measured on api.scryfall.com 2026-08-16 on two independent axes — `unique=prints`
	// with `include_extras`+`include_variations`, and the plain default `unique=cards` — both set
	// differences against the five layouts below are ZERO on both. It EXCLUDES meld, which the old
	// union included: `is:meld is:dfc` is 0 while `is:meld -is:dfc` is every meld printing (72
	// prints / 21 cards). And it INCLUDES the three layouts the old comment set aside as "not
	// gameplay cards and not in our corpus" — art_series 2,650, double_faced_token 120,
	// reversible_card 81 — two of which this import demonstrably carries: counting `card_layout`
	// over the built rows gives art_series 2,650 and double_faced_token 120, agreeing with
	// Scryfall exactly.
	[
		"is\u0000dfc",
		"layout:transform or layout:modal_dfc or layout:art_series or layout:double_faced_token or " +
			"layout:reversible_card",
	],
	// `tdfc` is `transform` under another name: `is:tdfc -is:transform` and its converse are both
	// empty on api.scryfall.com.
	["is\u0000tdfc", "layout:transform"],
	// The rest of the layout family, each pinned in both directions the same way.
	//
	// `is:host` and `is:augmentation` are the SAME predicate — Unstable's two halves together, not
	// one each. All four differences are empty: `is:host -is:augmentation`, its converse, and each
	// against `layout:host or layout:augment` (46 = 29 + 17). Written out per value rather than
	// aliased, because their equality is a measurement about Scryfall and not a spelling of ours.
	//
	// `is:token` reaches past `layout:token` to the double-faced tokens and to six Wilds of
	// Eldraine Role tokens that ship as `layout:flip` (twoe/15-17, twoc/1-2, plst/TWOE-17). The
	// `t:token` clause is what catches those six, and it cannot over-catch: `t:token -is:token` is
	// empty on Scryfall, so the union is exactly `is:token` and stays so as further odd-layout
	// tokens are printed. `is:token layout:emblem` is 0 — an emblem is not a token.
	["is\u0000artseries", "layout:art_series"],
	["is\u0000augmentation", "layout:host or layout:augment"],
	["is\u0000host", "layout:host or layout:augment"],
	["is\u0000planar", "layout:planar"],
	["is\u0000reversible", "layout:reversible_card"],
	["is\u0000token", "layout:token or layout:double_faced_token or t:token"],
	// Frame-effect (stored in card_frame_data). is:colorshifted == frame:colorshifted exactly (45).
	["is\u0000colorshifted", "frame:colorshifted"],
	["is\u0000extendedart", "frame:extendedart"], // 3,629 = 3,629
	["is\u0000showcase", "frame:showcase"], // 2,213 = 2,213
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
	// The Amonkhet/Hour cycling duals. Scryfall spells them three ways; all three are 10.
	["is\u0000bicycleland", "otag:cycle-bicycle-land"], // 10, exact
	["is\u0000bikeland", "otag:cycle-bicycle-land"], // 10, exact
	["is\u0000bondland", "otag:cycle-bondland"], // 10
	["is\u0000bounceland", "otag:bounceland"], // 17, exact
	["is\u0000canland", "otag:cycle-horizon-land"], // 6; Scryfall's other spelling of canopyland
	["is\u0000canopyland", "otag:cycle-horizon-land"], // 6, exact
	["is\u0000checkland", "otag:cycle-checkland"], // 10, exact
	["is\u0000cycleland", "otag:cycle-bicycle-land"], // 10; third spelling of bikeland
	["is\u0000creatureland", "t:land o:become o:creature o:/still a.* land/"],
	["is\u0000dual", "otag:cycle-abu-dual-land"], // 10, the ABUR duals, exact
	["is\u0000fastland", "otag:cycle-fastland"], // 10, exact
	["is\u0000fetchland", "otag:cycle-fetchland"], // 10, exact
	["is\u0000filterland", "otag:cycle-hybrid-filterland or otag:cycle-ody-filterland"], // 20 vs 22
	["is\u0000gainland", "otag:gainland"], // 42, self-updating superset of Scryfall's 15
	["is\u0000karoo", "otag:bounceland"], // 17; Scryfall's other spelling of bounceland
	["is\u0000manland", "t:land o:become o:creature o:/still a.* land/"],
	// Land, and the name says so — there is no cycle tag for these, and upstream's own
	// CUSTOM_IS_TAGS note describes them the same way ("land and name contains pathway").
	// 10 = 10 against api.scryfall.com.
	["is\u0000pathway", "t:land name:pathway"],
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
	// The MKM cycle, and Scryfall's list is still exactly those 10 — `cycle-dual-surveil-land`
	// holds the same set today, and the SOS cycle sits under its own slug that Scryfall has not
	// adopted, so the MKM slug is the one that tracks their answer rather than drifting past it.
	["is\u0000surveilland", "otag:cycle-mkm-surveil-land"], // 10, exact
	["is\u0000storageland", "otag:cycle-fem-storage-land or otag:cycle-mmq-storage-land or otag:cycle-tsp-storage-land"], // 15 vs 12
	["is\u0000tangoland", "otag:cycle-tangoland"], // 10; Scryfall accepts both names
	["is\u0000triland", "otag:cycle-ala-shardland or otag:cycle-ktk-wedgeland"], // 10, name-verified
	["is\u0000triome", "otag:cycle-iko-triome or otag:cycle-snc-triland"], // 10, name-verified
	// Scryfall's `is:tricycleland` is the triomes, name for name (the five IKO plus the five SNC)
	// — not a third cycling-land cycle, despite the spelling.
	["is\u0000tricycleland", "otag:cycle-iko-triome or otag:cycle-snc-triland"], // 10, name-verified
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
	// ── Set types (the `st:` operator, added alongside) ──────────────────────
	// `is:masterpiece` and `is:alchemy` ARE their set types: both set differences against
	// `st:masterpiece` / `st:alchemy` are empty on api.scryfall.com (2026-08-16). `is:funny` is
	// close rather than equal — 151 cards Scryfall calls funny are not in a funny SET, and 190
	// funny-set cards are not is:funny — but the funny sets are not imported at all, so the
	// difference is unobservable here and the mapping is what makes the answer an honest zero
	// instead of an unexplained one.
	["is\u0000alchemy", "st:alchemy"],
	["is\u0000funny", "st:funny"], // 151/190 residual, unobservable in this corpus
	["is\u0000masterpiece", "st:masterpiece"], // exact
	// ── Eligibility, in the shape is:commander already uses ──────────────────
	// Each validated separately against its own live list rather than rewritten to the format
	// filter — they are strict SUBSETS of `f:oathbreaker` / `f:brawl` / `f:duel`, not equal to them.
	// Measured 2026-08-16: every card Scryfall names is matched (the "is: minus shape" difference is
	// ZERO in all three), and the shapes over-catch by 15 / 27 / 121 on 287 / 2,318 / 3,323. Adding
	// the format banlist does not close the gap, so it is recorded rather than papered over — the
	// same standing the filterland (20 vs 22) and gainland (43 vs 15) entries already have.
	["is\u0000oathbreaker", "t:planeswalker f:oathbreaker"], // +15 / 287
	["is\u0000brawler", '((t:legendary (toughness>=0 or t:background)) or o:"can be your commander") f:brawl'], // +27 / 2,318
	["is\u0000duelcommander", '((t:legendary (toughness>=0 or t:background)) or o:"can be your commander") f:duel'], // +121 / 3,323
	// Everything with a castable primary type on some face. Scryfall's own is:spell is FACE-level
	// and this type union is not, so the two differ on the merged type lines: +48 / 31,760 measured
	// against api.scryfall.com on 2026-08-16 (excluding funny sets, which are not imported), with
	// ZERO misses — a strict superset, and the over-catch is the single-faced Artifact Lands plus
	// Unfinity's Attractions. `-t:land` was the other candidate and is worse in both directions:
	// 173 over, 87 under, because it drops the modal DFCs whose front face is a spell.
	[
		"is\u0000spell",
		"t:artifact or t:battle or t:creature or t:enchantment or t:instant or t:kindred or t:planeswalker or t:sorcery",
	],
	// A printing that is not a reprint IS the first printing, exactly — not approximately. Measured
	// on api.scryfall.com 2026-08-16: `is:firstprinting is:reprint` and `-is:firstprinting
	// -is:reprint` are both empty, so the two partition the printing space; `e:khm` is 425 prints,
	// 26 of them reprints and 399 first printings; `!"Lightning Bolt"` is 64 prints, 61 reprints and
	// 3 first printings. Ties all count — `!"Forest"` answers with BOTH lea/294 and lea/295 — which
	// falls out of the complement without a rule of its own. Scryfall accepts both spellings.
	["is\u0000firstprinting", "-is:reprint"],
	["is\u0000firstprint", "-is:reprint"],
	// ── Mana-symbol classes ──────────────────────────────────────────────────
	// Both are SYMBOL SET membership, and the sets come from Scryfall's own /symbology (fetched
	// 2026-08-16, filtered to `represents_mana`), not from a shape guess: a symbol is HYBRID when
	// it has two or more non-Phyrexian components, and PHYREXIAN when one of its components is P.
	// The two overlap on the ten two-colour Phyrexian symbols ({G/W/P} …), which are both, and
	// they part company on {B/P} (Phyrexian, not hybrid — one colour) and {C/P} (the same).
	//
	// {C/P} is in the symbology but NOT in the `m:` half below: no printed cost carries it
	// (`mana:{C/P}` and `o:"{c/p}"` both answer zero on api.scryfall.com, 2026-08-21), and the
	// mana-symbol validator (upstream #909) rejects it in a query — `{C/P}` is not one of the
	// shapes it accepts — so naming it would make the whole expansion a parse error for a term
	// that can match nothing.
	//
	// Verified against api.scryfall.com card for card — all 603 `is:hybrid` and all 73
	// `is:phyrexian` fetched and diffed against the 2026-08-16 bulk: ZERO cards Scryfall names are
	// missed by either rule, and every extra this corpus would add comes from a set this import
	// does not carry (Unknown Event, Mystery Booster playtest, Heroes of the Realm).
	//
	// `m:` and not a regex over the printed cost: the cost is stored as counted SYMBOLS, so each
	// leaf is an integer compare against the mana vocab, where a regex over the cost string
	// mismatches in both directions (measured: 5 under, 35 over).
	//
	// The `o:` half of `is:phyrexian` is not decoration. Scryfall's rule is the symbol ANYWHERE on
	// the card, not only in the cost — 36 of its 73 cards carry no Phyrexian symbol in any cost at
	// all (Spellskite, the Souleaters, every `{2}{B/P}: transform` back face) — and dropping it
	// leaves half the answer behind. `is:hybrid` is cost-only by the same measurement: 216 cards
	// carry a hybrid symbol in their rules text and Scryfall calls none of them hybrid.
	[
		makeKey("is", "hybrid"),
		"m:{W/U} or m:{W/B} or m:{U/B} or m:{U/R} or m:{B/R} or m:{B/G} or m:{R/G} or m:{R/W} or " +
			"m:{G/W} or m:{G/U} or m:{W/U/P} or m:{W/B/P} or m:{U/B/P} or m:{U/R/P} or m:{B/R/P} or " +
			"m:{B/G/P} or m:{R/G/P} or m:{R/W/P} or m:{G/W/P} or m:{G/U/P} or m:{2/W} or m:{2/U} or " +
			"m:{2/B} or m:{2/R} or m:{2/G} or m:{C/W} or m:{C/U} or m:{C/B} or m:{C/R} or m:{C/G}",
	],
	[
		makeKey("is", "phyrexian"),
		"m:{W/P} or m:{U/P} or m:{B/P} or m:{R/P} or m:{G/P} or m:{W/U/P} or m:{W/B/P} or " +
			"m:{U/B/P} or m:{U/R/P} or m:{B/R/P} or m:{B/G/P} or m:{R/G/P} or m:{R/W/P} or m:{G/W/P} or " +
			'm:{G/U/P} or o:"{w/p}" or o:"{u/p}" or o:"{b/p}" or o:"{r/p}" or o:"{g/p}" or o:"{c/p}" or ' +
			'o:"{w/u/p}" or o:"{w/b/p}" or o:"{u/b/p}" or o:"{u/r/p}" or o:"{b/r/p}" or o:"{b/g/p}" or ' +
			'o:"{r/g/p}" or o:"{r/w/p}" or o:"{g/w/p}" or o:"{g/u/p}"',
	],
	// Spelling aliases of tags the importer stores (db-info BOOLEAN_IS_TAGS / ARRAY_IS_TAGS).
	// Aliased rather than stored twice: a second copy of a 3,228-card tag is bytes for nothing.
	["is\u0000full", "is:fullart"],
	["is\u0000promostamped", "is:stamped"],
]);

/**
 * Scryfall's `has:` family, which asks whether a field is PRESENT rather than what it holds. The
 * vocabulary was read off the live API rather than the syntax docs, which list only two of it:
 * every candidate was probed on 2026-08-16 and the ones it accepts recorded here.
 *
 * Two shapes. The boolean half (`has:foil`, `has:booster`, …) is the SAME question `is:` asks and
 * answers with the same stored tag, so it rewrites to the `is:` value. The presence half is a
 * non-empty test on a text column, which `<field>:/./` already expresses — an unanchored
 * one-character regex over a column matches exactly the rows that have one.
 *
 * NOT here, and warning for a stated reason: `has:illustration` / `has:stamp` / `has:multiverse` /
 * `has:tcgplayer` / `has:cardmarket` / `has:image` / `has:indicator` are presence tests on columns
 * with no regex path (ids, interned compat scalars), and `has:attraction_lights` / `has:partner`
 * have no stored column at all. Each needs a presence predicate in the engine, not a rewrite.
 */
const HAS_EXPANSIONS: ReadonlyMap<string, string> = new Map([
	// Presence on a regex-capable text column.
	["artist", "artist:/./"],
	["flavor", "flavor:/./"],
	["watermark", "watermark:/./"],
	// The same question `is:` answers, off the same stored tag.
	["booster", "is:booster"],
	["etched", "is:etched"],
	["foil", "is:foil"],
	["glossy", "is:glossy"],
	["highres", "is:hires"],
	["nonfoil", "is:nonfoil"],
	["spotlight", "is:spotlight"],
	["story", "is:spotlight"],
	// The presence half again, for the one column that grew a predicate instead of a regex path:
	// `has:printedname` is the same question `is:localizedname` asks, and both counts on
	// api.scryfall.com are 31,294.
	["printedname", "is:localizedname"],
]);

/**
 * The `is:` values no rewrite can express and no importer tag holds: the engine answers each from a
 * field it already stores. Listed here so `SUPPORTED_IS_VALUES` covers them — the alternative is a
 * predicate that works and still warns that it does not.
 *
 * `localizedname` is `printed_name_folded_id != NONE_STR`, "this printing carries a printed name",
 * which is also what Scryfall means. Measured 2026-08-16: 182 of the printings it matches are
 * ENGLISH (om1/66 prints "Rhilex the Accursed" over Agent Venom), so it is not "non-English"; it is
 * per-FACE, matching every Japanese transform printing whose printed names live on the faces and
 * not at the top level; and `is:localizedname e:dsk` counts 1,917 printings there against this
 * corpus's own 1,917. Like `lang:`, its presence WIDENS the query to the foreign annex — that is
 * how api.scryfall.com answers 31,294 cards for it with no `lang:` term in sight.
 *
 * `unique` is "this card has been printed in exactly one SET" — Scryfall's syntax page says so in
 * as many words ("cards that have only been in a single set") — and it is NOT prints=1: 2,847 of
 * its own 16,318 have more than one printing. The set count spans every language, verified on the
 * 130 cards whose only second set is a foreign-only promo (Salvat, ps11, pmei): Scryfall calls none
 * of them unique.
 *
 * `vanilla` is "a creature whose FRONT FACE prints no rules text", and the face scope is the whole
 * reason it is a predicate: every rewrite composes terms over the MERGED row, whose text is the
 * faces' joined, so a blank front hides behind the half that prints. Three more rules ride on
 * `FilterExpr::VanillaFace` rather than on anything spelled here, each measured against
 * api.scryfall.com on 2026-08-17: the FRONT alone answers (a blank creature BACK is not enough —
 * `is:vanilla` over `Kaslem's Stonetree`, `Ecstatic Awakener`, `Chosen of Markov` and
 * `Skin Invasion` is 0), the creature test is the CARD's rather than that front's
 * (`City's Blessing // Elemental` is vanilla there and its front is not a creature), and a LAND is
 * never vanilla (`is:vanilla t:land` is 0 with and without `include_extras`, which is what keeps
 * `Dryad Arbor` out). The text read is the SEARCHABLE one, reminder stripped — `Icehide Golem` and
 * `Infinity Elemental` print only reminder text and are vanilla there. 352 → 363, and the 363 is
 * Scryfall's own set card for card.
 */
export const ENGINE_IS_VALUES: ReadonlySet<string> = new Set(["localizedname", "unique", "vanilla"]);

for (const [value, dsl] of HAS_EXPANSIONS) {
	(DERIVED_EXPANSIONS as Map<string, string>).set(makeKey("has", value), dsl);
}

/**
 * Every `is:` value this parser can answer at all: the derivable expansions above, the booleans the
 * importer stores on the row, and the two the engine answers from a stored field. Anything else
 * reaches the engine as a tag no row carries and comes back as zero results with nothing to say why
 * — see `unsupportedIsWarnings`. Reading BOOLEAN_IS_TAGS rather than restating it is what keeps a
 * tag added to the importer from being reported unsupported by the parser.
 */
export const SUPPORTED_IS_VALUES: ReadonlySet<string> = new Set([
	...BOOLEAN_IS_TAGS.keys(),
	...ARRAY_IS_TAGS.keys(),
	...COMPUTED_IS_TAGS,
	...ENGINE_IS_VALUES,
	...[...DERIVED_EXPANSIONS.keys()].filter((k) => k.startsWith("is\u0000")).map((k) => k.slice("is\u0000".length)),
]);

/**
 * `has:` is a TOTAL ALIAS of `is:`, not the hand-listed subset HAS_EXPANSIONS above was.
 *
 * That map was built by probing `has:`-FLAVOURED candidates — the presence questions, and the
 * boolean tags that read like presence questions — so every value nobody thought to spell against
 * `has:` was absent, and this server answered a 404 no-match where api.scryfall.com answers a full
 * list. `has:split` is the one the sweep caught (126 there, no match here); it is not special.
 *
 * MEASURED against api.scryfall.com on 2026-08-17, over 22 values chosen to span every shape the
 * `is:` vocabulary has — derived layout predicates (`split`, `dfc`, `modal`, `meld`, `flip`,
 * `leveler`), computed text predicates (`vanilla`, `frenchvanilla`, `permanent`, `spell`), importer
 * booleans (`promo`, `digital`, `reprint`, `funny`, `token`, `extra`, `etched`, `hires`,
 * `reserved`, `spotlight`, `masterpiece`) and the two set-shaped ones (`commander`, `firstprint`).
 * `is:X` and `has:X` answered the SAME `total_cards` on all 22, with no disagreement anywhere:
 *
 *     is:permanent 26220 = has:permanent      is:frenchvanilla 1095 = has:frenchvanilla
 *     is:split       126 = has:split          is:indicator      369 = has:indicator
 *
 * A value that is neither a `has:` presence test nor an `is:` tag is a 400 upstream and a warning
 * here — `has:flying` and `has:goblin` are both `bad_request` on api.scryfall.com — so the alias
 * widens the vocabulary without widening what counts as valid.
 *
 * A FALLBACK rather than entries folded into HAS_EXPANSIONS, so the presence half keeps precedence:
 * `has:watermark` asks whether a watermark is PRESENT and must not become `is:watermark`.
 */
for (const value of SUPPORTED_IS_VALUES) {
	const key = makeKey("has", value);
	if (!DERIVED_EXPANSIONS.has(key)) {
		(DERIVED_EXPANSIONS as Map<string, string>).set(key, `is:${value}`);
	}
}

/**
 * Every `has:` value this parser can answer. Same contract as SUPPORTED_IS_VALUES, and the same
 * consequence for anything outside it: a warning rather than a silent zero.
 */
export const SUPPORTED_HAS_VALUES: ReadonlySet<string> = new Set([...HAS_EXPANSIONS.keys(), ...SUPPORTED_IS_VALUES]);

function makeKey(alias: string, value: string): string {
	return `${alias}\u0000${value}`;
}

/** The same (alias, value) pair spelled the way the caller wrote it: `is:split`, `has:artist`. */
function termOf(key: string): string {
	return key.replace("\u0000", ":");
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

/**
 * Every `column:value` leaf under `node`, lowercased — what an expansion left in the tree.
 *
 * Only leaves carrying a STRING value are recorded, because only those can be confused with a term
 * a caller wrote at the granularity anything downstream compares at; a numeric or mana leaf
 * (`toughness>=0`, `m:{W/U}`) has no spelling to mistake.
 */
function collectExpandedLeaves(node: QueryNode, out: QueryTerm[]): void {
	if (node instanceof AndNode || node instanceof OrNode) {
		for (const op of node.operands) collectExpandedLeaves(op, out);
		return;
	}
	if (node instanceof NotNode) {
		collectExpandedLeaves(node.operand, out);
		return;
	}
	if (node instanceof BinaryOperatorNode && node.lhs instanceof CardAttributeNode) {
		const value = (node.rhs as Partial<ValueNode> & { value?: unknown }).value;
		if (typeof value === "string") {
			out.push({ attribute: node.lhs.attributeName, value: value.toLowerCase() });
		}
	}
}

/** Expand derived-predicate leaves in `node`; returns [node, changed]. */
function expand(
	node: QueryNode,
	inProgress: ReadonlySet<string>,
	expanded: ExpandedDerivedTerm[],
): [QueryNode, boolean] {
	const cls = (node as object).constructor;
	if (cls === AndNode || cls === OrNode) {
		let changed = false;
		const operands: QueryNode[] = [];
		for (const op of (node as AndNode | OrNode).operands) {
			const [newOp, opChanged] = expand(op, inProgress, expanded);
			operands.push(newOp);
			changed ||= opChanged;
		}
		return changed ? [cls === AndNode ? new AndNode(operands) : new OrNode(operands), true] : [node, false];
	}
	if (cls === NotNode) {
		const [newOp, changed] = expand((node as NotNode).operand, inProgress, expanded);
		return changed ? [new NotNode(newOp), true] : [node, false];
	}
	const key = leafKey(node);
	if (key !== null && DERIVED_EXPANSIONS.has(key) && !inProgress.has(key)) {
		// Recurse into the expansion so a definition may itself reference another
		// derived predicate; `inProgress` breaks any (mis)configured cycle.
		const nested = new Set(inProgress);
		nested.add(key);
		const [subtree] = expand(parseExpansion(DERIVED_EXPANSIONS.get(key) as string), nested, expanded);
		// Only the OUTERMOST expansion is recorded: `is:watermark` expands to `has:watermark`, which
		// expands again to `watermark:/./`, and the term the caller wrote — the one any rule keyed on
		// the spelling has to read — is the first of those three, not the second.
		if (inProgress.size === 0) {
			const leaves: QueryTerm[] = [];
			collectExpandedLeaves(subtree, leaves);
			expanded.push({ term: termOf(key), leaves });
		}
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

/** Rewrite plain-literal regex leaves to substring leaves, in place, recording which terms. */
function lowerRegexLeaves(node: QueryNode, lowered: LoweredRegexTerm[]): void {
	if (node instanceof AndNode || node instanceof OrNode) {
		for (const op of node.operands) lowerRegexLeaves(op, lowered);
	} else if (node instanceof NotNode) {
		lowerRegexLeaves(node.operand, lowered);
	} else if (node instanceof BinaryOperatorNode && node.operator === ":" && node.rhs instanceof RegexValueNode) {
		const literal = regexPlainLiteral(node.rhs.value);
		if (literal !== null) {
			// LITERAL, not a bare word: a regex matches the stored name as written, so the
			// lowered form must keep the quoted spelling's semantics rather than pick up the
			// bare word's separator/diacritic fold. Measured on api.scryfall.com 2026-08-16:
			// `name:/lim-dul/` answers 0 and `name:/Lim-D.l/` answers 8, so `/lim-dul/` is NOT
			// the fold that `name:limdul` (8) applies.
			//
			// `regexDerived` and the column list are the SAME fact recorded twice, deliberately:
			// on the node for whoever holds the AST, and on the Query for the route layer, which
			// only ever sees the wire tree and cannot see either flag there. See
			// `Query.loweredRegexTerms`.
			node.rhs = new StringValueNode(literal, true, true);
			if (node.lhs instanceof CardAttributeNode) {
				lowered.push({ attribute: node.lhs.attributeName, value: literal.toLowerCase() });
			}
		}
	}
}

/** Rewrite plain-literal regex leaves (`o:/foo/` -> `o:foo`) to substring leaves. */
export function lowerLiteralRegexes(query: Query): Query {
	const lowered: LoweredRegexTerm[] = [];
	lowerRegexLeaves(query.root, lowered);
	query.loweredRegexTerms = lowered;
	return query;
}

/**
 * Rewrite derived-predicate leaves (frame synonyms, derivable `is:`) into primitive subtrees,
 * recording which terms were replaced and what each left behind.
 *
 * The record is not bookkeeping: the rewrite makes `is:split` and `layout:split` the same tree, and
 * one consumer above the parser has to keep telling them apart. See `Query.expandedDerivedTerms`.
 */
export function expandDerivedPredicates(query: Query): Query {
	const expanded: ExpandedDerivedTerm[] = [];
	const [root, changed] = expand(query.root, new Set(), expanded);
	if (!changed) {
		return query;
	}
	const out = flattenNestedOperations(new Query(root));
	out.expandedDerivedTerms = expanded;
	return out;
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
/** Append a warning for every `is:`/`has:` leaf naming a value this server cannot answer. */
function collectUnsupportedIs(node: QueryNode, found: string[]): void {
	const cls = (node as object).constructor;
	if (cls === AndNode || cls === OrNode) {
		for (const op of (node as AndNode | OrNode).operands) collectUnsupportedIs(op, found);
		return;
	}
	if (cls === NotNode) {
		collectUnsupportedIs((node as NotNode).operand, found);
		return;
	}
	const key = leafKey(node);
	if (key === null) return;
	const sep = key.indexOf("\u0000");
	const alias = key.slice(0, sep);
	const value = key.slice(sep + 1);
	// `not:` is `-is:` (negateNotPrefix runs after this), so its vocabulary is `is:`'s.
	const supported =
		alias === "is" || alias === "not" ? SUPPORTED_IS_VALUES : alias === "has" ? SUPPORTED_HAS_VALUES : null;
	if (supported === null || supported.has(value)) return;
	found.push(
		`Unsupported term \u201c${alias}:${value}\u201d: this server has no data for that predicate, so it matched no cards.`,
	);
}

/**
 * Warnings for the `is:` values in `query` that this server cannot answer, in source order.
 *
 * A tag no row carries is indistinguishable from a tag every row happens to miss: both come back as
 * zero results, and the caller cannot tell an empty answer from an unimplemented predicate.
 * Scryfall answers an unknown `is:` value by IGNORING the term and warning (measured 2026-08-16:
 * `is:notarealtag e:khm` returns the whole set with "Invalid expression … was ignored"). This server
 * keeps the term — so the result is a no-match, not a widened one — and says so, which is the honest
 * version of the same courtesy. Whether to adopt the ignore-and-continue policy wholesale is a
 * separate decision that touches every operator, not just this one.
 *
 * Runs BEFORE `expandDerivedPredicates`, which replaces exactly the leaves this reads.
 */
export function unsupportedIsWarnings(query: Query): string[] {
	const found: string[] = [];
	collectUnsupportedIs(query.root, found);
	return found;
}

/**
 * Replace `not:value` leaves with `NotNode(is:value)`; return `[node, changed]`.
 *
 * Reuses the leaf's own operator and rhs untouched — only `lhs` changes, from the `not` FieldInfo
 * to `is`'s — so the wrapped leaf is indistinguishable from a user-typed `is:value` and
 * expandDerivedPredicates (which runs next) still applies is:'s expansion table to it (`not:vanilla`
 * negates the same subtree `is:vanilla` expands to).
 */
function swapNotLeaves(node: QueryNode): [QueryNode, boolean] {
	const cls = (node as object).constructor;
	if (cls === AndNode || cls === OrNode) {
		let changed = false;
		const operands: QueryNode[] = [];
		for (const op of (node as AndNode | OrNode).operands) {
			const [newOp, opChanged] = swapNotLeaves(op);
			operands.push(newOp);
			changed ||= opChanged;
		}
		return changed ? [cls === AndNode ? new AndNode(operands) : new OrNode(operands), true] : [node, false];
	}
	if (cls === NotNode) {
		const [newOp, changed] = swapNotLeaves((node as NotNode).operand);
		return changed ? [new NotNode(newOp), true] : [node, false];
	}
	if (
		node instanceof BinaryOperatorNode &&
		node.lhs instanceof CardAttributeNode &&
		node.lhs.originalAttribute === "not"
	) {
		const isLhs = new CardAttributeNode("is", node.lhs.matchedParserClass);
		// `type(node)(...)`: the leaf is always a CardBinaryOperatorNode here (the parser builds no
		// other BinaryOperatorNode with a CardAttributeNode lhs), and rebuilding through that class
		// is what keeps the constructor's own lowering intact.
		return [new NotNode(new CardBinaryOperatorNode(isLhs, node.operator, node.rhs)), true];
	}
	return [node, false];
}

/**
 * Rewrite `not:value` leaves into `NotNode(is:value)`.
 *
 * Scryfall's docs: `is:` "has a convenient inverted mode `not:` which is the same as `-is:`". Runs
 * FIRST so every later pass sees a plain `is:` leaf under a NotNode; flattening afterward folds the
 * new NotNode into whatever surrounds it exactly as a typed `-is:` would have been.
 */
export function negateNotPrefix(query: Query): Query {
	const [root, changed] = swapNotLeaves(query.root);
	if (!changed) {
		return query;
	}
	return flattenNestedOperations(new Query(root));
}

const REWRITE_PASSES: ReadonlyArray<(q: Query) => Query> = [
	negateNotPrefix,
	expandDerivedPredicates,
	lowerLiteralRegexes,
];

/** Apply every post-parse AST rewrite, in order. The single seam both parsers call. */
export function rewriteQuery(queryIn: Query): Query {
	// The `is:` check reads the very leaves expandDerivedPredicates replaces, so it runs first.
	// Strip next: a directive is not a filter, so no pass should ever see one. Both the pairs and
	// the warnings are attached AFTER, because each pass returns a fresh Query.
	const warnings = unsupportedIsWarnings(queryIn);
	const { query: stripped, directives } = extractDirectives(queryIn);
	let query = stripped;
	for (const rewritePass of REWRITE_PASSES) {
		query = rewritePass(query);
	}
	query.directives = directives;
	query.warnings = warnings;
	return query;
}
