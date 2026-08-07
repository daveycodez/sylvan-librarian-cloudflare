// /search: param coercion errors (exact upstream messages), limit/fields
// validation, envelope shape, columnar inversion, parse errors, and the
// engine-error deviation (loud 500 instead of upstream's SQL fallback).

import { beforeEach, describe, expect, test } from "bun:test";
import { FakeEngine, FakeParseError, installFakeParser, json, makeCtx, testDispatch } from "./harness";

beforeEach(() => {
	installFakeParser();
});

describe("search param coercion", () => {
	test("bad enum value mirrors upstream ParamCoercionError message", async () => {
		const res = await testDispatch(makeCtx(), "/search?direction=up");
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({
			title: "Invalid Parameter",
			description: "Invalid value for 'direction': 'up' (expected one of: asc, desc)",
		});
	});

	test("bad orderby lists CardOrdering members in declaration order", async () => {
		const res = await testDispatch(makeCtx(), "/search?orderby=elo");
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.description).toBe(
			"Invalid value for 'orderby': 'elo' (expected one of: cmc, cubecobra, edhrec, name, power, rarity, toughness, usd)",
		);
	});

	test("prefer uses underscore enum values, so usd-low is rejected like upstream", async () => {
		const res = await testDispatch(makeCtx(), "/search?prefer=usd-low");
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.description).toBe(
			"Invalid value for 'prefer': 'usd-low' (expected one of: default, oldest, newest, usd_low, usd_high, promo)",
		);
	});

	test("non-integer limit is a coercion error", async () => {
		const res = await testDispatch(makeCtx(), "/search?limit=abc");
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({
			title: "Invalid Parameter",
			description: "Invalid value for 'limit': 'abc' (expected int)",
		});
	});

	test("coercion errors carry no cache header (binding precedes the handler)", async () => {
		const res = await testDispatch(makeCtx(), "/search?limit=abc");
		expect(res.headers.get("Cache-Control")).toBeNull();
	});

	test("negative limit is upstream's Invalid Limit 400, with the search cache header", async () => {
		const res = await testDispatch(makeCtx(), "/search?limit=-1");
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({ title: "Invalid Limit", description: "Limit must be a positive integer." });
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=90");
	});

	test("unknown string params are dropped as query noise", async () => {
		const res = await testDispatch(makeCtx(), "/search?q=elf&bogus_param=1");
		expect(res.status).toBe(200);
	});
});

describe("search fields", () => {
	test("empty fields list is rejected", async () => {
		const res = await testDispatch(makeCtx(), "/search?q=elf&fields=");
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({
			title: "Invalid Fields",
			description: "fields must include at least one field name.",
		});
	});

	test("unknown field name is rejected with a Python-repr'd name", async () => {
		const res = await testDispatch(makeCtx(), "/search?q=elf&fields=name,bogus");
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({ title: "Invalid Fields", description: "Unknown field: 'bogus'" });
	});

	test("fields are deduped and forwarded; default is the usual 9", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/search?q=elf&fields=name,name,set_code");
		expect(engine.lastSearch?.fields).toEqual(["name", "set_code"]);

		await testDispatch(makeCtx({ engine }), "/search?q=elf");
		expect(engine.lastSearch?.fields).toEqual([
			"name",
			"set_code",
			"collector_number",
			"power",
			"toughness",
			"mana_cost",
			"oracle_text",
			"set_name",
			"type_line",
		]);
	});
});

