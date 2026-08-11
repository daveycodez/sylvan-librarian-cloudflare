// Regenerates the served static assets from the vendored upstream ones
// (vendor/sylvan_librarian/api/static). Run with:
//
//   bun scripts/generate-assets.ts
//
// Re-run whenever scripts/sync-upstream.sh updates anything under api/static.
//
// TWO outputs, split by who reads the file:
//
//   public/            files a BROWSER fetches, served straight from
//                      Cloudflare's CDN. These never enter the Worker script
//                      and never invoke the Worker at all.
//   src/routes/        the handful of fragments the Worker itself splices into
//     assets.gen.txt   page HTML, plus the cache-busting hashes.
//
// The split is a cold-start fix, measured. Everything used to be one ~313KB
// text module inside the script, and script size costs isolate startup at
// about 1.5ms per 100KB — which every /search paid, because at this traffic
// isolates rarely survive between requests:
//
//   blob in script   313KB -> 10,12,13ms startup   149KB -> 10,9ms
//                    0.5KB -> 7,7ms               (empty Worker floor: 5ms)
//
// Only ~17KB is genuinely Worker-side, so the rest moves to the CDN.
//
// app.min.js still does not exist upstream — their makefile builds it with
// `npx terser api/static/app.js --compress --mangle` — and the
// _STYLES_CSS_HASH/_APP_MIN_JS_HASH/_CARD_JS_HASH cache-busting hashes are
// still sha256 hex prefixes of file bytes, computed here at build time because
// a Worker has no process start to compute them at.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";
import { buildCriticalCss } from "../src/routes/critical-css";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const staticDir = join(repoRoot, "vendor/sylvan_librarian/api/static");
const fragmentsDir = join(staticDir, "fragments");
const outPath = join(repoRoot, "src/routes/assets.gen.txt");
const publicDir = join(repoRoot, "public");

function text(path: string): string {
	return readFileSync(path, "utf8");
}

/** Mirrors upstream _static_hash: sha256 of the file bytes, first 12 hex chars. */
function hash12(bytes: Uint8Array | string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex").slice(0, 12);
}

const appJs = text(join(staticDir, "app.js"));
// Upstream: `npx terser api/static/app.js --compress --mangle --output api/static/app.min.js`
// (makefile target api/static/app.min.js). --compress/--mangle with no options
// map to `{ compress: {}, mangle: {} }` here.
const minified = await minify(appJs, { compress: {}, mangle: {} });
if (typeof minified.code !== "string") {
	throw new Error("terser produced no output for app.js");
}
const appMinJs = minified.code;

// ── CDN assets ───────────────────────────────────────────────────────────────
//
// Written at the path a browser requests them from, so Cloudflare's asset
// worker matches the URL and serves the file WITHOUT invoking this Worker: no
// isolate start, no CPU, no request against the Worker's own budget.

/** [file inside public/, source path] */
const cdnAssets: [string, string][] = [
	["static/app.js", join(staticDir, "app.js")],
	["static/card.js", join(staticDir, "card.js")],
	["static/styles.css", join(staticDir, "styles.css")],
	["static/favicon.ico", join(staticDir, "favicon.ico")],
	["static/social-preview.webp", join(staticDir, "social-preview.webp")],
	// Upstream serves the icon from the root as well.
	["favicon.ico", join(staticDir, "favicon.ico")],
	["robots.txt", join(staticDir, "robots.txt")],
	["prefer_score_tuner.html", join(staticDir, "prefer_score_tuner.html")],
];

// ── Content-hashed filenames ─────────────────────────────────────────────────
//
// The hash lives in the FILENAME (app.<hash>.min.js), not in a query string
// (app.min.js?v=<hash>). This is the one change that makes the whole class of
// "the fix did not reach the user" bug impossible, and it is what Vite — and so
// TanStack Start, and Cloudflare's own Vite plugin — emit: /assets/img.2d8efhg.png.
//
// Why the query string could not work, demonstrated against the live deploy:
//
//   GET /static/app.min.js?v=deadbeef0000  ->  200, 25,599 bytes, current file
//   GET /static/app.min.js?v=              ->  200, 25,599 bytes, current file
//
// Cloudflare's asset layer resolves by PATH and ignores the query entirely, and
// _headers matches on path too. So `?v=` was never part of the asset's identity:
// there is exactly ONE object at /static/app.min.js, and every version of the
// URL — old, new, empty, garbage — is an alias for whatever that object happens
// to be right now. A client that asked for ?v=<new hash> during any window where
// the asset store still held the old bytes got the OLD FILE under the NEW KEY,
// with a year-long max-age stamped on it. The version token could not fail
// closed, because it was never read by anything.
//
// That is not a theory. A browser was found holding pre-fix app.min.js under
// ?v=2c8d03ce51b5 — the hash OF the fixed build — while curl at the identical
// URL returned the fixed bytes. It does not matter whether the window was opened
// by wrangler skipping an upload ("No updated asset files to upload") or by
// propagation inside Cloudflare: with a path-versioned URL neither can produce
// it. /static/app.<newhash>.min.js is a DISTINCT OBJECT. An asset store that
// does not have it yet returns 404 — which falls through to the Worker's 404 and
// is not cached for a year — instead of silently serving a different file. The
// failure mode changes from "wrong bytes, pinned until the user clears site
// data" to "briefly missing, then correct".
//
// Because the URL is now content-addressed, `immutable` is safe again and is
// what Cloudflare recommends for fingerprinted filenames. This reverses 885f2c5,
// which removed it — correctly, at the time: under query versioning a poisoned
// entry really was unrecoverable. `immutable` is only ever safe when a changed
// byte changes the URL, and until now a changed byte did not.
function hashedName(file: string, hash: string): string {
	const dot = file.indexOf(".");
	return `${file.slice(0, dot)}.${hash}${file.slice(dot)}`;
}

