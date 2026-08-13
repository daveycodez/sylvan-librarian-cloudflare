// How every Scryfall-compatible response reaches the wire.
//
// Both surfaces answer with Scryfall's objects — the cards routes out of the engine, the reference
// routes out of KV — and they must not drift on the mechanics: the content type carries the
// charset Scryfall sends, an error object's own `status` is the HTTP status, and a pre-rendered
// `data` array is SPLICED into its envelope as bytes rather than parsed and re-encoded.
//
// Upstream split the same plumbing out for the same reason when its second surface arrived
// (api/scryfall_compat/responder.py, #922).

import { encodeUtf8, jsonBytesResponse, jsonStreamResponse } from "../../engine/bytes";
import { cardList, catalogObject } from "./objects";

/**
 * Spelled out rather than a shared constant: Scryfall sends the charset, and a client that compares
 * content types sees the difference.
 */
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** The spellings Scryfall reads as true; module-level so asBool does not rebuild it per call. */
const TRUE_SPELLINGS = new Set(["1", "true", "yes", "on"]);

/** Parse a Scryfall boolean query parameter; anything but a true spelling is false. */
export function asBool(value: string | undefined, fallback = false): boolean {
	if (value === undefined) return fallback;
	return TRUE_SPELLINGS.has(value.trim().toLowerCase());
}

// ─── decimal fields ──────────────────────────────────────────────────────────
//
// Scryfall types `cmc` and a symbol's `mana_value` as DECIMAL, and its JSON says so: Lightning Bolt
// is `"cmc":1.0`, not `"cmc":1` (api.scryfall.com/cards/named?exact=Lightning+Bolt). The field is
// decimal because fractional mana values are real — Little Girl costs {HW} and has `"cmc":0.5` —
// so a whole-numbered mana value still serializes with its decimal point.
//
// JavaScript cannot express that. It has one number type, and `JSON.stringify(1.0)` is `"1"`, so
// every card object this port serialized was one byte short of Scryfall's on a field a strictly
// typed client can notice. Python, where upstream lives, has no such problem: 1.0 is a float and
// `json.dumps` writes `1.0`.
//
// So the number is carried through `JSON.stringify` as a marked STRING and unquoted afterwards.
// The marker is a per-isolate UUID rather than a fixed token: the unquoting is a text substitution
// over the whole body, and a card's own oracle text must not be able to spell it.
const DECIMAL_FIELDS: ReadonlySet<string> = new Set(["cmc", "mana_value"]);

// The marker is built ON FIRST USE, not at module load. Workers forbid generating random values in
// global scope — "Disallowed operation called within global scope" — and a `crypto.randomUUID()`
// here does not fail at the request that needs it, it fails the whole isolate at startup, so every
// route 500s. `bun dev` refused to boot at all, which is the only reason this was cheap to find.
let decimalMark: { mark: string; pattern: RegExp } | null = null;

function decimalMarker(): { mark: string; pattern: RegExp } {
	decimalMark ??= (() => {
		const mark = `@@decimal-${crypto.randomUUID()}:`;
		return { mark, pattern: new RegExp(`"${mark}([-0-9.eE+]+)"`, "g") };
	})();
	return decimalMark;
}

