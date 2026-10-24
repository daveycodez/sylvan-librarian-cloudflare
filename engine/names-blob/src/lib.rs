//! The corpus-wide card-names blob's FORMAT (backlog n8, n15; format 3 for the wake): its parsers and
//! format 3's encoder — one crate, compiled into BOTH wasm modules.
//!
//! The query engine (engine/wasm, names.rs) reads the blob and answers autocomplete, name-only
//! searches and fuzzy plans from it; the import module (engine/wasm-import) is what both
//! publishers run to turn the format-2 blob `encodeCardNames` writes into format 3
//! (`names_blob_v3`). So the encoder and the reader are the same source, and the nightly and the
//! deploy seeders write the same bytes.
//!
//! This crate holds the TABLES and nothing that answers a question: what a load builds from a
//! blob of any format (`NameList`), and how format 3 stores what a format-2 load builds.

use card_engine::{CLASS_EXTRA_GATE, FuzzyProbe, FuzzySignature};

/// Format 1's first line: `<collated>\t<printed>\n` per served pair. Read for autocomplete only —
/// a build published before n15 names such a blob, and its index answers nothing (the router then
/// asks every partition, as it did).
pub const NAMES_BLOB_HEADER: &str = "sylvan-card-names/1\n";
/// Format 2's first line: one card record per line (`card_engine::name_records_tsv`, led by its
/// partition). Any other first line is refused, so a format change is a new tag and an older
/// object falls back instead of misreading it.
pub const NAMES_BLOB_HEADER_V2: &str = "sylvan-card-names/2\n";
/// Format 3's first line: format 2's records with everything a load used to rebuild from them
/// already built — see [`NameList::encode_v3`] for the layout. Binary after this line, so a reader
/// that knows only formats 1 and 2 refuses it on the header, as it refuses any other.
pub const NAMES_BLOB_HEADER_V3: &str = "sylvan-card-names/3\n";

/// A byte range of one of the list's strings.
pub type Span = (u32, u32);

/// Format 3's `shape` bits: the lower name is `printed.to_lowercase()` (format 2's empty lower
/// field), and the folded name IS the lower name (its empty folded field). Neither is written out.
const SHAPE_LOWER_IS_PRINTED_LOWERCASED: u8 = 1;
const SHAPE_FOLDED_IS_LOWER: u8 = 2;

/// One line of the blob: a card (formats 2 and 3) or a served pair (format 1). Read-only outside
/// this crate: every span was checked against its string when the list was parsed.
pub struct Entry {
    /// Into `collated` (the joined haystack), without its `\n`.
    pub collated: Span,
    /// Into `text`.
    pub printed: Span,
    /// Into `derived` (formats 2 and 3).
    pub lower: Span,
    pub folded: Span,
    /// Formats 2 and 3; format 1 reads every entry as served.
    pub partition: u16,
    pub classes: u8,
    pub best: u8,
    /// `flavor[flavor_from .. flavor_from + flavor_len]`.
    pub flavor_from: u32,
    pub flavor_len: u32,
}

/// The decoded blob: its text, its entries, and what the autocomplete scan precomputes.
pub struct NameList {
    format: u8,
    /// Formats 1 and 2: the raw blob, which the printed and flavor spans point into. Format 3: the
    /// printed names and flavor keys alone, entry by entry.
    text: String,
    /// Formats 2 and 3: every lower and folded name, written out (format 2 elides the derivable ones).
    derived: String,
    entries: Vec<Entry>,
    /// Every entry's flavor keys (formats 2 and 3): a span into `text` and the key's `CLASS_*` bits.
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
    /// Formats 2 and 3: each entry's typo-stage signature (`FuzzyProbe::signature` of its folded
    /// name), so a fuzzy plan scores only the names that can clear the floor (`FuzzyProbe::could_clear`).
    signatures: Vec<FuzzySignature>,
}

