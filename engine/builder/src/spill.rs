//! The corpus on disk instead of in the heap — the native builder's memory
//! ceiling, removed.
//!
//! `run_import` used to hold every draft in one `Vec<RowDraft>` and run ONE
//! global `transform::finalize` over it, which measured 7.4GiB peak RSS on the
//! real 517,746-row multilingual corpus against Workers Builds' 8GB: a 1-2 year
//! runway, where both other memory ceilings in this program (the 128MB serving
//! DO, the 124MiB nightly wasm build) auto-scale with `partition_count` and
//! have decades. This module is the decomposition the nightly coordinator
//! already runs (plan B3: `agg → finalize → build` ONCE PER PARTITION, correct
//! because `hash(oracle_id)` co-locates every printing of a card), applied to
//! the native path:
//!
//!   1. one streaming pass over `all_cards`: transform each row and APPEND its
//!      draft to a spill file, keeping only the small corpus-wide aggregates
//!      (below) resident;
//!   2. pick N from the measured spilled bytes;
//!   3. demux the spill into N per-partition files (one pass);
//!   4. per partition, in turn: read only that partition's drafts, finalize
//!      them, build that archive, drop everything.
//!
//! WHAT STAYS RESIDENT, AND WHY IT HAS TO. Two of `finalize`'s passes are not
//! oracle-local, so they cannot be cut per partition without changing the rows:
//!
//!   * `cubecobra_score` is a PERCENT_RANK over the distinct card names of the
//!     whole corpus (`cubecobra_scores_from_pairs`). Computed over 1/Nth of the
//!     names it produces different numbers for the same card — and the archive
//!     stores the value and sorts on it (`orderby=cubecobra`). Genuinely global.
//!   * `illustration_count` counts rows sharing (illustration_id, card_name),
//!     which is oracle-local in practice but keyed by name rather than by
//!     oracle_id, so nothing in the data model forbids a cross-partition group.
//!
//! Both are cheap to keep GLOBAL while the corpus itself streams: this pass
//! holds one interned record per printing (~32B) plus the two id→slot maps —
//! tens of MB, not gigabytes — so the finalized rows are byte-identical to the
//! ones the single-`Vec` path produced, which
//! `spilled_rows_match_the_in_memory_finalize` below asserts.
//!
//! The pin slots (`PinnedPrintings`) ride along in the same pass. They ARE
//! oracle-local — the key carries the oracle_id — so a partition could compute
//! them for itself; they are collected here because this pass is already the
//! one place every draft passes with the labels in hand.
//!
//! THE OTHER PUBLISHER runs `agg(p)` over one partition's drafts
//! (import-coordinator.ts's loop) and so can compute NEITHER of these there. It
//! takes both from its own global `scores` phase (`transform::CorpusTables`),
//! sealed before the loop opens and carried in the TagData snapshot. The two
//! publishers therefore rank and count over the same corpus, through the same
//! `cubecobra_scores_from_pairs` and the same `illust_count_qualifies`.
//!
//! Spill records are framed `[u64 le part_hash][u32 le len][draft JSON]`. The
//! hash is the raw fnv1a64 of oracle_id, never a partition index, for the same
//! reason `RowMeta::part_hash` is: N is chosen AFTER the corpus is measured, so
//! the staged bytes must be cuttable at any N.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ranks::PrintingRanks;
use crate::tags::TagData;
use crate::transform::{
    cubecobra_scores_from_pairs, finalize_row, illust_count_key, is_pinned, PinnedPrintings, RowDraft,
};

/// Bytes of framing the COORDINATOR counts around each staged draft
/// ([8B partition hash][draft JSON]) — the denominator
/// `SPILLED_DRAFT_TO_STORE_RATIO` is measured against, kept identical to
/// src/import-publish.ts's so the two projections are the same number. This
/// file's own 4-byte length prefix is deliberately NOT counted: it is this
/// path's private framing (~2MB on today's corpus), and counting it would make
/// the two constants describe different bases.
const COORDINATOR_FRAME_BYTES: u64 = 8;

