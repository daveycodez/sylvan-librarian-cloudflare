//! The import pipeline as a wasm C ABI, run inside the ImportCoordinator
//! Durable Object (128MB isolate). Every parity-sensitive step is the same
//! Rust the native builder runs — transform, tag-ancestor resolution,
//! last-wins dedupe, illustration counts, prefer/cubecobra scoring,
//! finalize_row, and card_engine's SpillingStoreBuilder — so the DO import
//! and the native dev build cannot drift. The host (TypeScript) contributes
//! only I/O: fetching dumps, storing spilled blobs in DO SQLite, publishing
//! chunks to D1.
//!
//! ## Protocol
//!
//! Host-provided imports (module "env"):
//!   emit(kind, ptr, len)             wasm → host bytes; kinds below
//!   pull_row(index, dest, cap) -> i32  host serves spilled row blob #index
//!                                      (add order), copied into dest; -1 on
//!                                      unknown index / cap overflow
//!
//! Emit kinds:
//!   1 log line (utf-8)               diagnostics, host console.logs it
//!   2 draft blob                     one RowDraft as [u64 le fnv1a64(oracle_id)]
//!                                    [RowDraft JSON] (store in order). The 8-byte
//!                                    prefix is the partition hash: the store is cut
//!                                    by hash(oracle_id) % partition_count, but N is
//!                                    chosen by the BUILDER after transform (Decision
//!                                    3b, auto-scaled) — so the draft carries the full
//!                                    64-bit hash, computed once in Rust (the plan's
//!                                    "partition tag" with the modulus deferred), and
//!                                    the build phase mods it by whatever N it picks.
//!   3 stats json                     per-call summary (see each export)
//!   4 spill blob                     one encoded CardRow (store in add order)
//!   5 store chunk                    archive bytes, in order
//!   6 finalized row json             ENGINE_COLUMNS row (D1 cards table feed)
//!   7 tag-data blob                  serialized TagData snapshot (persist +
//!                                    restore across DO evictions)
//!   8 compat chunk                   residue-archive bytes, in order. Interleaves with kind 5:
//!                                    the residue is written mid-build, before the search indexes
//!                                    exist, which is what keeps the build's peak under the cap.
//!
//! Exports drive the phases in order; all buffers passed in are allocated
//! with `alloc` and consumed (freed) by the callee:
//!   reset()                          fresh import; drops all state
//!   canonical_add_lines(ptr, len)    default_cards JSONL lines → id set in
//!                                    TagData (MUST be fed, and snapshotted via
//!                                    tags_export, BEFORE transform runs: the
//!                                    coordinator restores the snapshot into each
//!                                    transient transform instance)
//!   transform_lines(ptr, len)        all_cards JSONL lines → draft emits, each
//!                                    marked is_canonical by id-membership in the
//!                                    restored canonical set
//!   tags_begin() / tags_add_lines(ptr, len) / tags_finish(kind)
//!   tags_export() / tags_restore(ptr, len)
//!   scores_add_drafts(ptr, len, n)   draft-blob batch, EVERY partition, in
//!                                    emission order → the corpus-wide tables in
//!                                    TagData (cubecobra percent-rank over the
//!                                    whole corpus's names; illustration counts,
//!                                    whose group key has no oracle_id in it —
//!                                    a partition can compute neither), AND
//!                                    EMIT_ROUTING lines for the id→partition
//!                                    routing filter (`n` = partition_count; 0
//!                                    to skip). The one pass that sees every
//!                                    draft once is the one place both belong.
//!   scores_finish()                  seals those tables — call after ALL drafts,
//!                                    BEFORE the per-partition loop opens
//!   agg_drafts(ptr, len)             draft-blob batch (length-prefixed), ONE
//!                                    partition's drafts
//!   agg_finish()                     seals aggregation (dedupe winners, pin
//!                                    slots) — call after that partition's drafts
//!   finalize_begin()
//!   finalize_drafts(ptr, len)        same draft batches, same order →
//!                                    spill + row emits for winners
//!   finalize_end() -> staged rows    frees tags+aggregates before build
//!   build_store_stream() -> i64      pulls spilled rows in build order,
//!                                    emits store chunks; total bytes or -1
//!   current_alloc() / peak_alloc()   heap observability
//!
//! Batches of blobs (draft blobs in `agg_drafts`/`finalize_drafts`) are
//! length-prefixed concatenations: repeating [u32 le length][bytes].

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use card_engine::{fnv1a64_oracle_id, SpillingStoreBuilder};
use serde_json::Value;
use sylvan_store_builder::ranks::PrintingRanks;
use sylvan_store_builder::tags::{TagAccumulator, TagData, TagKind};
use sylvan_store_builder::transform::{
    art_tags_of, finalize_row, illust_count_qualifies, is_pinned, routing_keys_of, transform_row, PinnedPrintings,
    RowDraft,
};

