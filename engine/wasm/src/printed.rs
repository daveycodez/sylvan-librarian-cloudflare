//! The printed-names blob (backlog x24): what ONE object needs to tell whether any partition's
//! containment stage could answer a `/cards/named?fuzzy=` needle through a FOREIGN printed name.
//!
//! The names index (names.rs `fuzzy_plan`) decides every fuzzy rule but that one — containment's
//! printed tier, where each word lands in a printed name or in its card's oracle name (`red goad`
//! is Unmoored Ego through the Portuguese "Ego à Deriva") — so a needle nothing English carries
//! was planned `everywhere`: every miss asked every partition. The blob holds each card's printed
//! names as card_engine's `PrintedRecord` cuts them (only what an ASCII query word can match),
//! one line per card led by its partition, and [`PrintedList::carriers`] answers which partitions
//! hold a card whose printed name completes the words. With the names index's own partitions that
//! is every partition whose containment can answer anything — none, for a sentence typed into the
//! name box, which is then Scryfall's 404 from the one object that planned it.
//!
//! Loaded only by an object whose plan reached that tier (src/engine/store.ts), never beside every
//! partition's store.

use std::io::Read;

/// The blob's first line. Any other is refused, so a format change is a new tag and an older
/// object answers as it did without the blob (every partition asked).
pub const PRINTED_BLOB_HEADER: &str = "sylvan-printed-names/1\n";

/// One searchable field of the blob: a card's oracle name or one of its printed forms.
#[derive(Clone, Copy)]
struct Field {
    /// Byte offset into `text`.
    start: u32,
    /// The card (line) it belongs to, with `ORACLE` set on the oracle-name field.
    card: u32,
    len: u16,
}

const ORACLE: u32 = 1 << 31;

/// The decoded blob.
pub struct PrintedList {
    /// The raw blob, header included; every field is a span of it.
    text: String,
    /// Every field, in text order (so sorted by `start`).
    fields: Vec<Field>,
    /// Each card's partition, by line.
    partitions: Vec<u16>,
    /// How many printed forms (non-oracle fields) the blob holds.
    printed: usize,
}

impl PrintedList {
    /// Parse a raw (inflated) blob.
    pub fn parse(raw: Vec<u8>) -> Result<Self, String> {
        let text = String::from_utf8(raw).map_err(|e| format!("printed names blob is not UTF-8: {e}"))?;
        if !text.starts_with(PRINTED_BLOB_HEADER) {
            let first = text.lines().next().unwrap_or("").chars().take(40).collect::<String>();
            return Err(format!("printed names blob starts {first:?}, not a printed-names header"));
        }
        if u32::try_from(text.len()).is_err() {
            return Err(format!("printed names blob is {} bytes, past what a u32 offset addresses", text.len()));
        }
        let body = &text[PRINTED_BLOB_HEADER.len()..];
        if !body.is_empty() && !body.ends_with('\n') {
            return Err("printed names blob does not end in a line break (truncated?)".to_owned());
        }
        let mut fields: Vec<Field> = Vec::with_capacity(body.len() / 16);
        let mut partitions: Vec<u16> = Vec::with_capacity(body.len() / 96);
        let mut printed = 0usize;
        for (n, line) in body.split_terminator('\n').enumerate() {
            let card = u32::try_from(partitions.len()).map_err(|_| "too many printed-name lines".to_owned())?;
            let mut parts = line.split('\t');
            let partition = parts
                .next()
                .and_then(|p| p.parse::<u16>().ok())
                .ok_or_else(|| format!("printed names line {}: bad partition in {line:?}", n + 1))?;
            let oracle = parts.next().ok_or_else(|| format!("printed names line {}: no oracle name", n + 1))?;
            let span = |field: &str| -> Result<(u32, u16), String> {
                let start = field.as_ptr() as usize - text.as_ptr() as usize;
                let len = u16::try_from(field.len()).map_err(|_| format!("printed names line {}: a field past 64KB", n + 1))?;
                Ok((start as u32, len))
            };
            let (start, len) = span(oracle)?;
            fields.push(Field { start, card: card | ORACLE, len });
            let before = fields.len();
            for form in parts {
                if form.is_empty() || !form.bytes().all(|b| b == b' ' || b.is_ascii_alphanumeric()) {
                    return Err(format!("printed names line {}: {form:?} is not a printed form", n + 1));
                }
                let (start, len) = span(form)?;
                fields.push(Field { start, card, len });
            }
            if fields.len() == before {
                return Err(format!("printed names line {}: a card with no printed name", n + 1));
            }
            printed += fields.len() - before;
            partitions.push(partition);
        }
        fields.shrink_to_fit();
        partitions.shrink_to_fit();
        Ok(PrintedList { text, fields, partitions, printed })
    }

