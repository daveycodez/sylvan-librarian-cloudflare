//! The per-partition half of the card-names blob (backlog n8; format 2 since n15, the corpus-wide
//! names index `/cards/autocomplete`, name-only `/cards/search` and `/cards/named?fuzzy=` answer
//! from ONE object with).
//!
//! WHAT A PARTITION CONTRIBUTES is decided by the engine, not here: `StoreStats::name_records` is
//! read off the structures each partition's archive is serialized from (card_engine's
//! `names_index::name_records_of`), and the engine spells each record as its blob line
//! (`card_engine::name_records_tsv`) — one card per line, led by its partition.
//!
//! Both publishers write exactly this. The native builder appends every partition's lines to
//! [`CARD_NAMES_FILE`] beside the archives, each led by `<partition>\t`; the in-Worker nightly emits
//! them per partition build (engine/wasm-import, `EMIT_NAMES`) without the lead, and its coordinator
//! adds the same `<partition>\t` when it stages them. Each publisher then hands the lines to ONE
//! TypeScript encoder (`src/engine/card-names.ts`, `encodeCardNames`), which dedupes, sorts and
//! frames them — so the two published blobs are byte-identical by construction, and the harness
//! checks it (scripts/import-harness/card-names-check.ts).

/// The native builder's sidecar: every partition's lines, partition after partition.
pub const CARD_NAMES_FILE: &str = "card-names.tsv";

/// Partition `k`'s records as blob lines, each led by `k\t`.
pub fn partition_names_tsv(k: usize, records: &[card_engine::NameRecord]) -> Result<Vec<u8>, String> {
    card_engine::name_records_tsv(&format!("{k}\t"), records)
}

#[cfg(test)]
mod tests {
    use super::partition_names_tsv;
    use card_engine::NameRecord;

    fn record(collated: &str, printed: &str, lower: &str, folded: &str, flavor: &[(&str, u8)]) -> NameRecord {
        NameRecord {
            collated: collated.to_owned(),
            printed: printed.to_owned(),
            lower: lower.to_owned(),
            folded: folded.to_owned(),
            classes: 0x1f,
            best: 0,
            flavor: flavor.iter().map(|(k, b)| ((*k).to_owned(), *b)).collect(),
        }
    }

    #[test]
    fn spells_one_line_per_record_led_by_its_partition() {
        let records = vec![
            record("fireice", "Fire // Ice", "fire // ice", "fire // ice", &[]),
            record("eowynladyofrohan", "Éowyn, Lady of Rohan", "éowyn, lady of rohan", "eowyn, lady of rohan", &[]),
            record("titanothrex", "Titanoth Rex", "titanoth rex", "titanoth rex", &[("godzillaprimevalchampion", 0x10)]),
        ];
        let got = String::from_utf8(partition_names_tsv(3, &records).expect("spellable")).expect("utf-8");
        assert_eq!(
            got,
            "3\t1f0\tfireice\tFire // Ice\t\t\t\n\
             3\t1f0\teowynladyofrohan\tÉowyn, Lady of Rohan\t\teowyn, lady of rohan\t\n\
             3\t1f0\ttitanothrex\tTitanoth Rex\t\t\tgodzillaprimevalchampion:10\n"
        );
        assert_eq!(partition_names_tsv(0, &[]).expect("empty"), Vec::<u8>::new());
    }

    #[test]
    fn refuses_a_name_it_cannot_spell() {
        for bad in ["a\tb", "a\nb", "a\rb"] {
            let err = partition_names_tsv(0, &[record("ab", bad, &bad.to_lowercase(), &bad.to_lowercase(), &[])])
                .expect_err("refused");
            assert!(err.contains("tab or a line break"), "{err}");
        }
        let err = partition_names_tsv(0, &[record("x", "X", "", "", &[])]).expect_err("an empty lower name is refused");
        assert!(err.contains("cannot spell"), "{err}");
    }
}
