// _root SSR: placeholder replacement with embedded results, no-query and
// failure paths, cache headers, site naming; plus the card page and the legacy
// index redirects.

import { beforeEach, describe, expect, test } from "bun:test";
import { installFakeParser, json, makeCtx, testDispatch } from "./harness";

beforeEach(() => {
	installFakeParser();
});

describe("_root without a query", () => {
	test("serves the index page with placeholders intact, cached 1h", async () => {
		const res = await testDispatch(makeCtx(), "/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
		const html = await res.text();
		expect(html).toContain("<!-- SERVER_SIDE_RESULTS -->");
		expect(html).toContain("<!-- SERVER_SIDE_RESULTS_COUNT -->");
		expect(html).toContain("<!-- SERVER_SIDE_EMBEDDED_DATA -->");
	});

	test("site name is derived from the request host", async () => {
		const res = await testDispatch(makeCtx({ requestHost: "sylvan-librarian.com" }), "/");
		const html = await res.text();
		expect(html).toContain("<title>Sylvan Librarian - Magic: The Gathering Card Search</title>");
		expect(html).not.toContain("%%%SITENAME%%%");
	});

	test("unusable hosts fall back to MTG Search", async () => {
		const res = await testDispatch(makeCtx({ requestHost: "127.0.0.1:8080" }), "/");
		expect(await res.text()).toContain("<title>MTG Search - Magic: The Gathering Card Search</title>");
	});

	test("shared fragments and cache-busted asset URLs are spliced in", async () => {
		const html = await (await testDispatch(makeCtx(), "/")).text();
		expect(html).not.toContain("<!-- FOOTER -->");
		expect(html).not.toContain("<!-- CSS -->");
		expect(html).toContain('<footer class="footer">');
		expect(html).toMatch(/\/static\/styles\.css\?v=[0-9a-f]{12}/);
		expect(html).toMatch(/\/static\/app\.min\.js\?v=[0-9a-f]{12}/);
		// Critical CSS inlined into the <style> block.
		expect(html).toContain(".results-container{");
	});
});

describe("_root with a search query", () => {
	test("embeds server-side results, count and envelope, cached 90s", async () => {
		const res = await testDispatch(makeCtx(), "/?q=elf");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=90");
		const html = await res.text();
		expect(html).not.toContain("<!-- SERVER_SIDE_RESULTS -->");
		expect(html).not.toContain("<!-- SERVER_SIDE_EMBEDDED_DATA -->");
		expect(html).toContain('window.EMBEDDED_SEARCH_RESULTS = {"cards":');
		expect(html).toContain('<div class="results-count">Found 17 cards matching "elf"</div>');
		expect(html).toContain('data-card-id="0"');
		expect(html).toContain('<div class="card-name">Llanowar Elves</div>');
		// Mana symbols render as span markup, not raw braces.
		expect(html).toContain('<span class="mana-symbol ms ms-g ms-cost"></span>');
		// Card images link to the card page.
		expect(html).toContain('<a href="/card/m19/314" class="card-page-link">');
	});

	test("bad enum on _root is a binding 400, not a soft failure", async () => {
		const res = await testDispatch(makeCtx(), "/?q=elf&orderby=bogus");
		expect(res.status).toBe(400);
		expect((await json(res)).title).toBe("Invalid Parameter");
	});

	test("parse failure serves the page without results, cached 1h", async () => {
		const res = await testDispatch(makeCtx(), "/?q=PARSE_FAIL((");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
		const html = await res.text();
		expect(html).toContain("<!-- SERVER_SIDE_RESULTS -->");
		expect(html).toContain("<!-- SERVER_SIDE_EMBEDDED_DATA -->");
	});

	test("unloaded engine propagates as a 503 (upstream's setup-incomplete parity)", async () => {
		const res = await testDispatch(makeCtx({ engine: null }), "/?q=elf");
		expect(res.status).toBe(503);
	});
});

describe("card page", () => {
	test("serves the card shell for /card/{set}/{collector}, cached 1h", async () => {
		const res = await testDispatch(makeCtx(), "/card/m19/314");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
		const html = await res.text();
		expect(html).toContain("Sylvan Librarian");
		expect(html).not.toContain("%%%SITENAME%%%");
		expect(html).toMatch(/\/static\/card\.js\?v=[0-9a-f]{12}/);
	});

	test("query param colliding with a path segment is upstream's TypeError 400", async () => {
		const res = await testDispatch(makeCtx(), "/card/m19/314?set_code=neo");
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({
			title: "400 Bad Request",
			description: "APIResource.card() got multiple values for set_code",
		});
	});

	test("three path segments no longer resolve to the card route", async () => {
		const res = await testDispatch(makeCtx(), "/card/a/b/c");
		expect(res.status).toBe(404);
	});
});

describe("legacy index redirects", () => {
	for (const path of ["/index", "/index.html"]) {
		test(`${path} answers 301 to /`, async () => {
			const res = await testDispatch(makeCtx(), path);
			expect(res.status).toBe(301);
			expect(res.headers.get("Location")).toBe("/");
		});
	}
});
