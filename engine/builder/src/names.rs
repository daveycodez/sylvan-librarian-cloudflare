//! The per-partition half of the card-names blob `/cards/autocomplete` answers from (backlog n8).
//!
//! WHAT A PARTITION CONTRIBUTES is decided by the engine, not here: `StoreStats::autocomplete_names`
//! is read off the structures each partition's archive is serialized from (card_engine's
//! `autocomplete_names_of`), so which name a card carries and whether any of its printings is served
//! are the engine's own answers. This module only spells them for the host: one
//! `<collated>\t<printed>\n` line per pair, in the order the engine sorted them.
//!
//! Both publishers write exactly this. The native builder appends every partition's lines to
//! [`CARD_NAMES_FILE`] beside the archives; the in-Worker nightly emits them per partition build
//! (engine/wasm-import, `EMIT_NAMES`) and stages them. Each publisher then hands the lines to ONE
//! TypeScript encoder (`src/engine/card-names.ts`, `encodeCardNames`), which dedupes, sorts and
//! frames them — so the two published blobs are byte-identical by construction, and the harness
//! checks it (scripts/import-harness/card-names-check.ts).

/// The native builder's sidecar: every partition's lines, partition after partition.
pub const CARD_NAMES_FILE: &str = "card-names.tsv";

/// One partition's pairs as `<collated>\t<printed>\n` lines.
///
/// A tab or a line break in either string would make the line ambiguous, and no card name carries
/// one — so one that does is refused rather than escaped: the build fails loudly on the day the data
/// changes, instead of publishing a blob whose reader splits a name in two.
pub fn partition_names_tsv(names: &[(String, String)]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(names.iter().map(|(c, p)| c.len() + p.len() + 2).sum());
    for (collated, printed) in names {
        for s in [collated, printed] {
            if s.contains(['\t', '\n', '\r']) {
                return Err(format!("card name {s:?} carries a tab or a line break; the names blob cannot spell it"));
            }
        }
        out.extend_from_slice(collated.as_bytes());
        out.push(b'\t');
        out.extend_from_slice(printed.as_bytes());
        out.push(b'\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::partition_names_tsv;

    #[test]
    fn spells_one_line_per_pair_in_the_given_order() {
        let names = vec![
            ("fireice".to_owned(), "Fire // Ice".to_owned()),
            ("eowynladyofrohan".to_owned(), "Éowyn, Lady of Rohan".to_owned()),
        ];
        let got = String::from_utf8(partition_names_tsv(&names).expect("spellable")).expect("utf-8");
        assert_eq!(got, "fireice\tFire // Ice\neowynladyofrohan\tÉowyn, Lady of Rohan\n");
        assert_eq!(partition_names_tsv(&[]).expect("empty"), Vec::<u8>::new());
    }

    #[test]
    fn refuses_a_name_it_cannot_spell() {
        for bad in ["a\tb", "a\nb", "a\rb"] {
            let err = partition_names_tsv(&[("ab".to_owned(), bad.to_owned())]).expect_err("refused");
            assert!(err.contains("tab or a line break"), "{err}");
        }
    }
}
