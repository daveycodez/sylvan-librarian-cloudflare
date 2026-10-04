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
import { patternExceedsBudget, toJsValidationPattern } from "../../parser/regex-budget";
import { isKnownSetCode } from "../../parser/set-dates.gen";
import { isWordCont, type Token, TT, tokenize } from "../../parser/tokenizer";
import { DIRECTIVE_TABLES } from "../enums";

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

function unknownIncludeWarning(rawValue: string): string {
	const chars = [...rawValue.toLowerCase()];
	const echoed =
		chars.length > DISPLAY_VALUE_ECHO_LIMIT
			? `${chars.slice(0, DISPLAY_VALUE_ECHO_LIMIT - 3).join("")}...`
			: chars.join("");
	return `Unknown direction choice \u201c${echoed}\u201d was ignored`;
}

/** The keywords Scryfall reads as display options: this parser's directives, and `include`. */
function isDisplayKeyword(keyword: string): boolean {
	return DIRECTIVE_TABLES.has(keyword) || keyword === INCLUDE_KEYWORD;
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
	"stamp",
	"cheapest",
	// `include` LEFT THIS TABLE on 2026-10-03: `include:` is a display option this surface now
	// reads (see INCLUDE_VALUES), and under `=` it is a keyword Scryfall itself does not know —
	// `include=extras t:goblin` is 561 carrying `Unknown keyword “include”.`
	"direct",
]);

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
]);

