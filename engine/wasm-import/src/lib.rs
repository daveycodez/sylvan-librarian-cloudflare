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
//!   2 draft blob                     one serialized RowDraft (store in order)
//!   3 stats json                     per-call summary (see each export)
//!   4 spill blob                     one encoded CardRow (store in add order)
//!   5 store chunk                    archive bytes, in order
//!   6 finalized row json             ENGINE_COLUMNS row (D1 cards table feed)
//!   7 tag-data blob                  serialized TagData snapshot (persist +
//!                                    restore across DO evictions)
//!
//! Exports drive the phases in order; all buffers passed in are allocated
//! with `alloc` and consumed (freed) by the callee:
//!   reset()                          fresh import; drops all state
//!   transform_lines(ptr, len)        JSONL bulk-card lines → draft emits
//!   tags_begin() / tags_add_lines(ptr, len) / tags_finish(kind)
//!   tags_export() / tags_restore(ptr, len)
//!   agg_drafts(ptr, len)             draft-blob batch (length-prefixed)
//!   agg_finish()                     seals aggregation (winners, counts,
//!                                    cubecobra) — call after ALL drafts
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

use card_engine::SpillingStoreBuilder;
use serde_json::Value;
use sylvan_store_builder::tags::{TagAccumulator, TagData, TagKind};
use sylvan_store_builder::transform::{
    cubecobra_scores_from_pairs, finalize_row, illust_count_key, transform, RowDraft,
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

/// Per-winner aggregation row collected during `agg_drafts`, compact enough
/// for ~110k printings to sit in a few MB. Sorted by first_pos in
/// `agg_finish` to reproduce the native path's deduped-row order.
struct WinnerInfo {
    first_pos: u32,
    /// The winning (last) occurrence's fields, overwritten on re-encounter.
    card_name: String,
    edhrec_rank: Option<i64>,
    illust_key: Option<String>,
}

#[derive(Default)]
struct AggState {
    /// scryfall_id → index into `winners` (insertion order = first-seen order).
    by_id: HashMap<String, u32>,
    winners: Vec<WinnerInfo>,
    /// scryfall_id → winning occurrence position (pos of the LAST occurrence);
    /// finalize processes a draft only at its winning position.
    winner_pos: HashMap<String, u32>,
    /// Sealed by agg_finish:
    illust_counts: HashMap<(String, String), u64>,
    cubecobra: HashMap<String, f64>,
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
/// EMIT_DRAFT blobs. Emits a stats object per call:
/// {parsed, skipped, filtered, drafts, parsed_bytes}. Returns drafts emitted
/// this call, or -1 on a fatal transform error (missing required field —
/// upstream aborts the whole import; so do we).
#[unsafe(no_mangle)]
pub extern "C" fn transform_lines(ptr: *mut u8, len: usize) -> i64 {
    let buf = take_buf(ptr, len);
    let (mut parsed, mut skipped, mut filtered, mut drafts) = (0u64, 0u64, 0u64, 0u64);
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
        match transform(&card) {
            Ok(Some(draft)) => {
                let blob = match serde_json::to_vec(&draft) {
                    Ok(b) => b,
                    Err(e) => {
                        log(&format!("draft serialize failed: {e}"));
                        return -1;
                    }
                };
                emit_bytes(EMIT_DRAFT, &blob);
                drafts += 1;
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
        "drafts": drafts, "parsed_bytes": parsed_bytes,
    }));
    drafts as i64
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

/// First pass over draft blobs, in emission order. Mirrors the native
/// finalize's dedupe: first-seen position kept, last content wins.
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
            let info = WinnerInfo {
                first_pos: pos,
                illust_key: illust_count_key(&draft).map(str::to_owned),
                card_name: draft.card_name,
                edhrec_rank: draft.edhrec_rank,
            };
            match s.agg.by_id.get(&draft.scryfall_id) {
                Some(&idx) => {
                    // Re-encounter: content updates (last wins), first_pos kept.
                    let slot = &mut s.agg.winners[idx as usize];
                    slot.card_name = info.card_name;
                    slot.edhrec_rank = info.edhrec_rank;
                    slot.illust_key = info.illust_key;
                    s.agg.winner_pos.insert(draft.scryfall_id, pos);
                }
                None => {
                    s.agg.by_id.insert(draft.scryfall_id.clone(), s.agg.winners.len() as u32);
                    s.agg.winners.push(info);
                    s.agg.winner_pos.insert(draft.scryfall_id, pos);
                }
            }
        }
        s.agg.winners.len() as i64
    })
}