/// Deletes the files it names when it drops — so a spill never survives the
/// process, on the success path or on any `?` between here and the manifest.
#[derive(Default)]
struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl TempFiles {
    fn forget(&mut self, path: &Path) {
        self.0.retain(|p| p != path);
    }
}

/// String → dense id, so the aggregation pass holds one copy of each card name
/// and illustration id rather than one per printing.
#[derive(Default)]
struct Interner {
    index: HashMap<String, u32>,
    values: Vec<String>,
}

impl Interner {
    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.index.get(s) {
            return i;
        }
        let i = self.values.len() as u32;
        self.values.push(s.to_owned());
        self.index.insert(s.to_owned(), i);
        i
    }

    fn get(&self, i: u32) -> &str {
        &self.values[i as usize]
    }
}

/// `illust_id` value meaning "this row does not qualify for illustration counting"
/// (`illust_count_key` returned None).
const NO_ILLUST: u32 = u32::MAX;

/// What the aggregation pass keeps for one deduped printing. 32 bytes: the
/// strings live in the interners, and the draft itself lives on disk.
struct Winner {
    /// Position of the row that currently WINS this scryfall_id (last-wins).
    record: u64,
    part_hash: u64,
    name_id: u32,
    illust_id: u32,
    edhrec: Option<i64>,
}

/// `finalize`'s corpus-wide passes, run while the corpus streams past.
struct CorpusAggregator<'a> {
    /// scryfall_id → winner slot; slots are in FIRST-SEEN order, which is the
    /// order `finalize`'s dedupe produces and the order both derived tables
    /// depend on.
    by_id: HashMap<String, u32>,
    names: Interner,
    illusts: Interner,
    winners: Vec<Winner>,
    superseded: HashSet<u64>,
    /// Duplicate scryfall_ids whose two rows carry DIFFERENT oracle_ids — the
    /// one shape that would make dedupe non-partition-local. Reported, not
    /// tolerated silently.
    cross_partition_dupes: u64,
    /// Scryfall's representative labels, borrowed for the length of the stream:
    /// the pin slots below are collected as rows go past, so the labels must be
    /// in hand BEFORE the corpus is streamed (main.rs fetches oracle_cards
    /// first for exactly this reason).
    labels: &'a HashSet<String>,
    pins: PinnedPrintings,
    /// The per-card printing order the representative choice falls back on when a filter
    /// excludes the pinned printing (`ranks`). Collected as rows stream past, for the same
    /// reason `pins` is, and sealed against them at the end of the stream.
    ranks: PrintingRanks,
    /// Every artist's credited spellings, corpus-wide — see `transform::ArtistSpellings`.
    artist_spellings: crate::transform::ArtistSpellings,
}

impl<'a> CorpusAggregator<'a> {
    fn new(labels: &'a HashSet<String>) -> Self {
        CorpusAggregator {
            by_id: HashMap::new(),
            names: Interner::default(),
            illusts: Interner::default(),
            winners: Vec::new(),
            superseded: HashSet::new(),
            cross_partition_dupes: 0,
            labels,
            pins: PinnedPrintings::default(),
            ranks: PrintingRanks::default(),
            artist_spellings: crate::transform::ArtistSpellings::new(),
        }
    }

    fn observe(&mut self, record: u64, part_hash: u64, draft: &RowDraft) {
        self.pins.observe(draft, self.labels);
        self.ranks.observe(draft);
        crate::transform::observe_artist_spellings(&mut self.artist_spellings, draft.card_artist.as_deref(), &draft.compat_blob);
        let info = Winner {
            record,
            part_hash,
            name_id: self.names.intern(&draft.card_name),
            illust_id: illust_count_key(draft).map_or(NO_ILLUST, |ill| self.illusts.intern(ill)),
            edhrec: draft.edhrec_rank,
        };
        match self.by_id.get(&draft.scryfall_id).copied() {
            // Last-wins on content, first-seen on POSITION — exactly
            // `finalize`'s dedupe, which overwrites `rows[i]` in place.
            Some(slot) => {
                let prev = &mut self.winners[slot as usize];
                self.superseded.insert(prev.record);
                if prev.part_hash != info.part_hash {
                    self.cross_partition_dupes += 1;
                }
                *prev = info;
            }
            None => {
                self.by_id.insert(draft.scryfall_id.clone(), self.winners.len() as u32);
                self.winners.push(info);
            }
        }
    }

