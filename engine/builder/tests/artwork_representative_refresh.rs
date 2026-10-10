//! THE NIGHT'S READ OF THE NEWEST ARTWORK REPRESENTATIVES, through the whole native pipeline:
//! Scryfall JSON → transform → finalize → store → query → card objects.
//!
//! `unique=art` answers each artwork with the printing Scryfall keeps for it, and the builder
//! marks that printing from a compiled copy of the record (`art_reps.tsv`). The copy speaks for
//! printings released by the day it was written; a later one falls back to "released the day the
//! artwork debuted", which marks every printing of that day and so answers the first of the
//! card's own order. The nightly import reads the newest end of the same record and installs it
//! with the lists it refreshes (`is_lists::ART_REP_LINE`): for a row released on or after the
//! override's day those rows are the whole answer.
//!
//! Real card objects, api.scryfall.com 2026-10-10. Star Trek (`trk`) is dated 2026-11-13, after
//! the compiled table, and prints each of its ten shock lands twice with one artwork — a showcase
//! printing and its surge foil. Scryfall's record keeps the SURGE FOIL trk/495 for Sacred Foundry
//! and the PLAIN trk/399 for Overgrown Tomb: one set, one day, the same two treatments, and no
//! field of the four card objects says which.
//!
//! ONE TEST, IN ITS OWN BINARY: the override is process-wide, and every other test of the builder
//! reads the compiled table on parallel threads.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};
use sylvan_store_builder::{art_reps, is_lists};

const FIXTURES: &[&str] = &[
    "sacred_foundry_trk_400",
    "sacred_foundry_trk_495",
    "overgrown_tomb_trk_399",
    "overgrown_tomb_trk_494",
    // Released before any day the night reads back to: the compiled record's, whatever the night says.
    "cryptex_mkm_251",
    "cryptex_mkm_422",
    "cryptex_pmkm_251s",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store of the fixtures, built under whatever table is installed NOW.
fn store() -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-art-reps-refresh-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn name(w: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_name", "original_attribute": "name"}},
            "op": ":",
            "rhs": {"node_type": "CollatedNameValueNode", "kwargs": {"value": w}},
        },
    })
}

/// The printing `unique=art` answers the one artwork of the card named `w` with.
fn art(store: &BufferStore, w: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: "artwork".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(&name(w), &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| format!("{}/{}", c["set"].as_str().unwrap(), c["collector_number"].as_str().unwrap()))
        .collect()
}

fn head() -> String {
    let tiers = is_lists::compiled_tsv()
        .lines()
        .find_map(|l| l.strip_prefix("# print_tiers.tsv "))
        .expect("the compiled table records its tier table");
    format!("# base {}\n# print_tiers.tsv {tiers}\n", is_lists::compiled_fingerprint())
}

#[test]
fn a_printing_released_since_the_day_is_the_representative_the_nights_read_lists() {
    // The fixtures are what the test says they are: Star Trek is dated after the compiled table.
    let released = |n: &str| fixture(n)["released_at"].as_str().unwrap().to_owned();
    assert!(released("sacred_foundry_trk_495").as_str() > art_reps::written());
    assert!(released("cryptex_mkm_422").as_str() < "2026-01-01");

    // THE COMPILED TABLE ALONE says nothing of a printing released after it was written, the
    // debut rule marks both printings of each land, and the answer is the first of the card's own
    // order — the plain printing of both. Right for Overgrown Tomb, wrong for Sacred Foundry.
    let compiled = store();
    assert_eq!(art(&compiled, "sacred"), ["trk/400"]);
    assert_eq!(art(&compiled, "overgrown"), ["trk/399"]);
    assert_eq!(art(&compiled, "cryptex"), ["mkm/422"]);

    // THE NIGHT'S READ, back to 2026-09-10: Scryfall's own rows for the two artworks.
    let read = format!("{}# art-reps-from 2026-09-10\nart_rep\trow\ttrk\ten\t399 495\n", head());
    assert_eq!(is_lists::set_override(read), Ok(1));
    let refreshed = store();
    assert_eq!(art(&refreshed, "sacred"), ["trk/495"]);
    assert_eq!(art(&refreshed, "overgrown"), ["trk/399"]);
    // A printing released before the day is the compiled record's: the night's rows do not name
    // mkm/422, and it represents Cryptex all the same.
    assert_eq!(art(&refreshed, "cryptex"), ["mkm/422"]);

    // The rows are the whole answer from the day on: an artwork none of whose printings is listed
    // has no representative, and answers the first of its card's order.
    let other = format!("{}# art-reps-from 2026-09-10\nart_rep\trow\ttrk\ten\t494\n", head());
    assert_eq!(is_lists::set_override(other), Ok(1));
    let moved = store();
    assert_eq!(art(&moved, "overgrown"), ["trk/494"]);
    assert_eq!(art(&moved, "sacred"), ["trk/400"]);

    // A day far enough back takes the older printings from the compiled record too: with Cryptex
    // inside the window and unlisted, the card's order answers mkm/251.
    let wide = format!("{}# art-reps-from 2024-01-01\nart_rep\trow\ttrk\ten\t399 495\n", head());
    assert_eq!(is_lists::set_override(wide), Ok(1));
    assert_eq!(art(&store(), "cryptex"), ["mkm/251"]);

    // Refused whole — rows without a day — and the table in force stands.
    assert!(is_lists::set_override(format!("{}art_rep\trow\ttrk\ten\t494\n", head())).is_err());
    assert_eq!(art(&store(), "cryptex"), ["mkm/251"]);

    is_lists::clear_override();
    let back = store();
    assert_eq!(art(&back, "sacred"), ["trk/400"]);
    assert_eq!(art(&back, "cryptex"), ["mkm/422"]);
}
