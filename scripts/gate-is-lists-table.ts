// An `is:` lists override that names rows of a bulk file, for scripts/gate.sh's differential.
//
//   bun scripts/gate-is-lists-table.ts <bulk.jsonl> <out.tsv>
//
// The gate asks both builders for the same rows under ONE override — `memprobe rows --is-lists`
// natively, engine/wasm-import/driver.ts's sixth argument in wasm — and the table has to be one the
// nightly could have composed, touching every kind of line it writes: a card list by oracle id, a
// row list by row (and the ninth list, the rows `new:artist` leaves out, which the builders turn
// into a mark the engine's build reads), the artwork representatives released since a day, the
// foreign rows out of `covered`, and one set written absolutely for `covered`
// (English rows in and out) and `related` (printings in and out, and a card by its oracle id). So
// it is composed by the nightly's own `composeOverride` (src/import-is-lists.ts) over the
// committed table, from a state cut out of the bulk file's first rows.
//
// Deterministic: the same bulk file gives the same table.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ART_REP_LINE,
	composeOverride,
	freshState,
	numberLines,
	oraclesOf,
	readCompiled,
	tableLines,
} from "../src/import-is-lists";

const [bulkPath, outPath] = process.argv.slice(2);
if (!bulkPath || !outPath) {
	console.error("usage: bun scripts/gate-is-lists-table.ts <bulk.jsonl> <out.tsv>");
	process.exit(2);
}

interface Row {
	set: string;
	number: string;
	lang: string;
	oracle: string;
	name: string;
	released: string;
}

// The head of the file is enough, and the file is ~200MB: read a slice, drop the cut line.
const head = new TextDecoder().decode(
	await Bun.file(bulkPath)
		.slice(0, 24 * 1024 * 1024)
		.arrayBuffer(),
);
const rows: Row[] = head
	.split("\n")
	.slice(0, -1)
	.filter((line) => line.trim())
	.map((line) => {
		const c = JSON.parse(line) as {
			set: string;
			collector_number: string;
			lang: string;
			name: string;
			oracle_id?: string;
			released_at?: string;
			card_faces?: { oracle_id?: string }[];
		};
		return {
			set: c.set,
			number: c.collector_number,
			lang: c.lang,
			oracle: oraclesOf(c)[0] ?? "",
			name: c.name,
			released: c.released_at ?? "",
		};
	})
	.filter((r) => r.oracle && !/\s/.test(r.set + r.number + r.lang) && !/[\t\n]/.test(r.name));
if (rows.length < 500) throw new Error(`${bulkPath}: ${rows.length} usable rows in its first 24MB — not a bulk file?`);

const compiled = readFileSync(join(import.meta.dir, "..", "engine", "builder", "src", "is_lists.tsv"), "utf8");
const state = freshState(readCompiled(compiled).base);
const night = "2026-01-01";
const english = rows.filter((r) => r.lang === "en");
const foreign = rows.filter((r) => r.lang !== "en");
const grouped = (picked: Row[], key: (r: Row) => string) => {
	const byKey = new Map<string, Set<string>>();
	for (const r of picked) byKey.set(key(r), (byKey.get(key(r)) ?? new Set()).add(r.number));
	return byKey;
};

const cards = [...new Map(english.map((r) => [r.oracle, r.name]))].slice(0, 6);
state.lists.spellbook = {
	total: 3,
	fetched: night,
	lines: cards.slice(0, 3).map(([id, name]) => `spellbook\toracle\t${id}\t${name}`),
};
state.lists.spikey = {
	total: 3,
	fetched: night,
	lines: cards.slice(3, 6).map(([id, name]) => `spikey\toracle\t${id}\t${name}`),
};
const introRows = rows.filter((_, i) => i % 97 === 0).slice(0, 40);
state.lists.intro = {
	total: introRows.length,
	fetched: night,
	lines: numberLines(
		"intro",
		"row",
		grouped(introRows, (r) => `${r.set}\t${r.lang}`),
	),
};
// The ninth list, which is not an `is:` value: rows `new:artist` leaves out, of any language.
const oldArtistRows = rows.filter((_, i) => i % 89 === 0).slice(0, 50);
state.lists.old_artist = {
	total: oldArtistRows.length,
	fetched: night,
	lines: numberLines(
		"old_artist",
		"row",
		grouped(oldArtistRows, (r) => `${r.set}\t${r.lang}`),
	),
};
const uncovered = foreign.filter((_, i) => i % 53 === 0).slice(0, 60);
state.foreign = {
	total: uncovered.length,
	fetched: night,
	lines: numberLines(
		"covered",
		"not-row",
		grouped(uncovered, (r) => `${r.set}\t${r.lang}`),
	),
};
const set = (english[0] as Row).set;
const numbers = [...new Set(english.filter((r) => r.set === set).map((r) => r.number))];
const half = Math.ceil(numbers.length / 2);
const inSet = (kind: string, tag: string, picked: string[], key: string) =>
	picked.length > 0 ? numberLines(tag, kind, new Map([[key, new Set(picked)]])) : [];
const related = numbers.filter((_, i) => i % 3 === 0);
const loose = english.find((r) => r.set === set && related.includes(r.number)) as Row;
state.sets[set] = {
	count: numbers.length,
	fetched: night,
	cov: half,
	unc: numbers.length - half,
	rel: related.length,
	lines: [
		...inSet("row", "covered", numbers.slice(0, half), `${set}\ten`),
		...inSet("not-row", "covered", numbers.slice(half), `${set}\ten`),
		...inSet("print", "related", related, set),
		...inSet(
			"not",
			"related",
			numbers.filter((n) => !related.includes(n)),
			set,
		),
		`related\toracle\t${loose.oracle}\t${loose.name}`,
	],
};
// The artwork representatives: every row released on or after the day half the rows are older
// than is marked by these lines alone — one row in five of them — and the older half by the
// compiled record and the debut rule, as with no override.
const days = rows
	.map((r) => r.released)
	.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
	.sort();
const artFrom = days[Math.floor(days.length / 2)] as string;
const artRows = rows.filter((r) => r.released >= artFrom).filter((_, i) => i % 5 === 0);
if (artRows.length < 20) throw new Error(`${bulkPath}: ${artRows.length} rows to mark as artwork representatives`);
state.art = {
	total: artRows.length,
	fetched: night,
	from: artFrom,
	lines: numberLines(
		ART_REP_LINE,
		"row",
		grouped(artRows, (r) => `${r.set}\t${r.lang}`),
	),
};
state.checked = night;

const table = composeOverride(compiled, state);
if (table === null) throw new Error("the state refines nothing");
writeFileSync(outPath, table);
console.log(
	`${outPath}: ${tableLines(table)} lines — 3 spellbook and 3 spikey cards, ${introRows.length} intro rows, ` +
		`${oldArtistRows.length} rows out of new:artist, ${artRows.length} artwork representatives since ${artFrom}, ` +
		`${uncovered.length} foreign rows out of covered, ${numbers.length} printings of ${set} in or out of covered and related`,
);
