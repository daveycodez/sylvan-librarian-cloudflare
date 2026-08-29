//! Query-regex compilation: accepting the dialect the SQL path accepts.
//!
//! `o:/.../` is documented against PostgreSQL's `~*`
//! (docs/changelog/2025-02-02-regex-search.md), and two things it accepts the
//! `regex` crate does not:
//!
//! - **Lookaround.** `(?!…)`, `(?=…)`, `(?<=…)`, `(?<!…)`. The `regex` crate
//!   omits these by design — they are what costs it its linear-time guarantee.
//!   Lookahead is on the documented feature list.
//! - **Word-boundary escapes.** ARE spells them `\y`/`\Y`/`\m`/`\M`, and ARE's
//!   `\Z` is Rust's `\z`. `\y` and `\Z` have exact `regex`-crate spellings, so
//!   they are rewritten in place; `\m`/`\M` have none and become lookaround.
//!
//! Both were engine *declines* — a `build_filter` error that
//! `_search`'s blanket handler turned into a silent PostgreSQL fallback. That
//! made the SQL path load-bearing for a documented feature rather than a
//! crash net.
//!
//! A pattern the `regex` crate accepts still compiles on it, unchanged. The
//! backtracking engine is entered only where the fast one cannot go, which
//! keeps every existing optimization — most importantly the #734 trigram
//! narrowing, whose `regex_syntax::parse` reads the same pattern string.

use std::cell::Cell;
use std::sync::Arc;

use regex::Regex;

/// Backtracking steps allowed for one `is_match` before `fancy_regex` gives up.
///
/// Only reachable from a pattern that already declined the linear engine, and
/// only per candidate string. The ceiling matters because a lookaround pattern
/// has no literal factor for the trigram narrow to read, so it is evaluated
/// against the whole corpus: the bound is what keeps a pathological pattern
/// from turning one request into a CPU sink.
///
/// 8192 is upstream's calibrated public-search figure (#1047,
/// docs/issues/security-regex-execution-budget.md), adopted verbatim rather than
/// kept at the 1,000,000 this file first shipped. Two reasons the number can be
/// this tight here: upstream compiles EVERY pattern on `fancy_regex` and only
/// backtracking ones actually spend budget, which is exactly the set that reaches
/// this arm — so the two trees bound the same patterns — and exhausting it is no
/// longer a wrong answer but a reported one (see `REGEX_MATCH_FAILED` below).
const BACKTRACK_LIMIT: usize = 8192;

/// Prefix on a compile error that must surface as an unsupported-regex rejection
/// rather than an engine decline: the pattern is invalid for the public search
/// surface, so retrying it on the SQL path would fail the same way.
pub(crate) const REGEX_COMPILE_ERR_PREFIX: &str = "regex_compile:";

/// Prefix on a runtime match failure — `is_match` exhausting [`BACKTRACK_LIMIT`].
pub(crate) const REGEX_MATCH_ERR_PREFIX: &str = "regex_match:";

thread_local! {
    /// Set when an `is_match` on this thread aborted on the backtrack limit.
    ///
    /// The flag is what lets `is_match` keep returning a plain `bool` — the shape
    /// every per-card `Tri` call site wants — while a query that hit the ceiling
    /// still fails loudly instead of silently under-matching. Once set, every
    /// later match on the thread short-circuits to `false`: the answer is already
    /// known to be wrong, so there is nothing to gain by computing more of it.
    static REGEX_MATCH_FAILED: Cell<bool> = const { Cell::new(false) };
}

/// Whether a match on this thread has already aborted on the backtrack limit.
pub(crate) fn regex_match_failed() -> bool {
    REGEX_MATCH_FAILED.with(Cell::get)
}

/// Reset before bind/evaluate so a prior query on this thread cannot poison the next.
pub(crate) fn clear_regex_match_failed() {
    REGEX_MATCH_FAILED.with(|c| c.set(false));
}

/// Take and clear the failure flag; `Some(message)` when a match aborted at runtime.
pub(crate) fn take_regex_match_failed() -> Option<String> {
    REGEX_MATCH_FAILED.with(|c| {
        if c.get() {
            c.set(false);
            Some(format!("{REGEX_MATCH_ERR_PREFIX}regex execution limit exceeded"))
        } else {
            None
        }
    })
}

