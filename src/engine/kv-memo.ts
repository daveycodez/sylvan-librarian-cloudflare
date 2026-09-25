/**
 * A per-isolate memo over KV reads of stable, nightly-rewritten values — the reference mirrors
 * (`/sets`, `/catalog/*`, `/symbology`), the rulings buckets and the oracle index's buckets.
 *
 * Those routes used to read KV on every request that reached the Worker. The edge cache is keyed
 * on the full URL, so a request with a fresh query string is a guaranteed miss, and each one was a
 * metered KV read against the same 100k/day budget the request meter draws on — with no `cacheTtl`
 * on the read, so not even the colo cache absorbed it. The keys are stable within a layout
 * version and rewritten nightly, so a short memo is safe: staleness after a publish is bounded by
 * the memo window plus `cacheTtl`, both under the hour the routes' own response tiers already
 * accept.
 *
 * Keyed by the NAMESPACE object, then a POOL, then the key, so two bindings (or two test fakes)
 * never share an entry and one dataset's large values cannot evict another's. A miss is memoized
 * too — an unpublished key must not cost a read per request. A failed read is not memoized: it is
 * reported and retried by the next request.
 */

import { edgeCacheUrl, readThroughEdgeCache } from "./edge-cache";

interface MemoEntry {
	at: number;
	bytes: Uint8Array | null;
}

/** Per namespace, per POOL: one dataset's large values must not evict another's (see `pool`). */
const memos = new WeakMap<KVNamespace, Map<string, Map<string, MemoEntry>>>();

export interface KvMemoOptions {
	/** KV's own colo cache, seconds (minimum 60). */
	cacheTtl?: number;
	/** How long this isolate answers from its copy, ms. */
	memoMs?: number;
	/** Entries kept per namespace and pool, oldest evicted first. */
	maxEntries?: number;
	/** Bytes kept per pool, oldest evicted first (0 = bounded by entry count only). */
	maxBytes?: number;
	/**
	 * Which memo the value competes in. The reference mirrors and rulings buckets share "default";
	 * the oracle index (64 x ~270KB) gets its own, so a burst of its reads cannot flush them.
	 */
	pool?: string;
	/**
	 * Read through the colo's Cache API for this many seconds before KV (edge-cache.ts): unmetered
	 * and shared by every isolate in the colo, where a KV `get` bills even on a colo-cache hit.
	 * 0 = KV only, which is what every caller before the oracle index keeps.
	 */
	edgeTtl?: number;
	/**
	 * With `edgeTtl`: how long the colo remembers that the key is ABSENT, seconds (0 = never, so the
	 * next reader asks KV). For a key read per request whose absence is a normal state for a while.
	 */
	edgeMissTtl?: number;
	/** `ctx.waitUntil`, so the edge-cache store is off the request path. */
	defer?: (p: Promise<unknown>) => void;
}

export const KV_MEMO_DEFAULTS: Required<Omit<KvMemoOptions, "defer">> = {
	cacheTtl: 3600,
	memoMs: 60_000,
	maxEntries: 8,
	maxBytes: 0,
	pool: "default",
	edgeTtl: 0,
	edgeMissTtl: 0,
};

/** The value under `key` as bytes, or null when absent — from this isolate's memo when fresh. */
export async function readKvBytesMemo(
	kv: KVNamespace,
	key: string,
	options: KvMemoOptions = {},
): Promise<Uint8Array | null> {
	const { cacheTtl, memoMs, maxEntries, maxBytes, pool, edgeTtl, edgeMissTtl } = { ...KV_MEMO_DEFAULTS, ...options };
	let pools = memos.get(kv);
	if (!pools) {
		pools = new Map();
		memos.set(kv, pools);
	}
	let memo = pools.get(pool);
	if (!memo) {
		memo = new Map();
		pools.set(pool, memo);
	}
	const now = Date.now();
	const hit = memo.get(key);
	if (hit && now - hit.at < memoMs) return hit.bytes;
	const fromKv = async (): Promise<Uint8Array | null> => {
		const value = await kv.get(key, { type: "arrayBuffer", cacheTtl });
		return value === null ? null : new Uint8Array(value);
	};
	const bytes =
		edgeTtl > 0
			? await readThroughEdgeCache(edgeCacheUrl(key), edgeTtl, fromKv, options.defer, edgeMissTtl)
			: await fromKv();
	memo.delete(key);
	const incoming = bytes?.byteLength ?? 0;
	let held = 0;
	if (maxBytes > 0) for (const entry of memo.values()) held += entry.bytes?.byteLength ?? 0;
	while (memo.size >= maxEntries || (maxBytes > 0 && memo.size > 0 && held + incoming > maxBytes)) {
		const oldest = memo.keys().next();
		if (oldest.done) break;
		held -= memo.get(oldest.value)?.bytes?.byteLength ?? 0;
		memo.delete(oldest.value);
	}
	memo.set(key, { at: now, bytes });
	return bytes;
}

/** Test hook: forget every memoized value for a namespace, in every pool. */
export function forgetKvMemo(kv: KVNamespace): void {
	memos.delete(kv);
}
