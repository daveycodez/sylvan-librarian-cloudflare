// The partitioned build+publish loop's durable state (src/import-publish.ts):
// N chosen once and pinned, one pp_publish value carrying every partition's
// publish cursor, resume mid-partition and mid-chunk, and the SAFE-cut restart
// scoped to a single partition's record.
//
// The publish driver below mirrors stepPublish the way publish-notify.test.ts
// mirrors stepNotify: the coordinator is a Durable Object wrapped in an alarm
// chain, so driving the real phase would mean standing up SQLite and the phase
// machine to test the state transitions. Every "alarm" round-trips the state
// through serialize/parse, because that is exactly what the real loop does —
// an alarm that resumes from anything but the persisted bytes is the bug class
// pp_publish exists to close.

import { describe, expect, test } from "bun:test";
import { assembleChunk, KV_CHUNK_BYTES, KV_CHUNK_BYTES_SAFE, type StagedRow } from "../../src/engine/store-kv";
import {
	advanceToNextPartition,
	completePartitionPublish,
	currentRecord,
	DRAFT_TO_STORE_RATIO,
	initialPpPublish,
	MAX_PARTITION_COUNT,
	MIN_PARTITION_COUNT,
	type PpPublish,
	parsePpPublish,
	partitionCountFor,
	publishChunkTotal,
	recordBuild,
	recordChunk,
	restartAtSafeCut,
	serializePpPublish,
	TARGET_PARTITION_BYTES,
} from "../../src/import-publish";

/** The persistence boundary: what every alarm transition does to the state. */
const roundTrip = (state: PpPublish): PpPublish => parsePpPublish(serializePpPublish(state)) as PpPublish;

describe("partitionCountFor (Decision 3b)", () => {
	test("derives N from the projection: staged bytes × ratio / target, rounded up", () => {
		// The gen-19 production shape: ~88MB of staged drafts projects tiny under
		// the measured multilingual ratio — the floor holds it at 2. (An
		// English-only corpus never reaches this code in production; the floor is
		// what makes that safe.)
		expect(partitionCountFor(88_000_000)).toBe(2);
		// THE G2-measured shape: the real all_cards corpus staged 1,480.8MB of
		// drafts and built ~353MB of archives — at the 43MB target that is nine
		// partitions, each a single KV chunk.
		expect(partitionCountFor(1_480_683_467)).toBe(9);
		// And the arithmetic itself, at a point where no clamp is near.
		const staged = 2_500_000_000;
		expect(partitionCountFor(staged)).toBe(
			Math.ceil(Math.ceil(staged * DRAFT_TO_STORE_RATIO) / TARGET_PARTITION_BYTES),
		);
	});

	test("the target stays inside one KV chunk", () => {
		// A partition over the chunk cut takes a second chunk, and chunks load
		// strictly in sequence — so crossing this line costs a sequential KV round
		// trip on every cold load of that partition. The real corpus caught it:
		// at a 48MB target, five of eight partitions took a nearly-empty second
		// chunk (13 chunks where the design says one per partition).
		expect(TARGET_PARTITION_BYTES).toBeLessThanOrEqual(KV_CHUNK_BYTES);
	});

	test("clamps to the floor — an N=1 store would be an unsplit archive in disguise", () => {
		expect(partitionCountFor(0)).toBe(MIN_PARTITION_COUNT);
		expect(partitionCountFor(1_000)).toBe(MIN_PARTITION_COUNT);
	});

	test("clamps to the ceiling — a runaway projection must not amplify itself", () => {
		expect(partitionCountFor(10_000_000_000)).toBe(MAX_PARTITION_COUNT);
	});

	test("garbage input is an error, not a partition count", () => {
		expect(() => partitionCountFor(Number.NaN)).toThrow(/cannot size/);
		expect(() => partitionCountFor(-1)).toThrow(/cannot size/);
	});
});

