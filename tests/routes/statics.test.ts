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
	paths?: Record<string, string>;
};

/** [logical name, the unhashed original inside public/] */
const hashed: [name: string, file: string][] = [
	["styles.css", "static/styles.css"],
	["app.min.js", "static/app.min.js"],
	["card.js", "static/card.js"],
];

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

	test("content-addressed paths are immutable; the unhashed originals revalidate", () => {
		const headers = readFileSync(join(publicDir, "_headers"), "utf8");
		const ruleFor = (path: string): string => {
			const at = headers.indexOf(`\n${path}\n`);
			expect(at, `_headers has no rule for ${path}`).toBeGreaterThan(-1);
			return headers.slice(at + 1).split("\n")[1] ?? "";
		};

		// `immutable` is safe here and ONLY here. It means "never revalidate, not even on an
		// explicit reload", so it is only ever correct on a URL that cannot change meaning — and
		// under the old ?v=<hash> scheme the URL could, because Cloudflare's asset layer resolves
		// by path and ignores the query. One object sat at /static/app.min.js and every ?v= was an
		// alias for it, so a client asking for the new version during any window where the old
		// bytes were still deployed got them, and `immutable` pinned them for a year. That is not
		// hypothetical: a browser was found holding pre-fix app.min.js under ?v=2c8d03ce51b5.
		// 885f2c5 removed `immutable` for that reason and was right to.
		//
		// With the hash in the PATH the alias is gone: /static/app.<hash>.min.js is a distinct
		// object whose name is derived from its bytes, so an asset store that lacks those bytes
		// 404s (recoverable) rather than serving different ones under the same key.
		for (const [name] of hashed) {
			const path = generated.paths?.[name];
			expect(path, `${name} has no hashed path`).toBeTruthy();
			expect(ruleFor(path as string)).toBe("  Cache-Control: public, max-age=31536000, immutable");
		}

		// The unhashed originals stay published as a fallback for clients still holding markup
		// that names them. They must revalidate: they are NOT content-addressed, so a long TTL
		// on them would recreate exactly the bug above.
		for (const p of ["/static/app.min.js", "/static/styles.css", "/static/card.js"]) {
			expect(ruleFor(p)).toBe("  Cache-Control: public, max-age=0, must-revalidate");
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
	// its `hashes` key entirely, so every asset URL was served as `?v=` with no value. Back then
	// _headers put `max-age=31536000, immutable` on /static/app.min.js by PATH — and Cloudflare
	// does not match query strings — so an unversioned URL under that header could never be
	// cache-busted. A frontend fix could not reach anyone who had already loaded the page.
	//
	// The hash now lives in the path, which removes that failure entirely, but the check below is
	// what keeps it removed: it is the only thing standing between a URL and the bytes it claims to
	// name. It catches the commoner version too — regenerating public/ without committing
	// assets.gen.txt, or the reverse.
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

	// The property that makes the URL trustworthy: the name is DERIVED from the bytes served
	// under it, so a URL can never denote content that was not published at that URL. This is
	// what ?v= could not give us — there, the name was fixed and the bytes were whatever the
	// asset store currently held.
	for (const [name, original] of hashed) {
		test(`${name} is published at a path its own bytes hash to`, () => {
			const path = generated.paths?.[name];
			expect(path, `${name} has no hashed path — the asset would ship unversioned`).toBeTruthy();

			const bytes = readFileSync(join(publicDir, (path as string).replace(/^\//, "")));
			const hasher = new Bun.CryptoHasher("sha256");
			hasher.update(bytes);
			const digest = hasher.digest("hex").slice(0, 12);

			// the hash embedded in the filename == the hash of the file's own bytes
			expect(path).toContain(digest);
			expect(generated.hashes?.[name]).toBe(digest);
			// and it is the same file as the unhashed original, not a stale copy of it
			expect(Buffer.compare(bytes, readFileSync(join(publicDir, original)))).toBe(0);
		});
	}

	test("hashed paths live under /static/ and carry no query string", () => {
		for (const [name] of hashed) {
			expect(generated.paths?.[name]).toMatch(/^\/static\/[A-Za-z0-9.]+$/);
		}
	});
});
