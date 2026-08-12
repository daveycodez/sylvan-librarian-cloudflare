// serde_json's `json!` expands recursively and this fixture is one deep literal; the default
// 128 is not enough for it once the compat residue is nested inside.
#![recursion_limit = "512"]

//! The critical-path feasibility test: build a store from handcrafted card
//! rows, load it through the buffer (no-mmap) path, and query it — the exact
//! pipeline the Cloudflare Worker runs, with no python, postgres, or mmap
//! anywhere.

use card_engine::{BufferStore, QueryOptions, StoreBuilder};
use serde_json::{json, Value};

/// A card-row JSON object carrying every key `card_from_json` (the
/// field-for-field mirror of upstream's `card_from_pydict`) reads.
#[allow(clippy::too_many_arguments)]
fn card_row(
    card_name: &str,
    oracle_id: &str,
    scryfall_id: &str,
    set_code: &str,
    set_name: &str,
    collector_number: &str,
    oracle_text: &str,
    type_line: &str,
    card_types: &[&str],
    subtypes: &[&str],
    keywords: &[&str],
    colors: &[&str],
    cmc: u32,
    mana_sym: &str,
    prefer_score: f64,
) -> Value {
    let color_obj: Value = Value::Object(
        colors.iter().map(|c| ((*c).to_owned(), json!(true))).collect(),
    );
    let keyword_obj: Value = Value::Object(
        keywords.iter().map(|k| ((*k).to_owned(), json!({}))).collect(),
    );
    json!({
        "card_name": card_name,
        "card_name_folded": card_name.to_lowercase(),
        "oracle_id": oracle_id,
        "scryfall_id": scryfall_id,
        "illustration_id": format!("{scryfall_id}-art"),
        "card_set_code": set_code,
        "set_name": set_name,
        "collector_number": collector_number,
        "collector_number_int": collector_number.parse::<u16>().ok(),
        "oracle_text": oracle_text,
        "flavor_text": "",
        "type_line": type_line,
        "card_types": card_types,
        "card_subtypes": subtypes,
        "card_keywords": keyword_obj,
        "card_colors": color_obj,
        "card_color_identity": color_obj,
        "produced_mana": {},
        "card_layout": "normal",
        "card_border": "black",
        "card_rarity_int": 0,
        "card_artist": "Test Artist",
        "released_at": "2020-01-01",
        "cmc": cmc,
        "mana_cost_text": format!("{{{mana_sym}}}"),
        "mana_cost_jsonb": { mana_sym: [1] },
        "card_legalities": {
            "commander": "legal",
            "modern": "legal",
            "vintage": "restricted"
        },
        "card_oracle_tags": {},
        "card_art_tags": {},
        "card_is_tags": {},
        "card_frame_data": {},
        "edhrec_rank": 100,
        "price_usd": 1.47,
        "prefer_score": prefer_score,
        "cubecobra_score": 0.5,
        "creature_power": null,
        "creature_toughness": null,
        "creature_power_text": null,
        "creature_toughness_text": null,
        "planeswalker_loyalty": null,
        "card_watermark": null,
        // The residue Scryfall sends that no column holds — the second archive's whole content.
        // Verbatim Scryfall keys, exactly as the importer snapshots them (see `_compat_blob`).
        "card_compat_blob": {
            "lang": "en",
            "games": ["paper"],
            "finishes": ["nonfoil"],
            "set_id": "9d739461-c5ac-43a1-af41-3d5a585b5c8d",
            "set_type": "core",
            "multiverse_ids": [12345],
            // A printed loyalty this port keeps ONLY here: the `planeswalker_loyalty` column above
            // is the integer `loy:` filters on, and "X" is why the text cannot be derived from it.
            "loyalty": "X",
        },
    })
}

fn fixture_rows() -> Vec<Value> {
    vec![
        // Two printings of the same oracle card (same oracle_id) — exercises
        // the group-by-oracle path; the higher prefer_score printing must be
        // the default-preferred one.
        card_row(
            "Test Bolt",
            "11111111-1111-1111-1111-111111111111",
            "aaaaaaaa-0000-0000-0000-000000000001",
            "tst",
            "Test Set",
            "1",
            "Test Bolt deals 3 damage to any target.",
            "Instant",
            &["Instant"],
            &[],
            &[],
            &["R"],
            1,
            "R",
            0.9,
        ),
        card_row(
            "Test Bolt",
            "11111111-1111-1111-1111-111111111111",
            "aaaaaaaa-0000-0000-0000-000000000002",
            "ts2",
            "Test Set Two",
            "42",
            "Test Bolt deals 3 damage to any target.",
            "Instant",
            &["Instant"],
            &[],
            &[],
            &["R"],
            1,
            "R",
            0.2,
        ),
        card_row(
            "Test Wurm",
            "22222222-2222-2222-2222-222222222222",
            "bbbbbbbb-0000-0000-0000-000000000001",
            "tst",
            "Test Set",
            "2",
            "Trample",
            "Creature — Wurm",
            &["Creature"],
            &["Wurm"],
            &["Trample"],
            &["G"],
            6,
            "G",
            0.7,
        ),
    ]
}

