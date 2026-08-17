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
// ranks (the per-card printing order behind the representative choice) is NOT gated: all three
// import paths compute it, the wasm one included. A wasm build that omitted it would still link
// — transform's caller passes a rank — and would quietly produce a store whose prefer_score
// disagrees with the native builder's, which nothing compares until someone diffs a
// nightly-built store against a deploy-built one.
pub mod ranks;
// spill (the corpus staged on disk) is native-only for the same reason: the
// wasm import stages its drafts in DO SQLite through the host, never in files.
#[cfg(not(target_arch = "wasm32"))]
pub mod spill;
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
    // This path holds the WHOLE corpus, so it computes the artist-entity relation itself rather
    // than being handed one — see `transform::observe_artist_spellings_row`.
    let mut artist_spellings = transform::ArtistSpellings::new();
    for (i, row) in rows.enumerate() {
        transform::observe_artist_spellings_row(&mut artist_spellings, &row);
        builder
            .add_card(&row)
            .map_err(|e| format!("row {i}: {e}"))?;
    }
    builder.set_artist_entities(transform::artist_entity_table(&artist_spellings));

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

    // WHERE THE ARCHIVE'S BYTES GO. The store dominates every cost the Cloudflare
    // port has -- cold DO CPU is near-linear in it (~240MB/s to materialise into a
    // wasm heap), as are the KV chunk count, the per-region cache rows and peak
    // isolate memory -- so "shrink the store" is the one lever with real headroom
    // left. It was unactionable while roughly half the archive sat in a bucket no
    // source file could size, which is what this prints.
    //
    // `indexes + padding` is the REMAINDER rather than a measurement, so it absorbs
    // the index structures and rkyv's alignment slack instead of claiming a
    // precision it does not have.
    {
        let named = stats.cards_bytes
            + stats.printings_bytes
            + stats.strings_bytes
            + stats.vocab_bytes
            + stats.direct_arrays_bytes;
        let pct = |n: usize| 100.0 * n as f64 / store_bytes as f64;
        let mb = |n: usize| n as f64 / 1_048_576.0;
        eprintln!("    archive {:.1}MB in {} sections:", mb(store_bytes as usize), 6);
        eprintln!(
            "      printings          {:>6.1}MB  {:>4.1}%   ({} x {}B)",
            mb(stats.printings_bytes),
            pct(stats.printings_bytes),
            stats.printing_count,
            stats.printings_bytes.checked_div(stats.printing_count.max(1)).unwrap_or(0)
        );
        eprintln!(
            "      cards              {:>6.1}MB  {:>4.1}%   ({} x {}B)",
            mb(stats.cards_bytes),
            pct(stats.cards_bytes),
            stats.card_count,
            stats.cards_bytes.checked_div(stats.card_count.max(1)).unwrap_or(0)
        );
        eprintln!("      strings            {:>6.1}MB  {:>4.1}%", mb(stats.strings_bytes), pct(stats.strings_bytes));
        eprintln!("      vocabs             {:>6.1}MB  {:>4.1}%", mb(stats.vocab_bytes), pct(stats.vocab_bytes));
        eprintln!(
            "      direct arrays      {:>6.1}MB  {:>4.1}%",
            mb(stats.direct_arrays_bytes),
            pct(stats.direct_arrays_bytes)
        );
        eprintln!(
            "      indexes + padding  {:>6.1}MB  {:>4.1}%   (remainder)",
            mb((store_bytes as usize).saturating_sub(named)),
            pct((store_bytes as usize).saturating_sub(named))
        );
        eprintln!(
            "    canonical {} + annex {} rows; annex-only groups dropped: {} ({} rows)",
            stats.printing_count,
            stats.foreign_printing_count,
            stats.annex_only_oracles_dropped,
            stats.annex_only_rows_dropped
        );
    }

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