    /// Inflate a gzip blob (as KV and the object's cache hold it) and parse it.
    pub fn from_gzip(gz: &[u8]) -> Result<Self, String> {
        let mut raw = Vec::with_capacity(gz.len() * 3);
        flate2::read::MultiGzDecoder::new(gz)
            .read_to_end(&mut raw)
            .map_err(|e| format!("printed names blob does not inflate: {e}"))?;
        Self::parse(raw)
    }

    /// Printed forms held (the load log line's count).
    pub fn len(&self) -> usize {
        self.printed
    }

    pub fn is_empty(&self) -> bool {
        self.printed == 0
    }

    /// Bytes held in linear memory.
    pub fn heap_bytes(&self) -> usize {
        self.text.capacity() + self.fields.capacity() * std::mem::size_of::<Field>() + self.partitions.capacity() * 2
    }

    /// The partitions holding a card one of whose printed forms, pooled with its oracle name,
    /// carries every one of `words` AND carries at least one of them itself — ascending. (A card
    /// whose oracle name carries them all is an ENGLISH carrier, which the names index names.)
    ///
    /// `words` are what the route hands the containment stage; each is cut to its alphanumerics
    /// (`strip_separators`) and the empty ones dropped, as the engine does. None when a word holds
    /// a non-ASCII character: the blob keeps only what an ASCII word can match, so it cannot say,
    /// and the caller asks every partition.
    ///
    /// THE ENGINE'S TEST, EXACTLY: `contains_unseparated(printed or oracle, word)` is a substring
    /// test on the name's alphanumerics, and a printed form keeps every ASCII alphanumeric in order
    /// with a space (which no word holds) wherever non-ASCII ones stood.
    pub fn carriers(&self, words: &[String]) -> Option<Vec<u16>> {
        let needles: Vec<String> =
            words.iter().map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>()).filter(|w| !w.is_empty()).collect();
        if needles.iter().any(|w| !w.is_ascii()) {
            return None;
        }
        if needles.is_empty() {
            return Some(Vec::new());
        }
        let hay = self.text.as_bytes();
        let n = self.fields.len();
        // hit[w][field]: the field carries word w. One search per word over the whole text, stepping
        // to the next field after each hit, so a word is looked for once per field at most.
        let mut hit: Vec<Vec<bool>> = Vec::with_capacity(needles.len());
        for word in &needles {
            let mut marks = vec![false; n];
            let finder = memchr::memmem::Finder::new(word.as_bytes());
            let mut pos = PRINTED_BLOB_HEADER.len();
            while pos < hay.len() {
                let Some(off) = finder.find(&hay[pos..]) else { break };
                let at = pos + off;
                let i = self.fields.partition_point(|f| f.start as usize <= at);
                if i > 0 {
                    let f = self.fields[i - 1];
                    let end = f.start as usize + usize::from(f.len);
                    if at + word.len() <= end {
                        marks[i - 1] = true;
                        pos = end;
                        continue;
                    }
                }
                // Inside a partition number, which is no name.
                pos = at + 1;
            }
            if !marks.iter().any(|m| *m) {
                // A word no name of any card carries: nothing completes the words.
                return Some(Vec::new());
            }
            hit.push(marks);
        }
        let mut found = std::collections::BTreeSet::new();
        let mut oracle_at = 0usize;
        for (i, f) in self.fields.iter().enumerate() {
            if f.card & ORACLE != 0 {
                oracle_at = i;
                continue;
            }
            let card = f.card as usize;
            if found.contains(&self.partitions[card]) {
                continue;
            }
            let mut own = false;
            let carried = hit.iter().all(|marks| {
                own |= marks[i];
                marks[i] || marks[oracle_at]
            });
            if carried && own {
                found.insert(self.partitions[card]);
            }
        }
        Some(found.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(lines: &[&str]) -> Vec<u8> {
        let mut out = PRINTED_BLOB_HEADER.as_bytes().to_vec();
        for l in lines {
            out.extend_from_slice(l.as_bytes());
            out.push(b'\n');
        }
        out
    }

    fn words(s: &str) -> Vec<String> {
        s.split(' ').map(str::to_owned).collect()
    }

    #[test]
    fn a_word_in_a_printed_name_pools_with_its_oracle_name() {
        let list = PrintedList::parse(blob(&[
            "3\tunmooredego\tegoaderiva\tegoalladeriva\tegoaladeriva",
            "7\tlightningbolt\tblitzschlag\tfoudre",
            "1\tguile\tinganno",
        ]))
        .expect("blob");
        assert_eq!(list.len(), 6);
        // `goad` from the Portuguese name, `red` from the oracle one.
        assert_eq!(list.carriers(&words("red goad")), Some(vec![3]));
        assert_eq!(list.carriers(&words("goad red")), Some(vec![3]));
        // A whole printed name.
        assert_eq!(list.carriers(&words("blitzschlag")), Some(vec![7]));
        // No typo tolerance, and no partition holds a match: the 404.
        assert_eq!(list.carriers(&words("blitzschlagg")), Some(vec![]));
        assert_eq!(list.carriers(&words("blue creatures that combo infinitely")), Some(vec![]));
        // The oracle name alone is the English tier, not this one.
        assert_eq!(list.carriers(&words("lightning")), Some(vec![]));
        // Words across two printed names of one card do not pool with each other.
        assert_eq!(list.carriers(&words("blitz foudre")), Some(vec![]));
        // Separators in a word are the engine's: dropped.
        assert_eq!(list.carriers(&[String::from("in-ganno")]), Some(vec![1]));
        // A partition number is no name.
        assert_eq!(list.carriers(&words("3")), Some(vec![]));
        // A non-ASCII word cannot be answered from ASCII forms: the caller asks everywhere.
        assert_eq!(list.carriers(&[String::from("dériva")]), None);
        assert_eq!(list.carriers(&[]), Some(vec![]));
    }

    #[test]
    fn a_form_keeps_ascii_runs_apart() {
        // Stored printed names are accent-folded, as the route folds the query.
        assert_eq!(card_engine::printed_form("ego a deriva"), "egoaderiva");
        assert_eq!(card_engine::printed_form("ego à deriva"), "ego deriva", "an unfolded letter is a break");
        assert_eq!(card_engine::printed_form("тест abc де def"), "abc def");
        assert_eq!(card_engine::printed_form("雷光の稲妻"), "");
        let list = PrintedList::parse(blob(&["0\tx\tabc def"])).expect("blob");
        assert_eq!(list.carriers(&words("abc")), Some(vec![0]));
        assert_eq!(list.carriers(&words("cd")), Some(vec![]), "a match cannot cross a non-ASCII letter");
        assert_eq!(list.carriers(&words("abcdef")), Some(vec![]));
    }

    #[test]
    fn a_blob_it_cannot_read_is_refused() {
        assert!(PrintedList::parse(b"sylvan-printed-names/2\n0\ta\tb\n".to_vec()).is_err(), "another version");
        assert!(PrintedList::parse(blob(&["x\ta\tb"])).is_err(), "bad partition");
        assert!(PrintedList::parse(blob(&["0\ta"])).is_err(), "no printed name");
        assert!(PrintedList::parse(blob(&["0\ta\tB-c"])).is_err(), "not a printed form");
        assert!(PrintedList::parse(b"sylvan-printed-names/1\n0\ta\tb".to_vec()).is_err(), "truncated");
        assert!(PrintedList::from_gzip(b"not gzip").is_err());
        let empty = PrintedList::parse(PRINTED_BLOB_HEADER.as_bytes().to_vec()).expect("an empty corpus");
        assert!(empty.is_empty() && empty.carriers(&words("anything")) == Some(vec![]));
    }
}
