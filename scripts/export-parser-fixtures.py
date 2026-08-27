#!/usr/bin/env python3
"""Export parser parity fixtures from the vendored upstream test corpus.

Walks the upstream parsing test corpus (vendor/sylvan_librarian/api/parsing/tests),
collects every query string it exercises, runs each through the PRODUCTION Python
parse pipeline (parse_scryfall_query = hand parser + rewrite passes), and writes
tests/parser/fixtures/*.json entries of the form:

    {"query": ..., "tree": "<canonical json>"}            # parse + to_json succeeded
    {"query": ..., "error": {"type": ..., "message": ...}} # raised

`tree` is the engine-wire JSON — exactly what the Rust engine deserializes: the
pyo3 entry point calls filters.to_json() and orjson-dumps it (see
card_engine/src/lib.rs bind_and_split_filter). It is stored as a canonical
STRING (sort_keys=True, ensure_ascii=False, separators=(",", ":")) so the
int-vs-float distinction (2 vs 2.0) survives the fixture round-trip and the TS
side can compare byte-for-byte.

How queries are gathered:
  1. pytest collection over api/parsing/tests: every parametrized test's
     callspec params whose names are known query-carrying names, plus the
     composed date/year triples from test_date_year_search.
  2. An AST scan of the same files for query string literals passed directly to
     parse calls or assigned to `query = "..."` inside test bodies.
  3. balance_partial_query results for the partial-query corpus (both the raw
     partial and its balanced form are exported).
  4. A supplementary list of edge-case queries defined below (unicode, float
     repr, big ints, invalid dates/colors/rarities, lex errors, ...).

Format: json.dump writes one-space indent, which is not what biome enforces on
tests/. Follow every run with `bunx biome check --write tests/parser/fixtures/`
or `bun run check` fails on formatting alone, with a diff the size of the corpus.

Environment: run with the repo venv (.venv) which needs pytest, pyparsing,
cachebox and titlecase installed (`python3 -m venv .venv && .venv/bin/pip
install pytest pyparsing cachebox titlecase`). Upstream does NOT install the
optional `regex` package, so titlecase's `re` fallback branch is the production
behavior — do not install `regex` here or fixtures will diverge.

Import surgery: api.utils.db_utils transitively imports docker/psycopg, which
are irrelevant to parsing; a stub module providing IntArray is injected into
sys.modules before the parsing package is imported. sys.path gets the vendored
package root so `api.parsing` resolves.

Unicode side tables: the TS port's src/parser/py-unicode-data.ts encodes where
CPython's Unicode tables (3.13 / Unicode 15.1) differ from the JS engine's. If
the Python used to regenerate fixtures changes major version, regenerate that
file too (dump per-codepoint lower/upper/title/cased/case-ignorable/isalpha/
isspace/combining tables from Python, diff them against the JS built-ins with a
bun script, and emit the exception maps — see the header of py-unicode-data.ts).
"""

from __future__ import annotations

import ast
import json
import os
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# PARSER_EXPORT_SOURCE points the exporter at another checkout of the upstream
# repo root (a PR worktree, or a patched copy of vendor/). Used when a parser
# change lands on an upstream branch before the vendor tree syncs it — ground
# truth must come from the branch's parser or the new fixtures cannot exist.
# Default stays the vendored tree.
VENDOR_ROOT = Path(os.environ["PARSER_EXPORT_SOURCE"]) if os.environ.get("PARSER_EXPORT_SOURCE") else REPO_ROOT / "vendor" / "sylvan_librarian"
TESTS_DIR = VENDOR_ROOT / "api" / "parsing" / "tests"
FIXTURES_DIR = REPO_ROOT / "tests" / "parser" / "fixtures"

# ── import surgery ───────────────────────────────────────────────────────────

sys.path.insert(0, str(VENDOR_ROOT))

_db_utils_stub = types.ModuleType("api.utils.db_utils")


class IntArray(list):
    """Stub of api.utils.db_utils.IntArray (only used by SQL paths we never run)."""


_db_utils_stub.IntArray = IntArray  # type: ignore[attr-defined]
sys.modules["api.utils.db_utils"] = _db_utils_stub

import pytest  # noqa: E402

