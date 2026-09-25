// Where rulings live: Workers KV, as 256 buckets of pre-rendered Ruling objects keyed by the
// first byte of the card's oracle id.
//
// Upstream (api/rulings_import.py, PR #912) loads the rulings bulk file into `magic.rulings` and
// answers `/cards/:id/rulings` with `SELECT ... WHERE oracle_id = %s ORDER BY published_at,
// comment`. There is no Postgres here, and rulings do not belong in the card store either: they
// hang off `oracle_id` rather than off a printing, nothing but this one route reads them, and
// putting 26MB of them in the search archive or the residue would cost every `/search` and every
// `/cards/*` load — for a route that is a rounding error of the traffic.
//
// So they get their own KV shape, read by the REQUEST ISOLATE rather than by the engine Durable
// Object. That is the opposite of every other `/cards/*` route (card objects are assembled in the
// DO, which meters against 30s where the isolate meters against 10ms), and it is deliberate: a
// rulings answer needs no card assembly at all, just the right bytes out of one KV value.
//
// THE ISOLATE NEVER PARSES THE BUCKET. A value is a fixed-width index over pre-rendered JSON: the
// route binary-searches the oracle ids, slices one payload range out, and splices it into the List
// envelope as bytes. Reading one card's rulings therefore touches ~1.5KB of index probes and one
// substring of payload, not the ~104KB the value holds — the same "count the passes over the
// payload" reasoning that put card assembly in the DO, applied to a route that can avoid the
// passes entirely instead. Measured over 5,000 lookups on the real corpus: 1.07us each.
//
// Sizing, measured against the 2026-08-11 rulings dump (77,998 entries, 19,770 distinct oracle
// ids, 25.7MB of JSONL; 77,961 rulings after the file's own repeats are dropped):
//
//   - 256 buckets, split on the first byte of the oracle id. Ids are UUIDv4, so the split is
//     uniform: mean 104,428 bytes per bucket, max 164,710, min 63,523. One bucket is one KV read,
//     so the bucket count sets what a rulings request transfers; 256 keeps that at ~104KB.
//   - 256 KV writes if every bucket changed, against the free plan's 1,000/day. It does not:
//     the publisher hashes each bucket and writes only the ones whose bytes moved (see
//     `stepRulings`), so a normal night is a handful and a set release is tens.
//   - 25.5MB of a 1GB namespace, next to ~165MB (compressed, all partitions) per kept store version.
//
// NOT COMPRESSED, unlike the store chunks. Those are streamed into wasm whole, so compression buys
// both transfer and peak memory; a bucket is read to slice ~1KB out of it, and gzip would put a
// full decode pass back on the isolate's 10ms budget to save transfer inside Cloudflare's own
// network.
//
// Buckets are written to STABLE keys, overwritten in place each import, where store chunks are
// keyed per build. Nothing here spans buckets — a bucket is self-consistent on its own, and no
// reader holds two — so there is no torn-read window to version away, and stable keys mean no
// retention sweep and no second set of 256 deletes a day. The format version is in the key
// (`rulings:v1:*`), so a layout change publishes alongside the old one rather than over it.
//
// Stable keys are also why the READER cannot simply put a bucket in the colo's cache for hours:
// the key says nothing about which night's bytes it holds. The route's read therefore names each
// cached copy by the PUBLISH VERSION `rulings:meta` records, which every publish rewrites after its
// last bucket — see `readRulingsBucket` for the version, the settle window and the bound.

import { edgeCacheUrl, matchEdgeCache, putEdgeCache } from "./edge-cache";
import { encodeKeyedBlob, KeyedBlobError, type KeyedEntry, keyedBlobLookup } from "./keyed-blob";
import { readKvBytesMemo } from "./kv-memo";

/**
 * Bucket layout version, in the key. Bump on any layout change: readers of the previous version
 * keep reading the previous keys, which are still there until the publisher stops writing them.
 *
 * v2 moved the layout itself into keyed-blob.ts, shared with the reference data. Same idea, one
 * implementation of the binary search rather than two that can drift.
 *
 * Distinct from the CONTAINER version inside the blob's own header: this one says what the keys
 * and payloads mean, that one says how the bytes are arranged. A change to either is a new key
 * namespace here, which is why this is the number in the key.
 */
