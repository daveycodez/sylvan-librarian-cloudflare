// Build a generation's id→partition routing filter from the native builder's
// `routing-keys.tsv` sidecar — shared by both deploy-path seeders.
//
// The sidecar is written by `build_store_partitioned_spilled` (engine/builder/
// src/lib.rs) at the one point where a finalized row and the partition that owns
// it are both in hand: one `<partition>\t<key>` line per addressable id, ~1.23M
// of them on today's corpus. The nightly publisher reaches the same key set from
// the coordinator's corpus-wide scores pass; this is the deploy path's half.
//
// Absent sidecar is NOT an error. A build dir from a builder that predates the
// filter simply publishes no filter, and every bare-id route falls back to the
// N-way fan-out — which is what the deployment did before it existed.

import { existsSync, readFileSync } from "node:fs";
import { buildRoutingFilterFromHashes, RoutingKeyAccumulator } from "../src/engine/routing-filter";
import type { StoreManifest } from "../src/engine/types";

export const ROUTING_KEYS_FILE = "routing-keys.tsv";

/**
 * Read the sidecar and build the filter, or null when the build dir has none.
 *
 * Hashes as it streams rather than collecting the keys: the file is ~60MB of
 * text and the accumulator keeps three typed arrays instead of 1.2M strings.
 */
export function routingFilterFromBuildDir(
	dir: string,
	manifest: StoreManifest,
): { bytes: Uint8Array; keys: number } | null {
	const path = `${dir}/${ROUTING_KEYS_FILE}`;
	if (!existsSync(path)) return null;
	const n = manifest.partition_count as number;
	const acc = new RoutingKeyAccumulator(1 << 21);
	const text = readFileSync(path, "utf8");
	let at = 0;
	let line = 0;
	while (at < text.length) {
		let end = text.indexOf("\n", at);
		if (end === -1) end = text.length;
		if (end > at) {
			const tab = text.indexOf("\t", at);
			if (tab === -1 || tab > end) throw new Error(`${ROUTING_KEYS_FILE}:${line + 1} has no tab separator`);
			const partition = Number(text.slice(at, tab));
			if (!Number.isInteger(partition) || partition < 0 || partition >= n) {
				throw new Error(`${ROUTING_KEYS_FILE}:${line + 1} names partition ${partition} against partition_count ${n}`);
			}
			acc.add(text.slice(tab + 1, end), partition);
		}
		at = end + 1;
		line++;
	}
	const sealed = acc.seal();
	const bytes = buildRoutingFilterFromHashes(sealed, {
		builtAt: String(manifest.built_at),
		partitionCount: n,
		partitionHash: manifest.partition_hash as string,
	});
	return { bytes, keys: sealed.lo.length };
}
