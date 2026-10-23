// A cold gather's phase 1 in one wave: the siblings past one invocation's six calls are asked by the
// coordinator's own second invocation (src/engine/sibling-split.ts). What is pinned here is when a
// gather splits, which siblings go where, that the group is ONE call sent once, and that the page is
// the page the unsplit gather builds — the same bytes, the same totals — whatever the group does.

import { describe, expect, test } from "bun:test";
import {
	encodeKeyPacket,
	encodeRowPacket,
	type GatherShaping,
	joinJsonArray,
	type PartitionClient,
	type RowShaping,
	runTwoPhase,
	type SearchKeysReply,
} from "../../src/engine/gather";
import type { SiblingCallTiming } from "../../src/engine/gather-health";
import { SIBLING_CALLS_AT_ONCE } from "../../src/engine/sibling-limit";
import { type GroupedKeys, planSplit, type SearchKeysGroupReply, splitClients } from "../../src/engine/sibling-split";
import type { EngineSearchOptions } from "../../src/engine/types";

const all = () => true;
const none = () => false;

describe("planSplit: which gathers split, and how", () => {
	test("twelve partitions, all eleven siblings may be waking: five asked here, six by the second invocation", () => {
		expect(SIBLING_CALLS_AT_ONCE).toBe(6);
		expect(planSplit(12, 5, all)).toEqual({ direct: [0, 1, 2, 3, 4], grouped: [6, 7, 8, 9, 10, 11], waking: 11 });
		expect(planSplit(12, 0, all)).toEqual({ direct: [1, 2, 3, 4, 5], grouped: [6, 7, 8, 9, 10, 11], waking: 11 });
		expect(planSplit(12, 11, all)).toEqual({ direct: [0, 1, 2, 3, 4], grouped: [5, 6, 7, 8, 9, 10], waking: 11 });
	});

	test("the coordinator never asks itself, and the two halves cover every sibling once", () => {
		for (let own = 0; own < 12; own++) {
			const plan = planSplit(12, own, all);
			if (plan === null) throw new Error("expected a split");
			const asked = [...plan.direct, ...plan.grouped].sort((a, b) => a - b);
			expect(asked).toEqual(Array.from({ length: 12 }, (_, p) => p).filter((p) => p !== own));
			expect(plan.direct.length + 1).toBe(SIBLING_CALLS_AT_ONCE);
		}
	});

	test("no split while the siblings that may be waking fit one wave", () => {
		expect(planSplit(12, 5, none)).toBeNull();
		// Six may be waking: one wave holds them, and the rest free their slots in a round trip.
		expect(planSplit(12, 5, (p) => p < 6)).toBeNull();
		expect(planSplit(12, 5, (p) => p < 8)).toMatchObject({ waking: 7 });
	});

	test("no split when one wave holds every sibling, or the coordinator's own partition is unknown", () => {
		expect(planSplit(7, 3, all)).toBeNull();
		expect(planSplit(8, 3, all)).toMatchObject({ direct: [0, 1, 2, 4, 5], grouped: [6, 7] });
		expect(planSplit(12, undefined, all)).toBeNull();
	});
});

// ── the page is the unsplit gather's page ──────────────────────────────────────────────────────

const OPTS: EngineSearchOptions = {
	filterTreeJson: "{}",
	unique: "printing",
	prefer: "default",
	orderby: "name",
	direction: "asc",
	limit: 7,
	offset: 0,
	fields: ["name"],
};

const CARDS: GatherShaping = {
	shape: "cards",
	baseUrl: "https://x",
	reshape: () => {
		throw new Error("reshape must never run against a fleet that has finished deploying");
	},
};

const frame = (partition: number, vpid: number) =>
	new TextEncoder().encode(`{"object":"card","name":"p${partition}v${vpid}","cmc":1.0}`);

