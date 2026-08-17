// Publish a natively-built PARTITIONED store to PRODUCTION KV, so a deploy is
// live with a current index instead of waiting for the in-Worker nightly to
// build one.
//
//   bun scripts/seed-remote-kv.ts <store-build-dir>
//
// The build dir comes from `sylvan-store-builder --out DIR --partitions auto`:
// a manifest skeleton (partition_count + partitions[], each record naming its
// own archive file) plus the N archive files. The publish is
// `sum(chunk_count) + 1` writes: every partition's gzipped chunks in partition
// order, then the manifest at `store:manifest`. The manifest goes LAST and is
// the commit point — until it lands, readers keep serving whatever was
// published before, so a failure at any point leaves the deployment in a valid
// state rather than a half-swapped one.
//
// AN UNPARTITIONED BUILD DIR IS REFUSED, loudly. This deployment serves only
// partitioned stores; publishing a single archive here would land a manifest
// the deployed readers cannot load — a dark site with a green build log, which
// is the exact failure the loud path exists to prevent. (import-store.sh
// already fails earlier, at the builder's own argv parsing, if the builder
// predates `--partitions`; this is the second line of defense.)
//
// There is no incremental path and no dedup, deliberately. The predecessor of
// this script uploaded only the 40,000-byte chunks D1 did not already hold,
// with content hashes and reuse accounting, because ~1,800 row writes per
// store had to fit a 100k/day quota. ~20 KV writes against a 1,000/day
// allowance make all of that machinery pure cost.

import { readFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	chunkForKv,
	chunkKey,
	KEEP_STORES_IN_KV,
	MANIFEST_KEY,
	manifestShapeProblem,
	PARTITION_HASH_ALGO,
	routingFilterKey,
	STORE_CONTENT_GENERATION,
} from "../src/engine/store-kv";
import type { StoreManifest, StoreManifestPartition } from "../src/engine/types";
import { liveManifestBuiltAts, pruneOldStores } from "./kv-prune";
import { requireDeployEnvironment } from "./kv-target";
import { kvName } from "./project-config";
import { ROUTING_KEYS_FILE, routingFilterFromBuildDir } from "./routing-filter-build";
import { wranglerArgv } from "./wrangler-cmd";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!dir) {
	console.error("usage: bun scripts/seed-remote-kv.ts <store-build-dir>");
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as StoreManifest & {
	chunks?: unknown;
	[k: string]: unknown;
};
if (!Number.isInteger(manifest.partition_count) || !Array.isArray(manifest.partitions)) {
	console.error(
		`${dir}/manifest.json is an UNPARTITIONED build — refusing to publish it. ` +
			`Generation ${STORE_CONTENT_GENERATION} readers load only partitioned stores; ` +
			`rebuild with \`sylvan-store-builder --out ${dir} --partitions auto\`.`,
	);
	process.exit(2);
}
const partitions = manifest.partitions as StoreManifestPartition[];

// Cut each partition's archive on RAW bytes, then gzip each cut as its own
// member — the format the reader expects and the ImportCoordinator also
// publishes. Level 9 here because this runs in the deploy with a real CPU and
// no alarm budget, where the Worker gets whatever CompressionStream gives it
// (~level 1); gzip is gzip, so the two load through the identical path and
// only the stored size differs.
const gzip = (c: Uint8Array) => gzipSync(c, { level: 9 });
const chunksByPartition: Uint8Array[][] = [];
for (const partition of partitions) {
	const archive = new Uint8Array(readFileSync(`${dir}/${partition.store_key}`));
	if (archive.length !== partition.store_bytes) {
		throw new Error(`${partition.store_key} is ${archive.length} bytes, manifest says ${partition.store_bytes}`);
	}
	const { chunks, cut } = chunkForKv(archive, gzip);
	console.log(`  ${partition.store_key}: cut at ${cut} raw bytes -> ${chunks.length} chunk(s)`);
	partition.chunk_count = chunks.length;
	// Present iff compressed: this is the flag the reader keys off, not a hint.
	partition.store_gzip_bytes = chunks.reduce((n, c) => n + c.length, 0);
	chunksByPartition.push(chunks);
}

// Totals recomputed FROM the records just filled, never trusted from the
// skeleton: the manifest is validated against its own sums before it is
// written, and a skeleton total that disagreed with the real files would
// otherwise publish the lie.
manifest.store_bytes = partitions.reduce((n, p) => n + p.store_bytes, 0);
manifest.store_gzip_bytes = partitions.reduce((n, p) => n + (p.store_gzip_bytes ?? 0), 0);
manifest.chunk_count = partitions.reduce((n, p) => n + p.chunk_count, 0);
manifest.card_count = partitions.reduce((n, p) => n + p.card_count, 0);
manifest.printing_count = partitions.reduce((n, p) => n + p.printing_count, 0);
// Stamped at publish time, not by the Rust builder: the generation describes
// what this checkout's builder puts in a store, and one TS constant shared by
// every publisher (here, the seed scripts, and the ImportCoordinator) cannot
// drift the way a copy in Rust would. Without it store-age reads a natively
// seeded store as generation 0 and demands a rebuild forever.
manifest.content_generation = STORE_CONTENT_GENERATION;
// The hash NAME must match the one implementation everything routes by; the
// builder stamps it, but an older skeleton without it must not publish as
// "unspecified" — loaders refuse a manifest whose hash they do not recognise,
// and absent is unrecognisable.
manifest.partition_hash ??= PARTITION_HASH_ALGO;
// Content hashes were a D1-era field; nothing reads them now, and leaving a
// stale one in the manifest would be a lie about how the store is addressed.
manifest.chunks = undefined;

// The same refusal writeManifest gives the coordinator: the manifest is the
// commit point, so a malformed one is a served outage, not a build failure.
const problem = manifestShapeProblem(manifest);
if (problem) {
	console.error(`refusing to publish the manifest: ${problem}`);
	process.exit(2);
}

// The store is production data like any other: written by the deploy and by the nightly cron, and
// by nothing else. See requireDeployEnvironment.
requireDeployEnvironment();

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

// Every partition's chunks first: writing them before the manifest is what
// makes the manifest a commit point. `--path` because a 20MB value cannot ride
// an argv string.
for (let k = 0; k < partitions.length; k++) {
	const partition = partitions[k] as StoreManifestPartition;
	const pieces = chunksByPartition[k] as Uint8Array[];
	for (let seq = 0; seq < pieces.length; seq++) {
		const bytes = pieces[seq] as Uint8Array;
		const tmp = join(tmpdir(), `sylvan-store-chunk-p${k}-${seq}.bin`);
		await writeFile(tmp, bytes);
		try {
			await kv(["key", "put", chunkKey(partition.store_key, seq), "--path", tmp, "--remote"]);
			console.log(
				`  partition ${k + 1}/${partitions.length} chunk ${seq + 1}/${pieces.length} ` +
					`(${(bytes.length / 1048576).toFixed(1)}MB) uploaded`,
			);
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
	const routingPath = join(tmpdir(), "sylvan-store-routing.bin");
	await writeFile(routingPath, routing.bytes);
	try {
		await kv([
			"key",
			"put",
			routingFilterKey(manifest.format_version, String(manifest.built_at)),
			"--path",
			routingPath,
			"--remote",
		]);
		console.log(
			`  routing filter uploaded: ${routing.keys} ids, ${(routing.bytes.byteLength / 1024).toFixed(0)}KB ` +
				`(bare-id routes ask ONE partition instead of ${manifest.partition_count})`,
		);
	} finally {
		await unlink(routingPath).catch(() => {});
	}
} else {
	console.warn(`No ${ROUTING_KEYS_FILE} in ${dir}: bare-id routes will fan out across every partition.`);
}

// The commit point.
const manifestPath = join(tmpdir(), "sylvan-store-manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest));
try {
	await kv(["key", "put", MANIFEST_KEY, "--path", manifestPath, "--remote"]);

	// AFTER the manifest, which is the commit point: the newest build is live, so every build older
	// than the retention policy is now unreachable. A partitioned build's N chunk families share one
	// built_at and retire together (see staleStoreKeys). The build just published is protected
	// explicitly, and so is the family the live manifest references. Retention used to be driven by
	// a history list the importer wiped every run, so nothing was ever deleted — see
	// scripts/kv-prune.ts.
	const protect = [String(manifest.built_at ?? ""), ...(await liveManifestBuiltAts(true))];
	const prunedChunks = await pruneOldStores(KEEP_STORES_IN_KV, protect, true);
	if (prunedChunks > 0) console.log(`Retention: dropped ${prunedChunks} chunk(s) from superseded store builds.`);
} finally {
	await unlink(manifestPath).catch(() => {});
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
console.log(
	`Store published to KV "${kvName}": ${manifest.store_key} ` +
		`(${manifest.partition_count} partitions, ${mb(manifest.store_bytes)} raw -> ` +
		`${mb(manifest.store_gzip_bytes as number)} gzip, ${manifest.chunk_count} chunks).`,
);