/** [logical name, file inside public/static, contents] */
const hashedAssets: [name: string, source: string, bytes: Uint8Array | string][] = [
	["styles.css", "styles.css", readFileSync(join(staticDir, "styles.css"))],
	["app.min.js", "app.min.js", appMinJs],
	["card.js", "card.js", readFileSync(join(staticDir, "card.js"))],
];

const hashes: Record<string, string> = {};
const hashedPaths: Record<string, string> = {};
/** [file inside public/, contents] for the content-addressed copies. */
const hashedWrites: [file: string, bytes: Uint8Array | string][] = [];
for (const [name, source, bytes] of hashedAssets) {
	const hash = hash12(bytes);
	const file = `static/${hashedName(source, hash)}`;
	hashes[name] = hash;
	hashedPaths[name] = `/${file}`;
	hashedWrites.push([file, bytes]);
}

// ── Superseded builds are KEPT, not deleted ──────────────────────────────────
//
// Content-hashing made `immutable` safe. Deleting the old file made stale HTML
// fatal — which is the same bug wearing the opposite coat.
//
// The comment below says `immutable` is safe because the document naming an
// asset is never served stale. That is true of the BROWSER cache: pages go out
// `max-age=0, must-revalidate`. It is not true of the EDGE. The same pages
// carry `stale-while-revalidate=86400`, so for up to a day a revalidation can
// be answered from the shared cache with a page built before this deploy — one
// naming /static/app.<oldhash>.min.js. Measured after a deploy: that URL 404s.
//
// A 404 on the script is not a flicker. Nothing hydrates: no re-render, no flip
// button, no modal, and whatever the server rendered is all the user ever sees
// until they reload. Exactly the "it was broken until I refreshed" report.
//
// So each build keeps the previous few hashes alive. They are a few hundred KB,
// served by the CDN rather than the Worker, and stop being requested the moment
// HTML turns over. RETAINED_BUILDS is deliberately larger than one: several
// deploys can land inside a single 24h staleness window, and it was one busy
// evening that produced the report.
//
// Retention is recorded in assets.gen.txt rather than inferred from whatever
// files happen to be lying in public/, so the generator stays deterministic:
// same inputs plus same previous state produce the same output, with no clocks
// and no directory scan deciding what survives.
const RETAINED_BUILDS = 5;

type PreviousManifest = { hashes?: Record<string, string>; retiredHashes?: Record<string, string[]> };
const previous: PreviousManifest = existsSync(outPath) ? (JSON.parse(text(outPath)) as PreviousManifest) : {};

/** Superseded hashes, most recently retired first, capped at RETAINED_BUILDS. */
const retiredHashes: Record<string, string[]> = {};
for (const [name, source] of hashedAssets) {
	const seen = [previous.hashes?.[name], ...(previous.retiredHashes?.[name] ?? [])];
	const kept: string[] = [];
	for (const hash of seen) {
		// Skip the hash we just built: it is current, not retired.
		if (!hash || hash === hashes[name] || kept.includes(hash)) continue;
		// Only keep a hash whose BYTES still exist — on a fresh clone, or after a
		// hand-pruned public/, there is nothing to republish and a _headers entry
		// for a missing file would fail the statics test rather than help anyone.
		if (!existsSync(join(publicDir, `static/${hashedName(source, hash)}`))) continue;
		kept.push(hash);
		if (kept.length === RETAINED_BUILDS) break;
	}
	retiredHashes[name] = kept;
}

/** [file inside public/, contents] read back BEFORE public/ is wiped. */
const retainedWrites: [file: string, bytes: Uint8Array][] = [];
for (const [name, source] of hashedAssets) {
	for (const hash of retiredHashes[name] ?? []) {
		const file = `static/${hashedName(source, hash)}`;
		retainedWrites.push([file, readFileSync(join(publicDir, file))]);
	}
}

