// The printed-names blob (backlog x24) against every partition's own containment stage, on the REAL
// corpus.
//
// The claim: wherever the names index plans a `/cards/named?fuzzy=` needle `everywhere` (only
// containment's printed tier is undecided), the plan's partitions plus the blob's printed carriers
// are every partition whose own containment stage answers anything — so asking only those gives the
// ten-partition answer, and none at all is the needle's 404. Checked on every partition of a local
// store build, through the committed wasm (one instance per partition, the index and the blob loaded
// into another), the production encoders, over needles cut from the corpus's own printed names —
// single words, printed words pooled with oracle words, words across a non-ASCII letter — and the
// sentences production's misses are.
//
// Opt-in, because it loads every partition of the corpus:
//
//   SYLVAN_REAL_DIFFERENTIAL=1 bun test tests/engine/printed-names-real.test.ts
//
// with STORE_BUILD_DIR pointing at a store build (default: this checkout's store-build/).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { encodeCardNames, ledByPartition } from "../../src/engine/card-names";
import { encodePrintedNames, PRINTED_NAMES_HEADER } from "../../src/engine/printed-names";
import { FUZZY_SIMILARITY_FLOOR, FUZZY_SIMILARITY_LEAD, FUZZY_WEAK_BELOW } from "../../src/engine/types";
import { newEngine, type TestEngine } from "./wasm-engine";

const STORE_DIR = process.env.STORE_BUILD_DIR ?? join(import.meta.dir, "../../store-build");
const MANIFEST = join(STORE_DIR, "manifest.json");

interface Manifest {
	format_version: number;
	partitions: { store_key: string }[];
}

const opted = process.env.SYLVAN_REAL_DIFFERENTIAL === "1";
const manifest: Manifest | null =
	opted && existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest) : null;
const readable = manifest !== null && manifest.format_version === newEngine().use((g) => g.store_version());

interface PrintedGlue {
	store_printed_records_tsv(): Uint8Array;
	load_printed_names(gz: Uint8Array): number;
	printed_names_heap_bytes(): number;
	printed_names_partitions(wordsJson: string): string;
	cards_containing_all_words(wordsJson: string, setCode: string, limit: number, fieldsJson: string): string;
}

describe.skipIf(!readable)(`the printed-names blob vs every partition's containment, on ${STORE_DIR}`, () => {
	test("the plan's partitions plus the printed carriers are every partition containment answers from", () => {
		const m = manifest as Manifest;
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		const engines: TestEngine[] = m.partitions.map((p) => {
			const engine = newEngine();
			const bytes = new Uint8Array(readFileSync(join(STORE_DIR, p.store_key)));
			engine.use((g) => g.init_store(bytes));
			return engine;
		});
		const names: Uint8Array[] = [];
		const printed: Uint8Array[] = [];
		for (const [k, engine] of engines.entries()) {
			names.push(encoder.encode(ledByPartition(k, decoder.decode(engine.use((g) => g.store_name_records_tsv())))));
			const tsv = engine.use((g) => (g as unknown as PrintedGlue).store_printed_records_tsv());
			printed.push(encoder.encode(ledByPartition(k, decoder.decode(tsv))));
		}
		const raw = encodePrintedNames(printed);
		const gz = gzipSync(raw);
		const index = newEngine();
		index.use((g) => g.load_names(gzipSync(encodeCardNames(names))));
		const started = performance.now();
		const forms = index.use((g) => (g as unknown as PrintedGlue).load_printed_names(gz));
		const loadMs = performance.now() - started;
		const heap = index.use((g) => (g as unknown as PrintedGlue).printed_names_heap_bytes());

		// Needles: every 40th card's printed forms, cut three ways, and the sentences.
		const needles = [
			"blue creatures that combo infinitely",
			"cards that lower equip cost",
			"littlebones",
			"red goad",
			"blitzschlag",
			"blitzschlagg",
			"ego a derva",
			"foudre",
		];
		const body = decoder.decode(raw).slice(PRINTED_NAMES_HEADER.length).split("\n").filter(Boolean);
		for (let i = 0; i < body.length; i += 40) {
			const [, oracle, ...forms] = (body[i] as string).split("\t");
			const form = forms[forms.length - 1] as string;
			const run = form.split(" ")[0] as string;
			if (run.length >= 6) needles.push(run.slice(1, 6));
			if (run.length >= 5 && oracle && oracle.length >= 4) needles.push(`${oracle.slice(-4)} ${run.slice(0, 5)}`);
			if (form.includes(" ")) needles.push(form.replace(" ", ""));
		}
		const wordsOf = (q: string) => q.split(/[^\w']+/u).filter((w) => w.length > 0);
		const answering: number[][] = needles.map(() => []);
		for (const [k, engine] of engines.entries()) {
			for (const [i, q] of needles.entries()) {
				const contained = engine.use((g) =>
					(g as unknown as PrintedGlue).cards_containing_all_words(JSON.stringify(wordsOf(q)), "", 2, '["name"]'),
				);
				if ((JSON.parse(contained) as unknown[]).length > 0) answering[i]?.push(k);
			}
		}
		let wide = 0;
		let asked = 0;
		let none = 0;
		let carriersMs = 0;
		for (const [i, q] of needles.entries()) {
			const words = JSON.stringify(wordsOf(q));
			const plan = JSON.parse(
				index.use((g) => g.names_fuzzy_plan(q, words, FUZZY_SIMILARITY_FLOOR, FUZZY_SIMILARITY_LEAD, FUZZY_WEAK_BELOW)),
			) as { partitions: number[]; everywhere: boolean };
			if (!plan.everywhere) continue;
			wide++;
			const t0 = performance.now();
			const carriers = JSON.parse(index.use((g) => (g as unknown as PrintedGlue).printed_names_partitions(words))) as {
				partitions: number[];
			} | null;
			carriersMs += performance.now() - t0;
			expect(carriers).not.toBeNull();
			const union = new Set([...plan.partitions, ...(carriers?.partitions ?? [])]);
			expect({ q, missed: (answering[i] as number[]).filter((p) => !union.has(p)) }).toEqual({ q, missed: [] });
			asked += union.size;
			if (union.size === 0) none++;
		}
		console.log(
			`printed names: ${forms} forms, ${raw.byteLength} bytes raw, ${gz.byteLength} gzip; load ${loadMs.toFixed(1)}ms, ` +
				`${(heap / 1048576).toFixed(2)}MB in wasm; ${wide} of ${needles.length} needles planned everywhere now ask ` +
				`${asked} of ${wide * engines.length} partitions (${none} none), carriers ${(carriersMs / Math.max(1, wide)).toFixed(2)}ms each`,
		);
		expect(wide).toBeGreaterThan(100);
	}, 600_000);
});
