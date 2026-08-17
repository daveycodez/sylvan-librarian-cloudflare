/**
 * The TypeScript twin of `card_engine::partition` (vendor/sylvan_librarian/
 * card_engine/src/partition.rs). The Rust builder assigns every card to a
 * partition; this file lets the router compute the same assignment from an
 * oracle_id so single-card routes make exactly one RPC. The two
 * implementations are pinned to each other by
 * tests/engine/partition-hash-vectors.json — if they ever disagree, the router
 * asks the wrong partition and cards silently vanish from results, which is
 * why the vectors are asserted by both `cargo test` and `bun test`.
 *
 * partition_count is never a constant: it comes from the manifest of the
 * generation the request is pinned to (the builder auto-sizes it from the
 * corpus). Callers must pass `manifest.partition_count`, and single-card
 * routes that miss should re-read the manifest and retry once — a stale
 * isolate manifest means a stale modulus.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/** FNV-1a 64 over the ASCII bytes of the lowercase hyphenated oracle_id. */
export function fnv1a64OracleId(oracleId: string): bigint {
	let hash = FNV_OFFSET;
	const lowered = oracleId.toLowerCase();
	for (let i = 0; i < lowered.length; i++) {
		hash ^= BigInt(lowered.charCodeAt(i));
		hash = (hash * FNV_PRIME) & U64;
	}
	return hash;
}

/** The partition owning `oracleId` in a store cut into `partitionCount` partitions. */
export function partitionOfOracleId(oracleId: string, partitionCount: number): number {
	if (!Number.isInteger(partitionCount) || partitionCount <= 0) {
		throw new Error(`partitionCount must be a positive integer, got ${partitionCount}`);
	}
	return Number(fnv1a64OracleId(oracleId) % BigInt(partitionCount));
}

/**
 * The gather partition for a query: a deterministic spread of coordinator work
 * across the N partition objects, so no single partition becomes the region's
 * merge hot spot. Any stable function of the query text works; FNV-1a of the
 * raw string reuses the hash above (the INPUT is not an oracle_id here, and
 * nothing depends on agreement with Rust — this is routing, not addressing).
 */
export function gatherPartitionOf(query: string, partitionCount: number): number {
	if (!Number.isInteger(partitionCount) || partitionCount <= 0) {
		throw new Error(`partitionCount must be a positive integer, got ${partitionCount}`);
	}
	return Number(fnv1a64OracleId(query) % BigInt(partitionCount));
}
