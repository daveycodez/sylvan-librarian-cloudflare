//! Who can lead a deck, what is cast, and which Arena duplicates are extras — through the whole
//! native pipeline: Scryfall JSON → transform → finalize → store → query. Real card JSON from the
//! 2026-08-16 bulk, one printing per shape the old rewrites got wrong, each answer pinned against
//! api.scryfall.com (2026-09-26):
//!
//!   - meld RESULTS are no commander (Brisela, inr/14b; Ragnarok, fin/99b — whose `all_parts`
//!     names a sibling printing's ids, not its own), meld PARTS are (Gisela, inr/24; Vanille,
//!     fin/211, the same sibling-id shape);
//!   - a FLIP card's flipped legend is no commander (Budoka Pupil // Ichiga) and a legendary front
//!     is (Homura); a TRANSFORM card's legendary back is not (Westvale Abbey // Ormendahl);
//!   - Grist, the Hunger Tide is: a creature everywhere but the battlefield;
//!   - Vehicles and Backgrounds lead Commander and Brawl decks, not Duel Commander ones (Heart of
//!     Kiran, Acolyte of Bahamut); duel's `restricted` is its "banned as commander" (Derevi);
//!   - brawl takes a legendary planeswalker (Davriel, Soul Broker) and refuses `competitivebrawl`
//!     bans (Tajic, Legion's Valor);
//!   - `is:oathbreaker` reads the front face (Kytheon's and Valki's planeswalkers are backs);
//!   - `is:spell` refuses Attractions and artifact lands and keeps a modal spell // land, a
//!     pre-Sixth-Edition `Summon Jaguar` and a meld result;
//!   - Arena's conjured duplicates (ydmu/35 Black Lotus, hbg/911 Ruin Crab) are extras, a served
//!     y-set reprint (yeoe/31 Clifftop Retreat) is not.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "brisela_inr_14b",
    "ragnarok_fin_99b",
    "gisela_inr_24",
    "vanille_fin_211",
    "budoka_pupil_bok_122",
    "homura_sok_103",
    "westvale_abbey_inr_287",
    "kytheon_ori_23",
    "valki_khm_114",
    "grist_dsc_220",
    "heart_of_kiran_aer_153",
    "acolyte_of_bahamut_clb_212",
    "derevi_c13_186",
    "tajic_legions_valor_ymkm_28",
    "davriel_soul_broker_j21_15",
    "ferris_wheel_unf_210",
    "seat_of_the_synod_mrd_283",
    "agadeems_awakening_znr_90",
    "aswan_jaguar_past_1",
    "black_lotus_ydmu_35",
    "ruin_crab_hbg_911",
    "clifftop_retreat_yeoe_31",
    "lightning_bolt",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    // One directory per CALL, not per process: the two tests below run on parallel threads of one
    // process, and a shared directory let one test delete the store file the other was reading.
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-role-classes-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// `is:<tag>`, as the parser emits it for a stored tag.
fn is(tag: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_is_tags", "original_attribute": "is"}},
            "op": ":",
            "rhs": [tag],
        },
    })
}

/// Every printing a tree matches, as sorted `set/number` addresses.
fn addresses(store: &BufferStore, tree: &Value) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
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

fn sorted(v: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = v.iter().map(|s| (*s).to_owned()).collect();
    v.sort();
    v
}

#[test]
fn each_role_class_answers_the_printings_scryfall_does() {
    let store = store();
    let cases: &[(&str, &[&str])] = &[
        // Not Brisela/Ragnarok (meld results), Budoka Pupil (flipped legend), Westvale Abbey
        // (legendary back), Davriel (a planeswalker), Ferris Wheel, Seat, Agadeem, the Arena
        // duplicates, Lightning Bolt, Aswan Jaguar. Tajic is `not_legal` in Commander, not banned,
        // and Arena's legends count there (Candela, yeoe/1, is one on Scryfall).
        (
            "commander",
            &[
                "aer/153", "c13/186", "clb/212", "dsc/220", "fin/211", "inr/24", "khm/114", "ori/23", "sok/103",
                "ymkm/28",
            ],
        ),
        // Commander's shapes plus a legendary planeswalker, `legal` in brawl and not banned in
        // competitive brawl: Davriel in, Tajic out (banned there), and Homura and Acolyte of
        // Bahamut out because neither is on Arena (`brawl: not_legal`).
        ("brawler", &["aer/153", "c13/186", "dsc/220", "fin/211", "inr/24", "j21/15", "khm/114", "ori/23"]),
        // Creatures, Grist, and "can be your commander" only: no Vehicle, no Background, and not
        // Derevi, whose duel legality is `restricted`.
        ("duelcommander", &["dsc/220", "fin/211", "inr/24", "khm/114", "ori/23", "sok/103"]),
        // A planeswalker FRONT that is oathbreaker-legal: Grist. Kytheon's and Valki's walkers are
        // backs, and Davriel is Arena-only (`oathbreaker: not_legal`).
        ("oathbreaker", &["dsc/220"]),
    ];
    for (tag, want) in cases {
        assert_eq!(addresses(&store, &is(tag)), sorted(want), "is:{tag}");
    }

    // Castable: everything but the Attraction, the artifact land, Westvale Abbey's land front
    // and Clifftop Retreat. The meld result and the Summon card are spells on Scryfall.
    let spells = addresses(&store, &is("spell"));
    for kept in ["inr/14b", "fin/99b", "past/1", "znr/90", "bok/122", "ydmu/35", "hbg/911"] {
        assert!(spells.contains(&kept.to_owned()), "{kept} should be is:spell");
    }
    for refused in ["unf/210", "mrd/283", "inr/287", "yeoe/31"] {
        assert!(!spells.contains(&refused.to_owned()), "{refused} should not be is:spell");
    }

    // The meld roles, including the two printings whose `all_parts` names a sibling's ids.
    assert_eq!(addresses(&store, &is("meldresult")), sorted(&["fin/99b", "inr/14b"]));
    assert_eq!(addresses(&store, &is("meldpart")), sorted(&["fin/211", "inr/24"]));
}

#[test]
fn arena_conjured_duplicates_are_extras_and_a_served_reprint_is_not() {
    let store = store();
    let extras = addresses(&store, &is("extra"));
    assert!(extras.contains(&"ydmu/35".to_owned()), "ydmu/35 Black Lotus is extra on Scryfall");
    assert!(extras.contains(&"hbg/911".to_owned()), "hbg/911 Ruin Crab is extra on Scryfall");
    assert!(!extras.contains(&"yeoe/31".to_owned()), "yeoe/31 Clifftop Retreat is served on Scryfall");
    // And the gate's other side: Tajic (ymkm/28) and Davriel (j21/15) are digital and served.
    assert!(!extras.contains(&"ymkm/28".to_owned()));
    assert!(!extras.contains(&"j21/15".to_owned()));
}
