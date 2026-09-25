// The weekly platform-drift check (backlog g2): does the NEWEST @cloudflare/workers-types name a
// Durable Object location hint this deployment does not route to?
//
//   bun scripts/check-location-hints.ts <path to workers-types index.d.ts>
//
// Independent of the compatibility date, unlike `wrangler types`: it reads the union straight out
// of the package's declaration file. Exits non-zero (with a GitHub `::error::`) on any difference.

import { readFileSync } from "node:fs";
import { REGION_HINTS } from "../src/engine/region";

const path = process.argv[2];
if (!path) {
	console.error("usage: bun scripts/check-location-hints.ts <workers-types index.d.ts>");
	process.exit(2);
}
const source = readFileSync(path, "utf-8");
const match = /type DurableObjectLocationHint\s*=\s*([^;]+);/.exec(source);
if (!match?.[1]) {
	console.error(`::error::no DurableObjectLocationHint union found in ${path}`);
	process.exit(1);
}
const upstream = new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string));
const ours = new Set<string>(REGION_HINTS);
const missing = [...upstream].filter((h) => !ours.has(h));
const gone = [...ours].filter((h) => !upstream.has(h));
if (missing.length || gone.length) {
	if (missing.length) {
		console.error(
			`::error::Cloudflare offers location hint(s) this deployment does not route to: ${missing.join(", ")} — add them to REGIONS in src/engine/region.ts`,
		);
	}
	if (gone.length) console.error(`::error::hint(s) no longer in workers-types: ${gone.join(", ")}`);
	process.exit(1);
}
console.log(`location hints match: ${[...upstream].sort().join(", ")}`);