/// A compiled query regex, on whichever engine can express it.
///
/// `Clone` is cheap on both arms: `regex::Regex` is internally `Arc`-based, and
/// the backtracking arm is behind an `Arc` here for the same reason — see
/// `FilterExpr`'s `Clone` note.
#[derive(Clone, Debug)]
enum RegexEngine {
    /// The linear-time engine. Every pattern that can be, is.
    Fast(Regex),
    /// The backtracking engine: lookaround and backreferences only.
    Backtrack(Arc<fancy_regex::Regex>),
}

/// One compiled query pattern, plus the one fact about it the matcher needs on every candidate.
///
/// `self_reference` is CACHED rather than re-derived, and the reason is a cost the fix would
/// otherwise have charged to queries that do not use it: the matcher asks this question once per
/// candidate card, and answering it by scanning the compiled source for the sentinel is a scan of
/// ~250 bytes × the whole corpus on EVERY regex query, `~` or not.
#[derive(Clone, Debug)]
pub(crate) struct CompiledRegex {
    engine: RegexEngine,
    self_reference: bool,
}

/// The character `~` compiles to, and the one this engine writes into a card's own text in place
/// of its name before matching. See `translate_self_reference`.
///
/// U+10400 DESERET CAPITAL LETTER LONG I, chosen for two properties and not for taste. It is
/// `\p{Alphabetic}`, so the `\b` the compiled alternation puts around it means exactly what the
/// `\b` around the phrase alternatives means — the boundary is enforced by the regex engine
/// rather than by a hand-rolled scan that would have to re-implement Unicode `\w`. And it is
/// absent from the corpus: the whole 2026-05-31 bulk dump carries 17 astral-plane characters in
/// its searchable text, every one an Egyptian hieroglyph from the Amonkhet flavor text
/// (U+130xx-U+133xx), and nothing in the Deseret block at all.
pub(crate) const SELF_REF_SENTINEL: char = '\u{10400}';

/// The self-reference phrases `~` aliases, for EVERY card and independent of its own card types.
///
/// Scryfall's docs call `~` "an automatic alias for the current card name or “this spell” if the
/// card mentions itself", which understates it twice over: the phrase family is much wider than
/// "this spell", and it is not conditioned on the card's own type. Both halves are measured.
///
/// TYPE-INDEPENDENCE, three instants that never name themselves and whose only self-reference-
/// shaped text is inside an ability they GRANT to something else — all three match `o:/~/` on
/// api.scryfall.com 2026-08-28: Full Steam Ahead, Martyrdom, Storm the Citadel. So the expansion
/// is a fixed alternation, not a per-card choice keyed to the card's types.
///
/// THE MEMBERSHIP, one probe per phrase against a card whose text contains that phrase and
/// nothing else self-referential (`!"<card>" o:/~/`, 2026-08-28). In: creature (Kor Outfitter),
/// spell (Altar's Reap), land (Orzhov Guildgate), artifact (Midnight Clock), enchantment
/// (Beastmaster Ascension), card (Bone Dragon), aura (Psychic Venom), token (Rite of the Raging
/// Storm), equipment (Gate Smasher), vehicle (Voyager Glidecar), permanent (Hidden Stag), saga
/// (The War Games), siege (Invasion of Tolvada), class (Rogue Class), spacecraft (Uthros
/// Scanship), case (Case of the Filched Falcon).
///
/// OUT, and each of these is a card that does NOT match: turn (Surge of Brilliance), way (Mulch),
/// ability (Crown of Gondor), mana (Eldrazi Temple), combat (Neyith of the Dire Hunt), one
/// (Temporal Manipulation), effect (Edgewalker), process (Professor Onyx), phase (Najeela, the
/// Blade-Blossom), game (Commander's Insignia), only (Ondu Spiritdancer), step (Y'shtola Rhul),
/// main (Aggravated Assault), and — the one that says this list is hand-maintained upstream
/// rather than derived from the type system — DOOR (Ticket Booth // Tunnel of Hate). Rooms say
/// "when you unlock this door" and Scryfall does not count it.
///
/// Possessives need no entry of their own: `\bthis creature\b` matches inside "this creature's"
/// because `'` is not a word character, and Howlgeist ("this creature's") confirms it.
///
/// CONTRAPTION and ATTRACTION were the last two in, and they are worth their own paragraph
/// because they are the largest single block the phrase family carries: the Un-set assembled
/// permanents say "Whenever you crank this Contraption" and "When you visit this Attraction", and
/// nothing else in their text is self-referential. Counted whole rather than sampled, on
/// api.scryfall.com 2026-08-28 — `o:/this contraption/` is 45 and `o:/this contraption/ o:/~/` is
/// the same 45; `o:/this attraction/` is 10 and `o:/this attraction/ o:/~/` is the same 10. Every
/// card the phrase reaches is a card `~` reaches, which is what makes them members rather than a
/// coincidence, and the two probes in the format above are Arms Depot and Ferris Wheel, both 1.
/// Their absence was 47 of the 53 names `o:/~/` missed here.
const SELF_REF_THIS_PHRASES: &[&str] = &[
    "creature", "spell", "land", "artifact", "enchantment", "card", "aura", "token", "equipment",
    "vehicle", "permanent", "saga", "siege", "class", "spacecraft", "case", "contraption",
    "attraction",
];

