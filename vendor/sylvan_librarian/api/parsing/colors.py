"""Colour vocabulary: the letter codes and every name Scryfall's search accepts for them."""

COLOR_CODE_TO_NAME = {
    "b": "black",
    "c": "colorless",
    "g": "green",
    "r": "red",
    "u": "blue",
    "w": "white",
}

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
# `all` spells `wubrgc` where `rainbow` spells `wubrg`. Both are in this table because it is the
# VOCABULARY -- Scryfall accepts both words -- but neither is compared as a SET of letters: they are
# COUNTS, and the letters they spell are read only for how many values they come to on the column
# being asked. See COLOR_SPREAD_COUNT_NAMES below.
#
# It also fully replaces the old name -> single-letter-code table (`white` -> `w`, etc.), so there
# is only one lookup path.
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
    # the five Strixhaven colleges -- verified live the same way, corpus-wide: c:lorehold =
    # c:rw = 682, c:prismari = c:ur = 668, c:quandrix = c:gu = 638, c:silverquill = c:wb = 614,
    # c:witherbloom = c:bg = 606.
    "lorehold": "rw",
    "prismari": "ur",
    "quandrix": "gu",
    "silverquill": "wb",
    "witherbloom": "bg",
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


# The two colour names that mean "the WHOLE spread of this column", which is a COUNT.
#
# `rainbow` and `all` live in COLOR_ALIAS_TO_CODES because Scryfall accepts both words and that map
# is the vocabulary. They are not compared as the letters they spell, though, and this is the one
# place in the colour vocabulary where a name and its own letter spelling ANSWER DIFFERENTLY. The
# letters are read only for how many values they come to on the column asked:
#
#   rainbow  spells wubrg  -> 5 on every column
#   all      spells wubrgc -> 5 on card_colors / card_color_identity (the C drops out), 6 on
#                             produced_mana (where C is a producible value) -- the same asymmetry
#                             COLOR_COUNT_NAMES' `produces=6` paragraph already carries
#
# and THE OPERATOR IS CARRIED THROUGH VERBATIM, with `:` meaning `=` -- which is exactly what the
# numeric colour-count path does with `c:2` already. No surprises, unlike the `m` and `any` tables.
#
# MEASURED against api.scryfall.com 2026-08-28, corpus-wide (33,599 cards), on all three columns:
#
#   c:rainbow = c:all = c>=all = c=all           =     60 = `c=5`      c>all = 0 = `c>5`
#   c<rainbow = c<all = c!=rainbow               = 33,540 = `c<5` = `c!=5`
#   id:rainbow = id:all = id=rainbow = id>=all   =    129 = `id=5`     id>rainbow = 0
#   id<rainbow = id<all = id!=rainbow = id!=all  = 33,470 = `id<5` = `id!=5`
#   id<=rainbow = id<=all                        = 33,599 = every card
#   produces:rainbow = produces=rainbow          =    693 = `produces=5`
#   produces>=rainbow                            =    799 = `produces>=5`
#   produces<rainbow                             = 32,800 = `produces<5`
#   produces<=rainbow                            = 33,493 = `produces<=5`
#   produces>rainbow                             =    106 = `produces>5`
#   produces!=rainbow                            = 32,906 = `produces!=5`
#   produces:all = produces=all = produces>=all  =    106 = `produces=6`   produces>all = 0
#   produces<all = produces!=all                 = 33,493 = `produces<6`   produces<=all = 33,599
#
# TWO ROWS REFUTE THE SET READING, and they are why this is a table and not a letter expansion.
# `id:wubrg` is 33,599 -- EVERY card -- because `id:` is a subset test, while `id:rainbow` is 129;
# and `produces:wubrg` is 799 where `produces:rainbow` is 693, because a superset-of-WUBRG test also
# admits the 106 cards that produce a sixth value.
#
# The doc-comment this replaces claimed `produces:all` matched nothing and that `produces:rainbow`
# = `produces:wubrg` = 13. Both are refuted above by direct probe on the same day the rest of this
# table was measured; card_engine's own `color_count` had the right number for `produces:all` (106)
# all along, so the two comments had been contradicting each other.
COLOR_SPREAD_COUNT_NAMES = frozenset({"rainbow", "all"})
