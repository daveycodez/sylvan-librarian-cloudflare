// The purge request (src/cache-purge-request.ts): a deploy-path publish cannot purge the response
// cache itself, so it leaves a KV key and the watchdog tick purges once the engines have had time
// to reach the new store.

import { describe, expect, test } from "bun:test";
import { PURGE_GIVE_UP_MS, PURGE_REQUEST_KEY, PURGE_SETTLE_MS, runPurgeRequest } from "../../src/cache-purge-request";

const NOW = Date.parse("2026-11-20T04:20:00Z");

function kvWith(request: unknown) {
	const values = new Map<string, unknown>(request === undefined ? [] : [[PURGE_REQUEST_KEY, request]]);
	const deleted: string[] = [];
	return {
		deleted,
		has: () => values.has(PURGE_REQUEST_KEY),
		kv: {
			get: async (key: string) => values.get(key) ?? null,
			delete: async (key: string) => {
				deleted.push(key);
				values.delete(key);
			},
		},
	};
}
const ok = async () => ({ success: true });
const broken = async () => ({ success: false, errors: [{ code: 0, message: "nope" }] });

describe("runPurgeRequest", () => {
	test("no request: nothing is purged", async () => {
		let purges = 0;
		const { kv } = kvWith(undefined);
		const purge = async () => {
			purges += 1;
			return { success: true };
		};
		expect(await runPurgeRequest(kv, purge, NOW)).toBe("none");
		expect(purges).toBe(0);
	});

	test("a fresh request waits for the engines; an older one is purged once and removed", async () => {
		let purges = 0;
		const purge = async () => {
			purges += 1;
			return { success: true };
		};
		const state = kvWith({ at: NOW - PURGE_SETTLE_MS + 1, why: "a deploy published a store" });
		expect(await runPurgeRequest(state.kv, purge, NOW)).toBe("waiting");
		expect(purges).toBe(0);
		expect(await runPurgeRequest(state.kv, purge, NOW + 1)).toBe("purged");
		expect(purges).toBe(1);
		expect(state.deleted).toEqual([PURGE_REQUEST_KEY]);
		expect(await runPurgeRequest(state.kv, purge, NOW + 600_000)).toBe("none");
		expect(purges).toBe(1);
	});

	test("a failed purge keeps the request for the next tick — until it is too old to matter", async () => {
		const state = kvWith({ at: NOW - PURGE_SETTLE_MS, why: "x" });
		expect(await runPurgeRequest(state.kv, broken, NOW)).toBe("failed");
		expect(state.has()).toBe(true);
		expect(await runPurgeRequest(state.kv, ok, NOW + 600_000)).toBe("purged");
		const stuck = kvWith({ at: NOW - PURGE_GIVE_UP_MS, why: "x" });
		expect(await runPurgeRequest(stuck.kv, broken, NOW)).toBe("dropped");
		expect(stuck.has()).toBe(false);
	});

	test("a request with no usable time is honoured at once, and an unreadable key is not a purge", async () => {
		expect(await runPurgeRequest(kvWith({ why: "by hand" }).kv, ok, NOW)).toBe("purged");
		const failing = { get: async () => Promise.reject(new Error("kv down")), delete: async () => {} };
		expect(await runPurgeRequest(failing, ok, NOW)).toBe("none");
	});
});
