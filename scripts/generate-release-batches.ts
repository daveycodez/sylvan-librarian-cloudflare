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
// AND TWO PER PAIR THE SEQUENCE CANNOT SPLIT (2026-10-08). A batch boundary that falls where the
// code order continues is invisible in that sequence — `ced | cei` reads the same as `ced cei` —
// and `order=released` never needs it, because (batch, code) is the same order either way. Three
// other orders do: `prefer:newest` and `prefer:oldest`, which pick by (date, batch, Scryfall id),
// and the order of a card's own printings (`unique=prints order=name`), which runs the batches
// DESCENDING and the codes inside one ASCENDING. On 1993-12-10 they answer `cei` before `ced`; the
// two sets are two batches. So for every two sets of one alphabetical run that share a card, that
// card is asked BOTH `prefer:newest` and `prefer:oldest` across the pair. A boundary is the two
// answers DIFFERING — newest the later code, oldest the earlier. One answer alone says nothing:
// inside a batch both keep the row with the lowest id, in whichever set it is (`blc`/`mb2` on
// 2024-08-02: 14 shared cards, `mb2` kept 8 times and `blc` 6, identically under both; `eld`/`peld`
// on 2019-10-04: 68 shared cards, `peld` every time under newest and `eld` every time under oldest).
// 128 such pairs asked in the 2026-09-24 corpus, 25 of them a boundary; 148 and 27 in the
// 2026-10-10 one, the first read with a card counted for a set by its CANONICAL row (see
// `readDates`) — the two it added are `prm | sld` on 2020-07-31 and `pal06 | pmps06` on 2006-01-01,
// each with a set printed in Japanese alone.
//
// Run by hand after a store build and commit the diff, like `bun run set-dates`: the nightly import
// cannot touch committed code, and the table is only a snapshot of an order Scryfall does not
// promise to keep — `snc`/`psnc` on 2022-04-29 swapped between 2026-08-16 and 2026-09-25. A table
// change moves stored ranks, so it ships with a STORE_CONTENT_GENERATION bump.

import { createReadStream, writeFileSync } from "node:fs";

const OUT = "vendor/sylvan_librarian/card_engine/src/release_batches.tsv";
const UA = "sylvan-librarian-cloudflare/generate-release-batches (set order inside a release date)";
// api.scryfall.com asks for under 10 requests a second; /cards/search rate-limits well below that
// in practice (a 250ms gap drew a 429 on 2026-09-25), so this stays at two a second unless told
// to go slower.
const GAP_MS = Number(process.env.SCRYFALL_GAP_MS ?? 500);

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pick {
	rank: [number, number, number, string];
	cn: string;
}

