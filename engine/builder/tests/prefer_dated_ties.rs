//! `prefer:oldest` AND `prefer:newest` INSIDE ONE RELEASE DATE — through the whole native pipeline:
//! Scryfall JSON → transform → finalize → store → query → card objects.
//!
//! Real card objects, api.scryfall.com 2026-10-08: the four printings of Ultima, Origin of
//! Oblivion and the four of Ultima, all released 2025-06-13. The date ties on every one of them, so
//! the answer is the whole of Scryfall's tiebreak — the release batch of the set (ascending for
//! `oldest`, descending for `newest`), the set code, then the SMALLEST Scryfall id:
//!
//! ```text
//! Ultima, Origin of Oblivion   fin/2 d55a4c02…   pfin/2s 67bd0d2c…   fin/324 2ac1b165…   fin/421 e6e27054…
//!   prefer:oldest  fin/324      prefer:newest  pfin/2s      with e:fin, both  fin/324
//! Ultima                       fin/38 39504a0e…  pfin/38s 1586fec8…  fin/328 e673fb51…   pss5/1 e9fabb82…
//!   prefer:oldest  fin/38       prefer:newest  pfin/38s
//! ```
//!
//! `pfin` is batch 1 of that date and `fin` and `pss5` batch 0 (card_engine's release_batches.tsv),
//! so `newest` leads with the prerelease promo and `oldest` with fin, whose smallest id is the
//! borderless fin/324 — not the default printing fin/2 that the tie used to fall to here, which is
//! what `e:fin t:god prefer:oldest` showed: fin/2 and fin/128 against Scryfall's fin/324 and fin/336.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "ultima_origin_of_oblivion_fin_2",
    "ultima_origin_of_oblivion_pfin_2s",
    "ultima_origin_of_oblivion_fin_324",
    "ultima_origin_of_oblivion_fin_421",
    "ultima_fin_38",
    "ultima_pfin_38s",
    "ultima_fin_328",
    "ultima_pss5_1",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store(reversed: bool) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let mut cards: Vec<Value> = FIXTURES.iter().map(|n| fixture(n)).collect();
    if reversed {
        cards.reverse();
    }
    let drafts = cards.iter().map(|c| transform_row(c, true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-prefer-dated-ties-{}-{build}", std::process::id()));
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

fn oracle(id: &str) -> Value {
    leaf("oracle_id", "oracleid", "StringValueNode", id)
}

fn set(code: &str) -> Value {
    leaf("card_set_code", "e", "StringValueNode", code)
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

/// The one printing `unique=cards` answers for the tree under `prefer`, as `set/number`.
fn pick(store: &BufferStore, tree: &Value, prefer: &str) -> String {
    let opts = QueryOptions {
        unique: "card".to_owned(),
        prefer: prefer.to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let rows = serde_json::from_str::<Vec<Value>>(body).unwrap();
    assert_eq!(rows.len(), 1, "one card");
    format!("{}/{}", rows[0]["set"].as_str().unwrap(), rows[0]["collector_number"].as_str().unwrap())
}

#[test]
fn a_date_tie_breaks_by_the_release_batch_the_set_and_the_smallest_id() {
    for reversed in [false, true] {
        let store = store(reversed);
        let god = oracle(fixture("ultima_origin_of_oblivion_fin_2")["oracle_id"].as_str().unwrap());
        let spell = oracle(fixture("ultima_fin_38")["oracle_id"].as_str().unwrap());

        // The default printings, for contrast: what the tie fell to before.
        assert_eq!(pick(&store, &god, "default"), "fin/2");
        assert_eq!(pick(&store, &spell, "default"), "fin/38");

        // One set: the smallest Scryfall id, in both directions.
        let in_fin = and(&[god.clone(), set("fin")]);
        assert_eq!(pick(&store, &in_fin, "oldest"), "fin/324");
        assert_eq!(pick(&store, &in_fin, "newest"), "fin/324");

        // Two sets of one date: the earlier batch for `oldest`, the later for `newest`.
        assert_eq!(pick(&store, &god, "oldest"), "fin/324");
        assert_eq!(pick(&store, &god, "newest"), "pfin/2s");
        // Three: fin and pss5 share batch 0 and the code decides between them, ascending in both.
        assert_eq!(pick(&store, &spell, "oldest"), "fin/38");
        assert_eq!(pick(&store, &spell, "newest"), "pfin/38s");
    }
}
