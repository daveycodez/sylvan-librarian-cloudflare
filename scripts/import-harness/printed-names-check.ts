// What the harness checks about the printed-names blob (backlog x24) once the run is done.
//
//   1. PUBLISHED: the manifest names the blob under its build's family key, KV holds exactly
//      `printed_bytes` under it, and the blob is exactly the union of every partition's own printed
//      records as its archive reads them back (`store_printed_records_tsv`, the archived twin, over
//      the chunks the run published), each led by its partition.
//   2. IT SETTLES WHAT THE PLAN LEFT `everywhere`, through the committed engine wasm: for needles made
//      of the corpus's own printed and oracle words (and sentences no name carries), wherever the
//      names index plans `everywhere`, the plan's partitions plus the blob's printed carriers are
//      every partition whose own containment stage answers anything — a partition outside them
//      answers nothing, so leaving it out cannot change the answer.
//   3. BOTH PUBLISHERS AGREE, byte for byte: the native builder's `printed-names.tsv`, through the
//      same encoder, is the nightly's blob.
//
// Runs before the card-names check, which deletes the native build dir when it is done.

import { gunzipSync } from "node:zlib";
import { cardNamesOf, ledByPartition } from "../../src/engine/card-names";
import {
	encodePrintedNames,
	PRINTED_NAMES_HEADER,
	printedNamesCount,
	printedNamesKey,
	printedNamesOf,
} from "../../src/engine/printed-names";
import { chunkKey, formatManifestKey } from "../../src/engine/store-kv";
import {
	FUZZY_SIMILARITY_FLOOR,
	FUZZY_SIMILARITY_LEAD,
	FUZZY_WEAK_BELOW,
	type StoreManifest,
} from "../../src/engine/types";
import { printedNamesFromBuildDir } from "../printed-names-build";
import type { FakeKV } from "./storage";

export interface PrintedNamesCheck {
	ok: boolean;
	lines: string[];
}

