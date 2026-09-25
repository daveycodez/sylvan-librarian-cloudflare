// The partition-scoped restore (backlog x4), through the REAL wasm import module — the committed
// artifact the ImportCoordinator instantiates.
//
// WHAT CHANGED. Every partition's instance used to restore the WHOLE TagData — every oracle id's
// tags, every illustration's art tags — plus the whole sealed corpus tables (every name's cubecobra
// score, every illustration group's count). That was a corpus-wide term in a heap whose every other
// term is bounded by the partition size, and at 2x the corpus it carried agg, finalize and build
// past the 128MB isolate. Now a partition's fresh instance restores the labels, the slug table and
// the oracle tags its own oracle ids hash to (`tags_restore_pull_partition`), and at the seal pulls
// the art tags and corpus-table entries for exactly the illustrations and names its drafts carried
// (`partition_tables_restore_pull`). The snapshots are streamed out in chunks (`tags_export`,
// `corpus_export`) and pulled back row by row, never as one buffer.
//
// WHAT IS PINNED. Every partition's SPILL BLOBS — the store build's whole input — and finalized rows
// are byte-identical to the whole-restore path's, over a corpus built to hit every lookup the
// filters touch: oracle tags, art tags on a double-faced card's BACK face, an illustration group
// counted across partitions, the percent-rank, the pins. And each partition keeps strictly less
// than the whole, or the filters are not filtering.

import { describe, expect, test } from "bun:test";
import { splitDraftEmit } from "../../src/import-spill";

const wasmBytes = await Bun.file(
	new URL("../../engine/wasm-import/pkg/sylvan_wasm_import.wasm", import.meta.url),
).arrayBuffer();
const WasmModule = (WebAssembly as unknown as { Module: new (b: ArrayBuffer) => WebAssembly.Module }).Module;
const module_ = new WasmModule(wasmBytes);

const enc = new TextEncoder();
const dec = new TextDecoder();

const EMIT = { LOG: 1, DRAFT: 2, STATS: 3, SPILL: 4, ROW: 6, TAGDATA: 7, CORPUS: 12 } as const;

interface Exports {
	memory: WebAssembly.Memory;
	alloc(len: number): number;
	reset(): void;
	transform_lines(ptr: number, len: number): bigint;
	tags_begin(): void;
	tags_add_lines(ptr: number, len: number): bigint;
	tags_finish(kind: number): bigint;
	labels_add_lines(ptr: number, len: number): bigint;
	tags_export(): bigint;
	tags_restore(ptr: number, len: number): bigint;
	tags_restore_pull(): bigint;
	tags_restore_pull_partition(p: number, n: number): bigint;
	partition_tables_restore_pull(which: number): bigint;
	corpus_export(): bigint;
	corpus_restore_pull(source: number): bigint;
	scores_add_drafts(ptr: number, len: number, n: number): bigint;
	scores_finish(): bigint;
	agg_drafts(ptr: number, len: number): bigint;
	agg_finish(): bigint;
	finalize_begin(): bigint;
	finalize_drafts(ptr: number, len: number): bigint;
	finalize_end(): bigint;
}

/** One instance = one fresh linear memory: a partition's instance, or an eviction boundary. */
class Host {
	readonly ex: Exports;
	drafts: Uint8Array[] = [];
	rows: Record<string, unknown>[] = [];
	spill: Uint8Array[] = [];
	tagChunks: Uint8Array[] = [];
	corpusChunks: Uint8Array[] = [];
	/** What pull_row serves: row `i` of the snapshot a pull restore is reading. */
	pulling: Uint8Array[] = [];

