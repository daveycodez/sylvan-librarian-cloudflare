//! Where a `/cards/*` card object's CPU actually goes, phase by phase, over the real store.
//!
//! Production measurement (Cloudflare port, SearchEngine Durable Object, 2026-08-11) put
//! `scryfallSearch` at roughly `1.9ms + 92us per card` -- 18ms for a 175-card page, against 3ms
//! for the same 175 cards served as flat `/search` rows with 20 fields. So a card object costs
//! ~15x a row, and the cost is per-card, not fixed.
//!
//! What production CANNOT say is which half: the Rust side building 66 fields into a
//! `serde_json::Value` tree, or the JS side parsing that tree, rebuilding it as Scryfall card
//! objects and re-encoding it. Measuring the JS half locally put it near 3.4us/card, which scales
//! to maybe 15-25us in the DO -- around a fifth. This module measures the Rust half directly, so
//! the remaining ~70us/card is attributed rather than inferred.
//!
//!     cargo test --release bench_card_object_build -- --ignored --nocapture
//!
//! Needs a real store and its compat archive. Unlike the other bench modules here, it takes them
//! from this port's `store-build/` (whatever the newest pair is), because the residue archive only
//! exists in this deployment -- upstream keeps the same fields in Postgres.

use std::hint::black_box;
use std::time::Instant;

use serde_json::Value;

use super::core_api::{BufferStore, QueryOptions};

const ITERS: usize = 30;
const PAGE: usize = 175;

/// Every field a card object needs -- CARD_OBJECT_FIELDS from the port's
/// routes/scryfall-compat/objects.ts, which is what `scryfallSearch` passes on every request.
const CARD_OBJECT_FIELDS: &[&str] = &[
    "name", "scryfall_id", "oracle_id", "layout", "mana_cost", "cmc", "type_line", "oracle_text", "power",
    "toughness", "colors", "color_identity", "card_keywords", "set_code", "set_name", "collector_number", "rarity",
    "flavor_text", "artist", "illustration_id", "released_at", "legalities", "edhrec_rank", "price_usd",
    "price_eur", "price_tix", "watermark", "card_frame_data", "card_is_tags", "border_color", "frame", "lang",
    "image_status", "set_type", "security_stamp", "set_id", "arena_id", "mtgo_id", "mtgo_foil_id", "tcgplayer_id",
    "tcgplayer_etched_id", "cardmarket_id", "penny_rank", "image_updated_at", "price_usd_foil", "price_usd_etched",
    "price_eur_foil", "multiverse_ids", "promo_types", "frame_effects", "games", "finishes", "booster", "digital",
    "foil", "nonfoil", "full_art", "highres_image", "oversized", "promo", "reprint", "story_spotlight", "textless",
    "variation", "card_faces", "all_parts",
];

fn newest(prefix: &str) -> Option<std::path::PathBuf> {
    let dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../store-build"));
    let mut hits: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(prefix) && n.ends_with(".store")))
        .collect();
    hits.sort();
    hits.pop()
}

fn load() -> Option<BufferStore> {
    let store_path = newest("card-store-")?;
    let store_bytes = std::fs::read(&store_path).ok()?;
    let store = match BufferStore::from_bytes(&store_bytes) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("SKIP: {} rejected ({e}) -- stale archive for this build", store_path.display());
            return None;
        }
    };
    println!("store   {}\n", store_path.display());
    Some(store)
}

fn opts(fields: &[&str], limit: usize) -> QueryOptions {
    QueryOptions {
        orderby: "name".to_owned(),
        direction: "asc".to_owned(),
        limit,
        fields: Some(fields.iter().map(|s| (*s).to_owned()).collect()),
        ..QueryOptions::default()
    }
}

/// Best-of, like the other bench modules here: the minimum is the run least disturbed by the OS.
fn best_ms(mut kernel: impl FnMut() -> usize) -> f64 {
    let mut best = f64::MAX;
    for _ in 0..ITERS {
        let started = Instant::now();
        let out = kernel();
        black_box(out);
        best = best.min(started.elapsed().as_secs_f64() * 1000.0);
    }
    best
}

fn report(label: &str, ms: f64) {
    println!("{:<44} {:>8.3}ms  {:>7.1}us/card", label, ms, ms * 1000.0 / PAGE as f64);
}

#[test]
#[ignore = "benchmark; needs a real store in store-build/"]
fn bench_card_object_build() {
    let Some(store) = load() else {
        eprintln!("SKIP: no store-build/card-store-*.store + card-compat-*.store pair");
        return;
    };
    // TrueNode -- the whole corpus, so a 175-card page is full and the row work is the subject
    // rather than the filter. Same wire shape the port's trees.ts TRUE_TREE sends.
    let tree = serde_json::json!({"node_type": "TrueNode", "kwargs": {}});

    println!("=== the whole call, as scryfallSearch makes it ===");
    let all = best_ms(|| {
        let out = store.query_value(&tree, &opts(CARD_OBJECT_FIELDS, PAGE)).expect("query");
        out.rows.len()
    });
    report("query_value(66 fields, 175 rows)", all);

    // The same query asking for ONE field: everything except per-field row construction --
    // planning, candidate materialization, ordering, paging. The floor the rest sits on.
    let skeleton = best_ms(|| {
        let out = store.query_value(&tree, &opts(&["name"], PAGE)).expect("query");
        out.rows.len()
    });
    report("query_value(1 field, 175 rows)   [search only]", skeleton);
    report("=> the 65 extra fields cost", all - skeleton);

    println!("\n=== what the wasm boundary adds on top (lib.rs's `query`) ===");
    // to_json CLONES every row (QueryOutput::to_json takes &self), then to_string serializes.
    let out = store.query_value(&tree, &opts(CARD_OBJECT_FIELDS, PAGE)).expect("query");
    let clone_ms = best_ms(|| {
        let wrapped: Value = out.to_json();
        wrapped.as_object().map_or(0, serde_json::Map::len)
    });
    report("QueryOutput::to_json  [the deep clone]", clone_ms);

    let wrapped = out.to_json();
    let encode_ms = best_ms(|| wrapped.to_string().len());
    report("Value::to_string      [serialize]", encode_ms);

    let bytes = wrapped.to_string().len();
    println!("\npayload {}KB for {} rows", bytes / 1024, out.rows.len());
    println!("RUST TOTAL {:.3}ms = {:.1}us/card", all + clone_ms + encode_ms, (all + clone_ms + encode_ms) * 1000.0 / PAGE as f64);
    println!("(production DO measured ~92us/card for the whole thing, Rust + JS)");

    println!("\n=== field-group attribution, one group at a time on top of `name` ===");
    for (label, group) in [
        ("scalars (cmc, rarity, power, ...)", &["name", "cmc", "rarity", "power", "toughness", "collector_number"][..]),
        ("legalities", &["name", "legalities"][..]),
        ("sorted string sets (keywords/tags)", &["name", "card_keywords", "card_is_tags", "card_frame_data", "promo_types", "frame_effects"][..]),
        ("uuids (scryfall/oracle/set ids)", &["name", "scryfall_id", "oracle_id", "set_id", "illustration_id"][..]),
        ("card_faces", &["name", "card_faces"][..]),
        ("all_parts", &["name", "all_parts"][..]),
        ("prices", &["name", "price_usd", "price_eur", "price_tix"][..]),
    ] {
        let ms = best_ms(|| store.query_value(&tree, &opts(group, PAGE)).expect("query").rows.len());
        report(&format!("  + {label}"), ms - skeleton);
    }
}
