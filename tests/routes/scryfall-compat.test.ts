// The Scryfall-compatible /cards/* surface: route shapes, error bodies, and the two rules that
// make it a drop-in replacement rather than an approximation — absent keys stay absent, and a
// miss is a Scryfall-shaped 404 rather than this port's routes listing.

import { describe, expect, test } from "bun:test";
import { encodeRulingsBucket, type RulingRow, rulingsBucketKey, rulingsBucketOf } from "../../src/engine/rulings-kv";
import type { RouteContext } from "../../src/routes/registry";
import { toScryfallCard } from "../../src/routes/scryfall-compat/objects";
import { stringifyScryfall } from "../../src/routes/scryfall-compat/respond";
import { FakeEngine, FakeKV, FIXTURE_CARDS, json, makeCtx, testDispatch } from "./harness";

const ctx = makeCtx();

/** POST bodies need a request with one; every other route ignores it. */
function postCtx(body: unknown, engine = new FakeEngine()) {
	return makeCtx({
		engine,
		request: new Request("https://sylvan-librarian.com/cards/collection", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	});
}

describe("GET /cards/search", () => {
	test("answers a Scryfall List object with the cards spliced in", async () => {
		const res = await testDispatch(ctx, "/cards/search?q=elf");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.object).toBe("list");
		expect(body.total_cards).toBe(17);
		// The DO encodes `data`; the route splices the string in without parsing it. If the splice
		// missed, this is the empty array the envelope was built with.
		expect(Array.isArray(body.data)).toBe(true);
		expect((body.data as unknown[]).length).toBeGreaterThan(0);
		expect((body.data as Record<string, unknown>[])[0]?.object).toBe("card");
	});

	test("an empty query is Scryfall's 400, not this port's", async () => {
		const body = await json(await testDispatch(ctx, "/cards/search"));
		expect(body.object).toBe("error");
		expect(body.code).toBe("bad_request");
		// U+2018 in `didn‘t`, and a `warnings: null` beside it: Scryfall writes both, and this is
		// the body a client sees most often after a typo.
		expect(body.details).toBe("You didn\u2018t enter anything to search for.");
		expect(Object.keys(body)).toEqual(["object", "code", "status", "warnings", "details"]);
		expect(body.warnings).toBeNull();
	});

	test("page is Scryfall's to_i-and-clamp, never a rejection", async () => {
		// Measured on api.scryfall.com 2026-08-16: page=0, page=-3, page=abc and page= all serve
		// page 1, and page=2.5 / page=+2 / page=2abc truncate at the first non-digit. This port
		// answered `400 "The page parameter must be a positive integer."` — a sentence Scryfall
		// does not own and a rejection it does not make.
		for (const page of ["0", "-3", "abc", "", "0x2", "1e2", "-0"]) {
			const res = await testDispatch(ctx, `/cards/search?q=elf&page=${page}`);
			expect(res.status).toBe(200);
		}
	});

	test("a page past the end is Scryfall's 422, not a 404", async () => {
		// The two answers say different things and Scryfall gives them different statuses: a query
		// that matched nothing is `404 not_found` at every page, and a page beyond a result that DID
		// match is `422 validation_error`. Answering 404 to both told a paginating client its query
		// had stopped matching.
		const res = await testDispatch(ctx, "/cards/search?q=elf&page=9999");
		expect(res.status).toBe(422);
		const body = await json(res);
		expect(body.code).toBe("validation_error");
		expect(body.details).toBe(
			"You have paginated beyond the end of these results, reduce your `page` parameter or refer to " +
				"the syntax guide at https://scryfall.com/docs/reference",
		);
		// Scryfall's 422 carries no `warnings` key even when terms were ignored.
		expect("warnings" in body).toBe(false);
	});

	test("a query that matched nothing keeps the 404 at every page", async () => {
		const engine = new FakeEngine();
		engine.cards = [];
		engine.totalCards = 0;
		for (const page of ["1", "5"]) {
			const res = await testDispatch(makeCtx({ engine }), `/cards/search?q=elf&page=${page}`);
			expect(res.status).toBe(404);
			expect((await json(res)).code).toBe("not_found");
		}
	});

	test("the no-match body cites docs/reference, which is where Scryfall's points", async () => {
		const engine = new FakeEngine();
		engine.cards = [];
		engine.totalCards = 0;
		const body = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf"));
		expect(body.details).toBe(
			"Your query didn\u2019t match any cards. Adjust your search terms or refer to the syntax guide " +
				"at https://scryfall.com/docs/reference",
		);
	});

	test("a query whose every term was ignored is a 400 carrying the warnings", async () => {
		const res = await testDispatch(ctx, "/cards/search?q=subtype%3Aeldrazi");
		expect(res.status).toBe(400);
		const body = await json(res);
		// Scryfall's key ORDER, warnings before details — measured on the live body.
		expect(Object.keys(body)).toEqual(["object", "code", "status", "warnings", "details"]);
		expect(body.details).toBe("All of your terms were ignored.");
		expect(body.warnings).toEqual([
			"Invalid expression \u201csubtype:eldrazi\u201d was ignored. Unknown keyword \u201csubtype\u201d.",
		]);
	});

	test("a surviving term makes an ignored one a warning on a 200", async () => {
		const engine = new FakeEngine();
		const body = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=f%3Anotaformat+t%3Aelf"));
		expect(body.object).toBe("list");
		expect(body.warnings).toEqual([
			"Invalid expression \u201cf:notaformat\u201d was ignored. Unknown game format \u201cnotaformat\u201d",
		]);
		// The ignored term really left the query rather than being reported and kept.
		expect(engine.lastSearch?.filterTreeJson).not.toContain("legalities");
	});

	test("typographic quotes reach the parser as the quotes they stand for", async () => {
		// Users paste curly quotes constantly; this port answered `400 Failed to parse query` to
		// every one of them while Scryfall folds four characters and searches.
		const engine = new FakeEngine();
		const res = await testDispatch(makeCtx({ engine }), `/cards/search?q=${encodeURIComponent("o:\u201cdraw\u201d")}`);
		expect(res.status).toBe(200);
		const plain = new FakeEngine();
		await testDispatch(makeCtx({ engine: plain }), `/cards/search?q=${encodeURIComponent('o:"draw"')}`);
		expect(engine.lastSearch?.filterTreeJson).toBe(plain.lastSearch?.filterTreeJson as string);
	});

	test("a malformed regex is a 400, never a 5xx", async () => {
		// The engine used to compile this one and its failure escaped as a bare 503 with a non-JSON
		// body — the worst answer a JSON API can give to user-controlled text.
		const res = await testDispatch(ctx, `/cards/search?q=${encodeURIComponent("o:/[unclosed/")}`);
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.warnings).toEqual([
			"Invalid expression \u201co:/[unclosed/\u201d was ignored. " +
				"Invalid regular expression: brackets [] not balanced.",
		]);
	});

	test("unbalanced parentheses get Scryfall's own sentence", async () => {
		const res = await testDispatch(ctx, `/cards/search?q=${encodeURIComponent("e:khm (t:god")}`);
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.details).toBe("Your search contains unclosed parentheses.");
		expect(body.warnings).toBeNull();
	});

	test("a 404 carries no warnings, even when terms were ignored", async () => {
		// Scryfall's not-found body is `{object, code, status, details}` and nothing else, whether or
		// not the query had a term it dropped.
		const engine = new FakeEngine();
		engine.cards = [];
		engine.totalCards = 0;
		const body = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=f%3Anotaformat+t%3Aelf"));
		expect(Object.keys(body)).toEqual(["object", "code", "status", "details"]);
	});

	test("an unrecognized unique mode is silent, as Scryfall's is", async () => {
		for (const unique of ["card", "printing", "printings", "artwork", "bogus"]) {
			const body = await json(await testDispatch(ctx, `/cards/search?q=elf&unique=${unique}`));
			expect(body.warnings).toBeUndefined();
		}
	});

	test("an unknown order warns and falls back to name instead of failing the search", async () => {
		const body = await json(await testDispatch(ctx, "/cards/search?q=elf&order=penny"));
		expect(body.warnings).toEqual(["This server cannot sort by 'penny' yet; sorted by name instead."]);
	});

	test("next_page spells out every effective parameter, not just what was sent", async () => {
		const engine = new FakeEngine();
		engine.totalCards = 1000;
		const body = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf"));
		expect(body.has_more).toBe(true);
		const next = new URL(body.next_page as string);
		expect(next.searchParams.get("page")).toBe("2");
		expect(next.searchParams.get("unique")).toBe("cards");
		expect(next.searchParams.get("order")).toBe("name");
	});

	test("next_page omits dir when it resolves to auto, and spells it out when it does not", async () => {
		// The ONE parameter Scryfall leaves out of next_page. Verified live 2026-08-16:
		// `?dir=asc` echoes `dir=asc`; `?dir=auto` and an absent `dir` both echo no `dir` at all.
		// Spelling `dir=auto` in put every paged next_page one parameter away from Scryfall's,
		// and a client follows that URL verbatim into every later page.
		const engine = new FakeEngine();
		engine.totalCards = 1000;
		const plain = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf"));
		expect(new URL(plain.next_page as string).searchParams.has("dir")).toBe(false);

		const explicitAuto = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&dir=auto"));
		expect(new URL(explicitAuto.next_page as string).searchParams.has("dir")).toBe(false);

		const asc = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&dir=asc"));
		expect(new URL(asc.next_page as string).searchParams.get("dir")).toBe("asc");
	});

	// ─── include_extras ───────────────────────────────────────────────────────
	// Scryfall's default hides memorabilia, un-sets, playtest promos and the "Card" type-line
	// family from `/cards/search` and returns them under `include_extras=true`. It is a QUERY-TIME
	// filter there, and now here: those printings are imported and carry `is:extra`, where they
	// used to be refused at import — which made `include_extras=true` answer nothing at all and
	// `/cards/named` 404 on cards Scryfall serves.

	test("the default ANDs -is:extra AND -is:variation into the filter tree", async () => {
		// Both default gates, in ONE flat AndNode rather than two nested wraps — the caller's own
		// tree stays the first operand whichever gates are closed.
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf");
		const tree = JSON.parse(engine.lastSearch?.filterTreeJson ?? "null");
		expect(tree.node_type).toBe("AndNode");
		expect(tree.kwargs.operands).toHaveLength(3);
		const negated = tree.kwargs.operands.slice(1);
		for (const node of negated) {
			expect(node.node_type).toBe("NotNode");
			expect(node.kwargs.operand.kwargs.lhs.kwargs.attribute_name).toBe("card_is_tags");
		}
		expect(
			negated.map((n: { kwargs: { operand: { kwargs: { rhs: string[] } } } }) => n.kwargs.operand.kwargs.rhs),
		).toEqual([["extra"], ["variation"]]);
	});

	test("include_extras=true leaves the tree alone", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&include_extras=true");
		const tree = JSON.parse(engine.lastSearch?.filterTreeJson ?? "null");
		expect(JSON.stringify(tree)).not.toContain("extra");
	});

	test("a caller's own is:extra term is an UNCONDITIONAL trigger", async () => {
		// `is:extra` is one of the terms Scryfall auto-enables on, so the default conjunct is not
		// added at all and the tree carries the caller's term once. (It used to read `is:extra AND
		// NOT is:extra` — an empty set — which is not what api.scryfall.com answers.)
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=is%3Aextra");
		const json = JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));
		expect(json.split('"extra"').length - 1).toBe(1);
		// The only negation left is the OTHER gate's — `is:extra` does not auto-enable variations.
		expect(json.split("NotNode").length - 1).toBe(1);
		expect(json).toContain('"variation"');
	});

	test("a set term auto-enables extras ONLY when that set has one", async () => {
		// The measured rule, both halves. `q=e:lea` echoes include_extras=true on
		// api.scryfall.com and `is:extra e:lea` is 1 (Crusade); `q=e:khm` echoes false and
		// `is:extra e:khm` is 0. A perfect split over 18 probed sets.
		const engine = new FakeEngine();
		engine.setsWithExtrasList = ["lea"];
		await testDispatch(makeCtx({ engine }), "/cards/search?q=e%3Alea");
		expect(JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"))).not.toContain("extra");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=e%3Akhm");
		expect(JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"))).toContain("extra");
	});

	test("the trigger propagates through or, and and negation", async () => {
		// It is a SYNTACTIC property of the terms, not of the result set: `-e:lea t:land` is true
		// on Scryfall and `-e:war t:land` is false, though neither result can contain an extra.
		const engine = new FakeEngine();
		engine.setsWithExtrasList = ["lea"];
		for (const q of ["-e%3Alea+t%3Aland", "e%3Awar+or+e%3Alea", "(e%3Alea+t%3Acreature)+or+t%3Aland"]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${q}`);
			expect(JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"))).not.toContain('"extra"');
		}
		await testDispatch(makeCtx({ engine }), "/cards/search?q=-e%3Awar+t%3Aland");
		expect(JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"))).toContain('"extra"');
	});

	test("a:, wm:, layout: and t:token trigger unconditionally", async () => {
		// Each fires on the TERM, not on what it matches: `a:"Wesley Burt"` triggers on Scryfall
		// although `a:"Wesley Burt" is:extra` is 0, and `layout:normal` triggers.
		const engine = new FakeEngine();
		for (const q of ["a%3Aguay", "wm%3Amirran", "layout%3Anormal", "t%3Atoken"]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${q}`);
			expect(JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"))).not.toContain('"extra"');
		}
	});

	test("a name: REGEX triggers whether or not the rewrite lowered it to a literal", async () => {
		// The trigger is on the SPELLING, and `lowerLiteralRegexes` erases the spelling: a
		// metacharacter-free `name:/…/` becomes `name:"…"` in the wire tree, byte for byte, because
		// that is upstream's rewrite and the parity fixtures compare it. Measured on
		// api.scryfall.com 2026-08-16: `name:/zzzqq/` matches nothing and STILL echoes
		// `include_extras=true`; `name:/^z/` does too; `name:"zzzqq"` echoes false. The parser hands
		// the lowering out of band (`loweredRegexAttributes`) so all three answer correctly here.
		const engine = new FakeEngine();
		const treeOf = () => JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));

		// Lowered to a literal — the case that used to miss.
		await testDispatch(makeCtx({ engine }), "/cards/search?q=name%3A%2Fzzzqq%2F");
		expect(treeOf()).not.toContain('"extra"');

		// A real pattern, which keeps its RegexValueNode and always did trigger.
		await testDispatch(makeCtx({ engine }), "/cards/search?q=name%3A%2F%5Ez%2F");
		expect(treeOf()).not.toContain('"extra"');

		// The genuinely quoted literal, which must NOT trigger — the half that keeps the fix from
		// being "every name: term forces extras".
		await testDispatch(makeCtx({ engine }), "/cards/search?q=name%3A%22zzzqq%22");
		expect(treeOf()).toContain('"extra"');

		// ...and a lowered regex on ANOTHER column, which Scryfall does not trigger on either.
		await testDispatch(makeCtx({ engine }), "/cards/search?q=o%3A%2Fzzzqq%2F");
		expect(treeOf()).toContain('"extra"');
	});

	test("the SAME lowering suppresses the value triggers, which is the other direction", async () => {
		// One cause, two errors. `t:token cmc=3` is 6 on api.scryfall.com (extras auto-enabled) and
		// `t:/token/ cmc=3` is 0; `is:/extra/ cmc=3` and `border:/silver/ cmc=3` both answer plain
		// `cmc=3` (22,832) and echo `include_extras=false`. After the rewrite all three regex forms
		// are byte-identical to their plain spellings in the wire tree, so only the parser's record
		// of what it lowered can tell them apart.
		const engine = new FakeEngine();
		const treeOf = () => JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));
		for (const q of ["t%3A%2Ftoken%2F", "is%3A%2Fextra%2F", "border%3A%2Fsilver%2F"]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${q}`);
			expect(treeOf(), q).toContain('"extra"'); // the default conjunct is still there
		}
		// A metacharacter keeps the RegexValueNode, and a type regex never triggered anyway.
		await testDispatch(makeCtx({ engine }), "/cards/search?q=t%3A%2F%5Etoken%24%2F");
		expect(treeOf()).toContain('"extra"');
		// The pairs are keyed by column AND value, so a plain trigger beside a lowered regex on the
		// same column still fires.
		await testDispatch(makeCtx({ engine }), "/cards/search?q=t%3Atoken+t%3A%2Fgoblin%2F");
		expect(treeOf()).not.toContain('"extra"');
	});

	test("is:oversized, is:reserved, is:rebalanced and is:glossy trigger; the other is: values do not", async () => {
		// Found by probing all 32 STORED `is:` values this parser supports for the echo, 2026-08-16.
		// The negative half is the load-bearing one: `is:variation` (93 bare vs 97 with the flag),
		// `is:convention` (63 vs 67), `is:judge` (173 vs 176) and `is:league` (6 vs 18) all CONTAIN
		// extras and still echo false, so a rule read off result counts would add them wrongly.
		//
		// `glossy` is the same lesson from the other side. It was left out because it holds NO
		// extras, which makes its count identical either way — and the echo says `true` regardless,
		// because the rule is syntactic. A count cannot measure this; only the echo can.
		const engine = new FakeEngine();
		const treeOf = () => JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));
		for (const value of ["oversized", "reserved", "rebalanced", "glossy"]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=is%3A${value}`);
			expect(treeOf(), value).not.toContain('"extra"');
		}
		for (const value of ["variation", "convention", "judge", "league", "promo", "foil"]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=is%3A${value}`);
			expect(treeOf(), value).toContain('"extra"');
		}
	});

	test("a DERIVED is: fires on the term the caller wrote, not on what it expanded into", async () => {
		// `expandDerivedPredicates` replaces `is:split` with `layout:split` before the wire tree
		// exists, and `layout:` is an unconditional trigger while `is:split` is not: measured on
		// api.scryfall.com 2026-08-16, `is:split` echoes `include_extras=false` and answers 327
		// where `layout:split` echoes `true` and answers 347. All 90 derived values were probed one
		// at a time; twelve fire and 78 do not, and the split follows NO structural rule —
		// `is:mdfc` fires with zero extras in its population, `is:stamped` does not fire with 696.
		const engine = new FakeEngine();
		const treeOf = () => JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));

		// Derived, expands to a trigger, and does NOT fire there — the defect this closes. Every one
		// of these lowers to `layout:`; `has:artist` lowers to `artist:/./` and `is:commander` to a
		// subtree ending in `-banned:commander`, the other two attributes an expansion can leak.
		for (const q of [
			"is:split",
			"is:flip",
			"is:transform",
			"is:tdfc",
			"is:meld",
			"is:leveler",
			"is:adventure",
			"has:artist",
			"is:commander",
		]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${encodeURIComponent(q)}`);
			expect(treeOf(), q).toContain('"extra"'); // the default exclusion survives
		}

		// Derived AND a measured trigger. `has:glossy` is the interesting one: it expands to an
		// `is:glossy` leaf, which the walk must decline to read as the caller's own — and then fires
		// anyway, on the term.
		for (const q of [
			"is:token",
			"is:mdfc",
			"is:dfc",
			"is:planar",
			"is:funny",
			"is:watermark",
			"has:watermark",
			"has:glossy",
		]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${encodeURIComponent(q)}`);
			expect(treeOf(), q).not.toContain('"extra"');
		}

		// The spelling the caller DID write still fires, beside the one they did not: suppression is
		// keyed by column and value, not by column.
		await testDispatch(makeCtx({ engine }), "/cards/search?q=is%3Asplit+layout%3Anormal");
		expect(treeOf()).not.toContain('"extra"');
	});

	// ─── include_variations ───────────────────────────────────────────────────
	// The third of Scryfall's three search parameters, and the last one this route only echoed.
	// Measured with queries that fire no auto-enable: `t:creature` is 51,473 bare and 51,523 with
	// the parameter, `cmc=3` 22,832 against 22,854, `o:draw` 12,301 against 12,303.

	test("include_variations=true drops the -is:variation conjunct and keeps the extras one", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&include_variations=true");
		const json = JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));
		expect(json).not.toContain('"variation"');
		expect(json).toContain('"extra"');
	});

	test("both parameters true leaves the tree alone", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&include_variations=true&include_extras=true");
		const tree = JSON.parse(engine.lastSearch?.filterTreeJson ?? "null");
		expect(JSON.stringify(tree)).not.toContain("NotNode");
	});

	test("a caller's own is:variation term forces the gate, over an explicit false", async () => {
		// The ONLY auto-enable this gate has, and it is a FORCE: `t:creature or is:variation` sent
		// with `include_variations=false` answers 51,566 on api.scryfall.com and echoes `true`.
		const engine = new FakeEngine();
		for (const q of ["is%3Avariation", "is%3Avariation&include_variations=false", "t%3Aelf+or+is%3Avariation"]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${q}`);
			const json = JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));
			expect(json.split('"variation"').length - 1, q).toBe(1);
		}
	});

	test("nothing that auto-enables EXTRAS auto-enables variations", async () => {
		// The two trigger rules are different, and this is the half that would be wrong if the
		// variations gate had simply been pointed at `extrasTriggers`. Each of these echoes
		// `include_extras=true include_variations=false` on api.scryfall.com; a SET term does not
		// enable it either (`e:hho` is 21 bare and 23 only with the parameter).
		const engine = new FakeEngine();
		engine.setsWithExtrasList = ["hho"];
		for (const q of [
			"a%3Aguay",
			"wm%3Amirran",
			"layout%3Anormal",
			"t%3Atoken",
			"is%3Aextra",
			"is%3Aoversized",
			"e%3Ahho",
		]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${q}`);
			expect(JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null")), q).toContain('"variation"');
		}
	});

	test("next_page echoes the RESOLVED include_variations", async () => {
		const engine = new FakeEngine();
		engine.totalCards = 1000;
		const res = await testDispatch(makeCtx({ engine }), "/cards/search?q=is%3Avariation&include_variations=false");
		const body = (await res.json()) as { next_page?: string };
		expect(new URL(body.next_page ?? "http://x/").searchParams.get("include_variations")).toBe("true");

		const plain = await testDispatch(makeCtx({ engine }), "/cards/search?q=elf");
		const plainBody = (await plain.json()) as { next_page?: string };
		expect(new URL(plainBody.next_page ?? "http://x/").searchParams.get("include_variations")).toBe("false");
	});

	test("border:silver triggers extras and every other border value does not", async () => {
		// `border:gold` is the control, and the reason this is a trigger rather than a coincidence:
		// every gold border is a World Championship card, so the whole population is memorabilia —
		// it answers 0 bare and 1,373 with `include_extras=true`, which is what a NON-trigger on
		// this attribute looks like. `border:silver` answers 665 both ways and echoes true unsent,
		// with only 108 of the 665 inside `is:extra`.
		const engine = new FakeEngine();
		const treeOf = () => JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));
		await testDispatch(makeCtx({ engine }), "/cards/search?q=border%3Asilver");
		expect(treeOf()).not.toContain('"extra"');
		for (const value of ["gold", "black", "white", "borderless"]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=border%3A${value}`);
			expect(treeOf(), value).toContain('"extra"');
		}
		await testDispatch(makeCtx({ engine }), "/cards/search?q=frame%3A2015");
		expect(treeOf()).toContain('"extra"');
	});

	test("banned: triggers at every value, and f: only at premodern", async () => {
		// Both bind to `card_legalities`, so the alias separates them. `banned:` fires wholesale
		// (legacy/vintage/modern/pauper all echo true) while `restricted:vintage` does not; and of
		// the 21 format values probed one at a time, `premodern` is the only one that fires —
		// `legal:premodern` fires too, so it is the value rather than the alias.
		const engine = new FakeEngine();
		const treeOf = () => JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"));
		for (const q of [
			"banned%3Alegacy",
			"banned%3Avintage",
			"f%3Apremodern",
			"format%3Apremodern",
			"legal%3Apremodern",
		]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${q}`);
			expect(treeOf(), q).not.toContain('"extra"');
		}
		for (const q of ["restricted%3Avintage", "f%3Apauper", "f%3Alegacy", "legal%3Astandard"]) {
			await testDispatch(makeCtx({ engine }), `/cards/search?q=${q}`);
			expect(treeOf(), q).toContain('"extra"');
		}
	});

	test("a set-type term does NOT auto-enable extras", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=st%3Amemorabilia");
		expect(JSON.stringify(JSON.parse(engine.lastSearch?.filterTreeJson ?? "null"))).toContain("extra");
	});

	test("next_page echoes the RESOLVED include_extras, not the parameter as sent", async () => {
		// `q=e:lea&include_extras=false` echoes `include_extras=true` on api.scryfall.com AND
		// returns the extras. Echoing the raw parameter made the link contradict its own page.
		const engine = new FakeEngine();
		engine.setsWithExtrasList = ["lea"];
		engine.totalCards = 1000;
		const res = await testDispatch(makeCtx({ engine }), "/cards/search?q=e%3Alea&include_extras=false");
		const body = (await res.json()) as { next_page?: string };
		expect(new URL(body.next_page ?? "http://x/").searchParams.get("include_extras")).toBe("true");
	});

	test("is:extra is a SUPPORTED value — it filters rather than warning", async () => {
		const engine = new FakeEngine();
		const res = await testDispatch(makeCtx({ engine }), "/cards/search?q=is%3Aextra&include_extras=true");
		const body = (await res.json()) as { warnings?: string[] };
		expect((body.warnings ?? []).join(" ")).not.toContain("extra");
	});

	test("include_multilingual=true threads into the engine options", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&include_multilingual=true");
		expect(engine.lastSearch?.includeMultilingual).toBe(true);
	});

	test("the default is FALSE — Scryfall's English/canonical-only lane — and is sent explicitly", async () => {
		// Explicitly false rather than absent: the wire contract is that the route always states
		// the lane, so "absent" never grows a meaning of its own inside the engine.
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf");
		expect(engine.lastSearch?.includeMultilingual).toBe(false);
	});

	test("unrecognized spellings read as false, like every other boolean param here", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&include_multilingual=banana");
		expect(engine.lastSearch?.includeMultilingual).toBe(false);
	});

	// ── In-query directives (upstream #893) ──────────────────────────────────
	//
	// The parser has always STRIPPED these from the tree; this route then dropped what it was
	// handed, so a directive was a silent no-op. Measured against api.scryfall.com 2026-08-16:
	// `is:foil e:khm unique:prints` returns 387 there (the unique-PRINTS count) against 285 for
	// `is:foil e:khm`, and this route answered 285.
	test("an in-query directive reaches the engine options", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20unique%3Aprints");
		expect(engine.lastSearch?.unique).toBe("printing");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20order%3Acmc");
		expect(engine.lastSearch?.orderby).toBe("cmc");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20sort%3Areleased");
		expect(engine.lastSearch?.orderby).toBe("released");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20dir%3Adesc");
		expect(engine.lastSearch?.direction).toBe("desc");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20direction%3Adesc");
		expect(engine.lastSearch?.direction).toBe("desc");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20prefer%3Aoldest");
		expect(engine.lastSearch?.prefer).toBe("oldest");
	});

	test("a directive OVERRIDES the query parameter, in both directions", async () => {
		// Measured, not assumed (api.scryfall.com, 2026-08-16):
		//   q=is:foil e:khm unique:prints & unique=cards  -> 387, the PRINTS count
		//   q=is:foil e:khm unique:cards  & unique=prints -> 285, the CARDS count
		//   q=… order:cmc & order=name                    -> sorted by cmc
		//   q=… dir:desc  & dir=asc                       -> descending
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20unique%3Aprints&unique=cards");
		expect(engine.lastSearch?.unique).toBe("printing");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20unique%3Acards&unique=prints");
		expect(engine.lastSearch?.unique).toBe("card");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20order%3Acmc&order=name");
		expect(engine.lastSearch?.orderby).toBe("cmc");

		await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20dir%3Adesc&dir=asc");
		expect(engine.lastSearch?.direction).toBe("desc");
	});

	test("next_page lowercases q and collapses its whitespace, like Scryfall", async () => {
		// Measured 2026-08-16: `E:KHM T:Creature OR T:Land` comes back as
		// `q=e:khm t:creature or t:land`, `a:"Rebecca Guay"` as `a:"rebecca guay"` (inside the
		// quotes), `o:/^Whenever/` as `o:/^whenever/`, `name:Éowyn` as `name:éowyn`, and a query
		// with doubled or edge whitespace comes back trimmed and collapsed.
		const engine = new FakeEngine();
		engine.totalCards = 1000;
		const body = await json(
			await testDispatch(makeCtx({ engine }), "/cards/search?q=%20%20E%3AKHM%20%20T%3ACreature%20OR%20T%3ALand%20"),
		);
		expect(new URL(body.next_page as string).searchParams.get("q")).toBe("e:khm t:creature or t:land");
	});

	test("an order Scryfall serves and this server cannot keeps its own spelling in next_page", async () => {
		// `penny` and `review` fall back to `name` here and Scryfall sorts by them, so Scryfall's
		// echo says `order=penny`. Echoing `name` would round-trip fine (page 2 falls back the
		// same way) but differ from Scryfall for nothing. `cubecobra` is the deliberate opposite:
		// Scryfall echoes `name` because it has no such ordering, and echoing `name` here would
		// hand back a link that pages by NAME after a page ordered by cubecobra.
		const engine = new FakeEngine();
		engine.totalCards = 1000;
		const penny = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&order=penny"));
		expect(new URL(penny.next_page as string).searchParams.get("order")).toBe("penny");

		const cube = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&order=cubecobra"));
		expect(new URL(cube.next_page as string).searchParams.get("order")).toBe("cubecobra");

		// An order NEITHER side has resolves to name on both.
		const bogus = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf&order=nosuchorder"));
		expect(new URL(bogus.next_page as string).searchParams.get("order")).toBe("name");
	});

	test("next_page echoes the RESOLVED order and unique, not the raw parameters", async () => {
		// Scryfall's own echo, measured 2026-08-16: `q=t:creature order:cmc unique:prints` with no
		// order/unique parameters at all answers a next_page carrying `order=cmc&unique=prints`,
		// and `q=t:creature dir:desc` carries `dir=desc`. `q` echoes verbatim, directive included,
		// so the two have to agree — otherwise page 2 pages a different result set than page 1.
		const engine = new FakeEngine();
		engine.totalCards = 1000;
		const body = await json(
			await testDispatch(makeCtx({ engine }), "/cards/search?q=elf%20order%3Acmc%20unique%3Aprints%20dir%3Adesc"),
		);
		const next = new URL(body.next_page as string);
		expect(next.searchParams.get("order")).toBe("cmc");
		expect(next.searchParams.get("unique")).toBe("prints");
		expect(next.searchParams.get("dir")).toBe("desc");
		expect(next.searchParams.get("q")).toBe("elf order:cmc unique:prints dir:desc");
	});

	// has_more's FALSE branch, which nothing pinned while the page count was recovered by walking
	// the encoded cards. It is now `rowCount` off the engine result (EngineSerializedResult), so a
	// producer that forgets to set it would silently report a last page as having a next one.
	test("a result set that fits on one page has no next page", async () => {
		const engine = new FakeEngine();
		engine.totalCards = FIXTURE_CARDS.length;
		const body = await json(await testDispatch(makeCtx({ engine }), "/cards/search?q=elf"));
		expect(body.total_cards).toBe(FIXTURE_CARDS.length);
		expect((body.data as unknown[]).length).toBe(FIXTURE_CARDS.length);
		expect(body.has_more).toBe(false);
		expect(body.next_page).toBeUndefined();
	});
});

describe("GET /cards/named", () => {
	test("exact matches on the folded name", async () => {
		const body = await json(await testDispatch(ctx, "/cards/named?exact=Llanowar%20Elves"));
		expect(body.object).toBe("card");
		expect(body.name).toBe("Llanowar Elves");
	});

	test("neither exact nor fuzzy is a 400", async () => {
		const res = await testDispatch(ctx, "/cards/named");
		expect(res.status).toBe(400);
		expect((await json(res)).details).toBe("You must provide a `fuzzy` or `exact` parameter");
	});

	test("a miss is Scryfall's 404 with the name quoted", async () => {
		const res = await testDispatch(ctx, "/cards/named?exact=Not%20A%20Card");
		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body.object).toBe("error");
		expect(body.details).toContain("No cards found matching");
	});

	test("ambiguous is a not_found carrying a type, exactly as Scryfall spells it", async () => {
		const engine = new FakeEngine();
		engine.scryfallExactNames = [];
		engine.scryfallFuzzyStatus = "ambiguous";
		const res = await testDispatch(makeCtx({ engine }), "/cards/named?fuzzy=zzzz%20qqqq");
		expect(res.status).toBe(404);
		const body = await json(res);
		// Measured on api.scryfall.com (`fuzzy=aust com`, 2026-08-16): the code is the coarse
		// class and `type` is what tells a client "refine" from "does not exist". The mirror sent
		// `code: "ambiguous"` with no type, which is what the named-fuzzy-aust-com live-parity
		// deviation recorded.
		expect(body.code).toBe("not_found");
		expect(body.type).toBe("ambiguous");
		expect(body.details).toContain("Too many cards match ambiguous name");
	});

	test("format=text renders rather than answering JSON", async () => {
		const res = await testDispatch(ctx, "/cards/named?exact=Llanowar%20Elves&format=text");
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(await res.text()).toContain("Llanowar Elves");
	});

	test("format=image redirects to the CDN", async () => {
		const res = await testDispatch(ctx, "/cards/named?exact=Llanowar%20Elves&format=image");
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("cards.scryfall.io");
	});
});

describe("GET /cards/autocomplete", () => {
	test("answers a Catalog object", async () => {
		const body = await json(await testDispatch(ctx, "/cards/autocomplete?q=llan"));
		expect(body.object).toBe("catalog");
		expect(body.data).toEqual(["Llanowar Elves"]);
		expect(body.total_values).toBe(1);
	});

	test("under two characters is an empty catalog, not a corpus scan", async () => {
		const engine = new FakeEngine();
		const body = await json(await testDispatch(makeCtx({ engine }), "/cards/autocomplete?q=l"));
		expect(body.total_values).toBe(0);
		expect(engine.lastAutocomplete).toBeNull();
	});

	// The engine matches `card_name_folded`, so the needle has to arrive folded or an ASCII query
	// can never reach a name carrying diacritics. Unfolded, `q=eowyn` answered an EMPTY catalog
	// while `q=éowyn` answered three cards — against Scryfall, which answers both. Asserted on what
	// the ENGINE receives rather than on results, because the fixture corpus has no accented names
	// and a result-shaped test would pass just as well without the fold.
	test.each([
		["É" + "owyn", "eowyn"],
		["Jötun", "jotun"],
		["Lim-Dûl", "lim-dul"],
		["LLAN", "llan"],
	])("folds and lowercases %p before the engine sees it", async (query, expected) => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), `/cards/autocomplete?q=${encodeURIComponent(query)}`);
		expect(engine.lastAutocomplete?.prefix).toBe(expected);
	});
});

describe("GET /cards/random", () => {
	test("carries Scryfall's no-cache — a cached random card is one card forever", async () => {
		// Its own engine, whose count agrees with its rows: the route draws at a random offset in
		// `totalCards`, and the shared fake reports more cards than it holds.
		const engine = new FakeEngine();
		engine.totalCards = engine.cards.length;
		const res = await testDispatch(makeCtx({ engine }), "/cards/random");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
	});

	test("stays on the default-English lane — no include_multilingual in its engine options", async () => {
		// The route takes no include_multilingual parameter (Scryfall's doesn't either); a `lang:`
		// term in q widens inside the engine, so the option is simply never set here.
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/random?q=elf");
		expect(engine.lastSearch?.includeMultilingual).toBeUndefined();
	});

	// ── the extras gate, which this route ran without until 2026-08-17 ──────────
	//
	// MEASURED on api.scryfall.com the same day, two requests: `t:goblin cmc=0` fires no trigger
	// and holds nothing but extras, and `/cards/random` answers 404 for it bare and a token
	// (q07/T12) with `include_extras=true`. Same rule as `/cards/search`, same module.

	test("q draws from the gated corpus — the same conjunct /cards/search adds", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/random?q=lightning+bolt");
		// Both draws (count, then the offset read) see the gated tree, not just the first.
		expect(engine.lastSearch?.filterTreeJson).toContain('"extra"');
		expect(engine.lastSearch?.filterTreeJson).toContain('"variation"');
	});

	test("include_extras=true is honored here, because api.scryfall.com honors it here", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/cards/random?q=lightning+bolt&include_extras=true");
		const json = engine.lastSearch?.filterTreeJson ?? "";
		expect(json).not.toContain('"extra"');
		expect(json).toContain('"variation"');
	});

	test("a trigger term auto-enables the gate here too", async () => {
		const engine = new FakeEngine();
		engine.setsWithExtrasList = ["lea"];
		await testDispatch(makeCtx({ engine }), "/cards/random?q=e%3Alea");
		expect(engine.lastSearch?.filterTreeJson).not.toContain('"extra"');
		await testDispatch(makeCtx({ engine }), "/cards/random?q=e%3Akhm");
		expect(engine.lastSearch?.filterTreeJson).toContain('"extra"');
	});

	test("the bare draw stays UNGATED — deliberately, and not measured", async () => {
		// Scryfall's own bare `/cards/random` was never established either way: it echoes nothing,
		// and separating a ~10% extras share from zero would take tens of draws from an endpoint
		// that rate-limits this repo. The whole-corpus draw is what this route has always done, so
		// it is what it keeps doing until somebody measures the other side. See the handler.
		const engine = new FakeEngine();
		engine.totalCards = engine.cards.length;
		await testDispatch(makeCtx({ engine }), "/cards/random");
		expect(engine.lastSearch?.filterTreeJson).not.toContain('"extra"');
	});
});

describe("cache headers", () => {
	// Measured against api.scryfall.com rather than guessed. This surface exists so a client can
	// change one base URL, and how long it may reuse a response is part of what it observes — an
	// uncached /cards/* would also put every request through the Worker and the Durable Object,
	// against a 100k/day allowance, on the surface mtg-seeker actually calls.
	test.each([
		["/cards/search?q=elf", "public, max-age=57600"],
		["/cards/aaaaaaaa-0000-4000-8000-000000000001", "public, max-age=57600"],
		["/cards/m15/18", "public, max-age=57600"],
		["/cards/multiverse/12345", "public, max-age=57600"],
		["/cards/autocomplete?q=llan", "public, max-age=57600"],
		["/cards", "public, max-age=57600"],
	])("%s is Scryfall's 16-hour tier", async (path, expected) => {
		expect((await testDispatch(ctx, path)).headers.get("Cache-Control")).toBe(expected);
	});

	test("named gets the same tier, not Scryfall's 48 hours", async () => {
		// A card object embeds `prices` and this store rebuilds nightly, so 172800 would let a
		// client hold prices from two imports ago with nothing in the response to say so — and
		// `named` returns the same object every other route here does.
		const res = await testDispatch(ctx, "/cards/named?exact=Llanowar%20Elves");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=57600");
	});

	test("the tier rides on error responses, as Scryfall's does", async () => {
		// Measured: an empty-query 400 comes back with the route's own max-age, and a `named` miss
		// with the full tier rather than no-store.
		expect((await testDispatch(ctx, "/cards/search")).headers.get("Cache-Control")).toBe("public, max-age=57600");
		expect((await testDispatch(ctx, "/cards/named?exact=Nope")).headers.get("Cache-Control")).toBe(
			"public, max-age=57600",
		);
	});

	test("a 500 is no-store, unlike every other status here", async () => {
		// Deterministic-in-the-URL answers are safe to cache for hours; an engine failure is not.
		// Caching it alongside them would pin a transient outage into every edge for 16 hours.
		const engine = new FakeEngine();
		engine.searchError = new Error("wasm trap");
		const res = await testDispatch(makeCtx({ engine }), "/cards/search?q=elf");
		expect(res.status).toBe(500);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	test("the collection POST is private and must-revalidate, and its REFUSALS are no-cache", async () => {
		// A shared cache keys on the URL, and this route's answer depends entirely on the BODY.
		const ok = await testDispatch(
			postCtx({ identifiers: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] }),
			"/cards/collection",
			"POST",
		);
		expect(ok.headers.get("Cache-Control")).toBe("max-age=0, private, must-revalidate");
		// An empty list is a 400 now, and Scryfall answers every collection 400 with `no-cache`
		// rather than the route's own tier (measured 2026-08-16 across all five of its messages).
		const refused = await testDispatch(postCtx({ identifiers: [] }), "/cards/collection", "POST");
		expect(refused.status).toBe(400);
		expect(refused.headers.get("Cache-Control")).toBe("no-cache");
	});

	test("/search keeps its own tier — the two surfaces have no reason to agree", async () => {
		expect((await testDispatch(ctx, "/search?q=elf")).headers.get("Cache-Control")).toBe(
			"public, max-age=90, stale-while-revalidate=86400",
		);
	});
});

describe("POST /cards/collection", () => {
	test("resolves identifiers and reports the ones that matched nothing", async () => {
		const known = "aaaaaaaa-0000-4000-8000-000000000001";
		const body = await json(
			await testDispatch(
				postCtx({ identifiers: [{ id: known }, { id: "bbbbbbbb-0000-4000-8000-000000000009" }] }),
				"/cards/collection",
				"POST",
			),
		);
		expect(body.object).toBe("list");
		expect((body.data as unknown[]).length).toBe(1);
		expect(body.not_found).toEqual([{ id: "bbbbbbbb-0000-4000-8000-000000000009" }]);
	});

	test("{set, collector_number} resolves the ENGLISH printing when a foreign row shares the address", async () => {
		// THE silent-regression trap once foreign rows share set+number (the fixture ja row shares
		// m15/18 with the en row, and sits FIRST in the fake's lookup order): the identifier has no
		// lang field — Scryfall's collection docs define none — so the tree it builds must pin
		// `card_lang == "en"` implicitly. A resolver that dropped that clause answers the ja row.
		const body = await json(
			await testDispatch(
				postCtx({ identifiers: [{ set: "m15", collector_number: "18" }] }),
				"/cards/collection",
				"POST",
			),
		);
		const data = body.data as Record<string, unknown>[];
		expect(data.length).toBe(1);
		expect(data[0]?.lang).toBe("en");
		expect(data[0]?.id).toBe("aaaaaaaa-0000-4000-8000-000000000002");
		expect(body.not_found).toEqual([]);
	});

	test("two identifiers naming one card answer TWICE — `data` is one entry per identifier", async () => {
		// The opposite of what this port used to do. Measured 2026-08-16: three identical `{id}`
		// identifiers return three card objects and 75 identical `{name}` identifiers return 75, so
		// `data` answers the list that was sent rather than the set of cards it names. Deduplicating
		// broke the one thing the route is for — a deck list with four copies of a card got three
		// fewer objects back than it had rows to fill, with nothing saying so.
		const known = "aaaaaaaa-0000-4000-8000-000000000001";
		const body = await json(
			await testDispatch(postCtx({ identifiers: [{ id: known }, { id: known }] }), "/cards/collection", "POST"),
		);
		expect((body.data as unknown[]).length).toBe(2);
	});

	test("the envelope is {object, not_found, data} — no has_more", async () => {
		// Scryfall does not paginate this List and does not send `has_more` on it (measured
		// 2026-08-16). The port used to reuse the search envelope, which always writes the key;
		// `collectionList` is the variant that does not. Key ORDER is asserted too, because the
		// envelope has one definition and a reordering there would reach both surfaces.
		const known = "aaaaaaaa-0000-4000-8000-000000000001";
		const res = await testDispatch(postCtx({ identifiers: [{ id: known }] }), "/cards/collection", "POST");
		const body = await json(res);
		expect(Object.keys(body)).toEqual(["object", "not_found", "data"]);
		expect("has_more" in body).toBe(false);
	});

	test("an EMPTY identifiers list is a 400, not an empty List", async () => {
		// Scryfall's bound is "at least 1 and no more than 75", and it means the lower half too
		// (measured 2026-08-16): `{"identifiers": []}` is a `400 bad_request` carrying the same
		// sentence a 76-long list gets. This port answered `200 {"data": []}`, which told the client
		// its (empty) question had an (empty) answer.
		const res = await testDispatch(postCtx({ identifiers: [] }), "/cards/collection", "POST");
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.code).toBe("bad_request");
		expect(body.details).toBe("The `identifiers` list must have at least 1 and no more than 75 references.");
	});

	test("a non-object entry earns the COUNT sentence, not an identifier complaint", async () => {
		// `[null]` and `["Lightning Bolt"]` both measured: Scryfall validates the list's shape before
		// any identifier's, so a bare string in the list reads as "this is not a list of references".
		for (const entry of [null, "Lightning Bolt", ["nested"]]) {
			const res = await testDispatch(postCtx({ identifiers: [entry] }), "/cards/collection", "POST");
			expect(res.status).toBe(400);
			expect((await json(res)).details).toBe(
				"The `identifiers` list must have at least 1 and no more than 75 references.",
			);
		}
	});

	test("an identifier whose keys name no lookup is `Invalid identifier schema`", async () => {
		// Every string here is measured, including the tail: it lists the RECOGNIZED keys the
		// identifier does carry, so a half-built `{set}` says "set" and a wholly wrong `{arena_id}`
		// says nothing. `arena_id` is the case worth having — it is a real key on a card object and
		// simply not a collection identifier, so a client reaching for it used to be told the card
		// does not exist.
		const cases: [unknown, string][] = [
			[{ arena_id: 67330 }, ""],
			[{}, ""],
			[{ nonsense: "x" }, ""],
			[{ set: "khm" }, "set"],
			[{ set: "khm", lang: "ja" }, "set"],
			[{ set: "khm", zzz: 1 }, "set"],
			[{ collector_number: "1" }, "collector_number"],
			[{ collector_number: "1", lang: "en" }, "collector_number"],
		];
		for (const [ident, tail] of cases) {
			const res = await testDispatch(postCtx({ identifiers: [ident] }), "/cards/collection", "POST");
			expect(res.status).toBe(400);
			const body = await json(res);
			expect(body.code).toBe("bad_request");
			expect(body.details).toBe(`Invalid identifier schema: ${tail}`);
		}
	});

	test("a complete schema resolves whatever else rides with it, in any key order", async () => {
		// `lang` is accepted and IGNORED — measured on `{set: khm, collector_number: 40, lang: ja}`,
		// which returns the English card. An unrecognized key beside a valid schema is ignored too.
		for (const ident of [
			{ id: "aaaaaaaa-0000-4000-8000-000000000001" },
			{ id: "aaaaaaaa-0000-4000-8000-000000000001", zzz: 1 },
			{ name: "Llanowar Elves", collector_number: "999" },
			{ collector_number: "314", set: "m19" },
			{ set: "m19", collector_number: "314", lang: "ja" },
		]) {
			const res = await testDispatch(postCtx({ identifiers: [ident] }), "/cards/collection", "POST");
			expect(res.status).toBe(200);
		}
	});

	test("a non-integer `mtgo_id` or `multiverse_id` is its own 400", async () => {
		for (const key of ["mtgo_id", "multiverse_id"]) {
			const res = await testDispatch(postCtx({ identifiers: [{ [key]: "abc" }] }), "/cards/collection", "POST");
			expect(res.status).toBe(400);
			expect((await json(res)).details).toBe(`A \`${key}\` identifier must be an integer: abc`);
		}
	});

	test("collection_uuid_rule_is_v4_shape_not_the_zero_value", async () => {
		// The rule measured against api.scryfall.com on 2026-08-16 (see COLLECTION_UUID_RE): a
		// malformed identifier UUID is a 400 for the whole request, and the boundary is RFC 4122
		// VERSION 4 SHAPE — not the all-zero VALUE, and not "unknown card".
		const cases: { id: string; status: number; why: string }[] = [
			// Rejected: every non-4 version nibble, and every variant nibble outside [89ab].
			{ id: "00000000-0000-0000-0000-000000000000", status: 400, why: "nil uuid: version 0" },
			{ id: "00000000-0000-0000-0000-000000000001", status: 400, why: "not the zero VALUE: version 0" },
			{ id: "10000000-0000-0000-0000-000000000000", status: 400, why: "version 0" },
			{ id: "3f2c8e5d-91b7-1a6e-bd12-4f5a9c7e8b01", status: 400, why: "version 1" },
			{ id: "3f2c8e5d-91b7-7a6e-bd12-4f5a9c7e8b01", status: 400, why: "version 7" },
			{ id: "3f2c8e5d-91b7-4a6e-cd12-4f5a9c7e8b01", status: 400, why: "variant c" },
			{ id: "3f2c8e5d-91b7-4a6e-0d12-4f5a9c7e8b01", status: 400, why: "variant 0" },
			{ id: "not-a-uuid", status: 400, why: "not a uuid at all" },
			{ id: "", status: 400, why: "empty string" },
			{ id: "7673784edb4b43a18d551bb9fc1e284f", status: 400, why: "no dashes" },
			// Accepted, and therefore answered in not_found rather than 400: the ZERO value wearing
			// v4's nibbles, and an ordinary unknown v4. This pair is the whole point of the case.
			{ id: "00000000-0000-4000-8000-000000000000", status: 200, why: "zero value, v4 shape" },
			{ id: "3f2c8e5d-91b7-4a6e-9d12-4f5a9c7e8b01", status: 200, why: "valid, unknown: variant 9" },
			{ id: "3f2c8e5d-91b7-4a6e-bd12-4f5a9c7e8b01", status: 200, why: "valid, unknown: variant b" },
		];
		for (const { id, status, why } of cases) {
			const res = await testDispatch(postCtx({ identifiers: [{ id }] }), "/cards/collection", "POST");
			expect(`${why}: ${res.status}`).toBe(`${why}: ${status}`);
			const body = await json(res);
			if (status === 400) {
				expect(body.code).toBe("bad_request");
				expect(body.object).toBe("error");
			} else {
				expect(body.not_found).toEqual([{ id }]);
				expect(body.data).toEqual([]);
			}
		}
	});

	test("a malformed UUID reports the offending key and value, truncated as Scryfall truncates it", async () => {
		const res = await testDispatch(
			postCtx({ identifiers: [{ id: "00000000-0000-0000-0000-000000000000" }] }),
			"/cards/collection",
			"POST",
		);
		// 30 characters then U+2026 — measured, and a short value is echoed whole.
		expect((await json(res)).details).toBe("An `id` identifier must be a valid UUID: 00000000-0000-0000-0000-000000…");
		const short = await json(
			await testDispatch(postCtx({ identifiers: [{ oracle_id: "not-a-uuid" }] }), "/cards/collection", "POST"),
		);
		expect(short.details).toBe("An `oracle_id` identifier must be a valid UUID: not-a-uuid");
	});

	test("one malformed identifier 400s the whole batch, wherever it sits", async () => {
		const known = { id: "aaaaaaaa-0000-4000-8000-000000000001" };
		const bad = { id: "00000000-0000-0000-0000-000000000000" };
		for (const identifiers of [
			[known, bad],
			[bad, known],
		]) {
			const res = await testDispatch(postCtx({ identifiers }), "/cards/collection", "POST");
			expect(res.status).toBe(400);
			// The FIRST malformed identifier is the one reported, not the first identifier.
			expect((await json(res)).details).toContain("00000000-0000-0000-0000-000000");
		}
	});

	test("non-UUID identifier kinds are untouched by the UUID rule", async () => {
		// `{set, collector_number}` with nonsense is a MISS, not a bad request (measured: Scryfall
		// answers 200 with it in not_found). Only the three UUID-typed keys are shape-checked.
		const body = await json(
			await testDispatch(
				postCtx({ identifiers: [{ set: "khm", collector_number: "zzz" }, { name: "Definitely Not A Real Card" }] }),
				"/cards/collection",
				"POST",
			),
		);
		expect(body.object).toBe("list");
		expect((body.not_found as unknown[]).length).toBe(2);
	});

	test("past the cap is Scryfall's 400, not a truncated answer and not a 422", async () => {
		// The cap check runs BEFORE identifier validation — these 76 carry `{id: "x"}`, which is not
		// a valid UUID, and the count sentence still wins.
		const identifiers = Array.from({ length: 76 }, () => ({ id: "x" }));
		const res = await testDispatch(postCtx({ identifiers }), "/cards/collection", "POST");
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.code).toBe("bad_request");
		expect(body.details).toBe("The `identifiers` list must have at least 1 and no more than 75 references.");
	});

	test("a missing and a non-array `identifiers` get DIFFERENT 400s", async () => {
		// Measured 2026-08-16: an absent list reads as an empty one and gets the count sentence,
		// while a present-but-not-a-list one gets its own. This port sent the same `422
		// validation_error` with wording of its own to both.
		const missing = await testDispatch(postCtx({ nope: true }), "/cards/collection", "POST");
		expect(missing.status).toBe(400);
		expect((await json(missing)).details).toBe(
			"The `identifiers` list must have at least 1 and no more than 75 references.",
		);
		const notArray = await testDispatch(postCtx({ identifiers: {} }), "/cards/collection", "POST");
		expect(notArray.status).toBe(400);
		expect((await json(notArray)).details).toBe("The `identifiers` list must be a JSON array.");
	});

	test("GET is not allowed, and says so the way Scryfall says it", async () => {
		// api.scryfall.com answers 404 here, not 405, and sends no `Allow` — measured 2026-08-16.
		const res = await testDispatch(ctx, "/cards/collection");
		expect(res.status).toBe(404);
		expect(res.headers.get("Allow")).toBeNull();
		expect((await json(res)).code).toBe("not_found");
	});
});

