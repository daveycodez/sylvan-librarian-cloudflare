//! The `is:` classes that are Scryfall's own record (generation 74), through the whole native
//! pipeline: Scryfall JSON → transform → finalize → store → query. Real card objects (the
//! fixtures are card objects verbatim), each value asked the tree the parser emits for it.
//!
//! Every expectation is api.scryfall.com's answer on 2026-10-09. The lists themselves are
//! `src/is_lists.tsv` (`bun run is-lists`); what each value is, and the rules tried for it, are
//! at the constants in `transform.rs`. The corpus-wide check — the builder run over the whole
//! bulk file tags exactly Scryfall's rows — is `examples/is_lists_audit.rs`; these pin one card
//! per key shape so a change to the lookup cannot pass unnoticed.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{Value, json};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store of exactly these card objects, each with whether its row is the CANONICAL one of its
/// printing (the row Scryfall's `default_cards` holds) or an annex row. One directory per CALL:
/// the tests run on parallel threads.
fn store_of(cards: &[(&str, bool)]) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = cards.iter().map(|(name, canonical)| transform_row(&fixture(name), *canonical).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-x74-is-lists-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `is:<value>`, the tree the parser emits.
fn is(value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_is_tags", "original_attribute": "is"}},
            "op": ":",
            "rhs": [value],
        },
    })
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// Every PRINTING the tree matches as sorted `set/number/lang` addresses — every language when
/// `every_language`, otherwise what a search with no `lang:` and no `include_multilingual` sees.
fn rows(store: &BufferStore, tree: &Value, every_language: bool) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        include_multilingual: every_language,
        fields: Some(["scryfall_id", "set_code", "collector_number", "lang"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> = serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| {
            format!(
                "{}/{}/{}",
                c["set"].as_str().unwrap(),
                c["collector_number"].as_str().unwrap(),
                c["lang"].as_str().unwrap()
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
fn covered_is_every_printing_outside_the_default_tier() {
    // `-is:covered` is the first run of a card's own order. Counterspell: dsc/114 is in it and
    // the Secret Lair sld/175 is not; dsc/114 in Japanese is not either — a default printing's
    // other languages come back in the second run — and that is the RULE (`ranks::print_tier`).
    //
    // The table is where Scryfall's record departs from it, each way: ltr/262, a plain English
    // Plains the rule calls default, is covered; ymid/7, an Arena-only printing the rule calls
    // covered, is the only printing of Faithful Disciple and is not; and The Lord of the Rings'
    // French ltr/1 is default-tier beside its English row, where every other set's French is not.
    let store = store_of(&[
        ("counterspell_dsc_114", true),
        ("counterspell_dsc_114_ja", false),
        ("counterspell_sld_175", true),
        ("banish_from_edoras_ltr_1", true),
        ("banish_from_edoras_ltr_1_fr", false),
        ("plains_ltr_262", true),
        ("faithful_disciple_ymid_7", true),
    ]);
    assert_eq!(rows(&store, &is("covered"), false), ["ltr/262/en", "sld/175/en"]);
    assert_eq!(rows(&store, &not(is("covered")), false), ["dsc/114/en", "ltr/1/en", "ymid/7/en"]);
    assert_eq!(rows(&store, &is("covered"), true), ["dsc/114/ja", "ltr/262/en", "sld/175/en"]);
    assert_eq!(rows(&store, &not(is("covered")), true), ["dsc/114/en", "ltr/1/en", "ltr/1/fr", "ymid/7/en"]);
}

#[test]
fn jumpstart_is_four_sets_and_the_booster_cards_of_six_more() {
    // 1,760 printings: all of jmp, j21, j25 and ajmp — but for j21/25, an Arena printing of
    // Static Discharge that is not in it — and mom/323-337 with their like. Jumpstart 2022 is
    // not in it at all.
    let store = store_of(&[
        ("blessed_sanctuary_jmp_1", true),
        ("essence_of_orthodoxy_mom_323", true),
        ("agrus_kos_eternal_soldier_j22_1", true),
        ("static_discharge_j21_25", true),
    ]);
    assert_eq!(rows(&store, &is("jumpstart"), false), ["jmp/1/en", "mom/323/en"]);
    assert_eq!(rows(&store, &not(is("jumpstart")), false), ["j21/25/en", "j22/1/en"]);
}

#[test]
fn intro_is_a_list_of_numbers_and_not_the_beginner_box() {
    // 224 printings. fdn/490 and fdn/491 both carry the `beginnerbox` promo type and nothing
    // else that differs; Scryfall's `is:intro` (and `is:beginner`) holds the first.
    let store = store_of(&[("angelic_edict_fdn_490", true), ("bishops_soldier_fdn_491", true)]);
    assert_eq!(rows(&store, &is("intro"), false), ["fdn/490/en"]);
}

#[test]
fn invitational_and_misprint_are_lists_of_rows() {
    // Avalanche Riders ulg/74 is `is:invitational` in English and five other languages and not
    // in French; `is:misprint` is the SPANISH 4bb/50 Serra Angel and not the Japanese one.
    let store = store_of(&[
        ("avalanche_riders_ulg_74", true),
        ("avalanche_riders_ulg_74_fr", false),
        ("serra_angel_4bb_50_es", true),
        ("serra_angel_4bb_50_ja", false),
    ]);
    assert_eq!(rows(&store, &is("invitational"), true), ["ulg/74/en"]);
    assert_eq!(rows(&store, &is("misprint"), true), ["4bb/50/es"]);
    assert_eq!(rows(&store, &not(is("misprint")), true), ["4bb/50/ja", "ulg/74/en", "ulg/74/fr"]);
}

#[test]
fn spellbook_and_spikey_are_lists_of_cards() {
    // `is:spellbook`: Faithful Disciple drafts from a spellbook. `is:spikey`: Counterspell and
    // Divide by Zero are banned or restricted nowhere today and are in it, in every language;
    // Rhystic Study is banned in Pauper Commander and is not.
    let store = store_of(&[
        ("faithful_disciple_ymid_7", true),
        ("counterspell_dsc_114", true),
        ("counterspell_dsc_114_ja", false),
        ("divide_by_zero_stx_41", true),
        ("rhystic_study_pcy_45", true),
    ]);
    assert_eq!(rows(&store, &is("spellbook"), true), ["ymid/7/en"]);
    assert_eq!(rows(&store, &is("spikey"), true), ["dsc/114/en", "dsc/114/ja", "stx/41/en"]);
    assert_eq!(rows(&store, &not(is("spikey")), false), ["pcy/45/en", "ymid/7/en"]);
}

#[test]
fn related_is_the_card_and_not_the_row() {
    // Valorous Steed's English m21/42 lists its Knight token in `all_parts`; its Portuguese row
    // lists nothing and is `is:related` all the same, for its card. Divide by Zero carries no
    // `all_parts` on any printing and is in Scryfall's list. Akoum Refuge is neither.
    let store = store_of(&[
        ("valorous_steed_m21_42", true),
        ("valorous_steed_m21_42_pt", false),
        ("divide_by_zero_stx_41", true),
        ("akoum_refuge_c13_272", true),
    ]);
    assert_eq!(rows(&store, &is("related"), true), ["m21/42/en", "m21/42/pt", "stx/41/en"]);
    assert_eq!(rows(&store, &not(is("related")), true), ["c13/272/en"]);
}

#[test]
fn gateway_and_lair_are_classes_with_no_member() {
    // A 404 on api.scryfall.com, and the negation every printing.
    let store = store_of(&[("counterspell_dsc_114", true), ("akoum_refuge_c13_272", true)]);
    for value in ["gateway", "lair"] {
        assert_eq!(rows(&store, &is(value), true), Vec::<String>::new());
        assert_eq!(rows(&store, &not(is(value)), true), ["c13/272/en", "dsc/114/en"]);
    }
}
