// Retiring the keys a previous LAYOUT version left behind, from the deploy side.
//
// The nightly import does the same thing after it writes a dataset's meta key (see
// ImportCoordinator.pruneOldKeys); this is that sweep for the publisher that runs in the deploy, so
// whichever writer ran last leaves the namespace holding exactly one version.
//
// After the meta key, never before: the meta key is the commit point, and deleting the old
// namespace first would leave a window in which neither version is complete. Best effort — a key
// that will not delete costs a few KB of a 1GB namespace and gets another chance next publish.

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListedKey } from "../src/engine/kv-retention";
import { staleKeys } from "../src/engine/kv-versions";
import type { DeployKv } from "./deploy-upload";
import { kvTargetArgs } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

/**
 * `wrangler kv key get` as text. `value: null` when the key is ABSENT — wrangler's own wording
 * for a miss, the same test scripts/store-age.ts applies — and `failed` when the read did not
 * answer at all, which callers must not mistake for a miss (deploy-upload.ts skips its sweep on one).
 */
export async function kvGetText(
	key: string,
	remote: boolean,
): Promise<{ value: string | null; failed: string | null }> {
	const proc = Bun.spawn([...wranglerArgv(), "kv", "key", "get", key, ...(await kvTargetArgs(remote))], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) === 0) return { value: out, failed: null };
	const detail = `${err}\n${out}`;
	if (/not found|does not exist|no value/i.test(detail)) return { value: null, failed: null };
	return { value: null, failed: detail.trim().split("\n").slice(-3).join(" ") || `wrangler kv key get ${key} failed` };
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
 * `wrangler kv key list` with each key's metadata — every put this repo makes carries `{b: bytes}`,
 * which is how the byte guard sums the namespace (kv-retention.ts). `prefix` "" lists everything;
 * wrangler walks every page itself. Null when the list FAILED, which no caller may read as "empty".
 *
 * COST: one list operation per 1,000 keys against the free plan's 1,000 a day; the namespace holds
 * ~450 keys, and a deploy lists at most three times (before its first key, after its manifest, and
 * prune-kv.ts's sweep on every deploy).
 */
export async function kvListWithMetadata(prefix: string, remote: boolean): Promise<ListedKey[] | null> {
	const listing = Bun.spawn(
		[...wranglerArgv(), "kv", "key", "list", ...(prefix ? ["--prefix", prefix] : []), ...(await kvTargetArgs(remote))],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(listing.stdout).text();
	if ((await listing.exited) !== 0) return null;
	try {
		return (JSON.parse(out.slice(out.indexOf("["))) as { name: string; metadata?: unknown }[]).map((k) => ({
			name: k.name,
			metadata: k.metadata,
		}));
	} catch {
		return null;
	}
}

/** `wrangler kv bulk delete`: one wrangler start-up for any number of keys. */
export async function kvBulkDelete(keys: readonly string[], remote: boolean): Promise<boolean> {
	if (keys.length === 0) return true;
	const file = join(tmpdir(), `sylvan-kv-delete-${process.pid}-${Date.now()}.json`);
	await writeFile(file, JSON.stringify(keys));
	try {
		const proc = Bun.spawn(
			[...wranglerArgv(), "kv", "bulk", "delete", file, "--force", ...(await kvTargetArgs(remote))],
			{ stdout: "ignore", stderr: "inherit" },
		);
		return (await proc.exited) === 0;
	} finally {
		await unlink(file).catch(() => {});
	}
}

/**
 * The deploy side's KV (scripts/deploy-upload.ts) over wrangler. Small values only: the fence, the
 * lease. A put that fails throws, with wrangler's own words.
 */
export function wranglerDeployKv(remote: boolean): DeployKv {
	return {
		get: (key) => kvGetText(key, remote),
		async put(key, value, opts) {
			const file = join(tmpdir(), `sylvan-kv-put-${process.pid}-${Date.now()}.txt`);
			await writeFile(file, value);
			try {
				const argv = [
					...wranglerArgv(),
					"kv",
					"key",
					"put",
					key,
					"--path",
					file,
					...(opts?.ttlSeconds ? ["--ttl", String(opts.ttlSeconds)] : []),
					...(opts?.metadata !== undefined ? ["--metadata", JSON.stringify(opts.metadata)] : []),
					...(await kvTargetArgs(remote)),
				];
				const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
				const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
				if ((await proc.exited) !== 0) throw new Error(`wrangler kv key put ${key} failed: ${`${err}\n${out}`.trim()}`);
			} finally {
				await unlink(file).catch(() => {});
			}
		},
		list: (prefix) => kvListWithMetadata(prefix, remote),
		deleteKeys: (keys) => kvBulkDelete(keys, remote),
		sleep: (ms) => Bun.sleep(ms),
		now: () => Date.now(),
	};
}