/// Seal aggregation: order winners by first-seen position (the native deduped
/// row order), then derive illustration counts and cubecobra scores exactly
/// as transform::finalize does over its deduped Vec.
#[unsafe(no_mangle)]
pub extern "C" fn agg_finish() -> i64 {
    with_state(|s| {
        if s.agg.sealed {
            return s.agg.winners.len() as i64;
        }
        let mut order: Vec<u32> = (0..s.agg.winners.len() as u32).collect();
        order.sort_unstable_by_key(|&i| s.agg.winners[i as usize].first_pos);

        let mut illust: HashMap<(String, String), u64> = HashMap::new();
        let mut per_name: Vec<(&str, Option<i64>)> = Vec::new();
        let mut name_seen: HashMap<&str, ()> = HashMap::new();
        for &i in &order {
            let w = &s.agg.winners[i as usize];
            if let Some(ill) = &w.illust_key {
                *illust.entry((ill.clone(), w.card_name.clone())).or_insert(0) += 1;
            }
            if name_seen.insert(w.card_name.as_str(), ()).is_none() {
                per_name.push((w.card_name.as_str(), w.edhrec_rank));
            }
        }
        let cubecobra = cubecobra_scores_from_pairs(&per_name);
        drop(name_seen);
        drop(per_name);
        s.agg.illust_counts = illust;
        s.agg.cubecobra = cubecobra;
        s.agg.sealed = true;
        emit_stats(serde_json::json!({
            "winners": s.agg.winners.len(),
            "positions": s.agg.positions_seen,
            "illust_entries": s.agg.illust_counts.len(),
            "cubecobra_names": s.agg.cubecobra.len(),
        }));
        s.agg.winners.len() as i64
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
        s.finalize_pos = 0;
        s.staging = Some(SpillingStoreBuilder::new());
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
            let art_tags = s.tags.resolve(
                draft
                    .illustration_id
                    .as_ref()
                    .and_then(|ill| s.tags.art.get(ill))
                    .unwrap_or(&empty),
            );
            let illustration_count = draft
                .illustration_id
                .as_ref()
                .and_then(|ill| s.agg.illust_counts.get(&(ill.clone(), draft.card_name.clone())))
                .copied()
                .unwrap_or(0);
            let cubecobra_score = s.agg.cubecobra.get(&draft.card_name).copied();
            let row = finalize_row(draft, &oracle_tags, &art_tags, illustration_count, cubecobra_score);
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
}

/// Sized for D1: comfortably under D1's per-value/response limits while
/// keeping the chunk count (rows written per publish) small.
const CHUNK_BYTES: usize = 900_000;
const PULL_CAP: usize = 64 * 1024;

impl ChunkWriter {
    fn flush_chunk(&mut self) {
        if !self.buf.is_empty() {
            emit_bytes(EMIT_CHUNK, &self.buf);
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

    let mut w = ChunkWriter { buf: Vec::with_capacity(CHUNK_BYTES), total: 0 };
    match builder.finish_from_sorted(rows, &mut w) {
        Ok(stats) => {
            if let Some(idx) = failed {
                log(&format!("build_store_stream: pull_row failed at blob {idx}"));
                return -1;
            }
            if stats.printing_count != expected {
                log(&format!(
                    "build_store_stream: row stream truncated: {} of {expected}",
                    stats.printing_count
                ));
                return -1;
            }
            let _ = w.flush();
            emit_stats(serde_json::json!({
                "card_count": stats.card_count,
                "printing_count": stats.printing_count,
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
