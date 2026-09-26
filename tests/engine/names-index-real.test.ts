// The names index (backlog n15) against the full gather, on the REAL corpus.
//
// The claim: for a NAME-ONLY `/cards/search`, gathering from only the partitions the names index
// names gives the page the ten-partition gather gives — total, rows and bytes — and an index that
// names none is exactly a search that matches nothing (its 404). This checks it on every partition
// of a local store build, through the committed wasm (ten instances, one per partition, and the
// index loaded into an eleventh), the production encoder, parser, extras gate and `runTwoPhase`:
//
//   - the shapes the Worker logs (`cards/search: shape=…`, 2026-09-25): a bare word, AND of 2–10
//     words (mtg-seeker's word-by-word probes of a name — whole names, subsets, typos, and words
//     from two different cards, which is where the day's ~800 404s come from), `name:/…/` (which
//     turns include_extras on), OR of words, a quoted literal;
//   - with the options the route sends them with (unique=cards, order=edhrec or name, page 1),
//     and the rest of the space: unique=prints and art, page 2, include_extras,
//     include_variations and include_multilingual.
//
// Opt-in, because it loads every partition of the corpus:
//
//   SYLVAN_REAL_DIFFERENTIAL=1 bun test tests/engine/names-index-real.test.ts
//
// with STORE_BUILD_DIR pointing at a store build (default: this checkout's store-build/).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { encodeCardNames, ledByPartition } from "../../src/engine/card-names";
import { type GatherShaping, joinJsonArray, type PartitionClient, runTwoPhase } from "../../src/engine/gather";
import type { EngineSearchOptions } from "../../src/engine/types";
import { canonicalStringify, type FilterValue, parseScryfallQueryWithDirectives } from "../../src/parser";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { queryShape } from "../../src/routes/scryfall-compat/query-shape";
import { newEngine, type TestEngine } from "./wasm-engine";

const STORE_DIR = process.env.STORE_BUILD_DIR ?? join(import.meta.dir, "../../store-build");
const MANIFEST = join(STORE_DIR, "manifest.json");

interface Manifest {
	format_version: number;
	built_at: string;
	partitions: { store_key: string }[];
}

const opted = process.env.SYLVAN_REAL_DIFFERENTIAL === "1";
const manifest: Manifest | null =
	opted && existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest) : null;
const readable = manifest !== null && manifest.format_version === newEngine().use((g) => g.store_version());

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

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

const CARDS: GatherShaping = {
	shape: "cards",
	baseUrl: "https://api.scryfall.com",
	reshape: () => {
		throw new Error("no partition here is on a previous build");
	},
};

