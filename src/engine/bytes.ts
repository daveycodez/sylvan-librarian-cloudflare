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

/** A JSON response built from byte runs, without ever concatenating strings. */
export function jsonBytesResponse(parts: readonly Uint8Array[], headers?: Record<string, string>): Response {
	return new Response(concatBytes(parts), {
		headers: { "content-type": "application/json", ...headers },
	});
}

/**
 * The same envelope splice, with the payload arriving as a STREAM the engine is still sending.
 *
 * The one implementation for every route whose body is `<small head><big payload><small tail>` —
 * /search, /random_search, /cards/search and /cards. They all used to buffer the payload into one
 * array first; measured 2026-08-13, serializing it out of the Durable Object was the largest single
 * term in /cards/search's DO CPU, and taking it off that route moved 18ms -> 14ms. Nothing about
 * that is specific to card objects, so there is no second way to build these responses.
 *
 * CONTENT-LENGTH IS EXACT, from the engine's own byte count. A streamed body would otherwise go out
 * chunked, and these responses are edge-cached on two different tiers; the length is known before
 * the first byte moves, so no client or cache can tell this from the buffered form.
 */
export function jsonStreamResponse(
	parts: { head: Uint8Array; payload: ReadableStream<Uint8Array>; payloadLength: number; tail: Uint8Array },
	headers?: Record<string, string>,
): Response {
	const { head, payload, payloadLength, tail } = parts;
	// PIPED, not pulled. The first version of this read the payload with a `pull` callback and
	// re-enqueued each chunk, which put a JS call on every chunk of a 652KB page IN THE METERED
	// ISOLATE — measured at ~13ms mean against the free plan's 10ms budget. `pipeTo` moves the same
	// bytes inside the runtime with no JS in the loop, so only the two small ends are touched here.
	// A bare TransformStream rather than workerd's IdentityTransformStream: the identity one is a
	// runtime global that does not exist under `bun test`, and this path is covered by route tests.
	// Neither has a JS transform function, so neither puts a callback in the chunk loop.
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	void (async () => {
		const writer = writable.getWriter();
		try {
			await writer.write(head);
		} finally {
			writer.releaseLock();
		}
		await payload.pipeTo(writable, { preventClose: true });
		const closer = writable.getWriter();
		await closer.write(tail);
		await closer.close();
	})().catch(() => {
		// A client that hangs up mid-body aborts the pipe; there is nothing to answer with by then,
		// and an unhandled rejection here would take the isolate down rather than the request.
	});
	return new Response(readable, {
		headers: {
			"content-type": "application/json",
			"content-length": String(head.byteLength + payloadLength + tail.byteLength),
			...headers,
		},
	});
}