/// Where `~` is being expanded, which decides WHICH alternatives it gets.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum SelfRefScope {
    /// No expansion: `~` is the literal tilde.
    ///
    /// EVERY COLUMN BUT THE TWO ORACLE ONES, and `ft:` is the one that took two measurements to
    /// place. `name:/~/`, `t:/~/` and `mana:/~/` are all 404 on api.scryfall.com (2026-08-28) —
    /// `name:` could not be, if `~` were the card's name there. `ft:/~/` is 2, which looks like
    /// an alias answering thinly and is not: the two cards are Blighted Agent and Urabrask the
    /// Hidden, whose Phyrexian-script flavor text contains a literal `~`, and the plain substring
    /// `ft:"~"` returns the same two. The phrase family confirms it from the other side —
    /// `ft:/this creature/` is 6 and `ft:/this creature/ -ft:/~/` is the same 6, so not one of
    /// those six matches. Expanding names on flavor answered 680 against 2.
    None,
    /// Rules text: the card's names AND the "this <noun>" phrase family. `o:/~/` 19,228,
    /// `fo:/~/` 22,037 — the difference being the reminder text `fo:` keeps.
    Oracle,
}

/// The alternation `~` expands to: the sentinel that stands in for whichever of the card's own
/// names the substitution found, plus — on rules text only — the fixed phrase family.
///
/// The sentinel is BARE, with no `\b` of its own, because the substitution has already checked
/// the boundary against the NAME's edges. That is not a simplification: for a name ending in
/// punctuation Scryfall's `\b<name>\b` demands a word character AFTER the punctuation, so
/// `!"Kaboom!" o:/~/` is 404 even though the card's text opens "Kaboom! deals damage" — and a
/// sentinel wearing its own `\b` would have called it a match. See `with_self_reference`.
fn self_reference_alternation(_scope: SelfRefScope) -> String {
    format!(
        r"(?:\bthis (?:{})\b|{})",
        SELF_REF_THIS_PHRASES.join("|"),
        SELF_REF_SENTINEL
    )
}

/// Replace every `~` outside a bracket expression with [`self_reference_alternation`].
///
/// An ESCAPED tilde expands too, which is Scryfall's behaviour and not an oversight here:
/// `o:/\~/` answers the same 19,228 as `o:/~/` (2026-08-28), so the backslash does not protect
/// it. Bracket expressions are left alone for the same reason the `\s…` shorthands are — see
/// `translate_query_escapes`.
pub(crate) fn translate_self_reference(pattern: &str, scope: SelfRefScope) -> String {
    if !pattern.contains('~') {
        return pattern.to_string();
    }
    let expansion = self_reference_alternation(scope);
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len() + expansion.len());
    let mut class_pos: Option<usize> = None;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            // `\~` loses the backslash and expands; every other escape is copied whole so the
            // class-tracking below never sees an escaped `[` or `]` as a delimiter.
            match chars.get(i + 1) {
                Some('~') if class_pos.is_none() => {
                    out.push_str(&expansion);
                    i += 2;
                    continue;
                }
                Some(&next) => {
                    out.push('\\');
                    out.push(next);
                    class_pos = class_pos.map(|n| n + 2);
                    i += 2;
                    continue;
                }
                None => {
                    out.push('\\');
                    break;
                }
            }
        }
        if c == '~' && class_pos.is_none() {
            out.push_str(&expansion);
            i += 1;
            continue;
        }
        match class_pos {
            None => {
                if c == '[' {
                    class_pos = Some(0);
                }
            }
            Some(0) if c == '^' => {}
            Some(0) if c == ']' => class_pos = Some(1),
            Some(_) if c == ']' => class_pos = None,
            Some(n) => class_pos = Some(n + 1),
        }
        out.push(c);
        i += 1;
    }
    out
}

