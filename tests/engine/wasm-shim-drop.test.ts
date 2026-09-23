// The shim cannot be instantiated in bun (its `.wasm` import resolves only under wrangler's
// CompiledWasm rule), so the one invariant of a dropped instance is pinned on the source: the
// dropped instance's memory is DETACHED. wasm-bindgen's glue caches a view of the bound memory and
// rebuilds it only when that view's byteLength is 0; a drop that skipped the detach left the next
// instance — this label's or a sibling's in the same isolate — marshalling every argument through
// the dead instance's buffer, so every reload failed on garbage and the recovery never succeeded.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "../../src/engine/wasm-shim.ts"), "utf8");

describe("dropping a wasm instance", () => {
	test("detaches its memory before the next instance is bound, exactly as bindTo does for an outgoing one", () => {
		const drop = src.slice(src.indexOf("function dropInstance("), src.indexOf("function instantiate("));
		expect(drop).toContain("dropped.memory?.grow(0);");
		expect(drop.indexOf("dropped.memory?.grow(0);")).toBeLessThan(drop.indexOf("if (bound === label) bound = null;"));
		const bind = src.slice(src.indexOf("function bindTo("), src.indexOf("export function ensureEngine("));
		expect(bind).toContain("instances.get(bound)?.memory?.grow(0);");
	});
});
