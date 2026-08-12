// Where the reference data lives: Workers KV, as pre-rendered response bodies.
//
// Upstream (api/scryfall_reference_import.py, PR #922) mirrors three things off api.scryfall.com
// into Postgres — 1,047 sets, twenty catalogs totalling ~62,000 strings, and 84 card symbols — and
// serves `/sets`, `/catalog/:name` and `/symbology` out of those tables. Its reasoning for
// mirroring rather than deriving carries over unchanged and is worth restating, because this port
// has an engine that looks like it could answer some of it: a Set object carries eight fields no
// card carries, `card_count` counts Scryfall's printings rather than this corpus's deliberate
// subset, and a card symbol has no card at all. Deriving would produce numbers no other Scryfall
// client agrees with, on objects whose whole purpose is to be compared against theirs.
//
// What changes here is only WHERE the mirror lives, and the shape follows the rulings one: the
// import renders the JSON, KV holds it, and the isolate splices bytes into an envelope without
// parsing them. Three shapes, because the three routes ask different questions:
//
//   `/sets`               ONE value holding the whole `data` array, ~621KB. That array IS the
//                         response, so there is nothing to index and nothing to skip.
//   `/sets/:code|:id`,    SETS_BUCKET_COUNT keyed blobs (keyed-blob.ts), ~40KB each. Each set's
//   `/sets/tcgplayer/:id` object is stored once and pointed at by all three of its keys, so a
//                         lookup reads one small value instead of the 621KB list.
//   `/catalog/:name`      One value per catalog, holding its `data` array — 20 values, from 9
//                         bytes (battle-types) to 692KB (card-names). Again the array is the
//                         response.
//   `/symbology`          ONE value, ~29KB, same story.
//
// Sizes measured against api.scryfall.com on 2026-08-12. The whole set is ~1.65MB across 38 values
// against a 1GB namespace, and 38 writes on a first publish against the free plan's 1,000/day —
// the publisher hashes each value and rewrites only what moved, so ordinary nights are far fewer.
//
// `/symbology/parse-mana` is not here: it is a pure function of its parameter (src/routes/
// scryfall-compat/mana.ts) and is the one route on this surface that works before any import.

import { encodeKeyedBlob, type KeyedEntry } from "./keyed-blob";

/**
 * Layout version, in every key this module owns. Bump on any change to what the values mean, so a
 * new publisher writes a new namespace rather than over the one a running reader is using.
 *
 * This is the LAYOUT — what the keys are and how a value is arranged. What a value HOLDS rides
 * REFERENCE_CONTENT_GENERATION instead, and the two are separate for the reason the store's
 * `format_version` and `content_generation` are: a layout change has to mint a new key namespace so
 * a running reader keeps reading keys it understands, while a content change must overwrite in
 * place rather than orphan 39 values nothing prunes.
 *
 * v2 minted new keys for a change that was really the second kind — the values went from a
 * re-serialization to Scryfall's own bytes — which is what made the distinction worth having.
 */
export const REFERENCE_FORMAT_VERSION = 2;

/**
 * What the values HOLD. Bump when the same layout renders different bytes.
 *
 * Generation 2 is Scryfall's raw bytes rather than a re-serialization: JavaScript cannot re-emit
 * `"mana_value":0.0`, so a parsed-and-restringified mirror was one byte short of the API it
 * mirrors. `--if-missing` compares this as well as the layout version, so a deploy republishes
 * instead of skipping over data it would now render differently.
 */
export const REFERENCE_CONTENT_GENERATION = 2;

/**
 * Buckets the single-set lookups are spread over.
 *
 * 1,047 sets carrying three keys each is ~1MB of index-plus-payload, and reading all of it to
 * answer `/sets/mh3` would put the list route's cost on the lookup route. 16 buckets is ~40KB a
 * read; more buckets would not help (a bucket is already one small read) and would cost writes.
 */
export const SETS_BUCKET_COUNT = 16;

/** Written last by the publisher, and read only by it — see the rulings meta key for why. */
export const REFERENCE_META_KEY = "reference:meta";

