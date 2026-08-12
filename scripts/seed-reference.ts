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
	rawArrayElements,
	renderCatalog,
	renderSets,
	renderSymbology,
	SETS_BUCKET_COUNT,
	setsBucketKey,
	setsListKey,
	symbologyKey,
} from "../src/engine/reference-kv";
import { kvHasCurrent } from "./kv-published";
import { kvTargetArgs, requireDeployEnvironment } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

const remote = process.argv.includes("--remote");
/** Deploy-path mode: make sure the data is THERE, and leave keeping it current to the cron. */
const ifMissing = process.argv.includes("--if-missing");
const API = process.env.SCRYFALL_API_URL ?? "https://api.scryfall.com";
const userAgent = `sylvan-librarian-seed/${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Milliseconds between requests to api.scryfall.com.
 *
 * Scryfall asks for 50-100ms of delay between requests and rate-limits callers who ignore it; this
 * script makes twenty-two in a row (the set list, twenty catalogs, the symbol list), which is
 * exactly the shape that would otherwise arrive as a burst. The conservative end of their range,
 * because the whole run still costs ~2s and nothing is waiting on it.
 */
const SCRYFALL_DELAY_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let firstRequest = true;

/**
 * One endpoint, as BOTH the parsed payload and its raw text.
 *
 * The raw text is what actually gets stored: these routes serve what Scryfall sent, down to how it
 * wrote the numbers (`"mana_value":0.0` is a decimal there, and JavaScript cannot re-emit that).
 * The parsed copy is only used to derive lookup keys.
 */
async function fetchJson(path: string): Promise<{ payload: Record<string, unknown>; raw: string[] }> {
	// Before the request rather than after it, so the pacing holds however the callers are ordered
	// and no path can skip it by returning early.
	if (!firstRequest) await sleep(SCRYFALL_DELAY_MS);
	firstRequest = false;
	const res = await fetch(`${API}/${path}`, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
	if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
	const text = await res.text();
	return { payload: JSON.parse(text) as Record<string, unknown>, raw: rawArrayElements(text) };
}

if (ifMissing && (await kvHasCurrent(REFERENCE_META_KEY, REFERENCE_FORMAT_VERSION, remote))) {
	console.log(`Reference data v${REFERENCE_FORMAT_VERSION} is already published — leaving it to the nightly import.`);
	process.exit(0);
}

const entries: { key: string; value: string }[] = [];

// ── sets ─────────────────────────────────────────────────────────────────────

console.log("Fetching /sets ...");
const { payload: setsPayload, raw: setsRaw } = await fetchJson("sets");
const setsData = setsPayload.data;
if (!Array.isArray(setsData) || setsData.length === 0) throw new Error("/sets answered no data");
const { list, buckets, setCount } = renderSets(setsData as Record<string, unknown>[], setsRaw);
entries.push({ key: setsListKey(), value: list });
for (let bucket = 0; bucket < buckets.length; bucket++) {
	// Decoded strictly: a value that is not valid UTF-8 would be mangled by bulk put's string path,
	// and this is where that has to fail rather than at a request.
	entries.push({ key: setsBucketKey(bucket), value: decoder.decode(buckets[bucket] as Uint8Array) });
}

// ── catalogs ─────────────────────────────────────────────────────────────────

const catalogCounts: Record<string, number> = {};
for (const name of CATALOG_NAMES) {
	const { payload, raw } = await fetchJson(`catalog/${name}`);
	const values = payload.data;
	if (!Array.isArray(values)) throw new Error(`/catalog/${name} answered no data array`);
	const { json, count } = renderCatalog(values, raw);
	catalogCounts[name] = count;
	entries.push({ key: catalogKey(name), value: encodeCountedArray(json, count) });
}
console.log(
	`Fetched ${CATALOG_NAMES.length} catalogs, ${Object.values(catalogCounts).reduce((a, b) => a + b, 0)} values`,
);

// ── symbology ────────────────────────────────────────────────────────────────

const { payload: symbologyPayload, raw: symbologyRaw } = await fetchJson("symbology");
const symbolsData = symbologyPayload.data;
if (!Array.isArray(symbolsData) || symbolsData.length === 0) throw new Error("/symbology answered no data");
const symbology = renderSymbology(symbolsData as Record<string, unknown>[], symbologyRaw);
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

if (remote) requireDeployEnvironment();
const bulkFile = join(tmpdir(), "sylvan-reference-bulk.json");
await writeFile(bulkFile, JSON.stringify(entries));
try {
	const argv = [...wranglerArgv(), "kv", "bulk", "put", bulkFile, ...(await kvTargetArgs(remote))];
	const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error("kv bulk put failed");
} finally {
	await unlink(bulkFile).catch(() => {});
}

console.log(
	`Reference data seeded into ${remote ? "production" : "local"} KV: ${setCount} sets, ` +
		`${CATALOG_NAMES.length} catalogs, ${symbology.count} symbols across ${entries.length} values.`,
);
