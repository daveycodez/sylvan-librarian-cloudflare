// What the harness checks about the card-names blob (backlog n8; format 2, the names index, n15) once
// the run is done.
//
//   1. PUBLISHED: the manifest names the blob, KV holds exactly `names_bytes` under that key, and the
//      blob is exactly the union of every partition's own name records as its archive reads them back
//      (`store_name_records_tsv`, the archived twin, over the chunks the run published), each led by
//      its partition.
//   2. IT ANSWERS WHAT THE FAN-OUT ANSWERS, through the committed engine wasm: every two-character
//      needle and a sample of real substrings, the blob's answer against every partition's own
//      `autocomplete` merged by the production `mergeAutocomplete` — byte for byte. And (n15) the
//      names index names EXACTLY the partitions whose own query returns a row, for name-only
//      searches over a sample of real words, pairs of them, regexes and words nothing contains,
//      under the default extras/variations gate.
//   3. BOTH PUBLISHERS AGREE, byte for byte: the native builder's `card-names.tsv` (the build dir the
//      oracle-index check just produced), through the same encoder, is the nightly's blob.
//
// (3) is skipped with `--no-native`, as the oracle check's parity half is.

import { existsSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { cardNamesCount, cardNamesOf, encodeCardNames, ledByPartition } from "../../src/engine/card-names";
import { mergeAutocomplete } from "../../src/engine/partitioned-engine";
import { chunkKey, formatManifestKey } from "../../src/engine/store-kv";
import type { StoreManifest } from "../../src/engine/types";
import { foldAccents } from "../../src/parser/pystr";
import { cardNamesFromBuildDir } from "../card-names-build";
import type { FakeKV } from "./storage";

export interface CardNamesCheck {
	ok: boolean;
	lines: string[];
}

/** One archive into the shim's instance for `label`, through the loader's own raw-load exports. */
function loadArchive(engine: import("../../src/engine/wasm-shim").EngineHandle, archive: Uint8Array): void {
	engine.begin_store_load(archive.byteLength);
	engine.store_load_chunk(archive);
	engine.finish_store_load();
}

export async function checkCardNames(kv: FakeKV, nativeDir: string | null): Promise<CardNamesCheck> {
	const lines: string[] = [];
	const fail = (why: string): CardNamesCheck => ({ ok: false, lines: [...lines, `FAILED: ${why}`] });

	// ── 1. what the nightly published ───────────────────────────────────────
	const manifest = (await kv.get(formatManifestKey(), "json")) as StoreManifest | null;
	if (!manifest) return fail("no manifest was published");
	const names = cardNamesOf(manifest);
	if (!names) return fail(`the manifest names no card-names blob (names_key=${manifest.names_key})`);
	const stored = (await kv.get(names.key, "arrayBuffer")) as ArrayBuffer | null;
	if (!stored) return fail(`${names.key} was not published`);
	if (stored.byteLength !== names.bytes) {
		return fail(`${names.key} holds ${stored.byteLength} bytes, the manifest says ${names.bytes}`);
	}
	const raw = new Uint8Array(gunzipSync(new Uint8Array(stored)));

	// The committed engine wasm through the production shim (one instance of its own), so the glue
	// the loader's instances share is never rebound under them.
	const { engineFor } = await import("../../src/engine/wasm-shim");
	const engine = engineFor("harness-card-names");
	const answersOf: string[][][] = [];
	const archiveRecords: Uint8Array[] = [];
	const collated: string[] = [];
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const partitions = manifest.partitions ?? [];
	for (const [k, part] of partitions.entries()) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			const chunk = (await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer | null;
			if (!chunk) return fail(`${chunkKey(part.store_key, seq)} is missing`);
			pieces.push(gunzipSync(new Uint8Array(chunk)));
		}
		const archive = new Uint8Array(Buffer.concat(pieces));
		loadArchive(engine, archive);
		const records = decoder.decode(engine.store_name_records_tsv());
		archiveRecords.push(encoder.encode(ledByPartition(k, records)));
		for (const line of records.split("\n")) if (line) collated.push(line.split("\t")[1] as string);
	}
	const expected = encodeCardNames(archiveRecords);
	if (!Buffer.from(expected).equals(Buffer.from(raw))) {
		return fail(
			`the blob (${cardNamesCount(raw)} records) is not the union of the ${partitions.length} archives' own ` +
				`records (${cardNamesCount(expected)})`,
		);
	}
	lines.push(
		`card names: ${cardNamesCount(raw)} records published under ${names.key}, ${raw.byteLength} bytes raw -> ` +
			`${names.bytes} gzip — exactly the ${partitions.length} archives' own records`,
	);

	// ── 2. the blob answers what the fan-out answers ────────────────────────
	const needles: string[] = [];
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	for (const a of alphabet) for (const b of alphabet) needles.push(a + b);
	for (let i = 0; i < collated.length; i += 7) {
		const c = collated[i] as string;
		if (c.length >= 5) needles.push(c.slice(1, 5));
	}
	needles.push("lim-dûl", "éowyn", "fire // ice", "_____", "a", "zzzz", "アク");
	const folded = needles.map((q) => foldAccents(q.trim().toLowerCase()));
	// n15: name-only searches, gated as /cards/search gates a default query.
	const leaf = (kind: string, value: string) => ({
		node_type: "CardBinaryOperatorNode",
		kwargs: {
			op: ":",
			lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_name", original_attribute: "name" } },
			rhs: { node_type: kind, kwargs: { value } },
		},
	});
	const notIs = (tag: string) => ({
		node_type: "NotNode",
		kwargs: {
			operand: {
				node_type: "CardBinaryOperatorNode",
				kwargs: {
					lhs: { node_type: "CardAttributeNode", kwargs: { attribute_name: "card_is_tags", original_attribute: "is" } },
					op: ":",
					rhs: [tag],
				},
			},
		},
	});
	const gated = (tree: unknown) =>
		JSON.stringify({ node_type: "AndNode", kwargs: { operands: [tree, notIs("extra"), notIs("variation")] } });
	const trees: string[] = [];
	for (let i = 0; i < collated.length; i += 11) {
		const c = collated[i] as string;
		const d = collated[(i * 7 + 3) % collated.length] as string;
		if (c.length >= 4) trees.push(gated(leaf("CollatedNameValueNode", c.slice(0, 4))));
		if (c.length >= 6 && d.length >= 3) {
			trees.push(
				gated({
					node_type: "AndNode",
					kwargs: {
						operands: [leaf("CollatedNameValueNode", c.slice(2, 6)), leaf("CollatedNameValueNode", d.slice(0, 3))],
					},
				}),
			);
		}
	}
	for (const re of ["^bolt", "dragon$", "^[aeiou].*s$", "\\d", "//"]) trees.push(gated(leaf("RegexValueNode", re)));
	for (const w of ["zzqx", "qqqq", "xyzzy"]) trees.push(gated(leaf("CollatedNameValueNode", w)));
	const opts = JSON.stringify({
		unique: "card",
		prefer: "default",
		orderby: "name",
		direction: "asc",
		limit: 1,
		offset: 0,
		fields: ["name"],
		include_multilingual: false,
	});
	const truth: number[][] = trees.map(() => []);
	for (const [k, part] of partitions.entries()) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			pieces.push(
				gunzipSync(new Uint8Array((await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer)),
			);
		}
		const archive = new Uint8Array(Buffer.concat(pieces));
		loadArchive(engine, archive);
		answersOf.push(folded.map((q) => JSON.parse(engine.autocomplete(q, 20)) as string[]));
		for (const [i, tree] of trees.entries()) {
			if ((JSON.parse(engine.query(tree, opts)) as { total: number }).total > 0) truth[i]?.push(k);
		}
	}
	engine.load_names(new Uint8Array(stored));
	let differing = 0;
	let answered = 0;
	for (let i = 0; i < folded.length; i++) {
		const q = folded[i] as string;
		const merged = JSON.stringify(
			mergeAutocomplete(
				answersOf.map((a) => a[i] as string[]),
				q,
				20,
			),
		);
		const got = engine.names_autocomplete(q, 20);
		if (got !== merged) {
			differing++;
			if (differing <= 3) lines.push(`  ${JSON.stringify(q)}: names ${got} vs fan-out ${merged}`);
		}
		if (merged !== "[]") answered++;
	}
	if (differing > 0) return fail(`${differing} of ${folded.length} needles answer differently from the fan-out`);
	lines.push(
		`card names: ${folded.length} needles answered byte-identically to the ${partitions.length}-partition fan-out ` +
			`(${answered} non-empty)`,
	);
	let wrongPartitions = 0;
	let empty = 0;
	for (const [i, tree] of trees.entries()) {
		const index = JSON.parse(engine.names_search_partitions(tree, false)) as { partitions: number[] } | null;
		const want = truth[i] as number[];
		if (JSON.stringify(index?.partitions ?? null) !== JSON.stringify(want)) {
			wrongPartitions++;
			if (wrongPartitions <= 3)
				lines.push(`  ${tree.slice(0, 160)}: index ${JSON.stringify(index)} vs ${JSON.stringify(want)}`);
		}
		if (want.length === 0) empty++;
	}
	if (wrongPartitions > 0) {
		return fail(`the names index names the wrong partitions for ${wrongPartitions} of ${trees.length} name searches`);
	}
	lines.push(
		`card names: the names index names exactly the answering partitions for ${trees.length} name searches ` +
			`(${empty} with none — a 404 in one call)`,
	);

	// ── 3. the native builder's blob, byte for byte ─────────────────────────
	if (!nativeDir) {
		lines.push("card names: native-builder parity skipped (--no-native)");
		return { ok: true, lines };
	}
	try {
		const native = cardNamesFromBuildDir(nativeDir);
		if (!native) return fail(`the native builder wrote no card-names.tsv in ${nativeDir}`);
		if (!Buffer.from(native.raw).equals(Buffer.from(raw))) {
			return fail(
				`the native builder's blob (${native.count} names, ${native.raw.byteLength} bytes) differs from the ` +
					`nightly's (${cardNamesCount(raw)} names, ${raw.byteLength} bytes)`,
			);
		}
		lines.push(`card names: the native builder's blob is byte-identical to the nightly's (${native.count} names)`);
		return { ok: true, lines };
	} finally {
		if (existsSync(nativeDir)) rmSync(nativeDir, { recursive: true, force: true });
	}
}
