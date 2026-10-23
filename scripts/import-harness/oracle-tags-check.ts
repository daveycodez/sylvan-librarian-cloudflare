// What the harness checks about the oracle-tags blob (src/engine/oracle-tag-partitions.ts) once the
// run is done.
//
//   1. PUBLISHED: the manifest names the blob under its build's family key, KV holds exactly
//      `otags_bytes` under it, and the reader accepts it against the manifest's modulus.
//   2. IT IS EXACT, through the committed engine wasm over the chunks the run published: for every
//      slug the blob lists and slugs no card carries, a partition answers `otag:<slug>` with any row
//      — extras, variations and foreign printings included — if and only if the blob places the
//      slug there. "Answers ⇒ placed" is what keeps a restricted `otag:` search's page the full
//      gather's; "placed ⇒ answers" is what makes it as narrow as it can be.
//   3. BOTH PUBLISHERS AGREE, byte for byte: the native builder's `oracle-tags.tsv`, through the same
//      encoder, is the nightly's blob.
//
// Runs before the card-names check, which deletes the native build dir when it is done.

import { gunzipSync } from "node:zlib";
import { type PartitionClient, ROWS_GATHER, runTwoPhase } from "../../src/engine/gather";
import { OracleTagPartitions, oracleTagsKey, oracleTagsOf } from "../../src/engine/oracle-tag-partitions";
import { chunkKey, formatManifestKey } from "../../src/engine/store-kv";
import type { StoreManifest } from "../../src/engine/types";
import { canonicalStringify, type FilterValue, parseScryfallQueryWithDirectives } from "../../src/parser";
import { oracleTagsFromBuildDir } from "../oracle-tags-build";
import type { FakeKV } from "./storage";

export interface OracleTagsCheck {
	ok: boolean;
	lines: string[];
}

