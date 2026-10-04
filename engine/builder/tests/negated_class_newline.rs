//! A negated character class stops at a line break — through the whole native pipeline: Scryfall
//! JSON → transform → finalize → store → query.
//!
//! The two queries are the ones mtg-seeker reported on 2026-10-03, and the four cards are the ones
//! they separate. Tiller Engine and Monument to Endurance are MODAL: the trigger is one line, the
//! modes are bullets on lines of their own, and `[^.]*` only reaches the bullet by crossing the
//! break. api.scryfall.com does not cross it (PostgreSQL ARE's newline-sensitive mode: `.` and a
//! bracket expression using `^` never match a newline) and answers Amulet of Vigor alone for the
//! first and Bone Miser alone for the second; this engine answered both cards for each.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] =
    &["tiller_engine_dmc_20", "amulet_of_vigor_wwk_121", "monument_to_endurance_dft_237", "bone_miser_c19_15"];

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
    let out_dir = std::env::temp_dir().join(format!("sylvan-negated-class-newline-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `o:/pattern/` or `fo:/pattern/`, as the parser emits it.
fn regex(alias: &str, pattern: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "oracle_text", "original_attribute": alias}},
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
fn the_reported_queries_answer_what_scryfall_answers() {
    let store = store();
    // 1 on api.scryfall.com (2026-10-03), 2 here before: Tiller Engine's "Untap that land." is
    // the first bullet, a line below the trigger.
    assert_eq!(names(&store, &regex("o", "you control enters tapped, [^.]*untap")), ["Amulet of Vigor"]);
    // 1 there, 2 here before: Monument to Endurance's "Draw a card." is its first bullet.
    assert_eq!(names(&store, &regex("fo", "whenever you (cycle or )?discard[^.]*draw a card")), ["Bone Miser"]);
    // Naming the newline in the class changes nothing, because it is already not in it.
    assert_eq!(names(&store, &regex("fo", r"whenever you (cycle or )?discard[^.\n]*draw a card")), ["Bone Miser"]);
}

#[test]
fn only_a_negated_class_is_kept_off_the_line_break() {
    let store = store();
    let both = ["Monument to Endurance", "Tiller Engine"];
    let none: [&str; 0] = [];
    // `choose one` ends the trigger line on both modal cards; the next thing is the break.
    for crossing in [r"\n", r"\s", r"[\s\S]", r"[\n]", r"[[:space:]]", r"(.|\n)"] {
        assert_eq!(names(&store, &regex("o", &format!("—{crossing}•"))), both, "{crossing}");
    }
    for stopped in [".", "[^x]", "[^a-z]", "[^[:alpha:]]"] {
        assert_eq!(names(&store, &regex("o", &format!("—{stopped}•"))), none, "{stopped}");
    }
    // Inside one line a negated class is what it always was.
    assert_eq!(names(&store, &regex("o", "tapped, [^.]*one")), ["Tiller Engine"]);
    // And the line anchors still find the bullets (the other two legs of the same mode).
    assert_eq!(names(&store, &regex("o", "^• untap that land\\.$")), ["Tiller Engine"]);
}
