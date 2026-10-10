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
//! within its own card, 11 bits, leaving 11 whole and two fractional for the existing score to
//! ride underneath:
//!
//! ```text
//! prefer_score = (RANK_SPAN - 1 - rank) * RANK_STEP + prefer_score_as_before + (pinned ? PIN_BONUS : 0)
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
//!     `(RANK_SPAN - 1) * RANK_STEP` plus its own old score, so those comparisons still turn on
//!     the old score alone.
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
//! THE TIER IS TWO FACTS, AND FOUR CLASSES (2026-10-10). What was read as three tiers — default,
//! everything else, and "memorabilia, a gold border, an oversized card" last — is the pair
//! `(covered, extra)`: whether the printing is outside the default tier (`is:covered`, and every row
//! that is not English), and whether a search hides it unless it is asked for extras (`is:extra`).
//! A card's printings come back in the classes `(0,0)`, `(0,1)`, `(1,0)`, `(1,1)`, each newest first:
//!
//! ```text
//! Shivan Dragon        fdn/763 … lea/174 | sld/2759 … fbb/177 (fr) | 30a/170, 30a/467, j21/788,
//!                      o90p/5, cei/175, ced/175          — the Arena duplicate j21/788 of 2021 sits
//!                      among the memorabilia, by its date: covered AND an extra
//! Storm Crow           9ed/100 … all/36b | plst/POR-69, sld/60, plst/9ED-100 | ysos/31
//! Flametongue Kavu     dmr/120 … pls/60 | yeoe/41 | plst/PLS-60 (2026-11), dmr/320 …
//!                      — the Alchemy duplicate of 2025 AHEAD of a newer List printing: an extra
//!                      that is NOT covered is the second class, not part of the third
//! History of Benalia   dom/21 | ybro/31 (2023) | prm/99669 (2024), plst/DOM-21, pdom/21p, pdom/21s
//! ```
//!
//! Measured on 151 sequences read with their own `is:covered` and against the whole `is:extra`
//! list (10,905 printings): every card with an Arena-only or Alchemy extra beside served
//! printings, 62 with a foil-only List printing, 17 with an extra that is not covered, the two
//! token cards with a memorabilia printing, the oversized cards that are not extras (three
//! dungeons, the 2009-2011 oversized promos) and a sample of the 932 with memorabilia — 151 of
//! 151 in class order and date-descending inside each class. "Extras last" alone holds on 116 of
//! the first 135, and the three tiers on 7 of the 16 where an oversized printing is not an extra.
//! Both facts were already decided per row: [`recorded_tier`] and `transform::extras_class`.
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
//!     per-set table where it does not (`print_tiers.tsv`) — and, since 2026-10-09, from
//!     Scryfall's record of the printing itself where `is_lists.tsv` holds it ([`recorded_tier`]):
//!     these departures are exactly the rows `is:covered` lists against the rule.
//!   * `lang:any` interleaves the languages by date — mar/9, mar/9 in German, Spanish, French and
//!     Japanese, then dsc/114's translations — where this store pages a card's English rows
//!     before its others (the canonical and annex spaces of the sort key). The ranks are right
//!     for it; the page order is the sort key's, and is not this module's to change.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;

use crate::transform::{pin_key, PinKey, PinnedPrintings, RowDraft};

/// The number of ranks a card has, the last of them shared by every row past it: the worst-ranked
/// row of a card scores 0 from the rank term.
///
/// 2048 SINCE 2026-10-10, AND 1024 BEFORE IT. The five basic lands are the only cards that need
/// more than 1,024, and they need a third more: a default-tier slot's other languages rank apart
/// from its English row, so `Forest` is 956 slots and 1,380 ranks, `Mountain` 1,377, `Plains`
/// 1,353, `Island` 1,352, `Swamp` 1,344 (all_cards, 2026-10-10; the next card, Sol Ring, is 196).
/// Past the clamp a row fell back to the score underneath, so `!"Island" unique=prints` came back
/// in Scryfall's order for 745 rows and in no order for the 188 after them.
pub const RANK_SPAN: u32 = 2048;

