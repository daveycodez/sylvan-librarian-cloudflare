// PartitionedEngine.searchCardsAtAddress: the card page's first search, asked of the ONE partition
// the routing filter names for a printing address (src/routes/card-embed.ts). Its own file so the
// shared RPC-count table in partitioned-routes.test.ts stays untouched.

import { describe, expect, test } from "bun:test";
import { PartitionedEngine } from "../../src/engine/partitioned-engine";
import type { RemoteEngine } from "../../src/engine/remote-engine";
import { EngineCallTimeoutError } from "../../src/engine/remote-engine";
import { buildRoutingFilter, RoutingFilter, setNumberKey } from "../../src/engine/routing-filter";
import { type EngineSearchOptions, StaleModulusError, type StoreManifest } from "../../src/engine/types";

const N = 4;
const ID = { builtAt: "100", partitionCount: N, partitionHash: "fnv1a64/oracle_id/v1" };

const MANIFEST: StoreManifest = {
	store_key: "card-store-v1-100-address.store",
	built_at: "100",
	card_count: 40,
	printing_count: 100,
	upstream_commit: "abc",
	format_version: 1,
	store_bytes: 1000,
	chunk_count: N,
	partition_count: N,
	partition_hash: "fnv1a64/oracle_id/v1",
	partitions: Array.from({ length: N }, (_, k) => ({
		store_key: `card-store-v1-100-address-p${k}.store`,
		store_bytes: 250,
		chunk_count: 1,
		card_count: 10,
		printing_count: 25,
	})),
};

const OPTS: EngineSearchOptions = {
	filterTreeJson: '{"q":"set:war cn:\\"2\\""}',
	unique: "printing",
	prefer: "default",
	orderby: "edhrec",
	direction: "asc",
	limit: 100,
	offset: 0,
	fields: ["name"],
};

function filterOf(entries: { key: string; partition: number }[]): RoutingFilter {
	const parsed = RoutingFilter.parse(buildRoutingFilter(entries, ID), ID);
	if ("reason" in parsed) throw new Error(parsed.reason);
	return parsed.filter;
}

function build(routing: RoutingFilter | null, fail: Error | null = null) {
	const calls: string[] = [];
	const remote = (p: number) =>
		({
			searchCardsAsJson: async (_o: unknown, shape: unknown, pinned?: number) => {
				calls.push(`searchCardsAsJson:${p}:${String(shape)}:${pinned ?? "-"}`);
				if (fail) throw fail;
				return { totalCards: 1, cardsBytes: new TextEncoder().encode(`[{"p":${p}}]`), rowCount: 1 };
			},
		}) as unknown as RemoteEngine;
	const engine = new PartitionedEngine(remote, MANIFEST, async () => MANIFEST, routing);
	return { engine, calls };
}

describe("searchCardsAtAddress", () => {
	const key = setNumberKey("war", "2");

	test("asks the ONE partition the filter names, pinned to this request's partition count", async () => {
		const { engine, calls } = build(filterOf([{ key, partition: 2 }]));
		const answer = await engine.searchCardsAtAddress(OPTS, "rows", key);
		expect(new TextDecoder().decode(answer?.cardsBytes)).toBe('[{"p":2}]');
		expect(calls).toEqual([`searchCardsAsJson:2:rows:${N}`]);
	});

	test("no routing filter is null, and asks nobody", async () => {
		const { engine, calls } = build(null);
		expect(await engine.searchCardsAtAddress(OPTS, "rows", key)).toBeNull();
		expect(calls).toEqual([]);
	});

	test("a partition cut at another count, or not answering, is null: the caller searches everywhere", async () => {
		for (const err of [new StaleModulusError("cut at 5"), new EngineCallTimeoutError("stuck")]) {
			const { engine } = build(filterOf([{ key, partition: 1 }]), err);
			expect(await engine.searchCardsAtAddress(OPTS, "rows", key)).toBeNull();
		}
	});

	test("a query or store error is the caller's to see", async () => {
		const { engine } = build(filterOf([{ key, partition: 1 }]), new Error("wasm trap"));
		await expect(engine.searchCardsAtAddress(OPTS, "rows", key)).rejects.toThrow("wasm trap");
	});
});
