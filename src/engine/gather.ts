// The two-phase gather (CARD-PARTITIONING §6, plan B5): the phase-1 key-packet
// codec, the k-way bytewise merge, page selection, the pinned-generation check,
// and the orchestration that runs both phases against partition clients.
//
// The Durable Object side (search-engine-do.ts) supplies the clients — its own
// loaded store locally, siblings over RPC — and this module supplies everything
// order-sensitive, precisely because that is the part a wiring mistake would
// corrupt silently rather than fail.
//
// THE COORDINATOR NEVER INTERPRETS A KEY. Sort keys are opaque byte strings the
// engine promises are totally ordered across partitions (globally comparable —
// plan Track A4); this module compares them with memcmp and nothing else.
// Reimplementing any ordering logic in TypeScript is the drift class
// CARD-PARTITIONING §6 forbids. The engine also stamps every key with a leading
// version byte (`sort_key_version`); streams whose versions differ must never
// be merged — memcmp across encodings is meaningless — so the run refuses them
// by partition name.

import type { EngineSearchOptions } from "./types";

/** One phase-1 entry: an opaque sort key and the virtual printing id owning it. */
export interface KeyEntry {
	key: Uint8Array;
	vpid: number;
}

/**
 * The packet layout this codec speaks, pinned against the Rust packer's
 * `KEY_PACKET_VERSION` by tests/engine/gather-wire-fixture.json.
 *
 * Version 1 was keys-only. Version 2 adds the inline-row section — the rows for
 * a prefix of the entries, carried in the SAME reply so the common page needs no
 * phase-2 round trip. The version leads the packet and a decoder refuses anything
 * else, for the same reason the merge refuses mixed `sort_key_version`s: a wire
 * mismatch between a rolling deploy's two builds has to be a loud failure, not a
 * misread offset.
 */
export const KEY_PACKET_VERSION = 2;

/** A partition's phase-1 reply, decoded. */
export interface KeyPacket {
	/** The partition's UNPAGINATED match count (total_cards sums these). */
	total: number;
	entries: KeyEntry[];
	/**
	 * Rows for `entries[0 .. inlineRows.length)`, each still ENCODED. They stay as
	 * bytes on purpose: most of them lose the cross-partition merge, and parsing
	 * the losers would cost more than the round trip inlining them saves.
	 */
	inlineRows: Uint8Array[];
}

/**
 * Decode the packed phase-1 reply, all LITTLE-ENDIAN:
 *
 * ```text
 * version: u32, total: u32, n: u32, inline: u32
 * n      of: keylen: u16, key bytes, vpid: u32
 * inline of: rowlen: u32, row JSON bytes
 * ```
 *
 * The layout mirrors the `query_keys` export in engine/wasm (plan A4), and
 * tests/engine/gather-wire-fixture.json holds real bytes off that packer that
 * both sides assert against.
 */
export function decodeKeyPacket(packed: Uint8Array): KeyPacket {
	const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
	if (packed.byteLength < 16) throw new Error(`key packet too short: ${packed.byteLength} bytes`);
	const version = view.getUint32(0, true);
	if (version !== KEY_PACKET_VERSION) {
		throw new Error(`key packet version ${version}, expected ${KEY_PACKET_VERSION}; refusing to read it`);
	}
	const total = view.getUint32(4, true);
	const n = view.getUint32(8, true);
	const inlineCount = view.getUint32(12, true);
	const entries: KeyEntry[] = [];
	let at = 16;
	for (let i = 0; i < n; i++) {
		if (at + 2 > packed.byteLength) throw new Error(`key packet truncated in entry ${i} header`);
		const keylen = view.getUint16(at, true);
		at += 2;
		if (at + keylen + 4 > packed.byteLength) throw new Error(`key packet truncated in entry ${i} body`);
		entries.push({ key: packed.subarray(at, at + keylen), vpid: view.getUint32(at + keylen, true) });
		at += keylen + 4;
	}
	if (inlineCount > n) throw new Error(`key packet claims ${inlineCount} inline rows for ${n} entries`);
	const inlineRows: Uint8Array[] = [];
	for (let i = 0; i < inlineCount; i++) {
		if (at + 4 > packed.byteLength) throw new Error(`key packet truncated in inline row ${i} header`);
		const rowlen = view.getUint32(at, true);
		at += 4;
		if (at + rowlen > packed.byteLength) throw new Error(`key packet truncated in inline row ${i} body`);
		inlineRows.push(packed.subarray(at, at + rowlen));
		at += rowlen;
	}
	if (at !== packed.byteLength) throw new Error(`key packet has ${packed.byteLength - at} trailing bytes`);
	return { total, entries, inlineRows };
}