	constructor() {
		const view = (ptr: number, len: number) => new Uint8Array(this.ex.memory.buffer, ptr, len);
		const imports: Record<string, Record<string, unknown>> = {
			env: {
				emit: (kind: number, ptr: number, len: number) => {
					const bytes = view(ptr, len).slice();
					if (kind === EMIT.DRAFT) this.drafts.push(bytes);
					else if (kind === EMIT.ROW) this.rows.push(JSON.parse(dec.decode(bytes)) as Record<string, unknown>);
					else if (kind === EMIT.SPILL) this.spill.push(bytes);
					else if (kind === EMIT.TAGDATA) this.tagChunks.push(bytes);
					else if (kind === EMIT.CORPUS) this.corpusChunks.push(bytes);
					else if (kind === EMIT.LOG) console.error(`[wasm-import] ${dec.decode(bytes)}`);
				},
				pull_row: (index: number, dest: number, cap: number) => {
					const row = this.pulling[index];
					if (!row || row.length > cap) return -1;
					view(dest, row.length).set(row);
					return row.length;
				},
			},
		};
		for (const imp of WebAssembly.Module.imports(module_)) {
			imports[imp.module] ??= {};
			const mod = imports[imp.module] as Record<string, unknown>;
			if (mod[imp.name] !== undefined) continue;
			if (imp.kind === "function")
				mod[imp.name] = () => {
					throw new Error(`stubbed import called: ${imp.module}.${imp.name}`);
				};
			else if (imp.kind === "memory") mod[imp.name] = new WebAssembly.Memory({ initial: 32 });
			else if (imp.kind === "table") mod[imp.name] = new WebAssembly.Table({ element: "anyfunc", initial: 128 });
			else mod[imp.name] = 0;
		}
		this.ex = new WebAssembly.Instance(module_, imports as WebAssembly.Imports).exports as unknown as Exports;
		this.ex.reset();
	}

	send(bytes: Uint8Array, call: (ptr: number, len: number) => bigint, label: string): bigint {
		const ptr = this.ex.alloc(bytes.length);
		new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
		const rc = call(ptr, bytes.length);
		if (rc < 0n) throw new Error(`${label} failed`);
		return rc;
	}

	/** Run a pull export over `rows`; returns its code WITHOUT throwing, for the refusal tests. */
	pull(rows: Uint8Array[], call: () => bigint): bigint {
		this.pulling = rows;
		try {
			return call();
		} finally {
			this.pulling = [];
		}
	}

	tagsExport(): Uint8Array[] {
		this.tagChunks = [];
		if (this.ex.tags_export() < 0n) throw new Error("tags_export failed");
		return this.tagChunks;
	}

