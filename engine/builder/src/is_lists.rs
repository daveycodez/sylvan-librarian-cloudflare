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
//! printing added after the table was measured gets. `covered` is read back by the rank
//! ([`crate::ranks::recorded_tier`]): a printing's tier is this record of it where there is one.
//!
//! WHAT IT COSTS. One lookup by set, one by (set, collector number) and one per oracle id for each
//! row imported, whatever the number of values; nothing at query time, where each is an ordinary
//! `card_is_tags` member.
//!
//! THE COMPILED TABLE AND ITS OVERRIDE. The table is compiled in (`include_str!`): exact on the day
//! `bun run is-lists` wrote it, and drifting from then on — over five days `covered` moved by 125
//! printings, `related` by 41, `misprint` by 22. So the nightly import refetches what moved
//! (src/import-is-lists.ts) and hands this module a WHOLE table in the same encoding,
//! [`set_override`], which supersedes the compiled one for every lookup until the process — a wasm
//! instance, a native build — ends. An override is refused, and the table in force stands, unless
//! it parses line for line, names the compiled table it was composed over (`# base`, the FNV-1a of
//! this build's own table: an override composed for another build's table is not this build's)
//! and the tier table its `covered` lines were measured against (`# print_tiers.tsv`). With no
//! override installed nothing here differs from the compiled table alone.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

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
    /// An override's `# base` line: the fingerprint of the compiled table it was composed over.
    base: Option<&'static str>,
    /// An override's `# meta` line, verbatim: what the importer says about it (its dates), carried
    /// to the manifest and not read here.
    meta: Option<&'static str>,
    /// Data lines read.
    lines: usize,
}

/// The table in `tsv`, or the first line that is not one.
fn try_parse(tsv: &'static str) -> Result<Table, String> {
    let mut table = Table::default();
    for line in tsv.lines().filter(|l| !l.is_empty()) {
        if let Some(comment) = line.strip_prefix('#') {
            let comment = comment.trim();
            if let Some(fingerprint) = comment.strip_prefix("print_tiers.tsv ") {
                table.tiers_fingerprint = Some(fingerprint);
            } else if let Some(base) = comment.strip_prefix("base ") {
                table.base = Some(base);
            } else if let Some(meta) = comment.strip_prefix("meta ") {
                table.meta = Some(meta);
            }
            continue;
        }
        let malformed = || format!("is_lists.tsv: malformed row {line:?}");
        let fields: Vec<&'static str> = line.split('\t').collect();
        if fields.iter().any(|f| f.is_empty()) {
            return Err(malformed());
        }
        let Some(tag) = fields.first().and_then(|t| LIST_TAGS.iter().position(|x| x == t)) else {
            return Err(malformed());
        };
        let tag = tag as u8;
        let numbers = |set: &'static str, lang: &'static str, numbers: &'static str, is_in: bool, table: &mut Table| {
            for number in numbers.split(' ') {
                if number.is_empty() {
                    return Err(format!("is_lists.tsv: an empty collector number in {line:?}"));
                }
                table.by_print.entry((set, number)).or_default().push((tag, lang, is_in));
            }
            Ok(())
        };
        match fields[1..] {
            ["set", set] => table.by_set.entry(set).or_default().push(tag),
            ["oracle", id, _name] => table.by_oracle.entry(id).or_default().push(tag),
            ["print", set, list] => numbers(set, "", list, true, &mut table)?,
            ["not", set, list] => numbers(set, "", list, false, &mut table)?,
            ["row", set, lang, list] => numbers(set, lang, list, true, &mut table)?,
            ["not-row", set, lang, list] => numbers(set, lang, list, false, &mut table)?,
            _ => return Err(malformed()),
        }
        table.lines += 1;
    }
    Ok(table)
}

/// The compiled table: a line that is not one stops the build.
fn parse(tsv: &'static str) -> Table {
    try_parse(tsv).unwrap_or_else(|problem| panic!("{problem}"))
}

static TABLE: LazyLock<Table> = LazyLock::new(|| parse(IS_LISTS_TSV));

/// The table that supersedes the compiled one, when the importer has installed one.
static OVERRIDE: RwLock<Option<&'static Table>> = RwLock::new(None);

fn installed() -> Option<&'static Table> {
    *OVERRIDE.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The compiled table's text, for the importer to compose an override over.
pub fn compiled_tsv() -> &'static str {
    IS_LISTS_TSV
}

/// The compiled table's fingerprint: what an override's `# base` line must name.
pub fn compiled_fingerprint() -> String {
    fnv1a64(IS_LISTS_TSV.as_bytes())
}

/// The day the compiled table was measured, from its first line (`… api.scryfall.com, 2026-10-09.`).
pub fn compiled_date() -> Option<&'static str> {
    let date = IS_LISTS_TSV.lines().next()?.trim_end_matches('.').rsplit(' ').next()?;
    let shaped = date.len() == 10
        && date.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    shaped.then_some(date)
}

/// `tsv` as a table that may stand in for the compiled one, or why it may not.
fn checked_override(tsv: &'static str) -> Result<Table, String> {
    let table = try_parse(tsv)?;
    let base = compiled_fingerprint();
    if table.base != Some(base.as_str()) {
        return Err(format!(
            "the override was composed over table {} and this build compiles {base}",
            table.base.unwrap_or("(no `# base` line)")
        ));
    }
    if table.tiers_fingerprint != TABLE.tiers_fingerprint {
        return Err(format!(
            "the override's `covered` lines were measured against print_tiers.tsv {} and this build compiles {}",
            table.tiers_fingerprint.unwrap_or("(none recorded)"),
            TABLE.tiers_fingerprint.unwrap_or("(none recorded)")
        ));
    }
    if table.lines == 0 {
        return Err("the override holds no line".to_owned());
    }
    Ok(table)
}

