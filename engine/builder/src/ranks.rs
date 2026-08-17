//! WHICH PRINTING REPRESENTS A CARD INSIDE A FILTER, as a per-card rank.
//!
//! `unique=cards` returns one printing per card, and `prefer_score` decides which. Where
//! Scryfall's `oracle_cards` label names a printing, [`transform::PIN_BONUS`] pins it and the
//! answer is exact. The gap this module closes is the other case: a query whose filter EXCLUDES
//! the pinned printing (`e:khm` for a card whose global representative lives elsewhere), where
//! Scryfall falls back to a rule of its own.
//!
//! THE RULE, MEASURED. 16,045 labelled observations were harvested from api.scryfall.com on
//! 2026-08-16 by asking it for its own answer in bulk — `e:<set>`, `a:"<artist>"` and
//! filter-shaped scopes under `unique=cards`, each candidate set reconstructed from the bulk
//! corpus and validated against that scope's own `total_cards` (23 scopes whose reconstruction
//! disagreed were discarded rather than trusted). 156 scopes, 24,943 pairwise "X beat Y here"
//! constraints over 10,557 cards. Two results:
//!
//!   * A FIXED PER-PRINTING ORDER SUFFICES. Kahn's algorithm over all 24,943 constraints finds
//!     0 of 10,557 cards contradicting any total order — so this is expressible as a score at
//!     all, which is the thing that had been in doubt.
//!   * THE ORDER IS `pin, then released_at DESC, then collector number ASC` — the three keys this
//!     harvest could see. Two more were added later on evidence it could not; see THE TWO KEYS
//!     ADDED AFTER THIS HARVEST below, which is where the order as shipped is written out.
//!
//!     ```text
//!     rule                                all    set  artist   misc | pin in scope  pin EXCLUDED
//!     pin > prefer_score (before this)  .8493  .8617   .8992  .5982 |        .9999         .6594
//!     pin > collector number asc        .9436  .9648   .9022  .7881 |        .9999         .8726
//!     pin > released newest             .6163  .5660   .9475  .4798 |        .9999         .1325
//!     pin > released newest > cn asc    .9833  .9874   .9632  .9798 |        .9999         .9624
//!     ```
//!
//!     Neither half works alone — recency is 13% by itself and only becomes right once the pin
//!     has taken the cards it names. Greedy lexicographic induction over 128 comparators (every
//!     printing field, promo-type flags, external ids, set-level dates) reaches .9852 by adding
//!     `n_games`/`arena_id`/`rarity` terms, but those LOSE on scopes held out from the search
//!     (.9736 against .9774), so they are overfitting and are not here.
//!
//! THE TWO KEYS ADDED AFTER THIS HARVEST. The shipped order is five keys, not three:
//!
//! ```text
//! pin ASC > NOT has_english > cn HAS AN ALPHABETIC PREFIX > released_at DESC > cn_sort_key ASC
//! ```
//!
//!   * `has_english` — A SLOT WITH NO ENGLISH PRINTING SORTS AFTER ONE WITH. The harvest above
//!     could not see this: ranking is over DISTINCT slots, so `prefer_score`'s `+40` language term
//!     orders the languages WITHIN a slot and nothing ordered them ACROSS slots. `RANK_STEP` is
//!     2048, so no term riding underneath a rank can ever cross one — a set printed only in a
//!     foreign language therefore won on date alone. Four narrowed pairs, measured live against
//!     api.scryfall.com on 2026-08-17, one request each; Scryfall keeps an English printing in
//!     all four:
//!
//!     ```text
//!     Active Volcano        leg/130:en  bchr/43:ja  chr/43:en   -> chr/43:en   (was bchr/43:ja)
//!     Abomination           leg/87:en   4bb/117:es  ren/46:fr   -> leg/87:en   (was ren/46:fr)
//!     Abyssal Specter       8ed/117:en  ddc/40:en   ps11/60:es  -> ddc/40:en   (was ps11/60:es)
//!     Darksteel Juggernaut  som/150:en  pmei/2010-1:ja          -> som/150:en  (was pmei/…:ja)
//!     ```
//!
//!     The fix is a KEY, not a bigger bonus: raising `+40` toward 2048 would be fitting a constant
//!     to four observations, and it would also drag the language term across the OTHER components
//!     it is deliberately smaller than. Note `bchr/43` and `chr/43` share a release date AND a
//!     collector number, so before this key the two slots were separated by nothing at all — an
//!     exact tie under `sort_unstable_by_key`, which is not even deterministic.
//!
//!   * `cn prefix` — A COLLECTOR NUMBER WITH AN ALPHABETIC PREFIX SORTS AFTER ONE WITHOUT.
//!     `plst/USG-4` loses to `usg/4`, `plst/MMA-196` to `mma/196`, `sld/901` to `2x2/361`. Derived
//!     over 20,321 labelled decisions (three corpora: 18,638 reconstructed `unique=cards` merges,
//!     2,748 adjacent pairs of Scryfall's own `unique=prints order=name` order, and 1,683
//!     decisions over ten scopes chosen AFTER the rule was fitted). On those ten fresh scopes it
//!     scores .9346 against today's .9156, and beats the hardcoded `plst` demotion below (.9323)
//!     which it therefore replaces on the merits rather than on taste. It fires on 6.57% of
//!     English printings. The BOOLEAN only: `cn_prefix ASC` as an ordering scores .9120 -> .8961,
//!     because among two prefixed numbers the date is right and the prefix is not. Do NOT add
//!     `booster`, `digital`, `promo`, `promo_types` or `frame_effects` — `cn-prefix OR NOT
//!     booster` scores higher on the fitting corpus and LOWER on the fresh scopes, which is what a
//!     holdout drawn from the same scope family fails to catch.
//!
//! WHY LANGUAGE OUTRANKS THE PREFIX, which no measurement decides. Scryfall's default search is
//! English-only, so every corpus the prefix key was fitted on is English throughout and cannot
//! constrain the two against each other. Putting `has_english` first leaves the prefix key's
//! measured gain exactly intact — within an English scope `has_english` is constant, so the prefix
//! is the effective first non-pin key — while the other order would let a prefixed ENGLISH slot
//! lose to an unprefixed foreign-only one, which is the thing the four pairs above refute.
//!
//! `released_at ASC` IS REFUTED, not merely unchosen: on 17,776 pairwise constraints DESC is right
//! 11,003 and wrong 2,038, and ASC is the mirror. And the residual is ONE-SIDED — of the decisions
//! `pin > released DESC > cn ASC` gets wrong, the printing Scryfall keeps is OLDER in 1,114 and
//! NEWER in 0 — so whatever is still missing demotes printings, it does not reorder dates. What is
//! left after these five keys is proven non-derivable: every one of 254 candidate keys, in both
//! directions, orders at least one observed adjacent pair backwards.
//!
//! WHY A RANK AND NOT A FORMULA. `prefer_score` is an `f32` and the archive sorts printings on
//! `!f32_sort_bits(prefer_score)`, so whatever this rule is, it has to fit 24 bits of mantissa.
//! It does not: `released_at` spans 1,279 distinct values, and collector numbers reach 105,882
//! with 483 distinct suffixes — about 37 bits together. What DOES fit is the rank of the printing
//! within its own card, because a card has at most 949 distinct printing slots (`Forest`), 10
//! bits, leaving 14 for the existing score to ride underneath:
//!
//! ```text
//! prefer_score = (RANK_SPAN - rank) * RANK_STEP + prefer_score_as_before + (pinned ? PIN_BONUS : 0)
//! ```
//!
//! Three properties come out of that shape, and each is a thing that must not move:
//!
//!   * THE PINNED ANSWER IS UNCHANGED. `pinned` is the FIRST key of the rank order, so a pinned
//!     printing is rank 0 and wins every filter that contains it — bit for bit what PIN_BONUS
//!     did alone. That answer is known-exact (.9999 measured); it is not traded for a fitted one.
//!   * ENGLISH STILL LEADS ITS OWN SLOT. Ranking is over DISTINCT `(released_at, set, collector
//!     number)` slots, so a card's several languages of one printing share a rank and fall
//!     through to the old score, whose `+40` language term orders them exactly as before. The
//!     `has_english` key above is what orders slots ACROSS that collapse; it does not reach inside
//!     one, and the DISTINCT slot key is unchanged.
//!   * CROSS-CARD ORDER IS UNTOUCHED. `cards_containing_all_words` and `exact_card_by_name` rank
//!     CARDS by their chosen printing's score; every rank-0 printing carries
//!     `RANK_SPAN * RANK_STEP` plus its own old score, so those comparisons still turn on the old
//!     score alone. The one cost is precision: at this magnitude an f32 step is 0.25, so two old
//!     scores closer together than that (the `illustration_count` term's 4th decimal) now tie.
//!
//! WHAT IT STILL GETS WRONG, measured rather than guessed — 3.8% overall, 96.24% of the
//! pin-excluded class:
//!
//!   * THE LIST AND SECRET LAIR REPRINTS — LARGELY CLOSED by the `cn prefix` key above, which is
//!     what `plst/USG-4` losing to `usg/4` and `sld/901` losing to `2x2/361` were both instances
//!     of. What survives it is `plst` beating the REMASTERS whose collector numbers are bare —
//!     `klr`, `akr` (digital) and `tsr`, `sir`, `sis` (paper) — plus the `cmm`-vs-`mb2` class.
//!     `digital` as a companion key does not fix it and makes the whole rule worse (.9468 against
//!     .9616), so those stay, and by the 254-key sweep they stay for good.
//!   * SAME-SET, SAME-DATE VARIANT BLOCKS. In `znr`/`mkm`/`dsk`/`otj` the non-full-art basic
//!     beats lower-numbered full-art ones; in `ltr` the November scroll basics beat the June
//!     ones (recency, right) while November's showcase `Battle-Scarred Goblin` loses to June's
//!     (recency, wrong). `image_status`, `full_art`, `booster` and `promo_types` each explain
//!     part of this class and none of them generalises.

