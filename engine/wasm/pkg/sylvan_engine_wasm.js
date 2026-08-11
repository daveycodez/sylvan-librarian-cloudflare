/* @ts-self-types="./sylvan_engine_wasm.d.ts" */
import * as wasm from "./sylvan_engine_wasm_bg.wasm";
import { __wbg_set_wasm } from "./sylvan_engine_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    __init_panic_hook, autocomplete, begin_compat_load, begin_store_load, card_by_external_id, card_by_illustration_id, card_by_scryfall_id, card_count, cards_by_scryfall_ids, cards_containing_all_words, catalog, compat_load_chunk, compat_loaded, exact_card_by_name, finish_compat_load, finish_store_load, fuzzy_card_by_name, init_compat_store, init_store, printings_of_oracle_id, query, random_search, size, store_load_chunk, store_loaded, store_version, unload_store
} from "./sylvan_engine_wasm_bg.js";
