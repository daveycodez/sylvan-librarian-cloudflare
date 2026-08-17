// Retiring the keys a previous LAYOUT version left behind, from the deploy side.
//
// The nightly import does the same thing after it writes a dataset's meta key (see
// ImportCoordinator.pruneOldKeys); this is that sweep for the publisher that runs in the deploy, so
// whichever writer ran last leaves the namespace holding exactly one version.
//
// After the meta key, never before: the meta key is the commit point, and deleting the old
// namespace first would leave a window in which neither version is complete. Best effort — a key
// that will not delete costs a few KB of a 1GB namespace and gets another chance next publish.

import { staleKeys } from "../src/engine/kv-versions";
import { MANIFEST_KEY, staleStoreKeys } from "../src/engine/store-kv";
import { kvTargetArgs } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

/**
 * The built_at of the build the LIVE manifest points at, so a sweep cannot
 * retire the family the serving path is reading right now — age alone is not
 * the whole rule.
 *
 * A list rather than a single value because callers concatenate it with the
 * build they just published; both go to `protect`.
 *
 * Best effort: a pointer that is absent or unreadable protects nothing (there
 * is nothing being served through it to protect).
 */
export async function liveManifestBuiltAts(remote: boolean): Promise<string[]> {
	const proc = Bun.spawn([...wranglerArgv(), "kv", "key", "get", MANIFEST_KEY, ...(await kvTargetArgs(remote))], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) return [];
	try {
		const at = String((JSON.parse(out.slice(out.indexOf("{"))) as { built_at?: unknown }).built_at ?? "");
		return at ? [at] : [];
	} catch {
		// Unparseable manifest: nothing to protect through it.
		return [];
	}
}

/** Delete every key under `prefix` that the current layout does not own. */
export async function pruneOldKeys(prefix: string, currentPrefix: string, remote: boolean): Promise<number> {
	const target = await kvTargetArgs(remote);
	const listing = Bun.spawn([...wranglerArgv(), "kv", "key", "list", "--prefix", prefix, ...target], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(listing.stdout).text();
	if ((await listing.exited) !== 0) {
		console.warn(`Retention: could not list keys under ${prefix}; leaving them.`);
		return 0;
	}
	let names: string[];
	try {
		names = (JSON.parse(out.slice(out.indexOf("["))) as { name: string }[]).map((k) => k.name);
	} catch {
		console.warn(`Retention: could not read the key list under ${prefix}; leaving them.`);
		return 0;
	}

	const stale = staleKeys(names, prefix, currentPrefix);
	if (stale.length === 0) return 0;

	// `kv bulk delete` takes a JSON array of key names, which is one wrangler start-up rather than
	// one per key.
	const file = `${require("node:os").tmpdir()}/sylvan-prune-${prefix.replaceAll(":", "-")}.json`;
	await Bun.write(file, JSON.stringify(stale));
	const proc = Bun.spawn([...wranglerArgv(), "kv", "bulk", "delete", file, "--force", ...target], {
		stdout: "ignore",
		stderr: "inherit",
	});
	if ((await proc.exited) !== 0) {
		console.warn(`Retention: could not delete ${stale.length} stale key(s) under ${prefix}; leaving them.`);
		return 0;
	}
	return stale.length;
}

/**
 * Delete every store build but the newest `keep`, plus every build in `protect`
 * — the one just published and the one the live manifest references (see
 * liveManifestBuiltAts).
 *
 * The deploy's counterpart to ImportCoordinator.pruneOldStores. Retention used to be driven by a
 * history list the coordinator wiped every run, so nothing was ever deleted; deriving it from the
 * keys themselves is what heals a namespace that already leaked.
 */
export async function pruneOldStores(
	keep: number,
	protect: string | readonly string[] | undefined,
	remote: boolean,
): Promise<number> {
	const target = await kvTargetArgs(remote);
	const listing = Bun.spawn([...wranglerArgv(), "kv", "key", "list", "--prefix", "store:card-", ...target], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(listing.stdout).text();
	if ((await listing.exited) !== 0) {
		console.warn("Retention: could not list store keys; leaving them.");
		return 0;
	}
	let names: string[];
	try {
		names = (JSON.parse(out.slice(out.indexOf("["))) as { name: string }[]).map((k) => k.name);
	} catch {
		console.warn("Retention: could not read the store key list; leaving them.");
		return 0;
	}

	const stale = staleStoreKeys(names, keep, protect);
	if (stale.length === 0) return 0;
	const file = `${require("node:os").tmpdir()}/sylvan-prune-stores.json`;
	await Bun.write(file, JSON.stringify(stale));
	const proc = Bun.spawn([...wranglerArgv(), "kv", "bulk", "delete", file, "--force", ...target], {
		stdout: "ignore",
		stderr: "inherit",
	});
	if ((await proc.exited) !== 0) {
		console.warn(`Retention: could not delete ${stale.length} superseded store chunk(s); leaving them.`);
		return 0;
	}
	return stale.length;
}
