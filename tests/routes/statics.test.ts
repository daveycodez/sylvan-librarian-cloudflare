// Static assets are served from public/ by Cloudflare's CDN and never reach
// the Worker, so there is no handler left to dispatch against. What still has
// to hold is that the generator put the right bytes at the right URLs, and
// that the Worker no longer carries them.
//
// scripts/generate-assets.ts writes both public/ and src/routes/assets.gen.txt
// from the same vendored sources, so this checks its output rather than a
// route.

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { routes } from "../../src/routes";

const generated = JSON.parse(readFileSync(join(import.meta.dir, "../../src/routes/assets.gen.txt"), "utf8")) as {
	hashes?: Record<string, string>;
};

const repoRoot = join(import.meta.dir, "../..");
const publicDir = join(repoRoot, "public");
const vendorStatic = join(repoRoot, "vendor/sylvan_librarian/api/static");

/** Public URL path -> file inside public/, as a browser would request it. */
const CDN_ASSETS: [url: string, file: string][] = [
	["/static/app.js", "static/app.js"],
	["/static/app.min.js", "static/app.min.js"],
	["/static/card.js", "static/card.js"],
	["/static/styles.css", "static/styles.css"],
	["/static/favicon.ico", "static/favicon.ico"],
	["/static/social-preview.webp", "static/social-preview.webp"],
	["/favicon.ico", "favicon.ico"],
	["/robots.txt", "robots.txt"],
	["/prefer_score_tuner.html", "prefer_score_tuner.html"],
];

describe("CDN static assets", () => {
	for (const [url, file] of CDN_ASSETS) {
		test(`${url} exists in public/ and is non-empty`, () => {
			expect(statSync(join(publicDir, file)).size).toBeGreaterThan(0);
		});
	}

	// Copied verbatim from upstream — the generator must not transform them.
	// (app.min.js is excluded: it is built here, not vendored.)
	const VERBATIM: [file: string, vendored: string][] = [
		["static/app.js", "app.js"],
		["static/card.js", "card.js"],
		["static/styles.css", "styles.css"],
		["static/favicon.ico", "favicon.ico"],
		["static/social-preview.webp", "social-preview.webp"],
		["favicon.ico", "favicon.ico"],
		["robots.txt", "robots.txt"],
		["prefer_score_tuner.html", "prefer_score_tuner.html"],
	];
	for (const [file, vendored] of VERBATIM) {
		test(`${file} is byte-identical to the vendored file`, () => {
			const shipped = readFileSync(join(publicDir, file));
			expect(Buffer.compare(shipped, readFileSync(join(vendorStatic, vendored)))).toBe(0);
		});
	}

	test("robots.txt body matches the vendored file", () => {
		expect(readFileSync(join(publicDir, "robots.txt"), "utf8")).toBe("User-agent: *\nDisallow: \nCrawl-delay: 5\n");
	});

	test("app.min.js is a real minification of app.js, not a copy", () => {
		const min = readFileSync(join(publicDir, "static/app.min.js"), "utf8");
		const full = readFileSync(join(publicDir, "static/app.js"), "utf8");
		expect(min.length).toBeGreaterThan(0);
		expect(min.length).toBeLessThan(full.length);
		expect(min).not.toBe(full);
	});

	test("_headers names only files that exist", () => {
		const headers = readFileSync(join(publicDir, "_headers"), "utf8");
		const paths = headers.split("\n").filter((l) => l.startsWith("/"));
		expect(paths.length).toBeGreaterThan(0);
		for (const p of paths) {
			expect(statSync(join(publicDir, p.slice(1))).size).toBeGreaterThan(0);
		}
	});

	test("the hash-busted assets get a long max-age but are NOT immutable", () => {
		const headers = readFileSync(join(publicDir, "_headers"), "utf8");
		// This test used to assert `immutable`, on the reasoning that a ?v=<content hash> URL can
		// never serve stale content because the URL changes first. That reasoning has a hole: the
		// hash is written into the HTML by the WORKER, and the asset is uploaded to the CDN
		// separately, so a request landing between the two deploy steps fetches the NEW url and
		// gets the OLD bytes. `immutable` then pins that for the full year — it means "never
		// revalidate, not even on an explicit reload" — with no recovery short of clearing site
		// data. It happened, and the only cure was telling people to clear their cache.
		//
		// The long max-age stays: it keeps normal navigation off the network. Dropping `immutable`
		// costs one revalidation on reload, and buys back the escape hatch a bad deploy needs.
		for (const p of ["/static/app.min.js", "/static/styles.css"]) {
			const block = headers.slice(headers.indexOf(p));
			expect(block.split("\n")[1]).toContain("max-age=31536000");
			expect(block.split("\n")[1]).not.toContain("immutable");
		}
	});
});

describe("the Worker no longer serves static files", () => {
	for (const [url] of CDN_ASSETS) {
		test(`${url} has no route`, () => {
			expect(routes[url.replace(/^\//, "")]).toBeUndefined();
		});
	}

	test("the asset blob is a fraction of what it was", () => {
		// It carried every browser file (~313KB) and now holds only the page
		// templates, fragments, critical CSS and hashes. Script size costs
		// isolate startup, which every /search pays — see generate-assets.ts.
		const bytes = statSync(join(repoRoot, "src/routes/assets.gen.txt")).size;
		expect(bytes).toBeLessThan(40 * 1024);
	});
});

describe("cache-busting hashes", () => {
	// assets.gen.txt is GENERATED, and it went stale against its generator once already: it lost
	// its `hashes` key entirely, so every asset URL was served as `?v=` with no value. _headers
	// sets `max-age=31536000, immutable` on /static/app.min.js by PATH, and Cloudflare does not
	// match query strings — so an unversioned URL under that header is permanently uncacheable-bust.
	// A frontend fix could not reach anyone who had already loaded the page.
	//
	// Comparing the stored hash against the bytes actually shipped catches that, and catches the
	// commoner version of it: regenerating public/ without committing assets.gen.txt, or the reverse.
	const hashed: [string, string][] = [
		["styles.css", "static/styles.css"],
		["app.min.js", "static/app.min.js"],
		["card.js", "static/card.js"],
	];

	for (const [name, file] of hashed) {
		test(`${name}'s hash matches the bytes in public/`, () => {
			const stored = generated.hashes?.[name];
			expect(stored, `${name} has no hash — the asset would ship unversioned`).toBeTruthy();
			const hasher = new Bun.CryptoHasher("sha256");
			hasher.update(readFileSync(join(publicDir, file)));
			expect(stored).toBe(hasher.digest("hex").slice(0, 12));
		});
	}

	test("every hash is a 12-char hex prefix", () => {
		for (const [name] of hashed) {
			expect(generated.hashes?.[name]).toMatch(/^[0-9a-f]{12}$/);
		}
	});
});
