"""The hyphen and the slash, as a bare name word carries them.

Measured on api.scryfall.com 2026-10-04, one request per row:

    fire-ice  fire--ice  fire-"ice"  fire-ice-     1, Fire // Ice
    fire-  fire/                                   324 = fire
    power-                                         77 = power
    fire/ice  fire//ice  fire- ice                 4 = fire ice
    power/sink  power--sink  power-"sink"          1, Power Sink

So a run of hyphens glues what follows it -- a word, a number or a quoted string -- into the same
name word, a run with nothing glued behind it is dropped, and a slash ends the word. Each of these
was a parse error in the hand parser, for every word and not only one that opens with a numeric
alias.

Hand parser only: the pyparsing grammar is not changed, so these are not in implicit_and_cases.
"""

import pytest

from api.parsing import parse_scryfall_query


def tree(query: str) -> dict:
    """The engine-wire tree the hand-parser pipeline produces for *query*."""
    return parse_scryfall_query(query).to_json()


@pytest.mark.parametrize(
    argnames=["query", "same_as"],
    argvalues=[
        ("fire--ice", "fire-ice"),
        ("fire---ice", "fire-ice"),
        ('fire-"ice"', "fire-ice"),
        ("fire-ice-", "fire-ice"),
        ("power--sink", "power-sink"),
        ('power-"sink"', "power-sink"),
        ("fire-", "fire"),
        ("power-", "name:power"),
        ("usd-", "name:usd"),
        ("fire/", "fire"),
        ("fire/ice", "fire ice"),
        ("fire//ice", "fire ice"),
        ("fire- ice", "fire ice"),
        ("fire/ice/x", "fire ice x"),
        ("power/sink", "name:power sink"),
        ("-fire-", "-fire"),
        ("(fire-) t:instant", "(fire) t:instant"),
        ("fire/ice or t:goblin", "fire ice or t:goblin"),
    ],
)
def test_hyphen_and_slash_in_a_bare_name_word(query: str, same_as: str) -> None:
    """Each spelling parses to the tree of the plain spelling it is measured equal to."""
    assert tree(query) == tree(same_as)


@pytest.mark.parametrize(argnames=["query"], argvalues=[("power/2>1",), ("cmc-1<3",), ("power-cmc>1",), ("power - cmc",)])
def test_arithmetic_is_untouched(query: str) -> None:
    """A numeric term behind the operator is still arithmetic."""
    assert "card_name" not in str(tree(query))


@pytest.mark.parametrize(argnames=["query"], argvalues=[("fire-(ice)",), ("/fire",), ("fire /ice",), ("o:fire-",), ("fire+ice",)])
def test_what_is_not_a_name_word_separator_is_still_an_error(query: str) -> None:
    """A hyphen before a group, a leading slash, and either character in a value are not read."""
    with pytest.raises(ValueError, match="Failed to"):
        parse_scryfall_query(query)
