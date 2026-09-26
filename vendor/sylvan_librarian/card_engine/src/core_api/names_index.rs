//! LOCAL PATCH (sylvan-librarian-cloudflare, backlog n15): the engine's half of the corpus-wide
//! NAMES INDEX — what one engine object needs to know about every card of every partition to tell
//! a name lookup which partitions can answer it, and the engine's own name tests to ask it with.
//!
//! WHY. The store is cut into N partitions by oracle id, and a name says nothing about an oracle
//! id, so a name-only `/cards/search` (`bolt`, `lightning bolt`, `name:/^bolt/`) and every
//! `/cards/named?fuzzy=` asked all N objects. The port publishes one [`NameRecord`] per card
//! beside the store (the n8 card-names blob, format 2; engine/wasm/src/names.rs reads it), and ONE
//! object evaluates the lookup over the whole corpus's records to name the partitions that can
//! hold an answer. Those — usually one or two, often none — are then asked exactly as before.
//!
//! ONE IMPLEMENTATION OF EACH TEST. Nothing here re-spells a predicate:
//!   - a search filter is compiled by `build_filter` and evaluated leaf by leaf through the query
//!     arms' own functions ([`crate::NamePredicate`], filter.rs);
//!   - the typo stage's score is `fuzzy_score_cleared` over `fuzzy_needle`, the scan's own two
//!     steps ([`FuzzyProbe`]);
//!   - containment is `strip_separators` + `contains_unseparated`, and `exact=`'s key test is
//!     `name_key_tier` ([`NamesProbe`]).
//!
//! What the records carry is decided the same way: [`name_records_of`] reads the structures an
//! archive is serialized from, and [`BufferStore::name_records`] — its archived twin, which a test
//! pins equal — reads the archive through the engine's own flavor-name indexes.
//!
//! EXACTNESS IS THE CALLER'S CONTRACT, and it is a SUPERSET contract: a partition set derived from
//! these records may name a partition that answers nothing (it is then asked for nothing), but
//! must never leave out one that answers something. Where a record cannot tell, the flags below
//! err wide.

use serde_json::Value;

use super::{BufferStore, EngineError, NameScope};
use crate::{CardData, NONE_STR, str_at};

/// The collection-vocab spelling of `is:variation`, as `include_variations=false` excludes it (the
/// router's extras gate, src/routes/extras-gate.ts `VARIATION_IS_TAG`).
const VARIATION_IS_TAG: &str = "variation";

// ─── Printing classes ─────────────────────────────────────────────────────────
// Which printings a search's rows come from, by the two default exclusions the router ANDs in
// (`-is:extra` unless include_extras, `-is:variation` unless include_variations) and whether the
// foreign annex is in play (include_multilingual). A card or a flavor key carries the bit of every
// class one of its printings belongs to; a search asks for the ONE bit its gates select.

/// Canonical, neither `is:extra` nor `is:variation` — the default `/cards/search` lane.
pub const CLASS_BOTH_GATES: u8 = 1 << 0;
/// Canonical, not `is:variation` (include_extras=true).
pub const CLASS_VARIATION_GATE: u8 = 1 << 1;
/// Canonical, not `is:extra` (include_variations=true). ALSO "served": the printing a default
/// search shows, which is autocomplete's per-card rule (`any_printing_is_served`).
pub const CLASS_EXTRA_GATE: u8 = 1 << 2;
/// Any canonical printing.
pub const CLASS_CANONICAL: u8 = 1 << 3;
/// Any printing, either space — the superset include_multilingual reads.
pub const CLASS_ANY: u8 = 1 << 4;

/// The card's best printing (`best_printing_of(cid, None)`: its first served canonical printing,
/// else its first) is an ART SERIES: `exact=` skips the card and the typo stage's pool leaves it
/// out (`typo_pool_vpid`). Also set for a card with no canonical printing at all, which every
/// name stage skips.
pub const BEST_ART_SERIES: u8 = 1 << 0;
/// The best printing's layout is one the containment stage never answers with
/// (`CONTAINMENT_EXCLUDED_LAYOUTS`), or there is none.
pub const BEST_NO_CONTAINMENT: u8 = 1 << 1;

