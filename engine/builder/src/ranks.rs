//! A CARD'S OWN ORDER OF ITS PRINTINGS, as a per-row rank.
//!
//! One order answers three questions on api.scryfall.com, and this module is that order:
//!
//!   * `unique=prints&order=name` — the printings of one card tie on the name and come back in it;
//!   * `unique=cards` — the card's representative is the first printing in it that the filter
//!     keeps, which is why `g:war` answers Neheb's war/140 and not the 2021 promo pwar/140★;
//!   * a foreign printed name (`/cards/named?fuzzy=対抗呪文`, `!"Counterspell" lang:ja`) — the first
//!     printing of that LANGUAGE in it.
//!
//! Where Scryfall's `oracle_cards` label names a printing, [`transform::PIN_BONUS`] pins it and it
//! leads; the rank is everything after it.
//!
//! THE ORDER, MEASURED (api.scryfall.com, 2026-10-08). `prints>=8 -t:basic` under `unique=prints
//! order=name include_extras=true` is 33,640 rows, every printing of the 2,433 cards and tokens
//! printed eight times or more, each card's rows in Scryfall's own sequence:
//!
//! ```text
//! tier ASC > released_at DESC > the date's release batch DESC > set code ASC > collector number ASC
//! ```
//!
//!   * THE TIER is the whole of what the earlier fits could not find. A card's printings are not
//!     one date-descending list but up to three, one after another: Counterspell is dsc/114,
//!     cmm/81, dmr/45 … leb/55, lea/54 (27 rows, 2024 down to 1993), THEN fdc/61, sld/7117 …
//!     plgm/1, 4bb/65, fbb/54 (46 rows, 2026 down to 1994), THEN 30a/54 … cei/55, ced/55 (15 rows).
//!     Every one of the 2,433 sequences is at most three date-descending runs, and the 2026-08-16
//!     harvest's residue — "the printing Scryfall keeps is OLDER in 1,114 and NEWER in 0" — is this:
//!     a newer printing of a later tier loses to an older one of an earlier tier. See [`print_tier`]
//!     for what puts a printing in which.
//!   * INSIDE A DATE the sets come latest release batch first (`card_engine::release_batch`, the
//!     order `order=released&dir=desc` leads with), a batch's sets by code, a set's printings by
//!     collector number as `order=set` reads it: Ultima is fin/38, then pfin/38s, fin/328, pss5/1 —
//!     pfin sits in batch 1 of 2025-06-13, fin and pss5 in batch 0. Over the 101 distinct
//!     (date, set, set) precedences these rows and the samples below show inside one tier,
//!     batch-descending then code-ascending holds on all 101; code-descending on 52,
//!     batch-ascending on 49. Six of them turn on a batch boundary that falls where the code order
//!     continues (`cei` after `ced` on 1993-12-10, `peld` after `eld`, `pss1` after `exp`), which
//!     Scryfall's ascending `order=released` reads the same either way: the table asks
//!     `prefer:newest` and `prefer:oldest` for those (scripts/generate-release-batches.ts), and
//!     before it did this order held on 95.
//!
//! Replayed over those 2,433 sequences with the label leading each, the order stored until now —
//! English slot, collector-number prefix, date, collector number — reproduces 226 whole sequences
//! and puts 20.5% of the rows in their place; with a card's first k printings filtered away its
//! best remaining printing is Scryfall's next one 46.4% of the time. This order: 2,369 sequences,
//! 98.0% of the rows, 98.6%. By the default tier of each set type alone, without the measured
//! table: 1,080 sequences.
//!
//! AND ON CARDS THE TABLE WAS NOT MEASURED ON — `prints=7 -t:basic`, 5,390 rows, the 772 cards
//! printed exactly seven times: 757 whole sequences (218 before), 99.0% of the rows in place
//! (49.2%), the next-best printing right 99.4% of the time (65.0%). And on every printing of five
//! release groups asked whole (`g:fic`, `g:snc`, `g:war`, `g:hob`, `g:ecc`; 852 cards with two or
//! more rows): 847 sequences, the five misses New Capenna Commander's etched display commanders
//! (ncc/186-190 ahead of the extended-art ncc/100-107 they follow by number).
//!
//! WHY A RANK AND NOT A FORMULA. `prefer_score` is an `f32` and the archive sorts printings on
//! `!f32_sort_bits(prefer_score)`, so whatever this rule is, it has to fit 24 bits of mantissa.
//! It does not: `released_at` spans 1,279 distinct values, and collector numbers reach 105,882
//! with 483 distinct suffixes — about 37 bits together. What DOES fit is the rank of the row
//! within its own card, 10 bits, leaving 14 for the existing score to ride underneath:
//!
//! ```text
//! prefer_score = (RANK_SPAN - rank) * RANK_STEP + prefer_score_as_before + (pinned ? PIN_BONUS : 0)
//! ```
//!
//! Three properties come out of that shape, and each is a thing that must not move:
//!
//!   * THE PINNED ANSWER IS UNCHANGED. `pinned` is the FIRST key of the rank order, so the
//!     labelled English printing is rank 0 and wins every filter that contains it.
//!   * ENGLISH STILL LEADS ITS OWN SLOT, where the slot is not the card's default tier: a slot's
//!     languages share one rank there and fall through to the old score, whose `+40` language
//!     term orders them as before.
//!   * CROSS-CARD ORDER IS UNTOUCHED. `cards_containing_all_words` and `exact_card_by_name` rank
//!     CARDS by their chosen printing's score; every rank-0 printing carries
//!     `RANK_SPAN * RANK_STEP` plus its own old score, so those comparisons still turn on the old
//!     score alone.
//!
//! A LANGUAGE IS NOT A TIER OF ITS OWN, BUT THE DEFAULT TIER IS ENGLISH ONLY. `!"Counterspell"
//! lang:any` leads with the 27 default-tier printings in English and nothing else; dsc/114's
//! German, Spanish, French, Italian and Japanese rows come back in the second run, at their date,
//! between purl/2 (2024-10-18) and mb2/158 (2024-08-02). So under `lang:ja` nothing is in the
//! default tier and the order is the date alone — mar/9, fca/4, sld/1589, dsc/114, cmm/81 … — which
//! is why a Japanese printed name resolves to mar/9 while the English one resolves to dsc/114. The
//! rank is therefore per (slot, English or not): a default-tier slot's other languages rank where
//! their date puts them in the second tier, and every other slot's languages share its rank.
//! Ten printed names in five languages asked of `/cards/named?fuzzy=` the same day each answered
//! the newest printing in that language (ties by set and number as above).
//!
//! WHAT IT STILL GETS WRONG, measured: 64 of the 2,433 sequences.
//!
//!   * THE TIER IS SCRYFALL'S OWN RECORD, NOT A FUNCTION OF THE CARD. Dominaria Remastered's
//!     retro-frame `boosterfun` printings are second-tier, except the fifteen black ones
//!     (dmr/300-314), which are default-tier; Jumpstart 2022 is second-tier except Rhystic Study
//!     (j22/114); Modern Horizons 3 Commander is second-tier except Wayfarer's Bauble (m3c/315),
//!     whose Lost Caverns Commander printing (lcc/317) is the one second-tier row of a default-tier
//!     set. No field of the card object separates them — blc/191 and tdc/203 print Abrade with the
//!     same frame, finishes, games, stamp, promo types and set type, and are in different tiers.
//!     So the tier is read from a card's shape where the shape decides it and from a MEASURED
//!     per-set table where it does not (`print_tiers.tsv`), and a printing that departs from its
//!     set stays wrong.
//!   * Digital-only Arena printings split between the second and third run with no visible rule
//!     (`j21`, `hbg`, three Alchemy sets); they rank second here.
//!   * `lang:any` interleaves the languages by date — mar/9, mar/9 in German, Spanish, French and
//!     Japanese, then dsc/114's translations — where this store pages a card's English rows
//!     before its others (the canonical and annex spaces of the sort key). The ranks are right
//!     for it; the page order is the sort key's, and is not this module's to change.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;

