//! Scryfall bulk card object → engine row.
//!
//! Port of `vendor/sylvan_librarian/api/card_processing.py` (`preprocess_card`
//! and its helpers) composed with what the Postgres round-trip adds on top:
//!
//! - The engine is fed by `SELECT {ENGINE_COLUMNS} FROM magic.cards`
//!   (api/api_resource.py `_reload_engine`, line ~993; `get_cards.sql` is the
//!   same `SELECT *` shape). `ENGINE_COLUMNS`
//!   (card_engine/card_engine/__init__.py lines 40-84) is therefore the exact
//!   key set each emitted row carries, and `card_from_pydict`
//!   (card_engine/src/lib.rs line 721) is the consumer every field is checked
//!   against.
//! - Rows conflict on `scryfall_id` with last-wins dedupe
//!   (api/db/bulk_upsert.py `_dedupe_rows` + `_upsert_cards`
//!   `conflict_target=["scryfall_id"]`, covered by upstream's
//!   `test_duplicate_scryfall_id_in_batch_last_wins`). Multi-face cards share
//!   the parent's `id`, so the LAST face that survives preprocessing is the row
//!   the database — and thus the engine — ends up with.
//! - `prefer_score` is recomputed on every import by
//!   `api/sql/backfill_prefer_scores.sql`; `cubecobra_score` by
//!   `api/sql/backfill_cubecobra_scores.sql` (both invoked from
//!   `_run_import_under_lock`, api_resource.py lines 1045-1046). Both are
//!   ported in [`finalize`].
//! - `card_oracle_tags` / `card_art_tags` are attached from the tag bulk dumps
//!   (api/tag_import.py, ported in `tags.rs`). `card_is_tags` carries only the
//!   [`BOOLEAN_IS_TAGS`] subset, which `_sync_boolean_is_tags` derives from the
//!   bulk card's own booleans after each upsert; upstream's CUSTOM_IS_TAGS need
//!   a per-tag Scryfall search sweep that no automated import runs, so they stay
//!   absent on both sides.

use std::collections::BTreeSet;
use std::collections::HashMap;

use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::canonical_combining_class;

use crate::tags::TagData;

/// `is:` values Scryfall ships as BOOLEANS on every bulk card object, as
/// `(card_is_tags key, raw blob key)`. Mirrors db_info.BOOLEAN_IS_TAGS, which is also what the
/// parser reads to decide whether an `is:` value has data behind it at all
/// (`rewrite.SUPPORTED_IS_VALUES`) — an entry added on one side and not the other turns a working
/// predicate into a warned no-match, or the reverse.
///
/// `promo`/`reprint`/`foil` were held back once over their cardinality. THE MEMORY QUESTION THAT
/// DEFERRED THEM IS ANSWERED, by building the same 2026-08-16 corpus (31,724 cards / 517,746 rows)
/// four times over and weighing the nine archives:
///
/// | stored `is:` vocabulary                     | archives   | vs 3 entries    |
/// |---------------------------------------------|------------|-----------------|
/// | 3 (reserved, gamechanger, oversized)        | 363.02 MiB | --              |
/// | 6 (+ promo, reprint, foil)                  | 364.17 MiB | +1.16 / +0.32%  |
/// | 27 (full, minus booster/hires/nonfoil)      | 370.79 MiB | +7.77 / +2.14%  |
/// | 30 (full, this table + ARRAY_IS_TAGS)       | 372.68 MiB | +9.66 / +2.66%  |
///
/// The intuition the deferral was built on is BACKWARDS, and the fourth build is what shows it:
/// `booster`, `hires` and `nonfoil` are the three densest tags in the vocabulary -- 28k, 33k and
/// 34k cards, the last of them 99.8% of the corpus -- and together they cost 1.89 MiB, a fifth of
/// the growth. The 24 mid-density tags cost 6.61 MiB. Density is CHEAP here: past the storage
/// crossover a value is a bitmap plane (one bit per row) rather than a posting list (four bytes
/// per row), so the expensive tag is the one carried by a few thousand printings, not by all of
/// them. Nothing in this table is disproportionate on those terms; the whole vocabulary is 2.66%.
///
/// `foil` is Scryfall's deprecated top-level boolean and says the same thing as `finishes`
/// containing "foil"; reading the boolean keeps every entry here on the one shape upstream's
/// `_sync_is_tags` can express in SQL.
const BOOLEAN_IS_TAGS: &[(&str, &str)] = &[
    ("booster", "booster"),
    ("digital", "digital"),
    ("foil", "foil"),
    ("fullart", "full_art"),
    ("gamechanger", "game_changer"),
    ("hires", "highres_image"),
    ("nonfoil", "nonfoil"),
    ("oversized", "oversized"),
    ("promo", "promo"),
    ("reprint", "reprint"),
    ("reserved", "reserved"),
    ("spotlight", "story_spotlight"),
    ("textless", "textless"),
    ("variation", "variation"),
];

/// `is:` values Scryfall ships as membership in a bulk ARRAY, as
/// `(card_is_tags key, raw blob array key, member)`. Mirrors db_info.ARRAY_IS_TAGS; upstream's
/// `_sync_is_tags` asks the same question in SQL with jsonb's `?` containment operator.
///
/// Every mapping was established by READING the cards Scryfall returns rather than by guessing
/// the spelling: `is:X` was fetched from api.scryfall.com on 2026-08-16 and the `promo_types`
/// arrays of the results intersected. That is what turns `is:judge` into `judgegift`, and what
/// separates `is:stamped` from the broader `promopack` its results also all carry.
const ARRAY_IS_TAGS: &[(&str, &str, &str)] = &[
    ("boosterfun", "promo_types", "boosterfun"),
    ("buyabox", "promo_types", "buyabox"),
    ("convention", "promo_types", "convention"),
    ("datestamped", "promo_types", "datestamped"),
    ("etched", "finishes", "etched"),
    ("fnm", "promo_types", "fnm"),
    ("gameday", "promo_types", "gameday"),
    ("giftbox", "promo_types", "giftbox"),
    ("glossy", "promo_types", "glossy"),
    ("instore", "promo_types", "instore"),
    ("judge", "promo_types", "judgegift"),
    ("league", "promo_types", "league"),
    ("prerelease", "promo_types", "prerelease"),
    ("rebalanced", "promo_types", "rebalanced"),
    ("release", "promo_types", "release"),
    ("stamped", "promo_types", "stamped"),
    ("universesbeyond", "promo_types", "universesbeyond"),
];

/// Scryfall's set_type for products that are collectible objects rather than tournament-legal
/// printings. Mirrors api/card_processing.py's MEMORABILIA_SET_TYPE.
const MEMORABILIA_SET_TYPE: &str = "memorabilia";