/** Encode a packet in the same layout — the test fixtures' generator, and the
 * reference for what the wasm export must emit. */
export function encodeKeyPacket(packet: { total: number; entries: KeyEntry[]; inlineRows?: Uint8Array[] }): Uint8Array {
	const inlineRows = packet.inlineRows ?? [];
	const size =
		16 +
		packet.entries.reduce((s, e) => s + 2 + e.key.byteLength + 4, 0) +
		inlineRows.reduce((s, r) => s + 4 + r.byteLength, 0);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	view.setUint32(0, KEY_PACKET_VERSION, true);
	view.setUint32(4, packet.total, true);
	view.setUint32(8, packet.entries.length, true);
	view.setUint32(12, inlineRows.length, true);
	let at = 16;
	for (const e of packet.entries) {
		view.setUint16(at, e.key.byteLength, true);
		out.set(e.key, at + 2);
		view.setUint32(at + 2 + e.key.byteLength, e.vpid, true);
		at += 2 + e.key.byteLength + 4;
	}
	for (const row of inlineRows) {
		view.setUint32(at, row.byteLength, true);
		out.set(row, at + 4);
		at += 4 + row.byteLength;
	}
	return out;
}

/**
 * memcmp. Shorter-is-prefix compares LESS, matching how the engine's key
 * encoding terminates variable-length segments — but this module does not rely
 * on that detail; it only promises bytewise order.
 */
export function compareKeys(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.byteLength, b.byteLength);
	for (let i = 0; i < n; i++) {
		const d = (a[i] as number) - (b[i] as number);
		if (d !== 0) return d;
	}
	return a.byteLength - b.byteLength;
}

/** One row of the merged order: which partition owns it, its vpid there, and
 * its LOCAL POSITION in that partition's phase-1 stream.
 *
 * The local index is what makes the inline-row optimisation exact. A partition
 * carries rows for a PREFIX of its own stream, so "did phase 1 already send this
 * row?" is the single comparison `index < inlineRows.length` — no key matching,
 * no vpid lookup table, and nothing that could quietly pair a page slot with the
 * wrong row. */
export interface MergedRef {
	partition: number;
	vpid: number;
	index: number;
}

/**
 * K-way merge of per-partition key streams into the global order.
 *
 * Each partition's entries arrive ALREADY SORTED by the engine (its own page of
 * `offset + limit` best keys); the merge interleaves them by memcmp. A byte-equal
 * tie — which the key encoding makes unreachable for real keys, since a total
 * order over scryfall_id rides in the suffix — breaks deterministically by
 * (partition, vpid), so the differential test's synthetic streams have one
 * defined answer too.
 *
 * Linear scan over k heads rather than a heap: k is the manifest's
 * partition_count (~8), so the constant matters more than the asymptote.
 */
export function mergeKeyStreams(streams: KeyEntry[][]): MergedRef[] {
	const heads = streams.map(() => 0);
	const out: MergedRef[] = [];
	for (;;) {
		let best = -1;
		for (let p = 0; p < streams.length; p++) {
			const at = heads[p] as number;
			const entries = streams[p] as KeyEntry[];
			if (at >= entries.length) continue;
			if (best === -1) {
				best = p;
				continue;
			}
			const bestEntries = streams[best] as KeyEntry[];
			const bestEntry = bestEntries[heads[best] as number] as KeyEntry;
			const entry = entries[at] as KeyEntry;
			const cmp = compareKeys(entry.key, bestEntry.key);
			if (cmp < 0 || (cmp === 0 && entry.vpid < bestEntry.vpid)) best = p;
			// cmp === 0 with equal vpids across partitions: lower partition index
			// wins by iteration order (p ascends and strict < never replaces).
		}
		if (best === -1) return out;
		const entries = streams[best] as KeyEntry[];
		const index = heads[best] as number;
		out.push({ partition: best, vpid: (entries[index] as KeyEntry).vpid, index });
		heads[best] = index + 1;
	}
}