use crate::transform::{pin_key, PinKey, PinnedPrintings, RowDraft};

/// Ranks are clamped to this, and it is the multiplier's ceiling: the worst-ranked row of a card
/// scores 0 from the rank term. 1024 because all but the five basic lands have fewer ranked rows
/// (`Forest` has 949 printing slots, measured 2026-08-16, and more ranks than that now that a
/// default-tier slot's other languages rank apart): a basic land's oldest second-tier rows share
/// the last rank and fall back to the score underneath, exactly as a row past the clamp always did.
pub const RANK_SPAN: u32 = 1024;

/// What one rank step is worth. Must exceed everything that rides underneath it — the ordinary
/// `prefer_score` (~130-220) plus `PIN_BONUS` (1000) — so a better rank always wins outright;
/// 2048 is the next power of two above that 1250, and powers of two keep the product exact in an
/// f32. `RANK_SPAN * RANK_STEP` is 2^21, so the whole score stays inside the 2^24 an f32 holds.
pub const RANK_STEP: f64 = 2048.0;

/// The rank term of `prefer_score`: rank 0 scores highest, and each further rank drops one step.
pub fn rank_term(rank: u32) -> f64 {
    f64::from(RANK_SPAN - rank.min(RANK_SPAN)) * RANK_STEP
}

/// A collector number as `order=set` orders it, which is how a card's printings inside one set and
/// date come back: the digits as one integer (a number with none first), then the text as Scryfall
/// collates it (`card_engine::collector_collation_key` — symbols, digits, letters). `9` before
/// `10`, `239` before `239★` before `239s`, and `4` before `USG-4`.
///
/// It was `(leading letters, digits, rest)` until 2026-10-08, which put every prefixed number last
/// — the prefix was a key of its own then (`cn_has_set_prefix`), and inside one set the two agree
/// except on a set that letters its numbers: Counterspell's four 2001 World Championship printings
/// are wc01/ab67, ar67, ab69, ar69 on api.scryfall.com, the number before the deck's initials.
pub fn collector_order_key(collector_number_int: Option<i64>, cn: &str) -> (Option<i64>, String) {
    (collector_number_int, card_engine::collector_collation_key(cn))
}

