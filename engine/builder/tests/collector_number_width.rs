//! A collector number above 65,535 is the number it is, through the whole native pipeline: Scryfall
//! JSON → transform → finalize → store → query, and the same rows cut into partitions.
//!
//! Reported 2026-10-08 by the client that pins a printing as `(e:<set> cn:<number>)`: `e:prm
//! cn:80937` was a 404 where api.scryfall.com answers Crystalline Giant. The engine stored the
//! numeric collector number as an `Option<u16>` and every loader filled it with a saturating cast,
//! so each number past the ceiling was stored AS the ceiling — `cn>65535` matched nothing,
//! `cn<65536` matched everything, and those printings tied under `order=set`.
//!
//! The fixtures are api.scryfall.com card objects verbatim (2026-10-08): four of Magic Online's prm
//! above the ceiling, one below it, and a dated pmei promo whose "2025-25" is 202,525 — Scryfall
//! concatenates the digits, as this port does (`e:pmei cn>=202410` is 34 there, of pmei's 112).
//! One test per rule; the counts measured on api.scryfall.com are in scripts/live-parity-cases.json.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: [&str; 7] = [
    "abbot_of_keral_keep_prm_62501",
    "helm_of_obedience_prm_65642",
    "crystalline_giant_prm_80887",
    "crystalline_giant_prm_80937",
    "academy_loremaster_prm_103404",
    "aang_air_nomad_pmei_2025_25",
    "valki_khm_114",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn rows() -> Vec<Value> {
    let cards: Vec<Value> = FIXTURES.iter().map(|n| fixture(n)).collect();
    let drafts = cards.iter().map(|c| transform_row(c, c["lang"] == "en").unwrap().unwrap()).collect();
    finalize(drafts, &TagData::default()).collect()
}

/// The fixtures as ONE store. One directory per CALL: the tests run on parallel threads.
fn store() -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let out_dir = std::env::temp_dir().join(format!("sylvan-collector-width-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows().into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// The same rows cut into `n` partitions the way the publisher cuts them: by the row's partition
/// hash, each bucket built on its own through the standalone-blob path.
fn partitions(n: u32) -> Vec<BufferStore> {
    let mut buckets: Vec<Vec<Vec<u8>>> = vec![Vec::new(); n as usize];
    for row in rows() {
        let (meta, blob) = card_engine::SpillingStoreBuilder::encode_standalone(&row).expect("standalone");
        buckets[(meta.part_hash % u64::from(n)) as usize].push(blob);
    }
    buckets
        .into_iter()
        .map(|blobs| {
            let mut bytes = Vec::new();
            card_engine::build_partition_from_standalone(blobs.into_iter(), Value::Null, &mut bytes).expect("partition build");
            BufferStore::from_bytes(&bytes).expect("partition loads")
        })
        .collect()
}

fn attribute(column: &str, spelling: &str) -> Value {
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": column, "original_attribute": spelling}})
}

/// `<spelling><op><number>` on the numeric collector number — the tree the parser emits for an
/// unquoted `cn:80937`, `number:80937` and every `cn>=`.
fn num(spelling: &str, op: &str, value: u32) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute("collector_number_int", spelling), "op": op, "rhs": {"node_type": "NumericValueNode", "kwargs": {"value": value}}},
    })
}

/// `cn:"80937"` — the STRING collector number, which never had the bug.
fn quoted(value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute("collector_number", "cn"), "op": ":", "rhs": {"node_type": "StringValueNode", "kwargs": {"value": value}}},
    })
}

fn set(code: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute("card_set_code", "e"), "op": ":", "rhs": {"node_type": "StringValueNode", "kwargs": {"value": code}}},
    })
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

