// Push a natively-built store to PRODUCTION D1, so a first deploy is live
// immediately instead of waiting ~10 minutes for the in-Worker bootstrap
// import. Runs from a dev machine with `wrangler login` credentials; the
// Worker itself still needs zero configuration.
//
//   bun scripts/seed-remote-d1.ts <store-build-dir> [--with-cards]
//
// Emits the same writes as the ImportCoordinator's publish phase, as SQL
// files ingested via `wrangler d1 execute --remote` (which routes large
// files through D1's server-side import), in a deliberately safe order:
//
//   1. store chunks            (site not yet affected)
//   2. history + manifest      <- commit point: the site goes LIVE here
//   3. cards + fallback_meta   (--with-cards only)
//
// A failure at any point leaves the deployment in a valid state — before the
// manifest the site reports an unavailable index; after it, the site
// serves and the nightly import tops up whatever is missing.
//
// --with-cards also seeds the SQL-fallback cards table (~200k metered row
// writes). That exceeds the FREE plan's ~100k/day D1 write limit — use it on
// paid; on free, skip it and let the nightly adaptive import fill the table.

import { readFileSync } from "node:fs";
import { d1Name } from "./project-config";

const args = process.argv.slice(2);
const withCards = args.includes("--with-cards");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
	console.error("usage: bun scripts/seed-remote-d1.ts <store-build-dir> [--with-cards]");
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as {
	store_key: string;
	store_bytes: number;
	[k: string]: unknown;
};
const store = new Uint8Array(readFileSync(`${dir}/${manifest.store_key}`));
if (store.length !== manifest.store_bytes) {
	throw new Error(`store file is ${store.length} bytes, manifest says ${manifest.store_bytes}`);
}

// Bounded by D1's SQL statement limit, NOT by the in-Worker publisher's chunk
// size. These rows are written as `INSERT ... X'<hex>'`, and hex doubles the
// payload: at the wasm import's 900_000-byte chunks a single statement is
// ~1.8MB against D1's documented 100,000-byte maximum, which fails with
// "statement too long: SQLITE_TOOBIG" every time. 40_000 bytes → ~80KB of hex
// plus statement text, comfortably inside the limit.
//
// The store loader accepts any chunking (it concatenates by seq and checks the
// total against the manifest), so a different chunk size here is not a format
// difference — but it does mean more, smaller rows, which is why the read path
// batches by BYTES rather than by a fixed row count (see store.ts).
const CHUNK_BYTES = 40_000;
const chunkCount = Math.ceil(store.length / CHUNK_BYTES);
(manifest as Record<string, unknown>).chunk_count = chunkCount;

/** Published store versions kept. One previous version covers isolates mid-swap;
 * more just consumes the free plan's 500MB D1 ceiling (~75MB per version, and
 * the SQL-fallback cards table wants ~100MB of it too). Matches the in-Worker
 * publish path's KEEP_STORES. */
const KEEP_STORES = 2;

