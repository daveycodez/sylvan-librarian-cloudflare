//! The party classes a card's RULES TEXT grants — through the whole native pipeline: Scryfall JSON
//! → transform → finalize → store → query. Burakos, Party Leader (`Legendary Creature — Orc`) and
//! Tajuru Paragon (`Creature — Elf`) print `is also a Cleric, Rogue, Warrior, and Wizard`, and
//! api.scryfall.com answers `t:cleric`, `t:rogue`, `t:warrior` and `t:wizard` with them
//! (2026-10-01) — the type WORD only, never a phrase or a prefix, since the word is not in the
//! line. Derevi (`Legendary Creature — Bird Wizard`) is the printed-line control.

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &["burakos_clb_653", "tajuru_paragon_znr_209", "derevi_c13_186", "lightning_bolt"];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-party-class-types-{}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `t<op><value>`, as the parser emits it: the value title-cased, the column resolved to subtypes.
fn t(op: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_subtypes", "original_attribute": "t"}},
            "op": op,
            "rhs": [value],
        },
    })
}

fn not(tree: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": tree}})
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
fn a_party_class_granted_by_rules_text_answers_the_type_word_and_nothing_wider() {
    let store = store();
    let granted = ["clb/653", "znr/209"];
    for class in ["Cleric", "Rogue", "Warrior"] {
        assert_eq!(addresses(&store, &t(":", class)), granted, "t:{class}");
        assert_eq!(addresses(&store, &t("=", class)), granted, "t={class}");
    }
    // Derevi prints the word; the two granted cards join it.
    assert_eq!(addresses(&store, &t(":", "Wizard")), ["c13/186", "clb/653", "znr/209"]);
    // Terms compose, and negation is the complement.
    assert_eq!(addresses(&store, &and(vec![t(":", "Cleric"), t(":", "Elf")])), ["znr/209"]);
    assert_eq!(addresses(&store, &not(t(":", "Wizard"))).len(), 1, "only Lightning Bolt is left");

    // Nothing wider: the granted word is not in the line, so no prefix, plural or phrase sees it,
    // and no other type the text does not name is granted.
    let none: [&str; 0] = [];
    for needle in ["Cler", "Clerics", "Elf Cleric", "Orc Warrior", "Cleric Rogue", "Ally", "Druid"] {
        assert_eq!(addresses(&store, &t(":", needle)), none, "t:{needle:?}");
    }
    assert_eq!(addresses(&store, &t(":", "Bird Wizard")), ["c13/186"]);
    assert_eq!(addresses(&store, &t(":", "Wiz")), ["c13/186"]);
    assert_eq!(addresses(&store, &t(">=", "Cleric")), none, "t>=cleric keeps the printed line");
}
