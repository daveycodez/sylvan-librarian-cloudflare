//! The two printed stats that were held as ABSENT and are numbers on api.scryfall.com — through
//! the whole native pipeline: Scryfall JSON → transform → finalize → store → query.
//!
//! Measured 2026-10-04, each row scoped by exact name so the answer there is 1 or 404.
//!
//! POWER `∞` (Infinity Elemental, ∞/5) is above every value a query can name, and finite:
//!
//!   pow>=0  pow>0  pow!=0  pow>1000  pow>2147483648  pow>2461449600        1
//!   pow=0   pow<0  pow<2147483648  pow=2147483648                           404
//!   pow>tou  pow>cmc  pt>=0  pt>5  pt>1000  tou=5                           1      pt=5  404
//!   pt>pow                                                                  1
//!   pow>pt  pow>=pt  pow=pt                                                 404
//!
//! and `order:power direction:desc` lists it first, ahead of B.F.M.'s 99. 2,461,449,600 is the
//! largest value Scryfall compares with at all (one more is `Value out of range`).
//!
//! LOYALTY `X` and `*` are zero: `loy=0`, `loy<1` and `loy=x` each answer Dakkon, Shadow Slayer
//! and Jeska, Thrice Reborn (printed `0`), Nissa, Steward of Elements (`X`) and B.O.B. (Bevy of
//! Beebles) (`*`); `loy>=0` is 330 against this port's 328. Dungeon Master's `1d4+1` stays
//! absent: `loy>=0`, `loy=0` and `loy=1` are each 404 for it.
//!
//! The cards here are the committed fixtures with the printed form under test written over the
//! field, so each is a real row in every other respect.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions, INFINITE_STAT};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const INFINITY: &str = "Infinity Elemental";
const GIRL: &str = "Little Girl";
const KIRAN: &str = "Heart of Kiran";
const JACE: &str = "Jace, the Mind Sculptor";
const NISSA: &str = "Nissa, Steward of Elements";
const BOB: &str = "B.O.B. (Bevy of Beebles)";
const DAKKON: &str = "Dakkon, Shadow Slayer";
const DUNGEON_MASTER: &str = "Dungeon Master";

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `base` as another card: its own name and ids, and the given fields written over it.
fn variant(base: &str, n: u8, name: &str, fields: &[(&str, &str)]) -> Value {
    let mut card = fixture(base);
    card["name"] = json!(name);
    card["id"] = json!(format!("00000000-0000-4000-8000-0000000000{n:02x}"));
    card["oracle_id"] = json!(format!("00000000-0000-4000-9000-0000000000{n:02x}"));
    card["collector_number"] = json!(format!("9{n:02}"));
    for (key, value) in fields {
        card[*key] = json!(value);
    }
    card
}

fn cards() -> Vec<Value> {
    vec![
        variant("little_girl_unh_16", 1, INFINITY, &[("power", "\u{221e}"), ("toughness", "5")]),
        fixture("little_girl_unh_16"),
        fixture("heart_of_kiran_aer_153"),
        fixture("jace_the_mind_sculptor"),
        variant("jace_the_mind_sculptor", 2, NISSA, &[("loyalty", "X")]),
        variant("jace_the_mind_sculptor", 3, BOB, &[("loyalty", "*")]),
        variant("jace_the_mind_sculptor", 4, DAKKON, &[("loyalty", "0")]),
        variant("jace_the_mind_sculptor", 5, DUNGEON_MASTER, &[("loyalty", "1d4+1")]),
        fixture("lightning_bolt"),
    ]
}

