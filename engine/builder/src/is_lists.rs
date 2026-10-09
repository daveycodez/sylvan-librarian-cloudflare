//! THE `is:` CLASSES THAT ARE SCRYFALL'S OWN RECORD — copied, not derived.
//!
//! Eight values api.scryfall.com answers from a list it keeps and no field of a card object
//! decides: `covered`, `intro`, `invitational`, `jumpstart`, `misprint`, `related`, `spellbook`
//! and `spikey`. Each was read whole on 2026-10-09 (`unique=prints`, extras in, every language)
//! against the same day's bulk file, rules were tried over it, and where none reproduced the
//! answer the answer itself is the data: `is_lists.tsv`, written by
//! scripts/generate-is-lists.ts (`bun run is-lists`). What each value is, and what was tried, is
//! written at its constant in transform.rs.
//!
//! THE TABLE names a value's printings at the widest key that is exact:
//!
//! ```text
//! set      <set>                    every printing of the set
//! oracle   <oracle id> <name>       every printing of the card, by any of its faces' ids
//! print    <set> <numbers>          these collector numbers, in every language
//! row      <set> <lang> <numbers>   these collector numbers, in this language alone
//! not      <set> <numbers>          out, whatever a set, a card or the rule says
//! not-row  <set> <lang> <numbers>   out in this language alone
//! ```
//!
//! The narrowest key wins: a row's own line, then its printing's, then its set's or its card's.
//! Where the table says nothing about a printing the answer is the value's RULE — none for the
//! six plain lists, `all_parts` for `related`, the print tier for `covered` — which is what a
//! printing added after the table was measured gets.
//!
//! WHAT IT COSTS. One lookup by set, one by (set, collector number) and one per oracle id for each
//! row imported, whatever the number of values; nothing at query time, where each is an ordinary
//! `card_is_tags` member. The table is compiled in, so the nightly import reads no network for it
//! and it goes stale until `bun run is-lists` is run again and committed.

use std::collections::HashMap;
use std::sync::LazyLock;

use crate::transform::{
    COVERED_IS_TAG, INTRO_IS_TAG, INVITATIONAL_IS_TAG, JUMPSTART_IS_TAG, MISPRINT_IS_TAG, RELATED_IS_TAG, SPELLBOOK_IS_TAG,
    SPIKEY_IS_TAG,
};

/// The values the table may name, in the order [`Verdicts`] holds them.
pub const LIST_TAGS: [&str; 8] = [
    COVERED_IS_TAG,
    INTRO_IS_TAG,
    INVITATIONAL_IS_TAG,
    JUMPSTART_IS_TAG,
    MISPRINT_IS_TAG,
    RELATED_IS_TAG,
    SPELLBOOK_IS_TAG,
    SPIKEY_IS_TAG,
];

const IS_LISTS_TSV: &str = include_str!("is_lists.tsv");

/// What the table says about one row for each of [`LIST_TAGS`]: in, out, or nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Verdicts([Option<bool>; LIST_TAGS.len()]);

impl Verdicts {
    /// The table's answer for `tag`, or `None` where it has none and the value's rule decides.
    pub fn of(&self, tag: &str) -> Option<bool> {
        LIST_TAGS.iter().position(|t| *t == tag).and_then(|i| self.0[i])
    }
}

/// One `print`/`row`/`not`/`not-row` entry under a (set, collector number): the value, the one
/// language it is about (`""` for all of them) and whether the printing is in.
type Entry = (u8, &'static str, bool);

#[derive(Default)]
struct Table {
    by_set: HashMap<&'static str, Vec<u8>>,
    by_oracle: HashMap<&'static str, Vec<u8>>,
    by_print: HashMap<(&'static str, &'static str), Vec<Entry>>,
    /// The fingerprint of print_tiers.tsv the `covered` lines were measured against.
    tiers_fingerprint: Option<&'static str>,
}

fn parse(tsv: &'static str) -> Table {
    let mut table = Table::default();
    for line in tsv.lines().filter(|l| !l.is_empty()) {
        if let Some(comment) = line.strip_prefix('#') {
            if let Some(fingerprint) = comment.trim().strip_prefix("print_tiers.tsv ") {
                table.tiers_fingerprint = Some(fingerprint);
            }
            continue;
        }
        let fields: Vec<&'static str> = line.split('\t').collect();
        let Some(tag) = fields.first().and_then(|t| LIST_TAGS.iter().position(|x| x == t)) else {
            panic!("is_lists.tsv: malformed row {line:?}")
        };
        let tag = tag as u8;
        let numbers = |set: &'static str, lang: &'static str, numbers: &'static str, is_in: bool, table: &mut Table| {
            for number in numbers.split(' ') {
                if number.is_empty() {
                    panic!("is_lists.tsv: an empty collector number in {line:?}");
                }
                table.by_print.entry((set, number)).or_default().push((tag, lang, is_in));
            }
        };
        match fields[1..] {
            ["set", set] => table.by_set.entry(set).or_default().push(tag),
            ["oracle", id, _name] => table.by_oracle.entry(id).or_default().push(tag),
            ["print", set, list] => numbers(set, "", list, true, &mut table),
            ["not", set, list] => numbers(set, "", list, false, &mut table),
            ["row", set, lang, list] => numbers(set, lang, list, true, &mut table),
            ["not-row", set, lang, list] => numbers(set, lang, list, false, &mut table),
            _ => panic!("is_lists.tsv: malformed row {line:?}"),
        }
    }
    table
}

