// LOCAL PATCH (Cloudflare port): the pure-Rust surface of the engine.
//
// Everything here is a JSON-shaped mirror of an existing pyo3 code path — no
// new engine logic. The three consumers are:
//
//   - sylvan-store-builder (native bin): StoreBuilder — card_from_json rows in,
//     archive bytes out via the same build_card_data()/write_archive() pipeline
//     reload_commit() uses.
//   - sylvan-engine-wasm (Worker): BufferStore — the archive held as an owned
//     16-aligned buffer instead of an mmap, queried through the same
//     bind_and_split_filter_value()/run_query_routed() path as the pyo3
//     query(), with rows rendered to serde_json instead of PyDicts.
//   - card_engine's own python surface: EngineError, which the core paths now
//     return and the pyo3 wrappers convert back into the exact exception types
//     they raised before.
//
// Mirroring rule: every `jv_*` input helper here is a field-for-field port of
// the `opt_*`/pydict helper of the same shape in lib.rs, and JSON_FIELD_TABLE
// mirrors FIELD_TABLE entry-for-entry. When upstream changes one of those,
// this file must follow — scripts/sync-upstream.sh flags lib.rs for exactly
// that review.

use super::{face_mana_cost, face_stat_nums};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::num::NonZeroU32;

use super::{
    AOracleCard, APrinting, AStrings, ARCHIVE_FORMAT_VERSION, ARCHIVE_HEADER_LEN, ARTIST_NONE,
    CardData, CardRow, CompatFields, FaceRow, InlineStr, Interner, ManaCost, ManaVocabInterner,
    PERMANENT_TYPES, QueryCtx, QueryParams, RelatedCard, VocabInterner, archive_header,
    build_card_data, card_types_list_to_bits, coll_str, coll_str_opt, color_list_to_mask,
    count_common_keywords, count_common_types, format_shift_or_assign, identity_letters,
    iso8601_utc_to_epoch_secs, lane_add,
    legality_bits_to_json, legality_code, mana_lane, parse_uuid_or_hash, rarity_int_to_text,
    frame_of, released_int_to_iso, run_query_routed, sorted_strs, str_at, strip_reminder_text, sync_format_shifts, uuid_from_u128,
    write_archive,
    DEFAULT_FIELDS,
    // The compat residue's flag bits and bitset vocabularies, shared with FIELD_TABLE's twins.
    COMPAT_BOOSTER, COMPAT_DIGITAL, COMPAT_FOIL, COMPAT_FULL_ART, COMPAT_HIGHRES_IMAGE,
    COMPAT_NONFOIL, COMPAT_OVERSIZED, COMPAT_PROMO, COMPAT_REPRINT, COMPAT_STORY_SPOTLIGHT,
    COMPAT_TEXTLESS, COMPAT_VARIATION, FINISH_ETCHED, FINISH_FOIL, FINISH_GLOSSY, FINISH_NONFOIL,
    FINISH_NAMES, VOCAB_NONE, bits_to_names, compat_flag, games_pack, games_to_names,
    // The engine surface #912 adds: external-id addressing, fuzzy name match, autocomplete.
    EXT_ARENA, EXT_CARDMARKET, EXT_MTGO, EXT_MULTIVERSE, EXT_TCGPLAYER, FuzzyOutcome, fuzzy_name_match, record_of_exact_name,
    // The multilingual surface: the widened driver and the virtual-pid resolvers. The by-id
    // lookups reach BOTH printing spaces through find_vpid_by_*, never through the canonical
    // index alone — see card_by_scryfall_id.
    card_of_vpid, printing_at, run_query_widened,
};
use rkyv::Archived;
use rkyv::util::AlignedVec;

// ─── Error type ──────────────────────────────────────────────────────────────

/// What kind of failure an [`EngineError`] is. The python feature maps each
/// kind back onto the exception type the pyo3 surface raised before this type
/// existed, so python callers observe no change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineErrorKind {
    /// Engine invariant / IO failure (was PyRuntimeError).
    Runtime,
    /// Bad input data (was PyValueError).
    Value,
    /// Malformed or unbuildable query (was card_engine.QueryError).
    Query,
    /// `fields` named an unknown field (was card_engine.UnknownFieldError).
    UnknownField,
    /// A query regex is unsupported, malformed, or exhausted its execution budget
    /// (was card_engine.UnsupportedRegexError). Distinct from `Query` because it is
    /// FATAL: it names a defect in the query text itself, so there is no retry —
    /// unlike an engine decline, which the SQL path may still serve.
    UnsupportedRegex,
}

/// Plain error carried by the pure-Rust core paths.
#[derive(Debug, Clone)]
pub struct EngineError {
    pub kind: EngineErrorKind,
    pub msg: String,
}

impl EngineError {
    pub(crate) fn runtime(msg: impl Into<String>) -> Self {
        EngineError { kind: EngineErrorKind::Runtime, msg: msg.into() }
    }

    pub(crate) fn value(msg: impl Into<String>) -> Self {
        EngineError { kind: EngineErrorKind::Value, msg: msg.into() }
    }

    pub(crate) fn query(msg: impl Into<String>) -> Self {
        EngineError { kind: EngineErrorKind::Query, msg: msg.into() }
    }

    pub(crate) fn unknown_field(msg: impl Into<String>) -> Self {
        EngineError { kind: EngineErrorKind::UnknownField, msg: msg.into() }
    }

    pub(crate) fn unsupported_regex(msg: impl Into<String>) -> Self {
        EngineError { kind: EngineErrorKind::UnsupportedRegex, msg: msg.into() }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for EngineError {}

/// The exception mapping that keeps the python surface's behavior unchanged:
/// each kind converts to exactly the exception type the pre-patch code raised
/// at that site.
#[cfg(feature = "python")]
impl From<EngineError> for pyo3::PyErr {
    fn from(e: EngineError) -> pyo3::PyErr {
        match e.kind {
            EngineErrorKind::Runtime => pyo3::exceptions::PyRuntimeError::new_err(e.msg),
            EngineErrorKind::Value => pyo3::exceptions::PyValueError::new_err(e.msg),
            EngineErrorKind::Query => super::QueryError::new_err(e.msg),
            EngineErrorKind::UnknownField => super::UnknownFieldError::new_err(e.msg),
            EngineErrorKind::UnsupportedRegex => super::UnsupportedRegexError::new_err(e.msg),
        }
    }
}

/// The archive format version readers and writers must agree on — exposed for
/// store manifests and the wasm `store_version()` health check.
pub fn store_format_version() -> u32 {
    ARCHIVE_FORMAT_VERSION
}

// ─── JSON loading helpers (mirrors of the pydict `opt_*` helpers) ────────────
// Same key, same default, same conversion as the pydict twin; JSON null and a
// missing key both read as absent, exactly like a Python None / missing dict
// key does through `get_item(key).ok().flatten()`.

fn jv_opt_str(d: &Value, key: &str) -> Option<String> {
    d.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Mirror of `opt_uuid`. JSON carries UUIDs as strings, so only the
/// string→u128 arm of the pydict version applies (psycopg's native uuid.UUID
/// objects cannot appear in JSON input).
fn jv_opt_uuid(d: &Value, key: &str) -> u128 {
    d.get(key).and_then(Value::as_str).map(parse_uuid_or_hash).unwrap_or(0)
}



/// Mirror of `opt_date_str`. JSON carries dates as ISO strings, so only the
/// string arm of the pydict version (which also accepts datetime.date from
/// psycopg) applies.
fn jv_opt_date_str(d: &Value, key: &str) -> Option<String> {
    jv_opt_str(d, key)
}

/// Mirror of `opt_price_cents`: dollars → rounded integer cents.
/// `Value::Number` covers both the f64 and i64 arms of the pydict version, and `Value::String`
/// its string arm — which is the arm the corpus actually takes, since Scryfall sends every member
/// of `prices` as a decimal string.
fn jv_opt_price_cents(d: &Value, key: &str) -> Option<u32> {
    let dollars = match d.get(key)? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    Some((dollars * 100.0).round() as u32)
}

/// Mirror of `opt_image_updated_at`: Scryfall's ISO-8601 UTC string → epoch seconds.
fn jv_opt_image_updated_at(d: &Value, key: &str) -> Option<NonZeroU32> {
    let secs = match d.get(key)? {
        Value::String(s) => iso8601_utc_to_epoch_secs(s)?,
        // Already-numeric input (a re-ingested row) keeps the old reading rather than vanishing.
        other => other.as_u64().and_then(|n| u32::try_from(n).ok())?,
    };
    NonZeroU32::new(secs)
}

fn jv_opt_f32(d: &Value, key: &str) -> Option<f32> {
    d.get(key).and_then(Value::as_f64).map(|n| n as f32)
}

fn jv_opt_u8(d: &Value, key: &str) -> Option<u8> {
    jv_opt_f32(d, key).map(|v| v as u8)
}

fn jv_opt_u16(d: &Value, key: &str) -> Option<u16> {
    jv_opt_f32(d, key).map(|v| v as u16)
}

fn jv_opt_u32(d: &Value, key: &str) -> Option<u32> {
    jv_opt_f32(d, key).map(|v| v as u32)
}

/// Mirror of `str_list`, including the all-or-nothing shape of
/// `extract::<Vec<String>>`: one non-string element makes the whole list read
/// as absent, not as a partial list.
fn jv_str_list(d: &Value, key: &str) -> Vec<String> {
    d.get(key)
        .and_then(Value::as_array)
        .and_then(|arr| arr.iter().map(|v| v.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>())
        .unwrap_or_default()
}

/// Mirror of `jsonb_color_to_bits`: the object's KEYS are the colors.
fn jv_color_bits(d: &Value, key: &str) -> u8 {
    let colors: Vec<&str> = d
        .get(key)
        .and_then(Value::as_object)
        .map(|m| m.keys().map(String::as_str).collect())
        .unwrap_or_default();
    color_list_to_mask(&colors)
}

/// Mirror of `str_list_to_ids`: interned ids preserving element order.
fn jv_str_list_to_ids(d: &Value, key: &str, vocab: &mut VocabInterner) -> Result<Vec<u16>, EngineError> {
    jv_str_list(d, key).into_iter().map(|s| vocab.intern(s)).collect()
}

/// Mirror of `jsonb_obj_to_ids`: the object's keys, interned, sorted, deduped.
fn jv_obj_to_ids(d: &Value, key: &str, vocab: &mut VocabInterner) -> Result<Vec<u16>, EngineError> {
    let mut ids: Vec<u16> = d
        .get(key)
        .and_then(Value::as_object)
        .map(|m| m.keys().map(|s| vocab.intern(s.clone())).collect::<Result<Vec<u16>, EngineError>>())
        .transpose()?
        .unwrap_or_default();
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// Mirror of legality.rs's `jsonb_obj_to_legality_bits`: an object of
/// `{format: status}` strings folded into the packed legality word, assigning
/// registry shifts through the same `format_shift_or_assign` path. A
/// non-string status is skipped, like the pydict version's `extract().ok()?`.
fn jv_legality_bits(d: &Value, key: &str) -> u64 {
    d.get(key)
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(format, status)| {
                    let status = status.as_str()?;
                    let shift = format_shift_or_assign(format)?;
                    Some(legality_code(status) << shift)
                })
                .fold(0u64, |bits, b| bits | b)
        })
        .unwrap_or_default()
}

/// Mirror of `str_list_color_mask`: colors as Scryfall spells them on a FACE —
/// a plain list (`["W"]`), not the row columns' jsonb object. Same mask either way.
fn jv_str_list_color_mask(d: &Value, key: &str) -> u8 {
    let colors = jv_str_list(d, key);
    color_list_to_mask(&colors.iter().map(String::as_str).collect::<Vec<_>>())
}

/// Mirror of `opt_str_list_color_mask`: `["W"]` is `Some(1)`, `[]` is `Some(0)`, an absent key is
/// `None`. The three states `face_color_masks` needs and the plain mask collapses two of.
fn jv_opt_str_list_color_mask(d: &Value, key: &str) -> Option<u8> {
    d.get(key).filter(|v| !v.is_null()).map(|_| jv_str_list_color_mask(d, key))
}

/// Mirror of `faces_from_pydict`: the card's faces, front first; empty for the
/// ~82% of cards with one face.
///
/// Keys are Scryfall's own (`_FACE_OBJECT_FIELDS` in api/card_processing.py), not the row's
/// column names, because a face record is a snapshot of what Scryfall sent for that face.
///
/// The distinction that matters: `intern_opt(None)` yields `NONE_STR`, not the id of `""`.
/// Scryfall OMITS a key rather than sending null, so an absent key has to stay absent — a
/// transform back face has no `mana_cost` at all, which is different from having an empty one.
/// The three non-optional ids (name, type_line, oracle_text) use `unwrap_or_default()` to match
/// the pydict twin exactly, so both sides agree key-for-key.
/// The FRONT face's `layout` — the whole of `CardRow::card_face_layout_id`, since every face of
/// every printing that has the key agrees on its value (measured: 81 printings, 162 faces).
///
/// The pydict twin is `face_layout_from_pydict` in lib.rs.
fn jv_face_layout(d: &Value) -> Option<String> {
    d.get("card_faces")
        .and_then(Value::as_array)
        .and_then(|l| l.first())
        .and_then(|f| jv_opt_str(f, "layout"))
}

fn jv_faces(
    d: &Value,
    it: &mut Interner,
    artists: &mut VocabInterner,
    mana: &mut ManaVocabInterner,
) -> Result<Vec<FaceRow>, EngineError> {
    let Some(list) = d.get("card_faces").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut faces = Vec::with_capacity(list.len());
    for face in list {
        if !face.is_object() {
            continue;
        }
        // Lowercased into the artist vocab for search, original case into the string table for
        // the card object — the vocab alone loses the printed capitalization.
        let artist = jv_opt_str(face, "artist");
        let card_artist_name_id = it.intern_opt(artist.clone());
        let card_artist_vid = match artist {
            Some(a) => artists.intern(a.to_lowercase())?,
            None => ARTIST_NONE,
        };
        // The searchable half, parsed from the face's own printed strings — see OracleFace. An
        // absent OR empty `mana_cost` is no cost at all, not a cost of zero.
        let face_mana = jv_opt_str(face, "mana_cost").filter(|s| !s.is_empty());
        let (creature_power, creature_toughness, planeswalker_loyalty) = face_stat_nums(
            jv_opt_str(face, "type_line").as_deref(),
            jv_opt_str(face, "power").as_deref(),
            jv_opt_str(face, "toughness").as_deref(),
            jv_opt_str(face, "loyalty").as_deref(),
        );
        let mana_cost = match face_mana {
            Some(s) => Some(face_mana_cost(&s, mana)?),
            None => None,
        };
        faces.push(FaceRow {
            card_artist_name_id,
            // Scryfall's face watermarks are lowercase already — all 76 distinct values across
            // the 2026-08-16 all_cards bulk, top level and face alike — so the one interned id
            // serves both `wm:`, which compares lowercase, and the card object, which prints it.
            card_watermark_id: it.intern_opt(jv_opt_str(face, "watermark")),
            creature_power,
            creature_toughness,
            planeswalker_loyalty,
            mana_cost,
            card_name_id: it.intern(jv_opt_str(face, "name").unwrap_or_default()),
            mana_cost_text_id: it.intern_opt(jv_opt_str(face, "mana_cost")),
            type_line_id: it.intern(jv_opt_str(face, "type_line").unwrap_or_default()),
            oracle_text_id: it.intern(jv_opt_str(face, "oracle_text").unwrap_or_default()),
            creature_power_text_id: it.intern_opt(jv_opt_str(face, "power")),
            creature_toughness_text_id: it.intern_opt(jv_opt_str(face, "toughness")),
            planeswalker_loyalty_text_id: it.intern_opt(jv_opt_str(face, "loyalty")),
            defense_text_id: it.intern_opt(jv_opt_str(face, "defense")),
            flavor_name_id: it.intern_opt(jv_opt_str(face, "flavor_name")),
            // Absent `colors` stays absent — a split or flip face has no colour of its own and
            // must inherit the card's, not read as colourless. See `face_color_masks`.
            card_colors: jv_opt_str_list_color_mask(face, "colors"),
            color_indicator: jv_str_list_color_mask(face, "color_indicator"),
            illustration_id: jv_opt_str(face, "illustration_id").map_or(0, |s| parse_uuid_or_hash(&s)),
            card_artist_vid,
            flavor_text_id: it.intern_opt(jv_opt_str(face, "flavor_text")),
            printed_name_id: it.intern_opt(jv_opt_str(face, "printed_name")),
            printed_type_line_id: it.intern_opt(jv_opt_str(face, "printed_type_line")),
            printed_text_id: it.intern_opt(jv_opt_str(face, "printed_text")),
        });
    }
    Ok(faces)
}

/// Mirror of `opt_bool`: a missing key, a null and a non-bool all read false.
fn jv_opt_bool(d: &Value, key: &str) -> bool {
    d.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Mirror of `str_set_bits`: one bit per member present in a string list.
fn jv_str_set_bits(d: &Value, key: &str, table: &[(&str, u8)]) -> u8 {
    let present = jv_str_list(d, key);
    table
        .iter()
        .filter(|(name, _)| present.iter().any(|p| p == name))
        .fold(0u8, |acc, (_, bit)| acc | bit)
}

/// The `games` list as the ORDERED bit sequence `games_pack` packs, unknown members dropped.
///
/// Its sibling `jv_str_set_bits` folds membership and loses the order, which is fine for
/// `finishes` (Scryfall lists those in a fixed nonfoil/foil/etched order) and wrong for `games`.
fn jv_games_bits(d: &Value, key: &str) -> u8 {
    games_pack(jv_str_list(d, key).iter().map(String::as_str))
}

/// Mirror of `opt_nonzero_u32`: a 0 reads as absent, which is right for every field this is used
/// on — an id or a price of 0 is not a value Scryfall sends.
fn jv_opt_nonzero_u32(d: &Value, key: &str) -> Option<NonZeroU32> {
    jv_opt_u32(d, key).and_then(NonZeroU32::new)
}

/// Mirror of `compat_from_pydict`: the residue Scryfall sends that no column holds, read out of
/// `card_compat_blob`.
///
/// Absent keys stay at their sentinel: `VOCAB_NONE` for interned ids, `None` for the optionals,
/// clear bits for the flags. Scryfall OMITS a key rather than sending null, so "zero" has to mean
/// "was not there" or a reconstructed card object sprouts nulls Scryfall never sent.
fn jv_compat(d: &Value, vocab: &mut VocabInterner) -> Result<CompatFields, EngineError> {
    let Some(blob) = d.get("card_compat_blob").filter(|v| v.is_object()) else {
        return Ok(CompatFields::default());
    };
    let prices = blob.get("prices").filter(|v| v.is_object());
    let price = |key: &str| prices.and_then(|p| jv_opt_price_cents(p, key)).and_then(NonZeroU32::new);

    let mut flags = 0u16;
    for (key, bit) in [
        ("booster", COMPAT_BOOSTER),
        ("digital", COMPAT_DIGITAL),
        ("foil", COMPAT_FOIL),
        ("nonfoil", COMPAT_NONFOIL),
        ("full_art", COMPAT_FULL_ART),
        ("highres_image", COMPAT_HIGHRES_IMAGE),
        ("oversized", COMPAT_OVERSIZED),
        ("promo", COMPAT_PROMO),
        ("reprint", COMPAT_REPRINT),
        ("story_spotlight", COMPAT_STORY_SPOTLIGHT),
        ("textless", COMPAT_TEXTLESS),
        ("variation", COMPAT_VARIATION),
    ] {
        if jv_opt_bool(blob, key) {
            flags |= bit;
        }
    }

    let intern_opt = |vocab: &mut VocabInterner, value: Option<String>| -> Result<u16, EngineError> {
        match value {
            Some(v) => vocab.intern(v),
            None => Ok(VOCAB_NONE),
        }
    };

    Ok(CompatFields {
        arena_id: jv_opt_nonzero_u32(blob, "arena_id"),
        mtgo_id: jv_opt_nonzero_u32(blob, "mtgo_id"),
        mtgo_foil_id: jv_opt_nonzero_u32(blob, "mtgo_foil_id"),
        tcgplayer_id: jv_opt_nonzero_u32(blob, "tcgplayer_id"),
        tcgplayer_etched_id: jv_opt_nonzero_u32(blob, "tcgplayer_etched_id"),
        cardmarket_id: jv_opt_nonzero_u32(blob, "cardmarket_id"),
        penny_rank: jv_opt_nonzero_u32(blob, "penny_rank"),
        image_updated_at: jv_opt_image_updated_at(blob, "image_updated_at"),
        price_usd_foil: price("usd_foil"),
        price_usd_etched: price("usd_etched"),
        price_eur_foil: price("eur_foil"),
        set_vid: intern_opt(vocab, jv_opt_str(blob, "set_id"))?,
        lang_id: intern_opt(vocab, jv_opt_str(blob, "lang"))?,
        image_status_id: intern_opt(vocab, jv_opt_str(blob, "image_status"))?,
        set_type_id: intern_opt(vocab, jv_opt_str(blob, "set_type"))?,
        security_stamp_id: intern_opt(vocab, jv_opt_str(blob, "security_stamp"))?,
        games: jv_games_bits(blob, "games"),
        finishes: jv_str_set_bits(
            blob,
            "finishes",
            &[
                ("nonfoil", FINISH_NONFOIL),
                ("foil", FINISH_FOIL),
                ("etched", FINISH_ETCHED),
                ("glossy", FINISH_GLOSSY),
            ],
        ),
        flags,
        // The pydict twin's `extract::<Vec<u32>>` is all-or-nothing: one non-integer element makes
        // the whole list read as absent, so a filter_map here would diverge. `collect::<Option>`
        // keeps the two agreeing.
        multiverse_ids: blob
            .get("multiverse_ids")
            .and_then(Value::as_array)
            .and_then(|arr| arr.iter().map(|v| v.as_u64().map(|n| n as u32)).collect::<Option<Vec<_>>>())
            .unwrap_or_default(),
        promo_types: jv_str_list_to_ids(blob, "promo_types", vocab)?,
        frame_effects: jv_str_list_to_ids(blob, "frame_effects", vocab)?,
    })
}

/// Mirror of `all_parts_from_pydict`: Scryfall's related-card list, in Scryfall's order (which is
/// meaningful for melds — the two parts, then the result).
fn jv_all_parts(d: &Value, it: &mut Interner, vocab: &mut VocabInterner) -> Result<Vec<RelatedCard>, EngineError> {
    let Some(blob) = d.get("card_compat_blob").filter(|v| v.is_object()) else {
        return Ok(Vec::new());
    };
    let Some(list) = blob.get("all_parts").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(list.len());
    for part in list {
        if !part.is_object() {
            continue;
        }
        out.push(RelatedCard {
            id: jv_opt_str(part, "id").map_or(0, |s| parse_uuid_or_hash(&s)),
            name_id: it.intern(jv_opt_str(part, "name").unwrap_or_default()),
            type_line_id: it.intern(jv_opt_str(part, "type_line").unwrap_or_default()),
            component_id: match jv_opt_str(part, "component") {
                Some(c) => vocab.intern(c)?,
                None => VOCAB_NONE,
            },
        });
    }
    Ok(out)
}

/// Mirror of `mana_cost_from_pydict`: mana_cost_jsonb is an object whose keys
/// are mana symbols and whose values are lists; a symbol's count is its list's
/// length (capped at 127), 0 for a non-list value.
fn mana_cost_from_json(
    d: &Value,
    cmc_val: Option<f32>,
    mana_vocab: &mut ManaVocabInterner,
    card_types: u16,
) -> Result<ManaCost, EngineError> {
    let mut core = 0u64;
    let mut devotion = 0u64;
    let mut hybrids: Vec<(u8, u8)> = Vec::new();
    if let Some(m) = d.get("mana_cost_jsonb").and_then(Value::as_object) {
        for (sym, v) in m.iter() {
            let count = v.as_array().map(|l| l.len().min(127) as u8).unwrap_or(0);
            match mana_lane(sym) {
                Some(lane) => {
                    core = lane_add(core, lane, count);
                    if lane < 6 {
                        devotion = lane_add(devotion, lane, count);
                    }
                }
                None => {
                    hybrids.push((mana_vocab.intern(sym)?, count));
                    for part in sym.split('/') {
                        // WUBRGC: SQL's calculate_devotion counts C too ({C/W} hybrids)
                        if let Some(lane) = mana_lane(part).filter(|&l| l < 6) {
                            devotion = lane_add(devotion, lane, count);
                        }
                    }
                }
            }
        }
    }
    hybrids.sort_unstable();
    // Nonpermanents (Instant/Sorcery) never contribute devotion, regardless of
    // their mana cost — see PERMANENT_TYPES.
    if card_types & PERMANENT_TYPES == 0 {
        devotion = 0;
    }
    Ok(ManaCost { core, hybrids, devotion, cmc: cmc_val.unwrap_or(0.0) })
}

/// Field-for-field mirror of `card_from_pydict`: same keys, same defaults,
/// same interning calls, same format_shifts registry population (via
/// `jv_legality_bits`). Any divergence between the two is a bug.
pub(crate) fn card_from_json(
    d: &Value,
    it: &mut Interner,
    vocab: &mut VocabInterner,
    artists: &mut VocabInterner,
    mana: &mut ManaVocabInterner,
) -> Result<CardRow, EngineError> {
    let released_at = jv_opt_date_str(d, "released_at").unwrap_or_default();
    let released_at_int: Option<u32> = released_at.replace('-', "").parse().ok();
    // Raw strings from the JSON object; interned to ids as the struct is built below.
    let card_name = jv_opt_str(d, "card_name").unwrap_or_default();
    let card_name_lower = InlineStr::<61>::from_str(&card_name.to_lowercase());
    // Already lowercased + accent-folded upstream (fold_accents(), #649); read as-is.
    let card_name_folded = InlineStr::<61>::from_str(&jv_opt_str(d, "card_name_folded").unwrap_or_default());
    let oracle_text = jv_opt_str(d, "oracle_text").unwrap_or_default();
    let oracle_text_lower_id = it.intern(strip_reminder_text(&oracle_text).to_lowercase());
    let oracle_full_lower_id = it.intern(oracle_text.to_lowercase());
    let flavor_text = jv_opt_str(d, "flavor_text").unwrap_or_default();
    let flavor_text_lower_id = it.intern(flavor_text.to_lowercase());
    // Lowercased into the artist vocab for search, original case into the string table for the
    // card object — see Printing.card_artist_name_id.
    let card_artist = jv_opt_str(d, "card_artist");
    let card_artist_name_id = it.intern_opt(card_artist.clone());
    // Already lowercased + accent-folded by the builder, like card_name_folded; read as-is.
    let card_artist_folded_id = it.intern_opt(jv_opt_str(d, "card_artist_folded"));
    let card_artist_vid = match &card_artist {
        Some(a) => artists.intern(a.to_lowercase())?,
        None => ARTIST_NONE,
    };
    let card_types = card_types_list_to_bits(&jv_str_list(d, "card_types"));

    Ok(CardRow {
        card_artist_name_id,
        card_artist_folded_id,
        scryfall_id: jv_opt_uuid(d, "scryfall_id"),
        oracle_id: jv_opt_uuid(d, "oracle_id"),
        illustration_id: jv_opt_uuid(d, "illustration_id"),

        card_name_lower,
        card_name_folded,
        card_name_id: it.intern(card_name),
        oracle_text_lower_id,
        oracle_full_lower_id,
        oracle_text_id: it.intern(oracle_text),
        flavor_text_lower_id,
        flavor_text_id: it.intern(flavor_text),
        card_artist_vid,
        card_set_code: InlineStr::<8>::from_str(&jv_opt_str(d, "card_set_code").unwrap_or_default()),
        card_layout_id: it.intern(jv_opt_str(d, "card_layout").unwrap_or_default()),
        // The FRONT face's `layout`, which every face of the printing shares — see
        // CardRow::card_face_layout_id. The pydict twin is `face_layout_from_pydict`.
        card_face_layout_id: it.intern_opt(jv_face_layout(d)),
        card_border_id: it.intern(jv_opt_str(d, "card_border").unwrap_or_default()),
        card_watermark_id: it.intern_opt(jv_opt_str(d, "card_watermark")),
        collector_number_id: it.intern(jv_opt_str(d, "collector_number").unwrap_or_default()),
        mana_cost_text_id: it.intern_opt(jv_opt_str(d, "mana_cost_text")),
        type_line_id: it.intern(jv_opt_str(d, "type_line").unwrap_or_default()),
        set_name_id: it.intern(jv_opt_str(d, "set_name").unwrap_or_default()),
        released_at_int,

        card_colors: jv_color_bits(d, "card_colors"),
        card_color_identity: jv_color_bits(d, "card_color_identity"),
        produced_mana: jv_color_bits(d, "produced_mana"),
        color_indicator: jv_color_bits(d, "color_indicator"),

        // Read as f32, not truncated: `mana_cost` below already asks for the same key as an
        // f32, so an integer cmc here was the only place the two disagreed. Mirrors
        // `card_from_pydict` in lib.rs, which this exists to be the non-pyo3 twin of.
        cmc: jv_opt_f32(d, "cmc"),
        creature_power: jv_opt_f32(d, "creature_power"),
        creature_toughness: jv_opt_f32(d, "creature_toughness"),
        planeswalker_loyalty: jv_opt_u8(d, "planeswalker_loyalty"),
        card_rarity_int: jv_opt_u8(d, "card_rarity_int"),
        collector_number_int: jv_opt_u16(d, "collector_number_int"),
        edhrec_rank: jv_opt_u32(d, "edhrec_rank"),
        price_usd: jv_opt_price_cents(d, "price_usd"),
        price_eur: jv_opt_price_cents(d, "price_eur"),
        price_tix: jv_opt_price_cents(d, "price_tix"),
        prefer_score: jv_opt_f32(d, "prefer_score"),
        cubecobra_score: jv_opt_f32(d, "cubecobra_score"),

        card_types,
        card_subtypes: jv_str_list_to_ids(d, "card_subtypes", vocab)?,
        card_keywords: jv_obj_to_ids(d, "card_keywords", vocab)?,
        card_keywords_printed: jv_str_list_to_ids(d, "card_keywords_printed", vocab)?,
        card_legalities: jv_legality_bits(d, "card_legalities"),
        card_oracle_tags: jv_obj_to_ids(d, "card_oracle_tags", vocab)?,
        card_art_tags: jv_obj_to_ids(d, "card_art_tags", vocab)?,
        card_is_tags: jv_obj_to_ids(d, "card_is_tags", vocab)?,
        card_frame_data: jv_obj_to_ids(d, "card_frame_data", vocab)?,

        mana_cost: mana_cost_from_json(d, jv_opt_f32(d, "cmc"), mana, card_types)?,

        creature_power_text_id: it.intern_opt(jv_opt_str(d, "creature_power_text")),
        creature_toughness_text_id: it.intern_opt(jv_opt_str(d, "creature_toughness_text")),
        planeswalker_loyalty_text_id: it.intern_opt(jv_opt_str(d, "planeswalker_loyalty_text")),

        printed_name_id: it.intern_opt(jv_opt_str(d, "printed_name")),
        printed_type_line_id: it.intern_opt(jv_opt_str(d, "printed_type_line")),
        printed_text_id: it.intern_opt(jv_opt_str(d, "printed_text")),
        // Already lowercased + accent-folded by the importer, like card_name_folded above.
        printed_name_folded_id: it.intern_opt(jv_opt_str(d, "printed_name_folded")),
        flavor_name_id: it.intern_opt(jv_opt_str(d, "flavor_name")),
        flavor_name_folded_id: it.intern_opt(jv_opt_str(d, "flavor_name_folded")),
        // Verbatim: signed strings, never lowercased or reparsed. See `OracleCard`'s pair.
        life_modifier_id: it.intern_opt(jv_opt_str(d, "life_modifier")),
        hand_modifier_id: it.intern_opt(jv_opt_str(d, "hand_modifier")),
        // An ABSENT key reads canonical, deliberately the opposite default from jv_opt_bool:
        // every pre-multilingual feed is canonical-only, so absence means "there is no annex",
        // not "this row belongs in it".
        is_canonical: d.get("is_canonical").and_then(Value::as_bool).unwrap_or(true),

        card_faces: jv_faces(d, it, artists, mana)?,
        all_parts: jv_all_parts(d, it, vocab)?,
        compat: jv_compat(d, vocab)?,
    })
}

// ─── Archive section sizing (LOCAL PATCH) ────────────────────────────────────

/// Where a finished archive's bytes go, by section.
///
/// Arithmetic over the assembled sections, taken at the one moment they are all
/// in hand and still typed — after this they are an opaque contiguous buffer
/// whose field offsets no caller can recover. Deliberately not implemented by
/// re-serialising each section: that would double the build's peak memory, and
/// this same code runs inside a 128MB isolate.
///
/// A `Vec<T>` archives as a contiguous run of `Archived<T>`, so `len *
/// size_of::<Archived<T>>()` is exact for the fixed-width sections. A
/// `Vec<String>` is a run of relative pointers plus the character bytes, so it
/// is the pointer run plus the summed lengths.
fn archive_section_stats(d: &CardData) -> StoreStats {
    let strings_bytes: usize = d.strings.iter().map(|s| s.len()).sum::<usize>()
        + d.strings.len() * std::mem::size_of::<rkyv::string::ArchivedString>();
    // `artist_vocab_collated` and the artist entity table are counted here too. The collated
    // vocab (~40KB) had been missing since the format version that added it — it is a
    // `Vec<String>` sitting beside `artist_vocab` in `CardData`, so every byte of it was archived
    // and none of it reported, and a size accounting that under-reports is the one that lets a
    // memory cap be crossed quietly.
    let artist_entity_strs: usize = d.artist_entities.forms_collated.iter().map(|s| s.len()).sum::<usize>()
        + d.artist_entities.forms_lower.iter().map(|s| s.len()).sum::<usize>();
    let vocab_bytes: usize = d.coll_vocab.iter().map(|s| s.len()).sum::<usize>()
        + d.artist_vocab.iter().map(|s| s.len()).sum::<usize>()
        + d.artist_vocab_collated.iter().map(|s| s.len()).sum::<usize>()
        + d.mana_vocab.iter().map(|s| s.len()).sum::<usize>()
        + artist_entity_strs
        + (d.coll_vocab.len()
            + d.artist_vocab.len()
            + d.artist_vocab_collated.len()
            + d.mana_vocab.len()
            + d.artist_entities.forms_collated.len()
            + d.artist_entities.forms_lower.len())
            * std::mem::size_of::<rkyv::string::ArchivedString>()
        + d.coll_vocab_sorted.len() * 2
        + d.artist_entities.form_offsets.len() * 4;
    let direct_arrays_bytes = d.offsets.len() * 4
        + d.foreign_offsets.len() * 4
        + d.indexes.printing_to_card.len() * 4
        + d.indexes.foreign_to_card.len() * 4
        + d.indexes.artwork_base.len() * 4
        + d.indexes.artwork_groups.len() * 2
        + d.indexes.artwork_group_col.len() * 2;
    StoreStats {
        card_count: d.cards.len(),
        // Canonical printings only, so the number keeps meaning what the pyo3 size() and every
        // health check reads; the annex is counted separately below.
        printing_count: d.printings.len(),
        cards_bytes: d.cards.len() * std::mem::size_of::<AOracleCard>(),
        printings_bytes: (d.printings.len() + d.foreign.len()) * std::mem::size_of::<APrinting>(),
        strings_bytes,
        vocab_bytes,
        direct_arrays_bytes,
        foreign_printing_count: d.foreign.len(),
        annex_only_oracles_dropped: 0, // the builder entry points overwrite from BuiltStore
        annex_only_rows_dropped: 0,
    }
}

// ─── Store builder ───────────────────────────────────────────────────────────

/// Counts of what a finished store contains, returned by
/// [`StoreBuilder::finish_to_writer`] for manifests and logging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreStats {
    /// Oracle cards (post-grouping).
    pub card_count: usize,
    /// Printings (the pre-grouping row count; what the pyo3 `size()` reports).
    pub printing_count: usize,
    /// LOCAL PATCH (sylvan-librarian-cloudflare): where the archive's bytes go.
    ///
    /// The store dominates every cost the Cloudflare port has — cold CPU is a
    /// near-linear function of it (~240MB/s to materialise into a wasm heap),
    /// as are the KV chunk count, the per-region cache rows, and peak isolate
    /// memory. "Shrink the store" was the one remaining lever with real
    /// headroom, and it was unactionable because nobody could say what the
    /// bytes ARE: roughly half sat in a bucket no source file could size.
    ///
    /// Computed by arithmetic over the sections rather than by re-serialising
    /// them, so it costs microseconds and adds no memory — which matters
    /// because this path also runs inside a 128MB isolate.
    ///
    /// `indexes_bytes` is the REMAINDER (archive total minus everything named),
    /// so it absorbs the index structures and any rkyv padding rather than
    /// pretending to a precision it does not have.
    pub cards_bytes: usize,
    pub printings_bytes: usize,
    pub strings_bytes: usize,
    pub vocab_bytes: usize,
    pub direct_arrays_bytes: usize,
    /// Annex (foreign) rows in the store. `printing_count` above stays canonical-only — the
    /// pyo3 size() meaning — so completeness checks over a multilingual feed must count
    /// `printing_count + foreign_printing_count` (the wasm-builder-probe aborted healthy builds
    /// until it did).
    pub foreign_printing_count: usize,
    /// Oracle groups dropped whole because NO canonical row survived the import filters (the
    /// annex-only shape — e.g. the ja 4ED ante printings whose every other printing is
    /// never-legal). See build_card_data_sorted's drop site; a small nonzero value is expected
    /// (3 on the real corpus), a LARGE one means the canonical feed went missing.
    pub annex_only_oracles_dropped: usize,
    /// Rows those drops removed, so a spilled stream's completeness check stays EXACT:
    /// `printing_count + foreign_printing_count + annex_only_rows_dropped == staged rows`.
    pub annex_only_rows_dropped: usize,
}

/// Non-python twin of the pyo3 staged-reload surface: `new()` ≙ reload_begin
/// (minus the cross-process flock, which only the mmap publish path needs),
/// `add_card()` ≙ add_batch's per-dict body, `finish_to_writer()` ≙
/// reload_commit's build + serialize — the same `build_card_data()` /
/// `write_archive()` calls, streaming into any writer instead of the
/// tmp+rename shm file.
pub struct StoreBuilder {
    rows: Vec<CardRow>,
    interner: Interner,
    vocab: VocabInterner,
    artists: VocabInterner,
    /// The corpus-wide artist-entity relation, set once by `set_artist_entities` before the build.
    /// Empty means "not supplied", which is exactly today's string-only `a:` — see
    /// `ArtistEntityIndex`.
    artist_entities: Value,
    mana: ManaVocabInterner,
}

impl StoreBuilder {
    pub fn new() -> Self {
        StoreBuilder {
            rows: Vec::new(),
            interner: Interner::new(),
            vocab: VocabInterner::new(),
            artists: VocabInterner::new(),
            artist_entities: Value::Null,
            mana: ManaVocabInterner::new(),
        }
    }

    /// The corpus-wide artist-entity relation (`transform::artist_entity_table`), which no
    /// partition build can derive from its own rows — see `ArtistEntityIndex`. Call before
    /// finishing; a build that never does keeps `a:`'s plain string behaviour.
    pub fn set_artist_entities(&mut self, table: Value) {
        self.artist_entities = table;
    }

    /// Stage one card row (one printing), parsed by [`card_from_json`].
    pub fn add_card(&mut self, card: &Value) -> Result<(), EngineError> {
        let row = card_from_json(card, &mut self.interner, &mut self.vocab, &mut self.artists, &mut self.mana)?;
        self.rows.push(row);
        Ok(())
    }

    /// Rows staged so far (printings, not oracle cards).
    pub fn staged_rows(&self) -> usize {
        self.rows.len()
    }

    /// Sort, group, index, and serialize the staged rows: header + rkyv
    /// archive into `w`, flushed. The bytes are exactly what reload_commit()
    /// writes to the shm file, so any reader path (mmap or buffer) accepts them.
    pub fn finish_to_writer<W: std::io::Write>(self, w: &mut W) -> Result<StoreStats, EngineError> {
        let StoreBuilder { rows, interner, vocab, artists, artist_entities, mana } = self;
        let built = build_card_data(rows, interner, vocab, artists, crate::artist_entity_index_from_json(Some(&artist_entities)), mana)?;
        let mut stats = archive_section_stats(&built.card_data);
        stats.annex_only_oracles_dropped = built.annex_only_oracles_dropped;
        stats.annex_only_rows_dropped = built.annex_only_rows_dropped;
        write_archive(&built.card_data, w)?;
        w.flush().map_err(|e| EngineError::runtime(format!("flush store: {e}")))?;
        Ok(stats)
    }
}

impl Default for StoreBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Spilling store builder (memory-capped build path) ───────────────────────

/// StoreBuilder variant for memory-capped environments (a 128MB Worker
/// isolate): staged rows leave process memory instead of accumulating in a
/// Vec. `add_card` returns each parsed row as an opaque encoded blob the
/// caller stores externally (Durable Object SQLite in production); at finish
/// the caller streams the blobs back in `sorted_order()` and the build
/// proceeds exactly like [`StoreBuilder::finish_to_writer`] — same grouping
/// code, same archive bytes. Only the interners and per-row sort keys stay
/// resident (~a few MB per 100k rows for the keys).
pub struct SpillingStoreBuilder {
    interner: Interner,
    vocab: VocabInterner,
    artists: VocabInterner,
    /// See `StoreBuilder::artist_entities`.
    artist_entities: Value,
    mana: ManaVocabInterner,
    /// (oracle_id, prefer_score, illustration_id, scryfall_id) per staged row,
    /// in add order — the inputs to card_row_build_order.
    keys: Vec<(u128, Option<f32>, u128, u128)>,
}

impl SpillingStoreBuilder {
    pub fn new() -> Self {
        SpillingStoreBuilder {
            interner: Interner::new(),
            vocab: VocabInterner::new(),
            artists: VocabInterner::new(),
            artist_entities: Value::Null,
            mana: ManaVocabInterner::new(),
            keys: Vec::new(),
        }
    }

    /// The corpus-wide artist-entity relation — see `StoreBuilder::set_artist_entities`.
    pub fn set_artist_entities(&mut self, table: Value) {
        self.artist_entities = table;
    }

    /// Stage one card row; returns the encoded row for external storage.
    pub fn add_card(&mut self, card: &Value) -> Result<Vec<u8>, EngineError> {
        let row = card_from_json(card, &mut self.interner, &mut self.vocab, &mut self.artists, &mut self.mana)?;
        self.keys.push((row.oracle_id, row.prefer_score, row.illustration_id, row.scryfall_id));
        Ok(encode_card_row(&row))
    }

    pub fn staged_rows(&self) -> usize {
        self.keys.len()
    }

    /// Indices into add order, sorted by the exact build order. Feed the
    /// spilled rows back to [`Self::finish_from_sorted`] in this sequence.
    /// Comparator outcomes match build_card_data's row sort bit-for-bit, so
    /// the resulting permutation is identical.
    pub fn sorted_order(&self) -> Vec<u32> {
        let mut idx: Vec<u32> = (0..self.keys.len() as u32).collect();
        idx.sort_unstable_by(|&a, &b| {
            crate::card_row_build_order(self.keys[a as usize], self.keys[b as usize])
        });
        idx
    }

    /// Consume the spilled rows (already in sorted_order) and write the
    /// archive. Bytes are identical to the Vec path's by construction: both
    /// feed the same row sequence to the same grouping/serialization code.
    pub fn finish_from_sorted<W: std::io::Write>(
        self,
        rows: impl Iterator<Item = Vec<u8>>,
        w: &mut W,
    ) -> Result<StoreStats, EngineError> {
        let SpillingStoreBuilder { interner, vocab, artists, artist_entities, mana, keys } = self;
        let expected = keys.len();
        drop(keys);
        let rows = rows.map(|bytes| decode_card_row(&bytes));
        let built =
            crate::build_card_data_sorted(
                rows,
                expected,
                interner,
                vocab,
                artists,
                crate::artist_entity_index_from_json(Some(&artist_entities)),
                mana,
            )?;
        let mut stats = archive_section_stats(&built.card_data);
        stats.annex_only_oracles_dropped = built.annex_only_oracles_dropped;
        stats.annex_only_rows_dropped = built.annex_only_rows_dropped;
        write_archive(&built.card_data, w)?;
        w.flush().map_err(|e| EngineError::runtime(format!("flush store: {e}")))?;
        Ok(stats)
    }
}

impl Default for SpillingStoreBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Partitioned build (LOCAL PATCH, Cloudflare port) ────────────────────────
// Upstream serves from Postgres and has no partition axis. The Cloudflare store is cut into N
// archives by `partition_of_oracle_id`; the native builder assigns each row here, and the
// nightly wasm import reaches the same cut through its own draft partitioning (the coordinator
// re-mods each draft's stored 64-bit hash) — both sides of that agreement are pinned by
// tests/engine/partition-hash-vectors.json.

/// What [`SpillingStoreBuilder::encode_standalone`] knows about a row without a shared interner:
/// where it belongs and where it sorts.
#[derive(Debug, Clone, Copy)]
pub struct RowMeta {
    /// The RAW fnv1a64 of the row's oracle_id — deliberately not a partition index, so the same
    /// staged blobs can be cut at any N the caller later chooses (`part_hash % N`).
    pub part_hash: u64,
    /// Byte-ascending order over these blobs IS `card_row_build_order`: oracle_id (16B BE), then
    /// `!f32_sort_bits(prefer_score or 0.0)` (4B BE — prefer descending, None ≡ 0.0, exactly the
    /// build comparator), then illustration_id and scryfall_id (16B BE each). 52 bytes, not the
    /// plan's sketched 40: the full tiebreak chain (16+4+16+16) does not fit in 40, and a
    /// truncated scryfall_id would make the spill order nondeterministic exactly where reprint
    /// sheets tie on everything else.
    pub build_sort_blob: [u8; 52],
}

impl SpillingStoreBuilder {
    /// Encode one raw engine row as a SELF-CONTAINED blob: no interner state rides along, so the
    /// blob can be replayed into any partition's own fresh builder — per-partition interning is
    /// the whole point (one global interner over the multilingual corpus is ~125MB of strings and
    /// cannot fit a 124MiB wasm build; each partition's interner holds only its own cut).
    ///
    /// An associated function, not a method, deliberately: touching `self`'s interners would be
    /// exactly the shared state the blob must not depend on. The blob is the row's compact JSON —
    /// byte-heavier than the id-based spill codec, which is the accepted trade on this NATIVE
    /// path (the nightly wasm import partitions its DRAFTS instead and never stages these; see
    /// import-coordinator.ts's partition loop).
    pub fn encode_standalone(card: &Value) -> Result<(RowMeta, Vec<u8>), EngineError> {
        let oracle_id = card
            .get("oracle_id")
            .and_then(Value::as_str)
            .ok_or_else(|| EngineError::value("row is missing oracle_id (required for partitioning)"))?;
        let mut blob_key = [0u8; 52];
        blob_key[..16].copy_from_slice(&parse_uuid_or_hash(oracle_id).to_be_bytes());
        let prefer = jv_opt_f32(card, "prefer_score").unwrap_or(0.0);
        blob_key[16..20].copy_from_slice(&(!crate::f32_sort_bits(prefer)).to_be_bytes());
        blob_key[20..36].copy_from_slice(&jv_opt_uuid(card, "illustration_id").to_be_bytes());
        blob_key[36..52].copy_from_slice(&jv_opt_uuid(card, "scryfall_id").to_be_bytes());
        let blob = serde_json::to_vec(card).map_err(|e| EngineError::runtime(format!("encode row: {e}")))?;
        Ok((
            RowMeta { part_hash: crate::fnv1a64_oracle_id(oracle_id), build_sort_blob: blob_key },
            blob,
        ))
    }
}

/// Build ONE partition's archive from its standalone blobs, through fresh interners and the same
/// build/serialize pipeline every other path uses — so a partition's archive is byte-identical
/// to what a single-partition build of the same rows would produce. Order-insensitive on this
/// native path (`build_card_data` sorts internally); `RowMeta::build_sort_blob` exists so a
/// memory-capped caller that spills blobs externally can presort them instead.
pub fn build_partition_from_standalone<W: std::io::Write>(
    blobs: impl Iterator<Item = Vec<u8>>,
    // The corpus-wide artist-entity relation (`transform::artist_entity_table`), the one input a
    // partition build cannot derive from its own rows — see `ArtistEntityIndex`. `Value::Null`
    // keeps `a:`'s plain string behaviour.
    artist_entities: Value,
    w: &mut W,
) -> Result<StoreStats, EngineError> {
    let mut builder = StoreBuilder::new();
    builder.set_artist_entities(artist_entities);
    for (i, blob) in blobs.enumerate() {
        let row: Value = serde_json::from_slice(&blob)
            .map_err(|e| EngineError::value(format!("partition blob {i}: {e}")))?;
        builder.add_card(&row)?;
    }
    builder.finish_to_writer(w)
}

// ─── CardRow spill codec ─────────────────────────────────────────────────────
//
// Little-endian, field-by-field, version-free: blobs never outlive one build
// (spilled and replayed within a single import run), so there is no
// cross-version compatibility surface. Encode and decode must mirror each
// other exactly; round-trip is asserted in tests below.

struct RowEnc(Vec<u8>);

impl RowEnc {
    fn u8v(&mut self, v: u8) { self.0.push(v); }
    fn u16v(&mut self, v: u16) { self.0.extend_from_slice(&v.to_le_bytes()); }
    fn u32v(&mut self, v: u32) { self.0.extend_from_slice(&v.to_le_bytes()); }
    fn u64v(&mut self, v: u64) { self.0.extend_from_slice(&v.to_le_bytes()); }
    fn u128v(&mut self, v: u128) { self.0.extend_from_slice(&v.to_le_bytes()); }
    fn f32v(&mut self, v: f32) { self.0.extend_from_slice(&v.to_le_bytes()); }
    fn opt<T>(&mut self, v: &Option<T>, f: impl FnOnce(&mut Self, &T)) {
        match v {
            None => self.u8v(0),
            Some(x) => {
                self.u8v(1);
                f(self, x);
            }
        }
    }
    fn str_inline(&mut self, s: &str) {
        debug_assert!(s.len() < 256);
        self.u8v(s.len() as u8);
        self.0.extend_from_slice(s.as_bytes());
    }
    fn vec_u16(&mut self, v: &[u16]) {
        self.u16v(v.len() as u16);
        for &x in v {
            self.u16v(x);
        }
    }
    fn vec_u32(&mut self, v: &[u32]) {
        self.u16v(v.len() as u16);
        for &x in v {
            self.u32v(x);
        }
    }
    /// A niched id: 0 IS the absent case, exactly as `Option<NonZeroU32>` archives it, so this
    /// costs 4 bytes rather than the tag-plus-payload 5 that `opt` would.
    fn nonzero_u32(&mut self, v: &Option<NonZeroU32>) {
        self.u32v(v.map_or(0, NonZeroU32::get));
    }
}

struct RowDec<'a> {
    buf: &'a [u8],
    at: usize,
}

impl<'a> RowDec<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.buf[self.at..self.at + n];
        self.at += n;
        s
    }
    fn u8v(&mut self) -> u8 { self.take(1)[0] }
    fn u16v(&mut self) -> u16 { u16::from_le_bytes(self.take(2).try_into().unwrap()) }
    fn u32v(&mut self) -> u32 { u32::from_le_bytes(self.take(4).try_into().unwrap()) }
    fn u64v(&mut self) -> u64 { u64::from_le_bytes(self.take(8).try_into().unwrap()) }
    fn u128v(&mut self) -> u128 { u128::from_le_bytes(self.take(16).try_into().unwrap()) }
    fn f32v(&mut self) -> f32 { f32::from_le_bytes(self.take(4).try_into().unwrap()) }
    fn opt<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> Option<T> {
        if self.u8v() == 1 { Some(f(self)) } else { None }
    }
    fn str_owned(&mut self) -> String {
        let n = self.u8v() as usize;
        String::from_utf8(self.take(n).to_vec()).expect("spill blob utf8")
    }
    fn vec_u16(&mut self) -> Vec<u16> {
        let n = self.u16v() as usize;
        (0..n).map(|_| self.u16v()).collect()
    }
    fn vec_u32(&mut self) -> Vec<u32> {
        let n = self.u16v() as usize;
        (0..n).map(|_| self.u32v()).collect()
    }
    fn nonzero_u32(&mut self) -> Option<NonZeroU32> {
        NonZeroU32::new(self.u32v())
    }
}