/// On a FLAVOR KEY only: a served printing (not `is:extra`, either space) carries it — the
/// containment stage's flavor passes read a key only through such a printing.
pub const KEY_SERVED: u8 = 1 << 5;
/// On a FLAVOR KEY only: a served printing carrying it is one the containment stage never answers
/// with (`CONTAINMENT_EXCLUDED_LAYOUTS`). A key that is `KEY_SERVED` and not this answers
/// containment whichever of its served printings the pass picks.
pub const KEY_SERVED_OUTSIDE_CONTAINMENT: u8 = 1 << 6;

/// The flavor-key-only bits of one printing.
fn key_bits(extra: bool, layout: Option<&str>) -> u8 {
    if extra {
        return 0;
    }
    if layout.is_some_and(|l| super::CONTAINMENT_EXCLUDED_LAYOUTS.contains(&l)) {
        KEY_SERVED | KEY_SERVED_OUTSIDE_CONTAINMENT
    } else {
        KEY_SERVED
    }
}

fn class_bits(canonical: bool, extra: bool, variation: bool) -> u8 {
    let mut bits = CLASS_ANY;
    if canonical {
        bits |= CLASS_CANONICAL;
        if !extra {
            bits |= CLASS_EXTRA_GATE;
        }
        if !variation {
            bits |= CLASS_VARIATION_GATE;
        }
        if !extra && !variation {
            bits |= CLASS_BOTH_GATES;
        }
    }
    bits
}

fn best_bits(layout: Option<&str>) -> u8 {
    let mut bits = 0;
    if layout == Some("art_series") {
        bits |= BEST_ART_SERIES;
    }
    if layout.is_some_and(|l| super::CONTAINMENT_EXCLUDED_LAYOUTS.contains(&l)) {
        bits |= BEST_NO_CONTAINMENT;
    }
    bits
}

/// One card, as the names index sees it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct NameRecord {
    /// `collated_name`: what `name:word`, `exact=` and autocomplete compare.
    pub collated: String,
    /// The printed name autocomplete answers with (`card_name_id`, falling back to `collated`).
    pub printed: String,
    /// `lower_name`: what `name:"…"` and `name:/…/` compare.
    pub lower: String,
    /// `folded_name`: what the typo and containment stages compare.
    pub folded: String,
    /// `CLASS_*`: the classes the card's printings fall in.
    pub classes: u8,
    /// `BEST_*`: what the card's best printing's layout keeps it out of.
    pub best: u8,
    /// Every flavor-name key a printing of this card carries — a card-level flavor name's
    /// `flavor_names_collated`, or its faces' joined `FaceFlavorKey::collated` — with the
    /// `CLASS_*` bits of the printings carrying it, and the `KEY_*` bits. Sorted by key, one entry
    /// per key.
    pub flavor: Vec<(String, u8)>,
}

/// Sort a card's (key, bits) pairs and OR the bits of equal keys together.
fn normalize_flavor(mut keys: Vec<(String, u8)>) -> Vec<(String, u8)> {
    keys.sort_unstable();
    let mut out: Vec<(String, u8)> = Vec::with_capacity(keys.len());
    for (key, bits) in keys {
        match out.last_mut() {
            Some((last, b)) if *last == key => *b |= bits,
            _ => out.push((key, bits)),
        }
    }
    out
}

