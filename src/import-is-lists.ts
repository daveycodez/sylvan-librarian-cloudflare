// The `is:` lists that are Scryfall's own record, REFRESHED WITH THE NIGHTLY STORE BUILD.
//
// Eight values of `is:` are answered from a list api.scryfall.com keeps and no field of a card
// decides: `covered`, `intro`, `invitational`, `jumpstart`, `misprint`, `related`, `spellbook`
// and `spikey`. The builder tags them from a table compiled into it
// (engine/builder/src/is_lists.tsv, written by `bun run is-lists`), exact on the day it was
// measured and drifting from then on. This module is what the nightly import runs BEFORE its
// first row to bring that table to tonight (the `is_lists` phase of src/import-coordinator.ts),
// and it holds the answer checks `bun run is-lists` shares with it.
//
// ── WHAT IS ASKED, AND WHEN ────────────────────────────────────────────────────────────────────
//
// A whole refetch of the eight lists is ~870 pages of 175 — an hour at a polite pace, every
// night, from each of two accounts. So the night asks for the FIRST page of what is small, reads
// the list's size off it (`total_cards`), and goes on only where something moved:
//
//   intro invitational jumpstart misprint      `is:V lang:any`, rows. Refetched whole when the
//                                              total moved, and every IS_LISTS_REFETCH_DAYS
//                                              regardless (a list can swap a member for another
//                                              and keep its size: that is the bound on it).
//                                              A list that fits one page is whole on its probe.
//   spellbook spikey                           `is:V`, one row a CARD (unique=cards): 5 pages
//                                              where every language's rows are 86. Same rule.
//   covered, rows not in English               `-is:covered -lang:en`, 19 pages: every such row
//                                              is covered by the rule, so the answer IS the list.
//   covered in English, and related            BY SET: /sets says how many printings each set
//                                              holds, and a set whose count moved since it was
//                                              last read is read again — `e:S is:covered`,
//                                              `e:S -is:covered`, `e:S is:related` — and written
//                                              down ABSOLUTELY, every printing of it in or out,
//                                              so nothing here evaluates the tier rule. That
//                                              count (`card_count`) holds a set's VARIATIONS, and
//                                              so do the reads (`searchQuery`): `e:mkm` is 451
//                                              rows with them, as `/sets` says, and 440 without.
//                                              The first night reads the sets released in the
//                                              IS_LISTS_RECENT_DAYS before the compiled table was
//                                              measured and takes the rest as they stand.
//
// A change in a set whose count did NOT move — Scryfall re-tiering an old printing — is not read.
// It is SEEN: three more first pages give tonight's size of `is:covered lang:en`,
// `-is:covered lang:en` and `is:related`, the sets read tonight explain some of the movement since
// last night, and what they do not explain is said in the night's log line. `bun run is-lists`
// (the whole measurement, against the bulk file) is the remedy, and committing its table resets
// everything here: the state names the table it refines, and another table starts it over.
//
// ── WHAT A NIGHT COSTS (the free plan) ─────────────────────────────────────────────────────────
//
//   typical     11 requests: six list probes, one for the foreign rows, three sizes, /sets
//   a set moved +3 to +30 each (a 300-printing set is ~7; Secret Lair's 2,833 is ~30)
//   worst case  IS_LISTS_NIGHT_REQUESTS (240), whatever moved: what does not fit waits a night.
//               70 of them are the fixed part on the night everything is refetched whole.
//   variations  cost no request: 122 rows of the corpus, 36 of them in `misprint` (491 rows where a
//               default search shows 455, three pages either way) and none a row of another
//               language that is not covered; and a set's cost was already reckoned from
//               `card_count`, which counts them.
//   pacing      one request a second (IS_LISTS_GAP_MS; Scryfall asks for 50–100 ms and at most
//               ten a second), IS_LISTS_SLICE_REQUESTS (30) an alarm — under the 50 subrequests
//               an invocation gets — so at most 8 alarms and ~6 minutes of wall time, ~15 s on a
//               typical night; CPU is the JSON parse of each page, ~10 ms.
//   storage     one Durable Object row an alarm (the work in progress) and two at the end; one KV
//               read and one KV write a night (IS_LISTS_KV_KEY, the state every later night and
//               every deploy reads).
//
// ── NO GENERATION, AND WHAT A DEPLOY USES ──────────────────────────────────────────────────────
//
// A refreshed list changes stored `is:` tags with no code change, and needs no
// STORE_CONTENT_GENERATION for it: the nightly never asks whether its store is "new" — every run
// builds and publishes a whole family under a new `built_at`, the manifest is the commit point,
// `notify` moves every engine object onto it and `purge` drops the edge cache — so tonight's lists
// are served by tonight's store. The generation is what makes a DEPLOY rebuild (scripts/store-age.ts),
// and stays what it was: a bump goes with a change of code or of the committed table, as before.
// No stored layout changes either: the tags are the `card_is_tags` members generation 75 wrote.
//
// A deploy rebuilds the store whenever Scryfall's dumps are newer than the live one — most pushes.
// It asks Scryfall nothing; it reads this module's state back from KV and hands the builder the
// same table (scripts/is-lists-override.ts, `sylvan-store-builder --is-lists`), so a deploy's
// store and the nightly's differ by the dumps between them and not by eight values going back to
// the committed day. The manifest of either says which lists it was tagged from (`is_lists`).
//
// ── WHAT CANNOT HAPPEN ─────────────────────────────────────────────────────────────────────────
//
// A list is applied only WHOLE: every page of it answered, the totals agreeing page to page, as
// many rows as the total, no row twice, every key the shape the table can hold. Anything else —
// a failed request, a warning, a row without a set — refuses that one list and leaves it as it
// was last night (or as compiled), and the others go on. Three refusals, a 429, the request
// budget or the clock end the night's refresh; the build then runs with what was whole. Nothing
// in here can fail the import: the phase catches everything and moves on (stepIsLists).

