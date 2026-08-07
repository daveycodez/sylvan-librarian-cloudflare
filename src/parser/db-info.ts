/**
 * Port of api/parsing/db_info.py — database field information and mappings.
 *
 * Kept structurally close to the Python module so upstream diffs can be
 * hand-applied: DB_COLUMNS is the same ordered list, and the derived lookup
 * tables are built the same way.
 */

export const FieldType = {
	JSONB_ARRAY: "jsonb_array",
	JSONB_OBJECT: "jsonb_object",
	NUMERIC: "numeric",
	TEXT: "text",
	DATE: "date",
} as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export const ParserClass = {
	NUMERIC: "numeric",
	MANA: "mana",
	RARITY: "rarity",
	LEGALITY: "legality",
	COLOR: "color",
	TEXT: "text",
	DATE: "date",
	YEAR: "year",
} as const;
export type ParserClass = (typeof ParserClass)[keyof typeof ParserClass];

export interface FieldInfo {
	readonly dbColumnName: string;
	readonly fieldType: FieldType;
	readonly searchAliases: readonly string[];
	readonly parserClass: ParserClass;
}

export const DB_COLUMNS: readonly FieldInfo[] = [
	{
		dbColumnName: "card_artist",
		fieldType: FieldType.TEXT,
		searchAliases: ["artist", "a"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_colors",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["color", "colors", "c"],
		parserClass: ParserClass.COLOR,
	},
	{
		dbColumnName: "card_color_identity",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["color_identity", "coloridentity", "id", "identity"],
		parserClass: ParserClass.COLOR,
	},
	{
		dbColumnName: "card_frame_data",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["frame"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_keywords",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["keyword", "kw"],
		parserClass: ParserClass.TEXT,
	},
	{ dbColumnName: "card_name", fieldType: FieldType.TEXT, searchAliases: ["name"], parserClass: ParserClass.TEXT },
	{
		dbColumnName: "card_subtypes",
		fieldType: FieldType.JSONB_ARRAY,
		searchAliases: ["subtype", "subtypes"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_types",
		fieldType: FieldType.JSONB_ARRAY,
		searchAliases: ["type", "types", "t"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "cmc",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["cmc", "mv", "manavalue"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "creature_power",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["power", "pow"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "creature_toughness",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["toughness", "tou"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "planeswalker_loyalty",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["loyalty", "loy"],
		parserClass: ParserClass.NUMERIC,
	},
	{ dbColumnName: "edhrec_rank", fieldType: FieldType.NUMERIC, searchAliases: [], parserClass: ParserClass.NUMERIC },
	{
		dbColumnName: "mana_cost_jsonb",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["mana", "m"],
		parserClass: ParserClass.MANA,
	},
	{
		dbColumnName: "devotion",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["devotion"],
		parserClass: ParserClass.MANA,
	},
	{ dbColumnName: "price_usd", fieldType: FieldType.NUMERIC, searchAliases: ["usd"], parserClass: ParserClass.NUMERIC },
	{ dbColumnName: "price_eur", fieldType: FieldType.NUMERIC, searchAliases: ["eur"], parserClass: ParserClass.NUMERIC },
	{ dbColumnName: "price_tix", fieldType: FieldType.NUMERIC, searchAliases: ["tix"], parserClass: ParserClass.NUMERIC },
	{
		dbColumnName: "produced_mana",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["produces"],
		parserClass: ParserClass.COLOR,
	},
	{
		dbColumnName: "raw_card_blob",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: [],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "oracle_text",
		fieldType: FieldType.TEXT,
		searchAliases: ["oracle", "o"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "flavor_text",
		fieldType: FieldType.TEXT,
		searchAliases: ["flavor", "ft"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_oracle_tags",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["oracle_tags", "otag"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_art_tags",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["art_tags", "art"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_is_tags",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["is"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_rarity_int",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["rarity", "r"],
		parserClass: ParserClass.RARITY,
	},
	{
		dbColumnName: "card_set_code",
		fieldType: FieldType.TEXT,
		searchAliases: ["set", "s", "e"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "collector_number",
		fieldType: FieldType.TEXT,
		searchAliases: ["number", "cn"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "collector_number_int",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["number", "cn"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "card_legalities",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["format", "f", "legal", "banned", "restricted"],
		parserClass: ParserClass.LEGALITY,
	},
	{ dbColumnName: "card_layout", fieldType: FieldType.TEXT, searchAliases: ["layout"], parserClass: ParserClass.TEXT },
	{ dbColumnName: "card_border", fieldType: FieldType.TEXT, searchAliases: ["border"], parserClass: ParserClass.TEXT },
	{
		dbColumnName: "card_watermark",
		fieldType: FieldType.TEXT,
		searchAliases: ["watermark", "wm"],
		parserClass: ParserClass.TEXT,
	},
	{ dbColumnName: "released_at", fieldType: FieldType.DATE, searchAliases: ["date"], parserClass: ParserClass.DATE },
	{ dbColumnName: "released_at", fieldType: FieldType.DATE, searchAliases: ["year"], parserClass: ParserClass.YEAR },
];

export const ALIAS_TO_FIELD_INFOS: ReadonlyMap<string, readonly FieldInfo[]> = (() => {
	const map = new Map<string, FieldInfo[]>();
	for (const col of DB_COLUMNS) {
		for (const alias of col.searchAliases) {
			const key = alias.toLowerCase();
			const list = map.get(key);
			if (list) list.push(col);
			else map.set(key, [col]);
		}
	}
	return map;
})();

export const CARD_SUPERTYPES: ReadonlySet<string> = new Set(["Basic", "Legendary", "Snow", "World"]);

export const CARD_TYPES: ReadonlySet<string> = new Set([
	"Artifact",
	"Conspiracy",
	"Creature",
	"Enchantment",
	"Instant",
	"Kindred", // new name for tribal
	"Land",
	"Planeswalker",
	"Sorcery",
	"Tribal",
]);

export const COLOR_CODE_TO_NAME: ReadonlyMap<string, string> = new Map([
	["b", "black"],
	["c", "colorless"],
	["g", "green"],
	["r", "red"],
	["u", "blue"],
	["w", "white"],
]);

export const COLOR_NAME_TO_CODE: ReadonlyMap<string, string> = new Map(
	[...COLOR_CODE_TO_NAME].map(([code, name]) => [name, code]),
);

export const FORMAT_CODE_TO_NAME: ReadonlyMap<string, string> = new Map([
	["m", "modern"],
	["s", "standard"],
	["l", "legacy"],
	["p", "pauper"],
	["c", "commander"],
	["v", "vintage"],
	["h", "historic"],
]);
