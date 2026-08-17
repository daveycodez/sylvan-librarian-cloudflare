// Print how recently the store was built, or exit non-zero if there is no
// usable store. Two callers, one question:
//
//   scripts/import-store.sh  — the live store, deciding whether a deploy needs
//     the bulk import. A routine code push should not re-download ~450MB and
//     republish identical bytes.
//   scripts/dev.sh (--local) — the seeded dev store, deciding whether
//     `bun dev` needs to rebuild before it starts serving.
//
// Dev deliberately runs the SAME script rather than a lighter local variant.
// It used to ask only whether a manifest existed, which meant a builder change
// that forced a rebuild before a deploy was silently ignored locally, and
// `bun dev` came up serving from a store the code could no longer read. Two
// implementations of one question drift; one implementation with a flag
// cannot.
//
//   bun scripts/store-age.ts        -> "2h ago" (exit 0)
//   bun scripts/store-age.ts --local   same, against the dev namespace
//                                      exit 1: no usable store — an ANSWER
//                                      exit 2: could not tell — a FAILURE
//
// "Usable" means a manifest that parses and carries a build time, a byte
// count and a chunk count, AND describes data Scryfall has not superseded.
//
// That last test is the real one: it asks upstream when it last regenerated
// its dumps and compares against when this store was built. A store built
// after the newest dump already contains it, however many hours ago that was;
// a store built before it is stale, however recent. The clock-based window
// this replaced could only approximate that, and got it wrong in both
// directions — rebuilding an identical store every 20 hours, and serving one
// built minutes before a Scryfall refresh until the next nightly cron.
//
// MAX_AGE_HOURS survives only as a backstop for what upstream timestamps
// cannot see: a store format the deployed code no longer reads, or a build
// that predates a change in this repo. It is deliberately loose, because the
// upstream comparison is what should normally decide.
//
// Both non-zero exits make the caller import, which costs build minutes but
// never leaves a deploy without an index. They are still kept apart, because
// they mean opposite things about the deployment: 1 says the store really is
// missing or stale, 2 says this script could not reach KV — and a 2 reported
// as a 1 is a broken query that presents as an eternally-empty database, which
// is exactly the failure this split exists to make visible. Every path says
// why on stderr; callers must show that text, not discard it.

import { chunkKey, MANIFEST_KEY, routingFilterKey, STORE_CONTENT_GENERATION } from "../src/engine/store-kv";
import { kvName } from "./project-config";
import { wranglerArgv } from "./wrangler-cmd";

/** Backstop only — see the header. A week covers "nothing upstream changed but
 * this repo did", without reinstating a nightly rebuild of identical bytes. */
const MAX_AGE_HOURS = 7 * 24;

const BULK_DATA_URL = process.env.SCRYFALL_BULK_URL ?? "https://api.scryfall.com/bulk-data";
/** The dumps an import actually reads. A refresh of any of them is a change the
 * live store does not have; the rest of the listing is not this gate's business. */
const DUMP_KINDS = ["all_cards", "default_cards", "oracle_tags", "art_tags"];

/**
 * When Scryfall last regenerated the dumps this store is built from, as unix
 * seconds — or null if upstream could not be asked.
 *
 * Null deliberately means "unknown", not "unchanged": the caller falls back to
 * the age backstop rather than skipping an import on a guess. A deploy that
 * cannot reach Scryfall is not evidence that Scryfall stood still.
 */
