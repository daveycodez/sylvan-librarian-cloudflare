//! A gzip/DEFLATE inflater whose ENTIRE decode state is a plain, versioned,
//! serializable struct.
//!
//! ## Why this exists
//!
//! The import recode phase re-compresses a staged multi-GB gzip stream into
//! independent members across many Durable Object alarms, each capped at 30s
//! of CPU. gzip cannot be entered mid-stream, so before this crate a resuming
//! alarm re-decompressed the whole prefix and threw it away — a cost that
//! grows with the dump until no budget shape fits under the cap (measured
//! 8.2s/GiB of prefix; the discard ALONE would exceed 30s past ~3.6GiB raw).
//! Persisting the decompressor's state between alarms makes the prefix cost
//! zero at any size: the next alarm restores ~33KB and continues from the
//! exact bit it stopped at.
//!
//! No existing implementation exposes that state: Web `DecompressionStream`
//! is opaque, zlib's `inflateGetDictionary`/`inflatePrime` cannot reproduce a
//! mid-block position, and miniz_oxide's `DecompressorOxide` is a private
//! layout that may change under any dependency update. So the decoder is
//! written here, ~stb/puff-sized, with the serialized layout OWNED and
//! VERSIONED by this repo (`STATE_VERSION`): a deploy that changes the layout
//! bumps the version, and a stale checkpoint is refused rather than
//! misinterpreted.
//!
//! ## Shape
//!
//! [`Inflater`] is an explicit state machine (the classic zlib/puff structure)
//! whose every register lives in the struct — no recursion, no borrowed
//! iterators — so it can stop ANYWHERE: mid gzip header, mid Huffman code
//! (partial bits held in `bitbuf`), mid match copy, mid trailer. [`feed`]
//! pushes compressed bytes in and appends raw bytes to an output Vec, pausing
//! when input runs out OR when `max_out` raw bytes have been produced — the
//! latter is what lets a caller stop the stream at an exact raw offset (a
//! recode member boundary) and serialize a state that corresponds to
//! precisely that offset. [`save`]/[`restore`] round-trip the state through
//! bytes; the Huffman decode tables are NOT serialized — they are rebuilt
//! from the (serialized) code lengths on restore, keeping the blob small and
//! the layout free of derived structures.
//!
//! Output is deterministic: inflate is a decoding, so ANY correct inflater
//! produces byte-identical raw output for the same compressed input. The
//! differential tests (vs flate2, an independent implementation) pin this
//! one's correctness across adversarial stop points; byte-identity with the
//! platform's `DecompressionStream` is additionally pinned by the wasm-level
//! tests in tests/import/ (TypeScript, against the committed blob).
//!
//! Multi-member (concatenated) gzip is decoded transparently, and each
//! member's CRC32 + ISIZE trailer is verified — a checkpoointed resume must
//! not be a way to smuggle corruption past the checks the one-pass path had.

#![forbid(unsafe_code)]

/// Version stamp embedded in every serialized state blob. ANY change to the
/// serialized layout — field added, removed, reordered, widened — MUST bump
/// this, so a checkpoint written by older code is refused by `restore`
/// (`RestoreError::Version`) and the caller falls back to its from-byte-0
/// path instead of continuing from a misread window.
pub const STATE_VERSION: u32 = 1;

/// "SLIF" (SyLvan InFlate), little-endian, at the head of every state blob.
const STATE_MAGIC: u32 = 0x464C_4953;

/// Exact byte length of a version-1 state blob; `restore` rejects any other.
pub const STATE_BYTES: usize = 33_193;

const WINDOW_SIZE: usize = 1 << 15;
const WINDOW_MASK: u32 = (WINDOW_SIZE - 1) as u32;
/// Primary-table bits for Huffman decode: codes this short (the overwhelming
/// majority) resolve in one lookup; longer ones take the canonical bit-walk.
const FAST_BITS: u32 = 9;
const MAX_BITS: u32 = 15;

// ─── errors ──────────────────────────────────────────────────────────────────

/// The compressed stream is invalid. Not retryable: the same bytes will fail
/// the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InflateError(pub &'static str);

impl std::fmt::Display for InflateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "corrupt deflate stream: {}", self.0)
    }
}
impl std::error::Error for InflateError {}

/// A state blob was refused. The caller's contract: fall back to decoding
/// from byte 0 — never guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreError {
    /// Wrong length or magic — not a state blob at all.
    Shape,
    /// A real state blob from a different layout version.
    Version(u32),
    /// Structurally impossible field values (or tables that cannot build).
    Invalid(&'static str),
}

impl std::fmt::Display for RestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RestoreError::Shape => write!(f, "not an inflate state blob"),
            RestoreError::Version(v) => write!(f, "inflate state version {v}, this code is {STATE_VERSION}"),
            RestoreError::Invalid(what) => write!(f, "invalid inflate state: {what}"),
        }
    }
}
impl std::error::Error for RestoreError {}

// ─── static tables ───────────────────────────────────────────────────────────

/// Length symbol 257+i → (extra bits, base length). RFC 1951 §3.2.5.
const LEN_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];

/// Distance symbol → (extra bits, base distance). RFC 1951 §3.2.5.
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
    8193, 12289, 16385, 24577,
];

/// The order code-length code lengths arrive in. RFC 1951 §3.2.7.
const CLEN_ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}
static CRC_TABLE: [u32; 256] = crc_table();

fn crc32_fold(mut crc: u32, bytes: &[u8]) -> u32 {
    for &b in bytes {
        crc = (crc >> 8) ^ CRC_TABLE[((crc ^ b as u32) & 0xFF) as usize];
    }
    crc
}

// ─── Huffman tables (rebuilt from code lengths; never serialized) ────────────