// ─── counting allocator (observability; OOM shows as a trap regardless) ──────

struct CountingAlloc;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn count_alloc(size: usize) {
    let cur = CURRENT.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(cur, Ordering::Relaxed);
}

fn count_dealloc(size: usize) {
    CURRENT.fetch_sub(size, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count_alloc(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        count_dealloc(layout.size());
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count_dealloc(layout.size());
        count_alloc(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count_alloc(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }
}

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

// ─── host imports ────────────────────────────────────────────────────────────

const EMIT_LOG: u32 = 1;
const EMIT_DRAFT: u32 = 2;
const EMIT_STATS: u32 = 3;
const EMIT_SPILL: u32 = 4;
const EMIT_CHUNK: u32 = 5;
const EMIT_ROW: u32 = 6;
const EMIT_TAGDATA: u32 = 7;
/// One scores batch's routing-filter input: `<partition>\t<key>\n` lines, the SAME text shape
/// the native builder writes to `routing-keys.tsv`, so one parser reads both publishers' output.
const EMIT_ROUTING: u32 = 8;

// `wasm_import_module = "env"` is load-bearing, not decoration: the host
// instantiates with `imports.env.emit` / `imports.env.pull_row`
// (src/engine/import-wasm.ts), and older rustc emitted bare extern blocks as
// "env" imports by default — newer rust-lld instead treats them as undefined
// symbols and fails the link ("undefined symbol: emit", first seen on CI's
// stable while local 1.90 linked clean). The attribute says explicitly what
// the old default assumed.
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn emit(kind: u32, ptr: *const u8, len: usize);
    fn pull_row(index: u32, dest: *mut u8, cap: usize) -> i32;
}

fn emit_bytes(kind: u32, bytes: &[u8]) {
    unsafe { emit(kind, bytes.as_ptr(), bytes.len()) }
}

fn log(msg: &str) {
    emit_bytes(EMIT_LOG, msg.as_bytes());
}

fn emit_stats(v: Value) {
    emit_bytes(EMIT_STATS, v.to_string().as_bytes());
}

// ─── import state ────────────────────────────────────────────────────────────

#[derive(Default)]
struct AggState {
    /// scryfall_id → first-seen position (the dedupe: a repeated id keeps its first position and
    /// its last content, which `winner_pos` below is the other half of).
    by_id: HashMap<String, u32>,
    /// scryfall_id → winning occurrence position (pos of the LAST occurrence);
    /// finalize processes a draft only at its winning position.
    winner_pos: HashMap<String, u32>,
    /// The (set, collector-number) slots this partition's labelled printings sit in, so the pin
    /// reaches every language's edition of them (transform::PIN_BONUS). Partition-local by
    /// construction: the slot key carries the oracle_id, and every printing of one card hashes to
    /// one partition — unlike the corpus tables, which is why THOSE come from TagData.
    pins: PinnedPrintings,
    /// Where each printing slot sits in its card's order — which printing represents the card
    /// under a filter the pinned printing does not survive (sylvan_store_builder::ranks).
    /// Partition-local for exactly the reason `pins` is: the order is keyed inside one card.
    ranks: PrintingRanks,
    sealed: bool,
    positions_seen: u32,
}

#[derive(Default)]
struct ImportState {
    tags: TagData,
    /// Streaming fold of tag-dump lines between tags_begin and tags_finish.
    tag_acc: TagAccumulator,
    agg: AggState,
    /// Position counter for finalize's second pass over the same draft order.
    finalize_pos: u32,
    staging: Option<SpillingStoreBuilder>,
}

static STATE: Mutex<Option<ImportState>> = Mutex::new(None);

fn with_state<R>(f: impl FnOnce(&mut ImportState) -> R) -> R {
    let mut guard = STATE.lock().unwrap();
    f(guard.get_or_insert_with(ImportState::default))
}

// ─── memory ABI ──────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Reclaim a buffer produced by `alloc`. Exported for host-side error paths;
/// the exports below consume (and free) their input buffers themselves.
fn take_buf(ptr: *mut u8, len: usize) -> Vec<u8> {
    unsafe { Vec::from_raw_parts(ptr, len, len) }
}

/// Free a buffer produced by `alloc`, with the length it was allocated with.
///
/// `alloc` leaks by design: every other export CONSUMES its input buffer, so
/// the host never has one left to free. `staged_order` is the exception — it
/// fills a host buffer rather than consuming one, and the host calls it once
/// per reorder slice. Unfreed, that is ~390KB of permutation leaked per slice
/// into linear memory that is never handed back, and it persists into the
/// build, whose high-water sits at 120.9MiB (single-archive build, measured on
/// the real corpus 2026-08-13) against this module's 124MiB `--max-memory` —
/// see the fit tripwire in scripts/gate.sh.
#[unsafe(no_mangle)]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(take_buf(ptr, len));
}

#[unsafe(no_mangle)]
pub extern "C" fn reset() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("wasm-import panic: {info}");
        emit_bytes(EMIT_LOG, msg.as_bytes());
    }));
    *STATE.lock().unwrap() = Some(ImportState::default());
}

