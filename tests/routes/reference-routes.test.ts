// The reference half of the Scryfall surface: /sets, /catalog/* and /symbology (upstream #922).
//
// Two rules run through all of it, and both are the port's rather than upstream's: a value that has
// never been published is a 503 saying so — never an empty List, which would be a claim about Magic
// — and the cache tiers are Scryfall's own measured ones, which are NOT the card routes' 16 hours.

import { describe, expect, test } from "bun:test";
import {
	catalogKey,
	encodeCountedArray,
	renderCatalog,
	renderSets,
	renderSymbology,
	setsBucketKey,
	setsListKey,
	symbologyKey,
} from "../../src/engine/reference-kv";
import { FakeKV, json, makeCtx, testDispatch } from "./harness";

const SETS = [
	{
		object: "set",
		id: "aaaaaaaa-1111-4111-8111-111111111111",
		code: "mh3",
		name: "Modern Horizons 3",
		tcgplayer_id: 23361,
		released_at: "2024-06-14",
		card_count: 303,
	},
	{
		object: "set",
		id: "bbbbbbbb-2222-4222-8222-222222222222",
		code: "dsk",
		name: "Duskmourn: House of Horror",
		released_at: "2024-09-27",
		card_count: 276,
	},
];

const SYMBOLS = [
	{ object: "card_symbol", symbol: "{T}", english: "tap this permanent", mana_value: null },
	{ object: "card_symbol", symbol: "{W}", english: "one white mana", mana_value: 1 },
];

/** A context whose KV holds the reference values, rendered exactly as the import renders them. */
function referenceCtx(): { ctx: ReturnType<typeof makeCtx>; kv: FakeKV } {
	const kv = new FakeKV();
	// The raw text a mirror stores; JSON.stringify is exact for these fixtures, and the real
	// publisher passes Scryfall's own bytes.
	const { list, buckets } = renderSets(
		SETS,
		SETS.map((set) => JSON.stringify(set)),
	);
	kv.put(setsListKey(), list);
	for (let bucket = 0; bucket < buckets.length; bucket++) kv.put(setsBucketKey(bucket), buckets[bucket] as Uint8Array);
	const creatureTypes = renderCatalog(["Elf", "Goblin", "Druid"]);
	kv.put(catalogKey("creature-types"), encodeCountedArray(creatureTypes.json, creatureTypes.count));
	kv.put(
		symbologyKey(),
		renderSymbology(
			SYMBOLS,
			SYMBOLS.map((symbol) => JSON.stringify(symbol)),
		).json,
	);
	return { ctx: makeCtx({ kv }), kv };
}

describe("GET /sets", () => {
	test("answers a List of Set objects in the order they were published", async () => {
		const res = await testDispatch(referenceCtx().ctx, "/sets");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.object).toBe("list");
		expect(body.has_more).toBe(false);
		// Scryfall's /sets List carries no total_cards — it is not a card list.
		expect(body.total_cards).toBeUndefined();
		const data = body.data as Record<string, unknown>[];
		// The stored order IS the data: `/sets` is released_at descending, and same-day sets arrive
		// in an order nothing in the object reproduces, so it is preserved rather than recomputed.
		expect(data.map((set) => set.code)).toEqual(["mh3", "dsk"]);
	});

	test("a set answers by code, by id and by TCGplayer id", async () => {
		const { ctx } = referenceCtx();
		for (const path of [
			"/sets/mh3",
			"/sets/aaaaaaaa-1111-4111-8111-111111111111",
			"/sets/tcgplayer/23361",
			// A client that upper-cased a code while building a URL still finds the set.
			"/sets/MH3",
		]) {
			const body = await json(await testDispatch(ctx, path));
			expect(body.object).toBe("set");
			expect(body.code).toBe("mh3");
			// The Set object is served whole, including the fields no card carries.
			expect(body.card_count).toBe(303);
		}
	});

	test("a set this instance does not hold is Scryfall's 404", async () => {
		const { ctx } = referenceCtx();
		for (const path of ["/sets/zzz", "/sets/tcgplayer/999999", "/sets/mh3/extra"]) {
			const res = await testDispatch(ctx, path);
			expect(res.status).toBe(404);
			const body = await json(res);
			expect(body.object).toBe("error");
			expect(body.code).toBe("not_found");
			// Not this port's routes-listing 404, which is not a Scryfall body at all.
			expect(body.description).toBeUndefined();
		}
	});

	test("every set miss carries Scryfall's own wording, not the generic body", async () => {
		// Measured 2026-08-12. Upstream answers these with the cards surface's generic
		// "The requested object or REST method was not found. Please double-check..." instead.
		const { ctx } = referenceCtx();
		for (const path of ["/sets/zzz", "/sets/tcgplayer/999999", "/sets/tcgplayer"]) {
			const body = await json(await testDispatch(ctx, path));
			expect(body.details).toBe("No Magic set found for the given code or ID");
		}
	});

	test("a non-numeric TCGplayer id is a 404, not a lookup", async () => {
		const res = await testDispatch(referenceCtx().ctx, "/sets/tcgplayer/not-a-number");
		expect(res.status).toBe(404);
	});
});

