//! The card-names blob's INPUT against the REAL corpus (backlog n8): what a build publishes for each
//! partition (`StoreStats::autocomplete_names`, read off the structures the archive is serialized
//! from) must be exactly what that partition's archive can offer (`BufferStore::autocomplete_names`,
//! read back through the accessors `autocomplete` uses).
//!
//! The corpus's `rows.jsonl` (the finalized rows the build dir's archives were built from) is cut by
//! the production partition function and rebuilt, partition by partition, and each rebuild's names
//! are compared pair for pair with the published archive's. The ranking half of the differential —
//! the blob's answers against the fan-out's merge, on 6,350 needles — is
//! tests/engine/autocomplete-names-real.test.ts, which drives the committed wasm and the production
//! `mergeAutocomplete`; the fixture-sized version of both runs in CI (src/names.rs).
//!
//! Ignored: it needs a built corpus, read-only. In release:
//!
//!   SYLVAN_STORE_BUILD=/path/to/store-build scripts/with-rust.sh cargo test --release \
//!     -p sylvan-engine-wasm --test names_real -- --ignored --nocapture

use std::io::BufRead;

use card_engine::{fnv1a64_oracle_id, BufferStore, StoreBuilder};
use serde_json::Value;

#[test]
#[ignore = "needs a built corpus: SYLVAN_STORE_BUILD=<store-build dir>"]
fn build_time_names_equal_every_archives_names() {
    let Ok(dir) = std::env::var("SYLVAN_STORE_BUILD") else {
        eprintln!("SYLVAN_STORE_BUILD is not set; nothing to check");
        return;
    };
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/manifest.json")).unwrap()).unwrap();
    let parts = manifest["partitions"].as_array().unwrap();
    let n = parts.len() as u64;
    let started = std::time::Instant::now();
    let mut builders: Vec<StoreBuilder> = (0..n).map(|_| StoreBuilder::new()).collect();
    let rows = std::io::BufReader::with_capacity(1 << 22, std::fs::File::open(format!("{dir}/rows.jsonl")).unwrap());
    let mut count = 0usize;
    for line in rows.lines() {
        let row: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let k = fnv1a64_oracle_id(row["oracle_id"].as_str().unwrap()) % n;
        builders[k as usize].add_card(&row).unwrap();
        count += 1;
    }
    eprintln!("{count} rows cut into {n} partitions in {:.1?}", started.elapsed());
    let mut total = 0usize;
    for (k, builder) in builders.into_iter().enumerate() {
        let stats = builder.finish_to_writer(&mut std::io::sink()).unwrap();
        let key = parts[k]["store_key"].as_str().unwrap();
        let store = BufferStore::from_bytes(&std::fs::read(format!("{dir}/{key}")).unwrap()).unwrap();
        let archived = store.autocomplete_names();
        assert_eq!(stats.card_count, parts[k]["card_count"].as_u64().unwrap() as usize, "p{k}: not the same build");
        if stats.autocomplete_names != archived {
            let built: std::collections::BTreeSet<_> = stats.autocomplete_names.iter().collect();
            let held: std::collections::BTreeSet<_> = archived.iter().collect();
            let only_built: Vec<_> = built.difference(&held).take(5).collect();
            let only_held: Vec<_> = held.difference(&built).take(5).collect();
            panic!("p{k}: build-time names differ from the archive's: built-only {only_built:?}, archive-only {only_held:?}");
        }
        eprintln!("p{k}: {} names, identical", archived.len());
        total += archived.len();
    }
    eprintln!("{total} partition names (before the cross-partition dedupe) identical in {:.1?}", started.elapsed());
}