#[derive(Debug, thiserror::Error)]
pub enum TransformError {
    /// A field upstream reads unconditionally (KeyError → whole import aborts)
    /// or that the DB requires NOT NULL. Mirrors upstream's abort-on-error
    /// behaviour in `_upsert_cards` rather than silently skipping the card.
    #[error("card {card:?} is missing required field {field:?}")]
    MissingField { card: String, field: &'static str },
    #[error("card {card:?} field {field:?} has unexpected type")]
    BadType { card: String, field: &'static str },
}

/// One preprocessed printing row plus the raw-blob inputs the prefer-score
/// backfill reads. ~100k of these are held in memory during aggregation on
/// the native path; the wasm (Durable Object) import serializes each draft
/// out to external storage instead — hence the serde derives.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RowDraft {
    // ── engine columns (ENGINE_COLUMNS) ─────────────────────────────────────
    pub scryfall_id: String,
    pub oracle_id: String,
    pub illustration_id: Option<String>,
    pub card_name: String,
    pub card_name_folded: String,
    pub oracle_text: Option<String>,
    pub flavor_text: String,
    pub card_artist: Option<String>,
    /// The artist lowercased and accent-folded, exactly as `card_name_folded` is. The engine
    /// has no NFKD of its own, so `order=artist`'s collation can only fold if the fold arrives
    /// with the row -- see card_engine's `artist_vocab_folded`.
    pub card_artist_folded: Option<String>,
    pub card_set_code: Option<String>,
    pub card_layout: Option<String>,
    pub card_border: Option<String>,
    pub card_watermark: Option<String>,
    /// Scryfall's `life_modifier` / `hand_modifier` — the two starting-total deltas a Vanguard
    /// avatar prints, carried VERBATIM as the signed strings Scryfall writes ("+7", "-3", "+0").
    ///
    /// Vanguard-only and card-level, both measured over the whole 2026-08-16 all_cards bulk: 119
    /// printings carry them, every one of layout `vanguard`, every one carrying both, and the pair
    /// is constant across every printing of each of the 107 oracle cards. Nothing else in the
    /// corpus — no layout, no set, no language — carries either key.
    pub life_modifier: Option<String>,
    pub hand_modifier: Option<String>,
    pub collector_number: Option<String>,
    pub collector_number_int: Option<i64>,
    pub mana_cost_text: Option<String>,
    pub type_line: Option<String>,
    pub set_name: Option<String>,
    pub released_at: String,
    pub card_colors: Vec<String>,
    pub color_indicator: Vec<String>,
    pub card_color_identity: Vec<String>,
    pub produced_mana: Vec<String>,
    pub card_keywords: Vec<String>,
    pub card_keywords_printed: Vec<String>,
    /// The BOOLEAN_IS_TAGS whose bulk-card boolean is true (api_resource.py
    /// `_sync_boolean_is_tags`). Only these are derivable from bulk data;
    /// every other `is:` tag still needs upstream's per-tag Scryfall sweep.
    pub card_is_tags: Vec<String>,
    pub card_types: Vec<String>,
    pub card_subtypes: Vec<String>,
    pub card_legalities: Map<String, Value>,
    pub card_frame_data: Vec<String>,
    pub mana_cost_jsonb: Vec<(String, u32)>,
    /// A DECIMAL, not an integer. Scryfall types cmc Decimal and means it -- the half-mana
    /// symbol {HW} gives Little Girl a mana value of exactly 0.5 -- and this field is where the
    /// Postgres `cmc` column sits in upstream's shape, so it is where an integer would silently
    /// round it to 0. Upstream made the same change in the column type (#923,
    /// api/db/2026-08-12-01-fractional-mana-value.sql: `integer` -> `real`).
    pub cmc: Option<f64>,
    /// FRACTIONAL, for the same reason `cmc` above is: eleven Unhinged cards print a HALF power
    /// or toughness (`Little Girl` is `.5`/`.5`, `Smart Ass` `2.5`/`1`, `Assquatch` `3.5`/`3.5`),
    /// and an integer column silently truncates each to the value it rounds down to — where it
    /// then wrongly ANSWERS that value. Measured on api.scryfall.com 2026-08-17: `tou=0` is 432
    /// there and was 433 here (Little Girl), `pow=2` 5730 against 5733 (Smart Ass, Stone-Cold
    /// Basilisk, Vile Bile). Every fraction in the corpus is a half, so nothing finer is needed —
    /// but a float is what upstream's `cmc` migration already chose for this exact bug, and a
    /// second convention (a scaled integer) would need a x2 at every read site to stay right.
    pub creature_power: Option<f64>,
    pub creature_toughness: Option<f64>,
    pub creature_power_text: Option<String>,
    pub creature_toughness_text: Option<String>,
    pub planeswalker_loyalty: Option<i64>,
    /// The PRINTED loyalty (upstream line 408: `card["planeswalker_loyalty_text"] =
    /// card.get("loyalty")`). The integer above is what `loy:` filters on and cannot hold "X"
    /// (Nissa, Steward of Elements) or "1+*".
    pub planeswalker_loyalty_text: Option<String>,
    pub card_rarity_int: Option<i64>,
    pub edhrec_rank: Option<i64>,
    pub price_usd: Option<f64>,
    pub price_eur: Option<f64>,
    pub price_tix: Option<f64>,

    // ── printed-language columns (multilingual store) ────────────────────────
    // Scryfall's top-level printed_name / printed_type_line / printed_text, verbatim, with
    // exact absence: None means the key was not on the card object, and the engine's intern_opt
    // keeps that distinct from an empty string. The per-face halves ride `card_faces` below
    // (FACE_OBJECT_FIELDS carries them), never these.
    pub printed_name: Option<String>,
    pub printed_type_line: Option<String>,
    pub printed_text: Option<String>,
    /// The printed FULL name ("Front // Back"), lowercased and accent-folded with the same
    /// fold `card_name_folded` uses — the engine's printed-name index key. None when no face
    /// carries a printed name (every English printing).
    pub printed_name_folded: Option<String>,
    /// Scryfall's top-level `flavor_name` — the Godzilla/Stranger Things/Secret Lair alternate
    /// name a printing is SOLD under. Printing-level like the printed triple, and a different
    /// thing from it: 669 of the 540,484 all_cards rows carry one, 609 of them English. The
    /// per-face variant (28 face occurrences on 15 printings, `transform`/`reversible_card`
    /// only) rides `card_faces` via FACE_OBJECT_FIELDS instead — Scryfall never puts both on
    /// one printing.
    pub flavor_name: Option<String>,
    /// `flavor_name`, lowercased and accent-folded with the same fold as above — the engine's
    /// flavor-name index key, which is what makes `/cards/named?exact=Godzilla, Primeval
    /// Champion` and `?fuzzy=godzilla primeval` resolve. Top-level only, matching Scryfall:
    /// `exact=Dracula, Lord of Blood` (a FACE flavor name) answers 404.
    pub flavor_name_folded: Option<String>,
    /// Whether this row is one of Scryfall's canonical (default_cards) printings. Decided by
    /// the CALLER via [`transform_row`] — id-membership in default_cards, never re-derived —
    /// and defaulted true so drafts serialized before the flag existed read as canonical.
    #[serde(default = "default_true")]
    pub is_canonical: bool,

    // ── raw-blob inputs consumed by the prefer-score backfill ───────────────
    // (backfill_prefer_scores.sql reads these via raw_card_blob ->> ...; we
    // keep just the referenced values instead of the whole blob.)
    pub raw_lang_en: bool,
    pub raw_set_type: Option<String>,
    pub raw_image_status_highres: bool,
    pub raw_has_paper: bool,
    pub raw_frame_effect_legendary: bool,
    pub raw_frame_effect_showcase: bool,
    pub raw_finish_nonfoil: bool,
    pub raw_finish_foil: bool,
    pub raw_finish_etched: bool,

    // ── per-face snapshots (upstream `_face_records`) ───────────────────────
    // Each entry carries only the `_FACE_OBJECT_FIELDS` keys the face actually
    // has, verbatim from Scryfall. Absent stays absent: Scryfall OMITS a key
    // rather than sending null, and `jv_faces` in core_api.rs relies on that to
    // round-trip a missing key back to NONE_STR instead of an empty string.
    // Empty for the ~82% of cards with a single face.
    pub card_faces: Vec<Map<String, Value>>,

    // ── the compat residue (upstream `_compat_blob`) ────────────────────────
    // Every Scryfall key that no column holds and no derivation recovers, kept
    // verbatim. Read back by `jv_compat` and `jv_all_parts` in core_api.rs.
    pub compat_blob: Map<String, Value>,
}

/// Keys that do NOT go in the compat residue, because a column already holds them or they are a
/// pure function of one (upstream `_COMPAT_BLOB_EXCLUDED`).
///
/// Kept SUBTRACTIVE, exactly as upstream keeps it: the residue is "whatever is left", so a
/// Scryfall key nobody has seen yet lands in the blob by default instead of being silently dropped
/// the first time it appears.
///
/// `prices` is deliberately absent even though price_usd/eur/tix are columns — usd_foil,
/// usd_etched and eur_foil are not, and keeping the object whole costs a few bytes against losing
/// three fields.
const COMPAT_BLOB_EXCLUDED: [&str; 54] = [
    // stored in a column of their own
    "id",
    "oracle_id",
    "name",
    "released_at",
    "layout",
    "mana_cost",
    "cmc",
    "type_line",
    "oracle_text",
    "power",
    "toughness",
    "loyalty",
    "colors",
    "color_identity",
    "keywords",
    "set",
    "set_name",
    "collector_number",
    "rarity",
    "flavor_text",
    "artist",
    "illustration_id",
    "border_color",
    "edhrec_rank",
    "legalities",
    "produced_mana",
    "watermark",
    "reserved",
    "game_changer",
    "frame",
    // pure functions of id / set / collector_number / oracle_id, re-emitted on read
    "object",
    "uri",
    "scryfall_uri",
    "image_uris",
    "rulings_uri",
    "prints_search_uri",
    "set_uri",
    "set_search_uri",
    "scryfall_set_uri",
    "card_back_id",
    "related_uris",
    "purchase_uris",
    "resource_id",
    // its own column
    "card_faces",
    // stored in a column of their own (the printed-language triple; their per-face halves ride
    // card_faces via FACE_OBJECT_FIELDS)
    "printed_name",
    "printed_type_line",
    "printed_text",
    // stored in a column of its own; the per-face variant rides card_faces
    "flavor_name",
    // stored in columns of their own (Vanguard's two starting-total deltas)
    "life_modifier",
    "hand_modifier",
    // Added by upstream's importer before it snapshots the residue. Raw bulk JSON never carries
    // them, so these four are inert here — kept so the two exclusion lists stay comparable
    // line-for-line when upstream's changes are synced.
    "card_name",
    "face_name",
    "face_idx",
    "scryfall_id",
];

/// Upstream `_compat_blob`: the Scryfall keys that no column holds and no derivation recovers.
///
/// Taken from the card as Scryfall sent it, before any face merging — a merged row's identity
/// scalars come from the front face, but the residue belongs to the printing as a whole.
fn compat_blob(card: &Map<String, Value>) -> Map<String, Value> {
    card.iter()
        .filter(|(key, _)| !COMPAT_BLOB_EXCLUDED.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// What `card_faces` stores per face, in Scryfall's own key names and value
/// shapes (upstream `_FACE_OBJECT_FIELDS`).
///
/// `object` is the constant "card_face" and `image_uris` is a pure function of
/// the card's id and the face's position, so neither is stored.
const FACE_OBJECT_FIELDS: [&str; 20] = [
    // Not in upstream's list, and the one key Scryfall puts on a FACE and on no top-level card:
    // the face's own `layout`. Exactly 81 printings in the 2026-08-16 all_cards bulk carry it,
    // all 81 `reversible_card`, both faces of each agreeing (154 `normal` + 6 `adventure` + 2
    // `token` face occurrences over 77 + 3 + 1 printings). Scryfall SEARCHES it — `layout:normal`
    // answers 106,635 there against the 106,558 printings whose own layout is `normal`, and the
    // 77-row difference is exactly the reversible printings whose faces are `normal` — so it is
    // a stored value, not a display one. Ahead of `name` because Scryfall's face key order is
    // `object -> oracle_id -> layout -> name`, and the first two are not stored.
    "layout",
    "name",
    // Scryfall's key order on a face is name -> flavor_name -> mana_cost (verified live on
    // vow/338 `transform` and sld/1079 `reversible_card`, 2026-08-16), and jv_faces round-trips
    // this list's order, so the position here IS the emitted position.
    "flavor_name",
    "mana_cost",
    "type_line",
    "oracle_text",
    "power",
    "toughness",
    "loyalty",
    // The per-face printed-language triple. Presence varies per face per printing (a
    // prepare-layout Spanish card localizes the front face's name and type line and nothing
    // else), and jv_faces in core_api.rs round-trips exactly what is here — absent stays absent.
    "printed_name",
    "printed_type_line",
    "printed_text",
    // Not in upstream's list, which loses every battle's defense: Scryfall prints it on the FACE
    // (Invasion of Alara's front face is `defense: 7`) and no column holds it.
    "defense",
    "colors",
    "color_indicator",
    "flavor_text",
    // WATERMARK IS PER FACE, and dropping it here lost the value twice over.
    //
    // Not in upstream's list either. Scryfall puts the watermark on the FACE and, on a card with
    // `card_faces`, on NOTHING ELSE: 0 of the 12,098 faced printings in the 2026-08-16 all_cards
    // bulk carry a top-level `watermark`, against 36,437 unfaced ones that do. The face-overlay in
    // `transform_row` wrote face 0's value onto the merged dict anyway, so `card_watermark` was
    // set on all 156 faced printings that have one — a key Scryfall never sends — while every
    // later face's value was discarded here.
    //
    // The discard is not a display-only loss. `Research // Development` (dis/155) is simic on its
    // front face and izzet on its back, and Scryfall answers it for BOTH `wm:simic` and
    // `wm:izzet`; this port answered only simic. 19 printings carry a watermark a later face alone
    // has, and every affected guild was short 1-2 rows. Measured over the whole 2026-08-16
    // default_cards bulk: 156 faced printings carry a watermark, 19 of them two distinct ones,
    // never three, and never one whose FRONT face lacks it.
    //
    // Position is Scryfall's own: the key sits between `flavor_text` and `artist` on every one of
    // the 1,075 face occurrences in the bulk, and `jv_faces` round-trips this list's order.
    "watermark",
    "artist",
    "artist_id",
    "illustration_id",
];

/// Upstream `_face_records`: snapshot each face's own fields, front first.
///
/// Only the keys the face actually has — a face missing a key must stay missing
/// so a reconstructed face agrees with Scryfall key-for-key.
fn face_records(card_faces: &[Value]) -> Vec<Map<String, Value>> {
    card_faces
        .iter()
        .filter_map(Value::as_object)
        .map(|face| {
            FACE_OBJECT_FIELDS
                .iter()
                .filter_map(|&field| face.get(field).map(|v| (field.to_string(), v.clone())))
                .collect()
        })
        .collect()
}

// ─── helpers ported from card_processing.py ──────────────────────────────────

/// Python `str.title()`: titlecase every cased character that follows a
/// non-cased character, lowercase the rest. Needed because upstream's
/// `parse_type_line` and frame-data derivation call `.title()`, whose behaviour
/// around apostrophes differs from a naive word-capitalizer ("urza's" →
/// "Urza'S"), and the DB rows carry exactly that spelling.
fn py_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_cased = false;
    for c in s.chars() {
        if prev_cased {
            out.extend(c.to_lowercase());
        } else {
            out.extend(c.to_uppercase());
        }
        prev_cased = c.is_lowercase() || c.is_uppercase();
    }
    out
}

/// card_processing.py lines 33-36: title-case the whole type line, partition on
/// the em dash, whitespace-split each side.
pub fn parse_type_line(type_line: &str) -> (Vec<String>, Vec<String>) {
    let titled = py_title(type_line);
    let (left, right) = match titled.split_once('\u{2014}') {
        Some((l, r)) => (l, r),
        None => (titled.as_str(), ""),
    };
    (
        left.split_whitespace().map(str::to_string).collect(),
        right.split_whitespace().map(str::to_string).collect(),
    )
}

/// card_processing.py lines 54-63 (`maybe_float` / `maybe_int` via `maybeify`):
/// numbers pass through, strings go through float(); failures → None.
/// (`int(float(v))` truncates toward zero.)
fn maybe_float(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn maybe_int(v: Option<&Value>) -> Option<i64> {
    let f = maybe_float(v)?;
    // Python would raise OverflowError on int(inf); it never occurs in card data.
    if !f.is_finite() { None } else { Some(f.trunc() as i64) }
}

/// `maybe_int` for a printed POWER or TOUGHNESS, where `*` IS A NUMBER AND IT IS ZERO.
///
/// `maybe_int` reads `*` as absent, and absent compares false against everything — so `tou<1`
/// answered 273 here against api.scryfall.com's 434 and `tou=0` 272 against 432. That is 160
/// cards, every one of them a `*`-statted creature, and Scryfall's own `tou:*` answers the same
/// 432 as `tou=0`.
///
/// THE STAR IS SUBSTITUTED, NOT THE VALUE REPLACED — the arithmetic around it still runs. Measured
/// on api.scryfall.com 2026-08-17, one card per printed form:
///
/// ```text
///   Allosaurus Rider   power     1+*   matches pow=1   (not pow=0)
///   Souls of the Lost  toughness *+1   matches tou=1
///   Aysen Crusader     power     2+*   matches pow=2, and NOT pow=0
/// ```
///
/// so `*` -> 0 and the sum is evaluated: `1+*` is 1, `7-*` is 7, `*` alone is 0. The whole
/// corpus's starred forms are `*`, `1+*`, `*+1`, `2+*`, `7-*` and `*²` (one card, and `0²` is 0),
/// which this expression grammar covers exactly — a term is a signed number or a star, and the
/// terms are added.
///
/// `?` IS ALSO ZERO, measured rather than assumed by analogy: `Shellephant` (ust/121) prints it on
/// both sides, and api.scryfall.com answers `!"Shellephant" tou=0` 1, `tou>=0` 1, `tou>0` 0. Read
/// as ABSENT it satisfied no comparison at all, which was the whole of `toughness<1` answering 433
/// against 434.
///
/// AND THE VALUE IS NOT ROUNDED, which is why this returns an `f64` and not the `i64` it used to.
/// Eleven Unhinged cards print a half, and truncating each to its floor made it wrongly ANSWER the
/// floor: `tou=0` was 433 against Scryfall's 432 (Little Girl, `.5`), `pow=2` 5733 against 5730
/// (Smart Ass, Stone-Cold Basilisk, Vile Bile, all `2.5`). The twin of `a_fractional_mana_value_is_
/// not_rounded`, and the same fix upstream applied to `cmc` in
/// api/db/2026-08-12-01-fractional-mana-value.sql.
///
/// `∞` (Infinity Elemental) stays absent: it is `ulst`, which api.scryfall.com does not answer for
/// at all, so there is no measurement to follow and an unmeasured form is not extended.
fn maybe_stat_num(v: Option<&Value>) -> Option<f64> {
    // `is_finite` is the guard `maybe_int` used to supply on the way past: Rust parses "inf" and
    // "NaN" out of a string where Python's int() would raise, and neither belongs in a column the
    // sort keys and the numeric planes read.
    if let Some(n) = maybe_float(v).filter(|n| n.is_finite()) {
        return Some(n);
    }
    let s = match v? {
        Value::String(s) => s.trim(),
        _ => return None,
    };
    if !s.contains(['*', '?']) {
        return None;
    }
    // Split into signed terms without splitting a leading sign off the first one: "7-*" is 7 and
    // -0, "-1+*" is -1 and 0.
    let mut total: f64 = 0.0;
    let mut sign: f64 = 1.0;
    let mut term = String::new();
    let push = |term: &mut String, sign: f64, total: &mut f64| -> bool {
        let t = term.trim().to_string();
        term.clear();
        if t.is_empty() {
            return false;
        }
        // `*`, `*²` and `?` are all zero, so such a term contributes nothing; a numeric term
        // parses, and anything else fails the whole value. Spelled as the three exact forms the
        // corpus prints rather than "starts with a star": an unrecognised form then reads as
        // ABSENT, which is the pre-fix behaviour and the safe direction to be wrong in.
        //
        // `?` IS MEASURED, not assumed by analogy with `*`. `Shellephant` (ust/121) prints `?`
        // on both sides, and on api.scryfall.com 2026-08-17 `!"Shellephant" tou=0` is 1,
        // `tou>=0` is 1 and `tou>0` is 0 — so Scryfall holds exactly 0, the same value it holds
        // for a star. It is the whole of `toughness<1`'s 433-against-434: this port read `?` as
        // ABSENT, and an absent value satisfies no comparison against its own column. The corpus
        // prints `?` on three cards (Shellephant, `Loopy Lobster` cmb1, `Catch of the Day` mb2)
        // and only Shellephant is in a set api.scryfall.com answers for at all.
        //
        // `∞` is NOT here, deliberately: `Infinity Elemental` is `ulst`, which Scryfall does not
        // answer for either, so there is no measurement to follow — the same rule that keeps
        // loyalty's two starred cards out of `stat_str_to_int_star`.
        if matches!(t.as_str(), "*" | "*\u{b2}" | "?") {
            return true;
        }
        match t.parse::<f64>() {
            Ok(n) if n.is_finite() => {
                *total += sign * n;
                true
            }
            _ => false,
        }
    };
    for (i, c) in s.char_indices() {
        match c {
            '+' | '-' if i > 0 => {
                if !push(&mut term, sign, &mut total) {
                    return None;
                }
                sign = if c == '-' { -1.0 } else { 1.0 };
            }
            _ => term.push(c),
        }
    }
    if !push(&mut term, sign, &mut total) {
        return None;
    }
    Some(total)
}

/// card_processing.py lines 66-76.
fn rarity_text_to_int(rarity: &str) -> i64 {
    match rarity {
        "common" => 0,
        "uncommon" => 1,
        "rare" => 2,
        // special BELOW mythic, which is Scryfall's ladder and not the one upstream shipped.
        // Measured 2026-08-16: `order=rarity dir=desc` answers mythic before the single `special`
        // row (Gaea's Blessing, tsb/77), and `r:bonus or r:special` answers special first ascending
        // and bonus first descending. So the ladder is common < uncommon < rare < special < mythic
        // < bonus, and the two middle tiers were transposed. It is one number line, so this moves
        // `r>=mythic` (now {mythic, bonus}) as well as `order=rarity`.
        "special" => 3,
        "mythic" => 4,
        "bonus" => 5,
        _ => -1,
    }
}

/// card_processing.py lines 79-94: keep only ASCII digits (concatenated across
/// gaps: "123a45" → 12345), parse, and null anything outside i32 range.
fn extract_collector_number_int(collector_number: &str) -> Option<i64> {
    let digits: String = collector_number.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    // Leading zeros are fine for i64 parse; overflow of even i64 → None, like
    // the Python int() → range-check path.
    let n: i64 = digits.parse().ok()?;
    if (-(2i64.pow(31))..=(2i64.pow(31) - 1)).contains(&n) { Some(n) } else { None }
}

/// The Latin letters NFKD leaves WHOLE, and the spellings a name comparison has to read them as.
///
/// NFKD is a decomposition, and a decomposition can only ever separate a base letter from its
/// marks. `æ` is not `a` with a mark on it — it is its own letter with no decomposition at all — so
/// every one of these survived `fold_accents` untouched and `name:æther` found nothing where
/// Scryfall finds 90. MEASURED against api.scryfall.com on 2026-08-16, one probe per character,
/// each against its expanded spelling: æ/ae 90, œ/oe 167, ß/ss 2051, ø/o 22111, ł/l 18748, đ/d
/// 14591, þ/th 5689, ð/d 14591, ħ/h 14176, ŋ/ng 4834, ŧ/t 22261, ı/i 22954, ĸ/k 6616 — equal
/// totals on both sides of every pair. (ĳ folds too, at 22; NFKD already reaches that one.)
///
/// The three characters DELIBERATELY ABSENT, each measured to 404 on Scryfall: `×` and `÷`, which
/// are symbols rather than letters and which `collate_name` would delete anyway; and `ſ`, which
/// Scryfall does not fold and NFKD does. Known residual divergences, all on characters no card in
/// the corpus contains: `ſ`, the presentation ligatures `ﬁ`/`ﬂ`/`ﬀ`, `½`, `№` and `ǽ` — NFKD folds
/// each of them and Scryfall folds none.
///
/// Mirrors `_LIGATURE_FOLD` in api/parsing/card_query_nodes.py.
fn ligature_fold(c: char) -> Option<&'static str> {
    Some(match c {
        'Æ' => "AE",
        'æ' => "ae",
        'Œ' => "OE",
        'œ' => "oe",
        'ß' => "ss",
        'Ø' => "O",
        'ø' => "o",
        'Ł' => "L",
        'ł' => "l",
        'Đ' | 'Ð' => "D",
        'đ' | 'ð' => "d",
        'Þ' => "Th",
        'þ' => "th",
        'Ħ' => "H",
        'ħ' => "h",
        'Ŋ' => "NG",
        'ŋ' => "ng",
        'Ŧ' => "T",
        'ŧ' => "t",
        'ı' => "i",
        'ĸ' => "k",
        _ => return None,
    })
}

/// api/parsing/card_query_nodes.py (`fold_accents`): NFKD, drop combining marks,
/// then expand the undecomposable Latin letters. Single source of truth for
/// `card_name_folded`.
pub fn fold_accents(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.nfkd().filter(|c| canonical_combining_class(*c) == 0) {
        match ligature_fold(c) {
            Some(expanded) => out.push_str(expanded),
            None => out.push(c),
        }
    }
    out
}

/// api/parsing/card_query_nodes.py lines 387-421 (`mana_cost_str_to_dict`):
/// symbol → count, from braced symbols (skipping pure integers) plus unbraced
/// WUBRGCX characters. Returned in first-seen order (Python dict order);
/// the JSON value for each symbol is the list [1..=count] — the engine's
/// `mana_cost_from_pydict` reads the list length as the pip count.
pub fn mana_cost_str_to_counts(mana_cost: &str) -> Vec<(String, u32)> {
    let upper = mana_cost.to_uppercase();
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, u32> = HashMap::new();
    let bump = |order: &mut Vec<String>, counts: &mut HashMap<String, u32>, sym: String| {
        let entry = counts.entry(sym.clone()).or_insert(0);
        if *entry == 0 {
            order.push(sym);
        }
        *entry += 1;
    };

    // Braced symbols; also blank out braced regions for the unbraced pass,
    // replacing each with a space exactly like the Python re.sub.
    let mut unbraced = String::with_capacity(upper.len());
    let mut rest = upper.as_str();
    while let Some(open) = rest.find('{') {
        unbraced.push_str(&rest[..open]);
        let Some(close_rel) = rest[open..].find('}') else {
            // Unterminated brace: Python's regex would not match it; the raw
            // remainder flows into the unbraced pass.
            rest = &rest[open..];
            break;
        };
        let sym = &rest[open + 1..open + close_rel];
        // Python: int(sym) succeeding → skipped (generic mana); anything else,
        // including the empty string, is counted as a pip symbol.
        if sym.trim().parse::<i64>().is_err() {
            bump(&mut order, &mut counts, sym.to_string());
        }
        unbraced.push(' ');
        rest = &rest[open + close_rel + 1..];
    }
    unbraced.push_str(rest);

    for c in unbraced.chars() {
        if "WUBRGCX".contains(c) {
            bump(&mut order, &mut counts, c.to_string());
        }
    }

    order.into_iter().map(|sym| { let n = counts[&sym]; (sym, n) }).collect()
}

// ─── raw-card accessors ─────────────────────────────────────────────────────

fn s(card: &Map<String, Value>, key: &str) -> Option<String> {
    card.get(key).and_then(Value::as_str).map(str::to_string)
}

fn str_array(card: &Map<String, Value>, key: &str) -> Vec<String> {
    card.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn array_contains(card: &Map<String, Value>, key: &str, needle: &str) -> bool {
    card.get(key)
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(needle)))
}

fn required_str(card: &Map<String, Value>, name: &str, field: &'static str) -> Result<String, TransformError> {
    s(card, field).ok_or_else(|| TransformError::MissingField { card: name.to_string(), field })
}

// ─── preprocess_card port ────────────────────────────────────────────────────

/// The `is:` value that carries the extras class. Spelled once here and once in the TypeScript
/// parser's COMPUTED_IS_TAGS; the two must agree or `is:extra` warns instead of filtering.
pub const EXTRA_IS_TAG: &str = "extra";

/// The `layout` values whose printings Scryfall calls EXTRAS and hides from a default
/// `/cards/search`, plus the two non-layout signals that do the same job.
///
/// DERIVED FROM SCRYFALL'S OWN ANSWERS, not from this file's old filter list — which turned out to
/// predict the wrong thing. Every class the old `passes_filters` dropped was probed against
/// api.scryfall.com on 2026-08-16 (`q=!"<name>"` bare, then with `include_extras=true`, then
/// `/cards/named?exact=`), and four of the seven are simply ORDINARY search results:
///
///   never-legal   `!"Hold the Perimeter"` (cn2/6)     -> 200 bare   ordinary
///   funny         `!"Bamboozling Beeble"` (unf/37)    -> 200 bare   ordinary
///                 `!"Goblin Bowling Team"` (ugl/44)   -> 200 bare   ordinary (silver, never-legal)
///   "X // X"      `!"Magmatic Hellkite // …"` (tdm)   -> 200 bare   ordinary (reversible_card)
///   playtest+legal `sld/SCTLR` Counterspell            -> in `unique=prints` bare
///
///   memorabilia   `!"Siren's Call"&unique=prints`     -> 8 bare, 12 with extras (ced/78 appears)
///   type "Card"   `!"The Monarch"` (tmkc/31)          -> 404 bare, 200 with extras
///   type "Token"  `!"Goblin Army"` (thob/4)           -> 404 bare, 200 with extras
///   planar        `!"Truga Jungle"` (opc2/38)         -> 404 bare, 200 with extras
///   playtest      `!"Subgoyf"` (mb2/536)              -> 404 bare, 200 with extras
///
/// The property that actually predicts hiding is Scryfall's own `is:extra` (6,054 cards); this
/// approximation reaches 5,873 distinct English cards, within 3% of it — and, unlike the filter
/// list, it is a statement about the PRINTING rather than about how playable the card is.
///
/// `/cards/named?exact=` answered 200 for every one of them, hidden or not: that route has no
/// extras gate at all, which is the other half of why refusing the ROW could never reproduce this.
///
/// `host` AND `augment` WERE HERE AND ARE WRONG. Unstable's Hosts and Augments are ORDINARY search
/// results: `is:extra e:ust` answers 0 on api.scryfall.com while this list counted 32, and bare
/// `e:ust` answers Unstable's full English count either way. The two layouts are unusual card
/// FACES, not printings Scryfall hides — which is the distinction this list is supposed to draw.
/// Measured 2026-08-16; 46 printings across ust/und/ulst stop carrying `is:extra`.
const EXTRA_LAYOUTS: &[&str] =
    &["token", "double_faced_token", "emblem", "planar", "scheme", "vanguard", "art_series", "front_card"];

/// `set_type` of the Un-sets and the joke oddities — the one family where the extras verdict is a
/// property of the SET and not of the printing.
const FUNNY_SET_TYPE: &str = "funny";

/// The `funny` sets Scryfall hides behind `include_extras`. Every OTHER funny set is served
/// ordinarily, and both halves are total: measured on api.scryfall.com 2026-08-16, all 22 funny
/// sets in the corpus answer `is:extra e:<code>` with either their whole card count or zero —
/// never anything in between.
///
///   whole set extra   cmb1 121  cmb2 121  h17 4  hho 21  ph17 3  ph18 4  ph19 7  ph20 3  ph21 4
///                     ph22 5  ph23 2  phtr 3  punk 52  ulst 62  unk 512
///   whole set served  ptg 0  sunf 0  ugl 0  und 0  unf 0  unh 0  ust 0
///
/// NOTHING ON THE PRINTING PREDICTS THE SPLIT, and that is a measurement rather than a shrug. The
/// ulst rows (The List's Unstable reprints) were diffed field by field against their own ust twins
/// over the whole 2026-08-16 bulk: of the 40-odd keys, the only values ulst holds that no
/// ust/und/unh/unf/ugl row holds are `highres_image: false` and `image_status: "lowres"` — scan
/// quality, and not even uniform across ulst. `set_type`, `border_color` (silver both), `layout`,
/// `security_stamp`, `promo_types`, `frame_effects`, `games`, `finishes`, `booster`, `reprint`,
/// `content_warning`, `legalities` (never legal both) all overlap. Widening the comparison to the
/// two GROUPS — 927 printings across the 15 extra sets against 1,310 across the 7 served ones —
/// found no field whose value set separates them either.
///
/// The SET objects do not predict it: `foil_only` is true for both h17 (extra) and ptg (served),
/// `parent_set_code` is set on both punk (extra) and sunf (served), `tcgplayer_id` is set on both
/// unk (extra) and ptg (served), and `card_count`/`printed_size`/`digital`/`block` split neither
/// way. So it is editorial data in Scryfall's own database, and a list is the only faithful port.
///
/// SPELLED AS THE EXTRA SIDE ON PURPOSE. A funny set this list has never heard of is served
/// ORDINARILY, so the failure mode of a stale list is a handful of employee-award or convention
/// cards leaking into search — not a 639-card retail Un-set vanishing from it, which is what
/// defaulting the other way would risk the first time Wizards prints another one.
const FUNNY_EXTRA_SETS: &[&str] = &[
    "cmb1", "cmb2", "h17", "hho", "ph17", "ph18", "ph19", "ph20", "ph21", "ph22", "ph23", "phtr", "punk", "ulst",
    "unk",
];

/// Whether Scryfall hides this printing from a default `/cards/search` — the `is:extra` class.
///
/// NOTHING IS DROPPED ANY MORE. `preprocess_card` used to refuse seven classes of printing at
/// import; Scryfall serves all seven, and gates three-and-a-bit of them behind
/// `include_extras=false`. An absent row cannot reproduce a query-time gate in either direction:
/// `/cards/named?exact=Counters` answered 404 where Scryfall answers fmsc/9, and
/// `include_extras=true` had nothing to include. So every row is imported and this decides which
/// ones carry `is:extra`; `cardsSearchHandler` ANDs `-is:extra` unless the caller (or a set term)
/// asks otherwise.
///
/// The `legalities` read stays, and stays fallible: it is the one field whose absence still means
/// the bulk row is malformed rather than merely unusual.
///
/// MEASURED COVERAGE (2026-08-16, the 114,068 English printings of the all_cards bulk against
/// api.scryfall.com's own `is:extra`, 10,818 printings): this class reaches 10,732 — 45 short and
/// none over. The 45 are Arena-only duplicate printings with no signal on them at all (hbg 18,
/// j21 16, ydmu 9, ybro 1) plus one Secret Lair poster; the same field-by-field diff that cleared
/// `FUNNY_EXTRA_SETS` finds nothing separating them from their own set-mates either, so they are
/// left rather than enumerated one id at a time. Before the funny/digital/silver-promo/Stickers
/// rules were added it reached 10,482 with 308 misses and 2 false positives.
///
/// THE "ONE SECRET LAIR POSTER" IS NO LONGER AMONG THEM (2026-08-17). It was sld/1969
/// `Mechtitan // Mechtitan`, and it did have a signal — the type line the "Card"/"Token" rule
/// below already reads. Being a `reversible_card` it prints no TOP-LEVEL type line, so that rule
/// saw an empty string; both its faces are `Token Legendary Artifact Creature — Construct`. The
/// rule now falls back to the faces when the card states no type line of its own, which closes it
/// and leaves 44 — the Arena duplicates, which genuinely carry nothing.
fn extras_class(card: &Map<String, Value>) -> Result<bool, TransformError> {
    let legalities = card
        .get("legalities")
        .and_then(Value::as_object)
        .ok_or_else(|| TransformError::MissingField { card: s(card, "name").unwrap_or_default(), field: "legalities" })?;
    let never_legal = !legalities.values().any(|v| matches!(v.as_str(), Some("legal") | Some("restricted")));
    // A FUNNY SET DECIDES FOR ITS PRINTINGS — see `FUNNY_EXTRA_SETS` for the measurement and for
    // why no printing field can stand in for the list.
    //
    // A funny set the list names is extra outright. A funny set it does NOT name still falls
    // through to the layout, memorabilia, content-warning and "Card"/"Token" rules below, and
    // skips only the two that measurably misfire inside the un-sets: `und`/`unh` carry a
    // `playtest` promo each ("Look at Me, I'm R&D", a real Un-card that merely DEPICTS a playtest
    // card) and `sunf` ships 48 sticker sheets, and all three sets answer `is:extra` 0 on
    // api.scryfall.com.
    //
    // FALLING THROUGH RATHER THAN RETURNING FALSE IS THE POINT. An early `false` would let a
    // future funny set's tokens, planes or vanguards vanish from search the moment the list went
    // stale — the silent-vanishing failure this list's polarity was chosen to avoid, reintroduced
    // one level down. It costs nothing today: of the 57 funny printings another rule would call
    // extra (punk 52 planar, cmb1/cmb2 1 vanguard each, hho/h17 1 token each) every single one is
    // already in a listed set, so the two rules agree wherever they overlap.
    let funny = s(card, "set_type").as_deref() == Some(FUNNY_SET_TYPE);
    if funny && s(card, "set").is_some_and(|code| FUNNY_EXTRA_SETS.contains(&code.as_str())) {
        return Ok(true);
    }
    // A DIGITAL PRINTING NO FORMAT ALLOWS. Arena's Alchemy duplicates and the Astral cards from
    // the 1997 MicroProse game are legal nowhere and served nowhere: 117 printings across hbg
    // (104), past (12) and prm (1), every one of them inside Scryfall's `is:extra` and not one
    // outside it, over the whole English corpus. Digital and never-legal are each ordinary on
    // their own — Alchemy's playable cards are legal in alchemy/historic, and paper's never-legal
    // conspiracies are ordinary results — so it is the conjunction that carries the class.
    if card.get("digital").and_then(Value::as_bool) == Some(true) && never_legal {
        return Ok(true);
    }
    // A SILVER-BORDERED PROMO: an Un-card handed out outside its own set (Arena League, judge
    // gifts, prerelease stamps). 10 printings across pal04/j17/p30m/punh/pust, all extras, no
    // false positive — silver alone is not the class (567 silver printings are ordinary), and
    // neither is `promo`.
    if s(card, "border_color").as_deref() == Some("silver") && s(card, "set_type").as_deref() == Some("promo") {
        return Ok(true);
    }
    if s(card, "layout").as_deref().is_some_and(|l| EXTRA_LAYOUTS.contains(&l)) {
        return Ok(true);
    }
    if s(card, "set_type").as_deref() == Some(MEMORABILIA_SET_TYPE) {
        return Ok(true);
    }
    // `content_warning` — the flag Scryfall sets on the printings it will not show unasked. It is
    // an EXTRAS signal and nothing else in this function catches it: 91 printings across the bulk
    // (25 English), all layout `normal`, all ordinary type lines, all legal somewhere. Missing it
    // made nine sets look extras-free that Scryfall auto-enables `include_extras` for — lea's only
    // extra IS a content-warning card (Crusade), and 2ed/3ed/4ed/5ed/6ed/sum/leg/arn/ddf/me1/me3/
    // ced/cei/prm are the same story. Measured 2026-08-16: `is:extra e:lea` answers 1.
    if card.get("content_warning").and_then(Value::as_bool) == Some(true) {
        return Ok(true);
    }
    // A "Card"/"Token"/"Stickers" TYPE LINE, for the printings whose layout does not already say
    // so: the checklist and substitute-card family ships as layout `normal` in some sets, and the
    // Secret Lair sticker sheets (sld/335-339) ship as an ordinary `normal` box-set printing whose
    // only tell is the type. `Stickers` is guarded on `funny` because `sunf` ships 48 sticker
    // sheets that Scryfall serves; `Card`/`Token` need no guard, and deliberately do not have one.
    //
    // READ THE FACES WHEN THE CARD PRINTS NO TYPE LINE OF ITS OWN. A `reversible_card` has no
    // top-level `type_line` at all — every one of its 40-odd keys lives on the two faces — so this
    // rule saw an empty string and fell through, and the ONE printing in the corpus it should have
    // caught is the one the class comment below already records as an unexplained miss: sld/1969
    // `Mechtitan // Mechtitan`, whose two faces are both `Token Legendary Artifact Creature —
    // Construct`. Scryfall answers `e:sld cn:1969 is:extra` 1; this answered 0, and the printing
    // leaked into every default search — `c=wubrg` was 61 here against Scryfall's 60.
    //
    // MEASURED AS A RULE, NOT AS AN ID. Over the whole 2026-08-16 all_cards bulk, 81 printings have
    // no top-level `type_line`; the face fallback fires on exactly ONE of them, sld/1969, which is
    // exactly the one Scryfall calls extra. No false positive to trade against, in any language.
    // `poster` was the other candidate signal and is NOT the rule — 434 printings carry that promo
    // type and Scryfall serves all but this one ordinarily.
    //
    // FALLBACK RATHER THAN UNION, deliberately: a card that DOES print a type line has already
    // stated its own class, and a `transform` front face is a Creature whose back may be anything.
    // Only the card that says nothing at all delegates to its faces.
    let type_lines: Vec<String> = match s(card, "type_line").filter(|t| !t.is_empty()) {
        Some(type_line) => vec![type_line],
        None => card
            .get("card_faces")
            .and_then(Value::as_array)
            .map(|faces| faces.iter().filter_map(|f| f.as_object().and_then(|o| s(o, "type_line"))).collect())
            .unwrap_or_default(),
    };
    for type_line in &type_lines {
        let (card_types, _) = parse_type_line(type_line);
        if card_types.iter().any(|t| t == "Card" || t == "Token" || (t == "Stickers" && !funny)) {
            return Ok(true);
        }
    }
    // A playtest promo, EXCEPT where the printing is otherwise playable: sld/SCTLR Counterspell
    // carries `promo_types: ["sldbonus", "playtest"]`, is legal in modern/legacy/pauper, and is
    // returned by a bare `!"Counterspell"&unique=prints` — so the flag alone does not hide a row,
    // the mb2/cmb1 convention cards are hidden because they are unplayable as well.
    Ok(array_contains(card, "promo_types", "playtest") && never_legal && !funny)
}


/// The single-face tail of `preprocess_card` (lines 155-270): derive every
/// engine column from a fully merged card dict. `card_name` is the lifted
/// parent name (line 134: set before face processing so faces keep the full
/// "A // B" name).
fn build_draft(card: &Map<String, Value>, card_name: &str) -> Result<RowDraft, TransformError> {
    let nm = card_name.to_string();
    let miss = |field: &'static str| TransformError::MissingField { card: nm.clone(), field };

    // Line 169: scryfall_id = card["id"] (KeyError aborts the import upstream).
    let scryfall_id = required_str(card, card_name, "id")?;
    // oracle_id: filled by bulk_upsert from the dict key; magic.cards has it
    // NOT NULL (2026-05-21-01-oracle-id-not-null.sql), so a missing value would
    // abort the upstream import — error here likewise. For reversible cards the
    // face-level oracle_id lands via the face merge.
    let oracle_id = required_str(card, card_name, "oracle_id")?;
    // released_at: NOT NULL date column, always present in bulk data.
    let released_at = required_str(card, card_name, "released_at")?;

    // Lines 171-173: type line split.
    let type_line = s(card, "type_line").ok_or_else(|| miss("type_line"))?;
    let (card_types, card_subtypes) = parse_type_line(&type_line);

    // Line 175: planeswalker loyalty (maybe_int of the printed loyalty), and line 408: the
    // printed STRING itself, verbatim, as its own column.
    let planeswalker_loyalty = maybe_int(card.get("loyalty"));
    let planeswalker_loyalty_text = s(card, "loyalty");

    // Lines 176-189 ordinarily attach stats only to creatures/Vehicles/Spacecraft. The raw
    // Scryfall keys outrank that type-line inference, though: historical and joke printings can
    // carry real power/toughness behind a noncanonical type line. `Atinlay Igpay` says
    // `Eaturecray`, and old-template cards such as `Old Fogey` say `Summon`; api.scryfall.com still
    // serves and searches their printed stats. Dropping the keys made `pow=3`/`tou=3` miss the
    // former and `tou>=3.5` miss the latter even though both rows were present in the store.
    let is_creaturelike = card_types.iter().any(|t| t == "Creature")
        || card_subtypes.iter().any(|t| t == "Vehicle" || t == "Spacecraft");
    let has_printed_stats = card.get("power").is_some() || card.get("toughness").is_some();
    // `maybe_stat_num` and not `maybe_int`: `*` and `?` are zero on both sides of a
    // power/toughness comparison and a printed HALF is kept as a half — see its doc comment for
    // the cards that pin each rule. The printed strings beside them are untouched, and they are
    // what the card object serves.
    let (creature_power, creature_toughness, creature_power_text, creature_toughness_text) =
        if is_creaturelike || has_printed_stats {
            (
                maybe_stat_num(card.get("power")),
                maybe_stat_num(card.get("toughness")),
                s(card, "power"),
                s(card, "toughness"),
            )
        } else {
            (None, None, None, None)
        };

    // Lines 192-195: color/keyword sets, stored as {key: true} JSONB objects.
    // card["colors"] and card["color_identity"] are indexed directly upstream
    // (KeyError aborts), so they are required; keywords/produced_mana default [].
    let card_colors = match card.get("colors") {
        Some(Value::Array(_)) => str_array(card, "colors"),
        _ => return Err(miss("colors")),
    };
    let card_color_identity = match card.get("color_identity") {
        Some(Value::Array(_)) => str_array(card, "color_identity"),
        _ => return Err(miss("color_identity")),
    };
    // Lowercased so the stored key matches what `keyword:` looks up -- Scryfall's own spelling
    // is inconsistently cased ("First strike", "Doctor's companion"), and lowercase is the same
    // normalization the oracle/art tag collections already use on both sides. Any collision the
    // fold creates collapses in keys_true, matching Python's dict.fromkeys.
    let card_keywords: Vec<String> = str_array(card, "keywords").iter().map(|k| k.to_lowercase()).collect();
    // ...and again as printed, for the card OBJECT. The fold above is not invertible: only 455 of
    // the 885 distinct keywords in the 2026-08-16 all_cards bulk come back from capitalizing the
    // folded form ("Battle Cry", "AV Bead", "Bio-plasmic Barrage" do not), and Scryfall's order is
    // neither the folded list's nor alphabetical ("Flying" before "Flash" on Brazen Borrower). The
    // engine keeps the two apart on purpose: `keyword:` binds the folded ids, the object emits
    // these. Cheap either way -- 885 strings intern once for the whole corpus.
    let card_keywords_printed = str_array(card, "keywords");
    let produced_mana = str_array(card, "produced_mana");
    // Scryfall's own top-level `color_indicator` — the dot printed on a card whose colours its mana
    // cost cannot state (a meld result, a coloured back). 546 printings in the 2026-08-16 bulk carry
    // one, and this port emitted the key on none of them. Deliberately NOT face-merged: the
    // two-image layouts keep theirs on the faces and send no top-level copy at all, and on the
    // one-image layouts the front face's overlay IS the card's value.
    let color_indicator = str_array(card, "color_indicator");

    // The is: tags Scryfall ships as booleans on every bulk card object. Upstream
    // syncs these from raw_card_blob in one set-based statement after each upsert
    // (_sync_boolean_is_tags); there is no stored row to reconcile against here,
    // so the set is simply rebuilt per card. Adding an entry to BOOLEAN_IS_TAGS is
    // the whole change on both sides.
    let card_is_tags: Vec<String> = BOOLEAN_IS_TAGS
        .iter()
        .filter(|(_, blob_key)| card.get(*blob_key) == Some(&Value::Bool(true)))
        .map(|(tag, _)| (*tag).to_owned())
        .chain(
            ARRAY_IS_TAGS
                .iter()
                .filter(|(_, blob_key, member)| array_contains(card, blob_key, member))
                .map(|(tag, _, _)| (*tag).to_owned()),
        )
        .collect();

    // Line 197: edhrec_rank passes through (bulk_upsert casts to integer).
    let edhrec_rank = maybe_int(card.get("edhrec_rank"));

    // Lines 199-209: frame version + frame effects, title-cased, first-seen
    // order (Python dict insertion order), duplicates collapsed.
    let mut card_frame_data: Vec<String> = Vec::new();
    if let Some(frame) = s(card, "frame")
        && !frame.is_empty()
    {
        card_frame_data.push(py_title(&frame));
    }
    for effect in str_array(card, "frame_effects") {
        let titled = py_title(&effect);
        if !card_frame_data.contains(&titled) {
            card_frame_data.push(titled);
        }
    }

    // Lines 211-215: prices as floats (strings in the bulk data).
    let prices = card.get("prices").and_then(Value::as_object);
    let price = |k: &str| maybe_float(prices.and_then(|p| p.get(k)));
    let (price_usd, price_eur, price_tix) = (price("usd"), price("eur"), price("tix"));

    // Lines 219-228: lowercased set code / layout / border / watermark.
    let card_set_code = s(card, "set").map(|v| v.to_lowercase());
    let card_layout = s(card, "layout").map(|v| v.to_lowercase());
    let card_border = s(card, "border_color").map(|v| v.to_lowercase());
    let card_watermark = s(card, "watermark").map(|v| v.to_lowercase());

    // VERBATIM, not lowercased and not parsed to a number, unlike the four above. Scryfall prints
    // these as SIGNED STRINGS and the sign is always written, zero included: over the whole
    // 2026-08-16 all_cards bulk the life values are the 23 strings "+0".."+30" and "-1".."-8" and
    // the hand values the 8 strings "-4".."+3" — never a bare "0", never a "-0". An i8 plus a
    // formatter would round-trip today's corpus and invent a spelling the day Scryfall writes one
    // of them unsigned, so the string is what is carried.
    //
    // Read here, in `build_draft`, rather than restored in `transform_row` from the unoverlaid
    // card like `card_layout` and `card_artist`: those two exist on FACES and so had to be taken
    // back from the card, while these appear on no face anywhere in the corpus. All 119 printings
    // that carry them are layout `vanguard`, every one carries BOTH (never one alone), and none
    // has `card_faces` at all — so the face overlay cannot reach them and one parse site does.
    let life_modifier = s(card, "life_modifier");
    let hand_modifier = s(card, "hand_modifier");

    // Lines 230-231: mana cost symbol counts. (Line 235's devotion column is
    // NOT ported: it is not in ENGINE_COLUMNS — card_from_pydict recomputes
    // devotion from mana_cost_jsonb + card types, lib.rs lines 688-718.)
    let mana_cost_text = s(card, "mana_cost");
    let mana_cost_jsonb = mana_cost_str_to_counts(mana_cost_text.as_deref().unwrap_or(""));

    // Lines 242-243: folded name (#649).
    let card_name_folded = fold_accents(&card_name.to_lowercase());

    // Line 246 / 249: artist, cmc. NOT truncated -- maybe_float, mirroring upstream's own
    // switch away from maybe_int (#923). The corpus filter above still drops funny sets, so
    // every value this actually sees today is integral; what changes is that a fraction would
    // now survive rather than being rounded on the way in.
    let card_artist = s(card, "artist");
    let card_artist_folded = card_artist.as_deref().map(|a| fold_accents(&a.to_lowercase()));
    let cmc = maybe_float(card.get("cmc"));

    // Lines 251-255: rarity only when non-empty.
    let rarity = s(card, "rarity").unwrap_or_default().to_lowercase();
    let card_rarity_int = if rarity.is_empty() { None } else { Some(rarity_text_to_int(&rarity)) };

    // Lines 257-260: collector number + numeric extraction.
    let collector_number = s(card, "collector_number");
    let collector_number_int = collector_number.as_deref().and_then(extract_collector_number_int);

    // Line 261 / face merge: face-level illustration id.
    let illustration_id = s(card, "illustration_id");

    // Line 264: card_legalities defaults to the Scryfall legalities object.
    let card_legalities = card
        .get("legalities")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // Lines 159-164: flavor_text normalized to '' when absent.
    let flavor_text = s(card, "flavor_text").unwrap_or_default();

    Ok(RowDraft {
        oracle_text: s(card, "oracle_text"),
        set_name: s(card, "set_name"),
        type_line: Some(type_line),
        // Prefer-score inputs (backfill_prefer_scores.sql reads these from
        // raw_card_blob; the raw blob itself is not an engine column, so only
        // the referenced values are retained).
        raw_lang_en: s(card, "lang").as_deref() == Some("en"),
        raw_set_type: s(card, "set_type"),
        raw_image_status_highres: s(card, "image_status").as_deref() == Some("highres_scan"),
        raw_has_paper: array_contains(card, "games", "paper"),
        raw_frame_effect_legendary: array_contains(card, "frame_effects", "legendary"),
        raw_frame_effect_showcase: array_contains(card, "frame_effects", "showcase"),
        raw_finish_nonfoil: array_contains(card, "finishes", "nonfoil"),
        raw_finish_foil: array_contains(card, "finishes", "foil"),
        raw_finish_etched: array_contains(card, "finishes", "etched"),
        scryfall_id,
        oracle_id,
        illustration_id,
        card_name: card_name.to_string(),
        card_name_folded,
        flavor_text,
        card_artist,
        card_artist_folded,
        card_set_code,
        card_layout,
        card_border,
        card_watermark,
        life_modifier,
        hand_modifier,
        collector_number,
        collector_number_int,
        mana_cost_text,
        released_at,
        card_colors,
        card_color_identity,
        color_indicator,
        produced_mana,
        card_keywords,
        card_keywords_printed,
        card_is_tags,
        card_types,
        card_subtypes,
        card_legalities,
        card_frame_data,
        mana_cost_jsonb,
        cmc,
        creature_power,
        creature_toughness,
        creature_power_text,
        creature_toughness_text,
        planeswalker_loyalty,
        planeswalker_loyalty_text,
        card_rarity_int,
        edhrec_rank,
        price_usd,
        price_eur,
        price_tix,
        // Filled by `transform` after the per-face drafts merge; a single-faced
        // card has none, which is the ~82% case.
        card_faces: Vec::new(),
        // Also filled by `transform`, from the card as Scryfall sent it rather than from the
        // per-face overlay this function may have been handed — the printed columns and the
        // canonical flag likewise (the flag is the caller's fact, not the card's).
        compat_blob: Map::new(),
        printed_name: None,
        flavor_name: None,
        flavor_name_folded: None,
        printed_type_line: None,
        printed_text: None,
        printed_name_folded: None,
        is_canonical: true,
    })
}

fn default_true() -> bool {
    true
}

impl RowDraft {
    /// Record an `Extra` verdict as the `is:extra` tag, which is where the query plane reads it.
    ///
    /// A COMPUTED tag rather than a bulk boolean, so it cannot ride BOOLEAN_IS_TAGS: no Scryfall
    /// field says "this printing is an extra", the answer is the union of the classes
    /// `extras_class` recognizes, and `card_is_tags` is the one place the engine already indexes
    /// per-printing membership (a `HybridTagIndex`, which is what keeps `-is:extra` composable —
    /// spelled as a set-type conjunct instead it would have cost three of the six physical plans).
    fn set_extra(&mut self, is_extra: bool) {
        if is_extra && !self.card_is_tags.iter().any(|t| t == EXTRA_IS_TAG) {
            self.card_is_tags.push(EXTRA_IS_TAG.to_owned());
        }
    }
}

/// The printed full name for the engine's printed-name index, folded exactly like
/// `card_name_folded`: per-face `printed_name`s joined " // " — each face falling back to its
/// English `name` when Scryfall omitted `printed_name` there, so a prepare-layout printing whose
/// back face is never localized still yields a complete two-part name — or the top-level
/// `printed_name` when the card has no faces. `None` when no printed name exists anywhere: an
/// English printing contributes nothing to the printed-name index.
fn printed_name_folded(card: &Map<String, Value>, faces: &[Map<String, Value>]) -> Option<String> {
    let full = if faces.iter().any(|f| f.contains_key("printed_name")) {
        faces
            .iter()
            .map(|f| f.get("printed_name").or_else(|| f.get("name")).and_then(Value::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join(" // ")
    } else {
        s(card, "printed_name")?
    };
    Some(fold_accents(&full.to_lowercase()))
}

/// Joins face texts. `"\n"` so substring/regex matches cannot span faces in
/// practice (`.` does not cross newlines), `"//"` because that is the face
/// separator Scryfall itself renders.
const FACE_TEXT_SEPARATOR: &str = "\n//\n";

/// Order-preserving union: extend `into` with values it does not already hold.
fn union_list(into: &mut Vec<String>, from: &[String]) {
    for value in from {
        if !into.contains(value) {
            into.push(value.clone());
        }
    }
}

/// Upstream's `_FACE_JOINED_TEXTS` rule for one field.
///
/// Python filters on truthiness (`if part`), so an EMPTY string is dropped just
/// like an absent one — which is why `flavor_text` (normalised to `""` when
/// absent) never contributes a bare separator.
fn join_face_text(a: &str, b: &str, separator: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => String::new(),
        (true, false) => b.to_string(),
        (false, true) => a.to_string(),
        (false, false) => format!("{a}{separator}{b}"),
    }
}

/// Upstream `_merge_processed_faces`: collapse fully-processed per-face rows
/// into the card's single searchable row.
///
/// Scryfall ANDs search predicates at the CARD level, each satisfiable by any
/// face — `t:sorcery t:land` returns the MDFC lands even though no single face
/// is both. One row per printing carrying any-face unions reproduces that;
/// one row per face would break every cross-face conjunction.
///
/// The front face supplies the row and with it every identity and display
/// scalar (illustration, prices, collector number). Later faces fold in by
/// four policies, and everything not named here stays the front's.
fn merge_face_drafts(drafts: Vec<RowDraft>) -> RowDraft {
    let mut it = drafts.into_iter();
    let mut merged = it.next().expect("merge_face_drafts requires at least one face");

    for face in it {
        // _FACE_LIST_UNIONS: order-preserving union.
        union_list(&mut merged.card_types, &face.card_types);
        union_list(&mut merged.card_subtypes, &face.card_subtypes);

        // _FACE_FLAG_UNIONS: set union. These are {key: true} objects upstream,
        // so `dict.update` is a union; the port holds them as ordered Vecs and
        // finalize_row emits the same objects, making union_list equivalent.
        union_list(&mut merged.card_colors, &face.card_colors);
        union_list(&mut merged.card_keywords, &face.card_keywords);
        union_list(&mut merged.card_keywords_printed, &face.card_keywords_printed);
        union_list(&mut merged.produced_mana, &face.produced_mana);

        // _FACE_JOINED_TEXTS. type_line uses " // "; the rest use the newline form.
        merged.oracle_text = {
            let joined = join_face_text(
                merged.oracle_text.as_deref().unwrap_or(""),
                face.oracle_text.as_deref().unwrap_or(""),
                FACE_TEXT_SEPARATOR,
            );
            // Stays None when neither face had text, so `oracle_text IS NULL`
            // keeps meaning "no text" rather than "empty text".
            if joined.is_empty() { None } else { Some(joined) }
        };
        merged.flavor_text =
            join_face_text(&merged.flavor_text, &face.flavor_text, FACE_TEXT_SEPARATOR);
        merged.type_line = {
            let joined = join_face_text(
                merged.type_line.as_deref().unwrap_or(""),
                face.type_line.as_deref().unwrap_or(""),
                " // ",
            );
            if joined.is_empty() { None } else { Some(joined) }
        };

        // _FACE_STAT_GROUPS: copied per GROUP from the first face that has any
        // of the group, so a numeric column and its _text twin always describe
        // the same face (the schema's check constraints couple them).
        let power_group_empty = merged.creature_power.is_none()
            && merged.creature_toughness.is_none()
            && merged.creature_power_text.is_none()
            && merged.creature_toughness_text.is_none();
        let face_has_power = face.creature_power.is_some()
            || face.creature_toughness.is_some()
            || face.creature_power_text.is_some()
            || face.creature_toughness_text.is_some();
        if power_group_empty && face_has_power {
            merged.creature_power = face.creature_power;
            merged.creature_toughness = face.creature_toughness;
            merged.creature_power_text = face.creature_power_text;
            merged.creature_toughness_text = face.creature_toughness_text;
        }
        // Upstream's second group: (planeswalker_loyalty, planeswalker_loyalty_text). Copied as a
        // PAIR from the first face that has any of the group, exactly like the power group above,
        // so the integer `loy:` filters on and the printed string a card object shows always
        // describe the same face.
        let loyalty_group_empty =
            merged.planeswalker_loyalty.is_none() && merged.planeswalker_loyalty_text.is_none();
        let face_has_loyalty =
            face.planeswalker_loyalty.is_some() || face.planeswalker_loyalty_text.is_some();
        if loyalty_group_empty && face_has_loyalty {
            merged.planeswalker_loyalty = face.planeswalker_loyalty;
            merged.planeswalker_loyalty_text = face.planeswalker_loyalty_text.clone();
        }
    }

    merged
}

/// `preprocess_card` for one bulk card object, canonical by default.
///
/// The one-argument shape every existing caller uses; feeds that only carry canonical rows
/// (default_cards) never say so explicitly. Foreign feeds go through [`transform_row`].
pub fn transform(bulk_card: &Value) -> Result<Option<RowDraft>, TransformError> {
    transform_row(bulk_card, true)
}

/// `preprocess_card` for one bulk card object.
///
/// A multi-face card (transform, MDFC, split, adventure, flip) becomes ONE row
/// carrying the front face's identity and every face's searchable data — see
/// [`merge_face_drafts`]. `Ok(None)` means every face (or the card itself) was
/// filtered, mirroring upstream's empty list.
///
/// `is_canonical` is the CALLER's fact — id-membership in Scryfall's default_cards — because
/// re-deriving Scryfall's selection is exactly the drift class the PIN_BONUS precedent exists
/// to eliminate. The engine routes non-canonical rows into its foreign annex.
pub fn transform_row(bulk_card: &Value, is_canonical: bool) -> Result<Option<RowDraft>, TransformError> {
    let card = bulk_card
        .as_object()
        .ok_or_else(|| TransformError::BadType { card: String::new(), field: "card" })?;

    // EVERY ROW IS IMPORTED. The only question the old filters still answer is whether the
    // printing carries `is:extra`, and that is a property of the PRINTING — decided once here,
    // never per face.
    let verdict = extras_class(card)?;

    // Line 134: lift the full card name before face processing.
    let card_name = required_str(card, s(card, "name").unwrap_or_default().as_str(), "name")?;

    // Faces are the parent dict overlaid with face data (precedence: face
    // overrides parent), each run through the full pipeline, then collapsed.
    if let Some(faces) = card.get("card_faces").and_then(Value::as_array) {
        let mut drafts: Vec<RowDraft> = Vec::with_capacity(faces.len());
        for face in faces {
            let Some(face_obj) = face.as_object() else { continue };
            let mut merged = card.clone();
            merged.remove("card_faces"); // don't keep recursing
            // Upstream pops the creature_* keys from the parent before merging;
            // those keys never exist on raw bulk objects, so nothing to do.
            for (k, v) in face_obj {
                merged.insert(k.clone(), v.clone());
            }
            drafts.push(build_draft(&merged, &card_name)?);
        }
        if drafts.is_empty() {
            return Ok(None);
        }
        let mut row = merge_face_drafts(drafts);
        // The engine's copy of the faces. Upstream also re-attaches them to
        // raw_card_blob for its image sync; this port stores no blob.
        row.card_faces = face_records(faces);
        // From `card`, not from any face overlay: upstream takes the residue from the card as
        // Scryfall sent it on both paths, and every key in it (ids, prices, finishes, set
        // metadata) belongs to the printing rather than to one of its faces. The printed
        // columns likewise — a face overlay's printed_name would masquerade as the card's.
        row.compat_blob = compat_blob(card);
        row.printed_name = s(card, "printed_name");
        row.flavor_name = s(card, "flavor_name");
        // ...and the LAYOUT, which is the one key on this list a face can genuinely carry. Scryfall
        // puts `layout` on the FACES of reversible cards and on nothing else — over the whole
        // 2026-08-15 all_cards bulk exactly 81 cards have a face-level `layout` and all 81 are
        // `reversible_card` — so the overlay above wrote the face's value onto the merged dict and
        // `merge_face_drafts` then kept the front's. Every one of the 81 was stored as some other
        // layout entirely (77 `normal`, 3 `adventure`, 1 `token`), which is why the corpus reported
        // zero reversible cards and `is:dfc` missed all ten `sld` printings the sweep still flagged.
        row.card_layout = s(card, "layout").map(|v| v.to_lowercase());
        row.set_extra(verdict);
        row.printed_type_line = s(card, "printed_type_line");
        row.printed_text = s(card, "printed_text");
        // ...and the ARTIST, for the same reason and on measured evidence. A card drawn by two
        // people carries the JOINED credit at top level ("David Martin & Franz Vohwinkel" on
        // Fire // Ice, dmr/215) and the per-face credit inside `card_faces`. The face overlay
        // above puts face 0's artist on the merged dict, so `merge_face_drafts` kept the FRONT
        // face's name and Scryfall's joined value never reached the column — this port answered
        // "David Martin". Upstream's card_processing.py has the same defect; per Decision 8d the
        // engine follows Scryfall, and the fix goes upstream with this evidence attached.
        //
        // Taking Scryfall's own string rather than re-joining the faces is what makes the two
        // degenerate shapes free: 4,951 multi-faced cards whose faces share ONE artist carry that
        // single name here (never "X & X"), and 1,158 SINGLE-faced cards are already credited to
        // two people ("Greg Hildebrandt & Tim Hildebrandt", uds/22) — a derivation from faces
        // could not have produced either. Measured over the whole 2026-08-16 default_cards bulk:
        // the separator is " & " with no third artist anywhere in the corpus (max artist_ids 2),
        // and every comma in an artist string is part of a name ("Ken Meyer, Jr."), never a
        // separator. `artist_ids` is not stored, so this string is also not re-splittable —
        // "Hari & Deepti" is ONE artist of ten cards.
        //
        // The column feeds three surfaces, and all three were wrong together: the card object's
        // `artist`, `order=artist` (api.scryfall.com sorts Fire // Ice AFTER all six plain
        // "David Martin" dmr cards, i.e. on the joined string), and `a:` (`a:"franz vohwinkel"`
        // matches Fire // Ice there — artist search covers NON-FRONT faces). The third falls out
        // of the first: `a:` compares the COLLATED artist, which drops the " & ", so every
        // artist's own collated name is a substring of the joined one.
        row.card_artist = s(card, "artist");
        row.card_artist_folded = row.card_artist.as_deref().map(|a| fold_accents(&a.to_lowercase()));
        row.printed_name_folded = printed_name_folded(card, &row.card_faces);
        row.flavor_name_folded = row.flavor_name.as_deref().map(|v| fold_accents(&v.to_lowercase()));
        row.is_canonical = is_canonical;
        return Ok(Some(row));
    }

    let mut row = build_draft(card, &card_name)?;
    row.compat_blob = compat_blob(card);
    row.printed_name = s(card, "printed_name");
    row.flavor_name = s(card, "flavor_name");
    row.set_extra(verdict);
    row.printed_type_line = s(card, "printed_type_line");
    row.printed_text = s(card, "printed_text");
    row.printed_name_folded = printed_name_folded(card, &row.card_faces);
    row.flavor_name_folded = row.flavor_name.as_deref().map(|v| fold_accents(&v.to_lowercase()));
    row.is_canonical = is_canonical;
    Ok(Some(row))
}

// ─── cross-card aggregation: tag attach + score backfills ───────────────────

/// Round to 4 decimal places, half away from zero — Postgres
/// `ROUND(numeric, 4)` semantics used by the illustration_count component.
fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// Upstream's `art_style` predicate: licensed-crossover or stylistic-departure art.
///
/// `external-ip` is the Scryfall tagger's parent tag over ~57 licensed franchises;
/// `dungeons-and-dragons` and `the-lord-of-the-rings` are exempt because their art matches
/// Magic's high-fantasy look. Shared by the `art_style` component and by [`pin_applies`], so the
/// score and the pin cannot disagree about what "off style" means.
pub fn is_off_style(art_tags: &[&str]) -> bool {
    let has = |t: &str| art_tags.contains(&t);
    (has("external-ip") && !(has("dungeons-and-dragons") || has("the-lord-of-the-rings")))
        || has("anime")
        || has("comic-style")
        || has("line-art")
        || has("word-art-title")
}

/// Added to the printing Scryfall's `oracle_cards` file names as a card's representative.
///
/// UNCONDITIONAL here, and that is a deliberate divergence from upstream. This port's whole
/// purpose is to answer like Scryfall, so where Scryfall has named a representative that answer
/// wins outright — including on the 213 cards where its pick is licensed-crossover art (Marvel
/// Super Heroes Commander for Birds of Paradise, Harmonize, Shock, Skullclamp) that upstream's
/// `art_style` component deliberately demotes. Upstream optimises "the version that looks like
/// Magic" and is right to keep that veto; this port optimises "what Scryfall would have said".
///
/// Large enough to dominate every real component sum (components land in ~130-220), because this
/// is a PIN rather than another weight: where the label exists and applies, it decides. It rides
/// UNDER the printing rank added by [`crate::ranks`], which is why it can stay this size: the
/// rank's first key is "is this slot pinned", so a pinned printing is rank 0 and this bonus no
/// longer has to out-shout anything — it carries the same magnitude into the cross-card
/// comparisons that read the score, which is the only reason it is still added at all. `prefer_score`
/// still ranks everything underneath it, which is what the ~3.4% of cards with no usable label,
/// the per-artwork-group representatives `unique=artwork` needs, and every filtered query fall
/// back on.
///
/// APPLIED BY PRINTING SLOT, NOT BY ID — see [`PinnedPrintings`]. The label names ONE scryfall_id
/// and it is always an English printing, so pinning that id alone leaves every foreign row of the
/// same card scored by raw `prefer_score`; Scryfall's own within-language representative is the
/// printing at the SAME (set_code, collector_number) as its English one, which raw prefer_score
/// gets wrong wherever a showcase printing outscores the pinned slot (14 of 175 `e:khm lang:ja`
/// cards, verified against api.scryfall.com 2026-08-16).
pub const PIN_BONUS: f64 = 1000.0;

/// The printing SLOT a pin applies to: `(oracle_id, set_code, collector_number)`.
///
/// oracle_id is in the key so the propagation stays a per-CARD fact — two cards can only collide
/// on (set, number) across languages of the same card, and keying by card rather than by set slot
/// makes the whole thing partition-local (every printing of a card hashes to one partition), which
/// is what lets the nightly coordinator compute it per partition and the native builder compute it
/// while the corpus streams.
pub type PinKey = (String, String, String);

/// The (set, collector-number) slots Scryfall's labels named, per card.
///
/// Built in each import path's per-card pass — the same pass that already computes illustration
/// counts — and consulted by [`is_pinned`] once per row. A row with no set code or no collector
/// number cannot be addressed by slot and is therefore never a propagation source or target; the
/// labelled row itself is still pinned by its id, so such a card scores exactly as it did before
/// this propagation existed.
#[derive(Debug, Default, Clone)]
pub struct PinnedPrintings(std::collections::HashSet<PinKey>);

impl PinnedPrintings {
    /// Record `r`'s slot when `r` is the printing a label names. Cheap enough to call per row.
    pub fn observe(&mut self, r: &RowDraft, labels: &std::collections::HashSet<String>) {
        if labels.contains(&r.scryfall_id)
            && let Some(key) = pin_key(r)
        {
            self.0.insert(key);
        }
    }

    /// Does `r` sit in a slot a label named?
    pub fn contains(&self, r: &RowDraft) -> bool {
        pin_key(r).is_some_and(|key| self.0.contains(&key))
    }

    /// The same question asked of a slot rather than a row — what the printing ranking needs,
    /// which orders SLOTS and so never has a row in hand (see `ranks::PrintingRanks::seal`).
    pub fn contains_key(&self, key: &PinKey) -> bool {
        self.0.contains(key)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Pin a slot directly. `ranks.rs` orders SLOTS, so its tests need a pinned slot without a
    /// `RowDraft` to build one from; production code reaches this set only through `observe`.
    #[cfg(test)]
    pub(crate) fn pin_slot_for_test(&mut self, key: PinKey) {
        self.0.insert(key);
    }
}

/// `r`'s [`PinKey`], or None when it has no addressable slot (no set code or no collector number).
pub fn pin_key(r: &RowDraft) -> Option<PinKey> {
    Some((r.oracle_id.clone(), r.card_set_code.clone()?, r.collector_number.clone()?))
}

/// Whether this row gets [`PIN_BONUS`]: it IS the labelled printing, or it shares that printing's
/// slot (its own language's edition of it).
///
/// Exactly +PIN_BONUS once, never twice, so the pin stays a PIN and raw `prefer_score` still
/// breaks ties WITHIN a pinned slot (the several rows of one (set, number) in different languages
/// order among themselves by the ordinary components, English first by the +40 language term).
pub fn is_pinned(
    r: &RowDraft,
    labels: &std::collections::HashSet<String>,
    pins: &PinnedPrintings,
) -> bool {
    labels.contains(&r.scryfall_id) || pins.contains(r)
}

/// backfill_prefer_scores.sql, one row: every component of
/// `prefer_score_components`, summed into `prefer_score`.
/// `illustration_count` is the number of qualifying rows sharing this row's
/// (illustration_id, card_name) — see [`finalize`] for the corpus-wide count.
fn prefer_score(draft: &RowDraft, art_tags: &[&str], illustration_count: u64) -> f64 {
    let mut total = 0.0f64;

    // 'illustration_count': 23 * LN(1 + COUNT(*)) / LN(40), rounded to 4 places.
    total += round4(23.0 * (1.0 + illustration_count as f64).ln() / 40.0f64.ln());

    // 'rarity'
    total += match draft.card_rarity_int {
        Some(0) => 16.0, // common
        Some(1) => 16.0, // uncommon
        Some(2) => 11.0, // rare
        _ => 0.0,        // mythic and everything else
    };

    // 'border'
    total += if draft.card_border.as_deref() == Some("black") { 14.0 } else { 0.0 };

    // 'frame': first matching frame-data key wins (SQL CASE order).
    let has_frame = |k: &str| draft.card_frame_data.iter().any(|f| f == k);
    total += if has_frame("2015") {
        42.0
    } else if has_frame("2003") {
        30.0
    } else if has_frame("1997") {
        25.0
    } else if has_frame("1993") {
        10.0
    } else {
        0.0
    };

    // 'extended_art' ("extendedart".title() == "Extendedart"). NEGATIVE: an extended-art printing
    // is a variant, not the version most people picture, so it scores below the base printing of
    // the same set rather than above it. Was +12, which was the single largest disagreement with
    // Scryfall's own representative choice — see upstream #920 for the corpus and the holdout.
    total += if has_frame("Extendedart") { -6.0 } else { 0.0 };

    // 'highres_scan' (raw_card_blob ->> 'image_status')
    total += if draft.raw_image_status_highres { 16.0 } else { 0.0 };

    // 'has_paper' (raw_card_blob -> 'games' ? 'paper'; always true post-filter,
    // but computed anyway to mirror the SQL)
    total += if draft.raw_has_paper { 6.0 } else { 0.0 };

    // 'language' (raw_card_blob ->> 'lang')
    total += if draft.raw_lang_en { 40.0 } else { 0.0 };

    // 'legendary_frame' (raw frame_effects, lowercase — NOT card_frame_data)
    total += if draft.raw_frame_effect_legendary { 5.0 } else { 0.0 };

    // 'non_showcase'
    total += if !draft.raw_frame_effect_showcase { 10.0 } else { 0.0 };

    // 'finish': nonfoil > foil > etched, first match.
    total += if draft.raw_finish_nonfoil {
        10.0
    } else if draft.raw_finish_foil {
        5.0
    } else {
        0.0 // etched or no finish data
    };

    // 'artwork_set': everything except the dbl set.
    total += match draft.card_set_code.as_deref() {
        Some("dbl") => 0.0,
        _ => 20.0,
    };

    // 'art_style': licensed-crossover / stylistic-departure art gets no bonus.
    total += if is_off_style(art_tags) { 0.0 } else { 14.0 };

    total
}

/// backfill_cubecobra_scores.sql: one score per distinct card_name, propagated
/// to all printings. score = Σ weight_d * PERCENT_RANK_d, weights normalized to
/// sum to 100 (api_resource.py backfill_cubecobra_scores: four weights of 1 →
/// 25.0 each). This pipeline never runs the separate /ingest_cubecobra route,
/// so the three cubecobra_* columns are NULL for every card — an all-NULL
/// dimension is a single PERCENT_RANK peer group (rank 1 → 0.0) contributing
/// nothing, exactly as in Postgres — leaving 25 * PERCENT_RANK(edhrec_rank ASC
/// NULLS LAST).
fn cubecobra_scores_by_name(drafts: &[RowDraft]) -> HashMap<String, f64> {
    // DISTINCT ON (card_name): one representative row per name (edhrec_rank is
    // per-oracle-card in the bulk data, so all printings agree; first-seen is
    // as good as Postgres's unspecified tie-break).
    let mut per_name: Vec<(&str, Option<i64>)> = Vec::new();
    let mut seen: HashMap<&str, ()> = HashMap::new();
    for d in drafts {
        if seen.insert(d.card_name.as_str(), ()).is_none() {
            per_name.push((d.card_name.as_str(), d.edhrec_rank));
        }
    }
    cubecobra_scores_from_pairs(&per_name)
}

/// The cubecobra score computation over already-deduped (name, edhrec_rank)
/// pairs, in first-seen order. Shared with the wasm import's aggregation
/// pass, which collects the same pairs while streaming drafts from external
/// storage.
pub fn cubecobra_scores_from_pairs(per_name: &[(&str, Option<i64>)]) -> HashMap<String, f64> {
    const W_EDHREC: f64 = 25.0;

    let n = per_name.len();
    if n == 0 {
        return HashMap::new();
    }

    // PERCENT_RANK() OVER (ORDER BY edhrec_rank ASC NULLS LAST) =
    // (rank - 1) / (n - 1), where rank is 1 + the number of rows strictly
    // before this row's peer group. NULLs form one trailing peer group.
    let mut sorted: Vec<Option<i64>> = per_name.iter().map(|(_, r)| *r).collect();
    sorted.sort_by_key(|r| (r.is_none(), r.unwrap_or(0)));
    // rank of a value = index of its first occurrence + 1
    let mut first_index: HashMap<Option<i64>, usize> = HashMap::new();
    for (i, r) in sorted.iter().enumerate() {
        first_index.entry(*r).or_insert(i);
    }

    per_name
        .iter()
        .map(|&(name, rank_val)| {
            let pr = if n == 1 {
                0.0
            } else {
                first_index[&rank_val] as f64 / (n - 1) as f64
            };
            (name.to_string(), W_EDHREC * pr)
        })
        .collect()
}

/// The finalize inputs that are CORPUS-WIDE — accumulated while the corpus streams past, then
/// sealed. Two of them, and neither survives being computed per partition:
///
///   * `cubecobra_score` is a PERCENT_RANK over the distinct card names of the WHOLE corpus, so
///     over 1/Nth of the names it produces different numbers for the same card — and the archive
///     both stores the value and sorts on it (`orderby=cubecobra`).
///   * `illustration_count` counts rows sharing `(illustration_id, card_name)`. That key carries
///     NO oracle_id, so unlike every other per-card aggregate nothing in the data model makes it
///     partition-local: two cards with one name and one illustration would be counted short in
///     both partitions. It has never happened (0 of 46,487 groups on the real 517,746-row corpus,
///     measured 2026-08-16) — but "has never happened" is the reason to count it where the
///     question cannot arise rather than to guard the place it can.
///
/// WHY THIS IS A STRUCTURE RATHER THAN TWO LOCALS. The native builder keeps the equivalent
/// resident while the drafts spill to disk (spill.rs's `CorpusAggregator`); the nightly
/// coordinator fills THIS one in a global phase before its partition loop and carries it through
/// the [`TagData`] snapshot — the one persistence path `CanonicalIds` already rides. Both paths
/// seal through the same `cubecobra_scores_from_pairs` and count through the same
/// [`illust_count_qualifies`], which is where the parity is.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct CorpusTables {
    /// Distinct card names in FIRST-SEEN order with the edhrec_rank of the first row carrying each
    /// — the percent-rank's input. Emptied by [`CorpusTables::seal`].
    #[serde(default)]
    pending: Vec<(String, Option<i64>)>,
    /// card_name → score, present only once sealed. `Option` rather than an empty map because an
    /// unsealed table read as "no scores" is a store whose whole cubecobra column is silently
    /// null — the callers check [`CorpusTables::is_sealed`] instead of guessing.
    #[serde(default)]
    scores: Option<HashMap<String, f64>>,
    /// [`illust_group_key`] → qualifying rows in that group. Flat string keys rather than a
    /// `(String, String)` tuple because this map is snapshotted as JSON, whose object keys are
    /// strings; the separator is a byte neither a UUID nor a card name can contain.
    #[serde(default)]
    illust: HashMap<String, u64>,
    /// Every artist's credited spellings, keyed by `artist_ids` uuid — the input to
    /// `card_artist_alt`, and the third corpus-wide fact this table carries because a partition
    /// build cannot reconstruct it. See `ArtistSpellings`. ~2.4k entries; it rides the snapshot
    /// with the rest, so it survives a DO eviction mid-import exactly as the scores do.
    #[serde(default)]
    artists: ArtistSpellings,
    /// card_name → index into `pending`, rebuilt on demand (a restored snapshot has none).
    #[serde(skip)]
    index: HashMap<String, usize>,
}

impl CorpusTables {
    /// Observe one draft: its name for the percent-rank (first-seen wins, exactly as
    /// `cubecobra_scores_by_name`'s `DISTINCT ON (card_name)` does over the deduped rows), and its
    /// illustration group when the row qualifies for counting ([`illust_count_key`]'s predicate).
    pub fn observe_artists(&mut self, artist: Option<&str>, compat_blob: &Map<String, Value>) {
        observe_artist_spellings(&mut self.artists, artist, compat_blob);
    }

    /// The corpus's artist-entity relation, handed to each partition's builder — see
    /// `artist_entity_table`.
    pub fn artist_entities(&self) -> Value {
        artist_entity_table(&self.artists)
    }

    /// Artists with more than one credited spelling — the only ones `card_artist_alt` names.
    pub fn multi_spelling_artists(&self) -> usize {
        self.artists.values().filter(|s| s.len() > 1).count()
    }

    pub fn observe(&mut self, card_name: &str, edhrec_rank: Option<i64>, illust_key: Option<&str>) {
        if self.index.len() != self.pending.len() {
            // Restored snapshot: the skipped index is stale — rebuild.
            self.index = self.pending.iter().enumerate().map(|(i, (n, _))| (n.clone(), i)).collect();
        }
        if !self.index.contains_key(card_name) {
            self.index.insert(card_name.to_owned(), self.pending.len());
            self.pending.push((card_name.to_owned(), edhrec_rank));
        }
        if let Some(ill) = illust_key {
            *self.illust.entry(illust_group_key(ill, card_name)).or_insert(0) += 1;
        }
    }

    /// Compute the percent-rank over everything observed and drop its inputs (the illustration
    /// counts are already final). Idempotent: a second call keeps the sealed table, so the
    /// phase's last slice can be retried.
    pub fn seal(&mut self) -> usize {
        if self.scores.is_none() {
            let pairs: Vec<(&str, Option<i64>)> = self.pending.iter().map(|(n, r)| (n.as_str(), *r)).collect();
            self.scores = Some(cubecobra_scores_from_pairs(&pairs));
        }
        self.pending = Vec::new();
        self.index = HashMap::new();
        self.names()
    }

    pub fn is_sealed(&self) -> bool {
        self.scores.is_some()
    }

    /// This name's cubecobra score, or None when the table is unsealed or the name was never seen.
    pub fn cubecobra(&self, card_name: &str) -> Option<f64> {
        self.scores.as_ref().and_then(|m| m.get(card_name).copied())
    }

    /// Qualifying rows sharing this row's (illustration_id, card_name); 0 for a row with no
    /// illustration id, which is what the SQL's NULL equality yields.
    pub fn illustration_count(&self, illustration_id: Option<&str>, card_name: &str) -> u64 {
        illustration_id
            .and_then(|ill| self.illust.get(&illust_group_key(ill, card_name)))
            .copied()
            .unwrap_or(0)
    }

    /// Distinct names — sealed scores if sealed, observations otherwise.
    pub fn names(&self) -> usize {
        self.scores.as_ref().map_or(self.pending.len(), HashMap::len)
    }

    /// Distinct (illustration_id, card_name) groups counted.
    pub fn illustration_groups(&self) -> usize {
        self.illust.len()
    }
}

/// The illustration-count group key, `illustration_id \u{1f} card_name`. One definition, because
/// a key built differently at write and read time is a silent zero count.
fn illust_group_key(illustration_id: &str, card_name: &str) -> String {
    let mut key = String::with_capacity(illustration_id.len() + card_name.len() + 1);
    key.push_str(illustration_id);
    key.push('\u{1f}');
    key.push_str(card_name);
    key
}

fn keys_true<S: AsRef<str>>(keys: &[S]) -> Value {
    let mut m = Map::new();
    for k in keys {
        m.insert(k.as_ref().to_owned(), Value::Bool(true));
    }
    Value::Object(m)
}

fn opt_str_val(v: &Option<String>) -> Value {
    v.as_ref().map_or(Value::Null, |s| Value::String(s.clone()))
}

fn opt_i64_val(v: Option<i64>) -> Value {
    v.map_or(Value::Null, |n| json!(n))
}

fn opt_f64_val(v: Option<f64>) -> Value {
    v.map_or(Value::Null, |n| json!(n))
}

/// Store a float the way it comes back from a Postgres `real` column: rounded
/// through f32. Both score columns are `real`; the engine reads them as f32.
fn real_val(v: f64) -> Value {
    json!(v as f32 as f64)
}

/// Cross-card aggregation + row emission.
///
/// Consumes the full draft set (one entry per bulk card that survived
/// preprocessing; ~100k), applies:
///   1. last-wins dedupe by scryfall_id (bulk_upsert `_dedupe_rows` — bulk data
///      should never repeat ids, but the upsert semantics are mirrored anyway),
///   2. tag attachment (tag_import.py `_sync_card_tags`: card_oracle_tags by
///      oracle_id, card_art_tags by illustration_id, absent → {}),
///   3. the prefer-score backfill (backfill_prefer_scores.sql), whose
///      illustration_count component counts qualifying magic.cards rows sharing
///      (illustration_id, card_name),
///   4. the cubecobra-score backfill (backfill_cubecobra_scores.sql).
///
/// It yields one `serde_json::Value` object per row with exactly the ENGINE_COLUMNS key set, in
/// the shape `card_from_pydict` consumes.
///
/// Sequencing note: upstream's `_run_import_under_lock` computes prefer scores
/// BEFORE importing tags, against the art tags left in the DB by the previous
/// import cycle (the card upsert skips tag columns, so they survive). A fresh
/// build has no previous cycle; computing prefer scores from this run's tags
/// reproduces upstream's steady state.
pub fn finalize(drafts: Vec<RowDraft>, tags: &TagData) -> impl Iterator<Item = Value> + use<> {
    // 1. last-wins dedupe by scryfall_id, preserving first-seen position
    //    (order is irrelevant to the consumer — _reload_engine's SELECT has no
    //    ORDER BY — but determinism keeps builds reproducible).
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut rows: Vec<RowDraft> = Vec::with_capacity(drafts.len());
    for d in drafts {
        match index.get(&d.scryfall_id) {
            Some(&i) => rows[i] = d,
            None => {
                index.insert(d.scryfall_id.clone(), rows.len());
                rows.push(d);
            }
        }
    }
    drop(index);

    // 3a. illustration_count: COUNT(*) of rows with the same illustration_id
    //     and card_name where lang='en', set_type <> 'memorabilia' and border
    //     not in ('gold','yellow') (backfill_prefer_scores.sql lines 31-45).
    //     NULL illustration_id never matches (SQL NULL equality), giving 0.
    let mut illust_counts: HashMap<(String, String), u64> = HashMap::new();
    for r in &rows {
        if let Some(ill) = illust_count_key(r) {
            *illust_counts.entry((ill.to_owned(), r.card_name.clone())).or_insert(0) += 1;
        }
    }

    // 4. cubecobra scores per card_name.
    let cubecobra = cubecobra_scores_by_name(&rows);

    // 5. the slots Scryfall's labels named, so the pin reaches every language's edition of the
    //    labelled printing and not just the (always English) row the label names. Same per-card
    //    pass shape as the illustration counts above; see PIN_BONUS.
    let mut pins = PinnedPrintings::default();
    for r in &rows {
        pins.observe(r, &tags.labels);
    }

    // 6. the order each card's printings are chosen in when a filter excludes the pinned one —
    //    same per-card pass shape again, sealed against the pins because "is this slot pinned"
    //    is the first key of that order. See `ranks`.
    let mut ranks = crate::ranks::PrintingRanks::default();
    for r in &rows {
        ranks.observe(r);
    }
    ranks.seal(&pins);

    let empty: Vec<u32> = Vec::new();
    let tags = tags.clone();
    rows.into_iter().map(move |r| {
        let oracle_tags = tags.resolve(tags.oracle.get(&r.oracle_id).unwrap_or(&empty));
        let art_tags = art_tags_of(&tags, &r);
        let illustration_count = r
            .illustration_id
            .as_ref()
            .and_then(|ill| illust_counts.get(&(ill.clone(), r.card_name.clone())))
            .copied()
            .unwrap_or(0);
        let cubecobra_score = cubecobra.get(&r.card_name).copied();
        let pinned = is_pinned(&r, &tags.labels, &pins);
        let rank = ranks.rank_of(&r);
        finalize_row(r, &oracle_tags, &art_tags, illustration_count, cubecobra_score, pinned, rank)
    })
}

/// Every illustration this printing SHOWS, front first, deduped: the row's own
/// `illustration_id` plus each face's.
///
/// A single-faced card has exactly one, and a card whose faces carry no art of their own (split,
/// flip, adventure — Scryfall puts one `illustration_id` on the card and none on the faces) also
/// has exactly one. A double-faced card has TWO, and only the front's is the row's own: the face
/// merge (store-kv.ts generation 5) puts face 0's keys on the merged dict, so `illustration_id` is
/// the FRONT face's and the back's exists only inside `card_faces`.
pub fn illustration_ids(r: &RowDraft) -> Vec<&str> {
    let mut ids: Vec<&str> = Vec::new();
    if let Some(ill) = r.illustration_id.as_deref().filter(|s| !s.is_empty()) {
        ids.push(ill);
    }
    for face in &r.card_faces {
        if let Some(ill) = face.get("illustration_id").and_then(Value::as_str).filter(|s| !s.is_empty())
            && !ids.contains(&ill)
        {
            ids.push(ill);
        }
    }
    ids
}

/// `card_art_tags` for a row: the UNION of the art tags of every illustration it shows.
///
/// THIS PORT DIVERGES FROM UPSTREAM'S SQL, because Scryfall diverges from it. `_sync_card_tags`
/// matches `card_art_tags` on the row's single `illustration_id` column, which for a
/// double-faced card is its FRONT face's — so a back-face-only tag was unreachable. Scryfall
/// answers otherwise, measured 2026-08-16 against api.scryfall.com:
///
/// * `arttag:snow e:khm` — 75 there, 73 here. The two missing are `Birgi, God of Storytelling //
///   Harnfel, Horn of Bounty` and `Esika, God of the Tree // The Prismatic Bridge`, whose snow is
///   on the BACK face's art.
/// * `-art:human e:khm t:creature` — 135 there, 136 here, the extra being `Valki, God of Lies //
///   Tibalt, Cosmic Impostor`: Tibalt is the human, and Tibalt is the back.
///
/// Scope on the 2026-08-16 bulk: 9,368 printings carry more than one illustration and 5,491 of
/// them gain at least one tag from a non-front face.
///
/// One definition, three callers — this path, the spill aggregation and the wasm import — so no
/// import path can attach a different tag set than another.
pub fn art_tags_of<'a>(tags: &'a TagData, r: &RowDraft) -> Vec<&'a str> {
    const EMPTY: &[u32] = &[];
    let ids = illustration_ids(r);
    // One illustration is the overwhelming majority and its stored list is ALREADY sorted by slug
    // text and deduped (tags.rs `finish_into`), so it is returned untouched rather than re-sorted.
    if ids.len() < 2 {
        return tags.resolve(ids.first().and_then(|ill| tags.art.get(*ill)).map_or(EMPTY, Vec::as_slice));
    }
    let mut out: Vec<&str> = Vec::new();
    for ill in ids {
        out.extend(tags.resolve(tags.art.get(ill).map_or(EMPTY, Vec::as_slice)));
    }
    // Back into the invariant a single list already satisfies: sorted by slug text, deduped.
    out.sort_unstable();
    out.dedup();
    out
}

