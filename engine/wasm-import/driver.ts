// End-to-end exercise of the wasm import module against the memprobe corpus:
// bulk JSONL → transform → tags → aggregate → finalize → store build, with
// the host side played by in-memory arrays (standing in for DO SQLite / D1).
//
//   bun engine/wasm-import/driver.ts <import.wasm> <bulk.jsonl> <tags.json> \
//       <rows-out.jsonl> <store-out.store>
//
// Outputs let the native pipeline act as the oracle:
//   rows-out.jsonl   must equal memprobe's rows.jsonl byte-for-byte
//   store-out.store  must be semantically identical to the native store
//                    (memprobe compare)

import { createHash } from "node:crypto";

const [wasmPath, bulkPath, tagsPath, rowsOut, storeOut] = process.argv.slice(2);
if (!wasmPath || !bulkPath || !tagsPath || !rowsOut || !storeOut) {
	console.error("usage: bun driver.ts <import.wasm> <bulk.jsonl> <tags.json> <rows-out.jsonl> <store-out.store>");
	process.exit(2);
}

const module_ = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());

// ── host state (the DO-SQLite stand-ins) ────────────────────────────────────
const draftBatches: Uint8Array[] = []; // length-prefixed batches, emission order
let draftBatchBuf: Uint8Array[] = [];
const spilled: Uint8Array[] = [];
const rowLines: string[] = [];
const chunks: Uint8Array[] = [];
let chunkBytes = 0;
const statsLog: unknown[] = [];
const decoder = new TextDecoder();

let memory: WebAssembly.Memory | undefined;
const view = (ptr: number, len: number) => new Uint8Array(memory!.buffer, ptr, len);

const EMIT = { LOG: 1, DRAFT: 2, STATS: 3, SPILL: 4, CHUNK: 5, ROW: 6, TAGDATA: 7 } as const;

const env = {
	emit(kind: number, ptr: number, len: number) {
		const bytes = view(ptr, len).slice();
		switch (kind) {
			case EMIT.LOG:
				console.error(`[wasm] ${decoder.decode(bytes)}`);
				break;
			case EMIT.DRAFT:
				draftBatchBuf.push(bytes);
				break;
			case EMIT.STATS:
				statsLog.push(JSON.parse(decoder.decode(bytes)));
				break;
			case EMIT.SPILL:
				spilled.push(bytes);
				break;
			case EMIT.CHUNK:
				chunks.push(bytes);
				chunkBytes += bytes.length;
				break;
			case EMIT.ROW:
				rowLines.push(decoder.decode(bytes));
				break;
			case EMIT.TAGDATA:
				break; // persistence path; not needed in-process
			default:
				throw new Error(`unknown emit kind ${kind}`);
		}
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
	alloc(len: number): number;
	reset(): void;
	transform_lines(ptr: number, len: number): bigint;
	tags_begin(): void;
	tags_add_lines(ptr: number, len: number): bigint;
	tags_finish(kind: number): bigint;
	agg_drafts(ptr: number, len: number): bigint;
	agg_finish(): bigint;
	finalize_begin(): bigint;
	finalize_drafts(ptr: number, len: number): bigint;
	finalize_end(): bigint;
	build_store_stream(): bigint;
	current_alloc(): number;
	peak_alloc(): number;
};
memory = ex.memory;

const encoder = new TextEncoder();
const mb = (n: number | bigint) => (Number(n) / (1024 * 1024)).toFixed(1);

function sendBytes(bytes: Uint8Array, call: (ptr: number, len: number) => bigint, label: string): bigint {
	const ptr = ex.alloc(bytes.length);
	view(ptr, bytes.length).set(bytes);
	const rc = call(ptr, bytes.length);
	if (rc < 0n) throw new Error(`${label} failed (see [wasm] log)`);
	return rc;
}

function lengthPrefixed(blobs: Uint8Array[]): Uint8Array {
	const total = blobs.reduce((n, b) => n + 4 + b.length, 0);
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	let at = 0;
	for (const b of blobs) {
		dv.setUint32(at, b.length, true);
		out.set(b, at + 4);
		at += 4 + b.length;
	}
	return out;
}

async function* fileLines(path: string): AsyncGenerator<string[]> {
	let pending = "";
	const batch: string[] = [];
	for await (const piece of Bun.file(path).stream().pipeThrough(new TextDecoderStream())) {
		pending += piece;
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length === 0) continue;
			batch.push(line);
			if (batch.length >= 2000) {
				yield batch.splice(0);
			}
		}
	}
	if (pending.length > 0) batch.push(pending);
	if (batch.length > 0) yield batch;
}

