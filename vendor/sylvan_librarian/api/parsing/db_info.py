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
    # A distinct FieldInfo from "is" above, sharing its db_column_name, so a `not:` leaf
    # generates the identical SQL/explanation as `is:` on its own -- rewrite.py's
    # negate_not_prefix distinguishes the two via original_attribute and supplies the
    # negation Scryfall's docs describe ("not: is the same as -is:").
    FieldInfo(
        db_column_name="card_is_tags",
        field_type=FieldType.JSONB_OBJECT,
        search_aliases=["not"],
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

FORMAT_CODE_TO_NAME = {
    "m": "modern",
    "s": "standard",
    "l": "legacy",
    "p": "pauper",
    "c": "commander",
    "v": "vintage",
    "h": "historic",
}

# The `is:` values derivable from a card's own row, as {card_is_tags key: boolean SQL expression}.
# `_sync_boolean_is_tags` rebuilds the column from these after each import -- no per-tag API sweep,
# unlike admin_resource.CUSTOM_IS_TAGS, and no accumulation in the import loop -- and
# `rewrite.SUPPORTED_IS_VALUES` reads the keys so the parser knows which `is:` values have data
# behind them. Adding a tag here is the whole change on both sides; it lives in db_info rather than
# admin_resource because the parser cannot import that module.
#
# Each expression must reference the row alias `cards` (it runs inside a correlated subquery, not a
# plain WHERE). Upstream #1000 generalized this from {tag: blob key} to an arbitrary expression,
# which is what lets one mechanism cover plain top-level booleans, promo_types/keywords/finishes
# array membership, single-field lookups (set_type, preview.source) and, per #1001,
# `mana_cost_text` regexes -- the last of which replaces a brittle ~15-term OR rewrite for
# `is:hybrid`/`is:phyrexian` over an open, growing symbol set.
#
# `promo`/`reprint`/`foil` were held back once over their cardinality -- they cover 6,125 / 17,150 /
# 29,829 cards against `reserved`'s 571 -- so the memory question was asked before landing them and
# then answered: the same corpus (2026-08-16 all_cards, 31,724 cards / 517,746 rows) built twice,
# archives totalling 363.02 MiB before and 364.17 MiB after. +1.16 MiB, +0.32%, for three of the
# densest tags in the vocabulary, because a value carried by that share of the corpus stores as a
# bitmap plane rather than a posting list. `foil` is Scryfall's deprecated top-level boolean, which
# says the same thing as `finishes` containing "foil".
#
# Spelling: the KEY is the word a player types, so it follows Scryfall's own syntax page --
# `is:judge_gift`, not `is:judgegift` (the concatenated form is the promo_types MEMBER, on the
# right-hand side). `rewrite.py` carries `is:judge` as an alias onto it, because Scryfall accepts
# that spelling too.
BOOLEAN_IS_TAGS: dict[str, str] = {
    # -- plain top-level booleans on the bulk card object --------------------------------
    "booster": "cards.raw_card_blob->'booster' = 'true'::jsonb",
    "digital": "cards.raw_card_blob->'digital' = 'true'::jsonb",
    "foil": "cards.raw_card_blob->'foil' = 'true'::jsonb",
    "fullart": "cards.raw_card_blob->'full_art' = 'true'::jsonb",
    "gamechanger": "cards.raw_card_blob->'game_changer' = 'true'::jsonb",
    "hires": "cards.raw_card_blob->'highres_image' = 'true'::jsonb",
    "nonfoil": "cards.raw_card_blob->'nonfoil' = 'true'::jsonb",
    "oversized": "cards.raw_card_blob->'oversized' = 'true'::jsonb",
    "promo": "cards.raw_card_blob->'promo' = 'true'::jsonb",
    "reprint": "cards.raw_card_blob->'reprint' = 'true'::jsonb",
    "reserved": "cards.raw_card_blob->'reserved' = 'true'::jsonb",
    "spotlight": "cards.raw_card_blob->'story_spotlight' = 'true'::jsonb",
    "textless": "cards.raw_card_blob->'textless' = 'true'::jsonb",
    "variation": "cards.raw_card_blob->'variation' = 'true'::jsonb",
    # -- array membership (promo_types, finishes, keywords) ------------------------------
    #
    # Every promo_types mapping was established by READING the cards Scryfall returns rather than
    # by guessing the spelling: `is:X` was fetched from api.scryfall.com on 2026-08-16 and the
    # `promo_types` arrays of the results intersected, which is what turns `is:judge_gift` into
    # `judgegift` and `is:stamped` into `stamped` (its results also all carry `promopack`, which is
    # the broader tag and not the one asked for). `is:prerelease` and `is:rebalanced` are the same
    # shape -- both intersections carry a second, broader member (`datestamped`, `alchemy`) that
    # has its own `is:` value, so the narrower one is the mapping.
    "arena_league": "cards.raw_card_blob->'promo_types' @> '\"arenaleague\"'",
    "boosterfun": "cards.raw_card_blob->'promo_types' @> '\"boosterfun\"'",
    "buyabox": "cards.raw_card_blob->'promo_types' @> '\"buyabox\"'",
    "convention": "cards.raw_card_blob->'promo_types' @> '\"convention\"'",
    "datestamped": "cards.raw_card_blob->'promo_types' @> '\"datestamped\"'",
    "etched": "cards.raw_card_blob->'finishes' @> '\"etched\"'",
    "fnm": "cards.raw_card_blob->'promo_types' @> '\"fnm\"'",
    "gameday": "cards.raw_card_blob->'promo_types' @> '\"gameday\"'",
    "giftbox": "cards.raw_card_blob->'promo_types' @> '\"giftbox\"'",
    "glossy": "cards.raw_card_blob->'promo_types' @> '\"glossy\"'",
    "instore": "cards.raw_card_blob->'promo_types' @> '\"instore\"'",
    "intro_pack": "cards.raw_card_blob->'promo_types' @> '\"intropack\"'",
    "judge_gift": "cards.raw_card_blob->'promo_types' @> '\"judgegift\"'",
    "league": "cards.raw_card_blob->'promo_types' @> '\"league\"'",
    "media_insert": "cards.raw_card_blob->'promo_types' @> '\"mediainsert\"'",
    # "Partner with <name>" cards carry a plain "Partner" keyword alongside it (verified
    # against the corpus), so checking for "Partner" alone already covers both.
    "partner": "cards.raw_card_blob->'keywords' @> '\"Partner\"'",
    "planeswalker_deck": "cards.raw_card_blob->'promo_types' @> '\"planeswalkerdeck\"'",
    "player_rewards": "cards.raw_card_blob->'promo_types' @> '\"playerrewards\"'",
    "prerelease": "cards.raw_card_blob->'promo_types' @> '\"prerelease\"'",
    "rebalanced": "cards.raw_card_blob->'promo_types' @> '\"rebalanced\"'",
    "release": "cards.raw_card_blob->'promo_types' @> '\"release\"'",
    "set_promo": "cards.raw_card_blob->'promo_types' @> '\"setpromo\"'",
    "stamped": "cards.raw_card_blob->'promo_types' @> '\"stamped\"'",
    "universesbeyond": "cards.raw_card_blob->'promo_types' @> '\"universesbeyond\"'",
    # -- single-field lookups: shapes the old {tag: blob key} table could not express -----
    "scryfallpreview": "cards.raw_card_blob->'preview'->>'source' = 'Scryfall'",
    # -- mana-symbol classes (#1001, corrected by #1011) ---------------------------------
    #
    # FOUR hybrid families, not one: the ten `{W/U}` symbols, the twobrid `{2/W}` cycle, the
    # colourless-hybrid `{C/W}` cycle and Phyrexian-hybrid `{W/U/P}`. `{C/P}` is excluded because
    # colourless Phyrexian is not hybrid and Scryfall agrees (`is:hybrid o:"{c/p}"` is empty).
    "hybrid": r"cards.mana_cost_text ~ '\{([0-9]+|[WUBRGC])/[WUBRGC](/P)?\}'",
    # Phyrexian is ANYWHERE on the card: 36 of the 73 carry the symbol in rules text and nowhere
    # else, so the cost alone answers 37. `{C/P}` IS in this class -- it exists on cards even
    # though #909's validator rejects it as a query term, which is the case a stored tag answers
    # and an `m:` rewrite cannot.
    "phyrexian": (
        r"cards.mana_cost_text ~ '\{([WUBRGC]/)?[WUBRGC]/P\}' "
        r"OR cards.oracle_text ~* '\{([wubrgc]/)?[wubrgc]/p\}'"
    ),
}

# NOT STORED, deliberately: `masterpiece`. `st:masterpiece` is the same predicate as upstream's
# `set_type = 'masterpiece'` expression and is exact (empty set difference on api.scryfall.com,
# 2026-08-16), so storing it would be a second copy of an answer a rewrite already gives for no
# archive bytes.
#
# `hybrid` and `phyrexian` ARE stored, but not with the regexes #1001 landed: measured against
# Scryfall on 2026-08-23 (unique=cards, simulated over the cards it returns), `\{[WUBRG]/[WUBRG]\}`
# answers 569 of `is:hybrid`'s 603 and `\{[WUBRG]/P\}` answers 33 of `is:phyrexian`'s 73. The
# widened pair above is exact on the single-face corpus and is upstream PR #1011; this tree carries
# it ahead of the pin, which is why these two entries differ from a76f0cb.