// ─── Partitioned build (Cloudflare deployment machinery) ─────────────────────
// The deploy-path twin of the nightly coordinator's partition loop: cut the same rows into N
// archives by the same hash, so a deploy-seeded store and a nightly-built store route
// identically. N is COMPUTED, never a constant (plan decision 3b) — the router reads it from the
// manifest this emits.

/// Names the partition-assignment function in the manifest; must equal store-kv.ts's
/// PARTITION_HASH_ALGO or every loader refuses the manifest (deliberately — routing by the wrong
/// hash makes cards silently vanish from single-card routes).
#[cfg(not(target_arch = "wasm32"))]
pub const PARTITION_HASH_ALGO: &str = "fnv1a64/oracle_id/v1";

/// The auto-scale rule: enough partitions that each lands near this size. The clamp floor of 2
/// keeps the partitioned code paths exercised even on a small corpus, and the ceiling of 32
/// bounds fan-out width.
///
/// MUST STAY <= store-kv.ts's KV_CHUNK_BYTES, and that is the binding reason for the value —
/// the same reason, in the same words, as its twin in src/import-publish.ts, which this number
/// mirrors: `kvArchiveStream` pulls a partition's chunks strictly in sequence, so a partition
/// whose raw bytes cross the 46_000_000 chunk cut costs an extra sequential round trip on every
/// cold load. At 48MB the real corpus measured 42-46MB partitions and five of eight took a
/// second, nearly-empty chunk — 13 chunks where the design says 8. 43MB sits under the cut with
/// room for the projection's own error.
#[cfg(not(target_arch = "wasm32"))]
const TARGET_PARTITION_BYTES: u64 = 43_000_000;
#[cfg(not(target_arch = "wasm32"))]
const MIN_PARTITIONS: u32 = 2;
#[cfg(not(target_arch = "wasm32"))]
const MAX_PARTITIONS: u32 = 32;

/// Projected PARTITIONED store bytes per SPILLED DRAFT byte — how the deploy path's
/// `--partitions auto` sizes N, and the exact twin of src/import-publish.ts's
/// `DRAFT_TO_STORE_RATIO`.
///
/// DENOMINATOR: the coordinator's staging measure, Σ(8 + RowDraft JSON) — the same framing the
/// nightly stages drafts in ([8B partition hash][draft JSON]), which is why the two constants
/// can be one number. Measured on the real multilingual corpus (517,746 drafts,
/// 1,552,683,467 framed bytes = 1,480.8MB): 353.3MB of archives at N=8, 365.5MB at N=32 —
/// 0.239 and 0.247. 0.24 projects today's corpus to nine ~40MB partitions.
///
/// NEVER project from a single-archive measurement build: the N=1 shape is SUPERLINEAR — the
/// same rows build a 1,792.8MB single archive, ~1.4GB of quadratic-class index remainder that
/// vanishes when the corpus is cut — so a one-bucket measurement projected N = 38, clamped to
/// 32, when the honest target was 8. Hitting the clamp ceiling IS the "projection input is
/// garbage" signal, and projecting from staged bytes is the fix.
#[cfg(not(target_arch = "wasm32"))]
const SPILLED_DRAFT_TO_STORE_RATIO: f64 = 0.24;

/// The same projection over a different base: standalone ROW-JSON blobs, for the in-memory
/// `build_store_partitioned` (the differential harness's arm — the deploy path spills).
/// Measured in the same G2 run: 353.3MB / 365.5MB of archives from 1,785.7MB of row blobs,
/// ratio 0.198–0.205; 0.21 errs a partition-count's breadth toward more. Same fact as
/// `SPILLED_DRAFT_TO_STORE_RATIO`, different denominator — keep the two comments in step.
#[cfg(not(target_arch = "wasm32"))]
const PARTITION_ROW_TO_STORE_RATIO: f64 = 0.21;