/**
 * The page cut, and the phase-2 shopping list: rows `[offset, offset+limit)` of
 * the merged order, grouped by owning partition WITH their global positions, so
 * the splice can put each fetched row back in merged order.
 *
 * `carried` says how many rows each partition already sent inline. A page row
 * whose local index falls inside its partition's carried prefix is NOT in the
 * shopping list — that is the whole saving — and a partition that owes nothing
 * does not appear in the map at all, so it is never called.
 */
export function selectPage(
	merged: MergedRef[],
	offset: number,
	limit: number,
	carried: number[] = [],
): { page: MergedRef[]; byPartition: Map<number, number[]> } {
	const page = merged.slice(offset, offset + limit);
	const byPartition = new Map<number, number[]>();
	for (const ref of page) {
		if (ref.index < (carried[ref.partition] ?? 0)) continue;
		const list = byPartition.get(ref.partition);
		if (list) list.push(ref.vpid);
		else byPartition.set(ref.partition, [ref.vpid]);
	}
	return { page, byPartition };
}

/**
 * How many rows each partition should carry inline with its phase-1 keys.
 *
 * OFFSET 0 ONLY. The global page is then the global top `limit`, so each
 * partition's contribution is a PREFIX of its own stream and a prefix budget can
 * cover it. Past page 1 a partition's contribution starts at a local rank nobody
 * can predict before the merge, so the budget is zero and the deep page pays for
 * phase 2 exactly as it always did — which is also where the wasted bytes would
 * be worst, since `offset + limit` keys are already in flight.
 *
 * THE SIZE is `limit/N` — the mean contribution — plus a flat slack. Modelling a
 * partition's share of a 175-row page as Binomial(175, 1/9) gives mean 19.4 and
 * sd 4.16, so `20 + 16 = 36` sits four standard deviations out and the chance
 * that ANY of the nine overflows is ~2e-4 per request. The flat term is what
 * makes small limits safe too: at limit 20 the budget is 19 against a mean of
 * 2.2. An overflow is not an error — it costs one phase-2 call for the rows past
 * the prefix, which is the protocol this replaced.
 *
 * The measured cost of the slack is bytes: 9 x 36 rows shipped where ~175 are
 * used. Twinned in engine/builder/examples/g2.rs's `inline_row_budget` so the G2
 * differential exercises the shape production runs.
 */
export const INLINE_SLACK = 16;

export function inlineRowBudget(offset: number, limit: number, partitionCount: number): number {
	if (offset > 0 || partitionCount <= 0 || limit <= 0) return 0;
	return Math.min(limit, Math.ceil(limit / partitionCount) + INLINE_SLACK);
}

/** What a phase-1 reply says about its generation: the partition archive it answered from. */
export interface GenerationReply {
	partition: number;
	storeKey: string;
}

/**
 * The pinned-generation check (plan B5): every phase-1 reply must have answered
 * from the SAME build. Swaps are monotonic — prepare/commit makes the mixed
 * window sub-second, and an old generation cannot be re-asked-for once its
 * chunks are retired — so on a mismatch the gather pins to the NEWEST build (by
 * the `built_at` embedded in the chunk-family key) and re-issues phase 1 to the
 * partitions that answered from an older one.
 */
export function pinGeneration(replies: GenerationReply[]): { pinnedBuiltAt: string; stragglers: number[] } {
	const builtAtOf = (storeKey: string): string => {
		const m = /-v\d+-(\d+)(?:-p\d+)?\.store$/.exec(storeKey);
		if (!m?.[1]) throw new Error(`phase-1 reply names an unparseable store key: ${storeKey}`);
		return m[1];
	};
	// built_at is numeric (see staleStoreKeys, which sorts builds the same way);
	// compare as numbers so a length change in the stamp cannot reorder builds.
	let pinned = "";
	for (const r of replies) {
		const at = builtAtOf(r.storeKey);
		if (pinned === "" || Number(at) > Number(pinned)) pinned = at;
	}
	return {
		pinnedBuiltAt: pinned,
		stragglers: replies.filter((r) => builtAtOf(r.storeKey) !== pinned).map((r) => r.partition),
	};
}

