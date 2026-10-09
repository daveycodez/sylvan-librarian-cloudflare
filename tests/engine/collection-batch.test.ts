// POST /cards/collection's one-round batch: the packet codec, the absence of a per-kind fallback,
// and the response the route splices from the engine's bytes — which must be the document the old
// objects-then-stringify path wrote, byte for byte.

import { describe, expect, test } from "bun:test";
import {
	collectionBatchRequest,
	collectionPacketRanks,
	decodeCollectionPacket,
} from "../../src/engine/collection-batch";
import { RemoteEngine } from "../../src/engine/remote-engine";
import { currentShardWidth } from "../../src/engine/shard-controller";
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
		const packet = packetOf([[3, "", 1, 0.5]], ['{"k":"a"}', null, null, '{"t":1}', '{"n":"bolt"}']);
		const got = decodeCollectionPacket(packet, BATCH);
		const read = (b: Uint8Array | null) => (b === null ? null : text.decode(b));
		expect(got.keys.map(read)).toEqual(['{"k":"a"}', null]);
		expect(got.trees.map(read)).toEqual([null, '{"t":1}']);
		expect(got.names.map(read)).toEqual(['{"n":"bolt"}']);
		expect(got.nameRanks).toEqual([[3, "", 1, 0.5]]);
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
		const req = (b: CollectionBatch) => JSON.parse(collectionBatchRequest(b)) as Record<string, unknown>;
		expect(req({ ...BATCH, presence: true }).presence).toBe(true);
		expect("presence" in req(BATCH)).toBe(false);
	});

	test("a packet that does not match its batch is refused, not misread", () => {
		const short = packetOf([null], ['{"k":"a"}', null, null, null]);
		expect(() => decodeCollectionPacket(short, BATCH)).toThrow();
		const wrongRanks = packetOf([], ['{"k":"a"}', null, null, null, null]);
		expect(() => decodeCollectionPacket(wrongRanks, BATCH)).toThrow(/ranks/);
	});

	test("the request carries the batch and the tree options, and no batch-wide filter or preference", () => {
		const req = JSON.parse(collectionBatchRequest(BATCH)) as Record<string, unknown>;
		expect(req.keys).toEqual(BATCH.keys);
		expect(req.trees).toEqual(BATCH.trees);
		expect(req.names).toEqual([["lightning bolt", ""]]);
		expect((req.tree_opts as { orderby: string; limit: number }).orderby).toBe("edhrec");
		// The engine still reads `prefer` and `scope` off this object — the `?q=` extension's two
		// keys (removed 2026-10-08). Absent is its "none"; written, they would filter every name.
		expect(Object.keys(req).sort()).toEqual(["keys", "names", "tree_opts", "trees"]);
		// A caller cannot hand one in either: a second argument is not read.
		const stray = (collectionBatchRequest as (...args: unknown[]) => string)(BATCH, {
			prefer: "oldest",
			filterTreeJson: '{"x":1}',
		});
		expect(stray).toBe(collectionBatchRequest(BATCH));
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

describe("RemoteEngine's batch keeps the RPC's argument positions across the `?q=` scope's removal", () => {
	// The engine object's method is (batch, baseUrl, <scope>, reportedShards), by position. The
	// scope is gone (2026-10-08) and its place is not: an object on the build before reads the
	// third argument as a scope and the fourth as the shard count, so a shard count sent third
	// would never arrive there, and every collection call would report a width of 1 to the
	// region's rendezvous for as long as the deploy rolls.
	//
	// It is still so one deploy later (the Rust behind the scope went then, the slot did not): the
	// object on the build before reads the count fourth on any day, so the Worker sends it fourth.
	test("the third argument is null and the shard count is still the fourth", async () => {
		const sent: unknown[][] = [];
		const stub = {
			scryfallCollectionBatch: async (...args: unknown[]) => {
				sent.push(args);
				return { packet: packetOf([null], ['{"k":"a"}', null, null, null, null]) };
			},
		};
		await new RemoteEngine(stub as never, "wnam").scryfallCollectionBatch(BATCH, "https://x");
		expect(sent).toHaveLength(1);
		const [batch, baseUrl, retired, shards] = sent[0] as unknown[];
		expect(sent[0]).toHaveLength(4);
		expect(batch).toBe(BATCH);
		expect(baseUrl).toBe("https://x");
		expect(retired).toBeNull();
		expect(typeof shards).toBe("number");
	});

	test("NEW ISOLATE, OLD OBJECT: an object reading (batch, baseUrl, retired, reportedShards) is handed the region's width", async () => {
		// The method as the object on the build before this one declares it, read by position.
		const read: { retired: unknown; reportedShards: unknown }[] = [];
		const stub = {
			scryfallCollectionBatch: async (_batch: unknown, _baseUrl: string, retired: unknown, reportedShards?: number) => {
				read.push({ retired, reportedShards });
				return { packet: packetOf([null], ['{"k":"a"}', null, null, null, null]) };
			},
		};
		await new RemoteEngine(stub as never, "wnam").scryfallCollectionBatch(BATCH, "https://x");
		expect(read).toEqual([{ retired: null, reportedShards: currentShardWidth("wnam") }]);
	});

	test("the engine's own method takes a batch and a base URL, and a third argument reaches nothing", async () => {
		const sent: unknown[][] = [];
		const stub = {
			scryfallCollectionBatch: async (...args: unknown[]) => {
				sent.push(args);
				return { packet: packetOf([null], ['{"k":"a"}', null, null, null, null]) };
			},
		};
		const engine = new RemoteEngine(stub as never, "wnam");
		const loose = engine.scryfallCollectionBatch.bind(engine) as (...args: unknown[]) => Promise<unknown>;
		await loose(BATCH, "https://x", { prefer: "oldest", filterTreeJson: '{"x":1}' });
		expect((sent[0] as unknown[])[2]).toBeNull();
	});
});

describe("RemoteEngine's batch carries where unsettled routed names live (x47)", () => {
	const names = ["lightning bolt", "lightnig bolt", "chaos"].map((folded) => ({ folded, setCode: "" }));
	const batch: CollectionBatch = { keys: [], trees: [], names };
	const packet = packetOf([null, null, null], [null, null, null]);

	test("the header alone reads the ranks and the presence", () => {
		expect(collectionPacketRanks(packet)).toEqual({ ranks: [null, null, null] });
		const widened = packetOf({ ranks: [null], present: [true] } as never, [null]);
		expect(collectionPacketRanks(widened)).toEqual({ ranks: [null], present: [true] });
	});

	test("the holders are spread back over the batch's names, null where the store did not look", async () => {
		const located = { builtAt: "1790419993", names: [1, 2], holders: [[], [1, 3]] };
		const stub = { scryfallCollectionBatch: async () => ({ packet, located }) };
		const got = await new RemoteEngine(stub as never, "wnam").scryfallCollectionBatch(batch, "https://x");
		expect(got.nameHolders).toEqual({ builtAt: "1790419993", holders: [null, [], [1, 3]] });
		expect(got.nameRanks).toEqual([null, null, null]);
	});

	test("a store on the build before it sends none; a position outside the batch is dropped", async () => {
		const plain = { scryfallCollectionBatch: async () => ({ packet }) };
		const bare = await new RemoteEngine(plain as never, "wnam").scryfallCollectionBatch(batch, "https://x");
		expect("nameHolders" in bare).toBe(false);
		const odd = { builtAt: "1", names: [7, -1, 1.5, 0], holders: [[1], [2], [3], [4]] };
		const stub = { scryfallCollectionBatch: async () => ({ packet, located: odd }) };
		const got = await new RemoteEngine(stub as never, "wnam").scryfallCollectionBatch(batch, "https://x");
		expect(got.nameHolders).toEqual({ builtAt: "1", holders: [[4], null, null] });
	});
});

describe("RemoteEngine's batch carries what wrote it (x58), and pairs with the code on either side of it", () => {
	const batch: CollectionBatch = { keys: [{ kind: "scryfall_id", id: "a" }], trees: [], names: [] };
	const packet = packetOf([], ['{"k":"a"}']);
	const answeredFrom = { build: "1791026526", commit: "40e6ab09" };
	const ask = (reply: Record<string, unknown>) =>
		new RemoteEngine({ scryfallCollectionBatch: async () => reply } as never, "wnam").scryfallCollectionBatch(
			batch,
			"https://x",
		);

	test("the object's build and commit come through beside the cards", async () => {
		const got = await ask({ packet, answeredFrom });
		expect(got.answeredFrom).toEqual(answeredFrom);
		expect(got.keys.map((b) => (b === null ? null : text.decode(b)))).toEqual(['{"k":"a"}']);
	});

	test("NEW ISOLATE, OLD OBJECT: a reply without the field is the same cards and no claim", async () => {
		// The object on the code before x58 returns `{ packet }`. The answer decodes as it always
		// did and says nothing about what wrote it — which the route reads as "do not keep".
		const got = await ask({ packet });
		expect("answeredFrom" in got).toBe(false);
		expect(got.keys.map((b) => (b === null ? null : text.decode(b)))).toEqual(['{"k":"a"}']);
		// Half a claim is no claim: neither field is taken without the other, nor a non-string.
		for (const half of [{ build: "1791026526" }, { commit: "40e6ab09" }, { build: 1791026526, commit: "x" }, null]) {
			expect("answeredFrom" in (await ask({ packet, answeredFrom: half }))).toBe(false);
		}
	});

	test("OLD ISOLATE, NEW OBJECT: the code before x58 reads the packet and `located`, and they are unchanged", async () => {
		// What the previous RemoteEngine did with a reply, verbatim: destructure the two fields it
		// knew and decode. A trailing field it never names cannot reach it.
		const located = { builtAt: "1791026526", names: [], holders: [] };
		const previous = (reply: { packet: Uint8Array; located?: unknown }) => {
			const { packet: bytes, located: where } = reply;
			return { answer: decodeCollectionPacket(bytes, batch), where };
		};
		const before = previous({ packet, located });
		const after = previous({ packet, located, answeredFrom } as never);
		expect(after.answer).toEqual(before.answer);
		expect(after.where).toBe(before.where);
		expect("answeredFrom" in after.answer).toBe(false);
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

	test("compact is the stringified List byte for byte, and its keys are Scryfall's three", async () => {
		const spliced = await scryfallCollectionJson(bytes, notFound, false, CACHE).text();
		const old = await scryfallJson(collectionList(cards, notFound), false, CACHE).text();
		expect(spliced).toBe(old);
		// No `warnings`: api.scryfall.com's collection List never carries the key (2026-10-08), and
		// the one thing that wrote it here — the `?q=` scope — is gone.
		expect(Object.keys(JSON.parse(spliced))).toEqual(["object", "not_found", "data"]);
	});

	test("pretty indents the cards too, as the old path did", async () => {
		const spliced = await scryfallCollectionJson(bytes, notFound, true, CACHE).text();
		const old = await scryfallJson(collectionList(cards, notFound), true, CACHE).text();
		expect(spliced).toBe(old);
	});

	test("nothing found is still a List with an empty data array", async () => {
		const spliced = await scryfallCollectionJson([], notFound, false, CACHE).text();
		expect(spliced).toBe(await scryfallJson(collectionList([], notFound), false, CACHE).text());
	});

	test("the headers are the route's", () => {
		const res = scryfallCollectionJson(bytes, [], false, CACHE);
		expect(res.headers.get("cache-control")).toBe("private");
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});
