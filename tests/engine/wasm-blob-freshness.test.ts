// THE COMMITTED WASM BLOBS MUST HAVE BEEN BUILT FROM THIS SOURCE TREE.
//
// This is the check whose absence took the site down on 2026-08-27, and on the format bump before
// it. `engine/wasm/pkg/sylvan_engine_wasm_bg.wasm` is a committed artifact — wrangler.jsonc keeps
// it that way so Workers Builds needs no Rust toolchain — and NOTHING rebuilds it. Workers Builds
// rebuilds the native store builder, republishes the store at whatever ARCHIVE_FORMAT_VERSION the
// source says, and ships whichever engine blob was last committed. When those two numbers disagree
// the engine cannot read its own store and every engine-backed route answers 500.
//
// It lives in `bun test tests`, which the `js` CI job runs on every pull request, so a stale blob
// is a red check on the PR instead of an outage after the merge.
//
// WHY THIS AND NOT A REBUILD-AND-DIFF: wasm-pack output moves with the toolchain, the wasm-opt
// version and embedded paths, so rebuilding in CI and diffing the bytes would go red for reasons
// unrelated to staleness. Hashing the INPUTS is deterministic on every machine and needs no Rust,
// no corpus and no store.
//
// WHY NOT A REAL QUERY: loading a store into the engine and running a search would be a stronger
// check, and `tests/routes/card-object-parity.test.ts` shows it is possible — it instantiates this
// very blob. But it needs a store built by the current native builder, which needs Rust and a
// corpus in the `js` job. The staleness invariant is what actually failed twice, and it is
// checkable for free.

import { describe, expect, test } from "bun:test";
import {
	BLOBS,
	computeBlobHashes,
	computeSourceHash,
	readArchiveFormatVersion,
	readProvenance,
	sourceInputs,
} from "../../scripts/wasm-provenance";

const REBUILD =
	"run `bun run build` and commit engine/wasm/pkg/, engine/wasm-import/pkg/ and engine/wasm-provenance.json";

describe("committed wasm blobs are built from this source tree", () => {
	test("the provenance record exists", () => {
		expect(readProvenance(), `engine/wasm-provenance.json is missing or unreadable — ${REBUILD}`).not.toBeNull();
	});

	// THE ONE THAT MATTERS. A blob built against an older ARCHIVE_FORMAT_VERSION cannot read the
	// store the deploy publishes, and the failure is total rather than partial: not a wrong answer
	// on some query, but every engine call failing while KV-only routes like /sets stay 200.
	test("the blobs were built at the current ARCHIVE_FORMAT_VERSION", () => {
		const provenance = readProvenance();
		expect(provenance).not.toBeNull();
		const current = readArchiveFormatVersion();
		expect(
			provenance?.archive_format_version,
			`the committed wasm engine was built at ARCHIVE_FORMAT_VERSION ${provenance?.archive_format_version} ` +
				`but card_engine/src/lib.rs now declares ${current}. Production would run this engine against a ` +
				`store built at ${current} and every engine-backed route would answer 500 — ${REBUILD}`,
		).toBe(current);
	});

	test("the blobs were built from the current engine sources", () => {
		const provenance = readProvenance();
		expect(provenance).not.toBeNull();
		expect(
			provenance?.source_hash,
			`the Rust sources that compile into the wasm blobs have changed since the blobs were built — ${REBUILD}`,
		).toBe(computeSourceHash());
	});

	test("the committed blobs are the ones the record describes", () => {
		const provenance = readProvenance();
		expect(provenance).not.toBeNull();
		expect(
			provenance?.blob_hashes,
			`a committed .wasm file does not match its recorded hash — it was replaced, truncated, or ` +
				`rebuilt without the record being regenerated. ${REBUILD}`,
		).toEqual(computeBlobHashes());
	});

	// A guard on the guard. If a crate is renamed or a source directory moves and the input list
	// silently goes empty, every hash above still "matches" and the check quietly stops checking.
	test("the source input list is non-trivial and covers both blobs' crates", () => {
		const inputs = sourceInputs();
		expect(inputs.length).toBeGreaterThan(20);
		for (const crate of [
			"vendor/sylvan_librarian/card_engine/src/lib.rs",
			"engine/wasm/src/lib.rs",
			"engine/wasm-import/src",
			"engine/builder/src",
			"engine/inflate/src",
			"Cargo.toml",
			".cargo/config.toml",
			"Cargo.lock",
		]) {
			expect(inputs.some((f) => f.startsWith(crate))).toBe(true);
		}
		// The exact production paths, spelled here rather than read back from the implementation —
		// a wrong two-entry BLOBS list must fail this test, not satisfy a length check.
		expect(BLOBS).toEqual([
			"engine/wasm/pkg/sylvan_engine_wasm_bg.wasm",
			"engine/wasm-import/pkg/sylvan_wasm_import.wasm",
		]);
	});
});
