// What the harness checks about the `is:` lists the nightly refreshes (src/import-is-lists.ts):
// the eight values that are Scryfall's own record and the ninth list kept with them — the rows
// `new:artist` leaves out, which the store holds as a bit on every OTHER row — here answered by a
// Scryfall made from the harness corpus (fake-scryfall.ts) so the lists name rows the store
// really holds.
//
//   1. THE NIGHT THE STORE WAS BUILT ON. The refresh ran across more than one alarm, one list's
//      read FAILED MIDWAY and the run published all the same; the state is in KV, the manifest
//      says which lists the store was tagged from, and the table the run installed is the one the
//      state composes.
//   2. THE STORE CARRIES THE LISTS, through the committed engine wasm over the chunks the run
//      published: every list read whole tags exactly the corpus rows the fake Scryfall named — a
//      card list by oracle id, a row list by row, a read set's English rows in or out of
//      `covered`, its printings in or out of `related` — and the list whose read failed is as the
//      compiled table has it.
//   3. BOTH BUILDERS AGREE. The native builder (the deploy path), handed the same table with
//      `--is-lists`, tags the same rows with each of the eight values, id for id.
//   3a. THE ARTWORK REPRESENTATIVES. The night read the newest end of the fake Scryfall's record
//      of them, back to HARNESS_ART_FROM; the native builder under the run's table marks, of the
//      rows released since that day, exactly the rows the record names; and the store the nightly
//      published answers `unique=art` with the named row for every artwork whose printings are
//      all inside the window with one of them named.
//   4. THE NIGHTS AFTER, each a fresh coordinator over the same KV, run as far as the first dump:
//      nothing moved → first pages only and the same table; a list grew → the table carries the
//      new member; a read failing midway and a malformed page → that list as last night had it;
//      a KV that cannot be read, and a slice the runtime ended twice → no refresh, and the chain
//      still reaches the dumps.
//
// With an import blob committed before the override existed (2) to (4) cannot run: the nightly
// then builds from the compiled table and says so, and this check says THAT, loudly, and passes —
// tests/engine/wasm-blob-freshness.test.ts is what fails on a stale blob.

import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import { chunkKey, formatManifestKey } from "../../src/engine/store-kv";
import type { StoreManifest } from "../../src/engine/types";
import {
	ART_REP_LINE,
	ART_REPS_QUERY,
	composeOverride,
	IS_LISTS_KV_KEY,
	IS_LISTS_SLICE_REQUESTS,
	type IsListsState,
	LIST_TAGS,
	type ListTag,
	listQuery,
	oraclesOf,
	readCompiled,
	type SmallList,
	tableLines,
} from "../../src/import-is-lists";
import type { Corpus } from "./corpus";
import { type FakeCard, FakeScryfall } from "./fake-scryfall";
import { type FakeKV, MeteredStorage } from "./storage";

export interface IsListsCheck {
	ok: boolean;
	lines: string[];
}

interface CorpusRow {
	id: string;
	oracles: string[];
	set: string;
	number: string;
	lang: string;
	released: string;
	/** The printing's one illustration; null for a faced or art-less row, which (3a) leaves alone. */
	illustration: string | null;
}

/**
 * The day the harness's night reads the artwork representatives back to (the coordinator's
 * test-only `ART_REPS_FROM`). The corpus is dated 1996 to 2025, years before any compiled table
 * of them, so the day production would use holds none of its rows.
 */
export const HARNESS_ART_FROM = "2002-01-01";

export interface ListsWorld {
	fake: FakeScryfall;
	/** Every corpus row, the ones the fake Scryfall does not hold (a key held twice) included. */
	rows: CorpusRow[];
	/** The sets the first night reads, and the list whose read is made to fail midway. */
	readSets: string[];
	failing: ListTag;
}

function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return h >>> 0;
}

/**
 * A Scryfall for the corpus: every row once per (set, number, language) — the synthetic corpus
 * repeats keys, which api.scryfall.com's never does, so the repeats are rows its search does not
 * hold, like the bulk file's real unindexed ones — and eight lists cut from it deterministically.
 */
