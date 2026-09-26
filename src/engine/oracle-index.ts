// Scryfall id → oracle id, in Workers KV, so `/cards/:id/rulings` can find a card's rulings bucket
// without asking a partition Durable Object who the card is.
//
// The rulings route needs exactly one fact about a printing — its oracle id — and until this index
// it paid a routed engine call (and, on a hibernated partition, a store wake) to learn it: ~28k a
// day on DeckGen, 93% of them mtg-seeker's Worker, every sampled one the two-segment
// `/cards/<scryfall id>/rulings` shape. The mapping is ~540k pairs, changes only when printings
// are added, and is known to both publishers at the moment they already visit every printing: the
// nightly's `scores` pass (the wasm emits the pairs beside the routing keys, EMIT_ORACLE_PAIRS)
// and the native builder's partition loop (`oracle-pairs.bin`). Which printings get an entry is
// one Rust function, `transform::oracle_pair_of`; how entries become buckets is THIS module, run
// by both publishers — so the two write byte-identical buckets for the same corpus.
//
// LAYOUT — one KV value per bucket, BINARY, fixed width, searched in place:
//
//   0..4    "SLOX"
//   4       format version (1)
//   5       this value's bucket number — a value put under the wrong key is refused, not misread
//   6..8    0
//   8..12   entry count, u32 little-endian
//   12..16  0
//   16..    `count` entries of 32 bytes, sorted ascending by the first 16:
//             16 bytes  the scryfall id's raw bytes
//             16 bytes  its oracle id's raw bytes
//
// Binary rather than keyed-blob.ts's ASCII because the ASCII rule exists for `wrangler kv bulk put`
// with STRING values, and this value never takes that path: the nightly puts bytes from the
// Worker, and the deploy path bulk-puts with `base64: true`, which the bulk API decodes server-side.
// Hex would double every entry (64B, 35MB now, 70MB at 2× corpus) inside a namespace whose ceiling
// the store generations already press on.
//
// BUCKET = the scryfall id's top six bits. Ids are UUIDv4, so the split is uniform (2026-09-24's
// build: 542,556 pairs, 8,123–8,715 a bucket → 260–279KB, 17.4MB in all). What is LEFT OUT misses
// and falls back to the engine, which is exactly today's answer: a printing newer than the last
// publish. The reversible printings are IN, under their faces' oracle id — the id the route reads
// when a card object has none at top level (`rulingsOracleIdOf`; see `oracle_pair_of`). Content
// generation 1 left them out, while the route read only the top level and answered them `[]`.
//
// STABLE KEYS, overwritten in place, like the rulings buckets and for the same reasons: a reader
// holds one bucket and nothing spans buckets, so there is no torn read to version away; and stable
// keys need no retention sweep — generational keys would cost 64 puts AND 64 deletes a night. The
// `oracle-index:` prefix is outside every sweep (`store:card-`, `rulings:v`, `reference:v`), which
// tests/engine/oracle-index.test.ts pins. The publisher diffs against per-bucket hashes recorded
// in the META key (not in a Durable Object's table), so the deploy path and the nightly skip each
// other's unchanged buckets.

/** Bucket layout version, in the key. Bump on any layout change; the old keys are pruned after. */
export const ORACLE_INDEX_FORMAT_VERSION = 1;
/**
 * What the entries mean (which printings are included). Bump to force a full republish.
 * 2 (2026-09-25): the reversible printings are included, under their faces' oracle id.
 */
export const ORACLE_INDEX_CONTENT_GENERATION = 2;
/** Buckets in the set: the scryfall id's top six bits. */
export const ORACLE_INDEX_BUCKET_COUNT = 64;
export const ORACLE_INDEX_META_KEY = "oracle-index:meta";
/** Every bucket key of every layout version starts with this (the meta key does not). */
export const ORACLE_INDEX_KEY_PREFIX = "oracle-index:v";

const MAGIC = [0x53, 0x4c, 0x4f, 0x58]; // "SLOX"
const HEADER_BYTES = 16;
const ID_BYTES = 16;
/** One (scryfall id, oracle id) record — `transform::ORACLE_PAIR_BYTES` on the Rust side. */
export const ORACLE_PAIR_BYTES = 2 * ID_BYTES;

export interface OracleIndexMeta {
	format_version: number;
	content_generation: number;
	bucket_count: number;
	built_at: string;
	pair_count: number;
	/** sha256 of each bucket's bytes, hex, in bucket order — what the next publish diffs against. */
	hashes: string[];
}

