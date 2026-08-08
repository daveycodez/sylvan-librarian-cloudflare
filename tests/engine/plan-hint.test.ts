// Plan-aware shard cap: the mapping from observed plan evidence to the cap.

import { describe, expect, test } from "bun:test";
import { capForPlan } from "../../src/engine/plan-hint";

describe("capForPlan", () => {
	test("free disables sharding", () => {
		expect(capForPlan("free")).toBe(1);
	});
	test("paid gets the full default cap", () => {
		expect(capForPlan("paid")).toBe(8);
	});
	test("no evidence yet is conservative", () => {
		expect(capForPlan(null)).toBe(2);
		expect(capForPlan(undefined)).toBe(2);
		expect(capForPlan("garbage")).toBe(2);
	});
});
