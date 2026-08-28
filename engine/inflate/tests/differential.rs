//! Differential proof of the serializable inflater, against flate2 — an
//! INDEPENDENT gzip implementation that both compresses the inputs and
//! decodes the reference output.
//!
//! The property under test is the whole point of the crate: chopping a decode
//! into many resume-from-serialized-state segments — at adversarial split
//! points in both the compressed input (every byte) and the raw output (every
//! byte; member-grid stops) — produces raw bytes IDENTICAL to a one-pass
//! decode, with every intermediate state surviving save → restore into a
//! brand-new Inflater (the cross-alarm shape: nothing carries over but the
//! blob). A companion suite in tests/import/ (TypeScript) pins the same
//! property against the committed wasm blob and the Workers platform's
//! DecompressionStream.

use std::io::{Read, Write};

use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sylvan_inflate::{FeedStop, Inflater, RestoreError, STATE_VERSION};

// ─── deterministic content generators ────────────────────────────────────────

struct Lcg(u32);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() as usize) % n
    }
}

/// Card-shaped JSONL — the real corpus class: highly compressible text with
/// repeated keys, varied values, occasional long runs.
fn gen_jsonl(bytes: usize, seed: u32) -> Vec<u8> {
    let mut rng = Lcg(seed);
    let mut out = Vec::with_capacity(bytes + 256);
    let mut i = 0u64;
    while out.len() < bytes {
        let pad = "x".repeat(rng.below(40));
        let cost = rng.below(16);
        let line = format!(
            "{{\"object\":\"card\",\"id\":\"{i:032x}\",\"name\":\"Card {i}\",\"lang\":\"en\",\"cmc\":{cost},\"oracle_text\":\"Whenever this attacks, draw a card. {pad}\"}}\n",
        );
        out.extend_from_slice(line.as_bytes());
        i += 1;
    }
    out.truncate(bytes);
    out
}

/// Incompressible bytes: deflate falls back to stored blocks at any level.
fn gen_random(bytes: usize, seed: u32) -> Vec<u8> {
    let mut rng = Lcg(seed);
    (0..bytes).map(|_| (rng.next() >> 24) as u8).collect()
}

/// Long overlapping matches (dist 1 and dist ~window) — the match-copy paths.
fn gen_repetitive(bytes: usize) -> Vec<u8> {
    let motif = b"abcabcabc-the-same-line-again-and-again\n";
    let mut out = Vec::with_capacity(bytes + motif.len());
    out.extend_from_slice(&[b'z'; 4096]); // a dist-1 run
    while out.len() < bytes {
        out.extend_from_slice(motif);
    }
    out.truncate(bytes);
    out
}

fn gzip(raw: &[u8], level: u32) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::new(level));
    enc.write_all(raw).expect("gzip write");
    enc.finish().expect("gzip finish")
}

fn reference_inflate(gz: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    MultiGzDecoder::new(gz).read_to_end(&mut out).expect("flate2 decodes");
    out
}

// ─── the chopped decoder under test ──────────────────────────────────────────

/// Decode `gz` with input fed in `feed_sizes`-driven chunks and output capped
/// at `stop_sizes`-driven amounts, executing save → restore → (assert stable
/// re-save) into a FRESH Inflater at every single pause point.
fn inflate_chopped(gz: &[u8], mut feed_size: impl FnMut() -> usize, mut max_out: impl FnMut() -> usize) -> Vec<u8> {
    let mut inf = Inflater::new();
    // Byte 0 is a split point too: the fresh state must itself round-trip.
    inf = reload(&inf);
    let mut out = Vec::new();
    let mut at = 0usize;
    let mut pending: usize = 0; // unconsumed remainder of the current chunk
    loop {
        if pending == 0 && at < gz.len() {
            pending = feed_size().clamp(1, gz.len() - at);
        }
        // An empty chunk at EOF is legitimate: an OutputFull pause can leave
        // decoded-but-uncapped work (a half-copied match) needing no input.
        let chunk = &gz[at..at + pending];
        let cap = max_out().max(1);
        let (consumed, stop) = inf.feed(chunk, cap, &mut out).expect("valid stream");
        at += consumed;
        pending -= consumed;
        assert_eq!(inf.total_in(), at as u64, "total_in tracks consumed bytes");
        assert_eq!(inf.total_out(), out.len() as u64, "total_out tracks produced bytes");
        // The cross-alarm boundary: nothing survives but the blob.
        inf = reload(&inf);
        if at >= gz.len() && pending == 0 && stop == FeedStop::NeedInput {
            assert!(inf.at_member_boundary(), "stream must end clean, not truncated");
            return out;
        }
    }
}

