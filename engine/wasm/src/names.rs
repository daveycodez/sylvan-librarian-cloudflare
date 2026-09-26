//! The corpus-wide card-names blob, answered from ONE engine object (backlog n8; the names index,
//! backlog n15).
//!
//! A partition's archive holds a tenth of the corpus's names, so the engine's own
//! `BufferStore::autocomplete` can only answer for a tenth, and the router used to ask every
//! partition and merge (partitioned-engine.ts `mergeAutocomplete`): N calls per keystroke, answered
//! when the slowest object replied. This module answers for the whole corpus from the published
//! card-names blob instead, so one object answers alone. Since format 2 the blob holds one RECORD
//! per card of every partition (card_engine `NameRecord`: its partition, its names, the printing
//! classes it and its flavor keys fall in), and the same object also tells a name-only
//! `/cards/search` and `/cards/named?fuzzy=` WHICH partitions can answer ([`search_partitions`],
//! [`fuzzy_plan`]) — usually one or two, often none, where every one of them was asked before.
//!
//! THE AUTOCOMPLETE RANKING IS A LINE-FOR-LINE COPY of vendor `BufferStore::autocomplete` (card_engine
//! core_api.rs): the same collated needle and two-character gate, the same prefix/contains rank, the
//! same distinct `pg_trgm` windows and cross-multiplied similarity, the same printed-name tiebreak,
//! the same dedupe after sorting. The two differences are the input, and neither changes an answer:
//!
//!   - The candidates are the blob's records, scanned whole, where the engine narrows through its
//!     trigram index first. The index only ever narrows to a SUPERSET of the names containing the
//!     needle (every window of a contained needle is a window of the name), and both sides then keep
//!     exactly the names that start with or contain it.
//!   - The extras gate runs on the records' served bit (format 1 held the served cards alone): the
//!     cards with a served printing, which is the set the engine's per-card check lets through.
//!     The engine's last tiebreak, the card id, only ever orders two entries with the same printed
//!     name, and the dedupe keeps one of them either way.
//!
//! A THIRD COPY IS A DRIFT RISK, and the tests below are what hold it: a fixture-sized differential
//! (`cargo test`, CI) against the single store AND against the partitioned fan-out's merge, and the
//! real-corpus one in tests/engine/autocomplete-names-real.test.ts.
//!
//! THE NAMES INDEX COPIES NOTHING. Its predicates are the engine's (`NameQuery`, `FuzzyProbe`,
//! `NamesProbe` in card_engine's `names_index`); this module only walks the records and collects
//! partitions. Its answers are pinned against the partitions' own by the fixture differentials below
//! and the real-corpus ones in tests/engine/names-index-real.test.ts.

use std::io::Read;

use card_engine::{
    BEST_ART_SERIES, BEST_NO_CONTAINMENT, CLASS_EXTRA_GATE, FuzzyProbe, FuzzySignature, KEY_SERVED, KEY_SERVED_OUTSIDE_CONTAINMENT, NameQuery,
    NameRecordView, NamesProbe,
};

/// Format 1's first line: `<collated>\t<printed>\n` per served pair. Read for autocomplete only —
/// a build published before n15 names such a blob, and its index answers nothing (the router then
/// asks every partition, as it did).
pub const NAMES_BLOB_HEADER: &str = "sylvan-card-names/1\n";
/// Format 2's first line: one card record per line (`card_engine::name_records_tsv`, led by its
/// partition). Any other first line is refused, so a format change is a new tag and an older
/// object falls back instead of misreading it.
pub const NAMES_BLOB_HEADER_V2: &str = "sylvan-card-names/2\n";

/// A byte range of one of the list's two strings.
type Span = (u32, u32);

/// One line of the blob: a card (format 2) or a served pair (format 1).
struct Entry {
    /// Into `text`.
    collated: Span,
    printed: Span,
    /// Into `derived` (format 2 only).
    lower: Span,
    folded: Span,
    /// Format 2 only; format 1 reads every entry as served.
    partition: u16,
    classes: u8,
    best: u8,
    /// `flavor[flavor_from .. flavor_from + flavor_len]`.
    flavor_from: u32,
    flavor_len: u32,
}

/// The decoded blob: its text, its entries, and what the autocomplete scan precomputes.
pub struct NameList {
    format: u8,
    text: String,
    /// Format 2: every lower and folded name, written out (the blob elides the derivable ones).
    derived: String,
    entries: Vec<Entry>,
    /// Every entry's flavor keys (format 2): a span into `text` and the key's `CLASS_*` bits.
    flavor: Vec<(u32, u32, u8)>,
    /// `|collated_trigrams(collated)|` per entry — the needle-independent half of the similarity,
    /// computed once at load instead of on every hit of every keystroke.
    trigram_counts: Vec<u32>,
    /// Every collated name, each followed by `\n`, in entry order — ONE haystack for the needle, so a
    /// keystroke is a single SIMD substring search instead of ~39k small ones. A collated name is
    /// alphanumerics only, so neither it nor any needle can hold the separator, and no match can span
    /// two names.
    collated: String,
    /// Where entry i's collated name starts in `collated`, ascending.
    collated_starts: Vec<u32>,
    /// Format 2: each entry's typo-stage signature (`FuzzyProbe::signature` of its folded name), so a
    /// fuzzy plan scores only the names that can clear the floor (`FuzzyProbe::could_clear`).
    signatures: Vec<FuzzySignature>,
}

fn hex(field: &str, line: usize) -> Result<u32, String> {
    u32::from_str_radix(field, 16).map_err(|_| format!("card names line {line}: {field:?} is not hex"))
}

