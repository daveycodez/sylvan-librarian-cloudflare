//! A SECRET LAIR BONUS PRINTING GIVES WAY TO A PLAIN SIBLING OF ITS ARTWORK in `unique=art`, for any
//! layout — through the whole native pipeline: Scryfall JSON → transform → finalize → store → query.
//!
//! api.scryfall.com, 2026-10-04, `oracleid:… ((e:sld cn:…) or (e:sld cn:…)) unique=art`, one request
//! per group. Of the 15 artwork groups inside `sld` that mix a `sldbonus` printing with a plain one,
//! it keeps the PLAIN printing in 14 — Silence sld/1816 (not sld/881), Braid of Fire sld/1247 (not
//! sld/729), Counterspell sld/1933 (not sld/7010), the five reversible planeswalkers, and six more
//! where this port already agreed — and the bonus printing in ONE: Counterspell's sld/SCTLR, against
//! the plain sld/175. `unique=cards` on the same groups keeps the bonus printing in eight of them
//! (Silence sld/881, Braid of Fire sld/729, Counterspell sld/7010 and the five planeswalkers), so the
//! rule is `unique=art`'s and no wider.
//!
//! The printings here: Silence sld/881 (bonus) and sld/1816, Braid of Fire sld/729 (bonus) and
//! sld/1247, Counterspell sld/7010 (bonus) and sld/1933, and the exception, Counterspell sld/SCTLR
//! (bonus, priced $900) beside sld/175.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "silence_sld_881",
    "silence_sld_1816",
    "braid_of_fire_sld_729",
    "braid_of_fire_sld_1247",
    "counterspell_sld_7010",
    "counterspell_sld_1933",
    "counterspell_sld_sctlr",
    "counterspell_sld_175",
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
    let out_dir = std::env::temp_dir().join(format!("sylvan-secret-lair-bonus-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn leaf(attribute: &str, alias: &str, kind: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": attribute, "original_attribute": alias}},
            "op": ":",
            "rhs": {"node_type": kind, "kwargs": {"value": value}},
        },
    })
}

fn set(code: &str) -> Value {
    leaf("card_set_code", "e", "StringValueNode", code)
}

fn number(n: &str) -> Value {
    leaf("collector_number", "cn", "StringValueNode", n)
}

fn name(w: &str) -> Value {
    leaf("card_name", "name", "CollatedNameValueNode", w)
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

fn or(operands: &[Value]) -> Value {
    json!({"node_type": "OrNode", "kwargs": {"operands": operands}})
}

/// The rows the tree matches under `unique` and `orderby`, as `set/number`, IN PAGE ORDER.
fn ordered(store: &BufferStore, tree: &Value, unique: &str, orderby: &str) -> Vec<String> {
    ordered_in(store, tree, unique, orderby, "asc")
}

fn ordered_in(store: &BufferStore, tree: &Value, unique: &str, orderby: &str, direction: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: unique.to_owned(),
        orderby: orderby.to_owned(),
        direction: direction.to_owned(),
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

fn sorted(mut rows: Vec<String>) -> Vec<String> {
    rows.sort();
    rows
}

#[test]
fn unique_art_gives_a_bonus_printing_up_to_a_plain_one_in_any_layout() {
    let store = store();
    let art = |tree: &Value| sorted(ordered(&store, tree, "artwork", "name"));
    // Silence, Braid of Fire and Counterspell's sld/1933 group: the plain printing, where the store's
    // order (`prefer_score`) kept the bonus one.
    assert_eq!(art(&and(&[set("sld"), name("silence")])), ["sld/1816"]);
    assert_eq!(art(&and(&[set("sld"), name("braid")])), ["sld/1247"]);
    // Counterspell is TWO artworks: sld/1933's group gives way, and SCTLR's does not exist to give —
    // Scryfall keeps the bonus SCTLR there, where the page holds sld/175 already, a plain printing
    // that no rule of this one's reaches. The one of the 15 that stays different, and why: nothing
    // separates it from the 14 in the fields the store holds (the bonus printing is the only one of
    // the 15 with a price, but Tibalt and Evolving Wilds, which have one too, split).
    assert_eq!(art(&and(&[set("sld"), name("counterspell")])), ["sld/175", "sld/1933"]);
    // A sibling that the filter EXCLUDES cannot stand for the group: with the plain one out of the
    // query the bonus printing is all there is, as on Scryfall.
    assert_eq!(art(&and(&[set("sld"), name("silence"), not(number("1816"))])), ["sld/881"]);
    assert_eq!(art(&and(&[set("sld"), name("braid"), not(number("1247"))])), ["sld/729"]);
    // `unique=cards` is the opposite pick for the bonus printings, and no rule here touches it.
    let cards = |tree: &Value| sorted(ordered(&store, tree, "card", "name"));
    assert_eq!(cards(&and(&[set("sld"), name("silence")])), ["sld/881"]);
    assert_eq!(cards(&and(&[set("sld"), name("braid")])), ["sld/729"]);
    // `unique=prints` is every printing.
    assert_eq!(
        sorted(ordered(&store, &and(&[set("sld"), or(&[name("silence"), name("braid")])]), "printing", "name")),
        ["sld/1247", "sld/1816", "sld/729", "sld/881"]
    );
}

#[test]
fn the_swapped_printing_is_what_the_page_is_ordered_by() {
    let store = store();
    // The plain printings' prices when fetched: Counterspell sld/175 $5.01, Silence sld/1816 $19.20,
    // Counterspell sld/1933 $26.77, Braid of Fire sld/1247 $29.18; the bonus printings (sld/881, 729,
    // 7010) carry none. A swapped row's key is its NEW printing's price. Left where its predecessor
    // sorted to — an unpriced printing, which sorts LAST — Braid of Fire and Counterspell's sld/1933
    // would trail the page in the order the store listed them, and would not be in price order.
    // api.scryfall.com orders by the printing it shows.
    let all = and(&[set("sld"), or(&[name("silence"), name("braid"), name("counterspell")])]);
    assert_eq!(ordered(&store, &all, "artwork", "usd"), ["sld/175", "sld/1816", "sld/1933", "sld/1247"]);
    assert_eq!(ordered_in(&store, &all, "artwork", "usd", "desc"), ["sld/1247", "sld/1933", "sld/1816", "sld/175"]);
    // The control: with the plain siblings excluded nothing swaps, and the bonus printings' missing
    // prices keep them where an unpriced printing sorts.
    let no_plain = and(&[all, not(number("1247")), not(number("1933"))]);
    let page = ordered(&store, &no_plain, "artwork", "usd");
    assert_eq!(&page[..2], ["sld/175", "sld/1816"]);
    assert_eq!(sorted(page[2..].to_vec()), ["sld/7010", "sld/729"]);
}
