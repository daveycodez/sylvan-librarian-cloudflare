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
// order, then the manifest at `store:manifest:v<format>` (and the legacy
// `store:manifest` mirror when it holds the same format — one more write). The
// manifest goes LAST and is the commit point — until it lands, readers keep
// serving whatever was published before, so a failure at any point leaves the
// deployment in a valid state rather than a half-swapped one.
//
// A FORMAT BUMP PUBLISHES BESIDE THE RUNNING BUILD, NOT OVER IT (backlog x19). This script runs in
// Workers Builds' install step, minutes before `wrangler deploy` switches the code. The Worker still
// serving reads its own format's manifest, which this publish does not touch — nor the legacy
// mirror, which holds that same older format — so it keeps answering from its store until the
// switch, and the new code starts on the manifest written here. That window used to be dark
// (generations 45, 48, 53). The old format's family retires at the next publish by the new code.
//
// AN UNPARTITIONED BUILD DIR IS REFUSED, loudly. This deployment serves only
// partitioned stores; publishing a single archive here would land a manifest
// the deployed readers cannot load — a dark site with a green build log, which
// is the exact failure the loud path exists to prevent. (import-store.sh
// already fails earlier, at the builder's own argv parsing, if the builder
// predates `--partitions`; this is the second line of defense.)
//
// RETENTION BY ROLE AND THE DEPLOY'S LEASE (backlog x3, scripts/deploy-upload.ts): before the first
// chunk the deploy takes the upload lease from whoever holds it (the deploy wins; import-store.sh's
// fence has already told every nightly run that began earlier to retire), deletes every generation
// that is not the live one or the one it replaced, and asks the byte guard whether this build's
// family — its EXACT size, cut and compressed above — fits under the free plan's 1 GB. After the
// manifest it releases the lease and sweeps with the new roles. KV never holds a fourth generation.
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
import { cardNamesKey } from "../src/engine/card-names";
import { kvBytesMetadata, replacedManifest, withPreviousBuiltAt } from "../src/engine/kv-retention";
import { printedNamesKey } from "../src/engine/printed-names";
import {
	ARCHIVE_FORMAT_VERSION,
	CARRIED_MANIFEST_BLOCKS,
	carryManifestBlocks,
	chunkForKv,
	chunkKey,
	manifestKeysToWrite,
	manifestShapeProblem,
	PARTITION_HASH_ALGO,
	routingFilterKey,
	STORE_CONTENT_GENERATION,
} from "../src/engine/store-kv";
import { tagAliasesKey } from "../src/engine/tag-aliases";
import type { StoreManifest, StoreManifestPartition } from "../src/engine/types";
import { CARD_NAMES_FILE, cardNamesFromBuildDir } from "./card-names-build";
import { beginDeployUpload, deployStillHoldsLease, finishDeployUpload, readPublishedManifests } from "./deploy-upload";
import { wranglerDeployKv } from "./kv-prune";
import { requireDeployEnvironment } from "./kv-target";
import { PRINTED_NAMES_FILE, printedNamesFromBuildDir } from "./printed-names-build";
import { kvName } from "./project-config";
import { ROUTING_KEYS_FILE, routingFilterFromBuildDir } from "./routing-filter-build";
import { TAG_ALIASES_FILE, tagAliasesFileFromBuildDir } from "./tag-aliases-build";
import { wranglerArgv, wranglerFailure } from "./wrangler-cmd";

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
// The manifest's KEY is its format (x19), and the Worker this deploy ships reads exactly one:
// ARCHIVE_FORMAT_VERSION, from the committed engine provenance. A builder of another format would
// publish a store under a key the new code never reads — dark from `wrangler deploy` on, with a green
// build. The freshness test keeps the two equal in CI; this is the deploy's own line.
if (manifest.format_version !== ARCHIVE_FORMAT_VERSION) {
	console.error(
		`refusing to publish: the builder wrote archive format ${manifest.format_version}, but the Worker this ` +
			`deploy ships reads format ${ARCHIVE_FORMAT_VERSION} (engine/wasm-provenance.json). Rebuild the blobs ` +
			"(`bun run build`) or the builder so the two agree.",
	);
	process.exit(2);
}

// The store is production data like any other: written by the deploy and by the nightly cron, and
// by nothing else. See requireDeployEnvironment.
requireDeployEnvironment();

/** Attempts a KV write gets, and the waits between them: a put is idempotent (same key, same bytes). */
const KV_ATTEMPTS = 4;
const KV_BACKOFF_MS = [5_000, 15_000, 30_000];

/**
 * Run a wrangler KV command, retrying a failed one and failing loudly with its own message.
 *
 * RETRIED because a chunk put fails now and then with nothing wrong on our side: on 2026-09-25 the
 * DeckGen deploy lost a 13–14MB put after 3 good ones and, 30 minutes later, after 4; the free
 * account's lost its first put the same minute as DeckGen's first failure, and its next deploy
 * uploaded all ten. Every command here is a put of a fixed key and value, so asking again is safe.
 */
