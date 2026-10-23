// An `otag:` search gathered from only the partitions the build's oracle-tags blob names
// (oracle-tag-partitions.ts, card-restriction.ts) against the full gather — on the REAL corpus.
//
// Two claims, checked through the committed wasm (one instance per partition), the production
// parser (with the build's own tag alias map), extras gate, blob (encoded from the build's own
// `oracle-tags.tsv`) and `runTwoPhase`:
//
//   1. THE BLOB IS EXACT. For every slug it lists and a set of slugs no card carries, a partition
//      answers `otag:<slug>` with any row — extras, variations and foreign printings included — if
//      and only if the blob places the slug there. (Only "answers ⇒ placed" is needed for the pages
//      to be right; "placed ⇒ answers" is what makes the restriction as narrow as it can be.)
//   2. THE PAGE IS THE FULL GATHER'S. For bare tags (every slug the blob lists, once), alias
//      spellings, `oracletag:`/`function:`, `=`/`>=`/`>`, unknown tags, ORs and ANDs of tags, tags
//      ANDed with other filters and with `!"name"` lists, negated tags and tags ORed with an
//      unrestricted term (which must not narrow) — under unique cards/prints/art, several orders
//      and directions, page 2, include_extras, include_variations and include_multilingual, in both
//      the card-object (`/cards/search`) and row (`/search`) shapes — the restricted gather gives the
//      full gather's total, rows, bytes, widening and build, and an empty restriction is a query that
//      matches nothing.
//
// It also reports how many partitions a bare `otag:` asks, over every slug of the build.
//
// Opt-in, because it loads every partition of the corpus:
//
//   SYLVAN_REAL_DIFFERENTIAL=1 STORE_BUILD_DIR=<store build> bun test tests/engine/otag-real.test.ts

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { oracleTagsFromBuildDir } from "../../scripts/oracle-tags-build";
import { routingFilterFromBuildDir } from "../../scripts/routing-filter-build";
import { cardRestrictionOf } from "../../src/engine/card-restriction";
import {
	type GatherShaping,
	joinJsonArray,
	type PartitionClient,
	ROWS_GATHER,
	runTwoPhase,
} from "../../src/engine/gather";
import { OracleTagPartitions } from "../../src/engine/oracle-tag-partitions";
import { gatherPartitionOf } from "../../src/engine/partition";
import { nameKey, RoutingFilter } from "../../src/engine/routing-filter";
import { parseTagAliasTables } from "../../src/engine/tag-aliases";
import type { EngineSearchOptions, StoreManifest } from "../../src/engine/types";
import { canonicalStringify, type FilterValue, parseScryfallQueryWithDirectives } from "../../src/parser";
import { applyExtrasGate } from "../../src/routes/extras-gate";
import { newEngine, type TestEngine } from "./wasm-engine";

const STORE_DIR = process.env.STORE_BUILD_DIR ?? join(import.meta.dir, "../../store-build");
const MANIFEST = join(STORE_DIR, "manifest.json");

const opted = process.env.SYLVAN_REAL_DIFFERENTIAL === "1";
const manifest: StoreManifest | null =
	opted && existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as StoreManifest) : null;
const readable =
	manifest !== null &&
	existsSync(join(STORE_DIR, "oracle-tags.tsv")) &&
	manifest.format_version === newEngine().use((g) => g.store_version());

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
const UNIQUE: Record<string, string> = { cards: "card", prints: "printing", art: "artwork" };

