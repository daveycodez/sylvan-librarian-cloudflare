//! A card's printings come back in api.scryfall.com's ORDER, ties included — through the whole
//! native pipeline: Scryfall JSON → transform → finalize (the representative ranks) → store →
//! query → card objects. Real JSON: Flashback's three printings of 2026-04-24 — psos/115p, sos/115
//! and sos/333, from api.scryfall.com on 2026-09-25 — and Doubling Cube's four from the 2026-08-16
//! bulk that face_oracle_ids.rs already carries: 10e/321, 5dn/116, The List's plst/10E-321 and the
//! reversible sld/1080.
//!
//! This is the search mtgseeker's Prints strip sends — `oracleid:<id>&unique=prints`, under
//! `order=released` (its default `dir`, descending) — and the answers asserted are Scryfall's own,
//! read off `/cards/search` the same day:
//!
//! - Flashback, `order=released`: psos/115p, sos/333, sos/115. All three share a release date, so
//!   the whole order is the tie-break: the prerelease-promo set `psos` sits in a later BATCH of
//!   that date than `sos` (card_engine's release_batches.tsv), where the code order this port used
//!   put `psos` last. Collector numbers descend inside the set, with the date.
//! - Doubling Cube, `order=name`: 10e/321, 5dn/116, plst/10E-321, then sld/1080 under its own
//!   printed name. The three `Doubling Cube` printings tie on the name, so their order is the
//!   representative ranking's — which read `10E-321` as a bare number and put the 2021 List
//!   reprint ahead of the 2004 printing it outdates (`cn_has_set_prefix`).

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FLASHBACK: &str = "02070488-9203-4304-9392-a111d20218c5";
const DOUBLING_CUBE: &str = "9afd8f12-0796-4500-aaa3-10b4a46ef6ec";

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    let cards = [
        "flashback_sos_115",
        "flashback_sos_333",
        "flashback_psos_115p",
        "doubling_cube_10e_321",
        "doubling_cube_5dn_116",
        "doubling_cube_plst_10e_321",
        "doubling_cube_sld_1080",
    ];
    let drafts = cards.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-print-order-ties-{}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn oracle_id_leaf(oracle_id: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "oracle_id", "original_attribute": "oracleid"}},
            "op": ":",
            "rhs": {"node_type": "StringValueNode", "kwargs": {"value": oracle_id}},
        },
    })
}

/// The printings a card's `oracleid:` search pages, in page order, as `set/number` addresses.
fn prints(store: &BufferStore, oracle_id: &str, orderby: &str, direction: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: orderby.to_owned(),
        direction: direction.to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(&oracle_id_leaf(oracle_id), &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| format!("{}/{}", c["set"].as_str().unwrap(), c["collector_number"].as_str().unwrap()))
        .collect()
}

#[test]
fn a_same_day_tie_orders_its_sets_and_numbers_as_scryfall_does() {
    let store = store();
    assert_eq!(prints(&store, FLASHBACK, "released", "desc"), ["psos/115p", "sos/333", "sos/115"]);
    // `dir=asc` is the exact reversal on api.scryfall.com, the set order with it.
    assert_eq!(prints(&store, FLASHBACK, "released", "asc"), ["sos/115", "sos/333", "psos/115p"]);
    // No same-day tie on Doubling Cube, and none moved: the dates alone decide.
    assert_eq!(
        prints(&store, DOUBLING_CUBE, "released", "desc"),
        ["sld/1080", "plst/10E-321", "10e/321", "5dn/116"]
    );
}

#[test]
fn a_name_tie_orders_a_digit_led_list_number_after_the_printing_it_reprints() {
    let store = store();
    assert_eq!(
        prints(&store, DOUBLING_CUBE, "name", "asc"),
        ["10e/321", "5dn/116", "plst/10E-321", "sld/1080"]
    );
}
