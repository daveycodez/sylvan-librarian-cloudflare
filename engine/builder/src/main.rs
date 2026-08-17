//! sylvan-store-builder: build a card_engine archive from Scryfall bulk data.
//!
//!   sylvan-store-builder --out DIR [--partitions auto|N]
//!
//! Local development's fast path (scripts/seed-local.sh) and the deploy path
//! (scripts/import-store.sh): one native build of the same pipeline the
//! ImportCoordinator Durable Object runs in wasm — shared transform/tags/
//! finalize code, byte-identical rows by construction. Nightly refreshes run
//! entirely on-platform; this binary never deploys.
//!
//! Env overrides (both unset in production, see bulk.rs):
//!   SCRYFALL_BULK_URL  replace the /bulk-data listing URL
//!   SYLVAN_BULK_DIR    stream `<dir>/<kind>.jsonl.gz` (`all_cards.jsonl.gz` or
//!                      `all-cards.jsonl.gz`) off disk instead of downloading
//!                      it; per-kind and optional, so a dir holding only the
//!                      card dumps still fetches the tag dumps from Scryfall.
//!                      Local dev and CI use it to skip a ~470MB download.

use std::path::PathBuf;
use std::process::ExitCode;

use sylvan_store_builder::{
    build_store_partitioned_spilled, build_store_spilled, bulk, spill, tags, transform, PartitionsArg,
};

fn parse_args() -> Result<(PathBuf, Option<PartitionsArg>), String> {
    const USAGE: &str = "usage: sylvan-store-builder --out DIR [--partitions auto|N]";
    let mut out: Option<PathBuf> = None;
    let mut partitions: Option<PartitionsArg> = None;
    let mut argv = std::env::args().skip(1);
    while let Some(flag) = argv.next() {
        match flag.as_str() {
            "--out" => out = Some(PathBuf::from(argv.next().ok_or(USAGE)?)),
            "--partitions" => {
                let v = argv.next().ok_or(USAGE)?;
                partitions = Some(if v == "auto" {
                    PartitionsArg::Auto
                } else {
                    PartitionsArg::Fixed(v.parse().map_err(|_| format!("--partitions {v:?}: {USAGE}"))?)
                });
            }
            _ => return Err(USAGE.to_owned()),
        }
    }
    Ok((out.ok_or(USAGE)?, partitions))
}

fn now_unix() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_owned())
}

