"""Public entry points for Scryfall query parsing."""

from __future__ import annotations

from typing import TYPE_CHECKING

from api.parsing.hand_parser import _is_word_cont
from api.parsing.hand_parser import parse_query as _parse_query
from api.parsing.rewrite import rewrite_query

if TYPE_CHECKING:
    from api.parsing.nodes import Query


def balance_partial_query(query: str) -> str:
    """Balance quotes and parentheses for typeahead searches using a stack."""
    char_to_mirror = {
        "(": ")",
        "'": "'",  # single quote is own mirror
        '"': '"',  # double quote is own mirror
        ")": "(",
    }
    unbalanced_closing_chars = {")"}
    quote_chars = {"'", '"'}

    current_stack = []
    for index, char in enumerate(query):
        # When inside a quoted string, only the matching closing quote ends it.
        if current_stack and current_stack[-1] in quote_chars:
            if char == current_stack[-1]:
                current_stack.pop()
            continue

        # A word character either side of an apostrophe makes it part of the word rather than an
        # opening quote -- the same rule _scan_word_end applies in the tokenizer. Without this the
        # balancer "closes" the apostrophe in urza's, producing urza's', which does not parse:
        # strictly worse than before bare names accepted apostrophes at all.
        if char == "'" and 0 < index < len(query) - 1 and _is_word_cont(query[index - 1]) and _is_word_cont(query[index + 1]):
            continue

        mirrored_char = char_to_mirror.get(char)
        if not mirrored_char:
            continue
        if current_stack and current_stack[-1] == mirrored_char:
            current_stack.pop()
        else:
            if char in unbalanced_closing_chars:
                msg = f"Unbalanced closing character '{char}' cannot be balanced"
                raise ValueError(msg)
            current_stack.append(char)
    while current_stack:
        char = current_stack.pop()
        mirrored_char = char_to_mirror[char]
        query += mirrored_char
    return query


def parse_scryfall_query(query: str) -> Query:
    """Parse a Scryfall search query into a card-specific AST.

    Args:
        query: The search query string to parse.

    Returns:
        A Scryfall-specific Query AST.
    """
    # parse => transform => rest: the whole rewrite pipeline runs on the common AST at this shared
    # seam, so it applies identically regardless of which parser _parse_query is.
    return rewrite_query(_parse_query(query))
