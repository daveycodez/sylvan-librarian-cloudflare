"""Scryfall's colour-NAME vocabulary: the guilds, shards, wedges and four-colour names.

`c:azorius` is a normal thing for a player to type, and this parser answered it with a parse
error — only `white`/`blue`/`black`/`red`/`green`/`colorless` and bare letter strings were
accepted. Scryfall accepts 44 names, measured one request each against api.scryfall.com
(`c:<value> e:khm`, 2026-08-16) and each then checked against its letter spelling over the whole
corpus, because Kaldheim holds exactly one card of three colours or more and would have agreed
with almost any mapping: `c:bant` = `c:gwu` = 153, `c:yore-tiller` = `c:wubr` = 62,
`c:rainbow` = `c:wubrg` = 60, `c:brown` = `c:c` = 4,300.

The list is a boundary rather than a superset: `yore`, `glint`, `dune`, `ink` and `witch` on
their own are rejected by Scryfall, so the un-hyphenated four-colour nicknames are not in its
table, and neither are `five`, `mono`, `guild`, `shard` or `wedge`.

The five Strixhaven colleges (Lorehold, Prismari, Quandrix, Silverquill, Witherbloom) were added
later, verified the same way: `c:witherbloom` = `c:bg` = 606 corpus-wide, and so on for all five.
`college`, `colleges`, and `strixhaven` are rejected by Scryfall, same boundary-not-superset rule.

A second vocabulary lives here too: the colour-COUNT names (`m`, `gold`, `multicolor(ed)`,
`multicolour(ed)`), which spell no letters at all and compare the NUMBER of colours in the column.
They are measured the same way and asserted against the numeric comparison each one means -- on
the two colour columns only, because Scryfall counts produced_mana over six values.
"""

from functools import partial

import pytest

from api.parsing import generate_sql_query, parse_query, parse_scryfall_query
from api.parsing.card_query_nodes import _color_count_masks
from api.parsing.colors import COLOR_ALIAS_TO_CODES
from api.parsing.pyparsing_based import parse_str_to_query as pyparsing_parse_str_to_query

parse_with_pyparsing = partial(parse_query, parser_fn=pyparsing_parse_str_to_query)

# (name query, the letter query it must mean). Every pair verified live before landing.
COLOR_NAME_CASES = [
    ("c:azorius", "c:wu"),
    # the alias spellings Scryfall accepts for each colour column, on letter values. Its vocabulary
    # is a BOUNDARY: `cid`, `commanderidentity`, `colouridentity` and `colour_identity` all come
    # back "Unknown keyword", so only these join.
    ("colour:wu", "c:wu"),
    ("colours:wu", "c:wu"),
    ("commander:wu", "id:wu"),
    ("commander<=jund", "ci<=brg"),
    ("c:dimir", "c:ub"),
    ("c:rakdos", "c:br"),
    ("c:gruul", "c:rg"),
    ("c:selesnya", "c:gw"),
    ("c:orzhov", "c:wb"),
    ("c:izzet", "c:ur"),
    ("c:golgari", "c:bg"),
    ("c:boros", "c:rw"),
    ("c:simic", "c:gu"),
    # the five Strixhaven colleges
    ("c:lorehold", "c:rw"),
    ("c:prismari", "c:ur"),
    ("c:quandrix", "c:gu"),
    ("c:silverquill", "c:wb"),
    ("c:witherbloom", "c:bg"),
    ("c:bant", "c:gwu"),
    ("c:esper", "c:wub"),
    ("c:grixis", "c:ubr"),
    ("c:jund", "c:brg"),
    ("c:naya", "c:rgw"),
    ("c:abzan", "c:wbg"),
    ("c:jeskai", "c:urw"),
    ("c:sultai", "c:bgu"),
    ("c:mardu", "c:rwb"),
    ("c:temur", "c:gur"),
    ("c:yore-tiller", "c:wubr"),
    ("c:glint-eye", "c:ubrg"),
    ("c:dune-brood", "c:brgw"),
    ("c:ink-treader", "c:rgwu"),
    ("c:witch-maw", "c:gwub"),
    ("c:artifice", "c:wubr"),
    ("c:chaos", "c:ubrg"),
    ("c:aggression", "c:brgw"),
    ("c:altruism", "c:rgwu"),
    ("c:growth", "c:gwub"),
    ("c:rainbow", "c:wubrg"),
    ("c:colourless", "c:c"),
    ("c:brown", "c:c"),
    # `all` spells wubrgc, which is wubrg once the c drops out of a card_colors comparison …
    ("c:all", "c:wubrg"),
    # … and stays six values on produced_mana, where colorless is a genuine producible thing.
    ("produces:all", "produces:wubrgc"),
    ("produces:rainbow", "produces:wubrg"),
    # The identity spellings take the same vocabulary (Scryfall: id:bant e:khm == id:gwu e:khm).
    ("id:bant", "id:gwu"),
    ("identity:esper", "identity:wub"),
    ("ci<=abzan", "ci<=wbg"),
    ("c>=azorius", "c>=wu"),
    ("c!=jund", "c!=brg"),
    ("-c:temur", "-c:gur"),
]