/// Every card's [`NameRecord`], in card order — read off the SAME unarchived structures
/// `write_archive` has just serialized (the build-time twin of [`BufferStore::name_records`], which a
/// test pins equal). ~3,900 records a partition, allocated after the archive is out, like
/// `autocomplete_names_of`.
pub(crate) fn name_records_of(d: &CardData) -> Vec<NameRecord> {
    let vid = |tag: &str| d.coll_vocab.iter().position(|s| s.as_str() == tag).map(|p| p as u16);
    let (extra_vid, variation_vid) = (vid(crate::EXTRA_IS_TAG), vid(VARIATION_IS_TAG));
    let tagged = |tags: &[u16], v: Option<u16>| v.is_some_and(|v| tags.contains(&v));
    // The keys a printing is matched under: its card-level flavor name's collated record name
    // (`flavor_names_collated`, over `flavor_name_folded_id`), and its faces' join exactly as
    // `FaceFlavorNames::build` derives one — skipped when it collates to nothing.
    let keys_of = |p: &crate::Printing| -> Vec<String> {
        let mut keys = Vec::new();
        if p.flavor_name_folded_id != NONE_STR {
            keys.push(crate::collate_name(&d.strings[p.flavor_name_folded_id as usize]));
        }
        let names: Vec<&str> = p
            .faces
            .iter()
            .filter(|f| f.flavor_name_id != NONE_STR)
            .map(|f| d.strings[f.flavor_name_id as usize].as_str())
            .collect();
        if !names.is_empty() {
            let collated = crate::collate_name(&names.join(" // ").to_lowercase());
            if !collated.is_empty() {
                keys.push(collated);
            }
        }
        keys
    };
    let mut out = Vec::with_capacity(d.cards.len());
    for (cid, card) in d.cards.iter().enumerate() {
        let canonical = &d.printings[d.offsets[cid] as usize..d.offsets[cid + 1] as usize];
        let foreign = &d.foreign[d.foreign_offsets[cid] as usize..d.foreign_offsets[cid + 1] as usize];
        let mut classes = 0u8;
        let mut flavor: Vec<(String, u8)> = Vec::new();
        for (is_canonical, space) in [(true, canonical), (false, foreign)] {
            for p in space {
                let extra = tagged(&p.card_is_tags, extra_vid);
                let bits = class_bits(is_canonical, extra, tagged(&p.card_is_tags, variation_vid));
                classes |= bits;
                let layout = (p.card_layout_id != NONE_STR).then(|| d.strings[p.card_layout_id as usize].as_str());
                for key in keys_of(p) {
                    flavor.push((key, bits | key_bits(extra, layout)));
                }
            }
        }
        // `best_printing_of(cid, None)`: the first served canonical printing, else the first.
        let best = canonical.iter().find(|p| !tagged(&p.card_is_tags, extra_vid)).or_else(|| canonical.first());
        let best = match best {
            None => BEST_ART_SERIES | BEST_NO_CONTAINMENT,
            Some(p) => best_bits((p.card_layout_id != NONE_STR).then(|| d.strings[p.card_layout_id as usize].as_str())),
        };
        let collated = crate::collated_name_of(card, &d.strings);
        let printed = if card.card_name_id == NONE_STR { collated } else { d.strings[card.card_name_id as usize].as_str() };
        out.push(NameRecord {
            collated: collated.to_owned(),
            printed: printed.to_owned(),
            lower: crate::lower_name_of(card, &d.strings).to_owned(),
            folded: crate::folded_name_of(card, &d.strings).to_owned(),
            classes,
            best,
            flavor: normalize_flavor(flavor),
        });
    }
    out
}