// Cache lifetimes. Two tiers, matching Cloudflare's guidance for Workers static
// assets and the Vite/TanStack convention:
//
//   content-hashed paths   public, max-age=31536000, immutable
//   everything else        public, max-age=0, must-revalidate  (the platform default)
//
// The unhashed originals stay published on must-revalidate. They are the
// fallback for any client still holding HTML that points at them, and for
// anything linking the upstream path directly; revalidating means such a client
// gets current bytes rather than a 404 or a stale copy. Nothing this repo
// renders points at them any more.
//
// The long-lived entries and the always-revalidated HTML are a MATCHED PAIR, not
// two independent choices. `immutable` on the asset is only safe because the
// document that names it is never served stale — see pageCacheHeader() in
// src/routes/http.ts. Take one without the other and a browser can pin a
// year-long asset from a pointer it read out of an hour-old cached page.
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";
const HEADERS = `# GENERATED by scripts/generate-assets.ts - do not edit.
${[...Object.values(hashedPaths), ...retainedWrites.map(([file]) => `/${file}`)]
	.map((p) => `${p}\n  Cache-Control: ${IMMUTABLE}\n`)
	.join("")}/static/app.min.js
  Cache-Control: ${REVALIDATE}
/static/styles.css
  Cache-Control: ${REVALIDATE}
/static/card.js
  Cache-Control: ${REVALIDATE}
/static/app.js
  Cache-Control: public, max-age=86400
/static/social-preview.webp
  Cache-Control: public, max-age=2592000
/static/favicon.ico
  Cache-Control: public, max-age=604800
/favicon.ico
  Cache-Control: public, max-age=604800
/robots.txt
  Cache-Control: public, max-age=86400
`;

rmSync(publicDir, { recursive: true, force: true });
for (const [name, source] of cdnAssets) {
	const dest = join(publicDir, name);
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, readFileSync(source));
}
// Built here, so it has no source file to copy.
mkdirSync(join(publicDir, "static"), { recursive: true });
writeFileSync(join(publicDir, "static/app.min.js"), appMinJs);

// The content-addressed copies the pages actually link. Same bytes as the
// unhashed original above — the hash is derived from exactly these bytes, so
// the URL cannot name content that was never published under it.
for (const [file, bytes] of hashedWrites) {
	writeFileSync(join(publicDir, file), bytes);
}
// Republished byte-for-byte from the previous build, so a page still naming one
// keeps working instead of 404ing its own script.
for (const [file, bytes] of retainedWrites) {
	writeFileSync(join(publicDir, file), bytes);
}

writeFileSync(join(publicDir, "_headers"), HEADERS);

// ── Worker-side fragments ────────────────────────────────────────────────────
//
// What is left is only what the WORKER reads: the page templates it splices
// values into, and the cache-busting hashes it writes into their markup.

const out = {
	comment: "GENERATED FILE - do not edit. Built by scripts/generate-assets.ts from vendor/sylvan_librarian/api/static.",
	text: {
		"index.html": text(join(staticDir, "index.html")),
		"card.html": text(join(staticDir, "card.html")),
		"fragments/favicon.html": text(join(fragmentsDir, "favicon.html")),
		"fragments/preconnects.html": text(join(fragmentsDir, "preconnects.html")),
		"fragments/fonts.html": text(join(fragmentsDir, "fonts.html")),
		"fragments/css.html": text(join(fragmentsDir, "css.html")),
		"fragments/footer.html": text(join(fragmentsDir, "footer.html")),
	},
	// Upstream builds this in APIResource.__init__ from styles.css, and this
	// port used to redo it at module init — which meant every isolate carried
	// the whole 17KB stylesheet AND re-derived the same string before it could
	// serve anything. It is a pure function of a file that only changes when
	// upstream does, so it belongs here.
	criticalCss: buildCriticalCss(text(join(staticDir, "styles.css"))),
	// Upstream computes these at import time from the files on disk
	// (api_resource.py _static_hash). app.min.js hashes the terser output above,
	// exactly as upstream hashes the terser output the makefile wrote to disk.
	// Kept because the deploy verifier and the tests compare them against the
	// bytes in public/; the pages themselves use `paths`.
	hashes,
	// What the Worker splices into the markup: a full, content-addressed path.
	// Upstream appends ?v=<hash> to a fixed path instead. That is the one place
	// this port deliberately departs from api_resource.py, and it has to: their
	// WSGI app serves the file itself, so the bytes behind /static/app.min.js
	// and the hash in the HTML always move together in one process. Here the
	// asset lives on a CDN that resolves by path and ignores the query, so a
	// query-versioned URL is an alias for whatever object currently sits at that
	// path — which is exactly how a browser ended up pinning pre-fix bytes under
	// the post-fix ?v=. Putting the hash in the path restores the invariant
	// upstream gets for free: one URL, one set of bytes, forever.
	paths: hashedPaths,
	// Hashes of superseded builds whose files are still published, most recently
	// retired first. Read back by the NEXT run to decide what to keep alive —
	// which is what makes retention deterministic rather than a scan of whatever
	// happens to be sitting in public/. Nothing at runtime reads this.
	retiredHashes,
};

// Emitted as TEXT, not as a JSON module, and compact rather than indented: a
// JSON import is inlined by the bundler as an object literal that every isolate
// materialises at startup. Small now that the browser files live on the CDN,
// but the property still holds.
writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${outPath} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB, was ~313 KiB)`);
console.log(`Wrote ${publicDir}/ (${cdnAssets.length + 1} CDN assets + _headers)`);
console.log(`hashes: ${JSON.stringify(out.hashes)}`);
