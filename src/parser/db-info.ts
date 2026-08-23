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
		// `colour`/`colours` are Scryfall's British spellings and answer identically (`colour:wu e:khm`
		// = `c:wu e:khm` = 6, measured 2026-08-16). `color_identity`/`coloridentity` below are the
		// reverse case — spellings THIS parser accepts and Scryfall does not — and are left alone:
		// answering where Scryfall warns costs a searcher nothing, while removing them would break
		// queries that already work.
		searchAliases: ["color", "colors", "colour", "colours", "c"],
		parserClass: ParserClass.COLOR,
	},
	{
		dbColumnName: "card_color_identity",
		fieldType: FieldType.JSONB_OBJECT,
		// `commander` is how a player actually searches a commander's colours, and it is plain colour
		// IDENTITY: `commander:wu e:khm` = `id:wu e:khm` = 117, and it takes the counts too
		// (`commander:m e:khm` = `commander>=2 e:khm` = 74). Scryfall's identity vocabulary is a
		// BOUNDARY — `cid`, `commanderidentity`, `colouridentity` and `colour_identity` all come
		// back "Unknown keyword" — so nothing else joins it.
		searchAliases: ["color_identity", "coloridentity", "id", "identity", "ci", "commander"],
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
		dbColumnName: "oracle_id",
		fieldType: FieldType.TEXT,
		searchAliases: ["oracleid", "oracle_id"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "oracle_text",
		fieldType: FieldType.TEXT,
		// `fo:`/`fulloracle:` are Scryfall's FULL-oracle spellings and share this column: the
		// stored `oracle_text` IS the full text, reminder text included, so the SQL path answers
		// both from it and needs no second column. They are told apart downstream by
		// `original_attribute` — which matters only to the card engine, whose searchable oracle
		// column has reminder text stripped out of it the way Scryfall's `o:` does.
		// Measured on api.scryfall.com 2026-08-16: `fo:lifelink` 713 / `o:lifelink` stripped,
		// `fo:draw e:khm` 57 / `o:draw e:khm` 39, `fo:/\(this creature/` 1,098 / `o:/\(/` 0.
		searchAliases: ["oracle", "o", "fo", "fulloracle"],
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
		searchAliases: ["oracle_tags", "otag", "oracletag", "function"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_art_tags",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["art_tags", "art", "atag", "arttag"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_is_tags",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["is", "has"],
		parserClass: ParserClass.TEXT,
	},
	// A distinct FieldInfo from "is" above, sharing its column, so a `not:` leaf is an `is:` leaf
	// to everything downstream — rewrite.ts's negateNotPrefix distinguishes the two via
	// originalAttribute and supplies the negation Scryfall's docs describe ("not: is the same as
	// -is:"). Upstream #987.
	{
		dbColumnName: "card_is_tags",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["not"],
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
	{
		dbColumnName: "card_lang",
		fieldType: FieldType.TEXT,
		searchAliases: ["lang", "language"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "card_set_type",
		fieldType: FieldType.TEXT,
		searchAliases: ["set_type", "settype", "st"],
		parserClass: ParserClass.TEXT,
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

/**
 * The `is:` values Scryfall ships as BOOLEANS on every bulk card object, as
 * `card_is_tags key -> raw blob key`. The importer rebuilds the column from these
 * (engine/builder/src/transform.rs, upstream's `_sync_is_tags`) and the parser reads the keys so
 * it knows which `is:` values have data behind them (`rewrite.SUPPORTED_IS_VALUES`). Adding a
 * field here is the whole change on both sides.
 *
 * `foil` is Scryfall's deprecated top-level boolean, which says the same thing as `finishes`
 * containing "foil"; reading the boolean keeps every entry here on the one shape upstream can
 * express in SQL. See engine/builder/src/transform.rs for the measured archive cost of the dense
 * members of this table.
 */
/**
 * `is:` values the IMPORTER computes rather than copying off a Scryfall field, so they cannot ride
 * BOOLEAN_IS_TAGS or ARRAY_IS_TAGS (which are both "this bulk key says so" tables).
 *
 * `extra` is the union of the classes Scryfall hides from a default `/cards/search` behind
 * `include_extras=false` — memorabilia and the other extras `set_type`s, playtest promos, and the
 * "Card" type-line art-series family. It exists because reproducing `include_extras` means
 * STORING those printings and filtering them at query time, which is what Scryfall does;
 * this port used to reproduce it by refusing to import them, which made `/cards/named` 404 where
 * Scryfall answers and made `include_extras=true` answer nothing at all.
 *
 * Spelled once here and once in the builder's `EXTRA_IS_TAG`; the two must agree or `is:extra`
 * warns instead of filtering.
 */
export const EXTRA_IS_TAG = "extra";

/**
 * `is:hybrid`. Computed by the importer from the FRONT face's mana cost, which is the only place
 * that question can be answered: Scryfall's `m:` matches a symbol on any face, so the `m:` union
 * this replaced answered 605 where Scryfall answers 603 — the extras being the two `prepare`
 * printings hybrid on the back alone. Spelled once here and once as the builder's `HYBRID_IS_TAG`.
 */
export const HYBRID_IS_TAG = "hybrid";

export const COMPUTED_IS_TAGS: ReadonlySet<string> = new Set([EXTRA_IS_TAG, HYBRID_IS_TAG]);

export const BOOLEAN_IS_TAGS: ReadonlyMap<string, string> = new Map([
	["booster", "booster"],
	["digital", "digital"],
	["foil", "foil"],
	["fullart", "full_art"],
	["gamechanger", "game_changer"],
	["hires", "highres_image"],
	["nonfoil", "nonfoil"],
	["oversized", "oversized"],
	["promo", "promo"],
	["reprint", "reprint"],
	["reserved", "reserved"],
	["spotlight", "story_spotlight"],
	["textless", "textless"],
	["variation", "variation"],
]);

/**
 * The `is:` values Scryfall ships as membership in a bulk ARRAY, as
 * `card_is_tags key -> [raw blob array key, member]`. Same contract as BOOLEAN_IS_TAGS.
 *
 * Every mapping was established by READING the cards Scryfall returns rather than by guessing the
 * spelling: `is:X` was fetched from api.scryfall.com on 2026-08-16 and the `promo_types` arrays of
 * the results intersected. That is what turns `is:judge_gift` into `judgegift`, and what separates
 * `is:stamped` from the broader `promopack` its results also all carry.
 *
 * The KEY is the word a player types, which is Scryfall's own syntax-page spelling
 * (`is:judge_gift`, `is:set_promo`); the concatenated form is the promo_types MEMBER. `rewrite.ts`
 * carries `is:judge` as an alias onto `judge_gift` rather than storing those rows twice.
 */
export const ARRAY_IS_TAGS: ReadonlyMap<string, readonly [string, string]> = new Map([
	["arena_league", ["promo_types", "arenaleague"]],
	["boosterfun", ["promo_types", "boosterfun"]],
	["buyabox", ["promo_types", "buyabox"]],
	["convention", ["promo_types", "convention"]],
	["datestamped", ["promo_types", "datestamped"]],
	["etched", ["finishes", "etched"]],
	["fnm", ["promo_types", "fnm"]],
	["gameday", ["promo_types", "gameday"]],
	["giftbox", ["promo_types", "giftbox"]],
	["glossy", ["promo_types", "glossy"]],
	["instore", ["promo_types", "instore"]],
	["intro_pack", ["promo_types", "intropack"]],
	["judge_gift", ["promo_types", "judgegift"]],
	["league", ["promo_types", "league"]],
	["media_insert", ["promo_types", "mediainsert"]],
	// "Partner with <name>" cards carry a plain "Partner" keyword alongside it (verified against
	// the corpus), so checking for "Partner" alone already covers both.
	["partner", ["keywords", "Partner"]],
	["planeswalker_deck", ["promo_types", "planeswalkerdeck"]],
	["player_rewards", ["promo_types", "playerrewards"]],
	["prerelease", ["promo_types", "prerelease"]],
	["rebalanced", ["promo_types", "rebalanced"]],
	["release", ["promo_types", "release"]],
	["set_promo", ["promo_types", "setpromo"]],
	["stamped", ["promo_types", "stamped"]],
	["universesbeyond", ["promo_types", "universesbeyond"]],
] as [string, readonly [string, string]][]);

/**
 * The `is:` values that read a NESTED single field rather than a top-level boolean or an array, as
 * `card_is_tags key -> [outer blob key, inner key, value]`. Mirrors the builder's `FIELD_IS_TAGS`.
 *
 * Upstream expresses the same question as a SQL expression
 * (`raw_card_blob->'preview'->>'source' = 'Scryfall'`), which neither the Rust builder nor this
 * table has an equivalent of, so the one shape it actually uses gets its own small table rather
 * than an expression evaluator.
 */
export const FIELD_IS_TAGS: ReadonlyMap<string, readonly [string, string, string]> = new Map([
	["scryfallpreview", ["preview", "source", "Scryfall"]],
] as [string, readonly [string, string, string]][]);

export const CARD_SUPERTYPES: ReadonlySet<string> = new Set(["Basic", "Legendary", "Snow", "World"]);

export const CARD_TYPES: ReadonlySet<string> = new Set([
	"Artifact",
	"Battle", // reaches the corpus once faces merge (#400): every battle is a transform front
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

/**
 * Every colour NAME Scryfall's search accepts, as the letter set that name spells.
 *
 * The guild / shard / wedge vocabulary is what players actually type — `c:azorius` is a normal
 * thing to write and this parser answered it with a parse error — so the whole table was measured
 * rather than guessed, one request each against api.scryfall.com (`c:<value> e:khm`, 2026-08-16),
 * and every accepted name then checked against its letter spelling over the WHOLE corpus. Kaldheim
 * holds exactly one card of three colours or more, so a set-scoped check would have agreed with
 * almost any mapping; the corpus-wide pairs are the ones that pin it: `c:bant` = `c:gwu` = 153,
 * `c:esper` = `c:wub` = 146, `c:yore-tiller` = `c:wubr` = 62, `c:witch-maw` = `c:gwub` = 63,
 * `c:rainbow` = `c:wubrg` = 60, `c:brown` = `c:c` = 4,300, and so on for all 24 pairs.
 *
 * It is a BOUNDARY rather than a superset. `yore`, `glint`, `dune`, `ink` and `witch` on their own
 * come back "Unknown color …" — the un-hyphenated four-colour nicknames are NOT in Scryfall's
 * table, only the hyphenated forms and the five one-word synonyms are — and so do `five`, `mono`,
 * `guild`, `shard`, `wedge`, `nephilim` and `chromatic`.
 *
 * `all` spells `wubrgc` where `rainbow` spells `wubrg`, and the difference is measured rather than
 * cosmetic: for card_colors and card_color_identity the `c` drops out, so `c:all` = `c:wubrg` = 60,
 * while for produced_mana it does not, so `produces:all` matches nothing (no card produces all six)
 * where `produces:rainbow` = `produces:wubrg` = 13. One table serves all three columns because
 * `getColorsComparisonKeys` already draws exactly that line.
 *
 * NOT here: the colour-COUNT names, which spell no letters at all — see COLOR_COUNT_NAMES below.
 */
export const COLOR_ALIAS_TO_CODES: ReadonlyMap<string, string> = new Map([
	// the five colours, colourless, and the British and slang spellings of the latter
	["white", "w"],
	["blue", "u"],
	["black", "b"],
	["red", "r"],
	["green", "g"],
	["colorless", "c"],
	["colourless", "c"],
	["brown", "c"],
	// the ten Ravnica guilds
	["azorius", "wu"],
	["dimir", "ub"],
	["rakdos", "br"],
	["gruul", "rg"],
	["selesnya", "gw"],
	["orzhov", "wb"],
	["izzet", "ur"],
	["golgari", "bg"],
	["boros", "rw"],
	["simic", "gu"],
	// the five Strixhaven colleges — verified live the same way, corpus-wide: c:lorehold =
	// c:rw = 682, c:prismari = c:ur = 668, c:quandrix = c:gu = 638, c:silverquill = c:wb = 614,
	// c:witherbloom = c:bg = 606.
	["lorehold", "rw"],
	["prismari", "ur"],
	["quandrix", "gu"],
	["silverquill", "wb"],
	["witherbloom", "bg"],
	// the five Alara shards
	["bant", "gwu"],
	["esper", "wub"],
	["grixis", "ubr"],
	["jund", "brg"],
	["naya", "rgw"],
	// the five Khans wedges
	["abzan", "wbg"],
	["jeskai", "urw"],
	["sultai", "bgu"],
	["mardu", "rwb"],
	["temur", "gur"],
	// the five four-colour names, hyphenated (the Nephilim) and as one word
	["yore-tiller", "wubr"],
	["glint-eye", "ubrg"],
	["dune-brood", "brgw"],
	["ink-treader", "rgwu"],
	["witch-maw", "gwub"],
	["artifice", "wubr"],
	["chaos", "ubrg"],
	["aggression", "brgw"],
	["altruism", "rgwu"],
	["growth", "gwub"],
	// all five colours, and all six values
	["rainbow", "wubrg"],
	["all", "wubrgc"],
]);

/**
 * The colour values that are a COUNT rather than a set of letters.
 *
 * `c:m` is not "the colour m" — there is no such colour. It is Scryfall's word for MULTICOLOURED,
 * and it compares the NUMBER of colours in the column, which is why it cannot live in
 * COLOR_ALIAS_TO_CODES beside `azorius`: there are no letters to expand. `gold` and the
 * `multicolor` spellings are the same value under other names; every one of the six answers the
 * identical count (`c:m` = `c:gold` = `c:multicolor` = `c:multicolored` = `c:multicolour` =
 * `c:multicoloured` = 44 in Kaldheim, where `c:2` = 43 and `c>=2` = 44).
 *
 * THE OPERATOR TABLE IS MEASURED, and it is not "substitute the number 2". Corpus-wide against
 * api.scryfall.com, 2026-08-16:
 *
 *   c:m = c=m = c>m = c>=m = 4,607 = `c>=2`          (`c=2` is 3,811 and `c>2` is 796)
 *   c<m = c!=m           = 29,049 = `c<2`            (`c!=2` is 29,836)
 *   c<=m                 = 33,599 = EVERY CARD       (`c<=2` is 32,812)
 *
 * `>` is the surprise on the high side — `c>m` is `c>=2`, not `c>2` — and `!=` is the surprise on
 * the low side: `c!=m` is `c<2`, the negation of "is multicoloured", NOT `c!=2`, which would also
 * admit the 796 three-and-more-colour cards. `<=` is a tautology rather than `c<=2`, pinned against
 * a second term so it cannot be read as "the whole corpus": `c<=m t:creature` = `t:creature`
 * = `c<=5 t:creature` = 18,753 where `c<=2 t:creature` = 18,140.
 *
 * The identity spellings take the same table on their own column: `id:m` = `id=m` = `id>m` =
 * `id>=m` = 5,831 = `id>=2`, `id<m` = `id!=m` = 27,768 = `id<2` (`id!=2` is 28,824), and
 * `id<=m` = 33,599 = every card (`id<=2` is 32,543).
 *
 * `produces:` takes the same table, but over SIX values rather than five, and that asymmetry is
 * measured rather than tidy: produced_mana is the one colour-ish column whose array can literally
 * contain "C" (Sol Ring produces `["C"]` while its colors and color_identity are both `[]`). So
 * `produces=6` = 106 = `produces:all` — a count no five-key popcount can even reach — the 481 cards
 * that produce colorless and nothing else answer `produces=1` rather than `produces=0`, the three
 * producing exactly {C,W} land in `produces=2` and not `produces=1`, and counts 0..6 partition the
 * corpus exactly (30,996 + 1,143 + 504 + 147 + 10 + 693 + 106 = 33,599). The colour columns must
 * keep counting five: `c:all` = `c:wubrg` = `c=5` = 60, and `c=6` is not a valid query there at all
 * ("Unknown color 6"). Both halves are pinned by tests so the asymmetry is not "fixed" later.
 *
 * `produces:m` = `produces=m` = `produces>m` = `produces>=m` = 1,460 = `produces>=2`
 * (`produces=2` is 504), while `produces<m` = `produces!=m` = 1,143 = `produces=1` — NOT
 * `produces<2` (32,139), which sweeps in the cards that produce nothing — and `produces<=m` =
 * 2,603 = `produces>=1` rather than every card.
 */
export const COLOR_COUNT_NAMES: ReadonlySet<string> = new Set([
	"m",
	"gold",
	"multicolor",
	"multicolour",
	"multicolored",
	"multicoloured",
]);

export const FORMAT_CODE_TO_NAME: ReadonlyMap<string, string> = new Map([
	["m", "modern"],
	["s", "standard"],
	["l", "legacy"],
	["p", "pauper"],
	["c", "commander"],
	["v", "vintage"],
	["h", "historic"],
]);
