//! Native store builder: drives `card_engine::StoreBuilder` end-to-end from
//! Scryfall-shaped card-row JSON to an archive file plus a manifest.
//!
//! The Scryfall fetch/transform pipeline modules (ported from upstream's
//! Python import pipeline — see PIPELINE.md for the wiring sequence) feed
//! [`build_store`], this crate's store-build seam.

// bulk (reqwest) is native-only: the wasm import path
// (engine/wasm-import, run inside the ImportCoordinator Durable Object) does
// its networking in JS and publishes through bindings, consuming only the
// pure transform/tags logic from this crate.
#[cfg(not(target_arch = "wasm32"))]
pub mod bulk;
pub mod tags;
pub mod transform;

#[cfg(not(target_arch = "wasm32"))]
use std::io::{BufWriter, Write};
#[cfg(not(target_arch = "wasm32"))]
use std::path::Path;

#[cfg(not(target_arch = "wasm32"))]
use card_engine::{store_format_version, StoreBuilder};
#[cfg(not(target_arch = "wasm32"))]
use serde_json::Value;

/// What a finished build produced — serialized alongside the store so the
/// Worker can verify it is loading bytes from the same engine build.
#[derive(Debug, Clone)]
#[cfg(not(target_arch = "wasm32"))]
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
    /// Object key of the paired residue archive (see CompatData in card_engine): the Scryfall
    /// card-object fields `/search` never reads, loaded only by `/cards/*`.
    pub compat_key: String,
    /// Residue archive size in bytes, header included.
    pub compat_bytes: u64,
}

#[cfg(not(target_arch = "wasm32"))]
impl Manifest {
    /// The manifest as the publishers read it.
    ///
    /// Hand-written rather than derived, and therefore a SECOND definition of this struct that
    /// can drift from the first — which it did: `compat_key` and `compat_bytes` were added to the
    /// struct and not here, so `build_store` wrote the card-object archive to disk and then
    /// published a manifest that never mentioned it, and the deploy died on
    /// `store-build/undefined`. `every_field_reaches_the_json` below is what stops that
    /// happening again.
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "store_key": self.store_key,
            "built_at": self.built_at,
            "card_count": self.card_count,
            "printing_count": self.printing_count,
            "upstream_commit": self.upstream_commit,
            "format_version": self.format_version,
            "store_bytes": self.store_bytes,
            "compat_key": self.compat_key,
            "compat_bytes": self.compat_bytes,
        })
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod manifest_tests {
    use super::Manifest;

    /// Every field of `Manifest` reaches `to_json`.
    ///
    /// The serializer is hand-written, so a field added to the struct is not added to the wire by
    /// the compiler. This is a `Debug` comparison rather than a key list because `Debug` is
    /// derived: it grows with the struct on its own, where a hand-maintained list would need the
    /// same discipline that failed in the first place.
    #[test]
    fn every_field_reaches_the_json() {
        let manifest = Manifest {
            store_key: "card-store-v1-2.store".to_owned(),
            built_at: "2".to_owned(),
            card_count: 3,
            printing_count: 4,
            upstream_commit: "abc".to_owned(),
            format_version: 5,
            store_bytes: 6,
            compat_key: "card-compat-v1-2.store".to_owned(),
            compat_bytes: 7,
        };
        let json = manifest.to_json();
        let object = json.as_object().expect("an object");
        // Debug renders `field: value` for every field, so the field NAMES come from the struct
        // itself rather than from a list here that would need the same upkeep as to_json.
        let debug = format!("{manifest:?}");
        let fields: Vec<&str> = debug
            .trim_start_matches("Manifest {")
            .trim_end_matches('}')
            .split(", ")
            .filter_map(|part| part.split_once(": ").map(|(name, _)| name.trim()))
            .collect();
        for field in &fields {
            assert!(object.contains_key(*field), "Manifest.{field} never reaches to_json()");
        }
        assert_eq!(object.len(), fields.len(), "to_json emits a key that is not a Manifest field");
    }
}

/// UPSTREAM.lock's pinned commit, read at runtime from the repo root (two
/// levels above this crate). Falls back to "unknown" outside the repo layout.
#[cfg(not(target_arch = "wasm32"))]
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
#[cfg(not(target_arch = "wasm32"))]
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
    // The residue archive is a SECOND file, paired with the store by name. Keeping /cards/*'s
    // fields out of the search archive is what holds the search store at three KV chunks and the
    // in-Worker build under its 112 MiB cap -- see CompatData in card_engine.
    let compat_key = format!("card-compat-v{format_version}-{built_at}.store");
    let compat_path = out_dir.join(&compat_key);

    std::fs::create_dir_all(out_dir)?;
    let file = std::fs::File::create(&store_path)?;
    let compat_file = std::fs::File::create(&compat_path)?;
    let mut compat_counter =
        CountingWriter { inner: BufWriter::with_capacity(1 << 20, compat_file), written: 0 };
    let mut counter = CountingWriter { inner: BufWriter::with_capacity(1 << 20, file), written: 0 };
    let stats = builder.finish_to_writer(&mut counter, Some(&mut compat_counter))?;
    let store_bytes = counter.written;
    let compat_bytes = compat_counter.written;
    counter.flush()?;
    compat_counter.flush()?;

    Ok(Manifest {
        store_key,
        built_at: built_at.to_owned(),
        card_count: stats.card_count,
        printing_count: stats.printing_count,
        upstream_commit: upstream_commit(),
        format_version,
        store_bytes,
        compat_key,
        compat_bytes,
    })
}

/// Pass-through writer that counts the archive bytes as they stream out.
#[cfg(not(target_arch = "wasm32"))]
struct CountingWriter<W: Write> {
    inner: W,
    written: u64,
}

#[cfg(not(target_arch = "wasm32"))]
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
