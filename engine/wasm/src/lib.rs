//! Thin wasm-bindgen boundary over `card_engine`'s pure-Rust core API.
//!
//! No engine logic lives here: every export marshals JS values in, calls
//! `card_engine::{BufferStore, StoreBuilder-adjacent}` APIs, and marshals JSON
//! strings out.
//!
//! Store loading is CHUNKED by design. A Worker isolate has ~128MB and the
//! store is ~70MB, so the JS side must never hold a full copy of the store
//! while wasm holds another. The intended flow is:
//!
//! ```js
//! begin_store_load(totalLen);          // preallocates the aligned buffer
//! for await (const chunk of r2Body) {  // ~1MB chunks straight off the R2 stream
//!   store_load_chunk(chunk);
//! }
//! finish_store_load();                 // validates + atomically swaps in
//! ```
//!
//! `finish_store_load` swaps atomically: on any error the previously active
//! store (if any) stays live. For a hot swap under memory pressure, the JS
//! glue may call `unload_store()` first (accepting a brief unavailability
//! window) so the old ~70MB is returned to the allocator before the new
//! buffer grows; without it the swap transiently needs both stores in linear
//! memory.

use flate2::write::MultiGzDecoder;
use std::cell::RefCell;
use std::io::Write;
use wasm_bindgen::prelude::*;

use card_engine::{AlignedVec, BufferStore, EngineError, QueryOptions};

thread_local! {
    /// The active store. Worker isolates are single-threaded, so a
    /// thread_local RefCell is a plain module-level slot.
    static STORE: RefCell<Option<BufferStore>> = const { RefCell::new(None) };
    /// An in-progress chunked load: (buffer, expected total length).
    static LOADING: RefCell<Option<(AlignedVec, usize)>> = const { RefCell::new(None) };
    /// An in-progress GZIPPED load: the inflater, writing straight into the store buffer.
    static GZ_LOADING: RefCell<Option<MultiGzDecoder<StoreSink>>> = const { RefCell::new(None) };
    /// The buffer a GZIPPED load inflates into. Held HERE rather than inside the decoder so that
    /// the decoder can be dropped in any state — mid-stream, corrupt, never finished — and the
    /// buffer is still reachable to recycle. See `abandon_loads`.
    static GZ_BUF: RefCell<Option<AlignedVec>> = const { RefCell::new(None) };
    /// The buffer of the last store this instance let go of, kept for the next load to refill.
    /// See `store_buffer`.
    static SPARE: RefCell<Option<AlignedVec>> = const { RefCell::new(None) };
    /// An in-progress LZ4 load (the Durable Object's local cache, backlog r3): the store buffer
    /// the frames decode into, plus any frame split across two crossings.
    static LZ4_LOADING: RefCell<Option<Lz4Load>> = const { RefCell::new(None) };
}

/// Prefix of every error that means THIS INSTANCE can no longer be trusted. The wasm target is
/// panic=abort: a trap never runs Rust's drops, so a `RefCell` borrow taken by the call that
/// trapped (`with_store`'s shared borrow of the store, the gzip sink's borrow of its buffer) stays
/// counted forever. Queries still work — shared borrows nest — but every `borrow_mut` after it
/// panicked, which is another trap, so the next publish's unload trapped, every later load
/// allocated a fresh store buffer and trapped again at install, and linear memory climbed a
/// partition per attempt until the isolate died. Every slot access below is a CHECKED borrow that
/// answers with this prefix instead; the JS shim (src/engine/wasm-shim.ts) drops the instance
/// on seeing it, and the next call instantiates a fresh one.
pub const POISONED_PREFIX: &str = "engine poisoned: ";

fn poisoned(slot: &str) -> String {
    format!("{POISONED_PREFIX}the {slot} slot is still borrowed by a call that trapped")
}

/// `f` over the slot mutably, or the poisoned error if a trapped call still holds a borrow of it.
fn with_mut<S, T>(
    key: &'static std::thread::LocalKey<RefCell<S>>,
    name: &str,
    f: impl FnOnce(&mut S) -> T,
) -> Result<T, String> {
    key.with(|cell| match cell.try_borrow_mut() {
        Ok(mut guard) => Ok(f(&mut guard)),
        Err(_) => Err(poisoned(name)),
    })
}

/// The buffer a load of `total` bytes fills: the spare, when it is big enough, else a new one.
///
/// A freed store-sized buffer cannot be reused by the allocator for the next store-sized request
/// (see `BufferStore::into_bytes` for the measurement: unload + reload doubled linear memory to
/// ~80MB), and linear memory never shrinks. Refilling the SAME allocation keeps an object at one
/// store's worth for its whole life, across every publish swap. A fresh buffer is sized with ~3%
/// of headroom so the next generation of the same partition — which drifts by a fraction of that
/// night to night — still fits it; a bigger jump (a content-generation change) simply allocates
/// once more.
fn store_buffer(total: usize) -> Result<AlignedVec, String> {
    if let Some(mut spare) = with_mut(&SPARE, "spare", |s| s.take())?
        && spare.capacity() >= total
    {
        spare.clear();
        return Ok(spare);
    }
    Ok(AlignedVec::with_capacity(total + total / 32))
}

/// Keep `buf` as the spare, unless the spare already there is the bigger one. Every path that
/// gives up on a store-sized buffer goes through here rather than dropping it: a dropped
/// store-sized block is not reusable by the allocator (see `store_buffer`), so each failed load
/// used to grow linear memory by a whole partition — a partition whose chunks had been swept
/// turned a 503-per-request outage into an isolate reset loop after two or three requests.
fn recycle(buf: AlignedVec) -> Result<(), String> {
    with_mut(&SPARE, "spare", |slot| match slot.as_ref() {
        Some(spare) if spare.capacity() >= buf.capacity() => {}
        _ => *slot = Some(buf),
    })
}

/// Give up on every in-progress load, recycling its buffer. Called before a new load begins —
/// a load the JS side abandoned mid-stream (a KV chunk that errored, an isolate reset between
/// pieces) never reached `finish`, and its buffer is exactly what the next load should refill —
/// and on every error path inside a load.
fn abandon_loads() -> Result<(), String> {
    if let Some((buf, _)) = with_mut(&LOADING, "load", |l| l.take())? {
        recycle(buf)?;
    }
    with_mut(&GZ_LOADING, "gzip decoder", |g| *g = None)?;
    if let Some(buf) = with_mut(&GZ_BUF, "gzip buffer", |b| b.take())? {
        recycle(buf)?;
    }
    if let Some(load) = with_mut(&LZ4_LOADING, "lz4 load", |l| l.take())? {
        recycle(load.buf)?;
    }
    Ok(())
}

/// Install `store` as the active one, keeping the outgoing store's buffer as the spare.
fn install(store: BufferStore) -> Result<(), String> {
    if let Some(old) = with_mut(&STORE, "store", |s| s.replace(store))? {
        with_mut(&SPARE, "spare", |s| *s = Some(old.into_bytes()))?;
    }
    Ok(())
}

/// The preallocated store buffer (`GZ_BUF`) as an inflate SINK: decompressed bytes land in their
/// final, aligned place, and a stream that inflates past the declared length is refused mid-write
/// rather than growing the buffer.
struct StoreSink {
    total: usize,
}

impl Write for StoreSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        GZ_BUF.with(|b| {
            let Ok(mut slot) = b.try_borrow_mut() else {
                return Err(std::io::Error::other(poisoned("gzip buffer")));
            };
            let Some(buf) = slot.as_mut() else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "store_load_gzip_chunk: no load buffer (load already abandoned)",
                ));
            };
            if buf.len() + data.len() > self.total {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "store_load_gzip_chunk: inflates past the declared total ({} + {} > {})",
                        buf.len(),
                        data.len(),
                        self.total
                    ),
                ));
            }
            buf.extend_from_slice(data);
            Ok(data.len())
        })
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Panics must be loud, not silent isolate deaths: route the panic message to
/// console.error before the trap. Installed once at module instantiation.
#[wasm_bindgen(start)]
pub fn __init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        console_error(&format!("sylvan-engine-wasm panic: {info}"));
    }));
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

fn js_err(e: EngineError) -> JsError {
    JsError::new(&e.to_string())
}

// ─── Store loading ───────────────────────────────────────────────────────────

/// One-shot load for callers that already hold the whole archive (tests,
/// small stores). Copies `bytes` into an aligned buffer; prefer the chunked
/// API for production-size stores to avoid a second full-size JS-side copy.
#[wasm_bindgen]
pub fn init_store(bytes: &[u8]) -> Result<(), JsError> {
    let store = BufferStore::from_bytes(bytes).map_err(js_err)?;
    with_mut(&STORE, "store", |s| *s = Some(store)).map_err(|e| JsError::new(&e))?;
    with_mut(&LOADING, "load", |l| *l = None).map_err(|e| JsError::new(&e))?;
    Ok(())
}

/// Start a chunked store load: preallocate the full aligned buffer up front
/// (one allocation, no growth reallocs while chunks stream in). Any previous
/// in-progress load is discarded; the ACTIVE store is untouched until
/// `finish_store_load` succeeds.
#[wasm_bindgen]
pub fn begin_store_load(total_len: u32) -> Result<(), JsError> {
    let total = total_len as usize;
    if total == 0 {
        return Err(JsError::new("begin_store_load: total_len must be non-zero"));
    }
    let js = |e: String| JsError::new(&e);
    abandon_loads().map_err(js)?;
    let buf = store_buffer(total).map_err(js)?;
    with_mut(&LOADING, "load", |l| *l = Some((buf, total))).map_err(js)?;
    Ok(())
}

/// Append one chunk of the archive (wasm-bindgen copies the chunk into linear
/// memory; stream ~1MB chunks so the JS side never holds the whole store).
#[wasm_bindgen]
pub fn store_load_chunk(chunk: &[u8]) -> Result<(), JsError> {
    store_load_chunk_inner(chunk).map_err(|e| JsError::new(&e))
}

fn store_load_chunk_inner(chunk: &[u8]) -> Result<(), String> {
    let overflow = LOADING.with(|l| {
        let Ok(mut slot) = l.try_borrow_mut() else {
            return Err(poisoned("load"));
        };
        let Some((buf, total)) = slot.as_mut() else {
            return Err("store_load_chunk called without begin_store_load".to_string());
        };
        if buf.len() + chunk.len() > *total {
            return Ok(Some(format!(
                "store_load_chunk: overflow ({} + {} > declared total {})",
                buf.len(),
                chunk.len(),
                total
            )));
        }
        buf.extend_from_slice(chunk);
        Ok(None)
    })?;
    if let Some(msg) = overflow {
        abandon_loads()?; // abort the load, keeping its buffer; the active store is untouched
        return Err(msg);
    }
    Ok(())
}

/// Validate the streamed archive and atomically swap it in as the active
/// store. On any error the in-progress buffer is RECYCLED as the spare (see
/// `recycle`) and the previously active store (if any) keeps serving.
#[wasm_bindgen]
pub fn finish_store_load() -> Result<(), JsError> {
    finish_store_load_inner().map_err(|e| JsError::new(&e))
}

fn finish_store_load_inner() -> Result<(), String> {
    let (buf, total) = with_mut(&LOADING, "load", |l| l.take())?
        .ok_or_else(|| "finish_store_load called without begin_store_load".to_string())?;
    if buf.len() != total {
        let msg = format!("finish_store_load: incomplete load ({} of declared {} bytes)", buf.len(), total);
        recycle(buf)?;
        return Err(msg);
    }
    match BufferStore::try_from_aligned(buf) {
        Ok(store) => install(store),
        Err((e, buf)) => {
            recycle(buf)?;
            Err(e.to_string())
        }
    }
}

/// Start a load whose bytes arrive GZIPPED — one or more concatenated gzip members, which is how
/// a partition's stored chunks sit in KV and in the Durable Object's cache.
///
/// The JS side used to decompress with `DecompressionStream` and cross the result in: in workerd
/// that is ~10,000 4KB pieces per partition, each resolved through the streams machinery, and it
/// measured 306-752ms of Durable Object CPU for a 14.3MB -> 40.8MB partition (a benchmark Worker,
/// one stage per invocation, 2026-09-22) — most of every cold wake, against 6-18ms to read the
/// same bytes out of KV and 29-85ms to copy them into wasm. Inflating here takes the compressed
/// bytes in whatever pieces the source delivers and writes the output directly into the
/// preallocated store buffer: no JS-side decompressed bytes at all, and one crossing per
/// compressed piece. Memory is unchanged — the buffer is the same one `begin_store_load` makes,
/// and the inflater's own state is its 32KB window.
///
/// Same atomic contract as the uncompressed path: the active store is untouched until
/// `finish_store_load_gzip` succeeds.
#[wasm_bindgen]
pub fn begin_store_load_gzip(total_len: u32) -> Result<(), JsError> {
    let total = total_len as usize;
    if total == 0 {
        return Err(JsError::new("begin_store_load_gzip: total_len must be non-zero"));
    }
    let js = |e: String| JsError::new(&e);
    abandon_loads().map_err(js)?;
    let buf = store_buffer(total).map_err(js)?;
    with_mut(&GZ_BUF, "gzip buffer", |b| *b = Some(buf)).map_err(js)?;
    with_mut(&GZ_LOADING, "gzip decoder", |g| *g = Some(MultiGzDecoder::new(StoreSink { total }))).map_err(js)?;
    Ok(())
}

/// Inflate one piece of the compressed stream into the store buffer. Pieces may split gzip members
/// (and their headers) anywhere.
#[wasm_bindgen]
pub fn store_load_gzip_chunk(chunk: &[u8]) -> Result<(), JsError> {
    store_load_gzip_chunk_inner(chunk).map_err(|e| JsError::new(&e))
}

fn store_load_gzip_chunk_inner(chunk: &[u8]) -> Result<(), String> {
    let failed = GZ_LOADING.with(|g| {
        let Ok(mut slot) = g.try_borrow_mut() else {
            return Err(poisoned("gzip decoder"));
        };
        let Some(decoder) = slot.as_mut() else {
            return Err("store_load_gzip_chunk called without begin_store_load_gzip".to_string());
        };
        Ok(decoder.write_all(chunk).err().map(|e| format!("store_load_gzip_chunk: {e}")))
    })?;
    if let Some(msg) = failed {
        abandon_loads()?; // abort the load, keeping its buffer; the active store is untouched
        return Err(msg);
    }
    Ok(())
}

/// Finish a gzipped load: the last member must be complete (its CRC and length trailer verified by
/// the decoder), the output exactly the declared length, and the header this build's. Then the
/// store swaps in atomically, exactly as `finish_store_load` does. On any error the buffer is
/// RECYCLED as the spare, never dropped.
#[wasm_bindgen]
pub fn finish_store_load_gzip() -> Result<(), JsError> {
    finish_store_load_gzip_inner().map_err(|e| JsError::new(&e))
}

fn finish_store_load_gzip_inner() -> Result<(), String> {
    let decoder = with_mut(&GZ_LOADING, "gzip decoder", |g| g.take())?
        .ok_or_else(|| "finish_store_load_gzip called without begin_store_load_gzip".to_string())?;
    let total = decoder.get_ref().total;
    if let Err(e) = decoder.finish() {
        abandon_loads()?;
        return Err(format!("finish_store_load_gzip: truncated or corrupt gzip stream: {e}"));
    }
    let Some(buf) = with_mut(&GZ_BUF, "gzip buffer", |b| b.take())? else {
        return Err("finish_store_load_gzip: no load buffer (load already abandoned)".to_string());
    };
    if buf.len() != total {
        let msg = format!("finish_store_load_gzip: incomplete load ({} of declared {} bytes)", buf.len(), total);
        recycle(buf)?;
        return Err(msg);
    }
    match BufferStore::try_from_aligned(buf) {
        Ok(store) => install(store),
        Err((e, buf)) => {
            recycle(buf)?;
            Err(e.to_string())
        }
    }
}