fn encode_card_row(r: &CardRow) -> Vec<u8> {
    let mut e = RowEnc(Vec::with_capacity(256));
    e.str_inline(r.card_name_lower.as_str());
    e.str_inline(r.card_name_folded.as_str());
    e.u8v(r.card_colors);
    e.u8v(r.card_color_identity);
    e.u8v(r.produced_mana);
    e.u8v(r.color_indicator);
    e.u16v(r.card_types);
    e.u128v(r.scryfall_id);
    e.u128v(r.oracle_id);
    e.u128v(r.illustration_id);
    e.u32v(r.card_name_id);
    e.u32v(r.oracle_text_id);
    e.u32v(r.oracle_text_lower_id);
    e.u32v(r.oracle_full_lower_id);
    e.u32v(r.flavor_text_id);
    e.u32v(r.flavor_text_lower_id);
    e.u16v(r.card_artist_vid);
    e.u32v(r.card_artist_name_id);
    e.u32v(r.card_artist_folded_id);
    e.str_inline(r.card_set_code.as_str());
    e.u32v(r.card_layout_id);
    e.u32v(r.card_face_layout_id);
    e.u32v(r.card_border_id);
    e.u32v(r.card_watermark_id);
    e.u32v(r.collector_number_id);
    e.u32v(r.mana_cost_text_id);
    e.u32v(r.type_line_id);
    e.u32v(r.set_name_id);
    e.opt(&r.released_at_int, |e, &v| e.u32v(v));
    // 4 bytes rather than 1: cmc is fractional (Scryfall types it Decimal -- {HW} is 0.5).
    // Encoder and decoder are the two halves of ONE run's spill, both from the same wasm
    // build, so the widening needs no compatibility shim -- but they must move together, and
    // the decoder's matching `f32v` is the only other place that reads these bytes.
    e.opt(&r.cmc, |e, &v| e.f32v(v));
    e.opt(&r.creature_power, |e, &v| e.f32v(v));
    e.opt(&r.creature_toughness, |e, &v| e.f32v(v));
    e.opt(&r.planeswalker_loyalty, |e, &v| e.u8v(v));
    e.opt(&r.card_rarity_int, |e, &v| e.u8v(v));
    e.opt(&r.collector_number_int, |e, &v| e.u16v(v));
    e.opt(&r.edhrec_rank, |e, &v| e.u32v(v));
    e.opt(&r.price_usd, |e, &v| e.u32v(v));
    e.opt(&r.price_eur, |e, &v| e.u32v(v));
    e.opt(&r.price_tix, |e, &v| e.u32v(v));
    e.opt(&r.prefer_score, |e, &v| e.f32v(v));
    e.opt(&r.cubecobra_score, |e, &v| e.f32v(v));
    e.vec_u16(&r.card_subtypes);
    e.vec_u16(&r.card_keywords);
    e.vec_u16(&r.card_keywords_printed);
    e.u64v(r.card_legalities);
    e.vec_u16(&r.card_oracle_tags);
    e.vec_u16(&r.card_art_tags);
    e.vec_u16(&r.card_is_tags);
    e.vec_u16(&r.card_frame_data);
    e.u64v(r.mana_cost.core);
    e.u16v(r.mana_cost.hybrids.len() as u16);
    for &(id, count) in &r.mana_cost.hybrids {
        e.u8v(id);
        e.u8v(count);
    }
    e.u64v(r.mana_cost.devotion);
    e.f32v(r.mana_cost.cmc);
    e.u32v(r.creature_power_text_id);
    e.u32v(r.creature_toughness_text_id);
    e.u32v(r.planeswalker_loyalty_text_id);
    // The printed-language columns and the canonical flag. Same exposure as the faces below:
    // no upstream twin, no compile error if forgotten — a printed field dropped here is a
    // printed field absent from every foreign card object this port serves, and a lost
    // canonical flag silently moves a printing between the two spaces.
    e.u32v(r.printed_name_id);
    e.u32v(r.printed_type_line_id);
    e.u32v(r.printed_text_id);
    e.u32v(r.printed_name_folded_id);
    e.u32v(r.flavor_name_id);
    e.u32v(r.flavor_name_folded_id);
    e.u32v(r.life_modifier_id);
    e.u32v(r.hand_modifier_id);
    e.u8v(u8::from(r.is_canonical));
    // Faces ride the spill too. This codec has no upstream twin — it exists because the Worker
    // build is alarm-chained and rows are spilled between invocations to fit a 30s alarm — so
    // nothing upstream would catch faces being dropped here. A face that does not survive the
    // spill is a face missing from every store this port builds in production.
    e.u16v(r.card_faces.len() as u16);
    for f in &r.card_faces {
        e.u32v(f.card_name_id);
        e.u32v(f.mana_cost_text_id);
        e.u32v(f.type_line_id);
        e.u32v(f.oracle_text_id);
        e.u32v(f.creature_power_text_id);
        e.u32v(f.creature_toughness_text_id);
        e.u32v(f.planeswalker_loyalty_text_id);
        e.u32v(f.defense_text_id);
        // OPTIONAL, because "no colors key" and "colors: []" are different facts about a face and
        // the spill is the only copy between two alarm invocations — collapsing them here would
        // make `c:c` match every split card in production and nowhere else.
        e.opt(&f.card_colors, |e, &v| e.u8v(v));
        e.u8v(f.color_indicator);
        // The searchable half rides the spill with the rest of the face: a face whose numbers
        // survive here and not there is a face that is printable and unsearchable in production
        // only — the exact shape this column was added to close.
        e.opt(&f.creature_power, |e, &v| e.f32v(v));
        e.opt(&f.creature_toughness, |e, &v| e.f32v(v));
        e.opt(&f.planeswalker_loyalty, |e, &v| e.u8v(v));
        e.opt(&f.mana_cost, |e, m| {
            e.u64v(m.core);
            e.u16v(m.hybrids.len() as u16);
            for &(id, count) in &m.hybrids {
                e.u8v(id);
                e.u8v(count);
            }
            e.f32v(m.cmc);
        });
        e.u128v(f.illustration_id);
        e.u16v(f.card_artist_vid);
        e.u32v(f.card_artist_name_id);
        // The face's watermark rides the spill for the same reason its artist does: the DO build
        // is alarm-chained and this is the only copy between invocations, so a value dropped here
        // is a watermark `wm:` cannot see in production and nowhere else.
        e.u32v(f.card_watermark_id);
        e.u32v(f.flavor_text_id);
        e.u32v(f.flavor_name_id);
        e.u32v(f.printed_name_id);
        e.u32v(f.printed_type_line_id);
        e.u32v(f.printed_text_id);
    }
    // The related-card list and the compat residue ride the spill for the same reason the faces
    // do, and with the same exposure: no upstream twin, no compile error if a field is forgotten,
    // and the only symptom is that field being absent from every card object this port serves.
    e.u16v(r.all_parts.len() as u16);
    for part in &r.all_parts {
        e.u128v(part.id);
        e.u32v(part.name_id);
        e.u32v(part.type_line_id);
        e.u16v(part.component_id);
    }
    e.nonzero_u32(&r.compat.arena_id);
    e.nonzero_u32(&r.compat.mtgo_id);
    e.nonzero_u32(&r.compat.mtgo_foil_id);
    e.nonzero_u32(&r.compat.tcgplayer_id);
    e.nonzero_u32(&r.compat.tcgplayer_etched_id);
    e.nonzero_u32(&r.compat.cardmarket_id);
    e.nonzero_u32(&r.compat.penny_rank);
    e.nonzero_u32(&r.compat.image_updated_at);
    e.nonzero_u32(&r.compat.price_usd_foil);
    e.nonzero_u32(&r.compat.price_usd_etched);
    e.nonzero_u32(&r.compat.price_eur_foil);
    e.u16v(r.compat.set_vid);
    e.u16v(r.compat.lang_id);
    e.u16v(r.compat.image_status_id);
    e.u16v(r.compat.set_type_id);
    e.u16v(r.compat.security_stamp_id);
    e.u8v(r.compat.games);
    e.u8v(r.compat.finishes);
    e.u16v(r.compat.flags);
    e.vec_u32(&r.compat.multiverse_ids);
    e.vec_u16(&r.compat.promo_types);
    e.vec_u16(&r.compat.frame_effects);
    e.0
}

fn decode_card_row(buf: &[u8]) -> Result<CardRow, EngineError> {
    let mut d = RowDec { buf, at: 0 };
    let row = CardRow {
        card_name_lower: InlineStr::from_str(&d.str_owned()),
        card_name_folded: InlineStr::from_str(&d.str_owned()),
        card_colors: d.u8v(),
        card_color_identity: d.u8v(),
        produced_mana: d.u8v(),
        color_indicator: d.u8v(),
        card_types: d.u16v(),
        scryfall_id: d.u128v(),
        oracle_id: d.u128v(),
        illustration_id: d.u128v(),
        card_name_id: d.u32v(),
        oracle_text_id: d.u32v(),
        oracle_text_lower_id: d.u32v(),
        oracle_full_lower_id: d.u32v(),
        flavor_text_id: d.u32v(),
        flavor_text_lower_id: d.u32v(),
        card_artist_vid: d.u16v(),
        card_artist_name_id: d.u32v(),
        card_artist_folded_id: d.u32v(),
        card_set_code: InlineStr::from_str(&d.str_owned()),
        card_layout_id: d.u32v(),
        card_face_layout_id: d.u32v(),
        card_border_id: d.u32v(),
        card_watermark_id: d.u32v(),
        collector_number_id: d.u32v(),
        mana_cost_text_id: d.u32v(),
        type_line_id: d.u32v(),
        set_name_id: d.u32v(),
        released_at_int: d.opt(|d| d.u32v()),
        cmc: d.opt(|d| d.f32v()), // 4 bytes -- see encode_card_row's note
        creature_power: d.opt(|d| d.f32v()),
        creature_toughness: d.opt(|d| d.f32v()),
        planeswalker_loyalty: d.opt(|d| d.u8v()),
        card_rarity_int: d.opt(|d| d.u8v()),
        collector_number_int: d.opt(|d| d.u16v()),
        edhrec_rank: d.opt(|d| d.u32v()),
        price_usd: d.opt(|d| d.u32v()),
        price_eur: d.opt(|d| d.u32v()),
        price_tix: d.opt(|d| d.u32v()),
        prefer_score: d.opt(|d| d.f32v()),
        cubecobra_score: d.opt(|d| d.f32v()),
        card_subtypes: d.vec_u16(),
        card_keywords: d.vec_u16(),
        card_keywords_printed: d.vec_u16(),
        card_legalities: d.u64v(),
        card_oracle_tags: d.vec_u16(),
        card_art_tags: d.vec_u16(),
        card_is_tags: d.vec_u16(),
        card_frame_data: d.vec_u16(),
        mana_cost: {
            let core = d.u64v();
            let n = d.u16v() as usize;
            let hybrids = (0..n).map(|_| (d.u8v(), d.u8v())).collect();
            let devotion = d.u64v();
            let cmc = d.f32v();
            ManaCost { core, hybrids, devotion, cmc }
        },
        creature_power_text_id: d.u32v(),
        creature_toughness_text_id: d.u32v(),
        planeswalker_loyalty_text_id: d.u32v(),
        printed_name_id: d.u32v(),
        printed_type_line_id: d.u32v(),
        printed_text_id: d.u32v(),
        printed_name_folded_id: d.u32v(),
        flavor_name_id: d.u32v(),
        flavor_name_folded_id: d.u32v(),
        life_modifier_id: d.u32v(),
        hand_modifier_id: d.u32v(),
        is_canonical: d.u8v() != 0,
        // These three must stay LAST, in this order, and in exactly the encoder's field order:
        // struct-literal initializers are evaluated top-to-bottom and each one consumes from the
        // same cursor. The length check below is what turns any drift between the two halves into
        // a loud error.
        card_faces: {
            let n = d.u16v() as usize;
            (0..n)
                .map(|_| FaceRow {
                    card_name_id: d.u32v(),
                    mana_cost_text_id: d.u32v(),
                    type_line_id: d.u32v(),
                    oracle_text_id: d.u32v(),
                    creature_power_text_id: d.u32v(),
                    creature_toughness_text_id: d.u32v(),
                    planeswalker_loyalty_text_id: d.u32v(),
                    defense_text_id: d.u32v(),
                    card_colors: d.opt(|d| d.u8v()),
                    color_indicator: d.u8v(),
                    creature_power: d.opt(|d| d.f32v()),
                    creature_toughness: d.opt(|d| d.f32v()),
                    planeswalker_loyalty: d.opt(|d| d.u8v()),
                    mana_cost: d.opt(|d| {
                        let core = d.u64v();
                        let n = d.u16v() as usize;
                        let hybrids = (0..n).map(|_| (d.u8v(), d.u8v())).collect();
                        ManaCost { core, hybrids, devotion: 0, cmc: d.f32v() }
                    }),
                    illustration_id: d.u128v(),
                    card_artist_vid: d.u16v(),
                    card_artist_name_id: d.u32v(),
                    card_watermark_id: d.u32v(),
                    flavor_text_id: d.u32v(),
                    flavor_name_id: d.u32v(),
                    printed_name_id: d.u32v(),
                    printed_type_line_id: d.u32v(),
                    printed_text_id: d.u32v(),
                })
                .collect()
        },
        all_parts: {
            let n = d.u16v() as usize;
            (0..n)
                .map(|_| RelatedCard {
                    id: d.u128v(),
                    name_id: d.u32v(),
                    type_line_id: d.u32v(),
                    component_id: d.u16v(),
                })
                .collect()
        },
        compat: CompatFields {
            arena_id: d.nonzero_u32(),
            mtgo_id: d.nonzero_u32(),
            mtgo_foil_id: d.nonzero_u32(),
            tcgplayer_id: d.nonzero_u32(),
            tcgplayer_etched_id: d.nonzero_u32(),
            cardmarket_id: d.nonzero_u32(),
            penny_rank: d.nonzero_u32(),
            image_updated_at: d.nonzero_u32(),
            price_usd_foil: d.nonzero_u32(),
            price_usd_etched: d.nonzero_u32(),
            price_eur_foil: d.nonzero_u32(),
            set_vid: d.u16v(),
            lang_id: d.u16v(),
            image_status_id: d.u16v(),
            set_type_id: d.u16v(),
            security_stamp_id: d.u16v(),
            games: d.u8v(),
            finishes: d.u8v(),
            flags: d.u16v(),
            multiverse_ids: d.vec_u32(),
            promo_types: d.vec_u16(),
            frame_effects: d.vec_u16(),
        },
    };
    if d.at != buf.len() {
        return Err(EngineError::runtime(format!(
            "spill blob length mismatch: consumed {} of {}",
            d.at,
            buf.len()
        )));
    }
    Ok(row)
}

// ─── Buffer-backed store (the wasm/no-mmap load path) ────────────────────────

/// The archive held as an owned buffer instead of an mmap. The rkyv payload
/// must be 16-aligned (the same invariant get_mmap() gets for free from
/// page-aligned mappings plus the 16-byte header): `AlignedVec`'s default
/// alignment is 16, so with the header at offset 0 the payload at
/// ARCHIVE_HEADER_LEN stays 16-aligned.
pub struct BufferStore {
    bytes: AlignedVec,
}

impl BufferStore {
    /// Take ownership of a fully assembled archive (header + payload) already
    /// sitting in an [`AlignedVec`] — the zero-extra-copy path for chunked
    /// streaming loads. Validates the header exactly like get_mmap(): an
    /// archive from a different build (or a foreign file) is rejected rather
    /// than handed to access_unchecked, which would be UB.
    pub fn from_aligned(bytes: AlignedVec) -> Result<Self, EngineError> {
        if bytes.len() < ARCHIVE_HEADER_LEN || bytes[..ARCHIVE_HEADER_LEN] != archive_header() {
            return Err(EngineError::runtime(
                "archive header mismatch (stale or foreign archive; rebuild the store with this engine version)",
            ));
        }
        let store = BufferStore { bytes };
        // Adopt the archive's legality shifts HERE, at load, rather than leaving it to the first
        // filter query. `legality_bits_to_json` decodes against the process-global FORMAT_SHIFTS
        // registry and reports an EMPTY object when it is unpopulated -- not an error -- and the
        // only other caller of sync_format_shifts is bind_and_split_filter_value, on the filter
        // path. So every route that resolves a card WITHOUT filtering (/cards/named, /cards/:id,
        // /cards/collection) answered `legalities: {}` on any isolate that had not yet served a
        // search, and /cards/* is cached for 16 hours, which pinned that empty object for the card
        // it happened to. Syncing at load makes the registry a property of having a store rather
        // than of what the isolate has been asked so far.
        sync_format_shifts(&store.data().format_shifts);
        Ok(store)
    }

