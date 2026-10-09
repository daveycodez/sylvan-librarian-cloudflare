// Copy the `is:` classes api.scryfall.com keeps as its own record — no field of a card object
// decides them — into the table the builder tags printings from
// (engine/builder/src/is_lists.tsv, read by engine/builder/src/is_lists.rs).
//
//   bun run is-lists -- --bulk all-cards.jsonl.gz              # ~1 h of paced requests
//   bun run is-lists -- --bulk all-cards.jsonl.gz --cache DIR  # keeps every answer; a rerun reads them
//
// `--bulk` is Scryfall's `all_cards` file (https://api.scryfall.com/bulk-data), downloaded the same
// day: every row of every language, which is what says how wide a key can be. Without it the file
// is downloaded to the cache directory.
//
// WHAT IS MEASURED, per value, always `unique=prints&include_extras=true&include_variations=true`
// (`searchQuery`, the nightly's own): a search leaves `variation: true` printings out unless it is
// asked for them, and a list read without them is short of them.
//
//   gateway lair     `is:V` must answer nothing (a 404 with no warning). Nothing is written.
//   beginner         must be the same printings as `intro` (both differences empty); a synonym.
//   invitational misprint intro jumpstart
//                    `is:V lang:any`, every row. A LIST OF PRINTINGS, written at the widest key
//                    that is exact: a whole set, a collector number in every language, or one
//                    language's row of it (`is:misprint` is a Spanish Serra Angel and not the
//                    Japanese one).
//   spellbook spikey `is:V lang:any`. A LIST OF CARDS, by oracle id: every printing in every
//                    language.
//   related          `is:related`. The rule is "some printing of the card carries `all_parts`";
//                    the list is the cards in the answer that the rule does not reach.
//   covered          `is:covered`, `-is:covered` and `-is:covered -lang:en`. The rule is the tier
//                    of the printing in its card's own order (ranks.rs `print_tier`, which reads
//                    print_tiers.tsv): everything outside the default tier is covered. The list
//                    is the rows where that rule and Scryfall's record differ, each way.
//
// A ROW SCRYFALL'S SEARCH DOES NOT HOLD is not evidence, so "the list lacks this row" is checked
// before it is written down as an exception: the row is asked for by set, number and language,
// and only one the search does return is listed `not`. THE VARIATIONS ARE NOT SUCH ROWS. The first
// table (2026-10-09) counted 122 rows of the bulk file "no search returns", 92 of them English,
// and they were exactly the `variation: true` printings — the `†` and `★` twins, Portal's `d`
// numbers — which the search holds and hides by default. Skipped as unindexed, they were tagged by
// rule alone: none of the 36 that are `is:misprint` was, and four were on the wrong side of
// `is:covered`. Read with them the same day, every row of the bulk file is in an answer (0 rows
// "no search returns"). The probe stays for a row that really is in none — a card object newer or
// older than the bulk file.
//
// IT STOPS on a shape it does not understand: a value that should answer nothing and answers, a
// synonym that is no longer one, a list that is not exact at any key, a key holding a tab or a
// space, an answer that is not a whole list (a page that is not one, a list that moved while it
// was read, a row twice). It writes nothing then.
//
// THE NIGHTLY IMPORT REFRESHES THIS TABLE WITHOUT IT (src/import-is-lists.ts): it reads the small
// lists whole and `covered` and `related` set by set, where a set's printings moved, and hands the
// builder the result over the compiled table. What an answer must be to count as a list is the
// same code here and there — `checkSearchPage`, `acceptPage`, `refuseRepeats` — and this script
// remains the WHOLE measurement, the only one that holds every row against the bulk file: run it
// when the night's log line says rows moved in sets whose count did not, and from time to time
// regardless. Committing its table starts the nightly's state over from it.
//
// Run by hand and commit the diff, like `bun run print-tiers`. A change here changes what a
// deploy's build tags, so it ships with a STORE_CONTENT_GENERATION bump. RUN IT AFTER
// `bun run print-tiers` WHENEVER THAT TABLE CHANGES: `covered` is written as differences from the
// tier rule, and the builder refuses a table whose recorded fingerprint of print_tiers.tsv is not
// the one it compiled with.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import {
	type ApiCard,
	acceptPage,
	byNumber,
	checkLine,
	checkSearchPage,
	fnv1a64,
	ListRefused,
	newList,
	oraclesOf,
	refuseRepeats,
	type SearchAnswer,
	searchQuery,
} from "../src/import-is-lists";
import { defaultTier, isVariant, type Row as TierRow } from "./generate-print-tiers";

