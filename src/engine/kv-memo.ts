/**
 * A per-isolate memo over KV reads of stable, nightly-rewritten values — the reference mirrors
 * (`/sets`, `/catalog/*`, `/symbology`) and the rulings buckets.
 *
 * Those routes used to read KV on every request that reached the Worker. The edge cache is keyed
 * on the full URL, so a request with a fresh query string is a guaranteed miss, and each one was a
 * metered KV read against the same 100k/day budget the request meter draws on — with no `cacheTtl`
 * on the read, so not even the colo cache absorbed it. The keys are stable within a layout
 * version and rewritten nightly, so a short memo is safe: staleness after a publish is bounded by
 * the memo window plus `cacheTtl`, both under the hour the routes' own response tiers already
 * accept.
 *
 * Keyed by the NAMESPACE object and then the key, so two bindings (or two test fakes) never share
 * an entry. A miss is memoized too — an unpublished key must not cost a read per request. A failed
 * read is not memoized: it is reported and retried by the next request.
 */

interface MemoEntry {
	at: number;
	bytes: Uint8Array | null;
}

const memos = new WeakMap<KVNamespace, Map<string, MemoEntry>>();

export interface KvMemoOptions {
	/** KV's own colo cache, seconds (minimum 60). */
	cacheTtl?: number;
	/** How long this isolate answers from its copy, ms. */
	memoMs?: number;
	/** Entries kept per namespace, oldest evicted first. */
	maxEntries?: number;
}

export const KV_MEMO_DEFAULTS: Required<KvMemoOptions> = { cacheTtl: 3600, memoMs: 60_000, maxEntries: 8 };

/** The value under `key` as bytes, or null when absent — from this isolate's memo when fresh. */
export async function readKvBytesMemo(
	kv: KVNamespace,
	key: string,
	options: KvMemoOptions = {},
): Promise<Uint8Array | null> {
	const { cacheTtl, memoMs, maxEntries } = { ...KV_MEMO_DEFAULTS, ...options };
	let memo = memos.get(kv);
	if (!memo) {
		memo = new Map();
		memos.set(kv, memo);
	}
	const now = Date.now();
	const hit = memo.get(key);
	if (hit && now - hit.at < memoMs) return hit.bytes;
	const value = await kv.get(key, { type: "arrayBuffer", cacheTtl });
	const bytes = value === null ? null : new Uint8Array(value);
	memo.delete(key);
	while (memo.size >= maxEntries) {
		const oldest = memo.keys().next();
		if (oldest.done) break;
		memo.delete(oldest.value);
	}
	memo.set(key, { at: now, bytes });
	return bytes;
}

/** Test hook: forget every memoized value for a namespace. */
export function forgetKvMemo(kv: KVNamespace): void {
	memos.delete(kv);
}