/** A decimal-typed number as Scryfall writes it: `1` becomes `1.0`, `0.5` stays `0.5`. */
function decimalText(value: number): string {
	return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * `JSON.stringify` for Scryfall objects, with decimal-typed fields written as decimals.
 *
 * Every Scryfall-shaped body this port emits goes through here, so the rule lives in one place —
 * and the engine, which writes card objects itself in Rust, is held to the same bytes by
 * tests/routes/card-object-parity.test.ts.
 */
export function stringifyScryfall(value: unknown, pretty = false): string {
	const { mark, pattern } = decimalMarker();
	const marked = JSON.stringify(
		value,
		(key, raw) => (DECIMAL_FIELDS.has(key) && typeof raw === "number" ? `${mark}${decimalText(raw)}` : raw),
		pretty ? 2 : undefined,
	);
	return marked.replace(pattern, "$1");
}

/** One Scryfall object as a response. An error object's own `status` becomes the HTTP status. */
export function scryfallJson(
	payload: Record<string, unknown>,
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	const status = payload.object === "error" && typeof payload.status === "number" ? payload.status : 200;
	return new Response(stringifyScryfall(payload, pretty), {
		status,
		headers: { "content-type": JSON_CONTENT_TYPE, ...cache },
	});
}

/**
 * Splice already-encoded array bytes into an envelope built by `envelope`.
 *
 * The envelope is built with an EMPTY data array and the bytes are dropped into it, so there is one
 * definition of each object's key order rather than a second one written out here. `data` is always
 * the last key, so this is a tail replacement found by lastIndexOf rather than a regex: an anchored
 * `$` does not match, because the closing brace follows.
 *
 * Only the envelope is encoded here. The payload can be 692KB (the card-names catalog) or 621KB
 * (the set list), and it is copied once, as bytes, into the buffer that becomes the response —
 * interpolating it into a template literal instead would decode the whole thing to UTF-16 and
 * encode it back.
 */
/**
 * Split a rendered envelope at its empty `data` array, giving the bytes either side of the payload.
 *
 * The one implementation of where the splice happens, because the buffered and streamed responses
 * MUST agree byte for byte — they answer the same routes and the same cached URLs, so a divergence
 * here would be a difference no test on either path alone could see.
 */
export function spliceMarkers(
	envelope: Record<string, unknown>,
	pretty: boolean,
): { head: Uint8Array; tail: Uint8Array } {
	const body = stringifyScryfall(envelope, pretty);
	const key = pretty ? '"data": ' : '"data":';
	const marker = `${key}[]`;
	const at = body.lastIndexOf(marker);
	if (at < 0) throw new Error("envelope did not end with an empty data array");
	return { head: encodeUtf8(`${body.slice(0, at)}${key}`), tail: encodeUtf8(body.slice(at + marker.length)) };
}

function spliceData(
	envelope: Record<string, unknown>,
	dataBytes: Uint8Array,
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	const { head, tail } = spliceMarkers(envelope, pretty);
	return jsonBytesResponse([head, dataBytes, tail], { "content-type": JSON_CONTENT_TYPE, ...cache });
}

/** A List whose `data` is already encoded. */
export function scryfallListJson(
	dataBytes: Uint8Array,
	opts: { totalCards?: number; hasMore: boolean; nextPage?: string; warnings?: string[] },
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	return spliceData(cardList([], opts), dataBytes, pretty, cache);
}

/**
 * The same List, with `data` arriving as a STREAM the engine is still writing.
 *
 * Byte-for-byte identical to `scryfallListJson` — same envelope, same splice point, same order —
 * but the payload is never a `Uint8Array` in this isolate at all: it is piped from the Durable
 * Object straight to the socket. That is the whole point, since the measured cost of these routes
 * is handling the bytes rather than producing them.
 *
 * `dataLength` is the engine's own count, so `content-length` is still exact and these responses
 * stay cacheable on Scryfall's 16-hour tier exactly as before. A streamed body without it would go
 * out chunked, which is a behaviour change the payload win does not justify.
 */
export function scryfallListStream(
	data: { body: ReadableStream<Uint8Array>; byteLength: number },
	opts: { totalCards?: number; hasMore: boolean; nextPage?: string; warnings?: string[] },
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	const { head, tail } = spliceMarkers(cardList([], opts), pretty);
	return jsonStreamResponse(
		{ head, payload: data.body, payloadLength: data.byteLength, tail },
		{ "content-type": JSON_CONTENT_TYPE, ...cache },
	);
}

/**
 * A Catalog whose `data` is already encoded.
 *
 * `totalValues` rides alongside the bytes because `total_values` is a key in the object and the
 * whole point is not to parse the array to count it — the publisher knows the count and stores it
 * (see reference-kv.ts).
 */
export function scryfallCatalogJson(
	dataBytes: Uint8Array,
	totalValues: number,
	uri: string | undefined,
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	const envelope = catalogObject([], uri);
	envelope.total_values = totalValues;
	return spliceData(envelope, dataBytes, pretty, cache);
}