/// What one rank step is worth. Must exceed everything that rides underneath it — the ordinary
/// `prefer_score` (~130-220) plus `PIN_BONUS` (1000) — so a better rank always wins outright;
/// 2048 is the next power of two above that 1250, and powers of two keep the product exact in an
/// f32. The largest rank term is `(RANK_SPAN - 1) * RANK_STEP`, 2^22 less one step, so the whole
/// score stays under 2^22: an f32 holds it to a quarter point there, which is what rank 0 — the
/// only rank the cross-card comparisons read — was held to under the span of 1024.
pub const RANK_STEP: f64 = 2048.0;

/// The rank term of `prefer_score`: rank 0 scores highest, and each further rank drops one step
/// down to the last, which scores nothing.
pub fn rank_term(rank: u32) -> f64 {
    f64::from(RANK_SPAN - 1 - rank.min(RANK_SPAN - 1)) * RANK_STEP
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

/// The tier a row is RANKED in: [`print_tier`], corrected by Scryfall's own record of the printing
/// where the measured table holds one.
///
/// `is:covered` IS THE DEFAULT TIER, ANSWERED BY NAME — a printing outside it is covered — and
/// `is_lists.tsv` holds every English row where that record and the shape rule differ (and, for a
/// set the nightly has read, every English row of it). Until 2026-10-09 the rank read the rule
/// alone, so each such row was tagged right and ORDERED wrong: the module doc's "a printing that
/// departs from its set stays wrong". Found on three variations, which a search hides unless it is
/// asked for them, so their place had never been read (`include_variations=true`, 2026-10-09):
///
/// ```text
/// Zilortha, Strength Incarnate   cmm/366, iko/275y, cmm/599, iko/275     here cmm/366, cmm/599, iko/275y, iko/275
/// Grafted Identity               mid/57, mid/57†, prm/93940, dbl/57 …    here mid/57† sixth, after pmid/57s
/// Supportive Parents             spm/119, om1/117†, om1/117              here om1/117 before om1/117†
/// ```
///
/// iko/275y and mid/57† are Arena-only and om1/117† sits in a set whose plain printings are
/// second-tier, so the rule says second tier for all three; `-is:covered` holds all three, and
/// each is in its card's FIRST run. Over the harvest ([`print_tier`]'s, read again with variations:
/// 36,821 rows), the 56 English rows the table lists whose sequence proves a tier:
///
/// ```text
/// listed NOT covered, the rule says second tier   33 of 33 in the default tier
///     (Dominaria Remastered's dmr/300-314, Jumpstart 2022's Rhystic Study, m3c/315 …)
/// listed covered, the rule says default tier      13 of 13 in the second
///     (lcc/317, the Lord of the Rings' ltr/262-271 and 332-339, Foundations' fdn/273 …)
/// listed NOT covered, an ALCHEMY set              10 of 10 in the second tier all the same
/// ```
///
/// — 28,049 of the 28,086 proven English rows in their tier, where the rule alone has 28,003. So
/// the record is read for an English row outside an Alchemy set, and it moves a row between the
/// first two tiers only: what puts a printing LAST (memorabilia, a gold border, an oversized card)
/// is not what `is:covered` records — planes, schemes and vanguard cards are oversized, last and
/// not covered — and a row that is not English is second-tier whatever the record says (the 3,226
/// rows of `-is:covered -lang:en`). Where the table says nothing, the rule stands.
///
/// The table is the one in force — the nightly's refreshed override when it is installed — so a
/// printing Scryfall moves between tiers is ranked where it was moved to by the next build.
pub fn recorded_tier(r: &RowDraft) -> u8 {
    let tier = print_tier(r);
    if tier == 2 || !r.raw_lang_en || r.raw_set_type.as_deref() == Some("alchemy") {
        return tier;
    }
    match crate::transform::covered_verdict(r) {
        Some(false) => 0,
        Some(true) => 1,
        None => tier,
    }
}

/// The CLASS a row is ranked in, `0..=3`: `2 * covered + extra` — see the module doc for the
/// measurement. `covered` is [`recorded_tier`]'s first-two-tiers verdict made a boolean, with the
/// two things that verdict set aside read as what they are:
///
///   * AN ALCHEMY SET'S RECORD COUNTS. `recorded_tier` left an Alchemy row to the shape rule
///     because the ten rows the table lists NOT covered there sat "in the second tier all the
///     same". They sit in the second CLASS: each is an Arena duplicate of a paper card, an extra,
///     and an extra that is not covered comes after the default printings and before every covered
///     one — History of Benalia's ybro/31 (2023) ahead of prm/99669 (2024).
///   * THE SHAPE'S "LAST" IS NOT A CLASS. Memorabilia, a gold border and an oversized card are
///     covered by the rule, and whether one is LAST is whether it is an extra: an oversized dungeon
///     or a 2009 oversized promo is served by default and ranks with the covered printings, and an
///     Arena duplicate with no mark on it at all ranks with the memorabilia.
///
/// A row that is not English is covered whatever the record says, as before.
pub fn rank_class(r: &RowDraft) -> u8 {
    let covered = !r.raw_lang_en || crate::transform::covered_verdict(r).unwrap_or_else(|| print_tier(r) != 0);
    u8::from(covered) * 2 + u8::from(r.is_extra())
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
    (RANK_SPAN - 1 - steps as u32, score - steps * RANK_STEP)
}

/// A printing slot of one card: `(released_at, set_code, collector_number)`.
type SlotKey = (String, String, String);

/// What the order needs to know about one printing slot's rows.
#[derive(Debug, Default, Clone)]
struct Slot {
    /// The class ([`rank_class`]) of the slot's English row, when it has one.
    english: Option<u8>,
    /// The classes its rows in other languages take — `[served rows, extras]`, each `None` where
    /// the slot has no such row.
    ///
    /// TWO, because one slot's languages need not agree on being an extra. Pradesh Gypsies carries
    /// Scryfall's content warning, which hides a printing by default, on its English, Spanish,
    /// Japanese and Portuguese 4th Edition rows and not on the Korean and Chinese ones; kept as one
    /// class the black-bordered slot took the Korean row's, and `4bb/265` in Spanish (1995-04)
    /// came back ahead of Renaissance's `ren/152` (1995-08), an extra like it and four months newer.
    foreign: [Option<u8>; 2],
    collector_number_int: Option<i64>,
}

/// Which rows of a slot an entry of the order ranks: its English row, its served rows in other
/// languages, or its extras in other languages. Also the index of that rank in [`RowRanks`].
type Half = usize;
const ENGLISH: Half = 0;
/// `FOREIGN + 0` the served rows, `FOREIGN + 1` the extras.
const FOREIGN: Half = 1;

/// One printing's ranks, by [`Half`].
type RowRanks = [u32; 3];

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
    /// The sealed answer: printing → the rank of its English row, of its served rows in other
    /// languages and of its extras in other languages. Keyed exactly as a pin is, so the two
    /// per-card facts a finalized row needs are asked in the same shape. The ranks differ where
    /// the halves are in different classes, or carry different dates — see `seal`.
    ranks: HashMap<PinKey, RowRanks>,
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
            let class = rank_class(r);
            let side = if r.raw_lang_en { &mut slot.english } else { &mut slot.foreign[usize::from(r.is_extra())] };
            *side = Some(side.map_or(class, |seen| seen.min(class)));
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
            // One entry per rank: a slot's English row, and each kind of its other languages that
            // does not share that row's class.
            let mut ordered: Vec<(&SlotKey, &Slot, u8, Half)> = Vec::with_capacity(slots.len());
            for (key, slot) in &slots {
                if let Some(class) = slot.english {
                    ordered.push((key, slot, class, ENGLISH));
                }
                for (kind, class) in slot.foreign.iter().enumerate() {
                    if let Some(class) = *class
                        && slot.english != Some(class)
                    {
                        ordered.push((key, slot, class, FOREIGN + kind));
                    }
                }
            }
            ordered.sort_unstable_by_key(|((released_at, set, cn), slot, class, half)| {
                let key: PinKey = (oracle_id.clone(), set.clone(), cn.clone());
                let date = released_at.replace('-', "").parse::<u32>().unwrap_or(0);
                // The label names one printing, and it is the English one wherever a slot has one.
                let pinned = pins.contains_key(&key) && (*half == ENGLISH || slot.english.is_none());
                (
                    u8::from(!pinned),
                    *class,
                    Reverse(released_at.clone()),
                    Reverse(card_engine::release_batch(date, set)),
                    set.clone(),
                    collector_order_key(slot.collector_number_int, cn),
                    *half,
                )
            });
            // A PRINTING IS (set, number), AND ITS LANGUAGES NEED NOT SHARE A DATE. The 30th
            // Anniversary History promos were handed out in Japan in September 2022 and in English
            // in March 2023, and Scryfall dates each row: `!"Shivan Dragon"` returns p30h/4 at
            // 2023-03-21, between p30t/2 and sld/716, and under `lang:any` its Japanese row at
            // 2022-09-09, after gn3/87 (2026-10-10). Two dates are two SLOTS of one printing, so
            // the rank of each half is the rank of an entry that HOLDS rows of that half — the
            // English one from a slot with an English row, the others' from a slot with theirs —
            // and only a half with no entry of its own borrows another's. Until 2026-10-10 the
            // Japanese-only slot wrote both halves and, sorting later, won: the English p30h/4
            // ranked at the Japanese date. 25 printings carry two dates (p30h 10, phpr 5, pl21 4,
            // pcbb 4, one each in cmm and dci).
            let mut ranks: HashMap<(&str, &str), [Option<u32>; 3]> = HashMap::with_capacity(slots.len());
            for (rank, ((_, set, cn), slot, class, half)) in ordered.into_iter().enumerate() {
                let entry = ranks.entry((set.as_str(), cn.as_str())).or_default();
                // `ordered` is best first, so the first entry seen for a half is its best rank.
                entry[half].get_or_insert(rank as u32);
                if half == ENGLISH {
                    // Its other languages share the rank where they share its class.
                    for (kind, other) in slot.foreign.iter().enumerate() {
                        if *other == Some(class) {
                            entry[FOREIGN + kind].get_or_insert(rank as u32);
                        }
                    }
                }
            }
            for ((set, cn), [english, served, extra]) in ranks {
                let row: RowRanks = [
                    english.or(served).or(extra).unwrap_or(RANK_SPAN),
                    served.or(extra).or(english).unwrap_or(RANK_SPAN),
                    extra.or(served).or(english).unwrap_or(RANK_SPAN),
                ];
                self.ranks.insert((oracle_id.clone(), set.to_owned(), cn.to_owned()), row);
            }
        }
    }

    /// `r`'s rank within its card. A row with no addressable slot ranks last, so it can never
    /// displace a printing the rule actually ordered.
    pub fn rank_of(&self, r: &RowDraft) -> u32 {
        let half = if r.raw_lang_en { ENGLISH } else { FOREIGN + usize::from(r.is_extra()) };
        pin_key(r).and_then(|k| self.ranks.get(&k)).map_or(RANK_SPAN, |ranks| ranks[half])
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
                    // A test slot's other languages are all of one kind: extras when their class
                    // is an extras class (odd), served rows otherwise.
                    let mut other = [None, None];
                    if let Some(class) = foreign {
                        other[usize::from(class & 1)] = Some(*class);
                    }
                    (
                        (date.to_string(), set.to_string(), cn.to_string()),
                        Slot { english: *english, foreign: other, collector_number_int },
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
            let ranks = r.ranks[&("o".to_owned(), set.to_string(), cn.to_string())];
            let (en, other) = (ranks[ENGLISH], ranks[FOREIGN + usize::from(foreign.unwrap_or(0) & 1)]);
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

    /// The four classes ([`rank_class`]): the default tier; an extra that is not covered; a
    /// covered printing; a covered extra.
    const A: Option<u8> = Some(0);
    const X: Option<u8> = Some(1);
    const B: Option<u8> = Some(2);
    const C: Option<u8> = Some(3);

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
        assert_eq!(r.ranks[&("o".to_owned(), "ren".to_owned(), "46".to_owned())], [0, 0, 0]);
        // The label is the ENGLISH row of the slot it names: that slot's other languages keep the
        // rank their date gives them.
        let mut pins = PinnedPrintings::default();
        pins.pin_slot_for_test(("o".to_owned(), "cmm".to_owned(), "81".to_owned()));
        let r = sealed(&[("2024-09-27", "dsc", "114", A, B), ("2023-08-04", "cmm", "81", A, B)], &pins);
        assert_eq!(r.ranks[&("o".to_owned(), "cmm".to_owned(), "81".to_owned())], [0, 3, 3]);
        assert_eq!(r.ranks[&("o".to_owned(), "dsc".to_owned(), "114".to_owned())], [1, 2, 2]);
    }

    #[test]
    fn the_classes_are_covered_then_extra_each_newest_first() {
        // Shivan Dragon, api.scryfall.com 2026-10-10: after the default printings and the covered
        // ones come 30a/170, 30a/467, j21/788, o90p/5, cei/175 — the Arena duplicate of 2021 among
        // the memorabilia, at its date. It is covered and an extra, as they are.
        assert_eq!(
            ranked(&[
                ("1998-01-01", "o90p", "5", C, None),
                ("2021-08-26", "j21", "788", C, None),
                ("2022-11-28", "30a", "170", C, None),
                ("2022-10-14", "gn3", "87", B, None),
                ("2024-11-15", "fdn", "206", A, None),
            ]),
            vec!["fdn/206", "gn3/87", "30a/170", "j21/788", "o90p/5"],
        );
        // History of Benalia: dom/21, then ybro/31 (2023), then prm/99669 (2024) and plst/DOM-21
        // (2020). The Alchemy duplicate is an extra Scryfall does NOT record as covered: it comes
        // before every covered printing, the newer Magic Online promo among them.
        assert_eq!(
            ranked(&[
                ("2020-09-26", "plst", "DOM-21", B, None),
                ("2024-03-27", "prm", "99669", B, None),
                ("2023-10-10", "ybro", "31", X, None),
                ("2018-04-27", "dom", "21", A, None),
            ]),
            vec!["dom/21", "ybro/31", "prm/99669", "plst/DOM-21"],
        );
    }

    #[test]
    fn a_printing_whose_languages_carry_two_dates_ranks_each_at_its_own() {
        // The 30th Anniversary History promo of Shivan Dragon: Japanese 2022-09-09, English
        // 2023-03-21. api.scryfall.com 2026-10-10 answers sld/1709, p30t/2 (ja), p30h/4, sld/716,
        // dmr/329, gn3/87 — the English row at ITS date — and, with every language, p30h/4 in
        // Japanese after gn3/87. Either input order: the Japanese slot used to write both halves.
        let slots = [
            ("2024-06-24", "sld", "1709", B, None),
            ("2023-03-21", "p30h", "4", B, None),
            ("2022-09-09", "p30h", "4", None, B),
            ("2023-02-21", "sld", "716", B, None),
            ("2022-10-14", "gn3", "87", B, None),
        ];
        let want = vec!["sld/1709", "p30h/4", "sld/716", "gn3/87", "p30h/4:x"];
        assert_eq!(ranked(&slots), want);
        let mut reversed = slots;
        reversed.reverse();
        assert_eq!(ranked(&reversed), want);
    }

    #[test]
    fn a_slots_other_languages_rank_apart_where_only_some_are_extras() {
        // Pradesh Gypsies, api.scryfall.com 2026-10-10: 4ed/265, leg/197, ren/152 (fr), 4bb/265
        // (es) — every one an extra by its content warning, the Renaissance printing the newer.
        // The black-bordered slot's Korean and Chinese rows carry no warning and are served; they
        // rank with the covered printings, and the Spanish row does not ride with them.
        let mut r = PrintingRanks::default();
        let slot = |english, foreign| Slot { english, foreign, collector_number_int: Some(265) };
        r.slots.insert(
            "o".to_owned(),
            [
                (("1995-04-01".to_owned(), "4ed".to_owned(), "265".to_owned()), slot(X, [None, C])),
                (("1995-08-01".to_owned(), "ren".to_owned(), "152".to_owned()), slot(None, [None, C])),
                (("1995-04-01".to_owned(), "4bb".to_owned(), "265".to_owned()), slot(None, [B, C])),
            ]
            .into_iter()
            .collect(),
        );
        r.seal(&PinnedPrintings::default());
        let ranks = |set: &str, cn: &str| r.ranks[&("o".to_owned(), set.to_owned(), cn.to_owned())];
        // 4ed/265 in English, 4bb/265 in Korean, ren/152, then 4bb/265 in Spanish and 4ed/265's
        // translations by set code.
        assert_eq!(ranks("4ed", "265")[ENGLISH], 0);
        assert_eq!(ranks("4bb", "265")[FOREIGN], 1);
        assert_eq!(ranks("ren", "152")[FOREIGN + 1], 2);
        assert_eq!(ranks("4bb", "265")[FOREIGN + 1], 3);
        assert_eq!(ranks("4ed", "265")[FOREIGN + 1], 4);
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

    /// The tier a row is RANKED in is Scryfall's record of it where `is_lists.tsv` holds one
    /// (api.scryfall.com 2026-10-09: `-is:covered` holds the first five, `is:covered` the next
    /// three), and the rule's wherever the record is not about the first two tiers.
    #[test]
    fn the_recorded_tier_of_real_printings() {
        for (name, rule, recorded) in [
            // Arena-only variations of expansion printings: second-tier by their shape, and in
            // their cards' first run.
            ("zilortha_strength_incarnate_iko_275y", 1, 0),
            ("grafted_identity_mid_57_dagger", 1, 0),
            // A variation in a set whose plain printings are second-tier (print_tiers.tsv).
            ("supportive_parents_om1_117_dagger", 1, 0),
            // The departures the module doc names: Jumpstart 2022's Rhystic Study, and Wayfarer's
            // Bauble in Modern Horizons 3 Commander, a ripple foil at that.
            ("rhystic_study_j22_114", 1, 0),
            ("wayfarers_bauble_m3c_315", 1, 0),
            // ...and its Lost Caverns Commander printing, the other way; Heroes of the Realm 2018
            // whole, the variation with the rest (a `funny` set nobody measured, default by type).
            ("wayfarers_bauble_lcc_317", 0, 1),
            ("the_legend_of_arena_ph18_4", 0, 1),
            ("the_legend_of_arena_ph18_4_dagger", 0, 1),
            // Not the record's to say. An ALCHEMY printing is listed not covered and sits in its
            // card's second run (Black Lotus: ydmu/35 after vma/4 and the Alpha printings); an
            // oversized plane is listed not covered, and what puts a printing last is its shape.
            ("black_lotus_ydmu_35", 1, 1),
            ("academy_at_tolaria_west_ohop_1", 2, 2),
            // Where the table says nothing, the rule.
            ("zilortha_strength_incarnate_cmm_366", 0, 0),
            ("zilortha_strength_incarnate_iko_275", 1, 1),
            ("supportive_parents_om1_117", 1, 1),
        ] {
            let draft = draft(name);
            assert_eq!((print_tier(&draft), recorded_tier(&draft)), (rule, recorded), "{name}");
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
