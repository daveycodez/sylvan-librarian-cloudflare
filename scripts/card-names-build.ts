// The card-names blob (src/engine/card-names.ts, backlog n8) from the native builder's
// `card-names.tsv` sidecar — shared by both deploy-path seeders and the import harness's parity check.
//
// The sidecar is every partition's served `(collated, printed)` pairs as the engine read them off the
// archives it had just built (`build_store_partitioned_spilled`, engine/builder/src/lib.rs), partition
// after partition. `encodeCardNames` — the nightly's own encoder — turns it into the blob, so a
// deploy-seeded build and a nightly build of the same corpus publish the same bytes.
//
// Absent sidecar is NOT an error: a build dir from a builder before n8 publishes no blob, and
// /cards/autocomplete keeps fanning out across every partition, as it did before.

import { existsSync, readFileSync } from "node:fs";
import { cardNamesCount, encodeCardNames } from "../src/engine/card-names";

export const CARD_NAMES_FILE = "card-names.tsv";

/** The raw (uncompressed) blob for a build dir, or null when the builder wrote no sidecar. */
export function cardNamesFromBuildDir(dir: string): { raw: Uint8Array; count: number } | null {
	const path = `${dir}/${CARD_NAMES_FILE}`;
	if (!existsSync(path)) return null;
	const raw = encodeCardNames([new Uint8Array(readFileSync(path))]);
	return { raw, count: cardNamesCount(raw) };
}
