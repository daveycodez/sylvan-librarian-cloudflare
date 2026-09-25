// UTF-8 helpers for the payload path, which deliberately never becomes a JS string.
//
// The engine writes its answer as UTF-8 and the socket wants UTF-8, so every conversion in
// between is pure overhead: wasm-bindgen would decode to UTF-16, the Durable Object RPC would
// encode back to UTF-8, and the isolate would flatten and encode a third time to build the
// response body. Measured, the DO's CPU is very nearly a pure function of payload size, and the
// isolate's share of these passes is charged against the free plan's 10ms per request.
//
// So the envelope is spliced in bytes: the small JSON around the payload is encoded once (it is
// a couple of hundred bytes), and the payload itself is copied exactly once, into the buffer that
// becomes the response.

const ENCODER = new TextEncoder();

/** The newline separating the engine's `<total> <rowCount>` prefix from its rows. */
export const NEWLINE = 0x0a;

/** Encode a small piece of JSON — an envelope, never a payload. */
export function encodeUtf8(text: string): Uint8Array {
	return ENCODER.encode(text);
}

/**
 * Join byte runs into one buffer.
 *
 * One allocation and one pass, against the alternative of building a JS string and letting the
 * response encode it: that would materialize the whole payload in UTF-16 first, which is the cost
 * this path exists to avoid. `set` is a memcpy, not a per-character loop.
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.byteLength;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

const DECODER = new TextDecoder();

/** Decode UTF-8 bytes — for the one caller that genuinely needs the payload as values. */
export function decodeUtf8(bytes: Uint8Array): string {
	return DECODER.decode(bytes);
}

const LT = 0x3c;
const LT_ESCAPE = ENCODER.encode("\\u003c");

/**
 * JSON bytes made safe to inline in an HTML `<script>`: every `<` becomes `<`, exactly what
 * serializeEmbeddedJson does to a string (upstream #1037). Byte-level is sound because UTF-8 never
 * uses 0x3C inside a multi-byte sequence (continuation bytes are 0x80-0xBF). A payload with no `<`
 * — nearly all of them — comes back as the same view, uncopied.
 */
export function escapeLtBytes(bytes: Uint8Array): Uint8Array {
	let at = bytes.indexOf(LT);
	if (at === -1) return bytes;
	const parts: Uint8Array[] = [];
	let from = 0;
	while (at !== -1) {
		parts.push(bytes.subarray(from, at), LT_ESCAPE);
		from = at + 1;
		at = bytes.indexOf(LT, from);
	}
	parts.push(bytes.subarray(from));
	return concatBytes(parts);
}

/** A JSON response built from byte runs, without ever concatenating strings. */
export function jsonBytesResponse(parts: readonly Uint8Array[], headers?: Record<string, string>): Response {
	return new Response(concatBytes(parts), {
		headers: { "content-type": "application/json", ...headers },
	});
}

// `jsonStreamResponse` USED TO SIT HERE: an envelope spliced around a payload still streaming out
// of the Durable Object. Removed with its last caller. The isolate no longer splices around a
// stream on ANY route — /cards/search and /cards have the object build the whole response, and
// /search and /random_search buffer, because their tail depends on the payload. See the transport
// note in routes/scryfall-compat/respond.ts before reintroducing this shape.
