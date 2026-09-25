// POST /cards/collection's one-round batch: the packet codec, the absence of a per-kind fallback,
// and the response the route splices from the engine's bytes — which must be the document the old
// objects-then-stringify path wrote, byte for byte.

import { describe, expect, test } from "bun:test";
import { collectionBatchRequest, decodeCollectionPacket } from "../../src/engine/collection-batch";
import { RemoteEngine } from "../../src/engine/remote-engine";
import type { CollectionBatch } from "../../src/engine/types";
import { collectionList } from "../../src/routes/scryfall-compat/objects";
import { scryfallCollectionJson, scryfallJson, stringifyScryfall } from "../../src/routes/scryfall-compat/respond";

const utf8 = new TextEncoder();
const text = new TextDecoder();

/** A packet laid out exactly as engine/wasm's `collection_batch` writes it. */
function packetOf(ranks: unknown[], slots: (string | null)[]): Uint8Array {
	const header = utf8.encode(JSON.stringify(ranks));
	const parts: number[] = [];
	const u32 = (n: number) => parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
	u32(header.length);
	parts.push(...header);
	for (const slot of slots) {
		const bytes = slot === null ? new Uint8Array() : utf8.encode(slot);
		u32(bytes.length);
		parts.push(...bytes);
	}
	return new Uint8Array(parts);
}

const BATCH: CollectionBatch = {
	keys: [
		{ kind: "scryfall_id", id: "a" },
		{ kind: "external", namespace: "mtgo", id: 7 },
	],
	trees: ["t-en", "t-any"],
	names: [{ folded: "lightning bolt", setCode: "" }],
};

describe("the collection packet", () => {
	test("decodes to per-slot views in key, tree, name order", () => {
		const packet = packetOf([[1, 2, 0.5]], ['{"k":"a"}', null, null, '{"t":1}', '{"n":"bolt"}']);
		const got = decodeCollectionPacket(packet, BATCH);
		const read = (b: Uint8Array | null) => (b === null ? null : text.decode(b));
		expect(got.keys.map(read)).toEqual(['{"k":"a"}', null]);
		expect(got.trees.map(read)).toEqual([null, '{"t":1}']);
		expect(got.names.map(read)).toEqual(['{"n":"bolt"}']);
		expect(got.nameRanks).toEqual([[1, 2, 0.5]]);
		// Views, not copies: every card shares the packet's buffer.
		expect(got.keys[0]?.buffer).toBe(packet.buffer);
	});

	test("a batch that asked for presence reads the widened header; one that did not has none", () => {
		const slots = ['{"k":"a"}', null, null, null, null];
		const widened = decodeCollectionPacket(packetOf({ ranks: [null], present: [true] } as never, slots), BATCH);
		expect(widened.nameRanks).toEqual([null]);
		expect(widened.namePresent).toEqual([true]);
		// A store on the previous build ignores the flag and answers the plain array.
		const plain = decodeCollectionPacket(packetOf([null], slots), BATCH);
		expect(plain.nameRanks).toEqual([null]);
		expect(plain.namePresent).toBeUndefined();
		const req = (b: CollectionBatch) => JSON.parse(collectionBatchRequest(b, null)) as Record<string, unknown>;
		expect(req({ ...BATCH, presence: true }).presence).toBe(true);
		expect("presence" in req(BATCH)).toBe(false);
	});

	test("a packet that does not match its batch is refused, not misread", () => {
		const short = packetOf([null], ['{"k":"a"}', null, null, null]);
		expect(() => decodeCollectionPacket(short, BATCH)).toThrow();
		const wrongRanks = packetOf([], ['{"k":"a"}', null, null, null, null]);
		expect(() => decodeCollectionPacket(wrongRanks, BATCH)).toThrow(/ranks/);
	});

	test("the request carries the batch, the tree options and the scope", () => {
		const req = JSON.parse(
			collectionBatchRequest(BATCH, { prefer: "oldest", filterTreeJson: '{"x":1}' } as never),
		) as Record<string, unknown>;
		expect(req.keys).toEqual(BATCH.keys);
		expect(req.trees).toEqual(BATCH.trees);
		expect(req.names).toEqual([["lightning bolt", ""]]);
		expect(req.prefer).toBe("oldest");
		expect(req.scope).toBe('{"x":1}');
		expect((req.tree_opts as { orderby: string; limit: number }).orderby).toBe("edhrec");
		expect(JSON.parse(collectionBatchRequest(BATCH, null)).scope).toBe("");
	});
});

describe("RemoteEngine's batch has no per-kind fallback", () => {
	// The rolling-deploy shim that answered a previous-build object through the per-kind methods
	// is gone with them (backlog n3): every object has had scryfallCollectionBatch since b9bc501.
	test("a failure of the batch call is the caller's, whatever it says", async () => {
		for (const message of [
			"Engine query failed: bad scope",
			'The RPC receiver does not implement the method "scryfallCollectionBatch".',
		]) {
			const stub = {
				scryfallCollectionBatch: async () => {
					throw new Error(message);
				},
			};
			await expect(new RemoteEngine(stub as never, "wnam").scryfallCollectionBatch(BATCH, "https://x")).rejects.toThrow(
				message,
			);
		}
	});
});

describe("the collection response, spliced from card bytes", () => {
	// Decimal-typed fields, a nested object and a non-ASCII name: the parts of a card object where a
	// splice and a stringify could disagree.
	const cards = [
		{ object: "card", id: "a", name: "Æther Vial", cmc: 1, prices: { usd: "1.00" } },
		{ object: "card", id: "b", name: "Fire // Ice", cmc: 4, card_faces: [{ name: "Fire" }, { name: "Ice" }] },
	];
	const notFound = [{ name: "No Such Card" }, { set: "xyz", collector_number: "1" }];
	const bytes = cards.map((c) => utf8.encode(stringifyScryfall(c)));
	const CACHE = { "Cache-Control": "private" };

	for (const warnings of [undefined, ["a warning"]]) {
		test(`compact, ${warnings ? "with" : "without"} warnings, is the stringified List byte for byte`, async () => {
			const spliced = await scryfallCollectionJson(bytes, notFound, warnings, false, CACHE).text();
			const old = await scryfallJson(collectionList(cards, notFound, warnings), false, CACHE).text();
			expect(spliced).toBe(old);
		});
	}

	test("pretty indents the cards too, as the old path did", async () => {
		const spliced = await scryfallCollectionJson(bytes, notFound, undefined, true, CACHE).text();
		const old = await scryfallJson(collectionList(cards, notFound), true, CACHE).text();
		expect(spliced).toBe(old);
	});

	test("nothing found is still a List with an empty data array", async () => {
		const spliced = await scryfallCollectionJson([], notFound, undefined, false, CACHE).text();
		expect(spliced).toBe(await scryfallJson(collectionList([], notFound), false, CACHE).text());
	});

	test("the headers are the route's", () => {
		const res = scryfallCollectionJson(bytes, [], undefined, false, CACHE);
		expect(res.headers.get("cache-control")).toBe("private");
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});