// ─── The LZ4 local cache (backlog r3) ────────────────────────────────────────
//
// KV keeps gzip; what changes is the copy a Durable Object keeps in its OWN SQLite, which every
// wake of a hibernated object materialises. The gzip inflate above measured 211-329ms per ~44MB
// partition in workerd (2026-09-24, fresh isolates, ~84% of a wake); LZ4 blocks decoded the same
// partition in 66ms at x1.46 the bytes. The store is ENCODED here too, from the archive this
// instance already holds (`store_lz4_frame`), after a load that inflated gzip — so no second
// store-sized buffer ever exists on either side.
//
// The stream is frames, one per LZ4_BLOCK_BYTES of raw archive:
//
//   [raw_len u32 LE][comp_len u32 LE][xxh32(compressed) u32 LE][LZ4 block, comp_len bytes]
//
// Independent blocks (no dictionary carried between frames), so a frame decodes straight into its
// place in the store buffer. The per-frame xxh32 is what gzip's CRC was: the check that turns a
// readable-and-wrong cached copy into a refused load. The format's version lives in the cache
// key's family tag (`:lz4v1`), not in the bytes — an unknown tag is a cache miss on the JS side.

/// Raw bytes per LZ4 frame. 1MB keeps every crossing and the one buffered partial frame small;
/// the ratio barely depends on it (21.38MB at 1MB blocks against 21.35MB at 4MB, 2026-09-24).
pub const LZ4_BLOCK_BYTES: usize = 1 << 20;
/// `raw_len`, `comp_len`, `xxh32`.
const LZ4_FRAME_HEADER: usize = 12;

struct Lz4Load {
    buf: AlignedVec,
    total: usize,
    /// A frame the last crossing cut short, header included; at most one frame long.
    pending: Vec<u8>,
}

fn frame_header(bytes: &[u8]) -> (usize, usize, u32) {
    let word = |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    (word(0) as usize, word(4) as usize, word(8))
}

/// A frame header that could not have been written by `store_lz4_frame`: refused before its
/// length is trusted for anything, including how many bytes to buffer.
fn check_frame_header(raw: usize, comp: usize) -> Result<(), String> {
    if raw == 0 || raw > LZ4_BLOCK_BYTES {
        return Err(format!("store_load_lz4_chunk: frame declares {raw} raw bytes (max {LZ4_BLOCK_BYTES})"));
    }
    if comp == 0 || comp > lz4_flex::block::get_maximum_output_size(raw) {
        return Err(format!("store_load_lz4_chunk: frame declares {comp} compressed bytes for {raw} raw"));
    }
    Ok(())
}

/// Verify one whole frame and decode it into its place at the end of the store buffer.
fn decode_frame(load: &mut Lz4Load, raw: usize, sum: u32, block: &[u8]) -> Result<(), String> {
    if xxhash_rust::xxh32::xxh32(block, 0) != sum {
        return Err("store_load_lz4_chunk: frame checksum mismatch (corrupt cached copy)".to_string());
    }
    let at = load.buf.len();
    if at + raw > load.total {
        return Err(format!(
            "store_load_lz4_chunk: decodes past the declared total ({at} + {raw} > {})",
            load.total
        ));
    }
    load.buf.resize(at + raw, 0);
    match lz4_flex::block::decompress_into(block, &mut load.buf[at..]) {
        Ok(n) if n == raw => Ok(()),
        Ok(n) => Err(format!("store_load_lz4_chunk: frame decoded to {n} bytes, header says {raw}")),
        Err(e) => Err(format!("store_load_lz4_chunk: {e}")),
    }
}

/// Take one crossing's bytes: finish a buffered partial frame, decode every whole frame in place
/// (no copy), and buffer the tail.
fn lz4_feed(load: &mut Lz4Load, mut input: &[u8]) -> Result<(), String> {
    if !load.pending.is_empty() {
        if load.pending.len() < LZ4_FRAME_HEADER {
            let take = (LZ4_FRAME_HEADER - load.pending.len()).min(input.len());
            load.pending.extend_from_slice(&input[..take]);
            input = &input[take..];
            if load.pending.len() < LZ4_FRAME_HEADER {
                return Ok(());
            }
        }
        let (raw, comp, sum) = frame_header(&load.pending);
        check_frame_header(raw, comp)?;
        let need = LZ4_FRAME_HEADER + comp;
        let take = (need - load.pending.len()).min(input.len());
        load.pending.extend_from_slice(&input[..take]);
        input = &input[take..];
        if load.pending.len() < need {
            return Ok(());
        }
        let mut frame = std::mem::take(&mut load.pending);
        decode_frame(load, raw, sum, &frame[LZ4_FRAME_HEADER..])?;
        // Keep the allocation for the next straddling frame.
        frame.clear();
        load.pending = frame;
    }
    while input.len() >= LZ4_FRAME_HEADER {
        let (raw, comp, sum) = frame_header(input);
        check_frame_header(raw, comp)?;
        if input.len() < LZ4_FRAME_HEADER + comp {
            break;
        }
        decode_frame(load, raw, sum, &input[LZ4_FRAME_HEADER..LZ4_FRAME_HEADER + comp])?;
        input = &input[LZ4_FRAME_HEADER + comp..];
    }
    load.pending.extend_from_slice(input);
    Ok(())
}

/// Start a load whose bytes are the LZ4 frame stream a Durable Object cached (see the section
/// comment). Same atomic contract and the same buffer as the other two load paths: the active
/// store is untouched until `finish_store_load_lz4` succeeds, and a failed load's buffer is
/// recycled as the spare.
#[wasm_bindgen]
pub fn begin_store_load_lz4(total_len: u32) -> Result<(), JsError> {
    let total = total_len as usize;
    if total == 0 {
        return Err(JsError::new("begin_store_load_lz4: total_len must be non-zero"));
    }
    let js = |e: String| JsError::new(&e);
    abandon_loads().map_err(js)?;
    let buf = store_buffer(total).map_err(js)?;
    // Sized once for the largest frame the encoder can write, so buffering a straddling frame
    // never doubles its way past it: linear memory never shrinks, and every byte of slack here
    // is paid for the instance's life.
    let pending = Vec::with_capacity(LZ4_FRAME_HEADER + lz4_flex::block::get_maximum_output_size(LZ4_BLOCK_BYTES));
    with_mut(&LZ4_LOADING, "lz4 load", |l| *l = Some(Lz4Load { buf, total, pending })).map_err(js)?;
    Ok(())
}

/// Decode one piece of the frame stream. Pieces may split frames (and their headers) anywhere.
#[wasm_bindgen]
pub fn store_load_lz4_chunk(chunk: &[u8]) -> Result<(), JsError> {
    store_load_lz4_chunk_inner(chunk).map_err(|e| JsError::new(&e))
}

fn store_load_lz4_chunk_inner(chunk: &[u8]) -> Result<(), String> {
    let failed = LZ4_LOADING.with(|l| {
        let Ok(mut slot) = l.try_borrow_mut() else {
            return Err(poisoned("lz4 load"));
        };
        let Some(load) = slot.as_mut() else {
            return Err("store_load_lz4_chunk called without begin_store_load_lz4".to_string());
        };
        Ok(lz4_feed(load, chunk).err())
    })?;
    if let Some(msg) = failed {
        abandon_loads()?; // abort the load, keeping its buffer; the active store is untouched
        return Err(msg);
    }
    Ok(())
}

/// Finish an LZ4 load: no partial frame left over, the output exactly the declared length, and
/// the header this build's. Then the store swaps in atomically, as the other two paths do.
#[wasm_bindgen]
pub fn finish_store_load_lz4() -> Result<(), JsError> {
    finish_store_load_lz4_inner().map_err(|e| JsError::new(&e))
}

fn finish_store_load_lz4_inner() -> Result<(), String> {
    let load = with_mut(&LZ4_LOADING, "lz4 load", |l| l.take())?
        .ok_or_else(|| "finish_store_load_lz4 called without begin_store_load_lz4".to_string())?;
    let Lz4Load { buf, total, pending } = load;
    if !pending.is_empty() || buf.len() != total {
        let msg = format!(
            "finish_store_load_lz4: incomplete load ({} of declared {} bytes, {} bytes of a frame left over)",
            buf.len(),
            total,
            pending.len()
        );
        recycle(buf)?;
        return Err(msg);
    }
    match BufferStore::try_from_aligned(buf) {
        Ok(store) => install(store),
        Err((e, buf)) => {
            recycle(buf)?;
            Err(e.to_string())
        }
    }
}

/// Frame `index` of the ACTIVE store's LZ4 encoding, or an empty array past the last one.
///
/// The encoder half of the cache: after a load that inflated gzip, the Durable Object walks
/// `index = 0, 1, …` and writes each frame into its cache, so the archive is encoded from the
/// bytes already in linear memory — one frame (~0.5MB) resident on the JS side at a time. The JS
/// walk is synchronous, so nothing can swap the store out between two frames of one encoding.
#[wasm_bindgen]
pub fn store_lz4_frame(index: u32) -> Result<Vec<u8>, JsError> {
    with_store(|store| Ok(lz4_frame_of(store.bytes(), index as usize)))
}

fn lz4_frame_of(bytes: &[u8], index: usize) -> Vec<u8> {
    let start = index.saturating_mul(LZ4_BLOCK_BYTES);
    if start >= bytes.len() {
        return Vec::new();
    }
    let block = &bytes[start..bytes.len().min(start + LZ4_BLOCK_BYTES)];
    let mut out = vec![0u8; LZ4_FRAME_HEADER + lz4_flex::block::get_maximum_output_size(block.len())];
    // Infallible: the output is sized by the crate's own bound for this input.
    let comp = lz4_flex::block::compress_into(block, &mut out[LZ4_FRAME_HEADER..]).unwrap_or(0);
    out.truncate(LZ4_FRAME_HEADER + comp);
    let sum = xxhash_rust::xxh32::xxh32(&out[LZ4_FRAME_HEADER..], 0);
    out[0..4].copy_from_slice(&(block.len() as u32).to_le_bytes());
    out[4..8].copy_from_slice(&(comp as u32).to_le_bytes());
    out[8..12].copy_from_slice(&sum.to_le_bytes());
    out
}

/// Drop the active store, keeping its buffer as the spare the next load refills
/// (see `store_buffer`: a freed store buffer is NOT reused by the allocator, so
/// dropping it outright would grow linear memory by a whole store on the next
/// load). Call before a swap when there isn't headroom for two stores at once.
#[wasm_bindgen]
pub fn unload_store() -> Result<(), JsError> {
    unload_store_inner().map_err(|e| JsError::new(&e))
}

fn unload_store_inner() -> Result<(), String> {
    if let Some(old) = with_mut(&STORE, "store", |s| s.take())? {
        with_mut(&SPARE, "spare", |s| *s = Some(old.into_bytes()))?;
    }
    Ok(())
}

/// Whether a store is loaded. A poisoned slot reports false: the instance holds nothing usable,
/// and the next load or query surfaces the poisoned error for the shim to act on.
#[wasm_bindgen]
pub fn store_loaded() -> bool {
    STORE.with(|s| s.try_borrow().map(|g| g.is_some()).unwrap_or(false))
}

// ─── Queries / catalog / health ──────────────────────────────────────────────

fn with_store<T>(f: impl FnOnce(&BufferStore) -> Result<T, JsError>) -> Result<T, JsError> {
    STORE.with(|s| {
        // `try_borrow`: only a trapped `install`/`unload` can leave a MUTABLE borrow behind,
        // and reading through it would be reading a store mid-replacement.
        let guard = s.try_borrow().map_err(|_| JsError::new(&poisoned("store")))?;
        let store = guard.as_ref().ok_or_else(|| JsError::new("no store loaded"))?;
        f(store)
    })
}

/// Run a query. `filter_tree_json` is the filter-tree JSON (TrueNode /
/// AndNode / ... encoding); `opts_json` is an object with any of `unique`,
/// `prefer`, `orderby`, `direction`, `limit`, `offset`, `fields`,
/// `include_multilingual` — missing keys take the same defaults as the
/// upstream pyo3 `query()`. Returns `{"total": n, "rows": [...]}` as a JSON
/// string.
#[wasm_bindgen]
pub fn query(filter_tree_json: &str, opts_json: &str) -> Result<String, JsError> {
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    with_store(|store| {
        let out = store.query(filter_tree_json, &opts).map_err(js_err)?;
        Ok(out.to_json().to_string())
    })
}

/// The same query as [`query`], answered as `<total> <row count>\n<rows JSON array>` IN BYTES.
///
/// For the caller that wants the rows ENCODED rather than as objects — which is /search, whose
/// whole path was `wasm.query` -> `JSON.parse` -> `JSON.stringify`, producing the same bytes it
/// started with. See `QueryOutput::into_total_and_rows_bytes`. `query` is kept for the callers
/// that genuinely need the rows as values (the columnar shape, and the card-object routes until
/// those build their objects here too).
///
/// Returns `Vec<u8>`, so wasm-bindgen hands JS a `Uint8Array` by copying the linear-memory slice.
/// A `String` return would instead `TextDecoder.decode` it into a UTF-16 JS string, which the
/// Durable Object RPC would UTF-8 encode straight back on the way out — two full passes over the
/// payload, both charged to CPU budgets, to arrive at the bytes written here.
#[wasm_bindgen]
pub fn query_rows(filter_tree_json: &str, opts_json: &str) -> Result<Vec<u8>, JsError> {
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    with_store(|store| {
        let out = store.query(filter_tree_json, &opts).map_err(js_err)?;
        // Not `js_err`: this is a serde_json::Error, not an EngineError. It cannot actually
        // happen -- serializing Values into a Vec has no fallible sink -- but the type is real.
        out.into_total_and_rows_bytes().map_err(|e| JsError::new(&e.to_string()))
    })
}

/// A page of Scryfall card objects as `<total> <row count>\n<cards JSON array>`, in UTF-8 bytes.
///
/// What /cards/search runs. The card objects are built HERE rather than by the caller, so the
/// Durable Object no longer parses the engine's rows, constructs ~60 keys per card in JS, and
/// re-encodes the result — it hands these bytes to the response. Requires the residue archive to
/// be attached, like every other card-object entry point.
#[wasm_bindgen]
pub fn scryfall_search(filter_tree_json: &str, opts_json: &str, base_url: &str) -> Result<Vec<u8>, JsError> {
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    let tree: serde_json::Value = serde_json::from_str(filter_tree_json).map_err(|e| JsError::new(&e.to_string()))?;
    with_store(|store| store.scryfall_search_bytes(&tree, &opts, base_url).map_err(js_err))
}

/// Whether a query would run the multilingual (widened) driver — `include_multilingual`, or a
/// `lang:` leaf in the bound filter.
///
/// The partitioned gather builds its envelope from `query_keys` replies and never holds a
/// `QueryOutput`, so it asks this instead. `/cards/search` needs the answer to echo
/// `include_multilingual` in `next_page` the way Scryfall does.
#[wasm_bindgen]
pub fn query_widens(filter_tree_json: &str, opts_json: &str) -> Result<bool, JsError> {
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    let tree: serde_json::Value = serde_json::from_str(filter_tree_json).map_err(|e| JsError::new(&e.to_string()))?;
    with_store(|store| store.query_widens(&tree, &opts).map_err(js_err))
}

