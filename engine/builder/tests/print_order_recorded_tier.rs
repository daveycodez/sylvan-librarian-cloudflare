//! A PRINTING IS RANKED IN THE TIER SCRYFALL RECORDS FOR IT — through the whole native pipeline:
//! Scryfall JSON → transform → finalize (the ranks) → store → query → card objects.
//!
//! `is:covered` is "outside the default tier of its card's own order", and `is_lists.tsv` holds
//! the English rows where Scryfall's record and the shape rule (`ranks::print_tier`) differ. The
//! rank reads that record (`ranks::recorded_tier`); before 2026-10-09 it read the rule alone, so
//! such a row was tagged right and ordered wrong.
//!
//! Real card objects, api.scryfall.com 2026-10-09, and the answers asserted are Scryfall's own for
//! exactly these printings (`unique=prints&order=name&include_extras=true&include_variations=true`).
//! Three are VARIATIONS, which a search hides unless it is asked for them — where they sit had
//! never been read:
//!
//! - `!"Zilortha, Strength Incarnate"` — cmm/366, iko/275y, cmm/599, iko/275. The Arena-only
//!   variation iko/275y (2022) is in the first run, behind Commander Masters' plain printing and
//!   ahead of its borderless one; the rule calls an Arena-only printing second-tier and put it
//!   third. `e:iko unique=cards` answers it, not the buy-a-box Godzilla iko/275.
//! - `!"Grafted Identity" (e:mid or e:dbl)` — mid/57, mid/57†, dbl/57, mid/335: the variation beside
//!   its twin, where the rule put it after Double Feature's printing of four months later.
//! - `!"Supportive Parents"` — spm/119, om1/117†, om1/117: Through the Omenpaths' plain printings
//!   are second-tier (print_tiers.tsv) and this variation is not, so it comes BEFORE the printing
//!   it is a variation of.
//!
//! And two that are not variations, the departures ranks.rs named as what it "still gets wrong":
//!
//! - `!"Wayfarer's Bauble" (e:m3c or e:lcc)` — m3c/315, lcc/317. The one default-tier row of a
//!   second-tier set and the one second-tier row of a default-tier set: the rule answered them the
//!   other way round.
//! - `!"Rhystic Study" (e:j22 or e:pcy)` — j22/114, pcy/45: Jumpstart 2022 is second-tier but for
//!   this printing.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "zilortha_strength_incarnate_iko_275",
    "zilortha_strength_incarnate_cmm_599",
    "zilortha_strength_incarnate_iko_275y",
    "zilortha_strength_incarnate_cmm_366",
    "grafted_identity_mid_335",
    "grafted_identity_dbl_57",
    "grafted_identity_mid_57_dagger",
    "grafted_identity_mid_57",
    "supportive_parents_om1_117",
    "supportive_parents_om1_117_dagger",
    "supportive_parents_spm_119",
    "wayfarers_bauble_lcc_317",
    "wayfarers_bauble_m3c_315",
    "rhystic_study_pcy_45",
    "rhystic_study_j22_114",
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
    let drafts = cards.iter().map(|c| transform_row(c, true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-print-order-recorded-tier-{}-{build}", std::process::id()));
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

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

/// The rows the tree matches, as `set/number`, IN PAGE ORDER.
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
fn a_variation_scryfall_records_in_the_default_tier_is_ranked_in_it() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("zilortha"), "printing"), ["cmm/366", "iko/275y", "cmm/599", "iko/275"]);
        assert_eq!(rows(&store, &and(&[name("zilortha"), set("iko")]), "card"), ["iko/275y"]);
        assert_eq!(rows(&store, &name("grafted"), "printing"), ["mid/57", "mid/57†", "dbl/57", "mid/335"]);
    }
}

#[test]
fn a_default_tier_variation_of_a_second_tier_printing_comes_before_it() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("supportive"), "printing"), ["spm/119", "om1/117†", "om1/117"]);
        assert_eq!(rows(&store, &and(&[name("supportive"), set("om1")]), "card"), ["om1/117†"]);
    }
}

#[test]
fn a_printing_that_departs_from_its_sets_tier_is_ranked_where_scryfall_records_it() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(rows(&store, &name("wayfarer"), "printing"), ["m3c/315", "lcc/317"]);
        assert_eq!(rows(&store, &name("wayfarer"), "card"), ["m3c/315"]);
        assert_eq!(rows(&store, &name("rhystic"), "printing"), ["j22/114", "pcy/45"]);
    }
}