export async function checkOracleTags(kv: FakeKV, nativeDir: string | null): Promise<OracleTagsCheck> {
	const lines: string[] = [];
	const fail = (why: string): OracleTagsCheck => ({ ok: false, lines: [...lines, `FAILED: ${why}`] });

	// ── 1. what the nightly published ───────────────────────────────────────
	const manifest = (await kv.get(formatManifestKey(), "json")) as StoreManifest | null;
	if (!manifest) return fail("no manifest was published");
	const ref = oracleTagsOf(manifest);
	if (!ref) return fail(`the manifest names no oracle-tags blob (otags_key=${manifest.otags_key})`);
	if (ref.key !== oracleTagsKey(manifest.format_version, String(manifest.built_at))) {
		return fail(`${ref.key} is not in the build's family`);
	}
	const stored = (await kv.get(ref.key, "arrayBuffer")) as ArrayBuffer | null;
	if (!stored) return fail(`${ref.key} was not published`);
	if (stored.byteLength !== ref.bytes) {
		return fail(`${ref.key} holds ${stored.byteLength} bytes, the manifest says ${ref.bytes}`);
	}
	const raw = new Uint8Array(gunzipSync(new Uint8Array(stored)));
	const n = manifest.partition_count as number;
	let tags: OracleTagPartitions;
	try {
		tags = OracleTagPartitions.parse(raw, { partitionCount: n, partitionHash: manifest.partition_hash as string });
	} catch (err) {
		return fail(`the reader refuses the blob: ${err}`);
	}
	const slugs = tags.slugs();
	if (slugs.length < 20) return fail(`only ${slugs.length} tags: the check proves nothing`);
	lines.push(
		`oracle tags: ${slugs.length} tags published under ${ref.key}, ${raw.byteLength} bytes raw -> ${ref.bytes} gzip`,
	);

	// ── 2. exact against the archives ───────────────────────────────────────
	const { engineFor } = await import("../../src/engine/wasm-shim");
	const engine = engineFor("harness-oracle-tags");
	// The archive the instance holds right now: a phase-1 reply names its store key.
	let loadedKey = "";
	const client: PartitionClient = {
		async searchKeys(opts, inlineRows, shaping) {
			return {
				packed: engine.query_keys(
					opts.filterTreeJson,
					JSON.stringify({
						unique: opts.unique,
						prefer: opts.prefer,
						orderby: opts.orderby,
						direction: opts.direction,
						limit: opts.limit,
						offset: opts.offset,
						fields: opts.fields,
						include_multilingual: opts.includeMultilingual === true,
					}),
					inlineRows,
					shaping.shape,
					shaping.baseUrl ?? "",
				),
				storeKey: loadedKey,
				sortKeyVersion: engine.sort_key_version(),
				shape: shaping.shape,
			};
		},
		async fetchRows(vpids, fields, _storeKey, shaping) {
			return {
				rowsBytes: engine.fetch_rows(
					Uint32Array.from(vpids),
					JSON.stringify(fields),
					shaping.shape,
					shaping.baseUrl ?? "",
				),
				shape: shaping.shape,
			};
		},
	};
	const template = canonicalStringify(parseScryfallQueryWithDirectives("otag:zzqxplaceholder").tree as FilterValue);
	if (!template.includes('"zzqxplaceholder"')) return fail(`unexpected otag wire: ${template}`);
	const unknown = ["synergy-zzqx", ...slugs.slice(0, 20).map((s) => `${s}-zq`)].filter(
		(s) => tags.partitionsOf(s).length === 0,
	);
	let checked = 0;
	for (const [p, part] of (manifest.partitions ?? []).entries()) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			const chunk = (await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer | null;
			if (!chunk) return fail(`${chunkKey(part.store_key, seq)} is missing`);
			pieces.push(gunzipSync(new Uint8Array(chunk)));
		}
		const archive = new Uint8Array(Buffer.concat(pieces));
		engine.begin_store_load(archive.byteLength);
		engine.store_load_chunk(archive);
		engine.finish_store_load();
		loadedKey = part.store_key;
		for (const slug of [...slugs, ...unknown]) {
			const page = await runTwoPhase(
				[client],
				{
					// Every mode at once: no extras/variations gate, the foreign annex, every printing.
					filterTreeJson: template.replace('"zzqxplaceholder"', JSON.stringify(slug)),
					unique: "printing",
					prefer: "default",
					orderby: "name",
					direction: "auto",
					limit: 1,
					offset: 0,
					fields: [],
					includeMultilingual: true,
				},
				ROWS_GATHER,
			);
			const placed = tags.partitionsOf(slug).includes(p);
			if (page.total > 0 && !placed) return fail(`partition ${p} answers otag:${slug} but the blob does not place it`);
			if (page.total === 0 && placed)
				return fail(`the blob places otag:${slug} in partition ${p}, which answers nothing`);
			checked++;
		}
	}
	lines.push(
		`oracle tags: ${checked} (partition, tag) pairs over ${slugs.length} tags and ${unknown.length} unknown ones — ` +
			"a partition answers exactly where the blob places the tag",
	);

	// ── 3. the native builder's blob, byte for byte ─────────────────────────
	if (!nativeDir) {
		lines.push("oracle tags: native-builder parity skipped (--no-native)");
		return { ok: true, lines };
	}
	const native = oracleTagsFromBuildDir(nativeDir, manifest);
	if (!native) return fail(`the native builder wrote no oracle-tags.tsv in ${nativeDir}`);
	if (!Buffer.from(native.raw).equals(Buffer.from(raw))) {
		return fail(
			`the native builder's blob (${native.count} tags, ${native.raw.byteLength} bytes) differs from the ` +
				`nightly's (${slugs.length} tags, ${raw.byteLength} bytes)`,
		);
	}
	lines.push(`oracle tags: the native builder's blob is byte-identical to the nightly's (${native.count} tags)`);
	return { ok: true, lines };
}
