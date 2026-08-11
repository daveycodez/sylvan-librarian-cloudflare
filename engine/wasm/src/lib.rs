//! Thin wasm-bindgen boundary over `card_engine`'s pure-Rust core API.
//!
//! No engine logic lives here: every export marshals JS values in, calls
//! `card_engine::{BufferStore, StoreBuilder-adjacent}` APIs, and marshals JSON
//! strings out.
//!
//! Store loading is CHUNKED by design. A Worker isolate has ~128MB and the
//! store is ~70MB, so the JS side must never hold a full copy of the store
//! while wasm holds another. The intended flow is:
//!
//! ```js
//! begin_store_load(totalLen);          // preallocates the aligned buffer
//! for await (const chunk of r2Body) {  // ~1MB chunks straight off the R2 stream
//!   store_load_chunk(chunk);
//! }
//! finish_store_load();                 // validates + atomically swaps in
//! ```
//!
//! `finish_store_load` swaps atomically: on any error the previously active
//! store (if any) stays live. For a hot swap under memory pressure, the JS
//! glue may call `unload_store()` first (accepting a brief unavailability
//! window) so the old ~70MB is returned to the allocator before the new
//! buffer grows; without it the swap transiently needs both stores in linear
//! memory.

use std::cell::RefCell;
use wasm_bindgen::prelude::*;

use card_engine::{AlignedVec, BufferStore, EngineError, QueryOptions};

thread_local! {
    /// The active store. Worker isolates are single-threaded, so a
    /// thread_local RefCell is a plain module-level slot.
    static STORE: RefCell<Option<BufferStore>> = const { RefCell::new(None) };
    /// An in-progress chunked load: (buffer, expected total length).
    static LOADING: RefCell<Option<(AlignedVec, usize)>> = const { RefCell::new(None) };
}

/// Panics must be loud, not silent isolate deaths: route the panic message to
/// console.error before the trap. Installed once at module instantiation.
#[wasm_bindgen(start)]
pub fn __init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        console_error(&format!("sylvan-engine-wasm panic: {info}"));
    }));
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

fn js_err(e: EngineError) -> JsError {
    JsError::new(&e.to_string())
}

// ─── Store loading ───────────────────────────────────────────────────────────

/// One-shot load for callers that already hold the whole archive (tests,
/// small stores). Copies `bytes` into an aligned buffer; prefer the chunked
/// API for production-size stores to avoid a second full-size JS-side copy.
#[wasm_bindgen]
pub fn init_store(bytes: &[u8]) -> Result<(), JsError> {
    let store = BufferStore::from_bytes(bytes).map_err(js_err)?;
    STORE.with(|s| *s.borrow_mut() = Some(store));
    LOADING.with(|l| *l.borrow_mut() = None);
    Ok(())
}

/// One-shot residue attach, the `init_store` twin.
#[wasm_bindgen]
pub fn init_compat_store(bytes: &[u8]) -> Result<(), JsError> {
    let mut buf = AlignedVec::with_capacity(bytes.len());
    buf.extend_from_slice(bytes);
    STORE.with(|s| {
        let mut guard = s.borrow_mut();
        let store = guard.as_mut().ok_or_else(|| JsError::new("no store loaded"))?;
        store.attach_compat(buf).map_err(js_err)
    })
}

/// Start a chunked store load: preallocate the full aligned buffer up front
/// (one allocation, no growth reallocs while chunks stream in). Any previous
/// in-progress load is discarded; the ACTIVE store is untouched until
/// `finish_store_load` succeeds.
#[wasm_bindgen]
pub fn begin_store_load(total_len: u32) -> Result<(), JsError> {
    let total = total_len as usize;
    if total == 0 {
        return Err(JsError::new("begin_store_load: total_len must be non-zero"));
    }
    let buf = AlignedVec::with_capacity(total);
    LOADING.with(|l| *l.borrow_mut() = Some((buf, total)));
    Ok(())
}

