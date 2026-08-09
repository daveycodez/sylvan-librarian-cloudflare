// firstToSucceed is what lets a cold colo ask its own store load and the
// region's warm one at the same time, so the pathological cases are the point:
// a regional DO that is unreachable must not fail a request this colo could
// have answered, and a loser that rejects late must not surface anywhere.

import { describe, expect, test } from "bun:test";
import { firstToSucceed } from "../../src/engine/first-to-succeed";

const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const failsAfter = (ms: number, err: Error): Promise<never> =>
	new Promise((_, reject) => setTimeout(() => reject(err), ms));

describe("firstToSucceed", () => {
	test("returns the first to resolve, whichever argument it was", async () => {
		expect(await firstToSucceed(after(40, "slow"), after(1, "fast"))).toBe("fast");
		expect(await firstToSucceed(after(1, "fast"), after(40, "slow"))).toBe("fast");
	});

	test("a rejection does not settle the race while another attempt is alive", async () => {
		// The case this exists for: the region is unreachable, the local load is
		// still running. Promise.race would reject here.
		expect(await firstToSucceed(failsAfter(1, new Error("region unreachable")), after(20, "local"))).toBe("local");
	});

	test("rejects only when every attempt has failed, with the first error", async () => {
		const first = new Error("first");
		const second = new Error("second");
		expect(firstToSucceed(failsAfter(1, first), failsAfter(20, second))).rejects.toThrow("first");
	});

	test("a loser rejecting after the winner resolves is swallowed, not thrown", async () => {
		// No handler of ours would catch this: it settles after the caller has
		// already been given an answer, so it can only surface as an unhandled
		// rejection. Verified by letting it fire well after the winner returns.
		const unhandled: unknown[] = [];
		const onUnhandled = (e: Event) => unhandled.push((e as Event & { reason?: unknown }).reason);
		globalThis.addEventListener?.("unhandledrejection", onUnhandled);

		expect(await firstToSucceed(after(1, "winner"), failsAfter(15, new Error("late loser")))).toBe("winner");
		await after(40, null);

		globalThis.removeEventListener?.("unhandledrejection", onUnhandled);
		expect(unhandled).toEqual([]);
	});

	test("a single attempt still works, and an empty call is a bug", async () => {
		expect(await firstToSucceed(after(1, "only"))).toBe("only");
		expect(firstToSucceed<never>()).rejects.toThrow(/at least one/);
	});
});
