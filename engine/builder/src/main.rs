//! sylvan-store-builder: build a card_engine archive from Scryfall bulk data.
//!
//!   sylvan-store-builder --out DIR
//!
//! Local development's fast path (scripts/seed-local.sh): one native build of
//! the same pipeline the ImportCoordinator Durable Object runs in wasm —
//! shared transform/tags/finalize code, byte-identical rows by construction.
//! Production imports run entirely on-platform; this binary never deploys.

use std::path::PathBuf;
use std::process::ExitCode;

use sylvan_store_builder::{build_store, bulk, tags, transform};

fn parse_out_dir() -> Result<PathBuf, String> {
    let mut argv = std::env::args().skip(1);
    match (argv.next().as_deref(), argv.next(), argv.next()) {
        (Some("--out"), Some(dir), None) => Ok(PathBuf::from(dir)),
        _ => Err("usage: sylvan-store-builder --out DIR".to_owned()),
    }
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
fn run_import(out_dir: &std::path::Path) -> Result<(), String> {
    eprintln!("downloading card data...");
    let client = bulk::BulkClient::new().map_err(|e| format!("bulk client: {e}"))?;
    let mut drafts = Vec::new();
    for card in client.stream(bulk::DEFAULT_CARDS).map_err(|e| format!("bulk stream: {e}"))? {
        let card = card.map_err(|e| format!("bulk read: {e}"))?;
        if let Some(draft) = transform::transform(&card).map_err(|e| format!("transform: {e}"))? {
            drafts.push(draft);
        }
        if drafts.len() % 10_000 == 0 && !drafts.is_empty() {
            eprintln!("  {} printings...", drafts.len());
        }
    }

    eprintln!("downloading tags...");
    let tag_data = tags::fetch_tag_data(&client).map_err(|e| format!("tags: {e}"))?;

    eprintln!("computing scores and finalizing rows...");
    let rows = transform::finalize(drafts, &tag_data);

    eprintln!("building store...");
    let manifest = build_store(rows, out_dir, &now_unix()).map_err(|e| format!("store build: {e}"))?;
    let manifest_path = out_dir.join("manifest.json");
    std::fs::write(&manifest_path, manifest.to_json().to_string()).map_err(|e| format!("write manifest: {e}"))?;
    eprintln!(
        "built {} ({} cards, {} printings)",
        manifest.store_key, manifest.card_count, manifest.printing_count
    );
    Ok(())
}

fn main() -> ExitCode {
    let out_dir = match parse_out_dir() {
        Ok(dir) => dir,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    match run_import(&out_dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("import failed: {e}");
            ExitCode::FAILURE
        }
    }
}
