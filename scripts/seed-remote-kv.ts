// Publish a natively-built store to PRODUCTION KV, so a deploy is live with a
// current index instead of waiting for the in-Worker nightly to build one.
//
//   bun scripts/seed-remote-kv.ts <store-build-dir>
//
// The whole publish is `chunk_count + 1` writes: ~4 chunks of ~20MB, then the
// manifest. The manifest goes LAST and is the commit point — until it lands,
// readers keep serving whatever was published before, so a failure at any
// point leaves the deployment in a valid state rather than a half-swapped one.
//
// There is no incremental path and no dedup, deliberately. The predecessor of
// this script uploaded only the 40,000-byte chunks D1 did not already hold,
// with content hashes and reuse accounting, because ~1,800 row writes per
// store had to fit a 100k/day quota. Four KV writes against a 1,000/day
// allowance make all of that machinery pure cost.

import { readFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkCountFor, chunkKey, MANIFEST_KEY, STORE_CONTENT_GENERATION, splitStore } from "../src/engine/store-kv";
import { kvName } from "./project-config";
import { wranglerArgv } from "./wrangler-cmd";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!dir) {
	console.error("usage: bun scripts/seed-remote-kv.ts <store-build-dir>");
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as {
	store_key: string;
	store_bytes: number;
	compat_key: string;
	compat_bytes: number;
	[k: string]: unknown;
};
const store = new Uint8Array(readFileSync(`${dir}/${manifest.store_key}`));
if (store.length !== manifest.store_bytes) {
	throw new Error(`store file is ${store.length} bytes, manifest says ${manifest.store_bytes}`);
}
// The paired card-object archive (see CompatData in card_engine): the fields /search never reads,
// kept out of the store so it stays at three chunks. Published alongside, never separately -- the
// two share an index space and are meaningless apart.
const compat = new Uint8Array(readFileSync(`${dir}/${manifest.compat_key}`));
if (compat.length !== manifest.compat_bytes) {
	throw new Error(`card-object archive is ${compat.length} bytes, manifest says ${manifest.compat_bytes}`);
}

const chunks = splitStore(store);
const compatChunks = splitStore(compat);
manifest.chunk_count = chunks.length;
manifest.compat_chunk_count = compatChunks.length;
// Stamped at publish time, not by the Rust builder: the generation describes
// what this checkout's builder puts in a store, and one TS constant shared by
// every publisher (here, the seed scripts, and the ImportCoordinator) cannot
// drift the way a copy in Rust would. Without it store-age reads a natively
// seeded store as generation 0 and demands a rebuild forever.
manifest.content_generation = STORE_CONTENT_GENERATION;
// Content hashes were a D1-era field; nothing reads them now, and leaving a
// stale one in the manifest would be a lie about how the store is addressed.
manifest.chunks = undefined;

/** Run a wrangler KV command, failing loudly with its own message. */
async function kv(args: string[]): Promise<void> {
	const proc = Bun.spawn([...wranglerArgv(), "kv", ...args, "--namespace-id", await namespaceId()], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((await proc.exited) !== 0) {
		throw new Error(`wrangler kv ${args[0]} failed: ${(err.trim() || out.trim()).split("\n").slice(-4).join(" ")}`);
	}
}

let cachedId: string | null = null;
/** The namespace align-kv-binding.ts created/pinned for this Worker. */
async function namespaceId(): Promise<string> {
	if (cachedId) return cachedId;
	const proc = Bun.spawn([...wranglerArgv(), "kv", "namespace", "list"], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) throw new Error(`cannot list KV namespaces: ${out}`);
	const all = JSON.parse(out.slice(out.indexOf("["))) as { id?: string; title?: string }[];
	const found = all.find((n) => n.title === kvName)?.id;
	if (!found) throw new Error(`no KV namespace named "${kvName}" — run scripts/align-kv-binding.ts first`);
	cachedId = found;
	return found;
}

// Chunks first: writing them before the manifest is what makes the manifest a
// commit point. `--path` because a 20MB value cannot ride an argv string.
for (const [label, key, pieces] of [
	["chunk", manifest.store_key, chunks],
	["card-object chunk", manifest.compat_key, compatChunks],
] as const) {
	for (let seq = 0; seq < pieces.length; seq++) {
		const bytes = pieces[seq] as Uint8Array;
		const tmp = join(tmpdir(), `sylvan-store-chunk-${seq}.bin`);
		await writeFile(tmp, bytes);
		try {
			await kv(["key", "put", chunkKey(key, seq), "--path", tmp, "--remote"]);
			console.log(`  ${label} ${seq + 1}/${pieces.length} (${(bytes.length / 1048576).toFixed(1)}MB) uploaded`);
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}
}

// The commit point.
const manifestPath = join(tmpdir(), "sylvan-store-manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest));
try {
	await kv(["key", "put", MANIFEST_KEY, "--path", manifestPath, "--remote"]);
} finally {
	await unlink(manifestPath).catch(() => {});
}

console.log(
	`Store published to KV "${kvName}": ${manifest.store_key} ` +
		`(${(store.length / 1048576).toFixed(1)}MB, ${chunks.length} chunks, expected ${chunkCountFor(store.length)}) ` +
		`+ ${manifest.compat_key} (${(compat.length / 1048576).toFixed(1)}MB, ${compatChunks.length} chunks).`,
);
