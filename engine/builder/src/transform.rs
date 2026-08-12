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

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::canonical_combining_class;

use crate::tags::TagData;

/// `is:` values Scryfall ships as BOOLEANS on every bulk card object, as
/// `(card_is_tags key, raw blob key)`. Mirrors api_resource.BOOLEAN_IS_TAGS.
/// foil/promo/reprint are deliberately NOT here yet (higher cardinality,
/// upstream wants a memory check first).
const BOOLEAN_IS_TAGS: &[(&str, &str)] =
    &[("reserved", "reserved"), ("gamechanger", "game_changer"), ("oversized", "oversized")];

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
/// ONE ENTRY SHORT OF UPSTREAM'S, deliberately: upstream excludes `loyalty` because it has a
/// `planeswalker_loyalty_text` column, and this port does not. Its `planeswalker_loyalty` column is
/// the INTEGER the query planner filters `loy:` on, which cannot hold "X" or "1+*", and promoting
/// the text to a card-level column would put it in the main store — the one with the three-chunk
/// ceiling — for a field only `/cards/*` ever reads. So loyalty stays in the residue, where it
/// costs 2 interned bytes a printing in the archive that is already loaded for exactly those
/// routes. Excluding it here while no column held it is what silently dropped it from every
/// planeswalker's card object.
const COMPAT_BLOB_EXCLUDED: [&str; 47] = [
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
const FACE_OBJECT_FIELDS: [&str; 14] = [
    "name",
    "mana_cost",
    "type_line",
    "oracle_text",
    "power",
    "toughness",
    "loyalty",
    // Not in upstream's list, which loses every battle's defense: Scryfall prints it on the FACE
    // (Invasion of Alara's front face is `defense: 7`) and no column holds it.
    "defense",
    "colors",
    "color_indicator",
    "flavor_text",
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
    // Line 117: memorabilia -- World Championship decks, Collectors' Edition, 30th Anniversary,
    // the oversized promos. Scryfall hides these from any search that does not name their set, so
    // importing them makes ordinary queries disagree with it; they were supplying the CHEAPEST
    // printing for 184 cards, which is the printing a price ordering returns. See upstream's
    // card_processing.py for why this is an IMPORT filter and not a query-time one -- the short
    // version is that a conjunct on every query breaks four of the six physical plans.
    //
    // 2,672 of this store's 97,803 printings (2.73%), and 0 of its 31,724 cards are printed only
    // in memorabilia sets, so no card is lost.
    if s(card, "set_type").as_deref() == Some(MEMORABILIA_SET_TYPE) {
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
    // Lowercased so the stored key matches what `keyword:` looks up -- Scryfall's own spelling
    // is inconsistently cased ("First strike", "Doctor's companion"), and lowercase is the same
    // normalization the oracle/art tag collections already use on both sides. Any collision the
    // fold creates collapses in keys_true, matching Python's dict.fromkeys.
    let card_keywords: Vec<String> = str_array(card, "keywords").iter().map(|k| k.to_lowercase()).collect();
    let produced_mana = str_array(card, "produced_mana");

    // The is: tags Scryfall ships as booleans on every bulk card object. Upstream
    // syncs these from raw_card_blob in one set-based statement after each upsert
    // (_sync_boolean_is_tags); there is no stored row to reconcile against here,
    // so the set is simply rebuilt per card. Adding an entry to BOOLEAN_IS_TAGS is
    // the whole change on both sides.
    let card_is_tags: Vec<String> = BOOLEAN_IS_TAGS
        .iter()
        .filter(|(_, blob_key)| card.get(*blob_key) == Some(&Value::Bool(true)))
        .map(|(tag, _)| (*tag).to_owned())
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
        card_rarity_int,
        edhrec_rank,
        price_usd,
        price_eur,
        price_tix,
        // Filled by `transform` after the per-face drafts merge; a single-faced
        // card has none, which is the ~82% case.
        card_faces: Vec::new(),
        // Also filled by `transform`, from the card as Scryfall sent it rather than from the
        // per-face overlay this function may have been handed.
        compat_blob: Map::new(),
    })
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
        // Upstream's second group is (planeswalker_loyalty, planeswalker_loyalty_text).
        // This port has no loyalty _text column — the engine stores loyalty text only
        // per FACE (FaceRow.planeswalker_loyalty_text_id) — so the group is one field.
        if merged.planeswalker_loyalty.is_none() && face.planeswalker_loyalty.is_some() {
            merged.planeswalker_loyalty = face.planeswalker_loyalty;
        }
    }

    merged
}

