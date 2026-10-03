// A load kept in module state belongs to the request that began it (src/engine/shared-load.ts): if
// that request is cancelled the promise never settles, and whoever awaits it waits for as long as
// its own client does — two /cards/search requests on DeckGen 2026-10-03, 100s each, then a 524.
// A joiner therefore waits on its OWN clock. The runtime half of this (a cancelled request's read
// never settling, and the runtime not noticing the hang) was measured in workerd; what is pinned
// here is that the join gives up when the clock says so.

import { describe, expect, test } from "bun:test";
import { settledWithin } from "../../src/engine/shared-load";

const never = <T>() => new Promise<T>(() => {});

describe("settledWithin", () => {
	test("a load that settles in the window is its value, wrapped so that undefined and null are answers too", async () => {
		expect(await settledWithin(Promise.resolve(7), 50)).toEqual({ value: 7 });
		expect(await settledWithin(Promise.resolve(null), 50)).toEqual({ value: null });
		const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late but inside"), 10));
		expect(await settledWithin(slow, 200)).toEqual({ value: "late but inside" });
	});

	test("a load that never settles is given up on when the window closes — the cancelled owner", async () => {
		const started = Date.now();
		expect(await settledWithin(never<number>(), 30)).toBeNull();
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(25);
		expect(waited).toBeLessThan(1_000);
	});

	test("a failure inside the window is the joiner's failure, as awaiting it would be", async () => {
		await expect(settledWithin(Promise.reject(new Error("partition down")), 50)).rejects.toThrow("partition down");
	});

	test("a failure after the window is nobody's here: the joiner already has its null", async () => {
		let fail: (err: Error) => void = () => {};
		const shared = new Promise<number>((_, reject) => {
			fail = reject;
		});
		expect(await settledWithin(shared, 10)).toBeNull();
		// Were this unhandled, bun would fail the test run on it.
		fail(new Error("too late to matter"));
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
});