/// The illustration_count predicate (backfill_prefer_scores.sql lines 31-45):
/// returns the row's illustration_id when the row qualifies for counting.
/// Shared by the native aggregation above and the wasm import's aggregation
/// pass, so the two paths cannot drift.
pub fn illust_count_key(r: &RowDraft) -> Option<&str> {
    let ill = r.illustration_id.as_deref()?;
    illust_count_qualifies(r.raw_lang_en, r.raw_set_type.as_deref(), r.card_border.as_deref()).then_some(ill)
}

/// The predicate alone, over the three raw values it reads.
///
/// Split out so the global scores pass — which deserializes a NARROW struct rather than a whole
/// `RowDraft`, three fields out of fifty — asks the same question the row-level path asks, from
/// the same code.
pub fn illust_count_qualifies(raw_lang_en: bool, raw_set_type: Option<&str>, card_border: Option<&str>) -> bool {
    raw_lang_en
        && raw_set_type != Some(MEMORABILIA_SET_TYPE)
        && !matches!(card_border, Some("gold") | Some("yellow"))
}

/// Emit one finalized ENGINE_COLUMNS row from a draft plus its aggregation
/// inputs. Split out of [`finalize`]'s closure so the wasm (Durable Object)
/// import path — which streams drafts from external storage instead of
/// holding a Vec — produces byte-identical rows through the same code.
/// Every credited spelling of one artist ENTITY, keyed by Scryfall's `artist_ids` uuid.
///
/// CORPUS-WIDE, and that is the whole reason it exists rather than being derived inside the
/// engine. `a:` is an artist-ENTITY match — a needle matching any one of an artist's spellings
/// answers for all of that artist's printings (`a:"don't mess"` answers `a:"rebecca guay"`'s 399
/// on api.scryfall.com, 2026-08-17). The store is PARTITIONED by oracle_id, and each partition is
/// built from its own rows alone: the partition holding `Persecute Artist` would learn that
/// `Rebecca "Don't Mess with Me" Guay` names the same artist as `Rebecca Guay`, and the other nine
/// would not — so `a:"don't mess"` would answer that one partition's rows and silently drop the
/// rest. Measured on the first build that tried it: 25 cards against Scryfall's 166.
///
/// So the relation is resolved HERE, where the whole corpus is in hand, and travels to every
/// partition on the rows themselves (`card_artist_alt`). Both import paths keep their own copy for
/// the same reason they each keep their own illustration counts and cubecobra scores.
pub type ArtistSpellings = HashMap<String, BTreeSet<String>>;

