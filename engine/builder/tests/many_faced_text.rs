//! A card with more than two faces has no searchable rules text — through the whole native
//! pipeline: Scryfall JSON → transform → finalize → store → query.
//!
//! Who // What // When // Where // Why is five instants on one card. api.scryfall.com answers
//! `o:` and `fo:` for it as if it had no text at all, while its name and types search normally;
//! this engine searched all five faces, and the card was the one Sylvan-only answer in
//! mtg-seeker's 2026-10-04 reports R09, R11, R13, R14, R15, R22 and R24. Every assertion is a
//! probe measured there that day. Fire // Ice is the two-faced control.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &["who_what_when_where_why_und_75", "fire_ice"];
const FIVE: &str = "Who // What // When // Where // Why";

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    // One directory per CALL, not per process: the tests below run on parallel threads of one
    // process, and a shared directory lets one test delete the store file another is reading.
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-many-faced-text-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn term(attribute: &str, alias: &str, node_type: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": attribute, "original_attribute": alias}},
            "op": ":",
            "rhs": {"node_type": node_type, "kwargs": {"value": value}},
        },
    })
}

fn regex(alias: &str, pattern: &str) -> Value {
    term("oracle_text", alias, "RegexValueNode", pattern)
}

fn phrase(alias: &str, value: &str) -> Value {
    term("oracle_text", alias, "StringValueNode", value)
}

/// Every card a tree matches, as full card objects, by name.
fn cards(store: &BufferStore, tree: &Value) -> Vec<Value> {
    let opts = QueryOptions {
        unique: "card".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "name", "card_faces"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    serde_json::from_str::<Vec<Value>>(body).unwrap()
}

fn names(store: &BufferStore, tree: &Value) -> Vec<String> {
    cards(store, tree).iter().map(|c| c["name"].as_str().unwrap().to_owned()).collect()
}

const NONE: [&str; 0] = [];

#[test]
fn five_faces_search_no_rules_text() {
    let store = store();
    for word in ["target", "destroy", "player", "gains", "destroy target artifact", "counter target creature spell"] {
        assert!(!names(&store, &phrase("o", word)).contains(&FIVE.to_owned()), "o:{word:?}");
    }
    assert_eq!(names(&store, &phrase("o", "Destroy target artifact.")), NONE, "R22");
    assert_eq!(names(&store, &regex("o", "target")), ["Fire // Ice"]);
    assert_eq!(names(&store, &regex("fo", "target")), ["Fire // Ice"]);
    assert_eq!(names(&store, &phrase("fo", "target")), ["Fire // Ice"]);
    assert_eq!(names(&store, &regex("o", ".")), ["Fire // Ice"]);
    // The text is THERE and empty, not absent: `o:/^$/` is 1 on Scryfall.
    assert_eq!(names(&store, &regex("o", "^$")), [FIVE]);
    assert_eq!(names(&store, &regex("fo", "^$")), [FIVE]);
    // R15's and R24's arms.
    assert_eq!(names(&store, &regex("o", r"destroy target (creature\.|artifact(?![^.]*you))")), NONE);
    assert_eq!(
        names(&store, &regex("o", r"^(• )?(Counter|Destroy|Exile|Return)? ?target ([\w-]+ )?(spell|creature|artifact|enchantment|permanent|land|card|player|opponent)\b")),
        NONE
    );
}

#[test]
fn the_name_the_types_and_the_printed_faces_are_untouched() {
    let store = store();
    let by_name = cards(&store, &term("card_name", "name", "RegexValueNode", "what"));
    assert_eq!(by_name.len(), 1);
    assert_eq!(by_name[0]["name"], FIVE);
    let faces = by_name[0]["card_faces"].as_array().unwrap_or_else(|| panic!("five faces: {}", by_name[0]));
    assert_eq!(faces.len(), 5);
    assert_eq!(faces[1]["oracle_text"], "Destroy target artifact.");
    assert_eq!(faces[4]["oracle_text"], "Destroy target enchantment.");
    assert_eq!(names(&store, &term("card_types", "t", "RegexValueNode", "instant")), ["Fire // Ice", FIVE]);
}

#[test]
fn two_faces_are_searched_face_by_face() {
    let store = store();
    assert_eq!(names(&store, &regex("o", r"^tap target permanent\.$")), ["Fire // Ice"]);
    assert_eq!(names(&store, &regex("o", r"targets\.$")), ["Fire // Ice"]);
    assert_eq!(names(&store, &regex("o", r"damage(.|\n)*tap target")), NONE, "no pattern crosses the two faces");
}