describe("GET /cards and /cards/...", () => {
	test("/cards paginates every card", async () => {
		const body = await json(await testDispatch(ctx, "/cards"));
		expect(body.object).toBe("list");
		expect(body.total_cards).toBe(17);
	});

	test("/cards/:id answers a card object", async () => {
		const body = await json(await testDispatch(ctx, "/cards/aaaaaaaa-0000-4000-8000-000000000001"));
		expect(body.object).toBe("card");
	});

	test("/cards/:id with a non-UUID is a 404, not a set-code lookup", async () => {
		const res = await testDispatch(ctx, "/cards/not-a-uuid");
		expect(res.status).toBe(404);
		expect((await json(res)).object).toBe("error");
	});

	test("/cards/:namespace/:id addresses an external id", async () => {
		const body = await json(await testDispatch(ctx, "/cards/multiverse/12345"));
		expect(body.object).toBe("card");
	});

	test("/cards/:code/:number defaults to the ENGLISH printing when a foreign row shares the address", async () => {
		// The language rides IN THE QUERY (`card_lang == "en"` when the segment is absent), like
		// upstream's SQL filter. The fixture ja row shares m15/18 with the en row and sits FIRST in
		// the fake's lookup order, so a resolver that dropped the implicit English would answer a
		// card object saying lang: ja at a URL Scryfall defines as English.
		const body = await json(await testDispatch(ctx, "/cards/m15/18"));
		expect(body.object).toBe("card");
		expect(body.lang).toBe("en");
		expect(body.id).toBe("aaaaaaaa-0000-4000-8000-000000000002");
	});

	test("/cards/:code/:number/:lang resolves the named foreign printing", async () => {
		const body = await json(await testDispatch(ctx, "/cards/m15/18/ja"));
		expect(body.object).toBe("card");
		expect(body.lang).toBe("ja");
		expect(body.id).toBe("aaaaaaaa-0000-4000-8000-000000000003");
	});

	test("a language no printing carries 404s rather than answering another one", async () => {
		// Answering the English card for /de would be a card object that says lang: en at a URL
		// that asked for German — same 404 as upstream, now produced by the query itself.
		const res = await testDispatch(ctx, "/cards/m15/18/de");
		expect(res.status).toBe(404);
	});

	test("a foreign-only printing misses in English and resolves by its own language", async () => {
		// The pt-only fixture: the default-English lookup must MISS rather than substitute the
		// foreign row, and the /:lang form must find it.
		expect((await testDispatch(ctx, "/cards/grn/212")).status).toBe(404);
		const body = await json(await testDispatch(ctx, "/cards/grn/212/pt"));
		expect(body.object).toBe("card");
		expect(body.lang).toBe("pt");
	});

	test("a miss carries the body Scryfall words for that SHAPE, not one generic string", async () => {
		// Measured against api.scryfall.com on 2026-08-12. Upstream answers all of these with one
		// generic body, and that body is not even the generic one Scryfall sends — it carries a
		// "Please double-check your URI and try again." tail Scryfall does not.
		const cases: [string, string][] = [
			// The path addresses nothing at all.
			["/cards/not-a-uuid", "The requested object or REST method was not found."],
			["/cards/multiverse", "The requested object or REST method was not found."],
			// A well-formed address that resolves to no card.
			[
				"/cards/aaaaaaaa-0000-4000-8000-00000000dead",
				"No card found with the given ID or set code and collector number.",
			],
			["/cards/multiverse/99999999", "No card found with the given ID or set code and collector number."],
			// `/cards/<x>/rulings` where x is not an id reads as a set code and a collector number
			// called "rulings", so Scryfall answers the CARD miss rather than the rulings one.
			["/cards/not-a-uuid/rulings", "No card found with the given ID or set code and collector number."],
			// The rulings shapes, worded for the routes that take a multiverse id too.
			[
				"/cards/aaaaaaaa-0000-4000-8000-00000000dead/rulings",
				"No card found with the given ID, multiverse ID, or set code & collector number.",
			],
			[
				"/cards/multiverse/99999999/rulings",
				"No card found with the given ID, multiverse ID, or set code & collector number.",
			],
		];
		// Nothing resolves, so every one of these is a miss — including the external-id and
		// set/collector-number lookups, which the plain fake answers unconditionally.
		class MissEngine extends FakeEngine {
			override async scryfallCardById(): Promise<null> {
				return null;
			}
			override async scryfallCardByExternalId(): Promise<null> {
				return null;
			}
			override async scryfallFirstOfEach(trees: string[]): Promise<null[]> {
				return trees.map(() => null);
			}
		}
		const missCtx = makeCtx({ engine: new MissEngine() });
		for (const [path, details] of cases) {
			const res = await testDispatch(missCtx, path);
			expect(res.status).toBe(404);
			expect((await json(res)).details).toBe(details);
		}
	});

	test("import_rulings is not a public route", async () => {
		// Upstream's route loads the bulk file into Postgres and, like every other import, lives
		// behind the Basic-Auth /_admin mount since #963; here the nightly import publishes rulings
		// to KV. The old public path is a plain 404 and the mount is a 401 (src/routes/admin.ts).
		expect((await testDispatch(ctx, "/import_rulings")).status).toBe(404);
		expect((await testDispatch(ctx, "/_admin/import_rulings")).status).toBe(401);
	});
});

