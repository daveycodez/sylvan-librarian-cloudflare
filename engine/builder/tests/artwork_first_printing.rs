//! `unique=art` ANSWERS AN ARTWORK'S FIRST PRINTING — through the whole native pipeline: Scryfall
//! JSON → transform → finalize → store → query → card objects.
//!
//! Real card objects, api.scryfall.com 2026-10-08, and the answers are Scryfall's own for exactly
//! these printings (`unique=art&include_extras=true`):
//!
//! - `!"Angel of the Dawn"` — one artwork, printed in m19 (2018), 2xm and cmr (2020): m19/7. The
//!   card's own order leads with the newest, cmr/6, and that is what this port answered.
//! - `!"Ajani, the Greathearted" (e:war or e:pwar) -cn:184p` — two artworks, war/184 and war/184★.
//!   The second is the Japanese alternate art, printed the same day in the set (war/184★) and as a
//!   prerelease promo (pwar/184s★): one date, and the set's printing answers, not the promo that
//!   the card's own order puts first (`pwar` is the later release batch of 2019-05-03).
//!
//! `unique=cards` and `unique=prints` on the same printings are unmoved and asserted beside it.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "angel_of_the_dawn_cmr_6",
    "angel_of_the_dawn_2xm_4",
    "angel_of_the_dawn_m19_7",
    "ajani_the_greathearted_war_184",
    "ajani_the_greathearted_pwar_184s",
    "ajani_the_greathearted_pwar_184sstar_ja",
    "ajani_the_greathearted_war_184star_ja",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store(reversed: bool) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let mut cards: Vec<Value> = FIXTURES.iter().map(|n| fixture(n)).collect();
    if reversed {
        cards.reverse();
    }
    // Every one of these is a default_cards row: the two Japanese printings have no English twin.
    let drafts = cards.iter().map(|c| transform_row(c, true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-artwork-first-printing-{}-{build}", std::process::id()));
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

/// The rows the tree matches under `unique` and `prefer`, as `set/number`, in page order.
fn rows(store: &BufferStore, tree: &Value, unique: &str, prefer: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: unique.to_owned(),
        prefer: prefer.to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| format!("{}/{}", c["set"].as_str().unwrap(), c["collector_number"].as_str().unwrap()))
        .collect()
}

#[test]
fn an_artwork_is_represented_by_its_oldest_printing() {
    for reversed in [false, true] {
        let store = store(reversed);
        let angel = name("angel");
        assert_eq!(rows(&store, &angel, "artwork", "default"), ["m19/7"]);
        // The card's own order, and so its representative, still lead with the newest.
        assert_eq!(rows(&store, &angel, "printing", "default"), ["cmr/6", "2xm/4", "m19/7"]);
        assert_eq!(rows(&store, &angel, "card", "default"), ["cmr/6"]);
        // A prefer that is written still decides: `prefer:newest` is the newest of the artwork.
        assert_eq!(rows(&store, &angel, "artwork", "newest"), ["cmr/6"]);
    }
}

#[test]
fn on_one_date_the_set_printing_represents_the_artwork_not_its_promo() {
    for reversed in [false, true] {
        let store = store(reversed);
        let ajani = name("ajani");
        assert_eq!(rows(&store, &ajani, "artwork", "default"), ["war/184", "war/184★"]);
        // The card's own order puts the prerelease promo of the Japanese art first.
        assert_eq!(rows(&store, &ajani, "printing", "default"), ["war/184", "pwar/184s", "pwar/184s★", "war/184★"]);
    }
}