    /// Copy `bytes` into a fresh aligned buffer and validate. Convenience for
    /// callers that already hold the archive contiguously (tests, the native
    /// builder's round-trip check).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, EngineError> {
        let mut buf = AlignedVec::with_capacity(bytes.len());
        buf.extend_from_slice(bytes);
        Self::from_aligned(buf)
    }

    fn data(&self) -> &Archived<CardData> {
        // Safety: same trusted-write-path argument as QueryEngine::query()'s
        // access_unchecked — the bytes come from write_archive() in this same
        // build of this crate (from_aligned/from_bytes enforced that with the
        // header equality check: magic, format version, archived struct
        // sizes), the buffer is immutable for the life of self, and the
        // payload is 16-aligned by AlignedVec's alignment plus the 16-byte
        // header offset.
        unsafe { rkyv::access_unchecked::<Archived<CardData>>(&self.bytes[ARCHIVE_HEADER_LEN..]) }
    }

    /// LOCAL PATCH (sylvan-librarian-cloudflare, benchmark support): the densest
    /// values of a collection index, with their row counts.
    ///
    /// Any question about collection-index encoding is decided by DENSITY — the
    /// storage crossover is 1/32 of the domain and the narrowing guard fires at
    /// 1/4 — so a benchmark that does not aim at values BETWEEN those two
    /// measures nothing that matters. This reports which values those actually
    /// are rather than leaving a bench to guess at tag names; it is what
    /// `memprobe tagbench` targets, and what sized the hybrid change.
    pub fn top_collection_values(&self, field: &str, n: usize) -> Vec<(String, usize)> {
        let d = self.data();
        let idx = match field {
            "oracle_tags" => &d.indexes.oracle_tags,
            "art_tags" => &d.indexes.art_tags,
            "subtypes" => &d.indexes.subtypes,
            "keywords" => &d.indexes.keywords,
            _ => return Vec::new(),
        };
        let mut all: Vec<(String, usize)> = idx
            .dense
            .iter()
            .map(|(k, v)| (k.as_str().to_owned(), u32::from(v.count) as usize))
            .chain(idx.sparse.iter().map(|(k, v)| (k.as_str().to_owned(), v.len())))
            .collect();
        all.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        all.truncate(n);
        all
    }

    /// Printing count — the same number the pyo3 `size()` reports, so health
    /// checks keep their meaning.
    pub fn size(&self) -> usize {
        self.data().printings.len()
    }

    /// Oracle-card count (post-grouping).
    pub fn card_count(&self) -> usize {
        self.data().cards.len()
    }

    /// Mirror of the pyo3 `common_card_types()`.
    pub fn common_card_types(&self) -> HashMap<String, u32> {
        count_common_types(self.data())
    }

    /// Mirror of the pyo3 `common_card_keywords()`.
    pub fn common_card_keywords(&self) -> HashMap<String, u32> {
        count_common_keywords(self.data())
    }

    /// The set codes holding at least one `is:extra` printing, sorted — the table the
    /// `include_extras` auto-enable reads. See `CardIndexes::sets_with_extras`.
    pub fn sets_with_extras(&self) -> Vec<&str> {
        self.data().indexes.sets_with_extras.iter().map(|s| s.as_str()).collect()
    }

    /// Mirror of the pyo3 `query()`: filter-tree JSON in, `(total, rows)` out,
    /// with rows rendered through JSON_FIELD_TABLE instead of PyDicts. Runs
    /// the exact same bind/split/route/execute path.
    pub fn query(&self, filter_tree_json: &str, opts: &QueryOptions) -> Result<QueryOutput, EngineError> {
        let json_val: Value = serde_json::from_str(filter_tree_json)
            .map_err(|e| EngineError::query(format!("bad query JSON: {e}")))?;
        self.query_value(&json_val, opts)
    }

    /// The shared executor dispatch: bind, detect the multilingual widening, run the right
    /// driver, and hand back the raw page. Split from [`Self::query_value`] so `query_keys` (the
    /// partitioned gather's phase 1) runs the EXACT same routing — same triggers, same drivers —
    /// and can never page differently than the query it stands in for.
    #[allow(clippy::type_complexity)]
    fn run_page<'a>(
        &'a self,
        filter_tree: &Value,
        opts: &QueryOptions,
    ) -> Result<(QueryParams, usize, Vec<(&'a AOracleCard, &'a APrinting)>, bool), EngineError> {
        let data = self.data();
        let params = QueryParams::from_strs(
            &opts.unique,
            &opts.prefer,
            &opts.orderby,
            &opts.direction,
            opts.limit,
            opts.offset,
        );
        let (plane_expr, mut filter_expr, sort_bound, unsplit) =
            super::bind_and_split_filter_value(filter_tree, &opts.unique, data, params.sort_col)?;

        // The multilingual widening: either trigger sends the query to the widened driver over
        // both printing spaces, with the FULL bound filter (`unsplit` — the widened driver has no
        // plane machinery to hand a split half to). With neither trigger, the routed driver runs
        // bit-for-bit as before and never reads the annex.
        let widened = opts.include_multilingual || unsplit.widens_to_annex();
        let (total, page) = if widened {
            run_query_widened(data, &params.with_sort_bound(sort_bound), &unsplit)
        } else {
            let ctx = QueryCtx::from(data);
            run_query_routed(
                &ctx,
                &params.with_sort_bound(sort_bound),
                &mut filter_expr,
                Some(&unsplit),
                plane_expr.as_ref(),
            )
        };
        Ok((params, total, page, widened))
    }

    /// [`Self::query`] over an already parsed filter tree.
    pub fn query_value(&self, filter_tree: &Value, opts: &QueryOptions) -> Result<QueryOutput, EngineError> {
        let resolved_fields = resolve_fields_json(opts.fields.clone())?;
        let data = self.data();
        let (_params, total, page, widened) = self.run_page(filter_tree, opts)?;
        let rows: Vec<Value> = page
            .iter()
            .map(|(c, p)| card_to_json(c, p, &data.strings, &data.coll_vocab, &resolved_fields))
            .collect();
        Ok(QueryOutput { total, rows, widened })
    }

    /// LOCAL PATCH (Cloudflare port): whether this query WOULD run the widened driver, without
    /// running it.
    ///
    /// The partitioned gather assembles its own envelope from `query_keys` replies, so it never
    /// sees a `QueryOutput` and cannot read `widened` off one. The decision is a pure function of
    /// the options and the bound filter and is identical in every partition, so the gather asks
    /// its own local store once. Binding a filter is cheap next to a nine-way fan-out.
    ///
    /// Same two triggers, same code path as `run_page` — that is the point: `/cards/search` echoes
    /// `include_multilingual` in `next_page` from this, and a second implementation in TypeScript
    /// is the drift the one-implementation rule forbids.
    pub fn query_widens(&self, filter_tree: &Value, opts: &QueryOptions) -> Result<bool, EngineError> {
        if opts.include_multilingual {
            return Ok(true);
        }
        let data = self.data();
        let params = QueryParams::from_strs(&opts.unique, &opts.prefer, &opts.orderby, &opts.direction, 1, 0);
        let (_, _, _, unsplit) =
            super::bind_and_split_filter_value(filter_tree, &opts.unique, data, params.sort_col)?;
        Ok(unsplit.widens_to_annex())
    }

    /// LOCAL PATCH (Cloudflare port): phase 1 of the partitioned two-phase gather. Runs the same
    /// executor as [`Self::query_value`] — routed or widened by the same triggers — and answers
    /// with the exact total plus the page's OPAQUE SORT KEYS and virtual printing ids instead of
    /// rows. The gather DO bytewise-merges these streams across partitions (see
    /// `encode_sort_key` for why byte order is sound across archives) and fetches only the
    /// surviving rows with [`Self::fetch_rows`]. `opts.limit`/`opts.offset` bound the keys the
    /// same way they bound a page: a partition never ships more keys than the final page could
    /// use (each partition is asked for the top `offset + limit`, offset 0, by the caller).
    ///
    /// `inline_rows` folds phase 2 into phase 1 for the rows most likely to survive the merge.
    /// The caller asks for the first `inline_rows` entries' materialized rows ALONGSIDE the keys;
    /// a page whose every row lands inside those prefixes needs no second round trip, and one that
    /// does not simply falls back to [`Self::fetch_rows`] for what is missing. The rows are
    /// byte-identical to what `fetch_rows` would return for the same vpids and fields — that is the
    /// property the differential holds this to, and the reason the two paths can be mixed inside a
    /// single page without the merged order noticing which rows came from where.
    ///
    /// Why a PREFIX and not a window: with offset 0 (the overwhelming majority of traffic) the
    /// global page is the global top `limit`, so each partition's contribution is a prefix of its
    /// own stream and `limit/N + slack` entries cover it with room to spare. At a nonzero offset a
    /// partition's contribution starts at an unknown local rank, so the caller asks for no inline
    /// rows at all rather than shipping bytes that provably cannot be used.
    pub fn query_keys(
        &self,
        filter_tree: &Value,
        opts: &QueryOptions,
        inline_rows: usize,
    ) -> Result<QueryKeysOutput, EngineError> {
        let resolved_fields = resolve_fields_json(opts.fields.clone())?;
        let data = self.data();
        let (params, total, page, _widened) = self.run_page(filter_tree, opts)?;
        let inline = inline_rows.min(page.len());
        let rows = page[..inline]
            .iter()
            .map(|(c, p)| card_to_json(c, p, &data.strings, &data.coll_vocab, &resolved_fields))
            .collect();
        let keys = page
            .into_iter()
            .map(|(c, p)| {
                let vpid = super::vpid_of_ref(data, p);
                (super::encode_sort_key(data, c, p, vpid, params.sort_col, params.descending), vpid)
            })
            .collect();
        Ok(QueryKeysOutput { total, keys, rows })
    }

    /// LOCAL PATCH (Cloudflare port): phase 2 of the partitioned two-phase gather — the rows for
    /// the virtual printing ids phase 1's merge kept, in CALLER order (the merged page order),
    /// each materialized like any other row (a foreign vpid yields the foreign printing object).
    /// An out-of-range vpid is a loud error, not a skip: the ids came from this same store's
    /// phase 1 moments ago, so a miss means the caller mixed stores or generations.
    pub fn fetch_rows(&self, vpids: &[u32], fields: Option<Vec<String>>) -> Result<Vec<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        let n_total = (data.printings.len() + data.foreign.len()) as u32;
        vpids
            .iter()
            .map(|&vpid| {
                if vpid >= n_total {
                    return Err(EngineError::value(format!(
                        "vpid {vpid} out of range ({n_total} printings across both spaces)"
                    )));
                }
                let cid = card_of_vpid(data, vpid) as usize;
                Ok(card_to_json(
                    &data.cards[cid],
                    printing_at(data, vpid),
                    &data.strings,
                    &data.coll_vocab,
                    &resolved_fields,
                ))
            })
            .collect()
    }

    /// A page of Scryfall card objects, encoded, as `<total> <row count>\n<cards JSON array>`.
    ///
    /// LOCAL ADDITION (Cloudflare port), the card-object twin of `into_total_and_rows_bytes`. The
    /// caller used to receive engine ROWS and build the card objects itself: parse the rows out of
    /// JSON, construct ~60 keys per card, re-encode. Measured, the Durable Object's CPU is very
    /// nearly a pure function of payload bytes, so that round trip — not the construction — was
    /// what a 175-card page spent its time on. Here the bytes are written once and go out as they
    /// are. See `card_object::write_scryfall_card`.
    pub fn scryfall_search_bytes(
        &self,
        filter_tree: &Value,
        opts: &QueryOptions,
        base_url: &str,
    ) -> Result<Vec<u8>, EngineError> {
        let out = self.query_value(filter_tree, opts)?;
        let mut buf = Vec::with_capacity(out.rows.len() * 3072 + 24);
        // `<total> <rows> <widened>` — the third field is new, and it is why `next_page` can echo
        // `include_multilingual` the way Scryfall does (see QueryOutput::widened).
        buf.extend_from_slice(format!("{} {} {}", out.total, out.rows.len(), u8::from(out.widened)).as_bytes());
        buf.push(b'\n');
        crate::card_object::write_scryfall_cards(&mut buf, &out.rows, base_url);
        Ok(buf)
    }

    /// Whether a filter tree is the "no filter at all" one. Spelled against the wire shape the
    /// parser emits (`{"node_type": "TrueNode"}`) rather than by binding the tree, because the
    /// point is to skip the bind.
    fn is_true_node(tree: &Value) -> bool {
        tree.get("node_type").and_then(Value::as_str) == Some("TrueNode")
    }

    /// Mirror of the pyo3 `sample_preferred()`, with the RNG seed supplied by
    /// the caller instead of drawn from OS entropy — wasm32-unknown-unknown
    /// has no ambient entropy source, so the Worker passes one in.
    ///
    /// LOCAL ADDITION (Cloudflare port): `filter_tree`. Without it this export had no way to
    /// exclude anything, so `/random_search` drew from the UNGATED corpus while both search
    /// surfaces gated — 13.6% of 1,000 draws were `is:extra` (measured on the local store,
    /// 2026-08-17). A route cannot fix that above the engine: the pool lives here.
    ///
    /// # The filtered pool is the QUERY's answer, not a second implementation of it
    ///
    /// A `Some(tree)` runs the ordinary paging path with the page opened to the whole match set,
    /// and samples the rows it returns. That is deliberately not a new evaluator: "which cards may
    /// this draw return" is then the same question, answered by the same code, as "which cards does
    /// `/search` with that query return" — `random-differential.ts` checks exactly that equality
    /// from the outside, and it could not if this walked its own candidate set.
    ///
    /// It costs one gather over this partition's cards. That is affordable BECAUSE the draw is
    /// partition-local: N=10 puts ~3,850 cards in each object, so the enumeration and its sort are
    /// a fraction of a millisecond, where the same shape over an unpartitioned 38k corpus would be
    /// the wrong trade. `None` keeps the old O(n) sampling untouched, so nothing that does not ask
    /// for a filter pays for one.
    pub fn sample_preferred(
        &self,
        n: usize,
        seed: u64,
        filter_tree: Option<&Value>,
        fields: Option<Vec<String>>,
    ) -> Result<Vec<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();

        // The pool the draw samples: every card, or the cards the filter admits. A `TrueNode` is
        // treated as no filter at all rather than run — it is what the callers send when they have
        // no query, and paging the whole corpus to rediscover "everything matches" would be the
        // one case where the filtered path is both slower and no more correct.
        let filtered: Option<Vec<(&AOracleCard, &APrinting)>> = match filter_tree {
            Some(tree) if !Self::is_true_node(tree) => {
                let opts = QueryOptions {
                    unique: "card".to_owned(),
                    prefer: "default".to_owned(),
                    orderby: "edhrec".to_owned(),
                    direction: "asc".to_owned(),
                    // The whole match set: this is the ONE caller that wants every row rather than a
                    // page, and `GatherSelect` bounds its buffer by the limit, so the limit is what
                    // opens it. `usize::MAX` would also disable the prune; the card count is the
                    // same page with a buffer the store can actually hold.
                    limit: data.cards.len(),
                    offset: 0,
                    fields: None,
                    include_multilingual: false,
                };
                let (_params, _total, page, _widened) = self.run_page(tree, &opts)?;
                Some(page)
            }
            _ => None,
        };

        let pool_len = filtered.as_ref().map_or(data.cards.len(), Vec::len);
        let take = n.min(pool_len);
        if take == 0 {
            return Ok(Vec::new());
        }

        use rand::RngExt as _;
        use rand::SeedableRng as _;
        let mut rng = rand::rngs::SmallRng::seed_from_u64(seed);
        let mut chosen = HashSet::with_capacity(take);
        while chosen.len() < take {
            chosen.insert(rng.random::<u64>() as usize % pool_len);
        }

        Ok(chosen
            .iter()
            .map(|&i| {
                let (card, printing) = match &filtered {
                    // The printing the QUERY chose, not the card's default-preferred one. They
                    // differ exactly when the filter rejects the default printing and admits
                    // another — a card whose only non-extra printing is its second is the case —
                    // and answering with the rejected printing would put an `is:extra` row in a
                    // draw that just excluded them.
                    Some(rows) => rows[i],
                    None => {
                        let card = &data.cards[i];
                        // The random pool is built from cards, so a card with no canonical printing
                        // would read an unrelated row rather than fail; see crate::preferred_vpid.
                        let preferred = crate::preferred_vpid(data, i).unwrap_or_default() as usize;
                        (card, &data.printings[preferred])
                    }
                };
                card_to_json(card, printing, &data.strings, &data.coll_vocab, &resolved_fields)
            })
            .collect())
    }

    // ─── Single-card addressing (mirrors of the #[pymethods] of the same names) ──────────────
    //
    // Upstream reaches these through pyo3 and falls back to SQL when the engine cannot answer.
    // This port has no SQL, so a None here IS the 404 — see the module comment and the README's
    // "Deviations from upstream". Every one of them runs in the Durable Object, never the isolate.

    /// Mirror of the pyo3 `card_by_scryfall_id()`. Both printing spaces: a foreign id resolves to
    /// the FOREIGN printing object, the same way `/cards/<set>/<number>/<lang>` already answers.
    pub fn card_by_scryfall_id(&self, scryfall_id: &str, fields: Option<Vec<String>>) -> Result<Option<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        let Some(vpid) = super::find_vpid_by_scryfall_id(data, parse_uuid_or_hash(scryfall_id)) else {
            return Ok(None);
        };
        let cid = card_of_vpid(data, vpid) as usize;
        Ok(Some(card_to_json(
            &data.cards[cid],
            printing_at(data, vpid),
            &data.strings,
            &data.coll_vocab,
            &resolved_fields,
        )))
    }

    /// [`Self::card_by_scryfall_id`] over many ids at once, in the order given, skipping misses.
    ///
    /// A batch rather than a loop of wasm calls: `POST /cards/collection` resolves up to 175
    /// identifiers, and crossing the JS/wasm boundary once with the whole list keeps that one
    /// serialization instead of 175.
    pub fn cards_by_scryfall_ids(
        &self,
        scryfall_ids: &[String],
        fields: Option<Vec<String>>,
    ) -> Result<Vec<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        let mut out = Vec::with_capacity(scryfall_ids.len());
        for id in scryfall_ids {
            let Some(vpid) = super::find_vpid_by_scryfall_id(data, parse_uuid_or_hash(id)) else {
                continue;
            };
            let cid = card_of_vpid(data, vpid) as usize;
            out.push(card_to_json(
                &data.cards[cid],
                printing_at(data, vpid),
                &data.strings,
                &data.coll_vocab,
                &resolved_fields,
            ));
        }
        Ok(out)
    }

    /// Mirror of the pyo3 `printings_of_oracle_id()`: every printing of one card, in stored
    /// (descending default-prefer) order, so the first is the representative printing.
    pub fn printings_of_oracle_id(
        &self,
        oracle_id: &str,
        fields: Option<Vec<String>>,
    ) -> Result<Vec<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        let Some(cid) = super::find_oracle_by_oracle_id(
            &data.indexes.oracle_by_oracle_id,
            &data.cards,
            parse_uuid_or_hash(oracle_id),
        ) else {
            return Ok(Vec::new());
        };
        let cid = cid as usize;
        let (start, end) = (u32::from(data.offsets[cid]) as usize, u32::from(data.offsets[cid + 1]) as usize);
        Ok((start..end)
            .map(|pid| {
                card_to_json(
                    &data.cards[cid],
                    &data.printings[pid],
                    &data.strings,
                    &data.coll_vocab,
                    &resolved_fields,
                )
            })
            .collect())
    }

    /// Mirror of the pyo3 `card_by_external_id()`. An unknown namespace is a query error rather
    /// than a miss, so a typo in the path reads as a bad request instead of "no such card".
    /// Both printing spaces, like `card_by_scryfall_id`: foreign printings carry their own
    /// multiverse ids, so `/cards/multiverse/<foreign>` addresses an annex row.
    pub fn card_by_external_id(
        &self,
        namespace: &str,
        external_id: u64,
        fields: Option<Vec<String>>,
    ) -> Result<Option<Value>, EngineError> {
        let ns = match namespace {
            "multiverse" => EXT_MULTIVERSE,
            "mtgo" => EXT_MTGO,
            "arena" => EXT_ARENA,
            "tcgplayer" => EXT_TCGPLAYER,
            "cardmarket" => EXT_CARDMARKET,
            other => return Err(EngineError::query(format!("unknown id namespace {other:?}"))),
        };
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        let Some(vpid) = super::find_vpid_by_external_id(data, ns, external_id) else {
            return Ok(None);
        };
        let cid = card_of_vpid(data, vpid) as usize;
        Ok(Some(card_to_json(
            &data.cards[cid],
            printing_at(data, vpid),
            &data.strings,
            &data.coll_vocab,
            &resolved_fields,
        )))
    }

    /// Mirror of the pyo3 `fuzzy_card_by_name()`: `("hit", card)`, `("ambiguous", None)` or
    /// `("miss", None)`.
    ///
    /// Ambiguous stays distinct from a miss because Scryfall reports it, and answering 404 would
    /// tell the client the card does not exist.
    pub fn fuzzy_card_by_name(
        &self,
        name: &str,
        floor: f32,
        lead: f32,
        fields: Option<Vec<String>>,
    ) -> Result<(&'static str, Option<Value>), EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        match fuzzy_name_match(data, name, floor, lead) {
            FuzzyOutcome::Miss => Ok(("miss", None)),
            FuzzyOutcome::Ambiguous => Ok(("ambiguous", None)),
            FuzzyOutcome::Hit { cid, vpid } => {
                // The card's default-preferred printing for an English hit; the matched printed
                // name's best printing for a foreign one (the FOREIGN printing object, which is
                // what Scryfall answers for "ego à deriva") — the vpid encodes which.
                Ok((
                    "hit",
                    Some(card_to_json(
                        &data.cards[cid as usize],
                        printing_at(data, vpid),
                        &data.strings,
                        &data.coll_vocab,
                        &resolved_fields,
                    )),
                ))
            }
        }
    }

    /// LOCAL PATCH (Cloudflare port): the scores-bearing fuzzy surface for the partitioned
    /// gather — the top `k` distinct (card, name) candidate classes clearing `floor`, so the
    /// gather can run the exact global FLOOR/LEAD race that `fuzzy_card_by_name` runs locally
    /// (see `crate::fuzzy_candidates` for why `{status, card}` alone forces a conservative
    /// merge). `oracle_id` is the cross-partition card identity; `vpid` is partition-local.
    pub fn fuzzy_candidates(&self, name: &str, floor: f32, k: usize) -> Vec<FuzzyCandidate> {
        crate::fuzzy_candidates(self.data(), name, floor, k)
            .into_iter()
            .map(|c| FuzzyCandidate {
                score: c.score,
                oracle_id: uuid_from_u128(c.oracle_id).map(|u| u.to_string()).unwrap_or_default(),
                vpid: c.vpid,
                folded_name: c.name,
            })
            .collect()
    }

    /// The best printing of a card the needle NAMES, optionally within one set.
    ///
    /// LOCAL ADDITION (Cloudflare port). Upstream does this in SQL and has no engine equivalent,
    /// so `/cards/named?exact=` would be the one route with nothing behind it here. The keys are
    /// `name_key_tier`'s, plus the joined name of a two-faced card and the flavor names --
    /// Scryfall resolves `exact=Delver of Secrets` to the two-faced card, and matching only the
    /// combined name would 404 it.
    ///
    /// `folded` must already be lowercased and accent-folded by the caller, the same way
    /// `card_name_folded` was at import (foldAccents in src/parser/pystr.ts); the collating is
    /// done here. A scan, for the same reason the fuzzy match is one: ~31,700 names, nothing
    /// stored, and it runs in the DO.
    pub fn exact_card_by_name(
        &self,
        folded: &str,
        set_code: Option<&str>,
        fields: Option<Vec<String>>,
    ) -> Result<Option<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        let Some((_, _, cid, vpid)) = self.name_best(folded, set_code, NameScope::Exact) else {
            return Ok(None);
        };
        Ok(Some(card_to_json(
            &data.cards[cid],
            printing_at(data, vpid),
            &data.strings,
            &data.coll_vocab,
            &resolved_fields,
        )))
    }

    /// The RANK `exact_card_by_name` answers with, without materializing the card.
    ///
    /// `(tier, prefer_score)`, higher wins, ties broken by score: tier 2 = the needle IS this
    /// card's whole name, 1 = it matches a FACE of this card, 0 = it matches a FLAVOR name.
    ///
    /// WHY THIS IS PUBLIC. With a partitioned store the scan runs once per partition, and MORE
    /// THAN ONE PARTITION CAN ANSWER: a needle is often one card's whole name and another card's
    /// face name, and those two cards hash to different partitions. The router used to take the
    /// first non-null answer in partition order, on the premise that "a folded name identifies an
    /// oracle card, and an oracle card lives in exactly one partition". That premise stopped being
    /// true when this scan learned to match faces and flavor names, and the ranking below — which
    /// is the whole reason `exact=Lightning Bolt` does not answer `Emeritus of Conflict //
    /// Lightning Bolt` — was being computed per partition and then thrown away.
    ///
    /// Measured on the ten-partition store, 2026-08-17, against api.scryfall.com:
    ///
    ///   exact=Ancestral Recall   -> Emeritus of Ideation // Ancestral Recall  (want Ancestral Recall)
    ///   exact=Brainstorm         -> Harmonized Trio // Brainstorm             (want Brainstorm)
    ///   exact=Fire               -> Start // Fire                             (want Fire // Ice)
    ///   exact=Delver of Secrets  -> Delver of Secrets // Delver of Secrets    (want ... // Insectile
    ///                                                                          Aberration; the
    ///                                                                          doubled name is a
    ///                                                                          real art_series card)
    ///
    /// The last two are the reason a bare "is it the whole name?" flag is not enough to merge on:
    /// neither candidate is a whole-name match, so the answer turns on prefer_score, which only
    /// the owning partition can compute.
    pub fn exact_name_rank(&self, folded: &str, set_code: Option<&str>) -> Option<(u8, f32)> {
        self.name_best(folded, set_code, NameScope::Exact).map(|(tier, score, _, _)| (tier, score))
    }

    /// The best printing a COLLECTION IDENTIFIER's `name` resolves to -- `POST /cards/collection`'s
    /// `{"name": ...}`, whose rule is NOT `exact=`'s -- optionally within one set.
    ///
    /// LOCAL ADDITION (Cloudflare port), like `exact_card_by_name` above it: upstream has no
    /// collection route at all. Measured against api.scryfall.com on 2026-08-31, ONE IDENTIFIER
    /// PER REQUEST -- a collection response's `data` is not in identifier order, and a batched
    /// probe silently mis-attributes its answers to the wrong needles:
    ///
    ///   {"name":"Delver of Secrets"}                   -> Delver of Secrets // Insectile Aberration
    ///   {"name":"Insectile Aberration"}                -> the same card (a BACK face names it)
    ///   {"name":"Delver of Secrets // Insectile ..."}  -> not_found   <- and `exact=` HITS it
    ///   {"name":"Fire // Ice"}, {"name":"Wear // Tear"},
    ///   {"name":"Bonecrusher Giant // Stomp"}          -> not_found, all three
    ///   {"name":"Who // What // When // Where // Why"} -> und/75 (a FIVE-part name IS a key)
    ///   {"name":"Who"}                                 -> not_found (so does `exact=Who`)
    ///   {"name":"Godzilla, King of the Monsters"}      -> not_found   <- `exact=` answers Zilortha
    ///   {"name":"limduls vault"}                       -> Lim-Dul's Vault (collated, like `!`)
    ///
    /// So a collection identifier reads `name_key_tier`'s keys and NOTHING else: the two face
    /// names when the name splits in exactly two, the whole name otherwise, never both, and never
    /// a flavor name. That difference is the whole of it -- the ranking, the set filter and the
    /// printing chosen are `exact=`'s, and every needle both surfaces accept answers the same card
    /// on both (`Lightning Bolt` msc/806, `Brainstorm` tle/155, `Titanoth Rex` iko/174, ...).
    pub fn collection_card_by_name(
        &self,
        folded: &str,
        set_code: Option<&str>,
        fields: Option<Vec<String>>,
    ) -> Result<Option<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        let Some((_, _, cid, vpid)) = self.name_best(folded, set_code, NameScope::Collection) else {
            return Ok(None);
        };
        Ok(Some(card_to_json(
            &data.cards[cid],
            printing_at(data, vpid),
            &data.strings,
            &data.coll_vocab,
            &resolved_fields,
        )))
    }

    /// `collection_card_by_name`'s rank, for the partitioned router -- the twin of
    /// `exact_name_rank`, and public for the same reason: more than one partition can answer, and
    /// the first non-null is not the best one.
    pub fn collection_name_rank(&self, folded: &str, set_code: Option<&str>) -> Option<(u8, f32)> {
        self.name_best(folded, set_code, NameScope::Collection).map(|(tier, score, _, _)| (tier, score))
    }

    /// The shared scan behind all four name entry points: `(tier, score, cid, vpid)`.
    ///
    /// `folded` is COLLATED here and compared against collated names, because that is what
    /// Scryfall compares — on `exact=` and on a collection `{"name"}` identifier alike. Measured
    /// on api.scryfall.com, 2026-08-31: `delverofsecrets`, `insectileaberration`, `lightningbolt`,
    /// `Lightning-Bolt`, `limduls vault`, `Kongming Sleeping Dragon` and `whowhatwhenwherewhy` all
    /// resolve on both surfaces, where the folded comparison this used to do answered 404 on every
    /// one of them (`!"limduls vault"` already compared collated; the two name surfaces did not).
    /// The FLAVOR pass at the bottom stays FOLDED: its index is keyed on folded names, and a
    /// collated probe of it would miss the spelling that works today.
    fn name_best(&self, folded: &str, set_code: Option<&str>, scope: NameScope) -> Option<(u8, f32, usize, u32)> {
        let needle = crate::collate_name(folded);
        let data = self.data();
        // Ranked on (whole-name match, prefer_score), in that order.
        //
        // DELIBERATE DIVERGENCE from upstream, which orders on prefer_score alone. On this corpus
        // that returns `Emeritus of Conflict // Lightning Bolt` for `exact=Lightning Bolt`,
        // because a two-faced card whose BACK face carries the name outscores the card actually
        // named that. Scryfall returns the whole-name match. Matching a face is right -- Scryfall
        // resolves `exact=Delver of Secrets` -- but it is a FALLBACK, not a peer.
        // TIER, not a bool, because the flavor-name fallback below is a third rank and the
        // partition merge has to order all three against each other with one comparison.
        let mut best: Option<(u8, f32, usize, u32)> = None;
        for cid in name_scan_candidates(data, &needle) {
            let cid = cid as usize;
            let card = &data.cards[cid];
            let Some(tier) = name_key_tier(
                crate::folded_name(card, &data.strings),
                crate::collated_name(card, &data.strings),
                &needle,
                scope,
            ) else {
                continue;
            };
            let Some((pid, score)) = self.best_printing_of(cid, set_code) else {
                continue;
            };
            if best.is_none_or(|(bt, bs, _, _)| (tier, score) > (bt, bs)) {
                best = Some((tier, score, cid, pid as u32));
            }
        }
        // EXACT NEVER READS PRINTED NAMES — verified against api.scryfall.com on 2026-08-16,
        // in every script and with and without accents:
        //
        //   exact=アクスガルドの自慢屋  (ja, Axgard Braggart)  -> 404 not_found
        //   exact=Ego à Deriva          (pt, Unmoored Ego)     -> 404 not_found
        //   exact=Ego a Deriva          (folded)               -> 404 not_found
        //   exact=Impacto               (es, Shock)            -> 404 not_found
        //
        // while `fuzzy=` resolves the same needles to the foreign printing. So the split is not
        // script- or accent-related: `exact=` is scoped to the ORACLE name and `fuzzy=` is not,
        // and a printed-name pass here would answer 200 where Scryfall answers 404 on every
        // well-formed foreign name — the opposite of parity. A printed-name record lookup was
        // written for this path and is deleted with it rather than left unreachable.
        //
        // IT DOES READ FLAVOR NAMES, which is not the same rule read loosely — it is the third
        // case, measured the same day on the same route:
        //
        //   exact=Godzilla, Primeval Champion  -> 200, Titanoth Rex prm/80925 (that printing)
        //   exact=Mechagodzilla, the Weapon    -> 200, Crystalline Giant prm/80937
        //   exact=Yojimbo                      -> 200, Solitude sld/7004
        //   exact=Titanoth Rex   (control)     -> 200, Titanoth Rex iko/174 (the oracle default)
        //   exact=Dracula, Lord of Blood       -> 404  (a FACE flavor name — face-level does not
        //                                              participate, and is not indexed here)
        //
        // A flavor name resolves to the PRINTING that carries it, not the card's default — which
        // is why this pass answers with the record's own vpid. It runs only when the oracle scan
        // found nothing, so `exact=Titanoth Rex` still answers iko/174.
        //
        // A COLLECTION IDENTIFIER READS NONE OF IT. Same route, same day, same needles:
        // `{"name":"Godzilla, King of the Monsters"}`, `{"name":"Yojimbo"}` and
        // `{"name":"Godzilla, Primeval Champion"}` are all not_found there while `exact=` answers
        // Zilortha, Solitude and Titanoth Rex — so the fallback is scoped, not shared.
        if scope == NameScope::Exact
            && best.is_none()
            && let Some(rec) = record_of_exact_name(&data.indexes.flavor_names, &data.strings, folded)
            && let Some((vpid, score)) = self.best_vpid_of_record_in(&data.indexes.flavor_names, rec, set_code)
        {
            return Some((TIER_FLAVOR_NAME, score, card_of_vpid(data, vpid) as usize, vpid));
        }
        best
    }

    /// A record's best printing passing the set filter, with its prefer score — the annex twin
    /// of `best_printing_of`. The record's vpids are stored best-prefer-first, so the first one
    /// through the filter is the answer. `idx` is `printed_names` or `flavor_names`: containment
    /// reads both, `exact=` reads only the second (see `exact_card_by_name`).
    fn best_vpid_of_record_in(
        &self,
        idx: &Archived<crate::PrintedNameIndex>,
        rec: usize,
        set_code: Option<&str>,
    ) -> Option<(u32, f32)> {
        let data = self.data();
        let pn = idx;
        let (from, to) = (u32::from(pn.offsets[rec]) as usize, u32::from(pn.offsets[rec + 1]) as usize);
        pn.vpids[from..to]
            .iter()
            .map(|v| u32::from(*v))
            .find(|&v| {
                set_code.is_none_or(|s| printing_at(data, v).card_set_code.as_str().eq_ignore_ascii_case(s))
            })
            .map(|v| (v, printing_at(data, v).prefer_score.as_ref().map_or(f32::MIN, |x| f32::from(*x))))
    }

    /// `best_vpid_of_record_in` over the printed-name index — the shape most callers want.
    fn best_vpid_of_record(&self, rec: usize, set_code: Option<&str>) -> Option<(u32, f32)> {
        self.best_vpid_of_record_in(&self.data().indexes.printed_names, rec, set_code)
    }

    /// One card per DISTINCT name whose NAMES carry every one of `words`, best printing each, up
    /// to `limit`.
    ///
    /// LOCAL ADDITION, same reasoning as `exact_card_by_name`: this is the containment stage of
    /// `/cards/named?fuzzy=`, which upstream runs as a `DISTINCT ON (card_name)` with a LIKE per
    /// word. The caller asks for 2 and reads the count: more than one distinct name is
    /// `ambiguous`, which Scryfall reports rather than guessing between.
    ///
    /// SCRYFALL'S TWO SLACKNESSES, both measured against api.scryfall.com on 2026-08-16 and both
    /// reproduced here (they are why `fuzzy=red goad` resolves at all):
    ///
    ///   1. SEPARATORS DO NOT COUNT. A word matches the name with every non-alphanumeric removed,
    ///      so it may span the name's own word boundaries: `goad` is inside `Ego à Deriva`
    ///      ("eg|o a d|eriva"), and `aust`/`com` are inside `Manicomio Infausto`.
    ///   2. THE POOL IS THE PRINTING'S NAMES, NOT ONE NAME. Each word may land in EITHER the
    ///      oracle name or that printing's printed name, independently and in any order:
    ///      `red goad` takes `red` from "Unmoo|red| Ego" and `goad` from the Portuguese
    ///      "Ego à Deriva", and `fuzzy=goad red` resolves to the same printing.
    ///
    /// The answer is the PRINTING whose names completed the match — the card's preferred printing
    /// when the oracle name alone carried every word, the best printing of the printed name that
    /// supplied the rest otherwise.
    pub fn cards_containing_all_words(
        &self,
        words: &[String],
        set_code: Option<&str>,
        limit: usize,
        fields: Option<Vec<String>>,
    ) -> Result<Vec<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        // Separators are stripped from the QUERY side once, here, so the match is a plain
        // "contains, ignoring the name's separators" per candidate (see contains_unseparated).
        let needles: Vec<String> = words.iter().map(|w| strip_separators(w)).filter(|w| !w.is_empty()).collect();
        if needles.is_empty() {
            return Ok(Vec::new());
        }
        // Two answers are distinct when they differ in BOTH card and oracle name — the fuzzy
        // lane's rule (FuzzyRace): several printings of one card are one answer, a card's own
        // printed names are too, and two cards sharing a name stay one answer. `matched` is the
        // length of the PRINTED name that completed the match, 0 for an oracle-only hit: the
        // shortest one answers, because a name that spells the query and nothing else is the match
        // the query meant (`fuzzy=ego à deriva` is contained by the Portuguese "Ego à Deriva", the
        // Spanish "Ego a la deriva" and the Italian "Ego alla Deriva" alike, and Scryfall answers
        // the Portuguese one — measured 2026-08-16). Prefer score breaks what length cannot.
        let mut answers: Vec<Answer> = Vec::new();
        // The query as ONE unseparated string, for the whole-name rank: a name that IS the query
        // ends the ambiguity question outright (see equals_unseparated). Word order matters here
        // and nowhere else in this stage — an exact name is a sequence, containment is a set.
        let whole: String = needles.concat();
        let mut exact: Option<Answer> = None;
        // A word under 3 bytes has no trigrams and narrows nothing; when no word has any, the scan
        // is the only answer.
        let narrowable: Vec<&str> = needles.iter().map(String::as_str).filter(|w| w.len() >= 3).collect();
        // THE ORACLE PASS narrows on the LONGEST word alone, and can: it answers only when the
        // oracle name carries EVERY word, so any one of them is a sound filter and the longest is
        // the most selective.
        let longest = narrowable.iter().max_by_key(|w| w.len()).copied().unwrap_or("");
        let mut cards: Vec<u32> = Vec::new();
        if narrowable.is_empty() {
            cards.extend(0..data.cards.len() as u32);
        } else {
            // ONE probe. `name_trigram` is built over the COLLATED name and `name_scan_candidates`
            // collates the needle, so a query word that spans a separator now shares windows with
            // the name that carries it — `goad` IS a window of "egoaderiva". This used to need
            // `unseparated_variants`: several hundred re-spellings of the word with separators put
            // back in, unioned, because the index windowed names as stored. Against a collated
            // index every one of those collapses to this same probe, and the union of a few
            // hundred identical answers is what took `cards_containing_all_words` from 2.6% of a
            // full scan to 6.3% (gate perf ratios, limit 3%).
            cards.extend(name_scan_candidates(data, longest));
        }
        for cid in cards {
            let cid = cid as usize;
            let name = crate::folded_name(&data.cards[cid], &data.strings);
            if !needles.iter().all(|w| contains_unseparated(name, w)) {
                continue;
            }
            let Some((vpid, score)) = self.best_printing_of(cid, set_code) else { continue };
            let answer = Answer { name, score, cid, vpid, matched: 0 };
            if equals_unseparated(name, &whole) {
                // An oracle name that IS the query. Nothing outranks it, and a second card
                // spelling the same name is the same answer either way.
                if exact.as_ref().is_none_or(|best| score > best.score) {
                    exact = Some(answer);
                }
                continue;
            }
            // One past the limit is enough to tell "one match" from "ambiguous"; the caller asks
            // for 2 and never needs the rest. The pass still RUNS to the end of its candidates
            // rather than breaking: a name that IS the query outranks ambiguity, and candidates
            // arrive in card order, not in rank order.
            Self::offer_answer(&mut answers, answer, limit);
        }
        // THE RECORD PASSES: names OTHER than the oracle name that a printing carries — its
        // printed name, and its `flavor_name`. Both indexes have the same shape and the same
        // rule, so they are one loop.
        //
        // The flavor pass is what resolves `fuzzy=godzilla primeval` (Titanoth Rex, whose flavor
        // name is "Godzilla, Primeval Champion"), `fuzzy=rex godzilla` and `fuzzy=titanoth
        // champion` — the last of which takes "titanoth" from the ORACLE name and "champion"
        // from the flavor name, which is the pooling rule below doing its job across a third
        // name. All three measured on api.scryfall.com 2026-08-16.
        //
        // Narrowed on EVERY word, unioned — unlike the oracle pass this one cannot know which
        // word the other name supplies, and the words it does not supply are the oracle name's.
        // Ambiguity here is counted by ORACLE CARD, not by string: a record whose card already
        // answered — under its oracle name or another of its printed names — is the same answer,
        // so "berserker" matching a card's ja and es names cannot fake a two-answer tie. Two
        // different CARDS are two answers, exactly like two oracle names. Skipped once the pass
        // above already proved ambiguity: the caller only reads the count past `limit`.
        for pn in [&data.indexes.printed_names, &data.indexes.flavor_names] {
            if exact.is_some() || pn.name_ids.is_empty() {
                continue;
            }
            let mut records: Vec<u32> = Vec::new();
            if narrowable.is_empty() {
                records.extend(0..pn.name_ids.len() as u32);
            } else {
                for variant in narrowable.iter().flat_map(|w| unseparated_variants(w)) {
                    match crate::trigram_candidates(&pn.trigrams, &variant) {
                        Some(ids) => records.extend(ids),
                        None => records.extend(0..pn.name_ids.len() as u32),
                    }
                }
                records.sort_unstable();
                records.dedup();
            }
            for rec in records {
                let rec = rec as usize;
                let Some(printed) = str_at(&data.strings, u32::from(pn.name_ids[rec])) else { continue };
                let Some((vpid, score)) = self.best_vpid_of_record_in(pn, rec, set_code) else { continue };
                let cid = card_of_vpid(data, vpid) as usize;
                let name = crate::folded_name(&data.cards[cid], &data.strings);
                // The printing's whole pool: this printed name OR the oracle name it prints.
                if !needles.iter().all(|w| contains_unseparated(printed, w) || contains_unseparated(name, w)) {
                    continue;
                }
                let answer = Answer { name, score, cid, vpid: vpid as usize, matched: printed.len() };
                if equals_unseparated(printed, &whole) {
                    // A printed name that IS the query — `fuzzy=egoaderiva` and `fuzzy=ego à
                    // deriva` alike. It outranks containment, but never an ORACLE name that is
                    // also the query: `exact=` is oracle-scoped and this stage keeps that order.
                    if exact.as_ref().is_none_or(|best| best.matched > 0 && score > best.score) {
                        exact = Some(answer);
                    }
                    continue;
                }
                Self::offer_answer(&mut answers, answer, limit);
            }
        }
        // A name that IS the query is THE answer, however many other names carry its letters.
        let mut by_name = match exact {
            Some(answer) => vec![answer],
            None => answers,
        };
        by_name.sort_unstable_by(|a, b| b.score.total_cmp(&a.score));
        Ok(by_name
            .into_iter()
            .take(limit)
            .map(|answer| {
                card_to_json(
                    &data.cards[answer.cid],
                    printing_at(data, answer.vpid as u32),
                    &data.strings,
                    &data.coll_vocab,
                    &resolved_fields,
                )
            })
            .collect())
    }

    /// Record one containment answer, keeping ONE per (card, oracle name) class: the shortest
    /// completing printed name, then the better prefer score. See `cards_containing_all_words`.
    fn offer_answer<'a>(answers: &mut Vec<Answer<'a>>, candidate: Answer<'a>, limit: usize) {
        match answers.iter().position(|a| a.name == candidate.name || a.cid == candidate.cid) {
            Some(at) => {
                let slot = &answers[at];
                if (candidate.matched, -candidate.score) < (slot.matched, -slot.score) {
                    answers[at] = candidate;
                }
            }
            // One past the limit is all the caller reads ("more than one" is ambiguous), so the
            // list stops growing there while the passes keep looking for a whole-name match.
            None if answers.len() <= limit => answers.push(candidate),
            None => {}
        }
    }

    /// The best printing carrying this illustration id, or None.
    ///
    /// LOCAL ADDITION (Cloudflare port). `illustration_id` is one of the identifiers Scryfall's
    /// collection endpoint accepts, and upstream answers it with a plain column predicate — but it
    /// is not a searchable field in this port's query language, so there is no filter tree that
    /// expresses it. A scan over ~95,000 printings comparing a u128, which is cheaper than the
    /// index it would otherwise need and runs in the DO.
    pub fn card_by_illustration_id(
        &self,
        illustration_id: &str,
        fields: Option<Vec<String>>,
    ) -> Result<Option<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();
        let needle = parse_uuid_or_hash(illustration_id);
        if needle == 0 {
            return Ok(None);
        }
        // Printings are stored in descending default-prefer order within each card, so the FIRST
        // match is the best printing of the first card to carry this art -- the representative
        // every other by-artwork path shows. `find_printing_by_illustration_id` preserves exactly
        // that by taking the minimum pid across the run, rather than whichever member a binary
        // search lands on; the id is not unique, unlike scryfall_id.
        //
        // This was a scan over ~95,000 printings comparing a u128 until the index existed --
        // 391 us worst of 200 sampled ids against a 49 us mean, the last by-id route without one.
        let Some(pid) = crate::find_printing_by_illustration_id(
            &data.indexes.printing_by_illustration_id,
            &data.printings,
            needle,
        ) else {
            return Ok(None);
        };
        let pid = pid as usize;
        let cid = u32::from(data.indexes.printing_to_card[pid]) as usize;
        Ok(Some(card_to_json(
            &data.cards[cid],
            &data.printings[pid],
            &data.strings,
            &data.coll_vocab,
            &resolved_fields,
        )))
    }

    /// A card's best printing and its score, optionally restricted to one set.
    ///
    /// Printings are stored in descending default-prefer order, so the first one that passes the
    /// set filter IS the best -- the same representative every other by-name path shows.
    fn best_printing_of(&self, cid: usize, set_code: Option<&str>) -> Option<(usize, f32)> {
        let data = self.data();
        let (start, end) = (u32::from(data.offsets[cid]) as usize, u32::from(data.offsets[cid + 1]) as usize);
        (start..end)
            .find(|&pid| {
                set_code.is_none_or(|s| data.printings[pid].card_set_code.as_str().eq_ignore_ascii_case(s))
            })
            .map(|pid| (pid, data.printings[pid].prefer_score.as_ref().map_or(f32::MIN, |v| f32::from(*v))))
    }

    /// Whether any CANONICAL printing of this card is one a default search would show.
    ///
    /// The card-level reading of `-is:extra`, which is the gate `/cards/search` ANDs in: a name
    /// belongs in the catalog if ANY of its printings is served, not only if all of them are. A
    /// token, an emblem, a memorabilia front-card or a playtest card has no served printing at
    /// all and drops out entirely.
    ///
    /// `None` for `extra_vid` means this store's collection vocabulary never interned the tag —
    /// a fixture, or a corpus with no extras — and then every card is servable, which is the
    /// same answer the scan would give.
    fn any_printing_is_served(&self, cid: usize, extra_vid: Option<u16>) -> bool {
        let Some(vid) = extra_vid else { return true };
        let data = self.data();
        let (start, end) = (u32::from(data.offsets[cid]) as usize, u32::from(data.offsets[cid + 1]) as usize);
        (start..end).any(|pid| !data.printings[pid].card_is_tags.iter().any(|t| u16::from(*t) == vid))
    }

    /// Scryfall's autocomplete catalog: the names a `/cards/autocomplete` client is offered, in
    /// Scryfall's own order, returning the card's PRINTED name.
    ///
    /// TWO RULES, BOTH MEASURED AGAINST api.scryfall.com, and neither of them the `ORDER BY rank,
    /// length(card_name), card_name` this used to reproduce.
    ///
    /// 1. THE ORDER IS TRIGRAM SIMILARITY, NOT LENGTH. Postgres' `pg_trgm` `similarity(a, b)` is
    ///    the size of the intersection of the two strings' trigram sets over the size of their
    ///    union, where a string's trigrams are the 3-character windows of `"  " + s + " "`. The
    ///    name is COLLATED first — spaces and punctuation removed, which is why length looked
    ///    like the rule for so long: with the separators gone and no repeated window, the
    ///    denominator is exactly the collated length. Every place plain length got it wrong is a
    ///    place one of those two terms bites:
    ///
    ///      - a REPEATED window shrinks the set. `Light Up the Night` repeats `igh`/`ght` and
    ///        sorts with the 13-letter names, ahead of the 14-letter `Lightning Angel`;
    ///        `Shapesharer` and `Shambleshark` repeat `sha` and each sort one group early.
    ///      - a name ENDING in the query's tail shares the closing `"xy "` window and scores
    ///        higher for it. For `q=ser` every one of `Serum Raker`, `Serum Powder`,
    ///        `Serene Master`, `Serra Avenger`, `Serra Redeemer` and `Serendib Sorcerer` ends in
    ///        `er` and outranks shorter names that do not; for `q=ang` the four promoted names
    ///        are the four ending in `ng`.
    ///
    ///    MEASURED: 30 prefixes fetched from api.scryfall.com (2026-08-17), 546 adjacent pairs of
    ///    Scryfall's own output. This key inverts ZERO of them. Collated length inverts 18 of the
    ///    first 375 and printed length inverts 71. Ten of the thirty prefixes were held out of the
    ///    derivation and are among the zero.
    ///
    /// 2. THE CATALOG EXCLUDES EXTRAS. `Shark` and `Shard` (tokens), `Lightning` (a memorabilia
    ///    front-card) and `Lightning Colt` (a `cmb2` playtest card) are in this corpus and not in
    ///    Scryfall's answers. Same gate `/cards/search` ANDs in, read per card — see
    ///    `any_printing_is_served`.
    ///
    /// THE RANK SPLIT SURVIVES BOTH, and is now asked of the COLLATED name. `q=gob` answers
    /// `_____ Goblin` FIRST — which collates to `goblin`, a prefix — while `q=ang` never answers
    /// `Defang` even though its similarity (0.2222) beats six of the twenty names that are there.
    /// The predicate is collated too, which is measured rather than assumed: `q=ningbolt` answers
    /// `Lightning Bolt`, and `ningbolt` is a substring of `lightningbolt` and of nothing else.
    ///
    /// WHAT IS NOT DERIVED: the order WITHIN one similarity value. Over 1,121 tie-ordered pairs,
    /// no feature of the card separates them — name, collated name, first and last release,
    /// printing count, EDHREC and penny rank, oracle id, Scryfall id, multiverse/MTGO/Arena/
    /// TCGplayer/Cardmarket id, rarity, first set, collector number, layout, type line, and the
    /// digital/booster/reprint/paper flags, each in both directions, and the lexicographic
    /// fixpoint over all 28 returns the EMPTY key. The order is stable across days (2026-08-16
    /// and 2026-08-17 agree name for name), so it is a fixed internal ordinal and not noise —
    /// the same class as the `unique=art` representative and `/sets` same-date ordering. The
    /// printed name is the tiebreak here because it is total and deterministic, and because a
    /// partitioned merge has to be able to recompute it from the names alone.
    pub fn autocomplete(&self, prefix: &str, limit: usize) -> Vec<String> {
        let data = self.data();
        // COLLATED, not merely lowered. `collate_name` is what `card_name_collated` is built with
        // and what `name_trigram` indexes, so the needle and the names are compared in one form,
        // the index narrows exactly rather than approximately, and `similarity` below is computed
        // over the same strings Scryfall's is.
        let needle = crate::collate_name(&prefix.to_lowercase());
        // The route's own "under two characters is an empty catalog" gate, re-asked of the
        // COLLATED needle — which is the only place it can be asked once collation is what the
        // names are compared in. `q=a` is an empty catalog on api.scryfall.com, and without this
        // a two-character query whose second character is punctuation would collate to one
        // letter and scan-and-score every name in the corpus that contains it.
        if needle.chars().count() < 2 {
            return Vec::new();
        }
        let mut needle_tg: Vec<[char; 3]> = Vec::with_capacity(needle.len() + 1);
        collated_trigrams(&needle, &mut needle_tg);
        let extra_vid = data.coll_vocab.iter().position(|s| s.as_str() == crate::EXTRA_IS_TAG).map(|p| p as u16);
        // (rank, |name ∩ needle|, |name|, printed name, cid). The similarity is kept as the two
        // counts rather than a float so the comparison below is exact integer arithmetic: a f32
        // ratio would make ties depend on rounding, and a tie is the ONE place this ordering
        // hands over to a tiebreak that must be reproducible in the TypeScript merge.
        let mut hits: Vec<(u8, u32, u32, &str, u32)> = Vec::new();
        let mut name_tg: Vec<[char; 3]> = Vec::with_capacity(64);
        for cid in name_scan_candidates(data, &needle) {
            let card = &data.cards[cid as usize];
            let collated = crate::collated_name(card, &data.strings);
            let rank = if collated.starts_with(&needle) {
                0u8
            } else if collated.contains(&needle) {
                1u8
            } else {
                continue;
            };
            // Scored only for a name that already matched: the trigram work is ~20 windows and a
            // membership test each, and paying it for all ~31,700 names would be 30x the cost of
            // the `contains` that rules most of them out in a few bytes.
            collated_trigrams(collated, &mut name_tg);
            let inter = name_tg.iter().filter(|t| needle_tg.contains(t)).count() as u32;
            // The PRINTED name, not the key it matched on. A catalog entry is something a client
            // hands straight back to `/cards/named?exact=`, and `lightningbolt` is not the name
            // Scryfall prints.
            let printed = str_at(&data.strings, u32::from(card.card_name_id)).unwrap_or(collated);
            hits.push((rank, inter, name_tg.len() as u32, printed, cid));
        }
        // similarity = inter / (|needle| + |name| - inter), compared as a cross-multiplied
        // rational in u64 — the counts are window counts of card names, so the products cannot
        // come close to overflowing.
        let qn = needle_tg.len() as u64;
        let union = |inter: u32, total: u32| qn + u64::from(total) - u64::from(inter);
        hits.sort_unstable_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| (u64::from(b.1) * union(a.1, a.2)).cmp(&(u64::from(a.1) * union(b.1, b.2))))
                .then_with(|| a.3.cmp(b.3))
                .then_with(|| a.4.cmp(&b.4))
        });
        let mut out: Vec<String> = Vec::with_capacity(limit.min(hits.len()));
        for (_, _, _, printed, cid) in hits {
            // Extras BEFORE the dedup, so a name printed both as a token and as a real card is
            // still offered: the token copy is skipped and the served copy supplies the entry.
            if !self.any_printing_is_served(cid as usize, extra_vid) {
                continue;
            }
            // One entry per distinct printed name: several printings of one card are one
            // suggestion, and two cards sharing a name are one suggestion too.
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
}

