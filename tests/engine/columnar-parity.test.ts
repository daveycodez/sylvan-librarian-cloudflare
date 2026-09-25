// The gate on writing the columnar page in the engine (backlog n11).
//
// `serializeCards(rows, "columnar")` — the engine's rows through JSON.parse, inverted, and back out
// of JSON.stringify — is what `/search?shape=columnar` has always answered, and the site reads it.
// The replacement never parses: the engine writes each row's values as a COLUMN FRAME, spelled the
// way JSON.stringify spells them, and `assembleColumnar` copies bytes. The route splices those bytes
// into the response unexamined, so "equal once parsed" is not the bar; this compares BYTES, over
// rows built to break each part of the writer: number spelling (the one place serde_json and
// JavaScript disagree), key order, string escaping, nesting, and the empty page.
//
// Unlike most of tests/, this instantiates the real wasm engine. It needs no store: the frame
// writer is a pure function of the rows (`shaped_frames_from_rows`, a test-only export).

import { describe, expect, test } from "bun:test";
import { assembleColumnar, columnKeys, columnsFrameOf, serializeCards } from "../../src/engine/columnar";
import { decodeRowPacket, joinJsonArray } from "../../src/engine/gather";
import { newEngine } from "./wasm-engine";

const engine = newEngine();
const decoder = new TextDecoder();

/**
 * Rows given as the JSON text the engine writes (serde_json's spelling, keys sorted), answered both
 * ways: the page the old path wrote, and the pages the engine's frames assemble to.
 */
function bothWays(rowsJson: string): { reference: string; columns: string; reshaped: string; rows: string } {
	const parsed = JSON.parse(rowsJson) as Record<string, unknown>[];
	const keys = columnKeys(parsed.length > 0 ? Object.keys(parsed[0] as Record<string, unknown>) : []);
	const columnFrames = decodeRowPacket(engine.use((g) => g.shaped_frames_from_rows(rowsJson, "columns")));
	const rowFrames = decodeRowPacket(engine.use((g) => g.shaped_frames_from_rows(rowsJson, "rows")));
	expect(columnFrames.length).toBe(parsed.length);
	return {
		reference: serializeCards(parsed, "columnar"),
		columns: decoder.decode(assembleColumnar(keys, columnFrames)),
		reshaped: decoder.decode(
			assembleColumnar(
				keys,
				parsed.map((row) => columnsFrameOf(row, keys)),
			),
		),
		rows: decoder.decode(joinJsonArray(rowFrames)),
	};
}

function expectParity(rowsJson: string): void {
	const got = bothWays(rowsJson);
	expect(got.columns).toBe(got.reference);
	// The legacy reshape — a partition still on the previous build — lands on the same bytes.
	expect(got.reshaped).toBe(got.reference);
	// And the JavaScript-spelled "rows" frames join to what JSON.stringify wrote over the parse.
	expect(got.rows).toBe(serializeCards(JSON.parse(rowsJson) as Record<string, unknown>[], "rows"));
}

