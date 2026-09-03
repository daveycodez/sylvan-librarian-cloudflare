/**
 * The `is:` tag tables exist THREE times — the vendored Python that upstream
 * queries with, the TypeScript the parser advertises support from, and the Rust
 * the builder actually writes rows with — and nothing compared any two of them.
 *
 * `SUPPORTED_IS_VALUES` (src/parser/rewrite.ts) is derived from db-info.ts
 * precisely so the parser can never advertise a tag the importer does not store.
 * That closes the loop WITHIN TypeScript and no further: the rows are written
 * from `engine/builder/src/transform.rs`, whose tables are a hand-kept copy.
 * Add a tag to db-info.ts alone and the parser accepts `is:newtag`, the engine
 * finds it on no row, and the query returns zero results with no warning — the
 * exact silent-zero failure SUPPORTED_IS_VALUES exists to prevent, arriving
 * through the one door it does not cover.
 *
 * So: compare the tables themselves, not a behaviour downstream of them. The
 * Rust side is plain `const` arrays of string tuples, which is what makes this
 * cheap — the same trick tests/parser/tag-slugs.test.ts uses on tags.rs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ARRAY_IS_TAGS,
	BOOLEAN_IS_TAGS,
	COMPUTED_IS_TAGS,
	FIELD_IS_TAGS,
	GAME_IS_TAGS,
} from "../../src/parser/db-info";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TRANSFORM_RS = readFileSync(join(REPO_ROOT, "engine/builder/src/transform.rs"), "utf8");
const DB_INFO_PY = readFileSync(join(REPO_ROOT, "vendor/sylvan_librarian/api/parsing/db_info.py"), "utf8");

/**
 * Strip Rust line comments without touching a `//` inside a string literal —
 * the doc comments above these tables are prose full of both quotes and
 * slashes, so a naive regex mangles the source before it is ever parsed.
 */
function stripLineComments(src: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i] as string;
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += src[i + 1] ?? "";
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * The string tuples of a `const NAME: &[...] = &[ ... ];` table, in source
 * order. The array is spanned by bracket depth rather than by a lazy regex
 * because FIELD_IS_TAGS is declared on ONE line, and a match terminated on the
 * first `];` ran straight past it into the rest of the file.
 */
function rustTable(name: string): string[][] {
	const src = stripLineComments(TRANSFORM_RS);
	const start = src.indexOf(`const ${name}:`);
	expect(start, `${name} should be declared in transform.rs`).toBeGreaterThanOrEqual(0);
	const open = src.indexOf("&[", src.indexOf("=", start));
	let depth = 0;
	let end = -1;
	for (let i = open + 1; i < src.length; i++) {
		if (src[i] === "[") depth++;
		else if (src[i] === "]") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	expect(end, `${name}'s array should be balanced`).toBeGreaterThan(open);
	const body = src.slice(open + 2, end);
	return [...body.matchAll(/\(([^)]*)\)/g)].map((tuple) =>
		[...(tuple[1] as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] as string),
	);
}

/** A table as sorted rows, so the comparison is about content and not order. */
const sorted = (rows: string[][]) => rows.map((row) => row.join(" ")).sort();

