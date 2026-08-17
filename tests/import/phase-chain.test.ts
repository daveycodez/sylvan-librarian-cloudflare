// The nightly run's ONE phase chain (src/import-phases.ts).
//
// This suite used to pin a fork: two dump lists and two chains selected by an
// env var, with the expensive failure being a run that switched halfway and
// published a chimera. The fork is deleted, so what is left to pin is that the
// single chain still reaches every phase in the right order — the recode detour
// sits directly after the all_cards fetch, every fetched dump is handed on, and
// the chain terminates at `canonical` rather than escaping into a phase name
// nothing routes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DUMP_KINDS, type DumpKind, phaseAfterFetch, phaseAfterStaged, TRANSFORM_KIND } from "../../src/import-phases";
import { MIN_PARTITION_COUNT, partitionCountFor } from "../../src/import-publish";

/** Walk the chain from the first fetch to the canonical phase, exactly as
 * advanceFetch/stepRecode drive it: fetch → (recode →) fetch → … → canonical. */
function walkChain(): string[] {
	const phases: string[] = [];
	let phase: string = `fetch:${DUMP_KINDS[0]}`;
	// A chain that failed to terminate would otherwise hang the suite rather than
	// fail it; the bound is generous against the six dumps plus one recode.
	for (let step = 0; phase !== "canonical"; step++) {
		if (step > DUMP_KINDS.length * 2) throw new Error(`chain did not reach canonical, stuck at ${phase}`);
		phases.push(phase);
		if (phase.startsWith("fetch:")) {
			phase = phaseAfterFetch(phase.slice("fetch:".length) as DumpKind);
		} else if (phase.startsWith("recode:")) {
			phase = phaseAfterStaged(phase.slice("recode:".length) as DumpKind);
		} else {
			throw new Error(`chain escaped into ${phase}`);
		}
	}
	phases.push("canonical");
	return phases;
}

describe("the phase chain", () => {
	test("walks every dump in order, recode straight after the all_cards fetch", () => {
		expect(walkChain()).toEqual([
			"fetch:all_cards",
			"recode:all_cards",
			"fetch:default_cards",
			"fetch:oracle_tags",
			"fetch:art_tags",
			"fetch:oracle_cards",
			"fetch:rulings",
			"canonical",
		]);
	});

	test("all_cards is fetched FIRST and is the transform corpus", () => {
		// Largest download, earliest failure — and the dump every draft comes from,
		// so a list that led with anything else would spend the cheap dumps first
		// and discover a rotated all_cards last.
		expect(DUMP_KINDS[0]).toBe("all_cards");
		expect(TRANSFORM_KIND).toBe("all_cards");
		expect(DUMP_KINDS).toContain(TRANSFORM_KIND);
	});

	test("only all_cards takes the recode detour", () => {
		// Recoding is ~8 slices of re-streaming; it exists for the ~392MB dump whose
		// resumes would otherwise be quadratic, not for the small ones.
		for (const kind of DUMP_KINDS) {
			expect(phaseAfterFetch(kind).startsWith("recode:")).toBe(kind === "all_cards");
		}
	});

	test("the canonical phase is reached before transform, always", () => {
		// Not optional, and this is the assertion the deleted legacy arm used to
		// carry: the wasm transform marks each row's is_canonical by id-membership
		// in the set this phase builds, and the engine routes non-canonical rows
		// into its foreign annex. An empty set would annex EVERY row and build a
		// store whose default searches return nothing.
		expect(walkChain().at(-1)).toBe("canonical");
		expect(phaseAfterStaged(DUMP_KINDS[DUMP_KINDS.length - 1] as DumpKind)).toBe("canonical");
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
