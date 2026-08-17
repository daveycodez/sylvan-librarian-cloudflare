// The canonical id set, exercised through the REAL wasm import module — the
// same committed artifact the ImportCoordinator instantiates.
//
// What is being pinned is the continuity contract the transform phase leans
// on: the set is built by canonical_add_lines across SLICES ON SEPARATE
// TRANSIENT INSTANCES (a fresh linear memory each time — the same loss shape
// as a Durable Object eviction), carried between them only by the TagData
// snapshot (tags_export → tags_restore), and consumed by transform_lines on
// yet another fresh instance, where it decides every draft's is_canonical and
// nothing else. If the set does not survive that relay, every printing quietly
// imports as foreign and the store builds anyway.
//
// Like tests/routes/card-object-parity.test.ts, this instantiates real wasm:
// no network, one committed file. The host shim is deliberately minimal —
// the coordinator's own shim (src/engine/import-wasm.ts) is exercised where
// its splitting logic lives, via splitDraftEmit in draft-partition.test.ts.

import { describe, expect, test } from "bun:test";
import { fnv1a64OracleId } from "../../src/engine/partition";
import { splitDraftEmit } from "../../src/import-spill";

const wasmBytes = await Bun.file(
	new URL("../../engine/wasm-import/pkg/sylvan_wasm_import.wasm", import.meta.url),
).arrayBuffer();
const WasmModule = (WebAssembly as unknown as { Module: new (b: ArrayBuffer) => WebAssembly.Module }).Module;
const module_ = new WasmModule(wasmBytes);

const enc = new TextEncoder();
const dec = new TextDecoder();

const EMIT = { LOG: 1, DRAFT: 2, STATS: 3, TAGDATA: 7 } as const;

interface Host {
	drafts: Uint8Array[];
	tagData: Uint8Array[];
	stats: Record<string, number>[];
	canonicalAddLines(lines: string): bigint;
	transformLines(lines: string): bigint;
	tagsExport(): Uint8Array;
	tagsRestore(bytes: Uint8Array): bigint;
}

