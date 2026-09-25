// The nightly's half of the oracle index, through the REAL wasm import module: `scores_add_drafts`
// emits one EMIT_ORACLE_PAIRS run per batch, right after that batch's EMIT_ROUTING, holding one
// 32-byte (scryfall id, oracle id) record per draft whose card object carries an oracle id — and
// NONE for a reversible printing, whose card object has no top-level oracle_id. The coordinator
// stages both emits in one routing_keys row per batch, so the ordering and the always-emit rule
// are what that staging leans on. (Which printings get a record is pinned against the NATIVE
// builder's rows in engine/builder: `both_publishers_emit_the_same_oracle_pairs`.)

import { describe, expect, test } from "bun:test";
import {
	encodeOracleIndexBuckets,
	ORACLE_PAIR_BYTES,
	oracleIdLookup,
	oracleIndexBucketOf,
} from "../../src/engine/oracle-index";
import { splitDraftEmit } from "../../src/import-spill";

const wasmBytes = await Bun.file(
	new URL("../../engine/wasm-import/pkg/sylvan_wasm_import.wasm", import.meta.url),
).arrayBuffer();
const WasmModule = (WebAssembly as unknown as { Module: new (b: ArrayBuffer) => WebAssembly.Module }).Module;
const module_ = new WasmModule(wasmBytes);
const enc = new TextEncoder();
const dec = new TextDecoder();
const EMIT = { LOG: 1, DRAFT: 2, ROUTING: 8, ORACLE_PAIRS: 11 } as const;

function instantiate() {
	const emits: { kind: number; bytes: Uint8Array }[] = [];
	let memory: WebAssembly.Memory | undefined;
	const view = (ptr: number, len: number) => new Uint8Array((memory as WebAssembly.Memory).buffer, ptr, len);
	const imports: Record<string, Record<string, unknown>> = {
		env: {
			emit(kind: number, ptr: number, len: number) {
				const bytes = view(ptr, len).slice();
				if (kind === EMIT.LOG) console.error(`[wasm-import] ${dec.decode(bytes)}`);
				else emits.push({ kind, bytes });
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
	const ex = new WebAssembly.Instance(module_, imports as WebAssembly.Imports).exports as unknown as {
		memory: WebAssembly.Memory;
		alloc(len: number): number;
		reset(): void;
		transform_lines(ptr: number, len: number): bigint;
		scores_add_drafts(ptr: number, len: number, partitionCount: number): bigint;
	};
	memory = ex.memory;
	ex.reset();
	const send = (bytes: Uint8Array, call: (ptr: number, len: number) => bigint): bigint => {
		const ptr = ex.alloc(bytes.length);
		view(ptr, bytes.length).set(bytes);
		const rc = call(ptr, bytes.length);
		if (rc < 0n) throw new Error("wasm call failed");
		return rc;
	};
	return {
		emits,
		transform: (lines: string) => send(enc.encode(lines), (p, l) => ex.transform_lines(p, l)),
		scores: (batch: Uint8Array, n: number) => send(batch, (p, l) => ex.scores_add_drafts(p, l, n)),
	};
}

function lengthPrefixed(blobs: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(blobs.reduce((n, b) => n + 4 + b.length, 0));
	const dv = new DataView(out.buffer);
	let at = 0;
	for (const b of blobs) {
		dv.setUint32(at, b.length, true);
		out.set(b, at + 4);
		at += 4 + b.length;
	}
	return out;
}

type Card = Record<string, unknown> & { id: string; oracle_id: string };
const fixture = async (name: string) =>
	JSON.parse(await Bun.file(new URL(`../../engine/builder/src/fixtures/${name}.json`, import.meta.url)).text()) as Card;
const bolt = await fixture("lightning_bolt");
const reversible = await fixture("delver_of_secrets");
reversible.layout = "reversible_card";
for (const face of reversible.card_faces as Record<string, unknown>[]) face.layout = "normal";
reversible.id = "cccccccc-0000-4000-8000-000000000099";

const CARDS: Card[] = [
	...Array.from({ length: 6 }, (_, i) => ({
		...bolt,
		id: `${(i * 40).toString(16).padStart(2, "0")}aaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
		oracle_id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
		name: `Pairs Card ${i}`,
	})),
	reversible,
];

/** The corpus's staged drafts, as the coordinator holds them. */
function drafts(): Uint8Array[] {
	const host = instantiate();
	host.transform(CARDS.map((c) => JSON.stringify(c)).join("\n"));
	return host.emits.filter((e) => e.kind === EMIT.DRAFT).map((e) => splitDraftEmit(e.bytes).draft);
}

describe("EMIT_ORACLE_PAIRS through the real wasm module", () => {
	test("one run per batch, right after its routing keys, one record per non-reversible draft", () => {
		const staged = drafts();
		expect(staged.length).toBe(CARDS.length);
		const host = instantiate();
		// Two batches, as two scores calls: each yields [ROUTING, ORACLE_PAIRS] in that order.
		host.scores(lengthPrefixed(staged.slice(0, 4)), 3);
		host.scores(lengthPrefixed(staged.slice(4)), 3);
		expect(host.emits.map((e) => e.kind)).toEqual([EMIT.ROUTING, EMIT.ORACLE_PAIRS, EMIT.ROUTING, EMIT.ORACLE_PAIRS]);
		const runs = host.emits.filter((e) => e.kind === EMIT.ORACLE_PAIRS).map((e) => e.bytes);
		expect(runs.map((r) => r.length / ORACLE_PAIR_BYTES)).toEqual([4, 2]); // the reversible one is left out

		const { buckets, pairCount } = encodeOracleIndexBuckets(runs);
		expect(pairCount).toBe(6);
		for (const card of CARDS.slice(0, 6)) {
			expect(oracleIdLookup(buckets[oracleIndexBucketOf(card.id) as number] as Uint8Array, card.id)).toBe(
				card.oracle_id,
			);
		}
		expect(
			oracleIdLookup(buckets[oracleIndexBucketOf(reversible.id) as number] as Uint8Array, reversible.id),
		).toBeNull();
	});

	test("an empty batch still emits its (empty) run, and partition_count 0 emits neither", () => {
		const host = instantiate();
		host.scores(lengthPrefixed([]), 3);
		expect(host.emits.map((e) => [e.kind, e.bytes.length])).toEqual([
			[EMIT.ROUTING, 5], // just the name-keys stamp line
			[EMIT.ORACLE_PAIRS, 0],
		]);
		const off = instantiate();
		off.scores(lengthPrefixed(drafts()), 0);
		expect(off.emits).toEqual([]);
	});
});