impl NameList {
    /// Parse a raw (inflated) blob of either format.
    pub fn parse(raw: Vec<u8>) -> Result<Self, String> {
        let text = String::from_utf8(raw).map_err(|e| format!("card names blob is not UTF-8: {e}"))?;
        let (format, header) = if text.starts_with(NAMES_BLOB_HEADER) {
            (1u8, NAMES_BLOB_HEADER)
        } else if text.starts_with(NAMES_BLOB_HEADER_V2) {
            (2u8, NAMES_BLOB_HEADER_V2)
        } else {
            let first = text.lines().next().unwrap_or("").chars().take(40).collect::<String>();
            return Err(format!("card names blob starts {first:?}, not a card-names header"));
        };
        if u32::try_from(text.len()).is_err() {
            return Err(format!("card names blob is {} bytes, past what a u32 offset addresses", text.len()));
        }
        let body = &text[header.len()..];
        if !body.is_empty() && !body.ends_with('\n') {
            return Err("card names blob does not end in a line break (truncated?)".to_owned());
        }
        let mut entries: Vec<Entry> = Vec::with_capacity(body.len() / 40);
        let mut flavor: Vec<(u32, u32, u8)> = Vec::new();
        let mut derived = String::with_capacity(if format == 2 { body.len() / 2 } else { 0 });
        let mut at = header.len();
        for line in body.split_terminator('\n') {
            let n = entries.len() + 1;
            let span = |field: &str| -> Span {
                let start = field.as_ptr() as usize - text.as_ptr() as usize;
                (start as u32, (start + field.len()) as u32)
            };
            let fields: Vec<&str> = line.split('\t').collect();
            let entry = if format == 1 {
                let [collated, printed] = fields[..] else {
                    return Err(format!("card names line {n} is not one tab between two names: {line:?}"));
                };
                Entry {
                    collated: span(collated),
                    printed: span(printed),
                    lower: (0, 0),
                    folded: (0, 0),
                    partition: 0,
                    classes: CLASS_EXTRA_GATE,
                    best: 0,
                    flavor_from: 0,
                    flavor_len: 0,
                }
            } else {
                let [partition, flags, collated, printed, lower, folded, keys] = fields[..] else {
                    return Err(format!("card names line {n} does not hold 7 fields: {line:?}"));
                };
                let partition = partition.parse::<u16>().map_err(|_| format!("card names line {n}: bad partition {partition:?}"))?;
                if flags.len() != 3 {
                    return Err(format!("card names line {n}: bad flags {flags:?}"));
                }
                let (classes, best) = (hex(&flags[..2], n)? as u8, hex(&flags[2..], n)? as u8);
                let push = |derived: &mut String, s: &str| -> Span {
                    let start = derived.len() as u32;
                    derived.push_str(s);
                    (start, derived.len() as u32)
                };
                let lower = if lower.is_empty() { push(&mut derived, &printed.to_lowercase()) } else { push(&mut derived, lower) };
                let folded = if folded.is_empty() { lower } else { push(&mut derived, folded) };
                let flavor_from = flavor.len() as u32;
                if !keys.is_empty() {
                    for key in keys.split(',') {
                        let Some((name, bits)) = key.rsplit_once(':') else {
                            return Err(format!("card names line {n}: bad flavor key {key:?}"));
                        };
                        let (start, end) = span(name);
                        flavor.push((start, end, hex(bits, n)? as u8));
                    }
                }
                Entry {
                    collated: span(collated),
                    printed: span(printed),
                    lower,
                    folded,
                    partition,
                    classes,
                    best,
                    flavor_from,
                    flavor_len: flavor.len() as u32 - flavor_from,
                }
            };
            entries.push(entry);
            at += line.len() + 1;
        }
        debug_assert_eq!(at, text.len());
        // Every table at its final size: a load's linear memory is held for the life of the build.
        entries.shrink_to_fit();
        flavor.shrink_to_fit();
        derived.shrink_to_fit();
        let mut list = NameList {
            format,
            text,
            derived,
            entries,
            flavor,
            trigram_counts: Vec::new(),
            collated: String::new(),
            collated_starts: Vec::new(),
            signatures: Vec::new(),
        };
        let n = list.len();
        let joined: usize = list.entries.iter().map(|e| (e.collated.1 - e.collated.0) as usize + 1).sum();
        let mut collated = String::with_capacity(joined);
        let mut starts = Vec::with_capacity(n);
        let mut counts = Vec::with_capacity(n);
        let mut windows: Vec<[char; 3]> = Vec::with_capacity(64);
        for i in 0..n {
            let name = list.pair(i).0;
            if name.contains('\n') {
                return Err(format!("card names line {} has a line break in its collated name", i + 1));
            }
            starts.push(collated.len() as u32);
            collated.push_str(name);
            collated.push('\n');
            // The distinct-window count `collated_trigrams(name).len()` gives, by sort and dedupe.
            windows.clear();
            if !name.is_empty() {
                let mut window = [' ', ' ', ' '];
                for c in name.chars().chain(std::iter::once(' ')) {
                    window = [window[1], window[2], c];
                    windows.push(window);
                }
            }
            windows.sort_unstable();
            windows.dedup();
            counts.push(windows.len() as u32);
        }
        list.collated = collated;
        list.collated_starts = starts;
        list.trigram_counts = counts;
        if list.format == 2 {
            list.signatures = list.entries.iter().map(|e| FuzzyProbe::signature(list.at_derived(e.folded))).collect();
        }
        // The inflate over-reserves; the spans are offsets, so the text can move.
        list.text.shrink_to_fit();
        Ok(list)
    }