    fn seal(self) -> Aggregates {
        let CorpusAggregator {
            names,
            illusts,
            winners,
            superseded,
            cross_partition_dupes,
            by_id,
            pins,
            mut ranks,
            artist_spellings,
            labels: _,
        } = self;
        drop(by_id);
        // The order asks "is this slot pinned" first, so it can only be frozen once every row
        // has gone past and `pins` is complete.
        ranks.seal(&pins);

        // illustration_count: COUNT(*) over deduped rows sharing
        // (illustration_id, card_name) among the qualifying rows.
        let mut illust_counts: HashMap<(String, String), u64> = HashMap::new();
        for w in &winners {
            if w.illust_id != NO_ILLUST {
                let key = (illusts.get(w.illust_id).to_owned(), names.get(w.name_id).to_owned());
                *illust_counts.entry(key).or_insert(0) += 1;
            }
        }

        // DISTINCT ON (card_name) in first-seen order, then the percent-rank —
        // the same call `cubecobra_scores_by_name` makes over the whole Vec.
        let mut seen: HashSet<u32> = HashSet::new();
        let mut per_name: Vec<(&str, Option<i64>)> = Vec::with_capacity(names.values.len());
        for w in &winners {
            if seen.insert(w.name_id) {
                per_name.push((names.get(w.name_id), w.edhrec));
            }
        }
        let cubecobra = cubecobra_scores_from_pairs(&per_name);
        drop(per_name);

        Aggregates {
            rows: winners.len() as u64,
            illust_counts,
            cubecobra,
            pins,
            ranks,
            artist_spellings,
            superseded,
            cross_partition_dupes,
        }
    }
}

/// The sealed corpus-wide aggregates, plus everything a later pass needs to
/// reproduce `finalize`'s dedupe without holding the drafts.
pub struct Aggregates {
    /// Deduped rows — what `finalize` would have yielded.
    pub rows: u64,
    illust_counts: HashMap<(String, String), u64>,
    cubecobra: HashMap<String, f64>,
    /// The (set, collector-number) slots Scryfall's labels named, so the pin reaches every
    /// language's edition of the labelled printing (see `transform::PIN_BONUS`). Collected as
    /// rows stream past rather than from the deduped winners, which differs only for a repeated
    /// scryfall_id that also moved collector number — a shape `cross_partition_dupes` already
    /// refuses the milder version of.
    pins: PinnedPrintings,
    /// Where each printing slot sits in its card's order — the representative choice for every
    /// filter the pinned printing does not survive (`ranks`).
    ranks: PrintingRanks,
    /// Every credited spelling of every artist, corpus-wide — the input to the `card_artist_alt`
    /// column. Observed as rows STREAM PAST rather than from the deduped winners, exactly as
    /// `pins` is, and for the same reason: a repeated scryfall_id cannot change who drew the card.
    /// See `transform::ArtistSpellings` for why this cannot be derived inside a partition build.
    artist_spellings: crate::transform::ArtistSpellings,
    /// Spill record positions a LATER duplicate superseded; skipped on replay.
    /// Empty on every real corpus (Scryfall ids are unique) — it exists so a
    /// corpus that does repeat one is deduped identically rather than doubled.
    superseded: HashSet<u64>,
    pub cross_partition_dupes: u64,
}

impl Aggregates {
    /// The corpus's artist-entity relation, handed to each partition's builder once — see
    /// `transform::artist_entity_table` for why it cannot ride the rows.
    pub fn artist_entities(&self) -> Value {
        crate::transform::artist_entity_table(&self.artist_spellings)
    }

