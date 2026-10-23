// The oracle-tags blob (src/engine/oracle-tag-partitions.ts) from the native builder's
// `oracle-tags.tsv` sidecar — shared by both deploy-path seeders and the import harness's parity
// check, as card-names-build.ts is for the names blob.
//
// The sidecar is every partition's oracle tags as the engine read them off the archives it had just
// built (`build_store_partitioned_spilled`, engine/builder/src/lib.rs; card_engine `oracle_tags_of`),
// partition after partition. `encodeOracleTagPartitions` — the nightly's own encoder — turns it into
// the blob, so a deploy-seeded build and a nightly build of the same corpus publish the same bytes.
//
// Absent sidecar is NOT an error: a build dir from a builder before it publishes no blob, and every
// `otag:` search keeps asking every partition, as it did before.

import { existsSync, readFileSync } from "node:fs";
import { encodeOracleTagPartitions, OracleTagPartitions } from "../src/engine/oracle-tag-partitions";
import type { StoreManifest } from "../src/engine/types";

export const ORACLE_TAGS_FILE = "oracle-tags.tsv";

/** The raw (uncompressed) blob for a build dir, or null when the builder wrote no sidecar. */
export function oracleTagsFromBuildDir(
	dir: string,
	manifest: StoreManifest,
): { raw: Uint8Array; count: number } | null {
	const path = `${dir}/${ORACLE_TAGS_FILE}`;
	if (!existsSync(path)) return null;
	const expect = {
		partitionCount: manifest.partition_count as number,
		partitionHash: manifest.partition_hash as string,
	};
	const raw = encodeOracleTagPartitions(
		[new Uint8Array(readFileSync(path))],
		expect.partitionCount,
		expect.partitionHash,
	);
	// The reader's own parse, so a blob it would refuse fails here, at publish time.
	return { raw, count: OracleTagPartitions.parse(raw, expect).size };
}
