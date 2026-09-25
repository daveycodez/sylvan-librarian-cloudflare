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

/**
 * Header magic: "SRF" + format version. Bump the trailing digit with the layout.
 *
 * SRF2 (2026-09-23): one BYTE per cell where SRF1 packed two 4-bit cells per byte. Fifteen
 * partitions was the 4-bit ceiling while the build allowed up to MAX_PARTITION_COUNT (then 32), so
 * corpus growth past fifteen partitions would have failed the filter build and sent every bare-id
 * route back to the N-way fan-out without a word. A reader meeting an unknown magic refuses it
 * and fans out, which is the correct answer to any filter it cannot trust.
 *
 * The byte bounds N twice over: an id cell holds a partition (N <= 255), and a name cell holds
 * `N + s` for a name served in partition s with 255 reserved (N <= 127 for every partition to be
 * able to answer `served`). MAX_PARTITION_COUNT (48) sits well inside both, and
 * tests/engine/routing-filter.test.ts builds a filter AT that ceiling to prove it.
 */
export const ROUTING_FILTER_MAGIC = 0x53524632; // "SRF2"
/** The previous layout, still READ: the live filter at deploy time is last night's until the next publish. */
export const ROUTING_FILTER_MAGIC_V1 = 0x53524631; // "SRF1"

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
	/** A printing ADDRESS, `<set>/<collector_number>` — see `setNumberKey`. */
	setNumber: "sn",
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

/**
 * The key for a printing ADDRESS — `/cards/:set/:number` and a collection `{set, collector_number}`:
 * the set code lowercased (the engine compares it lowercased), the collector number exactly as
 * written (the engine compares it exactly). One key per address, whatever the language: every
 * printing at an address shares one oracle id, so the address alone names its partition — see
 * `set_number_routing_key` in engine/builder/src/transform.rs, which writes the other side.
 */
export function setNumberKey(setCode: string, collectorNumber: string): string {
	return routingKey(ROUTING_NAMESPACES.setNumber, `${setCode.toLowerCase()}/${collectorNumber}`);
}

/** The key for one of the external integer id namespaces. */
export function externalIdKey(namespace: string, id: number): string {
	return routingKey(namespace, String(id));
}

// ── Name keys (backlog n6) ────────────────────────────────────────────────────
//
// `/cards/named?exact=`, a collection `{"name"}` identifier and a `!"Name"` search name a card by
// its folded name, and a name does not say which partition holds it — so all three asked every
// partition. The builders (`name_routing_keys_of` in engine/builder/src/transform.rs) emit one key
// per (partition, collated name) for every name the engine can match: canonical rows' whole and
// face names, and every row's flavor name.
//
// A NAME CAN LIVE IN SEVERAL PARTITIONS — a card's whole name is another card's face name, most
// often an art-series card's — so a name key's value is not "the lowest owner" like an id's:
//
//   p            (< N)       exactly one partition holds the name
//   N + s        (< 2N)      several do, but exactly ONE (s) holds a SERVED card of it — the
//                            engine ranks served first, so s's served answer beats every other's
//   255                      no single partition decides it; ask them all
//
// and `lookupName` hands the router which of those it is. Both are HINTS in the same sense an id's
// value is: a key never built in reads garbage, so the router trusts a reply only when the reply
// itself proves the key was real (partitioned-engine.ts, `nameReplySettles`).

/** Namespace of a name key; `ns:` marks a SERVED row's key in the build input and hashes as `nm:`. */
export const NAME_NAMESPACE = "nm";
const SERVED_NAME_PREFIX = "ns:";
const NAME_PREFIX = "nm:";

/**
 * The first line of every routing-key batch a name-aware builder writes (`NAME_KEYS_STAMP` in
 * transform.rs). A filter claims name keys — `ROUTING_FEATURE_NAME_KEYS` — only when every batch it
 * was built from carried one: a name key's ABSENCE from a filter built partly from batches without
 * them would read as "one partition holds this", which is exactly the wrong answer.
 */
export const NAME_KEYS_STAMP = "#nm1";

/** Header features bit: the filter carries name keys, so `lookupName` may answer. */
export const ROUTING_FEATURE_NAME_KEYS = 1;

/** The name-key value meaning "no single partition decides this name". */
const NAME_AMBIGUOUS = 255;

/** Characters outside ASCII that the engine and `collateName` both drop — the typographic quotes
 * and dashes a client pastes. Anything else non-ASCII is not routed (see `nameKey`). */
const DROPPED_TYPOGRAPHY = /[‘’“”–—]/gu;

