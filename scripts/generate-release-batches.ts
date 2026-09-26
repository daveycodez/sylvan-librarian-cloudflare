// Measure the order api.scryfall.com gives the SETS that share one release date, and write it to
// the table the engine's `assign_set_ranks` reads (vendor/…/card_engine/src/release_batches.tsv).
//
//   bun run release-batches                       # reads store-build/rows.jsonl
//   bun run release-batches -- --rows <rows.jsonl>
//
// `order=released` breaks a date tie by set, then by collector number, and `dir=desc` is the exact
// reversal of `dir=asc`. Which SET comes first inside a date is not anything Scryfall publishes:
// no `/sets` field, no parent/child or set-type rule and not the code order reproduces it (the
// parity-sweep findings §16 and §18 prove that over every visible field). It is not even one order
// over the sets: `prm` sorts before `sld` on 2020-07-31 and after it on 2022-11-04, measured in one
// sitting. So it is measured, per date, and what the engine stores is the measurement.
//
// WHAT A DATE LOOKS LIKE. Scryfall's sequence is the code order broken into BATCHES — runs that
// are each alphabetical, one after another (2025-04-11 is `plg25 plst pspl spg tdm | tdc | atdm
// ptdm ttdc ttdm`) — the shape sets added in several passes leave. So the table stores, per date, the
// batch of every set that is not in the first one, and the engine orders a date's sets by
// (batch, code). A set the table does not name is batch 0: a date nobody measured sorts by code,
// which is exactly what this port did before the table existed, and a set added to a measured
// date after the last refresh sorts by code among the first batch.
//
// ONE REQUEST PER DATE. Every date on which the local store holds printings of two or more sets is
// asked once, for one printing of each set (`date=D ((e:a cn:"x") or (e:b cn:"y") …)`, extras and
// variations included so no set hides), ascending. The set sequence is read off the answer.
//
// Run by hand after a store build and commit the diff, like `bun run set-dates`: the nightly import
// cannot touch committed code, and the table is only a snapshot of an order Scryfall does not
// promise to keep — `snc`/`psnc` on 2022-04-29 swapped between 2026-08-16 and 2026-09-25. A table
// change moves stored ranks, so it ships with a STORE_CONTENT_GENERATION bump.

import { createReadStream, writeFileSync } from "node:fs";

const OUT = "vendor/sylvan_librarian/card_engine/src/release_batches.tsv";
const UA = "sylvan-librarian-cloudflare/generate-release-batches (set order inside a release date)";
// api.scryfall.com asks for under 10 requests a second; /cards/search rate-limits well below that
// in practice (a 250ms gap drew a 429 on 2026-09-25), so this stays at two a second.
const GAP_MS = 500;

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pick {
	rank: [number, number, number, string];
	cn: string;
}

function before(a: Pick["rank"], b: Pick["rank"]): boolean {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return (a[i] as number | string) < (b[i] as number | string);
	}
	return false;
}

/**
 * The file's lines, split on `\n` alone. Not `readline`: it also breaks on the U+2028/U+2029 that
 * JSON allows raw inside a string, and flavor text carries them.
 */
async function* jsonLines(path: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let rest = "";
	for await (const chunk of createReadStream(path)) {
		rest += decoder.decode(chunk as Uint8Array, { stream: true });
		let nl = rest.indexOf("\n");
		let start = 0;
		while (nl >= 0) {
			if (nl > start) yield rest.slice(start, nl);
			start = nl + 1;
			nl = rest.indexOf("\n", start);
		}
		rest = rest.slice(start);
	}
	if (rest) yield rest;
}

/** date → set → the printing to ask for: English first, then a bare number, then the shortest. */
async function readDates(path: string): Promise<Map<string, Map<string, Pick>>> {
	const dates = new Map<string, Map<string, Pick>>();
	for await (const line of jsonLines(path)) {
		const row = JSON.parse(line) as {
			card_set_code?: string;
			collector_number?: string;
			released_at?: string | null;
			card_compat_blob?: { lang?: string };
		};
		const { card_set_code: set, collector_number: cn, released_at: date } = row;
		if (!set || !cn || !date || /["\s]/.test(cn)) continue;
		const rank: Pick["rank"] = [row.card_compat_blob?.lang === "en" ? 0 : 1, /^\d+$/.test(cn) ? 0 : 1, cn.length, cn];
		let sets = dates.get(date);
		if (!sets) {
			sets = new Map();
			dates.set(date, sets);
		}
		const cur = sets.get(set);
		if (!cur || before(rank, cur.rank)) sets.set(set, { rank, cn });
	}
	return dates;
}

async function ask(date: string, sets: Map<string, Pick>): Promise<string[]> {
	const terms = [...sets].map(([set, { cn }]) => `(e:${set} cn:"${cn}")`).join(" or ");
	const qs = new URLSearchParams({
		q: `date=${date} (${terms})`,
		unique: "prints",
		order: "released",
		dir: "asc",
		include_extras: "true",
		include_variations: "true",
	});
	let url: string | null = `https://api.scryfall.com/cards/search?${qs}`;
	const seq: string[] = [];
	while (url) {
		const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
		const body = (await res.json()) as { data?: { set: string }[]; has_more?: boolean; next_page?: string };
		await sleep(GAP_MS);
		if (res.status === 429) {
			await sleep(65_000);
			continue;
		}
		if (res.status === 404) break;
		if (!res.ok) throw new Error(`${date}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
		for (const card of body.data ?? []) {
			if (seq.at(-1) === card.set) continue;
			if (seq.includes(card.set)) throw new Error(`${date}: ${card.set} is not contiguous — the set grouping broke`);
			seq.push(card.set);
		}
		url = body.has_more && body.next_page ? body.next_page : null;
	}
	return seq;
}

/** Each set's batch: the number of code-order descents before it in the date's sequence. */
export function batchesOf(seq: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	let batch = 0;
	seq.forEach((set, i) => {
		if (i > 0 && set < (seq[i - 1] as string)) batch++;
		out.set(set, batch);
	});
	return out;
}

async function main(): Promise<void> {
	const rows = arg("--rows", "store-build/rows.jsonl");
	const dates = await readDates(rows);
	const shared = [...dates].filter(([, sets]) => sets.size >= 2).sort(([a], [b]) => (a < b ? 1 : -1));
	console.log(`${shared.length} release dates hold two or more sets in ${rows}`);
	const entries: string[] = [];
	let reordered = 0;
	let maxBatch = 0;
	for (const [date, sets] of shared) {
		const seq = await ask(date, sets);
		const batches = batchesOf(seq);
		if ([...batches.values()].some((b) => b > 0)) reordered++;
		for (const [set, batch] of batches) {
			if (batch === 0) continue;
			maxBatch = Math.max(maxBatch, batch);
			entries.push(`${date.replace(/-/g, "")}\t${set}\t${batch}`);
		}
	}
	entries.sort();
	const header = [
		"# GENERATED FILE - do not edit. Built by scripts/generate-release-batches.ts from api.scryfall.com.",
		"#",
		"# yyyymmdd <TAB> set code <TAB> batch: inside one release date, `order=released` orders the sets",
		"# by (batch, code). A (date, set) not listed is batch 0. See assign_set_ranks in lib.rs.",
		`# ${shared.length} dates measured, ${reordered} of them not in code order.`,
	];
	writeFileSync(OUT, `${[...header, ...entries].join("\n")}\n`);
	console.log(`Wrote ${OUT} — ${entries.length} entries over ${reordered} dates, largest batch ${maxBatch}`);
}

if (import.meta.main) await main();
