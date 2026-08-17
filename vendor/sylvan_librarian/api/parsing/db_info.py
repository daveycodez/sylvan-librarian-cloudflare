"""Database field information and mappings for Scryfall queries."""

from __future__ import annotations

from enum import StrEnum


class FieldType(StrEnum):
    """Enumeration of supported database field types."""

    JSONB_ARRAY = "jsonb_array"
    JSONB_OBJECT = "jsonb_object"
    NUMERIC = "numeric"
    TEXT = "text"
    DATE = "date"


class ParserClass(StrEnum):
    """Enumeration of parser classes for different field types."""

    NUMERIC = "numeric"  # Supports arithmetic operations (cmc, power, etc.)
    MANA = "mana"  # Mana cost fields with special mana value parsing
    RARITY = "rarity"  # Rarity fields with string-to-numeric conversion
    LEGALITY = "legality"  # Format/legal fields with JSON handling
    COLOR = "color"  # Color fields (card colors and color identity)
    TEXT = "text"  # Simple text fields (name, artist, oracle text)
    DATE = "date"  # Date fields with full date values
    YEAR = "year"  # Year fields with 4-digit year values


class FieldInfo:
    """Information about a database field and its search aliases."""

    def __init__(self, *, db_column_name: str, field_type: FieldType, search_aliases: list[str], parser_class: ParserClass) -> None:
        """Initialize field information.

        Args:
            db_column_name: The actual database column name.
            field_type: The type of the field.
            search_aliases: List of search aliases for this field.
            parser_class: The parser class to use for this field. If None, defaults based on field_type.
        """
        self.db_column_name = db_column_name
        self.field_type = field_type
        self.search_aliases = search_aliases
        # Default parser class based on field type if not specified
        if parser_class is None:
            parser_class = ParserClass.NUMERIC if field_type == FieldType.NUMERIC else ParserClass.TEXT
        self.parser_class = parser_class

    def __repr__(self: FieldInfo) -> str:
        """Return a string representation of the field info."""
        return (
            "FieldInfo("
            f"db_column_name={self.db_column_name}, "
            f"field_type={self.field_type}, "
            f"search_aliases={self.search_aliases}, "
            f"parser_class={self.parser_class}"
            ")"
        )


