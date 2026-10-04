/**
 * Scryfall's "ignore what you cannot honor" query policy, for the compat surface only.
 *
 * ─── WHAT SCRYFALL DOES ──────────────────────────────────────────────────────
 *
 * Scryfall's search does not reject a query because one term in it is unusable. It DROPS that
 * term, records a warning naming it, and answers with whatever survives — and it 400s only when
 * NOTHING survives. Measured against api.scryfall.com on 2026-08-16, one request per row:
 *
 *   q=f:notaformat e:khm   200, 323 rows, warnings:["Invalid expression “f:notaformat” was
 *                          ignored. Unknown game format “notaformat”"]
 *   q=f:notaformat         400 bad_request, details "All of your terms were ignored.", the same
 *                          warnings array
 *   q=subtype:elf e:war    200, 266 rows (the whole set) + "Unknown keyword “subtype”."
 *   q=(subtype:elf or subtype:goblin) e:war   200, 266 — a group whose every arm was dropped is
 *                          itself dropped
 *   q=()                   400 "All of your terms were ignored."
 *
 * That single mechanism is the root cause of eight separate divergences this port carried: it
 * 400d on a dangling operator, 404d on an unknown format or language, 503d on a malformed regex,
 * and answered a NARROWER result than Scryfall wherever this port's vocabulary is a superset of
 * Scryfall's (`subtype:`, `types:`, `oracle_tags:`, `art_tags:`, negated numeric equality).
 *
 * ─── WHY IT LIVES ON THE COMPAT SURFACE AND NOT IN THE PARSER ────────────────
 *
 * Because the two surfaces are answering to different vocabularies, and only one of them is
 * Scryfall's. `subtype:`, `types:`, `oracle_tags:` and `art_tags:` are spellings upstream added
 * on purpose; `/search` and the web UI use them, and deleting them from the parser to match
 * Scryfall would remove working features from the port's own API to make a mirror of an API that
 * never had them. Scryfall does have the same predicates under different names (`otag:`,
 * `atag:`), which this port also accepts — so on `/cards/search` the Scryfall spelling works and
 * the upstream-only spelling is ignored-and-warned exactly as Scryfall does, while `/search`
 * keeps the whole vocabulary. One parser, two policies, and the policy is a route-layer concept
 * because "what Scryfall's API accepts" is a route-layer fact.
 *
 * ─── HOW ─────────────────────────────────────────────────────────────────────
 *
 * The policy runs on the RAW query text, before parsing, for the same reason Scryfall's must: a
 * term this parser cannot lex at all (`t:` with no value, `cmc>=notanumber`, `o:/[unclosed/`)
 * has to be removed before the parse, not after it. The scan is quote-, regex-, brace- and
 * paren-aware, drops the terms the tables below name, and rebuilds the query from the spans it
 * kept — so a query with nothing to ignore comes back BYTE-IDENTICAL to its input (modulo the
 * typographic-quote fold), which is the property that keeps this off the hot path's conscience.
 */

import { foldTypographicQuotes, regexPlainLiteral } from "../../parser";
import {
	ALIAS_TO_FIELD_INFOS,
	COLOR_ALIAS_TO_CODES,
	COLOR_COUNT_NAMES,
	COLUMN_SCOPED_COUNT_NAMES,
	GAME_IS_TAGS,
	ParserClass,
} from "../../parser/db-info";
import { LexError } from "../../parser/errors";
import type { DirectiveFound } from "../../parser/nodes";
import { patternExceedsBudget, toJsValidationPattern } from "../../parser/regex-budget";
import { SUPPORTED_HAS_VALUES, SUPPORTED_IS_VALUES } from "../../parser/rewrite";
import { isKnownSetCode } from "../../parser/set-dates.gen";
import { isWordCont, type Token, TT, tokenize } from "../../parser/tokenizer";
import { DIRECTIVE_TABLES } from "../enums";
import { blockSetCodes, blockValueCode } from "./set-blocks.gen";

/** Scryfall's syntax budget, independent of the engine's post-rewrite safety budget. */
export const TOO_MANY_REGEX_DETAILS = "Too many regular expression operators used";
const MAX_SCRYFALL_REGEX_OPERATORS = 6;

// Only Scryfall regex fields count. Color slash values are ordinary colors; unsupported
// regex fields are ignored. The engine intentionally supports additional string columns.
const SCRYFALL_REGEX_KEYWORDS: ReadonlySet<string> = new Set([
	"name",
	"type",
	"t",
	"oracle",
	"o",
	"fo",
	"fulloracle",
	"flavor",
	"ft",
	"mana",
	"m",
]);

/**
 * Measured against api.scryfall.com on 2026-09-27: six regex operators succeed and
 * seven return 400 with TOO_MANY_REGEX_DETAILS on search and random. Repeated literal
 * patterns still count; a malformed pattern on a known field counts before validation.
 * Therefore inspect raw tokens before ignore-and-continue, literal lowering or dedupe.
 * Quotes and escaped regex delimiters are handled by the existing lexer.
 */
export function exceedsScryfallRegexBudget(query: string): boolean {
	let tokens: Token[];
	try {
		tokens = tokenize(foldTypographicQuotes(query));
	} catch (error) {
		// Keep the existing syntax/term-policy error for queries that cannot be tokenized.
		if (error instanceof LexError) return false;
		throw error;
	}
	let count = 0;
	for (let i = 2; i < tokens.length; i++) {
		const token = tokens[i];
		const operator = tokens[i - 1];
		const keyword = tokens[i - 2];
		if (
			token?.type === TT.REGEX &&
			operator?.type === TT.OP &&
			keyword?.type === TT.WORD &&
			SCRYFALL_REGEX_KEYWORDS.has(String(keyword.value).toLowerCase())
		) {
			count++;
			if (count > MAX_SCRYFALL_REGEX_OPERATORS) return true;
		}
	}
	return false;
}

export const NESTED_DISPLAY_OPTIONS_DETAILS = "Display options may not be specified inside parentheses.";

/**
 * `include:` — SCRYFALL'S IN-QUERY SPELLING OF `include_extras` AND ITS TWO SIBLINGS, a display
 * option like `unique:` and `order:`, and one this port refused outright.
 *
 * Reported from mtg-seeker (x66 R6): `name:/^reset$/ include:extras` is 200 / 1 card on
 * api.scryfall.com and was `400 Failed to parse query` here. Measured 2026-10-03, base `cmc=3` =
 * 8,089 (8,302 with `include_extras=true`), reading the three flags back out of `next_page`:
 *
 *   include:extras    include:extra         8,302   extras=true
 *   include:variations  include:variation   8,089   variations=true
 *   include:multilingual                    8,090   multilingual=true
 *   include:all       include:everything    8,302   extras=true variations=true multilingual=true
 *   include:funny     include:digital       8,089   accepted, silently, and nothing observable moves
 *   include:foo  foreign  tokens  any  none  both  prints  true  1
 *                                           8,089 + `Unknown direction choice “foo” was ignored`
 *
 * THE WARNING REALLY DOES SAY "direction choice" — Scryfall's sentence for an unknown `direction:`
 * value, reused. The value is echoed lower-cased (`include:FOO` → “foo”), quotes and all
 * (`include:"extras"` is NOT `extras`: it warns about “"extras"”), and cut to ten characters with
 * three ASCII dots (`include:extras,variations` → “extras,...”), not the 20 and the `…` an ignored
 * expression gets.
 *
 * IT IS A DISPLAY OPTION, with everything that follows from that:
 *
 *   -include:extras t:goblin cmc=0     20     a `-` changes nothing (`-include:foo` warns the same)
 *   include:extras cmc=3 &include_extras=false   8,302   the option beats the parameter
 *   (include:extras t:goblin) cmc=0    400 `Display options may not be specified inside parentheses.`
 *   include:extras                     400 `All of your terms were ignored.`, `warnings: null` —
 *                                          an option is not a term, so nothing is left
 *   include:extras or t:goblin cmc=0   20     removed before the connectors are read
 *   include:extras include:variations  both flags
 *
 * And only under `:`. `include=extras t:goblin` is 561 with `Unknown keyword “include”.` — an
 * ordinary unknown keyword — and `include>extras` is the honored-and-empty comparison every
 * unknown keyword is.
 *
 * COST: nothing at query time beyond the flag it sets — the same extras gate conjunct the
 * `include_extras` parameter already removes.
 */
const INCLUDE_KEYWORD = "include";

/** The three `include_*` parameters an in-query `include:` can switch on. */
export interface IncludeOptions {
	extras: boolean;
	variations: boolean;
	multilingual: boolean;
}

/** What one `include:` value switches on. An empty list is a value Scryfall accepts and ignores. */
const INCLUDE_VALUES: ReadonlyMap<string, readonly (keyof IncludeOptions)[]> = new Map<
	string,
	readonly (keyof IncludeOptions)[]
>([
	["extras", ["extras"]],
	["extra", ["extras"]],
	["variations", ["variations"]],
	["variation", ["variations"]],
	["multilingual", ["multilingual"]],
	["all", ["extras", "variations", "multilingual"]],
	["everything", ["extras", "variations", "multilingual"]],
	["funny", []],
	["digital", []],
]);

/** How much of an unknown display-option value Scryfall echoes: ten characters, dots included. */
const DISPLAY_VALUE_ECHO_LIMIT = 10;

/** `Unknown <what> “<value>” was ignored` — Scryfall's sentence for a display option's bad value. */
function unknownDisplayValueWarning(what: string, rawValue: string): string {
	const chars = [...rawValue.toLowerCase()];
	const echoed =
		chars.length > DISPLAY_VALUE_ECHO_LIMIT
			? `${chars.slice(0, DISPLAY_VALUE_ECHO_LIMIT - 3).join("")}...`
			: chars.join("");
	return `Unknown ${what} \u201c${echoed}\u201d was ignored`;
}

function unknownIncludeWarning(rawValue: string): string {
	return unknownDisplayValueWarning("direction choice", rawValue);
}

/**
 * EVERY DISPLAY OPTION IS READ HERE, on the query text, and none of them is a term.
 *
 * `unique:`, `order:`/`sort:`, `direction:`/`dir:` and `prefer:` are this parser's directives
 * (upstream #893) and `/search` reads them through the parser. On this surface three things about
 * them were not Scryfall's, all measured on api.scryfall.com 2026-10-03 (`t:goblin` = 561):
 *
 * 1. THE SENTENCE. An unknown value is a `warnings` entry worded by Scryfall, where this port sent
 *    upstream's `Ignored unknown unique mode 'nonsense' in unique:nonsense.`:
 *
 *      unique:nonsense          Unknown unique mode “nonsense” was ignored
 *      order:nonsense  sort:…   Unknown order choice “nonsense” was ignored
 *      direction:…     dir:…    Unknown direction choice “nonsense” was ignored
 *      prefer:nonsense          Unknown preference mode “nonsense” was ignored
 *      display:…       as:…     Unknown display mode “nonsense” was ignored
 *
 *    with the value lower-cased and cut to ten characters, dots included (`unique:abcdefghijklmnop`
 *    → “abcdefg...”; `prefer:abcdefghij`, exactly ten, comes back whole). A QUOTED value is unknown
 *    — `unique:"prints"` and `order:"cmc"` each warn, quotes echoed — and a `-` changes nothing.
 *
 * 2. A QUERY OF NOTHING BUT OPTIONS. `unique:prints`, `order:cmc`, `prefer:oldest`, `display:grid`
 *    and `unique:prints order:cmc` are each `400 All of your terms were ignored.` with `warnings:
 *    null` (`unique:nonsense` alone carries its warning). This port answered the whole corpus —
 *    38,705 cards for `order:cmc`. Removing the options from the query text is what makes that
 *    fall out: nothing is left.
 *
 * 3. `unique=prints` IS NOT AN OPTION. It is 561 carrying `Unknown keyword “unique”.`, as
 *    `include=extras` and `display=grid` are; this port answered `400 Failed to parse query`.
 *
 * `display:`/`as:` change nothing an API response shows; `grid`, `checklist`, `full`, `text` and
 * `images` are accepted silently and this port called the keyword unknown.
 *
 * AND `unique:art` SWITCHES EXTRAS ON, which the `unique=art` PARAMETER does not: `unique:art
 * cmc=3` is 11,081 echoing `include_extras=true` where `cmc=3&unique=art` is 10,977 echoing false
 * (`-unique:art` the same 11,081; `unique:prints cmc=3` echoes false). One more syntactic trigger
 * in the family extras-gate.ts tabulates, and the only one that is a display option.
 *
 * WHAT STAYS THIS PORT'S OWN: the values its tables hold that Scryfall's do not — `unique:artwork`
 * / `card` / `printing`, `order:cubecobra`, `prefer:borderless` — are honored where Scryfall warns
 * (each measured as "Unknown … was ignored" there), the same superset the `order=` parameter
 * keeps. And `order:penny` / `order:review`, which Scryfall sorts by and this port cannot, keep the
 * parameter's own sentence.
 */
const DISPLAY_OPTION_LABELS: ReadonlyMap<string, string> = new Map([
	["unique", "unique mode"],
	["order", "order choice"],
	["sort", "order choice"],
	["direction", "direction choice"],
	["dir", "direction choice"],
	["prefer", "preference mode"],
]);

/** `display:` / `as:` — Scryfall's page layouts, which no API response shows. */
const DISPLAY_MODE_KEYWORDS: ReadonlySet<string> = new Set(["display", "as"]);
const DISPLAY_MODES: ReadonlySet<string> = new Set(["grid", "checklist", "full", "text", "images"]);

/** The two orders Scryfall sorts by and this port cannot — see routes.ts, which words the warning. */
export const SCRYFALL_ONLY_ORDERS: readonly string[] = ["penny", "review"];

/** The keywords Scryfall reads as display options: this parser's directives, `include`, `display`. */
function isDisplayKeyword(keyword: string): boolean {
	return DIRECTIVE_TABLES.has(keyword) || keyword === INCLUDE_KEYWORD || DISPLAY_MODE_KEYWORDS.has(keyword);
}

/** The verdict on one `<display keyword>:<value>` leaf. Never a term: it always leaves the query. */
function classifyDisplayOption(keyword: string, rawValue: string): LeafVerdict {
	const none = { keep: false, reason: null, include: [] } as const;
	const value = rawValue.toLowerCase();
	if (keyword === INCLUDE_KEYWORD) {
		const switches = INCLUDE_VALUES.get(value);
		return switches === undefined
			? { ...none, warning: unknownIncludeWarning(rawValue) }
			: { ...none, include: switches, warning: null };
	}
	if (DISPLAY_MODE_KEYWORDS.has(keyword)) {
		return DISPLAY_MODES.has(value)
			? { ...none, warning: null }
			: { ...none, warning: unknownDisplayValueWarning("display mode", rawValue) };
	}
	const spec = DIRECTIVE_TABLES.get(keyword);
	const label = DISPLAY_OPTION_LABELS.get(keyword);
	if (spec === undefined || label === undefined) return { ...none, warning: null };
	const resolved = spec.table.get(value);
	if (resolved !== undefined) {
		return {
			...none,
			include: spec.param === "unique" && resolved === "artwork" ? ["extras"] : [],
			warning: null,
			directive: { name: keyword, value, nested: false },
		};
	}
	if (spec.param === "orderby" && SCRYFALL_ONLY_ORDERS.includes(value)) {
		return { ...none, warning: `This server cannot sort by '${value}' yet; sorted by name instead.` };
	}
	return { ...none, warning: unknownDisplayValueWarning(label, rawValue) };
}

/**
 * Scryfall rejects display directives inside groups before validating their values.
 * Measured 2026-09-27 for every alias in DIRECTIVE_TABLES, including a negated sort
 * and an unknown value. A dangling `sort:` and `sort=value` are not directives.
 * Inspect tokens so parentheses and directive-looking text in literals remain opaque.
 */
export function hasNestedScryfallDisplayOption(query: string): boolean {
	let tokens: Token[];
	try {
		tokens = tokenize(foldTypographicQuotes(query));
	} catch (error) {
		if (error instanceof LexError) return false;
		throw error;
	}
	let depth = 0;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token?.type === TT.LPAREN) depth++;
		else if (token?.type === TT.RPAREN) depth--;
		else if (depth > 0 && token?.type === TT.WORD && isDisplayKeyword(String(token.value).toLowerCase())) {
			const operator = tokens[i + 1];
			const value = tokens[i + 2];
			// A field value that happens to read `sort` is not a directive keyword.
			if (tokens[i - 1]?.type === TT.OP) continue;
			if (
				operator?.type === TT.OP &&
				operator.value === ":" &&
				(value?.type === TT.WORD || value?.type === TT.QUOTED || value?.type === TT.NUMBER)
			)
				return true;
		}
	}
	return false;
}

/**
 * The four characters Scryfall folds before lexing now live in the PARSER, next to the lexer they
 * are folded for — `src/parser/tokenizer.ts`, which carries the measurement that established them.
 *
 * They were here first and ONLY here, which meant `/search` and the web UI rejected the very
 * quotes their own search box produces while `/cards/search` accepted them. This scan still folds
 * FIRST, before anything else it does, because the spans it keeps and the terms it echoes in
 * warnings have to be the ones the parser will read — so the compat behaviour is byte-identical
 * and the other surfaces gained it.
 */
export const foldSmartQuotes = foldTypographicQuotes;

/**
 * Keywords this port accepts that Scryfall's search does not know at all.
 *
 * Measured one request each (`<alias>:<plausible value> e:war`, 2026-08-16): every OTHER alias in
 * `DB_COLUMNS` came back honored, and these came back with "Unknown keyword". They are exactly
 * the upstream-only spellings — Scryfall reaches the same three columns as `t:`/`otag:`/`atag:`.
 */
const NOT_SCRYFALL_KEYWORDS: ReadonlySet<string> = new Set([
	"subtype",
	"subtypes",
	"types",
	"color_identity",
	"coloridentity",
	"oracle_tags",
	"art_tags",
]);

/**
 * Keywords SCRYFALL knows and this port does not — left to fail as they already do.
 *
 * The rule below ignores any keyword neither side knows (`nonsense:value`, which Scryfall answers
 * with "Unknown keyword" and a 400 rather than a parse error). These are the exception: ignoring
 * one would answer a WIDER result than Scryfall, silently, because Scryfall honors it. They are
 * already ledgered as UNSUPPORTED operators in the sweep, and pretending to have dropped a term
 * Scryfall applied is worse than saying the query could not be read.
 */
const SCRYFALL_ONLY_KEYWORDS: ReadonlySet<string> = new Set([
	// `game` LEFT THIS TABLE when the importer started storing the `games` array as `game_*` tags
	// (db-info.ts GAME_IS_TAGS). It is a keyword this port honors now, so listing it here would
	// claim the opposite; what remains of it on this surface is the value validator below, which
	// reproduces Scryfall's ``Unknown game `nonsense` `` rather than letting the term through.
	// `in` left it the same way, a day later, when the importer started storing the per-card
	// `card_in_tags` union (db-info.ts). Scryfall gives `in:` NO value validator — `in:nonsense`
	// and `in:zz` are 404s with no warnings key, honored and matching nothing — so nothing
	// replaces it on this surface: an unknown value names a tag no card carries.
	"cube",
	"new",
	"not",
	// `stamp` LEFT THIS TABLE with x68: the engine compares the security stamp the card object
	// already emits (db-info's `security_stamp`), and STAMP_KEYWORDS below says Scryfall's
	// `Unknown security stamp` for a value outside its six.
	// `include` LEFT THIS TABLE on 2026-10-03: `include:` is a display option this surface now
	// reads (see INCLUDE_VALUES), and under `=` it is a keyword Scryfall itself does not know —
	// `include=extras t:goblin` is 561 carrying `Unknown keyword “include”.`
	//
	// `direct` LEFT IT the same day for the opposite reason: Scryfall does not know it either
	// (`direct:x e:khm t:god` is 12 carrying `Unknown keyword “direct”.`), so the unknown-keyword
	// rule is the right answer and this table was claiming otherwise.
	//
	// EIGHTEEN MORE JOINED IT, found by probing `<keyword>:<value> e:khm t:god` (12 cards) for
	// every keyword Scryfall's syntax is known to carry, 2026-10-03. Each is HONORED there — the
	// count moves, or the answer is a plain 404 with no `warnings` key — and each was being dropped
	// here with `Unknown keyword “…”.`, which is the one thing this table exists to prevent: a
	// query answered WIDER than Scryfall answers it, under a sentence saying Scryfall would have
	// ignored the term too. A client that validates queries here and ships them there read that
	// warning as "safe to send". Now they fail to parse, loudly, until the port can answer them:
	//
	//   block b edition           honored: `block:khm` and `edition:khm` are the 12
	//   lore                      honored: `lore:x` is 7
	//   artists                   honored: `artists:1` is the 12
	//   mtgoid multiverseid arenaid tcgplayerid      404 for id 1 in that set
	//   prints sets paperprints papersets illustrations edhrec usdfoil collector collectornumber
	//                             404 for the probe value
	//
	// (Under a comparison they were already honored-and-empty, by the COMPARABLE_KEYWORDS rule,
	// and still are: narrower than Scryfall's count, never wider.)
	//
	// x68 TOOK THEM BACK OUT ONE GROUP AT A TIME, as each gained an answer. `edition`, `collector`,
	// `collectornumber` and `edhrec` left first: they are spellings of columns the parser already
	// had (db-info's `card_set_code`, `collector_number_int`, `edhrec_rank`). `mtgoid`,
	// `multiverseid`, `arenaid`, `tcgplayerid` and `usdfoil` left second: the engine answers them
	// from fields the store already held for the card object. `prints`, `sets`, `paperprints`,
	// `papersets`, `illustrations` and `artists` left third, with store generation 58, which
	// holds the counts they compare. `block` and `b` left fourth: a block is a list of sets, and
	// BLOCK_KEYWORDS below rewrites the term into them.
	//
	// `lore` LEFT FIFTH, on 2026-10-04, once the three probes its rewrite failed were understood:
	// `lore:ft e:khm` is 22 against the four-column union's 41 because the union's `name:ft` is the
	// COLLATED name ("Jarl oF The Forsaken") and `lore:` reads the name as printed. LORE_KEYWORDS
	// below; card_engine's `build_binary` carries the rule and its measurements.
	//
	// WHAT IS LEFT, AND WHY, each measured the same day:
	//
	//   cube      `cube:vintage` 540, `cube:legacy` 600, `cube:arena` 550 … membership of
	//             Scryfall's curated cube lists, which are in no bulk file and have no API
	//             endpoint. Not obtainable by the import.
	//   new       `new:art`, `new:artist`, `new:flavor`, `new:frame`, `new:language`,
	//             `new:rarity`, `new:card` — and `new:illustration`, `new:lang`, `new:ft`,
	//             `new:flavortext`, `new:foil`, `new:nonfoil`, `new:paper`, `new:game`, each
	//             honored 2026-10-04 (anything else: `Checking if cards have a new “x” is not
	//             supported`). Per-printing "first printing of this card with this" flags.
	//             MEASURED AND NOT ANSWERED: two of the values fit a rule exactly over the
	//             2026-09-24 corpus — `rarity` (42,688 of 42,688 card-rarity groups: the first
	//             canonical printing outside promo, memorabilia, from_the_vault, treasure_chest
	//             and every masterpiece set but `wot`) and `language` (30,866 of 30,866 for
	//             German) — in the order (release date, release batch, first integer of the
	//             collector number, variation last, Scryfall id). `frame`, `art`, `card` and
	//             `flavor` do not: with promo and masterpiece printings eligible, a same-date tie
	//             against the main set is decided by something this order does not hold (216,
	//             410, 1,276 and 20,519 groups wrong), and `new:artist` is 542,524 of 545,293
	//             printings — not "first by this artist" at all. A keyword answered for two
	//             values and refused for the rest is not answered.
	//
	// `cheapest` LEFT SIXTH, the same day, with store generation 61, which holds each printing's
	// answer: CHEAPEST_KEYWORDS below.
]);

/**
 * `block:` / `b:` — every card in a Magic block, named by any set code of it.
 *
 * NOT A COLUMN. A block is a list of SETS, and which sets is a function of two fields of
 * Scryfall's set objects that no card object carries; `set-blocks.gen.ts` holds them (its
 * generator carries the measured rule), and the term is rewritten here into the `e:` terms it
 * means: `block:wwk` → `(e:proe or e:pwwk or e:pzen or e:roe or e:troe or e:twwk or e:tzen or
 * e:wwk or e:zen)`. A set with no block and no parent, or a code the table has never seen, is
 * that set alone — `block:khm` is `e:khm`'s 305.
 *
 * Measured on api.scryfall.com 2026-10-03/04:
 *
 *   block:khm t:god = b:khm t:god = block=khm t:god = block:KHM   12
 *   block:nonsense t:god                 404, no warning — honored, and naming no set
 *   block!=khm t:god, block>khm t:god    404 (the comparison rule)
 *   -block:khm t:god                     100 — the complement, over a corpus with extras in it
 *   block:/khm/ t:god                    95 + Unknown regular expression keyword “block”.
 *   block:zen or cmc=3                   8,819, echoing include_extras=true
 *
 * IT OPENS EXTRAS UNCONDITIONALLY, which `e:` does not (`e:zen or cmc=3` echoes false): the
 * block's token sets are members and `block:zen` is 629 where its three expansions are 607. So
 * the verdict carries `include: extras` — the mechanism `include:extras` uses — rather than
 * leaving it to the conditional rule the rewritten `e:` terms would get.
 *
 * A SET NAME ANSWERS WHERE ITS CODE DOES. `block:zendikar` is `block:zen`'s 629 and
 * `b:"return to ravnica"` is `block:rtr`'s 670 (2026-10-04): the value is the set's whole name
 * with case, spaces, apostrophes, periods, hyphens and underscores ignored, or one of Scryfall's
 * own nicknames (`block:shards`, `block:alpha`). `blockValueCode` resolves it from the generated
 * table, whose generator carries every measurement — the 38 names that answered, the nicknames,
 * and what is left out (token-set names, a value with a colon in it, a nickname nobody measured).
 * A value that names nothing and is not shaped like a code answers nothing: narrower than
 * Scryfall, never wider.
 *
 * COST: one map lookup in a table parsed on the first `block:` term, at parse time. A query
 * without the keyword never touches it.
 */