export function listsWorld(corpus: Corpus): ListsWorld {
	const rows: CorpusRow[] = [];
	const cards: FakeCard[] = [];
	const held = new Set<string>();
	const perSet = new Map<string, number>();
	for (const line of new TextDecoder().decode(gunzipSync(corpus.dumps.all_cards as Uint8Array)).split("\n")) {
		if (!line.trim()) continue;
		const c = JSON.parse(line) as {
			id: string;
			name: string;
			set: string;
			collector_number: string;
			lang: string;
			oracle_id?: string;
			released_at?: string;
			illustration_id?: string;
			card_faces?: { oracle_id?: string }[];
			all_parts?: unknown[];
		};
		const oracles = oraclesOf(c);
		rows.push({
			id: c.id,
			oracles,
			set: c.set,
			number: c.collector_number,
			lang: c.lang,
			released: c.released_at ?? "",
			illustration: c.card_faces || !c.illustration_id ? null : c.illustration_id,
		});
		const key = `${c.set}/${c.collector_number}/${c.lang}`;
		if (held.has(key) || oracles.length === 0) continue;
		held.add(key);
		perSet.set(c.set, (perSet.get(c.set) ?? 0) + 1);
		const printing = `${c.set}/${c.collector_number}`;
		const is: string[] = [];
		if (c.lang === "en" ? hash(key) % 4 === 0 : hash(key) % 40 !== 0) is.push("covered");
		if (hash(printing) % 3 === 0) is.push("related");
		if (hash(key) % 150 === 3) is.push("misprint");
		if (hash(printing) % 211 === 5) is.push("intro");
		if (c.lang !== "en" && hash(key) % 2003 === 11) is.push("invitational");
		// The rows `new:artist` leaves out: one in sixty-one, whatever the language.
		if (hash(`artist ${key}`) % 61 === 7) is.push("old_artist");
		const card: FakeCard = {
			id: c.id,
			oracle_id: oracles[0] as string,
			name: c.name,
			set: c.set,
			collector_number: c.collector_number,
			lang: c.lang,
			is,
			released_at: c.released_at ?? "1993-08-05",
			// The record of artwork representatives: one row in four, of any day.
			rep: hash(`rep ${key}`) % 4 === 1,
		};
		if (Array.isArray(c.all_parts) && c.all_parts.length > 0) card.all_parts = c.all_parts;
		// One row in nineteen is a VARIATION, which the fake Scryfall answers only to a request
		// that asks for variations: every list and every read set holds some, so a refresh that
		// reads without them publishes a store this check finds short.
		if (hash(`variation ${key}`) % 19 === 0) card.variation = true;
		cards.push(card);
	}
	const bySize = [...perSet].sort(([, a], [, b]) => a - b || (a < b ? -1 : 1)).map(([code]) => code);
	// Two sets of middling size are "not yet released": the first night reads them. (The corpus's
	// smallest sets hold one row.) A smaller one is Jumpstart.
	const middle = Math.floor(bySize.length / 2);
	const readSets = bySize.slice(middle, middle + 2);
	const jumpstart = bySize[Math.floor(bySize.length / 3)] as string;
	const cardsOf = (from: number, count: number) =>
		new Set(
			[...new Set(cards.filter((c) => c.lang === "en").map((c) => c.oracle_id))].sort().slice(from, from + count),
		);
	const [spellbook, spikey] = [cardsOf(0, 3), cardsOf(3, 5)];
	for (const card of cards) {
		if (card.set === jumpstart) card.is.push("jumpstart");
		if (spellbook.has(card.oracle_id)) card.is.push("spellbook");
		if (spikey.has(card.oracle_id)) card.is.push("spikey");
	}
	const fake = new FakeScryfall(
		cards,
		[...perSet.keys()]
			.sort()
			.map((code) => ({ code, released_at: readSets.includes(code) ? "2099-01-01" : "2015-01-01" })),
	);
	// Small pages, so the lists take several and the night more than one alarm.
	fake.pageRows = 25;
	return { fake, rows, readSets, failing: "misprint" };
}

/** Make page 2 of the failing list's read fail, as a dropped connection would. */
export function failMidway(world: ListsWorld): void {
	world.fake.fault = (path) =>
		path.includes(encodeURIComponent(`is:${world.failing}`)) && path.includes("page=2") ? "throw" : null;
}

const isNode = (tag: string) => ({
	node_type: "CardBinaryOperatorNode",
	kwargs: {
		lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_is_tags", original_attribute: "is" } },
		op: ":",
		rhs: [tag],
	},
});

/**
 * The tree that answers a list's rows. `old_artist` is no tag of a stored row: the engine's build
 * turns its ABSENCE into the `new:artist` bit, so its rows are the ones `is:newartist` does not
 * answer.
 */
const isTree = (tag: string) =>
	JSON.stringify(
		tag === "old_artist" ? { node_type: "NotNode", kwargs: { operand: isNode("newartist") } } : isNode(tag),
	);

