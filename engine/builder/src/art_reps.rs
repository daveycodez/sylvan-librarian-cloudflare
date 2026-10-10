//! WHICH PRINTING REPRESENTS AN ARTWORK — Scryfall's own record, read whole.
//!
//! `unique=art` returns one printing per artwork, and api.scryfall.com keeps which one per
//! illustration: asked for an artwork's printings one at a time, it answers ONE first and then the
//! card's own order (`!"Vizzerdrix"`: 7ed/110, then 9ed/S7, 9ed/S7a, 8ed/S5, 8ed/S5a, 7ed/110★).
//! That one is the first printing of the artwork for most, and where the first day holds several
//! it follows no field of a card object — the extended-art mkm/422 for Cryptex and the plain
//! lci/126 for Tarrian's Journal, the invisible-ink foil mkm/379 over the showcase mkm/341, the
//! promo-pack ecl/403 over ecl/69; the best key, not a promo and then the lowest number, names
//! 81% of 9,910 such artworks.
//!
//! So it is measured. A search that matches every card returns every artwork's representative,
//! and `art_reps.tsv` (scripts/generate-art-reps.ts, `bun run art-reps`) holds them by set. With
//! the table as the mark, "the representative where the query holds it, else the first of the
//! card's own order" is Scryfall's answer for 3,700 of 3,700 artworks with two or more printings
//! in scope, over 24 scopes read 2026-10-10 — twelve sets, six release groups, four sets of
//! reprints without their originals, the variations; the debut rule had 3,111.
//!
//! A SET THE TABLE NAMES IS ANSWERED BY IT ALONE, UP TO THE DAY IT WAS WRITTEN, and every set
//! Scryfall listed that day is named, with or without a row. A printing released since — dated
//! after the table's `@written` day, a new set's or a new Secret Lair drop's in an old one — and a
//! set it does not name fall back to the debut rule (`transform::NewArt::standing`), which is
//! right for a reprint — the representative of an old artwork is an old printing, and a later one
//! is not of the debut's day — and is what this port answered before for an artwork the new
//! printing brings. So the table goes stale by one release at a time and only for that release's
//! own artworks, until `bun run art-reps` reads them.

use std::collections::HashMap;
use std::sync::LazyLock;

/// Scryfall's representative rows by set (scripts/generate-art-reps.ts).
const ART_REPS_TSV: &str = include_str!("art_reps.tsv");

/// One set's representative rows: its English whole numbers as sorted, disjoint runs, and every
/// other row as the table writes it (`number`, or `number@lang` where it is not English), sorted.
#[derive(Default)]
struct SetReps {
    runs: Vec<(u32, u32)>,
    rows: Vec<&'static str>,
}

/// The table: the day it was read (`@written <TAB> YYYY-MM-DD`), and each set's rows.
struct Table {
    written: &'static str,
    sets: HashMap<&'static str, SetReps>,
}

static ART_REPS: LazyLock<Table> = LazyLock::new(|| parse(ART_REPS_TSV));

/// A collector number that is a whole number as written — `7`, not `007` or `7a` — which is what
/// the table folds into runs.
fn whole(collector_number: &str) -> Option<u32> {
    let plain = !collector_number.is_empty()
        && collector_number.bytes().all(|b| b.is_ascii_digit())
        && (collector_number == "0" || !collector_number.starts_with('0'));
    plain.then(|| collector_number.parse().ok()).flatten()
}

fn parse(text: &'static str) -> Table {
    let mut sets: HashMap<&'static str, SetReps> = HashMap::new();
    let mut written = None;
    for line in text.lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let (set, tokens) = line.split_once('\t').unwrap_or_else(|| panic!("art_reps.tsv: malformed row {line:?}"));
        if set == "@written" {
            assert!(tokens.len() == 10 && tokens.is_ascii(), "art_reps.tsv: not a date: {tokens:?}");
            written = Some(tokens);
            continue;
        }
        let reps = sets.entry(set).or_default();
        for token in tokens.split(' ').filter(|t| !t.is_empty()) {
            let run = match token.split_once("..") {
                Some((first, last)) => whole(first).zip(whole(last)),
                None => whole(token).map(|n| (n, n)),
            };
            match run {
                Some((first, last)) if first <= last => reps.runs.push((first, last)),
                Some(_) => panic!("art_reps.tsv: a run that descends: {token:?}"),
                None if token.contains("..") => panic!("art_reps.tsv: a run of something else: {token:?}"),
                None => reps.rows.push(token),
            }
        }
        reps.runs.sort_unstable();
        reps.rows.sort_unstable();
    }
    Table { written: written.expect("art_reps.tsv: no @written row"), sets }
}

/// Whether this row represents its artwork on Scryfall — `None` for a set the table does not name
/// and for a printing released (`released_at`, `YYYY-MM-DD`) after the table was written, where
/// the caller's rule stands.
pub fn verdict(set: &str, collector_number: &str, lang: &str, released_at: &str) -> Option<bool> {
    verdict_in(&ART_REPS, set, collector_number, lang, released_at)
}