// ─── Query options / output ──────────────────────────────────────────────────

/// The pyo3 `query()` keyword surface as a plain struct. `Default` reproduces
/// the pyo3 signature defaults exactly.
#[derive(Debug, Clone)]
pub struct QueryOptions {
    pub unique: String,
    pub prefer: String,
    pub orderby: String,
    pub direction: String,
    pub limit: usize,
    pub offset: usize,
    pub fields: Option<Vec<String>>,
    /// Scryfall's `include_multilingual`: widen the search to the foreign-printing annex. False
    /// is Scryfall's default — English/canonical printings only. The OTHER widening trigger is a
    /// `lang:` leaf in the bound filter, detected during filter compile (FilterExpr::widens_to_annex),
    /// so the flag and the operator can never widen differently.
    pub include_multilingual: bool,
}

impl Default for QueryOptions {
    fn default() -> Self {
        QueryOptions {
            unique: "card".to_owned(),
            prefer: "default".to_owned(),
            orderby: "edhrec".to_owned(),
            direction: "asc".to_owned(),
            limit: 100,
            offset: 0,
            fields: None,
            include_multilingual: false,
        }
    }
}

impl QueryOptions {
    /// Parse a JSON options object (the wasm boundary's `opts_json`), filling
    /// any missing key with the pyo3 default. Unknown keys are rejected so a
    /// misspelled option fails loudly instead of silently applying defaults.
    pub fn from_json_str(s: &str) -> Result<Self, EngineError> {
        let v: Value = serde_json::from_str(s)
            .map_err(|e| EngineError::query(format!("bad options JSON: {e}")))?;
        let obj = v.as_object().ok_or_else(|| EngineError::query("options JSON must be an object"))?;
        let mut opts = QueryOptions::default();
        for (k, val) in obj {
            match k.as_str() {
                "unique" | "prefer" | "orderby" | "direction" => {
                    let s = val
                        .as_str()
                        .ok_or_else(|| EngineError::query(format!("option {k:?} must be a string")))?;
                    match k.as_str() {
                        "unique" => opts.unique = s.to_owned(),
                        "prefer" => opts.prefer = s.to_owned(),
                        "orderby" => opts.orderby = s.to_owned(),
                        _ => opts.direction = s.to_owned(),
                    }
                }
                "limit" | "offset" => {
                    let n = val
                        .as_u64()
                        .ok_or_else(|| EngineError::query(format!("option {k:?} must be a non-negative integer")))?;
                    if k == "limit" {
                        opts.limit = n as usize;
                    } else {
                        opts.offset = n as usize;
                    }
                }
                "include_multilingual" => {
                    opts.include_multilingual = val
                        .as_bool()
                        .ok_or_else(|| EngineError::query("option \"include_multilingual\" must be a boolean"))?;
                }
                "fields" => {
                    if val.is_null() {
                        opts.fields = None;
                    } else {
                        let arr = val
                            .as_array()
                            .ok_or_else(|| EngineError::query("option \"fields\" must be a list of strings or null"))?;
                        let fields = arr
                            .iter()
                            .map(|f| f.as_str().map(str::to_owned))
                            .collect::<Option<Vec<_>>>()
                            .ok_or_else(|| EngineError::query("option \"fields\" must be a list of strings or null"))?;
                        opts.fields = Some(fields);
                    }
                }
                _ => return Err(EngineError::query(format!("unknown query option: {k:?}"))),
            }
        }
        Ok(opts)
    }
}

/// A query result page: the total match count plus the requested page's rows
/// as JSON objects (one key per resolved field).
#[derive(Debug, Clone)]
pub struct QueryOutput {
    pub total: usize,
    pub rows: Vec<Value>,
    /// LOCAL ADDITION (Cloudflare port): whether this query ran the WIDENED driver — either
    /// `include_multilingual` was set or the bound filter carried a `lang:` leaf.
    ///
    /// It exists so `/cards/search` can echo `include_multilingual` in `next_page` the way
    /// Scryfall does: a `lang:` in `q` alone makes Scryfall's echo say `true`. The route cannot
    /// work that out for itself without re-implementing the lang-leaf detection in TypeScript,
    /// which is the drift this engine's one-implementation rule exists to prevent — so the engine
    /// hands back the answer it already computed to choose a driver.
    pub widened: bool,
}

/// LOCAL PATCH (Cloudflare port): one cross-partition fuzzy candidate — the best score of a
/// distinct (card, name) class. `oracle_id` is the canonical hyphenated uuid string ("" for the
/// unset id), the identity the global race's "same card never competes with itself" rule keys on.
#[derive(Debug, Clone)]
pub struct FuzzyCandidate {
    pub score: f32,
    pub oracle_id: String,
    pub vpid: u32,
    pub folded_name: String,
}

/// LOCAL PATCH (Cloudflare port): [`BufferStore::query_keys`]'s answer — the exact total plus
/// the page's opaque sort keys, each paired with the virtual printing id [`BufferStore::fetch_rows`]
/// resolves. Keys are byte-comparable within and ACROSS partitions (see `encode_sort_key`), and
/// every key leads with `SORT_KEY_VERSION` — a merge must refuse mixed versions.
#[derive(Debug, Clone)]
pub struct QueryKeysOutput {
    pub total: usize,
    pub keys: Vec<(Vec<u8>, u32)>,
    /// The materialized rows for the first `rows.len()` entries of `keys`, in the same order —
    /// phase 2 folded into phase 1 (see [`BufferStore::query_keys`]). Empty when the caller asked
    /// for none. Always a PREFIX of `keys`, so an entry's row is at the same index as its key.
    pub rows: Vec<Value>,
}

impl QueryOutput {
    /// `{"total": .., "rows": [..]}` — the wire shape the wasm boundary returns.
    pub fn to_json(&self) -> Value {
        let mut m = Map::with_capacity(2);
        m.insert("total".to_owned(), Value::from(self.total as u64));
        m.insert("rows".to_owned(), Value::Array(self.rows.clone()));
        Value::Object(m)
    }

    /// `<total> <row count>\n<rows as a JSON array>`, as bytes — the same answer, without the
    /// round trip and without ever becoming a JS string.
    ///
    /// LOCAL ADDITION (Cloudflare port). `to_json` above exists to be re-serialized and then
    /// PARSED BACK by the Durable Object, which reads `total` and hands `rows` on to be encoded
    /// again — so the same bytes are built, decoded, parsed and re-encoded before anything looks
    /// at them. Measured against the live deployment, the DO's CPU is very nearly a pure function
    /// of payload size (~29us per KB across a 17x range, 67KB->1134KB), so those extra passes are
    /// most of what a large result costs; the row construction underneath is ~16us per CARD.
    ///
    /// This hands back the rows already encoded, so the DO can splice the string into its envelope
    /// and never materialize a card. Two costs go away rather than one:
    ///
    ///   - the `self.rows.clone()` in `to_json`, a deep clone of the whole tree, which that method
    ///     needs only because it borrows and its one caller drops `self` immediately after;
    ///   - the wrapper object, so the two numbers ride as a decimal prefix instead of forcing the
    ///     reader to parse an object to reach them.
    ///
    /// The row count is in the prefix because the caller needs it (`has_more` is derived from it)
    /// and it is `rows.len()` here — where recovering it downstream would mean counting objects in
    /// an encoded array, which is exactly the walk over the whole payload this avoids.
    ///
    /// A newline separator rather than JSON because the point is that the reader does not parse:
    /// the prefix ends at the first `\n` and the rows are the rest. Neither a newline nor a space
    /// can appear in the prefix, and serde_json escapes any newline inside the rows.
    ///
    /// BYTES, not a `String`, and that is the whole point on this path. A `String` return would
    /// make wasm-bindgen `TextDecoder.decode` the payload into a UTF-16 JS string, and the
    /// Durable Object RPC would then UTF-8 encode it straight back — two full passes over a
    /// megabyte to hand back the bytes written here. The isolate's metered CPU pays for both.
    /// These bytes reach the response body as they are.
    pub fn into_total_and_rows_bytes(self) -> Result<Vec<u8>, serde_json::Error> {
        // Serialized straight into the prefixed buffer: `to_string` then concatenation would copy
        // the whole payload a second time, which is the cost this method exists to avoid.
        let mut buf = Vec::with_capacity(self.rows.len() * 512 + 24);
        buf.extend_from_slice(format!("{} {}", self.total, self.rows.len()).as_bytes());
        buf.push(b'\n');
        serde_json::to_writer(&mut buf, &self.rows)?;
        Ok(buf)
    }
}

// ─── JSON result field selection (mirror of FIELD_TABLE) ─────────────────────

type JsonFieldExtractor = fn(&AOracleCard, &APrinting, &AStrings, &AStrings) -> Value;

fn opt_str_value(s: Option<&str>) -> Value {
    match s {
        Some(s) => Value::String(s.to_owned()),
        None => Value::Null,
    }
}

fn uuid_value(v: u128) -> Value {
    // The pyo3 table returns uuid.UUID objects; JSON's equivalent is the
    // canonical hyphenated lowercase string (what Scryfall's API itself ships).
    match uuid_from_u128(v) {
        Some(u) => Value::String(u.to_string()),
        None => Value::Null,
    }
}

fn str_vec_value(items: Vec<&str>) -> Value {
    Value::Array(items.into_iter().map(|s| Value::String(s.to_owned())).collect())
}

/// Entry-for-entry mirror of FIELD_TABLE: same names, same source fields, same
/// ordering/sorting behavior, values rendered as JSON instead of Python
/// objects. Absent optionals are `null`.
const JSON_FIELD_TABLE: &[(&str, JsonFieldExtractor)] = &[
    // The card's name, or — on the 81 printings whose faces are not their card's — the joined
    // name THIS printing prints: "Temple Garden // Temple Garden" against the card's "Temple
    // Garden". See OracleCard::divergent.
    ("name", |c, p, s, _v| {
        let id = crate::divergent_of(c, p).map_or(u32::from(c.card_name_id), |d| u32::from(d.card_name_id));
        opt_str_value(str_at(s, id))
    }),
    ("set_code", |_c, p, _s, _v| Value::String(p.card_set_code.as_str().to_owned())),
    ("collector_number", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.collector_number_id)))),
    ("power", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.creature_power_text_id)))),
    ("toughness", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.creature_toughness_text_id)))),
    ("loyalty", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.planeswalker_loyalty_text_id)))),
    ("mana_cost", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.mana_cost_text_id)))),
    ("oracle_text", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.oracle_text_id)))),
    ("set_name", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.set_name_id)))),
    ("type_line", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.type_line_id)))),
    ("illustration_id", |_c, p, _s, _v| uuid_value(u128::from(p.illustration_id))),
    ("scryfall_id", |_c, p, _s, _v| uuid_value(u128::from(p.scryfall_id))),
    // Exact f64 dollars from the stored integer cents — see FIELD_TABLE's note.
    ("price_usd", |_c, p, _s, _v| {
        p.price_usd
            .as_ref()
            .map(|v| Value::from(f64::from(u32::from(*v)) / 100.0))
            .unwrap_or(Value::Null)
    }),
    ("price_eur", |_c, p, _s, _v| {
        p.price_eur
            .as_ref()
            .map(|v| Value::from(f64::from(u32::from(*v)) / 100.0))
            .unwrap_or(Value::Null)
    }),
    ("price_tix", |_c, p, _s, _v| {
        p.price_tix
            .as_ref()
            .map(|v| Value::from(f64::from(u32::from(*v)) / 100.0))
            .unwrap_or(Value::Null)
    }),
    ("prefer_score", |_c, p, _s, _v| {
        p.prefer_score.as_ref().map(|v| Value::from(f32::from(*v))).unwrap_or(Value::Null)
    }),
    // card_subtypes preserves the printed order; the set-like collections get
    // re-sorted lexicographically for deterministic output (same as FIELD_TABLE).
    ("card_subtypes", |c, _p, _s, v| {
        str_vec_value(c.card_subtypes.iter().map(|id| coll_str(v, u16::from(*id))).collect())
    }),
    // Scryfall's casing, in Scryfall's order — the folded, sorted `card_keywords` is the SEARCH
    // form and never reaches a card object. Empty printed list falls back to it so a hand-built
    // row (tests, benches) without the printed key still renders its keywords.
    ("card_keywords", |c, _p, _s, v| {
        if c.card_keywords_printed.is_empty() {
            str_vec_value(sorted_strs(v, &c.card_keywords))
        } else {
            str_vec_value(c.card_keywords_printed.iter().map(|id| coll_str(v, u16::from(*id))).collect())
        }
    }),
    ("card_oracle_tags", |c, _p, _s, v| str_vec_value(sorted_strs(v, &c.card_oracle_tags))),
    ("card_art_tags", |_c, p, _s, v| str_vec_value(sorted_strs(v, &p.card_art_tags))),
    ("card_is_tags", |_c, p, _s, v| str_vec_value(sorted_strs(v, &p.card_is_tags))),
    ("card_frame_data", |_c, p, _s, v| str_vec_value(sorted_strs(v, &p.card_frame_data))),
    // Card-data fields in Scryfall's own shapes (upstream #877). FIELD_TABLE is pyo3-gated and not
    // compiled here, so its five new entries would merge clean, build clean, and do nothing —
    // `fields=layout` would 400 as an unknown field. These are their live twins.
    // Off the PRINTING since gen 30 — see the FIELD_TABLE twin in lib.rs. This is the LIVE table
    // (the pyo3 one above it is not compiled here), so this is the entry `card_object.rs` reads
    // `layout` from when it decides TWO_IMAGE_LAYOUTS and EDHREC_JOINED_LAYOUTS.
    ("layout", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.card_layout_id)))),
    // Through `f32::from` because the archived scalar is an endian wrapper, and out as a JSON
    // number that keeps its fraction: this is the value card_object.rs writes as the decimal
    // `"cmc"` Scryfall answers with.
    ("cmc", |c, _p, _s, _v| c.cmc.as_ref().copied().map(|v| Value::from(f32::from(v))).unwrap_or(Value::Null)),
    ("rarity", |_c, p, _s, _v| {
        p.card_rarity_int
            .as_ref()
            .copied()
            .and_then(|v| rarity_int_to_text(v))
            .map(Value::from)
            .unwrap_or(Value::Null)
    }),
    ("color_identity", |c, _p, _s, _v| str_vec_value(identity_letters(c.card_color_identity))),
    // Scryfall's `produced_mana`, which the store has always held (the `produces:` filter reads
    // the same byte) and no field table ever emitted — so every land this port served was missing
    // a key Scryfall sends. Omitted, not nulled, when the card produces nothing: Value::Null goes
    // through the writers' absent path.
    ("color_indicator", |c, _p, _s, _v| {
        if c.color_indicator == 0 { Value::Null } else { str_vec_value(identity_letters(c.color_indicator)) }
    }),
    ("produced_mana", |c, _p, _s, _v| {
        if c.produced_mana == 0 { Value::Null } else { str_vec_value(identity_letters(c.produced_mana)) }
    }),
    ("legalities", |c, p, _s, _v| {
        // Printing-level word only for the ~556 divergence cards, the same rule the filters use.
        let bits = if c.legality_divergent { u64::from(p.card_legalities) } else { u64::from(c.card_legalities) };
        legality_bits_to_json(bits)
    }),
    // ── The rest of a Scryfall card object that the SEARCH archive still holds (upstream #912) ──
    // Same standing note as #877's five above: FIELD_TABLE is pyo3-gated and compiles to nothing
    // in this port, so these hand-written twins are the live table. The residue fields are NOT
    // here — they moved to JSON_COMPAT_FIELD_TABLE below with the second archive.
    ("card_faces", |c, p, s, _v| faces_to_json(c, p, s)),
    ("colors", |c, _p, _s, _v| str_vec_value(identity_letters(c.card_colors))),
    // See FIELD_TABLE's note: upstream emits `border_color: null` on every engine-served card and
    // omits `frame`, because neither had an accessor. Scryfall always sends both.
    ("border_color", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.card_border_id)))),
    ("frame", |_c, p, _s, v| opt_str_value(frame_of(p, v))),
    ("oracle_id", |c, _p, _s, _v| uuid_value(u128::from(c.oracle_id))),
    ("flavor_text", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.flavor_text_id)))),
    // The ORIGINAL-CASE string, from its own interned id. Resolving `card_artist_vid` here served
    // garbage twice over — the vid indexes the ARTIST vocab, not the collection vocab this arm was
    // reading ("fumes" for Franz Vohwinkel in production), and even the right vocab holds only the
    // lowercased search form. Fixture parity could never catch the cross-vocab half: both twins
    // read the same row JSON, so they agreed on the scrambled value — the live-parity harness
    // against api.scryfall.com is the guard that did.
    ("artist", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.card_artist_name_id)))),
    ("watermark", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.card_watermark_id)))),
    ("edhrec_rank", |c, _p, _s, _v| {
        c.edhrec_rank.as_ref().copied().map(|v| Value::from(u32::from(v))).unwrap_or(Value::Null)
    }),
    ("released_at", |_c, p, _s, _v| {
        p.released_at_int
            .as_ref()
            .copied()
            .map(|v| Value::String(released_int_to_iso(u32::from(v))))
            .unwrap_or(Value::Null)
    }),
    // ── The compat residue (upstream #912), read off `Printing.compat` / `OracleCard.all_parts`
    // exactly as upstream's FIELD_TABLE reads them. `null` is how "Scryfall omitted this key"
    // travels; `toScryfallCard` on the TypeScript side drops null-valued keys rather than
    // emitting them, which is what keeps a reconstructed object shaped like Scryfall's instead
    // of sprouting nulls Scryfall never sent.
    ("lang", |_c, p, _s, v| opt_str_value(coll_str_opt(v, u16::from(p.compat.lang_id)))),
    // The printing's printed-language text (top-level; the per-face halves ride card_faces).
    // `null` = Scryfall omitted the key, same absence rule as every field in this block.
    ("printed_name", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.printed_name_id)))),
    // Scryfall's `flavor_name`: the alternate name a printing is sold under. Its key position is
    // "immediately before `lang`" on every one of the 669 top-level occurrences in the 2026-08-16
    // all_cards bulk, which is `name -> flavor_name -> lang` when there is no printed name and
    // `name -> printed_name -> flavor_name -> lang` when there is. The face-level variant rides
    // the face objects instead; the two never appear on one printing.
    ("flavor_name", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.flavor_name_id)))),
    ("printed_type_line", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.printed_type_line_id)))),
    ("printed_text", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.printed_text_id)))),
    // Vanguard's two starting-total deltas — off the CARD, unlike every printed_* above, because
    // that is where they are stored (see `OracleCard::life_modifier_id`). `null` = key absent,
    // which is the answer for all but 107 cards.
    ("life_modifier", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.life_modifier_id)))),
    ("hand_modifier", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.hand_modifier_id)))),
    ("image_status", |_c, p, _s, v| opt_str_value(coll_str_opt(v, u16::from(p.compat.image_status_id)))),
    ("set_type", |_c, p, _s, v| opt_str_value(coll_str_opt(v, u16::from(p.compat.set_type_id)))),
    ("security_stamp", |_c, p, _s, v| opt_str_value(coll_str_opt(v, u16::from(p.compat.security_stamp_id)))),
    ("set_id", |_c, p, _s, v| opt_str_value(coll_str_opt(v, u16::from(p.compat.set_vid)))),
    ("arena_id", |_c, p, _s, _v| opt_u32_value(p.compat.arena_id.as_ref().map(|v| v.get()))),
    ("mtgo_id", |_c, p, _s, _v| opt_u32_value(p.compat.mtgo_id.as_ref().map(|v| v.get()))),
    ("mtgo_foil_id", |_c, p, _s, _v| opt_u32_value(p.compat.mtgo_foil_id.as_ref().map(|v| v.get()))),
    ("tcgplayer_id", |_c, p, _s, _v| opt_u32_value(p.compat.tcgplayer_id.as_ref().map(|v| v.get()))),
    ("tcgplayer_etched_id", |_c, p, _s, _v| opt_u32_value(p.compat.tcgplayer_etched_id.as_ref().map(|v| v.get()))),
    ("cardmarket_id", |_c, p, _s, _v| opt_u32_value(p.compat.cardmarket_id.as_ref().map(|v| v.get()))),
    ("penny_rank", |_c, p, _s, _v| opt_u32_value(p.compat.penny_rank.as_ref().map(|v| v.get()))),
    ("image_updated_at", |_c, p, _s, _v| opt_u32_value(p.compat.image_updated_at.as_ref().map(|v| v.get()))),
    // Dollars from integer cents, the same conversion price_usd uses.
    ("price_usd_foil", |_c, p, _s, _v| opt_cents_value(p.compat.price_usd_foil.as_ref().map(|v| v.get()))),
    ("price_usd_etched", |_c, p, _s, _v| opt_cents_value(p.compat.price_usd_etched.as_ref().map(|v| v.get()))),
    ("price_eur_foil", |_c, p, _s, _v| opt_cents_value(p.compat.price_eur_foil.as_ref().map(|v| v.get()))),
    ("multiverse_ids", |_c, p, _s, _v| {
        Value::Array(p.compat.multiverse_ids.iter().map(|v| Value::from(u32::from(*v))).collect())
    }),
    // In STORED order, which is the payload's: the ingest reads both with jv_str_list_to_ids, so
    // the order was there all along and only the emission was throwing it away. Scryfall serves
    // `["showcase","legendary"]` and `["universesbeyond","ffv"]`, neither of them alphabetical.
    ("promo_types", |_c, p, _s, v| {
        str_vec_value(p.compat.promo_types.iter().map(|id| coll_str(v, u16::from(*id))).collect())
    }),
    ("frame_effects", |_c, p, _s, v| {
        str_vec_value(p.compat.frame_effects.iter().map(|id| coll_str(v, u16::from(*id))).collect())
    }),
    // Scryfall's own order, not a fixed one -- the byte carries the permutation (see GAME_ORDERS).
    ("games", |_c, p, _s, _v| str_vec_value(games_to_names(p.compat.games))),
    ("finishes", |_c, p, _s, _v| str_vec_value(bits_to_names(p.compat.finishes, FINISH_NAMES))),
    ("booster", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_BOOSTER))),
    ("digital", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_DIGITAL))),
    ("foil", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_FOIL))),
    ("nonfoil", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_NONFOIL))),
    ("full_art", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_FULL_ART))),
    ("highres_image", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_HIGHRES_IMAGE))),
    ("oversized", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_OVERSIZED))),
    ("promo", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_PROMO))),
    ("reprint", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_REPRINT))),
    ("story_spotlight", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_STORY_SPOTLIGHT))),
    ("textless", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_TEXTLESS))),
    ("variation", |_c, p, _s, _v| Value::from(compat_flag(&p.compat, COMPAT_VARIATION))),
    // Off the PRINTING, not the card: Scryfall's related-card list varies by printing (see the
    // field's note on `Printing`), so every printing answers with its own or with none.
    ("all_parts", |_c, p, s, v| {
        Value::Array(
            p.all_parts
                .iter()
                .map(|part| {
                    let mut m = Map::with_capacity(5);
                    m.insert("object".to_owned(), Value::from("related_card"));
                    m.insert("id".to_owned(), uuid_value(u128::from(part.id)));
                    m.insert("component".to_owned(), opt_str_value(coll_str_opt(v, u16::from(part.component_id))));
                    m.insert("name".to_owned(), opt_str_value(str_at(s, u32::from(part.name_id))));
                    m.insert("type_line".to_owned(), opt_str_value(str_at(s, u32::from(part.type_line_id))));
                    Value::Object(m)
                })
                .collect(),
        )
    }),
];

/// A niched optional id as JSON. The residue stores the eleven sparse ids as `Option<NonZeroU32>`
/// so rkyv can put the None in the value itself; absent is `null` here, never `0`.
fn opt_u32_value(v: Option<u32>) -> Value {
    v.map(Value::from).unwrap_or(Value::Null)
}

/// Dollars from the stored integer cents, or `null` — the same conversion `price_usd` uses.
fn opt_cents_value(v: Option<u32>) -> Value {
    v.map(|c| Value::from(f64::from(c) / 100.0)).unwrap_or(Value::Null)
}

/// Upstream's `exact=` predicate: the whole folded name, or either half of a `Front // Back` one.
/// Card ids worth examining for a folded-name predicate, narrowed by `name_trigram` when it can be.
///
/// LOCAL ADDITION (Cloudflare port). Every `/cards/named` route scanned all ~31,700 cards doing
/// string work, while `name:` in the query language answered the same question through this index
/// in a tenth the time — measured, `exact_card_by_name` 1,090 us against `name:ward` at 75 us.
/// The index was right there; these routes predate the habit of reaching for it.
///
/// SOUND for `exact=`, whose needle is a CONTIGUOUS SUBSTRING of the stored folded name by
/// construction — `name_key_tier` accepts the whole collated name, or one collated side of a
/// " // " split, and the collated name IS the two collated sides concatenated — so a matching name
/// contains every trigram of the needle and cannot be outside the intersection.
///
/// The containment stage matches with the name's SEPARATORS IGNORED, which is weaker than
/// contiguous, so this index cannot decide that question alone: `cards_containing_all_words` unions
/// this over every word and states the recall edge that leaves. The callers still re-verify; this
/// only decides who gets asked.
///
/// `None` from `trigram_candidates` means the needle is under 3 bytes, where the index has nothing
/// to say and the full scan is the only answer.
///
/// The needle is COLLATED before it is looked up, because the index is built over
/// `card_name_collated`: a folded needle that kept its spaces ("of the") has no window in common
/// with the collated names and would narrow to nothing. Collating only ever WIDENS the candidate
/// set relative to the folded question the callers ask — deleting the same character class from
/// both sides preserves containment — so every caller's own verification still decides.
fn name_scan_candidates(data: &Archived<CardData>, needle: &str) -> Vec<u32> {
    let idx = &data.indexes.name_trigram;
    // APPLICABILITY CHECK, the same shape every other index gets (`sort_perms::order` length-checks
    // its arrays, the planes compare `n_cards`). Narrowing through an index that was never built --
    // or was built for a different card count -- would return NO candidates where the scan found
    // matches, turning a stale index into silently wrong answers instead of slow ones. A fixture
    // store that skips index construction is exactly that case.
    if u32::from(idx.domain) as usize != data.cards.len() {
        return (0..data.cards.len() as u32).collect();
    }
    let collated = crate::collate_name(needle);
    if collated.is_empty() {
        return (0..data.cards.len() as u32).collect();
    }
    crate::trigram_candidates(idx, &collated).unwrap_or_else(|| (0..data.cards.len() as u32).collect())
}

/// The distinct trigrams of an already-collated string, as `pg_trgm` forms them.
///
/// Postgres pads a word with TWO leading spaces and one trailing space and takes every
/// 3-character window of the result, so `"bolt"` yields `"  b"`, `" bo"`, `"bol"`, `"olt"`,
/// `"lt "` — five windows for four characters, and the two that carry the word's edges are what
/// make a prefix and a suffix score differently from a middle. `similarity(a, b)` is then
/// `|A ∩ B| / |A ∪ B|` over these sets, which is the ordering `autocomplete` reproduces.
///
/// DISTINCT, and that is load-bearing rather than an optimization: a repeated window is one
/// member of a set, so `Light Up the Night` (`igh` and `ght` twice) has the trigram count of a
/// name two characters shorter and sorts as one. `Vec` and a linear scan rather than a `HashSet`
/// because a card name is ~20 windows, where hashing costs more than the comparisons it saves;
/// the buffer is reused across the whole scan.
///
/// CHARS, not bytes. The collated name keeps every alphanumeric the fold left behind, and a
/// window that split a multi-byte character would compare against a needle that did not.
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

/// A query word with every non-alphanumeric character removed — the form the containment stage
/// matches with (see `cards_containing_all_words`). Apostrophes ride along: `yawgmoth's` becomes
/// `yawgmoths`, which is what "Yawgmoth's Will" reads as with ITS separators gone.
fn strip_separators(word: &str) -> String {
    word.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// One containment answer: the printing that carries it, and what completed the match.
///
/// `matched` is the length of the PRINTED name that supplied the words the oracle name could not,
/// and 0 when the oracle name carried all of them — the rank that decides which of a card's
/// printings answers (see `cards_containing_all_words`).
struct Answer<'a> {
    name: &'a str,
    score: f32,
    cid: usize,
    vpid: usize,
    matched: usize,
}

/// The separator runs a folded name can spell BETWEEN two of a query word's characters. Space
/// covers nearly everything; the rest are what the corpus actually puts inside a name — an
/// apostrophe ("Yawgmoth's Will"), a hyphen ("Ley-Line"), and comma-space ("Yawgmoth, Thran
/// Physician"), which is the only multi-byte run that occurs often enough to matter.
const NAME_SEPARATORS: [&str; 4] = [" ", "'", "-", ", "];

/// How the corpus could have SPELLED `word`, for narrowing: the word itself, then the word with
/// one or two separator runs inserted between its characters.
///
/// The trigram index windows names AS STORED, so a word that spans a separator shares no window
/// with the name that carries it — `goad` has no window in common with "ego a deriva". Every
/// variant here is an ordinary contiguous probe, and their union covers every occurrence with up
/// to two separator runs inside the word: `lightningbolt` finds "lightning bolt" and `egoaderiva`
/// finds "ego a deriva". A variant the corpus never spells dies on its first window lookup, which
/// is what keeps a few hundred probes cheap.
///
/// KNOWN EDGE: three or more separator runs inside ONE query word is not enumerated (a four-word
/// name typed as a single token). Two is where the observed Scryfall answers stop, and the count
/// grows quadratically in the word's length — so the k=2 tier is also capped at
/// `TWO_SEPARATOR_MAX_LEN`, past which a word long enough to need it identifies its card by its
/// contiguous half anyway.
fn unseparated_variants(word: &str) -> Vec<String> {
    /// Past this, only the one-separator tier is enumerated (see above).
    const TWO_SEPARATOR_MAX_LEN: usize = 20;
    let chars: Vec<&str> = word.char_indices().map(|(i, c)| &word[i..i + c.len_utf8()]).collect();
    let mut out = vec![word.to_owned()];
    for first in 1..chars.len() {
        for sep in NAME_SEPARATORS {
            out.push(format!("{}{sep}{}", chars[..first].concat(), chars[first..].concat()));
        }
        // The two-run tier is SPACES ONLY, and 16x cheaper for it. Two runs inside one query word
        // means the name spelled it across three of its own words — "ego a deriva" carrying `goad`
        // — and a name that puts punctuation at BOTH of those joins, typed as one token, is a
        // shape no observed Scryfall answer needs.
        if word.len() > TWO_SEPARATOR_MAX_LEN {
            continue;
        }
        for second in first + 1..chars.len() {
            out.push(format!(
                "{} {} {}",
                chars[..first].concat(),
                chars[first..second].concat(),
                chars[second..].concat(),
            ));
        }
    }
    out
}

/// `hay` IS `needle` (already separator-free) once `hay`'s non-alphanumerics are dropped.
///
/// The whole-name half of the containment rule: `fuzzy=lightningbolt` answers Lightning Bolt on
/// api.scryfall.com (2026-08-16) even though "Emeritus of Conflict // Lightning Bolt" contains the
/// same letters, so a name that IS the query outranks every name that merely carries it — and
/// that is not `hay == needle`, which the separators break.
fn equals_unseparated(hay: &str, needle: &str) -> bool {
    let mut wanted = needle.chars();
    for c in hay.chars().filter(|c| c.is_alphanumeric()) {
        if wanted.next() != Some(c) {
            return false;
        }
    }
    wanted.next().is_none()
}

/// `needle` (already separator-free) inside `hay`, ignoring `hay`'s non-alphanumerics.
///
/// Scryfall's containment rule, and it is not the same as `hay.contains(needle)`: `goad` is inside
/// "ego à deriva" because the folded name reads `egoaderiva` once its spaces are dropped. No
/// allocation — the name is walked in place, per start position, skipping separators as they come.
/// Names are short (61 bytes covers the corpus), so the quadratic worst case is bounded.
fn contains_unseparated(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let mut rest = hay;
    while !rest.is_empty() {
        let mut hay_chars = rest.chars();
        let mut needle_chars = needle.chars();
        let mut wanted = needle_chars.next();
        while let Some(want) = wanted {
            match hay_chars.next() {
                None => return false, // the name ran out mid-needle, and every later start is shorter
                Some(c) if !c.is_alphanumeric() => {} // a separator the query never spelled
                Some(c) if c == want => wanted = needle_chars.next(),
                Some(_) => break,
            }
        }
        if wanted.is_none() {
            return true;
        }
        let mut next = rest.chars();
        next.next();
        rest = next.as_str();
    }
    false
}

/// Descending precedence for the name scan. These values cross the wasm boundary and are compared
/// — never interpreted — by the partition merge, so their ORDER is the contract and their
/// magnitudes are not.
const TIER_WHOLE_NAME: u8 = 2;
const TIER_FACE_NAME: u8 = 1;
const TIER_FLAVOR_NAME: u8 = 0;

/// Which name keys a lookup may match. `/cards/named?exact=` reads a strict SUPERSET of what a
/// `POST /cards/collection` `{"name"}` identifier does — see `collection_card_by_name` for the
/// measurements that separate them.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum NameScope {
    Exact,
    Collection,
}