/// The names blob's line for each record (format 2 — engine/wasm/src/names.rs reads it,
/// src/engine/card-names.ts `encodeCardNames` frames it), each led by `prefix` (the native
/// builder's `<partition>\t`; the nightly's coordinator writes the same prefix per staged
/// partition):
///
/// ```text
/// <prefix><classes:2 hex><best:1 hex>\t<collated>\t<printed>\t<lower>\t<folded>\t<key>:<bits>,…\n
/// ```
///
/// `lower` is empty when it is `printed.to_lowercase()`, and `folded` when it is `lower` — true of
/// all but a few hundred cards, and what keeps the blob near its n8 size. A flavor key is collated
/// (alphanumerics only), so neither `:` nor `,` can occur in one.
///
/// A tab or line break in a name, or an empty name its derivation cannot spell, is REFUSED rather
/// than escaped: the build fails loudly on the day the data changes, instead of publishing a blob
/// whose reader splits a record in two (the n8 rule).
pub fn name_records_tsv(prefix: &str, records: &[NameRecord]) -> Result<Vec<u8>, String> {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(records.len() * 48);
    for r in records {
        for s in [&r.collated, &r.printed, &r.lower, &r.folded] {
            if s.contains(['\t', '\n', '\r']) {
                return Err(format!("card name {s:?} carries a tab or a line break; the names blob cannot spell it"));
            }
        }
        let derived_lower = r.printed.to_lowercase();
        let lower = if r.lower == derived_lower { "" } else { r.lower.as_str() };
        let folded = if r.folded == r.lower { "" } else { r.folded.as_str() };
        if (lower.is_empty() && r.lower != derived_lower) || (folded.is_empty() && r.folded != r.lower) {
            return Err(format!("card {:?} has an empty name its derivation cannot spell", r.collated));
        }
        let _ = write!(out, "{prefix}{:02x}{:x}\t{}\t{}\t{lower}\t{folded}\t", r.classes, r.best, r.collated, r.printed);
        for (i, (key, bits)) in r.flavor.iter().enumerate() {
            if key.contains([':', ',', '\t', '\n', '\r']) {
                return Err(format!("flavor key {key:?} is not collated; the names blob cannot spell it"));
            }
            let _ = write!(out, "{}{key}:{bits:02x}", if i == 0 { "" } else { "," });
        }
        out.push('\n');
    }
    Ok(out.into_bytes())
}

impl BufferStore {
    /// The archived twin of [`name_records_of`], read through the engine's own structures: the
    /// `flavor_names` index and `flavor_names_collated` for card-level flavor names, the derived
    /// `FaceFlavorNames` for face-level ones, `best_printing_of` for the best printing. What both
    /// builders publish is pinned against this (tests, and the real-corpus check in
    /// engine/wasm/tests/names_real.rs).
    pub fn name_records(&self) -> Vec<NameRecord> {
        let data = self.data();
        let vid = |tag: &str| data.coll_vocab.iter().position(|s| s.as_str() == tag).map(|p| p as u16);
        let (extra_vid, variation_vid) = (vid(crate::EXTRA_IS_TAG), vid(VARIATION_IS_TAG));
        let n = data.printings.len() as u32;
        let bits_of = |vpid: u32| {
            let p = crate::printing_at(data, vpid);
            let tagged = |v: Option<u16>| v.is_some_and(|v| p.card_is_tags.iter().any(|t| u16::from(*t) == v));
            class_bits(vpid < n, tagged(extra_vid), tagged(variation_vid))
        };
        let key_bits_of = |vpid: u32| {
            let p = crate::printing_at(data, vpid);
            let extra = extra_vid.is_some_and(|v| p.card_is_tags.iter().any(|t| u16::from(*t) == v));
            bits_of(vpid) | key_bits(extra, super::layout_of(data, vpid))
        };
        let mut flavor: Vec<Vec<(String, u8)>> = vec![Vec::new(); data.cards.len()];
        let idx = &data.indexes.flavor_names;
        for rec in 0..idx.name_ids.len() {
            let (from, to) = (u32::from(idx.offsets[rec]) as usize, u32::from(idx.offsets[rec + 1]) as usize);
            for v in &idx.vpids[from..to] {
                let vpid = u32::from(*v);
                let cid = crate::card_of_vpid(data, vpid) as usize;
                flavor[cid].push((data.indexes.flavor_names_collated[rec].as_str().to_owned(), key_bits_of(vpid)));
            }
        }
        for key in &self.face_flavor_names().keys {
            for &vpid in &key.vpids {
                flavor[crate::card_of_vpid(data, vpid) as usize].push((key.collated.clone(), key_bits_of(vpid)));
            }
        }
        let mut out = Vec::with_capacity(data.cards.len());
        for (cid, card) in data.cards.iter().enumerate() {
            let (cs, ce) = (u32::from(data.offsets[cid]), u32::from(data.offsets[cid + 1]));
            let (fs, fe) = (u32::from(data.foreign_offsets[cid]), u32::from(data.foreign_offsets[cid + 1]));
            let classes = (cs..ce).chain((fs..fe).map(|f| n + f)).fold(0u8, |acc, vpid| acc | bits_of(vpid));
            let best = match self.best_printing_of(cid, None) {
                None => BEST_ART_SERIES | BEST_NO_CONTAINMENT,
                Some((pid, _, _)) => best_bits(super::layout_of(data, pid as u32)),
            };
            let collated = crate::collated_name(card, &data.strings);
            let printed = str_at(&data.strings, u32::from(card.card_name_id)).unwrap_or(collated);
            out.push(NameRecord {
                collated: collated.to_owned(),
                printed: printed.to_owned(),
                lower: crate::lower_name(card, &data.strings).to_owned(),
                folded: crate::folded_name(card, &data.strings).to_owned(),
                classes,
                best,
                flavor: normalize_flavor(std::mem::take(&mut flavor[cid])),
            });
        }
        out
    }
}