// ── 1. transform ────────────────────────────────────────────────────────────
ex.reset();
let t = performance.now();
let drafts = 0n;
for await (const lines of fileLines(bulkPath)) {
	drafts = sendBytes(encoder.encode(lines.join("\n")), (p, l) => ex.transform_lines(p, l), "transform_lines");
	if (draftBatchBuf.length >= 2000) {
		draftBatches.push(lengthPrefixed(draftBatchBuf.splice(0)));
	}
}
if (draftBatchBuf.length > 0) draftBatches.push(lengthPrefixed(draftBatchBuf.splice(0)));
console.error(`transform: ${drafts} drafts in ${((performance.now() - t) / 1000).toFixed(1)}s, heap ${mb(ex.current_alloc())}/${mb(ex.peak_alloc())} MB`);

// ── 2. tags (synthesized dump records from the gen's tag maps) ──────────────
t = performance.now();
const tagMaps = (await Bun.file(tagsPath).json()) as {
	oracle: Record<string, string[]>;
	art: Record<string, string[]>;
};
function feedTags(map: Record<string, string[]>, idField: string, kind: number) {
	// One parentless tag record per slug, tagging every id that lists it —
	// build_id_to_tags reproduces the maps exactly (no ancestors involved).
	const bySlug = new Map<string, string[]>();
	for (const [id, slugs] of Object.entries(map)) {
		for (const slug of slugs) {
			let ids = bySlug.get(slug);
			if (!ids) bySlug.set(slug, (ids = []));
			ids.push(id);
		}
	}
	ex.tags_begin();
	let batch: string[] = [];
	let n = 0;
	for (const [slug, ids] of bySlug) {
		batch.push(
			JSON.stringify({ id: `uuid-${slug}`, slug, parent_ids: [], taggings: ids.map((id) => ({ [idField]: id })) }),
		);
		if (batch.length >= 500) {
			sendBytes(encoder.encode(batch.join("\n")), (p, l) => ex.tags_add_lines(p, l), "tags_add_lines");
			batch = [];
		}
		n++;
	}
	if (batch.length > 0) sendBytes(encoder.encode(batch.join("\n")), (p, l) => ex.tags_add_lines(p, l), "tags_add_lines");
	const mapped = ex.tags_finish(kind);
	if (mapped < 0n) throw new Error("tags_finish failed");
	console.error(`tags kind=${kind}: ${n} slugs -> ${mapped} ids`);
}
feedTags(tagMaps.oracle, "oracle_id", 1);
feedTags(tagMaps.art, "illustration_id", 2);
console.error(`tags in ${((performance.now() - t) / 1000).toFixed(1)}s, heap ${mb(ex.current_alloc())}/${mb(ex.peak_alloc())} MB`);

// ── 3. aggregate ────────────────────────────────────────────────────────────
t = performance.now();
for (const batch of draftBatches) {
	sendBytes(batch, (p, l) => ex.agg_drafts(p, l), "agg_drafts");
}
const winners = ex.agg_finish();
console.error(`agg: ${winners} winners in ${((performance.now() - t) / 1000).toFixed(1)}s, heap ${mb(ex.current_alloc())}/${mb(ex.peak_alloc())} MB`);

// ── 4. finalize ─────────────────────────────────────────────────────────────
t = performance.now();
if (ex.finalize_begin() < 0n) throw new Error("finalize_begin failed");
for (const batch of draftBatches) {
	sendBytes(batch, (p, l) => ex.finalize_drafts(p, l), "finalize_drafts");
}
const staged = ex.finalize_end();
if (staged < 0n) throw new Error("finalize_end failed");
console.error(`finalize: ${staged} rows staged in ${((performance.now() - t) / 1000).toFixed(1)}s, heap ${mb(ex.current_alloc())}/${mb(ex.peak_alloc())} MB`);

// ── 5. store build ──────────────────────────────────────────────────────────
t = performance.now();
const total = ex.build_store_stream();
if (total < 0n) throw new Error("build_store_stream failed");
console.error(`build: ${mb(total)} MB archive in ${((performance.now() - t) / 1000).toFixed(1)}s, heap peak ${mb(ex.peak_alloc())} MB, linear ${mb(memory.buffer.byteLength)} MB`);

// ── outputs ─────────────────────────────────────────────────────────────────
await Bun.write(rowsOut, `${rowLines.join("\n")}\n`);
const all = new Uint8Array(chunkBytes);
let off = 0;
for (const c of chunks) {
	all.set(c, off);
	off += c.length;
}
await Bun.write(storeOut, all);
const hash = createHash("sha256").update(all).digest("hex");
console.log(`rows            ${rowLines.length} -> ${rowsOut}`);
console.log(`store_bytes     ${total} in ${chunks.length} chunks -> ${storeOut}`);
console.log(`sha256          ${hash}`);
console.log(`stats           ${JSON.stringify(statsLog.at(-1))}`);
console.log(`linear_memory   ${mb(memory.buffer.byteLength)} MB  <-- 128MB isolate ceiling`);
