// The oracle-tag partitions blob: which partitions hold a card carrying each `otag:` value, so a
// bare `otag:X` search asks only those instead of all N.
//
// WHY IT EXISTS. On DeckGen (paid account, the 24 hours to 2026-10-23 ~21:00 UTC) 3,259
// `/cards/search` misses a day were a bare `otag:X` — a crawl of mostly-distinct tags (`synergy-*`
// and the like), 277 of them 404s — and each one was a full gather: one coordinator call plus N-1
// sibling calls, p50 654 / p90 1,302 ms cold in wnam. A tag lives on the cards it tags, and the
// store is cut by oracle id, so most tags live in a few partitions (27 sampled tags: ~7.6 of 12 on
// average, several in one or two) and an unknown tag lives in none. With this blob the router asks
// exactly the holders (card-restriction.ts), and an unknown tag's 404 costs one call.
//
// WHAT GOES IN is decided by the ENGINE at build time, per partition: card_engine `oracle_tags_of`
// lists the distinct `coll_vocab` strings of every card's `card_oracle_tags`, read off the
// structures the archive was just serialized from. `otag:x` is a `CollectionCmp` on exactly that
// field (filter.rs), so the list is the engine's own stored tags — ancestors included (the builder
// denormalizes them onto each card), alias spellings absent (the parser resolves them to the slug
// before the wire, tag-aliases.ts) — and it covers every row of every mode: canonical printings,
// extras, variations and the foreign annex all belong to one of these cards.
//
// Both publishers hand those per-partition slugs to `encodeOracleTagPartitions` below, each led by
// its partition — the native builder through its `oracle-tags.tsv` sidecar
// (scripts/oracle-tags-build.ts), which the builder writes led, the nightly through one staged emit
// per partition build (import-coordinator.ts), which the coordinator leads (`ledByPartition`) — so
// the two blobs are the same bytes by construction; the import harness checks it.
//
// THE FORMAT, raw (KV holds it gzipped):
//
//   sylvan-oracle-tags/1\n
//   <partition_count>\t<partition_hash>\n
//   <slug>\t<mask>\n          one per distinct slug, sorted by slug; <mask> is lowercase hex, bit p
//                             set when partition p holds a card carrying the slug
//
// ~4,500 slugs on the 2026-08-16 dumps, ~95KB raw and ~25KB gzipped (measured at publish; the
// publishers log it). The partition count and hash are checked against the manifest the request is
// pinned to, so a blob is never read under another modulus.
//
// WHERE IT LIVES: one KV value per build, `store:card-otags-v<fmt>-<built_at>.store:0`
// (generationKey), named by the manifest (`otags_key`, with its stored length as `otags_bytes`), so
// retention keeps and retires it with its build. ABSENT — a build published before it, a publisher
// that could not build it — every `otag:` search asks every partition, exactly as before.
//
// WHERE IT IS READ: the router isolate (partitioned-engine.ts), through the colo's Cache API
// (edge-cache.ts) and then KV, once per isolate per build, never awaited past ORACLE_TAGS_WAIT_MS:
// a request that cannot have it in time gathers from every partition, which is always correct.

import { edgeCacheUrl, readThroughEdgeCache } from "./edge-cache";
import { generationKey, kvBytesMetadata } from "./kv-retention";
import { gzipBytes, KV_VALUE_CAP_BYTES } from "./store-kv";
import type { Env, StoreManifest } from "./types";

/** The blob's first line. A reader refuses any other. */
export const ORACLE_TAGS_HEADER = "sylvan-oracle-tags/1\n";

/** The widest modulus a mask spells exactly: a JS number holds every integer below 2^53. */
export const ORACLE_TAGS_MAX_PARTITIONS = 53;

/** The oracle-tags blob of one build: `store:card-otags-v<fmt>-<built_at>.store:0`. */
export function oracleTagsKey(formatVersion: number, builtAt: string): string {
	return generationKey("otags", formatVersion, builtAt);
}

/**
 * The manifest's oracle-tags blob, or null when it names none — in which case every `otag:` search
 * asks every partition, as it always did. Read-tolerant: a malformed pair of fields is "none".
 */