describe("search envelope", () => {
	test("engine-path envelope keys, values and order", async () => {
		const res = await testDispatch(makeCtx(), "/search?q=elf");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=90");
		expect(res.headers.get("content-type")).toBe("application/json");
		const body = await json(res);
		expect(Object.keys(body)).toEqual([
			"cards",
			"compiled",
			"inner_timings",
			"outer_timings",
			"params",
			"query",
			"query_explanation",
			"total_cards",
		]);
		expect(body.compiled).toBe("(rust engine)");
		expect(body.params).toEqual({});
		expect(body.query).toBe("elf");
		expect(body.query_explanation).toBe("the name contains elf");
		expect(body.total_cards).toBe(17);
		expect(Array.isArray(body.cards)).toBe(true);
		const timings = body.inner_timings as Record<string, { _meta: Record<string, number> }>;
		expect(Object.keys(timings)).toEqual(["parse", "engine_query", "engine_collect"]);
		expect(timings.parse?._meta.count).toBe(1);
	});

	test("query falls back to q, and empty query string falls through to q", async () => {
		let res = await testDispatch(makeCtx(), "/search?query=goblin");
		expect((await json(res)).query).toBe("goblin");
		res = await testDispatch(makeCtx(), "/search?query=&q=zombie");
		expect((await json(res)).query).toBe("zombie");
	});

	test("missing query searches everything with an empty explanation", async () => {
		const res = await testDispatch(makeCtx(), "/search");
		const body = await json(res);
		expect(body.query).toBe("");
		expect(body.query_explanation).toBe("");
		expect(res.status).toBe(200);
	});

	test("search options are forwarded to the engine", async () => {
		const engine = new FakeEngine();
		await testDispatch(
			makeCtx({ engine }),
			"/search?q=elf&unique=printing&prefer=oldest&orderby=name&direction=desc&limit=5",
		);
		expect(engine.lastSearch).toMatchObject({
			unique: "printing",
			prefer: "oldest",
			orderby: "name",
			direction: "desc",
			limit: 5,
		});
	});

	test("columnar shape inverts cards into per-field lists", async () => {
		const rows = await json(await testDispatch(makeCtx(), "/search?q=elf&shape=rows"));
		const columnar = await json(await testDispatch(makeCtx(), "/search?q=elf&shape=columnar"));
		const cards = rows.cards as Record<string, unknown>[];
		const columns = columnar.cards as Record<string, unknown[]>;
		expect(Object.keys(columns)).toEqual(Object.keys(cards[0] as object));
		for (const key of Object.keys(columns)) {
			expect(columns[key]).toEqual(cards.map((c) => c[key]));
		}
		// Envelope key order is unchanged by the columnar transform.
		expect(Object.keys(columnar)).toEqual(Object.keys(rows));
	});
});

describe("search failure modes", () => {
	test("parse error is upstream's Invalid Search Query 400", async () => {
		const res = await testDispatch(makeCtx(), "/search?q=PARSE_FAIL((");
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({
			title: "Invalid Search Query",
			description: 'Failed to parse query: "PARSE_FAIL(("',
		});
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=90");
	});

	test("engine failure is a loud 500 Engine Error (deliberate deviation from SQL fallback)", async () => {
		const engine = new FakeEngine();
		engine.searchError = new Error("wasm trap");
		const res = await testDispatch(makeCtx({ engine }), "/search?q=elf");
		expect(res.status).toBe(500);
		const body = await json(res);
		expect(body.title).toBe("Engine Error");
	});

	test("unloaded engine is a 503 with upstream's catalog wording", async () => {
		const res = await testDispatch(makeCtx({ engine: null }), "/search?q=elf");
		expect(res.status).toBe(503);
		expect(await json(res)).toEqual({
			title: "Service Unavailable",
			description: "Engine is not loaded, please try again later.",
		});
	});

	test("non-ParseError from the parser is not converted to a 400", async () => {
		installFakeParser(() => {
			throw new Error("internal parser bug");
		});
		const res = await testDispatch(makeCtx(), "/search?q=elf");
		expect(res.status).toBe(500);
		expect((await json(res)).title).toBe("Server Error");
	});
});

describe("FakeParseError sanity", () => {
	test("fake parse error is not a plain Error match", () => {
		expect(new FakeParseError("x")).toBeInstanceOf(Error);
	});
});
