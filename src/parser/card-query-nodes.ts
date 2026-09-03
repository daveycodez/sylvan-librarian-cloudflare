/**
 * Port of api/parsing/card_query_nodes.py — card-specific AST nodes.
 *
 * Only the engine-wire serialization surface (kwargs / to_json) is ported; the
 * SQL-generation paths have no effect on the wire format. Serialization-time
 * validation failures (invalid colors, unknown rarities) throw ParseError with
 * the exact messages Python's ValueErrors carry.
 */

import {
	ALIAS_TO_FIELD_INFOS,
	CARD_SUPERTYPES,
	CARD_TYPES,
	COLOR_ALIAS_TO_CODES,
	COLOR_CODE_TO_NAME,
	COLOR_COUNT_NAMES,
	COLOR_SPREAD_COUNT_NAMES,
	COLUMN_SCOPED_COUNT_NAMES,
	type FieldInfo,
	FieldType,
	FORMAT_CODE_TO_NAME,
	type ParserClass,
	ParserClass as PC,
} from "./db-info";
import { ParseError } from "./errors";
import {
	BinaryOperatorNode,
	type FilterTree,
	type FilterValue,
	NumericValueNode,
	nodeToJson,
	QueryNode,
	RegexValueNode,
	StringValueNode,
	type ValueNode,
} from "./nodes";
import { collateName, foldAccents, PyNumber, pyLower, pyStrip, pyStrTitle } from "./pystr";
import { artTagAliases, oracleTagAliases } from "./tag-aliases.gen";
import { titlecase } from "./titlecase";

export { foldAccents };

// Rarity ordering for comparison operations.
const RARITY_TO_NUMBER: ReadonlyMap<string, number> = new Map([
	["common", 0],
	["c", 0],
	["uncommon", 1],
	["u", 1],
	["rare", 2],
	["r", 2],
	["special", 3],
	["s", 3],
	["mythic", 4],
	["m", 4],
	["bonus", 5],
	["b", 5],
]);

// Python renders the valid list as str(tuple(RARITY_TO_NUMBER.keys())).
const VALID_RARITIES_STR = `(${[...RARITY_TO_NUMBER.keys()].map((k) => `'${k}'`).join(", ")})`;

/** Convert rarity string to numeric value for comparison (get_rarity_number). */
export function getRarityNumber(rarity: string): number {
	const rarityLower = pyStrip(pyLower(rarity));
	const intVal = RARITY_TO_NUMBER.get(rarityLower);
	if (intVal === undefined) {
		throw new ParseError(`Unknown rarity: ${rarity}. Valid rarities are: ${VALID_RARITIES_STR}`);
	}
	return intVal;
}

/** Card-specific attribute node with field mapping. */
export class CardAttributeNode extends QueryNode {
	override readonly nodeType: string = "CardAttributeNode";

	/** The user-facing alias, preserved before mapping (e.g. "t", "frame"). */
	readonly originalAttribute: string;
	readonly matchedParserClass: ParserClass;
	readonly fieldInfos: readonly FieldInfo[];
	/** The mapped db column name (AttributeNode.attribute_name in Python). */
	readonly attributeName: string;

	constructor(attributeName: string, matchedParserClass: ParserClass) {
		super();
		this.originalAttribute = pyLower(attributeName);
		this.matchedParserClass = matchedParserClass;
		const aliasFieldInfos = ALIAS_TO_FIELD_INFOS.get(pyLower(attributeName)) ?? [];
		this.fieldInfos = aliasFieldInfos.filter((f) => f.parserClass === matchedParserClass);
		// Python: `(field_info,) = self.field_infos` — must match exactly one.
		if (this.fieldInfos.length !== 1) {
			throw new ParseError(
				this.fieldInfos.length === 0
					? "not enough values to unpack (expected 1, got 0)"
					: "too many values to unpack (expected 1)",
			);
		}
		this.attributeName = pyLower((this.fieldInfos[0] as FieldInfo).dbColumnName);
	}

	override kwargs(): Record<string, FilterValue> {
		return { attribute_name: this.attributeName, original_attribute: this.originalAttribute };
	}
}

