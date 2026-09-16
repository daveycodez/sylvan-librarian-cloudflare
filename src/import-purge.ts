/**
 * Staging purges, sliced: what one alarm may delete and in what order.
 *
 * The coordinator's staging tables hold rows of up to 1.9MB, and a partition's
 * worth of them is ~300MB across four tables. Until 2026-09-16 the partition's
 * publish completion deleted all of it in ONE transactionSync, and the next
 * alarm's first awaited storage read stalled behind that commit's flush — for
 * hours, until a deploy reset the object. That was the whole Durable Object
 * duration bill on the free account (an object stays billed while any I/O is
 * pending; 92% of the 13,000 GB-s/day cap on 2026-09-15), and it is why a
 * nightly run took days: one partition per reset.
 *
 * The one commit size production has proven safe is the bucket phase's: 64
 * draft batches of ~1.9MB deleted alongside its inserts, ~120MB, every slice
 * of every run. PURGE_SLICE_BYTES is under a third of that. Every purge — the
 * partition's, the wasm rewind's, and the run-start reset's — goes through the
 * same slice, one bounded transaction per alarm, so no commit anywhere in the
 * import frees more pages than the bucket phase already does.
 *
 * Pure: the plan is a function of the head rows a slice reads, so a test can
 * pin it without SQLite, and the SQL itself is mirrored in
 * tests/import/purge-slice.test.ts against bun:sqlite with real-sized blobs.
 */

/**
 * `blobs` is the progressive purge at a phase boundary: ONE table and the dump
 * kinds a phase was the last consumer of (stage_blobs' raw all_cards after
 * recode, ~390MB — while its recoded stage_members are what transform reads
 * next; stage_blobs' default_cards after canonical; stage_members' all_cards
 * after transform, ~400MB; stage_blobs' tag and label dumps after tags), named
 * in the `purge_table` and `purge_kinds` meta rows, with `purge_next` naming
 * the phase that follows.
 * Each of those used to be one `DELETE ... WHERE kind = ?` in the phase's
 * closing transaction — the same commit shape that wedged the partition loop,
 * and on 2026-09-16 the DeckGen coordinator sat wedged behind the recode one.
 */
export type PurgeScope = "reset" | "partition" | "rewind" | "blobs";

export interface PurgeTable {
	/** A staging table with a `bytes BLOB` column (every one of them has it). */
	table: string;
	/** The column a slice orders and cuts on: the table's primary key, or its tail. */
	key: string;
	/**
	 * A leading key column the slice is confined to, for composite keys.
	 * `partition`: draft_parts (partition, seq) — the partition scope supplies
	 * the value, the reset scope discovers the lowest one present. `kind`:
	 * stage_blobs / stage_members (kind, seq) — always discovered. Without it,
	 * `key <= cut` on a composite key would sweep rows the plan never priced.
	 */
	scope?: "partition" | "kind";
}

/**
 * What each scope retires, smallest tables first so the next consumer's
 * inputs clear soonest and the biggest family (draft_parts, ~180MB per
 * partition) is last.
 *
 * `reset` is everything a previous run could have left behind — a healthy run
 * leaves all of these empty, so a reset is one alarm; a run that died mid-way
 * pays the slices its leftovers cost, once. stage_files and recode_checkpoint
 * are a handful of tiny rows and are cleared inline at run start.
 */
export const PURGE_TABLES: Record<PurgeScope, readonly PurgeTable[]> = {
	partition: [
		{ table: "chunk_staging", key: "seq" },
		{ table: "ordered_rows", key: "base" },
		{ table: "spill_batches", key: "base" },
		{ table: "draft_parts", key: "seq", scope: "partition" },
	],
	rewind: [
		{ table: "ordered_rows", key: "base" },
		{ table: "spill_batches", key: "base" },
	],
	blobs: [
		{ table: "stage_blobs", key: "seq", scope: "kind" },
		{ table: "stage_members", key: "seq", scope: "kind" },
	],
	reset: [
		{ table: "chunk_staging", key: "seq" },
		{ table: "ordered_rows", key: "base" },
		{ table: "spill_batches", key: "base" },
		{ table: "routing_keys", key: "seq" },
		{ table: "tagdata_blobs", key: "seq" },
		{ table: "draft_parts", key: "seq", scope: "partition" },
		{ table: "draft_batches", key: "seq" },
		{ table: "stage_members", key: "seq", scope: "kind" },
		{ table: "stage_blobs", key: "seq", scope: "kind" },
	],
};

export interface PurgePlan {
	/** Delete every row whose key is <= this (the head rows are in key order). */
	upTo: number;
	rows: number;
	bytes: number;
}

/**
 * How far one slice deletes: the head rows in key order until their bytes
 * reach the budget — and ALWAYS at least one row, so a single row larger than
 * the budget still goes rather than stalling the purge forever. Null means the
 * table (or the scoped part of it) is already empty.
 */
export function planPurgeSlice(rows: readonly { key: number; bytes: number }[], budgetBytes: number): PurgePlan | null {
	if (rows.length === 0) return null;
	let upTo = rows[0]?.key ?? 0;
	let total = 0;
	let n = 0;
	for (const row of rows) {
		if (n > 0 && total >= budgetBytes) break;
		upTo = row.key;
		total += row.bytes;
		n += 1;
	}
	return { upTo, rows: n, bytes: total };
}