/// StoreBuilder -> archive bytes -> BufferStore -> TrueNode query.
#[test]
fn build_load_query_roundtrip() {
    let mut builder = StoreBuilder::new();
    for row in fixture_rows() {
        builder.add_card(&row).expect("add_card");
    }
    assert_eq!(builder.staged_rows(), 3);

    let mut bytes: Vec<u8> = Vec::new();
    // `None`: this test is about the SEARCH archive, which is the one /search loads.
    let stats = builder.finish_to_writer(&mut bytes, None).expect("finish_to_writer");
    assert_eq!(stats.card_count, 2, "two distinct oracle ids");
    assert_eq!(stats.printing_count, 3, "three printings staged");
    assert!(!bytes.is_empty());

    let store = BufferStore::from_bytes(&bytes).expect("buffer load");
    assert_eq!(store.card_count(), 2);
    assert_eq!(store.size(), 3, "size() reports printings");

    // The whole point: a query over the buffer store, no mmap involved.
    let out = store
        .query(r#"{"node_type": "TrueNode"}"#, &QueryOptions::default())
        .expect("TrueNode query");
    assert_eq!(out.total, 2, "card-unique TrueNode matches every oracle card");
    let mut names: Vec<&str> = out
        .rows
        .iter()
        .map(|r| r["name"].as_str().expect("name field"))
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["Test Bolt", "Test Wurm"]);

    // Default-preferred printing of Test Bolt is the higher prefer_score one.
    let bolt = out.rows.iter().find(|r| r["name"] == "Test Bolt").unwrap();
    assert_eq!(bolt["set_code"], "tst");
    assert_eq!(bolt["oracle_text"], "Test Bolt deals 3 damage to any target.");

    // Printing-unique mode sees all three printings.
    let printings = store
        .query(
            r#"{"node_type": "TrueNode"}"#,
            &QueryOptions { unique: "printing".to_owned(), ..QueryOptions::default() },
        )
        .expect("printing-unique query");
    assert_eq!(printings.total, 3);

    // Field selection: unknown fields fail loudly, valid ones project.
    let err = store
        .query(
            r#"{"node_type": "TrueNode"}"#,
            &QueryOptions { fields: Some(vec!["definitely_not_a_field".to_owned()]), ..QueryOptions::default() },
        )
        .unwrap_err();
    assert!(err.to_string().contains("unknown field"));

    let projected = store
        .query(
            r#"{"node_type": "TrueNode"}"#,
            &QueryOptions {
                fields: Some(vec!["name".to_owned(), "scryfall_id".to_owned(), "card_keywords".to_owned()]),
                ..QueryOptions::default()
            },
        )
        .expect("projected query");
    let wurm = projected.rows.iter().find(|r| r["name"] == "Test Wurm").unwrap();
    assert_eq!(wurm["scryfall_id"], "bbbbbbbb-0000-0000-0000-000000000001");
    assert_eq!(wurm["card_keywords"], json!(["Trample"]));

    // Catalog + sampling round out the Worker surface.
    let types = store.common_card_types();
    assert_eq!(types.get("Instant"), Some(&1));
    assert_eq!(types.get("Creature"), Some(&1));
    assert_eq!(types.get("Wurm"), Some(&1), "subtypes count too");
    let keywords = store.common_card_keywords();
    assert_eq!(keywords.get("Trample"), Some(&1));

    let sampled = store.sample_preferred(5, 42, None).expect("sample");
    assert_eq!(sampled.len(), 2, "clamped to the pool size");
}

/// The same pipeline through the builder crate's file-writing entry point.
#[test]
fn build_store_writes_archive_and_manifest_data() {
    let out_dir = std::env::temp_dir().join(format!(
        "sylvan-store-builder-test-{}",
        std::process::id()
    ));
    let manifest = sylvan_store_builder::build_store(
        fixture_rows().into_iter(),
        &out_dir,
        "1754000000",
    )
    .expect("build_store");

    assert_eq!(manifest.card_count, 2);
    assert_eq!(manifest.printing_count, 3);
    assert_eq!(manifest.format_version, card_engine::store_format_version());
    assert_eq!(manifest.built_at, "1754000000");
    assert!(!manifest.upstream_commit.is_empty());

    assert!(manifest.store_key.ends_with(".store"), "{}", manifest.store_key);

    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).expect("read store file");
    assert_eq!(bytes.len() as u64, manifest.store_bytes, "store_bytes must match the file");

    let store = BufferStore::from_bytes(&bytes).expect("load written store");
    assert_eq!(store.card_count(), 2);

    // A corrupted header must be rejected, not handed to access_unchecked.
    let mut bad = bytes.clone();
    bad[0] ^= 0xFF;
    assert!(BufferStore::from_bytes(&bad).is_err());

    std::fs::remove_dir_all(&out_dir).ok();
}