// ─── phase: transform ────────────────────────────────────────────────────────

/// Newline-separated bulk-card JSONL lines → transform each; drafts leave as
/// EMIT_DRAFT blobs framed [u64 le fnv1a64(oracle_id)][RowDraft JSON] (the
/// partition hash — see the protocol doc for why it is a full hash and not a
/// partition index). Each row's `is_canonical` is id-membership in the
/// canonical set (`canonical_add_lines`), which the host must have restored
/// into THIS instance (`tags_restore`) before the first line arrives —
/// transform instances are transient, so the set cannot be assumed resident.
/// An empty set is not an error here (the host enforces that the canonical
/// pass ran; this module cannot tell "not restored" from "restored empty").
///
/// Emits a stats object per call:
/// {parsed, skipped, filtered, drafts, canonical, parsed_bytes}. Returns
/// drafts emitted this call, or -1 on a fatal transform error (missing
/// required field — upstream aborts the whole import; so do we).
#[unsafe(no_mangle)]
pub extern "C" fn transform_lines(ptr: *mut u8, len: usize) -> i64 {
    let buf = take_buf(ptr, len);
    with_state(|s| {
        let (mut parsed, mut skipped, mut filtered, mut drafts, mut canonical) = (0u64, 0u64, 0u64, 0u64, 0u64);
        let mut parsed_bytes = 0u64;
        for line in buf.split(|&b| b == b'\n') {
            let trimmed = trim_ascii(line);
            if trimmed.is_empty() {
                continue;
            }
            // JsonlStream parity: non-object lines are skipped (the host runs the
            // parse-coverage check over these counts, mirroring bulk.rs).
            let card: Value = match serde_json::from_slice(trimmed) {
                Ok(v @ Value::Object(_)) => {
                    parsed += 1;
                    // +1: the newline the host's line splitter consumed, matching
                    // read_line()'s byte accounting in the native JsonlStream.
                    parsed_bytes += line.len() as u64 + 1;
                    v
                }
                _ => {
                    skipped += 1;
                    continue;
                }
            };
            // The caller's fact, per transform_row's contract: id-membership in
            // default_cards, never re-derived. A card without an `id` cannot be a
            // member (and fails transform below on the missing required field).
            let is_canonical =
                card.get("id").and_then(Value::as_str).is_some_and(|id| s.tags.canonical.contains(id));
            match transform_row(&card, is_canonical) {
                Ok(Some(draft)) => {
                    // Hash prefix + JSON in one buffer, one emit: the pair must
                    // never separate, or a draft lands in the wrong partition.
                    let mut blob = Vec::with_capacity(2048);
                    blob.extend_from_slice(&fnv1a64_oracle_id(&draft.oracle_id).to_le_bytes());
                    if let Err(e) = serde_json::to_writer(&mut blob, &draft) {
                        log(&format!("draft serialize failed: {e}"));
                        return -1;
                    }
                    emit_bytes(EMIT_DRAFT, &blob);
                    drafts += 1;
                    if is_canonical {
                        canonical += 1;
                    }
                }
                Ok(None) => filtered += 1,
                Err(e) => {
                    // Fatal, matching the native pipeline: a card missing a field
                    // upstream reads unconditionally aborts the import.
                    log(&format!("transform: {e}"));
                    return -1;
                }
            }
        }
        emit_stats(serde_json::json!({
            "parsed": parsed, "skipped": skipped, "filtered": filtered,
            "drafts": drafts, "canonical": canonical, "parsed_bytes": parsed_bytes,
        }));
        drafts as i64
    })
}

/// Feed `default_cards` JSONL lines; keep each line's `id` — membership in Scryfall's canonical
/// printing set — as a 16-byte binary member of `TagData.canonical`.
///
/// Same continuity rationale as `labels_add_lines`: the set lands inside `TagData` so the ONE
/// snapshot path (`tags_export`/`tags_restore`) carries it — across DO evictions between canonical
/// slices, and into every transient transform instance, which is where it is consumed
/// (`transform_lines` marks each row's `is_canonical` by membership). It must therefore be fully
/// built and exported BEFORE the transform phase starts.
///
/// Junk lines are skipped rather than fatal — the same posture as the bulk stream — but unlike
/// labels the set is NOT optional (an empty set builds a store with no canonical printings), so
/// the COORDINATOR enforces coverage over the whole phase, where lines-fed is knowable; the
/// per-call return (ids newly added) is what it sums.
#[unsafe(no_mangle)]
pub extern "C" fn canonical_add_lines(ptr: *mut u8, len: usize) -> i64 {
    /// The one field read per line; serde skips the other ~4KB without building a Value.
    #[derive(serde::Deserialize)]
    struct IdOnly {
        #[serde(default)]
        id: Option<String>,
    }
    let buf = take_buf(ptr, len);
    let mut added = 0i64;
    with_state(|s| {
        for line in buf.split(|&b| b == b'\n') {
            let trimmed = trim_ascii(line);
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_slice::<IdOnly>(trimmed) else { continue };
            if let Some(id) = v.id {
                if s.tags.canonical.insert(&id) {
                    added += 1;
                }
            }
        }
    });
    added
}

