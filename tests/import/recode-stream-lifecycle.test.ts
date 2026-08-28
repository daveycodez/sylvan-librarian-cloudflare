// The recode alarm's ONE shared stream, and the lifecycle rules that keep it
// from wedging.
//
// On 2026-08-28 two recode alarms were killed at exactly 899,983ms and
// 899,984ms of wall time having burned 1,675ms and 1,913ms of CPU. Full wall,
// almost no CPU, is not a compute loop: it is a promise that never settled.
// Both had already committed windows before they stopped, so whatever they were
// waiting on, they were waiting on it BETWEEN windows — the exact seam commit
// 5c1860d introduced when it made one alarm cut several windows off a single
// pass over the staged stream.
//
// That seam has three rules, none of them enforced by a type:
//
//   1. recodeWindow's early `break` must NOT close the shared iterator. A
//      `for await ... of` with a `break` calls the iterator's `return` method,
//      and closing an async generator over a ReadableStream releases the
//      reader lock — so the NEXT window would be reading a stream that has
//      already been let go. `resumedSource` exists to prevent that, and it
//      does it by exposing an iterator with no `return` method at all, which
//      is the kind of deliberate omission a later edit silently undoes.
//   2. The iterator must be closed EXACTLY ONCE, by recodeAlarm's `finally`,
//      on every exit — normal, exhausted, or thrown. A leaked-open iterator
//      keeps a reader lock that a later alarm's `getReader()` would await
//      forever, which is precisely a full-wall/no-CPU stall.
//   3. Nothing may call `next()` after that close. A read on a released reader
//      is the other shape that never settles.
//
// The harness cannot reproduce the production stall — nothing outside workerd
// has its I/O semantics — so this suite pins the rules instead, on the real
// recodeAlarm, with a source that reports every call it receives.

import { describe, expect, test } from "bun:test";
import { MEMBER_RAW_BYTES, RECODE_WINDOW_RAW, type RecodeResult, recodeAlarm } from "../../src/import-recode";

/** Deterministic, compressible, JSONL-shaped bytes — the same generator shape
 * recode.test.ts uses, so the two suites describe the same corpus. */
function makeRaw(bytes: number, seed = 11): Uint8Array {
	let s = seed >>> 0;
	const rand = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const lines: string[] = [];
	let total = 0;
	for (let i = 0; total < bytes; i++) {
		const line = `{"object":"card","seq":${i},"name":"card ${i}","pad":"${"x".repeat(Math.floor(rand() * 40))}"}\n`;
		lines.push(line);
		total += line.length;
	}
	return new TextEncoder().encode(lines.join("")).subarray(0, bytes);
}

interface Recorder {
	source: AsyncIterable<Uint8Array>;
	nexts: number;
	returns: number;
	/** next() calls that arrived after return() — rule 3's violation. */
	useAfterClose: number;
	closed: boolean;
}

/**
 * A source that behaves like the real one and remembers how it was treated.
 *
 * Deliberately an OBJECT with an explicit `return`, not an async generator:
 * recodeAlarm's `await it.return?.()` has to find a method to call for the
 * close to be observable at all, and the coordinator's real sources (async
 * generators, which always have one) do.
 */
function recordingSource(bytes: Uint8Array, chunk: number): Recorder {
	const state: Recorder = {
		nexts: 0,
		returns: 0,
		useAfterClose: 0,
		closed: false,
		source: null as unknown as AsyncIterable<Uint8Array>,
	};
	let at = 0;
	state.source = {
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<Uint8Array>> => {
				if (state.closed) state.useAfterClose += 1;
				state.nexts += 1;
				if (at >= bytes.length) return { value: undefined, done: true };
				const end = Math.min(at + chunk, bytes.length);
				const value = bytes.subarray(at, end);
				at = end;
				return { value, done: false };
			},
			return: async (): Promise<IteratorResult<Uint8Array>> => {
				state.returns += 1;
				state.closed = true;
				return { value: undefined, done: true };
			},
		}),
	};
	return state;
}

/** A window small enough to cut several of, still a multiple of the member
 * size — the invariant recodeWindow enforces. */
const MEMBER_RAW = 1024;
const WINDOW_RAW = 2 * MEMBER_RAW;
/** Rates and budget chosen so the alarm stops on BUDGET, mid-stream, with the
 * source still open — the state rule 2 is about. */
const OPTS = {
	windowRaw: WINDOW_RAW,
	memberRaw: MEMBER_RAW,
	gzipSecondsPerGib: 74,
	discardSecondsPerGib: 8.2,
	resumed: true,
};

