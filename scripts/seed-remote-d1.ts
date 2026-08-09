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
// Step 1 uploads only the chunks D1 does not already hold (see
// src/engine/store-chunks.ts). That makes this both incremental and
// resumable, from one property: chunks are addressed by their content, so
// "already there" is decided by what the bytes ARE, not by how far a previous
// attempt got. A republish of an unchanged store uploads nothing; a rebuild
// after a day of Scryfall churn uploads the part that changed; a run killed
// halfway uploads the remainder rather than starting over.
//
// --with-cards also seeds the SQL-fallback cards table (~200k metered row
// writes). That exceeds the FREE plan's ~100k/day D1 write limit — use it on
// paid; on free, skip it and let the nightly adaptive import fill the table.

import { readFileSync } from "node:fs";
import { chunkHash, splitStore } from "../src/engine/store-chunks";
import { d1Name } from "./project-config";
import { wranglerArgv } from "./wrangler-cmd";

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

// The chunk grid and its hashing live in src/engine/store-chunks.ts, shared
// with the in-Worker publisher and the reader — a publisher that chose its own
// boundaries would share no chunks with the other one, and the whole delta
// would evaporate at the first alternation between deploy and nightly import.
const chunkBytes = splitStore(store);
const chunkHashes = await Promise.all(chunkBytes.map(chunkHash));
(manifest as Record<string, unknown>).chunk_count = chunkHashes.length;
(manifest as Record<string, unknown>).chunks = chunkHashes;

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

/**
 * What this publish cost D1, accumulated across every ingested file.
 *
 * Worth surfacing because these are metered: the free plan allows 5M rows read
 * and 100k rows written per day, and before chunks were content-addressed a
 * single publish spent ~1,831 of those writes whether or not anything had
 * changed. A number printed at the end of the build is how that stays honest —
 * the delta either shows up here as a small write count or it is not real.
 *
 * wrangler reports the figures per `--file` execution under `--json`; they are
 * D1's own accounting, not an estimate of ours.
 */
const d1Cost = { queries: 0, rowsRead: 0, rowsWritten: 0, sizeMB: "" };

async function execRemote(sqlPath: string): Promise<void> {
	if (process.env.SEED_REMOTE_DRY) {
		console.log(`[dry-run] would ingest ${sqlPath}`);
		return;
	}
	console.log(`Ingesting ${sqlPath}...`);
	const proc = Bun.spawn(
		[...wranglerArgv(), "d1", "execute", d1Name, "--remote", "-y", "--json", "-c", "wrangler.jsonc", "--file", sqlPath],
		{ stdout: "pipe", stderr: "inherit" },
	);
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) {
		console.error(out.trim());
		console.error(`Ingest of ${sqlPath} failed — the deployment is still in a valid state`);
		console.error("(no manifest = the site reports an unavailable index; manifest live = site serves).");
		process.exit(1);
	}
	// Accounting is a bonus, never a failure: a parse miss must not fail a
	// publish that D1 already accepted.
	try {
		const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
			results?: Record<string, unknown>[];
		}[];
		const stats = parsed[0]?.results?.[0] ?? {};
		d1Cost.queries += Number(stats["Total queries executed"] ?? 0);
		d1Cost.rowsRead += Number(stats["Rows read"] ?? 0);
		d1Cost.rowsWritten += Number(stats["Rows written"] ?? 0);
		if (stats["Database size (MB)"]) d1Cost.sizeMB = String(stats["Database size (MB)"]);
	} catch {
		/* statistics unavailable for this file */
	}
}

/** One line at the end of the build saying what this publish cost D1. */
function reportD1Cost(label: string): void {
	if (process.env.SEED_REMOTE_DRY) return;
	console.log(
		`D1 cost (${label}): ${d1Cost.rowsWritten.toLocaleString()} rows written, ` +
			`${d1Cost.rowsRead.toLocaleString()} rows read, ${d1Cost.queries.toLocaleString()} queries` +
			`${d1Cost.sizeMB ? `, database now ${d1Cost.sizeMB}MB` : ""}.`,
	);
}

/**
 * Which of `hashes` D1 already holds.
 *
 * Deliberately a real query rather than `INSERT OR IGNORE` on everything: OR
 * IGNORE would make the writes cheap but still push every chunk's hex across
 * the wire, which is the ~150MB and the minutes this step exists to avoid.
 *
 * A failure here is NOT fatal — it only costs the delta. Treating "cannot ask"
 * as "D1 has nothing" re-uploads the whole store, which is exactly the old
 * behaviour, so the publish stays correct while losing the optimisation.
 */