/// Append one chunk of the archive (wasm-bindgen copies the chunk into linear
/// memory; stream ~1MB chunks so the JS side never holds the whole store).
#[wasm_bindgen]
pub fn store_load_chunk(chunk: &[u8]) -> Result<(), JsError> {
    LOADING.with(|l| {
        let mut slot = l.borrow_mut();
        let Some((buf, total)) = slot.as_mut() else {
            return Err(JsError::new("store_load_chunk called without begin_store_load"));
        };
        if buf.len() + chunk.len() > *total {
            let msg = format!(
                "store_load_chunk: overflow ({} + {} > declared total {})",
                buf.len(),
                chunk.len(),
                total
            );
            *slot = None; // abort the load; the active store is untouched
            return Err(JsError::new(&msg));
        }
        buf.extend_from_slice(chunk);
        Ok(())
    })
}

/// Validate the streamed archive and atomically swap it in as the active
/// store. On any error the in-progress buffer is dropped and the previously
/// active store (if any) keeps serving.
#[wasm_bindgen]
pub fn finish_store_load() -> Result<(), JsError> {
    let (buf, total) = LOADING
        .with(|l| l.borrow_mut().take())
        .ok_or_else(|| JsError::new("finish_store_load called without begin_store_load"))?;
    if buf.len() != total {
        return Err(JsError::new(&format!(
            "finish_store_load: incomplete load ({} of declared {} bytes)",
            buf.len(),
            total
        )));
    }
    let store = BufferStore::from_aligned(buf).map_err(js_err)?;
    STORE.with(|s| *s.borrow_mut() = Some(store));
    Ok(())
}

/// Drop the active store, returning its memory to the wasm allocator (linear
/// memory never shrinks, but the pages are reused by the next load). Call
/// before a swap when there isn't headroom for two stores at once.
#[wasm_bindgen]
pub fn unload_store() {
    STORE.with(|s| *s.borrow_mut() = None);
}

#[wasm_bindgen]
pub fn store_loaded() -> bool {
    STORE.with(|s| s.borrow().is_some())
}

// ─── The residue archive ─────────────────────────────────────────────────────
//
// A SECOND archive holding the Scryfall card-object fields (see CompatData in card_engine).
// Attached on demand, because `/search` reads none of it: an isolate that only ever serves
// searches never pays the ~11MB of linear memory or the extra KV round trip. `/cards/*` attaches
// it on first use and it stays for the life of the loaded store.
//
// It reuses the SAME streaming buffer as the search store's load, so the two can never be in
// flight at once — which is correct, because a residue archive is only meaningful against the
// store it was built with, and attaching happens after that store is active.

/// Start a chunked residue load. The active store must already be loaded: the residue shares its
/// index space and string tables, so there is nothing to attach it to otherwise.
#[wasm_bindgen]
pub fn begin_compat_load(total_len: u32) -> Result<(), JsError> {
    if !store_loaded() {
        return Err(JsError::new("begin_compat_load without a loaded store"));
    }
    begin_store_load(total_len)
}

/// Append one chunk of the residue archive.
#[wasm_bindgen]
pub fn compat_load_chunk(chunk: &[u8]) -> Result<(), JsError> {
    store_load_chunk(chunk)
}

/// Validate the streamed residue archive and attach it to the active store.
#[wasm_bindgen]
pub fn finish_compat_load() -> Result<(), JsError> {
    let (buf, total) = LOADING
        .with(|l| l.borrow_mut().take())
        .ok_or_else(|| JsError::new("finish_compat_load called without begin_compat_load"))?;
    if buf.len() != total {
        return Err(JsError::new(&format!(
            "finish_compat_load: incomplete load ({} of declared {} bytes)",
            buf.len(),
            total
        )));
    }
    STORE.with(|s| {
        let mut guard = s.borrow_mut();
        let store = guard.as_mut().ok_or_else(|| JsError::new("no store loaded"))?;
        store.attach_compat(buf).map_err(js_err)
    })
}

/// Whether the residue archive is attached to the active store.
#[wasm_bindgen]
pub fn compat_loaded() -> bool {
    STORE.with(|s| s.borrow().as_ref().is_some_and(BufferStore::has_compat))
}

