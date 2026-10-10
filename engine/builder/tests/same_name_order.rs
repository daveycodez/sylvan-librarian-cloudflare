//! DIFFERENT CARDS THAT SHARE A NAME COME BACK IN SCRYFALL'S ORDER — through the whole native
//! pipeline: Scryfall JSON → transform → finalize → store → query → card objects.
//!
//! 236 names are carried by more than one card, and under `order=name` — and wherever another
//! order ties and falls to the name — api.scryfall.com returns such cards in one order: a class
//! (a card, then a token or front card, then an art-series card) and then ONE collated string,
//! the type line with its type words reversed, the colours, the power, the toughness and the
//! rules text for a token; the rules text for a card (card_engine `same_name_tie`, which carries
//! the measurement: 235 of the 236 names, and the 236th by name). This port broke the tie on the
//! oracle id.
//!
//! Real card objects, api.scryfall.com 2026-10-10, and the answers asserted are Scryfall's own for
//! exactly these cards (`!"<name>"`, `unique=cards`, `order=name`, extras in):
//!
//! - `!"Elemental"`, nine of its 31 tokens — tbng/7, tshm/9, troe/2, tthb/8, tdmu/11, tecc/9,
//!   tinr/13, tecc/2, tecc/10. The enchantment token leads whatever its colour; black-red before
//!   red; a bare `*/*` first in its colour, a `*/1` between the 1/1s and the 2/1 (here: before
//!   tdmu/11), and the red `*/*` WITH rules text after the red-green 5/5 — its string is its text.
//!   Eldraine Commander's three, which `g:ecc` returned tecc/2, 10, 9: tecc/9, tecc/2, tecc/10.
//! - `!"Inferno"` — 8ed/196, ffdn/8: the card, then the Jumpstart front card, which led here.
//! - `!"Garbage Elemental"` — ust/82c, 82d, 82a, 82f, 82e, 82b: six real cards of one name, by
//!   their rules text (Battle cry, Cascade, Frenzy, Last strike, Unleash, When…), not their number.
//! - `!"Spirit"` — jtla/16, t2x2/2: the front card before a creature token (`card` < `creature…`);
//!   `!"Treasure"` — tfra/15, fj22/36: an artifact token before the front card (`artifact…` < `card`).
//! - `!"B.F.M. (Big Furry Monster)"` — ugl/28, ugl/29: the one pair of 1,901 the string gets
//!   wrong, held by name.
//!
//! The same order under `dir=desc` — the name tiebreak is ascending whatever the direction — and
//! under `order=cmc`, where the nine tokens tie on the mana value.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "elemental_tecc_2",
    "elemental_tecc_10",
    "elemental_tecc_9",
    "elemental_tinr_13",
    "elemental_tdmu_11",
    "elemental_tthb_8",
    "elemental_troe_2",
    "elemental_tshm_9",
    "elemental_tbng_7",
    "inferno_ffdn_8",
    "inferno_8ed_196",
    "garbage_elemental_ust_82a",
    "garbage_elemental_ust_82b",
    "garbage_elemental_ust_82c",
    "garbage_elemental_ust_82d",
    "garbage_elemental_ust_82e",
    "garbage_elemental_ust_82f",
    "spirit_t2x2_2",
    "spirit_jtla_16",
    "treasure_fj22_36",
    "treasure_tfra_15",
    "bfm_big_furry_monster_ugl_29",
    "bfm_big_furry_monster_ugl_28",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The store, built from the fixtures in the order given — and again in reverse, because the
/// order of the cards of one name must not depend on the order the corpus streamed past.
fn store(reversed: bool) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let mut cards: Vec<Value> = FIXTURES.iter().map(|n| fixture(n)).collect();
    if reversed {
        cards.reverse();
    }
    let drafts = cards.iter().map(|c| transform_row(c, true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-same-name-order-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `!"<name>"` — the needle as the parser hands it over, collated.
fn exactly(name: &str) -> Value {
    let collated: String = name.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    json!({"node_type": "ExactNameNode", "kwargs": {"value": collated}})
}

/// The cards the tree matches, as `set/number`, IN PAGE ORDER.
fn cards(store: &BufferStore, tree: &Value, orderby: &str, direction: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: "card".to_owned(),
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

const ELEMENTALS: [&str; 9] = ["tbng/7", "tshm/9", "troe/2", "tthb/8", "tdmu/11", "tecc/9", "tinr/13", "tecc/2", "tecc/10"];

#[test]
fn the_tokens_of_one_name_order_by_one_collated_string() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(cards(&store, &exactly("Elemental"), "name", "asc"), ELEMENTALS);
    }
}

#[test]
fn the_order_is_ascending_whatever_the_direction_and_under_an_order_that_ties() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(cards(&store, &exactly("Elemental"), "name", "desc"), ELEMENTALS);
        assert_eq!(cards(&store, &exactly("Elemental"), "cmc", "asc"), ELEMENTALS);
        assert_eq!(cards(&store, &exactly("Elemental"), "cmc", "desc"), ELEMENTALS);
    }
}

#[test]
fn a_card_comes_before_the_front_card_of_its_name() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(cards(&store, &exactly("Inferno"), "name", "asc"), ["8ed/196", "ffdn/8"]);
    }
}

#[test]
fn a_front_card_sits_between_an_artifact_token_and_a_creature_token() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(cards(&store, &exactly("Spirit"), "name", "asc"), ["jtla/16", "t2x2/2"]);
        assert_eq!(cards(&store, &exactly("Treasure"), "name", "asc"), ["tfra/15", "fj22/36"]);
    }
}

#[test]
fn real_cards_of_one_name_order_by_their_rules_text() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(
            cards(&store, &exactly("Garbage Elemental"), "name", "asc"),
            ["ust/82c", "ust/82d", "ust/82a", "ust/82f", "ust/82e", "ust/82b"]
        );
    }
}

#[test]
fn the_two_halves_of_bfm_are_held_by_name() {
    for reversed in [false, true] {
        let store = store(reversed);
        assert_eq!(cards(&store, &exactly("B.F.M. (Big Furry Monster)"), "name", "asc"), ["ugl/28", "ugl/29"]);
    }
}
