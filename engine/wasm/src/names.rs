//! `/cards/autocomplete` from ONE engine object (backlog n8).
//!
//! A partition's archive holds a tenth of the corpus's names, so the engine's own
//! `BufferStore::autocomplete` can only answer for a tenth, and the router used to ask every
//! partition and merge (partitioned-engine.ts `mergeAutocomplete`): N calls per keystroke, answered
//! when the slowest object replied. This module answers for the whole corpus from the published
//! card-names blob instead — every served `(collated, printed)` pair of every partition — so one
//! object answers alone.
//!
//! THE RANKING IS A LINE-FOR-LINE COPY of vendor `BufferStore::autocomplete` (card_engine
//! core_api.rs): the same collated needle and two-character gate, the same prefix/contains rank, the
//! same distinct `pg_trgm` windows and cross-multiplied similarity, the same printed-name tiebreak,
//! the same dedupe after sorting. The two differences are the input, and neither changes an answer:
//!
//!   - The candidates are the blob's pairs, scanned whole, where the engine narrows through its
//!     trigram index first. The index only ever narrows to a SUPERSET of the names containing the
//!     needle (every window of a contained needle is a window of the name), and both sides then keep
//!     exactly the names that start with or contain it.
//!   - The extras gate has already run: the blob holds the cards with a served printing and no
//!     others (`autocomplete_names_of`), which is the set the engine's per-card check lets through.
//!     The engine's last tiebreak, the card id, only ever orders two entries with the same printed
//!     name, and the dedupe keeps one of them either way.
//!
//! A THIRD COPY IS A DRIFT RISK, and the tests below are what hold it: a fixture-sized differential
//! (`cargo test`, CI) against the single store AND against the partitioned fan-out's merge, and the
//! real-corpus one in tests/engine/autocomplete-names-real.test.ts.

use std::io::Read;

/// The blob's first line. A reader refuses anything else, so a format change is a new tag and an
/// older object falls back to the fan-out instead of misreading it.
pub const NAMES_BLOB_HEADER: &str = "sylvan-card-names/1\n";

/// The decoded blob: its text, where each pair sits in it, and each name's trigram count.
pub struct NameList {
    text: String,
    /// `(start, tab, end)` byte offsets per line: collated = text[start..tab], printed = text[tab+1..end].
    spans: Vec<(u32, u32, u32)>,
    /// `|collated_trigrams(collated)|` per pair — the needle-independent half of the similarity,
    /// computed once at load instead of on every hit of every keystroke.
    trigram_counts: Vec<u32>,
    /// Every collated name, each followed by `\n`, in pair order — ONE haystack for the needle, so a
    /// keystroke is a single SIMD substring search instead of ~34k small ones. A collated name is
    /// alphanumerics only, so neither it nor any needle can hold the separator, and no match can span
    /// two names.
    collated: String,
    /// Where pair i's collated name starts in `collated`, ascending.
    collated_starts: Vec<u32>,
}

impl NameList {
    /// Parse a raw (inflated) blob: the header line, then `<collated>\t<printed>\n` lines.
    pub fn parse(raw: Vec<u8>) -> Result<Self, String> {
        let text = String::from_utf8(raw).map_err(|e| format!("card names blob is not UTF-8: {e}"))?;
        let Some(body) = text.strip_prefix(NAMES_BLOB_HEADER) else {
            let first = text.lines().next().unwrap_or("").chars().take(40).collect::<String>();
            return Err(format!("card names blob starts {first:?}, not {:?}", NAMES_BLOB_HEADER.trim_end()));
        };
        if u32::try_from(text.len()).is_err() {
            return Err(format!("card names blob is {} bytes, past what a u32 offset addresses", text.len()));
        }
        let mut spans = Vec::with_capacity(body.len() / 32);
        let mut at = NAMES_BLOB_HEADER.len();
        for line in body.split_terminator('\n') {
            let Some(tab) = line.find('\t') else {
                return Err(format!("card names line {} has no tab: {line:?}", spans.len() + 1));
            };
            if line[tab + 1..].contains('\t') {
                return Err(format!("card names line {} has two tabs: {line:?}", spans.len() + 1));
            }
            spans.push((at as u32, (at + tab) as u32, (at + line.len()) as u32));
            at += line.len() + 1;
        }
        if !body.is_empty() && !body.ends_with('\n') {
            return Err("card names blob does not end in a line break (truncated?)".to_owned());
        }
        let mut list = NameList {
            text,
            spans,
            trigram_counts: Vec::new(),
            collated: String::new(),
            collated_starts: Vec::new(),
        };
        let n = list.len();
        let mut collated = String::with_capacity(list.text.len() / 2);
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
        Ok(list)
    }

    /// Inflate a gzip blob (as KV and the object's cache hold it) and parse it.
    pub fn from_gzip(gz: &[u8]) -> Result<Self, String> {
        let mut raw = Vec::with_capacity(gz.len() * 3);
        flate2::read::MultiGzDecoder::new(gz)
            .read_to_end(&mut raw)
            .map_err(|e| format!("card names blob does not inflate: {e}"))?;
        Self::parse(raw)
    }

    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    /// Pair `i` as `(collated, printed)`.
    fn pair(&self, i: usize) -> (&str, &str) {
        let (start, tab, end) = self.spans[i];
        (&self.text[start as usize..tab as usize], &self.text[tab as usize + 1..end as usize])
    }

    /// Bytes held: the text plus the two tables — what a load adds to linear memory.
    pub fn heap_bytes(&self) -> usize {
        self.text.capacity()
            + self.spans.capacity() * std::mem::size_of::<(u32, u32, u32)>()
            + self.trigram_counts.capacity() * std::mem::size_of::<u32>()
            + self.collated.capacity()
            + self.collated_starts.capacity() * std::mem::size_of::<u32>()
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
        // The extras gate ran at build time (the blob holds served cards only); the dedupe is the
        // engine's: one entry per distinct printed name.
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
}
