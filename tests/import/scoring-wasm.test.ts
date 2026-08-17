// The two scoring inputs the partition loop cannot take at face value, through the REAL wasm
// import module — the same committed artifact the ImportCoordinator instantiates:
// the corpus-global cubecobra table, and the pin slots PIN_BONUS propagates across.
//
// WHAT IS BEING PINNED. `cubecobra_score` is a PERCENT_RANK over the distinct card names of the
// whole corpus, and the nightly build runs `agg(p)` over ONE partition's drafts. Sealed there, the
// table ranks each card against 1/Nth of the names, so the same corpus scores differently
// depending on how many partitions it happened to be cut into — and the archive stores the value
// and SORTS on it (`orderby=cubecobra`), so the deploy-built store and the nightly-built store
// would answer that ordering differently. So: the table is sealed ONCE, globally, in its own phase
// before the loop opens, and reaches every partition through the TagData snapshot
// (tags_export → tags_restore), the same relay the canonical id set rides.
//
// The third arm below is the one with teeth: it seals a table per partition — the shape this fix
// replaced — and asserts the scores DIFFER, so a regression cannot pass by accident.

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

const EMIT = { LOG: 1, DRAFT: 2, STATS: 3, SPILL: 4, ROW: 6, TAGDATA: 7 } as const;

interface Host {
	drafts: Uint8Array[];
	rows: Record<string, unknown>[];
	transformLines(lines: string): bigint;
	labelsAddLines(lines: string): bigint;
	scoresAddDrafts(batch: Uint8Array): bigint;
	scoresFinish(): bigint;
	tagsExport(): Uint8Array;
	tagsRestore(bytes: Uint8Array): bigint;
	aggDrafts(batch: Uint8Array): bigint;
	aggFinish(): bigint;
	finalizeBegin(): void;
	finalizeDrafts(batch: Uint8Array): bigint;
	finalizeEnd(): bigint;
}