/// Whether a collector number carries a SET-CODE PREFIX: leading non-digits (`USG-4`, `mb278`), or
/// a digit-led set code before a dash (`10E-321`, `2XM-235`, `5DN-116` — a head of digits and
/// capitals with at least one capital, followed by a number). A dated head is not (`pmei/2010-1`,
/// `ppro/2022-3`: no letter), nor a lettered suffix (`plg24/2J-b`: no number after the dash).
///
/// This was a KEY of the order from 2026-08-17 to 2026-10-08 — "a prefixed number sorts after a
/// bare one" — and what it was fitted on is the tier ([`print_tier`]): The List reprints a card
/// under its first printing's `SET-N`, and The List is second-tier. As a key it also demoted a
/// prefix that is not one (9ed/S10, tdd1/T2 and the `tmed` tokens are default-tier), so what the
/// tier reads now is the DASHED shape alone, a reprint numbered after the printing it copies.
pub fn cn_has_set_prefix(cn: &str) -> bool {
    if cn.starts_with(|c: char| !c.is_ascii_digit()) {
        return true;
    }
    cn.split_once('-').is_some_and(|(head, tail)| {
        head.chars().all(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
            && head.chars().any(|c| c.is_ascii_uppercase())
            && tail.starts_with(|c: char| c.is_ascii_digit())
    })
}

/// A collector number of the List's shape: another printing's `SET-N`.
fn cn_is_reprint_numbered(cn: &str) -> bool {
    cn.contains('-') && cn_has_set_prefix(cn)
}

/// Scryfall's order of a card's printings is in TIERS, and this is which one a row is in:
/// `0` the default tier, `1` after every default-tier printing whatever its date, `2` last.
///
/// MEASURED over the module doc's harvest and every token (`is:token`), 36,804 rows in 3,461
/// sequences, each row labelled where its sequence proves the tier (three runs name all three; in
/// two, a row dated before the second run's first row cannot belong to it): 28,071 English rows
/// and 1,238 others. Rows carrying each mark, and how many of them are in the tier it names:
///
/// ```text
/// tier 2   set type memorabilia                                   1,487 of 1,487
///          a gold border 327 of 329, an oversized card 93 of 99
/// tier 1   every row that is not English                          1,238 of 1,238
///          promo                                                  2,952 of 2,954
///          promo type boosterfun                                  1,377 of 1,387  (dmr/300-314)
///          frame effect extendedart / inverted / showcase / etched  2,767 of 2,770
///          borderless 2,057 of 2,058, full art 769 of 769, textless 138 of 138
///          an Arena-only printing                                   433 of   435
///          rarity `special` in a masters set (Time Spiral Remastered)  70 of  70
///          a collector number of the List's shape, `SET-N`        1,369 of 1,389
/// tier 0   everything else in a set whose plain printings are tier 0 — which is the set TYPE
///          (core, expansion, masters, draft_innovation, commander, duel_deck, planechase,
///          archenemy, starter, arsenal, eternal, funny, token) unless `print_tiers.tsv` says
///          otherwise: 462 sets measured, 40 of them not what their type says
/// ```
///
/// What does NOT move a printing out of the default tier, each counted on rows carrying it and
/// nothing above: a foil-only finish (659 of 694 — 7th Edition's `★` foils sit beside their
/// nonfoils), Magic Online (447 of 447: Vintage Masters, Tempest Remastered, Masters Edition I-IV),
/// the 1993, 1997 and future frames, a white border, the `legendary`, `enchantment`, `tombstone`,
/// `companion`, `colorshifted` and double-faced frame marks, and the promo types `setpromo` (233 of
/// 233, the older token sets), `surgefoil` (130 of 139 beside a nonfoil finish, 6 of 6 without one;
/// the foil-only `★` printings of the Universes Beyond commander sets are second-tier with the rest
/// of their sets), `universesbeyond` (93 of 93), `startercollection`, `starterdeck`, `beginnerbox`, `planeswalkerdeck`,
/// `setextension`, `brawldeck`, the league tokens' `instore` and `league`, and the Final Fantasy
/// game tags. A promo type this list does not name is read as a treatment.
pub fn print_tier(r: &RowDraft) -> u8 {
    let blob = &r.compat_blob;
    let flag = |key: &str| blob.get(key).and_then(Value::as_bool).unwrap_or(false);
    let set_type = r.raw_set_type.as_deref().unwrap_or("");
    let set_tier = set_tier(r.card_set_code.as_deref().unwrap_or(""), set_type);
    if set_tier == 2 || r.card_border.as_deref() == Some("gold") || flag("oversized") {
        return 2;
    }
    if !r.raw_lang_en || set_tier == 1 {
        return 1;
    }
    let list = |key: &'static str| blob.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
    let plain_promo_type = |p: &str| PLAIN_PROMO_TYPES.contains(&p) || is_game_tag(p);
    let variant = flag("promo")
        || list("promo_types").any(|p| !plain_promo_type(p))
        || list("frame_effects").any(|f| VARIANT_FRAME_EFFECTS.contains(&f))
        || !matches!(r.card_border.as_deref(), Some("black" | "white"))
        || flag("full_art")
        || flag("textless")
        || (flag("digital") && !list("games").any(|g| g == "mtgo"))
        // `card_rarity_int` 3 is `special` (transform's rarity ladder).
        || (r.card_rarity_int == Some(3) && set_type == "masters")
        || r.collector_number.as_deref().is_some_and(cn_is_reprint_numbered);
    u8::from(variant)
}

/// Promo types a default-tier printing carries. Anything else Scryfall names is a treatment.
const PLAIN_PROMO_TYPES: [&str; 11] = [
    "beginnerbox",
    "brawldeck",
    "instore",
    "league",
    "planeswalkerdeck",
    "setextension",
    "setpromo",
    "startercollection",
    "starterdeck",
    "surgefoil",
    "universesbeyond",
];

/// The Final Fantasy sets tag each printing with the game it draws on — `ffi`, `ffvii`, `ffxvi` —
/// as a promo type. Sixteen tags and counting, none of them a treatment.
fn is_game_tag(promo_type: &str) -> bool {
    promo_type.strip_prefix("ff").is_some_and(|n| !n.is_empty() && n.chars().all(|c| matches!(c, 'i' | 'v' | 'x')))
}

/// Frame effects that make a printing a variant. Every other one is a rules frame.
const VARIANT_FRAME_EFFECTS: [&str; 5] = ["extendedart", "inverted", "showcase", "etched", "shatteredglass"];

/// Scryfall's own record of which tier a set's plain English printings are in, where it is not
/// what the set type says (`print_tiers.tsv`, written by scripts/generate-print-tiers.ts).
const PRINT_TIERS_TSV: &str = include_str!("print_tiers.tsv");

static PRINT_TIERS: LazyLock<HashMap<&'static str, u8>> = LazyLock::new(|| {
    PRINT_TIERS_TSV
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let parsed = l.split_once('\t').and_then(|(set, tier)| Some((set, tier.parse::<u8>().ok().filter(|t| *t <= 2)?)));
            parsed.unwrap_or_else(|| panic!("print_tiers.tsv: malformed row {l:?}"))
        })
        .collect()
});

