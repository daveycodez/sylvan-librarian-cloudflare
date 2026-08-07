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
//!   (api/tag_import.py, ported in `tags.rs`); `card_is_tags` is never written
//!   by `import_data` (it is in bulk_upsert's `skip_columns` and only a separate
//!   manual route touches it), so it is always `{}` here.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::canonical_combining_class;

use crate::tags::TagData;

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
/// backfill reads. ~100k of these are held in memory during aggregation.
#[derive(Debug, Clone)]
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
    pub card_set_code: Option<String>,
    pub card_layout: Option<String>,
    pub card_border: Option<String>,
    pub card_watermark: Option<String>,
    pub collector_number: Option<String>,
    pub collector_number_int: Option<i64>,
    pub mana_cost_text: Option<String>,
    pub type_line: Option<String>,
    pub set_name: Option<String>,
    pub released_at: String,
    pub card_colors: Vec<String>,
    pub card_color_identity: Vec<String>,
    pub produced_mana: Vec<String>,
    pub card_keywords: Vec<String>,
    pub card_types: Vec<String>,
    pub card_subtypes: Vec<String>,
    pub card_legalities: Map<String, Value>,
    pub card_frame_data: Vec<String>,
    pub mana_cost_jsonb: Vec<(String, u32)>,
    pub cmc: Option<i64>,
    pub creature_power: Option<i64>,
    pub creature_toughness: Option<i64>,
    pub creature_power_text: Option<String>,
    pub creature_toughness_text: Option<String>,
    pub planeswalker_loyalty: Option<i64>,
    pub card_rarity_int: Option<i64>,
    pub edhrec_rank: Option<i64>,
    pub price_usd: Option<f64>,
    pub price_eur: Option<f64>,
    pub price_tix: Option<f64>,

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