// ─── Queries / catalog / health ──────────────────────────────────────────────

fn with_store<T>(f: impl FnOnce(&BufferStore) -> Result<T, JsError>) -> Result<T, JsError> {
    STORE.with(|s| {
        let guard = s.borrow();
        let store = guard.as_ref().ok_or_else(|| JsError::new("no store loaded"))?;
        f(store)
    })
}

/// Run a query. `filter_tree_json` is the filter-tree JSON (TrueNode /
/// AndNode / ... encoding); `opts_json` is an object with any of `unique`,
/// `prefer`, `orderby`, `direction`, `limit`, `offset`, `fields` — missing
/// keys take the same defaults as the upstream pyo3 `query()`. Returns
/// `{"total": n, "rows": [...]}` as a JSON string.
#[wasm_bindgen]
pub fn query(filter_tree_json: &str, opts_json: &str) -> Result<String, JsError> {
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    with_store(|store| {
        let out = store.query(filter_tree_json, &opts).map_err(js_err)?;
        Ok(out.to_json().to_string())
    })
}

/// The same query as [`query`], answered as `<total> <row count>\n<rows JSON array>` IN BYTES.
///
/// For the caller that wants the rows ENCODED rather than as objects — which is /search, whose
/// whole path was `wasm.query` -> `JSON.parse` -> `JSON.stringify`, producing the same bytes it
/// started with. See `QueryOutput::into_total_and_rows_bytes`. `query` is kept for the callers
/// that genuinely need the rows as values (the columnar shape, and the card-object routes until
/// those build their objects here too).
///
/// Returns `Vec<u8>`, so wasm-bindgen hands JS a `Uint8Array` by copying the linear-memory slice.
/// A `String` return would instead `TextDecoder.decode` it into a UTF-16 JS string, which the
/// Durable Object RPC would UTF-8 encode straight back on the way out — two full passes over the
/// payload, both charged to CPU budgets, to arrive at the bytes written here.
#[wasm_bindgen]
pub fn query_rows(filter_tree_json: &str, opts_json: &str) -> Result<Vec<u8>, JsError> {
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    with_store(|store| {
        let out = store.query(filter_tree_json, &opts).map_err(js_err)?;
        // Not `js_err`: this is a serde_json::Error, not an EngineError. It cannot actually
        // happen -- serializing Values into a Vec has no fallible sink -- but the type is real.
        out.into_total_and_rows_bytes().map_err(|e| JsError::new(&e.to_string()))
    })
}

/// A page of Scryfall card objects as `<total> <row count>\n<cards JSON array>`, in UTF-8 bytes.
///
/// What /cards/search runs. The card objects are built HERE rather than by the caller, so the
/// Durable Object no longer parses the engine's rows, constructs ~60 keys per card in JS, and
/// re-encodes the result — it hands these bytes to the response. Requires the residue archive to
/// be attached, like every other card-object entry point.
#[wasm_bindgen]
pub fn scryfall_search(filter_tree_json: &str, opts_json: &str, base_url: &str) -> Result<Vec<u8>, JsError> {
    let opts = QueryOptions::from_json_str(opts_json).map_err(js_err)?;
    let tree: serde_json::Value = serde_json::from_str(filter_tree_json).map_err(|e| JsError::new(&e.to_string()))?;
    with_store(|store| store.scryfall_search_bytes(&tree, &opts, base_url).map_err(js_err))
}

/// One engine row as a Scryfall card object, for the differential test that guards the port.
///
/// Needs NO store: the builder is a pure function of the row and the base URL, which is what lets
/// `tests/routes/card-object-parity.test.ts` instantiate the engine and compare this against
/// `toScryfallCard` byte for byte. Not on any request path — the routes go through
/// `scryfall_search`, which writes a whole page at once.
#[wasm_bindgen]
pub fn scryfall_card_from_row(row_json: &str, base_url: &str) -> Result<String, JsError> {
    let row: serde_json::Value = serde_json::from_str(row_json).map_err(|e| JsError::new(&e.to_string()))?;
    let serde_json::Value::Object(map) = row else {
        return Err(JsError::new("row must be a JSON object"));
    };
    let mut out = Vec::with_capacity(2048);
    card_engine::card_object::write_scryfall_card(&mut out, &map, base_url);
    String::from_utf8(out).map_err(|e| JsError::new(&e.to_string()))
}