/** What the publisher records about the reference data it last wrote. */
export interface ReferenceMeta {
	format_version: number;
	/** See REFERENCE_CONTENT_GENERATION. Absent on sets published before it existed. */
	content_generation?: number;
	bucket_count: number;
	/** Epoch seconds. */
	built_at: string;
	set_count: number;
	symbol_count: number;
	/** Catalog name → how many values it holds. */
	catalogs: Record<string, number>;
}

/**
 * The twenty catalogs Scryfall documents, upstream's `CATALOG_NAMES` verbatim.
 *
 * Listed rather than discovered, which is upstream's call and worth keeping: a name this instance
 * has never imported 404s as an unknown catalog instead of answering an empty one, so a client
 * cannot conclude from a 200 that Magic has no creature types.
 */
export const CATALOG_NAMES = [
	"card-names",
	"artist-names",
	"word-bank",
	"supertypes",
	"card-types",
	"artifact-types",
	"battle-types",
	"creature-types",
	"enchantment-types",
	"land-types",
	"planeswalker-types",
	"spell-types",
	"powers",
	"toughnesses",
	"loyalties",
	"watermarks",
	"keyword-abilities",
	"keyword-actions",
	"ability-words",
	"flavor-words",
] as const;

export type CatalogName = (typeof CATALOG_NAMES)[number];

const CATALOG_NAME_SET: ReadonlySet<string> = new Set(CATALOG_NAMES);

/** Whether a path segment names a catalog this surface serves. */
export function isCatalogName(name: string): name is CatalogName {
	return CATALOG_NAME_SET.has(name);
}

/** Every key this dataset has ever owned, across layout versions. */
export const REFERENCE_KEY_PREFIX = "reference:v";

/** The prefix the CURRENT layout writes under; anything else under REFERENCE_KEY_PREFIX is stale. */
export function referenceCurrentPrefix(): string {
	return `reference:v${REFERENCE_FORMAT_VERSION}:`;
}

/** The `data` array for `GET /sets`, rendered whole. */
export function setsListKey(): string {
	return `reference:v${REFERENCE_FORMAT_VERSION}:sets:list`;
}

/** One bucket of the by-key set index. */
export function setsBucketKey(bucket: number): string {
	return `reference:v${REFERENCE_FORMAT_VERSION}:sets:${bucket.toString(16).padStart(2, "0")}`;
}

/** The `data` array for one catalog. */
export function catalogKey(name: string): string {
	return `reference:v${REFERENCE_FORMAT_VERSION}:catalog:${name}`;
}

/** The `data` array for `GET /symbology`. */
export function symbologyKey(): string {
	return `reference:v${REFERENCE_FORMAT_VERSION}:symbology`;
}

/**
 * Index keys are 48 bytes wide: a Scryfall set id is 36 characters, `tcgplayer:` plus a group id is
 * ~16, and a set code is a handful. 48 leaves room for all three without truncating any.
 */
const SET_KEY_WIDTH = 48;

/**
 * The three ways a set can be addressed, folded to the exact strings the index stores.
 *
 * Lowercased because the routes fold their path segment the same way — upstream matches on
 * `lower(code)` and `id::text`, so `/sets/MH3` and `/sets/mh3` are one set, and a client that
 * upper-cased a code while building a URL still finds it.
 */
export function setLookupKeys(set: { id?: unknown; code?: unknown; tcgplayer_id?: unknown }): string[] {
	const keys: string[] = [];
	if (typeof set.code === "string" && set.code) keys.push(`code:${set.code.toLowerCase()}`);
	if (typeof set.id === "string" && set.id) keys.push(`id:${set.id.toLowerCase()}`);
	if (typeof set.tcgplayer_id === "number" && Number.isFinite(set.tcgplayer_id)) {
		keys.push(`tcgplayer:${set.tcgplayer_id}`);
	}
	return keys;
}

/** The key a `/sets/:code` or `/sets/:id` path segment looks up under. */
export function setCodeOrIdKey(identifier: string): string {
	const folded = identifier.trim().toLowerCase();
	// A set code is never shaped like a UUID, so both spellings can be tried without ambiguity —
	// upstream asks the same question in one SQL statement with an OR.
	return folded.includes("-") && folded.length >= 32 ? `id:${folded}` : `code:${folded}`;
}