/// A little-endian column reader over format 3's tables, refusing to read past the blob.
struct Columns<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Columns<'a> {
    fn take(&mut self, len: usize, what: &str) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(len).filter(|&end| end <= self.bytes.len());
        let Some(end) = end else {
            return Err(format!("card names blob (format 3) ends inside its {what}"));
        };
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn u32(&mut self, what: &str) -> Result<u32, String> {
        let b = self.take(4, what)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u8s(&mut self, n: usize, what: &str) -> Result<&'a [u8], String> {
        self.take(n, what)
    }

    fn u16s(&mut self, n: usize, what: &str) -> Result<Vec<u16>, String> {
        let b = self.take(n.checked_mul(2).ok_or("card names blob (format 3): a column past usize")?, what)?;
        Ok(b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())
    }

    fn string(&mut self, len: usize, what: &str) -> Result<String, String> {
        let b = self.take(len, what)?;
        std::str::from_utf8(b).map(str::to_owned).map_err(|e| format!("card names blob (format 3): its {what} is not UTF-8: {e}"))
    }
}

/// The next `\n`-ended string of a format-3 section at `at`, as a span without its `\n`; `at` moves
/// past it. A line break is ASCII, so both ends of the span are character boundaries.
fn next_line(s: &str, at: &mut usize, what: &str) -> Result<Span, String> {
    let start = *at;
    let Some(len) = s.as_bytes().get(start..).and_then(|rest| memchr::memchr(b'\n', rest)) else {
        return Err(format!("card names blob (format 3): its section ends before a {what}"));
    };
    *at = start + len + 1;
    Ok((start as u32, (start + len) as u32))
}

/// What a name's distinct window count usually is: one window per character and one more (the
/// count is smaller only when a window repeats). Format 3 stores each count as its distance from this.
fn slack_base(collated: &str) -> u16 {
    (collated.chars().count() as u16).wrapping_add(1)
}

fn put_u16s(out: &mut Vec<u8>, column: impl Iterator<Item = u16>) {
    for v in column {
        out.extend_from_slice(&v.to_le_bytes());
    }
}

fn hex(field: &str, line: usize) -> Result<u32, String> {
    u32::from_str_radix(field, 16).map_err(|_| format!("card names line {line}: {field:?} is not hex"))
}

