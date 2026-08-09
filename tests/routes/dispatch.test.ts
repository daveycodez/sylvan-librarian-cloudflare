// Dispatch-level behavior: the 404 routes listing (upstream
// _build_routes_listing shape and ordering), 405 + Allow, positional
// capacities, get_pid, and the Postgres-only 501 stubs.

import { describe, expect, test } from "bun:test";
import { buildRoutesListing } from "../../src/routes";
import { json, makeCtx, testDispatch } from "./harness";

const ctx = makeCtx();

describe("404 routes listing", () => {
	test("unknown path answers 404 with the full routes listing", async () => {
		const res = await testDispatch(ctx, "/definitely_not_a_route");
		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body.title).toBe("Not Found");
		const routes = (body.description as { routes: Record<string, unknown> }).routes;
		expect(routes).toEqual(JSON.parse(JSON.stringify(buildRoutesListing())));
	});

	test("listing keys follow upstream registration order", () => {
		expect(Object.keys(buildRoutesListing())).toEqual([
			"index",
			"index.html",
			"_root",
			"backfill_cubecobra_scores",
			"backfill_prefer_scores",
			"card",
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
			"ingest_cubecobra",
			"random_search",
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
	test("POST to a GET route is 405 with sorted Allow", async () => {
		const res = await testDispatch(ctx, "/search", "POST");
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET, HEAD");
		expect((await json(res)).description).toBe("Allowed methods: GET, HEAD");
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
