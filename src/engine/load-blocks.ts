// How archive bytes cross from a KV stream into wasm linear memory: in blocks of a size this
// module picks, rather than in whatever pieces the source happened to deliver.
//
// Every `store_load_chunk` call is a wasm-bindgen boundary crossing — it allocates a buffer inside
// linear memory, copies the piece in, lets Rust append it, and frees. That prologue is a FIXED cost
// per call, so what it costs over a whole load is set by the NUMBER of pieces, not their size. And
// gzipping the store took the production piece count from 3 to 18,713, because `DecompressionStream`
// emits 4KB at a time (76,642,320 / 18,713 = 4,096 exactly). Measured across that deploy
// (2026-08-12T02:03Z), cold Durable Object invocations went 322ms -> 1252ms at the median and
// 1050ms -> 2504ms at the max, against the ~190ms the change had budgeted for decompression.
//
// Blocking decouples the crossing size from however the source cut the bytes up, and that coupling
// is what made BOTH formats bad: a 26MB uncompressed KV chunk meant a 26MB scratch allocation
// inside linear memory (peak ~102.6MB against the 128MB isolate), and a 4KB gzip piece means 18,713
// crossings. A block size in the low megabytes is small enough to leave the peak compression bought
// essentially intact and large enough that the per-call cost stops being visible.
//
// The extra copy this adds is real and is not the cost: one more pass over 76.6MB at memcpy speed,
// single-digit milliseconds against the several hundred the crossings were taking.
//
// The comment this replaces recorded blocking as tried and rejected — "at 17,880 pieces it measured
// no better than passing them straight through, so the crossings are not the cost". That was
// measured under wrangler dev's SIMULATED KV, which hands a store over in ~4KB pieces whatever the
// format, so it compared blocked-vs-unblocked at a piece count production did not then have. On the
// network the uncompressed path delivered 3 pieces, and the experiment never covered the case gzip
// has now created.

/** Bytes gathered on the JS side before each crossing into wasm. */
export const LOAD_BLOCK_BYTES = 4 * 1024 * 1024;

/** What a load fed, from both ends: pieces the source delivered, blocks handed to wasm. */
export interface FeedCounts {
	pieces: number;
	blocks: number;
}

/**
 * Drain `body` into `push`, never crossing into wasm with more than `blockBytes` at a time.
 *
 * IT DOES NOT COALESCE, and used to. The original version accumulated small pieces into one reused
 * `blockBytes` buffer, on the theory that the 18,713 crossings a gzipped store produces were
 * expensive. 58cfbe7 shipped that and measured the theory false: crossings went 18,713 -> 19 and
 * cold DO CPU did not move. So the accumulation bought nothing while costing a full extra pass over
 * the archive — a 76.6MB memcpy on every single load, purely to rearrange bytes that were about to
 * be copied again anyway.
 *
 * What was worth keeping is the CEILING, not the floor: no single crossing may be large, because
 * wasm-bindgen allocates a scratch buffer inside linear memory for each one and that allocation is
 * what the 128MB isolate actually feels. A 26MB KV chunk crossed whole took peak linear memory to
 * ~102.6MB; capped at 4MB it is ~78.7MB.
 *
 * Both properties now hold with ZERO copies on this side. A piece at or under the cap crosses as
 * it arrived; a larger one is handed over as `subarray` VIEWS, which allocate nothing. The only
 * copy left is the one wasm-bindgen makes into linear memory, which happens regardless.
 *
 * A consequence worth stating: `push` no longer receives a reused buffer, so it is free to retain
 * what it is given. The old contract required synchronous consumption.
 *
 * Both counts are returned and both are logged by the caller. `pieces` is not knowable from this
 * side — it depends entirely on how KV and any DecompressionStream hand the bytes over — and it is
 * the number that made the original regression visible, so it stays observable.
 */
export async function feedBlocks(
	body: ReadableStream<Uint8Array>,
	push: (block: Uint8Array) => void,
	blockBytes: number = LOAD_BLOCK_BYTES,
): Promise<FeedCounts> {
	const reader = body.getReader();
	let pieces = 0;
	let blocks = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			pieces += 1;
			if (value.length <= blockBytes) {
				// Already small enough to cross as-is. No copy, no accumulation: the
				// piece IS the block.
				push(value);
				blocks += 1;
				continue;
			}
			// Too big for one crossing, so hand it over in `blockBytes` slices.
			// `subarray` is a VIEW — the only copy is the one wasm-bindgen makes on
			// the far side, which happens whatever we do here.
			for (let off = 0; off < value.length; off += blockBytes) {
				push(value.subarray(off, Math.min(off + blockBytes, value.length)));
				blocks += 1;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { pieces, blocks };
}
