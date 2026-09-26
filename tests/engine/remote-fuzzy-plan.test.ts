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
