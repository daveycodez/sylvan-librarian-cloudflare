// The rolling-deploy fallback for the columnar gather (backlog n11).
//
// `"columns"` is the first row shape a sibling on the previous build REFUSES: that build hands the
// shape name to its engine, whose `parse_shape` knows only rows and cards and throws. A coordinator
// on the new build therefore has to turn that refusal into the previous build's answer — rows,
// unshaped — which `runTwoPhase` already reshapes, row by kept row. These pin the wrapper that does
// it (`tolerateUnknownShape`) against fakes; columnar-real-pages.test.ts runs the same thing over a
// real store.

import { describe, expect, test } from "bun:test";
import { assembleColumnar, columnKeys, columnsFrameOf, columnsGather, serializeCards } from "../../src/engine/columnar";
import {
	encodeKeyPacket,
	encodeRowPacket,
	type PartitionClient,
	type RowShaping,
	runTwoPhase,
	tolerateUnknownShape,
} from "../../src/engine/gather";
import type { EngineSearchOptions } from "../../src/engine/types";

const OPTS: EngineSearchOptions = {
	filterTreeJson: "{}",
	unique: "card",
	prefer: "default",
	orderby: "name",
	direction: "asc",
	limit: 4,
	offset: 0,
	fields: ["name", "cmc"],
};

const encoder = new TextEncoder();
const REFUSAL = 'unknown row shape "columns": expected "rows" or "cards"';

/** The engine's row JSON for a card: serde_json's spelling, so cmc is `2.0`. */
const rowJson = (p: number, v: number) => `{"cmc":${v}.0,"name":"p${p}v${v}"}`;

/**
 * A partition. On this build (`refuses` false) it writes rows or column frames as asked; on the
 * previous one it throws that build's error for "columns". Records every shape it was asked for.
 */
function partition(p: number, keys: number[], refuses: boolean, asked: string[]): PartitionClient {
	const entries = keys.map((k, i) => ({ key: new Uint8Array([k]), vpid: i }));
	const frame = (v: number, shaping: RowShaping): Uint8Array =>
		shaping.shape === "columns"
			? columnsFrameOf(JSON.parse(rowJson(p, v)) as Record<string, unknown>, columnKeys(OPTS.fields))
			: encoder.encode(rowJson(p, v));
	const check = (shaping: RowShaping) => {
		asked.push(shaping.shape);
		if (refuses && shaping.shape === "columns") throw new Error(REFUSAL);
	};
	return {
		async searchKeys(opts, inlineRows, shaping) {
			check(shaping);
			const window = entries.slice(opts.offset, opts.offset + opts.limit);
			return {
				packed: encodeKeyPacket({
					total: keys.length,
					entries: window,
					inlineRows: window.slice(0, inlineRows).map((e) => frame(e.vpid, shaping)),
				}),
				storeKey: `card-store-v1-100-p${p}.store`,
				sortKeyVersion: 1,
				shape: shaping.shape,
			};
		},
		async fetchRows(vpids, _fields, _storeKey, shaping) {
			check(shaping);
			return { rowsBytes: encodeRowPacket(vpids.map((v) => frame(v, shaping))), shape: shaping.shape };
		},
	};
}

const COLUMNS: RowShaping = { shape: "columns", baseUrl: "" };

describe("tolerateUnknownShape", () => {
	test("a phase-1 refusal is asked again for rows and answered as the previous build (no shape)", async () => {
		const asked: string[] = [];
		const client = tolerateUnknownShape(partition(0, [1, 2], true, asked), "columns");
		const reply = await client.searchKeys(OPTS, 2, COLUMNS);
		expect(asked).toEqual(["columns", "rows"]);
		expect(reply.shape).toBeUndefined();
		// Learned: phase 2 goes straight to rows, and answers the previous build's JSON array.
		const fetched = await client.fetchRows([0, 1], OPTS.fields, "k", COLUMNS);
		expect(asked).toEqual(["columns", "rows", "rows"]);
		expect(fetched.shape).toBeUndefined();
		expect(new TextDecoder().decode(fetched.rowsBytes)).toBe(`[${rowJson(0, 0)},${rowJson(0, 1)}]`);
	});

	test("a phase-2 refusal alone falls back too", async () => {
		const asked: string[] = [];
		const client = tolerateUnknownShape(partition(0, [1], true, asked), "columns");
		const fetched = await client.fetchRows([0], OPTS.fields, "k", COLUMNS);
		expect(asked).toEqual(["columns", "rows"]);
		expect(fetched.shape).toBeUndefined();
	});

	test("a partition on this build is asked once, in the shape", async () => {
		const asked: string[] = [];
		const client = tolerateUnknownShape(partition(0, [1], false, asked), "columns");
		const reply = await client.searchKeys(OPTS, 1, COLUMNS);
		expect(asked).toEqual(["columns"]);
		expect(reply.shape).toBe("columns");
	});

	test("any other failure is not a fallback", async () => {
		const failing: PartitionClient = {
			searchKeys: async () => {
				throw new Error("gather: partition 3 did not answer");
			},
			fetchRows: async () => {
				throw new Error("generation mismatch");
			},
		};
		const client = tolerateUnknownShape(failing, "columns");
		await expect(client.searchKeys(OPTS, 0, COLUMNS)).rejects.toThrow(/did not answer/);
		await expect(client.fetchRows([0], [], "k", COLUMNS)).rejects.toThrow(/mismatch/);
	});

	test("the rows shape is passed through untouched", () => {
		const client = partition(0, [1], false, []);
		expect(tolerateUnknownShape(client, "rows")).toBe(client);
	});
});

describe("a columnar gather across a half-deployed fleet", () => {
	for (const [label, offset] of [
		["page 1, off the inline prefixes", 0],
		["a later page, through phase 2", 2],
	] as const) {
		test(`${label}: the page is the one serializeCards wrote`, async () => {
			const asked: string[][] = [[], [], []];
			const keys = [
				[1, 3, 5],
				[2, 4, 6],
				[7, 8],
			];
			// Partition 1 is still on the previous build.
			const fleet = keys.map((k, p) => partition(p, k, p === 1, asked[p] as string[]));
			const opts = { ...OPTS, offset };
			const columnKeysOf = columnKeys(opts.fields);
			const page = await runTwoPhase(fleet, opts, columnsGather(columnKeysOf));
			// Merged: 1 2 3 4 5 6 7 8 = p0v0 p1v0 p0v1 p1v1 p0v2 p1v2 p2v0 p2v1.
			const expected = [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
				[0, 2],
				[1, 2],
				[2, 0],
				[2, 1],
			]
				.slice(offset, offset + opts.limit)
				.map(([p, v]) => JSON.parse(rowJson(p as number, v as number)) as Record<string, unknown>);
			expect(new TextDecoder().decode(assembleColumnar(columnKeysOf, page.slots))).toBe(
				serializeCards(expected, "columnar"),
			);
			expect(asked[1]?.[0]).toBe("columns");
			expect(asked[1]?.slice(1).every((s) => s === "rows")).toBe(true);
			expect(asked[0]?.every((s) => s === "columns")).toBe(true);
		});
	}
});