// ─── Search: a filter that reads names alone ──────────────────────────────────

/// A `/cards/search` filter tree that reads card NAMES and nothing else, compiled by the engine —
/// or rather, the part of one that does, beside the router's default exclusions.
///
/// The router sends `AND(<the user's tree>, NOT is:extra, NOT is:variation)` (either exclusion
/// absent when the caller or a trigger term lifts it). Those two conjuncts are recognised by their
/// wire shape and become the printing class the records are read in; everything else must compile
/// (`build_filter`) to AND/OR over the three name leaves, or this is None and the caller asks every
/// partition as before.
pub struct NameQuery {
    predicate: crate::NamePredicate,
    extra_gate: bool,
    variation_gate: bool,
}

/// `NOT card_is_tags:[<tag>]` — the one conjunct shape the router's gate writes
/// (extras-gate.ts `notIsTagNode`) — as its tag.
fn gate_tag(node: &Value) -> Option<&str> {
    if node["node_type"].as_str() != Some("NotNode") {
        return None;
    }
    let inner = &node["kwargs"]["operand"];
    let kw = &inner["kwargs"];
    let lhs = &kw["lhs"];
    let is_gate = inner["node_type"].as_str() == Some("CardBinaryOperatorNode")
        && kw["op"].as_str() == Some(":")
        && lhs["node_type"].as_str() == Some("CardAttributeNode")
        && lhs["kwargs"]["attribute_name"].as_str() == Some("card_is_tags");
    if !is_gate {
        return None;
    }
    match kw["rhs"].as_array().map(Vec::as_slice) {
        Some([Value::String(tag)]) if tag == crate::EXTRA_IS_TAG || tag == VARIATION_IS_TAG => Some(tag.as_str()),
        _ => None,
    }
}