fn store() -> BufferStore {
    // One directory per CALL: the tests run on parallel threads of one process.
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = cards().iter().map(|c| transform_row(c, true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-printed-stat-values-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn num(value: f64) -> Value {
    json!({"node_type": "NumericValueNode", "kwargs": {"value": value}})
}

fn column(alias: &str) -> Value {
    let attribute = match alias {
        "pt" => "power_plus_toughness",
        "pow" => "creature_power",
        "tou" => "creature_toughness",
        "loy" => "planeswalker_loyalty",
        "mv" => "cmc",
        other => panic!("no column for {other}"),
    };
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": attribute, "original_attribute": alias}})
}

fn binary(lhs: Value, op: &str, rhs: Value) -> Value {
    json!({"node_type": "CardBinaryOperatorNode", "kwargs": {"lhs": lhs, "op": op, "rhs": rhs}})
}

fn cmp(alias: &str, op: &str, value: f64) -> Value {
    binary(column(alias), op, num(value))
}

/// The cards a tree matches, in the order asked for.
fn rows(store: &BufferStore, tree: &Value, orderby: &str, direction: &str) -> Vec<Value> {
    let opts = QueryOptions {
        unique: "card".to_owned(),
        orderby: orderby.to_owned(),
        direction: direction.to_owned(),
        fields: Some(["scryfall_id", "name", "power", "toughness", "loyalty"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    serde_json::from_str::<Vec<Value>>(body).unwrap()
}

/// Every card a tree matches, by name, sorted.
fn names(store: &BufferStore, tree: &Value) -> Vec<String> {
    let mut out: Vec<String> =
        rows(store, tree, "name", "asc").iter().map(|c| c["name"].as_str().unwrap().to_owned()).collect();
    out.sort();
    out
}

fn has(store: &BufferStore, tree: &Value, name: &str) -> bool {
    names(store, tree).iter().any(|n| n == name)
}

#[test]
fn a_printed_infinity_is_above_every_value_a_query_can_name() {
    let store = store();
    // Every row Scryfall answers 1 to.
    for (op, value) in [(">=", 0.0), (">", 0.0), ("!=", 0.0), (">", 1000.0), (">", 2_147_483_648.0), (">", 2_461_449_600.0)] {
        assert!(has(&store, &cmp("pow", op, value), INFINITY), "pow{op}{value}");
    }
    // ...and every row it answers 404 to.
    for (op, value) in [("=", 0.0), ("<", 0.0), ("<", 2_147_483_648.0), ("=", 2_147_483_648.0), ("<=", 2_461_449_600.0)] {
        assert!(!has(&store, &cmp("pow", op, value), INFINITY), "pow{op}{value}");
    }
    // The toughness beside it is the plain 5 it prints.
    assert!(has(&store, &cmp("tou", "=", 5.0), INFINITY));
    // Nothing else moved: the half and the Vehicle answer as they did.
    assert_eq!(names(&store, &cmp("pow", ">", 1000.0)), [INFINITY]);
    assert_eq!(names(&store, &cmp("pow", ">=", 0.0)), [KIRAN, INFINITY, GIRL]);
}

#[test]
fn it_is_finite_so_power_plus_toughness_is_greater_still() {
    let store = store();
    // `pt` is the sum, and the sum is above the power: `pt>pow` 1, `pow>pt` `pow>=pt` `pow=pt` 404.
    assert!(has(&store, &binary(column("pt"), ">", column("pow")), INFINITY));
    for op in [">", ">=", "="] {
        assert!(!has(&store, &binary(column("pow"), op, column("pt")), INFINITY), "pow{op}pt");
    }
    // `pt>=0`, `pt>5` and `pt>1000` are 1 and `pt=5` is 404.
    for (op, value) in [(">=", 0.0), (">", 5.0), (">", 1000.0), (">", 2_461_449_600.0)] {
        assert!(has(&store, &cmp("pt", op, value), INFINITY), "pt{op}{value}");
    }
    assert!(!has(&store, &cmp("pt", "=", 5.0), INFINITY));
    assert!(has(&store, &cmp("pt", "=", INFINITE_STAT + 5.0), INFINITY));
    // Against the other columns: `pow>tou` and `pow>cmc` are 1.
    assert!(has(&store, &binary(column("pow"), ">", column("tou")), INFINITY));
    assert!(has(&store, &binary(column("pow"), ">", column("mv")), INFINITY));
    assert!(!has(&store, &binary(column("pow"), "<", column("tou")), INFINITY));
}

#[test]
fn it_sorts_first_by_power_descending_and_serves_the_printed_string() {
    let store = store();
    let by_power = rows(&store, &cmp("pow", ">=", 0.0), "power", "desc");
    let order: Vec<&str> = by_power.iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(order, [INFINITY, KIRAN, GIRL]);
    // The card object prints what the card prints: the column is only what comparisons read.
    assert_eq!(by_power[0]["power"], json!("\u{221e}"));
    assert_eq!(by_power[0]["toughness"], json!("5"));
    let ascending = rows(&store, &cmp("pow", ">=", 0.0), "power", "asc");
    assert_eq!(ascending.last().unwrap()["name"], json!(INFINITY));
}

#[test]
fn a_printed_loyalty_of_x_or_star_is_zero() {
    let store = store();
    // `loy=0` and `loy<1`: the printed `0`, the `X` and the `*` — and not the `1d4+1`.
    assert_eq!(names(&store, &cmp("loy", "=", 0.0)), [BOB, DAKKON, NISSA]);
    assert_eq!(names(&store, &cmp("loy", "<", 1.0)), [BOB, DAKKON, NISSA]);
    assert_eq!(names(&store, &cmp("loy", ":", 0.0)), [BOB, DAKKON, NISSA]);
    // `loy>=0` is every loyalty that is a number; Dungeon Master's is not one.
    assert_eq!(names(&store, &cmp("loy", ">=", 0.0)), [BOB, DAKKON, JACE, NISSA]);
    assert_eq!(names(&store, &cmp("loy", ">", 0.0)), [JACE]);
    for op in [">=", "=", "<", "!="] {
        assert!(!has(&store, &cmp("loy", op, 0.0), DUNGEON_MASTER), "loy{op}0");
        assert!(!has(&store, &cmp("loy", op, 1.0), DUNGEON_MASTER), "loy{op}1");
    }
    // The card object prints what the card prints.
    let zero = rows(&store, &cmp("loy", "=", 0.0), "name", "asc");
    let printed: Vec<(&str, &Value)> = zero.iter().map(|c| (c["name"].as_str().unwrap(), &c["loyalty"])).collect();
    assert_eq!(printed, [(BOB, &json!("*")), (DAKKON, &json!("0")), (NISSA, &json!("X"))]);
}