const BLOCK_KEYWORDS: ReadonlySet<string> = new Set(["block", "b"]);
const SET_CODE_SHAPE_RE = /^[0-9a-z]{1,8}$/i;

/** The `e:` terms a `block:` value means, as one group — or the term that matches nothing. */
function blockTerm(value: string): string {
	// A code or a name the table knows; failing that, a code-shaped value is a set released since
	// the table was refreshed, and answers alone.
	const code = blockValueCode(value) ?? (SET_CODE_SHAPE_RE.test(value) ? value : null);
	if (code === null) return NEVER_MATCHES;
	return `(${blockSetCodes(code)
		.map((member) => `e:${member}`)
		.join(" or ")})`;
}

/**
 * Scryfall cannot express a NEGATED numeric EQUALITY, and says so in two different sentences.
 *
 * Measured (`-<kw>:<value>` alone, so the answer is the 400 that carries the whole warning):
 * `-cmc:3`, `-mv:3`, `-manavalue:3` earn the value sentence; `-pow:1`, `-power:1`, `-tou:1`,
 * `-toughness:1`, `-loy:3`, `-loyalty:3`, `-usd:0`, `-eur:0`, `-tix:0`, `-year:1993` earn
 * "Unknown keyword" WITH THE MINUS INSIDE THE QUOTES. `-cn:1` and `-number:1` are honored — `cn:`
 * is the STRING collector-number column, and only its integer twin `cn>=` is caught by the rule
 * below — so this table is equality-and-these-columns rather than negation as such.
 *
 * THIS COMMENT USED TO CLAIM `-date:2021` AND `-cmc!=3` WERE HONORED TOO. Both claims were wrong,
 * and re-measuring them is what produced `negatedComparisonVerdict` below: `-cmc!=3 e:khm
 * t:creature` is 151, the unfiltered anchor, where `cmc!=3` is 106; and `-date:2021` is 141,
 * exactly what the UNNEGATED `date:2021` answers. Neither is honored; they are simply quiet about
 * it, which is why a comment could carry the error.
 *
 * Reproducing the split rather than picking one sentence: the strings are the contract, and a
 * client that matches on them sees Scryfall's.
 *
 * `pt` and `powtou`, the combined power-and-toughness keyword, are the same kind of column and
 * take the same sentence: `-pt=2` alone is the 400 carrying `Unknown keyword “-pt”.`, and
 * `pt:foo t:goblin` is 561 carrying `Unknown keyword “pt”.` (2026-10-03).
 *
 * THE x68 NUMERIC KEYWORDS ARE THE SAME KIND AND TAKE THE SAME TWO SENTENCES, each measured
 * 2026-10-03 against the anchor `e:khm` = 305: `collector:abc`, `collectornumber:abc` and
 * `edhrec:abc` are 305 carrying `Unknown keyword “<kw>”.`; `-collector:1`, `-collectornumber:1`
 * and `-edhrec:1` are 305 carrying `Unknown keyword “-<kw>”.`; and `-collector>=390` and
 * `-edhrec>=5000` are 305 with no warning at all — the silent tautology below. `cn`/`number` are
 * NOT here although `collector` is the same column: `-cn:1` is honored (304), because under `:`
 * those two spellings read the string collector number.
 */
const NEGATED_EQUALITY_UNKNOWN_KEYWORD: ReadonlySet<string> = new Set([
	"pow",
	"power",
	"tou",
	"toughness",
	"pt",
	"powtou",
	"loy",
	"loyalty",
	"usd",
	"eur",
	"tix",
	"year",
	"collector",
	"collectornumber",
	"edhrec",
	"edhrecrank",
	"edhrec_rank",
	// `usdfoil:abc e:khm` and `-usdfoil:1 e:khm` are 305 carrying the two sentences, and
	// `-usdfoil>=1 e:khm` is 305 with none (2026-10-03).
	"usdfoil",
	// The six counts, each probed the same three ways: `<kw>:abc e:khm` and `-<kw>:1 e:khm` are
	// 305 carrying `Unknown keyword “<kw>”.` / `“-<kw>”.` for prints, sets, paperprints,
	// papersets, illustrations and artists; `-prints>=10 e:khm` and `-artists>=2 e:khm` are 305
	// with no warning.
	"prints",
	"sets",
	"paperprints",
	"papersets",
	"illustrations",
	"artists",
]);

/**
 * `collector` / `collectornumber` — the numeric collector number's own spellings — and how
 * Scryfall reads a value there that only STARTS as a number.
 *
 * Measured 2026-10-03, anchor `e:khm` = 305, one request per row:
 *
 *   collector:1  collector:040→40  collector:1a  collector:1-2      1 card each
 *   collector:1★  collector:1.5  collector:-1  collector:0          404, no warning
 *   collector:abc  collector:a-40  collector:a1  collector:★
 *   collector:+1  collector:"1"                                     305 + `Unknown keyword “collector”.`
 *
 * So a value led by digits and continued in letters or hyphens is its leading integer (`1a` and
 * `1-2` are both collector number 1); one led by a digit and continued in anything else is kept
 * and matches nothing; and one that does not start as a number at all is the unknown-keyword
 * sentence the numeric columns give. (`pow:1a t:goblin` is 135, the power-1 goblins, so the
 * leading-integer reading is not this keyword's alone — it is applied here because it was
 * measured here.)
 *
 * THE FIRST OF THOSE WAS HALF THE RULE, found 2026-10-04: `collector:1z e:khm` is a 404. The
 * letters behind the integer are a term of their own (khm/1 is Axgard Braggart, which has an `a`
 * and no `z`), as behind every numeric value — `numericValueSplit`, which now answers `1a` and
 * `1-2` before this table is read. What still reaches the leading-integer test below is the value
 * that rule cannot split: one continued in a character the lexer does not read (`1★`).
 */
const COLLECTOR_NUMBER_KEYWORDS: ReadonlySet<string> = new Set(["collector", "collectornumber"]);
const COLLECTOR_LEADING_INTEGER_RE = /^(\d+)[A-Za-z-][A-Za-z0-9-]*$/;

/** The mana-value spellings, whose negated equality earns the value sentence instead. */
const MANA_VALUE_KEYWORDS: ReadonlySet<string> = new Set(["cmc", "mv", "manavalue"]);

/**
 * `*`, `x`, `y` AND `z` ARE THE NUMBER ZERO where a numeric column takes its value — the four
 * things a card prints where a number goes, read as Scryfall reads them off the card.
 *
 * Measured on api.scryfall.com 2026-10-04, one request per row. `pow=0` is 1,049, `tou=0` 431,
 * `pt=0` 406, `loy=0` 4, `cmc=0` 1,432:
 *
 *   pow=*  pow:*  power=*  pow=x  pow=X  pow=y  pow=z      1,049      tou=*  tou=x  tou=y   431
 *   pt=*  pt=x  powtou=x  pt=z                              406        loy=x  loy=X  loy=*  loy=z  loy<=x   4
 *   cmc=x  cmc=*  mv=x  cmc=y  cmc=z                      1,432      manavalue=* e:khm    38
 *   pow>*  pow>x   17,943 = pow>0      pow>=x  18,978 = pow>=0      pow<x  pow<*  4      pow<=*  1,053
 *   pow!=*         17,947              tou>x   18,553               cmc>x e:khm  267
 *
 * and on the columns where no card holds a zero the comparisons say the same (anchor `e:khm` =
 * 305): `usd>x` `usd>=x` `usd>*` `prints>x` `year>x` `year>=x` `cn>x` `cn>=*` `artists>=x`
 * `tix>=y` 305, `edhrec>x` 295 (the ranked ones), `usdfoil>x` 285 (the foil-priced ones), and
 * `usd=x` `usd=*` `edhrec=x` `prints=x` `year=x` `cn=x` each a plain 404.
 *
 * ONLY THOSE FOUR, ONLY BARE, AND ONLY ALONE. `pow=a`, `pow=w`, `pow=?`, `pow=∞`, `pow=inf` and
 * `pow=½` are the unknown-keyword sentence, and so are the quoted `pow="x"`, `pow="*"` and
 * `pow='*'`. The negated equality is the sentence its numeric twin gets (`-pow=*` is `Unknown
 * keyword “-pow”.`), which is why the leaf is re-read as `<kw><op>0` rather than answered here.
 *
 * This port ignored `*` with the unknown-keyword sentence and — `x` having been listed among the
 * column names a comparison may name on its right — handed `pow=x` to a parser that refused it.
 *
 * A value that only STARTS with one of these, or with a number, ends there and the rest is a term
 * of its own: `pow=xy` is `pow=0 y`. That is `numericValueSplit`, beside `classifyLeaf`.
 *
 * COST: one regex test on a numeric leaf at parse time. Nothing reaches the engine.
 */
const ZERO_WORD_RE = /^[xyz*]$/i;

/**
 * `Value out of range` — A NUMBER PAST ±2,461,449,600 IS NOT COMPARED WITH; the term is ignored.
 *
 * Found while measuring what Infinity Elemental's `∞` compares as (card_engine's `INFINITE_STAT`):
 * above a certain constant Scryfall stops answering the comparison and says so. Measured on
 * api.scryfall.com 2026-10-04, anchor `e:khm t:god` = 12, a row at 12 carrying the sentence being
 * a term that was dropped. The bound was found by bisection, one request per step:
 *
 *   pow>2461449600   pow>2461449600.0   pow>-2461449600   pt<2461449600   usd<2461449600
 *   cmc<2461449600                                             compared (404, or 12 with no warning)
 *   pow>2461449601   pow>2461449600.5   pow>02461449601   pow>-2461449601   pt<2461449601
 *   usd<2461449601   cmc<2461449601                            12 + `Value out of range`
 *
 * so it is the VALUE (a leading zero and a fraction are read), it is symmetric, and it is the same
 * on every numeric column and under every operator — each of these is the 12 with the sentence:
 * `pow=9999999999`, `tou>9999999999`, `loy<9999999999`, `mv:9999999999`, `edhrec<9999999999`,
 * `prints<9999999999`, `artists<9999999999`, `year<9999999999`, `collector<9999999999`,
 * `cn<9999999999`, `cn:9999999999`, `tix<9999999999`, `usdfoil<9999999999`. The echo is cut at 20
 * characters like every other (`pow>999999999999999…`), and the sentence has no full stop.
 *
 * (2,461,449,600 is 28,489 days of seconds — midnight on 1 January 2048 as a Unix time. Whatever
 * reads the number evidently also tries it as a timestamp.)
 *
 * The negated forms never reach it: `-pow>9999999999` is the silent tautology, `-pow=9999999999`
 * the negated-equality `Unknown keyword “-pow”.`, and `-cmc=9999999999` the value sentence.
 *
 * This port compared with the number: `pow>9999999999` beside the anchor was a 404, and
 * `loy<9999999999` 1 — the set's one planeswalker — where Scryfall answers all 12.
 *
 * COST: one number parse on a numeric leaf at parse time.
 */
const VALUE_OUT_OF_RANGE_REASON = "Value out of range";
const MAX_COMPARABLE_VALUE = 2_461_449_600;
const PLAIN_NUMBER_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;

function isOutOfRange(rawValue: string): boolean {
	return PLAIN_NUMBER_RE.test(rawValue) && Math.abs(Number(rawValue)) > MAX_COMPARABLE_VALUE;
}

/** `cn` / `number`: the string collector number under `:`/`=`, a number only under a comparison. */
const STRING_NUMBER_KEYWORDS: ReadonlySet<string> = new Set(["cn", "number"]);

/** Whether `keyword` reads `rawValue` as a number under `op` — the columns ZERO_WORD_RE applies to. */
function readsNumber(keyword: string, equality: boolean): boolean {
	if (MANA_VALUE_KEYWORDS.has(keyword) || NEGATED_EQUALITY_UNKNOWN_KEYWORD.has(keyword)) return true;
	return STRING_NUMBER_KEYWORDS.has(keyword) && !equality;
}

const MANA_VALUE_REASON = "The value must be a number, or \u201ceven\u201d/\u201codd\u201d";

/**
 * `even` and `odd`, each mapped to the other \u2014 the two words the mana-value keywords take where a
 * number goes, and what a LEADING `-` turns each into.
 *
 * \u2500\u2500\u2500 WHAT SCRYFALL DOES WITH THEM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *
 * Measured on api.scryfall.com 2026-10-03, one request per row, corpus `mv>=0` = 33,649:
 *
 *   mv:even    17,331    cmc:even 17,331    manavalue=even 17,331    mv=even 17,331
 *   mv:odd     16,317    manavalue:odd 16,317    mv=odd 16,317    cmc=odd 16,317
 *   mv:EVEN    17,331    mv:eVeN 17,331    mv:"even" 17,331       case and quotes are immaterial
 *   mv:foo     400 + `The value must be a number, or \u201ceven\u201d/\u201codd\u201d` \u2014 the sentence named them all along
 *
 *   mv>even  mv<even  mv>=odd  mv<=odd  mv!=even  mv!=odd       404 each, NO `warnings` key
 *   mv>even or (t:goblin t:wizard)   18 = the other arm          kept, and matching nothing
 *   -mv>even  -mv!=even              33,649                       the silent tautology below
 *
 * So `:`/`=` is the whole feature, and under a comparison the word is just a value that is not a
 * number: the same honored-and-empty leaf `cmc>=notanumber` is.
 *
 * \u2500\u2500\u2500 A NEGATED PARITY IS THE OTHER PARITY, NOT THE COMPLEMENT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *
 * The one place the two differ is Little Girl, whose mana value is 0.5 and is neither:
 *
 *   -mv:even   16,317    -mv=even 16,317    = mv:odd         -cmc:odd  -mv:"odd"  17,331 = mv:even
 *   -mv:even mv=0.5      404                                 -mv:odd mv=0.5      404
 *   -(mv:even)           16,318                              the GROUP is the honest complement
 *   -(mv:even or mv:odd) 1, Little Girl
 *
 * This is the same leaf-binding fault the numeric columns show everywhere else (`-mv:3` is
 * refused with the value sentence, `-mv>=3` is a tautology), in its third shape: on the two words
 * the `-` FLIPS the word. Rewritten here, on the raw text, for the reason `date` is: the parser's
 * `-mv:even` is the complement, which is what `/search` should answer and what `-(mv:even)`
 * answers on Scryfall too.
 */
const MANA_VALUE_PARITY_FLIP: ReadonlyMap<string, string> = new Map([
	["even", "odd"],
	["odd", "even"],
]);

/** The parity word a raw value spells, or null: quotes and case are immaterial (see above). */
function manaValueParity(rawValue: string): string | null {
	const word = unquote(rawValue).toLowerCase();
	return MANA_VALUE_PARITY_FLIP.has(word) ? word : null;
}

/**
 * A LEADING `-` ON A COMPARISON LEAF IS NOT APPLIED BY SCRYFALL. The term becomes always-true.
 *
 * This is the general case of the table above, and it is SILENT \u2014 no warning, no 400, nothing in
 * the response that says a term was not applied. That silence is why it went unnoticed while the
 * equality half, which announces itself, has been implemented here since the policy was written.
 *
 * \u2500\u2500\u2500 THE MEASUREMENT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *
 * Anchor `e:khm t:creature` = 151, one request per row, api.scryfall.com 2026-08-16. A row that
 * answers 151 is a term that did nothing:
 *
 *              positive   negated                  positive   negated
 *   pow>=1        146       151        year>=2022      11        151
 *   pow>1         125       151        year!=2021      11        151
 *   tou>=1        150       151        cn>=100        112        151
 *   tou!=1        133       151        edhrec>=5000   112        151
 *   pt>=3         141       151        artists>=2       0        151
 *   cmc>=3        112       151        paperprints>=2  87        151
 *   cmc!=3        106       151        papersets>=2    86        151
 *   loy>=3          1       151        pow>=tou       106        151
 *   usd>=1         28       151        cmc>=notanumber  0        151
 *   eur>=1         27       151
 *
 * All five of `>` `>=` `<` `<=` `!=` were probed on each of pow, tou, cmc, loy, usd, eur, tix,
 * year, cn, edhrec, artists, paperprints, papersets \u2014 65 rows, every one of them 151.
 *
 * \u2500\u2500\u2500 IT IS A TAUTOLOGY, NOT A DROPPED TERM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *
 * The distinction decides the implementation, because the two differ under `or`:
 *
 *   -pow>=1                       200, 33,599 \u2014 the WHOLE corpus, no warnings
 *   -pow:1                        400 "All of your terms were ignored." + its warning
 *   (-pow>=1 or t:god) e:khm      323 \u2014 all of Kaldheim
 *   (t:god) e:khm                  13 \u2014 what a REMOVED arm would have answered
 *   (-pow:1 or t:god) e:khm        13 + its warning \u2014 the ignore machinery really does remove
 *
 * So this cannot be routed through `ignoredWarning`: the term survives as a leaf that matches
 * everything. `-pow>=1 f:notaformat e:khm t:creature` is 151 warning ONLY about `f:notaformat`,
 * which pins that the two mechanisms coexist without borrowing each other's sentence.
 *
 * \u2500\u2500\u2500 WHERE THE RULE STOPS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *
 * `-( \u2026 )` is honored throughout \u2014 `-(cmc>=3) e:khm t:creature` is 39, the complement of
 * `cmc>=3`'s 112, where the bare `-cmc>=3` is 151. The fault is in how `-` binds to a comparison
 * LEAF, not in negation.
 *
 * And the set-comparison columns negate correctly, which is what makes this a table of keywords
 * rather than a rule about the operator (positive, negated, and 151 minus the positive):
 *
 *   r>=rare       52   99 \u2713      c>=2        19  132 \u2713      m>=2      102   49 \u2713
 *   r!=rare      114   37 \u2713      c!=2       135   16 \u2713      m!=2      151    0 \u2713
 *   rarity>=rare  52   99 \u2713      colour>=2   19  132 \u2713      produces>=2 5  146 \u2713
 *                                id>=2       19  132 \u2713      devotion>={r}{r} 7 144 \u2713
 *
 * Every alias of those columns was probed and agrees (`color colors colour colours`,
 * `id identity ci commander`, `r rarity`, `m mana`). The upstream-only spellings
 * `color_identity`/`coloridentity` are deliberately NOT here: Scryfall does not know them, so on
 * Scryfall they take the tautology like any other unknown keyword \u2014 and NOT_SCRYFALL_KEYWORDS
 * drops them before this rule is reached anyway.
 *
 * On a TEXT column or an unknown keyword the positive comparison already matches nothing
 * (`name>zzz`, `t>creature`, `nonsense>=1` are all 404 with no warning), so the negated form
 * matching everything is ordinary boolean negation rather than a fault \u2014 but the answer to
 * reproduce is the same tautology, and routing those through here is what stops
 * `-nonsense>=1 e:khm t:creature` emitting an unknown-keyword warning Scryfall does not
 * (measured: 151, `warnings` absent). It is also why this runs BEFORE the value validators:
 * `-lang>zz`, `-f>notaformat` and `-oracleid>abc` are 151 with no warning where their unnegated
 * twins are ignored-and-warned.
 */
const NEGATION_HONORING_COMPARISONS: ReadonlySet<string> = new Set([
	"c",
	"color",
	"colors",
	"colour",
	"colours",
	"id",
	"identity",
	"ci",
	"commander",
	"r",
	"rarity",
	"m",
	"mana",
	"produces",
	"devotion",
]);

/**
 * `date` is the third behaviour: the `-` is DISCARDED and the term applied POSITIVELY.
 *
 * Not dropped (that would answer the anchor's 151) and not honored (that would answer the
 * complement) \u2014 measured on every operator, with values chosen so the three readings differ:
 *
 *                     positive   negated   honored would be
 *   date>=2022           11        11            140
 *   date<2022           141       141             11
 *   date>2021            11        11            141
 *   date<=2021          141       141             11
 *   date!=2021           11        11            141
 *   date:2021           141       141             11
 *   date=2021           141       141             11
 *
 * `year`, the other spelling of the same underlying column, does NOT do this: `year>=2022` is 11
 * and `-year>=2022` is 151, the ordinary tautology above. Two keywords onto one column, two
 * different faults \u2014 which is why this is a keyword table and not a column one.
 *
 * `-(date>2021) e:khm t:creature` is 141, the honest complement of 11, so this too is the leaf
 * binding rather than negation.
 */
const DATE_KEYWORDS: ReadonlySet<string> = new Set(["date"]);

/**
 * THE KEYWORDS SCRYFALL ACTUALLY IMPLEMENTS `>` `>=` `<` `<=` `!=` FOR. Everything else — a text
 * column this parser knows, a directive, or a keyword nobody knows — is HONORED AND MATCHES
 * NOTHING under those five operators, silently.
 *
 * ─── THE ENUMERATION ─────────────────────────────────────────────────────────────────────────
 *
 * Not reasoned about: every alias in `DB_COLUMNS` and every directive name was probed as
 * `<alias>>=0 e:khm t:creature` against api.scryfall.com, 2026-08-16, one request each. `>=0` is
 * the discriminator because it is satisfiable on every numeric column, so a 404 means the
 * comparison did not happen rather than that it happened and found nothing. 78 rows fell into
 * exactly three classes:
 *
 *   COMPARES (200, a real count)
 *     c ci color colors colour colours commander id identity   151 (colour count)
 *     cmc mv manavalue m mana                                  151
 *     pow power tou toughness                                  151
 *     cn number year                                           151
 *     usd eur tix                                              141
 *     loy loyalty                                                1
 *     produces                                                 151
 *
 *   COMPARES, AND CHECKS ITS VALUE (200 + an ignored-term warning on a bad value)
 *     r rarity        `Unknown rarity “0.”`
 *     date            `Invalid date or unknown set code “0”`
 *     devotion        `Devotion can only match single color or hybrid mana.`
 *
 *   MATCHES NOTHING (404, and NO `warnings` key)
 *     a art artist arttag atag banned border e s set f format legal restricted flavor fo ft
 *     fulloracle function frame has is keyword kw lang language layout name o oracle oracle_id
 *     oracleid oracletag otag set_type settype st t type watermark wm
 *     unique sort order direction dir prefer            (the directive names take it too)
 *     nonsense                                          (and so does any unknown keyword)
 *
 * ─── WHY IT IS ONE RULE AND NOT TWO ──────────────────────────────────────────────────────────
 *
 * The unknown-keyword case and the text-column case reach the same answer by the same route, and
 * the pairs that separate them are the proof:
 *
 *   nonsense:1   200, 151 + `Unknown keyword “nonsense”.`   nonsense>=1  404, no warning
 *   t:creature   200, 151                                   t>creature   404, no warning
 *   f:notaformat 200, 151 + `Unknown game format`           f>notaformat 404, no warning
 *   lang:zz      200, 151 + `Unknown language \`zz\``          lang>zz      404, no warning
 *
 * Under `:`/`=` each of those runs a validator and ignores the term; under a comparison NONE of
 * them does, and the term survives matching nothing. So this must run BEFORE the unknown-keyword
 * rule and before every value validator — a comparison never reaches them.
 *
 * `nonsense>1`, `nonsense<1`, `nonsense<=1` and `nonsense!=1` are all the same 404, so it is the
 * whole comparison family and not `>=` alone.
 *
 * ─── WHAT IS DELIBERATELY NOT IN THE SET ─────────────────────────────────────────────────────
 *
 * A numeric column Scryfall compares and this parser has no spelling for answers the 404 an
 * unknown keyword answers under this rule — wrong against Scryfall's count, and putting it in
 * the set would be worse: a term kept for a keyword the parser cannot lex is a 400. The names
 * that were in that state are listed at SCRYFALL_ONLY_KEYWORDS, and each JOINS this set on the
 * commit that gives it a column.
 *
 * `pt` was the first, on 2026-10-03, and is the worked example of what the gap costs: `pt<6`
 * answered this rule's 404 against Scryfall's 10,818, and `pt=2 t:creature` answered all 18,760
 * creatures with an unknown-keyword warning against Scryfall's 2,127. `edhrec` and the
 * `collector` pair followed (x68).
 */
const COMPARABLE_KEYWORDS: ReadonlySet<string> = new Set([
	// colour and colour-identity counts
	"c",
	"color",
	"colors",
	"colour",
	"colours",
	"ci",
	"id",
	"identity",
	"commander",
	"produces",
	// mana
	"m",
	"mana",
	"devotion",
	// numeric columns
	"cmc",
	"mv",
	"manavalue",
	"pow",
	"power",
	"tou",
	"toughness",
	"pt",
	"powtou",
	"loy",
	"loyalty",
	"usd",
	"eur",
	"tix",
	"cn",
	"number",
	"year",
	// x68, each measured 2026-10-03: `collector>=390 e:khm` 17 = `cn>=390 e:khm`,
	// `collectornumber>=390 e:khm` 17, `edhrec>=5000 e:khm` 222, `edhrec<=10` 5.
	"collector",
	"collectornumber",
	"edhrec",
	"edhrecrank",
	"edhrec_rank",
	// `usdfoil>=1 e:khm` 68, `usdfoil<1 e:khm` 229, `usdfoil!=1 e:khm` 285.
	"usdfoil",
	// `prints>=10` 1,521, `sets>=10` 1,068, `paperprints>=10` 1,282, `papersets>=10` 898,
	// `illustrations>=10` 95, `artists>=2` 631, `artists!=1` 638.
	"prints",
	"sets",
	"paperprints",
	"papersets",
	"illustrations",
	"artists",
	// ordered enums / dates
	"r",
	"rarity",
	"date",
]);