/// save → restore → save must be byte-identical, and the restored inflater
/// must sit at the same offsets.
fn reload(inf: &Inflater) -> Inflater {
    let blob = inf.save();
    let back = Inflater::restore(&blob).expect("a live state restores");
    assert_eq!(back.save(), blob, "save/restore/save is stable");
    assert_eq!(back.total_in(), inf.total_in());
    assert_eq!(back.total_out(), inf.total_out());
    back
}

// ─── the matrix ──────────────────────────────────────────────────────────────

#[test]
fn one_pass_matches_flate2_across_levels_and_content() {
    let corpora: Vec<(&str, Vec<u8>)> = vec![
        ("jsonl", gen_jsonl(1 << 20, 7)),
        ("random", gen_random(1 << 20, 11)),
        ("repetitive", gen_repetitive(1 << 20)),
        ("empty", Vec::new()),
        ("one byte", vec![b'A']),
    ];
    for (name, raw) in &corpora {
        // Level 0 = stored blocks, 1 = fastest/fixed-leaning, 6 = the level
        // real dumps ship at, 9 = densest dynamic blocks.
        for level in [0u32, 1, 6, 9] {
            let gz = gzip(raw, level);
            assert_eq!(&reference_inflate(&gz), raw, "flate2 self-check ({name} level {level})");
            let ours = inflate_chopped(&gz, || usize::MAX, || usize::MAX);
            assert_eq!(&ours, raw, "one-pass differential ({name} level {level})");
        }
    }
}

#[test]
fn every_input_byte_is_a_valid_stop() {
    // 1-byte feeds suspend at every compressed byte — inside the gzip header,
    // mid Huffman code, mid extra bits, mid stored length, mid trailer — and
    // every suspension is serialized into a fresh instance.
    for (raw, level) in [
        (gen_jsonl(96 * 1024, 21), 6u32),
        (gen_random(24 * 1024, 22), 6), // stored blocks
        (gen_repetitive(96 * 1024), 9),
    ] {
        let gz = gzip(&raw, level);
        let ours = inflate_chopped(&gz, || 1, || usize::MAX);
        assert_eq!(ours, raw);
    }
}

#[test]
fn every_output_byte_is_a_valid_stop() {
    // max_out=1 pauses after every raw byte — mid match copy above all — and
    // serializes there.
    let raw = gen_jsonl(48 * 1024, 31);
    let gz = gzip(&raw, 6);
    let ours = inflate_chopped(&gz, || usize::MAX, || 1);
    assert_eq!(ours, raw);

    let raw = gen_repetitive(48 * 1024);
    let gz = gzip(&raw, 9);
    let ours = inflate_chopped(&gz, || usize::MAX, || 1);
    assert_eq!(ours, raw);
}

#[test]
fn random_split_schedules_compose() {
    let raw = gen_jsonl(4 << 20, 41);
    let gz = gzip(&raw, 6);
    for seed in 1..=8u32 {
        let mut feed_rng = Lcg(seed);
        let mut stop_rng = Lcg(seed ^ 0xBEEF);
        let ours = inflate_chopped(
            &gz,
            move || 1 + feed_rng.below(64 * 1024),
            move || 1 + stop_rng.below(256 * 1024),
        );
        assert_eq!(ours, raw, "schedule seed {seed}");
    }
}