#[derive(Default, Clone)]
struct Huffman {
    /// Symbols per code length, 1..=15 (puff's `count`), for the bit-walk.
    counts: [u16; (MAX_BITS + 1) as usize],
    /// Symbols in canonical order (by length, then symbol), for the bit-walk.
    symbols: Vec<u16>,
    /// Primary table: next FAST_BITS input bits (LSB-first, zero-padded past
    /// what is available) → (code length << 9) | symbol; 0 = no code of
    /// length ≤ FAST_BITS matches, take the bit-walk.
    fast: Vec<u16>,
    /// Codes exist for every possible bit pattern. An incomplete table is
    /// accepted at build (matching zlib's tolerance of the one-distance-code
    /// streams some encoders emit) and only errors if a gap is actually read.
    complete: bool,
}

impl Huffman {
    fn build(lens: &[u8]) -> Result<Huffman, InflateError> {
        let mut counts = [0u16; (MAX_BITS + 1) as usize];
        for &l in lens {
            counts[l as usize] += 1;
        }
        counts[0] = 0;
        let mut left: i32 = 1;
        for &count in &counts[1..=MAX_BITS as usize] {
            left <<= 1;
            left -= count as i32;
            if left < 0 {
                return Err(InflateError("over-subscribed huffman code"));
            }
        }
        let complete = left == 0;
        let mut offs = [0usize; (MAX_BITS + 1) as usize];
        for len in 1..MAX_BITS as usize {
            offs[len + 1] = offs[len] + counts[len] as usize;
        }
        let mut symbols = vec![0u16; offs[MAX_BITS as usize] + counts[MAX_BITS as usize] as usize];
        let mut next = offs;
        for (sym, &l) in lens.iter().enumerate() {
            if l != 0 {
                symbols[next[l as usize]] = sym as u16;
                next[l as usize] += 1;
            }
        }
        // Canonical code assignment (RFC 1951 §3.2.2), and the primary table:
        // every FAST_BITS-wide pattern a short code prefixes maps straight to
        // that (symbol, length).
        let mut fast = vec![0u16; 1 << FAST_BITS];
        let mut code: u32 = 0;
        let mut idx = 0usize;
        for len in 1..=MAX_BITS {
            let n = counts[len as usize] as u32;
            if len <= FAST_BITS {
                for k in 0..n {
                    let rev = ((code + k).reverse_bits() >> (32 - len)) as usize;
                    let entry = ((len as u16) << 9) | symbols[idx + k as usize];
                    let step = 1usize << len;
                    let mut i = rev;
                    while i < (1 << FAST_BITS) {
                        fast[i] = entry;
                        i += step;
                    }
                }
            }
            idx += n as usize;
            code = (code + n) << 1;
        }
        Ok(Huffman { counts, symbols, fast, complete })
    }

    fn fixed_lit() -> Huffman {
        let mut lens = [0u8; 288];
        lens[..144].fill(8);
        lens[144..256].fill(9);
        lens[256..280].fill(7);
        lens[280..].fill(8);
        Huffman::build(&lens).expect("fixed literal table is well-formed")
    }

    fn fixed_dist() -> Huffman {
        // 32 five-bit codes; 30 and 31 decode but are invalid distances,
        // caught at use (matching zlib).
        Huffman::build(&[5u8; 32]).expect("fixed distance table is well-formed")
    }
}

// ─── the state machine ───────────────────────────────────────────────────────

/// Every stoppable position in the decode. Discriminants are the serialized
/// values — append-only within a version; renumbering is a version bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Mode {
    /// The fixed 10-byte gzip header, `hdr_have` bytes in.
    GzHeader = 0,
    /// FEXTRA's 2-byte little-endian length, `hdr_have` bytes in.
    GzExtraLen = 1,
    /// Skipping `skip_rem` FEXTRA payload bytes.
    GzExtra = 2,
    /// Skipping the NUL-terminated FNAME.
    GzName = 3,
    /// Skipping the NUL-terminated FCOMMENT.
    GzComment = 4,
    /// Skipping the 2-byte FHCRC, `hdr_have` bytes in.
    GzHcrc = 5,
    /// The 3-bit block header (BFINAL + BTYPE).
    BlockHead = 6,
    /// Stored block: byte-align, then LEN/NLEN (4 bytes via `hdr_have`/`hdr_buf`).
    StoredLen = 7,
    /// Stored block: `length` raw bytes remain to copy.
    Stored = 8,
    /// Dynamic block: the 14-bit HLIT/HDIST/HCLEN triple.
    TableHead = 9,
    /// Dynamic block: `ncode` 3-bit code-length code lengths, `have` read.
    TableClen = 10,
    /// Dynamic block: `nlen + ndist` code lengths via the clen code, `have` read.
    TableLens = 11,
    /// Compressed data: at a literal/length symbol boundary.
    BlockSym = 12,
    /// Compressed data: length decoded into `length`, distance symbol next.
    DistSym = 13,
    /// Copying a match: `length` bytes remain, from `dist` back.
    MatchCopy = 14,
    /// The 8-byte CRC32+ISIZE trailer, `hdr_have` bytes in (byte-aligns first).
    Trailer = 15,
    /// A member decoded and verified clean. Terminal if no more input comes;
    /// another byte starts the next concatenated member.
    MemberEnd = 16,
}

impl Mode {
    fn from_u8(v: u8) -> Option<Mode> {
        use Mode::*;
        Some(match v {
            0 => GzHeader,
            1 => GzExtraLen,
            2 => GzExtra,
            3 => GzName,
            4 => GzComment,
            5 => GzHcrc,
            6 => BlockHead,
            7 => StoredLen,
            8 => Stored,
            9 => TableHead,
            10 => TableClen,
            11 => TableLens,
            12 => BlockSym,
            13 => DistSym,
            14 => MatchCopy,
            15 => Trailer,
            16 => MemberEnd,
            _ => return None,
        })
    }
}

