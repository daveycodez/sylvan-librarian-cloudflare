// Publish the rulings buckets that back /cards/:id/rulings, without waiting for a nightly import.
//
//   bun scripts/seed-rulings.ts            # local simulated KV, for `bun dev`
//   bun scripts/seed-rulings.ts --remote   # production KV, for a fresh deploy
//
// The nightly ImportCoordinator writes exactly these keys (see its `rulings` phase) from exactly
// this code, so this is a shortcut in WHO runs it, not in what lands. Without it a fresh
// deployment answers 503 on the rulings routes until the first cron fires, and `bun dev` answers
// 503 forever — rulings are the one /cards/* input the local store build does not produce.
//
// One `kv bulk put`, which is one wrangler start-up rather than 257: local puts cannot even run
// concurrently (parallel wrangler processes fight over miniflare's own state and fail with
// "Network connection lost"), so per-key puts would be minutes of a dev loop.
//
// Bulk put takes its values from JSON, i.e. through a string — which is exactly why a bucket is
// ASCII (see src/engine/rulings-kv.ts). An earlier packed-binary index did not survive it: bucket
// `2b` went in at 112,993 bytes and landed at 113,887, payload intact and every oracle id in the
// index replaced with U+FFFD, so the route answered `data: []` for a card with 32 rulings.
//
// Remotely this is also 256 metered writes against the free plan's 1,000/day, which is what the
// nightly import pays on a first publish and why this is a deliberate step rather than part of
// every deploy.

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	encodeRulingsBucket,
	parseRulingLine,
	RULINGS_BUCKET_COUNT,
	RULINGS_CONTENT_GENERATION,
	RULINGS_FORMAT_VERSION,
	RULINGS_KEY_PREFIX,
	RULINGS_META_KEY,
	type RulingRow,
	type RulingsMeta,
	rulingsBucketKey,
	rulingsBucketOf,
	rulingsCurrentPrefix,
} from "../src/engine/rulings-kv";
import { pruneOldKeys } from "./kv-prune";
import { kvHasCurrent } from "./kv-published";
import { kvTargetArgs, requireDeployEnvironment } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

const remote = process.argv.includes("--remote");
/** Deploy-path mode: make sure the data is THERE, and leave keeping it current to the cron. */
const ifMissing = process.argv.includes("--if-missing");

if (ifMissing && (await kvHasCurrent(RULINGS_META_KEY, RULINGS_FORMAT_VERSION, RULINGS_CONTENT_GENERATION, remote))) {
	console.log(
		`Rulings v${RULINGS_FORMAT_VERSION} generation ${RULINGS_CONTENT_GENERATION} are already published — ` +
			"leaving them to the nightly import.",
	);
	process.exit(0);
}
const BULK_DATA_URL = process.env.SCRYFALL_BULK_URL ?? "https://api.scryfall.com/bulk-data";
const userAgent = `sylvan-librarian-seed/${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;

// ── fetch the dump ───────────────────────────────────────────────────────────

const listing = (await (await fetch(BULK_DATA_URL, { headers: { "User-Agent": userAgent } })).json()) as {
	data?: { type?: string; jsonl_download_uri?: string; updated_at?: string }[];
};
const record = (listing.data ?? []).find((r) => r.type === "rulings");
if (!record?.jsonl_download_uri) throw new Error("/bulk-data listing has no jsonl_download_uri for rulings");
console.log(`Fetching ${record.jsonl_download_uri} ...`);
const response = await fetch(record.jsonl_download_uri, {
	headers: { "User-Agent": userAgent, "Accept-Encoding": "identity" },
});
if (!response.ok) throw new Error(`rulings dump answered ${response.status}`);
const compressed = new Uint8Array(await response.arrayBuffer());
const text = new TextDecoder().decode(gunzipSync(compressed));

// ── build every bucket ───────────────────────────────────────────────────────

const byBucket = new Map<number, RulingRow[]>();
let lines = 0;
let usable = 0;
for (const line of text.split("\n")) {
	if (line.trim().length === 0) continue;
	lines += 1;
	const row = parseRulingLine(line);
	if (row === null) continue;
	usable += 1;
	const bucket = rulingsBucketOf(row.oracle_id);
	if (bucket === null) continue;
	const group = byBucket.get(bucket);
	if (group) group.push(row);
	else byBucket.set(bucket, [row]);
}
// The coordinator's own coverage check, so a format change fails here too rather than seeding 256
// empty buckets that read as "no card has any rulings".
if (lines > 0 && usable < 0.8 * lines) {
	throw new Error(`rulings dump: only ${usable} of ${lines} entries are usable; format changed?`);
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const entries: { key: string; value: string }[] = [];
let rulings = 0;
for (let bucket = 0; bucket < RULINGS_BUCKET_COUNT; bucket++) {
	const { bytes, rulingCount } = encodeRulingsBucket(byBucket.get(bucket) ?? []);
	rulings += rulingCount;
	// Decoded strictly: a bucket that is not valid UTF-8 would go through bulk put's string path
	// and land mangled, and this is where that has to be caught rather than at a request.
	entries.push({ key: rulingsBucketKey(bucket), value: decoder.decode(bytes) });
}
const meta: RulingsMeta = {
	format_version: RULINGS_FORMAT_VERSION,
	content_generation: RULINGS_CONTENT_GENERATION,
	bucket_count: RULINGS_BUCKET_COUNT,
	built_at: String(Math.floor(Date.now() / 1000)),
	ruling_count: rulings,
};
// Last in the file, as it is last in the phase: it is what tells the next import the set is really
// in KV, so it must not describe buckets that did not land.
entries.push({ key: RULINGS_META_KEY, value: JSON.stringify(meta) });

// ── write ────────────────────────────────────────────────────────────────────

if (remote) requireDeployEnvironment();
const bulkFile = join(tmpdir(), "sylvan-rulings-bulk.json");
await writeFile(bulkFile, JSON.stringify(entries));
try {
	const argv = [...wranglerArgv(), "kv", "bulk", "put", bulkFile, ...(await kvTargetArgs(remote))];
	const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error("kv bulk put failed");
} finally {
	await unlink(bulkFile).catch(() => {});
}

// The meta key has landed, so the set is complete — anything left under an older layout version
// is now unreachable. See scripts/kv-prune.ts.
const pruned = await pruneOldKeys(RULINGS_KEY_PREFIX, rulingsCurrentPrefix(), remote);
if (pruned > 0) console.log(`Retention: dropped ${pruned} rulings key(s) from an older layout.`);

console.log(
	`Rulings seeded into ${remote ? "production" : "local"} KV: ${rulings} rulings ` +
		`(${usable}/${lines} dump entries usable) across ${RULINGS_BUCKET_COUNT} buckets.`,
);