/// The inline flags every query regex is compiled with, and the exact prefix the two callers that
/// read a compiled pattern back (`regex_tier`, `regex_required_factors`) strip before parsing it.
///
/// `i` is the `~*` operator the SQL path uses. `m` makes `^` and `$` match at every line boundary
/// rather than only at the ends of the string, which is what Scryfall does — measured against
/// api.scryfall.com on 2026-08-16, `o:/^Whenever you cast/ e:khm` returns Firja, Judge of Valor
/// (khm/209), whose oracle text is `"Flying, lifelink\nWhenever you cast your second spell each
/// turn, …"`, and `o:/lifelink$/ e:khm` returns it too. Oracle text is the only multi-line column,
/// so this changes nothing on the single-line ones (name, type line, artist, set code).
///
/// It does NOT turn on `s`: `.` still stops at a newline, verified the same way
/// (`o:/Flying.Whenever/ e:khm` is empty on Scryfall while `o:/Flying\nWhenever/ e:khm` is not).
/// Together that is exactly PostgreSQL ARE's newline-sensitive mode — the SQL path spells the
/// same pair `(?n)` — so the two paths still accept and answer one dialect.
///
/// Keep this a single `(?…)` group: the strippers match it by literal prefix.
pub(crate) const QUERY_REGEX_FLAGS: &str = "(?im)";

impl CompiledRegex {
    /// Compile a query pattern under [`QUERY_REGEX_FLAGS`].
    ///
    /// The error string is the linear engine's, not the backtracking one's: if
    /// both reject the pattern it is malformed rather than merely non-linear,
    /// and the first message is the one that names the actual syntax problem.
    pub(crate) fn new(pattern: &str) -> Result<Self, String> {
        Self::compile(pattern, SelfRefScope::None)
    }

    /// Compile with `~` expanded to the self-reference alternation.
    ///
    /// A SEPARATE ENTRY POINT BECAUSE THE COLUMN DECIDES, and Scryfall's answer says so out loud:
    /// `name:/~/` is 404 on api.scryfall.com (2026-08-28). If `~` were the card's name there, that
    /// query would be the whole corpus; it is nothing, so the alias is simply not expanded on
    /// `name:`. `t:/~/` and `mana:/~/` are 404 too — vacuously, since no type line or mana cost
    /// carries a self-reference — and on all three `~` stays the literal tilde no such field
    /// contains. The columns that DO expand it are the text ones: `o:/~/` 19,228, `fo:/~/` 22,037
    /// (the difference being reminder text, which `fo:` keeps), `ft:/~/` 2.
    pub(crate) fn new_self_referential(pattern: &str, scope: SelfRefScope) -> Result<Self, String> {
        Self::compile(pattern, scope)
    }

    fn compile(pattern: &str, scope: SelfRefScope) -> Result<Self, String> {
        let source = if scope == SelfRefScope::None {
            pattern.to_string()
        } else {
            translate_self_reference(pattern, scope)
        };
        // The EXPANSION is what matters, not the request: `o:/draw/` asked for expansion and got
        // none, so it must not pay the substitution or lose the narrow.
        let self_reference = source.contains(SELF_REF_SENTINEL);
        let translated = translate_query_escapes(&source);
        let cased = format!("{QUERY_REGEX_FLAGS}{translated}");
        match Regex::new(&cased) {
            Ok(re) => Ok(CompiledRegex { engine: RegexEngine::Fast(re), self_reference }),
            Err(linear_err) => match fancy_regex::RegexBuilder::new(&cased)
                .backtrack_limit(BACKTRACK_LIMIT)
                .build()
            {
                Ok(re) => Ok(CompiledRegex { engine: RegexEngine::Backtrack(Arc::new(re)), self_reference }),
                Err(_) => Err(format!("invalid regex '{pattern}': {linear_err}")),
            },
        }
    }

