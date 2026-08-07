// First-deploy bootstrap page: shown on HTML routes while the card index is
// being built (empty R2 bucket → import container running). Auto-refreshes;
// once the manifest lands, the normal UI takes over. This page is the one
// intentional addition to upstream's surface — upstream answers 503 here,
// which is still what all JSON endpoints do.

import { importStatus } from "./store";
import type { Env } from "./types";

export async function bootstrapPage(env: Env): Promise<Response> {
	let statusLine = "starting up";
	try {
		const status = (await importStatus(env)) as {
			run?: { state?: string; startedAt?: string };
			builder?: { state?: string; phase?: string };
		};
		const phase = status.builder?.phase ?? status.run?.state ?? "starting";
		statusLine = String(phase);
	} catch {
		// Coordinator not reachable yet (first seconds after deploy) — keep the default.
	}
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Sylvan Librarian — building card index</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#1a2318;color:#e8efe4}
main{text-align:center;max-width:34rem;padding:2rem}
h1{font-size:1.4rem;font-weight:600}
p{color:#a9bba1;line-height:1.5}
code{background:#26332270;padding:.1rem .4rem;border-radius:4px}
.spin{width:2rem;height:2rem;margin:0 auto 1.5rem;border:3px solid #3d4f37;border-top-color:#8fbc7f;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<main>
<div class="spin"></div>
<h1>Building the card index</h1>
<p>First-time setup: streaming Scryfall bulk data and building the search
engine store. This takes a few minutes and happens only once (then nightly,
invisibly).</p>
<p>Current status: <code>${statusLine.replace(/[<>&]/g, "")}</code></p>
<p>This page refreshes automatically.</p>
</main>
</body>
</html>`;
	return new Response(html, {
		status: 503,
		headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5" },
	});
}