/** The values the table may name, in the builder's order (is_lists.rs `LIST_TAGS`). */
export const LIST_TAGS = [
	"covered",
	"intro",
	"invitational",
	"jumpstart",
	"misprint",
	"related",
	"spellbook",
	"spikey",
] as const;
export type ListTag = (typeof LIST_TAGS)[number];

/** Lists of ROWS: `is:V lang:any`, each row in or out by itself. */
export const ROW_LISTS = ["intro", "invitational", "jumpstart", "misprint"] as const;
/** Lists of CARDS: every printing of an oracle id, asked one row a card. */
export const CARD_LISTS = ["spellbook", "spikey"] as const;
export type SmallList = (typeof ROW_LISTS)[number] | (typeof CARD_LISTS)[number];

/** Where the state lives in KV. No generation in the name, so retention never sweeps it. */
export const IS_LISTS_KV_KEY = "is-lists:state";

/** Requests one night may make, whatever moved. */
export const IS_LISTS_NIGHT_REQUESTS = 240;
/** Requests one alarm may make: under the free plan's 50 subrequests, with room for the alarm's own. */
export const IS_LISTS_SLICE_REQUESTS = 30;
/** Milliseconds between the starts of two requests. */
export const IS_LISTS_GAP_MS = 1000;
/** Wall time one alarm may spend asking before it banks its progress. */
export const IS_LISTS_SLICE_MS = 120_000;
/** Wall time from the night's first request after which the refresh stops and the build goes on. */
export const IS_LISTS_DEADLINE_MS = 15 * 60_000;
/** Refused lists after which the night stops asking. */
export const IS_LISTS_MAX_REFUSALS = 3;
/** A small list is refetched whole at least this often, moved or not. */
export const IS_LISTS_REFETCH_DAYS = 7;
/** On the first night: sets released this long before the compiled table was measured are read. */
export const IS_LISTS_RECENT_DAYS = 30;
/** The state must stay one KV value and one Durable Object row. */
export const IS_LISTS_STATE_MAX_BYTES = 1_500_000;
/** Scryfall's page size, for estimating what a set costs. */
export const SCRYFALL_PAGE_ROWS = 175;

// ── the answer checks, shared with scripts/generate-is-lists.ts ────────────────────────────────

/** A list that may not be used: the answer was not the shape a list has. */
export class ListRefused extends Error {}

export function refuse(message: string): never {
	throw new ListRefused(message);
}

