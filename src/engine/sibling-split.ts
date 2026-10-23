/**
 * A COLD gather's phase 1 in one wave, not two: the sibling calls past what one invocation may have
 * open are sent by a second invocation of the coordinator itself.
 *
 * WHY. One invocation has at most six outgoing calls open (sibling-limit.ts, x44), and a full gather
 * at twelve partitions has eleven siblings to ask — so the limiter sends six and the other five wait
 * for a slot. Warm, that costs one more sibling round trip (10–60ms in wnam). COLD, every one of the
 * eleven is loading its store, and a slot frees only when a load has finished: the five in the queue
 * START their wake when the first wave's ends, and the gather pays two wakes back to back. Measured:
 *
 *   - DeckGen, wnam, 2026-10-23 08:52:14: coordinator p5 woke and reserved its store; p0, p1, p2
 *     loaded at +0.19–0.29s, p9, p10, p11 at +0.58–0.60s, the gather took 1,329ms.
 *   - daveycodez, wnam, 2026-10-23 09:06:34 (an idle deployment, every partition read from KV):
 *     p0, p2, p4, p5, p6 loaded at +0.71–1.34s, p7–p11 at +1.74–2.07s; 2,212ms.
 *
 * The six-call limit is counted per INVOCATION, not per object: x44's evidence is that the 7th–10th
 * shape stayed exact while one object ran several gathers at once. A Durable Object may call itself,
 * and that call is another invocation with six calls of its own. So when the coordinator is itself
 * cold and more of its siblings may be waking than one wave holds (SiblingMemory.mayBeWaking: not
 * heard from within nine seconds), it sends five siblings' calls itself and ONE call to its own
 * object, which sends the other six (searchKeysGroup) — eleven loads at once, for one extra Durable
 * Object request. A cold coordinator was about 1,480 of DeckGen's gathers in the 24 hours to
 * 2026-10-23 09:00 UTC (its `reserved … before asking its 11 siblings` line: wnam 352, enam 660,
 * apac-se 320, weur 120).
 *
 * SAME ANSWER. The grouped siblings are asked by the same code (the coordinator's partitionClients,
 * with its limiter, its hedges, its neighbour and its retry), with the same arguments, of the same
 * objects; their replies come back as they were and reach runTwoPhase in partition order with the
 * rest. A grouped call that failed, and the whole group if the call to it failed, is asked again
 * directly, as if no group had been sent. Only the first phase-1 ask goes through the group: a
 * straggler's re-ask (pinGeneration), a deep page's second ask and phase 2 go direct.
 *
 * WHEN NOT. A warm coordinator never splits (search-engine-do.ts fullGatherClients: its memory knows
 * only the gathers IT coordinated, so it cannot tell a cold region from siblings warmed by the other
 * eleven coordinators), nor a cold one whose siblings answered it within nine seconds, nor one
 * whose siblings fit one wave. Neither a list gather (y1) nor a names-index gather (n15) splits:
 * they ask few partitions.
 */

import type { PartitionClient, RowShaping, SearchKeysReply } from "./gather";
import type { SiblingCallTiming } from "./gather-health";
import { SIBLING_CALLS_AT_ONCE } from "./sibling-limit";
import type { EngineSearchOptions } from "./types";

/** Which siblings the coordinator asks itself, and which it hands to its second invocation. */
export interface SplitPlan {
	/** Asked by the gather's own invocation, in partition order. */
	direct: number[];
	/** Asked by the second invocation (searchKeysGroup), in partition order. */
	grouped: number[];
	/** How many of the siblings may have been waking when the plan was made, for the line. */
	waking: number;
}

/**
 * The split for a full gather at `width` coordinated by partition `own`, or null to ask every sibling
 * directly. The direct calls are the FIRST siblings in partition order, because that is the order the
 * gather issues them in (runTwoPhase asks partition 0 first) and the limiter sends them in: so the
 * group's call is exactly the call that takes the last slot.
 */
export function planSplit(
	width: number,
	own: number | undefined,
	mayBeWaking: (partition: number) => boolean,
	limit = SIBLING_CALLS_AT_ONCE,
): SplitPlan | null {
	const siblings = Array.from({ length: width }, (_, p) => p).filter((p) => p !== own);
	if (own === undefined || siblings.length <= limit || limit < 2) return null;
	const waking = siblings.filter((p) => mayBeWaking(p)).length;
	if (waking <= limit) return null;
	return { direct: siblings.slice(0, limit - 1), grouped: siblings.slice(limit - 1), waking };
}

/** One grouped sibling's outcome, as the second invocation hands it back. */
export type GroupedKeys =
	| { partition: number; ok: true; reply: SearchKeysReply; timing: SiblingCallTiming | null }
	| { partition: number; ok: false; error: string; timing: SiblingCallTiming | null };

/** What searchKeysGroup returns. */
export interface SearchKeysGroupReply {
	calls: GroupedKeys[];
}

/**
 * `clients` with the `grouped` partitions' FIRST searchKeys answered by ONE call to `sendGroup`,
 * sent when the first of them is asked, with the arguments it was asked with. Each grouped partition
 * takes its own reply from that call; any it does not get (the call failed, or that partition's
 * entry did) it asks of its own client, exactly as an ungrouped partition would. Every later
 * searchKeys, and every fetchRows and refresh, is the client's own.
 *
 * `heard` is told each reply the group delivered, with the timing the second invocation measured,
 * so the coordinator's trace and stall verdict still see every sibling call.
 */
export function splitClients(
	clients: PartitionClient[],
	grouped: readonly number[],
	sendGroup: (opts: EngineSearchOptions, inlineRows: number, shaping: RowShaping) => Promise<SearchKeysGroupReply>,
	heard: (entry: GroupedKeys) => void,
): PartitionClient[] {
	const members = new Set(grouped);
	let group: { args: [EngineSearchOptions, number, RowShaping]; reply: Promise<SearchKeysGroupReply | null> } | null =
		null;
	const spent = new Set<number>();
	return clients.map((client, partition) => {
		if (!members.has(partition)) return client;
		return {
			...client,
			searchKeys: async (opts: EngineSearchOptions, inlineRows: number, shaping: RowShaping) => {
				if (spent.has(partition)) return client.searchKeys(opts, inlineRows, shaping);
				spent.add(partition);
				if (group === null) {
					group = {
						args: [opts, inlineRows, shaping],
						reply: sendGroup(opts, inlineRows, shaping).catch(() => null),
					};
				}
				const [askedOpts, askedInline, askedShaping] = group.args;
				// Another ask than the one the group carried: this partition's own, as without a group.
				if (askedOpts !== opts || askedInline !== inlineRows || askedShaping !== shaping) {
					return client.searchKeys(opts, inlineRows, shaping);
				}
				const answered = await group.reply;
				const entry = answered?.calls.find((c) => c.partition === partition);
				if (entry?.ok) {
					heard(entry);
					return entry.reply;
				}
				if (entry) heard(entry);
				return client.searchKeys(opts, inlineRows, shaping);
			},
		};
	});
}
