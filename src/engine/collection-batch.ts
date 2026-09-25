// `POST /cards/collection` in one round: the request a store is sent, the packet it answers with,
// and the partitioned merge's two rules. See Engine.scryfallCollectionBatch.
//
// The packet is what engine/wasm's `collection_batch` writes, little-endian:
//
//   header_len: u32, header: header_len bytes of JSON — one rank per name, [served, tier, score] or null
//     (or, when the batch asked for `presence`, {"ranks": [...], "present": [bool per name]})
//   then for each key, each tree, each name, in that order: len: u32, card: len bytes (0 = none)
//
// Decoding takes VIEWS into the packet (subarray, never slice), so a card's bytes are copied once —
// into the response — however many layers carry them there.

import { CARD_OBJECT_FIELDS } from "../routes/scryfall-compat/objects";
import { stringifyScryfall } from "../routes/scryfall-compat/respond";
import { encodeUtf8 } from "./bytes";
import type { CollectionBatch, CollectionBatchAnswer, CollectionKeyIdentifier, CollectionScope, Engine } from "./types";

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
		| (number[] | null)[]
		| { ranks: (number[] | null)[]; present: boolean[] };
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
		nameRanks: new Array<number[] | null>(batch.names.length).fill(null),
	};
}

/** The error workerd raises when a stub's object has no such method — see collectionBatchFromSeparateCalls. */
export function isMissingRpcMethod(err: unknown, method: string): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.includes(`does not implement the method "${method}"`);
}

/**
 * ROLLING-DEPLOY SHIM: one store's answer to a batch, through the per-kind methods that predate
 * `scryfallCollectionBatch`. For a request handler on this build that reaches an object still on
 * the previous one, which has no such method; it costs the calls the batch saves, for that one
 * object, for that one window. Delete it (and its caller in remote-engine.ts) once a later deploy
 * has shipped — no object can be older than the build before it.
 */
export async function collectionBatchFromSeparateCalls(
	engine: Pick<
		Engine,
		| "scryfallCardsByIds"
		| "scryfallCardsByIdentifiers"
		| "scryfallFirstOfEach"
		| "scryfallCollectionNames"
		| "scryfallCollectionNameRanks"
	>,
	batch: CollectionBatch,
	baseUrl: string,
	scope: CollectionScope | null,
): Promise<CollectionBatchAnswer> {
	const out = emptyCollectionAnswer(batch);
	const bytes = (card: Record<string, unknown> | null | undefined) =>
		card ? encodeUtf8(stringifyScryfall(card)) : null;
	const ids = batch.keys.flatMap((k, i) => (k.kind === "scryfall_id" ? [{ i, id: k.id }] : []));
	const others = batch.keys.flatMap((k, i) => (k.kind === "scryfall_id" ? [] : [{ i, key: k }]));
	await Promise.all([
		ids.length === 0
			? null
			: engine
					.scryfallCardsByIds(
						ids.map((e) => e.id),
						baseUrl,
					)
					.then((cards) => {
						const byId = new Map(cards.map((c) => [String(c.id).toLowerCase(), c]));
						for (const { i, id } of ids) out.keys[i] = bytes(byId.get(id.toLowerCase()));
					}),
		others.length === 0
			? null
			: engine
					.scryfallCardsByIdentifiers(
						others.map((e) => e.key as CollectionKeyIdentifier),
						baseUrl,
					)
					.then((cards) => {
						for (const [j, { i }] of others.entries()) out.keys[i] = bytes(cards[j]);
					}),
		batch.trees.length === 0
			? null
			: engine.scryfallFirstOfEach(batch.trees, baseUrl).then((cards) => {
					for (const [i, card] of cards.entries()) out.trees[i] = bytes(card);
				}),
		batch.names.length === 0
			? null
			: Promise.all([
					engine.scryfallCollectionNameRanks(batch.names, scope),
					engine.scryfallCollectionNames(batch.names, baseUrl, scope),
				]).then(([ranks, cards]) => {
					out.nameRanks = ranks;
					for (const [i, card] of cards.entries()) out.names[i] = bytes(card);
				}),
	]);
	return out;
}