/** One fresh instance = one fresh linear memory, the eviction boundary. */
function instantiate(): Host {
	const drafts: Uint8Array[] = [];
	const tagData: Uint8Array[] = [];
	const stats: Record<string, number>[] = [];
	let memory: WebAssembly.Memory | undefined;
	const view = (ptr: number, len: number) => new Uint8Array((memory as WebAssembly.Memory).buffer, ptr, len);
	const imports: Record<string, Record<string, unknown>> = {
		env: {
			emit(kind: number, ptr: number, len: number) {
				const bytes = view(ptr, len).slice();
				if (kind === EMIT.DRAFT) drafts.push(bytes);
				else if (kind === EMIT.TAGDATA) tagData.push(bytes);
				else if (kind === EMIT.STATS) stats.push(JSON.parse(dec.decode(bytes)) as Record<string, number>);
				else if (kind === EMIT.LOG) console.error(`[wasm-import] ${dec.decode(bytes)}`);
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
		reset(): void;
		canonical_add_lines(ptr: number, len: number): bigint;
		transform_lines(ptr: number, len: number): bigint;
		tags_export(): bigint;
		tags_restore(ptr: number, len: number): bigint;
	};
	memory = ex.memory;
	ex.reset();
	const send = (bytes: Uint8Array, call: (ptr: number, len: number) => bigint, label: string): bigint => {
		const ptr = ex.alloc(bytes.length);
		view(ptr, bytes.length).set(bytes);
		const rc = call(ptr, bytes.length);
		if (rc < 0n) throw new Error(`${label} failed`);
		return rc;
	};
	return {
		drafts,
		tagData,
		stats,
		canonicalAddLines: (lines) =>
			send(enc.encode(lines), (p, l) => ex.canonical_add_lines(p, l), "canonical_add_lines"),
		transformLines: (lines) => send(enc.encode(lines), (p, l) => ex.transform_lines(p, l), "transform_lines"),
		tagsExport: () => {
			tagData.length = 0;
			if (ex.tags_export() < 0n) throw new Error("tags_export failed");
			const total = tagData.reduce((n, b) => n + b.length, 0);
			const merged = new Uint8Array(total);
			let at = 0;
			for (const b of tagData) {
				merged.set(b, at);
				at += b.length;
			}
			return merged;
		},
		tagsRestore: (bytes) => send(bytes, (p, l) => ex.tags_restore(p, l), "tags_restore"),
	};
}

type Fixture = Record<string, unknown> & { id: string; oracle_id: string };
const fixture = async (name: string): Promise<Fixture> =>
	JSON.parse(await Bun.file(new URL(`../../engine/builder/src/fixtures/${name}.json`, import.meta.url)).text());
const bolt = await fixture("lightning_bolt");
const shockJa = await fixture("shock_ja");
const line = (card: unknown) => JSON.stringify(card);

describe("canonical id set through the real wasm module", () => {
	test("the set survives instance churn and marks exactly its members canonical", () => {
		// Slice 1, instance A: half the set arrives, snapshot exported —
		// the canonical phase's per-slice shape.
		const a = instantiate();
		expect(a.canonicalAddLines(line({ id: bolt.id, name: "noise" }))).toBe(1n);
		const snapshotA = a.tagsExport();

		// Slice 2, instance B (instance A's heap is gone — the eviction): restore,
		// add the rest, re-export. Junk and id-less lines are skipped, duplicates
		// are not re-added.
		const b = instantiate();
		b.tagsRestore(snapshotA);
		const fed = [line({ id: bolt.id }), "not json at all", line({ name: "no id here" }), ""].join("\n");
		expect(b.canonicalAddLines(fed)).toBe(0n);
		const snapshot = b.tagsExport();

		// Transform, instance C (transient, like every transform slice): the
		// snapshot is the ONLY thing that traveled. Bolt is in the set; the
		// Japanese Shock printing is not.
		const c = instantiate();
		c.tagsRestore(snapshot);
		c.transformLines([line(bolt), line(shockJa)].join("\n"));
		expect(c.drafts.length).toBe(2);
		const rows = c.drafts.map((d) => JSON.parse(dec.decode(splitDraftEmit(d).draft)) as Record<string, unknown>);
		expect(rows[0]?.scryfall_id).toBe(bolt.id);
		expect(rows[0]?.is_canonical).toBe(true);
		expect(rows[1]?.scryfall_id).toBe(shockJa.id);
		expect(rows[1]?.is_canonical).toBe(false);
		expect(c.stats[0]?.canonical).toBe(1);
	});

	test("draft framing carries the fnv1a64 oracle-id hash partition.ts predicts", () => {
		const c = instantiate();
		c.transformLines([line(bolt), line(shockJa)].join("\n"));
		const [boltDraft, shockDraft] = c.drafts.map((d) => splitDraftEmit(d));
		// The Rust emit and the TypeScript twin must agree on the same bytes —
		// this is the Rust→TS half of the hash-parity contract (the shared
		// vector file pins the two implementations to each other; this pins the
		// FRAMING to both).
		expect(boltDraft?.partHash).toBe(fnv1a64OracleId(bolt.oracle_id as string));
		expect(shockDraft?.partHash).toBe(fnv1a64OracleId(shockJa.oracle_id as string));
	});

	test("a snapshot from before the canonical field restores as an empty set", () => {
		// The tags phase's own snapshots never carry the field; restoring one
		// must not fail, and everything then imports as foreign — the state the
		// coordinator's coverage check exists to make unreachable.
		const c = instantiate();
		c.tagsRestore(enc.encode('{"labels":[],"slugs":[],"oracle":{},"art":{},"oracle_aliases":{},"art_aliases":{}}'));
		c.transformLines(line(bolt));
		const row = JSON.parse(dec.decode(splitDraftEmit(c.drafts[0] as Uint8Array).draft)) as Record<string, unknown>;
		expect(row.is_canonical).toBe(false);
	});
});