DB_COLUMNS = [
    FieldInfo(
        db_column_name="card_artist",
        field_type=FieldType.TEXT,
        search_aliases=["artist", "a"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_colors",
        field_type=FieldType.JSONB_OBJECT,
        # `colour`/`colours` are Scryfall's British spellings and answer identically (`colour:wu e:khm`
        # = `c:wu e:khm` = 6, measured 2026-08-16). `color_identity`/`coloridentity` below are the
        # reverse case -- spellings THIS parser accepts and Scryfall does not -- and are left alone:
        # answering where Scryfall warns costs a searcher nothing, while removing them would break
        # queries that already work.
        search_aliases=["color", "colors", "colour", "colours", "c"],
        parser_class=ParserClass.COLOR,
    ),
    FieldInfo(
        db_column_name="card_color_identity",
        field_type=FieldType.JSONB_OBJECT,
        # `commander` is how a player actually searches a commander's colours, and it is plain colour
        # IDENTITY: `commander:wu e:khm` = `id:wu e:khm` = 117, and it takes the counts too
        # (`commander:m e:khm` = `commander>=2 e:khm` = 74). Scryfall's identity vocabulary is a
        # BOUNDARY -- `cid`, `commanderidentity`, `colouridentity` and `colour_identity` all come
        # back "Unknown keyword" -- so nothing else joins it.
        search_aliases=["color_identity", "coloridentity", "id", "identity", "ci", "commander"],
        parser_class=ParserClass.COLOR,
    ),
    FieldInfo(
        db_column_name="card_frame_data",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["frame"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_keywords",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["keyword", "kw"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_name",
        field_type=FieldType.TEXT,
        search_aliases=["name"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_subtypes",
        field_type=FieldType.JSONB_ARRAY,
        search_aliases=["subtype", "subtypes"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_types",
        field_type=FieldType.JSONB_ARRAY,
        search_aliases=["type", "types", "t"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="cmc",
        field_type=FieldType.NUMERIC,
        search_aliases=["cmc", "mv", "manavalue"],
        parser_class=ParserClass.NUMERIC,
    ),
    FieldInfo(
        db_column_name="creature_power",
        field_type=FieldType.NUMERIC,
        search_aliases=["power", "pow"],
        parser_class=ParserClass.NUMERIC,
    ),
    FieldInfo(
        db_column_name="creature_toughness",
        field_type=FieldType.NUMERIC,
        search_aliases=["toughness", "tou"],
        parser_class=ParserClass.NUMERIC,
    ),
    FieldInfo(
        db_column_name="planeswalker_loyalty",
        field_type=FieldType.NUMERIC,
        search_aliases=["loyalty", "loy"],
        parser_class=ParserClass.NUMERIC,
    ),
    FieldInfo(
        db_column_name="edhrec_rank",
        field_type=FieldType.NUMERIC,
        search_aliases=[],
        parser_class=ParserClass.NUMERIC,
    ),
    FieldInfo(
        db_column_name="mana_cost_jsonb",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["mana", "m"],
        parser_class=ParserClass.MANA,
    ),
    FieldInfo(
        db_column_name="devotion",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["devotion"],
        parser_class=ParserClass.MANA,
    ),
    FieldInfo(
        db_column_name="price_usd",
        field_type=FieldType.NUMERIC,
        search_aliases=["usd"],
        parser_class=ParserClass.NUMERIC,
    ),
    FieldInfo(
        db_column_name="price_eur",
        field_type=FieldType.NUMERIC,
        search_aliases=["eur"],
        parser_class=ParserClass.NUMERIC,
    ),
    FieldInfo(
        db_column_name="price_tix",
        field_type=FieldType.NUMERIC,
        search_aliases=["tix"],
        parser_class=ParserClass.NUMERIC,
    ),
    FieldInfo(
        db_column_name="produced_mana",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["produces"],
        parser_class=ParserClass.COLOR,
    ),
    FieldInfo(
        db_column_name="raw_card_blob",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=[],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="oracle_id",
        field_type=FieldType.TEXT,
        search_aliases=["oracleid", "oracle_id"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="oracle_text",
        field_type=FieldType.TEXT,
        # `fo:`/`fulloracle:` are Scryfall's FULL-oracle spellings and share this column: the
        # stored `oracle_text` IS the full text, reminder text included, so the SQL path answers
        # both from it and needs no second column. They are told apart downstream by
        # `original_attribute` -- which matters only to the card engine, whose searchable oracle
        # column has reminder text stripped out of it the way Scryfall's `o:` does.
        # Measured on api.scryfall.com 2026-08-16: `fo:lifelink` 713 / `o:lifelink` stripped,
        # `fo:draw e:khm` 57 / `o:draw e:khm` 39, `fo:/\(this creature/` 1,098 / `o:/\(/` 0.
        search_aliases=["oracle", "o", "fo", "fulloracle"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="flavor_text",
        field_type=FieldType.TEXT,
        search_aliases=["flavor", "ft"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_oracle_tags",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["oracle_tags", "otag", "oracletag", "function"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_art_tags",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["art_tags", "art", "atag", "arttag"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_is_tags",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["is", "has"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_rarity_int",
        field_type=FieldType.NUMERIC,
        search_aliases=["rarity", "r"],
        parser_class=ParserClass.RARITY,
    ),
    FieldInfo(
        db_column_name="card_set_code",
        field_type=FieldType.TEXT,
        search_aliases=["set", "s", "e"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="collector_number",
        field_type=FieldType.TEXT,
        search_aliases=["number", "cn"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="collector_number_int",
        field_type=FieldType.NUMERIC,
        search_aliases=["number", "cn"],
        parser_class=ParserClass.NUMERIC,
    ),  # No direct aliases - will be routed
    FieldInfo(
        db_column_name="card_legalities",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["format", "f", "legal", "banned", "restricted"],
        parser_class=ParserClass.LEGALITY,
    ),
    FieldInfo(
        db_column_name="card_lang",
        field_type=FieldType.TEXT,
        search_aliases=["lang", "language"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_set_type",
        field_type=FieldType.TEXT,
        search_aliases=["set_type", "settype", "st"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_layout",
        field_type=FieldType.TEXT,
        search_aliases=["layout"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_border",
        field_type=FieldType.TEXT,
        search_aliases=["border"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="card_watermark",
        field_type=FieldType.TEXT,
        search_aliases=["watermark", "wm"],
        parser_class=ParserClass.TEXT,
    ),
    FieldInfo(
        db_column_name="released_at",
        field_type=FieldType.DATE,
        search_aliases=["date"],
        parser_class=ParserClass.DATE,
    ),
    FieldInfo(
        db_column_name="released_at",
        field_type=FieldType.DATE,
        search_aliases=["year"],
        parser_class=ParserClass.YEAR,
    ),
]

KNOWN_CARD_ATTRIBUTES = set()
NUMERIC_CARD_ATTRIBUTES: set[str] = set()
SEARCH_NAME_TO_DB_NAME = {}
DB_NAME_TO_FIELD_TYPE = {}

ALIAS_TO_FIELD_INFOS: dict[str, list[FieldInfo]] = {}
COLNAME_TO_FIELD_INFOS: dict[str, list[FieldInfo]] = {}
PARSER_CLASS_TO_FIELD_INFOS: dict[ParserClass, list[FieldInfo]] = {}

for col in DB_COLUMNS:
    for ialias in col.search_aliases:
        ALIAS_TO_FIELD_INFOS.setdefault(ialias.lower(), []).append(col)

    COLNAME_TO_FIELD_INFOS.setdefault(col.db_column_name, []).append(col)
    PARSER_CLASS_TO_FIELD_INFOS.setdefault(col.parser_class, []).append(col)

    KNOWN_CARD_ATTRIBUTES.add(col.db_column_name.lower())
    KNOWN_CARD_ATTRIBUTES.update(alias.lower() for alias in col.search_aliases)
    if col.parser_class == ParserClass.NUMERIC:
        NUMERIC_CARD_ATTRIBUTES.add(col.db_column_name.lower())
        NUMERIC_CARD_ATTRIBUTES.update(alias.lower() for alias in col.search_aliases)
    SEARCH_NAME_TO_DB_NAME[col.db_column_name.lower()] = col.db_column_name
    DB_NAME_TO_FIELD_TYPE[col.db_column_name] = col.field_type

    for ialias in col.search_aliases:
        SEARCH_NAME_TO_DB_NAME[ialias.lower()] = col.db_column_name


CARD_SUPERTYPES = {
    "Basic",
    "Legendary",
    "Snow",
    "World",
}

CARD_TYPES = {
    "Artifact",
    "Battle",  # reaches the corpus once faces merge (#400): every battle is a transform front
    "Conspiracy",
    "Creature",
    "Enchantment",
    "Instant",
    "Kindred",  # new name for tribal
    "Land",
    "Planeswalker",
    "Sorcery",
    "Tribal",
}

COLOR_CODE_TO_NAME = {
    "b": "black",
    "c": "colorless",
    "g": "green",
    "r": "red",
    "u": "blue",
    "w": "white",
}

COLOR_NAME_TO_CODE = {v: k for k, v in COLOR_CODE_TO_NAME.items()}

# Every colour NAME Scryfall's search accepts, as the letter set that name spells.
#
# The guild / shard / wedge vocabulary is what players actually type -- `c:azorius` is a normal
# thing to write and this parser answered it with a parse error -- so the whole table was measured
# rather than guessed, one request each against api.scryfall.com (`c:<value> e:khm`, 2026-08-16),
# and every accepted name then checked against its letter spelling over the WHOLE corpus. Kaldheim
# holds exactly one card of three colours or more, so a set-scoped check would have agreed with
# almost any mapping; the corpus-wide pairs are the ones that pin it: `c:bant` = `c:gwu` = 153,
# `c:esper` = `c:wub` = 146, `c:yore-tiller` = `c:wubr` = 62, `c:witch-maw` = `c:gwub` = 63,
# `c:rainbow` = `c:wubrg` = 60, `c:brown` = `c:c` = 4,300, and so on for all 24 pairs.
#
# It is a BOUNDARY rather than a superset. `yore`, `glint`, `dune`, `ink` and `witch` on their own
# come back "Unknown color ..." -- the un-hyphenated four-colour nicknames are NOT in Scryfall's
# table, only the hyphenated forms and the five one-word synonyms are -- and so do `five`, `mono`,
# `guild`, `shard`, `wedge`, `nephilim` and `chromatic`.
#
# `all` spells `wubrgc` where `rainbow` spells `wubrg`, and the difference is measured rather than
# cosmetic: for card_colors and card_color_identity the `c` drops out, so `c:all` = `c:wubrg` = 60,
# while for produced_mana it does not, so `produces:all` matches nothing (no card produces all six)
# where `produces:rainbow` = `produces:wubrg` = 13. One table serves all three columns because
# `get_colors_comparison_object` already draws exactly that line.
#
# NOT here: the colour-COUNT names, which spell no letters at all -- see COLOR_COUNT_NAMES below.
COLOR_ALIAS_TO_CODES = {
    # the five colours, colourless, and the British and slang spellings of the latter
    "white": "w",
    "blue": "u",
    "black": "b",
    "red": "r",
    "green": "g",
    "colorless": "c",
    "colourless": "c",
    "brown": "c",
    # the ten Ravnica guilds
    "azorius": "wu",
    "dimir": "ub",
    "rakdos": "br",
    "gruul": "rg",
    "selesnya": "gw",
    "orzhov": "wb",
    "izzet": "ur",
    "golgari": "bg",
    "boros": "rw",
    "simic": "gu",
    # the five Alara shards
    "bant": "gwu",
    "esper": "wub",
    "grixis": "ubr",
    "jund": "brg",
    "naya": "rgw",
    # the five Khans wedges
    "abzan": "wbg",
    "jeskai": "urw",
    "sultai": "bgu",
    "mardu": "rwb",
    "temur": "gur",
    # the five four-colour names, hyphenated (the Nephilim) and as one word
    "yore-tiller": "wubr",
    "glint-eye": "ubrg",
    "dune-brood": "brgw",
    "ink-treader": "rgwu",
    "witch-maw": "gwub",
    "artifice": "wubr",
    "chaos": "ubrg",
    "aggression": "brgw",
    "altruism": "rgwu",
    "growth": "gwub",
    # all five colours, and all six values
    "rainbow": "wubrg",
    "all": "wubrgc",
}

# The colour values that are a COUNT rather than a set of letters.
#
# `c:m` is not "the colour m" -- there is no such colour. It is Scryfall's word for MULTICOLOURED,
# and it compares the NUMBER of colours in the column, which is why it cannot live in
# COLOR_ALIAS_TO_CODES beside `azorius`: there are no letters to expand. `gold` and the
# `multicolor` spellings are the same value under other names; every one of the six answers the
# identical count (`c:m` = `c:gold` = `c:multicolor` = `c:multicolored` = `c:multicolour` =
# `c:multicoloured` = 44 in Kaldheim, where `c:2` = 43 and `c>=2` = 44).
#
# THE OPERATOR TABLE IS MEASURED, and it is not "substitute the number 2". Corpus-wide against
# api.scryfall.com, 2026-08-16:
#
#   c:m = c=m = c>m = c>=m = 4,607 = `c>=2`          (`c=2` is 3,811 and `c>2` is 796)
#   c<m = c!=m           = 29,049 = `c<2`            (`c!=2` is 29,836)
#   c<=m                 = 33,599 = EVERY CARD       (`c<=2` is 32,812)
#
# `>` is the surprise on the high side -- `c>m` is `c>=2`, not `c>2` -- and `!=` is the surprise on
# the low side: `c!=m` is `c<2`, the negation of "is multicoloured", NOT `c!=2`, which would also
# admit the 796 three-and-more-colour cards. `<=` is a tautology rather than `c<=2`, pinned against
# a second term so it cannot be read as "the whole corpus": `c<=m t:creature` = `t:creature`
# = `c<=5 t:creature` = 18,753 where `c<=2 t:creature` = 18,140.
#
# The identity spellings take the same table on their own column: `id:m` = `id=m` = `id>m` =
# `id>=m` = 5,831 = `id>=2`, `id<m` = `id!=m` = 27,768 = `id<2` (`id!=2` is 28,824), and
# `id<=m` = 33,599 = every card (`id<=2` is 32,543).
#
# `produces:` takes the same table, but over SIX values rather than five, and that asymmetry is
# measured rather than tidy: produced_mana is the one colour-ish column whose array can literally
# contain "C" (Sol Ring produces ["C"] while its colors and color_identity are both []). So
# `produces=6` = 106 = `produces:all` -- a count no five-key popcount can even reach -- the 481
# cards that produce colorless and nothing else answer `produces=1` rather than `produces=0`, the
# three producing exactly {C,W} land in `produces=2` and not `produces=1`, and counts 0..6 partition
# the corpus exactly (30,996 + 1,143 + 504 + 147 + 10 + 693 + 106 = 33,599). The colour columns must
# keep counting five: `c:all` = `c:wubrg` = `c=5` = 60, and `c=6` is not a valid query there at all
# ("Unknown color 6"). Both halves are pinned by tests so the asymmetry is not "fixed" later.
#
# `produces:m` = `produces=m` = `produces>m` = `produces>=m` = 1,460 = `produces>=2`
# (`produces=2` is 504), while `produces<m` = `produces!=m` = 1,143 = `produces=1` -- NOT
# `produces<2` (32,139), which sweeps in the cards that produce nothing -- and `produces<=m` =
# 2,603 = `produces>=1` rather than every card.
COLOR_COUNT_NAMES = frozenset(
    {
        "m",
        "gold",
        "multicolor",
        "multicolour",
        "multicolored",
        "multicoloured",
    }
)

FORMAT_CODE_TO_NAME = {
    "m": "modern",
    "s": "standard",
    "l": "legacy",
    "p": "pauper",
    "c": "commander",
    "v": "vintage",
    "h": "historic",
}

FORMAT_NAME_TO_CODE = {v: k for k, v in FORMAT_CODE_TO_NAME.items()}

# The `is:` values Scryfall ships as BOOLEANS on every bulk card object, as
# {card_is_tags key: raw blob key}. `_sync_boolean_is_tags` rebuilds the column from these after
# each import -- no per-tag API sweep, unlike api_resource.CUSTOM_IS_TAGS, and no accumulation in
# the import loop -- and `rewrite.SUPPORTED_IS_VALUES` reads the keys so the parser knows which
# `is:` values have data behind them. Adding a field here is the whole change on both sides; it
# lives in db_info rather than api_resource because the parser cannot import that module.
#
# `promo`/`reprint`/`foil` were held back once over their cardinality -- they cover 6,125 / 17,150 /
# 29,829 cards against `reserved`'s 571 -- so the memory question was asked before landing them and
# then answered: the same corpus (2026-08-16 all_cards, 31,724 cards / 517,746 rows) built twice,
# archives totalling 363.02 MiB before and 364.17 MiB after. +1.16 MiB, +0.32%, for three of the
# densest tags in the vocabulary, because a value carried by that share of the corpus stores as a
# bitmap plane rather than a posting list. `foil` is Scryfall's deprecated top-level boolean, which
# says the same thing as `finishes` containing "foil"; reading the boolean keeps every entry here on
# the one shape `_sync_boolean_is_tags` can express in SQL.
BOOLEAN_IS_TAGS: dict[str, str] = {
    "booster": "booster",
    "digital": "digital",
    "foil": "foil",
    "fullart": "full_art",
    "gamechanger": "game_changer",
    "hires": "highres_image",
    "nonfoil": "nonfoil",
    "promo": "promo",
    "reprint": "reprint",
    "reserved": "reserved",
    "spotlight": "story_spotlight",
    "textless": "textless",
    "variation": "variation",
}

# The `is:` values Scryfall ships as membership in a bulk ARRAY rather than as a boolean, as
# `card_is_tags key -> (raw blob array key, member)`. Same contract as BOOLEAN_IS_TAGS in every
# other respect — `_sync_is_tags` rebuilds both from raw_card_blob in one statement, and the
# parser reads both keys for `SUPPORTED_IS_VALUES`.
#
# Every mapping below was established by READING the cards Scryfall returns rather than by
# guessing the spelling: `is:X` was fetched from api.scryfall.com on 2026-08-16 and the
# `promo_types` arrays of the results intersected, which is what turns `is:judge` into
# `judgegift` and `is:stamped` into `stamped` (its results also all carry `promopack`, which is
# the broader tag and not the one asked for). `is:prerelease` and `is:rebalanced` are the same
# shape — both intersections carry a second, broader member (`datestamped`, `alchemy`) that has
# its own `is:` value, so the narrower one is the mapping.
#
# NOT here, deliberately: `is:intro` (set-shaped — the results share set_type box/core, no promo
# type), `is:masterpiece` (set_type masterpiece), `is:alchemy` (set_type alchemy) and
# `is:scryfallpreview` (7 cards, no shared promo type). Those want a set-type predicate, not a
# tag, and are left warning until one exists.
ARRAY_IS_TAGS: dict[str, tuple[str, str]] = {
    "boosterfun": ("promo_types", "boosterfun"),
    "buyabox": ("promo_types", "buyabox"),
    "convention": ("promo_types", "convention"),
    "datestamped": ("promo_types", "datestamped"),
    "etched": ("finishes", "etched"),
    "fnm": ("promo_types", "fnm"),
    "gameday": ("promo_types", "gameday"),
    "giftbox": ("promo_types", "giftbox"),
    "glossy": ("promo_types", "glossy"),
    "instore": ("promo_types", "instore"),
    "judge": ("promo_types", "judgegift"),
    "league": ("promo_types", "league"),
    "prerelease": ("promo_types", "prerelease"),
    "rebalanced": ("promo_types", "rebalanced"),
    "release": ("promo_types", "release"),
    "stamped": ("promo_types", "stamped"),
    "universesbeyond": ("promo_types", "universesbeyond"),
}
