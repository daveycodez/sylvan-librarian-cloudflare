//! How many partitions the store is cut into — sized on its LARGEST partition, projected from the
//! staged drafts' own layout under each candidate N (backlog x28).
//!
//! The line-for-line twin of `src/import-sizing.ts` (the nightly coordinator's copy), which carries
//! the long form of why: the rule this replaces sized N on the MEAN partition and left the hash's
//! skew to a fixed 7% allowance, and on the 2026-09-26 real corpus the largest partition sat 1.4%
//! under the 46MB chunk cut. Both builders see the same (partition hash, draft JSON length) for
//! every staged draft and run the same integer arithmetic over them, so they choose the same N —
//! `tests/engine/partition-sizing-vectors.json` pins that for both languages, and the import
//! harness checks it end to end. Change a constant here and its twin there together.

/// The floor: two, not one, so the partitioned code paths are exercised on every corpus.
pub const MIN_PARTITIONS: u32 = 2;
/// The ceiling (src/import-publish.ts's `MAX_PARTITION_COUNT` has every N-scaled cost behind it).
pub const MAX_PARTITIONS: u32 = 48;

/// Bytes of framing counted around each staged draft: the 8-byte partition hash the coordinator
/// stages in front of every draft's JSON. This spill's own 4-byte length prefix is private framing
/// and is not counted.
pub const DRAFT_FRAME_BYTES: u64 = 8;

/// store-kv.ts's KV_CHUNK_BYTES: the raw cut a partition must stay one chunk under.
pub const KV_CHUNK_BYTES: u64 = 46_000_000;

/// The projection's coefficients — a partition's archive is
/// `STORE_BYTES_PER_PARTITION + STORE_BYTES_PER_CARD x cards + (NUM / DEN) x framed draft bytes`,
/// fitted 2026-09-26 over 181 real partitions of the 2026-08-16 corpus built at N = 8..48
/// (src/import-sizing.ts has the fit and its residuals: -0.77% .. +0.62% between 30 and 60MB).
pub const STORE_BYTES_PER_PARTITION: u64 = 1_141_000;
pub const STORE_BYTES_PER_CARD: u64 = 3_770;
pub const STORE_PER_DRAFT_BYTE_NUM: u64 = 1_527;
pub const STORE_PER_DRAFT_BYTE_DEN: u64 = 10_000;

/// The projection's error allowance (src/import-sizing.ts's `PARTITION_PROJECTION_ERROR_PCT`):
/// a partition built further above its projection than this means the fit needs re-measuring.
pub const PROJECTION_ERROR: f64 = 0.01;

/// The most a partition may PROJECT to: the cut less the 5% safety margin, less the 1% projection
/// error on top — `floor(46_000_000 x 95 / 101)`, src/import-sizing.ts's `PARTITION_CEILING_BYTES`
/// (the shared vectors file holds the two equal).
pub const PARTITION_CEILING_BYTES: u64 = KV_CHUNK_BYTES * 95 / 101;
const _: () = assert!(PARTITION_CEILING_BYTES < KV_CHUNK_BYTES);

/// The ceiling in force: the constant, or `SYLVAN_PARTITION_CEILING_BYTES` for the import harness
/// (the twin of the coordinator's `IMPORT_PARTITION_CEILING_BYTES`), whose corpus is a fiftieth of
/// the real one and would otherwise always land on MIN_PARTITIONS.
pub fn partition_ceiling_bytes() -> u64 {
    std::env::var("SYLVAN_PARTITION_CEILING_BYTES")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(PARTITION_CEILING_BYTES)
}

/// The projection in 1/DEN-byte units, so the two languages never disagree on a rounding.
fn scaled_projection(cards: u64, framed_draft_bytes: u64) -> u64 {
    (STORE_BYTES_PER_PARTITION + STORE_BYTES_PER_CARD * cards) * STORE_PER_DRAFT_BYTE_DEN
        + STORE_PER_DRAFT_BYTE_NUM * framed_draft_bytes
}

