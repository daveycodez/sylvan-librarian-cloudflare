// The Scryfall-compatible /cards/* surface: route shapes, error bodies, and the two rules that
// make it a drop-in replacement rather than an approximation — absent keys stay absent, and a
// miss is a Scryfall-shaped 404 rather than this port's routes listing.

import { describe, expect, test } from "bun:test";
import { toScryfallCard } from "../../src/routes/scryfall-compat/objects";
import { FakeEngine, json, makeCtx, testDispatch } from "./harness";

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
	test("is never cached — a cached random card is one card forever", async () => {
		const res = await testDispatch(ctx, "/cards/random");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
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

	test("a trailing rulings segment is Scryfall's 404, not an empty list and not the routes listing", async () => {
		for (const path of ["/cards/aaaaaaaa-0000-0000-0000-000000000001/rulings", "/cards/m15/165/rulings"]) {
			const res = await testDispatch(ctx, path);
			expect(res.status).toBe(404);
			const body = await json(res);
			// An empty List would claim the card HAS no rulings; this deployment does not serve
			// them at all, which is a different statement. And `description.routes` would be this
			// port's own 404, which is not a Scryfall body.
			expect(body.object).toBe("error");
			expect(body.code).toBe("not_found");
			expect(body.description).toBeUndefined();
		}
	});

	test("import_rulings is a 501 stub like the other Postgres-only routes", async () => {
		const res = await testDispatch(ctx, "/import_rulings");
		expect(res.status).toBe(501);
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
