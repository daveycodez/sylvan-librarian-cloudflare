// The parser bridge's test override is one global for the whole `bun test` process. A file that
// installs the fake parser and never clears it leaves it active for every file bun happens to run
// afterwards — and "afterwards" is directory-discovery order, which differs between APFS here and
// ext4 on the CI runner, and on ext4 from one fresh checkout to the next.
//
// THE BUG THIS PINS. On 2026-09-22 the js job failed on a vendor-only Python commit: 19 tests in
// scryfall-compat.test.ts, every one that parses through the real parser, received the fake's
// `name:"<query>"` tree instead. search.test.ts had run four files earlier and left the fake
// installed; the rerun happened to order scryfall-compat second and was green. The full suite
// passed locally every time, because here scryfall-compat is discovered before either installer.
//
// Two pins: the helper that scopes the fake really does clear it, and no test file installs a
// fake without that helper or an explicit clear of its own.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadParser } from "../../src/routes/parser-bridge";
import { FakeParseError, fakeParse, useFakeParser } from "./harness";

const TESTS = join(import.meta.dir, "..");

function testFiles(dir: string, prefix = ""): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...testFiles(join(dir, entry.name), rel));
		else if (entry.name.endsWith(".test.ts"))
			out.push({ path: rel, text: readFileSync(join(dir, entry.name), "utf8") });
	}
	return out;
}

/** Strip comments, so prose about the override (like this file's) is not what the scan matches. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Does this file put a fake parser into the bridge, by any of its three doors? */
function installsAFake(src: string): boolean {
	return (
		/\buseFakeParser\s*\(/.test(src) ||
		/\binstallFakeParser\s*\(/.test(src) ||
		/\bsetParserForTests\s*\(\s*(?!null\s*\))/.test(src)
	);
}

/** Does it also take the fake back out — through the scoped helper, or an explicit clear? */
function clearsIt(src: string): boolean {
	return /\buseFakeParser\s*\(/.test(src) || /\bsetParserForTests\s*\(\s*null\s*\)/.test(src);
}

describe("useFakeParser scopes the fake to the file's own tests", () => {
	describe("while the helper is in force", () => {
		useFakeParser();

		test("the bridge hands out the fake", async () => {
			const parser = await loadParser();
			expect(parser.parseScryfallQuery("elf")).toEqual(fakeParse("elf"));
			expect(parser.isParseError(new FakeParseError("x"))).toBe(true);
		});
	});

	describe("once its tests are over", () => {
		test("the bridge is back to the real parser", async () => {
			// The real parser does not know the fake's sentinel error, and turns `elf` into a
			// tree the fake never builds: the extras gate's conjuncts are not its concern, but
			// a bare word IS a `name:` term in both, so tell them apart by the error class.
			const parser = await loadParser();
			expect(parser.isParseError(new FakeParseError("x"))).toBe(false);
			expect(parser.parseScryfallQuery("is:extra")).not.toEqual(fakeParse("is:extra"));
		});
	});
});

describe("no test file leaves a fake parser installed", () => {
	test("the scan actually reads the tree it is guarding", () => {
		// A scan that silently walks nothing passes forever. Pin the two installers that caused
		// the 2026-09-22 failure, and the file that was failed by them.
		const files = testFiles(TESTS);
		const installers = files.filter((f) => installsAFake(code(f.text))).map((f) => f.path);
		expect(installers).toContain("routes/root.test.ts");
		expect(installers).toContain("routes/search.test.ts");
		expect(files.map((f) => f.path)).toContain("routes/scryfall-compat.test.ts");
	});

	test("every file that installs a fake also clears it", () => {
		const offenders = testFiles(TESTS)
			.filter((f) => {
				const src = code(f.text);
				return installsAFake(src) && !clearsIt(src);
			})
			.map((f) => f.path);
		expect(offenders).toEqual([]);
	});
});
