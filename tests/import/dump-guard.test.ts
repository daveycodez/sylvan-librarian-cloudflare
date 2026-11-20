// The dump guard (src/import-dump-guard.ts): a Scryfall release that arrives empty or cut short is
// skipped. On 2026-11-19 oracle_tags was published as 20 bytes of nothing, and the import built and
// published a store without a single oracle tag over one that was fine.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DUMP_MIN_BYTES, dumpSizeProblem, releaseProblems } from "../../src/import-dump-guard";
import { DUMP_KINDS, type DumpKind } from "../../src/import-phases";

/** Each dump's gzipped length on 2026-11-19 (oracle_tags: the morning's, the last whole one). */
const MEASURED: Record<DumpKind, number> = {
	all_cards: 407_877_582,
	default_cards: 81_265_440,
	oracle_cards: 25_527_596,
	art_tags: 13_447_529,
	oracle_tags: 6_125_719,
	rulings: 5_508_481,
};

describe("the floors", () => {
	test("every dump the import reads has one, and every real release clears it with room", () => {
		expect(Object.keys(DUMP_MIN_BYTES).sort()).toEqual([...DUMP_KINDS].sort());
		for (const kind of DUMP_KINDS) {
			expect(dumpSizeProblem(kind, MEASURED[kind])).toBeNull();
			// A dump a third smaller than today's still imports; one cut to a third does not.
			expect(dumpSizeProblem(kind, Math.floor(MEASURED[kind] * 0.67))).toBeNull();
			expect(dumpSizeProblem(kind, Math.floor(MEASURED[kind] / 3))).not.toBeNull();
		}
	});

	test("the 2026-11-19 oracle_tags dump — 20 bytes — is refused, in a sentence that says so", () => {
		expect(dumpSizeProblem("oracle_tags", 20)).toBe("oracle_tags is 20 bytes, under its 3,000,000-byte floor");
		expect(dumpSizeProblem("oracle_tags", 0)).not.toBeNull();
	});

	test("a length nobody stated is not a refusal", () => {
		for (const unknown of [null, Number.NaN, -1]) expect(dumpSizeProblem("all_cards", unknown)).toBeNull();
	});

	test("the native builder refuses the same dumps (engine/builder/src/bulk.rs)", () => {
		const rust = readFileSync(join(import.meta.dir, "../../engine/builder/src/bulk.rs"), "utf8");
		const table = rust.slice(
			rust.indexOf("pub const DUMP_MIN_BYTES"),
			rust.indexOf("];", rust.indexOf("pub const DUMP_MIN_BYTES")),
		);
		const pairs = [...table.matchAll(/\("([a-z_]+)", ([0-9_]+)\)/g)].map((m) => [
			m[1],
			Number((m[2] as string).replaceAll("_", "")),
		]);
		expect(Object.fromEntries(pairs)).toEqual({ ...DUMP_MIN_BYTES });
	});
});

describe("releaseProblems", () => {
	const uris = new Map(DUMP_KINDS.map((kind): [DumpKind, string] => [kind, `https://dumps/${kind}`]));

	test("a whole release has none", async () => {
		expect(await releaseProblems(uris, async (_uri, kind) => MEASURED[kind])).toEqual([]);
	});

	test("that night's release names the one empty dump", async () => {
		const problems = await releaseProblems(uris, async (_uri, kind) => (kind === "oracle_tags" ? 20 : MEASURED[kind]));
		expect(problems).toEqual(["oracle_tags is 20 bytes, under its 3,000,000-byte floor"]);
	});

	test("a server that states no length refuses nothing", async () => {
		expect(await releaseProblems(uris, async () => null)).toEqual([]);
	});
});
