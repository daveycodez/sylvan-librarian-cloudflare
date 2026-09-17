// The nightly run's ONE phase chain (src/import-phases.ts).
//
// This suite used to pin a fork: two dump lists and two chains selected by an
// env var, with the expensive failure being a run that switched halfway and
// published a chimera. The fork is deleted, so what is left to pin is that the
// single chain still reaches every phase in the right order — every fetched dump
// is handed on, the streamed dumps (all_cards, default_cards) are never fetched
// at all, and the chain terminates at `canonical` rather than escaping into a
// phase name nothing routes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DUMP_KINDS,
	type DumpKind,
	FETCHED_KINDS,
	firstFetchPhase,
	phaseAfterFetch,
	phaseAfterStaged,
	STREAMED_KINDS,
	TRANSFORM_KIND,
} from "../../src/import-phases";
import { MIN_PARTITION_COUNT, partitionCountFor } from "../../src/import-publish";

/** Walk the chain from the first fetch to the canonical phase, exactly as
 * listing and advanceFetch drive it: fetch → fetch → … → canonical. */
function walkChain(): string[] {
	const phases: string[] = [];
	let phase: string = firstFetchPhase();
	// A chain that failed to terminate would otherwise hang the suite rather than
	// fail it; the bound is generous against the six dumps.
	for (let step = 0; phase !== "canonical"; step++) {
		if (step > DUMP_KINDS.length * 2) throw new Error(`chain did not reach canonical, stuck at ${phase}`);
		phases.push(phase);
		if (phase.startsWith("fetch:")) {
			phase = phaseAfterFetch(phase.slice("fetch:".length) as DumpKind);
		} else {
			throw new Error(`chain escaped into ${phase}`);
		}
	}
	phases.push("canonical");
	return phases;
}

describe("the phase chain", () => {
	test("fetches only the small dumps, in order, straight into canonical — no recode detour", () => {
		expect(walkChain()).toEqual([
			"fetch:oracle_tags",
			"fetch:art_tags",
			"fetch:oracle_cards",
			"fetch:rulings",
			"canonical",
		]);
		for (const kind of DUMP_KINDS) expect(phaseAfterFetch(kind).startsWith("recode:")).toBe(false);
	});

	test("the two big dumps are streamed, never fetched: the transform corpus and the canonical set's source", () => {
		// ~392MB of all_cards (plus ~400MB of it recoded) and ~78MB of default_cards
		// used to be written into Durable Object storage and deleted again; the
		// phases that read them now stream them from Scryfall (openDumpStream).
		expect([...STREAMED_KINDS].sort()).toEqual(["all_cards", "default_cards"]);
		expect(STREAMED_KINDS).toContain(TRANSFORM_KIND);
		expect(TRANSFORM_KIND).toBe("all_cards");
		for (const kind of STREAMED_KINDS) expect(FETCHED_KINDS).not.toContain(kind);
		expect([...FETCHED_KINDS, ...STREAMED_KINDS].sort()).toEqual([...DUMP_KINDS].sort());
	});

	test("the canonical phase is reached before transform, always", () => {
		// Not optional, and this is the assertion the deleted legacy arm used to
		// carry: the wasm transform marks each row's is_canonical by id-membership
		// in the set this phase builds, and the engine routes non-canonical rows
		// into its foreign annex. An empty set would annex EVERY row and build a
		// store whose default searches return nothing.
		expect(walkChain().at(-1)).toBe("canonical");
		expect(phaseAfterStaged(FETCHED_KINDS[FETCHED_KINDS.length - 1] as DumpKind)).toBe("canonical");
	});
});

describe("the build loop's width", () => {
	test("the partition count is auto-scaled, never a constant, with a floor of 2", () => {
		// The floor is what guarantees partition boundaries are exercised on every
		// run — there is no N=1 shape any more for a run to collapse into.
		expect(partitionCountFor(0)).toBe(MIN_PARTITION_COUNT);
		expect(MIN_PARTITION_COUNT).toBe(2);
		// The measured 2026-08-15 corpus: 1,480,683,467 draft bytes → N=9 at the
		// 43MB target (one KV chunk per partition — see TARGET_PARTITION_BYTES).
		expect(partitionCountFor(1_480_683_467)).toBe(9);
	});
});

