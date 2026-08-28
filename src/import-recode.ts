// Recode: re-compressing a staged dump into independently seekable gzip members.
//
// A fetched dump sits in stage_blobs as one long gzip stream, so reading byte N
// of the decompressed text costs decompressing bytes 0..N — every time. That
// was tolerable at default_cards size (~78MB compressed), where each transform
// slice's re-stream-and-discard is sub-second. all_cards decompresses to ~2GB
// and its transform takes ~55 slices, so the same resume strategy would
// decompress a cumulative ~50GB+ per night: the quadratic-restream hazard.
//
// The recode phase pays the whole-stream decompression a FIXED number of times
// (once per window, right after the fetch) and re-compresses the bytes into
// INDEPENDENT gzip members of MEMBER_RAW_BYTES raw each — one SQLite row per
// member, carrying (raw_start, raw_len) so a later consumer can binary-search
// for the member containing any raw offset and start decompressing THERE.
// After the recode, resuming at raw offset N costs one ~8MB member instead of
// an N-byte prefix: O(1) instead of O(N).
//
// Split out of import-coordinator.ts so this is reachable from a test without
// a Durable Object: everything here is pure, taking byte streams and member
// readers as callbacks (the import-spill pattern).

import { gzipBytes } from "./engine/store-kv";

/**
 * Raw (decompressed) bytes of the LARGEST window one recode pass re-compresses
 * before committing — the unit of commit, not the unit of alarm.
 *
 * One alarm processes as many windows as its work budget affords (see
 * RECODE_ALARM_BUDGET_SECONDS), streaming the staged gzip prefix ONCE per
 * alarm, so the per-alarm cost is bounded by the budget, not by the window
 * count. The window still bounds two things: how many members sit in memory
 * before a commit (32 members ≈ 60–70MB compressed against the 128MB isolate
 * cap — never hold two windows), and the most work a kill can throw away.
 */
export const RECODE_WINDOW_RAW = 256 * 1024 * 1024;

/**
 * Measured CPU cost of gzipping window bytes, in seconds per GiB of raw input.
 *
 * Probe 2026-08-27 (production observability, the nightly all_cards run): the
 * window at raw offset 0 — pure gzip of 256MiB, no prefix to discard — cost
 * 18.9s, i.e. ~74s/GiB. Used by recodeAlarm to project a window's cost before
 * starting it.
 */
export const RECODE_GZIP_SECONDS_PER_GIB = 74;

/**
 * Measured CPU cost of decompress-and-discard of the staged gzip prefix, in
 * seconds per GiB of raw prefix.
 *
 * Same 2026-08-27 probe: successive 256MiB windows cost 18.9s, 20.9s, 25.3s,
 * 25.1s, 28.1s, 29.1s — a fit of ≈ 18.9s + prefix-GiB × 8.2s. The window at
 * raw 1610612736 (a 1.5GiB prefix) projected ~31s against the 30s Durable
 * Object CPU cap: it died with outcome=exceededCpu cpuTimeMs=30000, was
 * retried 6 times identically, and the alarm chain died at 11:28 UTC — every
 * night since 2026-08-22, when dump growth crossed the line.
 */
export const RECODE_DISCARD_SECONDS_PER_GIB = 8.2;

/**
 * Work budget one recode alarm may spend, in modeled seconds (charged as
 * window-GiB × RECODE_GZIP_SECONDS_PER_GIB plus prefix-GiB ×
 * RECODE_DISCARD_SECONDS_PER_GIB), leaving real headroom under the 30s cap.
 *
 * The budget must assume the worst: a FRESH alarm pays the full current
 * prefix discard before its first window (a mid-alarm stop point never
 * carries over — the next alarm re-streams from byte 0), so the prefix charge
 * is levied up front whether this invocation is a resume or a retry. There is
 * no CPU clock to consult instead: Date.now/performance.now do not advance
 * during synchronous CPU in Workers.
 */
export const RECODE_ALARM_BUDGET_SECONDS = 23;

