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
 * Drain `body` into `push`, gathering source pieces into `blockBytes`-sized blocks.
 *
 * `push` MUST consume the block synchronously, because the same buffer is refilled and pushed
 * again — which is the point, since a fresh allocation per block would put the garbage back that
 * blocking exists to avoid. The wasm-bindgen crossing copies into linear memory before returning,
 * so it satisfies that; anything that retained the reference would see it overwritten.
 *
 * Both counts are returned and both are logged by the caller. `pieces` is not knowable from this
 * side — it depends entirely on how KV and any DecompressionStream hand the bytes over — and it is
 * the number that made the regression above visible, so it stays observable even though the loader
 * no longer lets it drive anything.
 */
export async function feedBlocks(
	body: ReadableStream<Uint8Array>,
	push: (block: Uint8Array) => void,
	blockBytes: number = LOAD_BLOCK_BYTES,
): Promise<FeedCounts> {
	const reader = body.getReader();
	const block = new Uint8Array(blockBytes);
	let filled = 0;
	let pieces = 0;
	let blocks = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			pieces += 1;
			// A piece may straddle any number of block boundaries — an uncompressed 26MB KV chunk
			// fills six and a bit — so this loops rather than assuming a piece fits in what is left.
			let off = 0;
			while (off < value.length) {
				const take = Math.min(blockBytes - filled, value.length - off);
				block.set(value.subarray(off, off + take), filled);
				filled += take;
				off += take;
				if (filled === blockBytes) {
					push(block);
					blocks += 1;
					filled = 0;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	// The tail, which is almost every load: an archive is not a multiple of the block size.
	// `subarray` is a view, so the crossing copies only the bytes actually filled.
	if (filled > 0) {
		push(block.subarray(0, filled));
		blocks += 1;
	}
	return { pieces, blocks };
}