/// The tier of a set's PLAIN English printings: the measured table, else the set type.
fn set_tier(set: &str, set_type: &str) -> u8 {
    if let Some(tier) = PRINT_TIERS.get(set) {
        return *tier;
    }
    match set_type {
        "memorabilia" => 2,
        "core" | "expansion" | "masters" | "draft_innovation" | "commander" | "duel_deck" | "planechase" | "archenemy"
        | "starter" | "arsenal" | "eternal" | "funny" | "token" => 0,
        _ => 1,
    }
}

/// Split a finalized `prefer_score` back into `(rank, everything riding underneath it)`.
///
/// The encoding's central claim, executable: because one rank step outweighs the ordinary score
/// and the pin bonus together, the two halves never mix and either can be asserted about on its
/// own. Tests of the COMPONENTS use this so they keep saying what they said before the rank term
/// existed, instead of being rewritten around a magnitude.
#[cfg(test)]
pub(crate) fn split(score: f64) -> (u32, f64) {
    let steps = (score / RANK_STEP).floor();
    (RANK_SPAN - steps as u32, score - steps * RANK_STEP)
}

/// A printing slot of one card: `(released_at, set_code, collector_number)`.
type SlotKey = (String, String, String);

/// What the order needs to know about one printing slot's rows.
#[derive(Debug, Default, Clone)]
struct Slot {
    /// The tier of the slot's English row, when it has one.
    english: Option<u8>,
    /// The tier its rows in other languages take, when it has any.
    foreign: Option<u8>,
    collector_number_int: Option<i64>,
}

/// Where each printing row sits in its card's order.
///
/// Filled by the same per-card pass every import path already makes for [`PinnedPrintings`] —
/// `observe` per row as the corpus streams, then `seal` once the pins are known, because whether
/// a slot is pinned is the first thing the order asks and that is not knowable until the labelled
/// row has gone past.
#[derive(Debug, Default, Clone)]
pub struct PrintingRanks {
    /// oracle_id → its distinct `(released_at, set_code, collector_number)` slots.
    slots: HashMap<String, HashMap<SlotKey, Slot>>,
    /// The sealed answer: slot → `(rank of its English row, rank of its other languages)`. Keyed
    /// exactly as a pin is, so the two per-card facts a finalized row needs are asked in the same
    /// shape. The two ranks differ only for a default-tier slot — see the module doc.
    ranks: HashMap<PinKey, (u32, u32)>,
    sealed: bool,
}