/** The mana-value spellings, whose negated equality earns the value sentence instead. */
const MANA_VALUE_KEYWORDS: ReadonlySet<string> = new Set(["cmc", "mv", "manavalue"]);

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
 * `edhrec`, `artists`, `paperprints` and `papersets` are numeric columns Scryfall compares
 * (`edhrec>=5000 e:khm t:creature` = 112) and this parser has no spelling for. They are not in
 * SCRYFALL_ONLY_KEYWORDS either, so they were already being reported as unknown keywords; under
 * this rule they answer the 404 an unknown keyword answers instead of the 151 the ignore
 * machinery answered. Both are wrong against Scryfall's count, and putting them in the set would
 * be worse — a term kept for a keyword the parser cannot lex is a 400.
 *
 * `pt` WAS THE FIFTH NAME ON THAT LIST until 2026-10-03, and is the worked example of what the
 * list costs: `pt<6` answered this rule's 404 against Scryfall's 10,818, and `pt=2 t:creature`
 * answered all 18,760 creatures with an unknown-keyword warning against Scryfall's 2,127. It has
 * a column now (db-info's `power_plus_toughness`, both spellings), so it is in the set.
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
	if (textOnly && regexPlainLiteral(rawValue.slice(1, -1)) !== null) return null;
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
 * ─── THE ONE SHAPE THIS DELIBERATELY LETS THROUGH ────────────────────────────────────────────
 *
 * `date:2021-13` is a THIRD answer there — `Invalid date “2021-13”`, without the set-code half of
 * the sentence, because the shape parsed and only the month was out of range. This port answers
 * `400 Failed to parse query` for it, which is the pre-existing gap `parser.parseDateValue`
 * records, and the shape test above keeps it exactly that: a value that LOOKS like a date is not
 * this function's business, so nothing here changes for it. `date:2021-02-30` is a fourth answer
 * again (404, honored and matching nothing) and is left alone for the same reason.
 *
 * A regex literal is skipped so `date:/199/` keeps its own sentence — `Unknown regular expression
 * keyword “date”.` from `regexKeywordReason`, which runs later and would never be reached.
 */
function dateValueReason(keyword: string, rawValue: string): string | null {
	if (!DATE_KEYWORDS.has(keyword) || isRegexLiteral(rawValue)) return null;
	const value = unquote(rawValue).toLowerCase();
	if (DATE_SHAPE_RE.test(value) || isKnownSetCode(value)) return null;
	return `Invalid date or unknown set code “${value}”`;
}

/** Keyword groups, by the alias spellings this parser and Scryfall share. */
const FORMAT_KEYWORDS: ReadonlySet<string> = new Set(["f", "format", "legal", "banned", "restricted"]);
const LANGUAGE_KEYWORDS: ReadonlySet<string> = new Set(["lang", "language"]);
const RARITY_KEYWORDS: ReadonlySet<string> = new Set(["r", "rarity"]);
const ORACLE_ID_KEYWORDS: ReadonlySet<string> = new Set(["oracleid", "oracle_id"]);
const GAME_KEYWORDS: ReadonlySet<string> = new Set(["game"]);

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
	...ORACLE_ID_KEYWORDS,
	...COLOR_KEYWORDS,
	...GAME_KEYWORDS,
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
 * Onigmo's wording for the malformations a pasted regex actually has.
 *
 * Scryfall compiles the pattern in Ruby and reports its engine's message, so the four classes
 * below were read off api.scryfall.com rather than translated from V8's:
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
		if (c === '"' || c === "'" || c === "/") {
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
			if (c === '"' || c === "'" || c === "/") {
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
	if (/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(v)) return true;
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
	"x",
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

/** The verdict on one leaf term: keep it (possibly rewritten), or drop it with Scryfall's reason. */
type LeafVerdict =
	| { keep: true; text: string }
	| { keep: false; reason: string }
	/** A display option: removed from the query, never a term, with its own warning if any. */
	| { keep: false; reason: null; include: readonly (keyof IncludeOptions)[]; warning: string | null };

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

	// `include:` under `:` is a display option, in either polarity — see INCLUDE_VALUES. Under `=`
	// it falls through to the unknown-keyword rule, which is what Scryfall answers.
	if (keyword === INCLUDE_KEYWORD && op === ":") {
		const switches = INCLUDE_VALUES.get(rawValue.toLowerCase());
		return switches === undefined
			? { keep: false, reason: null, include: [], warning: unknownIncludeWarning(rawValue) }
			: { keep: false, reason: null, include: switches, warning: null };
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
		// A column compared with ITSELF, under any spelling of it and any operator — see
		// SAME_SIDES_REASON. After the value check, so a value that is not a column never gets
		// here, and after the negation rules, which answer `-pow=pow` and `-pow>pow` first.
		const column = numericColumnOf(keyword);
		if (column !== null && column === numericColumnOf(loweredValue)) {
			return { keep: false, reason: SAME_SIDES_REASON };
		}
	}

	if (FORMAT_KEYWORDS.has(keyword) && !SCRYFALL_FORMATS.has(loweredValue)) {
		return { keep: false, reason: `Unknown game format \u201c${loweredValue}\u201d` };
	}
	if (LANGUAGE_KEYWORDS.has(keyword) && !SCRYFALL_LANGUAGES.has(loweredValue)) {
		return { keep: false, reason: `Unknown language \`${loweredValue}\`` };
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
	// The `game_*` tags under this port's own spelling — see NOT_SCRYFALL_IS_VALUES.
	if (IS_KEYWORDS.has(keyword) && NOT_SCRYFALL_IS_VALUES.has(loweredValue)) {
		return { keep: false, reason: `Checking if cards are \u201c${loweredValue}\u201d is not supported` };
	}
	if (ORACLE_ID_KEYWORDS.has(keyword) && !UUID_V4_RE.test(value)) {
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
		const verdict = classifyLeaf(piece.text);
		if (verdict.keep) {
			if (verdict.text !== piece.text) changed = true;
			kept.push({ ...piece, text: verdict.text });
			continue;
		}
		changed = true;
		if (verdict.reason === null) {
			for (const option of verdict.include) scan.include[option] = true;
			if (verdict.warning !== null) scan.warnings.push(verdict.warning);
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
	const scan: PolicyScan = { warnings: [], include: { extras: false, variations: false, multilingual: false } };
	const { include } = scan;
	if (unbalancedParens(folded)) {
		return { query: folded, warnings: [], allIgnored: false, unclosedParens: true, include };
	}
	const query = policyLevel(folded, scan);
	const warnings = scan.warnings;
	if (query !== null && query.trim() !== "") {
		return { query, warnings, allIgnored: false, unclosedParens: false, include };
	}
	// Nothing survived, and now the only way that happens is a term Scryfall refused: a dangling
	// operator is REWRITTEN rather than dropped (danglingOperatorTerm), so `q=t:` no longer empties
	// the query and no longer needs an always-true leaf standing in for it.
	return { query: folded, warnings, allIgnored: true, unclosedParens: false, include };
}