/// One partition's projected archive bytes, from its card count and its framed draft bytes.
pub fn project_partition_bytes(cards: u64, framed_draft_bytes: u64) -> u64 {
    scaled_projection(cards, framed_draft_bytes) / STORE_PER_DRAFT_BYTE_DEN
}

/// What [`choose_partition_count`] decided, and the numbers it decided on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SizingChoice {
    pub n: u32,
    /// Projected archive bytes of each partition at `n`.
    pub projected: Vec<u64>,
    /// The largest of them, and where.
    pub largest: u64,
    pub largest_at: u32,
    /// Distinct oracle ids (cards), framed draft bytes and drafts in the whole corpus.
    pub cards: u64,
    pub framed_bytes: u64,
    pub drafts: u64,
    /// The ceiling the largest was held to.
    pub ceiling: u64,
    /// No N in range brought the largest partition under the ceiling; `n` is MAX_PARTITIONS.
    pub clamped: bool,
}

/// The corpus as the projection needs it: one entry per CARD (distinct oracle hash) with the
/// framed bytes of all its drafts — src/import-sizing.ts's `CardBytes`. Every draft of a card lands
/// in the card's partition, so per-partition sums over cards are exactly the sums over drafts, and
/// a candidate N costs one pass over ~39k cards rather than ~540k drafts.
pub struct CardBytes {
    cards: Vec<(u64, u64)>,
    drafts: u64,
    framed_bytes: u64,
}

impl CardBytes {
    pub fn of(drafts: &[(u64, u32)]) -> Self {
        let mut sorted: Vec<(u64, u32)> = drafts.to_vec();
        sorted.sort_unstable_by_key(|&(h, _)| h);
        let mut cards: Vec<(u64, u64)> = Vec::new();
        let mut framed_bytes = 0u64;
        for (h, len) in sorted {
            let framed = DRAFT_FRAME_BYTES + u64::from(len);
            framed_bytes += framed;
            match cards.last_mut() {
                Some((last, bytes)) if *last == h => *bytes += framed,
                _ => cards.push((h, framed)),
            }
        }
        CardBytes { cards, drafts: drafts.len() as u64, framed_bytes }
    }

    pub fn cards(&self) -> u64 {
        self.cards.len() as u64
    }

    /// Each partition's projection at `n`, in 1/DEN-byte units.
    fn scaled_at(&self, n: u32) -> Vec<u64> {
        let mut bytes = vec![0u64; n as usize];
        let mut cards = vec![0u64; n as usize];
        for &(h, b) in &self.cards {
            let k = (h % u64::from(n)) as usize;
            bytes[k] += b;
            cards[k] += 1;
        }
        (0..n as usize).map(|k| scaled_projection(cards[k], bytes[k])).collect()
    }
}

/// Every partition's projected archive bytes when the corpus is cut into `n` — what a build at any
/// N logs its actual sizes against.
pub fn project_partitions(corpus: &CardBytes, n: u32) -> Vec<u64> {
    corpus.scaled_at(n.max(1)).into_iter().map(|s| s / STORE_PER_DRAFT_BYTE_DEN).collect()
}

/// The partition count for a corpus: the smallest N in [MIN, MAX] whose every partition projects to
/// at most `ceiling` bytes; MAX_PARTITIONS, `clamped`, when none does.
///
/// The search starts at the first N whose MEAN fits (the projection is linear in each partition's
/// counts, so a partition count whose mean overflows cannot have a largest that fits) and walks up.
pub fn choose_partition_count_for(corpus: &CardBytes, ceiling: u64) -> SizingChoice {
    let scaled_ceiling = ceiling * STORE_PER_DRAFT_BYTE_DEN;
    let project = |n: u32| -> SizingChoice {
        let scaled = corpus.scaled_at(n);
        // The FIRST largest, as the TypeScript twin takes it.
        let mut largest_at = 0usize;
        for k in 1..scaled.len() {
            if scaled[k] > scaled[largest_at] {
                largest_at = k;
            }
        }
        SizingChoice {
            n,
            projected: scaled.iter().map(|s| s / STORE_PER_DRAFT_BYTE_DEN).collect(),
            largest: scaled[largest_at] / STORE_PER_DRAFT_BYTE_DEN,
            largest_at: largest_at as u32,
            cards: corpus.cards(),
            framed_bytes: corpus.framed_bytes,
            drafts: corpus.drafts,
            ceiling,
            clamped: scaled[largest_at] > scaled_ceiling,
        }
    };
    let start = scaled_projection(corpus.cards(), corpus.framed_bytes)
        .div_ceil(scaled_ceiling.max(1))
        .clamp(u64::from(MIN_PARTITIONS), u64::from(MAX_PARTITIONS)) as u32;
    for n in start..MAX_PARTITIONS {
        let choice = project(n);
        if !choice.clamped {
            return choice;
        }
    }
    project(MAX_PARTITIONS)
}

