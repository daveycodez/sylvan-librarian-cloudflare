// A minimal host for the wasm module's resumable-inflate surface, against the
// REAL committed blob — the same artifact the ImportCoordinator instantiates
// (the canonical-wasm.test.ts pattern: no network, one committed file). Each
// instantiate() is a fresh linear memory, i.e. the Durable Object eviction /
// next-alarm boundary: continuity across instances exists ONLY through the
// serialized state blob, which is exactly what these tests are pinning.

import type { ResumableInflate } from "../../src/import-recode";

const wasmBytes = await Bun.file(
	new URL("../../engine/wasm-import/pkg/sylvan_wasm_import.wasm", import.meta.url),
).arrayBuffer();
const WasmModule = (WebAssembly as unknown as { Module: new (b: ArrayBuffer) => WebAssembly.Module }).Module;
const module_ = new WasmModule(wasmBytes);

const EMIT_LOG = 1;
const EMIT_INFLATE = 9;
const dec = new TextDecoder();

export interface InflateHost {
	begin(): void;
	/** Compressed offset to resume from, or null when the blob is refused. */
	restore(state: Uint8Array): number | null;
	feed(bytes: Uint8Array, maxOut: number): { consumed: number; output: Uint8Array | null };
	atBoundary(): boolean;
	totalOut(): number;
	save(): Uint8Array;
	/** The shape InflateRecodeSource drives (same object underneath). */
	resumable(): ResumableInflate;
}

/** One fresh wasm instance — one alarm's worth of decoder lifetime. */
export function instantiate(): InflateHost {
	let memory: WebAssembly.Memory | undefined;
	let emitted: Uint8Array | null = null;
	const view = (ptr: number, len: number) => new Uint8Array((memory as WebAssembly.Memory).buffer, ptr, len);
	const imports: Record<string, Record<string, unknown>> = {
		env: {
			emit(kind: number, ptr: number, len: number) {
				if (kind === EMIT_INFLATE) emitted = view(ptr, len).slice();
				else if (kind === EMIT_LOG) console.error(`[wasm-import] ${dec.decode(view(ptr, len))}`);
			},
			pull_row: () => -1,
		},
	};
	for (const imp of WebAssembly.Module.imports(module_)) {
		imports[imp.module] ??= {};
		const mod = imports[imp.module] as Record<string, unknown>;
		if (mod[imp.name] !== undefined) continue;
		if (imp.kind === "function") {
			mod[imp.name] = () => {
				throw new Error(`stubbed import called: ${imp.module}.${imp.name}`);
			};
		} else if (imp.kind === "memory") mod[imp.name] = new WebAssembly.Memory({ initial: 32 });
		else if (imp.kind === "table") mod[imp.name] = new WebAssembly.Table({ element: "anyfunc", initial: 128 });
		else mod[imp.name] = 0;
	}
	const instance = new WebAssembly.Instance(module_, imports as WebAssembly.Imports);
	const ex = instance.exports as unknown as {
		memory: WebAssembly.Memory;
		alloc(len: number): number;
		dealloc(ptr: number, len: number): void;
		inflate_begin(): void;
		inflate_restore(ptr: number, len: number): bigint;
		inflate_feed(ptr: number, len: number, maxOut: bigint): bigint;
		inflate_status(): number;
		inflate_save(dest: number, cap: number): bigint;
		inflate_total_out(): bigint;
	};
	memory = ex.memory;

	const send = (bytes: Uint8Array): number => {
		const ptr = ex.alloc(bytes.length);
		view(ptr, bytes.length).set(bytes);
		return ptr;
	};

	const host: InflateHost = {
		begin: () => ex.inflate_begin(),
		restore: (state) => {
			const rc = ex.inflate_restore(send(state), state.length);
			return rc < 0n ? null : Number(rc);
		},
		feed: (bytes, maxOut) => {
			emitted = null;
			const rc = ex.inflate_feed(send(bytes), bytes.length, BigInt(maxOut));
			if (rc < 0n) throw new Error("inflate_feed failed");
			return { consumed: Number(rc), output: emitted };
		},
		atBoundary: () => ex.inflate_status() === 1,
		totalOut: () => Number(ex.inflate_total_out()),
		save: () => {
			const cap = 64 * 1024;
			const ptr = ex.alloc(cap);
			try {
				const n = Number(ex.inflate_save(ptr, cap));
				if (n < 0) throw new Error("inflate_save failed");
				return view(ptr, n).slice();
			} finally {
				ex.dealloc(ptr, cap);
			}
		},
		resumable: () => ({
			feed: host.feed,
			atBoundary: host.atBoundary,
			totalOut: host.totalOut,
			save: host.save,
		}),
	};
	return host;
}
