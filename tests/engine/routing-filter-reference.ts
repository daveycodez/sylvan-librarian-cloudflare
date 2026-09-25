// The routing filter's construction AS IT WAS at 923e5086 (2026-09-25), kept verbatim as the
// reference the x2 rewrite is held to: routing-filter-seal.test.ts builds every key set through both
// and requires the same sealed columns and the same filter bytes. The published filter's bytes are
// the contract — a reader in every isolate and last night's KV value both depend on them — so the
// rewrite is proven against the code it replaced, not against a description of it.
//
// Only the construction half is here (accumulate, comparator seal, peel, pack); lookup never changed.
// Edits to this file defeat its purpose: it changes only if the published format changes on purpose.

const ROUTING_FILTER_MAGIC = 0x53524632; // "SRF2"

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

/** The widest cell value: one byte per cell, so up to 255 partitions. */
const VALUE_MASK = 0xff;

/** `ns:` marks a SERVED row's name key in the build input and hashes as `nm:`. */
const SERVED_NAME_PREFIX = "ns:";
const NAME_PREFIX = "nm:";

/** The name-key value meaning "no single partition decides this name". */
const NAME_AMBIGUOUS = 255;

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
function routingHash(key: string): { lo: number; hi: number } {
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

/** What the header pins the filter to — all three must match the manifest. */
interface RoutingFilterIdentity {
	builtAt: string;
	partitionCount: number;
	partitionHash: string;
}

/** Accumulator flag: the entry is a NAME key (`nm:`/`ns:`), sealed by the name rule. */
const FLAG_NAME = 1;
/** Accumulator flag: a SERVED row emitted it (`ns:`). */
const FLAG_SERVED = 2;

/** The sealed columns a filter is built from. `nameKeys` counts the distinct name keys among them. */
interface SealedRoutingKeys {
	lo: Uint32Array;
	hi: Uint32Array;
	values: Uint8Array;
	nameKeys: number;
}

export class ReferenceAccumulator {
	private lo: Uint32Array;
	private hi: Uint32Array;
	private values: Uint8Array;
	private flags: Uint8Array;
	private n = 0;

	constructor(capacityHint = 1024) {
		const cap = Math.max(16, capacityHint);
		this.lo = new Uint32Array(cap);
		this.hi = new Uint32Array(cap);
		this.values = new Uint8Array(cap);
		this.flags = new Uint8Array(cap);
	}

	get size(): number {
		return this.n;
	}

	/** Columns reallocated because the capacity hint ran out — 0 when the hint was honest. */
	grows = 0;

	/**
	 * One build-input line's key. `ns:<k>` (a SERVED row's name) and `nm:<k>` both hash as
	 * `nm:<k>` — the lookup side only ever asks `nm:` — and carry their flags into `seal`.
	 */
	add(key: string, partition: number): void {
		let flags = 0;
		let hashed = key;
		if (key.startsWith(NAME_PREFIX)) flags = FLAG_NAME;
		else if (key.startsWith(SERVED_NAME_PREFIX)) {
			flags = FLAG_NAME | FLAG_SERVED;
			hashed = NAME_PREFIX + key.slice(SERVED_NAME_PREFIX.length);
		}
		const h = routingHash(hashed);
		this.addHashed(h.lo, h.hi, partition, flags);
	}

	addHashed(lo: number, hi: number, partition: number, flags = 0): void {
		if (this.n === this.lo.length) this.grow();
		this.lo[this.n] = lo;
		this.hi[this.n] = hi;
		this.values[this.n] = partition;
		this.flags[this.n] = flags;
		this.n++;
	}

	private grow(): void {
		this.grows++;
		const cap = this.lo.length * 2;
		const lo = new Uint32Array(cap);
		lo.set(this.lo);
		const hi = new Uint32Array(cap);
		hi.set(this.hi);
		const values = new Uint8Array(cap);
		values.set(this.values);
		const flags = new Uint8Array(cap);
		flags.set(this.flags);
		this.lo = lo;
		this.hi = hi;
		this.values = values;
		this.flags = flags;
	}

	/**
	 * Sorted, deduplicated hash columns: an id key's LOWEST partition; a name key's one partition,
	 * `partitionCount + s` for its one SERVED partition `s`, or 255 (see the name-key section).
	 * `partitionCount` is required once any name key was added.
	 */
	seal(partitionCount?: number): SealedRoutingKeys {
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
		let nameKeys = 0;
		// One RUN per distinct hash. An id run keeps its minimum as it goes; a name run (any entry
		// flagged) is decided when it closes, from which partitions hold it and which hold it served.
		let runName = false;
		let owner = -1;
		let owners = 0;
		let served = -1;
		let serveds = 0;
		const closeRun = () => {
			if (m === 0 || !runName) return;
			nameKeys++;
			if (partitionCount === undefined) throw new Error("routing filter: name keys need the partition count to seal");
			if (owners === 1) outValues[m - 1] = owner;
			else if (serveds === 1 && partitionCount + served < NAME_AMBIGUOUS) outValues[m - 1] = partitionCount + served;
			else outValues[m - 1] = NAME_AMBIGUOUS;
		};
		// "Distinct" counted against the first partition seen: a second one makes the run
		// multi-owner (2), and nothing after that can make it sole again.
		const noteName = (v: number, f: number) => {
			if (owners === 0) {
				owner = v;
				owners = 1;
			} else if (v !== owner) owners = 2;
			if ((f & FLAG_SERVED) !== 0) {
				if (serveds === 0) {
					served = v;
					serveds = 1;
				} else if (v !== served) serveds = 2;
			}
		};
		for (const i of sorted) {
			const l = lo[i] as number;
			const h = hi[i] as number;
			const v = this.values[i] as number;
			const f = this.flags[i] as number;
			if (m > 0 && outLo[m - 1] === l && outHi[m - 1] === h) {
				if ((f & FLAG_NAME) !== 0) runName = true;
				if (v < (outValues[m - 1] as number)) outValues[m - 1] = v;
				noteName(v, f);
				continue;
			}
			closeRun();
			outLo[m] = l;
			outHi[m] = h;
			outValues[m] = v;
			m++;
			runName = (f & FLAG_NAME) !== 0;
			owner = -1;
			owners = 0;
			served = -1;
			serveds = 0;
			noteName(v, f);
		}
		closeRun();
		return { lo: outLo.subarray(0, m), hi: outHi.subarray(0, m), values: outValues.subarray(0, m), nameKeys };
	}
}

export function referenceBuild(
	sealed: { lo: Uint32Array; hi: Uint32Array; values: Uint8Array },
	identity: RoutingFilterIdentity,
	/** The header's features word — `ROUTING_FEATURE_NAME_KEYS` only when EVERY input batch carried
	 * `NAME_KEYS_STAMP` (see there). */
	features = 0,
): Uint8Array {
	if (identity.partitionCount > VALUE_MASK) {
		throw new Error(
			`routing filter: partition_count ${identity.partitionCount} does not fit ${VALUE_MASK} distinct 8-bit values`,
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
		return packFilter(nibbles, { seed, blockLength, keyCount: n }, identity, features);
	}
	throw new Error(`routing filter: 3-wise peeling failed for ${n} keys under ${MAX_SEEDS} seeds`);
}

function packFilter(
	nibbles: Uint8Array,
	shape: { seed: number; blockLength: number; keyCount: number },
	identity: RoutingFilterIdentity,
	features: number,
): Uint8Array {
	const hashBytes = encoder.encode(identity.partitionHash);
	const builtAtBytes = encoder.encode(identity.builtAt);
	const packedCells = nibbles.length;
	const out = new Uint8Array(HEADER_BYTES + hashBytes.length + builtAtBytes.length + packedCells);
	const view = new DataView(out.buffer);
	view.setUint32(0, ROUTING_FILTER_MAGIC, false);
	view.setUint32(4, shape.seed >>> 0, true);
	view.setUint32(8, shape.blockLength, true);
	view.setUint32(12, shape.keyCount, true);
	view.setUint32(16, identity.partitionCount, true);
	view.setUint32(20, hashBytes.length, true);
	view.setUint32(24, builtAtBytes.length, true);
	// 28: the FEATURES word (SRF2 readers before it saw a reserved zero here and ignore it, which is
	// right: a reader that never asks a name key cannot misread one). 32..40 reserved (zero).
	view.setUint32(28, features >>> 0, true);
	out.set(hashBytes, HEADER_BYTES);
	out.set(builtAtBytes, HEADER_BYTES + hashBytes.length);
	out.set(nibbles, HEADER_BYTES + hashBytes.length + builtAtBytes.length);
	return out;
}