/** The five operators the rule above is about; `:` and `=` are the other, older mechanism. */
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([">", ">=", "<", "<=", "!="]);

/** `f:`/`format:`/`legal:`/`banned:`/`restricted:` — Scryfall's game formats. */
const SCRYFALL_FORMATS: ReadonlySet<string> = new Set([
	// The `legalities` key set of a live card object (api.scryfall.com/cards/named, 2026-08-16) …
	"standard",
	"future",
	"historic",
	"timeless",
	"gladiator",
	"pioneer",
	"modern",
	"legacy",
	"pauper",
	"vintage",
	"penny",
	"commander",
	"oathbreaker",
	"standardbrawl",
	"brawl",
	"competitivebrawl",
	"alchemy",
	"paupercommander",
	"duel",
	"oldschool",
	"premodern",
	"predh",
	"tlr",
	// … plus the search-only spellings measured as honored. `pauperedh` and `frontier` are NOT
	// among them — both come back ignored-and-warned, which is what makes this a measured list
	// rather than a guess at a superset.
	"explorer",
	"historicbrawl",
	"duelcommander",
	"edh",
]);

/**
 * `lang:`/`language:` — every spelling measured as honored, plus `any`.
 *
 * Scryfall is generous here (`zh`, `jp`, `sp`, `kr`, `cn`, `tw`, `cs`, `ru-ru`, `pt-br` and the
 * full English names all resolve) and still rejects `zz`, `po` and the ambiguous `chinese`. The
 * set is the measured boundary; a spelling missing from it is ignored-and-warned, which is what
 * this port did to `lang:zz` and is no worse than the empty 404 it used to answer for all of them.
 */
const SCRYFALL_LANGUAGES: ReadonlySet<string> = new Set([
	"any",
	"en",
	"es",
	"fr",
	"de",
	"it",
	"pt",
	"ja",
	"ko",
	"ru",
	"zhs",
	"zht",
	"he",
	"la",
	"grc",
	"ar",
	"sa",
	"ph",
	"qya",
	"cs",
	"zh",
	"jp",
	"sp",
	"kr",
	"cn",
	"tw",
	"ru-ru",
	"pt-br",
	"english",
	"spanish",
	"french",
	"german",
	"italian",
	"portuguese",
	"japanese",
	"korean",
	"russian",
	"phyrexian",
	"chinesesimplified",
	"chinesetraditional",
]);

/** `r:`/`rarity:` — Scryfall's rarity words and their single-letter forms. */
const SCRYFALL_RARITIES: ReadonlySet<string> = new Set([
	"common",
	"uncommon",
	"rare",
	"special",
	"mythic",
	"bonus",
	"c",
	"u",
	"r",
	"s",
	"m",
	"b",
]);

/**
 * What Scryfall accepts as an `oracleid:` value — a strict v4 UUID, case-insensitive. The nil UUID,
 * a version-1 shape, a bad variant nibble and the unhyphenated form are each "ignored" with the
 * warning below (measured 2026-09-25). Shared with the extras gate, where the same check decides
 * whether the term reached Scryfall's tree at all and so whether it can force `include_extras`.
 */
export const UUID_V4_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/**
 * The colour VALUES Scryfall reads as a name rather than as a set of letters.
 *
 * Measured one request each (`c:<value> e:khm`, 2026-08-16). The accepted names are exactly the ten
 * guilds, the ten shards and wedges, the five HYPHENATED four-colour names plus their five
 * one-word synonyms, `rainbow`, `all`, `gold`, `brown`, and the British spellings — while `yore`,
 * `glint`, `dune`, `ink`, `witch`, `five` and `mono` are all REJECTED, so the un-hyphenated
 * four-colour nicknames are not in Scryfall's table and this list is a boundary rather than a
 * superset. An all-digit value (`c:0`, `c:2`) is a count and always fine.
 *
 * The parser knows every one of them itself — the set-valued names through `COLOR_ALIAS_TO_CODES`,
 * and the `m` family (`m`, `gold`, `multicolor(ed)`, `multicolour(ed)`) through
 * `COLOR_COUNT_NAMES`, which is a colour COUNT rather than a set and lowers to the numeric
 * comparison (`c:m` = `c>=2` = 44 in Kaldheim, where `c:2` = 43). So what this table still decides
 * is only which values Scryfall REFUSES: it has to stay a superset of the parser's vocabulary,
 * because a name listed here that the parser cannot spell is a 400 where Scryfall answers, and a
 * name missing here that the parser CAN spell is a warning where Scryfall is silent.
 *
 * WHICH IS WHY IT IS DERIVED AND NOT WRITTEN OUT. Two hand-kept mirrors of one vocabulary drifted
 * twice — `produces:any` (fixed 3288c89) and then the five Strixhaven colleges, which the parser
 * has spelled since 2026-08-16 while this list did not, so `c:lorehold e:khm t:creature` answered
 * the UNFILTERED 151 with a warning where Scryfall answers 2. The invariant the doc-comment above
 * declares is now the definition: this set IS the parser's column-independent colour vocabulary,
 * so a name added to db-info is known here on the same commit and can never be a warning again.
 *
 * The measured boundary survives the derivation because the boundary lives in db-info: the names
 * Scryfall REFUSES (`yore`, `glint`, `dune`, `ink`, `witch`, `five`, `mono`, `nephilim`,
 * `chromatic`) are absent from COLOR_ALIAS_TO_CODES for exactly the same measured reason they were
 * absent here, and `any` is scoped away from the colour columns in COLUMN_SCOPED_COUNT_NAMES
 * rather than living in COLOR_COUNT_NAMES. The one direction derivation cannot police — the parser
 * gaining a name Scryfall does NOT accept — is what the vocabulary test in
 * tests/routes/query-terms.test.ts asserts, name by name, against the live-measured boundary.
 */
const COLOR_NAMES: ReadonlySet<string> = new Set([...COLOR_ALIAS_TO_CODES.keys(), ...COLOR_COUNT_NAMES]);

/**
 * The names that belong to `produces:` alone — `any` today, and whatever else db-info ever scopes
 * to produced_mana. Read out of COLUMN_SCOPED_COUNT_NAMES by resolving `produces` to its db column
 * through ALIAS_TO_FIELD_INFOS, the same resolution the parser's own validColorNamesFor performs,
 * so the column name is never spelled twice.
 *
 * `any` is the only entry this table has that COLOR_NAMES must not gain: on the colour columns
 * Scryfall refuses it and drops the term (`t:creature c:any` = `t:creature` = 18,753, and `c:any`
 * alone answers "All of your terms were ignored"), while on produced_mana it is HONOURED —
 * `produces:any` = 2,603 = `produces>=1`. Scoping it in db-info is what keeps `c:any` / `id:any`
 * on the "Unknown color “a”" drop they already answered.
 */
const PRODUCES_ONLY_NAMES: ReadonlySet<string> = new Set(
	[...COLUMN_SCOPED_COUNT_NAMES]
		.filter(([column]) => (ALIAS_TO_FIELD_INFOS.get("produces") ?? []).some((fi) => fi.dbColumnName === column))
		.flatMap(([, names]) => [...names]),
);

/**
 * The WORDS for colorless, which `produces:` does not accept — derived as the names that spell the
 * bare `c`, because that is what makes them refusable there rather than any property of the words.
 *
 * Measured: `produces:colorless` answers "Unknown color “e”" and `produces:brown` "Unknown color
 * “n”", where `c:colorless` and `c:brown` are both simply names. Colorless is a producible VALUE on
 * produced_mana, spelled `c` — `produces:wubrgc` is honoured — so Scryfall's produces table holds
 * the letter and not the three words for it. Deriving the exclusion from the code means a fourth
 * synonym for colorless added to COLOR_ALIAS_TO_CODES is excluded here on the same commit.
 */
const COLORLESS_WORDS: ReadonlySet<string> = new Set(
	[...COLOR_ALIAS_TO_CODES].filter(([, code]) => code === "c").map(([name]) => name),
);

/** `produces:` accepts the same names minus the words for colorless, PLUS its own scoped names. */
const PRODUCES_NAMES: ReadonlySet<string> = new Set([
	...[...COLOR_NAMES].filter((n) => !COLORLESS_WORDS.has(n)),
	...PRODUCES_ONLY_NAMES,
]);

/** The letters a colour set is spelled with: the five colours, colourless, and multicolour. */
const COLOR_LETTERS = "wubrgcm";
const COLORED_LETTERS = "wubrg";

/**
 * Why Scryfall refuses a colour value, or null when it does not.
 *
 * THE ORDER OF THE THREE CHECKS IS MEASURED, not chosen: `c:witch` spells `w i t c h`, whose `i`,
 * `t` and `h` are not colours, and Scryfall still answers "A card cannot be both colored and
 * colorless" — so the contradiction is decided on the letters it DID recognize, before it complains
 * about the ones it did not.
 *
 * But the `m` rule is decided FIRST, ahead of the contradiction: `c:monocolor`, `c:chromatic` and
 * `c:spectrum` all spell a `c` alongside coloured letters AND contain an `m`, and Scryfall answers
 * the `m` sentence for every one of them. Reading the contradiction first got all three wrong
 * while still fitting `c:witch` — the order is pinned by values that SEPARATE the two rules.
 *
 * And the contradiction does not exist for `produces:` at all, because colorless is a genuine
 * producible value there: `produces:wubrgc` is honoured (it matches nothing) and
 * `produces:colorless` answers "Unknown color “e”" — the unknown-letter sentence — where
 * `c:colorless` is simply a name.
 *
 * The `m` rule reads the WHOLE value, not the letters it recognized, and stops at five characters.
 * Both halves were needed to fit the measurements, and the port's first reading of this rule
 * (recognized letters only, untruncated) got `c:mono` wrong in the loudest way available — it
 * answered "Unknown color “n”" where Scryfall answers the `m` sentence. Seven values pin it, each
 * one `sorted(set(value) - {m, -})` cut to five: `mono`→no, `mm`→(empty), `mwu`→uw, `mzy`→yz,
 * `m1`→1, `mono-red`→denor, `monocolor`→clnor, `monocolored`→cdeln, `nephilim`→ehiln (not
 * "ehilnp"), `chromatic`→achio (not "achiort"), `spectrum`→ceprs (not "ceprstu"), `prismatic`→acipr.
 *
 * THE HINT ECHOES THE KEYWORD THE USER TYPED, not a canonical `c`. Measured 2026-08-28, one
 * request each, anchor `e:khm` = 323: `c:mw` → "Use c>w", `color:mw` → "Use color>w", and the same
 * for `colors`, `colour`, `colours`, `id`, `identity`, `ci`, `commander` and `produces` — ten
 * spellings, ten different hints. This port said `c>` for all ten, which agreed only on the `c:`
 * spelling and is why the divergence hid: `id:mono` is "Use id>no" and `produces:nephilim` is
 * "Use produces>ehiln" where this port answered "Use c>no" and "Use c>ehiln" (42 sweep cases).
 * The hint's keyword is LOWERCASED however it was typed — `C:MW` answers "Use c>w instead." —
 * which is exactly what `keyword` already holds, so it is echoed as-is. (Scryfall ALSO lower-cases
 * the expression it quotes — `Invalid expression “c:mw”` for `C:MW`. That is a property of the
 * echo rather than of the colour rule, and it belongs to every ignored term, not just this one;
 * `ignoredWarning` carries the measurements and does the downcasing.)
 *
 * And the letter it names is the ALPHABETICALLY FIRST unrecognized one, which took nine values to
 * establish and no two of which agree on any simpler rule: `glint`→i, `yore`→e, `dune`→d,
 * `null`→l, `void`→d, `spirit`→i, `land`→a, `five`→e, `qq`→q. Not the first in the string, not the
 * last — the first in sorted order.
 */
/** The text between a `/…/` value's delimiters, or the value unchanged when it has none. */
function stripRegexDelimiters(value: string): string {
	return value.length >= 2 && value.startsWith("/") && value.endsWith("/") ? value.slice(1, -1) : value;
}

function colorReason(value: string, keyword: string): string | null {
	// A SLASH-DELIMITED VALUE IS ORDINARY VALUE TEXT on these columns — Scryfall runs no regex
	// here, and the delimiters are simply not colour letters. Validating them WOULD have named
	// `/` as the unknown colour, which is neither what Scryfall says nor a term it drops:
	// measured on api.scryfall.com 2026-08-28, `c:/w/` is 7,105 (= `c:w`, honoured, no warning at
	// all) while `c:/xyz/` is `Invalid expression “c:/xyz/” was ignored. Unknown color “x”` — the
	// expression echoed WITH its slashes and the letter named from WITHOUT them. Stripping here
	// and leaving the echo alone is exactly that split.
	const lower = stripRegexDelimiters(value).toLowerCase();
	// `produces:` reads a NARROWER name table than the colour columns do: `produces:brown` comes
	// back "Unknown color “n”" and `produces:colorless` "Unknown color “e”", where `c:brown` and
	// `c:colorless` are both fine — colorless is a producible VALUE there, spelled `c`, and the
	// words for it are simply not in that table. `produces:all` is honoured and means all six
	// (it matches nothing: no card produces every colour and colorless).
	const names = keyword === "produces" ? PRODUCES_NAMES : COLOR_NAMES;
	if (lower === "" || names.has(lower) || /^\d+$/.test(lower)) return null;
	const known = new Set<string>();
	const unknown = new Set<string>();
	for (const ch of lower) (COLOR_LETTERS.includes(ch) ? known : unknown).add(ch);
	if (lower.includes("m") && lower.length > 1) {
		const rest = [...new Set([...lower])]
			.filter((ch) => ch !== "m" && ch !== "-")
			.sort()
			.join("")
			.slice(0, COLORED_LETTERS.length);
		return `Using \u201cm\u201d with other colors is no longer supported. Use ${keyword}>${rest} instead.`;
	}
	if (keyword !== "produces" && known.has("c") && [...known].some((ch) => COLORED_LETTERS.includes(ch))) {
		return "A card cannot be both colored and colorless.";
	}
	if (unknown.size > 0) return `Unknown color \u201c${[...unknown].sort()[0]}\u201d`;
	return null;
}

/** The keywords whose value is a colour set. */
const COLOR_KEYWORDS: ReadonlySet<string> = new Set([
	"c",
	"color",
	"colors",
	"colour",
	"colours",
	"ci",
	"id",
	"identity",
	"commander",
	"produces",
]);

/** The keyword whose value is a devotion cost. */
const DEVOTION_KEYWORDS: ReadonlySet<string> = new Set(["devotion"]);

/** The cost column's two spellings — `devotion` shares the parser class and NOT this behaviour. */
const MANA_COST_KEYWORDS: ReadonlySet<string> = new Set(["mana", "m"]);

/**
 * What Scryfall's mana lexer consumes before it complains, so the leftover it quotes can be
 * reproduced. `mana>=/{r}/` names only `//`, which says the braces, the colour letters and the
 * digits were all read as symbols and only the delimiters survived.
 */
const MANA_COST_VALUE_CHARS: ReadonlySet<string> = new Set("{}/0123456789wubrgcsxyzphWUBRGCSXYZPH");

/** Colour letters, and the rest of the alphabet a mana symbol may be spelled from. */
const DEVOTION_COLORS = "wubrg";
const MANA_SYMBOL_PARTS = new Set([..."wubrgcsxyzp"]);

const DEVOTION_REASON = "Devotion can only match single color or hybrid mana.";

/**
 * `mana:{q}` — WHAT SCRYFALL'S MANA READER LEAVES UNREAD, which is what its sentence names.
 *
 * This port answered `400 Failed to parse query` for every value below: the parser's symbol
 * validator (upstream #909) refuses the whole query, where Scryfall drops the one term. Measured
 * 2026-10-04, anchor `e:khm t:god` = 12, each row the 12 carrying
 * `Unknown mana symbols “<what is left, upper-cased>”.` — under `mana:`, `m:`, `mana=`, `mana>=`
 * and `-mana:` alike, and `mana:{q}` alone is the 400 `All of your terms were ignored.`:
 *
 *   {q} → {Q}     {t} → {T}     {e} → {E}     {a} → {A}     {d} → {D}     {p} → {P}
 *   {tk} → {TK}   {q}{t} → {Q}{T}   {} → {}   "{q}" → {Q}
 *   q → Q         wq → Q        1q → Q        2wwq → Q      abc → A       hello → HEO
 *   {w}{q} → {Q}                {w}{w}{zz} → {}             {pw} → {P}    {chaos} → {HAO}
 *   {1/w} → {1/}  {2/c} → {2/}  {2/2} → {2/2} {w/q} → {/Q}  {w/w} → {/}
 *   {w/u/b} → {//}              {w/p/p} → {/P/P}
 *
 * One reading fits every row. A whole `{…}` group that is a mana symbol is consumed; then, of
 * what is left, each bare letter that is a symbol on its own (`w u b r g c s x y z l`) is
 * consumed wherever it stands — inside a group that was not a symbol too, which is why `{1/w}`
 * leaves `{1/}` and `{chaos}` leaves `{HAO}` — and a number is consumed only at the very start.
 * What remains, in order, is the sentence.
 *
 * WHICH GROUPS ARE SYMBOLS is read off what Scryfall honored (a 404 with no warning): `{100}`
 * `{s}` `{l}` `{h}` `{hw}` `{u/w}` `{c/w}` `{c/p}`, and a hybrid in EITHER order — `{p/w}` and
 * `{w/2}` are honored where this parser takes only `{w/p}` and `{2/w}`, so those two are
 * respelled rather than left to fail. A doubled part is not one (`{w/w}`, `{2/2}`, `{w/p/p}`),
 * nor a generic half that is not 2, nor `{2/c}`. The table errs toward calling a group a symbol:
 * that leaves the term to the parser, as before, where the other error would drop a term Scryfall
 * honors. `{h}`, `{hw}`, `{hr}`, `{l}` and `{c/p}` are in that state — honored there, still a
 * parse error here.
 *
 * NOT DECIDED HERE, and left to the parser exactly as before: a value with a character outside
 * letters, digits, braces and `/`, and a bare digit that is not leading (`w2q`), which no probe
 * covered. And one that was measured and is not reproduced: `mana:{w e:khm t:god` is the 12
 * naming “{” there, and a parse error here — this scan reads an unclosed `{` to the end of the
 * query, as the lexer does, so the term never arrives alone.
 *
 * COST: one pass over the value of a `mana:` term at parse time.
 */
const MANA_SYMBOL_VALUE_RE = /^[A-Za-z0-9{}/]+$/;
const MANA_BARE_SYMBOLS: ReadonlySet<string> = new Set("wubrgcsxyzl");
const MANA_SINGLE_SYMBOLS: ReadonlySet<string> = new Set([..."wubrgcsxyzlh", "hw", "hr"]);
const MANA_HYBRID_COLORS = "wubrgs";

/** A `{…}` group's parts, in the order this parser reads them — or null when it is no symbol. */
function manaSymbolParts(inner: string): string[] | null {
	const parts = inner.split("/");
	if (parts.length === 1) return /^\d+$/.test(inner) || MANA_SINGLE_SYMBOLS.has(inner) ? parts : null;
	if (new Set(parts).size !== parts.length || parts.length > 3) return null;
	const colors = parts.filter((part) => MANA_HYBRID_COLORS.includes(part) && part.length === 1);
	const has = (part: string) => parts.includes(part);
	if (parts.length === 3) return colors.length === 2 && has("p") ? [...colors, "p"] : null;
	if (colors.length === 2) return parts;
	if (colors.length === 1) {
		if (has("c")) return parts;
		if (has("2")) return ["2", colors[0] as string];
		if (has("p")) return [colors[0] as string, "p"];
	}
	return has("c") && has("p") ? ["c", "p"] : null;
}

/**
 * What Scryfall's mana reader leaves of `value` (upper-cased; empty when it reads all of it) and
 * the value with each hybrid's parts in this parser's order — or null when the value is a shape
 * this does not decide.
 */
function readManaSymbols(value: string): { leftover: string; respelled: string } | null {
	if (!MANA_SYMBOL_VALUE_RE.test(value)) return null;
	let leftover = "";
	let respelled = "";
	let pos = /^\d*/.exec(value)?.[0].length ?? 0;
	respelled += value.slice(0, pos);
	const bare = (ch: string, inGroup: boolean): boolean => {
		if (MANA_BARE_SYMBOLS.has(ch.toLowerCase())) return true;
		// A digit inside a group that is no symbol stays (`{1/w}` → `{1/}`); a bare one that is not
		// leading was never measured.
		if (/\d/.test(ch) && !inGroup) return false;
		leftover += ch;
		return true;
	};
	while (pos < value.length) {
		const ch = value[pos] as string;
		const close = ch === "{" ? value.indexOf("}", pos + 1) : -1;
		if (close === -1) {
			if (!bare(ch, false)) return null;
			respelled += ch;
			pos++;
			continue;
		}
		const group = value.slice(pos, close + 1);
		const parts = manaSymbolParts(group.slice(1, -1).toLowerCase());
		if (parts !== null) respelled += `{${parts.join("/")}}`;
		else {
			for (const inner of group) bare(inner, true);
			respelled += group;
		}
		pos = close + 1;
	}
	return { leftover: leftover.toUpperCase(), respelled };
}

function unknownManaSymbols(value: string): string {
	return `Unknown mana symbols “${value.toUpperCase()}”.`;
}

/**
 * `devotion:` takes ONE colour, repeated — or one hybrid PAIR, repeated. Anything else is
 * ignored-and-warned, in both polarities and under every operator.
 *
 * Two different sentences, and which one you get says whether Scryfall recognized the symbol at
 * all. Measured against api.scryfall.com 2026-08-16, anchor `e:khm t:creature` = 151:
 *
 *   HONORED            {r} 27   {R} 27   r 27   {r}{r} 7   rr 7   {r}{r}{r} 404 (nothing that deep)
 *                      {r/g} 62   {g/r} 62   {r/g}{r/g} 16   {r/g}{g/r} 16
 *
 *   `Devotion can only match single color or hybrid mana.`
 *                      {w}{u}   {r}{g}   rg          two different colours
 *                      {r}{r/g}                      a colour and a hybrid do not mix
 *                      {c} {s} {x} {1}               recognized symbols that are not a colour
 *                      {2/r} {r/p}                   hybrids with a non-colour half
 *                      2                             any non-symbol value
 *
 *   `Unknown mana symbols “<VALUE, UPPERCASED>”.`
 *                      {p} → “{P}”     {} → “{}”     notmana → “NOTMANA”
 *
 * So `{c}`, `{s}`, `{x}`, `{1}`, `{2/r}` and `{r/p}` ARE mana symbols and simply are not devotion,
 * while a lone `{p}` and an empty `{}` are not symbols at all. The echo is the value as written
 * with `toUpperCase` applied — braces kept, nothing re-spelled.
 *
 * Order-insensitivity of the hybrid pair is measured, not assumed: `{g/r}` and `{r/g}` answer the
 * same 62, and mixing the two spellings in one value answers the same 16 as either alone.
 *
 * Both polarities: `-devotion>2` and `-devotion:2` are 151 with the devotion sentence, the same as
 * their positive twins — this is a VALUE check, not a negation rule, which is why it sits with the
 * other validators and after the negation block. (`devotion` is in
 * NEGATION_HONORING_COMPARISONS, so a negated comparison reaches here rather than being swallowed.)
 */
function devotionReason(value: string): string | null {
	const lower = value.toLowerCase();
	const symbols: string[] = [];
	if (lower.startsWith("{")) {
		// `{a}{b}{c}` — anything that is not a closed brace group makes the whole value unreadable.
		const groups = lower.match(/\{[^{}]*\}/g);
		if (groups === null || groups.join("") !== lower) return unknownManaSymbols(value);
		symbols.push(...groups.map((g) => g.slice(1, -1)));
	} else {
		symbols.push(...lower);
	}
	if (symbols.length === 0) return unknownManaSymbols(value);
	const signatures: string[] = [];
	for (const symbol of symbols) {
		const parts = symbol.split("/");
		// A symbol Scryfall does not know at all: an empty group, or a part outside the mana
		// alphabet. A LONE `p` is in that class too — `{p}` is "Unknown mana symbols", where
		// `{r/p}` is a symbol Scryfall knows and rejects for devotion.
		if (parts.some((p) => !MANA_SYMBOL_PARTS.has(p) && !/^\d+$/.test(p))) return unknownManaSymbols(value);
		if (parts.length === 1 && parts[0] === "p") return unknownManaSymbols(value);
		// Known, but devotion counts colour pips only: every half must be a colour.
		if (!parts.every((p) => DEVOTION_COLORS.includes(p))) return DEVOTION_REASON;
		signatures.push([...new Set(parts)].sort().join(""));
	}
	if (new Set(signatures).size > 1) return DEVOTION_REASON;
	return null;
}

/**
 * The keywords a `field:/pattern/` actually REACHES a regex engine on here.
 *
 * Scryfall's own list is four columns, and its docs page names them:
 * <https://scryfall.com/docs/regular-expressions> gives `type:`/`t:`, `oracle:`/`o:`,
 * `flavor:`/`ft:` and `name:`, and every other keyword answers
 * `Unknown regular expression keyword “X”.` — verified one probe per alias against
 * api.scryfall.com on 2026-08-28, all 80 spellings `DB_COLUMNS` carries.
 *
 * THIS SET IS WIDER THAN SCRYFALL'S, deliberately and measurably (upstream #907): the engine runs
 * a compiled pattern against every string column the store holds, so on this deployment
 * `a:/^rebecca/` is 170, `s:/^kh/` 442, `cn:/^1/` 17,483, `layout:/^trans/` 401,
 * `border:/^black/` 32,817 and `wm:/^az/` 107, where Scryfall ignores the term and warns.
 * Answering where Scryfall warns costs a searcher nothing — the same rule `color_identity` and
 * `coloridentity` are kept under in db-info — so those stay.
 *
 * `fo`/`fulloracle` join `oracle`/`o`: Scryfall takes a regex on them too (`fo:/\(this creature/`
 * is 1,098 there, a pattern the reminder-stripped column cannot match at all).
 */
