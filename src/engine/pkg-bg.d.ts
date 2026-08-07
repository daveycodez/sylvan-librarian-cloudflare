// Types for the wasm-bindgen internal glue module (sylvan_engine_wasm_bg.js),
// which the Workers shim imports directly: same public surface as the pkg
// entry (declared in wasm-module.d.ts) plus the bundler-integration hook.
declare module "*/sylvan_engine_wasm_bg.js" {
	export * from "sylvan-engine-wasm";
	export function __wbg_set_wasm(exports: unknown): void;
}
