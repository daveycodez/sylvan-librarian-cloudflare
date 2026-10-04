//! The Scryfall search keywords x68 gave an answer to, through the whole native pipeline: Scryfall
//! JSON → transform → finalize → store → query. Real card objects (the fixtures are bulk objects
//! verbatim), each keyword asked the tree the parser emits for it.
//!
//! What is pinned here is the RULE each keyword follows, on the printings the fixtures hold — the
//! corpus-wide counts measured on api.scryfall.com (2026-10-03) are recorded beside each keyword
//! in src/parser/db-info.ts and card_engine's filter.rs, and compared live by
//! scripts/live-parity-cases.json.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store of exactly these card objects. One directory per CALL: the tests run on parallel
/// threads of one process.
fn store_of(cards: &[Value]) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = cards.iter().map(|c| transform_row(c, c["lang"] == "en").unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-x68-keywords-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn store_from(fixtures: &[&str]) -> BufferStore {
    store_of(&fixtures.iter().map(|n| fixture(n)).collect::<Vec<_>>())
}

fn attribute(column: &str, spelling: &str) -> Value {
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": column, "original_attribute": spelling}})
}

/// `<spelling><op><number>` on a numeric column — the tree the parser emits.
fn num(column: &str, spelling: &str, op: &str, value: f64) -> Value {
    let value = if value.fract() == 0.0 { json!(value as i64) } else { json!(value) };
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute(column, spelling), "op": op, "rhs": {"node_type": "NumericValueNode", "kwargs": {"value": value}}},
    })
}

/// `<spelling><op><other column>` — a numeric column compared with another.
fn num_col(column: &str, spelling: &str, op: &str, other: &str, other_spelling: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute(column, spelling), "op": op, "rhs": attribute(other, other_spelling)},
    })
}

/// `<spelling><op><word>` on a text column.
fn text(column: &str, spelling: &str, op: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute(column, spelling), "op": op, "rhs": {"node_type": "StringValueNode", "kwargs": {"value": value}}},
    })
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

/// Every PRINTING the tree matches, as sorted `set/number` addresses.
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

// ── edition: ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn edition_is_set_under_another_spelling() {
    // `edition:khm t:god` = `e:khm t:god` = 12 on api.scryfall.com.
    let store = store_from(&["valki_khm_114", "doubling_cube_10e_321", "doubling_cube_5dn_116", "lightning_bolt"]);
    assert_eq!(printings(&store, &text("card_set_code", "edition", ":", "khm")), ["khm/114"]);
    assert_eq!(printings(&store, &text("card_set_code", "edition", "=", "10e")), ["10e/321"]);
    assert_eq!(
        printings(&store, &text("card_set_code", "edition", ":", "khm")),
        printings(&store, &text("card_set_code", "e", ":", "khm")),
    );
    assert_eq!(printings(&store, &not(text("card_set_code", "edition", ":", "khm"))), ["10e/321", "5dn/116", "msc/806"]);
}

// ── collector: / collectornumber: ───────────────────────────────────────────────────────────────

#[test]
fn collector_is_the_numeric_collector_number() {
    // khm/114, 10e/321, 5dn/116, msc/806. `collector:1 e:khm` is khm/1 there and
    // `collector>=390 e:khm` its 17 = `cn>=390 e:khm`.
    let store = store_from(&["valki_khm_114", "doubling_cube_10e_321", "doubling_cube_5dn_116", "lightning_bolt"]);
    let collector = |op: &str, v: f64| printings(&store, &num("collector_number_int", "collector", op, v));
    assert_eq!(collector(":", 114.0), ["khm/114"]);
    assert_eq!(collector("=", 114.0), ["khm/114"]);
    assert_eq!(collector(">=", 321.0), ["10e/321", "msc/806"]);
    assert_eq!(collector(">", 321.0), ["msc/806"]);
    assert_eq!(collector("<", 116.0), ["khm/114"]);
    assert_eq!(collector("<=", 116.0), ["5dn/116", "khm/114"]);
    assert_eq!(collector("!=", 114.0), ["10e/321", "5dn/116", "msc/806"]);
    assert_eq!(collector(":", 0.0), NONE);
    // Both spellings, and `cn` under a comparison, are one tree but for the spelling.
    assert_eq!(printings(&store, &num("collector_number_int", "collectornumber", ">=", 321.0)), ["10e/321", "msc/806"]);
    assert_eq!(printings(&store, &num("collector_number_int", "cn", ">=", 321.0)), collector(">=", 321.0));
}

#[test]
fn collector_compares_against_another_column() {
    // `collector>=cmc e:khm` is 303 = `cn>=cmc e:khm`. Every fixture's number is far above its
    // mana value, so `>=` keeps them all and `<` none.
    let store = store_from(&["valki_khm_114", "doubling_cube_10e_321", "lightning_bolt"]);
    assert_eq!(
        printings(&store, &num_col("collector_number_int", "collector", ">=", "cmc", "cmc")),
        ["10e/321", "khm/114", "msc/806"]
    );
    assert_eq!(printings(&store, &num_col("collector_number_int", "collector", "<", "cmc", "cmc")), NONE);
}

// ── edhrec: ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn edhrec_is_the_cards_rank() {
    // Llanowar Elves 58, Clifftop Retreat 81, Lightning Bolt 160, Doubling Cube 3516 (both
    // printings: the rank is the card's), and a Dragon token with none.
    let store = store_from(&[
        "llanowar_elves",
        "clifftop_retreat_yeoe_31",
        "lightning_bolt",
        "doubling_cube_10e_321",
        "doubling_cube_5dn_116",
        "dragon_tund_4",
    ]);
    let edhrec = |spelling: &str, op: &str, v: f64| printings(&store, &num("edhrec_rank", spelling, op, v));
    assert_eq!(edhrec("edhrec", ":", 160.0), ["msc/806"]);
    assert_eq!(edhrec("edhrecrank", "=", 160.0), ["msc/806"]);
    assert_eq!(edhrec("edhrec_rank", ":", 58.0), ["fdn/227"]);
    assert_eq!(edhrec("edhrec", "<=", 100.0), ["fdn/227", "yeoe/31"]);
    assert_eq!(edhrec("edhrec", "<", 81.0), ["fdn/227"]);
    assert_eq!(edhrec("edhrec", ">=", 3516.0), ["10e/321", "5dn/116"]);
    assert_eq!(edhrec("edhrec", ">", 3516.0), NONE);
}

#[test]
fn a_card_with_no_rank_compares_as_null() {
    // `edhrec!=1 e:khm` and `edhrec>=0 e:khm` are both 295 of Kaldheim's 305 on api.scryfall.com:
    // the ten unranked cards satisfy neither a comparison nor its complement.
    let store = store_from(&["lightning_bolt", "dragon_tund_4"]);
    assert_eq!(printings(&store, &num("edhrec_rank", "edhrec", ">=", 0.0)), ["msc/806"]);
    assert_eq!(printings(&store, &num("edhrec_rank", "edhrec", "!=", 1.0)), ["msc/806"]);
    assert_eq!(printings(&store, &not(num("edhrec_rank", "edhrec", ">=", 0.0))), NONE);
    assert_eq!(
        printings(&store, &and(&[num("edhrec_rank", "edhrec", ">=", 0.0), text("card_set_code", "edition", ":", "tund")])),
        NONE
    );
}