// ── The run itself ─────────────────────────────────────────────────────────────

/** One partition's phase-1 answer, as the RPC carries it. */
export interface SearchKeysReply {
	/** encodeKeyPacket layout — the wasm export's bytes, forwarded opaquely. */
	packed: Uint8Array;
	/** The archive that answered — the pinned-generation check's input. */
	storeKey: string;
	/** Leading version byte of every key in `packed`. */
	sortKeyVersion: number;
}

/**
 * What the gather needs from each partition — its own engine locally, siblings
 * over Durable Object RPC. Index in the array IS the partition number.
 */
export interface PartitionClient {
	/** `inlineRows` asks this partition to carry the rows for the first N entries
	 * of its own answer, so the page needs no phase-2 call for them. */
	searchKeys(opts: EngineSearchOptions, inlineRows: number): Promise<SearchKeysReply>;
	/** Rows for these vpids in CALLER order, as a UTF-8 JSON array. `storeKey`
	 * pins the generation: a partition that has swapped must error loudly, not
	 * answer from different rows. */
	fetchRows(vpids: number[], fields: string[], storeKey: string): Promise<Uint8Array>;
	/** Converge this partition on the manifest KV holds NOW — prefetch and swap if it differs
	 * from what it serves. The gather's remedy for a straggler that no publish told; optional
	 * only so an older sibling build without it still answers a gather. */
	refresh?(): Promise<void>;
}

/** How long to let stragglers finish their commit before phase 1 is re-asked.
 * The prepare→commit publish makes the mixed window sub-second, so one short
 * pause covers the case this exists for. */
export const GATHER_REISSUE_BACKOFF_MS = 250;

const decoder = new TextDecoder();

/**
 * Both phases, start to finish: keys from every partition on ONE pinned
 * generation, merged bytewise, cut to the page, rows fetched from their owners
 * and reassembled in merged order.
 *
 * Returns the page's rows as PARSED objects (the caller re-encodes in whatever
 * shape its route needs) plus the exact unpaginated total.
 */
