// Publish the tag alias map for the build the LIVE manifest names, when none is there.
//
//   bun scripts/publish-tag-aliases.ts --remote     # production KV (deploy only — see kv-target.ts)
//   bun scripts/publish-tag-aliases.ts              # wrangler's local dev KV
//
// Both publishers write the map beside the store they build (src/engine/tag-aliases.ts): the
// deploy's seeder from the builder's sidecar, the nightly coordinator from the wasm import. This
// script covers the one build neither can reach — the store that is live RIGHT NOW, built before
// the map shipped with the store — so a deploy that skips the import (a routine code push) does
// not leave the Worker resolving no aliases until the next nightly. It runs from import-store.sh's
// skip path (the one deploy that publishes nothing else) and is a no-op once the live build
// carries its map.
//
// THE MAP IS CUT FROM TODAY'S TAG DUMPS, not from the dumps the live store was built from, which
// the coordinator no longer has. Tags move slowly (one slug flip and 18 new aliases in five weeks
// of drift), so a map a day newer than its store is the right answer for a day; the next nightly
// publishes the exact one. The resolution rules are the wasm import's own — the same Rust the
// coordinator runs, fed the same JSONL — so this cannot disagree with it about what an alias is.

import { existsSync, readFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { plugin } from "bun";
import { MANIFEST_KEY } from "../src/engine/store-kv";
import { parseTagAliasTables, tagAliasesKey } from "../src/engine/tag-aliases";
import type { StoreManifest } from "../src/engine/types";
import { kvTargetArgs, requireDeployEnvironment } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

const REMOTE = process.argv.includes("--remote");
const BULK_DATA_URL = process.env.SCRYFALL_BULK_URL ?? "https://api.scryfall.com/bulk-data";
const USER_AGENT = "sylvan-librarian-cloudflare/publish-tag-aliases";
/** Lines per wasm call, the coordinator's own batch (LINES_PER_CALL in src/import-coordinator.ts). */
const LINES_PER_CALL = 2_000;

/** A `.wasm` import is a WebAssembly.Module under wrangler's CompiledWasm rule; under bun it is a
 * file path. Same load-time shim as scripts/import-harness/run.ts, registered before the module
 * that imports it is loaded. */
const WasmModule = WebAssembly.Module as unknown as new (bytes: ArrayBuffer) => WebAssembly.Module;
plugin({
	name: "wasm-as-module",
	setup(build) {
		build.onLoad({ filter: /\.wasm$/ }, async (args) => ({
			exports: { default: new WasmModule(await Bun.file(args.path).arrayBuffer()) },
			loader: "object",
		}));
	},
});

if (REMOTE) requireDeployEnvironment();
const target = await kvTargetArgs(REMOTE);

/** `wrangler kv key get` as text, or null when the key is absent. Remote answers a missing key
 * with a non-zero exit; the local store answers it with an empty body — both are "absent". */
async function kvGet(key: string): Promise<string | null> {
	const proc = Bun.spawn([...wranglerArgv(), "kv", "key", "get", key, ...target], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) return null;
	const at = out.indexOf("{");
	return at === -1 ? null : out.slice(at);
}

async function kvPut(key: string, path: string): Promise<void> {
	const proc = Bun.spawn([...wranglerArgv(), "kv", "key", "put", key, "--path", path, ...target], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((await proc.exited) !== 0) {
		throw new Error(`wrangler kv key put ${key} failed: ${(err.trim() || out.trim()).split("\n").slice(-4).join(" ")}`);
	}
}

// ── which build, and does it already have a map ────────────────────────────────

const manifestText = await kvGet(MANIFEST_KEY);
if (manifestText === null) {
	console.log("No store manifest is published; nothing to attach an alias map to.");
	process.exit(0);
}
const manifest = JSON.parse(manifestText) as StoreManifest;
if (!manifest.format_version || !manifest.built_at) {
	console.log(`The live manifest (${manifest.store_key}) carries no format_version/built_at; nothing to key a map by.`);
	process.exit(0);
}
const key = tagAliasesKey(manifest.format_version, String(manifest.built_at));
const existing = await kvGet(key);
if (existing !== null) {
	try {
		const tables = parseTagAliasTables(existing);
		console.log(
			`Build ${manifest.built_at} already carries its alias map (${tables.oracle.size} oracle + ${tables.art.size} art) at ${key}.`,
		);
		process.exit(0);
	} catch (err) {
		console.warn(`The alias map at ${key} does not parse (${err}); republishing it.`);
	}
}

// ── cut the map from today's tag dumps, through the same wasm the nightly runs ─

const { ImportWasm } = await import("../src/engine/import-wasm");
const wasm = new ImportWasm();
wasm.reset();

interface BulkListing {
	data?: { type?: string; jsonl_download_uri?: string; updated_at?: string }[];
}
const listing = (await (await fetch(BULK_DATA_URL, { headers: { "User-Agent": USER_AGENT } })).json()) as BulkListing;

/** Stream one gzipped JSONL dump into the wasm's tag accumulator, LINES_PER_CALL lines at a time. */
async function feed(kind: "oracle_tags" | "art_tags", code: 1 | 2): Promise<void> {
	const record = listing.data?.find((d) => d.type === kind);
	if (!record?.jsonl_download_uri) throw new Error(`/bulk-data lists no jsonl_download_uri for ${kind}`);
	console.log(`Streaming ${kind} (${record.updated_at}) from ${record.jsonl_download_uri} ...`);
	const local = process.env.SYLVAN_BULK_DIR ? join(process.env.SYLVAN_BULK_DIR, `${kind}.jsonl.gz`) : null;
	const body =
		local && existsSync(local)
			? new Blob([readFileSync(local)]).stream()
			: (await fetch(record.jsonl_download_uri, { headers: { "User-Agent": USER_AGENT } })).body;
	if (!body) throw new Error(`${kind}: empty response body`);
	const gunzip = createGunzip();
	const decoder = new TextDecoder();
	let pending = "";
	let batch: string[] = [];
	let lines = 0;
	wasm.tagsBegin();
	const flush = () => {
		if (batch.length === 0) return;
		wasm.tagsAddLines(batch.join("\n"));
		lines += batch.length;
		batch = [];
	};
	const take = (chunk: Uint8Array) => {
		pending += decoder.decode(chunk, { stream: true });
		let at = 0;
		for (;;) {
			const nl = pending.indexOf("\n", at);
			if (nl === -1) break;
			const line = pending.slice(at, nl);
			at = nl + 1;
			if (line.trim().length > 0) batch.push(line);
			if (batch.length >= LINES_PER_CALL) flush();
		}
		pending = pending.slice(at);
	};
	const done = new Promise<void>((resolve, reject) => {
		gunzip.on("data", (chunk: Buffer) => take(new Uint8Array(chunk)));
		gunzip.on("end", () => resolve());
		gunzip.on("error", reject);
	});
	const reader = body.getReader();
	for (;;) {
		const { value, done: eof } = await reader.read();
		if (eof) break;
		if (value) gunzip.write(value);
	}
	gunzip.end();
	await done;
	pending += decoder.decode();
	if (pending.trim().length > 0) batch.push(pending);
	flush();
	const mapped = wasm.tagsFinish(code);
	console.log(`  ${kind}: ${lines} tags, ${mapped} ids mapped`);
}

await feed("oracle_tags", 1);
await feed("art_tags", 2);

let json = "";
wasm.setHandlers({
	onTagAliases: (b) => {
		json = new TextDecoder().decode(b);
	},
});
wasm.tagAliasesExport();
wasm.setHandlers({});
const tables = parseTagAliasTables(json);

// ── publish ────────────────────────────────────────────────────────────────────

const tmp = join(tmpdir(), "sylvan-tag-aliases.json");
await writeFile(tmp, json);
try {
	await kvPut(key, tmp);
} finally {
	await unlink(tmp).catch(() => {});
}
console.log(
	`Tag aliases published for build ${manifest.built_at}: ${tables.oracle.size} oracle + ${tables.art.size} art ` +
		`(${json.length} bytes) at ${key}.`,
);
