// Dispatch-level behavior: the 404 routes listing (upstream
// _build_routes_listing shape and ordering), 405 + Allow, positional
// capacities, get_pid, and the Postgres-only 501 stubs.

import { describe, expect, test } from "bun:test";
import { buildRoutesListing } from "../../src/routes";
import { json, makeCtx, testDispatch } from "./harness";

const ctx = makeCtx();

describe("404 routes listing", () => {
	test("unknown path answers Scryfall's error object, NOT the routes listing", async () => {
		// The deliberate reversal of what this used to assert. This deployment exists so a client
		// can change one base URL and stop talking to api.scryfall.com, and that has to hold when it
		// asks for something that does not exist: it parses `code` and `details`, and
		// `{title, description: {routes}}` gives it neither. Status, wording and tier are measured.
		const res = await testDispatch(ctx, "/definitely_not_a_route");
		expect(res.status).toBe(404);
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(await json(res)).toEqual({
			object: "error",
			code: "not_found",
			status: 404,
			details: "The requested object or REST method was not found.",
		});
	});

	test("the routes listing is still BUILT — it is the 404 body that stopped carrying it", async () => {
		// `buildRoutesListing` is upstream's `_build_routes_listing` and its shape and ordering are
		// still pinned by the test below; nothing about the registration order changed, only where
		// the listing is served. Kept as its own assertion so a future reader does not conclude the
		// listing is dead code and delete it.
		expect(Object.keys(buildRoutesListing()).length).toBeGreaterThan(20);
	});

	test("listing keys follow upstream registration order", () => {
		expect(Object.keys(buildRoutesListing())).toEqual([
			"index",
			"index.html",
			"_root",
			"backfill_cubecobra_scores",
			"backfill_prefer_scores",
			"card",
			// The Scryfall-compatible surface (upstream #912). `cards` sorts before
			// `discover_is_tags_from_syntax` the same way `card` does, and its five named
			// sub-routes follow it: dir(cls) puts a class's attributes in name order, and the
			// exact paths register consecutively behind the handler that declares them.
			"cards",
			"cards/search",
			"cards/named",
			"cards/autocomplete",
			"cards/random",
			"cards/collection",
			"discover_is_tags_from_syntax",
			"get_catalog",
			"get_common_keywords",
			"get_migrations",
			"get_pid",
			"import_all_is_tags",
			"import_art_tags",
			"import_card_by_name",
			"import_cards_by_search",
			"import_data",
			"import_oracle_tags",
			// Postgres-only, so a 501 stub like the backfills; sorts here by attribute name.
			"import_rulings",
			"ingest_cubecobra",
			"random_search",
			// The reference surface (upstream #922). Four separate handlers, so they sort by
			// attribute name — scryfall_catalog, scryfall_parse_mana, scryfall_sets,
			// scryfall_symbology — which is why parse-mana lands between catalog and sets rather
			// than behind symbology the way the cards sub-routes sit behind `cards`.
			"catalog",
			"symbology/parse-mana",
			"sets",
			"symbology",
			"search",
			"setup_schema",
		]);
	});

	test("search listing mirrors Python inspect output", () => {
		const listing = buildRoutesListing().search as {
			doc: string;
			args: unknown[];
			kwargs: Record<string, { type: string; default: unknown }>;
		};
		expect(listing.doc.startsWith("Run a search query and return results and metadata.\n")).toBe(true);
		expect(listing.args).toEqual([]);
		expect(Object.keys(listing.kwargs)).toEqual([
			"direction",
			"fields",
			"limit",
			"orderby",
			"prefer",
			"q",
			"query",
			"shape",
			"unique",
		]);
		expect(listing.kwargs.direction).toEqual({ type: "SortDirection", default: "asc" });
		expect(listing.kwargs.fields).toEqual({ type: "Sequence[str] | None", default: null });
		expect(listing.kwargs.limit).toEqual({ type: "int", default: 100 });
		expect(listing.kwargs.shape).toEqual({ type: "ResponseShape", default: "rows" });
	});

	test("keyword-only params without defaults are positional args in the listing", () => {
		const listing = buildRoutesListing().import_card_by_name as { args: { name: string; type: string }[] };
		expect(listing.args).toEqual([{ name: "card_name", type: "str" }]);
	});
});