/// card_processing.py lines 66-76.
fn rarity_text_to_int(rarity: &str) -> i64 {
    match rarity {
        "common" => 0,
        "uncommon" => 1,
        "rare" => 2,
        "mythic" => 3,
        "special" => 4,
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

/// api/parsing/card_query_nodes.py lines 483-494 (`fold_accents`): NFKD then
/// drop combining marks. Single source of truth for `card_name_folded`.
pub fn fold_accents(value: &str) -> String {
    value.nfkd().filter(|c| canonical_combining_class(*c) == 0).collect()
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

/// The filters at the top of `preprocess_card` (lines 104-125), applied both to
/// the top-level card and to each merged face (the Python function recurses, so
/// every face passes through them again with the parent's card-level values).
fn passes_filters(card: &Map<String, Value>) -> Result<bool, TransformError> {
    // Line 104: never-legal paper cards — a card with no "legal" or
    // "restricted" status in ANY format is dropped. This is upstream's policy,
    // mirrored exactly (import_data has no "include never-legal" variant).
    let legalities = card
        .get("legalities")
        .and_then(Value::as_object)
        .ok_or_else(|| TransformError::MissingField { card: s(card, "name").unwrap_or_default(), field: "legalities" })?;
    if !legalities.values().any(|v| matches!(v.as_str(), Some("legal") | Some("restricted"))) {
        return Ok(false);
    }
    // Line 106: playtest promos (Mystery Booster convention cards).
    if array_contains(card, "promo_types", "playtest") {
        return Ok(false);
    }
    // Line 108: digital-only printings.
    if !array_contains(card, "games", "paper") {
        return Ok(false);
    }
    // Line 110: un-sets and other joke products.
    if s(card, "set_type").as_deref() == Some("funny") {
        return Ok(false);
    }
    // Lines 114-118: unplayable "Card"/"Token" type lines.
    if let Some(type_line) = s(card, "type_line")
        && !type_line.is_empty()
    {
        let (card_types, _) = parse_type_line(&type_line);
        if card_types.iter().any(|t| t == "Card" || t == "Token") {
            return Ok(false);
        }
    }
    // Lines 121-124: "X // X" cards (same name on both sides).
    if let Some(name) = s(card, "name")
        && let Some((left, right)) = name.split_once("//")
        && left.trim() == right.trim()
    {
        return Ok(false);
    }
    Ok(true)
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

    // Line 175: planeswalker loyalty (maybe_int of the printed loyalty).
    let planeswalker_loyalty = maybe_int(card.get("loyalty"));

    // Lines 176-189: creature stats only for creatures/Vehicles/Spacecraft;
    // explicit None otherwise (matches the DB check constraint).
    let is_creaturelike = card_types.iter().any(|t| t == "Creature")
        || card_subtypes.iter().any(|t| t == "Vehicle" || t == "Spacecraft");
    let (creature_power, creature_toughness, creature_power_text, creature_toughness_text) = if is_creaturelike {
        (
            maybe_int(card.get("power")),
            maybe_int(card.get("toughness")),
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
    let card_keywords = str_array(card, "keywords");
    let produced_mana = str_array(card, "produced_mana");

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

    // Lines 230-231: mana cost symbol counts. (Line 235's devotion column is
    // NOT ported: it is not in ENGINE_COLUMNS — card_from_pydict recomputes
    // devotion from mana_cost_jsonb + card types, lib.rs lines 688-718.)
    let mana_cost_text = s(card, "mana_cost");
    let mana_cost_jsonb = mana_cost_str_to_counts(mana_cost_text.as_deref().unwrap_or(""));

    // Lines 242-243: folded name (#649).
    let card_name_folded = fold_accents(&card_name.to_lowercase());

    // Line 246 / 249: artist, truncated cmc.
    let card_artist = s(card, "artist");
    let cmc = maybe_int(card.get("cmc"));

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
        card_set_code,
        card_layout,
        card_border,
        card_watermark,
        collector_number,
        collector_number_int,
        mana_cost_text,
        released_at,
        card_colors,
        card_color_identity,
        produced_mana,
        card_keywords,
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
        card_rarity_int,
        edhrec_rank,
        price_usd,
        price_eur,
        price_tix,
    })
}

/// `preprocess_card` for one bulk card object, collapsed through the
/// `scryfall_id` last-wins dedupe.
///
/// Upstream returns a list (one dict per surviving face) and the upsert then
/// keeps exactly one row per scryfall_id, later rows overwriting earlier ones
/// (`_dedupe_rows`, asserted by `test_duplicate_scryfall_id_in_batch_last_wins`).
/// All faces of a card share the parent's `id`, so the database row — and the
/// engine row — is the LAST face that survives preprocessing. This function
/// returns that row directly; `Ok(None)` means every face (or the card itself)
/// was filtered, mirroring upstream's empty list.
pub fn transform(bulk_card: &Value) -> Result<Option<RowDraft>, TransformError> {
    let card = bulk_card
        .as_object()
        .ok_or_else(|| TransformError::BadType { card: String::new(), field: "card" })?;

    if !passes_filters(card)? {
        return Ok(None);
    }

    // Line 134: lift the full card name before face processing.
    let card_name = required_str(card, s(card, "name").unwrap_or_default().as_str(), "name")?;

    // Lines 139-153: faces are the parent dict overlaid with face data
    // (precedence: face overrides parent), each re-run through the filters.
    if let Some(faces) = card.get("card_faces").and_then(Value::as_array) {
        let mut last: Option<RowDraft> = None;
        for face in faces {
            let Some(face_obj) = face.as_object() else { continue };
            let mut merged = card.clone();
            merged.remove("card_faces"); // line 150: don't keep recursing
            // Lines 142-144 pop creature_* keys from the parent before merging;
            // those keys never exist on raw bulk objects, so nothing to do.
            for (k, v) in face_obj {
                merged.insert(k.clone(), v.clone());
            }
            if !passes_filters(&merged)? {
                continue;
            }
            last = Some(build_draft(&merged, &card_name)?);
        }
        return Ok(last);
    }

    Ok(Some(build_draft(card, &card_name)?))
}

// ─── cross-card aggregation: tag attach + score backfills ───────────────────

/// Round to 4 decimal places, half away from zero — Postgres
/// `ROUND(numeric, 4)` semantics used by the illustration_count component.
fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// backfill_prefer_scores.sql, one row: every component of
/// `prefer_score_components`, summed into `prefer_score`.
/// `illustration_count` is the number of qualifying rows sharing this row's
/// (illustration_id, card_name) — see [`finalize`] for the corpus-wide count.
fn prefer_score(draft: &RowDraft, art_tags: &[String], illustration_count: u64) -> f64 {
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

    // 'extended_art' ("extendedart".title() == "Extendedart")
    total += if has_frame("Extendedart") { 12.0 } else { 0.0 };

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
    let has_tag = |t: &str| art_tags.iter().any(|x| x == t);
    let off_style = (has_tag("external-ip") && !(has_tag("dungeons-and-dragons") || has_tag("the-lord-of-the-rings")))
        || has_tag("anime")
        || has_tag("comic-style")
        || has_tag("line-art")
        || has_tag("word-art-title");
    total += if off_style { 0.0 } else { 14.0 };

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
    const W_EDHREC: f64 = 25.0;

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
        .into_iter()
        .map(|(name, rank_val)| {
            let pr = if n == 1 {
                0.0
            } else {
                first_index[&rank_val] as f64 / (n - 1) as f64
            };
            (name.to_string(), W_EDHREC * pr)
        })
        .collect()
}

fn keys_true(keys: &[String]) -> Value {
    let mut m = Map::new();
    for k in keys {
        m.insert(k.clone(), Value::Bool(true));
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
///   4. the cubecobra-score backfill (backfill_cubecobra_scores.sql),
/// and yields one `serde_json::Value` object per row with exactly the
/// ENGINE_COLUMNS key set, in the shape `card_from_pydict` consumes.
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
        if let Some(ill) = &r.illustration_id
            && r.raw_lang_en
            && r.raw_set_type.as_deref() != Some("memorabilia")
            && !matches!(r.card_border.as_deref(), Some("gold") | Some("yellow"))
        {
            *illust_counts.entry((ill.clone(), r.card_name.clone())).or_insert(0) += 1;
        }
    }

    // 4. cubecobra scores per card_name.
    let cubecobra = cubecobra_scores_by_name(&rows);

    let empty: Vec<String> = Vec::new();
    let tags = tags.clone();
    rows.into_iter().map(move |r| {
        let oracle_tags = tags.oracle.get(&r.oracle_id).unwrap_or(&empty);
        let art_tags = r
            .illustration_id
            .as_ref()
            .and_then(|ill| tags.art.get(ill))
            .unwrap_or(&empty);
        let illustration_count = r
            .illustration_id
            .as_ref()
            .and_then(|ill| illust_counts.get(&(ill.clone(), r.card_name.clone())))
            .copied()
            .unwrap_or(0);
        let prefer = prefer_score(&r, art_tags, illustration_count);
        let cubecobra_score = cubecobra.get(&r.card_name).copied();

        // Exactly ENGINE_COLUMNS (card_engine/card_engine/__init__.py lines
        // 40-84); columns the engine never reads (raw_card_blob, devotion,
        // face_name/face_idx, planeswalker_loyalty_text, rarity text,
        // prefer_score_components, cubecobra_* raw columns) are not emitted.
        let mut m = Map::with_capacity(43);
        m.insert("scryfall_id".into(), Value::String(r.scryfall_id));
        m.insert("oracle_id".into(), Value::String(r.oracle_id));
        m.insert("illustration_id".into(), opt_str_val(&r.illustration_id));
        m.insert("card_artist".into(), opt_str_val(&r.card_artist));
        m.insert("card_border".into(), opt_str_val(&r.card_border));
        m.insert("card_color_identity".into(), keys_true(&r.card_color_identity));
        m.insert("card_colors".into(), keys_true(&r.card_colors));
        m.insert("card_frame_data".into(), keys_true(&r.card_frame_data));
        // Never written by import_data: bulk_upsert runs with card_is_tags in
        // skip_columns and only the manual /import_all_is_tags route fills it.
        m.insert("card_is_tags".into(), Value::Object(Map::new()));
        m.insert("card_keywords".into(), keys_true(&r.card_keywords));
        m.insert("card_layout".into(), opt_str_val(&r.card_layout));
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
        m.insert("cmc".into(), opt_i64_val(r.cmc));
        m.insert("collector_number".into(), opt_str_val(&r.collector_number));
        m.insert("collector_number_int".into(), opt_i64_val(r.collector_number_int));
        m.insert("creature_power".into(), opt_i64_val(r.creature_power));
        m.insert("creature_toughness".into(), opt_i64_val(r.creature_toughness));
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
        m.insert("price_eur".into(), opt_f64_val(r.price_eur));
        m.insert("price_tix".into(), opt_f64_val(r.price_tix));
        m.insert("price_usd".into(), opt_f64_val(r.price_usd));
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
        Value::Object(m)
    })
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

    #[test]
    fn lightning_bolt_transforms() {
        let draft = transform(&fixture("lightning_bolt")).unwrap().unwrap();
        assert_eq!(draft.card_name, "Lightning Bolt");
        assert_eq!(draft.card_types, vec!["Instant"]);
        assert_eq!(draft.card_colors, vec!["R"]);
        assert_eq!(draft.cmc, Some(1));
        assert_eq!(draft.creature_power, None);
        assert_eq!(draft.creature_power_text, None);
        assert_eq!(draft.mana_cost_jsonb, vec![("R".to_string(), 1)]);
        assert_eq!(draft.card_rarity_int, Some(1)); // uncommon in msc
        assert!(draft.raw_has_paper);
    }

    #[test]
    fn llanowar_elves_creature_fields() {
        let draft = transform(&fixture("llanowar_elves")).unwrap().unwrap();
        assert_eq!(draft.creature_power, Some(1));
        assert_eq!(draft.creature_toughness, Some(1));
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
    fn dfc_last_face_wins() {
        // Upstream's scryfall_id last-wins dedupe means the stored row for a
        // transform card is its BACK face, under the full "A // B" card_name.
        let card = fixture("delver_of_secrets");
        let draft = transform(&card).unwrap().unwrap();
        assert_eq!(draft.card_name, "Delver of Secrets // Insectile Aberration");
        assert_eq!(draft.card_name_folded, "delver of secrets // insectile aberration");
        // Face 2 (Insectile Aberration) data:
        assert_eq!(draft.type_line.as_deref(), Some("Creature \u{2014} Human Insect"));
        assert_eq!(draft.creature_power, Some(3));
        assert_eq!(draft.creature_toughness, Some(2));
        assert!(draft.mana_cost_jsonb.is_empty()); // back face has no mana cost
        // Face-level illustration id, not the parent's (parent has none).
        let face2_ill = card["card_faces"][1]["illustration_id"].as_str().unwrap();
        assert_eq!(draft.illustration_id.as_deref(), Some(face2_ill));
        // Card-level fields flow through the merge:
        assert_eq!(draft.scryfall_id, card["id"].as_str().unwrap());
        assert_eq!(draft.oracle_id, card["oracle_id"].as_str().unwrap());
        assert_eq!(draft.card_color_identity, vec!["U"]);
        assert_eq!(draft.card_keywords, vec!["Flying", "Transform"]);
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

    #[test]
    fn skip_filters_mirror_upstream() {
        // Never legal in any format → skipped (card_processing.py line 104).
        let mut c = minimal_card("Never Legal");
        c["legalities"] = json!({"vintage": "not_legal"});
        assert!(transform(&c).unwrap().is_none());
        // restricted counts as playable.
        let mut c = minimal_card("Restricted");
        c["legalities"] = json!({"vintage": "restricted"});
        assert!(transform(&c).unwrap().is_some());
        // Playtest promo → skipped (line 106).
        let mut c = minimal_card("Playtest");
        c["promo_types"] = json!(["playtest"]);
        assert!(transform(&c).unwrap().is_none());
        // Digital-only → skipped (line 108).
        let mut c = minimal_card("Digital");
        c["games"] = json!(["arena"]);
        assert!(transform(&c).unwrap().is_none());
        // Funny set → skipped (line 110).
        let mut c = minimal_card("Funny");
        c["set_type"] = json!("funny");
        assert!(transform(&c).unwrap().is_none());
        // Token type line → skipped (lines 114-118).
        let mut c = minimal_card("Token");
        c["type_line"] = json!("Token Creature \u{2014} Goblin");
        assert!(transform(&c).unwrap().is_none());
        // "X // X" same-name card → skipped (lines 121-124).
        let mut c = minimal_card("ignored");
        c["name"] = json!("Echo // Echo");
        assert!(transform(&c).unwrap().is_none());
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
            "scryfall_id", "oracle_id", "illustration_id", "card_artist", "card_border",
            "card_color_identity", "card_colors", "card_frame_data", "card_is_tags",
            "card_keywords", "card_layout", "card_legalities", "card_name",
            "card_name_folded", "card_art_tags", "card_oracle_tags", "card_rarity_int",
            "card_set_code", "card_subtypes", "card_types", "card_watermark", "cmc",
            "collector_number", "collector_number_int", "creature_power",
            "creature_toughness", "edhrec_rank", "flavor_text", "mana_cost_jsonb",
            "mana_cost_text", "oracle_text", "planeswalker_loyalty", "price_eur",
            "price_tix", "price_usd", "produced_mana", "released_at",
            "creature_power_text", "creature_toughness_text", "set_name", "type_line",
            "prefer_score", "cubecobra_score",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        // Spot-check JSONB shapes.
        assert_eq!(row["card_colors"], json!({"G": true}));
        assert_eq!(row["mana_cost_jsonb"], json!({"G": [1]}));
        assert_eq!(row["card_is_tags"], json!({}));
        assert_eq!(row["card_subtypes"], json!(["Elf", "Druid"]));
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
        let expected_illus = ((23.0 * 2.0f64.ln() / 40.0f64.ln()) * 10_000.0).round() / 10_000.0;
        let expected = (188.0 + expected_illus) as f32 as f64;
        assert_eq!(rows[0]["prefer_score"].as_f64().unwrap(), expected);
        // Single distinct card_name → PERCENT_RANK 0 → cubecobra_score 0.
        assert_eq!(rows[0]["cubecobra_score"].as_f64().unwrap(), 0.0);
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
        assert_eq!(illus_component(&rows[0]), (188.0 + count2) as f32 as f64);
        assert_eq!(illus_component(&rows[1]), (188.0 + count2) as f32 as f64);
        // Non-English row still COUNTS the en rows (its own count is 2) but
        // loses the language component (188 - 40 = 148).
        assert_eq!(illus_component(&rows[2]), (148.0 + count2) as f32 as f64);
        assert_eq!(illus_component(&rows[3]), (188.0 + count1) as f32 as f64);
    }

    #[test]
    fn finalize_attaches_tags_and_art_style() {
        let mut tags = TagData::default();
        let draft = transform(&fixture("llanowar_elves")).unwrap().unwrap();
        tags.oracle.insert(draft.oracle_id.clone(), vec!["mana-dork".into(), "mana-producer".into()]);
        tags.art
            .insert(draft.illustration_id.clone().unwrap(), vec!["external-ip".into(), "fallout".into()]);
        let rows: Vec<Value> = finalize(vec![draft], &tags).collect();
        assert_eq!(rows[0]["card_oracle_tags"], json!({"mana-dork": true, "mana-producer": true}));
        assert_eq!(rows[0]["card_art_tags"], json!({"external-ip": true, "fallout": true}));
        // external-ip without the dnd/lotr exemptions → art_style 0 instead of
        // 14: prefer drops by exactly 14 versus the untagged run.
        let untagged: Vec<Value> = finalize(
            vec![transform(&fixture("llanowar_elves")).unwrap().unwrap()],
            &TagData::default(),
        )
        .collect();
        let diff = untagged[0]["prefer_score"].as_f64().unwrap() - rows[0]["prefer_score"].as_f64().unwrap();
        assert_eq!(diff, 14.0);
    }
}
