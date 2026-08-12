//! `legalities` must decode on a store that has NEVER run a filter query.
//!
//! Its own test binary, and deliberately only ONE test in it. The format→shift registry
//! (`FORMAT_SHIFTS`) is a process-global, and every filter query populates it as a side effect, so
//! a case like this sharing a binary with any query test is vacuous the moment the other test runs
//! first — which is exactly the condition that hid the bug in production.
//!
//! What it guards: `legality_bits_to_json` reports an EMPTY object against an unpopulated
//! registry rather than failing. Until `from_aligned` adopted the archive's shifts at load, the
//! only thing that populated them was `bind_and_split_filter_value`, on the filter path. So every
//! route that resolves a card WITHOUT filtering — `/cards/named`, `/cards/:id`,
//! `/cards/collection` — answered `"legalities": {}` on any isolate that had not yet served a
//! search, and `/cards/*` responses are cached for 16 hours, which pinned the empty object for
//! whichever card happened to land on a cold isolate.

// The fixture below is one big `json!`, same as roundtrip.rs's, and serde_json expands a literal
// that size past the default 128.
#![recursion_limit = "256"]

use card_engine::{BufferStore, StoreBuilder};
use serde_json::{json, Value};

fn card_row() -> Value {
    json!({
        "card_name": "Test Walker",
        "card_name_folded": "test walker",
        "oracle_id": "11111111-1111-1111-1111-111111111111",
        "scryfall_id": "aaaaaaaa-0000-0000-0000-000000000001",
        "illustration_id": "aaaaaaaa-0000-0000-0000-000000000001-art",
        "card_set_code": "tst",
        "set_name": "Test Set",
        "collector_number": "1",
        "collector_number_int": 1,
        "oracle_text": "+1: Draw a card.",
        "flavor_text": "",
        "type_line": "Legendary Planeswalker — Test",
        "card_types": ["Planeswalker"],
        "card_subtypes": ["Test"],
        "card_keywords": {},
        "card_colors": {"U": true},
        "card_color_identity": {"U": true},
        "produced_mana": {},
        "card_layout": "normal",
        "card_border": "black",
        "card_rarity_int": 0,
        "card_artist": "Test Artist",
        "released_at": "2020-01-01",
        "cmc": 3,
        "mana_cost_text": "{1}{U}{U}",
        "mana_cost_jsonb": {"U": [2]},
        // The three statuses that are NOT the not_legal default, so a decode that silently
        // produced the default for everything could not pass either.
        "card_legalities": {
            "commander": "legal",
            "modern": "banned",
            "vintage": "restricted"
        },
        "card_oracle_tags": {},
        "card_art_tags": {},
        "card_is_tags": {},
        "card_frame_data": {},
        "edhrec_rank": 100,
        "price_usd": 1.47,
        "prefer_score": 1.0,
        "cubecobra_score": 0.5,
        "creature_power": null,
        "creature_toughness": null,
        "creature_power_text": null,
        "creature_toughness_text": null,
        "planeswalker_loyalty": 3,
        "card_watermark": null,
        "card_compat_blob": {
            "lang": "en",
            "games": ["paper"],
            "finishes": ["nonfoil"],
            "set_id": "9d739461-c5ac-43a1-af41-3d5a585b5c8d",
            "set_type": "core",
            "multiverse_ids": [12345],
            "loyalty": "3",
        },
    })
}

#[test]
fn a_card_object_carries_its_legalities_before_any_query_runs() {
    let mut builder = StoreBuilder::new();
    builder.add_card(&card_row()).expect("add_card");
    let mut bytes: Vec<u8> = Vec::new();
    let mut compat: Vec<u8> = Vec::new();
    builder.finish_to_writer(&mut bytes, Some(&mut compat)).expect("finish_to_writer");

    // Load and attach ONLY. No `query()` anywhere in this binary, so the registry is whatever
    // loading the archive made it -- which is the whole point.
    let mut store = BufferStore::from_bytes(&bytes).expect("buffer load");
    store.attach_compat_bytes(&compat).expect("attach the card-object archive");

    let card = store
        .card_by_scryfall_id("aaaaaaaa-0000-0000-0000-000000000001", Some(vec!["name".to_owned(), "legalities".to_owned()]))
        .expect("lookup")
        .expect("the card is in the store");

    let legalities = card["legalities"].as_object().expect("legalities is an object");
    assert!(
        !legalities.is_empty(),
        "legalities decoded to {{}} without a filter query having populated FORMAT_SHIFTS -- \
         the exact shape /cards/named served from a cold isolate"
    );

    // Values, not just presence: an empty registry gives {}, but a registry populated with the
    // wrong shifts would give a full object of wrong answers, which presence alone accepts.
    assert_eq!(card["legalities"]["commander"], json!("legal"));
    assert_eq!(card["legalities"]["modern"], json!("banned"));
    assert_eq!(card["legalities"]["vintage"], json!("restricted"));
}