describe("the pp_publish value", () => {
	test("N and the loop position survive the persistence boundary exactly", () => {
		// THE pinning property (plan B3): built_at and N must not fork across a
		// mid-loop restart. N lives as partitions.length — one representation, no
		// second copy to drift — so surviving serialize/parse IS surviving the
		// restart.
		let state = initialPpPublish(8);
		state.partition = 5;
		state.step = "reorder";
		state = roundTrip(state);
		expect(state.partitions.length).toBe(8);
		expect(state.partition).toBe(5);
		expect(state.step).toBe("reorder");
	});

	test("absent state is 'the loop has not started', never a default", () => {
		expect(parsePpPublish(null)).toBeNull();
	});

	test("a malformed value is an error, not a silent restart from partition 0", () => {
		// Treating bad bytes as absent would republish partition 0 over chunk keys
		// that already exist — the exact resume-from-stale-cursor bug this value
		// exists to make unrepresentable.
		expect(() => parsePpPublish('{"partition":9,"step":"agg","partitions":[{}]}')).toThrow(/malformed/);
		expect(() => parsePpPublish('{"partition":0}')).toThrow(/malformed/);
	});

	test("recordBuild arms the publish with a zeroed cursor at the ambitious cut", () => {
		const state = initialPpPublish(2);
		// Dirty the record the way an earlier partition's life cycle would.
		const rec = currentRecord(state);
		rec.chunks_published = 3;
		rec.cursor_seq = 7;
		rec.cursor_off = 123;
		rec.gzip_bytes = 999;
		rec.cut = KV_CHUNK_BYTES_SAFE;
		recordBuild(state, 1000, 10, 30);
		expect(currentRecord(state)).toEqual({
			store_bytes: 1000,
			card_count: 10,
			printing_count: 30,
			chunk_count: 0,
			chunks_published: 0,
			cursor_seq: 0,
			cursor_off: 0,
			cut: KV_CHUNK_BYTES,
			gzip_bytes: 0,
		});
		expect(state.step).toBe("publish");
	});

	test("the SAFE-cut restart resets ONLY the current partition's record", () => {
		// Partition 0 published at the ambitious cut; partition 1 compresses badly.
		// Partition 0's finished record — already stamped into chunk keys and about
		// to be stamped into the manifest — must not move.
		const state = initialPpPublish(2);
		recordBuild(state, 1000, 10, 30);
		recordChunk(state, { seq: 4, off: 0 }, 400);
		completePartitionPublish(state);
		const done = structuredClone(state.partitions[0]);
		expect(advanceToNextPartition(state)).toBe(true);
		recordBuild(state, 2000, 20, 60);
		recordChunk(state, { seq: 2, off: 50 }, 300);
		restartAtSafeCut(state);
		expect(currentRecord(state).cut).toBe(KV_CHUNK_BYTES_SAFE);
		expect(currentRecord(state).chunks_published).toBe(0);
		expect(currentRecord(state).cursor_seq).toBe(0);
		expect(currentRecord(state).cursor_off).toBe(0);
		expect(currentRecord(state).gzip_bytes).toBe(0);
		// The build outputs survive the restart — only the publish progress resets.
		expect(currentRecord(state).store_bytes).toBe(2000);
		expect(state.partitions[0]).toEqual(done);
	});

	test("advanceToNextPartition stops at the last partition without mutating", () => {
		const state = initialPpPublish(2);
		expect(advanceToNextPartition(state)).toBe(true);
		expect(state.partition).toBe(1);
		expect(advanceToNextPartition(state)).toBe(false);
		// Still addressing the last partition, so the manifest assembly that
		// follows the `false` reads a valid current record.
		expect(state.partition).toBe(1);
	});
});

// ─── the publish loop, driven the way the alarms drive it ────────────────────

/** Deterministic archive bytes for partition k, checkable byte by byte. */
function archiveFor(k: number, length: number): Uint8Array {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 31 + k * 7 + (i >> 8)) & 0xff;
	return out;
}

/** The archive as chunk_staging rows (the DO stages ~1.9MB rows; here 33 bytes so grids misalign). */
function stagedRowsFor(archive: Uint8Array, rowBytes = 33): StagedRow[] {
	const rows: StagedRow[] = [];
	for (let at = 0; at < archive.length; at += rowBytes) {
		rows.push({ seq: rows.length, bytes: archive.subarray(at, Math.min(at + rowBytes, archive.length)) });
	}
	return rows;
}

interface DriveResult {
	/** Publish-phase alarms consumed (chunk slices + completion slices). */
	alarms: number;
	/** Raw bytes per published chunk key. */
	published: Map<string, Uint8Array>;
	/** True once the manifest write ran (the last partition's completion slice). */
	manifestWritten: boolean;
	state: PpPublish;
}

/**
 * stepPublish's slice loop, mirrored: one chunk (or one completion) per alarm,
 * the state round-tripped through its serialized form between alarms.
 *
 * `cut` stands in for KV_CHUNK_BYTES at test scale; "gzip" is identity, so the
 * published bytes are directly comparable to the archives.
 */
function drivePublish(
	state: PpPublish,
	archives: Uint8Array[],
	cut: number,
	opts?: { maxAlarms?: number },
): DriveResult {
	const published = new Map<string, Uint8Array>();
	let alarms = 0;
	let manifestWritten = false;
	const max = opts?.maxAlarms ?? 1000;
	while (alarms < max) {
		state = roundTrip(state); // the persistence boundary between alarms
		const rec = currentRecord(state);
		if (rec.store_bytes === 0) {
			// The partition's "build alarm": record its outputs and arm the publish.
			// Not counted — this drives the publish phase only.
			recordBuild(state, (archives[state.partition] as Uint8Array).length, 1, 1);
			currentRecord(state).cut = cut;
			continue;
		}
		alarms += 1;
		const total = publishChunkTotal(state);
		if (rec.chunks_published < total) {
			const archive = archives[state.partition] as Uint8Array;
			const want = Math.min(rec.cut, rec.store_bytes - rec.chunks_published * rec.cut);
			const rows = stagedRowsFor(archive);
			const { bytes, cursor } = assembleChunk(want, { seq: rec.cursor_seq, off: rec.cursor_off }, (fromSeq, limit) =>
				rows.filter((r) => r.seq >= fromSeq).slice(0, limit),
			);
			published.set(`p${state.partition}:${rec.chunks_published}`, bytes);
			recordChunk(state, cursor, bytes.length);
			continue;
		}
		completePartitionPublish(state);
		if (!advanceToNextPartition(state)) {
			manifestWritten = true;
			break;
		}
	}
	return { alarms, published, manifestWritten, state };
}

