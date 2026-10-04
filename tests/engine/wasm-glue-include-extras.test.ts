// THE COMMITTED wasm-bindgen GLUE MUST CALL THE COMMITTED WASM WITH ALL OF ITS ARGUMENTS.
//
// 2026-10-04: `include_extras` shipped end to end — route, partition client, Durable Object, store.ts,
// wasm shim, Rust — and had NO EFFECT in production. `engine/wasm/pkg` is a committed build artifact of
// FOUR files; the build commit carried the rebuilt `.wasm` and left the regenerated glue
// (`sylvan_engine_wasm_bg.js`, `sylvan_engine_wasm.d.ts`, `sylvan_engine_wasm_bg.wasm.d.ts`) behind. The
// committed wasm took `(prefix, limit, include_extras)`; the committed glue still called
// `wasm.autocomplete(ptr, len, limit)`, so the engine read `include_extras` as an argument nobody passed:
// zero, false, the default catalog, for `true`, `1`, `yes` and every other spelling.
//
// Nothing else could see it. The wasm-blob freshness test hashes the Rust sources against the committed
// `.wasm` only, and every other test that drives the real engine is opt-in (a built local store). A
// working tree where the glue had been regenerated and not yet committed — the one that wrote the commit —
// passed all of them.
//
// This runs the REAL committed glue against the REAL committed wasm, on every `bun test tests`, over a
// names blob of records the native builder wrote for the four Mechtitan cards (rows.jsonl, 2026-10-04:
// the token tneo/14 and its Secret Lair reversible printing sld/1969 have no served printing, which is
// what `include_extras` lifts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as bg from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";
import { encodeCardNames } from "../../src/engine/card-names";
import { newEngine } from "./wasm-engine";

const GLUE = join(import.meta.dir, "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js");
const WASM = join(import.meta.dir, "../../engine/wasm/pkg/sylvan_engine_wasm_bg.wasm");

/**
 * `store_name_records_tsv`'s lines for Mechtitan Core (neo/249, sld/1965), the Mechtitan token (tneo/14),
 * its reversible printing (sld/1969), and Treasure Keeper (a served card) with its art-series card
 * (aclb/26, "Treasure Keeper // Treasure Keeper"), led by partition 0 as the publishers lead them. The
 * flags are `<classes><best>`: `1f0` has a served printing (bit 4 of the classes), `1a0` and `1a3` have none.
 */
const RECORDS = [
	["0", "1f0", "treasurekeeper", "Treasure Keeper", "", "", ""],
	["0", "1a3", "treasurekeepertreasurekeeper", "Treasure Keeper // Treasure Keeper", "", "", ""],
	["0", "1a0", "mechtitan", "Mechtitan", "", "", ""],
	["0", "1a0", "mechtitanmechtitan", "Mechtitan // Mechtitan", "", "", ""],
	["0", "1f0", "mechtitancore", "Mechtitan Core", "", "", ""],
	["0", "1f0", "mechtitancoremechtitancore", "Mechtitan Core // Mechtitan Core", "", "", ""],
]
	.map((fields) => `${fields.join("\t")}\n`)
	.join("");

function engineWithNames() {
	const engine = newEngine();
	const raw = encodeCardNames([new TextEncoder().encode(RECORDS)]);
	expect(engine.use((g) => g.load_names(gzipSync(raw)))).toBe(6);
	expect(engine.use((g) => g.names_format())).toBe(2);
	return engine;
}

const answer = (engine: ReturnType<typeof newEngine>, prefix: string, includeExtras: boolean) =>
	JSON.parse(engine.use((g) => g.names_autocomplete(prefix, 20, includeExtras))) as string[];

describe("include_extras survives the wasm boundary", () => {
	test("names_autocomplete through the committed glue: the flag offers the token and the extra printing's name", () => {
		const engine = engineWithNames();
		// api.scryfall.com 2026-10-04: the default catalog and the flag's, for `mechtitan` and `treasure k`.
		expect(answer(engine, "mechtitan", false)).toEqual(["Mechtitan Core", "Mechtitan Core // Mechtitan Core"]);
		expect(answer(engine, "mechtitan", true)).toEqual([
			"Mechtitan",
			"Mechtitan // Mechtitan",
			"Mechtitan Core",
			"Mechtitan Core // Mechtitan Core",
		]);
		expect(answer(engine, "treasure k", false)).toEqual(["Treasure Keeper"]);
		expect(answer(engine, "treasure k", true)).toEqual(["Treasure Keeper", "Treasure Keeper // Treasure Keeper"]);
	});

	// The class of failure, not only this instance of it: a regenerated export whose glue was not
	// regenerated with it. Every export's declared arity is the number of arguments the glue's call to
	// it passes, so a signature that grew (or shrank) without its glue is a red test the same day.
	test("every wasm export is called by the committed glue with as many arguments as it declares", () => {
		const module = new (WebAssembly as unknown as { Module: new (b: ArrayBuffer) => WebAssembly.Module }).Module(
			readFileSync(WASM).buffer.slice(0) as ArrayBuffer,
		);
		const instance = new WebAssembly.Instance(module, { "./sylvan_engine_wasm_bg.js": bg });
		const exported = instance.exports as Record<string, unknown>;
		const calls = [...readFileSync(GLUE, "utf8").matchAll(/\bwasm\.(\w+)\(([^)]*)\)/g)];
		expect(calls.length).toBeGreaterThan(50);
		const wrong: string[] = [];
		for (const [, name, args] of calls) {
			const fn = exported[name as string];
			if (typeof fn !== "function") continue; // memory, tables and the like are read, not called
			const passed = (args as string).trim() === "" ? 0 : (args as string).split(",").length;
			if (passed !== fn.length) wrong.push(`${name}: glue passes ${passed}, wasm declares ${fn.length}`);
		}
		expect(
			wrong,
			"engine/wasm/pkg's glue was not regenerated with its .wasm — commit all of engine/wasm/pkg after `bun run build`",
		).toEqual([]);
	});
});