/// One engine row as a Scryfall card object, for the differential test that guards the port.
///
/// Needs NO store: the builder is a pure function of the row and the base URL, which is what lets
/// `tests/routes/card-object-parity.test.ts` instantiate the engine and compare this against
/// `toScryfallCard` byte for byte. Not on any request path — the routes go through
/// `scryfall_search`, which writes a whole page at once.
#[wasm_bindgen]
pub fn scryfall_card_from_row(row_json: &str, base_url: &str) -> Result<String, JsError> {
    let row: serde_json::Value = serde_json::from_str(row_json).map_err(|e| JsError::new(&e.to_string()))?;
    let serde_json::Value::Object(map) = row else {
        return Err(JsError::new("row must be a JSON object"));
    };
    let mut out = Vec::with_capacity(2048);
    card_engine::card_object::write_scryfall_card(&mut out, &map, base_url);
    String::from_utf8(out).map_err(|e| JsError::new(&e.to_string()))
}

/// `{"card_types": {…}, "card_keywords": {…}, "sets_with_extras": [code, …]}` —
/// the data behind /get_catalog, plus the `include_extras` auto-enable table.
///
/// The extras table rides HERE rather than on an export of its own because the
/// route that reads it needs it at most once per store generation: this is the
/// one call the isolate already caches whole, so a set-scoped `/cards/search`
/// costs zero extra round trips.
#[wasm_bindgen]
pub fn catalog() -> Result<String, JsError> {
    with_store(|store| {
        let out = serde_json::json!({
            "card_types": store.common_card_types(),
            "card_keywords": store.common_card_keywords(),
            "sets_with_extras": store.sets_with_extras(),
        });
        Ok(out.to_string())
    })
}

/// Printing count of the loaded store (the upstream `size()` health number);
/// 0 when no store is loaded, mirroring the pyo3 surface's "empty engine".
#[wasm_bindgen]
pub fn size() -> u32 {
    STORE.with(|s| s.try_borrow().ok().and_then(|g| g.as_ref().map(|st| st.size() as u32)).unwrap_or(0))
}

/// Oracle-card count of the loaded store; 0 when no store is loaded.
#[wasm_bindgen]
pub fn card_count() -> u32 {
    STORE.with(|s| s.try_borrow().ok().and_then(|g| g.as_ref().map(|st| st.card_count() as u32)).unwrap_or(0))
}

/// The archive format version this build reads/writes. A store manifest's
/// `format_version` must match, or `finish_store_load` will reject the bytes.
#[wasm_bindgen]
pub fn store_version() -> u32 {
    card_engine::store_format_version()
}

/// `n` randomly sampled oracle cards, each as the printing the FILTER chose (its
/// default-preferred one when there is no filter) — the engine behind
/// /random_search. `seed` comes from the caller (JS `crypto.getRandomValues` or
/// per-request entropy): the sampling itself is deterministic per seed.
/// `fields_json` is a JSON list of field names, or "null"/"" for the default
/// field set. Returns a JSON array of card objects.
///
/// `filter_tree_json` is the LOCAL ADDITION: the same wire tree `search` takes,
/// or "null"/"" for the unfiltered pool. Without it this export could not
/// exclude anything and `/random_search` drew `is:extra` rows the search
/// surfaces hide — the route had nothing to gate with, because the pool is
/// here. A `TrueNode` costs nothing extra; see `sample_preferred`.
#[wasm_bindgen]
pub fn random_search(n: u32, seed: u64, filter_tree_json: &str, fields_json: &str) -> Result<String, JsError> {
    let fields: Option<Vec<String>> = if fields_json.is_empty() || fields_json == "null" {
        None
    } else {
        serde_json::from_str(fields_json)
            .map_err(|e| JsError::new(&format!("bad fields JSON: {e}")))?
    };
    let filter: Option<serde_json::Value> = if filter_tree_json.is_empty() || filter_tree_json == "null" {
        None
    } else {
        Some(
            serde_json::from_str(filter_tree_json)
                .map_err(|e| JsError::new(&format!("bad filter JSON: {e}")))?,
        )
    };
    with_store(|store| {
        let rows = store.sample_preferred(n as usize, seed, filter.as_ref(), fields).map_err(js_err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    })
}

// ─── Single-card addressing (the Scryfall-compatible /cards/* surface) ───────
//
// Every one of these runs inside the Durable Object, where CPU is metered against 30 s rather than
// the isolate's 10 ms. `fields_json` is a JSON list of field names, or "null"/"" for the default
// set, exactly like `random_search` above. A miss is JSON `null`, which the caller turns into
// Scryfall's 404 error object — this port has no SQL to fall back to, so a miss IS the answer.

/// Parse the shared `fields_json` argument.
fn parse_fields(fields_json: &str) -> Result<Option<Vec<String>>, JsError> {
    if fields_json.is_empty() || fields_json == "null" {
        return Ok(None);
    }
    serde_json::from_str(fields_json).map_err(|e| JsError::new(&format!("bad fields JSON: {e}")))
}

/// One card by Scryfall id, or `null`.
#[wasm_bindgen]
pub fn card_by_scryfall_id(scryfall_id: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let found = store.card_by_scryfall_id(scryfall_id, fields).map_err(js_err)?;
        Ok(found.unwrap_or(serde_json::Value::Null).to_string())
    })
}

/// Cards by Scryfall id, in the order given, skipping misses. One boundary crossing for the whole
/// batch: `POST /cards/collection` resolves up to 175 identifiers.
#[wasm_bindgen]
pub fn cards_by_scryfall_ids(ids_json: &str, fields_json: &str) -> Result<String, JsError> {
    let ids: Vec<String> =
        serde_json::from_str(ids_json).map_err(|e| JsError::new(&format!("bad ids JSON: {e}")))?;
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let rows = store.cards_by_scryfall_ids(&ids, fields).map_err(js_err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    })
}

/// Every printing of one oracle card, representative first. Empty array for an unknown id.
#[wasm_bindgen]
pub fn printings_of_oracle_id(oracle_id: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let rows = store.printings_of_oracle_id(oracle_id, fields).map_err(js_err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    })
}

/// One card by a marketplace or client id, or `null`. `namespace` is Scryfall's own path segment.
#[wasm_bindgen]
pub fn card_by_external_id(namespace: &str, external_id: u64, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let found = store.card_by_external_id(namespace, external_id, fields).map_err(js_err)?;
        Ok(found.unwrap_or(serde_json::Value::Null).to_string())
    })
}

/// Scryfall's `?fuzzy=` name lookup. Returns `{"status": "hit"|"ambiguous"|"miss", "card": ...}`.
///
/// `ambiguous` stays distinct from `miss` because Scryfall reports it, and answering 404 would
/// tell the client the card does not exist.
#[wasm_bindgen]
pub fn fuzzy_card_by_name(name: &str, floor: f32, lead: f32, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let (status, card) = store.fuzzy_card_by_name(name, floor, lead, fields).map_err(js_err)?;
        Ok(serde_json::json!({ "status": status, "card": card }).to_string())
    })
}

/// The best printing of a card whose FOLDED name matches exactly, or `null`.
///
/// `folded` must already be lowercased and accent-folded by the caller (foldAccents in
/// src/parser/pystr.ts), the same way `card_name_folded` was at import. `set_code` is "" for no
/// set restriction.
#[wasm_bindgen]
pub fn exact_card_by_name(folded: &str, set_code: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    let set = if set_code.is_empty() { None } else { Some(set_code) };
    with_store(|store| {
        let found = store.exact_card_by_name(folded, set, fields).map_err(js_err)?;
        Ok(found.unwrap_or(serde_json::Value::Null).to_string())
    })
}

/// How well this partition's best `exact=` candidate matches, as `[served, tier, score]`, or
/// `null`.
///
/// Served is 1 when the printing answered is one a default search shows and 0 when the name
/// exists only in the extras class (a memorabilia front card, a token, an art-series card);
/// tier descends 2 (the needle IS a card's whole name) > 1 (it matches a FACE) > 0 (a FLAVOR
/// name); ties break on prefer_score. Compared lexicographically, in that order — served leads,
/// so `exact=Earth Rumble` answers the tla sorcery over the jtla front card of the same name
/// whatever partition each hashed to. Compare these, do not interpret them.
///
/// EXISTS FOR THE PARTITIONED ROUTER. `exact_card_by_name` ranks its candidates, but with the
/// corpus cut into partitions that ranking is LOCAL — and more than one partition can answer,
/// because a needle is often one card's whole name and another card's face name, and those two
/// cards hash apart. Taking the first non-null answer discarded the ranking and returned whichever
/// partition replied first. The router now ranks every partition with this and materializes only
/// the winner, which is the same shape `fuzzy_candidates` already uses for the fuzzy race.
#[wasm_bindgen]
pub fn exact_name_rank(folded: &str, set_code: &str) -> Result<String, JsError> {
    let set = if set_code.is_empty() { None } else { Some(set_code) };
    with_store(|store| {
        Ok(match store.exact_name_rank(folded, set) {
            Some((served, tier, score)) => format!("[{served},{tier},{score}]"),
            None => "null".to_string(),
        })
    })
}

/// `exact_name_rank` and `exact_card_by_name` in ONE call, plus whether this store holds the
/// name at all — `{"rank": <exact_name_rank's text>, "present": bool, "card": <row or null>}`
/// (LOCAL PATCH, Cloudflare port).
///
/// FOR THE NAME ROUTE (backlog n6). The router asks the partition the routing filter names for a
/// name FIRST, and one reply has to be enough to decide whether it is the answer: the rank says
/// whether a served card won (which no other partition can beat when this one is the name's only
/// served holder), and `present` says whether a MISS is real. A set-restricted miss here is
/// authoritative only if this store holds the name at all — then the filter's word that no other
/// partition does is exact, rather than an arbitrary value for a key it never held. So `present`
/// is computed, without the set, only when the restricted scan found nothing.
///
/// `rank` is written by the same `format!` as `exact_name_rank`, so the router compares the two
/// exports' ranks as the same numbers.
#[wasm_bindgen]
pub fn exact_name_probe(folded: &str, set_code: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    let set = if set_code.is_empty() { None } else { Some(set_code) };
    with_store(|store| {
        let rank = store.exact_name_rank(folded, set);
        let present = rank.is_some() || (set.is_some() && store.exact_name_rank(folded, None).is_some());
        let card = match rank {
            Some(_) => store.exact_card_by_name(folded, set, fields).map_err(js_err)?,
            None => None,
        };
        let rank_text = match rank {
            Some((served, tier, score)) => format!("[{served},{tier},{score}]"),
            None => "null".to_string(),
        };
        Ok(format!(
            r#"{{"rank":{rank_text},"present":{present},"card":{}}}"#,
            card.unwrap_or(serde_json::Value::Null)
        ))
    })
}

/// The best printing a COLLECTION IDENTIFIER's `name` names, or `null` — `POST /cards/collection`.
///
/// NOT `exact_card_by_name` with a different caller: a collection identifier reads a card's FACE
/// names when the name splits in exactly two and its whole name otherwise, where `exact=` also
/// reads the joined name and the flavor names. `{"name":"Fire // Ice"}` is not_found on
/// api.scryfall.com and `exact=Fire // Ice` is Fire // Ice — see `collection_card_by_name`.
///
/// `folded` is lowercased and accent-folded by the caller (foldAccents in src/parser/pystr.ts);
/// the collating happens in the engine. `set_code` is "" for no set restriction.
///
/// `prefer` and `scope_json` are the batch's `?q=` — its folded prefer (this API's spelling,
/// "default" for none) and its filter tree as canonical JSON ("" for none); see the engine's
/// `CollectionScope`.
/// One call for the WHOLE batch — `identifiers_json` is `[[folded, set_code], …]` — so the scope
/// is bound once rather than once per identifier (a regex in the scope compiled 75 times was
/// the difference between 25ms and 165ms on a full batch). Answers a JSON array, a card object or
/// `null` per identifier, in order.
#[wasm_bindgen]
pub fn collection_cards_by_names(
    identifiers_json: &str,
    fields_json: &str,
    prefer: &str,
    scope_json: &str,
) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    let idents = parse_identifiers(identifiers_json)?;
    let scope = parse_scope(prefer, scope_json)?;
    with_store(|store| {
        let borrowed: Vec<(&str, Option<&str>)> =
            idents.iter().map(|(f, s)| (f.as_str(), s.as_deref())).collect();
        let found = store.collection_cards_by_names(&borrowed, fields, scope.as_ref()).map_err(js_err)?;
        let out: Vec<serde_json::Value> = found.into_iter().map(|c| c.unwrap_or(serde_json::Value::Null)).collect();
        Ok(serde_json::Value::Array(out).to_string())
    })
}

/// `[[folded, set_code], …]` off the wire; an empty set code is no set restriction.
fn parse_identifiers(identifiers_json: &str) -> Result<Vec<(String, Option<String>)>, JsError> {
    let raw: Vec<(String, String)> = serde_json::from_str(identifiers_json)
        .map_err(|e| JsError::new(&format!("collection identifiers are not [[folded, set], …]: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|(folded, set)| (folded, if set.is_empty() { None } else { Some(set) }))
        .collect())
}

/// The wire form of a collection scope, or `None` when the batch sent no `?q=` at all.
fn parse_scope(prefer: &str, scope_json: &str) -> Result<Option<card_engine::CollectionScope>, JsError> {
    if scope_json.is_empty() && (prefer.is_empty() || prefer == "default") {
        return Ok(None);
    }
    let filter_tree = if scope_json.is_empty() {
        None
    } else {
        Some(serde_json::from_str(scope_json).map_err(|e| JsError::new(&format!("collection scope is not JSON: {e}")))?)
    };
    Ok(Some(card_engine::CollectionScope { prefer: prefer.to_owned(), filter_tree }))
}

/// How well this partition's best collection-identifier candidate matches, as
/// `[served, tier, score]` or `null` per identifier — the batched twin of `exact_name_rank`, and
/// there for the same partitioned router. Under a scope the score is the scope's prefer score
/// and served is always 1 (the scope's pool holds no extras).
#[wasm_bindgen]
pub fn collection_name_ranks(identifiers_json: &str, prefer: &str, scope_json: &str) -> Result<String, JsError> {
    let idents = parse_identifiers(identifiers_json)?;
    let scope = parse_scope(prefer, scope_json)?;
    with_store(|store| {
        let borrowed: Vec<(&str, Option<&str>)> =
            idents.iter().map(|(f, s)| (f.as_str(), s.as_deref())).collect();
        let ranks = store.collection_name_ranks(&borrowed, scope.as_ref()).map_err(js_err)?;
        let out: Vec<serde_json::Value> = ranks
            .into_iter()
            .map(|r| match r {
                Some((served, tier, score)) => serde_json::json!([served, tier, score]),
                None => serde_json::Value::Null,
            })
            .collect();
        Ok(serde_json::Value::Array(out).to_string())
    })
}

/// The best printing carrying this illustration id, or `null`.
#[wasm_bindgen]
pub fn card_by_illustration_id(illustration_id: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let found = store.card_by_illustration_id(illustration_id, fields).map_err(js_err)?;
        Ok(found.unwrap_or(serde_json::Value::Null).to_string())
    })
}

