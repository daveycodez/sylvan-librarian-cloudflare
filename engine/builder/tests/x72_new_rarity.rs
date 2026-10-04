//! Scryfall's `new:rarity` through the whole native pipeline: Scryfall JSON → transform →
//! finalize → store → query. Real card objects (the fixtures are card objects verbatim), asked
//! the tree the parser emits for `is:newrarity`, the spelling the compat surface writes the term
//! as.
//!
//! The rule — the first canonical printing of a card at each rarity, outside promo, memorabilia,
//! from_the_vault, treasure_chest and every masterpiece set but `wot`, in the order (release date,
//! release batch, first integer of the collector number, variation last, Scryfall id) — was
//! measured on api.scryfall.com 2026-10-04 against the whole list, 38,943 of 38,943 printings;
//! card_engine's `assign_new_rarity_flags` carries the evidence for each clause. What is pinned
//! here is that rule, on the rows the fixtures hold — each pair one clause, and each winner the
//! printing Scryfall's own list holds.

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
    let out_dir = std::env::temp_dir().join(format!("sylvan-x72-new-rarity-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `is:newrarity`, the tree the parser emits.
fn new_rarity() -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_is_tags", "original_attribute": "is"}},
            "op": ":",
            "rhs": ["newrarity"],
        },
    })
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// Every PRINTING the tree matches, EVERY LANGUAGE, as sorted `set/number/lang` addresses.
fn rows(store: &BufferStore, tree: &Value) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        include_multilingual: true,
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
fn new_rarity_is_the_first_canonical_printing_at_each_rarity_in_the_measured_order() {
    let store = store_of(&[
        // THE RELEASE BATCH before the collector number and the id: Fourth Edition and its
        // Spanish/Italian/… Foreign Black Border printing share 1995-04-01, and 4bb is the date's
        // later batch (release_batches.tsv) — so `4ed/49` is new though `4bb/49`'s id is lower.
        ("seeker_4ed_49", true),
        ("seeker_4bb_49_es", true),
        // THE SET CODE IS NOT A KEY: Revised and its French/German/Italian printing share a date
        // and a batch, and the id decides — `3ed/270` for Ornithopter, `fbb/248` for Flying Carpet.
        ("ornithopter_3ed_270", true),
        ("ornithopter_fbb_270_fr", true),
        ("flying_carpet_3ed_248", true),
        ("flying_carpet_fbb_248_fr", true),
        // A VARIATION sorts after its plain twin: `ons/200★` (variation, the lower id) is not new.
        ("embermage_goblin_ons_200", true),
        ("embermage_goblin_ons_200_star", true),
        // THE ANNEX never answers: the Russian `rav/186` carries the lower id and is not new.
        ("transluminant_rav_186", true),
        ("transluminant_rav_186_ru", false),
        // A PROMO SET is outside: Pentavite's 2004 p04/3 is not new, its 2011 token tm12/7 is.
        ("pentavite_tm12_7", true),
        ("pentavite_p04_3", true),
        // MASTERPIECE sets are outside but for `wot`: Kor Haven's Expedition exp/41 is its only
        // mythic printing and is not new (`new:rarity e:exp` is 0); Hatching Plans' wot/20 is.
        ("kor_haven_exp_41", true),
        ("kor_haven_nem_141", true),
        ("hatching_plans_wot_20", true),
        // RARITY by rarity, and a SERIALIZED printing counts: Merfolk of the Pearl Trident is new
        // at common in Alpha and at rare in Secret Lair's serialized sld/714.
        ("merfolk_pearl_trident_lea_66", true),
        ("merfolk_pearl_trident_sld_714", true),
    ]);
    assert_eq!(
        rows(&store, &new_rarity()),
        [
            "3ed/270/en",
            "4ed/49/en",
            "fbb/248/fr",
            "lea/66/en",
            "nem/141/en",
            "ons/200/en",
            "rav/186/en",
            "sld/714/en",
            "tm12/7/en",
            "wot/20/en",
        ]
    );
    // Two-valued: `-new:rarity` is the plain complement (79,435 + 38,943 = every canonical row).
    assert_eq!(
        rows(&store, &not(new_rarity())),
        [
            "3ed/248/en",
            "4bb/49/es",
            "exp/41/en",
            "fbb/270/fr",
            "ons/200★/en",
            "p04/3/en",
            "rav/186/ru",
        ]
    );
}
