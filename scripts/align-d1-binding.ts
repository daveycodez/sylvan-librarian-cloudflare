// Point the D1 binding at the database this Worker owns, before `wrangler
// deploy` reads the config.
//
// Workers Builds overrides the Worker name (WRANGLER_CI_OVERRIDE_NAME) but has
// no equivalent for bindings, and `wrangler deploy` has no --d1 flag — so a
// second Worker deployed from an unedited fork would publish its store to its
// own database while its binding still pointed at the first Worker's. This
// rewrites `database_name` in the build workspace so the two agree.
//
// It edits a file, so: it is a no-op unless the names actually differ (the
// single-Worker case never touches anything), it patches only that one string
// with a targeted replacement — the config is JSONC and a JSON round-trip would
// destroy every comment in it — and it says loudly what it did.
//
//   bun scripts/align-d1-binding.ts

import { configuredD1Name, d1Name, workerName } from "./project-config";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url).pathname;

if (configuredD1Name === d1Name) {
	console.log(`D1 binding already points at "${d1Name}".`);
	process.exit(0);
}

const raw = await Bun.file(CONFIG).text();
const pattern = /("database_name"\s*:\s*)"[^"]*"/;
if (!pattern.test(raw)) {
	console.error('align-d1-binding: no "database_name" field found in wrangler.jsonc — refusing to guess.');
	process.exit(1);
}
const next = raw.replace(pattern, `$1"${d1Name}"`);
await Bun.write(CONFIG, next);

console.log(
	`Worker deploys as "${workerName}" (CI override), so its D1 binding moves ` +
		`from "${configuredD1Name}" to "${d1Name}" — each Worker owns its own database.`,
);