describe("the columnar page assembled from engine frames equals serializeCards byte for byte", () => {
	test("numbers: whole floats, -0, both exponent thresholds, and integers past 2^53", () => {
		// Each of these parses to the same double in serde_json (best-effort float parse) as in
		// JSON.parse, so both sides start from one value — `123456789012345680000.0`, for one, does
		// not. In production no parse sits between the two spellings: both write the engine's own
		// double. The spelling of arbitrary doubles is covered by bits, below.
		const values = [
			"5.0",
			"-5.0",
			"0.0",
			"-0.0",
			"0.5",
			"12.25",
			"0.1",
			"0.30000000000000004",
			"1e-6",
			"1.5e-6",
			"1e-7",
			"1.5e-7",
			"-2.5e-9",
			"1e20",
			"147573952589676412928.0",
			"123456789012345683968",
			"1e21",
			"1.5e21",
			"1.7976931348623157e308",
			"5e-324",
			"2.2250738585072014e-308",
			"100",
			"-100",
			"9007199254740992",
			"9007199254740993",
			"-9007199254740993",
			"18446744073709551615",
			"-9223372036854775808",
		];
		expectParity(`[${values.map((v, i) => `{"cmc":${v},"name":"n${i}"}`).join(",")}]`);
	});

	test("nesting: objects, arrays, empties, and array-index keys a parsed object lists first", () => {
		expectParity(
			JSON.stringify([
				{
					card_faces: [{ mana_cost: "{1}{U}", name: "Fire" }, { name: "Ice" }],
					colors: ["R", "U"],
					legalities: { commander: "legal", modern: "not_legal", vintage: "restricted" },
					nothing: [],
					odd: { "10": 1, "9": 2, a: { "0": [], "01": {} } },
				},
				{ card_faces: null, colors: [], legalities: {}, nothing: [[], [[]]], odd: null },
			]),
		);
	});

	test("strings: astral characters, U+2028/U+2029, quotes, backslashes and every control escape", () => {
		const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("");
		expectParity(
			JSON.stringify([
				{ flavor: "🐉 Æther “quoted” \u2028line\u2029para", name: 'He said "no" \\ then </script>' },
				{ flavor: controls, name: "\u007f\u0080\uffff" },
				{ flavor: "", name: "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 ᚠ" },
			]),
		);
	});

	test("nulls and booleans", () => {
		expectParity('[{"a":null,"b":true,"c":false},{"a":false,"b":null,"c":true}]');
	});

	test("zero rows is {} (and [] as rows)", () => {
		const got = bothWays("[]");
		expect(got.reference).toBe("{}");
		expect(got.columns).toBe("{}");
		expect(got.rows).toBe("[]");
	});

	test("rows with no fields are {} too", () => {
		expectParity("[{},{}]");
	});
});

describe("JavaScript's number spelling, against JSON.stringify itself", () => {
	// Fed by BITS through a Float64Array: a JSON round trip into the engine would let serde_json's
	// best-effort float parse move the value under test.
	function expectSpelled(values: Float64Array): void {
		expect(engine.use((g) => g.js_spelled_numbers(values))).toBe(JSON.stringify(Array.from(values)));
	}

	test("NaN and the infinities are null, -0 is 0", () => {
		expectSpelled(new Float64Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0]));
	});

	test("100,000 doubles drawn from random bit patterns", () => {
		// A fixed xorshift seed, so a failure reproduces.
		let s = 0x9e3779b97f4a7c15n;
		const next = () => {
			s ^= (s << 13n) & 0xffff_ffff_ffff_ffffn;
			s ^= s >> 7n;
			s ^= (s << 17n) & 0xffff_ffff_ffff_ffffn;
			return s;
		};
		const bits = new BigUint64Array(100_000);
		for (let i = 0; i < bits.length; i++) bits[i] = next();
		expectSpelled(new Float64Array(bits.buffer));
	});

	test("decimals a card actually carries, and every power of ten across both thresholds", () => {
		const values: number[] = [];
		for (let i = 0; i <= 2000; i++) values.push(i / 4, i / 100, i * 0.1, -i / 3);
		for (let e = -330; e <= 310; e++) values.push(10 ** e, 1.5 * 10 ** e, 2 ** (e / 3));
		expectSpelled(new Float64Array(values));
	});
});

describe("assembleColumnar refuses frames that do not fit the keys", () => {
	const frame = (row: Record<string, unknown>, keys: string[]) => columnsFrameOf(row, keys);

	test("a field count that disagrees with the keys", () => {
		expect(() => assembleColumnar(["a", "b"], [frame({ a: 1 }, ["a"])])).toThrow(/carries 1 fields/);
	});

	test("a truncated or over-long frame", () => {
		const good = frame({ a: "xyz" }, ["a"]);
		expect(() => assembleColumnar(["a"], [good.subarray(0, good.byteLength - 1)])).toThrow(/truncated/);
		const long = new Uint8Array(good.byteLength + 1);
		long.set(good);
		expect(() => assembleColumnar(["a"], [long])).toThrow(/trailing/);
	});

	test("columnKeys is the distinct fields, sorted — the engine row's key order", () => {
		expect(columnKeys(["name", "cmc", "name", "type_line", "cmc"])).toEqual(["cmc", "name", "type_line"]);
	});
});
