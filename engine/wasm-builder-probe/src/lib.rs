//! Wasm store-build probe: the SpillingStoreBuilder path the ImportCoordinator
//! DO would run, exported over a minimal C ABI (no wasm-bindgen — the driver
//! auto-stubs any bindgen placeholder imports that leak in via deps).
//!
//! Protocol (driver.ts):
//!   probe_alloc(len) -> ptr        allocate an input buffer inside wasm
//!   builder_new()                  start a build
//!   builder_add_jsonl(ptr, len)    parse a batch of JSONL rows; each staged
//!                                  row is spilled OUT via env.spill_row and
//!                                  never kept in wasm memory. Frees the
//!                                  buffer; returns staged count, or -1
//!                                  (error text via env.log_err)
//!   builder_finish() -> i64        pulls spilled rows back in build order
//!                                  via env.pull_row(index, dest, cap),
//!                                  builds + serializes, streaming the
//!                                  archive out through env.emit_chunk;
//!                                  returns total bytes, or -1
//!   peak_alloc() / current_alloc() counting-allocator readings (bytes)
//!
//! Memory ceiling: enforced at link time (--max-memory); exceeding it makes
//! memory.grow fail, which surfaces as an allocation abort → wasm trap. A
//! completed run under the cap IS the feasibility proof.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use card_engine::SpillingStoreBuilder;
use serde_json::Value;

// ─── counting allocator (same scheme as the native memprobe) ─────────────────

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

unsafe extern "C" {
    fn emit_chunk(ptr: *const u8, len: usize);
    fn log_err(ptr: *const u8, len: usize);
    /// Store one spilled row blob (add order = blob index).
    fn spill_row(ptr: *const u8, len: usize);
    /// Copy spilled blob `index` into dest (≤ cap bytes); returns its length,
    /// or -1 if the index is unknown / the blob exceeds cap.
    fn pull_row(index: u32, dest: *mut u8, cap: usize) -> i32;
}

fn report_err(msg: &str) {
    unsafe { log_err(msg.as_ptr(), msg.len()) }
}

// ─── builder state ───────────────────────────────────────────────────────────

static BUILDER: Mutex<Option<SpillingStoreBuilder>> = Mutex::new(None);

#[unsafe(no_mangle)]
pub extern "C" fn probe_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn builder_new() {
    std::panic::set_hook(Box::new(|info| {
        report_err(&format!("wasm panic: {info}"));
    }));
    *BUILDER.lock().unwrap() = Some(SpillingStoreBuilder::new());
}

/// Parse a newline-delimited batch of finalized rows; stage + spill each one.
/// Takes ownership of the buffer allocated by probe_alloc (frees it).
// The host is the only caller and it passes a pointer this module handed it from `probe_alloc`;
// clippy cannot see that contract across the C ABI, and marking the export `unsafe` would change
// the ABI surface the driver links against.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[unsafe(no_mangle)]
pub extern "C" fn builder_add_jsonl(ptr: *mut u8, len: usize) -> i64 {
    let buf = unsafe { Vec::from_raw_parts(ptr, len, len) };
    let mut guard = BUILDER.lock().unwrap();
    let Some(builder) = guard.as_mut() else {
        report_err("builder_add_jsonl before builder_new");
        return -1;
    };
    for line in buf.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let row: Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(e) => {
                report_err(&format!("row parse: {e}"));
                return -1;
            }
        };
        match builder.add_card(&row) {
            Ok(blob) => unsafe { spill_row(blob.as_ptr(), blob.len()) },
            Err(e) => {
                report_err(&format!("add_card: {e}"));
                return -1;
            }
        }
    }
    builder.staged_rows() as i64
}

/// Streams archive chunks out via emit_chunk as rkyv produces them, so the
/// full store is never resident — the same shape the DO uses to trickle
/// chunks into SQLite/D1.
struct ChunkWriter {
    buf: Vec<u8>,
    total: u64,
}

const CHUNK_BYTES: usize = 1 << 20;
/// Spilled CardRow blobs are a few hundred bytes; 64KB is generous headroom.
const PULL_CAP: usize = 64 * 1024;

impl ChunkWriter {
    fn flush_chunk(&mut self) {
        if !self.buf.is_empty() {
            unsafe { emit_chunk(self.buf.as_ptr(), self.buf.len()) }
            self.total += self.buf.len() as u64;
            self.buf.clear();
        }
    }
}

impl Write for ChunkWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= CHUNK_BYTES {
            self.flush_chunk();
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.flush_chunk();
        Ok(())
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn builder_finish() -> i64 {
    let Some(builder) = BUILDER.lock().unwrap().take() else {
        report_err("builder_finish before builder_new");
        return -1;
    };
    // Build order lives wasm-side; the host is a dumb blob store indexed by
    // add order. ~4 bytes/row for the order + one reused pull scratch buffer.
    let order = builder.sorted_order();
    let mut scratch = vec![0u8; PULL_CAP];
    let mut failed: Option<u32> = None;
    let rows = order.iter().filter_map(|&idx| {
        let n = unsafe { pull_row(idx, scratch.as_mut_ptr(), PULL_CAP) };
        if n < 0 {
            failed = Some(idx);
            return None; // truncates the stream; caught by expected-count check below
        }
        Some(scratch[..n as usize].to_vec())
    });

    let mut w = ChunkWriter { buf: Vec::with_capacity(CHUNK_BYTES), total: 0 };
    let expected = order.len();
    // No residue writer: this probe measures the SEARCH archive's build peak, which is the number
    // the 112 MiB wasm cap binds. The card-object archive is written and dropped earlier in the
    // same call (see CompatData), so `None` here discards it without changing what is measured.
    match builder.finish_from_sorted(rows, &mut w, None) {
        Ok(stats) => {
            if let Some(idx) = failed {
                report_err(&format!("pull_row failed at blob {idx}"));
                return -1;
            }
            if stats.printing_count != expected {
                report_err(&format!(
                    "row stream truncated: {} of {expected} printings",
                    stats.printing_count
                ));
                return -1;
            }
            let _ = w.flush();
            w.total as i64
        }
        Err(e) => {
            report_err(&format!("finish: {e}"));
            -1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn peak_alloc() -> usize {
    PEAK.load(Ordering::Relaxed)
}

#[unsafe(no_mangle)]
pub extern "C" fn current_alloc() -> usize {
    CURRENT.load(Ordering::Relaxed)
}
