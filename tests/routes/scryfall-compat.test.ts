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
		expect(body.details).toBe("You didn't enter anything to search for.");
	});

	test("page 0 is rejected rather than silently read as page 1", async () => {
		const res = await testDispatch(ctx, "/cards/search?q=elf&page=0");
		expect(res.status).toBe(400);
		expect((await json(res)).details).toContain("positive integer");
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
		expect((await json(res)).details).toContain("fuzzy or exact");
	});

	test("a miss is Scryfall's 404 with the name quoted", async () => {
		const res = await testDispatch(ctx, "/cards/named?exact=Not%20A%20Card");
		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body.object).toBe("error");
		expect(body.details).toContain("No cards found matching");
	});

	test("ambiguous is its own error code, not a miss", async () => {
		const engine = new FakeEngine();
		engine.scryfallExactNames = [];
		engine.scryfallFuzzyStatus = "ambiguous";
		const res = await testDispatch(makeCtx({ engine }), "/cards/named?fuzzy=zzzz%20qqqq");
		expect(res.status).toBe(404);
		const body = await json(res);
		// A 404 either way, but the CODE is what tells a client "refine" from "does not exist".
		expect(body.code).toBe("ambiguous");
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
});

describe("GET /cards/random", () => {
	test("carries Scryfall's no-cache — a cached random card is one card forever", async () => {
		const res = await testDispatch(ctx, "/cards/random");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
	});
});