/// A printing's credit split into `(artist_id, that artist's spelling)`, Scryfall's own alignment.
///
/// POSITIONAL: `artist_ids[i]` names the `i`th " & "-joined component. Two rules, both measured
/// over the whole 2026-08-16 default_cards bulk:
///
/// - ONE id is the whole credit even when it contains the separator. `Hari & Deepti` is a single
///   artist of ten printings; re-splitting it would invent two and give each the other's cards.
///   10 rows take this branch.
/// - a count that does not line up yields NOTHING rather than a guessed alignment — an alignment
///   that slips by one credits the wrong person. 0 rows take this branch.
///
/// Takes the two inputs rather than a `RowDraft` so the DO's scores phase — which parses a narrow
/// subset of the draft to keep the corpus pass inside a 124MiB isolate — can call it unchanged.
fn artist_credit_components<'a>(artist: Option<&'a str>, compat_blob: &'a Map<String, Value>) -> Vec<(&'a str, &'a str)> {
    let Some(artist) = artist else { return Vec::new() };
    let Some(ids) = compat_blob
        .get("artist_ids")
        .and_then(Value::as_array)
        // All-or-nothing, like the count check below: a non-string element must not shift the rest.
        .and_then(|a| a.iter().map(Value::as_str).collect::<Option<Vec<&str>>>())
    else {
        return Vec::new();
    };
    if ids.len() == 1 {
        return vec![(ids[0], artist)];
    }
    let parts: Vec<&str> = artist.split(" & ").collect();
    if parts.len() != ids.len() {
        return Vec::new();
    }
    ids.into_iter().zip(parts).collect()
}