/** Statements per SQL file — sized to keep each file well under 100MB. */
const TARGET_FILE_BYTES = 48_000_000;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sqlEscape = (s: string) => s.replace(/'/g, "''");
const sqlLit = (v: unknown): string => {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number") return String(v);
	// Objects/arrays are the JSON-typed columns — stored as JSON text.
	const s = typeof v === "object" ? JSON.stringify(v) : String(v);
	return `'${sqlEscape(s)}'`;
};

async function execRemote(sqlPath: string): Promise<void> {
	if (process.env.SEED_REMOTE_DRY) {
		console.log(`[dry-run] would ingest ${sqlPath}`);
		return;
	}
	console.log(`Ingesting ${sqlPath}...`);
	const proc = Bun.spawn(
		["bunx", "wrangler", "d1", "execute", d1Name, "--remote", "-y", "-c", "wrangler.jsonc", "--file", sqlPath],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if ((await proc.exited) !== 0) {
		console.error(`Ingest of ${sqlPath} failed — the deployment is still in a valid state`);
		console.error("(no manifest = the site reports an unavailable index; manifest live = site serves).");
		process.exit(1);
	}
}

/** Write statements into sequentially numbered files of ~TARGET_FILE_BYTES. */
async function writeSqlFiles(prefix: string, statements: Iterable<string>): Promise<string[]> {
	const paths: string[] = [];
	let parts: string[] = [];
	let bytes = 0;
	const flush = async () => {
		if (parts.length === 0) return;
		const path = `${dir}/${prefix}-${paths.length}.sql`;
		await Bun.write(path, parts.join("\n"));
		paths.push(path);
		parts = [];
		bytes = 0;
	};
	for (const stmt of statements) {
		parts.push(stmt);
		bytes += stmt.length + 1;
		if (bytes >= TARGET_FILE_BYTES) await flush();
	}
	await flush();
	return paths;
}

// ── 1. store chunks ──────────────────────────────────────────────────────────
function* chunkStatements(): Generator<string> {
	yield "CREATE TABLE IF NOT EXISTS store_chunks (store_key TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (store_key, seq));";
	yield "CREATE TABLE IF NOT EXISTS store_manifest (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);";
	yield "CREATE TABLE IF NOT EXISTS store_history (store_key TEXT PRIMARY KEY, published_at INTEGER NOT NULL);";
	yield `DELETE FROM store_chunks WHERE store_key = '${sqlEscape(manifest.store_key)}';`;
	for (let seq = 0; seq < chunkCount; seq++) {
		const chunk = store.subarray(seq * CHUNK_BYTES, Math.min((seq + 1) * CHUNK_BYTES, store.length));
		yield `INSERT INTO store_chunks (store_key, seq, bytes) VALUES ('${sqlEscape(manifest.store_key)}', ${seq}, X'${hex(chunk)}');`;
	}
}
for (const path of await writeSqlFiles("seed-remote-chunks", chunkStatements())) {
	await execRemote(path);
}

// ── 2. the commit point: history + manifest — the site goes live here ────────
{
	const path = `${dir}/seed-remote-manifest.sql`;
	await Bun.write(
		path,
		[
			`INSERT OR REPLACE INTO store_history (store_key, published_at) VALUES ('${sqlEscape(manifest.store_key)}', ${Date.now()});`,
			`INSERT OR REPLACE INTO store_manifest (id, json) VALUES (1, '${sqlEscape(JSON.stringify(manifest))}');`,
		].join("\n"),
	);
	await execRemote(path);
	console.log(`Manifest live: ${manifest.store_key} — the site now serves.`);
}

// ── 3. prune superseded store versions ───────────────────────────────────────
//
// Without this D1 grows by a whole store (~75MB) per publish and never shrinks:
// step 1 only clears chunks for the key it is about to write. Observed on a real
// deployment going 75MB → 150MB across two builds, against the FREE plan's
// 500MB database ceiling — roughly six more deploys before publishes fail.
//
// Runs AFTER the manifest is live, so a failure here leaves a serving site with
// some extra rows, never a live manifest pointing at pruned chunks.
{
	const path = `${dir}/seed-remote-prune.sql`;
	const keep = `SELECT store_key FROM store_history ORDER BY published_at DESC LIMIT ${KEEP_STORES}`;
	await Bun.write(
		path,
		[
			`DELETE FROM store_chunks WHERE store_key NOT IN (${keep});`,
			`DELETE FROM store_history WHERE store_key NOT IN (${keep});`,
		].join("\n"),
	);
	await execRemote(path);
	console.log(`Pruned store versions beyond the ${KEEP_STORES} most recent.`);
}

// ── 4. optional: the SQL-fallback cards table ────────────────────────────────
if (!withCards) {
	console.log("Done (store only). The nightly import fills the SQL-fallback cards table;");
	console.log("on a paid plan, re-run with --with-cards to seed it now.");
	process.exit(0);
}

const { cardsRowValues, structuralHash } = await import("../src/fallback/cards-sync");
const rowsText = (() => {
	try {
		return readFileSync(`${dir}/rows.jsonl`, "utf8");
	} catch {
		console.error(`No ${dir}/rows.jsonl (older build?) — rebuild without --reuse to seed cards.`);
		process.exit(1);
	}
})();

function* cardsStatements(): Generator<string> {
	let columns: string[] = [];
	let batch: string[] = [];
	let total = 0;
	for (const line of rowsText.split("\n")) {
		if (!line) continue;
		const row = JSON.parse(line) as Record<string, unknown>;
		const values = cardsRowValues(row, structuralHash(row));
		if (columns.length === 0) {
			columns = Object.keys(values);
			yield `CREATE TABLE IF NOT EXISTS cards (${columns.map((c) => (c === "scryfall_id" ? `${c} TEXT PRIMARY KEY` : c)).join(", ")});`;
			yield "CREATE TABLE IF NOT EXISTS fallback_meta (id INTEGER PRIMARY KEY CHECK (id = 1), store_key TEXT NOT NULL, complete INTEGER NOT NULL, synced_rows INTEGER NOT NULL);";
		}
		batch.push(`(${columns.map((c) => sqlLit(values[c])).join(", ")})`);
		total++;
		if (batch.length >= 40) {
			yield `INSERT OR REPLACE INTO cards (${columns.join(", ")}) VALUES ${batch.join(", ")};`;
			batch = [];
		}
	}
	if (columns.length > 0 && batch.length > 0) {
		yield `INSERT OR REPLACE INTO cards (${columns.join(", ")}) VALUES ${batch.join(", ")};`;
	}
	if (total > 0) {
		// Completeness flips LAST, after every row landed.
		yield `INSERT OR REPLACE INTO fallback_meta (id, store_key, complete, synced_rows) VALUES (1, '${sqlEscape(manifest.store_key)}', 1, ${total});`;
	}
	console.log(`(${total} card rows staged)`);
}
for (const path of await writeSqlFiles("seed-remote-cards", cardsStatements())) {
	await execRemote(path);
}
console.log("Done: store live + SQL-fallback cards table complete.");
