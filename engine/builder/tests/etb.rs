//! Scryfall's ETB controls through the production transform, store and query engine.
//! The fixture contains the exact TypeScript parser trees, pinned by scryfall-etb.test.ts.
//! No network or result-count snapshots: assert the measured cards by name, in both
//! polarities and Boolean groups, including reminder-only and second-face entry text.

use card_engine::{BufferStore, QueryOptions};
use serde_json::Value;
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

#[test]
fn etb_matches_scryfalls_measured_controls_through_the_store() {
    let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/etb-controls.json")).unwrap();
    let cards = fixture["cards"].as_array().unwrap();
    let drafts = cards.iter().map(|c| transform_row(&c["card"], true).unwrap().unwrap()).collect();
    // The draw membership was collected separately via `fo:enters otag:draw`, so
    // Bowmasters must fail because of the tag, while its entry trigger still matches ETB.
    let draw = cards.iter().filter(|c| c["draw"] == true)
        .map(|c| (c["card"]["oracle_id"].as_str().unwrap().to_owned(), vec!["draw".to_owned()]))
        .collect();
    let tags = TagData::from_slug_maps(draw, Default::default());
    let rows: Vec<Value> = finalize(drafts, &tags).collect();
    let out = std::env::temp_dir().join(format!("sylvan-etb-controls-{}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out, "etb-controls").expect("build");
    let bytes = std::fs::read(out.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out).unwrap();
    let store = BufferStore::from_bytes(&bytes).expect("load");
    let opts = QueryOptions {
        orderby: "name".to_owned(),
        limit: cards.len(),
        ..QueryOptions::default()
    };
    for case in fixture["queries"].as_array().unwrap() {
        let bytes = store.scryfall_search_bytes(&case["tree"], &opts, "https://sylvan.example").expect("query");
        let (_, body) = std::str::from_utf8(&bytes).unwrap().split_once('\n').unwrap();
        let cards: Vec<Value> = serde_json::from_str(body).unwrap();
        let mut names: Vec<&str> = cards.iter().map(|c| c["name"].as_str().unwrap()).collect();
        names.sort_unstable();
        let expected: Vec<&str> = case["expected"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
        assert_eq!(names, expected, "{}", case["q"]);
    }
}
