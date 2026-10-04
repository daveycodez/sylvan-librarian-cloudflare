//! `-(loy>=1)` — a negated GROUP over a face stat, as api.scryfall.com answers it — through the
//! whole native pipeline: Scryfall JSON → transform → finalize → store → query, with the
//! `ScryfallNotNode` the compat surface emits for it.
//!
//! Scryfall compares `pow`, `tou` and `loy` over a printing's two faces in three-valued logic:
//! TRUE when a face satisfies the comparison, FALSE only when both faces carry the stat and
//! neither does, NULL otherwise. Under `NOT` only the FALSE ones answer. Measured 2026-10-04:
//!
//!   t:planeswalker -(loy=0)   10 — Ajani Goldmane sld/745, Arlinn mid/211, Jace Beleren sld/746,
//!                             Rowan // Will stx/156 … every printing with loyalty on two faces
//!   t:planeswalker -(loy>=4)  4  — Jace Beleren sld/746 (3 // 3) is one; Ajani Goldmane (4 // 4),
//!                             Arlinn (4 // 4) and Rowan (2) // Will (4) are not
//!   t:planeswalker -(loy>=1)  404, where `loy<1` is 4 (Dakkon's 0, Nissa's X)
//!   t:creature -(pow>=1)      2  — Birds of Paradise sld/1675 (0 // 0) is one
//!   -(pow>tou) e:khm          Cosima // The Omenkeel alone; -(pow>=3 t:elf) e:khm 289
//!
//! The printings here: Ajani Goldmane m11/1 (loyalty 4, one face) and sld/745 (reversible),
//! Jace Beleren m11/58 (3) and sld/746 (reversible), Arlinn mid/211 (4 // 4), Rowan // Will
//! stx/156 (2 // 4), Valki // Tibalt khm/114 (creature 2/1 // loyalty 5), Dakkon mh2/192 (0),
//! Nissa c20/224 (X), Birds of Paradise sld/1675 (reversible, 0/1), Lightning Bolt.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "ajani_goldmane_m11_1",
    "ajani_goldmane_sld_745",
    "jace_beleren_m11_58",
    "jace_beleren_sld_746",
    "arlinn_mid_211",
    "rowan_will_stx_156",
    "valki_khm_114",
    "dakkon_mh2_192",
    "nissa_c20_224",
    "birds_of_paradise_sld_1675",
    "lightning_bolt",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-negated-face-stat-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn attribute(column: &str, spelling: &str) -> Value {
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": column, "original_attribute": spelling}})
}

/// `<spelling><op><number>` — the tree the parser emits.
fn num(column: &str, spelling: &str, op: &str, value: i64) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute(column, spelling), "op": op, "rhs": {"node_type": "NumericValueNode", "kwargs": {"value": value}}},
    })
}

fn loy(op: &str, value: i64) -> Value {
    num("planeswalker_loyalty", "loy", op, value)
}

fn pow(op: &str, value: i64) -> Value {
    num("creature_power", "pow", op, value)
}

fn planeswalker() -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute("card_types", "t"), "op": ":", "rhs": ["Planeswalker"]},
    })
}

/// The negated group as the compat surface sends it.
fn scryfall_not(operand: Value) -> Value {
    json!({"node_type": "ScryfallNotNode", "kwargs": {"operand": operand}})
}

/// The negated group as the parser emits it, and `/search` sends it.
fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

fn or(operands: &[Value]) -> Value {
    json!({"node_type": "OrNode", "kwargs": {"operands": operands}})
}

/// Every PRINTING the tree matches, as sorted `set/number`.
fn printings(store: &BufferStore, tree: &Value) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> = serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| format!("{}/{}", c["set"].as_str().unwrap(), c["collector_number"].as_str().unwrap()))
        .collect();
    out.sort();
    out
}

const NONE: [&str; 0] = [];

