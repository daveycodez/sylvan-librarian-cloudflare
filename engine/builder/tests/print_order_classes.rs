//! A CARD'S PRINTINGS COME BACK IN FOUR CLASSES, AND EACH ROW AT ITS OWN DATE — through the whole
//! native pipeline: Scryfall JSON → transform → finalize (the ranks) → store → query → card objects.
//!
//! The order of a card's own printings was read as three tiers: the default one, everything else,
//! and "memorabilia, a gold border, an oversized card" last. It is two facts, `(covered, extra)` —
//! is the printing outside the default tier (`is:covered`, and every row that is not English), and
//! does a search hide it unless it is asked for extras (`is:extra`) — and the printings come back
//! in the classes (0,0), (0,1), (1,0), (1,1), each newest first (`ranks::rank_class`).
//!
//! Real card objects, api.scryfall.com 2026-10-10, and the answers asserted are Scryfall's own for
//! exactly these printings, asked the same day (`unique=prints&order=name&include_extras=true`):
//!
//! - `!"Shivan Dragon"` over nine of its 54 rows — fdn/206, sld/1709, p30h/4, sld/716, gn3/87,
//!   30a/170, j21/788, o90p/5. TWO things. The Arena duplicate j21/788 (2021) carries no mark of
//!   memorabilia and sits among it, between the 30th Anniversary Edition and the 1998 oversized
//!   card: it is covered and an extra, as they are, and the three tiers ranked it ahead of the
//!   promos of 2017. And the 30th Anniversary History promo p30h/4 is dated 2023-03-21 in English
//!   and 2022-09-09 in Japanese: the English row comes back at ITS date, ahead of sld/716
//!   (2023-02), where it was ranked at the Japanese one, behind gn3/87 (2022-10). With every
//!   language the Japanese row follows gn3/87.
//! - `!"History of Benalia"` — dom/21, ybro/31, prm/99669, plst/DOM-21. The Alchemy duplicate
//!   ybro/31 (2023) is an extra Scryfall does NOT record as covered, and it comes back before the
//!   Magic Online promo of 2024: an uncovered extra is the second class, not part of the third.
//! - `!"Storm Crow"` — 9ed/100, plst/9ED-100, ysos/31. This Alchemy duplicate (2026) IS covered,
//!   and is last, after the List printing of 2020.
//! - `!"Pradesh Gypsies"` — 4ed/265, leg/197, ren/152 (fr), 4bb/265 (es). Every one carries
//!   Scryfall's content warning and is an extra; the black-bordered slot's Korean row does not and
//!   is served. One slot's languages rank apart where only some are extras: the Spanish row comes
//!   after Renaissance's, four months newer, and the Korean one — covered, not an extra — before
//!   both.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