/** One release date in the local store: the printing to ask each set for, and each set's cards. */
interface DateSets {
	picks: Map<string, Pick>;
	/** set → the oracle ids it prints on this date in a row a default search reads. */
	cards: Map<string, Set<string>>;
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
async function readDates(path: string): Promise<Map<string, DateSets>> {
	const dates = new Map<string, DateSets>();
	for await (const line of jsonLines(path)) {
		const row = JSON.parse(line) as {
			card_set_code?: string;
			collector_number?: string;
			released_at?: string | null;
			oracle_id?: string;
			is_canonical?: boolean;
			card_compat_blob?: { lang?: string };
		};
		const { card_set_code: set, collector_number: cn, released_at: date } = row;
		if (!set || !cn || !date || /["\s]/.test(cn)) continue;
		const english = row.card_compat_blob?.lang === "en";
		const rank: Pick["rank"] = [english ? 0 : 1, /^\d+$/.test(cn) ? 0 : 1, cn.length, cn];
		let sets = dates.get(date);
		if (!sets) {
			sets = { picks: new Map(), cards: new Map() };
			dates.set(date, sets);
		}
		const cur = sets.picks.get(set);
		if (!cur || before(rank, cur.rank)) sets.picks.set(set, { rank, cn });
		// THE CANONICAL ROW, NOT THE ENGLISH ONE. Which cards two sets share is asked so that the pair
		// can be probed, and the probe is a default search: it reads a printing's English row where
		// it has one and its only language where it has not. Counting English rows alone left a set
		// printed in one other language with no cards at all, so no pair with it was ever asked — and
		// the two the card order still had wrong were exactly those: Secret Lair's Japanese basics
		// (sld/63-67) ahead of Magic Online's promos on 2020-07-31, and the Japanese Magic Premiere
		// Shop lands (`pmps06`) ahead of the Arena League's (`pal06`) on 2006-01-01, each a boundary
		// both prefers name. A rows file written before `is_canonical` existed falls back to English.
		if ((row.is_canonical ?? english) && row.oracle_id) {
			let cards = sets.cards.get(set);
			if (!cards) {
				cards = new Set();
				sets.cards.set(set, cards);
			}
			cards.add(row.oracle_id);
		}
	}
	return dates;
}

/** One search, every page, with the pause and the 429 back-off every request here takes. */
async function search<T>(label: string, params: Record<string, string>): Promise<T[]> {
	const qs = new URLSearchParams(params);
	let url: string | null = `https://api.scryfall.com/cards/search?${qs}`;
	const out: T[] = [];
	while (url) {
		const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
		const body = (await res.json()) as { data?: T[]; has_more?: boolean; next_page?: string };
		await sleep(GAP_MS);
		if (res.status === 429) {
			await sleep(65_000);
			continue;
		}
		if (res.status === 404) break;
		if (!res.ok) throw new Error(`${label}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
		out.push(...(body.data ?? []));
		url = body.has_more && body.next_page ? body.next_page : null;
	}
	return out;
}

async function ask(date: string, sets: Map<string, Pick>): Promise<string[]> {
	const terms = [...sets].map(([set, { cn }]) => `(e:${set} cn:"${cn}")`).join(" or ");
	const cards = await search<{ set: string }>(date, {
		q: `date=${date} (${terms})`,
		unique: "prints",
		order: "released",
		dir: "asc",
		include_extras: "true",
		include_variations: "true",
	});
	const seq: string[] = [];
	for (const card of cards) {
		if (seq.at(-1) === card.set) continue;
		if (seq.includes(card.set)) throw new Error(`${date}: ${card.set} is not contiguous — the set grouping broke`);
		seq.push(card.set);
	}
	return seq;
}

/**
 * Is `later` in a LATER batch of `date` than `earlier`, where `earlier < later` by code and the
 * ascending sequence therefore cannot say? Inside one batch `prefer:newest` and `prefer:oldest` keep
 * the SAME row of a card both sets print (the lowest Scryfall id); across a boundary newest keeps
 * the later batch's and oldest the earlier's. `null` when an answer names neither set, or the two
 * disagree the other way round (which the ascending sequence rules out).
 */
async function laterBatch(date: string, oracle: string, earlier: string, later: string): Promise<boolean | null> {
	const pick = async (prefer: string): Promise<string | undefined> => {
		const cards = await search<{ set: string }>(`${date} ${earlier}/${later} ${prefer}`, {
			q: `oracleid:${oracle} date=${date} (e:${earlier} or e:${later}) prefer:${prefer}`,
			include_extras: "true",
			include_variations: "true",
		});
		return cards[0]?.set;
	};
	const newest = await pick("newest");
	const oldest = await pick("oldest");
	if ((newest !== earlier && newest !== later) || (oldest !== earlier && oldest !== later)) return null;
	if (newest === oldest) return false;
	if (newest === later) return true;
	console.warn(`  ${date} ${earlier}/${later}: newest answers the earlier code and oldest the later — skipped`);
	return null;
}

/**
 * The batch boundaries a date's ascending sequence HIDES: indexes `k` where `seq[k - 1] < seq[k]`
 * by code and `seq[k]` is nevertheless in a later batch.
 *
 * Only pairs of one alphabetical run that `shares` a card can be asked, and only they matter — a
 * boundary between two sets with no card in common changes no answer. Narrow pairs first, so a
 * wider pair is asked only when nothing between it is already known: a boundary inside it settles
 * it, and so does a proven same-batch pair that covers it. A boundary found across a pair that is
 * not adjacent is placed as late as the proven same-batch pairs allow.
 */
export async function hiddenCuts(
	seq: readonly string[],
	shares: (a: string, b: string) => string | undefined,
	later: (oracle: string, a: string, b: string) => Promise<boolean | null>,
): Promise<Set<number>> {
	const cuts = new Set<number>();
	let start = 0;
	for (let end = 1; end <= seq.length; end++) {
		if (end < seq.length && (seq[end] as string) > (seq[end - 1] as string)) continue;
		const same: [number, number][] = [];
		for (let span = 1; span < end - start; span++) {
			for (let i = start; i + span < end; i++) {
				const j = i + span;
				const oracle = shares(seq[i] as string, seq[j] as string);
				if (!oracle) continue;
				let settled = same.some(([x, y]) => x <= i && j <= y);
				for (let k = i + 1; k <= j && !settled; k++) settled = cuts.has(k);
				if (settled) continue;
				const answer = await later(oracle, seq[i] as string, seq[j] as string);
				if (answer === null) continue;
				if (!answer) {
					same.push([i, j]);
					continue;
				}
				let k = j;
				while (k > i && same.some(([x, y]) => x < k && k <= y)) k--;
				if (k > i) cuts.add(k);
				else console.warn(`  ${seq[i]}/${seq[j]}: a boundary with no place left for it — skipped`);
			}
		}
		start = end;
	}
	return cuts;
}

/**
 * Each set's batch: the number of boundaries before it in the date's sequence — every code-order
 * descent, and every boundary `hiddenCuts` found where the code order continues.
 */
export function batchesOf(seq: readonly string[], cuts: ReadonlySet<number> = new Set()): Map<string, number> {
	const out = new Map<string, number>();
	let batch = 0;
	seq.forEach((set, i) => {
		if (i > 0 && (set < (seq[i - 1] as string) || cuts.has(i))) batch++;
		out.set(set, batch);
	});
	return out;
}

async function main(): Promise<void> {
	const rows = arg("--rows", "store-build/rows.jsonl");
	const dates = await readDates(rows);
	const shared = [...dates].filter(([, sets]) => sets.picks.size >= 2).sort(([a], [b]) => (a < b ? 1 : -1));
	console.log(`${shared.length} release dates hold two or more sets in ${rows}`);
	const entries: string[] = [];
	let reordered = 0;
	let maxBatch = 0;
	let asked = 0;
	let hidden = 0;
	for (const [date, sets] of shared) {
		const seq = await ask(date, sets.picks);
		const shares = (a: string, b: string): string | undefined => {
			const other = sets.cards.get(b);
			if (!other) return undefined;
			for (const oracle of sets.cards.get(a) ?? []) if (other.has(oracle)) return oracle;
			return undefined;
		};
		const cuts = await hiddenCuts(seq, shares, (oracle, a, b) => {
			asked++;
			return laterBatch(date, oracle, a, b);
		});
		if (cuts.size > 0) console.log(`  ${date}: ${[...cuts].map((k) => `${seq[k - 1]} | ${seq[k]}`).join(", ")}`);
		hidden += cuts.size;
		const batches = batchesOf(seq, cuts);
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
		`# ${shared.length} dates measured, ${reordered} of them in more than one batch; ${asked} same-run pairs`,
		`# asked \`prefer:newest\` and \`prefer:oldest\`, ${hidden} of them a boundary the code order hides.`,
	];
	writeFileSync(OUT, `${[...header, ...entries].join("\n")}\n`);
	console.log(`Wrote ${OUT} — ${entries.length} entries over ${reordered} dates, largest batch ${maxBatch}`);
}

if (import.meta.main) await main();
