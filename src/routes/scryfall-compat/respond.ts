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
import type { SearchPageEnvelope } from "../../engine/types";
import { CSV_CONTENT_DISPOSITION, CSV_CONTENT_TYPE, CSV_HAS_MORE_HEADER, cardsToCsv } from "./csv";
import { cardList, catalogObject, errorObject } from "./objects";

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

/**
 * One Scryfall object as a response. An error object's own `status` becomes the HTTP status.
 *
 * AN ERROR BODY IS ALWAYS PRETTY-PRINTED, whatever `pretty` says. That is not a style choice, it is
 * what api.scryfall.com does: measured 2026-08-16 across the whole surface, every `object: "error"`
 * body comes back as two-space-indented JSON while every data body comes back compact, and it does
 * not negotiate — `Accept: application/json`, `Accept: text/html`, a bare wildcard and an explicit
 * `?pretty=false` all produce the same 130-byte indented not-found. Scryfall renders errors through
 * a different serializer than answers, and this port rendered both compact, so a client comparing
 * bytes saw a different document for every 4xx it received.
 *
 * `pretty` still reaches the writer for the 200 case, which is the only case it was ever about.
 */
export function scryfallJson(
	payload: Record<string, unknown>,
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	const isError = payload.object === "error";
	const status = isError && typeof payload.status === "number" ? payload.status : 200;
	return new Response(stringifyScryfall(payload, isError || pretty), {
		status,
		headers: { "content-type": JSON_CONTENT_TYPE, ...cache },
	});
}

/**
 * A DISPATCH-level error in Scryfall's shape: `{object, code, status, details}`.
 *
 * The router answers some errors before any handler runs — an unknown path, a method a route does
 * not accept, an engine that has not loaded — and it used to answer all of them in upstream's falcon
 * shape, `{title, description}`. On the Scryfall-compatible surface that is the wrong document: a
 * client pointed at this deployment instead of api.scryfall.com parses `code` and `details`, finds
 * neither, and has to special-case this origin — which is precisely the thing it cannot do and still
 * be pointable back at Scryfall.
 *
 * So the SHAPE is chosen by which surface the path belongs to (see `SCRYFALL_SURFACE_ROUTES`), not
 * by which error it is. This deployment also serves upstream's own routes and its own web
 * interface, whose error bodies the frontend renders through `showError()` by reading `title` and
 * `description`; those keep falcon's shape, because there the JSON is talking to a page rather than
 * to an API client.
 *
 * Pretty-printed, like every other error body here — see `scryfallJson`.
 */
export function scryfallHttpError(
	code: string,
	status: number,
	details: string,
	extraHeaders?: Record<string, string>,
): Response {
	return new Response(stringifyScryfall(errorObject(code, status, details), true), {
		status,
		headers: { "content-type": JSON_CONTENT_TYPE, "Cache-Control": "no-cache", ...extraHeaders },
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

/**
 * The answer when a page came back with no rows — which is TWO different answers.
 *
 * Scryfall separates "your query matched nothing" from "your query matched, but not this far in":
 * a query with no results is `404 not_found` at every page, and a page past the end of a result
 * that DOES have rows is `422 validation_error` (measured 2026-08-16: `e:khm` is two pages, and
 * `page=3` is a 422 while `e:notaset` is a 404 at `page=1` and at `page=3` alike). This port
 * answered 404 to both, which told a paginating client its query had stopped matching.
 *
 * Lives here rather than in the three engines that call it because all three MUST agree: the same
 * URL is served by the in-process engine under test, the Durable Object in production and the
 * route-test harness, and a divergence between them is one no single suite can see.
 */
export function emptyPageResponse(
	envelope: SearchPageEnvelope,
	totalCards: number,
	cache: Record<string, string>,
): Response {
	if (envelope.beyondEndDetails !== undefined && totalCards > 0 && envelope.pageOffset >= totalCards) {
		// No `warnings` on this body: Scryfall's 422 carries none even for a query whose terms were
		// ignored (`subtype:elf e:khm&page=9999`).
		return scryfallJson(errorObject("validation_error", 422, envelope.beyondEndDetails), envelope.pretty, cache);
	}
	// NO `warnings` on a 404, even when terms WERE ignored: Scryfall's not-found body is
	// `{object, code, status, details}` and nothing else, on a query with ignored terms
	// (`-pow:2 t:goblin e:khm`) exactly as on one without (`subtype:elf e:notaset`). This port used
	// to attach them here to explain an unsupported `is:` value, which is a real courtesy and a real
	// divergence; the note survives on `/search`, this project's own surface, where it belongs.
	return scryfallJson(errorObject("not_found", 404, envelope.noMatchDetails), envelope.pretty, cache);
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

// `scryfallListStream` USED TO SIT HERE: a List whose envelope was spliced around a payload still
// streaming out of the Durable Object. It is gone because the shape it served is gone. Two
// transports remain, and neither wants it (see f740ed3):
//
//   payload leaves the isolate untouched   -> the object builds the WHOLE response and this side
//                                             returns it (/cards/search, /cards) — no splice, so
//                                             nothing to wrap
//   isolate must splice around the payload -> buffer it (/search, /random_search), because the
//                                             tail is `metadataFor` and cannot exist before the
//                                             payload does
//
// Splicing around a stream is the third case, and it is the one that measured WORSE: /search on
// the streaming transport went 5ms -> 11ms of isolate against a 10ms budget. Restoring this
// function would be re-proposing that, so the argument belongs here rather than the code.

/**
 * The same page of cards as `scryfallListJson`, rendered as Scryfall's CSV instead.
 *
 * It takes the SAME `data` bytes the JSON envelope would have been spliced around, which is what
 * keeps the two formats from ever disagreeing about which rows a page holds: `format=csv` selects a
 * serialization, never a query. The array is parsed here rather than in the engine because this
 * runs where the payload already is — inside the Durable Object for the deployed path, in-process
 * for the direct one — and never in the request isolate, whose 10ms budget is the reason
 * `/cards/search` builds its whole response on the far side of the RPC in the first place.
 *
 * `has_more` has no envelope to live in, so it rides a header, exactly as api.scryfall.com does.
 */
export function scryfallCsvResponse(dataBytes: Uint8Array, hasMore: boolean, cache: Record<string, string>): Response {
	const cards = JSON.parse(new TextDecoder().decode(dataBytes)) as Record<string, unknown>[];
	const body = encodeUtf8(cardsToCsv(cards));
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": CSV_CONTENT_TYPE,
			"content-disposition": CSV_CONTENT_DISPOSITION,
			"content-length": String(body.byteLength),
			[CSV_HAS_MORE_HEADER]: String(hasMore),
			...cache,
		},
	});
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