impl PrintingRanks {
    /// Record `r`'s slot. Cheap enough to call per row; a row with no set code or no collector
    /// number has no addressable slot and is skipped, exactly as the pin skips it.
    pub fn observe(&mut self, r: &RowDraft) {
        if let (Some(set), Some(cn)) = (r.card_set_code.as_ref(), r.collector_number.as_ref()) {
            let slot = self
                .slots
                .entry(r.oracle_id.clone())
                .or_default()
                .entry((r.released_at.clone(), set.clone(), cn.clone()))
                .or_default();
            let tier = print_tier(r);
            let side = if r.raw_lang_en { &mut slot.english } else { &mut slot.foreign };
            *side = Some(side.map_or(tier, |seen| seen.min(tier)));
            slot.collector_number_int = r.collector_number_int;
        }
    }

    /// Order every card's rows and freeze the ranks. Idempotent — a phase's last slice can be
    /// retried — and it consumes the slot table, which is the larger of the two.
    pub fn seal(&mut self, pins: &PinnedPrintings) {
        if self.sealed {
            return;
        }
        self.sealed = true;
        for (oracle_id, slots) in std::mem::take(&mut self.slots) {
            // One entry per rank: a slot's English row, and its other languages where they do not
            // share that row's tier. The `bool` says which half of the slot the entry ranks.
            let mut ordered: Vec<(&SlotKey, &Slot, u8, bool)> = Vec::with_capacity(slots.len());
            for (key, slot) in &slots {
                match (slot.english, slot.foreign) {
                    (Some(en), Some(other)) if en != other => {
                        ordered.push((key, slot, en, true));
                        ordered.push((key, slot, other, false));
                    }
                    (Some(en), _) => ordered.push((key, slot, en, true)),
                    (None, Some(other)) => ordered.push((key, slot, other, false)),
                    (None, None) => {}
                }
            }
            ordered.sort_unstable_by_key(|((released_at, set, cn), slot, tier, english)| {
                let key: PinKey = (oracle_id.clone(), set.clone(), cn.clone());
                let date = released_at.replace('-', "").parse::<u32>().unwrap_or(0);
                // The label names one printing, and it is the English one wherever a slot has one.
                let pinned = pins.contains_key(&key) && (*english || slot.english.is_none());
                (
                    u8::from(!pinned),
                    *tier,
                    Reverse(released_at.clone()),
                    Reverse(card_engine::release_batch(date, set)),
                    set.clone(),
                    collector_order_key(slot.collector_number_int, cn),
                    u8::from(!*english),
                )
            });
            let mut ranks: HashMap<(&str, &str), (u32, u32)> = HashMap::with_capacity(slots.len());
            for (rank, ((_, set, cn), slot, _, english)) in ordered.into_iter().enumerate() {
                let rank = rank as u32;
                let entry = ranks.entry((set.as_str(), cn.as_str())).or_insert((rank, rank));
                if english {
                    entry.0 = rank;
                    // Its other languages share the rank unless they have an entry of their own.
                    if slot.foreign.is_none() || slot.foreign == slot.english {
                        entry.1 = rank;
                    }
                } else {
                    entry.1 = rank;
                    if slot.english.is_none() {
                        entry.0 = rank;
                    }
                }
            }
            for ((set, cn), pair) in ranks {
                self.ranks.insert((oracle_id.clone(), set.to_owned(), cn.to_owned()), pair);
            }
        }
    }

    /// `r`'s rank within its card. A row with no addressable slot ranks last, so it can never
    /// displace a printing the rule actually ordered.
    pub fn rank_of(&self, r: &RowDraft) -> u32 {
        pin_key(r)
            .and_then(|k| self.ranks.get(&k).copied())
            .map_or(RANK_SPAN, |(english, other)| if r.raw_lang_en { english } else { other })
    }

    pub fn len(&self) -> usize {
        self.ranks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ranks.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_numbers_order_as_order_set_reads_them() {
        // `9` before `10`, `239` before its `★`, and — the one place this differs from the key it
        // replaces — a prefixed number beside the bare one it shares digits with, not after
        // everything: api.scryfall.com answers wc01/ab67, ar67, ab69, ar69 (2026-10-08).
        let mut v = vec!["10", "9", "239★", "239", "USG-4", "4", "1a", "1b", "ar67", "ab69", "ab67", "ar69"];
        let int = |cn: &str| cn.chars().filter(char::is_ascii_digit).collect::<String>().parse::<i64>().ok();
        v.sort_by_key(|c| collector_order_key(int(c), c));
        assert_eq!(v, vec!["1a", "1b", "4", "USG-4", "9", "10", "ab67", "ar67", "ab69", "ar69", "239", "239★"]);
    }

    #[test]
    fn a_rank_step_outweighs_everything_riding_under_it() {
        // The whole point of RANK_STEP: a better rank beats a worse one even when the worse one
        // carries a full ordinary score AND the pin bonus.
        assert!(rank_term(0) - rank_term(1) > crate::transform::PIN_BONUS + 300.0);
    }

    #[test]
    fn the_whole_score_survives_an_f32() {
        // Every value the composition can produce has to round-trip the archive's f32.
        let worst = rank_term(0) + crate::transform::PIN_BONUS + 300.0;
        assert_eq!(worst as f32 as f64, worst);
        assert!(worst < f64::from(1u32 << 24));
    }

    /// One slot of a card: its date, set, collector number, the tier of its English row and the
    /// tier of its rows in other languages (None where it has none).
    type TestSlot<'a> = (&'a str, &'a str, &'a str, Option<u8>, Option<u8>);

