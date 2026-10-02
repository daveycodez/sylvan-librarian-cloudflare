// RemoteEngine.scryfallNamedFuzzyPlan picks the plan's fields out of the object's reply by name, so
// the telemetry riders stay behind. x24 added `printed` without naming it there, and every
// `cards/named fuzzy:` line in production logged `printed=-`, including plans the printed-names
// blob decided. These pin every field the plan carries across the RPC.

import { describe, expect, test } from "bun:test";
import { RemoteEngine } from "../../src/engine/remote-engine";

const reply = (extra: Record<string, unknown>) => ({
	scryfallNamedFuzzyPlan: async () => ({
		partitions: [3],
		everywhere: false,
		stage: "miss",
		builtAt: "1790419993",
		...extra,
	}),
});

describe("RemoteEngine.scryfallNamedFuzzyPlan", () => {
	test("carries the printed-names verdict", async () => {
		for (const printed of ["hit", "miss", "absent"] as const) {
			const plan = await new RemoteEngine(reply({ printed }) as never, "wnam").scryfallNamedFuzzyPlan("x", ["x"]);
			expect(plan.printed).toBe(printed);
		}
	});

	test("carries the bundle, and leaves out what the object did not send", async () => {
		const bundle = { partition: 3 } as never;
		const withBundle = await new RemoteEngine(reply({ bundle }) as never, "wnam").scryfallNamedFuzzyPlan("x", ["x"]);
		expect(withBundle).toEqual({ partitions: [3], everywhere: false, stage: "miss", builtAt: "1790419993", bundle });
		const bare = await new RemoteEngine(reply({}) as never, "wnam").scryfallNamedFuzzyPlan("x", ["x"]);
		expect(bare).toEqual({ partitions: [3], everywhere: false, stage: "miss", builtAt: "1790419993" });
		expect("printed" in bare).toBe(false);
	});
});

describe("RemoteEngine.scryfallNamedFuzzyRouted (x48)", () => {
	const bundle = { exact: { rank: null, present: false, card: null } } as never;
	const riders = { acquireMs: 0, load: 1, rate: 2, shards: 1 };

	test("carries the bundle and every field of the plan beside it, the riders left behind", async () => {
		const plan = { partitions: [], everywhere: false, stage: "miss", builtAt: "1790419993", printed: "miss" };
		const stub = { scryfallNamedFuzzyRouted: async () => ({ bundle, plan, ...riders }) };
		const got = await new RemoteEngine(stub as never, "wnam").scryfallNamedFuzzyRouted("x", ["x"], 2, "https://x");
		expect(got).toEqual({ bundle, plan } as never);
	});

	test("a ranked bundle comes back with no plan", async () => {
		const stub = { scryfallNamedFuzzyRouted: async () => ({ bundle, plan: null, ...riders }) };
		const got = await new RemoteEngine(stub as never, "wnam").scryfallNamedFuzzyRouted("x", ["x"], 2, "https://x");
		expect(got).toEqual({ bundle, plan: null });
	});

	test("an object on the build before it fails the call, for the router to ask as it did", async () => {
		const stub = {
			scryfallNamedFuzzyRouted: async () => {
				throw new Error('The RPC receiver does not implement the method "scryfallNamedFuzzyRouted".');
			},
		};
		await expect(
			new RemoteEngine(stub as never, "wnam").scryfallNamedFuzzyRouted("x", ["x"], 2, "https://x"),
		).rejects.toThrow("does not implement");
	});
});