	corpusExport(): Uint8Array[] {
		this.corpusChunks = [];
		if (this.ex.corpus_export() < 0n) throw new Error("corpus_export failed");
		return this.corpusChunks;
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** Re-cut a snapshot into rows of `size` bytes: where the host cuts it must not matter to a restore. */
function recut(parts: Uint8Array[], size: number): Uint8Array[] {
	const all = concat(parts);
	const out: Uint8Array[] = [];
	for (let at = 0; at < all.length; at += size) out.push(all.subarray(at, Math.min(at + size, all.length)));
	return out;
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

type Card = Record<string, unknown> & { id: string; oracle_id: string; name: string };
const fixture = async (name: string) =>
	JSON.parse(await Bun.file(new URL(`../../engine/builder/src/fixtures/${name}.json`, import.meta.url)).text()) as Card;
const bolt = await fixture("lightning_bolt");
const delver = await fixture("delver_of_secrets");
const jace = await fixture("jace_the_mind_sculptor");
const elves = await fixture("llanowar_elves");

const uuid = (prefix: string, i: number) => `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;

/**
 * Forty cards over twenty oracle ids and four base cards: two printings per oracle id, so a card's
 * printings share a partition while its illustration groups (name + illustration) are counted from
 * both; double-faced printings whose BACK face carries art tags; labels on half the cards.
 */
function corpus(): { cards: Card[]; oracleTags: string[]; artTags: string[]; labels: string[] } {
	const bases = [bolt, delver, jace, elves];
	const cards: Card[] = [];
	const oracleTagLines: string[] = [];
	const art = new Map<string, string[]>();
	for (let o = 0; o < 20; o++) {
		const base = bases[o % bases.length] as Card;
		const oracleId = uuid("bbbbbbbb", o);
		const name = `${base.name as string} ${o}`;
		for (let k = 0; k < 2; k++) {
			const i = o * 2 + k;
			const card: Card = {
				...structuredClone(base),
				id: uuid("aaaaaaaa", i),
				oracle_id: oracleId,
				name,
				edhrec_rank: o % 7 === 3 ? undefined : (o + 1) * 13,
			};
			// Both printings of a card share one illustration, so its (illustration, name) group counts 2.
			const front = uuid("cccccccc", o);
			if (Array.isArray(card.card_faces) && (card.card_faces as unknown[]).length === 2) {
				const faces = card.card_faces as Record<string, unknown>[];
				(faces[0] as Record<string, unknown>).illustration_id = front;
				(faces[1] as Record<string, unknown>).illustration_id = uuid("dddddddd", o);
				// Back-face art only: reachable through illustration_ids(), not the row's own column.
				art.set(uuid("dddddddd", o), [`back-${o % 3}`]);
			} else {
				card.illustration_id = front;
			}
			if (o % 2 === 0) art.set(front, [`front-${o % 4}`]);
			cards.push(card);
		}
		if (o % 3 !== 1) oracleTagLines.push(oracleId);
	}
	const tagDump = (slugToIds: Map<string, string[]>, key: string) =>
		[...slugToIds.entries()].map(([slug, ids], i) =>
			JSON.stringify({
				object: "tag",
				id: uuid(key === "oracle_id" ? "eeeeeeee" : "ffffffff", i),
				slug,
				parent_ids: [],
				aliases: [],
				taggings: ids.map((id) => ({ [key]: id })),
			}),
		);
	const oracleSlugs = new Map<string, string[]>();
	oracleTagLines.forEach((id, i) => {
		const slug = `oracle-${i % 5}`;
		oracleSlugs.set(slug, [...(oracleSlugs.get(slug) ?? []), id]);
	});
	const artSlugs = new Map<string, string[]>();
	for (const [ill, slugs] of art) for (const slug of slugs) artSlugs.set(slug, [...(artSlugs.get(slug) ?? []), ill]);
	return {
		cards,
		oracleTags: tagDump(oracleSlugs, "oracle_id"),
		artTags: tagDump(artSlugs, "illustration_id"),
		labels: cards.filter((_, i) => i % 4 === 0).map((c) => JSON.stringify({ id: c.id })),
	};
}

/** Everything the loop starts from: the staged drafts, the tags snapshot, the sealed corpus snapshot. */
function stage() {
	const { cards, oracleTags, artTags, labels } = corpus();
	const transform = new Host();
	transform.send(
		enc.encode(cards.map((c) => JSON.stringify(c)).join("\n")),
		(p, l) => transform.ex.transform_lines(p, l),
		"transform",
	);
	const staged = transform.drafts.map((d) => splitDraftEmit(d));
	expect(staged.length).toBe(cards.length);

	const tags = new Host();
	for (const [lines, kind] of [
		[oracleTags, 1],
		[artTags, 2],
	] as const) {
		tags.ex.tags_begin();
		tags.send(enc.encode(lines.join("\n")), (p, l) => tags.ex.tags_add_lines(p, l), "tags_add_lines");
		expect(tags.ex.tags_finish(kind)).toBeGreaterThan(0n);
	}
	tags.send(enc.encode(labels.join("\n")), (p, l) => tags.ex.labels_add_lines(p, l), "labels");
	const tagRows = tags.tagsExport();

	// The scores phase, sliced the way the coordinator slices it: each slice a fresh instance that
	// pulls the previous slice's corpus snapshot back, adds its drafts, and exports again.
	const drafts = staged.map((s) => s.draft);
	let corpusRows: Uint8Array[] = [];
	for (let at = 0; at < drafts.length; at += 15) {
		const slice = new Host();
		if (corpusRows.length > 0)
			expect(slice.pull(recut(corpusRows, 97), () => slice.ex.corpus_restore_pull(0))).toBeGreaterThan(0n);
		slice.send(lengthPrefixed(drafts.slice(at, at + 15)), (p, l) => slice.ex.scores_add_drafts(p, l, 0), "scores");
		if (at + 15 >= drafts.length) slice.ex.scores_finish();
		corpusRows = slice.corpusExport();
	}

	// What the phase used to leave instead: the whole TagData with the sealed tables inside it.
	const merged = new Host();
	expect(merged.pull(recut(tagRows, 101), () => merged.ex.tags_restore_pull())).toBeGreaterThan(0n);
	expect(merged.pull(corpusRows, () => merged.ex.corpus_restore_pull(0))).toBeGreaterThan(0n);
	const legacyRows = merged.tagsExport();
	return { staged, tagRows, corpusRows, legacyRows };
}

function finalize(host: Host, batch: Uint8Array) {
	if (host.ex.finalize_begin() < 0n) throw new Error("finalize_begin failed");
	host.send(batch, (p, l) => host.ex.finalize_drafts(p, l), "finalize_drafts");
	host.ex.finalize_end();
	return { spill: host.spill, rows: host.rows };
}

/** The old path: the whole TagData, sealed tables inside, restored into the partition's instance. */
function wholeRestore(legacyRows: Uint8Array[], mine: Uint8Array[]) {
	const host = new Host();
	host.send(concat(legacyRows), (p, l) => host.ex.tags_restore(p, l), "tags_restore");
	host.send(lengthPrefixed(mine), (p, l) => host.ex.agg_drafts(p, l), "agg");
	host.ex.agg_finish();
	return finalize(host, lengthPrefixed(mine));
}

/** The new path: the partition's share at the start, the rest at the seal. */
function scopedRestore(
	s: ReturnType<typeof stage>,
	mine: Uint8Array[],
	p: number,
	n: number,
	corpus: "corpus" | "legacy" = "corpus",
) {
	const host = new Host();
	const oracle = host.pull(recut(s.tagRows, 89), () => host.ex.tags_restore_pull_partition(p, n));
	expect(oracle).toBeGreaterThanOrEqual(0n);
	host.send(lengthPrefixed(mine), (q, l) => host.ex.agg_drafts(q, l), "agg");
	host.ex.agg_finish();
	const art = host.pull(s.tagRows, () => host.ex.partition_tables_restore_pull(1));
	const names =
		corpus === "corpus"
			? host.pull(s.corpusRows, () => host.ex.partition_tables_restore_pull(2))
			: host.pull(s.legacyRows, () => host.ex.partition_tables_restore_pull(3));
	expect(art).toBeGreaterThanOrEqual(0n);
	expect(names).toBeGreaterThan(0n);
	return { ...finalize(host, lengthPrefixed(mine)), kept: { oracle, art, names } };
}

describe("the partition-scoped restore", () => {
	test("every partition's spill and rows are byte-identical to the whole restore's, and each keeps a share", () => {
		const s = stage();
		for (const n of [2, 3, 5]) {
			const kept = { oracle: 0n, art: 0n, names: 0n };
			for (let p = 0; p < n; p++) {
				const mine = s.staged.filter((d) => d.partHash % BigInt(n) === BigInt(p)).map((d) => d.draft);
				if (mine.length === 0) continue;
				const whole = wholeRestore(s.legacyRows, mine);
				const scoped = scopedRestore(s, mine, p, n);
				expect(scoped.spill.length).toBe(whole.spill.length);
				expect(scoped.spill.map((b) => Buffer.from(b).toString("hex"))).toEqual(
					whole.spill.map((b) => Buffer.from(b).toString("hex")),
				);
				expect(scoped.rows).toEqual(whole.rows);
				// The same through a TagData snapshot's own corpus field (a run staged across the deploy).
				expect(scopedRestore(s, mine, p, n, "legacy").rows).toEqual(whole.rows);
				kept.oracle += scoped.kept.oracle;
				kept.art += scoped.kept.art;
				kept.names += scoped.kept.names;
			}
			// Summed over the partitions, each table is kept ONCE — nothing is kept twice, so no
			// partition held the whole table (every partition is non-empty at these n).
			expect(kept.oracle).toBe(13n); // the 13 tagged oracle ids
			expect(kept.names).toBe(20n); // the 20 names
			expect(kept.art).toBeGreaterThan(0n);
		}
		// And the rows carry what the filters could have dropped: scores, and back-face art tags.
		const rows = wholeRestore(
			s.legacyRows,
			s.staged.map((d) => d.draft),
		).rows;
		expect(rows.every((r) => typeof r.cubecobra_score === "number")).toBe(true);
		expect(rows.some((r) => JSON.stringify(r.card_art_tags ?? "").includes("back-"))).toBe(true);
		expect(rows.some((r) => JSON.stringify(r.card_oracle_tags ?? "").includes("oracle-"))).toBe(true);
	});

	test("a streamed snapshot restores the same wherever the host cuts its rows", () => {
		// Compared as VALUES: the maps serialize in HashMap order, which follows the instance's hash
		// seeds, so two instances' bytes may differ for identical tables. The label SET likewise;
		// every other list (the slug table above all) keeps its order.
		const value = (rows: Uint8Array[]) =>
			JSON.parse(dec.decode(concat(rows)), (k, v) =>
				k === "labels" && Array.isArray(v) ? [...v].sort() : v,
			) as unknown;
		const s = stage();
		const whole = value(s.legacyRows);
		expect((whole as { corpus: { scores: Record<string, number> } }).corpus.scores).toBeDefined();
		for (const size of [1, 7, 4096, 1 << 20]) {
			const host = new Host();
			expect(host.pull(recut(s.legacyRows, size), () => host.ex.tags_restore_pull())).toBeGreaterThan(0n);
			expect(value(host.tagsExport())).toEqual(whole);
		}
		// The corpus tables round-trip alone, and out of a TagData snapshot's own field.
		const a = new Host();
		a.pull(s.corpusRows, () => a.ex.corpus_restore_pull(0));
		const b = new Host();
		b.pull(recut(s.legacyRows, 13), () => b.ex.corpus_restore_pull(1));
		expect(value(a.corpusExport())).toEqual((whole as { corpus: unknown }).corpus);
		expect(value(b.corpusExport())).toEqual((whole as { corpus: unknown }).corpus);
	});

	test("the restores refuse what would build a silently wrong store", () => {
		const s = stage();
		const mine = s.staged.map((d) => d.draft);
		// Before the seal there are no keys to keep to.
		const early = new Host();
		early.pull(s.tagRows, () => early.ex.tags_restore_pull_partition(0, 2));
		expect(early.pull(s.tagRows, () => early.ex.partition_tables_restore_pull(1))).toBe(-1n);
		// An UNSEALED corpus (a scores phase that never finished) would score every row null.
		const unsealed = new Host();
		const slice = new Host();
		slice.send(lengthPrefixed(mine), (p, l) => slice.ex.scores_add_drafts(p, l, 0), "scores");
		const pending = slice.corpusExport();
		unsealed.pull(s.tagRows, () => unsealed.ex.tags_restore_pull_partition(0, 1));
		unsealed.send(lengthPrefixed(mine), (p, l) => unsealed.ex.agg_drafts(p, l), "agg");
		unsealed.ex.agg_finish();
		expect(unsealed.pull(pending, () => unsealed.ex.partition_tables_restore_pull(2))).toBe(-1n);
		// A truncated snapshot is a parse failure, never a restored prefix.
		const cut = new Host();
		expect(cut.pull(recut(s.legacyRows, 64).slice(0, 3), () => cut.ex.tags_restore_pull())).toBe(-1n);
		// A partition outside the count.
		const outside = new Host();
		expect(outside.pull(s.tagRows, () => outside.ex.tags_restore_pull_partition(2, 2))).toBe(-1n);
	});
});