/// What stopped a [`Inflater::feed`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedStop {
    /// Input exhausted. If [`Inflater::at_member_boundary`] is also true this
    /// is a clean end-of-stream point; otherwise more input is required.
    NeedInput,
    /// `max_out` raw bytes were produced; input may remain unconsumed —
    /// resume by feeding `input[consumed..]`.
    OutputFull,
}

pub struct Inflater {
    mode: Mode,
    /// Unconsumed input bits, next bit at bit 0. Invariant: bits at positions
    /// ≥ `bitcnt` are zero (the zero-padded Huffman peek depends on it).
    bitbuf: u64,
    bitcnt: u32,
    /// Compressed bytes consumed — including those held in `bitbuf`, which
    /// travel inside the state. A caller resuming after `restore` feeds the
    /// compressed stream starting exactly here.
    total_in: u64,
    /// Raw bytes produced across all members.
    total_out: u64,
    /// Raw bytes produced in the current member (ISIZE is this mod 2^32).
    member_out: u64,
    /// Running CRC32 of the current member's output (pre final xor).
    crc: u32,
    gz_flags: u8,
    /// Byte progress inside the fixed-size header pieces (header, extra-len,
    /// hcrc, trailer).
    hdr_have: u8,
    /// Trailer / extra-len bytes accumulate here.
    hdr_buf: [u8; 8],
    /// FEXTRA payload bytes still to skip.
    skip_rem: u32,
    last_block: bool,
    /// Current block type (0 stored, 1 fixed, 2 dynamic) — picks which
    /// tables `restore` rebuilds.
    btype: u8,
    // Dynamic-header registers (RFC 1951 §3.2.7 names).
    nlen: u16,
    ndist: u16,
    ncode: u16,
    have: u16,
    /// Code lengths: literal/length codes in [0, nlen), distances in
    /// [nlen, nlen + ndist).
    lens: [u8; 320],
    clen_lens: [u8; 19],
    /// Stored-block bytes remaining, or match length remaining.
    length: u32,
    /// Match distance.
    dist: u32,
    /// The 32KiB sliding window as a ring; `wpos` is the next write slot.
    window: Box<[u8; WINDOW_SIZE]>,
    wpos: u32,
    // Decode tables — derived, rebuilt by `restore`, never serialized.
    lit: Huffman,
    dst: Huffman,
    clen: Huffman,
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Default for Inflater {
    fn default() -> Self {
        Inflater::new()
    }
}

impl Inflater {
    pub fn new() -> Inflater {
        Inflater {
            mode: Mode::GzHeader,
            bitbuf: 0,
            bitcnt: 0,
            total_in: 0,
            total_out: 0,
            member_out: 0,
            crc: 0xFFFF_FFFF,
            gz_flags: 0,
            hdr_have: 0,
            hdr_buf: [0; 8],
            skip_rem: 0,
            last_block: false,
            btype: 0,
            nlen: 0,
            ndist: 0,
            ncode: 0,
            have: 0,
            lens: [0; 320],
            clen_lens: [0; 19],
            length: 0,
            dist: 0,
            window: Box::new([0; WINDOW_SIZE]),
            wpos: 0,
            lit: Huffman::default(),
            dst: Huffman::default(),
            clen: Huffman::default(),
        }
    }

    /// Compressed bytes consumed so far (the resume offset for a restored
    /// state: feed the compressed stream from exactly here).
    pub fn total_in(&self) -> u64 {
        self.total_in
    }

    /// Raw bytes produced so far, across members.
    pub fn total_out(&self) -> u64 {
        self.total_out
    }

    /// True exactly when the stream sits at a verified end of a gzip member —
    /// the ONLY position where running out of input is not truncation.
    pub fn at_member_boundary(&self) -> bool {
        self.mode == Mode::MemberEnd
    }

    #[inline]
    fn refill(&mut self, cur: &mut Cursor) {
        if cur.data.len() - cur.pos >= 8 {
            if self.bitcnt < 56 {
                // One 8-byte load per top-up instead of a byte loop. Only the
                // bytes that fit whole are kept (mask before OR), preserving
                // the bits-above-bitcnt-are-zero invariant peek_sym leans on.
                let take = ((63 - self.bitcnt) >> 3) as usize; // 1..=7
                let v = u64::from_le_bytes(cur.data[cur.pos..cur.pos + 8].try_into().expect("sized read"))
                    & ((1u64 << (take * 8)) - 1);
                self.bitbuf |= v << self.bitcnt;
                cur.pos += take;
                self.bitcnt += (take * 8) as u32;
                self.total_in += take as u64;
            }
            return;
        }
        while self.bitcnt <= 56 && cur.pos < cur.data.len() {
            self.bitbuf |= (cur.data[cur.pos] as u64) << self.bitcnt;
            cur.pos += 1;
            self.bitcnt += 8;
            self.total_in += 1;
        }
    }

    #[inline]
    fn consume(&mut self, n: u32) {
        debug_assert!(n <= self.bitcnt);
        self.bitbuf >>= n;
        self.bitcnt -= n;
    }

    #[inline]
    fn peek(&self, n: u32) -> u32 {
        (self.bitbuf & ((1u64 << n) - 1)) as u32
    }

    /// One byte off the (byte-aligned) bit buffer, refilling from the cursor.
    #[inline]
    fn take_byte(&mut self, cur: &mut Cursor) -> Option<u8> {
        debug_assert_eq!(self.bitcnt % 8, 0);
        if self.bitcnt < 8 {
            self.refill(cur);
            if self.bitcnt < 8 {
                return None;
            }
        }
        let b = (self.bitbuf & 0xFF) as u8;
        self.consume(8);
        Some(b)
    }

