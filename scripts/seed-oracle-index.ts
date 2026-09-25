// Publish the scryfall id → oracle id index (src/engine/oracle-index.ts) from a native store build.
//
//   bun scripts/seed-oracle-index.ts store-build            # production KV (Workers Builds only)
//   bun scripts/seed-oracle-index.ts store-build --local    # local simulated KV, for `bun dev`
//   bun scripts/seed-oracle-index.ts store-build --dry-run  # encode and report; write nothing
//
// The deploy path's half; the nightly coordinator's `oracle_index` phase is the other, from the
// same encoder and the same meta-held hashes, so each skips the buckets the other already wrote.
// Run by import-store.sh right after seed-remote-kv.ts, i.e. only when the deploy built a store —
// a deploy that skips the import has no pairs to publish, and leaves the index to the nightly.
// NEVER FATAL there: a missing index costs one engine call per rulings request, which is today.
//
// SOURCE: `oracle-pairs.bin` (the builder's sidecar, 32 bytes per printing whose card object
// carries an oracle id — `transform::oracle_pair_of_row` — written beside routing-keys.tsv). A
// build dir from an older builder falls back to reading rows.jsonl and applying the same rule
// here (`pairFromRow`, pinned in tests/engine/oracle-index.test.ts). `bun run harness:import` runs
// the native builder and the nightly on one corpus and requires byte-identical buckets.
//
// UPLOAD: one `kv bulk put` with `base64: true` remotely — the bulk API decodes base64
// server-side, so the binary survives the JSON transport that mangled the rulings' first layout.
// NOT locally: wrangler's local bulk path decodes base64 to a UTF-8 STRING before the put
// (`Buffer.from(data, "base64").toString()`), which is the same mangling. Locally each changed
// bucket is a `kv key put --path` instead (~1s each).

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	encodeOracleIndexBuckets,
	ORACLE_INDEX_KEY_PREFIX,
	ORACLE_INDEX_META_KEY,
	ORACLE_PAIR_BYTES,
	type OracleIndexMeta,
	oracleIndexBucketKey,
	oracleIndexCurrentPrefix,
	planOracleIndexPublish,
	uuidBytes,
} from "../src/engine/oracle-index";
import { kvGetText, pruneOldKeys } from "./kv-prune";
import { kvTargetArgs, requireDeployEnvironment } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

/** The sidecar the native builder writes (engine/builder/src/lib.rs). */
export const ORACLE_PAIRS_FILE = "oracle-pairs.bin";

/**
 * One finalized row's pair — `transform::oracle_pair_of_row`, in TS, for build dirs that predate
 * the sidecar: both ids must be UUIDs, and a `reversible_card` printing has none (its card object
 * carries no top-level oracle_id, so the engine answers its rulings `data: []`).
 */
export function pairFromRow(
	row: { scryfall_id?: unknown; oracle_id?: unknown; card_layout?: unknown },
	out: Uint8Array,
	at: number,
): boolean {
	if (row.card_layout === "reversible_card") return false;
	if (typeof row.scryfall_id !== "string" || typeof row.oracle_id !== "string") return false;
	const s = uuidBytes(row.scryfall_id, out.subarray(at, at + 16));
	if (s === null) return false;
	return uuidBytes(row.oracle_id, out.subarray(at + 16, at + ORACLE_PAIR_BYTES)) !== null;
}

/** Every pair in a build dir, as runs: the sidecar when present, else rows.jsonl. */
export async function readPairs(dir: string): Promise<{ runs: Uint8Array[]; source: string }> {
	const sidecar = join(dir, ORACLE_PAIRS_FILE);
	if (existsSync(sidecar)) return { runs: [new Uint8Array(readFileSync(sidecar))], source: sidecar };
	const rows = join(dir, "rows.jsonl");
	if (!existsSync(rows)) throw new Error(`${dir} has neither ${ORACLE_PAIRS_FILE} nor rows.jsonl`);
	const runs: Uint8Array[] = [];
	let run = new Uint8Array(4096 * ORACLE_PAIR_BYTES);
	let at = 0;
	for await (const line of jsonlLines(rows)) {
		if (!pairFromRow(JSON.parse(line) as Record<string, unknown>, run, at)) continue;
		at += ORACLE_PAIR_BYTES;
		if (at === run.length) {
			runs.push(run);
			run = new Uint8Array(run.length);
			at = 0;
		}
	}
	runs.push(run.subarray(0, at));
	return { runs, source: `${rows} (no ${ORACLE_PAIRS_FILE}: a build from an older builder)` };
}

/**
 * A JSONL file's non-empty lines, split on `\n` BYTES only. Not node:readline: it also breaks on a
 * lone `\r` and on U+2028/U+2029, which serde_json writes unescaped inside strings — measured on
 * 2026-09-24's rows.jsonl, where a readline split cut a row mid-string.
 */
