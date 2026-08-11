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

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use super::{
    AOracleCard, APrinting, AStrings, ARCHIVE_FORMAT_VERSION, ARCHIVE_HEADER_LEN, ARTIST_NONE,
    CardData, CardRow, FaceRow, InlineStr, Interner, ManaCost, ManaVocabInterner, PERMANENT_TYPES,
    QueryCtx, QueryParams, VocabInterner, archive_header, build_card_data,
    card_types_list_to_bits, coll_str, color_list_to_mask, count_common_keywords,
    count_common_types, format_shift_or_assign, identity_letters, lane_add, legality_bits_to_json,
    legality_code, mana_lane, parse_uuid_or_hash, rarity_int_to_text, run_query_routed, sorted_strs,
    str_at, uuid_from_u128, write_archive,
    DEFAULT_FIELDS,
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
/// `Value::as_f64` covers both the f64 and i64 arms of the pydict version.
fn jv_opt_price_cents(d: &Value, key: &str) -> Option<u32> {
    d.get(key).and_then(Value::as_f64).map(|dollars| (dollars * 100.0).round() as u32)
}

fn jv_opt_f32(d: &Value, key: &str) -> Option<f32> {
    d.get(key).and_then(Value::as_f64).map(|n| n as f32)
}

fn jv_opt_i8(d: &Value, key: &str) -> Option<i8> {
    jv_opt_f32(d, key).map(|v| v as i8)
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
fn jv_faces(d: &Value, it: &mut Interner, artists: &mut VocabInterner) -> Result<Vec<FaceRow>, EngineError> {
    let Some(list) = d.get("card_faces").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut faces = Vec::with_capacity(list.len());
    for face in list {
        if !face.is_object() {
            continue;
        }
        let card_artist_vid = match jv_opt_str(face, "artist") {
            Some(a) => artists.intern(a.to_lowercase())?,
            None => ARTIST_NONE,
        };
        faces.push(FaceRow {
            card_name_id: it.intern(jv_opt_str(face, "name").unwrap_or_default()),
            mana_cost_text_id: it.intern_opt(jv_opt_str(face, "mana_cost")),
            type_line_id: it.intern(jv_opt_str(face, "type_line").unwrap_or_default()),
            oracle_text_id: it.intern(jv_opt_str(face, "oracle_text").unwrap_or_default()),
            creature_power_text_id: it.intern_opt(jv_opt_str(face, "power")),
            creature_toughness_text_id: it.intern_opt(jv_opt_str(face, "toughness")),
            planeswalker_loyalty_text_id: it.intern_opt(jv_opt_str(face, "loyalty")),
            card_colors: jv_str_list_color_mask(face, "colors"),
            color_indicator: jv_str_list_color_mask(face, "color_indicator"),
            illustration_id: jv_opt_str(face, "illustration_id").map_or(0, |s| parse_uuid_or_hash(&s)),
            card_artist_vid,
            flavor_text_id: it.intern_opt(jv_opt_str(face, "flavor_text")),
        });
    }
    Ok(faces)
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
    let oracle_text_lower_id = it.intern(oracle_text.to_lowercase());
    let flavor_text = jv_opt_str(d, "flavor_text").unwrap_or_default();
    let flavor_text_lower_id = it.intern(flavor_text.to_lowercase());
    let card_artist_vid = match jv_opt_str(d, "card_artist") {
        Some(a) => artists.intern(a.to_lowercase())?,
        None => ARTIST_NONE,
    };
    let card_types = card_types_list_to_bits(&jv_str_list(d, "card_types"));

    Ok(CardRow {
        scryfall_id: jv_opt_uuid(d, "scryfall_id"),
        oracle_id: jv_opt_uuid(d, "oracle_id"),
        illustration_id: jv_opt_uuid(d, "illustration_id"),

        card_name_lower,
        card_name_folded,
        card_name_id: it.intern(card_name),
        oracle_text_lower_id,
        oracle_text_id: it.intern(oracle_text),
        flavor_text_lower_id,
        flavor_text_id: it.intern(flavor_text),
        card_artist_vid,
        card_set_code: InlineStr::<8>::from_str(&jv_opt_str(d, "card_set_code").unwrap_or_default()),
        card_layout_id: it.intern(jv_opt_str(d, "card_layout").unwrap_or_default()),
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

        cmc: jv_opt_u8(d, "cmc"), // Un-set cards have fractional cmc, but we don't load those into the dataset
        creature_power: jv_opt_i8(d, "creature_power"),
        creature_toughness: jv_opt_i8(d, "creature_toughness"),
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
        card_legalities: jv_legality_bits(d, "card_legalities"),
        card_oracle_tags: jv_obj_to_ids(d, "card_oracle_tags", vocab)?,
        card_art_tags: jv_obj_to_ids(d, "card_art_tags", vocab)?,
        card_is_tags: jv_obj_to_ids(d, "card_is_tags", vocab)?,
        card_frame_data: jv_obj_to_ids(d, "card_frame_data", vocab)?,

        mana_cost: mana_cost_from_json(d, jv_opt_f32(d, "cmc"), mana, card_types)?,

        creature_power_text_id: it.intern_opt(jv_opt_str(d, "creature_power_text")),
        creature_toughness_text_id: it.intern_opt(jv_opt_str(d, "creature_toughness_text")),

        card_faces: jv_faces(d, it, artists)?,
    })
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
    mana: ManaVocabInterner,
}

impl StoreBuilder {
    pub fn new() -> Self {
        StoreBuilder {
            rows: Vec::new(),
            interner: Interner::new(),
            vocab: VocabInterner::new(),
            artists: VocabInterner::new(),
            mana: ManaVocabInterner::new(),
        }
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
        let StoreBuilder { rows, interner, vocab, artists, mana } = self;
        let built = build_card_data(rows, interner, vocab, artists, mana)?;
        let stats = StoreStats {
            card_count: built.card_data.cards.len(),
            printing_count: built.card_data.printings.len(),
        };
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
            mana: ManaVocabInterner::new(),
            keys: Vec::new(),
        }
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
        let SpillingStoreBuilder { interner, vocab, artists, mana, keys } = self;
        let expected = keys.len();
        drop(keys);
        let rows = rows.map(|bytes| decode_card_row(&bytes));
        let built = crate::build_card_data_sorted(rows, expected, interner, vocab, artists, mana)?;
        let stats = StoreStats {
            card_count: built.card_data.cards.len(),
            printing_count: built.card_data.printings.len(),
        };
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
}

fn encode_card_row(r: &CardRow) -> Vec<u8> {
    let mut e = RowEnc(Vec::with_capacity(256));
    e.str_inline(r.card_name_lower.as_str());
    e.str_inline(r.card_name_folded.as_str());
    e.u8v(r.card_colors);
    e.u8v(r.card_color_identity);
    e.u8v(r.produced_mana);
    e.u16v(r.card_types);
    e.u128v(r.scryfall_id);
    e.u128v(r.oracle_id);
    e.u128v(r.illustration_id);
    e.u32v(r.card_name_id);
    e.u32v(r.oracle_text_id);
    e.u32v(r.oracle_text_lower_id);
    e.u32v(r.flavor_text_id);
    e.u32v(r.flavor_text_lower_id);
    e.u16v(r.card_artist_vid);
    e.str_inline(r.card_set_code.as_str());
    e.u32v(r.card_layout_id);
    e.u32v(r.card_border_id);
    e.u32v(r.card_watermark_id);
    e.u32v(r.collector_number_id);
    e.u32v(r.mana_cost_text_id);
    e.u32v(r.type_line_id);
    e.u32v(r.set_name_id);
    e.opt(&r.released_at_int, |e, &v| e.u32v(v));
    e.opt(&r.cmc, |e, &v| e.u8v(v));
    e.opt(&r.creature_power, |e, &v| e.u8v(v as u8));
    e.opt(&r.creature_toughness, |e, &v| e.u8v(v as u8));
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
        e.u8v(f.card_colors);
        e.u8v(f.color_indicator);
        e.u128v(f.illustration_id);
        e.u16v(f.card_artist_vid);
        e.u32v(f.flavor_text_id);
    }
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
        card_types: d.u16v(),
        scryfall_id: d.u128v(),
        oracle_id: d.u128v(),
        illustration_id: d.u128v(),
        card_name_id: d.u32v(),
        oracle_text_id: d.u32v(),
        oracle_text_lower_id: d.u32v(),
        flavor_text_id: d.u32v(),
        flavor_text_lower_id: d.u32v(),
        card_artist_vid: d.u16v(),
        card_set_code: InlineStr::from_str(&d.str_owned()),
        card_layout_id: d.u32v(),
        card_border_id: d.u32v(),
        card_watermark_id: d.u32v(),
        collector_number_id: d.u32v(),
        mana_cost_text_id: d.u32v(),
        type_line_id: d.u32v(),
        set_name_id: d.u32v(),
        released_at_int: d.opt(|d| d.u32v()),
        cmc: d.opt(|d| d.u8v()),
        creature_power: d.opt(|d| d.u8v() as i8),
        creature_toughness: d.opt(|d| d.u8v() as i8),
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
        // Must stay LAST and in exactly the encoder's field order: these initializers are
        // evaluated top-to-bottom and each one consumes from the same cursor. The length check
        // below is what turns any drift between the two halves into a loud error.
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
                    card_colors: d.u8v(),
                    color_indicator: d.u8v(),
                    illustration_id: d.u128v(),
                    card_artist_vid: d.u16v(),
                    flavor_text_id: d.u32v(),
                })
                .collect()
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
        Ok(BufferStore { bytes })
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

    /// Mirror of the pyo3 `query()`: filter-tree JSON in, `(total, rows)` out,
    /// with rows rendered through JSON_FIELD_TABLE instead of PyDicts. Runs
    /// the exact same bind/split/route/execute path.
    pub fn query(&self, filter_tree_json: &str, opts: &QueryOptions) -> Result<QueryOutput, EngineError> {
        let json_val: Value = serde_json::from_str(filter_tree_json)
            .map_err(|e| EngineError::query(format!("bad query JSON: {e}")))?;
        self.query_value(&json_val, opts)
    }

    /// [`Self::query`] over an already parsed filter tree.
    pub fn query_value(&self, filter_tree: &Value, opts: &QueryOptions) -> Result<QueryOutput, EngineError> {
        let resolved_fields = resolve_fields_json(opts.fields.clone())?;
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

        let ctx = QueryCtx::from(data);
        let (total, page) = run_query_routed(
            &ctx,
            &params.with_sort_bound(sort_bound),
            &mut filter_expr,
            Some(&unsplit),
            plane_expr.as_ref(),
        );

        let rows: Vec<Value> = page
            .iter()
            .map(|(c, p)| card_to_json(c, p, &data.strings, &data.coll_vocab, &resolved_fields))
            .collect();
        Ok(QueryOutput { total, rows })
    }

    /// Mirror of the pyo3 `sample_preferred()`, with the RNG seed supplied by
    /// the caller instead of drawn from OS entropy — wasm32-unknown-unknown
    /// has no ambient entropy source, so the Worker passes one in.
    pub fn sample_preferred(&self, n: usize, seed: u64, fields: Option<Vec<String>>) -> Result<Vec<Value>, EngineError> {
        let resolved_fields = resolve_fields_json(fields)?;
        let data = self.data();

        let pool_len = data.cards.len();
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
            .map(|&cid| {
                let card = &data.cards[cid];
                let preferred = u32::from(data.offsets[cid]) as usize;
                card_to_json(card, &data.printings[preferred], &data.strings, &data.coll_vocab, &resolved_fields)
            })
            .collect())
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
}