/// The full import: fetch → transform → tags → finalize → build. Mirrors
/// upstream `_run_import_under_lock` (api_resource.py), with the score
/// backfills computed against this run's tags (see transform::finalize docs).
///
/// TWO CARD DUMPS, ONE CORPUS (the same shape the nightly coordinator runs, and the shape the G2
/// real-corpus gate proved): `default_cards` is streamed first for its IDS ONLY — the canonical
/// set — and `all_cards` is then streamed as the corpus, each row transformed with the canonicity
/// fact rather than a rule derived from the row (plan reconciliation 5). Streaming only
/// default_cards, as this did before, builds an English-only store: no foreign printings, `lang:ja`
/// empty, "ego à deriva" unresolvable — and it did so on BOTH the deploy path and `bun dev`, which
/// is the drift the two publishers are supposed to be immune to.
fn run_import(out_dir: &std::path::Path, partitions: Option<PartitionsArg>) -> Result<(), String> {
    let client = bulk::BulkClient::new().map_err(|e| format!("bulk client: {e}"))?;

    // 1. The canonical id set. Ids only: a CanonicalIds holds 16 parsed bytes per id (~1.9MB at
    //    today's ~117k), so the whole default_cards stream is consumed and dropped, never retained
    //    as JSON alongside the all_cards stream that follows.
    eprintln!("downloading default_cards (the canonical id set)...");
    let mut canonical = tags::CanonicalIds::default();
    for card in client.stream(bulk::DEFAULT_CARDS).map_err(|e| format!("bulk stream: {e}"))? {
        let card = card.map_err(|e| format!("bulk read: {e}"))?;
        if let Some(id) = card.get("id").and_then(serde_json::Value::as_str) {
            canonical.insert(id);
        }
    }
    if canonical.is_empty() {
        return Err("default_cards yielded no ids — every row would be marked foreign".to_owned());
    }
    eprintln!("  {} canonical ids", canonical.len());

    // 2. Scryfall's own representative choice, used to PIN ours. Deliberately non-fatal: this is
    //    an optional input, and an import that cannot reach it should still produce a store scored
    //    the way it always was rather than no store at all.
    //
    //    BEFORE the corpus stream, because the pin propagates by printing slot (transform's
    //    PIN_BONUS): the labelled row's (set_code, collector_number) is only knowable while that
    //    row goes past, so the aggregation pass needs this set in hand from the first draft.
    eprintln!("downloading representative labels...");
    let mut labels: std::collections::HashSet<String> = std::collections::HashSet::new();
    match client.stream(bulk::ORACLE_CARDS) {
        Ok(iter) => {
            for card in iter {
                match card {
                    Ok(c) => {
                        if let Some(id) = c.get("id").and_then(|v| v.as_str()) {
                            labels.insert(id.to_string());
                        }
                    }
                    Err(e) => eprintln!("  warning: oracle_cards read: {e}"),
                }
            }
            eprintln!("  {} representative labels", labels.len());
        }
        Err(e) => eprintln!("  warning: no representative labels ({e}); scoring without the pin"),
    }

    // 3. The corpus — STRAIGHT TO DISK.
    //
    // Every draft is appended to a spill file under the out dir as it is transformed, so the
    // 517k-row multilingual corpus is never resident. What stays in the heap is the small,
    // corpus-WIDE aggregation state `finalize` needs and a partition cannot compute for itself
    // (the cubecobra percent-rank over distinct card names, the illustration counts) — tens of
    // MB, sealed when the stream ends. See engine/builder/src/spill.rs.
    eprintln!("downloading all_cards (every printing in every language)...");
    std::fs::create_dir_all(out_dir).map_err(|e| format!("create {}: {e}", out_dir.display()))?;
    let mut staging = spill::DraftSpill::create(out_dir, &labels)?;
    let (mut lines, mut canon_rows, mut foreign_rows, mut filtered) = (0u64, 0u64, 0u64, 0u64);
    let mut logged_at = 0u64;
    for card in client.stream(bulk::ALL_CARDS).map_err(|e| format!("bulk stream: {e}"))? {
        let card = card.map_err(|e| format!("bulk read: {e}"))?;
        lines += 1;
        let is_canonical = card
            .get("id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| canonical.contains(id));
        match transform::transform_row(&card, is_canonical).map_err(|e| format!("transform: {e}"))? {
            Some(draft) => {
                if is_canonical {
                    canon_rows += 1;
                } else {
                    foreign_rows += 1;
                }
                staging.append(&draft)?;
            }
            None => filtered += 1,
        }
        // Same 10k cadence as ever, but latched: a filtered row leaves the count on a multiple and
        // used to reprint the same line for each one.
        if staging.records() >= logged_at + 10_000 {
            logged_at = staging.records() - staging.records() % 10_000;
            eprintln!("  {logged_at} printings...");
        }
    }
    let corpus = staging.finish()?;
    eprintln!(
        "  {lines} lines -> {} drafts ({canon_rows} canonical + {foreign_rows} foreign), {filtered} filtered",
        corpus.records
    );
    eprintln!(
        "  staged {:.1}MB of drafts on disk ({} rows after dedupe)",
        corpus.framed_bytes as f64 / 1_048_576.0,
        corpus.aggregates.rows
    );

    eprintln!("downloading tags...");
    let mut tag_data = tags::fetch_tag_data(&client).map_err(|e| format!("tags: {e}"))?;
    // Still carried on TagData: `is_pinned` checks the labelled id itself as well as the slots the
    // aggregation pass collected, so a labelled printing is pinned even where it has no slot.
    tag_data.labels = labels;

    // ONE PARTITION AT A TIME, out of the spill: read that partition's drafts, finalize them
    // against the corpus-wide aggregates, build its archive, drop everything, delete its spill.
    // The finalized rows are teed to rows.jsonl on the way past — the local D1 seeder feeds the
    // SQL-fallback cards table from it, so a native seed is as complete as the DO import. (Its
    // lines are grouped by partition rather than in corpus order; nothing reads it in order —
    // `_reload_engine`'s SELECT has no ORDER BY, and memprobe streams it.)
    //
    // MEASURED on the real multilingual corpus (517,746 drafts, `--partitions auto` = 9), against
    // Workers Builds' 8GB and 20 minutes: 451MiB peak RSS, 52.0s wall. The same corpus through
    // the previous shape — every draft in one Vec, one global finalize — peaked at 7.41GiB in
    // 48.4s on the same machine, i.e. 1-2 years of corpus growth from the ceiling while every
    // other memory ceiling in this program had decades. Where the peak goes now, sampled through
    // one run: 124MiB standing after the corpus stream (the aggregation state, ~250B per row),
    // +40MiB for the tag corpus, and the rest one partition's build — which does NOT grow with
    // the corpus, because N auto-scales to keep a partition near TARGET_PARTITION_BYTES. Only the
    // first term grows, linearly, so the ceiling is ~60x today's row count away.
    eprintln!("computing scores and finalizing rows...");
    let rows_path = out_dir.join("rows.jsonl");
    let mut rows_file = std::io::BufWriter::with_capacity(
        1 << 20,
        std::fs::File::create(&rows_path).map_err(|e| format!("create rows.jsonl: {e}"))?,
    );
    // Partitioned when asked (`--partitions auto|N` — the flag both scripts pass), the single
    // archive otherwise. One manifest.json either way; the v2 shape is discriminated by
    // `partition_count`'s presence.
    let built_at = now_unix();
    let (manifest_json, built_summary) = match partitions {
        Some(arg) => {
            let manifest =
                build_store_partitioned_spilled(corpus, &tag_data, out_dir, &built_at, arg, &mut rows_file)
                    .map_err(|e| format!("partitioned store build: {e}"))?;
            let summary = format!(
                "built {} ({} cards, {} printings, {} partitions)",
                manifest["store_key"].as_str().unwrap_or(""),
                manifest["card_count"],
                manifest["printing_count"],
                manifest["partition_count"]
            );
            (manifest, summary)
        }
        None => {
            let manifest = build_store_spilled(&corpus, &tag_data, out_dir, &built_at, &mut rows_file)
                .map_err(|e| format!("store build: {e}"))?;
            let summary = format!(
                "built {} ({} cards, {} printings)",
                manifest.store_key, manifest.card_count, manifest.printing_count
            );
            (manifest.to_json(), summary)
        }
    };
    std::io::Write::flush(&mut rows_file).map_err(|_| "write rows.jsonl failed".to_owned())?;
    let manifest_path = out_dir.join("manifest.json");
    std::fs::write(&manifest_path, manifest_json.to_string()).map_err(|e| format!("write manifest: {e}"))?;

    // The alias → slug maps this build resolved, for the query side to fold search terms through.
    // This port does not stamp alias keys into the store (see TagData::oracle_aliases), so this
    // file is the OTHER half of that decision: without it every alias spelling stops resolving.
    // scripts/generate-tag-aliases.ts turns it into the committed parser module.
    let aliases_path = out_dir.join("tag-aliases.json");
    let aliases = serde_json::json!({
        "oracle": tag_data.oracle_aliases,
        "art": tag_data.art_aliases,
    });
    std::fs::write(&aliases_path, aliases.to_string()).map_err(|e| format!("write tag-aliases: {e}"))?;
    eprintln!(
        "wrote {} ({} oracle + {} art aliases)",
        aliases_path.display(),
        tag_data.oracle_aliases.len(),
        tag_data.art_aliases.len()
    );
    // The build itself printed the annex/drop split (build_store_partitioned's totals line); this
    // is the corpus side of the same question — what went IN.
    eprintln!("{built_summary} from {canon_rows} canonical + {foreign_rows} foreign rows");
    Ok(())
}

fn main() -> ExitCode {
    let (out_dir, partitions) = match parse_args() {
        Ok(parsed) => parsed,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    match run_import(&out_dir, partitions) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("import failed: {e}");
            ExitCode::FAILURE
        }
    }
}