impl NameQuery {
    /// The name query a filter tree is, or None when any part of it reads something else. A tree
    /// the engine cannot compile is None too: the query itself then reports the error, exactly as
    /// it always has.
    pub fn of(tree: &Value) -> Option<NameQuery> {
        fn flatten<'a>(node: &'a Value, parts: &mut Vec<&'a Value>, gates: &mut (bool, bool)) {
            if node["node_type"].as_str() == Some("AndNode")
                && let Some(operands) = node["kwargs"]["operands"].as_array()
            {
                for operand in operands {
                    flatten(operand, parts, gates);
                }
                return;
            }
            match gate_tag(node) {
                Some(tag) if tag == crate::EXTRA_IS_TAG => gates.0 = true,
                Some(_) => gates.1 = true,
                None => parts.push(node),
            }
        }
        let mut parts = Vec::new();
        let mut gates = (false, false);
        flatten(tree, &mut parts, &mut gates);
        if parts.is_empty() {
            return None;
        }
        let mut compiled = Vec::with_capacity(parts.len());
        for part in parts {
            compiled.push(crate::build_filter(part).ok()?.into_name_predicate()?);
        }
        let predicate = if compiled.len() == 1 { compiled.pop()? } else { crate::NamePredicate::All(compiled) };
        Some(NameQuery { predicate, extra_gate: gates.0, variation_gate: gates.1 })
    }

    /// The `CLASS_*` bit a card or flavor key must carry to be read: the class of printings the
    /// search's rows come from. `include_multilingual` widens to every printing.
    pub fn class_bit(&self, multilingual: bool) -> u8 {
        if multilingual {
            return CLASS_ANY;
        }
        match (self.extra_gate, self.variation_gate) {
            (true, true) => CLASS_BOTH_GATES,
            (false, true) => CLASS_VARIATION_GATE,
            (true, false) => CLASS_EXTRA_GATE,
            (false, false) => CLASS_CANONICAL,
        }
    }

    /// Whether a card has a printing, in the class `bit` names, that satisfies the query.
    ///
    /// EXACT for the canonical classes: a printing is matched against the card's names plus its
    /// own flavor key, and the predicate is monotone in that key, so the card matches iff it has
    /// a printing in the class (then the key-less reading is enough) or a key carried by one does.
    pub fn card_matches(&self, record: &NameRecordView<'_>, bit: u8) -> bool {
        if record.classes & bit == 0 {
            return false;
        }
        if self.predicate.holds(record.collated, record.lower, None) {
            return true;
        }
        self.predicate.reads_flavor()
            && record.flavor.iter().any(|(key, bits)| bits & bit != 0 && self.predicate.holds(record.collated, record.lower, Some(key)))
    }

    /// Run `scan` (which calls `card_matches`) under the engine's regex budget: a pattern that
    /// exhausted it anywhere is an error, and the caller asks the partitions instead — they report
    /// the same exhaustion, or answer, exactly as they did before the index.
    pub fn scan<T>(&self, scan: impl FnOnce(&NameQuery) -> T) -> Result<T, EngineError> {
        crate::clear_regex_match_failed();
        let out = scan(self);
        match crate::take_regex_match_failed() {
            Some(msg) => Err(EngineError::unsupported_regex(msg.strip_prefix(crate::REGEX_MATCH_ERR_PREFIX).unwrap_or(&msg))),
            None => Ok(out),
        }
    }
}

/// A [`NameRecord`] borrowed from wherever the reader keeps it (the wasm crate holds the blob's text).
pub struct NameRecordView<'a> {
    pub collated: &'a str,
    pub lower: &'a str,
    pub classes: u8,
    pub flavor: &'a [(&'a str, u8)],
}

// ─── /cards/named?fuzzy=: the three stages' own tests ─────────────────────────

/// The typo stage's score for one name — `fuzzy_name_match`'s loop body, bit for bit: the same
/// separator fold and trigram run of the name, the same prefilters and `(J + L) / 2` in f32.
pub struct FuzzyProbe {
    needle_bytes: Vec<u8>,
    needle_tg: Vec<[u8; 3]>,
    name_bytes: Vec<u8>,
    name_tg: Vec<[u8; 3]>,
    dp: Vec<u32>,
}

impl FuzzyProbe {
    /// The probe for a needle, or None when nothing alphanumeric survives it (the scan's Miss).
    pub fn new(needle: &str) -> Option<FuzzyProbe> {
        let (needle_bytes, needle_tg) = crate::fuzzy_needle(needle)?;
        Some(FuzzyProbe { needle_bytes, needle_tg, name_bytes: Vec::with_capacity(64), name_tg: Vec::with_capacity(64), dp: Vec::with_capacity(64) })
    }

    /// The score of a card's `folded_name` against the needle, or None under `floor`.
    pub fn score(&mut self, folded: &str, floor: f32) -> Option<f32> {
        crate::fold_separators_into(folded, &mut self.name_bytes);
        crate::name_trigrams_into(&self.name_bytes, &mut self.name_tg);
        crate::fuzzy_score_cleared(&self.name_tg, &self.needle_tg, &self.name_bytes, &self.needle_bytes, floor, &mut self.dp)
    }

