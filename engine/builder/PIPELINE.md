# Data-import pipeline modules

Rust port of upstream's Python import pipeline
(`vendor/sylvan_librarian/api/`: `scryfall_bulk_data_fetcher.py`,
`card_processing.py`, `tag_import.py`, plus the score backfills that
`import_data` runs).

**Re-verified against the source on 2026-08-16.** This file was written on
2026-08-07 as a wiring *proposal* for modules that were not yet declared by any
target. Everything it proposed is now built and shipping, and several details
landed differently — the list below is what `engine/builder/src/` actually
contains today, and the reader should re-check it against `lib.rs` rather than
trust this paragraph indefinitely.

## The modules, and which targets see them

`src/lib.rs` is the crate root and declares all of them. There is no
undeclared-module problem left to solve.

| Module | Declared | Role |
|---|---|---|
| `bulk` | `#[cfg(not(target_arch = "wasm32"))]` | Scryfall `/bulk-data` listing, UA, retries, gzip, JSONL streaming |
| `transform` | always | one bulk card object → one `RowDraft`, plus `finalize` / `finalize_row` |
| `tags` | always | `oracle_tags` / `art_tags` dumps → per-id slug sets; `CanonicalIds` |
| `ranks` | always | per-card printing order behind the representative choice |
| `spill` | `#[cfg(not(target_arch = "wasm32"))]` | the corpus staged on disk instead of in the heap |

**There is no `r2` module and no R2 upload path.** The 2026-08-07 draft of this
file sketched `r2::R2Client::from_env()` and `put_store` / `put_json`; that was
never built. Both publishers write to **KV**: the deploy path through
`scripts/import-store.sh` → `scripts/seed-remote-kv.ts`, and the nightly through
`src/import-coordinator.ts`'s alarm chain. `src/engine/store-kv.ts` owns the key
layout.

The two native-only gates are deliberate and each says why in `lib.rs`: the wasm
import (`engine/wasm-import`, run inside the `ImportCoordinator` Durable Object)
does its networking in JS and stages its drafts in DO SQLite, so it needs
neither `bulk` nor `spill`. `ranks` is pointedly **not** gated — all three import
paths compute it, and a wasm build that omitted it would still link while
producing a store whose `prefer_score` disagrees with the native builder's.

Three targets consume the crate: the `sylvan-store-builder` binary
(`src/main.rs`), `engine/wasm-import` (the nightly), and the probe/differential
harnesses (`examples/memprobe`, `engine/wasm-builder-probe`).

## Wiring sequence

What `run_import` in `src/main.rs` actually does. It still mirrors upstream
`_run_import_under_lock` (api_resource.py) with the score backfills moved after
the tag fetch — upstream computes prefer scores against the previous cycle's art
tags left in Postgres; a fresh single-shot build reproduces that steady state by
using this run's tags.

**Two card dumps, one corpus.** `default_cards` is streamed first for its **ids
only** (the canonical set); `all_cards` is then streamed as the corpus, with
each row transformed carrying the canonicity fact. Streaming only
`default_cards` — which is what the original sketch below did — builds an
English-only store: no foreign printings, `lang:ja` empty. Non-canonical rows
land in the archive's annex.

```rust
let client = bulk::BulkClient::new()?;                    // Scryfall UA + retries

// 1. the canonical id set — ids only, the stream is consumed and dropped
let mut canonical = tags::CanonicalIds::default();
for card in client.stream(bulk::DEFAULT_CARDS)? { canonical.insert(id_of(card?)); }

// 2. Scryfall's own representative labels (oracle_cards), used to PIN ours.
//    Non-fatal: an import that cannot reach it still produces a store.

// 3. the corpus — STRAIGHT TO DISK. Every draft is appended to a spill file as
//    it is transformed, so the 517k-row multilingual corpus is never resident.
let mut staging = spill::DraftSpill::create(out_dir, &labels)?;
for card in client.stream(bulk::ALL_CARDS)? {
    let card = card?;
    let is_canonical = canonical.contains(id_of(&card));
    if let Some(draft) = transform::transform_row(&card, is_canonical)? {
        staging.append(&draft)?;                          // None = filtered out
    }
}
let corpus = staging.finish()?;                           // + corpus-wide aggregates

// 4. tags: oracle_tags + art_tags dumps → denormalized per-id tag slugs
let tag_data = tags::fetch_tag_data(&client)?;

// 5. ONE PARTITION AT A TIME out of the spill: read that partition's drafts,
//    finalize them against the corpus-wide aggregates, build its archive, drop
//    everything, delete its spill. Writes N archives + one manifest.json.
build_store_partitioned_spilled(corpus, &tag_data, out_dir, &built_at, arg, &mut rows_file)?;
```

