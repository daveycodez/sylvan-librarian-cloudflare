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
	COLOR_CODE_TO_NAME,
	COLOR_NAME_TO_CODE,
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
import { foldAccents, PyNumber, pyLower, pyStrip, pyStrTitle } from "./pystr";
import { ART_TAG_ALIASES, ORACLE_TAG_ALIASES } from "./tag-aliases.gen";
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
	["mythic", 3],
	["m", 3],
	["special", 4],
	["s", 4],
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
 */
export function getColorsComparisonKeys(val: string, attr = "card_colors"): string[] {
	const colorlessIsValue = attr === "produced_mana";
	const codeSet = new Set(COLOR_CODE_TO_NAME.keys());
	const chars = [...val];
	if (val !== "" && chars.every((c) => codeSet.has(c))) {
		const keys: string[] = [];
		for (const c of chars) {
			if (!colorlessIsValue && c === "c") continue;
			const upper = c.toUpperCase();
			if (!keys.includes(upper)) keys.push(upper);
		}
		return keys;
	}
	const letterCode = COLOR_NAME_TO_CODE.get(val);
	if (letterCode === undefined) {
		throw new ParseError(`Invalid color string: ${val}`);
	}
	if (letterCode === "c") {
		return colorlessIsValue ? ["C"] : [];
	}
	return [letterCode.toUpperCase()];
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
 * mapping is carried once (~78KB, tag-aliases.gen.ts) and folded in here instead.
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
	return [resolveTagAlias(slugifyTag(val), ORACLE_TAG_ALIASES)];
}

/** get_art_tags_comparison_object(...).keys() */
export function getArtTagsComparisonKeys(val: string): string[] {
	return [resolveTagAlias(slugifyTag(val), ART_TAG_ALIASES)];
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

/** Exact card name search (the ! prefix syntax). */
export class ExactNameNode extends QueryNode {
	override readonly nodeType: string = "ExactNameNode";

	constructor(readonly value: string) {
		super();
	}

	override kwargs(): Record<string, FilterValue> {
		return { value: pyLower(this.value) };
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
export class CardBinaryOperatorNode extends BinaryOperatorNode {
	override readonly nodeType: string = "CardBinaryOperatorNode";

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

	/**
	 * Serialize a numeric color-count rhs (id>=3 / c=2) for the Rust engine.
	 *
	 * Only the two real color fields support counting; produced_mana's C key is a genuine
	 * producible value, not a color, so a count over it would be ambiguous.
	 */
	private numericColorRhsToJson(attr: string): FilterValue {
		if (attr === "card_colors" || attr === "card_color_identity") {
			return nodeToJson(this.rhs);
		}
		throw new ParseError(`Numeric comparison is not supported for ${attr}`);
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
			// Numeric color syntax (id>=3 / c=2): pass the raw NumericValueNode so the Rust engine
			// builds a color-count comparison instead of a mask compare.
			if (this.rhs instanceof NumericValueNode) {
				return this.numericColorRhsToJson(attr);
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
			if (attr === "card_legalities") {
				return getLegalityComparisonKeys(val, lhs.originalAttribute);
			}
		}

		if (fieldInfo.parserClass === PC.RARITY && this.rhs instanceof StringValueNode) {
			return new NumericValueNode(PyNumber.int(BigInt(getRarityNumber(this.rhs.value)))).toJson();
		}

		if ((attr === "card_name" || attr === "card_artist") && this.rhs instanceof StringValueNode) {
			let value = titlecase(this.rhs.value);
			// Fold diacritics for fuzzy card_name: search so the Rust engine's
			// TextContains matches the same way the SQL path does (#649);
			// exact/comparison ops keep the literal value, accent-sensitive.
			if (attr === "card_name" && this.operator === ":") {
				value = foldAccents(value);
			}
			return { node_type: "StringValueNode", kwargs: { value } };
		}

		return nodeToJson(this.rhs);
	}
}