/// The tier at which `needle` — already COLLATED — is one of this card's name keys, or None for a
/// card the needle does not name. `folded` and `collated` are the card's own two stored spellings
/// of its name (`folded_name` and `collated_name`).
fn name_key_tier(folded: &str, collated: &str, needle: &str, scope: NameScope) -> Option<u8> {
    let mut halves = folded.split(" // ");
    let front = halves.next().unwrap_or("");
    let back = halves.next();
    // EXACTLY two halves. A name with more of them has no face keys at all: measured on
    // api.scryfall.com 2026-08-31, `exact=Who`, `exact=What` and `{"name":"Who"}` are each
    // not_found, while `exact=Who // What // When // Where // Why` and the same identifier answer
    // und/75 — the FIVE-part name is the key, and its parts are not. A `split_once` read this as
    // "Who" + "What // When // Where // Why" and answered the card on the front half alone.
    if let Some(back) = back.filter(|_| halves.next().is_none()) {
        // Collated AFTER the split, because the `" // "` join is itself non-alphanumeric:
        // collapsing first would make the boundary vanish and let a needle straddle it.
        if crate::collate_name(front) == needle || crate::collate_name(back) == needle {
            return Some(TIER_FACE_NAME);
        }
        // The joined name is `exact=`'s key and NOT a collection identifier's — the one place the
        // two surfaces disagree about a card that exists. See `collection_card_by_name`.
        return (scope == NameScope::Exact && collated == needle).then_some(TIER_WHOLE_NAME);
    }
    (collated == needle).then_some(TIER_WHOLE_NAME)
}

/// JSON twin of `faces_to_pylist`: text from the oracle card, art from this printing.
///
/// `object` and `image_uris` are omitted deliberately -- the first is the constant "card_face",
/// the second a pure function of the card's id and the face's position, so the caller re-emits
/// both. A printing carrying fewer face-art records than the card has faces leaves those faces
/// without art rather than borrowing the wrong face's, exactly as the pydict twin does.
fn faces_to_json(card: &AOracleCard, printing: &APrinting, strings: &AStrings) -> Value {
    // Whichever of the card's two face lists THIS printing prints -- see OracleCard::divergent.
    // `divergent_of` is the whole of that decision (there is no flag on the printing): it returns
    // None for every printing but the 81 reversible ones, and a None reads `card.faces` exactly as
    // this always has.
    let divergent = crate::divergent_of(card, printing);
    let faces = divergent.map_or(&card.faces, |d| &d.faces);
    // Scryfall's FACE-level `layout`, which the 81 reversible printings carry on both faces and
    // nothing else in the corpus carries at all. Absent stays absent: writing the key with a
    // null would put it on 540k faces Scryfall sends it on none of.
    let face_layout = divergent.and_then(|d| str_at(strings, u32::from(d.face_layout_id)));
    Value::Array(
        faces
            .iter()
            .enumerate()
            .map(|(i, face)| {
                let mut m = Map::with_capacity(12);
                if let Some(v) = face_layout {
                    m.insert("layout".to_owned(), Value::String(v.to_owned()));
                }
                m.insert("name".to_owned(), opt_str_value(str_at(strings, u32::from(face.card_name_id))));
                m.insert("mana_cost".to_owned(), opt_str_value(str_at(strings, u32::from(face.mana_cost_text_id))));
                m.insert("type_line".to_owned(), opt_str_value(str_at(strings, u32::from(face.type_line_id))));
                m.insert("oracle_text".to_owned(), opt_str_value(str_at(strings, u32::from(face.oracle_text_id))));
                m.insert("power".to_owned(), opt_str_value(str_at(strings, u32::from(face.creature_power_text_id))));
                m.insert(
                    "toughness".to_owned(),
                    opt_str_value(str_at(strings, u32::from(face.creature_toughness_text_id))),
                );
                m.insert(
                    "loyalty".to_owned(),
                    opt_str_value(str_at(strings, u32::from(face.planeswalker_loyalty_text_id))),
                );
                m.insert("defense".to_owned(), opt_str_value(str_at(strings, u32::from(face.defense_text_id))));
                // `unwrap_or(0)` deliberately: this writer has always emitted the key on every
                // face, and the absent/empty distinction the column now carries is a SEARCH fact.
                // The Scryfall-compat writer (card_object.rs) emits faces from the row's own face
                // records, where an absent key was already absent, so nothing on the parity path
                // reads this.
                m.insert(
                    "colors".to_owned(),
                    str_vec_value(identity_letters(face.card_colors.as_ref().map_or(0, |v| *v))),
                );
                m.insert(
                    "color_indicator".to_owned(),
                    str_vec_value(identity_letters(face.color_indicator)),
                );
                if let Some(art) = printing.faces.get(i) {
                    // Original case from the string table — see JSON_FIELD_TABLE's `artist` arm.
                    m.insert("artist".to_owned(), opt_str_value(str_at(strings, u32::from(art.card_artist_name_id))));
                    m.insert("illustration_id".to_owned(), uuid_value(u128::from(art.illustration_id)));
                    m.insert("flavor_text".to_owned(), opt_str_value(str_at(strings, u32::from(art.flavor_text_id))));
                    // Present only when THIS face carries one — absence is exact, like the
                    // printed triple below and unlike `flavor_text`, which Scryfall's face
                    // objects carry as a key even when empty.
                    if let Some(v) = str_at(strings, u32::from(art.flavor_name_id)) {
                        m.insert("flavor_name".to_owned(), Value::String(v.to_owned()));
                    }
                    // Same rule, and the reason the top-level key disappears on a faced printing:
                    // Scryfall puts the watermark HERE and on 0 of the 12,098 faced printings'
                    // top level (2026-08-16 all_cards). See PrintingFace::card_watermark_id.
                    if let Some(v) = str_at(strings, u32::from(art.card_watermark_id)) {
                        m.insert("watermark".to_owned(), Value::String(v.to_owned()));
                    }
                }
                // The printed-language triple, inserted only when this printing's face carries
                // the key: absence is exact per face (a prepare-layout Spanish printing
                // localizes the front face's name and type line and nothing else), so an
                // absent key never becomes a null. Keys land alphabetically like the rest —
                // this Map is a BTreeMap — which the TS twin mirrors.
                if let Some(printed) = printing.printed_faces.get(i) {
                    if let Some(v) = str_at(strings, u32::from(printed.printed_name_id)) {
                        m.insert("printed_name".to_owned(), Value::String(v.to_owned()));
                    }
                    if let Some(v) = str_at(strings, u32::from(printed.printed_type_line_id)) {
                        m.insert("printed_type_line".to_owned(), Value::String(v.to_owned()));
                    }
                    if let Some(v) = str_at(strings, u32::from(printed.printed_text_id)) {
                        m.insert("printed_text".to_owned(), Value::String(v.to_owned()));
                    }
                }
                Value::Object(m)
            })
            .collect(),
    )
}


/// Mirror of `resolve_fields`: dedupe repeats, reject unknown names, `None` →
/// DEFAULT_FIELDS. Same error message shape as the pyo3 UnknownFieldError.
fn resolve_fields_json(fields: Option<Vec<String>>) -> Result<Vec<(&'static str, JsonFieldExtractor)>, EngineError> {
    let requested: Vec<&str> = match &fields {
        Some(v) => v.iter().map(String::as_str).collect(),
        None => DEFAULT_FIELDS.to_vec(),
    };
    let mut seen = HashSet::with_capacity(requested.len());
    let mut resolved = Vec::with_capacity(requested.len());
    for name in requested {
        if !seen.insert(name) {
            continue;
        }
        match JSON_FIELD_TABLE.iter().find(|(n, _)| *n == name) {
            Some((n, f)) => resolved.push((*n, *f)),
            None => return Err(EngineError::unknown_field(format!("unknown field: {name:?}"))),
        }
    }
    Ok(resolved)
}