describe("GET /catalog/:name", () => {
	test("answers a Catalog object with total_values", async () => {
		const body = await json(await testDispatch(referenceCtx().ctx, "/catalog/creature-types"));
		expect(body.object).toBe("catalog");
		// total_values comes from the publisher, not from counting the array here — the whole point
		// of storing the count is that the route never parses a 692KB payload to learn it.
		expect(body.total_values).toBe(3);
		expect(body.data).toEqual(["Elf", "Goblin", "Druid"]);
		// A Catalog carries its own uri, pointing at Scryfall — and /cards/autocomplete's does NOT,
		// which is why the object takes it as an option rather than always building one.
		expect(body.uri).toBe("https://api.scryfall.com/catalog/creature-types");
		expect(Object.keys(body)).toEqual(["object", "uri", "total_values", "data"]);
	});

	test("a name Scryfall does not document is a 404, not an empty catalog", async () => {
		// An empty catalog would let a client conclude Magic has no such thing.
		const res = await testDispatch(referenceCtx().ctx, "/catalog/not-a-catalog");
		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body.code).toBe("not_found");
		// Scryfall's catalog miss has no "Please double-check your URI and try again." tail, where
		// the cards surface's generic body does. Measured, not assumed.
		expect(body.details).toBe("The requested object or REST method was not found.");
	});

	test("a documented name that has not been imported yet is a 503, not empty", async () => {
		const res = await testDispatch(referenceCtx().ctx, "/catalog/artist-names");
		expect(res.status).toBe(503);
		expect((await json(res)).code).toBe("service_unavailable");
	});
});

describe("GET /symbology", () => {
	test("answers a List of CardSymbol objects in Scryfall's order", async () => {
		const body = await json(await testDispatch(referenceCtx().ctx, "/symbology"));
		expect(body.object).toBe("list");
		expect((body.data as Record<string, unknown>[]).map((symbol) => symbol.symbol)).toEqual(["{T}", "{W}"]);
	});
});

describe("GET /symbology/parse-mana", () => {
	test("parses a cost without reading anything", async () => {
		// The one route here that answers before any import: no KV at all in this context.
		const body = await json(await testDispatch(makeCtx(), "/symbology/parse-mana?cost=RUW"));
		expect(body.object).toBe("mana_cost");
		expect(body.cost).toBe("{U}{R}{W}");
		expect(body.colors).toEqual(["W", "U", "R"]);
	});

	// api.scryfall.com does not reject this: a missing `cost` is the same request as an empty one,
	// and both answer 200 with `cost: null` (measured 2026-08-16). This asserted the 400 upstream
	// sends, which is a sentence Scryfall does not own and a rejection it does not make.
	test("no cost parameter is the same 200 an empty cost is, not a 400", async () => {
		const missing = await testDispatch(makeCtx(), "/symbology/parse-mana");
		const empty = await testDispatch(makeCtx(), "/symbology/parse-mana?cost=");
		expect(missing.status).toBe(200);
		const text = await missing.text();
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(body.object).toBe("mana_cost");
		expect(body.cost).toBeNull();
		expect(text).toBe(await empty.text());
	});

	test("a fragment that is not mana is a 422, which is what Scryfall answers", async () => {
		const res = await testDispatch(makeCtx(), "/symbology/parse-mana?cost=%7BT%7D");
		expect(res.status).toBe(422);
		const body = await json(res);
		expect(body.object).toBe("error");
		// `validation_error`, which is what Scryfall sends; upstream sends `bad_request` here.
		expect(body.code).toBe("validation_error");
		expect(body.details).toContain("could not be understood as part of mana cost");
	});
});

describe("nothing published yet", () => {
	test("every mirrored route is a 503 that says so, never an empty answer", async () => {
		const ctx = makeCtx({ kv: new FakeKV() });
		for (const path of ["/sets", "/sets/mh3", "/catalog/creature-types", "/symbology"]) {
			const res = await testDispatch(ctx, path);
			expect(res.status).toBe(503);
			const body = await json(res);
			expect(body.object).toBe("error");
			expect(body.code).toBe("service_unavailable");
			// The one answer here that must not be cached: the next import fixes it.
			expect(res.headers.get("cache-control")).toBe("no-store");
		}
	});
});

describe("cache headers", () => {
	// Measured against api.scryfall.com on 2026-08-11. These are NOT the card routes' 16 hours: a
	// client that swapped its base URL would otherwise hold a response far longer than Scryfall
	// intends, and would not find out until it served something stale.
	test.each([
		["/sets", "public"],
		["/sets/mh3", "public"],
		["/sets/tcgplayer/23361", "public"],
		["/catalog/creature-types", "public"],
		["/symbology", "public"],
		["/symbology/parse-mana?cost=W", "max-age=0, private, must-revalidate"],
	])("%s carries Scryfall's own tier", async (path, expected) => {
		expect((await testDispatch(referenceCtx().ctx, path)).headers.get("Cache-Control")).toBe(expected);
	});

	test("a 404 carries the tier too, as Scryfall's does", async () => {
		expect((await testDispatch(referenceCtx().ctx, "/sets/zzz")).headers.get("Cache-Control")).toBe("public");
	});
});