describe.skipIf(!readable)(`the names index vs the ten-partition gather, on ${STORE_DIR}`, () => {
	test(
		"the same page from the partitions it names, and a 404 exactly when it names none",
		async () => {
			const m = manifest as Manifest;
			const engines: TestEngine[] = m.partitions.map((p) => {
				const engine = newEngine();
				const bytes = new Uint8Array(readFileSync(join(STORE_DIR, p.store_key)));
				engine.use((g) => g.init_store(bytes));
				return engine;
			});
			const decoder = new TextDecoder();
			const lines: Uint8Array[] = [];
			const printed: string[] = [];
			for (const [k, engine] of engines.entries()) {
				const records = decoder.decode(engine.use((g) => g.store_name_records_tsv()));
				lines.push(new TextEncoder().encode(ledByPartition(k, records)));
				for (const line of records.split("\n")) {
					const f = line.split("\t");
					if (f.length === 6 && (Number.parseInt((f[0] as string).slice(0, 2), 16) & 4) !== 0)
						printed.push(f[2] as string);
				}
			}
			const raw = encodeCardNames(lines);
			const gz = gzipSync(raw, { level: 9 });
			// The index object: its own instance, holding a partition's store as a real one does.
			const index = newEngine();
			index.use((g) =>
				g.init_store(
					new Uint8Array(readFileSync(join(STORE_DIR, (m.partitions[0] as { store_key: string }).store_key))),
				),
			);
			const baseMemory = index.use((g) => g.names_heap_bytes());
			index.use((g) => g.load_names(gz));
			const heap = index.use((g) => g.names_heap_bytes()) - baseMemory;

			const clients: PartitionClient[] = engines.map((engine, p) => {
				const storeKey = (m.partitions[p] as { store_key: string }).store_key;
				return {
					async searchKeys(opts, inlineRows, shaping) {
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
						return {
							rowsBytes: engine.use((g) =>
								g.fetch_rows(Uint32Array.from(vpids), JSON.stringify(fields), shaping.shape, shaping.baseUrl),
							),
							shape: shaping.shape,
						};
					},
				};
			});

			// ── the queries ──
			const random = rng(0x0015);
			const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)] as T;
			const words = (name: string) =>
				name
					.toLowerCase()
					.split(/[^\p{L}\p{N}']+/u)
					.filter((w) => w.length > 0);
			const typo = (w: string) => {
				if (w.length < 4) return `${w}q`;
				const i = 1 + Math.floor(random() * (w.length - 2));
				return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
			};
			const queries: { q: string; params: Record<string, string> }[] = [];
			const seek = { unique: "cards", order: "edhrec" };
			for (let i = 0; i < 400; i++) {
				const ws = words(pick(printed));
				if (ws.length === 0) continue;
				queries.push({ q: ws.join(" "), params: seek }); // a whole name, word by word
				queries.push({ q: ws.map((w, j) => (j === ws.length - 1 ? typo(w) : w)).join(" "), params: seek });
				queries.push({ q: [...ws, ...words(pick(printed))].join(" "), params: seek }); // two cards' words
				queries.push({ q: pick(ws), params: seek });
			}
			for (let i = 0; i < 120; i++) {
				const w = pick(words(pick(printed)));
				queries.push({ q: `name:/\\b${w.replace(/[^a-z0-9]/g, "")}\\b/`, params: { unique: "cards", order: "name" } });
				queries.push({ q: `name:/^${w.replace(/[^a-z0-9]/g, "").slice(0, 3)}/`, params: seek });
				queries.push({ q: `${w} or ${pick(words(pick(printed)))}`, params: seek });
				queries.push({ q: `name:"${w}"`, params: { order: "name" } });
			}
			const wide = ["bolt", "dragon", "angel", "elf", "goblin", "godzilla", "ego", "lightning bolt", "the"];
			for (const w of wide) {
				const variants: Record<string, string>[] = [
					{ unique: "prints", order: "name" },
					{ unique: "art", order: "released" },
					{ page: "2", order: "name" },
					{ include_extras: "true" },
					{ include_variations: "true" },
					{ include_multilingual: "true", unique: "prints" },
					{ include_extras: "true", include_variations: "true", include_multilingual: "true" },
				];
				for (const params of variants) {
					queries.push({ q: w, params });
				}
			}

			const UNIQUE: Record<string, string> = { cards: "card", prints: "printing", art: "artwork" };
			let compared = 0;
			let notes404 = 0;
			let asked = 0;
			let differing = 0;
			// Per shape: searches, 404s the index answered alone, and the partitions a hit asked.
			const shapes = new Map<string, { n: number; empty: number; hitPartitions: number }>();
			const shown: string[] = [];
			let indexMs = 0;
			for (const { q, params } of queries) {
				let parsed: ReturnType<typeof parseScryfallQueryWithDirectives>;
				try {
					parsed = parseScryfallQueryWithDirectives(q);
				} catch {
					continue;
				}
				const shape = queryShape(parsed.tree);
				const gate = await applyExtrasGate(
					{ setsWithExtras: async () => [] },
					parsed.tree,
					{ loweredRegexTerms: parsed.loweredRegexTerms, expandedDerivedTerms: parsed.expandedDerivedTerms },
					{ includeExtras: params.include_extras === "true", includeVariations: params.include_variations === "true" },
				);
				const page = Number(params.page ?? "1");
				const opts: EngineSearchOptions = {
					filterTreeJson: canonicalStringify(gate.tree as FilterValue),
					unique: UNIQUE[params.unique ?? "cards"] ?? "card",
					prefer: "default",
					orderby: params.order ?? "name",
					direction: "auto",
					limit: 175,
					offset: (page - 1) * 175,
					fields: [],
					includeMultilingual: params.include_multilingual === "true",
				};
				const started = performance.now();
				const answer = JSON.parse(
					index.use((g) => g.names_search_partitions(opts.filterTreeJson, opts.includeMultilingual === true)),
				) as { partitions: number[] } | null;
				indexMs += performance.now() - started;
				if (answer === null) continue; // not a name-only filter: today's path, untouched
				const tally = shapes.get(shape) ?? { n: 0, empty: 0, hitPartitions: 0 };
				tally.n++;
				if (answer.partitions.length === 0) tally.empty++;
				tally.hitPartitions += answer.partitions.length;
				shapes.set(shape, tally);
				const full = await runTwoPhase(clients, opts, CARDS);
				const pruned =
					answer.partitions.length === 0
						? null
						: await runTwoPhase(
								answer.partitions.map((p) => clients[p] as PartitionClient),
								opts,
								CARDS,
							);
				compared++;
				asked += answer.partitions.length;
				if (answer.partitions.length === 0) notes404++;
				const fullBytes = decoder.decode(joinJsonArray(full.slots));
				const same =
					pruned === null
						? full.total === 0 && full.slots.length === 0
						: pruned.total === full.total &&
							pruned.widened === full.widened &&
							pruned.builtAt === full.builtAt &&
							decoder.decode(joinJsonArray(pruned.slots)) === fullBytes;
				if (!same) {
					differing++;
					if (shown.length < 10) {
						shown.push(
							`${JSON.stringify(q)} ${JSON.stringify(params)}: index ${JSON.stringify(answer)}, full total ${full.total}`,
						);
					}
				}
			}
			console.log(
				`names blob: ${raw.byteLength} bytes raw, ${gz.byteLength} gzip (level 9), ${(heap / 1048576).toFixed(2)}MB in wasm\n` +
					`${compared} name-only searches compared (of ${queries.length}): ${differing} differ; ` +
					`${notes404} answered as 404 from the index alone; ${(asked / compared).toFixed(2)} partitions asked on ` +
					`average where the gather asked ${engines.length}; index ${(indexMs / compared).toFixed(2)}ms a search\n` +
					`by shape (searches, 404s in one call, partitions a hit asked on average):\n${[...shapes]
						.sort((a, b) => b[1].n - a[1].n)
						.map(
							([s, t]) =>
								`  ${s}: ${t.n}, ${t.empty}, ${t.n > t.empty ? (t.hitPartitions / (t.n - t.empty)).toFixed(2) : "-"}`,
						)
						.join("\n")}`,
			);
			for (const line of shown) console.log(`  DIFFERS ${line}`);
			expect(differing).toBe(0);
			expect(compared).toBeGreaterThan(1500);
			expect(notes404).toBeGreaterThan(300);
		},
		{ timeout: 1_800_000 },
	);
});
