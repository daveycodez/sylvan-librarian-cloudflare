// Measure which TIER of a card's own printing order each set's plain English printings are in on
// api.scryfall.com, and write the sets that are not where their set type puts them to the table the
// builder's ranking reads (engine/builder/src/print_tiers.tsv).
//
//   bun run print-tiers                                  # harvests from api.scryfall.com (~15 min)
//   bun run print-tiers -- --save harvest.jsonl          # ...and keeps the harvest
//   bun run print-tiers -- --load harvest.jsonl[,more]   # re-reads a kept harvest, no network
//
// WHAT IS MEASURED. `unique=prints&order=name` returns a card's printings in Scryfall's own order,
// and that order is not one date-descending list but up to three, one after another — the default
// printings newest first, then every other printing newest first, then the ones nobody plays with
// (see engine/builder/src/ranks.rs for the whole order). Which list a printing is in is mostly its
// shape: a promo, a `boosterfun` treatment, a showcase frame, a language that is not English are
// all in the second. But the same plain black-bordered nonfoil reprint is in the first list in
// Tarkir: Dragonstorm Commander and in the second in Bloomburrow Commander, and no field of the
// card object says so — frame, finishes, games, stamp, promo types and set type are identical. It
// is Scryfall's record, kept per printing and all but constant per set, so it is measured per set.
//
// HOW. Every printing of every card printed eight times or more (`prints>=8 -t:basic`), and of
// every token, in Scryfall's order. A card's sequence is cut where the date RISES: each rise is a
// tier boundary, so three runs name all three tiers, and with two the rows of the first run dated
// before the second run's first row are certainly in the first tier (a second-tier row there would
// have sorted after it). Rows the sequence does not decide are not counted. A set's tier is the
// majority of its plain English rows' labels, and the table holds the sets where that is not the
// default for the set's type — the same default `set_tier` applies to a set nobody measured.
//
// Run by hand and commit the diff, like `bun run release-batches`: the nightly import cannot touch
// committed code. A table change moves stored ranks, so it ships with a STORE_CONTENT_GENERATION
// bump.

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "engine/builder/src/print_tiers.tsv";
const UA = "sylvan-librarian-cloudflare/generate-print-tiers (the tier of each set in a card's own print order)";
const GAP_MS = 500;
/** The harvest: enough reprints to place a set against its neighbours, and every token. */
const QUERIES = ["prints>=8 -t:basic", "is:token"];

