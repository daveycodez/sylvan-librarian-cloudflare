# Data-import pipeline modules

Rust port of upstream's Python import pipeline
(`vendor/sylvan_librarian/api/`: `scryfall_bulk_data_fetcher.py`,
`card_processing.py`, `tag_import.py`, plus the score backfills that
`import_data` runs). Four modules in `src/`, currently **not** declared by any
target — the crate root (main.rs / lib.rs, owned by the store-build wiring)
needs:

```rust
mod bulk;      // or `pub mod` from lib.rs
mod transform;
mod tags;
mod r2;
```

(`transform` uses `crate::tags`, `tags` uses `crate::bulk`; all four must be
declared in the same crate root. Their unit tests compile with the target that
includes them.)

## Wiring sequence

Mirrors upstream `_run_import_under_lock` (api_resource.py), with the score
backfills moved after the tag fetch — upstream computes prefer scores against
the previous cycle's art tags left in Postgres; a fresh single-shot build
reproduces that steady state by using this run's tags:

```rust
let client = bulk::BulkClient::new()?;                    // Scryfall UA + retries

// 1. cards: stream default_cards (gzipped JSONL), transform each
let mut drafts = Vec::new();                              // ~100k drafts, fine in 4GB
for card in client.stream(bulk::DEFAULT_CARDS)? {
    if let Some(draft) = transform::transform(&card?)? {  // None = filtered out
        drafts.push(draft);
    }
}

// 2. tags: oracle_tags + art_tags dumps → denormalized per-id tag slugs
let tag_data = tags::fetch_tag_data(&client)?;

// 3. aggregate + emit: tag attach, prefer/cubecobra score backfills, dedupe;
//    yields one serde_json::Value per printing with exactly the ENGINE_COLUMNS
//    key set card_from_pydict consumes
let rows = transform::finalize(drafts, &tag_data);        // impl Iterator<Item = Value>

// 4. feed `rows` to the StoreBuilder seam (build_store), then upload:
let r2 = r2::R2Client::from_env()?;                       // R2_ACCESS_KEY_ID,
                                                          // R2_SECRET_ACCESS_KEY,
                                                          // CF_ACCOUNT_ID, R2_BUCKET
r2.put_store(std::fs::File::open(&store_path)?, &store_key)?;  // multipart
r2.put_json("manifest.json", &manifest.to_json())?;
```

Errors: `transform::TransformError` means a card was missing a field upstream
reads unconditionally (Python KeyError / NOT NULL violation → whole import
aborts); treat it as fatal, not skippable. `bulk::BulkError::Parse` at the end
of a stream is the parse-coverage integrity check — also fatal.

## Row shape

Each emitted row carries exactly the 43 `ENGINE_COLUMNS`
(`vendor/sylvan_librarian/card_engine/card_engine/__init__.py`), the column set
`_reload_engine` SELECTs into `card_from_pydict`. Notably: one row per
`scryfall_id` (multi-face cards collapse to their LAST surviving face —
upstream's `_dedupe_rows` last-wins semantics), `card_is_tags` is always `{}`
(never written by `import_data`), and `prefer_score` / `cubecobra_score` are
computed in `finalize` by porting `backfill_prefer_scores.sql` /
`backfill_cubecobra_scores.sql`.