/// A whole `POST /cards/collection` batch against THIS store in one call (LOCAL PATCH, Cloudflare
/// port) — every identifier kind at once, answered as finished card objects.
///
/// The partitioned router used to spend up to 2N + N + N calls on one batch: `{name}` ranked on
/// every partition and then materialized from the winners, `{set, collector_number}` fanned out on
/// its own, and the id kinds on theirs. This answers all of them in ONE round: each name comes
/// back with its rank AND its local winner's card, so the router keeps the global winner's card
/// without asking again. That is exact, not a guess: the winning partition's local pick is the
/// same card its second-round materialize would have returned, because `collection_name_ranks`
/// and `collection_cards_by_names` rank by the same `name_best`.
///
/// `request_json` is `{"keys": [...], "trees": [...], "tree_opts": {...}, "names": [[folded,
/// set], ...], "prefer": "...", "scope": "..."}`:
///
/// - `keys`: `{"kind": "scryfall_id" | "oracle_id" | "illustration_id", "id": "<uuid>"}` or
///   `{"kind": "external", "namespace": "mtgo" | "multiverse" | ..., "id": <n>}`. An oracle id
///   answers its representative printing, as `/cards/collection` always has.
/// - `trees`: filter trees as JSON strings, each answered by its first row under `tree_opts`.
/// - `names`, `prefer`, `scope`: exactly `collection_cards_by_names`'s arguments.
///
/// The answer is little-endian bytes:
///
/// ```text
/// header_len: u32, header: header_len bytes of JSON — one rank per name, [served, tier, score] or null
/// then for each key, each tree, each name, in that order: len: u32, card: len bytes (0 = none)
/// ```
///
/// Cards are written by `write_scryfall_card`, the builder `/cards/search` uses, so the router
/// splices them into the response without parsing them.
#[wasm_bindgen]
pub fn collection_batch(request_json: &str, fields_json: &str, base_url: &str) -> Result<Vec<u8>, JsError> {
    let req: serde_json::Value =
        serde_json::from_str(request_json).map_err(|e| JsError::new(&format!("bad collection batch JSON: {e}")))?;
    let fields = parse_fields(fields_json)?;
    let list = |name: &str| req.get(name).and_then(serde_json::Value::as_array).map_or(&[][..], Vec::as_slice);
    let (keys, trees) = (list("keys"), list("trees"));
    let idents: Vec<(String, Option<String>)> = list("names")
        .iter()
        .map(|pair| {
            let at = |i: usize| pair.get(i).and_then(serde_json::Value::as_str).unwrap_or_default();
            (at(0).to_owned(), if at(1).is_empty() { None } else { Some(at(1).to_owned()) })
        })
        .collect();
    let text = |name: &str| req.get(name).and_then(serde_json::Value::as_str).unwrap_or_default();
    let scope = parse_scope(text("prefer"), text("scope"))?;
    let tree_opts = match req.get("tree_opts") {
        Some(opts) if !trees.is_empty() => Some(QueryOptions::from_json_str(&opts.to_string()).map_err(js_err)?),
        _ => None,
    };

    with_store(|store| {
        let names: Vec<(&str, Option<&str>)> = idents.iter().map(|(f, s)| (f.as_str(), s.as_deref())).collect();
        let (ranks, name_cards) = if names.is_empty() {
            (Vec::new(), Vec::new())
        } else {
            (
                store.collection_name_ranks(&names, scope.as_ref()).map_err(js_err)?,
                store.collection_cards_by_names(&names, fields.clone(), scope.as_ref()).map_err(js_err)?,
            )
        };
        let rank_list: Vec<serde_json::Value> = ranks
            .iter()
            .map(|r| match r {
                Some((served, tier, score)) => serde_json::json!([served, tier, score]),
                None => serde_json::Value::Null,
            })
            .collect();
        // `"presence": true` (the name route, backlog n6) widens the header to `{"ranks": [...],
        // "present": [...]}`: per name, whether this store holds it AT ALL — no set, no scope, and
        // `exact=`'s wider name rule, i.e. `exact_name_rank(folded, None)` — computed only for a
        // name the restricted scan missed. See `exact_name_probe` for why a routed miss needs it.
        let header = if req.get("presence").and_then(serde_json::Value::as_bool).unwrap_or(false) {
            let present: Vec<bool> = ranks
                .iter()
                .zip(&names)
                .map(|(rank, (folded, _))| rank.is_some() || store.exact_name_rank(folded, None).is_some())
                .collect();
            serde_json::json!({ "ranks": rank_list, "present": present })
        } else {
            serde_json::Value::Array(rank_list)
        };
        let header = serde_json::to_vec(&header).map_err(|e| JsError::new(&e.to_string()))?;

        let mut buf = Vec::with_capacity(4 + header.len() + (keys.len() + trees.len() + names.len()) * 2048);
        buf.extend_from_slice(&(header.len() as u32).to_le_bytes());
        buf.extend_from_slice(&header);
        for key in keys {
            let found = collection_key_card(store, key, fields.clone())?;
            write_optional_card(&mut buf, found.as_ref(), base_url)?;
        }
        for tree in trees {
            let (Some(tree), Some(opts)) = (tree.as_str(), tree_opts.as_ref()) else {
                return Err(JsError::new("collection trees must be JSON strings, with tree_opts"));
            };
            let first = store.query(tree, opts).map_err(js_err)?.rows.into_iter().next();
            write_optional_card(&mut buf, first.as_ref(), base_url)?;
        }
        for card in &name_cards {
            write_optional_card(&mut buf, card.as_ref(), base_url)?;
        }
        Ok(buf)
    })
}

/// One `collection_batch` key, resolved the way its single-card route resolves it.
fn collection_key_card(
    store: &BufferStore,
    key: &serde_json::Value,
    fields: Option<Vec<String>>,
) -> Result<Option<serde_json::Value>, JsError> {
    let text = |name: &str| key.get(name).and_then(serde_json::Value::as_str).unwrap_or_default();
    match text("kind") {
        "scryfall_id" => store.card_by_scryfall_id(text("id"), fields).map_err(js_err),
        // Printings are stored in descending default-prefer order, so the first is the
        // representative printing every by-name path shows.
        "oracle_id" => Ok(store.printings_of_oracle_id(text("id"), fields).map_err(js_err)?.into_iter().next()),
        "illustration_id" => store.card_by_illustration_id(text("id"), fields).map_err(js_err),
        "external" => {
            let id = key.get("id").and_then(serde_json::Value::as_u64).ok_or_else(|| JsError::new("external id must be a number"))?;
            store.card_by_external_id(text("namespace"), id, fields).map_err(js_err)
        }
        other => Err(JsError::new(&format!("unknown collection key kind {other:?}"))),
    }
}

/// A framed card, or a zero length for none — `collection_batch`'s slot encoding.
fn write_optional_card(buf: &mut Vec<u8>, row: Option<&serde_json::Value>, base_url: &str) -> Result<(), JsError> {
    match row {
        Some(row) => write_framed_row(buf, row, RowShape::Cards, base_url),
        None => {
            buf.extend_from_slice(&0u32.to_le_bytes());
            Ok(())
        }
    }
}

/// One card per distinct name containing EVERY word, best printing each, up to `limit`.
/// The containment stage of `/cards/named?fuzzy=`; the caller asks for 2 and reads the count.
#[wasm_bindgen]
pub fn cards_containing_all_words(
    words_json: &str,
    set_code: &str,
    limit: u32,
    fields_json: &str,
) -> Result<String, JsError> {
    let words: Vec<String> =
        serde_json::from_str(words_json).map_err(|e| JsError::new(&format!("bad words JSON: {e}")))?;
    let fields = parse_fields(fields_json)?;
    let set = if set_code.is_empty() { None } else { Some(set_code) };
    with_store(|store| {
        let rows = store.cards_containing_all_words(&words, set, limit as usize, fields).map_err(js_err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    })
}

/// Card names matching a partial name, prefix matches first. Scryfall's autocomplete catalog.
#[wasm_bindgen]
pub fn autocomplete(prefix: &str, limit: u32) -> Result<String, JsError> {
    with_store(|store| Ok(serde_json::to_string(&store.autocomplete(prefix, limit as usize)).unwrap_or_else(|_| "[]".into())))
}

// ─── The partitioned two-phase gather (LOCAL PATCH, Cloudflare port) ─────────
// Phase 1 asks every partition for its page's opaque sort keys; the gather DO bytewise-merges
// the streams (each key leads with a version byte — refuse mixed versions) and phase 2 fetches
// only the rows that survived the merge, from the partitions that own them.

/// The phase-1 packet layout this build emits and `src/engine/gather.ts` decodes.
///
/// It leads the packet so the two sides can never disagree silently: a gather reading a packet
/// whose version it does not know REFUSES it, the same way it refuses a key stream whose
/// `sort_key_version` disagrees. Version 1 was keys-only (`total, n, entries…`); version 2 adds
/// the inline-row section that folds phase 2 into phase 1; version 3 adds a `flags` word to the
/// header (bit 0: the query ran the widened driver), so the gather learns `widened` from the
/// reply instead of binding the filter a second time on its own store.
pub const KEY_PACKET_VERSION: u32 = 3;

/// `flags` bit 0: the query ran the multilingual (widened) driver.
pub const KEY_PACKET_FLAG_WIDENED: u32 = 1;

/// The shape every framed row takes on the wire, named by the caller of [`query_keys`] and
/// [`fetch_rows`]: the engine row's own JSON, or the Scryfall card object built from it.
///
/// The card shape goes through `card_engine::card_object::write_scryfall_card` — the SAME writer
/// [`scryfall_search`] runs over a whole page — so a page the gather splices from framed rows
/// (`[` + rows joined by `,` + `]`) is byte-identical to the one that export would have written.
/// That is what lets the coordinating object assemble `/cards/search` without parsing or
/// re-serialising a card: every pass over the payload that the single-store path had already
/// removed (see src/engine/store.ts's `scryfallSearch`) stays removed on the partitioned path.
///
/// Two more shapes write JSON as JAVASCRIPT spells it (see [`write_js_json`], backlog n11): the
/// columnar frame `/search?shape=columnar` is assembled from, and JS-spelled rows for the page
/// exports whose callers always re-serialized through `JSON.stringify` ([`random_search_shaped`]).
#[derive(Clone, Copy)]
enum RowShape {
    Rows,
    Cards,
    /// `nfields: u16`, then per field, in the row's key order, `vlen: u32 LE` and the value's JSON
    /// in JavaScript's spelling: one row's column values, which src/engine/columnar.ts's
    /// `assembleColumnar` splices into `{"k":[…],…}` without a parser.
    Columns,
    /// The row's JSON in JavaScript's spelling. Never asked for by name on the gather's wire:
    /// [`parse_shape`] does not accept it; [`parse_page_shape`] spells it `"rows"`.
    JsRows,
}

/// A plain `String` error rather than a `JsError`, so the rejection is testable natively:
/// `JsError::new` is a wasm-bindgen import and panics off-target.
fn parse_shape(shape: &str) -> Result<RowShape, String> {
    match shape {
        "rows" => Ok(RowShape::Rows),
        "cards" => Ok(RowShape::Cards),
        "columns" => Ok(RowShape::Columns),
        other => Err(format!("unknown row shape {other:?}: expected \"rows\", \"cards\" or \"columns\"")),
    }
}

/// One framed row: `len: u32 LE`, then `len` bytes in `shape`. The length is patched in after the
/// write so the card writer streams straight into the packet with no intermediate buffer.
fn write_framed_row(
    buf: &mut Vec<u8>,
    row: &serde_json::Value,
    shape: RowShape,
    base_url: &str,
) -> Result<(), JsError> {
    let len_at = buf.len();
    buf.extend_from_slice(&[0u8; 4]);
    match shape {
        RowShape::Rows => serde_json::to_writer(&mut *buf, row).map_err(|e| JsError::new(&e.to_string()))?,
        RowShape::Cards => match row {
            serde_json::Value::Object(map) => card_engine::card_object::write_scryfall_card(buf, map, base_url),
            _ => return Err(JsError::new("a card-shaped row must be a JSON object")),
        },
        RowShape::Columns => match row {
            serde_json::Value::Object(map) => write_columns_frame(buf, map).map_err(|m| JsError::new(&m))?,
            _ => return Err(JsError::new("a column-shaped row must be a JSON object")),
        },
        RowShape::JsRows => write_js_json(buf, row),
    }
    let len = u32::try_from(buf.len() - len_at - 4).map_err(|_| JsError::new("framed row exceeds u32 length"))?;
    buf[len_at..len_at + 4].copy_from_slice(&len.to_le_bytes());
    Ok(())
}

/// Phase 1: the same query [`query`] runs, answered as keys — and, for the first `inline_rows`
/// of them, the rows too — packed little-endian:
///
/// ```text
/// version: u32 (= KEY_PACKET_VERSION)
/// total: u32, n: u32, inline: u32, flags: u32 (KEY_PACKET_FLAG_WIDENED)
/// n      of: keylen: u16, key: keylen bytes, vpid: u32
/// inline of: rowlen: u32, row bytes in `shape`
/// ```
///
/// `total` is the partition's exact match count; the keys are its top `offset + limit` in page
/// order. The key bytes are comparable across partitions (see card_engine's `encode_sort_key`);
/// `vpid` is meaningful only against the SAME loaded store — hand it back to [`fetch_rows`] on
/// this partition, never another.
///
/// THE INLINE SECTION IS A PREFIX, and each row is framed separately rather than shipped as one
/// JSON array on purpose: most of them lose the cross-partition merge, and a gather that had to
/// parse the whole array to reach the few survivors would pay for the losers twice — once on the
/// wire and once in the parser. Framed, it splices exactly the rows the page kept.
///
/// `shape` is `"rows"` or `"cards"` (see [`RowShape`]); `base_url` matters only for cards. The
/// packet itself does not record the shape — the RPC reply that carries it does, which is what
/// lets a gather tell a sibling still on the previous build (row JSON, no shape) from one that
/// answered in the shape it asked for. The `"cards"` shape builds from whatever `fields` the opts
/// name; the caller widens them to the card-object set, as the single-store path does.
#[wasm_bindgen]
pub fn query_keys(
    filter_tree_json: &str,
    opts_json: &str,
    inline_rows: u32,
    shape: &str,
    base_url: &str,
) -> Result<Vec<u8>, JsError> {
    let shape = parse_shape(shape).map_err(|m| JsError::new(&m))?;
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    let tree: serde_json::Value =
        serde_json::from_str(filter_tree_json).map_err(|e| JsError::new(&e.to_string()))?;
    with_store(|store| {
        let out = store.query_keys(&tree, &opts, inline_rows as usize).map_err(js_err)?;
        let mut buf = Vec::with_capacity(20 + out.keys.iter().map(|(k, _)| k.len() + 6).sum::<usize>());
        buf.extend_from_slice(&KEY_PACKET_VERSION.to_le_bytes());
        buf.extend_from_slice(&u32::try_from(out.total).unwrap_or(u32::MAX).to_le_bytes());
        buf.extend_from_slice(&(out.keys.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(out.rows.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(if out.widened { KEY_PACKET_FLAG_WIDENED } else { 0 }).to_le_bytes());
        for (key, vpid) in &out.keys {
            let len = u16::try_from(key.len())
                .map_err(|_| JsError::new("sort key exceeds u16 length"))?;
            buf.extend_from_slice(&len.to_le_bytes());
            buf.extend_from_slice(key);
            buf.extend_from_slice(&vpid.to_le_bytes());
        }
        for row in &out.rows {
            write_framed_row(&mut buf, row, shape, base_url)?;
        }
        Ok(buf)
    })
}

/// Phase 2: the rows for `vpids` (a Uint32Array from this partition's own phase 1), in CALLER
/// order, as a ROW PACKET — `n: u32 LE`, then `n` framed rows exactly as [`query_keys`] frames
/// its inline section, in the same `shape`. Individually framed rather than one JSON array so the
/// coordinator splices them into the page by memcpy, never through a parser. An unknown vpid is
/// a loud error — the ids came from this same store moments ago, so a miss means the caller
/// mixed partitions or generations.
#[wasm_bindgen]
pub fn fetch_rows(vpids: &[u32], fields_json: &str, shape: &str, base_url: &str) -> Result<Vec<u8>, JsError> {
    let shape = parse_shape(shape).map_err(|m| JsError::new(&m))?;
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let rows = store.fetch_rows(vpids, fields).map_err(js_err)?;
        let mut buf = Vec::with_capacity(4 + rows.len() * 2048);
        buf.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        for row in &rows {
            write_framed_row(&mut buf, row, shape, base_url)?;
        }
        Ok(buf)
    })
}

// ─── JavaScript-spelled pages: the columnar shape (LOCAL PATCH, Cloudflare port, n11) ────────
//
// `/search?shape=columnar` (the site's own search and its `/random_search` preload) was written by
// JavaScript: the engine's rows went through `JSON.parse`, were inverted into one list per field,
// and came back out of `JSON.stringify`. That round trip is most of what a columnar page costs,
// and the bytes it produces differ from the engine's in one respect only: NUMBERS are spelled the
// way JavaScript spells them (`5.0` is `5`, `-0.0` is `0`, `1e21` is `1e+21`, a u64 past 2^53 is
// rounded). Everything below writes those bytes directly, so the page is assembled by memcpy
// (src/engine/columnar.ts's `assembleColumnar`) and stays byte-identical to what it replaced —
// `tests/engine/columnar-parity.test.ts` diffs the two.

/// A value's JSON exactly as `JSON.stringify(JSON.parse(serde_json::to_string(value)))` writes it.
///
/// Two things separate that from serde_json's own output:
///
/// - numbers, spelled by [`write_js_number`];
/// - object key ORDER: an object `JSON.parse` built lists its array-index keys ("0", "17") first,
///   ascending numerically, then the rest in insertion order — see [`JsEntries`].
///
/// String escaping already agrees: both escape `"`, `\` and the C0 controls (`\b \f \n \r \t` by
/// name, the rest as lowercase `\u00XX`), and neither escapes DEL, U+2028, U+2029 or anything
/// astral. A Rust string cannot hold the lone surrogate `JSON.stringify` would escape.
fn write_js_json(buf: &mut Vec<u8>, value: &serde_json::Value) {
    use serde_json::Value;
    match value {
        Value::Null => buf.extend_from_slice(b"null"),
        Value::Bool(true) => buf.extend_from_slice(b"true"),
        Value::Bool(false) => buf.extend_from_slice(b"false"),
        Value::Number(n) => write_js_number(buf, n),
        Value::String(s) => write_json_string(buf, s),
        Value::Array(items) => {
            buf.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    buf.push(b',');
                }
                write_js_json(buf, item);
            }
            buf.push(b']');
        }
        Value::Object(map) => {
            buf.push(b'{');
            for (i, (key, item)) in JsEntries::of(map).enumerate() {
                if i > 0 {
                    buf.push(b',');
                }
                write_json_string(buf, key);
                buf.push(b':');
                write_js_json(buf, item);
            }
            buf.push(b'}');
        }
    }
}

