// Proves a deploy actually reached users, from the outside.
//
//   bun scripts/verify-deploy.ts [origin ...]
//
// Run automatically at the end of scripts/deploy.sh. Defaults to both deployed
// origins; pass origins to override.
//
// This exists because "the deploy succeeded" and "users are running the new
// code" turned out to be different statements. A frontend fix once sat live on
// the CDN — byte-identical to the local build, verified with cmp — while a
// browser kept executing the previous bundle, and every check available at the
// time said the deploy was fine. The checks were looking at the wrong thing:
// they compared what was UPLOADED against what was BUILT, and never asked what
// a page actually tells a browser to fetch.
//
// So this walks the real chain, in the direction a browser walks it:
//
//   1. GET the page, exactly as a browser would.
//   2. Read the asset URLs OUT OF THAT HTML — not out of the local build.
//   3. GET each of those URLs and hash the bytes that come back.
//   4. Require that hash to equal the one committed in assets.gen.txt.
//
// Step 2 is the one that matters. Comparing the local build against the CDN
// would have passed all through the incident, because both halves were correct
// in isolation; what was broken was the POINTER between them. A check that
// re-derives the URL locally cannot see that, and a check that reads the URL
// from the served HTML cannot miss it.
//
// It also verifies the cache headers, because the headers are load-bearing:
// `immutable` on the assets is only safe while the document naming them is
// revalidated (see scripts/generate-assets.ts). If a change ever makes the HTML
// long-lived again, the assets silently become pinnable and this fails.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Generated {
	hashes: Record<string, string>;
	paths: Record<string, string>;
}
const generated = JSON.parse(readFileSync(join(repoRoot, "src/routes/assets.gen.txt"), "utf8")) as Generated;

const DEFAULT_ORIGINS = [
	"https://sylvan-librarian.daveycodez.workers.dev",
	"https://sylvan-librarian.deckgen.workers.dev",
];

const origins = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ORIGINS;

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`    ok   ${label}`);
	} else {
		failures++;
		console.log(`    FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
	}
}

async function sha12(response: Response): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(new Uint8Array(await response.arrayBuffer()));
	return hasher.digest("hex").slice(0, 12);
}

/** Every /static/... URL the served markup actually points a browser at. */
function assetUrlsIn(html: string): string[] {
	return [...html.matchAll(/["'(](\/static\/[A-Za-z0-9._-]+(?:\?[^"')\s]*)?)/g)].flatMap((m) => m[1] ?? []);
}

for (const origin of origins) {
	console.log(`\n==> ${origin}`);

	let html: string;
	let pageCacheControl: string | null;
	try {
		const page = await fetch(`${origin}/`, { headers: { "cache-control": "no-cache" } });
		check(page.ok, `GET / -> ${page.status}`);
		if (!page.ok) {
			continue;
		}
		pageCacheControl = page.headers.get("cache-control");
		html = await page.text();
	} catch (err) {
		check(false, `GET /`, String(err));
		continue;
	}

	// The document must not be cacheable by a browser without revalidation, or a
	// stale pointer can outlive the deploy — which is the failure this whole
	// scheme is built to prevent.
	check(
		pageCacheControl !== null && /max-age=0/.test(pageCacheControl) && /must-revalidate/.test(pageCacheControl),
		`page revalidates (Cache-Control: ${pageCacheControl})`,
	);

	// card.js is named only by the card page, so collect from both documents.
	// The card route renders a static shell, so any set/collector renders it.
	const cardPage = await fetch(`${origin}/card/lea/1`, { headers: { "cache-control": "no-cache" } });
	check(cardPage.ok, `GET /card/lea/1 -> ${cardPage.status}`);
	const served = [...assetUrlsIn(html), ...(cardPage.ok ? assetUrlsIn(await cardPage.text()) : [])];

	// No query-versioned asset may survive anywhere in the markup: under
	// Cloudflare's asset layer the query is not part of the asset's identity, so
	// such a URL is an alias for whatever currently sits at that path.
	const queryVersioned = served.filter((u) => u.includes("?"));
	check(queryVersioned.length === 0, "no ?v= asset URLs in the served HTML", queryVersioned.join(", "));

	for (const [name, path] of Object.entries(generated.paths)) {
		const expected = generated.hashes[name];

		// The pages must name the exact build that is committed here.
		check(served.includes(path), `a page points at ${path}`, `served: ${[...new Set(served)].join(", ")}`);

		const res = await fetch(`${origin}${path}`, { headers: { "cache-control": "no-cache" } });
		if (!res.ok) {
			check(false, `GET ${path} -> ${res.status}`);
			continue;
		}

		const actual = await sha12(res);
		check(actual === expected, `${path} serves the committed bytes`, `expected ${expected}, got ${actual}`);

		const cc = res.headers.get("cache-control") ?? "";
		check(cc.includes("immutable"), `${name} is immutable (Cache-Control: ${cc})`);
	}
}

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED — users are not necessarily running this build.`);
	process.exit(1);
}
console.log(`\nAll checks passed across ${origins.length} origin(s): users are running this build.`);
