// Columnar pages off a REAL store (backlog n11): the engine-written page must be byte-identical to
// the one `serializeCards` wrote, on the site's own queries, through every path that answers one —
// the single-store query, the random draw, and the partitioned gather, including a gather in which
// one partition is still on the previous build and refuses the new shape.
//
// Needs a local store build: STORE_BUILD_DIR, or this checkout's store-build/ (the builder's output
// directory; `scripts/import-store.sh` writes it). Without one — CI — the suite skips; the synthetic
// parity suite (columnar-parity.test.ts) still covers every writer rule.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	assembleColumnar,
	columnKeys,
	columnsGather,
	decodeShapedPage,
	serializeCards,
} from "../../src/engine/columnar";
import {
	decodeRowPacket,
	joinJsonArray,
	type PartitionClient,
	parseSlots,
	ROWS_GATHER,
	runTwoPhase,
} from "../../src/engine/gather";
import type { EngineSearchOptions } from "../../src/engine/types";
import { canonicalStringify, type FilterValue, parseScryfallQuery } from "../../src/parser";
import { defaultLaneExclusionTree } from "../../src/routes/extras-gate";
import { DEFAULT_RESULT_FIELDS, RESULT_FIELD_NAMES } from "../../src/routes/search";
import { newEngine, type TestEngine } from "./wasm-engine";

const STORE_DIR = process.env.STORE_BUILD_DIR ?? join(import.meta.dir, "../../store-build");
const MANIFEST = join(STORE_DIR, "manifest.json");

interface Manifest {
	format_version: number;
	partitions: { store_key: string }[];
}

const manifest: Manifest | null = existsSync(MANIFEST)
	? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest)
	: null;
const readable = manifest !== null && manifest.format_version === newEngine().use((g) => g.store_version());

/** How many partitions the gather runs across: enough to merge, few enough to hold in memory. */
const GATHER_WIDTH = 3;

const decoder = new TextDecoder();
const text = (bytes: Uint8Array) => decoder.decode(bytes);

/** The options object WasmEngine.optsJson writes (store.ts), so the engine sees what production sends. */
function optsJson(opts: EngineSearchOptions): string {
	return JSON.stringify({
		unique: opts.unique,
		prefer: opts.prefer,
		orderby: opts.orderby,
		direction: opts.direction,
		limit: opts.limit,
		offset: opts.offset,
		fields: opts.fields,
		include_multilingual: opts.includeMultilingual === true,
	});
}

function searchOpts(q: string, fields: readonly string[], limit: number, offset = 0): EngineSearchOptions {
	return {
		filterTreeJson: canonicalStringify(parseScryfallQuery(q) as FilterValue),
		unique: "card",
		prefer: "default",
		orderby: "name",
		direction: "asc",
		limit,
		offset,
		fields: [...fields],
	};
}

/** The site's page (default fields, 100 rows), a wide page, and the large one. */
const PAGES: { label: string; opts: EngineSearchOptions }[] = [
	{ label: "t:elf, site default", opts: searchOpts("t:elf", DEFAULT_RESULT_FIELDS, 100) },
	{ label: "o:draw, site default", opts: searchOpts("o:draw", DEFAULT_RESULT_FIELDS, 100) },
	{ label: "c:r, page 3", opts: searchOpts("c:r", DEFAULT_RESULT_FIELDS, 100, 200) },
	{ label: "t:dragon, every field", opts: searchOpts("t:dragon", RESULT_FIELD_NAMES, 330) },
	{ label: "cmc=0, every field", opts: searchOpts("cmc=0", RESULT_FIELD_NAMES, 1000) },
	{ label: "t:creature, 1000 rows × every field", opts: searchOpts("t:creature", RESULT_FIELD_NAMES, 1000) },
	{ label: "no match", opts: searchOpts("t:zzzqqq", DEFAULT_RESULT_FIELDS, 100) },
];