fn trim_ascii(b: &[u8]) -> &[u8] {
    let start = b.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(b.len());
    let end = b.iter().rposition(|c| !c.is_ascii_whitespace()).map_or(start, |i| i + 1);
    &b[start..end]
}

// ─── phase: tags ─────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn tags_begin() {
    with_state(|s| s.tag_acc = TagAccumulator::default());
}

/// Tag-dump JSONL lines, folded into the accumulator as they arrive. Lines
/// never accumulate — the real dumps carry ~700k taggings, and buffering the
/// records (even pruned to the read fields) blew the wasm heap on real data.
#[unsafe(no_mangle)]
pub extern "C" fn tags_add_lines(ptr: *mut u8, len: usize) -> i64 {
    let buf = take_buf(ptr, len);
    let mut added = 0i64;
    with_state(|s| {
        for line in buf.split(|&b| b == b'\n') {
            let trimmed = trim_ascii(line);
            if trimmed.is_empty() {
                continue;
            }
            // Junk lines are skipped — same posture as the bulk stream.
            if s.tag_acc.add_line(trimmed) {
                added += 1;
            }
        }
    });
    added
}

/// kind: 1 = oracle tags (keyed by oracle_id), 2 = art tags (illustration_id).
#[unsafe(no_mangle)]
pub extern "C" fn tags_finish(kind: u32) -> i64 {
    with_state(|s| {
        let acc = std::mem::take(&mut s.tag_acc);
        let kind = match kind {
            1 => TagKind::Oracle,
            2 => TagKind::Art,
            _ => {
                log(&format!("tags_finish: unknown kind {kind}"));
                return -1;
            }
        };
        acc.finish_into(kind, &mut s.tags);
        match kind {
            TagKind::Oracle => s.tags.oracle.len() as i64,
            TagKind::Art => s.tags.art.len() as i64,
        }
    })
}

/// Feed `oracle_cards` JSONL lines; keep each line's `id` as a representative label.
///
/// Lands in `TagData.labels` rather than its own state so it inherits the export/restore the tags
/// already have — the import is alarm-chained and the wasm is re-instantiated between phases, so a
/// second persistence path here would be a second thing that can drift from it.
///
/// Junk lines are skipped rather than fatal, same posture as the bulk stream: labels are an
/// OPTIONAL input, and an import that cannot read them must still produce a correctly scored
/// store rather than no store.
#[unsafe(no_mangle)]
pub extern "C" fn labels_add_lines(ptr: *mut u8, len: usize) -> i64 {
    let buf = take_buf(ptr, len);
    let mut added = 0i64;
    with_state(|s| {
        for line in buf.split(|&b| b == b'\n') {
            let trimmed = trim_ascii(line);
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_slice::<Value>(trimmed) else { continue };
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                if s.tags.labels.insert(id.to_string()) {
                    added += 1;
                }
            }
        }
    });
    added
}