describe("GET /cards/:id/rulings", () => {
	const ORACLE_ID = "bbbbbbbb-0000-4000-8000-000000000002";
	const OTHER_ORACLE_ID = "cccccccc-0000-4000-8000-000000000003";

	/** The fixture cards, with an oracle id — which is what rulings hang off. */
	class RulingsEngine extends FakeEngine {
		oracleId = ORACLE_ID;

		private withOracle(card: Record<string, unknown> | null): Record<string, unknown> | null {
			return card === null ? null : { ...card, oracle_id: this.oracleId };
		}

		override async scryfallCardById(id: string, baseUrl: string): Promise<Record<string, unknown> | null> {
			return this.withOracle(await super.scryfallCardById(id, baseUrl));
		}

		override async scryfallCardByExternalId(
			namespace: string,
			externalId: number,
			baseUrl: string,
		): Promise<Record<string, unknown> | null> {
			return this.withOracle(await super.scryfallCardByExternalId(namespace, externalId, baseUrl));
		}

		override async scryfallFirstOfEach(trees: string[], baseUrl: string): Promise<(Record<string, unknown> | null)[]> {
			return (await super.scryfallFirstOfEach(trees, baseUrl)).map((card) => this.withOracle(card));
		}
	}

	const RULINGS: RulingRow[] = [
		{ oracle_id: ORACLE_ID, source: "wotc", published_at: "2019-07-12", comment: "The second ruling." },
		{ oracle_id: ORACLE_ID, source: "wotc", published_at: "2014-07-18", comment: "The first ruling." },
		{ oracle_id: OTHER_ORACLE_ID, source: "scryfall", published_at: "2020-01-01", comment: "Another card's." },
	];

	/** A context whose KV holds the bucket each of those oracle ids belongs in. */
	function rulingsCtx(rows: RulingRow[] = RULINGS): { ctx: RouteContext; kv: FakeKV } {
		const kv = new FakeKV();
		for (const bucket of new Set(rows.map((row) => rulingsBucketOf(row.oracle_id) as number))) {
			const inBucket = rows.filter((row) => rulingsBucketOf(row.oracle_id) === bucket);
			kv.put(rulingsBucketKey(bucket), encodeRulingsBucket(inBucket).bytes);
		}
		return { ctx: makeCtx({ engine: new RulingsEngine(), kv }), kv };
	}

	test("answers a List of Ruling objects for the card's oracle id", async () => {
		const res = await testDispatch(rulingsCtx().ctx, "/cards/aaaaaaaa-0000-4000-8000-000000000001/rulings");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		const body = await json(res);
		expect(body.object).toBe("list");
		expect(body.has_more).toBe(false);
		// Scryfall's rulings List carries no total_cards — it is not a card list.
		expect(body.total_cards).toBeUndefined();
		const data = body.data as Record<string, unknown>[];
		expect(data.length).toBe(2);
		expect(data[0]).toEqual({
			object: "ruling",
			oracle_id: ORACLE_ID,
			source: "wotc",
			published_at: "2019-07-12",
			comment: "The second ruling.",
		});
		// Newest date first, which is Scryfall's order — NOT upstream's ascending one. See
		// encodeRulingsBucket and the README's deviations list.
		expect(data[1]?.published_at).toBe("2014-07-18");
	});

	test("the same rulings answer every way the card can be addressed", async () => {
		for (const path of [
			"/cards/aaaaaaaa-0000-4000-8000-000000000001/rulings",
			"/cards/multiverse/12345/rulings",
			"/cards/m15/18/rulings",
		]) {
			const body = await json(await testDispatch(rulingsCtx().ctx, path));
			expect(body.object).toBe("list");
			expect((body.data as unknown[]).length).toBe(2);
		}
	});

	test("a card with no rulings is an empty list, not a 404", async () => {
		// The 404 is about the CARD. A card the corpus holds and Scryfall has never ruled on
		// answers 200 with data: [], which is what Scryfall itself does.
		const engine = new RulingsEngine();
		engine.oracleId = "dddddddd-0000-4000-8000-000000000004";
		const kv = new FakeKV();
		kv.put(rulingsBucketKey(rulingsBucketOf(engine.oracleId) as number), encodeRulingsBucket([]).bytes);
		const res = await testDispatch(makeCtx({ engine, kv }), "/cards/aaaaaaaa-0000-4000-8000-000000000001/rulings");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.object).toBe("list");
		expect(body.data).toEqual([]);
	});

	test("rulings for a card this deployment does not hold are the card's 404", async () => {
		const res = await testDispatch(rulingsCtx().ctx, "/cards/aaaaaaaa-0000-4000-8000-00000000dead/rulings");
		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body.object).toBe("error");
		expect(body.code).toBe("not_found");
		// Not this port's routes-listing 404, which is not a Scryfall body at all.
		expect(body.description).toBeUndefined();
	});

	test("a bucket that was never published is a 503, not an empty list", async () => {
		// An empty list would claim the card has no rulings; the honest statement is that this
		// deployment has not published any yet. It is also the one rulings answer that must not
		// be cached for 16 hours — the next import fixes it.
		const res = await testDispatch(
			makeCtx({ engine: new RulingsEngine(), kv: new FakeKV() }),
			"/cards/aaaaaaaa-0000-4000-8000-000000000001/rulings",
		);
		expect(res.status).toBe(503);
		const body = await json(res);
		expect(body.object).toBe("error");
		expect(body.code).toBe("service_unavailable");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	test("a KV read failure is a 500 that says so, never an empty list", async () => {
		const { ctx: failing, kv } = rulingsCtx();
		kv.failOn.add(rulingsBucketKey(rulingsBucketOf(ORACLE_ID) as number));
		const res = await testDispatch(failing, "/cards/aaaaaaaa-0000-4000-8000-000000000001/rulings");
		expect(res.status).toBe(500);
		expect((await json(res)).code).toBe("internal_error");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	test("rulings carry the same 16-hour tier as every other /cards/* answer", async () => {
		const res = await testDispatch(rulingsCtx().ctx, "/cards/aaaaaaaa-0000-4000-8000-000000000001/rulings");
		expect(res.headers.get("cache-control")).toBe("public, max-age=57600");
	});

	test("pretty indents the envelope", async () => {
		const res = await testDispatch(rulingsCtx().ctx, "/cards/aaaaaaaa-0000-4000-8000-000000000001/rulings?pretty=1");
		expect(await res.text()).toContain('\n  "data": ');
	});
});

describe("the card object", () => {
	const row = {
		scryfall_id: "aaaaaaaa-0000-4000-8000-000000000001",
		oracle_id: "bbbbbbbb-0000-4000-8000-000000000002",
		name: "Llanowar Elves",
		set_code: "m15",
		collector_number: "165",
		lang: "en",
		mana_cost: "{G}",
		oracle_text: "{T}: Add {G}.",
		colors: ["G"],
		color_identity: ["G"],
		card_keywords: [],
		games: ["paper"],
		finishes: ["nonfoil"],
		price_usd: 0.25,
		tcgplayer_id: 1234,
		// Everything Scryfall would OMIT for this card is absent from the row, as the engine
		// renders an absent field: null.
		watermark: null,
		penny_rank: null,
		promo_types: [],
	};

	test("absent keys stay absent rather than becoming null", () => {
		const card = toScryfallCard(row);
		// The one rule that makes this a drop-in: a client comparing shapes must not see a
		// difference on every row.
		expect("watermark" in card).toBe(false);
		expect("penny_rank" in card).toBe(false);
		expect("promo_types" in card).toBe(false);
		expect("flavor_text" in card).toBe(false);
		// A creature has no loyalty, and must not sprout one.
		expect("loyalty" in card).toBe(false);
	});

	test("a planeswalker's loyalty is the printed STRING, beside power/toughness", () => {
		// The integer `planeswalker_loyalty` column answers `loy:` and cannot hold "X" or "1+*",
		// so the card object reads the text out of the residue instead. Emitting nothing at all
		// is what left mtg-seeker's verifier reading a planeswalker with no loyalty.
		const walker = toScryfallCard({ ...row, name: "Jace Beleren", loyalty: "3" });
		expect(walker.loyalty).toBe("3");

		// Scryfall's own key order: loyalty sits with the creature stats it is the analogue of.
		const keys = Object.keys(walker);
		expect(keys.indexOf("loyalty")).toBeGreaterThan(keys.indexOf("type_line"));

		// "X" is a real printed loyalty (Nissa, Steward of Elements) and must survive verbatim
		// rather than being coerced through the integer column.
		expect(toScryfallCard({ ...row, loyalty: "X" }).loyalty).toBe("X");
	});

	test("cmc is a decimal, as Scryfall types it", () => {
		// api.scryfall.com answers `"cmc":1.0`, not `"cmc":1`
		// (https://api.scryfall.com/cards/named?exact=Lightning+Bolt). The field is decimal because
		// fractional mana values are real: Little Girl costs {HW} and answers `"cmc":0.5`. A
		// whole-numbered mana value therefore still carries its decimal point, and JavaScript —
		// which has one number type and writes `JSON.stringify(1.0)` as `"1"` — cannot express that
		// without help. See stringifyScryfall.
		const body = stringifyScryfall(toScryfallCard({ ...row, cmc: 1 }));
		expect(body).toContain('"cmc":1.0');
		// A half mana value passes through untouched, for the day funny sets are imported.
		expect(stringifyScryfall({ cmc: 0.5 })).toBe('{"cmc":0.5}');
		// And a card with no mana value still says so.
		expect(stringifyScryfall(toScryfallCard({ ...row, cmc: null }))).toContain('"cmc":null');
	});

	test("every derived URI is a pure function of the ids", () => {
		const card = toScryfallCard(row, "https://example.test");
		expect(card.uri).toBe("https://example.test/cards/aaaaaaaa-0000-4000-8000-000000000001");
		expect(card.rulings_uri).toBe("https://example.test/cards/aaaaaaaa-0000-4000-8000-000000000001/rulings");
		expect(card.set_search_uri).toBe("https://example.test/cards/search?order=set&q=e%3Am15&unique=prints");
		expect(card.scryfall_uri).toBe("https://scryfall.com/card/m15/165/llanowar-elves?utm_source=api");
		// This port sources images from Scryfall's CDN rather than upstream's CloudFront mirror,
		// and the card object has to agree with the pages that already do.
		const images = card.image_uris as Record<string, string>;
		expect(images.normal).toBe("https://cards.scryfall.io/normal/front/a/a/aaaaaaaa-0000-4000-8000-000000000001.jpg");
	});

	test("prices are Scryfall's two-decimal strings, with null for the ones it has no value for", () => {
		const prices = toScryfallCard(row).prices as Record<string, string | null>;
		expect(prices.usd).toBe("0.25");
		expect(prices.usd_foil).toBeNull();
	});

	test("purchase_uris: a product link per marketplace id, a NAME SEARCH for each id the card lacks", () => {
		// Per KEY, not per card: this row has a tcgplayer_id and no cardmarket/mtgo one, and
		// Scryfall answers exactly that shape (verified live across khm). All three keys always
		// present — the search form is what every foreign printing gets, since marketplace product
		// ids belong to the English printing and never reach an annex row.
		const uris = toScryfallCard(row).purchase_uris as Record<string, string>;
		expect(uris.tcgplayer).toBe("https://www.tcgplayer.com/product/1234?page=1");
		expect(uris.cardmarket).toBe("https://www.cardmarket.com/en/Magic/Products/Search?searchString=Llanowar+Elves");
		expect(uris.cardhoarder).toBe("https://www.cardhoarder.com/cards?data%5Bsearch%5D=Llanowar+Elves");
	});

	test("purchase_uris search on a multi-face card uses the FRONT FACE name, not the joined one", () => {
		// Scryfall searches TCGplayer for `Invasion of Alara`, never for the ` // `-joined name:
		// the joined string matches no product. `related_uris`' tcgplayer_infinite_* links DO
		// carry the joined name (verified live), so the two strings deliberately differ.
		const card = toScryfallCard({
			...row,
			name: "Invasion of Alara // Awaken the Maelstrom",
			tcgplayer_id: undefined,
			card_faces: [{ name: "Invasion of Alara" }, { name: "Awaken the Maelstrom" }],
		});
		const uris = card.purchase_uris as Record<string, string>;
		expect(uris.tcgplayer).toBe(
			"https://www.tcgplayer.com/search/magic/product?productLineName=magic&q=Invasion+of+Alara&view=grid",
		);
		expect(uris.cardmarket).toBe("https://www.cardmarket.com/en/Magic/Products/Search?searchString=Invasion+of+Alara");
		const related = card.related_uris as Record<string, string>;
		expect(related.tcgplayer_infinite_articles).toContain("Invasion+of+Alara+%2F%2F+Awaken+the+Maelstrom");
	});

	test("a multi-face card carries card_faces and NOT the text they replace", () => {
		const card = toScryfallCard({
			...row,
			// A two-image layout: the picture and the cost belong to the faces, so neither is at the
			// top level. On a split or adventure both ARE, which is the sibling case below.
			layout: "transform",
			card_faces: [
				{ name: "Delver of Secrets", mana_cost: "{U}", oracle_text: "..." },
				{ name: "Insectile Aberration", mana_cost: null, oracle_text: "..." },
			],
		});
		expect(Array.isArray(card.card_faces)).toBe(true);
		expect("mana_cost" in card).toBe(false);
		expect("image_uris" in card).toBe(false);
		const faces = card.card_faces as Record<string, unknown>[];
		expect(faces.length).toBe(2);
		const [front, back] = faces as [Record<string, unknown>, Record<string, unknown>];
		expect(front.object).toBe("card_face");
		// Each face gets its own front/back image, which the engine deliberately does not store.
		expect((back.image_uris as Record<string, string>).normal).toContain("/back/");
		// A face's absent key stays absent, exactly like the card's — `null` here, not `""`, which
		// on `mana_cost` would be the costless back face Scryfall does send.
		expect("mana_cost" in back).toBe(false);
	});

	test("a one-image multi-face card keeps its picture and its joined cost at the top level", () => {
		const card = toScryfallCard({
			...row,
			layout: "split",
			name: "Fire // Ice",
			card_faces: [
				{ name: "Fire", mana_cost: "{1}{R}", oracle_text: "..." },
				{ name: "Ice", mana_cost: "{1}{U}", oracle_text: "..." },
			],
		});
		// Scryfall serves ONE image for a split card and joins the faces' costs; the faces carry
		// neither a picture nor a colour list of their own.
		expect(card.mana_cost).toBe("{1}{R} // {1}{U}");
		expect((card.image_uris as Record<string, string>).normal).toContain("/front/");
		const faces = card.card_faces as Record<string, unknown>[];
		expect("image_uris" in (faces[0] as Record<string, unknown>)).toBe(false);
		expect("colors" in (faces[0] as Record<string, unknown>)).toBe(false);
		// ...and edhrec files a split under both halves, unlike every other multi-face layout.
		expect((card.related_uris as Record<string, string>).edhrec).toBe("https://edhrec.com/route/?cc=Fire+%2F%2F+Ice");
	});
});
