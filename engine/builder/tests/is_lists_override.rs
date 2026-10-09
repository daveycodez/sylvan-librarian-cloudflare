//! The override of the compiled `is:` lists (`is_lists::set_override`), through transform and
//! finalize — what the nightly import installs before its first row (src/import-is-lists.ts) and
//! what `sylvan-store-builder --is-lists` installs for a deploy.
//!
//! ONE TEST, IN ITS OWN BINARY: the override is process-wide, and every other test of the builder
//! reads the compiled table on parallel threads.

use serde_json::Value;
use sylvan_store_builder::is_lists;
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The finished rows' list tags, as `set/number/lang: tag tag …` in the order given.
fn tags_of(cards: &[&str]) -> Vec<String> {
    let drafts = cards.iter().map(|name| transform_row(&fixture(name), true).unwrap().unwrap()).collect();
    let mut out: Vec<String> = finalize(drafts, &TagData::default())
        .map(|row| {
            // The finished row's own shape for the column: `{"tag": true, …}`.
            let mut tags: Vec<&str> = row["card_is_tags"]
                .as_object()
                .expect("card_is_tags is an object")
                .keys()
                .map(String::as_str)
                .filter(|t| is_lists::LIST_TAGS.contains(t))
                .collect();
            tags.sort_unstable();
            format!("{}/{}: {}", row["card_set_code"].as_str().unwrap(), row["collector_number"].as_str().unwrap(), tags.join(" "))
        })
        .collect();
    out.sort();
    out
}

fn tiers_fingerprint() -> String {
    is_lists::compiled_tsv()
        .lines()
        .find_map(|l| l.strip_prefix("# print_tiers.tsv "))
        .expect("the compiled table records its tier table")
        .to_owned()
}

#[test]
fn an_installed_override_supersedes_the_compiled_table_and_a_refused_one_changes_nothing() {
    let cards = ["blessed_sanctuary_jmp_1", "bishops_soldier_fdn_491", "counterspell_dsc_114", "counterspell_sld_175"];
    // The compiled table: all of `jmp` is jumpstart, fdn/491 is in nothing, Counterspell is
    // spikey, and its Secret Lair printing is covered by the tier rule.
    let compiled = tags_of(&cards);
    assert_eq!(compiled, ["dsc/114: spikey", "fdn/491: ", "jmp/1: jumpstart", "sld/175: covered spikey"]);
    assert_eq!(is_lists::manifest_note()["source"], "compiled");

    let head = format!(
        "# base {}\n# print_tiers.tsv {}\n# meta {{\"base\":\"2026-10-09\",\"checked\":\"2026-10-10\",\"source\":\"nightly\"}}\n",
        is_lists::compiled_fingerprint(),
        tiers_fingerprint()
    );
    let counterspell = fixture("counterspell_dsc_114")["oracle_id"].as_str().unwrap().to_owned();
    // A whole table of its own: fdn/491 joins `intro` and `related`, dsc/114 is covered and
    // sld/175 is not (each against the rule), Counterspell is in `spellbook` — and neither
    // `jumpstart` nor `spikey` has a line, so nothing is in either.
    let table = format!(
        "{head}intro\tprint\tfdn\t491\nrelated\tprint\tfdn\t491\ncovered\trow\tdsc\ten\t114\n\
         covered\tnot-row\tsld\ten\t175\nspellbook\toracle\t{counterspell}\tCounterspell\n"
    );
    assert_eq!(is_lists::set_override(table), Ok(5));
    let overridden = ["dsc/114: covered spellbook", "fdn/491: intro related", "jmp/1: ", "sld/175: spellbook"];
    assert_eq!(tags_of(&cards), overridden);
    assert_eq!(is_lists::manifest_note()["checked"], "2026-10-10");

    // Refused: a line that is not one, and a table composed over another build's.
    assert!(is_lists::set_override(format!("{head}intro\tprint\tfdn\t491\ngainland\tset\tktk\n")).is_err());
    assert!(is_lists::set_override("# base 0000000000000000\nintro\tprint\tfdn\t491\n".to_owned()).is_err());
    assert_eq!(tags_of(&cards), overridden, "a refused override leaves the table in force");

    is_lists::clear_override();
    assert_eq!(tags_of(&cards), compiled);
}