async function kv(args: string[]): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		const proc = Bun.spawn([...wranglerArgv(), "kv", ...args, "--namespace-id", await namespaceId()], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		const err = await new Response(proc.stderr).text();
		if ((await proc.exited) === 0) return;
		const why = wranglerFailure(`${out}\n${err}`);
		if (attempt >= KV_ATTEMPTS) {
			throw new Error(`wrangler kv ${args.slice(0, 3).join(" ")} failed ${attempt} times: ${why}`);
		}
		const wait = KV_BACKOFF_MS[attempt - 1] ?? 30_000;
		console.warn(
			`  wrangler kv ${args.slice(0, 3).join(" ")} failed (attempt ${attempt}/${KV_ATTEMPTS}), retrying in ${wait / 1000}s: ${why}`,
		);
		await Bun.sleep(wait);
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

// The family's other keys, read now so the byte guard can count them with the chunks.
const routing = routingFilterFromBuildDir(dir, manifest);
// REQUIRED where the filter is optional: a build without it answers every alias tag spelling with
// nothing (see src/engine/tag-aliases.ts). The builder writes it beside every store, so absent means
// a build dir this script should not publish.
const aliasesPath = tagAliasesFileFromBuildDir(dir);
const aliasesBytes = readFileSync(aliasesPath).byteLength;
const cardNames = cardNamesFromBuildDir(dir);
const cardNamesStored = cardNames ? gzip(cardNames.raw) : null;
const printedNames = printedNamesFromBuildDir(dir);
const printedNamesStored = printedNames ? gzip(printedNames.raw) : null;
const builtAt = String(manifest.built_at);
const incomingBytes =
	chunksByPartition.reduce((n, pieces) => n + pieces.reduce((m, c) => m + c.length, 0), 0) +
	(routing?.bytes.byteLength ?? 0) +
	aliasesBytes +
	(cardNamesStored?.byteLength ?? 0) +
	(printedNamesStored?.byteLength ?? 0);

// Before the family's FIRST key: the fence, the lease, the sweep by role and the byte guard.
const deployKv = wranglerDeployKv(true);
const begun = await beginDeployUpload(deployKv, { builtAt, incomingBytes });
if (!begun.ok) {
	console.error(`refusing to publish: ${begun.why}`);
	process.exit(1);
}

/** `--metadata` for a put of `bytes`: every value carries its size, which the byte guard sums. */
const sized = (bytes: number) => ["--metadata", JSON.stringify(kvBytesMetadata(bytes))];

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
			await kv(["key", "put", chunkKey(partition.store_key, seq), "--path", tmp, ...sized(bytes.length), "--remote"]);
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
			...sized(routing.bytes.byteLength),
			"--remote",
		]);
		console.log(
			`  routing filter uploaded: ${routing.keys} keys (${routing.nameKeys} names), ${(routing.bytes.byteLength / 1024).toFixed(0)}KB ` +
				`(bare-id routes ask ONE partition instead of ${manifest.partition_count})`,
		);
	} finally {
		await unlink(routingPath).catch(() => {});
	}
} else {
	console.warn(`No ${ROUTING_KEYS_FILE} in ${dir}: bare-id routes will fan out across every partition.`);
}

// The tag alias map, before the manifest for the same reason as the routing filter.
await kv([
	"key",
	"put",
	tagAliasesKey(manifest.format_version, String(manifest.built_at)),
	"--path",
	aliasesPath,
	...sized(aliasesBytes),
	"--remote",
]);
console.log(`  tag aliases uploaded from ${TAG_ALIASES_FILE}`);

// n8: the card-names blob, before the manifest that names it — one more key of this build's family
// (cardNamesKey, store:card-names-…), so retention keeps and retires it with the archives it
// describes. Optional like the routing filter: without it /cards/autocomplete fans out, as before n8.
if (cardNamesStored) {
	const namesKey = cardNamesKey(manifest.format_version, String(manifest.built_at));
	const namesPath = join(tmpdir(), "sylvan-store-card-names.bin");
	await writeFile(namesPath, cardNamesStored);
	try {
		await kv(["key", "put", namesKey, "--path", namesPath, ...sized(cardNamesStored.byteLength), "--remote"]);
	} finally {
		await unlink(namesPath).catch(() => {});
	}
	manifest.names_key = namesKey;
	manifest.names_bytes = cardNamesStored.byteLength;
	console.log(
		`  card names uploaded: ${cardNames?.count} names, ${((cardNames?.raw.byteLength ?? 0) / 1024).toFixed(0)}KB raw -> ` +
			`${(cardNamesStored.byteLength / 1024).toFixed(0)}KB gzip (/cards/autocomplete asks ONE partition instead of ` +
			`${manifest.partition_count})`,
	);
} else {
	console.warn(`No ${CARD_NAMES_FILE} in ${dir}: /cards/autocomplete will fan out across every partition.`);
}

