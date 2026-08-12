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
import { staleStoreKeys } from "../src/engine/store-kv";
import { kvTargetArgs } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

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
 * Delete every store build but the newest `keep`, plus the one just published.
 *
 * The deploy's counterpart to ImportCoordinator.pruneOldStores. Retention used to be driven by a
 * history list the coordinator wiped every run, so nothing was ever deleted; deriving it from the
 * keys themselves is what heals a namespace that already leaked.
 */
export async function pruneOldStores(
	keep: number,
	currentBuiltAt: string | undefined,
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

	const stale = staleStoreKeys(names, keep, currentBuiltAt);
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