describe.skipIf(!readable)(`otag: searches vs the full gather, on ${STORE_DIR}`, () => {
	// describe.skipIf still evaluates this body, so a missing manifest must not throw here.
	const m = (manifest ?? { partition_count: 0, partitions: [] }) as StoreManifest;
	const n = m.partition_count as number;
	const parts = (m.partitions ?? []) as { store_key: string }[];
	let engines: TestEngine[] = [];
	let clients: PartitionClient[] = [];
	let tags: OracleTagPartitions;
	const decoder = new TextDecoder();

	const setUp = () => {
		if (engines.length > 0) return;
		engines = parts.map((p) => {
			const engine = newEngine();
			engine.use((g) => g.init_store(new Uint8Array(readFileSync(join(STORE_DIR, p.store_key)))));
			return engine;
		});
		clients = engines.map((engine, p) => {
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
		const built = oracleTagsFromBuildDir(STORE_DIR, m);
		if (built === null) throw new Error("the build has no oracle-tags.tsv");
		tags = OracleTagPartitions.parse(built.raw, {
			partitionCount: n,
			partitionHash: m.partition_hash as string,
		});
	};

	test(
		"the blob is exact: a partition answers `otag:x` in any mode iff the blob places x there",
		async () => {
			setUp();
			const random = rng(0x07a6);
			const slugs = tags.slugs();
			const unknown = [
				"synergy-zzqx",
				"zzqx-not-a-tag",
				...Array.from({ length: 30 }, () => {
					const s = slugs[Math.floor(random() * slugs.length)] as string;
					return `${s}-zq`;
				}),
			].filter((s) => tags.partitionsOf(s).length === 0);
			// The wire leaf the parser writes, with the slug substituted verbatim (the slug IS the
			// value the engine binds; going through the parser's slugify again could change it).
			const template = canonicalStringify(parseScryfallQueryWithDirectives("otag:zzqxplaceholder").tree as FilterValue);
			if (!template.includes('"zzqxplaceholder"')) throw new Error(`unexpected otag wire: ${template}`);
			// Every mode at once: extras and variations (no gate), the foreign annex, every printing.
			const wide = (slug: string): EngineSearchOptions => ({
				filterTreeJson: template.replace('"zzqxplaceholder"', JSON.stringify(slug)),
				unique: "printing",
				prefer: "default",
				orderby: "name",
				direction: "auto",
				limit: 1,
				offset: 0,
				fields: [],
				includeMultilingual: true,
			});
			let placedEmpty = 0;
			let missing = 0;
			const shown: string[] = [];
			for (const slug of [...slugs, ...unknown]) {
				const opts = wide(slug);
				const placed = new Set(tags.partitionsOf(slug));
				for (let p = 0; p < n; p++) {
					const page = await runTwoPhase([clients[p] as PartitionClient], opts, CARDS);
					const answers = page.total > 0;
					if (answers && !placed.has(p)) {
						missing++;
						if (shown.length < 10) shown.push(`${slug}: partition ${p} answers ${page.total} rows, not placed`);
					}
					if (!answers && placed.has(p)) {
						placedEmpty++;
						if (shown.length < 10) shown.push(`${slug}: partition ${p} placed but answers nothing`);
					}
				}
			}
			const counts = slugs.map((s) => tags.partitionsOf(s).length);
			const hist = Array.from({ length: n + 1 }, (_, k) => counts.filter((c) => c === k).length);
			console.log(
				`${slugs.length} slugs and ${unknown.length} unknown ones, against each of ${n} partitions: ` +
					`${missing} answer where the blob does not place them, ${placedEmpty} placed but answer nothing\n` +
					`a bare otag: asks ${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)} of ${n} ` +
					`partitions on average over every slug; by partitions asked: ${hist.map((c, k) => `${k}:${c}`).join(" ")}`,
			);
			for (const line of shown) console.log(`  ${line}`);
			expect(missing).toBe(0);
			expect(placedEmpty).toBe(0);
		},
		{ timeout: 3_600_000 },
	);

	test(
		"the same page from the tag's partitions, and nothing when it names none",
		async () => {
			setUp();
			const random = rng(0x07a7);
			const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)] as T;
			const aliases = parseTagAliasTables(readFileSync(join(STORE_DIR, "tag-aliases.json"), "utf8"));
			const slugs = tags.slugs();
			const narrow = slugs.filter((s) => tags.partitionsOf(s).length <= 3);
			const aliasSpellings = [...aliases.oracle.keys()];

			// Names for the list combinations, placed by the build's own routing filter, as the router does.
			const routing = routingFilterFromBuildDir(STORE_DIR, m);
			if (routing === null) throw new Error("the build has no routing-keys.tsv");
			const parsedFilter = RoutingFilter.parse(routing.bytes, {
				builtAt: String(m.built_at),
				partitionCount: n,
				partitionHash: m.partition_hash as string,
			});
			if ("reason" in parsedFilter) throw new Error(parsedFilter.reason);
			const filter = parsedFilter.filter;
			const hintOf = (collated: string) => {
				if (!filter.hasNameKeys) return null;
				const key = nameKey(collated);
				return key === null ? null : filter.lookupNamePlacement(key);
			};
			const served: string[] = [];
			for (const engine of engines) {
				const records = decoder.decode(engine.use((g) => g.store_name_records_tsv()));
				for (const line of records.split("\n")) {
					const f = line.split("\t");
					if (f.length !== 6) continue;
					const classes = Number.parseInt((f[0] as string).slice(0, 2), 16);
					if ((classes & 8) !== 0 && (classes & 4) !== 0 && !(f[2] as string).includes('"'))
						served.push(f[2] as string);
				}
			}

			const quoted = (s: string) => `"${s}"`;
			const tag = (s = pick(slugs)) => `otag:${quoted(s)}`;
			const unknownTag = () => `otag:${quoted(`${pick(slugs)}-zq`)}`;
			const FILTERS = [
				"t:creature",
				"c:g",
				"id<=wubrg t:instant",
				"-t:land",
				"o:/draw a card/",
				"cmc<=2",
				"atag:dragon",
			];
			const PARAMS: Record<string, string>[] = [
				{ unique: "cards", order: "name" },
				{ unique: "cards", order: "name" },
				{ unique: "cards", order: "edhrec" },
				{ unique: "cards", order: "cmc", dir: "desc" },
				{ unique: "art", order: "released" },
				{ unique: "prints", order: "released", dir: "desc" },
				{ unique: "prints", page: "2", order: "name" },
				{ unique: "cards", page: "2", order: "name" },
				{ unique: "cards", include_extras: "true" },
				{ unique: "prints", include_variations: "true", order: "set" },
				{ unique: "prints", include_multilingual: "true" },
				{ unique: "cards", include_extras: "true", include_multilingual: "true", order: "usd" },
				{ unique: "art", include_extras: "true", include_variations: "true", order: "artist", dir: "asc" },
			];

			// kind: what the query is, for the report and for what it must do.
			const queries: { q: string; kind: string; params: Record<string, string>; rows: boolean }[] = [];
			// Every slug once, bare, mostly the production lane's shape (unique=cards order=name).
			for (const slug of slugs) {
				queries.push({
					q: tag(slug),
					kind: "bare",
					params: random() < 0.6 ? { unique: "cards", order: "name" } : pick(PARAMS),
					rows: random() < 0.15,
				});
			}
			const more: [string, () => string][] = [
				["unknown", unknownTag],
				["alias", () => `otag:${pick(aliasSpellings)}`],
				["spelling", () => `${pick(["oracletag", "function", "oracle_tags", "otag"])}:${pick(narrow)}`],
				["operator", () => `otag${pick(["=", ">=", ">"])}${pick(narrow)}`],
				["or", () => `(${tag(pick(narrow))} or ${tag(pick(narrow))}${random() < 0.3 ? ` or ${unknownTag()}` : ""})`],
				["and", () => `${tag()} ${tag()}`],
				["filtered", () => `${pick(FILTERS)} ${tag(random() < 0.5 ? pick(narrow) : pick(slugs))}`],
				[
					"names",
					() =>
						`${tag(pick(narrow))} (${Array.from({ length: 1 + Math.floor(random() * 5) }, () => `!"${pick(served)}"`).join(" or ")})`,
				],
				["or-names", () => `(${tag(pick(narrow))} or !"${pick(served)}")`],
				["negated", () => `-${tag()} ${pick(FILTERS)}`],
				["unrestricted-or", () => `(${tag(pick(narrow))} or t:elf)`],
				["less", () => `otag${pick(["<", "<=", "!="])}${pick(narrow)} ${pick(FILTERS)}`],
			];
			for (let i = 0; i < 2400; i++) {
				const [kind, make] = more[i % more.length] as [string, () => string];
				queries.push({ q: make(), kind, params: pick(PARAMS), rows: random() < 0.2 });
			}

			let compared = 0;
			let differing = 0;
			let emptyRestriction = 0;
			let nonEmptyPages = 0;
			let asked = 0;
			let fullAsk = 0;
			const byKind = new Map<string, { n: number; restricted: number; asked: number }>();
			const shown: string[] = [];
			for (const { q, kind, params, rows } of queries) {
				let parsedQuery: ReturnType<typeof parseScryfallQueryWithDirectives>;
				try {
					parsedQuery = parseScryfallQueryWithDirectives(q, aliases);
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
					{ includeExtras: params.include_extras === "true", includeVariations: params.include_variations === "true" },
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
				const restriction = cardRestrictionOf(opts.filterTreeJson, n, hintOf, opts.includeMultilingual === true, (s) =>
					tags.partitionsOf(s),
				);
				const narrowed = restriction !== null && restriction.partitions.length < n;
				const stat = byKind.get(kind) ?? { n: 0, restricted: 0, asked: 0 };
				stat.n++;
				// What the router asks: the restriction's partitions, ONE for an empty one, else all.
				const askedHere = narrowed ? Math.max(1, restriction.partitions.length) : n;
				stat.asked += askedHere;
				if (narrowed) stat.restricted++;
				byKind.set(kind, stat);
				// The shapes that must never narrow.
				if ((kind === "negated" || kind === "unrestricted-or" || kind === "less") && narrowed) {
					differing++;
					shown.push(`${JSON.stringify(q)} narrowed to ${JSON.stringify(restriction?.partitions)}`);
					continue;
				}
				if (!narrowed) continue;
				const shaping = rows ? ROWS : CARDS;
				let full: Awaited<ReturnType<typeof runTwoPhase>>;
				try {
					full = await runTwoPhase(clients, opts, shaping);
				} catch (err) {
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
				asked += askedHere;
				fullAsk += n;
				if (full.total > 0) nonEmptyPages++;
				let same: boolean;
				if (restriction.partitions.length === 0) {
					emptyRestriction++;
					// The router asks one partition as a gather of one: its page must be the full gather's.
					const owner = gatherPartitionOf(opts.filterTreeJson, n);
					const one = await runTwoPhase([clients[owner] as PartitionClient], opts, shaping);
					same =
						full.total === 0 &&
						full.slots.length === 0 &&
						one.total === 0 &&
						one.slots.length === 0 &&
						one.widened === full.widened &&
						one.builtAt === full.builtAt;
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
			const kinds = [...byKind]
				.map(
					([kind, s]) =>
						`  ${kind}: ${s.n} queries, ${s.restricted} narrowed, ${(s.asked / s.n).toFixed(2)} of ${n} partitions asked on average`,
				)
				.join("\n");
			console.log(
				`${queries.length} otag: queries: ${compared} restricted and compared, ${differing} differ; ` +
					`${emptyRestriction} restricted to no partition (a 404 from one); ${nonEmptyPages} with rows; ` +
					`the compared ones ask ${asked} partitions where the full gather asks ${fullAsk}\n${kinds}`,
			);
			for (const line of shown) console.log(`  DIFFERS ${line}`);
			expect(differing).toBe(0);
			expect(compared).toBeGreaterThan(4000);
			expect(nonEmptyPages).toBeGreaterThan(3000);
			expect(emptyRestriction).toBeGreaterThan(150);
		},
		{ timeout: 3_600_000 },
	);
});
