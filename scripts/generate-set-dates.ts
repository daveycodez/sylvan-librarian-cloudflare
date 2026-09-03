// Turn api.scryfall.com's `/sets` into the committed parser module behind `date>=<set code>`.
//
// Scryfall accepts a SET CODE anywhere a date value goes, and resolves it to that set's
// `released_at` before comparing. Measured one request per row, 2026-09-03, each set code against
// the explicit date `/sets/<code>` reports for it:
//
//   date>=hob  1,200 = date>=2026-08-14      date>=3ed  33,581 = date>=1994-04-11
//   date:hob     311 = date:2026-08-14       date>=10e  28,976 = date>=2007-07-13
//   date<hob  33,203 = date<2026-08-14       date>=40k  16,724 = date>=2022-10-07
//   date<=hob 33,409                         date>=2x2  17,295 = date>=2022-07-08
//   date>hob     901
//
// So the code is a full YYYY-MM-DD point, not a window like the bare year is, and every operator
// reads it as one. Only the PRIMARY `code` resolves: `date>=dar` and `date>=ms4` — Dominaria's
// mtgo/arena code and Mythic Edition's — are both `Invalid date or unknown set code`, where
// `e:dar` is 265 there. So this table is `code -> released_at` and nothing else.
//
//   bun scripts/generate-set-dates.ts
//
// Run by scripts/import-store.sh next to generate-tag-aliases.ts, for the same reason: the
// committed module then describes the same Scryfall the live store was built from. A set released
// after the last run is an unknown code until the next one, which is the honest answer — the
// alternative is a KV read on the parse path of every search.

import { writeFileSync } from "node:fs";

const OUT = "src/parser/set-dates.gen.ts";
const SETS_URL = "https://api.scryfall.com/sets";

interface SetObject {
	code?: unknown;
	released_at?: unknown;
}

/**
 * The table as ONE string literal, `code:yyyymmdd` pairs joined by `|`, sorted by code.
 *
 * Same reasoning as `table()` in generate-tag-aliases.ts — a string literal is scanned rather than
 * structured, so no isolate pays to build 1,049 array literals at module load against the free
 * plan's 10ms CPU budget, and a query that never writes a set-code date never builds the Map.
 *
 * `code:yyyymmdd` rather than JSON because the shape is fixed and the bytes are not: JSON of the
 * ISO strings is ~23KB where this is ~14KB, and the hyphens are re-inserted on read by the one
 * caller that wants them. DOUBLE-quoted, unlike tag-aliases.gen.ts's single-quoted JSON — that
 * file quotes the other way because JSON is all double quotes and escaping them would cost
 * thousands of characters, where this encoding contains no quote of either kind. Biome formats a
 * quoteless literal to double quotes, so emitting anything else fails `bun run check`.
 *
 * The regexes in `main` are what keep that true by construction rather than by luck: a set code or
 * a date carrying a quote or a `|` would break the encoding, and is rejected instead of emitted.
 */
function table(dates: Map<string, string>): string {
	const rows = [...dates.keys()].sort().map((code) => `${code}:${dates.get(code) as string}`);
	return `"${rows.join("|")}"`;
}

async function main(): Promise<void> {
	const res = await fetch(SETS_URL, {
		headers: { "User-Agent": "sylvan-librarian-cloudflare/generate-set-dates", Accept: "application/json" },
	});
	if (!res.ok) {
		console.error(`GET ${SETS_URL} answered ${res.status}`);
		process.exit(1);
	}
	const payload = (await res.json()) as { data?: unknown };
	const sets = payload.data;
	if (!Array.isArray(sets) || sets.length === 0) throw new Error("/sets answered no data");

	const dates = new Map<string, string>();
	for (const entry of sets as SetObject[]) {
		const code = typeof entry.code === "string" ? entry.code.toLowerCase() : null;
		const released = typeof entry.released_at === "string" ? entry.released_at : null;
		// A set with no release date cannot anchor a comparison, so it is left out and its code
		// reads as unknown — which is what Scryfall answers for a value it cannot turn into a date.
		if (code === null || released === null) continue;
		if (!/^[0-9a-z]{1,8}$/.test(code)) throw new Error(`unexpected set code ${JSON.stringify(code)}`);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(released)) {
			throw new Error(`unexpected released_at ${JSON.stringify(released)} on ${code}`);
		}
		dates.set(code, released.replace(/-/g, ""));
	}
	if (dates.size === 0) throw new Error("/sets answered no usable sets");

	const source = `// GENERATED FILE - do not edit. Built by scripts/generate-set-dates.ts from api.scryfall.com/sets.
//
// Scryfall resolves a SET CODE written where a date goes to that set's \`released_at\`:
// \`date>=hob\` is \`date>=2026-08-14\`, on every one of the six operators. See the generator for
// the measurements, and for why only the primary \`code\` is here.
//
// A TABLE rather than a lookup, because the parser is synchronous and sits on the hot path: the
// alternative is a KV read of the \`/sets\` reference data on every search that writes one of
// these. Regenerated with the store, exactly like tag-aliases.gen.ts.

// One string literal, scanned rather than structured, parsed on first use — see \`table()\` in the
// generator. Dates are \`yyyymmdd\`; \`setReleaseDate\` re-inserts the hyphens.
const SET_DATES =
	${table(dates)};

let dateMap: ReadonlyMap<string, string> | null = null;

function setDates(): ReadonlyMap<string, string> {
	if (dateMap === null) {
		const built = new Map<string, string>();
		for (const row of SET_DATES.split("|")) {
			const sep = row.indexOf(":");
			built.set(row.slice(0, sep), row.slice(sep + 1));
		}
		dateMap = built;
	}
	return dateMap;
}

/**
 * The \`YYYY-MM-DD\` a set code names, or null when no set carries that code.
 *
 * Case-insensitive, because Scryfall's is: \`date>=HOB\` is \`date>=hob\`'s 1,200.
 */
export function setReleaseDate(code: string): string | null {
	const packed = setDates().get(code.toLowerCase());
	if (packed === undefined) return null;
	return \`\${packed.slice(0, 4)}-\${packed.slice(4, 6)}-\${packed.slice(6, 8)}\`;
}

/** Whether \`code\` names a set this table knows — the question the compat surface asks. */
export function isKnownSetCode(code: string): boolean {
	return setDates().has(code.toLowerCase());
}
`;

	writeFileSync(OUT, source);
	console.log(`Wrote ${OUT} — ${dates.size} set codes`);
}

await main();
