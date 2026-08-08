// Seed a natively-built store into LOCAL simulated D1, mirroring exactly what
// the ImportCoordinator's publish phase writes (chunks → history → manifest)
// PLUS the cards phase (the SQL-fallback `cards` table + fallback_meta), so a
// native seed leaves local dev as complete as the full DO import would.
//
//   bun scripts/seed-local-d1.ts <store-build-dir>
//
// The store file, manifest.json, and rows.jsonl come from
// `sylvan-store-builder --out`.
//
// Writes DIRECTLY into miniflare's local D1 SQLite file (bun:sqlite): local
// D1 is a plain SQLite database on disk, and `wrangler d1 execute --file`
// takes tens of minutes to push ~180MB of data through its SQL parser while
// a direct transactional write takes seconds. Dev-only tooling by
// construction — production publishing is the ImportCoordinator's job. Run
// while `wrangler dev` is STOPPED (dev.sh seeds before starting it); SQLite
// locking protects against corruption either way.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { cardsRowValues, structuralHash } from "../src/fallback/cards-sync";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: bun scripts/seed-local-d1.ts <store-build-dir>");
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

// Same chunk size the wasm import publishes (engine/wasm-import CHUNK_BYTES).
const CHUNK_BYTES = 900_000;
const chunkCount = Math.ceil(store.length / CHUNK_BYTES);
(manifest as Record<string, unknown>).chunk_count = chunkCount;

/** Locate miniflare's SQLite file for the one D1 binding; boot it if absent. */
async function localD1Path(): Promise<string> {
	const d1Dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
	// The database file is named by a 64-hex id; metadata.sqlite is
	// miniflare's own bookkeeping, not the D1 database.
	const find = () => {
		try {
			return readdirSync(d1Dir).filter((f) => /^[0-9a-f]{64}\.sqlite$/.test(f));
		} catch {
			return [];
		}
	};
	let files = find();
	if (files.length === 0) {
		// Fresh checkout: let wrangler materialize the database file once.
		const proc = Bun.spawn(
			[
				"bunx",
				"wrangler",
				"d1",
				"execute",
				"sylvan-librarian",
				"--local",
				"-c",
				"wrangler.dev.jsonc",
				"--command",
				"SELECT 1",
			],
			{ stdout: "ignore", stderr: "inherit" },
		);
		if ((await proc.exited) !== 0) process.exit(1);
		files = find();
	}
	if (files.length !== 1) {
		throw new Error(`expected exactly one local D1 database in ${d1Dir}, found ${files.length}`);
	}
	return `${d1Dir}/${files[0]}`;
}

const dbPath = await localD1Path();
console.error(`Seeding ${dbPath} directly...`);
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");

// ── store: chunks → history → manifest (manifest last = the commit point) ────
db.exec(`CREATE TABLE IF NOT EXISTS store_chunks (store_key TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (store_key, seq));
CREATE TABLE IF NOT EXISTS store_manifest (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS store_history (store_key TEXT PRIMARY KEY, published_at INTEGER NOT NULL);`);

db.transaction(() => {
	db.run("DELETE FROM store_chunks WHERE store_key = ?", [manifest.store_key]);
	const insertChunk = db.prepare("INSERT INTO store_chunks (store_key, seq, bytes) VALUES (?, ?, ?)");
	for (let seq = 0; seq < chunkCount; seq++) {
		insertChunk.run(
			manifest.store_key,
			seq,
			store.subarray(seq * CHUNK_BYTES, Math.min((seq + 1) * CHUNK_BYTES, store.length)),
		);
	}
	db.run("INSERT OR REPLACE INTO store_history (store_key, published_at) VALUES (?, ?)", [
		manifest.store_key,
		Date.now(),
	]);
	db.run("INSERT OR REPLACE INTO store_manifest (id, json) VALUES (1, ?)", [JSON.stringify(manifest)]);
})();
console.error(`Store seeded: ${manifest.store_key} (${chunkCount} chunks).`);

// ── cards: the SQL-fallback table, from the rows the builder teed out ────────
// Same cardsRowValues/structuralHash derivations the production cards phase
// applies, so local dev serves the fallback path too, marked complete.
const rowsPath = `${dir}/rows.jsonl`;
let rowsText = "";
try {
	rowsText = readFileSync(rowsPath, "utf8");
} catch {
	console.error(`No ${rowsPath} (older build?) — skipping the SQL-fallback cards table.`);
	console.error("Rebuild without --reuse to seed it.");
	process.exit(0);
}

const bindVal = (v: unknown): string | number | null => {
	if (v === null || v === undefined) return null;
	if (typeof v === "number") return v;
	// Objects/arrays are the JSON-typed columns — stored as JSON text.
	return typeof v === "object" ? JSON.stringify(v) : String(v);
};

let totalRows = 0;
let columns: string[] = [];
let insertCard: ReturnType<Database["prepare"]> | null = null;
db.transaction(() => {
	for (const line of rowsText.split("\n")) {
		if (!line) continue;
		const row = JSON.parse(line) as Record<string, unknown>;
		const values = cardsRowValues(row, structuralHash(row));
		if (!insertCard) {
			columns = Object.keys(values);
			// Same schema as ensureCardsSchema (no secondary indexes), fresh table.
			db.exec(
				`CREATE TABLE IF NOT EXISTS cards (${columns.map((c) => (c === "scryfall_id" ? `${c} TEXT PRIMARY KEY` : c)).join(", ")});
CREATE TABLE IF NOT EXISTS fallback_meta (id INTEGER PRIMARY KEY CHECK (id = 1), store_key TEXT NOT NULL, complete INTEGER NOT NULL, synced_rows INTEGER NOT NULL);
DELETE FROM cards;`,
			);
			insertCard = db.prepare(
				`INSERT OR REPLACE INTO cards (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
			);
		}
		insertCard.run(...columns.map((c) => bindVal(values[c])));
		totalRows++;
	}
	if (totalRows > 0) {
		db.run("INSERT OR REPLACE INTO fallback_meta (id, store_key, complete, synced_rows) VALUES (1, ?, 1, ?)", [
			manifest.store_key,
			totalRows,
		]);
	}
})();
db.close();
console.error(
	totalRows > 0
		? `Seeded ${totalRows} cards rows; SQL fallback marked complete.`
		: `${rowsPath} is empty — SQL-fallback cards table not seeded.`,
);
