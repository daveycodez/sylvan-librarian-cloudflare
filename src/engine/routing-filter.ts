// The printing-id → partition routing filter (plan B5's "~9MB×N map", replaced
// by something two orders of magnitude smaller).
//
// THE PROBLEM. Cards are partitioned by `hash(oracle_id) % N`, so a route that
// starts from an ORACLE id asks exactly one partition. Every other id — the
// printing's own `scryfall_id`, its `illustration_id`, its multiverse/mtgo/
// arena/tcgplayer/cardmarket ids — is a bare UUID or integer with no derivable
// relationship to its card's oracle_id, so `/cards/<id>`, `/cards/multiverse/<n>`,
// the illustration lookup and `POST /cards/collection {id}` all had to fan out to
// every partition and take the first non-null answer. On the free plan every one
// of those N stub calls is a separately billed Durable Object request.
//
// THE STRUCTURE is a 3-wise XOR *retrieval* filter (Botelho/Graf–Lemire), not a
// Bloom filter, and the difference is the whole point:
//
//   * for a key that WAS in the build set it returns the stored value EXACTLY —
//     no false positives, no probability, so the routed partition is right;
//   * for a key that was NOT, it returns an arbitrary 4-bit value — which is why
//     a lookup is only ever a HINT, and a miss at the hinted partition falls back
//     to the full fan-out. The filter can be unhelpful; it can never be wrong.
//
// The stored value is the LOWEST partition index owning the key. That is not an
// arbitrary choice: `PartitionedEngine.firstNonNull` resolves a multi-owner id
// (46 of them across the real 1.23M-key corpus — some illustration ids and a
// handful of shared multiverse/cardmarket ids) by partition order, so storing the
// minimum makes the hinted answer byte-identical to the fanned-out one.
//
// SIZE, measured against the real generation-1786869419 corpus (517,746
// printings): 1,232,730 distinct addressable keys, 1.23 cells per key, 4 bits per
// cell ⇒ 758 KB. One KV value, read at most once per isolate, and never awaited on
// the request path — see `RoutingFilterCache`.
//
// VALIDATION ON LOAD mirrors the manifest's `partition_hash` discipline: the
// header carries the built_at stamp, the partition count and the partition-hash
// name it was built against, and a filter that disagrees with the manifest the
// request is pinned to is DISCARDED rather than consulted. A filter from another
// generation would hint at partitions computed under another modulus, which is
// exactly the silent-wrong-answer class the manifest checks exist to prevent.

/** Header magic: "SRF" + format version. Bump the trailing digit with the layout. */
export const ROUTING_FILTER_MAGIC = 0x53524631; // "SRF1"

/** Header bytes before the cell array. */
const HEADER_BYTES = 40;

/**
 * Cells per key. 1.23 is the classic 3-wise XOR peeling threshold — below ~1.22
 * the hypergraph stops being peelable almost surely and construction starts
 * failing over and over instead of once in a while.
 */
const CELLS_PER_KEY = 1.23;

/** Seeds tried before construction gives up. Each attempt peels or it does not;
 * failures are independent, and 1.23 makes a failure rare enough that ten is a
 * formality rather than a budget. */
const MAX_SEEDS = 10;

/** Spare cells added on top of the ratio — see `blockLength`. */
const CELL_FLOOR = 32;

/** The value written for "no partition" — only reachable for absent keys. */
const VALUE_MASK = 0xf;

/**
 * The key namespaces. A route's identifier space is part of its key, so a
 * multiverse id `12345` and a tcgplayer id `12345` are different keys and cannot
 * hint at each other's partitions.
 *
 * These strings are part of the WIRE FORMAT — the publisher hashes them and the
 * isolate hashes them again on the other side of a KV value. Renaming one
 * silently turns every lookup in that namespace into a fallback.
 */
export const ROUTING_NAMESPACES = {
	scryfallId: "i",
	illustrationId: "l",
	multiverse: "multiverse",
	mtgo: "mtgo",
	arena: "arena",
	tcgplayer: "tcgplayer",
	cardmarket: "cardmarket",
} as const;

/** `<namespace>:<id>` — the exact bytes both sides hash. */
export function routingKey(namespace: string, id: string): string {
	return `${namespace}:${id}`;
}

