// Workers-compatible instantiation of the wasm-bindgen bundler-target pkg.
//
// Wrangler's CompiledWasm rule resolves a .wasm import to a WebAssembly.Module
// (not instantiated exports, which webpack-style bundlers provide), so the
// pkg's own entry glue (`sylvan_engine_wasm.js`) cannot run in workerd. This
// shim does what that glue expects its bundler to have done: synchronous
// instantiation with the bindgen import object, then handing the exports to
// the glue. The `sylvan-engine-wasm` alias in wrangler config points here.

import * as bg from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";
// The pkg's generated .wasm.d.ts types this as the exports object (webpack
// semantics); under wrangler's CompiledWasm rule it is actually a Module.
import wasmModule from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.wasm";

const instance = new WebAssembly.Instance(wasmModule as unknown as WebAssembly.Module, {
	"./sylvan_engine_wasm_bg.js": bg,
});
bg.__wbg_set_wasm(instance.exports);
(instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();

export * from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";
