// _root SSR: placeholder replacement with embedded results, no-query and
// failure paths, cache headers, site naming; plus the card page and the legacy
// index redirects.

import { beforeEach, describe, expect, test } from "bun:test";
import { buildImageUrl, createCardHtml, scryfallImageUrl } from "../../src/routes/noscript";
import { installFakeParser, json, makeCtx, testDispatch } from "./harness";

beforeEach(() => {
	installFakeParser();
});

describe("_root without a query", () => {
	test("serves the index page with placeholders intact, revalidated by the browser", async () => {
		const res = await testDispatch(makeCtx(), "/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate, s-maxage=3600");
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

	test("every host gets the fixed Sylvan Librarian title (deliberate deviation)", async () => {
		const res = await testDispatch(makeCtx({ requestHost: "127.0.0.1:8080" }), "/");
		expect(await res.text()).toContain("<title>Sylvan Librarian - Magic: The Gathering Card Search</title>");
	});

	test("shared fragments and content-addressed asset URLs are spliced in", async () => {
		const html = await (await testDispatch(makeCtx(), "/")).text();
		expect(html).not.toContain("<!-- FOOTER -->");
		expect(html).not.toContain("<!-- CSS -->");
		expect(html).toContain('<footer class="footer">');
		expect(html).toMatch(/\/static\/styles\.[0-9a-f]{12}\.css/);
		expect(html).toMatch(/\/static\/app\.[0-9a-f]{12}\.min\.js/);
		// The query form is what let a browser pin pre-fix bytes under the post-fix URL.
		expect(html).not.toContain("?v=");
		// Critical CSS inlined into the <style> block.
		expect(html).toContain(".results-container{");
	});
});

describe("_root with a search query", () => {
	test("embeds server-side results, count and envelope, cached 90s", async () => {
		const res = await testDispatch(makeCtx(), "/?q=elf");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe(
			"public, max-age=0, must-revalidate, s-maxage=90, stale-while-revalidate=86400",
		);
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

	test("parse failure serves the page without results, revalidated by the browser", async () => {
		const res = await testDispatch(makeCtx(), "/?q=PARSE_FAIL((");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate, s-maxage=3600");
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
	test("serves the card shell for /card/{set}/{collector}, revalidated by the browser", async () => {
		const res = await testDispatch(makeCtx(), "/card/m19/314");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate, s-maxage=3600");
		const html = await res.text();
		expect(html).toContain("Sylvan Librarian");
		expect(html).not.toContain("%%%SITENAME%%%");
		expect(html).toMatch(/\/static\/card\.[0-9a-f]{12}\.js/);
		expect(html).not.toContain("?v=");
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

// Card images are a DELIBERATE DEVIATION: Scryfall's CDN, not upstream's CloudFront
// mirror. The port has no pipeline to populate that mirror, and the mirror is wrong
// for exactly the cards this matters for — its face-1 object is the BACK face's art
// for every transform/MDFC card, and it has no face-2 object at all.
//
// Worth pinning rather than trusting: an image URL that silently 404s looks like a
// missing image, not like a bug, and nothing else in the suite would notice.
describe("card images come from Scryfall, derived from scryfall_id", () => {
	const ID = "9d9a9350-4734-4cc1-986d-467e6715199f";

	test("the front URL shards on the first two characters of the id", () => {
		expect(scryfallImageUrl(ID, "normal")).toBe(`https://cards.scryfall.io/normal/front/9/d/${ID}.jpg`);
	});

	test("png is the lossless version and carries the matching extension", () => {
		expect(scryfallImageUrl(ID, "png")).toBe(`https://cards.scryfall.io/png/front/9/d/${ID}.png`);
		expect(scryfallImageUrl(ID, "large")).toEndWith(".jpg");
	});

	test("the back face is a side, not a face index", () => {
		expect(scryfallImageUrl(ID, "normal", true)).toContain("/back/");
		expect(scryfallImageUrl(ID, "normal", false)).toContain("/front/");
	});

	test("a row without scryfall_id yields no URL rather than a 404-ing one", () => {
		expect(buildImageUrl({ name: "Whatever", set_code: "bot", collector_number: "6" }, "normal")).toBe("");
	});

	test("a rendered card names Scryfall and never the CloudFront mirror", () => {
		const html = createCardHtml({ name: "Slicer, Hired Muscle", scryfall_id: ID }, 0);
		expect(html).toContain("cards.scryfall.io");
		expect(html).not.toContain("cloudfront.net");
		// The srcset advertises the widths Scryfall actually publishes. Claiming a
		// width the CDN does not serve makes the browser pick the wrong source.
		expect(html).toContain("488w");
		expect(html).toContain("672w");
		expect(html).toContain("745w");
	});
});

// The mana font is the one that flashes visibly: a mana symbol is
// <span class="ms ms-g"> with no text of its own, so before the font arrives
// there is no glyph at all, and it pops in afterwards. The font stylesheets
// deliberately load with media="print" to stay off the critical path, which
// means the browser cannot discover the woff2 until it has parsed the CSS —
// unless it is preloaded. Pinned because losing a preload costs nothing at
// build time and shows up only as a flicker on someone else's machine.
describe("font loading hints", () => {
	const FONTS = ["mana/mana-subset", "beleren/beleren-subset", "mplantin/mplantin-subset"];
	const CDN = "https://d1hot9ps2xugbc.cloudfront.net/cdn/fonts";

	/** Each <link> as its own chunk — the markup is prettier-wrapped across lines. */
	const links = (html: string) => html.split("<link").map((chunk) => chunk.replace(/\s+/g, " "));

	test("every font stylesheet and its woff2 are preloaded", async () => {
		const all = links(await (await testDispatch(makeCtx(), "/")).text());
		for (const font of FONTS) {
			expect(
				all.some((l) => l.includes('as="font"') && l.includes(`${CDN}/${font}.woff2`)),
				`${font}.woff2 must be preloaded, or the browser cannot start fetching it until the CSS is parsed`,
			).toBe(true);
			expect(
				all.some((l) => l.includes('as="style"') && l.includes(`${CDN}/${font}.css`)),
				`${font}.css must be preloaded`,
			).toBe(true);
		}
	});

	test("font preloads carry crossorigin, without which they are fetched twice", async () => {
		const all = links(await (await testDispatch(makeCtx(), "/")).text());
		const fontPreloads = all.filter((l) => l.includes('as="font"'));
		expect(fontPreloads.length).toBe(FONTS.length);
		for (const link of fontPreloads) {
			expect(link, "a font preload without crossorigin is discarded and refetched").toContain("crossorigin");
		}
	});

	test("the connection is warmed in both credential modes", async () => {
		const all = links(await (await testDispatch(makeCtx(), "/")).text());
		const preconnects = all.filter((l) => l.includes('rel="preconnect"'));
		// A preconnect's crossorigin flag is part of its identity, so the anonymous
		// connection the fonts need is not the one the stylesheets use.
		expect(preconnects.some((l) => !l.includes("crossorigin"))).toBe(true);
		expect(preconnects.some((l) => l.includes("crossorigin"))).toBe(true);
	});
});