export async function* jsonlLines(path: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let carry = new Uint8Array(0);
	for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
		const bytes = chunk as Uint8Array;
		let buf = bytes;
		if (carry.length > 0) {
			buf = new Uint8Array(carry.length + bytes.length);
			buf.set(carry);
			buf.set(bytes, carry.length);
		}
		let start = 0;
		for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
			if (nl > start) yield decoder.decode(buf.subarray(start, nl));
			start = nl + 1;
		}
		carry = buf.slice(start);
	}
	if (carry.length > 0) yield decoder.decode(carry);
}

async function main(): Promise<void> {
	const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "store-build";
	const dryRun = process.argv.includes("--dry-run");
	const remote = !process.argv.includes("--local");
	if (remote && !dryRun) requireDeployEnvironment();

	const { runs, source } = await readPairs(dir);
	const { buckets, pairCount, conflicts } = encodeOracleIndexBuckets(runs);
	if (pairCount === 0) throw new Error("no (scryfall_id, oracle_id) pairs found — refusing to publish an empty index");
	const builtAt = String(
		(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { built_at?: unknown }).built_at ?? "",
	);
	const bytes = buckets.reduce((n, b) => n + b.byteLength, 0);
	console.log(
		`Oracle index: ${pairCount} printings from ${source}` +
			`${conflicts > 0 ? ` (${conflicts} conflicting ids dropped)` : ""}, ` +
			`${buckets.length} buckets, ${(bytes / 1048576).toFixed(1)}MB.`,
	);
	if (dryRun) return;

	const read = await kvGetText(ORACLE_INDEX_META_KEY, remote);
	if (read.failed) throw new Error(`could not read ${ORACLE_INDEX_META_KEY}: ${read.failed}`);
	let published: OracleIndexMeta | null = null;
	try {
		published = read.value ? (JSON.parse(read.value.slice(read.value.indexOf("{"))) as OracleIndexMeta) : null;
	} catch {
		published = null; // unparseable describes nothing: every bucket is owed
	}
	const { changed, meta } = await planOracleIndexPublish(buckets, pairCount, builtAt, published);
	console.log(`Oracle index: ${changed.length}/${buckets.length} bucket(s) differ from what KV holds.`);

	const target = await kvTargetArgs(remote);
	if (changed.length > 0) {
		if (remote) {
			const entries = changed.map((b) => ({
				key: oracleIndexBucketKey(b),
				value: Buffer.from(buckets[b] as Uint8Array).toString("base64"),
				base64: true,
			}));
			const file = join(tmpdir(), "sylvan-oracle-index-bulk.json");
			await writeFile(file, JSON.stringify(entries));
			try {
				const proc = Bun.spawn([...wranglerArgv(), "kv", "bulk", "put", file, ...target], {
					stdout: "inherit",
					stderr: "inherit",
				});
				if ((await proc.exited) !== 0) throw new Error("kv bulk put failed");
			} finally {
				await unlink(file).catch(() => {});
			}
		} else {
			for (const b of changed) {
				const file = join(tmpdir(), `sylvan-oracle-index-${b}.bin`);
				await writeFile(file, buckets[b] as Uint8Array);
				try {
					const argv = [...wranglerArgv(), "kv", "key", "put", oracleIndexBucketKey(b), "--path", file, ...target];
					const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "inherit" });
					if ((await proc.exited) !== 0) throw new Error(`kv key put ${oracleIndexBucketKey(b)} failed`);
				} finally {
					await unlink(file).catch(() => {});
				}
			}
		}
	}

	// LAST, and only after every changed bucket landed: its hashes are what the next publisher diffs
	// against, so it must never describe a bucket KV does not hold.
	const metaFile = join(tmpdir(), "sylvan-oracle-index-meta.json");
	await writeFile(metaFile, JSON.stringify(meta));
	try {
		const argv = [...wranglerArgv(), "kv", "key", "put", ORACLE_INDEX_META_KEY, "--path", metaFile, ...target];
		const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "inherit" });
		if ((await proc.exited) !== 0) throw new Error("meta put failed");
	} finally {
		await unlink(metaFile).catch(() => {});
	}
	// The nightly's rule: sweep an older layout's buckets only when the layout moved.
	if (published?.format_version !== meta.format_version) {
		const pruned = await pruneOldKeys(ORACLE_INDEX_KEY_PREFIX, oracleIndexCurrentPrefix(), remote);
		if (pruned > 0) console.log(`Retention: dropped ${pruned} oracle-index key(s) from an older layout.`);
	}
	console.log(
		`Oracle index published to ${remote ? "production" : "local"} KV: ${changed.length} bucket(s) and the meta.`,
	);
}

if (import.meta.main) await main();
