// The byte-handling contract of the partitioned /cards/search, pinned as a COUNT rather than a
// time: assembling a page of card objects from the partitions' framed rows must call JSON.parse,
// JSON.stringify and TextDecoder.decode exactly ZERO times.
//
// Every shipped CPU win on this route came from removing a pass over the payload (rowCount,
// query_rows, bytes end to end, card objects in Rust — see Store.scryfallSearch), and the
// regression this guards against was invisible to every other test: when the gather became the
// only search path it quietly reintroduced all four passes, the routes still answered correctly,
// the RPC-count table still held, and only the Durable Object's CPU knew. A timing bound would
// need stable hardware; a call count runs anywhere, and it fails the moment a pass comes back.

import { describe, expect, spyOn, test } from "bun:test";
import {
	encodeKeyPacket,
	encodeRowPacket,
	type GatherShaping,
	joinJsonArray,
	type PartitionClient,
	runTwoPhase,
} from "../../src/engine/gather";
import type { EngineSearchOptions } from "../../src/engine/types";

const OPTS: EngineSearchOptions = {
	filterTreeJson: "{}",
	unique: "printing",
	prefer: "default",
	orderby: "name",
	direction: "asc",
	limit: 4,
	offset: 0,
	fields: ["name"],
};

const CARDS: GatherShaping = {
	shape: "cards",
	baseUrl: "https://x",
	reshape: () => {
		throw new Error("reshape must never run against a fleet that has finished deploying");
	},
};

/** A card-shaped frame, built with TextEncoder BEFORE any spy is installed. */
const frame = (partition: number, vpid: number) =>
	new TextEncoder().encode(`{"object":"card","name":"p${partition}v${vpid}","cmc":1.0}`);

/** A partition answering in the card shape: framed inline rows and a framed phase 2. */
function cardPartition(partition: number, keys: number[]): PartitionClient {
	const storeKey = `card-store-v1-100-p${partition}.store`;
	const entries = keys.map((k, i) => ({ key: new Uint8Array([k]), vpid: i }));
	return {
		async searchKeys(opts, inlineRows) {
			const window = entries.slice(opts.offset, opts.offset + opts.limit);
			return {
				packed: encodeKeyPacket({
					total: keys.length,
					entries: window,
					inlineRows: window.slice(0, inlineRows).map((e) => frame(partition, e.vpid)),
				}),
				storeKey,
				sortKeyVersion: 1,
				shape: "cards",
			};
		},
		async fetchRows(vpids) {
			return { rowsBytes: encodeRowPacket(vpids.map((v) => frame(partition, v))), shape: "cards" };
		},
	};
}

function expectedPage(refs: [number, number][]): string {
	return `[${refs.map(([p, v]) => new TextDecoder().decode(frame(p, v))).join(",")}]`;
}

/** Run `body` with the three codecs spied on, and return their call counts. */
async function countPasses(
	body: () => Promise<Uint8Array>,
): Promise<{ parse: number; stringify: number; decode: number; bytes: Uint8Array }> {
	const parse = spyOn(JSON, "parse");
	const stringify = spyOn(JSON, "stringify");
	const decode = spyOn(TextDecoder.prototype, "decode");
	try {
		const bytes = await body();
		return {
			parse: parse.mock.calls.length,
			stringify: stringify.mock.calls.length,
			decode: decode.mock.calls.length,
			bytes,
		};
	} finally {
		parse.mockRestore();
		stringify.mockRestore();
		decode.mockRestore();
	}
}

describe("passes over the payload on the partitioned /cards/search", () => {
	test("page 1, covered by the inline prefixes: zero parses, zero stringifies, zero decodes", async () => {
		const clients = [cardPartition(0, [1, 3, 5]), cardPartition(1, [2, 4, 6]), cardPartition(2, [7, 8])];
		const passes = await countPasses(async () => {
			const page = await runTwoPhase(clients, OPTS, CARDS);
			return joinJsonArray(page.slots);
		});
		expect(passes.parse).toBe(0);
		expect(passes.stringify).toBe(0);
		expect(passes.decode).toBe(0);
		expect(new TextDecoder().decode(passes.bytes)).toBe(
			expectedPage([
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
			]),
		);
	});

	test("a deep page, through phase 2: still zero", async () => {
		const clients = [cardPartition(0, [1, 3, 5]), cardPartition(1, [2, 4, 6]), cardPartition(2, [7, 8])];
		const passes = await countPasses(async () => {
			const page = await runTwoPhase(clients, { ...OPTS, offset: 5, limit: 3 }, CARDS);
			return joinJsonArray(page.slots);
		});
		expect(passes.parse).toBe(0);
		expect(passes.stringify).toBe(0);
		expect(passes.decode).toBe(0);
		// Merged: 1 2 3 4 5 | 6 7 8 → p1v2, p2v0, p2v1.
		expect(new TextDecoder().decode(passes.bytes)).toBe(
			expectedPage([
				[1, 2],
				[2, 0],
				[2, 1],
			]),
		);
	});

	test("the spies see what they are meant to see", async () => {
		// A control, so a zero above means "no pass" and not "the spy missed it".
		const passes = await countPasses(async () => {
			const parsed = JSON.parse(new TextDecoder().decode(frame(0, 0))) as { name: string };
			return new TextEncoder().encode(JSON.stringify(parsed));
		});
		expect(passes.parse).toBe(1);
		expect(passes.stringify).toBe(1);
		expect(passes.decode).toBe(1);
	});
});