/// Record one FINALIZED ROW's credit into the corpus-wide table.
///
/// The row-iterator build paths (`build_store`, `build_store_partitioned`) are handed rows rather
/// than drafts, and `artist_ids` survives into the row untouched — it rides the compat residue,
/// which is subtractive. So those paths compute the same table from the same facts, which is what
/// keeps a natively-built store and a wasm-built one answering `a:` identically. The rule is
/// simply WHOEVER HOLDS THE WHOLE CORPUS COMPUTES IT: a partition build must be handed the result.
pub fn observe_artist_spellings_row(table: &mut ArtistSpellings, row: &Value) {
    static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
    let blob = row.get("card_compat_blob").and_then(Value::as_object).unwrap_or(&EMPTY);
    observe_artist_spellings(table, row.get("card_artist").and_then(Value::as_str), blob);
}

/// Record one draft's credit into the corpus-wide table.
pub fn observe_artist_spellings(table: &mut ArtistSpellings, artist: Option<&str>, compat_blob: &Map<String, Value>) {
    for (id, spelling) in artist_credit_components(artist, compat_blob) {
        table.entry(id.to_owned()).or_default().insert(spelling.to_owned());
    }
}

/// The whole corpus's artist-entity relation as ONE object — `[[[lowercase, accent-folded], ...],
/// ...]`, one row per artist with more than one credited spelling.
///
/// ONE OBJECT PER ARCHIVE, NOT PER ROW, and that placement is the whole design rather than a
/// tidy-up. Written onto the rows instead, this is O(that artist's spellings) on EVERY row
/// crediting them, which has no bound: the gate's synthetic corpus gives one artist id 4,359
/// distinct credit strings, so each of its rows carried a 146KB table and `rows.jsonl` went from
/// 198MB to 6.5GB — an out-of-memory in the capped wasm import, which is the nightly's own build
/// path. Handed to the builder once, it is ~2KB whatever the corpus does.
///
/// ONLY the artists with more than one spelling — 28 of 2,396 in the 2026-08-16 all_cards bulk.
/// A single-spelling artist has nothing to add: `collate_name` strips the " & ", so that artist's
/// one collated spelling is a contiguous substring of every collated credit naming them
/// (`davidmartin` and `franzvohwinkel` both sit inside `davidmartinfranzvohwinkel`), and the
/// engine's plain vocab scan already answers for every one of those credits.
///
/// The ARTIST IDS THEMSELVES ARE NOT CARRIED. They did their work here — deciding which spellings
/// are one person — and the engine relates a spelling to a credit by the same `contains` rule `a:`
/// already runs on, so a uuid would be a key nothing reads.
///
/// BOTH CASES of the fold, because the engine has no NFKD — the builder owns folding, which is why
/// `card_name_folded` and `card_artist_folded` arrive pre-folded. `a:` compares the collated fold;
/// a non-ASCII needle also compares the unfolded spelling, collated on the fly.
pub fn artist_entity_table(table: &ArtistSpellings) -> Value {
    let mut entities: Vec<Value> = table
        .values()
        .filter(|s| s.len() > 1)
        .map(|spellings| {
            Value::Array(
                spellings
                    .iter()
                    .map(|s| {
                        let lower = s.to_lowercase();
                        json!([lower, fold_accents(&lower)])
                    })
                    .collect(),
            )
        })
        .collect();
    // Deterministic archive bytes: `ArtistSpellings` is a HashMap and its iteration order is not.
    entities.sort_unstable_by_key(std::string::ToString::to_string);
    Value::Array(entities)
}

pub fn finalize_row(
    r: RowDraft,
    oracle_tags: &[&str],
    art_tags: &[&str],
    illustration_count: u64,
    cubecobra_score: Option<f64>,
    // This printing sits in the slot Scryfall's `oracle_cards` file names as the card's
    // representative — it either IS that printing or shares its (set_code, collector_number), i.e.
    // it is that printing in another language ([`is_pinned`]). Decided by the CALLER because it
    // needs a per-card fact the row alone cannot answer, and every import path already makes a
    // per-card pass — keeping the decision there is what stops the paths drifting.
    pinned: bool,
    // Where this printing's SLOT sits in its card's order (`ranks::PrintingRanks`) — the other
    // per-card fact, decided by the caller for the same reason `pinned` is. `RANK_SPAN` (last)
    // for a row no import path ranked, which is what a caller that has no ranking passes.
    rank: u32,
) -> Value {
    {
        // The rank leads by construction: one rank step outweighs the ordinary score and the pin
        // bonus together, so the card's order is the measured rule and everything underneath only
        // breaks ties WITHIN one slot (its languages) and orders CARDS against each other exactly
        // as it did before. See `ranks` for the measurement and the encoding argument.
        let prefer = crate::ranks::rank_term(rank)
            + prefer_score(&r, art_tags, illustration_count)
            + if pinned { PIN_BONUS } else { 0.0 };

        // Exactly ENGINE_COLUMNS (card_engine/card_engine/__init__.py lines
        // 40-84) plus `planeswalker_loyalty_text`, which card_from_pydict reads and upstream's
        // list omits — see the note at its insert below. Columns the engine never reads
        // (raw_card_blob, devotion, face_name/face_idx, rarity text, prefer_score_components,
        // cubecobra_* raw columns) are not emitted.
        let mut m = Map::with_capacity(50);
        m.insert("scryfall_id".into(), Value::String(r.scryfall_id));
        m.insert("oracle_id".into(), Value::String(r.oracle_id));
        m.insert("illustration_id".into(), opt_str_val(&r.illustration_id));
        m.insert("card_artist".into(), opt_str_val(&r.card_artist));
        m.insert("card_artist_folded".into(), opt_str_val(&r.card_artist_folded));
        m.insert("card_border".into(), opt_str_val(&r.card_border));
        m.insert("card_color_identity".into(), keys_true(&r.card_color_identity));
        m.insert("card_colors".into(), keys_true(&r.card_colors));
        m.insert("card_frame_data".into(), keys_true(&r.card_frame_data));
        // Only the BOOLEAN_IS_TAGS subset: those come off the bulk card's own
        // booleans (_sync_boolean_is_tags, which runs after every upsert). The
        // CUSTOM_IS_TAGS still need upstream's per-tag Scryfall search sweep and
        // stay absent here, as they are under upstream's own automated import.
        m.insert("card_is_tags".into(), keys_true(&r.card_is_tags));
        m.insert("card_keywords".into(), keys_true(&r.card_keywords));
        // An ARRAY, not a {key: true} object: this one exists for its ORDER, which a JSON object
        // loses on the way through serde_json's BTreeMap.
        m.insert(
            "card_keywords_printed".into(),
            Value::Array(r.card_keywords_printed.into_iter().map(Value::String).collect()),
        );
        m.insert("card_layout".into(), opt_str_val(&r.card_layout));
        m.insert("life_modifier".into(), opt_str_val(&r.life_modifier));
        m.insert("hand_modifier".into(), opt_str_val(&r.hand_modifier));
        m.insert("card_legalities".into(), Value::Object(r.card_legalities));
        m.insert("card_name".into(), Value::String(r.card_name));
        m.insert("card_name_folded".into(), Value::String(r.card_name_folded));
        m.insert("card_art_tags".into(), keys_true(art_tags));
        m.insert("card_oracle_tags".into(), keys_true(oracle_tags));
        m.insert("card_rarity_int".into(), opt_i64_val(r.card_rarity_int));
        m.insert("card_set_code".into(), opt_str_val(&r.card_set_code));
        m.insert(
            "card_subtypes".into(),
            Value::Array(r.card_subtypes.into_iter().map(Value::String).collect()),
        );
        m.insert(
            "card_types".into(),
            Value::Array(r.card_types.into_iter().map(Value::String).collect()),
        );
        m.insert("card_watermark".into(), opt_str_val(&r.card_watermark));
        m.insert("cmc".into(), opt_f64_val(r.cmc));
        m.insert("collector_number".into(), opt_str_val(&r.collector_number));
        m.insert("collector_number_int".into(), opt_i64_val(r.collector_number_int));
        m.insert("creature_power".into(), opt_f64_val(r.creature_power));
        m.insert("creature_toughness".into(), opt_f64_val(r.creature_toughness));
        m.insert("edhrec_rank".into(), opt_i64_val(r.edhrec_rank));
        m.insert("flavor_text".into(), Value::String(r.flavor_text));
        // {symbol: [1..n]} — the engine reads the list length as the pip count.
        let mut mana = Map::new();
        for (sym, count) in r.mana_cost_jsonb {
            mana.insert(sym, Value::Array((1..=count).map(|i| json!(i)).collect()));
        }
        m.insert("mana_cost_jsonb".into(), Value::Object(mana));
        m.insert("mana_cost_text".into(), opt_str_val(&r.mana_cost_text));
        m.insert("oracle_text".into(), opt_str_val(&r.oracle_text));
        m.insert("planeswalker_loyalty".into(), opt_i64_val(r.planeswalker_loyalty));
        // NOT in upstream #912's ENGINE_COLUMNS, and that looks like ITS bug: card_from_pydict
        // reads this exact key, and the list's own comment says it "must match". Emitted here
        // because this port's engine is the only path — omitting it nulls every planeswalker's
        // printed loyalty.
        m.insert("planeswalker_loyalty_text".into(), opt_str_val(&r.planeswalker_loyalty_text));
        // The printed-language columns (multilingual store). Null = the key was absent on the
        // card object, which `card_from_json`'s intern_opt keeps distinct from an empty string;
        // the per-face halves ride `card_faces` below. `is_canonical` routes the row into
        // either the canonical printings or the engine's foreign annex.
        m.insert("printed_name".into(), opt_str_val(&r.printed_name));
        m.insert("flavor_name".into(), opt_str_val(&r.flavor_name));
        m.insert("printed_type_line".into(), opt_str_val(&r.printed_type_line));
        m.insert("printed_text".into(), opt_str_val(&r.printed_text));
        m.insert("printed_name_folded".into(), opt_str_val(&r.printed_name_folded));
        m.insert("flavor_name_folded".into(), opt_str_val(&r.flavor_name_folded));
        m.insert("is_canonical".into(), Value::Bool(r.is_canonical));
        m.insert("price_eur".into(), opt_f64_val(r.price_eur));
        m.insert("price_tix".into(), opt_f64_val(r.price_tix));
        m.insert("price_usd".into(), opt_f64_val(r.price_usd));
        m.insert("color_indicator".into(), keys_true(&r.color_indicator));
        m.insert("produced_mana".into(), keys_true(&r.produced_mana));
        m.insert("released_at".into(), Value::String(r.released_at));
        m.insert("creature_power_text".into(), opt_str_val(&r.creature_power_text));
        m.insert("creature_toughness_text".into(), opt_str_val(&r.creature_toughness_text));
        m.insert("set_name".into(), opt_str_val(&r.set_name));
        m.insert("type_line".into(), opt_str_val(&r.type_line));
        m.insert("prefer_score".into(), real_val(prefer));
        m.insert(
            "cubecobra_score".into(),
            cubecobra_score.map_or(Value::Null, real_val),
        );
        // Read back by `jv_faces` in card_engine's core_api.rs, which expects
        // Scryfall's own key names and relies on an absent key staying absent.
        m.insert(
            "card_faces".into(),
            Value::Array(r.card_faces.into_iter().map(Value::Object).collect()),
        );
        // Read back by `jv_compat` and `jv_all_parts` in card_engine's core_api.rs. Verbatim
        // Scryfall keys, and absent stays absent for the same reason `card_faces` above does.
        m.insert("card_compat_blob".into(), Value::Object(r.compat_blob));
        Value::Object(m)
    }
}