impl NameList {
    /// Parse a raw (inflated) blob of any format.
    pub fn parse(raw: Vec<u8>) -> Result<Self, String> {
        if raw.starts_with(NAMES_BLOB_HEADER_V3.as_bytes()) {
            return Self::parse_v3(&raw);
        }
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
            let (s, t) = list.entries[i].collated;
            let name = &list.text[s as usize..t as usize];
            if name.contains('\n') {
                return Err(format!("card names line {} has a line break in its collated name", i + 1));
            }
            let start = collated.len() as u32;
            starts.push(start);
            collated.push_str(name);
            // From here the entry's collated name is read from the haystack, as format 3 reads it.
            list.entries[i].collated = (start, collated.len() as u32);
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

    /// Format 3 (raw, uncompressed) of a format-2 blob's list: the same records, in the same order,
    /// with what a load used to spend its time building from them already built — the sort-and-
    /// dedupe window counts behind the autocomplete trigram counts and the typo-stage signatures,
    /// the joined collated haystack, and every record split into columns — by the code that builds
    /// them for a format-2 load, so a format-3 load checks and copies instead.
    ///
    /// Little-endian; every string is UTF-8 ending in `\n` (no name holds one), in entry order:
    ///
    /// ```text
    /// "sylvan-card-names/3\n"
    /// u32 entries, u32 flavor keys, u32 |collated|, u32 |text|, u32 |derived|
    /// collated  per entry: its collated name (the autocomplete haystack, as a load holds it)
    /// text      per entry: its printed name, then its flavor keys' names
    /// derived   per entry: its lower name unless SHAPE_LOWER_IS_PRINTED_LOWERCASED, then its folded
    ///           name unless SHAPE_FOLDED_IS_LOWER — format 2's two elisions, kept
    /// u16 partition[entries]   u8 classes[entries]   u8 best[entries]   u8 shape[entries]
    /// u16 flavor_keys[entries] u8 key_bits[keys]
    /// u16 trigram_slack[entries]     chars(collated) + 1 - |collated_trigrams(collated)|
    /// u16 signature_slack[entries]   FuzzySignature::trigrams XOR the trigram count
    /// ```
    ///
    /// The two window counts are stored as their distance from what they usually are, so both
    /// columns are mostly zeros. Two derivations are left to the load because they are linear
    /// and their bytes are not small: an elided lower name (`printed.to_lowercase()`, as format 2
    /// derives it) and the signature's hash bits ([`FuzzyProbe::signature_bits`], one pass with no
    /// window set — the SET, which only the count needs, is what cost). The tests pin a format-3
    /// load table for table against a format-2 load of the same records, fixture and real corpus.
    pub fn encode_v3(&self) -> Result<Vec<u8>, String> {
        if self.format != 2 {
            return Err(format!("card names: format {} has no format-3 form (only format 2 does)", self.format));
        }
        let n = self.entries.len();
        let line = |out: &mut String, s: &str, what: &str| -> Result<(), String> {
            if s.contains('\n') {
                return Err(format!("card names: a {what} holds a line break: {s:?}"));
            }
            out.push_str(s);
            out.push('\n');
            Ok(())
        };
        let (mut text, mut derived) = (String::with_capacity(self.text.len() / 2), String::with_capacity(self.derived.len()));
        let (mut shape, mut keys) = (Vec::with_capacity(n), Vec::with_capacity(n));
        let mut key_bits = Vec::with_capacity(self.flavor.len());
        for e in &self.entries {
            let printed = self.at(e.printed);
            line(&mut text, printed, "printed name")?;
            let flavor = self.flavor_of(e);
            keys.push(u16::try_from(flavor.len()).map_err(|_| format!("card names: {} flavor keys on one card", flavor.len()))?);
            for (key, bits) in flavor {
                line(&mut text, key, "flavor key")?;
                key_bits.push(bits);
            }
            let (lower, folded) = (self.at_derived(e.lower), self.at_derived(e.folded));
            let mut s = 0u8;
            if lower == printed.to_lowercase() {
                s |= SHAPE_LOWER_IS_PRINTED_LOWERCASED;
            } else {
                line(&mut derived, lower, "lower name")?;
            }
            if folded == lower {
                s |= SHAPE_FOLDED_IS_LOWER;
            } else {
                line(&mut derived, folded, "folded name")?;
            }
            shape.push(s);
        }
        let mut trigram_slack = Vec::with_capacity(n);
        let mut signature_slack = Vec::with_capacity(n);
        for i in 0..n {
            let count = u16::try_from(self.trigram_counts[i]).map_err(|_| format!("card names: {} trigrams", self.trigram_counts[i]))?;
            trigram_slack.push(slack_base(self.pair(i).0).wrapping_sub(count));
            signature_slack.push(self.signatures[i].trigrams ^ count);
        }
        let u32_of = |len: usize, what: &str| u32::try_from(len).map_err(|_| format!("card names: a {what} of {len}"));
        let mut out = Vec::with_capacity(NAMES_BLOB_HEADER_V3.len() + 20 + self.collated.len() + text.len() + derived.len() + n * 10);
        out.extend_from_slice(NAMES_BLOB_HEADER_V3.as_bytes());
        for (len, what) in [
            (n, "entry count"),
            (self.flavor.len(), "flavor key count"),
            (self.collated.len(), "collated section"),
            (text.len(), "text section"),
            (derived.len(), "derived section"),
        ] {
            out.extend_from_slice(&u32_of(len, what)?.to_le_bytes());
        }
        out.extend_from_slice(self.collated.as_bytes());
        out.extend_from_slice(text.as_bytes());
        out.extend_from_slice(derived.as_bytes());
        put_u16s(&mut out, self.entries.iter().map(|e| e.partition));
        out.extend(self.entries.iter().map(|e| e.classes));
        out.extend(self.entries.iter().map(|e| e.best));
        out.extend_from_slice(&shape);
        put_u16s(&mut out, keys.into_iter());
        out.extend_from_slice(&key_bits);
        put_u16s(&mut out, trigram_slack.into_iter());
        put_u16s(&mut out, signature_slack.into_iter());
        Ok(out)
    }

    /// Read a format-3 blob ([`encode_v3`](Self::encode_v3)): every length checked against the blob
    /// and every string against its section, then the tables copied. No window set is built.
    fn parse_v3(raw: &[u8]) -> Result<Self, String> {
        let mut c = Columns { bytes: raw, at: NAMES_BLOB_HEADER_V3.len() };
        let n = c.u32("entry count")? as usize;
        let nf = c.u32("flavor key count")? as usize;
        let (collated_len, text_len, derived_len) =
            (c.u32("collated section")? as usize, c.u32("text section")? as usize, c.u32("derived section")? as usize);
        let collated = c.string(collated_len, "collated section")?;
        let text = c.string(text_len, "text section")?;
        let stored = c.string(derived_len, "derived section")?;
        let partition = c.u16s(n, "partitions")?;
        let classes = c.u8s(n, "classes")?;
        let best = c.u8s(n, "best flags")?;
        let shape = c.u8s(n, "shapes")?;
        let keys = c.u16s(n, "flavor key counts")?;
        let key_bits = c.u8s(nf, "flavor key bits")?;
        let trigram_slack = c.u16s(n, "trigram counts")?;
        let signature_slack = c.u16s(n, "signature window counts")?;
        if c.at != raw.len() {
            return Err(format!("card names blob (format 3) holds {} bytes past its tables", raw.len() - c.at));
        }
        let (mut at_collated, mut at_text, mut at_stored) = (0usize, 0usize, 0usize);
        let mut derived = String::with_capacity(stored.len() + text.len());
        let mut entries = Vec::with_capacity(n);
        let mut flavor = Vec::with_capacity(nf);
        let mut collated_starts = Vec::with_capacity(n);
        let mut trigram_counts = Vec::with_capacity(n);
        let mut signatures = Vec::with_capacity(n);
        for i in 0..n {
            let name = next_line(&collated, &mut at_collated, "collated name")?;
            collated_starts.push(name.0);
            let count = slack_base(&collated[name.0 as usize..name.1 as usize]).wrapping_sub(trigram_slack[i]);
            trigram_counts.push(u32::from(count));
            let printed = next_line(&text, &mut at_text, "printed name")?;
            let flavor_from = flavor.len() as u32;
            for _ in 0..keys[i] {
                let Some(&bits) = key_bits.get(flavor.len()) else {
                    return Err("card names blob (format 3): more flavor keys than its key table".to_owned());
                };
                let (s, t) = next_line(&text, &mut at_text, "flavor key")?;
                flavor.push((s, t, bits));
            }
            let start = derived.len() as u32;
            if shape[i] & SHAPE_LOWER_IS_PRINTED_LOWERCASED != 0 {
                derived.push_str(&text[printed.0 as usize..printed.1 as usize].to_lowercase());
            } else {
                let (s, t) = next_line(&stored, &mut at_stored, "lower name")?;
                derived.push_str(&stored[s as usize..t as usize]);
            }
            let lower = (start, derived.len() as u32);
            let folded = if shape[i] & SHAPE_FOLDED_IS_LOWER != 0 {
                lower
            } else {
                let (s, t) = next_line(&stored, &mut at_stored, "folded name")?;
                let start = derived.len() as u32;
                derived.push_str(&stored[s as usize..t as usize]);
                (start, derived.len() as u32)
            };
            signatures.push(FuzzySignature {
                trigrams: signature_slack[i] ^ count,
                bits: FuzzyProbe::signature_bits(&derived[folded.0 as usize..folded.1 as usize]),
            });
            entries.push(Entry {
                collated: name,
                printed,
                lower,
                folded,
                partition: partition[i],
                classes: classes[i],
                best: best[i],
                flavor_from,
                flavor_len: flavor.len() as u32 - flavor_from,
            });
        }
        if at_collated != collated.len() || at_text != text.len() || at_stored != stored.len() || flavor.len() != nf {
            return Err("card names blob (format 3): its sections hold strings no entry names".to_owned());
        }
        if u32::try_from(derived.len()).is_err() {
            return Err("card names blob (format 3): its derived names pass what a u32 offset addresses".to_owned());
        }
        derived.shrink_to_fit();
        Ok(NameList { format: 3, text, derived, entries, flavor, trigram_counts, collated, collated_starts, signatures })
    }

    /// Whether two lists hold the same tables, read as every question reads them: each entry's
    /// strings, flags, partition and flavor keys, the haystack and its starts, the trigram counts and
    /// the signatures — everything but where in its sections a string happens to sit, which is the
    /// one thing formats 2 and 3 lay out differently. `Err` names the first difference.
    pub fn same_tables(&self, other: &NameList) -> Result<(), String> {
        if self.entries.len() != other.entries.len() {
            return Err(format!("{} entries against {}", self.entries.len(), other.entries.len()));
        }
        if self.collated != other.collated || self.collated_starts != other.collated_starts {
            return Err("the collated haystacks differ".to_owned());
        }
        if self.trigram_counts != other.trigram_counts {
            return Err("the trigram counts differ".to_owned());
        }
        if self.signatures != other.signatures {
            let at = self.signatures.iter().zip(&other.signatures).position(|(a, b)| a != b);
            return Err(format!("the signatures differ, first at entry {at:?}"));
        }
        for (i, (a, b)) in self.entries.iter().zip(&other.entries).enumerate() {
            let row = |l: &NameList, e: &Entry| {
                (
                    l.at_collated(e.collated).to_owned(),
                    l.at(e.printed).to_owned(),
                    l.at_derived(e.lower).to_owned(),
                    l.at_derived(e.folded).to_owned(),
                    e.partition,
                    e.classes,
                    e.best,
                    l.flavor_of(e).into_iter().map(|(k, bits)| (k.to_owned(), bits)).collect::<Vec<_>>(),
                )
            };
            let (ra, rb) = (row(self, a), row(other, b));
            if ra != rb {
                return Err(format!("entry {i} differs: {ra:?} against {rb:?}"));
            }
        }
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The blob's format: 1 (autocomplete only), 2 or 3 (the names index too).
    pub fn format(&self) -> u8 {
        self.format
    }

    /// Every entry, in the blob's order.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Every entry's flavor keys: a span into the text and the key's `CLASS_*` bits.
    pub fn flavor(&self) -> &[(u32, u32, u8)] {
        &self.flavor
    }

    /// Every collated name, each followed by `\n`, in entry order (the autocomplete haystack).
    pub fn collated(&self) -> &str {
        &self.collated
    }

    /// Where entry i's collated name starts in [`collated`](Self::collated), ascending.
    pub fn collated_starts(&self) -> &[u32] {
        &self.collated_starts
    }

    /// `|collated_trigrams(collated)|` per entry.
    pub fn trigram_counts(&self) -> &[u32] {
        &self.trigram_counts
    }

    /// Each entry's typo-stage signature (formats 2 and 3; empty for format 1).
    pub fn signatures(&self) -> &[FuzzySignature] {
        &self.signatures
    }

    pub fn at(&self, (start, end): Span) -> &str {
        &self.text[start as usize..end as usize]
    }

    pub fn at_derived(&self, (start, end): Span) -> &str {
        &self.derived[start as usize..end as usize]
    }

    pub fn at_collated(&self, (start, end): Span) -> &str {
        &self.collated[start as usize..end as usize]
    }

    /// Entry `i` as `(collated, printed)`.
    pub fn pair(&self, i: usize) -> (&str, &str) {
        let e = &self.entries[i];
        (self.at_collated(e.collated), self.at(e.printed))
    }

    /// Whether entry `i` is a card autocomplete may offer: one with a served printing.
    pub fn served(&self, i: usize) -> bool {
        self.entries[i].classes & CLASS_EXTRA_GATE != 0
    }

    /// Entry `i`'s flavor keys with their bits.
    pub fn flavor_of(&self, e: &Entry) -> Vec<(&str, u8)> {
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