/**
 * Convert color string to the ordered color-key list for the wire format
 * (get_colors_comparison_object(...).keys(), which preserves first-occurrence
 * order because Python dicts are insertion-ordered).
 *
 * `val` is either a letter string ('WUBRG') or one of the names in COLOR_ALIAS_TO_CODES —
 * 'red', 'azorius', 'yore-tiller' — which is the vocabulary Scryfall itself accepts.
 */
export function getColorsComparisonKeys(val: string, attr = "card_colors"): string[] {
	const colorlessIsValue = attr === "produced_mana";
	const codeSet = new Set(COLOR_CODE_TO_NAME.keys());
	// A color NAME spells a set of letters ('azorius' -> 'wu', 'brown' -> 'c', 'colorless' -> 'c');
	// a letter string already is one. Expanding the name FIRST leaves a single code path, so
	// `c:azorius` and `c:wu` serialize to the identical rhs and cannot drift apart, and the
	// colorless-is-a-value distinction below is stated once instead of once per spelling.
	const codes = COLOR_ALIAS_TO_CODES.get(val) ?? val;
	const chars = [...codes];
	if (codes !== "" && chars.every((c) => codeSet.has(c))) {
		const keys: string[] = [];
		for (const c of chars) {
			if (!colorlessIsValue && c === "c") continue;
			const upper = c.toUpperCase();
			if (!keys.includes(upper)) keys.push(upper);
		}
		return keys;
	}
	throw new ParseError(`Invalid color string: ${val}`);
}

/** get_frame_data_comparison_object(...).keys() */
export function getFrameDataComparisonKeys(val: string): string[] {
	return [pyStrTitle(pyStrip(val))];
}

/** get_keywords_comparison_object(...).keys() */
export function getKeywordsComparisonKeys(val: string): string[] {
	// Keywords are stored in lowercase (see the builder's preprocess_card port in
	// engine/builder/src/transform.rs) — Scryfall's own spelling is inconsistently
	// cased ("First strike", "Doctor's companion"), and lowercase is the same
	// normalization the oracle/art tag collections already use on both sides.
	return [pyLower(pyStrip(val))];
}

/**
 * Normalize a written tag spelling to the slug form oracle and art tags are stored under.
 *
 * Every slug in both tag dumps matches `[a-z0-9]+(-[a-z0-9]+)*`, so folding runs of
 * non-alphanumerics to a single hyphen can only turn a miss into the hit the searcher meant.
 * Scryfall accepts the spaced spelling of a slug the same way — `art:"right facing"` and
 * `art:right-facing` both find the `right-facing` tag — and this is also what makes aliases
 * written with spaces reachable, since the tag import stores those slugified too.
 *
 * The character class is `[^a-z0-9]` and not `\W`: `\W` keeps underscores, and an underscore is
 * not a slug character.
 */