    /// Decode one symbol WITHOUT consuming its bits: `Ok(None)` means the
    /// available bits cannot resolve it (refill, or suspend if input is
    /// exhausted — nothing was consumed, so the retry is clean).
    fn peek_sym(&self, h: &Huffman) -> Result<Option<(u16, u32)>, InflateError> {
        // The zero-bits-past-bitcnt invariant makes the primary lookup sound
        // even short of FAST_BITS: if the entry it finds fits the REAL bits,
        // prefix-freeness says it is the one true decode.
        let e = h.fast[self.peek(FAST_BITS) as usize];
        if e != 0 {
            let len = (e >> 9) as u32;
            if len <= self.bitcnt {
                return Ok(Some((e & 0x1FF, len)));
            }
            // Entry lengths are ≤ FAST_BITS, so this only happens when fewer
            // than FAST_BITS real bits are available and they zero-padded into
            // a longer code's slot: undecidable until more bits arrive.
            return Ok(None);
        }
        // Long code (or too few bits to tell): the canonical bit-walk, MSB
        // of the code arriving first (RFC 1951 §3.1.1).
        let mut code: u32 = 0;
        let mut first: u32 = 0;
        let mut index: u32 = 0;
        for len in 1..=MAX_BITS {
            if len > self.bitcnt {
                return Ok(None);
            }
            code |= ((self.bitbuf >> (len - 1)) & 1) as u32;
            let count = h.counts[len as usize] as u32;
            if code < first + count {
                return Ok(Some((h.symbols[(index + (code - first)) as usize], len)));
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err(InflateError("invalid huffman code"))
    }

    /// Fold this feed's produced bytes into the sliding-window ring, in at
    /// most two copies. Called once per suspension — NOT per byte — which is
    /// what keeps the literal/match hot paths down to plain Vec appends: the
    /// decode itself reads recent history out of `out` directly and only
    /// reaches into the ring for bytes older than the current feed.
    fn ring_fold(&mut self, produced: &[u8]) {
        let tail = if produced.len() >= WINDOW_SIZE { &produced[produced.len() - WINDOW_SIZE..] } else { produced };
        let at = self.wpos as usize;
        let first = (WINDOW_SIZE - at).min(tail.len());
        self.window[at..at + first].copy_from_slice(&tail[..first]);
        self.window[..tail.len() - first].copy_from_slice(&tail[first..]);
        self.wpos = ((at + tail.len()) as u32) & WINDOW_MASK;
    }

    /// Decode from `input`, appending at most `max_out` raw bytes to `out`.
    /// Returns the count of input bytes consumed and why decoding stopped;
    /// resume by feeding `input[consumed..]` (after draining `out`, if
    /// `OutputFull`). The state after ANY `Ok` return corresponds exactly to
    /// (`total_in`, `total_out`) and may be serialized with [`save`]. After an
    /// `Err` the state is POISONED — the batched counters were never folded —
    /// so it must be discarded, never saved (a corrupt stream has no valid
    /// resume point anyway).
    pub fn feed(&mut self, input: &[u8], max_out: usize, out: &mut Vec<u8>) -> Result<(usize, FeedStop), InflateError> {
        let out_start = out.len();
        // CRC, member/total counters, and the window ring all fold in batches
        // at suspension points, not per byte — the hot paths below are plain
        // Vec appends. out[crc_from..] is the current member's output not yet
        // folded into crc/member_out.
        let mut crc_from = out_start;
        let mut cur = Cursor { data: input, pos: 0 };
        macro_rules! suspend {
            ($why:expr) => {{
                self.crc = crc32_fold(self.crc, &out[crc_from..]);
                self.member_out += (out.len() - crc_from) as u64;
                self.total_out += (out.len() - out_start) as u64;
                self.ring_fold(&out[out_start..]);
                return Ok((cur.pos, $why));
            }};
        }
        loop {
            match self.mode {
                Mode::GzHeader => {
                    while self.hdr_have < 10 {
                        let Some(b) = self.take_byte(&mut cur) else { suspend!(FeedStop::NeedInput) };
                        match self.hdr_have {
                            0 if b != 0x1F => return Err(InflateError("not a gzip stream (magic)")),
                            1 if b != 0x8B => return Err(InflateError("not a gzip stream (magic)")),
                            2 if b != 8 => return Err(InflateError("unknown gzip compression method")),
                            3 => {
                                if b & 0xE0 != 0 {
                                    return Err(InflateError("reserved gzip header flags set"));
                                }
                                self.gz_flags = b;
                            }
                            _ => {} // MTIME / XFL / OS: ignored
                        }
                        self.hdr_have += 1;
                    }
                    self.hdr_have = 0;
                    self.mode = if self.gz_flags & 0x04 != 0 { Mode::GzExtraLen } else { self.after_extra() };
                }
                Mode::GzExtraLen => {
                    while self.hdr_have < 2 {
                        let Some(b) = self.take_byte(&mut cur) else { suspend!(FeedStop::NeedInput) };
                        self.hdr_buf[self.hdr_have as usize] = b;
                        self.hdr_have += 1;
                    }
                    self.skip_rem = self.hdr_buf[0] as u32 | ((self.hdr_buf[1] as u32) << 8);
                    self.hdr_have = 0;
                    self.mode = Mode::GzExtra;
                }
                Mode::GzExtra => {
                    while self.skip_rem > 0 {
                        let Some(_) = self.take_byte(&mut cur) else { suspend!(FeedStop::NeedInput) };
                        self.skip_rem -= 1;
                    }
                    self.mode = self.after_extra();
                }
                Mode::GzName | Mode::GzComment => loop {
                    let Some(b) = self.take_byte(&mut cur) else { suspend!(FeedStop::NeedInput) };
                    if b == 0 {
                        self.mode = if self.mode == Mode::GzName { self.after_name() } else { self.after_comment() };
                        break;
                    }
                },
                Mode::GzHcrc => {
                    while self.hdr_have < 2 {
                        let Some(_) = self.take_byte(&mut cur) else { suspend!(FeedStop::NeedInput) };
                        self.hdr_have += 1;
                    }
                    self.hdr_have = 0;
                    self.mode = Mode::BlockHead;
                }
                Mode::BlockHead => {
                    self.refill(&mut cur);
                    if self.bitcnt < 3 {
                        suspend!(FeedStop::NeedInput);
                    }
                    self.last_block = self.peek(1) == 1;
                    self.btype = (self.peek(3) >> 1) as u8;
                    self.consume(3);
                    match self.btype {
                        0 => {
                            // Stored: drop the bit remainder now, then LEN/NLEN.
                            let drop = self.bitcnt % 8;
                            self.consume(drop);
                            self.mode = Mode::StoredLen;
                        }
                        1 => {
                            self.lit = Huffman::fixed_lit();
                            self.dst = Huffman::fixed_dist();
                            self.mode = Mode::BlockSym;
                        }
                        2 => self.mode = Mode::TableHead,
                        _ => return Err(InflateError("invalid block type")),
                    }
                }
                Mode::StoredLen => {
                    while self.hdr_have < 4 {
                        let Some(b) = self.take_byte(&mut cur) else { suspend!(FeedStop::NeedInput) };
                        self.hdr_buf[self.hdr_have as usize] = b;
                        self.hdr_have += 1;
                    }
                    self.hdr_have = 0;
                    let len = self.hdr_buf[0] as u32 | ((self.hdr_buf[1] as u32) << 8);
                    let nlen = self.hdr_buf[2] as u32 | ((self.hdr_buf[3] as u32) << 8);
                    if len != !nlen & 0xFFFF {
                        return Err(InflateError("stored block length check failed"));
                    }
                    self.length = len;
                    self.mode = Mode::Stored;
                }
                Mode::Stored => {
                    while self.length > 0 {
                        if out.len() - out_start >= max_out {
                            suspend!(FeedStop::OutputFull);
                        }
                        if self.bitcnt >= 8 {
                            let b = (self.bitbuf & 0xFF) as u8;
                            self.consume(8);
                            out.push(b);
                            self.length -= 1;
                        } else {
                            debug_assert_eq!(self.bitcnt, 0);
                            let n = (self.length as usize)
                                .min(cur.data.len() - cur.pos)
                                .min(max_out - (out.len() - out_start));
                            if n == 0 {
                                suspend!(FeedStop::NeedInput);
                            }
                            let (from, to) = (cur.pos, cur.pos + n);
                            cur.pos = to;
                            self.total_in += n as u64;
                            out.extend_from_slice(&cur.data[from..to]);
                            self.length -= n as u32;
                        }
                    }
                    self.mode = if self.last_block { Mode::Trailer } else { Mode::BlockHead };
                }
                Mode::TableHead => {
                    self.refill(&mut cur);
                    if self.bitcnt < 14 {
                        suspend!(FeedStop::NeedInput);
                    }
                    self.nlen = 257 + self.peek(5) as u16;
                    self.consume(5);
                    self.ndist = 1 + self.peek(5) as u16;
                    self.consume(5);
                    self.ncode = 4 + self.peek(4) as u16;
                    self.consume(4);
                    if self.nlen > 286 || self.ndist > 30 {
                        return Err(InflateError("too many length or distance symbols"));
                    }
                    self.have = 0;
                    self.clen_lens = [0; 19];
                    self.mode = Mode::TableClen;
                }
                Mode::TableClen => {
                    while self.have < self.ncode {
                        self.refill(&mut cur);
                        if self.bitcnt < 3 {
                            suspend!(FeedStop::NeedInput);
                        }
                        self.clen_lens[CLEN_ORDER[self.have as usize]] = self.peek(3) as u8;
                        self.consume(3);
                        self.have += 1;
                    }
                    self.clen = Huffman::build(&self.clen_lens)?;
                    if !self.clen.complete {
                        return Err(InflateError("incomplete code-length code"));
                    }
                    self.have = 0;
                    self.lens = [0; 320];
                    self.mode = Mode::TableLens;
                }
                Mode::TableLens => {
                    let total = self.nlen + self.ndist;
                    while self.have < total {
                        self.refill(&mut cur);
                        let Some((sym, sl)) = self.peek_sym(&self.clen)? else { suspend!(FeedStop::NeedInput) };
                        if sym < 16 {
                            self.consume(sl);
                            self.lens[self.have as usize] = sym as u8;
                            self.have += 1;
                            continue;
                        }
                        let (extra, base) = match sym {
                            16 => (2u32, 3u32),
                            17 => (3, 3),
                            _ => (7, 11),
                        };
                        // Symbol + its extra bits consumed atomically, so a
                        // suspension can never land between them.
                        if self.bitcnt < sl + extra {
                            suspend!(FeedStop::NeedInput);
                        }
                        self.consume(sl);
                        let rep = base + self.peek(extra);
                        self.consume(extra);
                        let fill = if sym == 16 {
                            if self.have == 0 {
                                return Err(InflateError("length repeat with no previous length"));
                            }
                            self.lens[self.have as usize - 1]
                        } else {
                            0
                        };
                        if self.have as u32 + rep > total as u32 {
                            return Err(InflateError("length repeat past end of table"));
                        }
                        for _ in 0..rep {
                            self.lens[self.have as usize] = fill;
                            self.have += 1;
                        }
                    }
                    if self.lens[256] == 0 {
                        return Err(InflateError("missing end-of-block code"));
                    }
                    self.lit = Huffman::build(&self.lens[..self.nlen as usize])?;
                    if !self.lit.complete {
                        return Err(InflateError("incomplete literal/length code"));
                    }
                    // Incomplete distance tables are tolerated (single-code
                    // streams exist in the wild); a gap only errors if read.
                    self.dst = Huffman::build(&self.lens[self.nlen as usize..(self.nlen + self.ndist) as usize])?;
                    self.mode = Mode::BlockSym;
                }
                Mode::BlockSym => loop {
                    // A loop, not one symbol: literal runs — most of a JSON
                    // corpus — stay in this tight path without re-dispatching
                    // the outer mode match.
                    self.refill(&mut cur);
                    let Some((sym, sl)) = self.peek_sym(&self.lit)? else { suspend!(FeedStop::NeedInput) };
                    if sym < 256 {
                        if out.len() - out_start >= max_out {
                            suspend!(FeedStop::OutputFull);
                        }
                        self.consume(sl);
                        out.push(sym as u8);
                        continue;
                    }
                    if sym == 256 {
                        self.consume(sl);
                        self.mode = if self.last_block { Mode::Trailer } else { Mode::BlockHead };
                    } else {
                        if sym > 285 {
                            return Err(InflateError("invalid literal/length code"));
                        }
                        let i = (sym - 257) as usize;
                        let extra = LEN_EXTRA[i] as u32;
                        if self.bitcnt < sl + extra {
                            suspend!(FeedStop::NeedInput);
                        }
                        self.consume(sl);
                        self.length = LEN_BASE[i] as u32 + self.peek(extra);
                        self.consume(extra);
                        self.mode = Mode::DistSym;
                    }
                    break;
                },
                Mode::DistSym => {
                    self.refill(&mut cur);
                    let Some((sym, sl)) = self.peek_sym(&self.dst)? else { suspend!(FeedStop::NeedInput) };
                    if sym > 29 {
                        return Err(InflateError("invalid distance code"));
                    }
                    let extra = DIST_EXTRA[sym as usize] as u32;
                    if self.bitcnt < sl + extra {
                        suspend!(FeedStop::NeedInput);
                    }
                    self.consume(sl);
                    self.dist = DIST_BASE[sym as usize] as u32 + self.peek(extra);
                    self.consume(extra);
                    // Current member's produced count: the folded part plus
                    // this feed's not-yet-folded tail.
                    if self.dist as u64 > self.member_out + (out.len() - crc_from) as u64 {
                        return Err(InflateError("distance too far back"));
                    }
                    self.mode = Mode::MatchCopy;
                }
                Mode::MatchCopy => {
                    let dist = self.dist as usize;
                    while self.length > 0 {
                        let produced = out.len() - out_start;
                        if produced >= max_out {
                            suspend!(FeedStop::OutputFull);
                        }
                        let n = (self.length as usize).min(max_out - produced);
                        if dist <= produced {
                            // Source lies wholly in this feed's own output:
                            // copy in dist-wide waves, which is exactly the
                            // overlapping-match semantic (dist 1 = run fill).
                            let mut left = n;
                            while left > 0 {
                                let take = left.min(dist);
                                let src = out.len() - dist;
                                out.extend_from_within(src..src + take);
                                left -= take;
                            }
                            self.length -= n as u32;
                        } else {
                            // The source starts before this feed: those bytes
                            // live in the ring (folded at the last suspend).
                            // At most `dist - produced` of them, then the loop
                            // re-enters the in-out branch above.
                            let ring_bytes = dist - produced;
                            let take = ring_bytes.min(n);
                            for k in 0..take {
                                let idx = (self.wpos as usize + WINDOW_SIZE - ring_bytes + k) & WINDOW_MASK as usize;
                                out.push(self.window[idx]);
                            }
                            self.length -= take as u32;
                        }
                    }
                    self.mode = Mode::BlockSym;
                }
                Mode::Trailer => {
                    if self.hdr_have == 0 {
                        let drop = self.bitcnt % 8;
                        self.consume(drop);
                        // The trailer check needs the member's final CRC and
                        // length, so fold the member-scoped batches here (the
                        // ring and total_out still fold at the suspend).
                        self.crc = crc32_fold(self.crc, &out[crc_from..]);
                        self.member_out += (out.len() - crc_from) as u64;
                        crc_from = out.len();
                    }
                    while self.hdr_have < 8 {
                        let Some(b) = self.take_byte(&mut cur) else { suspend!(FeedStop::NeedInput) };
                        self.hdr_buf[self.hdr_have as usize] = b;
                        self.hdr_have += 1;
                    }
                    self.hdr_have = 0;
                    let expect_crc = u32::from_le_bytes([self.hdr_buf[0], self.hdr_buf[1], self.hdr_buf[2], self.hdr_buf[3]]);
                    let expect_len = u32::from_le_bytes([self.hdr_buf[4], self.hdr_buf[5], self.hdr_buf[6], self.hdr_buf[7]]);
                    if !self.crc != expect_crc {
                        return Err(InflateError("gzip crc mismatch"));
                    }
                    if self.member_out as u32 != expect_len {
                        return Err(InflateError("gzip length mismatch"));
                    }
                    self.crc = 0xFFFF_FFFF;
                    self.member_out = 0;
                    self.last_block = false;
                    self.mode = Mode::MemberEnd;
                }
                Mode::MemberEnd => {
                    self.refill(&mut cur);
                    if self.bitcnt < 8 {
                        suspend!(FeedStop::NeedInput);
                    }
                    // Another byte after a clean member: a concatenated member
                    // (multi-member gzip is one valid file, per RFC 1952 §2.2).
                    self.mode = Mode::GzHeader;
                }
            }
        }
    }

    fn after_extra(&self) -> Mode {
        if self.gz_flags & 0x08 != 0 {
            Mode::GzName
        } else {
            self.after_name()
        }
    }

    fn after_name(&self) -> Mode {
        if self.gz_flags & 0x10 != 0 {
            Mode::GzComment
        } else {
            self.after_comment()
        }
    }

    fn after_comment(&self) -> Mode {
        if self.gz_flags & 0x02 != 0 {
            Mode::GzHcrc
        } else {
            Mode::BlockHead
        }
    }

    // ── state serialization ──────────────────────────────────────────────────

    /// Serialize to exactly [`STATE_BYTES`] bytes. Pure function of the
    /// decode state: save → restore → save is byte-identical. Only valid
    /// between [`feed`] calls (there is no other kind of moment — the struct
    /// holds no mid-call state).
    pub fn save(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(STATE_BYTES);
        b.extend_from_slice(&STATE_MAGIC.to_le_bytes());
        b.extend_from_slice(&STATE_VERSION.to_le_bytes());
        b.push(self.mode as u8);
        b.push(self.last_block as u8);
        b.push(self.btype);
        b.push(self.gz_flags);
        b.push(self.hdr_have);
        b.extend_from_slice(&[0u8; 3]); // padding, must be zero
        b.extend_from_slice(&self.bitbuf.to_le_bytes());
        b.extend_from_slice(&self.bitcnt.to_le_bytes());
        b.extend_from_slice(&self.skip_rem.to_le_bytes());
        b.extend_from_slice(&self.crc.to_le_bytes());
        b.extend_from_slice(&self.total_in.to_le_bytes());
        b.extend_from_slice(&self.total_out.to_le_bytes());
        b.extend_from_slice(&self.member_out.to_le_bytes());
        b.extend_from_slice(&self.nlen.to_le_bytes());
        b.extend_from_slice(&self.ndist.to_le_bytes());
        b.extend_from_slice(&self.ncode.to_le_bytes());
        b.extend_from_slice(&self.have.to_le_bytes());
        b.extend_from_slice(&self.length.to_le_bytes());
        b.extend_from_slice(&self.dist.to_le_bytes());
        b.extend_from_slice(&(self.wpos as u16).to_le_bytes()); // < 32768, always
        b.extend_from_slice(&self.hdr_buf);
        b.extend_from_slice(&self.clen_lens);
        b.extend_from_slice(&self.lens);
        b.extend_from_slice(&self.window[..]);
        debug_assert_eq!(b.len(), STATE_BYTES);
        b
    }

    /// Rebuild an inflater from a [`save`] blob, refusing anything that is
    /// not byte-for-byte plausible: wrong shape, wrong version, impossible
    /// field values, or code lengths whose tables cannot build. Refusal is
    /// the feature — the caller falls back to decoding from byte 0.
    pub fn restore(bytes: &[u8]) -> Result<Inflater, RestoreError> {
        if bytes.len() != STATE_BYTES {
            return Err(RestoreError::Shape);
        }
        let mut at = 0usize;
        let mut take = |n: usize| {
            let s = &bytes[at..at + n];
            at += n;
            s
        };
        let u32_of = |s: &[u8]| u32::from_le_bytes(s.try_into().expect("sized read"));
        let u64_of = |s: &[u8]| u64::from_le_bytes(s.try_into().expect("sized read"));
        let u16_of = |s: &[u8]| u16::from_le_bytes(s.try_into().expect("sized read"));

        if u32_of(take(4)) != STATE_MAGIC {
            return Err(RestoreError::Shape);
        }
        let version = u32_of(take(4));
        if version != STATE_VERSION {
            return Err(RestoreError::Version(version));
        }
        let mode = Mode::from_u8(take(1)[0]).ok_or(RestoreError::Invalid("mode"))?;
        let last_block = match take(1)[0] {
            0 => false,
            1 => true,
            _ => return Err(RestoreError::Invalid("last_block")),
        };
        let btype = take(1)[0];
        if btype > 2 {
            return Err(RestoreError::Invalid("btype"));
        }
        let gz_flags = take(1)[0];
        let hdr_have = take(1)[0];
        if take(3) != [0u8; 3] {
            return Err(RestoreError::Invalid("padding"));
        }
        let bitbuf = u64_of(take(8));
        let bitcnt = u32_of(take(4));
        if bitcnt > 64 {
            return Err(RestoreError::Invalid("bitcnt"));
        }
        if bitcnt < 64 && bitbuf >> bitcnt != 0 {
            // The zero-above-bitcnt invariant is load-bearing for peek_sym.
            return Err(RestoreError::Invalid("bitbuf"));
        }
        let skip_rem = u32_of(take(4));
        if skip_rem > 0xFFFF {
            return Err(RestoreError::Invalid("skip_rem"));
        }
        let crc = u32_of(take(4));
        let total_in = u64_of(take(8));
        let total_out = u64_of(take(8));
        let member_out = u64_of(take(8));
        if member_out > total_out {
            return Err(RestoreError::Invalid("member_out"));
        }
        let nlen = u16_of(take(2));
        let ndist = u16_of(take(2));
        let ncode = u16_of(take(2));
        let have = u16_of(take(2));
        if nlen > 286 || ndist > 30 || ncode > 19 {
            return Err(RestoreError::Invalid("table sizes"));
        }
        let length = u32_of(take(4));
        if length > 0xFFFF || (mode == Mode::MatchCopy && length > 258) {
            return Err(RestoreError::Invalid("length"));
        }
        let dist = u32_of(take(4));
        if dist > 32768 || (mode == Mode::MatchCopy && (dist == 0 || dist as u64 > member_out)) {
            return Err(RestoreError::Invalid("dist"));
        }
        let wpos = u16_of(take(2)) as u32;
        if wpos as usize >= WINDOW_SIZE {
            return Err(RestoreError::Invalid("wpos"));
        }
        let mut hdr_buf = [0u8; 8];
        hdr_buf.copy_from_slice(take(8));
        // The largest counted piece is the 10-byte fixed gzip header.
        if hdr_have > 9 {
            return Err(RestoreError::Invalid("hdr_have"));
        }
        let mut clen_lens = [0u8; 19];
        clen_lens.copy_from_slice(take(19));
        if clen_lens.iter().any(|&l| l > 7) {
            return Err(RestoreError::Invalid("clen lengths"));
        }
        let mut lens = [0u8; 320];
        lens.copy_from_slice(take(320));
        if lens.iter().any(|&l| l > 15) {
            return Err(RestoreError::Invalid("code lengths"));
        }
        let mut window = Box::new([0u8; WINDOW_SIZE]);
        window.copy_from_slice(take(WINDOW_SIZE));
        debug_assert_eq!(at, STATE_BYTES);

        // `have` only means anything in the two table-reading modes; bound it
        // by what each mode indexes with it.
        let over_have = match mode {
            Mode::TableClen => have > ncode,
            Mode::TableLens => have > nlen + ndist,
            _ => false,
        };
        if over_have {
            return Err(RestoreError::Invalid("have"));
        }

        // Rebuild every table the mode could read from. A build failure means
        // the lengths cannot be the ones a live decode was using — refuse.
        let bad = |_e: InflateError| RestoreError::Invalid("tables do not build");
        let mut clen = Huffman::default();
        let mut lit = Huffman::default();
        let mut dst = Huffman::default();
        match mode {
            Mode::TableLens => {
                clen = Huffman::build(&clen_lens).map_err(bad)?;
                if !clen.complete {
                    return Err(RestoreError::Invalid("tables do not build"));
                }
            }
            Mode::BlockSym | Mode::DistSym | Mode::MatchCopy => match btype {
                1 => {
                    lit = Huffman::fixed_lit();
                    dst = Huffman::fixed_dist();
                }
                2 => {
                    lit = Huffman::build(&lens[..nlen as usize]).map_err(bad)?;
                    if !lit.complete || lens[256] == 0 {
                        return Err(RestoreError::Invalid("tables do not build"));
                    }
                    dst = Huffman::build(&lens[nlen as usize..(nlen + ndist) as usize]).map_err(bad)?;
                }
                _ => return Err(RestoreError::Invalid("stored block cannot be mid-symbol")),
            },
            _ => {}
        }

        Ok(Inflater {
            mode,
            bitbuf,
            bitcnt,
            total_in,
            total_out,
            member_out,
            crc,
            gz_flags,
            hdr_have,
            hdr_buf,
            skip_rem,
            last_block,
            btype,
            nlen,
            ndist,
            ncode,
            have,
            lens,
            clen_lens,
            length,
            dist,
            window,
            wpos,
            lit,
            dst,
            clen,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_blob_is_exactly_the_documented_size() {
        assert_eq!(Inflater::new().save().len(), STATE_BYTES);
    }

    #[test]
    fn fresh_state_round_trips() {
        let a = Inflater::new().save();
        let b = Inflater::restore(&a).expect("fresh state restores").save();
        assert_eq!(a, b);
    }

    #[test]
    fn wrong_version_is_refused() {
        let mut blob = Inflater::new().save();
        blob[4..8].copy_from_slice(&2u32.to_le_bytes());
        assert!(matches!(Inflater::restore(&blob), Err(RestoreError::Version(2))));
    }

    #[test]
    fn wrong_shape_is_refused() {
        assert!(matches!(Inflater::restore(&[]), Err(RestoreError::Shape)));
        let blob = Inflater::new().save();
        assert!(matches!(Inflater::restore(&blob[..blob.len() - 1]), Err(RestoreError::Shape)));
        let mut bad_magic = blob.clone();
        bad_magic[0] ^= 0xFF;
        assert!(matches!(Inflater::restore(&bad_magic), Err(RestoreError::Shape)));
    }

    #[test]
    fn impossible_fields_are_refused() {
        // mode out of range
        let mut blob = Inflater::new().save();
        blob[8] = 200;
        assert!(matches!(Inflater::restore(&blob), Err(RestoreError::Invalid("mode"))));
        // bitbuf bits above bitcnt (breaks the peek invariant)
        let mut blob = Inflater::new().save();
        blob[16..24].copy_from_slice(&u64::MAX.to_le_bytes()); // bitbuf, with bitcnt 0
        assert!(matches!(Inflater::restore(&blob), Err(RestoreError::Invalid("bitbuf"))));
        // code length over 15
        let mut blob = Inflater::new().save();
        let lens_at = STATE_BYTES - WINDOW_SIZE - 320;
        blob[lens_at] = 16;
        assert!(matches!(Inflater::restore(&blob), Err(RestoreError::Invalid("code lengths"))));
    }

    #[test]
    fn truncated_input_is_need_input_not_error() {
        let mut inf = Inflater::new();
        let mut out = Vec::new();
        let (consumed, stop) = inf.feed(&[0x1F, 0x8B], usize::MAX, &mut out).expect("prefix is fine");
        assert_eq!(consumed, 2);
        assert_eq!(stop, FeedStop::NeedInput);
        assert!(!inf.at_member_boundary());
    }

    #[test]
    fn garbage_input_errors() {
        let mut inf = Inflater::new();
        let mut out = Vec::new();
        assert!(inf.feed(&[0x50, 0x4B, 0x03, 0x04], usize::MAX, &mut out).is_err());
    }
}
