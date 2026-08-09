// Resolve the Worker name the way wrangler itself resolves it, and derive the
// D1 database name from it, so a fork needs ZERO edits — including two Workers
// on one account, each with its own database.
//
// Workers Builds injects WRANGLER_CI_OVERRIDE_NAME with the name of the
// connected Worker and wrangler prefers it over the config file's `name`
// (wrangler-dist/cli.js, mergeSharedConfigArgs: "Failed to match Worker
// name... Overriding using the CI provided Worker name"). It is undocumented,
// so this mirrors the binary rather than the docs.
//
//   import { workerName, d1Name } from "./project-config";
//   bun scripts/project-config.ts worker | d1 | configured-d1

const CONFIG = new URL("../wrangler.jsonc", import.meta.url).pathname;

/** Strip // and block comments that are not inside a double-quoted string. */
function stripJsonc(src: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i] as string;
		if (inString) {
			out += c;
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i++;
			continue;
		}
		out += c;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

interface WranglerConfig {
	name?: string;
	d1_databases?: { binding?: string; database_name?: string }[];
}

const raw = await Bun.file(CONFIG).text();
const parsed = JSON.parse(stripJsonc(raw)) as WranglerConfig;

const configuredName = parsed.name ?? "";
/** What wrangler will actually deploy as: the CI override wins. */
export const workerName = process.env.WRANGLER_CI_OVERRIDE_NAME || configuredName;
/** The D1 database this Worker owns. Derived from the Worker name so a second
 * Worker on the same account gets a separate database with no config edits. */
export const d1Name = workerName;
/** What the config file currently binds — may lag behind d1Name in CI. */
export const configuredD1Name = parsed.d1_databases?.[0]?.database_name ?? "";

if (!workerName) throw new Error("cannot resolve a Worker name from wrangler.jsonc or WRANGLER_CI_OVERRIDE_NAME");

if (import.meta.main) {
	const which = process.argv[2];
	if (which === "worker") console.log(workerName);
	else if (which === "d1") console.log(d1Name);
	else if (which === "configured-d1") console.log(configuredD1Name);
	else {
		console.error("usage: bun scripts/project-config.ts <worker|d1|configured-d1>");
		process.exit(2);
	}
}