/// Serialize the accumulated TagData for host-side persistence (survives DO
/// eviction between the tags phase and finalize).
#[unsafe(no_mangle)]
pub extern "C" fn tags_export() -> i64 {
    with_state(|s| match serde_json::to_vec(&s.tags) {
        Ok(bytes) => {
            emit_bytes(EMIT_TAGDATA, &bytes);
            bytes.len() as i64
        }
        Err(e) => {
            log(&format!("tags_export: {e}"));
            -1
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn tags_restore(ptr: *mut u8, len: usize) -> i64 {
    let buf = take_buf(ptr, len);
    match serde_json::from_slice::<TagData>(&buf) {
        Ok(tags) => with_state(|s| {
            let n = tags.oracle.len() + tags.art.len();
            s.tags = tags;
            n as i64
        }),
        Err(e) => {
            log(&format!("tags_restore: {e}"));
            -1
        }
    }
}

// ─── phase: aggregation ──────────────────────────────────────────────────────

/// Iterate a length-prefixed blob batch: repeating [u32 le len][bytes].
fn split_batch(buf: &[u8]) -> Result<Vec<&[u8]>, String> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < buf.len() {
        if at + 4 > buf.len() {
            return Err(format!("truncated batch header at {at}"));
        }
        let len = u32::from_le_bytes(buf[at..at + 4].try_into().unwrap()) as usize;
        at += 4;
        if at + len > buf.len() {
            return Err(format!("truncated batch blob at {at} (len {len})"));
        }
        out.push(&buf[at..at + len]);
        at += len;
    }
    Ok(out)
}

// ─── phase: scores (GLOBAL, before the partition loop) ───────────────────────

/// Fold one batch of draft blobs into the corpus-wide tables.
///
/// FED EVERY DRAFT, of every partition, in emission order — that is the whole point:
///   * `cubecobra_score` is a PERCENT_RANK over the distinct card names of the WHOLE corpus, so a
///     table built from one partition's names gives the same card a different number; the archive
///     stores that number and sorts on it (`orderby=cubecobra`), so the two publishers would
///     disagree about the ordering of every `order=cubecobra` query after the first nightly.
///   * `illustration_count` groups by `(illustration_id, card_name)`, a key with no oracle_id in
///     it — the only finalize aggregate the partition hash does not co-locate.
///
/// The tables land in `TagData`, which the coordinator snapshots per slice
/// (tags_export/tags_restore) — the same one persistence path the canonical id set rides, so this
/// phase is resumable and eviction-proof for free.
///
/// Only five fields are read per draft, so the batch is not parsed into `RowDraft`s.
/// Returns distinct card names observed so far.
#[unsafe(no_mangle)]
pub extern "C" fn scores_add_drafts(ptr: *mut u8, len: usize, partition_count: u32) -> i64 {
    /// The corpus tables' inputs: the percent-rank's pair, and what
    /// `transform::illust_count_key` reads to decide whether a row is counted.
    #[derive(serde::Deserialize)]
    struct TableInputs {
        card_name: String,
        #[serde(default)]
        edhrec_rank: Option<i64>,
        #[serde(default)]
        illustration_id: Option<String>,
        #[serde(default)]
        raw_lang_en: bool,
        #[serde(default)]
        raw_set_type: Option<String>,
        #[serde(default)]
        card_border: Option<String>,
        // ── the routing filter's inputs (transform::routing_keys_of) ─────────
        // Read here rather than in a pass of their own: this phase already visits every draft of
        // every partition exactly once, which is precisely the visit the filter needs.
        #[serde(default)]
        scryfall_id: String,
        #[serde(default)]
        oracle_id: String,
        #[serde(default)]
        compat_blob: serde_json::Map<String, Value>,
        // The artist entity relation's input, read in this same pass for the same reason the
        // routing keys are: it is the one visit that sees every draft of every partition.
        #[serde(default)]
        card_artist: Option<String>,
    }
    let buf = take_buf(ptr, len);
    let blobs = match split_batch(&buf) {
        Ok(b) => b,
        Err(e) => {
            log(&format!("scores_add_drafts: {e}"));
            return -1;
        }
    };
    with_state(|s| {
        if s.tags.corpus.is_sealed() {
            log("scores_add_drafts after scores_finish");
            return -1;
        }
        // The routing filter's key set rides THIS pass because it is the only one that sees every
        // draft of every partition exactly once, and it already parses each of them — so the keys
        // cost one wider Deserialize rather than a second sweep of the corpus. Emitted per batch
        // and never accumulated: 1.2M keys held in wasm would be ~55MB against a 124MiB ceiling
        // the build peak already spends most of.
        let mut routing = String::new();
        let mut keys: Vec<String> = Vec::with_capacity(8);
        for blob in blobs {
            let draft: TableInputs = match serde_json::from_slice(blob) {
                Ok(d) => d,
                Err(e) => {
                    log(&format!("scores_add_drafts: draft parse: {e}"));
                    return -1;
                }
            };
            let illust = draft.illustration_id.as_deref().filter(|_| {
                illust_count_qualifies(draft.raw_lang_en, draft.raw_set_type.as_deref(), draft.card_border.as_deref())
            });
            s.tags.corpus.observe(&draft.card_name, draft.edhrec_rank, illust);
            // The artist ENTITY relation, gathered in the SAME corpus-wide pass and for a stronger
            // version of the same reason: `a:` is an entity match, and a partition holding one
            // spelling of an artist and not the other would answer for its own rows and silently
            // drop the other nine partitions'. See `transform::ArtistSpellings`.
            s.tags.corpus.observe_artists(draft.card_artist.as_deref(), &draft.compat_blob);
            if partition_count > 0 {
                keys.clear();
                routing_keys_of(
                    &draft.scryfall_id,
                    draft.illustration_id.as_deref(),
                    &draft.compat_blob,
                    &mut keys,
                );
                let p = fnv1a64_oracle_id(&draft.oracle_id) % u64::from(partition_count);
                for key in &keys {
                    routing.push_str(&p.to_string());
                    routing.push('\t');
                    routing.push_str(key);
                    routing.push('\n');
                }
            }
        }
        if partition_count > 0 {
            // Emitted even when EMPTY: the coordinator keys the staged row on the batch this call
            // consumed, and a skipped emit would leave that batch's row absent on a retry rather
            // than replaced.
            emit_bytes(EMIT_ROUTING, routing.as_bytes());
        }
        s.tags.corpus.names() as i64
    })
}

/// Seal the corpus tables — call once, after every draft has been fed, before the per-partition
/// loop opens. Idempotent (the phase's last slice can be retried). Returns distinct names scored.
#[unsafe(no_mangle)]
pub extern "C" fn scores_finish() -> i64 {
    with_state(|s| {
        let names = s.tags.corpus.seal();
        emit_stats(serde_json::json!({
            "cubecobra_names": names,
            "illust_groups": s.tags.corpus.illustration_groups(),
            "multi_spelling_artists": s.tags.corpus.multi_spelling_artists(),
        }));
        names as i64
    })
}

/// First pass over ONE PARTITION's draft blobs, in emission order. Mirrors the native finalize's
/// dedupe — a repeated scryfall_id is finalized once, at its LAST occurrence, so the last content
/// wins — and collects that partition's pin slots on the way past.
#[unsafe(no_mangle)]
pub extern "C" fn agg_drafts(ptr: *mut u8, len: usize) -> i64 {
    let buf = take_buf(ptr, len);
    let blobs = match split_batch(&buf) {
        Ok(b) => b,
        Err(e) => {
            log(&format!("agg_drafts: {e}"));
            return -1;
        }
    };
    with_state(|s| {
        if s.agg.sealed {
            log("agg_drafts after agg_finish");
            return -1;
        }
        for blob in blobs {
            let draft: RowDraft = match serde_json::from_slice(blob) {
                Ok(d) => d,
                Err(e) => {
                    log(&format!("agg_drafts: draft parse: {e}"));
                    return -1;
                }
            };
            let pos = s.agg.positions_seen;
            s.agg.positions_seen += 1;
            // The one per-card fact this pass still collects: the labelled row's slot, knowable
            // only while that row goes past (transform::PIN_BONUS).
            s.agg.pins.observe(&draft, &s.tags.labels);
            s.agg.ranks.observe(&draft);
            let first = s.agg.by_id.len() as u32;
            s.agg.by_id.entry(draft.scryfall_id.clone()).or_insert(first);
            s.agg.winner_pos.insert(draft.scryfall_id, pos);
        }
        s.agg.by_id.len() as i64
    })
}

/// Seal aggregation.
///
/// What is left of it, now that BOTH of `finalize`'s cross-row tables are corpus-global
/// (`scores_add_drafts`): the dedupe — which draft position is a winner — and the pin slots. Both
/// are keyed inside one card, and the partition hash puts one card in one partition, so both are
/// exactly what they would be over the whole corpus.
#[unsafe(no_mangle)]
pub extern "C" fn agg_finish() -> i64 {
    with_state(|s| {
        if s.agg.sealed {
            return s.agg.by_id.len() as i64;
        }
        s.agg.sealed = true;
        // The printing order asks "is this slot pinned" first, so it can only be frozen once the
        // whole partition has gone past and the pin slots are complete.
        let pins = std::mem::take(&mut s.agg.pins);
        s.agg.ranks.seal(&pins);
        s.agg.pins = pins;
        emit_stats(serde_json::json!({
            "winners": s.agg.by_id.len(),
            "positions": s.agg.positions_seen,
            "pinned_slots": s.agg.pins.len(),
            "ranked_slots": s.agg.ranks.len(),
        }));
        s.agg.by_id.len() as i64
    })
}

// ─── phase: finalize (second pass over the same draft order) ─────────────────

#[unsafe(no_mangle)]
pub extern "C" fn finalize_begin() -> i64 {
    with_state(|s| {
        if !s.agg.sealed {
            log("finalize_begin before agg_finish");
            return -1;
        }
        // Unsealed tables would finalize every row with a NULL cubecobra_score and a zero
        // illustration count, and build a perfectly valid, silently wrong store — so they are
        // refused here rather than read as "no scores". Only a snapshot from before the scores
        // phase existed can produce it.
        if !s.tags.corpus.is_sealed() {
            log("finalize_begin before the corpus tables were sealed (scores phase)");
            return -1;
        }
        s.finalize_pos = 0;
        let mut staging = SpillingStoreBuilder::new();
        // The artist-entity relation, handed over ONCE for this partition. It comes from the
        // SEALED corpus tables — the same snapshot `cubecobra_score` and `illustration_count` come
        // from, and global for a stronger version of their reason: `a:` is an entity match, and a
        // partition that saw only the spellings its own rows print would answer `a:"don't mess"`
        // with its own Rebecca Guay rows and silently drop the other nine partitions'. Once, and
        // not on the rows: per row it is O(that artist's spellings) with no bound, which took the
        // gate corpus's rows.jsonl from 198MB to 6.5GB and out-of-memoried this very build.
        staging.set_artist_entities(s.tags.corpus.artist_entities());
        s.staging = Some(staging);
        0
    })
}

/// Same draft batches, same order as agg_drafts. A draft is finalized only at
/// its winning position; each winner becomes one ENGINE_COLUMNS row emitted
/// twice — as a spill blob (EMIT_SPILL, the store build input) and as row
/// JSON (EMIT_ROW, the D1 cards-table feed). Returns rows staged so far.
#[unsafe(no_mangle)]
pub extern "C" fn finalize_drafts(ptr: *mut u8, len: usize) -> i64 {
    let buf = take_buf(ptr, len);
    let blobs = match split_batch(&buf) {
        Ok(b) => b,
        Err(e) => {
            log(&format!("finalize_drafts: {e}"));
            return -1;
        }
    };
    with_state(|s| {
        let Some(_) = s.staging.as_ref() else {
            log("finalize_drafts before finalize_begin");
            return -1;
        };
        let empty: Vec<u32> = Vec::new();
        for blob in blobs {
            let pos = s.finalize_pos;
            s.finalize_pos += 1;
            let draft: RowDraft = match serde_json::from_slice(blob) {
                Ok(d) => d,
                Err(e) => {
                    log(&format!("finalize_drafts: draft parse: {e}"));
                    return -1;
                }
            };
            if s.agg.winner_pos.get(&draft.scryfall_id) != Some(&pos) {
                continue; // a duplicated scryfall_id's non-winning occurrence
            }
            let oracle_tags = s.tags.resolve(s.tags.oracle.get(&draft.oracle_id).unwrap_or(&empty));
            let art_tags = art_tags_of(&s.tags, &draft);
            // BOTH GLOBAL, from the scores phase — not from this partition's aggregation, which
            // would rank the card against 1/Nth of the corpus's names and count only the rows of
            // its illustration group that landed here (see `scores_add_drafts`).
            let illustration_count =
                s.tags.corpus.illustration_count(draft.illustration_id.as_deref(), &draft.card_name);
            let cubecobra_score = s.tags.corpus.cubecobra(&draft.card_name);
            // Same source of truth as the native builder: `TagData.labels`, which the tags
            // export/restore already carries across DO evictions, plus the slots those labels
            // named (agg's per-card pass). Unconditional, matching transform.rs's PIN_BONUS doc —
            // this port answers like Scryfall.
            let pinned = is_pinned(&draft, &s.tags.labels, &s.agg.pins);
            let rank = s.agg.ranks.rank_of(&draft);
            let row = finalize_row(draft, &oracle_tags, &art_tags, illustration_count, cubecobra_score, pinned, rank);
            let row_json = row.to_string();
            let builder = s.staging.as_mut().expect("checked above");
            match builder.add_card(&row) {
                Ok(spill) => {
                    emit_bytes(EMIT_SPILL, &spill);
                    emit_bytes(EMIT_ROW, row_json.as_bytes());
                }
                Err(e) => {
                    log(&format!("finalize_drafts: add_card: {e}"));
                    return -1;
                }
            }
        }
        s.staging.as_ref().map_or(-1, |b| b.staged_rows() as i64)
    })
}

/// Seal staging and free everything the build no longer needs (tags,
/// aggregates) so the store assembly runs against a minimal resident set.
#[unsafe(no_mangle)]
pub extern "C" fn finalize_end() -> i64 {
    with_state(|s| {
        let Some(builder) = s.staging.as_ref() else {
            log("finalize_end before finalize_begin");
            return -1;
        };
        let staged = builder.staged_rows() as i64;
        s.tags = TagData::default();
        s.agg = AggState::default();
        emit_stats(serde_json::json!({ "staged": staged }));
        staged
    })
}

// ─── phase: store build ──────────────────────────────────────────────────────

struct ChunkWriter {
    buf: Vec<u8>,
    total: u64,
    /// EMIT_CHUNK for the search store, EMIT_COMPAT_CHUNK for the residue archive.
    kind: u32,
}

/// Sized for D1: comfortably under D1's per-value/response limits while
/// keeping the chunk count (rows written per publish) small.
const CHUNK_BYTES: usize = 900_000;
const PULL_CAP: usize = 64 * 1024;

impl ChunkWriter {
    fn flush_chunk(&mut self) {
        if !self.buf.is_empty() {
            emit_bytes(self.kind, &self.buf);
            self.total += self.buf.len() as u64;
            self.buf.clear();
        }
    }
}

impl Write for ChunkWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        // Split at exact chunk boundaries: rkyv can hand this writer a single
        // multi-MB slice (the archived string table), and appending it whole
        // would emit a chunk far over the host's 2MB SQLite value cap.
        let mut at = 0;
        while at < data.len() {
            let room = CHUNK_BYTES - self.buf.len();
            let take = room.min(data.len() - at);
            self.buf.extend_from_slice(&data[at..at + take]);
            at += take;
            if self.buf.len() >= CHUNK_BYTES {
                self.flush_chunk();
            }
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.flush_chunk();
        Ok(())
    }
}

/// The permutation `build_store_stream` will pull in: `staged_rows()` u32s,
/// little-endian, written into a host buffer. Returns the byte length, 0 if
/// nothing is staged, or -1 if `cap` is too small.
///
/// Exposed so the HOST can lay the spill out in build order before the build
/// runs. Without it the host only learns each index when `pull_row` asks for
/// it, one at a time, and the only way to serve an arbitrary index is a random
/// seek into the spill — 97,802 of them for a real corpus, which is what took
/// the build past the Durable Object CPU ceiling. Knowing the order up front
/// turns that into a sequential scan.
// The host is the only caller and `dest`/`cap` come from a buffer it allocated through this
// module's own ABI; clippy cannot see that contract across the C boundary, and marking the
// export `unsafe` would change the ABI surface the coordinator links against.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[unsafe(no_mangle)]
pub extern "C" fn staged_order(dest: *mut u8, cap: usize) -> i64 {
    with_state(|s| {
        let Some(builder) = s.staging.as_ref() else {
            return 0;
        };
        let order = builder.sorted_order();
        let need = order.len() * 4;
        if need > cap {
            log(&format!("staged_order: need {need} bytes, host offered {cap}"));
            return -1;
        }
        // Safety: the host allocated `cap` bytes at `dest` via alloc() and
        // does not touch them until this returns; `need <= cap` is checked.
        let out = unsafe { std::slice::from_raw_parts_mut(dest, need) };
        for (i, idx) in order.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&idx.to_le_bytes());
        }
        need as i64
    })
}

