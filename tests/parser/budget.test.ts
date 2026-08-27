// The public query budgets (upstream #1041/#1047): byte length, group nesting depth, regex leaf
// count, and the per-pattern static limits. The parity fixtures already pin the rejections upstream
// exercises; these pin the BOUNDS themselves, which no fixture query sits near.

import { describe, expect, test } from "bun:test";
import {
	InvalidRegexPatternError,
	MAX_QUERY_UTF8_BYTES,
	parseScryfallQuery,
	QUERY_REGEX_REJECTED_MESSAGE,
	QUERY_TOO_LONG_MESSAGE,
	QueryBudgetExceeded,
} from "../../src/parser";
import { MAX_GROUP_DEPTH } from "../../src/parser/query-budget";
import { MAX_REGEX_LEAVES_PER_QUERY } from "../../src/parser/regex-budget";

/** Throw-and-capture, so a test can assert on the instance rather than only that it threw. */
function thrownBy(query: string): unknown {
	try {
		parseScryfallQuery(query);
	} catch (err) {
		return err;
	}
	return null;
}

describe("query byte length", () => {
	test("a query at the limit parses and one byte past it is refused", () => {
		// `o:a o:a …` — real terms, so nothing but the length can be what rejects it.
		const term = "o:a ";
		const atLimit = term.repeat(Math.floor(MAX_QUERY_UTF8_BYTES / term.length)).trimEnd();
		expect(atLimit.length).toBeLessThanOrEqual(MAX_QUERY_UTF8_BYTES);
		expect(() => parseScryfallQuery(atLimit)).not.toThrow();

		const over = `${atLimit} ${"o:aaaaa ".repeat(2)}`;
		expect(over.length).toBeGreaterThan(MAX_QUERY_UTF8_BYTES);
		const err = thrownBy(over);
		expect(err).toBeInstanceOf(QueryBudgetExceeded);
		expect((err as QueryBudgetExceeded).kind).toBe("length");
		expect((err as Error).message).toBe(QUERY_TOO_LONG_MESSAGE);
	});

	// The limit is stated in UTF-8 BYTES, and a Worker measures strings in UTF-16 code units. A
	// query of emoji is under the limit by `.length` and over it by the encoder, which is the one
	// place the two units visibly disagree.
	test("the limit counts UTF-8 bytes, not JS string length", () => {
		const emoji = "🜁"; // 4 UTF-8 bytes, 2 UTF-16 code units
		const query = `o:"${emoji.repeat(900)}"`;
		expect(query.length).toBeLessThan(MAX_QUERY_UTF8_BYTES);
		expect(thrownBy(query)).toBeInstanceOf(QueryBudgetExceeded);
	});
});

describe("parenthesis nesting depth", () => {
	test("nesting at the limit parses and one level deeper is refused", () => {
		const nest = (depth: number) => `${"(".repeat(depth)}o:a${")".repeat(depth)}`;
		expect(() => parseScryfallQuery(nest(MAX_GROUP_DEPTH))).not.toThrow();

		const err = thrownBy(nest(MAX_GROUP_DEPTH + 1));
		expect(err).toBeInstanceOf(QueryBudgetExceeded);
		expect((err as QueryBudgetExceeded).kind).toBe("depth");
	});

	// SIBLING groups are not nesting and must not accumulate: `(a) (b) (c) …` is depth 1, however
	// many of them there are. A counter that never decremented would reject this.
	test("sibling groups do not accumulate depth", () => {
		const siblings = Array.from({ length: MAX_GROUP_DEPTH * 4 }, (_, i) => `(o:a${i})`).join(" ");
		expect(() => parseScryfallQuery(siblings)).not.toThrow();
	});
});

describe("regex budgets", () => {
	test("regex leaves are counted per query", () => {
		// Distinct patterns: identical ones would dedupe, and the leaf count is checked BEFORE the
		// dedupe pass precisely so repetition cannot buy extra leaves.
		const leaf = (i: number) => `o:/a${i}b+/`;
		const atLimit = Array.from({ length: MAX_REGEX_LEAVES_PER_QUERY }, (_, i) => leaf(i)).join(" ");
		expect(() => parseScryfallQuery(atLimit)).not.toThrow();

		const over = `${atLimit} ${leaf(MAX_REGEX_LEAVES_PER_QUERY)}`;
		const err = thrownBy(over);
		expect(err).toBeInstanceOf(QueryBudgetExceeded);
		expect((err as QueryBudgetExceeded).kind).toBe("regex_leaves");
		expect((err as Error).message).toBe(QUERY_REGEX_REJECTED_MESSAGE);
	});

	// A LITERAL regex is lowered to a plain substring before the budget runs, so it is not a regex
	// leaf by the time anything counts them — `o:/flying/` costs nothing against the limit.
	test("literal regexes are lowered before they are counted", () => {
		const literals = Array.from({ length: MAX_REGEX_LEAVES_PER_QUERY * 3 }, (_, i) => `o:/flying${i}/`).join(" ");
		expect(() => parseScryfallQuery(literals)).not.toThrow();
	});

	test.each([
		["a pattern over the byte limit", `o:/${"ab+".repeat(100)}/`],
		["nested quantifiers whose product exceeds the bound", "o:/(?:a{50}){50}/"],
		["a single quantifier over the bound", "o:/a{2000}/"],
		["a backreference", "o:/(a)\\1/"],
		["a conditional", "o:/(a)(?(1)b)/"],
		["more lookarounds than the limit", "o:/(?=a)(?=b)(?=c)(?=d)(?=e)x+/"],
	])("%s is refused as over budget", (_label, query) => {
		const err = thrownBy(query);
		expect(err).toBeInstanceOf(QueryBudgetExceeded);
		expect((err as QueryBudgetExceeded).kind).toBe("regex_pattern");
	});

	// A malformed pattern is a different answer from an over-budget one: the user mistyped, and the
	// reason is quoted back rather than hidden behind the budget's fixed message.
	test("a malformed pattern is reported as malformed, not as over budget", () => {
		const err = thrownBy("name:/(/");
		expect(err).toBeInstanceOf(InvalidRegexPatternError);
		expect((err as Error).message).not.toBe(QUERY_REGEX_REJECTED_MESSAGE);
	});

	// Bracket expressions are opaque: the metacharacters inside one are literal, and counting them
	// as structure would refuse a pattern for punctuation it never treats as punctuation.
	test("metacharacters inside a character class are not counted as structure", () => {
		expect(() => parseScryfallQuery("o:/[|(){2}]x+/")).not.toThrow();
	});
});