from api.parsing.parsing_f import balance_partial_query  # noqa: E402
# Upstream #1050 moved the production pipeline behind post_parse.parse_query; `parse_scryfall_query`
# is the hand-parser partial of it. Import it from the package root, which is where the seam lives
# now — parsing_f is down to the balancer.
from api.parsing import parse_scryfall_query  # noqa: E402
from api.parsing.card_query_nodes import slugify_tag  # noqa: E402

# ── query collection ─────────────────────────────────────────────────────────

# Parametrize argument names that carry a parseable query string.
QUERY_PARAM_NAMES = {
    "query",
    "input_query",
    "query_str",
    "test_input",
    "original_query",
    "invalid_query",
    "semantically_invalid_query",
    "lowercase_query",
    "uppercase_query",
    "synonym",
    "expansion",
    "regex_query",
    "substring_query",
}

# Parametrize argument names that carry partial queries meant for balancing.
BALANCE_PARAM_NAMES = {"input_query", "original_query"}


class _Collector:
    """Pytest plugin that harvests query strings from collected test items."""

    def __init__(self) -> None:
        self.queries: set[str] = set()
        self.balance_inputs: set[str] = set()

    def pytest_collection_finish(self, session: pytest.Session) -> None:
        for item in session.items:
            callspec = getattr(item, "callspec", None)
            if callspec is None:
                continue
            params = callspec.params
            fname = item.path.name if item.path else ""
            for name, val in params.items():
                if not isinstance(val, str):
                    continue
                if name in QUERY_PARAM_NAMES:
                    self.queries.add(val)
                if fname.startswith("test_balance") and name in BALANCE_PARAM_NAMES:
                    self.balance_inputs.add(val)
            # test_date_year_search composes the query from a triple.
            if {"searchattr", "searchoperator", "searchvalue"} <= params.keys():
                self.queries.add(f"{params['searchattr']}{params['searchoperator']}{params['searchvalue']}")


def collect_from_pytest() -> tuple[set[str], set[str]]:
    collector = _Collector()
    rc = pytest.main(
        [
            "--collect-only",
            "-q",
            "-p",
            "no:cacheprovider",
            f"--confcutdir={TESTS_DIR}",
            "--rootdir",
            str(VENDOR_ROOT),
            str(TESTS_DIR),
        ],
        plugins=[collector],
    )
    if rc not in (0,):
        msg = f"pytest collection failed with exit code {rc}"
        raise SystemExit(msg)
    return collector.queries, collector.balance_inputs


PARSE_CALL_NAMES = {
    "parse_query",
    "parse_scryfall_query",
    "parse_search_query",
    "get_where_clause",
    "balance_partial_query",
}