@pytest.mark.parametrize(
    argnames=("query", "canonical_query"),
    argvalues=COLOR_NAME_CASES,
    ids=[q for q, _ in COLOR_NAME_CASES],
)
def test_color_name_matches_letters(query: str, canonical_query: str) -> None:
    """A colour name produces exactly the SQL its letter spelling does, in both parsers."""
    assert generate_sql_query(parse_scryfall_query(query)) == generate_sql_query(parse_scryfall_query(canonical_query))
    assert generate_sql_query(parse_with_pyparsing(query)) == generate_sql_query(parse_with_pyparsing(canonical_query))


# The colour-COUNT names, as the numeric comparison each one means. `m` is not a colour and spells
# no letters: it is Scryfall's word for MULTICOLOURED and compares the NUMBER of colours in the
# column, so the operator does not survive verbatim either. Every pair below was measured
# corpus-wide against api.scryfall.com on 2026-08-16 -- see colors.COLOR_COUNT_NAMES for the
# counts, including the two readings that are NOT "substitute the number 2": `c>m` is `c>=2` rather
# than `c>2` (4,607 against 796), and `c!=m` is `c<2` rather than `c!=2` (29,049 against 29,836).
COLOR_COUNT_CASES = [
    # every spelling of the name, on the same operator
    ("c:m", "c>=2"),
    ("c:gold", "c>=2"),
    ("c:multicolor", "c>=2"),
    ("c:multicolour", "c>=2"),
    ("c:multicolored", "c>=2"),
    ("c:multicoloured", "c>=2"),
    # every operator, on the same spelling
    ("c=m", "c>=2"),
    ("c>m", "c>=2"),
    ("c>=m", "c>=2"),
    ("c<m", "c<2"),
    ("c!=m", "c<2"),
    ("c<=m", "c>=0"),  # a tautology: `c<=m t:creature` = `t:creature` = 18,753
    # every alias of each column takes the same table -- the lowering keys off the resolved db
    # column, not the spelling, so `commander:m` is `id:m` for free
    ("color:m", "c>=2"),
    ("colors:gold", "c>=2"),
    ("colour:m", "c>=2"),
    ("colours:multicolored", "c>=2"),
    ("commander:m", "id>=2"),
    ("commander>gold", "id>=2"),
    ("id:m", "id>=2"),
    ("identity:gold", "id>=2"),
    ("ci>m", "ci>=2"),
    ("id<m", "id<2"),
    ("id!=multicoloured", "id<2"),
    ("id<=m", "id>=0"),
    # case, quoting and negation all reach the same lowering
    ("c:M", "c>=2"),
    ("c:GOLD", "c>=2"),
    ('c:"m"', "c>=2"),
    ("-c:m", "-c>=2"),
]


@pytest.mark.parametrize(
    argnames=("query", "canonical_query"),
    argvalues=COLOR_COUNT_CASES,
    ids=[q for q, _ in COLOR_COUNT_CASES],
)
def test_color_count_name_matches_number(query: str, canonical_query: str) -> None:
    """A colour-COUNT name produces exactly the SQL its numeric comparison does, in both parsers."""
    assert generate_sql_query(parse_scryfall_query(query)) == generate_sql_query(parse_scryfall_query(canonical_query))
    assert generate_sql_query(parse_search_query(query)) == generate_sql_query(parse_search_query(canonical_query))


# produced_mana is the same table on a SIX-value count, intersected with "produces at least one
# value": `produces<m` = 1,143 = `produces=1` and NOT `produces<2` = 32,139, which sweeps in the
# 30,996 cards that produce nothing at all.
PRODUCED_COUNT_CASES = [
    ("produces:m", "produces>=2"),
    ("produces=gold", "produces>=2"),
    ("produces>m", "produces>=2"),
    ("produces>=multicoloured", "produces>=2"),
    ("produces<m", "produces=1"),
    ("produces!=m", "produces=1"),
    ("produces<=m", "produces>=1"),
]