/** The ids of every row the published store tags with each value. */
async function publishedTags(kv: FakeKV, manifest: StoreManifest): Promise<Map<ListTag, Set<string>>> {
	const { engineFor } = await import("../../src/engine/wasm-shim");
	const engine = engineFor("harness-is-lists");
	const out = new Map<ListTag, Set<string>>(LIST_TAGS.map((tag) => [tag, new Set<string>()]));
	const opts = JSON.stringify({
		unique: "printing",
		orderby: "name",
		direction: "asc",
		limit: 10_000_000,
		offset: 0,
		fields: ["scryfall_id"],
		include_multilingual: true,
	});
	for (const part of manifest.partitions ?? []) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			pieces.push(
				gunzipSync(new Uint8Array((await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer)),
			);
		}
		const archive = new Uint8Array(Buffer.concat(pieces));
		engine.begin_store_load(archive.byteLength);
		engine.store_load_chunk(archive);
		engine.finish_store_load();
		for (const tag of LIST_TAGS) {
			const answer = JSON.parse(engine.query(isTree(tag), opts)) as { total: number; rows: { scryfall_id: string }[] };
			if (answer.rows.length !== answer.total)
				throw new Error(`is:${tag}: ${answer.rows.length} rows of ${answer.total}`);
			for (const row of answer.rows) (out.get(tag) as Set<string>).add(row.scryfall_id);
		}
	}
	return out;
}

