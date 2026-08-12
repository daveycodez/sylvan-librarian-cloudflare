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
//   - 25.5MB of a 1GB namespace, next to ~77MB per kept store version.
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

import { encodeKeyedBlob, KeyedBlobError, type KeyedEntry, keyedBlobLookup } from "./keyed-blob";

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
 * Written LAST by the rulings phase, and read only by the publisher — the route never asks for it.
 *
 * It exists so the publisher can tell "KV already holds a full set" from "this namespace was
 * recreated and my hash table is describing values that no longer exist". Its absence forces a
 * full republish.
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
 * ruling id; the bulk file carries no id, and none of the four candidate rules (the file's own
 * order, that reversed, comment ascending, comment descending) matched on any of 10 sampled cards
 * that have a date carrying several rulings. 13,847 of the 19,770 cards with rulings have such a
 * date, so this is most of them — see the README's deviations list.
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