export const RULINGS_FORMAT_VERSION = 2;

/**
 * What the buckets HOLD, against RULINGS_FORMAT_VERSION's how they are arranged.
 *
 * Two numbers because they answer different questions, exactly as the store's `format_version` and
 * `content_generation` do. A LAYOUT change mints a new key namespace, so a running reader keeps
 * reading the keys it understands while the new ones land. A CONTENT change — the same keys
 * rendered differently, say a field whose formatting was wrong — must overwrite in place, and all
 * it needs is for the publisher to notice it is stale.
 *
 * Bump this when the bytes change for the same layout. `--if-missing` compares both, so a deploy
 * republishes rather than skipping over data it would render differently.
 */
export const RULINGS_CONTENT_GENERATION = 1;

/** Buckets in the set; see the sizing note above. Must divide the first byte's 256 values evenly. */
export const RULINGS_BUCKET_COUNT = 256;

/**
 * Written LAST by the rulings phase.
 *
 * It exists so the publisher can tell "KV already holds a full set" from "this namespace was
 * recreated and my hash table is describing values that no longer exist". Its absence forces a
 * full republish.
 *
 * The route reads it too, but only as a VERSION (see `readRulingsBucket`): once a colo an hour,
 * never per request, to learn whether the buckets it holds in its cache are still the published
 * ones. Being written last is what makes it usable for that — a new meta means every bucket of
 * the set it describes has already been put.
 */
export const RULINGS_META_KEY = "rulings:meta";

/** What the publisher records about the set it last wrote. */
export interface RulingsMeta {
	format_version: number;
	/** See RULINGS_CONTENT_GENERATION. Absent on sets published before it existed. */
	content_generation?: number;
	bucket_count: number;
	/** Epoch seconds, matching the store manifest's `built_at`. */
	built_at: string;
	/** Rulings across all buckets, after dropping duplicates. */
	ruling_count: number;
}

/** One row of the rulings bulk file, after upstream's `_valid_rulings` filter. */
export interface RulingRow {
	oracle_id: string;
	source: string;
	published_at: string;
	comment: string;
}

// A bucket is a keyed blob (see keyed-blob.ts) whose keys are oracle ids with their dashes taken
// out, and whose payloads are each card's `data` array. Everything about the layout — why it is
// ASCII, how the index is searched — lives there, because the reference data uses the same one.

/** Index key width: a Scryfall UUID with its dashes taken out. */
const ID_HEX_BYTES = 32;

/** Every key this dataset has ever owned, across layout versions. */
export const RULINGS_KEY_PREFIX = "rulings:v";

/** The prefix the CURRENT layout writes under; anything else under RULINGS_KEY_PREFIX is stale. */
export function rulingsCurrentPrefix(): string {
	return `rulings:v${RULINGS_FORMAT_VERSION}:`;
}

/** The KV key one bucket lives at. */
export function rulingsBucketKey(bucket: number): string {
	return `rulings:v${RULINGS_FORMAT_VERSION}:${bucket.toString(16).padStart(2, "0")}`;
}

/** 32 hex digits once the dashes are out; anything else is not an id this format can key. */
const HEX_32 = /^[0-9a-fA-F]{32}$/;

/**
 * A Scryfall UUID as the 32 lowercase hex digits the index keys on, or null when it is not one.
 *
 * Lowercased because Scryfall's ids are, and a client that upper-cased one while building a URL
 * must still find its card's rulings.
 */
export function uuidHex(uuid: string): string | null {
	const hex = uuid.replaceAll("-", "");
	return HEX_32.test(hex) ? hex.toLowerCase() : null;
}

