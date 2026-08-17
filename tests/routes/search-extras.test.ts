// `/search`'s half of the extras/variations gate — the SHARED rule in src/routes/extras-gate.ts,
// asserted through the web-UI route rather than through `/cards/search`.
//
// THE BUG THESE PIN. `/search` had no extras handling at all, and did not need any while the store
// was built from Scryfall's `default_cards` bulk: that dump carries no art-series printings, so
// there was nothing to exclude. The importer moved to `all_cards`, which carries 2,650 of them, and
// `q=lightning bolt` began answering THREE printings — astx/76 "Lightning Bolt // Lightning Bolt",
// a Strixhaven Art Series card — where `/cards/search` and api.scryfall.com both answer two. The
// same shape as several bugs found that night: a check that was harmless under the old data.
//
// THE REAL PARSER RUNS HERE, deliberately, and this file therefore installs no fake one. The gate
// reads `card_is_tags` / `card_set_code` leaves, the `field:/regex/` spellings the rewrite erases
// and the `is:split` -> `layout:split` expansions it invents; a fake tree carries none of that, so
// a test built on one would pass against a gate that never fired.

import { beforeEach, describe, expect, test } from "bun:test";
import { setParserForTests } from "../../src/routes/parser-bridge";
import { FakeEngine, makeCtx, testDispatch } from "./harness";

// The parser bridge's override is a module-level global, and sibling files install a fake one in
// their own `beforeEach`. Clearing it here is what makes "the real parser runs in this file" true
// no matter which order the suite runs in — without it these tests read a fake tree and pass.
beforeEach(() => {
	setParserForTests(null);
});

/** The tree the route handed the engine, as a string — the gate's only observable here. */
async function treeFor(engine: FakeEngine, query: string): Promise<string> {
	await testDispatch(makeCtx({ engine }), `/search?q=${encodeURIComponent(query)}`);
	return JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));
}

/** How many `NOT(is:<tag>)` conjuncts the gate added — 0, 1 or 2. */
function gatesClosed(tree: string): { extra: boolean; variation: boolean } {
	return { extra: tree.includes('"extra"'), variation: tree.includes('"variation"') };
}

describe("/search applies the extras gate", () => {
	test("an ordinary query excludes extras AND variations", async () => {
		// The regression itself. Without the gate this tree is the bare `name:` conjunction and
		// the search answers astx/76 alongside msc/806 and sos/113.
		const engine = new FakeEngine();
		const tree = await treeFor(engine, "lightning bolt");
		expect(gatesClosed(tree)).toEqual({ extra: true, variation: true });
		expect(tree.split("NotNode").length - 1).toBe(2);
	});

	test("the empty query is left alone — a TrueNode tree is not wrapped", async () => {
		// `withoutIsTags` declines to wrap `True` because the lanes that search without a query
		// have their own scoping. `/search?q=` is one of them.
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/search");
		expect(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null")).toEqual({ node_type: "TrueNode", kwargs: {} });
	});

	test("is:extra means what it says — the term is not cancelled by its own gate", async () => {
		// The reason the exclusion is a query-time conjunct and not a flag on the wire: a caller
		// who asks for extras by name gets them, and the tree carries ONE `extra` (theirs) rather
		// than a term and its own negation.
		const engine = new FakeEngine();
		const tree = await treeFor(engine, "is:extra");
		expect(tree.split('"extra"').length - 1).toBe(1);
		// The OTHER gate is still closed — `is:extra` does not auto-enable variations.
		expect(tree.split("NotNode").length - 1).toBe(1);
		expect(tree).toContain('"variation"');
	});

	test("every unconditional trigger still admits extras", async () => {
		// Each fires on the TERM, not on what it matches — measured against api.scryfall.com and
		// pinned for `/cards/search` in scryfall-compat.test.ts. This is the same rule, reached
		// through the other route: one implementation, two surfaces.
		const engine = new FakeEngine();
		for (const q of [
			"a:guay",
			"wm:mirran",
			"layout:normal",
			"t:token",
			"is:oversized",
			"border:silver",
			"banned:legacy",
			"name:/^Ancient/",
			"is:artseries",
		]) {
			expect(gatesClosed(await treeFor(engine, q)), q).toMatchObject({ extra: false });
		}
	});

	test("a set term admits extras only when that set holds one", async () => {
		const engine = new FakeEngine();
		engine.setsWithExtrasList = ["lea"];
		expect(gatesClosed(await treeFor(engine, "e:lea")).extra).toBe(false);
		expect(gatesClosed(await treeFor(engine, "e:khm")).extra).toBe(true);
	});

	test("is:variation admits variations, and nothing else does", async () => {
		const engine = new FakeEngine();
		engine.setsWithExtrasList = ["lea"];
		// ONE `variation` in the tree — the caller's own term, with no negation of it beside it.
		const own = await treeFor(engine, "is:variation");
		expect(own.split('"variation"').length - 1).toBe(1);
		expect(own.split("NotNode").length - 1).toBe(1); // the extras gate, still closed
		// Everything that forces the EXTRAS gate leaves this one closed — the two rules were
		// measured separately and are not one rule read twice.
		for (const q of ["t:token", "layout:normal", "is:extra", "e:lea"]) {
			expect(gatesClosed(await treeFor(engine, q)).variation, q).toBe(true);
		}
	});

	test("the explanation describes the query, not the gate", async () => {
		// The gate wraps the tree AFTER `explainWireTree` reads it. If it wrapped first, every
		// search on the site would explain itself as "… and it is not an extra and it is not a
		// variation" — the page prints this string verbatim.
		const res = await testDispatch(makeCtx({ engine: new FakeEngine() }), "/search?q=bolt");
		const body = (await res.json()) as { query_explanation: string };
		expect(body.query_explanation).toBe("the name contains Bolt");
	});

	test("the gate does not disturb the arithmetic-not-compared rejection", async () => {
		// `usesValueAsPredicate` runs on the tree the user wrote, BEFORE the wrap. Gating first
		// would bury the value node inside an AndNode where the walk stops looking.
		const res = await testDispatch(makeCtx({ engine: new FakeEngine() }), "/search?q=1");
		expect(res.status).toBe(400);
	});
});