    /// One draft → its finalized ENGINE_COLUMNS row, through the same
    /// `finalize_row` every other import path calls, with the same corpus-wide
    /// aggregation inputs the single-`Vec` `finalize` computed.
    pub fn finalize(&self, draft: RowDraft, tags: &TagData) -> Value {
        const EMPTY: &[u32] = &[];
        let oracle_tags = tags.resolve(tags.oracle.get(&draft.oracle_id).map_or(EMPTY, Vec::as_slice));
        let art_tags = crate::transform::art_tags_of(tags, &draft);
        let illustration_count = draft
            .illustration_id
            .as_ref()
            .and_then(|ill| self.illust_counts.get(&(ill.clone(), draft.card_name.clone())))
            .copied()
            .unwrap_or(0);
        let cubecobra_score = self.cubecobra.get(&draft.card_name).copied();
        let pinned = is_pinned(&draft, &tags.labels, &self.pins);
        let rank = self.ranks.rank_of(&draft);
        finalize_row(draft, &oracle_tags, &art_tags, illustration_count, cubecobra_score, pinned, rank)
    }
}

/// The spill being written: one append-only file plus the aggregation pass.
pub struct DraftSpill<'a> {
    path: PathBuf,
    out: BufWriter<File>,
    agg: CorpusAggregator<'a>,
    records: u64,
    framed_bytes: u64,
    temp: TempFiles,
    scratch: Vec<u8>,
}

impl<'a> DraftSpill<'a> {
    /// Create the spill file under `dir` (the build's own out dir, so the spill
    /// lives on the same filesystem as the archives it feeds).
    ///
    /// `labels` is Scryfall's representative set (the `oracle_cards` ids). It is taken HERE, not
    /// at finalize time, because the pin now propagates by printing slot: the labelled row's
    /// (set, collector_number) is only knowable while its row goes past.
    pub fn create(dir: &Path, labels: &'a HashSet<String>) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let path = dir.join("drafts.spill");
        let file = File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
        Ok(DraftSpill {
            out: BufWriter::with_capacity(1 << 20, file),
            temp: TempFiles(vec![path.clone()]),
            path,
            agg: CorpusAggregator::new(labels),
            records: 0,
            framed_bytes: 0,
            scratch: Vec::with_capacity(4096),
        })
    }

    /// Append one draft, observing it for the corpus-wide aggregates.
    pub fn append(&mut self, draft: &RowDraft) -> Result<(), String> {
        self.scratch.clear();
        serde_json::to_writer(&mut self.scratch, draft).map_err(|e| format!("encode draft: {e}"))?;
        let part_hash = card_engine::fnv1a64_oracle_id(&draft.oracle_id);
        let len = u32::try_from(self.scratch.len()).map_err(|_| "draft larger than 4GB".to_owned())?;
        self.out
            .write_all(&part_hash.to_le_bytes())
            .and_then(|()| self.out.write_all(&len.to_le_bytes()))
            .and_then(|()| self.out.write_all(&self.scratch))
            .map_err(|e| format!("write spill: {e}"))?;
        self.agg.observe(self.records, part_hash, draft);
        self.records += 1;
        self.framed_bytes += COORDINATOR_FRAME_BYTES + u64::from(len);
        Ok(())
    }

    /// Rows appended so far (pre-dedupe) — the caller's progress counter.
    pub fn records(&self) -> u64 {
        self.records
    }

    /// Seal the file and the aggregates.
    pub fn finish(mut self) -> Result<SpilledCorpus, String> {
        self.out.flush().map_err(|e| format!("flush spill: {e}"))?;
        drop(self.out);
        Ok(SpilledCorpus {
            path: self.path,
            records: self.records,
            framed_bytes: self.framed_bytes,
            aggregates: self.agg.seal(),
            temp: self.temp,
        })
    }
}

