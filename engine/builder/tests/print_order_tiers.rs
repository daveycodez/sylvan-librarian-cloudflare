//! A CARD'S PRINTINGS COME BACK IN SCRYFALL'S TIERS — through the whole native pipeline: Scryfall
//! JSON → transform → finalize (the ranks) → store → query → card objects.
//!
//! Real card objects, api.scryfall.com 2026-10-08, and the answers asserted are Scryfall's own for
//! exactly these printings, each asked the same day (`unique=prints&order=name&include_extras=true`
//! unless said otherwise):
//!
//! - `!"Neheb, Dreadhorde Champion"` — dmc/125, war/140, sld/857, pwar/140★, pwar/140s. The set
//!   printings lead, 2022 then 2019; the 2021 resale promo pwar/140★ follows them both, where a
//!   date-first order put it ahead of war/140 — which is what `g:war unique=cards` answered here,
//!   pwar/140★ against Scryfall's war/140.
//! - `!"Ultima"` — fin/38, pfin/38s, fin/328, pss5/1: four printings of one date, the default one
//!   and then the prerelease promo's set ahead of fin's borderless and of Standard Showdown's,
//!   where the collector number alone put pss5/1 second.
//! - `!"Abrade" (e:tdc or e:blc or e:inr or e:plst or e:2xm or e:hou or e:phou or e:fdc)` —
//!   tdc/203, inr/139, 2xm/114, hou/83, then fdc/136, inr/311, blc/191, plst/2XM-114, plst/HOU-83,
//!   phou/83. Foundations Commander's printing is the newest of the ten and the fifth returned, and
//!   `unique=cards` over the same ten answers tdc/203, not fdc/136.
//! - `!"Counterspell" ((e:mar cn:9) or e:dsc or e:cmm or e:pf26)` — dsc/114, cmm/81, pf26/5, mar/9,
//!   cmm/630; with `lang:ja`, mar/9, dsc/114, cmm/81, cmm/630 and `unique=cards` mar/9. The same
//!   slot leads in English and comes second in Japanese: the default tier is English only.
//!   `/cards/named?fuzzy=対抗呪文` answers that Japanese mar/9 too.
//! - `!"Counterspell" (e:ced or e:cei)` — cei/55, ced/55, the last two of Counterspell's printings:
//!   both Collectors' Editions are dated 1993-12-10 and `cei` is the later release batch of that
//!   date, a boundary the code order hides (`ced`, `cei` ascending either way) and
//!   release_batches.tsv finds by asking both prefers. Scryfall keeps `cei` under `prefer:newest`
//!   and `ced` under `prefer:oldest` for all 292 cards the two share.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "neheb_dreadhorde_champion_dmc_125",
    "neheb_dreadhorde_champion_war_140",
    "neheb_dreadhorde_champion_sld_857",
    "neheb_dreadhorde_champion_pwar_140star",
    "neheb_dreadhorde_champion_pwar_140s",
    "ultima_fin_38",
    "ultima_pfin_38s",
    "ultima_fin_328",
    "ultima_pss5_1",
    "abrade_tdc_203",
    "abrade_inr_139",
    "abrade_2xm_114",
    "abrade_hou_83",
    "abrade_fdc_136",
    "abrade_inr_311",
    "abrade_blc_191",
    "abrade_plst_2xm_114",
    "abrade_plst_hou_83",
    "abrade_phou_83",
    "counterspell_dsc_114",
    "counterspell_dsc_114_ja",
    "counterspell_cmm_81",
    "counterspell_cmm_81_ja",
    "counterspell_cmm_630",
    "counterspell_cmm_630_ja",
    "counterspell_mar_9",
    "counterspell_mar_9_ja",
    "counterspell_pf26_5",
    "counterspell_ced_55",
    "counterspell_cei_55",
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
    let mut cards: Vec<Value> = FIXTURES.iter().map(|n| fixture(n)).collect();
    if reversed {
        cards.reverse();
    }
    let drafts = cards.iter().map(|c| transform_row(c, c["lang"] == "en").unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-print-order-tiers-{}-{build}", std::process::id()));
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
fn a_promo_follows_every_set_printing_whatever_its_date() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(
            rows(&store, &name("neheb"), "printing"),
            ["dmc/125", "war/140", "sld/857", "pwar/140★", "pwar/140s"]
        );
        // `g:war`'s representative: with Dominaria United Commander's printing out of the scope,
        // War of the Spark's own, not the 2021 promo that outdates it.
        assert_eq!(rows(&store, &and(&[name("neheb"), not(set("dmc"))]), "card"), ["war/140"]);
    }
}

#[test]
fn one_date_orders_its_sets_by_release_batch_and_its_numbers_inside_them() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("ultima"), "printing"), ["fin/38", "pfin/38s", "fin/328", "pss5/1"]);
        // `g:fin -e:fin -e:fic`: the prerelease promo, where the store answered pss5/1.
        assert_eq!(rows(&store, &and(&[name("ultima"), not(set("fin"))]), "card"), ["pfin/38s"]);
    }
}

#[test]
fn a_set_the_table_names_is_second_tier_though_its_printing_looks_like_a_default_one() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(
            rows(&store, &name("abrade"), "printing"),
            [
                "tdc/203",
                "inr/139",
                "2xm/114",
                "hou/83",
                "fdc/136",
                "inr/311",
                "blc/191",
                "plst/2XM-114",
                "plst/HOU-83",
                "phou/83"
            ]
        );
        assert_eq!(rows(&store, &name("abrade"), "card"), ["tdc/203"]);
    }
}

#[test]
fn the_default_tier_is_english_only_so_another_language_orders_by_its_dates() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(
            rows(&store, &name("counterspell"), "printing"),
            ["dsc/114", "cmm/81", "pf26/5", "mar/9", "cmm/630", "cei/55", "ced/55"]
        );
        assert_eq!(rows(&store, &name("counterspell"), "card"), ["dsc/114"]);
        // Without Duskmourn Commander's printing: Commander Masters', not the 2026 promo.
        assert_eq!(rows(&store, &and(&[name("counterspell"), not(set("dsc"))]), "card"), ["cmm/81"]);
        // In Japanese nothing is in the default tier.
        let japanese = and(&[name("counterspell"), lang("ja")]);
        assert_eq!(rows(&store, &japanese, "printing"), ["mar/9:ja", "dsc/114:ja", "cmm/81:ja", "cmm/630:ja"]);
        assert_eq!(rows(&store, &japanese, "card"), ["mar/9:ja"]);
    }
}

#[test]
fn a_batch_boundary_the_code_order_hides_still_puts_the_later_batch_first() {
    for reversed in [false, true] {
        let store = store(reversed);
        let collectors = and(&[name("counterspell"), not(set("dsc")), not(set("cmm")), not(set("pf26")), not(set("mar"))]);
        assert_eq!(rows(&store, &collectors, "printing"), ["cei/55", "ced/55"]);
        assert_eq!(rows(&store, &collectors, "card"), ["cei/55"]);
    }
}
