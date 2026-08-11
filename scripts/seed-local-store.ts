// Seed a natively-built store into LOCAL simulated KV — the store as ~20MB
// chunks plus a manifest, exactly what the ImportCoordinator publishes — so
// `bun dev` serves a fully working site without waiting on the in-DO import.
//
//   bun scripts/seed-local-store.ts <store-build-dir>
//
// The store file, manifest.json, and rows.jsonl come from
// `sylvan-store-builder --out`.

import { readFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkKey, MANIFEST_KEY, STORE_CONTENT_GENERATION, splitStore } from "../src/engine/store-kv";
import { wranglerArgv } from "./wrangler-cmd";

/** Write one key into miniflare's local KV for the STORE_KV binding. */
async function localKvPut(key: string, path: string): Promise<void> {
	const proc = Bun.spawn(
		[
			...wranglerArgv(),
			"kv",
			"key",
			"put",
			key,
			"--path",
			path,
			"--binding",
			"STORE_KV",
			"--local",
			"-c",
			"wrangler.dev.jsonc",
		],
		{ stdout: "ignore", stderr: "inherit" },
	);
	if ((await proc.exited) !== 0) throw new Error(`local kv put failed for ${key}`);
}

const dir = process.argv[2];
if (!dir) {
	console.error("usage: bun scripts/seed-local-store.ts <store-build-dir>");
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
// The paired card-object archive (see CompatData in card_engine). Seeded too, or /cards/* is the
// one surface that works in production and 503s in dev.
const compat = new Uint8Array(readFileSync(`${dir}/${manifest.compat_key}`));
if (compat.length !== manifest.compat_bytes) {
	throw new Error(`card-object archive is ${compat.length} bytes, manifest says ${manifest.compat_bytes}`);
}

// The same ~20MB KV grid production publishes on. Local dev deliberately gets
// the REAL format, not a simpler one: the chunked read path would otherwise
// never run outside production, and "works locally" would say nothing about
// the path that actually serves.
const chunkBytes = splitStore(store);
const compatChunks = splitStore(compat);
(manifest as Record<string, unknown>).chunk_count = chunkBytes.length;
(manifest as Record<string, unknown>).compat_chunk_count = compatChunks.length;
(manifest as Record<string, unknown>).chunks = undefined;
// See the note in seed-remote-kv.ts: the generation is stamped by whoever
// publishes, from the one shared constant.
(manifest as Record<string, unknown>).content_generation = STORE_CONTENT_GENERATION;

// ── store: chunks → manifest into local KV (manifest last = commit point) ───
// Miniflare keeps KV as a SQLite-backed blob store; `wrangler kv key put
// --local` is the supported way in, and at four values it is fast enough that
// the direct-file trick the cards table needs is not worth its fragility.
for (const [key, pieces] of [
	[manifest.store_key, chunkBytes],
	[manifest.compat_key, compatChunks],
] as const) {
	for (let seq = 0; seq < pieces.length; seq++) {
		const bytes = pieces[seq] as Uint8Array;
		const tmp = join(tmpdir(), `sylvan-local-chunk-${seq}.bin`);
		await writeFile(tmp, bytes);
		try {
			await localKvPut(chunkKey(key, seq), tmp);
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}
}
const manifestTmp = join(tmpdir(), "sylvan-local-manifest.json");
await writeFile(manifestTmp, JSON.stringify(manifest));
try {
	await localKvPut(MANIFEST_KEY, manifestTmp);
} finally {
	await unlink(manifestTmp).catch(() => {});
}
console.log(
	`Store seeded into local KV: ${manifest.store_key} (${chunkBytes.length} chunks) ` +
		`+ ${manifest.compat_key} (${compatChunks.length} chunks).`,
);