export function oracleIndexCurrentPrefix(): string {
	return `${ORACLE_INDEX_KEY_PREFIX}${ORACLE_INDEX_FORMAT_VERSION}:`;
}

export function oracleIndexBucketKey(bucket: number): string {
	return `${oracleIndexCurrentPrefix()}${bucket.toString(16).padStart(2, "0")}`;
}

function hexDigit(code: number): number {
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	return -1;
}

/**
 * A UUID's 16 raw bytes, or null when it is not one. Dashes are accepted anywhere and ignored,
 * case is folded — the same reading the engine's `parse_uuid_or_hash` and the builder's
 * `parse_uuid16` give an id, so an uppercase id finds here exactly what it finds there.
 */
export function uuidBytes(uuid: string, out: Uint8Array = new Uint8Array(ID_BYTES)): Uint8Array | null {
	let n = 0;
	let hi = -1;
	for (let i = 0; i < uuid.length; i++) {
		const code = uuid.charCodeAt(i);
		if (code === 0x2d) continue;
		const d = hexDigit(code);
		if (d < 0 || n >= ID_BYTES) return null;
		if (hi < 0) hi = d;
		else {
			out[n++] = (hi << 4) | d;
			hi = -1;
		}
	}
	return n === ID_BYTES && hi < 0 ? out : null;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** 16 raw bytes as Scryfall's lowercase 8-4-4-4-12 spelling. */
export function formatUuid(bytes: Uint8Array, at = 0): string {
	let s = "";
	for (let i = 0; i < ID_BYTES; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
		s += HEX[bytes[at + i] as number];
	}
	return s;
}

/** Which bucket a scryfall id's pair lives in, from its first raw byte. */
export function oracleIndexBucketOfByte(firstByte: number): number {
	return firstByte >> 2;
}

/** Which bucket a scryfall id lives in, or null when it is not a UUID. */
export function oracleIndexBucketOf(scryfallId: string): number | null {
	const bytes = uuidBytes(scryfallId);
	return bytes === null ? null : oracleIndexBucketOfByte(bytes[0] as number);
}

export class OracleIndexFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OracleIndexFormatError";
	}
}

function compareIds(a: Uint8Array, aAt: number, b: Uint8Array, bAt: number): number {
	for (let i = 0; i < ID_BYTES; i++) {
		const d = (a[aAt + i] as number) - (b[bAt + i] as number);
		if (d !== 0) return d;
	}
	return 0;
}

function checkRun(chunk: Uint8Array): void {
	if (chunk.length % ORACLE_PAIR_BYTES !== 0) {
		throw new OracleIndexFormatError(`pair run is ${chunk.length} bytes, not a multiple of ${ORACLE_PAIR_BYTES}`);
	}
}

/**
 * Every bucket, built from flat runs of 32-byte (scryfall id, oracle id) records in any order, in
 * TWO passes over the same runs: `count` each, then `add` each, then `finish`.
 *
 * Two passes rather than one because of where the nightly runs this — a Durable Object with a
 * 128MB isolate — and what one pass would hold. Counting first sizes each bucket's staging buffer
 * exactly, so the scatter allocates the pairs ONCE (17MB today, ~35MB at 2× corpus) and never the
 * input beside them: the coordinator streams its staged rows through `count`, drops them, and
 * streams them again through `add`. `finish` then turns each bucket's staging into its output and
 * releases the staging as it goes, so the peak is ~1× the pairs plus one bucket. The price is
 * reading the ~1,180 staged rows twice.
 *
 * Pure in the pair SET: order, chunking and duplicates do not change a byte of the output, which
 * is what lets a reordered night write nothing and the two publishers agree.
 */
export class OracleIndexBuilder {
	private readonly counts = new Uint32Array(ORACLE_INDEX_BUCKET_COUNT);
	private readonly fill = new Uint32Array(ORACLE_INDEX_BUCKET_COUNT);
	private staging: Uint8Array[] | null = null;
	private finished = false;

	/** Pass 1: count a run's records per bucket. Every run must be counted before any is added. */
	count(chunk: Uint8Array): void {
		if (this.staging !== null) throw new Error("OracleIndexBuilder: count after add");
		checkRun(chunk);
		for (let at = 0; at < chunk.length; at += ORACLE_PAIR_BYTES) {
			const b = oracleIndexBucketOfByte(chunk[at] as number);
			this.counts[b] = (this.counts[b] as number) + 1;
		}
	}