def collect_from_ast() -> set[str]:
    """Scan test sources for literal query strings used outside parametrize tables."""
    queries: set[str] = set()
    for path in sorted(TESTS_DIR.glob("test_*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            # parse_query("...") style direct calls
            if isinstance(node, ast.Call):
                func = node.func
                name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
                if name in PARSE_CALL_NAMES and node.args:
                    arg = node.args[0]
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        queries.add(arg.value)
            # query = "..." assignments inside test bodies
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in ("query", "query_str", "input_query"):
                        queries.add(node.value.value)
    return queries


# Supplementary edge cases: Python/TS divergence traps the upstream corpus does
# not cover directly. Ground truth still comes from the Python parser below.
EXTRA_CASES = [
    # empty / whitespace
    "",
    "   ",
    "\t\n",
    # unicode words and case mapping
    "name:éowyn",
    'name:"éowyn"',
    "name:Éowyn",
    "éowyn",
    "!Éowyn",
    '!"ÆTHER VIAL"',
    "name:ætherling",
    # The Latin letters NFKD leaves whole, which fold_accents expands and Scryfall compares as
    # their expansions (measured 2026-08-16, equal totals against the expanded spelling for each):
    # æ/ae 90, œ/oe 167, ß/ss 2051, ø/o 22111, ł/l 18748, đ/d 14591, þ/th 5689, ð/d 14591,
    # ħ/h 14176, ŋ/ng 4834, ŧ/t 22261, ı/i 22954, ĸ/k 6616.
    "name:œuvre",
    "name:øde",
    "name:þor",
    "name:łódź",
    "name:đelo",
    "name:ĳsselmeer",
    "a:łebski",
    "o:æther",
    'o:"æther"',
    "t:æ",
    "ft:æther",
    # `*` is an ordinary character in a value, deleted by the name/artist collation and kept
    # everywhere else: `name:ft*` == `name:*ft*` == `name:ft` (1,628) while `o:ft*`,
    # `t:crea*ture` and the quoted `name:"ft*"` each find nothing.
    "name:ft*",
    "name:*ft*",
    "name:*ft",
    "name:f*t",
    'name:"ft*"',
    "o:ft*",
    "t:crea*ture",
    "a:gu*ay",
    "ft:cro*ft",
    "*",
    "ft*",
    # `!=` on a string column is the empty set on Scryfall, whatever the value.
    "name!=ft",
    'name!="lightning bolt"',
    "o!=draw",
    "t!=creature",
    "a!=guay",
    "set!=khm",
    "artist:rebecca",
    'artist:"seb mckinnon"',
    'a:"PETE VENTERS"',
    "name:strasse",
    "name:straße",
    'name:"ǅungla"',
    "o:ΣΙΓΜΑ",
    'name:"ΟΔΥΣΣΕΥΣ"',
    "name:ﬁre",
    'name:"d\'avenant archer"',
    'name:"o\'kagachi"',
    'name:"l\'antiquaire"',
    "name:mcgee",
    'name:"MR. BABYCAKES"',
    "name:will-o-the-wisp",
    "name:the",
    'name:"the wanderer"',
    'name:"war of the last alliance"',
    "name:x/y",
    'name:"Ego à Deriva"',
    'name:"稲妻"',
    # lang: operator (multilingual)
    "lang:ja",
    "lang:any",
    "-lang:en",
    "lang:zzz",
    "lang>=en",
    "language:ru",
    "lang:ja t:creature",
    "(lang:ja or lang:ru) cmc=1",
    # Escaped metacharacters on every regex-capable operator. A backslash before a NON-word
    # character IS that character, so a pattern with nothing else in it lowers to the equivalent
    # substring leaf (rewrite._regex_plain_literal) and one with a real metacharacter or class
    # escape keeps its regex leaf with the backslashes intact. Both halves are pinned here across
    # the operators, because the two implementations have to agree about WHICH half a pattern is
    # in -- the trees are compared byte for byte.
    r"o:/\(this creature/",
    r"fo:/\(this creature/",
    r"o:/\{t\}/",
    r"o:/target\./",
    r"o:/\+1\/\+1/",
    r"o:/\[brackets\]/",
    r"o:/back\\slash/",
    r"name:/\,/",
    r"name:/\'/",
    r"a:/\./",
    r"ft:/\./",
    r"flavor:/\(/",
    r"t:/\(/",
    r"t:/\-/",
    r"e:/kh\w/",
    r"cn:/\d/",
    r"watermark:/izz\S+/",
    r"layout:/norm\w+/",
    r"border:/bl\w+/",
    # ...and the ones that must NOT lower, so a pattern that keeps its leaf keeps its backslashes.
    r"o:/\(a.b/",
    r"name:/^\(x/",
    r"t:/\(a|b/",
    r"fo:/[\]]/",
    r"o:/\bfoo/",
    # fo:/fulloracle: -- Scryfall's FULL-oracle operator, sharing oracle_text's column and told
    # apart from `o:` by original_attribute (the engine's searchable oracle column is stripped).
    "fo:lifelink",
    "fulloracle:lifelink",
    'fo:"damage dealt by this creature also causes"',
    "fo:/\\(this creature/",
    "-fo:lifelink",
    "fo:draw e:khm",
    # oracleid: operator -- the query every card object's prints_search_uri carries
    "oracleid:43fbfeec-bcaf-48b8-befe-b7346fec5a3a",
    "oracle_id:43fbfeec-bcaf-48b8-befe-b7346fec5a3a",
    "oracleid:43FBFEEC-BCAF-48B8-BEFE-B7346FEC5A3A",
    'oracleid:"43fbfeec-bcaf-48b8-befe-b7346fec5a3a"',
    "-oracleid:43fbfeec-bcaf-48b8-befe-b7346fec5a3a",
    "oracleid:not-a-uuid",
    "oracleid:43fbfeec",
    "oracleid>43fbfeec-bcaf-48b8-befe-b7346fec5a3a",
    "oracleid:43fbfeec-bcaf-48b8-befe-b7346fec5a3a t:creature",
    "(oracleid:43fbfeec-bcaf-48b8-befe-b7346fec5a3a or oracleid:21f45043-5419-4019-8b6c-e5294bd5f549) cmc=1",
    # floats and int/float json rendering
    "cmc=2.0",
    "cmc>=1.5",
    "power>2.50",
    "cmc=0.5",
    "usd<=0.25",
    "cmc=10000000000000000.5",
    "cmc=0.00001",
    "cmc>99999999999999999999",
    "power=007",
    "toughness=2.",
    # arithmetic
    "power+toughness>cmc*2",
    "(power+toughness)/2>=3",
    "cmc-power-toughness<1",
    "2*power-1>3",
    "power>-cmc+5",
    "-cmc>1",
    "-(cmc-1)>0",
    "- cmc",
    "5/2>cmc",
    # dual-class collector number
    "cn:123",
    "cn:123a",
    'cn:"10E-105"',
    "number>=100",
    "cn:*107",
    "number:2.5",
    # colors (incl. serialization-time validation errors)
    "c:wubrg",
    "c:c",
    "c:colorless",
    "c:wwu",
    "c:gw",
    "id<=jund",
    "id<=wg",
    "c>=WUBRGC",
    'c:"purple"',
    'c:""',
    'color:"wubrg"',
    "produces:c",
    "produces:wu",
    "c:purple",
    "identity!=r",
    # colour COUNT names: every spelling, every operator, every column. The lowering lives in
    # CardBinaryOperatorNode's constructor and depends on BOTH the value and the operator, so the
    # fixture has to cross them rather than sample one of each.
    "c:m",
    "c=m",
    "c>m",
    "c>=m",
    "c<m",
    "c<=m",
    "c!=m",
    "c:gold",
    "c=gold",
    "c>gold",
    "c>=gold",
    "c<gold",
    "c<=gold",
    "c!=gold",
    "c:multicolor",
    "c=multicolor",
    "c>multicolor",
    "c>=multicolor",
    "c<multicolor",
    "c<=multicolor",
    "c!=multicolor",
    "c:multicolour",
    "c<multicolour",
    "c<=multicolour",
    "c:multicolored",
    "c!=multicolored",
    "c<=multicolored",
    "c:multicoloured",
    "c!=multicoloured",
    "c<=multicoloured",
    "color:m",
    "colors:m",
    "colour:gold",
    "colours:multicolored",
    "id:m",
    "id=m",
    "id>m",
    "id>=m",
    "id<m",
    "id<=m",
    "id!=m",
    "identity:gold",
    "ci:multicolored",
    "coloridentity<m",
    "color_identity<=m",
    # produced_mana counts SIX values (colorless is a producible one), so it lowers to its own
    # operator table and reaches a different SQL mask than the colour columns do
    "produces:m",
    "produces=m",
    "produces>m",
    "produces>=m",
    "produces<m",
    "produces<=m",
    "produces!=m",
    "produces:gold",
    "produces:multicoloured",
    "produces>=2",
    "produces=6",
    # the alias spellings Scryfall accepts for each colour column, in both modes
    "colour:wu",
    "colours:wu",
    "colour:m",
    "colours>=2",
    "commander:wu",
    "commander:m",
    "commander>=2",
    "commander<=jund",
    # and the neighbours it REJECTS, which must stay bare-name searches here
    "cid:wu",
    "colouridentity:wu",
    "commanderidentity:wu",
    # the bare counts the names lower to, so a fixture diff shows them side by side
    "c>=2",
    "c<2",
    "c>=0",
    # case, quoting and negation reach the same lowering
    "c:M",
    "c:GOLD",
    'c:"m"',
    'c:"multicolor"',
    "-c:m",
    # still invalid: `m` beside another colour letter is not a name and not a letter set
    "c:mw",
    "c:wm",
    "c:mc",
    "c:mm",
    "c!=mw",
    "id:mw",
    "c:mono",
    "produces:mw",
    # rarity
    "r:mythic",
    "r>=u",
    "rarity<rare",
    'r:"weird"',
    'rarity:"COMMON"',
    "r=s",
    "r:bonus",
    # mana / devotion
    "m:{2}{W}",
    "mana:2ww",
    "m:{g/u}{g/u}",
    'm:"{G}"',
    "devotion:{g}{g}{g}",
    "m>=2WW",
    "mana<{R}{R}",
    "m:xxr",
    "m:1{r}1",
    # dates and years
    "date:2020-02-29",
    "date:2019-02-29",
    "date=2025-13-01",
    "date:2025-02-30",
    "date:1991",
    "date:2041",
    "year:2025",
    "year:1991",
    "year>2040",
    "date:2025-6-7",
    "date:2025-006-007",
    "date:2024-1.5-07",
    # YEAR-MONTH, with no day. The corpus had no case of this at ANY precision, which is why the
    # parser could consume the month tokens and then return the bare year -- silently, for as long
    # as it did -- without a single fixture moving. Every operator is listed because the engine
    # reads a different end of the window for each.
    "date:2021-02",
    "date=2021-02",
    "date>=2021-02",
    "date>2021-02",
    "date<=2021-02",
    "date<2021-02",
    "date!=2021-02",
    "date:2021-13",
    "date:2021-00",
    "year:2021-02",
    # is:/frame: synonym expansion (incl. nesting and negation)
    "is:vanilla",
    "is:dfc",
    "-is:old",
    "frame:modern is:new",
    "is:party",
    "is:manland",
    "frame:/old/",
    'is:"OLD"',
    "is:unknown_tag",
    "IS:OLD",
    "banned:m",
    "restricted:vintage",
    "legal:c",
    "f:M",
    # regex lowering
    "o:/sacrifice a/",
    "o:/^tap/",
    "o:/a\\.b/",
    "o:/\\d+/",
    "o:/dra(w|ws)/",
    "o://",
    "name:/li.*ing/",
    "t:/creature/",
    "kw:/flying/",
    "o:/först/",
    # type/keyword/tag titling
    "t:LEGENDARY",
    "t:dragon",
    "subtype:creature",
    "kw:first_strike",
    'kw:"first strike"',
    "otag:removal",
    "art:squirrel",
    'frame:"2015"',
    "frame:showcase",
    "layout:MODAL_DFC",
    "wm:orzhov",
    "border:BLACK",
    # exact names
    "!fire",
    "!'lightning bolt'",
    "!2rr",
    "!(fire)",
    "! fire",
    # lex/parse errors
    "cmc=2 and id=",
    "name:",
    "(a b",
    "a b)",
    "()",
    "a,b",
    "cmc>#",
    "and",
    "or a",
    "a AND",
    'name:"unclosed',
    "o:{tap",
    "cmc:３",
    "²",
    "power>",
    "c:",
    "!",
    "!=x",
    "--a",
    # tricky implicit AND / quoting
    "t:creature (o:flying or o:reach) -c:u cmc<=3",
    '"lightning" or "shock"',
    "fire 'and' ice",
    "o:\"pay {W/P}\"",
    'name:"a\\"b"',
    "name:'it\\'s'",
    "set:MH2 r:c",
    "e:neo cn:100",
]


def generate_fuzz_queries(count: int = 800, seed: int = 20260807) -> set[str]:
    """Deterministic random query soup for differential coverage beyond the corpus.

    Same ground-truth rule as everything else: whatever Python does (tree or
    error) is the verdict the TS port must reproduce.
    """
    import random  # noqa: PLC0415

    rng = random.Random(seed)
    aliases = [
        "name", "o", "oracle", "t", "type", "subtype", "c", "color", "id", "identity",
        "cmc", "mv", "power", "pow", "tou", "loyalty", "usd", "r", "rarity", "set", "e",
        "cn", "number", "m", "mana", "devotion", "kw", "keyword", "frame", "is", "otag",
        "art", "f", "format", "legal", "banned", "layout", "border", "wm", "date", "year",
        "produces", "flavor", "ft", "artist", "a", "unknownfield", "Naya", "éclair",
    ]
    ops = [":", "=", "!=", ">", "<", ">=", "<="]
    words = [
        "fire", "bolt", "dragon", "Éowyn", "straße", "ǅungla", "ΣΙΓΜΑ", "ﬁre", "mcgee",
        "o'kagachi", "will-o-the-wisp", "2rr", "40k", "x", "the", "and", "or", "AND", "OR",
        "wubrg", "c", "rg", "colorless", "mythic", "u", "modern", "vintage", "creature",
        "legendary", "goblin", "changeling", "2015", "showcase", "split", "old", "new",
        "dfc", "vanilla", "123", "10E-105", "brawl", "紅蓮", "æther",
    ]
    values = [
        '"lightning bolt"', "'full art'", '"a\\"b"', '""', "/dra(w|ws)/", "/sacrifice a/",
        "/^tap/", "/a\\/b/", "{2}{W}", "{g/u}", "2ww", "3", "2.5", "0.0", "007", "2024",
        "2024-02-29", "1993", "-1", "*",
    ]
    numerics = ["cmc", "power", "tou", "loyalty", "usd", "3", "2.5", "(cmc+1)", "0"]

    def leaf() -> str:
        kind = rng.random()
        if kind < 0.55:
            return f"{rng.choice(aliases)}{rng.choice(ops)}{rng.choice(words + values)}"
        if kind < 0.7:
            lhs = rng.choice(numerics)
            rhs = rng.choice(numerics)
            arith = rng.choice(["+", "-", "*", "/"])
            spacer = rng.choice(["", " "])
            return f"{lhs}{spacer}{arith}{spacer}{rhs}{rng.choice(ops)}{rng.choice(numerics)}"
        if kind < 0.8:
            return f"!{rng.choice(words)}" if rng.random() < 0.5 else f'!"{rng.choice(words)}"'
        return rng.choice(words + values)

    def expr(depth: int) -> str:
        n = rng.randint(1, 3)
        parts = []
        for _ in range(n):
            part = f"({expr(depth + 1)})" if depth < 2 and rng.random() < 0.25 else leaf()
            if rng.random() < 0.2:
                part = f"-{part}"
            parts.append(part)
        joiner = rng.choice([" ", " ", " and ", " or ", " AND ", " OR "])
        return joiner.join(parts)

    return {expr(0) for _ in range(count)}


def main() -> None:
    pytest_queries, balance_inputs = collect_from_pytest()
    ast_queries = collect_from_ast()

    balanced: set[str] = set()
    for partial in balance_inputs:
        try:
            balanced.add(balance_partial_query(partial))
        except ValueError:
            pass

    groups: dict[str, set[str]] = {
        "corpus": pytest_queries | ast_queries | balanced,
        "extra-cases": set(EXTRA_CASES),
        "fuzz": generate_fuzz_queries(),
    }

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    trees = 0
    errors = 0
    for name, queries in groups.items():
        entries = []
        for query in sorted(queries):
            entry: dict[str, object] = {"query": query}
            try:
                tree = parse_scryfall_query(query).to_json()
                entry["tree"] = json.dumps(tree, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                trees += 1
            except Exception as exc:  # noqa: BLE001 — any raise is part of the contract
                entry["error"] = {"type": type(exc).__name__, "message": str(exc)}
                errors += 1
            entries.append(entry)
        total += len(entries)
        out_path = FIXTURES_DIR / f"{name}.json"
        with out_path.open("w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print(f"wrote {out_path.relative_to(REPO_ROOT)}: {len(entries)} cases")

    print(f"total: {total} cases ({trees} trees, {errors} error verdicts)")
    export_tag_slugs()


# Written spellings whose slug form the three implementations must agree on. `slugify_tag` exists
# in Python (upstream), TypeScript (src/parser) and Rust (engine/builder) — the query side
# normalizes the search term and the import side stores the key it has to land on, so a
# disagreement makes `art:"open mouth"` silently return nothing. Generating the expectations from
# the vendored Python makes upstream the single source of truth instead of three hand-written lists.
_TAG_SLUG_CASES = [
    "fire",
    "Open Mouth",
    "  right facing  ",
    "a--b",
    "-lead-",
    "A_B",
    "!!!",
    "",
    "Multi   Space   Words",
    "UPPER",
    "trailing-",
    "with.dots.and-dashes",
    "digits123",
    "123",
    "café",
    "e—m dash",
    "tab\tseparated",
]


def export_tag_slugs() -> None:
    """Write the shared slugify expectations the TS and Rust ports are both tested against."""
    entries = [{"input": case, "slug": slugify_tag(case)} for case in _TAG_SLUG_CASES]
    out_path = FIXTURES_DIR / "tag-slugs.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"wrote {out_path.relative_to(REPO_ROOT)}: {len(entries)} slug cases")


if __name__ == "__main__":
    main()