Note `transform::transform_row(card, is_canonical)` is the entry point. The
one-argument `transform::transform(card)` still exists and is equivalent to
`transform_row(card, true)`.

`finalize(drafts: Vec<RowDraft>, tags)` also still exists and is what the
in-memory arm and the tests use; the deploy path goes through the spilled arm,
and `spill.rs`'s `spilled_rows_match_the_in_memory_finalize` is what asserts the
two produce identical rows.

Errors: `transform::TransformError` means a card was missing a field upstream
reads unconditionally (Python KeyError / NOT NULL violation → whole import
aborts); treat it as fatal, not skippable. `bulk::BulkError::Parse` at the end
of a stream is the parse-coverage integrity check — also fatal.

## Partitioning

`--partitions auto|N` (both `scripts/seed-local.sh` and
`scripts/import-store.sh` pass it). `auto` is plan Decision 3b: N is projected
from the build's own measured byte accounting rather than configured, as
`clamp(ceil(projected_store_bytes / TARGET_PARTITION_BYTES), 2, 32)` with
`TARGET_PARTITION_BYTES = 43_000_000`. `src/import-publish.ts`'s
`partitionCountFor` is the line-for-line twin on the nightly side, and the two
constants' doc comments are explicitly kept in step.

The hash is `PARTITION_HASH_ALGO = "fnv1a64/oracle_id/v1"`, and the builder
asserts its own agreement with `tests/engine/partition-hash-vectors.json` at
startup, before it cuts anything — the Rust↔TS agreement is the
highest-consequence detail in the design, so it is not left to "the tests were
run".

Spill records are framed `[u64 le part_hash][u32 le len][draft JSON]`. The
stored value is the **raw** fnv1a64 of oracle_id, never a partition index,
because N is chosen after the corpus is measured and the staged bytes must stay
cuttable at any N.

## Row shape

Each emitted row carries exactly the **45** `ENGINE_COLUMNS`
(`vendor/sylvan_librarian/card_engine/card_engine/__init__.py`, counted
2026-08-16), the column set `_reload_engine` SELECTs into `card_from_pydict`.
Notably: one row per `scryfall_id` (multi-face cards collapse to their LAST
surviving face — upstream's `_dedupe_rows` last-wins semantics), and
`prefer_score` / `cubecobra_score` are computed in `finalize` by porting
`backfill_prefer_scores.sql` / `backfill_cubecobra_scores.sql`.

`card_is_tags` is **not** empty — the 2026-08-07 claim that it "is always `{}`,
never written by `import_data`" is false today. It carries the `BOOLEAN_IS_TAGS`
and `ARRAY_IS_TAGS` subsets that `_sync_boolean_is_tags` derives from the bulk
card's own booleans after each upsert, plus the `extra` tag the builder adds
itself (`EXTRA_IS_TAG`, `transform.rs`). Upstream's `CUSTOM_IS_TAGS` need a
per-tag Scryfall search sweep that no automated import runs, so those stay absent
on both sides.

Two of `finalize`'s passes are genuinely corpus-global and therefore cannot be
computed inside a partition: `cubecobra_score` (a percent-rank over the distinct
card names of the whole corpus) and `illustration_count` (keyed by
`(illustration_id, card_name)`, not by oracle_id). `spill.rs`'s module header is
the authority on how each publisher keeps them global — the native path holds
them resident across the streaming pass, the nightly takes both from its own
`scores` phase in the `TagData` snapshot.