/// `{"card_types": {name: count}, "card_keywords": {name: count}}` — the data
/// behind /get_catalog.
#[wasm_bindgen]
pub fn catalog() -> Result<String, JsError> {
    with_store(|store| {
        let out = serde_json::json!({
            "card_types": store.common_card_types(),
            "card_keywords": store.common_card_keywords(),
        });
        Ok(out.to_string())
    })
}

/// Printing count of the loaded store (the upstream `size()` health number);
/// 0 when no store is loaded, mirroring the pyo3 surface's "empty engine".
#[wasm_bindgen]
pub fn size() -> u32 {
    STORE.with(|s| s.borrow().as_ref().map(|st| st.size() as u32).unwrap_or(0))
}

/// Oracle-card count of the loaded store; 0 when no store is loaded.
#[wasm_bindgen]
pub fn card_count() -> u32 {
    STORE.with(|s| s.borrow().as_ref().map(|st| st.card_count() as u32).unwrap_or(0))
}

/// The archive format version this build reads/writes. A store manifest's
/// `format_version` must match, or `finish_store_load` will reject the bytes.
#[wasm_bindgen]
pub fn store_version() -> u32 {
    card_engine::store_format_version()
}

/// `n` randomly sampled oracle cards, each as its default-preferred printing —
/// the engine behind /random_search. `seed` comes from the caller (JS
/// `crypto.getRandomValues` or per-request entropy): the sampling itself is
/// deterministic per seed. `fields_json` is a JSON list of field names, or
/// "null"/"" for the default field set. Returns a JSON array of card objects.
#[wasm_bindgen]
pub fn random_search(n: u32, seed: u64, fields_json: &str) -> Result<String, JsError> {
    let fields: Option<Vec<String>> = if fields_json.is_empty() || fields_json == "null" {
        None
    } else {
        serde_json::from_str(fields_json)
            .map_err(|e| JsError::new(&format!("bad fields JSON: {e}")))?
    };
    with_store(|store| {
        let rows = store.sample_preferred(n as usize, seed, fields).map_err(js_err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    })
}

// ─── Single-card addressing (the Scryfall-compatible /cards/* surface) ───────
//
// Every one of these runs inside the Durable Object, where CPU is metered against 30 s rather than
// the isolate's 10 ms. `fields_json` is a JSON list of field names, or "null"/"" for the default
// set, exactly like `random_search` above. A miss is JSON `null`, which the caller turns into
// Scryfall's 404 error object — this port has no SQL to fall back to, so a miss IS the answer.

/// Parse the shared `fields_json` argument.
fn parse_fields(fields_json: &str) -> Result<Option<Vec<String>>, JsError> {
    if fields_json.is_empty() || fields_json == "null" {
        return Ok(None);
    }
    serde_json::from_str(fields_json).map_err(|e| JsError::new(&format!("bad fields JSON: {e}")))
}

/// One card by Scryfall id, or `null`.
#[wasm_bindgen]
pub fn card_by_scryfall_id(scryfall_id: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let found = store.card_by_scryfall_id(scryfall_id, fields).map_err(js_err)?;
        Ok(found.unwrap_or(serde_json::Value::Null).to_string())
    })
}

/// Cards by Scryfall id, in the order given, skipping misses. One boundary crossing for the whole
/// batch: `POST /cards/collection` resolves up to 175 identifiers.
#[wasm_bindgen]
pub fn cards_by_scryfall_ids(ids_json: &str, fields_json: &str) -> Result<String, JsError> {
    let ids: Vec<String> =
        serde_json::from_str(ids_json).map_err(|e| JsError::new(&format!("bad ids JSON: {e}")))?;
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let rows = store.cards_by_scryfall_ids(&ids, fields).map_err(js_err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    })
}