// The coordinator's side of the contract, pinned against its source. There is
// no run mode to persist and no flag to read, so what these assert is the
// ABSENCE of the machinery that used to fork a run — a re-introduced env read
// here is how the dual window would grow back.
describe("the coordinator runs one pipeline", () => {
	const src = readFileSync(join(import.meta.dir, "../../src/import-coordinator.ts"), "utf8");

	test("no run mode is selected, persisted or read back", () => {
		expect(src).not.toContain("runModeFor");
		expect(src).not.toContain("requireMode");
		expect(src).not.toContain("RUN_MODE_META_KEY");
		expect(src).not.toContain("partitionedStoreEnabled");
		expect(src).not.toContain("PARTITIONED_STORE");
	});

	test("the fetch list and transform corpus are the module's constants", () => {
		expect(src).toContain("DUMP_KINDS");
		expect(src).toContain("TRANSFORM_KIND");
	});

	test("the publish writes the one manifest key", () => {
		// writeManifest derives nothing from a mode any more, and the notify phase
		// pushes what it just wrote from the same single key.
		expect(src).not.toContain("manifestKeyFor");
		expect(src).toContain("MANIFEST_KEY");
	});
});

// Staging is retired in bounded slices, never in one commit (src/import-purge.ts).
// On 2026-09-15 the partition's ~300MB completion delete wedged the object for
// hours behind its own flush, every partition, every day: the whole Durable
// Object duration bill on the free account. These pin the shape of the fix
// against the source, the way the block above pins the absence of run modes.
describe("the coordinator never deletes staging in one commit", () => {
	const src = readFileSync(join(import.meta.dir, "../../src/import-coordinator.ts"), "utf8");

	test("the big dumps are streamed, never staged: no recode phase, no member staging", () => {
		expect(src).toContain("openDumpStream(corpus, rawOffset)");
		expect(src).toContain('openDumpStream("default_cards", rawDone)');
		expect(src).not.toContain("INSERT INTO stage_members");
		expect(src).not.toContain("stepRecode");
	});

	test("the purge is its own sliced phase, and the manifest write follows it", () => {
		expect(src).toContain('case "purge_staging":');
		expect(src).toContain('case "manifest":');
		expect(src).toContain("stepPurgeStaging()");
		expect(src).toContain("stepManifest()");
	});

	test("no whole-table, whole-partition or whole-kind staging delete remains", () => {
		expect(src).not.toContain("resetStaging");
		expect(src).not.toContain('"DELETE FROM spill_batches"');
		expect(src).not.toContain('"DELETE FROM ordered_rows"');
		expect(src).not.toContain('"DELETE FROM draft_parts WHERE partition = ?"');
		// The phase-boundary drops of a whole dump kind (recode, canonical,
		// transform, tags) go through the blobs purge. The one `kind = ?` delete
		// left is the rotated-dump restart in stepFetch, a warn path that drops
		// what a restarted download has fetched so far.
		expect(src.match(/"DELETE FROM stage_blobs WHERE kind = \?"/g)?.length ?? 0).toBe(1);
		expect(src).not.toContain('"DELETE FROM stage_members WHERE kind = ?"');
		// The one remaining unsliced clear is the build retry's chunk_staging
		// (≤ ~70MB, under the commit size the bucket phase proves), and it is timed.
		expect(src.match(/DELETE FROM chunk_staging"/g)?.length ?? 0).toBe(1);
	});

	test("every purge goes through the one bounded slice", () => {
		expect(src).toContain("PURGE_SLICE_BYTES");
		expect(src).toContain('beginPurge("partition")');
		expect(src).toContain('beginPurge("rewind")');
		expect(src).toContain('beginPurge("reset")');
		// Only the tags boundary stages dumps any more; all_cards and default_cards are streamed.
		expect(src.match(/beginPurge\("blobs"/g)?.length ?? 0).toBe(1);
	});

	test("the alarm watches itself: one abort, and a timer that is always cleared", () => {
		expect(src.match(/this\.ctx\.abort\(/g)?.length ?? 0).toBe(1);
		expect(src).toContain("clearTimeout(timer)");
		expect(src).toContain("ALARM_WATCHDOG_MS");
	});
});
