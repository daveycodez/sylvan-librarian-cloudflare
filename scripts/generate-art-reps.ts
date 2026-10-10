// Read which printing REPRESENTS each artwork on api.scryfall.com, and write them to the table
// the builder marks them from (engine/builder/src/art_reps.tsv).
//
//   bun run art-reps                                # reads api.scryfall.com (~320 requests)
//   bun run art-reps -- --save reps.jsonl           # ...and keeps what it read
//   bun run art-reps -- --load reps.jsonl           # re-reads a kept answer, no network
//
// WHAT IS MEASURED. `unique=art` returns one printing per artwork, and which one is not anything a
// card object carries. Asked for an artwork's printings one at a time — ask, drop the answer, ask
// again — Scryfall returns ONE printing first and then the card's own order (ranks.rs):
//
//   !"Vizzerdrix"          7ed/110, then 9ed/S7, 9ed/S7a, 8ed/S5, 8ed/S5a, 7ed/110★
//   !"Cryptex"             mkm/422, then mkm/251, pmkm/251p, pmkm/251s
//   !"Temple of Deceit"    thb/245, then fdn/697, dsc/307, moc/431, clb/922, mic/184, woc/170, …
//
// so each artwork has a REPRESENTATIVE, a record Scryfall keeps per illustration, and a search
// answers it wherever the query holds it and the first of the card's order where it does not. The
// record follows no field: over the 9,910 artworks whose printings share their first date, the
// best key (not a promo, then the lowest collector number) names the representative of 81%; it is
// the extended-art printing for Cryptex and the plain one for Tarrian's Journal, the invisible-ink
// foil mkm/379 over the showcase mkm/341 it copies, the surge foil who/913 over who/322.
//
// It is PUBLISHED, though: a search that matches every card (`year>=1993`, extras and variations
// in) returns every artwork's representative, 54,746 rows on 2026-10-10. With those as the mark,
// "the representative where the query holds it, else the first of the card's own order" answers
// 3,700 of 3,700 artworks that have two or more printings in scope, over 24 scopes (twelve sets,
// six release groups, reprint sets without their originals, the variations) — where the rule this
// replaces, a printing of the day the artwork debuted, has 3,111.
//
// (Scryfall's `unique_artwork` bulk file is nearly the same list and is NOT read: it also carries
// the representative of an illustration that has since been merged into another — 51 artworks
// have two rows there and seven none — and for 18 it names a translation.)
//
// THE TABLE holds every set Scryfall lists and, for each, the collector numbers of the rows that
// represent an artwork (a run of whole numbers as `first..last`; `number@lang` for a row that is
// not English). A set the table names is answered by it alone; a set it does not name — one
// released since the last run — falls back to the debut rule (engine/builder `NewArt::standing`),
// which is right for a reprint, since the representative of an old artwork is in an old set.
//
// THE NIGHTLY IMPORT READS THE NEWEST END OF THE SAME RECORD (src/import-is-lists.ts, THE ARTWORK
// REPRESENTATIVES): the same query asked newest release first, down to a month before this
// table's `@written` day, handed to the builder beside the lists it refreshes. So a set released
// since this script last ran is answered by Scryfall's record all the same, and what this script
// is still for is everything the night's window does not reach: a representative Scryfall moved
// in an older set, a printing catalogued late under an old date, and the window itself, which
// grows a page for every 175 artworks printed since `@written` and is refused past 60 pages.
// The query, the paging and what counts as a page of a list are that module's own code.
//
// Run by hand and commit the diff, like `bun run print-tiers`: the nightly import cannot touch
// committed code. A table change moves a stored bit, so it ships with a STORE_CONTENT_GENERATION
// bump.

import { readFileSync, writeFileSync } from "node:fs";
import {
	type ApiCard,
	ART_REPS_QUERY,
	acceptPage,
	checkSearchPage,
	newList,
	refuseRepeats,
	searchQuery,
} from "../src/import-is-lists";