describe("the recode alarm's shared stream", () => {
	test("cuts several windows off ONE pass — the iterator is never restarted", async () => {
		const raw = makeRaw(10 * MEMBER_RAW);
		const rec = recordingSource(raw, 700);
		const windows: RecodeResult[] = [];
		const progress = await recodeAlarm(rec.source, 0, (w) => void windows.push(w), { ...OPTS, budgetSeconds: 1000 });

		expect(progress.windows).toBeGreaterThan(1);
		expect(progress.exhausted).toBe(true);
		expect(progress.rawEnd).toBe(raw.length);
		// The whole point of 5c1860d: the prefix is paid per ALARM. If a later
		// window had re-opened the source, the bytes would have been re-read
		// from zero and the windows would overlap.
		let expectedStart = 0;
		for (const window of windows) {
			expect(window.rawStart).toBe(expectedStart);
			expectedStart = window.rawEnd;
		}
	});

	test("a window's early break does not close the shared iterator (rule 1)", async () => {
		const raw = makeRaw(10 * MEMBER_RAW);
		const rec = recordingSource(raw, 700);
		let seen = 0;
		await recodeAlarm(
			rec.source,
			0,
			(w) => {
				seen += 1;
				// Every window but the last ended on `break outer`. If that break
				// had closed the shared iterator, the source would be closed here
				// and the NEXT window would read nothing.
				if (!w.exhausted) expect(rec.closed).toBe(false);
			},
			{ ...OPTS, budgetSeconds: 1000 },
		);
		expect(seen).toBeGreaterThan(1);
	});

	test("closes the iterator exactly once, on the budget-stop path (rule 2)", async () => {
		const raw = makeRaw(200 * MEMBER_RAW);
		const rec = recordingSource(raw, 700);
		// A budget that buys a couple of windows out of a stream far longer than
		// that: the alarm returns with the source mid-stream.
		const progress = await recodeAlarm(rec.source, 0, () => {}, { ...OPTS, budgetSeconds: 0.0002 });
		expect(progress.exhausted).toBe(false);
		expect(rec.returns).toBe(1);
		expect(rec.useAfterClose).toBe(0);
	});

	test("closes the iterator exactly once when the stream runs out (rule 2)", async () => {
		const raw = makeRaw(6 * MEMBER_RAW);
		const rec = recordingSource(raw, 512);
		const progress = await recodeAlarm(rec.source, 0, () => {}, { ...OPTS, budgetSeconds: 1000 });
		expect(progress.exhausted).toBe(true);
		expect(rec.returns).toBe(1);
		expect(rec.useAfterClose).toBe(0);
	});

	test("closes the iterator exactly once when a commit throws (rule 2)", async () => {
		const raw = makeRaw(20 * MEMBER_RAW);
		const rec = recordingSource(raw, 700);
		// A commit failure is the realistic mid-alarm throw: the coordinator
		// wraps it in transactionSync, and SQLITE_TOOBIG or a rolled-back
		// transaction surfaces exactly here. The alarm must still let the stream
		// go, or the retry inherits a locked reader.
		await expect(
			recodeAlarm(
				rec.source,
				0,
				() => {
					throw new Error("commit failed");
				},
				{ ...OPTS, budgetSeconds: 1000 },
			),
		).rejects.toThrow("commit failed");
		expect(rec.returns).toBe(1);
		expect(rec.useAfterClose).toBe(0);
	});

	test("never reads past the close, so a released reader is never awaited (rule 3)", async () => {
		const raw = makeRaw(40 * MEMBER_RAW);
		const rec = recordingSource(raw, 333);
		await recodeAlarm(rec.source, 0, () => {}, { ...OPTS, budgetSeconds: 0.0006 });
		expect(rec.closed).toBe(true);
		expect(rec.useAfterClose).toBe(0);
		// And the close really was the LAST thing: one more next() here would be
		// the use-after-close a real ReadableStream never answers.
		const before = rec.nexts;
		await Promise.resolve();
		expect(rec.nexts).toBe(before);
	});

	test("the real member size still divides the real window size", () => {
		// recodeWindow throws on a window that is not a whole number of members,
		// and every checkpoint's correctness rests on that: a misaligned grid
		// makes a resumed alarm recut members at different offsets.
		expect(RECODE_WINDOW_RAW % MEMBER_RAW_BYTES).toBe(0);
	});
});
