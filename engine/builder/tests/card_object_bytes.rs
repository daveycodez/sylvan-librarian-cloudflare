//! A built store renders api.scryfall.com's own card objects BYTE FOR BYTE (backlog x27).
//!
//! Every other card-object test in the repo holds a builder to a fixture someone wrote, or the two
//! builders to each other — and both kinds stayed green through a gap on every object this port
//! served: Scryfall's key ORDER (top level, faces, related cards, `legalities`) and nine keys
//! Scryfall sends that the store never held (`artist_ids`, each face's `artist_id`, `preview`,
//! `resource_id`, a non-shared `card_back_id`, `variation_of`, `attraction_lights`,
//! `content_warning`, plus the render-only `game_changer`, `foil`, `nonfoil`, `image_updated_at`
//! and `all_parts[].uri`). The live harnesses could not see the order at all: both sort keys.
//!
//! So the fixtures here are SCRYFALL'S OBJECTS, fetched from api.scryfall.com on 2026-09-26 and
//! changed in exactly one way — the affiliate wrapper on the tcgplayer links unwrapped, the port's
//! one documented deviation. Each goes through the whole native pipeline (transform → finalize →
//! partitioned store → engine row → `write_scryfall_card`) and must come back as the same bytes.
//! Fifteen printings chosen to reach every gap: split, transform, battle, reversible and its
//! ordinary sibling, plane, scheme (a starred collector number), vanguard, an Unfinity attraction,
//! a content-warning card, a variation, a Phyrexian printing, a game changer, a Spanish transform
//! and a 2026 printing carrying a `resource_id`.

use std::collections::HashSet;

use card_engine::BufferStore;
use serde_json::Value;
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: [&str; 15] = [
    "normal_bolt",
    "split_fire_ice",
    "transform_delver",
    "battle",
    "reversible",
    "reversible_sibling",
    "planar",
    "scheme",
    "vanguard",
    "attraction",
    "content_warning",
    "variation_of",
    "ph_glyph",
    "game_changer",
    "es_transform_mom_230",
];

/// The fields the port's `CARD_OBJECT_FIELDS` asks the engine for (src/routes/scryfall-compat/objects.ts).
const CARD_OBJECT_FIELDS: &[&str] = &[
    "name", "scryfall_id", "oracle_id", "layout", "mana_cost", "cmc", "type_line", "oracle_text", "printed_name",
    "printed_type_line", "printed_text", "flavor_name", "life_modifier", "hand_modifier", "power", "toughness",
    "loyalty", "colors", "color_identity", "card_keywords", "set_code", "set_name", "collector_number", "rarity",
    "flavor_text", "artist", "illustration_id", "released_at", "legalities", "edhrec_rank", "price_usd",
    "price_eur", "price_tix", "watermark", "card_frame_data", "card_is_tags", "border_color", "frame", "lang",
    "image_status", "set_type", "security_stamp", "set_id", "arena_id", "mtgo_id", "mtgo_foil_id", "tcgplayer_id",
    "tcgplayer_etched_id", "cardmarket_id", "penny_rank", "image_updated_at", "price_usd_foil", "price_usd_etched",
    "price_eur_foil", "multiverse_ids", "promo_types", "frame_effects", "games", "finishes", "booster", "digital",
    "foil", "nonfoil", "full_art", "highres_image", "oversized", "promo", "reprint", "story_spotlight", "textless",
    "variation", "card_faces", "all_parts", "produced_mana", "color_indicator", "artist_ids", "resource_id",
    "variation_of", "attraction_lights", "card_back_id", "preview", "content_warning",
];

fn fixture_text(name: &str) -> String {
    let path = format!("{}/tests/fixtures/scryfall_card_objects/{name}.json", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path).unwrap().trim_end().to_owned()
}

#[test]
fn a_built_store_renders_scryfalls_card_objects_byte_for_byte() {
    let texts: Vec<String> = FIXTURES.iter().map(|n| fixture_text(n)).collect();
    let cards: Vec<Value> = texts.iter().map(|t| serde_json::from_str(t).unwrap()).collect();
    // Scryfall's representative printing per card, which is what decides the card's own faces and
    // name against a reversible printing's (`OracleCard::divergent`) — the reversible one never is.
    let labels: HashSet<String> = cards
        .iter()
        .filter(|c| c["layout"] != "reversible_card")
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    let drafts = cards.iter().map(|c| transform_row(c, true).unwrap().expect("not filtered")).collect();
    let mut tags = TagData::default();
    tags.labels = labels;
    let rows: Vec<Value> = finalize(drafts, &tags).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-card-object-bytes-{}", std::process::id()));
    let manifest = sylvan_store_builder::build_store_partitioned(
        rows.into_iter(),
        &out_dir,
        "1754000000",
        sylvan_store_builder::PartitionsArg::Fixed(1),
    )
    .expect("build");
    let key = manifest["partitions"][0]["store_key"].as_str().unwrap().to_owned();
    let store = BufferStore::from_bytes(&std::fs::read(out_dir.join(key)).unwrap()).expect("loads");
    std::fs::remove_dir_all(&out_dir).ok();

    let fields: Vec<String> = CARD_OBJECT_FIELDS.iter().map(|s| (*s).to_owned()).collect();
    let mut failures = Vec::new();
    for ((name, text), card) in FIXTURES.iter().zip(&texts).zip(&cards) {
        let id = card["id"].as_str().unwrap();
        let Some(Value::Object(row)) = store.card_by_scryfall_id(id, Some(fields.clone())).expect("lookup") else {
            failures.push(format!("{name}: {id} is not in the store"));
            continue;
        };
        let mut out = Vec::new();
        card_engine::card_object::write_scryfall_card(&mut out, &row, "https://api.scryfall.com");
        let ours = String::from_utf8(out).unwrap();
        if ours != *text {
            let at = ours.bytes().zip(text.bytes()).take_while(|(a, b)| a == b).count();
            let window = |s: &str| s.get(at.saturating_sub(60)..(at + 60).min(s.len())).unwrap_or("").to_owned();
            failures.push(format!("{name}: first difference at byte {at}\n  scryfall …{}…\n  ours     …{}…", window(text), window(&ours)));
        }
    }
    assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), FIXTURES.len(), failures.join("\n"));
}
