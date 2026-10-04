//! `ft:` on a non-English printing reads THAT printing's flavor text — through the whole native
//! pipeline: Scryfall JSON → transform → finalize → store → query.
//!
//! Measured on api.scryfall.com 2026-10-04, unique=prints:
//!
//!   ft:dunkelheit lang:de   213      ft:schatten lang:de  264      ft:ombre lang:fr   755
//!   lang:ja ft:の e:neo     128      lang:de e:m21 has:flavor  199  lang:de e:m21 ft:der  77
//!   ft:/dunkel.*/ lang:de   315      ft:dunkelheit lang:any    213  ft:dunkelheit include:multilingual 135 cards
//!   ft:dunkelheit           404      (no language asked: the English printings only)
//!   lang:de e:m21 ft:the    4        (German rows whose flavor text holds the English word)
//!
//! Every one of the answering rows was a 404 here. The flavor index is built over the canonical
//! printings' texts, so the bound `ft:` leaf — a set of ids drawn from it — was False for every
//! foreign row; a query that walks the annex now leaves the predicate unbound and reads the
//! printing (`FilterExpr::bind_with`). The store is unchanged: the text was always on the row.
//!
//! Alpine Watchdog, m21/2: English "On the eighth day, a blizzard hit. …" and German „Am achten
//! Tag überraschte uns ein Schneesturm. …".

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let cards = ["alpine_watchdog_m21_2", "alpine_watchdog_m21_2_de", "lightning_bolt"].map(fixture);
    let drafts = cards.iter().map(|c| transform_row(c, c["lang"] == "en").unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-foreign-flavor-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn attribute(column: &str, spelling: &str) -> Value {
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": column, "original_attribute": spelling}})
}

fn leaf(column: &str, spelling: &str, rhs: Value) -> Value {
    json!({"node_type": "CardBinaryOperatorNode", "kwargs": {"lhs": attribute(column, spelling), "op": ":", "rhs": rhs}})
}

/// `ft:<word>` — the tree the parser emits.
fn ft(word: &str) -> Value {
    leaf("flavor_text", "ft", json!({"node_type": "StringValueNode", "kwargs": {"value": word}}))
}

/// `ft:/<pattern>/`.
fn ft_regex(pattern: &str) -> Value {
    leaf("flavor_text", "ft", json!({"node_type": "RegexValueNode", "kwargs": {"value": pattern}}))
}

fn lang(code: &str) -> Value {
    leaf("card_lang", "lang", json!({"node_type": "StringValueNode", "kwargs": {"value": code}}))
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// Every PRINTING the tree matches, as sorted `set/number/lang`.
fn printings(store: &BufferStore, tree: &Value, include_multilingual: bool) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number", "lang"].map(str::to_owned).to_vec()),
        include_multilingual,
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> = serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| {
            format!(
                "{}/{}/{}",
                c["set"].as_str().unwrap(),
                c["collector_number"].as_str().unwrap(),
                c["lang"].as_str().unwrap()
            )
        })
        .collect();
    out.sort();
    out
}

const NONE: [&str; 0] = [];
const GERMAN: [&str; 1] = ["m21/2/de"];
const ENGLISH: [&str; 1] = ["m21/2/en"];

#[test]
fn a_foreign_printing_is_found_by_its_own_flavor_text() {
    let store = store();
    assert_eq!(printings(&store, &and(&[ft("schneesturm"), lang("de")]), false), GERMAN);
    assert_eq!(printings(&store, &and(&[lang("de"), ft("am achten tag")]), false), GERMAN);
    // ...and not by the English printing's, which it does not print.
    assert_eq!(printings(&store, &and(&[ft("blizzard"), lang("de")]), false), NONE);
}

#[test]
fn a_pattern_and_has_flavor_read_the_printing_too() {
    let store = store();
    assert_eq!(printings(&store, &and(&[ft_regex("schnee.*"), lang("de")]), false), GERMAN);
    // `has:flavor` is `flavor:/./` by the time it reaches the engine.
    assert_eq!(printings(&store, &and(&[ft_regex("."), lang("de")]), false), GERMAN);
    assert_eq!(printings(&store, &and(&[not(ft("schneesturm")), lang("de")]), false), NONE);
    assert_eq!(printings(&store, &and(&[not(ft("blizzard")), lang("de")]), false), GERMAN);
}

#[test]
fn include_multilingual_reads_every_printing_and_the_default_lane_only_the_canonical_ones() {
    let store = store();
    // `ft:dunkelheit` is a 404 and `ft:dunkelheit include:multilingual` 135 cards.
    assert_eq!(printings(&store, &ft("schneesturm"), false), NONE);
    assert_eq!(printings(&store, &ft("schneesturm"), true), GERMAN);
    // The English text answers as it did, in either lane.
    assert_eq!(printings(&store, &ft("blizzard"), false), ENGLISH);
    assert_eq!(printings(&store, &ft("blizzard"), true), ENGLISH);
    assert_eq!(printings(&store, &and(&[ft("blizzard"), lang("en")]), false), ENGLISH);
}