/// serde_json's string escaping, which is `JSON.stringify`'s (see [`write_js_json`]).
fn write_json_string(buf: &mut Vec<u8>, s: &str) {
    // Writing into a Vec cannot fail.
    let _ = serde_json::to_writer(&mut *buf, s);
}

/// An object's entries in the order JavaScript enumerates a parsed object's own keys.
enum JsEntries<'a> {
    /// No array-index key: the map's own order, which is what insertion order was.
    Plain(serde_json::map::Iter<'a>),
    /// Array-index keys first, ascending by value; then the others in the map's order.
    Reordered(std::vec::IntoIter<(&'a String, &'a serde_json::Value)>),
}

impl<'a> JsEntries<'a> {
    fn of(map: &'a serde_json::Map<String, serde_json::Value>) -> Self {
        if !map.keys().any(|k| js_array_index(k).is_some()) {
            return JsEntries::Plain(map.iter());
        }
        let mut indexed: Vec<(u32, (&'a String, &'a serde_json::Value))> =
            map.iter().filter_map(|(k, v)| js_array_index(k).map(|i| (i, (k, v)))).collect();
        indexed.sort_unstable_by_key(|(i, _)| *i);
        let mut ordered: Vec<(&'a String, &'a serde_json::Value)> = indexed.into_iter().map(|(_, kv)| kv).collect();
        ordered.extend(map.iter().filter(|(k, _)| js_array_index(k).is_none()));
        JsEntries::Reordered(ordered.into_iter())
    }
}

impl<'a> Iterator for JsEntries<'a> {
    type Item = (&'a String, &'a serde_json::Value);
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            JsEntries::Plain(it) => it.next(),
            JsEntries::Reordered(it) => it.next(),
        }
    }
}

/// `key` as an ECMAScript array index — the canonical decimal spelling of an integer in
/// `0..2^32 - 1` — or `None`. Those are the keys an object enumerates first.
fn js_array_index(key: &str) -> Option<u32> {
    let b = key.as_bytes();
    if b.is_empty() || b.len() > 10 || (b.len() > 1 && b[0] == b'0') || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    u32::try_from(value).ok().filter(|&v| v != u32::MAX)
}

/// The largest magnitude below which every integer is exactly a JavaScript number.
const JS_MAX_SAFE_MAGNITUDE: u64 = 1 << 53;

/// A JSON number as `JSON.stringify` writes the value `JSON.parse` read from serde_json's spelling.
///
/// An integer JavaScript holds exactly is written as-is. One past 2^53 is not held exactly: the
/// parse rounds it to the nearest double (ties to even — which is also what `as f64` does), and
/// that double is what gets written.
fn write_js_number(buf: &mut Vec<u8>, n: &serde_json::Number) {
    if let Some(u) = n.as_u64() {
        if u <= JS_MAX_SAFE_MAGNITUDE {
            let _ = write!(buf, "{u}");
        } else {
            write_js_f64(buf, u as f64);
        }
    } else if let Some(i) = n.as_i64() {
        if i.unsigned_abs() <= JS_MAX_SAFE_MAGNITUDE {
            let _ = write!(buf, "{i}");
        } else {
            write_js_f64(buf, i as f64);
        }
    } else if let Some(f) = n.as_f64() {
        write_js_f64(buf, f);
    }
}