export function slugifyTag(val: string): string {
	// Python's str.strip("-") removes every leading and trailing hyphen, not just one.
	return pyLower(pyStrip(val))
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Resolve a slugified tag through a dump's alias map, or return it unchanged.
 *
 * PORT-LOCAL, and the half that makes the store smaller. Upstream #914 resolves aliases at import
 * by stamping each one as an extra key beside the slug and every ancestor, so query time stays an
 * exact match. Here that costs 6,252,880 bytes of archive — 1,024,204 duplicate entries, each
 * costing 2 bytes forward plus a 4-byte inverted TagIndex posting — which crossed the 25MB KV
 * chunk grid from 3 values to 4 and put a fourth serialized read on every cold store load. So the
 * mapping is carried once (~68KB, tag-aliases.gen.ts) and folded in here instead.
 *
 * The substitution is exact, not approximate: the builder attaches alias `a` to slug `s` under
 * precisely the condition it attaches `s` itself, so `art:flames` and `art:fire` were always the
 * same row set. An unknown value passes through untouched, which is what keeps a plain slug — and
 * a typo — behaving exactly as before.
 */
function resolveTagAlias(slug: string, aliases: ReadonlyMap<string, string>): string {
	return aliases.get(slug) ?? slug;
}

/** get_oracle_tags_comparison_object(...).keys() */
export function getOracleTagsComparisonKeys(val: string): string[] {
	return [resolveTagAlias(slugifyTag(val), oracleTagAliases())];
}

/** get_art_tags_comparison_object(...).keys() */
export function getArtTagsComparisonKeys(val: string): string[] {
	return [resolveTagAlias(slugifyTag(val), artTagAliases())];
}

/** get_is_tags_comparison_object(...).keys() */
export function getIsTagsComparisonKeys(val: string): string[] {
	return [pyLower(pyStrip(val))];
}

/** get_legality_comparison_object(...).keys() — [normalized format name]. */
export function getLegalityComparisonKeys(val: string, attr: string): string[] {
	let formatName = pyLower(pyStrip(val));
	formatName = FORMAT_CODE_TO_NAME.get(formatName) ?? formatName;
	if (attr === "format" || attr === "f" || attr === "legal" || attr === "banned" || attr === "restricted") {
		return [formatName];
	}
	throw new ParseError(`Unknown legality attribute: ${attr}`);
}

/**
 * Exact card name search (the ! prefix syntax).
 *
 * The value is COLLATED — lowercased, diacritics folded, every non-alphanumeric character
 * removed — because that is the name Scryfall compares `!` against. Measured on
 * api.scryfall.com 2026-08-16, all four of these answer the same single card:
 *
 *   !"Lim-Dûl's Vault"   !"lim-dul's vault"   !"limduls vault"   !"Lim-Dul's Vault"
 *
 * and `!"eowyn, lady of rohan"` answers "Éowyn, Lady of Rohan". Comparing the literal lowercase
 * name — what this emitted before — answered only the first of those, so typing a card's name
 * without its accent or its punctuation found nothing.
 */
export class ExactNameNode extends QueryNode {
	override readonly nodeType: string = "ExactNameNode";

	constructor(readonly value: string) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return { value: collateName(foldAccents(pyLower(this.value))) };
	}
}

function rhsStringValue(rhs: QueryNode): string {
	const value = (rhs as ValueNode).value;
	if (typeof value !== "string") {
		// Unreachable through the hand parser: every value parser that feeds a
		// string-typed field produces a string-valued node.
		throw new ParseError(`'${typeof value}' object has no attribute 'strip'`);
	}
	return value;
}

/** Card-specific binary operator node with the wire-format kwargs specialization. */
/**
 * What a colour-COUNT name (`c:m`, `id:gold`) means, per operator, as the (operator, count) pair
 * the numeric colour-count comparison is built from. Measured; the evidence and the two surprises
 * in it are written out at db-info's COLOR_COUNT_NAMES.
 */
const COLOR_COUNT_BY_OPERATOR: ReadonlyMap<string, readonly [string, number]> = new Map([
	[":", [">=", 2]],
	["=", [">=", 2]],
	[">", [">=", 2]],
	[">=", [">=", 2]],
	["<", ["<", 2]],
	["!=", ["<", 2]],
	["<=", [">=", 0]], // a tautology, spelled as a count so it stays one leaf
] as [string, readonly [string, number]][]);

/**
 * The same table for produced_mana, intersected with "produces at least one value". A card that
 * makes no mana at all is not a producer of anything, and Scryfall keeps it out of every one of
 * these: `produces<m` = `produces!=m` = 1,143 = `produces=1`, NOT `produces<2` (32,139), which
 * sweeps in the 30,996 cards that produce nothing; and `produces<=m` = 2,603 = `produces>=1`
 * rather than every card. The extra conjunct collapses into the count itself, so this stays one
 * (operator → operator, count) table and no AND node is needed.
 */
const PRODUCED_COUNT_BY_OPERATOR: ReadonlyMap<string, readonly [string, number]> = new Map([
	[":", [">=", 2]],
	["=", [">=", 2]],
	[">", [">=", 2]],
	[">=", [">=", 2]],
	["<", ["=", 1]],
	["!=", ["=", 1]],
	["<=", [">=", 1]],
] as [string, readonly [string, number]][]);

/**
 * `produces:any` — "produces anything at all" — per operator. Measured; the counts on both bases
 * and the reason `any` is produced_mana-only are written out at db-info's COLUMN_SCOPED_COUNT_NAMES.
 *
 * The `!=` row is what makes this a THIRD table rather than a reuse of the two above: `any` puts
 * `!=` with `:` on the high side (2,603 = `produces>=1`), where `m` puts it on the low side. And
 * the `<` / `<=` rows are the first in this file to need `=0` and `<=1` — both are ordinary
 * numeric comparisons the engine's ColorCountCmp already answers, so they cost nothing downstream.
 */
