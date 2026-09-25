// The one-time sweep of the colo-era engine objects (backlog c1, part b).
//
// Eleven SearchEngine objects from before engines were named by region (engine-LAX, engine-LAX-1…7,
// engine-BOS, engine-EWR, engine-PDX) still hold their cached store — an estimated 1.2–1.4 GB of
// DeckGen's 5 GB pool — and nothing announces them, so the notify phase's retirement never reaches
// them. The sweep reaches them by name, gated by RETIRED_ENGINE_SWEEP. What must hold:
//   - unset means nothing: no object addressed, no record read;
//   - "dry-run" only measures, and measuring writes nothing — addressing a name an account never had
//     instantiates it, so the measurement must not be what gives it storage;
//   - "release" runs deleteAll only on the objects that actually hold something;
//   - each value runs once, not every night the var is still set.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEngineName } from "../../src/engine/engine-namespace";
import {
	RETIRED_COLO_ENGINE_NAMES,
	RETIRED_HOLDING_BYTES,
	type RetiredSweepRecord,
	retiredSweepMode,
	sweepRetiredEngines,
} from "../../src/engine/retired-engine-sweep";

/** DeckGen as inventoried: every LAX shard holds a cache; the free account never had BOS or PDX. */
function fleet(initial: Record<string, number> = {}) {
	const bytes = new Map<string, number>(Object.entries(initial));
	const calls: string[] = [];
	let record: RetiredSweepRecord | undefined;
	let recordReads = 0;
	const lines: string[] = [];
	const warnings: string[] = [];
	return {
		bytes,
		calls,
		lines,
		warnings,
		recordReads: () => recordReads,
		record: () => record,
		/** One notify: what the coordinator does around the helper. */
		async notify(setting: string | undefined, overrides: { failFootprint?: string } = {}) {
			const done = await sweepRetiredEngines({
				setting,
				lastDone: async () => {
					recordReads += 1;
					return record;
				},
				footprint: async (name) => {
					calls.push(`footprint ${name}`);
					if (name === overrides.failFootprint) throw new Error("object reset");
					// A name that never existed answers from an empty instance and gains nothing.
					return bytes.get(name) ?? 0;
				},
				release: async (name) => {
					calls.push(`release ${name}`);
					bytes.set(name, 4096);
				},
				now: () => new Date("2026-09-26T11:40:00Z"),
				log: (line) => lines.push(line),
				warn: (line) => warnings.push(line),
			});
			if (done) record = done;
			return done;
		},
	};
}

const DECKGEN = {
	"engine-LAX": 140_000_000,
	"engine-LAX-1": 120_000_000,
	"engine-LAX-2": 118_000_000,
	"engine-LAX-3": 117_000_000,
	"engine-LAX-4": 116_000_000,
	"engine-LAX-5": 115_000_000,
	"engine-LAX-6": 114_000_000,
	"engine-LAX-7": 113_000_000,
	"engine-BOS": 110_000_000,
	"engine-EWR": 8192,
	"engine-PDX": 105_000_000,
};

describe("RETIRED_ENGINE_SWEEP: the three states", () => {
	test("unset, empty or blank: no object addressed and not even the record read", async () => {
		for (const setting of [undefined, "", "  "]) {
			const f = fleet(DECKGEN);
			expect(await f.notify(setting)).toBeNull();
			expect(f.calls).toEqual([]);
			expect(f.recordReads()).toBe(0);
			expect(f.lines).toEqual([]);
			expect(f.warnings).toEqual([]);
		}
	});

	test("an unrecognised value is off, and says so", async () => {
		for (const setting of ["true", "Release", "dryrun", "1"]) {
			const f = fleet(DECKGEN);
			expect(await f.notify(setting)).toBeNull();
			expect(f.calls).toEqual([]);
			expect(f.warnings[0]).toContain(`RETIRED_ENGINE_SWEEP="${setting}"`);
		}
		expect(retiredSweepMode(" dry-run ")).toBe("dry-run");
	});

	test("dry-run measures all eleven, logs every size, and releases nothing", async () => {
		const f = fleet(DECKGEN);
		const done = await f.notify("dry-run");
		expect(f.calls).toEqual(RETIRED_COLO_ENGINE_NAMES.map((n) => `footprint ${n}`));
		expect(f.calls.some((c) => c.startsWith("release"))).toBe(false);
		expect(Object.fromEntries(f.bytes)).toEqual(DECKGEN);
		expect(done?.mode).toBe("dry-run");
		expect(done?.bytes).toEqual(DECKGEN);
		expect(f.lines[0]).toContain("10/11 colo-era object(s) hold 1168.0MB");
		for (const [name, n] of Object.entries(DECKGEN)) expect(f.lines[0]).toContain(`${name}=${n}`);
	});

	test("release runs deleteAll only on objects above the threshold, and reads back what is left", async () => {
		const f = fleet(DECKGEN);
		const done = await f.notify("release");
		const released = f.calls.filter((c) => c.startsWith("release")).map((c) => c.slice("release ".length));
		expect(released.sort()).toEqual(
			Object.entries(DECKGEN)
				.filter(([, n]) => n > RETIRED_HOLDING_BYTES)
				.map(([name]) => name)
				.sort(),
		);
		expect(released).not.toContain("engine-EWR");
		// Measured, released, then measured again — never released before it was measured.
		for (const name of released) {
			expect(f.calls.indexOf(`footprint ${name}`)).toBeLessThan(f.calls.indexOf(`release ${name}`));
			expect(f.calls.lastIndexOf(`footprint ${name}`)).toBeGreaterThan(f.calls.indexOf(`release ${name}`));
		}
		expect(done?.released?.length).toBe(10);
		expect(done?.freedBytes).toBe(1_168_000_000 - 10 * 4096);
		expect(f.lines[1]).toContain("deleteAll on 10/10 object(s) freed");
	});

	test("the free account's shape: one holder, names it never had stay unreleased", async () => {
		const f = fleet({ "engine-LAX": 130_000_000 });
		await f.notify("release");
		expect(f.calls.filter((c) => c.startsWith("release"))).toEqual(["release engine-LAX"]);
		expect([...f.bytes.keys()]).toEqual(["engine-LAX"]);
	});
});