/** The same, off the native builder's rows.jsonl. */
async function nativeTags(nativeDir: string): Promise<Map<ListTag, Set<string>>> {
	const out = new Map<ListTag, Set<string>>(LIST_TAGS.map((tag) => [tag, new Set<string>()]));
	const lines = createInterface({
		input: createReadStream(join(nativeDir, "rows.jsonl")),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		if (!line) continue;
		const row = JSON.parse(line) as { scryfall_id: string; card_is_tags?: Record<string, unknown> };
		for (const tag of LIST_TAGS) if (row.card_is_tags?.[tag]) (out.get(tag) as Set<string>).add(row.scryfall_id);
	}
	return out;
}

function differ(a: Set<string>, b: Set<string>): string | null {
	const missing = [...b].filter((id) => !a.has(id));
	const extra = [...a].filter((id) => !b.has(id));
	return missing.length + extra.length === 0 ? null : `${missing.length} missing, ${extra.length} extra`;
}

const metaRow = (storage: MeteredStorage, key: string): string | null => {
	const row = (storage.db.query("SELECT value FROM meta WHERE key = ?").all(key) as { value?: string }[])[0];
	return row?.value === undefined ? null : String(row.value);
};

/**
 * The committed import blob, through the coordinator's own shim. Imported HERE, not at the top:
 * its `.wasm` import resolves to a Module only once shims.ts has registered its loader, and a
 * static import is linked before that module runs.
 */
async function importBlob(): Promise<import("../../src/engine/import-wasm").ImportWasm> {
	return (await import("../../src/engine/import-wasm")).transientWasm();
}

/** Write the table the run installed (if any) where the native builder can be handed it. */
export function writeRunTable(storage: MeteredStorage, dir: string): string | null {
	const table = metaRow(storage, "is_lists_table");
	if (table === null) return null;
	const path = join(dir, "is-lists-override.tsv");
	writeFileSync(path, table);
	return path;
}

/** (1) to (3): the night the store was built on. `logged` is the run's `Is lists` lines. */
export async function checkIsLists(
	kv: FakeKV,
	storage: MeteredStorage,
	world: ListsWorld,
	logged: string[],
	nativeDir: string | null,
): Promise<IsListsCheck> {
	const lines: string[] = [];
	const fail = (why: string): IsListsCheck => ({ ok: false, lines: [...lines, `FAILED: ${why}`] });
	const manifest = (await kv.get(formatManifestKey(), "json")) as StoreManifest | null;
	if (!manifest) return fail("no manifest was published");
	const blob = await importBlob();
	if (!blob.isListsRefreshable()) {
		lines.push(
			"is lists: SKIPPED — the committed import blob predates the override (`bun run build:wasm-import`); " +
				`the nightly said: ${logged.at(-1) ?? "(nothing)"}`,
		);
		return logged.some((l) => l.includes("NOT refreshed"))
			? { ok: true, lines }
			: fail("a blob that cannot refresh did not say so");
	}

	// ── 1. the night ───────────────────────────────────────────────────────
	const line = logged.find((l) => l.startsWith("Is lists:")) ?? "";
	const state = (await kv.get(IS_LISTS_KV_KEY, "json")) as IsListsState | null;
	const table = metaRow(storage, "is_lists_table");
	if (!state || table === null) return fail(`the run left no state or no table (logged: ${line || "nothing"})`);
	const slices = Number(/in (\d+) slice/.exec(line)?.[1] ?? 0);
	if (slices < 2) return fail(`the refresh was meant to span alarms and took ${slices} slice(s): ${line}`);
	if (!line.includes(`${world.failing} REFUSED`)) return fail(`the failing list was not refused: ${line}`);
	if (state.lists[world.failing as keyof typeof state.lists]) return fail("a list whose read failed is in the state");
	const compiled = blob.isListsCompiled() as string;
	const artReps = blob.artRepsWritten() !== null;
	if (composeOverride(compiled, state, artReps) !== table)
		return fail("the table the run installed is not the one its state composes");
	if (artReps) {
		const art = state.art;
		if (!art || art.from !== HARNESS_ART_FROM)
			return fail(`the night's artwork representatives are ${JSON.stringify(art)?.slice(0, 120)}`);
		if (!table.includes(`\n# art-reps-from ${HARNESS_ART_FROM}\n`) || !table.includes(`\n${ART_REP_LINE}\trow\t`))
			return fail("the table the run installed carries no artwork representatives");
		if (manifest.is_lists?.art_reps?.from !== HARNESS_ART_FROM)
			return fail(
				`the manifest does not say which artwork representatives it was marked from: ${JSON.stringify(manifest.is_lists)}`,
			);
	} else {
		lines.push(
			"is lists: the artwork representatives NOT CHECKED — the committed import blob predates them (`bun run build`)",
		);
	}
	const note = manifest.is_lists;
	if (note?.source !== "nightly" || note.checked !== state.checked || note.sets !== world.readSets.length) {
		return fail(`the manifest's is_lists is ${JSON.stringify(note)}`);
	}
	lines.push(`is lists: ${line.slice("Is lists: ".length, 300)}…`);
	lines.push(
		`is lists: state in KV (${JSON.stringify(state).length} bytes), table of ${tableLines(table)} lines installed, ` +
			`manifest says ${JSON.stringify(note).slice(0, 160)}`,
	);

	// ── 2. the store carries them ──────────────────────────────────────────
	const got = await publishedTags(kv, manifest);
	const scry = (q: string) => world.fake.rows(q, "prints") as FakeCard[];
	const rowKey = (r: { set: string; number: string; lang: string }) => `${r.set}/${r.number}/${r.lang}`;
	const keysOf = (cards: FakeCard[]) => new Set(cards.map((c) => `${c.set}/${c.collector_number}/${c.lang}`));
	const idsWhere = (keep: (row: (typeof world.rows)[number]) => boolean) =>
		new Set(world.rows.filter(keep).map((r) => r.id));
	const expected = new Map<string, Set<string>>();
	// The ninth list only where the blob's own table counts it: an import blob built before the
	// list existed is never asked for it (`beginNight`), and its store holds no such bit.
	const artists = readCompiled(compiled).base.totals.old_artist !== undefined;
	const rowLists: readonly SmallList[] = artists
		? ["intro", "invitational", "jumpstart", "old_artist"]
		: ["intro", "invitational", "jumpstart"];
	if (!artists) {
		lines.push(
			"is lists: the rows new:artist leaves out NOT CHECKED — the committed import blob predates the list (`bun run build`)",
		);
	}
	for (const tag of rowLists) {
		const keys = keysOf(scry(listQuery(tag).q));
		expected.set(
			tag,
			idsWhere((r) => keys.has(rowKey(r))),
		);
	}
	for (const tag of ["spellbook", "spikey"] as const) {
		const oracles = new Set(scry(`is:${tag} lang:any`).map((c) => c.oracle_id));
		expected.set(
			tag,
			idsWhere((r) => r.oracles.some((id) => oracles.has(id))),
		);
	}
	for (const [tag, want] of expected) {
		if (want.size === 0)
			return fail(`the fake Scryfall's is:${tag} names no corpus row — the check would prove nothing`);
		const off = differ(got.get(tag as ListTag) as Set<string>, want);
		if (off) return fail(`is:${tag}: the store's rows are not the list's (${off} of ${want.size})`);
	}
	// A read set, absolutely: its English rows by row, its printings by number.
	const inRead = (r: { set: string }) => world.readSets.includes(r.set);
	const covered = keysOf(world.readSets.flatMap((s) => scry(`e:${s} is:covered lang:en`)));
	const related = new Set(
		world.readSets.flatMap((s) => scry(`e:${s} is:related`)).map((c) => `${c.set}/${c.collector_number}`),
	);
	const english = idsWhere((r) => inRead(r) && r.lang === "en");
	const wantCovered = idsWhere((r) => inRead(r) && r.lang === "en" && covered.has(rowKey(r)));
	const gotCovered = new Set([...(got.get("covered") as Set<string>)].filter((id) => english.has(id)));
	const wantRelated = idsWhere((r) => inRead(r) && related.has(`${r.set}/${r.number}`));
	const everyRead = idsWhere(inRead);
	const gotRelated = new Set([...(got.get("related") as Set<string>)].filter((id) => everyRead.has(id)));
	if (wantCovered.size === 0 || wantCovered.size === english.size || wantRelated.size === 0) {
		return fail("the read sets' covered or related rows are none or all — the check would prove nothing");
	}
	const offCovered = differ(gotCovered, wantCovered);
	if (offCovered)
		return fail(`is:covered in ${world.readSets.join(", ")}: the English rows are not the answer's (${offCovered})`);
	const offRelated = differ(gotRelated, wantRelated);
	if (offRelated)
		return fail(`is:related in ${world.readSets.join(", ")}: the printings are not the answer's (${offRelated})`);
	// The foreign rows, everywhere: covered but for the ones the answer names.
	const uncoveredForeign = keysOf(scry("-is:covered -lang:en"));
	const wantForeign = idsWhere((r) => r.lang !== "en" && !uncoveredForeign.has(rowKey(r)));
	const foreign = idsWhere((r) => r.lang !== "en");
	const offForeign = differ(
		new Set([...(got.get("covered") as Set<string>)].filter((id) => foreign.has(id))),
		wantForeign,
	);
	if (offForeign)
		return fail(`is:covered in other languages: not every row but the ${uncoveredForeign.size} named (${offForeign})`);
	lines.push(
		`is lists: the published store tags exactly the fake Scryfall's rows — ` +
			[...expected].map(([tag, want]) => `${tag} ${want.size}`).join(", ") +
			`; covered ${wantCovered.size} of ${english.size} English rows and related ${wantRelated.size} of ${everyRead.size} rows in ` +
			`${world.readSets.join(", ")}; ${uncoveredForeign.size} foreign rows uncovered of ${foreign.size}`,
	);

	// ── 3. both builders, under the same table ─────────────────────────────
	if (!nativeDir || !existsSync(join(nativeDir, "rows.jsonl"))) {
		lines.push("is lists: native-builder parity skipped (--no-native)");
		return { ok: true, lines };
	}
	const native = await nativeTags(nativeDir);
	const nativeManifest = JSON.parse(await Bun.file(join(nativeDir, "manifest.json")).text()) as StoreManifest;
	// The same object, whatever order each builder wrote its keys in.
	const sorted = (value: unknown): string =>
		JSON.stringify(value, (_key, v: unknown) =>
			v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v,
		);
	if (sorted(nativeManifest.is_lists) !== sorted(note)) {
		return fail(
			`the native manifest's is_lists is ${JSON.stringify(nativeManifest.is_lists)}, the nightly's ${JSON.stringify(note)}`,
		);
	}
	for (const tag of LIST_TAGS) {
		if (tag === "old_artist" && !artists) continue;
		const off = differ(got.get(tag) as Set<string>, native.get(tag) as Set<string>);
		if (off) return fail(`is:${tag}: the nightly's rows are not the native builder's under the same table (${off})`);
	}
	lines.push(
		"is lists: the native builder, handed the same table (--is-lists), tags the same rows id for id — " +
			LIST_TAGS.map((tag) => `${tag} ${(native.get(tag) as Set<string>).size}`).join(", "),
	);

	// ── 3a. the artwork representatives ────────────────────────────────────
	if (!artReps) return { ok: true, lines };
	const named = keysOf(
		(world.fake.rows(ART_REPS_QUERY, "art") as FakeCard[]).filter((c) => (c.released_at ?? "") >= HARNESS_ART_FROM),
	);
	const since = idsWhere((r) => r.released >= HARNESS_ART_FROM);
	const wantMarked = idsWhere((r) => r.released >= HARNESS_ART_FROM && named.has(rowKey(r)));
	const marked = await nativeMarked(nativeDir, since);
	if (wantMarked.size < 100 || wantMarked.size * 2 > since.size)
		return fail(
			`the record names ${wantMarked.size} of ${since.size} rows since ${HARNESS_ART_FROM} — the check would prove nothing`,
		);
	const offMarked = differ(marked, wantMarked);
	if (offMarked)
		return fail(
			`artwork representatives: the native builder's marks since ${HARNESS_ART_FROM} are not the record's rows (${offMarked} of ${wantMarked.size})`,
		);
	// Through the store the nightly published: an artwork whose English printings are all inside
	// the window, exactly one of them named, answers that one. (A faced or art-less printing, and
	// an artwork with a printing before the day — which the compiled record or the debut rule
	// may mark — are left out: the claim is the window's alone.)
	const groups = new Map<string, CorpusRow[]>();
	for (const r of world.rows) {
		if (r.lang !== "en" || r.illustration === null || r.oracles.length === 0) continue;
		// By the illustration alone, whichever cards carry it: an artwork two cards share is one
		// artwork, and its named printing answers in the partition that holds it.
		groups.set(r.illustration, [...(groups.get(r.illustration) ?? []), r]);
	}
	const answered = await publishedArtworks(kv, manifest);
	let [asked, wrong] = [0, 0];
	for (const group of groups.values()) {
		if (group.length < 2 || group.some((r) => r.released < HARNESS_ART_FROM)) continue;
		const namedHere = group.filter((r) => named.has(rowKey(r)));
		if (namedHere.length !== 1) continue;
		asked++;
		if (!answered.has((namedHere[0] as CorpusRow).id)) wrong++;
	}
	if (asked < 20)
		return fail(`only ${asked} artworks of the corpus can be asked about — the check would prove nothing`);
	if (wrong > 0)
		return fail(`unique=art: ${wrong} of ${asked} artworks inside the window do not answer the row the record names`);
	lines.push(
		`is lists, the artwork representatives: ${state.art?.total} in the fake record, read back to ${HARNESS_ART_FROM} ` +
			`(${membersOf(state.art?.lines ?? []).size} rows); the native builder under the run's table marks exactly the ${wantMarked.size} ` +
			`named rows of the ${since.size} released since; and the published store answers unique=art with the named printing ` +
			`for ${asked} of ${asked} artworks whose printings are all inside the window`,
	);
	return { ok: true, lines };
}

/** Every key a table's `row` lines name. */
function membersOf(tableRows: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const line of tableRows) {
		const [, , set, lang, numbers] = line.split("\t");
		for (const n of (numbers ?? "").split(" ")) out.add(`${set}/${n}/${lang}`);
	}
	return out;
}