    /// Does this pattern match anywhere in `haystack`?
    ///
    /// Exceeding `BACKTRACK_LIMIT` returns `false` AND raises
    /// [`REGEX_MATCH_FAILED`], which the query entry points read once at the end
    /// and turn into an unsupported-regex error. That is what this used to get
    /// wrong: the limit was treated as "no match", a silent divergence from
    /// PostgreSQL (which raises) justified by not wanting to thread a fallible
    /// result through per-card `Tri` evaluation. The thread-local is the answer
    /// to that objection — the signature stays `bool` and the failure still
    /// escapes.
    ///
    /// The `Fast` arm cannot fail: the linear engine has no backtracking to run
    /// out of, which is the whole reason a pattern stays on it.
    #[inline]
    pub(crate) fn is_match(&self, haystack: &str) -> bool {
        match &self.engine {
            RegexEngine::Fast(re) => re.is_match(haystack),
            RegexEngine::Backtrack(re) => {
                if REGEX_MATCH_FAILED.with(Cell::get) {
                    return false;
                }
                match re.is_match(haystack) {
                    Ok(m) => m,
                    Err(fancy_regex::Error::RuntimeError(_)) => {
                        REGEX_MATCH_FAILED.with(|c| c.set(true));
                        false
                    }
                    Err(_) => false,
                }
            }
        }
    }

    /// The compiled pattern source, [`QUERY_REGEX_FLAGS`] prefix included.
    ///
    /// Feeds `regex_tier` (cost) and the #734 literal-factor extraction. The
    /// latter parses this with `regex_syntax`, which fails on a backtracking
    /// pattern and yields no factors — so those patterns lose the trigram
    /// narrow and scan, which is correct, just not fast.
    pub(crate) fn as_str(&self) -> &str {
        match &self.engine {
            RegexEngine::Fast(re) => re.as_str(),
            RegexEngine::Backtrack(re) => re.as_str(),
        }
    }

    /// True when this pattern needed the backtracking engine. Cost only.
    #[inline]
    pub(crate) fn is_backtracking(&self) -> bool {
        matches!(self.engine, RegexEngine::Backtrack(_))
    }

    /// True when `~` was expanded into this pattern, so matching it needs the per-card
    /// substitution — and so the #734 trigram narrow must decline.
    #[inline]
    pub(crate) fn has_self_reference(&self) -> bool {
        self.self_reference
    }
}

/// One mana symbol, as Scryfall's `\sm` shorthand means it.
///
/// MEASURED, not derived from the symbology table: every alternative below is a card the corpus
/// actually holds, and the whole expression was checked by asking api.scryfall.com for BOTH counts
/// on 2026-08-28 — `o:/\sm/` and `o:/<this>/` are 11,057 apiece, corpus-wide.
///
/// Four alternatives exist only because a probe found the card that needs them, and each is one
/// card wide: `{½}` (Cheap Ass), `{H}` — Scryfall's spelling of the generic Phyrexian symbol
/// (Rage Extractor) — `{HR}`/`{HW}` half-mana (Mons's Goblin Waiters), and `{P}`, which is
/// Bloomburrow's PAWPRINT and not Phyrexian at all (the five `Season of …` cards). The last is why
/// `\smp` below cannot simply reuse this: Scryfall counts `{P}` as a mana symbol and NOT as a
/// Phyrexian one, contradicting its own docs page, which offers `{P}` as a `\smp` example.
const MANA_SYMBOL: &str = r"\{(?:[0-9]+|[wubrgcsxyz]|[^{}]*/[^{}]*|h[wubrg]?|p|½)\}";

/// The same vocabulary MINUS the bare `{P}`, which is what `\smr` repeats over.
///
/// Scryfall's `\sm` counts the Bloomburrow PAWPRINT as a mana symbol and its two DERIVED
/// shorthands do not: `\smp` excludes it (42, not 47) and so does `\smr`. Measured on the
/// deployment after the shorthands landed, 2026-08-28: `o:/\smr/` answered 1,194 against
/// Scryfall's 1,189, and the five extras were exactly the `Season of …` cards, whose
/// `{P}{P} —` mode lines are a repeated pawprint and nothing else.
const REPEATABLE_MANA_SYMBOL: &str = r"\{(?:[0-9]+|[wubrgcsxyz]|[^{}]*/[^{}]*|h[wubrg]?|½)\}";

