// Publish the reference data behind /sets, /catalog/* and /symbology, without waiting for a
// nightly import.
//
//   bun scripts/seed-reference.ts            # local simulated KV, for `bun dev`
//   bun scripts/seed-reference.ts --remote   # production KV, for a fresh deploy
//
// The nightly ImportCoordinator writes exactly these keys from exactly this rendering code (see its
// `reference` phase and src/engine/reference-kv.ts), so this is a shortcut in WHO runs it, not in
// what lands. Without it a fresh deployment answers 503 on these routes until the first cron fires,
// and `bun dev` answers 503 forever — none of this comes from the store build.
//
// Twenty-two requests to api.scryfall.com and 38 KV values, one `kv bulk put`. Every value is ASCII
// (see keyed-blob.ts for why that is a requirement rather than a preference), so the string path
// bulk put uses carries them intact.

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CATALOG_NAMES,
	catalogKey,
	encodeCountedArray,
	REFERENCE_FORMAT_VERSION,
	REFERENCE_META_KEY,
	type ReferenceMeta,
	renderCatalog,
	renderSets,
	renderSymbology,
	SETS_BUCKET_COUNT,
	setsBucketKey,
	setsListKey,
	symbologyKey,
} from "../src/engine/reference-kv";
import { wranglerArgv } from "./wrangler-cmd";

const remote = process.argv.includes("--remote");
const API = process.env.SCRYFALL_API_URL ?? "https://api.scryfall.com";
const userAgent = `sylvan-librarian-seed/${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

async function fetchJson(path: string): Promise<Record<string, unknown>> {
	const res = await fetch(`${API}/${path}`, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
	if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
	return (await res.json()) as Record<string, unknown>;
}

const entries: { key: string; value: string }[] = [];

// ── sets ─────────────────────────────────────────────────────────────────────

console.log("Fetching /sets ...");
const setsPayload = await fetchJson("sets");
const setsData = setsPayload.data;
if (!Array.isArray(setsData) || setsData.length === 0) throw new Error("/sets answered no data");
const { list, buckets, setCount } = renderSets(setsData as Record<string, unknown>[]);
entries.push({ key: setsListKey(), value: list });
for (let bucket = 0; bucket < buckets.length; bucket++) {
	// Decoded strictly: a value that is not valid UTF-8 would be mangled by bulk put's string path,
	// and this is where that has to fail rather than at a request.
	entries.push({ key: setsBucketKey(bucket), value: decoder.decode(buckets[bucket] as Uint8Array) });
}

// ── catalogs ─────────────────────────────────────────────────────────────────

const catalogCounts: Record<string, number> = {};
for (const name of CATALOG_NAMES) {
	const payload = await fetchJson(`catalog/${name}`);
	const values = payload.data;
	if (!Array.isArray(values)) throw new Error(`/catalog/${name} answered no data array`);
	const { json, count } = renderCatalog(values);
	catalogCounts[name] = count;
	entries.push({ key: catalogKey(name), value: encodeCountedArray(json, count) });
}
console.log(
	`Fetched ${CATALOG_NAMES.length} catalogs, ${Object.values(catalogCounts).reduce((a, b) => a + b, 0)} values`,
);

// ── symbology ────────────────────────────────────────────────────────────────

const symbologyPayload = await fetchJson("symbology");
const symbolsData = symbologyPayload.data;
if (!Array.isArray(symbolsData) || symbolsData.length === 0) throw new Error("/symbology answered no data");
const symbology = renderSymbology(symbolsData as Record<string, unknown>[]);
entries.push({ key: symbologyKey(), value: symbology.json });

const meta: ReferenceMeta = {
	format_version: REFERENCE_FORMAT_VERSION,
	bucket_count: SETS_BUCKET_COUNT,
	built_at: String(Math.floor(Date.now() / 1000)),
	set_count: setCount,
	symbol_count: symbology.count,
	catalogs: catalogCounts,
};
// Last, as it is last in the phase: it says the published set is really there.
entries.push({ key: REFERENCE_META_KEY, value: JSON.stringify(meta) });

// ── write ────────────────────────────────────────────────────────────────────

const bulkFile = join(tmpdir(), "sylvan-reference-bulk.json");
await writeFile(bulkFile, JSON.stringify(entries));
try {
	const argv = [
		...wranglerArgv(),
		"kv",
		"bulk",
		"put",
		bulkFile,
		"--binding",
		"STORE_KV",
		remote ? "--remote" : "--local",
	];
	if (!remote) argv.push("-c", "wrangler.dev.jsonc");
	const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error("kv bulk put failed");
} finally {
	await unlink(bulkFile).catch(() => {});
}

console.log(
	`Reference data seeded into ${remote ? "production" : "local"} KV: ${setCount} sets, ` +
		`${CATALOG_NAMES.length} catalogs, ${symbology.count} symbols across ${entries.length} values.`,
);
