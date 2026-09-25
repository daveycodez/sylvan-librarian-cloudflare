// Spill codec + the reorder that makes the store build fit a 30s alarm.
//
// The store build consumes rows in card-sort order. Finalize can only write
// them in add order, because the sort key of the last row is not known until
// every row is in. Serving the build an arbitrary add-index therefore meant a
// random seek per row — 97,802 `substr` lookups, measured at 15.0s of a 17.4s
// build, roughly 60s on an edge core against a 30s ceiling.
//
// So the permutation is fetched from wasm up front and the spill is rewritten
// once to match it (`reorderSlice`), after which the build reads straight
// through (`orderedRowCursor`).
//
// Split out of import-coordinator.ts so this is reachable from a test without
// a Durable Object: everything here is pure, taking blob readers as callbacks.
// The reorder is the one phase whose failure mode is a store that builds
// without error and is wrong, so it is the one phase that most needs tests.

/** Byte cap for a persisted blob group (safely under SQLite's 2MB value cap). */
export const BLOB_GROUP_BYTES = 1_500_000;

/**
 * Raw bytes per staged DRAFT group: a draft_batches row (transform) and a draft_parts row (bucket).
 *
 * Four times BLOB_GROUP_BYTES because those rows are stored PACKED (import-blob-codec.ts): drafts
 * deflate ~7x, so a 1.5MB-raw group was a ~0.2MB row, and every draft cost ~4x the rows it needed —
 * inserted by transform, deleted by bucket, re-inserted and purged per partition. Rows written are
 * the free plan's tightest meter (100k/day). 6MB raw is ~0.9MB packed at the real corpus's ratio;
 * a group that packs past STAGED_ROW_BYTES anyway is re-cut at BLOB_GROUP_BYTES by its writer
 * (packedDraftGroups), so no ratio can reach SQLite's 2MB value cap. Wasm is still fed at most
 * BLOB_GROUP_BYTES per call (feedSlices).
 */
export const DRAFT_BATCH_BYTES = 6_000_000;

/** The most a packed staged row may hold: just under the Durable Object's 2MB value cap. */
export const STAGED_ROW_BYTES = 1_900_000;

export function lengthPrefixed(blobs: Uint8Array[]): Uint8Array {
	const total = blobs.reduce((n, b) => n + 4 + b.length, 0);
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	let at = 0;
	for (const b of blobs) {
		dv.setUint32(at, b.length, true);
		out.set(b, at + 4);
		at += 4 + b.length;
	}
	return out;
}

export function splitBatch(batch: Uint8Array): Uint8Array[] {
	const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
	const out: Uint8Array[] = [];
	let at = 0;
	while (at < batch.length) {
		const len = dv.getUint32(at, true);
		out.push(batch.subarray(at + 4, at + 4 + len));
		at += 4 + len;
	}
	return out;
}

/** Coerce a SQLite blob column to bytes. `substr()` over a BLOB yields a BLOB,
 * but a silently different representation here would feed the store builder
 * garbage rather than failing, so unknown shapes are an error. */
export function blobBytes(value: unknown): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		const v = value as ArrayBufferView;
		return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	}
	throw new Error(`spill lookup returned unexpected blob type ${typeof value}`);
}

/** Copy to an exact ArrayBuffer: SQL blob params must not be views. */
export function exactBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}

/** Split blobs into groups whose length-prefixed encoding stays under the cap. */
export function blobGroups(blobs: Uint8Array[], cap: number = BLOB_GROUP_BYTES): Uint8Array[][] {
	const groups: Uint8Array[][] = [];
	let group: Uint8Array[] = [];
	let bytes = 0;
	for (const b of blobs) {
		if (group.length > 0 && bytes + 4 + b.length > cap) {
			groups.push(group);
			group = [];
			bytes = 0;
		}
		group.push(b);
		bytes += 4 + b.length;
	}
	if (group.length > 0) groups.push(group);
	return groups;
}