/** Which bucket an oracle id's rulings live in, or null when it is not a UUID. */
export function rulingsBucketOf(oracleId: string): number | null {
	const hex = uuidHex(oracleId);
	if (hex === null) return null;
	const firstByte = Number.parseInt(hex.slice(0, 2), 16);
	return Math.floor((firstByte * RULINGS_BUCKET_COUNT) / 256);
}

/**
 * Thrown when a bucket's bytes are not a bucket. Never a miss — a miss is `null`.
 *
 * Its own type rather than KeyedBlobError so the route can keep answering "the rulings store could
 * not be read" for a bad bucket while a bug in the caller (an over-long key, say) still surfaces as
 * itself.
 */
export class RulingsFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RulingsFormatError";
	}
}

/**
 * The `data` array for one oracle id, as the JSON bytes to splice into a List envelope — or null
 * when this bucket carries no rulings for it, which is a 200 with `data: []`, not a miss.
 *
 * `bucket` is the whole KV value. Nothing in it is decoded except the index entries the binary
 * search touches (see keyed-blob.ts).
 */
export function rulingsSlice(bucket: Uint8Array, oracleId: string): Uint8Array | null {
	const hex = uuidHex(oracleId);
	if (hex === null) return null;
	try {
		return keyedBlobLookup(bucket, hex);
	} catch (err) {
		if (err instanceof KeyedBlobError) throw new RulingsFormatError(`rulings bucket: ${err.message}`);
		throw err;
	}
}

// ── Reading a bucket: the colo cache, named by the publish version ──────────────────────────────
//
// A bucket read used to be a metered KV `get` on every miss of the isolate's memo, and the memo
// barely hits: 256 buckets, 8 entries shared with the reference data, ~32k cold isolates a day.
// That was ~27k of DeckGen's KV reads a day for ~28k rulings requests. The colo's Cache API is
// unmetered and shared by every isolate in the colo, but a bucket key is rewritten IN PLACE, so a
// copy cached under it would keep serving last night's rulings for as long as it lived.
//
// So a cached copy is named `<bucket key>@<publish version>`, and the version is `rulings:meta`'s
// identity. The meta is the right source because it is the LAST thing every publish writes (the
// nightly phase after its final slice; the deploy seed as the last entry of one bulk put, which the
// settle window below covers): a colo that reads a new meta is reading about buckets already in KV. The store manifest is not a usable
// source even though every request is pinned to one — it is published BEFORE the rulings phase
// runs, so a version taken from it would name the previous night's bytes as the new build's for
// the minutes-to-hours the phase takes, and keep them for as long as the copy lived.
//
// Learning the meta costs one metered read per colo per RULINGS_VERSION_CHECK_S, not per request:
// the colo keeps a small record of the version it last saw (`RULINGS_SEEN_URL`) and each isolate
// trusts it for RULINGS_VERSION_MEMO_MS.
//
// STALENESS, precisely. A publish writes its meta at W. A colo's last read that can still return
// the previous meta is KV's propagation (~60 s at the minimum cacheTtl used here) after W; its next
// check is at most RULINGS_VERSION_CHECK_S later, and an isolate may trust the previous answer for
// RULINGS_VERSION_MEMO_MS more — W + 60 + 3,600 + 60 s = 62 minutes, the first request after which
// reads the new bytes. That is today's bound term for term: the bucket read it replaces carried
// KV's cacheTtl of 3,600 s (a read at W + 60 s kept the old bytes until W + 3,660 s) plus the same
// 60 s memo. What changes is that nothing a colo caches can outlive a publish it has seen.
//
// THE SETTLE WINDOW. KV is eventually consistent: a bucket read soon after it was rewritten can
// still return the old bytes (propagation plus the read's own 60 s cacheTtl, ~120 s). A colo that
// sees a new version immediately could therefore cache the OLD bytes under the NEW name, for a day.
// Fills within RULINGS_SETTLE_S of the colo first seeing a version are kept for 60 s only, and the
// colo record carries `since` across its hourly checks precisely so this is decided per colo, not
// per cold isolate. The cost is a KV read per bucket per minute for five minutes after a publish,
// and only for buckets that are asked for in those minutes.
//
// ONE CASE KEEPS A COPY LONGER THAN TODAY: a rulings phase that gives up part-way (see
// RULINGS_MAX_ATTEMPTS in the coordinator) has rewritten some buckets without rewriting the meta,
// so the version does not move and a colo may serve its copy of the previous bytes for up to
// RULINGS_EDGE_TTL_S — the "previous rulings stay served" that night already accepts, for a day
// instead of an hour.
//
// No usable meta — none published, a layout this reader does not key, an unreadable value, or a
// failed read — means the read is exactly today's: KV through the isolate memo, no colo copy.