describe.skipIf(!readable)(`columnar pages off the local store (${STORE_DIR})`, () => {
	// bun runs a skipped describe's body to collect its tests, so this must not assume a store.
	const partitions = readable ? (manifest as Manifest).partitions.slice(0, GATHER_WIDTH) : [];
	const engines: TestEngine[] = partitions.map((p) => {
		const engine = newEngine();
		const bytes = new Uint8Array(readFileSync(join(STORE_DIR, p.store_key)));
		engine.use((g) => g.init_store(bytes));
		return engine;
	});
	const single = engines[0] as TestEngine;

	for (const { label, opts } of PAGES) {
		test(`single store — ${label}`, () => {
			const reference = single.use((g) => JSON.parse(g.query(opts.filterTreeJson, optsJson(opts)))) as {
				total: number;
				rows: Record<string, unknown>[];
			};
			const { total, frames } = decodeShapedPage(
				single.use((g) => g.query_shaped(opts.filterTreeJson, optsJson(opts), "columns")),
			);
			expect(total).toBe(reference.total);
			expect(frames.length).toBe(reference.rows.length);
			expect(text(assembleColumnar(columnKeys(opts.fields), frames))).toBe(serializeCards(reference.rows, "columnar"));
		});
	}

	test("the random draw, both shapes, over the route's exclusion tree", () => {
		const tree = canonicalStringify(defaultLaneExclusionTree() as FilterValue);
		for (const [n, fields] of [
			[12, DEFAULT_RESULT_FIELDS],
			[1000, RESULT_FIELD_NAMES],
		] as const) {
			for (const seed of [1n, 7n, 0xdead_beef_cafe_f00dn]) {
				const reference = single.use((g) =>
					JSON.parse(g.random_search(n, seed, tree, JSON.stringify(fields))),
				) as Record<string, unknown>[];
				const shaped = (shape: string) =>
					decodeRowPacket(single.use((g) => g.random_search_shaped(n, seed, tree, JSON.stringify(fields), shape)));
				// The engine draws a deterministic SET per seed but lists it in HashSet order, which
				// is seeded per instance and per call — so two draws are compared as sets, and each
				// page is held to being exactly what JSON.stringify writes for its own contents.
				const rowsPage = text(joinJsonArray(shaped("rows")));
				const rows = JSON.parse(rowsPage) as Record<string, unknown>[];
				expect(rowsPage).toBe(serializeCards(rows, "rows"));
				const keys = columnKeys(fields);
				const columnsPage = text(assembleColumnar(keys, shaped("columns")));
				const columns = JSON.parse(columnsPage) as Record<string, unknown[]>;
				const inverted = (columns[keys[0] as string] ?? []).map((_, i) =>
					Object.fromEntries(keys.map((k) => [k, (columns[k] as unknown[])[i]])),
				);
				expect(columnsPage).toBe(serializeCards(inverted, "columnar"));
				const asSet = (page: Record<string, unknown>[]) => page.map((r) => JSON.stringify(r)).sort();
				expect(asSet(rows)).toEqual(asSet(reference));
				expect(asSet(inverted)).toEqual(asSet(reference));
				expect(rows.length).toBe(n);
			}
		}
	});

	/** Partition clients over the loaded engines, the way SearchEngineDO wires its siblings. */
	function clients(legacyPartitions: ReadonlySet<number> = new Set()): PartitionClient[] {
		return engines.map((engine, p) => {
			const storeKey = (partitions[p] as { store_key: string }).store_key;
			// The previous build's engine: `parse_shape` knew only rows and cards, and said so.
			const refuse = (shape: string) => {
				if (legacyPartitions.has(p) && shape === "columns") {
					throw new Error(`unknown row shape "columns": expected "rows" or "cards"`);
				}
			};
			return {
				async searchKeys(opts, inlineRows, shaping) {
					refuse(shaping.shape);
					return {
						packed: engine.use((g) =>
							g.query_keys(opts.filterTreeJson, optsJson(opts), inlineRows, shaping.shape, shaping.baseUrl),
						),
						storeKey,
						sortKeyVersion: engine.use((g) => g.sort_key_version()),
						shape: shaping.shape,
					};
				},
				async fetchRows(vpids, fields, _storeKey, shaping) {
					refuse(shaping.shape);
					return {
						rowsBytes: engine.use((g) =>
							g.fetch_rows(Uint32Array.from(vpids), JSON.stringify(fields), shaping.shape, shaping.baseUrl),
						),
						shape: shaping.shape,
					};
				},
			};
		});
	}

	for (const { label, opts } of PAGES) {
		test(`gathered across ${GATHER_WIDTH} partitions — ${label}`, async () => {
			const old = await runTwoPhase(clients(), opts, ROWS_GATHER);
			const reference = serializeCards(parseSlots(old.slots), "columnar");
			const keys = columnKeys(opts.fields);
			const page = await runTwoPhase(clients(), opts, columnsGather(keys));
			expect(page.total).toBe(old.total);
			expect(text(assembleColumnar(keys, page.slots))).toBe(reference);

			// Mid-rollout: partition 1 is still on the previous build and refuses "columns".
			const mixed = await runTwoPhase(clients(new Set([1])), opts, columnsGather(keys));
			expect(mixed.total).toBe(old.total);
			expect(text(assembleColumnar(keys, mixed.slots))).toBe(reference);
		});
	}
});
