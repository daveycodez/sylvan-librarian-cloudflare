// The printed-names blob (src/engine/printed-names.ts, backlog x24) from the native builder's
// `printed-names.tsv` sidecar — shared by both deploy-path seeders and the import harness's parity
// check, as card-names-build.ts is for the names blob.
//
// The sidecar is every partition's printed records as the engine read them off the archives it had
// just built (`build_store_partitioned_spilled`, engine/builder/src/lib.rs), partition after
// partition. `encodePrintedNames` — the nightly's own encoder — turns it into the blob, so a
// deploy-seeded build and a nightly build of the same corpus publish the same bytes.
//
// Absent sidecar is NOT an error: a build dir from a builder before x24 publishes no blob, and the
// fuzzy plan keeps asking every partition for containment's printed tier, as it did before.

import { existsSync, readFileSync } from "node:fs";
import { encodePrintedNames, printedNamesCount } from "../src/engine/printed-names";

export const PRINTED_NAMES_FILE = "printed-names.tsv";

/** The raw (uncompressed) blob for a build dir, or null when the builder wrote no sidecar. */
export function printedNamesFromBuildDir(dir: string): { raw: Uint8Array; count: number } | null {
	const path = `${dir}/${PRINTED_NAMES_FILE}`;
	if (!existsSync(path)) return null;
	const raw = encodePrintedNames([new Uint8Array(readFileSync(path))]);
	return { raw, count: printedNamesCount(raw) };
}