async function upstreamUpdatedAt(): Promise<number | null> {
	try {
		const res = await fetch(BULK_DATA_URL, {
			// Scryfall rejects default UAs; mirror the Worker's convention.
			headers: { "User-Agent": "sylvan-librarian-deploy/1.0", Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			console.error(`store-age: ${BULK_DATA_URL} answered ${res.status} — falling back to the age backstop.`);
			return null;
		}
		const listing = (await res.json()) as { data?: { type?: string; updated_at?: string }[] };
		const stamps = (listing.data ?? [])
			.filter((r) => r.type && DUMP_KINDS.includes(r.type))
			.map((r) => Date.parse(r.updated_at ?? ""))
			.filter((n) => Number.isFinite(n));
		if (stamps.length === 0) {
			console.error("store-age: /bulk-data listed no updated_at for the dumps we read — using the age backstop.");
			return null;
		}
		return Math.floor(Math.max(...stamps) / 1000);
	} catch (err) {
		console.error(`store-age: could not reach Scryfall (${err}) — falling back to the age backstop.`);
		return null;
	}
}

// `--local` reads the dev namespace instead of the deployed one. Everything
// after this point is shared, deliberately: `bun dev` has to gate on exactly
// what a deploy gates on, or the two drift and dev serves from a store the
// deploy would have rebuilt. That drift is not hypothetical — dev.sh used to
// ask only whether a manifest EXISTED, so a builder-generation change forced a
// rebuild before a deploy and was silently ignored locally.
const LOCAL = process.argv.includes("--local");
const WHERE = LOCAL ? "the local dev store" : "KV";

// Read the manifest straight out of KV. `kv key get` exits non-zero when the
// key is absent, which is the "nothing published yet" answer rather than a
// failure to ask — the two are kept apart below because they mean opposite
// things about the deployment.
// Resolve the KV target ONCE, then read every key through it. Both reads —
// the manifest here and the chunk probe at the bottom — must hit the same
// namespace; building each argv separately is how `--local` would end up
// inspecting production for one of them.
let kvTarget: string[];
if (LOCAL) {
	kvTarget = ["--binding", "STORE_KV", "--local", "-c", "wrangler.dev.jsonc"];
} else {
	const nsProc = Bun.spawn([...wranglerArgv(), "kv", "namespace", "list"], { stdout: "pipe", stderr: "pipe" });
	const nsOut = await new Response(nsProc.stdout).text();
	if ((await nsProc.exited) !== 0) {
		console.error(`store-age: could not list KV namespaces —\n  ${nsOut.trim()}`);
		process.exit(2);
	}
	let namespaceId: string | undefined;
	try {
		const all = JSON.parse(nsOut.slice(nsOut.indexOf("["))) as { id?: string; title?: string }[];
		namespaceId = all.find((n) => n.title === kvName)?.id;
	} catch {
		console.error(`store-age: could not parse the KV namespace list —\n  ${nsOut.trim()}`);
		process.exit(2);
	}
	if (!namespaceId) {
		console.error(`store-age: no KV namespace named "${kvName}" — nothing has ever been published.`);
		process.exit(1);
	}
	kvTarget = ["--namespace-id", namespaceId, "--remote"];
}

/** `wrangler kv key get <key>` against whichever namespace this run targets. */
const kvGetArgv = (key: string): string[] => [...wranglerArgv(), "kv", "key", "get", key, ...kvTarget];

const proc = Bun.spawn(kvGetArgv(MANIFEST_KEY), { stdout: "pipe", stderr: "pipe" });
const out = await new Response(proc.stdout).text();
const errText = await new Response(proc.stderr).text();
if ((await proc.exited) !== 0) {
	const noise = /Logs were written to|^\s*$|^\s*🪵/;
	const detail = (errText.trim() || out.trim() || "no output")
		.split("\n")
		.filter((line) => !noise.test(line))
		.join("\n  ")
		.trim();
	// A namespace that has never been published to simply has no manifest key.
	// That is an ANSWER — "nothing here yet" — not a failure to ask.
	if (/not found|does not exist|no value/i.test(detail)) {
		console.error(`store-age: ${WHERE} holds no manifest at ${MANIFEST_KEY} — nothing has been published.`);
		process.exit(1);
	}
	console.error(`store-age: could not read the manifest from ${WHERE} —\n  ${detail}`);
	process.exit(2);
}
const json = out.trim();
if (!json) {
	console.error(`store-age: ${WHERE} holds no manifest — nothing has been seeded yet.`);
	process.exit(1);
}

let manifest: {
	built_at?: string;
	store_bytes?: number;
	chunk_count?: number;
	store_key?: string;
	content_generation?: number;
	partition_count?: number;
	format_version?: number;
	partitions?: { store_key?: string; store_bytes?: number; chunk_count?: number }[];
};
try {
	manifest = JSON.parse(json) as typeof manifest;
} catch {
	console.error("store-age: the published manifest is not valid JSON — treating the store as unusable.");
	process.exit(1);
}
const builtAt = Number(manifest.built_at);
if (!Number.isFinite(builtAt) || builtAt <= 0) {
	console.error(`store-age: the manifest has no usable built_at (${JSON.stringify(manifest.built_at)}).`);
	process.exit(1);
}
// The store may be structurally fine and still hold the wrong VALUES: a builder
// change (lowercase keywords, a new is: tag) leaves the layout untouched, so
// nothing in the header or the byte count catches it and the engine answers
// confidently with stale semantics. Timestamps cannot see this either — the
// store can be newer than every Scryfall dump and still predate the builder.
// So compare generations, and treat older as no usable store.
const publishedGeneration = manifest.content_generation ?? 0;
if (publishedGeneration !== STORE_CONTENT_GENERATION) {
	console.error(
		`store-age: the published store is builder generation ${publishedGeneration}, but this deploy builds ` +
			`generation ${STORE_CONTENT_GENERATION} — its contents no longer match what the code queries.`,
	);
	console.error("           Treating it as no store at all, so the build rebuilds it.");
	process.exit(1);
}
if (!manifest.store_bytes || !manifest.chunk_count) {
	console.error(
		`store-age: the manifest is incomplete (store_bytes=${manifest.store_bytes}, chunk_count=${manifest.chunk_count}).`,
	);
	process.exit(1);
}
// The partition shape is validated UNCONDITIONALLY: readers load only
// partitioned archives, so a manifest without the shape — an unpartitioned one
// left by a store that predates the format, or a malformed partitions[] — is a
// store this deployment cannot serve. Loudly "no store", never quietly
// "current", so the build rebuilds it rather than deploying dark.
//
// The check mirrors manifestShapeProblem's producer-side one (this script
// cannot import it wholesale: that also validates the totals against archive
// files this machine does not hold).
if (
	!Number.isInteger(manifest.partition_count) ||
	!Array.isArray(manifest.partitions) ||
	manifest.partitions.length !== manifest.partition_count ||
	manifest.partitions.some((p) => !p.store_key || !p.store_bytes || !p.chunk_count)
) {
	console.error(
		`store-age: the manifest at ${MANIFEST_KEY} is generation ${STORE_CONTENT_GENERATION} but its ` +
			`partition shape is malformed or absent (partition_count=${manifest.partition_count}, ` +
			`partitions=${manifest.partitions?.length}). This deployment serves partitioned archives only.`,
	);
	console.error("           Treating it as no store at all, so the build rebuilds it.");
	process.exit(1);
}

// A manifest is a POINTER, and a pointer can outlive what it points at: empty
// the namespace key by key and the manifest can be the last one standing (or
// simply the last to propagate), at which point this script would report a
// healthy store, skip the import, and leave every request 503ing on a missing
// chunk. So prove the bytes are really there before believing the manifest.
// One extra read per archive, on its LAST chunk — a truncated upload loses the
// tail first, so the last chunk catches a half-published store as well as an
// emptied one. EVERY partition is probed, because retention retires families
// all-or-nothing but an interrupted publish does not: partitions 0..k can be
// complete while k+1 is missing, and one absent partition 503s every card it
// owns.
for (const target of manifest.partitions ?? []) {
	const lastChunk = chunkKey(target.store_key ?? "", (target.chunk_count ?? 1) - 1);
	const probe = Bun.spawnSync(kvGetArgv(lastChunk));
	if (probe.exitCode !== 0) {
		console.error(
			`store-age: the manifest names ${target.store_key} but ${lastChunk} is not in ${WHERE} — the store is`,
		);
		console.error("           incomplete or was emptied. Treating it as no store at all, so the build rebuilds it.");
		process.exit(1);
	}
}

// The routing filter is OPTIONAL to serve with — a missing one just means the
// bare-id routes fan out — so a missing one is a warning here, not a rebuild.
// The generation bump that shipped the filter is what forces the rebuild
// (STORE_CONTENT_GENERATION 21); this line is how you see it landed.
if (manifest.format_version && manifest.built_at) {
	const key = routingFilterKey(manifest.format_version, String(manifest.built_at));
	if (Bun.spawnSync(kvGetArgv(key)).exitCode !== 0) {
		console.warn(
			`store-age: no routing filter at ${key} — every /cards/<id> lookup will fan out to all ` +
				`${manifest.partition_count} partitions (9 billed DO requests instead of 1).`,
		);
	}
}

const ageMs = Date.now() - builtAt * 1000;
const ago = (ms: number) => {
	const hours = Math.floor(ms / 3600_000);
	const mins = Math.floor((ms % 3600_000) / 60_000);
	return hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
};

if (ageMs > MAX_AGE_HOURS * 3600_000) {
	const hours = (ageMs / 3600_000).toFixed(1);
	console.error(`store-age: the live store was built ${hours}h ago, past the ${MAX_AGE_HOURS}h backstop.`);
	process.exit(1);
}

// The real freshness test. Scryfall regenerates its dumps roughly daily; a
// store built after the newest one already contains everything upstream has.
const upstream = await upstreamUpdatedAt();
if (upstream !== null && builtAt < upstream) {
	console.error(
		`store-age: Scryfall refreshed its dumps ${ago(Date.now() - upstream * 1000)} ` +
			`(${new Date(upstream * 1000).toISOString()}), after this store was built — rebuilding.`,
	);
	process.exit(1);
}
if (upstream !== null) {
	console.error(
		`store-age: Scryfall's newest dump is from ${new Date(upstream * 1000).toISOString()}, ` +
			"already in the live store — no rebuild needed.",
	);
}

console.log(ago(ageMs));