// ─── draft partition hashes ──────────────────────────────────────────────────
//
// The transform emits every draft framed [u64 le fnv1a64(oracle_id)][RowDraft
// JSON] (engine/wasm-import protocol, emit kind 2). The hash — not a partition
// index — because partition_count is chosen by the BUILDER after transform
// (auto-scaled, plan Decision 3b): the draft carries the N-generic fact,
// computed once in Rust, and whoever groups drafts later mods it by the N it
// actually picked. draft_batches persists the hashes as a parallel BLOB vector
// (`part_hashes`, count × 8 bytes le, i-th entry belonging to the batch's i-th
// length-prefixed draft) rather than a column per draft: one draft per row
// would spend 540k row writes against the 100k/day Durable Object budget, and
// SQLite INTEGER is a signed i64 the storage bindings cannot carry a u64
// through undamaged.

/** Bytes of the partition-hash prefix on an EMIT_DRAFT payload. */
export const DRAFT_HASH_BYTES = 8;

/** Split one EMIT_DRAFT payload into its partition hash and the RowDraft JSON. */
export function splitDraftEmit(payload: Uint8Array): { partHash: bigint; draft: Uint8Array } {
	if (payload.length < DRAFT_HASH_BYTES) {
		throw new Error(`draft emit is ${payload.length} bytes — shorter than its hash prefix`);
	}
	const dv = new DataView(payload.buffer, payload.byteOffset, DRAFT_HASH_BYTES);
	return { partHash: dv.getBigUint64(0, true), draft: payload.subarray(DRAFT_HASH_BYTES) };
}

/** Pack per-draft hashes into the `part_hashes` column form (count × 8 bytes le). */
export function packPartHashes(hashes: readonly bigint[]): Uint8Array {
	const out = new Uint8Array(hashes.length * DRAFT_HASH_BYTES);
	const dv = new DataView(out.buffer);
	for (let i = 0; i < hashes.length; i++) dv.setBigUint64(i * DRAFT_HASH_BYTES, hashes[i] as bigint, true);
	return out;
}

