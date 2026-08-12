// The rulings bucket format: what the import writes and what a request isolate slices out of it.
//
// The route never parses a bucket — it binary-searches an index and copies one byte range into the
// response — so a writer and reader that disagree by one byte do not fail loudly, they serve one
// card's rulings under another card's id. These pin the round trip, the ordering upstream's SQL
// guarantees (ORDER BY published_at, comment), and every way a bucket can be unreadable.

import { describe, expect, test } from "bun:test";
import {
	encodeRulingsBucket,
	parseRulingLine,
	RULINGS_BUCKET_COUNT,
	type RulingRow,
	RulingsFormatError,
	rulingsBucketKey,
	rulingsBucketOf,
	rulingsSlice,
	uuidHex,
} from "../../src/engine/rulings-kv";

const decoder = new TextDecoder();

/** A UUID in `bucket`, distinguished by `n` — the shape the index has to sort and search. */
function uuidIn(bucket: number, n: number): string {
	const tail = n.toString(16).padStart(6, "0");
	return `${bucket.toString(16).padStart(2, "0")}${tail}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function ruling(oracleId: string, publishedAt: string, comment: string, source = "wotc"): RulingRow {
	return { oracle_id: oracleId, source, published_at: publishedAt, comment };
}

/** The rulings a bucket holds for one id, decoded — the route splices these bytes verbatim. */
function rulingsOf(bucket: Uint8Array, oracleId: string): Record<string, unknown>[] | null {
	const slice = rulingsSlice(bucket, oracleId);
	return slice === null ? null : (JSON.parse(decoder.decode(slice)) as Record<string, unknown>[]);
}

describe("bucket addressing", () => {
	test("the bucket is the first byte of the oracle id", () => {
		expect(rulingsBucketOf("00000000-0000-4000-8000-000000000000")).toBe(0);
		expect(rulingsBucketOf("ff000000-0000-4000-8000-000000000000")).toBe(RULINGS_BUCKET_COUNT - 1);
		// Case cannot change where a card's rulings live: Scryfall lowercases its ids, but a client
		// following a URL it built itself may not.
		expect(rulingsBucketOf("AB000000-0000-4000-8000-000000000000")).toBe(0xab);
	});

	test("anything that is not a UUID has no bucket", () => {
		for (const value of [
			"",
			"not-a-uuid",
			"00000000-0000-4000-8000-00000000000",
			"zz000000-0000-4000-8000-000000000000",
		]) {
			expect(rulingsBucketOf(value)).toBeNull();
			expect(uuidHex(value)).toBeNull();
		}
	});

	test("keys carry the format version, so a layout change lands beside the old set", () => {
		expect(rulingsBucketKey(0)).toBe("rulings:v2:00");
		expect(rulingsBucketKey(255)).toBe("rulings:v2:ff");
	});
});

describe("encode and slice", () => {
	test("a card's rulings come back as the Ruling objects upstream builds", () => {
		const id = uuidIn(0x2b, 1);
		const { bytes, rulingCount } = encodeRulingsBucket([ruling(id, "2014-07-18", "Only ruling.", "scryfall")]);
		expect(rulingCount).toBe(1);
		expect(rulingsOf(bytes, id)).toEqual([
			{ object: "ruling", oracle_id: id, source: "scryfall", published_at: "2014-07-18", comment: "Only ruling." },
		]);
	});

	test("rulings are newest date first, as Scryfall serves them", () => {
		// NOT upstream's ORDER BY published_at, comment. Measured against api.scryfall.com: 16 of 16
		// sampled cards spanning several dates came back newest-first, so upstream's ascending sort
		// would show every one of them inverted to a client that only changed its base URL.
		const id = uuidIn(0x10, 7);
		const { bytes } = encodeRulingsBucket([
			ruling(id, "2019-07-12", "b newer"),
			ruling(id, "2014-07-18", "z oldest"),
			ruling(id, "2019-07-12", "a newer"),
		]);
		expect((rulingsOf(bytes, id) as Record<string, unknown>[]).map((r) => r.comment)).toEqual([
			// Within one date the comment is only a deterministic stand-in: Scryfall orders same-date
			// rulings by an id the bulk file does not carry.
			"a newer",
			"b newer",
			"z oldest",
		]);
	});

	test("the file's repeated tuples are served once", () => {
		// 37 of 77,998 entries on 2026-08-11 are exact repeats; upstream drops them on its unique
		// index, so a client must not see the same ruling twice here either.
		const id = uuidIn(0x40, 3);
		const twice = ruling(id, "2020-01-01", "Said once.");
		const { bytes, rulingCount } = encodeRulingsBucket([twice, { ...twice }, ruling(id, "2020-01-01", "Said too.")]);
		expect(rulingCount).toBe(2);
		expect((rulingsOf(bytes, id) as unknown[]).length).toBe(2);
	});

	test("a card with no rulings in the bucket is null, which the route reads as an empty list", () => {
		const { bytes } = encodeRulingsBucket([ruling(uuidIn(0x55, 1), "2020-01-01", "One.")]);
		expect(rulingsSlice(bytes, uuidIn(0x55, 2))).toBeNull();
		// An empty bucket is still a bucket: the publisher writes all 256, so the route can read a
		// MISSING one as "nothing published yet" rather than as "this card has none".
		const empty = encodeRulingsBucket([]);
		expect(empty.rulingCount).toBe(0);
		expect(rulingsSlice(empty.bytes, uuidIn(0x55, 1))).toBeNull();
	});

	test("every id in a full bucket resolves to its OWN rulings", () => {
		// The binary search is the part that fails quietly: an index sorted differently than it is
		// searched returns a neighbour's rulings under this card's id, with nothing to notice.
		const rows: RulingRow[] = [];
		for (let n = 0; n < 400; n++) {
			// Ids added in an order that is neither sorted nor reverse-sorted.
			const id = uuidIn(0x7f, (n * 37) % 400);
			rows.push(ruling(id, "2020-01-01", `ruling for ${(n * 37) % 400}`));
		}
		const { bytes, rulingCount } = encodeRulingsBucket(rows);
		expect(rulingCount).toBe(400);
		for (let n = 0; n < 400; n++) {
			const found = rulingsOf(bytes, uuidIn(0x7f, n)) as Record<string, unknown>[];
			expect(found).toHaveLength(1);
			expect(found[0]?.comment).toBe(`ruling for ${n}`);
			expect(found[0]?.oracle_id).toBe(uuidIn(0x7f, n));
		}
	});

	test("an oracle id that is not a UUID is dropped rather than given a bucket", () => {
		const good = uuidIn(0x01, 1);
		const { bytes, rulingCount } = encodeRulingsBucket([
			ruling(good, "2020-01-01", "Kept."),
			ruling("oracle-id-from-a-future-scryfall", "2020-01-01", "Dropped."),
		]);
		expect(rulingCount).toBe(1);
		expect(rulingsOf(bytes, good)).toHaveLength(1);
	});

	test("non-ASCII comments survive the byte layout", () => {
		// Offsets and lengths are in BYTES; a comment measured in characters would truncate every
		// ruling with a typographic apostrophe in it, which is most of them.
		const id = uuidIn(0x99, 1);
		const comment = "They’re not associated with any specific permanents — ✦";
		const { bytes } = encodeRulingsBucket([
			ruling(id, "2020-01-01", comment),
			ruling(uuidIn(0x99, 2), "2020-01-01", "x"),
		]);
		expect((rulingsOf(bytes, id) as Record<string, unknown>[])[0]?.comment).toBe(comment);
	});
});

describe("a bucket that is not a bucket", () => {
	const id = uuidIn(0x22, 1);
	const good = encodeRulingsBucket([ruling(id, "2020-01-01", "One.")]).bytes;

	test("bytes that are not this format are an error, never a miss", () => {
		const wrongMagic = good.slice();
		wrongMagic[0] = 0x00;
		expect(() => rulingsSlice(wrongMagic, id)).toThrow(RulingsFormatError);
		expect(() => rulingsSlice(new Uint8Array(4), id)).toThrow(RulingsFormatError);
	});

	test("a future format version is refused rather than misread", () => {
		const future = good.slice();
		future.set(new TextEncoder().encode("99"), 4); // the version's two hex digits
		expect(() => rulingsSlice(future, id)).toThrow(RulingsFormatError);
	});

	test("an index longer than the value it sits in is refused", () => {
		const truncated = good.slice(0, 20);
		expect(() => rulingsSlice(truncated, id)).toThrow(RulingsFormatError);
	});

	test("a bucket survives being carried as a string", () => {
		// THE REGRESSION THIS FORMAT EXISTS FOR. A KV value goes through string-shaped transports
		// (`wrangler kv bulk put` takes its values from JSON), and a packed binary index came back
		// with every id replaced by U+FFFD — bigger by ~900 bytes, still parseable, and answering
		// `data: []` for a card with 32 rulings. Decoding STRICTLY is the check: if any byte here is
		// not valid UTF-8, this throws rather than quietly substituting.
		const rows: RulingRow[] = [];
		for (let n = 0; n < 50; n++) rows.push(ruling(uuidIn(0xe0, n), "2020-01-01", `ruling ${n} — “quoted”`));
		const { bytes } = encodeRulingsBucket(rows);
		const carried = new TextEncoder().encode(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		expect(carried).toEqual(bytes);
		for (let n = 0; n < 50; n++) {
			expect((rulingsOf(carried, uuidIn(0xe0, n)) as Record<string, unknown>[])[0]?.comment).toBe(
				`ruling ${n} — “quoted”`,
			);
		}
	});

	test("a bucket read out of a larger buffer reads its own bytes", () => {
		// KV hands back an ArrayBuffer; a view with a non-zero byteOffset is what a caller that
		// slices one out of a bigger read would pass, and DataView must be told about it.
		const padded = new Uint8Array(good.length + 8);
		padded.set(good, 8);
		expect(rulingsOf(padded.subarray(8), id)).toHaveLength(1);
	});
});

describe("parseRulingLine", () => {
	const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
	const full = {
		object: "ruling",
		oracle_id: "00037840-6089-42ec-8c5c-281f9f474504",
		source: "wotc",
		published_at: "2025-02-07",
		comment: "Energy counters are a kind of counter that a player may have.",
	};

	test("keeps the four fields upstream's table requires", () => {
		expect(parseRulingLine(line(full))).toEqual({
			oracle_id: full.oracle_id,
			source: "wotc",
			published_at: "2025-02-07",
			comment: full.comment,
		});
	});

	test("drops an entry missing any of them, as upstream's _valid_rulings does", () => {
		for (const field of ["oracle_id", "source", "published_at", "comment"] as const) {
			expect(parseRulingLine(line({ ...full, [field]: "" }))).toBeNull();
			expect(parseRulingLine(line({ ...full, [field]: undefined }))).toBeNull();
		}
	});

	test("a published_at that grew a time component is still a date", () => {
		// Upstream slices rather than parses so a future timestamp form cannot fail its ::date
		// cast; the same slice keeps the served value a date rather than a timestamp.
		expect(parseRulingLine(line({ ...full, published_at: "2025-02-07T21:00:31.766+00:00" }))?.published_at).toBe(
			"2025-02-07",
		);
	});

	test("a line that is not an object is dropped, not thrown", () => {
		for (const value of ["", "not json", "null", "[]", '"a string"']) {
			expect(parseRulingLine(value)).toBeNull();
		}
	});
});
