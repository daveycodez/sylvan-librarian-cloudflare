// Seed a natively-built PARTITIONED store into LOCAL simulated KV — each
// partition's archive as gzipped chunks plus the manifest, exactly what the
// ImportCoordinator publishes — so `bun dev` serves a fully working site
// without waiting on the in-DO import.
//
//   bun scripts/seed-local-store.ts <store-build-dir>
//
// The build dir comes from `sylvan-store-builder --out DIR --partitions auto`
// (see seed-local.sh): a manifest skeleton plus the N archive files. An
// unpartitioned build dir is refused for the same reason seed-remote-kv.ts
// refuses one — the reader cannot load it, and dev must exercise the shape
// production serves.

import { readFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	chunkForKv,
	chunkKey,
	MANIFEST_KEY,
	manifestShapeProblem,
	PARTITION_HASH_ALGO,
	routingFilterKey,
	STORE_CONTENT_GENERATION,
} from "../src/engine/store-kv";
import type { StoreManifest, StoreManifestPartition } from "../src/engine/types";
import { ROUTING_KEYS_FILE, routingFilterFromBuildDir } from "./routing-filter-build";
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

const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as StoreManifest & {
	chunks?: unknown;
	[k: string]: unknown;
};
if (!Number.isInteger(manifest.partition_count) || !Array.isArray(manifest.partitions)) {
	console.error(
		`${dir}/manifest.json is an UNPARTITIONED build — refusing to seed it. ` +
			`Generation ${STORE_CONTENT_GENERATION} readers load only partitioned stores; ` +
			`rebuild with \`sylvan-store-builder --out ${dir} --partitions auto\`.`,
	);
	process.exit(2);
}
const partitions = manifest.partitions as StoreManifestPartition[];

// The same KV grid production publishes on: each partition's archive cut on
// RAW bytes, each cut gzipped as its own member. Local dev deliberately gets
// the REAL format, not a simpler one — the chunked, per-chunk-decompressing,
// per-partition read path would otherwise never run outside production, and
// "works locally" would say nothing about the path that actually serves.
const gzip = (c: Uint8Array) => gzipSync(c, { level: 9 });
const chunksByPartition: Uint8Array[][] = [];
for (const partition of partitions) {
	const archive = new Uint8Array(readFileSync(`${dir}/${partition.store_key}`));
	if (archive.length !== partition.store_bytes) {
		throw new Error(`${partition.store_key} is ${archive.length} bytes, manifest says ${partition.store_bytes}`);
	}
	const chunks = chunkForKv(archive, gzip).chunks;
	partition.chunk_count = chunks.length;
	// Present iff compressed — the flag the reader keys off (see StoreManifest).
	partition.store_gzip_bytes = chunks.reduce((n, c) => n + c.length, 0);
	chunksByPartition.push(chunks);
}

// Totals from the records just filled, then the shared stamps — the same
// discipline as seed-remote-kv.ts, see the notes there.
manifest.store_bytes = partitions.reduce((n, p) => n + p.store_bytes, 0);
manifest.store_gzip_bytes = partitions.reduce((n, p) => n + (p.store_gzip_bytes ?? 0), 0);
manifest.chunk_count = partitions.reduce((n, p) => n + p.chunk_count, 0);
manifest.card_count = partitions.reduce((n, p) => n + p.card_count, 0);
manifest.printing_count = partitions.reduce((n, p) => n + p.printing_count, 0);
manifest.content_generation = STORE_CONTENT_GENERATION;
manifest.partition_hash ??= PARTITION_HASH_ALGO;
manifest.chunks = undefined;
const problem = manifestShapeProblem(manifest);
if (problem) {
	console.error(`refusing to seed the manifest: ${problem}`);
	process.exit(2);
}

// ── store: every partition's chunks → manifest (manifest last = commit point) ─
// Miniflare keeps KV as a SQLite-backed blob store; `wrangler kv key put
// --local` is the supported way in, and at ~20 values it is fast enough that
// the direct-file trick the cards table needed is not worth its fragility.
for (let k = 0; k < partitions.length; k++) {
	const partition = partitions[k] as StoreManifestPartition;
	const pieces = chunksByPartition[k] as Uint8Array[];
	for (let seq = 0; seq < pieces.length; seq++) {
		const bytes = pieces[seq] as Uint8Array;
		const tmp = join(tmpdir(), `sylvan-local-chunk-p${k}-${seq}.bin`);
		await writeFile(tmp, bytes);
		try {
			await localKvPut(chunkKey(partition.store_key, seq), tmp);
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}
}
// The routing filter, before the manifest and after the chunks — one more key of
// this build's family, so a generation whose publish never completes leaves a
// filter nothing names and retention sweeps with the rest (routingFilterKey).
const routing = routingFilterFromBuildDir(dir, manifest);
if (routing) {
	const routingTmp = join(tmpdir(), "sylvan-local-routing.bin");
	await writeFile(routingTmp, routing.bytes);
	try {
		await localKvPut(routingFilterKey(manifest.format_version, String(manifest.built_at)), routingTmp);
	} finally {
		await unlink(routingTmp).catch(() => {});
	}
	console.log(
		`Routing filter seeded: ${routing.keys} ids, ${(routing.bytes.byteLength / 1024).toFixed(0)}KB ` +
			`(bare-id routes ask ONE partition instead of ${manifest.partition_count}).`,
	);
} else {
	console.warn(`No ${ROUTING_KEYS_FILE} in ${dir}: bare-id routes will fan out across every partition.`);
}
// The manifest LAST, at the one key, exactly as seed-remote-kv.ts publishes it:
// dev reads through the identical loader, so seeding anywhere else would test a
// path production does not have.
const manifestTmp = join(tmpdir(), "sylvan-local-manifest.json");
await writeFile(manifestTmp, JSON.stringify(manifest));
try {
	await localKvPut(MANIFEST_KEY, manifestTmp);
} finally {
	await unlink(manifestTmp).catch(() => {});
}
console.log(
	`Store seeded into local KV: ${manifest.store_key} ` +
		`(${manifest.partition_count} partitions, ${manifest.chunk_count} chunks).`,
);
