// `POST /cards/collection` in one round: the request a store is sent, the packet it answers with,
// and the partitioned merge's two rules. See Engine.scryfallCollectionBatch.
//
// The packet is what engine/wasm's `collection_batch` writes, little-endian:
//
//   header_len: u32, header: header_len bytes of JSON — one rank per name, [tier, name, served, score] or null
//     (or, when the batch asked for `presence`, {"ranks": [...], "present": [bool per name]})
//   then for each key, each tree, each name, in that order: len: u32, card: len bytes (0 = none)
//
// Decoding takes VIEWS into the packet (subarray, never slice), so a card's bytes are copied once —
// into the response — however many layers carry them there.

import { CARD_OBJECT_FIELDS } from "../routes/scryfall-compat/objects";
import type { CollectionBatch, CollectionBatchAnswer, CollectionScope, NameRank } from "./types";

/**
 * How a `{set, collector_number}` tree is answered: its first printing under these options, the
 * ones `scryfallFirstOfEach` has always used.
 */
const TREE_OPTS = {
	unique: "printing",
	prefer: "default",
	orderby: "edhrec",
	direction: "asc",
	limit: 1,
	offset: 0,
	fields: CARD_OBJECT_FIELDS,
	include_multilingual: false,
};

const decoder = new TextDecoder();

/** The `request_json` argument of `collection_batch`. */
export function collectionBatchRequest(batch: CollectionBatch, scope: CollectionScope | null | undefined): string {
	return JSON.stringify({
		keys: batch.keys,
		trees: batch.trees,
		tree_opts: TREE_OPTS,
		names: batch.names.map(({ folded, setCode }) => [folded, setCode]),
		prefer: scope?.prefer ?? "default",
		scope: scope?.filterTreeJson ?? "",
		...(batch.presence ? { presence: true } : {}),
	});
}

/** A `collection_batch` packet, split into per-slot views in `batch`'s order. */
export function decodeCollectionPacket(packet: Uint8Array, batch: CollectionBatch): CollectionBatchAnswer {
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	const headerLen = view.getUint32(0, true);
	// Two header shapes: the plain rank array, and `{ranks, present}` for a batch that asked for
	// presence — which a store on the previous build ignores, answering the plain array.
	const header = JSON.parse(decoder.decode(packet.subarray(4, 4 + headerLen))) as
		| (NameRank | null)[]
		| { ranks: (NameRank | null)[]; present: boolean[] };
	const nameRanks = Array.isArray(header) ? header : header.ranks;
	const namePresent = Array.isArray(header) ? undefined : header.present;
	let at = 4 + headerLen;
	const take = (count: number): (Uint8Array | null)[] => {
		const out: (Uint8Array | null)[] = [];
		for (let i = 0; i < count; i++) {
			const len = view.getUint32(at, true);
			at += 4;
			out.push(len === 0 ? null : packet.subarray(at, at + len));
			at += len;
		}
		return out;
	};
	const keys = take(batch.keys.length);
	const trees = take(batch.trees.length);
	const names = take(batch.names.length);
	if (at !== packet.byteLength || nameRanks.length !== batch.names.length) {
		throw new Error(
			`collection packet does not match its batch: ${packet.byteLength} bytes, read ${at}; ${nameRanks.length} ranks for ${batch.names.length} names`,
		);
	}
	return namePresent === undefined ? { keys, trees, names, nameRanks } : { keys, trees, names, nameRanks, namePresent };
}

/** An answer with nothing found, sized to `batch` — the start of a merge. */
export function emptyCollectionAnswer(batch: CollectionBatch): CollectionBatchAnswer {
	const none = (n: number) => new Array<Uint8Array | null>(n).fill(null);
	return {
		keys: none(batch.keys.length),
		trees: none(batch.trees.length),
		names: none(batch.names.length),
		nameRanks: new Array<NameRank | null>(batch.names.length).fill(null),
	};
}
