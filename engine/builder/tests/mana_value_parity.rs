//! `mv:even` / `mv:odd` — through the whole native pipeline: Scryfall JSON → transform → finalize →
//! store → query, with the tree the parser emits for the two words (`(mv % 2) = 0|1`).
//!
//! Every card is one row of the 2026-10-03 measurement against api.scryfall.com, scoped by exact
//! name so the answer there is 1 or 404:
//!
//!   Seat of the Synod   mv 0     even   a land is even (`mv:even mv=0` is all 1,432 of `mv=0`)
//!   Lightning Bolt      mv 1     odd
//!   Fireball            mv 1     odd    {X}{R}: the X is 0
//!   Fire // Ice         mv 4     even   a split card is its two halves joined, not 2 and 2
//!   Delver of Secrets   mv 1     odd    a transform card is its front; the costless back is not 0
//!   Brisela             mv 11    odd    a meld result has a mana value of its own
//!   Little Girl         mv 0.5   NEITHER — `mv:even mv=0.5` and `mv:odd mv=0.5` are both 404, and
//!                                `-(mv:even or mv:odd)` is this card alone

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "seat_of_the_synod_mrd_283",
    "lightning_bolt",
    "fireball_clb_175",
    "fire_ice",
    "delver_of_secrets",
    "brisela_inr_14b",
    "little_girl_unh_16",
];

const EVEN: [&str; 2] = ["Fire // Ice", "Seat of the Synod"];
const ODD: [&str; 4] =
    ["Brisela, Voice of Nightmares", "Delver of Secrets // Insectile Aberration", "Fireball", "Lightning Bolt"];

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
    let out_dir = std::env::temp_dir().join(format!("sylvan-mana-value-parity-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn num(value: f64) -> Value {
    json!({"node_type": "NumericValueNode", "kwargs": {"value": value}})
}

fn mana_value(alias: &str) -> Value {
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "cmc", "original_attribute": alias}})
}

fn binary(lhs: Value, op: &str, rhs: Value) -> Value {
    json!({"node_type": "CardBinaryOperatorNode", "kwargs": {"lhs": lhs, "op": op, "rhs": rhs}})
}

/// `mv:even` (remainder 0) or `mv:odd` (remainder 1), as the parser lowers it.
fn parity(remainder: f64) -> Value {
    binary(binary(mana_value("mv"), "%", num(2.0)), "=", num(remainder))
}

fn not(tree: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": tree}})
}

fn nary(node_type: &str, operands: Vec<Value>) -> Value {
    json!({"node_type": node_type, "kwargs": {"operands": operands}})
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
fn even_and_odd_read_the_cards_own_mana_value() {
    let store = store();
    assert_eq!(names(&store, &parity(0.0)), EVEN, "mv:even");
    assert_eq!(names(&store, &parity(1.0)), ODD, "mv:odd");
}

#[test]
fn a_half_is_neither_and_only_the_complement_finds_it() {
    let store = store();
    let none: [&str; 0] = [];
    // `mv:even mv:odd` is 404 on Scryfall: the two are disjoint.
    assert_eq!(names(&store, &nary("AndNode", vec![parity(0.0), parity(1.0)])), none);
    // `mv:even or mv:odd` is one short of the corpus, and `-(mv:even or mv:odd)` is the one.
    let either = nary("OrNode", vec![parity(0.0), parity(1.0)]);
    assert_eq!(names(&store, &either).len(), EVEN.len() + ODD.len());
    assert_eq!(names(&store, &not(either)), ["Little Girl"]);
    // `-(mv:even)` is the complement — 16,318 there against `mv:odd`'s 16,317 — so it holds the
    // half as well as the odd cards. (The bare `-mv:even` is `mv:odd` on Scryfall; that flip is
    // the compat surface's, on the query text, and never reaches the engine as a NOT.)
    let mut odd_and_half: Vec<&str> = ODD.to_vec();
    odd_and_half.push("Little Girl");
    odd_and_half.sort_unstable();
    assert_eq!(names(&store, &not(parity(0.0))), odd_and_half);
}

#[test]
fn parity_composes_with_an_ordinary_mana_value_term() {
    let store = store();
    // `mv:even mv=0` is every `mv=0` card; `mv:odd mv=0.5` is 404.
    let mv_eq = |v: f64| binary(mana_value("mv"), "=", num(v));
    assert_eq!(names(&store, &nary("AndNode", vec![parity(0.0), mv_eq(0.0)])), ["Seat of the Synod"]);
    let none: [&str; 0] = [];
    assert_eq!(names(&store, &nary("AndNode", vec![parity(1.0), mv_eq(0.5)])), none);
    assert_eq!(names(&store, &nary("AndNode", vec![parity(0.0), mv_eq(0.5)])), none);
    assert_eq!(names(&store, &mv_eq(0.5)), ["Little Girl"]);
}
