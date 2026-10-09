// Write the `is:` lists table the last nightly import refreshed, for the deploy's native build.
//
//   bun scripts/is-lists-override.ts --remote --out store-build/is-lists-override.tsv
//   bun scripts/is-lists-override.ts --out FILE          # wrangler's local dev KV
//
// THE DEPLOY TAGS FROM THE LISTS THE NIGHTLY DID. Eight `is:` values are Scryfall's own record,
// tagged from a table compiled into the builder (engine/builder/src/is_lists.tsv). The nightly
// import refreshes that table from api.scryfall.com before it builds and leaves what it read in
// one KV value (src/import-is-lists.ts, IS_LISTS_KV_KEY). A deploy rebuilds the store whenever
// Scryfall has regenerated its dumps since the live store was built — most pushes — and if it
// tagged from the compiled table alone, every such deploy would take `is:covered`,
// `is:related` and the rest back to the day the table was committed until the next 11:17 UTC.
// So the deploy reads the same value, composes the same table with the same code
// (`composeOverride`) and hands it to the builder (`sylvan-store-builder --is-lists`).
//
// It asks Scryfall NOTHING: a deploy's lists are the last night's, never fresher, so the store a
// deploy publishes and the store the nightly published differ only by the dumps between them.
//
// The state names the compiled table it refines (its fingerprint). After a commit that regenerates
// the table (`bun run is-lists`) the stored state is for the old one: nothing is written, the
// deploy builds from the new compiled table, and the next nightly starts its state over from it.
//
// NEVER FATAL, and always says which it was. With no file written the builder is run without
// `--is-lists` and tags from the compiled table — what every deploy did before this existed.
//
// READ-ONLY against KV, so it is not gated to the deploy environment (kv-target.ts): looking at
// what the nightly left must stay possible from anywhere.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeOverride, IS_LISTS_KV_KEY, noteOf, readCompiled, usableState } from "../src/import-is-lists";
import { kvTargetArgs } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

const REMOTE = process.argv.includes("--remote");
const outAt = process.argv.indexOf("--out");
const OUT = outAt >= 0 ? process.argv[outAt + 1] : undefined;
if (!OUT) {
	console.error("usage: bun scripts/is-lists-override.ts [--remote] --out FILE");
	process.exit(2);
}

/** The compiled table, the bytes the builder `include_str!`s. */
const COMPILED = join(import.meta.dir, "..", "engine", "builder", "src", "is_lists.tsv");

/** `wrangler kv key get` as text, or null when the key is absent (publish-tag-aliases.ts kvGet). */
async function kvGet(key: string): Promise<string | null> {
	const target = await kvTargetArgs(REMOTE);
	const proc = Bun.spawn([...wranglerArgv(), "kv", "key", "get", key, ...target], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) return null;
	const at = out.indexOf("{");
	return at === -1 ? null : out.slice(at);
}

// A file left by an earlier build must not be handed to this one.
rmSync(OUT, { force: true });
try {
	const compiled = readFileSync(COMPILED, "utf8");
	const { base } = readCompiled(compiled);
	const text = await kvGet(IS_LISTS_KV_KEY);
	if (text === null) {
		console.log(`is: lists: no nightly has refreshed them yet — building with the compiled table (${base.date}).`);
		process.exit(0);
	}
	const state = usableState(JSON.parse(text), base);
	if (state === null) {
		console.log(
			`is: lists: the stored refresh is for another compiled table than this commit's (${base.date}) — ` +
				"building with the compiled table; the next nightly starts over from it.",
		);
		process.exit(0);
	}
	const table = composeOverride(compiled, state);
	if (table === null) {
		console.log(
			`is: lists: the nightly has refreshed nothing over the compiled table (${base.date}) — building with it.`,
		);
		process.exit(0);
	}
	writeFileSync(OUT, table);
	const note = noteOf(state, base.date);
	console.log(
		`is: lists: ${OUT} — the last nightly's table over ${base.date}'s (checked ${note.checked ?? "never"}; ` +
			`${Object.keys(note.fetched ?? {}).length} lists and ${note.sets ?? 0} sets read; ${table.split("\n").length - 5} lines).`,
	);
} catch (err) {
	rmSync(OUT, { force: true });
	console.log(`is: lists: could not read the nightly's refresh (${err}) — building with the compiled table.`);
}