#[test]
fn member_grid_stops_match_the_recode_shape() {
    // The production pattern exactly: output stopped at every multiple of the
    // member size, state saved there, decode continued in a fresh instance.
    let raw = gen_jsonl(3 << 20, 51);
    let gz = gzip(&raw, 6);
    let member = 256 * 1024;
    let mut produced = 0usize;
    let mut inf = reload(&Inflater::new());
    let mut out = Vec::new();
    let mut at = 0usize;
    while !(inf.at_member_boundary() && at >= gz.len()) {
        let cap = member - (produced % member);
        let chunk_end = (at + 8 * 1024).min(gz.len());
        let (consumed, stop) = inf.feed(&gz[at..chunk_end], cap, &mut out).expect("valid stream");
        at += consumed;
        produced = out.len();
        if stop == FeedStop::OutputFull {
            assert_eq!(produced % member, 0, "OutputFull lands exactly on the grid");
        }
        inf = reload(&inf);
        if at >= gz.len() && stop == FeedStop::NeedInput && !inf.at_member_boundary() {
            panic!("truncated");
        }
    }
    assert_eq!(out, raw);
}

#[test]
fn eof_state_restores_and_stays_done() {
    let raw = gen_jsonl(64 * 1024, 61);
    let gz = gzip(&raw, 6);
    let mut inf = Inflater::new();
    let mut out = Vec::new();
    inf.feed(&gz, usize::MAX, &mut out).expect("valid stream");
    assert!(inf.at_member_boundary());
    let mut back = reload(&inf);
    assert!(back.at_member_boundary());
    let (consumed, stop) = back.feed(&[], usize::MAX, &mut out).expect("EOF is stable");
    assert_eq!((consumed, stop), (0, FeedStop::NeedInput));
    assert_eq!(out, raw);
}

#[test]
fn concatenated_members_decode_across_the_seam() {
    // RFC 1952 §2.2: a gzip file is one or more members. Splits land on the
    // seam, one byte either side of it, and inside both members.
    let a = gen_jsonl(80 * 1024, 71);
    let b = gen_repetitive(64 * 1024);
    let c = gen_random(16 * 1024, 73);
    let mut gz = gzip(&a, 6);
    let seam = gz.len();
    gz.extend_from_slice(&gzip(&b, 1));
    gz.extend_from_slice(&gzip(&c, 0));
    let mut raw = a.clone();
    raw.extend_from_slice(&b);
    raw.extend_from_slice(&c);
    assert_eq!(reference_inflate(&gz), raw, "flate2 self-check");

    let ours = inflate_chopped(&gz, || usize::MAX, || usize::MAX);
    assert_eq!(ours, raw);

    for first in [seam - 1, seam, seam + 1] {
        let mut lead = Some(first);
        let ours = inflate_chopped(&gz, move || lead.take().unwrap_or(usize::MAX), || usize::MAX);
        assert_eq!(ours, raw, "seam split at {first}");
    }

    let ours = inflate_chopped(&gz, || 1, || usize::MAX);
    assert_eq!(ours, raw, "1-byte feeds across the seam");
}

// ─── header variants and a hand-built fixed-Huffman member ───────────────────

/// LSB-first bit writer; Huffman codes go in MSB-of-code-first (RFC 1951 §3.1.1).
struct BitWriter {
    bytes: Vec<u8>,
    cur: u32,
    nbits: u32,
}

impl BitWriter {
    fn new() -> Self {
        BitWriter { bytes: Vec::new(), cur: 0, nbits: 0 }
    }
    fn bits_lsb(&mut self, val: u32, n: u32) {
        self.cur |= val << self.nbits;
        self.nbits += n;
        while self.nbits >= 8 {
            self.bytes.push((self.cur & 0xFF) as u8);
            self.cur >>= 8;
            self.nbits -= 8;
        }
    }
    fn code_msb(&mut self, code: u32, n: u32) {
        for i in (0..n).rev() {
            self.bits_lsb((code >> i) & 1, 1);
        }
    }
    fn align(&mut self) {
        if self.nbits > 0 {
            self.bytes.push((self.cur & 0xFF) as u8);
            self.cur = 0;
            self.nbits = 0;
        }
    }
}

