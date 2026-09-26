//! Oracle ids that live only on a card's FACES — every `reversible_card` printing, and nothing else
//! in the 2026-08-16 bulk (81 printings, 71 oracle ids, both faces of each agreeing) — through the
//! whole native pipeline: Scryfall JSON → transform → finalize → partitioned store → query → card
//! object. Real JSON from that bulk: Ugin, Eye of the Storms tdm/382 and Doubling Cube's four
//! English printings (10e/321, 5dn/116, plst/10E-321 and the reversible sld/1080).
//!
//! What it pins, because each was a suspect on 2026-09-25 and none of them was the bug:
//!
//!   * a face-only printing is PARTITIONED by its faces' oracle id, beside the card's other
//!     printings, so an `oracleid:` search pinned to that id's partition (src/engine/pinned-oracle.ts)
//!     finds it — and no other partition holds any of them;
//!   * the engine's `oracle_id` filter MATCHES it: `oracleid:9afd8f12-0796-4500-aaa3-10b4a46ef6ec`
//!     is Doubling Cube's four printings, as on api.scryfall.com. (That search 404'd because the
//!     TypeScript parser glued `0796` as the number 796 — tests/parser/parity.test.ts.)
//!   * its card object carries NO top-level `oracle_id` and the card's on every face, which is the
//!     shape `/cards/:id/rulings` reads the faces' id from (`rulingsOracleIdOf`) — the rulings bug.

use card_engine::{partition_of_oracle_id, BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const UGIN: &str = "5c58353a-fd60-4528-bf0d-669626cda0b2";
const DOUBLING_CUBE: &str = "9afd8f12-0796-4500-aaa3-10b4a46ef6ec";
const N: u32 = 3;

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The five printings' partition stores, built exactly as the native builder cuts them.
fn partitions() -> Vec<BufferStore> {
    let cards = [
        "ugin_tdm_382",
        "doubling_cube_10e_321",
        "doubling_cube_5dn_116",
        "doubling_cube_plst_10e_321",
        "doubling_cube_sld_1080",
    ];
    let drafts = cards.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-face-oracle-ids-{}", std::process::id()));
    let manifest = sylvan_store_builder::build_store_partitioned(
        rows.into_iter(),
        &out_dir,
        "1754000000",
        sylvan_store_builder::PartitionsArg::Fixed(N),
    )
    .expect("partitioned build");
    let stores = manifest["partitions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let bytes = std::fs::read(out_dir.join(p["store_key"].as_str().unwrap())).unwrap();
            BufferStore::from_bytes(&bytes).expect("partition loads")
        })
        .collect();
    std::fs::remove_dir_all(&out_dir).ok();
    stores
}

/// `oracleid:<id>` as the parser's wire tree, every printing, as Scryfall card objects.
fn cards_of(store: &BufferStore, oracle_id: &str) -> Vec<Value> {
    let tree = json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "oracle_id", "original_attribute": "oracleid"}},
            "op": ":",
            "rhs": {"node_type": "StringValueNode", "kwargs": {"value": oracle_id}},
        },
    });
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(
            ["scryfall_id", "oracle_id", "name", "layout", "set_code", "collector_number", "card_faces"]
                .map(str::to_owned)
                .to_vec(),
        ),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(&tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    serde_json::from_str::<Vec<Value>>(body).unwrap()
}

fn address(card: &Value) -> String {
    format!("{}/{}", card["set"].as_str().unwrap(), card["collector_number"].as_str().unwrap())
}

#[test]
fn face_only_oracle_ids_partition_match_and_render_by_their_faces() {
    let stores = partitions();
    assert_eq!(stores.len(), N as usize);

    for (oracle_id, reversible_address, expected) in [
        (DOUBLING_CUBE, "sld/1080", vec!["10e/321", "5dn/116", "plst/10E-321", "sld/1080"]),
        (UGIN, "tdm/382", vec!["tdm/382"]),
    ] {
        let owner = partition_of_oracle_id(oracle_id, N) as usize;
        for (p, store) in stores.iter().enumerate() {
            let cards = cards_of(store, oracle_id);
            if p != owner {
                assert!(cards.is_empty(), "{oracle_id}: partition {p} holds printings its owner {owner} should");
                continue;
            }
            let mut addresses: Vec<String> = cards.iter().map(address).collect();
            addresses.sort();
            assert_eq!(addresses, expected, "{oracle_id} in its own partition {owner}");

            let reversible = cards.iter().find(|c| address(c) == reversible_address).unwrap();
            assert_eq!(reversible["layout"], "reversible_card");
            assert!(reversible.get("oracle_id").is_none(), "Scryfall's reversible card object has no top-level oracle_id");
            let faces = reversible["card_faces"].as_array().expect("faces");
            assert_eq!(faces.len(), 2);
            for face in faces {
                assert_eq!(face["oracle_id"], oracle_id, "every face carries the card's oracle id");
            }
            for card in cards.iter().filter(|c| address(c) != reversible_address) {
                assert_eq!(card["oracle_id"], oracle_id, "{}", address(card));
            }
        }
    }
}
