// How every Scryfall-compatible response reaches the wire.
//
// Both surfaces answer with Scryfall's objects — the cards routes out of the engine, the reference
// routes out of KV — and they must not drift on the mechanics: the content type carries the
// charset Scryfall sends, an error object's own `status` is the HTTP status, and a pre-rendered
// `data` array is SPLICED into its envelope as bytes rather than parsed and re-encoded.
//
// Upstream split the same plumbing out for the same reason when its second surface arrived
// (api/scryfall_compat/responder.py, #922).

import { encodeUtf8, jsonBytesResponse } from "../../engine/bytes";
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

/** One Scryfall object as a response. An error object's own `status` becomes the HTTP status. */
export function scryfallJson(
	payload: Record<string, unknown>,
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	const status = payload.object === "error" && typeof payload.status === "number" ? payload.status : 200;
	return new Response(pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload), {
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
function spliceData(
	envelope: Record<string, unknown>,
	dataBytes: Uint8Array,
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	const body = pretty ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope);
	const key = pretty ? '"data": ' : '"data":';
	const marker = `${key}[]`;
	const at = body.lastIndexOf(marker);
	if (at < 0) throw new Error("envelope did not end with an empty data array");
	const head = encodeUtf8(`${body.slice(0, at)}${key}`);
	const tail = encodeUtf8(body.slice(at + marker.length));
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