const PRODUCED_ANY_BY_OPERATOR: ReadonlyMap<string, readonly [string, number]> = new Map([
	[":", [">=", 1]],
	["=", [">=", 1]],
	[">", [">=", 1]],
	[">=", [">=", 1]],
	["!=", [">=", 1]],
	["<", ["=", 0]],
	["<=", ["<=", 1]],
] as [string, readonly [string, number]][]);

/** The column-scoped count names' tables, keyed by the NAME — the column decides reachability. */
const COLUMN_SCOPED_COUNT_TABLES: ReadonlyMap<string, ReadonlyMap<string, readonly [string, number]>> = new Map([
	["any", PRODUCED_ANY_BY_OPERATOR],
]);

const COLOR_COUNT_ATTRIBUTES: ReadonlySet<string> = new Set(["card_colors", "card_color_identity", "produced_mana"]);

/**
 * `rainbow` / `all` — "the whole spread of this column" — per operator. The operator is carried
 * through VERBATIM here, `:` meaning `=`, which is what the numeric colour-count path already does
 * with `c:2`; the counts and the two rows that refute the letter reading are written out at
 * db-info's COLOR_SPREAD_COUNT_NAMES.
 *
 * Spelled as an explicit seven-row table rather than "pass the operator through" so it reads beside
 * the three tables above and so a row nobody measured cannot appear by accident.
 */
const SPREAD_BY_OPERATOR: ReadonlyMap<string, string> = new Map([
	[":", "="],
	["=", "="],
	["!=", "!="],
	["<", "<"],
	["<=", "<="],
	[">", ">"],
	[">=", ">="],
]);

/** How many values the whole spread of one column comes to — the width `all` spells there. */
const COLOR_COLUMN_WIDTH: ReadonlyMap<string, number> = new Map([
	["card_colors", 5],
	["card_color_identity", 5],
	["produced_mana", 6],
]);

/**
 * Every spelling of colourless that names NO colour on a colour column.
 *
 * Derived from the vocabulary rather than retyped, so it cannot drift: it is exactly the names
 * COLOR_ALIAS_TO_CODES maps to the single code `c`, plus that code itself. On card_colors and
 * card_color_identity `getColorsComparisonKeys` drops the `c`, so all four spellings compare
 * against an EMPTY key list; on produced_mana the `c` survives as a real value and none of this
 * applies.
 */
const COLORLESS_SPELLINGS: ReadonlySet<string> = new Set([
	"c",
	...[...COLOR_ALIAS_TO_CODES].filter(([, codes]) => codes === "c").map(([name]) => name),
]);

/**
 * `c>=colorless` — and only `>=` — per operator, on the two columns where colourless is the empty
 * set.
 *
 * EVERY CARD IS A SUPERSET OF NOTHING, and Scryfall says so. The engine's mask compare has a
 * standing special case that reads an empty mask under `Ge` as exact equality (`bits == 0`), which
 * is right for `:` and wrong for `>=` — the two share CmpOp::Ge downstream and cannot be told
 * apart there, so the `>=` row is separated HERE, as the tautology `>= 0` the `c<=m` row already
 * spells the same way.
 *
 * MEASURED against api.scryfall.com 2026-08-28, corpus-wide (33,599) AND against the
 * `e:khm t:creature` base (151), on both columns and all four spellings:
 *
 *   c>=c = c>=colorless = c>=colourless = c>=brown = 33,599 = every card   (base: 151)
 *   id>=c                                         = 33,599 = every card   (base: 151)
 *
 * and NO OTHER OPERATOR MOVES — each was probed and each already agreed, which is why this table
 * has one row instead of seven:
 *
 *   c:c = c=c = c<=c = 4,300 (base 2)    c<c = 0 (base 0)    c>c = c!=c = 29,396 (base 149)
 *   id:c = id=c = id<=c = 2,959 (base 2)                     id>c = id!=c = 30,640 (base 149)
 *
 * The `c=c` + `c!=c` sum overshoots the corpus by 97 rather than partitioning it, because `colors`
 * is compared per FACE (see card_engine's `face_color_masks`): 97 cards have both a colourless
 * face and a coloured one and answer to both terms. `c>=c`'s 33,599 is the corpus exactly.
 */