export async function checkPrintedNames(kv: FakeKV, nativeDir: string | null): Promise<PrintedNamesCheck> {
	const lines: string[] = [];
	const fail = (why: string): PrintedNamesCheck => ({ ok: false, lines: [...lines, `FAILED: ${why}`] });

	// ── 1. what the nightly published ───────────────────────────────────────
	const manifest = (await kv.get(formatManifestKey(), "json")) as StoreManifest | null;
	if (!manifest) return fail("no manifest was published");
	const printed = printedNamesOf(manifest);
	if (!printed) return fail(`the manifest names no printed-names blob (printed_key=${manifest.printed_key})`);
	if (printed.key !== printedNamesKey(manifest.format_version, String(manifest.built_at))) {
		return fail(`${printed.key} is not in the build's family`);
	}
	const stored = (await kv.get(printed.key, "arrayBuffer")) as ArrayBuffer | null;
	if (!stored) return fail(`${printed.key} was not published`);
	if (stored.byteLength !== printed.bytes) {
		return fail(`${printed.key} holds ${stored.byteLength} bytes, the manifest says ${printed.bytes}`);
	}
	const raw = new Uint8Array(gunzipSync(new Uint8Array(stored)));
	const names = cardNamesOf(manifest);
	if (!names) return fail("the manifest names no card-names blob to plan with");
	const namesStored = (await kv.get(names.key, "arrayBuffer")) as ArrayBuffer | null;
	if (!namesStored) return fail(`${names.key} was not published`);

	const { engineFor } = await import("../../src/engine/wasm-shim");
	const engine = engineFor("harness-printed-names");
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const partitions = manifest.partitions ?? [];
	const archives: Uint8Array[] = [];
	const archiveRecords: Uint8Array[] = [];
	for (const [k, part] of partitions.entries()) {
		const pieces: Buffer[] = [];
		for (let seq = 0; seq < part.chunk_count; seq++) {
			const chunk = (await kv.get(chunkKey(part.store_key, seq), "arrayBuffer")) as ArrayBuffer | null;
			if (!chunk) return fail(`${chunkKey(part.store_key, seq)} is missing`);
			pieces.push(gunzipSync(new Uint8Array(chunk)));
		}
		const archive = new Uint8Array(Buffer.concat(pieces));
		archives.push(archive);
		engine.begin_store_load(archive.byteLength);
		engine.store_load_chunk(archive);
		engine.finish_store_load();
		archiveRecords.push(encoder.encode(ledByPartition(k, decoder.decode(engine.store_printed_records_tsv()))));
	}
	const expected = encodePrintedNames(archiveRecords);
	if (!Buffer.from(expected).equals(Buffer.from(raw))) {
		return fail(
			`the blob (${printedNamesCount(raw)} cards) is not the union of the ${partitions.length} archives' own ` +
				`printed records (${printedNamesCount(expected)})`,
		);
	}
	lines.push(
		`printed names: ${printedNamesCount(raw)} cards published under ${printed.key}, ${raw.byteLength} bytes raw -> ` +
			`${printed.bytes} gzip — exactly the ${partitions.length} archives' own records`,
	);

	// ── 2. the blob settles what the plan left everywhere ───────────────────
	const body = decoder.decode(raw).slice(PRINTED_NAMES_HEADER.length).split("\n").filter(Boolean);
	const needles: string[] = ["blue creatures that combo infinitely", "cards that lower equip cost", "zzqx qqqq"];
	for (let i = 0; i < body.length; i += 3) {
		const [, oracle, ...forms] = (body[i] as string).split("\t");
		const form = (forms[0] as string).split(" ")[0] as string;
		if (form.length >= 5) needles.push(form.slice(1, 5));
		if (form.length >= 6 && oracle && oracle.length >= 3) needles.push(`${oracle.slice(0, 3)} ${form.slice(-4)}`);
		if (form.length >= 4) needles.push(`${form.slice(0, 4)} zq`);
	}
	const wordsOf = (q: string) => q.split(/[^\w']+/u).filter((w) => w.length > 0);
	// Every partition's containment answer, per needle.
	const answering: number[][] = needles.map(() => []);
	for (const [k, archive] of archives.entries()) {
		engine.begin_store_load(archive.byteLength);
		engine.store_load_chunk(archive);
		engine.finish_store_load();
		for (const [i, q] of needles.entries()) {
			const contained = JSON.parse(
				engine.cards_containing_all_words(JSON.stringify(wordsOf(q)), "", 2, JSON.stringify(["name"])),
			) as unknown[];
			if (contained.length > 0) answering[i]?.push(k);
		}
	}
	engine.load_names(new Uint8Array(namesStored));
	engine.load_printed_names(new Uint8Array(stored));
	let wide = 0;
	let none = 0;
	let asked = 0;
	for (const [i, q] of needles.entries()) {
		const words = JSON.stringify(wordsOf(q));
		const plan = JSON.parse(
			engine.names_fuzzy_plan(q, words, FUZZY_SIMILARITY_FLOOR, FUZZY_SIMILARITY_LEAD, FUZZY_WEAK_BELOW),
		) as { partitions: number[]; everywhere: boolean } | null;
		if (!plan?.everywhere) continue;
		wide++;
		const carriers = JSON.parse(engine.printed_names_partitions(words)) as { partitions: number[] } | null;
		if (!carriers) return fail(`${JSON.stringify(q)}: the printed names could not say`);
		const union = new Set([...plan.partitions, ...carriers.partitions]);
		const missed = (answering[i] as number[]).filter((p) => !union.has(p));
		if (missed.length > 0) {
			return fail(
				`${JSON.stringify(q)}: partitions ${missed.join(",")} answer containment but the plan ` +
					`(${plan.partitions}) and the printed names (${carriers.partitions}) leave them out`,
			);
		}
		asked += union.size;
		if (union.size === 0) none++;
	}
	if (wide < 20) return fail(`only ${wide} needles reached the printed tier: the check proves nothing`);
	lines.push(
		`printed names: ${wide} needles the names index planned everywhere now ask ${asked} of ` +
			`${wide * partitions.length} partitions (${none} none at all — a 404 in one call), and no left-out ` +
			"partition answers containment",
	);

	// ── 3. the native builder's blob, byte for byte ─────────────────────────
	if (!nativeDir) {
		lines.push("printed names: native-builder parity skipped (--no-native)");
		return { ok: true, lines };
	}
	const native = printedNamesFromBuildDir(nativeDir);
	if (!native) return fail(`the native builder wrote no printed-names.tsv in ${nativeDir}`);
	if (!Buffer.from(native.raw).equals(Buffer.from(raw))) {
		return fail(
			`the native builder's blob (${native.count} cards, ${native.raw.byteLength} bytes) differs from the ` +
				`nightly's (${printedNamesCount(raw)} cards, ${raw.byteLength} bytes)`,
		);
	}
	lines.push(`printed names: the native builder's blob is byte-identical to the nightly's (${native.count} cards)`);
	return { ok: true, lines };
}