export function unpackPartHashes(bytes: Uint8Array): bigint[] {
	if (bytes.length % DRAFT_HASH_BYTES !== 0) {
		throw new Error(`part_hashes blob is ${bytes.length} bytes — not a multiple of ${DRAFT_HASH_BYTES}`);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: bigint[] = [];
	for (let at = 0; at < bytes.length; at += DRAFT_HASH_BYTES) out.push(dv.getBigUint64(at, true));
	return out;
}

/**
 * The drafts belonging to partition `partition` of `partitionCount`, out of
 * draft_batches rows — re-modding the stored hash by the N the build chose.
 *
 * This is the enumeration the partitioned build loop (plan B3) runs once per
 * partition: `agg(p)` feeds exactly these drafts, in batch order, which is
 * emission order — the order the dedupe's first-seen/last-wins semantics
 * depend on. Yields views into each batch's bytes; callers that outlive the
 * batch must copy.
 */
export function* draftsForPartition(
	batches: Iterable<{ bytes: Uint8Array; partHashes: Uint8Array }>,
	partition: number,
	partitionCount: number,
): Generator<Uint8Array> {
	if (!Number.isInteger(partitionCount) || partitionCount <= 0) {
		throw new Error(`partitionCount must be a positive integer, got ${partitionCount}`);
	}
	const n = BigInt(partitionCount);
	const k = BigInt(partition);
	for (const batch of batches) {
		const drafts = splitBatch(batch.bytes);
		const hashes = unpackPartHashes(batch.partHashes);
		if (hashes.length !== drafts.length) {
			throw new Error(`draft batch holds ${drafts.length} drafts but ${hashes.length} hashes`);
		}
		for (let i = 0; i < drafts.length; i++) {
			if ((hashes[i] as bigint) % n === k) yield drafts[i] as Uint8Array;
		}
	}
}

/**
 * One draft batch split into its N partitions at once — `out[k]` is exactly what
 * `draftsForPartition([batch], k, N)` would yield, in the same order, for every k.
 *
 * The bucket phase runs this once over the whole staging, where the partition
 * loop used to run `draftsForPartition` N times over it: the same modulus, one
 * pass instead of N, and the (N-1)/N of every batch that a partition's own pass
 * decoded and discarded is instead handed to the partition it belongs to.
 * Views into the batch's bytes, like draftsForPartition; the caller writes them
 * out (length-prefixed, byte-capped) before the batch goes away.
 */
export function bucketDrafts(
	batch: { bytes: Uint8Array; partHashes: Uint8Array },
	partitionCount: number,
): Uint8Array[][] {
	if (!Number.isInteger(partitionCount) || partitionCount <= 0) {
		throw new Error(`partitionCount must be a positive integer, got ${partitionCount}`);
	}
	const drafts = splitBatch(batch.bytes);
	const hashes = unpackPartHashes(batch.partHashes);
	if (hashes.length !== drafts.length) {
		throw new Error(`draft batch holds ${drafts.length} drafts but ${hashes.length} hashes`);
	}
	const n = BigInt(partitionCount);
	const out: Uint8Array[][] = Array.from({ length: partitionCount }, () => []);
	for (let i = 0; i < drafts.length; i++) {
		(out[Number((hashes[i] as bigint) % n)] as Uint8Array[]).push(drafts[i] as Uint8Array);
	}
	return out;
}

/** Where every spilled row sits, by add-order index. */
export interface SpillIndex {
	/** `base` of the spill_batches group holding this row. */
	groupOf: number[];
	/** Byte offset of the row's payload within that group's blob. */
	offsetOf: number[];
	lengthOf: number[];
}

/**
 * Index one pass over the spill groups, which arrive keyed by the add-order
 * index of their first row (`base`) and hold length-prefixed rows from there.
 *
 * Only offsets are kept — ~2.4MB of packed arrays for a full corpus — so the
 * group bytes stay collectable as the scan moves past them.
 */
export function spillIndex(groups: Iterable<{ base: number; bytes: Uint8Array }>): SpillIndex {
	const groupOf: number[] = [];
	const offsetOf: number[] = [];
	const lengthOf: number[] = [];
	for (const { base, bytes } of groups) {
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let at = 0;
		let n = 0;
		while (at + 4 <= bytes.length) {
			const len = dv.getUint32(at, true);
			groupOf[base + n] = base;
			offsetOf[base + n] = at + 4;
			lengthOf[base + n] = len;
			at += 4 + len;
			n += 1;
		}
	}
	return { groupOf, offsetOf, lengthOf };
}

/**
 * The rows for build positions `[from, to)`, in build order.
 *
 * `order` is the add-order index per build position — the permutation
 * `build_store_stream` will pull in. Each spill group this slice needs is read
 * exactly once, via `readGroup`, rather than once per row.
 *
 * Rows are COPIED out of the group blob rather than viewed into it. A
 * `subarray` would keep its whole group's buffer reachable for as long as the
 * returned rows live, and since a slice's rows are spread across effectively
 * every group, that pins the entire spill (~30-48MB) in the isolate alongside
 * a wasm heap already holding ~90MB of interners. Copying caps the retained
 * set at this slice's own rows.
 */
export function reorderSlice(
	order: Uint32Array,
	index: SpillIndex,
	from: number,
	to: number,
	readGroup: (base: number) => Uint8Array | null,
): Uint8Array[] {
	const wanted = new Set<number>();
	for (let pos = from; pos < to; pos++) {
		const idx = order[pos] as number;
		const base = index.groupOf[idx];
		if (base === undefined) throw new Error(`reorder: build position ${pos} names unspilled row ${idx}`);
		wanted.add(base);
	}

	const rows = new Map<number, Uint8Array>();
	for (const base of [...wanted].sort((a, b) => a - b)) {
		const bytes = readGroup(base);
		if (!bytes) throw new Error(`reorder: spill group ${base} missing`);
		for (let pos = from; pos < to; pos++) {
			const idx = order[pos] as number;
			if (index.groupOf[idx] !== base) continue;
			const at = index.offsetOf[idx] as number;
			rows.set(pos, bytes.slice(at, at + (index.lengthOf[idx] as number)));
		}
	}

	const ordered: Uint8Array[] = [];
	for (let pos = from; pos < to; pos++) {
		const row = rows.get(pos);
		if (!row) throw new Error(`reorder: no spilled row for build position ${pos}`);
		ordered.push(row);
	}
	return ordered;
}

/** An ordered_rows group: length-prefixed rows for build positions from `base`. */
export interface OrderedGroup {
	base: number;
	bytes: Uint8Array;
}

/**
 * A `pullRow` handler over rows already rewritten in build order.
 *
 * The wasm build asks by add-order index; after the reorder those arrive in
 * exactly `order`'s sequence, so this is a cursor, not a lookup table — one
 * ordered blob resident at a time and an array index per row. `readFrom` hands
 * back the group covering a build position (the greatest `base` at or below
 * it), so a gap or a truncated table ends the stream rather than silently
 * serving the wrong row.
 *
 * The pulled index is still checked against `order`. Nothing downstream would
 * catch it if it drifted: `build_store_stream` verifies only the row COUNT,
 * and rows arriving out of order split a card's printings across non-adjacent
 * groups, producing an archive that serializes cleanly and is wrong. The check
 * costs one comparison per row and turns that into a thrown error.
 */
export function orderedRowCursor(
	order: Uint32Array,
	readFrom: (position: number) => OrderedGroup | null,
): (index: number) => Uint8Array | null {
	const staged = order.length;
	let cursor = 0;
	let held: Uint8Array[] = [];
	let heldFrom = -1;
	return (index: number): Uint8Array | null => {
		if (cursor >= staged) return null;
		if (index !== order[cursor]) {
			throw new Error(
				`build pulled row ${index} at build position ${cursor}, but the reorder wrote ${order[cursor]} there`,
			);
		}
		if (heldFrom < 0 || cursor >= heldFrom + held.length) {
			const next = readFrom(cursor);
			if (!next) return null;
			held = splitBatch(next.bytes);
			heldFrom = next.base;
			// A group that does not actually cover this position means the
			// rewrite is short or has a hole; stop rather than serve a
			// neighbouring row and let the count check downstream fail.
			if (cursor < heldFrom || cursor >= heldFrom + held.length) return null;
		}
		const row = held[cursor - heldFrom] as Uint8Array;
		cursor += 1;
		return row;
	};
}

/** One staged draft group: the drafts [start, end) of the caller's list, packed. */
export interface PackedDraftGroup {
	start: number;
	end: number;
	/** Length-prefixed raw bytes (the draft_batches `raw_len`). */
	raw: number;
	packed: Uint8Array;
}

/**
 * Drafts cut into staged groups of DRAFT_BATCH_BYTES raw, each packed. A group whose packed bytes
 * would pass STAGED_ROW_BYTES — drafts that compress under ~3.2x, which no corpus has come near —
 * is re-cut at BLOB_GROUP_BYTES, the size every group was before, whose packed form cannot reach
 * the cap. In draft order, covering every draft exactly once.
 */
export function packedDraftGroups(drafts: Uint8Array[], pack: (raw: Uint8Array) => Uint8Array): PackedDraftGroup[] {
	const out: PackedDraftGroup[] = [];
	let start = 0;
	for (const group of blobGroups(drafts, DRAFT_BATCH_BYTES)) {
		const raw = lengthPrefixed(group);
		const packed = pack(raw);
		if (packed.length <= STAGED_ROW_BYTES) {
			out.push({ start, end: start + group.length, raw: raw.length, packed });
			start += group.length;
			continue;
		}
		for (const sub of blobGroups(group, BLOB_GROUP_BYTES)) {
			const subRaw = lengthPrefixed(sub);
			out.push({ start, end: start + sub.length, raw: subRaw.length, packed: pack(subRaw) });
			start += sub.length;
		}
	}
	return out;
}

/**
 * The most one agg_drafts / finalize_drafts call is handed. Each call's input is allocated in the
 * group instance's linear memory, which never shrinks, while the aggregation state grows around
 * it — so a big input buffer leaves a big hole, and the store build that runs later in the same
 * instance inherits the high-water. Measured at 2x/3x the corpus (the build's worst partition):
 * 1.5MB feeds 101.4/109.1MB, 256KB feeds 96.9/104.4MB — below the 98.0/106.2MB of the 1.5MB
 * groups fed whole before 2026-09-25 — at the same CPU.
 */
export const WASM_FEED_BYTES = 256 * 1024;

/**
 * A length-prefixed batch cut at entry boundaries into views of at most `cap` bytes (an entry
 * larger than `cap` stands alone). Staged draft groups are up to DRAFT_BATCH_BYTES raw; wasm is fed
 * WASM_FEED_BYTES at a time. Views, not copies: the caller's batch stays the one resident copy.
 */
export function feedSlices(batch: Uint8Array, cap: number = WASM_FEED_BYTES): Uint8Array[] {
	const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
	const out: Uint8Array[] = [];
	let start = 0;
	let at = 0;
	while (at < batch.length) {
		if (at + 4 > batch.length) throw new Error(`truncated batch header at ${at}`);
		const next = at + 4 + dv.getUint32(at, true);
		if (next > batch.length) throw new Error(`truncated batch entry at ${at}`);
		if (next - start > cap && at > start) {
			out.push(batch.subarray(start, at));
			start = at;
		}
		at = next;
	}
	if (at > start) out.push(batch.subarray(start, at));
	return out;
}

/** One staged routing_keys row: the routing filter's input text (packed) and the oracle pairs. */
export interface RoutingStagingRow {
	seq: number;
	bytes: Uint8Array;
	pairs: Uint8Array | null;
}

/**
 * A scores slice's routing-filter input and oracle-index pairs as staged routing_keys rows: ONE
 * row for the whole slice, keyed by the seq of its first batch. Until 2026-09-25 it was one row
 * per batch, ~1,480 a night at 1x, each written and then deleted by the oracle_index phase.
 *
 * The text and the pairs are the batches' own, concatenated in batch order, so the routing and
 * oracle_index phases read exactly the lines and records they did before. Every batch's text
 * opens with the name-keys stamp, the first batch's included, so the row still opens with it. A
 * slice whose concatenation would not fit a row (`cap`), or that lacks a batch's pairs, is staged
 * per batch as before. Per-batch keys are the batches' own seqs, all within this slice's range,
 * so they cannot collide with another slice's row either way.
 */
export function routingStagingRows(
	routing: readonly { seq: number; bytes: Uint8Array }[],
	pairs: ReadonlyMap<number, Uint8Array>,
	pack: (raw: Uint8Array) => Uint8Array,
	cap: number,
): RoutingStagingRow[] {
	const first = routing[0];
	if (!first) return [];
	const concat = (parts: Uint8Array[]) => {
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	};
	const batchPairs = routing.map((b) => pairs.get(b.seq));
	if (batchPairs.every((p) => p !== undefined)) {
		const text = pack(concat(routing.map((b) => b.bytes)));
		// Stored raw: random UUIDs do not compress.
		const joined = concat(batchPairs as Uint8Array[]);
		if (text.length <= cap && joined.length <= cap) return [{ seq: first.seq, bytes: text, pairs: joined }];
	}
	return routing.map((b) => ({ seq: b.seq, bytes: pack(b.bytes), pairs: pairs.get(b.seq) ?? null }));
}
