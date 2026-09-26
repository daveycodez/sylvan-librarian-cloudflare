// The printed-names blob (backlog x24): every card's foreign printed names, cut to what an ASCII
// query word can match, so ONE object can settle the one `/cards/named?fuzzy=` rule the names index
// (card-names.ts) cannot — containment's printed tier, where each word lands in a printed name or in
// its card's oracle name (`red goad` is Unmoored Ego through the Portuguese "Ego à Deriva").
//
// WHY IT EXISTS. Without it the fuzzy plan (engine/wasm/src/names.rs `fuzzy_plan`) had to answer
// `everywhere` for every needle no English name settles — every miss, and mtg-seeker sends its whole
// seek sentence through fuzzy= first on every seek — so each one asked all N partitions. With it the
// plan names the partitions holding a printed name that completes the words, and none for a
// sentence: the 404 from the plan's own object, one call.
//
// WHY ITS OWN BLOB, not rows of the names blob: every partition object caches the names blob in its
// SQLite (the pool gate counts it per object, import-budget.ts partitionCacheBytes); this is ~2.4x its
// size and read only by an object planning a needle that reaches the printed tier. Such an object
// loads it from KV into its wasm instance and keeps it there for the build — never into SQLite, so it
// costs the pool nothing (store.ts `printedPartitions`).
//
// WHAT GOES IN is decided by the engine at build time, per partition (card_engine
// `names_index::printed_records_of`, spelled by `printed_records_tsv`). Both publishers hand those
// per-partition lines to `encodePrintedNames` below, each led by its partition — the native builder
// through its `printed-names.tsv` sidecar (scripts/printed-names-build.ts), which the builder writes
// led, the nightly through one staged emit per partition build (import-coordinator.ts), which the
// coordinator leads (`ledByPartition`) — so the two blobs are the same bytes by construction; the
// import harness checks it (scripts/import-harness/printed-names-check.ts).
//
// WHERE IT LIVES: one KV value per build, `store:card-printed-v<fmt>-<built_at>.store:0`
// (generationKey), named by the manifest (`printed_key`, with its stored length as `printed_bytes`),
// so retention keeps and retires it with its build.

import { generationKey, kvBytesMetadata } from "./kv-retention";
import { gzipBytes, KV_VALUE_CAP_BYTES } from "./store-kv";
import type { StoreManifest } from "./types";

/** The blob's first line — engine/wasm/src/printed.rs PRINTED_BLOB_HEADER. A reader refuses any other. */
export const PRINTED_NAMES_HEADER = "sylvan-printed-names/1\n";

/** The printed-names blob of one build: `store:card-printed-v<fmt>-<built_at>.store:0`. */
export function printedNamesKey(formatVersion: number, builtAt: string): string {
	return generationKey("printed", formatVersion, builtAt);
}

/**
 * The manifest's printed-names blob, or null when it names none — a store published before x24, or
 * by a publisher that could not build one — in which case the fuzzy plan asks every partition for
 * the printed tier, as it always did. Read-tolerant: a malformed pair of fields is "none".
 */
export function printedNamesOf(manifest: StoreManifest | null | undefined): { key: string; bytes: number } | null {
	const key = manifest?.printed_key;
	const bytes = manifest?.printed_bytes;
	if (typeof key !== "string" || !key.startsWith("store:card-printed-")) return null;
	if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return null;
	return { key, bytes };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const encoder = new TextEncoder();

/**
 * The raw blob from every partition's record lines (`card_engine::printed_records_tsv`, each led by
 * its partition), in any order and with any repeats: the header, then each distinct line once,
 * sorted — THE one encoder both publishers use, so the bytes do not depend on build order. A line
 * that is not a partition, an oracle name and at least one printed form (ASCII alphanumerics and
 * spaces) is refused: the reader would refuse the whole blob.
 */
export function encodePrintedNames(parts: Iterable<Uint8Array>): Uint8Array {
	const lines = new Set<string>();
	for (const part of parts) {
		const text = utf8.decode(part);
		if (text.length > 0 && !text.endsWith("\n"))
			throw new Error("printed names: a partition's lines do not end in \\n");
		for (const line of text.split("\n")) {
			if (line === "") continue;
			const fields = line.split("\t");
			const printed = fields.slice(2);
			if (
				!/^\d+$/.test(fields[0] ?? "") ||
				fields.length < 3 ||
				line.includes("\r") ||
				!printed.every((f) => /^[a-z0-9]+(?: [a-z0-9]+)*$/i.test(f))
			) {
				throw new Error(`printed names: malformed line ${JSON.stringify(line.slice(0, 80))}`);
			}
			lines.add(line);
		}
	}
	const sorted = [...lines].sort();
	return encoder.encode(PRINTED_NAMES_HEADER + sorted.map((l) => `${l}\n`).join(""));
}

/** How many cards (lines after the header) a raw blob holds. */
export function printedNamesCount(raw: Uint8Array): number {
	let n = 0;
	for (const b of raw) if (b === 10) n++;
	return Math.max(0, n - 1);
}

/**
 * Publish a build's printed-names blob to KV, gzipped (as every reader holds it), and say what the
 * manifest records. Not gated on the manifest: it goes up before the manifest names it, and a blob
 * for a build that never publishes is a key nobody names, swept with its family.
 */
export async function writePrintedNames(
	kv: KVNamespace,
	formatVersion: number,
	builtAt: string,
	raw: Uint8Array,
): Promise<{ key: string; bytes: number; raw: number; count: number }> {
	const stored = await gzipBytes(raw);
	if (stored.byteLength > KV_VALUE_CAP_BYTES) {
		throw new Error(
			`printed names blob is ${stored.byteLength} bytes gzipped, over the ${KV_VALUE_CAP_BYTES} KV value cap`,
		);
	}
	const key = printedNamesKey(formatVersion, builtAt);
	await kv.put(key, stored, { metadata: kvBytesMetadata(stored.byteLength) });
	return { key, bytes: stored.byteLength, raw: raw.byteLength, count: printedNamesCount(raw) };
}
