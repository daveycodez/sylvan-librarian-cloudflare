// The card-names blob `/cards/autocomplete` answers from (backlog n8).
//
// WHY IT EXISTS. A partition's archive holds a tenth of the corpus's names, so autocomplete used to
// ask all N partition objects and merge their lists (partitioned-engine.ts mergeAutocomplete): N
// Durable Object calls per keystroke, answered when the slowest one replied. This blob is every
// served (collated, printed) name pair of the whole corpus — ~33,700 pairs, ~1.1MB raw and ~450KB
// gzipped today — so ONE object can answer for everything (engine/wasm/src/names.rs, a line-for-line
// copy of the engine's own ranking).
//
// WHAT GOES IN is decided by the engine at build time, per partition (card_engine
// `autocomplete_names_of`: the first row of each oracle group's name, kept iff any canonical printing
// is served). Both publishers hand those per-partition lines to `encodeCardNames` below — the native
// builder through its `card-names.tsv` sidecar (scripts/seed-remote-kv.ts), the nightly through one
// staged emit per partition build (import-coordinator.ts) — so the two blobs are the same bytes by
// construction; the import harness checks it (scripts/import-harness/card-names-check.ts).
//
// WHERE IT LIVES: one KV value per build, `store:card-names-v<fmt>-<built_at>.store:0`, named by the
// manifest (`names_key`, with its stored length as `names_bytes`). Shaped like the routing filter's
// key so `staleStoreKeys` retires it with the rest of its generation. Engine objects cache it in their
// own SQLite beside their archive (store.ts autocompleteFromNames), so KV is read once per object per
// generation, never on a wake.

import { kvBytesMetadata } from "./kv-retention";
import { gzipBytes, KV_VALUE_CAP_BYTES } from "./store-kv";
import type { StoreManifest } from "./types";

/** The blob's first line — engine/wasm/src/names.rs NAMES_BLOB_HEADER; a reader refuses any other. */
export const CARD_NAMES_HEADER = "sylvan-card-names/1\n";

/** The names blob of one build: `store:card-names-v<fmt>-<built_at>.store:0`. */
export function cardNamesKey(formatVersion: number, builtAt: string): string {
	return `store:card-names-v${formatVersion}-${builtAt}.store:0`;
}

/**
 * The manifest's names blob, or null when it names none — a store published before n8, or by a
 * publisher that could not build one — in which case autocomplete fans out as it always did.
 * Read-tolerant: a malformed pair of fields is "none", never an error.
 */
export function cardNamesOf(manifest: StoreManifest | null | undefined): { key: string; bytes: number } | null {
	const key = manifest?.names_key;
	const bytes = manifest?.names_bytes;
	if (typeof key !== "string" || !key.startsWith("store:card-names-")) return null;
	if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return null;
	return { key, bytes };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const encoder = new TextEncoder();

/**
 * The raw blob from every partition's `<collated>\t<printed>\n` lines, in any order and with any
 * repeats: the header, then each distinct line once, sorted. THE one encoder both publishers use.
 *
 * Sorted so the bytes do not depend on the partition count or the order partitions were built in —
 * the ranking itself reads the list in any order (it sorts its hits) — and deduplicated because two
 * partitions can hold two cards that share a printed name. A line that is not exactly one tab
 * between two tab-free strings is refused: the reader would refuse the whole blob.
 */
export function encodeCardNames(parts: Iterable<Uint8Array>): Uint8Array {
	const lines = new Set<string>();
	for (const part of parts) {
		const text = utf8.decode(part);
		if (text.length > 0 && !text.endsWith("\n")) throw new Error("card names: a partition's lines do not end in \\n");
		for (const line of text.split("\n")) {
			if (line === "") continue;
			const tab = line.indexOf("\t");
			if (tab < 0 || line.indexOf("\t", tab + 1) >= 0 || line.includes("\r")) {
				throw new Error(`card names: malformed line ${JSON.stringify(line.slice(0, 80))}`);
			}
			lines.add(line);
		}
	}
	const sorted = [...lines].sort();
	return encoder.encode(CARD_NAMES_HEADER + sorted.map((l) => `${l}\n`).join(""));
}

/** How many pairs a raw blob holds (its lines after the header). */
export function cardNamesCount(raw: Uint8Array): number {
	let n = 0;
	for (const b of raw) if (b === 10) n++;
	return Math.max(0, n - 1);
}

/**
 * Publish a build's names blob to KV, gzipped (as every reader and the object caches hold it), and
 * say what the manifest records. Deliberately NOT gated on the manifest, like the routing filter: it
 * goes up before the manifest names it, and a blob for a build that never publishes is a key nobody
 * names, swept with its family.
 */
export async function writeCardNames(
	kv: KVNamespace,
	formatVersion: number,
	builtAt: string,
	raw: Uint8Array,
): Promise<{ key: string; bytes: number; raw: number; count: number }> {
	const stored = await gzipBytes(raw);
	if (stored.byteLength > KV_VALUE_CAP_BYTES) {
		throw new Error(
			`card names blob is ${stored.byteLength} bytes gzipped, over the ${KV_VALUE_CAP_BYTES} KV value cap`,
		);
	}
	const key = cardNamesKey(formatVersion, builtAt);
	// Sized metadata, like every family key (kv-retention.ts): the byte guard reads it off the list.
	await kv.put(key, stored, { metadata: kvBytesMetadata(stored.byteLength) });
	return { key, bytes: stored.byteLength, raw: raw.byteLength, count: cardNamesCount(raw) };
}