/**
 * The routing key for a FOLDED name (lowercased and accent-folded, as every name route hands it to
 * the engine), or null when the name must not be routed.
 *
 * Collated — every non-alphanumeric removed — because the engine compares collated names, and it
 * is what the builder keys. NOT ROUTED unless every remaining character is ASCII: `collateName`
 * (Unicode letter and number categories) and Rust's `char::is_alphanumeric` disagree on some
 * non-ASCII marks, and a key spelled differently on the two sides could name a partition holding a
 * DIFFERENT name. The corpus's only non-ASCII name keys are 27 Japanese flavor names, which keep
 * fanning out.
 */
export function nameKey(folded: string): string | null {
	const stripped = folded.replace(DROPPED_TYPOGRAPHY, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range, not a control class
	if (!/^[\x00-\x7f]*$/.test(stripped)) return null;
	let collated = "";
	for (let i = 0; i < stripped.length; i++) {
		const c = stripped.charCodeAt(i);
		if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90)) collated += stripped[i];
	}
	return collated === "" ? null : `${NAME_PREFIX}${collated}`;
}

/** What `lookupName` knows about a name: the one partition holding it, or the one holding it SERVED. */
export type NameHint = { sole: number } | { served: number };

// ── Hashing ───────────────────────────────────────────────────────────────────
//
// Two independent 32-bit Murmur3 hashes rather than one 64-bit one, deliberately:
// this runs 1.2M times per build in a Durable Object with a CPU budget, and
// 32-bit integer math in JS stays in the fast path where BigInt does not. The two
// halves are combined into three well-mixed slot indices below.

function murmur32(bytes: Uint8Array, seed: number): number {
	return murmur32Range(bytes, 0, bytes.length, seed);
}

