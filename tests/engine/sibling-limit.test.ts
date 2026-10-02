// x44: a gather keeps at most six sibling calls outstanding, and a sibling call that dies says
// enough about its coordinator to tell why.
//
// DeckGen, 2026-09-29 → 10-02: 893 "failed transiently" lines in 195 one-millisecond bursts, each
// either the first k calls a coordinator issued or its last four — never a set a sibling's own
// eviction could pick. Both shapes need a call waiting in the runtime's six-connection queue; the
// limiter keeps the seventh call out of it. See src/engine/sibling-limit.ts.

import { describe, expect, spyOn, test } from "bun:test";
import { siblingCall } from "../../src/engine/remote-engine";
import { SIBLING_CALLS_AT_ONCE, SiblingLimiter, type SiblingLoad } from "../../src/engine/sibling-limit";

/** A task the test settles by hand. */
function gate<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the sibling limiter", () => {
	test("the limit is the runtime's six", () => {
		expect(SIBLING_CALLS_AT_ONCE).toBe(6);
	});

	test("six or fewer calls start synchronously, in the order asked — the fan-out x23 relies on", () => {
		const limiter = new SiblingLimiter();
		const started: number[] = [];
		for (let p = 0; p < 6; p++) {
			void limiter.run(() => {
				started.push(p);
				return new Promise(() => {});
			});
		}
		// No await has happened: every one of the six is already out.
		expect(started).toEqual([0, 1, 2, 3, 4, 5]);
		expect(limiter.open).toBe(6);
		expect(limiter.queued).toBe(0);
	});

	test("the seventh to tenth wait, and each goes out as an earlier call settles, in order", async () => {
		const load: SiblingLoad = { open: 0, queued: 0 };
		const limiter = new SiblingLimiter(load);
		const gates = Array.from({ length: 10 }, () => gate<number>());
		const started: number[] = [];
		let outstanding = 0;
		let peak = 0;
		const answers = gates.map((g, p) =>
			limiter.run(async () => {
				started.push(p);
				peak = Math.max(peak, ++outstanding);
				try {
					return await g.promise;
				} finally {
					outstanding--;
				}
			}),
		);
		expect(started).toEqual([0, 1, 2, 3, 4, 5]);
		expect([limiter.open, limiter.queued, load.open, load.queued]).toEqual([6, 4, 6, 4]);

		// Any of the six settling frees a slot — not only the oldest.
		gates[3]?.resolve(3);
		await tick();
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect([limiter.open, limiter.queued]).toEqual([6, 3]);

		gates[0]?.resolve(0);
		gates[6]?.resolve(6);
		await tick();
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

		for (const [p, g] of gates.entries()) g.resolve(p);
		// Every call answers its own caller, whatever order they went out in.
		expect(await Promise.all(answers)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(peak).toBe(6);
		expect([limiter.open, limiter.queued, load.open, load.queued]).toEqual([0, 0, 0, 0]);
	});

	test("a call that fails gives its slot up, and its error reaches only its own caller", async () => {
		const limiter = new SiblingLimiter(undefined, 1);
		const first = gate<string>();
		const a = limiter.run(() => first.promise);
		const b = limiter.run(async () => "second");
		const c = limiter.run(() => {
			throw new Error("could not derive the sibling's name");
		});
		first.reject(new Error("Network connection lost."));
		const settled = await Promise.allSettled([a, b, c]);
		expect(settled.map((s) => (s.status === "fulfilled" ? s.value : String(s.reason)))).toEqual([
			"Error: Network connection lost.",
			"second",
			"Error: could not derive the sibling's name",
		]);
		expect([limiter.open, limiter.queued]).toEqual([0, 0]);
		// ...and the limiter still works afterwards.
		expect(await limiter.run(async () => "after")).toBe("after");
	});

	test("two gathers on one object each get six; the object's tally counts both", () => {
		const load: SiblingLoad = { open: 0, queued: 0 };
		const one = new SiblingLimiter(load);
		const two = new SiblingLimiter(load);
		for (let p = 0; p < 10; p++) {
			void one.run(() => new Promise(() => {}));
			void two.run(() => new Promise(() => {}));
		}
		expect([one.open, one.queued, two.open, two.queued]).toEqual([6, 4, 6, 4]);
		expect(load).toEqual({ open: 12, queued: 8 });
	});

	test("a retry runs inside the slot of the call it replaces: never a seventh connection", async () => {
		const limiter = new SiblingLimiter();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		let outstanding = 0;
		let peak = 0;
		const lost = Object.assign(new Error("Network connection lost."), { retryable: true });
		try {
			const answers = Array.from({ length: 10 }, (_, p) => {
				let attempts = 0;
				return limiter.run(() =>
					siblingCall(
						`partition-${p} searchKeys`,
						() => ({}),
						async () => {
							peak = Math.max(peak, ++outstanding);
							await tick();
							outstanding--;
							// The first four die once, as a cancelled prefix did in production.
							if (p < 4 && attempts++ === 0) throw lost;
							return p;
						},
					),
				);
			});
			expect(await Promise.all(answers)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			expect(peak).toBe(6);
			expect(warn).toHaveBeenCalledTimes(4);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("a failed sibling call says where it was", () => {
	const lost = () => Object.assign(new Error("Network connection lost."), { retryable: true });

	test("the warning carries the sibling, the attempt, the time since it was sent, and the coordinator's state", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		let now = 1_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		try {
			const answer = await siblingCall(
				"partition-6 searchKeys",
				() => ({}),
				async () => {
					if (calls++ === 0) {
						now += 212;
						throw lost();
					}
					return "keys";
				},
				() => "coordinator=engine-enam-p9 gather_ms=215 gather_open=6 gather_queued=4 object_open=6 object_queued=4",
			);
			expect(answer).toBe("keys");
			expect(warn.mock.calls.map((c) => c[0])).toEqual([
				"partition-6 searchKeys failed transiently (Error: Network connection lost.) attempt=1 elapsed=212ms " +
					"coordinator=engine-enam-p9 gather_ms=215 gather_open=6 gather_queued=4 object_open=6 object_queued=4; " +
					"asking once more on a fresh stub",
			]);
		} finally {
			clock.mockRestore();
			warn.mockRestore();
		}
	});

	test("a retry that fails too is logged as attempt 2, and its own error is the one thrown", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		let calls = 0;
		try {
			await expect(
				siblingCall(
					"partition-2 fetchRows",
					() => ({}),
					async () => {
						throw calls++ === 0 ? lost() : new Error("this Durable Object instance is no longer active");
					},
				),
			).rejects.toThrow("no longer active");
			const lines = warn.mock.calls.map((c) => String(c[0]));
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("failed transiently (Error: Network connection lost.) attempt=1 elapsed=");
			expect(lines[0]).toEndWith("; asking once more on a fresh stub");
			expect(lines[1]).toContain("partition-2 fetchRows failed on its retry (Error: this Durable Object instance");
			expect(lines[1]).toContain(" attempt=2 elapsed=");
		} finally {
			warn.mockRestore();
		}
	});

	test("an answer about the query is neither retried nor logged, and the context is never built", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		let described = 0;
		try {
			await expect(
				siblingCall(
					"partition-1 searchKeys",
					() => ({}),
					async () => {
						throw new Error("generation mismatch: rows asked from a but engine-wnam-p1 serves b");
					},
					() => `n=${described++}`,
				),
			).rejects.toThrow("generation mismatch");
			expect(warn).not.toHaveBeenCalled();
			expect(described).toBe(0);
		} finally {
			warn.mockRestore();
		}
	});
});