    /// Inflate a gzip blob (as KV and the object's cache hold it) and parse it.
    pub fn from_gzip(gz: &[u8]) -> Result<Self, String> {
        let mut raw = Vec::with_capacity(gz.len() * 4);
        flate2::read::MultiGzDecoder::new(gz)
            .read_to_end(&mut raw)
            .map_err(|e| format!("card names blob does not inflate: {e}"))?;
        Self::parse(raw)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The blob's format: 1 (autocomplete only) or 2 (the names index too).
    pub fn format(&self) -> u8 {
        self.format
    }

    fn at(&self, (start, end): Span) -> &str {
        &self.text[start as usize..end as usize]
    }

    fn at_derived(&self, (start, end): Span) -> &str {
        &self.derived[start as usize..end as usize]
    }

    /// Entry `i` as `(collated, printed)`.
    fn pair(&self, i: usize) -> (&str, &str) {
        let e = &self.entries[i];
        (self.at(e.collated), self.at(e.printed))
    }

    /// Whether entry `i` is a card autocomplete may offer: one with a served printing.
    fn served(&self, i: usize) -> bool {
        self.entries[i].classes & CLASS_EXTRA_GATE != 0
    }

    /// Entry `i`'s flavor keys with their bits.
    fn flavor_of(&self, e: &Entry) -> Vec<(&str, u8)> {
        self.flavor[e.flavor_from as usize..(e.flavor_from + e.flavor_len) as usize]
            .iter()
            .map(|&(s, t, bits)| (self.at((s, t)), bits))
            .collect()
    }

    /// Bytes held: the two strings plus the tables — what a load adds to linear memory.
    pub fn heap_bytes(&self) -> usize {
        self.text.capacity()
            + self.derived.capacity()
            + self.entries.capacity() * std::mem::size_of::<Entry>()
            + self.flavor.capacity() * std::mem::size_of::<(u32, u32, u8)>()
            + self.trigram_counts.capacity() * std::mem::size_of::<u32>()
            + self.collated.capacity()
            + self.collated_starts.capacity() * std::mem::size_of::<u32>()
            + self.signatures.capacity() * std::mem::size_of::<FuzzySignature>()
    }
}

/// `collate_name` (card_engine lib.rs), verbatim: the folded lowercase string with every
/// non-alphanumeric character removed.
fn collate_name(folded_lower: &str) -> String {
    folded_lower.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// `collated_trigrams` (card_engine core_api.rs), verbatim: the DISTINCT `pg_trgm` windows of
/// `"  " + collated + " "`, as chars.
fn collated_trigrams(collated: &str, out: &mut Vec<[char; 3]>) {
    out.clear();
    if collated.is_empty() {
        return;
    }
    let mut window = [' ', ' ', ' '];
    for c in collated.chars().chain(std::iter::once(' ')) {
        window = [window[1], window[2], c];
        if !out.contains(&window) {
            out.push(window);
        }
    }
}

/// `|A ∩ B|` for the needle's distinct windows A and the name's B, without building B: a needle
/// window counts once if it occurs among the name's windows at all, which is what membership in the
/// distinct set means. Equal, window for window, to the engine's
/// `name_tg.iter().filter(|t| needle_tg.contains(t)).count()` — both count the distinct windows the
/// two strings share — at a handful of comparisons instead of a dedupe per hit.
fn shared_windows(needle_tg: &[[char; 3]], collated: &str, seen: &mut Vec<bool>) -> u32 {
    seen.clear();
    seen.resize(needle_tg.len(), false);
    let mut window = [' ', ' ', ' '];
    for c in collated.chars().chain(std::iter::once(' ')) {
        window = [window[1], window[2], c];
        if let Some(j) = needle_tg.iter().position(|t| *t == window) {
            seen[j] = true;
        }
    }
    seen.iter().filter(|s| **s).count() as u32
}

/// `BufferStore::autocomplete` over the blob — see the module comment for the two input
/// differences and why neither changes an answer. `prefix` is what the route passes the engine
/// (already lowercased and accent-folded), and it is collated here exactly as there.
///
/// Three costs are moved, never changed: the substring test is one memchr `memmem` search over
/// every collated name joined (on valid UTF-8 a byte match is exactly `str::contains`, and the
/// separator cannot be matched), the similarity's intersection counts shared windows without
/// building the name's set (`shared_windows`), and each name's trigram count comes from the table
/// the load filled. Measured on the real corpus (33,603 pairs, bun, one wasm instance): the
/// per-name form of the engine's loop cost 1.2–2.7ms a needle; this is 0.23ms for a long needle,
/// 0.42ms at three characters and 1.0ms at two (thousands of hits to rank), 0.25ms averaged over
/// the real-corpus differential's 6,350 needles — against 0.35ms of engine CPU the fan-out spent
/// summed over ten partitions, before counting its ten Durable Object requests.
pub fn autocomplete(names: &NameList, prefix: &str, limit: usize) -> Vec<String> {
    let needle = collate_name(&prefix.to_lowercase());
    if needle.chars().count() < 2 {
        return Vec::new();
    }
    let mut needle_tg: Vec<[char; 3]> = Vec::with_capacity(needle.len() + 1);
    collated_trigrams(&needle, &mut needle_tg);
    let finder = memchr::memmem::Finder::new(needle.as_bytes());
    // (rank, |name ∩ needle|, |name|, printed name, index) — the engine's tuple, with the pair's
    // index where it has the card id.
    let mut hits: Vec<(u8, u32, u32, &str, u32)> = Vec::new();
    let mut seen: Vec<bool> = Vec::with_capacity(needle_tg.len());
    // Every name the needle occurs in — the engine's `starts_with || contains` — found by ONE search
    // over the joined collated names; a name matched twice is taken once.
    let mut last = usize::MAX;
    for at in finder.find_iter(names.collated.as_bytes()) {
        let i = names.collated_starts.partition_point(|&s| s as usize <= at) - 1;
        if i == last {
            continue;
        }
        last = i;
        // The extras gate: a card with no served printing is never offered (format 1 held no such
        // card; format 2 holds every card and says which are served).
        if !names.served(i) {
            continue;
        }
        let (collated, printed) = names.pair(i);
        let rank = if collated.starts_with(&needle) { 0u8 } else { 1u8 };
        let inter = shared_windows(&needle_tg, collated, &mut seen);
        hits.push((rank, inter, names.trigram_counts[i], printed, i as u32));
    }
    let qn = needle_tg.len() as u64;
    let union = |inter: u32, total: u32| qn + u64::from(total) - u64::from(inter);
    let order = |a: &(u8, u32, u32, &str, u32), b: &(u8, u32, u32, &str, u32)| {
        a.0.cmp(&b.0)
            .then_with(|| (u64::from(b.1) * union(a.1, a.2)).cmp(&(u64::from(a.1) * union(b.1, b.2))))
            .then_with(|| a.3.cmp(b.3))
            .then_with(|| a.4.cmp(&b.4))
    };
    // The engine sorts every hit; only the head is ever read. The order is TOTAL (the index breaks
    // every tie), so the `head` smallest hits, sorted, are exactly the full sort's first `head` —
    // and when they hold `limit` distinct printed names the answer is decided by them alone. A head
    // with too many repeats to fill the limit falls back to the full sort, so this is never a
    // different answer, only a cheaper one for a two-letter needle with thousands of hits.
    let head = limit.saturating_mul(4).max(limit + 16);
    if hits.len() > head {
        let _ = hits.select_nth_unstable_by(head - 1, order);
        hits[..head].sort_unstable_by(order);
        let mut distinct: Vec<&str> = Vec::with_capacity(limit);
        for hit in &hits[..head] {
            if !distinct.contains(&hit.3) {
                distinct.push(hit.3);
            }
            if distinct.len() == limit {
                break;
            }
        }
        if distinct.len() == limit {
            hits.truncate(head);
        } else {
            hits.sort_unstable_by(order);
        }
    } else {
        hits.sort_unstable_by(order);
    }
    let mut out: Vec<String> = Vec::with_capacity(limit.min(hits.len()));
    for (_, _, _, printed, _) in hits {
        // The extras gate ran in the scan (served cards only); the dedupe is the engine's: one entry
        // per distinct printed name.
        if out.iter().any(|n| n == printed) {
            continue;
        }
        out.push(printed.to_owned());
        if out.len() == limit {
            break;
        }
    }
    out
}

// ─── The names index (backlog n15) ────────────────────────────────────────────

/// The partitions holding a card a name-only search matches, ascending — or None for a format-1
/// blob, which has no index. An `Err` is the engine's own refusal (a regex that exhausted its budget
/// over the corpus's names); the caller then asks every partition, which reports it or answers.
///
/// EXACT, not merely a superset, for every canonical row space (see `NameQuery::card_matches`): the
/// partitions named are exactly those whose gather would return a row, so an empty answer IS the
/// search's 404. With `include_multilingual` the class read is every printing, a superset.
pub fn search_partitions(
    names: &NameList,
    query: &NameQuery,
    multilingual: bool,
) -> Option<Result<Vec<u16>, card_engine::EngineError>> {
    if names.format < 2 {
        return None;
    }
    let bit = query.class_bit(multilingual);
    Some(query.scan(|q| {
        let mut found: std::collections::BTreeSet<u16> = std::collections::BTreeSet::new();
        for e in &names.entries {
            if found.contains(&e.partition) {
                continue;
            }
            let flavor = if e.flavor_len == 0 { Vec::new() } else { names.flavor_of(e) };
            let view =
                NameRecordView { collated: names.at(e.collated), lower: names.at_derived(e.lower), classes: e.classes, flavor: &flavor };
            if q.card_matches(&view, bit) {
                found.insert(e.partition);
            }
        }
        found.into_iter().collect()
    }))
}

/// Which partitions `/cards/named?fuzzy=` must ask so that merging their bundles
/// (`mergeNamedFuzzyBundles`, every other partition read as answering nothing) gives exactly the
/// answer every partition's bundles give.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FuzzyPlan {
    /// Ascending.
    pub partitions: Vec<u16>,
    /// The containment stage may have to read foreign printed names, which the blob does not
    /// carry: every partition must be asked.
    pub everywhere: bool,
    /// Which stage decided the set — for the log line: "exact", "typo", "contained", "miss".
    pub stage: &'static str,
}

/// The fuzzy route's plan for one needle, or None for a format-1 blob. `folded` and `words` are what
/// the route hands every partition's bundle; `floor`, `lead` and `weak_below` are the thresholds it
/// hands them (`lead` as the router's merge compares it, a JS number).
///
/// Stage by stage, with the reason each partition set is enough (a partition left out must answer
/// NOTHING the merge reads at that stage):
///
///   1. EXACT. Every partition holding a card whose name keys `exact=`'s scan matches
///      (`NamesProbe::names_card`) or a flavor key that IS the needle. When one of those cards
///      is not an art series, a rank is certain, the exact merge over these partitions is the
///      answer, and nothing else is asked.
///   2. TYPO. Every partition holding a CONTENDER: a typo-pool card (not an art series) whose
///      `FuzzyProbe` score is within `lead` of the best score anywhere — the one test the merge's
///      race makes (`best - runner < lead`). The winner is among them, and no card outside can
///      tie it or make it ambiguous.
///   3. CONTAINMENT, when the best score is weak or there is none. Every partition holding a card
///      whose names carry every word (the oracle name, or pooled with its flavor keys), and every
///      partition holding a card of the same name (the merge dedupes by name). Sound only when an
///      English-tier answer is CERTAIN, because only then are the foreign printed names, which the
///      blob does not carry, dropped by the merge's English tier. Otherwise `everywhere`. Certain
///      means one of: a card whose oracle name alone carries every word, its best printing in the
///      containment pool (the oracle pass answers it); or a flavor key carried by a served printing
///      and by none outside the pool (so the flavor pass answers it through whichever served
///      printing it picks) that carries every word alone — or pooled with its card's name, when no
///      other card carries that key (so the printing the pass picks is that card's).
pub fn fuzzy_plan(
    names: &NameList,
    folded: &str,
    words: &[String],
    floor: f32,
    lead: f64,
    weak_below: f32,
) -> Option<FuzzyPlan> {
    if names.format < 2 {
        return None;
    }
    let probe = NamesProbe::new(folded, words);
    let mut asked: std::collections::BTreeSet<u16> = std::collections::BTreeSet::new();
    let plan = |asked: std::collections::BTreeSet<u16>, everywhere: bool, stage: &'static str| FuzzyPlan {
        partitions: asked.into_iter().collect(),
        everywhere,
        stage,
    };

    let mut exact_certain = false;
    for e in &names.entries {
        let flavor_named = e.flavor_len > 0 && names.flavor_of(e).iter().any(|(key, _)| probe.names_key(key));
        if probe.names_card(names.at_derived(e.folded), names.at(e.collated)) {
            asked.insert(e.partition);
            exact_certain |= e.best & BEST_ART_SERIES == 0;
        } else if flavor_named {
            asked.insert(e.partition);
        }
    }
    if exact_certain {
        return Some(plan(asked, false, "exact"));
    }