use std::cmp::Reverse;
use std::collections::HashMap;

use crate::transform::{pin_key, PinKey, PinnedPrintings, RowDraft};

/// Ranks are clamped to this, and it is the multiplier's ceiling: the worst-ranked printing of a
/// card scores 0 from the rank term. 1024 because the largest card in the corpus has 949 distinct
/// printing slots (`Forest`, measured 2026-08-16) — the clamp is a backstop, not a working limit.
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

/// A collector number ordered the way a person reads it: `9` before `10`, and `239` before
/// `239★`. Splitting leading non-digits / digits / remainder is what separates `USG-4` from `4`
/// and keeps `p`/`s`/`★` suffixes of one number together and in a stable order.
///
/// A number with no digits at all sorts last within its prefix, which is what `u64::MAX` buys.
pub fn cn_sort_key(cn: &str) -> (String, u64, String) {
    let digits_at = cn.find(|c: char| c.is_ascii_digit());
    let Some(start) = digits_at else {
        return (cn.to_owned(), u64::MAX, String::new());
    };
    let end = cn[start..]
        .find(|c: char| !c.is_ascii_digit())
        .map_or(cn.len(), |i| start + i);
    (
        cn[..start].to_owned(),
        cn[start..end].parse::<u64>().unwrap_or(u64::MAX),
        cn[end..].to_owned(),
    )
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

/// Where each printing SLOT sits in its card's order.
///
/// Filled by the same per-card pass every import path already makes for [`PinnedPrintings`] —
/// `observe` per row as the corpus streams, then `seal` once the pins are known, because whether
/// a slot is pinned is the first thing the order asks and that is not knowable until the labelled
/// row has gone past.
#[derive(Debug, Default, Clone)]
pub struct PrintingRanks {
    /// oracle_id → its distinct `(released_at, set_code, collector_number)` slots, each mapped to
    /// whether ANY row in that slot is English. DISTINCT is what collapses a printing's languages
    /// onto one rank; see the module doc. The flag is the slot-level residue of that collapse —
    /// the one thing about the languages a slot swallows that its ORDER still needs.
    slots: HashMap<String, HashMap<(String, String, String), bool>>,
    /// The sealed answer: slot → rank. Keyed exactly as a pin is, so the two per-card facts a
    /// finalized row needs are asked in the same shape.
    ranks: HashMap<PinKey, u32>,
    sealed: bool,
}

impl PrintingRanks {
    /// Record `r`'s slot. Cheap enough to call per row; a row with no set code or no collector
    /// number has no addressable slot and is skipped, exactly as the pin skips it.
    pub fn observe(&mut self, r: &RowDraft) {
        if let (Some(set), Some(cn)) = (r.card_set_code.as_ref(), r.collector_number.as_ref()) {
            *self
                .slots
                .entry(r.oracle_id.clone())
                .or_default()
                .entry((r.released_at.clone(), set.clone(), cn.clone()))
                .or_default() |= r.raw_lang_en;
        }
    }

    /// Order every card's slots and freeze the ranks. Idempotent — a phase's last slice can be
    /// retried — and it consumes the slot table, which is the larger of the two.
    pub fn seal(&mut self, pins: &PinnedPrintings) {
        if self.sealed {
            return;
        }
        self.sealed = true;
        for (oracle_id, slots) in std::mem::take(&mut self.slots) {
            let mut ordered: Vec<_> = slots.into_iter().collect();
            ordered.sort_unstable_by_key(|((released_at, set, cn), has_english)| {
                let key: PinKey = (oracle_id.clone(), set.clone(), cn.clone());
                (
                    u8::from(!pins.contains_key(&key)),
                    u8::from(!has_english),
                    u8::from(!cn_sort_key(cn).0.is_empty()),
                    Reverse(released_at.clone()),
                    cn_sort_key(cn),
                )
            });
            for (rank, ((_, set, cn), _)) in ordered.into_iter().enumerate() {
                self.ranks.insert((oracle_id.clone(), set, cn), rank as u32);
            }
        }
    }

    /// `r`'s rank within its card. A row with no addressable slot ranks last, so it can never
    /// displace a printing the rule actually ordered.
    pub fn rank_of(&self, r: &RowDraft) -> u32 {
        pin_key(r).and_then(|k| self.ranks.get(&k).copied()).unwrap_or(RANK_SPAN)
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
    fn collector_numbers_order_the_way_a_person_reads_them() {
        let mut v = vec!["10", "9", "239★", "239", "USG-4", "4", "1a", "1b"];
        v.sort_by_key(|c| cn_sort_key(c));
        assert_eq!(v, vec!["1a", "1b", "4", "9", "10", "239", "239★", "USG-4"]);
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

    /// The five-key order, exercised through `seal` rather than restated — a slot table in, a rank
    /// per slot out. `pins` is empty, so every case below is the pin-EXCLUDED class the two new
    /// keys were measured on.
    fn ranked(slots: &[(&str, &str, &str, bool)]) -> Vec<String> {
        let mut r = PrintingRanks::default();
        r.slots.insert(
            "o".to_owned(),
            slots
                .iter()
                .map(|(date, set, cn, en)| ((date.to_string(), set.to_string(), cn.to_string()), *en))
                .collect(),
        );
        r.seal(&PinnedPrintings::default());
        let mut out: Vec<_> = r.ranks.iter().map(|((_, set, cn), rank)| (*rank, format!("{set}/{cn}"))).collect();
        out.sort_unstable();
        out.into_iter().map(|(_, s)| s).collect()
    }

    #[test]
    fn a_foreign_only_slot_loses_to_an_english_one_it_outdates() {
        // C1's Active Volcano, which is the sharpest of the four: bchr/43 and chr/43 share a
        // release date AND a collector number, so before the language key the two slots were
        // separated by nothing at all and the winner was whatever the unstable sort landed on.
        assert_eq!(
            ranked(&[
                ("1994-06-01", "leg", "130", true),
                ("1995-07-01", "bchr", "43", false),
                ("1995-07-01", "chr", "43", true),
            ]),
            vec!["chr/43", "leg/130", "bchr/43"],
        );
        // Darksteel Juggernaut: the foreign slot is genuinely NEWER, so this is the key beating
        // recency rather than breaking a tie.
        assert_eq!(
            ranked(&[("2010-10-01", "som", "150", true), ("2010-12-01", "pmei", "2010-1", false)]),
            vec!["som/150", "pmei/2010-1"],
        );
    }

    #[test]
    fn an_alpha_prefixed_collector_number_sorts_after_a_bare_one_it_outdates() {
        // `plst/USG-4` (2024) is the newest Angelic Page and Scryfall keeps `usg/4` (1998).
        assert_eq!(
            ranked(&[("2024-09-01", "plst", "USG-4", true), ("1998-10-12", "usg", "4", true)]),
            vec!["usg/4", "plst/USG-4"],
        );
        // `2010-1` is NOT prefixed — the digits start at byte 0 — so this pair is decided by the
        // date alone, which is what keeps the key from catching every dashed number.
        assert_eq!(
            ranked(&[("2010-12-01", "pmei", "2010-1", true), ("1998-10-12", "usg", "4", true)]),
            vec!["pmei/2010-1", "usg/4"],
        );
    }

    #[test]
    fn language_outranks_the_prefix_and_the_pin_outranks_both() {
        // The composition order, on one card: a prefixed ENGLISH slot beats an unprefixed
        // foreign-only one (this is the choice no corpus could make, see the module doc), and a
        // pin beats everything regardless of either.
        assert_eq!(
            ranked(&[("2024-09-01", "plst", "USG-4", true), ("2025-01-01", "ren", "46", false)]),
            vec!["plst/USG-4", "ren/46"],
        );
        let mut pins = PinnedPrintings::default();
        pins.pin_slot_for_test(("o".to_owned(), "ren".to_owned(), "46".to_owned()));
        let mut r = PrintingRanks::default();
        r.slots.insert(
            "o".to_owned(),
            [
                (("2024-09-01".to_owned(), "plst".to_owned(), "USG-4".to_owned()), true),
                (("2025-01-01".to_owned(), "ren".to_owned(), "46".to_owned()), false),
            ]
            .into_iter()
            .collect(),
        );
        r.seal(&pins);
        assert_eq!(r.ranks[&("o".to_owned(), "ren".to_owned(), "46".to_owned())], 0);
    }

    #[test]
    fn ranks_clamp_rather_than_underflow() {
        assert_eq!(rank_term(RANK_SPAN), 0.0);
        assert_eq!(rank_term(RANK_SPAN + 5_000), 0.0);
    }
}
