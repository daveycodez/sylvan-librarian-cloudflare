//! Scryfall's `in:` through the whole native pipeline: Scryfall JSON → transform → finalize →
//! store → query. Real card objects (the fixtures are card objects verbatim, fetched from
//! api.scryfall.com 2026-10-09), asked the tree the parser emits for `in:<word>`.
//!
//! `in:` is "cards that have ever been printed in", and WHICH printings count is per namespace.
//! Measured on api.scryfall.com 2026-10-09 — card_engine's `assign_in_tags` carries the evidence —
//! and pinned here one rule a test, each on the card the measurement found it by:
//!
//!   - a RARITY counts from every canonical printing outside the promo, masterpiece, memorabilia
//!     and from_the_vault set types and outside Secret Lair Drop. A `box` set counts: the 2017
//!     Gift Pack's rare Plains is why `in:rare e:khm` holds the five Kaldheim basics there.
//!   - an ANNEX row — a translation of a printing `default_cards` holds in English — gives the
//!     card its language and nothing else: not its rarity, game, frame, finish or booster flag.
//!   - `astral` and `sega` are games like the other three.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{Value, json};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store of exactly these card objects, each with whether its row is the CANONICAL one of its
/// printing (the row Scryfall's `default_cards` holds) or an annex row. One directory per CALL:
/// the tests run on parallel threads.
fn store_of(cards: &[(&str, bool)]) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = cards.iter().map(|(name, canonical)| transform_row(&fixture(name), *canonical).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-in-which-printings-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `in:<word>`, the tree the parser emits.
fn printed_in(word: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_in_tags", "original_attribute": "in"}},
            "op": ":",
            "rhs": [word],
        },
    })
}

/// Every card `in:<word>` matches, by name.
fn cards_in(store: &BufferStore, word: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: "card".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "name"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(&printed_in(word), &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> =
        serde_json::from_str::<Vec<Value>>(body).unwrap().iter().map(|c| c["name"].as_str().unwrap().to_owned()).collect();
    out.sort();
    out
}

const NONE: [&str; 0] = [];

#[test]
fn a_box_sets_rarity_counts() {
    // Plains is common in Kaldheim and rare in the 2017 Gift Pack, a `box` set: `in:rare` there.
    // Every other rare printing a basic land has is a promo, a Secret Lair or an oversized prize.
    let store = store_of(&[("plains_khm_394", true), ("plains_g17_1", true)]);
    assert_eq!(cards_in(&store, "rare"), ["Plains"]);
    assert_eq!(cards_in(&store, "common"), ["Plains"]);
    // Arden Angel's only printing outside Secret Lair is a Sega Dreamcast card, `box` and
    // Japanese — the canonical row of a printing that has no English one.
    let store = store_of(&[("arden_angel_psdg_1", true)]);
    assert_eq!(cards_in(&store, "rare"), ["Arden Angel"]);
}

#[test]
fn secret_lair_drops_rarity_does_not_count() {
    // Kutzil is uncommon in Ixalan and rare in `sld/2782`; Plains is rare in `sld/100`. Neither
    // is `in:rare` by it — and `sld` is a `box` set like the Gift Pack above, so it is the set.
    let store = store_of(&[("kutzil_lci_232", true), ("kutzil_sld_2782", true), ("plains_khm_394", true), ("plains_sld_100", true)]);
    assert_eq!(cards_in(&store, "rare"), NONE);
    assert_eq!(cards_in(&store, "uncommon"), ["Kutzil, Malamet Exemplar"]);
    // The printing still counts in every other namespace.
    assert_eq!(cards_in(&store, "sld"), ["Kutzil, Malamet Exemplar", "Plains"]);
    assert_eq!(cards_in(&store, "box"), ["Kutzil, Malamet Exemplar", "Plains"]);
}

#[test]
fn a_masterpiece_sets_rarity_does_not_count() {
    // Kor Haven is rare in Nemesis and mythic as a Zendikar Expedition (`exp/41`, masterpiece).
    let store = store_of(&[("kor_haven_nem_141", true), ("kor_haven_exp_41", true)]);
    assert_eq!(cards_in(&store, "mythic"), NONE);
    assert_eq!(cards_in(&store, "rare"), ["Kor Haven"]);
    assert_eq!(cards_in(&store, "masterpiece"), ["Kor Haven"]);
}

#[test]
fn an_annex_rows_rarity_does_not_count() {
    // Whippoorwill is uncommon in The Dark and rare on the Italian row of the same printing:
    // `e:drk lang:it r:rare -in:rare` is 40 cards on api.scryfall.com, this one among them.
    let store = store_of(&[("whippoorwill_drk_91", true), ("whippoorwill_drk_91_it", false)]);
    assert_eq!(cards_in(&store, "rare"), NONE);
    assert_eq!(cards_in(&store, "uncommon"), ["Whippoorwill"]);
}

#[test]
fn an_annex_row_gives_its_language() {
    // What the annex is read for: `in:it` is the Italian row, and the card has no canonical one.
    let store = store_of(&[("whippoorwill_drk_91", true), ("whippoorwill_drk_91_it", false)]);
    assert_eq!(cards_in(&store, "it"), ["Whippoorwill"]);
    assert_eq!(cards_in(&store, "en"), ["Whippoorwill"]);
    assert_eq!(cards_in(&store, "drk"), ["Whippoorwill"]);
    assert_eq!(cards_in(&store, "de"), NONE);
}

#[test]
fn an_annex_rows_game_does_not_count() {
    // Sodden Verdure's `tmc/74` lists paper and mtgo in English and adds arena in German.
    let store = store_of(&[("sodden_verdure_tmc_74", true), ("sodden_verdure_tmc_74_de", false)]);
    assert_eq!(cards_in(&store, "arena"), NONE);
    assert_eq!(cards_in(&store, "mtgo"), ["Sodden Verdure"]);
    assert_eq!(cards_in(&store, "paper"), ["Sodden Verdure"]);
}

#[test]
fn an_annex_rows_frame_does_not_count() {
    // Nezumi Shortfang's `chk/131` is the 2003 frame in English and reads 2015 in German.
    let store = store_of(&[("nezumi_shortfang_chk_131", true), ("nezumi_shortfang_chk_131_de", false)]);
    assert_eq!(cards_in(&store, "2015"), NONE);
    assert_eq!(cards_in(&store, "2003"), ["Nezumi Shortfang // Stabwhisker the Odious"]);
}

#[test]
fn an_annex_rows_finish_and_booster_flag_do_not_count() {
    // Ashiok's Forerunner's `thb/277` is nonfoil and outside boosters in English; the German row
    // adds foil and says booster.
    let store = store_of(&[("ashioks_forerunner_thb_277", true), ("ashioks_forerunner_thb_277_de", false)]);
    assert_eq!(cards_in(&store, "foil"), NONE);
    assert_eq!(cards_in(&store, "booster"), NONE);
    assert_eq!(cards_in(&store, "nonfoil"), ["Ashiok's Forerunner"]);
}

#[test]
fn astral_and_sega_are_games() {
    // The two games the packed `games` byte has no bit for: `in:astral` is 12 cards on
    // api.scryfall.com and `in:sega` 10, with `include_extras=true`.
    let store = store_of(&[("aswan_jaguar_past_1", true), ("arden_angel_psdg_1", true), ("plains_khm_394", true)]);
    assert_eq!(cards_in(&store, "astral"), ["Aswan Jaguar"]);
    assert_eq!(cards_in(&store, "sega"), ["Arden Angel"]);
    assert_eq!(cards_in(&store, "paper"), ["Plains"]);
}