const concat = (parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

describe("the publish loop across alarms", () => {
	test("every partition's chunks reassemble to its own archive, byte for byte", () => {
		const archives = [archiveFor(0, 900), archiveFor(1, 750), archiveFor(2, 400)];
		const { published, manifestWritten, state } = drivePublish(initialPpPublish(3), archives, 400);
		expect(manifestWritten).toBe(true);
		for (let k = 0; k < archives.length; k++) {
			const rec = state.partitions[k];
			const chunks = Array.from({ length: rec?.chunk_count ?? 0 }, (_, i) => published.get(`p${k}:${i}`) as Uint8Array);
			expect(concat(chunks)).toEqual(archives[k] as Uint8Array);
		}
	});

	test("N=8 partitions of 2 chunks each is 24 publish alarms, manifest on the last", () => {
		// The alarm-count sanity (plan B3 budgets ~360-380 alarms/night total):
		// per partition, one alarm per chunk plus one completion alarm; the LAST
		// completion also writes the manifest rather than spending a 25th alarm.
		const archives = Array.from({ length: 8 }, (_, k) => archiveFor(k, 800));
		const { alarms, manifestWritten } = drivePublish(initialPpPublish(8), archives, 400);
		expect(alarms).toBe(8 * (2 + 1));
		expect(manifestWritten).toBe(true);
	});

	test("resume mid-partition: a restart between alarms loses nothing", () => {
		// drivePublish round-trips the state before EVERY alarm, so this asserts
		// the loop's whole progress is reconstructible from the one persisted
		// value at every boundary — including between partitions. The dedicated
		// case here: stop the world after partition 0 finished and partition 1
		// has one chunk in KV, then finish from the serialized state alone.
		const archives = [archiveFor(0, 800), archiveFor(1, 800)];
		const first = drivePublish(initialPpPublish(2), archives, 400, { maxAlarms: 4 });
		expect(first.manifestWritten).toBe(false);
		expect(first.state.partition).toBe(1);
		const resumed = drivePublish(parsePpPublish(serializePpPublish(first.state)) as PpPublish, archives, 400);
		expect(resumed.manifestWritten).toBe(true);
		const all = new Map([...first.published, ...resumed.published]);
		for (let k = 0; k < 2; k++) {
			expect(concat([all.get(`p${k}:0`) as Uint8Array, all.get(`p${k}:1`) as Uint8Array])).toEqual(
				archives[k] as Uint8Array,
			);
		}
	});

	test("resume mid-chunk: a put whose marker rolled back re-puts identical bytes", () => {
		// The idempotence stepPublish relies on: the KV put landed, the alarm died
		// before the transaction, and the retry must produce the SAME bytes for
		// the SAME key — the cursor lives in the record, so re-assembling from the
		// un-advanced cursor is deterministic. 33-byte staging rows against a
		// 400-byte cut guarantee the boundary falls mid-row (400 % 33 != 0).
		const archive = archiveFor(0, 900);
		const state = initialPpPublish(2);
		recordBuild(state, archive.length, 1, 1);
		currentRecord(state).cut = 400;
		const rows = stagedRowsFor(archive);
		const read = (fromSeq: number, limit: number) => rows.filter((r) => r.seq >= fromSeq).slice(0, limit);
		const rec = currentRecord(state);
		const attempt1 = assembleChunk(400, { seq: rec.cursor_seq, off: rec.cursor_off }, read);
		// The marker rolls back: recordChunk never runs. The retry alarm reads the
		// same persisted cursor...
		const replayed = roundTrip(state);
		const rec2 = currentRecord(replayed);
		const attempt2 = assembleChunk(400, { seq: rec2.cursor_seq, off: rec2.cursor_off }, read);
		expect(attempt2.bytes).toEqual(attempt1.bytes);
		expect(attempt2.cursor).toEqual(attempt1.cursor);
		// ...and once the marker DOES commit, the next chunk starts mid-row.
		recordChunk(replayed, attempt2.cursor, attempt2.bytes.length);
		expect(currentRecord(replayed).cursor_off).toBeGreaterThan(0);
	});
});