fn fixed_lit_code(lit: u32) -> (u32, u32) {
    match lit {
        0..=143 => (0x30 + lit, 8),
        144..=255 => (0x190 + (lit - 144), 9),
        256..=279 => (lit - 256, 7),
        _ => (0xC0 + (lit - 280), 8),
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    // Small, independent table-free CRC32 for the hand-built member.
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { 0xEDB8_8320 ^ (crc >> 1) } else { crc >> 1 };
        }
    }
    !crc
}

/// A gzip member written by hand: every optional header field set (FEXTRA,
/// FNAME, FCOMMENT, FHCRC — no mainstream encoder emits them all) around a
/// FIXED-Huffman block (flate2 essentially never emits one).
fn hand_built_member(payload: &[u8]) -> Vec<u8> {
    let mut header = vec![
        0x1F, 0x8B, 8,    // magic, deflate
        0x02 | 0x04 | 0x08 | 0x10, // FHCRC | FEXTRA | FNAME | FCOMMENT
        1, 2, 3, 4,       // MTIME (arbitrary)
        0, 3,             // XFL, OS
    ];
    header.extend_from_slice(&[4, 0]); // XLEN = 4
    header.extend_from_slice(b"XTRA");
    header.extend_from_slice(b"a-name\0");
    header.extend_from_slice(b"a comment\0");
    let hcrc = crc32(&header) & 0xFFFF;
    let mut gz = header;
    gz.push((hcrc & 0xFF) as u8);
    gz.push((hcrc >> 8) as u8);

    let mut w = BitWriter::new();
    w.bits_lsb(1, 1); // BFINAL
    w.bits_lsb(1, 2); // BTYPE = 01 fixed
    for &b in payload {
        let (code, n) = fixed_lit_code(b as u32);
        w.code_msb(code, n);
    }
    let (eob, n) = fixed_lit_code(256);
    w.code_msb(eob, n);
    w.align();
    gz.extend_from_slice(&w.bytes);
    gz.extend_from_slice(&crc32(payload).to_le_bytes());
    gz.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    gz
}

#[test]
fn header_variants_and_fixed_blocks_decode() {
    let payload: Vec<u8> = (0..2048u32).map(|i| (i % 251) as u8).collect(); // spans both 8- and 9-bit literal ranges
    let gz = hand_built_member(&payload);
    assert_eq!(reference_inflate(&gz), payload, "flate2 agrees the member is valid");
    // One pass, then every-byte feeds with save/restore at each — the header
    // sub-modes (GzExtraLen, GzExtra, GzName, GzComment, GzHcrc) all become
    // serialization points.
    assert_eq!(inflate_chopped(&gz, || usize::MAX, || usize::MAX), payload);
    assert_eq!(inflate_chopped(&gz, || 1, || usize::MAX), payload);
    assert_eq!(inflate_chopped(&gz, || 1, || 1), payload);
}

#[test]
fn flate2_extra_name_comment_headers_decode() {
    let raw = gen_jsonl(32 * 1024, 81);
    let mut enc = flate2::GzBuilder::new()
        .extra(&b"trailing-extra"[..])
        .filename(&b"all-cards.json"[..])
        .comment(&b"a bulk dump"[..])
        .write(Vec::new(), Compression::new(6));
    enc.write_all(&raw).expect("gzip write");
    let gz = enc.finish().expect("gzip finish");
    assert_eq!(inflate_chopped(&gz, || 1, || usize::MAX), raw);
}

// ─── corruption is refused, not resumed past ─────────────────────────────────

#[test]
fn corrupt_crc_is_an_error() {
    let raw = gen_jsonl(16 * 1024, 91);
    let mut gz = gzip(&raw, 6);
    let n = gz.len();
    gz[n - 8] ^= 0xFF; // CRC32 low byte
    let mut inf = Inflater::new();
    let mut out = Vec::new();
    assert!(inf.feed(&gz, usize::MAX, &mut out).is_err());
}