/// `clamp(ceil(projected_store_bytes / TARGET_PARTITION_BYTES), MIN, MAX)` — plan Decision 3b,
/// and the line-for-line twin of import-publish.ts's `partitionCountFor`.
#[cfg(not(target_arch = "wasm32"))]
fn partition_count_for(staged_bytes: u64, ratio: f64, base: &str) -> u32 {
    let projected = (staged_bytes as f64 * ratio) as u64;
    let n = projected
        .div_ceil(TARGET_PARTITION_BYTES)
        .clamp(u64::from(MIN_PARTITIONS), u64::from(MAX_PARTITIONS)) as u32;
    eprintln!(
        "  staged {:.1}MB of {base} x {ratio} -> projected {:.1}MB -> {n} partitions (target {}MB each)",
        staged_bytes as f64 / 1_048_576.0,
        projected as f64 / 1_048_576.0,
        TARGET_PARTITION_BYTES / 1_000_000,
    );
    n
}

/// `--partitions` as parsed: auto-scaled from the build's own byte accounting, or pinned.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Copy)]
pub enum PartitionsArg {
    Auto,
    Fixed(u32),
}

/// Belt-and-braces startup assert: this binary's hash must agree with the committed Rust↔TS
/// vector file before it cuts anything. The vendored engine's own test suite pins the same
/// vectors, but the binary that ships archives should not depend on "the tests were run".
#[cfg(not(target_arch = "wasm32"))]
fn verify_partition_hash_vectors() -> Result<(), String> {
    let raw = include_str!("../../../tests/engine/partition-hash-vectors.json");
    let parsed: Value = serde_json::from_str(raw).map_err(|e| format!("partition-hash-vectors.json: {e}"))?;
    if parsed["algorithm"].as_str() != Some(PARTITION_HASH_ALGO) {
        return Err(format!(
            "partition hash vectors are for {:?}, this builder speaks {PARTITION_HASH_ALGO:?}",
            parsed["algorithm"]
        ));
    }
    let vectors = parsed["vectors"].as_array().ok_or("partition-hash-vectors.json has no vectors")?;
    for v in vectors.iter().take(8) {
        let oracle_id = v["oracle_id"].as_str().ok_or("vector missing oracle_id")?;
        let expected: u64 = v["fnv1a64"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .ok_or("vector fnv1a64 must be a decimal string")?;
        if card_engine::fnv1a64_oracle_id(oracle_id) != expected {
            return Err(format!("partition hash disagrees with the committed vectors on {oracle_id}"));
        }
    }
    Ok(())
}

/// Build a PARTITIONED store: N archives named `card-store-v<fmt>-<built_at>-p<k>.store` plus a
/// manifest-v2 skeleton (`src/engine/types.ts`'s `StoreManifest` shape — `partition_count`
/// present is the version discriminant). Skeleton: `chunk_count` is 0 on every partition here,
/// because the KV cut belongs to the publisher (seed-remote-kv computes it while chunking);
/// everything a router needs to HASH — partition_count, partition_hash — is final.
///
/// `Auto` projects N from the staged blob bytes (`PARTITION_ROW_TO_STORE_RATIO`); a fixed N
/// skips the projection. Rows are cut through the same standalone-blob path the differential
/// test proves against the unpartitioned build, and each partition builds through its own fresh
/// interners.
///
/// THIS ARM HOLDS THE WHOLE CORPUS (rows in, blobs staged) and is the differential harness's,
/// not the deploy path's — `build_store_partitioned_spilled` is what the binary runs.
#[cfg(not(target_arch = "wasm32"))]
pub fn build_store_partitioned(
    rows: impl Iterator<Item = Value>,
    out_dir: &Path,
    built_at: &str,
    partitions: PartitionsArg,
) -> Result<Value, Box<dyn std::error::Error>> {
    verify_partition_hash_vectors()?;
    let mut staged: Vec<(u64, Vec<u8>)> = Vec::new();
    // Computed BEFORE the cut, for the reason the cut exists: no partition sees the whole corpus.
    let mut artist_spellings = transform::ArtistSpellings::new();
    for (i, row) in rows.enumerate() {
        transform::observe_artist_spellings_row(&mut artist_spellings, &row);
        let (meta, blob) =
            card_engine::SpillingStoreBuilder::encode_standalone(&row).map_err(|e| format!("row {i}: {e}"))?;
        staged.push((meta.part_hash, blob));
    }
    let artist_entities = transform::artist_entity_table(&artist_spellings);

    let n = match partitions {
        PartitionsArg::Fixed(n) if n >= 1 => n,
        PartitionsArg::Fixed(n) => return Err(format!("--partitions {n} is not a partition count").into()),
        // Projection, never a measurement build: see SPILLED_DRAFT_TO_STORE_RATIO for why the
        // one shape a measurement pass could build (a single archive) is the one shape whose
        // size must not be projected from.
        PartitionsArg::Auto => partition_count_for(
            staged.iter().map(|(_, b)| b.len() as u64).sum(),
            PARTITION_ROW_TO_STORE_RATIO,
            "row blobs",
        ),
    };

    let mut buckets: Vec<Vec<Vec<u8>>> = vec![Vec::new(); n as usize];
    for (hash, blob) in staged {
        buckets[(hash % u64::from(n)) as usize].push(blob);
    }

    std::fs::create_dir_all(out_dir)?;
    let mut accum = PartitionAccum::new(built_at, n);
    for (k, blobs) in buckets.into_iter().enumerate() {
        let (mut counter, store_key) = accum.open(out_dir, k)?;
        let stats = card_engine::build_partition_from_standalone(blobs.into_iter(), artist_entities.clone(), &mut counter)
            .map_err(|e| format!("partition {k}: {e}"))?;
        counter.flush()?;
        accum.record(k, store_key, counter.written, &stats);
    }
    Ok(accum.finish())
}

/// The deploy path's build: the corpus never enters the heap.
///
/// Same cut, same rows, same archives as [`build_store_partitioned`] — the difference is only
/// where the corpus lives. Drafts come off the spill one at a time, are finalized against the
/// corpus-wide aggregates the spill pass already sealed, are teed to `rows_out` (rows.jsonl, the
/// local D1 seeder's and the gate's memprobe corpus) and fed straight into the partition's
/// archive. Nothing corpus-sized is resident at any point: one partition's drafts are read, its
/// archive is written, and its spill file is deleted before the next partition starts.
#[cfg(not(target_arch = "wasm32"))]
pub fn build_store_partitioned_spilled<W: Write>(
    corpus: spill::SpilledCorpus,
    tags: &tags::TagData,
    out_dir: &Path,
    built_at: &str,
    partitions: PartitionsArg,
    rows_out: &mut W,
) -> Result<Value, Box<dyn std::error::Error>> {
    verify_partition_hash_vectors()?;
    let n = match partitions {
        PartitionsArg::Fixed(n) if n >= 1 => n,
        PartitionsArg::Fixed(n) => return Err(format!("--partitions {n} is not a partition count").into()),
        PartitionsArg::Auto => {
            partition_count_for(corpus.framed_bytes, SPILLED_DRAFT_TO_STORE_RATIO, "staged drafts")
        }
    };

    std::fs::create_dir_all(out_dir)?;
    let (aggregates, mut parts) = corpus.demux(n, out_dir)?;
    // The one assumption the per-partition decomposition rests on that the data could violate:
    // a repeated scryfall_id whose two rows carry different oracle_ids would be deduped in one
    // partition and survive in another. Zero on every real corpus; loud rather than silent if
    // that ever changes.
    if aggregates.cross_partition_dupes > 0 {
        return Err(format!(
            "{} scryfall_id(s) repeat across oracle_ids — dedupe is no longer partition-local",
            aggregates.cross_partition_dupes
        )
        .into());
    }

    let rows_out = std::cell::RefCell::new(rows_out);
    let row_err = std::cell::Cell::new(false);
    // The routing filter's input (transform::routing_keys_of): `<partition>\t<key>` per line,
    // written HERE because this is the only pass where a finalized row and the partition that
    // owns it are both in hand — the spill's own frame carries the raw hash, and N is not chosen
    // until several lines above. `scripts/seed-remote-kv.ts` turns the file into the KV value.
    let routing_path = out_dir.join("routing-keys.tsv");
    let routing_out = std::cell::RefCell::new(BufWriter::with_capacity(
        1 << 20,
        std::fs::File::create(&routing_path).map_err(|e| format!("create routing-keys.tsv: {e}"))?,
    ));
    let mut routing_count = 0u64;
    let artist_entities = aggregates.artist_entities();
    let mut accum = PartitionAccum::new(built_at, n);
    for k in 0..n as usize {
        let (mut counter, store_key) = accum.open(out_dir, k)?;
        let mut rows = parts.rows(k, &aggregates, tags)?;
        let routing_here = std::cell::Cell::new(0u64);
        let stats = {
            // `encode_standalone`'s blob IS the row's compact JSON, which is also rows.jsonl's
            // line — so the tee and the build share ONE serialization instead of each doing
            // their own (1.7GB of it, on today's corpus).
            let mut keys: Vec<String> = Vec::with_capacity(8);
            let blobs = rows.by_ref().map(|row| {
                keys.clear();
                transform::routing_keys_of_row(&row, &mut keys);
                {
                    let mut r = routing_out.borrow_mut();
                    for key in &keys {
                        if writeln!(r, "{k}\t{key}").is_err() {
                            row_err.set(true);
                        }
                    }
                }
                routing_here.set(routing_here.get() + keys.len() as u64);
                let bytes = serde_json::to_vec(&row).unwrap_or_else(|_| {
                    row_err.set(true);
                    Vec::new()
                });
                let mut out = rows_out.borrow_mut();
                if out.write_all(&bytes).and_then(|()| out.write_all(b"\n")).is_err() {
                    row_err.set(true);
                }
                bytes
            });
            card_engine::build_partition_from_standalone(blobs, artist_entities.clone(), &mut counter)
                .map_err(|e| format!("partition {k}: {e}"))?
        };
        if let Some(e) = rows.take_error() {
            return Err(format!("partition {k}: {e}").into());
        }
        if row_err.get() {
            return Err("encoding a finalized row or writing rows.jsonl failed".to_owned().into());
        }
        counter.flush()?;
        accum.record(k, store_key, counter.written, &stats);
        routing_count += routing_here.get();
        // This partition is published to disk; its drafts are dead weight from here.
        parts.release(k);
    }
    routing_out.borrow_mut().flush().map_err(|e| format!("flush routing-keys.tsv: {e}"))?;
    eprintln!("wrote {} ({routing_count} routing keys)", routing_path.display());
    Ok(accum.finish())
}

/// The unpartitioned twin of [`build_store_partitioned_spilled`]: one archive, still built
/// without the corpus in the heap. Nothing in production emits this shape (both scripts pass
/// `--partitions auto`), but the flagless path must not be the one that still OOMs.
#[cfg(not(target_arch = "wasm32"))]
pub fn build_store_spilled<W: Write>(
    corpus: &spill::SpilledCorpus,
    tags: &tags::TagData,
    out_dir: &Path,
    built_at: &str,
    rows_out: &mut W,
) -> Result<Manifest, Box<dyn std::error::Error>> {
    let mut rows = corpus.rows(tags)?;
    let tee_err = std::cell::Cell::new(false);
    let manifest = {
        let teed = rows.by_ref().inspect(|row| {
            if writeln!(rows_out, "{row}").is_err() {
                tee_err.set(true);
            }
        });
        build_store(teed, out_dir, built_at)?
    };
    if let Some(e) = rows.take_error() {
        return Err(e.into());
    }
    if tee_err.get() {
        return Err("write rows.jsonl failed".to_owned().into());
    }
    Ok(manifest)
}

/// The per-partition manifest records and running totals, plus the per-partition log line —
/// shared by both partitioned builds so the two cannot describe the same archives differently.
#[cfg(not(target_arch = "wasm32"))]
struct PartitionAccum {
    built_at: String,
    format_version: u32,
    n: u32,
    records: Vec<Value>,
    total_bytes: u64,
    total_cards: usize,
    total_printings: usize,
    total_foreign: usize,
    dropped_oracles: usize,
    dropped_rows: usize,
}

#[cfg(not(target_arch = "wasm32"))]
impl PartitionAccum {
    fn new(built_at: &str, n: u32) -> Self {
        PartitionAccum {
            built_at: built_at.to_owned(),
            format_version: store_format_version(),
            n,
            records: Vec::with_capacity(n as usize),
            total_bytes: 0,
            total_cards: 0,
            total_printings: 0,
            total_foreign: 0,
            dropped_oracles: 0,
            dropped_rows: 0,
        }
    }

    /// Partition k's archive file, open and counting, plus the key it publishes under.
    fn open(&self, out_dir: &Path, k: usize) -> Result<(ArchiveWriter, String), Box<dyn std::error::Error>> {
        let store_key = format!("card-store-v{}-{}-p{k}.store", self.format_version, self.built_at);
        let file = std::fs::File::create(out_dir.join(&store_key))?;
        Ok((CountingWriter { inner: BufWriter::with_capacity(1 << 20, file), written: 0 }, store_key))
    }

    fn record(&mut self, k: usize, store_key: String, written: u64, stats: &card_engine::StoreStats) {
        eprintln!(
            "  p{k}: {:.1}MB, {} cards, {} canonical printings, {} annex rows",
            written as f64 / 1_048_576.0,
            stats.card_count,
            stats.printing_count,
            stats.foreign_printing_count
        );
        self.total_bytes += written;
        self.total_cards += stats.card_count;
        self.total_printings += stats.printing_count;
        self.total_foreign += stats.foreign_printing_count;
        self.dropped_oracles += stats.annex_only_oracles_dropped;
        self.dropped_rows += stats.annex_only_rows_dropped;
        self.records.push(serde_json::json!({
            "store_key": store_key,
            "store_bytes": written,
            "chunk_count": 0, // skeleton: the KV publisher computes the real cut
            "card_count": stats.card_count,
            "printing_count": stats.printing_count,
        }));
    }

    fn finish(self) -> Value {
        // The annex line is the multilingual build's own smoke test: `foreign` at zero means the
        // corpus was English-only (the all_cards stream went missing), and a LARGE drop count
        // means the canonical feed did — see StoreStats::annex_only_oracles_dropped, which
        // expects 3 on today's real corpus (the ja 4ED ante printings).
        eprintln!(
            "  totals: {} cards, {} canonical + {} annex rows; annex-only groups dropped: {} ({} rows)",
            self.total_cards, self.total_printings, self.total_foreign, self.dropped_oracles, self.dropped_rows
        );
        serde_json::json!({
            "store_key": format!("card-store-v{}-{}.store", self.format_version, self.built_at),
            "built_at": self.built_at,
            "card_count": self.total_cards,
            "printing_count": self.total_printings,
            "upstream_commit": upstream_commit(),
            "format_version": self.format_version,
            "store_bytes": self.total_bytes,
            "partition_count": self.n,
            "partition_hash": PARTITION_HASH_ALGO,
            "partitions": self.records,
        })
    }
}

/// What a partition's archive streams out through: buffered file, bytes counted.
#[cfg(not(target_arch = "wasm32"))]
type ArchiveWriter = CountingWriter<BufWriter<std::fs::File>>;

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