/// Scryfall's non-standard regex shorthands, as `(suffix after \s, expansion)`.
///
/// <https://scryfall.com/docs/regular-expressions> documents these as "not formal character
/// classes, it is just shorthand we have added", and they are the reason a `\s` in a query regex
/// cannot be read as whitespace without looking at what follows it. THE FAILURE THEY CAUSED HERE
/// WAS SILENT: `o:/\smp/` answers 42 on api.scryfall.com and answered ZERO here, because no
/// oracle text on earth contains whitespace followed by "mp" — and `o:/\sm/`, worse, answered a
/// plausible 10,791 against Scryfall's 11,057, a wrong number that looks like a right one.
///
/// EVERY EXPANSION IS A MEASURED EQUALITY, established by asking api.scryfall.com for the count
/// of the shorthand and the count of the expansion and requiring them to agree, corpus-wide,
/// 2026-08-28:
///
/// | shorthand | means                        | count  | expansion agrees |
/// |-----------|------------------------------|--------|------------------|
/// | `\ss`     | any card symbol              | 12,446 | yes              |
/// | `\sm`     | any mana symbol              | 11,057 | yes              |
/// | `\sc`     | any COLORED mana symbol      |  6,676 | yes              |
/// | `\smh`    | any hybrid card symbol       |    172 | yes              |
/// | `\smp`    | any Phyrexian card symbol    |     42 | yes              |
/// | `\smr`    | any REPEATED mana symbol     |  1,189 | see below        |
/// | `\spt`    | an X/X power/toughness       |  3,185 | yes              |
/// | `\spp`    | a +X/+X                      |  7,160 | yes              |
/// | `\smm`    | a -X/-X                      |    841 | yes              |
///
/// `\sc` excludes the half-mana symbols and `\smh` excludes the MONOCOLOR Phyrexian ones, both
/// measured rather than assumed: `\{[^{}]*[wubrg][^{}]*\}` is 6,677 against `\sc`'s 6,676 (the
/// extra is `{HR}`), and every symbol carrying a `/` is 213 against `\smh`'s 172 (the 41
/// difference is exactly `o:/\/p}/`, the `{X/P}` cards).
///
/// LONGEST MATCH. `\smm` is the -X/-X shorthand and not `\sm` followed by a literal `m`, and the
/// same holds for `\smr`/`\smh`/`\smp` against `\sm`. Scryfall reads them the same way and its
/// choice is observable: `o:/\smana/` is 404 there — `\sm` then "ana" — where this port answered
/// 2,784, the count for whitespace followed by "mana".
///
/// Each expansion is wrapped in `(?:…)` so a quantifier binds to the whole shorthand: `\sm{2}`
/// is two mana symbols, not one symbol whose closing brace repeats.
const SCRYFALL_SHORTHANDS: &[(&str, &str)] = &[
    // Three characters first, so the longest match wins.
    ("mh", r"(?:\{(?:[^{}]*/[^{}]*/[^{}]*|[^{}]*/[^{}p])\})"),
    ("mp", r"(?:\{(?:[^{}]*/p|h)\})"),
    ("mm", r"(?:-[0-9x*]+/-[0-9x*]+)"),
    ("pt", r"(?:[0-9x*]+/[0-9x*]+)"),
    ("pp", r"(?:\+[0-9x*]+/\+[0-9x*]+)"),
    ("s", r"(?:\{[^{}]*\})"),
    ("c", r"(?:\{[0-9wubrgcpxyz/½]*[wubrg][0-9wubrgcpxyz/½]*\})"),
];

