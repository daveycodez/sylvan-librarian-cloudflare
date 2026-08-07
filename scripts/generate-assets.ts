// Regenerates src/routes/assets.gen.json from the vendored upstream static
// assets (vendor/sylvan_librarian/api/static). Run with:
//
//   bun scripts/generate-assets.ts && bunx biome check --write src/routes/assets.gen.json
//
// Re-run whenever scripts/sync-upstream.sh updates anything under api/static.
//
// Why a generated module instead of wrangler `rules` imports: the routes must
// serve app.js/card.js *as text* (a `Text` rule glob for `**/*.js` would break
// real JS module imports), app.min.js does not exist upstream — their makefile
// builds it with `npx terser api/static/app.js --compress --mangle` — and the
// _STYLES_CSS_HASH/_APP_MIN_JS_HASH/_CARD_JS_HASH cache-busting hashes are
// sha256 hex prefixes computed from file bytes at process start, which is
// build time for a Worker. Emitting one JSON blob keeps all of that identical
// under bun test and under wrangler's bundler, with no per-runtime loader
// configuration.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const staticDir = join(repoRoot, "vendor/sylvan_librarian/api/static");
const fragmentsDir = join(staticDir, "fragments");
const outPath = join(repoRoot, "src/routes/assets.gen.json");

function text(path: string): string {
	return readFileSync(path, "utf8");
}

function base64(path: string): string {
	return readFileSync(path).toString("base64");
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

const out = {
	comment: "GENERATED FILE - do not edit. Built by scripts/generate-assets.ts from vendor/sylvan_librarian/api/static.",
	text: {
		"app.js": appJs,
		"app.min.js": appMinJs,
		"card.js": text(join(staticDir, "card.js")),
		"styles.css": text(join(staticDir, "styles.css")),
		"index.html": text(join(staticDir, "index.html")),
		"card.html": text(join(staticDir, "card.html")),
		"robots.txt": text(join(staticDir, "robots.txt")),
		"prefer_score_tuner.html": text(join(staticDir, "prefer_score_tuner.html")),
		"fragments/favicon.html": text(join(fragmentsDir, "favicon.html")),
		"fragments/preconnects.html": text(join(fragmentsDir, "preconnects.html")),
		"fragments/fonts.html": text(join(fragmentsDir, "fonts.html")),
		"fragments/css.html": text(join(fragmentsDir, "css.html")),
		"fragments/footer.html": text(join(fragmentsDir, "footer.html")),
	},
	binaryBase64: {
		"favicon.ico": base64(join(staticDir, "favicon.ico")),
		"social-preview.webp": base64(join(staticDir, "social-preview.webp")),
	},
	// Upstream computes these at import time from the files on disk
	// (api_resource.py _static_hash). app.min.js hashes the terser output above,
	// exactly as upstream hashes the terser output the makefile wrote to disk.
	hashes: {
		"styles.css": hash12(readFileSync(join(staticDir, "styles.css"))),
		"app.min.js": hash12(appMinJs),
		"card.js": hash12(readFileSync(join(staticDir, "card.js"))),
	},
};

writeFileSync(outPath, `${JSON.stringify(out, null, "\t")}\n`);
console.log(`Wrote ${outPath}`);
console.log(`hashes: ${JSON.stringify(out.hashes)}`);
