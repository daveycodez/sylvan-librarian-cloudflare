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
	// A third FieldInfo on the same column, for the same reason `not` is a second one: `game:paper`
	// asks a card_is_tags question, but the VALUE is Scryfall's game vocabulary rather than the tag
	// vocabulary, so the leaf has to be distinguishable by originalAttribute. rewrite.ts's
	// `prefixGameValues` turns it into the `game_<value>` tag GAME_IS_TAGS names — which is what
	// keeps `game:promo` from quietly answering `is:promo`.
	{
		dbColumnName: "card_is_tags",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["game"],
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

/**
 * `is:meldpart` / `is:meldresult`. Computed by the importer from the printing's OWN entry in
 * Scryfall's `all_parts` array, which is the only place the role is written down — a meld card
 * carries all three entries, so `layout:meld` says the card is part of a meld and not which side.
 *
 * 14 parts and 7 results on api.scryfall.com (2026-09-03), two parts per result. Both answered 0
 * here before this: `all_parts` is stored in the compat residue, the archive only `/cards/*` reads,
 * so no search could reach it — the same shape the `games` gap had.
 *
 * Spelled once here and once as the builder's `MELD_PART_IS_TAG`/`MELD_RESULT_IS_TAG`.
 */
export const MELD_PART_IS_TAG = "meldpart";
export const MELD_RESULT_IS_TAG = "meldresult";

export const COMPUTED_IS_TAGS: ReadonlySet<string> = new Set([
	EXTRA_IS_TAG,
	HYBRID_IS_TAG,
	MELD_PART_IS_TAG,
	MELD_RESULT_IS_TAG,
]);

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
 * ─── THE 2026-09-03 SWEEP: 24 ROWS BECAME 92 ─────────────────────────────────────────────────
 *
 * The table was 24 rows and the vocabulary is not. It was hand-kept from Scryfall's SYNTAX PAGE,
 * and the page documents about half of what the search accepts — `is:serialized`, `is:surgefoil`,
 * `is:galaxyfoil`, `is:textured`, `is:stepandcompleat` and the whole Final Fantasy family appear
 * nowhere on it and all answer there. Every one of them was a silent zero here.
 *
 * Enumerated rather than read off a page this time: 5,600 printings were paged out of eight
 * printing-space queries chosen to hit the special printings, which yielded 88 distinct
 * `promo_types` members; unioned with the syntax page's 92 `is:` values that gave 186 candidates,
 * of which 93 were outside `SUPPORTED_IS_VALUES`; each of those 93 was then probed against
 * api.scryfall.com, and 78 came back a 200. 74 of the 78 intersect to a field member of THEIR OWN
 * NAME — 73 in `promo_types` and `tombstone` in `frame_effects`, which is why that one is a frame
 * rewrite and not a row here.
 *
 * Six of the 74 are the CONCATENATED spelling of a tag this table already stored (`setpromo` for
 * `set_promo`, `judgegift` for `judge_gift`, and so on for `arenaleague`, `intropack`,
 * `mediainsert`, `planeswalkerdeck`). Scryfall takes both spellings; those became aliases in
 * rewrite.ts rather than rows, because the tag under either spelling is the same tag and the store
 * already carries it.
 *
 * The 15 candidates Scryfall itself rejects — `acorn`, `oval`, `triangle`, `arena`, `circle`,
 * `snow`, `devoid`, `legendary`, `inverted`, `lesson`, `enchantment` and the DFC frame effects —
 * are deliberately absent: they are `frame_effects` or `security_stamp` members that are NOT `is:`
 * values there (`stamp:` and `frame:` reach them), and adding them would answer where Scryfall
 * refuses.
 *
 * The KEY is the word a player types, which is Scryfall's own syntax-page spelling
 * (`is:judge_gift`, `is:set_promo`); the concatenated form is the promo_types MEMBER. `rewrite.ts`
 * carries `is:judge` as an alias onto `judge_gift` rather than storing those rows twice.
 */
export const ARRAY_IS_TAGS: ReadonlyMap<string, readonly [string, string]> = new Map([
	["arena_league", ["promo_types", "arenaleague"]],
	["beginnerbox", ["promo_types", "beginnerbox"]],
	["boosterfun", ["promo_types", "boosterfun"]],
	["boxtopper", ["promo_types", "boxtopper"]],
	["brawldeck", ["promo_types", "brawldeck"]],
	["bringafriend", ["promo_types", "bringafriend"]],
	["bundle", ["promo_types", "bundle"]],
	["buyabox", ["promo_types", "buyabox"]],
	["chocobotrackfoil", ["promo_types", "chocobotrackfoil"]],
	["commanderparty", ["promo_types", "commanderparty"]],
	["commanderpromo", ["promo_types", "commanderpromo"]],
	["concept", ["promo_types", "concept"]],
	["confettifoil", ["promo_types", "confettifoil"]],
	["convention", ["promo_types", "convention"]],
	["cosmicfoil", ["promo_types", "cosmicfoil"]],
	["datestamped", ["promo_types", "datestamped"]],
	["dazzlefoil", ["promo_types", "dazzlefoil"]],
	["dossier", ["promo_types", "dossier"]],
	["doubleexposure", ["promo_types", "doubleexposure"]],
	["doublerainbow", ["promo_types", "doublerainbow"]],
	["draculaseries", ["promo_types", "draculaseries"]],
	["draftweekend", ["promo_types", "draftweekend"]],
	["dragonscalefoil", ["promo_types", "dragonscalefoil"]],
	["duels", ["promo_types", "duels"]],
	["embossed", ["promo_types", "embossed"]],
	["etched", ["finishes", "etched"]],
	["event", ["promo_types", "event"]],
	["facetfoil", ["promo_types", "facetfoil"]],
	["ffi", ["promo_types", "ffi"]],
	["ffii", ["promo_types", "ffii"]],
	["ffiii", ["promo_types", "ffiii"]],
	["ffiv", ["promo_types", "ffiv"]],
	["ffix", ["promo_types", "ffix"]],
	["ffv", ["promo_types", "ffv"]],
	["ffvi", ["promo_types", "ffvi"]],
	["ffvii", ["promo_types", "ffvii"]],
	["ffviii", ["promo_types", "ffviii"]],
	// Final Fantasy X, and established the way the rest of this table was: `is:ffx` is 120 cards /
	// 170 printings on api.scryfall.com (2026-09-03), and intersecting the `promo_types` of all 170
	// leaves `ffx` and `universesbeyond`. The second is the wider set every Universes Beyond
	// printing carries and is already a row below; `ffx` is the discriminating member.
	["ffx", ["promo_types", "ffx"]],
	["ffxi", ["promo_types", "ffxi"]],
	["ffxii", ["promo_types", "ffxii"]],
	["ffxiii", ["promo_types", "ffxiii"]],
	["ffxiv", ["promo_types", "ffxiv"]],
	["ffxv", ["promo_types", "ffxv"]],
	["ffxvi", ["promo_types", "ffxvi"]],
	["firstplacefoil", ["promo_types", "firstplacefoil"]],
	["fnm", ["promo_types", "fnm"]],
	["fracturefoil", ["promo_types", "fracturefoil"]],
	["galaxyfoil", ["promo_types", "galaxyfoil"]],
	["gameday", ["promo_types", "gameday"]],
	["giftbox", ["promo_types", "giftbox"]],
	["gilded", ["promo_types", "gilded"]],
	["gleaminggold", ["promo_types", "gleaminggold"]],
	["glossy", ["promo_types", "glossy"]],
	["godzillaseries", ["promo_types", "godzillaseries"]],
	["halofoil", ["promo_types", "halofoil"]],
	["headliner", ["promo_types", "headliner"]],
	["imagine", ["promo_types", "imagine"]],
	["instore", ["promo_types", "instore"]],
	["intro_pack", ["promo_types", "intropack"]],
	["invisibleink", ["promo_types", "invisibleink"]],
	["japanshowcase", ["promo_types", "japanshowcase"]],
	["jpwalker", ["promo_types", "jpwalker"]],
	["judge_gift", ["promo_types", "judgegift"]],
	["league", ["promo_types", "league"]],
	["magnified", ["promo_types", "magnified"]],
	["manafoil", ["promo_types", "manafoil"]],
	["media_insert", ["promo_types", "mediainsert"]],
	["neonink", ["promo_types", "neonink"]],
	["oilslick", ["promo_types", "oilslick"]],
	["openhouse", ["promo_types", "openhouse"]],
	// "Partner with <name>" cards carry a plain "Partner" keyword alongside it (verified against
	// the corpus), so checking for "Partner" alone already covers both.
	["partner", ["keywords", "Partner"]],
	["planeswalker_deck", ["promo_types", "planeswalkerdeck"]],
	["player_rewards", ["promo_types", "playerrewards"]],
	["playpromo", ["promo_types", "playpromo"]],
	["portrait", ["promo_types", "portrait"]],
	["poster", ["promo_types", "poster"]],
	["prerelease", ["promo_types", "prerelease"]],
	["promopack", ["promo_types", "promopack"]],
	["rainbowfoil", ["promo_types", "rainbowfoil"]],
	["raisedfoil", ["promo_types", "raisedfoil"]],
	["ravnicacity", ["promo_types", "ravnicacity"]],
	["rebalanced", ["promo_types", "rebalanced"]],
	["release", ["promo_types", "release"]],
	["resale", ["promo_types", "resale"]],
	["ripplefoil", ["promo_types", "ripplefoil"]],
	["scroll", ["promo_types", "scroll"]],
	["serialized", ["promo_types", "serialized"]],
	["set_promo", ["promo_types", "setpromo"]],
	["silverfoil", ["promo_types", "silverfoil"]],
	["silverscroll", ["promo_types", "silverscroll"]],
	["sldbonus", ["promo_types", "sldbonus"]],
	["sourcematerial", ["promo_types", "sourcematerial"]],
	["stamped", ["promo_types", "stamped"]],
	["standardshowdown", ["promo_types", "standardshowdown"]],
	["startercollection", ["promo_types", "startercollection"]],
	["starterdeck", ["promo_types", "starterdeck"]],
	["stepandcompleat", ["promo_types", "stepandcompleat"]],
	["storechampionship", ["promo_types", "storechampionship"]],
	["surgefoil", ["promo_types", "surgefoil"]],
	["textured", ["promo_types", "textured"]],
	["thick", ["promo_types", "thick"]],
	["tourney", ["promo_types", "tourney"]],
	["universesbeyond", ["promo_types", "universesbeyond"]],
	["upsidedown", ["promo_types", "upsidedown"]],
	["vault", ["promo_types", "vault"]],
	["wizardsplaynetwork", ["promo_types", "wizardsplaynetwork"]],
] as [string, readonly [string, string]][]);

/**
 * Scryfall's `game:` vocabulary, as `game value -> card_is_tags key`.
 *
 * The tag keys are PREFIXED, and that is the whole point of the table: `games` is a bulk ARRAY
 * exactly like `promo_types`, so `game:paper` would ride ARRAY_IS_TAGS as the bare tag `paper` —
 * and then `game:promo` would answer `is:promo`'s 6,126 promos instead of Scryfall's
 * ``Unknown game `promo` ``. Prefixing makes the mapping TOTAL: rewrite.ts sends every `game:`
 * value through it, a value outside this table becomes a `game_<value>` tag no row carries, and
 * the two vocabularies can never collide.
 *
 * ─── THE VOCABULARY ──────────────────────────────────────────────────────────────────────────
 *
 * Measured against api.scryfall.com 2026-09-03. `paper`, `arena` and `mtgo` answer (32,729 /
 * 16,070 / 30,707 over the default corpus); `astral` and `sega` are ACCEPTED and answer nothing
 * there — `game:astral` is a 404 with no `warnings` key, and 12 cards with `include_extras=true`,
 * so they are valid values naming two old digital-only sets rather than typos. Anything else is
 * ignored-and-warned: `game:nonsense` comes back ``Unknown game `nonsense` `` and `game:PROMO`
 * names `promo` lower-cased, exactly as `lang:` does.
 *
 * ─── WHY THE `is:` TAGS AND NOT A NEW COLUMN ─────────────────────────────────────────────────
 *
 * `games` is per PRINTING (`card_is_tags` hangs off `Printing`, which is where the question
 * belongs — `game:paper is:digital` is 0 on api.scryfall.com and so is `-is:digital -game:paper`,
 * so the two are the same per-printing predicate), and three of the five values are DENSE. A new
 * column would be an ARCHIVE_FORMAT_VERSION change and its deploy blackout; a tag is a
 * STORE_CONTENT_GENERATION change, and the builder's own measurement is that density is cheap
 * here — past the storage crossover a value is a bitmap plane rather than a posting list, so the
 * three dense games cost about what the three densest existing tags did (1.89 MiB for
 * booster/hires/nonfoil). See engine/builder/src/transform.rs.
 *
 * ─── FIVE HERE, THREE ON THE CARD OBJECT — A DIVERGENCE, WRITTEN DOWN ONCE ───────────────────
 *
 * The `/cards/*` emission path is a THREE-member vocabulary: `card_engine`'s `GAME_NAMES` is
 * `paper`/`mtgo`/`arena`, and `games_pack` drops `astral` and `sega` on the way into the compat
 * blob's packed byte — deliberately, because that byte spends three bits on membership and three
 * on Scryfall's ORDER, and the order of up to five values does not fit where the order of three
 * does. So a printing whose only game is `astral` matches `game:astral` here and emits `games: []`
 * on its card object, where Scryfall emits `["astral"]`.
 *
 * Kept as five rather than cut to three, because the two tables answer different questions and
 * only one of them is lossy: MEMBERSHIP has no width limit, and dropping `astral`/`sega` from
 * search to match the emission would answer nothing for a value api.scryfall.com honors. Widening
 * the emission instead is an archive change — the order field has to grow, or the packed byte has
 * to become two — with its own measurement to do, and it is not folded in here.
 *
 * Spelled once here and once in the builder's `GAME_IS_TAGS`; the two must agree or `game:paper`
 * silently answers nothing.
 */
export const GAME_IS_TAGS: ReadonlyMap<string, string> = new Map([
	["paper", "game_paper"],
	["arena", "game_arena"],
	["mtgo", "game_mtgo"],
	["astral", "game_astral"],
	["sega", "game_sega"],
]);

/** The `card_is_tags` key a `game:` value names, valid or not — see GAME_IS_TAGS. */
export function gameTagKey(value: string): string {
	return GAME_IS_TAGS.get(value) ?? `game_${value}`;
}

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
 * `all` spells `wubrgc` where `rainbow` spells `wubrg`. Both are in this table because it is the
 * VOCABULARY — Scryfall accepts both words, and the compat layer reads this map to decide that —
 * but neither is compared as a SET of letters: they are COUNTS, and the letters they spell are read
 * only for how many values they come to on the column being asked. See COLOR_SPREAD_COUNT_NAMES.
 *
 * NOT compared as letters either: the colour-COUNT names, which spell nothing at all — see
 * COLOR_COUNT_NAMES below.
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

/**
 * The two colour names that mean "the WHOLE spread of this column", which is a COUNT.
 *
 * `rainbow` and `all` live in COLOR_ALIAS_TO_CODES because Scryfall accepts both words and that
 * map is the vocabulary. They are not compared as the letters they spell, though, and this is the
 * one place in the colour vocabulary where a name and its own letter spelling ANSWER DIFFERENTLY.
 * The letters are read only for how many values they come to on the column asked:
 *
 *   rainbow  spells wubrg  -> 5 on every column
 *   all      spells wubrgc -> 5 on card_colors / card_color_identity (the C drops out), 6 on
 *                             produced_mana (where C is a producible value) — the same asymmetry
 *                             COLOR_COUNT_NAMES' `produces=6` paragraph already carries
 *
 * and THE OPERATOR IS CARRIED THROUGH VERBATIM, with `:` meaning `=` — which is exactly what the
 * numeric colour-count path does with `c:2` already. No surprises, unlike the `m` and `any` tables.
 *
 * MEASURED against api.scryfall.com 2026-08-28, corpus-wide (33,599 cards), on all three columns:
 *
 *   c:rainbow = c:all = c>=all = c=all           =     60 = `c=5`      c>all = 0 = `c>5`
 *   c<rainbow = c<all = c!=rainbow               = 33,540 = `c<5` = `c!=5`
 *   id:rainbow = id:all = id=rainbow = id>=all   =    129 = `id=5`     id>rainbow = 0
 *   id<rainbow = id<all = id!=rainbow = id!=all  = 33,470 = `id<5` = `id!=5`
 *   id<=rainbow = id<=all                        = 33,599 = every card
 *   produces:rainbow = produces=rainbow          =    693 = `produces=5`
 *   produces>=rainbow                            =    799 = `produces>=5`
 *   produces<rainbow                             = 32,800 = `produces<5`
 *   produces<=rainbow                            = 33,493 = `produces<=5`
 *   produces>rainbow                             =    106 = `produces>5`
 *   produces!=rainbow                            = 32,906 = `produces!=5`
 *   produces:all = produces=all = produces>=all  =    106 = `produces=6`   produces>all = 0
 *   produces<all = produces!=all                 = 33,493 = `produces<6`   produces<=all = 33,599
 *
 * TWO ROWS REFUTE THE SET READING, and they are why this is a table and not a letter expansion.
 * `id:wubrg` is 33,599 — EVERY card — because `id:` is a subset test, while `id:rainbow` is 129;
 * and `produces:wubrg` is 799 where `produces:rainbow` is 693, because a superset-of-WUBRG test
 * also admits the 106 cards that produce a sixth value. Reading either name as its letters is what
 * made `id:rainbow` answer the unfiltered corpus here.
 *
 * The doc-comment this replaces claimed `produces:all` matched nothing and that
 * `produces:rainbow` = `produces:wubrg` = 13. Both are refuted above by direct probe on the same
 * day the rest of this table was measured; card_engine's own `color_count` had the right number
 * for `produces:all` (106) all along, so the two comments had been contradicting each other.
 */
export const COLOR_SPREAD_COUNT_NAMES: ReadonlySet<string> = new Set(["rainbow", "all"]);

/**
 * The colour-COUNT names that are valid on ONE column only, as `db column -> names`.
 *
 * `any` is the whole table today, and it belongs to produced_mana alone. It is not a set of
 * letters and not a synonym for `m` — it asks whether the card produces ANYTHING — so it lowers
 * to its own (operator, count) pairs, written out at card-query-nodes' PRODUCED_ANY_BY_OPERATOR.
 *
 * MEASURED against api.scryfall.com 2026-08-28, corpus-wide AND against a `t:creature` second
 * base, so no equality below can be read as an accident of the whole-corpus totals:
 *
 *   produces:any = produces=any = produces>any = produces>=any = produces!=any
 *                        = 2,603 = `produces>=1`   (t:creature: 756)
 *   produces<any         = 30,996 = `produces=0`   (t:creature: 17,997)
 *   produces<=any        = 32,139 = `produces<=1`  (t:creature: 18,369)
 *
 * `!=` GROUPS WITH `:` HERE, which is NOT how the `m` table above behaves — there `produces!=m`
 * is the low side (`produces=1`) while `produces:m` is the high side. The asymmetry between the
 * two tables is measured on both bases and is deliberately not tidied: `produces!=any` is 2,603,
 * the same as `produces:any`, not the 30,996 a mirror of the `m` table would give.
 *
 * `<` and `<=` are the two that separate `any` from every count spelling: `produces<any` is
 * `produces=0` (the cards that produce nothing), while `produces<=any` is `produces<=1` — which
 * is `produces=0` plus the 1,143 single-value producers, and is NOT the whole corpus the way
 * `c<=m` is.
 *
 * SCOPED, AND THE SCOPE IS THE POINT. Scryfall does not accept `any` on the colour columns at
 * all: `c:any` on its own answers "All of your terms were ignored", and both `t:creature c:any`
 * and `t:creature id:any` answer `t:creature`'s 18,753 — the term is REJECTED and dropped, not
 * applied. So `any` must never join COLOR_COUNT_NAMES, which every colour column reads; it is
 * reachable only through the column named here, and `c:any` / `id:any` keep the parse error that
 * makes the compat layer drop them exactly as Scryfall does.
 */
export const COLUMN_SCOPED_COUNT_NAMES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["produced_mana", new Set(["any"])],
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
