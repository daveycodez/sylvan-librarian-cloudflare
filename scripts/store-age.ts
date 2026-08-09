// Print how recently the live store was built, or exit non-zero if there is
// no usable store. Used by scripts/deploy.sh to decide whether a deploy needs
// to run the bulk import: a routine code push should not re-download ~450MB
// and republish an identical store.
//
//   bun scripts/store-age.ts        -> "2h ago" (exit 0)
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
// missing or stale, 2 says this script could not reach D1 — and a 2 reported
// as a 1 is a broken query that presents as an eternally-empty database, which
// is exactly the failure this split exists to make visible. Every path says
// why on stderr; callers must show that text, not discard it.

import { d1Name } from "./project-config";
import { wranglerArgv } from "./wrangler-cmd";

/** Backstop only — see the header. A week covers "nothing upstream changed but
 * this repo did", without reinstating a nightly rebuild of identical bytes. */
const MAX_AGE_HOURS = 7 * 24;

const BULK_DATA_URL = process.env.SCRYFALL_BULK_URL ?? "https://api.scryfall.com/bulk-data";
/** The dumps an import actually reads; a refresh of any of them is a change. */
const DUMP_KINDS = ["default_cards", "oracle_tags", "art_tags"];

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

// Spawned through wranglerArgv(), NOT `bunx` — this statement contains spaces,
// and `bunx` under Workers Builds' bun splits them, which is precisely what
// made this check fail on every deploy. See scripts/wrangler-cmd.ts.
const proc = Bun.spawn(
	[
		...wranglerArgv(),
		"d1",
		"execute",
		d1Name,
		"--remote",
		"-y",
		"--json",
		// Same config the seeder writes through, so a read and a write can never
		// resolve to different databases.
		"-c",
		"wrangler.jsonc",
		"--command",
		"SELECT json FROM store_manifest WHERE id = 1",
	],
	{ stdout: "pipe", stderr: "pipe" },
);
const out = await new Response(proc.stdout).text();
const errText = await new Response(proc.stderr).text();
if ((await proc.exited) !== 0) {
	// Say why on stderr: "couldn't ask D1" and "no store yet" both mean the
	// deploy imports, but only one of them is worth acting on (an ambiguous
	// account needs CLOUDFLARE_ACCOUNT_ID, or every deploy re-imports).
	// wrangler puts some failures (e.g. "more than one account available") on
	// stdout rather than stderr, so fall back to whichever carried text.
	//
	// Print ALL of it, minus wrangler's own footer. A tail-of-3-lines slice
	// looked tidy and reported this:
	//
	//   could not read the manifest from D1 — 🪵 Logs were written to "..."
	//
	// which is the one line carrying no information, because the actual error
	// sits ABOVE the footer. A diagnostic that truncates the diagnosis is the
	// same bug as the `2>/dev/null` this replaced, one layer further in.
	const noise = /Logs were written to|^\s*$|^\s*🪵/;
	const detail = (errText.trim() || out.trim() || "no output")
		.split("\n")
		.filter((line) => !noise.test(line))
		.join("\n  ")
		.trim();
	// A database that has never been published to has no store_manifest table.
	// That is an ANSWER — "nothing here yet" — not a failure to ask, and
	// conflating the two turns a first deploy into an alarming red herring.
	if (/no such table/i.test(detail)) {
		console.error("store-age: this database has no store_manifest table — nothing has ever been published to it.");
		process.exit(1);
	}
	console.error(`store-age: could not read the manifest from D1 —\n  ${detail}`);
	process.exit(2);
}

// wrangler --json prints an array of result sets; a missing table is an error
// (non-zero above), an empty table is an empty results array.
let json: string | undefined;
try {
	const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results?: { json?: string }[] }[];
	json = parsed[0]?.results?.[0]?.json;
} catch {
	// wrangler exited 0 but did not hand back the result shape we parse. That
	// is this script failing to read D1, not D1 saying the store is missing.
	console.error(`store-age: could not parse wrangler's output —\n  ${out.trim().split("\n").join("\n  ")}`);
	process.exit(2);
}
if (!json) {
	console.error("store-age: store_manifest has no row — nothing has been published to this database yet.");
	process.exit(1);
}

let manifest: { built_at?: string; store_bytes?: number; chunk_count?: number };
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
if (!manifest.store_bytes || !manifest.chunk_count) {
	console.error(
		`store-age: the manifest is incomplete (store_bytes=${manifest.store_bytes}, chunk_count=${manifest.chunk_count}).`,
	);
	process.exit(1);
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