    let mut scored: Vec<(f32, u16)> = Vec::new();
    if let Some(mut fuzzy) = FuzzyProbe::new(folded) {
        for (e, &signature) in names.entries.iter().zip(&names.signatures) {
            if e.best & BEST_ART_SERIES != 0 || !fuzzy.could_clear(signature, floor) {
                continue;
            }
            if let Some(score) = fuzzy.score(names.at_derived(e.folded), floor) {
                scored.push((score, e.partition));
            }
        }
    }
    let best = scored.iter().map(|(s, _)| *s).fold(None, |m: Option<f32>, s| Some(m.map_or(s, |m| m.max(s))));
    if let Some(best) = best {
        for &(score, p) in &scored {
            if f64::from(best) - f64::from(score) < lead {
                asked.insert(p);
            }
        }
        if best >= weak_below {
            return Some(plan(asked, false, "typo"));
        }
    }

    if !probe.has_words() {
        return Some(plan(asked, false, if best.is_some() { "typo" } else { "miss" }));
    }
    let mut english_certain = false;
    let mut carriers: std::collections::HashSet<&str> = std::collections::HashSet::new();
    // How many cards carry each flavor key: a key only one card carries pools with that card's name.
    let mut key_cards: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for &(s, t, _) in &names.flavor {
        *key_cards.entry(names.at((s, t))).or_default() += 1;
    }
    for e in &names.entries {
        let name = names.at_derived(e.folded);
        let oracle = probe.contains_all(name);
        english_certain |= oracle && e.best & BEST_NO_CONTAINMENT == 0;
        let keys = if e.flavor_len > 0 { names.flavor_of(e) } else { Vec::new() };
        english_certain |= keys.iter().any(|&(key, bits)| {
            bits & KEY_SERVED != 0
                && bits & KEY_SERVED_OUTSIDE_CONTAINMENT == 0
                && (probe.contains_all(key)
                    || (key_cards.get(key) == Some(&1) && probe.contains_all_pooled([key, name].into_iter())))
        });
        let carried =
            oracle || (!keys.is_empty() && probe.contains_all_pooled(std::iter::once(name).chain(keys.iter().map(|(k, _)| *k))));
        if carried {
            asked.insert(e.partition);
            carriers.insert(name);
        }
    }
    if !english_certain {
        return Some(plan(asked, true, "contained"));
    }
    for e in &names.entries {
        if carriers.contains(names.at_derived(e.folded)) {
            asked.insert(e.partition);
        }
    }
    Some(plan(asked, false, "contained"))
}