describe("the is: tag tables agree across TypeScript and Rust", () => {
	test("BOOLEAN_IS_TAGS: same tags, each reading the same bulk key", () => {
		const ts = [...BOOLEAN_IS_TAGS].map(([tag, key]) => [tag, key]);
		expect(sorted(rustTable("BOOLEAN_IS_TAGS"))).toEqual(sorted(ts));
	});

	test("ARRAY_IS_TAGS: same tags, each testing the same array for the same member", () => {
		const ts = [...ARRAY_IS_TAGS].map(([tag, [key, member]]) => [tag, key, member]);
		expect(sorted(rustTable("ARRAY_IS_TAGS"))).toEqual(sorted(ts));
	});

	test("FIELD_IS_TAGS: same tags, each testing the same nested field for the same value", () => {
		const ts = [...FIELD_IS_TAGS].map(([tag, [outer, inner, value]]) => [tag, outer, inner, value]);
		expect(sorted(rustTable("FIELD_IS_TAGS"))).toEqual(sorted(ts));
	});

	/**
	 * `game:` reaches `card_is_tags` through the same one door, and through it harder: the tag key
	 * is PREFIXED (`paper` -> `game_paper`), so a disagreement here is not merely a tag the builder
	 * never writes — it is the parser rewriting `game:paper` onto a key that does not exist while
	 * `is:paper` sits next to it meaning something else entirely.
	 */
	test("GAME_IS_TAGS: same games, each naming the same prefixed tag", () => {
		const ts = [...GAME_IS_TAGS].map(([member, tag]) => [member, tag]);
		expect(sorted(rustTable("GAME_IS_TAGS"))).toEqual(sorted(ts));
	});

	test("the tables are non-trivial, so a broken extractor cannot pass by matching nothing", () => {
		expect(rustTable("BOOLEAN_IS_TAGS").length).toBeGreaterThan(10);
		expect(rustTable("ARRAY_IS_TAGS").length).toBeGreaterThan(20);
		expect(rustTable("FIELD_IS_TAGS").length).toBe(1);
		expect(rustTable("GAME_IS_TAGS").length).toBe(5);
		for (const table of ["BOOLEAN_IS_TAGS", "ARRAY_IS_TAGS", "FIELD_IS_TAGS", "GAME_IS_TAGS"]) {
			for (const row of rustTable(table)) {
				expect(row.length, `${table} row ${JSON.stringify(row)} should be string literals`).toBeGreaterThan(1);
			}
		}
	});
});

describe("the stored vocabulary still matches the vendored Python it is ported from", () => {
	// Upstream expresses every is: tag as one SQL predicate in a single dict, so
	// only the KEYS are comparable — the port splits that same vocabulary across
	// three shaped tables plus the two the importer computes.
	const pythonTags = (() => {
		const m = /^BOOLEAN_IS_TAGS: dict\[str, str\] = \{([\s\S]*?)\n\}/m.exec(DB_INFO_PY);
		expect(m, "db_info.py should declare BOOLEAN_IS_TAGS").not.toBeNull();
		const body = (m as RegExpExecArray)[1] as string;
		return new Set([...body.matchAll(/^\s+"([^"]+)":/gm)].map((x) => x[1] as string));
	})();

	/**
	 * `phyrexian` is upstream's and deliberately not ours: its rule is the symbol
	 * ANYWHERE on the card, which the `m:`/`o:` rewrite in rewrite.ts already
	 * answers exactly (73 of 73, measured card for card), so storing it would buy
	 * an archive value and nothing else. The reasoning is written out at that
	 * rewrite. The list is here so that ADDING a divergence is a decision someone
	 * makes on purpose, rather than a test quietly going green on a dropped tag.
	 */
	const DELIBERATE_DIVERGENCES = new Set(["phyrexian"]);

	test("every upstream tag is either stored here, computed here, or a named divergence", () => {
		const ours = new Set([
			...BOOLEAN_IS_TAGS.keys(),
			...ARRAY_IS_TAGS.keys(),
			...FIELD_IS_TAGS.keys(),
			...COMPUTED_IS_TAGS,
		]);
		expect([...pythonTags].filter((tag) => !ours.has(tag) && !DELIBERATE_DIVERGENCES.has(tag))).toEqual([]);
	});

	test("the divergence list has no stale entries", () => {
		for (const tag of DELIBERATE_DIVERGENCES) {
			expect(pythonTags.has(tag), `${tag} is no longer an upstream tag — drop it from the list`).toBe(true);
		}
	});

	test("the Python table parsed at all", () => {
		expect(pythonTags.size).toBeGreaterThan(30);
	});
});
