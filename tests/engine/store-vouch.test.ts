// The store vouch (src/engine/store-vouch.ts): the build a router is pinned to, carried in the
// fraction of the shard width it reports — exact both ways, invisible to an object that floors the
// width as every build has, and absent whenever there is no build to vouch for.

import { describe, expect, test } from "bun:test";
import { RemoteEngine } from "../../src/engine/remote-engine";
import { foldWidthAnnouncement } from "../../src/engine/shard-controller";
import { vouchedBuildOf, vouchingWidth } from "../../src/engine/store-vouch";

describe("the rider", () => {
	test("round-trips every width and build exactly, through JSON too", () => {
		for (const build of ["1", "1794954927", "1794954928", "2147483647", "4294967295"]) {
			for (const width of [undefined, 1, 2, 7, 48, 255]) {
				const rider = vouchingWidth(width, build) as number;
				expect(Math.floor(rider)).toBe(width ?? 1);
				expect(vouchedBuildOf(rider)).toBe(build);
				expect(vouchedBuildOf(JSON.parse(JSON.stringify({ shards: rider })).shards)).toBe(build);
			}
		}
	});

	test("an object on the build before it folds the same width it always did", () => {
		const announced = { shards: 1, at: 0 };
		for (const width of [1, 2, 5]) {
			const rider = vouchingWidth(width, "1794954927") as number;
			expect(foldWidthAnnouncement(announced, rider, 1, 60_000)).toEqual(
				foldWidthAnnouncement(announced, width, 1, 60_000),
			);
		}
		// No width of its own (a hedge) is the 1 an absent width reads as.
		expect(Math.floor(vouchingWidth(undefined, "1794954927") as number)).toBe(1);
	});

	test("no usable build leaves the width untouched, and a bare width vouches for nothing", () => {
		for (const build of [undefined, "", "0", "099", "abc", "1.5", "4294967296", "17949549270", null]) {
			expect(vouchingWidth(3, build)).toBe(3);
			expect(vouchingWidth(undefined, build)).toBeUndefined();
		}
		for (const bare of [undefined, null, 1, 2, 48, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "2", {}]) {
			expect(vouchedBuildOf(bare)).toBeUndefined();
		}
	});
});

describe("RemoteEngine reports its build on every instrumented call", () => {
	const riders = { acquireMs: 0, load: 0, rate: 0, shards: 1 };

	test("an RPC and the stream body both carry it; without a build they carry the bare width", async () => {
		const seen: unknown[] = [];
		const stub = {
			scryfallCardById: async (_id: string, _base: string, shards?: number) => {
				seen.push(shards);
				return { card: null, ...riders };
			},
			fetch: async (request: Request) => {
				seen.push(((await request.json()) as { shards?: number }).shards);
				return new Response("[]", {
					headers: {
						"x-total-cards": "0",
						"x-row-count": "0",
						"x-acquire-ms": "0",
						"x-load": "0",
						"x-rate": "0",
						"x-shards": "1",
					},
				});
			},
		};
		const vouching = new RemoteEngine(stub as never, "vouch-a", "SJC", undefined, false, undefined, "1794954927");
		await vouching.scryfallCardById("id", "https://x");
		await vouching.scryfallSearchPage({ limit: 10 } as never, "https://x", {} as never, {});
		expect(seen.map(vouchedBuildOf)).toEqual(["1794954927", "1794954927"]);
		expect(seen.map((s) => Math.floor(s as number))).toEqual([1, 1]);

		seen.length = 0;
		const plain = new RemoteEngine(stub as never, "vouch-b");
		await plain.scryfallCardById("id", "https://x");
		expect(seen.map(vouchedBuildOf)).toEqual([undefined]);
	});
});