/** The key a `/sets/tcgplayer/:id` path segment looks up under, or null when it is not an id. */
export function setTcgplayerKey(rawId: string): string | null {
	const trimmed = rawId.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	// Parsed and re-rendered so `007` and `7` are one key, as `int(raw_id)` makes them upstream.
	return `tcgplayer:${Number.parseInt(trimmed, 10)}`;
}

/** Which bucket a set key lives in. */
export function setsBucketOf(key: string): number {
	// FNV-1a over the key rather than its first character: the three key kinds have wildly
	// different alphabets (hex uuids, alphanumeric codes, `tcgplayer:` digits), so a prefix split
	// would pile most of them into a few buckets. A hash spreads them evenly and, being a pure
	// function of the key, keeps a set's bucket stable across imports.
	let hash = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % SETS_BUCKET_COUNT;
}

/**
 * The raw JSON text of each element of a response's `data` array.
 *
 * The mirrored routes serve what api.scryfall.com sent, and "what it sent" includes how it wrote
 * the numbers: a symbol's `mana_value` is DECIMAL there, so `0` arrives as `0.0`. Re-serializing
 * through `JSON.parse` and `JSON.stringify` silently drops that — JavaScript has one number type
 * and cannot write `0.0` — and it would also drop any field Scryfall adds that this port does not
 * know to keep. Copying the bytes keeps both.
 *
 * A scanner rather than a regex: elements are objects containing braces, brackets and escaped
 * quotes, and only depth tracking with string awareness finds their boundaries.
 */
export function rawArrayElements(responseText: string, arrayKey = "data"): string[] {
	const keyAt = responseText.indexOf(`"${arrayKey}"`);
	if (keyAt < 0) return [];
	const open = responseText.indexOf("[", keyAt);
	if (open < 0) return [];

	const elements: string[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let start = -1;
	for (let i = open; i < responseText.length; i++) {
		const c = responseText[i] as string;
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			if (depth === 1 && start < 0) start = i; // a bare string element, e.g. a catalog value
			continue;
		}
		if (c === "[" || c === "{") {
			depth += 1;
			if (depth === 2 && start < 0) start = i;
			continue;
		}
		if (c === "]" || c === "}") {
			depth -= 1;
			if (depth === 1 && start >= 0) {
				elements.push(responseText.slice(start, i + 1));
				start = -1;
			}
			if (depth === 0) break; // the array closed
			continue;
		}
		if (depth === 1 && c === "," && start >= 0) {
			elements.push(responseText.slice(start, i).trim());
			start = -1;
			continue;
		}
		if (depth === 1 && start < 0 && !/[\s,]/.test(c)) start = i; // a number or literal element
	}
	return elements;
}

/**
 * Render the reference values from what api.scryfall.com answered.
 *
 * Pure: the caller does the fetching and the writing, so the same rendering runs in the nightly
 * import (inside a Durable Object) and in the seeding script (inside bun), and neither can drift
 * from the other.
 */
export function renderSets(
	sets: Record<string, unknown>[],
	raw: string[],
): {
	list: string;
	buckets: Uint8Array[];
	setCount: number;
} {
	// Upstream keeps only entries carrying both an id and a code, and stores them in the order
	// Scryfall returned — which is `released_at` descending with same-day sets in an order nothing
	// in the object reproduces, so the sequence itself is the data.
	// Paired by index with the raw text, so each set is stored exactly as Scryfall wrote it.
	const usable = sets
		.map((entry, at) => ({ entry, json: raw[at] ?? JSON.stringify(entry) }))
		.filter(({ entry }) => typeof entry.id === "string" && entry.id && typeof entry.code === "string" && entry.code);
	// A TCGplayer group id is NOT unique across sets, which the live data is the only way to learn:
	// on 2026-08-12, six ids were shared by two or more sets, one of them (62) by all twenty-one
	// Judge Gift Cards sets. So a key can be claimed twice, and the first set in Scryfall's own
	// order takes it — deterministic, and the closest thing to a rule available.
	//
	// WHICH ONE SCRYFALL PICKS IS NOT DERIVABLE. Measured: id 62 answers `g03`, which is neither
	// the first nor the last of its twenty-one claimants in any ordering the object carries
	// (position, release date, code); id 33 answers `dd1`, the later of its two by position;
	// id 2570 answers `cmb2`, the earlier. That is Scryfall's internal set ordering, and the /sets
	// payload does not contain it. Upstream has the same gap from the other side — its lookup is a
	// `LIMIT 1` with no ORDER BY, so it returns whichever row Postgres reaches first. Recorded in
	// the README's deviations list.
	const claimed = new Set<string>();
	const perBucket: KeyedEntry[][] = Array.from({ length: SETS_BUCKET_COUNT }, () => []);
	for (const { entry: set, json } of usable) {
		for (const key of setLookupKeys(set)) {
			if (claimed.has(key)) continue;
			claimed.add(key);
			perBucket[setsBucketOf(key)]?.push({ key, json });
		}
	}
	return {
		list: `[${usable.map(({ json }) => json).join(",")}]`,
		buckets: perBucket.map((entries) => encodeKeyedBlob(entries, SET_KEY_WIDTH)),
		setCount: usable.length,
	};
}