/// `preprocess_card` for one bulk card object.
///
/// A multi-face card (transform, MDFC, split, adventure, flip) becomes ONE row
/// carrying the front face's identity and every face's searchable data — see
/// [`merge_face_drafts`]. `Ok(None)` means every face (or the card itself) was
/// filtered, mirroring upstream's empty list.
pub fn transform(bulk_card: &Value) -> Result<Option<RowDraft>, TransformError> {
    let card = bulk_card
        .as_object()
        .ok_or_else(|| TransformError::BadType { card: String::new(), field: "card" })?;

    if !passes_filters(card)? {
        return Ok(None);
    }

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
            if !passes_filters(&merged)? {
                continue;
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
        // metadata) belongs to the printing rather than to one of its faces.
        row.compat_blob = compat_blob(card);
        return Ok(Some(row));
    }

    let mut row = build_draft(card, &card_name)?;
    row.compat_blob = compat_blob(card);
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
/// Large enough to dominate every real component sum (scores land in ~130-220), because this is a
/// PIN rather than another weight: where the label exists and applies, it decides. `prefer_score`
/// still ranks everything underneath it, which is what the ~3.4% of cards with no usable label,
/// the per-artwork-group representatives `unique=artwork` needs, and every filtered query fall
/// back on.
pub const PIN_BONUS: f64 = 1000.0;

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

    let empty: Vec<u32> = Vec::new();
    let tags = tags.clone();
    rows.into_iter().map(move |r| {
        let oracle_tags = tags.resolve(tags.oracle.get(&r.oracle_id).unwrap_or(&empty));
        let art_tags = tags.resolve(
            r.illustration_id
                .as_ref()
                .and_then(|ill| tags.art.get(ill))
                .unwrap_or(&empty),
        );
        let illustration_count = r
            .illustration_id
            .as_ref()
            .and_then(|ill| illust_counts.get(&(ill.clone(), r.card_name.clone())))
            .copied()
            .unwrap_or(0);
        let cubecobra_score = cubecobra.get(&r.card_name).copied();
        let pinned = tags.labels.contains(&r.scryfall_id);
        finalize_row(r, &oracle_tags, &art_tags, illustration_count, cubecobra_score, pinned)
    })
}

/// The illustration_count predicate (backfill_prefer_scores.sql lines 31-45):
/// returns the row's illustration_id when the row qualifies for counting.
/// Shared by the native aggregation above and the wasm import's aggregation
/// pass, so the two paths cannot drift.
pub fn illust_count_key(r: &RowDraft) -> Option<&str> {
    let ill = r.illustration_id.as_deref()?;
    if r.raw_lang_en
        && r.raw_set_type.as_deref() != Some("memorabilia")
        && !matches!(r.card_border.as_deref(), Some("gold") | Some("yellow"))
    {
        Some(ill)
    } else {
        None
    }
}