/** A partition answering in the card shape, counting its searchKeys calls. */
function cardPartition(partition: number, keys: number[]) {
	const storeKey = `card-store-v1-100-p${partition}.store`;
	const entries = keys.map((k, i) => ({ key: new Uint8Array([k]), vpid: i }));
	const asked: { opts: EngineSearchOptions; inlineRows: number; shaping: RowShaping }[] = [];
	const client: PartitionClient = {
		async searchKeys(opts, inlineRows, shaping) {
			asked.push({ opts, inlineRows, shaping });
			const window = entries.slice(opts.offset, opts.offset + opts.limit);
			return {
				packed: encodeKeyPacket({
					total: keys.length,
					entries: window,
					inlineRows: window.slice(0, inlineRows).map((e) => frame(partition, e.vpid)),
				}),
				storeKey,
				sortKeyVersion: 1,
				shape: "cards",
			};
		},
		async fetchRows(vpids) {
			return { rowsBytes: encodeRowPacket(vpids.map((v) => frame(partition, v))), shape: "cards" };
		},
	};
	return { client, asked };
}

/** Twelve partitions whose keys interleave, so every partition holds part of every page. */
function fleet() {
	return Array.from({ length: 12 }, (_, p) => cardPartition(p, [p + 1, p + 13, p + 25, p + 37]));
}

const timing = (partition: number): SiblingCallTiming => ({
	partition,
	method: "searchKeys",
	ms: 40 + partition,
	acquireMs: 30,
	failed: false,
});

/**
 * The second invocation, as searchKeysGroup is: the grouped partitions asked through their own
 * clients with the arguments it was sent. `fail` names partitions whose entry comes back failed.
 */
function secondInvocation(clients: PartitionClient[], fail: number[] = []) {
	const sent: { opts: EngineSearchOptions; inlineRows: number; shaping: RowShaping; partitions: number[] }[] = [];
	const send =
		(partitions: number[]) =>
		async (opts: EngineSearchOptions, inlineRows: number, shaping: RowShaping): Promise<SearchKeysGroupReply> => {
			sent.push({ opts, inlineRows, shaping, partitions });
			const calls = await Promise.all(
				partitions.map(async (partition): Promise<GroupedKeys> => {
					if (fail.includes(partition))
						return { partition, ok: false, error: "Error: Network connection lost.", timing: null };
					const reply = await (clients[partition] as PartitionClient).searchKeys(opts, inlineRows, shaping);
					return { partition, ok: true, reply, timing: timing(partition) };
				}),
			);
			return { calls };
		};
	return { sent, send };
}

async function pageOf(clients: PartitionClient[], opts = OPTS) {
	const page = await runTwoPhase(clients, opts, CARDS);
	return { total: page.total, bytes: new TextDecoder().decode(joinJsonArray(page.slots)), builtAt: page.builtAt };
}

