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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
			"t:plane",
			"t:vanguard",
			"is:oversized",
			"border:silver",
			"banned:legacy",
			"name:/^Ancient/",
			"is:artseries",
		]) {
			expect(gatesClosed(await treeFor(engine, q)), q).toMatchObject({ extra: false });
		}
		// A class as hidden as the planes that Scryfall's echo nonetheless refuses to reveal — the
		// control that keeps the type triggers a measured table (2026-08-27) and not a rule.
		expect(gatesClosed(await treeFor(engine, "t:dungeon")), "t:dungeon").toMatchObject({ extra: true });
	});

	test("a `-` on the leaf switches off exactly three trigger families, and no other", async () => {
		// The polarity sweep of 2026-09-08 (`<term> or cmc=3` with include_extras=false, verdict from
		// the next_page echo). THE BUG THIS PINS: `t:conspiracy -is:funny` answered 27 cards here
		// against api.scryfall.com's 25, because the negated `is:funny` opened the gate and let
		// mb2/503 and mb2/505 — playtest extras Scryfall calls funny — through.
		const engine = new FakeEngine();
		engine.setsWithExtrasList = ["lea"];
		// Suppressed by the `-`: gate stays CLOSED. Both operand orders, and the bare shapes.
		for (const q of [
			"t:conspiracy -is:funny",
			"-is:funny t:conspiracy",
			"cmc=3 -is:funny",
			"-t:token t:land",
			"t:land -t:token",
			"-t:plane t:land",
			"-t:phenomenon cmc=3",
			"-t:scheme cmc=3",
			"-t:vanguard cmc=3",
			"-t:emblem cmc=3",
			"t:goblin -border:silver",
		]) {
			expect(gatesClosed(await treeFor(engine, q)), q).toMatchObject({ extra: true });
		}
		// The same three families, positive: gate OPEN. `is:funny` is a stored tag now and still
		// fires as one (it used to fire as a derived `st:funny` term — same verdict either way).
		for (const q of [
			"is:funny cmc=3",
			"t:conspiracy is:funny",
			"t:token t:land",
			"t:goblin border:silver",
			// `is:playtest` fires too (every playtest printing is an extra; 796 bare = 796 flagged).
			"is:playtest cmc=3",
			"set:mb2 is:playtest",
		]) {
			expect(gatesClosed(await treeFor(engine, q)), q).toMatchObject({ extra: false });
		}
		// Every OTHER family is polarity-blind — a `-` changes nothing, and the gate opens. Stored
		// `is:` values, derived `is:`/`has:` terms, the unconditional attributes, the regex name,
		// and the conditional set term (`-e:lea t:land` echoes true, the measurement that first
		// said negation propagates).
		// (`-is:extra` is asserted below on its own: the caller's term carries the string the
		// closed-gate probe reads.)
		for (const q of [
			"-is:glossy cmc=3",
			"-is:oversized cmc=3",
			"-is:reserved cmc=3",
			"-is:rebalanced cmc=3",
			"-is:surgefoil cmc=3",
			"-is:thick cmc=3",
			"-is:draculaseries cmc=3",
			"-is:playtest cmc=3",
			"-has:glossy cmc=3",
			"-has:watermark cmc=3",
			"-is:artseries cmc=3",
			"-is:dfc cmc=3",
			"-is:mdfc cmc=3",
			"-is:planar cmc=3",
			"-is:token cmc=3",
			"-is:watermark cmc=3",
			"-name:/bolt/",
			'-a:"Wesley Burt" cmc=3',
			"-wm:set cmc=3",
			"-layout:normal cmc=3",
			"-e:lea t:land",
		]) {
			expect(gatesClosed(await treeFor(engine, q)), q).toMatchObject({ extra: false });
		}
		// `-is:extra cmc=3` echoes true too, so the tree carries ONE `extra` — the caller's own
		// negated term — and no second, gate-added negation of it.
		const ownExtra = await treeFor(engine, "-is:extra cmc=3");
		expect(ownExtra.split('"extra"').length - 1).toBe(1);
		expect(ownExtra.split("NotNode").length - 1).toBe(2); // the caller's, plus the variations gate
		// The prefix has to be on the LEAF and the flag is not inherited down a negated group: the
		// measured datum is `-(is:funny)` echoing true (the parentheses alone undo the suppression
		// there), and a two-term group is the one parenthesised shape this parser can still see as
		// a group. (`-(is:funny)` itself folds to `-is:funny` before the tree exists — the recorded
		// residual at `NEGATION_SUPPRESSED_IS_TAGS`.)
		expect(gatesClosed(await treeFor(engine, "-(t:token or t:plane) t:land"))).toMatchObject({ extra: false });
	});

	test("oracleid: admits extras — the whole card, as api.scryfall.com answers it", async () => {
		// THE BUG THIS PINS: `oracleid:<id>` forces `include_extras` on api.scryfall.com (the
		// `<term> or cmc=3` echo, 2026-09-25, table at the walk), and the gate closed anyway — so
		// Mechtitan (tneo/14, sld/1969, both extras) answered 404 and 102 of 720 re-measured ids
		// came back without their 30a/cei/ced/World Championship/oversized/token printings. The card
		// page's printings strip sends this shape here (card-embed.ts `printingsUrl`), mtgseeker's
		// Prints strip sends it to `/cards/search`.
		const engine = new FakeEngine();
		const MECHTITAN = "a4fecf0a-a7b3-49e4-bbb2-9690dff5a8f4";
		for (const q of [
			`oracleid:${MECHTITAN}`,
			`oracleid=${MECHTITAN}`,
			`oracle_id:${MECHTITAN}`,
			`oracleid:${MECHTITAN.toUpperCase()}`,
			`oracleid:"${MECHTITAN}"`,
			// Polarity-blind, like every family but three: `-oracleid:<id> cmc=3` echoes true.
			`-oracleid:${MECHTITAN} cmc=3`,
			`oracleid:${MECHTITAN} or t:goblin`,
			// The TERM, not the rows: a well-formed id no card has still fires there.
			"oracleid:11111111-1111-4111-8111-111111111111 or cmc=3",
		]) {
			expect(gatesClosed(await treeFor(engine, q)), q).toMatchObject({ extra: false, variation: true });
		}
		// Scryfall IGNORES every id that is not a v4 UUID ("You must provide a valid v4 UUID."), so
		// none of them can fire; nor can the regex spelling it ignores, nor `!=`. And nothing else
		// that names one card does it: `!"Mechtitan"` is 404 there, `cn:` and `game:` echo false.
		for (const q of [
			"oracleid:abc or cmc=3",
			"oracleid:00000000-0000-0000-0000-000000000000 or cmc=3",
			"oracleid:11111111-1111-1111-8111-111111111111 or cmc=3",
			"oracleid:11111111-1111-4111-1111-111111111111 or cmc=3",
			`oracleid:/${MECHTITAN}/ or cmc=3`,
			`oracleid!=${MECHTITAN} or cmc=3`,
			'!"Mechtitan"',
			"cn:14 or cmc=3",
			"game:arena or cmc=3",
		]) {
			expect(gatesClosed(await treeFor(engine, q)), q).toMatchObject({ extra: true });
		}
	});

	test("the oracleid: tree is the one engine/builder/tests/oracle_id_extras.rs answers from real JSON", async () => {
		// That native test builds a store from Mechtitan's and Tithe's real card objects and pins
		// what THIS tree answers (every printing) against the old one (no extras). The fixtures carry
		// the ids asserted here.
		const fixture = (name: string) =>
			JSON.parse(readFileSync(join(import.meta.dir, `../../engine/builder/src/fixtures/${name}.json`), "utf8")) as {
				oracle_id?: string;
				card_faces?: { oracle_id?: string }[];
			};
		const MECHTITAN = fixture("mechtitan_tneo_14").oracle_id as string;
		expect(fixture("mechtitan_sld_1969").card_faces?.map((f) => f.oracle_id)).toEqual([MECHTITAN, MECHTITAN]);
		expect(fixture("tithe_vis_23").oracle_id).toBe(fixture("tithe_wc98_bh23a").oracle_id);
		const engine = new FakeEngine();
		expect(JSON.parse(await treeFor(engine, `oracleid:${MECHTITAN}`))).toEqual({
			node_type: "AndNode",
			kwargs: {
				operands: [
					{
						node_type: "CardBinaryOperatorNode",
						kwargs: {
							lhs: {
								node_type: "CardAttributeNode",
								kwargs: { attribute_name: "oracle_id", original_attribute: "oracleid" },
							},
							op: ":",
							rhs: { node_type: "StringValueNode", kwargs: { value: MECHTITAN } },
						},
					},
					{
						node_type: "NotNode",
						kwargs: {
							operand: {
								node_type: "CardBinaryOperatorNode",
								kwargs: {
									lhs: {
										node_type: "CardAttributeNode",
										kwargs: { attribute_name: "card_is_tags", original_attribute: "is" },
									},
									op: ":",
									rhs: ["variation"],
								},
							},
						},
					},
				],
			},
		});
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
