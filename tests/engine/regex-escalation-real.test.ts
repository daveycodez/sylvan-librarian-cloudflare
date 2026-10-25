// Lookaround patterns whose candidates cost more than 8,192 backtracks, on the REAL corpus, through
// the committed wasm — one instance per partition, the production parser in front of it.
//
// mtg-seeker's tempered-token queries of 2026-10-25 (`fo:/whenever you sacrifice[^.]*((?!\. whenever).)*?create/`
// and its kin) were refused by every partition holding one long candidate: a class loop followed by a
// lookahead loop that can take the same characters makes the backtracking VM try every split between
// them, and the first candidate past the flat 8,192 budget failed the whole query as `regex execution
// limit exceeded` — a 400 `Failed to parse query` on /cards/search where api.scryfall.com answers
// 15 cards. The engine now retries such a candidate up a small ladder of larger limits, paid from a
// per-query purse (card_engine `regex_compat::ESCALATION_LIMITS`).
//
// Each pattern here is checked against a pattern it is PROVABLY equal to, so the test needs no
// recorded totals that drift with every set:
//
//   - `[^.]*` before `((?!\.X).)*?` adds nothing: a character the class takes is never a `.`, so the
//     lookahead (which needs a `.` there) never refuses it, and a negated class is newline-free on
//     both engines (`NEGATED_CLASS_NEWLINE`), as `.` is.
//   - `((?!\)).)*?` IS `[^)]*` and `((?!\.)(.))*?` IS `[^.]*`: one character that is not the excluded
//     one and not a newline. Those equivalents run on the linear engine, so they are the reference
//     the backtracking answer has to reach.
//
// Opt-in, like the other real-corpus suites: SYLVAN_REAL_DIFFERENTIAL=1, with STORE_BUILD_DIR pointing
// at a store build (default: this checkout's store-build/).

import { describe, expect, test } from "bun:test";
import { canonicalStringify, type FilterValue, parseScryfallQuery } from "../../src/parser";
import { loadRealStore, realStoreDir, realStoreReadable } from "./real-partitions";

const OPTS = JSON.stringify({
	unique: "card",
	prefer: "default",
	orderby: "name",
	direction: "asc",
	limit: 100_000,
	offset: 0,
	fields: ["oracle_id"],
	include_multilingual: false,
});

/** Every oracle id the corpus answers `q` with, across all partitions — or the engine's refusal. */
function answer(q: string): string[] {
	const tree = canonicalStringify(parseScryfallQuery(q) as FilterValue);
	const ids: string[] = [];
	for (const engine of loadRealStore().engines) {
		const out = JSON.parse(engine.use((g) => g.query(tree, OPTS))) as { rows: { oracle_id: string }[] };
		for (const row of out.rows) ids.push(row.oracle_id);
	}
	return ids.sort();
}

const PAIRS: [string, string][] = [
	// The two reported queries' shape, and the reported query that already answered.
	[
		String.raw`fo:/whenever you sacrifice[^.]*((?!\. whenever).)*?create/`,
		String.raw`fo:/whenever you sacrifice((?!\. whenever).)*?create/`,
	],
	[
		String.raw`fo:/whenever you ([^.]* or )?sacrifice[^.]*((?!\. whenever).)*?(—(.|\n•)*?)?create [^.]*creature tokens?/`,
		String.raw`fo:/whenever you ([^.]* or )?sacrifice((?!\. whenever).)*?(—(.|\n•)*?)?create [^.]*creature tokens?/`,
	],
	// The same bug class with thousands of candidates, against linear-engine equivalents.
	[String.raw`fo:/\([^)]*((?!\)).)*?enters/`, String.raw`fo:/\([^)]*enters/`],
	[String.raw`o:/(when|whenever) [^.]*((?!\.)(.))*?(create|draw) a/`, "o:/(when|whenever) [^.]*(create|draw) a/"],
	[String.raw`fo:/when[^.]*((?!\. when).)*?token/`, String.raw`fo:/when((?!\. when).)*?token/`],
	[
		String.raw`o:/whenever you [^.]*((?!\. whenever).)*?draw a card/`,
		String.raw`o:/whenever you ((?!\. whenever).)*?draw a card/`,
	],
];

describe.skipIf(!realStoreReadable)(`a lookaround pattern past the flat backtrack budget, on ${realStoreDir}`, () => {
	for (const [pattern, equal] of PAIRS) {
		test(pattern, () => {
			const got = answer(pattern);
			expect(got.length).toBeGreaterThan(0);
			expect(got).toEqual(answer(equal));
		});
	}
});