#[test]
fn corrupt_isize_is_an_error() {
    let raw = gen_jsonl(16 * 1024, 92);
    let mut gz = gzip(&raw, 6);
    let n = gz.len();
    gz[n - 1] ^= 0xFF; // ISIZE high byte
    let mut inf = Inflater::new();
    let mut out = Vec::new();
    assert!(inf.feed(&gz, usize::MAX, &mut out).is_err());
}

#[test]
fn version_stamp_gates_the_whole_matrix() {
    // The deploy-mid-run story: a checkpoint from other code must be refused
    // whatever else looks plausible about it.
    let raw = gen_jsonl(64 * 1024, 93);
    let gz = gzip(&raw, 6);
    let mut inf = Inflater::new();
    let mut out = Vec::new();
    inf.feed(&gz[..gz.len() / 2], usize::MAX, &mut out).expect("valid prefix");
    let mut blob = inf.save();
    blob[4..8].copy_from_slice(&(STATE_VERSION + 1).to_le_bytes());
    assert!(matches!(Inflater::restore(&blob), Err(RestoreError::Version(_))));
}

// ─── the multi-hundred-MB differential ───────────────────────────────────────

/// The production-scale run: ~256MiB of card-shaped JSONL through one gzip
/// member, decoded in randomized feed chunks with randomized output stops and
/// a save → restore → fresh-instance hop at EVERY pause, compared against
/// flate2 in lockstep so neither output is ever held whole.
#[test]
fn multi_hundred_mb_stream_chopped_equals_one_pass() {
    const RAW_TARGET: usize = 256 << 20;
    // Generate + compress in slabs so only the compressed stream is resident.
    let mut enc = GzEncoder::new(Vec::new(), Compression::new(6));
    let mut produced = 0usize;
    let mut slab_seed = 0x5EED;
    while produced < RAW_TARGET {
        let slab = gen_jsonl((4 << 20).min(RAW_TARGET - produced), slab_seed);
        enc.write_all(&slab).expect("gzip write");
        produced += slab.len();
        slab_seed += 1;
    }
    let gz = enc.finish().expect("gzip finish");

    let mut reference = MultiGzDecoder::new(&gz[..]);
    let mut ref_buf = vec![0u8; 1 << 20];

    let mut inf = reload(&Inflater::new());
    let mut out = Vec::new();
    let mut at = 0usize;
    let mut feed_rng = Lcg(0xFEED);
    let mut stop_rng = Lcg(0x5709);
    let mut checked = 0usize;
    let mut pauses = 0u32;
    loop {
        let chunk_end = (at + 1 + feed_rng.below(256 * 1024)).min(gz.len());
        // Stops land everywhere: tiny, member-grid-sized, and huge.
        let cap = match stop_rng.below(3) {
            0 => 1 + stop_rng.below(4096),
            1 => 8 << 20,
            _ => usize::MAX,
        };
        let (consumed, stop) = inf.feed(&gz[at..chunk_end], cap, &mut out).expect("valid stream");
        at += consumed;
        pauses += 1;
        // Serialize at a sample of pauses (every pause would be ~200k blob
        // copies); always at OutputFull pauses, the checkpoint-bearing kind.
        if stop == FeedStop::OutputFull || pauses.is_multiple_of(7) {
            inf = reload(&inf);
        }
        // Lockstep comparison, discarding as we go.
        let mut off = 0usize;
        while off < out.len() {
            let n = (out.len() - off).min(ref_buf.len());
            reference.read_exact(&mut ref_buf[..n]).expect("reference has the bytes");
            assert_eq!(&out[off..off + n], &ref_buf[..n], "diverged near raw offset {checked}");
            off += n;
            checked += n;
        }
        out.clear();
        if at >= gz.len() && stop == FeedStop::NeedInput {
            break;
        }
    }
    assert!(inf.at_member_boundary(), "stream ends clean");
    assert_eq!(checked, RAW_TARGET);
    assert_eq!(reference.read(&mut ref_buf).expect("reference EOF"), 0, "reference is also exhausted");
}