/// The raw blob for a set of pairs — what `src/engine/card-names.ts` `encodeCardNames` writes
/// (dedupe, sort, header). For tests; production blobs are only ever encoded in TypeScript. The
/// order does not affect any answer (the ranking sorts), only the bytes.
#[cfg(test)]
pub fn encode_for_tests(pairs: &[(String, String)]) -> Vec<u8> {
    let mut lines: Vec<String> = pairs.iter().map(|(c, p)| format!("{c}\t{p}\n")).collect();
    lines.sort();
    lines.dedup();
    let mut out = NAMES_BLOB_HEADER.as_bytes().to_vec();
    for line in lines {
        out.extend_from_slice(line.as_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use card_engine::{BufferStore, StoreBuilder, StoreStats};
    use serde_json::{Value, json};

    /// A catalog row the loader accepts: one canonical English printing of a named card.
    fn row(name: &str, oracle: &str, scryfall: &str) -> Value {
        json!({
            "card_name": name,
            "card_name_folded": fold(&name.to_lowercase()),
            "oracle_id": oracle,
            "scryfall_id": scryfall,
            "card_set_code": "tst",
            "set_name": "Test Set",
            "collector_number": "1",
            "oracle_text": "Do a thing.",
            "type_line": "Instant",
            "card_types": ["Instant"],
            "card_legalities": {"vintage": "legal"},
            "card_colors": {"R": true},
            "card_color_identity": {"R": true},
            "card_layout": "normal",
            "prefer_score": 1.0,
        })
    }

    /// The importer's fold for the handful of accents the fixture uses.
    fn fold(lower: &str) -> String {
        lower.replace('é', "e").replace('û', "u").replace('ö', "o").replace('á', "a").replace('æ', "ae")
    }

    fn uuid(n: u32, tag: u8) -> String {
        format!("{tag:02x}{n:06x}-0000-4000-8000-000000000000")
    }

    /// The fixture corpus: names chosen for every rule the ranking has — accents, punctuation that
    /// collates away, a prefix that only exists collated, repeated windows, digits, split and long
    /// names, extras (a token-only card, a card with both a token and a served printing), a name two
    /// oracle ids share, and a crowd of prefix-sharing names so the limit bites.
    fn corpus() -> Vec<Value> {
        let mut rows = Vec::new();
        let mut n = 0u32;
        let mut add = |rows: &mut Vec<Value>, name: &str, extra: bool, shared_oracle: Option<u32>| {
            n += 1;
            let oracle = uuid(shared_oracle.unwrap_or(n), 0x0a);
            let mut r = row(name, &oracle, &uuid(n, 0x5c));
            if extra {
                r["card_is_tags"] = json!({"extra": true});
            }
            rows.push(r);
            n
        };
        for name in [
            "Lightning Bolt",
            "Lightning Angel",
            "Light Up the Night",
            "Lightning Helix",
            "Lim-Dûl's Vault",
            "Lim-Dûl the Necromancer",
            "Éowyn, Lady of Rohan",
            "Éomer, Marshal of Rohan",
            "Serra Avenger",
            "Serenity",
            "Serum Visions",
            "Serra Angel",
            "_____ Goblin",
            "Goblin Welder",
            "Gobsmacked",
            "Fire // Ice",
            "Who // What // When // Where // Why",
            "Jötun Grunt",
            "Æther Vial",
            "Aether Hub",
            "Shatter",
            "Shock",
            "Shapesharer",
            "Shambleshark",
            "Ajani, Caller of the Pride",
            "Ajani Goldmane",
            "B.F.M. (Big Furry Monster)",
            "Our Market Research Shows That Players Like Really Long Card Names So We Made this Card to Have the Absolute Longest Card Name Ever Elemental",
            "Borrowing 100,000 Arrows",
            "1996 World Champion",
            "Ancestral Recall",
            "Ancestral Vision",
            "Angel of Serenity",
            "Defang",
            "Chandra, Torch of Defiance",
            "Chandra's Outrage",
        ] {
            add(&mut rows, name, false, None);
        }
        // Enough `ang` names that a limit of 20 cuts the list.
        for i in 0..30 {
            add(&mut rows, &format!("Angelic Test {i:02}"), false, None);
        }
        // Extras: a token-only name, a memorabilia-style front card, and a name printed both as a
        // token and as a served card (one oracle id, two printings).
        add(&mut rows, "Shark", true, None);
        add(&mut rows, "Lightning", true, None);
        let shatter_token = add(&mut rows, "Shatter Token Card", true, None);
        add(&mut rows, "Shatter Token Card", false, Some(shatter_token));
        // Two cards, one printed name (different oracle ids): one suggestion.
        add(&mut rows, "Twin Name", false, None);
        add(&mut rows, "Twin Name", false, None);
        rows
    }

    fn build(rows: &[Value]) -> (BufferStore, StoreStats) {
        let mut builder = StoreBuilder::new();
        for r in rows {
            builder.add_card(r).expect("fixture row");
        }
        let mut bytes = Vec::new();
        let stats = builder.finish_to_writer(&mut bytes).expect("build");
        (BufferStore::from_bytes(&bytes).expect("load"), stats)
    }

    /// The fixture cut into `k` stores by the production partition function.
    fn partitions(rows: &[Value], k: u32) -> Vec<(BufferStore, StoreStats)> {
        (0..k)
            .map(|p| {
                let part: Vec<Value> = rows
                    .iter()
                    .filter(|r| {
                        card_engine::partition_of_oracle_id(r["oracle_id"].as_str().expect("oracle"), k) == p
                    })
                    .cloned()
                    .collect();
                build(&part)
            })
            .collect()
    }

    /// `mergeAutocomplete` (src/engine/partitioned-engine.ts) as the Rust differential in core_api
    /// spells it: the key recomputed from the printed names. The fixture's accents are folded the
    /// way the TypeScript `foldAccents` folds them.
    fn merge(lists: &[Vec<String>], prefix: &str, limit: usize) -> Vec<String> {
        let collate = |s: &str| collate_name(&fold(&s.to_lowercase()));
        let needle = collate(prefix);
        let mut needle_tg = Vec::new();
        collated_trigrams(&needle, &mut needle_tg);
        let score = |name: &str| {
            let mut tg = Vec::new();
            collated_trigrams(&collate(name), &mut tg);
            let inter = tg.iter().filter(|t| needle_tg.contains(t)).count() as u64;
            (inter, needle_tg.len() as u64 + tg.len() as u64 - inter)
        };
        let mut all: Vec<String> = Vec::new();
        for list in lists {
            for name in list {
                if !all.contains(name) {
                    all.push(name.clone());
                }
            }
        }
        let rank = |name: &str| u8::from(!collate(name).starts_with(&needle));
        all.sort_by(|a, b| {
            let ((ia, ua), (ib, ub)) = (score(a), score(b));
            rank(a).cmp(&rank(b)).then_with(|| (ib * ua).cmp(&(ia * ub))).then_with(|| a.cmp(b))
        });
        all.truncate(limit);
        all
    }

    /// Every two-character needle over the fixture's alphabet, every substring of every name up to
    /// six characters, and the adversarial shapes: accents, punctuation, separators, digits, a
    /// one-letter needle that only looks two long, and needles nothing contains.
    fn needles(rows: &[Value]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let alphabet: Vec<char> = ('a'..='z').chain('0'..='9').collect();
        for a in &alphabet {
            for b in &alphabet {
                out.push(format!("{a}{b}"));
            }
        }
        for r in rows {
            let collated = collate_name(&fold(&r["card_name"].as_str().expect("name").to_lowercase()));
            let chars: Vec<char> = collated.chars().collect();
            for len in 3..=6 {
                for start in 0..chars.len().saturating_sub(len - 1) {
                    out.push(chars[start..start + len].iter().collect());
                }
            }
        }
        for s in [
            "lim-dul", "limdul", "lim dûl", "eowyn", "éowyn", "jotun", "ningbolt", "_____", "_____ g", "gob", "a",
            "a.", "a ", "", "  ", "--", "fire // ice", "fireice", "//", "100,000", "100", "1996", "bfm", "b.f.m.",
            "zzzz", "qx", "ser", "lig", "ang", "sha", "aeth", "æther", "twin", "twin name", "shatter", "shark",
        ] {
            out.push(s.to_owned());
        }
        out.sort();
        out.dedup();
        out
    }

    /// THE CI DIFFERENTIAL: the blob answer equals the single store's, AND the partitioned
    /// fan-out's merge, for every needle and at two limits — at partition counts 1, 3 and 7.
    #[test]
    fn names_blob_answers_what_the_store_and_the_fan_out_answer() {
        let rows = corpus();
        let (single, _) = build(&rows);
        let needles = needles(&rows);
        assert!(needles.len() > 1500, "the needle set is the point: {}", needles.len());
        for k in [1u32, 3, 7] {
            let parts = partitions(&rows, k);
            let pairs: Vec<(String, String)> =
                parts.iter().flat_map(|(_, stats)| stats.autocomplete_names.iter().cloned()).collect();
            let names = NameList::parse(encode_for_tests(&pairs)).expect("blob");
            let mut answered = 0;
            for needle in &needles {
                for limit in [20usize, 3] {
                    let got = autocomplete(&names, needle, limit);
                    assert_eq!(got, single.autocomplete(needle, limit), "k={k} {needle:?} limit {limit}: single store");
                    let lists: Vec<Vec<String>> = parts.iter().map(|(s, _)| s.autocomplete(needle, limit)).collect();
                    assert_eq!(got, merge(&lists, needle, limit), "k={k} {needle:?} limit {limit}: fan-out merge");
                    answered += usize::from(!got.is_empty());
                }
            }
            assert!(answered > 1000, "k={k}: most needles must answer something, or this proves nothing ({answered})");
        }
    }

    /// The names a build publishes are exactly the ones its archive's own reader finds — the
    /// build-time extraction and the archived twin agree, pair for pair, on every partition.
    #[test]
    fn build_time_names_equal_the_archived_names() {
        let rows = corpus();
        for k in [1u32, 3] {
            for (store, stats) in partitions(&rows, k) {
                assert_eq!(stats.autocomplete_names, store.autocomplete_names(), "k={k}");
            }
        }
        let (_, stats) = build(&rows);
        let printed: Vec<&str> = stats.autocomplete_names.iter().map(|(_, p)| p.as_str()).collect();
        assert!(!printed.contains(&"Shark") && !printed.contains(&"Lightning"), "extras-only cards are not offered");
        assert!(printed.contains(&"Shatter Token Card"), "a card with any served printing is offered");
        assert_eq!(printed.iter().filter(|p| **p == "Twin Name").count(), 1, "one pair per distinct (collated, printed)");
        assert!(stats.autocomplete_names.contains(&("eowynladyofrohan".to_owned(), "Éowyn, Lady of Rohan".to_owned())));
        assert!(stats.autocomplete_names.iter().any(|(c, p)| p.len() > 61 && c.len() > 57), "a long name whole");
    }

    /// The two moved costs, pinned to what they replace: the window intersection and the trigram
    /// count against the engine's own computation, over every fixture name and needle.
    #[test]
    fn the_moved_costs_compute_what_the_engine_computes() {
        let rows = corpus();
        let names: Vec<String> = rows
            .iter()
            .map(|r| collate_name(&fold(&r["card_name"].as_str().expect("name").to_lowercase())))
            .collect();
        let mut seen = Vec::new();
        let (mut needle_tg, mut name_tg) = (Vec::new(), Vec::new());
        for needle in needles(&rows).iter().map(|n| collate_name(&n.to_lowercase())).filter(|n| n.chars().count() >= 2) {
            collated_trigrams(&needle, &mut needle_tg);
            for name in &names {
                collated_trigrams(name, &mut name_tg);
                let engine = name_tg.iter().filter(|t| needle_tg.contains(t)).count() as u32;
                assert_eq!(shared_windows(&needle_tg, name, &mut seen), engine, "{needle:?} in {name:?}");
                assert_eq!(
                    memchr::memmem::find(name.as_bytes(), needle.as_bytes()).is_some(),
                    name.contains(&needle),
                    "{needle:?} in {name:?}"
                );
            }
        }
        let pairs: Vec<(String, String)> = names.iter().map(|n| (n.clone(), n.clone())).collect();
        let list = NameList::parse(encode_for_tests(&pairs)).expect("blob");
        for i in 0..list.len() {
            collated_trigrams(list.pair(i).0, &mut name_tg);
            assert_eq!(list.trigram_counts[i], name_tg.len() as u32);
        }
    }

    /// The engine's loop as it is written in core_api — per-name `starts_with`/`contains`, the
    /// distinct-window set built per hit, every hit sorted — over a blob's pairs. What the moved
    /// costs in `autocomplete` must answer exactly as.
    fn reference(names: &NameList, prefix: &str, limit: usize) -> Vec<String> {
        let needle = collate_name(&prefix.to_lowercase());
        if needle.chars().count() < 2 {
            return Vec::new();
        }
        let mut needle_tg = Vec::new();
        collated_trigrams(&needle, &mut needle_tg);
        let mut hits: Vec<(u8, u32, u32, &str, u32)> = Vec::new();
        let mut name_tg = Vec::new();
        for i in 0..names.len() {
            let (collated, printed) = names.pair(i);
            let rank = if collated.starts_with(&needle) {
                0u8
            } else if collated.contains(&needle) {
                1u8
            } else {
                continue;
            };
            collated_trigrams(collated, &mut name_tg);
            let inter = name_tg.iter().filter(|t| needle_tg.contains(t)).count() as u32;
            hits.push((rank, inter, name_tg.len() as u32, printed, i as u32));
        }
        let qn = needle_tg.len() as u64;
        let union = |inter: u32, total: u32| qn + u64::from(total) - u64::from(inter);
        hits.sort_unstable_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| (u64::from(b.1) * union(a.1, a.2)).cmp(&(u64::from(a.1) * union(b.1, b.2))))
                .then_with(|| a.3.cmp(b.3))
                .then_with(|| a.4.cmp(&b.4))
        });
        let mut out: Vec<String> = Vec::new();
        for (_, _, _, printed, _) in hits {
            if out.iter().any(|n| n == printed) {
                continue;
            }
            out.push(printed.to_owned());
            if out.len() == limit {
                break;
            }
        }
        out
    }

    /// The head selection, including the case it must hand back to the full sort: a head so full
    /// of one printed name (many cards, one name — collated spellings differ) that it cannot fill
    /// the limit. And a needle that occurs twice in one name, and at a name's very end.
    #[test]
    fn the_fast_scan_answers_the_engines_loop() {
        let mut pairs: Vec<(String, String)> = Vec::new();
        for i in 0..200 {
            pairs.push((format!("dup{i:03}ab"), "Duplicate Name".to_owned()));
        }
        for i in 0..60 {
            pairs.push((format!("ab{i:02}x"), format!("Other {i:02}")));
            pairs.push((format!("zzab{i:02}abab"), format!("Twice {i:02}")));
        }
        pairs.push(("ab".to_owned(), "Ab".to_owned()));
        pairs.push(("xab".to_owned(), "Xab".to_owned()));
        pairs.push((String::new(), "_____".to_owned()));
        let list = NameList::parse(encode_for_tests(&pairs)).expect("blob");
        for needle in ["ab", "dup", "du", "abab", "b0", "0ab", "x", "xab", "zzab", "ab00x", "nothing", "ba"] {
            for limit in [1usize, 3, 20, 40, 500] {
                assert_eq!(autocomplete(&list, needle, limit), reference(&list, needle, limit), "{needle:?} limit {limit}");
            }
        }
        let rows = corpus();
        let pairs: Vec<(String, String)> = build(&rows).1.autocomplete_names;
        let list = NameList::parse(encode_for_tests(&pairs)).expect("blob");
        for needle in needles(&rows) {
            assert_eq!(autocomplete(&list, &needle, 20), reference(&list, &needle, 20), "{needle:?}");
        }
    }

    #[test]
    fn a_blob_it_cannot_read_is_refused() {
        assert!(NameList::parse(b"sylvan-card-names/2\na\tA\n".to_vec()).is_err(), "another version");
        assert!(NameList::parse(b"sylvan-card-names/1\nab A\n".to_vec()).is_err(), "no tab");
        assert!(NameList::parse(b"sylvan-card-names/1\na\tb\tc\n".to_vec()).is_err(), "two tabs");
        assert!(NameList::parse(b"sylvan-card-names/1\nab\tAb".to_vec()).is_err(), "truncated");
        assert!(NameList::parse(vec![0xff, 0xfe]).is_err(), "not UTF-8");
        assert!(NameList::from_gzip(b"not gzip").is_err());
        let empty = NameList::parse(NAMES_BLOB_HEADER.as_bytes().to_vec()).expect("an empty corpus");
        assert!(empty.is_empty() && autocomplete(&empty, "ab", 20).is_empty());
    }

    // ─── The names index (backlog n15) ───────────────────────────────────────

    /// The format-2 blob for a set of partitions, as `encodeCardNames` writes it: every partition's
    /// record lines led by its number, deduplicated, sorted, under the format-2 header.
    fn encode_v2(parts: &[(BufferStore, StoreStats)]) -> Vec<u8> {
        let mut lines: Vec<String> = Vec::new();
        for (k, (_, stats)) in parts.iter().enumerate() {
            let tsv = card_engine::name_records_tsv(&format!("{k}\t"), &stats.name_records).expect("spellable");
            lines.extend(String::from_utf8(tsv).expect("utf-8").lines().map(|l| format!("{l}\n")));
        }
        lines.sort();
        lines.dedup();
        let mut out = NAMES_BLOB_HEADER_V2.as_bytes().to_vec();
        for line in lines {
            out.extend_from_slice(line.as_bytes());
        }
        out
    }

    /// A printing of `name` with extras, variation, flavor-name, face and language knobs.
    fn printing(name: &str, oracle: u32, scry: u32) -> Value {
        let mut r = row(name, &uuid(oracle, 0x0b), &uuid(scry, 0x5d));
        r["card_compat_blob"] = json!({"lang": "en"});
        r
    }

    fn tag(r: &mut Value, tags: &[&str]) {
        let mut m = serde_json::Map::new();
        for t in tags {
            m.insert((*t).to_owned(), json!(true));
        }
        r["card_is_tags"] = Value::Object(m);
    }

    fn flavor(r: &mut Value, name: &str) {
        r["flavor_name"] = json!(name);
        r["flavor_name_folded"] = json!(fold(&name.to_lowercase()));
    }

    fn foreign(r: &mut Value, lang: &str, printed: &str) {
        r["is_canonical"] = json!(false);
        r["card_compat_blob"] = json!({"lang": lang});
        r["printed_name"] = json!(printed);
        r["printed_name_folded"] = json!(fold(&printed.to_lowercase()));
    }

    /// Every printing class the index distinguishes, and every name the predicates read: the
    /// autocomplete corpus, plus variations, extras carrying and sharing names, flavor names on
    /// served, extra, variation and foreign printings, face-level flavor names, foreign printed
    /// names, an art series and an emblem.
    fn index_corpus() -> Vec<Value> {
        let mut rows = corpus();
        let mut scry = 10_000u32;
        let mut next = || {
            scry += 1;
            scry
        };
        let mut add = |rows: &mut Vec<Value>, name: &str, oracle: u32, edit: &dyn Fn(&mut Value)| {
            let mut r = printing(name, oracle, next());
            edit(&mut r);
            rows.push(r);
        };
        add(&mut rows, "Variant Card", 1, &|_| {});
        add(&mut rows, "Variant Card", 1, &|r| tag(r, &["variation"]));
        add(&mut rows, "Only Variation Bolt", 2, &|r| tag(r, &["variation"]));
        add(&mut rows, "Extra Bolt Token", 3, &|r| tag(r, &["extra"]));
        add(&mut rows, "Extra And Variation", 4, &|r| tag(r, &["extra", "variation"]));
        add(&mut rows, "Titanoth Rex", 5, &|_| {});
        add(&mut rows, "Titanoth Rex", 5, &|r| flavor(r, "Godzilla, Primeval Champion"));
        add(&mut rows, "Titanoth Rex", 5, &|r| {
            foreign(r, "ja", "タイタノス・レックス");
            flavor(r, "Kaiju Only Foreign");
        });
        add(&mut rows, "Food", 6, &|r| {
            tag(r, &["extra"]);
            r["card_layout"] = json!("token");
            flavor(r, "Lunch 1:00 PM");
        });
        add(&mut rows, "Crystalline Giant", 7, &|_| {});
        add(&mut rows, "Crystalline Giant", 7, &|r| {
            tag(r, &["variation"]);
            flavor(r, "Mechagodzilla, the Weapon");
        });
        add(&mut rows, "Voldaren Bloodcaster // Bloodbat Summoner", 8, &|r| {
            r["card_layout"] = json!("transform");
            r["card_faces"] = json!([
                {"name": "Voldaren Bloodcaster", "type_line": "Creature", "oracle_text": "", "colors": ["B"], "flavor_name": "Dracula, Lord of Blood"},
                {"name": "Bloodbat Summoner", "type_line": "Creature", "oracle_text": "", "colors": ["B"], "flavor_name": "Dracula, Lord of Bats"},
            ]);
        });
        add(&mut rows, "Unmoored Ego", 9, &|_| {});
        add(&mut rows, "Unmoored Ego", 9, &|r| foreign(r, "pt", "Ego à Deriva"));
        add(&mut rows, "Guile", 10, &|_| {});
        add(&mut rows, "Guile", 10, &|r| foreign(r, "it", "Inganno"));
        add(&mut rows, "Lightning Bolt // Lightning Bolt", 11, &|r| {
            tag(r, &["extra"]);
            r["card_layout"] = json!("art_series");
        });
        add(&mut rows, "Liliana Emblem", 12, &|r| {
            tag(r, &["extra"]);
            r["card_layout"] = json!("emblem");
        });
        add(&mut rows, "Bolt Foreign Only", 13, &|r| foreign(r, "de", "Blitz Nur"));
        rows
    }

    fn name_leaf(kind: &str, value: &str) -> Value {
        json!({ "node_type": "CardBinaryOperatorNode", "kwargs": { "op": ":",
            "lhs": { "node_type": "CardAttributeNode", "kwargs": { "attribute_name": "card_name", "original_attribute": "name" } },
            "rhs": { "node_type": kind, "kwargs": { "value": value } } } })
    }

    fn node(kind: &str, operands: Vec<Value>) -> Value {
        json!({ "node_type": kind, "kwargs": { "operands": operands } })
    }

    fn not_is(tag: &str) -> Value {
        json!({ "node_type": "NotNode", "kwargs": { "operand": { "node_type": "CardBinaryOperatorNode", "kwargs": {
            "lhs": { "node_type": "CardAttributeNode", "kwargs": { "attribute_name": "card_is_tags", "original_attribute": "is" } },
            "op": ":", "rhs": [tag] } } } })
    }

    /// The router's gate, as extras-gate.ts `withoutIsTags` writes it.
    fn gated(tree: &Value, extra: bool, variation: bool) -> Value {
        let mut ops = vec![tree.clone()];
        if extra {
            ops.push(not_is("extra"));
        }
        if variation {
            ops.push(not_is("variation"));
        }
        if ops.len() == 1 { tree.clone() } else { node("AndNode", ops) }
    }

    /// Name-only trees over the fixture: every leaf kind over substrings of its names and flavor
    /// names, and the combinations seek sends (AND of words) and a few it does not.
    fn name_trees() -> Vec<Value> {
        let words = [
            "bolt", "lightning", "ang", "serra", "godzilla", "primeval", "lunch", "mechagodzilla", "dracula", "lordofbats",
            "lordofblood", "draculalordofblooddraculalordofbats", "kaiju", "ego", "deriva", "inganno", "variant",
            "variation", "extra", "token", "emblem", "liliana", "titanoth", "rex", "zzzz", "q", "", "fireice", "whowhat",
            "eowyn", "limdul", "blitz", "foreign", "only", "card", "giant", "food", "1996", "100000",
        ];
        let mut trees: Vec<Value> = Vec::new();
        for w in words {
            trees.push(name_leaf("CollatedNameValueNode", w));
            trees.push(name_leaf("StringValueNode", w));
        }
        for re in ["^li", "bolt$", "o.*t", "(?:ego|rex)", "//", "^$", "[0-9]", "é", "^(?!s)"] {
            trees.push(name_leaf("RegexValueNode", re));
        }
        for (a, b) in [("lightning", "bolt"), ("godzilla", "rex"), ("dracula", "bats"), ("variant", "card"), ("ego", "zzzz")] {
            trees.push(node("AndNode", vec![name_leaf("CollatedNameValueNode", a), name_leaf("CollatedNameValueNode", b)]));
            trees.push(node("OrNode", vec![name_leaf("CollatedNameValueNode", a), name_leaf("RegexValueNode", b)]));
        }
        trees.push(node("AndNode", vec![
            name_leaf("CollatedNameValueNode", "titanoth"),
            node("OrNode", vec![name_leaf("CollatedNameValueNode", "primeval"), name_leaf("StringValueNode", "rex")]),
        ]));
        trees
    }

    /// THE SEARCH DIFFERENTIAL: for every name-only tree, every gate combination and both row
    /// spaces, the partitions the index names are EXACTLY the partitions whose own query returns a
    /// row (a superset under include_multilingual) — at partition counts 1, 3 and 7.
    #[test]
    fn the_index_names_exactly_the_partitions_a_name_search_answers_from() {
        let rows = index_corpus();
        let mut checked = 0;
        let mut empty = 0;
        for k in [1u32, 3, 7] {
            let parts = partitions(&rows, k);
            let names = NameList::parse(encode_v2(&parts)).expect("blob");
            assert_eq!(names.format(), 2);
            for tree in name_trees() {
                for (extra, variation) in [(true, true), (false, true), (true, false), (false, false)] {
                    for multilingual in [false, true] {
                        let tree = gated(&tree, extra, variation);
                        let query = card_engine::NameQuery::of(&tree).expect("a name-only tree");
                        let got = search_partitions(&names, &query, multilingual).expect("format 2").expect("no budget");
                        let opts = card_engine::QueryOptions { include_multilingual: multilingual, ..Default::default() };
                        let truth: Vec<u16> = (0..k as u16)
                            .filter(|&p| parts[p as usize].0.query_value(&tree, &opts).expect("query").total > 0)
                            .collect();
                        if multilingual {
                            assert!(truth.iter().all(|p| got.contains(p)), "k={k} {tree} ml: {got:?} misses {truth:?}");
                        } else {
                            assert_eq!(got, truth, "k={k} extra={extra} variation={variation} {tree}");
                        }
                        checked += 1;
                        empty += usize::from(truth.is_empty());
                    }
                }
            }
        }
        assert!(checked > 1000 && empty > 100 && empty < checked - 300, "{checked} checked, {empty} empty");
    }

    /// Anything that reads more than names is not an index question.
    #[test]
    fn only_name_trees_are_index_questions() {
        let oracle = json!({ "node_type": "CardBinaryOperatorNode", "kwargs": { "op": ":",
            "lhs": { "node_type": "CardAttributeNode", "kwargs": { "attribute_name": "oracle_text", "original_attribute": "o" } },
            "rhs": { "node_type": "StringValueNode", "kwargs": { "value": "draw" } } } });
        let bolt = name_leaf("CollatedNameValueNode", "bolt");
        assert!(card_engine::NameQuery::of(&bolt).is_some());
        assert!(card_engine::NameQuery::of(&gated(&bolt, true, true)).is_some());
        for tree in [
            oracle.clone(),
            node("AndNode", vec![bolt.clone(), oracle.clone()]),
            node("OrNode", vec![bolt.clone(), oracle]),
            json!({ "node_type": "NotNode", "kwargs": { "operand": bolt.clone() } }),
            json!({ "node_type": "ExactNameNode", "kwargs": { "value": "bolt" } }),
            json!({ "node_type": "TrueNode", "kwargs": {} }),
            gated(&json!({ "node_type": "TrueNode", "kwargs": {} }), true, true),
            not_is("extra"),
            name_leaf("RegexValueNode", "("),
            json!({ "node_type": "CardBinaryOperatorNode", "kwargs": { "op": "!=",
                "lhs": { "node_type": "CardAttributeNode", "kwargs": { "attribute_name": "card_name", "original_attribute": "name" } },
                "rhs": { "node_type": "CollatedNameValueNode", "kwargs": { "value": "bolt" } } } }),
        ] {
            assert!(card_engine::NameQuery::of(&tree).is_none(), "{tree}");
        }
        // A format-1 blob has no index.
        let pairs = vec![("bolt".to_owned(), "Bolt".to_owned())];
        let v1 = NameList::parse(encode_for_tests(&pairs)).expect("v1");
        assert!(search_partitions(&v1, &card_engine::NameQuery::of(&bolt).unwrap(), false).is_none());
        assert!(fuzzy_plan(&v1, "bolt", &["bolt".to_owned()], 0.625, 0.002, 0.71).is_none());
    }

    /// Build-time records equal the archived twin's, record for record, on every partition.
    #[test]
    fn build_time_name_records_equal_the_archived_records() {
        let rows = index_corpus();
        for k in [1u32, 3, 7] {
            for (store, stats) in partitions(&rows, k) {
                assert_eq!(stats.name_records, store.name_records(), "k={k}");
            }
        }
        let (_, stats) = build(&rows);
        let titanoth = stats.name_records.iter().find(|r| r.collated == "titanothrex").expect("titanoth");
        assert_eq!(
            titanoth.flavor,
            vec![
                ("godzillaprimevalchampion".to_owned(), 0x1f | card_engine::KEY_SERVED),
                ("kaijuonlyforeign".to_owned(), card_engine::CLASS_ANY | card_engine::KEY_SERVED),
            ]
        );
        let bloodcaster = stats.name_records.iter().find(|r| r.collated.starts_with("voldaren")).expect("dfc");
        assert_eq!(bloodcaster.flavor, vec![("draculalordofblooddraculalordofbats".to_owned(), 0x1f | card_engine::KEY_SERVED)]);
        let food = stats.name_records.iter().find(|r| r.collated == "food").expect("food");
        assert_eq!(food.flavor[0].1 & card_engine::KEY_SERVED, 0, "an extra's flavor name is no containment key");
        let art = stats.name_records.iter().find(|r| r.collated == "lightningboltlightningbolt").expect("art");
        assert_eq!(art.best, card_engine::BEST_ART_SERIES | card_engine::BEST_NO_CONTAINMENT);
        let emblem = stats.name_records.iter().find(|r| r.collated == "lilianaemblem").expect("emblem");
        assert_eq!(emblem.best, card_engine::BEST_NO_CONTAINMENT);
        let only_variation = stats.name_records.iter().find(|r| r.collated == "onlyvariationbolt").expect("variation");
        assert_eq!(only_variation.classes & card_engine::CLASS_BOTH_GATES, 0);
        assert_ne!(only_variation.classes & card_engine::CLASS_EXTRA_GATE, 0);
    }

    /// The autocomplete answer does not depend on the format: a format-2 blob of the same builds
    /// answers every needle exactly as the format-1 blob does.
    #[test]
    fn format_2_autocompletes_as_format_1() {
        let rows = index_corpus();
        for k in [1u32, 3] {
            let parts = partitions(&rows, k);
            let pairs: Vec<(String, String)> =
                parts.iter().flat_map(|(_, stats)| stats.autocomplete_names.iter().cloned()).collect();
            let v1 = NameList::parse(encode_for_tests(&pairs)).expect("v1");
            let v2 = NameList::parse(encode_v2(&parts)).expect("v2");
            for needle in needles(&rows) {
                for limit in [20usize, 3] {
                    assert_eq!(autocomplete(&v2, &needle, limit), autocomplete(&v1, &needle, limit), "k={k} {needle:?}");
                }
            }
        }
    }

    /// THE FUZZY PLAN'S CONTRACT, stage by stage, against every partition's own stage outputs: a
    /// partition the plan leaves out ranks nothing, holds no typo contender, and — when the
    /// containment stage is reached and the plan is not `everywhere` — answers containment with
    /// nothing, or only with cards the merge's English tier drops.
    #[test]
    fn the_fuzzy_plan_asks_every_partition_that_could_change_the_answer() {
        let rows = index_corpus();
        let (floor, lead, weak) = (0.625f32, 0.002f64, 0.71f32);
        let mut needles: Vec<String> = vec![
            "lightning bolt", "lightnin bolt", "bolt", "godzilla primeval", "godzilla, primeval champion", "lunch",
            "ego a deriva", "red goad", "inganno", "blitz nur", "blitz", "liliana emblem", "lili emblem", "serra",
            "seraa angel", "zzzzqq", "titanoth champion", "dracula lord of bats", "lord of bats", "mechagodzilla",
            "variant", "fire", "ice", "who", "angelic test", "angelic tset 1", "shatter", "twin name", "twin nam",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        for r in &rows {
            let name = fold(&r["card_name"].as_str().unwrap().to_lowercase());
            needles.push(name.clone());
            if name.len() > 4 {
                needles.push(format!("{}x{}", &name[..name.len() / 2], &name[name.len() / 2 + 1..]));
            }
        }
        needles.sort();
        needles.dedup();
        let mut stages = std::collections::BTreeMap::<&str, usize>::new();
        let mut asked = 0usize;
        let mut total = 0usize;
        for k in [3u32, 7] {
            let parts = partitions(&rows, k);
            let names = NameList::parse(encode_v2(&parts)).expect("blob");
            for folded in &needles {
                let words: Vec<String> =
                    folded.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '\'')).filter(|w| !w.is_empty()).map(str::to_owned).collect();
                let plan = fuzzy_plan(&names, folded, &words, floor, lead, weak).expect("format 2");
                *stages.entry(plan.stage).or_default() += 1;
                asked += if plan.everywhere { k as usize } else { plan.partitions.len() };
                total += k as usize;
                let left_out = |p: u16| !plan.everywhere && !plan.partitions.contains(&p);
                let ranks: Vec<bool> = parts.iter().map(|(s, _)| s.exact_name_rank(folded, None).is_some()).collect();
                if ranks.iter().any(|r| *r) {
                    for p in 0..k as u16 {
                        assert!(!(ranks[p as usize] && left_out(p)), "k={k} {folded:?}: p{p} ranks the needle but is left out");
                    }
                    continue;
                }
                let cands: Vec<(u16, f32)> = parts
                    .iter()
                    .enumerate()
                    .flat_map(|(p, (s, _))| s.fuzzy_candidates(folded, floor, 8).into_iter().map(move |c| (p as u16, c.score)))
                    .collect();
                let best = cands.iter().map(|c| c.1).fold(None, |m: Option<f32>, s| Some(m.map_or(s, |m| m.max(s))));
                for &(p, s) in &cands {
                    let contender = f64::from(best.unwrap()) - f64::from(s) < lead;
                    assert!(!(contender && left_out(p)), "k={k} {folded:?}: p{p} holds a contender ({s}) but is left out");
                }
                if best.is_some_and(|b| b >= weak) {
                    continue;
                }
                // Containment: a left-out partition's answers must all be foreign-tier (no English
                // name carrying every word) and share no name with an asked partition's answer.
                let answers: Vec<Vec<Value>> = parts
                    .iter()
                    .map(|(s, _)| {
                        s.cards_containing_all_words(&words, None, 2, Some(vec!["name".to_owned(), "flavor_name".to_owned()]))
                            .expect("contained")
                    })
                    .collect();
                let needles_stripped: Vec<String> =
                    words.iter().map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>()).filter(|w| !w.is_empty()).collect();
                let english = |card: &Value| {
                    let strip = |v: &Value| -> String {
                        fold(&v.as_str().unwrap_or("").to_lowercase()).chars().filter(|c| c.is_alphanumeric()).collect()
                    };
                    let pool = [strip(&card["name"]), strip(&card["flavor_name"])];
                    needles_stripped.iter().all(|w| pool.iter().any(|n| n.contains(w.as_str())))
                };
                let asked_names: Vec<&str> = (0..k as u16)
                    .filter(|&p| !left_out(p))
                    .flat_map(|p| answers[p as usize].iter().map(|c| c["name"].as_str().unwrap()))
                    .collect();
                let any_english = answers.iter().flatten().any(&english);
                for p in (0..k as u16).filter(|&p| left_out(p)) {
                    for card in &answers[p as usize] {
                        assert!(
                            any_english && !english(card) && !asked_names.contains(&card["name"].as_str().unwrap()),
                            "k={k} {folded:?}: left-out p{p} answers containment with {card}"
                        );
                    }
                }
            }
        }
        eprintln!("fuzzy plan stages {stages:?}; asked {asked} of {total} partition-needles");
        assert!(stages.len() >= 3 && asked * 2 < total, "the plan must prune: {stages:?}, {asked} of {total}");
    }

    /// The typo prefilter never skips a name the engine's score would clear, at any floor — and it
    /// skips most of the names that cannot, which is its only reason to exist.
    #[test]
    fn the_signature_prefilter_never_skips_a_clearing_name() {
        let rows = index_corpus();
        let names: Vec<String> = rows.iter().map(|r| fold(&r["card_name"].as_str().unwrap().to_lowercase())).collect();
        let mut needles: Vec<String> = needles(&rows);
        needles.extend(names.iter().map(|n| n.replace('a', "e")));
        let (mut skipped, mut scored) = (0usize, 0usize);
        for floor in [0.0f32, 0.3, 0.5, 0.625, 0.8] {
            for needle in &needles {
                let Some(mut probe) = FuzzyProbe::new(needle) else { continue };
                for name in &names {
                    let could = probe.could_clear(FuzzyProbe::signature(name), floor);
                    let cleared = probe.score(name, floor).is_some();
                    assert!(could || !cleared, "{needle:?} vs {name:?} at {floor}: skipped a clearing name");
                    if floor == 0.625 && could {
                        scored += 1;
                    } else if floor == 0.625 {
                        skipped += 1;
                    }
                }
            }
        }
        assert!(skipped > 2 * scored, "at the production floor the prefilter must prune: {skipped} skipped, {scored} scored");
    }
}
