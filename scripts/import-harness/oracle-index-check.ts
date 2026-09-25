// What the harness checks about the oracle index (src/engine/oracle-index.ts) once the run is done.
//
//   1. PUBLISHED: the meta and all 64 buckets are in KV, the meta's hashes are the buckets' bytes,
//      and the entries are EXACTLY the corpus's (id, oracle_id) pairs minus the reversible
//      printings — every pair round-trips through `oracleIdLookup`, nothing extra is claimed.
//   2. BOTH PUBLISHERS AGREE, byte for byte: the native builder (the deploy path) is run against the
//      same dump server, its `oracle-pairs.bin` sidecar is encoded exactly as
//      scripts/seed-oracle-index.ts encodes it, and every bucket must equal the one the nightly
//      put — so the deploy seeder after a nightly (or the nightly after a deploy) writes nothing.
//
// (2) builds the native builder once (release profile, the same one memprobe already compiled the
// library in) and runs it for a few seconds; `--no-native` skips it.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	encodeOracleIndexBuckets,
	ORACLE_INDEX_BUCKET_COUNT,
	ORACLE_INDEX_META_KEY,
	type OracleIndexMeta,
	oracleIdLookup,
	oracleIndexBucketKey,
	oracleIndexBucketOf,
	oracleIndexEntries,
	planOracleIndexPublish,
} from "../../src/engine/oracle-index";
import { readPairs } from "../seed-oracle-index";
import type { Corpus } from "./corpus";
import type { FakeKV } from "./storage";

const BUILDER = "./target/release/sylvan-store-builder";

export interface OracleIndexCheck {
	ok: boolean;
	lines: string[];
}

function isUuid(v: unknown): v is string {
	return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** The builder's environment: this server's listing, and never a local dump dir. */
function builderEnv(serverUrl: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "SYLVAN_BULK_DIR") env[k] = v;
	env.SCRYFALL_BULK_URL = `${serverUrl}/bulk-data`;
	return env;
}

export async function checkOracleIndex(
	kv: FakeKV,
	corpus: Corpus,
	serverUrl: string,
	workDir: string,
	native: boolean,
): Promise<OracleIndexCheck> {
	const lines: string[] = [];
	const fail = (why: string): OracleIndexCheck => ({ ok: false, lines: [...lines, `FAILED: ${why}`] });

	// ── 1. what the nightly published ───────────────────────────────────────
	const meta = (await kv.get(ORACLE_INDEX_META_KEY, "json")) as OracleIndexMeta | null;
	if (!meta) return fail(`${ORACLE_INDEX_META_KEY} was not published`);
	const buckets: Uint8Array[] = [];
	for (let b = 0; b < ORACLE_INDEX_BUCKET_COUNT; b++) {
		const value = (await kv.get(oracleIndexBucketKey(b), "arrayBuffer")) as ArrayBuffer | null;
		if (!value) return fail(`${oracleIndexBucketKey(b)} was not published`);
		buckets.push(new Uint8Array(value));
	}
	const replan = await planOracleIndexPublish(buckets, meta.pair_count, meta.built_at, meta);
	if (replan.changed.length > 0)
		return fail(`the meta's hashes disagree with ${replan.changed.length} bucket(s) in KV`);

	const expected = new Map<string, string>();
	let reversible = 0;
	for (const line of new TextDecoder().decode(gunzipSync(corpus.dumps.all_cards as Uint8Array)).split("\n")) {
		if (!line.trim()) continue;
		const card = JSON.parse(line) as { id?: unknown; oracle_id?: unknown; layout?: unknown };
		if (card.layout === "reversible_card") {
			reversible++;
			continue;
		}
		if (isUuid(card.id) && isUuid(card.oracle_id)) expected.set(card.id.toLowerCase(), card.oracle_id.toLowerCase());
	}
	const held = new Map<string, string>();
	for (const bucket of buckets) for (const [s, o] of oracleIndexEntries(bucket)) held.set(s, o);
	if (held.size !== meta.pair_count) return fail(`meta says ${meta.pair_count} pairs, the buckets hold ${held.size}`);
	for (const [s, o] of expected) {
		const got = oracleIdLookup(buckets[oracleIndexBucketOf(s) as number] as Uint8Array, s);
		if (got !== o) return fail(`${s} looks up ${got}, the corpus says ${o}`);
	}
	for (const s of held.keys())
		if (!expected.has(s)) return fail(`${s} is indexed but is not an indexable corpus printing`);
	const sizes = buckets.map((b) => b.byteLength);
	lines.push(
		`oracle index: ${meta.pair_count} pairs published in ${ORACLE_INDEX_BUCKET_COUNT} buckets ` +
			`(${Math.min(...sizes)}-${Math.max(...sizes)} bytes, ${sizes.reduce((a, b) => a + b, 0)} in all); ` +
			`every corpus printing round-trips, ${reversible} reversible left out`,
	);

	// ── 2. the native builder's buckets, byte for byte ──────────────────────
	if (!native) {
		lines.push("oracle index: native-builder parity skipped (--no-native)");
		return { ok: true, lines };
	}
	const repo = join(import.meta.dir, "..", "..");
	if (!existsSync(join(repo, BUILDER))) {
		console.log("  building the native store builder for the parity check (first run only)...");
		const built = Bun.spawnSync(
			[
				"scripts/with-rust.sh",
				"cargo",
				"build",
				"--release",
				"-p",
				"sylvan-store-builder",
				"--bin",
				"sylvan-store-builder",
			],
			{ cwd: repo, stdout: "inherit", stderr: "inherit" },
		);
		if (built.exitCode !== 0) return fail("could not build the native store builder");
	}
	const out = join(workDir, "native-build");
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const proc = Bun.spawn([join(repo, BUILDER), "--out", out, "--partitions", "2"], {
		cwd: repo,
		env: builderEnv(serverUrl),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
	if ((await proc.exited) !== 0) return fail(`the native builder failed:\n${stderr.split("\n").slice(-8).join("\n")}`);
	const { runs, source } = await readPairs(out);
	if (!source.endsWith("oracle-pairs.bin"))
		return fail(`the native builder wrote no oracle-pairs.bin (read ${source})`);
	const nativeBuckets = encodeOracleIndexBuckets(runs).buckets;
	const differing = nativeBuckets.flatMap((b, i) =>
		Buffer.from(b).equals(Buffer.from(buckets[i] as Uint8Array)) ? [] : [i],
	);
	if (differing.length > 0) {
		return fail(
			`the native builder's buckets differ from the nightly's in ${differing.length}: ${differing.join(", ")}`,
		);
	}
	const seederPlan = await planOracleIndexPublish(nativeBuckets, meta.pair_count, meta.built_at, meta);
	lines.push(
		`oracle index: the native builder's ${nativeBuckets.length} buckets are byte-identical to the nightly's — ` +
			`the deploy seeder would write ${seederPlan.changed.length} of them after this night`,
	);
	rmSync(out, { recursive: true, force: true });
	return { ok: true, lines };
}