    fn sealed(slots: &[TestSlot], pins: &PinnedPrintings) -> PrintingRanks {
        let mut r = PrintingRanks::default();
        r.slots.insert(
            "o".to_owned(),
            slots
                .iter()
                .map(|(date, set, cn, english, foreign)| {
                    let collector_number_int = cn.chars().filter(char::is_ascii_digit).collect::<String>().parse().ok();
                    (
                        (date.to_string(), set.to_string(), cn.to_string()),
                        Slot { english: *english, foreign: *foreign, collector_number_int },
                    )
                })
                .collect(),
        );
        r.seal(pins);
        r
    }

    /// The order, exercised through `seal` rather than restated — a slot table in, the rows out in
    /// rank order: `set/cn` for a slot's English row, `set/cn:x` for its other languages where they
    /// rank apart from it (or stand alone).
    fn ranked(slots: &[TestSlot]) -> Vec<String> {
        let r = sealed(slots, &PinnedPrintings::default());
        let mut out: Vec<(u32, String)> = Vec::new();
        for (_, set, cn, english, foreign) in slots {
            let (en, other) = r.ranks[&("o".to_owned(), set.to_string(), cn.to_string())];
            if english.is_some() {
                out.push((en, format!("{set}/{cn}")));
            }
            if foreign.is_some() && (english.is_none() || other != en) {
                out.push((other, format!("{set}/{cn}:x")));
            }
        }
        out.sort_unstable();
        out.into_iter().map(|(_, s)| s).collect()
    }

    const A: Option<u8> = Some(0);
    const B: Option<u8> = Some(1);
    const C: Option<u8> = Some(2);

    #[test]
    fn a_foreign_only_slot_loses_to_an_english_one_it_outdates() {
        // C1's Active Volcano: bchr/43 and chr/43 share a release date AND a collector number, and
        // Scryfall keeps the English one. Chronicles is a default-tier set; a printing that exists
        // only in Japanese is second-tier, as every non-English row is.
        assert_eq!(
            ranked(&[
                ("1994-06-01", "leg", "130", A, None),
                ("1995-07-01", "bchr", "43", None, B),
                ("1995-07-01", "chr", "43", A, None),
            ]),
            vec!["chr/43", "leg/130", "bchr/43:x"],
        );
        // Darksteel Juggernaut: the foreign slot is genuinely NEWER, so this is the tier beating
        // recency rather than breaking a tie.
        assert_eq!(
            ranked(&[("2010-10-01", "som", "150", A, None), ("2010-12-01", "pmei", "2010-1", None, B)]),
            vec!["som/150", "pmei/2010-1:x"],
        );
    }

    #[test]
    fn a_second_tier_printing_sorts_after_a_default_one_it_outdates() {
        // `plst/USG-4` (2024) is the newest Angelic Page and Scryfall keeps `usg/4` (1998).
        assert_eq!(
            ranked(&[("2024-09-01", "plst", "USG-4", B, None), ("1998-10-12", "usg", "4", A, None)]),
            vec!["usg/4", "plst/USG-4"],
        );
        // A PROMO IS SECOND-TIER TOO, whatever its number looks like. This asserted the reverse —
        // `pmei/2010-1` ahead of `usg/4`, "decided by the date alone" — while a prefixed collector
        // number was the only thing known to demote a printing, on a media insert invented for the
        // test. Measured 2026-10-08: Counterspell's real one, pmei/2025-15 (2025-09-25), comes
        // back 37th, after all 27 default-tier printings down to lea/54 (1993); of the 1,572
        // English promo rows the harvest labels, 1,570 are second-tier.
        assert_eq!(
            ranked(&[("2010-12-01", "pmei", "2010-1", B, None), ("1998-10-12", "usg", "4", A, None)]),
            vec!["usg/4", "pmei/2010-1"],
        );
    }