export async function runTwoPhase(
	clients: PartitionClient[],
	opts: EngineSearchOptions,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ total: number; rows: Record<string, unknown>[] }> {
	// Phase 1 asks every partition for its best `offset + limit` keys FROM ZERO,
	// never for its own page at `offset`. The distinction is the whole
	// correctness argument of the merge: the global rows [offset, offset+limit)
	// are a subset of the union of the per-partition rows [0, offset+limit), and
	// of NOTHING smaller — a partition's own [offset, offset+limit) window can
	// miss every row the global page wanted from it, and once `offset` passes a
	// partition's match count that partition contributes nothing at all. Asking
	// with the caller's offset made page 1 right (offset 0 is the same request)
	// and every later page silently wrong, or a 404 when the merge came back
	// empty. `selectPage` below applies the caller's offset ONCE, to the merged
	// order, which is the only place it means anything.
	const phase1: EngineSearchOptions = { ...opts, offset: 0, limit: opts.offset + opts.limit };
	// Phase 2 folded into phase 1 for the page-1 case: every partition carries the
	// rows for a prefix of its own keys, and a page covered by those prefixes costs
	// no second round trip at all — 1 isolate RPC + (N-1) sibling RPCs instead of up
	// to 1 + (N-1) + (N-1). The budget is a HINT: a partition that under-delivers
	// (or a build that ignores the argument) simply leaves rows for phase 2 to
	// fetch, so nothing about the answer depends on it. See inlineRowBudget.
	const budget = inlineRowBudget(opts.offset, opts.limit, clients.length);
	const replies = await Promise.all(clients.map((c) => c.searchKeys(phase1, budget)));

	// Pinned generation: every partition must have answered from ONE build.
	// Swaps are monotonic, so on a mismatch the newest build wins and the
	// stragglers — mid-commit for a sub-second window — are asked again once.
	let pin = pinGeneration(replies.map((r, partition) => ({ partition, storeKey: r.storeKey })));
	if (pin.stragglers.length > 0) {
		await sleep(GATHER_REISSUE_BACKOFF_MS);
		for (const p of pin.stragglers) {
			replies[p] = await (clients[p] as PartitionClient).searchKeys(phase1, budget);
		}
		pin = pinGeneration(replies.map((r, partition) => ({ partition, storeKey: r.storeKey })));
	}
	// STILL MIXED AFTER THE PAUSE: this is no longer a commit window, it is a partition that no
	// publish ever told. The deploy's native import writes a new store to KV and NOTIFIES NOBODY —
	// a cold object reconciles against KV when it loads, a WARM one keeps serving what it loaded
	// until something tells it otherwise, and under steady traffic a partition never goes cold.
	// Measured 2026-09-02 after two deploys in one evening: 6 of 10 partitions on one account and
	// 1 of 10 on the other answered from the previous build for over half an hour, and every
	// search on both was a 500 because this threw. Tell the stragglers to converge on KV's
	// manifest, once, and ask again; a fleet that will not converge even then is the bug the
	// throw below has always been for.
	if (pin.stragglers.length > 0) {
		await Promise.all(pin.stragglers.map((p) => (clients[p] as PartitionClient).refresh?.()));
		for (const p of pin.stragglers) {
			replies[p] = await (clients[p] as PartitionClient).searchKeys(phase1, budget);
		}
		pin = pinGeneration(replies.map((r, partition) => ({ partition, storeKey: r.storeKey })));
		if (pin.stragglers.length > 0) {
			throw new Error(
				`gather: partitions ${pin.stragglers.join(",")} still answer from another generation ` +
					`after re-issue and refresh (pinned built_at ${pin.pinnedBuiltAt})`,
			);
		}
	}

	// Version gate BEFORE any merge: memcmp across key encodings is meaningless.
	const version = (replies[0] as SearchKeysReply).sortKeyVersion;
	for (let p = 1; p < replies.length; p++) {
		if ((replies[p] as SearchKeysReply).sortKeyVersion !== version) {
			throw new Error(
				`gather: partition ${p} emits sort-key version ${(replies[p] as SearchKeysReply).sortKeyVersion} ` +
					`against partition 0's ${version}; refusing to merge streams from different encodings`,
			);
		}
	}

	const packets = replies.map((r) => decodeKeyPacket(r.packed));
	const total = packets.reduce((s, p) => s + p.total, 0);
	const merged = mergeKeyStreams(packets.map((p) => p.entries));
	const carried = packets.map((p) => p.inlineRows.length);
	const { page, byPartition } = selectPage(merged, opts.offset, opts.limit, carried);
	if (page.length === 0) return { total, rows: [] };

	// Phase 2, only to the partitions that STILL owe rows after the inline prefixes
	// are accounted for, in parallel, pinned. On the common page this map is empty
	// and the whole block is skipped.
	const pinnedKeyOf = new Map<number, string>();
	for (let p = 0; p < replies.length; p++) pinnedKeyOf.set(p, (replies[p] as SearchKeysReply).storeKey);
	const fetched = new Map<number, Record<string, unknown>[]>();
	await Promise.all(
		[...byPartition.entries()].map(async ([partition, vpids]) => {
			const bytes = await (clients[partition] as PartitionClient).fetchRows(
				vpids,
				opts.fields,
				pinnedKeyOf.get(partition) as string,
			);
			const rows = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>[];
			if (rows.length !== vpids.length) {
				throw new Error(`gather: partition ${partition} returned ${rows.length} rows for ${vpids.length} vpids`);
			}
			fetched.set(partition, rows);
		}),
	);

	// Reassemble. A page slot takes its row from the partition's inline prefix when
	// its local index falls inside it, and otherwise from that partition's fetched
	// queue — which came back in caller (= merged) order, so the splice is a queue
	// walk and never a key comparison. Only the rows the page kept are parsed; the
	// inline rows that lost the merge are never decoded at all.
	const cursors = new Map<number, number>();
	const rows = page.map((ref) => {
		const inline = (packets[ref.partition] as KeyPacket).inlineRows[ref.index];
		if (inline !== undefined) return JSON.parse(decoder.decode(inline)) as Record<string, unknown>;
		const at = cursors.get(ref.partition) ?? 0;
		cursors.set(ref.partition, at + 1);
		return (fetched.get(ref.partition) as Record<string, unknown>[])[at] as Record<string, unknown>;
	});
	return { total, rows };
}