/// Every printing of one oracle card, representative first. Empty array for an unknown id.
#[wasm_bindgen]
pub fn printings_of_oracle_id(oracle_id: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let rows = store.printings_of_oracle_id(oracle_id, fields).map_err(js_err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    })
}

/// One card by a marketplace or client id, or `null`. `namespace` is Scryfall's own path segment.
#[wasm_bindgen]
pub fn card_by_external_id(namespace: &str, external_id: u64, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let found = store.card_by_external_id(namespace, external_id, fields).map_err(js_err)?;
        Ok(found.unwrap_or(serde_json::Value::Null).to_string())
    })
}

/// Scryfall's `?fuzzy=` name lookup. Returns `{"status": "hit"|"ambiguous"|"miss", "card": ...}`.
///
/// `ambiguous` stays distinct from `miss` because Scryfall reports it, and answering 404 would
/// tell the client the card does not exist.
#[wasm_bindgen]
pub fn fuzzy_card_by_name(name: &str, floor: f32, lead: f32, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let (status, card) = store.fuzzy_card_by_name(name, floor, lead, fields).map_err(js_err)?;
        Ok(serde_json::json!({ "status": status, "card": card }).to_string())
    })
}

/// The best printing of a card whose FOLDED name matches exactly, or `null`.
///
/// `folded` must already be lowercased and accent-folded by the caller (foldAccents in
/// src/parser/pystr.ts), the same way `card_name_folded` was at import. `set_code` is "" for no
/// set restriction.
#[wasm_bindgen]
pub fn exact_card_by_name(folded: &str, set_code: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    let set = if set_code.is_empty() { None } else { Some(set_code) };
    with_store(|store| {
        let found = store.exact_card_by_name(folded, set, fields).map_err(js_err)?;
        Ok(found.unwrap_or(serde_json::Value::Null).to_string())
    })
}

/// The best printing carrying this illustration id, or `null`.
#[wasm_bindgen]
pub fn card_by_illustration_id(illustration_id: &str, fields_json: &str) -> Result<String, JsError> {
    let fields = parse_fields(fields_json)?;
    with_store(|store| {
        let found = store.card_by_illustration_id(illustration_id, fields).map_err(js_err)?;
        Ok(found.unwrap_or(serde_json::Value::Null).to_string())
    })
}

/// One card per distinct name containing EVERY word, best printing each, up to `limit`.
/// The containment stage of `/cards/named?fuzzy=`; the caller asks for 2 and reads the count.
#[wasm_bindgen]
pub fn cards_containing_all_words(
    words_json: &str,
    set_code: &str,
    limit: u32,
    fields_json: &str,
) -> Result<String, JsError> {
    let words: Vec<String> =
        serde_json::from_str(words_json).map_err(|e| JsError::new(&format!("bad words JSON: {e}")))?;
    let fields = parse_fields(fields_json)?;
    let set = if set_code.is_empty() { None } else { Some(set_code) };
    with_store(|store| {
        let rows = store.cards_containing_all_words(&words, set, limit as usize, fields).map_err(js_err)?;
        Ok(serde_json::Value::Array(rows).to_string())
    })
}

