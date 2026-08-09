// Pin the D1 binding to the exact database this deploy publishes into, before
// `wrangler deploy` reads the config.
//
// Two failure modes this prevents, both seen in real builds:
//
//  1. A stale inherited id. wrangler.jsonc declares the binding by NAME only,
//     so `wrangler deploy` reuses the id already attached to the deployed
//     Worker (it prints the binding as "inherited"). Delete the D1 database and
//     redeploy and that id no longer exists: the import happily creates and
//     fills a NEW database, then the deploy dies with "The database <old-uuid>
//     could not be found [code: 7404]". Writing the id we actually published
//     into makes the binding deterministic instead of inherited.
//
//  2. A second Worker sharing the first one's database. Workers Builds renames
//     the Worker via WRANGLER_CI_OVERRIDE_NAME, and the D1 name derives from
//     that, so the name here can differ from what the file says.
//
// It edits wrangler.jsonc, so: no-op when nothing needs to change, targeted
// single-value replacements (the file is JSONC — a JSON round-trip would
// destroy every comment), and it says what it changed. The edit lands in the
// ephemeral build workspace, never in the repo.
//
//   bun scripts/align-d1-binding.ts

import { configuredD1Name, d1Name, workerName } from "./project-config";
import { wranglerArgv } from "./wrangler-cmd";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url).pathname;

/** The live database's uuid. It must exist by now — import-store.sh creates it
 * first — so a failure here is real and must not be papered over.
 *
 * Uses `d1 list`, not `d1 info <name>`: info resolves the name through this
 * config's binding, so a STALE database_id — the very thing this script exists
 * to repair — makes it fail with 7404 before it can tell us anything. list is
 * account-level and answers regardless. */
async function databaseId(name: string): Promise<string> {
	const proc = Bun.spawn([...wranglerArgv(), "d1", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((await proc.exited) !== 0) {
		throw new Error(`cannot list D1 databases: ${(err.trim() || out.trim()).split("\n").slice(-3).join(" ")}`);
	}
	const all = JSON.parse(out.slice(out.indexOf("["))) as { uuid?: string; name?: string }[];
	const match = all.find((d) => d.name === name);
	if (!match?.uuid) {
		throw new Error(`no D1 database named "${name}" on this account (have: ${all.map((d) => d.name).join(", ")})`);
	}
	return match.uuid;
}

const id = await databaseId(d1Name);
let raw = await Bun.file(CONFIG).text();
const changes: string[] = [];

if (configuredD1Name !== d1Name) {
	const namePattern = /("database_name"\s*:\s*)"[^"]*"/;
	if (!namePattern.test(raw)) throw new Error('no "database_name" field in wrangler.jsonc — refusing to guess');
	raw = raw.replace(namePattern, `$1"${d1Name}"`);
	changes.push(`database_name "${configuredD1Name}" → "${d1Name}" (Worker deploys as "${workerName}")`);
}

const idPattern = /("database_id"\s*:\s*)"([^"]*)"/;
const existing = idPattern.exec(raw);
if (existing) {
	if (existing[2] !== id) {
		raw = raw.replace(idPattern, `$1"${id}"`);
		changes.push(`database_id "${existing[2]}" → "${id}"`);
	}
} else {
	// Insert after database_name, preserving the file's indentation style.
	const anchor = /(\n(\s*)"database_name"\s*:\s*"[^"]*")/;
	if (!anchor.test(raw)) throw new Error('no "database_name" field to anchor database_id to');
	raw = raw.replace(anchor, `$1,\n$2"database_id": "${id}"`);
	changes.push(`database_id pinned to "${id}"`);
}

if (changes.length === 0) {
	console.log(`D1 binding already pinned to "${d1Name}" (${id}).`);
	process.exit(0);
}
await Bun.write(CONFIG, raw);
for (const change of changes) console.log(`D1 binding: ${change}`);