/** The ids, among `within`, of the native builder's rows that carry the artwork-representative mark. */
async function nativeMarked(nativeDir: string, within: Set<string>): Promise<Set<string>> {
	const out = new Set<string>();
	const rows = createInterface({
		input: createReadStream(join(nativeDir, "rows.jsonl")),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rows) {
		if (!line) continue;
		const row = JSON.parse(line) as { scryfall_id: string; card_is_tags?: Record<string, unknown> };
		// card_engine's ART_DEBUT_TAG: what the engine's build turns into the bit `unique=art` reads.
		if (row.card_is_tags?.art_debut && within.has(row.scryfall_id)) out.add(row.scryfall_id);
	}
	return out;
}

/** The ids of every row the published store answers `unique=art` with, over every printing. */
async function publishedArtworks(kv: FakeKV, manifest: StoreManifest): Promise<Set<string>> {
	const { engineFor } = await import("../../src/engine/wasm-shim");
	const engine = engineFor("harness-is-lists");
	const out = new Set<string>();
	const opts = JSON.stringify({
		unique: "artwork",
		orderby: "name",
		direction: "asc",
		limit: 10_000_000,
		offset: 0,
		fields: ["scryfall_id"],
	});
	// Every printing: none carries a tag of this name.
	const everything = JSON.stringify({ node_type: "NotNode", kwargs: { operand: isNode("no-such-tag") } });
	for (const part of manifest.partitions ?? []) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			pieces.push(
				gunzipSync(new Uint8Array((await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer)),
			);
		}
		const archive = new Uint8Array(Buffer.concat(pieces));
		engine.begin_store_load(archive.byteLength);
		engine.store_load_chunk(archive);
		engine.finish_store_load();
		const answer = JSON.parse(engine.query(everything, opts)) as { rows: { scryfall_id: string }[] };
		for (const row of answer.rows) out.add(row.scryfall_id);
	}
	return out;
}

