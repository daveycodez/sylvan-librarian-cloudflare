//! A query regex is LOWERCASED before it is read, so `\S` is `\s` — through the whole native
//! pipeline: Scryfall JSON → transform → finalize → store → query.
//!
//! api.scryfall.com downcases the whole query before parsing it, and an uppercase class escape is
//! the negation of its lowercase twin. `[\s\S]*`, the usual spelling of "anything, across lines",
//! is therefore `[\s\s]*` there: a run of whitespace. mtg-seeker's 2026-10-04 reports R01–R07, R10
//! and R21 are all that one shape, and the cards below are the ones they named.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "confiscate_fdn_709",
    "dream_leash_rav_45",
    "volition_reins_som_53",
    "lara_croft_tomb_raider_sld_1501",
    "thoughtseize_2xm_109",
];

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
    let out_dir = std::env::temp_dir().join(format!("sylvan-regex-case-fold-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `o:/pattern/`, as the parser emits it — the pattern in the case the user typed.
fn regex(pattern: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "oracle_text", "original_attribute": "o"}},
            "op": ":",
            "rhs": {"node_type": "RegexValueNode", "kwargs": {"value": pattern}},
        },
    })
}

/// Every card a tree matches, by name.
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

#[test]
fn the_reported_arms_answer_what_scryfall_answers() {
    let store = store();
    let none: [&str; 0] = [];
    // R06/R07. Confiscate's two lines are adjacent, so a whitespace run joins them; Dream Leash
    // and Volition Reins have a line between and were Sylvan-only.
    assert_eq!(names(&store, &regex(r"Enchant permanent[\s\S]*You control enchanted")), ["Confiscate"]);
    // R04. `perm` is followed by a letter, never by whitespace: none of the three, where this
    // engine answered all three.
    assert_eq!(names(&store, &regex(r"enchant (artifact(?! creature)|perm)[\s\S]*you control enchanted")), none);
    // R02/R05. "…discovery counter on it. You may play…" — a full stop and words lie between.
    assert_eq!(
        names(&store, &regex(r"legendary artifact card[^.]*graveyard[^.]*discovery counter[\s\S]*you may play")),
        none
    );
    // R10. "Target player reveals their hand. You choose … That player discards" needs the
    // second alternative to cross two sentences.
    assert_eq!(names(&store, &regex(r"target player([^.]*|[\s\S]*that player) discards")), none);
}

#[test]
fn the_lowercase_spellings_still_cross_lines() {
    let store = store();
    let auras = ["Confiscate", "Dream Leash", "Volition Reins"];
    // `(.|\n)*` is how "anything, across lines" is written on Scryfall, and it is unchanged.
    assert_eq!(names(&store, &regex(r"enchant permanent(.|\n)*you control enchanted")), auras);
    // An uppercase LITERAL was always case-insensitive and still is.
    assert_eq!(names(&store, &regex("ENCHANT PERMANENT")), auras);
    // `\W` is `\w`: a word character after "enchant", which a space is not.
    assert_eq!(names(&store, &regex(r"enchant\Wpermanent")), [""; 0]);
    assert_eq!(names(&store, &regex(r"enchan\Wt permanent")), [""; 0], "and `\\w` consumes a character");
    assert_eq!(names(&store, &regex(r"enchant\Spermanent")), auras, "`\\S` is `\\s`");
}
