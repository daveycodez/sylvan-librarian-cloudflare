// Workers-compatible instantiation of the wasm-bindgen bundler-target pkg.
//
// Wrangler's CompiledWasm rule resolves a .wasm import to a WebAssembly.Module
// (not instantiated exports, which webpack-style bundlers provide), so the
// pkg's own entry glue (`sylvan_engine_wasm.js`) cannot run in workerd. This
// shim does what that glue expects its bundler to have done: instantiation
// with the bindgen import object, then handing the exports to the glue. The
// `sylvan-engine-wasm` alias in wrangler config points here.
//
// Instantiation is LAZY, and that is the point. It used to run at module
// scope, which meant every isolate paid it — and isolates never query the
// engine. They parse a query, RPC to a SearchEngine Durable Object, and hand
// back the answer; only the DO ever touches wasm. Instantiating a 1.4MB module
// in each of them showed up as ~14ms of Worker startup, landing on whichever
// request happened to be first in a fresh isolate. With search-as-you-type
// spraying novel (cache-missing) queries across colos and isolates, that cost
// was being paid over and over against the free plan's 10ms-per-request CPU
// limit.

import * as bg from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";
// The pkg's generated .wasm.d.ts types this as the exports object (webpack
// semantics); under wrangler's CompiledWasm rule it is actually a Module.
import wasmModule from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.wasm";

let instantiated = false;

/**
 * Instantiate the engine, once per isolate, on first use.
 *
 * Every entry point that reaches wasm goes through the store loader, so that
 * is where this is called. Cheap to call repeatedly; a no-op after the first.
 */
export function ensureEngine(): void {
	if (instantiated) return;
	instantiated = true;
	const instance = new WebAssembly.Instance(wasmModule as unknown as WebAssembly.Module, {
		"./sylvan_engine_wasm_bg.js": bg,
	});
	bg.__wbg_set_wasm(instance.exports);
	(instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();
	// Wasm panics must land in console.error, not die silently with the isolate.
	bg.__init_panic_hook();
}

export * from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";