    #[test]
    fn a_digit_led_list_prefix_is_a_prefix_and_a_date_is_not() {
        // Doubling Cube, measured against api.scryfall.com 2026-09-25: `order=name` answers 10e,
        // 5dn, plst — the List reprint (2021) behind the Fifth Dawn printing it outdates (2004).
        assert_eq!(
            ranked(&[
                ("2007-07-13", "10e", "321", A, None),
                ("2004-06-04", "5dn", "116", A, None),
                ("2021-07-23", "plst", "10E-321", B, None),
            ]),
            vec!["10e/321", "5dn/116", "plst/10E-321"],
        );
        for cn in ["10E-321", "2XM-235", "5DN-116", "USG-4", "mb278"] {
            assert!(cn_has_set_prefix(cn), "{cn}");
        }
        for cn in ["321", "2010-1", "2022-3", "2J-b", "123s", "100★"] {
            assert!(!cn_has_set_prefix(cn), "{cn}");
        }
        // The tier reads the dashed shape alone: a lettered number is not a reprint's.
        for cn in ["10E-321", "USG-4", "IFIYW-2"] {
            assert!(cn_is_reprint_numbered(cn), "{cn}");
        }
        for cn in ["mb278", "S10", "T2", "ab67", "2010-1", "321"] {
            assert!(!cn_is_reprint_numbered(cn), "{cn}");
        }
    }

    #[test]
    fn a_same_date_same_number_tie_breaks_by_the_tier() {
        // War of the Spark's own printing and its promo-set twin share 2019-05-03 and number 223,
        // and api.scryfall.com's `order=name` puts war/223 first (2026-09-25). The promo is
        // second-tier, which is the whole of it — this was read as "pwar sits in a later batch of
        // that date", and inside one tier a later batch sorts FIRST (see the next test). Either
        // input order, because the pair once tied on every key and ranked by HashMap order.
        for slots in [
            [("2019-05-03", "war", "223", A, None), ("2019-05-03", "pwar", "223", B, None)],
            [("2019-05-03", "pwar", "223", B, None), ("2019-05-03", "war", "223", A, None)],
        ] {
            assert_eq!(ranked(&slots), vec!["war/223", "pwar/223"]);
        }
        // Commander (2011) and its oversized twin: cmd, then ocmd — an oversized card is last-tier.
        assert_eq!(
            ranked(&[("2011-06-17", "ocmd", "191", C, None), ("2011-06-17", "cmd", "191", A, None)]),
            vec!["cmd/191", "ocmd/191"],
        );
    }

    #[test]
    fn inside_a_tier_and_date_the_later_release_batch_leads_then_the_code_then_the_number() {
        // Squall, SeeD Mercenary on api.scryfall.com, 2026-10-08: fin/243, then pfin/243s, fin/402,
        // fin/509, fin/547, pss5/2 — one date, and after the default printing five second-tier
        // ones. `pfin` is batch 1 of 2025-06-13 in release_batches.tsv, `fin` and `pss5` batch 0.
        assert_eq!(
            ranked(&[
                ("2025-06-13", "pss5", "2", B, None),
                ("2025-06-13", "fin", "547", B, None),
                ("2025-06-13", "fin", "402", B, None),
                ("2025-06-13", "fin", "243", A, None),
                ("2025-06-13", "pfin", "243s", B, None),
                ("2025-06-13", "fin", "509", B, None),
            ]),
            vec!["fin/243", "pfin/243s", "fin/402", "fin/509", "fin/547", "pss5/2"],
        );
        // All-Seeing Arbiter: snc/34, snc/286, psnc/34p, psnc/34s — `snc` is batch 3 of 2022-04-29
        // and `psnc` batch 1, so here the set leads its promos.
        assert_eq!(
            ranked(&[
                ("2022-04-29", "psnc", "34s", B, None),
                ("2022-04-29", "psnc", "34p", B, None),
                ("2022-04-29", "snc", "286", B, None),
                ("2022-04-29", "snc", "34", A, None),
            ]),
            vec!["snc/34", "snc/286", "psnc/34p", "psnc/34s"],
        );
    }

    #[test]
    fn a_default_tier_slots_other_languages_rank_at_their_date_in_the_second_tier() {
        // Counterspell under `lang:any`, api.scryfall.com 2026-10-08: dsc/114, cmm/81, then pf26/5,
        // mar/9 and its translations, dsc/114's translations, cmm/81's, cmm/630 and its own.
        assert_eq!(
            ranked(&[
                ("2024-09-27", "dsc", "114", A, B),
                ("2023-08-04", "cmm", "81", A, B),
                ("2023-08-04", "cmm", "630", B, B),
                ("2025-09-26", "mar", "9", B, B),
                ("2026-04-13", "pf26", "5", B, None),
            ]),
            vec!["dsc/114", "cmm/81", "pf26/5", "mar/9", "dsc/114:x", "cmm/81:x", "cmm/630"],
        );
    }