/// Pull spilled rows back (host-stored, indexed by add order) in build order,
/// assemble + serialize the archive, stream chunks out. Returns total archive
/// bytes, or -1. Emits {card_count, printing_count, store_bytes} stats.
#[unsafe(no_mangle)]
pub extern "C" fn build_store_stream() -> i64 {
    let builder = match with_state(|s| s.staging.take()) {
        Some(b) => b,
        None => {
            log("build_store_stream without staged rows");
            return -1;
        }
    };
    let order = builder.sorted_order();
    let expected = order.len();
    let mut scratch = vec![0u8; PULL_CAP];
    let mut failed: Option<u32> = None;
    let rows = order.iter().filter_map(|&idx| {
        let n = unsafe { pull_row(idx, scratch.as_mut_ptr(), PULL_CAP) };
        if n < 0 {
            failed = Some(idx);
            return None; // truncation is caught by the count check below
        }
        Some(scratch[..n as usize].to_vec())
    });

    let mut w = ChunkWriter { buf: Vec::with_capacity(CHUNK_BYTES), total: 0, kind: EMIT_CHUNK };
    let result = builder.finish_from_sorted(rows, &mut w);
    match result {
        Ok(stats) => {
            if let Some(idx) = failed {
                log(&format!("build_store_stream: pull_row failed at blob {idx}"));
                return -1;
            }
            // Canonical + annex + annex-only-dropped, not `printing_count` alone: since the
            // foreign annex, `printing_count` counts CANONICAL rows only (the pyo3 size()
            // meaning), so this check — whose one job is catching a truncated pull stream —
            // rejects every healthy MULTILINGUAL build. The wasm-builder-probe hit exactly this
            // and fixed it there; this copy kept the old comparison, and only stayed quiet
            // because the one caller fed a corpus in which every row was canonical. The three
            // terms account for every staged row exactly (see StoreStats.annex_only_rows_dropped).
            let built = stats.printing_count + stats.foreign_printing_count + stats.annex_only_rows_dropped;
            if built != expected {
                log(&format!(
                    "build_store_stream: row stream truncated: {built} of {expected} rows \
                     (canonical {} + annex {} + annex-only dropped {})",
                    stats.printing_count, stats.foreign_printing_count, stats.annex_only_rows_dropped
                ));
                return -1;
            }
            let _ = w.flush();
            emit_stats(serde_json::json!({
                "card_count": stats.card_count,
                "printing_count": stats.printing_count,
                "foreign_printing_count": stats.foreign_printing_count,
                "store_bytes": w.total,
            }));
            w.total as i64
        }
        Err(e) => {
            log(&format!("build_store_stream: finish: {e}"));
            -1
        }
    }
}

// ─── observability ───────────────────────────────────────────────────────────

/// card_engine's ARCHIVE_FORMAT_VERSION — the host composes the store key and
/// manifest from it, so readers reject stores from a different engine build.
#[unsafe(no_mangle)]
pub extern "C" fn format_version() -> u32 {
    card_engine::store_format_version()
}

#[unsafe(no_mangle)]
pub extern "C" fn current_alloc() -> usize {
    CURRENT.load(Ordering::Relaxed)
}

#[unsafe(no_mangle)]
pub extern "C" fn peak_alloc() -> usize {
    PEAK.load(Ordering::Relaxed)
}