const REGEX_CAPABLE_KEYWORDS: ReadonlySet<string> = new Set([
	// Scryfall's four.
	"name",
	"type",
	"t",
	"oracle",
	"o",
	"fo",
	"fulloracle",
	"flavor",
	"ft",
	// This port's addition: every other string column the engine stores.
	"artist",
	"a",
	"set",
	"s",
	"e",
	"number",
	"cn",
	"layout",
	"border",
	"watermark",
	"wm",
]);

/**
 * The keywords where Scryfall never sees a regex AT ALL: `/…/` is read as part of the VALUE, and
 * the value's own validator is what speaks. Left to the validators below for that reason.
 *
 * Measured 2026-08-28. On the colour columns the slashes are simply not colour letters and are
 * skipped: `c:/w/` is 7,105 — exactly `c:w` — and `c:/wu/` is 718, exactly `c:wu`; `id:/w/` is
 * 7,993 and `produces:/g/` is 1,274. `set_type:` and `oracle_id:` answer `Unknown set type
 * “/^exp/”` and `You must provide a valid v4 UUID.` — their value sentences, not the regex one —
 * while the OTHER spellings of the same two columns (`st:`, `settype:`, `oracleid:`) do get the
 * regex sentence, which is why this is a set of spellings rather than of columns.
 *
 * `mana`/`m` ARE HERE FOR THE OPPOSITE REASON, and this file used to have it backwards. The
 * slashes are not value characters there: `mana:/…/` is a genuine regex, run against the printed
 * cost string, and `mana:/^{2}/` proves it by answering `400 Invalid regular expression:
 * quantifier operand invalid.` — the compiler's own sentence. It belongs on this list anyway,
 * because the whole list means "do not emit the regex-KEYWORD sentence, let the value parser
 * decide": under `:` and `=` the parser builds a RegexValueNode, and under every other operator
 * it falls back to the symbol lexer, which is what reproduces Scryfall's `Unknown mana symbols
 * “/^TAP/”` for `mana!=/^tap/`. `devotion` shares the parser class and is NOT here — it takes the
 * regex sentence, exactly as Scryfall's `Unknown regular expression keyword “devotion”` does.
 */
const REGEX_VALUE_FIRST_KEYWORDS: ReadonlySet<string> = new Set([
	"c",
	"color",
	"colors",
	"colour",
	"colours",
	"id",
	"identity",
	"ci",
	"commander",
	"produces",
	"mana",
	"m",
	"oracle_id",
	"scryfall_id",
	"illustration_id",
]);

/**
 * The one keyword whose regex-shaped value gets a VALUE sentence rather than the regex one.
 *
 * `set_type:/^exp/` answers `Unknown set type “/^exp/”` on api.scryfall.com while `st:/^exp/` and
 * `settype:/^exp/` answer `Unknown regular expression keyword …` — the same per-SPELLING split
 * `oracle_id:` and `oracleid:` show (2026-08-28). This port had no set-type value validator at
 * all, so all three spellings were `400 Failed to parse query` where Scryfall drops the term and
 * answers the rest: `st:/^exp/ t:goblin` is 563 there.
 */
const SET_TYPE_VALUE_KEYWORD = "set_type";

/** Whether `raw` is a `/…/` regex literal rather than an ordinary value. */
function isRegexLiteral(raw: string): boolean {
	return raw.length >= 2 && raw.startsWith("/") && raw.endsWith("/");
}

/**
 * The `Unknown regular expression keyword` sentence, or null when the term is fine.
 *
 * Two shapes reach here and only one of them is Scryfall's business. A PLAIN-LITERAL pattern on a
 * TEXT column never runs as a regex at all: `lowerLiteralRegexes` turns `is:/promo/` into
 * `is:promo` before the engine sees it, and that answers 6,126 here. Dropping it would remove a
 * working answer to buy nothing, so this fires only when the pattern needs a real engine — or
 * when the column's value parser cannot take a regex TOKEN in the first place, which is every
 * class but TEXT (`date:/1993/` is a parse error here however plain the pattern is).
 *
 * WHAT IT REPLACES, all measured on production 2026-08-28 against api.scryfall.com's 563 for the
 * same query anchored with `t:goblin`:
 *
 *   kw:/^fly/ t:goblin      404 — the term became the keyword `fly` and matched nothing
 *   otag:/^remov/ t:goblin  404 — became the tag `remov`
 *   st:/^exp/ t:goblin      400 Failed to parse query
 *   date:/199/ t:goblin     400 Failed to parse query
 *
 * The first two are the dangerous class: a different query, answered without a word.
 */
function regexKeywordReason(keyword: string, rawValue: string): string | null {
	if (!isRegexLiteral(rawValue)) return null;
	if (REGEX_CAPABLE_KEYWORDS.has(keyword) || REGEX_VALUE_FIRST_KEYWORDS.has(keyword)) return null;
	const infos = ALIAS_TO_FIELD_INFOS.get(keyword) ?? [];
	const textOnly = infos.length > 0 && infos.every((fi) => fi.parserClass === ParserClass.TEXT);
	if (textOnly && !STRICT_REGEX_KEYWORDS.has(keyword) && regexPlainLiteral(rawValue.slice(1, -1)) !== null) {
		return null;
	}
	if (keyword === SET_TYPE_VALUE_KEYWORD) {
		return `Unknown set type \u201c${rawValue.toLowerCase()}\u201d`;
	}
	return `Unknown regular expression keyword \u201c${keyword}\u201d.`;
}

/**
 * The date shapes Scryfall's value parser takes before it falls back to the set-code table.
 *
 * ZERO-PADDING-STRICT, which is Scryfall's own rule and not this port's parser's: measured
 * 2026-09-03 against the anchor `e:khm` = 323, `date:2021-2` comes back
 * `Invalid date or unknown set code “2021-2”` while `date:2021-02` is honored. The three
 * accepted shapes are `YYYY`, `YYYY-MM` and `YYYY-MM-DD`; everything else is tried as a SET CODE.
 */
const DATE_SHAPE_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/**
 * `Invalid date or unknown set code “X”`, or null when the value is one Scryfall can read.
 *
 * ─── WHAT SCRYFALL DOES WITH A DATE VALUE ────────────────────────────────────────────────────
 *
 * It tries the three date shapes above, then the set-code table, then gives up and IGNORES the
 * term. Measured 2026-09-03, anchor `e:khm` = 323, one request per row:
 *
 *   date>=hob      honored, 2026-08-14   `hob` is The Hobbit; see parser.parseDateValue
 *   date>=HOB      honored               the table is case-insensitive
 *   date>="hob"    honored               quoted resolves too
 *   date>=zzzz     323 + `… unknown set code “zzzz”`
 *   -date>=zzzz    323 + the same, echoing `-date>=zzzz`
 *   date>=ZZZZ     323 + the sentence naming `zzzz` — lower-cased, like every other value sentence
 *   date:2021-2    323 + the sentence naming `2021-2`
 *   date:99        323, date:1 323, date:20210205 323, date:2021- 323
 *
 * ─── A DATE THAT IS SHAPED LIKE ONE AND IS NOT ONE ───────────────────────────────────────────
 *
 * `date:2021-13` is a THIRD answer — `Invalid date “2021-13”`, without the set-code half of the
 * sentence, because the shape parsed and only the month was out of range. Measured 2026-10-04,
 * anchor `e:khm t:god` = 12, each row the 12 carrying the sentence for its own value:
 *
 *   date:2021-13  date:2021-00  date:2021-99  date:"2021-13"      a month outside 01–12
 *   date:2021-13-01  date:2021-12-32  date:2021-02-00             or a day outside 01–31
 *   date>=2021-13   -date:2021-13 (echoing the minus)             every operator, either polarity
 *
 * and `date:2021-13` alone is the 400 `All of your terms were ignored.` carrying it. This port
 * answered `400 Failed to parse query` for each.
 *
 * A day the MONTH does not have is not that: `date:2021-02-30` and `date:2021-02-29` are 404,
 * honored and matching nothing — see `honoredDateTerm`, which also answers the years the parser
 * will not read.
 *
 * A regex literal is skipped so `date:/199/` keeps its own sentence — `Unknown regular expression
 * keyword “date”.` from `regexKeywordReason`, which runs later and would never be reached.
 */
const DATE_PARTS_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function dateValueReason(keyword: string, rawValue: string): string | null {
	if (!DATE_KEYWORDS.has(keyword) || isRegexLiteral(rawValue)) return null;
	const value = unquote(rawValue).toLowerCase();
	const parts = DATE_PARTS_RE.exec(value);
	if (parts !== null) {
		const month = parts[2] === undefined ? 1 : Number(parts[2]);
		const day = parts[3] === undefined ? 1 : Number(parts[3]);
		return month < 1 || month > 12 || day < 1 || day > 31 ? `Invalid date “${value}”` : null;
	}
	if (DATE_SHAPE_RE.test(value) || isKnownSetCode(value)) return null;
	return `Invalid date or unknown set code “${value}”`;
}

/**
 * The years this parser reads a date in (`parser.ts` MIN_MTG_YEAR / MAX_YEAR). No printing is
 * dated outside them, which is what makes the two substitutions below exact rather than close.
 */
const MIN_DATE_YEAR = 1992;
const MAX_DATE_YEAR = 2040;

/** What a comparison against a year no printing is dated in comes to, or null inside the range. */
function yearOutOfRangeTerm(op: string, year: number): string | null {
	if (year >= MIN_DATE_YEAR && year <= MAX_DATE_YEAR) return null;
	const everythingIsLater = year < MIN_DATE_YEAR;
	if (op === "!=") return ALWAYS_MATCHES;
	if (op === ">" || op === ">=") return everythingIsLater ? ALWAYS_MATCHES : NEVER_MATCHES;
	if (op === "<" || op === "<=") return everythingIsLater ? NEVER_MATCHES : ALWAYS_MATCHES;
	return NEVER_MATCHES;
}

/**
 * A DATE SCRYFALL HONORS AND THIS PARSER REFUSES, rewritten into the term it means — or null when
 * the parser reads the value itself.
 *
 * Two shapes, both `400 Failed to parse query` here. Measured 2026-10-04, anchor `e:khm t:god` =
 * 12 (Kaldheim is 2021-02-05), none carrying a warning:
 *
 *   A DAY THE MONTH DOES NOT HAVE compares as the calendar position it names, past the month's end:
 *     date:2021-02-30  date:2021-02-29     404        date!=2021-02-30    12
 *     date<=2021-02-30                     12         date>=2021-02-30  date>=2021-02-29    404
 *   so `=` matches nothing, `!=` everything, and `<`/`<=` and `>`/`>=` are `<=` and `>` of the
 *   month's real last day.
 *
 *   A YEAR NO PRINTING IS DATED IN compares as a number:
 *     date:1990  date<1990  date:2041  date>9999     404
 *     date>=0000  date<9999  date<=2041               12
 *
 * `year:` takes the second shape too (`year:0000` and `year:9999` are 404, `year>=0` is 12);
 * `classifyLeaf` calls `yearOutOfRangeTerm` for it directly.
 *
 * COST: a regex and a few integer compares on a `date:` term, at parse time.
 */
function honoredDateTerm(keyword: string, op: string, rawValue: string): string | null {
	if (isRegexLiteral(rawValue)) return null;
	const parts = DATE_PARTS_RE.exec(unquote(rawValue));
	if (parts === null) return null;
	const year = Number(parts[1]);
	const outOfRange = yearOutOfRangeTerm(op, year);
	if (outOfRange !== null) return outOfRange;
	if (parts[2] === undefined || parts[3] === undefined) return null;
	const month = Number(parts[2]);
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (Number(parts[3]) <= lastDay) return null;
	if (op === "!=") return ALWAYS_MATCHES;
	if (op === ":" || op === "=") return NEVER_MATCHES;
	const monthEnd = `${parts[1]}-${parts[2]}-${String(lastDay).padStart(2, "0")}`;
	return `${keyword}${op === "<" || op === "<=" ? "<=" : ">"}${monthEnd}`;
}

/** Keyword groups, by the alias spellings this parser and Scryfall share. */
const FORMAT_KEYWORDS: ReadonlySet<string> = new Set(["f", "format", "legal", "banned", "restricted"]);
const LANGUAGE_KEYWORDS: ReadonlySet<string> = new Set(["lang", "language"]);
const RARITY_KEYWORDS: ReadonlySet<string> = new Set(["r", "rarity"]);
/**
 * The keywords whose value is a UUID: the oracle card's, and — since 2026-10-03 — the PRINTING's
 * own id and its artwork's.
 *
 * `scryfallid:` and `illustrationid:` are Scryfall keywords this port called unknown (x66 R5,
 * reported from mtg-seeker). Measured on api.scryfall.com that day, anchor `e:khm t:god` = 12:
 *
 *   scryfallid:860aa0fe-0337-458c-b864-5ef5733fbae6        1 card (Reset, me3/48)
 *   scryfall_id:…  scryfallid=…  SCRYFALLID:860AA0FE-…  scryfallid:"860aa0fe-…"    the same 1
 *   illustrationid:9e42d409-161d-4e63-8982-71e313f27b2f    1 card; 2 under unique=prints
 *   illustration_id:…  illustrationid=…                    the same
 *   scryfallid:abc e:khm t:god                             12 + `You must provide a valid v4 UUID.`
 *   scryfallid:00000000-0000-0000-0000-000000000000        400, the same sentence (the nil UUID)
 *   scryfallid:860aa0fe0337458cb8645ef5733fbae6            400 (no hyphens)
 *   -scryfallid:abc e:khm t:god                            12, echoing “-scryfallid:abc”
 *   scryfallid:11111111-1111-4111-8111-111111111111        404 — well-formed, names nothing
 *   scryfallid!=<id> e:khm t:god   scryfallid><id> …       404 — the comparison rule above
 *
 * The same v4 check `oracleid:` has, with the same sentence, and the same per-SPELLING split on a
 * regex-shaped value: `scryfall_id:/860aa0fe/` and `illustration_id:/9e42/` answer the UUID
 * sentence while `scryfallid:/…/` and `illustrationid:/…/` answer `Unknown regular expression
 * keyword` — see REGEX_VALUE_FIRST_KEYWORDS and UNDERSCORE_FREE_ID_KEYWORDS.
 */
const UUID_KEYWORDS: ReadonlySet<string> = new Set([
	"oracleid",
	"oracle_id",
	"scryfallid",
	"scryfall_id",
	"illustrationid",
	"illustration_id",
]);
const GAME_KEYWORDS: ReadonlySet<string> = new Set(["game"]);

/**
 * `stamp:` and its vocabulary — Scryfall's six security stamps.
 *
 * Measured 2026-10-03: `stamp:oval` 9,760, `triangle` 2,412, `arena` 525, `acorn` 141, `circle` 36,
 * `heart` 8, and anything else ignored with its own sentence, in either polarity and with NO
 * closing period: `stamp:none e:khm` and `stamp:nonsense e:khm` are 305 carrying
 * `Unknown security stamp “nonsense”`, `-stamp:nonsense e:khm` the same echoing the minus.
 * `stamp:OVAL` and `stamp:"oval"` are `stamp:oval`; `stamp!=oval` and `stamp>oval` are 404 (the
 * comparison rule); `stamp:/oval/` is the regex-keyword sentence.
 */
const STAMP_KEYWORDS: ReadonlySet<string> = new Set(["stamp"]);
const SECURITY_STAMPS: ReadonlySet<string> = new Set(["oval", "triangle", "acorn", "circle", "arena", "heart"]);

/**
 * Scryfall's external-id keywords, by spelling, and whether the spelling CHECKS its value.
 *
 * A value is read as its leading decimal digits — `mtgoid:87321a`, `mtgoid:87321.0`,
 * `arenaid:75036a`, `tcgplayerid:230675a` and `multiverseid:503605a` each name the one printing,
 * quoted or not — and one with no leading digit names no card: `mtgoid:abc`, `mtgoid:-1`,
 * `arenaid:abc` and `multiverseid:abc` are 404 with no warning, while the negations are SQL's
 * (`-arenaid:abc e:khm` and `-multiverseid:abc e:khm` are all 305, `-mtgoid:abc e:usg` 332 of
 * 335). So the value is rewritten to the integer the engine compares, `0` when there is none:
 * no printing carries id 0, and the engine's three-valued compare then answers each negation.
 *
 * ONLY THE tcgplayer SPELLINGS VALIDATE, and the sentence is Scryfall's own, typos included:
 * `tcgplayerid:abc e:khm`, `-tcgplayerid:abc e:khm` and `tcgplayerid:-5 e:khm` are 305 carrying
 * `You must provide a vaid interger`. `tcgplayerid:1.5` is honored (404 in Kaldheim).
 *
 * A regex-shaped value is the regex-keyword sentence on every one of them, however plain the
 * pattern (`mtgoid:/87321/ e:khm` is 305 carrying it), so these are in STRICT_REGEX_KEYWORDS.
 * Measured 2026-10-03.
 */
const EXTERNAL_ID_KEYWORDS: ReadonlyMap<string, { validates: boolean }> = new Map(
	[
		["mtgoid", "mtgo_id", "mtgo"],
		["arenaid", "arena_id", "arena"],
		["multiverseid", "multiverse_id", "multiverse"],
	]
		.flat()
		.map((alias): [string, { validates: boolean }] => [alias, { validates: false }])
		.concat(
			["tcgplayerid", "tcgplayer_id", "tcgplayer"].map((alias): [string, { validates: boolean }] => [
				alias,
				{ validates: true },
			]),
		),
);
const TCGPLAYER_ID_REASON = "You must provide a vaid interger";
const LEADING_DIGITS_RE = /^\d+/;

/**
 * TEXT-class keywords whose regex-shaped value is ALWAYS Scryfall's regex-keyword sentence — even
 * a plain-literal pattern, which `regexKeywordReason` otherwise lets through because the parser
 * lowers it. The exemption exists to keep answers this port already gave (`is:/promo/`); a keyword
 * that is new here has none to keep, and starts at Scryfall's answer.
 */
/**
 * `lore:` — a literal substring of the printing's name, flavor name, flavor text, oracle text or
 * type line. The engine answers it (card_engine `build_binary`, which carries the field-by-field
 * measurements); what is decided here is what Scryfall says about the term before any card is read.
 *
 * Measured on api.scryfall.com 2026-10-04:
 *
 *   lore:jace = lore=jace = lore:JACE            171
 *   lore!=jace, lore>jace                        404 (the comparison rule)
 *   -lore:zzzzqq e:khm                           305 — the complement, no third value
 *   lore:/jace/ e:khm                            305 + Unknown regular expression keyword “lore”.
 *   lore:"" e:khm, lore:'' e:khm                 305 + Unknown keyword “lore”.
 *   -lore:"" cmc=3                               Unknown keyword “-lore”.
 *   lore:" " e:khm                               305, no warning — a space is a value
 *   lore: e:khm                                  1 — the dangling-operator rule, a card named lore
 *
 * It forces `include_extras` under `:`/`=` in either polarity (extras-gate.ts), and nothing else.
 */
const LORE_KEYWORDS: ReadonlySet<string> = new Set(["lore"]);

/**
 * `cheapest:` — the printings carrying their card's cheapest price in a currency — and the words
 * Scryfall takes for one. The engine answers it from codes the store's build computes
 * (card_engine `assign_cheapest_codes`, which carries the rule and its measurements).
 *
 * Measured on api.scryfall.com 2026-10-04, each `cheapest:<word> e:khm` against the plain word the
 * same day:
 *
 *   usd  $  dollar      222        eur  euro  €      238        tix  mtgo      290
 *   USD, DOLLAR, "usd", cheapest=usd                            the same
 *   dollars euros ticket tickets usdfoil eurfoil usd_foil usdetched tcg tcgplayer cardmarket
 *   mkm cardhoarder paper price any us eu us$ 1
 *                       305 + Unknown currency “<word>”    (no closing period; the minus echoed
 *                                                           when the term is negated)
 *   cheapest:""         305 + Unknown keyword “cheapest”.
 *   cheapest:/usd/      305 + Unknown regular expression keyword “cheapest”.
 *   cheapest>usd, cheapest!=usd      404 (the comparison rule)
 *
 * THE NEGATED TERM IS NOT THE COMPLEMENT. `-cheapest:usd e:khm` is 5 printings where the positive
 * is 222 of 407, and one printing is in both; `-(cheapest:usd) e:khm` — the negated GROUP — is the
 * complement, 185, and `-(-cheapest:usd) e:khm` 402. So the negated term is rewritten into a
 * positive term of its own, `cheapest:not_<currency>`, which the engine answers with Scryfall's
 * expression for it, and a negated group stays a plain `Not` over whichever it holds. The value is
 * written as the plain word either way, so the parser never sees `$` or `€`.
 *
 * It forces no extras (`cheapest:usd cmc=3` echoes include_extras=false).
 */
const CHEAPEST_KEYWORDS: ReadonlySet<string> = new Set(["cheapest"]);
const CHEAPEST_CURRENCIES: ReadonlyMap<string, string> = new Map([
	["usd", "usd"],
	["$", "usd"],
	["dollar", "usd"],
	["eur", "eur"],
	["euro", "eur"],
	["\u20ac", "eur"],
	["tix", "tix"],
	["mtgo", "tix"],
]);

const STRICT_REGEX_KEYWORDS: ReadonlySet<string> = new Set([
	...STAMP_KEYWORDS,
	...EXTERNAL_ID_KEYWORDS.keys(),
	...LORE_KEYWORDS,
	...CHEAPEST_KEYWORDS,
]);

/**
 * `st:` / `set_type:` / `settype:` — Scryfall's 24 set types, and its sentence for anything else.
 *
 * Measured 2026-10-04, anchor `e:khm t:god` = 12. A value outside the vocabulary is ignored, in
 * either polarity, under `:` and `=`, quoted or not, and the sentence names the WHOLE value,
 * lower-cased (the echoed expression is cut at 20 as always; the value is not):
 *
 *   st:nonsense  set_type:nonsense  settype:nonsense  st=nonsense  st:"nonsense"  st:NONSENSE
 *       12 + `Unknown set type “nonsense”`             -st:nonsense echoes the minus
 *   st:nonsense alone        400 `All of your terms were ignored.` carrying it
 *   st:exp  st:duel  st:ftv  st:tokens  st:promos  st:supplemental  st:un     the same sentence:
 *       no prefix, no nickname and no plural is a set type
 *   st>nonsense              404, no warning (the comparison rule)
 *
 * This port kept the term and answered a 404 for each — narrower than Scryfall where a query
 * validated here is shipped there, and the negated form answered the anchor with no warning.
 *
 * All 24 types are honored (`st:core` … `st:minigame`, one request each beside `t:god`), and the
 * value is read with its spaces, `_` and `-` removed: `st:draftinnovation`,
 * `st:draft-innovation` and `st:"draft innovation"` are `st:draft_innovation`'s 11, where this
 * port matched the stored spelling only and answered nothing. So a known value is respelled to
 * the one the store holds.
 *
 * A CLOSED LIST, like `SCRYFALL_FORMATS`: a set type Scryfall adds is "unknown" here until it is
 * added — and the term is then dropped where Scryfall honors it. The 24 have not changed since
 * `minigame` in 2021.
 */
const SET_TYPE_KEYWORDS: ReadonlySet<string> = new Set(["st", "set_type", "settype"]);
const SCRYFALL_SET_TYPES: ReadonlyMap<string, string> = new Map(
	[
		"alchemy",
		"archenemy",
		"arsenal",
		"box",
		"commander",
		"core",
		"draft_innovation",
		"duel_deck",
		"eternal",
		"expansion",
		"from_the_vault",
		"funny",
		"masterpiece",
		"masters",
		"memorabilia",
		"minigame",
		"planechase",
		"premium_deck",
		"promo",
		"spellbook",
		"starter",
		"token",
		"treasure_chest",
		"vanguard",
	].map((setType) => [setType.replaceAll("_", ""), setType]),
);
const SET_TYPE_SEPARATORS_RE = /[\s_-]/g;

/**
 * `frame:` — Scryfall's frame editions, frame effects and their nicknames, and its sentence for
 * anything else.
 *
 * Measured 2026-10-04, anchor `e:khm t:god` = 12: `frame:nonsense`, `frame=nonsense`,
 * `frame:"nonsense"`, `frame:NONSENSE` and `frame:1` are each the 12 carrying
 * `Unknown frame “nonsense”` (the whole value, lower-cased), `-frame:nonsense` echoes the minus,
 * `frame:nonsense` alone is the 400, and `frame>nonsense` is the comparison rule's 404. So are
 * `frame:fullart`, `textless`, `borderless`, `booster`, `timeshifted`, `textured`, `dfc`,
 * `wanted`, `vehicle`, `borderlessalt` and `placeholderimage`: none is a frame. This port kept
 * each term and answered a 404.
 *
 * THE VOCABULARY, each value honored there (one request each beside `t:god`, no warning):
 *
 *   editions   1993 1997 2003 2015 future, and `old` `new` `modern`
 *   effects    Scryfall's `frame_effects` enum, all 24 — legendary miracle enchantment draft devoid
 *              tombstone colorshifted inverted sunmoondfc compasslanddfc originpwdfc mooneldrazidfc
 *              waxingandwaningmoondfc showcase extendedart companion etched snow lesson
 *              shatteredglass convertdfc fandfc upsidedowndfc spree
 *   nicknames  each the same count as the value it names, over the whole corpus:
 *              93 = 1993 (1,589)     97 = classic = 1997 (6,748)     03 = 8ed = 2003 (9,070)
 *              15 = m15 = 2015 (24,819)     retro = old (7,285, both differences empty)
 *              nyx = nyxtouched = enchantment (831, both differences empty)
 *
 * The ten nicknames answered nothing here (`frame:nyxtouched t:god` 0 against 24 — the bulk data
 * spells that effect `enchantment` now); each is respelled to the value it names. The value maps
 * to itself where the parser already reads it.
 *
 * A CLOSED LIST, with the cost that has: a frame effect Scryfall adds is "unknown" here until it
 * is added to this table, where before this the term reached the store and answered.
 */
