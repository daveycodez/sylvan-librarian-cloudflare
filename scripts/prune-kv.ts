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
import { liveManifestBuiltAts, pruneOldStores } from "./kv-prune";
import { requireDeployEnvironment } from "./kv-target";

const remote = process.argv.includes("--remote");
if (remote) requireDeployEnvironment();

// The build the LIVE MANIFEST points at is never swept, whatever its timestamp
// says. Read rather than assumed — a rollback republishes an OLDER manifest,
// and a sweep that decided "newest wins" would delete the store being served
// (see liveManifestBuiltAts).
const protect = await liveManifestBuiltAts(remote);
if (protect.length === 0) {
	// No readable manifest: sweeping now could delete the only store there is.
	console.log("Retention: no readable manifest — leaving every store build in place.");
} else {
	const removed = await pruneOldStores(KEEP_STORES_IN_KV, protect, remote);
	console.log(
		removed > 0
			? `Retention: dropped ${removed} chunk(s) from superseded store builds.`
			: "Retention: no superseded store builds to drop.",
	);
}
