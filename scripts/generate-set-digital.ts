// Turn api.scryfall.com's `/sets` into the committed card_engine table behind `paperprints` and
// `papersets`.
//
// Scryfall counts a printing as a PAPER one by its SET, not by its own `games`. Measured
// 2026-10-04, each card's stored value found by search (`!"Name" paperprints=K`):
//
//   card                    slot the two rules disagree on        games rule   set rule   Scryfall
//   "Name Sticker" Goblin   unf/107m   games [mtgo]                   0           1          1
//   Rakshasa Vizier         ktk/193y   games [arena]                  3           4          4
//   Library of Alexandria   spg/158a   games [arena]                  3           4          4
//   Oracle of the Alpha     mbc/64     games [arena]                  1           2          2
//   Mardu Hateblade         ktk/16y    games [arena]                  1           2          2
//
// and `paperprints=0` was 657 cards under the games rule against Scryfall's 654 — the three being
// "Name Sticker" Goblin and two Arena cards reprinted in mbc. A set is digital exactly when none
// of its printings is on paper: over the 1,052 sets the store held that day, `/sets`' `digital`
// flag and "no row of the set has `paper` in `games`" agree on every one. So the table could be
// derived from the rows — but a partition holds one eleventh of them, and the builder of one
// partition cannot see whether a set has a paper printing somewhere else.
//
//   bun run set-digital
//
// Run by hand and the diff committed, like `bun run set-dates`; a sync-upstream is the natural
// moment. A set announced after the last refresh is in neither list, and its printings fall back
// to their own `games` — the rule before this table, right for every set that is wholly one or
// the other.

import { writeFileSync } from "node:fs";

const OUT = "vendor/sylvan_librarian/card_engine/src/set_digital_gen.rs";
const SETS_URL = "https://api.scryfall.com/sets";

interface SetObject {
	code?: unknown;
	digital?: unknown;
}

/**
 * The body of a Rust string literal: the codes sorted and space separated, wrapped with `\` line
 * continuations (which swallow the newline and the next line's indent), closing quote included.
 */
function literal(codes: string[]): string {
	const lines: string[] = [];
	let line = "";
	for (const code of [...codes].sort()) {
		if (line.length + code.length + 1 > 92) {
			lines.push(line);
			line = "";
		}
		line += `${code} `;
	}
	if (line !== "") lines.push(line);
	const last = lines.length - 1;
	return lines.map((l, i) => `    ${i === last ? `${l.trimEnd()}"` : `${l}\\`}`).join("\n");
}

async function main(): Promise<void> {
	const res = await fetch(SETS_URL, {
		headers: { "User-Agent": "sylvan-librarian-cloudflare/generate-set-digital", Accept: "application/json" },
	});
	if (!res.ok) {
		console.error(`GET ${SETS_URL} answered ${res.status}`);
		process.exit(1);
	}
	const payload = (await res.json()) as { data?: unknown };
	const sets = payload.data;
	if (!Array.isArray(sets) || sets.length === 0) throw new Error("/sets answered no data");

	const paper: string[] = [];
	const digital: string[] = [];
	for (const entry of sets as SetObject[]) {
		const code = typeof entry.code === "string" ? entry.code.toLowerCase() : null;
		if (code === null) continue;
		// The table is space separated inside a Rust string literal: a code carrying anything else
		// would break the encoding, and is rejected instead of emitted.
		if (!/^[0-9a-z]{1,8}$/.test(code)) throw new Error(`unexpected set code ${JSON.stringify(code)}`);
		if (typeof entry.digital !== "boolean") throw new Error(`set ${code} has no boolean \`digital\``);
		(entry.digital ? digital : paper).push(code);
	}
	if (paper.length === 0 || digital.length === 0) throw new Error("/sets answered no usable sets");

	const source = `// GENERATED FILE - do not edit. Built by scripts/generate-set-digital.ts from api.scryfall.com/sets.
//
// LOCAL PATCH (Cloudflare port): which sets are PAPER sets and which DIGITAL, by Scryfall's own
// \`digital\` flag on the set object. \`assign_print_counts\` reads it: Scryfall's \`paperprints\` and
// \`papersets\` count a printing by its set, so an MTGO-only printing in a paper set is a paper
// print. See the generator for the measurements. Committed and refreshed by hand with
// \`bun run set-digital\`; a set in neither list falls back to the printing's own \`games\`.
//
// Space separated and sorted; read once per store BUILD, never at query time.

/// ${paper.length} set codes.
pub(crate) const PAPER_SETS: &str = "\\
${literal(paper)};

/// ${digital.length} set codes.
pub(crate) const DIGITAL_SETS: &str = "\\
${literal(digital)};
`;

	writeFileSync(OUT, source);
	console.log(`Wrote ${OUT} — ${paper.length} paper sets, ${digital.length} digital`);
}

await main();
