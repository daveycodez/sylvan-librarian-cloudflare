// The guard on the guard: `price_nullity` must actually fire.
//
// scripts/live-parity.ts blanks every member of `prices` on both sides before comparing bodies, so
// `null` and `"4900.00"` reduce to the same byte. That is what makes the `usd`/`eur` fix (local
// 417bed6, upstream #927 10a6fb7) unfalsifiable by the byte comparison alone: the coalesce belongs
// on the SEARCH KEY — filter, range index, sort key, representative pick — and NOT on the stored
// column that feeds the card object, and writing it into the column instead passes every count and
// every filter test while corrupting `prices.usd` on 12,865 printings.
//
// `checkPriceNullity` is the opt-in per-case assertion that sees it, and a check nobody can watch
// fail is worth nothing — `search-usd-coalesce-is-on-the-search-key-not-the-column` is green either
// way if this function silently returns []. So the failing direction is pinned here, offline,
// against bodies shaped like the two the case actually compares.

import { describe, expect, test } from "bun:test";
import { checkPriceNullity } from "../../scripts/volatile-shape";

/** A one-row `/cards/search` body carrying just the `prices` map the check reads. */
function listWith(prices: Record<string, string | null>): unknown {
	return {
		object: "list",
		total_cards: 1,
		data: [{ object: "card", id: "1", name: "Traveling Chocobo", prices }],
	};
}

const SCRYFALL = { usd: null, usd_foil: "5950.00", usd_etched: null, eur: null, eur_foil: "1.00", tix: null };
const KEYS = ["usd", "usd_foil", "usd_etched"];

describe("checkPriceNullity", () => {
	test("agreeing nullity passes, whatever the values are", () => {
		// Deliberately a DIFFERENT foil price on our side: this is a presence check, never a value
		// one, so an overnight market move must not turn it red.
		const ours = { ...SCRYFALL, usd_foil: "6100.00" };
		expect(checkPriceNullity(listWith(ours), listWith(SCRYFALL), KEYS)).toEqual([]);
	});

	test("a coalesce written into the STORED column is caught", () => {
		// The wrong fix, exactly: the served `usd` inherits the foil price. Scryfall serves null.
		const corrupted = { ...SCRYFALL, usd: "5950.00" };
		const problems = checkPriceNullity(listWith(corrupted), listWith(SCRYFALL), KEYS);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("data.0.prices.usd");
		expect(problems[0]).toContain("Scryfall serves null and the mirror serves a price");
	});

	test("the other direction — a price gone dark on our side — is caught too", () => {
		const ours = { ...SCRYFALL, usd_foil: null };
		const problems = checkPriceNullity(listWith(ours), listWith(SCRYFALL), KEYS);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("data.0.prices.usd_foil");
	});

	test("only the declared keys are read", () => {
		const ours = { ...SCRYFALL, eur: "12.00" };
		expect(checkPriceNullity(listWith(ours), listWith(SCRYFALL), KEYS)).toEqual([]);
		expect(checkPriceNullity(listWith(ours), listWith(SCRYFALL), ["eur"])).toHaveLength(1);
	});

	test("asserting nothing is itself a failure", () => {
		// A query that stopped matching the printings it was written for would otherwise go green
		// by comparing zero rows — the silent-vacuum failure mode this whole file exists to deny.
		const empty = { object: "list", total_cards: 0, data: [] };
		const problems = checkPriceNullity(empty, empty, KEYS);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("asserted nothing");
	});
});