export function oracleTagsOf(manifest: StoreManifest | null | undefined): { key: string; bytes: number } | null {
	const key = manifest?.otags_key;
	const bytes = manifest?.otags_bytes;
	if (typeof key !== "string" || !key.startsWith("store:card-otags-")) return null;
	if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return null;
	return { key, bytes };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const encoder = new TextEncoder();

/** A slug a line can carry: non-empty, no tab, no line break. */
function spellable(slug: string): boolean {
	return slug !== "" && !/[\t\r\n]/.test(slug);
}

/**
 * The raw blob from every partition's slug lines (`<partition>\t<slug>`), in any order and with any
 * repeats — THE one encoder both publishers use, so the bytes depend on neither build order nor
 * publisher. Throws on a line that is not a partition below `partitionCount` and a spellable slug:
 * a publisher must publish no blob rather than one that misplaces a tag.
 */
export function encodeOracleTagPartitions(
	parts: Iterable<Uint8Array>,
	partitionCount: number,
	partitionHash: string,
): Uint8Array {
	if (!Number.isInteger(partitionCount) || partitionCount < 1 || partitionCount > ORACLE_TAGS_MAX_PARTITIONS) {
		throw new Error(`oracle tags: partition count ${partitionCount} does not fit a mask`);
	}
	if (!spellable(partitionHash)) throw new Error(`oracle tags: partition hash ${JSON.stringify(partitionHash)}`);
	const holders = new Map<string, Set<number>>();
	for (const part of parts) {
		const text = utf8.decode(part);
		if (text.length > 0 && !text.endsWith("\n")) throw new Error("oracle tags: a partition's lines do not end in \\n");
		for (const line of text.split("\n")) {
			if (line === "") continue;
			const tab = line.indexOf("\t");
			const field = tab === -1 ? "" : line.slice(0, tab);
			const slug = tab === -1 ? "" : line.slice(tab + 1);
			const p = Number(field);
			if (!/^\d+$/.test(field) || p >= partitionCount || !spellable(slug)) {
				throw new Error(`oracle tags: malformed line ${JSON.stringify(line.slice(0, 80))}`);
			}
			let set = holders.get(slug);
			if (set === undefined) {
				set = new Set();
				holders.set(slug, set);
			}
			set.add(p);
		}
	}
	const slugs = [...holders.keys()].sort();
	let out = `${ORACLE_TAGS_HEADER}${partitionCount}\t${partitionHash}\n`;
	for (const slug of slugs) {
		let mask = 0;
		for (const p of holders.get(slug) as Set<number>) mask += 2 ** p;
		out += `${slug}\t${mask.toString(16)}\n`;
	}
	return encoder.encode(out);
}

/** A parsed blob: each slug's partition mask, for one modulus. */
export class OracleTagPartitions {
	private constructor(
		private readonly masks: ReadonlyMap<string, number>,
		readonly partitionCount: number,
		readonly partitionHash: string,
	) {}

	/** How many slugs the build carries. */
	get size(): number {
		return this.masks.size;
	}

	/**
	 * The partitions holding a card that carries `slug`, ascending — EMPTY for a slug no card of the
	 * build carries, which is a query term no row of any partition matches.
	 */
	partitionsOf(slug: string): number[] {
		const mask = this.masks.get(slug);
		if (mask === undefined) return [];
		const out: number[] = [];
		let rest = mask;
		for (let p = 0; p < this.partitionCount && rest > 0; p++) {
			if (rest % 2 === 1) out.push(p);
			rest = Math.floor(rest / 2);
		}
		return out;
	}

	/** Every slug, sorted — for tests and the harness. */
	slugs(): string[] {
		return [...this.masks.keys()];
	}

	/**
	 * Parse a raw blob, checked against the manifest the request is pinned to. Throws on anything
	 * else: a blob this cannot read whole must be refused, never half-used, because a half-read
	 * blob is a tag placed in too few partitions — a page missing rows.
	 */
	static parse(raw: Uint8Array, expect: { partitionCount: number; partitionHash: string }): OracleTagPartitions {
		const text = utf8.decode(raw);
		if (!text.startsWith(ORACLE_TAGS_HEADER)) throw new Error("oracle tags: unknown header");
		if (!text.endsWith("\n")) throw new Error("oracle tags: truncated");
		const lines = text.slice(ORACLE_TAGS_HEADER.length, -1).split("\n");
		const [count, hash, ...extra] = (lines[0] ?? "").split("\t");
		const n = Number(count);
		if (extra.length > 0 || !/^\d+$/.test(count ?? "") || hash === undefined) {
			throw new Error("oracle tags: malformed modulus line");
		}
		if (n !== expect.partitionCount || hash !== expect.partitionHash) {
			throw new Error(
				`oracle tags: built for ${n} partitions by ${hash}, the manifest has ${expect.partitionCount} by ${expect.partitionHash}`,
			);
		}
		if (n < 1 || n > ORACLE_TAGS_MAX_PARTITIONS) throw new Error(`oracle tags: partition count ${n}`);
		const limit = 2 ** n;
		const masks = new Map<string, number>();
		let previous = "";
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i] as string;
			const tab = line.lastIndexOf("\t");
			const slug = tab === -1 ? "" : line.slice(0, tab);
			const hex = tab === -1 ? "" : line.slice(tab + 1);
			const mask = /^[0-9a-f]{1,14}$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
			if (!spellable(slug) || !(mask > 0 && mask < limit) || (i > 1 && !(slug > previous))) {
				throw new Error(`oracle tags: malformed line ${i + 1}`);
			}
			masks.set(slug, mask);
			previous = slug;
		}
		return new OracleTagPartitions(masks, n, hash);
	}
}

/**
 * Publish a build's blob to KV, gzipped, and say what the manifest records. NOT gated on the
 * manifest, like the card-names blob: it goes up before the manifest names it, and a blob for a
 * build that never publishes is a key nobody names, swept with its family.
 */