/** 64-bit FNV-1a of bytes, as the builder computes it (is_lists.rs `fnv1a64`). */
export function fnv1a64(bytes: Uint8Array): string {
	// Two 32-bit halves: a BigInt per byte is ~100x slower, and this runs over the whole table.
	let hi = 0xcbf29ce4;
	let lo = 0x84222325;
	for (const byte of bytes) {
		lo = (lo ^ byte) >>> 0;
		// × 0x100000001b3 = × (2^40 + 0x1b3), mod 2^64: the low half times 0x1b3 carries into
		// the high half, and the low half's own bits land 8 up in it.
		const low = lo * 0x1b3;
		hi = (Math.imul(hi, 0x1b3) + Math.floor(low / 0x100000000) + ((lo << 8) >>> 0)) >>> 0;
		lo = low >>> 0;
	}
	return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/** Collector numbers in the table's order: by number, then by text. */
export function byNumber(a: string, b: string): number {
	const [x, y] = [Number.parseInt(a, 10), Number.parseInt(b, 10)];
	if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y;
	if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A card object's oracle ids, the front's (or its own) first. */
export function oraclesOf(c: { oracle_id?: string; card_faces?: { oracle_id?: string }[] }): string[] {
	const ids: string[] = [];
	for (const id of [c.oracle_id, ...(c.card_faces ?? []).map((f) => f.oracle_id)]) {
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** What a request answered: the status, the parsed body (null when it was not JSON), Retry-After in seconds. */
export interface SearchAnswer {
	status: number;
	body: unknown;
	retryAfter?: number;
}

/** The fields of a card object a list is made from. */
export interface ApiCard {
	id: string;
	oracle_id?: string;
	name: string;
	set: string;
	collector_number: string;
	lang: string;
	card_faces?: { oracle_id?: string }[];
	all_parts?: unknown[];
}

/**
 * `/cards/search`'s query string for page `page` of `q`: every printing, extras AND VARIATIONS in.
 *
 * A search leaves `variation: true` printings out unless `include_variations=true` is sent (or the
 * query names `is:variation`), and until 2026-10-09 this did not send it: the 122 variation rows
 * were in no answer, so `is:misprint is:variation lang:any` was 36 rows on api.scryfall.com and
 * none here, and a set's read was short of `/sets`' `card_count` by its variations (`e:mkm` 440
 * rows against 451; 451 with them). Every request of the night and of `bun run is-lists` is built
 * here, so a list, its size probe and a set's read are all the same scope.
 */
export function searchQuery(q: string, unique: "prints" | "cards" = "prints", page = 1): string {
	const params = new URLSearchParams({ q, unique, include_extras: "true", include_variations: "true" });
	if (page > 1) params.set("page", String(page));
	return `?${params}`;
}

/** One page of a search, checked. */
export interface SearchPage {
	rows: ApiCard[];
	total: number;
	hasMore: boolean;
}

/**
 * One answer of `/cards/search` as a page of a list, or REFUSED. Scryfall's plain no-match (a 404
 * `not_found` with no warning) is the empty list. Anything that is not a list, a list answered
 * with a warning (the query was not read as written), or a row without the four fields a key is
 * made of — or with whitespace in one, which the table's encoding cannot hold — is refused.
 */
export function checkSearchPage(q: string, answer: SearchAnswer): SearchPage {
	const { status } = answer;
	const body = (answer.body ?? {}) as {
		object?: unknown;
		code?: unknown;
		data?: unknown;
		has_more?: unknown;
		total_cards?: unknown;
		warnings?: unknown;
	};
	if (status === 404 && body.code === "not_found" && !body.warnings) return { rows: [], total: 0, hasMore: false };
	if (status !== 200 || body.object !== "list" || !Array.isArray(body.data)) {
		refuse(`${q}: ${status} ${JSON.stringify(answer.body ?? null).slice(0, 200)}`);
	}
	if (body.warnings) refuse(`${q}: answered with a warning: ${JSON.stringify(body.warnings).slice(0, 200)}`);
	const total = body.total_cards;
	if (typeof total !== "number" || !Number.isInteger(total) || total < body.data.length || body.data.length === 0) {
		refuse(`${q}: ${body.data.length} rows on a page of a list of ${JSON.stringify(total)}`);
	}
	if (typeof body.has_more !== "boolean") refuse(`${q}: a page that does not say whether there is another`);
	for (const c of body.data as Partial<ApiCard>[]) {
		const fields = [c?.id, c?.set, c?.collector_number, c?.lang];
		if (fields.some((f) => typeof f !== "string" || f === "")) refuse(`${q}: a row without id, set, number or lang`);
		if (fields.some((f) => /\s/.test(f as string))) {
			refuse(`${q}: whitespace in a key of ${c.set}/${c.collector_number}/${c.lang}`);
		}
		if (typeof c.name !== "string" || c.name === "" || /[\t\n\r]/.test(c.name)) {
			refuse(`${q}: ${c.set}/${c.collector_number} has no name the table can hold`);
		}
	}
	return { rows: body.data as ApiCard[], total, hasMore: body.has_more };
}

/** A list being read, page by page: resumable, because a night's alarm may end between two pages. */
export interface ListProgress<Row> {
	q: string;
	unique: "prints" | "cards";
	/** The next page to ask for, from 1. */
	page: number;
	/** The list's size, as its first page said; null before it. */
	total: number | null;
	rows: Row[];
	done: boolean;
}

export function newList<Row>(q: string, unique: "prints" | "cards" = "prints"): ListProgress<Row> {
	return { q, unique, page: 1, total: null, rows: [], done: false };
}

/**
 * Take one checked page into a list. REFUSED when the list moved while it was being read (a page
 * names another total than the first did), when a page says there is more after the total was
 * reached, and — on the last page — when the rows received are not the total.
 */
export function acceptPage<Row>(list: ListProgress<Row>, page: SearchPage, pick: (card: ApiCard) => Row): void {
	if (list.done) refuse(`${list.q}: a page after the last`);
	if (list.total !== null && page.total !== list.total) {
		refuse(`${list.q}: the list moved while it was read (${list.total} rows, then ${page.total})`);
	}
	list.total = page.total;
	for (const card of page.rows) list.rows.push(pick(card));
	list.page += 1;
	if (page.hasMore) {
		if (list.rows.length >= page.total) refuse(`${list.q}: more pages after all ${page.total} rows`);
		return;
	}
	if (list.rows.length !== page.total) {
		refuse(`${list.q}: ${list.rows.length} rows received of ${page.total}`);
	}
	list.done = true;
}

/** REFUSE a finished list that holds a row twice (a page served twice hides a row not served). */
export function refuseRepeats<Row>(list: ListProgress<Row>, keyOf: (row: Row) => string): void {
	const seen = new Set<string>();
	for (const row of list.rows) {
		const key = keyOf(row);
		if (seen.has(key)) refuse(`${list.q}: ${key.replaceAll("\t", "/")} is in the answer twice`);
		seen.add(key);
	}
}

/** `<tag> <kind> <key…> <numbers>` lines for numbers grouped under a key, keys and numbers in order. */
export function numberLines(tag: string, kind: string, byKey: Map<string, Set<string>>): string[] {
	return [...byKey]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, numbers]) => `${tag}\t${kind}\t${key}\t${[...numbers].sort(byNumber).join(" ")}`);
}

/** REFUSE a table line with an empty field: the builder reads fields by position. */
export function checkLine(line: string): string {
	if (line.split("\t").some((field) => field === "")) refuse(`an empty field: ${JSON.stringify(line)}`);
	return line;
}

// ── the compiled table, as the night reads it ──────────────────────────────────────────────────

/** What the night needs of the compiled table, small enough to ride in the work row. */
export interface CompiledBase {
	/** FNV-1a of the table's bytes: what an override's `# base` line names. */
	fingerprint: string;
	/** The day it was measured. */
	date: string;
	/** The print_tiers.tsv fingerprint its `covered` lines were measured against. */
	tiers: string;
	/** `is:V lang:any` rows per value on that day, from its header. */
	totals: Partial<Record<ListTag, number>>;
	/** Rows of its `covered not-row` lines in a language other than English. */
	foreignRows: number;
	/** Whether its `covered` and `related` lines are the kinds a set's lines can replace. */
	refinable: boolean;
	/** The card lists' own `not` and `not-row` lines: rows of a listed card that are out. */
	keep: Partial<Record<SmallList, string[]>>;
}

/** The compiled table's data lines by value, and its header's facts. */
export function readCompiled(tsv: string): { base: CompiledBase; lines: Record<ListTag, string[]> } {
	const lines = Object.fromEntries(LIST_TAGS.map((tag) => [tag, [] as string[]])) as Record<ListTag, string[]>;
	const totals: Partial<Record<ListTag, number>> = {};
	let tiers = "";
	let date = "";
	for (const line of tsv.split("\n")) {
		if (!line) continue;
		if (line.startsWith("#")) {
			const comment = line.slice(1).trim();
			const fingerprint = /^print_tiers\.tsv (\S+)$/.exec(comment);
			if (fingerprint) tiers = fingerprint[1] as string;
			const total = /^(\w+): (\d+) rows of every language/.exec(comment);
			if (total && (LIST_TAGS as readonly string[]).includes(total[1] as string)) {
				totals[total[1] as ListTag] = Number(total[2]);
			}
			const day = /api\.scryfall\.com, (\d{4}-\d{2}-\d{2})\.$/.exec(comment);
			if (day && !date) date = day[1] as string;
			continue;
		}
		const tag = line.slice(0, line.indexOf("\t"));
		if (!(LIST_TAGS as readonly string[]).includes(tag)) refuse(`the compiled table has a line of no value: ${line}`);
		lines[tag as ListTag].push(line);
	}
	if (!date || !tiers) refuse("the compiled table does not say when it was measured or against which tier table");
	let foreignRows = 0;
	let refinable = true;
	for (const line of lines.covered) {
		const [, kind, , lang, numbers] = line.split("\t");
		if ((kind !== "row" && kind !== "not-row") || !lang || !numbers) refinable = false;
		else if (lang !== "en") {
			if (kind !== "not-row") refinable = false;
			foreignRows += numbers.split(" ").length;
		}
	}
	for (const line of lines.related) {
		const kind = line.split("\t")[1];
		if (kind !== "oracle" && kind !== "print" && kind !== "not") refinable = false;
	}
	const keep: Partial<Record<SmallList, string[]>> = {};
	for (const tag of CARD_LISTS) {
		keep[tag] = lines[tag].filter((line) => ["not", "not-row"].includes(line.split("\t")[1] as string));
	}
	return {
		base: { fingerprint: fnv1a64(new TextEncoder().encode(tsv)), date, tiers, totals, foreignRows, refinable, keep },
		lines,
	};
}

// ── the state: what the nights have refreshed over one compiled table ──────────────────────────

/** One list as last read whole. */
export interface ListState {
	total: number;
	/** The night (YYYY-MM-DD) it was read. */
	fetched: string;
	lines: string[];
}

/** One set as last read. `count` null: owed a read (new, or put off for the night's budget). */
export interface SetState {
	count: number | null;
	fetched?: string;
	/** English rows covered and not, and printings related, when it was read. */
	cov?: number;
	unc?: number;
	rel?: number;
	lines?: string[];
}

export interface IsListsState {
	v: 1;
	/** The compiled table this refines (its fingerprint and day). Another table starts over. */
	base: string;
	baseDate: string;
	/** The last night the refresh ran to its end. */
	checked: string | null;
	lists: Partial<Record<SmallList, ListState>>;
	/** `-is:covered -lang:en`. */
	foreign?: ListState;
	/**
	 * The sizes of `is:covered lang:en`, `-is:covered lang:en` and `is:related` when last read, and
	 * `off`: how far they have moved since the first reading beyond what the sets read explain.
	 */
	sizes?: { night: string; coveredEn: number; uncoveredEn: number; related: number; off: [number, number, number] };
	/** Every set /sets has named. Empty before the first night that read /sets. */
	sets: Record<string, SetState>;
}

export function freshState(base: CompiledBase): IsListsState {
	return { v: 1, base: base.fingerprint, baseDate: base.date, checked: null, lists: {}, sets: {} };
}

/** A stored state, if it is one and refines this compiled table; else null (and the night starts over). */
export function usableState(stored: unknown, base: CompiledBase): IsListsState | null {
	const s = stored as Partial<IsListsState> | null;
	if (s?.v !== 1 || s.base !== base.fingerprint) return null;
	if (typeof s.lists !== "object" || s.lists === null || typeof s.sets !== "object" || s.sets === null) return null;
	return s as IsListsState;
}

/** Whether the state says anything the compiled table does not. */
export function refines(state: IsListsState): boolean {
	return (
		Object.keys(state.lists).length > 0 ||
		state.foreign !== undefined ||
		Object.values(state.sets).some((s) => s.lines !== undefined)
	);
}

/** What a store's manifest says about the lists it was tagged from (StoreManifest.is_lists). */
export interface IsListsNote {
	/** The day the compiled table under them was measured. */
	base: string | null;
	source: "compiled" | "nightly";
	/** The last night the refresh ran to its end. */
	checked?: string | null;
	/** The night each refreshed list was last read whole (`covered-foreign` for the foreign rows). */
	fetched?: Record<string, string>;
	/** Sets whose English `covered` and `related` lines were read from Scryfall, and the latest such night. */
	sets?: number;
	sets_fetched?: string;
}

export function noteOf(state: IsListsState | null, baseDate: string | null): IsListsNote {
	if (!state || !refines(state)) return { base: baseDate, source: "compiled", checked: state?.checked ?? null };
	const fetched: Record<string, string> = {};
	for (const [tag, list] of Object.entries(state.lists)) if (list) fetched[tag] = list.fetched;
	if (state.foreign) fetched["covered-foreign"] = state.foreign.fetched;
	const read = Object.values(state.sets).filter((s) => s.lines !== undefined && s.fetched);
	const note: IsListsNote = { base: state.baseDate, source: "nightly", checked: state.checked, fetched };
	if (read.length > 0) {
		note.sets = read.length;
		note.sets_fetched = read
			.map((s) => s.fetched as string)
			.sort()
			.at(-1);
	}
	return note;
}

/** A note in a sentence, for whoever asks what a store's lists are (scripts/store-age.ts). */
export function describeNote(note: IsListsNote): string {
	if (note.source !== "nightly") return `the compiled table of ${note.base ?? "an unrecorded day"}, never refreshed`;
	const lists = Object.entries(note.fetched ?? {})
		.map(([tag, night]) => `${tag} ${night}`)
		.join(", ");
	return (
		`the nightly's refresh of ${note.checked ?? "an unfinished night"} over the compiled table of ${note.base}` +
		(lists ? ` (read whole: ${lists})` : "") +
		(note.sets ? `; ${note.sets} set(s) read for covered and related, the latest ${note.sets_fetched}` : "")
	);
}

/**
 * The table the builder is handed: the compiled lines, with every list the state holds in place
 * of the compiled one. Null when the state refines nothing — the compiled table then stands, and
 * the store is byte for byte what it is without this module.
 *
 *   a small list      its lines replace the value's (a card list keeps the compiled `not` lines)
 *   covered, foreign  replaces the compiled `covered` lines of every language but English
 *   a set read        its `covered` lines replace the compiled English ones of that set; its
 *                     `related` lines are added, and being by printing they win over a card's
 */
export function composeOverride(compiledTsv: string, state: IsListsState): string | null {
	const { base, lines } = readCompiled(compiledTsv);
	if (state.base !== base.fingerprint) refuse(`the state refines table ${state.base}, not ${base.fingerprint}`);
	if (!refines(state)) return null;
	const out: Record<ListTag, string[]> = { ...lines };
	for (const tag of [...ROW_LISTS, ...CARD_LISTS]) {
		const list = state.lists[tag];
		if (list) out[tag] = list.lines;
	}
	const read = Object.entries(state.sets)
		.filter(([, s]) => s.lines !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : 1));
	if ((state.foreign || read.length > 0) && !base.refinable) {
		refuse("the compiled covered or related lines are of a kind a set's lines cannot replace");
	}
	const readSets = new Set(read.map(([code]) => code));
	out.covered = lines.covered.filter((line) => {
		const [, , set, lang] = line.split("\t");
		if (lang !== "en") return state.foreign === undefined;
		return !readSets.has(set as string);
	});
	if (state.foreign) out.covered.push(...state.foreign.lines);
	const related = new Set(lines.related);
	for (const [, set] of read) {
		for (const line of set.lines as string[]) {
			if (line.startsWith("covered\t")) out.covered.push(line);
			else related.add(line);
		}
	}
	out.related = [...related];
	const note = noteOf(state, base.date);
	const header = [
		`# OVERRIDE of is_lists.tsv (${base.date}), composed by src/import-is-lists.ts; checked ${state.checked ?? "never"}.`,
		`# base ${base.fingerprint}`,
		`# print_tiers.tsv ${base.tiers}`,
		`# meta ${JSON.stringify(note)}`,
	];
	const body = LIST_TAGS.flatMap((tag) => out[tag]).map(checkLine);
	return `${[...header, ...body].join("\n")}\n`;
}

