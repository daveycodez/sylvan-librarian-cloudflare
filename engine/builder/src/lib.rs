//! Native store builder: drives `card_engine::StoreBuilder` end-to-end from
//! Scryfall-shaped card-row JSON to an archive file plus a manifest.
//!
//! The Scryfall fetch/transform pipeline modules (ported from upstream's
//! Python import pipeline — see PIPELINE.md for the wiring sequence) feed
//! [`build_store`], this crate's store-build seam.

pub mod bulk;
pub mod r2;
pub mod tags;
pub mod transform;

use std::io::{BufWriter, Write};
use std::path::Path;

use card_engine::{store_format_version, StoreBuilder};
use serde_json::Value;

/// What a finished build produced — serialized alongside the store so the
/// Worker can verify it is loading bytes from the same engine build.
#[derive(Debug, Clone)]
pub struct Manifest {
    /// Object key the store is published under (R2). Versioned by the archive
    /// format so a Worker running an older engine never loads incompatible bytes.
    pub store_key: String,
    /// Build timestamp, supplied by the caller (the bin passes wall-clock time;
    /// tests pass a fixed value).
    pub built_at: String,
    /// Oracle cards in the store (post-grouping).
    pub card_count: usize,
    /// Printings in the store (pre-grouping row count; the `size()` number).
    pub printing_count: usize,
    /// The vendored upstream commit this builder was compiled from
    /// (UPSTREAM.lock), or "unknown" when the lock cannot be read.
    pub upstream_commit: String,
    /// card_engine's ARCHIVE_FORMAT_VERSION. Readers reject a mismatch.
    pub format_version: u32,
    /// Archive size in bytes (16-byte header included). The Worker
    /// preallocates its wasm-side buffer from this.
    pub store_bytes: u64,
}

impl Manifest {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "store_key": self.store_key,
            "built_at": self.built_at,
            "card_count": self.card_count,
            "printing_count": self.printing_count,
            "upstream_commit": self.upstream_commit,
            "format_version": self.format_version,
            "store_bytes": self.store_bytes,
        })
    }
}

/// UPSTREAM.lock's pinned commit, read at runtime from the repo root (two
/// levels above this crate). Falls back to "unknown" outside the repo layout.
pub fn upstream_commit() -> String {
    let lock_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../UPSTREAM.lock");
    std::fs::read_to_string(lock_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("commit").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned())
}

/// Build a store from card-row JSON objects (one per printing, in the field
/// shape `card_engine`'s loader expects) and write it into `out_dir`, named by
/// its store key. Returns the manifest; the caller decides where the manifest
/// itself is written/published.
pub fn build_store(
    rows: impl Iterator<Item = Value>,
    out_dir: &Path,
    built_at: &str,
) -> Result<Manifest, Box<dyn std::error::Error>> {
    let mut builder = StoreBuilder::new();
    for (i, row) in rows.enumerate() {
        builder
            .add_card(&row)
            .map_err(|e| format!("row {i}: {e}"))?;
    }

    let format_version = store_format_version();
    // The key must be unique per build: the Worker detects a new publish by
    // store-key change and caches store bytes immutably keyed by it.
    // Stored RAW, deliberately: R2 egress to Workers is free while decompress
    // CPU is metered per cold isolate — at scale, compression is a pure cost.
    let store_key = format!("card-store-v{format_version}-{built_at}.store");
    let store_path = out_dir.join(&store_key);

    std::fs::create_dir_all(out_dir)?;
    let file = std::fs::File::create(&store_path)?;
    let mut counter = CountingWriter { inner: BufWriter::with_capacity(1 << 20, file), written: 0 };
    let stats = builder.finish_to_writer(&mut counter)?;
    let store_bytes = counter.written;
    counter.flush()?;

    Ok(Manifest {
        store_key,
        built_at: built_at.to_owned(),
        card_count: stats.card_count,
        printing_count: stats.printing_count,
        upstream_commit: upstream_commit(),
        format_version,
        store_bytes,
    })
}

/// Pass-through writer that counts the archive bytes as they stream out.
struct CountingWriter<W: Write> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
