// Every partition of a local store build, each in its own instance of the committed wasm, with the
// build's names index and printed-names blob in one more — and a partition client over them that
// answers what a SearchEngine Durable Object answers, so the real PartitionedEngine and the real
// routes can be driven against the real corpus (routed-miss-real.test.ts).
//
// Opt-in, like the other real-corpus suites: SYLVAN_REAL_DIFFERENTIAL=1, with STORE_BUILD_DIR
// pointing at a store build (default: this checkout's store-build/) whose manifest.json names one
// archive per partition.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { encodeCardNames, ledByPartition } from "../../src/engine/card-names";
import { decodeNamedFuzzyPacket } from "../../src/engine/named-fuzzy";
import { encodePrintedNames } from "../../src/engine/printed-names";
import type { RemoteEngine } from "../../src/engine/remote-engine";
import {
	FUZZY_SIMILARITY_FLOOR,
	FUZZY_SIMILARITY_LEAD,
	FUZZY_WEAK_BELOW,
	type NamedFuzzyBundle,
	type NamedFuzzyOwnBundle,
	type NamedFuzzyPlan,
	type StoreManifest,
} from "../../src/engine/types";
import { CARD_OBJECT_FIELDS, type EngineRow, toScryfallCard } from "../../src/routes/scryfall-compat/objects";
import { newEngine, type TestEngine } from "./wasm-engine";

const STORE_DIR = process.env.STORE_BUILD_DIR ?? join(import.meta.dir, "../../store-build");
const MANIFEST = join(STORE_DIR, "manifest.json");

interface BuildManifest {
	format_version: number;
	built_at: string;
	partitions: { store_key: string }[];
}

/** The wasm exports these suites call beyond wasm-engine.ts's hand-typed glue. */
interface RealGlue {
	store_printed_records_tsv(): Uint8Array;
	load_printed_names(gz: Uint8Array): number;
	printed_names_partitions(wordsJson: string): string;
	named_fuzzy_bundle(
		folded: string,
		setCode: string,
		floor: number,
		lead: number,
		weakBelow: number,
		k: number,
		wordsJson: string,
		limit: number,
		fieldsJson: string,
	): Uint8Array;
}

const opted = process.env.SYLVAN_REAL_DIFFERENTIAL === "1";
const build: BuildManifest | null =
	opted && existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as BuildManifest) : null;

/** Whether a store build the committed wasm can read is there to test against. */
export const realStoreReadable = build !== null && build.format_version === newEngine().use((g) => g.store_version());
export const realStoreDir = STORE_DIR;

export interface RealStore {
	n: number;
	builtAt: string;
	engines: TestEngine[];
	/** The names index and the printed-names blob of the whole build. */
	index: TestEngine;
	/** A router's manifest for it; `withNames` false is a build that publishes no names index. */
	manifest(withNames: boolean): StoreManifest;
}

/** store.ts's FUZZY_CANDIDATE_CLASSES. */
const CANDIDATE_CLASSES = 8;
const FIELDS = JSON.stringify(CARD_OBJECT_FIELDS);

let loaded: RealStore | null = null;

export function loadRealStore(): RealStore {
	if (loaded) return loaded;
	const m = build as BuildManifest;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const engines = m.partitions.map((p) => {
		const engine = newEngine();
		const bytes = new Uint8Array(readFileSync(join(STORE_DIR, p.store_key)));
		engine.use((g) => g.init_store(bytes));
		return engine;
	});
	const names: Uint8Array[] = [];
	const printed: Uint8Array[] = [];
	for (const [k, engine] of engines.entries()) {
		names.push(encoder.encode(ledByPartition(k, decoder.decode(engine.use((g) => g.store_name_records_tsv())))));
		const tsv = engine.use((g) => (g as unknown as RealGlue).store_printed_records_tsv());
		printed.push(encoder.encode(ledByPartition(k, decoder.decode(tsv))));
	}
	const index = newEngine();
	index.use((g) => g.load_names(gzipSync(encodeCardNames(names))));
	index.use((g) => (g as unknown as RealGlue).load_printed_names(gzipSync(encodePrintedNames(printed))));
	const n = engines.length;
	const builtAt = String(m.built_at);
	loaded = {
		n,
		builtAt,
		engines,
		index,
		manifest: (withNames) =>
			({
				store_key: "card-store-v1-real.store",
				built_at: builtAt,
				card_count: 1,
				printing_count: 1,
				upstream_commit: "real",
				format_version: m.format_version,
				store_bytes: n,
				chunk_count: n,
				partition_count: n,
				partition_hash: "fnv1a64/oracle_id/v1",
				partitions: Array.from({ length: n }, (_, k) => ({
					store_key: `card-store-v1-real-p${k}.store`,
					store_bytes: 1,
					chunk_count: 1,
					card_count: 1,
					printing_count: 1,
				})),
				...(withNames ? { names_key: "store:card-names-v1-real.store:0", names_bytes: 10 } : {}),
			}) as StoreManifest,
	};
	return loaded;
}

