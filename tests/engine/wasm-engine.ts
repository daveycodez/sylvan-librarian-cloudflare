// The committed query engine (engine/wasm/pkg), instantiated in bun for the tests that drive the
// real wasm rather than a fake.
//
// Every test file that touches the engine's glue goes through HERE, because the glue is one module
// shared by every test file in the run (bun keeps one module registry across files): it holds one
// `wasm` exports pointer and caches typed-array views of the bound instance's memory, rebuilding
// them only when the cached view reads byteLength 0. A second instance bound over the first without
// detaching the first's buffer would have the glue marshal every argument through the wrong memory.
// So binding here does what src/engine/wasm-shim.ts's `bindTo` does: `grow(0)` the outgoing
// instance's memory (which detaches its buffer and moves nothing), then point the glue at the new
// one. The shim itself cannot be instantiated in bun — its `.wasm` import resolves to a Module only
// under wrangler's CompiledWasm rule — so this is the same two steps against bytes read from disk.

import * as bg from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";

/** The glue's exports these tests call, typed by hand (the `_bg.js` glue ships no declarations). */
export interface EngineGlue {
	scryfall_card_from_row(rowJson: string, baseUrl: string): string;
	init_store(bytes: Uint8Array): void;
	store_version(): number;
	query(filterTreeJson: string, optsJson: string): string;
	query_shaped(filterTreeJson: string, optsJson: string, shape: string): Uint8Array;
	query_keys(filterTreeJson: string, optsJson: string, inlineRows: number, shape: string, baseUrl: string): Uint8Array;
	fetch_rows(vpids: Uint32Array, fieldsJson: string, shape: string, baseUrl: string): Uint8Array;
	sort_key_version(): number;
	random_search(n: number, seed: bigint, filterTreeJson: string, fieldsJson: string): string;
	random_search_shaped(n: number, seed: bigint, filterTreeJson: string, fieldsJson: string, shape: string): Uint8Array;
	shaped_frames_from_rows(rowsJson: string, shape: string): Uint8Array;
	js_spelled_numbers(values: Float64Array): string;
	autocomplete(prefix: string, limit: number): string;
	store_autocomplete_names(): string;
	load_names(gz: Uint8Array): number;
	names_autocomplete(prefix: string, limit: number): string;
	names_heap_bytes(): number;
	names_format(): number;
	names_search_partitions(filterTreeJson: string, multilingual: boolean): string;
	names_fuzzy_plan(folded: string, wordsJson: string, floor: number, lead: number, weakBelow: number): string;
	store_name_records_tsv(): Uint8Array;
}

// `WebAssembly.Module` is typed abstract by bun-types, so the constructor is reached through the
// namespace value rather than the type. Runtime behaviour is the ordinary one.
const WasmModule = (WebAssembly as unknown as { Module: new (b: ArrayBuffer) => WebAssembly.Module }).Module;
const compiled = new WasmModule(
	await Bun.file(new URL("../../engine/wasm/pkg/sylvan_engine_wasm_bg.wasm", import.meta.url)).arrayBuffer(),
);
const glue = bg as unknown as EngineGlue & { __wbg_set_wasm: (exports: unknown) => void };

/** One engine instance: its own linear memory, so its own loaded store. */
export interface TestEngine {
	/** Run `f` against this instance, binding the shared glue to it first. */
	use<T>(f: (glue: EngineGlue) => T): T;
}

let bound: { memory: WebAssembly.Memory } | null = null;

export function newEngine(): TestEngine {
	const instance = new WebAssembly.Instance(compiled, { "./sylvan_engine_wasm_bg.js": bg });
	const self = { memory: instance.exports.memory as WebAssembly.Memory };
	let started = false;
	return {
		use(f) {
			if (bound !== self) {
				bound?.memory.grow(0);
				glue.__wbg_set_wasm(instance.exports);
				bound = self;
			}
			if (!started) {
				started = true;
				(instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();
			}
			return f(glue);
		},
	};
}
