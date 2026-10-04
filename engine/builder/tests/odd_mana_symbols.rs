//! The mana symbols only the un-sets print, and the ones no card prints at all — through the whole
//! native pipeline: Scryfall JSON → transform → finalize → store → query, with the tree the parser
//! emits for `mana:` (a `ManaValueNode` holding the value upper-cased).
//!
//! Measured on api.scryfall.com 2026-10-04, one request per row:
//!
//!   mana:{hw} = mana={hw} = mana>={hw}     1, Little Girl ({HW})      -mana:{hw}  33,648
//!   mana:{h}  mana:{hr}  mana:{l}  mana:l  mana:{l}{l}  mana:{c/p}  mana:{c/p}{c/p}  mana:{hw}{hw}
//!                                          404, no warning — honored, and no cost holds them
//!
//! and `{y}` / `{z}` are The Ultimate Nightmare of Wizards of the Coast® Customer Service's
//! ({X}{Y}{Z}{R}{R}). Both parsers refused every one of these symbols — upstream drops the un-sets
//! at import, so no cost there could hold them — which made each a `Failed to parse query` here.
//! The engine needed nothing: a symbol that is not one of its eight lanes is compared by NAME
//! against the store's own mana vocabulary, so `{HW}` finds the cost that prints it and `{L}`,
//! which no cost prints, finds nothing.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &["little_girl_unh_16", "ultimate_nightmare_ugl_53", "fireball_clb_175", "lightning_bolt"];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-odd-mana-symbols-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `mana<op><value>` — the tree the parser emits.
fn mana(op: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "mana_cost_jsonb", "original_attribute": "mana"}},
            "op": op,
            "rhs": {"node_type": "ManaValueNode", "kwargs": {"value": value}},
        },
    })
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// The names the tree matches, sorted.
fn names(store: &BufferStore, tree: &Value) -> Vec<String> {
    let opts = QueryOptions {
        unique: "card".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "name"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> =
        serde_json::from_str::<Vec<Value>>(body).unwrap().iter().map(|c| c["name"].as_str().unwrap().to_owned()).collect();
    out.sort();
    out
}

const NIGHTMARE: &str = "The Ultimate Nightmare of Wizards of the Coast® Customer Service";
const NONE: [&str; 0] = [];

#[test]
fn half_white_is_the_cost_that_prints_it() {
    let store = store();
    assert_eq!(names(&store, &mana(":", "{HW}")), ["Little Girl"]);
    assert_eq!(names(&store, &mana("=", "{HW}")), ["Little Girl"]);
    assert_eq!(names(&store, &mana(">=", "{HW}")), ["Little Girl"]);
    assert_eq!(names(&store, &not(mana(":", "{HW}"))), ["Fireball", "Lightning Bolt", NIGHTMARE]);
    // Two of them are a cost nothing prints.
    assert_eq!(names(&store, &mana(":", "{HW}{HW}")), NONE);
}

#[test]
fn y_and_z_are_the_cost_that_prints_them() {
    let store = store();
    assert_eq!(names(&store, &mana(":", "{Y}")), [NIGHTMARE]);
    assert_eq!(names(&store, &mana(":", "{Z}")), [NIGHTMARE]);
    assert_eq!(names(&store, &mana(":", "{X}{Y}{Z}")), [NIGHTMARE]);
    assert_eq!(names(&store, &mana("=", "{X}{Y}{Z}{R}{R}")), [NIGHTMARE]);
    // `{X}` alone is still Fireball's too.
    assert_eq!(names(&store, &mana(":", "{X}")), ["Fireball", NIGHTMARE]);
}

#[test]
fn a_symbol_no_cost_prints_matches_nothing_and_its_negation_everything() {
    let store = store();
    for symbol in ["{H}", "{HR}", "{L}", "{L}{L}", "{C/P}", "{C/P}{C/P}"] {
        assert_eq!(names(&store, &mana(":", symbol)), NONE, "mana:{symbol}");
        assert_eq!(names(&store, &mana("=", symbol)), NONE, "mana={symbol}");
        assert_eq!(names(&store, &not(mana(":", symbol))).len(), 4, "-mana:{symbol}");
    }
}
