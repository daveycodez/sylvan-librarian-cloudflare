// Print how recently the live store was built, or exit non-zero if there is
// no usable store. Used by scripts/deploy.sh to decide whether a deploy needs
// to run the bulk import: a routine code push should not re-download ~450MB
// and republish an identical store.
//
//   bun scripts/store-age.ts        -> "2h ago" (exit 0) | nothing (exit 1)
//
// "Usable" means a manifest that parses and carries a build time, a byte
// count and a chunk count. A store older than MAX_AGE_HOURS is treated as
// absent so a long-dormant deployment refreshes on its next deploy rather than
// serving a stale index until the nightly cron happens to fire.
//
// Every failure path exits 1 — unreadable manifest, no D1 access, ambiguous
// account. That biases towards running the import, which costs build minutes
// but never leaves a deploy without an index.

export {};

const MAX_AGE_HOURS = 20;

const proc = Bun.spawn(
	[
		"bunx",
		"wrangler",
		"d1",
		"execute",
		"sylvan-librarian",
		"--remote",
		"-y",
		"--json",
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
	const hint = (errText.trim() || out.trim() || "no output").split("\n").slice(-3).join(" ");
	console.error(`store-age: could not read the manifest from D1 — ${hint}`);
	process.exit(1);
}

// wrangler --json prints an array of result sets; a missing table is an error
// (non-zero above), an empty table is an empty results array.
let json: string | undefined;
try {
	const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results?: { json?: string }[] }[];
	json = parsed[0]?.results?.[0]?.json;
} catch {
	process.exit(1);
}
if (!json) process.exit(1);

let manifest: { built_at?: string; store_bytes?: number; chunk_count?: number };
try {
	manifest = JSON.parse(json) as typeof manifest;
} catch {
	process.exit(1);
}
const builtAt = Number(manifest.built_at);
if (!Number.isFinite(builtAt) || builtAt <= 0) process.exit(1);
if (!manifest.store_bytes || !manifest.chunk_count) process.exit(1);

const ageMs = Date.now() - builtAt * 1000;
if (ageMs > MAX_AGE_HOURS * 3600_000) process.exit(1);

const hours = Math.floor(ageMs / 3600_000);
const mins = Math.floor((ageMs % 3600_000) / 60_000);
console.log(hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`);