@pytest.mark.parametrize(
    argnames=("query", "canonical_query"),
    argvalues=PRODUCED_COUNT_CASES,
    ids=[q for q, _ in PRODUCED_COUNT_CASES],
)
def test_produced_mana_count_name_matches_number(query: str, canonical_query: str) -> None:
    """produced_mana takes the count names too, on its own operator table."""
    assert generate_sql_query(parse_scryfall_query(query)) == generate_sql_query(parse_scryfall_query(canonical_query))
    assert generate_sql_query(parse_search_query(query)) == generate_sql_query(parse_search_query(canonical_query))


# THE FIVE/SIX SPLIT, PINNED IN BOTH DIRECTIONS so a later tidy-up cannot quietly unify them.
#
# produced_mana is the one colour-ish column whose array can literally contain "C" -- Sol Ring
# produces ["C"] while its colors and color_identity are both [] -- so a COUNT there counts
# colorless as a value and the colour columns do not. Measured against api.scryfall.com 2026-08-16:
# `produces=6` = 106 = `produces:all` (a count no five-key popcount can reach), the 481 cards
# producing colorless and nothing else answer `produces=1`, and counts 0..6 partition the corpus
# exactly. On the colour side `c:all` = `c:wubrg` = `c=5` = 60 and `c=6` is not a valid query at
# all ("Unknown color 6").
def test_produced_mana_counts_six_values_and_colors_count_five() -> None:
    """The count width differs by column, and each width is the measured one."""
    # Six bits on produced_mana: 64 masks in the enumeration, and a count of 6 is reachable.
    assert len(_color_count_masks("=", 0, bits=6)) + len(_color_count_masks(">=", 1, bits=6)) == 64
    assert _color_count_masks("=", 6, bits=6) == [0b11_1111]
    # Five on the colour columns: 32 masks, and a count of 6 can never be satisfied.
    assert len(_color_count_masks("=", 0)) + len(_color_count_masks(">=", 1)) == 32
    assert _color_count_masks("=", 6) == []
    assert _color_count_masks("=", 5) == [0b1_1111]
    # And the two columns reach DIFFERENT SQL, so the widths cannot be served by one index.
    produced_sql = generate_sql_query(parse_scryfall_query("produces>=2"))[0]
    colors_sql = generate_sql_query(parse_scryfall_query("c>=2"))[0]
    assert "magic.produced_mana_mask" in produced_sql
    assert "magic.color_identity_mask" not in produced_sql
    assert "magic.color_identity_mask" in colors_sql
    assert "magic.produced_mana_mask" not in colors_sql


@pytest.mark.parametrize(
    argnames="invalid_query",
    argvalues=["c:mw", "c:wm", "c:mc", "c:mm", "c!=mw", "id:mw", "c:mono", "produces:mw"],
)
def test_m_beside_another_color_is_still_invalid(invalid_query: str) -> None:
    """`m` beside another colour letter is neither a name nor a letter set, and stays a parse error.

    Scryfall dropped the combination outright -- it answers "Using “m” with other colors is no
    longer supported" and IGNORES the term -- so quietly reading `c:mw` as a count would answer a
    different question from the one asked.
    """
    with pytest.raises(ValueError, match="Failed to parse query"):
        parse_scryfall_query(invalid_query)


@pytest.mark.parametrize(
    argnames="query",
    argvalues=["c:AZORIUS", "c:Azorius", "c:BaNt", "id:YORE-TILLER"],
)
def test_color_names_are_case_insensitive(query: str) -> None:
    """Scryfall answers `c:AZORIUS e:khm` with the same 6 cards as `c:azorius e:khm`."""
    assert generate_sql_query(parse_scryfall_query(query)) == generate_sql_query(parse_scryfall_query(query.lower()))


# Values Scryfall REJECTS, which this parser must keep rejecting: adding a name Scryfall does not
# have would answer a WIDER result than Scryfall, silently.
@pytest.mark.parametrize(
    argnames="invalid_query",
    argvalues=[
        "c:yore",
        "c:glint",
        "c:dune",
        "c:ink",
        "c:witch",
        "c:five",
        "c:guild",
        "c:shard",
        "c:wedge",
        "c:nephilim",
        "c:azorius-senate",
        "c:boros-legion",
    ],
)
def test_rejected_color_names_still_fail(invalid_query: str) -> None:
    """A name outside Scryfall's table is still a parse error rather than a silent widening."""
    with pytest.raises(ValueError, match="Failed to parse query"):
        parse_scryfall_query(invalid_query)


def test_every_alias_spells_only_color_codes() -> None:
    """Every entry in the table expands to letters `get_colors_comparison_object` can read."""
    assert all(set(codes) <= set("wubrgc") for codes in COLOR_ALIAS_TO_CODES.values())
