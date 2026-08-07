/* @ts-self-types="./sylvan_engine_wasm.d.ts" */
import * as wasm from "./sylvan_engine_wasm_bg.wasm";
import { __wbg_set_wasm } from "./sylvan_engine_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    __init_panic_hook, begin_store_load, card_count, catalog, finish_store_load, init_store, query, random_search, size, store_load_chunk, store_loaded, store_version, unload_store
} from "./sylvan_engine_wasm_bg.js";
