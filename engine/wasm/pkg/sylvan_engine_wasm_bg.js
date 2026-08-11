/**
 * Panics must be loud, not silent isolate deaths: route the panic message to
 * console.error before the trap. Installed once at module instantiation.
 */
export function __init_panic_hook() {
    wasm.__init_panic_hook();
}

/**
 * Card names matching a partial name, prefix matches first. Scryfall's autocomplete catalog.
 * @param {string} prefix
 * @param {number} limit
 * @returns {string}
 */
export function autocomplete(prefix, limit) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.autocomplete(ptr0, len0, limit);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Start a chunked residue load. The active store must already be loaded: the residue shares its
 * index space and string tables, so there is nothing to attach it to otherwise.
 * @param {number} total_len
 */
export function begin_compat_load(total_len) {
    const ret = wasm.begin_compat_load(total_len);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Start a chunked store load: preallocate the full aligned buffer up front
 * (one allocation, no growth reallocs while chunks stream in). Any previous
 * in-progress load is discarded; the ACTIVE store is untouched until
 * `finish_store_load` succeeds.
 * @param {number} total_len
 */
export function begin_store_load(total_len) {
    const ret = wasm.begin_store_load(total_len);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * One card by a marketplace or client id, or `null`. `namespace` is Scryfall's own path segment.
 * @param {string} namespace
 * @param {bigint} external_id
 * @param {string} fields_json
 * @returns {string}
 */
export function card_by_external_id(namespace, external_id, fields_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(namespace, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.card_by_external_id(ptr0, len0, external_id, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * The best printing carrying this illustration id, or `null`.
 * @param {string} illustration_id
 * @param {string} fields_json
 * @returns {string}
 */
export function card_by_illustration_id(illustration_id, fields_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(illustration_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.card_by_illustration_id(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * One card by Scryfall id, or `null`.
 * @param {string} scryfall_id
 * @param {string} fields_json
 * @returns {string}
 */
export function card_by_scryfall_id(scryfall_id, fields_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(scryfall_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.card_by_scryfall_id(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Oracle-card count of the loaded store; 0 when no store is loaded.
 * @returns {number}
 */
export function card_count() {
    const ret = wasm.card_count();
    return ret >>> 0;
}

/**
 * Cards by Scryfall id, in the order given, skipping misses. One boundary crossing for the whole
 * batch: `POST /cards/collection` resolves up to 175 identifiers.
 * @param {string} ids_json
 * @param {string} fields_json
 * @returns {string}
 */
export function cards_by_scryfall_ids(ids_json, fields_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.cards_by_scryfall_ids(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * One card per distinct name containing EVERY word, best printing each, up to `limit`.
 * The containment stage of `/cards/named?fuzzy=`; the caller asks for 2 and reads the count.
 * @param {string} words_json
 * @param {string} set_code
 * @param {number} limit
 * @param {string} fields_json
 * @returns {string}
 */
export function cards_containing_all_words(words_json, set_code, limit, fields_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(words_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(set_code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.cards_containing_all_words(ptr0, len0, ptr1, len1, limit, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * `{"card_types": {name: count}, "card_keywords": {name: count}}` — the data
 * behind /get_catalog.
 * @returns {string}
 */
export function catalog() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.catalog();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Append one chunk of the residue archive.
 * @param {Uint8Array} chunk
 */
export function compat_load_chunk(chunk) {
    const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compat_load_chunk(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Whether the residue archive is attached to the active store.
 * @returns {boolean}
 */
export function compat_loaded() {
    const ret = wasm.compat_loaded();
    return ret !== 0;
}

/**
 * The best printing of a card whose FOLDED name matches exactly, or `null`.
 *
 * `folded` must already be lowercased and accent-folded by the caller (foldAccents in
 * src/parser/pystr.ts), the same way `card_name_folded` was at import. `set_code` is "" for no
 * set restriction.
 * @param {string} folded
 * @param {string} set_code
 * @param {string} fields_json
 * @returns {string}
 */
export function exact_card_by_name(folded, set_code, fields_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(folded, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(set_code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.exact_card_by_name(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Validate the streamed residue archive and attach it to the active store.
 */
export function finish_compat_load() {
    const ret = wasm.finish_compat_load();
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Validate the streamed archive and atomically swap it in as the active
 * store. On any error the in-progress buffer is dropped and the previously
 * active store (if any) keeps serving.
 */
export function finish_store_load() {
    const ret = wasm.finish_store_load();
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Scryfall's `?fuzzy=` name lookup. Returns `{"status": "hit"|"ambiguous"|"miss", "card": ...}`.
 *
 * `ambiguous` stays distinct from `miss` because Scryfall reports it, and answering 404 would
 * tell the client the card does not exist.
 * @param {string} name
 * @param {number} floor
 * @param {number} lead
 * @param {string} fields_json
 * @returns {string}
 */
export function fuzzy_card_by_name(name, floor, lead, fields_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.fuzzy_card_by_name(ptr0, len0, floor, lead, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * One-shot residue attach, the `init_store` twin.
 * @param {Uint8Array} bytes
 */
export function init_compat_store(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.init_compat_store(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * One-shot load for callers that already hold the whole archive (tests,
 * small stores). Copies `bytes` into an aligned buffer; prefer the chunked
 * API for production-size stores to avoid a second full-size JS-side copy.
 * @param {Uint8Array} bytes
 */
export function init_store(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.init_store(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Every printing of one oracle card, representative first. Empty array for an unknown id.
 * @param {string} oracle_id
 * @param {string} fields_json
 * @returns {string}
 */
export function printings_of_oracle_id(oracle_id, fields_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(oracle_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.printings_of_oracle_id(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Run a query. `filter_tree_json` is the filter-tree JSON (TrueNode /
 * AndNode / ... encoding); `opts_json` is an object with any of `unique`,
 * `prefer`, `orderby`, `direction`, `limit`, `offset`, `fields` — missing
 * keys take the same defaults as the upstream pyo3 `query()`. Returns
 * `{"total": n, "rows": [...]}` as a JSON string.
 * @param {string} filter_tree_json
 * @param {string} opts_json
 * @returns {string}
 */
export function query(filter_tree_json, opts_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(filter_tree_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(opts_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.query(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * The same query as [`query`], answered as `<total> <row count>\n<rows JSON array>` IN BYTES.
 *
 * For the caller that wants the rows ENCODED rather than as objects — which is /search, whose
 * whole path was `wasm.query` -> `JSON.parse` -> `JSON.stringify`, producing the same bytes it
 * started with. See `QueryOutput::into_total_and_rows_bytes`. `query` is kept for the callers
 * that genuinely need the rows as values (the columnar shape, and the card-object routes until
 * those build their objects here too).
 *
 * Returns `Vec<u8>`, so wasm-bindgen hands JS a `Uint8Array` by copying the linear-memory slice.
 * A `String` return would instead `TextDecoder.decode` it into a UTF-16 JS string, which the
 * Durable Object RPC would UTF-8 encode straight back on the way out — two full passes over the
 * payload, both charged to CPU budgets, to arrive at the bytes written here.
 * @param {string} filter_tree_json
 * @param {string} opts_json
 * @returns {Uint8Array}
 */
export function query_rows(filter_tree_json, opts_json) {
    const ptr0 = passStringToWasm0(filter_tree_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(opts_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.query_rows(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * `n` randomly sampled oracle cards, each as its default-preferred printing —
 * the engine behind /random_search. `seed` comes from the caller (JS
 * `crypto.getRandomValues` or per-request entropy): the sampling itself is
 * deterministic per seed. `fields_json` is a JSON list of field names, or
 * "null"/"" for the default field set. Returns a JSON array of card objects.
 * @param {number} n
 * @param {bigint} seed
 * @param {string} fields_json
 * @returns {string}
 */
export function random_search(n, seed, fields_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(fields_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.random_search(n, seed, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Printing count of the loaded store (the upstream `size()` health number);
 * 0 when no store is loaded, mirroring the pyo3 surface's "empty engine".
 * @returns {number}
 */
export function size() {
    const ret = wasm.size();
    return ret >>> 0;
}

/**
 * Append one chunk of the archive (wasm-bindgen copies the chunk into linear
 * memory; stream ~1MB chunks so the JS side never holds the whole store).
 * @param {Uint8Array} chunk
 */
export function store_load_chunk(chunk) {
    const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.store_load_chunk(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @returns {boolean}
 */
export function store_loaded() {
    const ret = wasm.store_loaded();
    return ret !== 0;
}

/**
 * The archive format version this build reads/writes. A store manifest's
 * `format_version` must match, or `finish_store_load` will reject the bytes.
 * @returns {number}
 */
export function store_version() {
    const ret = wasm.store_version();
    return ret >>> 0;
}

/**
 * Drop the active store, returning its memory to the wasm allocator (linear
 * memory never shrinks, but the pages are reused by the next load). Call
 * before a swap when there isn't headroom for two stores at once.
 */
export function unload_store() {
    wasm.unload_store();
}
export function __wbg_Error_92b29b0548f8b746(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_error_488ee0f603dedc13(arg0, arg1) {
    console.error(getStringFromWasm0(arg0, arg1));
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
