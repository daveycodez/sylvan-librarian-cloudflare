/**
 * The tag slugifier exists three times — Python (upstream), TypeScript (src/parser) and Rust
 * (engine/builder) — because the query side normalizes the search term and the import side stores
 * the key that term has to land on. A disagreement between any two makes `art:"open mouth"`
 * silently return nothing: no error, no warning, just an empty result.
 *
 * The expectations are GENERATED from the vendored Python by scripts/export-parser-fixtures.py, so
 * upstream is the single source of truth rather than three hand-written lists. The Rust side reads
 * the same file (engine/builder/src/tags.rs).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slugifyTag } from "../../src/parser/card-query-nodes";

interface SlugCase {
	input: string;
	slug: string;
}

const cases: SlugCase[] = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "tag-slugs.json"), "utf8"));

describe("slugifyTag matches the Python it is ported from", () => {
	test("the fixture is non-empty", () => {
		expect(cases.length).toBeGreaterThan(0);
	});

	for (const { input, slug } of cases) {
		test(`slugifies ${JSON.stringify(input)} to ${JSON.stringify(slug)}`, () => {
			expect(slugifyTag(input)).toBe(slug);
		});
	}
});
