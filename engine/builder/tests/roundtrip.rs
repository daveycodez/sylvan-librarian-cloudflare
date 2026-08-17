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
    // DISTINCT FROM `colors` ON EVERY ROW, and that is the point. Both keys used to be handed the
    // SAME object, which made `card_colors` and `card_color_identity` indistinguishable in this
    // fixture — so `result_fields_reach_the_response`, whose stated job is catching an extractor
    // wired to the wrong source field, could not catch that particular wrong field. An identity
    // wider than the cost is also the real shape (a mana ability or an activated cost in the rules
    // text), so this is the fixture becoming more like a card, not less.
    color_identity: &[&str],
    cmc: u32,
    mana_sym: &str,
    prefer_score: f64,
) -> Value {
    let color_obj: Value = Value::Object(
        colors.iter().map(|c| ((*c).to_owned(), json!(true))).collect(),
    );
    let identity_obj: Value = Value::Object(
        color_identity.iter().map(|c| ((*c).to_owned(), json!(true))).collect(),
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
        "card_color_identity": identity_obj,
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
        // The PRINTED loyalty, as upstream's own column: the integer above is what `loy:` filters
        // on, and "X" is why the text cannot be derived from it.
        "planeswalker_loyalty_text": "X",
        "card_watermark": null,
        // The residue Scryfall sends that no column holds — packed onto the printing.
        // Verbatim Scryfall keys, exactly as the importer snapshots them (see `_compat_blob`).
        "card_compat_blob": {
            "lang": "en",
            "games": ["paper"],
            "finishes": ["nonfoil"],
            "set_id": "9d739461-c5ac-43a1-af41-3d5a585b5c8d",
            "set_type": "core",
            "multiverse_ids": [12345],
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
            &["R", "G"],
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
            &["R", "G"],
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
            &["G", "U"],
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
    let stats = builder.finish_to_writer(&mut bytes).expect("finish_to_writer");
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

/// The partitioned build: N archives cut by the shared hash, each loadable, plus a manifest-v2
/// skeleton in exactly the shape src/engine/types.ts declares — `partition_count` present is the
/// version discriminant, the top-level counts are TOTALS, and `partitions[k]` names the
/// `-p<k>`-suffixed chunk family.
#[test]
fn build_store_partitioned_cuts_by_the_shared_hash() {
    let out_dir = std::env::temp_dir().join(format!("sylvan-store-builder-parts-{}", std::process::id()));
    let manifest = sylvan_store_builder::build_store_partitioned(
        fixture_rows().into_iter(),
        &out_dir,
        "1754000000",
        sylvan_store_builder::PartitionsArg::Fixed(3),
    )
    .expect("partitioned build");

    assert_eq!(manifest["partition_count"], serde_json::json!(3));
    assert_eq!(manifest["partition_hash"], serde_json::json!("fnv1a64/oracle_id/v1"));
    assert_eq!(manifest["built_at"], serde_json::json!("1754000000"));
    assert_eq!(manifest["format_version"], serde_json::json!(card_engine::store_format_version()));
    // The family stem carries no partition suffix; each partition's key does.
    let stem = manifest["store_key"].as_str().expect("store_key");
    assert!(stem.ends_with(".store") && !stem.contains("-p"), "{stem}");

    let partitions = manifest["partitions"].as_array().expect("partitions");
    assert_eq!(partitions.len(), 3);
    let (mut cards, mut printings, mut bytes_total) = (0u64, 0u64, 0u64);
    for (k, p) in partitions.iter().enumerate() {
        let key = p["store_key"].as_str().expect("partition store_key");
        assert!(key.contains(&format!("-p{k}.store")), "{key}");
        let bytes = std::fs::read(out_dir.join(key)).expect("read partition file");
        assert_eq!(bytes.len() as u64, p["store_bytes"].as_u64().unwrap());
        let store = BufferStore::from_bytes(&bytes).expect("partition loads");
        assert_eq!(store.card_count() as u64, p["card_count"].as_u64().unwrap());
        cards += p["card_count"].as_u64().unwrap();
        printings += p["printing_count"].as_u64().unwrap();
        bytes_total += p["store_bytes"].as_u64().unwrap();
        // Every card in this partition hashes HERE — the cut is the shared function, not luck.
        let rows = store
            .query_value(
                &serde_json::json!({ "node_type": "TrueNode" }),
                &card_engine::QueryOptions {
                    fields: Some(vec!["oracle_id".to_owned()]),
                    ..card_engine::QueryOptions::default()
                },
            )
            .expect("partition queries");
        for row in rows.rows {
            let oracle = row["oracle_id"].as_str().expect("oracle_id");
            assert_eq!(card_engine::partition_of_oracle_id(oracle, 3), k as u32, "{oracle} in p{k}");
        }
    }
    // Top-level counts are the totals over the cut — nothing dropped, nothing doubled.
    assert_eq!(manifest["card_count"].as_u64().unwrap(), cards);
    assert_eq!(manifest["printing_count"].as_u64().unwrap(), printings);
    assert_eq!(manifest["printing_count"], serde_json::json!(3));
    assert_eq!(manifest["store_bytes"].as_u64().unwrap(), bytes_total);

    // Auto on a tiny corpus clamps to the floor of 2 — the partitioned code paths stay exercised.
    let manifest = sylvan_store_builder::build_store_partitioned(
        fixture_rows().into_iter(),
        &out_dir,
        "1754000001",
        sylvan_store_builder::PartitionsArg::Auto,
    )
    .expect("auto build");
    assert_eq!(manifest["partition_count"], serde_json::json!(2));

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
    builder.finish_to_writer(&mut bytes).expect("finish_to_writer");
    let store = BufferStore::from_bytes(&bytes).expect("buffer load");

    let opts = QueryOptions {
        fields: Some(vec![
            "name".to_owned(),
            "lang".to_owned(),
            "games".to_owned(),
            "layout".to_owned(),
            "cmc".to_owned(),
            "rarity".to_owned(),
            "colors".to_owned(),
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
    // BOTH colour fields, and they DISAGREE on this row ({R} cost, {R}{G} identity). Asserting one
    // of them against a fixture where the two were the same object proved only that some colour
    // bitmap decodes to letters; each extractor now has to be reading its own source field, and
    // swapping the two fails in both directions.
    assert_eq!(card["colors"], json!(["R"]), "the colors bitmap decodes to letters");
    assert_eq!(
        card["color_identity"],
        // ALPHABETICAL, which is what `identity_letters` emits (B, C, G, R, U, W) — and what
        // Scryfall's JSON emits too. MEASURED 2026-08-17 against api.scryfall.com, because no
        // fixture here had a multi-colour identity and so nothing had ever had an opinion:
        //   Burning-Tree Emissary  colors ["G","R"]            identity ["G","R"]
        //   Niv-Mizzet, Parun      colors ["R","U"]            identity ["R","U"]
        //   Sliver Queen           colors ["B","G","R","U","W"] identity ["B","G","R","U","W"]
        //   Golgari Signet         colors []                   identity ["B","G"]
        // The port answers identically on all four. WUBRG is a card-frame and mana-cost
        // convention; it does not reach these arrays, so sorting them into WUBRG would break
        // every multi-colour card we serve.
        json!(["G", "R"]),
        "the IDENTITY bitmap, which is wider than the cost here — an extractor reading card_colors \
         would answer [\"R\"]"
    );
    assert_eq!(
        card["legalities"]["vintage"],
        json!("restricted"),
        "the packed legality word decodes per format — and 'restricted' proves the 2-bit code is \
         read at the right shift, since legal/not_legal would survive an off-by-one"
    );
    assert_eq!(card["legalities"]["modern"], json!("legal"));

    // The residue fields, off the same printing and through the same one query — one archive.
    assert_eq!(card["lang"], json!("en"));
    assert_eq!(card["games"], json!(["paper"]), "the games bitset decodes to Scryfall's names");
    assert_eq!(
        card["loyalty"],
        json!("X"),
        "loyalty comes back as the printed string through the archive — the integer column \
         `loy:` filters on could not have carried this value at all"
    );
}

/// Two residue values Scryfall sends as STRINGS, through the readers, the archive, and the card
/// object writer.
///
/// Both were read by number-only readers and so were absent on every card in the corpus:
/// `prices` members are decimal strings ("60.00"), which made `usd_foil`/`usd_etched`/`eur_foil`
/// null everywhere, and `image_updated_at` is an ISO-8601 timestamp, which stripped the
/// `?<epoch>` cache-buster off every image URL. The values here are the real shapes — the
/// timestamp and its epoch are the pair the lightning_bolt fixture carries.
#[test]
fn string_shaped_residue_values_survive_ingest() {
    let mut row = fixture_rows().remove(0);
    let blob = row["card_compat_blob"].as_object_mut().expect("compat residue is an object");
    blob.insert(
        "prices".to_owned(),
        json!({"usd": "1.47", "usd_foil": "60.00", "usd_etched": "0.10", "eur": "1.20", "eur_foil": "44.44", "tix": "0.03"}),
    );
    blob.insert("image_updated_at".to_owned(), json!("2026-07-13T00:36:48Z"));

    let mut builder = StoreBuilder::new();
    builder.add_card(&row).expect("add_card");
    let mut bytes: Vec<u8> = Vec::new();
    builder.finish_to_writer(&mut bytes).expect("finish_to_writer");
    let store = BufferStore::from_bytes(&bytes).expect("buffer load");

    let card = store
        .card_by_scryfall_id(
            "aaaaaaaa-0000-0000-0000-000000000001",
            Some(
                ["name", "scryfall_id", "layout", "image_updated_at", "price_usd", "price_usd_foil", "price_usd_etched", "price_eur", "price_eur_foil", "price_tix"]
                    .iter()
                    .map(|f| (*f).to_owned())
                    .collect(),
            ),
        )
        .expect("lookup")
        .expect("the card is in the store");

    // Cents, from a decimal string. 60.00 -> 6000 also pins the rounding: a truncating parse of
    // the string would land 5999 on any price whose f64 sits a hair low.
    assert_eq!(card["price_usd_foil"], json!(60.0), "prices.usd_foil arrives as a string");
    assert_eq!(card["price_usd_etched"], json!(0.1));
    assert_eq!(card["price_eur_foil"], json!(44.44));
    assert_eq!(card["image_updated_at"], json!(1_783_903_008u32), "the ISO timestamp parses to epoch seconds");

    // And on the wire, which is the surface that was wrong: the three foil prices carry values
    // and every image URL carries Scryfall's cache-buster query.
    let mut out: Vec<u8> = Vec::new();
    card_engine::card_object::write_scryfall_card(&mut out, card.as_object().expect("row"), "https://example.test");
    let object: Value = serde_json::from_slice(&out).expect("card object parses");
    assert_eq!(object["prices"]["usd_foil"], json!("60.00"));
    assert_eq!(object["prices"]["usd_etched"], json!("0.10"));
    assert_eq!(object["prices"]["eur_foil"], json!("44.44"));
    for (size, uri) in object["image_uris"].as_object().expect("image_uris") {
        assert!(
            uri.as_str().expect("uri").ends_with("?1783903008"),
            "image_uris.{size} lost the cache-buster: {uri}"
        );
    }
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
    builder.finish_to_writer(&mut bytes).expect("finish_to_writer");
    let store = BufferStore::from_bytes(&bytes).expect("buffer load");
    store.query(r#"{"node_type": "TrueNode"}"#, &QueryOptions::default()).expect("default fields");
}
