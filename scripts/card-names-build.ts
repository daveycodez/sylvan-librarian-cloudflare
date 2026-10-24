// The card-names blob (src/engine/card-names.ts, backlog n8) from the native builder's
// `card-names.tsv` sidecar — shared by both deploy-path seeders and the import harness's parity check.
//
// The sidecar is every partition's served `(collated, printed)` pairs as the engine read them off the
// archives it had just built (`build_store_partitioned_spilled`, engine/builder/src/lib.rs), partition
// after partition. `encodeCardNames` — the nightly's own encoder — turns it into the format-2 blob,
// and `cardNamesV3` through the nightly's own converter (scripts/names-codec.ts, the same export of
// the same committed import module) into format 3, so a deploy-seeded build and a nightly build of
// the same corpus publish the same bytes.
//
// Absent sidecar is NOT an error: a build dir from a builder before n8 publishes no blob, and
// /cards/autocomplete keeps fanning out across every partition, as it did before.

import { existsSync, readFileSync } from "node:fs";
import { cardNamesCount, cardNamesV3, encodeCardNames } from "../src/engine/card-names";
import { namesCodec } from "./names-codec";

export const CARD_NAMES_FILE = "card-names.tsv";

/** The raw (uncompressed) format-3 blob for a build dir, or null when the builder wrote no sidecar. */
export function cardNamesFromBuildDir(dir: string): { raw: Uint8Array; count: number } | null {
	const path = `${dir}/${CARD_NAMES_FILE}`;
	if (!existsSync(path)) return null;
	const v2 = encodeCardNames([new Uint8Array(readFileSync(path))]);
	let raw: Uint8Array;
	try {
		raw = cardNamesV3(v2, namesCodec());
	} catch (err) {
		// The nightly's policy (import-coordinator.ts publishCardNames): the format-2 blob, which every
		// Worker reads, rather than none — names loads are slower, answers are the same.
		console.warn(`card names: format 3 failed (${err}); publishing format 2`);
		raw = v2;
	}
	return { raw, count: cardNamesCount(raw) };
}