// ─── the id→partition routing filter's key set (LOCAL PATCH, Cloudflare port) ───
//
// Every id a `/cards/*` route can be entered by that is NOT an oracle_id. The store is cut by
// `hash(oracle_id) % N`, so an oracle-keyed route asks one partition and every other id-keyed
// route had to ask all N and take the first non-null. `src/engine/routing-filter.ts` turns those
// into one RPC by mapping id → partition; THIS is where the (id, partition) pairs come from, and
// both publishers call it so the two can never disagree about what the filter contains.
//
// The namespace prefixes are WIRE FORMAT — `ROUTING_NAMESPACES` in routing-filter.ts holds the
// same strings, and the isolate hashes `<namespace>:<id>` on the other side of a KV value.
// Renaming one here silently turns that whole route class back into a fan-out.

/// External-id namespaces: the Scryfall compat-blob key, and the route namespace it answers
/// (`/cards/<namespace>/<id>`, `EXTERNAL_ID_NAMESPACES` in routes.ts).
const ROUTING_EXTERNAL_IDS: [(&str, &str); 4] =
    [("mtgo_id", "mtgo"), ("arena_id", "arena"), ("tcgplayer_id", "tcgplayer"), ("cardmarket_id", "cardmarket")];

/// Append one printing's routing keys.
///
/// `compat` is the printing's compat residue — `RowDraft::compat_blob` on the draft side,
/// `card_compat_blob` on the finalized-row side; the two publishers reach it under different
/// names, which is why this takes the map rather than the row.
///
/// A missing or oddly-typed id is SKIPPED rather than an error: a key the filter does not carry
/// costs one fan-out, and refusing to build a store over it would be wildly out of proportion.
pub fn routing_keys_of(
    scryfall_id: &str,
    illustration_id: Option<&str>,
    compat: &Map<String, Value>,
    out: &mut Vec<String>,
) {
    if !scryfall_id.is_empty() {
        out.push(format!("i:{}", scryfall_id.to_ascii_lowercase()));
    }
    if let Some(ill) = illustration_id.filter(|s| !s.is_empty()) {
        out.push(format!("l:{}", ill.to_ascii_lowercase()));
    }
    if let Some(Value::Array(ids)) = compat.get("multiverse_ids") {
        for id in ids {
            if let Some(n) = id.as_i64() {
                out.push(format!("multiverse:{n}"));
            }
        }
    }
    for (blob_key, namespace) in ROUTING_EXTERNAL_IDS {
        if let Some(n) = compat.get(blob_key).and_then(Value::as_i64) {
            out.push(format!("{namespace}:{n}"));
        }
    }
}