describe("splitClients: the page is the page", () => {
	test("the grouped siblings are ONE call, sent once with the gather's own arguments, and the page is unchanged", async () => {
		const unsplit = await pageOf(fleet().map((f) => f.client));
		const parts = fleet();
		const clients = parts.map((f) => f.client);
		const plan = planSplit(12, 5, all);
		if (plan === null) throw new Error("expected a split");
		// The group's own asks go to the same partition objects, as the second invocation's clients would.
		const group = secondInvocation(clients);
		const heard: GroupedKeys[] = [];
		const split = splitClients(clients, plan.grouped, group.send(plan.grouped), (e) => heard.push(e));
		const page = await pageOf(split);
		expect(page).toEqual(unsplit);
		expect(group.sent).toHaveLength(1);
		expect(group.sent[0]?.partitions).toEqual([6, 7, 8, 9, 10, 11]);
		// Every partition was asked exactly once, the grouped ones by the group, with one set of arguments.
		for (const part of parts) expect(part.asked).toHaveLength(1);
		const first = parts[0]?.asked[0];
		for (const p of plan.grouped) {
			expect(parts[p]?.asked[0]?.opts).toBe(first?.opts as EngineSearchOptions);
			expect(parts[p]?.asked[0]?.inlineRows).toBe(first?.inlineRows as number);
		}
		// ...and the coordinator heard every grouped call's timing, for its trace.
		expect(heard.map((e) => e.partition).sort((a, b) => a - b)).toEqual(plan.grouped);
		expect(heard.every((e) => e.timing?.method === "searchKeys")).toBe(true);
	});

	test("a grouped sibling the group could not reach is asked directly, and the page is unchanged", async () => {
		const unsplit = await pageOf(fleet().map((f) => f.client));
		const parts = fleet();
		const clients = parts.map((f) => f.client);
		const group = secondInvocation(clients, [8, 10]);
		const heard: GroupedKeys[] = [];
		const split = splitClients(clients, [6, 7, 8, 9, 10, 11], group.send([6, 7, 8, 9, 10, 11]), (e) => heard.push(e));
		expect(await pageOf(split)).toEqual(unsplit);
		// The failed two once each, by the coordinator; the rest once each, by the group.
		for (const part of parts) expect(part.asked).toHaveLength(1);
		expect(heard.filter((e) => !e.ok).map((e) => e.partition)).toEqual([8, 10]);
	});

	test("the call to the second invocation failing asks every grouped sibling directly", async () => {
		const unsplit = await pageOf(fleet().map((f) => f.client));
		const parts = fleet();
		const clients = parts.map((f) => f.client);
		let sent = 0;
		const split = splitClients(
			clients,
			[6, 7, 8, 9, 10, 11],
			async () => {
				sent += 1;
				throw new Error("internal error; reference = 0000");
			},
			() => {},
		);
		expect(await pageOf(split)).toEqual(unsplit);
		expect(sent).toBe(1);
		for (const part of parts) expect(part.asked).toHaveLength(1);
	});

	test("only the first ask goes through the group: a re-ask, and any other ask, is the partition's own", async () => {
		const parts = fleet();
		const clients = parts.map((f) => f.client);
		const group = secondInvocation(clients);
		const split = splitClients(clients, [6, 7, 8, 9, 10, 11], group.send([6, 7, 8, 9, 10, 11]), () => {});
		const shaping: RowShaping = { shape: "cards", baseUrl: "https://x" };
		const replies = await Promise.all(split.map((c) => c.searchKeys(OPTS, 3, shaping)));
		expect(replies).toHaveLength(12);
		expect(group.sent).toHaveLength(1);
		// A straggler re-asked (pinGeneration) with the same arguments: its own client, not a second group.
		await (split[7] as PartitionClient).searchKeys(OPTS, 3, shaping);
		expect(group.sent).toHaveLength(1);
		expect(parts[7]?.asked).toHaveLength(2);
		// A first ask with OTHER arguments than the group carried (a deep page's probe came first).
		const other = splitClients(clients, [6, 7], group.send([6, 7]), () => {});
		await (other[6] as PartitionClient).searchKeys(OPTS, 0, shaping);
		await (other[7] as PartitionClient).searchKeys({ ...OPTS, limit: 1 }, 0, shaping);
		expect(group.sent).toHaveLength(2);
		expect(group.sent[1]?.partitions).toEqual([6, 7]);
		// Partition 7's own client answered its different ask; the group's entry for it went unused.
		expect(parts[7]?.asked.at(-1)?.opts.limit).toBe(1);
	});

	test("ungrouped clients are the very same objects, fetchRows and refresh included", () => {
		const parts = fleet();
		const clients = parts.map((f) => f.client);
		const split = splitClients(
			clients,
			[9, 10, 11],
			async () => ({ calls: [] }),
			() => {},
		);
		for (let p = 0; p < 9; p++) expect(split[p]).toBe(clients[p] as PartitionClient);
		expect((split[10] as PartitionClient).fetchRows).toBe((clients[10] as PartitionClient).fetchRows);
	});

	test("an empty group answer leaves every grouped sibling to its own client", async () => {
		const parts = fleet();
		const clients = parts.map((f) => f.client);
		const split = splitClients(
			clients,
			[10, 11],
			async () => ({ calls: [] }),
			() => {},
		);
		const reply: SearchKeysReply = await (split[11] as PartitionClient).searchKeys(OPTS, 0, {
			shape: "cards",
			baseUrl: "",
		});
		expect(reply.storeKey).toBe("card-store-v1-100-p11.store");
		expect(parts[11]?.asked).toHaveLength(1);
	});
});