/** The card-object fields the inference reads. */
export interface Row {
	id: string;
	oracle_id?: string;
	name: string;
	lang: string;
	set: string;
	set_type: string;
	collector_number: string;
	released_at: string;
	rarity: string;
	border_color: string;
	promo: boolean;
	digital: boolean;
	full_art: boolean;
	textless: boolean;
	oversized: boolean;
	games: string[];
	promo_types?: string[];
	frame_effects?: string[];
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the shape rule — `print_tier` in engine/builder/src/ranks.rs, kept the same by hand ─────────

const PLAIN_PROMO_TYPES = new Set([
	"beginnerbox",
	"brawldeck",
	"instore",
	"league",
	"planeswalkerdeck",
	"setextension",
	"setpromo",
	"startercollection",
	"starterdeck",
	"surgefoil",
	"universesbeyond",
]);
const VARIANT_FRAME_EFFECTS = new Set(["extendedart", "inverted", "showcase", "etched", "shatteredglass"]);
const DEFAULT_TIER_TYPES = new Set([
	"core",
	"expansion",
	"masters",
	"draft_innovation",
	"commander",
	"duel_deck",
	"planechase",
	"archenemy",
	"starter",
	"arsenal",
	"eternal",
	"funny",
	"token",
]);

/** A set's tier by its type alone: what `set_tier` answers for a set the table does not name. */
export function defaultTier(setType: string): number {
	if (setType === "memorabilia") return 2;
	return DEFAULT_TIER_TYPES.has(setType) ? 0 : 1;
}

/** Another printing's `SET-N` as a collector number — The List's shape. */
function reprintNumbered(cn: string): boolean {
	const dash = cn.indexOf("-");
	if (dash < 0) return false;
	if (/^\D/.test(cn)) return true;
	const head = cn.slice(0, dash);
	return /^[0-9A-Z]+$/.test(head) && /[A-Z]/.test(head) && /^\d/.test(cn.slice(dash + 1));
}

/** Does the printing's own shape put it outside the default tier, whatever its set? */
export function isVariant(c: Row): boolean {
	return (
		c.promo ||
		(c.promo_types ?? []).some((p) => !PLAIN_PROMO_TYPES.has(p) && !/^ff[ivx]+$/.test(p)) ||
		(c.frame_effects ?? []).some((f) => VARIANT_FRAME_EFFECTS.has(f)) ||
		(c.border_color !== "black" && c.border_color !== "white") ||
		c.full_art ||
		c.textless ||
		c.oversized ||
		(c.digital && !c.games.includes("mtgo")) ||
		(c.rarity === "special" && c.set_type === "masters") ||
		reprintNumbered(c.collector_number)
	);
}

// ── the inference ────────────────────────────────────────────────────────────────────────────────

/** A row that can only be second-tier: not English, a promo set, Secret Lair, The List. */
function neverLastTier(c: Row): boolean {
	return c.lang !== "en" || c.set_type === "promo" || c.set === "sld" || c.set === "plst";
}

/**
 * The tier of each row of ONE card's sequence where the sequence proves it, `null` where it does
 * not. Runs are maximal date-descending stretches. Three runs are tiers 0, 1, 2. Two are 0 and 1
 * when the second cannot be the last tier — it opens with a row that never is, or the first holds
 * a plain English core or expansion printing — and then a first-run row is certainly tier 0 only
 * if it is dated before the second run's first row, or sits above a row that is.
 */
export function certainTiers(seq: readonly Row[]): (number | null)[] {
	const run: number[] = [];
	let r = 0;
	seq.forEach((c, i) => {
		if (i > 0 && c.released_at > (seq[i - 1] as Row).released_at) r++;
		run.push(r);
	});
	const out: (number | null)[] = seq.map(() => null);
	const runs = r + 1;
	if (runs === 1) return out;
	const first1 = run.indexOf(1);
	const anchored = seq.some(
		(c, i) => run[i] === 0 && c.lang === "en" && !isVariant(c) && (c.set_type === "core" || c.set_type === "expansion"),
	);
	if (runs < 3 && !anchored && !neverLastTier(seq[first1] as Row)) return out;
	const boundary = (seq[first1] as Row).released_at;
	let lastSure = -1;
	seq.forEach((c, i) => {
		if (run[i] === 0 && c.released_at < boundary) lastSure = i;
	});
	let lastSecond = -1;
	seq.forEach((c, i) => {
		if (run[i] === 1 && neverLastTier(c)) lastSecond = i;
	});
	seq.forEach((_, i) => {
		if (run[i] === 0) out[i] = i <= lastSure ? 0 : null;
		else if (run[i] === 1) out[i] = runs >= 3 || i <= lastSecond ? 1 : null;
		else if (run[i] === 2) out[i] = 2;
	});
	return out;
}

/** set → how many of its plain English rows were proven to be in each tier. */
export function measure(rows: readonly Row[]): Map<string, { type: string; votes: [number, number, number] }> {
	const sets = new Map<string, { type: string; votes: [number, number, number] }>();
	let from = 0;
	const same = (a: Row, b: Row) => a.name === b.name && a.oracle_id === b.oracle_id;
	for (let i = 1; i <= rows.length; i++) {
		if (i < rows.length && same(rows[i] as Row, rows[from] as Row)) continue;
		const seq = rows.slice(from, i);
		from = i;
		certainTiers(seq).forEach((tier, k) => {
			const c = seq[k] as Row;
			if (tier === null || c.lang !== "en" || isVariant(c)) return;
			let entry = sets.get(c.set);
			if (!entry) {
				entry = { type: c.set_type, votes: [0, 0, 0] };
				sets.set(c.set, entry);
			}
			entry.votes[tier as 0 | 1 | 2]++;
		});
	}
	return sets;
}

// ── the harvest ──────────────────────────────────────────────────────────────────────────────────

async function harvest(query: string): Promise<Row[]> {
	const qs = new URLSearchParams({ q: query, unique: "prints", order: "name", include_extras: "true" });
	let url: string | null = `https://api.scryfall.com/cards/search?${qs}`;
	const rows: Row[] = [];
	while (url) {
		const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
		await sleep(GAP_MS);
		if (res.status === 429) {
			await sleep(65_000);
			continue;
		}
		const body = (await res.json()) as { data?: Row[]; has_more?: boolean; next_page?: string; total_cards?: number };
		if (!res.ok) throw new Error(`${query}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
		rows.push(...(body.data ?? []));
		if (rows.length % 1750 < 175) console.log(`  ${query}: ${rows.length} of ${body.total_cards ?? "?"} rows`);
		url = body.has_more && body.next_page ? body.next_page : null;
	}
	return rows;
}

function load(paths: string): Row[] {
	const rows: Row[] = [];
	for (const path of paths.split(",")) {
		// Split on `\n` alone: JSON allows a raw U+2028 inside a string, and flavor text has them.
		for (const line of readFileSync(path, "utf8").split("\n")) if (line) rows.push(JSON.parse(line) as Row);
	}
	return rows;
}

async function main(): Promise<void> {
	const from = arg("--load");
	let rows: Row[];
	if (from) {
		rows = load(from);
	} else {
		rows = [];
		for (const q of QUERIES) rows.push(...(await harvest(q)));
	}
	const save = arg("--save");
	if (save) writeFileSync(save, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

	const sets = measure(rows);
	const entries: string[] = [];
	let agree = 0;
	for (const [set, { type, votes }] of [...sets].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const tier = votes.indexOf(Math.max(...votes));
		if (tier === defaultTier(type)) agree++;
		else entries.push(`${set}\t${tier}`);
	}
	const header = [
		"# GENERATED FILE - do not edit. Built by scripts/generate-print-tiers.ts from api.scryfall.com.",
		"#",
		"# set code <TAB> tier: where a set's PLAIN English printings sit in a card's own order when that is",
		"# not what its set type says (0 = the default tier, 1 = after it, 2 = last). See ranks.rs.",
		`# ${rows.length} printings read, ${sets.size} sets measured, ${agree} of them where their type puts them.`,
	];
	writeFileSync(OUT, `${[...header, ...entries].join("\n")}\n`);
	console.log(`Wrote ${OUT} — ${entries.length} sets of ${sets.size} measured are not their type's tier`);
}

if (import.meta.main) await main();