const OUT = "engine/builder/src/is_lists.tsv";
const TIERS = "engine/builder/src/print_tiers.tsv";
const UA = "sylvan-librarian-cloudflare/generate-is-lists (the is: classes no card field decides)";
const GAP_MS = Number(process.env.SCRYFALL_GAP_MS ?? 2200);
const SEARCH = "https://api.scryfall.com/cards/search";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Stop extends Error {}
function stop(message: string): never {
	throw new Stop(message);
}

// ── requests ─────────────────────────────────────────────────────────────────────────────────────

/** One answer, as the shared checks read it (src/import-is-lists.ts): the status and the parsed body. */
type Answer = SearchAnswer & { body: { code?: string; warnings?: string[] } | null };

const cacheDir = arg("--cache");
let lastRequest = 0;

async function get(url: string): Promise<Answer> {
	const path = cacheDir ? join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`) : null;
	if (path && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Answer;
	for (let attempt = 0; ; attempt++) {
		await sleep(Math.max(0, GAP_MS - (Date.now() - lastRequest)));
		const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
		lastRequest = Date.now();
		if (res.status === 429 || res.status >= 500) {
			if (attempt >= 5) stop(`${url}: ${res.status} six times`);
			await sleep((Number(res.headers.get("retry-after")) || 60) * 1000 + 1000);
			continue;
		}
		// A body that is not JSON is kept as null: the shared check refuses it by name.
		const answer: Answer = { status: res.status, body: (await res.json().catch(() => null)) as Answer["body"] };
		if (path) writeFileSync(path, JSON.stringify({ url, ...answer, at: new Date().toISOString() }));
		return answer;
	}
}

/** Page 1 of `q`: every printing, extras in. */
function searchUrl(q: string): string {
	return `${SEARCH}${searchQuery(q)}`;
}

/**
 * Every row a query answers; an empty list for Scryfall's plain no-match. The pages are asked for
 * by number and checked by the code the nightly refresh uses: each a page of a list, the totals
 * agreeing from page to page, as many rows as the total, no row twice.
 */
async function list(q: string): Promise<ApiCard[]> {
	const reading = newList<ApiCard>(q);
	while (!reading.done) {
		const page = checkSearchPage(q, await get(`${SEARCH}${searchQuery(q, "prints", reading.page)}`));
		acceptPage(reading, page, (card) => card);
		if (reading.rows.length % 5250 < 175 && !reading.done)
			console.log(`  ${q}: ${reading.rows.length} of ${page.total} rows`);
	}
	refuseRepeats(reading, (card) => card.id);
	return reading.rows;
}

/** A query's `total_cards`, from its first page alone. */
async function total(q: string): Promise<number> {
	return checkSearchPage(q, await get(searchUrl(q))).total;
}

/** Does Scryfall's search return this row at all? */
async function indexed(row: { id: string; set: string; collector_number: string; lang: string }): Promise<boolean> {
	const rows = await list(`e:${row.set} cn:"${row.collector_number}" lang:${row.lang}`);
	return rows.some((c) => c.id === row.id);
}

// ── the corpus ───────────────────────────────────────────────────────────────────────────────────

interface Card {
	id: string;
	set: string;
	number: string;
	lang: string;
	name: string;
	/** The card's oracle ids, the front's (or its own) first. */
	oracles: string[];
	hasParts: boolean;
	tier: number;
}

function readTiers(): Map<string, number> {
	const tiers = new Map<string, number>();
	for (const line of readFileSync(TIERS, "utf8").split("\n")) {
		if (!line || line.startsWith("#")) continue;
		const [set, tier] = line.split("\t");
		tiers.set(set as string, Number(tier));
	}
	return tiers;
}

/** `print_tier` in engine/builder/src/ranks.rs, kept the same by hand. */
function printTier(c: TierRow & { oversized?: boolean }, tiers: ReadonlyMap<string, number>): number {
	const setTier = tiers.get(c.set) ?? defaultTier(c.set_type);
	if (setTier === 2 || c.border_color === "gold" || c.oversized) return 2;
	if (c.lang !== "en" || setTier === 1) return 1;
	return isVariant(c) ? 1 : 0;
}

async function bulkPath(): Promise<string> {
	const given = arg("--bulk");
	if (given) return given;
	if (!cacheDir) stop("pass --bulk <all-cards.jsonl.gz>, or --cache <dir> to download it there");
	const path = join(cacheDir, "all-cards.jsonl.gz");
	if (existsSync(path)) return path;
	const res = await fetch("https://api.scryfall.com/bulk-data", {
		headers: { "User-Agent": UA, Accept: "application/json" },
	});
	const listing = (await res.json()) as { data?: { type: string; jsonl_download_uri?: string }[] };
	const uri = listing.data?.find((d) => d.type === "all_cards")?.jsonl_download_uri;
	if (!uri) stop("the bulk-data listing names no JSONL all_cards file");
	console.log(`downloading ${uri}`);
	await Bun.write(path, await fetch(uri));
	return path;
}

async function readCorpus(path: string, tiers: ReadonlyMap<string, number>): Promise<Card[]> {
	const cards: Card[] = [];
	const decoder = new StringDecoder("utf8");
	let rest = "";
	const take = (line: string) => {
		if (!line.trim()) return;
		const c = JSON.parse(line) as TierRow & ApiCard & { all_parts?: unknown[]; oversized?: boolean };
		if (/\s/.test(c.set) || /\s/.test(c.collector_number) || /\s/.test(c.lang)) {
			stop(`${c.set}/${c.collector_number}/${c.lang}: whitespace in a key`);
		}
		cards.push({
			id: c.id,
			set: c.set,
			number: c.collector_number,
			lang: c.lang,
			name: c.name,
			oracles: oraclesOf(c),
			hasParts: (c.all_parts?.length ?? 0) > 0,
			tier: printTier(c, tiers),
		});
	};
	// Split on `\n` alone: JSON allows a raw U+2028 inside a string, and flavor text has them.
	for await (const chunk of createReadStream(path).pipe(createGunzip())) {
		const lines = (rest + decoder.write(chunk as Buffer)).split("\n");
		rest = lines.pop() as string;
		for (const line of lines) take(line);
	}
	take(rest + decoder.end());
	return cards;
}

// ── the table ────────────────────────────────────────────────────────────────────────────────────

type Kind = "set" | "oracle" | "print" | "row" | "not" | "not-row";
const KIND_ORDER: Kind[] = ["set", "oracle", "print", "row", "not", "not-row"];

/** One value's entries: `set` codes, `oracle` ids (with the card's name), and numbers by set (and language). */
class Entries {
	readonly sets = new Set<string>();
	readonly oracles = new Map<string, string>();
	/** kind → `set` or `set\tlang` → numbers. */
	readonly numbers = new Map<Kind, Map<string, Set<string>>>();

	add(kind: "print" | "not", set: string, number: string): void;
	add(kind: "row" | "not-row", set: string, number: string, lang: string): void;
	add(kind: Kind, set: string, number: string, lang?: string): void {
		const byKey = this.numbers.get(kind) ?? new Map<string, Set<string>>();
		this.numbers.set(kind, byKey);
		const key = lang === undefined ? set : `${set}\t${lang}`;
		byKey.set(key, (byKey.get(key) ?? new Set()).add(number));
	}

	/** Whether the entries tag a row, or null where they say nothing — is_lists.rs `Verdicts`. */
	verdict(c: Card): boolean | null {
		const has = (kind: Kind, key: string) => this.numbers.get(kind)?.get(key)?.has(c.number) ?? false;
		if (has("not-row", `${c.set}\t${c.lang}`)) return false;
		if (has("row", `${c.set}\t${c.lang}`)) return true;
		if (has("not", c.set)) return false;
		if (has("print", c.set)) return true;
		if (this.sets.has(c.set) || c.oracles.some((id) => this.oracles.has(id))) return true;
		return null;
	}

	lines(tag: string): string[] {
		const out: string[] = [];
		for (const set of [...this.sets].sort()) out.push(`${tag}\tset\t${set}`);
		for (const [id, name] of [...this.oracles].sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			out.push(`${tag}\toracle\t${id}\t${name}`);
		}
		for (const kind of KIND_ORDER) {
			for (const [key, numbers] of [...(this.numbers.get(kind) ?? [])].sort(([a], [b]) => (a < b ? -1 : 1))) {
				out.push(`${tag}\t${kind}\t${key}\t${[...numbers].sort(byNumber).join(" ")}`);
			}
		}
		return out;
	}
}

interface Corpus {
	cards: Card[];
	byId: Map<string, Card>;
	bySet: Map<string, Card[]>;
	byPrint: Map<string, Card[]>;
}

const printKey = (c: { set: string; number: string }) => `${c.set}\t${c.number}`;

/** Rows the search does not return, found while checking exceptions. Counted in the header. */
const unindexed = new Set<string>();

async function isIndexed(c: Card): Promise<boolean> {
	if (unindexed.has(c.id)) return false;
	const yes = await indexed({ id: c.id, set: c.set, collector_number: c.number, lang: c.lang });
	if (!yes) unindexed.add(c.id);
	return yes;
}

/** STOP unless `entries` (over `rule`, where they say nothing) tag exactly `positives` of the corpus. */
function selfCheck(
	tag: string,
	corpus: Corpus,
	entries: Entries,
	positives: ReadonlySet<string>,
	rule: (c: Card) => boolean,
): void {
	let [missing, extra] = [0, 0];
	for (const c of corpus.cards) {
		if (unindexed.has(c.id)) continue;
		const tagged = entries.verdict(c) ?? rule(c);
		if (tagged && !positives.has(c.id)) extra++;
		if (!tagged && positives.has(c.id)) missing++;
	}
	if (missing || extra) stop(`is:${tag}: the table is not exact — ${missing} rows missing, ${extra} extra`);
}

/** A list of PRINTINGS: whole sets, then numbers in every language, then single rows. */
async function printingList(tag: string, corpus: Corpus): Promise<{ entries: Entries; rows: number }> {
	const rows = await list(`is:${tag} lang:any`);
	if (!rows.length) stop(`is:${tag} answers nothing`);
	const positives = new Set(rows.map((r) => r.id));
	const entries = new Entries();
	const inSet = new Map<string, number>();
	for (const r of rows) inSet.set(r.set, (inSet.get(r.set) ?? 0) + 1);
	for (const [set, count] of inSet) {
		const all = corpus.bySet.get(set) ?? [];
		// A set is listed whole when nearly all of it answers and what does not is rows the search
		// does not hold; a row it does hold is named `not-row`.
		if (count < 0.9 * all.length) continue;
		entries.sets.add(set);
		for (const c of all) {
			if (!positives.has(c.id) && (await isIndexed(c))) entries.add("not-row", c.set, c.number, c.lang);
		}
	}
	const seen = new Set<string>();
	for (const r of rows) {
		if (entries.sets.has(r.set)) continue;
		const key = printKey({ set: r.set, number: r.collector_number });
		if (seen.has(key)) continue;
		seen.add(key);
		const all = corpus.byPrint.get(key) ?? [];
		if (all.length && all.every((c) => positives.has(c.id))) entries.add("print", r.set, r.collector_number);
		else
			for (const row of rows)
				if (row.set === r.set && row.collector_number === r.collector_number)
					entries.add("row", row.set, row.collector_number, row.lang);
	}
	selfCheck(tag, corpus, entries, positives, () => false);
	return { entries, rows: rows.length };
}

/** A list of CARDS, by oracle id. */
async function cardList(tag: string, corpus: Corpus): Promise<{ entries: Entries; rows: number }> {
	const rows = await list(`is:${tag} lang:any`);
	if (!rows.length) stop(`is:${tag} answers nothing`);
	const positives = new Set(rows.map((r) => r.id));
	const entries = new Entries();
	for (const r of rows) for (const id of oraclesOf(r)) entries.oracles.set(id, r.name);
	for (const c of corpus.cards) {
		if (positives.has(c.id) || !c.oracles.some((id) => entries.oracles.has(id))) continue;
		if (await isIndexed(c)) entries.add("not-row", c.set, c.number, c.lang);
	}
	selfCheck(tag, corpus, entries, positives, () => false);
	return { entries, rows: rows.length };
}

/** `is:related`: the cards whose printings carry no `all_parts` anywhere, and are in it all the same. */
async function relatedList(corpus: Corpus): Promise<{ entries: Entries; rows: number }> {
	const rows = await list("is:related");
	const keys = new Set(rows.map((r) => printKey({ set: r.set, number: r.collector_number })));
	const positives = new Set<string>();
	for (const c of corpus.cards) if (keys.has(printKey(c))) positives.add(c.id);
	// The default search answers one row per printing; `lang:any` must be every language's row
	// of the same printings, or the key is not the printing.
	const everyLanguage = await total("is:related lang:any");
	if (Math.abs(everyLanguage - positives.size) > 0.0005 * everyLanguage) {
		stop(
			`is:related lang:any is ${everyLanguage} rows; every language of the default answer's printings is ${positives.size}`,
		);
	}
	const withParts = new Set<string>();
	for (const c of corpus.cards) if (c.hasParts && c.oracles[0]) withParts.add(c.oracles[0]);
	const rule = (c: Card) => c.oracles[0] !== undefined && withParts.has(c.oracles[0]);
	const entries = new Entries();
	for (const c of corpus.cards) {
		if (positives.has(c.id) && !rule(c) && c.oracles[0]) entries.oracles.set(c.oracles[0], c.name);
	}
	const asked = new Set<string>();
	for (const c of corpus.cards) {
		if (positives.has(c.id) || !(entries.verdict(c) ?? rule(c)) || asked.has(printKey(c))) continue;
		asked.add(printKey(c));
		// One row answers for its printing: the English one where there is one.
		const all = corpus.byPrint.get(printKey(c)) ?? [c];
		const probe = all.find((x) => x.lang === "en") ?? c;
		if (await isIndexed(probe)) entries.add("not", c.set, c.number);
		else for (const x of all) unindexed.add(x.id);
	}
	selfCheck("related", corpus, entries, positives, rule);
	return { entries, rows: everyLanguage };
}