/// Card names matching a partial name, prefix matches first. Scryfall's autocomplete catalog.
#[wasm_bindgen]
pub fn autocomplete(prefix: &str, limit: u32) -> Result<String, JsError> {
    with_store(|store| Ok(serde_json::to_string(&store.autocomplete(prefix, limit as usize)).unwrap_or_else(|_| "[]".into())))
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    /// The chunked load path, driven natively: StoreBuilder bytes streamed in
    /// 7-byte chunks through begin/chunk/finish, then queried. Happy-path only
    /// (constructing a JsError outside wasm is not supported), which is exactly
    /// the path the Worker runs.
    #[test]
    fn chunked_load_then_query() {
        let row = serde_json::json!({
            "card_name": "Chunk Test",
            "card_name_folded": "chunk test",
            "oracle_id": "33333333-3333-3333-3333-333333333333",
            "scryfall_id": "cccccccc-0000-0000-0000-000000000001",
            "card_set_code": "tst",
            "set_name": "Test Set",
            "collector_number": "1",
            "oracle_text": "Do the thing.",
            "type_line": "Sorcery",
            "card_types": ["Sorcery"],
            "card_subtypes": [],
            "card_keywords": {},
            "card_colors": {"U": true},
            "card_color_identity": {"U": true},
            "cmc": 2,
            "card_legalities": {"commander": "legal"},
        });
        let mut builder = card_engine::StoreBuilder::new();
        builder.add_card(&row).expect("add_card");
        let mut bytes = Vec::new();
        let mut compat = Vec::new();
        builder.finish_to_writer(&mut bytes, Some(&mut compat)).expect("finish");

        begin_store_load(bytes.len() as u32).expect("begin");
        for chunk in bytes.chunks(7) {
            store_load_chunk(chunk).expect("chunk");
        }
        finish_store_load().expect("finish_store_load");
        assert!(store_loaded());
        assert_eq!(size(), 1);
        assert_eq!(card_count(), 1);

        let out = query(r#"{"node_type": "TrueNode"}"#, "{}").expect("query");
        let v: serde_json::Value = serde_json::from_str(&out).expect("valid JSON out");
        assert_eq!(v["total"], 1);
        assert_eq!(v["rows"][0]["name"], "Chunk Test");

        let cat = catalog().expect("catalog");
        let v: serde_json::Value = serde_json::from_str(&cat).expect("valid catalog JSON");
        assert_eq!(v["card_types"]["Sorcery"], 1);

        let sampled = random_search(3, 7, "null").expect("random_search");
        let v: serde_json::Value = serde_json::from_str(&sampled).expect("valid sample JSON");
        assert_eq!(v.as_array().unwrap().len(), 1);

        // The /cards/* addressing surface, over the same loaded store. A hit and a miss each,
        // because a miss here IS the 404 — there is no SQL behind it to disagree.
        //
        // The residue archive attaches SEPARATELY, which is the point of the split: everything
        // above answered without it.
        assert!(!compat_loaded());
        init_compat_store(&compat).expect("attach compat");
        assert!(compat_loaded());
        let id = "cccccccc-0000-0000-0000-000000000001";
        let v: serde_json::Value =
            serde_json::from_str(&card_by_scryfall_id(id, "null").expect("by id")).expect("valid JSON");
        assert_eq!(v["name"], "Chunk Test");
        let v: serde_json::Value =
            serde_json::from_str(&card_by_scryfall_id("cccccccc-0000-0000-0000-00000000ffff", "null").expect("miss"))
                .expect("valid JSON");
        assert!(v.is_null());

        let v: serde_json::Value =
            serde_json::from_str(&cards_by_scryfall_ids(&format!("[{id:?}]"), "null").expect("batch")).expect("valid JSON");
        assert_eq!(v.as_array().unwrap().len(), 1);

        let v: serde_json::Value = serde_json::from_str(
            &printings_of_oracle_id("33333333-3333-3333-3333-333333333333", "null").expect("prints"),
        )
        .expect("valid JSON");
        assert_eq!(v.as_array().unwrap().len(), 1);

        let v: serde_json::Value =
            serde_json::from_str(&fuzzy_card_by_name("chunk test", 0.4, 0.05, "null").expect("fuzzy")).expect("valid JSON");
        assert_eq!(v["status"], "hit");
        assert_eq!(v["card"]["name"], "Chunk Test");

        let v: serde_json::Value =
            serde_json::from_str(&autocomplete("chun", 20).expect("autocomplete")).expect("valid JSON");
        assert_eq!(v, serde_json::json!(["Chunk Test"]), "the PRINTED name, not the folded key");

        unload_store();
        assert!(!store_loaded());
        assert_eq!(size(), 0);
    }
}
