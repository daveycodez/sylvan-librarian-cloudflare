//! `g:` / `group:` — a set's release group — through the whole native pipeline: Scryfall JSON →
//! transform → finalize → store → query, on real card objects of the Lorwyn Eclipsed family
//! (`ecl`, its children `ecc`, `pecl`, `tecl`, `aecl`, `yecl`, and `ecc`'s child `tecc`) beside
//! two printings of other families.
//!
//! The keyword is not a column: the compat surface rewrites it into the `e:` terms it means
//! (GROUP_KEYWORDS in src/routes/scryfall-compat/query-terms.ts, the rule in set-groups.ts), and
//! tests/routes/scryfall-set-groups.test.ts pins that each spelling below parses to exactly the
//! tree built here. What is pinned HERE is that the engine answers those trees with the printings
//! api.scryfall.com answers `g:` with (2026-10-08, each family member read card by card):
//!
//!   g:ecc   777 — all seven sets          g:ecl = g:tecl   764 — every set but tecc
//!   g:tecc  189 — tecc and ecc            -g:ecc e:ecc     176 — the named set stays
//!   -(g:ecc) e:ecc   404

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// One card in three printings over `ecl` and its promo child, one over `ecc` and its Alchemy
/// sibling, a token of each token set, an art-series card — and two printings of other families.
const FIXTURES: [&str; 10] = [
    "adept_watershaper_ecl_3",
    "adept_watershaper_ecl_297",
    "adept_watershaper_pecl_3p",
    "blowfly_infestation_ecc_46",
    "blowfly_infestation_yecl_32",
    "elemental_tecc_9",
    "elf_tecl_4",
    "ajani_outland_chaperone_aecl_28",
    "blanchwood_armor_fdn_213",
    "lightning_bolt",
];

fn store() -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-set-groups-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `e:<code>`, as the parser emits it.
fn set(code: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_set_code", "original_attribute": "e"}},
            "op": ":",
            "rhs": {"node_type": "StringValueNode", "kwargs": {"value": code}},
        },
    })
}

/// `(e:a or e:b or …)` — what a `g:` term is rewritten to.
fn sets(codes: &[&str]) -> Value {
    json!({"node_type": "OrNode", "kwargs": {"operands": codes.iter().map(|c| set(c)).collect::<Vec<_>>()}})
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

fn and(operands: Vec<Value>) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

/// The default lane's exclusion, as the extras gate writes it.
fn not_extra() -> Value {
    not(json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_is_tags", "original_attribute": "is"}},
            "op": ":",
            "rhs": ["extra"],
        },
    }))
}

fn rows(store: &BufferStore, tree: &Value, unique: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: unique.to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number", "name"].map(str::to_owned).to_vec()),
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

/// Every PRINTING the tree matches, as sorted `set/number` addresses.
fn printings(store: &BufferStore, tree: &Value) -> Vec<String> {
    rows(store, tree, "printing")
}

// The `e:` lists GROUP_KEYWORDS writes for the family, from the 2026-10-08 catalog.
const G_ECC: [&str; 7] = ["aecl", "ecc", "ecl", "pecl", "tecc", "tecl", "yecl"];
const G_ECL: [&str; 6] = ["aecl", "ecc", "ecl", "pecl", "tecl", "yecl"];
const G_TECC: [&str; 2] = ["ecc", "tecc"];

const FAMILY: [&str; 8] = ["aecl/28", "ecc/46", "ecl/297", "ecl/3", "pecl/3p", "tecc/9", "tecl/4", "yecl/32"];
const OTHER_FAMILIES: [&str; 2] = ["fdn/213", "msc/806"];

#[test]
fn a_child_names_its_parent_its_siblings_and_its_own_child() {
    // g:ecc — the one member whose group is the whole family.
    let store = store();
    assert_eq!(printings(&store, &sets(&G_ECC)), FAMILY);
}

#[test]
fn a_root_and_a_childless_child_stop_short_of_the_grandchild() {
    // g:ecl and g:tecl are one list, and tecc — a child of ecc — is not in it.
    let store = store();
    let without_grandchild: Vec<&str> = FAMILY.iter().copied().filter(|p| *p != "tecc/9").collect();
    assert_eq!(printings(&store, &sets(&G_ECL)), without_grandchild);
}

#[test]
fn a_grandchild_names_its_parent_and_not_its_grandparent() {
    // g:tecc — tecc and ecc, and none of ecl or ecl's other children.
    let store = store();
    assert_eq!(printings(&store, &sets(&G_TECC)), ["ecc/46", "tecc/9"]);
}

#[test]
fn another_family_is_never_in_it_and_an_unknown_code_is_nothing() {
    let store = store();
    for group in [&G_ECC[..], &G_ECL[..], &G_TECC[..]] {
        let matched = printings(&store, &sets(group));
        assert!(OTHER_FAMILIES.iter().all(|p| !matched.contains(&(*p).to_owned())), "{group:?}");
    }
    // g:zzzz is the term that never matches (`cmc<0`), and -g:zzzz its complement.
    let never = json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "cmc", "original_attribute": "cmc"}},
            "op": "<",
            "rhs": {"node_type": "NumericValueNode", "kwargs": {"value": 0}},
        },
    });
    assert_eq!(printings(&store, &never), [""; 0]);
    assert_eq!(printings(&store, &not(never)).len(), FAMILY.len() + OTHER_FAMILIES.len());
}