/** The `data` array for one catalog, from the strings Scryfall answered with. */
export function renderCatalog(values: unknown[], raw?: string[]): { json: string; count: number } {
	const strings = values.filter((value): value is string => typeof value === "string");
	// Catalogs are arrays of strings, so re-serializing is lossless — but the raw text is used when
	// it is available, so all three mirrors answer with the bytes Scryfall sent.
	const json = raw && raw.length === strings.length ? `[${raw.join(",")}]` : JSON.stringify(strings);
	return { json, count: strings.length };
}

// ── the counted-array value ──────────────────────────────────────────────────
//
// A Catalog object carries `total_values`, and the route must not have to parse a 692KB array to
// learn a number the publisher already knew. So a catalog's value is its count and then its JSON:
//
//   0..4   "SLCA"
//   4..6   format version, 2 hex digits
//   6..14  value count, 8 hex digits
//   14     "\n"
//   15..   the `data` array, `["a","b"]`
//
// ASCII throughout, for the reason keyed-blob.ts spells out. The sets list and the symbology list
// need no such header — a List object has no count key — so they are stored as the bare array.

const COUNTED_MAGIC = "SLCA";
const COUNTED_HEADER_BYTES = 15;

/** Thrown when a counted-array value is not one. */
export class CountedArrayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CountedArrayError";
	}
}

/** Pack a rendered array and its count into one value. */
export function encodeCountedArray(json: string, count: number): string {
	return `${COUNTED_MAGIC}${REFERENCE_FORMAT_VERSION.toString(16).padStart(2, "0")}${count
		.toString(16)
		.padStart(8, "0")}\n${json}`;
}

/** Read one back: the count from the header, the array as bytes to splice. */
export function readCountedArray(value: Uint8Array): { count: number; data: Uint8Array } {
	if (value.length < COUNTED_HEADER_BYTES) {
		throw new CountedArrayError(`value is ${value.length} bytes, shorter than its header`);
	}
	for (let i = 0; i < COUNTED_MAGIC.length; i++) {
		if (value[i] !== COUNTED_MAGIC.charCodeAt(i)) {
			throw new CountedArrayError("value does not start with the format magic");
		}
	}
	let count = 0;
	for (let i = 6; i < 14; i++) {
		const code = value[i] as number;
		let digit: number;
		if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
		else if (code >= 0x61 && code <= 0x66) digit = code - 0x61 + 10;
		else throw new CountedArrayError("header does not carry a readable count");
		count = count * 16 + digit;
	}
	return { count, data: value.subarray(COUNTED_HEADER_BYTES) };
}

/** The `data` array for `/symbology`, from what Scryfall answered with. */
export function renderSymbology(symbols: Record<string, unknown>[], raw: string[]): { json: string; count: number } {
	// Upstream keeps the entries that carry a symbol, in Scryfall's order; the bytes are Scryfall's
	// own, which is what keeps `"mana_value":0.0` a decimal.
	const usable = symbols
		.map((entry, at) => ({ entry, json: raw[at] ?? JSON.stringify(entry) }))
		.filter(({ entry }) => typeof entry.symbol === "string" && entry.symbol);
	return { json: `[${usable.map(({ json }) => json).join(",")}]`, count: usable.length };
}
