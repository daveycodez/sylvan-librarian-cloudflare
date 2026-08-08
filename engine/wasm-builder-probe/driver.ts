// Drives the wasm store-build probe: feeds finalized rows (JSONL) into the
// memory-capped wasm module in batches, collects the streamed archive chunks,
// and reports peak heap + sha256 for parity comparison with the native build.
//
//   bun engine/wasm-builder-probe/driver.ts <probe.wasm> <rows.jsonl>
//
// V8 wasm semantics here match workerd's; the link-time --max-memory cap makes
// this a faithful stand-in for a 128MB Worker isolate (minus JS-side heap,
// which is why the cap is set below 128MB).

import { createHash } from "node:crypto";

const [wasmPath, rowsPath] = process.argv.slice(2);
if (!wasmPath || !rowsPath) {
	console.error("usage: bun driver.ts <probe.wasm> <rows.jsonl>");
	process.exit(2);
}

const module_ = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());

// The probe itself imports only env.emit_chunk / env.log_err, but deps
// compiled for wasm32-unknown-unknown can leak wasm-bindgen placeholder
// imports (getrandom's wasm_js backend). None of them run on the build path;
// stub every unknown function import with a loud thrower.
const hash = createHash("sha256");
let totalChunkBytes = 0;
let chunkCount = 0;

let memory: WebAssembly.Memory | undefined;
const view = (ptr: number, len: number) => new Uint8Array(memory!.buffer, ptr, len);

const decoder = new TextDecoder();
// Spilled row blobs, indexed by add order — the JS stand-in for DO SQLite.
const spilled: Uint8Array[] = [];
let spilledBytes = 0;
const chunks: Uint8Array[] = [];
const env = {
	emit_chunk(ptr: number, len: number) {
		if (chunkCount === 0) {
			console.error(
				`  first chunk: heap current ${mb(ex.current_alloc())} MB (≈ CardData complete), peak so far ${mb(ex.peak_alloc())} MB`,
			);
		}
		const copy = view(ptr, len).slice(); // copy out before the buffer moves
		hash.update(copy);
		chunks.push(copy);
		totalChunkBytes += len;
		chunkCount += 1;
	},
	log_err(ptr: number, len: number) {
		console.error(`[wasm] ${decoder.decode(view(ptr, len))}`);
	},
	spill_row(ptr: number, len: number) {
		spilled.push(view(ptr, len).slice());
		spilledBytes += len;
	},
	pull_row(index: number, dest: number, cap: number): number {
		const blob = spilled[index];
		if (blob === undefined || blob.length > cap) return -1;
		view(dest, blob.length).set(blob);
		return blob.length;
	},
};

const imports: Record<string, Record<string, unknown>> = { env };
for (const imp of WebAssembly.Module.imports(module_)) {
	imports[imp.module] ??= {};
	if (imports[imp.module][imp.name] !== undefined) continue;
	if (imp.kind === "function") {
		imports[imp.module][imp.name] = (...args: unknown[]) => {
			throw new Error(`stubbed import called: ${imp.module}.${imp.name}(${args})`);
		};
	} else if (imp.kind === "memory") {
		imports[imp.module][imp.name] = new WebAssembly.Memory({ initial: 32 });
	} else if (imp.kind === "table") {
		imports[imp.module][imp.name] = new WebAssembly.Table({ element: "anyfunc", initial: 128 });
	} else if (imp.kind === "global") {
		imports[imp.module][imp.name] = 0;
	}
}

const instance = await WebAssembly.instantiate(module_, imports);
const ex = instance.exports as {
	memory: WebAssembly.Memory;
	probe_alloc(len: number): number;
	builder_new(): void;
	builder_add_jsonl(ptr: number, len: number): bigint;
	builder_finish(): bigint;
	peak_alloc(): number;
	current_alloc(): number;
};
memory = ex.memory;

const mb = (n: number | bigint) => (Number(n) / (1024 * 1024)).toFixed(1);
console.error(`initial wasm memory: ${mb(memory.buffer.byteLength)} MB`);

const encoder = new TextEncoder();
const BATCH_LINES = 2000;
const started = performance.now();

ex.builder_new();
let staged = 0n;
let batch: string[] = [];
let feeds = 0;
const feed = () => {
	if (batch.length === 0) return;
	const bytes = encoder.encode(batch.join("\n"));
	batch = [];
	const ptr = ex.probe_alloc(bytes.length);
	view(ptr, bytes.length).set(bytes);
	try {
		staged = ex.builder_add_jsonl(ptr, bytes.length);
	} catch (err) {
		console.error(
			`TRAP at feed #${feeds} (staged ${staged} rows): heap current ${mb(ex.current_alloc())} MB, peak ${mb(ex.peak_alloc())} MB, linear memory ${mb(memory!.buffer.byteLength)} MB`,
		);
		throw err;
	}
	feeds += 1;
	if (feeds % 10 === 0) {
		console.error(
			`  feed #${feeds}: staged ${staged}, heap ${mb(ex.current_alloc())} MB, linear ${mb(memory!.buffer.byteLength)} MB`,
		);
	}
	if (staged < 0n) throw new Error("builder_add_jsonl failed (see [wasm] log)");
};

const stream = Bun.file(rowsPath).stream();
let pending = "";
for await (const piece of stream.pipeThrough(new TextDecoderStream())) {
	pending += piece;
	const lines = pending.split("\n");
	pending = lines.pop() ?? "";
	for (const line of lines) {
		if (line.length === 0) continue;
		batch.push(line);
		if (batch.length >= BATCH_LINES) feed();
	}
}
if (pending.length > 0) batch.push(pending);
feed();

const stagedDone = performance.now();
console.error(`staged ${staged} rows in ${((stagedDone - started) / 1000).toFixed(1)}s (spilled ${mb(spilledBytes)} MB in ${spilled.length} blobs)`);
console.error(`  wasm heap: current ${mb(ex.current_alloc())} MB, peak ${mb(ex.peak_alloc())} MB, linear memory ${mb(memory.buffer.byteLength)} MB`);

const total = ex.builder_finish();
if (total < 0n) throw new Error("builder_finish failed (see [wasm] log)");
const finishDone = performance.now();

console.error(`finished archive in ${((finishDone - stagedDone) / 1000).toFixed(1)}s`);
console.log(`store_bytes     ${total} (${mb(total)} MB) in ${chunkCount} chunks`);
console.log(`sha256          ${hash.digest("hex")}`);
console.log(`wasm_heap_peak  ${mb(ex.peak_alloc())} MB`);
console.log(`linear_memory   ${mb(memory.buffer.byteLength)} MB  <-- must stay under the 128MB isolate ceiling`);
if (totalChunkBytes !== Number(total)) throw new Error("chunk byte total mismatch");

// Reassemble the streamed chunks and write the store to disk so the native
// `memprobe compare` can check semantic parity against the Vec-path build.
const outPath = process.argv[4];
if (outPath) {
	const all = new Uint8Array(totalChunkBytes);
	let off = 0;
	for (const c of chunks) {
		all.set(c, off);
		off += c.length;
	}
	await Bun.write(outPath, all);
	console.error(`wrote ${outPath}`);
}