// ── (4) the nights after ───────────────────────────────────────────────────────────────────────

interface NightRan {
	/** The phase the chain reached. */
	phase: string;
	table: string | null;
	logged: string[];
	/** The search queries asked, decoded. */
	queries: string[];
	paged: number;
	alarms: number;
}

type CoordinatorClass = new (
	ctx: unknown,
	env: unknown,
) => { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };

/** A fresh coordinator over the same KV, run from its start until the chain leaves the refresh. */
async function runToFirstDump(
	Coordinator: CoordinatorClass,
	env: Record<string, unknown>,
	world: ListsWorld,
	before?: (storage: MeteredStorage) => Promise<void>,
): Promise<NightRan> {
	const storage = new MeteredStorage();
	const ctx = {
		storage,
		abort(reason?: string): void {
			throw new Error(`ctx.abort: ${reason ?? "no reason"}`);
		},
	};
	const coordinator = new Coordinator(ctx, env);
	const logged: string[] = [];
	const [log, warn] = [console.log, console.warn];
	const capture =
		(to: typeof console.log) =>
		(...args: unknown[]) => {
			if (typeof args[0] === "string" && args[0].startsWith("Is lists:")) logged.push(args[0]);
			else if (typeof args[0] === "string" && args[0].startsWith("[wasm-import]")) to(...args);
		};
	const from = world.fake.asked.length;
	let alarms = 0;
	console.log = capture(log);
	console.warn = capture(warn);
	try {
		await coordinator.fetch(new Request("https://coordinator/start-import?reason=harness"));
		for (; alarms < 200; alarms++) {
			const phase = metaRow(storage, "phase") ?? "idle";
			if (phase.startsWith("fetch:") || phase === "idle") break;
			if (phase === "is_lists" && before) {
				await before(storage);
				before = undefined;
			}
			if ((await storage.getAlarm()) === null) break;
			await storage.deleteAlarm();
			await coordinator.alarm();
		}
	} finally {
		console.log = log;
		console.warn = warn;
	}
	const asked = world.fake.asked.slice(from).filter((path) => path.startsWith("/cards/search"));
	return {
		phase: metaRow(storage, "phase") ?? "idle",
		table: metaRow(storage, "is_lists_table"),
		logged,
		queries: asked.map((path) => new URL(path, "https://x.invalid").searchParams.get("q") ?? ""),
		paged: asked.filter((path) => path.includes("page=")).length,
		alarms,
	};
}

