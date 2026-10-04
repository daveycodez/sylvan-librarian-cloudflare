//! The `is:` values x72 re-measured against api.scryfall.com (2026-10-04), through the whole
//! native pipeline: Scryfall JSON → transform → finalize → store → query. Real card objects (the
//! fixtures are card objects verbatim), each value asked the tree the parser emits for it.
//!
//! Each was answering a different LIST than Scryfall's — not drift, a different rule — and each
//! rule here was found by reading every printing Scryfall returns for the value and simulating
//! candidates over the same day's bulk file. One test per rule; the corpus-wide counts are
//! recorded beside the rule (the builder's `class_tags`, card_engine's `PreferClassIds` and
//! `FilterExpr::FlavorNamePresent`) and compared live by scripts/live-parity-cases.json.

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
    let out_dir = std::env::temp_dir().join(format!("sylvan-x72-is-classes-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// Every fixture as the canonical row of its printing.
fn store_from(fixtures: &[&str]) -> BufferStore {
    store_of(&fixtures.iter().map(|name| (*name, true)).collect::<Vec<_>>())
}

/// `is:<value>`, the tree the parser emits.
fn is(value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_is_tags", "original_attribute": "is"}},
            "op": ":",
            "rhs": [value],
        },
    })
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// Every PRINTING the tree matches as sorted `set/number/lang` addresses — every language when
/// `every_language`, otherwise what a search with no `lang:` and no `include_multilingual` sees.
fn rows(store: &BufferStore, tree: &Value, every_language: bool) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        include_multilingual: every_language,
        fields: Some(["scryfall_id", "set_code", "collector_number", "lang"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> = serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| {
            format!(
                "{}/{}/{}",
                c["set"].as_str().unwrap(),
                c["collector_number"].as_str().unwrap(),
                c["lang"].as_str().unwrap()
            )
        })
        .collect();
    out.sort();
    out
}

fn printings(store: &BufferStore, tree: &Value) -> Vec<String> {
    rows(store, tree, false)
}

#[test]
fn a_bear_is_a_front_that_prints_two_two_for_two() {
    // 2,884 printings on api.scryfall.com, and the rule is the FRONT's printed power `2`, printed
    // toughness `2` and the card's mana value 2 — with no creature test. High-Speed Hoverbike is
    // a 2/2 Vehicle for {2} and is in; Sygg, Wanderwine Wisdom is a 2/2 for {1}{U} on its front
    // and is in; Nezumi Graverobber is a 2/1 that flips into a 4/2, so the merged row holds a 2
    // power and a 2 toughness, and it is out — it was in, with thirteen cards like it.
    let store = store_from(&[
        "high_speed_hoverbike_neo_247",
        "sygg_ecl_76",
        "black_knight_m10_85",
        "nezumi_graverobber_chk_129",
        "abbey_gargoyles_hml_1",
    ]);
    assert_eq!(printings(&store, &is("bear")), ["ecl/76/en", "m10/85/en", "neo/247/en"]);
    assert_eq!(printings(&store, &not(is("bear"))), ["chk/129/en", "hml/1/en"]);
}

#[test]
fn french_vanilla_is_every_line_opening_with_a_keyword_ability() {
    // 3,946 printings. IN: Abbey Gargoyles ("Flying, protection from red" — protection after a
    // comma), Bloodbraid Challenger ("Cascade", "Haste", "Escape—{3}{R}{G}, Exile three other
    // cards from your graveyard." — an unspaced em dash takes the rest of the line) and the
    // double-faced token Snake // Zombie ("Deathtouch", then a vanilla back).
    //
    // OUT: Black Knight ("First strike", then "Protection from white" OPENING a line — 23
    // printings the community tag had), Djinn of Fool's Fall ("Flying", "Plot {3}{U}" — Plot is
    // a keyword ACTION in Scryfall's catalog), Copy // Horror (a blank line first), Twining Twins
    // // Swift Spiral (the adventure's text counts), and the reversible tdm/379, whose second
    // face is its Omen half and not a creature.
    let store = store_from(&[
        "abbey_gargoyles_hml_1",
        "bloodbraid_challenger_m3c_122",
        "snake_zombie_cc2_9",
        "black_knight_m10_85",
        "djinn_of_fools_fall_otj_43",
        "copy_horror_tgk1_1",
        "twining_twins_woe_240",
        "scavenger_regent_tdm_379",
    ]);
    assert_eq!(printings(&store, &is("frenchvanilla")), ["cc2/9/en", "hml/1/en", "m3c/122/en"]);
}

