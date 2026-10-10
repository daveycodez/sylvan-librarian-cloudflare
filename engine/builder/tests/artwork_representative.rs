//! `unique=art` ANSWERS THE PRINTING SCRYFALL KEEPS FOR THE ARTWORK — through the whole native
//! pipeline: Scryfall JSON → transform → finalize → store → query → card objects.
//!
//! An artwork's representative is a record api.scryfall.com keeps per illustration: a search
//! answers it wherever the query holds it, and the first of the card's own order where it does
//! not. Until 2026-10-10 the port read it as "a printing released the day the artwork debuted",
//! which is the same printing for most artworks and no rule at all where that day holds several —
//! the showcase, extended-art, surge-foil and promo printings of one release. The builder now
//! marks the row Scryfall answers (`art_reps`, the table of every artwork's representative).
//!
//! Real card objects, api.scryfall.com 2026-10-10, and the answers asserted are Scryfall's own for
//! exactly these printings (`unique=art`, extras in), each artwork's printings sharing ONE date:
//!
//! - `!"Conspiracy Unraveler"` — mkm/47 and mkm/379: the dossier art is represented by the
//!   invisible-ink foil mkm/379, not the showcase printing mkm/341 it copies, which leads the
//!   card's order and is what the port answered.
//! - `!"Cryptex"` — mkm/422, the extended-art printing, over mkm/251 and the prerelease promo;
//!   without it (`-cn:422`), mkm/251: the card's own order, not another rule.
//! - `!"Silvergill Mentor"` — ecl/403, the promo-pack printing, over the set's own ecl/69.
//! - `!"Irrigated Farmland" e:who` — who/504, the extended-art printing, over who/288, the surge
//!   foil who/879 and the extended surge foil who/1095.
//! - `!"Temple of Deceit" (e:thb or e:dsc or e:fdn)` — thb/245, the artwork's first printing;
//!   without Theros Beyond Death, fdn/697, the first of the card's order — not dsc/307, though
//!   Scryfall's `unique_artwork` bulk file lists it beside thb/245.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "conspiracy_unraveler_mkm_47",
    "conspiracy_unraveler_mkm_341",
    "conspiracy_unraveler_mkm_379",
    "cryptex_mkm_251",
    "cryptex_mkm_422",
    "cryptex_pmkm_251s",
    "silvergill_mentor_ecl_69",
    "silvergill_mentor_ecl_403",
    "irrigated_farmland_who_288",
    "irrigated_farmland_who_504",
    "irrigated_farmland_who_879",
    "irrigated_farmland_who_1095",
    "temple_of_deceit_thb_245",
    "temple_of_deceit_dsc_307",
    "temple_of_deceit_fdn_697",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The store, built from the fixtures in the order given — and again in reverse, because an
/// artwork's representative must not depend on the order the corpus streamed past.
fn store(reversed: bool) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let mut cards: Vec<Value> = FIXTURES.iter().map(|n| fixture(n)).collect();
    if reversed {
        cards.reverse();
    }
    let drafts = cards.iter().map(|c| transform_row(c, true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-artwork-representative-{}-{build}", std::process::id()));
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

fn set(code: &str) -> Value {
    leaf("card_set_code", "e", "StringValueNode", code)
}

fn number(cn: &str) -> Value {
    leaf("collector_number", "cn", "StringValueNode", cn)
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// The rows the tree matches under `unique`, as `set/number`, in page order.
fn rows(store: &BufferStore, tree: &Value, unique: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: unique.to_owned(),
        orderby: "name".to_owned(),
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

#[test]
fn a_foil_twin_represents_the_artwork_its_showcase_printing_leads() {
    for reversed in [false, true] {
        let store = store(reversed);
        let mut art = rows(&store, &name("conspiracy"), "artwork");
        art.sort();
        assert_eq!(art, ["mkm/379", "mkm/47"]);
        // The card's own order is unmoved: the showcase printing still comes before its foil twin.
        assert_eq!(rows(&store, &name("conspiracy"), "printing"), ["mkm/47", "mkm/341", "mkm/379"]);
        assert_eq!(rows(&store, &name("conspiracy"), "card"), ["mkm/47"]);
    }
}

#[test]
fn the_representative_answers_where_the_query_holds_it_and_the_cards_order_where_it_does_not() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("cryptex"), "artwork"), ["mkm/422"]);
        assert_eq!(rows(&store, &and(&[name("cryptex"), not(number("422"))]), "artwork"), ["mkm/251"]);
        assert_eq!(rows(&store, &and(&[name("cryptex"), set("pmkm")]), "artwork"), ["pmkm/251s"]);
    }
}

#[test]
fn a_promo_pack_printing_can_be_the_representative() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("silvergill"), "artwork"), ["ecl/403"]);
        assert_eq!(rows(&store, &name("silvergill"), "card"), ["ecl/69"]);
    }
}

#[test]
fn of_four_printings_of_one_day_the_extended_art_one_represents_the_artwork() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("irrigated"), "artwork"), ["who/504"]);
        assert_eq!(rows(&store, &name("irrigated"), "printing"), ["who/288", "who/504", "who/879", "who/1095"]);
    }
}

#[test]
fn a_reprint_the_bulk_file_also_lists_is_not_the_representative() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("deceit"), "artwork"), ["thb/245"]);
        // Without the artwork's first printing: the first of the card's own order, Foundations'
        // of 2024-11, not Duskmourn Commander's of 2024-09.
        assert_eq!(rows(&store, &and(&[name("deceit"), not(set("thb"))]), "artwork"), ["fdn/697"]);
    }
}