/** How often a colo re-reads `rulings:meta` to learn of a new publish, seconds. */
export const RULINGS_VERSION_CHECK_S = 3_600;
/** How long an isolate trusts the colo's record of the version, ms. */
export const RULINGS_VERSION_MEMO_MS = 60_000;
/** How long after a colo first sees a version its bucket fills are kept only briefly, seconds. */
export const RULINGS_SETTLE_S = 300;
/** A settled bucket copy's life in the colo cache, seconds. Versions move nightly; longer buys nothing. */
export const RULINGS_EDGE_TTL_S = 86_400;
/** A bucket copy filled inside the settle window, seconds. */
export const RULINGS_UNSETTLED_EDGE_TTL_S = 60;
/** KV's own cacheTtl on the versioned path's reads: its minimum, since the colo cache is what saves the reads. */
const RULINGS_KV_CACHE_TTL_S = 60;
/** The colo record outlives its hourly checks so that `since` survives them. */
const RULINGS_SEEN_TTL_S = 7 * 86_400;
/** The colo's record of the version it last saw, when, and since when. Never a KV key. */
export const RULINGS_SEEN_URL = edgeCacheUrl(`${RULINGS_META_KEY}#seen`);

/**
 * The publish version a meta names, or null when it does not describe the buckets this reader
 * reads (another layout or bucket count) or cannot tell one publish from another.
 *
 * `built_at` is what moves: the nightly records its build's, the deploy seed its own clock. The
 * content generation and the ruling count ride along so a republish that somehow kept `built_at`
 * but changed what it wrote still reads as new.
 */
export function rulingsPublishVersion(meta: unknown): string | null {
	if (typeof meta !== "object" || meta === null) return null;
	const m = meta as Partial<RulingsMeta>;
	if (m.format_version !== RULINGS_FORMAT_VERSION || m.bucket_count !== RULINGS_BUCKET_COUNT) return null;
	if (typeof m.built_at !== "string" || m.built_at === "") return null;
	if (typeof m.ruling_count !== "number") return null;
	return `g${m.content_generation ?? 0}-${m.built_at}-${m.ruling_count}`;
}

/** What the colo remembers about the meta; epoch ms throughout. */
interface RulingsSeen {
	/** null = no usable meta: read as before. */
	version: string | null;
	/** When this colo first saw `version`. */
	since: number;
	/** When this colo last asked KV. */
	checked: number;
}

function parseSeen(bytes: Uint8Array | null): RulingsSeen | null {
	if (bytes === null) return null;
	try {
		const seen = JSON.parse(new TextDecoder().decode(bytes)) as RulingsSeen;
		const ok =
			(seen.version === null || typeof seen.version === "string") &&
			Number.isFinite(seen.since) &&
			Number.isFinite(seen.checked);
		return ok ? seen : null;
	} catch {
		return null;
	}
}

const seenMemo = new WeakMap<KVNamespace, { at: number; seen: RulingsSeen }>();

/** Test hook: forget this isolate's copy of the colo record. */
export function forgetRulingsVersion(kv: KVNamespace): void {
	seenMemo.delete(kv);
}

/**
 * The published rulings set's version and when this colo first saw it — or null for "no usable
 * meta, read as before". Never throws: a failed meta read is null for this request, not memoized.
 */