/// Emit one finalized ENGINE_COLUMNS row from a draft plus its aggregation
/// inputs. Split out of [`finalize`]'s closure so the wasm (Durable Object)
/// import path — which streams drafts from external storage instead of
/// holding a Vec — produces byte-identical rows through the same code.
pub fn finalize_row(
    r: RowDraft,
    oracle_tags: &[&str],
    art_tags: &[&str],
    illustration_count: u64,
    cubecobra_score: Option<f64>,
    // This printing is the one Scryfall's `oracle_cards` file names as the card's representative,
    // AND `pin_applies` allowed the pin. Decided by the CALLER because it needs a per-card fact
    // (does an on-style alternative exist), and both import paths already make a per-card pass —
    // keeping the decision there is what stops the two drifting.
    pinned: bool,
) -> Value {
    {
        let prefer = prefer_score(&r, art_tags, illustration_count) + if pinned { PIN_BONUS } else { 0.0 };

        // Exactly ENGINE_COLUMNS (card_engine/card_engine/__init__.py lines
        // 40-84); columns the engine never reads (raw_card_blob, devotion,
        // face_name/face_idx, planeswalker_loyalty_text, rarity text,
        // prefer_score_components, cubecobra_* raw columns) are not emitted.
        let mut m = Map::with_capacity(45);
        m.insert("scryfall_id".into(), Value::String(r.scryfall_id));
        m.insert("oracle_id".into(), Value::String(r.oracle_id));
        m.insert("illustration_id".into(), opt_str_val(&r.illustration_id));
        m.insert("card_artist".into(), opt_str_val(&r.card_artist));
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
        m.insert("cmc".into(), opt_f64_val(r.cmc));
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

    /// The funny-set filter is NOT relaxed by the change above: this is a capability, not a
    /// corpus decision, and the one card with a fractional mana value stays out either way.
    #[test]
    fn a_funny_set_is_still_dropped() {
        let mut card = minimal_card("Unfunny");
        card["set_type"] = json!("funny");
        card["cmc"] = json!(0.5);
        assert!(transform(&card).unwrap().is_none(), "set_type funny must still be filtered out");
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
        assert_eq!(draft.creature_power, Some(1));
        assert_eq!(draft.creature_toughness, Some(1));
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
        // Memorabilia set → skipped (line 117). The LITERAL, not MEMORABILIA_SET_TYPE: driving
        // both sides off the same constant makes the assertion self-referential and it then holds
        // with the constant set to anything at all.
        let mut c = minimal_card("WorldChampionship");
        c["set_type"] = json!("memorabilia");
        assert!(transform(&c).unwrap().is_none());
        // ...and an ordinary expansion is untouched, so a predicate that dropped EVERYTHING would
        // fail here rather than looking like a working filter.
        let mut c = minimal_card("Ordinary");
        c["set_type"] = json!("expansion");
        assert!(transform(&c).unwrap().is_some());
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
            "prefer_score", "cubecobra_score", "card_faces", "card_compat_blob",
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
    fn a_planeswalkers_printed_loyalty_survives_into_the_residue() {
        // Upstream excludes `loyalty` from the residue because it has a loyalty TEXT column; this
        // port only has the integer one the query planner filters `loy:` on, so excluding it here
        // dropped the key from every planeswalker's card object. It has to reach the blob, and as
        // the printed STRING — the integer column cannot represent "X" or "1+*".
        let row = &finalize(
            vec![transform(&fixture("jace_the_mind_sculptor")).unwrap().unwrap()],
            &TagData::default(),
        )
        .collect::<Vec<Value>>()[0];
        assert_eq!(row["card_compat_blob"]["loyalty"], json!("3"));
        // The numeric column still answers `loy:`, and is still a number.
        assert_eq!(row["planeswalker_loyalty"], json!(3));

        // A card with no loyalty keeps the key ABSENT rather than null: Scryfall omits it, and a
        // reconstructed object that carries `"loyalty": null` differs from Scryfall on every
        // non-planeswalker.
        let bolt = &finalize(vec![transform(&fixture("lightning_bolt")).unwrap().unwrap()], &TagData::default())
            .collect::<Vec<Value>>()[0];
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
        let expected_illus = ((23.0 * 2.0f64.ln() / 40.0f64.ln()) * 10_000.0).round() / 10_000.0;
        let expected = (188.0 + expected_illus) as f32 as f64;
        assert_eq!(rows[0]["prefer_score"].as_f64().unwrap(), expected);
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
        let mk = |id: &str| {
            let mut c = minimal_card("Pinme");
            c["id"] = json!(id);
            c
        };
        const ID_A: &str = "aaaaaaaa-0000-0000-0000-000000000001";
        const ID_B: &str = "aaaaaaaa-0000-0000-0000-000000000002";
        let drafts = || vec![transform(&mk(ID_A)).unwrap().unwrap(), transform(&mk(ID_B)).unwrap().unwrap()];
        let score_of = |rows: &[Value], id: &str| {
            rows.iter().find(|r| r["scryfall_id"] == json!(id)).expect("row present")["prefer_score"]
                .as_f64()
                .unwrap()
        };

        // Labelled printing wins by the pin, not by a component margin.
        let mut tagged = TagData::default();
        tagged.labels.insert(ID_B.to_string());
        let rows: Vec<Value> = finalize(drafts(), &tagged).collect();
        assert!(
            score_of(&rows, ID_B) - score_of(&rows, ID_A) > 900.0,
            "the labelled printing must be pinned above every ordinary score",
        );

        // No labels: scores exactly as before. This is what keeps the second bulk file an
        // OPTIONAL input — an import that cannot fetch it still produces a correct store.
        let rows: Vec<Value> = finalize(drafts(), &TagData::default()).collect();
        assert!(score_of(&rows, ID_A) < 900.0 && score_of(&rows, ID_B) < 900.0, "no label, no pin");
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
}