const bodyOf = (table: string | null) => (table ?? "").split("\n").filter((l) => l && !l.startsWith("#"));
const linesOf = (table: string | null, tag: string) => bodyOf(table).filter((l) => l.startsWith(`${tag}\t`));

export async function checkLaterNights(
	Coordinator: CoordinatorClass,
	env: Record<string, unknown>,
	kv: FakeKV,
	world: ListsWorld,
	firstTable: string,
): Promise<IsListsCheck> {
	const lines: string[] = [];
	const fail = (why: string): IsListsCheck => ({ ok: false, lines: [...lines, `FAILED: ${why}`] });
	const reached = (ran: NightRan) => (ran.phase.startsWith("fetch:") ? null : `the chain stopped in ${ran.phase}`);
	const { fake } = world;

	// Nothing moved (the failing list's read still fails: it is asked for again, and refused again).
	const quiet = await runToFirstDump(Coordinator, env, world);
	const quietPaged = quiet.queries.filter((q, i) => quiet.queries.indexOf(q) !== i && !q.includes(world.failing));
	if (reached(quiet)) return fail(`quiet night: ${reached(quiet)}`);
	if (quietPaged.length > 0 || quiet.queries.some((q) => q.startsWith("e:"))) {
		return fail(`quiet night: refetched ${[...new Set(quietPaged)].join(", ") || "a set"} though nothing moved`);
	}
	if (JSON.stringify(bodyOf(quiet.table)) !== JSON.stringify(bodyOf(firstTable)))
		return fail("quiet night: the table changed");
	lines.push(
		`is lists, a night nothing moved: ${quiet.queries.length} requests, no list refetched, no set read, the same table — ` +
			`${quiet.logged[0]?.slice(0, 110)}…`,
	);

	// The failing list heals, and a card list grows by one card.
	fake.fault = null;
	const newcomer = fake.cards.find(
		(c) => c.lang === "en" && !c.is.includes("spellbook") && !c.is.includes("spikey"),
	) as FakeCard;
	for (const c of fake.cards) if (c.oracle_id === newcomer.oracle_id) c.is.push("spellbook");
	const grown = await runToFirstDump(Coordinator, env, world);
	if (reached(grown)) return fail(`a list grew: ${reached(grown)}`);
	if (!linesOf(grown.table, "spellbook").some((l) => l.includes(newcomer.oracle_id))) {
		return fail(`a list grew: the table does not carry the new card (${grown.logged[0]})`);
	}
	if (linesOf(grown.table, world.failing).length === 0 || !grown.logged[0]?.includes(`${world.failing} first read`)) {
		return fail(`a list grew: the list that failed last night was not read tonight (${grown.logged[0]})`);
	}
	lines.push(
		`is lists, a list grew: spellbook carries ${newcomer.name} (${linesOf(grown.table, "spellbook").length} cards), and ` +
			`${world.failing} — refused the nights before — is read whole (${linesOf(grown.table, world.failing).length} lines)`,
	);

	// A read failing midway, then a malformed page: Jumpstart grows each night and is not applied.
	const jumpstartSet = (fake.cards.find((c) => c.is.includes("jumpstart")) as FakeCard).set;
	const lastGood = JSON.stringify(linesOf(grown.table, "jumpstart"));
	const growJumpstart = () => {
		const extra = fake.cards.find((c) => c.set !== jumpstartSet && !c.is.includes("jumpstart")) as FakeCard;
		extra.is.push("jumpstart");
	};
	growJumpstart();
	fake.fault = (path) => (path.includes("jumpstart") && path.includes("page=2") ? "throw" : null);
	const broken = await runToFirstDump(Coordinator, env, world);
	if (reached(broken)) return fail(`a read failed midway: ${reached(broken)}`);
	if (
		!broken.logged[0]?.includes("jumpstart REFUSED") ||
		JSON.stringify(linesOf(broken.table, "jumpstart")) !== lastGood
	) {
		return fail(`a read failed midway: jumpstart is not as last night had it (${broken.logged[0]})`);
	}
	growJumpstart();
	fake.fault = (path) => {
		if (!path.includes("jumpstart") || !path.includes("page=2")) return null;
		const truth = structuredClone(fake.truth(path)) as { status: number; body: { data: Record<string, unknown>[] } };
		delete (truth.body.data[0] as Record<string, unknown>).collector_number;
		return truth;
	};
	const malformed = await runToFirstDump(Coordinator, env, world);
	if (reached(malformed)) return fail(`a malformed page: ${reached(malformed)}`);
	if (
		!malformed.logged[0]?.includes(
			"jumpstart REFUSED (is:jumpstart lang:any: a row without id, set, number or lang)",
		) ||
		JSON.stringify(linesOf(malformed.table, "jumpstart")) !== lastGood
	) {
		return fail(`a malformed page: jumpstart is not as last night had it (${malformed.logged[0]})`);
	}
	lines.push(
		"is lists, a read failing midway and then a malformed page: jumpstart REFUSED both nights and left as the last good " +
			"night had it; every other list read, the chain on to the dumps",
	);

	// No state to be had, and a slice the runtime ended twice: no refresh, and the chain goes on.
	fake.fault = null;
	const state = (await kv.get(IS_LISTS_KV_KEY, "text")) as string;
	const realGet = kv.get.bind(kv);
	kv.get = async (key: string, options?: unknown) => {
		if (key === IS_LISTS_KV_KEY) throw new Error("KV GET failed: 500 Internal Server Error");
		return realGet(key, options);
	};
	const blind = await runToFirstDump(Coordinator, env, world);
	kv.get = realGet;
	if (
		reached(blind) ||
		blind.queries.length > 0 ||
		blind.table !== null ||
		!blind.logged[0]?.includes("NOT refreshed tonight")
	) {
		return fail(
			`KV unreadable: ${reached(blind) ?? blind.logged[0] ?? "nothing said"} (${blind.queries.length} requests)`,
		);
	}
	if (((await kv.get(IS_LISTS_KV_KEY, "text")) as string) !== state)
		return fail("KV unreadable: the stored lists were overwritten");
	const killed = await runToFirstDump(Coordinator, env, world, async (storage) => {
		// As the alarm body leaves it after two attempts that never returned.
		await storage.put("phase_attempts", 2);
	});
	if (reached(killed) || killed.queries.length > 0 || !killed.logged[0]?.includes("ended from outside 2 times")) {
		return fail(`a slice ended twice: ${reached(killed) ?? killed.logged[0] ?? "nothing said"}`);
	}
	lines.push(
		`is lists, no refresh at all: with KV unreadable ("${blind.logged[0]?.slice(0, 90)}…") and with a slice ended twice from ` +
			"outside the chain still reaches the dumps, asks Scryfall nothing and overwrites nothing",
	);
	if (IS_LISTS_SLICE_REQUESTS > 49)
		return fail("a slice may make more requests than a free-plan invocation's 50 subrequests");
	return { ok: true, lines };
}
