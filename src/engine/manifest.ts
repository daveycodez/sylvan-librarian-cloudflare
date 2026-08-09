// Manifest read, factored out of store.ts so route handlers (and their tests)
// can use it without pulling in the wasm engine module — the
// "sylvan-engine-wasm" alias only resolves inside the wrangler bundle.

import type { Env, StoreManifest } from "./types";
import { EngineUnavailableError } from "./types";

export async function readManifest(env: Env): Promise<StoreManifest | null> {
	try {
		const row = await env.STORE_DB.prepare("SELECT json FROM store_manifest WHERE id = 1").first<{ json: string }>();
		if (!row) return null;
		return JSON.parse(row.json) as StoreManifest;
	} catch (err) {
		// An empty database has no tables yet: "no index published", reported by
		// the caller as such. Anything else — the D1 database deleted from under
		// a running deployment, a binding that no longer resolves — becomes an
		// EngineUnavailableError carrying the platform's own message, so the
		// reason reaches the response instead of being flattened into a generic
		// 500 by the dispatcher's catch-all.
		if (String(err).includes("no such table")) return null;
		throw new EngineUnavailableError(`Cannot read the store manifest from D1: ${err}`, false);
	}
}