// ── a night's work ─────────────────────────────────────────────────────────────────────────────

type Unit =
	| { kind: "list"; tag: SmallList }
	| { kind: "foreign" }
	| { kind: "sizes" }
	| { kind: "sets" }
	| { kind: "set"; code: string; count: number; fresh: boolean };

/** A row of an answer, as little of it as a line is made from. */
interface Got {
	/** set, collector number, language */
	s: string;
	n: string;
	l: string;
	/** The card carries `all_parts`. */
	p?: 1;
	/** Its oracle ids (the front's first) and name, where a line names the card. */
	o?: string[];
	m?: string;
}

const keyOf = (g: Got) => `${g.s}\t${g.n}\t${g.l}`;

/** The night's progress: one Durable Object row, rewritten once an alarm. */
export interface NightWork {
	v: 1;
	/** The UTC day the night began, and when. */
	night: string;
	startedMs: number;
	base: CompiledBase;
	/** The state as the finished units have left it. */
	state: IsListsState;
	queue: Unit[];
	/** The head unit's lists, read so far. */
	lists: ListProgress<Got>[] | null;
	requests: number;
	slices: number;
	refusals: number;
	/** Why the night stopped asking before its queue was empty. */
	stopped: string | null;
	/** What each unit came to, for the night's one log line. */
	notes: string[];
	/** Tonight's sizes, and what the sets read tonight moved by. */
	sizes: number[];
	explained: { cov: number; unc: number; rel: number; unknown: string[] };
	setsRead: string[];
	setsOwed: number;
	setsNamed: number;
}