async function existingHashes(hashes: string[]): Promise<string[]> {
	if (process.env.SEED_REMOTE_DRY || hashes.length === 0) return [];
	const inList = hashes.map((h) => `'${h}'`).join(",");
	// Spawned through wranglerArgv(), not `bunx`: this query contains spaces,
	// and under Workers Builds' bun `bunx` splits them, so it failed there every
	// time and fell back to "D1 has nothing" — re-uploading the whole store
	// while the OR IGNORE inserts deduplicated it at the far end. The rows were
	// right; the bytes on the wire were not. `--file` is not an alternative
	// here: that path returns execution statistics rather than rows.
	const proc = Bun.spawn(
		[
			...wranglerArgv(),
			"d1",
			"execute",
			d1Name,
			"--remote",
			"-y",
			"--json",
			"-c",
			"wrangler.jsonc",
			"--command",
			`SELECT hash FROM store_blobs WHERE hash IN (${inList})`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((await proc.exited) !== 0) {
		console.warn(
			`Could not ask D1 which chunks it has (uploading all of them): ${(err.trim() || out.trim()).split("\n").slice(-2).join(" ")}`,
		);
		return [];
	}
	try {
		const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results?: { hash: string }[] }[];
		return (parsed[0]?.results ?? []).map((r) => r.hash);
	} catch {
		console.warn("Could not parse D1's chunk list (uploading all of them).");
		return [];
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

// ── 1. store chunks — only the ones D1 does not already hold ─────────────────
{
	const schemaPath = `${dir}/seed-remote-schema.sql`;
	await Bun.write(
		schemaPath,
		[
			"CREATE TABLE IF NOT EXISTS store_blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);",
			"CREATE TABLE IF NOT EXISTS store_manifest (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);",
			"CREATE TABLE IF NOT EXISTS store_history (store_key TEXT PRIMARY KEY, published_at INTEGER NOT NULL);",
			// Carries each published version's chunk list, so pruning can tell
			// which blobs are still referenced. store_history stays alongside it
			// as the ordering both publishers agree on.
			"CREATE TABLE IF NOT EXISTS store_versions (store_key TEXT PRIMARY KEY, published_at INTEGER NOT NULL, json TEXT NOT NULL);",
			// Legacy seq-indexed chunks. Still created so the prune below can
			// drain it on a database that predates content addressing, and so a
			// fresh one does not fail on a missing table.
			"CREATE TABLE IF NOT EXISTS store_chunks (store_key TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (store_key, seq));",
		].join("\n"),
	);
	await execRemote(schemaPath);

	// Ask D1 which of this store's chunks it already has. One statement: ~1.8k
	// hashes at 12 chars is ~27KB of IN-list, well inside the 100,000-byte
	// statement limit that sizes everything else here.
	const unique = [...new Set(chunkHashes)];
	const present = new Set(await existingHashes(unique));
	const missing = unique.filter((h) => !present.has(h));
	const reused = unique.length - missing.length;
	console.log(
		`Store ${manifest.store_key}: ${unique.length} chunks, ${reused} already in D1 (${((100 * reused) / unique.length).toFixed(1)}% reused), ${missing.length} to upload.`,
	);

	if (missing.length > 0) {
		const byHash = new Map(chunkHashes.map((h, i) => [h, chunkBytes[i] as Uint8Array]));
		function* blobStatements(): Generator<string> {
			for (const hash of missing) {
				// OR IGNORE, not plain INSERT: a previous attempt may have landed
				// this blob after its SQL file was written but before the run died,
				// and identical content under the same hash makes a retry a no-op
				// rather than a UNIQUE violation nothing can clear.
				yield `INSERT OR IGNORE INTO store_blobs (hash, bytes) VALUES ('${hash}', X'${hex(byHash.get(hash) as Uint8Array)}');`;
			}
		}
		for (const path of await writeSqlFiles("seed-remote-chunks", blobStatements())) {
			await execRemote(path);
		}
	} else {
		console.log("Nothing to upload — D1 already holds every chunk of this store.");
	}
}

// ── 2. the commit point: history + manifest — the site goes live here ────────
{
	const path = `${dir}/seed-remote-manifest.sql`;
	const json = sqlEscape(JSON.stringify(manifest));
	await Bun.write(
		path,
		[
			`INSERT OR REPLACE INTO store_history (store_key, published_at) VALUES ('${sqlEscape(manifest.store_key)}', ${Date.now()});`,
			`INSERT OR REPLACE INTO store_versions (store_key, published_at, json) VALUES ('${sqlEscape(manifest.store_key)}', ${Date.now()}, '${json}');`,
			`INSERT OR REPLACE INTO store_manifest (id, json) VALUES (1, '${json}');`,
		].join("\n"),
	);
	await execRemote(path);
	console.log(`Manifest live: ${manifest.store_key} — the site now serves.`);
}

// ── 3. prune superseded store versions ───────────────────────────────────────
//
// Without this D1 grows by a whole store (~75MB) per publish and never shrinks.
// Observed on a real deployment going 75MB → 150MB across two builds, against
// the FREE plan's 500MB database ceiling — roughly six more deploys before
// publishes fail.
//
// A blob survives while ANY kept version still lists it, which is what makes
// sharing safe: the chunks this store has in common with its predecessor are
// one set of rows with two referents, and dropping the predecessor must not
// take them with it.
//
// The legacy seq-indexed store_chunks table is drained on the same schedule.
// Its rows belong to versions published before content addressing, so they
// fall out naturally as those versions age past KEEP_STORES — never sooner,
// because an isolate mid-swap may still be reading one of them.
//
// Runs AFTER the manifest is live, so a failure here leaves a serving site with
// some extra rows, never a live manifest pointing at pruned chunks.
{
	const path = `${dir}/seed-remote-prune.sql`;
	const keep = `SELECT store_key FROM store_history ORDER BY published_at DESC LIMIT ${KEEP_STORES}`;
	await Bun.write(
		path,
		[
			`DELETE FROM store_versions WHERE store_key NOT IN (${keep});`,
			"DELETE FROM store_blobs WHERE hash NOT IN (SELECT je.value FROM store_versions v, json_each(v.json, '$.chunks') je);",
			`DELETE FROM store_chunks WHERE store_key NOT IN (${keep});`,
			`DELETE FROM store_history WHERE store_key NOT IN (${keep});`,
		].join("\n"),
	);
	await execRemote(path);
	console.log(`Pruned store versions beyond the ${KEEP_STORES} most recent.`);
}

// ── 4. optional: the SQL-fallback cards table ────────────────────────────────
if (!withCards) {
	reportD1Cost("store only");
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
reportD1Cost("store + cards");
console.log("Done: store live + SQL-fallback cards table complete.");
