/* @ts-self-types="./sylvan_engine_wasm.d.ts" */
import * as wasm from "./sylvan_engine_wasm_bg.wasm";
import { __wbg_set_wasm } from "./sylvan_engine_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    __init_panic_hook, autocomplete, begin_store_load, begin_store_load_gzip, begin_store_load_lz4, card_by_external_id, card_by_illustration_id, card_by_scryfall_id, card_count, cards_by_scryfall_ids, cards_containing_all_words, catalog, collection_batch, collection_cards_by_names, collection_name_ranks, exact_card_by_name, exact_name_probe, exact_name_rank, fetch_rows, finish_store_load, finish_store_load_gzip, finish_store_load_lz4, fuzzy_candidates, fuzzy_card_by_name, init_store, js_spelled_numbers, named_fuzzy_bundle, printings_of_oracle_id, query, query_keys, query_rows, query_shaped, query_widens, random_search, random_search_shaped, scryfall_card_from_row, scryfall_search, shaped_frames_from_rows, size, sort_key_version, store_load_chunk, store_load_gzip_chunk, store_load_lz4_chunk, store_loaded, store_lz4_frame, store_version, unload_store
} from "./sylvan_engine_wasm_bg.js";
