// The card-names blob `/cards/autocomplete` answers from (backlog n8) — and, since format 2, the
// corpus-wide NAMES INDEX name-only `/cards/search` and `/cards/named?fuzzy=` ask ONE object with
// instead of every partition (backlog n15).
//
// WHY IT EXISTS. A partition's archive holds a tenth of the corpus's names, so autocomplete used to
// ask all N partition objects and merge their lists (partitioned-engine.ts mergeAutocomplete): N
// Durable Object calls per keystroke, answered when the slowest one replied. This blob is every
// served (collated, printed) name pair of the whole corpus — ~33,700 pairs, ~1.1MB raw and ~450KB
// gzipped — so ONE object can answer for everything (engine/wasm/src/names.rs, a line-for-line
// copy of the engine's own ranking).
//
// FORMAT 2 (n15) holds one RECORD per card of every partition instead — its partition, its names,
// the printing classes it and its flavor-name keys fall in (card_engine `NameRecord`) — so the same
// object can also say WHICH partitions a name lookup's answers live in. The served pairs are the
// records whose served bit is set, so autocomplete answers exactly as before.
//
// WHAT GOES IN is decided by the engine at build time, per partition (card_engine
// `names_index::name_records_of`, spelled by `name_records_tsv`). Both publishers hand those
// per-partition lines to `encodeCardNames` below, each led by its partition — the native builder
// through its `card-names.tsv` sidecar (scripts/seed-remote-kv.ts), which the builder writes led, the
// nightly through one staged emit per partition build (import-coordinator.ts), which the coordinator
// leads (`ledByPartition`) — so the two blobs are the same bytes by construction; the import harness
// checks it (scripts/import-harness/card-names-check.ts).
//
// WHERE IT LIVES: one KV value per build, `store:card-names-v<fmt>-<built_at>.store:0`, named by the
// manifest (`names_key`, with its stored length as `names_bytes`). Shaped like the routing filter's
// key so `staleStoreKeys` retires it with the rest of its generation. Engine objects cache it in their
// own SQLite beside their archive (store.ts autocompleteFromNames), so KV is read once per object per
// generation, never on a wake.

import { kvBytesMetadata } from "./kv-retention";
import { gzipBytes, KV_VALUE_CAP_BYTES } from "./store-kv";
import type { StoreManifest } from "./types";

/**
 * The blob's first line — engine/wasm/src/names.rs NAMES_BLOB_HEADER_V2. A reader refuses any it does
 * not know: an object on the build before n15 finds this one unreadable and autocomplete fans out
 * from it, and an object on this build reads a format-1 blob (a build published before n15) for
 * autocomplete alone, answering every name lookup by asking every partition.
 */
export const CARD_NAMES_HEADER = "sylvan-card-names/2\n";

/** Fields per record line: partition, flags, collated, printed, lower, folded, flavor keys. */
const RECORD_FIELDS = 7;

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

/**
 * Whether a filter tree COULD be a question for the names index (n15): AND/OR over `card_name`
 * comparisons, beside the router's `NOT is:<tag>` gate conjuncts. A cheap structural look at the wire
 * JSON, so a gather coordinator never waits on its own store (the index lives beside it) for a query
 * that is plainly not one — the engine's own compile (card_engine `NameQuery::of`) is what decides.
 */
export function mayBeNameOnly(filterTreeJson: string): boolean {
	let tree: unknown;
	try {
		tree = JSON.parse(filterTreeJson);
	} catch {
		return false;
	}
	let names = 0;
	const walk = (node: unknown, depth: number): boolean => {
		if (depth > 32 || node === null || typeof node !== "object") return false;
		const { node_type, kwargs } = node as { node_type?: string; kwargs?: Record<string, unknown> };
		if (node_type === "AndNode" || node_type === "OrNode") {
			const operands = kwargs?.operands;
			return Array.isArray(operands) && operands.length > 0 && operands.every((o) => walk(o, depth + 1));
		}
		if (node_type === "NotNode") {
			const inner = (kwargs?.operand ?? {}) as { kwargs?: { lhs?: { kwargs?: { attribute_name?: unknown } } } };
			return inner.kwargs?.lhs?.kwargs?.attribute_name === "card_is_tags";
		}
		if (node_type === "CardBinaryOperatorNode") {
			const lhs = (kwargs?.lhs ?? {}) as { kwargs?: { attribute_name?: unknown } };
			if (lhs.kwargs?.attribute_name !== "card_name") return false;
			names++;
			return true;
		}
		return false;
	};
	return walk(tree, 0) && names > 0;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const encoder = new TextEncoder();

/**
 * One partition's staged record lines, each led by `<partition>\t` — the lead the native builder
 * writes itself (engine/builder names.rs `partition_names_tsv`) and the nightly's build cannot, since
 * it never learns which partition it is building.
 */
export function ledByPartition(partition: number, lines: string): string {
	if (lines === "") return "";
	if (!lines.endsWith("\n")) throw new Error("card names: a partition's lines do not end in \\n");
	return lines
		.slice(0, -1)
		.split("\n")
		.map((line) => `${partition}\t${line}\n`)
		.join("");
}

/**
 * The raw blob from every partition's record lines (`card_engine::name_records_tsv`, each led by its
 * partition), in any order and with any repeats: the header, then each distinct line once, sorted.
 * THE one encoder both publishers use.
 *
 * Sorted so the bytes do not depend on the order partitions were built in — every reader reads the
 * records in any order — and deduplicated because a line is a whole record, and two identical
 * records in one partition answer every question identically. A line that is not seven tab-separated
 * fields is refused: the reader would refuse the whole blob.
 */
export function encodeCardNames(parts: Iterable<Uint8Array>): Uint8Array {
	const lines = new Set<string>();
	for (const part of parts) {
		const text = utf8.decode(part);
		if (text.length > 0 && !text.endsWith("\n")) throw new Error("card names: a partition's lines do not end in \\n");
		for (const line of text.split("\n")) {
			if (line === "") continue;
			if (line.split("\t").length !== RECORD_FIELDS || line.includes("\r")) {
				throw new Error(`card names: malformed line ${JSON.stringify(line.slice(0, 80))}`);
			}
			lines.add(line);
		}
	}
	const sorted = [...lines].sort();
	return encoder.encode(CARD_NAMES_HEADER + sorted.map((l) => `${l}\n`).join(""));
}

/** How many records a raw blob holds (its lines after the header). */
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