/// The printings a tree matches as `set/number`, in the order the store answers under `orderby`.
fn answer(store: &BufferStore, tree: &Value, orderby: &str, direction: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
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

/// Every printing the tree matches, sorted.
fn printings(store: &BufferStore, tree: &Value) -> Vec<String> {
    let mut out = answer(store, tree, "name", "asc");
    out.sort();
    out
}

const NONE: [&str; 0] = [];
const ABOVE: [&str; 5] = ["pmei/2025-25", "prm/103404", "prm/65642", "prm/80887", "prm/80937"];

#[test]
fn cn_equals_a_number_above_65535() {
    // `e:prm cn:80937` and `cn:80937` are each exactly Crystalline Giant prm/80937 on Scryfall.
    let store = store();
    assert_eq!(printings(&store, &num("cn", ":", 80_937)), ["prm/80937"]);
    assert_eq!(printings(&store, &and(&[set("prm"), num("cn", ":", 80_937)])), ["prm/80937"]);
    assert_eq!(printings(&store, &num("cn", "=", 80_887)), ["prm/80887"]);
    assert_eq!(printings(&store, &num("cn", ":", 103_404)), ["prm/103404"]);
    // The ceiling itself is nobody's number here: it was every one of these printings'.
    assert_eq!(printings(&store, &num("cn", ":", 65_535)), NONE);
    // Under the ceiling, as before.
    assert_eq!(printings(&store, &num("cn", ":", 62_501)), ["prm/62501"]);
}

#[test]
fn number_is_cn_under_another_spelling() {
    let store = store();
    assert_eq!(printings(&store, &and(&[set("prm"), num("number", ":", 80_937)])), ["prm/80937"]);
    assert_eq!(printings(&store, &num("collector", ":", 80_937)), ["prm/80937"]);
    assert_eq!(printings(&store, &num("collectornumber", "=", 80_937)), ["prm/80937"]);
}

#[test]
fn a_range_one_number_wide_above_65535_is_that_number() {
    // `e:prm cn>80936 cn<80938` — the reporter's third spelling of the pin.
    let store = store();
    let window = and(&[set("prm"), num("cn", ">", 80_936), num("cn", "<", 80_938)]);
    assert_eq!(printings(&store, &window), ["prm/80937"]);
    assert_eq!(printings(&store, &and(&[num("cn", ">=", 80_887), num("cn", "<=", 80_937)])), ["prm/80887", "prm/80937"]);
}

#[test]
fn cn_greater_than_65535_is_the_printings_numbered_above_it() {
    // `e:prm cn>65535` is 1,951 on Scryfall and was a 404 here.
    let store = store();
    assert_eq!(printings(&store, &num("cn", ">", 65_535)), ABOVE);
    assert_eq!(printings(&store, &num("cn", ">=", 65_536)), ABOVE);
    assert_eq!(printings(&store, &and(&[set("prm"), num("cn", ">", 65_535)])), ABOVE[1..]);
    assert_eq!(printings(&store, &num("cn", ">", 100_000)), ["pmei/2025-25", "prm/103404"]);
}

#[test]
fn cn_less_than_65536_leaves_the_printings_above_it_out() {
    // `e:prm cn<65536` was every card in prm, the ones numbered above 65,535 included.
    let store = store();
    assert_eq!(printings(&store, &num("cn", "<", 65_536)), ["khm/114", "prm/62501"]);
    assert_eq!(printings(&store, &num("cn", "<=", 65_535)), ["khm/114", "prm/62501"]);
    assert_eq!(printings(&store, &and(&[set("prm"), num("cn", "<", 65_536)])), ["prm/62501"]);
    // The halves the report measured at 2^15: 62,501 is above it and always was.
    assert_eq!(printings(&store, &and(&[set("prm"), num("cn", "<", 32_768)])), NONE);
    assert_eq!(printings(&store, &and(&[set("prm"), num("cn", ">=", 32_768)])).len(), 5);
}

#[test]
fn a_dated_number_is_its_digits_run_together() {
    // pmei's "2025-25" is 202,525: `e:pmei cn>=202410` is 34 of pmei's 112 on Scryfall and
    // `e:pmei cn<=30` is a 404. Stored as 65,535, it answered neither.
    let store = store();
    assert_eq!(printings(&store, &and(&[set("pmei"), num("cn", ">=", 202_410)])), ["pmei/2025-25"]);
    assert_eq!(printings(&store, &num("cn", ":", 202_525)), ["pmei/2025-25"]);
    assert_eq!(printings(&store, &and(&[set("pmei"), num("cn", "<=", 30)])), NONE);
    assert_eq!(printings(&store, &num("cn", ">", 202_525)), NONE);
}

#[test]
fn the_quoted_number_is_the_string_and_is_unchanged() {
    let store = store();
    assert_eq!(printings(&store, &and(&[set("prm"), quoted("80937")])), ["prm/80937"]);
    assert_eq!(printings(&store, &quoted("2025-25")), ["pmei/2025-25"]);
    assert_eq!(printings(&store, &quoted("8093")), NONE);
}

#[test]
fn order_set_counts_across_65535() {
    // Tied at 65,535, these fell to the string, which reads "103404" ahead of "62501".
    let store = store();
    let prm = set("prm");
    let ascending = ["prm/62501", "prm/65642", "prm/80887", "prm/80937", "prm/103404"];
    assert_eq!(answer(&store, &prm, "set", "asc"), ascending);
    let mut descending = ascending.to_vec();
    descending.reverse();
    assert_eq!(answer(&store, &prm, "set", "desc"), descending);
}

#[test]
fn the_partitioned_cut_answers_what_one_archive_does() {
    // Each row is in exactly one partition, so every answer is the union of the partitions' —
    // and `order=set`'s cross-partition key carries the whole number, not its low sixteen bits.
    let store = store();
    for n in [2, 3, 10] {
        let parts = partitions(n);
        for tree in [
            num("cn", ":", 80_937),
            num("number", ":", 80_887),
            and(&[set("prm"), num("cn", ">", 80_936), num("cn", "<", 80_938)]),
            num("cn", ">", 65_535),
            num("cn", "<", 65_536),
            num("cn", ">=", 202_410),
            quoted("80937"),
        ] {
            let mut cut: Vec<String> = parts.iter().flat_map(|p| printings(p, &tree)).collect();
            cut.sort();
            assert_eq!(cut, printings(&store, &tree), "N={n} {tree}");
        }

        let prm = set("prm");
        for direction in ["asc", "desc"] {
            let opts = QueryOptions {
                unique: "printing".to_owned(),
                orderby: "set".to_owned(),
                direction: direction.to_owned(),
                limit: 100,
                fields: Some(vec!["scryfall_id".to_owned()]),
                ..QueryOptions::default()
            };
            let whole: Vec<Vec<u8>> = store.query_keys(&prm, &opts, 0).expect("keys").keys.into_iter().map(|(k, _)| k).collect();
            assert_eq!(whole.len(), 5);
            let mut merged: Vec<Vec<u8>> = parts
                .iter()
                .flat_map(|p| p.query_keys(&prm, &opts, 0).expect("partition keys").keys.into_iter().map(|(k, _)| k))
                .collect();
            merged.sort_unstable();
            assert_eq!(merged, whole, "order=set {direction} merged from N={n}");
        }
    }
}