/// Install `tsv` as the table every later [`verdicts`] call reads, in place of the compiled one.
/// Returns the lines it holds. A refused override changes nothing: the table in force before the
/// call stays.
///
/// The text is leaked — the table borrows its keys from it for the life of the process, as the
/// compiled table borrows from the binary — so this is called once per wasm instance or native
/// build, never per row.
pub fn set_override(tsv: String) -> Result<usize, String> {
    let table = checked_override(Box::leak(tsv.into_boxed_str()))?;
    let lines = table.lines;
    *OVERRIDE.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Box::leak(Box::new(table)));
    Ok(lines)
}

/// [`set_override`] from a file (the native builder's `--is-lists`, memprobe's).
pub fn set_override_from_file(path: &std::path::Path) -> Result<usize, String> {
    set_override(std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?)
}

/// Back to the compiled table.
pub fn clear_override() {
    *OVERRIDE.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// What a build's manifest says about the lists it tagged from (`StoreManifest.is_lists`): the
/// installed override's own `# meta` object, or the compiled table's day.
pub fn manifest_note() -> serde_json::Value {
    let meta = installed().and_then(|t| t.meta).and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok());
    match meta {
        Some(meta) if meta.is_object() => meta,
        _ => serde_json::json!({ "base": compiled_date(), "source": "compiled" }),
    }
}

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

/// What the measured table — the installed override, else the compiled one — says about the row
/// of `set`/`number` in `lang` whose card carries `oracle_ids` (its own, or each face's).
pub fn verdicts<'a>(set: &str, lang: &str, number: &str, oracle_ids: impl IntoIterator<Item = &'a str>) -> Verdicts {
    verdicts_in(installed().unwrap_or(&TABLE), set, lang, number, oracle_ids)
}

/// 64-bit FNV-1a, as src/import-is-lists.ts computes it over print_tiers.tsv and over this table.
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

    fn leak(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    fn override_text(body: &str) -> &'static str {
        let tiers = TABLE.tiers_fingerprint.expect("a recorded fingerprint");
        let base = compiled_fingerprint();
        leak(format!("# base {base}\n# print_tiers.tsv {tiers}\n# meta {{\"checked\":\"2026-10-10\"}}\n{body}"))
    }

    /// The override's table, without the process-wide slot (tests/is_lists_override.rs installs one).
    #[test]
    fn an_override_is_a_whole_table_in_the_same_encoding() {
        let table =
            checked_override(override_text("spellbook\toracle\tbbbb\tNew Card\ncovered\trow\tzzz\ten\t1 2\n")).unwrap();
        assert_eq!(table.lines, 2);
        assert_eq!(table.meta, Some("{\"checked\":\"2026-10-10\"}"));
        assert_eq!(verdicts_in(&table, "lea", "en", "1", ["bbbb"]).of("spellbook"), Some(true));
        assert_eq!(verdicts_in(&table, "zzz", "en", "2", ["x"]).of("covered"), Some(true));
        // It SUPERSEDES: what only the compiled table names is not in it.
        assert_eq!(verdicts_in(&table, "jmp", "en", "1", ["x"]).of("jumpstart"), None);
        assert_eq!(verdicts_in(&TABLE, "jmp", "en", "1", ["x"]).of("jumpstart"), Some(true));
    }

    #[test]
    fn an_override_is_refused_whole() {
        let tiers = TABLE.tiers_fingerprint.unwrap();
        let base = compiled_fingerprint();
        let refused = |text: String| checked_override(leak(text)).err().expect("refused");
        // A line that is not one: an unknown value, an unknown kind, an empty field, an empty number.
        for body in [
            "gainland\tset\tktk\n",
            "spikey\tname\tCounterspell\n",
            "spikey\toracle\t\tCounterspell\n",
            "covered\trow\tltr\ten\t1  2\n",
        ] {
            let why =
                refused(format!("# base {base}\n# print_tiers.tsv {tiers}\nspikey\toracle\taaaa\tA\n{body}"));
            assert!(why.contains("is_lists.tsv"), "{why}");
        }
        // Composed over another build's table, measured against another tier table, or empty.
        let line = "spikey\toracle\taaaa\tA\n";
        assert!(refused(format!("# base 0000000000000000\n# print_tiers.tsv {tiers}\n{line}")).contains("composed over"));
        assert!(refused(format!("# print_tiers.tsv {tiers}\n{line}")).contains("no `# base` line"));
        assert!(refused(format!("# base {base}\n# print_tiers.tsv 0000000000000000\n{line}")).contains("print_tiers.tsv"));
        assert!(refused(format!("# base {base}\n# print_tiers.tsv {tiers}\n")).contains("no line"));
    }

    #[test]
    fn the_compiled_table_says_when_it_was_measured() {
        let date = compiled_date().expect("the first line ends in the day");
        assert!(date.starts_with("20"), "{date}");
        assert_eq!(compiled_fingerprint().len(), 16);
        assert_eq!(manifest_note()["source"], "compiled");
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