/** `is:covered`: where the tier rule and Scryfall's record differ. */
async function coveredList(corpus: Corpus): Promise<{ entries: Entries; rows: number }> {
	const covered = new Set((await list("is:covered")).map((r) => r.id));
	const uncovered = new Set((await list("-is:covered")).map((r) => r.id));
	for (const r of await list("-is:covered -lang:en")) uncovered.add(r.id);
	// A row neither default-scope answer holds: an English one is a row the search does not
	// return at all; one in another language is covered unless the third answer names it.
	const positives = new Set<string>();
	for (const c of corpus.cards) {
		if (uncovered.has(c.id)) continue;
		if (covered.has(c.id) || c.lang !== "en") positives.add(c.id);
		else unindexed.add(c.id);
	}
	const everyLanguage = await total("is:covered lang:any");
	if (Math.abs(everyLanguage - positives.size) > 0.0005 * everyLanguage) {
		stop(`is:covered lang:any is ${everyLanguage} rows; the three answers make it ${positives.size}`);
	}
	const rule = (c: Card) => c.tier !== 0;
	const entries = new Entries();
	for (const c of corpus.cards) {
		if (unindexed.has(c.id) || rule(c) === positives.has(c.id)) continue;
		entries.add(positives.has(c.id) ? "row" : "not-row", c.set, c.number, c.lang);
	}
	selfCheck("covered", corpus, entries, positives, rule);
	return { entries, rows: everyLanguage };
}