const COLORLESS_BY_OPERATOR: ReadonlyMap<string, readonly [string, number]> = new Map([
	[">=", [">=", 0]], // every card is a superset of the empty set — a tautology, spelled as a count
] as [string, readonly [string, number]][]);

/**
 * The (operator → operator, count) pair a colour VALUE lowers through on one column, or undefined
 * when the value compares as letters and no lowering applies.
 *
 * The column-scoped names are asked FIRST and are gated on the column: `any` reaches its table
 * only on produced_mana, so `c:any` falls through to the letter path and stays the error Scryfall's
 * own rejection of the term corresponds to. The colourless spellings are the mirror image — gated
 * OFF produced_mana, where colourless is a producible value rather than the empty set.
 */
function loweredCount(column: string, value: string, operator: string): readonly [string, number] | undefined {
	if (COLUMN_SCOPED_COUNT_NAMES.get(column)?.has(value)) {
		return COLUMN_SCOPED_COUNT_TABLES.get(value)?.get(operator);
	}
	if (COLOR_COUNT_NAMES.has(value)) {
		return (column === "produced_mana" ? PRODUCED_COUNT_BY_OPERATOR : COLOR_COUNT_BY_OPERATOR).get(operator);
	}
	if (COLOR_SPREAD_COUNT_NAMES.has(value)) {
		const op = SPREAD_BY_OPERATOR.get(operator);
		const width = COLOR_COLUMN_WIDTH.get(column);
		// `rainbow` is five values on every column; `all` is the column's own width.
		return op === undefined || width === undefined ? undefined : [op, value === "all" ? width : 5];
	}
	if (column !== "produced_mana" && COLORLESS_SPELLINGS.has(value)) {
		return COLORLESS_BY_OPERATOR.get(operator);
	}
	return undefined;
}

export class CardBinaryOperatorNode extends BinaryOperatorNode {
	override readonly nodeType: string = "CardBinaryOperatorNode";

	/**
	 * Lower a colour-COUNT name to the numeric colour-count comparison before the node exists.
	 *
	 * `c:m` and its five synonyms are a NUMBER of colours, not a set of them, so the value has no
	 * letters to compare and the operator does not survive verbatim either (`c>m` is `c>=2` and
	 * `c!=m` is `c<2`). `produces:any` is the same shape on the one column that accepts it, under
	 * its own table. Doing it in the constructor is what keeps the two upstream parsers from
	 * disagreeing — the hand parser builds this node directly, the pyparsing one via
	 * `to_card_query_ast` — and it means the rest of the pipeline only ever sees the ordinary
	 * numeric node that `c>=2` already produces, on every path: engine JSON and explanation alike.
	 */
	constructor(lhs: QueryNode, operator: string, rhs: QueryNode) {
		if (
			lhs instanceof CardAttributeNode &&
			rhs instanceof StringValueNode &&
			COLOR_COUNT_ATTRIBUTES.has(lhs.attributeName)
		) {
			const lowered = loweredCount(lhs.attributeName, pyLower(pyStrip(rhs.value)), operator);
			if (lowered !== undefined) {
				super(lhs, lowered[0], new NumericValueNode(PyNumber.int(BigInt(lowered[1]))));
				return;
			}
		}
		super(lhs, operator, rhs);
	}

