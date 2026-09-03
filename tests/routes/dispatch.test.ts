// Dispatch-level behavior: the 404 routes listing (upstream
// _build_routes_listing shape and ordering), 405 + Allow, positional
// capacities, get_pid, the get_common_keywords 501 stub, and the /_admin mount.

import { describe, expect, test } from "bun:test";
import { buildRoutesListing, resolveAction } from "../../src/routes";
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
		expect(Object.keys(buildRoutesListing()).length).toBeGreaterThan(15);
	});

	test("listing keys follow upstream registration order", () => {
		// Upstream #963 moved the admin routes (import_*, setup_schema, the backfills,
		// ingest_cubecobra, discover_is_tags_from_syntax, prefer_score_tuner) behind the
		// `/_admin` mount and off this listing, and deleted get_migrations outright.
		// get_common_keywords stayed public, so it stays here.
		expect(Object.keys(buildRoutesListing())).toEqual([
			"index",
			"index.html",
			"_root",
			"card",
			// The Scryfall-compatible surface (upstream #912). `cards` sorts after `card` and
			// before `get_catalog`, and its five named sub-routes follow it: dir(cls) puts a
			// class's attributes in name order, and the exact paths register consecutively behind
			// the handler that declares them.
			"cards",
			"cards/search",
			"cards/named",
			"cards/autocomplete",
			"cards/random",
			"cards/collection",
			"get_catalog",
			"get_common_keywords",
			"get_pid",
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
});

describe("the /_admin mount (upstream #963 + #966)", () => {
	test("every path under /_admin is a 401 with a Basic challenge and no-store", async () => {
		// Upstream rejects every request under the mount when ADMIN_PASSWORD is unset; this port
		// never has one (and no Postgres behind the routes), so this is the complete behavior.
		for (const path of ["/_admin", "/_admin/", "/_admin/import_data", "/_admin/setup_schema/x/y"]) {
			const res = await testDispatch(ctx, path);
			expect(res.status).toBe(401);
			expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="admin"');
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(await json(res)).toEqual({ error: "Unauthorized" });
		}
	});

	test("the old public admin paths are plain 404s, like any unknown path", async () => {
		for (const path of ["/import_data", "/setup_schema", "/get_migrations", "/prefer_score_tuner", "/import_rulings"]) {
			const res = await testDispatch(ctx, path);
			expect(res.status).toBe(404);
			expect((await json(res)).code).toBe("not_found");
		}
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
});

describe("paths that name an Object.prototype member", () => {
	// `routes` is a plain object literal, so a membership test spelled `path in routes` walks the
	// prototype chain: `/constructor` matched Object itself, truthy enough to pass the `!entry`
	// guard, and the capacity check passed too because every comparison against an undefined
	// `positionalCapacity` is false. Dispatch then read `.methods` off a Function and threw — above
	// handle()'s try block, so it left as workerd's generic 500 with console.error never reached.
	// Unauthenticated, cache-key-shaped, and reachable by typing a word.
	const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"];

	test("resolve to nothing rather than to an inherited member", () => {
		for (const name of INHERITED) {
			expect(resolveAction(name)).toBeNull();
			expect(resolveAction(`${name}/trailing`)).toBeNull();
		}
	});

	test("answer 404 with Scryfall's error object, not a 500", async () => {
		for (const name of INHERITED) {
			for (const path of [`/${name}`, `/${name}/trailing`]) {
				const res = await testDispatch(ctx, path);
				expect(res.status).toBe(404);
				expect((await json(res)).code).toBe("not_found");
			}
		}
	});

	test("a real route is still resolved by its own name", () => {
		expect(resolveAction("cards/search")).toEqual({ key: "cards/search", positionalArgs: [] });
		expect(resolveAction("cards/xln/121")).toEqual({ key: "cards", positionalArgs: ["xln", "121"] });
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

describe("the one Postgres-backed route still on the public surface", () => {
	// get_common_keywords stayed public upstream (#963 moved only the data-management routes), and
	// it reads a SQL file against a database this deployment does not have.
	test("/get_common_keywords → 501 Not Implemented", async () => {
		const res = await testDispatch(ctx, "/get_common_keywords");
		expect(res.status).toBe(501);
		const body = await json(res);
		expect(body.title).toBe("Not Implemented");
		expect(String(body.description)).toContain("Postgres-backed route upstream");
	});
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
