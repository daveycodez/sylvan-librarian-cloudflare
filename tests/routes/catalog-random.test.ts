// get_catalog (Kindred→Tribal alias, lowercased keywords, sorted keys, 503
// when unloaded) and random_search (clamp, no-store, columnar).

import { describe, expect, test } from "bun:test";
import { FakeEngine, json, makeCtx, testDispatch } from "./harness";

describe("get_catalog", () => {
	test("aliases Kindred to Tribal, lowercases keywords, sorts keys, caches 1h", async () => {
		const res = await testDispatch(makeCtx(), "/get_catalog");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
		const body = await json(res);
		expect(Object.keys(body)).toEqual(["types", "keywords"]);
		expect(body.types).toEqual({ Creature: 100, Kindred: 5, Land: 42, Tribal: 5 });
		expect(Object.keys(body.types as object)).toEqual(["Creature", "Kindred", "Land", "Tribal"]);
		expect(body.keywords).toEqual({ flying: 10, haste: 3 });
		expect(Object.keys(body.keywords as object)).toEqual(["flying", "haste"]);
	});

	test("no Tribal alias when the engine reports no Kindred", async () => {
		const engine = new FakeEngine();
		engine.types = { Creature: 7 };
		const body = await json(await testDispatch(makeCtx({ engine }), "/get_catalog"));
		expect(body.types).toEqual({ Creature: 7 });
	});

	test("unloaded engine answers upstream's exact 503", async () => {
		const res = await testDispatch(makeCtx({ engine: null }), "/get_catalog");
		expect(res.status).toBe(503);
		expect(await json(res)).toEqual({
			title: "Service Unavailable",
			description: "Engine is not loaded, please try again later.",
		});
	});
});

describe("random_search", () => {
	test("returns the search-shaped envelope with no-store", async () => {
		const engine = new FakeEngine();
		const res = await testDispatch(makeCtx({ engine }), "/random_search?num_cards=2");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const body = await json(res);
		expect(Object.keys(body)).toEqual(["cards", "total_cards"]);
		expect((body.cards as unknown[]).length).toBe(2);
		expect(body.total_cards).toBe(2);
		expect(engine.lastSampleArgs?.numCards).toBe(2);
	});

	test("num_cards clamps to 1..1000", async () => {
		const engine = new FakeEngine();
		await testDispatch(makeCtx({ engine }), "/random_search?num_cards=5000");
		expect(engine.lastSampleArgs?.numCards).toBe(1000);
		await testDispatch(makeCtx({ engine }), "/random_search?num_cards=-3");
		expect(engine.lastSampleArgs?.numCards).toBe(1);
		await testDispatch(makeCtx({ engine }), "/random_search");
		expect(engine.lastSampleArgs?.numCards).toBe(1);
	});

	test("non-integer num_cards is a coercion 400", async () => {
		const res = await testDispatch(makeCtx(), "/random_search?num_cards=lots");
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({
			title: "Invalid Parameter",
			description: "Invalid value for 'num_cards': 'lots' (expected int)",
		});
	});

	test("columnar shape inverts the sampled cards", async () => {
		const body = await json(await testDispatch(makeCtx(), "/random_search?num_cards=2&shape=columnar"));
		const columns = body.cards as Record<string, unknown[]>;
		expect(columns.name).toEqual(["Llanowar Elves", "Elvish Mystic"]);
		expect(body.total_cards).toBe(2);
	});

	test("unloaded engine is a 503 (deviation: upstream returns an empty list mid-load)", async () => {
		const res = await testDispatch(makeCtx({ engine: null }), "/random_search");
		expect(res.status).toBe(503);
	});
});