	override kwargs(): Record<string, FilterValue> {
		if (!(this.lhs instanceof CardAttributeNode)) {
			// Arithmetic / non-card-attribute lhs: generic serialization.
			return { lhs: nodeToJson(this.lhs), op: this.operator, rhs: nodeToJson(this.rhs) };
		}

		const fieldInfos = this.lhs.fieldInfos;
		const fieldType = fieldInfos.length > 0 ? (fieldInfos[0] as FieldInfo).fieldType : null;

		if (fieldType === FieldType.JSONB_ARRAY) {
			// A regex is a pattern over the printed type line, not a member of the type/subtype
			// arrays. The title-casing below would turn `t:/goblin|elf/` into the literal subtype
			// "Goblin|Elf" and `t:/^drag/` into "^Drag", neither of which is a type any card has —
			// the query then matches nothing, silently. Scryfall answers both as regexes, so pass
			// the node through and let the engine run it against the type line.
			const attrLower = pyLower(this.lhs.attributeName);
			if (
				this.rhs instanceof RegexValueNode &&
				(attrLower === "card_types" || attrLower === "card_subtypes" || attrLower === "type")
			) {
				return { lhs: this.lhs.toJson(), op: this.operator, rhs: nodeToJson(this.rhs) };
			}
			// Resolve type vs subtype without mutating lhs — build lhs JSON explicitly.
			const rhsVal = pyStrTitle(pyStrip(rhsStringValue(this.rhs)));
			const attr = pyLower(this.lhs.attributeName);
			let resolvedAttr: string;
			if (attr === "card_types" || attr === "card_subtypes" || attr === "type") {
				resolvedAttr = CARD_SUPERTYPES.has(rhsVal) || CARD_TYPES.has(rhsVal) ? "card_types" : "card_subtypes";
			} else {
				resolvedAttr = this.lhs.attributeName;
			}
			const lhsJson: FilterTree = {
				node_type: "CardAttributeNode",
				kwargs: {
					attribute_name: resolvedAttr,
					original_attribute: this.lhs.originalAttribute,
				},
			};
			return { lhs: lhsJson, op: this.operator, rhs: [rhsVal] };
		}

		return { lhs: this.lhs.toJson(), op: this.operator, rhs: this.rhsToJson() };
	}