/** `murmur32` over `bytes[start, end)` — the batch parser hashes keys where they lie in the staged text. */
function murmur32Range(bytes: Uint8Array, start: number, end: number, seed: number): number {
	let h = seed | 0;
	const n = end - start;
	const blocks = start + (n & ~3);
	for (let i = start; i < blocks; i += 4) {
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

/** Accumulator flag: the entry is a NAME key (`nm:`/`ns:`), sealed by the name rule. */
const FLAG_NAME = 1;
/** Accumulator flag: a SERVED row emitted it (`ns:`). */
const FLAG_SERVED = 2;

/** The sealed columns a filter is built from. `nameKeys` counts the distinct name keys among them. */
export interface SealedRoutingKeys {
	lo: Uint32Array;
	hi: Uint32Array;
	values: Uint8Array;
	nameKeys: number;
}

/** What `RoutingKeyAccumulator.addBatch` read from one staged batch. */
export interface RoutingBatchRead {
	/** Key lines added (comment lines and lines without a tab are not keys). */
	keys: number;
	/** The batch opened with `NAME_KEYS_STAMP`. */
	stamped: boolean;
}

const EMPTY_U32 = new Uint32Array(0);
const EMPTY_U8 = new Uint8Array(0);

/** The stamp line's bytes, as a batch opens with them. */
const STAMP_LINE = encoder.encode(`${NAME_KEYS_STAMP}\n`);

/**
 * Accumulate hashed keys without ever holding the key strings.
 *
 * THE MEMORY SHAPE IS THE REASON THIS EXISTS. The nightly publisher builds the
 * filter inside a Durable Object with a 128 MB isolate, and the real corpus has
 * 1.45 M distinct keys in 1.95 M lines; a `Map<string, number>` of them is ~150 MB
 * of JS strings before anything is built. Hashing on arrival and keeping four typed
 * arrays (10 bytes a line) is ~20 MB for the same information, and the key is never
 * needed again — the filter is addressed by hash on both sides.
 *
 * SIZE IT EXACTLY when the line count is known (both publishers know it: the coordinator counts
 * lines as the scores pass stages them, the deploy seeder counts the TSV's newlines). A hint that
 * runs out doubles the columns — one at a time, each old one released as its successor lands, but
 * still ~1.8× the columns at the worst moment and twice the columns after — so the hint is the
 * difference between the corpus fitting and the build spending a third of the isolate on slack.
 *
 * Duplicates are collapsed at `seal()` by sorting on the 64-bit hash. An ID key keeps
 * the LOWEST partition. A NAME key (`nm:`/`ns:`, see `nameKey`) keeps the name rule:
 * its one partition, or N + the one partition holding it SERVED, or 255 — so `seal`
 * takes the partition count. Two DIFFERENT keys colliding on all 64 bits (expected
 * ~4e-8 over this corpus) would merge into one entry, and the loser's lookup would
 * hint at the wrong partition — which the serving path already handles as a miss
 * and falls back from. That is the only inexactness anywhere in the structure, and
 * it costs one RPC rather than a wrong answer.
 *
 * `seal()` CONSUMES the accumulator: it sorts the columns where they lie and hands them back cut to
 * the distinct keys. Nothing can be added afterwards.
 */
export class RoutingKeyAccumulator {
	private lo: Uint32Array;
	private hi: Uint32Array;
	private values: Uint8Array;
	private flags: Uint8Array;
	private n = 0;
	private sealed = false;
	/** `addBatch`'s scratch for re-spelling an `ns:` key as `nm:` before hashing it. */
	private respell = new Uint8Array(256);

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

	/**
	 * Every key line of one staged batch — `<partition>\t<key>` lines, UTF-8, `#` lines comments —
	 * hashed where it lies in the bytes. The same keys as decoding the batch and calling `add` per
	 * line, without a string per key: on the nightly's ~1.95M lines that was ~4M short-lived strings
	 * for the collector to chase, and 40% of the loop's time. Keys are hashed as their UTF-8 bytes,
	 * which is what `routingHash` hashes, so the two paths agree on every well-formed batch (the
	 * builders write nothing else: Rust strings are UTF-8 and carry no byte-order mark).
	 *
	 * A line without a tab before its newline is skipped, as the coordinator always has. The
	 * partition field is decimal; anything else in it is read the way `Number()` reads it.
	 */
	addBatch(text: Uint8Array): RoutingBatchRead {
		let stamped = text.length >= STAMP_LINE.length;
		for (let i = 0; stamped && i < STAMP_LINE.length; i++) stamped = text[i] === STAMP_LINE[i];
		let keys = 0;
		const len = text.length;
		let at = 0;
		while (at < len) {
			let end = text.indexOf(10, at);
			if (end === -1) end = len;
			if (end > at && text[at] !== 35 /* # */) {
				const tab = text.indexOf(9, at);
				if (tab !== -1 && tab < end) {
					this.addKeyBytes(text, tab + 1, end, partitionField(text, at, tab));
					keys++;
				}
			}
			at = end + 1;
		}
		return { keys, stamped };
	}

	/** `add` for a key lying in `bytes[start, end)`. */
	private addKeyBytes(bytes: Uint8Array, start: number, end: number, partition: number): void {
		// "nm:" / "ns:" — the name namespaces, told apart by their second byte.
		let flags = 0;
		let src = bytes;
		let from = start;
		let to = end;
		if (end - start >= 3 && bytes[start] === 110 && bytes[start + 2] === 58) {
			if (bytes[start + 1] === 109) flags = FLAG_NAME;
			else if (bytes[start + 1] === 115) {
				flags = FLAG_NAME | FLAG_SERVED;
				const n = end - start;
				if (this.respell.length < n) this.respell = new Uint8Array(n * 2);
				this.respell.set(bytes.subarray(start, end));
				this.respell[1] = 109; // ns: → nm:
				src = this.respell;
				from = 0;
				to = n;
			}
		}
		this.addHashed(
			murmur32Range(src, from, to, 0x9747b28c),
			murmur32Range(src, from, to, 0x1b873593),
			partition,
			flags,
		);
	}

	addHashed(lo: number, hi: number, partition: number, flags = 0): void {
		if (this.sealed) throw new Error("routing filter: the accumulator is sealed");
		if (this.n === this.lo.length) this.grow();
		this.lo[this.n] = lo;
		this.hi[this.n] = hi;
		this.values[this.n] = partition;
		this.flags[this.n] = flags;
		this.n++;
	}

	/** Double every column, one at a time, each old one released as its successor lands (`resized`). */
	private grow(): void {
		this.grows++;
		const cap = this.lo.length * 2;
		this.lo = new Uint32Array(resized(this.lo.buffer, cap * 4));
		this.hi = new Uint32Array(resized(this.hi.buffer, cap * 4));
		this.values = new Uint8Array(resized(this.values.buffer, cap));
		this.flags = new Uint8Array(resized(this.flags.buffer, cap));
	}

	/**
	 * Sorted, deduplicated hash columns: an id key's LOWEST partition; a name key's one partition,
	 * `partitionCount + s` for its one SERVED partition `s`, or 255 (see the name-key section).
	 * `partitionCount` is required once any name key was added.
	 *
	 * IN PLACE, and that is the point (backlog x2). The comparator sort this replaced boxed an index
	 * per line into a JS array and sorted THAT — 35/75/111MB of JS heap at 1×/2×/3× the corpus on
	 * top of the columns and two more copies of them, over the isolate's 128MB from 2×. This one
	 * permutes the accumulator's own columns by an MSD radix on the 64-bit hash (`sortByHash`): no
	 * JS heap, no scratch column, a third of the CPU. The order is the same ascending (hi, lo) the comparator gave,
	 * and a run of equal hashes is folded order-independently (a minimum, and "one partition or
	 * several" for owners and for served owners), so the output is byte-for-byte the old seal's —
	 * tests/engine/routing-filter-seal.test.ts holds the two side by side on the real key file.
	 *
	 * The distinct keys are then moved into exact-length columns one at a time, each old column
	 * released as its successor lands, so the filter build that follows holds 9 bytes per DISTINCT
	 * key (1.45M of 1.95M lines today) rather than 10 per line.
	 */
	seal(partitionCount?: number): SealedRoutingKeys {
		if (this.sealed) throw new Error("routing filter: the accumulator is already sealed");
		this.sealed = true;
		const n = this.n;
		const lo = this.lo;
		const hi = this.hi;
		const values = this.values;
		const flags = this.flags;
		sortByHash(lo, hi, values, flags, n);

		// One RUN per distinct hash, compacted to the front of the same columns (the write index
		// never passes the read index). An id run keeps its minimum as it goes; a name run (any
		// entry flagged) is decided when it closes, from which partitions hold it and which hold
		// it served.
		let m = 0;
		let nameKeys = 0;
		let runName = false;
		let owner = -1;
		let owners = 0;
		let served = -1;
		let serveds = 0;
		const closeRun = () => {
			if (m === 0 || !runName) return;
			nameKeys++;
			if (partitionCount === undefined) throw new Error("routing filter: name keys need the partition count to seal");
			if (owners === 1) values[m - 1] = owner;
			else if (serveds === 1 && partitionCount + served < NAME_AMBIGUOUS) values[m - 1] = partitionCount + served;
			else values[m - 1] = NAME_AMBIGUOUS;
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
		for (let i = 0; i < n; i++) {
			const l = lo[i] as number;
			const h = hi[i] as number;
			const v = values[i] as number;
			const f = flags[i] as number;
			if (m > 0 && lo[m - 1] === l && hi[m - 1] === h) {
				if ((f & FLAG_NAME) !== 0) runName = true;
				if (v < (values[m - 1] as number)) values[m - 1] = v;
				noteName(v, f);
				continue;
			}
			closeRun();
			lo[m] = l;
			hi[m] = h;
			values[m] = v;
			m++;
			runName = (f & FLAG_NAME) !== 0;
			owner = -1;
			owners = 0;
			served = -1;
			serveds = 0;
			noteName(v, f);
		}
		closeRun();

		// Column by column, each old column released the moment its exact copy exists — so the
		// peak is the old columns plus ONE new one, and nothing waits for a collection.
		this.lo = EMPTY_U32;
		this.hi = EMPTY_U32;
		this.values = EMPTY_U8;
		this.flags = EMPTY_U8;
		this.respell = EMPTY_U8;
		resized(flags.buffer, 0);
		return {
			lo: new Uint32Array(resized(lo.buffer, m * 4)),
			hi: new Uint32Array(resized(hi.buffer, m * 4)),
			values: new Uint8Array(resized(values.buffer, m)),
			nameKeys,
		};
	}
}

/**
 * `buffer`'s bytes in a buffer of `bytes` bytes (truncated, or zero-extended), with `buffer`'s own
 * memory released NOW rather than at some later collection: `ArrayBuffer.prototype.transfer`
 * (ES2024 — V8 11.4, so every workerd this deploys to, and bun) detaches the old buffer and frees its
 * backing store as it returns. `transfer(0)` is a release.
 *
 * THIS IS WHAT MAKES THE BUILD'S PEAK A NUMBER RATHER THAN A HOPE. A dropped typed array is freed
 * when the collector next runs, and V8 schedules that against external memory growth with tens of
 * megabytes of slack: at 3× the corpus the accumulator's 59MB of dead columns could still be
 * resident when the peel allocates its 48MB of scratch. Released here, they are not.
 *
 * Where `transfer` is missing, a copy the collector reclaims — the old behaviour, never a failure.
 */
function resized(buffer: ArrayBufferLike, bytes: number): ArrayBuffer {
	const transfer = (buffer as ArrayBuffer & { transfer?: (length: number) => ArrayBuffer }).transfer;
	if (typeof transfer === "function") return transfer.call(buffer, bytes);
	const out = new ArrayBuffer(bytes);
	new Uint8Array(out).set(new Uint8Array(buffer, 0, Math.min(bytes, buffer.byteLength)));
	return out;
}

/**
 * A staged line's partition field `bytes[start, end)`: decimal digits, or — for anything else —
 * what `Number()` makes of the text, which is how the string path always read it.
 */
function partitionField(bytes: Uint8Array, start: number, end: number): number {
	let v = 0;
	for (let i = start; i < end; i++) {
		const c = bytes[i] as number;
		if (c < 48 || c > 57 || end - start > 9) return Number(new TextDecoder().decode(bytes.subarray(start, end)));
		v = v * 10 + (c - 48);
	}
	return start === end ? 0 : v;
}

// ── The in-place hash sort ────────────────────────────────────────────────────
//
// MSD radix on the 64-bit key (hi, lo), permuting all four columns together by cycle-leader swaps
// (American flag sort): 16 bits first, 8 bits a level after that, insertion sort once a bucket is
// small. The hashes are uniform, so the first level leaves ~30/60/90 lines a bucket at 1×/2×/3× and
// one more level finishes nearly all of them. Not stable, and nothing needs it to be: equal hashes
// are folded order-independently by `seal`.

/** Buckets at or under this size are finished by insertion sort. */
const INSERTION_CUTOFF = 24;
/** The 8-bit levels below the first: hi's low 16 bits, then lo's 32. */
const SUB_LEVELS = 6;

function sortByHash(lo: Uint32Array, hi: Uint32Array, values: Uint8Array, flags: Uint8Array, n: number): void {
	if (n < 2) return;
	const first = new Uint32Array(65537);
	for (let i = 0; i < n; i++) {
		const d = ((hi[i] as number) >>> 16) + 1;
		first[d] = (first[d] as number) + 1;
	}
	for (let d = 0; d < 65536; d++) first[d + 1] = (first[d + 1] as number) + (first[d] as number);
	permute(lo, hi, values, flags, first, new Uint32Array(65536), 65536, 0);
	// Per-level scratch for the 8-bit levels, allocated once: a level's bucket bounds must
	// survive while its children sort.
	const bounds: Uint32Array[] = [];
	const next: Uint32Array[] = [];
	for (let l = 0; l < SUB_LEVELS; l++) {
		bounds.push(new Uint32Array(257));
		next.push(new Uint32Array(256));
	}
	const sortRange = (start: number, end: number, level: number): void => {
		if (end - start <= INSERTION_CUTOFF || level === SUB_LEVELS) {
			insertionSort(lo, hi, values, flags, start, end);
			return;
		}
		const b = bounds[level] as Uint32Array;
		b.fill(0);
		b[0] = start;
		const word = LEVEL_IN_HI[level + 1] ? hi : lo;
		const shift = LEVEL_SHIFT[level + 1] as number;
		for (let i = start; i < end; i++) {
			const d = (((word[i] as number) >>> shift) & 0xff) + 1;
			b[d] = (b[d] as number) + 1;
		}
		for (let d = 0; d < 256; d++) b[d + 1] = (b[d + 1] as number) + (b[d] as number);
		permute(lo, hi, values, flags, b, next[level] as Uint32Array, 256, level + 1);
		for (let d = 0; d < 256; d++) {
			const s = b[d] as number;
			const e = b[d + 1] as number;
			if (e - s > 1) sortRange(s, e, level + 1);
		}
	};
	for (let d = 0; d < 65536; d++) {
		const s = first[d] as number;
		const e = first[d + 1] as number;
		if (e - s > 1) sortRange(s, e, 0);
	}
}

/** Where each level's digit lies: level 0 is hi's top 16 bits, levels 1..6 the 8-bit digits after it. */
const LEVEL_IN_HI = [true, true, true, false, false, false, false];
const LEVEL_SHIFT = [16, 8, 0, 24, 16, 8, 0];

/**
 * Move every entry of `[bounds[0], bounds[radix])` into its digit's bucket, in place. `bounds` holds
 * the bucket starts (absolute, radix + 1 of them); `next` is scratch for the fill cursors.
 */
function permute(
	lo: Uint32Array,
	hi: Uint32Array,
	values: Uint8Array,
	flags: Uint8Array,
	bounds: Uint32Array,
	next: Uint32Array,
	radix: number,
	level: number,
): void {
	const inHi = LEVEL_IN_HI[level] as boolean;
	const shift = LEVEL_SHIFT[level] as number;
	const mask = radix - 1;
	for (let d = 0; d < radix; d++) next[d] = bounds[d] as number;
	for (let d = 0; d < radix; d++) {
		const end = bounds[d + 1] as number;
		let at = next[d] as number;
		while (at < end) {
			// Carry the entry at `at` round its cycle until one belonging here comes back.
			let l = lo[at] as number;
			let h = hi[at] as number;
			let v = values[at] as number;
			let f = flags[at] as number;
			let digit = ((inHi ? h : l) >>> shift) & mask;
			while (digit !== d) {
				const to = next[digit] as number;
				next[digit] = to + 1;
				const tl = lo[to] as number;
				const th = hi[to] as number;
				const tv = values[to] as number;
				const tf = flags[to] as number;
				lo[to] = l;
				hi[to] = h;
				values[to] = v;
				flags[to] = f;
				l = tl;
				h = th;
				v = tv;
				f = tf;
				digit = ((inHi ? h : l) >>> shift) & mask;
			}
			lo[at] = l;
			hi[at] = h;
			values[at] = v;
			flags[at] = f;
			at++;
		}
		next[d] = at;
	}
}

function insertionSort(
	lo: Uint32Array,
	hi: Uint32Array,
	values: Uint8Array,
	flags: Uint8Array,
	start: number,
	end: number,
): void {
	for (let i = start + 1; i < end; i++) {
		const l = lo[i] as number;
		const h = hi[i] as number;
		const v = values[i] as number;
		const f = flags[i] as number;
		let j = i - 1;
		while (j >= start) {
			const hj = hi[j] as number;
			if (hj < h || (hj === h && (lo[j] as number) <= l)) break;
			lo[j + 1] = lo[j] as number;
			hi[j + 1] = hj;
			values[j + 1] = values[j] as number;
			flags[j + 1] = flags[j] as number;
			j--;
		}
		lo[j + 1] = l;
		hi[j + 1] = h;
		values[j + 1] = v;
		flags[j + 1] = f;
	}
}

/**
 * Build the filter from an iterable of (key, partition) pairs — the convenient
 * entry point, for tests and for publishers with memory to spare. Everything it
 * does is accumulate and call `buildRoutingFilterFromHashes`. `features` is the
 * header's features word (`ROUTING_FEATURE_NAME_KEYS` when the entries carry names).
 */
export function buildRoutingFilter(
	entries: Iterable<RoutingEntry>,
	identity: RoutingFilterIdentity,
	features = 0,
): Uint8Array {
	const acc = new RoutingKeyAccumulator();
	for (const e of entries) {
		if (!Number.isInteger(e.partition) || e.partition < 0 || e.partition >= identity.partitionCount) {
			throw new Error(`routing filter: partition ${e.partition} out of range for count ${identity.partitionCount}`);
		}
		acc.add(e.key, e.partition);
	}
	return buildRoutingFilterFromHashes(acc.seal(identity.partitionCount), identity, features);
}

/** A peel queue entry whose slot had emptied by the time it was popped. */
const SKIPPED = 0xffffffff;
/** `peel`'s answer when a cell's key count would pass what its counter holds. */
const COUNT_OVERFLOW = -2;

/**
 * Build the filter from sealed hash columns (see `RoutingKeyAccumulator`).
 *
 * Throws if peeling fails under every seed — a caller must publish no filter
 * rather than a broken one, and the serving path already treats "no filter" as
 * "fan out", so a build failure degrades to today's behaviour.
 *
 * SCRATCH IS 8 BYTES A CELL (~10 a key), down from ~24 a key (backlog x2): the lone key's index per
 * cell, and the FIFO queue of cells, which doubles as the record of peel order — a popped cell that
 * had emptied is overwritten with SKIPPED, and a peeled key's own cell is left holding its index, so
 * the queue replayed backwards IS the assignment order the separate order/slot arrays used to hold.
 * A cell's key count is one byte, kept in the output's cells until they are assigned (a count is
 * Poisson with mean ~2.4; one past 255 falls back to four bytes, see `peel`). Every step visits
 * cells and keys in the same order as before, so the bytes are the same.
 */
export function buildRoutingFilterFromHashes(
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

	const hashBytes = encoder.encode(identity.partitionHash);
	const builtAtBytes = encoder.encode(identity.builtAt);
	const cellsAt = HEADER_BYTES + hashBytes.length + builtAtBytes.length;
	const out = new Uint8Array(cellsAt + cells);
	const cellValues = out.subarray(cellsAt);

	// Peeling scratch, reused across seeds. The key counts live in the output's own cells — they are
	// dead by the time the cells are assigned — and the two index arrays are released before this
	// returns, so all that outlives the build is the filter.
	let count: Uint8Array | Uint32Array = cellValues;
	const xorIdx = new Uint32Array(cells);
	const queue = new Uint32Array(cells);
	try {
		for (let attempt = 0; attempt < MAX_SEEDS; attempt++) {
			const seed = (0x9e3779b9 + attempt * 0x7feb352d) | 0;
			let queued = peel(lo, hi, n, seed, blockLength, count, xorIdx, queue);
			if (queued === COUNT_OVERFLOW) {
				count = new Uint32Array(cells);
				queued = peel(lo, hi, n, seed, blockLength, count, xorIdx, queue);
			}
			if (queued < 0) continue;

			// Assign in REVERSE peel order: by the time a key is written, the two cells
			// it did not own are already final, so its own cell can absorb the xor.
			cellValues.fill(0);
			const s1 = (seed * 0x9e3779b9) | 0;
			const s2 = (seed * 0x85ebca6b) | 0;
			for (let k = queued - 1; k >= 0; k--) {
				const own = queue[k] as number;
				if (own === SKIPPED) continue;
				const i = xorIdx[own] as number;
				const l = lo[i] as number;
				const h = hi[i] as number;
				const r0 = mix32(l ^ seed) % blockLength;
				const r1 = blockLength + (mix32(h ^ s1) % blockLength);
				const r2 = 2 * blockLength + (mix32((l ^ h ^ s2) | 0) % blockLength);
				let v = values[i] as number;
				if (r0 !== own) v ^= cellValues[r0] as number;
				if (r1 !== own) v ^= cellValues[r1] as number;
				if (r2 !== own) v ^= cellValues[r2] as number;
				cellValues[own] = v & VALUE_MASK;
			}
			writeHeader(out, hashBytes, builtAtBytes, { seed, blockLength, keyCount: n }, identity, features);
			return out;
		}
	} finally {
		resized(xorIdx.buffer, 0);
		resized(queue.buffer, 0);
		if (count !== cellValues) resized(count.buffer, 0);
	}
	throw new Error(`routing filter: 3-wise peeling failed for ${n} keys under ${MAX_SEEDS} seeds`);
}

/**
 * One peeling attempt under `seed`. Returns how many queue entries it used — every one either a
 * peeled key's own cell or SKIPPED — or -1 when the hypergraph did not peel, or COUNT_OVERFLOW when
 * a cell held more keys than `count` can count (the caller retries with a wider one: the attempt's
 * outcome must not depend on the counter's width).
 *
 * The slot arithmetic is `slotsOf`, inlined; the lookup side still calls `slotsOf`.
 */
function peel(
	lo: Uint32Array,
	hi: Uint32Array,
	n: number,
	seed: number,
	blockLength: number,
	count: Uint8Array | Uint32Array,
	xorIdx: Uint32Array,
	queue: Uint32Array,
): number {
	const cells = blockLength * 3;
	const cap = count instanceof Uint8Array ? 0xff : 0xffffffff;
	const s1 = (seed * 0x9e3779b9) | 0;
	const s2 = (seed * 0x85ebca6b) | 0;
	count.fill(0);
	xorIdx.fill(0);
	for (let i = 0; i < n; i++) {
		const l = lo[i] as number;
		const h = hi[i] as number;
		const r0 = mix32(l ^ seed) % blockLength;
		const r1 = blockLength + (mix32(h ^ s1) % blockLength);
		const r2 = 2 * blockLength + (mix32((l ^ h ^ s2) | 0) % blockLength);
		const c0 = count[r0] as number;
		const c1 = count[r1] as number;
		const c2 = count[r2] as number;
		if (c0 === cap || c1 === cap || c2 === cap) return COUNT_OVERFLOW;
		count[r0] = c0 + 1;
		count[r1] = c1 + 1;
		count[r2] = c2 + 1;
		xorIdx[r0] = ((xorIdx[r0] as number) ^ i) >>> 0;
		xorIdx[r1] = ((xorIdx[r1] as number) ^ i) >>> 0;
		xorIdx[r2] = ((xorIdx[r2] as number) ^ i) >>> 0;
	}
	let qHead = 0;
	let qTail = 0;
	for (let slot = 0; slot < cells; slot++) if (count[slot] === 1) queue[qTail++] = slot;
	let peeled = 0;
	while (qHead < qTail) {
		const slot = queue[qHead++] as number;
		if (count[slot] !== 1) {
			queue[qHead - 1] = SKIPPED;
			continue;
		}
		const i = xorIdx[slot] as number;
		peeled++;
		const l = lo[i] as number;
		const h = hi[i] as number;
		const r0 = mix32(l ^ seed) % blockLength;
		const r1 = blockLength + (mix32(h ^ s1) % blockLength);
		const r2 = 2 * blockLength + (mix32((l ^ h ^ s2) | 0) % blockLength);
		// The key's own cell keeps its count (1) and its index: no other key touches it, and the
		// assignment reads the index back from it. Its two other cells lose the key.
		if (r0 !== slot) {
			const c = (count[r0] as number) - 1;
			count[r0] = c;
			xorIdx[r0] = ((xorIdx[r0] as number) ^ i) >>> 0;
			if (c === 1) queue[qTail++] = r0;
		}
		if (r1 !== slot) {
			const c = (count[r1] as number) - 1;
			count[r1] = c;
			xorIdx[r1] = ((xorIdx[r1] as number) ^ i) >>> 0;
			if (c === 1) queue[qTail++] = r1;
		}
		if (r2 !== slot) {
			const c = (count[r2] as number) - 1;
			count[r2] = c;
			xorIdx[r2] = ((xorIdx[r2] as number) ^ i) >>> 0;
			if (c === 1) queue[qTail++] = r2;
		}
	}
	return peeled === n ? qTail : -1;
}

function writeHeader(
	out: Uint8Array,
	hashBytes: Uint8Array,
	builtAtBytes: Uint8Array,
	shape: { seed: number; blockLength: number; keyCount: number },
	identity: RoutingFilterIdentity,
	features: number,
): void {
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
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
		/** SRF1: two 4-bit cells per byte. SRF2: one byte per cell. */
		private readonly nibbles: boolean,
		/** The header's features word (0 for SRF1, and for an SRF2 filter built before it existed). */
		readonly features: number = 0,
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
		const magic = view.getUint32(0, false);
		if (magic !== ROUTING_FILTER_MAGIC && magic !== ROUTING_FILTER_MAGIC_V1) return { reason: "bad magic" };
		const nibbles = magic === ROUTING_FILTER_MAGIC_V1;
		const seed = view.getUint32(4, true) | 0;
		const blockLength = view.getUint32(8, true);
		const keyCount = view.getUint32(12, true);
		const partitionCount = view.getUint32(16, true);
		const hashLen = view.getUint32(20, true);
		const builtAtLen = view.getUint32(24, true);
		const features = nibbles ? 0 : view.getUint32(28, true);
		const cellsAt = HEADER_BYTES + hashLen + builtAtLen;
		const packedCells = nibbles ? (blockLength * 3 + 1) >> 1 : blockLength * 3;
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
			filter: new RoutingFilter(
				bytes,
				cellsAt,
				seed,
				blockLength,
				keyCount,
				{
					builtAt,
					partitionCount,
					partitionHash,
				},
				nibbles,
				features,
			),
		};
	}

	/** Bytes of the packed value, for logs and meters. */
	get byteLength(): number {
		return this.cells.byteLength;
	}

	private cellAt(slot: number): number {
		if (!this.nibbles) return this.cells[this.cellsAt + slot] as number;
		const byte = this.cells[this.cellsAt + (slot >> 1)] as number;
		return (slot & 1) === 0 ? byte & 0xf : (byte >> 4) & 0xf;
	}

	/**
	 * The partition to ask FIRST, or null when the answer is not a usable hint.
	 *
	 * A key that was built in always yields its own partition. A key that was not
	 * yields an arbitrary byte, and roughly (256 − N)/256 of those land outside the
	 * partition range and are recognised as garbage here — the rest cost one
	 * fruitless RPC before the caller falls back, which is the price of never
	 * being wrong.
	 */
	lookup(key: string): number | null {
		const value = this.valueOf(key);
		return value < this.identity.partitionCount ? value : null;
	}

	/** Whether this filter carries name keys — only then may `lookupName` answer. */
	get hasNameKeys(): boolean {
		return (this.features & ROUTING_FEATURE_NAME_KEYS) !== 0;
	}

	/**
	 * What the filter says about a NAME key (`nameKey`): the one partition holding it (`sole`), the
	 * one holding it SERVED (`served`), or null — ask them all. Always null on a filter without name
	 * keys, where a name's value would be whatever its cells happen to XOR to.
	 *
	 * A HINT, exactly like `lookup`: a name never built in reads an arbitrary byte, ~(256 − 2N)/256
	 * of which land on 255 or beyond 2N and come back null here. The rest name some partition, and
	 * the caller must let that partition's REPLY prove the key was real before trusting it — see
	 * `nameReplySettles` in partitioned-engine.ts.
	 */
	lookupName(key: string): NameHint | null {
		if (!this.hasNameKeys) return null;
		const value = this.valueOf(key);
		const n = this.identity.partitionCount;
		if (value < n) return { sole: value };
		if (value < 2 * n && value !== NAME_AMBIGUOUS) return { served: value - n };
		return null;
	}

	private valueOf(key: string): number {
		const { lo, hi } = routingHash(key);
		const [s0, s1, s2] = slotsOf(lo, hi, this.seed, this.blockLength);
		return this.cellAt(s0) ^ this.cellAt(s1) ^ this.cellAt(s2);
	}
}