const OUT = "engine/builder/src/art_reps.tsv";
const UA = "sylvan-librarian-cloudflare/generate-art-reps (the printing that represents each artwork)";
// api.scryfall.com asks for under 10 requests a second; /cards/search rate-limits well below that
// in practice, so this stays at two a second unless told to go slower.
const GAP_MS = Number(process.env.SCRYFALL_GAP_MS ?? 500);
/** What is kept of one representative. */
export interface Rep {
	set: string;
	collector_number: string;
	lang: string;
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One GET, with the pause and the 429 back-off every request here takes: the status and the parsed body. */
async function answer(url: string): Promise<{ status: number; body: unknown }> {
	for (;;) {
		const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
		await sleep(GAP_MS);
		if (res.status === 429) {
			await sleep(1000 * Number(res.headers.get("Retry-After") ?? 65));
			continue;
		}
		return { status: res.status, body: await res.json().catch(() => null) };
	}
}

/** The same, for an endpoint that is not a search: its body, or `null` on a 404. */
async function get<T>(url: string): Promise<T | null> {
	const { status, body } = await answer(url);
	if (status === 404) return null;
	if (status !== 200) throw new Error(`${url}: ${status} ${JSON.stringify(body).slice(0, 200)}`);
	return body as T;
}

/** Every set code Scryfall lists. */
async function readSets(): Promise<string[]> {
	const sets: string[] = [];
	let url: string | null = "https://api.scryfall.com/sets";
	while (url) {
		const page: { data: { code: string }[]; has_more?: boolean; next_page?: string } | null = await get(url);
		if (!page) throw new Error("/sets answered nothing");
		for (const set of page.data) sets.push(set.code);
		url = page.has_more && page.next_page ? page.next_page : null;
	}
	return sets;
}

/**
 * Every artwork's representative: the whole of `unique=art` over every card, oldest release
 * first. Asked page by page through the nightly's own request and checks (`searchQuery`,
 * `checkSearchPage`, `acceptPage`): each a page of a list, the totals agreeing from page to
 * page, as many rows as the total, no row twice — anything else throws and nothing is written.
 */
async function readReps(): Promise<Rep[]> {
	const reading = newList<ApiCard>(ART_REPS_QUERY, "art");
	while (!reading.done) {
		const url = `https://api.scryfall.com/cards/search${searchQuery(reading.q, "art", reading.page, "asc")}`;
		acceptPage(reading, checkSearchPage(reading.q, await answer(url)), (card) => card);
		if (reading.rows.length % 3500 === 0) console.log(`  ${reading.rows.length} of ${reading.total}`);
	}
	refuseRepeats(reading, (card) => card.id);
	return reading.rows.map(({ set, collector_number, lang }) => ({ set, collector_number, lang }));
}

/** A collector number that is a whole number as written — the ones a run can hold. */
const WHOLE = /^(0|[1-9][0-9]*)$/;

/**
 * One set's row tokens: its whole numbers as `first..last` runs (a lone number as itself), then
 * every other number as written, `@lang` after a row that is not English. Sorted, so the file
 * diffs by what changed.
 */
export function tokensOf(reps: readonly Rep[]): string[] {
	const whole: number[] = [];
	const rest: string[] = [];
	for (const { collector_number: cn, lang } of reps) {
		if (/[\s@]/.test(cn) || cn.includes("..") || cn === "")
			throw new Error(`a collector number the table cannot spell: ${JSON.stringify(cn)}`);
		if (lang === "en" && WHOLE.test(cn)) whole.push(Number(cn));
		else rest.push(lang === "en" ? cn : `${cn}@${lang}`);
	}
	whole.sort((a, b) => a - b);
	const tokens: string[] = [];
	for (let i = 0; i < whole.length; ) {
		let j = i;
		while (j + 1 < whole.length && (whole[j + 1] as number) <= (whole[j] as number) + 1) j++;
		tokens.push(i === j ? `${whole[i]}` : `${whole[i]}..${whole[j]}`);
		i = j + 1;
	}
	rest.sort();
	return [...tokens, ...new Set(rest)];
}

/** The table's text: a header, then one line per set — `set <TAB> tokens`, the tab kept for a set with none. */
export function tableOf(sets: readonly string[], reps: readonly Rep[], date: string): string {
	const bySet = new Map<string, Rep[]>();
	for (const set of sets) bySet.set(set, []);
	for (const rep of reps) {
		const rows = bySet.get(rep.set);
		if (rows) rows.push(rep);
		else bySet.set(rep.set, [rep]);
	}
	const lines = [...bySet]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([set, rows]) => `${set}\t${tokensOf(rows).join(" ")}`);
	const header = [
		`# GENERATED FILE - do not edit. Built by scripts/generate-art-reps.ts from api.scryfall.com, ${date}.`,
		"#",
		"# The printing that REPRESENTS each artwork under `unique=art`. set code <TAB> the collector",
		"# numbers of the set's rows that represent one: `first..last` a run of whole numbers, `number@lang`",
		"# a row that is not English. A set named here is answered by this table alone for every",
		"# printing released by the `@written` day; a later printing, and a set that is not named, fall",
		"# back to the debut rule. See art_reps.rs.",
		`# ${reps.length} artworks over ${bySet.size} sets.`,
		`@written\t${date}`,
	];
	return `${[...header, ...lines].join("\n")}\n`;
}

async function main(): Promise<void> {
	const load = arg("--load");
	let sets: string[];
	let reps: Rep[];
	if (load) {
		const kept = JSON.parse(readFileSync(load, "utf8")) as { sets: string[]; reps: Rep[] };
		({ sets, reps } = kept);
		console.log(`loaded ${reps.length} representatives and ${sets.length} sets from ${load}`);
	} else {
		sets = await readSets();
		console.log(`${sets.length} sets on api.scryfall.com`);
		reps = await readReps();
		const save = arg("--save");
		if (save) writeFileSync(save, JSON.stringify({ sets, reps }));
	}
	writeFileSync(OUT, tableOf(sets, reps, new Date().toISOString().slice(0, 10)));
	console.log(`Wrote ${OUT} — ${reps.length} artworks over ${new Set([...sets, ...reps.map((r) => r.set)]).size} sets`);
}

if (import.meta.main) await main();
