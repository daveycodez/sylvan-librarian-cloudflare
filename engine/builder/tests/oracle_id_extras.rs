//! `oracleid:` answers a card's EXTRAS printings too — through the whole native pipeline: Scryfall
//! JSON → transform → finalize → store → query → card object. Real JSON from api.scryfall.com
//! (2026-09-25): both printings of Mechtitan — the tneo/14 token and the sld/1969 reversible card
//! whose two faces are that token — and both of Tithe, the Visions vis/23 and the gold-bordered
//! 1998 World Championship deck printing wc98/bh23a.
//!
//! On api.scryfall.com a valid `oracleid:` term forces `include_extras` (src/routes/extras-gate.ts
//! has the probes), so `oracleid:<Mechtitan>&unique=prints` is tneo/14 and sld/1969 and Tithe's is
//! vis/23 and wc98/bh23a. The gate used to close anyway, and this port answered Mechtitan 404 and
//! Tithe one printing short — mtgseeker's Prints strip, which sends exactly that search.
//!
//! The gate is TypeScript, so this pins the half it cannot: that these four printings ARE in the
//! extras class the gate's `NOT is:extra` conjunct removes (every one but vis/23), and what each of
//! the two trees answers. The first tree below is the one the gate now sends for `oracleid:<id>`
//! — its `NOT is:variation` conjunct alone; tests/routes/search-extras.test.ts pins that the gate
//! sends exactly it.

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const MECHTITAN: &str = "a4fecf0a-a7b3-49e4-bbb2-9690dff5a8f4";
const TITHE: &str = "318304f5-0929-4cd3-97e6-08ac1ac48aa6";

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    let cards = ["mechtitan_tneo_14", "mechtitan_sld_1969", "tithe_vis_23", "tithe_wc98_bh23a"];
    let drafts = cards.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-oracle-id-extras-{}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn oracle_id_leaf(oracle_id: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "oracle_id", "original_attribute": "oracleid"}},
            "op": ":",
            "rhs": {"node_type": "StringValueNode", "kwargs": {"value": oracle_id}},
        },
    })
}

/// `NOT is:<tag>`, spelled as extras-gate.ts's `notIsTagNode` spells it.
fn not_is(tag: &str) -> Value {
    json!({
        "node_type": "NotNode",
        "kwargs": {"operand": {
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_is_tags", "original_attribute": "is"}},
                "op": ":",
                "rhs": [tag],
            },
        }},
    })
}

fn and(operands: Vec<Value>) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

/// Every printing a tree matches, as sorted `set/number` addresses.
fn addresses(store: &BufferStore, tree: &Value) -> Vec<String> {
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

#[test]
fn an_oracle_id_search_answers_the_extras_printings_scryfall_does() {
    let store = store();
    for (oracle_id, all, extras) in [
        (MECHTITAN, vec!["sld/1969", "tneo/14"], vec!["sld/1969", "tneo/14"]),
        (TITHE, vec!["vis/23", "wc98/bh23a"], vec!["wc98/bh23a"]),
    ] {
        // The extras class, as the store holds it: a token, a reversible card of tokens, and a
        // World Championship deck printing — every one of them `is:extra`, and vis/23 not.
        let extra_leaf = not_is("extra")["kwargs"]["operand"].clone();
        assert_eq!(addresses(&store, &and(vec![oracle_id_leaf(oracle_id), extra_leaf])), extras, "{oracle_id} is:extra");

        // What the gate sends for `oracleid:<id>` now: every printing, as on api.scryfall.com.
        let open = and(vec![oracle_id_leaf(oracle_id), not_is("variation")]);
        assert_eq!(addresses(&store, &open), all, "{oracle_id}, gate open");

        // What it used to send: the extras gone — Mechtitan nothing at all (the route's 404), Tithe
        // its Visions printing alone.
        let closed = and(vec![oracle_id_leaf(oracle_id), not_is("extra"), not_is("variation")]);
        let kept: Vec<String> = all.iter().filter(|a| !extras.contains(a)).map(|a| (*a).to_owned()).collect();
        assert_eq!(addresses(&store, &closed), kept, "{oracle_id}, gate closed");
    }
}