const FRAME_KEYWORDS: ReadonlySet<string> = new Set(["frame"]);
const SCRYFALL_FRAMES: ReadonlyMap<string, string> = new Map([
	...[
		"1993",
		"1997",
		"2003",
		"2015",
		"future",
		"old",
		"new",
		"modern",
		"legendary",
		"miracle",
		"enchantment",
		"draft",
		"devoid",
		"tombstone",
		"colorshifted",
		"inverted",
		"sunmoondfc",
		"compasslanddfc",
		"originpwdfc",
		"mooneldrazidfc",
		"waxingandwaningmoondfc",
		"showcase",
		"extendedart",
		"companion",
		"etched",
		"snow",
		"lesson",
		"shatteredglass",
		"convertdfc",
		"fandfc",
		"upsidedowndfc",
		"spree",
	].map((frame): [string, string] => [frame, frame]),
	["93", "1993"],
	["97", "1997"],
	["classic", "1997"],
	["03", "2003"],
	["8ed", "2003"],
	["15", "2015"],
	["m15", "2015"],
	["retro", "old"],
	["nyx", "enchantment"],
	["nyxtouched", "enchantment"],
]);

/** The three spellings that read the `card_is_tags` vocabulary. `not:` is `-is:`. */
const IS_KEYWORDS: ReadonlySet<string> = new Set(["is", "has", "not"]);

/**
 * `is:` VALUES this port answers and Scryfall does not know — the value-level twin of
 * NOT_SCRYFALL_KEYWORDS, and today exactly the `game_*` tags the importer stores for `game:`.
 *
 * `game:paper` is Scryfall's spelling and is honored on both sides; `is:game_paper` is the tag
 * underneath it, which is this port's own and reaches the same rows. Left alone it would answer
 * where api.scryfall.com ignores the term, so it is dropped here exactly as `subtype:` is — and
 * `game:paper` is untouched, because this scan runs on the RAW query text and the rewrite that
 * turns one into the other happens later, inside the parser.
 *
 * All three spellings take the same sentence, measured 2026-09-03: `is:nonsense`, `has:nonsense`
 * and `not:nonsense` each come back `Checking if cards are “nonsense” is not supported`.
 */
const NOT_SCRYFALL_IS_VALUES: ReadonlySet<string> = new Set(GAME_IS_TAGS.values());

/**
 * AN `is:` VALUE IS READ WITH ITS `-` AND `_` REMOVED, and Scryfall answers many values this port
 * knew under another word or another keyword.
 *
 * Found by sweeping 619 candidate values — every `is:`/`has:`/`not:` value on Scryfall's syntax
 * page, every value this parser supports, every `promo_types` member, layout, set type, frame and
 * card-object field name, and the land-cycle and treatment nicknames — one `is:<value>` request
 * each against api.scryfall.com and against production, 2026-10-04. Scryfall answered 327 of
 * them; 135 answered a different count here, and 107 of those were a warned no-match.
 *
 * SCRYFALL'S VOCABULARY IS HAND-KEPT AND NOT PUBLISHED, and no rule generates it: `is:confetti`,
 * `is:halo`, `is:ripple` and `is:emboss` answer for `confettifoil`, `halofoil`, `ripplefoil` and
 * `embossed`, while `is:galaxy`, `is:cosmic`, `is:texture` and `is:gild` are unknown. So two more
 * sweeps asked 328 short forms of the values already known — each promo type cut at its natural
 * joints, the acronyms, more land names — and found 33 more that answer. 947 candidates in all,
 * 360 answered. A fourth sweep would find a few more.
 *
 * ─── THE SEPARATORS ──────────────────────────────────────────────────────────────────────────
 *
 * `is:fo-il` and `is:f_o-il` are `is:foil` (12 of Kaldheim's 12 gods, no warning), `is:full_art`
 * is `is:fullart`'s 825 and `is:judge-gift` is `is:judge_gift`'s 164: both characters are dropped
 * before the value is looked up. 24 of the 107 were spelled with one — `is:art_series`,
 * `is:buy_a_box`, `is:french_vanilla`, `is:modal_dfc`, `is:universes_beyond` … — and this parser
 * keys its tags by exact spelling, so the value is respelled here to the one it stores.
 *
 * ─── THE SYNONYMS ────────────────────────────────────────────────────────────────────────────
 *
 * Each row of SCRYFALL_IS_SYNONYMS is a value Scryfall answers and the term this port already
 * answers the same printings with. Every one was measured as a symmetric difference on
 * api.scryfall.com over printings with extras in — `(is:A -B) or (B -is:A)` with
 * `unique=prints&include_extras=true` — and all are 404, the empty set:
 *
 *   another word for a value answered here    artcard bab confetti doublesided etchedfoil extras
 *                                             halo highres horizonland pwdeck story ub …
 *   a set type                                `is:core` is `st:core`, and eleven more. NOT
 *                                             `is:spellbook` (99 printings apart from
 *                                             `st:spellbook`), and `is:commander`, `is:funny`,
 *                                             `is:promo` and `is:token` are their own classes.
 *   a frame                                   `is:future` is `frame:future`, `is:modern` `frame:2003`
 *   a field that is present                   `is:artist`, `is:flavor`, `is:stamp`: at the printing
 *                                             grain 117,609 / 56,525 / 42,825 on both sides
 *
 * REWRITTEN ON THE QUERY TEXT, before the parser, so the term that reaches the extras gate is the
 * spelling its measured tables already hold: `is:artcard` opens extras because `is:artseries`
 * does (both 2,243 by default on Scryfall), and `is:extras` because `is:extra` does.
 *
 * WHAT IS STILL UNANSWERED is SCRYFALL_UNANSWERED_IS_VALUES below, with the reason for each.
 *
 * COST: one or two map lookups per `is:` term, at parse time; nothing at query time, and a query
 * with no `is:` term never reaches it.
 */
const IS_VALUE_WORD_RE = /^[A-Za-z0-9_-]+$/;
const IS_VALUE_SEPARATORS_RE = /[-_]/g;

const SECURITY_STAMP_PRESENT = `(${[...SECURITY_STAMPS].map((stamp) => `stamp:${stamp}`).join(" or ")})`;

const FINAL_FANTASY_GAMES = `(${"i ii iii iv v vi vii viii ix x xi xii xiii xiv xv xvi"
	.split(" ")
	.map((game) => `is:ff${game}`)
	.join(" or ")})`;

const SCRYFALL_IS_SYNONYMS: ReadonlyMap<string, string> = new Map([
	// Another word for a value this port stores, derives or computes.
	["artcard", "is:artseries"],
	["augment", "is:augmentation"],
	["bab", "is:buyabox"],
	["battlebondland", "is:bondland"],
	["canopy", "is:canopyland"],
	["chocobotrack", "is:chocobotrackfoil"],
	["compleat", "is:stepandcompleat"],
	["confetti", "is:confettifoil"],
	["crowdland", "is:bondland"],
	["doublefaced", "is:dfc"],
	["doublesided", "is:dfc"],
	["dracula", "is:draculaseries"],
	["dragonscale", "is:dragonscalefoil"],
	["emboss", "is:embossed"],
	["etch", "is:etched"],
	["etchedfoil", "is:etched"],
	["extended", "is:extendedart"],
	["extension", "is:setextension"],
	["extras", "is:extra"],
	// The sixteen Final Fantasy games' tags together: 741 cards.
	["ff", FINAL_FANTASY_GAMES],
	["finalfantasy", FINAL_FANTASY_GAMES],
	["firstplace", "is:firstplacefoil"],
	["fracture", "is:fracturefoil"],
	["gc", "is:gamechanger"],
	["gleaming", "is:gleaminggold"],
	["gloss", "is:glossy"],
	["godzilla", "is:godzillaseries"],
	["halo", "is:halofoil"],
	["highres", "is:hires"],
	["horizon", "is:canopyland"],
	["horizonland", "is:canopyland"],
	["insert", "is:media_insert"],
	["modaldfc", "is:mdfc"],
	["normal", "is:default"],
	["onlyprint", "is:unique"],
	["pack", "is:booster"],
	["planeswalkerstamp", "is:stamped"],
	["planeswalkerstamped", "is:stamped"],
	["premium", "is:foil"],
	["printedname", "is:localizedname"],
	["pwdeck", "is:planeswalker_deck"],
	["pwstamped", "is:stamped"],
	["raised", "is:raisedfoil"],
	["reservedlist", "is:reserved"],
	["ripple", "is:ripplefoil"],
	["splitmana", "is:hybrid"],
	["story", "is:spotlight"],
	["storyspotlight", "is:spotlight"],
	["surge", "is:surgefoil"],
	["tournament", "is:tourney"],
	["trikeland", "is:tricycleland"],
	["ub", "is:universesbeyond"],
	["wpn", "is:wizardsplaynetwork"],
	// A set type.
	["archenemy", "st:archenemy"],
	["arsenal", "st:arsenal"],
	["box", "st:box"],
	["core", "st:core"],
	["eternal", "st:eternal"],
	["expansion", "st:expansion"],
	["masters", "st:masters"],
	["memorabilia", "st:memorabilia"],
	["planechase", "st:planechase"],
	["premiumdeck", "st:premium_deck"],
	["starter", "st:starter"],
	// A frame.
	["future", "frame:future"],
	["futureshifted", "frame:future"],
	["modern", "frame:2003"],
	// A field that is present. `has:` and not the regex it lowers to: `a:` opens extras and
	// `has:artist` does not.
	["artist", "has:artist"],
	["flavor", "has:flavor"],
	["flavortext", "has:flavor"],
	["securitystamp", SECURITY_STAMP_PRESENT],
	["stamp", SECURITY_STAMP_PRESENT],
]);

/**
 * THE `is:` VALUES SCRYFALL ANSWERS AND THIS PORT CANNOT — the rest of the 2026-10-04 sweep, keyed
 * with the separators removed. Each is kept in the query and matches nothing, under the parser's
 * own "no data for that predicate" warning: narrower than Scryfall, never wider.
 *
 *   an id or a field that is present, with no presence test in the engine
 *       arenaid mtgoid multiverse multiverseid tcgplayer tcgplayerid cardmarket cardmarketid
 *       illustration illustrationid image back printedtext related placeholderimage
 *       indicator ci colorindicator attractionlights lights
 *     `-mtgoid:0` is not `is:mtgoid` (15,872 on production against Scryfall's 30,744): the
 *     engine's id match is a comparison, and its negation is not "has one".
 *   a class of Scryfall's own, with no rule found
 *       beginner covered cube displaycommander englishart paperart fbb fwb intro invitational
 *       jumpstart misprint moonlitland vergeland spellbook spikey timeshifted tron unset
 *     Five guesses were measured as symmetric differences over printings and refuted:
 *     `is:unset` against `st:funny` (922 apart), `is:jumpstart` against its three sets (1,322),
 *     `is:fbb` against `e:fbb or e:4bb` (316), `is:spellbook` against `st:spellbook` (99),
 *     `is:intro` (= `is:beginner`, 191) against the intro-pack, beginner-box and starter-deck
 *     tags together (564).
 *   accepted by Scryfall and answering nothing by default there either
 *       dueldeck fromthevault gateway lair minigame treasurechest vanguard
 */
export const SCRYFALL_UNANSWERED_IS_VALUES: ReadonlySet<string> = new Set([
	"arenaid",
	"attractionlights",
	"back",
	"beginner",
	"cardmarket",
	"cardmarketid",
	"ci",
	"colorindicator",
	"covered",
	"cube",
	"displaycommander",
	"dueldeck",
	"englishart",
	"fbb",
	"fromthevault",
	"fwb",
	"gateway",
	"illustration",
	"illustrationid",
	"image",
	"indicator",
	"intro",
	"invitational",
	"jumpstart",
	"lair",
	"lights",
	"minigame",
	"misprint",
	"moonlitland",
	"mtgoid",
	"multiverse",
	"multiverseid",
	"paperart",
	"placeholderimage",
	"printedtext",
	"related",
	"spellbook",
	"spikey",
	"tcgplayer",
	"tcgplayerid",
	"timeshifted",
	"treasurechest",
	"tron",
	"unset",
	"vanguard",
	"vergeland",
]);

/**
 * SCRYFALL'S TWO SENTENCES FOR AN `is:` / `has:` / `not:` VALUE IT DOES NOT ANSWER, or null when
 * the value is one this port keeps.
 *
 * This port kept every such term and answered a no-match (a 404 for `is:nonsense e:khm`, where
 * api.scryfall.com answers the set). Measured 2026-10-04, anchor `e:khm t:god` = 12, each row the
 * 12 carrying the sentence:
 *
 *   `Checking if cards are “nonsense” is not supported`      (no closing period)
 *     is:nonsense  has:nonsense  not:nonsense  is=nonsense  -is:nonsense (echoing the minus)
 *     is:NONSENSE names “nonsense”; is:non-sense names “non-sense”, the value as typed; is:1 names “1”
 *     THE VALUE IS CUT AT 20 like the expression: `is:abcdefghijklmnopqrst` (20) is named whole and
 *     `is:abcdefghijklmnopqrstu` (21) as “abcdefghijklmnopqrs…”.
 *
 *   `Unknown keyword “is”.` — the keyword as written, minus included
 *     is:"foil"  is:'foil'  is:"nonsense"  is:"two words"  has:"watermark"  not:"foil" (“not”)
 *     -is:"foil" (“-is”)  is:Éowyn
 *     A QUOTED VALUE IS NOT AN `is:` VALUE AT ALL, known or not: `is:"foil" e:khm` is all of
 *     Kaldheim, where this port answered its foils.
 *
 *   `Unknown regular expression keyword “is”.`
 *     is:/nonsense/ — and `is:/promo/` too, which this port deliberately keeps answering (see
 *     `regexKeywordReason`); only a pattern spelling no value it knows takes the sentence here.
 *
 * `is:nonsense` alone is the 400 `All of your terms were ignored.` carrying its warning, and
 * `is>nonsense` is the comparison rule's 404. A value carrying other ASCII punctuation is not
 * read as an `is:` term there at all (`is:foo.bar`, `is:foo,bar` and `is:foo'bar` are plain 404s
 * with no warning) and is left to the parser, as before.
 *
 * WHICH VALUES ARE KNOWN is three tables: what the parser supports, what `scryfallIsTerm`
 * respells, and SCRYFALL_UNANSWERED_IS_VALUES. All 220 values the parser supports were in the
 * sweep and Scryfall answered every one, so nothing this port answers is dropped.
 *
 * THE COST OF A CLOSED LIST OVER AN OPEN VOCABULARY. Scryfall's is hand-kept and unpublished, and
 * each of the three sweeps (947 candidates) found values the one before had not: a value it
 * answers that no sweep asked is dropped here with this sentence — a WIDER answer than
 * Scryfall's, where before this it was a no-match. When one is found, it joins
 * SCRYFALL_IS_SYNONYMS (with its difference probe) or SCRYFALL_UNANSWERED_IS_VALUES.
 */
const IS_VALUE_ECHO_LIMIT = 20;

function unknownIsValueReason(
	keyword: string,
	negated: boolean,
	rawValue: string,
	value: string,
	loweredValue: string,
): string | null {
	const supported = keyword === "has" ? SUPPORTED_HAS_VALUES : SUPPORTED_IS_VALUES;
	if (isRegexLiteral(rawValue)) {
		const word = regexPlainLiteral(rawValue.slice(1, -1));
		return word !== null && supported.has(word.toLowerCase())
			? null
			: `Unknown regular expression keyword “${keyword}”.`;
	}
	if (rawValue !== value || [...value].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)) {
		return `Unknown keyword “${negated ? "-" : ""}${keyword}”.`;
	}
	if (!IS_VALUE_WORD_RE.test(value) || supported.has(loweredValue)) return null;
	if (SCRYFALL_UNANSWERED_IS_VALUES.has(loweredValue.replace(IS_VALUE_SEPARATORS_RE, ""))) return null;
	const chars = [...loweredValue];
	const named =
		chars.length > IS_VALUE_ECHO_LIMIT ? `${chars.slice(0, IS_VALUE_ECHO_LIMIT - 1).join("")}…` : loweredValue;
	return `Checking if cards are “${named}” is not supported`;
}

/** The spelling this parser stores a value under, by the value with its separators removed. */
const IS_VALUE_SPELLINGS: ReadonlyMap<string, string> = (() => {
	const spellings = new Map<string, string>();
	for (const value of SUPPORTED_IS_VALUES) {
		const key = value.replace(IS_VALUE_SEPARATORS_RE, "");
		// The separator-free spelling wins where both exist (`arenaleague` beside `arena_league`):
		// it is the one the key itself spells.
		if (!spellings.has(key) || value === key) spellings.set(key, value);
	}
	return spellings;
})();

/**
 * The term an `is:` / `has:` / `not:` value Scryfall spells differently is answered with here, or
 * null when the value needs no respelling (or has no answer at all). `polarity` is the `-` the
 * rewritten term carries: the one written, flipped once for `not:`.
 */
function scryfallIsTerm(keyword: string, negated: boolean, loweredValue: string): string | null {
	const supported = keyword === "has" ? SUPPORTED_HAS_VALUES : SUPPORTED_IS_VALUES;
	if (supported.has(loweredValue)) return null;
	const key = loweredValue.replace(IS_VALUE_SEPARATORS_RE, "");
	const polarity = negated !== (keyword === "not") ? "-" : "";
	const spelling = supported.has(key) ? key : IS_VALUE_SPELLINGS.get(key);
	if (spelling !== undefined) return `${polarity}${keyword === "has" ? "has" : "is"}:${spelling}`;
	const synonym = SCRYFALL_IS_SYNONYMS.get(key);
	return synonym === undefined ? null : `${polarity}${synonym}`;
}

/**
 * Every keyword this file may NOT call unknown: the parser's own aliases, the in-query directives,
 * and the ones the validators below have rules for.
 *
 * The last group is load-bearing rather than belt-and-braces. It keeps this table honest against a
 * parser whose vocabulary is narrower than the validators' — the twin of this file upstream sits on
 * a branch without `lang:` or `oracleid:`, and without this a `lang:zz` there would be reported as
 * an unknown KEYWORD rather than an unknown LANGUAGE, changing sentence when an unrelated PR merged.
 */
const KNOWN_KEYWORDS: ReadonlySet<string> = new Set([
	...ALIAS_TO_FIELD_INFOS.keys(),
	...DIRECTIVE_TABLES.keys(),
	...MANA_VALUE_KEYWORDS,
	...NEGATED_EQUALITY_UNKNOWN_KEYWORD,
	...NEGATION_HONORING_COMPARISONS,
	...COMPARABLE_KEYWORDS,
	...DATE_KEYWORDS,
	...FORMAT_KEYWORDS,
	...LANGUAGE_KEYWORDS,
	...RARITY_KEYWORDS,
	...UUID_KEYWORDS,
	...COLOR_KEYWORDS,
	...GAME_KEYWORDS,
	...BLOCK_KEYWORDS,
]);

/**
 * How much of a rejected expression Scryfall echoes: 20 characters INCLUDING the ellipsis.
 *
 * Measured by lengthening one term a character at a time — `f:abcdefghijklmnopqr` (20 characters)
 * comes back whole and `f:abcdefghijklmnopqrs` (21) comes back as `f:abcdefghijklmnopq…`, which is
 * 19 characters and a U+2026. That is Rails' `String#truncate(20)`, whose omission counts against
 * the budget rather than being added to it, and it also fits the other truncation seen live
 * (`id:00000000-0000-00…` for a nil UUID). Only the EXPRESSION is cut; the reason sentence still
 * names the full value.
 */
const EXPRESSION_ECHO_LIMIT = 20;

/**
 * A term that can never match, substituted for a numeric comparison whose value is not a number.
 *
 * Scryfall answers `q=cmc>=notanumber` with its ordinary 404 — the term is HONORED and matches
 * nothing, unlike the ignored terms above, which is why it cannot be dropped: dropping it would
 * turn `cmc>=notanumber e:khm` into all of Kaldheim where Scryfall answers "no cards". Mana value
 * is never negative, so this leaf is empty by arithmetic rather than by a special node type, and
 * it composes correctly under `-` and `or` the way a dropped term would not.
 */
const NEVER_MATCHES = "cmc<0";

/**
 * A term that always matches, substituted for a negated comparison Scryfall does not apply.
 *
 * The negation of `NEVER_MATCHES` rather than a positive tautology such as `cmc>=0`, because the
 * two are not the same term over a column that can be absent: `cmc>=0` asks the index for rows
 * whose mana value compares, and the complement of the empty set is every row including those. It
 * is also the cheaper of the two — the engine builds the empty leaf and complements it, where
 * `cmc>=0` is a full range scan.
 *
 * `classifyLeaf`'s output is spliced into the rebuilt query and never re-classified, so this
 * spelling being itself a negated comparison costs nothing; it is idempotent regardless.
 */
const ALWAYS_MATCHES = `-${NEVER_MATCHES}`;

/**
 * A DANGLING OPERATOR IS NOT A TERM AT ALL: `t:` is the bare word `t`, and a bare word is a NAME
 * search.
 *
 * This port used to answer `q=t:` with every card, on the theory that an operator with no value
 * constrains nothing. Measured (api.scryfall.com, 2026-08-16), the theory is wrong twice over —
 * and so is the "this column is not null" reading it was replaced by, which fits `t:` = 22,261 and
 * `o:` = 22,111 and then dies on `ft:` = 1,628 where "has flavor text" is 20,877. What Scryfall
 * does is simpler: the term fails to lex as a keyword expression, so the token falls through to
 * an ordinary bare word — and `t` names cards whose NAME contains "t".
 *
 * Sixteen pairs, one request each, and every one of them equal:
 *
 *   t:      = t      = name:t   22,261      cmc:  = cmc         404 (no card is named "cmc")
 *   o:      = o                 22,111      layout: = layout    404
 *   name:   = name                  33      nonsense: = nonsense 404
 *   ft:     = ft     = name:ft   1,628      wm:   = wm           33
 *   in:     = in                 7,878      st:   = st        5,556
 *   t: e:khm  = t e:khm            215      -t: e:khm = -t e:khm  108
 *   t: or e:khm                 22,369      t: o: = t o      15,057
 *
 * `t: or e:khm` is the row that proves it composes as an ordinary leaf rather than as a
 * special-cased whole-query fallback: 22,261 + (323 - 215) = 22,369 exactly.
 *
 * The OPERATOR decides how much of the token becomes the word. With `:`, `>` or `<` the bare word
 * is the keyword alone (`t>` = `t<` = `t:` = 215 in Kaldheim); with `=`, `>=`, `<=` or `!=` the
 * operator characters stay ON the word, which is why `t=` and `t>=` are 404 where `t:` is 22,261,
 * and `name:"t="` is 404 to match. Both branches were checked against their `name:` twin.
 *
 * Rewriting to `name:…` rather than to a bare word keeps the substitution safe in every position:
 * a keyword is `[A-Za-z_][A-Za-z0-9_]*`, so `or:` would otherwise become the connector `or`.
 * Negation, grouping and `or` then compose for free, because the result is just a term.
 *
 * UNQUOTED for the bare-word branch, and quoted only for the `=`-family, because Scryfall does not
 * read the two spellings alike: `name:ft` is 1,628 and `name:"ft"` is 362, and the measured
 * equality is with the UNQUOTED form (`ft:` = `ft` = `name:ft` = 1,628). The `=`-family has to be
 * quoted regardless — its word carries the operator characters, and `name:"t="` is the 404 that
 * matched `t=`.
 */
function danglingOperatorTerm(negated: boolean, keyword: string, op: string): string {
	const bareWord = op === ":" || op === ">" || op === "<";
	const value = bareWord ? keyword : `"${keyword}${op}"`;
	return `${negated ? "-" : ""}name:${value}`;
}

export interface TermPolicyResult {
	/** The query to hand the parser: the input, minus the terms Scryfall would ignore. */
	query: string;
	/**
	 * The query's parentheses do not balance — Scryfall's own 400, with its own sentence.
	 *
	 * Measured 2026-08-16: `e:khm (t:god`, `e:khm t:god)` and a lone `(` all answer
	 * `400 bad_request` / `"Your search contains unclosed parentheses."`, in both directions and
	 * for a stray closer as well as a stray opener. This port answered its own
	 * `Failed to parse query: "…"` — the right status with the wrong sentence, on the single most
	 * common typo a search box produces.
	 */
	unclosedParens: boolean;
	/** Scryfall's warnings, in source order, already worded as Scryfall words them. */
	warnings: string[];
	/** Every term was ignored — the caller answers 400 "All of your terms were ignored." */
	allIgnored: boolean;
	/** What the query's `include:` options switch on — OR'd with the `include_*` parameters. */
	include: IncludeOptions;
	/**
	 * The display options the query carried with a value this port can apply, in source order —
	 * already REMOVED from `query`, for the caller to fold with `applyDirectives`.
	 */
	directives: DirectiveFound[];
}

