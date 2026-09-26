// `bun run gate` runs the import in-process through engine/wasm-import/driver.ts, whose `emit`
// switch throws on a kind it does not know. CI never runs that gate step, so when n8 (66b63506)
// added EMIT_NAMES = 13 to the crate the gate failed with "unknown emit kind 13" and nothing
// noticed. This test runs in CI and ties the two lists together: every `const EMIT_*: u32 = N` the
// crate declares must be a key of the driver's EMIT table with the same number, and the driver must
// declare nothing the crate does not.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** `const EMIT_NAME: u32 = N;` from the crate, as { NAME: N }. */
function crateEmitKinds(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const m of read("engine/wasm-import/src/lib.rs").matchAll(/^const EMIT_([A-Z_]+): u32 = (\d+);/gm)) {
		out[m[1] as string] = Number(m[2]);
	}
	return out;
}

/** The driver's `const EMIT = { NAME: N, … } as const;`, as { NAME: N }. */
function driverEmitKinds(): Record<string, number> {
	const table = /const EMIT = \{([^}]*)\} as const;/.exec(read("engine/wasm-import/driver.ts"));
	if (!table) throw new Error("driver.ts has no `const EMIT = { … } as const;` table");
	const out: Record<string, number> = {};
	for (const m of (table[1] as string).matchAll(/([A-Z_]+):\s*(\d+)/g)) out[m[1] as string] = Number(m[2]);
	return out;
}

describe("the wasm-import driver's EMIT table", () => {
	test("names every emit kind the crate declares, with the same number", () => {
		const crate = crateEmitKinds();
		expect(Object.keys(crate).length).toBeGreaterThanOrEqual(13);
		expect(driverEmitKinds()).toEqual(crate);
	});

	test("every kind reaches a case of the emit switch, not the throwing default", () => {
		const driver = read("engine/wasm-import/driver.ts");
		for (const name of Object.keys(driverEmitKinds())) expect(driver).toContain(`case EMIT.${name}:`);
	});
});