    #[test]
    fn the_date_decides_between_languages_inside_a_tier_and_the_pin_outranks_everything() {
        // THIS ASSERTED THE REVERSE — a prefixed English slot (plst/USG-4, 2024) ahead of a newer
        // foreign-only one (ren/46, 2025) — as "the choice no corpus could make", a language key
        // placed first because nothing measured it against the prefix. Measured 2026-10-08, the
        // second run of `!"Counterspell" unique=prints order=name` is one date-descending list
        // with the languages interleaved: sld/175 (2021-06-21), mh2/308 (06-18), pmei/2021-1 in
        // Japanese only (04-26), sta/15 (04-23), sta/78 in Japanese only, prm/86148 (2020-12-15).
        // The four pairs the language key was built on (see the first test) all have a default-tier
        // English printing, which outranks every non-English row with or without the key.
        assert_eq!(
            ranked(&[("2024-09-01", "plst", "USG-4", B, None), ("2025-01-01", "ren", "46", None, B)]),
            vec!["ren/46:x", "plst/USG-4"],
        );
        let mut pins = PinnedPrintings::default();
        pins.pin_slot_for_test(("o".to_owned(), "ren".to_owned(), "46".to_owned()));
        let r = sealed(&[("2026-09-01", "usg", "4", A, None), ("2025-01-01", "ren", "46", None, B)], &pins);
        assert_eq!(r.ranks[&("o".to_owned(), "ren".to_owned(), "46".to_owned())], (0, 0));
        // The label is the ENGLISH row of the slot it names: that slot's other languages keep the
        // rank their date gives them.
        let mut pins = PinnedPrintings::default();
        pins.pin_slot_for_test(("o".to_owned(), "cmm".to_owned(), "81".to_owned()));
        let r = sealed(&[("2024-09-27", "dsc", "114", A, B), ("2023-08-04", "cmm", "81", A, B)], &pins);
        assert_eq!(r.ranks[&("o".to_owned(), "cmm".to_owned(), "81".to_owned())], (0, 3));
        assert_eq!(r.ranks[&("o".to_owned(), "dsc".to_owned(), "114".to_owned())], (1, 2));
    }

    #[test]
    fn ranks_clamp_rather_than_underflow() {
        assert_eq!(rank_term(RANK_SPAN), 0.0);
        assert_eq!(rank_term(RANK_SPAN + 5_000), 0.0);
    }

    fn draft(name: &str) -> RowDraft {
        let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
        let card: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        crate::transform::transform_row(&card, true).unwrap().unwrap()
    }

    /// The tier of real card objects (api.scryfall.com, 2026-10-08), each one a row Scryfall's own
    /// sequence places: Abrade's ten printings come back tdc/203, inr/139, 2xm/114, hou/83 and then
    /// fdc/136, inr/311, blc/191, plst/2XM-114, plst/HOU-83, phou/83.
    #[test]
    fn the_tier_of_real_printings() {
        for (name, tier) in [
            // Plain printings of sets whose type is a default one.
            ("abrade_tdc_203", 0),
            ("abrade_inr_139", 0),
            ("abrade_2xm_114", 0),
            ("abrade_hou_83", 0),
            ("neheb_dreadhorde_champion_war_140", 0),
            ("neheb_dreadhorde_champion_dmc_125", 0),
            ("counterspell_dsc_114", 0),
            ("counterspell_cmm_81", 0),
            ("ultima_fin_38", 0),
            // The same shape in a commander set the measured table names: Bloomburrow Commander
            // and Foundations Commander print Abrade exactly as Tarkir: Dragonstorm Commander does.
            ("abrade_blc_191", 1),
            ("abrade_fdc_136", 1),
            // A treatment, a List reprint, a promo, a Secret Lair, a masterpiece.
            ("abrade_inr_311", 1),
            ("abrade_plst_2xm_114", 1),
            ("abrade_plst_hou_83", 1),
            ("abrade_phou_83", 1),
            ("neheb_dreadhorde_champion_pwar_140star", 1),
            ("neheb_dreadhorde_champion_pwar_140s", 1),
            ("neheb_dreadhorde_champion_sld_857", 1),
            ("ultima_pfin_38s", 1),
            ("ultima_fin_328", 1),
            ("ultima_pss5_1", 1),
            ("counterspell_cmm_630", 1),
            ("counterspell_mar_9", 1),
            ("counterspell_pf26_5", 1),
            // Not English: second-tier whatever the English row of its slot is.
            ("counterspell_dsc_114_ja", 1),
            ("counterspell_cmm_81_ja", 1),
            ("counterspell_mar_9_ja", 1),
        ] {
            assert_eq!(print_tier(&draft(name)), tier, "{name}");
        }
    }

    #[test]
    fn the_tier_table_parses_and_names_only_departures_from_the_set_type() {
        assert!(PRINT_TIERS.len() > 20);
        assert_eq!(set_tier("blc", "commander"), 1);
        assert_eq!(set_tier("tdc", "commander"), 0);
        assert_eq!(set_tier("gnt", "box"), 0);
        assert_eq!(set_tier("gn3", "box"), 1);
        assert_eq!(set_tier("30a", "memorabilia"), 2);
        assert_eq!(set_tier("a set nobody measured", "promo"), 1);
    }
}
