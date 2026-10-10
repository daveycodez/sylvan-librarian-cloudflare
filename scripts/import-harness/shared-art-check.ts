// What the harness checks about the artworks two cards share, once the run is done.
//
// `unique=art` answers such an artwork as ONE row, and which printings carry one is a fact no
// partition can know — the two cards are two oracle ids — so the nightly learns it in its
// corpus-wide scores phase (engine/builder `NewArt::observe_artwork`, carried between slices in
// the corpus snapshot and restored whole into every partition's build) and the store marks the
// printings. This asks the published store what it marked, through the committed engine wasm and
// the gather's own codec and merge:
//
//   1. THE NIGHTLY MARKED THEM. Every partition's `unique=art` answer to a query matching every
//      printing carries candidates; the corpus has such artworks split across partitions, so
//      there are more candidates than artworks, and the gather's count is rows of their own plus
//      one an artwork.
//   2. BOTH PUBLISHERS AGREE. The native builder's partitions (the build dir the oracle-index
//      check produced), asked the same way, send the same candidates — the same artworks under
//      the same sort keys, partition for partition — and come to the same total.
//
// (2) is skipped with `--no-native`. A committed engine blob that predates the mark sends no
// candidate at all: the check says so and fails, as a stale blob should.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeKeyPacket, type KeyPacket, mergeApart, pickShared } from "../../src/engine/gather";
import { chunkKey, formatManifestKey } from "../../src/engine/store-kv";
import type { StoreManifest } from "../../src/engine/types";
import type { FakeKV } from "./storage";

export interface SharedArtCheck {
	ok: boolean;
	lines: string[];
}

const EVERYTHING = JSON.stringify({ node_type: "TrueNode" });
const OPTS = JSON.stringify({ unique: "artwork", orderby: "name", direction: "asc", limit: 10_000_000, offset: 0 });
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** One build's phase-1 packets for "every printing, one row an artwork", partition by partition. */
async function packetsOf(archives: Uint8Array[]): Promise<KeyPacket[]> {
	const { engineFor } = await import("../../src/engine/wasm-shim");
	const engine = engineFor("harness-shared-art");
	return archives.map((archive) => {
		engine.begin_store_load(archive.byteLength);
		engine.store_load_chunk(archive);
		engine.finish_store_load();
		return decodeKeyPacket(engine.query_keys(EVERYTHING, OPTS, 0, "rows", ""));
	});
}

function gathered(packets: KeyPacket[]): { total: number; artworks: number; candidates: number; sent: string[] } {
	const shared = packets.map((p) => p.shared);
	const { apart } = mergeApart(
		packets.map((p) => p.entries),
		packets.map((p) => p.artless),
		shared,
	);
	return {
		total: packets.reduce((sum, p) => sum + p.total, 0) + apart,
		artworks: pickShared(shared).length,
		candidates: shared.reduce((sum, s) => sum + (s?.length ?? 0), 0),
		// Each partition's candidates as the artwork and the row's sort key: what the two builds must agree on.
		sent: shared.map((s) => (s ?? []).map((c) => `${hex(c.art)}:${hex(c.key)}`).join(",")),
	};
}

export async function checkSharedArt(kv: FakeKV, nativeDir: string | null): Promise<SharedArtCheck> {
	const lines: string[] = [];
	const fail = (why: string): SharedArtCheck => ({ ok: false, lines: [...lines, `FAILED: ${why}`] });
	const manifest = (await kv.get(formatManifestKey(), "json")) as StoreManifest | null;
	if (!manifest?.partitions) return fail("no partitioned manifest was published");
	const published: Uint8Array[] = [];
	for (const part of manifest.partitions) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			pieces.push(
				gunzipSync(new Uint8Array((await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer)),
			);
		}
		published.push(new Uint8Array(Buffer.concat(pieces)));
	}
	const nightly = gathered(await packetsOf(published));
	if (nightly.artworks < 10) {
		return fail(
			`the published store sends candidates for ${nightly.artworks} shared artworks — the corpus holds dozens ` +
				"(a committed engine or import blob from before the mark? `bun run build`)",
		);
	}
	if (nightly.candidates <= nightly.artworks) {
		return fail(
			`${nightly.candidates} candidates for ${nightly.artworks} shared artworks: none is split across partitions, ` +
				"so the merge was not exercised",
		);
	}
	lines.push(
		`shared artworks: the published store answers unique=art over every printing with ${nightly.total} rows — ` +
			`${nightly.artworks} of them artworks two cards share, one row each from ${nightly.candidates} candidates ` +
			`over ${published.length} partitions`,
	);
	if (!nativeDir || !existsSync(join(nativeDir, "manifest.json"))) {
		lines.push("shared artworks: native-builder parity skipped (--no-native)");
		return { ok: true, lines };
	}
	const nativeManifest = JSON.parse(readFileSync(join(nativeDir, "manifest.json"), "utf8")) as StoreManifest;
	const native = gathered(
		await packetsOf(
			(nativeManifest.partitions ?? []).map((p) => new Uint8Array(readFileSync(join(nativeDir, p.store_key)))),
		),
	);
	if (native.total !== nightly.total || JSON.stringify(native.sent) !== JSON.stringify(nightly.sent)) {
		const differing = native.sent.filter((s, i) => s !== nightly.sent[i]).length;
		return fail(
			`the native builder's store answers ${native.total} rows with ${native.candidates} candidates for ${native.artworks} ` +
				`shared artworks, the nightly's ${nightly.total} with ${nightly.candidates} for ${nightly.artworks} ` +
				`(${differing} partition(s) send different candidates)`,
		);
	}
	lines.push(
		"shared artworks: the native builder's partitions send the same candidates, artwork for artwork and key for key, " +
			`and come to the same ${native.total} rows`,
	);
	return { ok: true, lines };
}
