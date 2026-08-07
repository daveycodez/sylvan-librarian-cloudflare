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
    CardData, CardRow, InlineStr, Interner, ManaCost, ManaVocabInterner, PERMANENT_TYPES,
    QueryCtx, QueryParams, VocabInterner, archive_header, build_card_data,
    card_types_list_to_bits, coll_str, color_list_to_mask, count_common_keywords,
    count_common_types, format_shift_or_assign, lane_add, legality_code, mana_lane,
    parse_uuid_or_hash, run_query_routed, sorted_strs, str_at, uuid_from_u128, write_archive,
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
