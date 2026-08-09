// Create the KV namespace this deploy publishes the store into, and pin the
// binding to it, before `wrangler deploy` reads the config.
//
// KV bindings are id-only — there is no name-based form wrangler can resolve
// at deploy time — so a fork cannot ship a working id in the repo, and a
// second Worker on the same account must not inherit the first one's. Both
// are solved by deriving the namespace name from the Worker name wrangler
// will actually deploy as (WRANGLER_CI_OVERRIDE_NAME included), creating it if
// absent, and writing its id into wrangler.jsonc.
//
// It edits wrangler.jsonc, so: no-op when nothing needs to change, a single
// targeted replacement (the file is JSONC — a JSON round-trip would destroy
// every comment), and it says what it changed. The edit lands in the
// ephemeral build workspace, never in the repo.
//
//   bun scripts/align-kv-binding.ts

import { configuredKvId, kvName, workerName } from "./project-config";
import { wranglerArgv } from "./wrangler-cmd";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url).pathname;

interface Namespace {
	id?: string;
	title?: string;
}

/** Every KV namespace on the account, by title. */
async function listNamespaces(): Promise<Namespace[]> {
	const proc = Bun.spawn([...wranglerArgv(), "kv", "namespace", "list"], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((await proc.exited) !== 0) {
		throw new Error(`cannot list KV namespaces: ${(err.trim() || out.trim()).split("\n").slice(-3).join(" ")}`);
	}
	const at = out.indexOf("[");
	if (at < 0) return [];
	return JSON.parse(out.slice(at)) as Namespace[];
}

/** The namespace's id, creating it when this account has none by that name. */
async function namespaceId(): Promise<string> {
	const existing = (await listNamespaces()).find((n) => n.title === kvName);
	if (existing?.id) return existing.id;

	console.log(`Creating KV namespace "${kvName}"...`);
	const proc = Bun.spawn([...wranglerArgv(), "kv", "namespace", "create", kvName], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((await proc.exited) !== 0) {
		throw new Error(
			`cannot create KV namespace "${kvName}": ${(err.trim() || out.trim()).split("\n").slice(-3).join(" ")}`,
		);
	}
	// wrangler prints the new binding as a config snippet; the id is the only
	// 32-hex token in it. Re-listing instead would race namespace propagation.
	const found = /[0-9a-f]{32}/.exec(out);
	if (!found) throw new Error(`created "${kvName}" but could not find its id in wrangler's output:\n${out}`);
	return found[0];
}

const id = await namespaceId();
let raw = await Bun.file(CONFIG).text();

if (configuredKvId === id) {
	console.log(`KV binding already pinned to "${kvName}" (${id}).`);
	process.exit(0);
}

// Replace the id inside the kv_namespaces block only — the file has other
// id-shaped fields (durable object migrations) that must not be touched.
const block = /("kv_namespaces"\s*:\s*\[[^\]]*?"id"\s*:\s*)"[^"]*"/;
if (!block.test(raw))
	throw new Error('no "kv_namespaces" entry with an "id" field in wrangler.jsonc — refusing to guess');
raw = raw.replace(block, `$1"${id}"`);
await Bun.write(CONFIG, raw);

console.log(`KV binding: id "${configuredKvId}" → "${id}" (namespace "${kvName}", Worker deploys as "${workerName}").`);
