// Manifest read, factored out of store.ts so route handlers (and their tests)
// can use it without pulling in the wasm engine module — the
// "sylvan-engine-wasm" alias only resolves inside the wrangler bundle.

import type { Env, StoreManifest } from "./types";

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