fn verdict_in(table: &Table, set: &str, collector_number: &str, lang: &str, released_at: &str) -> Option<bool> {
    if released_at > table.written {
        return None;
    }
    let reps = table.sets.get(set)?;
    if lang == "en"
        && let Some(n) = whole(collector_number)
    {
        let at = reps.runs.partition_point(|&(first, _)| first <= n);
        return Some(at > 0 && n <= reps.runs[at - 1].1);
    }
    let found = if lang == "en" {
        reps.rows.binary_search(&collector_number).is_ok()
    } else {
        reps.rows.binary_search_by(|row| cmp_row(row, collector_number, lang)).is_ok()
    };
    Some(found)
}

/// Compare a stored `number@lang` (or bare `number`) with the pair asked for, as the stored string
/// compares with `number@lang` — without building that string for every row of the corpus.
fn cmp_row(row: &str, collector_number: &str, lang: &str) -> std::cmp::Ordering {
    let asked = collector_number.bytes().chain(std::iter::once(b'@')).chain(lang.bytes());
    row.bytes().cmp(asked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_parses_and_names_scryfalls_representatives() {
        let sets = &ART_REPS.sets;
        assert!(ART_REPS.written >= "2026-10-10", "the day the table was read: {}", ART_REPS.written);
        assert!(sets.len() > 1_000, "every set Scryfall lists is named: {}", sets.len());
        let rows: usize = sets.values().map(|s| s.rows.len() + s.runs.iter().map(|(a, b)| (b - a + 1) as usize).sum::<usize>()).sum();
        assert!(rows > 50_000, "one row an artwork: {rows}");
        for reps in sets.values() {
            assert!(reps.runs.windows(2).all(|w| w[0].1 < w[1].0), "runs are disjoint and sorted");
        }
        // api.scryfall.com, 2026-10-10. Murders at Karlov Manor: the plain printing of Case of the
        // Shattered Pact; the invisible-ink foil of Conspiracy Unraveler's dossier art, not the
        // showcase printing it copies; the extended-art Cryptex, not the plain one.
        assert_eq!(verdict("mkm", "1", "en", "2024-02-09"), Some(true));
        assert_eq!(verdict("mkm", "379", "en", "2024-02-09"), Some(true));
        assert_eq!(verdict("mkm", "341", "en", "2024-02-09"), Some(false));
        assert_eq!(verdict("mkm", "422", "en", "2024-02-09"), Some(true));
        assert_eq!(verdict("mkm", "251", "en", "2024-02-09"), Some(false));
        // 7th Edition: the nonfoil, not the foil `new:art` names; a number that is not whole.
        assert_eq!(verdict("7ed", "110", "en", "2001-04-11"), Some(true));
        assert_eq!(verdict("7ed", "110★", "en", "2001-04-11"), Some(false));
        // A translation of a representative is not it; a row printed in one language alone can be.
        assert_eq!(verdict("mkm", "1", "ja", "2024-02-09"), Some(false));
        assert_eq!(verdict("war", "184★", "ja", "2019-05-03"), Some(true));
        assert_eq!(verdict("war", "184★", "en", "2019-05-03"), Some(false));
        // A set the table does not name, and a printing dated after the table — in a set it
        // names, at a number it holds or not: the caller's rule stands.
        assert_eq!(verdict("zzz", "1", "en", "2024-02-09"), None);
        assert_eq!(verdict("mkm", "422", "en", "2099-01-01"), None);
        assert_eq!(verdict("mkm", "251", "en", "2099-01-01"), None);
    }

    #[test]
    fn a_row_is_found_by_its_number_and_language_as_the_table_writes_them() {
        let table = parse("# header\n@written\t2020-06-15\nabc\t1..3 7 10..12 007 12a 5@ja A-5@de\nempty\t\n");
        let has = |set: &str, cn: &str, lang: &str| verdict_in(&table, set, cn, lang, "2020-06-15").unwrap();
        for cn in ["1", "2", "3", "7", "10", "11", "12"] {
            assert!(has("abc", cn, "en"), "{cn}");
        }
        for cn in ["0", "4", "6", "8", "9", "13", "5", "A-5", "12b"] {
            assert!(!has("abc", cn, "en"), "{cn}");
        }
        // A number with a leading zero or a letter is its own row, not part of a run.
        assert!(has("abc", "007", "en") && has("abc", "12a", "en"));
        // A row that is not English is found in its language alone.
        assert!(has("abc", "5", "ja") && has("abc", "A-5", "de"));
        assert!(!has("abc", "5", "de") && !has("abc", "1", "ja"));
        assert!(table.sets.contains_key("empty") && !has("empty", "1", "en"));
        // The day the table was read is the last it speaks for.
        assert_eq!(verdict_in(&table, "abc", "1", "en", "2020-06-15"), Some(true));
        assert_eq!(verdict_in(&table, "abc", "1", "en", "2020-06-16"), None);
        assert_eq!(verdict_in(&table, "empty", "1", "en", "2020-06-16"), None);
        assert_eq!(verdict_in(&table, "nil", "1", "en", "2020-01-01"), None);
        assert_eq!(whole("12"), Some(12));
        assert_eq!(whole("007"), None);
        assert_eq!(whole("12a"), None);
    }
}
