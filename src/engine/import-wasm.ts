// Workers-side instantiation of the wasm import module (engine/wasm-import).
//
// The module speaks a C ABI (no wasm-bindgen): the host provides env.emit /
// env.pull_row, and every payload crosses as bytes. This shim owns the
// instance and routes emits to per-phase handler objects the coordinator
// swaps in. Deps compiled for wasm32 can leak wasm-bindgen placeholder
// imports (getrandom's wasm_js backend, unused on the import path) — those
// are auto-stubbed, throwing loudly if ever actually called.

import wasmModule from "../../engine/wasm-import/pkg/sylvan_wasm_import.wasm";

export interface ImportEmitHandlers {
	onDraft?(bytes: Uint8Array): void;
	onSpill?(bytes: Uint8Array): void;
	onChunk?(bytes: Uint8Array): void;
	onRow?(bytes: Uint8Array): void;
	onTagData?(bytes: Uint8Array): void;
	onStats?(stats: Record<string, number>): void;
	/** Serve spilled row blob #index (add order) during the store build. */
	pullRow?(index: number): Uint8Array | null;
}

const EMIT = { LOG: 1, DRAFT: 2, STATS: 3, SPILL: 4, CHUNK: 5, ROW: 6, TAGDATA: 7 } as const;

interface ImportExports {
	memory: WebAssembly.Memory;
	alloc(len: number): number;
	dealloc(ptr: number, len: number): void;
	reset(): void;
	transform_lines(ptr: number, len: number): bigint;
	tags_begin(): void;
	tags_add_lines(ptr: number, len: number): bigint;
	tags_finish(kind: number): bigint;
	tags_export(): bigint;
	tags_restore(ptr: number, len: number): bigint;
	agg_drafts(ptr: number, len: number): bigint;
	agg_finish(): bigint;
	finalize_begin(): bigint;
	finalize_drafts(ptr: number, len: number): bigint;
	finalize_end(): bigint;
	staged_order(dest: number, cap: number): bigint;
	build_store_stream(): bigint;
	format_version(): number;
	current_alloc(): number;
	peak_alloc(): number;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class ImportWasm {
	private ex: ImportExports;
	private handlers: ImportEmitHandlers = {};
	/**
	 * Identifies this wasm instance's lifetime. The coordinator persists it
	 * with phase progress; a mismatch after a Durable Object eviction means
	 * in-wasm state (tag maps, aggregates, staged interners) was lost and the
	 * dependent phase group must restart from its externally-stored inputs.
	 */
	readonly nonce: string = crypto.randomUUID();

	constructor() {
		const module_ = wasmModule as unknown as WebAssembly.Module;
		const view = (ptr: number, len: number) => new Uint8Array(this.ex.memory.buffer, ptr, len);
		const env = {
			emit: (kind: number, ptr: number, len: number): void => {
				const h = this.handlers;
				switch (kind) {
					case EMIT.LOG:
						console.log(`[wasm-import] ${decoder.decode(view(ptr, len))}`);
						return;
					case EMIT.DRAFT:
						h.onDraft?.(view(ptr, len).slice());
						return;
					case EMIT.STATS:
						h.onStats?.(JSON.parse(decoder.decode(view(ptr, len))) as Record<string, number>);
						return;
					case EMIT.SPILL:
						h.onSpill?.(view(ptr, len).slice());
						return;
					case EMIT.CHUNK:
						h.onChunk?.(view(ptr, len).slice());
						return;
					case EMIT.ROW:
						h.onRow?.(view(ptr, len).slice());
						return;
					case EMIT.TAGDATA:
						h.onTagData?.(view(ptr, len).slice());
						return;
					default:
						throw new Error(`wasm-import emitted unknown kind ${kind}`);
				}
			},
			pull_row: (index: number, dest: number, cap: number): number => {
				const blob = this.handlers.pullRow?.(index) ?? null;
				if (blob === null || blob.length > cap) return -1;
				view(dest, blob.length).set(blob);
				return blob.length;
			},
		};
		const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {
			env: env as unknown as Record<string, WebAssembly.ImportValue>,
		};
		for (const imp of WebAssembly.Module.imports(module_)) {
			const mod = imports[imp.module] ?? {};
			imports[imp.module] = mod;
			if (mod[imp.name] !== undefined) continue;
			if (imp.kind === "function") {
				mod[imp.name] = (...args: unknown[]) => {
					throw new Error(`wasm-import stubbed import called: ${imp.module}.${imp.name}(${args})`);
				};
			} else if (imp.kind === "memory") {
				mod[imp.name] = new WebAssembly.Memory({ initial: 32 });
			} else if (imp.kind === "table") {
				mod[imp.name] = new WebAssembly.Table({ element: "anyfunc", initial: 128 });
			} else {
				mod[imp.name] = 0 as unknown as WebAssembly.ImportValue;
			}
		}
		const instance = new WebAssembly.Instance(module_, imports);
		this.ex = instance.exports as unknown as ImportExports;
	}

	/**
	 * The order `buildStoreStream` will pull rows in, as add-order indices.
	 *
	 * The build needs rows sorted; the spill is written in add order. Knowing
	 * the permutation BEFORE the build lets the host lay the spill out to match
	 * it, so the build reads sequentially. Without it the only way to answer an
	 * arbitrary pullRow is a random seek — 97,802 of them for a real corpus,
	 * which is what pushed the build past the Durable Object CPU ceiling.
	 *
	 * Called once per reorder slice and once at the build, against a wasm
	 * instance that survives every alarm in the group — so the buffer is freed
	 * rather than left to `alloc`'s usual leak.
	 */
	stagedOrder(rows: number): Uint32Array {
		const cap = rows * 4;
		const ptr = this.ex.alloc(cap);
		try {
			const n = Number(this.ex.staged_order(ptr, cap));
			if (n < 0) throw new Error("wasm-import staged_order failed (buffer too small)");
			// Copied out immediately: the view is invalidated by any later
			// allocation that grows linear memory.
			return new Uint32Array(new Uint8Array(this.ex.memory.buffer, ptr, n).slice().buffer);
		} finally {
			// `cap`, not the returned length — the allocation's own size.
			this.ex.dealloc(ptr, cap);
		}
	}

	setHandlers(handlers: ImportEmitHandlers): void {
		this.handlers = handlers;
	}

	reset(): void {
		this.ex.reset();
	}

	formatVersion(): number {
		return this.ex.format_version();
	}

	heap(): { current: number; peak: number } {
		return { current: this.ex.current_alloc(), peak: this.ex.peak_alloc() };
	}

	private sendBytes(bytes: Uint8Array, call: (ptr: number, len: number) => bigint, label: string): bigint {
		const ptr = this.ex.alloc(bytes.length);
		new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
		const rc = call(ptr, bytes.length);
		if (rc < 0n) throw new Error(`wasm-import ${label} failed (see [wasm-import] log)`);
		return rc;
	}

	transformLines(lines: string): bigint {
		return this.sendBytes(encoder.encode(lines), (p, l) => this.ex.transform_lines(p, l), "transform_lines");
	}

	/** Byte-level variant: newline-separated JSONL already encoded. */
	transformLinesRaw(bytes: Uint8Array): bigint {
		return this.sendBytes(bytes, (p, l) => this.ex.transform_lines(p, l), "transform_lines");
	}

	tagsBegin(): void {
		this.ex.tags_begin();
	}

	tagsAddLines(lines: string): bigint {
		return this.sendBytes(encoder.encode(lines), (p, l) => this.ex.tags_add_lines(p, l), "tags_add_lines");
	}

	tagsFinish(kind: 1 | 2): bigint {
		const rc = this.ex.tags_finish(kind);
		if (rc < 0n) throw new Error("wasm-import tags_finish failed");
		return rc;
	}

	tagsExport(): void {
		if (this.ex.tags_export() < 0n) throw new Error("wasm-import tags_export failed");
	}

	tagsRestore(bytes: Uint8Array): bigint {
		return this.sendBytes(bytes, (p, l) => this.ex.tags_restore(p, l), "tags_restore");
	}

	aggDrafts(batch: Uint8Array): bigint {
		return this.sendBytes(batch, (p, l) => this.ex.agg_drafts(p, l), "agg_drafts");
	}

	aggFinish(): bigint {
		const rc = this.ex.agg_finish();
		if (rc < 0n) throw new Error("wasm-import agg_finish failed");
		return rc;
	}

	finalizeBegin(): void {
		if (this.ex.finalize_begin() < 0n) throw new Error("wasm-import finalize_begin failed");
	}

	finalizeDrafts(batch: Uint8Array): bigint {
		return this.sendBytes(batch, (p, l) => this.ex.finalize_drafts(p, l), "finalize_drafts");
	}

	finalizeEnd(): bigint {
		const rc = this.ex.finalize_end();
		if (rc < 0n) throw new Error("wasm-import finalize_end failed");
		return rc;
	}

	buildStoreStream(): bigint {
		const rc = this.ex.build_store_stream();
		if (rc < 0n) throw new Error("wasm-import build_store_stream failed");
		return rc;
	}
}

// Wasm linear memory never shrinks, so phase groups get their own instances:
// a heap that carried transform's high-water into tags/agg/finalize would
// breach the module's 112MB cap that each group individually fits under.

let groupInstance: ImportWasm | null = null;

/** The stateful tags→agg→finalize→build group's instance (created by newGroupWasm). */
export function groupWasm(): ImportWasm {
	groupInstance ??= new ImportWasm();
	return groupInstance;
}

/** Replace the group instance with a fresh zero-height heap (start of tags). */
export function newGroupWasm(): ImportWasm {
	groupInstance = new ImportWasm();
	return groupInstance;
}

/** Release the group instance (import finished) so its ~100MB can be GC'd. */
export function dropGroupWasm(): void {
	groupInstance = null;
}

/** A disposable instance for stateless work (transform slices). */
export function transientWasm(): ImportWasm {
	return new ImportWasm();
}
