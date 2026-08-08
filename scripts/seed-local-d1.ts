// Seed a natively-built store into LOCAL simulated D1, mirroring exactly what
// the ImportCoordinator's publish phase writes (chunks → history → manifest).
//
//   bun scripts/seed-local-d1.ts <store-build-dir>
//
// The store file and manifest.json come from `sylvan-store-builder --out`.

import { readFileSync } from "node:fs";

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

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sqlEscape = (s: string) => s.replace(/'/g, "''");

const statements: string[] = [
	"CREATE TABLE IF NOT EXISTS store_chunks (store_key TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (store_key, seq));",
	"CREATE TABLE IF NOT EXISTS store_manifest (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);",
	"CREATE TABLE IF NOT EXISTS store_history (store_key TEXT PRIMARY KEY, published_at INTEGER NOT NULL);",
	`DELETE FROM store_chunks WHERE store_key = '${sqlEscape(manifest.store_key)}';`,
];
for (let seq = 0; seq < chunkCount; seq++) {
	const chunk = store.subarray(seq * CHUNK_BYTES, Math.min((seq + 1) * CHUNK_BYTES, store.length));
	statements.push(
		`INSERT INTO store_chunks (store_key, seq, bytes) VALUES ('${sqlEscape(manifest.store_key)}', ${seq}, X'${hex(chunk)}');`,
	);
}
statements.push(
	`INSERT OR REPLACE INTO store_history (store_key, published_at) VALUES ('${sqlEscape(manifest.store_key)}', ${Date.now()});`,
	// Manifest LAST — the commit point, same ordering as the production publish.
	`INSERT OR REPLACE INTO store_manifest (id, json) VALUES (1, '${sqlEscape(JSON.stringify(manifest))}');`,
);

const sqlPath = `${dir}/seed-local.sql`;
await Bun.write(sqlPath, statements.join("\n"));
console.error(`Wrote ${sqlPath} (${chunkCount} chunks); executing against local D1...`);

const proc = Bun.spawn(
	["bunx", "wrangler", "d1", "execute", "sylvan-librarian", "--local", "-c", "wrangler.dev.jsonc", "--file", sqlPath],
	{ stdout: "inherit", stderr: "inherit" },
);
process.exit(await proc.exited);