#[test]
fn modal_is_a_bullet_spree_or_a_seasons_pawprints() {
    // 2,596 printings: a `•` in the text (Izzet Charm), the Spree keyword (Three Steps Ahead,
    // whose modes are `+ {cost} —` lines) or `{P} worth of modes` (Season of Gathering). High and
    // Dry Black Market chooses `5 ♦ worth of modes` and is not modal there.
    let store = store_from(&[
        "izzet_charm_mm3_171",
        "three_steps_ahead_otj_75",
        "season_of_gathering_blb_192",
        "high_and_dry_black_market_punk_pla028",
        "black_knight_m10_85",
    ]);
    assert_eq!(printings(&store, &is("modal")), ["blb/192/en", "mm3/171/en", "otj/75/en"]);
}

#[test]
fn a_gainland_is_one_of_fifteen_names() {
    // 244 printings of fifteen cards. Stark Industries has Akoum Refuge's text to the letter —
    // enters tapped, gain 1 life, `{T}: Add {U} or {R}.` — and is not one.
    let store = store_from(&["akoum_refuge_c13_272", "stark_industries_msh_272"]);
    assert_eq!(printings(&store, &is("gainland")), ["c13/272/en"]);
}

#[test]
fn a_scryfall_preview_names_the_cards_own_page_or_is_one_of_three() {
    // 7 printings. Snarespinner's war/176 was previewed by Scryfall, its source the card's own
    // page; its dmu/179 by TheGamer. Dig Through Time's uma/50 carries no `preview` object at all
    // and is in; its slz/258 says `source: Scryfall` with no URI — as 321 printings of that set
    // do — and is not.
    let store = store_from(&[
        "snarespinner_war_176",
        "snarespinner_dmu_179",
        "dig_through_time_uma_50",
        "dig_through_time_slz_258",
    ]);
    assert_eq!(printings(&store, &is("scryfallpreview")), ["uma/50/en", "war/176/en"]);
}

#[test]
fn a_flavor_name_does_not_widen_the_search() {
    // 686 printings, of the 742 rows of every language that carry a flavor name. Star of
    // Extinction's sld/1862 is "Meteorfall" in English and in Japanese: one row, the English one.
    // Crystalline Giant's iko/387 exists ONLY in Japanese ("Mechagodzilla, the Weapon"), so its
    // Japanese row is the canonical one and answers; iko/234 carries no flavor name.
    let store = store_of(&[
        ("star_of_extinction_sld_1862", true),
        ("star_of_extinction_sld_1862_ja", false),
        ("crystalline_giant_iko_387", true),
        ("crystalline_giant_iko_234", true),
    ]);
    assert_eq!(printings(&store, &is("flavorname")), ["iko/387/ja", "sld/1862/en"]);
    assert_eq!(printings(&store, &not(is("flavorname"))), ["iko/234/en"]);
    // `is:flavorname lang:any` is 741 there: every language asked for, the annex row answers.
    assert_eq!(rows(&store, &is("flavorname"), true), ["iko/387/ja", "sld/1862/en", "sld/1862/ja"]);
}

#[test]
fn a_masterpiece_and_a_colorshifted_frame_are_atypical() {
    // 30,837 printings; this port answered 27,369 of them. Two of the members a prefer probe
    // could not see: Fire-Lit Thicket's Zendikar Expedition (a masterpiece set — and what
    // `prefer:atypical` answers for it on api.scryfall.com) and Essence Warden's Planar Chaos
    // printing (the colorshifted frame). Their ordinary reprints are the default frame.
    let store = store_from(&[
        "fire_lit_thicket_exp_29",
        "fire_lit_thicket_2xm_317",
        "essence_warden_plc_145",
        "essence_warden_cma_106",
    ]);
    assert_eq!(printings(&store, &is("atypical")), ["exp/29/en", "plc/145/en"]);
    assert_eq!(printings(&store, &is("default")), ["2xm/317/en", "cma/106/en"]);
}
