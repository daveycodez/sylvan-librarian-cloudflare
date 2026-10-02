//! `is:funny` for the printings that are funny on ANOTHER printing's account — through the whole
//! native pipeline: Scryfall JSON → transform → finalize → store → query. Real card JSON from the
//! 2026-10-01 bulk, each answer pinned against api.scryfall.com the same day (`unique=prints`,
//! `include_extras`); the rule and its measurement are on `transform::FunnyCards`.
//!
//!   - a CARD with no funny signal of its own is funny when a sibling printing has one: sld/869
//!     Blacker Lotus (a borderless Secret Lair poster) beside ugl/70 (Unglued, silver-bordered);
//!   - a TOKEN reprinted into a funny set makes nothing funny, itself included: hho/21★ is one of
//!     99 Treasures, and Scryfall calls none of them funny — not sld/1432 (a box set), not txln/8;
//!   - a token BORN funny is funny in every printing: h17/4 is the Dragon's first, and tund/4 —
//!     black-bordered, in a token set — and tust/16 are funny with it. tust/4 Faerie Spy, born in
//!     a token set, is not.
//!
//! The fixtures are the bulk's objects verbatim, except the three Treasures' `all_parts`: Scryfall
//! lists every card that makes a Treasure there (some 500 entries each), and they keep the first
//! three.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store of exactly these card objects. One directory per CALL: the tests run on parallel
/// threads of one process.
fn store_of(cards: &[Value]) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = cards.iter().map(|c| transform_row(c, true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-funny-siblings-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn store_from(fixtures: &[&str]) -> BufferStore {
    store_of(&fixtures.iter().map(|n| fixture(n)).collect::<Vec<_>>())
}

/// Every printing `is:funny` matches, as sorted `set/number` addresses — the tree the parser emits
/// for a stored tag, so this is the bit the query plane reads.
fn funny(store: &BufferStore) -> Vec<String> {
    let tree = json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_is_tags", "original_attribute": "is"}},
            "op": ":",
            "rhs": ["funny"],
        },
    });
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(&tree, &opts, "https://sylvan.example").expect("query");
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

const NONE: [&str; 0] = [];

#[test]
fn a_card_is_funny_when_a_sibling_printing_is() {
    // sld/869 carries none of the printing rule's signals — a `box` set, borderless, a triangle
    // stamp — and Scryfall calls it funny. ugl/70 is why.
    let store = store_from(&["blacker_lotus_ugl_70", "blacker_lotus_sld_869", "lightning_bolt"]);
    assert_eq!(funny(&store), ["sld/869", "ugl/70"]);
}

#[test]
fn a_sibling_needs_a_funny_printing_to_inherit_from() {
    // The same sld/869 with no Unglued printing beside it: nothing on the row says funny, so
    // nothing is. The tag is the card's, never the Secret Lair's.
    let store = store_from(&["blacker_lotus_sld_869", "lightning_bolt"]);
    assert_eq!(funny(&store), NONE);
}

#[test]
fn a_token_reprinted_into_a_funny_set_makes_no_treasure_funny() {
    // THE TRAP. hho/21★ passes the printing rule (a funny set, never legal), and every Treasure
    // shares its oracle id. Scryfall calls none of them funny: not the Secret Lair one, which is
    // outside a token set and would inherit as a card does, not txln/8, and not hho/21★ itself.
    let store = store_from(&["treasure_hho_21star", "treasure_sld_1432", "treasure_txln_8", "lightning_bolt"]);
    assert_eq!(funny(&store), NONE);
    // ...in either stream order: the verdict is the card's, not the first row's.
    let store = store_of(&[fixture("treasure_txln_8"), fixture("treasure_sld_1432"), fixture("treasure_hho_21star")]);
    assert_eq!(funny(&store), NONE);
}

#[test]
fn a_token_born_funny_is_funny_in_every_printing() {
    // h17/4 is the Dragon's first printing, made for Sword of Dungeons & Dragons. tund/4 is a
    // black-bordered token in a token set — no funny signal on the row at all — and tust/16 is a
    // silver-bordered one the token-set clause used to keep out. Faerie Spy was born in a token
    // set, has no funny printing outside one, and stays out, as on Scryfall.
    let store = store_from(&["dragon_tund_4", "dragon_tust_16", "dragon_h17_4", "faerie_spy_tust_4"]);
    assert_eq!(funny(&store), ["h17/4", "tund/4", "tust/16"]);
    // Without the printing it was born as, a token-set Dragon is an ordinary token.
    let store = store_from(&["dragon_tund_4", "dragon_tust_16", "faerie_spy_tust_4"]);
    assert_eq!(funny(&store), NONE);
}

#[test]
fn a_printing_legal_somewhere_does_not_inherit() {
    // NEVER-LEGAL holds for the sibling as it does for the printing rule. No card in the
    // 2026-10-01 bulk has both a funny printing and one legal anywhere — legality follows the card
    // — so the shape is built from two real objects: Lightning Bolt (legal in modern, legacy, ...)
    // given Blacker Lotus's oracle id.
    let lotus = fixture("blacker_lotus_ugl_70");
    let mut bolt = fixture("lightning_bolt");
    bolt["oracle_id"] = lotus["oracle_id"].clone();
    let bolt_address = format!("{}/{}", bolt["set"].as_str().unwrap(), bolt["collector_number"].as_str().unwrap());
    let store = store_of(&[lotus, bolt]);
    assert_eq!(funny(&store), ["ugl/70"], "{bolt_address} is legal somewhere and stays out");
}

#[test]
fn a_card_in_a_token_set_does_not_inherit() {
    // The printing rule's `set_type != token` clause, kept for a card's siblings too: a card
    // printed in a token set is not funny for its Unglued printing. Nothing in the bulk has this
    // shape either (tclb/0, the one card Scryfall calls funny in a token set, has no funny
    // sibling), so it is sld/869 with its set type changed.
    let mut in_token_set = fixture("blacker_lotus_sld_869");
    in_token_set["set_type"] = json!("token");
    let store = store_of(&[fixture("blacker_lotus_ugl_70"), in_token_set]);
    assert_eq!(funny(&store), ["ugl/70"]);
}
