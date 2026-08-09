/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const init_store: (a: number, b: number) => [number, number];
export const begin_store_load: (a: number) => [number, number];
export const store_load_chunk: (a: number, b: number) => [number, number];
export const finish_store_load: () => [number, number];
export const store_loaded: () => number;
export const query: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const catalog: () => [number, number, number, number];
export const store_version: () => number;
export const random_search: (a: number, b: bigint, c: number, d: number) => [number, number, number, number];
export const size: () => number;
export const card_count: () => number;
export const __init_panic_hook: () => void;
export const unload_store: () => void;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_start: () => void;
