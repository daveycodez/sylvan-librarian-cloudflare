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

import type { StoreManifest, StoreManifestFamily } from "./types";

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

// ── Families: one contiguous run of partitions per language ──────────────────
//
// A single-family store (no `families` on the manifest) is one run covering every partition, so
// every caller below works unchanged on the layout this deployment serves today. With families,
// a search addresses its language's run alone: the English default lane is a few partitions and
// each other language one or two, whatever the whole store's count grows to. The by-id routes are
// unaffected — the routing filter hints a GLOBAL partition index — and the union of every family
// is what `include_multilingual` fans out across.

/** The default lane's language — the family that holds every `default_cards` row. */
export const DEFAULT_FAMILY_LANG = "en";

/** The manifest's families, or the one implicit family of a single-family store. */
export function familiesOf(manifest: Pick<StoreManifest, "partition_count" | "families">): StoreManifestFamily[] {
	const explicit = manifest.families;
	if (explicit && explicit.length > 0) return explicit;
	return [{ lang: DEFAULT_FAMILY_LANG, start: 0, count: manifest.partition_count ?? 0 }];
}

/** The default family: first in the list, `en`, holds every card's canonical representative. */
export function defaultFamilyOf(manifest: Pick<StoreManifest, "partition_count" | "families">): StoreManifestFamily {
	return familiesOf(manifest)[0] as StoreManifestFamily;
}

/** The family holding `lang`'s printings, or null when the store has none for that language. */
export function familyForLang(
	manifest: Pick<StoreManifest, "partition_count" | "families">,
	lang: string,
): StoreManifestFamily | null {
	return familiesOf(manifest).find((f) => f.lang === lang) ?? null;
}

/** The family a global partition index belongs to, or null when the index is outside every run. */
export function familyOfPartition(
	manifest: Pick<StoreManifest, "partition_count" | "families">,
	partition: number,
): StoreManifestFamily | null {
	return familiesOf(manifest).find((f) => partition >= f.start && partition < f.start + f.count) ?? null;
}

/** Every global partition index of a family, in order. */
export function partitionsOf(family: StoreManifestFamily): number[] {
	return Array.from({ length: family.count }, (_, i) => family.start + i);
}

/** The global partition owning `oracleId` within `family`. */
export function partitionOfOracleIdIn(family: StoreManifestFamily, oracleId: string): number {
	return family.start + partitionOfOracleId(oracleId, family.count);
}

/**
 * What a pinned search is pinned AGAINST: the layout — partition count and families — as one
 * string. Two builds cut the same way pin-compatibly (the owner of an oracle id is the same
 * partition in both), which is what lets a request from an isolate whose manifest is a minute
 * behind a nightly swap still be answered exactly by the owner it computed.
 */
export function layoutKeyOf(manifest: Pick<StoreManifest, "partition_count" | "families">): string {
	return `${manifest.partition_count ?? 0}|${familiesOf(manifest)
		.map((f) => `${f.lang}:${f.start}:${f.count}`)
		.join(",")}`;
}

/** The gather coordinator for a query, spread across `family`'s partitions. */
export function gatherPartitionIn(family: StoreManifestFamily, query: string): number {
	return family.start + gatherPartitionOf(query, family.count);
}
