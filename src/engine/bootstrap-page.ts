// First-deploy bootstrap page: shown on HTML routes (including the bare
// homepage) while the card index is being built — empty D1, ImportCoordinator
// DO running the in-Worker import. Auto-refreshes with the live phase; once
// the manifest lands, the normal UI takes over. This page is the one
// intentional addition to upstream's surface — upstream answers 503 here,
// which is still what all JSON endpoints do.
//
// Only the FIRST build reaches this page: the caller gates it on there being
// no store manifest in D1 at all. Once a store is published, a failing
// nightly re-import never replaces the working site with this page — the
// previous store keeps serving, which is the whole point of building the new
// one off to the side.
//
// A failed run is reported rather than hidden behind a spinner that would
// otherwise turn forever: an import that has exhausted its retries is not
// coming back on its own before the next scheduled run, and a first-deploy
// operator staring at "building..." has no other signal that anything broke.

import { importStatus } from "./store";
import type { Env } from "./types";

/** Escape for HTML text content — status/error strings are not trusted. */
function esc(s: string): string {
	return s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

interface StatusShape {
	run?: { state?: string; startedAt?: string; finishedAt?: string; detail?: string };
	builder?: {
		state?: string;
		phase?: string;
		detail?: string;
		printings?: number;
		retrying?: { attempt?: number; of?: number; error?: string };
		/** Set when the coordinator's storage is refusing operations (free-tier
		 * daily rows_written spent) — carries the platform's own message. */
		blocked?: string;
	};
}

export async function bootstrapPage(env: Env): Promise<Response> {
	let status: StatusShape = {};
	let reachable = true;
	try {
		status = (await importStatus(env)) as StatusShape;
	} catch {
		// Coordinator not reachable yet (first seconds after deploy), or it is
		// itself erroring — either way, say so instead of implying progress.
		reachable = false;
	}

	const blocked = status.builder?.blocked;
	const failed = status.run?.state === "failed";
	const retrying = status.builder?.retrying;
	const phase = status.builder?.phase ?? status.run?.state ?? (reachable ? "starting" : "unreachable");
	const detail = status.builder?.detail;
	const printings = status.builder?.printings ?? 0;

	// A failed run stops refreshing: reloading restarts the import from
	// scratch, so an auto-refresh loop would silently retry forever and
	// re-download the dumps every 5 seconds. A quota block refreshes slowly —
	// it clears on its own at a known time, and hammering it changes nothing.
	const refresh = failed ? "" : `<meta http-equiv="refresh" content="${blocked ? 300 : 5}">`;

	let body: string;
	if (blocked) {
		// Time until the next 00:00 UTC, when free-tier daily limits reset. Show
		// the absolute time too: a countdown near 24h means the window just
		// rolled over, which reads as alarming without that context (quota
		// accounting can lag a few minutes behind the reset).
		const now = new Date();
		const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
		const mins = Math.max(0, Math.round((reset - now.getTime()) / 60000));
		const when = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
		const nextReset = new Date(reset).toISOString().replace(".000Z", "Z");
		body = `<div class="bad">!</div>
<h1>Paused by a daily platform limit</h1>
<p>The import coordinator's storage is refusing operations, so the build cannot
continue right now. It reported:</p>
<pre>${esc(blocked)}</pre>
<p>Durable Objects free-tier daily limits reset at 00:00 UTC. The next reset is
<code>${esc(nextReset)}</code>, in ${when}. The build resumes on its own after
that — progress already on disk is kept, so it continues rather than starting
over.</p>
<p class="dim">If that countdown is close to 24 hours, the window has just reset
and this should clear shortly — quota accounting can lag the reset by several
minutes. This page rechecks every 5 minutes.</p>`;
	} else if (failed) {
		const reason = status.run?.detail ?? "no detail recorded";
		const when = status.run?.finishedAt ? ` at ${esc(status.run.finishedAt)}` : "";
		body = `<div class="bad">!</div>
<h1>The card index build failed</h1>
<p>The import gave up after ${esc(String(retrying?.of ?? 8))} retries${when}. It reported:</p>
<pre>${esc(reason)}</pre>
<p>The next scheduled import retries automatically on a fresh run. To retry
now, reload this page — that starts a new build from the beginning.</p>
<p class="dim">Worker logs have the full stack: <code>wrangler tail</code>.</p>`;
	} else if (!reachable) {
		body = `<div class="spin"></div>
<h1>Building the card index</h1>
<p>Waiting for the import coordinator to come up. If this persists for more
than a minute, check the Worker logs — the coordinator may be failing to
start.</p>
<p>This page refreshes automatically.</p>`;
	} else {
		const progress = detail ? `<p>Progress: <code>${esc(detail)}</code></p>` : "";
		const staged = printings > 0 ? `<p>${printings.toLocaleString("en-US")} printings processed so far.</p>` : "";
		const warn = retrying
			? `<p class="warn">Retrying after an error (attempt ${esc(String(retrying.attempt))} of
${esc(String(retrying.of))}). Transient failures are expected; the run only fails
if the retries run out.</p>${retrying.error ? `<pre>${esc(retrying.error)}</pre>` : ""}`
			: "";
		body = `<div class="spin"></div>
<h1>Building the card index</h1>
<p>First-time setup: streaming Scryfall bulk data and building the search
engine store. This takes a few minutes and happens only once (then nightly,
invisibly).</p>
<p>Current status: <code>${esc(String(phase))}</code></p>
${progress}
${staged}
${warn}
<p>This page refreshes automatically.</p>`;
	}

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>Sylvan Librarian — ${blocked ? "card index build paused" : failed ? "card index build failed" : "building card index"}</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#1a2318;color:#e8efe4}
main{text-align:center;max-width:34rem;padding:2rem}
h1{font-size:1.4rem;font-weight:600}
p{color:#a9bba1;line-height:1.5}
code{background:#26332270;padding:.1rem .4rem;border-radius:4px}
pre{background:#26332270;padding:.75rem;border-radius:6px;text-align:left;white-space:pre-wrap;word-break:break-word;color:#e8b4a8;font-size:.85rem;line-height:1.4}
.dim{color:#7c8c75;font-size:.9rem}
.warn{color:#d8c07f}
.spin{width:2rem;height:2rem;margin:0 auto 1.5rem;border:3px solid #3d4f37;border-top-color:#8fbc7f;border-radius:50%;animation:s 1s linear infinite}
.bad{width:2rem;height:2rem;line-height:2rem;margin:0 auto 1.5rem;border-radius:50%;background:#5c2b26;color:#f0b8ae;font-weight:700}
@keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
	return new Response(html, {
		status: 503,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			...(failed ? {} : { "Retry-After": blocked ? "300" : "5" }),
		},
	});
}