describe("cache headers", () => {
	// Measured against api.scryfall.com rather than guessed. This surface exists so a client can
	// change one base URL, and how long it may reuse a response is part of what it observes — an
	// uncached /cards/* would also put every request through the Worker and the Durable Object,
	// against a 100k/day allowance, on the surface mtg-seeker actually calls.
	test.each([
		["/cards/search?q=elf", "public, max-age=57600"],
		["/cards/aaaaaaaa-0000-0000-0000-000000000001", "public, max-age=57600"],
		["/cards/m15/165", "public, max-age=57600"],
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

	test("the collection POST is private and must-revalidate", async () => {
		// A shared cache keys on the URL, and this route's answer depends entirely on the BODY.
		const res = await testDispatch(postCtx({ identifiers: [] }), "/cards/collection", "POST");
		expect(res.headers.get("Cache-Control")).toBe("max-age=0, private, must-revalidate");
	});

	test("/search keeps its own tier — the two surfaces have no reason to agree", async () => {
		expect((await testDispatch(ctx, "/search?q=elf")).headers.get("Cache-Control")).toBe(
			"public, max-age=90, stale-while-revalidate=86400",
		);
	});
});

describe("POST /cards/collection", () => {
	test("resolves identifiers and reports the ones that matched nothing", async () => {
		const known = "aaaaaaaa-0000-0000-0000-000000000001";
		const body = await json(
			await testDispatch(
				postCtx({ identifiers: [{ id: known }, { id: "bbbbbbbb-0000-0000-0000-000000000009" }] }),
				"/cards/collection",
				"POST",
			),
		);
		expect(body.object).toBe("list");
		expect((body.data as unknown[]).length).toBe(1);
		expect(body.not_found).toEqual([{ id: "bbbbbbbb-0000-0000-0000-000000000009" }]);
	});

	test("two identifiers naming one card collapse to one entry", async () => {
		const known = "aaaaaaaa-0000-0000-0000-000000000001";
		const body = await json(
			await testDispatch(postCtx({ identifiers: [{ id: known }, { id: known }] }), "/cards/collection", "POST"),
		);
		expect((body.data as unknown[]).length).toBe(1);
	});

	test("past the cap is a 422 rather than a truncated answer", async () => {
		const identifiers = Array.from({ length: 76 }, () => ({ id: "x" }));
		const res = await testDispatch(postCtx({ identifiers }), "/cards/collection", "POST");
		expect(res.status).toBe(422);
		expect((await json(res)).code).toBe("validation_error");
	});

	test("a body without an identifiers array is a 422", async () => {
		const res = await testDispatch(postCtx({ nope: true }), "/cards/collection", "POST");
		expect(res.status).toBe(422);
	});

	test("GET is not allowed", async () => {
		const res = await testDispatch(ctx, "/cards/collection");
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
	});
});

describe("GET /cards and /cards/...", () => {
	test("/cards paginates every card", async () => {
		const body = await json(await testDispatch(ctx, "/cards"));
		expect(body.object).toBe("list");
		expect(body.total_cards).toBe(17);
	});

	test("/cards/:id answers a card object", async () => {
		const body = await json(await testDispatch(ctx, "/cards/aaaaaaaa-0000-0000-0000-000000000001"));
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

	test("/cards/:code/:number resolves by set and collector number", async () => {
		const body = await json(await testDispatch(ctx, "/cards/m15/165"));
		expect(body.object).toBe("card");
	});

	test("a language the printing is not in 404s rather than answering the English one", async () => {
		// DELIBERATE DEVIATION: lang lives in the residue archive and is not a filter field, so the
		// card is resolved first and its OWN stored language checked. Answering the English card
		// for /ja would be a card object that says lang: en at a URL that asked for Japanese.
		const res = await testDispatch(ctx, "/cards/m15/165/ja");
		expect(res.status).toBe(404);
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
				"/cards/aaaaaaaa-0000-0000-0000-00000000dead",
				"No card found with the given ID or set code and collector number.",
			],
			["/cards/multiverse/99999999", "No card found with the given ID or set code and collector number."],
			// `/cards/<x>/rulings` where x is not an id reads as a set code and a collector number
			// called "rulings", so Scryfall answers the CARD miss rather than the rulings one.
			["/cards/not-a-uuid/rulings", "No card found with the given ID or set code and collector number."],
			// The rulings shapes, worded for the routes that take a multiverse id too.
			[
				"/cards/aaaaaaaa-0000-0000-0000-00000000dead/rulings",
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

	test("import_rulings is a 501 stub like the other Postgres-only routes", async () => {
		// Upstream's admin route loads the bulk file into Postgres; here the nightly import
		// publishes rulings to KV, so the route it replaced stays a stub even though the data
		// it used to load is now served.
		const res = await testDispatch(ctx, "/import_rulings");
		expect(res.status).toBe(501);
	});
});

describe("GET /cards/:id/rulings", () => {
	const ORACLE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
	const OTHER_ORACLE_ID = "cccccccc-0000-0000-0000-000000000003";

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
		const res = await testDispatch(rulingsCtx().ctx, "/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings");
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
			"/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings",
			"/cards/multiverse/12345/rulings",
			"/cards/m15/165/rulings",
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
		engine.oracleId = "dddddddd-0000-0000-0000-000000000004";
		const kv = new FakeKV();
		kv.put(rulingsBucketKey(rulingsBucketOf(engine.oracleId) as number), encodeRulingsBucket([]).bytes);
		const res = await testDispatch(makeCtx({ engine, kv }), "/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.object).toBe("list");
		expect(body.data).toEqual([]);
	});

	test("rulings for a card this deployment does not hold are the card's 404", async () => {
		const res = await testDispatch(rulingsCtx().ctx, "/cards/aaaaaaaa-0000-0000-0000-00000000dead/rulings");
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
			"/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings",
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
		const res = await testDispatch(failing, "/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings");
		expect(res.status).toBe(500);
		expect((await json(res)).code).toBe("internal_error");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	test("rulings carry the same 16-hour tier as every other /cards/* answer", async () => {
		const res = await testDispatch(rulingsCtx().ctx, "/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings");
		expect(res.headers.get("cache-control")).toBe("public, max-age=57600");
	});

	test("pretty indents the envelope", async () => {
		const res = await testDispatch(rulingsCtx().ctx, "/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings?pretty=1");
		expect(await res.text()).toContain('\n  "data": ');
	});
});

describe("the card object", () => {
	const row = {
		scryfall_id: "aaaaaaaa-0000-0000-0000-000000000001",
		oracle_id: "bbbbbbbb-0000-0000-0000-000000000002",
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
		expect(card.uri).toBe("https://example.test/cards/aaaaaaaa-0000-0000-0000-000000000001");
		expect(card.rulings_uri).toBe("https://example.test/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings");
		expect(card.set_search_uri).toBe("https://example.test/cards/search?order=set&q=e%3Am15&unique=prints");
		expect(card.scryfall_uri).toBe("https://scryfall.com/card/m15/165/llanowar-elves?utm_source=api");
		// This port sources images from Scryfall's CDN rather than upstream's CloudFront mirror,
		// and the card object has to agree with the pages that already do.
		const images = card.image_uris as Record<string, string>;
		expect(images.normal).toBe("https://cards.scryfall.io/normal/front/a/a/aaaaaaaa-0000-0000-0000-000000000001.jpg");
	});

	test("prices are Scryfall's two-decimal strings, with null for the ones it has no value for", () => {
		const prices = toScryfallCard(row).prices as Record<string, string | null>;
		expect(prices.usd).toBe("0.25");
		expect(prices.usd_foil).toBeNull();
	});

	test("purchase_uris carry only the marketplaces the card has an id for", () => {
		const uris = toScryfallCard(row).purchase_uris as Record<string, string>;
		expect(uris.tcgplayer).toContain("1234");
		expect("cardmarket" in uris).toBe(false);
	});

	test("a multi-face card carries card_faces and NOT the text they replace", () => {
		const card = toScryfallCard({
			...row,
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
		// A face's absent key stays absent, exactly like the card's.
		expect("mana_cost" in back).toBe(false);
	});
});