export async function writeOracleTags(
	kv: KVNamespace,
	formatVersion: number,
	builtAt: string,
	raw: Uint8Array,
): Promise<{ key: string; bytes: number; raw: number }> {
	const stored = await gzipBytes(raw);
	if (stored.byteLength > KV_VALUE_CAP_BYTES) {
		throw new Error(
			`oracle tags blob is ${stored.byteLength} bytes gzipped, over the ${KV_VALUE_CAP_BYTES} KV value cap`,
		);
	}
	const key = oracleTagsKey(formatVersion, builtAt);
	await kv.put(key, stored, { metadata: kvBytesMetadata(stored.byteLength) });
	return { key, bytes: stored.byteLength, raw: raw.byteLength };
}

/** gunzip, through the runtime's own DecompressionStream (workerd and bun both have it). */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const body = new Response(bytes).body;
	if (body === null) return new Uint8Array(0);
	return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

// ── The router isolate's copy ─────────────────────────────────────────────────

/** KV's own colo cache for a read: the key names its build, so a published value never changes. */
const ORACLE_TAGS_CACHE_TTL = 3_600;
/** The colo's Cache API copy: immutable per build, so a day only bounds lingering. */
const ORACLE_TAGS_EDGE_TTL_S = 86_400;

/**
 * How long a request with an `otag:` term may wait for a fresh isolate's load before gathering from
 * every partition. The colo's copy is a same-machine read (the routing filter's measured p50 14ms,
 * p75 57ms for a value 30 times this size); past this the request costs what it always did.
 */
export const ORACLE_TAGS_WAIT_MS = 60;

/** Per isolate, keyed by the blob's KEY (one per build): the parsed blob, or null for a refused one. */
let tagCache: { key: string; tags: OracleTagPartitions | null } | null = null;
let tagLoad: { key: string; done: Promise<OracleTagPartitions | null> } | null = null;

/** Read, gunzip, check and parse `ref`'s blob, or null (refused or absent — logged). Throws on a KV fault. */
async function loadOracleTags(
	env: Env,
	manifest: StoreManifest,
	ref: { key: string; bytes: number },
): Promise<OracleTagPartitions | null> {
	const started = Date.now();
	const stored = await readThroughEdgeCache(edgeCacheUrl(ref.key), ORACLE_TAGS_EDGE_TTL_S, async () => {
		const buf = await env.STORE_KV.get(ref.key, { type: "arrayBuffer", cacheTtl: ORACLE_TAGS_CACHE_TTL });
		return buf === null ? null : new Uint8Array(buf);
	});
	if (stored === null) {
		console.warn(`oracle tags ${ref.key} are not in KV; otag: searches ask every partition on this build`);
		return null;
	}
	if (stored.byteLength !== ref.bytes) {
		console.warn(`oracle tags ${ref.key} are ${stored.byteLength} bytes, the manifest says ${ref.bytes}; refused`);
		return null;
	}
	try {
		const tags = OracleTagPartitions.parse(await gunzip(stored), {
			partitionCount: manifest.partition_count as number,
			partitionHash: manifest.partition_hash as string,
		});
		console.log(`oracle tags loaded: ${ref.key}, ${tags.size} tags, in ${Date.now() - started}ms`);
		return tags;
	} catch (err) {
		console.warn(`oracle tags ${ref.key} refused (${err}); otag: searches ask every partition on this build`);
		return null;
	}
}

/**
 * The oracle-tag partitions of the build `manifest` names, if this isolate has them or can have
 * them within `maxWaitMs` — else null, and the load carries on (under `waitUntil`) for the next
 * request. Never throws: a KV fault costs this request the narrowing, and the next one retries.
 */
export async function oracleTagPartitionsSoon(
	env: Env,
	manifest: StoreManifest,
	waitUntil: (p: Promise<unknown>) => void,
	maxWaitMs: number = ORACLE_TAGS_WAIT_MS,
): Promise<OracleTagPartitions | null> {
	const ref = oracleTagsOf(manifest);
	if (ref === null) return null;
	const cached = tagCache;
	if (cached?.key === ref.key) return cached.tags;
	let load = tagLoad;
	if (load?.key !== ref.key) {
		const started: { key: string; done: Promise<OracleTagPartitions | null> } = {
			key: ref.key,
			done: Promise.resolve(null),
		};
		started.done = (async () => {
			try {
				const tags = await loadOracleTags(env, manifest, ref);
				tagCache = { key: ref.key, tags };
				return tags;
			} catch (err) {
				// A failed read must not pin the isolate to "no blob": the next request reads again.
				console.warn(`oracle tags ${ref.key} could not be read (${err}); this request asks every partition`);
				return null;
			} finally {
				if (tagLoad === started) tagLoad = null;
			}
		})();
		tagLoad = started;
		waitUntil(started.done);
		load = started;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), maxWaitMs);
	});
	try {
		return await Promise.race([load.done, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Test hook: forget the isolate's copy. */
export function forgetOracleTagPartitions(): void {
	tagCache = null;
	tagLoad = null;
}
