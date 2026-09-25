// g1's nightly probe driver: bounded, never throwing, and an unanswered probe is simply absent.

import { describe, expect, mock, test } from "bun:test";

// The class file extends DurableObject; the driver under test never constructs one.
mock.module("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

const { probeHints, PROBES_PER_HINT } = await import("../../src/engine/placement-probe");

function namespace(answer: (hint: string, i: number) => Promise<{ colo: string | null }>) {
	const created: string[] = [];
	return {
		created,
		newUniqueId: () => ({}),
		get: (_id: unknown, options?: { locationHint?: string }) => {
			const hint = options?.locationHint ?? "";
			const i = created.filter((h) => h === hint).length;
			created.push(hint);
			return { where: () => answer(hint, i) };
		},
	};
}

describe("probeHints", () => {
	test("creates PROBES_PER_HINT objects per hint, each hinted, and collects their colos", async () => {
		const ns = namespace(async (hint, i) => ({ colo: `${hint.toUpperCase()}${i}` }));
		const out = await probeHints({ PLACEMENT_PROBE: ns }, ["wnam", "sam"]);
		expect(PROBES_PER_HINT).toBe(4);
		expect(ns.created.sort()).toEqual(["sam", "sam", "sam", "sam", "wnam", "wnam", "wnam", "wnam"]);
		expect(out.wnam?.sort()).toEqual(["WNAM0", "WNAM1", "WNAM2", "WNAM3"]);
		expect(out.sam).toHaveLength(4);
	});

	test("a probe that fails, answers null or never answers is absent — and the night still ends", async () => {
		const ns = namespace(async (hint, i) => {
			if (hint === "me") throw new Error("unreachable");
			if (i === 0) return { colo: null };
			if (i === 1) return new Promise(() => {}); // hangs forever
			return { colo: "FRA" };
		});
		const out = await probeHints({ PLACEMENT_PROBE: ns }, ["eeur", "me"], 4, 20);
		expect(out.eeur).toEqual(["FRA", "FRA"]);
		expect(out.me).toBeUndefined();
	});

	test("a deployment without the binding probes nothing", async () => {
		expect(await probeHints({}, ["wnam"])).toEqual({});
	});
});