    /// A name's [`FuzzySignature`]: the count of its distinct trigrams, as `score` forms them, and a
    /// 64-bit set of their hashes. Computed once per name, when a names index loads.
    pub fn signature(folded: &str) -> FuzzySignature {
        let (mut bytes, mut tg) = (Vec::new(), Vec::new());
        crate::fold_separators_into(folded, &mut bytes);
        crate::name_trigrams_into(&bytes, &mut tg);
        FuzzySignature { trigrams: u16::try_from(tg.len()).unwrap_or(u16::MAX), bits: tg.iter().fold(0, |b, t| b | signature_bit(t)) }
    }

    /// Whether a name with this signature CAN clear `floor` — false only where `score` would answer
    /// None: its first two exits read the trigram counts and the Jaccard of the two runs, and this
    /// reads the same counts and an UPPER bound on the Jaccard (a needle trigram whose hash bit the
    /// name lacks is certainly not shared; one whose bit it has may be). So a scan may skip `score`
    /// for a false here and never change what it finds. `u16::MAX` trigrams (a name past the count)
    /// is always scored.
    pub fn could_clear(&self, name: FuzzySignature, floor: f32) -> bool {
        if name.trigrams == u16::MAX {
            return true;
        }
        let (la, lb) = (usize::from(name.trigrams), self.needle_tg.len());
        let jaccard_floor = (2.0 * floor - 1.0).max(0.0);
        if la == 0 || lb == 0 || (la.min(lb) as f32) < jaccard_floor * la.max(lb) as f32 {
            return false;
        }
        let shared = self.needle_tg.iter().filter(|t| name.bits & signature_bit(t) != 0).count().min(la);
        let union = la + lb - shared;
        let jaccard = if union == 0 { 0.0 } else { shared as f32 / union as f32 };
        jaccard >= jaccard_floor
    }
}

/// See [`FuzzyProbe::signature`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FuzzySignature {
    pub trigrams: u16,
    pub bits: u64,
}

fn signature_bit(t: &[u8; 3]) -> u64 {
    let h = (u32::from(t[0]).wrapping_mul(0x9E37_79B1) ^ u32::from(t[1]).wrapping_mul(0x85EB_CA77) ^ u32::from(t[2]).wrapping_mul(0xC2B2_AE3D))
        .rotate_left(13);
    1u64 << (h % 64)
}

/// The exact and containment stages' tests for one needle.
pub struct NamesProbe {
    /// `collate_name(folded)`: what `exact=`'s keys compare against.
    collated: String,
    /// The query words as the containment stage strips them (`strip_separators`, empties dropped).
    needles: Vec<String>,
}

impl NamesProbe {
    pub fn new(folded: &str, words: &[String]) -> NamesProbe {
        NamesProbe {
            collated: crate::collate_name(folded),
            needles: words.iter().map(|w| super::strip_separators(w)).filter(|w| !w.is_empty()).collect(),
        }
    }

    /// Whether `exact=`'s scan names this card: `name_key_tier` over its folded and collated
    /// names (the whole name, or one half of a two-half name).
    pub fn names_card(&self, folded: &str, collated: &str) -> bool {
        super::name_key_tier(folded, collated, &self.collated, NameScope::Exact).is_some()
    }

    /// Whether a flavor key, collated, IS the needle — the flavor pass's collated comparison (its
    /// folded-record lookup matches a subset of these).
    pub fn names_key(&self, key: &str) -> bool {
        key == self.collated
    }

    /// Whether the containment stage has any word to look for (it answers nothing otherwise).
    pub fn has_words(&self) -> bool {
        !self.needles.is_empty()
    }

    /// Whether `hay` (a folded name, or a collated key — the same string once separators go)
    /// carries every word — the oracle pass's test.
    pub fn contains_all(&self, hay: &str) -> bool {
        self.needles.iter().all(|w| super::contains_unseparated(hay, w))
    }

    /// Whether every word is carried by at least one of `hays` — the record passes' pooling, read
    /// across ALL of a card's names at once (a superset of pooling one name with the oracle name).
    pub fn contains_all_pooled<'a>(&self, hays: impl Iterator<Item = &'a str> + Clone) -> bool {
        self.needles.iter().all(|w| hays.clone().any(|h| super::contains_unseparated(h, w)))
    }
}
