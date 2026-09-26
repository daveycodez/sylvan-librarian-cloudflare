// What the harness checks about the routing filter (src/engine/routing-filter.ts) once the run is done.
//
//   1. PUBLISHED, and it places the corpus's FACE-LEVEL flavor names (backlog n13): every printing
//      whose flavor names sit on its faces (corpus.ts adds them; memprobe emits none) is found
//      under its folded join, `nameKey` exactly as the named routes spell it, at the partition its
//      oracle id hashes to — the one partition an `exact=` for it now asks.
//   2. BOTH PUBLISHERS AGREE, byte for byte: the native builder's `routing-keys.tsv` (the build dir
//      the oracle-index check just produced, at the nightly's own partition count), built exactly as
//      scripts/seed-remote-kv.ts builds it and pinned to the nightly's manifest, is the filter the
//      nightly put — so the id keys, the name keys and the face keys are the same set on both sides.
//
// (2) is skipped with `--no-native`, as the oracle check's parity half is.

import { gunzipSync } from "node:zlib";
import { partitionOfOracleId } from "../../src/engine/partition";
import { nameKey, RoutingFilter } from "../../src/engine/routing-filter";
import { MANIFEST_KEY, routingFilterKeyFor } from "../../src/engine/store-kv";
import type { StoreManifest } from "../../src/engine/types";
import { foldAccents } from "../../src/parser/pystr";
import { routingFilterFromBuildDir } from "../routing-filter-build";
import type { Corpus } from "./corpus";
import type { FakeKV } from "./storage";

export interface RoutingFilterCheck {
	ok: boolean;
	lines: string[];
}

export async function checkRoutingFilter(
	kv: FakeKV,
	corpus: Corpus,
	nativeDir: string | null,
): Promise<RoutingFilterCheck> {
	const lines: string[] = [];
	const fail = (why: string): RoutingFilterCheck => ({ ok: false, lines: [...lines, `FAILED: ${why}`] });

	// ── 1. what the nightly published ───────────────────────────────────────
	const manifest = (await kv.get(MANIFEST_KEY, "json")) as StoreManifest | null;
	if (!manifest) return fail("no manifest was published");
	const key = routingFilterKeyFor(manifest);
	const n = manifest.partition_count as number;
	const stored = key ? ((await kv.get(key, "arrayBuffer")) as ArrayBuffer | null) : null;
	if (!key || !stored) return fail(`no routing filter was published (${key})`);
	const bytes = new Uint8Array(stored);
	const identity = {
		builtAt: String(manifest.built_at),
		partitionCount: n,
		partitionHash: manifest.partition_hash as string,
	};
	const parsed = RoutingFilter.parse(bytes, identity);
	if ("reason" in parsed) return fail(`the published filter does not parse: ${parsed.reason}`);
	const filter = parsed.filter;
	if (!filter.hasNameKeys) return fail("the published filter claims no name keys");

	let faced = 0;
	for (const line of new TextDecoder().decode(gunzipSync(corpus.dumps.all_cards as Uint8Array)).split("\n")) {
		if (!line.includes('"flavor_name"') || !line.includes('"card_faces"')) continue;
		const card = JSON.parse(line) as { oracle_id?: string; card_faces?: { flavor_name?: string }[] };
		const names = (card.card_faces ?? []).flatMap((f) => (f.flavor_name === undefined ? [] : [f.flavor_name]));
		if (names.length === 0 || !card.oracle_id) continue;
		const needle = foldAccents(names.join(" // ").toLowerCase());
		const nk = nameKey(needle);
		if (nk === null) return fail(`face flavor name ${JSON.stringify(needle)} is not routable`);
		const want = partitionOfOracleId(card.oracle_id, n);
		const hint = filter.lookupName(nk);
		const got = hint === null ? null : "sole" in hint ? hint.sole : hint.served;
		if (got !== want) {
			return fail(
				`face flavor name ${JSON.stringify(needle)} hints ${JSON.stringify(hint)}, its printing is in ${want}`,
			);
		}
		faced++;
	}
	if (faced === 0) return fail("the corpus carries no face-level flavor name to route (corpus.ts adds them)");
	lines.push(
		`routing filter: ${bytes.byteLength} bytes over ${n} partitions; all ${faced} face-level flavor names ` +
			"hint the one partition holding their printing",
	);

	// ── 2. the native builder's filter, byte for byte ──────────────────────
	if (nativeDir === null) {
		lines.push("routing filter: native-builder parity skipped (--no-native)");
		return { ok: true, lines };
	}
	const native = routingFilterFromBuildDir(nativeDir, manifest);
	if (native === null) return fail(`the native builder wrote no routing-keys.tsv in ${nativeDir}`);
	if (!Buffer.from(native.bytes).equals(Buffer.from(bytes))) {
		return fail(
			`the native builder's filter (${native.bytes.byteLength} bytes, ${native.keys} keys, ${native.nameKeys} name keys) ` +
				`differs from the nightly's (${bytes.byteLength} bytes)`,
		);
	}
	lines.push(
		`routing filter: the native builder's ${native.keys} keys (${native.nameKeys} name keys) build the nightly's ` +
			"filter byte for byte",
	);
	return { ok: true, lines };
}
