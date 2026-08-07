//! sylvan-store-builder: build a card_engine archive from card-row JSONL.
//!
//! Usage (skeleton — the Scryfall fetch/transform pipeline is being ported
//! separately and will replace the stdin/JSONL input):
//!
//!   sylvan-store-builder --out DIR [--serve]
//!
//! Reads one card-row JSON object per line from stdin, writes
//! `DIR/card-store-v<format_version>.store` and `DIR/manifest.json`.

// The Scryfall pipeline modules (bulk / transform / tags / r2) live in the
// library crate (sylvan_store_builder::bulk etc. — see PIPELINE.md for the
// wiring sequence); wiring them into this bin's flow replaces the stdin/JSONL
// input below.

use std::io::BufRead;
use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::Value;
use sylvan_store_builder::build_store;

struct Args {
    out: PathBuf,
    /// Stub: will serve build progress / health once the pipeline lands.
    serve: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut out: Option<PathBuf> = None;
    let mut serve = false;
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--out" => {
                let v = argv.next().ok_or("--out requires a directory argument")?;
                out = Some(PathBuf::from(v));
            }
            "--serve" => serve = true,
            "--help" | "-h" => {
                return Err("usage: sylvan-store-builder --out DIR [--serve]".to_owned());
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Args { out: out.ok_or("--out DIR is required")?, serve })
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::FAILURE;
        }
    };

    if args.serve {
        eprintln!("--serve: not implemented yet (pipeline port pending); building once and exiting");
    }

    // Skeleton input: card-row JSON objects, one per line, on stdin. The
    // ported Scryfall pipeline will replace this with bulk fetch + transform.
    let stdin = std::io::stdin();
    let rows = stdin.lock().lines().filter_map(|line| {
        let line = line.ok()?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("skipping malformed JSON line: {e}");
                None
            }
        }
    });

    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_owned());

    match build_store(rows, &args.out, &built_at) {
        Ok(manifest) => {
            let manifest_path = args.out.join("manifest.json");
            if let Err(e) = std::fs::write(&manifest_path, manifest.to_json().to_string()) {
                eprintln!("failed to write {}: {e}", manifest_path.display());
                return ExitCode::FAILURE;
            }
            println!(
                "built {} ({} cards, {} printings) -> {}",
                manifest.store_key,
                manifest.card_count,
                manifest.printing_count,
                args.out.display(),
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("store build failed: {e}");
            ExitCode::FAILURE
        }
    }
}
