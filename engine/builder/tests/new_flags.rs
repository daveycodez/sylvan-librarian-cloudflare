//! Scryfall's `new:` values through the whole native pipeline: Scryfall JSON → transform →
//! finalize → store → query. Real card objects (the fixtures are card objects verbatim), asked the
//! tree the parser emits for `is:new<value>`, the spelling the compat surface writes each term as.
//!
//! The rule is one shape for every value — per card and group, over the canonical rows that are
//! eligible, the first by (release date, release batch, the collector number's digits as one
//! integer, variation last, Scryfall id), flagged unless it is a variation — and was measured on
//! api.scryfall.com 2026-10-09 by reading each whole list; card_engine's `assign_new_flags`
//! carries the evidence for each clause. What is pinned here is that rule on the rows the
//! fixtures hold: each pair one clause, and each winner the printing Scryfall's own list holds.
//! `new:rarity` is older and has its own file, x72_new_rarity.rs.

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
    let out_dir = std::env::temp_dir().join(format!("sylvan-new-flags-{}-{build}", std::process::id()));
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
fn new_card_is_the_first_paper_printing_outside_memorabilia_in_the_measured_order() {
    let store = store_of(&[
        // PAPER: Rusko, Clockmaker was an Arena card for two years before Mystery Booster 2
        // printed it — `ybro/24` is its first printing and `mb2/263` its `new:card`.
        ("rusko_clockmaker_ybro_24", true),
        ("rusko_clockmaker_mb2_263", true),
        // MEMORABILIA is outside: Mirror Mirror's 1998 oversized `olep/48` precedes Unglued.
        ("mirror_mirror_olep_48", true),
        ("mirror_mirror_ugl_77", true),
        // THE RELEASE BATCH before the number and the id: `4bb` is 1995-04-01's later batch, so
        // `4ed/49` leads though `4bb/49`'s id is lower.
        ("seeker_4ed_49", true),
        ("seeker_4bb_49_es", true),
        // THE SET CODE IS NOT A KEY: Revised and Foreign Black Border share a date and a batch,
        // and the id decides — `fbb/248` for Flying Carpet.
        ("flying_carpet_3ed_248", true),
        ("flying_carpet_fbb_248_fr", true),
        // A VARIATION sorts after its plain twin: `ons/200★` carries the lower id.
        ("embermage_goblin_ons_200", true),
        ("embermage_goblin_ons_200_star", true),
        // THE ANNEX never answers: the Russian `rav/186` carries the lower id.
        ("transluminant_rav_186", true),
        ("transluminant_rav_186_ru", false),
        // THE ONE MEASURED LEAD (`NEW_ORDER_LEADS`): of Orb of Dragonkind's three Japanese
        // promos Scryfall answers J2, where the number and the id both say J1.
        ("orb_of_dragonkind_plg21_j1_ja", true),
        ("orb_of_dragonkind_plg21_j2_ja", true),
        ("orb_of_dragonkind_plg21_j3_ja", true),
    ]);
    assert_eq!(
        rows(&store, &is("newcard")),
        ["4ed/49/en", "fbb/248/fr", "mb2/263/en", "ons/200/en", "plg21/J2/ja", "rav/186/en", "ugl/77/en"]
    );
    // Two-valued: the negation is every other row of every language.
    assert_eq!(
        rows(&store, &not(is("newcard"))),
        [
            "3ed/248/en",
            "4bb/49/es",
            "olep/48/en",
            "ons/200★/en",
            "plg21/J1/ja",
            "plg21/J3/ja",
            "rav/186/ru",
            "ybro/24/en",
        ]
    );
}