/**
 * `Invalid expression “<term>” was ignored. <reason>`, with Scryfall's truncation and its DOWNCASE.
 *
 * THE ECHOED EXPRESSION IS LOWER-CASED IN FULL — keyword AND value — not echoed as typed. This
 * port echoed the term verbatim, so every warning about a term carrying a capital letter carried
 * the wrong text. Measured 2026-08-28, one request each, anchor `e:khm` = 323 unless noted:
 *
 *   C:mw              → “c:mw”              keyword upper, value lower
 *   c:MW              → “c:mw”              keyword lower, value upper
 *   C:MW              → “c:mw”              both upper — the three rows together SEPARATE the two
 *                                           halves, and neither half survives. One probe on
 *                                           `C:MW` alone could not have told them apart.
 *   c:MonoColor       → “c:monocolor”       (hint "Use c>clnor", already lower)
 *   Id:NePhIlIm       → “id:nephilim”       alternating case, non-`c` colour spelling
 *   F:NOTAFORMAT      → “f:notaformat”
 *   R:NotARare        → “r:notarare”
 *   R>NotARare        → “r>notarare”        a comparison operator echoes the same way
 *   Lang:ZZ           → “lang:zz”
 *   SubType:Eldrazi   → “subtype:eldrazi”   an UNKNOWN keyword is downcased the same way
 *   NotAKeyword:MiXeD → “notakeyword:mixed”
 *   Oracleid:NotAUuid → “oracleid:notauuid”
 *   Devotion:XyZ      → “devotion:xyz”
 *   Cmc:NotANumber    → “cmc:notanumber”
 *   -SubType:Human    → “-subtype:human”    the negation prefix is kept, the rest downcased
 *
 * The value is downcased even where its case is unambiguously load-bearing to the thing it spells,
 * which is what makes this a downcase of the TEXT and not a normalization of a case-insensitive
 * vocabulary: `O:/[Unclosed/` comes back “o:/[unclosed/” — the contents of a regex literal — and
 * `SubType:"Big Elf"` comes back “subtype:"big elf"”, quotes preserved and the quoted words
 * downcased. Nothing is corrupted by echoing it that way, because the term is being reported as
 * IGNORED: the text is display, never input, and the query handed to the parser is untouched.
 * Non-ASCII is downcased too (`SubType:ÉLDRÄZI` → “subtype:éldräzi”), so this is `toLowerCase()`
 * and not an ASCII fold.
 *
 * DOWNCASE FIRST, THEN TRUNCATE: `F:ABCDEFGHIJKLMNOPQRS` (21 characters) answers
 * “f:abcdefghijklmnopq…”, the lower-cased text cut to the same 20. That order is observable only on
 * a codepoint that CHANGES LENGTH when downcased, so it was measured on one: `f:İABCDEFGHIJKLMNOPQ`
 * is exactly 20 characters as typed and would come back whole if the cut ran first, but `İ`
 * (U+0130) downcases to `i` + U+0307 and the answer is “f:i̇abcdefghijklmno…” — 21 characters
 * downcased, then cut. The slice is by CODE POINT for the same reason: cutting UTF-16 units would
 * sever that combining mark from its `i`.
 *
 * Both answer shapes format identically: `C:MW` alone is the 400 whose `details` is "All of your
 * terms were ignored.", carrying the SAME “c:mw” warning that `C:MW e:khm` carries on its 200.
 */
function ignoredWarning(term: string, reason: string): string {
	const lowered = term.toLowerCase();
	const chars = [...lowered];
	const echoed =
		chars.length > EXPRESSION_ECHO_LIMIT ? `${chars.slice(0, EXPRESSION_ECHO_LIMIT - 1).join("")}\u2026` : lowered;
	return `Invalid expression \u201c${echoed}\u201d was ignored. ${reason}`;
}

/**
 * SCRYFALL'S REGEX DIALECT IS POSTGRESQL'S, and what PostgreSQL's compiler refuses, Scryfall
 * ignores with the compiler's own sentence.
 *
 * This file used to say Scryfall compiles in Ruby (Onigmo) and accepts what Onigmo accepts —
 * inline flags, named and atomic groups, possessive quantifiers, `\p{…}`. The sentences it was
 * already quoting say otherwise: "brackets [] not balanced", "quantifier operand invalid",
 * "invalid repetition count(s)" and "invalid escape \ sequence" are PostgreSQL's regex error
 * strings word for word (regerrs.h: REG_EBRACK, REG_BADRPT, REG_BADBR, REG_EESCAPE), and so is
 * "regular expression is too complex". Measured on api.scryfall.com 2026-10-03, anchor
 * `t:instant` = 3,909, pattern `destroy target creature` = 152 — a row at 3,909 was dropped:
 *
 *   `Invalid regular expression: quantifier operand invalid.`
 *     (?i)destroy…   destroy(?i) …   (?-i)…   (?i:destroy)   (?s:destroy)      inline flags, anywhere
 *     (?<a>destroy)  (?P<a>destroy)  (?'n'destroy)  (?>destroy)  (?|destroy)   named, atomic, reset
 *     destroy++  destroy*+  destroy?+  destroy+*  destroy{1}+  destroy{1}{2}   a quantified quantifier
 *     destroy???                                                               (one lazy `?` is fine)
 *     ^*destroy  destroy$*  destroy\y+  …creature\b{2}  (?=d)*destroy            a quantified constraint
 *     destroy(*)  destroy |*  {2}a  a|{2}  (?#x)*a                             nothing to quantify
 *
 *   `Invalid regular expression: invalid escape \ sequence.`
 *     \p{L}  \h  \z  \Z  \k  \g1  \Q…\E  [\p{L}]  bare \x  \xg  \u12  bare \c
 *     — every letter probed, one request each: the escapes that RUN are a b d e f m n r s t v w y
 *     in either case (the pattern is lower-cased before it is compiled), `\x` + hex, `\u` + four
 *     hex, `\c` + a character, and a backslash before anything that is not a letter.
 *
 *   RUN: (?:…) (?=…) (?!…) (?<=…) (?<!…) (?#…)   a*? a+? a?? a{1}? a{2,}?   [[:alpha:]] [[:word:]]
 *        \y \m \M \b \B   \x20 \u0020 \cA   {,2} and {r} (a `{` not followed by a digit is literal)
 *
 * This port ran every row of the first two groups — the engine's Rust `regex` and `fancy_regex`
 * take them — so a query using `(?i)` or a named group was validated here and silently lost its
 * regex on Scryfall.
 *
 * THE FIRST ERROR, LEFT TO RIGHT, IS THE ONE REPORTED, as a compiler reports it: `(a++` is the
 * quantifier sentence and `a)++` the parenthesis one; `[a++` is "brackets" (the class swallowed
 * the rest) and `a++[` the quantifier; `(?<x` is the quantifier sentence, not "not balanced";
 * `a{2,1}++` is the repetition count. One scan reproduces that order, which the two-pass check it
 * replaces (balance first, then shape) could not.
 *
 * NOT REPRODUCED, each a sentence this scan does not try to earn: `[a-\w]` (`invalid character
 * range`), and anything PostgreSQL rejects that is not listed above. Those fall through to the
 * older check below and, failing that, run.
 *
 * COST: one pass over the pattern at parse time.
 */
const QUANTIFIER_OPERAND_REASON = "Invalid regular expression: quantifier operand invalid.";
const INVALID_ESCAPE_REASON = "Invalid regular expression: invalid escape \\ sequence.";
const PARENS_REASON = "Invalid regular expression: parentheses () not balanced.";
const BRACKETS_REASON = "Invalid regular expression: brackets [] not balanced.";
const BRACES_REASON = "Invalid regular expression: braces {} not balanced.";
const REPETITION_COUNT_REASON = "Invalid regular expression: invalid repetition count(s).";

/** PostgreSQL's DUPMAX: `a{255,}` runs and `a{256,}` is `invalid repetition count(s)`. */
const MAX_REPETITION_COUNT = 255;

/** The letters that may follow a backslash on their own. Lower case: Scryfall lower-cases first. */
const VALID_ESCAPE_LETTERS: ReadonlySet<string> = new Set("abdefmnrstvwy");
/** Of those, the zero-width ones — a quantifier cannot follow them. */
const CONSTRAINT_ESCAPE_LETTERS: ReadonlySet<string> = new Set("bmy");

const HEX_DIGIT_RE = /^[0-9a-fA-F]$/;

/** The length of the escape starting at `pattern[i]` (a backslash), or -1 when PostgreSQL refuses it. */
function escapeLength(pattern: string, i: number): number {
	const next = pattern[i + 1];
	if (next === undefined) return 1;
	if (!/^[A-Za-z]$/.test(next)) return 2;
	const letter = next.toLowerCase();
	if (letter === "x") {
		let end = i + 2;
		while (end < pattern.length && HEX_DIGIT_RE.test(pattern[end] as string)) end++;
		return end > i + 2 ? end - i : -1;
	}
	if (letter === "u") {
		for (let k = i + 2; k < i + 6; k++) {
			if (!HEX_DIGIT_RE.test(pattern[k] ?? "")) return -1;
		}
		return 6;
	}
	if (letter === "c") return i + 2 < pattern.length ? 3 : -1;
	return VALID_ESCAPE_LETTERS.has(letter) ? 2 : -1;
}

/**
 * The first thing PostgreSQL's compiler would refuse in `pattern`, as Scryfall words it, or null.
 * See the block comment above for the measurements.
 */
function postgresSyntaxReason(pattern: string): string | null {
	// What a quantifier would apply to: nothing yet, an atom, a quantifier, a quantifier already
	// made lazy, or a zero-width constraint.
	type Kind = "none" | "atom" | "quantifier" | "lazy" | "constraint";
	const state: { kind: Kind } = { kind: "none" };
	/** One entry per open group: whether it is a lookaround (a constraint once closed). */
	const groups: boolean[] = [];
	const quantify = (): string | null => {
		if (state.kind !== "atom") return QUANTIFIER_OPERAND_REASON;
		state.kind = "quantifier";
		return null;
	};
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i] as string;
		if (ch === "\\") {
			const length = escapeLength(pattern, i);
			if (length < 0) return INVALID_ESCAPE_REASON;
			const letter = (pattern[i + 1] ?? "").toLowerCase();
			state.kind = length === 2 && CONSTRAINT_ESCAPE_LETTERS.has(letter) ? "constraint" : "atom";
			i += length;
			continue;
		}
		if (ch === "[") {
			let j = i + 1;
			if (pattern[j] === "^") j++;
			if (pattern[j] === "]") j++;
			let closed = false;
			while (j < pattern.length) {
				const c = pattern[j] as string;
				if (c === "\\") {
					const length = escapeLength(pattern, j);
					if (length < 0) return INVALID_ESCAPE_REASON;
					j += length;
				} else if (c === "[" && (pattern[j + 1] === ":" || pattern[j + 1] === "." || pattern[j + 1] === "=")) {
					const close = pattern.indexOf(`${pattern[j + 1]}]`, j + 2);
					if (close === -1) return BRACKETS_REASON;
					j = close + 2;
				} else if (c === "]") {
					closed = true;
					break;
				} else j++;
			}
			if (!closed) return BRACKETS_REASON;
			state.kind = "atom";
			i = j + 1;
			continue;
		}
		if (ch === "(") {
			if (pattern[i + 1] !== "?") {
				groups.push(false);
				state.kind = "none";
				i += 1;
				continue;
			}
			const c2 = pattern[i + 2];
			if (c2 === "#") {
				// A comment is transparent: `a(?#x)*` runs and `(?#x)*a` has nothing to quantify.
				const close = pattern.indexOf(")", i + 3);
				if (close === -1) return PARENS_REASON;
				i = close + 1;
				continue;
			}
			if (c2 === ":") {
				groups.push(false);
				i += 3;
			} else if (c2 === "=" || c2 === "!") {
				groups.push(true);
				i += 3;
			} else if (c2 === "<" && (pattern[i + 3] === "=" || pattern[i + 3] === "!")) {
				groups.push(true);
				i += 4;
			} else return QUANTIFIER_OPERAND_REASON;
			state.kind = "none";
			continue;
		}
		if (ch === ")") {
			const lookaround = groups.pop();
			if (lookaround === undefined) return PARENS_REASON;
			state.kind = lookaround ? "constraint" : "atom";
			i += 1;
			continue;
		}
		if (ch === "|") {
			state.kind = "none";
			i += 1;
			continue;
		}
		if (ch === "^" || ch === "$") {
			state.kind = "constraint";
			i += 1;
			continue;
		}
		if (ch === "*" || ch === "+") {
			const reason = quantify();
			if (reason !== null) return reason;
			i += 1;
			continue;
		}
		if (ch === "?") {
			if (state.kind === "quantifier") state.kind = "lazy";
			else {
				const reason = quantify();
				if (reason !== null) return reason;
			}
			i += 1;
			continue;
		}
		if (ch === "{" && /^[0-9]$/.test(pattern[i + 1] ?? "")) {
			// A bound. A `{` not followed by a digit is a literal brace (`{,2}`, `{r}`).
			const bound = /^\{(\d+)(?:(,)(\d*))?/.exec(pattern.slice(i));
			const end = bound === null ? -1 : i + bound[0].length;
			if (bound === null || pattern[end] !== "}") return BRACES_REASON;
			const low = Number(bound[1]);
			const high = bound[2] === undefined ? low : bound[3] === "" ? null : Number(bound[3]);
			if (low > MAX_REPETITION_COUNT || (high !== null && (high > MAX_REPETITION_COUNT || high < low))) {
				return REPETITION_COUNT_REASON;
			}
			const reason = quantify();
			if (reason !== null) return reason;
			i = end + 1;
			continue;
		}
		state.kind = "atom";
		i += 1;
	}
	return groups.length > 0 ? PARENS_REASON : null;
}

/**
 * The older, two-pass check, kept as the fallback for what the scan above does not model.
 *
 * It reports four classes, read off api.scryfall.com rather than translated from V8's:
 * `/[unclosed/` and `/[a-/` → brackets, `/(unclosed/` and `/a)/` → parentheses, `/a{2,1}/` →
 * repetition, a bare leading `*` → quantifier. Anything else gets the generic sentence; the
 * alternative is
 * inventing a message per malformation, which would be a guess wearing a measurement's clothes.
 */
function regexReason(pattern: string): string {
	const unescaped = pattern.replace(/\\[\s\S]/g, "");
	let depth = 0;
	let inClass = false;
	let bracketsBalanced = true;
	let parensBalanced = true;
	for (const ch of unescaped) {
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") inClass = true;
		else if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth < 0) parensBalanced = false;
		}
	}
	if (inClass) bracketsBalanced = false;
	if (depth !== 0) parensBalanced = false;
	if (!bracketsBalanced) return "Invalid regular expression: brackets [] not balanced.";
	if (!parensBalanced) return "Invalid regular expression: parentheses () not balanced.";
	const repetition = /\{(\d+),(\d+)\}/.exec(unescaped);
	if (repetition && Number(repetition[1]) > Number(repetition[2])) {
		return "Invalid regular expression: invalid repetition count(s).";
	}
	// A quantifier with nothing before it: at the start, after `|`, or after a plain `(` — NOT
	// after `(?`, which opens a group extension (`(?i)`, `(?<x>`) and once counted here.
	if (/(?:^|\||\((?!\?))[*+?]/.test(unescaped)) return "Invalid regular expression: quantifier operand invalid.";
	return "Invalid regular expression: invalid pattern.";
}

/**
 * SCRYFALL REFUSES A REGEX WHOSE PARENTHESES NEST THREE DEEP, and it decides that by counting
 * characters, before the pattern is ever compiled.
 *
 * Reported from mtg-seeker (x66): three shipped queries — a removal-battle, an attacking-matters
 * and an end-step-sacrifice supplement — each carried one regex nested three deep. This port
 * evaluated them (814, and 86 where Scryfall answers all 18,760 creatures) and said nothing, while
 * api.scryfall.com dropped the regex and answered the REST of the query with a warning. A query
 * validated here and shipped there returned a different set of cards with no error on either side.
 *
 * Measured on api.scryfall.com 2026-10-03, anchor `t:instant` = 3,909, one request per row. A row
 * that answers 3,909 carrying `Too many nested groups.` is a regex that was dropped:
 *
 *   o:/destroy ((target|another) (nonblack|nonwhite)|that) creature/   116    depth 2 runs
 *   o:/destroy ((target (nonblack|nonwhite))|that) creature/           400    alone: nothing is left
 *   t:instant o:/destroy (((target))) creature/                        3,909  depth 3
 *   t:instant o:/destroy (?:(?:(?:target))) creature/                  3,909  non-capturing counts
 *   (?=…) (?!…) (?<=…) (?<!…) (?i:…) (?<a>…) (?>…), three deep          3,909  every kind of group
 *   t:instant o:/(destroy) (target) (creature)/                        152    siblings do not nest
 *   t:instant o:/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/                    404    nor do eleven of them
 *   t:instant o:/((destroy)(( target))) creature/                      3,909  depth, not adjacency
 *
 * IT IS A COUNT OF THE TWO CHARACTERS, NOT OF GROUPS. A parenthesis that is escaped, or inside a
 * bracket expression, or inside a `(?#` comment, opens and closes a level like any other:
 *
 *   t:instant o:/destroy (?:(?:[(]?target)) creature/                  3,909  `[(]` is a third level
 *   t:instant o:/destroy (?:(?:\(?target)) creature/                   3,909  and so is `\(`
 *   t:instant o:/\(\(\(/    o:/[(][(][(]/                              3,909  three literals, no group
 *   t:instant o:/(\)(\)(a)))/    o:/([)]([)](a)))/                     404    a real depth of 3, and it
 *                                                                             RUNS: each `\)` closed one
 *   t:instant o:/())(((a)/                                             3,909  + `parentheses () not
 *                              balanced.` — the counter went to -1 and came back to 2, so it is not
 *                              clamped at zero, and the compiler spoke instead
 *
 * Every regex keyword takes it (`name:`, `t:`, `ft:`, `fo:`, `mana:` measured), a `-` is echoed
 * with the term, and two such terms earn two warnings. WHERE IT SITS among the other refusals is
 * measured too: after the unknown-regex-keyword sentence (`a:/(((x)))/` earns that one), before
 * the compiler's (`o:/(((a/` and `o:/(((a)))[/` are "nested", not "not balanced"), and it still
 * spends the seven-operator budget — six plain regexes and this one are a 400.
 *
 * COST: one pass over the pattern's characters at parse time, on a term that is already a regex.
 * Nothing reaches the engine.
 */
const MAX_REGEX_PAREN_DEPTH = 2;
const NESTED_GROUPS_REASON = "Too many nested groups.";

function nestsTooDeep(pattern: string): boolean {
	let depth = 0;
	for (const ch of pattern) {
		if (ch === "(") {
			if (++depth > MAX_REGEX_PAREN_DEPTH) return true;
		} else if (ch === ")") depth--;
	}
	return false;
}

/**
 * `Regular expression too complex.` — SCRYFALL'S OWN BUDGET ON ONE PATTERN, and it is two rules:
 * a weighted count of six characters, and a length.
 *
 * This port had its own bound instead (the parser's `regex-budget`, upstream #1047), and it
 * failed differently: from 257 bytes it answered `400 Search query contains an unsupported regular
 * expression.` for the WHOLE query, other terms and all, where Scryfall drops the one term and
 * answers the rest. And below 257 it ran patterns Scryfall refuses — a 244-character alternation
 * answered 377 cards here and, beside `t:instant`, all 3,909 instants there.
 *
 * ─── THE SCORE ───────────────────────────────────────────────────────────────────────────────
 *
 * Measured on api.scryfall.com 2026-10-03 by lengthening one pattern a character at a time under
 * `t:instant` (3,909 with the warning = dropped). The last pattern that ran, and the first that
 * did not:
 *
 *   `.` ×89 | ×90                 `destroy` + `.`×89 + `creature` | the same with ×90
 *   `a*` ×44 | ×45                `a+` and `a?` the same 44 | 45
 *   `|` ×22 | ×23                 alone, between one-letter words, between eight-letter words
 *   `(a)` ×29 + `.`×60 | ×30      `a{2}` ×14 + `.`×60 | ×15      `(?=a)` ×9 + `.`×60 | ×10
 *
 * One sum fits every row — refused at 90:
 *
 *   `.` 1      `(` 1      `*` `+` `?` `{` 2 each      `|` 4
 *
 * and the mixed rows confirm it is ONE sum and not six caps: 45 dots + 22 `a*` (89) runs and 46
 * (90) does not; 20 pipes + 9 dots (89) runs and + 10 does not; `.*` ×29 (87) runs and ×30 does
 * not; `a*?` ×7 + 60 dots (88) runs and ×8 (92) does not. A lookaround costs 3 — its `(` and its
 * `?` — which is `(?=a)`, `(?!a)`, `(?<=a)`, `(?<!a)` and `(?:a)` all refused at ×10 beside 60 dots.
 *
 * Everything else weighs nothing, each measured ×40 or ×50 beside dots: letters and digits (150 of
 * them), `)`, `[` `]` `^` `$` `}` `-` `~` `#` `,` `:` `!` `=` `<` `>` `&`, the class escapes `\w`
 * `\d` `\s` `\W`, `\n`, `\\`, and a backreference.
 *
 * LIKE THE NESTING RULE, IT COUNTS CHARACTERS AND NOT SYNTAX. An escaped or bracketed operator
 * costs what a live one does: `\.` ×45 + `.` ×45 is refused and ×44 runs; `[.]` ×30 + 60 dots is
 * refused; `\|` and `[|]` are refused at ×23; `\*`, `\?`, `\+` and `[*]` at ×45; `\{` ×15 beside
 * 60 dots. `o:/\(this creature\)/` therefore spends 1, and a mana symbol `{r}` spends 2.
 *
 * ─── THE LENGTH ──────────────────────────────────────────────────────────────────────────────
 *
 * 248 characters run and 249 do not, whatever they are (`a`, `1`, `A`, `,`, `é` — characters, not
 * bytes) and whatever the keyword (`o:`, `fo:`, `fulloracle:`, `name:`, `t:`, `ft:` each 248 | 249,
 * so it is the pattern and not the term). Three things are longer than they look, and they are
 * exactly what Ruby's `String#inspect` escapes, so the limit reads as "inspect is over 250":
 *
 *   `\`   counts 2     `\.` ×82 runs, ×83 is refused (3 × 83 = 249); `\w` `\b` `\s` `\d` `\n` each 3
 *   `"`   counts 2     ×10 leaves room for 228 more, not 238
 *   `#{`  counts 3     ×10 leaves room for 218 more
 *
 * and one is shorter: `--` counts ONE (ten hyphens leave room for 243 more; 249 of them run).
 * `'`, `<`, `&`, `~`, `—` and `•` are 1 each.
 *
 * ─── WHERE IT SITS ───────────────────────────────────────────────────────────────────────────
 *
 * FIRST of the text rules: `(((a)))` + 90 dots and `(((a)))` + 249 letters are "too complex", not
 * "nested"; `a{60}` + 90 dots is "too complex", not "too much repetition"; and an unbalanced `[`
 * or `(` in front of 90 dots is "too complex" too, so it precedes the compiler as well.
 *
 * NOT REPRODUCED: PostgreSQL's own `Invalid regular expression: regular expression is too
 * complex.` — a DIFFERENT sentence, from the compiler — which eighteen ADJACENT word boundaries
 * earn (`\b` ×18, `\y` ×18, `\B` ×18; seventeen run, and so do eighteen with a letter between
 * each). No query has that shape, and the port runs it.
 *
 * COST: one pass over the pattern's characters at parse time. Nothing reaches the engine, and a
 * pattern this refuses is one the engine no longer compiles or scans with.
 */
const TOO_COMPLEX_REASON = "Regular expression too complex.";
const REGEX_COMPLEXITY_LIMIT = 90;
const REGEX_INSPECT_LENGTH_LIMIT = 248;

function tooComplex(pattern: string): boolean {
	let score = 0;
	let length = 0;
	const chars = [...pattern];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		const next = chars[i + 1];
		if (ch === "." || ch === "(") score += 1;
		else if (ch === "*" || ch === "+" || ch === "?" || ch === "{") score += 2;
		else if (ch === "|") score += 4;
		if (ch === "-" && next === "-") {
			// The pair is one character.
			i++;
			length += 1;
		} else if (ch === "\\" || ch === '"') length += 2;
		else if (ch === "#" && next === "{") length += 2;
		else length += 1;
	}
	return score >= REGEX_COMPLEXITY_LIMIT || length > REGEX_INSPECT_LENGTH_LIMIT;
}

/**
 * `Too much repetition.` — THE UPPER BOUNDS OF A PATTERN'S `{…}` QUANTIFIERS, ADDED UP, MAY NOT
 * EXCEED 50.
 *
 * Found while pinning the complexity rule: `o:/destroy.{135}creature/` is refused with this
 * sentence and not that one. This port ran every such pattern up to its own bound of 1,024.
 *
 * Measured on api.scryfall.com 2026-10-03, anchor `t:instant` = 3,909:
 *
 *   a{50}  a{0,50}  .{50}          run                 a{51}  a{0,51}  .{51}       refused
 *   a{25}b{25}                     runs (50)           a{25}b{26}  a{0,25}b{0,26}  refused (51)
 *   a{2} ×26                       refused (52)        a{1} ×26                    runs (26)
 *   x{3,4}y{46}                    runs (4 + 46)       x{3,4}y{47}                 refused
 *   (a{10}){10}                    runs — a SUM (20), not the product (100)
 *
 * IT IS THE UPPER BOUND THAT COUNTS, and an open one counts nothing: `a{25,26}` runs (26, not 51),
 * `a{51,60}` is refused, and so is `a{60,51}` — 51, read before the compiler could object to the
 * order — while `a{51,}` runs, `x{3,}y{50}` runs, and `a{255,}` runs (256 is the compiler's
 * `invalid repetition count(s)`).
 *
 * And like the two rules before it, it reads CHARACTERS: `[{51}]` and `{r}{51}` are refused,
 * `a{051}` is refused (51), while `\{51\}` and `a{ 51}` run — the shape is a brace, digits, an
 * optional comma and more digits, and a brace, with nothing else between.
 *
 * LAST of the three text rules (`(((a{60})))` is "nested"; `a{60}` + 90 dots is "too complex") and
 * still ahead of the compiler (`a{60}[` is this sentence, not "brackets [] not balanced").
 *
 * COST: one regex scan of the pattern at parse time.
 */