	/** Pass 2: scatter a run into its buckets. Throws if the runs differ from the ones counted. */
	add(chunk: Uint8Array): void {
		if (this.finished) throw new Error("OracleIndexBuilder: add after finish");
		checkRun(chunk);
		this.staging ??= Array.from(this.counts, (n) => new Uint8Array(n * ORACLE_PAIR_BYTES));
		const staging = this.staging;
		for (let at = 0; at < chunk.length; at += ORACLE_PAIR_BYTES) {
			const b = oracleIndexBucketOfByte(chunk[at] as number);
			const into = staging[b] as Uint8Array;
			const fill = this.fill[b] as number;
			if (fill + ORACLE_PAIR_BYTES > into.length) {
				throw new Error(`OracleIndexBuilder: bucket ${b} got more pairs than were counted`);
			}
			into.set(chunk.subarray(at, at + ORACLE_PAIR_BYTES), fill);
			this.fill[b] = fill + ORACLE_PAIR_BYTES;
		}
	}

	/**
	 * Sort, dedupe and frame every bucket. A scryfall id seen twice with the SAME oracle id is kept
	 * once; with two DIFFERENT oracle ids it is DROPPED, not resolved — the route then asks the
	 * engine, the one authority on which printing it serves. Returns the conflicts to log.
	 */
	finish(): { buckets: Uint8Array[]; pairCount: number; conflicts: number } {
		if (this.finished) throw new Error("OracleIndexBuilder: finish twice");
		this.finished = true;
		const staging = this.staging ?? Array.from(this.counts, () => new Uint8Array(0));
		const buckets: Uint8Array[] = [];
		let pairCount = 0;
		let conflicts = 0;
		for (let b = 0; b < ORACLE_INDEX_BUCKET_COUNT; b++) {
			const scattered = staging[b] as Uint8Array;
			if ((this.fill[b] as number) !== scattered.length) {
				throw new Error(`OracleIndexBuilder: bucket ${b} got fewer pairs than were counted`);
			}
			const n = scattered.length / ORACLE_PAIR_BYTES;
			const order = new Uint32Array(n);
			for (let i = 0; i < n; i++) order[i] = i * ORACLE_PAIR_BYTES;
			order.sort(
				(x, y) =>
					compareIds(scattered, x, scattered, y) || compareIds(scattered, x + ID_BYTES, scattered, y + ID_BYTES),
			);
			// Dedupe: equal pairs collapse; an id carrying two oracle ids is dropped entirely.
			const kept = new Uint32Array(n);
			let k = 0;
			for (let i = 0; i < n; ) {
				const at = order[i] as number;
				let j = i + 1;
				let conflicting = false;
				while (j < n && compareIds(scattered, at, scattered, order[j] as number) === 0) {
					if (compareIds(scattered, at + ID_BYTES, scattered, (order[j] as number) + ID_BYTES) !== 0) {
						conflicting = true;
					}
					j++;
				}
				if (conflicting) conflicts++;
				else kept[k++] = at;
				i = j;
			}
			const out = new Uint8Array(HEADER_BYTES + k * ORACLE_PAIR_BYTES);
			out.set(MAGIC, 0);
			out[4] = ORACLE_INDEX_FORMAT_VERSION;
			out[5] = b;
			new DataView(out.buffer).setUint32(8, k, true);
			for (let i = 0; i < k; i++) {
				const at = kept[i] as number;
				out.set(scattered.subarray(at, at + ORACLE_PAIR_BYTES), HEADER_BYTES + i * ORACLE_PAIR_BYTES);
			}
			pairCount += k;
			buckets.push(out);
			staging[b] = new Uint8Array(0); // released: the output holds what survives
		}
		this.staging = null;
		return { buckets, pairCount, conflicts };
	}
}

/** Every bucket from runs already in hand — `OracleIndexBuilder`'s two passes over them. */
export function encodeOracleIndexBuckets(input: Uint8Array | readonly Uint8Array[]): {
	buckets: Uint8Array[];
	pairCount: number;
	conflicts: number;
} {
	const chunks = input instanceof Uint8Array ? [input] : input;
	const builder = new OracleIndexBuilder();
	for (const chunk of chunks) builder.count(chunk);
	for (const chunk of chunks) builder.add(chunk);
	return builder.finish();
}