/// [`routing_keys_of`] against a finalized row (`card_compat_blob`) — the native builder's shape.
pub fn routing_keys_of_row(row: &Value, out: &mut Vec<String>) {
    let empty = Map::new();
    routing_keys_of(
        row.get("scryfall_id").and_then(Value::as_str).unwrap_or(""),
        row.get("illustration_id").and_then(Value::as_str),
        row.get("card_compat_blob").and_then(Value::as_object).unwrap_or(&empty),
        out,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tags::TagData;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn py_title_matches_python_semantics() {
        assert_eq!(py_title("legendary creature"), "Legendary Creature");
        // Python: "urza's".title() == "Urza'S" — apostrophe resets casing.
        assert_eq!(py_title("urza's"), "Urza'S");
        assert_eq!(py_title("urza\u{2019}s"), "Urza\u{2019}S");
        // Digits are not cased: the char after one is title-cased.
        assert_eq!(py_title("a1b"), "A1B");
        assert_eq!(py_title("2015"), "2015");
        assert_eq!(py_title("extendedart"), "Extendedart");
    }

    #[test]
    fn parse_type_line_splits_on_em_dash() {
        let (types, subs) = parse_type_line("Legendary Creature \u{2014} Human Wizard");
        assert_eq!(types, vec!["Legendary", "Creature"]);
        assert_eq!(subs, vec!["Human", "Wizard"]);
        let (types, subs) = parse_type_line("Instant");
        assert_eq!(types, vec!["Instant"]);
        assert!(subs.is_empty());
    }

    #[test]
    fn maybe_int_mirrors_python() {
        assert_eq!(maybe_int(Some(&json!("2"))), Some(2));
        assert_eq!(maybe_int(Some(&json!("1.5"))), Some(1)); // int(float()) truncates
        assert_eq!(maybe_int(Some(&json!("-1"))), Some(-1));
        assert_eq!(maybe_int(Some(&json!("*"))), None);
        assert_eq!(maybe_int(Some(&json!(3.0))), Some(3));
        assert_eq!(maybe_int(Some(&Value::Null)), None);
        assert_eq!(maybe_int(None), None);
    }

    /// `*` is 0 in a power/toughness comparison on api.scryfall.com — `tou<1` is 434 there and was
    /// 273 here, `tou=0` 432 against 272, 160 cards — and the arithmetic printed around the star
    /// still runs. The three arithmetic rows are one card each, measured 2026-08-17:
    /// Allosaurus Rider (`1+*`) answers `pow=1`, Souls of the Lost (`*+1`) answers `tou=1`, and
    /// Aysen Crusader (`2+*`) answers `pow=2` and NOT `pow=0`.
    #[test]
    fn a_starred_stat_is_zero_and_keeps_its_arithmetic() {
        // Everything `maybe_int` already read, unchanged.
        assert_eq!(maybe_stat_num(Some(&json!("2"))), Some(2.0));
        assert_eq!(maybe_stat_num(Some(&json!("-1"))), Some(-1.0));
        assert_eq!(maybe_stat_num(Some(&json!(3.0))), Some(3.0));
        // A PRINTED HALF IS KEPT, not truncated — the twin of `a_fractional_mana_value_is_not_
        // rounded`. Eleven Unhinged cards print one, and rounding each to its floor made it
        // wrongly ANSWER that floor: measured on api.scryfall.com 2026-08-17, `tou=0` is 432
        // there and was 433 here (Little Girl `.5`), and `pow=2` 5730 against 5733 (Smart Ass,
        // Stone-Cold Basilisk, Vile Bile, all `2.5`).
        assert_eq!(maybe_stat_num(Some(&json!("1.5"))), Some(1.5));
        assert_eq!(maybe_stat_num(Some(&json!(".5"))), Some(0.5));
        assert_eq!(maybe_stat_num(Some(&json!("3.5"))), Some(3.5));
        assert_eq!(maybe_stat_num(Some(&Value::Null)), None);
        assert_eq!(maybe_stat_num(None), None);
        // Every starred form the corpus prints.
        assert_eq!(maybe_stat_num(Some(&json!("*"))), Some(0.0));
        assert_eq!(maybe_stat_num(Some(&json!("1+*"))), Some(1.0));
        assert_eq!(maybe_stat_num(Some(&json!("*+1"))), Some(1.0));
        assert_eq!(maybe_stat_num(Some(&json!("2+*"))), Some(2.0));
        assert_eq!(maybe_stat_num(Some(&json!("7-*"))), Some(7.0));
        assert_eq!(maybe_stat_num(Some(&json!("*²"))), Some(0.0));
        // The two rules compose: a star is 0 and the printed half beside it survives.
        assert_eq!(maybe_stat_num(Some(&json!("1.5+*"))), Some(1.5));
        // `?` IS ZERO TOO, and that is measured rather than reasoned from the star: `Shellephant`
        // (ust/121) prints `?` on both sides, and on api.scryfall.com 2026-08-17
        // `!"Shellephant" tou=0` is 1, `tou>=0` is 1 and `tou>0` is 0. It is the whole of
        // `toughness<1` answering 433 against 434 — read as ABSENT, it satisfied no comparison at
        // all.
        assert_eq!(maybe_stat_num(Some(&json!("?"))), Some(0.0));
        // Everything else that is not a number stays absent. `∞` is deliberately among them:
        // `Infinity Elemental` is `ulst`, which api.scryfall.com does not answer for, so there is
        // no measurement to follow and an unmeasured value is not extended.
        assert_eq!(maybe_stat_num(Some(&json!("X"))), None);
        assert_eq!(maybe_stat_num(Some(&json!("\u{221e}"))), None);
        assert_eq!(maybe_stat_num(Some(&json!("*?"))), None);
        // And it reaches the row: the column is what `pow=`/`tou=` compares, the text beside it is
        // what the card object serves.
        let mut card = minimal_card("Starry");
        card["type_line"] = json!("Creature \u{2014} Elemental");
        card["power"] = json!("*");
        card["toughness"] = json!("1+*");
        let draft = transform(&card).unwrap().unwrap();
        assert_eq!(draft.creature_power, Some(0.0));
        assert_eq!(draft.creature_toughness, Some(1.0));
        assert_eq!(draft.creature_power_text.as_deref(), Some("*"));
        assert_eq!(draft.creature_toughness_text.as_deref(), Some("1+*"));
    }

    /// An explicitly printed stat is searchable even when the historical/joke type line does not
    /// spell `Creature`. These are the complete residuals from enumerating all three live result
    /// sets on 2026-08-17: Atinlay alone for `pow=3` and `tou=3`, Old Fogey alone for
    /// `tou>=3.5`. Type parsing stays literal; preserving stats must not make either card answer
    /// `t:creature` by inventing a modern type.
    #[test]
    fn printed_stats_survive_a_noncanonical_creature_type_line() {
        for (name, type_line, power, toughness) in [
            ("Atinlay Igpay", "Eaturecray \u{2014} Igpay", "3", "3"),
            ("Old Fogey", "Summon \u{2014} Dinosaur", "7", "7"),
        ] {
            let mut card = minimal_card(name);
            card["type_line"] = json!(type_line);
            card["power"] = json!(power);
            card["toughness"] = json!(toughness);

            let draft = transform(&card).unwrap().unwrap();
            assert_eq!(draft.creature_power, Some(power.parse().unwrap()));
            assert_eq!(draft.creature_toughness, Some(toughness.parse().unwrap()));
            assert_eq!(draft.creature_power_text.as_deref(), Some(power));
            assert_eq!(draft.creature_toughness_text.as_deref(), Some(toughness));
            assert!(!draft.card_types.iter().any(|value| value == "Creature"));
        }
    }

    #[test]
    fn collector_number_extraction() {
        assert_eq!(extract_collector_number_int("123a"), Some(123));
        assert_eq!(extract_collector_number_int("123a45"), Some(12345)); // digits concatenated
        assert_eq!(extract_collector_number_int("\u{2605}"), None);
        assert_eq!(extract_collector_number_int("007"), Some(7));
        assert_eq!(extract_collector_number_int("99999999999"), None); // > i32 range
    }

    #[test]
    fn fold_accents_strips_diacritics() {
        assert_eq!(fold_accents("\u{c9}owyn"), "Eowyn"); // Éowyn
        assert_eq!(fold_accents("Lim-D\u{fb}l"), "Lim-Dul");
        assert_eq!(fold_accents("plain"), "plain");
    }

    #[test]
    fn mana_cost_counts() {
        assert_eq!(
            mana_cost_str_to_counts("{2}{W}{W}"),
            vec![("W".to_string(), 2)]
        );
        assert_eq!(
            mana_cost_str_to_counts("{X}{R/G}{R/G}"),
            vec![("X".to_string(), 1), ("R/G".to_string(), 2)]
        );
        // Unbraced + mixed formats are accepted (upstream supports "R{G}").
        // Python processes all braced symbols before the unbraced pass, so the
        // insertion order is G then R.
        assert_eq!(
            mana_cost_str_to_counts("R{G}"),
            vec![("G".to_string(), 1), ("R".to_string(), 1)]
        );
        assert!(mana_cost_str_to_counts("").is_empty());
        assert!(mana_cost_str_to_counts("{3}").is_empty());
    }

    /// Scryfall types cmc Decimal: /cards/named?exact=Little+Girl answers "mana_cost":"{HW}",
    /// "cmc":0.5, the only fractional mana value in the whole corpus. The cast here used to be
    /// `maybe_int`, which is `int(float(v))` in upstream's shape and turned that into 0 -- the
    /// same value a zero-cost card has.
    ///
    /// Little Girl itself is still filtered out by the funny-set rule above; this builds a card
    /// that reaches the transform so the CAST is what is under test, not the corpus.
    #[test]
    fn a_fractional_mana_value_is_not_rounded() {
        let mut card = minimal_card("Little Girl");
        card["cmc"] = json!(0.5);
        card["mana_cost"] = json!("{HW}");
        let draft = transform(&card).unwrap().unwrap();
        assert_eq!(draft.cmc, Some(0.5));
    }

    /// A RETAIL funny set is IMPORTED and ORDINARY — not dropped, and not an extra either.
    ///
    /// Dropping it was simply wrong: `q=e:ust` answers 249 on api.scryfall.com with and without
    /// `include_extras`, `q=border:silver t:goblin` answers 19, and `q=!"Earl of Squirrel"`
    /// answers 200 from a bare search (measured 2026-08-16). The un-sets are search results like
    /// any other set's — the joke ODDITIES are not, which is `FUNNY_EXTRA_SETS`.
    #[test]
    fn a_funny_set_is_imported_as_an_ordinary_card() {
        let mut card = minimal_card("Unfunny");
        card["set_type"] = json!("funny");
        card["set"] = json!("ust");
        card["cmc"] = json!(0.5);
        let draft = transform(&card).unwrap().expect("imported");
        assert!(!draft.card_is_tags.iter().any(|t| t == EXTRA_IS_TAG), "a retail un-set is not an extras class");
        assert_eq!(draft.cmc, Some(0.5), "the fractional mana value rides along");
    }

    #[test]
    fn lightning_bolt_transforms() {
        let draft = transform(&fixture("lightning_bolt")).unwrap().unwrap();
        assert_eq!(draft.card_name, "Lightning Bolt");
        assert_eq!(draft.card_types, vec!["Instant"]);
        assert_eq!(draft.card_colors, vec!["R"]);
        assert_eq!(draft.cmc, Some(1.0));
        assert_eq!(draft.creature_power, None);
        assert_eq!(draft.creature_power_text, None);
        assert_eq!(draft.mana_cost_jsonb, vec![("R".to_string(), 1)]);
        assert_eq!(draft.card_rarity_int, Some(1)); // uncommon in msc
        assert!(draft.raw_has_paper);
    }

    #[test]
    fn llanowar_elves_creature_fields() {
        let draft = transform(&fixture("llanowar_elves")).unwrap().unwrap();
        assert_eq!(draft.creature_power, Some(1.0));
        assert_eq!(draft.creature_toughness, Some(1.0));
        assert_eq!(draft.creature_power_text.as_deref(), Some("1"));
        assert_eq!(draft.produced_mana, vec!["G"]);
        assert_eq!(draft.card_subtypes, vec!["Elf", "Druid"]);
    }

    #[test]
    fn jace_planeswalker_loyalty() {
        let draft = transform(&fixture("jace_the_mind_sculptor")).unwrap().unwrap();
        assert_eq!(draft.planeswalker_loyalty, Some(3));
        assert_eq!(draft.creature_power, None);
        assert!(draft.card_types.contains(&"Planeswalker".to_string()));
    }

    #[test]
    fn dfc_faces_merge_into_one_row() {
        // REPLACES `dfc_last_face_wins`. Both faces now fold into one row: the
        // front supplies identity and display scalars, later faces contribute
        // unions and joined texts. The old behaviour — the stored row IS the
        // back face — is exactly what upstream's face merge (#400/#873) fixes.
        let card = fixture("delver_of_secrets");
        let draft = transform(&card).unwrap().unwrap();
        assert_eq!(draft.card_name, "Delver of Secrets // Insectile Aberration");
        assert_eq!(draft.card_name_folded, "delver of secrets // insectile aberration");

        // Joined texts, front first.
        assert_eq!(
            draft.type_line.as_deref(),
            Some("Creature \u{2014} Human Wizard // Creature \u{2014} Human Insect")
        );
        let oracle = draft.oracle_text.as_deref().unwrap();
        assert!(oracle.starts_with("At the beginning of your upkeep"));
        assert!(oracle.ends_with("\n//\nFlying"), "faces join with the newline separator: {oracle:?}");

        // Unions: one Creature entry, every face's subtypes in front-first order.
        assert_eq!(draft.card_types, vec!["Creature"]);
        assert_eq!(draft.card_subtypes, vec!["Human", "Wizard", "Insect"]);

        // Stat group comes from the FRONT face, whole — 1/1, not the back's 3/2,
        // and never a mix of the two.
        assert_eq!(draft.creature_power, Some(1.0));
        assert_eq!(draft.creature_toughness, Some(1.0));
        assert_eq!(draft.creature_power_text.as_deref(), Some("1"));
        assert_eq!(draft.creature_toughness_text.as_deref(), Some("1"));

        // Front-face display scalars. The illustration id moving from the back
        // to the front is what shifts prefer_score's artwork-set component for
        // multi-faced cards.
        assert_eq!(draft.mana_cost_jsonb, vec![("U".to_string(), 1)]);
        let front_ill = card["card_faces"][0]["illustration_id"].as_str().unwrap();
        assert_eq!(draft.illustration_id.as_deref(), Some(front_ill));

        // Card-level fields are untouched by the merge.
        assert_eq!(draft.scryfall_id, card["id"].as_str().unwrap());
        assert_eq!(draft.oracle_id, card["oracle_id"].as_str().unwrap());
        assert_eq!(draft.card_color_identity, vec!["U"]);
        assert_eq!(draft.card_keywords, vec!["flying", "transform"]);

        // And the per-face snapshots ride along, front first, carrying only the
        // keys each face actually has.
        assert_eq!(draft.card_faces.len(), 2);
        assert_eq!(draft.card_faces[0]["name"], "Delver of Secrets");
        assert_eq!(draft.card_faces[1]["name"], "Insectile Aberration");
        assert_eq!(draft.card_faces[1]["type_line"], "Creature \u{2014} Human Insect");
        // Scryfall omits `loyalty` on a creature face; it must stay omitted, because
        // core_api's jv_faces maps absent to NONE_STR and present-but-empty to "".
        assert!(!draft.card_faces[0].contains_key("loyalty"));
    }

    #[test]
    fn single_faced_cards_carry_no_faces() {
        let draft = transform(&minimal_card("Shock")).unwrap().unwrap();
        assert!(draft.card_faces.is_empty());
    }

    /// The card's OWN artist survives the face overlay — the three shapes, one rule.
    ///
    /// The face merge puts face 0's keys on the merged dict, so `card_artist` used to be read
    /// off the FRONT FACE and Scryfall's joined credit never reached the column. It is a stored
    /// The corpus-wide artist-entity relation `a:` needs, and the two credit shapes that decide it.
    ///
    /// `a:` is an artist-ENTITY match, so a needle matching any one of an artist's spellings must
    /// answer for all of that artist's printings. The relation is resolved HERE because the store
    /// is partitioned and no partition sees the whole corpus — see `ArtistSpellings`.
    #[test]
    fn artist_spellings_are_split_by_scryfalls_own_alignment() {
        let kev = "f366a0ee-a0cd-466d-ba6a-90058c7a31a6";
        let franz = "11111111-2222-3333-4444-555555555555";
        let pair = "7b22f886-5d28-4add-9515-4364a078fc86";
        // Through `transform_row`, so the credit and `artist_ids` arrive on the draft exactly as
        // the importer puts them there — the column and the residue, not a hand-set pair.
        let draft = |artist: &str, ids: &[&str]| {
            let mut card = minimal_card(artist);
            card["artist"] = json!(artist);
            card["artist_ids"] = Value::Array(ids.iter().map(|i| Value::String((*i).to_owned())).collect());
            transform_row(&card, true).expect("transform").expect("a row")
        };

        let drafts = vec![
            draft("Kev Walker", &[kev]),
            // ONE ARTIST, TWO NAMES, no shared substring — the pair no string work can relate.
            draft("Evkay Alkerway", &[kev]),
            // A joined credit: positional against `artist_ids`, so each half lands on its own id.
            draft("Kev Walker & Franz Vohwinkel", &[kev, franz]),
            // ONE id and a separator inside the NAME. `Hari & Deepti` credits ten printings in the
            // 2026-08-16 default_cards bulk and is a single artist; splitting it would invent two
            // and give each the other's cards.
            draft("Hari & Deepti", &[pair]),
        ];
        let mut table = ArtistSpellings::new();
        for d in &drafts {
            observe_artist_spellings(&mut table, d.card_artist.as_deref(), &d.compat_blob);
        }
        assert_eq!(
            table[kev].iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["Evkay Alkerway", "Kev Walker"],
            "the joined credit's first half is Kev's, and both spellings reach one id"
        );
        assert_eq!(table[franz].iter().map(String::as_str).collect::<Vec<_>>(), vec!["Franz Vohwinkel"]);
        assert_eq!(
            table[pair].iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["Hari & Deepti"],
            "a single id keeps the whole credit — never \"Hari\" and \"Deepti\""
        );

        // THE TABLE IS ONE OBJECT FOR THE WHOLE CORPUS, and it names only the artists with more
        // than one spelling: the rest are already reachable by the engine's plain vocab scan.
        // Written per row instead, this is O(that artist's spellings) on every row crediting them,
        // which has no bound — see `artist_entity_table`.
        assert_eq!(
            artist_entity_table(&table),
            json!([[["evkay alkerway", "evkay alkerway"], ["kev walker", "kev walker"]]]),
            "one entity, lowercased AND accent-folded because the engine has no NFKD — and Franz \
             and `Hari & Deepti`, with one spelling each, say nothing"
        );

        // A credit whose component count does not line up with `artist_ids` DECLINES rather than
        // guessing an alignment that slips by one. 0 rows of the live corpus take this branch.
        let mismatched = draft("A & B & C", &[kev, franz]);
        let mut solo = ArtistSpellings::new();
        observe_artist_spellings(&mut solo, mismatched.card_artist.as_deref(), &mismatched.compat_blob);
        assert!(solo.is_empty(), "a misaligned credit must contribute nothing, not a shifted guess");
    }

    /// value read by three surfaces at once (the card object's `artist`, `order=artist`, and
    /// `a:`), which is why the assertion lives here rather than in a card-object test.
    #[test]
    fn a_cards_artist_is_scryfalls_and_never_a_faces() {
        // TWO artists: the joined credit, verbatim — not "David Martin".
        let two = transform(&fixture("fire_ice")).unwrap().unwrap();
        assert_eq!(two.card_artist.as_deref(), Some("David Martin & Franz Vohwinkel"));
        assert_eq!(two.card_artist_folded.as_deref(), Some("david martin & franz vohwinkel"));
        // Both faces keep their own credit; the joined string is the CARD's, not any face's.
        assert_eq!(two.card_faces[0]["artist"], "David Martin");
        assert_eq!(two.card_faces[1]["artist"], "Franz Vohwinkel");

        // ONE artist across two faces: the single name, never "Nils Hamm & Nils Hamm". Free,
        // because the value is Scryfall's own rather than a join computed over the faces.
        let one = transform(&fixture("delver_of_secrets")).unwrap().unwrap();
        assert_eq!(one.card_artist.as_deref(), Some("Nils Hamm"));
        assert_eq!(one.card_faces.len(), 2);

        // SINGLE-FACED: the branch that was always right, pinned so it stays that way. Scryfall
        // credits two people on 1,158 faceless printings, and that string arrives pre-joined.
        let mut solo = minimal_card("Tormented Angel");
        solo["artist"] = json!("Greg Hildebrandt & Tim Hildebrandt");
        let solo = transform(&solo).unwrap().unwrap();
        assert!(solo.card_faces.is_empty());
        assert_eq!(solo.card_artist.as_deref(), Some("Greg Hildebrandt & Tim Hildebrandt"));
    }

    /// The card's OWN layout survives the face overlay — the same rule as the artist above, on the
    /// one other key a FACE can genuinely carry.
    ///
    /// Scryfall puts `layout` on the faces of `reversible_card` printings and on nothing else:
    /// over the whole 2026-08-15 all_cards bulk exactly 81 cards have a face-level `layout`, and
    /// all 81 are reversible. The overlay wrote the face's value onto the merged dict and
    /// `merge_face_drafts` kept the front's, so every one of the 81 was stored as some OTHER
    /// layout (77 `normal`, 3 `adventure`, 1 `token`) and the corpus reported zero reversible
    /// cards — which is why `is:dfc` was still missing all ten `sld` printings the sweep flagged
    /// after `reversible_card` was added to it.
    #[test]
    fn a_cards_layout_is_the_printings_and_never_a_faces() {
        let mut reversible = fixture("delver_of_secrets");
        reversible["layout"] = json!("reversible_card");
        for face in reversible["card_faces"].as_array_mut().unwrap() {
            face["layout"] = json!("normal");
        }
        let draft = transform(&reversible).unwrap().unwrap();
        assert_eq!(draft.card_layout.as_deref(), Some("reversible_card"), "the face's layout is not the card's");

        // The ordinary multi-face case, where no face carries the key at all, is unchanged.
        let plain = transform(&fixture("delver_of_secrets")).unwrap().unwrap();
        assert_eq!(plain.card_layout.as_deref(), Some("transform"));
        // ...and so is the single-face branch, which never had an overlay to survive.
        let solo = transform(&minimal_card("Shock")).unwrap().unwrap();
        assert_eq!(solo.card_layout.as_deref(), Some("normal"));
    }

    /// `flavor_name` is ingested on BOTH branches of `transform_row` — the multi-face merge and
    /// the single-face one — and folded for the engine's flavor-name index.
    ///
    /// Pinned on the single-face branch specifically because it is the branch that was missed:
    /// every flavor-name card that matters is single-faced (prm/80925 Titanoth Rex ->
    /// "Godzilla, Primeval Champion"), so a fix applied only to the merge branch reads as
    /// working code and ships an empty column.
    #[test]
    fn a_flavor_name_is_ingested_and_folded_on_both_branches() {
        let mut single = minimal_card("Titanoth Rex");
        single["flavor_name"] = json!("Godzilla, Primeval Champion");
        let draft = transform(&single).unwrap().unwrap();
        assert_eq!(draft.flavor_name.as_deref(), Some("Godzilla, Primeval Champion"));
        assert_eq!(draft.flavor_name_folded.as_deref(), Some("godzilla, primeval champion"));

        let mut multi = fixture("prepare_es");
        multi["flavor_name"] = json!("Amaterasu");
        let draft = transform_row(&multi, true).unwrap().unwrap();
        assert!(!draft.card_faces.is_empty(), "the merge branch");
        assert_eq!(draft.flavor_name.as_deref(), Some("Amaterasu"));
        assert_eq!(draft.flavor_name_folded.as_deref(), Some("amaterasu"));

        // Absent stays absent — the column must not fabricate an empty string.
        let plain = transform(&minimal_card("Shock")).unwrap().unwrap();
        assert_eq!(plain.flavor_name, None);
        assert_eq!(plain.flavor_name_folded, None);
    }

    /// A Japanese printing carries its whole printed triple, non-ASCII intact, and none of it
    /// leaks into the compat residue now that columns hold it.
    #[test]
    fn a_japanese_printing_carries_its_printed_triple() {
        let card = fixture("shock_ja");
        let draft = transform_row(&card, false).unwrap().unwrap();
        assert_eq!(draft.printed_name.as_deref(), Some("ショック"));
        assert_eq!(draft.printed_type_line.as_deref(), Some("インスタント"));
        assert_eq!(
            draft.printed_text.as_deref(),
            card["printed_text"].as_str(),
            "printed_text must pass through verbatim"
        );
        // Single-faced: the folded name is the folded top-level printed_name.
        assert_eq!(draft.printed_name_folded.as_deref(), Some("ショック"));
        assert!(!draft.is_canonical);

        let rows: Vec<Value> = finalize(vec![draft], &TagData::default()).collect();
        assert_eq!(rows[0]["printed_name"], json!("ショック"));
        assert_eq!(rows[0]["is_canonical"], json!(false));
        let blob = rows[0]["card_compat_blob"].as_object().unwrap();
        for key in ["printed_name", "printed_type_line", "printed_text"] {
            assert!(!blob.contains_key(key), "{key} has a column; the residue must not duplicate it");
        }
        // lang still rides the residue — the engine reads it from there.
        assert_eq!(blob["lang"], json!("ja"));
    }

    /// A prepare-layout Spanish printing localizes ONLY the front face's name and type line —
    /// the front has no printed_text and the back has no printed key at all, and both absences
    /// must survive into the per-face snapshots exactly.
    #[test]
    fn a_prepare_layout_localizes_only_the_front_face() {
        let draft = transform_row(&fixture("prepare_es"), false).unwrap().unwrap();
        // Multi-faced: no top-level printed keys on the card object, so the columns stay None.
        assert_eq!(draft.printed_name, None);
        assert_eq!(draft.printed_type_line, None);
        assert_eq!(draft.printed_text, None);

        assert_eq!(draft.card_faces.len(), 2);
        assert_eq!(draft.card_faces[0]["printed_name"], json!("Rescate repentino"));
        assert_eq!(draft.card_faces[0]["printed_type_line"], json!("Instantáneo"));
        assert!(!draft.card_faces[0].contains_key("printed_text"), "the front face has no printed_text");
        for key in ["printed_name", "printed_type_line", "printed_text"] {
            assert!(!draft.card_faces[1].contains_key(key), "the back face carries no {key}");
        }
        // The folded full name joins the localized front with the back's ENGLISH name — the
        // back was never localized, and a one-sided name would miss every full-name lookup.
        assert_eq!(draft.printed_name_folded.as_deref(), Some("rescate repentino // steady return"));
    }

    /// A Spanish transform card carries the full triplet on both faces, and the folded full name
    /// joins the two printed names accent-folded.
    #[test]
    fn an_es_transform_carries_both_faces_triplets() {
        let draft = transform_row(&fixture("delver_es"), false).unwrap().unwrap();
        assert_eq!(draft.card_faces.len(), 2);
        for (i, (name, type_line)) in [
            ("Ahondador de secretos", "Criatura — Hechicero humano"),
            ("Aberración insectil", "Criatura — Aberración humana"),
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(draft.card_faces[i]["printed_name"], json!(name));
            assert_eq!(draft.card_faces[i]["printed_type_line"], json!(type_line));
            assert!(draft.card_faces[i].contains_key("printed_text"), "face {i} carries printed_text");
        }
        // fold_accents drops the diacritic: "Aberración" -> "aberracion".
        assert_eq!(
            draft.printed_name_folded.as_deref(),
            Some("ahondador de secretos // aberracion insectil")
        );
    }

    /// An English printing carries no printed keys anywhere: no columns, no per-face keys, no
    /// folded name — and the plain [`transform`] entry point marks it canonical.
    #[test]
    fn an_english_printing_carries_no_printed_keys() {
        let draft = transform(&fixture("lightning_bolt")).unwrap().unwrap();
        assert_eq!(draft.printed_name, None);
        assert_eq!(draft.printed_type_line, None);
        assert_eq!(draft.printed_text, None);
        assert_eq!(draft.printed_name_folded, None);
        assert!(draft.is_canonical, "the one-argument transform stays canonical");

        let rows: Vec<Value> = finalize(vec![draft], &TagData::default()).collect();
        assert_eq!(rows[0]["printed_name"], json!(null));
        assert_eq!(rows[0]["printed_name_folded"], json!(null));
        assert_eq!(rows[0]["is_canonical"], json!(true));

        // The same card through transform_row with the flag off is the ONLY difference.
        let foreign = transform_row(&fixture("lightning_bolt"), false).unwrap().unwrap();
        assert!(!foreign.is_canonical);
    }

    fn minimal_card(name: &str) -> Value {
        json!({
            "id": format!("00000000-0000-4000-8000-{:012x}", name.len()),
            "oracle_id": "11111111-1111-4111-8111-111111111111",
            "name": name,
            "released_at": "2020-01-01",
            "type_line": "Instant",
            "legalities": {"vintage": "legal"},
            "games": ["paper"],
            "colors": ["R"],
            "color_identity": ["R"],
            "set": "tst",
            "set_name": "Test Set",
            "collector_number": "1",
            "rarity": "common",
            "layout": "normal",
            "border_color": "black",
            "frame": "2015",
            "lang": "en",
            "cmc": 1.0,
            "mana_cost": "{R}",
            "oracle_text": "Do a thing.",
            "finishes": ["nonfoil"],
            "image_status": "highres_scan",
        })
    }

    /// The classes, one probe each, as `is:extra` rather than as a drop.
    ///
    /// Upstream refuses seven classes of printing at import. api.scryfall.com serves all seven
    /// (2026-08-16), and hides four of them from a default `/cards/search` behind
    /// `include_extras=false` — a QUERY-TIME gate, which an absent row cannot reproduce in either
    /// direction: `/cards/named?exact=` answers every one of them, and `include_extras=true` has
    /// nothing to include when the row was never stored. So nothing here drops, and the
    /// assertions are about the TAG.
    #[test]
    fn extras_class_matches_what_scryfall_hides() {
        let tag = |c: &Value| {
            transform(c).unwrap().expect("every row is imported now").card_is_tags.iter().any(|t| t == EXTRA_IS_TAG)
        };

        // ─── ordinary: served by a bare `/cards/search` ───────────────────────────────────────
        // Never legal in any format. `!"Hold the Perimeter"` (cn2/6, a never-legal Conspiracy)
        // answers 200 bare, as does the never-legal silver-border `!"Goblin Bowling Team"`.
        // Relaxing this is also what empties card_engine's `drop_group_if_annex_only`.
        let mut c = minimal_card("Never Legal");
        c["legalities"] = json!({"vintage": "not_legal"});
        assert!(!tag(&c), "never-legal is not an extras class");
        // A RETAIL funny set: `q=e:ust` answers 249 with and without the flag.
        let mut c = minimal_card("Funny");
        c["set_type"] = json!("funny");
        c["set"] = json!("ust");
        assert!(!tag(&c), "a retail un-set is not an extras class");
        // ...and the same card in an un-set the list has never heard of, which is served rather
        // than hidden — the stale-list failure mode this direction was chosen for.
        let mut c = minimal_card("Unreleased");
        c["set_type"] = json!("funny");
        c["set"] = json!("un99");
        assert!(!tag(&c), "an unlisted funny set defaults to ORDINARY, never to hidden");
        // ...but its TOKENS are still extras, because the funny rule adds and never subtracts. An
        // early `false` here would let a future un-set's tokens vanish from search the moment the
        // list went stale, which is the same silent-vanishing failure one level down.
        let mut c = minimal_card("Unreleased Token");
        c["set_type"] = json!("funny");
        c["set"] = json!("un99");
        c["layout"] = json!("token");
        assert!(tag(&c), "a token in an unlisted funny set is still an extra");
        // A sticker sheet in a funny set is NOT: `sunf` ships 48 and Scryfall serves them.
        let mut c = minimal_card("Sticker Sheet");
        c["set_type"] = json!("funny");
        c["set"] = json!("sunf");
        c["type_line"] = json!("Stickers");
        assert!(!tag(&c), "sunf's sticker sheets are served");
        // A digital printing that IS legal somewhere: Alchemy's playable cards are ordinary.
        let mut c = minimal_card("Alchemy Playable");
        c["digital"] = json!(true);
        c["set_type"] = json!("alchemy");
        assert!(!tag(&c), "digital alone is not the class");
        // A silver border outside a promo set: 567 of them are ordinary results.
        let mut c = minimal_card("Silver Expansion");
        c["border_color"] = json!("silver");
        c["set_type"] = json!("expansion");
        assert!(!tag(&c), "silver alone is not the class");
        // A reversible "X // X" printing: `!"Magmatic Hellkite // Magmatic Hellkite"` answers 200
        // bare. (Its art_series cousins ARE extras, by layout, two cases below.)
        let mut c = minimal_card("ignored");
        c["name"] = json!("Echo // Echo");
        c["layout"] = json!("reversible_card");
        assert!(!tag(&c), "a reversible duplicate is an ordinary printing");
        // A playtest promo that is PLAYABLE: sld/SCTLR Counterspell is legal in modern and appears
        // in a bare `!"Counterspell"&unique=prints`, so the flag alone hides nothing.
        let mut c = minimal_card("Playable Playtest");
        c["promo_types"] = json!(["sldbonus", "playtest"]);
        assert!(!tag(&c), "playtest alone does not hide a playable printing");
        // ...and an ordinary expansion card, so a predicate that called everything extra fails
        // here rather than looking like it works.
        let mut c = minimal_card("Ordinary");
        c["set_type"] = json!("expansion");
        assert!(!tag(&c));

        // ─── extras: 404 bare, 200 with include_extras=true ──────────────────────────────────
        // A playtest promo that is unplayable: `!"Subgoyf"` (mb2/536).
        let mut c = minimal_card("Playtest");
        c["promo_types"] = json!(["playtest"]);
        c["legalities"] = json!({"vintage": "not_legal"});
        assert!(tag(&c), "an unplayable playtest promo is an extra");
        // Memorabilia: `!"Siren's Call"&unique=prints` is 8 bare and 12 with extras (ced/78).
        let mut c = minimal_card("WorldChampionship");
        c["set_type"] = json!("memorabilia");
        assert!(tag(&c));
        // A "Card" type line: `!"The Monarch"` (tmkc/31).
        let mut c = minimal_card("ArtSeries");
        c["type_line"] = json!("Card");
        assert!(tag(&c));
        // A "Token" type line: `!"Goblin Army"` (thob/4).
        let mut c = minimal_card("Token");
        c["type_line"] = json!("Token Creature \u{2014} Goblin");
        assert!(tag(&c));
        // ...and the LAYOUT half of the rule, which is what catches the planes, schemes,
        // vanguards, emblems and art series whose type lines say nothing: `!"Truga Jungle"`
        // (opc2/38, layout planar) is 404 bare and 200 with extras.
        let mut c = minimal_card("Plane");
        c["layout"] = json!("planar");
        assert!(tag(&c));
        let mut c = minimal_card("ArtCard");
        c["name"] = json!("Echo // Echo");
        c["layout"] = json!("art_series");
        assert!(tag(&c), "an art-series duplicate IS an extra, unlike its reversible cousin");
        // `content_warning`, the flag with no other signal behind it: layout `normal`, an ordinary
        // type line, legal somewhere. `is:extra e:lea` answers 1 and that one card is Crusade.
        let mut c = minimal_card("Crusade");
        c["content_warning"] = json!(true);
        assert!(tag(&c), "a content_warning printing is an extra");
        // A funny ODDITY set: `is:extra e:ulst` is 62 of 62, and its rows are field-for-field
        // indistinguishable from the ust twins two cases above — the set code is the whole signal.
        let mut c = minimal_card("Earl of Squirrel");
        c["set_type"] = json!("funny");
        c["set"] = json!("ulst");
        c["border_color"] = json!("silver");
        assert!(tag(&c), "The List's Unstable reprints are extras where Unstable's own are not");
        // A digital printing legal in NO format: `is:extra e:hbg` is 122, 104 of them this class.
        let mut c = minimal_card("Alchemy Duplicate");
        c["digital"] = json!(true);
        c["set_type"] = json!("alchemy");
        c["legalities"] = json!({"alchemy": "not_legal", "historic": "not_legal"});
        assert!(tag(&c), "a digital printing no format allows is an extra");
        // A silver-bordered promo: pal04's Arena League un-cards, j17's Rules Lawyer, pust/punh.
        let mut c = minimal_card("Arena League Mise");
        c["border_color"] = json!("silver");
        c["set_type"] = json!("promo");
        assert!(tag(&c), "a silver-bordered promo is an extra");
        // A Secret Lair sticker sheet (sld/335-339), whose only tell is the type line.
        let mut c = minimal_card("Sticker sheet");
        c["type_line"] = json!("Stickers");
        c["set_type"] = json!("box");
        assert!(tag(&c), "a sticker sheet is an extra outside a funny set");

        // ─── the two layouts that are NOT extras, against the list that used to hold them ─────
        // `is:extra e:ust` answers 0 on api.scryfall.com; Unstable's Hosts and Augments are
        // ordinary results. Asserted as a pair so re-adding either to EXTRA_LAYOUTS fails here.
        for layout in ["host", "augment"] {
            let mut c = minimal_card("Unstable");
            c["layout"] = json!(layout);
            c["set_type"] = json!("funny");
            c["set"] = json!("ust");
            assert!(!tag(&c), "{layout} is an ordinary printing, not an extra");
        }
        // ...and the playtest promo that is NOT one: `und`/`unh`'s "Look at Me, I'm R&D" is a real
        // Un-card that merely depicts a playtest card, and `is:extra e:und` answers 0. The funny
        // short-circuit is what makes the difference from mb2/536 Subgoyf, two cases above.
        let mut c = minimal_card("Look at Me, I'm R&D");
        c["set_type"] = json!("funny");
        c["set"] = json!("und");
        c["promo_types"] = json!(["playtest"]);
        c["legalities"] = json!({"vintage": "not_legal"});
        assert!(!tag(&c), "a playtest promo inside a served un-set is not an extra");
    }

    #[test]
    fn missing_required_field_is_an_error() {
        // Upstream KeyError/NOT NULL violations abort the import; mirror that.
        let mut c = minimal_card("No Colors");
        c.as_object_mut().unwrap().remove("colors");
        assert!(matches!(
            transform(&c),
            Err(TransformError::MissingField { field: "colors", .. })
        ));
        let mut c = minimal_card("No Oracle Id");
        c.as_object_mut().unwrap().remove("oracle_id");
        assert!(matches!(
            transform(&c),
            Err(TransformError::MissingField { field: "oracle_id", .. })
        ));
    }

    #[test]
    fn finalize_emits_engine_columns() {
        let drafts = vec![transform(&fixture("llanowar_elves")).unwrap().unwrap()];
        let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
        assert_eq!(rows.len(), 1);
        let row = rows[0].as_object().unwrap();
        // Exactly the ENGINE_COLUMNS key set (card_engine/__init__.py).
        let mut keys: Vec<&str> = row.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = vec![
            "scryfall_id", "oracle_id", "illustration_id", "card_artist", "card_artist_folded",
            "card_border",
            "card_color_identity", "card_colors", "card_frame_data", "card_is_tags",
            "card_keywords", "card_keywords_printed", "card_layout", "card_legalities", "card_name",
            "card_name_folded", "card_art_tags", "card_oracle_tags", "card_rarity_int",
            "card_set_code", "card_subtypes", "card_types", "card_watermark", "cmc",
            "collector_number", "collector_number_int", "color_indicator", "creature_power",
            "creature_toughness", "edhrec_rank", "flavor_name", "flavor_name_folded", "flavor_text", "mana_cost_jsonb",
            "mana_cost_text", "oracle_text", "planeswalker_loyalty", "planeswalker_loyalty_text", "price_eur",
            "price_tix", "price_usd", "produced_mana", "released_at",
            "creature_power_text", "creature_toughness_text", "set_name", "type_line",
            "prefer_score", "cubecobra_score", "card_faces", "card_compat_blob",
            "printed_name", "printed_type_line", "printed_text", "printed_name_folded", "is_canonical",
            "life_modifier", "hand_modifier",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        // Spot-check JSONB shapes.
        assert_eq!(row["card_colors"], json!({"G": true}));
        assert_eq!(row["mana_cost_jsonb"], json!({"G": [1]}));
        // The blob-backed is: tags, derived from the bulk card's own booleans and arrays: this
        // fixture is a boostered, high-res, foil-and-nonfoil reprint, and it is neither reserved
        // nor oversized nor a game changer. Its promo_types (beginnerbox, startercollection) are
        // not in ARRAY_IS_TAGS, so nothing comes back from that half — which is the case worth
        // pinning, since a mapping typo there produces exactly this: silence.
        assert_eq!(
            row["card_is_tags"],
            json!({"booster": true, "foil": true, "hires": true, "nonfoil": true, "reprint": true})
        );
        assert_eq!(row["card_subtypes"], json!(["Elf", "Druid"]));
    }

    #[test]
    fn the_compat_residue_is_whatever_no_column_holds() {
        let row = &finalize(
            vec![transform(&fixture("llanowar_elves")).unwrap().unwrap()],
            &TagData::default(),
        )
        .collect::<Vec<Value>>()[0];
        let blob = row["card_compat_blob"].as_object().unwrap();
        // Present because no column holds them — these are exactly what CompatFields reads.
        for key in ["lang", "set_id", "set_type", "games", "finishes", "prices", "multiverse_ids"] {
            assert!(blob.contains_key(key), "{key} should be in the residue");
        }
        // Absent because a column holds them, or because they are derived on read. A key that
        // slipped through here would be stored twice; one that fell out of the excluded list
        // would be stored ~98,000 times.
        for key in ["id", "name", "oracle_id", "cmc", "legalities", "image_uris", "uri", "card_faces"] {
            assert!(!blob.contains_key(key), "{key} should not be in the residue");
        }
    }

    #[test]
    fn a_planeswalkers_printed_loyalty_reaches_its_column() {
        // Upstream's shape exactly: `loyalty` is EXCLUDED from the residue because the
        // `planeswalker_loyalty_text` column holds the printed STRING — the integer column the
        // query planner filters `loy:` on cannot represent "X" or "1+*".
        let row = &finalize(
            vec![transform(&fixture("jace_the_mind_sculptor")).unwrap().unwrap()],
            &TagData::default(),
        )
        .collect::<Vec<Value>>()[0];
        assert_eq!(row["planeswalker_loyalty_text"], json!("3"));
        // The numeric column still answers `loy:`, and is still a number.
        assert_eq!(row["planeswalker_loyalty"], json!(3));
        // And the blob no longer duplicates what the column holds.
        assert!(!row["card_compat_blob"].as_object().unwrap().contains_key("loyalty"));

        // A card with no loyalty carries null in the column, and the engine's intern_opt turns
        // null into NONE_STR — which the card object writes as an OMITTED key, not a null.
        let bolt = &finalize(vec![transform(&fixture("lightning_bolt")).unwrap().unwrap()], &TagData::default())
            .collect::<Vec<Value>>()[0];
        assert_eq!(bolt["planeswalker_loyalty_text"], json!(null));
        assert!(!bolt["card_compat_blob"].as_object().unwrap().contains_key("loyalty"));
    }

    #[test]
    fn a_battle_face_keeps_its_defense() {
        // Scryfall prints defense on the FACE — every battle so far is a transform card, so a face
        // field list without `defense` loses the number outright.
        let mut card = minimal_card("Invasion of Test");
        card["layout"] = json!("transform");
        card["card_faces"] = json!([
            {"name": "Invasion of Test", "type_line": "Battle \u{2014} Siege", "oracle_text": "x", "defense": "7"},
            {"name": "Test, Reclaimed", "type_line": "Creature \u{2014} Elf", "oracle_text": "y", "power": "3", "toughness": "3"},
        ]);
        let draft = transform(&card).unwrap().unwrap();
        assert_eq!(draft.card_faces[0]["defense"], json!("7"));
        // Absent on the face that has none, for the same reason as loyalty above.
        assert!(!draft.card_faces[1].contains_key("defense"));
    }

    #[test]
    fn boolean_is_tags_come_from_the_bulk_card_booleans() {
        // _sync_boolean_is_tags parity: only the managed keys, only when the
        // blob boolean is exactly true. A missing key and a false key are the
        // same absence, and a non-boolean never counts.
        let tags_of = |card: &Value| {
            let draft = transform(card).unwrap().unwrap();
            let rows: Vec<Value> = finalize(vec![draft], &TagData::default()).collect();
            rows[0]["card_is_tags"].clone()
        };

        let mut card = minimal_card("Both");
        card["reserved"] = json!(true);
        card["game_changer"] = json!(true);
        assert_eq!(tags_of(&card), json!({"reserved": true, "gamechanger": true}));

        let mut only_reserved = minimal_card("OnlyReserved");
        only_reserved["reserved"] = json!(true);
        only_reserved["game_changer"] = json!(false);
        assert_eq!(tags_of(&only_reserved), json!({"reserved": true}));

        // Truthy-but-not-true must not leak in: upstream's SQL compares the blob
        // value to 'true'::jsonb, not for presence.
        let mut stringly = minimal_card("Stringly");
        stringly["reserved"] = json!("true");
        assert_eq!(tags_of(&stringly), json!({}));
    }

    #[test]
    fn finalize_prefer_score_matches_hand_computation() {
        // Llanowar Elves (fdn): common(16) + black border(14) + 2015 frame(42)
        // + highres(16) + paper(6) + en(40) + non-showcase(10) + nonfoil(10)
        // + non-dbl set(20) + on-style art(14) + illustration_count(1 match →
        // round4(23*ln(2)/ln(40))) + cubecobra n/a. Fixture has no extendedart
        // or legendary frame effects.
        let draft = transform(&fixture("llanowar_elves")).unwrap().unwrap();
        let rows: Vec<Value> = finalize(vec![draft], &TagData::default()).collect();
        // Plus the rank term: the card's only printing represents it, so rank 0 (see `ranks`).
        let expected_illus = ((23.0 * 2.0f64.ln() / 40.0f64.ln()) * 10_000.0).round() / 10_000.0;
        let expected = (crate::ranks::rank_term(0) + 188.0 + expected_illus) as f32 as f64;
        assert_eq!(rows[0]["prefer_score"].as_f64().unwrap(), expected);
        assert_eq!(crate::ranks::split(expected).0, 0);
        // Single distinct card_name → PERCENT_RANK 0 → cubecobra_score 0.
        assert_eq!(rows[0]["cubecobra_score"].as_f64().unwrap(), 0.0);
    }

    /// An extended-art printing must score BELOW an otherwise-identical base printing, so the
    /// base is the one that represents the card.
    ///
    /// The weight had no test at all while it was +12 — the only mention of `Extendedart` in this
    /// file was the title-casing helper — which is how a component ended up being the single
    /// largest disagreement with Scryfall's own representative choice without anything noticing.
    /// Asserted as a RELATION between two drafts rather than against a literal, so it keeps
    /// meaning the same thing if any of the other components are retuned.
    #[test]
    fn extended_art_scores_below_the_base_printing() {
        let mut base = minimal_card("Testcard");
        base["frame_effects"] = json!([]);
        let mut ext = minimal_card("Testcard");
        ext["frame_effects"] = json!(["extendedart"]);

        let rows: Vec<Value> = finalize(
            vec![
                transform(&base).unwrap().unwrap(),
                {
                    let mut d = transform(&ext).unwrap().unwrap();
                    // Distinct id so the last-wins dedupe in `finalize` keeps both.
                    d.scryfall_id = "00000000-0000-0000-0000-0000000000ff".to_string();
                    d
                },
            ],
    &TagData::default()
        )
        .collect();

        let base_score = rows[0]["prefer_score"].as_f64().unwrap();
        let ext_score = rows[1]["prefer_score"].as_f64().unwrap();
        assert!(
            ext_score < base_score,
            "extended art ({ext_score}) must score below the base printing ({base_score})",
        );
        // And by exactly the weight, so a change to it is a deliberate edit here too.
        assert_eq!(base_score - ext_score, 6.0);
    }

    /// Scryfall's label pins its printing as the card's representative, unconditionally.
    ///
    /// Unconditional is the point on this port: it exists to answer like Scryfall, so where
    /// Scryfall named a representative that answer wins outright — including where its pick is
    /// licensed-crossover art that upstream's `art_style` component demotes. Upstream keeps that
    /// veto; see PIN_BONUS.
    #[test]
    fn a_scryfall_label_pins_its_printing() {
        // Two printings of one card in DIFFERENT slots — the pin propagates by (set_code,
        // collector_number), so two rows sharing a slot are the same printing in two languages
        // and are pinned together (`the_pin_propagates_to_the_labelled_slot_in_every_language`).
        let mk = |id: &str, number: &str| {
            let mut c = minimal_card("Pinme");
            c["id"] = json!(id);
            c["collector_number"] = json!(number);
            c
        };
        const ID_A: &str = "aaaaaaaa-0000-0000-0000-000000000001";
        const ID_B: &str = "aaaaaaaa-0000-0000-0000-000000000002";
        let drafts =
            || vec![transform(&mk(ID_A, "1")).unwrap().unwrap(), transform(&mk(ID_B, "2")).unwrap().unwrap()];
        let score_of = |rows: &[Value], id: &str| {
            rows.iter().find(|r| r["scryfall_id"] == json!(id)).expect("row present")["prefer_score"]
                .as_f64()
                .unwrap()
        };

        // Components only: the rank term rides above them and is asserted separately (`ranks`).
        let parts = |rows: &[Value], id: &str| crate::ranks::split(score_of(rows, id));

        // Labelled printing wins by the pin, not by a component margin.
        let mut tagged = TagData::default();
        tagged.labels.insert(ID_B.to_string());
        let rows: Vec<Value> = finalize(drafts(), &tagged).collect();
        assert_eq!(parts(&rows, ID_B).0, 0, "the labelled printing represents its card");
        assert!(
            parts(&rows, ID_B).1 - parts(&rows, ID_A).1 > 900.0,
            "the labelled printing must be pinned above every ordinary score",
        );

        // No labels: scores exactly as before. This is what keeps the second bulk file an
        // OPTIONAL input — an import that cannot fetch it still produces a correct store.
        let rows: Vec<Value> = finalize(drafts(), &TagData::default()).collect();
        assert!(parts(&rows, ID_A).1 < 900.0 && parts(&rows, ID_B).1 < 900.0, "no label, no pin");
        // And the fallback order takes over: same release date, so the lower collector number
        // represents the card (`ranks`).
        assert_eq!(parts(&rows, ID_A).0, 0);
        assert_eq!(parts(&rows, ID_B).0, 1);
    }

    /// The pin reaches the labelled printing's OTHER-LANGUAGE editions — the rows at the same
    /// (set_code, collector_number) — and no further.
    ///
    /// Scryfall's `oracle_cards` label names exactly one scryfall_id and it is always an English
    /// printing, so pinning by id alone leaves every foreign row of that card ranked by raw
    /// `prefer_score`, which picks whatever printing scores best — a non-booster showcase, on 14 of
    /// the 175 `e:khm lang:ja` cards checked against api.scryfall.com. Scryfall's within-language
    /// representative is the printing at the same slot as its English one, which is what this
    /// asserts: the foreign row IN the pinned slot outranks the foreign row outside it.
    #[test]
    fn the_pin_propagates_to_the_labelled_slot_in_every_language() {
        const EN_ID: &str = "aaaaaaaa-0000-0000-0000-000000000063";
        const JA_PINNED: &str = "aaaaaaaa-0000-0000-0000-000000000163";
        const JA_SHOWCASE: &str = "aaaaaaaa-0000-0000-0000-000000000345";
        // English #63 (the labelled printing), its Japanese edition at the same number, and a
        // Japanese showcase printing at #345 — the shape khm ja actually has.
        let printing = |id: &str, number: &str, english: bool, showcase: bool| {
            let mut c = minimal_card("Icebreaker Kraken");
            c["id"] = json!(id);
            c["set"] = json!("khm");
            c["collector_number"] = json!(number);
            c["lang"] = json!(if english { "en" } else { "ja" });
            if showcase {
                c["frame_effects"] = json!(["showcase"]);
            }
            transform(&c).unwrap().unwrap()
        };
        let drafts = || {
            vec![
                printing(EN_ID, "63", true, false),
                printing(JA_PINNED, "63", false, false),
                printing(JA_SHOWCASE, "345", false, true),
            ]
        };
        let score_of = |rows: &[Value], id: &str| {
            rows.iter().find(|r| r["scryfall_id"] == json!(id)).expect("row present")["prefer_score"]
                .as_f64()
                .unwrap()
        };

        // Unpinned, the showcase row is NOT what wins — but the two Japanese rows are separated by
        // ordinary component margins, which is precisely what a pin has to override.
        let components = |rows: &[Value], id: &str| crate::ranks::split(score_of(rows, id)).1;
        let bare: Vec<Value> = finalize(drafts(), &TagData::default()).collect();
        assert!(
            components(&bare, JA_PINNED) < 900.0 && components(&bare, JA_SHOWCASE) < 900.0,
            "no label, no pin",
        );

        let mut tagged = TagData::default();
        tagged.labels.insert(EN_ID.to_string());
        let rows: Vec<Value> = finalize(drafts(), &tagged).collect();
        assert!(
            components(&rows, JA_PINNED) - components(&rows, JA_SHOWCASE) > 900.0,
            "the Japanese printing at the pinned slot must outrank the one outside it by the pin",
        );
        // Exactly +PIN_BONUS once per qualifying row, so raw prefer_score still orders within the
        // pinned slot (English above its own translation, by the language component).
        assert_eq!(score_of(&rows, JA_PINNED) - score_of(&bare, JA_PINNED), PIN_BONUS);
        assert_eq!(score_of(&rows, EN_ID) - score_of(&bare, EN_ID), PIN_BONUS);
        assert_eq!(score_of(&rows, JA_SHOWCASE), score_of(&bare, JA_SHOWCASE));
        assert!(score_of(&rows, EN_ID) > score_of(&rows, JA_PINNED), "English still leads its own slot");
    }

    /// The order a filter falls back on when it excludes the pinned printing: newest release
    /// first, then lowest collector number.
    ///
    /// Derived rather than guessed — 16,045 labelled observations harvested from
    /// api.scryfall.com on 2026-08-16, .9624 of the pin-excluded class against .6594 for the
    /// bare component score. See [`crate::ranks`] for the measurement, the alternatives it beat
    /// and the classes it still gets wrong.
    #[test]
    fn an_excluded_pin_falls_back_to_newest_then_lowest_number() {
        let printing = |id: &str, set: &str, number: &str, released: &str| {
            let mut c = minimal_card("Fallbackk");
            c["id"] = json!(id);
            c["set"] = json!(set);
            c["collector_number"] = json!(number);
            c["released_at"] = json!(released);
            transform(&c).unwrap().unwrap()
        };
        const OLD_LOW: &str = "dddddddd-0000-0000-0000-000000000001";
        const OLD_HIGH: &str = "dddddddd-0000-0000-0000-000000000002";
        const NEW_HIGH: &str = "dddddddd-0000-0000-0000-000000000003";
        let drafts = || {
            vec![
                printing(OLD_LOW, "aaa", "5", "2019-01-01"),
                printing(OLD_HIGH, "aaa", "300", "2019-01-01"),
                printing(NEW_HIGH, "bbb", "270", "2021-06-01"),
            ]
        };
        let rank_of = |rows: &[Value], id: &str| {
            let score = rows.iter().find(|r| r["scryfall_id"] == json!(id)).expect("row")["prefer_score"]
                .as_f64()
                .unwrap();
            crate::ranks::split(score).0
        };

        // No label: recency leads, and the older set orders within itself by collector number.
        let rows: Vec<Value> = finalize(drafts(), &TagData::default()).collect();
        assert_eq!(rank_of(&rows, NEW_HIGH), 0, "the newest printing represents the card");
        assert_eq!(rank_of(&rows, OLD_LOW), 1, "then the older set's lower collector number");
        assert_eq!(rank_of(&rows, OLD_HIGH), 2);

        // A label overrides all of it: the pinned slot is the first key of the order, so the
        // known-exact answer is never traded for the fitted one.
        let mut tagged = TagData::default();
        tagged.labels.insert(OLD_HIGH.to_string());
        let rows: Vec<Value> = finalize(drafts(), &tagged).collect();
        assert_eq!(rank_of(&rows, OLD_HIGH), 0, "the labelled printing wins whatever its date");
        assert_eq!(rank_of(&rows, NEW_HIGH), 1, "and the fallback order resumes underneath it");
        assert_eq!(rank_of(&rows, OLD_LOW), 2);
    }

    /// A different card at the same (set, number) is NOT pinned: the slot key carries the
    /// oracle_id, so the propagation cannot leak across cards.
    #[test]
    fn the_pin_does_not_leak_to_another_card_in_the_same_slot() {
        const PINNED: &str = "bbbbbbbb-0000-0000-0000-000000000001";
        const OTHER: &str = "bbbbbbbb-0000-0000-0000-000000000002";
        let mut a = transform(&minimal_card("Pinme")).unwrap().unwrap();
        a.scryfall_id = PINNED.into();
        a.card_set_code = Some("xyz".into());
        a.collector_number = Some("7".into());
        let mut b = transform(&minimal_card("Otherc")).unwrap().unwrap();
        b.scryfall_id = OTHER.into();
        b.oracle_id = "cccccccc-0000-0000-0000-000000000002".into();
        b.card_set_code = Some("xyz".into());
        b.collector_number = Some("7".into());

        let mut tagged = TagData::default();
        tagged.labels.insert(PINNED.to_string());
        let rows: Vec<Value> = finalize(vec![a, b], &tagged).collect();
        // Each row is rank 0 of its OWN card, so the pin is the whole difference between them.
        let components = |i: usize| crate::ranks::split(rows[i]["prefer_score"].as_f64().unwrap()).1;
        assert!(components(0) > 900.0, "the labelled printing is pinned");
        assert!(components(1) < 900.0, "another card in that slot is not");
    }

    #[test]
    fn finalize_cubecobra_percent_rank() {
        // Three names with edhrec ranks 10, 20, NULL → percent ranks 0, 0.5, 1
        // → scores 0, 12.5, 25 (weight 25), propagated to every printing.
        let mut a = transform(&minimal_card("Alpha")).unwrap().unwrap();
        a.edhrec_rank = Some(10);
        let mut b = transform(&minimal_card("BetaX")).unwrap().unwrap();
        b.edhrec_rank = Some(20);
        b.scryfall_id = "b".into();
        let mut c = transform(&minimal_card("GammaXY")).unwrap().unwrap();
        c.edhrec_rank = None;
        c.scryfall_id = "c".into();
        // Second printing of Alpha shares the name and the score.
        let mut a2 = a.clone();
        a2.scryfall_id = "a2".into();
        let rows: Vec<Value> = finalize(vec![a, b, c, a2], &TagData::default()).collect();
        let score = |i: usize| rows[i]["cubecobra_score"].as_f64().unwrap();
        assert_eq!(score(0), 0.0);
        assert_eq!(score(1), 12.5);
        assert_eq!(score(2), 25.0);
        assert_eq!(score(3), 0.0);
    }

    #[test]
    fn finalize_illustration_count_groups_by_illustration_and_name() {
        let ill = "22222222-2222-4222-8222-222222222222";
        let mk = |name: &str, id: &str, lang_en: bool| {
            let mut d = transform(&minimal_card(name)).unwrap().unwrap();
            d.scryfall_id = id.into();
            d.illustration_id = Some(ill.into());
            d.raw_lang_en = lang_en;
            d
        };
        // Two qualifying printings of the same art + name, one non-English
        // (excluded from the count), one different name (own group).
        let drafts = vec![mk("Same", "1", true), mk("Same", "2", true), mk("Same", "3", false), mk("Other", "4", true)];
        let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
        let illus_component = |row: &Value| {
            // prefer components other than illustration_count are identical
            // (fixture-derived); recover the component by subtracting the
            // known 188 base minus language (row 3 is non-en → 148).
            row["prefer_score"].as_f64().unwrap()
        };
        let count2 = ((23.0 * 3.0f64.ln() / 40.0f64.ln()) * 10_000.0).round() / 10_000.0;
        let count1 = ((23.0 * 2.0f64.ln() / 40.0f64.ln()) * 10_000.0).round() / 10_000.0;
        let rank0 = crate::ranks::rank_term(0);
        assert_eq!(illus_component(&rows[0]), (rank0 + 188.0 + count2) as f32 as f64);
        assert_eq!(illus_component(&rows[1]), (rank0 + 188.0 + count2) as f32 as f64);
        // Non-English row still COUNTS the en rows (its own count is 2) but
        // loses the language component (188 - 40 = 148).
        assert_eq!(illus_component(&rows[2]), (rank0 + 148.0 + count2) as f32 as f64);
        assert_eq!(illus_component(&rows[3]), (rank0 + 188.0 + count1) as f32 as f64);
    }

    #[test]
    fn finalize_attaches_tags_and_art_style() {
        let draft = transform(&fixture("llanowar_elves")).unwrap().unwrap();
        let tags = TagData::from_slug_maps(
            HashMap::from([(draft.oracle_id.clone(), vec!["mana-dork".into(), "mana-producer".into()])]),
            HashMap::from([(
                draft.illustration_id.clone().unwrap(),
                vec!["external-ip".into(), "fallout".into()],
            )]),
        );
        let rows: Vec<Value> = finalize(vec![draft], &tags).collect();
        assert_eq!(rows[0]["card_oracle_tags"], json!({"mana-dork": true, "mana-producer": true}));
        assert_eq!(rows[0]["card_art_tags"], json!({"external-ip": true, "fallout": true}));
        // external-ip without the dnd/lotr exemptions → art_style 0 instead of
        // 14: prefer drops by exactly 14 versus the untagged run.
        let untagged: Vec<Value> = finalize(
            vec![transform(&fixture("llanowar_elves")).unwrap().unwrap()],
            &TagData::default()
        )
        .collect();
        let diff = untagged[0]["prefer_score"].as_f64().unwrap() - rows[0]["prefer_score"].as_f64().unwrap();
        assert_eq!(diff, 14.0);
    }

    /// The row's `illustration_id` is its FRONT face's, so face 0 is a duplicate of it and the
    /// back is the only id the column cannot reach. A face with no art of its own (Fire // Ice's
    /// Ice half) contributes nothing rather than a null entry.
    #[test]
    fn illustration_ids_are_front_first_deduped_and_skip_artless_faces() {
        let delver = transform(&fixture("delver_of_secrets")).unwrap().unwrap();
        assert_eq!(
            illustration_ids(&delver),
            vec!["1c2fee9b-89ea-4ab1-a751-451c3cd65a88", "c2b5f731-771b-4949-90f3-0ad40d676100"]
        );
        let fire_ice = transform(&fixture("fire_ice")).unwrap().unwrap();
        assert_eq!(illustration_ids(&fire_ice), vec!["c890cb20-7e04-4ad0-96a6-8854cd409c14"]);
        let solo = transform(&fixture("llanowar_elves")).unwrap().unwrap();
        assert_eq!(illustration_ids(&solo), vec![solo.illustration_id.as_deref().unwrap()]);
    }

    /// A BACK-face-only art tag reaches the card. `arttag:snow e:khm` is 75 on Scryfall and was 73
    /// here for exactly this reason — Birgi's and Esika's snow is on the back face's art.
    #[test]
    fn art_tags_union_every_face_and_stay_sorted() {
        let draft = transform(&fixture("delver_of_secrets")).unwrap().unwrap();
        let tags = TagData::from_slug_maps(
            HashMap::new(),
            HashMap::from([
                ("1c2fee9b-89ea-4ab1-a751-451c3cd65a88".into(), vec!["human".into(), "window".into()]),
                ("c2b5f731-771b-4949-90f3-0ad40d676100".into(), vec!["insect".into(), "window".into()]),
            ]),
        );
        // Sorted by slug text and deduped, the invariant a single stored list already satisfies.
        assert_eq!(art_tags_of(&tags, &draft), vec!["human", "insect", "window"]);
        let rows: Vec<Value> = finalize(vec![draft], &tags).collect();
        assert_eq!(rows[0]["card_art_tags"], json!({"human": true, "insect": true, "window": true}));
    }

    /// The single-illustration path is untouched by the union: one stored list, returned as-is.
    #[test]
    fn art_tags_of_a_single_illustration_row_are_its_stored_list() {
        let draft = transform(&fixture("llanowar_elves")).unwrap().unwrap();
        let tags = TagData::from_slug_maps(
            HashMap::new(),
            HashMap::from([(draft.illustration_id.clone().unwrap(), vec!["elf".into(), "forest".into()])]),
        );
        assert_eq!(art_tags_of(&tags, &draft), vec!["elf", "forest"]);
        // And a face carrying no art of its own adds nothing: Fire // Ice's tags are the card's.
        let fire_ice = transform(&fixture("fire_ice")).unwrap().unwrap();
        let split_tags = TagData::from_slug_maps(
            HashMap::new(),
            HashMap::from([("c890cb20-7e04-4ad0-96a6-8854cd409c14".into(), vec!["fire".into()])]),
        );
        assert_eq!(art_tags_of(&split_tags, &fire_ice), vec!["fire"]);
    }
}