/// A double as ECMAScript's Number::toString writes it (ECMA-262 §6.1.6.1.20), which is what
/// `JSON.stringify` writes for a finite number; NaN and the infinities are `null`.
///
/// The DIGITS are the shortest that round-trip — Rust's `{:e}` and JavaScript both produce the
/// shortest, closest decimal — so only the LAYOUT is JavaScript's own: with `k` digits and the
/// decimal point `n` places from the left of them (value = 0.d₁d₂…dₖ × 10ⁿ),
///
/// - `k ≤ n ≤ 21`: the digits then `n - k` zeros (`5`, and `1e20` is `100000000000000000000`);
/// - `0 < n ≤ 21`: a point after `n` digits (`12.5`);
/// - `-6 < n ≤ 0`: `0.`, `-n` zeros, the digits (`0.5`, `0.000001`);
/// - otherwise an exponent, always signed: `1e+21`, `1.5e-7`.
///
/// `-0` is `0`, as JavaScript writes it.
fn write_js_f64(buf: &mut Vec<u8>, x: f64) {
    if !x.is_finite() {
        buf.extend_from_slice(b"null");
        return;
    }
    if x == 0.0 {
        buf.push(b'0');
        return;
    }
    let mut sci = ShortText::default();
    // `{:e}` with no precision is the shortest round-trip form: `d[.ddd]e[-]x`.
    let _ = std::fmt::Write::write_fmt(&mut sci, format_args!("{:e}", x.abs()));
    let text = sci.as_bytes();
    let Some(e_at) = text.iter().position(|&c| c == b'e') else {
        // Unreachable: `{:e}` always writes an exponent.
        buf.extend_from_slice(text);
        return;
    };
    let exponent: i32 = std::str::from_utf8(&text[e_at + 1..]).ok().and_then(|t| t.parse().ok()).unwrap_or(0);
    let mut digits = [0u8; 20];
    let mut k = 0usize;
    for &c in &text[..e_at] {
        if c.is_ascii_digit() && k < digits.len() {
            digits[k] = c;
            k += 1;
        }
    }
    if k > 0 && !(digits[k - 1] - b'0').is_multiple_of(2) {
        k = js_even_tie(x.abs(), &mut digits, k, exponent);
    }
    let digits = &digits[..k];
    let k = k as i32;
    let n = exponent + 1;
    if x < 0.0 {
        buf.push(b'-');
    }
    if k <= n && n <= 21 {
        buf.extend_from_slice(digits);
        buf.resize(buf.len() + (n - k) as usize, b'0');
    } else if 0 < n && n <= 21 {
        buf.extend_from_slice(&digits[..n as usize]);
        buf.push(b'.');
        buf.extend_from_slice(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        buf.extend_from_slice(b"0.");
        buf.resize(buf.len() + (-n) as usize, b'0');
        buf.extend_from_slice(digits);
    } else {
        buf.push(digits[0]);
        if k > 1 {
            buf.push(b'.');
            buf.extend_from_slice(&digits[1..]);
        }
        let e = n - 1;
        let _ = write!(buf, "e{}{}", if e < 0 { '-' } else { '+' }, e.unsigned_abs());
    }
}

/// The one place the DIGITS differ: when two shortest `k`-digit decimals are EXACTLY as close to
/// `ax` and both read back as it, ECMAScript takes the one whose last digit is even (Number::toString
/// step 5: "if there are two such possible values of s, choose the one that is even"), where Rust's
/// shortest formatter takes the upper — `2^-25` is `2.9802322387695312e-8` in V8 and `…313e-8` in
/// Rust. A tie needs `ax`'s exact expansion to be the midpoint, k + 1 digits ending in 5, so this is
/// called only for an odd last digit and returns at the first cheap check that fails; the exact
/// expansion (a double has at most 767 significant digits) is formatted only for a real candidate.
///
/// Rewrites `digits` to the even neighbour when that is JavaScript's answer, and returns the digit
/// count.
fn js_even_tie(ax: f64, digits: &mut [u8; 20], k: usize, exponent: i32) -> usize {
    let near = format!("{ax:.k$e}"); // k + 1 significant digits, exactly rounded
    let Some((mantissa, exp)) = near.split_once('e') else { return k };
    if exp.parse::<i32>().ok() != Some(exponent) {
        return k;
    }
    let near_digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    if near_digits.len() != k + 1 || near_digits[k] != b'5' {
        return k;
    }
    let exact = format!("{ax:.767e}");
    let mut exact_digits = exact.split_once('e').map_or("", |(m, _)| m).bytes().filter(u8::is_ascii_digit);
    if !near_digits.iter().all(|&d| exact_digits.next() == Some(d)) || exact_digits.any(|d| d != b'0') {
        return k;
    }
    // A true midpoint between `lower` and `lower + 1` in the last place.
    let lower = &near_digits[..k];
    let mut upper = lower.to_vec();
    let mut i = k;
    loop {
        if i == 0 {
            return k; // 99…9 + 1 carries into another digit: not a pair of k-digit decimals
        }
        i -= 1;
        if upper[i] == b'9' {
            upper[i] = b'0';
        } else {
            upper[i] += 1;
            break;
        }
    }
    let even: &[u8] = if (lower[k - 1] - b'0').is_multiple_of(2) { lower } else { &upper };
    if even == &digits[..k] {
        return k;
    }
    // Only if it reads back as `ax` — at a power of two the spacing below is half the spacing above.
    let text = format!("{}e{}", std::str::from_utf8(even).unwrap_or("0"), exponent - (k as i32 - 1));
    if text.parse::<f64>().ok() != Some(ax) {
        return k;
    }
    digits[..k].copy_from_slice(even);
    let mut kept = k;
    while kept > 1 && digits[kept - 1] == b'0' {
        kept -= 1;
    }
    kept
}

/// A fixed stack buffer for one formatted double (`{:e}` of an f64 is at most 24 bytes).
#[derive(Default)]
struct ShortText {
    bytes: [u8; 32],
    len: usize,
}

impl ShortText {
    fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

impl std::fmt::Write for ShortText {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let end = self.len + s.len();
        if end > self.bytes.len() {
            return Err(std::fmt::Error);
        }
        self.bytes[self.len..end].copy_from_slice(s.as_bytes());
        self.len = end;
        Ok(())
    }
}

/// One row as a [`RowShape::Columns`] frame body: `nfields: u16`, then each value as
/// `vlen: u32 LE` + its JavaScript-spelled JSON, in the order JavaScript enumerates the row's keys
/// (which, for the engine's field names, is the map's sorted order — the order `columnKeys` in
/// src/engine/columnar.ts derives from the request's fields). The keys themselves are NOT
/// written: every row of a page carries the same ones, so the assembler writes them once.
fn write_columns_frame(buf: &mut Vec<u8>, map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let nfields = u16::try_from(map.len()).map_err(|_| format!("a column frame holds at most 65535 fields, not {}", map.len()))?;
    buf.extend_from_slice(&nfields.to_le_bytes());
    for (_, value) in JsEntries::of(map) {
        let at = buf.len();
        buf.extend_from_slice(&[0u8; 4]);
        write_js_json(buf, value);
        let len = u32::try_from(buf.len() - at - 4).map_err(|_| "a column value exceeds u32 length".to_owned())?;
        buf[at..at + 4].copy_from_slice(&len.to_le_bytes());
    }
    Ok(())
}

/// The shapes a whole-page export writes: `"rows"` ([`RowShape::JsRows`] — JavaScript's spelling,
/// unlike the gather's `"rows"`) or `"columns"`.
fn parse_page_shape(shape: &str) -> Result<RowShape, String> {
    match shape {
        "rows" => Ok(RowShape::JsRows),
        "columns" => Ok(RowShape::Columns),
        other => Err(format!("unknown page shape {other:?}: expected \"rows\" or \"columns\"")),
    }
}

/// `rows` as a row packet — `n: u32 LE`, then each row framed as [`write_framed_row`] frames it.
fn page_packet(rows: &[serde_json::Value], shape: RowShape, prefix: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut buf = Vec::with_capacity(prefix.len() + 4 + rows.len() * 512);
    buf.extend_from_slice(prefix);
    buf.extend_from_slice(&u32::try_from(rows.len()).unwrap_or(u32::MAX).to_le_bytes());
    for row in rows {
        write_framed_row(&mut buf, row, shape, "")?;
    }
    Ok(buf)
}

/// The same query as [`query`], answered as `total: u32 LE` followed by a row packet of the page
/// in `shape` (see [`parse_page_shape`]) — the single-store `/search?shape=columnar`.
///
/// Its own export rather than [`query_keys`] + [`fetch_rows`]: those answer a page at `offset` by
/// fetching all `offset + limit` keys first, and a deep page would pay for every row before it.
#[wasm_bindgen]
pub fn query_shaped(filter_tree_json: &str, opts_json: &str, shape: &str) -> Result<Vec<u8>, JsError> {
    let shape = parse_page_shape(shape).map_err(|m| JsError::new(&m))?;
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    with_store(|store| {
        let out = store.query(filter_tree_json, &opts).map_err(js_err)?;
        let total = u32::try_from(out.total).unwrap_or(u32::MAX);
        page_packet(&out.rows, shape, &total.to_le_bytes())
    })
}

/// [`random_search`]'s draw — same arguments, same seed semantics, the same rows — answered as a
/// row packet in `shape` (see [`parse_page_shape`]), for `/random_search` and `/cards/random`.
/// Both routes' callers wrote the draw through `JSON.stringify`, so `"rows"` is JavaScript's
/// spelling too: the joined frames are the bytes they wrote.
#[wasm_bindgen]
pub fn random_search_shaped(
    n: u32,
    seed: u64,
    filter_tree_json: &str,
    fields_json: &str,
    shape: &str,
) -> Result<Vec<u8>, JsError> {
    let shape = parse_page_shape(shape).map_err(|m| JsError::new(&m))?;
    let fields = parse_fields(fields_json)?;
    let filter: Option<serde_json::Value> = if filter_tree_json.is_empty() || filter_tree_json == "null" {
        None
    } else {
        Some(serde_json::from_str(filter_tree_json).map_err(|e| JsError::new(&format!("bad filter JSON: {e}")))?)
    };
    with_store(|store| {
        let rows = store.sample_preferred(n as usize, seed, filter.as_ref(), fields).map_err(js_err)?;
        page_packet(&rows, shape, &[])
    })
}

/// Rows given as a JSON array, written as a row packet in `shape` — FOR THE PARITY TEST
/// (tests/engine/columnar-parity.test.ts), which diffs it against `serializeCards` over rows
/// built to break the writer. Needs no store; not on any request path.
#[wasm_bindgen]
pub fn shaped_frames_from_rows(rows_json: &str, shape: &str) -> Result<Vec<u8>, JsError> {
    let shape = parse_page_shape(shape).map_err(|m| JsError::new(&m))?;
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(rows_json).map_err(|e| JsError::new(&format!("rows are not a JSON array: {e}")))?;
    page_packet(&rows, shape, &[])
}

/// `values` as a JSON array in JavaScript's spelling — FOR THE PARITY TEST, which feeds it
/// doubles by their bits (a JSON round trip would let serde_json's best-effort float parse move
/// the value it is testing) and compares against `JSON.stringify`. Not on any request path.
#[wasm_bindgen]
pub fn js_spelled_numbers(values: &[f64]) -> String {
    let mut buf = Vec::with_capacity(values.len() * 24 + 2);
    buf.push(b'[');
    for (i, &v) in values.iter().enumerate() {
        if i > 0 {
            buf.push(b',');
        }
        write_js_f64(&mut buf, v);
    }
    buf.push(b']');
    String::from_utf8(buf).unwrap_or_default()
}

#[cfg(test)]
mod js_spelling_tests {
    use super::*;

    fn js(x: f64) -> String {
        let mut buf = Vec::new();
        write_js_f64(&mut buf, x);
        String::from_utf8(buf).expect("utf8")
    }

    fn js_value(v: &serde_json::Value) -> String {
        let mut buf = Vec::new();
        write_js_json(&mut buf, v);
        String::from_utf8(buf).expect("utf8")
    }

    /// Every layout branch of Number::toString, spelled as V8 spells it.
    #[test]
    fn doubles_are_spelled_as_javascript_spells_them() {
        let table: &[(f64, &str)] = &[
            (5.0, "5"),
            (-5.0, "-5"),
            (0.0, "0"),
            (-0.0, "0"),
            (0.5, "0.5"),
            (12.5, "12.5"),
            (-0.25, "-0.25"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e-6, "0.000001"),
            (1.5e-6, "0.0000015"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (-1.5e-7, "-1.5e-7"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
            (5e-324, "5e-324"),
            (0.1 + 0.2, "0.30000000000000004"),
            (9007199254740993.0, "9007199254740992"),
            // Exact midpoints of two shortest candidates: JavaScript takes the even one.
            (2f64.powi(-25), "2.9802322387695312e-8"),
            (6_632_827_120_354_249.0 / 4.0, "1658206780088562.2"),
            (-429_276_287_732_437.0 / 16.0, "-26829767983277.312"),
            (f64::NAN, "null"),
            (f64::INFINITY, "null"),
            (f64::NEG_INFINITY, "null"),
        ];
        for &(x, want) in table {
            assert_eq!(js(x), want, "{x:e}");
        }
    }

    #[test]
    fn integers_past_two_to_the_53_round_as_a_javascript_parse_rounds_them() {
        let v: serde_json::Value = serde_json::from_str(
            "[9007199254740992,9007199254740993,-9007199254740993,18446744073709551615,-9223372036854775808,5.0,-0.0]",
        )
        .expect("json");
        assert_eq!(
            js_value(&v),
            "[9007199254740992,9007199254740992,-9007199254740992,18446744073709552000,-9223372036854776000,5,0]"
        );
    }

    #[test]
    fn array_index_keys_enumerate_first_as_a_parsed_object_does() {
        let v: serde_json::Value = serde_json::from_str(r#"{"b":1,"10":2,"a":3,"9":4,"01":5,"4294967295":6,"4294967294":7}"#)
            .expect("json");
        // serde_json's map is sorted: 01, 10, 4294967294, 4294967295, 9, a, b. JavaScript lists
        // the array indices (9, 10, 4294967294 — not 01, not 2^32 - 1) first, by value.
        assert_eq!(js_value(&v), r#"{"9":4,"10":2,"4294967294":7,"01":5,"4294967295":6,"a":3,"b":1}"#);
    }

    /// The columnar keys are derived in TypeScript by SORTING the requested fields, which is right
    /// only while the engine's rows iterate in sorted key order — i.e. while serde_json's map is a
    /// BTreeMap. A dependency turning on serde_json's `preserve_order` feature would flip it to
    /// insertion order workspace-wide and silently permute every columnar page; this fails first.
    #[test]
    fn engine_rows_iterate_in_sorted_key_order() {
        let mut map = serde_json::Map::new();
        for key in ["type_line", "cmc", "name", "a"] {
            map.insert(key.to_owned(), serde_json::Value::Null);
        }
        let keys: Vec<&str> = map.keys().map(String::as_str).collect();
        assert_eq!(keys, ["a", "cmc", "name", "type_line"]);
    }

    #[test]
    fn a_columns_frame_is_nfields_then_length_prefixed_values() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"name":"Fire // Ice","cmc":4.0,"legal":{"modern":"legal"},"p":null}"#).expect("json");
        let serde_json::Value::Object(map) = v else { unreachable!() };
        let mut buf = Vec::new();
        write_columns_frame(&mut buf, &map).expect("frame");
        let mut want = vec![4u8, 0];
        for value in ["4", r#"{"modern":"legal"}"#, r#""Fire // Ice""#, "null"] {
            want.extend_from_slice(&(value.len() as u32).to_le_bytes());
            want.extend_from_slice(value.as_bytes());
        }
        assert_eq!(buf, want);
        assert!(parse_page_shape("cards").is_err());
        assert!(matches!(parse_shape("columns"), Ok(RowShape::Columns)));
        assert!(parse_shape("js_rows").is_err());
    }
}

/// The sort-key layout version this build emits (the first byte of every key). The gather
/// refuses to merge streams whose versions differ — a mixed-generation fan-out must fail loudly,
/// not return a silently misordered page.
#[wasm_bindgen]
pub fn sort_key_version() -> u8 {
    card_engine::SORT_KEY_VERSION
}

/// The scores-bearing fuzzy surface for the cross-partition FLOOR/LEAD race: this partition's
/// top `k` distinct (card, name) candidate classes clearing `floor`, packed little-endian:
///
/// ```text
/// n: u32, then n of:
///   score: f32 LE
///   oracle_id: 16 bytes (the uuid's big-endian byte order — render as the canonical
///              hyphenated string; all zeros = unset)
///   vpid: u32 LE (partition-local; meaningful only against THIS loaded store)
///   served: u8 (1 = a printing a default search shows, 0 = the card is extras-only; the
///           race's tiebreak on a score tie, so the served card of a shared name leads)
///   namelen: u16 LE, then namelen bytes of the folded name (UTF-8)
/// ```
///
/// The gather races the UNION of every partition's candidates with the engine's own rule:
/// global best by score; runner-up = best candidate differing from it in BOTH folded name and
/// oracle_id (a card never competes with itself, two cards sharing a name are one answer);
/// `hit` iff best − runner ≥ LEAD, then re-ask the winning partition's fuzzy_card_by_name —
/// whose local race the global winner provably also wins — to materialize the card.
#[wasm_bindgen]
pub fn fuzzy_candidates(name: &str, floor: f32, k: u32) -> Result<Vec<u8>, JsError> {
    with_store(|store| {
        let out = store.fuzzy_candidates(name, floor, k as usize);
        let mut buf = Vec::with_capacity(4 + out.len() * 40);
        buf.extend_from_slice(&(out.len() as u32).to_le_bytes());
        for c in &out {
            buf.extend_from_slice(&c.score.to_le_bytes());
            // The hyphenated uuid's 16 bytes (hex pairs in order); all zeros for "" (unset).
            let mut oracle = [0u8; 16];
            let mut nibbles = c.oracle_id.bytes().filter_map(|b| (b as char).to_digit(16).map(|d| d as u8));
            for slot in &mut oracle {
                match (nibbles.next(), nibbles.next()) {
                    (Some(hi), Some(lo)) => *slot = (hi << 4) | lo,
                    _ => {
                        oracle = [0u8; 16];
                        break;
                    }
                }
            }
            buf.extend_from_slice(&oracle);
            buf.extend_from_slice(&c.vpid.to_le_bytes());
            // The race's score-tie tiebreak: 1 when the vpid is a printing a default search shows.
            buf.push(u8::from(c.served));
            let len = u16::try_from(c.folded_name.len()).map_err(|_| JsError::new("name exceeds u16 length"))?;
            buf.extend_from_slice(&len.to_le_bytes());
            buf.extend_from_slice(c.folded_name.as_bytes());
        }
        Ok(buf)
    })
}

/// `/cards/named?fuzzy=` against THIS store in one call (LOCAL PATCH, Cloudflare port; backlog
/// n7): the exact stage, the typo stage and the containment stage together, so the partitioned
/// router asks each partition ONCE where it used to ask every partition three times over three
/// sequential rounds (probes, then fuzzy candidates plus the winner's materialize, then
/// containment).
///
/// Every section is written by the export that answers that stage alone, called here with the
/// same arguments, so the bundle cannot drift from them:
///
/// ```text
/// header_len: u32 LE, header: header_len bytes of JSON —
///   {"exact": <exact_name_probe(folded, set_code, fields)>,
///    "fuzzy": <fuzzy_card_by_name(folded, floor, lead, fields)> or null,
///    "contained": <cards_containing_all_words(words, set_code, limit, fields)> or null}
/// then the fuzzy_candidates(folded, floor, k) packet unchanged, or nothing
/// ```
///
/// A stage whose answer the router can never read is SKIPPED, which is what keeps one call no
/// dearer than the stages it replaces:
///
/// - This store ranks the needle exactly (`rank` non-null): nothing else is computed. Some
///   partition then has an exact rank, so the router's exact stage is certain to answer, and the
///   typo and containment stages never run anywhere. `fuzzy` and `contained` are null and there
///   are no candidate bytes.
/// - Otherwise the candidates are always computed (the router races every partition's). If there
///   is at least one, containment is skipped: the global race then has a leader, so it is a hit or
///   ambiguous and never falls through to containment. `contained` is null.
/// - With NO candidate, the local race is a miss by construction (`fuzzy_name_match` and
///   `fuzzy_candidates` offer the same scores against the same floor), so `fuzzy` is the miss
///   `fuzzy_card_by_name` would write, built by the same `json!` — without a second scan — and
///   containment runs.
///
/// `fuzzy` is this store's own local race, and the router uses it only when this partition wins
/// the global race: its local race is a sub-race the global winner also leads, which is the
/// materialize call the three-round router made to the winning partition.
///
/// `limit` is containment's; the route asks for 2 and reads two DISTINCT names as ambiguous.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn named_fuzzy_bundle(
    folded: &str,
    set_code: &str,
    floor: f32,
    lead: f32,
    k: u32,
    words_json: &str,
    limit: u32,
    fields_json: &str,
) -> Result<Vec<u8>, JsError> {
    let exact = exact_name_probe(folded, set_code, fields_json)?;
    // `exact_name_probe` writes `{"rank":null,` exactly when the needle ranks nowhere here.
    let ranked = !exact.starts_with(r#"{"rank":null,"#);
    let (fuzzy, contained, candidates) = if ranked {
        (None, None, Vec::new())
    } else {
        let candidates = fuzzy_candidates(folded, floor, k)?;
        if candidates.get(..4).is_some_and(|n| n != [0u8; 4]) {
            (Some(fuzzy_card_by_name(folded, floor, lead, fields_json)?), None, candidates)
        } else {
            let miss = serde_json::json!({ "status": "miss", "card": serde_json::Value::Null }).to_string();
            let contained = cards_containing_all_words(words_json, set_code, limit, fields_json)?;
            (Some(miss), Some(contained), candidates)
        }
    };
    let header = format!(
        r#"{{"exact":{exact},"fuzzy":{},"contained":{}}}"#,
        fuzzy.as_deref().unwrap_or("null"),
        contained.as_deref().unwrap_or("null"),
    );
    let header_len = u32::try_from(header.len()).map_err(|_| JsError::new("bundle header exceeds u32 length"))?;
    let mut buf = Vec::with_capacity(4 + header.len() + candidates.len());
    buf.extend_from_slice(&header_len.to_le_bytes());
    buf.extend_from_slice(header.as_bytes());
    buf.extend_from_slice(&candidates);
    Ok(buf)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod named_fuzzy_bundle_tests {
    use super::*;

    const FLOOR: f32 = 0.625;
    const LEAD: f32 = 0.002;
    const K: u32 = 8;
    const LIMIT: u32 = 2;
    const FIELDS: &str = r#"["name", "scryfall_id", "oracle_id", "set_code", "collector_number"]"#;

    /// A store where every stage has something to find: whole names, a name several others
    /// contain, near-misses a typo lands between, and two sets.
    fn load_names_store() {
        let mk = |i: usize, name: &str, set: &str| {
            serde_json::json!({
                "card_name": name,
                "card_name_folded": name.to_lowercase(),
                "oracle_id": format!("99999999-9999-4999-8999-{i:012}"),
                "scryfall_id": format!("aaaaaaaa-aaaa-4aaa-8aaa-{i:012}"),
                "card_set_code": set,
                "set_name": "Test Set",
                "collector_number": format!("{i}"),
                "oracle_text": "Do the thing.",
                "type_line": "Instant",
                "card_types": ["Instant"],
                "card_legalities": {"vintage": "legal"},
                "card_colors": {"R": true},
                "card_color_identity": {"R": true},
                "edhrec_rank": 100 + i,
                "prefer_score": 100.0,
            })
        };
        let names = [
            ("Lightning Bolt", "lea"),
            ("Lightning Helix", "rav"),
            ("Chain Lightning", "leg"),
            ("Counterspell", "lea"),
            ("Shock", "m19"),
            ("Shocker", "m19"),
            ("Bolt of Fire", "tst"),
        ];
        let mut builder = card_engine::StoreBuilder::new();
        for (i, (name, set)) in names.iter().enumerate() {
            builder.add_card(&mk(i + 1, name, set)).expect("add");
        }
        let mut bytes = Vec::new();
        builder.finish_to_writer(&mut bytes).expect("finish");
        init_store(&bytes).expect("load");
    }

    fn words_of(folded: &str) -> String {
        let words: Vec<&str> =
            folded.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '\'')).filter(|w| !w.is_empty()).collect();
        serde_json::to_string(&words).expect("words")
    }

    /// Which stages a bundle computed, read off the bundle itself.
    #[derive(Debug, PartialEq)]
    enum Ran {
        ExactOnly,
        ExactAndFuzzy,
        AllThree,
    }

    /// THE BUNDLE IS THE SEPARATE EXPORTS, byte for byte: its header's sections are exactly what
    /// `exact_name_probe`, `fuzzy_card_by_name` and `cards_containing_all_words` answer on their
    /// own, and its tail is exactly `fuzzy_candidates`' packet — for every stage the skip rules
    /// keep, and the skipped ones are exactly the ones the rules name.
    #[test]
    fn the_bundle_is_the_separate_exports_byte_for_byte() {
        load_names_store();
        let needles = [
            ("lightning bolt", ""),     // a whole name: exact only
            ("lightning bolt", "lea"),  // ... within its set
            ("lightning bolt", "m19"),  // a set it is not in: no rank, so the typo stage runs
            ("lihgtning bolt", ""),     // a typo
            ("counterspel", ""),        // a typo
            ("shock", "m19"),           // exact, beside a near name
            ("shokc", ""),              // a typo between two near names
            ("lightning", ""),          // no typo candidate: containment, two names
            ("helix", ""),              // containment, one name
            ("bolt", "tst"),            // containment within a set
            ("zzzz qqqq", ""),          // nothing anywhere
        ];
        let mut seen = Vec::new();
        for (folded, set) in needles {
            let words = words_of(folded);
            let bundle = named_fuzzy_bundle(folded, set, FLOOR, LEAD, K, &words, LIMIT, FIELDS).expect("bundle");
            let header_len = u32::from_le_bytes(bundle[..4].try_into().expect("u32")) as usize;
            let header = std::str::from_utf8(&bundle[4..4 + header_len]).expect("utf8 header");
            let tail = &bundle[4 + header_len..];

            let probe = exact_name_probe(folded, set, FIELDS).expect("probe");
            let candidates = fuzzy_candidates(folded, FLOOR, K).expect("candidates");
            let fuzzy = fuzzy_card_by_name(folded, FLOOR, LEAD, FIELDS).expect("fuzzy");
            let contained = cards_containing_all_words(&words, set, LIMIT, FIELDS).expect("contained");
            let rank_is_null = serde_json::from_str::<serde_json::Value>(&probe).expect("probe JSON")["rank"].is_null();
            let has_candidates = u32::from_le_bytes(candidates[..4].try_into().expect("u32")) > 0;

            let (ran, expected) = if !rank_is_null {
                (Ran::ExactOnly, (format!(r#"{{"exact":{probe},"fuzzy":null,"contained":null}}"#), Vec::new()))
            } else if has_candidates {
                (Ran::ExactAndFuzzy, (format!(r#"{{"exact":{probe},"fuzzy":{fuzzy},"contained":null}}"#), candidates))
            } else {
                // The skipped fuzzy_card_by_name would have answered exactly the miss written.
                (Ran::AllThree, (format!(r#"{{"exact":{probe},"fuzzy":{fuzzy},"contained":{contained}}}"#), candidates))
            };
            assert_eq!(header, expected.0, "{folded:?} set={set:?}: header sections");
            assert_eq!(tail, &expected.1[..], "{folded:?} set={set:?}: candidate bytes");
            if ran == Ran::AllThree {
                assert!(
                    serde_json::from_str::<serde_json::Value>(&fuzzy).expect("fuzzy JSON")["status"] == "miss",
                    "{folded:?}: no candidate must mean a local miss"
                );
            }
            seen.push(ran);
        }
        unload_store().expect("unload");
        // Every skip rule was exercised, so none of the three branches is untested.
        for branch in [Ran::ExactOnly, Ran::ExactAndFuzzy, Ran::AllThree] {
            assert!(seen.contains(&branch), "no needle took the {branch:?} branch: {seen:?}");
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    /// The next load refills the LAST store's allocation instead of asking for a new one — which
    /// the allocator cannot serve from the freed block, so linear memory would grow by a whole
    /// store on every publish swap. A request the spare cannot hold gets a fresh buffer.
    #[test]
    fn a_load_refills_the_spare_buffer() {
        let mut first = store_buffer(1_000).unwrap();
        let ptr = first.as_ptr();
        assert!(first.capacity() >= 1_000 + 1_000 / 32, "fresh buffers carry headroom");
        first.extend_from_slice(&[7u8; 1_000]);
        SPARE.with(|s| *s.borrow_mut() = Some(first));

        // The next generation, a little larger, still fits the headroom.
        let second = store_buffer(1_020).unwrap();
        assert_eq!(second.as_ptr(), ptr, "the spare was not reused");
        assert!(second.is_empty(), "a reused buffer must start empty");
        let cap = second.capacity();
        SPARE.with(|s| *s.borrow_mut() = Some(second));

        let bigger = store_buffer(cap + 1).unwrap();
        assert!(bigger.capacity() > cap);
        assert!(SPARE.with(|s| s.borrow().is_none()), "an outgrown spare is let go, not kept beside");
    }

    /// A borrow left behind by a trapped call (simulated here by leaking a guard, which is exactly
    /// what panic=abort does) makes every later slot access answer the POISONED error instead of
    /// panicking — a second trap — so the JS shim can drop the instance and start a fresh one.
    #[test]
    fn a_leaked_borrow_is_reported_as_poisoned_not_trapped() {
        // The guard's borrow is never released, like a trap mid-call. Test threads are per-test,
        // so the poisoned thread-local dies with this test.
        SPARE.with(|s| std::mem::forget(s.borrow_mut()));
        let err = store_buffer(16).expect_err("a held spare slot must not be reused");
        assert!(err.starts_with(POISONED_PREFIX), "{err}");
        let err = recycle(AlignedVec::new()).expect_err("nor written");
        assert!(err.starts_with(POISONED_PREFIX), "{err}");
    }

    /// A load that FAILS keeps its buffer as the spare: a corrupt gzip stream, a short raw load,
    /// an archive with a foreign header, and a load the caller abandoned without `finish` all
    /// leave the next load refilling the same allocation. Dropping it instead grew linear memory
    /// by a whole partition per attempt, which is what turned "this partition's chunks are gone"
    /// into an isolate reset loop.
    #[test]
    fn a_failed_load_recycles_its_buffer() {
        // Corrupt gzip: begin, feed garbage, finish fails, spare holds a buffer of the declared size.
        SPARE.with(|s| *s.borrow_mut() = None);
        begin_store_load_gzip(4_000).expect("begin gzip");
        let _ = store_load_gzip_chunk_inner(b"this is not a gzip stream at all");
        assert!(finish_store_load_gzip_inner().is_err());
        let spare_ptr = SPARE.with(|s| s.borrow().as_ref().map(|b| (b.as_ptr(), b.capacity())));
        let (ptr, cap) = spare_ptr.expect("the failed gzip load's buffer was dropped, not recycled");
        assert!(cap >= 4_000);
        assert!(GZ_BUF.with(|b| b.borrow().is_none()));
        assert!(GZ_LOADING.with(|g| g.borrow().is_none()));

        // Short raw load: the same buffer is refilled, then recycled again on the length error.
        begin_store_load(4_000).expect("begin raw");
        store_load_chunk_inner(&[1u8; 10]).expect("chunk");
        assert!(finish_store_load_inner().is_err());
        assert_eq!(SPARE.with(|s| s.borrow().as_ref().map(|b| b.as_ptr())), Some(ptr));

        // Foreign header: full length, wrong bytes — try_from_aligned hands the buffer back.
        begin_store_load(4_000).expect("begin raw");
        store_load_chunk_inner(&[0xAB; 4_000]).expect("chunk");
        assert!(finish_store_load_inner().is_err());
        assert_eq!(SPARE.with(|s| s.borrow().as_ref().map(|b| b.as_ptr())), Some(ptr));

        // Abandoned mid-stream (the JS side never called finish): the next begin takes it over.
        begin_store_load_gzip(4_000).expect("begin gzip");
        assert!(SPARE.with(|s| s.borrow().is_none()), "the load is holding the buffer");
        begin_store_load(4_000).expect("begin raw over an abandoned gzip load");
        let held = LOADING.with(|l| l.borrow().as_ref().map(|(b, _)| b.as_ptr()));
        assert_eq!(held, Some(ptr), "an abandoned load's buffer is what the next load refills");
        abandon_loads().expect("abandon");
        assert!(!store_loaded(), "no failed load ever became the active store");
    }

    /// The gzipped load path the Durable Object runs on every wake: a store published as
    /// CONCATENATED gzip members (one per stored KV chunk), handed over in pieces that split
    /// members and their headers at arbitrary points, must load into the same store the raw
    /// bytes do. Happy-path only, like the chunked test below (no JsError off-wasm).
    #[test]
    fn gzipped_members_load_like_the_raw_bytes() {
        use flate2::{Compression, write::GzEncoder};

        let row = serde_json::json!({
            "card_name": "Gzip Test",
            "card_name_folded": "gzip test",
            "oracle_id": "44444444-4444-4444-4444-444444444444",
            "scryfall_id": "dddddddd-0000-0000-0000-000000000001",
            "card_set_code": "tst",
            "set_name": "Test Set",
            "collector_number": "1",
            "oracle_text": "Inflate the thing.",
            "type_line": "Instant",
            "card_types": ["Instant"],
            "card_subtypes": [],
            "card_keywords": {},
            "card_colors": {"R": true},
            "card_color_identity": {"R": true},
            "cmc": 1,
            "card_legalities": {"commander": "legal"},
        });
        let mut builder = card_engine::StoreBuilder::new();
        builder.add_card(&row).expect("add_card");
        let mut raw = Vec::new();
        builder.finish_to_writer(&mut raw).expect("finish");

        // Two members, cut mid-archive, exactly as a two-chunk partition sits in KV.
        let cut = raw.len() / 3;
        let mut stored = Vec::new();
        for part in [&raw[..cut], &raw[cut..]] {
            let mut enc = GzEncoder::new(Vec::new(), Compression::default());
            enc.write_all(part).expect("gzip");
            stored.extend_from_slice(&enc.finish().expect("gzip finish"));
        }

        begin_store_load(raw.len() as u32).expect("begin");
        store_load_chunk(&raw).expect("chunk");
        finish_store_load().expect("finish_store_load");
        let tree = r#"{"node_type": "TrueNode"}"#;
        let from_raw = query(tree, "{}").expect("query raw");
        unload_store().expect("unload");

        begin_store_load_gzip(raw.len() as u32).expect("begin gzip");
        for piece in stored.chunks(5) {
            store_load_gzip_chunk(piece).expect("gzip chunk");
        }
        finish_store_load_gzip().expect("finish_store_load_gzip");
        assert!(store_loaded());
        let from_gzip = query(tree, "{}").expect("query gzip");
        unload_store().expect("unload");

        assert_eq!(from_gzip, from_raw);
        let v: serde_json::Value = serde_json::from_str(&from_gzip).expect("valid JSON out");
        assert_eq!(v["rows"][0]["name"], "Gzip Test");
    }

    /// Bytes shaped like an archive for the codec: compressible runs mixed with noise, several
    /// frames long and not a multiple of the frame size.
    fn codec_sample(len: usize) -> Vec<u8> {
        let mut state = 0x9E37_79B9u32;
        (0..len)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                if (i / 4096) % 3 == 0 { (state & 0xFF) as u8 } else { (i % 251) as u8 }
            })
            .collect()
    }

    fn lz4_stream(bytes: &[u8]) -> Vec<u8> {
        let mut stream = Vec::new();
        for index in 0.. {
            let frame = lz4_frame_of(bytes, index);
            if frame.is_empty() {
                break;
            }
            stream.extend_from_slice(&frame);
        }
        stream
    }

    fn lz4_decode(stream: &[u8], total: usize, piece: usize) -> Result<AlignedVec, String> {
        let mut load = Lz4Load { buf: AlignedVec::with_capacity(total), total, pending: Vec::new() };
        for part in stream.chunks(piece) {
            lz4_feed(&mut load, part)?;
        }
        if !load.pending.is_empty() {
            return Err(format!("{} bytes of a frame left over", load.pending.len()));
        }
        Ok(load.buf)
    }

    /// The LZ4 cache stream round-trips through every way a crossing can cut it: a piece smaller
    /// than a frame header, one that splits headers and blocks at odd offsets, and the whole
    /// stream at once. Frames are LZ4_BLOCK_BYTES of raw each except the last.
    #[test]
    fn lz4_frames_round_trip_across_any_crossing() {
        let raw = codec_sample(2 * LZ4_BLOCK_BYTES + 12_345);
        let stream = lz4_stream(&raw);
        assert!(stream.len() < raw.len(), "the sample must actually compress");
        assert_eq!(frame_header(&stream).0, LZ4_BLOCK_BYTES, "full frames carry a whole block");
        for piece in [5, 7_919, 1 << 20, stream.len()] {
            let out = lz4_decode(&stream, raw.len(), piece).expect("decode");
            assert_eq!(&out[..], &raw[..], "piece size {piece}");
        }
        assert!(lz4_frame_of(&raw, 3).is_empty(), "past the last frame is empty, not an error");
    }

    /// The readable-and-wrong guard: a flipped byte inside a block, a truncated stream, a header
    /// claiming more than a frame can hold, and a stream longer than the declared total are all
    /// refused — never decoded into a store that then fails in a query.
    #[test]
    fn lz4_refuses_a_corrupt_or_short_stream() {
        let raw = codec_sample(LZ4_BLOCK_BYTES + 777);
        let stream = lz4_stream(&raw);

        let mut flipped = stream.clone();
        flipped[LZ4_FRAME_HEADER + 40] ^= 0x01;
        let err = lz4_decode(&flipped, raw.len(), 4096).expect_err("checksum");
        assert!(err.contains("checksum"), "{err}");

        let err = lz4_decode(&stream[..stream.len() - 3], raw.len(), 4096).expect_err("truncated");
        assert!(err.contains("left over"), "{err}");

        let mut huge = stream.clone();
        huge[0..4].copy_from_slice(&((LZ4_BLOCK_BYTES as u32) + 1).to_le_bytes());
        assert!(lz4_decode(&huge, raw.len(), 4096).expect_err("oversized frame").contains("raw bytes"));

        let err = lz4_decode(&stream, raw.len() - 1, 4096).expect_err("past the total");
        assert!(err.contains("declared total"), "{err}");
    }

    /// The exported trio, end to end over a real store: encode the ACTIVE store frame by frame,
    /// unload, load the frames back in odd pieces, and answer the same query. A corrupt stream
    /// fails at the chunk, keeps its buffer as the spare, and never becomes the store.
    #[test]
    fn lz4_cache_loads_the_store_it_encoded() {
        load_wire_store();
        let tree = r#"{"node_type": "TrueNode"}"#;
        let before = query(tree, "{}").expect("query");
        let mut stream = Vec::new();
        for index in 0.. {
            let frame = store_lz4_frame(index).expect("frame");
            if frame.is_empty() {
                break;
            }
            stream.extend_from_slice(&frame);
        }
        let total = STORE.with(|s| s.borrow().as_ref().map(|st| st.bytes().len())).expect("store");
        unload_store().expect("unload");

        begin_store_load_lz4(total as u32).expect("begin lz4");
        for piece in stream.chunks(3) {
            store_load_lz4_chunk(piece).expect("lz4 chunk");
        }
        finish_store_load_lz4().expect("finish lz4");
        assert_eq!(query(tree, "{}").expect("query"), before);
        unload_store().expect("unload");

        let mut corrupt = stream.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 0xFF;
        begin_store_load_lz4(total as u32).expect("begin lz4");
        assert!(store_load_lz4_chunk_inner(&corrupt).is_err());
        assert!(LZ4_LOADING.with(|l| l.borrow().is_none()), "a failed chunk abandons the load");
        assert!(SPARE.with(|s| s.borrow().is_some()), "and keeps its buffer as the spare");
        assert!(!store_loaded());
    }

    /// The chunked load path, driven natively: StoreBuilder bytes streamed in
    /// 7-byte chunks through begin/chunk/finish, then queried. Happy-path only
    /// (constructing a JsError outside wasm is not supported), which is exactly
    /// the path the Worker runs.
    #[test]
    fn chunked_load_then_query() {
        let row = serde_json::json!({
            "card_name": "Chunk Test",
            "card_name_folded": "chunk test",
            "oracle_id": "33333333-3333-3333-3333-333333333333",
            "scryfall_id": "cccccccc-0000-0000-0000-000000000001",
            "card_set_code": "tst",
            "set_name": "Test Set",
            "collector_number": "1",
            "oracle_text": "Do the thing.",
            "type_line": "Sorcery",
            "card_types": ["Sorcery"],
            "card_subtypes": [],
            "card_keywords": {},
            "card_colors": {"U": true},
            "card_color_identity": {"U": true},
            "cmc": 2,
            "card_legalities": {"commander": "legal"},
        });
        let mut builder = card_engine::StoreBuilder::new();
        builder.add_card(&row).expect("add_card");
        let mut bytes = Vec::new();
        builder.finish_to_writer(&mut bytes).expect("finish");

        begin_store_load(bytes.len() as u32).expect("begin");
        for chunk in bytes.chunks(7) {
            store_load_chunk(chunk).expect("chunk");
        }
        finish_store_load().expect("finish_store_load");
        assert!(store_loaded());
        assert_eq!(size(), 1);
        assert_eq!(card_count(), 1);

        let out = query(r#"{"node_type": "TrueNode"}"#, "{}").expect("query");
        let v: serde_json::Value = serde_json::from_str(&out).expect("valid JSON out");
        assert_eq!(v["total"], 1);
        assert_eq!(v["rows"][0]["name"], "Chunk Test");

        let cat = catalog().expect("catalog");
        let v: serde_json::Value = serde_json::from_str(&cat).expect("valid catalog JSON");
        assert_eq!(v["card_types"]["Sorcery"], 1);

        let sampled = random_search(3, 7, "null", "null").expect("random_search");
        let v: serde_json::Value = serde_json::from_str(&sampled).expect("valid sample JSON");
        assert_eq!(v.as_array().unwrap().len(), 1);

        // The FILTER argument over the same one-card store, both ways round: a tree the card
        // fails empties the draw, and one it passes leaves it whole. `/random_search` sends
        // `-is:extra -is:variation`, so an export that ignored the argument would look identical
        // to a correct one on the unfiltered call above.
        let excludes_sorcery = r#"{"node_type": "NotNode", "kwargs": {"operand": {"node_type": "CardBinaryOperatorNode",
            "kwargs": {"op": ":", "lhs": {"node_type": "CardAttributeNode",
            "kwargs": {"attribute_name": "card_types", "original_attribute": "t"}}, "rhs": ["sorcery"]}}}}"#;
        let filtered = random_search(3, 7, excludes_sorcery, "null").expect("filtered random_search");
        let v: serde_json::Value = serde_json::from_str(&filtered).expect("valid filtered sample JSON");
        assert!(v.as_array().unwrap().is_empty(), "the only card is a Sorcery, and the filter excludes it");

        let keeps_sorcery = r#"{"node_type": "CardBinaryOperatorNode", "kwargs": {"op": ":",
            "lhs": {"node_type": "CardAttributeNode",
            "kwargs": {"attribute_name": "card_types", "original_attribute": "t"}}, "rhs": ["sorcery"]}}"#;
        let kept = random_search(3, 7, keeps_sorcery, "null").expect("filtered random_search");
        let v: serde_json::Value = serde_json::from_str(&kept).expect("valid filtered sample JSON");
        assert_eq!(v.as_array().unwrap().len(), 1, "the card matches, so the draw still finds it");

        // The /cards/* addressing surface, over the same loaded store. A hit and a miss each,
        // because a miss here IS the 404 — there is no SQL behind it to disagree. One archive
        // serves both surfaces, exactly as upstream's one store does.
        let id = "cccccccc-0000-0000-0000-000000000001";
        let v: serde_json::Value =
            serde_json::from_str(&card_by_scryfall_id(id, "null").expect("by id")).expect("valid JSON");
        assert_eq!(v["name"], "Chunk Test");
        let v: serde_json::Value =
            serde_json::from_str(&card_by_scryfall_id("cccccccc-0000-0000-0000-00000000ffff", "null").expect("miss"))
                .expect("valid JSON");
        assert!(v.is_null());

        let v: serde_json::Value =
            serde_json::from_str(&cards_by_scryfall_ids(&format!("[{id:?}]"), "null").expect("batch")).expect("valid JSON");
        assert_eq!(v.as_array().unwrap().len(), 1);

        let v: serde_json::Value = serde_json::from_str(
            &printings_of_oracle_id("33333333-3333-3333-3333-333333333333", "null").expect("prints"),
        )
        .expect("valid JSON");
        assert_eq!(v.as_array().unwrap().len(), 1);

        let v: serde_json::Value =
            serde_json::from_str(&fuzzy_card_by_name("chunk test", 0.4, 0.05, "null").expect("fuzzy")).expect("valid JSON");
        assert_eq!(v["status"], "hit");
        assert_eq!(v["card"]["name"], "Chunk Test");

        let v: serde_json::Value =
            serde_json::from_str(&autocomplete("chun", 20).expect("autocomplete")).expect("valid JSON");
        assert_eq!(v, serde_json::json!(["Chunk Test"]), "the PRINTED name, not the folded key");

        unload_store().expect("unload");
        assert!(!store_loaded());
        assert_eq!(size(), 0);
    }

    /// The deterministic two-row store the wire tests below share: loaded into the thread-local
    /// slot, so every test that calls this must `unload_store()` before it returns.
    fn load_wire_store() {
        let mk = |name: &str, oracle: &str, scry: &str, edhrec: u32| {
            serde_json::json!({
                "card_name": name,
                "card_name_folded": name.to_lowercase(),
                "oracle_id": oracle,
                "scryfall_id": scry,
                "card_set_code": "tst",
                "set_name": "Test Set",
                "collector_number": "1",
                "oracle_text": "Do the thing.",
                "type_line": "Instant",
                "card_types": ["Instant"],
                "card_legalities": {"vintage": "legal"},
                "card_colors": {"R": true},
                "card_color_identity": {"R": true},
                "edhrec_rank": edhrec,
                "prefer_score": 100.0,
            })
        };
        let mut builder = card_engine::StoreBuilder::new();
        builder.add_card(&mk("Wire Alpha", "77777777-7777-4777-8777-777777777771", "88888888-8888-4888-8888-888888888881", 10)).expect("add");
        builder.add_card(&mk("Wire Beta", "77777777-7777-4777-8777-777777777772", "88888888-8888-4888-8888-888888888882", 20)).expect("add");
        let mut bytes = Vec::new();
        builder.finish_to_writer(&mut bytes).expect("finish");
        init_store(&bytes).expect("load");
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().expect("u32"))
    }

    /// A test-side decoder for the phase-1 packet: the key entries' vpids in page order, and the
    /// framed inline rows. Mirrors gather.ts's `decodeKeyPacket` closely enough to read what the
    /// packer wrote — the committed fixture is what pins the two for real.
    fn split_key_packet(packed: &[u8]) -> (Vec<u32>, Vec<Vec<u8>>) {
        assert_eq!(u32_at(packed, 0), KEY_PACKET_VERSION);
        let n = u32_at(packed, 8) as usize;
        let inline = u32_at(packed, 12) as usize;
        // flags at 16: a TrueNode query over an English-only store never widens.
        assert_eq!(u32_at(packed, 16), 0);
        let mut at = 20;
        let mut vpids = Vec::with_capacity(n);
        for _ in 0..n {
            let keylen = u16::from_le_bytes(packed[at..at + 2].try_into().expect("u16")) as usize;
            at += 2 + keylen;
            vpids.push(u32_at(packed, at));
            at += 4;
        }
        let rows = split_frames(&packed[at..], inline);
        (vpids, rows)
    }

    /// `count` framed rows (`len: u32 LE, bytes`) read back to back from `bytes`, which must end
    /// exactly where the last frame does.
    fn split_frames(bytes: &[u8], count: usize) -> Vec<Vec<u8>> {
        let mut at = 0;
        let mut rows = Vec::with_capacity(count);
        for _ in 0..count {
            let len = u32_at(bytes, at) as usize;
            rows.push(bytes[at + 4..at + 4 + len].to_vec());
            at += 4 + len;
        }
        assert_eq!(at, bytes.len(), "trailing bytes after the last frame");
        rows
    }

    /// The row packet phase 2 returns: `n`, then `n` frames.
    fn split_row_packet(packed: &[u8]) -> Vec<Vec<u8>> {
        split_frames(&packed[4..], u32_at(packed, 0) as usize)
    }

    /// The wire contract between THIS crate's `query_keys` packer and src/engine/gather.ts's
    /// `decodeKeyPacket`, pinned as committed bytes: a deterministic two-row store's real packet
    /// must equal tests/engine/gather-wire-fixture.json byte for byte, and the bun twin
    /// (tests/engine/gather-wire.test.ts) decodes the SAME file with the TS codec. The same file
    /// pins `fetch_rows`'s row packet (`rows_packed_hex`) against `decodeRowPacket`. Regenerate
    /// deliberately with SYLVAN_WRITE_WIRE_FIXTURE=1 when either layout moves.
    #[test]
    fn query_keys_packet_matches_the_committed_wire_fixture() {
        load_wire_store();

        // ONE inline row of the two, so the fixture pins BOTH sections and the boundary between
        // them — a keys-only packet would leave the inline framing unpinned, which is precisely
        // the half a decoder mistake would land in.
        let packed = query_keys(
            r#"{"node_type": "TrueNode"}"#,
            r#"{"orderby": "name", "limit": 10, "fields": ["name"]}"#,
            1,
            "rows",
            "",
        )
        .expect("query_keys");
        // And phase 2 for BOTH entries, so the row packet's count header and the frame after a
        // frame are pinned too.
        let (vpids, _) = split_key_packet(&packed);
        let rows_packed = fetch_rows(&vpids, r#"["name"]"#, "rows", "").expect("fetch_rows");
        unload_store().expect("unload");

        // Base16, dependency-free both sides.
        let hex: String = packed.iter().map(|b| format!("{b:02x}")).collect();
        let rows_hex: String = rows_packed.iter().map(|b| format!("{b:02x}")).collect();
        let fixture_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/engine/gather-wire-fixture.json");
        let fixture = serde_json::json!({
            "note": "REAL query_keys bytes off a deterministic 2-row store (orderby=name, \
                     fields=[name], inline_rows=1, shape=rows). Pins the LE packet layout — version \
                     header with its flags word, key entries AND the framed inline-row section — between the Rust packer \
                     (engine/wasm) and src/engine/gather.ts's decodeKeyPacket. rows_packed_hex is \
                     fetch_rows for both entries (shape=rows), pinning the row packet against \
                     decodeRowPacket. Regenerate with SYLVAN_WRITE_WIRE_FIXTURE=1 cargo test -p \
                     sylvan-engine-wasm.",
            "packet_version": KEY_PACKET_VERSION,
            "sort_key_version": card_engine::SORT_KEY_VERSION,
            "total": 2,
            "entries": 2,
            "inline_rows": 1,
            "widened": false,
            "packed_hex": hex,
            "rows_packed_hex": rows_hex,
        });
        if std::env::var("SYLVAN_WRITE_WIRE_FIXTURE").is_ok() {
            // Tab-indented, matching the repo's biome formatting, so a regenerated fixture is
            // commit-clean without a manual format pass.
            let two_space = serde_json::to_string_pretty(&fixture).expect("encode fixture");
            let tabbed: String = two_space
                .lines()
                .map(|line| {
                    let spaces = line.len() - line.trim_start_matches(' ').len();
                    format!("{}{}\n", "\t".repeat(spaces / 2), &line[spaces..])
                })
                .collect();
            std::fs::write(fixture_path, tabbed).expect("write fixture");
        }
        let committed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(fixture_path).expect(
                "committed wire fixture missing — run once with SYLVAN_WRITE_WIRE_FIXTURE=1",
            ))
            .expect("fixture parses");
        assert_eq!(
            committed["packed_hex"].as_str().expect("hex"),
            hex,
            "the packed query_keys bytes moved — if deliberate (layout/version change), \
             regenerate the fixture AND update gather.ts's codec + its bun test together"
        );
        assert_eq!(
            committed["rows_packed_hex"].as_str().expect("rows hex"),
            rows_hex,
            "the fetch_rows row packet moved — if deliberate, regenerate the fixture AND update \
             gather.ts's decodeRowPacket + its bun test together"
        );
        assert_eq!(committed["sort_key_version"], serde_json::json!(card_engine::SORT_KEY_VERSION));
        assert_eq!(committed["packet_version"], serde_json::json!(KEY_PACKET_VERSION));
    }

    /// The claim the partitioned `/cards/search` rests on: a page spliced from card-shaped
    /// frames — inline ones from phase 1, fetched ones from phase 2 — is BYTE-IDENTICAL to the
    /// page `scryfall_search` writes whole, and inline frame i equals fetched frame i. The TS
    /// gather never parses a card because this holds; card-object-parity pins the writer itself
    /// against the TS reference, so this test only has to pin the framing around it.
    #[test]
    fn gather_frames_reassemble_to_the_single_store_page() {
        load_wire_store();
        let tree = r#"{"node_type": "TrueNode"}"#;
        let opts = r#"{"orderby": "name", "limit": 10, "fields": ["name", "scryfall_id", "oracle_id", "set_code", "collector_number", "oracle_text", "type_line", "legalities", "colors", "color_identity"]}"#;
        let base = "https://sylvan.example/api";

        let whole = scryfall_search(tree, opts, base).expect("scryfall_search");
        let newline = whole.iter().position(|&b| b == b'\n').expect("header line");
        let page = &whole[newline + 1..];

        let packed = query_keys(tree, opts, 2, "cards", base).expect("query_keys");
        let (vpids, inline) = split_key_packet(&packed);
        assert_eq!(inline.len(), 2, "both rows inline");
        let fetched = split_row_packet(
            &fetch_rows(&vpids, r#"["name", "scryfall_id", "oracle_id", "set_code", "collector_number", "oracle_text", "type_line", "legalities", "colors", "color_identity"]"#, "cards", base)
                .expect("fetch_rows"),
        );
        unload_store().expect("unload");

        assert_eq!(inline, fetched, "inline and fetched card frames diverged");
        let mut spliced = Vec::new();
        spliced.push(b'[');
        for (i, frame) in inline.iter().enumerate() {
            if i > 0 {
                spliced.push(b',');
            }
            spliced.extend_from_slice(frame);
        }
        spliced.push(b']');
        assert_eq!(
            std::str::from_utf8(&spliced).expect("utf8"),
            std::str::from_utf8(page).expect("utf8"),
            "a page spliced from card frames must equal the whole-page writer's bytes"
        );
        // The frames are card objects, not rows: the writer's envelope and the base URL are the tell.
        let first = std::str::from_utf8(&inline[0]).expect("utf8");
        assert!(first.starts_with("{\"object\":\"card\""), "{first}");
        assert!(first.contains(base), "{first}");

        // The shape is validated before any work (natively, without building a JsError).
        assert!(parse_shape("objects").is_err());
        assert!(matches!(parse_shape("cards"), Ok(RowShape::Cards)));
    }
}
