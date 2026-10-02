// A name that is nowhere, on the REAL corpus (backlog x48): `/cards/named?fuzzy=` through the real
// route and the real PartitionedEngine, every partition its own instance of the committed wasm, the
// names index and the printed-names blob in one more (real-partitions.ts).
//
// The claim: whatever the routing filter reads for the needle — nothing, or a hint to any partition,
// which is what it reads ~78% of the time for a name it never held — the response is the bytes the
// every-partition fan-out answers and the bytes the build before x48 answered, and a miss is ONE
// partition call. Checked over production's own misses (DeckGen, 2026-09-30) and, for the paths
// that must not move, real names, typos, containment and printed-name needles.
//
// Opt-in, because it loads every partition of the corpus:
//
//   SYLVAN_REAL_DIFFERENTIAL=1 bun test tests/engine/routed-miss-real.test.ts
//
// with STORE_BUILD_DIR pointing at a store build (default: this checkout's store-build/).

import { describe, expect, spyOn, test } from "bun:test";
import { PartitionedEngine } from "../../src/engine/partitioned-engine";
import {
	buildRoutingFilter,
	type NameHint,
	nameKey,
	ROUTING_FEATURE_NAME_KEYS,
	ROUTING_FEATURE_NAME_TIERS,
	RoutingFilter,
} from "../../src/engine/routing-filter";
import { foldAccents } from "../../src/parser/pystr";
import { makeCtx, testDispatch } from "../routes/harness";
import misses from "./named-fuzzy-misses-2026-09-30.json";
import {
	loadRealStore,
	type RealPartitionOptions,
	type RealStore,
	realFuzzyBundle,
	realPartition,
	realStoreDir,
	realStoreReadable,
} from "./real-partitions";

const foldedOf = (fuzzy: string) => foldAccents(fuzzy.trim().toLowerCase());
const wordsOf = (folded: string) => folded.split(/[^\w']+/u).filter((w) => w.length > 0);

/** A filter that reads `hint` for `folded` — with tiers when the hint carries a rival. */
function filterReading(store: RealStore, folded: string, hint: NameHint): RoutingFilter {
	const collated = (nameKey(folded) as string).slice("nm:".length);
	const entries =
		"sole" in hint
			? [{ key: `ns:${collated}`, partition: hint.sole }]
			: [
					{ key: `ns:${collated}`, partition: hint.served },
					{
						key: `${["na", "nf", "nm", "nw"][hint.rival ?? 0]}:${collated}`,
						partition: (hint.served + 1) % store.n,
					},
				];
	const identity = { builtAt: store.builtAt, partitionCount: store.n, partitionHash: "fnv1a64/oracle_id/v1" };
	const features = ROUTING_FEATURE_NAME_KEYS | ("sole" in hint ? 0 : ROUTING_FEATURE_NAME_TIERS);
	const parsed = RoutingFilter.parse(buildRoutingFilter(entries, identity, features), identity);
	if ("reason" in parsed) throw new Error(parsed.reason);
	expect(parsed.filter.lookupName(nameKey(folded) as string)).toEqual(hint);
	return parsed.filter;
}

async function ask(
	store: RealStore,
	fuzzy: string,
	routing: RoutingFilter | null,
	withNames: boolean,
	options: RealPartitionOptions = {},
) {
	const calls: string[] = [];
	const manifest = store.manifest(withNames);
	const engine = new PartitionedEngine(
		(p) => realPartition(store, p, calls, options),
		manifest,
		async () => manifest,
		routing,
	);
	const res = await testDispatch(makeCtx({ engine }), `/cards/named?${new URLSearchParams({ fuzzy })}`);
	return { status: res.status, body: await res.text(), calls };
}

describe.skipIf(!realStoreReadable)(`a fuzzy name that is nowhere, on ${realStoreDir}`, () => {
	test("production's misses are one call behind every hint, and every needle answers the fan-out's bytes", async () => {
		const store = loadRealStore();
		const log = spyOn(console, "log").mockImplementation(() => {});
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const real = (misses.needles as [string, number][]).map(([fuzzy]) => fuzzy);
			const others = [
				// Names, on every tier the exact stage ranks.
				"Lightning Bolt",
				"Delver of Secrets",
				"chaos",
				"day",
				"fire",
				"armed",
				"elemental",
				"Godzilla, Primeval Champion",
				// Typos, containment, printed names.
				"lihgtning bolt",
				"sol rin",
				"ightning bolt",
				"primeval titanoth",
				"bolt",
				"jac bel",
				"blitzschlag",
				"red goad",
				"ego a derva",
				"hyd disintegrat",
			];
			let missCallsBefore = 0;
			let missCallsAfter = 0;
			let missAsks = 0;
			let compared = 0;
			for (const fuzzy of [...real, ...others]) {
				const folded = foldedOf(fuzzy);
				const words = wordsOf(folded);
				const fanOut = await ask(store, fuzzy, null, false);
				expect(fanOut.calls.length).toBe(store.n);
				// Which partitions hold the name at all: a hint to any OTHER partition, or any hint at
				// all when none does, is what a filter that never held the key can read. One that
				// names a holder is checked only where the filter would really say it: a sole holder.
				const holders = Array.from({ length: store.n }, (_, p) => p).filter(
					(p) => realFuzzyBundle(store, p, folded, "", words, 2, "https://x").exact.present,
				);
				const hints: (NameHint | null)[] = [null];
				if (nameKey(folded) !== null) {
					if (holders.length === 0) {
						for (let p = 0; p < store.n; p++) hints.push({ sole: p });
						for (const rival of [0, 3]) hints.push({ served: 0, rival }, { served: store.n - 1, rival });
					} else if (holders.length === 1) {
						hints.push({ sole: holders[0] as number });
					}
				}
				for (const hint of hints) {
					const routing = hint === null ? null : filterReading(store, folded, hint);
					const now = await ask(store, fuzzy, routing, true);
					const before = await ask(store, fuzzy, routing, true, { beforeX48: true });
					expect({ fuzzy, hint, status: now.status, body: now.body }).toEqual({
						fuzzy,
						hint,
						status: fanOut.status,
						body: fanOut.body,
					});
					expect({ fuzzy, hint, status: before.status, body: before.body }).toEqual({
						fuzzy,
						hint,
						status: fanOut.status,
						body: fanOut.body,
					});
					expect(now.calls.length).toBeLessThanOrEqual(before.calls.length);
					compared++;
					if (real.includes(fuzzy)) {
						expect(fanOut.status).toBe(404);
						expect({ fuzzy, hint, calls: now.calls.length }).toEqual({ fuzzy, hint, calls: 1 });
						missCallsBefore += before.calls.length;
						missCallsAfter += now.calls.length;
						missAsks++;
					} else if (hint !== null && holders.length === 1) {
						// The hit path: one call, as before, and no plan beside it.
						expect(now.calls).toEqual([`routed:${holders[0]}`]);
						expect(before.calls).toEqual([`bundle:${holders[0]}`]);
					}
				}
			}
			log.mockRestore();
			console.log(
				`fuzzy on the real corpus: ${compared} (needle, hint) responses equal the ${store.n}-partition fan-out's; ` +
					`production's ${real.length} misses over ${missAsks} hints cost ${missCallsBefore} calls before x48, ${missCallsAfter} after`,
			);
			expect(missCallsAfter).toBe(missAsks);
		} finally {
			log.mockRestore();
			warn.mockRestore();
		}
	}, 600_000);
});