/** One fresh instance = one fresh linear memory, the eviction/partition boundary. */
function instantiate(): Host {
	const drafts: Uint8Array[] = [];
	const rows: Record<string, unknown>[] = [];
	const tagData: Uint8Array[] = [];
	let memory: WebAssembly.Memory | undefined;
	const view = (ptr: number, len: number) => new Uint8Array((memory as WebAssembly.Memory).buffer, ptr, len);
	const imports: Record<string, Record<string, unknown>> = {
		env: {
			emit(kind: number, ptr: number, len: number) {
				const bytes = view(ptr, len).slice();
				if (kind === EMIT.DRAFT) drafts.push(bytes);
				else if (kind === EMIT.ROW) rows.push(JSON.parse(dec.decode(bytes)) as Record<string, unknown>);
				else if (kind === EMIT.TAGDATA) tagData.push(bytes);
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
		transform_lines(ptr: number, len: number): bigint;
		labels_add_lines(ptr: number, len: number): bigint;
		scores_add_drafts(ptr: number, len: number): bigint;
		scores_finish(): bigint;
		tags_export(): bigint;
		tags_restore(ptr: number, len: number): bigint;
		agg_drafts(ptr: number, len: number): bigint;
		agg_finish(): bigint;
		finalize_begin(): bigint;
		finalize_drafts(ptr: number, len: number): bigint;
		finalize_end(): bigint;
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
		rows,
		transformLines: (lines) => send(enc.encode(lines), (p, l) => ex.transform_lines(p, l), "transform_lines"),
		labelsAddLines: (lines) => send(enc.encode(lines), (p, l) => ex.labels_add_lines(p, l), "labels_add_lines"),
		scoresAddDrafts: (batch) => send(batch, (p, l) => ex.scores_add_drafts(p, l), "scores_add_drafts"),
		scoresFinish: () => {
			const rc = ex.scores_finish();
			if (rc < 0n) throw new Error("scores_finish failed");
			return rc;
		},
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
		aggDrafts: (batch) => send(batch, (p, l) => ex.agg_drafts(p, l), "agg_drafts"),
		aggFinish: () => {
			const rc = ex.agg_finish();
			if (rc < 0n) throw new Error("agg_finish failed");
			return rc;
		},
		finalizeBegin: () => {
			if (ex.finalize_begin() < 0n) throw new Error("finalize_begin failed");
		},
		finalizeDrafts: (batch) => send(batch, (p, l) => ex.finalize_drafts(p, l), "finalize_drafts"),
		finalizeEnd: () => {
			const rc = ex.finalize_end();
			if (rc < 0n) throw new Error("finalize_end failed");
			return rc;
		},
	};
}

type Card = Record<string, unknown> & { id: string; oracle_id: string; name: string };
const bolt = JSON.parse(
	await Bun.file(new URL("../../engine/builder/src/fixtures/lightning_bolt.json", import.meta.url)).text(),
) as Card;

/**
 * A corpus of one-printing cards with distinct names and spread edhrec ranks — enough that the
 * percent-rank has something to rank and the partition cut splits the name set.
 */
const CORPUS: Card[] = Array.from({ length: 12 }, (_, i) => ({
	...bolt,
	id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
	oracle_id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
	name: `Testcard Number ${i}`,
	// Ranks 10, 20, ... and one card with none (the trailing NULL peer group).
	edhrec_rank: i === 11 ? undefined : (i + 1) * 10,
}));

const line = (card: unknown) => JSON.stringify(card);

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

/** The corpus as bare draft JSON blobs, in emission order — what the coordinator stages. */
function stagedDrafts(cards: Card[] = CORPUS): { draft: Uint8Array; partHash: bigint }[] {
	const host = instantiate();
	host.transformLines(cards.map(line).join("\n"));
	return host.drafts.map((d) => splitDraftEmit(d));
}

/** The two corpus-wide-derived values per scryfall_id, from one arm's finalized rows.
 * prefer_score is here because illustration_count is only visible through it. */
function scoresOf(rows: Record<string, unknown>[]): Map<string, string> {
	return new Map(rows.map((r) => [r.scryfall_id as string, `${r.cubecobra_score}/${r.prefer_score}`]));
}

/** cubecobra_score alone, where a test needs the number rather than the pair. */
function cubecobraOf(rows: Record<string, unknown>[]): Map<string, number> {
	return new Map(rows.map((r) => [r.scryfall_id as string, r.cubecobra_score as number]));
}

/** agg + finalize one partition's drafts against a TagData snapshot, as the loop does. */
function buildPartition(snapshot: Uint8Array, drafts: Uint8Array[]): Record<string, unknown>[] {
	const host = instantiate();
	host.tagsRestore(snapshot);
	host.aggDrafts(lengthPrefixed(drafts));
	host.aggFinish();
	host.finalizeBegin();
	host.finalizeDrafts(lengthPrefixed(drafts));
	host.finalizeEnd();
	return host.rows;
}

describe("the corpus-wide tables through the real wasm module", () => {
	test("a partitioned build scores every card exactly as an unpartitioned one", () => {
		const staged = stagedDrafts();
		expect(staged.length).toBe(CORPUS.length);
		const all = staged.map((s) => s.draft);

		// The scores phase: one pass over EVERY partition's drafts, sealed, snapshotted.
		const scorer = instantiate();
		scorer.scoresAddDrafts(lengthPrefixed(all));
		expect(scorer.scoresFinish()).toBe(BigInt(CORPUS.length));
		const snapshot = scorer.tagsExport();

		const wholeRows = buildPartition(snapshot, all);
		const whole = scoresOf(wholeRows);
		expect(whole.size).toBe(CORPUS.length);
		// A real percent-rank, not a degenerate constant: 0 for the best rank, 25 for the NULL.
		const ranks = [...cubecobraOf(wholeRows).values()];
		expect(ranks.some((v) => v === 0)).toBe(true);
		expect(Math.max(...ranks)).toBe(25);

		for (const n of [2, 3, 5]) {
			const rows: Record<string, unknown>[] = [];
			for (let p = 0; p < n; p++) {
				const mine = staged.filter((s) => s.partHash % BigInt(n) === BigInt(p)).map((s) => s.draft);
				if (mine.length > 0) rows.push(...buildPartition(snapshot, mine));
			}
			expect(scoresOf(rows)).toEqual(whole);
		}
	});

	test("a table sealed per partition would NOT match — the regression this replaced", () => {
		const staged = stagedDrafts();
		const n = 3;
		const local: Record<string, unknown>[] = [];
		for (let p = 0; p < n; p++) {
			const mine = staged.filter((s) => s.partHash % BigInt(n) === BigInt(p)).map((s) => s.draft);
			if (mine.length === 0) continue;
			// The old shape: each partition ranks its own names against its own name set.
			const scorer = instantiate();
			scorer.scoresAddDrafts(lengthPrefixed(mine));
			scorer.scoresFinish();
			local.push(...buildPartition(scorer.tagsExport(), mine));
		}
		const scorer = instantiate();
		scorer.scoresAddDrafts(lengthPrefixed(staged.map((s) => s.draft)));
		scorer.scoresFinish();
		const global = scoresOf(
			buildPartition(
				scorer.tagsExport(),
				staged.map((s) => s.draft),
			),
		);
		expect(scoresOf(local)).not.toEqual(global);
	});

	test("an illustration group counts whole even when its rows are in different partitions", () => {
		// (illustration_id, card_name) is the one aggregate key with no oracle_id in it, so it is
		// the one group the partition hash does not co-locate: two DIFFERENT cards sharing a name
		// and an illustration land in different partitions and, counted there, would each see half
		// the group. It has never happened on a real corpus — this is the shape that proves the
		// count no longer depends on it not happening.
		const ILL = "eeeeeeee-0000-4000-8000-000000000001";
		const twins: Card[] = [0, 1].map((i) => ({
			...(CORPUS[0] as Card),
			id: `ffffffff-0000-4000-8000-00000000000${i}`,
			// Different oracle_ids — a different partition each, by construction below.
			oracle_id: `ffffffff-0000-4000-8000-10000000000${i}`,
			name: "Shared Art Card",
			illustration_id: ILL,
			collector_number: `${100 + i}`,
		}));
		const staged = stagedDrafts(twins);
		const n = 2;
		const parts = staged.map((s) => Number(s.partHash % BigInt(n)));
		expect(new Set(parts).size).toBe(n); // the twins really do straddle

		const scorer = instantiate();
		scorer.scoresAddDrafts(lengthPrefixed(staged.map((s) => s.draft)));
		scorer.scoresFinish();
		const snapshot = scorer.tagsExport();

		const whole = scoresOf(
			buildPartition(
				snapshot,
				staged.map((s) => s.draft),
			),
		);
		const split = new Map<string, string>();
		for (let p = 0; p < n; p++) {
			const mine = staged.filter((_, i) => parts[i] === p).map((s) => s.draft);
			for (const [id, v] of scoresOf(buildPartition(snapshot, mine))) split.set(id, v);
		}
		expect(split).toEqual(whole);
	});

	test("finalize refuses to run against unsealed tables", () => {
		// A snapshot from before the scores phase existed restores UNSEALED; finalizing against it
		// would emit a null cubecobra column and a zero illustration count on every row, and build
		// a store that looks fine.
		const host = instantiate();
		host.tagsRestore(enc.encode('{"labels":[],"slugs":[],"oracle":{},"art":{},"oracle_aliases":{},"art_aliases":{}}'));
		host.aggDrafts(lengthPrefixed(stagedDrafts().map((s) => s.draft)));
		host.aggFinish();
		expect(() => host.finalizeBegin()).toThrow();
	});

	test("the hash co-locates every printing of a card, so partition-local aggregates stay whole", () => {
		// The property the per-partition illustration counts and pin slots rest on: they are keyed
		// inside one card, and one card is one partition.
		for (const card of CORPUS) {
			expect(fnv1a64OracleId(card.oracle_id) % 8n).toBe(fnv1a64OracleId(card.oracle_id) % 8n);
		}
		const staged = stagedDrafts([
			{ ...CORPUS[0], id: "cccccccc-0000-4000-8000-000000000001" } as Card,
			{ ...CORPUS[0], id: "cccccccc-0000-4000-8000-000000000002", lang: "ja" } as Card,
		]);
		expect(staged[0]?.partHash).toBe(staged[1]?.partHash as bigint);
	});
});

describe("the representative pin through the real wasm module", () => {
	const EN = "dddddddd-0000-4000-8000-000000000063";
	const JA_SAME_SLOT = "dddddddd-0000-4000-8000-000000000163";
	const JA_OTHER_SLOT = "dddddddd-0000-4000-8000-000000000345";
	const printings: Card[] = [
		{ ...(CORPUS[0] as Card), id: EN, set: "khm", collector_number: "63", lang: "en" },
		{ ...(CORPUS[0] as Card), id: JA_SAME_SLOT, set: "khm", collector_number: "63", lang: "ja" },
		{ ...(CORPUS[0] as Card), id: JA_OTHER_SLOT, set: "khm", collector_number: "345", lang: "ja" },
	];

	/** Finalized rows for these printings, with `labelled` named by Scryfall's oracle_cards dump. */
	function preferScores(labelled: string | null): Map<string, number> {
		const drafts = stagedDrafts(printings).map((s) => s.draft);
		const scorer = instantiate();
		if (labelled) scorer.labelsAddLines(line({ id: labelled }));
		scorer.scoresAddDrafts(lengthPrefixed(drafts));
		scorer.scoresFinish();
		const rows = buildPartition(scorer.tagsExport(), drafts);
		return new Map(rows.map((r) => [r.scryfall_id as string, r.prefer_score as number]));
	}

	test("the pin reaches the labelled printing's slot in every language, and no further", () => {
		// The label names one scryfall_id and it is always the ENGLISH printing, so pinning it
		// alone leaves the Japanese rows to raw prefer_score — which picked the wrong printing on
		// 14 of 175 `e:khm lang:ja` cards. Scryfall's within-language representative is the row at
		// the same (set, collector_number) as its English one.
		const bare = preferScores(null);
		const pinned = preferScores(EN);
		const PIN = 1000;
		expect(pinned.get(EN)).toBeCloseTo((bare.get(EN) as number) + PIN, 3);
		expect(pinned.get(JA_SAME_SLOT)).toBeCloseTo((bare.get(JA_SAME_SLOT) as number) + PIN, 3);
		// Exactly once per qualifying row, so raw prefer_score still orders within the slot.
		expect(pinned.get(JA_OTHER_SLOT)).toBe(bare.get(JA_OTHER_SLOT) as number);
		expect(pinned.get(JA_SAME_SLOT) as number).toBeGreaterThan((pinned.get(JA_OTHER_SLOT) as number) + 900);
		expect(pinned.get(EN) as number).toBeGreaterThan(pinned.get(JA_SAME_SLOT) as number);
	});
});
