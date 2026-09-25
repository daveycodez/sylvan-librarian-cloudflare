// How to invoke wrangler, in one place.
//
// Prefer the installed binary over `bunx wrangler`, because `bunx` under the
// bun that Workers Builds ships (1.2.15) does not pass an argument containing
// spaces through intact. A query sent that way arrived at wrangler as its first
// word, with the rest reported as stray arguments:
//
//   ✘ [ERROR] Unknown arguments: json, FROM, store_manifest, WHERE, id, =, 1
//
// which silently broke the freshness check on EVERY deploy — the manifest was
// there, the deploy could not read it, and a 450MB import ran every time. Newer
// bun does not split, which is why it never reproduced locally.
//
// `--file` is not a workaround: that path routes through D1's server-side
// import and returns execution STATISTICS rather than rows, so it cannot answer
// a SELECT at all. Statements go through files; queries need argv to survive.
//
// Spawning the binary directly with an array argv means no shell and no
// wrapper, so arguments arrive exactly as written whatever bun is in play.

import { existsSync } from "node:fs";

const LOCAL_WRANGLER = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;

/**
 * Argv prefix for a wrangler invocation, e.g.
 * `[...wranglerArgv(), "d1", "execute", ...]`.
 *
 * Falls back to `bunx wrangler` when the binary is absent (a workspace whose
 * dependencies are not installed yet). The fallback carries the space-splitting
 * hazard above, so callers that pass a space-bearing argument should expect the
 * failure to be reported, not silently absorbed.
 */
export function wranglerArgv(): string[] {
	return existsSync(LOCAL_WRANGLER) ? [LOCAL_WRANGLER] : ["bunx", "wrangler"];
}

/**
 * What a failed wrangler run actually said. Its last lines are the same footer every time ("If you
 * think this is a bug… Logs were written to …"), which is all the deploy logs of 2026-09-25 kept of
 * three failed chunk puts; the `✘ [ERROR]` line and what follows it are the cause.
 */
export function wranglerFailure(output: string): string {
	const lines = output
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim() && !/If you think this is a bug|Logs were written to/.test(l));
	const at = lines.findIndex((l) => /\[ERROR\]|✘/.test(l));
	return (at >= 0 ? lines.slice(at, at + 6) : lines.slice(-6)).join(" | ") || "no output";
}