/**
 * Raw bytes per independent gzip member — the seek granularity.
 *
 * A consumer resuming mid-dump decompresses at most one member before its
 * first useful byte, so this is the fixed resume cost (~8MB, low milliseconds).
 * 32 members per window; ~250 rows for the full dump. Compressed, a member is
 * ~1.6MB at all_cards' measured ~5x gzip ratio — see MEMBER_GZ_CAP_BYTES for
 * the ceiling that guards the ratio assumption.
 */
export const MEMBER_RAW_BYTES = 8 * 1024 * 1024;

/**
 * Hard ceiling on one member's COMPRESSED size, just under the Durable Object
 * SQLite 2MB value cap (the same limit STAGE_BLOB_BYTES stays under, and the
 * one that once failed the transform phase with a bare SQLITE_TOOBIG — see the
 * draft-batching note in import-coordinator.ts).
 *
 * 8MB of raw member needs a gzip ratio of at least ~4.2:1 to fit; card JSON
 * measures ~5x. If a future corpus section compresses worse (dense CJK printed
 * text is the plausible candidate), this turns a silent SQLITE_TOOBIG into a
 * named failure, and the fix is to halve MEMBER_RAW_BYTES — member seq is
 * derived from raw_start, so nothing else encodes the size.
 */
export const MEMBER_GZ_CAP_BYTES = 2_000_000;

/** One re-compressed member, ready to become a stage_members row. */
export interface RecodedMember {
	/** raw_start / memberRaw — stable across retries, so re-runs overwrite. */
	seq: number;
	rawStart: number;
	rawLen: number;
	/** The member's own complete gzip stream, decompressible on its own. */
	bytes: Uint8Array;
}

export interface RecodeResult {
	members: RecodedMember[];
	/** Where this window began: the rawDone it was cut against. */
	rawStart: number;
	/** The checkpoint after this window: raw bytes recoded so far. */
	rawEnd: number;
	/** True when the source ended inside (or exactly at the end of) this window. */
	exhausted: boolean;
	/**
	 * Unconsumed remainder of the last chunk pulled from the source, copied.
	 * A window that fills mid-chunk has already taken that chunk off the
	 * iterator; a caller cutting the NEXT window from the same live stream
	 * (recodeAlarm) must feed this back in front, or those bytes are lost.
	 */
	carry?: Uint8Array;
}

/** A one-shot stream over bytes already in memory, without a Blob's extra copy. */
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