static TABLE: LazyLock<Table> = LazyLock::new(|| parse(IS_LISTS_TSV));

fn verdicts_in<'a>(
    table: &Table,
    set: &str,
    lang: &str,
    number: &str,
    oracle_ids: impl IntoIterator<Item = &'a str>,
) -> Verdicts {
    let mut out = Verdicts::default();
    for tag in table.by_set.get(set).into_iter().flatten() {
        out.0[*tag as usize] = Some(true);
    }
    for id in oracle_ids {
        for tag in table.by_oracle.get(id).into_iter().flatten() {
            out.0[*tag as usize] = Some(true);
        }
    }
    if let Some(entries) = table.by_print.get(&(set, number)) {
        // Every language's line first, then this language's own over it.
        for (tag, _, is_in) in entries.iter().filter(|(_, l, _)| l.is_empty()) {
            out.0[*tag as usize] = Some(*is_in);
        }
        for (tag, _, is_in) in entries.iter().filter(|(_, l, _)| !l.is_empty() && *l == lang) {
            out.0[*tag as usize] = Some(*is_in);
        }
    }
    out
}

/// What the measured table says about the row of `set`/`number` in `lang` whose card carries
/// `oracle_ids` (its own, or each face's).
pub fn verdicts<'a>(set: &str, lang: &str, number: &str, oracle_ids: impl IntoIterator<Item = &'a str>) -> Verdicts {
    verdicts_in(&TABLE, set, lang, number, oracle_ids)
}

/// 64-bit FNV-1a, as scripts/generate-is-lists.ts computes it over print_tiers.tsv.
#[cfg(test)]
fn fnv1a64(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_parses_and_names_every_value() {
        let table = parse(IS_LISTS_TSV);
        let mut named = [false; LIST_TAGS.len()];
        let tags = table.by_set.values().flatten().chain(table.by_oracle.values().flatten()).copied();
        for tag in tags.chain(table.by_print.values().flatten().map(|(tag, _, _)| *tag)) {
            named[tag as usize] = true;
        }
        assert_eq!(named, [true; LIST_TAGS.len()], "a value of {LIST_TAGS:?} has no line");
    }

    /// `covered` is written as differences from `ranks::print_tier`, which reads print_tiers.tsv:
    /// a tier table regenerated without `bun run is-lists` after it would leave every difference
    /// measured against another rule.
    #[test]
    fn covered_was_measured_against_this_tier_table() {
        let recorded = parse(IS_LISTS_TSV).tiers_fingerprint.expect("is_lists.tsv records a print_tiers.tsv fingerprint");
        assert_eq!(
            recorded,
            fnv1a64(include_bytes!("print_tiers.tsv")),
            "print_tiers.tsv changed since is_lists.tsv was generated: run `bun run is-lists`"
        );
    }

    #[test]
    fn the_narrowest_key_wins() {
        let table = parse(concat!(
            "# print_tiers.tsv 0000000000000000\n",
            "jumpstart\tset\tjmp\n",
            "jumpstart\tnot-row\tjmp\tph\t58\n",
            "spikey\toracle\taaaa\tCounterspell\n",
            "spikey\tnot\tarn\t33†\n",
            "misprint\trow\t4bb\tes\t50 180\n",
            "covered\tprint\tltr\t7\n",
            "covered\tnot-row\tltr\tfr\t7\n",
        ));
        let v = |set, lang, number, oracle: &'static str| verdicts_in(&table, set, lang, number, [oracle]);
        assert_eq!(v("jmp", "en", "58", "x").of("jumpstart"), Some(true));
        assert_eq!(v("jmp", "ph", "58", "x").of("jumpstart"), Some(false));
        assert_eq!(v("j22", "en", "58", "x").of("jumpstart"), None);
        assert_eq!(v("lea", "en", "54", "aaaa").of("spikey"), Some(true));
        assert_eq!(v("arn", "en", "33†", "aaaa").of("spikey"), Some(false));
        assert_eq!(v("4bb", "es", "50", "x").of("misprint"), Some(true));
        assert_eq!(v("4bb", "ja", "50", "x").of("misprint"), None);
        assert_eq!(v("ltr", "en", "7", "x").of("covered"), Some(true));
        assert_eq!(v("ltr", "fr", "7", "x").of("covered"), Some(false));
        assert_eq!(v("ltr", "fr", "8", "x").of("covered"), None);
    }

    #[test]
    #[should_panic(expected = "malformed row")]
    fn an_unknown_value_stops_the_build() {
        parse("gainland\tset\tktk\n");
    }

    #[test]
    #[should_panic(expected = "malformed row")]
    fn an_unknown_kind_stops_the_build() {
        parse("spikey\tname\tCounterspell\n");
    }
}