export async function currentRulingsVersion(
	kv: KVNamespace,
	defer?: (p: Promise<unknown>) => void,
): Promise<{ version: string; since: number } | null> {
	const now = Date.now();
	const memo = seenMemo.get(kv);
	let seen = memo && now - memo.at < RULINGS_VERSION_MEMO_MS ? memo.seen : null;
	if (seen === null) {
		seen = await seenByColo(kv, now, defer);
		if (seen === null) return null;
		seenMemo.set(kv, { at: now, seen });
	}
	return seen.version === null ? null : { version: seen.version, since: seen.since };
}

/** The colo's record while fresh, else a new one from KV — null only when the KV read failed. */
async function seenByColo(
	kv: KVNamespace,
	now: number,
	defer?: (p: Promise<unknown>) => void,
): Promise<RulingsSeen | null> {
	const colo = parseSeen(await matchEdgeCache(RULINGS_SEEN_URL));
	if (colo !== null && now - colo.checked < RULINGS_VERSION_CHECK_S * 1000) return colo;
	let text: string | null;
	try {
		text = await kv.get(RULINGS_META_KEY, { type: "text", cacheTtl: RULINGS_KV_CACHE_TTL_S });
	} catch (err) {
		console.warn(`Rulings: ${RULINGS_META_KEY} read failed; reading the bucket as before: ${err}`);
		return null;
	}
	let meta: unknown = null;
	if (text !== null) {
		try {
			meta = JSON.parse(text);
		} catch {
			meta = null;
		}
	}
	const version = rulingsPublishVersion(meta);
	if (text !== null && version === null) {
		console.warn(`Rulings: ${RULINGS_META_KEY} names no version this reader keys; reading buckets as before`);
	}
	// `since` survives a check that finds the same version — that is what the long-lived record is for.
	const seen = { version, since: colo !== null && colo.version === version ? colo.since : now, checked: now };
	await putEdgeCache(RULINGS_SEEN_URL, new TextEncoder().encode(JSON.stringify(seen)), RULINGS_SEEN_TTL_S, defer);
	return seen;
}

/**
 * One bucket's bytes, or null when KV holds none — from the colo's copy of the current publish
 * when there is one. Throws when KV cannot be read, exactly as the plain read did.
 */
export async function readRulingsBucket(
	kv: KVNamespace,
	bucket: number,
	defer?: (p: Promise<unknown>) => void,
): Promise<Uint8Array | null> {
	const key = rulingsBucketKey(bucket);
	const published = await currentRulingsVersion(kv, defer);
	if (published === null) return readKvBytesMemo(kv, key);
	const settled = Date.now() - published.since >= RULINGS_SETTLE_S * 1000;
	return readKvBytesMemo(kv, key, {
		edgeKey: `${key}@${published.version}`,
		edgeTtl: settled ? RULINGS_EDGE_TTL_S : RULINGS_UNSETTLED_EDGE_TTL_S,
		cacheTtl: RULINGS_KV_CACHE_TTL_S,
		defer,
	});
}

/**
 * Scryfall publishes `published_at` as a bare date; upstream slices rather than parses so a future
 * timestamp form cannot fail its `::date` cast, and the same slice keeps the string a date here.
 */
const DATE_LENGTH = 10;

/**
 * One line of the rulings dump as a row, or null when it is not usable.
 *
 * Upstream's `_valid_rulings`: an entry needs all four fields, non-empty. A comment-less or
 * source-less entry is dropped rather than served with a hole in it.
 */
export function parseRulingLine(line: string): RulingRow | null {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof entry !== "object" || entry === null) return null;
	const { oracle_id, source, published_at, comment } = entry as Record<string, unknown>;
	if (typeof oracle_id !== "string" || !oracle_id) return null;
	if (typeof source !== "string" || !source) return null;
	if (typeof comment !== "string" || !comment) return null;
	if (published_at === null || published_at === undefined || published_at === "") return null;
	return { oracle_id, source, published_at: String(published_at).slice(0, DATE_LENGTH), comment };
}

