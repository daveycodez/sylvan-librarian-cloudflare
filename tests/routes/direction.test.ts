/**
 * `dir=auto` resolution (upstream #913).
 *
 * The engine has no AUTO arm, so a direction that reaches it unresolved falls through to the
 * default and sorts the query wrongly rather than failing — a silent wrong answer. These pin both
 * the resolution table and the fact that it is applied on the request path.
 */

import { describe, expect, test } from "bun:test";
import type { CardOrdering } from "../../src/routes/enums";
import { AUTO_DESCENDING_ORDERINGS, CARD_ORDERING, resolveDirection } from "../../src/routes/enums";

describe("resolveDirection", () => {
	test("an explicit direction is left alone", () => {
		expect(resolveDirection("asc", "released")).toBe("asc");
		expect(resolveDirection("desc", "name")).toBe("desc");
	});

	test("the five measured orderings resolve descending", () => {
		// Measured against api.scryfall.com 2026-08-09 by comparing the auto page against asc/desc.
		for (const orderby of ["released", "rarity", "usd", "tix", "eur"] as CardOrdering[]) {
			expect(resolveDirection("auto", orderby)).toBe("desc");
		}
	});

	test("every other ordering resolves ascending", () => {
		for (const orderby of CARD_ORDERING.values) {
			if (AUTO_DESCENDING_ORDERINGS.has(orderby)) continue;
			expect(resolveDirection("auto", orderby)).toBe("asc");
		}
	});

	test("edhrec resolves ascending, which is most-popular-first", () => {
		// Worth pinning separately: "ascending rank" and "most popular first" are the same thing
		// here, so the intuition that popularity should be descending is wrong.
		expect(resolveDirection("auto", "edhrec")).toBe("asc");
	});

	test("no ordering resolves to auto", () => {
		for (const orderby of CARD_ORDERING.values) {
			expect(resolveDirection("auto", orderby)).not.toBe("auto");
		}
	});
});
