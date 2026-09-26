// Backlog y1: a search restricted to a LIST of cards, gathered from only the partitions the router
// finds them in, against the full gather — on the REAL corpus.
//
// The claim: for every query whose filter tree carries a card restriction (card-restriction.ts),
// running the two-phase gather over just the restriction's partitions gives the ten-partition
// gather's page — total, rows, bytes, widening, build — and an empty restriction is a query that
// matches nothing. Checked through the committed wasm (one instance per partition), the production
// parser, extras gate, routing filter (built from the build's own routing-keys.tsv) and
// `runTwoPhase`, over generated lists shaped like mtg-seeker's lanes:
//
//   - 1, 2, 3, 5, 8, 20, 25 and 75 members; exact names of served cards, split-card faces, flavor
//     names, extras-only and foreign-only cards, names no card has; oracle ids, real and not; mixed;
//   - alone and ANDed with the filters the lanes send (`t:`, `otag:`, `atag:`, `o:/…/`, `id<=`), and
//     nested (two lists ANDed, a list inside an OR with an unrestricted term, which must not narrow);
//   - unique cards/prints/art, several orders and directions, page 2, include_extras,
//     include_multilingual, and both the card-object (`/cards/search`) and row (`/search`) shapes.
//
// It also reports the partitions mtg-seeker-shaped lists (1-25 served names ANDed with a lane's
// filter) ask, by list size — before this, always N.
//
// Opt-in, because it loads every partition of the corpus:
//
//   SYLVAN_REAL_DIFFERENTIAL=1 STORE_BUILD_DIR=<store build> bun test tests/engine/card-list-real.test.ts

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { routingFilterFromBuildDir } from "../../scripts/routing-filter-build";
import { cardRestrictionOf } from "../../src/engine/card-restriction";
import {
	type GatherShaping,
	joinJsonArray,
	type PartitionClient,
	ROWS_GATHER,
	runTwoPhase,
} from "../../src/engine/gather";
import { nameKey, RoutingFilter } from "../../src/engine/routing-filter";
import type { EngineSearchOptions, StoreManifest } from "../../src/engine/types";
import { canonicalStringify, type FilterValue, parseScryfallQueryWithDirectives } from "../../src/parser";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { newEngine, type TestEngine } from "./wasm-engine";

const STORE_DIR = process.env.STORE_BUILD_DIR ?? join(import.meta.dir, "../../store-build");
const MANIFEST = join(STORE_DIR, "manifest.json");

const opted = process.env.SYLVAN_REAL_DIFFERENTIAL === "1";
const manifest: StoreManifest | null =
	opted && existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as StoreManifest) : null;
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
const ROWS: GatherShaping = ROWS_GATHER;