async function main(): Promise<void> {
	if (cacheDir) mkdirSync(cacheDir, { recursive: true });
	const tiers = readTiers();
	const cards = await readCorpus(await bulkPath(), tiers);
	const corpus: Corpus = { cards, byId: new Map(), bySet: new Map(), byPrint: new Map() };
	for (const c of cards) {
		corpus.byId.set(c.id, c);
		corpus.bySet.set(c.set, [...(corpus.bySet.get(c.set) ?? []), c]);
		corpus.byPrint.set(printKey(c), [...(corpus.byPrint.get(printKey(c)) ?? []), c]);
	}
	console.log(`${cards.length} rows of every language read`);

	for (const value of ["gateway", "lair"]) {
		const { status, body } = await get(searchUrl(`is:${value}`));
		if (status !== 404 || body?.code !== "not_found" || body.warnings) {
			stop(`is:${value} answered ${status}${body?.warnings ? " with a warning" : ""}: it is no longer the empty class`);
		}
	}
	for (const q of ["is:beginner -is:intro", "is:intro -is:beginner"]) {
		if ((await list(q)).length) stop(`${q} is not empty: beginner is no longer intro`);
	}

	const measured: [string, { entries: Entries; rows: number }][] = [
		["covered", await coveredList(corpus)],
		["intro", await printingList("intro", corpus)],
		["invitational", await printingList("invitational", corpus)],
		["jumpstart", await printingList("jumpstart", corpus)],
		["misprint", await printingList("misprint", corpus)],
		["related", await relatedList(corpus)],
		["spellbook", await cardList("spellbook", corpus)],
		["spikey", await cardList("spikey", corpus)],
	];

	const day = new Date().toISOString().slice(0, 10);
	const header = [
		`# GENERATED FILE - do not edit. Built by scripts/generate-is-lists.ts from api.scryfall.com, ${day}.`,
		"#",
		"# The `is:` classes that are Scryfall's own record. tag <TAB> kind <TAB> key ...; see is_lists.rs.",
		"#   set      <set>                    every printing of the set",
		"#   oracle   <oracle id> <name>       every printing of the card",
		"#   print    <set> <numbers>          these collector numbers, in every language",
		"#   row      <set> <lang> <numbers>   these collector numbers, in this language alone",
		"#   not      <set> <numbers>          out, whatever a set, a card or the rule says",
		"#   not-row  <set> <lang> <numbers>   out in this language alone",
		"# `related` and `covered` are a rule and its exceptions: only the differences are here.",
		"#",
		...measured.map(([tag, m]) => `# ${tag}: ${m.rows} rows of every language on api.scryfall.com`),
		`# ${unindexed.size} rows of the bulk file no search returns were not counted either way.`,
		`# print_tiers.tsv ${fnv1a64(readFileSync(TIERS))}`,
	];
	const lines = measured.flatMap(([tag, m]) => m.entries.lines(tag));
	lines.forEach(checkLine);
	writeFileSync(OUT, `${[...header, ...lines].join("\n")}\n`);
	console.log(`Wrote ${OUT} — ${lines.length} lines; ${unindexed.size} unindexed rows ignored`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		// Its own stops, and an answer the shared checks refused as not being a whole list.
		if (!(error instanceof Stop) && !(error instanceof ListRefused)) throw error;
		console.error(`STOPPED, nothing written: ${error.message}`);
		process.exit(1);
	}
}