const TOO_MUCH_REPETITION_REASON = "Too much repetition.";
const MAX_REGEX_REPETITION_SUM = 50;
const REPETITION_BOUND_RE = /\{(?:\d+,)?(\d+)\}/g;

function repeatsTooMuch(pattern: string): boolean {
	let sum = 0;
	for (const match of pattern.matchAll(REPETITION_BOUND_RE)) {
		sum += Number(match[1]);
		if (sum > MAX_REGEX_REPETITION_SUM) return true;
	}
	return false;
}

/**
 * A BACKREFERENCE IS ACCEPTED BY SCRYFALL AND NEVER MATCHES ANYTHING. It is not a backreference
 * there at all.
 *
 * Reported from mtg-seeker (x66 R3): `t:creature name:/^(.)\1\1/` is a plain 404 on
 * api.scryfall.com and was `400 Search query contains an unsupported regular expression.` here —
 * the parser's budget refuses `\1` because the public engine is linear-time. The obvious reading,
 * that Scryfall evaluated the pattern and no creature's name opens with a tripled letter, is
 * wrong, and the rows that show it are the ones where a real backreference WOULD match
 * (2026-10-03, `t:elf` = 698):
 *
 *   name:/oo/ t:elf            75      Wood Elves, and 74 more
 *   name:/(o)\1/ t:elf         404     the same question, asked with a backreference
 *   name:/(.)\1/ t:elf         404     any doubled letter at all
 *   o:/(e)\1/ t:elf            404     …in rules text
 *   name:/^(a)\1/              404     though Aarakocra exists
 *   name:/o\1/ t:elf           404     NO GROUP to refer to, and no "invalid backreference" either
 *   name:/^(.)\2/ t:elf        404     a group that does not exist: the same silence
 *   name:/(o)\0/  name:/(o)\10/   404
 *   -name:/(.)\1/ t:elf        730     every elf — the complement of nothing (730, not 698,
 *                                      because a `name:` regex still switches extras on)
 *   name:/a\1b/ or t:elf       730     and it composes under `or` as an empty leaf
 *
 * So a backslash and digits are some character no card's text contains, and the term is honored
 * and empty — the answer a comparison on an unknown keyword gets. The named spellings are not
 * this: `\g1` and `\k1` are `Invalid regular expression: invalid escape \ sequence.`
 *
 * THE CHOICE, cost first. Translating to an equivalent pattern is impossible (there is nothing to
 * be equivalent to). Running real backreferences on the bounded backtracking engine would cost a
 * whole-corpus scan per term (no literal factor to narrow by) to compute an answer Scryfall does
 * not give — `name:/(o)\1/ t:elf` would be 75, not 404. So the term is kept and each `\<digits>`
 * becomes `\x01`, a character no card carries: the pattern stays a regex (the `name:` extras
 * trigger and the seven-operator budget still see one) and compiles on the LINEAR engine like any
 * other escape. No backtracking engine is entered at all. Checked against the deployed engine the
 * same day: `name:/(o)\x01/ t:elf` 404, `-name:/(.)\x01/ t:elf` 730, `name:/a\x01b/ or t:elf` 730.
 *
 * `\\1` is an escaped backslash and a digit, and is left alone.
 */
function neutralizeBackreferences(pattern: string): string {
	if (!/\\\d/.test(pattern)) return pattern;
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i] as string;
		if (ch !== "\\" || i + 1 >= pattern.length) {
			out += ch;
			continue;
		}
		const next = pattern[i + 1] as string;
		if (next < "0" || next > "9") {
			out += ch + next;
			i++;
			continue;
		}
		let end = i + 1;
		while (end < pattern.length && (pattern[end] as string) >= "0" && (pattern[end] as string) <= "9") end++;
		out += "\\x01";
		i = end - 1;
	}
	return out;
}

/**
 * A PATTERN SCRYFALL WOULD RUN AND THIS ENGINE'S OWN BUDGET WILL NOT is dropped with Scryfall's
 * too-complex sentence — the FAILURE MODE is Scryfall's even where the threshold is not.
 *
 * The parser's static budget (`parser/regex-budget.ts`, upstream #1047) is the engine's safety
 * bound, and it is narrower than Scryfall's in four places: more than 4 lookarounds (Scryfall
 * prices a lookaround at 3 of its 90, so up to 29), more than 64 constructs (Scryfall runs 89 dots
 * or 82 `\w`), an open-ended `{m,}` with m over 1 (`o:/a{2,}/` runs there), and more than 256
 * UTF-8 BYTES (Scryfall counts 248 CHARACTERS, so a pattern of non-ASCII text). Left to the
 * parser, any of them refused the WHOLE query — `400 Search query
 * contains an unsupported regular expression.`, a sentence Scryfall has no counterpart for — even
 * with other terms present. Dropping the one term keeps the rest of the query answering and tells
 * the caller, in the words a Scryfall client already handles, that the regex was not applied.
 *
 * THE RESIDUE, recorded as a known deviation (live-parity `search-regex-five-lookarounds-…`):
 * `t:instant o:/(?=d)(?=de)(?=des)(?=dest)(?=destr)destroy target creature/` is 152 on
 * api.scryfall.com (2026-10-03) and all of `t:instant` with the warning here. The safe direction
 * for a client that validates here and ships to Scryfall: the port refuses, loudly, what Scryfall
 * would have run — never the reverse. Raising the engine's bound to Scryfall's is a cost decision
 * (every lookaround pattern scans the corpus on the backtracking engine), not a parity fix.
 *
 * A metacharacter-free pattern on a text column never reaches the budget — the rewrite lowers it
 * to a plain substring — so it is exempt here too.
 */
function overEngineBudget(keyword: string, pattern: string): boolean {
	if (!MANA_COST_KEYWORDS.has(keyword) && regexPlainLiteral(pattern) !== null) return false;
	return patternExceedsBudget(pattern);
}

/**
 * Why Scryfall refuses a regex it has not compiled yet, or null — the checks it runs on the
 * pattern's TEXT, in the order it runs them.
 */
export function scryfallRegexTextReason(pattern: string): string | null {
	if (tooComplex(pattern)) return TOO_COMPLEX_REASON;
	if (nestsTooDeep(pattern)) return NESTED_GROUPS_REASON;
	if (repeatsTooMuch(pattern)) return TOO_MUCH_REPETITION_REASON;
	return null;
}

/**
 * An apostrophe the LEXER keeps inside a word rather than opening a string: preceded by a word
 * character and followed by one (or by the end of input) — `don't`, `urza's`, `urza'` mid-type.
 * The lexer's own rule lives in tokenizer.ts (`scanWordEnd`), where it is consulted only while a
 * word is already being scanned; this is that rule seen from a scanner that has no token state.
 * Both scanners below used to run to the next `'` on ANY apostrophe, so `(o:don't) e:khm` read as
 * a string that swallowed the `)` and was refused as unclosed parentheses, and `o:don't f:x` was
 * one piece with the second term neither dropped nor warned.
 */
function apostropheInWord(src: readonly string[], pos: number): boolean {
	if (pos === 0 || !isWordCont(src[pos - 1] as string)) return false;
	return pos + 1 >= src.length || isWordCont(src[pos + 1] as string);
}

/**
 * A `/` OPENS A PATTERN ONLY WHERE THE LEXER READS ONE: directly behind a comparison operator
 * (tokenizer.ts). Anywhere else it is the character — the separator `fire/ice` has, or division.
 * Both scanners below used to run to the next `/` on any slash, so `(fire/ice) e:khm` read as a
 * pattern that swallowed the `)` and was refused as unclosed parentheses, and `fire/ice f:x` was
 * one piece with the second term neither dropped nor warned — the apostrophe's two faults again.
 */
function opensPattern(src: readonly string[], pos: number): boolean {
	if (pos === 0) return false;
	const prev = src[pos - 1] as string;
	return prev === ":" || prev === "=" || prev === "<" || prev === ">";
}

/**
 * Whether the query's parentheses balance, ignoring the ones inside strings, patterns and mana
 * symbols — the same regions `scanPieces` steps over, for the same reason.
 */
function unbalancedParens(source: string): boolean {
	const src = [...source];
	const n = src.length;
	let depth = 0;
	for (let pos = 0; pos < n; pos++) {
		const c = src[pos] as string;
		if (c === "'" && apostropheInWord(src, pos)) continue;
		if (c === '"' || c === "'" || (c === "/" && opensPattern(src, pos))) {
			pos++;
			while (pos < n) {
				const d = src[pos] as string;
				if (d === "\\" && pos + 1 < n) pos += 2;
				else if (d === c) break;
				else pos++;
			}
			continue;
		}
		if (c === "{") {
			const close = src.indexOf("}", pos + 1);
			if (close === -1) return false;
			pos = close;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")" && --depth < 0) return true;
	}
	return depth !== 0;
}

// ─── scanning ────────────────────────────────────────────────────────────────

/**
 * One top-level piece of a query: a group, a boolean connector, or a leaf term.
 *
 * The scan respects everything the lexer respects — `"…"`, `'…'`, `/…/` and `{…}` all carry
 * spaces without ending a term, and a backslash escapes the next character inside a string or a
 * pattern — because a term boundary this scan gets wrong is a query this policy would corrupt.
 */
interface Piece {
	readonly text: string;
	readonly kind: "group" | "connector" | "leaf";
	/** For a group: the text inside the parentheses, and the `-`/`!` prefix outside them. */
	readonly inner?: string;
	readonly prefix?: string;
}

const CONNECTORS: ReadonlySet<string> = new Set(["and", "or"]);

function scanPieces(source: string): Piece[] {
	const src = [...source];
	const n = src.length;
	const pieces: Piece[] = [];
	let pos = 0;
	while (pos < n) {
		const ch = src[pos] as string;
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
			pos++;
			continue;
		}
		const start = pos;
		let depth = 0;
		let groupStart = -1;
		let groupEnd = -1;
		while (pos < n) {
			const c = src[pos] as string;
			if (c === "'" && apostropheInWord(src, pos)) {
				pos++;
				continue;
			}
			if (c === '"' || c === "'" || (c === "/" && opensPattern(src, pos))) {
				// A quoted string or a regex literal: run to its closing delimiter, honoring `\`.
				pos++;
				while (pos < n) {
					const d = src[pos] as string;
					if (d === "\\" && pos + 1 < n) pos += 2;
					else if (d === c) {
						pos++;
						break;
					} else pos++;
				}
				continue;
			}
			if (c === "{") {
				const close = src.indexOf("}", pos + 1);
				pos = close === -1 ? n : close + 1;
				continue;
			}
			if (c === "(") {
				if (depth === 0) groupStart = pos;
				depth++;
				pos++;
				continue;
			}
			if (c === ")") {
				depth--;
				pos++;
				if (depth === 0) groupEnd = pos;
				continue;
			}
			if (depth === 0 && (c === " " || c === "\t" || c === "\r" || c === "\n")) break;
			pos++;
		}
		const text = src.slice(start, pos).join("");
		if (groupStart >= 0 && groupEnd === pos) {
			pieces.push({
				text,
				kind: "group",
				prefix: src.slice(start, groupStart).join(""),
				inner: src.slice(groupStart + 1, groupEnd - 1).join(""),
			});
		} else if (CONNECTORS.has(text.toLowerCase())) {
			pieces.push({ text, kind: "connector" });
		} else {
			pieces.push({ text, kind: "leaf" });
		}
	}
	return pieces;
}

/** `keyword`, comparison operator and raw value of a leaf, or null when it is not one. */
const LEAF_RE = /^(-?)([A-Za-z_][A-Za-z0-9_]*)(!=|>=|<=|:|=|>|<)([\s\S]*)$/;

/** Strip one layer of matching quotes, so a validator reads the value the lexer would. */
function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
	}
	return value;
}

/**
 * Whether a value reads as a number to the numeric columns.
 *
 * `even`/`odd` are NOT numbers here, and were until 2026-10-03: they are two words ONE column
 * takes under `:`/`=`, which `classifyLeaf` decides before it asks this. Calling them numeric for
 * every column kept `pow:even` and `mv>even` in the query for the parser to refuse — `400 Failed
 * to parse query` where api.scryfall.com answers `Unknown keyword “pow”.` and a 404.
 *
 * AND A QUOTED VALUE IS A STRING, NEVER A NUMBER, which the same measurement turned up: this used
 * to unquote first, so `mv:"2"` was kept for a parser that reads a number TOKEN there and refuses
 * a quoted one — another `400 Failed to parse query`. Measured 2026-10-03, anchor `e:khm t:god`
 * = 12: `mv:"2"` and `mv="2"` earn the value sentence, `pow:"2"` `tou:"2"` `loy="3"` `usd:"1"`
 * `year:"2021"` and `year="2021"` earn `Unknown keyword “<kw>”.`, each 12 with its warning; and
 * `mv>"2" or (t:goblin t:wizard)` and `pow>="2" or (…)` are 18 with none — the comparison kept,
 * matching nothing. (`mv:"even"` is the one quoted value that IS honored, 17,331, and it is not a
 * number either.)
 */
function isNumericValue(value: string): boolean {
	const v = value.trim().toLowerCase();
	// No `+`: `pow=+1` is the unknown-keyword sentence on Scryfall — see ODD_NUMBER_RE.
	if (/^-?(\d+(\.\d*)?|\.\d+)$/.test(v)) return true;
	// `pow>=tou` and friends: a column name on the right is Scryfall's cross-column comparison.
	return /^[a-z]+$/.test(v) && CROSS_COLUMN_VALUES.has(v);
}

/**
 * The column names Scryfall accepts on the RIGHT of a numeric comparison.
 *
 * `pt`/`powtou` are among them, in both positions (2026-10-03): `pt>pow` 18,477, `pt>tou` =
 * `powtou>tou` = `tou<pt` 17,862, `pt=pow` = `pow=pt` 472, `pt<pow` = `pow>pt` 44, `pt>mv`
 * 15,207, `pt=cmc` 2,328, `mv>pt` 1,364.
 */
const CROSS_COLUMN_VALUES: ReadonlySet<string> = new Set([
	"pow",
	"power",
	"tou",
	"toughness",
	"pt",
	"powtou",
	"cmc",
	"mv",
	"manavalue",
	"loy",
	"loyalty",
	// `x` was here and is not a column: it is the number zero, as `*`, `y` and `z` are — see
	// ZERO_WORD_RE, which answers it before this table is read.
	// The collector number and the EDHREC rank, on the right as on the left (2026-10-03, anchor
	// `e:khm` = 305): `pow>cn` = `pow>number` 1, `cmc<edhrec` = `cmc<edhrecrank` 295, and
	// `collector>cn` and `collector=collector` are the same-sides refusal — which is only
	// reachable once the name on the right reads as a column.
	"cn",
	"number",
	"collector",
	"collectornumber",
	"edhrec",
	"edhrecrank",
	// The prices, which were never here: `cmc<usd e:khm` is 66, `usdfoil>usd` 247, `usd>usdfoil`
	// 57, `usdfoil>eur` 274, `eur>usdfoil` 30, `usdfoil>tix` 283 (2026-10-03). Before this a price
	// on the right was "not a number" and the comparison matched nothing.
	"usd",
	"eur",
	"tix",
	"usdfoil",
	// The counts: `prints>sets e:khm` 119, `prints=sets e:khm` 186, `prints>=paperprints e:khm`
	// 305, `prints>paperprints e:khm` 98, `illustrations>=prints e:khm` 123, and
	// `prints=prints e:khm` the same-sides refusal.
	"prints",
	"sets",
	"paperprints",
	"papersets",
	"illustrations",
	"artists",
]);

/**
 * What Scryfall says to a numeric column compared with itself.
 *
 * Measured 2026-10-03: `pt=pt`, `pt>powtou`, `pow=pow`, `pow=power`, `cmc=mv` and `tou>toughness`
 * alone are each the 400 carrying this sentence, and `loy=loy`, `pow>power` and `pt=powtou` with
 * `e:khm t:god` are each its 12 with the warning — every operator, and across SPELLINGS of one
 * column, so it is the column that is compared and not the word. This port answered `pow=pow`
 * with every card that has a power (18,981).
 *
 * The negated forms never reach it, and are measured too: `-pow=pow` is the negated-equality
 * `Unknown keyword “-pow”.` and `-pow>pow` the silent tautology.
 */
const SAME_SIDES_REASON = "The sides of your comparison must be different.";

/** The numeric column an alias names — `pow` and `power` are one, `pt` and `powtou` are one. */
function numericColumnOf(alias: string): string | null {
	const info = (ALIAS_TO_FIELD_INFOS.get(alias) ?? []).find((fi) => fi.parserClass === ParserClass.NUMERIC);
	return info === undefined ? null : info.dbColumnName;
}

/**
 * A NUMBER MAY END IN ITS POINT OR OPEN WITH IT, and a lone point is zero.
 *
 * Measured on api.scryfall.com 2026-10-04, one request per row:
 *
 *   pow=.5   1 (Little Girl) = cmc=.5      pow=1.  pow=1.0  pow=01   3,563 = pow=1
 *   cmc=2.   7,153 = cmc=2                 pow=1.5  pow=1.50         1
 *   pow=.    1,049 = pow=0                 pow=-.5                   404, no warning
 *   collector:1. e:khm   1                 collector:1.5 e:khm       404
 *   pow=+1   400 + `Unknown keyword “pow”.` — a `+` is not a sign, so the value is not a number
 *
 * The parser reads `0.5` and `1` and refuses `.5` and `1.` (the first does not lex, the second
 * lexes as a word), so the value is respelled here and everything Scryfall says to the leaf is
 * what it says to the respelled one. This port answered `Failed to parse query` for all of them,
 * and for `pow=+1`, which `isNumericValue` used to call a number.
 *
 * COST: one regex test on a numeric leaf at parse time.
 */
const ODD_NUMBER_RE = /^(-?)(\d*)\.(\d*)$/;

/** `.5` → `0.5`, `1.` → `1`, `.` → `0`; null when the value is not one of those spellings. */
function respelledNumber(rawValue: string): string | null {
	const match = ODD_NUMBER_RE.exec(rawValue);
	if (match === null || (match[2] !== "" && match[3] !== "")) return null;
	return `${match[1]}${match[2] === "" ? "0" : match[2]}${match[3] === "" ? "" : `.${match[3]}`}`;
}

/**
 * A NUMERIC VALUE ENDS WHERE THE NUMBER ENDS, AND WHAT FOLLOWS IS A TERM OF ITS OWN.
 *
 * Scryfall's lexer reads, after a numeric keyword and its operator, a number, one of the four
 * zero words (ZERO_WORD_RE) or a column name (CROSS_COLUMN_VALUES, the longest that fits) — and
 * stops. Whatever is glued on behind is lexed as the next term, exactly as if a space stood
 * there. Measured on api.scryfall.com 2026-10-04, one request per cell, each pair equal:
 *
 *   pow=1a    2,743 = pow=1 a        cmc=3a   6,254 = cmc=3 a       tou=2x   188 = tou=2 x
 *   pow=2x      234 = pow=2 x        loy=3a      74 = loy=3 a       pow>1a   11,760 = pow>1 a
 *   pow=xy      200 = pow=0 y        pow=xx      46 = pow=0 x       pow=you  85 = pow=0 ou
 *   pow=1.5a      1 = pow=1.5 a      pow=-1a      3 = pow=-1 a      pow=1.a  2,743 = pow=1. a
 *   pow=toua  8,059 = pow=tou a      tou=powerx 457 = tou=power x   (`tou=pow erx` is 1)
 *   usd>1a e:khm  47 = usd>1 a e:khm            year=2021a e:khm  241 = year=2021 a e:khm
 *   cn>1a e:khm  240 = cn>1 a e:khm             collector:1a e:khm  1, collector:1z e:khm  404
 *
 * THE REST IS ANY TERM, not only a name word: `pow=1t:goblin` is 182 = `pow=1 t:goblin`,
 * `pow=1-1` 3,561 (the word `1`, negated), `pow=1"a"` 2,742 (the quoted word), `pow=*1` 1 =
 * `pow=0 1` and `pow=x2` `pow=1e1` `pow=1d4` each the 404 their spaced twins are. So the rest goes
 * back through this policy as a query of its own.
 *
 * A REST THAT IS ONLY PUNCTUATION IS NOTHING: `pow=1*` `pow=1?` `pow=1!` `pow=1..` are 3,563 =
 * `pow=1`, `pow=**` `pow=x*` `pow=***` 1,049 = `pow=0`, as the bare words `?` and `.` are the
 * whole corpus (33,649). And `+` is a character a name keeps: `+2` alone is +2 Mace and `+mace` a
 * 404, so `pow=1+1` `pow=1+*` `pow=x+1` are 404 — the rest is asked for as the quoted word.
 *
 * NOT UNDER A LEADING `-`, where Scryfall reads no number at all: `-pow=1a` alone is the 400
 * carrying `Unknown keyword “-pow”.`, `-cmc=3a e:khm t:god` the 12 carrying the value sentence,
 * and `-pow>1a e:khm` the anchor's 305 (`-pow>1 a e:khm` is 241) — the whole word swallowed by the
 * rule the negated leaf already gets. Nor for a value that does not START as a number: `pow=a`,
 * `pow=+1a` and `mv=evena` are the sentences they were.
 *
 * `collector:` took a narrower rule until this one was measured — "a value led by digits is its
 * leading integer" — which answered `collector:1z e:khm` with khm/1 where Scryfall has a 404.
 *
 * LEFT ALONE: a rest this port's lexer cannot read (`collector:1★`, which stays the kept term
 * that matches nothing — Scryfall's 404), a rest of a lone `-`, and `cn:`/`number:` under
 * `:`/`=`, where the value is the string collector number (`cn:1a e:fem` is a card numbered 1a).
 *
 * COST: one regex on a leaf at parse time, and a second scan of the one leaf that splits.
 */