/// A finished spill: every draft on disk, every corpus-wide aggregate in hand.
pub struct SpilledCorpus {
    path: PathBuf,
    /// Records written (pre-dedupe).
    pub records: u64,
    /// Σ (8 + draft JSON bytes) — the coordinator's staging measure, which is
    /// what `SPILLED_DRAFT_TO_STORE_RATIO` is calibrated against.
    pub framed_bytes: u64,
    pub aggregates: Aggregates,
    temp: TempFiles,
}

impl SpilledCorpus {
    /// Cut the spill into N per-partition files by `part_hash % n`, dropping
    /// superseded duplicates on the way through, and DELETE the single spill
    /// the moment its last record has been read. Scratch disk therefore holds
    /// two copies of the corpus for the length of THIS pass and one afterwards,
    /// falling further as `PartitionSpills::release` frees each partition.
    /// Per-partition records are `[u32 le len][draft JSON]`; the hash has done
    /// its job by then.
    ///
    /// Consumes the corpus (its file is gone afterwards) and hands the
    /// aggregates back, because every per-partition finalize still needs them.
    pub fn demux(mut self, n: u32, dir: &Path) -> Result<(Aggregates, PartitionSpills), String> {
        let mut temp = TempFiles::default();
        let mut writers = Vec::with_capacity(n as usize);
        let mut paths = Vec::with_capacity(n as usize);
        for k in 0..n {
            let path = dir.join(format!("drafts-p{k}.spill"));
            let file = File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
            temp.0.push(path.clone());
            paths.push(path);
            writers.push(BufWriter::with_capacity(1 << 19, file));
        }
        let mut counts = vec![0u64; n as usize];

        let mut reader = SpillReader::open(&self.path)?;
        let mut index = 0u64;
        while let Some((part_hash, blob)) = reader.next_framed()? {
            if !self.aggregates.superseded.contains(&index) {
                let k = (part_hash % u64::from(n)) as usize;
                let len = u32::try_from(blob.len()).map_err(|_| "draft larger than 4GB".to_owned())?;
                writers[k]
                    .write_all(&len.to_le_bytes())
                    .and_then(|()| writers[k].write_all(blob))
                    .map_err(|e| format!("write partition spill {k}: {e}"))?;
                counts[k] += 1;
            }
            index += 1;
        }
        drop(reader);
        for (k, w) in writers.iter_mut().enumerate() {
            w.flush().map_err(|e| format!("flush partition spill {k}: {e}"))?;
        }
        drop(writers);

        std::fs::remove_file(&self.path).map_err(|e| format!("remove {}: {e}", self.path.display()))?;
        self.temp.forget(&self.path);
        Ok((self.aggregates, PartitionSpills { paths, counts, temp }))
    }

    /// Replay the WHOLE spill as finalized rows — the unpartitioned build's
    /// source, the same rows in the same order the single-`Vec` path produced.
    pub fn rows<'a>(&'a self, tags: &'a TagData) -> Result<FinalizedRows<'a>, String> {
        Ok(FinalizedRows {
            reader: SpillReader::open(&self.path)?,
            framed: true,
            index: 0,
            superseded: Some(&self.aggregates.superseded),
            aggregates: &self.aggregates,
            tags,
            error: None,
        })
    }
}

/// The demuxed per-partition spill files.
pub struct PartitionSpills {
    paths: Vec<PathBuf>,
    counts: Vec<u64>,
    temp: TempFiles,
}

impl PartitionSpills {
    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// Drafts of partition `k`, finalized. Nothing else is read or held.
    pub fn rows<'a>(&'a self, k: usize, aggregates: &'a Aggregates, tags: &'a TagData) -> Result<FinalizedRows<'a>, String> {
        Ok(FinalizedRows {
            reader: SpillReader::open(&self.paths[k])?,
            framed: false,
            index: 0,
            superseded: None,
            aggregates,
            tags,
            error: None,
        })
    }

    /// Drafts routed to partition `k` (post-dedupe).
    pub fn count(&self, k: usize) -> u64 {
        self.counts[k]
    }

    /// This partition's spill is spent — reclaim its disk before the next one
    /// is read, so scratch usage falls as the loop advances.
    pub fn release(&mut self, k: usize) {
        let path = self.paths[k].clone();
        let _ = std::fs::remove_file(&path);
        self.temp.forget(&path);
    }
}

