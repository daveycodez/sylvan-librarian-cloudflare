// What the harness checks about the card-names blob (backlog n8) once the run is done.
//
//   1. PUBLISHED: the manifest names the blob, KV holds exactly `names_bytes` under that key, and the
//      blob is exactly the union of what every partition's own archive can offer
//      (`store_autocomplete_names`, read back from the chunks the run published).
//   2. IT ANSWERS WHAT THE FAN-OUT ANSWERS, through the committed engine wasm: every two-character
//      needle and a sample of real substrings, the blob's answer against every partition's own
//      `autocomplete` merged by the production `mergeAutocomplete` — byte for byte.
//   3. BOTH PUBLISHERS AGREE, byte for byte: the native builder's `card-names.tsv` (the build dir the
//      oracle-index check just produced), through the same encoder, is the nightly's blob.
//
// (3) is skipped with `--no-native`, as the oracle check's parity half is.

import { existsSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { cardNamesCount, cardNamesOf, encodeCardNames } from "../../src/engine/card-names";
import { mergeAutocomplete } from "../../src/engine/partitioned-engine";
import { chunkKey, MANIFEST_KEY } from "../../src/engine/store-kv";
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
	const manifest = (await kv.get(MANIFEST_KEY, "json")) as StoreManifest | null;
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
	const archivePairs: Uint8Array[] = [];
	const collated: string[] = [];
	const encoder = new TextEncoder();
	const partitions = manifest.partitions ?? [];
	for (const part of partitions) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			const chunk = (await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer | null;
			if (!chunk) return fail(`${chunkKey(part.store_key, seq)} is missing`);
			pieces.push(gunzipSync(new Uint8Array(chunk)));
		}
		const archive = new Uint8Array(Buffer.concat(pieces));
		loadArchive(engine, archive);
		const pairs = JSON.parse(engine.store_autocomplete_names()) as [string, string][];
		archivePairs.push(encoder.encode(pairs.map(([c, p]) => `${c}\t${p}\n`).join("")));
		for (const [c] of pairs) collated.push(c);
	}
	const expected = encodeCardNames(archivePairs);
	if (!Buffer.from(expected).equals(Buffer.from(raw))) {
		return fail(
			`the blob (${cardNamesCount(raw)} names) is not the union of the ${partitions.length} archives' own ` +
				`pairs (${cardNamesCount(expected)})`,
		);
	}
	lines.push(
		`card names: ${cardNamesCount(raw)} names published under ${names.key}, ${raw.byteLength} bytes raw -> ` +
			`${names.bytes} gzip — exactly the ${partitions.length} archives' own pairs`,
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
	for (const part of partitions) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			pieces.push(
				gunzipSync(new Uint8Array((await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer)),
			);
		}
		const archive = new Uint8Array(Buffer.concat(pieces));
		loadArchive(engine, archive);
		answersOf.push(folded.map((q) => JSON.parse(engine.autocomplete(q, 20)) as string[]));
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