/// upstream #877's five result fields, proven to reach a RESPONSE and not merely to compile.
///
/// This is the test the port actually needs. `FIELD_TABLE` is pyo3-gated and not built here, so
/// #877's five entries land in dead code: the patch merges clean, `cargo check` is clean, and
/// `fields=layout` still 400s because `JSON_FIELD_TABLE` — the live table — never learned the name.
/// Nothing in the TS suite can see that either, since the route tests run against a fake engine.
/// Only a real store, queried for the real fields, distinguishes "ported" from "compiled".
#[test]
fn result_fields_reach_the_response() {
    let mut builder = StoreBuilder::new();
    for row in fixture_rows() {
        builder.add_card(&row).expect("add_card");
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut compat: Vec<u8> = Vec::new();
    builder.finish_to_writer(&mut bytes, Some(&mut compat)).expect("finish_to_writer");
    let mut store = BufferStore::from_bytes(&bytes).expect("buffer load");

    // A residue field is unreadable until the SECOND archive is attached, and that failure is a
    // clear error rather than a null — asserted here because "resolves to null" is precisely the
    // shape a broken split would take, and it is indistinguishable from a card Scryfall sent no
    // language for.
    let before = QueryOptions { fields: Some(vec!["lang".to_owned()]), ..QueryOptions::default() };
    assert!(
        store.query(r#"{"node_type": "TrueNode"}"#, &before).is_err(),
        "a residue field without the card-object archive must error, not answer null"
    );
    store.attach_compat_bytes(&compat).expect("attach the card-object archive");

    let opts = QueryOptions {
        fields: Some(vec![
            "name".to_owned(),
            "lang".to_owned(),
            "games".to_owned(),
            "layout".to_owned(),
            "cmc".to_owned(),
            "rarity".to_owned(),
            "color_identity".to_owned(),
            "legalities".to_owned(),
            "loyalty".to_owned(),
        ]),
        ..QueryOptions::default()
    };
    let out = store.query(r#"{"node_type": "TrueNode"}"#, &opts).expect("query with #877 fields");
    let card = &out.rows[0];

    // Values, not just presence: an extractor wired to the wrong source field returns null, which
    // a presence-only assertion would happily accept.
    assert_eq!(card["layout"], json!("normal"));
    // A DECIMAL, deliberately: cmc is `Option<f32>` in the engine and `Option<f64>` in the row,
    // because Scryfall types the field Decimal and {HW} makes that real (0.5). `json!(1)` and
    // `json!(1.0)` are different serde_json numbers, so this assertion is what pins which one the
    // extractor yields -- and the decimal is the one card_object.rs writes to the wire.
    assert_eq!(card["cmc"], json!(1.0), "cmc is the stored decimal, not an integer or a string");
    assert_eq!(card["rarity"], json!("common"), "rarity_int 0 decodes to the word");
    assert_eq!(card["color_identity"], json!(["R"]), "the identity bitmap decodes to WUBRG letters");
    assert_eq!(
        card["legalities"]["vintage"],
        json!("restricted"),
        "the packed legality word decodes per format — and 'restricted' proves the 2-bit code is \
         read at the right shift, since legal/not_legal would survive an off-by-one"
    );
    assert_eq!(card["legalities"]["modern"], json!("legal"));

    // The residue half, from the second archive and through the same one query.
    assert_eq!(card["lang"], json!("en"));
    assert_eq!(card["games"], json!(["paper"]), "the games bitset decodes to Scryfall's names");
    assert_eq!(
        card["loyalty"],
        json!("X"),
        "loyalty comes back as the printed string through the archive — an integer column could \
         not have carried this value at all, which is the whole reason it lives in the residue"
    );
}

/// `fields=None` must keep working. DEFAULT_FIELDS is ungated and live, so a name added there but
/// missing from JSON_FIELD_TABLE would make EVERY default search fail, not just one field.
#[test]
fn the_default_field_set_still_resolves() {
    let mut builder = StoreBuilder::new();
    for row in fixture_rows() {
        builder.add_card(&row).expect("add_card");
    }
    let mut bytes: Vec<u8> = Vec::new();
    builder.finish_to_writer(&mut bytes, None).expect("finish_to_writer");
    let store = BufferStore::from_bytes(&bytes).expect("buffer load");
    store.query(r#"{"node_type": "TrueNode"}"#, &QueryOptions::default()).expect("default fields");
}