/// The fixtures, and whether each is the row a default search reads for its printing.
const FIXTURES: &[(&str, bool)] = &[
    ("shivan_dragon_fdn_206", true),
    ("shivan_dragon_sld_1709", true),
    ("shivan_dragon_p30h_4", true),
    ("shivan_dragon_p30h_4_ja", false),
    ("shivan_dragon_sld_716", true),
    ("shivan_dragon_gn3_87", true),
    ("shivan_dragon_30a_170", true),
    ("shivan_dragon_j21_788", true),
    ("shivan_dragon_o90p_5", true),
    ("history_of_benalia_dom_21", true),
    ("history_of_benalia_ybro_31", true),
    ("history_of_benalia_prm_99669", true),
    ("history_of_benalia_plst_dom_21", true),
    ("storm_crow_9ed_100", true),
    ("storm_crow_plst_9ed_100", true),
    ("storm_crow_ysos_31", true),
    ("pradesh_gypsies_4ed_265", true),
    ("pradesh_gypsies_leg_197", true),
    ("pradesh_gypsies_ren_152_fr", true),
    ("pradesh_gypsies_4bb_265_es", true),
    ("pradesh_gypsies_4bb_265_ko", false),
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The store, built from the fixtures in the order given — and again in reverse, because the
/// order of a card's printings must not depend on the order the corpus streamed past.
fn store(reversed: bool) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let mut cards: Vec<(Value, bool)> = FIXTURES.iter().map(|(n, canonical)| (fixture(n), *canonical)).collect();
    if reversed {
        cards.reverse();
    }
    let drafts = cards.iter().map(|(c, canonical)| transform_row(c, *canonical).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-print-order-classes-{}-{build}", std::process::id()));
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

fn name(w: &str) -> Value {
    leaf("card_name", "name", "CollatedNameValueNode", w)
}

fn lang(code: &str) -> Value {
    leaf("card_lang", "lang", "StringValueNode", code)
}

fn set(code: &str) -> Value {
    leaf("card_set_code", "e", "StringValueNode", code)
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// The rows the tree matches, as `set/number` (`set/number:lang` when not English), IN PAGE ORDER.
fn rows(store: &BufferStore, tree: &Value, unique: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: unique.to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number", "lang"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| {
            let lang = c["lang"].as_str().unwrap();
            let slot = format!("{}/{}", c["set"].as_str().unwrap(), c["collector_number"].as_str().unwrap());
            if lang == "en" { slot } else { format!("{slot}:{lang}") }
        })
        .collect()
}

#[test]
fn an_extra_with_no_mark_of_memorabilia_ranks_with_the_memorabilia() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(
            rows(&store, &name("shivan"), "printing"),
            ["fdn/206", "sld/1709", "p30h/4", "sld/716", "gn3/87", "30a/170", "j21/788", "o90p/5"]
        );
        // With the served printings filtered away the newest extra answers, and it is the 30th
        // Anniversary Edition's, not the Arena duplicate the three tiers ranked ahead of it.
        let extras = and(&[
            name("shivan"),
            not(set("fdn")),
            not(set("sld")),
            not(set("p30h")),
            not(set("gn3")),
        ]);
        assert_eq!(rows(&store, &extras, "card"), ["30a/170"]);
    }
}

#[test]
fn a_printing_dated_apart_by_language_ranks_each_row_at_its_own_date() {
    for reversed in [false, true] {
        let store = store(reversed);
        // In English, 2023-03-21: ahead of the Secret Lair of 2023-02 and Game Night's of 2022-10.
        let promos = and(&[name("shivan"), not(set("fdn")), not(set("30a")), not(set("j21")), not(set("o90p"))]);
        assert_eq!(rows(&store, &promos, "printing"), ["sld/1709", "p30h/4", "sld/716", "gn3/87"]);
        // In Japanese, 2022-09-09: the one Japanese row here, asked for by its language.
        assert_eq!(rows(&store, &and(&[name("shivan"), lang("ja")]), "printing"), ["p30h/4:ja"]);
        // And the representative of `e:p30h or e:gn3` is the English promo, the newer of the two.
        let pair = and(&[name("shivan"), not(set("fdn")), not(set("sld")), not(set("30a")), not(set("j21")), not(set("o90p"))]);
        assert_eq!(rows(&store, &pair, "card"), ["p30h/4"]);
    }
}

#[test]
fn an_uncovered_extra_comes_before_every_covered_printing() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("benalia"), "printing"), ["dom/21", "ybro/31", "prm/99669", "plst/DOM-21"]);
        // Without Dominaria's own printing the Alchemy duplicate answers, not the newer promo.
        assert_eq!(rows(&store, &and(&[name("benalia"), not(set("dom"))]), "card"), ["ybro/31"]);
    }
}

#[test]
fn a_covered_extra_comes_after_every_served_printing() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("storm"), "printing"), ["9ed/100", "plst/9ED-100", "ysos/31"]);
        assert_eq!(rows(&store, &and(&[name("storm"), not(set("9ed"))]), "card"), ["plst/9ED-100"]);
    }
}

#[test]
fn one_slots_languages_rank_apart_where_only_some_are_extras() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("pradesh"), "printing"), ["4ed/265", "leg/197", "ren/152:fr", "4bb/265:es"]);
        // Among the extras that are not English the newer Renaissance row answers. Before, the
        // black-bordered slot took its served Korean row's class for every language and its
        // Spanish row, an extra of four months earlier, answered instead.
        let foreign_extras = and(&[name("pradesh"), not(lang("en")), not(lang("ko"))]);
        assert_eq!(rows(&store, &foreign_extras, "card"), ["ren/152:fr"]);
        // And with the Korean row in scope it answers: covered, served, and so ahead of every
        // extra of its card.
        assert_eq!(rows(&store, &and(&[name("pradesh"), not(lang("en"))]), "card"), ["4bb/265:ko"]);
    }
}