fn card_to_json(
    card: &AOracleCard,
    printing: &APrinting,
    strings: &AStrings,
    vocab: &AStrings,
    fields: &[(&'static str, JsonFieldExtractor)],
) -> Value {
    let mut m = Map::with_capacity(fields.len());
    for (name, extractor) in fields {
        m.insert((*name).to_owned(), extractor(card, printing, strings, vocab));
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NONE_STR, find_printing_by_external_id};
    use serde_json::json;

    /// The LIVE gate for a result field in this port. A name that reaches
    /// `RESULT_FIELD_NAMES` but not `JSON_FIELD_TABLE` passes the TS validator and then
    /// comes back as a 500 from the engine rather than a 400 — so the two tables agreeing
    /// is what makes `fields=price_eur` a working request instead of an error. FIELD_TABLE
    /// is pyo3-gated and compiled out here, so it cannot be compared against directly;
    /// this asserts the half that is actually reachable.
    #[test]
    fn every_price_field_resolves() {
        let names = ["price_usd", "price_eur", "price_tix"];
        let resolved = resolve_fields_json(Some(names.iter().map(|n| (*n).to_string()).collect()))
            .expect("every currency the orderby vocabulary sorts by must be readable");
        let got: Vec<&str> = resolved.iter().map(|(n, _)| *n).collect();
        assert_eq!(got, names);
    }

    /// The legality word must survive encode → decode unchanged.
    ///
    /// This is the invariant that has already been broken once here: `format_shift_or_assign`
    /// stores `(index * 2)`, so the shift IS the bit position, and a decoder that shifts by
    /// `shift * 2` double-shifts and misreads every format past the first. A round trip catches
    /// that; asserting one format does not, because format zero survives the bug.
    #[test]
    fn legality_bits_round_trip_through_json() {
        let input = json!({
            "card_legalities": {
                "alchemy": "banned",
                "commander": "legal",
                "modern": "not_legal",
                "pauper": "legal",
                "standard": "restricted",
                "vintage": "restricted",
            }
        });
        let bits = jv_legality_bits(&input, "card_legalities");
        let decoded = legality_bits_to_json(bits);

        // Every status word, on every format, in both directions.
        for (format, want) in input["card_legalities"].as_object().expect("object") {
            assert_eq!(&decoded[format], want, "{format} did not survive the round trip");
        }
    }

    /// A format the registry knows but the card never mentioned reads as not_legal, which is how
    /// the encoder treated it — an absent key contributes no bits.
    #[test]
    fn a_format_absent_from_the_card_reads_not_legal() {
        // Registers the format itself rather than relying on a sibling test having done it.
        // `format_shifts()` is a process-global registry, so depending on another test to
        // populate it made this pass or fail on test ORDER: it failed whenever it was run
        // alone (`cargo test <name>`) and raced the round-trip test in a full parallel run.
        // The assertion below is about an absent KEY, not about who registered the format.
        let registered =
            json!({ "card_legalities": { "standard": "legal", "modern": "legal", "legacy": "legal" } });
        let _ = jv_legality_bits(&registered, "card_legalities");

        let seen = json!({ "card_legalities": { "modern": "legal", "legacy": "banned" } });
        let bits = jv_legality_bits(&seen, "card_legalities");
        let decoded = legality_bits_to_json(bits);
        assert_eq!(decoded["modern"], json!("legal"));
        assert_eq!(decoded["legacy"], json!("banned"));
        // Known to the registry, absent from this card.
        assert_eq!(decoded["standard"], json!("not_legal"));
    }

    /// The decoder must not collapse distinct codes. legal/not_legal alone would survive an
    /// off-by-one in the shift; restricted and banned are what pin the 2-bit layout.
    #[test]
    fn all_four_legality_codes_are_distinguishable() {
        let input = json!({
            "card_legalities": { "f0": "legal", "f1": "restricted", "f2": "banned", "f3": "not_legal" }
        });
        let decoded = legality_bits_to_json(jv_legality_bits(&input, "card_legalities"));
        assert_eq!(decoded["f0"], json!("legal"));
        assert_eq!(decoded["f1"], json!("restricted"));
        assert_eq!(decoded["f2"], json!("banned"));
        assert_eq!(decoded["f3"], json!("not_legal"));
    }

    /// A face Scryfall sent without a key must read as ABSENT, not as an empty string.
    ///
    /// `intern_opt(None)` yields NONE_STR; `intern("")` yields a real id pointing at "". Both
    /// build clean and both look like "nothing" in a debugger, but only the first round-trips
    /// back to a missing key. A transform back face genuinely has no `mana_cost`, which is a
    /// different statement from having an empty one — and `/cards/*` will re-emit the difference.
    #[test]
    fn an_absent_face_key_stays_absent_rather_than_becoming_empty() {
        let mut it = Interner::new();
        let mut artists = VocabInterner::new();
        let d = json!({
            "card_faces": [
                { "name": "Delver of Secrets", "mana_cost": "{U}", "type_line": "Creature",
                  "oracle_text": "", "power": "1", "toughness": "1", "colors": ["U"] },
                // A transform back: no mana_cost key at all, and an empty flavor_text that IS
                // present. The two must not collapse into the same stored value.
                { "name": "Insectile Aberration", "type_line": "Creature",
                  "oracle_text": "Flying", "flavor_text": "", "colors": ["U"] },
            ]
        });
        let faces = jv_faces(&d, &mut it, &mut artists, &mut ManaVocabInterner::new()).expect("faces");
        assert_eq!(faces.len(), 2);

        // Front: mana_cost present.
        assert_ne!(faces[0].mana_cost_text_id, NONE_STR);
        // Back: mana_cost absent entirely.
        assert_eq!(faces[1].mana_cost_text_id, NONE_STR, "an omitted key must be NONE_STR");
        // Back: flavor_text PRESENT but empty — an id, not the sentinel.
        assert_ne!(faces[1].flavor_text_id, NONE_STR, "an empty-but-present key is not absent");
        // Neither face is a planeswalker, so loyalty is absent on both.
        assert_eq!(faces[0].planeswalker_loyalty_text_id, NONE_STR);
        assert_eq!(faces[1].planeswalker_loyalty_text_id, NONE_STR);
        // Face colors arrive as a plain list, not the row columns' jsonb object.
        assert_eq!(faces[0].card_colors, faces[1].card_colors);
        assert_eq!(faces[0].card_colors, Some(0b0000_0010), "U");
        // color_indicator is absent on both, which is a clear mask rather than a wrong one.
        assert_eq!(faces[0].color_indicator, 0);
    }

    /// THE THREE STATES OF A FACE'S `colors`, which a bare `u8` had only two of.
    ///
    /// A split or flip face carries no `colors` key at all — Fire // Ice's halves have `name`,
    /// `mana_cost` and `type_line` and nothing else — while an MDFC land back carries
    /// `"colors": []`, declared colourless. Both used to arrive as the mask 0, and reading the
    /// first as colourless is what would make `!"Fire // Ice" c:c` answer 1 where
    /// api.scryfall.com answers 404. See `face_color_masks` for what each state then means.
    #[test]
    fn an_absent_face_colors_key_is_not_a_declared_empty_one() {
        let mut it = Interner::new();
        let mut artists = VocabInterner::new();
        let d = json!({
            "card_faces": [
                // Fire // Ice, verbatim in shape: no `colors` anywhere on either half.
                { "name": "Fire", "mana_cost": "{1}{R}", "type_line": "Instant" },
                { "name": "Ice", "mana_cost": "{1}{U}", "type_line": "Instant" },
            ]
        });
        let split = jv_faces(&d, &mut it, &mut artists, &mut ManaVocabInterner::new()).expect("faces");
        assert_eq!(split[0].card_colors, None, "an omitted key is not a colourless face");
        assert_eq!(split[1].card_colors, None);

        let d = json!({
            "card_faces": [
                { "name": "Kabira Takedown", "mana_cost": "{1}{W}", "type_line": "Instant", "colors": ["W"] },
                // The land back DECLARES its emptiness, and that really does mean colourless.
                { "name": "Kabira Plateau", "mana_cost": "", "type_line": "Land", "colors": [] },
            ]
        });
        let mdfc = jv_faces(&d, &mut it, &mut artists, &mut ManaVocabInterner::new()).expect("faces");
        assert_eq!(mdfc[0].card_colors, Some(0b0000_0001), "W");
        assert_eq!(mdfc[1].card_colors, Some(0), "a declared empty list IS colourless");
    }

    /// Faces must survive the spill codec.
    ///
    /// This codec has no upstream twin — it exists because the Worker build is alarm-chained and
    /// rows are spilled between invocations to fit a 30s alarm — so nothing upstream would catch
    /// faces being dropped in it. A face that does not round-trip here is a face missing from
    /// every store this port builds in production, with no compile error and no failing import.
    #[test]
    fn faces_survive_the_spill_round_trip() {
        let mut it = Interner::new();
        let mut artists = VocabInterner::new();
        let d = json!({
            "card_faces": [
                { "name": "Front", "mana_cost": "{U}", "type_line": "Creature", "oracle_text": "a",
                  "power": "1", "toughness": "2", "colors": ["U"],
                  "illustration_id": "1c2fee9b-89ea-4ab1-a751-451c3cd65a88", "artist": "Nils Hamm" },
                { "name": "Back", "type_line": "Creature", "oracle_text": "b", "loyalty": "4",
                  "color_indicator": ["G"],
                  "illustration_id": "c2b5f731-771b-4949-90f3-0ad40d676100", "artist": "Nils Hamm" },
            ]
        });
        let faces = jv_faces(&d, &mut it, &mut artists, &mut ManaVocabInterner::new()).expect("faces");

        let mut row = decode_card_row(&encode_card_row(&CardRow {
            card_faces: faces,
            ..empty_card_row()
        }))
        .expect("round trip");

        assert_eq!(row.card_faces.len(), 2);
        let back = row.card_faces.pop().expect("back");
        let front = row.card_faces.remove(0);
        // The front's mana cost survives as a real interned id; the back's absence
        // survives as the sentinel. Both halves of that distinction have to cross
        // the spill, which is the whole point of this test.
        assert_ne!(front.mana_cost_text_id, NONE_STR);
        assert_eq!(back.mana_cost_text_id, NONE_STR);
        assert_ne!(front.illustration_id, back.illustration_id);
        assert_eq!(front.card_artist_vid, back.card_artist_vid); // same artist interned once
        assert_ne!(back.planeswalker_loyalty_text_id, NONE_STR);
        assert_ne!(back.color_indicator, 0);
        assert_eq!(front.color_indicator, 0);
    }

    /// `into_total_and_rows_json` must be the SAME ANSWER as the `to_json` path it replaces.
    ///
    /// The Durable Object splices its output into a response envelope without parsing it, so a
    /// divergence here is not caught by anything downstream -- it ships as a malformed body. The
    /// equivalence is asserted against `to_json`'s own `rows`, so the two cannot drift.
    #[test]
    fn total_and_rows_json_matches_the_wrapper_path() {
        let rows = vec![
            json!({"name": "Llanowar Elves", "cmc": 1.0, "colors": ["G"]}),
            // The characters that would break a naive prefix scheme or a hand-rolled encoder:
            // a newline and a quote inside a value, and non-ASCII that must not be escaped
            // differently by the two paths.
            json!({"name": "Æther \"Vial\"\nSecond line", "oracle_text": "Draw a card.\nThen discard."}),
            json!({"name": "Jötun Grunt", "power": null}),
        ];
        let out = QueryOutput { total: 4242, rows: rows.clone(), widened: false };

        let wrapped = out.to_json();
        let want_rows = wrapped.get("rows").expect("rows key").to_string();

        let bytes = out.into_total_and_rows_bytes().expect("serialize");
        let answer = String::from_utf8(bytes).expect("valid UTF-8");
        let newline = answer.find('\n').expect("prefix is newline-terminated");
        let prefix: Vec<&str> = answer[..newline].split(' ').collect();

        assert_eq!(prefix, ["4242", "3"], "prefix is `<total> <row count>`");
        assert_eq!(&answer[newline + 1..], want_rows, "rows are byte-identical to the wrapper's");

        // And the tail really is a JSON array, whatever the values contained.
        let reparsed: Value = serde_json::from_str(&answer[newline + 1..]).expect("tail parses");
        assert_eq!(reparsed, Value::Array(rows));
    }

    /// An empty page still carries a well-formed prefix and an empty array, not "" or "null".
    #[test]
    fn total_and_rows_json_handles_an_empty_page() {
        let bytes = QueryOutput { total: 0, rows: Vec::new(), widened: false }.into_total_and_rows_bytes().expect("serialize");
        let answer = String::from_utf8(bytes).expect("valid UTF-8");
        assert_eq!(answer, "0 0\n[]");
    }

    /// LOCAL PATCH measurement probe: break the archive's `indexes + padding`
    /// remainder — the largest section in archive_section_stats' report and the
    /// only one it cannot see inside — into individual `CardIndexes` fields, by
    /// serializing each field as its own rkyv root. Per-root sizes carry their
    /// own alignment rather than the archive's exact layout, so they rank the
    /// fields rather than partition the bytes exactly; the reconciliation lines
    /// at the end show how much the difference amounts to.
    ///
    /// Ignored because it needs a real corpus and holds it in memory several
    /// times over — native only, never wasm. SYLVAN_ROWS must be ABSOLUTE:
    /// cargo runs the test with the crate dir as cwd, not the repo root. Run as:
    ///   SYLVAN_ROWS=$PWD/store-build/rows.jsonl scripts/with-rust.sh cargo test --release \
    ///     -p card_engine index_section_breakdown -- --ignored --nocapture
    #[test]
    #[ignore]
    fn index_section_breakdown() {
        use std::io::BufRead;
        let rows_path = std::env::var("SYLVAN_ROWS").expect("set SYLVAN_ROWS to a rows.jsonl path");
        let file = std::fs::File::open(&rows_path).unwrap_or_else(|e| panic!("open {rows_path}: {e}"));
        let mut b = StoreBuilder::new();
        for line in std::io::BufReader::new(file).lines() {
            let line = line.expect("read rows.jsonl line");
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(&line).expect("parse row JSON");
            b.add_card(&v).expect("stage row");
        }
        let StoreBuilder { rows, interner, vocab, artists, artist_entities, mana } = b;
        let built =
            build_card_data(rows, interner, vocab, artists, crate::artist_entity_index_from_json(Some(&artist_entities)), mana).expect("build card data");
        let d = &built.card_data;

        macro_rules! sz {
            ($v:expr) => {
                rkyv::to_bytes::<rkyv::rancor::Error>(&$v).map(|b| b.len()).unwrap_or(0)
            };
        }

        let ix = &d.indexes;
        let mut parts: Vec<(&str, usize)> = vec![
            ("name_trigram", sz!(ix.name_trigram)),
            ("oracle_trigram", sz!(ix.oracle_trigram)),
            ("cmc", sz!(ix.cmc)),
            ("power", sz!(ix.power)),
            ("toughness", sz!(ix.toughness)),
            ("rarity", sz!(ix.rarity)),
            ("subtypes", sz!(ix.subtypes)),
            ("keywords", sz!(ix.keywords)),
            ("oracle_tags", sz!(ix.oracle_tags)),
            ("art_tags", sz!(ix.art_tags)),
            ("is_tags", sz!(ix.is_tags)),
            ("frame_data", sz!(ix.frame_data)),
            ("artists", sz!(ix.artists)),
            ("flavor", sz!(ix.flavor)),
            ("set_codes", sz!(ix.set_codes)),
            ("watermarks", sz!(ix.watermarks)),
            ("released_at", sz!(ix.released_at)),
            ("price_usd", sz!(ix.price_usd)),
            ("price_eur", sz!(ix.price_eur)),
            ("price_tix", sz!(ix.price_tix)),
            ("collector_number", sz!(ix.collector_number)),
            ("released_at_cards", sz!(ix.released_at_cards)),
            ("price_usd_cards", sz!(ix.price_usd_cards)),
            ("price_eur_cards", sz!(ix.price_eur_cards)),
            ("price_tix_cards", sz!(ix.price_tix_cards)),
            ("collector_number_cards", sz!(ix.collector_number_cards)),
            ("rarity_cards", sz!(ix.rarity_cards)),
            ("value_totals", sz!(ix.value_totals)),
            ("pair_totals", sz!(ix.pair_totals)),
            ("sort_perms", sz!(ix.sort_perms)),
            ("artwork_groups", sz!(ix.artwork_groups)),
            ("artwork_base", sz!(ix.artwork_base)),
            ("artwork_group_col", sz!(ix.artwork_group_col)),
            ("printing_to_card", sz!(ix.printing_to_card)),
            ("planes", sz!(ix.planes)),
            ("border_printing", sz!(ix.border_printing)),
            ("rarity_printing", sz!(ix.rarity_printing)),
            ("rarity_printing_ordered", sz!(ix.rarity_printing_ordered)),
            ("name_bigrams", sz!(ix.name_bigrams)),
            ("name_unigrams", sz!(ix.name_unigrams)),
            ("legal_divergent", sz!(ix.legal_divergent)),
            ("arith_tuple", sz!(ix.arith_tuple)),
            ("printing_by_scryfall_id", sz!(ix.printing_by_scryfall_id)),
            ("printing_by_illustration_id", sz!(ix.printing_by_illustration_id)),
            ("oracle_by_oracle_id", sz!(ix.oracle_by_oracle_id)),
            ("external_id_index", sz!(ix.external_id_index)),
            ("langs", sz!(ix.langs)),
            ("foreign_langs", sz!(ix.foreign_langs)),
            ("foreign_to_card", sz!(ix.foreign_to_card)),
            ("foreign_by_scryfall_id", sz!(ix.foreign_by_scryfall_id)),
            ("foreign_external_ids", sz!(ix.foreign_external_ids)),
            ("printed_names", sz!(ix.printed_names)),
        ];
        parts.sort_by_key(|p| std::cmp::Reverse(p.1));

        let whole_indexes = sz!(d.indexes);
        let field_sum: usize = parts.iter().map(|p| p.1).sum();

        struct CountWriter(usize);
        impl std::io::Write for CountWriter {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0 += b.len();
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut cw = CountWriter(0);
        write_archive(d, &mut cw).expect("serialize archive");
        let archive_total = cw.0 - ARCHIVE_HEADER_LEN;
        let stats = archive_section_stats(d);
        let named = stats.cards_bytes
            + stats.printings_bytes
            + stats.strings_bytes
            + stats.vocab_bytes
            + stats.direct_arrays_bytes;

        let mb = |b: usize| b as f64 / (1024.0 * 1024.0);
        println!("CardIndexes fields, serialized standalone ({} rows -> {} cards, {} printings):", built.card_data.printings.len(), stats.card_count, stats.printing_count);
        for (name, bytes) in &parts {
            if *bytes == 0 {
                continue;
            }
            println!("  {name:<28} {:>8.2}MB  {:>5.1}%", mb(*bytes), *bytes as f64 * 100.0 / whole_indexes as f64);
        }
        println!("  {:<28} {:>8.2}MB", "sum of fields", mb(field_sum));
        println!("  {:<28} {:>8.2}MB  (field alignment/framing: {:+.2}MB)", "CardIndexes as one root", mb(whole_indexes), mb(whole_indexes) - mb(field_sum));
        println!("  {:<28} {:>8.2}MB", "archive total", mb(archive_total));
        println!("  {:<28} {:>8.2}MB  (what archive_section_stats reports as indexes+padding)", "archive minus named sections", mb(archive_total - named));
        println!("  {:<28} {:>8.2}MB  (rkyv slack the per-field view cannot attribute)", "remainder minus CardIndexes", mb(archive_total - named - whole_indexes));
    }

    /// A CardRow with every scalar at its zero value, for tests that care about one field.
    fn empty_card_row() -> CardRow {
        let mut it = Interner::new();
        let mut vocab = VocabInterner::new();
        let mut artists = VocabInterner::new();
        let mut mana = ManaVocabInterner::new();
        card_from_json(&json!({}), &mut it, &mut vocab, &mut artists, &mut mana)
            .expect("an empty object yields an all-defaults row")
    }

    // ─── Foreign-printing annex round trips ──────────────────────────────────

    /// One engine row in the shape `card_from_json` reads: minimal, but grouping-complete.
    fn annex_row(name: &str, oracle: &str, scry: &str, lang: &str, prefer: f64) -> Value {
        json!({
            "card_name": name,
            "card_name_folded": name.to_lowercase(),
            "oracle_id": oracle,
            "scryfall_id": scry,
            "illustration_id": format!("{scry}-art"),
            "card_set_code": "tst",
            "set_name": "Test Set",
            "collector_number": "1",
            "oracle_text": "Do a thing.",
            "flavor_text": "",
            "type_line": "Instant",
            "card_types": ["Instant"],
            "card_legalities": {"vintage": "legal"},
            "card_colors": {"R": true},
            "card_color_identity": {"R": true},
            "produced_mana": {},
            "card_layout": "normal",
            "prefer_score": prefer,
            "card_compat_blob": {"lang": lang},
        })
    }

    /// Build through the Vec path and load through the buffer path — the wasm pipeline's shape.
    fn build_store(rows: &[Value]) -> (Vec<u8>, BufferStore) {
        build_store_with_entities(rows, Value::Null)
    }

    /// ...with the corpus-wide artist-entity relation the real builder computes and hands over.
    fn build_store_with_entities(rows: &[Value], artist_entities: Value) -> (Vec<u8>, BufferStore) {
        let mut b = StoreBuilder::new();
        b.set_artist_entities(artist_entities);
        for r in rows {
            b.add_card(r).expect("stage row");
        }
        let mut bytes = Vec::new();
        b.finish_to_writer(&mut bytes).expect("build store");
        let store = BufferStore::from_bytes(&bytes).expect("load store");
        (bytes, store)
    }

    /// The whole annex contract in one build→archive→read pass: non-canonical rows land in
    /// `foreign` under a card-aligned CSR in prefer-desc order, the canonical space keeps only
    /// the canonical rows, the annex indexes point where they claim, printed strings intern to
    /// one table entry however many rows share them, absent printed keys stay absent — and the
    /// spill codec reproduces the identical archive, so the alarm-chained wasm build cannot
    /// drift from the Vec path.
    #[test]
    fn foreign_rows_build_an_annex_with_csr_integrity() {
        let mut a_ja = annex_row("Shock", "oracle-a", "row-a-ja", "ja", 100.0);
        a_ja["is_canonical"] = json!(false);
        a_ja["printed_name"] = json!("ショック");
        a_ja["printed_type_line"] = json!("インスタント");
        a_ja["printed_text"] = json!("2点のダメージ");
        a_ja["printed_name_folded"] = json!("ショック");
        a_ja["card_compat_blob"]["multiverse_ids"] = json!([464001]);
        // Spanish printing whose type line and text were never localized: name only.
        let mut a_es = annex_row("Shock", "oracle-a", "row-a-es", "es", 90.0);
        a_es["is_canonical"] = json!(false);
        a_es["printed_name"] = json!("Impacto");
        a_es["printed_name_folded"] = json!("impacto");
        // A second card whose Japanese printing shares A's printed name byte-for-byte.
        let mut b_ja = annex_row("Other Card", "oracle-b", "row-b-ja", "ja", 80.0);
        b_ja["is_canonical"] = json!(false);
        b_ja["printed_name"] = json!("ショック");
        b_ja["printed_name_folded"] = json!("ショック");
        let rows = vec![
            annex_row("Shock", "oracle-a", "row-a-en", "en", 200.0),
            a_ja,
            a_es,
            annex_row("Other Card", "oracle-b", "row-b-en", "en", 150.0),
            b_ja,
        ];
        let (_bytes, store) = build_store(&rows);
        let d = store.data();

        // The canonical space holds ONLY the canonical rows; the annex holds the rest.
        assert_eq!(store.size(), 2, "canonical printings only");
        assert_eq!(store.card_count(), 2);
        assert_eq!(d.foreign.len(), 3);

        // CSR integrity: card-aligned, terminated, nondecreasing, and every foreign_to_card
        // entry agrees with the range that owns it.
        assert_eq!(d.foreign_offsets.len(), d.cards.len() + 1);
        assert_eq!(u32::from(*d.foreign_offsets.last().unwrap()) as usize, d.foreign.len());
        for w in d.foreign_offsets.windows(2) {
            assert!(u32::from(w[0]) <= u32::from(w[1]));
        }
        for (cid, w) in d.foreign_offsets.windows(2).enumerate() {
            for fid in u32::from(w[0])..u32::from(w[1]) {
                assert_eq!(u32::from(d.indexes.foreign_to_card[fid as usize]) as usize, cid);
            }
        }

        // Card A's annex range: both foreign rows, in LANGUAGE order (es before ja) — the order
        // Scryfall serves a slot's languages in, which `order_annex_by_language` stores. Note this
        // is NOT prefer order: the ja row scores 100 against the es row's 90, and it comes second.
        let a = d.cards.iter().position(|c| c.card_name_lower.as_str() == "shock").expect("card A");
        let (from, to) = (u32::from(d.foreign_offsets[a]) as usize, u32::from(d.foreign_offsets[a + 1]) as usize);
        assert_eq!(to - from, 2);
        let a_range = &d.foreign[from..to];
        let lang_of = |p: &APrinting| d.coll_vocab[u16::from(p.compat.lang_id) as usize].as_str();
        assert_eq!([lang_of(&a_range[0]), lang_of(&a_range[1])], ["es", "ja"], "annex rows are stored by language");

        // The language planes narrow each space independently.
        let en = d.indexes.langs.ids_of("en").expect("en postings");
        assert_eq!(en.len(), 2, "every canonical row is English here");
        assert!(d.indexes.langs.ids_of("ja").is_none(), "no canonical row is Japanese");
        let ja = d.indexes.foreign_langs.ids_of("ja").expect("ja postings");
        assert_eq!(ja.len(), 2);
        assert_eq!(d.indexes.foreign_langs.ids_of("es").expect("es postings").len(), 1);

        // The by-scryfall permutation covers the annex, ordered.
        assert_eq!(d.indexes.foreign_by_scryfall_id.len(), d.foreign.len());
        let by_id: Vec<u128> = d
            .indexes
            .foreign_by_scryfall_id
            .iter()
            .map(|i| u128::from(d.foreign[u32::from(*i) as usize].scryfall_id))
            .collect();
        assert!(by_id.windows(2).all(|w| w[0] <= w[1]));

        // A foreign multiverse id resolves through the annex external-id index to the ja row.
        let hit = find_printing_by_external_id(&d.indexes.foreign_external_ids, EXT_MULTIVERSE, 464001)
            .expect("foreign multiverse id resolves");
        assert_ne!(u32::from(d.foreign[hit as usize].printed_text_id), NONE_STR);
        assert!(
            find_printing_by_external_id(&d.indexes.external_id_index, EXT_MULTIVERSE, 464001).is_none(),
            "the canonical index must not see an annex-only id"
        );

        // PrintedNameIndex: records sorted by (name bytes, lang), a shared (name, lang) pair is
        // ONE record whose vpids come best prefer first, and vpids address the annex space.
        let pn = &d.indexes.printed_names;
        assert_eq!(pn.name_ids.len(), 2, "ショック(ja) collapses to one record; impacto(es) is the other");
        assert_eq!(pn.offsets.len(), pn.name_ids.len() + 1);
        let record_names: Vec<&str> =
            pn.name_ids.iter().map(|id| str_at(&d.strings, u32::from(*id)).expect("interned")).collect();
        assert_eq!(record_names, ["impacto", "ショック"], "sorted by name bytes");
        let shared = &pn.vpids[u32::from(pn.offsets[1]) as usize..u32::from(pn.offsets[2]) as usize];
        assert_eq!(shared.len(), 2);
        let n_printings = d.printings.len() as u32;
        let vprefer = |vpid: u32| {
            assert!(vpid >= n_printings, "printed names here live on annex rows");
            f32::from(d.foreign[(vpid - n_printings) as usize].prefer_score.as_ref().copied().unwrap())
        };
        assert!(vprefer(u32::from(shared[0])) > vprefer(u32::from(shared[1])), "best prefer first");

        // Interning dedupe: two rows' printed name (and its folded twin, identical here) share
        // ONE strings entry.
        assert_eq!(d.strings.iter().filter(|s| s.as_str() == "ショック").count(), 1);

        // Absence-exactness through the archive and back out as JSON: the es row's type line
        // and text were never localized, so they read as null while the name reads localized.
        let es = a_range.iter().find(|p| u32::from(p.printed_type_line_id) == NONE_STR).expect("es row");
        assert_eq!(u32::from(es.printed_text_id), NONE_STR);
        let fields = resolve_fields_json(Some(
            ["printed_name", "printed_type_line", "printed_text", "lang"].iter().map(|s| s.to_string()).collect(),
        ))
        .expect("printed fields resolve");
        let obj = card_to_json(&d.cards[a], es, &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["printed_name"], json!("Impacto"));
        assert_eq!(obj["printed_type_line"], json!(null));
        assert_eq!(obj["printed_text"], json!(null));
        assert_eq!(obj["lang"], json!("es"));

        // And the printed columns + canonical flag survive the spill codec: the decoder's
        // trailing length check makes a forgotten field a loud error, and the rebuilt store's
        // annex must come back row-for-row. (Byte equality between two independent builds is
        // not assertable — the archived HashMap sections serialize in per-instance iteration
        // order — so this compares the content the codec is responsible for.)
        let mut sb = SpillingStoreBuilder::new();
        let blobs: Vec<Vec<u8>> = rows.iter().map(|r| sb.add_card(r).expect("stage")).collect();
        let order = sb.sorted_order();
        let mut spilled = Vec::new();
        sb.finish_from_sorted(order.iter().map(|&i| blobs[i as usize].clone()), &mut spilled)
            .expect("spill build");
        let spill_store = BufferStore::from_bytes(&spilled).expect("load spilled store");
        let sd = spill_store.data();
        assert_eq!(sd.printings.len(), d.printings.len());
        assert_eq!(sd.foreign.len(), d.foreign.len());
        let offsets_of = |v: &Archived<Vec<u32>>| v.iter().map(|o| u32::from(*o)).collect::<Vec<u32>>();
        assert_eq!(offsets_of(&sd.foreign_offsets), offsets_of(&d.foreign_offsets));
        for (x, y) in sd.foreign.iter().zip(d.foreign.iter()) {
            assert_eq!(u128::from(x.scryfall_id), u128::from(y.scryfall_id));
            for (xi, yi) in [
                (x.printed_name_id, y.printed_name_id),
                (x.printed_type_line_id, y.printed_type_line_id),
                (x.printed_text_id, y.printed_text_id),
                (x.printed_name_folded_id, y.printed_name_folded_id),
                (x.flavor_name_id, y.flavor_name_id),
                (x.flavor_name_folded_id, y.flavor_name_folded_id),
            ] {
                assert_eq!(
                    str_at(&sd.strings, u32::from(xi)),
                    str_at(&d.strings, u32::from(yi)),
                    "a printed field diverged across the spill"
                );
            }
        }
    }

    /// Per-face printed keys round-trip with exact absence: a face without a key stays without
    /// it through build → archive → `faces_to_json`, and an all-English multi-faced printing
    /// stores no printed_faces at all.
    #[test]
    fn printed_faces_round_trip_absence_exactly() {
        let faces = json!([
            { "name": "Sudden Rescue", "type_line": "Instant", "oracle_text": "x",
              "printed_name": "Rescate repentino", "printed_type_line": "Instantáneo" },
            { "name": "Steady Return", "type_line": "Sorcery", "oracle_text": "y" },
        ]);
        let mut es = annex_row("Sudden Rescue // Steady Return", "oracle-p", "row-p-es", "es", 90.0);
        es["is_canonical"] = json!(false);
        es["card_faces"] = faces.clone();
        es["printed_name_folded"] = json!("rescate repentino // steady return");
        let mut en = annex_row("Sudden Rescue // Steady Return", "oracle-p", "row-p-en", "en", 200.0);
        en["card_faces"] = json!([
            { "name": "Sudden Rescue", "type_line": "Instant", "oracle_text": "x" },
            { "name": "Steady Return", "type_line": "Sorcery", "oracle_text": "y" },
        ]);
        let (_bytes, store) = build_store(&[en, es]);
        let d = store.data();

        // The English printing carries faces but NO printed_faces — absence is a length-0 Vec,
        // not a run of sentinels.
        assert_eq!(d.printings.len(), 1);
        assert_eq!(d.printings[0].faces.len(), 2);
        assert!(d.printings[0].printed_faces.is_empty());

        // The Spanish printing's printed_faces parallel its faces, sentinels exactly where
        // Scryfall omitted keys.
        assert_eq!(d.foreign.len(), 1);
        let p = &d.foreign[0];
        assert_eq!(p.printed_faces.len(), 2);
        assert_ne!(u32::from(p.printed_faces[0].printed_name_id), NONE_STR);
        assert_ne!(u32::from(p.printed_faces[0].printed_type_line_id), NONE_STR);
        assert_eq!(u32::from(p.printed_faces[0].printed_text_id), NONE_STR);
        assert_eq!(u32::from(p.printed_faces[1].printed_name_id), NONE_STR);
        assert_eq!(u32::from(p.printed_faces[1].printed_type_line_id), NONE_STR);
        assert_eq!(u32::from(p.printed_faces[1].printed_text_id), NONE_STR);

        // faces_to_json inserts a printed key only where the face carries it — never a null.
        let out = faces_to_json(&d.cards[0], p, &d.strings);
        let front = out[0].as_object().expect("front face");
        assert_eq!(front["printed_name"], json!("Rescate repentino"));
        assert_eq!(front["printed_type_line"], json!("Instantáneo"));
        assert!(!front.contains_key("printed_text"));
        let back = out[1].as_object().expect("back face");
        for key in ["printed_name", "printed_type_line", "printed_text"] {
            assert!(!back.contains_key(key), "the back face must not sprout {key}");
        }
        // And the English printing's faces stay printed-free.
        let plain = faces_to_json(&d.cards[0], &d.printings[0], &d.strings);
        assert!(!plain[0].as_object().unwrap().contains_key("printed_name"));
    }

    // ─── The widened (multilingual) query plan and the printing-granularity name paths ────────

    /// The A2/A3 fixture corpus: card A ("Unmoored Ego") with an English canonical row and two
    /// annex rows (pt with shared artwork, ja with its own), card B English-only.
    fn multilingual_store() -> BufferStore {
        let mut a_en = annex_row("Unmoored Ego", "oracle-a", "row-a-en", "en", 200.0);
        a_en["illustration_id"] = json!("ill-1");
        let mut a_pt = annex_row("Unmoored Ego", "oracle-a", "row-a-pt", "pt", 100.0);
        a_pt["is_canonical"] = json!(false);
        a_pt["illustration_id"] = json!("ill-1"); // shares the canonical artwork
        a_pt["printed_name"] = json!("Ego à Deriva");
        a_pt["printed_name_folded"] = json!("ego a deriva");
        let mut a_ja = annex_row("Unmoored Ego", "oracle-a", "row-a-ja", "ja", 90.0);
        a_ja["is_canonical"] = json!(false);
        a_ja["illustration_id"] = json!("ill-2"); // foreign-only artwork
        a_ja["printed_name"] = json!("係留を解かれた自我");
        a_ja["printed_name_folded"] = json!("係留を解かれた自我");
        let b_en = annex_row("Other Card", "oracle-b", "row-b-en", "en", 150.0);
        build_store(&[a_en, a_pt, a_ja, b_en]).1
    }

    /// A `lang:xx` filter-tree leaf, the shape the parser emits for `card_lang`.
    fn lang_filter(value: &str) -> Value {
        json!({
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "op": ":",
                "lhs": { "node_type": "CardAttributeNode",
                         "kwargs": { "attribute_name": "card_lang", "original_attribute": "lang" } },
                "rhs": { "node_type": "StringValueNode", "kwargs": { "value": value } },
            }
        })
    }

    fn opts_with(unique: &str, multilingual: bool) -> QueryOptions {
        QueryOptions {
            unique: unique.to_owned(),
            fields: Some(vec!["lang".to_owned(), "printed_name".to_owned()]),
            include_multilingual: multilingual,
            ..QueryOptions::default()
        }
    }

    /// `lang:xx` answers with that language's rows themselves: unique=cards picks the best
    /// matching row IN THE LANGUAGE (the foreign printing object), unique=prints lists them.
    #[test]
    fn a_lang_query_answers_the_foreign_printing() {
        let store = multilingual_store();
        let out = store.query_value(&lang_filter("pt"), &opts_with("card", false)).expect("lang:pt");
        assert_eq!(out.total, 1);
        assert_eq!(out.rows[0]["lang"], json!("pt"), "the Portuguese ROW, not the English rollup");
        assert_eq!(out.rows[0]["printed_name"], json!("Ego à Deriva"));

        let out = store.query_value(&lang_filter("ja"), &opts_with("printing", false)).expect("lang:ja");
        assert_eq!(out.total, 1);
        assert_eq!(out.rows[0]["lang"], json!("ja"));

        // lang:en names the canonical rows — the widened driver over the canonical space.
        let out = store.query_value(&lang_filter("en"), &opts_with("printing", false)).expect("lang:en");
        assert_eq!(out.total, 2);
        // A language nothing carries matches nothing (bound to no vocab id).
        let out = store.query_value(&lang_filter("ko"), &opts_with("card", false)).expect("lang:ko");
        assert_eq!(out.total, 0);
    }

    /// An `oracleid:<uuid>` filter-tree leaf, the shape the parser emits for `oracle_id`.
    fn oracle_id_filter(value: &str) -> Value {
        json!({
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "op": ":",
                "lhs": { "node_type": "CardAttributeNode",
                         "kwargs": { "attribute_name": "oracle_id", "original_attribute": "oracleid" } },
                "rhs": { "node_type": "StringValueNode", "kwargs": { "value": value } },
            }
        })
    }

    /// `oracleid:<uuid>` is the query every card object's `prints_search_uri` carries, so
    /// `unique=prints` over it must answer with exactly that card's printings — and nothing else.
    /// The id resolves through `oracle_by_oracle_id`, folds hex case, and a value naming no card
    /// (unknown id or unparseable text) matches nothing rather than erroring.
    #[test]
    fn an_oracle_id_query_answers_that_cards_printings() {
        let id_a = "43fbfeec-bcaf-48b8-befe-b7346fec5a3a";
        let id_b = "21f45043-5419-4019-8b6c-e5294bd5f549";
        let a1 = annex_row("Card A", id_a, "row-a-1", "en", 200.0);
        let a2 = annex_row("Card A", id_a, "row-a-2", "en", 100.0);
        let b1 = annex_row("Card B", id_b, "row-b-1", "en", 150.0);
        let store = build_store(&[a1, a2, b1]).1;
        let opts = |unique: &str| QueryOptions {
            unique: unique.to_owned(),
            fields: Some(vec!["name".to_owned(), "oracle_id".to_owned()]),
            ..QueryOptions::default()
        };

        let out = store.query_value(&oracle_id_filter(id_a), &opts("printing")).expect("oracleid:A");
        assert_eq!(out.total, 2, "both of A's printings, neither of B's");
        for row in &out.rows {
            assert_eq!(row["name"], json!("Card A"));
        }
        // unique=cards rolls the same match up to one row, the way Scryfall's default does.
        let out = store.query_value(&oracle_id_filter(id_a), &opts("card")).expect("oracleid:A cards");
        assert_eq!(out.total, 1);

        // The parser hands the value on unchanged, so the engine must fold hex case itself.
        let out = store
            .query_value(&oracle_id_filter(&id_a.to_uppercase()), &opts("printing"))
            .expect("oracleid:A uppercase");
        assert_eq!(out.total, 2, "an uppercase uuid names the same card");

        // A well-formed id this store does not hold, and a value that is not a uuid at all: both
        // are ordinary empty results, never an error (the parser deliberately does not validate).
        for miss in ["deadbeef-dead-4bee-8dad-decafbadf00d", "not-a-uuid"] {
            let out = store.query_value(&oracle_id_filter(miss), &opts("printing")).expect(miss);
            assert_eq!(out.total, 0, "{miss} names no card");
        }

        // Negation is the complement over the same exact set — B's row, and only B's.
        let negated = json!({ "node_type": "NotNode", "kwargs": { "operand": oracle_id_filter(id_a) } });
        let out = store.query_value(&negated, &opts("printing")).expect("-oracleid:A");
        assert_eq!(out.total, 1);
        assert_eq!(out.rows[0]["name"], json!("Card B"));
    }

    /// `include_multilingual` widens the row space but `unique=cards` still rolls up to the
    /// English row: every row matches and the canonical row carries the higher prefer score —
    /// no prefer-formula change, exactly Scryfall's observed semantics.
    #[test]
    fn include_multilingual_unique_cards_rolls_up_to_english() {
        let store = multilingual_store();
        let tree = json!({ "node_type": "TrueNode" });
        let out = store.query_value(&tree, &opts_with("card", true)).expect("widened");
        assert_eq!(out.total, 2, "one row per CARD");
        for row in &out.rows {
            assert_eq!(row["lang"], json!("en"), "the rollup representative is the English row");
        }

        // unique=prints: every row of every language, canonical before annex within a card.
        let mut opts = opts_with("printing", true);
        opts.fields = Some(vec!["lang".to_owned(), "name".to_owned()]);
        let out = store.query_value(&tree, &opts).expect("widened prints");
        assert_eq!(out.total, 4);
        // Cards tie on the sort key (no edhrec anywhere), so the page orders by (cid, vpid) —
        // card order is the store's (hashed oracle id), but WITHIN card A the canonical row
        // must precede the annex rows, which come in language order.
        let a_langs: Vec<&str> = out
            .rows
            .iter()
            .filter(|r| r["name"] == json!("Unmoored Ego"))
            .map(|r| r["lang"].as_str().unwrap())
            .collect();
        // English first (it is canonical, so it is in the other space and sorts ahead by vpid),
        // then the annex alphabetically by language code — ja before pt. Measured against
        // api.scryfall.com: `e:khm cn:1 include_multilingual=true` answers en, de, es, fr, it, ja,
        // ko, pt, ru, zhs, zht. It was prefer-desc, which put pt first here.
        assert_eq!(a_langs, ["en", "ja", "pt"], "canonical first, then the annex by language");
    }

    /// `unique=art` over the widened space counts UNION artwork groups: an annex row sharing a
    /// canonical illustration folds into that group (represented by the best row, the canonical
    /// one), and a foreign-only illustration is its own group represented by the foreign row.
    #[test]
    fn include_multilingual_unique_art_counts_union_groups() {
        let store = multilingual_store();
        let tree = json!({ "node_type": "TrueNode" });
        let mut opts = opts_with("artwork", true);
        opts.fields = Some(vec!["lang".to_owned(), "name".to_owned()]);
        let out = store.query_value(&tree, &opts).expect("widened art");
        assert_eq!(out.total, 3, "A's shared group + A's ja-only group + B's group");
        let a_langs: Vec<&str> = out
            .rows
            .iter()
            .filter(|r| r["name"] == json!("Unmoored Ego"))
            .map(|r| r["lang"].as_str().unwrap())
            .collect();
        assert_eq!(a_langs, ["en", "ja"], "shared artwork reps as English; ja-only artwork as the ja row");

        // Without the widening, the same query counts canonical groups only.
        let out = store.query_value(&tree, &opts_with("artwork", false)).expect("canonical art");
        assert_eq!(out.total, 2);
    }

    /// The negative invariant that keeps the default lane free: without a trigger, the annex is
    /// never read. The annex rows here are built to CHANGE the answer if they leaked — they match
    /// every filter below.
    #[test]
    fn a_default_query_never_reads_the_annex() {
        let store = multilingual_store();
        let tree = json!({ "node_type": "TrueNode" });
        for unique in ["card", "printing", "artwork"] {
            let out = store.query_value(&tree, &opts_with(unique, false)).expect("default lane");
            assert_eq!(out.total, 2, "unique={unique}: canonical rows only");
            assert!(out.rows.iter().all(|r| r["lang"] == json!("en")));
        }
    }

    /// An `is:` filter-tree leaf, the shape the parser emits for `card_is_tags`.
    fn is_filter(value: &str) -> Value {
        json!({
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "op": ":",
                "lhs": { "node_type": "CardAttributeNode",
                         "kwargs": { "attribute_name": "card_is_tags", "original_attribute": "is" } },
                "rhs": [value],
            }
        })
    }

    /// The random draw takes a FILTER, and the pool it samples is the filter's answer.
    ///
    /// `/random_search` had no way to exclude anything: `sample_preferred` sampled `0..n_cards`
    /// and the wasm export took no filter, so 13.6% of 1,000 draws on the built corpus came back
    /// `is:extra` while both search surfaces hid exactly those rows.
    ///
    /// Three assertions, and the third is the one that makes this more than a smoke test:
    ///   1. unfiltered, the pool is every card;
    ///   2. filtered, EVERY draw is in the filter's answer, over enough seeds that a leak shows;
    ///   3. the pool is the QUERY's answer — same cards as `query_value` with the same tree, so
    ///      the draw cannot drift from what `/search` would say about the same filter.
    #[test]
    fn a_filtered_random_draw_samples_only_matching_cards() {
        let mut rows = Vec::new();
        for i in 0..12 {
            let mut r = annex_row(&format!("Card {i}"), &format!("oracle-{i}"), &format!("scry-{i}"), "en", 1.0);
            // A third of the corpus is the excluded class, which is close to the real store's
            // share and leaves enough of both kinds that a uniform draw hits each.
            if i % 3 == 0 {
                r["card_is_tags"] = json!({"extra": true});
            }
            rows.push(r);
        }
        let (_b, store) = build_store(&rows);

        let names = |rows: &[Value]| -> Vec<String> {
            let mut v: Vec<String> = rows.iter().map(|r| r["name"].as_str().unwrap_or_default().to_owned()).collect();
            v.sort();
            v
        };

        // 1. No filter: the whole corpus is reachable.
        let all = store.sample_preferred(12, 7, None, None).expect("unfiltered draw");
        assert_eq!(all.len(), 12, "an unfiltered draw of the whole corpus returns every card");

        // The tree `/random_search` sends: NOT is:extra.
        let tree = json!({
            "node_type": "NotNode",
            "kwargs": { "operand": is_filter("extra") }
        });
        let want = store
            .query_value(
                &tree,
                &QueryOptions { limit: 100, fields: Some(vec!["name".to_owned()]), ..QueryOptions::default() },
            )
            .expect("the same filter as a query");
        assert_eq!(want.total, 8, "8 of the 12 fixture cards are not extras");

        // 2. Every draw, over many seeds, is inside that answer.
        let allowed: std::collections::HashSet<String> = names(&want.rows).into_iter().collect();
        for seed in 0..40u64 {
            let drawn = store.sample_preferred(3, seed, Some(&tree), None).expect("filtered draw");
            assert_eq!(drawn.len(), 3, "seed {seed}: the filter admits 8 cards, so 3 are always available");
            for row in &drawn {
                let name = row["name"].as_str().unwrap_or_default();
                assert!(allowed.contains(name), "seed {seed}: {name} is an is:extra card the filter excluded");
            }
        }

        // 3. Asking for more than the filter admits yields the filter's answer EXACTLY — which is
        //    the equality that keeps this route and `/search` from drifting apart.
        let whole = store.sample_preferred(12, 1, Some(&tree), None).expect("draw the whole filtered pool");
        assert_eq!(whole.len(), 8, "the pool is the match set, not the corpus");
        assert_eq!(names(&whole), names(&want.rows));

        // And a TrueNode is the unfiltered pool rather than a query, so the fast path stays.
        let true_tree = json!({ "node_type": "TrueNode" });
        let via_true = store.sample_preferred(12, 7, Some(&true_tree), None).expect("TrueNode draw");
        assert_eq!(names(&via_true), names(&all), "a TrueNode filter draws exactly what no filter draws");
    }

    /// `is:localizedname` reads the printing's printed name — and WIDENS, with no `lang:` written.
    ///
    /// The widening is not a convenience: api.scryfall.com answers 31,294 cards for a bare
    /// `is:localizedname`, and `&unique=prints` shows German, French and Japanese rows coming back.
    /// A canonical-only reading answers with the English printings that happen to carry a printed
    /// name — 182 of them there — and calls that the whole set.
    #[test]
    fn is_localizedname_widens_and_reads_the_printed_name() {
        let store = multilingual_store();
        // No `lang:`, `include_multilingual` false — and the answer is the two ANNEX rows.
        let out = store.query_value(&is_filter("localizedname"), &opts_with("printing", false)).expect("localizedname");
        assert_eq!(out.total, 2, "the pt and ja rows; the canonical English pair carries no printed name");
        // Language order, which is the order the annex is stored in and Scryfall serves.
        let langs: Vec<&str> = out.rows.iter().map(|r| r["lang"].as_str().unwrap()).collect();
        assert_eq!(langs, ["ja", "pt"]);
        assert_eq!(out.rows[1]["printed_name"], json!("Ego à Deriva"));

        // The complement is the canonical rows, over the same widened space.
        let negated = json!({ "node_type": "NotNode", "kwargs": { "operand": is_filter("localizedname") } });
        let out = store.query_value(&negated, &opts_with("printing", false)).expect("-localizedname");
        assert_eq!(out.total, 2);
        assert!(out.rows.iter().all(|r| r["lang"] == json!("en")));
    }

    /// PRESENCE, not "non-English": an ENGLISH printing that carries a printed name matches.
    ///
    /// 182 of them do on api.scryfall.com (om1/66 prints "Rhilex the Accursed" over Agent Venom),
    /// and 4,468 foreign printings print a name byte-identical to the English one and still count.
    /// A rule spelled as "lang != en" or as "printed_name != name" would be wrong on both sets.
    #[test]
    fn is_localizedname_counts_an_english_printing_that_has_one() {
        let mut en = annex_row("Agent Venom", "oracle-v", "row-v-en", "en", 200.0);
        en["printed_name"] = json!("Rhilex the Accursed");
        en["printed_name_folded"] = json!("rhilex the accursed");
        // ...and a printing whose printed name EQUALS its oracle name still counts.
        let mut same = annex_row("Shock", "oracle-s", "row-s-de", "de", 90.0);
        same["is_canonical"] = json!(false);
        same["printed_name"] = json!("Shock");
        same["printed_name_folded"] = json!("shock");
        let plain = annex_row("Shock", "oracle-s", "row-s-en", "en", 200.0);
        let store = build_store(&[en, plain, same]).1;

        let out = store.query_value(&is_filter("localizedname"), &opts_with("printing", false)).expect("localizedname");
        assert_eq!(out.total, 2, "the English printing with a printed name, and the identical-name German one");
        let langs: Vec<&str> = out.rows.iter().map(|r| r["lang"].as_str().unwrap()).collect();
        assert!(langs.contains(&"en"), "an English printing is not excluded for being English");
        assert!(langs.contains(&"de"));
    }

    /// `is:unique` is a SET count over the canonical rows AND the annex.
    ///
    /// Three cards, each built to break a different wrong rule. A: two printings, one set — unique,
    /// so "prints=1" is not the rule (`!"Forest"` is the real-corpus shape, two lea printings of
    /// one set). B: one English set plus a Japanese printing in a set of its own — NOT unique, the
    /// case a canonical-only walk gets wrong on 130 real cards (Salvat, ps11, pmei). C: an English
    /// row and a Japanese row in the SAME set — unique, so the annex cannot merely be counted.
    #[test]
    fn is_unique_counts_sets_across_the_annex() {
        let set_of = |mut row: Value, code: &str, cn: &str| -> Value {
            row["card_set_code"] = json!(code);
            row["collector_number"] = json!(cn);
            row
        };
        let mut rows = vec![
            set_of(annex_row("A", "oracle-a", "row-a-1", "en", 200.0), "aaa", "1"),
            set_of(annex_row("A", "oracle-a", "row-a-2", "en", 190.0), "aaa", "2"),
            set_of(annex_row("B", "oracle-b", "row-b-en", "en", 200.0), "aaa", "3"),
            set_of(annex_row("B", "oracle-b", "row-b-ja", "ja", 90.0), "bbb", "3"),
            set_of(annex_row("C", "oracle-c", "row-c-en", "en", 200.0), "aaa", "4"),
            set_of(annex_row("C", "oracle-c", "row-c-ja", "ja", 90.0), "aaa", "4"),
        ];
        for r in &mut rows {
            if r["card_compat_blob"]["lang"] != json!("en") {
                r["is_canonical"] = json!(false);
                r["printed_name"] = json!("名");
                r["printed_name_folded"] = json!("名");
            }
        }
        let store = build_store(&rows).1;

        let opts = QueryOptions { unique: "card".to_owned(), fields: Some(vec!["name".to_owned()]), ..QueryOptions::default() };
        let out = store.query_value(&is_filter("unique"), &opts).expect("is:unique");
        let names: Vec<&str> = out.rows.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(out.total, 2);
        assert_eq!(names, ["A", "C"], "B's Japanese-only second set disqualifies it");

        // It does NOT widen — asking about a card's set count is not asking for foreign rows.
        assert!(!store.query_widens(&is_filter("unique"), &opts).expect("widens?"));
        // ...where the printed-name predicate does.
        assert!(store.query_widens(&is_filter("localizedname"), &opts).expect("widens?"));
    }

    /// `lang:` + `unique=cards` follows the query's OWN English pick, not the card's global one.
    ///
    /// The Maskwood Nexus shape, from the live-parity ledger: the card's representative printing
    /// lives in ANOTHER set (clb 865), so no khm row carries the importer's PIN_BONUS, and the two
    /// khm ja rows are left to a tiebreak Scryfall's data does not supply — its ja extended-art
    /// printing has no `frame_effects`, so the -6 that separates the English pair (#240 over #369)
    /// does not exist between the annex rows. api.scryfall.com answers khm ja #240 anyway, because
    /// it follows the best English row IN THE QUERIED SET.
    ///
    /// The fixture makes the wrong answer the easy one: ja #369 outscores ja #240 on its own
    /// prefer, so a per-row rule picks #369. Only reading the canonical row at each slot, under
    /// the query with its language lifted, gets #240.
    #[test]
    fn a_language_pick_follows_the_english_row_in_the_querys_own_set() {
        let mut rows = Vec::new();
        // The card's GLOBAL representative, in a set the query does not ask for.
        let mut clb = annex_row("Maskwood Nexus", "oracle-m", "row-m-clb", "en", 240.0);
        clb["card_set_code"] = json!("clb");
        clb["collector_number"] = json!("865");
        rows.push(clb);
        // The two English khm rows: #240 beats #369 by the extended-art penalty.
        for (cn, prefer) in [("240", 197.36), ("369", 191.36)] {
            let mut r = annex_row("Maskwood Nexus", "oracle-m", &format!("row-m-khm-{cn}"), "en", prefer);
            r["card_set_code"] = json!("khm");
            r["collector_number"] = json!(cn);
            rows.push(r);
        }
        // The two Japanese khm rows, at the same two slots — and the WRONG one scores higher.
        for (cn, prefer) in [("240", 90.0), ("369", 95.0)] {
            let mut r = annex_row("Maskwood Nexus", "oracle-m", &format!("row-m-khm-{cn}-ja"), "ja", prefer);
            r["is_canonical"] = json!(false);
            r["card_set_code"] = json!("khm");
            r["collector_number"] = json!(cn);
            r["printed_name"] = json!("仮面の樹の交錯점");
            r["printed_name_folded"] = json!("仮面の樹の交錯점");
            rows.push(r);
        }
        let store = build_store(&rows).1;
        let khm = json!({
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "op": ":",
                "lhs": { "node_type": "CardAttributeNode",
                         "kwargs": { "attribute_name": "card_set_code", "original_attribute": "set" } },
                "rhs": { "node_type": "StringValueNode", "kwargs": { "value": "khm" } },
            }
        });
        let scoped = json!({ "node_type": "AndNode", "kwargs": { "operands": [khm.clone(), lang_filter("ja")] } });

        let opts = |unique: &str, ml: bool| QueryOptions {
            unique: unique.to_owned(),
            fields: Some(vec!["collector_number".to_owned(), "lang".to_owned()]),
            include_multilingual: ml,
            ..QueryOptions::default()
        };

        let out = store.query_value(&scoped, &opts("card", false)).expect("lang-scoped");
        assert_eq!(out.total, 1, "one card");
        assert_eq!(out.rows[0]["lang"], json!("ja"));
        assert_eq!(out.rows[0]["collector_number"], json!("240"), "follows the best khm ENGLISH row, not the ja score");

        // The row that outscores it is still THERE — this reorders the representative, it does not
        // drop anything.
        let prints = store.query_value(&scoped, &opts("printing", false)).expect("prints");
        assert_eq!(prints.total, 2, "both ja rows still match");

        // And the English lane is unmoved: include_multilingual rolls up to the global English
        // representative exactly as before, annex ranking never consulted.
        let all = store.query_value(&json!({ "node_type": "TrueNode" }), &opts("card", true)).expect("ml");
        assert_eq!(all.rows[0]["lang"], json!("en"));
        assert_eq!(all.rows[0]["collector_number"], json!("865"), "clb 865 is still the card's own pick");
    }

    /// An annex row whose slot has no canonical row in scope keeps the pick phase 1 made.
    ///
    /// The fallback half of the rule above: a foreign-only printing has no English row to follow,
    /// so nothing overrides its own prefer score and `unique=cards` answers the best of them.
    #[test]
    fn a_foreign_only_slot_keeps_its_own_pick() {
        let mut rows = Vec::new();
        let mut en = annex_row("Solo Print", "oracle-s", "row-s-en", "en", 200.0);
        en["card_set_code"] = json!("khm");
        en["collector_number"] = json!("5");
        rows.push(en);
        for (cn, prefer) in [("900", 60.0), ("901", 80.0)] {
            let mut r = annex_row("Solo Print", "oracle-s", &format!("row-s-{cn}-ja"), "ja", prefer);
            r["is_canonical"] = json!(false);
            r["card_set_code"] = json!("khm");
            r["collector_number"] = json!(cn);
            rows.push(r);
        }
        let store = build_store(&rows).1;
        let out = store
            .query_value(
                &lang_filter("ja"),
                &QueryOptions {
                    unique: "card".to_owned(),
                    fields: Some(vec!["collector_number".to_owned()]),
                    ..QueryOptions::default()
                },
            )
            .expect("lang-scoped");
        assert_eq!(out.rows[0]["collector_number"], json!("901"), "no English row at either slot; best own score wins");
    }

    /// Every by-id entry point addresses BOTH printing spaces.
    ///
    /// A foreign Scryfall id — and a multiverse id only a foreign row carries — resolves to the
    /// FOREIGN printing object. Searching `printing_by_scryfall_id` alone was what made
    /// `/cards/<foreign id>`, `/cards/multiverse/<foreign>`, that card's rulings (addressed by
    /// the same id) and `POST /cards/collection` with a foreign `{id}` all answer "no such card"
    /// about a row `/cards/<set>/<number>/<lang>` was serving at the same moment.
    #[test]
    fn every_by_id_lookup_reaches_the_annex() {
        let mut a_en = annex_row("Unmoored Ego", "oracle-a", "row-a-en", "en", 200.0);
        a_en["card_compat_blob"]["multiverse_ids"] = json!([451111]);
        let mut a_pt = annex_row("Unmoored Ego", "oracle-a", "row-a-pt", "pt", 100.0);
        a_pt["is_canonical"] = json!(false);
        a_pt["printed_name"] = json!("Ego à Deriva");
        a_pt["printed_name_folded"] = json!("ego a deriva");
        a_pt["card_compat_blob"]["multiverse_ids"] = json!([454775]);
        let b_en = annex_row("Other Card", "oracle-b", "row-b-en", "en", 150.0);
        let (_b, store) = build_store(&[a_en, a_pt, b_en]);
        let fields = Some(vec!["lang".to_owned(), "printed_name".to_owned(), "name".to_owned()]);

        // One id at a time: the annex row, and the canonical row still exactly as before.
        let pt = store.card_by_scryfall_id("row-a-pt", fields.clone()).expect("lookup").expect("a foreign id resolves");
        assert_eq!(pt["lang"], json!("pt"));
        assert_eq!(pt["printed_name"], json!("Ego à Deriva"));
        assert_eq!(pt["name"], json!("Unmoored Ego"), "oracle fields stay English");
        let en = store.card_by_scryfall_id("row-a-en", fields.clone()).expect("lookup").expect("canonical id");
        assert_eq!(en["lang"], json!("en"));
        assert_eq!(en["printed_name"], json!(null));

        // The batch (POST /cards/collection): both spaces, in the order asked, misses skipped.
        let ids = ["row-a-pt".to_owned(), "row-never-imported".to_owned(), "row-b-en".to_owned()];
        let batch = store.cards_by_scryfall_ids(&ids, fields.clone()).expect("batch");
        assert_eq!(batch.len(), 2, "the unknown id is skipped, never faked");
        assert_eq!(batch[0]["lang"], json!("pt"));
        assert_eq!(batch[1]["name"], json!("Other Card"));

        // External ids: the foreign multiverse id lives ONLY in the annex index.
        let mv_pt =
            store.card_by_external_id("multiverse", 454775, fields.clone()).expect("ext").expect("foreign multiverse");
        assert_eq!(mv_pt["lang"], json!("pt"));
        let mv_en =
            store.card_by_external_id("multiverse", 451111, fields.clone()).expect("ext").expect("canonical multiverse");
        assert_eq!(mv_en["lang"], json!("en"));

        // An unknown id must still MISS — in both spaces. Widening the search is only correct if
        // it cannot turn a 404 into some other card.
        assert!(store.card_by_scryfall_id("row-never-imported", fields.clone()).expect("lookup").is_none());
        assert!(store.card_by_external_id("multiverse", 999_999, fields.clone()).expect("ext").is_none());
        assert!(store.cards_by_scryfall_ids(&["row-never-imported".to_owned()], fields).expect("batch").is_empty());
    }

    /// A foreign printed name resolves to the FOREIGN printing object — through the CONTAINMENT
    /// stage, which is the stage Scryfall resolves it with.
    ///
    /// The typo scan behind `fuzzy_card_by_name` is English-only, and that is measured, not a
    /// simplification (api.scryfall.com, 2026-08-16): `fuzzy=blitzschlag` resolves the German
    /// printing of Lightning Bolt while `fuzzy=blitzschlagg` answers 404, and `fuzzy=ego a
    /// deriva` resolves the Portuguese printing while `fuzzy=ego a derva` answers 404. A printed
    /// name gets EXACT tolerance, never typo tolerance — so this test asserts both halves: the
    /// typo scan misses the foreign name, and the containment stage answers it.
    #[test]
    fn fuzzy_resolves_a_foreign_printed_name_to_the_foreign_printing() {
        let store = multilingual_store();
        let fields = Some(vec!["lang".to_owned(), "printed_name".to_owned(), "name".to_owned()]);
        let floor = crate::FUZZY_SCORE_FLOOR;
        let lead = crate::FUZZY_SCORE_LEAD;

        // THE TYPO SCAN: English names only, so a foreign needle finds nothing here.
        let (status, _) = store.fuzzy_card_by_name("ego a deriva", floor, lead, fields.clone()).expect("fuzzy");
        assert_eq!(status, "miss", "the typo scan does not read printed names");

        // THE CONTAINMENT STAGE, which the route reaches next, answers with the pt printing.
        let hits = store
            .cards_containing_all_words(&["ego".to_owned(), "a".to_owned(), "deriva".to_owned()], None, 2, fields.clone())
            .expect("containment");
        assert_eq!(hits.len(), 1, "one answer, not ambiguous");
        assert_eq!(hits[0]["lang"], json!("pt"), "the Portuguese printing object");
        assert_eq!(hits[0]["printed_name"], json!("Ego à Deriva"));
        assert_eq!(hits[0]["name"], json!("Unmoored Ego"), "oracle fields stay English");

        // An English needle keeps answering exactly what it always did, on the typo scan.
        let (status, card) = store.fuzzy_card_by_name("unmoored ego", floor, lead, fields).expect("fuzzy en");
        assert_eq!(status, "hit");
        assert_eq!(card.expect("hit")["lang"], json!("en"));
    }

    /// Ambiguity is counted by ORACLE CARD: a card's own name never competes with itself, while
    /// the same near-tie across two DIFFERENT cards still reads ambiguous.
    ///
    /// Both cards here are English, because the typo scan is: a foreign printed name reaches
    /// `?fuzzy=` through exact and containment (see
    /// `fuzzy_resolves_a_foreign_printed_name_to_the_foreign_printing`), so a card's foreign name
    /// cannot make it ambiguous with itself for the simpler reason that this scan never sees it.
    #[test]
    fn fuzzy_ambiguity_counts_cards_not_strings() {
        let floor = crate::FUZZY_SCORE_FLOOR;
        let lead = crate::FUZZY_SCORE_LEAD;
        // ONE card with two printings: two rows, one name, one answer.
        let a1 = annex_row("Fire Dragon", "oracle-c", "row-c-1", "en", 200.0);
        let a2 = annex_row("Fire Dragon", "oracle-c", "row-c-2", "en", 100.0);
        let (_b, store) = build_store(&[a1.clone(), a2]);
        let (status, _) = store.fuzzy_card_by_name("fire dragen", floor, lead, None).expect("fuzzy");
        assert_eq!(status, "hit", "one card's own printings must not make it ambiguous with itself");

        // The near-tie across two different CARDS stays ambiguous: "fire dragen" is one
        // substitution from both "fire dragon" and "fire dragan" and differs from each in the
        // same three trigrams, so the two score identically and neither leads.
        let other = annex_row("Fire Dragan", "oracle-d", "row-d-1", "en", 150.0);
        let (_b, store) = build_store(&[a1, other]);
        let (status, _) = store.fuzzy_card_by_name("fire dragen", floor, lead, None).expect("fuzzy");
        assert_eq!(status, "ambiguous", "two cards' near-tied names still read ambiguous");
    }

    /// The two name surfaces over one scan: a collection identifier's `name` reads a card's FACE
    /// names when the name splits in exactly two and its whole name otherwise; `exact=` reads that
    /// set PLUS the joined name.
    ///
    /// Measured against api.scryfall.com on 2026-08-31, one identifier per request:
    /// `{"name":"Delver of Secrets"}` and `{"name":"Insectile Aberration"}` both answer the card,
    /// `{"name":"Delver of Secrets // Insectile Aberration"}` is not_found while
    /// `exact=Delver of Secrets // Insectile Aberration` is the card, `{"name":"Who"}` and
    /// `exact=Who` are both not_found, and `{"name":"Who // What // When // Where // Why"}` and
    /// `exact=` of the same string are both und/75.
    #[test]
    fn a_collection_identifier_reads_faces_where_exact_also_reads_the_joined_name() {
        let two = annex_row("Delver of Secrets // Insectile Aberration", "oracle-dfc", "row-dfc", "en", 200.0);
        let five = annex_row("Who // What // When // Where // Why", "oracle-five", "row-five", "en", 150.0);
        let store = build_store(&[two, five]).1;
        let exact = |n: &str| store.exact_card_by_name(n, None, None).expect("exact").is_some();
        let coll = |n: &str| store.collection_card_by_name(n, None, None).expect("collection").is_some();

        // A FACE names the card on both surfaces, front and back alike.
        for needle in ["delver of secrets", "insectile aberration"] {
            assert!(exact(needle), "exact= resolves a face name");
            assert!(coll(needle), "a collection identifier resolves a face name");
        }
        // The JOINED name is the one card both surfaces disagree about.
        let joined = "delver of secrets // insectile aberration";
        assert!(exact(joined), "exact= answers the joined name");
        assert!(!coll(joined), "a collection identifier does not");

        // MORE than two halves: the whole name is the key and its parts are not, on both.
        let five_name = "who // what // when // where // why";
        assert!(exact(five_name) && coll(five_name), "the five-part name is a key on both");
        assert!(!exact("who") && !coll("who"), "and none of its parts is, on either");
    }

    /// Both name surfaces compare COLLATED names — punctuation and spacing removed — which is what
    /// Scryfall compares. Measured 2026-08-31 on api.scryfall.com: `exact=limduls vault`,
    /// `exact=Lightning-Bolt`, `exact=delverofsecrets` and the same three as collection
    /// identifiers all resolve, where a folded comparison answers 404 on every one.
    #[test]
    fn name_lookups_compare_collated_names() {
        let mut vault = annex_row("Lim-Dûl's Vault", "oracle-vault", "row-vault", "en", 200.0);
        vault["card_name_folded"] = json!("lim-dul's vault");
        let dfc = annex_row("Delver of Secrets // Insectile Aberration", "oracle-dfc", "row-dfc", "en", 150.0);
        let store = build_store(&[vault, dfc]).1;
        for needle in ["limduls vault", "lim-duls vault", "limdulsvault"] {
            assert!(store.exact_card_by_name(needle, None, None).expect("exact").is_some(), "exact= {needle}");
            assert!(store.collection_card_by_name(needle, None, None).expect("coll").is_some(), "collection {needle}");
        }
        // A FACE collates the same way, and the join it sits beside does not leak into it.
        assert!(store.collection_card_by_name("delverofsecrets", None, None).expect("coll").is_some());
        assert!(store.collection_card_by_name("secretsinsectile", None, None).expect("coll").is_none());
    }

    /// A FLAVOR name is `exact=`'s fallback and no part of a collection identifier.
    ///
    /// api.scryfall.com, 2026-08-31: `exact=Godzilla, King of the Monsters` answers Zilortha and
    /// `{"name":"Godzilla, King of the Monsters"}` is not_found; likewise `Yojimbo` (Solitude) and
    /// `Godzilla, Primeval Champion` (Titanoth Rex).
    #[test]
    fn a_flavor_name_answers_exact_and_never_a_collection_identifier() {
        let mut zilortha = annex_row("Zilortha, Strength Incarnate", "oracle-z", "row-z", "en", 200.0);
        zilortha["flavor_name"] = json!("Godzilla, King of the Monsters");
        zilortha["flavor_name_folded"] = json!("godzilla, king of the monsters");
        let store = build_store(&[zilortha]).1;
        let needle = "godzilla, king of the monsters";
        assert!(store.exact_card_by_name(needle, None, None).expect("exact").is_some(), "exact= reads it");
        assert!(store.collection_card_by_name(needle, None, None).expect("coll").is_none(), "a collection id does not");
        // The oracle name still answers both.
        assert!(store.collection_card_by_name("zilortha, strength incarnate", None, None).expect("coll").is_some());
    }

    /// `exact=` is scoped to the ORACLE name and never reads printed names — the negative
    /// invariant, pinned the same way autocomplete's foreign exclusion is.
    ///
    /// Verified against api.scryfall.com on 2026-08-16: `exact=アクスガルドの自慢屋`,
    /// `exact=Ego à Deriva`, `exact=Ego a Deriva` and `exact=Impacto` are all 404 not_found,
    /// while `fuzzy=` resolves the same needles to the foreign printing. Not a script or accent
    /// rule — a lane rule. Answering these would be a 200 where Scryfall answers 404.
    #[test]
    fn exact_never_reads_printed_names() {
        let store = multilingual_store();
        let fields = Some(vec!["lang".to_owned(), "printed_name".to_owned()]);
        assert!(
            store.exact_card_by_name("ego a deriva", None, fields.clone()).expect("exact").is_none(),
            "a well-formed foreign printed name is a MISS on exact, as it is on Scryfall"
        );
        assert!(store.exact_card_by_name("係留を解かれた自我", None, fields.clone()).expect("exact").is_none());
        // The English/oracle name keeps answering, and answers with the English printing.
        let hit = store.exact_card_by_name("unmoored ego", None, fields.clone()).expect("exact").expect("hit");
        assert_eq!(hit["lang"], json!("en"));

        // Nor by a `//` half of a printed name — the other class the deleted record lookup had.
        let mut es = annex_row("Sudden Rescue // Steady Return", "oracle-p", "row-p-es", "es", 90.0);
        es["is_canonical"] = json!(false);
        es["printed_name_folded"] = json!("rescate repentino // regreso constante");
        let en = annex_row("Sudden Rescue // Steady Return", "oracle-p", "row-p-en", "en", 200.0);
        let (_b, store) = build_store(&[en, es]);
        assert!(store.exact_card_by_name("rescate repentino", None, fields.clone()).expect("exact").is_none());
        // While the ENGLISH half still resolves — Scryfall's `exact=Delver of Secrets` rule.
        assert!(store.exact_card_by_name("sudden rescue", None, fields).expect("exact").is_some());
    }

    /// The containment stage searches printed names too, deduped by oracle card: a card whose
    /// English name already answered does not answer again under its printed name, and a
    /// foreign-only containment hit materializes the foreign printing.
    #[test]
    fn containment_searches_printed_names_deduped_by_card() {
        let store = multilingual_store();
        let fields = Some(vec!["lang".to_owned()]);
        // "ego" is in card A's English name AND its pt printed name: ONE answer (the English one),
        // or the fuzzy lane would call every such card ambiguous with itself.
        let rows = store.cards_containing_all_words(&["ego".to_owned()], None, 2, fields.clone()).expect("contains");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["lang"], json!("en"));
        // "deriva" exists only in the pt printed name: the foreign printing answers.
        let rows = store.cards_containing_all_words(&["deriva".to_owned()], None, 2, fields).expect("contains");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["lang"], json!("pt"));
    }

    /// Scryfall's containment slack, both halves, on the printing that made the mirror's
    /// `named-fuzzy-red-goad` deviation: separators do not count, and the pool is the PRINTING's
    /// names rather than any one of them.
    ///
    /// Measured on api.scryfall.com 2026-08-16: `fuzzy=red goad` and `fuzzy=goad red` both answer
    /// the Portuguese printing of Unmoored Ego, `fuzzy=redgoad` answers not_found (the words are
    /// matched separately, never rejoined), and `fuzzy=red goad xyzzy` answers not_found (EVERY
    /// word must land somewhere).
    #[test]
    fn containment_ignores_separators_and_pools_a_printings_names() {
        let store = multilingual_store();
        let fields = Some(vec!["lang".to_owned(), "printed_name".to_owned(), "name".to_owned()]);
        let words = |ws: &[&str]| ws.iter().map(|w| (*w).to_owned()).collect::<Vec<String>>();

        // "red" is inside "unmoo|red| ego"; "goad" is inside "eg|o a d|eriva" once the printed
        // name's spaces stop counting. Neither name carries both — the printing does.
        for query in [["red", "goad"], ["goad", "red"]] {
            let rows = store.cards_containing_all_words(&words(&query), None, 2, fields.clone()).expect("contains");
            assert_eq!(rows.len(), 1, "{query:?} identifies exactly one card");
            assert_eq!(rows[0]["lang"], json!("pt"), "{query:?} answers the printing that completed it");
            assert_eq!(rows[0]["printed_name"], json!("Ego à Deriva"));
            assert_eq!(rows[0]["name"], json!("Unmoored Ego"), "oracle fields stay English");
        }

        // Rejoined, it is one word no name spells: the words are matched one at a time, and
        // "redgoad" is contiguous in nothing (api.scryfall.com answers not_found, as it does for
        // "goadderiva" — while "egoaderiva", which IS contiguous once the spaces go, resolves).
        let rows = store.cards_containing_all_words(&words(&["redgoad"]), None, 2, fields.clone()).expect("contains");
        assert!(rows.is_empty());
        // One word spanning two of a printed name's spaces, and one spanning an oracle name's:
        // both resolve, which is the narrowing's real test — the index has no window of either.
        let rows = store.cards_containing_all_words(&words(&["egoaderiva"]), None, 2, fields.clone()).expect("c");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["lang"], json!("pt"), "the printed name that spells it");
        let rows = store.cards_containing_all_words(&words(&["unmooredego"]), None, 2, fields.clone()).expect("c");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["lang"], json!("en"));
        // And a word nothing carries sinks the whole query, however well the others match.
        let rows =
            store.cards_containing_all_words(&words(&["red", "goad", "xyzzy"]), None, 2, fields.clone()).expect("c");
        assert!(rows.is_empty());

        // The mixed pool does not widen to a SECOND card's names: "other" (card B's English name)
        // with "deriva" (card A's pt printed name) is nobody's printing.
        let rows = store.cards_containing_all_words(&words(&["other", "deriva"]), None, 2, fields).expect("contains");
        assert!(rows.is_empty());
    }

    /// A name that IS the query outranks every name that merely carries its letters, and ends the
    /// ambiguity question — the corpus really does hold both "Lightning Bolt" and "Emeritus of
    /// Conflict // Lightning Bolt", and `fuzzy=lightningbolt` answers the first on
    /// api.scryfall.com (2026-08-16) rather than reporting two.
    #[test]
    fn containment_prefers_the_name_that_is_the_query() {
        let bolt = annex_row("Lightning Bolt", "oracle-a", "row-a-en", "en", 100.0);
        // The split card outscores it, so a prefer-score-only rule answers the wrong one.
        let split = annex_row("Emeritus of Conflict // Lightning Bolt", "oracle-b", "row-b-en", "en", 200.0);
        let store = build_store(&[bolt, split]).1;
        let fields = Some(vec!["name".to_owned()]);
        let words = |ws: &[&str]| ws.iter().map(|w| (*w).to_owned()).collect::<Vec<String>>();

        for query in [vec!["lightningbolt"], vec!["lightning", "bolt"]] {
            let rows = store.cards_containing_all_words(&words(&query), None, 2, fields.clone()).expect("contains");
            assert_eq!(rows.len(), 1, "{query:?} is one answer, not an ambiguous pair");
            assert_eq!(rows[0]["name"], json!("Lightning Bolt"));
        }
        // A word only ONE of them carries still reaches the other, unranked and alone.
        let rows = store.cards_containing_all_words(&words(&["emeritus"]), None, 2, fields).expect("contains");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], json!("Emeritus of Conflict // Lightning Bolt"));
    }

    /// Which PRINTING answers when several of a card's printed names carry every word: the
    /// shortest one, which is the exact printed name whenever the corpus holds it.
    ///
    /// `fuzzy=ego à deriva` answers the PORTUGUESE printing on api.scryfall.com (2026-08-16)
    /// even though the Spanish "Ego a la deriva" and Italian "Ego alla Deriva" contain the same
    /// three words — and the Italian row here outscores the Portuguese one deliberately, so a
    /// prefer-score-only rule fails this test.
    #[test]
    fn containment_answers_with_the_shortest_completing_printed_name() {
        let mut pt = annex_row("Unmoored Ego", "oracle-a", "row-a-pt", "pt", 100.0);
        pt["is_canonical"] = json!(false);
        pt["printed_name"] = json!("Ego à Deriva");
        pt["printed_name_folded"] = json!("ego a deriva");
        let mut it = annex_row("Unmoored Ego", "oracle-a", "row-a-it", "it", 180.0);
        it["is_canonical"] = json!(false);
        it["printed_name"] = json!("Ego alla Deriva");
        it["printed_name_folded"] = json!("ego alla deriva");
        let mut es = annex_row("Unmoored Ego", "oracle-a", "row-a-es", "es", 170.0);
        es["is_canonical"] = json!(false);
        es["printed_name"] = json!("Ego a la deriva");
        es["printed_name_folded"] = json!("ego a la deriva");
        let store = build_store(&[annex_row("Unmoored Ego", "oracle-a", "row-a-en", "en", 200.0), pt, it, es]).1;
        let fields = Some(vec!["lang".to_owned()]);
        let words = ["ego", "a", "deriva"].iter().map(|w| (*w).to_owned()).collect::<Vec<String>>();
        let rows = store.cards_containing_all_words(&words, None, 2, fields).expect("contains");
        assert_eq!(rows.len(), 1, "one card, however many of its printings carry the words");
        assert_eq!(rows[0]["lang"], json!("pt"), "the printed name that IS the query, not the best-scoring one");
    }

    /// Autocomplete stays English/canonical — verified against the live API: Scryfall's
    /// autocomplete has no include_multilingual and returns nothing for foreign names.
    #[test]
    fn autocomplete_excludes_printed_names() {
        let store = multilingual_store();
        assert_eq!(store.autocomplete("ego", 20), vec!["Unmoored Ego"], "the English name only");
        assert!(store.autocomplete("deriva", 20).is_empty(), "a printed name never autocompletes");
    }

    /// A named catalog row, with the folded name the importer would have written.
    fn catalog_row(name: &str, oracle: &str) -> Value {
        annex_row(name, oracle, &format!("row-{oracle}-en"), "en", 100.0)
    }

    /// The autocomplete ORDER is `pg_trgm` similarity, not name length — the two shapes where
    /// the two disagree, both taken from api.scryfall.com's own answers (2026-08-17).
    ///
    ///   `q=lig`  `Light Up the Night` (15 collated characters) before `Lightning Angel` (14),
    ///           because `igh` and `ght` each occur twice and a trigram SET holds one of each.
    ///   `q=ser`  `Serra Avenger` (12) before `Serenity` (8), because the query's closing `er `
    ///           window is one `Serra Avenger` has and `Serenity` does not.
    ///
    /// Both are asserted against the length key as well, so a relapse to `length(card_name)`
    /// fails here rather than 18 rows into a live sweep.
    #[test]
    fn autocomplete_orders_by_trigram_similarity_not_length() {
        let store = build_store(&[
            catalog_row("Light Up the Night", "oracle-lutn"),
            catalog_row("Lightning Angel", "oracle-la"),
            catalog_row("Serra Avenger", "oracle-sa"),
            catalog_row("Serenity", "oracle-sy"),
        ])
        .1;
        assert_eq!(
            store.autocomplete("lig", 20),
            vec!["Light Up the Night", "Lightning Angel"],
            "a repeated window shrinks the trigram set, so the LONGER name leads"
        );
        assert_eq!(
            store.autocomplete("ser", 20),
            vec!["Serra Avenger", "Serenity"],
            "sharing the query's closing window outranks being five characters shorter"
        );
        // The key this replaces, spelled out: it gets both pairs backwards.
        for (a, b) in [("Light Up the Night", "Lightning Angel"), ("Serra Avenger", "Serenity")] {
            assert!(a.chars().count() > b.chars().count(), "{a} is longer than {b}, so `ORDER BY length` reverses them");
        }
    }

    /// The catalog excludes extras, per card: `Shark` is a token in this corpus and is absent
    /// from Scryfall's `q=sha`, while a name printed BOTH as a token and as a served card is
    /// still offered.
    #[test]
    fn autocomplete_excludes_extras() {
        let mut token = catalog_row("Shark", "oracle-shark");
        token["card_is_tags"] = json!({"extra": true});
        let mut both_token = catalog_row("Shatter", "oracle-shatter-token");
        both_token["scryfall_id"] = json!("row-shatter-token");
        both_token["card_is_tags"] = json!({"extra": true});
        // Same oracle id as the served printing, so the two are one card with two printings.
        both_token["oracle_id"] = json!("oracle-shatter");
        let store = build_store(&[token, both_token, catalog_row("Shatter", "oracle-shatter")]).1;
        assert_eq!(
            store.autocomplete("sha", 20),
            vec!["Shatter"],
            "a card with no served printing leaves the catalog; one with any served printing stays"
        );
    }

    /// The rank split and the match predicate are asked of the COLLATED name, which is measured:
    /// api.scryfall.com answers `q=gob` with `_____ Goblin` FIRST (it collates to `goblin`, a
    /// prefix) and answers `q=ningbolt` with `Lightning Bolt` (`ningbolt` is a substring of
    /// `lightningbolt` and of no spelling that keeps the space).
    #[test]
    fn autocomplete_ranks_and_matches_the_collated_name() {
        let store = build_store(&[
            catalog_row("_____ Goblin", "oracle-blank"),
            catalog_row("Goblin Welder", "oracle-welder"),
            catalog_row("Lightning Bolt", "oracle-bolt"),
        ])
        .1;
        assert_eq!(
            store.autocomplete("gob", 20),
            vec!["_____ Goblin", "Goblin Welder"],
            "underscores are not part of the name the prefix rank is asked about"
        );
        assert_eq!(
            store.autocomplete("ningbolt", 20),
            vec!["Lightning Bolt"],
            "a needle spanning a space matches, because both sides are compared collated"
        );
    }

    /// The perf property behind the foreign name paths: candidates come off the record trigram
    /// index, not a record scan. Exact and containment are the index-driven stages; the fuzzy
    /// scan is English-only and does not read these records at all (lib.rs's module comment has
    /// the Scryfall evidence — a foreign printed name gets no typo tolerance).
    #[test]
    fn printed_records_narrow_by_shared_windows() {
        let store = multilingual_store();
        let d = store.data();
        let pn = &d.indexes.printed_names;
        assert_eq!(pn.name_ids.len(), 2, "pt + ja records");
        // A needle sharing every window with only the pt record narrows to it alone.
        let hits = crate::trigram_candidates(&pn.trigrams, "deriva").expect("index applies");
        assert_eq!(hits.len(), 1);
        // A needle sharing no window with any record narrows to nothing.
        assert!(crate::trigram_candidates(&pn.trigrams, "zzzzzz").expect("index applies").is_empty());
    }

    /// The artist reaches the card object AS PRINTED — uppercase, diacritics — while search
    /// keeps narrowing on the lowercased artist vocab.
    ///
    /// Fixture parity could never catch the cross-vocab defect this pins: both twins read the
    /// same emitted row JSON, so they agreed byte-for-byte on the scrambled value. The
    /// live-parity harness against api.scryfall.com is what found it in production ("fumes" for
    /// Franz Vohwinkel, "blue-magic" for Milivoj Ćeran — collection-vocab strings, because
    /// `card_artist_vid` indexes the ARTIST vocab and was resolved against the collection one,
    /// and even the artist vocab holds only the lowercased search form). This is the offline
    /// regression pin for the fix: the printed string has its own interned id.
    #[test]
    fn the_artist_round_trips_in_original_case_and_searches_lowercased() {
        let mut row = annex_row("Shock", "oracle-a", "row-a-en", "en", 200.0);
        row["card_artist"] = json!("Milivoj Ćeran");
        // Populate the collection vocab so a relapse into the cross-vocab read has strings to
        // scramble into rather than an index panic.
        row["card_keywords"] = json!({"flying": {}, "haste": {}});
        let (_b, store) = build_store(&[row]);
        let d = store.data();
        let fields = resolve_fields_json(Some(vec!["artist".to_owned()])).expect("artist resolves");
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["artist"], json!("Milivoj Ćeran"), "original case, from the string table");

        // And the search side still narrows through the lowercased artist vocab.
        let tree = json!({
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "op": ":",
                "lhs": { "node_type": "CardAttributeNode",
                         "kwargs": { "attribute_name": "card_artist", "original_attribute": "artist" } },
                "rhs": { "node_type": "StringValueNode", "kwargs": { "value": "ćeran" } },
            }
        });
        let opts = QueryOptions { fields: Some(vec!["artist".to_owned()]), ..QueryOptions::default() };
        let out = store.query_value(&tree, &opts).expect("artist search");
        assert_eq!(out.total, 1, "the lowercased vocab still answers artist:");
        assert_eq!(out.rows[0]["artist"], json!("Milivoj Ćeran"));

        // An artistless printing stays an absent key, not an empty string.
        let (_b, store) = build_store(&[annex_row("Other Card", "oracle-b", "row-b-en", "en", 150.0)]);
        let d = store.data();
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["artist"], json!(null));
    }

    /// `games` survives the archive in SCRYFALL's order, not a fixed one.
    ///
    /// The byte spends its low three bits on membership and the next three on a GAME_ORDERS index
    /// (see the constant), so this is really two assertions in one: the emitted array is the
    /// payload's own order, and the membership bits underneath are still exactly the members —
    /// which is what every pre-order reader of the byte meant by it.
    #[test]
    fn games_keep_the_order_the_payload_listed_them_in() {
        for listed in [
            json!(["arena", "paper", "mtgo"]),
            json!(["paper", "arena", "mtgo"]),
            json!(["paper", "mtgo", "arena"]),
            json!(["mtgo", "paper"]),
            json!(["paper"]),
        ] {
            let mut row = annex_row("Shock", "oracle-a", "row-a-en", "en", 200.0);
            row["card_compat_blob"] = json!({"lang": "en", "games": listed});
            let (_b, store) = build_store(&[row]);
            let d = store.data();
            let fields = resolve_fields_json(Some(vec!["games".to_owned()])).expect("games resolves");
            let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
            assert_eq!(obj["games"], listed, "the emitted order is the payload's");
            // ...and the membership half of the byte still reads as a plain set.
            let packed = d.printings[0].compat.games;
            let members: Vec<&str> = listed.as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(
                (packed & crate::GAME_MEMBER_MASK).count_ones() as usize,
                members.len(),
                "one membership bit per game, order bits excluded"
            );
        }
        // An unknown game is dropped rather than mispacked, and a repeat does not double-count.
        let mut row = annex_row("Shock", "oracle-a", "row-a-en", "en", 200.0);
        row["card_compat_blob"] = json!({"lang": "en", "games": ["astral", "mtgo", "paper", "mtgo"]});
        let (_b, store) = build_store(&[row]);
        let d = store.data();
        let fields = resolve_fields_json(Some(vec!["games".to_owned()])).expect("games resolves");
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["games"], json!(["mtgo", "paper"]));
    }

    /// Keywords reach the card object AS PRINTED while `keyword:` keeps binding the folded form.
    ///
    /// The same shape as the artist defect above and unreachable by fixture parity for the same
    /// reason: both twins read the emitted row, so they agree on a wrong value. Scryfall's casing
    /// is not derivable from the fold (only 455 of the corpus's 885 keywords come back from
    /// capitalizing the first letter) and its ORDER is neither the fold's nor alphabetical, so
    /// both have to be stored.
    #[test]
    fn keywords_emit_as_printed_and_search_folded() {
        let mut row = annex_row("Brazen Borrower", "oracle-a", "row-a-en", "en", 200.0);
        row["card_keywords"] = json!({"flying": {}, "flash": {}});
        row["card_keywords_printed"] = json!(["Flying", "Flash"]);
        let (_b, store) = build_store(&[row]);
        let d = store.data();
        let fields = resolve_fields_json(Some(vec!["card_keywords".to_owned()])).expect("keywords resolve");
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["card_keywords"], json!(["Flying", "Flash"]), "printed casing, printed order");

        // The search side is untouched: the query value is lowercase and binds the folded ids.
        let tree = json!({
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "op": ":",
                "lhs": { "node_type": "CardAttributeNode",
                         "kwargs": { "attribute_name": "card_keywords", "original_attribute": "keyword" } },
                // The rhs a JSONB_OBJECT attribute carries is the raw key ARRAY the TS parser
                // emits (getKeywordsComparisonKeys), already lowercased.
                "rhs": ["flying"],
            }
        });
        let opts = QueryOptions { fields: Some(vec!["card_keywords".to_owned()]), ..QueryOptions::default() };
        let out = store.query_value(&tree, &opts).expect("keyword search");
        assert_eq!(out.total, 1, "keyword: still matches through the folded vocab");
        assert_eq!(out.rows[0]["card_keywords"], json!(["Flying", "Flash"]));
    }

    /// A second store, with the same keyword at a DIFFERENT vocab id, still answers `keyword:`.
    ///
    /// The lifetime question behind a nightly publish: a serving object loads store A, then
    /// `commitPublish` swaps store B under it (search-engine-do.ts), and B's `coll_vocab` is
    /// interned in build order, so "flying" is almost never the same u16 in both. A filter bound
    /// once against A's vocab and reused would then match nothing on B — `keyword:` quietly
    /// returning zero rows after every publish, in the English lane too.
    ///
    /// It does not, and this pins why: `prepare_query` calls `FilterExpr::bind` with the vocab of
    /// the archive it is ABOUT to query, on every query, and nothing caches the bound tree between
    /// them (the same per-query re-read `sync_format_shifts` does for the legality registry one
    /// line above it). Two stores in one process, queried in turn, is the smallest shape that can
    /// tell a per-store binding from a process-global one.
    #[test]
    fn a_keyword_filter_rebinds_against_each_store_it_queries() {
        let tree = json!({
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "op": ":",
                "lhs": { "node_type": "CardAttributeNode",
                         "kwargs": { "attribute_name": "card_keywords", "original_attribute": "keyword" } },
                "rhs": ["flying"],
            }
        });
        let opts = QueryOptions { fields: Some(vec!["card_keywords".to_owned()]), ..QueryOptions::default() };

        let mut a = annex_row("Air Elemental", "oracle-a", "row-a-en", "en", 200.0);
        a["card_keywords"] = json!({"flying": {}});
        a["card_keywords_printed"] = json!(["Flying"]);
        let (_ba, store_a) = build_store(&[a]);

        // Store B interns a run of collection strings ahead of the keyword — subtypes are read
        // before keywords in jv_card_row — so "flying" lands on a different vocab id and at a
        // different position in the sorted permutation `bind` binary-searches.
        let mut b = annex_row("Wind Drake", "oracle-b", "row-b-en", "en", 200.0);
        b["card_subtypes"] = json!(["Drake", "Bird", "Aardvark"]);
        b["card_keywords"] = json!({"flying": {}});
        b["card_keywords_printed"] = json!(["Flying"]);
        let (_bb, store_b) = build_store(&[b]);

        let id_of = |store: &BufferStore| -> u16 {
            let d = store.data();
            (0..d.coll_vocab.len())
                .find(|i| d.coll_vocab[*i].as_str() == "flying")
                .expect("the folded keyword is interned") as u16
        };
        assert_ne!(id_of(&store_a), id_of(&store_b), "the fixture must actually move the id");

        // A, then B, then A again: a stale binding would fail the second or the third.
        assert_eq!(store_a.query_value(&tree, &opts).expect("a").total, 1);
        assert_eq!(store_b.query_value(&tree, &opts).expect("b").total, 1, "the swapped store rebinds");
        assert_eq!(store_a.query_value(&tree, &opts).expect("a again").total, 1);
    }

    /// Colours come out ALPHABETICAL, which is what Scryfall serves — see identity_letters.
    #[test]
    fn colors_emit_in_scryfalls_alphabetical_order() {
        let mut row = annex_row("Invasion of Alara", "oracle-a", "row-a-en", "en", 200.0);
        row["card_colors"] = json!({"W": true, "U": true, "B": true, "R": true, "G": true});
        row["card_color_identity"] = json!({"U": true, "R": true});
        row["produced_mana"] = json!({"C": true, "B": true, "W": true});
        let (_b, store) = build_store(&[row]);
        let d = store.data();
        let names = ["colors", "color_identity", "produced_mana"];
        let fields = resolve_fields_json(Some(names.iter().map(|n| (*n).to_string()).collect())).expect("resolve");
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["colors"], json!(["B", "G", "R", "U", "W"]), "not WUBRG");
        assert_eq!(obj["color_identity"], json!(["R", "U"]), "not U then R");
        assert_eq!(obj["produced_mana"], json!(["B", "C", "W"]), "C sorts with the letters, not last");
    }

    /// `produced_mana` reaches the card object at all — it never did, so every land this port
    /// served was missing a key Scryfall sends. Absent when the card makes no mana, never `[]`.
    #[test]
    fn produced_mana_is_emitted_and_absent_when_empty() {
        let fields = resolve_fields_json(Some(vec!["produced_mana".to_owned()])).expect("resolves");
        let mut row = annex_row("Ancient Tomb", "oracle-a", "row-a-en", "en", 200.0);
        row["produced_mana"] = json!({"C": true});
        let (_b, store) = build_store(&[row]);
        let d = store.data();
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["produced_mana"], json!(["C"]));

        let (_b, store) = build_store(&[annex_row("Shock", "oracle-b", "row-b-en", "en", 150.0)]);
        let d = store.data();
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["produced_mana"], json!(null), "null is the writers' absent form");
    }

    /// `promo_types` and `frame_effects` keep the payload's order too.
    ///
    /// Same class as colours and games, and the cheapest of the three to have got wrong: the
    /// ingest reads both with `jv_str_list_to_ids`, so the order was in the archive the whole time
    /// and only the emission re-sorted it. Scryfall serves `["showcase","legendary"]` and
    /// `["universesbeyond","ffv"]`; alphabetical gives the reverse of both.
    #[test]
    fn promo_types_and_frame_effects_keep_the_payloads_order() {
        let mut row = annex_row("Shock", "oracle-a", "row-a-en", "en", 200.0);
        row["card_compat_blob"] = json!({
            "lang": "en",
            "frame_effects": ["showcase", "legendary"],
            "promo_types": ["universesbeyond", "ffv"],
        });
        let (_b, store) = build_store(&[row]);
        let d = store.data();
        let names = ["promo_types", "frame_effects"];
        let fields = resolve_fields_json(Some(names.iter().map(|n| (*n).to_string()).collect())).expect("resolve");
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["frame_effects"], json!(["showcase", "legendary"]), "not alphabetical");
        assert_eq!(obj["promo_types"], json!(["universesbeyond", "ffv"]), "not alphabetical");
    }

    /// The printed colour dot reaches the card object — it never did.
    ///
    /// A meld result states its colours with an indicator because its mana cost cannot (it has
    /// none): Mishra, Lost to Phyrexia serves `"color_indicator": ["B","R"]`. 546 printings in the
    /// corpus carry the key and this port emitted it on zero of them.
    #[test]
    fn a_printed_color_indicator_reaches_the_card_object() {
        let fields = resolve_fields_json(Some(vec!["color_indicator".to_owned()])).expect("resolves");
        let mut row = annex_row("Mishra, Lost to Phyrexia", "oracle-a", "row-a-en", "en", 200.0);
        row["color_indicator"] = json!({"B": true, "R": true});
        let (_b, store) = build_store(&[row]);
        let d = store.data();
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["color_indicator"], json!(["B", "R"]));

        let (_b, store) = build_store(&[annex_row("Shock", "oracle-b", "row-b-en", "en", 150.0)]);
        let d = store.data();
        let obj = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        assert_eq!(obj["color_indicator"], json!(null), "absent, not an empty list");
    }

    /// `all_parts` is the PRINTING's list, not the card's.
    ///
    /// Two printings of one oracle card, one carrying related cards and one carrying none: the
    /// second must answer with an empty list rather than borrowing the first's. This is the shape
    /// mom/230 has live — two related cards on the English printing, the key omitted entirely on
    /// the Spanish one — and it is why the field moved off `OracleCard`.
    #[test]
    fn all_parts_belongs_to_the_printing_that_carries_it() {
        let mut en = annex_row("Invasion of Alara", "oracle-a", "row-a-en", "en", 200.0);
        en["card_compat_blob"] = json!({
            "lang": "en",
            "all_parts": [{"id": "11111111-1111-1111-1111-111111111111", "component": "token",
                           "name": "Copy", "type_line": "Token"}],
        });
        let mut es = annex_row("Invasion of Alara", "oracle-a", "row-a-es", "es", 150.0);
        es["card_compat_blob"] = json!({"lang": "es"});
        let (_b, store) = build_store(&[en, es]);
        let d = store.data();
        let fields = resolve_fields_json(Some(vec!["all_parts".to_owned()])).expect("all_parts resolves");
        assert_eq!(d.printings.len(), 2, "one card, two canonical printings");
        let first = card_to_json(&d.cards[0], &d.printings[0], &d.strings, &d.coll_vocab, &fields);
        let second = card_to_json(&d.cards[0], &d.printings[1], &d.strings, &d.coll_vocab, &fields);
        let first_empty = first["all_parts"].as_array().unwrap().is_empty();
        let (with_parts, without) = if first_empty { (second, first) } else { (first, second) };
        assert_eq!(with_parts["all_parts"][0]["name"], json!("Copy"));
        assert_eq!(with_parts["all_parts"][0]["component"], json!("token"));
        assert!(
            without["all_parts"].as_array().unwrap().is_empty(),
            "the printing without related cards must not inherit the other's"
        );
    }

    /// The per-face artist, through the same fix: original case out of `faces_to_json`, absence
    /// exact on a face without one.
    #[test]
    fn a_face_artist_round_trips_in_original_case() {
        let mut row = annex_row("Sudden Rescue // Steady Return", "oracle-p", "row-p-en", "en", 200.0);
        row["card_faces"] = json!([
            { "name": "Sudden Rescue", "type_line": "Instant", "oracle_text": "x",
              "artist": "Milivoj Ćeran", "illustration_id": "ill-front" },
            { "name": "Steady Return", "type_line": "Sorcery", "oracle_text": "y",
              "illustration_id": "ill-back" },
        ]);
        let (_b, store) = build_store(&[row]);
        let d = store.data();
        let out = faces_to_json(&d.cards[0], &d.printings[0], &d.strings);
        assert_eq!(out[0]["artist"], json!("Milivoj Ćeran"));
        assert_eq!(out[1]["artist"], json!(null), "the artistless face stays null, never scrambled");
    }

    /// `a:` IS AN ARTIST-ENTITY MATCH: a needle matching ANY of an artist's credited spellings
    /// answers for ALL of that artist's printings.
    ///
    /// Measured on api.scryfall.com 2026-08-17: `a:"don't mess"&order=artist&unique=prints`
    /// answers 399 — exactly `a:"rebecca guay"`'s 399 — because one printing, `Persecute Artist`
    /// (unh/61), is credited `Rebecca "Don't Mess with Me" Guay`.
    ///
    /// The whole ingest path, not a hand-built `CardData`: `artist_ids` is read out of the compat
    /// residue by `jv_artist_ids`, the entity table is accumulated across rows and frozen by
    /// `ArtistEntityInterner::finish`, and only then does `bind` get to see it. A test that
    /// assembled the table itself would prove the query side and nothing about whether the value
    /// survives ingest — which is exactly where it was being dropped.
    ///
    /// `Kev Walker` / `Evkay Alkerway` is the pair that makes this unfakeable by string work:
    /// one artist, two credited names, NO shared substring. Only the UUID relates them.
    #[test]
    fn artist_predicates_answer_for_the_whole_artist_entity() {
        let franz = "11111111-2222-3333-4444-555555555555";
        let mut rows = Vec::new();
        let mut artist_row = |name: &str, oracle: &str, scry: &str, artist: &str| {
            let mut r = annex_row(name, oracle, scry, "en", 100.0);
            r["card_artist"] = json!(artist);
            r["card_artist_folded"] = json!(artist.to_lowercase());
            rows.push(r);
        };
        // pid order follows oracle_id, so the names below are what the asserts address.
        artist_row("Alpha", "oracle-a", "row-a", "Kev Walker");
        artist_row("Bravo", "oracle-b", "row-b", "Evkay Alkerway");
        // A JOINED credit naming the same artist. It must come along, exactly as the plain
        // substring scan already brings it along for `a:"kev walker"`.
        artist_row("Charlie", "oracle-c", "row-c", "Kev Walker & Franz Vohwinkel");
        // Franz SOLO. He has one spelling, so the table below says nothing about him — and that
        // silence is load-bearing: naming him would hand every `a:"kev walker"` query, which
        // matches the joined credit above, his whole body of work.
        artist_row("Delta", "oracle-d", "row-d", "Franz Vohwinkel");
        let _ = franz;

        // The table AS THE BUILDER HANDS IT OVER — one object for the corpus, spellings only, no
        // ids and nothing per row. The split that produces it is the builder's
        // (`transform::artist_entity_table`, tested there); this is the engine's half.
        let entities = json!([[["evkay alkerway", "evkay alkerway"], ["kev walker", "kev walker"]]]);
        let (_b, store) = build_store_with_entities(&rows, entities);
        let d = store.data();
        let hits = |needle: &str| -> Vec<String> {
            let mut f = crate::FilterExpr::TextContains {
                field: crate::TextSearchField::ArtistCollated,
                word: needle.to_string(),
            };
            f.bind(
                &d.coll_vocab,
                &d.coll_vocab_sorted,
                &d.artist_vocab,
                &d.artist_vocab_collated,
                &d.artist_entities,
                &d.mana_vocab,
                &d.indexes.flavor,
                &d.strings,
            );
            let mut names: Vec<String> = (0..d.printings.len())
                .filter(|&pid| {
                    let cid = u32::from(d.indexes.printing_to_card[pid]) as usize;
                    f.eval_printing(&d.cards[cid], &d.printings[pid], &d.strings) == crate::Tri::True
                })
                .map(|pid| {
                    let cid = u32::from(d.indexes.printing_to_card[pid]) as usize;
                    d.cards[cid].card_name_lower.as_str().to_owned()
                })
                .collect();
            names.sort();
            names
        };

        // THE DIVERGENCE. Before the entity table, "evkay" reached one printing and "kev walker"
        // reached two — two spellings of one artist answering as two artists.
        assert_eq!(hits("evkay"), vec!["alpha", "bravo", "charlie"], "the alternate spelling answers for the whole entity");
        assert_eq!(hits("kevwalker"), vec!["alpha", "bravo", "charlie"], "and so does the usual one");
        // ...and the closure stops at the entity. `Charlie` names Kev AND Franz; reaching Franz's
        // solo printing through it would be a filter that silently WIDENS.
        assert!(!hits("kevwalker").contains(&"delta".to_string()), "a joined credit must not drag in the other artist's work");
        assert_eq!(hits("franzvohwinkel"), vec!["charlie", "delta"], "and Franz still answers for his own");

        // The archived table is spellings and nothing else — no artist ids, nothing per printing.
        assert_eq!(d.artist_entities.form_offsets.len(), 2, "one entity");
        let forms: Vec<&str> = d.artist_entities.forms_collated.iter().map(rkyv::string::ArchivedString::as_str).collect();
        assert_eq!(forms, vec!["evkayalkerway", "kevwalker"]);
    }

    /// WATERMARK IS PER FACE, both halves of it, through the whole ingest path.
    ///
    /// `Research // Development` (dis/155) is simic on its front face and izzet on its back.
    /// Scryfall answers it for `wm:simic` AND `wm:izzet`, and emits the watermark on the FACES —
    /// it sends a top-level `watermark` on 0 of the 12,098 faced printings in the 2026-08-16
    /// all_cards bulk, against 36,437 unfaced ones that do.
    #[test]
    fn a_faced_printing_carries_every_face_watermark_and_emits_none_at_top_level() {
        let mut split = annex_row("Research // Development", "oracle-rd", "row-rd", "en", 100.0);
        split["card_layout"] = json!("split");
        // What the builder's face overlay writes: the FRONT face's value, at top level.
        split["card_watermark"] = json!("simic");
        split["card_faces"] = json!([
            { "name": "Research", "type_line": "Sorcery", "oracle_text": "x", "watermark": "simic",
              "illustration_id": "ill-front" },
            { "name": "Development", "type_line": "Sorcery", "oracle_text": "y", "watermark": "izzet" },
        ]);
        let mut plain = annex_row("Shock", "oracle-s", "row-s", "en", 100.0);
        plain["card_watermark"] = json!("izzet");

        let (_b, store) = build_store(&[split, plain]);
        let d = store.data();
        let pid_of = |name: &str| {
            (0..d.printings.len())
                .find(|&pid| {
                    let cid = u32::from(d.indexes.printing_to_card[pid]) as usize;
                    d.cards[cid].card_name_lower.as_str().starts_with(name)
                })
                .expect("printing")
        };
        let (split_pid, plain_pid) = (pid_of("research"), pid_of("shock"));

        // 1. THE SEARCH INDEX sees both faces, and the back-only value is a real answer.
        let postings = |v: &str| -> Vec<u32> {
            d.indexes.watermarks.get(v).map_or_else(Vec::new, |p| p.iter().map(|x| u32::from(*x)).collect())
        };
        assert!(postings("simic").contains(&(split_pid as u32)), "wm:simic must answer the split printing");
        assert!(postings("izzet").contains(&(split_pid as u32)), "wm:izzet must answer it TOO — the back face's value");
        assert!(postings("izzet").contains(&(plain_pid as u32)), "and the unfaced printing is untouched");

        // 2. THE CARD OBJECT puts it on the faces...
        let split_cid = u32::from(d.indexes.printing_to_card[split_pid]) as usize;
        let faces = faces_to_json(&d.cards[split_cid], &d.printings[split_pid], &d.strings);
        assert_eq!(faces[0]["watermark"], json!("simic"));
        assert_eq!(faces[1]["watermark"], json!("izzet"));

        // 3. ...while the printing's own column still holds the front's copy, which is what
        //    `wm:` reads first and what an unfaced printing answers with. The other half of the
        //    fix — keeping that value OFF the top level of a faced card object — belongs to the
        //    serializers and is pinned there: `a_faced_card_omits_the_top_level_watermark` in
        //    card_object.rs and its TypeScript twin.
        assert_eq!(str_at(&d.strings, u32::from(d.printings[split_pid].card_watermark_id)), Some("simic"));
        assert_eq!(str_at(&d.strings, u32::from(d.printings[plain_pid].card_watermark_id)), Some("izzet"));
    }

    // ─── Opaque sort keys, query_keys/fetch_rows, and the partitioned differential ────────────

    /// A corpus rich enough to exercise every orderby: six cards across several sets, prices,
    /// dates, artists (one artistless), edhrec ranks (some missing), plus foreign rows.
    /// Set a row's collector number the way the importer does: the string, plus the integer
    /// `extract_collector_number_int` pulls out of it (ASCII digits concatenated, absent when
    /// there are none). Both, because `order=set` keys on the PAIR and a fixture that carried only
    /// the string would sort "10" before "9" and call it correct.
    fn set_collector_number(r: &mut Value, cn: &str) {
        r["collector_number"] = json!(cn);
        let digits: String = cn.chars().filter(char::is_ascii_digit).collect();
        match digits.parse::<u16>() {
            Ok(n) => r["collector_number_int"] = json!(n),
            Err(_) => {
                if let Value::Object(map) = r {
                    map.remove("collector_number_int");
                }
            }
        }
    }

    fn differential_rows() -> Vec<Value> {
        let mut rows = Vec::new();
        let mk = |name: &str, oracle: &str, scry: &str, lang: &str, prefer: f64| {
            let mut r = annex_row(name, oracle, scry, lang, prefer);
            r["released_at"] = json!("2020-01-01");
            r
        };
        for (name, oracle, set, cn, date, usd, cmc, edhrec, artist, rarity) in [
            ("Alpha Strike", "oracle-1", "lea", "2", "1993-08-05", 12.0, 1.0, Some(100), Some("Anna Steinbauer"), 0),
            ("Alpha Strike", "oracle-1", "m21", "10", "2020-07-03", 0.5, 1.0, Some(100), Some("Zoltan Boros"), 0),
            ("Beta Ray", "oracle-2", "m21", "9", "2020-07-03", 3.25, 2.0, Some(50), Some("anna steinbauer"), 1),
            ("Gamma Wave", "oracle-3", "neo", "100", "2022-02-18", 0.1, 3.5, None, None, 2),
            ("Delta Wing", "oracle-4", "neo", "20", "2022-02-18", 7.0, 2.0, Some(50), Some("Milivoj Ćeran"), 3),
            ("Epsilon Drive", "oracle-5", "otj", "7", "2024-04-19", 0.02, 0.0, Some(7000), Some("Zoltan Boros"), 0),
            ("Zeta Field", "oracle-6", "lea", "1", "1993-08-05", 950.0, 6.0, Some(3), Some("Anna Steinbauer"), 3),
        ] {
            let scry = format!("row-{oracle}-{set}");
            let mut r = mk(name, oracle, &scry, "en", usd + 100.0);
            r["card_set_code"] = json!(set);
            set_collector_number(&mut r, cn);
            r["released_at"] = json!(date);
            r["price_usd"] = json!(usd);
            r["cmc"] = json!(cmc);
            r["card_rarity_int"] = json!(rarity);
            if let Some(e) = edhrec {
                r["edhrec_rank"] = json!(e);
            }
            if let Some(a) = artist {
                r["card_artist"] = json!(a);
            }
            rows.push(r);
        }
        // `order=name`'s COLLATION, in the shapes that separate it from a byte compare. Without
        // these the differential fixture is punctuation-free and proves nothing about the default
        // order — the same blind spot `collector_number: "1"` used to be for `order=set`.
        // Scryfall's answers, measured 2026-08-16: `Binding the Old Gods` before `Bind the
        // Monster` (the space goes), `Ajani, Caller of the Pride` before `Ajani Goldmane` (the
        // comma goes), `Éowyn, Lady of Rohan` before `Erebor Flamesmith` (É folds to e rather than
        // sorting past z). Each is the REVERSE of raw byte order, so a fixture that passes with a
        // byte comparator cannot contain them.
        for (oracle, name, folded) in [
            ("oracle-nm-1", "Bind the Monster", "bind the monster"),
            ("oracle-nm-2", "Binding the Old Gods", "binding the old gods"),
            ("oracle-nm-3", "Ajani, Caller of the Pride", "ajani, caller of the pride"),
            ("oracle-nm-4", "Ajani Goldmane", "ajani goldmane"),
            // The importer stores card_name_folded already accent-folded (fold_accents of the
            // lowercased name), so the fixture spells the folded form out the same way.
            ("oracle-nm-5", "Éowyn, Lady of Rohan", "eowyn, lady of rohan"),
            ("oracle-nm-6", "Erebor Flamesmith", "erebor flamesmith"),
        ] {
            let scry = format!("row-{oracle}-en");
            let mut r = mk(name, oracle, &scry, "en", 150.0);
            r["card_name_folded"] = json!(folded);
            r["edhrec_rank"] = json!(700);
            rows.push(r);
        }
        // `order=set`'s SECOND key, in the one shape that can go wrong: rows of ONE set whose
        // collector numbers separate only by the (int, string) rule. "9" before "10" is what a
        // plain string order gets backwards; "40" before "A-40" before "41" is khm's own sequence
        // (measured against api.scryfall.com over the whole set, 2026-08-16) and is what an
        // int-only key cannot express. "UB" carries no digits at all and leads the set, which is
        // where Scryfall puts the corpus's five digit-free numbers (`e:unk` answers CAa, CAb, UB,
        // CA01, ... , measured the same day) and what `Option<u16>`'s own `None < Some` gives.
        // Distinct oracles so the partition cut splits them, which is
        // what makes `partitioned_key_streams_merge_to_the_unpartitioned_order` prove the BYTE
        // encoding rather than just the in-archive rank.
        for (oracle, cn) in [
            ("oracle-cn-0", "UB"),
            ("oracle-cn-1", "9"),
            ("oracle-cn-2", "10"),
            ("oracle-cn-3", "40"),
            ("oracle-cn-4", "A-40"),
            ("oracle-cn-5", "41"),
        ] {
            let scry = format!("row-{oracle}-khm");
            let mut r = mk("Kaldheim Filler", oracle, &scry, "en", 150.0);
            r["card_set_code"] = json!("khm");
            set_collector_number(&mut r, cn);
            r["edhrec_rank"] = json!(600);
            rows.push(r);
        }
        // `order=released`'s SECOND key, in the one shape that separates it from a collector-number
        // key: TWO sets sharing ONE release date, with collector numbers that interleave across
        // them. Scryfall answers a shared date SET-GROUPED (measured over 102 multi-set date groups
        // on 2026-08-16, contiguous in 102 of them), so the whole of zza precedes the whole of zzb
        // ascending — an order no collector-number-only key can produce, since "500" would then
        // have to follow "10". Distinct oracles so the cut splits them and the BYTE encoding is on
        // trial too, and a date of its own so the block is contiguous in the full listing.
        for (oracle, set, cn) in [
            ("oracle-rt-1", "zzb", "1"),
            ("oracle-rt-2", "zza", "500"),
            ("oracle-rt-3", "zza", "9"),
            ("oracle-rt-4", "zzb", "10"),
        ] {
            let scry = format!("row-{oracle}-{set}");
            let mut r = mk("Released Tie Filler", oracle, &scry, "en", 150.0);
            r["card_set_code"] = json!(set);
            set_collector_number(&mut r, cn);
            r["released_at"] = json!("2021-06-11");
            r["edhrec_rank"] = json!(650);
            rows.push(r);
        }
        // The near-tie name pairs the cross-partition NAME lanes are proven on, placed (by the
        // shared hash, checked in-test) so each pair SPLITS across partitions at N=3.
        for (name, oracle, edhrec) in [
            ("Steel Wall", "oracle-7", 200),   // p1 at N=3
            ("Steel Walls", "oracle-9", 300),  // p2
            ("Shock", "oracle-10", 400),       // p0
            ("Shatter", "oracle-11", 500),     // p2
        ] {
            let scry = format!("row-{oracle}-en");
            let mut r = mk(name, oracle, &scry, "en", 150.0);
            r["edhrec_rank"] = json!(edhrec);
            rows.push(r);
        }
        // Foreign rows on two of the cards, for the widened differential.
        for (oracle, lang, printed) in [("oracle-1", "ja", "アルファの一撃"), ("oracle-4", "pt", "asa delta")] {
            let scry = format!("row-{oracle}-{lang}");
            let mut r = mk("x", oracle, &scry, lang, 40.0);
            // The card-level fields come from the group's first row; give the annex row the same
            // name so a first-row flip (hash order) cannot change card identity.
            r["card_name"] = rows
                .iter()
                .find(|x| x["oracle_id"] == json!(oracle))
                .map(|x| x["card_name"].clone())
                .unwrap();
            r["card_name_folded"] = json!(r["card_name"].as_str().unwrap().to_lowercase());
            r["is_canonical"] = json!(false);
            r["printed_name"] = json!(printed);
            r["printed_name_folded"] = json!(printed.to_lowercase());
            rows.push(r);
        }
        rows
    }

    /// The (orderby, direction, unique, include_multilingual) grid the key tests sweep: every
    /// primary-segment shape (string asc/desc, numeric, date, missing artist, missing edhrec
    /// tiebreak) and both drivers.
    fn key_grid() -> Vec<(&'static str, &'static str, &'static str, bool)> {
        vec![
            ("name", "asc", "card", false),
            ("name", "desc", "card", false),
            ("set", "asc", "printing", false),
            // Both directions, because `set` is the one column with a SECOND key and descending
            // has to reverse that key too — an encoder that reversed only the set code would still
            // pass the ascending sweep.
            ("set", "desc", "printing", false),
            ("released", "desc", "printing", false),
            ("cmc", "asc", "card", false),
            ("artist", "asc", "printing", false),
            ("artist", "desc", "printing", false),
            ("edhrec", "asc", "card", false),
            // Both directions, for the reason `set` has both: `edhrec` is the one column whose
            // ABSENT side sorts HIGHEST (see `absent_sorts_highest`), so descending is where the
            // unranked cards LEAD. An encoder that moved the null on one side only still passes
            // the ascending sweep — and `Gamma Wave` in the fixture is the row that has no rank.
            ("edhrec", "desc", "card", false),
            ("usd", "desc", "printing", false),
            ("name", "asc", "printing", true),
            ("released", "asc", "printing", true),
        ]
    }

    fn keys_opts(orderby: &str, direction: &str, unique: &str, multilingual: bool) -> QueryOptions {
        QueryOptions {
            unique: unique.to_owned(),
            orderby: orderby.to_owned(),
            direction: direction.to_owned(),
            limit: 10_000,
            fields: Some(vec!["scryfall_id".to_owned()]),
            include_multilingual: multilingual,
            ..QueryOptions::default()
        }
    }

    /// `order=set` orders a set by COLLECTOR NUMBER, and by the (int, string) rule Scryfall uses.
    ///
    /// The port had no collector-number component at all, so this order was whatever the edhrec
    /// tiebreak happened to give — `e:khm order=set` agreed with api.scryfall.com on 0 of 175 rows
    /// on page 1, in English. All four shapes that decide the rule are here: a digit-free number
    /// leads ("UB"), 9 precedes 10 (so it is not a string sort), "40" precedes "A-40" precedes
    /// "41" (so it is not an int sort either), and `dir=desc` reverses the number with the set
    /// rather than leaving it ascending inside a descending set — khm answers 407, 406, 405 …
    #[test]
    fn order_set_ranks_by_collector_number() {
        let (_b, store) = build_store(&differential_rows());
        let tree = json!({
            "node_type": "CardBinaryOperatorNode",
            "kwargs": {
                "op": ":",
                "lhs": { "node_type": "CardAttributeNode",
                         "kwargs": { "attribute_name": "card_set_code", "original_attribute": "set" } },
                "rhs": { "node_type": "StringValueNode", "kwargs": { "value": "khm" } },
            }
        });
        let numbers = |direction: &str| -> Vec<String> {
            let opts = QueryOptions {
                unique: "prints".to_owned(),
                orderby: "set".to_owned(),
                direction: direction.to_owned(),
                limit: 100,
                fields: Some(vec!["collector_number".to_owned()]),
                ..QueryOptions::default()
            };
            store
                .query_value(&tree, &opts)
                .expect("query")
                .rows
                .iter()
                .map(|r| r["collector_number"].as_str().expect("collector_number").to_owned())
                .collect()
        };
        let asc = numbers("asc");
        assert_eq!(asc, ["UB", "9", "10", "40", "A-40", "41"], "Scryfall's own khm/unk sequence");
        let mut reversed = asc.clone();
        reversed.reverse();
        assert_eq!(numbers("desc"), reversed, "dir=desc reverses the number with the set it sits in");
    }

    /// `order=released` breaks a date tie by SET first and collector number second, both following
    /// the primary's direction.
    ///
    /// Measured against api.scryfall.com on 2026-08-16. Cards sharing a release date come back
    /// set-grouped, not interleaved: `date=2025-04-11` answers all of tdm, then all of tdc, then
    /// all of ptdm, and 102 of 102 sampled multi-set date groups were contiguous by set. On every
    /// group tried, `dir=desc` was the exact reversal of `dir=asc`.
    ///
    /// The fixture's four rows are chosen so the two candidate rules DISAGREE rather than merely
    /// differ in confidence: zza's "500" sits above zzb's "1" ascending, which a collector-number
    /// key (the port's previous second key for this column) cannot produce at any direction — it
    /// answers zzb:1, zza:9, zzb:10, zza:500. Passing this is therefore evidence about the RULE,
    /// not just about the code agreeing with itself.
    #[test]
    fn order_released_breaks_a_date_tie_by_set_then_collector_number() {
        let (_b, store) = build_store(&differential_rows());
        let tree = json!({ "node_type": "TrueNode" });
        // The whole listing, then the sub-sequence of the one date the fixture gives two sets. A
        // sub-sequence of the true order is still the true order of those rows.
        let block = |direction: &str| -> Vec<String> {
            let opts = QueryOptions {
                unique: "prints".to_owned(),
                orderby: "released".to_owned(),
                direction: direction.to_owned(),
                limit: 10_000,
                fields: Some(vec!["set_code".to_owned(), "collector_number".to_owned()]),
                ..QueryOptions::default()
            };
            store
                .query_value(&tree, &opts)
                .expect("query")
                .rows
                .iter()
                .map(|r| {
                    format!(
                        "{}:{}",
                        r["set_code"].as_str().unwrap_or_default(),
                        r["collector_number"].as_str().unwrap_or_default()
                    )
                })
                .filter(|s| s.starts_with("zz"))
                .collect()
        };
        let asc = block("asc");
        assert_eq!(asc, ["zza:9", "zza:500", "zzb:1", "zzb:10"], "a shared date groups by set, then by number");
        let mut reversed = asc.clone();
        reversed.reverse();
        assert_eq!(block("desc"), reversed, "dir=desc reverses the set with the date, and the number with the set");
    }

    /// `order=name` collates the way Scryfall does: accents folded, every non-alphanumeric removed.
    ///
    /// The three pairs are each the REVERSE of raw byte order, which is what the port shipped: a
    /// space, a comma and an É respectively decide the comparison, and all three sort before
    /// letters as bytes. Measured against api.scryfall.com on 2026-08-16 over 1,333 adjacent pairs
    /// from eight pages: 0 violations of this rule, 133 of byte order.
    #[test]
    fn order_name_uses_scryfalls_collation() {
        let (_b, store) = build_store(&differential_rows());
        let opts = QueryOptions {
            unique: "card".to_owned(),
            orderby: "name".to_owned(),
            limit: 10_000,
            fields: Some(vec!["name".to_owned()]),
            ..QueryOptions::default()
        };
        let names: Vec<String> = store
            .query_value(&json!({ "node_type": "TrueNode" }), &opts)
            .expect("query")
            .rows
            .iter()
            .map(|r| r["name"].as_str().expect("name").to_owned())
            .collect();
        let at = |n: &str| names.iter().position(|x| x == n).unwrap_or_else(|| panic!("missing {n}"));
        assert!(at("Binding the Old Gods") < at("Bind the Monster"), "the space is not a character");
        assert!(at("Ajani, Caller of the Pride") < at("Ajani Goldmane"), "the comma is not a character");
        assert!(at("Éowyn, Lady of Rohan") < at("Erebor Flamesmith"), "É folds to e, and does not vanish");
    }

    /// Within one archive, the emitted key sequence must BE the page order — every key leads
    /// with the version byte and the stream is bytewise nondecreasing, for every orderby shape.
    #[test]
    fn query_keys_are_versioned_and_bytewise_page_ordered() {
        let (_b, store) = build_store(&differential_rows());
        let tree = json!({ "node_type": "TrueNode" });
        for (orderby, direction, unique, ml) in key_grid() {
            let out = store.query_keys(&tree, &keys_opts(orderby, direction, unique, ml), 0).expect("keys");
            assert!(!out.keys.is_empty());
            for (key, _) in &out.keys {
                assert_eq!(key[0], crate::SORT_KEY_VERSION, "every key leads with the version byte");
            }
            for w in out.keys.windows(2) {
                assert!(
                    w[0].0 <= w[1].0,
                    "byte order must equal page order for orderby={orderby} {direction} unique={unique}"
                );
            }
        }
    }

    /// query_keys is the same query: identical total, and its vpids fetched back through
    /// fetch_rows are exactly the rows query_value pages, in order.
    #[test]
    fn query_keys_totals_and_rows_match_the_query() {
        let (_b, store) = build_store(&differential_rows());
        let tree = json!({ "node_type": "TrueNode" });
        for (orderby, direction, unique, ml) in key_grid() {
            let opts = keys_opts(orderby, direction, unique, ml);
            let keyed = store.query_keys(&tree, &opts, 0).expect("keys");
            let paged = store.query_value(&tree, &opts).expect("rows");
            assert_eq!(keyed.total, paged.total);
            assert_eq!(keyed.keys.len(), paged.rows.len());
            let vpids: Vec<u32> = keyed.keys.iter().map(|(_, v)| *v).collect();
            let fetched = store.fetch_rows(&vpids, opts.fields.clone()).expect("fetch");
            assert_eq!(fetched, paged.rows, "fetch_rows(page vpids) must reproduce the page");
        }
    }

    /// fetch_rows answers in CALLER order, reaches the annex, and errors loudly on a vpid from
    /// nowhere.
    #[test]
    fn fetch_rows_preserves_caller_order_and_rejects_strays() {
        let store = multilingual_store();
        let d = store.data();
        let n = d.printings.len() as u32;
        let fields = Some(vec!["lang".to_owned()]);
        // Annex first, then a canonical row — order must survive.
        let rows = store.fetch_rows(&[n, 0], fields.clone()).expect("fetch");
        assert_eq!(rows.len(), 2);
        assert_ne!(rows[0]["lang"], json!("en"), "an annex vpid materializes the foreign printing");
        assert_eq!(rows[1]["lang"], json!("en"));
        let stray = n + d.foreign.len() as u32;
        assert!(store.fetch_rows(&[stray], fields).is_err(), "an out-of-range vpid is an error, not a skip");
    }

    /// THE cross-partition property (plan A4/G2 in miniature): cut the same corpus at N=4 via
    /// encode_standalone/build_partition_from_standalone, run query_keys on every partition, and
    /// the bytewise merge of the streams must equal the unpartitioned key sequence EXACTLY — same
    /// bytes, same order, totals summing. Key equality is row identity (the last 16 bytes are the
    /// scryfall_id), so this is the whole two-phase gather proven end to end, per orderby shape.
    /// It is also what forces UNDERLYING VALUES into the keys: a rank-based key passes the
    /// in-archive ordering test above and fails here, because each partition ranks its own cut.
    #[test]
    fn partitioned_key_streams_merge_to_the_unpartitioned_order() {
        const N: u32 = 4;
        let rows = differential_rows();
        let (_b, reference) = build_store(&rows);

        // The partitioned cut, through the standalone blob path the native builder uses.
        let partitions = partitioned_stores(&rows, N);
        assert!(
            partitions.iter().filter(|p| p.card_count() > 0).count() >= 2,
            "the corpus must actually split for the merge to prove anything"
        );

        let tree = json!({ "node_type": "TrueNode" });
        for (orderby, direction, unique, ml) in key_grid() {
            let opts = keys_opts(orderby, direction, unique, ml);
            let want = reference.query_keys(&tree, &opts, 0).expect("reference keys");

            let mut merged: Vec<Vec<u8>> = Vec::new();
            let mut total = 0usize;
            for p in &partitions {
                let out = p.query_keys(&tree, &opts, 0).expect("partition keys");
                total += out.total;
                for (key, _) in out.keys {
                    assert_eq!(key[0], crate::SORT_KEY_VERSION, "a merge must never mix key versions");
                    merged.push(key);
                }
            }
            // Each stream is sorted (asserted above), so sorting the concatenation IS the k-way
            // merge, and keys are globally unique (scryfall tail) so the order is total.
            merged.sort_unstable();

            let want_keys: Vec<&Vec<u8>> = want.keys.iter().map(|(k, _)| k).collect();
            assert_eq!(total, want.total, "orderby={orderby} {direction} unique={unique} ml={ml}");
            assert_eq!(
                merged.iter().collect::<Vec<_>>(),
                want_keys,
                "merged partition streams must equal the unpartitioned order (orderby={orderby} {direction} unique={unique} ml={ml})"
            );
        }
    }

    /// The same corpus cut at N partitions through the standalone blob path the native builder
    /// uses — shared by the key-merge property test and the envelope differential below.
    fn partitioned_stores(rows: &[Value], n: u32) -> Vec<BufferStore> {
        let mut buckets: Vec<Vec<Vec<u8>>> = vec![Vec::new(); n as usize];
        for row in rows {
            let (meta, blob) = SpillingStoreBuilder::encode_standalone(row).expect("standalone");
            buckets[(meta.part_hash % u64::from(n)) as usize].push(blob);
        }
        buckets
            .into_iter()
            .map(|blobs| {
                let mut bytes = Vec::new();
                build_partition_from_standalone(blobs.into_iter(), Value::Null, &mut bytes).expect("partition build");
                BufferStore::from_bytes(&bytes).expect("partition loads")
            })
            .collect()
    }

    /// THE REFERENCE GATHER — exactly the algorithm the serving DO must implement over
    /// `query_keys`/`fetch_rows` (src/engine/remote-engine.ts's gather must match this; the
    /// envelope test below is the contract it is held to):
    ///
    ///   phase 1: ask every partition for its top `offset + limit` keys at offset 0;
    ///            refuse mixed key versions; sum the exact totals.
    ///   merge:   k-way bytewise merge of the (sorted) streams; the page is positions
    ///            [offset, offset + limit) of the merged sequence.
    ///   phase 2: fetch each page row from the partition that OWNS it (vpids are
    ///            partition-local) FOR THE ROWS PHASE 1 DID NOT ALREADY CARRY, then splice
    ///            every row — inline or fetched — back into merged order.
    ///
    /// `inline_budget` is what the caller asks each partition to materialize alongside its keys
    /// (`0` reproduces the original keys-only protocol exactly). It is applied only at offset 0,
    /// for the reason `query_keys`' docstring gives, and it changes NOTHING about the answer: a
    /// row's bytes are the same whichever phase carried it. The returned `phase2_calls` is what
    /// the free plan is actually being billed for, so the test below can assert it went to zero.
    ///
    /// Returns (total_cards, data, has_more, phase2_calls).
    fn gather_reference(
        partitions: &[BufferStore],
        tree: &Value,
        opts: &QueryOptions,
        inline_budget: usize,
    ) -> (usize, Vec<Value>, bool, usize) {
        let mut phase1 = opts.clone();
        phase1.limit = opts.offset + opts.limit;
        phase1.offset = 0;
        let inline = if opts.offset == 0 { inline_budget } else { 0 };
        let mut total = 0usize;
        // (key, partition, vpid, LOCAL INDEX in that partition's stream)
        let mut merged: Vec<(Vec<u8>, usize, u32, usize)> = Vec::new();
        let mut carried: Vec<Vec<Value>> = Vec::with_capacity(partitions.len());
        for (part, store) in partitions.iter().enumerate() {
            let out = store.query_keys(tree, &phase1, inline).expect("phase 1 keys");
            total += out.total;
            for (local, (key, vpid)) in out.keys.into_iter().enumerate() {
                assert_eq!(key[0], crate::SORT_KEY_VERSION, "the gather must refuse mixed key versions");
                merged.push((key, part, vpid, local));
            }
            carried.push(out.rows);
        }
        // Streams arrive sorted, so sorting the concatenation IS the k-way merge; keys are
        // globally unique (the scryfall tail), so the order is total and needs no tiebreak.
        merged.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        let end = (opts.offset + opts.limit).min(merged.len());
        let page = if opts.offset < end { &merged[opts.offset..end] } else { &[][..] };

        // Splice: rows phase 1 carried are taken by LOCAL INDEX; the rest are fetched, grouped per
        // owning partition, and only from the partitions that still owe something.
        let mut rows: Vec<Option<Value>> = vec![None; page.len()];
        let mut phase2_calls = 0usize;
        for (part, store) in partitions.iter().enumerate() {
            let mut owed_at: Vec<usize> = Vec::new();
            let mut owed_vpids: Vec<u32> = Vec::new();
            for i in 0..page.len() {
                if page[i].1 != part {
                    continue;
                }
                match carried[part].get(page[i].3) {
                    Some(row) => rows[i] = Some(row.clone()),
                    None => {
                        owed_at.push(i);
                        owed_vpids.push(page[i].2);
                    }
                }
            }
            if owed_vpids.is_empty() {
                continue;
            }
            phase2_calls += 1;
            let fetched = store.fetch_rows(&owed_vpids, opts.fields.clone()).expect("phase 2 rows");
            for (slot, row) in owed_at.into_iter().zip(fetched) {
                rows[slot] = Some(row);
            }
        }
        let data: Vec<Value> = rows.into_iter().map(|r| r.expect("every page slot fetched")).collect();
        let has_more = opts.offset + data.len() < total;
        (total, data, has_more, phase2_calls)
    }

    /// The envelope-level differential (plan C5's acceptance shape, CARD-PARTITIONING §6): the
    /// same query corpus through (a) the unpartitioned store's pages and (b) the reference
    /// gather over an N=3 cut — BYTE-IDENTICAL envelopes: total_cards, has_more, and data in
    /// order, compared as serialized JSON. Sweeps the orderby grid plus lang:/include_multilingual
    /// variants and deep/past-the-end offsets.
    #[test]
    fn gathered_envelopes_equal_the_unpartitioned_pages() {
        let rows = differential_rows();
        let (_b, reference) = build_store(&rows);
        let partitions = partitioned_stores(&rows, 3);
        let true_node = json!({ "node_type": "TrueNode" });

        let mut cases: Vec<(Value, QueryOptions)> = Vec::new();
        for (orderby, direction, unique, ml) in key_grid() {
            for (offset, limit) in [(0usize, 4usize), (3, 4), (7, 50), (10_000, 5)] {
                let mut opts = keys_opts(orderby, direction, unique, ml);
                opts.offset = offset;
                opts.limit = limit;
                cases.push((true_node.clone(), opts));
            }
        }
        // The lang: lane through the gather too — the widened driver behind query_keys.
        let mut lang_opts = keys_opts("name", "asc", "card", false);
        lang_opts.limit = 5;
        cases.push((lang_filter("ja"), lang_opts));

        for (tree, opts) in cases {
            let want = reference.query_value(&tree, &opts).expect("unpartitioned page");
            let want_has_more = opts.offset + want.rows.len() < want.total;
            let envelope = |t: usize, d: &[Value], h: bool| {
                serde_json::json!({ "total_cards": t, "has_more": h, "data": d }).to_string()
            };
            let expected = envelope(want.total, &want.rows, want_has_more);

            // Every inline budget must produce the SAME envelope: 0 is the original keys-only
            // protocol, 1 forces a page that mixes carried and fetched rows inside one partition,
            // and a budget past the page length carries everything. If any of the three diverged,
            // folding phase 2 into phase 1 would be changing answers, not just round trips.
            for budget in [0usize, 1, 2, opts.offset + opts.limit + 1] {
                let (total, data, has_more, phase2) = gather_reference(&partitions, &tree, &opts, budget);
                assert_eq!(
                    envelope(total, &data, has_more),
                    expected,
                    "envelope diverged at inline budget {budget}: orderby={} {} unique={} ml={} offset={} limit={}",
                    opts.orderby, opts.direction, opts.unique, opts.include_multilingual, opts.offset, opts.limit
                );
                // The point of the whole exercise: at offset 0 a budget that covers the page costs
                // no phase-2 call at all, which is 1 isolate RPC + N-1 sibling RPCs and nothing else.
                if opts.offset == 0 && budget > opts.limit {
                    assert_eq!(
                        phase2, 0,
                        "an inline budget past the page length must fold phase 2 away entirely \
                         (orderby={} {} unique={} limit={})",
                        opts.orderby, opts.direction, opts.unique, opts.limit
                    );
                }
            }
        }
    }

    /// The rows `query_keys` carries inline must be BYTE-IDENTICAL to the ones `fetch_rows` would
    /// hand back for the same vpids and fields — the property that lets a single page mix them.
    /// Checked across the orderby grid and with an explicit field projection, because the two
    /// paths resolve `fields` through different call sites.
    #[test]
    fn inline_rows_equal_fetch_rows_for_the_same_entries() {
        let store = multilingual_store();
        let tree = json!({ "node_type": "TrueNode" });
        for (orderby, direction, unique, ml) in key_grid() {
            for fields in [None, Some(vec!["name".to_owned(), "lang".to_owned()])] {
                let mut opts = keys_opts(orderby, direction, unique, ml);
                opts.limit = 12;
                opts.fields = fields.clone();
                let out = store.query_keys(&tree, &opts, 5).expect("keys with inline rows");
                assert_eq!(out.rows.len(), out.keys.len().min(5), "inline rows are a prefix of the keys");
                let vpids: Vec<u32> = out.keys.iter().take(out.rows.len()).map(|(_, v)| *v).collect();
                let fetched = store.fetch_rows(&vpids, fields).expect("phase 2 rows");
                assert_eq!(
                    serde_json::to_string(&out.rows).unwrap(),
                    serde_json::to_string(&fetched).unwrap(),
                    "inline and fetched rows diverged (orderby={orderby} {direction} unique={unique} ml={ml})"
                );
            }
        }
        // Asking for more inline rows than the page has is clamped, never an error.
        let mut opts = keys_opts("name", "asc", "card", false);
        opts.limit = 3;
        let out = store.query_keys(&tree, &opts, 9_999).expect("clamped");
        assert_eq!(out.rows.len(), out.keys.len());
    }

    /// The reference cross-partition fuzzy race — exactly what partitioned-engine.ts's fuzzy
    /// combine must compute from the `fuzzy_candidates` export: union every partition's
    /// candidate classes, global best by score, runner-up = best candidate differing from it in
    /// BOTH folded name and oracle id, `hit` iff the best leads by `lead`. Returns the status
    /// and, on a hit, the winner's oracle id.
    fn fuzzy_race_reference(
        partitions: &[BufferStore],
        needle: &str,
        floor: f32,
        lead: f32,
    ) -> (&'static str, Option<String>) {
        let mut all: Vec<FuzzyCandidate> = Vec::new();
        for p in partitions {
            all.extend(p.fuzzy_candidates(needle, floor, 8));
        }
        all.sort_by(|a, b| {
            b.score.total_cmp(&a.score).then_with(|| a.oracle_id.cmp(&b.oracle_id)).then_with(|| a.vpid.cmp(&b.vpid))
        });
        let Some(best) = all.first().cloned() else { return ("miss", None) };
        let runner = all
            .iter()
            .find(|c| c.folded_name != best.folded_name && c.oracle_id != best.oracle_id);
        match runner {
            Some(r) if best.score - r.score < lead => ("ambiguous", None),
            _ => ("hit", Some(best.oracle_id)),
        }
    }

    /// The cross-partition fuzzy race must answer EXACTLY what a single store answers, for every
    /// needle shape — and the case that proves the scores-bearing export necessary: a needle two
    /// partitions both resolve to (distinct-name) local hits, where the conservative
    /// `{status, card}` combine reads ambiguous and the single store picks the winner by LEAD.
    #[test]
    fn fuzzy_race_across_partitions_matches_the_single_store() {
        let rows = differential_rows();
        let (_b, reference) = build_store(&rows);
        let partitions = partitioned_stores(&rows, 3);
        let fields = Some(vec!["oracle_id".to_owned()]);
        let (floor, lead) = (0.4f32, 0.05f32);

        let needles =
            ["alpha strike", "alpha strik", "beta rey", "steel wall", "shock", "アルファの一撃", "zzzzzz"];
        let mut split_hit_proven = false;
        for needle in needles {
            let (want_status, want_card) =
                reference.fuzzy_card_by_name(needle, floor, lead, fields.clone()).expect("single-store fuzzy");
            let (got_status, got_oracle) = fuzzy_race_reference(&partitions, needle, floor, lead);
            assert_eq!(got_status, want_status, "status diverged for {needle:?}");
            if want_status == "hit" {
                let want_oracle = want_card.expect("hit card")["oracle_id"].as_str().unwrap().to_owned();
                assert_eq!(got_oracle.as_deref(), Some(want_oracle.as_str()), "winner diverged for {needle:?}");
                // The materialization rule the TS combine uses: the winning partition's OWN
                // fuzzy answers the same hit (the global winner leads its local competitors too).
                let winner_partition = partitions
                    .iter()
                    .find(|p| {
                        p.fuzzy_candidates(needle, floor, 8)
                            .first()
                            .is_some_and(|c| c.oracle_id == want_oracle)
                    })
                    .expect("some partition owns the winner");
                let (s, c) = winner_partition
                    .fuzzy_card_by_name(needle, floor, lead, fields.clone())
                    .expect("winner-partition fuzzy");
                assert_eq!(s, "hit", "the winning partition must re-resolve its own hit for {needle:?}");
                assert_eq!(c.expect("card")["oracle_id"].as_str().unwrap(), want_oracle);
                // The divergence proof: at least one hit needle must have DISTINCT-NAME local
                // hits on two partitions — where {status, card} combining reads ambiguous.
                let local_hits: Vec<String> = partitions
                    .iter()
                    .filter_map(|p| {
                        let (s, c) = p.fuzzy_card_by_name(needle, floor, lead, fields.clone()).ok()?;
                        (s == "hit").then(|| c.unwrap()["oracle_id"].as_str().unwrap().to_owned())
                    })
                    .collect();
                if local_hits.len() >= 2 {
                    split_hit_proven = true;
                }
            }
        }
        assert!(
            split_hit_proven,
            "no needle produced two distinct local hits — the corpus no longer proves the \
             conservative combine wrong; re-place the near-tie pairs"
        );
    }

    /// The autocomplete merge key: merging per-partition lists under the engine's OWN
    /// (prefix-rank over the collated name, `pg_trgm` similarity DESCENDING, name) key
    /// reproduces the single-store output — and neither the alphabetical approximation nor the
    /// length one it replaced does, provably, on this corpus. `Shock` leads `Shatter` on
    /// similarity (2/7 against 2/9) where alphabetical reverses them, and `Serra Avenger` leads
    /// `Serenity` on similarity where length reverses them.
    ///
    /// This is what `src/engine/partitioned-engine.ts`'s `mergeAutocomplete` is pinned to: the
    /// merge recomputes the key from the NAMES, so a key the names cannot express would silently
    /// order a partitioned deployment differently from a single archive.
    #[test]
    fn autocomplete_merge_key_matches_the_single_store() {
        let mut rows = differential_rows();
        // `Serra Avenger`/`Serenity` — the suffix-share pair, which is the half of the key a
        // length merge gets wrong. Placed here rather than in the fixture's near-tie block
        // because only autocomplete reads it.
        rows.push(catalog_row("Serra Avenger", "oracle-ac-1"));
        rows.push(catalog_row("Serenity", "oracle-ac-2"));
        let (_b, reference) = build_store(&rows);
        let partitions = partitioned_stores(&rows, 3);

        // The merge key, recomputed from the names alone — the exact shape mergeAutocomplete has.
        // Lowercase-then-collate: the accent fold the TypeScript twin also applies is a no-op on
        // this fixture's ASCII names, and the store side reads `card_name_folded`, which the
        // importer already folded.
        let collate = |s: &str| crate::collate_name(&s.to_lowercase());
        let similarity = |needle: &str, name: &str| -> f64 {
            let (mut nt, mut ct) = (Vec::new(), Vec::new());
            collated_trigrams(needle, &mut nt);
            collated_trigrams(&collate(name), &mut ct);
            let inter = ct.iter().filter(|t| nt.contains(t)).count() as f64;
            let union = nt.len() as f64 + ct.len() as f64 - inter;
            inter / union
        };

        for prefix in ["sh", "ser"] {
            let want = reference.autocomplete(prefix, 20);
            let needle = collate(prefix);
            let mut merged: Vec<String> = Vec::new();
            for p in &partitions {
                for name in p.autocomplete(prefix, 20) {
                    if !merged.contains(&name) {
                        merged.push(name);
                    }
                }
            }
            let rank = |name: &str| u8::from(!collate(name).starts_with(&needle));
            let mut keyed = merged.clone();
            keyed.sort_by(|a, b| {
                rank(a)
                    .cmp(&rank(b))
                    .then_with(|| similarity(&needle, b).total_cmp(&similarity(&needle, a)))
                    .then_with(|| a.cmp(b))
            });
            assert_eq!(keyed, want, "{prefix}: the (rank, similarity, name) merge key must reproduce the engine order");

            let mut alpha = merged.clone();
            alpha.sort_by_key(|n| (rank(n), n.to_lowercase()));
            let mut by_len = merged;
            by_len.sort_by_key(|n| (rank(n), n.chars().count(), n.clone()));
            assert!(
                alpha != want || by_len != want,
                "{prefix}: at least one of the two approximations this key replaced must be provably wrong here"
            );
        }
    }

    /// Sorting standalone blobs by their RowMeta sort key reproduces the build order exactly —
    /// the contract a memory-capped caller relies on to presort spilled blobs.
    #[test]
    fn standalone_sort_blobs_reproduce_the_build_order() {
        let rows = differential_rows();
        let mut metas: Vec<(crate::core_api::RowMeta, usize)> = rows
            .iter()
            .enumerate()
            .map(|(i, r)| (SpillingStoreBuilder::encode_standalone(r).expect("standalone").0, i))
            .collect();
        metas.sort_by_key(|(m, _)| m.build_sort_blob);

        let mut sb = SpillingStoreBuilder::new();
        for r in &rows {
            sb.add_card(r).expect("stage");
        }
        let want: Vec<usize> = sb.sorted_order().into_iter().map(|i| i as usize).collect();
        let got: Vec<usize> = metas.into_iter().map(|(_, i)| i).collect();
        assert_eq!(got, want, "blob byte order must equal card_row_build_order");
    }

    /// The annex-only oracle shape found by the real-corpus G2 run: an oracle whose EVERY
    /// canonical printing is import-filtered while a foreign row survives (the ja 4ED ante
    /// cards, whose ja printings alone carry `oldschool: legal`). Before the drop guard this
    /// PANICKED the build (`divergent_formats_of` on the zero-width canonical window) — and
    /// would have killed the nightly wasm import identically, since both paths share
    /// build_card_data_sorted. The group is dropped whole and counted; two annex-only oracles
    /// so both close sites (interior group boundary and end-of-stream) are exercised whichever
    /// way the oracle hash orders them.
    #[test]
    fn an_annex_only_oracle_is_dropped_not_panicked() {
        let mut rows = Vec::new();
        for (name, oracle, scry) in
            [("Bronze Tablet", "oracle-ante-1", "row-ante-1"), ("Tempest Efreet", "oracle-ante-2", "row-ante-2")]
        {
            let mut ja = annex_row(name, oracle, scry, "ja", 40.0);
            ja["is_canonical"] = json!(false);
            ja["printed_name"] = json!("アンティ");
            ja["printed_name_folded"] = json!("アンティ");
            rows.push(ja);
        }
        rows.push(annex_row("Shock", "oracle-a", "row-a-en", "en", 200.0));
        let mut a_ja = annex_row("Shock", "oracle-a", "row-a-ja", "ja", 60.0);
        a_ja["is_canonical"] = json!(false);
        rows.push(a_ja);

        let (bytes, store) = build_store(&rows);
        let d = store.data();
        assert_eq!(store.card_count(), 1, "the annex-only oracles are gone, cards and rows alike");
        assert_eq!(store.size(), 1);
        assert_eq!(d.foreign.len(), 1, "only the surviving card's annex row remains");
        // The stats name what happened, exactly.
        let mut b = StoreBuilder::new();
        for r in &rows {
            b.add_card(r).expect("stage");
        }
        let mut out = Vec::new();
        let stats = b.finish_to_writer(&mut out).expect("annex-only oracles must not panic the build");
        assert_eq!(stats.annex_only_oracles_dropped, 2);
        assert_eq!(stats.annex_only_rows_dropped, 2);
        assert_eq!(stats.printing_count + stats.foreign_printing_count + stats.annex_only_rows_dropped, rows.len());

        // The spill path — the nightly's shape — takes the same guard.
        let mut sb = SpillingStoreBuilder::new();
        let blobs: Vec<Vec<u8>> = rows.iter().map(|r| sb.add_card(r).expect("stage")).collect();
        let order = sb.sorted_order();
        let mut spilled = Vec::new();
        let sstats = sb
            .finish_from_sorted(order.iter().map(|&i| blobs[i as usize].clone()), &mut spilled)
            .expect("spill build must not panic either");
        assert_eq!(sstats.annex_only_oracles_dropped, 2);

        // The dropped cards are unreachable on every lane — widened included — and the store
        // still answers queries (the panic site was the planes build; reaching a page proves
        // the whole index build ran).
        let out = store
            .query_value(&json!({ "node_type": "TrueNode" }), &opts_with("printing", true))
            .expect("widened query");
        assert_eq!(out.total, 2);
        drop(bytes);
    }

    /// An all-canonical feed — every store built before the multilingual work — produces an
    /// empty annex with a still-well-formed CSR, and rows without the flag read canonical.
    #[test]
    fn a_feed_without_canonical_flags_builds_an_empty_annex() {
        let (_bytes, store) = build_store(&[
            annex_row("Shock", "oracle-a", "row-a-en", "en", 200.0),
            annex_row("Other Card", "oracle-b", "row-b-en", "en", 150.0),
        ]);
        let d = store.data();
        assert!(d.foreign.is_empty());
        assert_eq!(d.foreign_offsets.len(), d.cards.len() + 1);
        assert!(d.foreign_offsets.iter().all(|o| u32::from(*o) == 0));
        assert_eq!(d.indexes.printed_names.name_ids.len(), 0);
        assert!(d.indexes.foreign_langs.ids_of("en").is_none());
        // The canonical lang plane still posts, for the day lang: narrows canonical rows.
        assert_eq!(d.indexes.langs.ids_of("en").expect("en postings").len(), 2);
    }
}
