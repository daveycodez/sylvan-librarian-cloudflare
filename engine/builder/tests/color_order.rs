//! `order=color` IN SCRYFALL'S ORDER — through the whole native pipeline: Scryfall JSON → transform
//! → finalize → store → query → card objects.
//!
//! Eighteen real card objects, api.scryfall.com 2026-10-08, one of every shape the order treats
//! differently, and the sequence asserted is Scryfall's own for them in both directions (asked as
//! eighteen exact names under `order=color`; the answer also held two `prepare` cards whose back
//! face is one of the names, which are not in this pool):
//!
//! ```text
//! Emeria's Call           W front, land back          a white card, not a land
//! Swords to Plowshares    W
//! Search for Azcanta      U front, land back
//! Valki, God of Lies      B front, B-R back           black, not black-red
//! Lightning Bolt          R
//! Grizzly Bears           G
//! Arlinn Kord             R-G                         the pairs in the game's own order:
//! Fire // Ice             U-R                           RG before UR before RW
//! Boros Charm             R-W
//! Nicol Bolas, the Ravager   U-B-R
//! Transguild Courier      W-U-B-R-G
//! Eldrazi Skyspawner      colourless, identity U      colourless cards by identity
//! Sol Ring                colourless
//! Westvale Abbey          land front, identity B      lands last, by identity
//! Dryad Arbor             a GREEN land
//! Forest                  identity G
//! Hengegate Pathway       identity W-U
//! Wastes                  no identity
//! ```
//!
//! `dir=desc` reverses the blocks and leaves the names inside one ascending: Dryad Arbor before
//! Forest in both.

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "wastes_eoc_191",
    "sol_ring_frc_21",
    "hengegate_pathway_khm_260",
    "forest_trk_325",
    "dryad_arbor_dsc_273",
    "westvale_abbey_inr_287",
    "eldrazi_skyspawner_bfz_58",
    "transguild_courier_dmc_194",
    "nicol_bolas_the_ravager_m19_218",
    "boros_charm_fdn_721",
    "fire_dmr_215",
    "arlinn_kord_inr_230",
    "grizzly_bears_10e_268",
    "lightning_bolt_msc_806",
    "valki_god_of_lies_khm_114",
    "search_for_azcanta_xln_74",
    "swords_to_plowshares_frc_37",
    "emerias_call_znr_12",
];

const ASCENDING: [&str; 18] = [
    "Emeria's Call // Emeria, Shattered Skyclave",
    "Swords to Plowshares",
    "Search for Azcanta // Azcanta, the Sunken Ruin",
    "Valki, God of Lies // Tibalt, Cosmic Impostor",
    "Lightning Bolt",
    "Grizzly Bears",
    "Arlinn Kord // Arlinn, Embraced by the Moon",
    "Fire // Ice",
    "Boros Charm",
    "Nicol Bolas, the Ravager // Nicol Bolas, the Arisen",
    "Transguild Courier",
    "Eldrazi Skyspawner",
    "Sol Ring",
    "Westvale Abbey // Ormendahl, Profane Prince",
    "Dryad Arbor",
    "Forest",
    "Hengegate Pathway // Mistgate Pathway",
    "Wastes",
];

const DESCENDING: [&str; 18] = [
    "Wastes",
    "Hengegate Pathway // Mistgate Pathway",
    "Dryad Arbor",
    "Forest",
    "Westvale Abbey // Ormendahl, Profane Prince",
    "Sol Ring",
    "Eldrazi Skyspawner",
    "Transguild Courier",
    "Nicol Bolas, the Ravager // Nicol Bolas, the Arisen",
    "Boros Charm",
    "Fire // Ice",
    "Arlinn Kord // Arlinn, Embraced by the Moon",
    "Grizzly Bears",
    "Lightning Bolt",
    "Valki, God of Lies // Tibalt, Cosmic Impostor",
    "Search for Azcanta // Azcanta, the Sunken Ruin",
    "Emeria's Call // Emeria, Shattered Skyclave",
    "Swords to Plowshares",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-color-order-{}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn names(store: &BufferStore, direction: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: "card".to_owned(),
        orderby: "color".to_owned(),
        direction: direction.to_owned(),
        fields: Some(["scryfall_id", "name"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(&json!({"node_type": "TrueNode"}), &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    serde_json::from_str::<Vec<Value>>(body).unwrap().iter().map(|c| c["name"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn colours_order_as_the_game_prints_them_by_the_front_face_with_lands_last_by_identity() {
    let store = store();
    assert_eq!(names(&store, "asc"), ASCENDING);
    assert_eq!(names(&store, "desc"), DESCENDING);
}