/** The key for a bare printing UUID (`/cards/<scryfall_id>`, collection `{id}`). */
export function scryfallIdKey(id: string): string {
	return routingKey(ROUTING_NAMESPACES.scryfallId, id.toLowerCase());
}

/** The key for an illustration UUID. */
export function illustrationIdKey(id: string): string {
	return routingKey(ROUTING_NAMESPACES.illustrationId, id.toLowerCase());
}

/** The key for one of the external integer id namespaces. */
export function externalIdKey(namespace: string, id: number): string {
	return routingKey(namespace, String(id));
}

// ── Hashing ───────────────────────────────────────────────────────────────────
//
// Two independent 32-bit Murmur3 hashes rather than one 64-bit one, deliberately:
// this runs 1.2M times per build in a Durable Object with a CPU budget, and
// 32-bit integer math in JS stays in the fast path where BigInt does not. The two
// halves are combined into three well-mixed slot indices below.

function murmur32(bytes: Uint8Array, seed: number): number {
	let h = seed | 0;
	const n = bytes.length;
	const blocks = n & ~3;
	for (let i = 0; i < blocks; i += 4) {
		let k =
			(bytes[i] as number) |
			((bytes[i + 1] as number) << 8) |
			((bytes[i + 2] as number) << 16) |
			((bytes[i + 3] as number) << 24);
		k = Math.imul(k, 0xcc9e2d51);
		k = (k << 15) | (k >>> 17);
		k = Math.imul(k, 0x1b873593);
		h ^= k;
		h = (h << 13) | (h >>> 19);
		h = (Math.imul(h, 5) + 0xe6546b64) | 0;
	}
	let k = 0;
	switch (n & 3) {
		// murmur3's tail is a deliberate fallthrough chain: 3 folds into 2 folds into 1, which is
		// the reference implementation and the only shape that hashes the same bytes.
		// biome-ignore lint/suspicious/noFallthroughSwitchClause: murmur3 tail, see above
		case 3:
			k ^= (bytes[blocks + 2] as number) << 16;
		// biome-ignore lint/suspicious/noFallthroughSwitchClause: murmur3 tail, see above
		case 2:
			k ^= (bytes[blocks + 1] as number) << 8;
		// falls through
		case 1:
			k ^= bytes[blocks] as number;
			k = Math.imul(k, 0xcc9e2d51);
			k = (k << 15) | (k >>> 17);
			k = Math.imul(k, 0x1b873593);
			h ^= k;
	}
	h ^= n;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

function mix32(x: number): number {
	let h = x | 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

const encoder = new TextEncoder();

/** The key's two independent 32-bit hash halves. */
export function routingHash(key: string): { lo: number; hi: number } {
	const bytes = encoder.encode(key);
	return { lo: murmur32(bytes, 0x9747b28c), hi: murmur32(bytes, 0x1b873593) };
}

/** The three cell indices a key occupies, one per block. */
function slotsOf(lo: number, hi: number, seed: number, blockLength: number): [number, number, number] {
	const r0 = mix32(lo ^ seed) % blockLength;
	const r1 = mix32(hi ^ ((seed * 0x9e3779b9) | 0)) % blockLength;
	const r2 = mix32((lo ^ hi ^ ((seed * 0x85ebca6b) | 0)) | 0) % blockLength;
	return [r0, blockLength + r1, 2 * blockLength + r2];
}

// ── Construction ──────────────────────────────────────────────────────────────

/** One (key, owning partition) pair for the build. */
export interface RoutingEntry {
	key: string;
	partition: number;
}

/** What the header pins the filter to — all three must match the manifest. */
export interface RoutingFilterIdentity {
	builtAt: string;
	partitionCount: number;
	partitionHash: string;
}

/**
 * Accumulate hashed keys without ever holding the key strings.
 *
 * THE MEMORY SHAPE IS THE REASON THIS EXISTS. The nightly publisher builds the
 * filter inside a Durable Object with a 128 MB isolate, and the real corpus has
 * 1.23 M keys; a `Map<string, number>` of them is ~150 MB of JS strings before
 * anything is built. Hashing on arrival and keeping three typed arrays is ~15 MB
 * for the same information, and the key is never needed again — the filter is
 * addressed by hash on both sides.
 *
 * Duplicates are collapsed at `seal()` by sorting on the 64-bit hash, keeping the
 * LOWEST partition. Two DIFFERENT keys colliding on all 64 bits (expected ~4e-8
 * over this corpus) would merge into one entry, and the loser's lookup would hint
 * at the wrong partition — which the serving path already handles as a miss and
 * falls back from. That is the only inexactness anywhere in the structure, and it
 * costs one RPC rather than a wrong answer.
 */
export class RoutingKeyAccumulator {
	private lo: Uint32Array;
	private hi: Uint32Array;
	private values: Uint8Array;
	private n = 0;

	constructor(capacityHint = 1024) {
		const cap = Math.max(16, capacityHint);
		this.lo = new Uint32Array(cap);
		this.hi = new Uint32Array(cap);
		this.values = new Uint8Array(cap);
	}

	get size(): number {
		return this.n;
	}

	add(key: string, partition: number): void {
		const h = routingHash(key);
		this.addHashed(h.lo, h.hi, partition);
	}

	addHashed(lo: number, hi: number, partition: number): void {
		if (this.n === this.lo.length) this.grow();
		this.lo[this.n] = lo;
		this.hi[this.n] = hi;
		this.values[this.n] = partition;
		this.n++;
	}

	private grow(): void {
		const cap = this.lo.length * 2;
		const lo = new Uint32Array(cap);
		lo.set(this.lo);
		const hi = new Uint32Array(cap);
		hi.set(this.hi);
		const values = new Uint8Array(cap);
		values.set(this.values);
		this.lo = lo;
		this.hi = hi;
		this.values = values;
	}

	/** Sorted, deduplicated (lowest partition wins) hash columns. */
	seal(): { lo: Uint32Array; hi: Uint32Array; values: Uint8Array } {
		const order = new Uint32Array(this.n);
		for (let i = 0; i < this.n; i++) order[i] = i;
		const lo = this.lo;
		const hi = this.hi;
		// Sort by the 64-bit hash so duplicates land adjacent. `Array.prototype.sort`
		// on a typed array's index view is the only ordering step in the build; the
		// peeling below is linear.
		const sorted = Array.from(order).sort((a, b) => {
			const dh = (hi[a] as number) - (hi[b] as number);
			return dh !== 0 ? dh : (lo[a] as number) - (lo[b] as number);
		});
		const outLo = new Uint32Array(this.n);
		const outHi = new Uint32Array(this.n);
		const outValues = new Uint8Array(this.n);
		let m = 0;
		for (const i of sorted) {
			const l = lo[i] as number;
			const h = hi[i] as number;
			const v = this.values[i] as number;
			if (m > 0 && outLo[m - 1] === l && outHi[m - 1] === h) {
				if (v < (outValues[m - 1] as number)) outValues[m - 1] = v;
				continue;
			}
			outLo[m] = l;
			outHi[m] = h;
			outValues[m] = v;
			m++;
		}
		return { lo: outLo.subarray(0, m), hi: outHi.subarray(0, m), values: outValues.subarray(0, m) };
	}
}

/**
 * Build the filter from an iterable of (key, partition) pairs — the convenient
 * entry point, for tests and for publishers with memory to spare. Everything it
 * does is accumulate and call `buildRoutingFilterFromHashes`.
 */
export function buildRoutingFilter(entries: Iterable<RoutingEntry>, identity: RoutingFilterIdentity): Uint8Array {
	const acc = new RoutingKeyAccumulator();
	for (const e of entries) {
		if (!Number.isInteger(e.partition) || e.partition < 0 || e.partition >= identity.partitionCount) {
			throw new Error(`routing filter: partition ${e.partition} out of range for count ${identity.partitionCount}`);
		}
		acc.add(e.key, e.partition);
	}
	return buildRoutingFilterFromHashes(acc.seal(), identity);
}

/**
 * Build the filter from sealed hash columns (see `RoutingKeyAccumulator`).
 *
 * Throws if peeling fails under every seed — a caller must publish no filter
 * rather than a broken one, and the serving path already treats "no filter" as
 * "fan out", so a build failure degrades to today's behaviour.
 */
export function buildRoutingFilterFromHashes(
	sealed: { lo: Uint32Array; hi: Uint32Array; values: Uint8Array },
	identity: RoutingFilterIdentity,
): Uint8Array {
	if (identity.partitionCount > VALUE_MASK) {
		throw new Error(
			`routing filter: partition_count ${identity.partitionCount} does not fit ${VALUE_MASK} distinct 4-bit values`,
		);
	}
	const { lo, hi, values } = sealed;
	const n = lo.length;

	// The `+ CELL_FLOOR` is what makes tiny key sets buildable at all: at n=2 the
	// ratio alone gives one cell per block, so both keys occupy the identical three
	// slots under every seed and peeling can never start. It is noise at corpus
	// scale (32 cells against 1.5M) and the difference between working and not for
	// the two-key case a test — or a partial build — will hand this.
	const blockLength = Math.max(4, Math.ceil((CELLS_PER_KEY * n + CELL_FLOOR) / 3));
	const cells = blockLength * 3;

	// Peeling scratch, reused across seeds.
	const count = new Uint32Array(cells);
	const xorIdx = new Uint32Array(cells);
	const order = new Uint32Array(n);
	const orderSlot = new Uint32Array(n);
	const queue = new Uint32Array(cells);

	for (let attempt = 0; attempt < MAX_SEEDS; attempt++) {
		const seed = (0x9e3779b9 + attempt * 0x7feb352d) | 0;
		count.fill(0);
		xorIdx.fill(0);
		for (let i = 0; i < n; i++) {
			const s = slotsOf(lo[i] as number, hi[i] as number, seed, blockLength);
			for (const slot of s) {
				count[slot] = (count[slot] as number) + 1;
				xorIdx[slot] = ((xorIdx[slot] as number) ^ i) >>> 0;
			}
		}
		let qHead = 0;
		let qTail = 0;
		for (let slot = 0; slot < cells; slot++) if (count[slot] === 1) queue[qTail++] = slot;
		let peeled = 0;
		while (qHead < qTail) {
			const slot = queue[qHead++] as number;
			if (count[slot] !== 1) continue;
			const i = xorIdx[slot] as number;
			order[peeled] = i;
			orderSlot[peeled] = slot;
			peeled++;
			const s = slotsOf(lo[i] as number, hi[i] as number, seed, blockLength);
			for (const other of s) {
				count[other] = (count[other] as number) - 1;
				xorIdx[other] = ((xorIdx[other] as number) ^ i) >>> 0;
				if (count[other] === 1) queue[qTail++] = other;
			}
		}
		if (peeled !== n) continue;

		// Assign in REVERSE peel order: by the time a key is written, the two cells
		// it did not own are already final, so its own cell can absorb the xor.
		const nibbles = new Uint8Array(cells);
		for (let k = n - 1; k >= 0; k--) {
			const i = order[k] as number;
			const own = orderSlot[k] as number;
			const s = slotsOf(lo[i] as number, hi[i] as number, seed, blockLength);
			let v = values[i] as number;
			for (const slot of s) if (slot !== own) v ^= nibbles[slot] as number;
			nibbles[own] = v & VALUE_MASK;
		}
		return packFilter(nibbles, { seed, blockLength, keyCount: n }, identity);
	}
	throw new Error(`routing filter: 3-wise peeling failed for ${n} keys under ${MAX_SEEDS} seeds`);
}

function packFilter(
	nibbles: Uint8Array,
	shape: { seed: number; blockLength: number; keyCount: number },
	identity: RoutingFilterIdentity,
): Uint8Array {
	const hashBytes = encoder.encode(identity.partitionHash);
	const builtAtBytes = encoder.encode(identity.builtAt);
	const packedCells = (nibbles.length + 1) >> 1;
	const out = new Uint8Array(HEADER_BYTES + hashBytes.length + builtAtBytes.length + packedCells);
	const view = new DataView(out.buffer);
	view.setUint32(0, ROUTING_FILTER_MAGIC, false);
	view.setUint32(4, shape.seed >>> 0, true);
	view.setUint32(8, shape.blockLength, true);
	view.setUint32(12, shape.keyCount, true);
	view.setUint32(16, identity.partitionCount, true);
	view.setUint32(20, hashBytes.length, true);
	view.setUint32(24, builtAtBytes.length, true);
	// 28..40 reserved (zero) so a later field can land without moving the payload.
	out.set(hashBytes, HEADER_BYTES);
	out.set(builtAtBytes, HEADER_BYTES + hashBytes.length);
	const at = HEADER_BYTES + hashBytes.length + builtAtBytes.length;
	for (let i = 0; i < nibbles.length; i += 2) {
		out[at + (i >> 1)] = ((nibbles[i] as number) & 0xf) | (((nibbles[i + 1] ?? 0) & 0xf) << 4);
	}
	return out;
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/** A parsed, ready-to-query filter. */
export class RoutingFilter {
	private constructor(
		private readonly cells: Uint8Array,
		private readonly cellsAt: number,
		private readonly seed: number,
		private readonly blockLength: number,
		readonly keyCount: number,
		readonly identity: RoutingFilterIdentity,
	) {}

	/**
	 * Parse and VALIDATE against the manifest the request is pinned to. Returns
	 * null — never throws — for anything that does not line up: the filter is an
	 * optimisation, and the honest response to a filter we cannot trust is to fan
	 * out exactly as the deployment did before it existed. The reason is logged by
	 * the caller, which knows which key it read.
	 */
	static parse(bytes: Uint8Array, expect: RoutingFilterIdentity): { filter: RoutingFilter } | { reason: string } {
		if (bytes.byteLength < HEADER_BYTES) return { reason: `only ${bytes.byteLength} bytes` };
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (view.getUint32(0, false) !== ROUTING_FILTER_MAGIC) return { reason: "bad magic" };
		const seed = view.getUint32(4, true) | 0;
		const blockLength = view.getUint32(8, true);
		const keyCount = view.getUint32(12, true);
		const partitionCount = view.getUint32(16, true);
		const hashLen = view.getUint32(20, true);
		const builtAtLen = view.getUint32(24, true);
		const cellsAt = HEADER_BYTES + hashLen + builtAtLen;
		const packedCells = (blockLength * 3 + 1) >> 1;
		if (bytes.byteLength !== cellsAt + packedCells) {
			return { reason: `length ${bytes.byteLength} != header ${cellsAt} + cells ${packedCells}` };
		}
		const decoder = new TextDecoder();
		const partitionHash = decoder.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + hashLen));
		const builtAt = decoder.decode(bytes.subarray(HEADER_BYTES + hashLen, cellsAt));
		if (partitionCount !== expect.partitionCount) {
			return { reason: `partition_count ${partitionCount} != manifest ${expect.partitionCount}` };
		}
		if (partitionHash !== expect.partitionHash) {
			return { reason: `partition_hash ${partitionHash} != manifest ${expect.partitionHash}` };
		}
		if (builtAt !== expect.builtAt) return { reason: `built_at ${builtAt} != manifest ${expect.builtAt}` };
		return {
			filter: new RoutingFilter(bytes, cellsAt, seed, blockLength, keyCount, {
				builtAt,
				partitionCount,
				partitionHash,
			}),
		};
	}

	/** Bytes of the packed value, for logs and meters. */
	get byteLength(): number {
		return this.cells.byteLength;
	}

	private cellAt(slot: number): number {
		const byte = this.cells[this.cellsAt + (slot >> 1)] as number;
		return (slot & 1) === 0 ? byte & 0xf : (byte >> 4) & 0xf;
	}

	/**
	 * The partition to ask FIRST, or null when the answer is not a usable hint.
	 *
	 * A key that was built in always yields its own partition. A key that was not
	 * yields an arbitrary nibble, and roughly (16 − N)/16 of those land outside the
	 * partition range and are recognised as garbage here — the rest cost one
	 * fruitless RPC before the caller falls back, which is the price of never
	 * being wrong.
	 */
	lookup(key: string): number | null {
		const { lo, hi } = routingHash(key);
		const [s0, s1, s2] = slotsOf(lo, hi, this.seed, this.blockLength);
		const value = this.cellAt(s0) ^ this.cellAt(s1) ^ this.cellAt(s2);
		return value < this.identity.partitionCount ? value : null;
	}
}
