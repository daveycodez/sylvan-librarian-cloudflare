// The card-names converter (src/engine/card-names.ts `cardNamesV3`) for the deploy seeders and every
// other bun-side caller: the committed import module's `names_blob_v3`, in a standalone instance.
//
// The SAME export of the SAME committed blob the nightly runs (src/engine/import-wasm.ts
// `namesBlobV3`), so a deploy-seeded build and a nightly build of one corpus publish the same bytes —
// which the import harness checks (scripts/import-harness/card-names-check.ts). Standalone because the
// module speaks a C ABI with no shared glue: an instance here cannot disturb any other instance in the
// process, and this file needs no `.wasm` import (which only wrangler and the harness resolve).

import { readFileSync } from "node:fs";
import type { NamesCodec } from "../src/engine/card-names";

const WASM = new URL("../engine/wasm-import/pkg/sylvan_wasm_import.wasm", import.meta.url).pathname;
/** The crate's EMIT_LOG and EMIT_NAMES_BLOB (engine/wasm-import/src/lib.rs). */
const EMIT_LOG = 1;
const EMIT_NAMES_BLOB = 17;

/** `WebAssembly.Module` is declared abstract in lib.dom; constructed as the harness shims do. */
const WasmModule = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module;

interface CodecExports {
	memory: WebAssembly.Memory;
	alloc(len: number): number;
	names_blob_v3(ptr: number, len: number): bigint;
}

let compiled: WebAssembly.Module | null = null;

/** A fresh instance per conversion: its linear memory goes with it. */
export function namesCodec(): NamesCodec {
	compiled ??= new WasmModule(new Uint8Array(readFileSync(WASM)));
	const module_ = compiled;
	return {
		namesBlobV3(raw: Uint8Array): Uint8Array {
			let out: Uint8Array | null = null;
			let ex: CodecExports | null = null;
			const view = (ptr: number, len: number) => new Uint8Array((ex as CodecExports).memory.buffer, ptr, len);
			const env: Record<string, WebAssembly.ImportValue> = {
				emit: (kind: number, ptr: number, len: number) => {
					if (kind === EMIT_NAMES_BLOB) out = view(ptr, len).slice();
					else if (kind === EMIT_LOG) console.warn(`[wasm-import] ${new TextDecoder().decode(view(ptr, len))}`);
					else throw new Error(`names codec: unexpected emit kind ${kind}`);
				},
				pull_row: () => -1,
			};
			const imports: Record<string, Record<string, WebAssembly.ImportValue>> = { env };
			// Placeholder imports a wasm32 dependency can leak (getrandom's wasm_js backend), unused here —
			// stubbed loudly, as src/engine/import-wasm.ts stubs them.
			for (const imp of WebAssembly.Module.imports(module_)) {
				const mod = imports[imp.module] ?? {};
				imports[imp.module] = mod;
				if (mod[imp.name] !== undefined || imp.kind !== "function") continue;
				mod[imp.name] = () => {
					throw new Error(`names codec: stubbed import called: ${imp.module}.${imp.name}`);
				};
			}
			ex = new WebAssembly.Instance(module_, imports).exports as unknown as CodecExports;
			const ptr = ex.alloc(raw.byteLength);
			view(ptr, raw.byteLength).set(raw);
			const n = Number(ex.names_blob_v3(ptr, raw.byteLength));
			const blob = out as Uint8Array | null;
			if (n < 0 || blob === null || blob.byteLength !== n) throw new Error("names codec: names_blob_v3 failed");
			return blob;
		},
	};
}