impl QueryOutput {
    /// `{"total": .., "rows": [..]}` — the wire shape the wasm boundary returns.
    pub fn to_json(&self) -> Value {
        let mut m = Map::with_capacity(2);
        m.insert("total".to_owned(), Value::from(self.total as u64));
        m.insert("rows".to_owned(), Value::Array(self.rows.clone()));
        Value::Object(m)
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
    ("name", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.card_name_id)))),
    ("set_code", |_c, p, _s, _v| Value::String(p.card_set_code.as_str().to_owned())),
    ("collector_number", |_c, p, s, _v| opt_str_value(str_at(s, u32::from(p.collector_number_id)))),
    ("power", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.creature_power_text_id)))),
    ("toughness", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.creature_toughness_text_id)))),
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
    ("card_keywords", |c, _p, _s, v| str_vec_value(sorted_strs(v, &c.card_keywords))),
    ("card_oracle_tags", |c, _p, _s, v| str_vec_value(sorted_strs(v, &c.card_oracle_tags))),
    ("card_art_tags", |_c, p, _s, v| str_vec_value(sorted_strs(v, &p.card_art_tags))),
    ("card_is_tags", |_c, p, _s, v| str_vec_value(sorted_strs(v, &p.card_is_tags))),
    ("card_frame_data", |_c, p, _s, v| str_vec_value(sorted_strs(v, &p.card_frame_data))),
    // Card-data fields in Scryfall's own shapes (upstream #877). FIELD_TABLE is pyo3-gated and not
    // compiled here, so its five new entries would merge clean, build clean, and do nothing —
    // `fields=layout` would 400 as an unknown field. These are their live twins.
    ("layout", |c, _p, s, _v| opt_str_value(str_at(s, u32::from(c.card_layout_id)))),
    ("cmc", |c, _p, _s, _v| c.cmc.as_ref().copied().map(Value::from).unwrap_or(Value::Null)),
    ("rarity", |_c, p, _s, _v| {
        p.card_rarity_int
            .as_ref()
            .copied()
            .and_then(|v| rarity_int_to_text(u8::from(v)))
            .map(Value::from)
            .unwrap_or(Value::Null)
    }),
    ("color_identity", |c, _p, _s, _v| str_vec_value(identity_letters(u8::from(c.card_color_identity)))),
    ("legalities", |c, p, _s, _v| {
        // Printing-level word only for the ~556 divergence cards, the same rule the filters use.
        let bits = if c.legality_divergent { u64::from(p.card_legalities) } else { u64::from(c.card_legalities) };
        legality_bits_to_json(bits)
    }),
];

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
            Some(entry) => resolved.push(*entry),
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
    use crate::NONE_STR;
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
        assert_eq!(resolved.iter().map(|(n, _)| *n).collect::<Vec<_>>(), names);
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
        let faces = jv_faces(&d, &mut it, &mut artists).expect("faces");
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
        assert_ne!(faces[0].card_colors, 0);
        // color_indicator is absent on both, which is a clear mask rather than a wrong one.
        assert_eq!(faces[0].color_indicator, 0);
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
        let faces = jv_faces(&d, &mut it, &mut artists).expect("faces");

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

    /// A CardRow with every scalar at its zero value, for tests that care about one field.
    fn empty_card_row() -> CardRow {
        let mut it = Interner::new();
        let mut vocab = VocabInterner::new();
        let mut artists = VocabInterner::new();
        let mut mana = ManaVocabInterner::new();
        card_from_json(&json!({}), &mut it, &mut vocab, &mut artists, &mut mana)
            .expect("an empty object yields an all-defaults row")
    }
}
