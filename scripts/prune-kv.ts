// Retire superseded store builds, whether or not this deploy published one.
//
//   bun scripts/prune-kv.ts            # local simulated KV
//   bun scripts/prune-kv.ts --remote   # production KV, from inside a deploy
//
// Cleanup is not part of publishing, and tying the two together is how a leak survives a fix. The
// store sweep used to run only inside the publisher, so a deploy that correctly skipped the import
// — the common case, because a recent store is already live — skipped the sweep with it. The same
// mistake had just been made with the rulings and reference layouts, where `--if-missing` exited
// before their sweep: production shed those orphans only once the skip path learned to clean.
//
// The layout sweeps live in the two seeding scripts, which run on every deploy. This is the store's
// counterpart, and it runs unconditionally beside them.

import { KEEP_STORES_IN_KV } from "../src/engine/store-kv";
import { liveManifestBuiltAts, pruneOldStores, publishingBuiltAts } from "./kv-prune";
import { requireDeployEnvironment } from "./kv-target";

const remote = process.argv.includes("--remote");
if (remote) requireDeployEnvironment();

// Two builds are never swept, whatever their timestamps say. The one the LIVE
// MANIFEST points at — read rather than assumed, because a rollback republishes
// an OLDER manifest, and a sweep that decided "newest wins" would delete the
// store being served. And the one the in-Worker coordinator is STILL UPLOADING
// — which has no manifest yet, and a built_at from when its build started,
// days before the deploy-built generations that land while it crawls. Both
// deploys on 2026-09-14/15 swept exactly that family out from under the
// coordinator, and its manifest write then named the chunks they had deleted
// (see publishingBuiltAts and PUBLISHING_KEY).
const live = await liveManifestBuiltAts(remote);
if (live.length === 0) {
	// No readable manifest: sweeping now could delete the only store there is.
	console.log("Retention: no readable manifest — leaving every store build in place.");
} else {
	const inFlight = await publishingBuiltAts(remote);
	if (inFlight.length > 0) console.log(`Retention: build ${inFlight[0]} is still being uploaded — protected.`);
	const removed = await pruneOldStores(KEEP_STORES_IN_KV, [...live, ...inFlight], remote);
	console.log(
		removed > 0
			? `Retention: dropped ${removed} chunk(s) from superseded store builds.`
			: "Retention: no superseded store builds to drop.",
	);
}