/// Rewrite PostgreSQL ARE escapes that the `regex` crate spells differently or
/// cannot spell at all, and expand Scryfall's `\s…` shorthands.
///
/// | ARE  | meaning              | rewritten to      |
/// |------|----------------------|-------------------|
/// | `\y` | word boundary        | `\b`              |
/// | `\Y` | not a word boundary  | `\B`              |
/// | `\m` | start of a word      | `(?<!\w)(?=\w)`   |
/// | `\M` | end of a word        | `(?<=\w)(?!\w)`   |
/// | `\Z` | end of string        | `\z`              |
///
/// `\y`/`\Y`/`\Z` have exact equivalents, so a pattern using only those stays
/// on the linear engine. `\m`/`\M` do not, and their lookaround rewrite sends
/// the pattern to the backtracking engine — correct, and rare enough to be
/// worth the access path.
///
/// The `\s…` half is [`SCRYFALL_SHORTHANDS`] plus `\smr`, which is the one shorthand no static
/// expansion can express: "the SAME mana symbol twice" needs a backreference, so it compiles a
/// named group and `\k<…>` and therefore lands on `fancy_regex` — losing the #734 trigram narrow
/// along with it. Every other shorthand stays on the linear engine, and the group is NAMED (and
/// numbered per occurrence) so it cannot collide with a capture the user wrote.
///
/// Bracket expressions are copied through untouched: inside `[…]` these are
/// ordinary escapes, not constraints. A `]` in the first position of a class is
/// literal (POSIX), so it does not close it. Scryfall does NOT skip classes —
/// `o:/[\sm]/` comes back "parentheses () not balanced" there, its own substitution having
/// broken the class — and reproducing that particular bug would turn a query that reads
/// perfectly well ("whitespace or the letter m") into an error.
///
/// THE UPPERCASE CLASS ESCAPES ARE A DELIBERATE NON-REPRODUCTION, and the only place in this
/// dialect where matching Scryfall was chosen against. Scryfall downcases the WHOLE pattern before
/// it compiles anything, so `\S` arrives at its engine as `\s` and the negation is simply lost.
/// Measured 2026-08-28 against api.scryfall.com, with this engine's answer beside it:
///
/// | query | Scryfall | here |
/// |---|---|---|
/// | `o:/\sdraw/` | 3,604 | 3,604 |
/// | `o:/\Sdraw/` | 3,604 | 1 |
/// | `o:/\Wdraw/` | 0 | 3,605 |
/// | `o:/\Ddraw/` | 0 | 3,605 |
///
/// `\S` answering the same 3,604 as `\s` is the whole proof: "non-whitespace then draw" and
/// "whitespace then draw" cannot both be 3,604 unless one of them is not being read. `\W` and `\D`
/// are the same fold seen from the other side — downcased to `\w` and `\d`, which no oracle text
/// satisfies before "draw", they answer nothing at all rather than the thousands they describe.
///
/// Reproducing this would mean case-folding the pattern here too, which costs every uppercase
/// escape a user could write and buys a bug. The shorthands above are lowercase-only for the same
/// reason the fold is not copied: `\Sm` is "non-whitespace, then m", not a mana symbol.
pub(crate) fn translate_query_escapes(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len());
    // Position within the current bracket expression, if any: `Some(n)` means
    // n characters have been consumed since `[`, which is how the leading-`]`
    // rule is applied without a second scan.
    let mut class_pos: Option<usize> = None;
    // Distinguishes the capture groups two `\smr`s in one pattern would otherwise share.
    let mut smr_seq = 0usize;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            i += 1;
            let Some(&next) = chars.get(i) else {
                out.push('\\');
                break;
            };
            i += 1;
            if class_pos.is_some() {
                out.push('\\');
                out.push(next);
                class_pos = class_pos.map(|n| n + 2);
                continue;
            }
            if next == 's' {
                if chars.get(i) == Some(&'m') && chars.get(i + 1) == Some(&'r') {
                    out.push_str(&format!("(?:(?<smr{smr_seq}>{REPEATABLE_MANA_SYMBOL})\\k<smr{smr_seq}>)"));
                    smr_seq += 1;
                    i += 2;
                    continue;
                }
                if chars.get(i) == Some(&'m')
                    && !matches!(chars.get(i + 1), Some('h') | Some('p') | Some('m'))
                {
                    out.push_str(&format!("(?:{MANA_SYMBOL})"));
                    i += 1;
                    continue;
                }
                if let Some((suffix, expansion)) = SCRYFALL_SHORTHANDS.iter().find(|(suffix, _)| {
                    suffix.chars().enumerate().all(|(k, sc)| chars.get(i + k) == Some(&sc))
                }) {
                    out.push_str(expansion);
                    i += suffix.chars().count();
                    continue;
                }
            }
            match next {
                'y' => out.push_str(r"\b"),
                'Y' => out.push_str(r"\B"),
                'm' => out.push_str(r"(?<!\w)(?=\w)"),
                'M' => out.push_str(r"(?<=\w)(?!\w)"),
                'Z' => out.push_str(r"\z"),
                other => {
                    out.push('\\');
                    out.push(other);
                }
            }
            continue;
        }

        match class_pos {
            None => {
                if c == '[' {
                    class_pos = Some(0);
                }
            }
            // A leading `^` negates without occupying the first position, so
            // `[^]…]` gets the same literal-`]` treatment as `[]…]`.
            Some(0) if c == '^' => {}
            // `[]…]`: a `]` in the first position is a literal member.
            Some(0) if c == ']' => class_pos = Some(1),
            Some(_) if c == ']' => class_pos = None,
            Some(n) => class_pos = Some(n + 1),
        }
        out.push(c);
        i += 1;
    }
    out
}