describe("method handling", () => {
	test("POST to a GET route on THIS PROJECT'S surface is falcon's 405", async () => {
		// `/search` is upstream's own route and the web interface's own JSON, whose error bodies the
		// frontend renders by reading `title` and `description` (public/static/app.js). It keeps
		// upstream's shape for exactly that reason.
		const res = await testDispatch(ctx, "/search", "POST");
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET, HEAD");
		expect((await json(res)).description).toBe("Allowed methods: GET, HEAD");
	});

	test("a wrong method on the SCRYFALL surface is Scryfall's 404, with no Allow header", async () => {
		// Measured 2026-08-16 across eight requests — POST/PUT/DELETE/PATCH against `/cards/search`,
		// `/cards/named`, `/cards/collection`, `/cards/:id` and `/sets`: api.scryfall.com answers 404
		// with the ordinary `not_found` object and sends NO `Allow`.
		//
		// This was briefly a 405 carrying an invented `method_not_allowed` code. 405 is the more
		// correct HTTP answer in the abstract, and it was still wrong here: Scryfall never emits a
		// 405, so nothing measured backed that code. A client that branches on 404-versus-405 has to
		// see what Scryfall shows it.
		const res = await testDispatch(ctx, "/cards/search", "POST");
		expect(res.status).toBe(404);
		expect(res.headers.get("Allow")).toBeNull();
		expect(await json(res)).toEqual({
			object: "error",
			code: "not_found",
			status: 404,
			details: "The requested object or REST method was not found.",
		});
	});

	test("GET /cards/collection is the same 404", async () => {
		const res = await testDispatch(ctx, "/cards/collection");
		expect(res.status).toBe(404);
		expect(res.headers.get("Allow")).toBeNull();
		expect((await json(res)).code).toBe("not_found");
	});

	test("every reference route is on the Scryfall surface too", async () => {
		// The split is by ROUTE KEY because the two surfaces interleave under one namespace:
		// `catalog` is Scryfall's and `get_catalog` is upstream's own, and only the table separates
		// them. This pins both halves of that pair.
		for (const path of ["/sets", "/symbology", "/catalog/battle-types", "/symbology/parse-mana"]) {
			const res = await testDispatch(ctx, path, "DELETE");
			expect(res.status).toBe(404);
			expect((await json(res)).code).toBe("not_found");
		}
		const own = await testDispatch(ctx, "/get_catalog", "DELETE");
		expect(own.status).toBe(405);
		expect(own.headers.get("Allow")).toBe("GET, HEAD");
		expect((await json(own)).title).toBe("Method Not Allowed");
	});

	test("HEAD is implied by GET on every route", async () => {
		const res = await testDispatch(ctx, "/get_pid", "HEAD");
		expect(res.status).toBe(200);
	});
});

describe("positional capacity", () => {
	test("trailing segments beyond a route's capacity are 404, not 400", async () => {
		expect((await testDispatch(ctx, "/get_pid/extra")).status).toBe(404);
		expect((await testDispatch(ctx, "/robots.txt/x")).status).toBe(404);
	});

	test("setup_schema absorbs any number of segments (upstream *args)", async () => {
		expect((await testDispatch(ctx, "/setup_schema/a/b/c")).status).toBe(501);
	});
});

describe("get_pid", () => {
	test("returns a bare JSON int (0 in Workers — isolates have no pid) with no-store", async () => {
		const res = await testDispatch(ctx, "/get_pid");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("0");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});
});

describe("Postgres-only routes answer 501", () => {
	const stubbed = [
		"/setup_schema",
		"/import_data",
		"/get_migrations",
		"/get_common_keywords",
		"/backfill_prefer_scores",
		"/backfill_cubecobra_scores",
		"/ingest_cubecobra",
		"/discover_is_tags_from_syntax",
		"/import_oracle_tags",
		"/import_art_tags",
		"/import_all_is_tags",
		"/import_card_by_name",
		"/import_cards_by_search",
	];
	for (const path of stubbed) {
		test(`${path} → 501 Not Implemented`, async () => {
			const res = await testDispatch(ctx, path);
			expect(res.status).toBe(501);
			const body = await json(res);
			expect(body.title).toBe("Not Implemented");
			expect(String(body.description)).toContain("replaced by the Cloudflare import pipeline in this port");
		});
	}
});

// The FONTS fragment is vendored verbatim and loads mana-subset.css (and the
// Beleren/MPlantin faces) from upstream's CloudFront. If the CSP stops naming
// that host, the stylesheet is blocked, .ms-* never gets a glyph, and every
// mana symbol in a card's oracle text renders as an empty box — with nothing
// failing server-side to say so. Derive the hosts from the page we actually
// serve rather than restating the constant.
describe("Content-Security-Policy covers the font CDN", () => {
	test("every cross-origin stylesheet/font host in the page is allowed", async () => {
		const res = await testDispatch(makeCtx(), "/");
		const html = await res.text();
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		const directive = (name: string) =>
			csp
				.split(";")
				.map((part) => part.trim())
				.find((part) => part.startsWith(`${name} `)) ?? "";

		const hosts = new Set(
			[...html.matchAll(/href="(https:\/\/[^/"]+)[^"]*"/g)]
				.map((m) => m[1] ?? "")
				.filter((host) => host !== "" && html.includes(`${host}/cdn/fonts/`)),
		);
		expect(hosts.size).toBeGreaterThan(0);
		for (const host of hosts) {
			expect(directive("style-src")).toContain(host);
			expect(directive("font-src")).toContain(host);
		}
	});
});