/** store.ts `namesFuzzyPlan`, against the index instance: the names index's plan, and the printed
 * names' word on what it left `everywhere`. */
export function realFuzzyPlan(store: RealStore, folded: string, words: string[]): NamedFuzzyPlan {
	const wordsJson = JSON.stringify(words);
	const plan = JSON.parse(
		store.index.use((g) =>
			g.names_fuzzy_plan(folded, wordsJson, FUZZY_SIMILARITY_FLOOR, FUZZY_SIMILARITY_LEAD, FUZZY_WEAK_BELOW),
		),
	) as Omit<NamedFuzzyPlan, "builtAt">;
	if (!plan.everywhere) return { ...plan, builtAt: store.builtAt };
	const printed = JSON.parse(
		store.index.use((g) => (g as unknown as RealGlue).printed_names_partitions(wordsJson)),
	) as { partitions: number[] } | null;
	if (printed === null) return { ...plan, builtAt: store.builtAt, printed: "absent" };
	const partitions = [...new Set([...plan.partitions, ...printed.partitions])].sort((a, b) => a - b);
	return {
		...plan,
		partitions,
		everywhere: false,
		stage: partitions.length === 0 ? "miss" : plan.stage,
		builtAt: store.builtAt,
		printed: printed.partitions.length > 0 ? "hit" : "miss",
	};
}

/** store.ts `WasmEngine.scryfallNamedFuzzyBundle`, against partition `p`'s instance. */
export function realFuzzyBundle(
	store: RealStore,
	p: number,
	folded: string,
	setCode: string,
	words: string[],
	limit: number,
	baseUrl: string,
): NamedFuzzyBundle {
	const packet = decodeNamedFuzzyPacket<EngineRow>(
		(store.engines[p] as TestEngine).use((g) =>
			(g as unknown as RealGlue).named_fuzzy_bundle(
				folded,
				setCode,
				FUZZY_SIMILARITY_FLOOR,
				FUZZY_SIMILARITY_LEAD,
				FUZZY_WEAK_BELOW,
				CANDIDATE_CLASSES,
				JSON.stringify(words),
				limit,
				FIELDS,
			),
		),
	);
	const card = (row: EngineRow | null) => (row === null ? null : toScryfallCard(row, baseUrl));
	return {
		exact: { rank: packet.exact.rank, present: packet.exact.present, card: card(packet.exact.card) },
		fuzzy: packet.fuzzy === null ? null : { status: packet.fuzzy.status, card: card(packet.fuzzy.card) },
		candidates: packet.candidates,
		contained: packet.contained === null ? null : packet.contained.map((row) => toScryfallCard(row, baseUrl)),
	};
}

/** Which build's object a partition client stands for. */
export interface RealPartitionOptions {
	/** An object on the build before x48: no `scryfallNamedFuzzyRouted`. */
	beforeX48?: boolean;
}

/**
 * Partition `p` as the router sees it — the SearchEngine RPCs the name routes call, answered as the
 * Durable Object answers them (search-engine-do.ts), every call recorded in `calls`.
 */
export function realPartition(
	store: RealStore,
	p: number,
	calls: string[],
	options: RealPartitionOptions = {},
): RemoteEngine {
	const client = {
		scryfallNamedFuzzyBundle: async (
			folded: string,
			setCode: string,
			words: string[],
			limit: number,
			baseUrl: string,
		) => {
			calls.push(`bundle:${p}`);
			return realFuzzyBundle(store, p, folded, setCode, words, limit, baseUrl);
		},
		scryfallNamedFuzzyPlan: async (folded: string, words: string[], own?: NamedFuzzyOwnBundle) => {
			const plan = realFuzzyPlan(store, folded, words);
			const wanted = own !== undefined && (plan.everywhere || plan.partitions.includes(own.partition));
			calls.push(wanted ? `plan+bundle:${p}` : `plan:${p}`);
			if (!wanted) return plan;
			return { ...plan, bundle: realFuzzyBundle(store, p, folded, "", words, own.limit, own.baseUrl) };
		},
		...(options.beforeX48
			? {}
			: {
					scryfallNamedFuzzyRouted: async (folded: string, words: string[], limit: number, baseUrl: string) => {
						const bundle = realFuzzyBundle(store, p, folded, "", words, limit, baseUrl);
						if (bundle.exact.rank !== null) {
							calls.push(`routed:${p}`);
							return { bundle, plan: null };
						}
						calls.push(`routed+plan:${p}`);
						return { bundle, plan: realFuzzyPlan(store, folded, words) };
					},
				}),
	};
	return client as unknown as RemoteEngine;
}