/**
 * One Ruling object, in upstream `ruling_object`'s key order.
 *
 * Rendered here rather than passed through from the bulk file, even though the file's lines
 * currently carry exactly these five keys in exactly this order. Upstream builds the object from
 * four selected columns, so a key Scryfall adds to the dump tomorrow is a key upstream does not
 * answer with — and passing the line through verbatim would make this port answer with it.
 */
function rulingObject(row: RulingRow): string {
	return JSON.stringify({
		object: "ruling",
		oracle_id: row.oracle_id,
		source: row.source,
		published_at: row.published_at,
		comment: row.comment,
	});
}

/**
 * Encode one bucket from the rulings that belong in it.
 *
 * Exact duplicates are dropped — the bulk file repeats a tuple often enough to matter (37 of 77,998
 * on 2026-08-11), and upstream drops them on its unique index rather than serving a ruling twice.
 *
 * ORDER IS `published_at` DESCENDING, `comment` ascending — NEWEST FIRST, which is Scryfall's own
 * order and NOT upstream's `ORDER BY published_at, comment`. Measured against api.scryfall.com on
 * 2026-08-12: of 16 sampled cards whose rulings span more than one date, 16 came back
 * newest-date-first and 0 oldest-first. Upstream has it backwards, so a client that swapped its
 * base URL would see every multi-date card's rulings inverted; this surface exists to make that
 * swap invisible, so it follows Scryfall where the two disagree. Reported upstream.
 *
 * WITHIN one date the order cannot be reproduced at all, and `comment` is a deterministic
 * stand-in rather than a guess at Scryfall's. Scryfall orders same-date rulings by an internal
 * ruling id and the bulk file carries no id. Re-measured 2026-08-16 over 25 cards with both
 * several dates and a date carrying 4+ rulings, against api.scryfall.com: the file's own order
 * within a date matched 0 of 25, as did that order reversed, whole-file order,
 * date-ascending-then-file, and the rule below.
 *
 * PRESERVING THE DUMP'S ORDER IS NOT THE ANSWER, and the reason is worth keeping so it is not
 * retried: the six boilerplate "kicker" rulings come back in a DIFFERENT order on different cards
 * (Strength of Night, Goblin Barrage and Spell Contortion each get their own permutation of the
 * same six comments), so Scryfall orders by a per-(card, ruling) row id rather than a per-ruling
 * one, and the dump — one line per pair, grouped by card — does not carry that within a card.
 *
 * 13,847 of the 19,770 cards with rulings have a crowded date, so this is most of them — see the
 * README's deviations list.
 *
 * Determinism matters beyond tidiness: the bytes are a pure function of the ruling SET, so a dump
 * that reorders its lines without changing content produces identical buckets, which is what lets
 * the publisher skip writing them.
 */
export function encodeRulingsBucket(rows: Iterable<RulingRow>): { bytes: Uint8Array; rulingCount: number } {
	const byOracle = new Map<string, RulingRow[]>();
	for (const row of rows) {
		const group = byOracle.get(row.oracle_id);
		if (group) group.push(row);
		else byOracle.set(row.oracle_id, [row]);
	}

	const entries: KeyedEntry[] = [];
	let rulingCount = 0;
	for (const [id, group] of byOracle) {
		const hex = uuidHex(id);
		// An oracle id that is not a UUID cannot be addressed by any route here, so it has no
		// bucket to live in and is dropped rather than given an arbitrary one.
		if (hex === null) continue;
		const sorted = group
			.slice()
			.sort((a, b) =>
				a.published_at > b.published_at
					? -1
					: a.published_at < b.published_at
						? 1
						: a.comment < b.comment
							? -1
							: a.comment > b.comment
								? 1
								: 0,
			);
		const rendered: string[] = [];
		let previous = "";
		for (const row of sorted) {
			const object = rulingObject(row);
			if (object === previous) continue; // the file's own repeats, in sort order and adjacent
			previous = object;
			rendered.push(object);
		}
		rulingCount += rendered.length;
		entries.push({ key: hex, json: `[${rendered.join(",")}]` });
	}
	return { bytes: encodeKeyedBlob(entries, ID_HEX_BYTES), rulingCount };
}
