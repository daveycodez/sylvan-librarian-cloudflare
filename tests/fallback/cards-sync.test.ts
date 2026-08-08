// Adaptive write pacing helpers: the daily-limit error classifier the
// ImportCoordinator keys plan detection off, and metered-write accounting.

import { describe, expect, test } from "bun:test";
import { isDailyLimitError, meteredWrites } from "../../src/fallback/cards-sync";

describe("isDailyLimitError", () => {
	test("matches Cloudflare's documented daily-limit wording", () => {
		// developers.cloudflare.com/d1/reference/faq: "D1 API will return
		// errors to your client indicating that your daily limits have been
		// exceeded" — no exact code is documented, so the classifier matches
		// the wording family.
		expect(isDailyLimitError(new Error("D1_ERROR: your daily limits have been exceeded"))).toBe(true);
		expect(isDailyLimitError(new Error("You have exceeded your daily D1 free tier quota"))).toBe(true);
		expect(isDailyLimitError("daily write quota exceeded, resets at 00:00 UTC")).toBe(true);
	});

	test("matches when the wording sits on the error cause", () => {
		const err = new Error("D1_ERROR");
		(err as { cause?: unknown }).cause = "daily limit exceeded";
		expect(isDailyLimitError(err)).toBe(true);
	});

	test("does not match unrelated limit errors", () => {
		expect(isDailyLimitError(new Error("Worker exceeded CPU time limit"))).toBe(false);
		expect(isDailyLimitError(new Error("too many SQL variables"))).toBe(false);
		expect(isDailyLimitError(new Error("Too many subrequests"))).toBe(false);
		expect(isDailyLimitError(new Error("SQLITE_TOOBIG: string or blob too big"))).toBe(false);
		expect(isDailyLimitError(new Error("network connection lost"))).toBe(false);
	});
});

describe("meteredWrites", () => {
	test("sums rows_written across batch results", () => {
		const results = [{ meta: { rows_written: 2 } }, { meta: { rows_written: 3 } }, { meta: { rows_written: 0 } }];
		expect(meteredWrites(results, 99)).toBe(5);
	});

	test("falls back to the estimate when meta is absent (local shims)", () => {
		expect(meteredWrites([{}, {}], 4)).toBe(4);
		expect(meteredWrites([], 7)).toBe(7);
	});

	test("mixes reported and missing meta without double counting", () => {
		// One statement reports, one doesn't: the reported sum wins — the
		// fallback estimate is all-or-nothing, not per-statement.
		expect(meteredWrites([{ meta: { rows_written: 6 } }, {}], 99)).toBe(6);
	});
});
