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
		// Scryfall's COMBINED power-and-toughness keyword, under both of its spellings. Not a stored
		// column: the engine adds the FRONT face's two stats per candidate card (card_engine's
		// `front_power_plus_toughness`, which carries the measurements). A numeric alias like any
		// other, so every comparator, a column on either side (`pt>pow`, `mv>pt`) and this port's
		// own arithmetic all reach it through the code that already serves `pow` and `tou`.
		//
		// Measured on api.scryfall.com 2026-10-03: `pt=2` and `powtou=2` 2,129, `pt:6` and
		// `powtou:6` 2,724, `pt<6` 10,818, `pt<=6` 13,542, `pt>6` 5,357, `pt>=6` 8,081, `pt!=6`
		// 16,175 — all seven operators, on both spellings. `ptsum`, `powertoughness` and the like
		// were never probed and are not here.
		dbColumnName: "power_plus_toughness",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["powtou", "pt"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "planeswalker_loyalty",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["loyalty", "loy"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		// Scryfall's EDHREC-rank keyword, under all three of its spellings (2026-10-03: `edhrec:1`,
		// `edhrecrank:1` and `edhrec_rank:1` are each Sol Ring; `edhrec<=10` 5, `edhrec>=5000 e:khm`
		// 222). The column was here all along, sorted on and never searched. A card with no rank
		// compares as NULL — `edhrec!=1 e:khm` and `edhrec>=0 e:khm` are both 295 of the set's 305.
		dbColumnName: "edhrec_rank",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["edhrec", "edhrecrank", "edhrec_rank"],
		parserClass: ParserClass.NUMERIC,
	},
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
		// LOCAL PATCH (Cloudflare port): Scryfall's `usdfoil` — the printing's own `prices.usd_foil`
		// and nothing coalesced into it. Measured 2026-10-03: `usdfoil>=1 e:khm` 68,
		// `usdfoil<1 e:khm` 229, `usdfoil=0.25 e:khm` 7, `usdfoil>=0 e:khm` 285 of 305 (a printing
		// with no foil price compares as NULL), `usdfoil>=100` 880 cards / 1,234 printings, and
		// `usdfoil>=0 e:cmr is:etched` is 404 — the etched price is not read. It compares against
		// the other columns in both positions (`usdfoil>usd e:khm` 247, `usd>usdfoil e:khm` 57,
		// `usdfoil>eur` 274, `eur>usdfoil` 30). `eurfoil`, `usdetched`, `usd_foil` and `tixfoil`
		// are NOT keywords there (`Unknown keyword`). The engine reads the cents the card object
		// already emits the price from; nothing new is stored.
		dbColumnName: "price_usd_foil",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["usdfoil"],
		parserClass: ParserClass.NUMERIC,
	},
	// LOCAL PATCH (Cloudflare port): Scryfall's five per-CARD counts and its per-printing artist
	// count. STORED since generation 58 — card_engine's `assign_print_counts` decides the five
	// over every printing of the card in every language and carries the rule for each, measured
	// on api.scryfall.com 2026-10-03 by reading a card's printings and binary-searching the value
	// Scryfall holds: Lightning Bolt is prints 77, sets 46, paperprints 68, papersets 41,
	// illustrations 33; Reset 3 / 3 / 2 / 2 / 2. Corpus-wide the same day:
	//
	//   prints=1 13,243   prints>=10 1,521   prints>=100 8   prints=0 404
	//   sets=1 16,115 (= is:unique exactly)   sets>=10 1,068   sets>=50 16
	//   paperprints=1 13,723   paperprints>=10 1,282   paperprints=0 654 (cards only in digital sets)
	//   papersets=1 16,825   papersets>=10 898   papersets=0 654
	//   illustrations=1 25,688   illustrations>=2 7,957   illustrations>=10 95   illustrations=0 4
	//   artists=2 = artists>=2 631   artists=0 12   artists=3 404   artists:1 e:khm all 305
	//
	// Numeric columns like any other: all seven operators, and a column on either side
	// (`prints>sets e:khm` 119, `prints=sets e:khm` 186, `prints>paperprints e:khm` 98,
	// `illustrations>=prints e:khm` 123, `prints>=cmc e:khm` 171, `artists>=cmc e:khm` 59). None
	// opens extras.
	{
		dbColumnName: "print_count",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["prints"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "set_count",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["sets"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "paper_print_count",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["paperprints"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "paper_set_count",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["papersets"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "illustration_count",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["illustrations"],
		parserClass: ParserClass.NUMERIC,
	},
	{
		dbColumnName: "artist_count",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["artists"],
		parserClass: ParserClass.NUMERIC,
	},
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
	// LOCAL PATCH (Cloudflare port): Scryfall's two PRINTING-id keywords, each under both of its
	// spellings. Measured on api.scryfall.com 2026-10-03: `scryfallid:860aa0fe-0337-458c-b864-
	// 5ef5733fbae6` and `scryfall_id:` the same are 1 card (Reset, me3/48), `illustrationid:` /
	// `illustration_id:9e42d409-161d-4e63-8982-71e313f27b2f` 1 card and 2 under `unique=prints`
	// (me3/48 and leg/73 share the artwork). `=` reads as `:`; every other operator matches
	// nothing. The engine compares the printing's own u128 (card_engine `ScryfallIdMatch` /
	// `IllustrationIdMatch`); nothing is stored for them that the store did not already hold.
	{
		dbColumnName: "scryfall_id",
		fieldType: FieldType.TEXT,
		searchAliases: ["scryfallid", "scryfall_id"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "illustration_id",
		fieldType: FieldType.TEXT,
		searchAliases: ["illustrationid", "illustration_id"],
		parserClass: ParserClass.TEXT,
	},
	// LOCAL PATCH (Cloudflare port): Scryfall's four EXTERNAL-id keywords, three spellings each.
	// Measured on api.scryfall.com 2026-10-03 against khm/1 Axgard Braggart (mtgo 87321, arena
	// 75036, tcgplayer 230675, multiverse 503605), each `<kw>:<id> e:khm` = 1:
	//
	//   mtgoid  mtgo_id  mtgo            arenaid  arena_id  arena
	//   tcgplayerid  tcgplayer_id  tcgplayer        multiverseid  multiverse_id  multiverse
	//
	// and NOT `mtgofoilid`, `mtgo_foil_id`, `tcg`, `mvid`, `cardmarketid` or `cardmarket` (each
	// `Unknown keyword`). `=` reads as `:`; every other operator matches nothing. TEXT, because
	// the value is an identifier and not a quantity: nothing compares or does arithmetic on it.
	// The engine reads the ids the card object already emits (card_engine `ExternalIdMatch`,
	// which carries the negation measurements); nothing new is stored.
	{
		dbColumnName: "mtgo_id",
		fieldType: FieldType.TEXT,
		searchAliases: ["mtgoid", "mtgo_id", "mtgo"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "arena_id",
		fieldType: FieldType.TEXT,
		searchAliases: ["arenaid", "arena_id", "arena"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "tcgplayer_id",
		fieldType: FieldType.TEXT,
		searchAliases: ["tcgplayerid", "tcgplayer_id", "tcgplayer"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "multiverse_id",
		fieldType: FieldType.TEXT,
		searchAliases: ["multiverseid", "multiverse_id", "multiverse"],
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
	// LOCAL PATCH (Cloudflare port): Scryfall's `lore:` — the value as a literal substring of the
	// printing's name, its flavor name, its flavor text, the card's oracle text (no reminder text,
	// `~` a plain tilde) or its type line (a plain substring, no type-word anchor). Measured on
	// api.scryfall.com 2026-10-04: `lore:jace` 171, `lore:ft e:khm` 22 (the four-column union with
	// the collated `name:` is 41), `lore:godzilla` 8 (flavor names), `lore:god` 486 against the
	// 468 of `(name:/god/ or ft:god or o:god or t:god)` — the Demigods and the Godzilla names.
	// Not a column: card_engine's `build_binary` composes it from the leaves the four keywords
	// already use plus one for the flavor name, and carries the full measurements.
	{
		dbColumnName: "lore",
		fieldType: FieldType.TEXT,
		searchAliases: ["lore"],
		parserClass: ParserClass.TEXT,
	},
	// LOCAL PATCH (Cloudflare port): Scryfall's `cheapest:` — the printings carrying their card's
	// cheapest price in a currency. Measured on api.scryfall.com 2026-10-04: `cheapest:usd e:khm`
	// 222 of the set's 407 printings, `cheapest:eur` 239, `cheapest:tix` 290; the value is `usd`
	// (`$`, `dollar`), `eur` (`euro`, `€`) or `tix` (`mtgo`), and the compat surface writes
	// `not_<currency>` for the negated TERM, which is not the complement (`-cheapest:usd e:khm`
	// is 5). Not a column: the engine answers from codes its build stores on the printing
	// (card_engine `assign_cheapest_codes`, which carries the rule and its measurements).
	{
		dbColumnName: "cheapest",
		fieldType: FieldType.TEXT,
		searchAliases: ["cheapest"],
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
	// `in:` — "cards that have ever been printed in" (Scryfall's syntax page): a set code, a set
	// type, a game, a language, a rarity, a frame year, or `booster`. A CARD-level fact, decided
	// at build over every printing of the card, canonical AND annex, and stored on the OracleCard
	// as its own collection column — because `tri()` sees one card and one printing and can never
	// answer "does SOME printing of this card" from there. Card-space, like `card_subtypes`; the
	// engine's `assign_in_tags` writes it and `CollField::InTags` reads it — and its doc comment
	// carries the measured rule per namespace (rarity skips the set types where it is decorative;
	// finishes skip digital-only printings; everything else is every printing).
	//
	// No value validator, because Scryfall has none: `in:nonsense` and `in:zz` are 404s there
	// with no warnings key, honored and matching nothing, and an unknown word here names a tag no
	// card carries. Compared under `:`/`=` only — `in>=rare` is a 404 there, which the compat
	// surface's comparison rule already answers.
	{
		dbColumnName: "card_in_tags",
		fieldType: FieldType.JSONB_OBJECT,
		searchAliases: ["in"],
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
		// `edition` is Scryfall's fourth spelling of the keyword: `edition:khm t:god` =
		// `edition=khm t:god` = `e:khm t:god` = 12, and it opens extras on the condition `e:` does
		// (`edition:lea or cmc=3` echoes include_extras=true, `edition:war or cmc=3` false).
		// Measured 2026-10-03.
		searchAliases: ["set", "s", "e", "edition"],
		parserClass: ParserClass.TEXT,
	},
	{
		dbColumnName: "collector_number",
		fieldType: FieldType.TEXT,
		searchAliases: ["number", "cn"],
		parserClass: ParserClass.TEXT,
	},
	{
		// `collector`/`collectornumber` are Scryfall's spellings of the NUMERIC collector number and
		// of nothing else — unlike `cn`/`number` they have no string half. Measured 2026-10-03,
		// anchor `e:khm` = 305: `collector:1` = `collectornumber:1` = `collector=1` 1,
		// `collector>=390` 17 = `cn>=390`, `collector<5` 4, `collector>=cmc` 303 = `cn>=cmc`, and
		// `collector>cn` is refused with `The sides of your comparison must be different.` — one
		// column. A value that is not a number is `Unknown keyword “collector”.` (`collector:abc`,
		// `collector:a-40`, `collector:★`, `collector:"1"`) where `cn:abc` is honored and matches
		// nothing, and `-collector:1` is `Unknown keyword “-collector”.` where `-cn:1` is 304: the
		// numeric columns' sentences, which query-terms.ts reproduces.
		dbColumnName: "collector_number_int",
		fieldType: FieldType.NUMERIC,
		searchAliases: ["number", "cn", "collector", "collectornumber"],
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
	// LOCAL PATCH (Cloudflare port): Scryfall's `stamp:` — the printing's security stamp. Measured
	// 2026-10-03: `stamp:oval` 9,760 cards / 34,726 printings, `triangle` 2,412 / 6,446, `arena`
	// 525, `acorn` 141 / 296, `circle` 36, `heart` 8; `stamp:oval e:khm` = `stamp=oval e:khm` =
	// `stamp:OVAL e:khm` 94 and `-stamp:oval e:khm` 216. Any other value is ignored with
	// `Unknown security stamp “<value>”` (SECURITY_STAMPS below; query-terms.ts says it). The
	// engine compares the stamp the card object already emits; nothing new is stored.
	{
		dbColumnName: "security_stamp",
		fieldType: FieldType.TEXT,
		searchAliases: ["stamp"],
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
 * `is:funny`. Scryfall's is a PER-PRINTING class and not a set type, and this port rewrote it to
 * `st:funny` on the premise that the difference was unobservable because funny sets were not
 * imported. That premise died with the `all_cards` import: unk (a funny set) is served, and the
 * Mystery Booster 2 playtest cards are in the store as extras. Measured 2026-09-08 (unique=cards):
 * `t:conspiracy -is:funny` is 25 on api.scryfall.com and was 27 here — mb2/503 Marchesa's Surprise
 * Party and mb2/505 Rule with an Even Hand, both `promo_types: [playtest]` in a `masters` set —
 * and `set:mb2 is:funny` was 121 there against 0 here, `is:playtest is:funny` 795 against 0.
 *
 * THE RULE, reverse-engineered and measured (include:extras=true, unique=cards):
 *
 *     never legal in ANY format
 *     AND (st:funny OR is:playtest OR border:silver OR stamp:acorn)
 *     AND NOT st:token
 *
 * Never-legal is NECESSARY: `is:funny` intersected with legality in any of the 21 formats is 0,
 * and all 190 of `st:funny -is:funny` are legal somewhere (Unfinity's eternal-legal half). The
 * disjunction is what reaches the non-funny-set printings: `is:playtest -is:funny` is exactly 1,
 * sld/SCTLR Counterspell, legal in historic/timeless. The `-st:token` clause keeps out 14
 * silver-bordered tust/tugl tokens Scryfall calls not funny. Residual 11 of 1,461, named at the
 * builder's `FUNNY_IS_TAG` — against 341 for the set-type rewrite it replaces.
 *
 * AND IT ASKS THE CARD'S OTHER PRINTINGS (generation 56). That rule reads one printing; a
 * printing with none of its signals is still funny on Scryfall when a sibling has one — sld/869
 * Blacker Lotus for ugl/70, olep's oversized Unglued cards, past/2 Call from the Grave for its
 * playtest reprint — and a token is funny exactly when its FIRST printing was (the h17 Dragon's
 * three printings are, the 99 Treasures are not, hho/21★ included). Measured 2026-10-01
 * (unique=prints): 1,966 of api.scryfall.com's 1,973 and nothing it lacks; the seven left have no
 * funny printing on their card. The rule is on the builder's `FunnyCards`.
 *
 * Computed by the importer, like `extra`, because it reads five fields of the printing at once —
 * and then the card's other printings, which only an importer holds together. Spelled once here
 * and once as the builder's `FUNNY_IS_TAG`.
 */
export const FUNNY_IS_TAG = "funny";

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

/**
 * `is:commander`, `is:brawler`, `is:duelcommander`, `is:oathbreaker` — who can lead a deck.
 * Computed by the importer from the FRONT face (the one you cast: a flip card's unflipped half, a
 * transform or modal card's front, both halves of a split), never a token or a meld result, and
 * from the printing's own legalities — including `competitivebrawl`, a format the engine has no
 * column for, and duel's `restricted`, which is how Scryfall writes Duel Commander's "banned as
 * commander" list.
 *
 * They were rewrites here until generation 55, and every rewrite read the MERGED row — every
 * face's types, toughness and text at once — so it answered for cards no one can cast as a
 * commander: `is:commander is:flip` 19 against api.scryfall.com's 4 (Budoka Pupil // Ichiga),
 * `is:commander is:transform` 102 against 86 (Westvale Abbey // Ormendahl), `is:commander is:meld`
 * 12 against 7 (the five meld RESULTS), `is:oathbreaker` 310 against 288 (Kytheon, Valki // Tibalt,
 * Urza, Planeswalker). The rules and their measurements are written at the builder's
 * `COMMANDER_IS_TAG`.
 *
 * Spelled once here and once as the builder's constants of the same names.
 */
export const COMMANDER_IS_TAG = "commander";
export const BRAWLER_IS_TAG = "brawler";
export const DUEL_COMMANDER_IS_TAG = "duelcommander";
export const OATHBREAKER_IS_TAG = "oathbreaker";

/**
 * `is:spell` — a card with a CASTABLE face that is a spell: not a land, not a token, not a card
 * type nothing is cast as (plane, scheme, conspiracy, dungeon, …), and not an Attraction or
 * Contraption. It was a type union over the merged row, which let Unfinity's Attractions and the
 * artifact lands in (32,446 against api.scryfall.com's 32,327). The rule and its measurement are
 * written at the builder's `SPELL_IS_TAG`. Spelled once here and once there.
 */
export const SPELL_IS_TAG = "spell";

export const COMPUTED_IS_TAGS: ReadonlySet<string> = new Set([
	EXTRA_IS_TAG,
	FUNNY_IS_TAG,
	HYBRID_IS_TAG,
	MELD_PART_IS_TAG,
	MELD_RESULT_IS_TAG,
	COMMANDER_IS_TAG,
	BRAWLER_IS_TAG,
	DUEL_COMMANDER_IS_TAG,
	OATHBREAKER_IS_TAG,
	SPELL_IS_TAG,
]);

export const BOOLEAN_IS_TAGS: ReadonlyMap<string, string> = new Map([
	["booster", "booster"],
	// `is:contentwarning` (and `is:content_warning`: Scryfall drops `_` and `-` from an `is:` value)
	// is the bulk card's `content_warning` flag. Measured 2026-10-04: 7 cards / 28 printings on
	// api.scryfall.com, every one carrying the flag, and the 8,111 printings production serves
	// from the same 20 sets hold exactly those 28 with it — the same ids.
	["contentwarning", "content_warning"],
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
 *
 * ─── FIVE MORE, 2026-10-04 ───────────────────────────────────────────────────────────────────
 *
 * `premiereshop`, `schinesealtart`, `setextension`, `singularityfoil` and `themepack` are
 * `promo_types` members the 2026-09-03 enumeration never saw (its eight queries did not page
 * them), found by sweeping 619 candidate `is:` values against api.scryfall.com. Each was
 * established in BOTH directions, over printings with extras in: every printing Scryfall returns
 * carries the member (51 / 61 / 50 / 1 / 33 printings), and of the printings production serves
 * from the sets those answers touch, the ones carrying the member are exactly the same ids.
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
	// No `partner` row: `is:partner` is Scryfall's "pairs as a commander" set, which rewrite.ts
	// expands (228 cards there and here); the `keywords ∋ Partner` row it had shadowed since
	// 2026-09-22 answered 134, and left the archive with generation 55.
	["planeswalker_deck", ["promo_types", "planeswalkerdeck"]],
	["player_rewards", ["promo_types", "playerrewards"]],
	["playpromo", ["promo_types", "playpromo"]],
	// Missing from the 2026-09-03 enumeration; `is:playtest` is 796 on api.scryfall.com (2026-09-08).
	["playtest", ["promo_types", "playtest"]],
	["portrait", ["promo_types", "portrait"]],
	["poster", ["promo_types", "poster"]],
	["premiereshop", ["promo_types", "premiereshop"]],
	["prerelease", ["promo_types", "prerelease"]],
	["promopack", ["promo_types", "promopack"]],
	["rainbowfoil", ["promo_types", "rainbowfoil"]],
	["raisedfoil", ["promo_types", "raisedfoil"]],
	["ravnicacity", ["promo_types", "ravnicacity"]],
	["rebalanced", ["promo_types", "rebalanced"]],
	["release", ["promo_types", "release"]],
	["resale", ["promo_types", "resale"]],
	["ripplefoil", ["promo_types", "ripplefoil"]],
	["schinesealtart", ["promo_types", "schinesealtart"]],
	["scroll", ["promo_types", "scroll"]],
	["serialized", ["promo_types", "serialized"]],
	["set_promo", ["promo_types", "setpromo"]],
	["setextension", ["promo_types", "setextension"]],
	["silverfoil", ["promo_types", "silverfoil"]],
	["silverscroll", ["promo_types", "silverscroll"]],
	["singularityfoil", ["promo_types", "singularityfoil"]],
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
	["themepack", ["promo_types", "themepack"]],
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