const uuidOf = (b: Uint8Array) => {
	const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

describe.skipIf(!readable)(`card-list searches vs the full gather, on ${STORE_DIR}`, () => {
	test(
		"the same page from the restriction's partitions, and nothing when it names none",
		async () => {
			const m = manifest as StoreManifest;
			const n = m.partition_count as number;
			const parts = m.partitions as { store_key: string }[];
			const engines: TestEngine[] = parts.map((p) => {
				const engine = newEngine();
				engine.use((g) => g.init_store(new Uint8Array(readFileSync(join(STORE_DIR, p.store_key)))));
				return engine;
			});
			const built = routingFilterFromBuildDir(STORE_DIR, m);
			if (built === null) throw new Error("the build has no routing-keys.tsv");
			const parsed = RoutingFilter.parse(built.bytes, {
				builtAt: String(m.built_at),
				partitionCount: n,
				partitionHash: m.partition_hash as string,
			});
			if ("reason" in parsed) throw new Error(parsed.reason);
			const filter = parsed.filter;
			// PartitionedEngine.nameHintOf, exactly.
			const hintOf = (collated: string) => {
				if (!filter.hasNameKeys) return null;
				const key = nameKey(collated);
				return key === null ? null : filter.lookupName(key);
			};

			// ── the corpus's names, by kind ──
			const decoder = new TextDecoder();
			const served: string[] = [];
			const faces: string[] = [];
			const extrasOnly: string[] = [];
			const foreignOnly: string[] = [];
			const flavors: string[] = [];
			for (const engine of engines) {
				const records = decoder.decode(engine.use((g) => g.store_name_records_tsv()));
				for (const line of records.split("\n")) {
					const f = line.split("\t");
					if (f.length !== 6) continue;
					const classes = Number.parseInt((f[0] as string).slice(0, 2), 16);
					const printed = f[2] as string;
					if (printed.includes('"')) continue;
					if ((classes & 8) === 0) foreignOnly.push(printed);
					else if ((classes & 4) === 0) extrasOnly.push(printed);
					else {
						served.push(printed);
						const halves = printed.split(" // ");
						if (halves.length === 2) faces.push(...halves);
					}
					for (const entry of (f[5] as string).split(",")) {
						const key = entry.split(":")[0];
						if (key) flavors.push(key);
					}
				}
			}
			const pairs = readFileSync(join(STORE_DIR, "oracle-pairs.bin"));
			const oracleIds: string[] = [];
			for (let at = 0; at + 32 <= pairs.byteLength; at += 32 * 97) {
				oracleIds.push(uuidOf(pairs.subarray(at + 16, at + 32)));
			}

			const clients: PartitionClient[] = engines.map((engine, p) => {
				const storeKey = (parts[p] as { store_key: string }).store_key;
				return {
					async searchKeys(opts, inlineRows, shaping) {
						return {
							packed: engine.use((g) =>
								g.query_keys(opts.filterTreeJson, optsJson(opts), inlineRows, shaping.shape, shaping.baseUrl ?? ""),
							),
							storeKey,
							sortKeyVersion: engine.use((g) => g.sort_key_version()),
							shape: shaping.shape,
						};
					},
					async fetchRows(vpids, fields, _storeKey, shaping) {
						return {
							rowsBytes: engine.use((g) =>
								g.fetch_rows(Uint32Array.from(vpids), JSON.stringify(fields), shaping.shape, shaping.baseUrl ?? ""),
							),
							shape: shaping.shape,
						};
					},
				};
			});

			// ── the queries ──
			const random = rng(0x0171);
			const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)] as T;
			const typo = (s: string) => {
				const i = 1 + Math.floor(random() * Math.max(1, s.length - 2));
				return `${s.slice(0, i)}q${s.slice(i)}`;
			};
			const member = (kind: number): string => {
				if (kind < 0.62) return `!"${pick(served)}"`;
				if (kind < 0.68) return `!"${pick(faces)}"`;
				if (kind < 0.72) return `!"${pick(flavors)}"`;
				if (kind < 0.76) return `!"${pick(extrasOnly)}"`;
				if (kind < 0.78 && foreignOnly.length > 0) return `!"${pick(foreignOnly)}"`;
				// A name no card has reads a garbage byte, which ~80% of the time is "ask everyone" and
				// makes its whole OR unrestricted — rare here so the rest of the lists still narrow.
				if (kind < 0.84) return random() < 0.2 ? `!"${typo(pick(served))}"` : `!"${pick(served)}"`;
				if (kind < 0.96) return `oracleid:${pick(oracleIds)}`;
				return `oracleid:${uuidOf(Uint8Array.from({ length: 16 }, () => Math.floor(random() * 256)))}`;
			};
			const list = (size: number, oracleShare: number) =>
				`(${Array.from({ length: size }, () => member(random() < oracleShare ? 0.84 + random() * 0.16 : random() * 0.84)).join(" or ")})`;
			const FILTERS = [
				"",
				"t:creature",
				"otag:ramp",
				"(otag:removal or o:/destroy target/)",
				"id<=wubrg t:instant",
				"atag:dragon",
				"(atag:castle or atag:forest)",
				"c:r",
				"-t:land",
			];
			const PARAMS: Record<string, string>[] = [
				{ unique: "cards", order: "edhrec" },
				{ unique: "cards", order: "name" },
				{ unique: "art", order: "released" },
				{ unique: "prints", order: "released", dir: "desc" },
				{ unique: "prints", page: "2", order: "name" },
				{ unique: "cards", include_extras: "true" },
				{ unique: "prints", include_multilingual: "true" },
				{ unique: "cards", include_extras: "true", include_multilingual: "true", order: "usd" },
			];
			const SIZES = [1, 2, 3, 5, 8, 20, 25, 25, 25, 75];
			// `lane` marks mtg-seeker's shape — N served names ANDed with a lane's filter, default
			// options — whose partitions asked are reported by list size.
			const queries: { q: string; params: Record<string, string>; rows: boolean; lane?: number }[] = [];
			const LANE_SIZES = [1, 3, 8, 20, 25];
			for (let i = 0; i < 1000; i++) {
				const size = LANE_SIZES[i % LANE_SIZES.length] as number;
				const names = Array.from({ length: size }, () => `!"${pick(served)}"`).join(" or ");
				const params = pick([
					{ unique: "cards", order: "edhrec" },
					{ unique: "art", order: "released" },
				]);
				queries.push({ q: `${pick(FILTERS)} (${names})`.trim(), params, rows: false, lane: size });
			}
			for (let i = 0; i < 3000; i++) {
				const size = pick(SIZES);
				const oracleShare = random() < 0.25 ? 1 : random() < 0.3 ? 0.3 : 0;
				let q = `${pick(FILTERS)} ${list(size, oracleShare)}`.trim();
				const nest = random();
				if (nest < 0.08)
					q = `${q} ${list(1 + Math.floor(random() * 5), oracleShare)}`; // two lists ANDed
				else if (nest < 0.12)
					q = `(${q} or t:elf)`; // must not narrow
				else if (nest < 0.15) q = `-${list(2, 0)} t:goblin`; // NOT: must not narrow
				queries.push({ q, params: pick(PARAMS), rows: random() < 0.2 });
			}

			const UNIQUE: Record<string, string> = { cards: "card", prints: "printing", art: "artwork" };
			let compared = 0;
			let differing = 0;
			let unrestricted = 0;
			let emptyRestriction = 0;
			let nonEmptyPages = 0;
			const shown: string[] = [];
			// Partitions asked, by list size, for the default-lane (gated, unique=cards) queries.
			const touched = new Map<number, number[]>();
			for (const { q, params, rows, lane } of queries) {
				let parsedQuery: ReturnType<typeof parseScryfallQueryWithDirectives>;
				try {
					parsedQuery = parseScryfallQueryWithDirectives(q);
				} catch {
					continue;
				}
				const gate = await applyExtrasGate(
					{ setsWithExtras: async () => [] },
					parsedQuery.tree,
					{
						loweredRegexTerms: parsedQuery.loweredRegexTerms,
						expandedDerivedTerms: parsedQuery.expandedDerivedTerms,
					},
					{ includeExtras: params.include_extras === "true" },
				);
				const page = Number(params.page ?? "1");
				const opts: EngineSearchOptions = {
					filterTreeJson: canonicalStringify(gate.tree as FilterValue),
					unique: UNIQUE[params.unique ?? "cards"] ?? "card",
					prefer: "default",
					orderby: params.order ?? "name",
					direction: params.dir ?? "auto",
					limit: 175,
					offset: (page - 1) * 175,
					fields: rows ? ["name", "set", "collector_number", "oracle_id"] : [],
					includeMultilingual: params.include_multilingual === "true",
				};
				const restriction = cardRestrictionOf(opts.filterTreeJson, n, hintOf, opts.includeMultilingual === true);
				if (lane !== undefined) {
					const list = touched.get(lane) ?? [];
					list.push(restriction === null ? n : restriction.partitions.length);
					touched.set(lane, list);
				}
				if (restriction === null || restriction.partitions.length >= n) {
					unrestricted++;
					continue;
				}
				const shaping = rows ? ROWS : CARDS;
				let full: Awaited<ReturnType<typeof runTwoPhase>>;
				try {
					full = await runTwoPhase(clients, opts, shaping);
				} catch (err) {
					// A query the engine refuses (e.g. an unknown tag) is refused by the subset too.
					await expect(
						runTwoPhase(
							restriction.partitions.map((p) => clients[p] as PartitionClient),
							opts,
							shaping,
						),
					).rejects.toBeDefined();
					void err;
					continue;
				}
				compared++;
				if (full.total > 0) nonEmptyPages++;
				let same: boolean;
				if (restriction.partitions.length === 0) {
					emptyRestriction++;
					same = full.total === 0 && full.slots.length === 0;
				} else {
					const routed = await runTwoPhase(
						restriction.partitions.map((p) => clients[p] as PartitionClient),
						opts,
						shaping,
					);
					same =
						routed.total === full.total &&
						routed.widened === full.widened &&
						routed.builtAt === full.builtAt &&
						decoder.decode(joinJsonArray(routed.slots)) === decoder.decode(joinJsonArray(full.slots));
				}
				if (!same) {
					differing++;
					if (shown.length < 10) {
						shown.push(
							`${JSON.stringify(q)} ${JSON.stringify(params)}: restricted to ${JSON.stringify(restriction.partitions)}, full total ${full.total}`,
						);
					}
				}
			}
			const distribution = [...touched]
				.sort((a, b) => a[0] - b[0])
				.map(([size, ks]) => {
					const hist = new Map<number, number>();
					for (const k of ks) hist.set(k, (hist.get(k) ?? 0) + 1);
					const mean = ks.reduce((s, k) => s + k, 0) / ks.length;
					const spread = [...hist]
						.sort((a, b) => a[0] - b[0])
						.map(([k, c]) => `${k}:${c}`)
						.join(" ");
					return `  ${size} members: ${ks.length} lists, ${mean.toFixed(2)} of ${n} partitions on average (${spread})`;
				})
				.join("\n");
			console.log(
				`${queries.length} list queries: ${compared} restricted and compared, ${differing} differ; ` +
					`${unrestricted} carried no restriction narrower than ${n}; ${emptyRestriction} restricted to no partition; ` +
					`${nonEmptyPages} with rows\n` +
					`partitions asked by mtg-seeker-shaped lists (served names ANDed with a lane filter), by members:\n${distribution}`,
			);
			for (const line of shown) console.log(`  DIFFERS ${line}`);
			expect(differing).toBe(0);
			expect(compared).toBeGreaterThan(2000);
			expect(nonEmptyPages).toBeGreaterThan(1000);
		},
		{ timeout: 3_600_000 },
	);
});
