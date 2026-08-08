// Manifest read + bootstrap kick, factored out of store.ts so route handlers
// (and their tests) can use them without pulling in the wasm engine module —
// the "sylvan-engine-wasm" alias only resolves inside the wrangler bundle.

import type { Env, StoreManifest } from "./types";

/** Per-isolate rate limit on bootstrap kicks; the coordinator DO dedupes anyway. */
const BOOTSTRAP_KICK_INTERVAL_MS = 60 * 1000;
let lastBootstrapKick = 0;

export async function readManifest(env: Env): Promise<StoreManifest | null> {
	try {
		const row = await env.STORE_DB.prepare("SELECT json FROM store_manifest WHERE id = 1").first<{ json: string }>();
		if (!row) return null;
		return JSON.parse(row.json) as StoreManifest;
	} catch (err) {
		// A fresh database has no tables yet — that is the bootstrap state, not
		// an error. Anything else propagates.
		if (String(err).includes("no such table")) return null;
		throw err;
	}
}

/** Ask the coordinator to start the bootstrap import (rate-limited per
 * isolate; the DO serializes concurrent kicks from many isolates). Returns
 * the kick's promise so request handlers can waitUntil it; DO-side callers
 * fire-and-forget. */
export function kickBootstrap(env: Env, reason: string): Promise<void> {
	const now = Date.now();
	if (now - lastBootstrapKick < BOOTSTRAP_KICK_INTERVAL_MS) return Promise.resolve();
	lastBootstrapKick = now;
	const coordinator = env.IMPORT_COORDINATOR.get(env.IMPORT_COORDINATOR.idFromName("singleton"));
	return coordinator
		.fetch(`https://coordinator/start-import?reason=${encodeURIComponent(reason)}`)
		.then(() => undefined)
		.catch((err) => {
			console.error("Failed to kick bootstrap import:", err);
		});
}