const NUMBER_PREFIX_RE = /^-?(?:\d+(?:\.\d*)?|\.\d*)/;
const ZERO_WORD_PREFIX_RE = /^[xyz*]/i;
const COLUMNS_LONGEST_FIRST: readonly string[] = [...CROSS_COLUMN_VALUES].sort((a, b) => b.length - a.length);
/** What the name collation deletes at the head of a word, so a rest of only these is no term. */
const REST_PUNCTUATION_RE = /^[.?*,/]+/;
const NUMBER_WORD_RE = /^(-?)(\d+(?:\.\d+)?)$/;
const QUOTABLE_WORD_RE = /^[^\s"'()]+$/;

/** How much of `rawValue` a numeric column reads: a number, a column name, or a zero word. */
function numericPrefixLength(rawValue: string): number {
	const number = NUMBER_PREFIX_RE.exec(rawValue);
	if (number !== null) return number[0].length;
	const lowered = rawValue.toLowerCase();
	for (const column of COLUMNS_LONGEST_FIRST) {
		if (lowered.startsWith(column)) return column.length;
	}
	return ZERO_WORD_PREFIX_RE.test(rawValue) ? 1 : 0;
}

/**
 * What was glued behind a numeric value, as the term it is: "" when it is nothing, null when this
 * port cannot read it (the leaf is then answered unsplit, as before).
 */
function gluedRest(rest: string): string | null {
	const text = rest.replace(REST_PUNCTUATION_RE, "");
	if (text === "" || text === "!") return "";
	// `+2` is the name that holds "+2", which only the quoted word says to this parser (a bare
	// `+` is arithmetic to it).
	if (text.startsWith("+")) return QUOTABLE_WORD_RE.test(text) ? `"${text}"` : null;
	// A bare number is a name word on Scryfall and a numeric literal to this parser.
	const number = NUMBER_WORD_RE.exec(text);
	if (number !== null) return `${number[1]}name:${number[2]}`;
	if (text === "-") return null;
	try {
		tokenize(text);
	} catch {
		return null;
	}
	return text;
}

/** `pow=1a` → `pow=1 a`: the leaf as the terms Scryfall reads, or null when it is one term. */
function numericValueSplit(term: string): string | null {
	const match = LEAF_RE.exec(term);
	if (match === null || match[1] === "-") return null;
	const op = match[3] as string;
	const rawValue = match[4] as string;
	if (!readsNumber((match[2] as string).toLowerCase(), op === ":" || op === "=")) return null;
	const length = numericPrefixLength(rawValue);
	if (length === 0 || length === rawValue.length) return null;
	const rest = gluedRest(rawValue.slice(length));
	if (rest === null) return null;
	const head = `${match[2]}${op}${rawValue.slice(0, length)}`;
	return rest === "" ? head : `${head} ${rest}`;
}

/** The verdict on one leaf term: keep it (possibly rewritten), or drop it with Scryfall's reason. */
type LeafVerdict =
	/** Kept, possibly rewritten; `include` is what the term switches on besides (see BLOCK_KEYWORDS). */
	| { keep: true; text: string; include?: readonly (keyof IncludeOptions)[] }
	| { keep: false; reason: string }
	/** A display option: removed from the query, never a term, with its own warning if any. */
	| {
			keep: false;
			reason: null;
			include: readonly (keyof IncludeOptions)[];
			warning: string | null;
			directive?: DirectiveFound;
	  };

function classifyLeaf(term: string): LeafVerdict {
	const match = LEAF_RE.exec(term);
	if (match === null) return { keep: true, text: term };
	const negated = match[1] === "-";
	const keyword = (match[2] as string).toLowerCase();
	const op = match[3] as string;
	const rawValue = match[4] as string;

	// BEFORE the unknown-keyword rule, because a dangling operator never reaches Scryfall's keyword
	// table at all: `nonsense:x` is "Unknown keyword" and `nonsense:` is a 404 for a card named
	// "nonsense" \u2014 the same 404 `q=nonsense` gives. See danglingOperatorTerm.
	if (rawValue === "") return { keep: true, text: danglingOperatorTerm(negated, match[2] as string, op) };

	const equality = op === ":" || op === "=";

	// `pow=*`, `tou>x`, `cmc=y`: the value is zero, and everything Scryfall says to the leaf is what
	// it says to `<kw><op>0` — see ZERO_WORD_RE. The warning, if one comes, still echoes the term
	// as written, because the caller echoes its own text.
	if (ZERO_WORD_RE.test(rawValue) && readsNumber(keyword, equality)) {
		return classifyLeaf(`${match[1]}${match[2]}${op}0`);
	}
	// `pow=.5`, `cmc=2.`, `pow=.`: a number the parser spells differently — see ODD_NUMBER_RE.
	if (readsNumber(keyword, equality)) {
		const respelled = respelledNumber(rawValue);
		if (respelled !== null) return classifyLeaf(`${match[1]}${match[2]}${op}${respelled}`);
	}

	// BEFORE the negation rule below, and it is the one value validator that has to be: `-date>=zzzz`
	// is dropped-and-warned exactly as its unnegated twin is, and it echoes the MINUS with it
	// (measured 2026-09-03, anchor `e:khm` = 323: `-date>=zzzz e:khm` is 323 carrying
	// `Invalid expression “-date>=zzzz” was ignored. Invalid date or unknown set code “zzzz”`).
	// The `-` strip below would otherwise hand the validator a term whose warning names the wrong
	// expression. See dateValueReason.
	{
		const dateReason = dateValueReason(keyword, rawValue);
		if (dateReason !== null) return { keep: false, reason: dateReason };
	}
	// A date Scryfall honors and the parser refuses — a day its month does not have, a year no
	// printing is dated in. The rewritten term carries no `-`: on `date` Scryfall discards it
	// (DATE_KEYWORDS), exactly as the rule just below does for a date the parser reads.
	if (DATE_KEYWORDS.has(keyword)) {
		const honored = honoredDateTerm(match[2] as string, op, rawValue);
		if (honored !== null) return { keep: true, text: honored };
	}

	// BEFORE the unknown-keyword rule and before every value validator, because Scryfall applies it
	// there: `-nonsense>=1`, `-subtype>=1`, `-lang>zz`, `-f>notaformat` and `-oracleid>abc` are all
	// the anchor's 151 with an ABSENT `warnings` key, where each unnegated twin is ignored-and-warned.
	// See NEGATION_HONORING_COMPARISONS and DATE_KEYWORDS for the measurements.
	if (negated) {
		if (DATE_KEYWORDS.has(keyword)) return { keep: true, text: term.slice(1) };
		if (!equality && !NEGATION_HONORING_COMPARISONS.has(keyword)) {
			return { keep: true, text: ALWAYS_MATCHES };
		}
	}

	// BEFORE the unknown-keyword rule and before every value validator, because Scryfall's
	// comparison operators reach neither. A keyword outside COMPARABLE_KEYWORDS — a text column,
	// a directive name, or a keyword nobody knows — is HONORED and matches nothing under `>` `>=`
	// `<` `<=` `!=`, with no `warnings` key at all. `nonsense>=1`, `t>creature`, `f>notaformat`,
	// `lang>zz`, `oracleid>abc` and `is>foil` are one 404 each; their `:` twins are all
	// ignored-and-warned. See COMPARABLE_KEYWORDS for the 78-row enumeration.
	//
	// The SCRYFALL_ONLY exemption below does not apply here: it exists so a keyword Scryfall
	// honors is not silently dropped, and this rule drops nothing — it answers Scryfall's own
	// empty result.
	if (COMPARISON_OPERATORS.has(op) && !COMPARABLE_KEYWORDS.has(keyword)) {
		return { keep: true, text: NEVER_MATCHES };
	}

	// A display option under `:`, in either polarity — see DISPLAY_OPTION_LABELS and INCLUDE_VALUES.
	// Under `=` it is a keyword Scryfall does not know (`unique=prints`, `include=extras` and
	// `display=grid` each earn the unknown-keyword sentence), which for `include`, `display` and
	// `as` is the rule just below and for this parser's directive names has to be said here.
	if (isDisplayKeyword(keyword)) {
		if (op === ":") return classifyDisplayOption(keyword, rawValue);
		return { keep: false, reason: `Unknown keyword \u201c${negated ? "-" : ""}${keyword}\u201d.` };
	}

	if (NOT_SCRYFALL_KEYWORDS.has(keyword) || (!KNOWN_KEYWORDS.has(keyword) && !SCRYFALL_ONLY_KEYWORDS.has(keyword))) {
		return { keep: false, reason: `Unknown keyword “${negated ? "-" : ""}${keyword}”.` };
	}

	// AFTER the unknown-keyword rule, because Scryfall orders them that way: `types:/creature/`
	// and `subtype:/goblin/` come back `Unknown keyword`, not `Unknown regular expression
	// keyword`, since neither spelling is a Scryfall keyword at all. See regexKeywordReason.
	const regexReasonForKeyword = regexKeywordReason(keyword, rawValue);
	if (regexReasonForKeyword !== null) return { keep: false, reason: regexReasonForKeyword };

	// `mv:even` / `mv:odd`, before every numeric rule below because the word is not a number and
	// each of them would otherwise speak for it. Three outcomes, all measured — see
	// MANA_VALUE_PARITY_FLIP: the positive term is kept as written, the negated one is the OTHER
	// parity, and under a comparison the word matches nothing (the negated comparison never gets
	// here: the tautology rule above already answered it).
	if (MANA_VALUE_KEYWORDS.has(keyword)) {
		const parity = manaValueParity(rawValue);
		if (parity !== null) {
			if (!equality) return { keep: true, text: NEVER_MATCHES };
			if (!negated) return { keep: true, text: term };
			return { keep: true, text: `${match[2]}${op}${MANA_VALUE_PARITY_FLIP.get(parity)}` };
		}
	}

	if (negated && equality) {
		if (MANA_VALUE_KEYWORDS.has(keyword)) return { keep: false, reason: MANA_VALUE_REASON };
		if (NEGATED_EQUALITY_UNKNOWN_KEYWORD.has(keyword)) {
			return { keep: false, reason: `Unknown keyword \u201c-${keyword}\u201d.` };
		}
	}

	const value = unquote(rawValue);
	/**
	 * The value as the REASON sentences name it, which is downcased — the same downcase the echoed
	 * expression gets (see `ignoredWarning`), and the second half of the same divergence. Measured
	 * 2026-08-28, anchor `e:khm` = 323: `F:NOTAFORMAT` answers `Unknown game format “notaformat”`,
	 * `Lang:ZZ` answers ``Unknown language `zz` `` and `R:NotARare` answers
	 * `Unknown rarity “notarare.”` — three sentences that had been echoing the value verbatim, so a
	 * capital letter in the value came back capitalized where Scryfall lower-cases it. The
	 * membership tests below already downcased to decide; only the sentences did not.
	 *
	 * This is deliberately NOT applied to the whole leaf: `value` still carries the user's case
	 * into every predicate that survives, and the colour and devotion readers do their own
	 * downcasing where their vocabulary calls for it.
	 */
	const loweredValue = value.toLowerCase();

	// `collector:1a` is collector number 1 and `collector:1★` matches nothing — see
	// COLLECTOR_NUMBER_KEYWORDS. Before the numeric rule below, which would call both unknown.
	if (COLLECTOR_NUMBER_KEYWORDS.has(keyword) && equality && /^\d/.test(rawValue) && !isNumericValue(rawValue)) {
		const leading = COLLECTOR_LEADING_INTEGER_RE.exec(rawValue);
		return { keep: true, text: leading === null ? NEVER_MATCHES : `${match[2]}${op}${leading[1]}` };
	}
	// ...and a signed value is not a collector number: `collector:+1` is the unknown-keyword
	// sentence, where the number test below would read it as one.
	if (COLLECTOR_NUMBER_KEYWORDS.has(keyword) && equality && rawValue.startsWith("+")) {
		return { keep: false, reason: `Unknown keyword “${keyword}”.` };
	}

	// A numeric column asked for something that is not a number. With `:`/`=` Scryfall ignores the
	// term; with a comparison it keeps it and matches nothing (`q=cmc>=notanumber` is a 404, not a
	// 400), so those two answers are different terms rather than one rule.
	if (MANA_VALUE_KEYWORDS.has(keyword) || NEGATED_EQUALITY_UNKNOWN_KEYWORD.has(keyword)) {
		if (!isNumericValue(rawValue)) {
			if (equality) {
				return MANA_VALUE_KEYWORDS.has(keyword)
					? { keep: false, reason: MANA_VALUE_REASON }
					: { keep: false, reason: `Unknown keyword \u201c${keyword}\u201d.` };
			}
			return { keep: true, text: NEVER_MATCHES };
		}
		// A number too large for Scryfall to compare with — see VALUE_OUT_OF_RANGE_REASON. After the
		// negation rules above, which answer `-pow>9999999999` and `-pow=9999999999` first.
		if (isOutOfRange(rawValue)) return { keep: false, reason: VALUE_OUT_OF_RANGE_REASON };
		// A column compared with ITSELF, under any spelling of it and any operator — see
		// SAME_SIDES_REASON. After the value check, so a value that is not a column never gets
		// here, and after the negation rules, which answer `-pow=pow` and `-pow>pow` first.
		const column = numericColumnOf(keyword);
		if (column !== null && column === numericColumnOf(loweredValue)) {
			return { keep: false, reason: SAME_SIDES_REASON };
		}
	}
	// ...and `cn` / `number` take the same sentence under every operator, `:` included, though under
	// `:` they read the string collector number. The negated forms were not measured and are left.
	if (STRING_NUMBER_KEYWORDS.has(keyword) && !negated && isOutOfRange(rawValue)) {
		return { keep: false, reason: VALUE_OUT_OF_RANGE_REASON };
	}
	// `year:0000` and `year:9999` are 404 and `year>=0` is the anchor: a year no printing is dated
	// in, which the parser refuses to read — see honoredDateTerm. After the negation rules, which
	// answer `-year:1990` and `-year>=0` first.
	if (keyword === "year" && /^\d+$/.test(rawValue)) {
		const outOfRange = yearOutOfRangeTerm(op, Number(rawValue));
		if (outOfRange !== null) return { keep: true, text: outOfRange };
	}

	if (FORMAT_KEYWORDS.has(keyword) && !SCRYFALL_FORMATS.has(loweredValue)) {
		return { keep: false, reason: `Unknown game format \u201c${loweredValue}\u201d` };
	}
	if (LANGUAGE_KEYWORDS.has(keyword) && !SCRYFALL_LANGUAGES.has(loweredValue)) {
		return { keep: false, reason: `Unknown language \`${loweredValue}\`` };
	}
	// `st:` and `frame:` read a closed vocabulary — see SCRYFALL_SET_TYPES and SCRYFALL_FRAMES. A
	// value outside it is ignored with its own sentence; one inside it under another spelling is
	// respelled to the one the parser reads. Equality only reaches here.
	if (SET_TYPE_KEYWORDS.has(keyword) || FRAME_KEYWORDS.has(keyword)) {
		const setType = SET_TYPE_KEYWORDS.has(keyword);
		const unknown = (shown: string) => (setType ? `Unknown set type “${shown}”` : `Unknown frame “${shown}”`);
		if (isRegexLiteral(rawValue)) {
			// Only a plain pattern gets this far (`regexKeywordReason`), and it keeps answering — as
			// `is:/promo/` does — only when it spells a value exactly. Anything else is the
			// sentence Scryfall gives every pattern here.
			const word = regexPlainLiteral(rawValue.slice(1, -1))?.toLowerCase() ?? "";
			const spelled = setType ? SCRYFALL_SET_TYPES.get(word.replaceAll("_", "")) : SCRYFALL_FRAMES.get(word);
			if (spelled !== word) {
				return {
					keep: false,
					reason:
						keyword === SET_TYPE_VALUE_KEYWORD
							? unknown(rawValue.toLowerCase())
							: `Unknown regular expression keyword “${keyword}”.`,
				};
			}
		} else {
			const spelled = setType
				? SCRYFALL_SET_TYPES.get(loweredValue.replace(SET_TYPE_SEPARATORS_RE, ""))
				: SCRYFALL_FRAMES.get(loweredValue);
			if (spelled === undefined) return { keep: false, reason: unknown(loweredValue) };
			if (spelled !== loweredValue) return { keep: true, text: `${match[1]}${match[2]}${op}${spelled}` };
		}
	}
	// EVERY operator, not only `:`/`=`. Rarity is an ordered enum, so `r>rare` is a comparison
	// Scryfall really performs — and it checks the value under a comparison exactly as it does
	// under equality. Measured, anchor `e:khm t:creature` = 151: `r:notarare`, `r=notarare`,
	// `r>notarare`, `r>=notarare`, `r<notarare` and `r!=notarare` are all 151 carrying
	// `Unknown rarity “notarare.”`, and `rarity>=0` is 151 carrying `Unknown rarity “0.”`. With an
	// `equality` guard here this port answered the four comparisons `400 Failed to parse query`
	// instead: nothing removed the term, and the parser's rarity value parser rejects a word that
	// is not a rarity.
	if (RARITY_KEYWORDS.has(keyword) && !SCRYFALL_RARITIES.has(loweredValue)) {
		// The period INSIDE the quotes is Scryfall's, not a typo here: the live body reads
		// `Unknown rarity “notarare.”`.
		return { keep: false, reason: `Unknown rarity \u201c${loweredValue}.\u201d` };
	}
	// `mana:/…/` IS a regex and `mana>=/…/` is not, so the delimiters are a VALUE error on every
	// operator but `:` and `=`. Measured on api.scryfall.com 2026-08-28: `mana=/{r}/` is 6,853
	// (honoured, the pattern compiled against the cost string) while `mana!=/^tap/` comes back
	// `Invalid expression “mana!=/^tap/” was ignored. Unknown mana symbols “/^TAP/”.` and
	// `mana>=/{r}/` `Unknown mana symbols “//”.` — the `{R}` accepted and the two delimiters left
	// over, which is what makes the second echo the two characters rather than the whole value.
	// Scoped to the slash form: everything else this column rejects is a pre-existing gap this
	// does not widen.
	if (MANA_COST_KEYWORDS.has(keyword) && !equality && isRegexLiteral(rawValue)) {
		const leftover = [...stripRegexDelimiters(rawValue)].every((c) => MANA_COST_VALUE_CHARS.has(c)) ? "//" : rawValue;
		return { keep: false, reason: unknownManaSymbols(leftover) };
	}
	// `mana:{q}` — what the mana reader leaves unread is the sentence, under every operator and
	// in both polarities; and a hybrid written in the other order is respelled. See readManaSymbols.
	if (MANA_COST_KEYWORDS.has(keyword) && !isRegexLiteral(rawValue)) {
		const read = readManaSymbols(value);
		if (read !== null && read.leftover !== "") return { keep: false, reason: unknownManaSymbols(read.leftover) };
		if (read !== null && read.respelled.toLowerCase() !== value.toLowerCase()) {
			return { keep: true, text: `${match[1]}${match[2]}${op}${read.respelled}` };
		}
	}
	// Devotion checks its value under every operator and in both polarities — see devotionReason.
	if (DEVOTION_KEYWORDS.has(keyword)) {
		const reason = devotionReason(value);
		if (reason !== null) return { keep: false, reason };
	}
	// `game:` checks its value under `:`/`=` and is HONORED-and-empty under a comparison, which the
	// COMPARABLE_KEYWORDS rule above already answers (`game>=paper e:khm t:god` is 404 there where
	// `game=paper e:khm t:god` is 12). Measured 2026-09-03: `game:nonsense` comes back
	// ``Unknown game `nonsense` `` — backticks, like `lang:`, not the curly quotes `f:`/`r:` use —
	// and `game:PROMO` names `promo`, echoing the expression lower-cased too. `astral` and `sega`
	// are in the vocabulary and simply match nothing in the default corpus; see GAME_IS_TAGS.
	if (GAME_KEYWORDS.has(keyword) && !GAME_IS_TAGS.has(loweredValue)) {
		return { keep: false, reason: `Unknown game \`${loweredValue}\`` };
	}
	// `block:` / `b:` become the sets of the block, and open extras — see BLOCK_KEYWORDS. Equality
	// only reaches here, as for `stamp:` below.
	if (BLOCK_KEYWORDS.has(keyword)) {
		return { keep: true, text: `${match[1]}${blockTerm(value)}`, include: ["extras"] };
	}
	// `lore:""` is the unknown-keyword sentence, minus included — see LORE_KEYWORDS. A value that
	// is only spaces is a value.
	if (LORE_KEYWORDS.has(keyword) && value === "") {
		return { keep: false, reason: `Unknown keyword \u201c${negated ? "-" : ""}${keyword}\u201d.` };
	}
	// `cheapest:` checks its value in both polarities, and its negated term is a term of its own
	// — see CHEAPEST_KEYWORDS. Equality only reaches here, as for `stamp:` below.
	if (CHEAPEST_KEYWORDS.has(keyword)) {
		if (value === "") {
			return { keep: false, reason: `Unknown keyword \u201c${negated ? "-" : ""}${keyword}\u201d.` };
		}
		const currency = CHEAPEST_CURRENCIES.get(loweredValue);
		if (currency === undefined) return { keep: false, reason: `Unknown currency \u201c${loweredValue}\u201d` };
		return { keep: true, text: `${match[2]}${op}${negated ? "not_" : ""}${currency}` };
	}
	// `stamp:` checks its value in both polarities — see STAMP_KEYWORDS. Equality only reaches
	// here: a comparison was answered by the COMPARABLE_KEYWORDS rule above.
	if (STAMP_KEYWORDS.has(keyword) && !SECURITY_STAMPS.has(loweredValue)) {
		return { keep: false, reason: `Unknown security stamp “${loweredValue}”` };
	}
	// The external ids: the value becomes the integer it leads with — see EXTERNAL_ID_KEYWORDS.
	{
		const externalId = EXTERNAL_ID_KEYWORDS.get(keyword);
		if (externalId !== undefined) {
			const digits = LEADING_DIGITS_RE.exec(value)?.[0];
			if (digits === undefined && externalId.validates) return { keep: false, reason: TCGPLAYER_ID_REASON };
			return { keep: true, text: `${match[1]}${match[2]}${op}${digits ?? "0"}` };
		}
	}
	// The `game_*` tags under this port's own spelling — see NOT_SCRYFALL_IS_VALUES.
	if (IS_KEYWORDS.has(keyword) && NOT_SCRYFALL_IS_VALUES.has(loweredValue)) {
		return { keep: false, reason: `Checking if cards are \u201c${loweredValue}\u201d is not supported` };
	}
	// An `is:` value Scryfall spells with separators, or answers under a word this port has
	// another term for — see SCRYFALL_IS_SYNONYMS. A bare word only: a quoted value is not an
	// `is:` value on Scryfall at all.
	if (IS_KEYWORDS.has(keyword) && rawValue === value && IS_VALUE_WORD_RE.test(value)) {
		const respelled = scryfallIsTerm(keyword, negated, loweredValue);
		if (respelled !== null) return { keep: true, text: respelled };
	}
	// ...and a value neither side answers, or one that is not an `is:` value at all — see
	// unknownIsValueReason.
	if (IS_KEYWORDS.has(keyword)) {
		const reason = unknownIsValueReason(keyword, negated, rawValue, value, loweredValue);
		if (reason !== null) return { keep: false, reason };
	}
	if (UUID_KEYWORDS.has(keyword) && !UUID_V4_RE.test(value)) {
		return { keep: false, reason: "You must provide a valid v4 UUID." };
	}
	if (COLOR_KEYWORDS.has(keyword)) {
		const reason = colorReason(value, keyword);
		if (reason !== null) return { keep: false, reason };
	}

	// A regex literal that will not compile. Validated here so the answer is Scryfall's 400 rather
	// than the engine's 503 — `routes.ts` also maps a filter-build failure to a bad request, for
	// the patterns this check accepts and Rust's `regex` crate does not.
	if (isRegexLiteral(rawValue)) {
		const pattern = rawValue.slice(1, -1);
		// The refusals Scryfall decides on the pattern's text come first — `o:/(((a/` is "nested",
		// not "not balanced". Not on the colour columns, where the slashes are value characters and
		// no regex is ever read (`c:/w/` is `c:w`); `mana:/…/` is a real regex and takes them.
		const readsRegex = !REGEX_VALUE_FIRST_KEYWORDS.has(keyword) || MANA_COST_KEYWORDS.has(keyword);
		if (readsRegex) {
			const textReason = scryfallRegexTextReason(pattern);
			if (textReason !== null) return { keep: false, reason: textReason };
		}
		if (readsRegex) {
			const syntaxReason = postgresSyntaxReason(pattern);
			if (syntaxReason !== null) return { keep: false, reason: syntaxReason };
		}
		try {
			new RegExp(toJsValidationPattern(pattern));
		} catch {
			return { keep: false, reason: regexReason(pattern) };
		}
		if (readsRegex) {
			const withoutBackreferences = neutralizeBackreferences(pattern);
			if (overEngineBudget(keyword, withoutBackreferences)) return { keep: false, reason: TOO_COMPLEX_REASON };
			if (withoutBackreferences !== pattern) {
				return { keep: true, text: `${match[1]}${match[2]}${op}/${withoutBackreferences}/` };
			}
		}
	}

	return { keep: true, text: term };
}

/**
 * Apply the policy to one nesting level, recursing into groups.
 *
 * Returns null when nothing at this level survived — which is what makes a group whose every arm
 * was dropped disappear along with its parentheses, the behaviour `(subtype:elf or
 * subtype:goblin) e:war` pins.
 */
interface PolicyScan {
	readonly warnings: string[];
	readonly include: IncludeOptions;
	readonly directives: DirectiveFound[];
}

function policyLevel(source: string, scan: PolicyScan): string | null {
	const pieces = scanPieces(source);
	if (pieces.length === 0) return null;
	const kept: Piece[] = [];
	// Tracks REWRITES as well as drops, because a numeric comparison whose value is not a number is
	// replaced rather than removed: returning `source` on the strength of "nothing was dropped"
	// silently threw that substitution away.
	let changed = false;
	for (const piece of pieces) {
		if (piece.kind === "connector") {
			kept.push(piece);
			continue;
		}
		if (piece.kind === "group") {
			const inner = policyLevel(piece.inner as string, scan);
			if (inner === null) {
				changed = true;
				continue;
			}
			if (inner !== piece.inner) changed = true;
			kept.push({ ...piece, text: `${piece.prefix ?? ""}(${inner})` });
			continue;
		}
		// `pow=1a` is two terms — see numericValueSplit. Each is answered as the term it is.
		const split = numericValueSplit(piece.text);
		if (split !== null) {
			changed = true;
			const inner = policyLevel(split, scan);
			if (inner !== null) kept.push({ kind: "leaf", text: inner });
			continue;
		}
		const verdict = classifyLeaf(piece.text);
		if (verdict.keep) {
			for (const option of verdict.include ?? []) scan.include[option] = true;
			if (verdict.text !== piece.text) changed = true;
			kept.push({ ...piece, text: verdict.text });
			continue;
		}
		changed = true;
		if (verdict.reason === null) {
			for (const option of verdict.include) scan.include[option] = true;
			if (verdict.warning !== null) scan.warnings.push(verdict.warning);
			if (verdict.directive !== undefined) scan.directives.push(verdict.directive);
			continue;
		}
		scan.warnings.push(ignoredWarning(piece.text, verdict.reason));
	}
	if (!changed) return source;

	// A connector left with nothing on one side is not a term; Scryfall tolerates `t:elf or` and
	// so does this, by removing what the drop orphaned rather than by handing the parser a
	// fragment it would reject.
	const cleaned: Piece[] = [];
	for (const piece of kept) {
		if (piece.kind === "connector") {
			const previous = cleaned[cleaned.length - 1];
			if (previous === undefined || previous.kind === "connector") continue;
		}
		cleaned.push(piece);
	}
	while (cleaned.length > 0 && (cleaned[cleaned.length - 1] as Piece).kind === "connector") cleaned.pop();
	if (cleaned.length === 0) return null;
	return cleaned.map((p) => p.text).join(" ");
}

/**
 * Fold the typographic quotes, then drop every term Scryfall would ignore.
 *
 * `allIgnored` is the 400 case, and it is deliberately not the same as "empty query": Scryfall
 * answers an empty `q` with "You didn‘t enter anything to search for." and a query whose every
 * term was unusable with "All of your terms were ignored." — two different sentences for two
 * different mistakes.
 */
export function scryfallTermPolicy(rawQuery: string): TermPolicyResult {
	const folded = foldSmartQuotes(rawQuery);
	const scan: PolicyScan = {
		warnings: [],
		include: { extras: false, variations: false, multilingual: false },
		directives: [],
	};
	const { include, directives } = scan;
	if (unbalancedParens(folded)) {
		return { query: folded, warnings: [], allIgnored: false, unclosedParens: true, include, directives };
	}
	const query = policyLevel(folded, scan);
	const warnings = scan.warnings;
	if (query !== null && query.trim() !== "") {
		return { query, warnings, allIgnored: false, unclosedParens: false, include, directives };
	}
	// Nothing survived, and now the only way that happens is a term Scryfall refused: a dangling
	// operator is REWRITTEN rather than dropped (danglingOperatorTerm), so `q=t:` no longer empties
	// the query and no longer needs an always-true leaf standing in for it.
	return { query: folded, warnings, allIgnored: true, unclosedParens: false, include, directives };
}