// x24: the printed-names blob, the same way (printedNamesKey, store:card-printed-…). Optional: without
// it the fuzzy plan asks every partition for containment's printed tier, as before x24.
if (printedNamesStored) {
	const printedKey = printedNamesKey(manifest.format_version, String(manifest.built_at));
	const printedPath = join(tmpdir(), "sylvan-store-printed-names.bin");
	await writeFile(printedPath, printedNamesStored);
	try {
		await kv(["key", "put", printedKey, "--path", printedPath, ...sized(printedNamesStored.byteLength), "--remote"]);
	} finally {
		await unlink(printedPath).catch(() => {});
	}
	manifest.printed_key = printedKey;
	manifest.printed_bytes = printedNamesStored.byteLength;
	console.log(
		`  printed names uploaded: ${printedNames?.count} cards, ${((printedNames?.raw.byteLength ?? 0) / 1024).toFixed(0)}KB raw -> ` +
			`${(printedNamesStored.byteLength / 1024).toFixed(0)}KB gzip (a fuzzy miss asks ONE partition instead of ` +
			`${manifest.partition_count})`,
	);
} else {
	console.warn(`No ${PRINTED_NAMES_FILE} in ${dir}: a fuzzy miss will ask every partition.`);
}

// The blocks the nightly decides — r3's cache codec, gated on the Durable Objects pool, and g1's
// placement, decided by its probes — are not the builder's to know. Carried from the manifest being
// replaced, or every deploy would reset them. A read that failed publishes without them, which is
// each block's safe default (gzip caches; the seed placement), and says so.
//
// "The manifest being replaced" is this format's own when there is one, else the newest live one
// of any format (replacedManifest): on a format bump that is the running build's, so its family
// becomes this manifest's rollback — the one family it would take to roll the code back.
const live = await readPublishedManifests<Record<string, unknown> & StoreManifest>(deployKv);
if (live.failed) {
	console.warn(
		`Could not read the live manifests to carry ${CARRIED_MANIFEST_BLOCKS.join(", ")} forward (${live.failed}); ` +
			"publishing without them — each reads as its safe default until the next nightly decides it again.",
	);
}
const replaced = replacedManifest(live.published, ARCHIVE_FORMAT_VERSION);
// The manifest this one replaces becomes the ROLLBACK role (previous_built_at) — read BEFORE the
// put, so it names yesterday's build and not a second copy of this one.
const published = withPreviousBuiltAt(carryManifestBlocks(manifest, replaced), replaced);
const carried = CARRIED_MANIFEST_BLOCKS.filter((b) => (published as Record<string, unknown>)[b] !== undefined);
if (carried.length) console.log(`  carried forward from the live manifest: ${carried.join(", ")}`);

// The commit point — only while this deploy still holds the lease. Only another deploy can take it,
// and that deploy has already deleted this build's family (deployStillHoldsLease).
if (!(await deployStillHoldsLease(deployKv, builtAt))) {
	console.error(
		`refusing to write the manifest: another deploy took the upload lease from build ${builtAt} and has ` +
			"retired its family; the live manifest is left as it is.",
	);
	process.exit(1);
}
const manifestPath = join(tmpdir(), "sylvan-store-manifest.json");
const manifestJson = JSON.stringify(published);
await writeFile(manifestPath, manifestJson);
// This format's key, then the legacy mirror only if it already holds this format (or nothing): a
// DIFFERENT format there is what the build still serving reads, and overwriting it was the dark
// window. An unreadable namespace (live.failed) writes only this format's key.
const legacy = live.failed ? { format_version: -1 } : (live.published.find((p) => p.legacy)?.manifest ?? null);
const manifestKeys = manifestKeysToWrite(ARCHIVE_FORMAT_VERSION, legacy);
try {
	for (const key of manifestKeys) {
		await kv(["key", "put", key, "--path", manifestPath, ...sized(manifestJson.length), "--remote"]);
	}
} finally {
	await unlink(manifestPath).catch(() => {});
}
console.log(
	`  manifest written to ${manifestKeys.join(" and ")}` +
		(manifestKeys.length === 1 ? " (the legacy key serves another format until it retires)" : ""),
);

// AFTER the manifest, which is the commit point: release the lease, then retention by role with the
// new roles — this build live, the one it replaced as the rollback, any other lease holder's family
// kept — and every other generation retired. A read that fails skips the sweep; the next deploy or
// nightly retries it.
const swept = await finishDeployUpload(deployKv, published);
if (swept === null) console.warn("Retention: could not read the lease or the key list — no sweep this time.");
else if (swept > 0) console.log(`Retention: dropped ${swept} key(s) from store generations with no role.`);

const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
console.log(
	`Store published to KV "${kvName}": ${manifest.store_key} ` +
		`(${manifest.partition_count} partitions, ${mb(manifest.store_bytes)} raw -> ` +
		`${mb(manifest.store_gzip_bytes as number)} gzip, ${manifest.chunk_count} chunks).`,
);