/// Sequential reader over either framing (`[hash][len][json]` or `[len][json]`).
struct SpillReader {
    inner: BufReader<File>,
    buf: Vec<u8>,
}

impl SpillReader {
    fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        Ok(SpillReader { inner: BufReader::with_capacity(1 << 20, file), buf: Vec::new() })
    }

    /// Next `[u64 hash][u32 len][json]` record, or None at a clean EOF.
    fn next_framed(&mut self) -> Result<Option<(u64, &[u8])>, String> {
        let mut head = [0u8; 12];
        match self.inner.read_exact(&mut head) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(format!("read spill: {e}")),
        }
        let hash = u64::from_le_bytes(head[..8].try_into().expect("8 bytes"));
        let len = u32::from_le_bytes(head[8..].try_into().expect("4 bytes")) as usize;
        self.read_body(len)?;
        Ok(Some((hash, &self.buf)))
    }

    /// Next `[u32 len][json]` record, or None at a clean EOF.
    fn next_plain(&mut self) -> Result<Option<&[u8]>, String> {
        let mut head = [0u8; 4];
        match self.inner.read_exact(&mut head) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(format!("read spill: {e}")),
        }
        let len = u32::from_le_bytes(head) as usize;
        self.read_body(len)?;
        Ok(Some(&self.buf))
    }

    fn read_body(&mut self, len: usize) -> Result<(), String> {
        self.buf.clear();
        self.buf.resize(len, 0);
        self.inner
            .read_exact(&mut self.buf)
            .map_err(|e| format!("read spill body ({len} bytes): {e}"))
    }
}

/// Finalized rows streamed out of a spill file: one draft in memory at a time.
///
/// `Iterator` rather than a fallible loop so it drops straight into
/// `build_store` / `build_partition_from_standalone`, which take iterators —
/// an I/O or parse failure ENDS the stream and is retrieved with
/// [`FinalizedRows::take_error`], which every caller checks before treating a
/// build as finished (a truncated stream must never publish as a store).
pub struct FinalizedRows<'a> {
    reader: SpillReader,
    framed: bool,
    index: u64,
    superseded: Option<&'a HashSet<u64>>,
    aggregates: &'a Aggregates,
    tags: &'a TagData,
    error: Option<String>,
}

impl FinalizedRows<'_> {
    /// The failure that ended the stream early, if any.
    pub fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }
}