#[test]
fn negated_on_the_term_the_named_set_stays() {
    let store = store();
    // -g:ecc is `-(e:aecl or e:ecl or e:pecl or e:tecc or e:tecl or e:yecl)`: ecc itself is kept.
    let minus_ecc = not(sets(&["aecl", "ecl", "pecl", "tecc", "tecl", "yecl"]));
    assert_eq!(printings(&store, &minus_ecc), ["ecc/46", "fdn/213", "msc/806"]);
    // -g:ecc g:ecc is 176 there: all of ecc and nothing else of the group.
    assert_eq!(printings(&store, &and(vec![minus_ecc.clone(), sets(&G_ECC)])), ["ecc/46"]);
    // -g:ecc e:ecl is a 404.
    assert_eq!(printings(&store, &and(vec![minus_ecc, set("ecl")])), [""; 0]);
    // -g:tecc is `-(e:ecc)`: the token set stays and its parent goes; -g:tecc g:ecc is 601.
    let minus_tecc = not(sets(&["ecc"]));
    assert_eq!(
        printings(&store, &and(vec![minus_tecc, sets(&G_ECC)])),
        ["aecl/28", "ecl/297", "ecl/3", "pecl/3p", "tecc/9", "tecl/4", "yecl/32"]
    );
    // -g:ecl is `-(e:aecl or e:ecc or e:pecl or e:tecl or e:yecl)`: ecl stays, and so does tecc,
    // which was never in ecl's group. -g:ecl g:ecc is 421.
    let minus_ecl = not(sets(&["aecl", "ecc", "pecl", "tecl", "yecl"]));
    assert_eq!(printings(&store, &and(vec![minus_ecl, sets(&G_ECC)])), ["ecl/297", "ecl/3", "tecc/9"]);
}

#[test]
fn a_negated_group_around_it_is_the_complement() {
    // -(g:ecc) is `-((e:aecl or … or e:yecl))`: nothing of the family, the named set included.
    let store = store();
    assert_eq!(printings(&store, &not(sets(&G_ECC))), OTHER_FAMILIES);
    assert_eq!(printings(&store, &and(vec![not(sets(&G_ECC)), set("ecc")])), [""; 0]);
    // -(-g:ecc) e:ecl is 408: the double negation is the other six sets.
    let minus_ecc = not(sets(&["aecl", "ecl", "pecl", "tecc", "tecl", "yecl"]));
    assert_eq!(printings(&store, &and(vec![not(minus_ecc), set("ecl")])), ["ecl/297", "ecl/3"]);
}

#[test]
fn unique_cards_is_one_row_a_card_across_the_group() {
    // Adept Watershaper is one card over ecl and pecl, Blowfly Infestation one over ecc and yecl.
    let store = store();
    assert_eq!(rows(&store, &sets(&G_ECC), "card").len(), 5);
    assert_eq!(rows(&store, &sets(&G_ECL), "card").len(), 4);
    assert_eq!(rows(&store, &sets(&G_TECC), "card"), ["ecc/46", "tecc/9"]);
    // Composition narrows it like any other term: g:ecc -e:ecl -e:pecl.
    let no_main_set = and(vec![sets(&G_ECC), not(set("ecl")), not(set("pecl"))]);
    assert_eq!(printings(&store, &no_main_set), ["aecl/28", "ecc/46", "tecc/9", "tecl/4", "yecl/32"]);
}

#[test]
fn the_default_lane_would_hide_the_groups_tokens_and_art_series() {
    // Why the term opens extras, as it does on api.scryfall.com (`g:war or cmc=3` echoes
    // include_extras=true where `e:war or cmc=3` echoes false): three of the family's sets hold
    // nothing but extras, and the exclusion the default lane adds would answer the group short —
    // by both tokens, the art-series card and yecl/32, an Arena reprint nobody opens.
    let store = store();
    let gated = and(vec![sets(&G_ECC), not_extra()]);
    assert_eq!(printings(&store, &gated), ["ecc/46", "ecl/297", "ecl/3", "pecl/3p"]);
    assert_eq!(printings(&store, &and(vec![sets(&G_TECC), not_extra()])), ["ecc/46"]);
}