/// [`choose_partition_count_for`] over drafts in hand — `(fnv1a64(oracle_id), draft JSON length)`
/// each, in any order.
pub fn choose_partition_count(drafts: &[(u64, u32)], ceiling: u64) -> SizingChoice {
    choose_partition_count_for(&CardBytes::of(drafts), ceiling)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../../tests/engine/partition-sizing-vectors.json")).expect("vectors parse")
    }

    fn drafts_of(v: &Value) -> Vec<(u64, u32)> {
        v["drafts"]
            .as_array()
            .expect("drafts")
            .iter()
            .map(|d| (d[0].as_str().unwrap().parse().unwrap(), d[1].as_u64().unwrap() as u32))
            .collect()
    }

    #[test]
    fn constants_are_the_typescript_twins() {
        let v = vectors();
        let c = &v["constants"];
        assert_eq!(c["min_partitions"].as_u64(), Some(u64::from(MIN_PARTITIONS)));
        assert_eq!(c["max_partitions"].as_u64(), Some(u64::from(MAX_PARTITIONS)));
        assert_eq!(c["draft_frame_bytes"].as_u64(), Some(DRAFT_FRAME_BYTES));
        assert_eq!(c["kv_chunk_bytes"].as_u64(), Some(KV_CHUNK_BYTES));
        assert_eq!(c["store_bytes_per_partition"].as_u64(), Some(STORE_BYTES_PER_PARTITION));
        assert_eq!(c["store_bytes_per_card"].as_u64(), Some(STORE_BYTES_PER_CARD));
        assert_eq!(c["store_per_draft_byte_num"].as_u64(), Some(STORE_PER_DRAFT_BYTE_NUM));
        assert_eq!(c["store_per_draft_byte_den"].as_u64(), Some(STORE_PER_DRAFT_BYTE_DEN));
        assert_eq!(c["partition_ceiling_bytes"].as_u64(), Some(PARTITION_CEILING_BYTES));
    }

    #[test]
    fn choices_match_the_reference() {
        let v = vectors();
        let drafts = drafts_of(&v);
        for expected in v["choices"].as_array().expect("choices") {
            let ceiling = expected["ceiling"].as_u64().unwrap();
            let got = choose_partition_count(&drafts, ceiling);
            assert_eq!(u64::from(got.n), expected["n"].as_u64().unwrap(), "n at ceiling {ceiling}");
            assert_eq!(got.largest, expected["largest"].as_u64().unwrap(), "largest at ceiling {ceiling}");
            assert_eq!(u64::from(got.largest_at), expected["largest_at"].as_u64().unwrap());
            assert_eq!(got.clamped, expected["clamped"].as_bool().unwrap());
            assert_eq!(got.cards, v["cards"].as_u64().unwrap());
            assert_eq!(got.framed_bytes, v["framed_bytes"].as_u64().unwrap());
            let projected: Vec<u64> =
                expected["projected"].as_array().unwrap().iter().map(|p| p.as_u64().unwrap()).collect();
            assert_eq!(got.projected, projected, "projection at ceiling {ceiling}");
        }
    }

    #[test]
    fn an_empty_corpus_is_the_floor() {
        let c = choose_partition_count(&[], PARTITION_CEILING_BYTES);
        assert_eq!((c.n, c.clamped, c.cards), (MIN_PARTITIONS, false, 0));
    }
}