impl Iterator for FinalizedRows<'_> {
    type Item = Value;

    fn next(&mut self) -> Option<Value> {
        loop {
            let next = if self.framed {
                self.reader.next_framed().map(|o| o.map(|(_, b)| b))
            } else {
                self.reader.next_plain()
            };
            let bytes = match next {
                Ok(Some(bytes)) => bytes,
                Ok(None) => return None,
                Err(e) => {
                    self.error = Some(e);
                    return None;
                }
            };
            let index = self.index;
            self.index += 1;
            if self.superseded.is_some_and(|s| s.contains(&index)) {
                continue;
            }
            let draft: RowDraft = match serde_json::from_slice(bytes) {
                Ok(draft) => draft,
                Err(e) => {
                    self.error = Some(format!("spill record {index}: {e}"));
                    return None;
                }
            };
            return Some(self.aggregates.finalize(draft, self.tags));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::{finalize, transform_row};

    fn fixture(name: &str) -> Value {
        let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The English fixtures plus the two foreign ones — enough distinct oracle
    /// ids to land in different partitions, and enough distinct names for the
    /// cubecobra percent-rank to have something to rank.
    fn corpus_drafts() -> Vec<RowDraft> {
        ["lightning_bolt", "llanowar_elves", "jace_the_mind_sculptor", "delver_of_secrets", "delver_es", "shock_ja"]
            .iter()
            .filter_map(|name| {
                let canonical = !name.ends_with("_es") && !name.ends_with("_ja");
                transform_row(&fixture(name), canonical).expect("transform")
            })
            .collect()
    }

    /// A private directory per test run: pid AND clock, so two suites running
    /// at once (or one re-run while another still holds a dir) cannot collide
    /// on a spill file whose whole point is that it is deleted underneath it.
    fn scratch(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let dir = std::env::temp_dir().join(format!("sylvan-spill-{tag}-{}-{nanos}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn spill_of(drafts: &[RowDraft], dir: &Path) -> SpilledCorpus {
        spill_of_labelled(drafts, dir, &HashSet::new())
    }

    fn spill_of_labelled(drafts: &[RowDraft], dir: &Path, labels: &HashSet<String>) -> SpilledCorpus {
        let mut spill = DraftSpill::create(dir, labels).expect("spill");
        for draft in drafts {
            spill.append(draft).expect("append");
        }
        spill.finish().expect("finish")
    }

    /// THE CLAIM OF THIS MODULE, in one test: the spilled path's finalized rows
    /// are the single-`Vec` path's rows, byte for byte — same order, same
    /// aggregation inputs, same `finalize_row`. `cubecobra_score` is the field
    /// that only comes out right when the name set is the WHOLE corpus, which
    /// is why the aggregates stay global while the drafts go to disk.
    #[test]
    fn spilled_rows_match_the_in_memory_finalize() {
        let drafts = corpus_drafts();
        assert!(drafts.len() >= 4, "fixtures should survive the filters");
        let tags = TagData::default();
        let want: Vec<String> = finalize(drafts.clone(), &tags).map(|r| r.to_string()).collect();

        let dir = scratch("replay");
        let corpus = spill_of(&drafts, &dir);
        assert_eq!(corpus.records, drafts.len() as u64);
        assert_eq!(corpus.aggregates.rows, want.len() as u64);
        assert_eq!(corpus.aggregates.cross_partition_dupes, 0);

        let mut rows = corpus.rows(&tags).expect("replay");
        let got: Vec<String> = rows.by_ref().map(|r| r.to_string()).collect();
        assert!(rows.take_error().is_none(), "replay must not end early");
        assert_eq!(got, want, "spilled replay must reproduce finalize() exactly");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The per-partition cut is a partition of the SAME rows: every row lands
    /// in exactly one partition, and the union is the reference multiset.
    #[test]
    fn the_partition_cut_is_a_partition_of_the_same_rows() {
        let drafts = corpus_drafts();
        let tags = TagData::default();
        let mut want: Vec<String> = finalize(drafts.clone(), &tags).map(|r| r.to_string()).collect();

        let dir = scratch("cut");
        let corpus = spill_of(&drafts, &dir);
        let (aggregates, mut parts) = corpus.demux(3, &dir).expect("demux");
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.counts.iter().sum::<u64>(), want.len() as u64);

        let mut cut: Vec<String> = Vec::new();
        for k in 0..parts.len() {
            let mut rows = parts.rows(k, &aggregates, &tags).expect("partition rows");
            let part: Vec<String> = rows.by_ref().map(|r| r.to_string()).collect();
            assert!(rows.take_error().is_none());
            assert_eq!(part.len() as u64, parts.count(k));
            cut.extend(part);
            parts.release(k);
        }
        cut.sort();
        want.sort();
        assert_eq!(cut, want, "the union of the partitions is the reference corpus");

        // Every printing of one card is in ONE partition — the co-location
        // property the whole decomposition rests on.
        let by_oracle: HashSet<&str> = drafts.iter().map(|d| d.oracle_id.as_str()).collect();
        for oracle in by_oracle {
            let hashes: HashSet<u64> = drafts
                .iter()
                .filter(|d| d.oracle_id == oracle)
                .map(|d| card_engine::fnv1a64_oracle_id(&d.oracle_id) % 3)
                .collect();
            assert_eq!(hashes.len(), 1, "one card must not straddle partitions");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The pin propagates by printing SLOT through the spilled path too, and the rows are still
    /// the in-memory `finalize`'s rows — the labels have to be in hand before the corpus streams
    /// (main.rs fetches oracle_cards first), which is the one ordering this path depends on.
    #[test]
    fn a_label_pins_its_slot_through_the_spill() {
        // The Japanese Shock plus an English twin at the same (set, collector_number).
        let ja = transform_row(&fixture("shock_ja"), false).expect("t").expect("kept");
        let mut en = ja.clone();
        en.scryfall_id = "aaaaaaaa-0000-0000-0000-0000000000en".to_owned();
        en.raw_lang_en = true;
        en.is_canonical = true;
        // A third row of the same card in another slot, which the pin must not reach.
        let mut ja_other = ja.clone();
        ja_other.scryfall_id = "aaaaaaaa-0000-0000-0000-000000000345".to_owned();
        ja_other.collector_number = Some("345".to_owned());

        let mut tags = TagData::default();
        tags.labels.insert(en.scryfall_id.clone());
        let drafts = vec![en.clone(), ja.clone(), ja_other.clone()];
        let want: Vec<String> = finalize(drafts.clone(), &tags).map(|r| r.to_string()).collect();

        let dir = scratch("pin");
        let corpus = spill_of_labelled(&drafts, &dir, &tags.labels);
        let mut rows = corpus.rows(&tags).expect("replay");
        let got: Vec<Value> = rows.by_ref().collect();
        assert!(rows.take_error().is_none());
        assert_eq!(got.iter().map(Value::to_string).collect::<Vec<_>>(), want);

        // The pin lives in the components; the rank term above them is asserted by the
        // byte-equality against `finalize` just above (see `ranks`).
        let components = |i: usize| crate::ranks::split(got[i]["prefer_score"].as_f64().expect("score")).1;
        assert!(components(0) > 900.0, "the labelled printing is pinned");
        assert!(components(1) > 900.0, "so is its Japanese edition at the same slot");
        assert!(components(2) < 900.0, "and nothing else is");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A repeated scryfall_id is deduped last-wins, exactly as `finalize` does,
    /// and the superseded record never reaches a partition.
    #[test]
    fn a_repeated_id_is_deduped_last_wins() {
        let first = transform_row(&fixture("lightning_bolt"), true).expect("t").expect("kept");
        let mut second = first.clone();
        second.flavor_text = "the later row wins".to_owned();
        let tags = TagData::default();
        let want: Vec<String> =
            finalize(vec![first.clone(), second.clone()], &tags).map(|r| r.to_string()).collect();
        assert_eq!(want.len(), 1);

        let dir = scratch("dupe");
        let corpus = spill_of(&[first, second], &dir);
        assert_eq!(corpus.records, 2);
        assert_eq!(corpus.aggregates.rows, 1, "the duplicate is deduped before anything is counted");
        let mut rows = corpus.rows(&tags).expect("replay");
        let got: Vec<String> = rows.by_ref().map(|r| r.to_string()).collect();
        assert!(rows.take_error().is_none());
        assert_eq!(got, want);

        let (_, parts) = corpus.demux(2, &dir).expect("demux");
        assert_eq!(parts.counts.iter().sum::<u64>(), 1, "a superseded record is not demuxed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A truncated spill fails the build instead of publishing a short store.
    #[test]
    fn a_truncated_spill_reports_an_error() {
        let drafts = corpus_drafts();
        let dir = scratch("truncated");
        let corpus = spill_of(&drafts, &dir);
        let path = corpus.path.clone();
        let bytes = std::fs::read(&path).expect("read spill");
        std::fs::write(&path, &bytes[..bytes.len() - 32]).expect("truncate");

        let tags = TagData::default();
        let mut rows = corpus.rows(&tags).expect("replay");
        let _: Vec<Value> = rows.by_ref().collect();
        assert!(rows.take_error().is_some(), "a truncated spill must surface as an error");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