describe("RETIRED_ENGINE_SWEEP: never twice", () => {
	test("a value that finished addresses no object on the next nightly", async () => {
		const f = fleet(DECKGEN);
		await f.notify("dry-run");
		f.calls.length = 0;
		expect(await f.notify("dry-run")).toBeNull();
		expect(f.calls).toEqual([]);
		expect(f.lines.at(-1)).toContain("already finished 2026-09-26T11:40:00.000Z");

		await f.notify("release");
		expect(f.calls.filter((c) => c.startsWith("release")).length).toBe(10);
		f.calls.length = 0;
		expect(await f.notify("release")).toBeNull();
		expect(await f.notify("release")).toBeNull();
		expect(f.calls).toEqual([]);
		expect(f.record()?.mode).toBe("release");
	});

	test("a dry run after the release is allowed once, and finds nothing left", async () => {
		const f = fleet(DECKGEN);
		await f.notify("release");
		f.calls.length = 0;
		const verify = await f.notify("dry-run");
		expect(f.calls.every((c) => c.startsWith("footprint"))).toBe(true);
		expect(f.lines.at(-1)).toContain("0/11 colo-era object(s) hold 0.0MB above 1.0MB — nothing left to release");
		expect(verify?.mode).toBe("dry-run");
	});

	test("a failed call is not recorded, so the next publish runs the value again", async () => {
		const f = fleet(DECKGEN);
		expect(await f.notify("dry-run", { failFootprint: "engine-LAX-3" })).toBeNull();
		expect(f.warnings[0]).toContain("engine-LAX-3: Error: object reset");
		expect(f.record()).toBeUndefined();
		f.calls.length = 0;
		expect((await f.notify("dry-run"))?.mode).toBe("dry-run");
		expect(f.calls.length).toBe(11);
	});
});

describe("the colo-era names", () => {
	test("none is a name any request or announcement produces", () => {
		expect(RETIRED_COLO_ENGINE_NAMES.length).toBe(11);
		for (const name of RETIRED_COLO_ENGINE_NAMES) expect(parseEngineName(name)).toBeNull();
	});

	test("they are addressed the way the colo era created them: idFromName, no hint", () => {
		// The colo era's call (6f34fd43…acd533d6): env.SEARCH_ENGINE.get(env.SEARCH_ENGINE.idFromName(name)).
		const ns = readFileSync(join(import.meta.dir, "../../src/engine/engine-namespace.ts"), "utf8");
		expect(ns).toContain("return env.SEARCH_ENGINE.get(env.SEARCH_ENGINE.idFromName(name));");
		const src = readFileSync(join(import.meta.dir, "../../src/import-coordinator.ts"), "utf8");
		const sweep = src.slice(src.indexOf("private async sweepRetiredColoEngines("));
		expect(sweep.slice(0, 600)).toContain("addressAnnouncedEngine(this.env, name)");
		// Wired from exactly one place in notify, and before the early return for "nothing live".
		const notify = src.slice(src.indexOf("private async stepNotify("));
		expect(src.split("this.sweepRetiredColoEngines()").length).toBe(2);
		expect(notify.indexOf("this.sweepRetiredColoEngines()")).toBeLessThan(notify.indexOf("if (live.length === 0)"));
	});
});

// ── storageFootprint writes nothing ───────────────────────────────────────────
//
// Addressing a name instantiates it, so a dry run over names an account never had must leave them
// exactly as instantiation alone would. Pinned at the source rather than by constructing the class:
// importing search-engine-do pulls in store.ts, and the mocks that would make it importable here are
// process-global in bun, so they would reach other suites in whatever order the files happen to run.
// The import harness (bun run harness:import) runs the REAL class against real SQLite, and a local
// workerd probe measured it (see the method's comment).

describe("SearchEngine.storageFootprint", () => {
	const src = readFileSync(join(import.meta.dir, "../../src/engine/search-engine-do.ts"), "utf8");
	const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

	test("reads databaseSize and nothing else", () => {
		const start = code.indexOf("async storageFootprint(");
		expect(start).toBeGreaterThan(-1);
		const open = code.indexOf("> {\n", start) + 3;
		const body = code.slice(open, code.indexOf("\n\t}", start)).trim();
		expect(body).toBe("return { label: this.label, bytes: this.ctx.storage.sql.databaseSize };");
	});

	test("instantiating a SearchEngine runs no storage code: no constructor, no blockConcurrencyWhile", () => {
		const cls = code.slice(code.indexOf("export class SearchEngine extends DurableObject"));
		expect(cls.length).toBeGreaterThan(1000);
		expect(cls).not.toMatch(/\bconstructor\s*\(/);
		expect(cls).not.toContain("blockConcurrencyWhile");
		// Field initialisers are in-memory only: none of them reaches ctx.
		const fields = cls.match(/^\t(?:private |readonly |public )*[a-zA-Z]+\s*(?::[^=;]+)?=\s*[^;]+;/gm) ?? [];
		expect(fields.length).toBeGreaterThan(3);
		for (const field of fields) expect(field).not.toContain("ctx");
	});
});