/** Decompress one member's gzip stream, yielding chunks as they decode. */
export async function* gunzipMember(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	const reader = bytesStream(bytes).pipeThrough(new DecompressionStream("gzip")).getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Cut one recode window out of a decompressed byte stream.
 *
 * Skips `skip` bytes (by default `rawDone`, the persisted checkpoint — a
 * caller whose stream is already positioned at `rawDone`, like recodeAlarm's
 * second and later windows, passes 0), then re-compresses up to `windowRaw`
 * bytes into members of `memberRaw` raw bytes each. The window is a multiple
 * of the member size, so every checkpoint lands on a member boundary — which
 * is what lets a retried slice recompute exactly the members it wrote before
 * (same seq, same bytes) instead of shifting the grid.
 */
export async function recodeWindow(
	source: AsyncIterable<Uint8Array>,
	rawDone: number,
	windowRaw = RECODE_WINDOW_RAW,
	memberRaw = MEMBER_RAW_BYTES,
	skip = rawDone,
): Promise<RecodeResult> {
	if (windowRaw % memberRaw !== 0) {
		throw new Error(`recode: window ${windowRaw} is not a multiple of the member size ${memberRaw}`);
	}
	if (rawDone % memberRaw !== 0) {
		// The checkpoint only ever advances by whole members (the final partial
		// member coincides with `exhausted`, after which nothing resumes), so a
		// misaligned value means the meta key was corrupted, not resumed.
		throw new Error(`recode: checkpoint ${rawDone} is not on a ${memberRaw}-byte member boundary`);
	}
	const members: RecodedMember[] = [];
	let toSkip = skip;
	let memberStart = rawDone;
	let carry: Uint8Array | undefined;
	let parts: Uint8Array[] = [];
	let partBytes = 0;
	let exhausted = true;
	const flush = async () => {
		if (partBytes === 0) return;
		const raw = new Uint8Array(partBytes);
		let at = 0;
		for (const part of parts) {
			raw.set(part, at);
			at += part.length;
		}
		parts = [];
		const bytes = await gzipBytes(raw);
		if (bytes.byteLength > MEMBER_GZ_CAP_BYTES) {
			throw new Error(
				`recode: member at raw offset ${memberStart} compressed to ${bytes.byteLength} bytes, over the ` +
					`${MEMBER_GZ_CAP_BYTES} SQLite value ceiling — this data compresses worse than ~4.2:1; ` +
					`halve MEMBER_RAW_BYTES`,
			);
		}
		members.push({ seq: memberStart / memberRaw, rawStart: memberStart, rawLen: partBytes, bytes });
		memberStart += partBytes;
		partBytes = 0;
	};
	outer: for await (const chunk of source) {
		let data = chunk;
		if (toSkip > 0) {
			if (data.length <= toSkip) {
				toSkip -= data.length;
				continue;
			}
			data = data.subarray(toSkip);
			toSkip = 0;
		}
		let at = 0;
		while (at < data.length) {
			const take = Math.min(memberRaw - partBytes, data.length - at);
			// Copied, not viewed: a decompressor is free to reuse its output
			// buffer, and the part list outlives this chunk.
			parts.push(data.slice(at, at + take));
			partBytes += take;
			at += take;
			if (partBytes === memberRaw) {
				await flush();
				if (memberStart - rawDone >= windowRaw) {
					exhausted = false;
					// Copied, not viewed, for the same buffer-reuse reason as the
					// member parts above.
					if (at < data.length) carry = data.slice(at);
					break outer;
				}
			}
		}
	}
	await flush(); // the stream's final, usually partial, member
	return { members, rawStart: rawDone, rawEnd: memberStart, exhausted, carry };
}

/** Progress one recode alarm made: how far the checkpoint moved, in how many
 * committed windows, and whether the source ran out. */
export interface RecodeAlarmProgress {
	windows: number;
	rawEnd: number;
	exhausted: boolean;
}

export interface RecodeAlarmOptions {
	budgetSeconds?: number;
	windowRaw?: number;
	memberRaw?: number;
	gzipSecondsPerGib?: number;
	discardSecondsPerGib?: number;
}

const GIB = 1024 * 1024 * 1024;

/**
 * Cut as many windows out of one pass over the staged stream as the work
 * budget affords, committing each through `commit` as it completes.
 *
 * The point: the prefix discard (skip to `rawDone`) is paid once per ALARM,
 * not once per window — the stream stays open across windows, with each
 * window's unconsumed chunk remainder fed back into the next. Early alarms do
 * several cheap windows; late alarms do one; the worst alarm is bounded by
 * the budget at ANY dump size.
 *
 * Budgeting is by modeled work units, not a clock (none advances during sync
 * CPU): the prefix discard is charged up front at the discard rate — the
 * worst case, a fresh alarm re-streaming from byte 0 — and each window is
 * charged at the gzip rate before it starts. When the next full window would
 * overrun, the window shrinks: the largest windowRaw/2^k not below memberRaw
 * whose projected cost fits. A fresh alarm always cuts at least one window,
 * even over budget — progress over purity — and the memberRaw floor bounds
 * that window's gzip cost to under a second.
 *
 * `commit` MUST persist each window before returning (the coordinator wraps
 * it in transactionSync): only one window's members are ever held in memory —
 * two would flirt with the 128MB isolate cap.
 */
export async function recodeAlarm(
	source: AsyncIterable<Uint8Array>,
	rawDone: number,
	commit: (window: RecodeResult) => void | Promise<void>,
	opts: RecodeAlarmOptions = {},
): Promise<RecodeAlarmProgress> {
	const budget = opts.budgetSeconds ?? RECODE_ALARM_BUDGET_SECONDS;
	const windowRaw = opts.windowRaw ?? RECODE_WINDOW_RAW;
	const memberRaw = opts.memberRaw ?? MEMBER_RAW_BYTES;
	const gzipRate = opts.gzipSecondsPerGib ?? RECODE_GZIP_SECONDS_PER_GIB;
	const discardRate = opts.discardSecondsPerGib ?? RECODE_DISCARD_SECONDS_PER_GIB;
	const gzipCost = (bytes: number) => (bytes / GIB) * gzipRate;

	// The prefix charge, up front: even a mid-phase alarm re-streams from byte
	// 0 and discards to the checkpoint before its first window.
	let spent = (rawDone / GIB) * discardRate;
	let cur = rawDone;
	let windows = 0;
	let carry: Uint8Array | undefined;
	const it = source[Symbol.asyncIterator]();
	try {
		for (;;) {
			// Largest window — halving from windowRaw, floored at one member —
			// whose projected gzip cost fits the remaining budget.
			let units = Math.max(1, Math.floor(windowRaw / memberRaw));
			while (units > 1 && gzipCost(units * memberRaw) > budget - spent) units >>= 1;
			if (windows > 0 && gzipCost(units * memberRaw) > budget - spent) break;
			const result = await recodeWindow(
				resumedSource(carry, it),
				cur,
				units * memberRaw,
				memberRaw,
				windows === 0 ? rawDone : 0,
			);
			await commit(result);
			windows += 1;
			spent += gzipCost(result.rawEnd - cur);
			cur = result.rawEnd;
			carry = result.carry;
			if (result.exhausted) return { windows, rawEnd: cur, exhausted: true };
		}
	} finally {
		// Close the underlying stream (releases the coordinator's reader lock)
		// exactly once, here — recodeWindow never sees a `return` to call.
		await it.return?.();
	}
	return { windows, rawEnd: cur, exhausted: false };
}

/**
 * One window's view of the shared alarm stream: a previous window's carry
 * first, then the live iterator — exposed WITHOUT a `return` method, so
 * recodeWindow's early `break` (which would close an async generator and
 * release the coordinator's reader lock mid-alarm) cannot end the stream the
 * next window still needs.
 */
function resumedSource(carry: Uint8Array | undefined, it: AsyncIterator<Uint8Array>): AsyncIterable<Uint8Array> {
	let head = carry;
	return {
		[Symbol.asyncIterator]: () => ({
			next: (): Promise<IteratorResult<Uint8Array>> => {
				if (head) {
					const value = head;
					head = undefined;
					return Promise.resolve({ value, done: false });
				}
				return it.next();
			},
		}),
	};
}

/**
 * Stream decompressed bytes from consecutive members, starting `skip` raw bytes
 * into member `startSeq`. Ends when `readMember` has no next member — members
 * are contiguous by construction, so a gap IS the end.
 */
export async function* memberBytes(
	readMember: (seq: number) => Uint8Array | null,
	startSeq: number,
	skip: number,
): AsyncGenerator<Uint8Array> {
	let toSkip = skip;
	for (let seq = startSeq; ; seq++) {
		const member = readMember(seq);
		if (member === null) return;
		for await (const chunk of gunzipMember(member)) {
			if (toSkip >= chunk.length) {
				toSkip -= chunk.length;
				continue;
			}
			yield toSkip > 0 ? chunk.subarray(toSkip) : chunk;
			toSkip = 0;
		}
	}
}

/** Pass a byte stream through, discarding the first `skip` bytes — the
 * non-recoded kinds' answer to a raw-offset resume (a linear discard, which is
 * exactly the cost profile those kinds are small enough to tolerate). */
export async function* skipBytes(source: AsyncIterable<Uint8Array>, skip: number): AsyncGenerator<Uint8Array> {
	let toSkip = skip;
	for await (const chunk of source) {
		if (toSkip >= chunk.length) {
			toSkip -= chunk.length;
			continue;
		}
		yield toSkip > 0 ? chunk.subarray(toSkip) : chunk;
		toSkip = 0;
	}
}