#[test]
fn only_a_printing_with_the_stat_on_two_faces_can_fail_a_comparison() {
    let store = store();
    // `-(loy=0)`: every two-loyalty printing, and no single-faced planeswalker.
    assert_eq!(printings(&store, &scryfall_not(loy("=", 0))), ["mid/211", "sld/745", "sld/746", "stx/156"]);
    // `-(loy>=4)`: Jace's two 3s. Ajani and Arlinn are 4 on both faces; Will is 4.
    assert_eq!(printings(&store, &scryfall_not(loy(">=", 4))), ["sld/746"]);
    assert_eq!(printings(&store, &scryfall_not(loy(">=", 3))), NONE);
    assert_eq!(printings(&store, &scryfall_not(loy("<", 3))), ["mid/211", "sld/745", "sld/746"]);
}

#[test]
fn a_zero_or_absent_stat_on_one_face_is_not_a_false() {
    let store = store();
    // `t:planeswalker -(loy>=1)` is a 404: Dakkon's 0 and Nissa's X have one face.
    assert_eq!(printings(&store, &and(&[planeswalker(), scryfall_not(loy(">=", 1))])), NONE);
    assert_eq!(printings(&store, &and(&[planeswalker(), loy("<", 1)])), ["c20/224", "mh2/192"]);
    // Valki // Tibalt has loyalty on ONE of its two faces, and a power on the other.
    assert_eq!(printings(&store, &scryfall_not(loy("=", 7))), ["mid/211", "sld/745", "sld/746", "stx/156"]);
    assert_eq!(printings(&store, &scryfall_not(pow(">=", 5))), ["sld/1675"]);
}

#[test]
fn power_follows_the_same_rule_and_a_reversible_printing_is_its_card_twice() {
    let store = store();
    // `t:creature -(pow>=1)`: Birds of Paradise's reversible printing, 0 on both sides.
    assert_eq!(printings(&store, &scryfall_not(pow(">=", 1))), ["sld/1675"]);
    assert_eq!(printings(&store, &scryfall_not(pow(">=", 0))), NONE);
}

#[test]
fn it_is_three_valued_through_a_group() {
    let store = store();
    // `-(loy>=4 t:planeswalker)`: NOT (A AND B) — everything that is no planeswalker, and Jace's
    // reversible printing.
    // (Valki // Tibalt is a planeswalker on one face, and its loyalty is on one face.)
    assert_eq!(
        printings(&store, &scryfall_not(and(&[loy(">=", 4), planeswalker()]))),
        ["msc/806", "sld/1675", "sld/746"]
    );
    // `-(loy>=4 or t:planeswalker)`: NOT (A OR B) — nothing is both no planeswalker and false.
    assert_eq!(printings(&store, &scryfall_not(or(&[loy(">=", 4), planeswalker()]))), NONE);
    // `-(-(loy>=4))` is `loy>=4`: `-(-(pow>=3)) e:khm` is `pow>=3 e:khm`'s 78.
    assert_eq!(printings(&store, &scryfall_not(scryfall_not(loy(">=", 4)))), printings(&store, &loy(">=", 4)));
    assert_eq!(printings(&store, &loy(">=", 4)), ["khm/114", "m11/1", "mid/211", "sld/745", "stx/156"]);
    // A card-level column in the same group is the complement it always was: `-(cmc>=3) e:khm
    // t:elf` is 7 = `cmc<3`.
    let cmc = |op: &str, v: i64| num("cmc", "cmc", op, v);
    assert_eq!(
        printings(&store, &scryfall_not(or(&[loy(">=", 4), cmc(">=", 2)]))),
        printings(&store, &and(&[scryfall_not(loy(">=", 4)), cmc("<", 2)]))
    );
}

#[test]
fn the_upstream_not_node_is_still_the_complement() {
    let store = store();
    // `/search` sends `NotNode`: every printing whose loyalty is not at least 4, as before.
    assert_eq!(
        printings(&store, &and(&[planeswalker(), not(loy(">=", 4))])),
        ["c20/224", "m11/58", "mh2/192", "sld/746"]
    );
    // ...and a `ScryfallNotNode` over a group with no face stat in it is that same complement.
    assert_eq!(printings(&store, &scryfall_not(planeswalker())), printings(&store, &not(planeswalker())));
}