/** The entry count a bucket's header claims, after checking the frame. Throws on any mismatch. */
function checkedCount(bucket: Uint8Array, expectBucket: number | null): number {
	if (bucket.length < HEADER_BYTES) {
		throw new OracleIndexFormatError(`value is ${bucket.length} bytes, shorter than the header`);
	}
	for (let i = 0; i < MAGIC.length; i++) {
		if (bucket[i] !== MAGIC[i]) throw new OracleIndexFormatError("value does not start with the format magic");
	}
	if (bucket[4] !== ORACLE_INDEX_FORMAT_VERSION) {
		throw new OracleIndexFormatError(
			`value is format version ${bucket[4]}, this reader speaks ${ORACLE_INDEX_FORMAT_VERSION}`,
		);
	}
	if (expectBucket !== null && bucket[5] !== expectBucket) {
		throw new OracleIndexFormatError(`value is bucket ${bucket[5]}, expected ${expectBucket}`);
	}
	const count = new DataView(bucket.buffer, bucket.byteOffset, bucket.byteLength).getUint32(8, true);
	if (HEADER_BYTES + count * ORACLE_PAIR_BYTES !== bucket.length) {
		throw new OracleIndexFormatError(`value claims ${count} entries but is ${bucket.length} bytes`);
	}
	return count;
}

const probe = new Uint8Array(ID_BYTES);

/**
 * The oracle id a bucket maps `scryfallId` to, or null when the bucket does not carry it (a
 * printing newer than the last publish, or no printing at all — the caller asks the engine).
 *
 * Throws OracleIndexFormatError when the value is not a bucket of this format, or is a DIFFERENT
 * bucket than the id belongs in. Nothing is decoded but the ~13 entries the search touches.
 */
export function oracleIdLookup(bucket: Uint8Array, scryfallId: string): string | null {
	const id = uuidBytes(scryfallId, probe);
	if (id === null) return null;
	const count = checkedCount(bucket, oracleIndexBucketOfByte(id[0] as number));
	let lo = 0;
	let hi = count - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const at = HEADER_BYTES + mid * ORACLE_PAIR_BYTES;
		const cmp = compareIds(bucket, at, id, 0);
		if (cmp === 0) return formatUuid(bucket, at + ID_BYTES);
		if (cmp < 0) lo = mid + 1;
		else hi = mid - 1;
	}
	return null;
}

/** Every (scryfall id, oracle id) a bucket holds, in order — for verification, not serving. */
export function* oracleIndexEntries(bucket: Uint8Array): Generator<[string, string]> {
	const count = checkedCount(bucket, null);
	for (let i = 0; i < count; i++) {
		const at = HEADER_BYTES + i * ORACLE_PAIR_BYTES;
		yield [formatUuid(bucket, at), formatUuid(bucket, at + ID_BYTES)];
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * What a publish must write: the buckets whose bytes differ from what the PUBLISHED meta says KV
 * holds, and the meta to write after them. Shared by the nightly (import-coordinator.ts) and the
 * deploy path (scripts/seed-oracle-index.ts), which is why the hashes live in KV and not in a
 * Durable Object's table: each path skips what the other already wrote.
 *
 * A meta from another layout, content generation or bucket count describes nothing this build
 * would write, so every bucket is owed — the same rule the rulings meta follows.
 */
export async function planOracleIndexPublish(
	buckets: Uint8Array[],
	pairCount: number,
	builtAt: string,
	published: OracleIndexMeta | null,
): Promise<{ changed: number[]; meta: OracleIndexMeta }> {
	const hashes = await Promise.all(buckets.map(sha256Hex));
	const known =
		published !== null &&
		typeof published === "object" &&
		published.format_version === ORACLE_INDEX_FORMAT_VERSION &&
		published.content_generation === ORACLE_INDEX_CONTENT_GENERATION &&
		published.bucket_count === ORACLE_INDEX_BUCKET_COUNT &&
		Array.isArray(published.hashes)
			? published.hashes
			: [];
	const changed = hashes.flatMap((h, b) => (known[b] === h ? [] : [b]));
	return {
		changed,
		meta: {
			format_version: ORACLE_INDEX_FORMAT_VERSION,
			content_generation: ORACLE_INDEX_CONTENT_GENERATION,
			bucket_count: ORACLE_INDEX_BUCKET_COUNT,
			built_at: builtAt,
			pair_count: pairCount,
			hashes,
		},
	};
}