/** UTC day of an instant. */
export function dayOf(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Begin a night over `compiledTsv`, from the state KV held (null: none, or one for another table). */
export function beginNight(compiledTsv: string, stored: unknown, nowMs: number): NightWork {
	const { base } = readCompiled(compiledTsv);
	const held = usableState(stored, base);
	const state = held ?? freshState(base);
	const queue: Unit[] = [...ROW_LISTS, ...CARD_LISTS].map((tag) => ({ kind: "list", tag }));
	if (base.refinable) queue.push({ kind: "foreign" }, { kind: "sizes" }, { kind: "sets" });
	const notes: string[] = [];
	if (stored && !held)
		notes.push(`the stored lists refine another table than this build's (${base.date}): starting over`);
	if (!base.refinable) notes.push("covered and related left as compiled (lines of a kind a set cannot replace)");
	return {
		v: 1,
		night: dayOf(nowMs),
		startedMs: nowMs,
		base,
		state,
		queue,
		lists: null,
		requests: 0,
		slices: 0,
		refusals: 0,
		stopped: null,
		notes,
		sizes: [],
		explained: { cov: 0, unc: 0, rel: 0, unknown: [] },
		setsRead: [],
		setsOwed: 0,
		setsNamed: 0,
	};
}

/** What a slice is run with: the caller paces `get` and owns the clock. */
export interface SliceEnv {
	/** GET `${apiUrl}${path}`. Throws on a transport failure. */
	get(path: string): Promise<SearchAnswer>;
	now(): number;
	/** Requests this slice may make, and when it must stop starting them. */
	maxRequests: number;
	deadlineMs: number;
}

/** The lists a unit reads. */
function listsOf(unit: Unit): ListProgress<Got>[] {
	switch (unit.kind) {
		case "list":
			return (CARD_LISTS as readonly string[]).includes(unit.tag)
				? [newList(`is:${unit.tag}`, "cards")]
				: [newList(`is:${unit.tag} lang:any`)];
		case "foreign":
			return [newList("-is:covered -lang:en")];
		case "sizes":
			return [newList("is:covered lang:en"), newList("-is:covered lang:en"), newList("is:related")];
		case "set":
			return [
				newList(`e:${unit.code} is:covered`),
				newList(`e:${unit.code} -is:covered`),
				newList(`e:${unit.code} is:related`),
			];
		case "sets":
			return [];
	}
}

function pick(unit: Unit, card: ApiCard): Got {
	const got: Got = { s: card.set, n: card.collector_number, l: card.lang };
	const named = (unit.kind === "list" && (CARD_LISTS as readonly string[]).includes(unit.tag)) || unit.kind === "set";
	if (named) {
		const ids = oraclesOf(card);
		if (ids.length === 0 || ids.some((id) => !/^[0-9a-f-]{36}$/.test(id))) {
			refuse(`${card.set}/${card.collector_number}: no oracle id the table can hold`);
		}
		got.o = unit.kind === "set" ? [ids[0] as string] : ids;
		got.m = card.name;
		if (Array.isArray(card.all_parts) && card.all_parts.length > 0) got.p = 1;
	}
	return got;
}

/** Every key a list's lines name, for counting what a refetch added and removed. */
function membersOf(lines: readonly string[]): Set<string> {
	const members = new Set<string>();
	for (const line of lines) {
		const fields = line.split("\t");
		const kind = fields[1];
		if (kind === "oracle" || kind === "set") members.add(`${kind}\t${fields[2]}`);
		else for (const n of (fields.at(-1) as string).split(" ")) members.add(`${fields.slice(1, -1).join("\t")}\t${n}`);
	}
	return members;
}

function moved(before: readonly string[] | undefined, after: readonly string[]): string {
	if (!before) return "first read";
	const [a, b] = [membersOf(before), membersOf(after)];
	let [added, removed] = [0, 0];
	for (const m of b) if (!a.has(m)) added++;
	for (const m of a) if (!b.has(m)) removed++;
	return `+${added} −${removed}`;
}

function rowLines(tag: string, kind: string, rows: readonly Got[]): string[] {
	const byKey = new Map<string, Set<string>>();
	for (const g of rows) byKey.set(`${g.s}\t${g.l}`, (byKey.get(`${g.s}\t${g.l}`) ?? new Set()).add(g.n));
	return numberLines(tag, kind, byKey);
}

function printLines(tag: string, kind: string, set: string, numbers: Iterable<string>): string[] {
	const all = new Set(numbers);
	return all.size > 0 ? numberLines(tag, kind, new Map([[set, all]])) : [];
}

function oracleLines(tag: string, rows: readonly Got[]): string[] {
	const names = new Map<string, string>();
	for (const g of rows) for (const id of g.o ?? []) if (!names.has(id)) names.set(id, g.m as string);
	return [...names]
		.sort(([a, x], [b, y]) => (x < y ? -1 : x > y ? 1 : a < b ? -1 : 1))
		.map(([id, name]) => `${tag}\toracle\t${id}\t${name}`);
}

/** A small list, read whole, into the state. */
function applyList(work: NightWork, tag: SmallList, list: ListProgress<Got>): void {
	if (list.rows.length === 0) refuse(`is:${tag} answers nothing`);
	refuseRepeats(list, keyOf);
	const isCards = (CARD_LISTS as readonly string[]).includes(tag);
	const lines = isCards
		? [...oracleLines(tag, list.rows), ...(work.base.keep[tag] ?? [])]
		: rowLines(tag, "row", list.rows);
	lines.forEach(checkLine);
	const before = work.state.lists[tag];
	work.notes.push(`${tag} ${moved(before?.lines, lines)} (${list.rows.length})`);
	work.state.lists[tag] = { total: list.rows.length, fetched: work.night, lines };
}

function applyForeign(work: NightWork, list: ListProgress<Got>): void {
	refuseRepeats(list, keyOf);
	if (list.rows.some((g) => g.l === "en")) refuse(`${list.q}: an English row in the answer`);
	const lines = rowLines("covered", "not-row", list.rows).map(checkLine);
	work.notes.push(`covered-foreign ${moved(work.state.foreign?.lines, lines)} (${list.rows.length})`);
	work.state.foreign = { total: list.rows.length, fetched: work.night, lines };
}

/** One set, read whole: every printing of it written in or out of `covered` (English) and `related`. */
function applySet(work: NightWork, unit: Extract<Unit, { kind: "set" }>, lists: ListProgress<Got>[]): void {
	const [covered, uncovered, related] = lists as [ListProgress<Got>, ListProgress<Got>, ListProgress<Got>];
	for (const list of lists) {
		refuseRepeats(list, keyOf);
		const stray = list.rows.find((g) => g.s.toLowerCase() !== unit.code.toLowerCase());
		if (stray) refuse(`${list.q}: a row of ${stray.s}`);
	}
	const all = new Map<string, Got>();
	for (const g of covered.rows) all.set(keyOf(g), g);
	for (const g of uncovered.rows) {
		if (all.has(keyOf(g))) refuse(`e:${unit.code}: ${g.s}/${g.n}/${g.l} is covered and not covered`);
		all.set(keyOf(g), g);
	}
	const inRelated = new Set<string>();
	for (const g of related.rows) {
		if (!all.has(keyOf(g))) refuse(`e:${unit.code}: ${g.s}/${g.n}/${g.l} is related and in neither half of the set`);
		inRelated.add(g.n);
	}
	const english = (rows: readonly Got[]) => rows.filter((g) => g.l === "en");
	const set = unit.code.toLowerCase();
	const lines = [
		...printLines(
			"covered",
			"row",
			`${set}\ten`,
			english(covered.rows).map((g) => g.n),
		),
		...printLines(
			"covered",
			"not-row",
			`${set}\ten`,
			english(uncovered.rows).map((g) => g.n),
		),
		// By printing, in every language: Scryfall's class is by card, so a printing's rows agree.
		...printLines("related", "print", set, inRelated),
		...printLines(
			"related",
			"not",
			set,
			[...all.values()].filter((g) => !inRelated.has(g.n)).map((g) => g.n),
		),
		// A related printing with no `all_parts` of its own: its card is related, wherever printed.
		...oracleLines(
			"related",
			related.rows.filter((g) => !g.p),
		),
	].map(checkLine);
	const now = { cov: english(covered.rows).length, unc: english(uncovered.rows).length, rel: related.rows.length };
	const before = work.state.sets[unit.code];
	const known = before?.fetched !== undefined || unit.fresh;
	if (known) {
		work.explained.cov += now.cov - (before?.cov ?? 0);
		work.explained.unc += now.unc - (before?.unc ?? 0);
		work.explained.rel += now.rel - (before?.rel ?? 0);
	} else work.explained.unknown.push(unit.code);
	work.state.sets[unit.code] = { count: unit.count, fetched: work.night, ...now, lines };
	work.setsRead.push(
		before?.fetched !== undefined
			? `${unit.code} (${before.cov}/${before.unc}/${before.rel} → ${now.cov}/${now.unc}/${now.rel})`
			: `${unit.code} (${now.cov}/${now.unc}/${now.rel})`,
	);
}

/** /sets: which sets hold another number of printings than when they were last read. */
function applySets(work: NightWork, answer: SearchAnswer): void {
	const body = (answer.body ?? {}) as { object?: unknown; data?: unknown; has_more?: unknown };
	if (answer.status !== 200 || body.object !== "list" || !Array.isArray(body.data) || body.data.length === 0) {
		refuse(`/sets: ${answer.status} ${JSON.stringify(answer.body ?? null).slice(0, 120)}`);
	}
	if (body.has_more === true) refuse("/sets: more than one page");
	const first = Object.keys(work.state.sets).length === 0;
	const recentFrom = Date.parse(`${work.base.date}T00:00:00Z`) - IS_LISTS_RECENT_DAYS * 86_400_000;
	const owed: { unit: Extract<Unit, { kind: "set" }>; released: string }[] = [];
	const named: { code: string; count: number; released: string }[] = [];
	for (const s of body.data as { code?: unknown; card_count?: unknown; released_at?: unknown }[]) {
		const { code, card_count: count } = s;
		if (typeof code !== "string" || !/^[a-z0-9]+$/i.test(code))
			refuse(`/sets: a set with the code ${JSON.stringify(code)}`);
		if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
			refuse(`/sets: ${code} holds ${count} cards`);
		named.push({ code, count, released: typeof s.released_at === "string" ? s.released_at : "9999-12-31" });
	}
	if (new Set(named.map((s) => s.code)).size !== named.length) refuse("/sets: a set twice");
	for (const { code, count, released } of named) {
		const before = work.state.sets[code];
		if (before !== undefined && before.count === count) continue;
		// A set first seen on a later night is new and its lines start from nothing; on the first
		// night only the recent ones are read, and the rest stand as the compiled table has them.
		const fresh = before === undefined && !first;
		const isOwed = before !== undefined || fresh || !(Date.parse(`${released}T00:00:00Z`) < recentFrom);
		if (!isOwed || count === 0) {
			work.state.sets[code] = { ...before, count };
			continue;
		}
		if (before === undefined) work.state.sets[code] = { count: null };
		owed.push({ unit: { kind: "set", code, count, fresh }, released });
	}
	// Newest first: when the budget does not reach them all, the sets still being printed are read.
	owed.sort((a, b) =>
		a.released < b.released ? 1 : a.released > b.released ? -1 : a.unit.code < b.unit.code ? -1 : 1,
	);
	work.queue.push(...owed.map((o) => o.unit));
	work.setsOwed = owed.length;
	work.setsNamed = named.length;
}

/** Requests a set's three lists take, at most: its printings twice over, and a page each to end on. */
function setCost(count: number): number {
	return 2 * Math.ceil(count / SCRYFALL_PAGE_ROWS) + 2;
}

/**
 * Run the night forward until its queue is empty, it stops, or this slice's requests or time are
 * spent. Returns true when the night is over. Never throws for anything a request answered: a
 * refused list is counted, noted and left as it was.
 */
export async function runSlice(work: NightWork, env: SliceEnv): Promise<boolean> {
	work.slices += 1;
	let asked = 0;
	const ask = async (path: string): Promise<SearchAnswer | null> => {
		if (env.now() - work.startedMs > IS_LISTS_DEADLINE_MS) {
			work.stopped = `${Math.round((env.now() - work.startedMs) / 60_000)} minutes in`;
			throw new ListRefused(work.stopped);
		}
		if (IS_LISTS_NIGHT_REQUESTS - work.requests <= 0) {
			work.stopped = `the night's ${IS_LISTS_NIGHT_REQUESTS} requests are spent`;
			throw new ListRefused(work.stopped);
		}
		if (asked >= env.maxRequests || env.now() >= env.deadlineMs) return null;
		asked += 1;
		work.requests += 1;
		const answer = await env.get(path);
		if (answer.status === 429) {
			work.stopped = `Scryfall answered 429 (Retry-After ${answer.retryAfter ?? "?"}s)`;
			throw new ListRefused(work.stopped);
		}
		return answer;
	};
	while (work.queue.length > 0 && work.stopped === null) {
		const unit = work.queue[0] as Unit;
		if (work.lists === null && unit.kind === "set" && setCost(unit.count) > IS_LISTS_NIGHT_REQUESTS - work.requests) {
			// Put off, not refused: its count stays owed, so the next night reads it first.
			work.queue.shift();
			continue;
		}
		const label = unit.kind === "list" ? unit.tag : unit.kind === "set" ? `e:${unit.code}` : unit.kind;
		try {
			if (unit.kind === "sets") {
				const answer = await ask("/sets");
				if (answer === null) return false;
				applySets(work, answer);
				work.queue.shift();
				continue;
			}
			work.lists ??= listsOf(unit);
			let unchanged = false;
			for (const list of work.lists) {
				// A size already read, when the slice before this one ended between two of them.
				if (unit.kind === "sizes" && list.total !== null) continue;
				while (!list.done) {
					const answer = await ask(`/cards/search${searchQuery(list.q, list.unique, list.page)}`);
					if (answer === null) return false;
					acceptPage(list, checkSearchPage(list.q, answer), (card) => pick(unit, card));
					// The sizes are their first pages' totals; nothing else of them is read.
					if (unit.kind === "sizes") break;
					// A list's first page is its probe: the same size as when it was last read
					// whole, and read recently enough, is left alone.
					if ((unit.kind === "list" || unit.kind === "foreign") && list.page === 2 && !list.done) {
						const before =
							unit.kind === "foreign" ? (work.state.foreign ?? foreignBase(work)) : listBase(work, unit.tag);
						if (
							before &&
							before.total === list.total &&
							daysBetween(before.fetched, work.night) < IS_LISTS_REFETCH_DAYS
						) {
							work.notes.push(`${unit.kind === "foreign" ? "covered-foreign" : unit.tag} = (${list.total})`);
							unchanged = true;
							break;
						}
					}
				}
				if (unchanged) break;
			}
			if (!unchanged) {
				if (unit.kind === "list") applyList(work, unit.tag, work.lists[0] as ListProgress<Got>);
				else if (unit.kind === "foreign") applyForeign(work, work.lists[0] as ListProgress<Got>);
				else if (unit.kind === "sizes") work.sizes = work.lists.map((l) => l.total ?? 0);
				else applySet(work, unit, work.lists);
			}
		} catch (err) {
			if (work.stopped === null) {
				work.refusals += 1;
				work.notes.push(`${label} REFUSED (${String(err instanceof Error ? err.message : err).slice(0, 160)})`);
				if (work.refusals >= IS_LISTS_MAX_REFUSALS) work.stopped = `${work.refusals} lists refused`;
			}
		}
		work.lists = null;
		work.queue.shift();
		if (JSON.stringify(work.state).length > IS_LISTS_STATE_MAX_BYTES) {
			work.stopped = "the refreshed lists have outgrown one stored value: run `bun run is-lists` and commit its table";
		}
	}
	return true;
}

/** What a row list is compared with before it was ever refetched: the compiled table's own size and day. */
function listBase(work: NightWork, tag: SmallList): { total: number; fetched: string } | undefined {
	const held = work.state.lists[tag];
	if (held) return held;
	const total = work.base.totals[tag];
	// The compiled header counts ROWS of every language: the size a row list's probe reads, and
	// not a card list's, which is read whole the first night.
	if ((CARD_LISTS as readonly string[]).includes(tag) || total === undefined) return undefined;
	return { total, fetched: work.base.date };
}

function foreignBase(work: NightWork): { total: number; fetched: string } {
	return { total: work.base.foreignRows, fetched: work.base.date };
}

/**
 * Tonight's sizes against the last reading: what moved, less what the sets read tonight moved by,
 * is movement in sets whose count did not move — printings Scryfall re-tiered, which nothing here
 * reads. It is carried in the state (`off`) from night to night, so a set put off tonight and
 * read tomorrow settles tomorrow, and it starts over whenever a set is read whose earlier counts
 * are not on record (its part of the movement cannot be told).
 */
function reconcile(work: NightWork): string | null {
	const state = work.state;
	const { cov, unc, rel, unknown } = work.explained;
	const [coveredEn, uncoveredEn, related] = work.sizes;
	if (coveredEn === undefined || uncoveredEn === undefined || related === undefined) {
		// Not read tonight: what the sets explained tonight cannot be set against anything later.
		if (state.sizes && (cov !== 0 || unc !== 0 || rel !== 0 || unknown.length > 0)) delete state.sizes;
		return null;
	}
	const sizes = `${coveredEn}/${uncoveredEn}/${related}`;
	const before = state.sizes;
	const next = { night: work.night, coveredEn, uncoveredEn, related, off: [0, 0, 0] as [number, number, number] };
	state.sizes = next;
	if (!before) return `sizes ${sizes} (the first on record)`;
	if (unknown.length > 0)
		return `sizes ${sizes} (not reconciled: ${unknown.slice(0, 4).join(", ")} read for the first time)`;
	next.off = [
		before.off[0] + coveredEn - before.coveredEn - cov,
		before.off[1] + uncoveredEn - before.uncoveredEn - unc,
		before.off[2] + related - before.related - rel,
	];
	const unread = work.setsNamed === 0 ? "/sets" : work.setsOwed - work.setsRead.length;
	if (unread !== 0)
		return `sizes ${sizes} (not reconciled yet: ${unread === "/sets" ? "/sets" : `${unread} set(s)`} unread)`;
	if (next.off.every((n) => n === 0)) return `sizes ${sizes} reconcile with the sets read`;
	return (
		`sizes ${sizes}: ${next.off[0]} covered and ${next.off[1]} uncovered English rows and ${next.off[2]} related ` +
		"printings MOVED IN SETS WHOSE COUNT DID NOT — not read; `bun run is-lists` measures them"
	);
}

/** Close a night that is over: stamp the state, and say in one line what was asked and what moved. */
export function closeNight(work: NightWork): { state: IsListsState; line: string } {
	const state = work.state;
	const ended = work.stopped === null && work.queue.length === 0;
	const parts = [...work.notes];
	if (work.setsNamed > 0) {
		const read = work.setsRead.length;
		const unread = work.setsOwed - read;
		const shown = work.setsRead.slice(0, 8).join(", ") + (read > 8 ? `, … +${read - 8}` : "");
		parts.push(
			`sets: ${work.setsOwed} of ${work.setsNamed} owed a read, ${read} read` +
				(read > 0 ? ` — ${shown} (English covered/not, related)` : "") +
				(unread > 0 ? `, ${unread} left for the next night` : ""),
		);
	}
	const sizes = reconcile(work);
	if (sizes) parts.push(sizes);
	if (ended) state.checked = work.night;
	const line =
		`Is lists: ${work.requests} requests in ${work.slices} slice(s)` +
		(work.stopped ? `, STOPPED (${work.stopped}; what was read whole is used, the rest is as it was)` : "") +
		` — ${parts.join("; ") || "nothing asked"}`;
	return { state, line };
}