	/** Compute the JSON-serializable rhs for non-JSONB_ARRAY CardAttributeNode LHS (_rhs_to_json). */
	private rhsToJson(): FilterValue {
		const lhs = this.lhs as CardAttributeNode;
		if (lhs.fieldInfos.length === 0) {
			return nodeToJson(this.rhs);
		}
		const fieldInfo = lhs.fieldInfos[0] as FieldInfo;
		const fieldType = fieldInfo.fieldType;
		const attr = lhs.attributeName;

		if (fieldType === FieldType.JSONB_OBJECT) {
			// Mana cost and devotion: pass raw ManaValueNode for Rust to parse pip counts.
			if (fieldInfo.parserClass === PC.MANA) {
				return nodeToJson(this.rhs);
			}
			// THE SAME BUG THE JSONB_ARRAY BRANCH ABOVE FIXES FOR `t:`, one field type further
			// along, and it was still live on every collection column. The comparison-key readers
			// below take a STRING and slug it into a tag name, so a regex arrived as its raw
			// pattern and came out a literal: `otag:/^remov/` became the tag `rem` and
			// `kw:/f.y/` became the keyword `fy`. Neither tag exists, so both answered 404 — not
			// a decline the caller could see, but a DIFFERENT QUERY, answered confidently.
			// Measured on production 2026-08-28 before this line existed: `kw:/^fly/` 404,
			// `otag:/^remov/` 404, `is:/^prom/` 404, `frame:/^199/` 404.
			//
			// Passing the node through hands the decision to the engine, whose `build_text_filter`
			// has no arm for these columns and says so (`regex not supported on card_keywords`),
			// which the route turns into a 400. A plain-literal regex never reaches here at all —
			// `lowerLiteralRegexes` has already turned `is:/promo/` into `is:promo` — so the
			// superset those answer (6,126 for `is:/promo/`) is untouched.
			//
			// SCOPED TO `:` AND `=`, which is where a regex is a regex — `lowerLiteralRegexes`
			// lowers only `:`, and `=` IS `:` on these columns. `kw>/x/` and `frame<=/x/` keep
			// upstream's slug, both because the fixture corpus pins them (tests/parser/fixtures,
			// which is never patched) and because there is nothing to fix: Scryfall answers a
			// comparison on a non-comparable keyword with the empty set, and so does the compat
			// layer, before either spelling reaches a parser.
			if (this.rhs instanceof RegexValueNode && (this.operator === ":" || this.operator === "=")) {
				return nodeToJson(this.rhs);
			}
			// Numeric color syntax (id>=3 / c=2): pass the raw NumericValueNode so the Rust engine
			// builds a color-count comparison instead of a mask compare.
			if (this.rhs instanceof NumericValueNode) {
				return nodeToJson(this.rhs);
			}
			const val = pyStrip(rhsStringValue(this.rhs));
			if (attr === "card_colors" || attr === "card_color_identity" || attr === "produced_mana") {
				return getColorsComparisonKeys(pyLower(val), attr);
			}
			if (attr === "card_keywords") {
				return getKeywordsComparisonKeys(val);
			}
			if (attr === "card_frame_data") {
				return getFrameDataComparisonKeys(val);
			}
			if (attr === "card_oracle_tags") {
				return getOracleTagsComparisonKeys(val);
			}
			if (attr === "card_art_tags") {
				return getArtTagsComparisonKeys(val);
			}
			if (attr === "card_is_tags") {
				return getIsTagsComparisonKeys(val);
			}
			// `in:` is a collection column like the six above it, and the engine reads a collection
			// value through `rhs.as_array()` — a bare StringValueNode there is an EMPTY value, a
			// leaf matching nothing, answered confidently. Lower-cased because every word
			// `assign_in_tags` interns is, and `in:KHM` / `in:Rare` / `in:JA` are all honored on
			// api.scryfall.com (323 / 10,883 / 30,545, 2026-09-04).
			if (attr === "card_in_tags") {
				return [pyLower(val)];
			}
			if (attr === "card_legalities") {
				return getLegalityComparisonKeys(val, lhs.originalAttribute);
			}
		}

		if (fieldInfo.parserClass === PC.RARITY && this.rhs instanceof StringValueNode) {
			return new NumericValueNode(PyNumber.int(BigInt(getRarityNumber(this.rhs.value)))).toJson();
		}

		if ((attr === "card_name" || attr === "card_artist") && this.rhs instanceof StringValueNode) {
			const value = titlecase(this.rhs.value);
			// A BARE `name:` word is COLLATED — diacritics folded (#649) AND every
			// non-alphanumeric character removed — because that is the string Scryfall matches a
			// bare word against. A QUOTED value (and a plain-literal regex lowered to one) is
			// matched literally instead, so it keeps neither fold; see StringValueNode. Measured
			// on api.scryfall.com 2026-08-16: `name:ft` 1,628 against `name:"ft"` 362,
			// `name:ofthe` 1,109 against `name:"ofthe"` 0, `name:limdul` 8 against
			// `name:"limdul"` 0.
			//
			// `=` IS `:` HERE — it is not a comparison on a string column, it carries no
			// information of its own, and the bare/quoted split survives it INTACT. Measured on
			// api.scryfall.com 2026-08-16: `name=ft` answers `name:ft`'s 1,628 (not `name:"ft"`'s
			// 362), `name="ft"` answers `name:"ft"`'s 362, and `name=limdul` answers
			// `name:limdul`'s 8. Gating on `:` alone sent `name=ft` down the literal path, where
			// the engine compared the whole string for equality and answered nothing at all.
			// `!=` is NOT in this class — it is the empty set on every string column, which
			// `build_text_filter` answers on its own.
			// `a:` gets the SAME split, on the same kind of evidence (api.scryfall.com, 2026-08-16):
			// `a:gawel` answers 10 exactly as `a:gaweł` does, `a:rebecca-guay` answers
			// `a:"rebecca guay"`'s 166, and `a:gu*ay` answers `a:guay`'s 197. An artist could only
			// be found under their own diacritics and punctuation before this.
			//
			// ...but for ARTISTS the split is a distinction the ENGINE then collapses, and this
			// node shape is all that survives of it. Scryfall has no quoted/bare and no `:`/`=`
			// line for artists the way it has for names — measured 2026-08-16, `a:"rebeccaguay"`
			// answers `a:rebecca-guay`'s 399, `a:"gawel"` answers `a:gaweł`'s 23, and `a="rebecca"`
			// answers `a:rebecca`'s 405 — so `bind` routes every artist form through one collated
			// contains (`artist_contains_ids`). The branch below is kept because `card_name` still
			// needs it, and because the collated node saves the engine the fold on the common path.
			if (
				(attr === "card_name" || attr === "card_artist") &&
				(this.operator === ":" || this.operator === "=") &&
				!this.rhs.literal
			) {
				return { node_type: "CollatedNameValueNode", kwargs: { value: collateName(foldAccents(value)) } };
			}
			return { node_type: "StringValueNode", kwargs: { value } };
		}

		return nodeToJson(this.rhs);
	}
}
